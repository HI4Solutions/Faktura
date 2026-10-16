// Ansatte fra a-ordningen (0113_ansatte_enklere.sql, docs/ansatte.md): for bedrifter som har hatt
// ansatte før og har sendt a-meldinger fra et annet system. Workeren henter avstemmingsrapporten
// fra Skatteetaten (Avstemmingsrapport A-melding API, som erstatter A06/A07) med systembrukeren
// organisasjonen har gitt Admin Konsoll i Altinn (tilgangspakken «A-ordningen», scopet
// skatteetaten:innrapporteringamelding): det som er rapportert om hver inntektsmottaker de siste
// månedene (arbeidsforholdet og lønnen). Lederen ser hvem som er med, og velger hvem som legges
// inn som nye, og hvem som finnes fra før og oppdateres (samme fødselsnummer, eller samme navn
// for en ansatt uten fødselsnummer).
//
// Rapporten bestilles og hentes når den er klar (avstemmingsrapport-amelding-api 1.0.1 på
// SwaggerHub): POST /bestillinger med opplysningspliktig, inntektsåret og månedene gir ID-en,
// GET /bestillinger/{id} statusen (OPPRETTES, KLAR, INGEN_DATA eller FEILET), og GET
// /rapporter/{id} rapporten (A07AOrdningenAvstemmingsinformasjon: mottatt.oppgave.virksomhet[]
// .inntektsmottaker[] med arbeidsforhold og inntekt). Beløpene er summene for perioden, så den
// bestilles for én måned om gangen: den siste måneden med en a-melding. Tolkingen leter etter
// feltene med navnene fra a-meldingen (norskIdentifikator, arbeidsforhold med startdato,
// stillingsprosent, yrke osv.) der de står, så den tåler at strukturen endres.
//
// Fødselsnumrene krypteres av workeren og lagres for seg (bare workeren leser dem); de settes på
// den ansatte med faktura.aordning_sett_fnr når lederen legger dem inn.
import { Hono, type Context } from "hono";
import { z } from "zod";
import { config } from "./config.js";
import { alle, en, somBruker, somSystem, type Db } from "./db.js";
import { ApiFeil, tilHttp } from "./feil.js";
import { fodselsdato as fodselsdatoFraFnr } from "./fnr.js";
import { dekrypter, krypter } from "./kryptering.js";
import { adresser, EtatFeil, etatKall, hentToken, SCOPE } from "./maskinporten.js";
import { A_ORDNING } from "./altinn.js";
import { harPakke, hentTilgang, melding } from "./skattekort.js";
import { leggIKo } from "./tjenester.js";
import { ansattSkjema, hentSkattekortFor, regler } from "./ansatte.js";
import { iDag } from "./regler.js";

const logg = (severity: string, message: string, data: Record<string, unknown> = {}) => console.log(JSON.stringify({ severity, message, ...data }));

// --- Tolkingen av rapporten ------------------------------------------------------------------

export type Arbeidsforhold = {
  id: string | null; // arbeidsforholdId i a-meldingen
  type: string | null; // typeArbeidsforhold
  startdato: string | null;
  sluttdato: string | null;
  stillingsprosent: number | null;
  yrkeskode: string | null;
  arbeidstidsordning: string | null;
  timer_full_stilling: number | null; // antallTimerPerUkeSomEnFullStillingTilsvarer
  avlonning: string | null; // avloenningstype (fast, time, …)
  ansettelsesform: string | null; // formForAnsettelse: fast eller midlertidig
  maaned: string | null; // siste kalendermåned det sto i
};
export type Lonnsdata = {
  maaned: string | null;
  fastlonn: number | null;
  timelonn: number | null;
  timer: number | null;
};
export type Avstemmingsperson = {
  fnr: string;
  fornavn: string | null;
  etternavn: string | null;
  fodselsdato: string | null;
  arbeidsforhold: Arbeidsforhold[]; // det gjeldende først
  lonn: Lonnsdata | null; // fra siste måned med fastlønn eller timelønn
};

type Obj = Record<string, unknown>;
const erObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const nokkel = (o: Obj, ...navn: string[]) => {
  const k = Object.keys(o).find((x) => navn.includes(x.toLowerCase()));
  return k === undefined ? undefined : o[k];
};
const ID_NOKLER = ["norskidentifikator", "identifikator", "foedselsnummer", "fodselsnummer", "fnr", "personidentifikator", "dnummer", "foedselsellerdnummer"];
const elleve = (v: unknown) => {
  if (typeof v !== "string" && typeof v !== "number") return null;
  const s = String(v).replace(/\s/g, "");
  return /^\d{11}$/.test(s) ? s : null;
};
const tekstI = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
const datoI = (v: unknown) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);
const tallI = (v: unknown) => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && /^-?\d+([.,]\d+)?$/.test(v.trim())) return Number(v.trim().replace(",", "."));
  return null;
};
// Yrkeskoden: sju siffer (som tekst, tall eller i et objekt).
function sjuSiffer(v: unknown): string | null {
  if (typeof v === "string" || typeof v === "number") {
    const s = String(v).replace(/\s/g, "");
    return /^\d{7}$/.test(s) ? s : null;
  }
  if (erObj(v))
    for (const x of Object.values(v))
      if (typeof x !== "object") {
        const s = sjuSiffer(x);
        if (s) return s;
      }
  return null;
}
// Kalendermåneden et objekt gjelder (kalendermaaned, maaned, periode …), som ÅÅÅÅ-MM.
function maanedI(o: Obj): string | null {
  for (const [k, v] of Object.entries(o)) {
    if (!/maaned|periode/i.test(k) || typeof v !== "string") continue;
    const m = /^(\d{4})-(\d{2})(-\d{2})?$/.exec(v.trim());
    if (m) return `${m[1]}-${m[2]}`;
  }
  return null;
}
function egenId(o: Obj): string | null {
  for (const [k, v] of Object.entries(o))
    if (ID_NOKLER.includes(k.toLowerCase())) {
      const id = elleve(v);
      if (id) return id;
    }
  return null;
}
// Personen: et objekt med fødselsnummeret selv, eller i et lite identitetsobjekt (uten lister)
// rett under seg (da hører søsknene, som arbeidsforholdene, til personen).
function personId(o: Obj): string | null {
  const egen = egenId(o);
  if (egen) return egen;
  for (const v of Object.values(o))
    if (erObj(v) && !Object.values(v).some(Array.isArray)) {
      const id = egenId(v);
      if (id) return id;
    }
  return null;
}
function gjennom(v: unknown, maaned: string | null, fn: (o: Obj, maaned: string | null) => void) {
  if (Array.isArray(v)) return v.forEach((x) => gjennom(x, maaned, fn));
  if (!erObj(v)) return;
  const m = maanedI(v) ?? maaned;
  fn(v, m);
  for (const x of Object.values(v)) gjennom(x, m, fn);
}

// Navn med store bokstaver (som i Folkeregisteret) skrives som vanlige navn.
function pentNavn(s: string | null): string | null {
  if (!s) return null;
  const t = s.trim().replace(/\s+/g, " ");
  if (t !== t.toUpperCase() || !/\p{L}/u.test(t)) return t;
  return t.toLowerCase().replace(/(^|[\s-])(\p{L})/gu, (_, a: string, b: string) => a + b.toUpperCase());
}
function navnFra(o: Obj): { fornavn: string | null; etternavn: string | null } | null {
  const fornavn = tekstI(nokkel(o, "fornavn"));
  const mellomnavn = tekstI(nokkel(o, "mellomnavn"));
  const etternavn = tekstI(nokkel(o, "etternavn"));
  if (fornavn || etternavn)
    return {
      fornavn: pentNavn([fornavn, mellomnavn].filter(Boolean).join(" ") || null),
      etternavn: pentNavn(etternavn),
    };
  const navn = tekstI(nokkel(o, "navn", "fulltnavn"));
  if (!navn) return null;
  // «Etternavn, Fornavn», ellers er det siste ordet etternavnet.
  const [a, b] = navn.includes(",") ? navn.split(",", 2).map((x) => x.trim()) : [];
  if (a && b) return { fornavn: pentNavn(b), etternavn: pentNavn(a) };
  const ord = navn.split(/\s+/);
  return ord.length > 1
    ? {
        fornavn: pentNavn(ord.slice(0, -1).join(" ")),
        etternavn: pentNavn(ord.at(-1)!),
      }
    : { fornavn: pentNavn(navn), etternavn: null };
}

// Navnet og fødselsdatoen: på personen eller i objektene rett under (som identiteten), ikke i
// arbeidsforholdene eller inntektene (der kan virksomheten ha et navn).
const IKKE_IDENTITET = /virksomhet|arbeidsforhold|inntekt|opplysningspliktig|arbeidsgiver|fradrag|trekk|ytelse|pensjon|permisjon|utleie/i;
function identitet(
  o: Obj,
  dybde = 0,
): {
  navn: { fornavn: string | null; etternavn: string | null } | null;
  fodselsdato: string | null;
} {
  let navn = navnFra(o);
  let fodselsdato = datoI(nokkel(o, "foedselsdato", "fodselsdato"));
  if (dybde < 3)
    for (const [k, v] of Object.entries(o)) {
      if (navn && fodselsdato) break;
      if (!erObj(v) || IKKE_IDENTITET.test(k)) continue;
      const x = identitet(v, dybde + 1);
      navn ??= x.navn;
      fodselsdato ??= x.fodselsdato;
    }
  return { navn, fodselsdato };
}

const AF_FELT = ["arbeidsforholdid", "typearbeidsforhold", "stillingsprosent", "yrke", "arbeidstidsordning", "ansettelsesform", "formforansettelse", "avloenningstype"];
function arbeidsforholdFra(o: Obj, maaned: string | null): Arbeidsforhold | null {
  const start = datoI(nokkel(o, "startdato"));
  if (!start || !Object.keys(o).some((k) => AF_FELT.includes(k.toLowerCase()))) return null;
  const id = nokkel(o, "arbeidsforholdid");
  return {
    id: typeof id === "string" || typeof id === "number" ? String(id).trim() || null : null,
    type: tekstI(nokkel(o, "typearbeidsforhold")),
    startdato: start,
    sluttdato: datoI(nokkel(o, "sluttdato")),
    stillingsprosent: tallI(nokkel(o, "stillingsprosent")),
    yrkeskode: sjuSiffer(nokkel(o, "yrke", "yrkeskode")),
    arbeidstidsordning: tekstI(nokkel(o, "arbeidstidsordning")),
    timer_full_stilling: tallI(nokkel(o, "antalltimerperukesomenfullstillingtilsvarer")),
    avlonning: tekstI(nokkel(o, "avloenningstype")),
    ansettelsesform: tekstI(nokkel(o, "ansettelsesform", "formforansettelse")),
    maaned,
  };
}

// Det gjeldende arbeidsforholdet først: uten sluttdato (eller med den seneste), så det som
// startet sist.
const gjeldende = (a: Arbeidsforhold, b: Arbeidsforhold) => (b.sluttdato ?? "9999").localeCompare(a.sluttdato ?? "9999") || (b.startdato ?? "").localeCompare(a.startdato ?? "");

type Samler = {
  fnr: string;
  navn: { fornavn: string | null; etternavn: string | null } | null;
  fodselsdato: string | null;
  arbeidsforhold: Map<string, Arbeidsforhold>;
  lonn: Map<string, { fast: number; time: number; timer: number }>;
};

function samle(person: Obj, s: Samler, maaned: string | null) {
  if (!s.navn || !s.fodselsdato) {
    const id = identitet(person);
    s.navn ??= id.navn;
    s.fodselsdato ??= id.fodselsdato;
  }
  gjennom(person, maaned, (o, m) => {
    const af = arbeidsforholdFra(o, m);
    if (af) {
      const k = af.id ?? `start:${af.startdato}`;
      const gml = s.arbeidsforhold.get(k);
      // Det fra den siste måneden gjelder; felt det ikke har, beholdes fra før.
      if (!gml) s.arbeidsforhold.set(k, af);
      else {
        const [eldst, nyest] = (gml.maaned ?? "") <= (af.maaned ?? "") ? [gml, af] : [af, gml];
        s.arbeidsforhold.set(k, Object.fromEntries(Object.keys(af).map((x) => [x, nyest[x as keyof Arbeidsforhold] ?? eldst[x as keyof Arbeidsforhold]])) as Arbeidsforhold);
      }
    }
    // Lønnen: fastlønn og timelønn (beløpet, og antallet timer for timelønnen).
    const belop = tallI(nokkel(o, "beloep", "belop"));
    if (belop !== null) {
      const li = nokkel(o, "loennsinntekt");
      const kilde = erObj(li) ? li : o;
      const beskrivelse = tekstI(nokkel(kilde, "beskrivelse"))?.toLowerCase();
      if (beskrivelse === "fastloenn" || beskrivelse === "timeloenn") {
        const k = m ?? "";
        const l = s.lonn.get(k) ?? { fast: 0, time: 0, timer: 0 };
        if (beskrivelse === "fastloenn") l.fast += belop;
        else {
          l.time += belop;
          l.timer += tallI(nokkel(kilde, "antall")) ?? tallI(nokkel(o, "antall")) ?? 0;
        }
        s.lonn.set(k, l);
      }
    }
  });
}

const rund = (n: number) => Math.round(n * 100) / 100;

// Personene i rapporten (sortert etter navn), med det gjeldende arbeidsforholdet og lønnen fra
// siste måned med fastlønn eller timelønn.
export function tolkAvstemming(data: unknown): Avstemmingsperson[] {
  const samlere = new Map<string, Samler>();
  const besok = (v: unknown, maaned: string | null) => {
    if (Array.isArray(v)) return v.forEach((x) => besok(x, maaned));
    if (!erObj(v)) return;
    const m = maanedI(v) ?? maaned;
    const id = personId(v);
    if (id) {
      const s = samlere.get(id) ?? {
        fnr: id,
        navn: null,
        fodselsdato: null,
        arbeidsforhold: new Map(),
        lonn: new Map(),
      };
      samlere.set(id, s);
      samle(v, s, m);
      return;
    }
    for (const x of Object.values(v)) besok(x, m);
  };
  besok(data, null);
  return [...samlere.values()]
    .map((s) => {
      const maaneder = [...s.lonn.entries()].filter(([, l]) => l.fast > 0 || l.time > 0).sort((a, b) => b[0].localeCompare(a[0]));
      const siste = maaneder[0];
      return {
        fnr: s.fnr,
        fornavn: s.navn?.fornavn ?? null,
        etternavn: s.navn?.etternavn ?? null,
        fodselsdato: s.fodselsdato ?? fodselsdatoFraFnr(s.fnr),
        arbeidsforhold: [...s.arbeidsforhold.values()].sort(gjeldende),
        lonn: siste
          ? {
              maaned: siste[0] || null,
              fastlonn: siste[1].fast > 0 ? rund(siste[1].fast) : null,
              timelonn: siste[1].time > 0 && siste[1].timer > 0 ? rund(siste[1].time / siste[1].timer) : null,
              timer: siste[1].timer > 0 ? rund(siste[1].timer) : null,
            }
          : null,
      };
    })
    .sort((a, b) => `${a.etternavn ?? ""} ${a.fornavn ?? ""}`.localeCompare(`${b.etternavn ?? ""} ${b.fornavn ?? ""}`, "nb") || a.fnr.localeCompare(b.fnr));
}

// --- Feltene på den ansatte ------------------------------------------------------------------

const TYPER = ["ordinaertArbeidsforhold", "maritimtArbeidsforhold", "frilanserOppdragstakerHonorarPersonerMm"];
const ORDNINGER = ["ikkeSkift", "andreSkift", "skift365", "doegnkontinuerligSkiftOgTurnus355", "helkontinuerligSkiftOgAndreOrdninger336", "offshore336"];

// Arbeidsforholdet slik det skal stå på den ansatte (bare verdier som er gyldige hos oss).
export function arbeidsforholdFelt(af: Arbeidsforhold | null | undefined): Record<string, unknown> {
  if (!af) return {};
  const f: Record<string, unknown> = {};
  if (af.startdato) f.ansatt_fra = af.startdato;
  if (af.sluttdato && (!af.startdato || af.sluttdato >= af.startdato)) f.ansatt_til = af.sluttdato;
  if (af.stillingsprosent !== null && af.stillingsprosent > 0 && af.stillingsprosent <= 100) f.stillingsprosent = af.stillingsprosent;
  if (af.yrkeskode) f.yrkeskode = af.yrkeskode;
  if (af.type && TYPER.includes(af.type)) f.arbeidsforhold_type = af.type;
  if (af.arbeidstidsordning && ORDNINGER.includes(af.arbeidstidsordning)) f.arbeidstidsordning = af.arbeidstidsordning;
  if (af.timer_full_stilling !== null && af.timer_full_stilling > 0 && af.timer_full_stilling <= 60) f.ukentlig_arbeidstid = af.timer_full_stilling;
  if (af.id && /^\S{1,50}$/.test(af.id)) f.arbeidsforhold_id = af.id;
  if (af.ansettelsesform === "fast" || af.ansettelsesform === "midlertidig") f.ansettelsestype = af.ansettelsesform;
  return f;
}

// Lønnen: fastlønn (månedslønn) eller timelønn etter avlønningstypen, ellers det som ble utbetalt.
export function lonnFelt(af: Arbeidsforhold | null | undefined, l: Lonnsdata | null | undefined): Record<string, unknown> {
  const time = af?.avlonning === "time" || (!af?.avlonning && !l?.fastlonn && !!l?.timelonn);
  if (time)
    return {
      lonnstype: "time",
      ...(l?.timelonn ? { timelonn: l.timelonn } : {}),
    };
  if (af?.avlonning === "fast" || l?.fastlonn)
    return {
      lonnstype: "maaned",
      ...(l?.fastlonn ? { maanedslonn: l.fastlonn } : {}),
    };
  return {};
}

// --- Workeren ----------------------------------------------------------------------------------

export const AVSTEMMING_PAUSE = { ms: 3000, maks: 90_000 }; // mellom hver gang statusen sjekkes, og hvor lenge (endres i tester)
const vent = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
const MAKS_FORSOK = 20; // nye forsøk hvert minutt når rapporten ikke er klar

// Månedene som prøves, den siste først: den inneværende og de to før. Rapporten bestilles for én
// måned om gangen (beløpene er summene for perioden), så lønnen er lønnen for den måneden, og
// den siste måneden med en a-melding brukes.
export function maanederFor(dag: string): string[] {
  const [aar, maaned] = dag.split("-").map(Number) as [number, number];
  return [0, 1, 2].map((n) => new Date(Date.UTC(aar, maaned - 1 - n, 1)).toISOString().slice(0, 7));
}

const AVSTEMMING_HVEM = "Skatteetaten (avstemmingsrapporten)";

function avstemmingFeil(r: { status: number; data: any; tekst: string }): EtatFeil {
  const kode = r.tekst.match(/AMLD_\d+/)?.[0] ?? null;
  const d = r.data;
  const tekst = (typeof d?.melding === "string" && d.melding) || (typeof d?.detail === "string" && d.detail) || (typeof d?.title === "string" && d.title) || "";
  const med = (s: string) => `${s}${tekst ? `: ${tekst}` : ""}${kode ? ` (${kode})` : ""}`;
  if (r.status === 404 || r.status === 405 || kode === "AMLD_021" || kode === "AMLD_1023")
    return new EtatFeil(
      med(`Skatteetaten kjente ikke igjen adressen til avstemmingsrapporten (${r.status})`) + ". Adressen må rettes etter Skatteetatens spesifikasjon (docs/ansatte.md).",
      r.status,
      kode,
    );
  if (r.status === 401 || r.status === 403)
    return new EtatFeil(
      med(`Skatteetaten avviste tilgangen til avstemmingsrapporten (${r.status})`) +
        ". Sjekk at tilgangen i Altinn har tilgangspakken «A-ordningen» (Innstillinger → Lønn → Skattekort).",
      r.status,
      kode,
    );
  return new EtatFeil(med(`Skatteetaten avviste hentingen av avstemmingsrapporten (${r.status})`), r.status, kode);
}

// Feil som ikke går over av seg selv: oppgaven prøves ikke igjen.
const varig = (e: unknown) => e instanceof EtatFeil && ((e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429) || e.status === 503);

// Bestiller rapporten for én kalendermåned (POST /bestillinger). Svaret er ID-en og statusen;
// adressen til bestillingen (statusen) returneres.
async function bestill(token: string, orgnr: string, maaned: string): Promise<string> {
  const [aar, mnd] = maaned.split("-").map(Number) as [number, number];
  const r = await etatKall(`${adresser().avstemming}/bestillinger`, token, {
    metode: "POST",
    kropp: { opplysningspliktig: orgnr, oensketInntektsaar: aar, oensketPeriodeFra: mnd, oensketPeriodeTil: mnd },
    hvem: AVSTEMMING_HVEM,
  });
  if (r.status >= 300) throw avstemmingFeil(r);
  const id = r.data?.id;
  if (typeof id !== "string" || !/^[\w-]{1,100}$/.test(id)) throw new EtatFeil("Skatteetaten svarte uten ID til bestillingen av avstemmingsrapporten.", 502);
  return `${adresser().avstemming}/bestillinger/${encodeURIComponent(id)}`;
}

// Bestillingen: venter (OPPRETTES), ingen a-melding for måneden (INGEN_DATA, eller ingen rapport),
// eller rapporten (KLAR, hentet fra /rapporter/{id}, samme ID som bestillingen).
type Bestillingssvar = { klar: false } | { klar: true; rapport: unknown | null };
async function sjekkBestilling(token: string, url: string): Promise<Bestillingssvar> {
  const r = await etatKall(url, token, { hvem: AVSTEMMING_HVEM });
  if (r.status >= 300) throw avstemmingFeil(r);
  const status = typeof r.data?.status === "string" ? r.data.status.trim().toUpperCase() : "";
  if (status === "INGEN_DATA") return { klar: true, rapport: null };
  // En bestilling som feilet, blir ikke bedre av å spørres igjen: lederen bestiller på nytt.
  if (status === "FEILET") throw new EtatFeil("Skatteetaten klarte ikke å lage avstemmingsrapporten. Prøv å hente på nytt.", 422);
  if (status !== "KLAR") return { klar: false };
  const id = url.split("/").pop()!;
  const rapport = await etatKall(`${adresser().avstemming}/rapporter/${id}`, token, { hvem: AVSTEMMING_HVEM });
  if (rapport.status === 204) return { klar: true, rapport: null };
  if (rapport.status >= 300) throw avstemmingFeil(rapport);
  return { klar: true, rapport: rapport.data ?? {} };
}

async function ventPaBestilling(token: string, url: string): Promise<Bestillingssvar> {
  const slutt = Date.now() + AVSTEMMING_PAUSE.maks;
  for (;;) {
    const svar = await sjekkBestilling(token, url);
    if (svar.klar || Date.now() + AVSTEMMING_PAUSE.ms > slutt) return svar;
    await vent(AVSTEMMING_PAUSE.ms);
  }
}

async function settStatus(org: string, felt: Record<string, unknown>) {
  const k = Object.keys(felt);
  await somSystem((db) =>
    db.query(`update faktura.aordning_import set ${k.map((x, i) => `${x} = $${i + 2}`).join(", ")} where org_id = $1 and status = 'bestilt'`, [org, ...k.map((x) => felt[x])]),
  );
}

const navnNokkel = (fornavn: string | null, etternavn: string | null) => `${fornavn ?? ""} ${etternavn ?? ""}`.trim().replace(/\s+/g, " ").toLowerCase();

// Hvem i rapporten som finnes fra før: samme fødselsnummer, ellers samme navn (og samme
// fødselsdato, om den er registrert) for en ansatt uten fødselsnummer.
async function finnAnsatte(org: string, personer: Avstemmingsperson[]) {
  const ansatte = await somSystem((db) =>
    alle<{
      id: string;
      fornavn: string;
      etternavn: string;
      fnr_kryptert: Buffer | null;
      fodselsdato: string | null;
    }>(db, "select id, fornavn, etternavn, fnr_kryptert, to_char(fodselsdato, 'YYYY-MM-DD') as fodselsdato from faktura.ansatte where org_id = $1 order by ansattnummer", [org]),
  );
  const medFnr = new Map<string, string>();
  const medNavn = new Map<string, { id: string; fodselsdato: string | null } | null>(); // null: flere med samme navn
  for (let i = 0; i < ansatte.length; i += 8)
    await Promise.all(
      ansatte.slice(i, i + 8).map(async (a) => {
        if (a.fnr_kryptert) {
          const nr = (await dekrypter(a.fnr_kryptert)).trim();
          if (!medFnr.has(nr)) medFnr.set(nr, a.id);
        }
      }),
    );
  for (const a of ansatte) {
    if (a.fnr_kryptert) continue;
    const k = navnNokkel(a.fornavn, a.etternavn);
    medNavn.set(k, medNavn.has(k) ? null : { id: a.id, fodselsdato: a.fodselsdato });
  }
  return personer.map((p) => {
    const ansatt = medFnr.get(p.fnr) ?? null;
    const navn = ansatt ? null : medNavn.get(navnNokkel(p.fornavn, p.etternavn));
    const forslag = navn && (!navn.fodselsdato || !p.fodselsdato || navn.fodselsdato === p.fodselsdato) ? navn.id : null;
    return { ansatt_id: ansatt, forslag_id: forslag };
  });
}

// Det som lagres om personene (uten fødselsnumrene).
export type Importperson = {
  nr: number;
  fornavn: string | null;
  etternavn: string | null;
  fodselsdato: string | null;
  arbeidsforhold: Arbeidsforhold | null;
  antall_arbeidsforhold: number;
  lonn: Lonnsdata | null;
  sluttet: boolean;
  ansatt_id: string | null;
  forslag_id: string | null;
};

// Henter avstemmingsrapporten for organisasjonen (bestilt av lederen) og lagrer personene. Den
// siste måneden med en a-melding brukes (den inneværende, ellers en av de to før).
// bestilling og maaned: en bestilling som ikke var klar (nytt forsøk om et minutt), og måneden den gjelder.
export async function hentFraAordningen(org: string, bestilling?: string, forsok = 0, maaned?: string): Promise<{ personer: number } | null> {
  const rad = await somSystem((db) => en<{ status: string; bestilt_av: string | null }>(db, "select status, bestilt_av from faktura.aordning_import where org_id = $1", [org]));
  if (rad?.status !== "bestilt") return null;
  try {
    if (!config.ameldingInnsending) throw new EtatFeil("Hentingen fra a-ordningen er ikke slått på ennå (den bruker samme tilgang som innsendingen av a-meldingen).", 503);
    const t = await hentTilgang(org);
    if (!t?.orgnr || t.status !== "godkjent") throw new EtatFeil("Koble til Skatteetaten først (Innstillinger → Lønn → Skattekort).", 409);
    if (!harPakke(t, A_ORDNING)) throw new EtatFeil("Tilgangen i Altinn mangler tilgangspakken «A-ordningen». Utvid tilgangen under Innstillinger → Lønn → Skattekort.", 409);
    const token = await hentToken(SCOPE.amelding, t.orgnr);
    const maaneder = maanederFor(iDag());
    let mnd = maaned && /^\d{4}-\d{2}$/.test(maaned) ? maaned : maaneder[0]!;
    // Bare adressen til en bestilling hos Skatteetaten (tokenet sendes ikke andre steder).
    let url = bestilling?.startsWith(`${adresser().avstemming}/bestillinger/`) ? bestilling : null;
    let data: unknown = null;
    // Måneden rapporten gjelder, eller alle som ble prøvd når ingen hadde en a-melding.
    let periode = { fra: maaneder.at(-1)!, til: maaneder[0]! };
    for (;;) {
      url ??= await bestill(token, t.orgnr, mnd);
      const svar = await ventPaBestilling(token, url);
      if (!svar.klar) {
        if (forsok < MAKS_FORSOK) {
          await leggIKo({ type: "aordning-hent", org_id: org, bestilling: url, forsok: forsok + 1, maaned: mnd }, 60);
          return null;
        }
        throw new EtatFeil("Skatteetaten ble ikke ferdig med avstemmingsrapporten. Prøv igjen senere.", 504);
      }
      if (svar.rapport) {
        data = svar.rapport;
        periode = { fra: mnd, til: mnd };
        break;
      }
      // Ingen a-melding for måneden: måneden før, så lenge den er blant dem som prøves.
      const forrige = new Date(Date.UTC(Number(mnd.slice(0, 4)), Number(mnd.slice(5, 7)) - 2, 1)).toISOString().slice(0, 7);
      if (forrige < maaneder.at(-1)!) {
        data = {};
        break;
      }
      mnd = forrige;
      url = null;
    }
    const personer = tolkAvstemming(data);
    const treff = await finnAnsatte(org, personer);
    const fnr: Buffer[] = [];
    for (let i = 0; i < personer.length; i += 8) {
      const deler = await Promise.all(personer.slice(i, i + 8).map((p) => krypter(p.fnr)));
      fnr.push(...deler);
    }
    const dag = iDag();
    const lagret: Importperson[] = personer.map((p, i) => ({
      nr: i + 1,
      fornavn: p.fornavn,
      etternavn: p.etternavn,
      fodselsdato: p.fodselsdato,
      arbeidsforhold: p.arbeidsforhold[0] ?? null,
      antall_arbeidsforhold: p.arbeidsforhold.length,
      lonn: p.lonn,
      sluttet: !!p.arbeidsforhold[0]?.sluttdato && p.arbeidsforhold[0].sluttdato < dag,
      ...treff[i]!,
    }));
    await settStatus(org, {
      status: "klar",
      hentet: new Date().toISOString(),
      periode_fra: periode.fra,
      periode_til: periode.til,
      personer: JSON.stringify(lagret),
      fnr,
      feil: null,
    });
    logg("INFO", "Ansatte hentet fra a-ordningen", {
      org_id: org,
      personer: lagret.length,
    });
    if (rad.bestilt_av)
      await leggIKo({
        type: "varsel",
        varsel: {
          hendelse: "ansatte",
          org_id: org,
          bruker_ider: [rad.bestilt_av],
          tittel: "Hentet fra a-ordningen",
          tekst: lagret.length
            ? `${lagret.length} ${lagret.length === 1 ? "person" : "personer"} fra a-meldingene. Velg hvem som skal legges inn.`
            : "Ingen personer i a-meldingene de siste månedene.",
          url: "/ansatte?aordning=1",
          tag: `aordning-${org}`,
        },
      }).catch(() => undefined);
    return { personer: lagret.length };
  } catch (e) {
    logg("WARNING", "Hentingen fra a-ordningen feilet", {
      org_id: org,
      feil: melding(e),
    });
    await settStatus(org, varig(e) || forsok >= MAKS_FORSOK ? { status: "feil", feil: melding(e) } : { feil: melding(e) });
    if (varig(e)) return null;
    throw e;
  }
}

// --- API-et ------------------------------------------------------------------------------------

const uuid = z.string().uuid();
const orgId = (c: Context) => uuid.parse(c.req.param("org"));
const bruk = <T>(c: Context, fn: (db: Db) => Promise<T>) => somBruker<T>(c.get("bruker").id, fn);

type Importrad = {
  status: "bestilt" | "klar" | "feil";
  bestilt: string;
  hentet: string | null;
  periode_fra: string | null;
  periode_til: string | null;
  personer: Importperson[] | null;
  feil: string | null;
};
type Kjent = {
  id: string;
  ansattnummer: number;
  fornavn: string;
  etternavn: string;
  har_fnr: boolean;
  aktiv: boolean;
  ansatt_fra: string;
  ansatt_til: string | null;
  stillingsprosent: number;
  yrkeskode: string | null;
  arbeidsforhold_id: string | null;
  lonnstype: "maaned" | "time";
  maanedslonn: number | null;
  timelonn: number | null;
};

// Om hentingen kan brukes (og hvorfor ikke).
async function tilgjengelig(db: Db, org: string): Promise<{ ok: boolean; grunn: string | null }> {
  if (!config.ameldingInnsending)
    return {
      ok: false,
      grunn: "Hentingen fra a-ordningen er ikke slått på ennå.",
    };
  const t = await en<{ status: string; pakker: string[] }>(db, "select status, pakker from faktura.skattekort_tilgang where org_id = $1", [org]);
  if (t?.status !== "godkjent")
    return {
      ok: false,
      grunn: "Koble til Skatteetaten først under Innstillinger → Lønn → Skattekort.",
    };
  if (!t.pakker.includes(A_ORDNING))
    return {
      ok: false,
      grunn: "Gi tilgang til a-ordningen i Altinn først: trykk «Utvid tilgangen i Altinn» under Innstillinger → Lønn → Skattekort.",
    };
  return { ok: true, grunn: null };
}

async function oversikt(db: Db, org: string) {
  await db.query("select faktura.krev($1, 'personal')", [org]);
  const t = await tilgjengelig(db, org);
  const rad = await en<Importrad>(db, "select status, bestilt, hentet, periode_fra, periode_til, personer, feil from faktura.aordning_import where org_id = $1", [org]);
  const ider = [...new Set((rad?.personer ?? []).flatMap((p) => [p.ansatt_id, p.forslag_id]).filter((x): x is string => !!x))];
  const kjente = new Map(
    (
      await alle<Kjent>(
        db,
        `select id, ansattnummer, fornavn, etternavn, har_fnr, aktiv, to_char(ansatt_fra, 'YYYY-MM-DD') as ansatt_fra, to_char(ansatt_til, 'YYYY-MM-DD') as ansatt_til,
                stillingsprosent::float8 as stillingsprosent, yrkeskode, arbeidsforhold_id, lonnstype, maanedslonn::float8 as maanedslonn, timelonn::float8 as timelonn
           from faktura.ansatte where org_id = $1 and id = any($2::uuid[])`,
        [org, ider],
      )
    ).map((a) => [a.id, a]),
  );
  return {
    tilgjengelig: t.ok,
    grunn: t.grunn,
    henting: rad
      ? {
          ...rad,
          personer:
            rad.personer?.map((p) => ({
              ...p,
              // Den ansatte er slettet siden: personen er ny igjen.
              ansatt_id: p.ansatt_id && kjente.has(p.ansatt_id) ? p.ansatt_id : null,
              ansatt: (p.ansatt_id && kjente.get(p.ansatt_id)) || null,
              forslag: (p.forslag_id && kjente.get(p.forslag_id)) || null,
            })) ?? null,
        }
      : null,
  };
}

const f = ansattSkjema.shape;
const leggInnSkjema = z.object({
  valgte: z
    .array(
      z.object({
        nr: z.number().int().min(1),
        // ny: legges inn; oppdater: arbeidsforholdet skrives på den ansatte som finnes (eller ansatt_id).
        handling: z.enum(["ny", "oppdater"]),
        ansatt_id: uuid.optional(),
        fornavn: f.fornavn.optional(),
        etternavn: f.etternavn.optional(),
      }),
    )
    .min(1, "Velg minst én person")
    .max(1000, "Høyst 1000 om gangen"),
});

export function aordningRuter() {
  const r = new Hono();

  r.get("/ansatte/aordning", async (c) => c.json(await bruk(c, (db) => oversikt(db, orgId(c)))));

  // Lederen ber om en ny henting (workeren henter rapporten).
  r.post("/ansatte/aordning/hent", async (c) => {
    const org = orgId(c);
    const ny = await bruk(c, async (db) => {
      await db.query("select faktura.krev($1, 'personal')", [org]);
      const t = await tilgjengelig(db, org);
      if (!t.ok) throw new ApiFeil(409, t.grunn!);
      return (await en<{ ny: boolean }>(db, "select faktura.bestill_aordning($1) as ny", [org]))!.ny;
    });
    if (ny) await leggIKo({ type: "aordning-hent", org_id: org });
    return c.json(await bruk(c, (db) => oversikt(db, org)));
  });

  // De valgte legges inn (nye) eller oppdateres (de som finnes). Nye får fødselsnummeret,
  // arbeidsforholdet og lønnen fra a-ordningen. De som finnes, får arbeidsforholdet slik det er
  // rapportert (startdato, stillingsprosent, yrkeskode, arbeidstidsordning og arbeidsforholdID-en,
  // så a-meldingen fortsetter det samme arbeidsforholdet), lønnen bare når de ikke har noen, og
  // fødselsnummeret når de mangler det.
  r.post("/ansatte/aordning/legg-inn", async (c) => {
    const b = leggInnSkjema.parse(await c.req.json().catch(() => ({})));
    const org = orgId(c);
    const resultat = await bruk(c, async (db) => {
      await db.query("select faktura.krev($1, 'personal')", [org]);
      const rad = await en<Importrad>(db, "select status, personer from faktura.aordning_import where org_id = $1", [org]);
      if (rad?.status !== "klar" || !rad.personer) throw new ApiFeil(409, "Hent fra a-ordningen først");
      const full = (await regler(db, org)).full_stilling;
      const antall = { ny: 0, oppdatert: 0 };
      const medFnr: string[] = [];
      for (const v of b.valgte) {
        const p = rad.personer[v.nr - 1];
        if (!p) throw new ApiFeil(404, "Fant ikke personen i hentingen");
        const hvem =
          [v.fornavn ?? p.fornavn, v.etternavn ?? p.etternavn].filter(Boolean).join(" ") ||
          (p.fodselsdato ? `Personen født ${p.fodselsdato.split("-").reverse().join(".")}` : `Person ${v.nr}`);
        try {
          const af = arbeidsforholdFelt(p.arbeidsforhold);
          if (v.handling === "ny") {
            if (p.ansatt_id && (await en(db, "select 1 from faktura.ansatte where org_id = $1 and id = $2", [org, p.ansatt_id]))) throw new ApiFeil(409, "er registrert fra før");
            const fornavn = v.fornavn ?? p.fornavn;
            const etternavn = v.etternavn ?? p.etternavn;
            if (!fornavn || !etternavn) throw new ApiFeil(400, "skriv fornavn og etternavn");
            const felt: Record<string, unknown> = {
              fornavn,
              etternavn,
              fodselsdato: p.fodselsdato,
              ukentlig_arbeidstid: full,
              ...af,
              ...lonnFelt(p.arbeidsforhold, p.lonn),
              ...(p.sluttet ? { aktiv: false } : {}),
            };
            const k = Object.keys(felt);
            const ny = (await en<{ id: string }>(db, `insert into faktura.ansatte (org_id, ${k.join(", ")}) values ($1, ${k.map((_, i) => `$${i + 2}`).join(", ")}) returning id`, [
              org,
              ...k.map((x) => felt[x]),
            ]))!.id;
            await db.query("select faktura.aordning_sett_fnr($1, $2, $3)", [org, ny, v.nr]);
            antall.ny++;
            if (!p.sluttet) medFnr.push(ny);
            continue;
          }
          const mal = v.ansatt_id ?? p.ansatt_id ?? p.forslag_id;
          if (!mal) throw new ApiFeil(400, "velg hvem i registeret personen er");
          const a = await en<{
            har_fnr: boolean;
            maanedslonn: number | null;
            timelonn: number | null;
            fodselsdato: string | null;
          }>(db, "select har_fnr, maanedslonn, timelonn, to_char(fodselsdato, 'YYYY-MM-DD') as fodselsdato from faktura.ansatte where org_id = $1 and id = $2", [org, mal]);
          if (!a) throw new ApiFeil(404, "fant ikke den ansatte");
          // En ansatt med et annet fødselsnummer er en annen person.
          if (a.har_fnr && p.ansatt_id !== mal) throw new ApiFeil(409, "den ansatte har et annet fødselsnummer");
          const felt: Record<string, unknown> = { ...af };
          if (a.maanedslonn === null && a.timelonn === null) Object.assign(felt, lonnFelt(p.arbeidsforhold, p.lonn));
          if (!a.fodselsdato && p.fodselsdato) felt.fodselsdato = p.fodselsdato;
          const k = Object.keys(felt);
          if (k.length)
            await db.query(`update faktura.ansatte set ${k.map((x, i) => `${x} = $${i + 3}`).join(", ")} where org_id = $1 and id = $2`, [org, mal, ...k.map((x) => felt[x])]);
          if (!a.har_fnr) {
            await db.query("select faktura.aordning_sett_fnr($1, $2, $3)", [org, mal, v.nr]);
            medFnr.push(mal);
          }
          antall.oppdatert++;
        } catch (e) {
          const h = tilHttp(e);
          throw new ApiFeil(h.status, `${hvem}: ${h.error}`);
        }
      }
      return { antall, medFnr };
    });
    await hentSkattekortFor(c, resultat.medFnr);
    return c.json({
      antall: resultat.antall,
      ...(await bruk(c, (db) => oversikt(db, org))),
    });
  });

  return r;
}
