// Trekkpålegg fra Skatteetaten i workeren (0127_trekkpaalegg.sql, docs/trekkpaalegg.md). Med
// systembrukeren organisasjonen har gitt systemet i Altinn (ressursen «Informasjon om
// trekkpålegg») og scopet skatteetaten:trekkpaalegg hentes siste versjon av alle påleggene der
// organisasjonen er trekkpliktig: hver morgen fra kl. 06, med en gang tilgangen er gitt, og når
// appen ber om det («Hent nå»). Før Skatteetaten har lagt inn pålegg, er svaret en tom liste.
//
// Hvert pålegg lagres med siste versjon; et pålegg som alt er lagret med samme eller en nyere
// versjon (sekvensnummeret), endres ikke. Skyldneren (fødselsnummeret) kobles til den ansatte med
// det fødselsnummeret (bare workeren dekrypterer fødselsnumrene); fødselsnummeret lagres ikke,
// bare fødselsdatoen. Et pålegg for en ansatt blir et fast trekk i lønnen
// (faktura.koble_trekkpaalegg), og lønnskjøringen trekker det som gjelder på utbetalingsdatoen
// (lonnstrekk.ts). Nye, endrede og avsluttede pålegg gir varsel til eier, administrator og den
// som har lønn; det lederen bør se på (en skyldner som ikke er registrert, en ansatt som har
// sluttet, et trekk lagt inn for hånd som kan være det samme), står som merknader på pålegget.
// https://skatteetaten.github.io/api-dokumentasjon/api/trekkpaalegg
import { alle, en, somSystem, type Db } from "./db.js";
import { config } from "./config.js";
import { dekrypter } from "./kryptering.js";
import { adresser, EtatFeil, etatKall, hentToken, SCOPE } from "./maskinporten.js";
import { TREKKPAALEGG_RESSURS } from "./altinn.js";
import { harPakke, hentTilgang, melding, skattFeil } from "./skattekort.js";
import { fodselsdato } from "./fnr.js";
import { kontonrGyldig } from "./regler.js";
import { leggIKo } from "./tjenester.js";
import { storrelseTekst, type Paaleggsperiode } from "./lonnstrekk.js";

const logg = (severity: string, message: string, data: Record<string, unknown> = {}) => console.log(JSON.stringify({ severity, message, ...data }));
const visDato = (d: string) => d.split("-").reverse().join(".");

// --- Pålegget slik Skatteetaten gir det ----------------------------------------------------------

export type Paalegg = {
  trekkid: string;
  trekkversjon: number;
  sekvensnummer: number;
  saksnummer: string | null;
  trekkstatus: "aktiv" | "avsluttet";
  formidlet: string | null; // når versjonen ble formidlet («opprettet»)
  skyldner: string | null; // fødselsnummeret (lagres ikke)
  trekkpliktig: string | null;
  betalingsmottaker: string | null;
  kontonr: string | null;
  kid: string | null;
  perioder: Paaleggsperiode[];
};

const tekst = (x: unknown, maks: number) => (typeof x === "string" || typeof x === "number" ? String(x).trim().slice(0, maks) || null : null);
const siffer = (x: unknown, re: RegExp) => {
  const s = typeof x === "string" || typeof x === "number" ? String(x).replace(/[\s.]/g, "") : "";
  return re.test(s) ? s : null;
};
const dato = (x: unknown) => (typeof x === "string" && /^\d{4}-\d{2}-\d{2}/.test(x) ? x.slice(0, 10) : null);
const tall = (x: unknown): number | null => {
  const n = typeof x === "number" ? x : typeof x === "string" && x.trim() ? Number(x.replace(",", ".")) : NaN;
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
};
// Beløpet eller prosenten står i et eget objekt ({trekkbeloep: {trekkbeloep: 5000}}); et tall rett
// i feltet godtas også.
const storrelse = (x: any, felt: string) => (x && typeof x === "object" ? tall(x[felt]) : tall(x));

export function tolkPaalegg(r: any): Paalegg | null {
  const trekkid = tekst(r?.trekkid, 100);
  if (!trekkid) return null;
  const b = r?.betalingsinformasjon ?? {};
  const perioder: Paaleggsperiode[] = (Array.isArray(r?.trekkstoerrelseForPeriode) ? r.trekkstoerrelseForPeriode : [])
    .map((p: any): Paaleggsperiode | null => {
      const fra = dato(p?.startdato);
      if (!fra) return null;
      const prosent = p?.trekkprosent != null ? storrelse(p.trekkprosent, "trekkprosent") : null;
      const belop = p?.trekkbeloep != null ? storrelse(p.trekkbeloep, "trekkbeloep") : null;
      return { fra, til: dato(p?.sluttdato), belop: prosent != null ? null : belop, prosent };
    })
    .filter((p: Paaleggsperiode | null): p is Paaleggsperiode => Boolean(p))
    .sort((x: Paaleggsperiode, y: Paaleggsperiode) => x.fra.localeCompare(y.fra));
  const formidlet = typeof r?.opprettet === "string" && !Number.isNaN(Date.parse(r.opprettet)) ? new Date(r.opprettet).toISOString() : null;
  return {
    trekkid,
    trekkversjon: Math.max(1, Math.floor(Number(r?.trekkversjon) || 1)),
    sekvensnummer: Math.max(0, Math.floor(Number(r?.sekvensnummer) || 0)),
    saksnummer: tekst(r?.saksnummer, 100),
    trekkstatus: String(r?.trekkstatus ?? "").toLowerCase() === "avsluttet" ? "avsluttet" : "aktiv",
    formidlet,
    skyldner: siffer(r?.skyldner, /^\d{11}$/),
    trekkpliktig: siffer(r?.trekkpliktig, /^\d{9}$/),
    betalingsmottaker: siffer(b.betalingsmottaker, /^\d{9}$/),
    kontonr: siffer(b.kontonummer, /^\d{11}$/),
    kid: siffer(b.kidnummer, /^\d{2,25}$/),
    perioder,
  };
}

// --- Kallet til Skatteetaten --------------------------------------------------------------------

// Ingen pålegg (Skatteetatens felles feilkoder for ingen treff).
const INGEN = new Set(["KB-007", "KB-009"]);

// Siste versjon av alle påleggene der organisasjonen er trekkpliktig.
export async function hentFraSkatteetaten(orgnr: string): Promise<Paalegg[]> {
  const token = await hentToken(SCOPE.trekkpaalegg, orgnr);
  const hva = "Kunne ikke hente trekkpåleggene fra Skatteetaten";
  const r = await etatKall(adresser().trekkpaalegg, token, { hvem: "Skatteetaten" });
  const kode = typeof r.data?.kode === "string" ? r.data.kode : null;
  if (r.status === 204 || (r.status === 404 && kode && INGEN.has(kode))) return [];
  if (r.status === 403)
    throw new EtatFeil(
      `${hva}: Skatteetaten avviste tilgangen (403${kode ? `, ${kode}` : ""}). Ressursen «Informasjon om trekkpålegg» må være godkjent i Altinn (Lønn → Skattekort → «Utvid tilgangen i Altinn»).`,
      403,
      kode,
    );
  if (r.status !== 200) {
    const f = skattFeil(r, hva);
    // Ukjent adresse (KB-003, eller en vanlig 404-side): adressen i maskinporten.ts må rettes.
    if (r.status === 404 && (!kode || kode === "KB-003"))
      throw new EtatFeil(`${f.message} Skatteetaten kjente ikke igjen adressen appen bruker; si fra til ${config.altinnSystemnavn}.`, 404, kode);
    throw f;
  }
  const liste: unknown[] = Array.isArray(r.data) ? r.data : Array.isArray(r.data?.trekkpaalegg) ? r.data.trekkpaalegg : [];
  return liste.map(tolkPaalegg).filter((p): p is Paalegg => Boolean(p));
}

// --- Lagringen -----------------------------------------------------------------------------------

type Ansatt = { id: string; navn: string; aktiv: boolean };

// Fødselsnumrene til de ansatte i organisasjonen (dekryptert, bare i workeren). Har flere det samme
// fødselsnummeret, gjelder den som er aktiv.
async function ansatteEtterFnr(org: string): Promise<Map<string, Ansatt>> {
  const rader = await somSystem((db) =>
    alle<Ansatt & { fnr_kryptert: Buffer }>(
      db,
      `select id, fornavn || ' ' || etternavn as navn, aktiv, fnr_kryptert from faktura.ansatte
        where org_id = $1 and fnr_kryptert is not null order by aktiv desc, ansattnummer`,
      [org],
    ),
  );
  const m = new Map<string, Ansatt>();
  for (const r of rader) {
    const fnr = (await dekrypter(r.fnr_kryptert)).replace(/\s/g, "");
    if (!m.has(fnr)) m.set(fnr, { id: r.id, navn: r.navn, aktiv: r.aktiv });
  }
  return m;
}

type Lagret = { id: string; ny: boolean; nyVersjon: boolean; avsluttet: boolean; ansatt: Ansatt | null; fodt: string | null; merknader: string[] };

// Lagrer pålegget og kobler det til den ansatte og trekket i lønnen (i én transaksjon).
async function lagrePaalegg(org: string, p: Paalegg, ansatt: Ansatt | null): Promise<Lagret> {
  const fodt = p.skyldner ? fodselsdato(p.skyldner) : null;
  return somSystem(async (db) => {
    const gammel = await en<{ id: string; sekvensnummer: number; trekkversjon: number; trekkstatus: string }>(
      db,
      "select id, sekvensnummer::float8 as sekvensnummer, trekkversjon, trekkstatus from faktura.trekkpaalegg where org_id = $1 and trekkid = $2 for update",
      [org, p.trekkid],
    );
    const nyVersjon = !gammel || p.sekvensnummer > gammel.sekvensnummer || (p.sekvensnummer === gammel.sekvensnummer && p.trekkversjon > gammel.trekkversjon);
    const merknader = await merknaderFor(db, org, p, ansatt, fodt);
    let id: string;
    if (!gammel) {
      id = (await en<{ id: string }>(
        db,
        `insert into faktura.trekkpaalegg (org_id, trekkid, trekkversjon, sekvensnummer, saksnummer, trekkstatus, formidlet, ansatt_id, fodselsdato,
                                           betalingsmottaker, kontonr, kid, perioder, merknader)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) returning id`,
        [org, p.trekkid, p.trekkversjon, p.sekvensnummer, p.saksnummer, p.trekkstatus, p.formidlet, ansatt?.id ?? null, fodt, p.betalingsmottaker, p.kontonr, p.kid, JSON.stringify(p.perioder), merknader],
      ))!.id;
    } else {
      id = gammel.id;
      if (nyVersjon)
        await db.query(
          `update faktura.trekkpaalegg set trekkversjon = $2, sekvensnummer = $3, saksnummer = $4, trekkstatus = $5, formidlet = $6, ansatt_id = $7, fodselsdato = $8,
                  betalingsmottaker = $9, kontonr = $10, kid = $11, perioder = $12, merknader = $13, endret = now()
            where id = $1`,
          [id, p.trekkversjon, p.sekvensnummer, p.saksnummer, p.trekkstatus, p.formidlet, ansatt?.id ?? null, fodt, p.betalingsmottaker, p.kontonr, p.kid, JSON.stringify(p.perioder), merknader],
        );
      // Samme versjon: bare koblingen til den ansatte og merknadene kan ha endret seg.
      else
        await db.query(
          `update faktura.trekkpaalegg set ansatt_id = $2, fodselsdato = $3, merknader = $4
            where id = $1 and (ansatt_id, fodselsdato, merknader) is distinct from ($2::uuid, $3::date, $4::text[])`,
          [id, ansatt?.id ?? null, fodt, merknader],
        );
    }
    await db.query("select faktura.koble_trekkpaalegg($1)", [id]);
    return {
      id,
      ny: !gammel,
      nyVersjon: Boolean(gammel) && nyVersjon,
      avsluttet: p.trekkstatus === "avsluttet" && gammel?.trekkstatus !== "avsluttet",
      ansatt,
      fodt,
      merknader,
    };
  });
}

// Det lederen bør se på for pålegget.
async function merknaderFor(db: Db, org: string, p: Paalegg, ansatt: Ansatt | null, fodt: string | null): Promise<string[]> {
  const m: string[] = [];
  const aktiv = p.trekkstatus === "aktiv";
  if (!ansatt) {
    if (aktiv)
      m.push(
        p.skyldner
          ? `Skyldneren${fodt ? ` (født ${visDato(fodt)})` : ""} er ikke registrert med fødselsnummer her. Legg inn fødselsnummeret på den ansatte, så trekkes pålegget i lønnen. Er personen ikke ansatt hos dere, si fra til Skatteetaten.`
          : "Pålegget har ikke fødselsnummeret til skyldneren, så det kan ikke kobles til en ansatt.",
      );
    return m;
  }
  if (aktiv && !ansatt.aktiv) m.push(`${ansatt.navn} er ikke aktiv ansatt her. Har arbeidsforholdet opphørt, si fra til Skatteetaten.`);
  if (p.kontonr && !kontonrGyldig(p.kontonr)) m.push(`Kontonummeret i pålegget (${p.kontonr}) er ikke gyldig, så trekket kommer ikke med i betalingsfila. Si fra til Skatteetaten.`);
  // Et samordnet utleggstrekk lagt inn for hånd med en annen (eller uten) KID kan være det samme
  // pålegget (med samme KID kobles det til pålegget).
  if (aktiv) {
    const egne = await en<{ n: number }>(
      db,
      `select count(*)::int as n from faktura.lonnstrekk
        where org_id = $1 and ansatt_id = $2 and paalegg_id is null and type = 'utlegg_samordnet' and kid is distinct from $3
          and (til is null or til >= faktura.i_dag())`,
      [org, ansatt.id, p.kid],
    );
    if (egne && egne.n > 0)
      m.push(
        `${ansatt.navn} har også et samordnet utleggstrekk som er lagt inn for hånd. Er det det samme pålegget, avslutt trekket for hånd, så det ikke trekkes to ganger.`,
      );
  }
  return m;
}

async function lagreHenting(org: string, felt: { hentet?: Date; antall?: number; feil: string | null }) {
  await somSystem((db) =>
    db.query(
      `update faktura.trekkpaalegg_henting set hentet = coalesce($2, hentet), antall = coalesce($3, antall), feil = $4 where org_id = $1`,
      [org, felt.hentet ?? null, felt.antall ?? null, felt.feil],
    ),
  );
}

// Varsel til eier, administrator og dem med lønn (en egen rolle med Lønn).
async function varsle(org: string, tittel: string, tekst: string, tag: string) {
  const mottakere = await somSystem((db) =>
    alle<{ bruker_id: string }>(db, "select bruker_id from faktura.medlemmer where org_id = $1 and (rolle in ('eier', 'admin') or faktura.tilpasset_har(org_id, bruker_id, 'lonn'))", [org]),
  );
  if (mottakere.length)
    await leggIKo({
      type: "varsel",
      varsel: { hendelse: "trekkpaalegg", org_id: org, bruker_ider: mottakere.map((m) => m.bruker_id), tittel, tekst, url: "/lonn?fane=trekkpaalegg", tag },
    }).catch(() => undefined);
}

// Hva varselet sier om pålegget: for hvem, og trekket som gjelder nå eller kommer.
function beskriv(p: Paalegg, l: Lagret) {
  const hvem = l.ansatt ? l.ansatt.navn : `en som ikke er registrert her${l.fodt ? ` (født ${visDato(l.fodt)})` : ""}`;
  const siste = p.perioder.at(-1);
  if (p.trekkstatus === "avsluttet") {
    const slutt = p.perioder.map((x) => x.til).filter((x): x is string => Boolean(x)).sort().at(-1);
    return `Trekkpålegget for ${hvem}${p.saksnummer ? ` (sak ${p.saksnummer})` : ""} er avsluttet${slutt ? ` fra ${visDato(slutt)}` : ""}.`;
  }
  const forst = hvem.charAt(0).toUpperCase() + hvem.slice(1);
  return `${forst}${p.saksnummer ? ` (sak ${p.saksnummer})` : ""}: ${siste ? `${storrelseTekst(siste)} fra ${visDato(siste.fra)}` : "uten trekk"}.`;
}

const varig = (e: unknown) => e instanceof EtatFeil && ((e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429) || e.status === 503);

// Henter påleggene for organisasjonen og lagrer dem. Feil som kan gå over (ingen svar fra
// Skatteetaten, 5xx), kastes etter at de er lagret, så Cloud Tasks prøver igjen.
export async function hentTrekkpaalegg(org: string): Promise<{ antall: number; nye: number; endret: number } | null> {
  if (!config.trekkpaalegg) return null;
  const t = await hentTilgang(org);
  if (!t?.orgnr || !harPakke(t, TREKKPAALEGG_RESSURS)) return null;
  await somSystem((db) =>
    db.query("insert into faktura.trekkpaalegg_henting (org_id, forsokt) values ($1, now()) on conflict (org_id) do update set forsokt = now()", [org]),
  );
  let liste: Paalegg[];
  try {
    liste = await hentFraSkatteetaten(t.orgnr);
  } catch (e) {
    logg("WARNING", "Trekkpåleggene ble ikke hentet fra Skatteetaten", { org_id: org, feil: melding(e) });
    await lagreHenting(org, { feil: melding(e) });
    if (varig(e)) return null;
    throw e;
  }
  // Fødselsnumrene dekrypteres bare når det er pålegg å koble.
  const ansatte = liste.length ? await ansatteEtterFnr(org) : new Map<string, Ansatt>();
  const svar = { antall: liste.length, nye: 0, endret: 0 };
  // De eldste først, så de nyeste versjonene vinner om samme trekk-ID står flere ganger.
  for (const p of [...liste].sort((a, b) => a.sekvensnummer - b.sekvensnummer)) {
    const l = await lagrePaalegg(org, p, p.skyldner ? (ansatte.get(p.skyldner) ?? null) : null);
    if (l.ny) svar.nye++;
    if (l.nyVersjon) svar.endret++;
    const tittel = l.ny
      ? p.trekkstatus === "avsluttet"
        ? null
        : "Nytt trekkpålegg fra Skatteetaten"
      : l.nyVersjon
        ? l.avsluttet
          ? "Trekkpålegg avsluttet"
          : "Endret trekkpålegg fra Skatteetaten"
        : null;
    if (tittel) await varsle(org, tittel, `${beskriv(p, l)}${l.merknader.length ? " Se merknadene i appen." : ""}`, `trekkpaalegg-${l.id}`);
  }
  await lagreHenting(org, { hentet: new Date(), antall: liste.length, feil: null });
  logg("INFO", "Trekkpålegg fra Skatteetaten", { org_id: org, ...svar });
  return svar;
}

// Hvert minutt (hjerteslaget): organisasjonene med ressursen og Lønn som ikke er hentet ennå
// (tilgangen er nettopp gitt), og hver morgen fra kl. 06 de andre. De merkes først, så de ikke
// legges i kø hvert minutt mens de hentes.
export async function planleggTrekkpaalegg(): Promise<number> {
  if (!config.trekkpaalegg) return 0;
  const rader = await somSystem((db) =>
    alle<{ org_id: string }>(
      db,
      `insert into faktura.trekkpaalegg_henting (org_id, forsokt)
       select t.org_id, now() from faktura.skattekort_tilgang t
         left join faktura.trekkpaalegg_henting h on h.org_id = t.org_id
        where t.status = 'godkjent' and $1 = any(t.pakker) and faktura.har_funksjon(t.org_id, 'lonn')
          and (h.forsokt is null
               or ((now() at time zone 'Europe/Oslo')::time >= time '06:00'
                   and h.forsokt < ((now() at time zone 'Europe/Oslo')::date + time '06:00') at time zone 'Europe/Oslo'))
       on conflict (org_id) do update set forsokt = now()
       returning org_id`,
      [TREKKPAALEGG_RESSURS],
    ),
  );
  for (const r of rader) await leggIKo({ type: "trekkpaalegg-hent", org_id: r.org_id });
  return rader.length;
}
