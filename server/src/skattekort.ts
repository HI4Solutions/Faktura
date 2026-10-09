// Skattekort til arbeidsgiver fra Skatteetaten (0068_skattekort_fra_skatteetaten.sql). Workeren
// bestiller skattekortene til de ansatte med fødselsnummer (høyst 1000 om gangen), venter på
// svaret og lagrer dem på de ansatte: alle trekkodene (skattekort_trekk), og trekket for lønn
// fra hovedarbeidsgiver (eller biarbeidsgiver) som skattekortet lønnskjøringen bruker.
//
//   Når tilgangen er godkjent, og når appen ber om det: alle de ansatte (eller de valgte).
//   Hver dag: endringene siden sist, de som ikke har skattekortet for året fra Skatteetaten,
//   og de som ikke er hentet på en uke.
//
// Tokenet gjelder systembrukeren organisasjonen har godkjent i Altinn (altinn.ts). Bestillingen
// gir en referanse, og svaret hentes med den (204 til det er klart, minst 2 sekunder mellom
// hver gang). Er svaret ikke klart innen et par minutter, hentes det i en ny oppgave.
// https://skatteetaten.github.io/api-dokumentasjon/api/skattekorttilarbeidsgiver
import { alle, en, somSystem } from "./db.js";
import { dekrypter } from "./kryptering.js";
import { adresser, EtatFeil, etatKall, hentToken, SCOPE, systemId } from "./maskinporten.js";
import { hentEndringsforesporsel, hentForesporsel, lagEndringsforesporsel, lagForesporsel, registrerSystem, tilgangspakker } from "./altinn.js";
import { leggIKo } from "./tjenester.js";

const logg = (severity: string, message: string, data: Record<string, unknown> = {}) => console.log(JSON.stringify({ severity, message, ...data }));

// --- Svaret fra Skatteetaten ---------------------------------------------------------------------

// Ett forskuddstrekk på skattekortet. tabell: trekktabellen (prosent er da satsen for ekstra
// kjøringer); prosent: prosenttrekk; frikort: beløpsgrensen (null: uten grense).
export type Trekk = { trekkode: string; tabell?: number; prosent?: number; frikort?: number | null; maaneder?: number };

export type Skattekortsvar = {
  fnr: string;
  resultat: string; // f.eks. skattekortopplysningerOK, ikkeSkattekort, ikkeTrekkplikt
  aar: number | null;
  utstedt: string | null;
  tillegg: string[]; // f.eks. oppholdPaaSvalbard, kildeskattPaaLoenn
  trekk: Trekk[] | null; // null: svaret har ikke skattekort
};

// Trekkodene står som LOENN_FRA_HOVEDARBEIDSGIVER i JSON og loennFraHovedarbeidsgiver i XML.
export const trekkode = (k: string) => k.trim().replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();

const tall = (v: unknown): number | undefined => {
  const n = typeof v === "string" ? Number(v.trim().replace(",", ".")) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : undefined;
};

function tilTrekk(t: any): Trekk | null {
  if (typeof t?.trekkode !== "string" || !t.trekkode.trim()) return null;
  const r: Trekk = { trekkode: trekkode(t.trekkode).slice(0, 80) };
  const kilde = t.trekktabell ?? t.trekkprosent;
  if (t.trekktabell) {
    const tabell = tall(t.trekktabell.tabellnummer);
    if (tabell !== undefined) r.tabell = tabell;
  }
  if (kilde) {
    const p = tall(kilde.prosentsats);
    if (p !== undefined) r.prosent = p;
    const m = tall(kilde.antallMaanederForTrekk);
    if (m !== undefined) r.maaneder = m;
  } else if (t.frikort) {
    r.frikort = tall(t.frikort.frikortbeloep) ?? null;
  }
  return r;
}

export function tolkSvar(data: any): Skattekortsvar[] {
  const ut: Skattekortsvar[] = [];
  for (const ag of Array.isArray(data?.arbeidsgiver) ? data.arbeidsgiver : []) {
    for (const a of Array.isArray(ag?.arbeidstaker) ? ag.arbeidstaker : []) {
      const fnr = String(a?.arbeidstakeridentifikator ?? "").trim();
      if (!/^\d{11}$/.test(fnr)) continue;
      const kort = a?.skattekort;
      const liste = Array.isArray(kort?.forskuddstrekk) ? kort.forskuddstrekk : null;
      const utstedt = typeof kort?.utstedtDato === "string" && /^\d{4}-\d{2}-\d{2}/.test(kort.utstedtDato) ? kort.utstedtDato.slice(0, 10) : null;
      ut.push({
        fnr,
        resultat: String(a?.resultatForSkattekort ?? a?.resultatPaaForespoersel ?? "").slice(0, 100),
        aar: tall(a?.inntektsaar) ?? null,
        utstedt,
        tillegg: (Array.isArray(a?.tilleggsopplysning) ? a.tilleggsopplysning : [])
          .filter((x: unknown): x is string => typeof x === "string" && x.length > 0)
          .map((x: string) => x.slice(0, 60))
          .slice(0, 10),
        trekk: liste ? liste.map(tilTrekk).filter((x: Trekk | null): x is Trekk => x !== null) : null,
      });
    }
  }
  return ut;
}

export type Kort = {
  skattekort: "tabell" | "prosent" | "frikort" | null;
  skatt_tabell: number | null;
  skatt_prosent: number | null;
  skatt_frikort: number | null;
};

// Skattekortet lønnen trekkes etter: trekket for lønn fra hovedarbeidsgiver, eller fra
// biarbeidsgiver når den ansatte har hovedarbeidsgiveren et annet sted (den andre om det ene
// mangler). null: skattekortet har ikke trekk for lønn (f.eks. bare pensjon).
export function kortFraTrekk(trekk: Trekk[], biarbeidsgiver: boolean): Kort | null {
  const hoved = trekk.find((t) => t.trekkode === "LOENN_FRA_HOVEDARBEIDSGIVER");
  const bi = trekk.find((t) => t.trekkode === "LOENN_FRA_BIARBEIDSGIVER");
  const t = biarbeidsgiver ? (bi ?? hoved) : (hoved ?? bi);
  if (!t) return null;
  if (t.tabell !== undefined && t.tabell >= 1000 && t.tabell <= 9999 && t.prosent !== undefined)
    return { skattekort: "tabell", skatt_tabell: t.tabell, skatt_prosent: t.prosent, skatt_frikort: null };
  if ("frikort" in t) return { skattekort: "frikort", skatt_tabell: null, skatt_prosent: null, skatt_frikort: t.frikort ?? null };
  if (t.prosent !== undefined) return { skattekort: "prosent", skatt_tabell: null, skatt_prosent: t.prosent, skatt_frikort: null };
  return null;
}

// Skattekortet etter svaret: fra trekket på kortet; uten skattekort ingen (det trekkes 50 %);
// uten trekkplikt frikort uten grense (ingen trekk). undefined: svaret endrer ikke skattekortet
// (f.eks. ugyldig fødselsnummer).
export function kortFraSvar(s: Skattekortsvar, biarbeidsgiver: boolean): Kort | undefined {
  if (s.trekk?.length) return kortFraTrekk(s.trekk, biarbeidsgiver) ?? undefined;
  if (s.resultat === "ikkeSkattekort") return { skattekort: null, skatt_tabell: null, skatt_prosent: null, skatt_frikort: null };
  if (s.resultat === "ikkeTrekkplikt") return { skattekort: "frikort", skatt_tabell: null, skatt_prosent: null, skatt_frikort: null };
  return undefined;
}

// --- Kallene til Skatteetaten ------------------------------------------------------------------

function skattFeil(svar: { status: number; data: any }, hva: string): EtatFeil {
  const kode = typeof svar.data?.kode === "string" ? svar.data.kode : null;
  const melding = typeof svar.data?.melding === "string" ? svar.data.melding : null;
  if (svar.status === 403 && !melding)
    return new EtatFeil(`${hva}: Skatteetaten avviste tilgangen (403). Sjekk at tilgangen i Altinn fortsatt er godkjent.`, 403, kode);
  return new EtatFeil(`${hva}: ${melding ?? `Skatteetaten svarte ${svar.status}`}${kode ? ` (${kode})` : ""}`, svar.status, kode);
}

// Referansen til bestillingen (BR og sifre), i hvilket felt den enn står.
export function finnReferanse(svar: { data: any; tekst: string; headers: Headers }): string | null {
  const ref = (v: unknown) => (typeof v === "string" && /^BR\d+$/.test(v.trim()) ? v.trim() : null);
  if (svar.data && typeof svar.data === "object") for (const v of Object.values(svar.data)) if (ref(v)) return ref(v);
  return ref(svar.data) ?? svar.tekst.match(/\bBR\d+\b/)?.[0] ?? svar.headers.get("location")?.match(/BR\d+/)?.[0] ?? null;
}

export type Bestilling = {
  aar: number;
  orgnr: string;
  fnr?: string[]; // uten: endringene siden sist
  kontakt: { epost: string | null; telefon: string | null };
};

// Et norsk mobilnummer (+47 og åtte sifre som begynner med 4 eller 9), ellers null.
export function mobilnummer(tlf: string | null): string | null {
  const s = (tlf ?? "").replace(/[\s().-]/g, "").replace(/^(\+47|0047)/, "");
  return /^[49]\d{7}$/.test(s) ? `+47${s}` : null;
}

// Kontaktinformasjonen er organisasjonens e-post (og mobilnummer); Skatteetaten varsler der når
// et skattekort endres.
export function bestillingskropp(b: Bestilling) {
  const kontakt = Object.fromEntries(
    Object.entries({ epostadresse: b.kontakt.epost?.trim() || null, mobiltelefonummer: mobilnummer(b.kontakt.telefon) }).filter(([, v]) => v),
  );
  return {
    inntektsaar: String(b.aar),
    bestillingstype: b.fnr ? "HENT_ALLE_OPPGITTE" : "HENT_KUN_ENDRING",
    ...(Object.keys(kontakt).length ? { kontaktinformasjon: kontakt } : {}),
    varslingstype: "VARSEL_VED_FOERSTE_ENDRING",
    forespoerselOmSkattekortTilArbeidsgiver: {
      arbeidsgiver: [{ arbeidsgiveridentifikator: { organisasjonsnummer: b.orgnr }, ...(b.fnr ? { arbeidstakeridentifikator: b.fnr } : {}) }],
    },
  };
}

async function bestill(token: string, b: Bestilling): Promise<string> {
  const r = await etatKall(`${adresser().skattekort}/bestillSkattekort`, token, { metode: "POST", kropp: bestillingskropp(b), hvem: "Skatteetaten" });
  if (r.status >= 300) throw skattFeil(r, "Bestillingen av skattekort feilet");
  const ref = finnReferanse(r);
  if (!ref) throw new EtatFeil("Skatteetaten ga ingen referanse til bestillingen", 502);
  return ref;
}

// Svaret på bestillingen, eller null når det ikke er klart ennå.
async function hentSvar(token: string, ref: string): Promise<any | null> {
  const r = await etatKall(`${adresser().skattekort}/skattekortTilArbeidsgiver/svar/${encodeURIComponent(ref)}`, token, { hvem: "Skatteetaten" });
  if (r.status === 204 || (r.status === 200 && !r.tekst.trim())) return null;
  if (r.status >= 300) throw skattFeil(r, "Henting av skattekortene feilet");
  return r.data ?? {};
}

export const PAUSE = { ms: 2500, maks: 120_000 }; // mellom hver gang svaret hentes, og hvor lenge (endres i tester)
const vent = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

async function ventPaSvar(token: string, ref: string): Promise<any | null> {
  const slutt = Date.now() + PAUSE.maks;
  for (;;) {
    await vent(PAUSE.ms);
    const svar = await hentSvar(token, ref);
    if (svar) return svar;
    if (Date.now() + PAUSE.ms > slutt) return null;
  }
}

// --- Tilgangen i Altinn -----------------------------------------------------------------------

type Tilgangsrad = {
  status: string;
  foresporsel_id: string | null;
  godkjenn_url: string | null;
  orgnr: string | null;
  epost: string | null;
  telefon: string | null;
  pakker: string[];
  endring_status: string | null;
  endring_id: string | null;
  endring_pakker: string[] | null;
};

export const hentTilgang = (orgId: string) =>
  somSystem((db) =>
    en<Tilgangsrad>(
      db,
      `select t.status, t.foresporsel_id, t.godkjenn_url, o.orgnr, o.epost, o.telefon, t.pakker, t.endring_status, t.endring_id, t.endring_pakker
         from faktura.skattekort_tilgang t join faktura.organisasjoner o on o.id = t.org_id
        where t.org_id = $1`,
      [orgId],
    ),
  );

// Systembrukeren har tilgangspakken (godkjent i Altinn).
export const harPakke = (t: Tilgangsrad | null | undefined, pakke: string) => t?.status === "godkjent" && t.pakker.includes(pakke);

// Oppdaterer tilgangen (kolonnenavnene kommer fra koden). Bare når statusen er den forventede, så
// en tilgang som er koblet fra eller bedt om på nytt i mellomtiden, ikke overskrives.
async function oppdaterTilgang(orgId: string, fra: string[], felt: Record<string, unknown>): Promise<boolean> {
  const k = Object.keys(felt);
  const r = await somSystem((db) =>
    db.query(`update faktura.skattekort_tilgang set ${k.map((x, i) => `${x} = $${i + 3}`).join(", ")} where org_id = $1 and status = any($2::text[])`, [
      orgId,
      fra,
      ...k.map((x) => felt[x]),
    ]),
  );
  return Boolean(r.rowCount);
}

// Feilmeldingen som lagres og vises (et fødselsnummer i den fra Skatteetaten skjules).
export const melding = (e: unknown) =>
  (e instanceof Error ? e.message : String(e)).replace(/\b\d{11}\b/g, "•••••••••••").slice(0, 500);
// Feil som ikke går over av seg selv (avvist, ugyldig, ikke satt opp): oppgaven prøves ikke igjen.
const varig = (e: unknown) => e instanceof EtatFeil && ((e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429) || e.status === 503);

// Lager forespørselen i Altinn etter at appen har bedt om tilgang. Har organisasjonen godkjent
// systemet fra før, hentes skattekortene med en gang.
export async function lagTilgang(orgId: string) {
  const t = await hentTilgang(orgId);
  if (!t || t.status !== "venter" || !t.orgnr) return;
  const naa = new Date().toISOString();
  try {
    const f = await lagForesporsel(t.orgnr);
    const ok = await oppdaterTilgang(orgId, ["venter"], {
      status: f.status,
      foresporsel_id: f.id,
      godkjenn_url: f.godkjennUrl,
      sjekket: naa,
      siste_feil: null,
      pakker: tilgangspakker(),
    });
    if (ok && f.status === "godkjent") await leggIKo({ type: "skattekort-hent", org_id: orgId, kilde: "godkjent" });
  } catch (e) {
    logg("WARNING", "Forespørselen om tilgang i Altinn feilet", { org_id: orgId, feil: melding(e) });
    await oppdaterTilgang(orgId, ["venter"], { status: "feil", sjekket: naa, siste_feil: melding(e) });
  }
}

// Sjekker om forespørselen er godkjent (eller avslått) i Altinn. Når den er godkjent, hentes
// skattekortene til alle de ansatte.
export async function sjekkTilgang(orgId: string) {
  const t = await hentTilgang(orgId);
  if (!t || !t.orgnr) return;
  if (t.status === "venter") return lagTilgang(orgId);
  if (t.status !== "ny") return;
  const naa = new Date().toISOString();
  try {
    // Uten id (forespørselen ble laget før): Altinn slår den opp etter organisasjonsnummeret.
    const f = t.foresporsel_id ? await hentForesporsel(t.foresporsel_id) : await lagForesporsel(t.orgnr);
    if (!f) {
      await oppdaterTilgang(orgId, ["ny"], { status: "utlopt", sjekket: naa, siste_feil: "Forespørselen finnes ikke lenger i Altinn. Be om tilgang på nytt." });
      return;
    }
    const ok = await oppdaterTilgang(orgId, ["ny"], {
      status: f.status,
      foresporsel_id: f.id ?? t.foresporsel_id,
      godkjenn_url: f.godkjennUrl ?? t.godkjenn_url,
      sjekket: naa,
      siste_feil: null,
    });
    if (ok && f.status === "godkjent") await leggIKo({ type: "skattekort-hent", org_id: orgId, kilde: "godkjent" });
  } catch (e) {
    logg("WARNING", "Sjekk av tilgangen i Altinn feilet", { org_id: orgId, feil: melding(e) });
    await oppdaterTilgang(orgId, ["ny"], { sjekket: naa, siste_feil: melding(e) });
  }
}

// --- Endringen av tilgangen (flere tilgangspakker) ---------------------------------------------

// Lager endringsforespørselen i Altinn for tilgangspakkene systemet trenger nå og systembrukeren
// ikke har (appen har bedt om det), eller sjekker den som venter på godkjenning.
export async function endreTilgang(orgId: string) {
  const t = await hentTilgang(orgId);
  if (!t || t.status !== "godkjent" || !t.orgnr || !t.endring_status) return;
  const felt = async (x: Record<string, unknown>) =>
    somSystem((db) => {
      const k = Object.keys(x);
      return db.query(`update faktura.skattekort_tilgang set ${k.map((y, i) => `${y} = $${i + 2}`).join(", ")} where org_id = $1`, [orgId, ...k.map((y) => x[y])]);
    });
  try {
    if (t.endring_status === "venter") {
      const mangler = tilgangspakker().filter((p) => !t.pakker.includes(p));
      if (!mangler.length) return void (await felt({ endring_status: "godkjent", endring_feil: null }));
      const f = await lagEndringsforesporsel(t.orgnr, mangler);
      await felt({ endring_status: f.status, endring_id: f.id, endring_url: f.godkjennUrl, endring_pakker: mangler, endring_feil: null });
      if (f.status === "godkjent") await felt({ pakker: [...new Set([...t.pakker, ...mangler])] });
      return;
    }
    if (t.endring_status !== "ny" || !t.endring_id) return;
    const f = await hentEndringsforesporsel(t.endring_id);
    if (!f) return void (await felt({ endring_status: "utlopt", endring_feil: "Endringsforespørselen finnes ikke lenger i Altinn. Be om det på nytt." }));
    await felt({ endring_status: f.status, endring_url: f.godkjennUrl, endring_feil: null });
    if (f.status === "godkjent") await felt({ pakker: [...new Set([...t.pakker, ...(t.endring_pakker ?? [])])] });
  } catch (e) {
    logg("WARNING", "Endringen av tilgangen i Altinn feilet", { org_id: orgId, feil: melding(e) });
    await felt({ endring_status: t.endring_status === "venter" ? "feil" : t.endring_status, endring_feil: melding(e) });
  }
}

// Hvert minutt: forespørsler som venter på godkjenning i Altinn, sjekkes hvert andre minutt den
// første timen og deretter hver halvtime (en forespørsel utløper etter en tid). En forespørsel
// workeren ikke har fått laget (status venter), prøves igjen etter ti minutter. Det samme gjelder
// endringsforespørslene (flere tilgangspakker).
export async function planleggTilgangssjekk(): Promise<number> {
  const rader = await somSystem((db) =>
    alle<{ org_id: string }>(
      db,
      `update faktura.skattekort_tilgang set sjekket = now()
        where (status = 'ny' and (sjekket is null or sjekket < now() - case when opprettet > now() - interval '1 hour' then interval '2 minutes' else interval '30 minutes' end))
           or (status = 'venter' and coalesce(sjekket, oppdatert) < now() - interval '10 minutes')
       returning org_id`,
    ),
  );
  for (const r of rader) await leggIKo({ type: "skattekort-status", org_id: r.org_id });
  const endringer = await somSystem((db) =>
    alle<{ org_id: string }>(
      db,
      `update faktura.skattekort_tilgang set sjekket = now()
        where status = 'godkjent' and endring_status in ('venter', 'ny')
          and (sjekket is null or sjekket < now() - case when endring_status = 'venter' then interval '10 minutes' else interval '2 minutes' end)
       returning org_id`,
    ),
  );
  for (const r of endringer) await leggIKo({ type: "altinn-endring", org_id: r.org_id });
  return rader.length + endringer.length;
}

// --- Hentingen ----------------------------------------------------------------------------------

export type Hentekilde = "godkjent" | "manuell" | "automatisk" | "ansatt";
export type Henteresultat = { bestilt: number; svar: number; oppdatert: number; venter: number };

const osloAar = () => Number(new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Oslo", year: "numeric" }).format(new Date()));

type Ansattrad = { id: string; fnr_kryptert: Buffer; biarbeidsgiver: boolean; skattekort_aar: number | null; hentes: boolean };

// De ansatte med fødselsnummer (ikke rollehavere som ikke er ansatt) og hvem av dem som skal
// hentes: de valgte, alle de aktive, eller (daglig) de som ikke har skattekortet for året fra
// Skatteetaten eller ikke er hentet på en uke.
async function ansatte(orgId: string, aar: number, valg: { ansattIder?: string[]; daglig?: boolean }) {
  const rader = await somSystem((db) =>
    alle<Ansattrad>(
      db,
      `select id, fnr_kryptert, biarbeidsgiver, skattekort_aar,
              case when $2::uuid[] is not null then id = any($2::uuid[])
                   when not $3 then aktiv
                   else aktiv and (skattekort_hentet is null or skattekort_kilde is distinct from 'skatteetaten'
                                   or skattekort_aar is distinct from $4 or skattekort_hentet < now() - interval '7 days') end as hentes
         from faktura.ansatte
        where org_id = $1 and fnr_kryptert is not null and arbeidstaker`,
      [orgId, valg.ansattIder ?? null, Boolean(valg.daglig), aar],
    ),
  );
  // Fødselsnumrene dekrypteres (Cloud KMS) noen om gangen.
  const fnr = new Map<string, Ansattrad[]>();
  for (let i = 0; i < rader.length; i += 8)
    await Promise.all(
      rader.slice(i, i + 8).map(async (a) => {
        const nr = await dekrypter(a.fnr_kryptert);
        fnr.set(nr, [...(fnr.get(nr) ?? []), a]);
      }),
    );
  return { fnr, hentes: [...fnr].filter(([, l]) => l.some((a) => a.hentes)).map(([nr]) => nr) };
}

// Lagrer skattekortene i svaret på de ansatte med fødselsnummeret. Et skattekort for et år før
// det den ansatte har, lagres ikke (f.eks. endringer i fjorårets skattekort i januar).
async function lagreSvar(orgId: string, svar: Skattekortsvar[], fnr: Map<string, Ansattrad[]>, aar: number): Promise<number> {
  let oppdatert = 0;
  const naa = new Date().toISOString();
  for (const s of svar) {
    for (const a of fnr.get(s.fnr) ?? []) {
      const sAar = s.aar ?? aar;
      if (a.skattekort_aar != null && a.skattekort_aar > sAar) continue;
      const kort = kortFraSvar(s, a.biarbeidsgiver);
      const felt: Record<string, unknown> = {
        skattekort_hentet: naa,
        skattekort_resultat: s.resultat || null,
        skattekort_utstedt: s.utstedt,
        skattekort_tillegg: s.tillegg,
        skattekort_trekk: s.trekk ? JSON.stringify(s.trekk) : null,
        ...(kort ? { ...kort, skattekort_aar: sAar, skattekort_kilde: "skatteetaten" } : {}),
      };
      const k = Object.keys(felt);
      await somSystem((db) =>
        db.query(`update faktura.ansatte set ${k.map((x, i) => `${x} = $${i + 3}`).join(", ")} where org_id = $1 and id = $2`, [orgId, a.id, ...k.map((x) => felt[x])]),
      );
      oppdatert++;
    }
  }
  return oppdatert;
}

// Bestiller og henter skattekortene for organisasjonen. daglig: endringene siden sist og de som
// mangler skattekortet for året; ellers alle de ansatte (eller de valgte). Gir null når
// tilgangen ikke er godkjent.
export async function hentSkattekort(
  orgId: string,
  valg: { ansattIder?: string[]; daglig?: boolean; aar?: number; kilde?: Hentekilde } = {},
): Promise<Henteresultat | null> {
  const t = await hentTilgang(orgId);
  if (!t || t.status !== "godkjent" || !t.orgnr) return null;
  const aar = valg.aar ?? osloAar();
  const resultat: Henteresultat = { bestilt: 0, svar: 0, oppdatert: 0, venter: 0 };
  try {
    const token = await hentToken(SCOPE.skattekort, t.orgnr);
    const { fnr, hentes } = await ansatte(orgId, aar, valg);
    const kontakt = { epost: t.epost, telefon: t.telefon };
    const bestillinger: Bestilling[] = [];
    // Endringene gjelder de ansatte som er hentet før (uten ansatte med fødselsnummer: ingenting å hente).
    if (valg.daglig && fnr.size) bestillinger.push({ aar, orgnr: t.orgnr, kontakt });
    for (let i = 0; i < hentes.length; i += 1000) bestillinger.push({ aar, orgnr: t.orgnr, kontakt, fnr: hentes.slice(i, i + 1000) });
    for (const b of bestillinger) {
      const ref = await bestill(token, b);
      resultat.bestilt += b.fnr?.length ?? 0;
      const data = await ventPaSvar(token, ref);
      if (!data) {
        // Svaret tar tid: hentes i en egen oppgave om et minutt.
        await leggIKo({ type: "skattekort-svar", org_id: orgId, referanse: ref, aar, forsok: 1 }, 60);
        resultat.venter++;
        continue;
      }
      const svar = tolkSvar(data);
      resultat.svar += svar.length;
      resultat.oppdatert += await lagreSvar(orgId, svar, fnr, aar);
    }
    await oppdaterTilgang(orgId, ["godkjent"], { sist_hentet: new Date().toISOString(), siste_feil: null });
    logg("INFO", "Skattekort hentet", { org_id: orgId, kilde: valg.kilde ?? null, ...resultat });
    return resultat;
  } catch (e) {
    logg("WARNING", "Henting av skattekort feilet", { org_id: orgId, feil: melding(e) });
    // Uten systembruker i Altinn (MP-303): tilgangen må bes om og godkjennes på nytt.
    if (e instanceof EtatFeil && e.kode === "MP-303") await oppdaterTilgang(orgId, ["godkjent"], { status: "feil", siste_feil: melding(e) });
    else await oppdaterTilgang(orgId, ["godkjent"], { siste_feil: melding(e) });
    if (varig(e)) return null;
    throw e;
  }
}

// Svaret på en bestilling som ikke var klart da den ble gjort. Prøves igjen hvert minutt i en
// halvtime.
export async function hentSkattekortSvar(orgId: string, referanse: string, aar: number, forsok: number) {
  const t = await hentTilgang(orgId);
  if (!t || t.status !== "godkjent" || !t.orgnr) return;
  try {
    const token = await hentToken(SCOPE.skattekort, t.orgnr);
    const data = await hentSvar(token, referanse);
    if (!data) {
      if (forsok < 30) await leggIKo({ type: "skattekort-svar", org_id: orgId, referanse, aar, forsok: forsok + 1 }, 60);
      else await oppdaterTilgang(orgId, ["godkjent"], { siste_feil: "Skatteetaten svarte ikke på bestillingen av skattekort. Prøv igjen senere." });
      return;
    }
    const { fnr } = await ansatte(orgId, aar, { ansattIder: [] });
    const oppdatert = await lagreSvar(orgId, tolkSvar(data), fnr, aar);
    await oppdaterTilgang(orgId, ["godkjent"], { sist_hentet: new Date().toISOString(), siste_feil: null });
    logg("INFO", "Skattekort hentet (svar som ventet)", { org_id: orgId, referanse, oppdatert });
  } catch (e) {
    await oppdaterTilgang(orgId, ["godkjent"], { siste_feil: melding(e) });
    if (!varig(e)) throw e;
  }
}

// Registrerer systemet i Altinns systemregister (eller oppdaterer det: navnet, klient-ID-en og
// adressen tilbake til appen), og lagrer hvordan det gikk.
export async function registrerAltinnSystem(): Promise<{ ok: boolean; resultat?: "ny" | "oppdatert"; feil?: string }> {
  const id = systemId();
  try {
    const resultat = await registrerSystem();
    await somSystem((db) =>
      db.query(
        `insert into faktura.altinn_system (id, registrert, oppdatert, siste_feil) values ($1, now(), now(), null)
         on conflict (id) do update set registrert = now(), oppdatert = now(), siste_feil = null`,
        [id],
      ),
    );
    logg("INFO", "Systemet er registrert i Altinn", { system_id: id, resultat });
    return { ok: true, resultat };
  } catch (e) {
    logg("WARNING", "Registreringen i Altinn feilet", { system_id: id, feil: melding(e) });
    await somSystem((db) =>
      db.query(
        `insert into faktura.altinn_system (id, oppdatert, siste_feil) values ($1, now(), $2)
         on conflict (id) do update set oppdatert = now(), siste_feil = excluded.siste_feil`,
        [id, melding(e)],
      ),
    );
    if (!varig(e)) throw e;
    return { ok: false, feil: melding(e) };
  }
}

// Daglig: endringene for organisasjonene med godkjent tilgang (og lønn slått på).
export async function planleggDagligSkattekort(): Promise<number> {
  const rader = await somSystem((db) =>
    alle<{ org_id: string }>(db, "select org_id from faktura.skattekort_tilgang where status = 'godkjent' and faktura.har_funksjon(org_id, 'lonn')"),
  );
  for (const r of rader) await leggIKo({ type: "skattekort-hent", org_id: r.org_id, daglig: true, kilde: "automatisk" });
  return rader.length;
}
