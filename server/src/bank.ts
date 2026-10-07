// Innbetalinger fra organisasjonens bankkontoer (Enable Banking): bare kontoene som er lagt
// inn i HI4 Faktura. Workeren henter nye transaksjoner på faste tider (HENTETIDER), lagrer
// innbetalingene og kobler dem til fakturaene:
//
//   KID, eller fakturanummeret i meldingen sammen med riktig beløp, riktig betaler eller
//   ordet «faktura»/«nr»: registreres som betaling med en gang.
//   Samme beløp og betaler (eller bare samme beløp på én faktura): forslag som brukeren
//   bekrefter.
//   Resten: AI-en (Gemini, se aiInnbetaling.ts) foreslår fakturaen når den er rimelig
//   sikker. Ellers uavklart, og brukeren velger faktura selv eller ignorerer den.
//
// Applikasjonen hos Enable Banking og den krypterte nøkkelen ligger i faktura.integrasjoner
// (type 'bank'); bare workeren kan dekryptere nøkkelen. Hver bank (DNB, Storebrand …) har
// sin egen kobling i faktura.bankkoblinger med egen BankID-innlogging, økt og kontoer.
import { randomBytes } from "node:crypto";
import { config } from "./config.js";
import { alle, en, somSystem, type Db } from "./db.js";
import { dekrypter } from "./kryptering.js";
import {
  BankFeil,
  gyldigTil,
  hentBanker,
  hentTransaksjoner,
  kontonr,
  opprettOkt,
  slettOkt,
  startAutorisering,
  tilInnbetalinger,
  velgBank,
  type BankNokkel,
  type Innbetaling,
  type Psu,
} from "./enableBanking.js";
import { sendVarsel } from "./push.js";
import { kr } from "./regler.js";
import { leggIKo } from "./tjenester.js";
import { aiPaa } from "./ai.js";
import { foreslaFaktura } from "./aiInnbetaling.js";

const logg = (severity: string, message: string, data: Record<string, unknown> = {}) => console.log(JSON.stringify({ severity, message, ...data }));

// En konto i banken. hent_fra: neste henting starter her. valgt: kontoen ble lest før appen
// begynte å lese kontoene som er lagt inn i HI4 Faktura (da gjaldt koblingens hent_fra).
export type BankKonto = { uid: string; kontonr: string; navn: string | null; hent_fra?: string; valgt?: boolean };
export type Bankkobling = {
  id: string;
  org_id: string;
  bank: string;
  land: string;
  psu_type: "business" | "personal";
  status: "venter" | "aktiv" | "feil";
  maks_sek: number | null;
  state: string | null;
  auth_url: string | null;
  auth_tid: string | null;
  auth_gyldig_til: string | null;
  okt_id: string | null;
  gyldig_til: string | null;
  fullfort: string | null;
  kontoer: BankKonto[];
  hent_fra: string | null;
  sist_hentet: string | null;
  varslet_utlop: string | null;
  siste_feil: string | null;
};
// Det som ligger i integrasjonens konfig (applikasjonen).
export type BankAppKonfig = { leverandor: "enablebanking"; app_id: string; app_navn?: string | null };

export const tilbakeUrl = () => `${config.appUrl}/bank/tilbake`;
export const nyState = (orgId: string) => `${orgId}.${randomBytes(18).toString("base64url")}`;

const iDag = (dager = 0) => {
  const d = new Date(Date.now() + dager * 86400_000);
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Oslo" }).format(d);
};
const somDato = (d: unknown) => (d instanceof Date ? d.toISOString() : d == null ? null : String(d));

// Når workeren henter av seg selv hver dag (norsk tid). Bankene tillater høyst fire hentinger
// i døgnet uten at brukeren er til stede (PSD2); «Hent nå» teller ikke med. Appen viser tidene.
export const HENTETIDER = ["06:00", "12:00", "18:00"];

// Dato (ÅÅÅÅ-MM-DD) og klokkeslett (TT:MM) i Oslo.
const osloFormat = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Oslo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const iOslo = (t: Date) => {
  const d = Object.fromEntries(osloFormat.formatToParts(t).map((x) => [x.type, x.value]));
  return { dato: `${d.year}-${d.month}-${d.day}`, klokke: `${d.hour}:${d.minute}` };
};
// Tidspunktet for et klokkeslett i Oslo den dagen (med sommertid).
const osloTidspunkt = (dato: string, klokke: string) => {
  const utc = Date.parse(`${dato}T${klokke}:00Z`);
  const vist = iOslo(new Date(utc));
  return new Date(utc - (Date.parse(`${vist.dato}T${vist.klokke}:00Z`) - utc));
};
// Den siste hentetiden som er passert i dag, eller null før dagens første.
export function sisteHentetid(naa = new Date()): Date | null {
  const { dato, klokke } = iOslo(naa);
  const passert = HENTETIDER.filter((t) => t <= klokke).at(-1);
  return passert ? osloTidspunkt(dato, passert) : null;
}
const senest = (a: string, b: string) => (a > b ? a : b); // datoer som ÅÅÅÅ-MM-DD

// Applikasjonen med nøkkelen dekryptert (bare workeren kan dekryptere).
export async function bankApp(db: Db, orgId: string): Promise<{ appId: string; nokkel: BankNokkel } | null> {
  const k = await en(db, "select status, konfig, hemmelighet_kryptert from faktura.integrasjoner where org_id = $1 and type = 'bank'", [orgId]);
  if (!k?.hemmelighet_kryptert || k.status === "frakoblet" || k.konfig?.leverandor !== "enablebanking" || !k.konfig.app_id) return null;
  return { appId: k.konfig.app_id, nokkel: { appId: k.konfig.app_id, privatNokkel: await dekrypter(k.hemmelighet_kryptert) } };
}

// Kontonumrene som er lagt inn i HI4 Faktura (organisasjonens kontonummer og Flere
// kontonumre), med navnet brukeren har gitt kontoen. Bare disse kontoene i bankene leses.
export async function egneKontoer(db: Db, orgId: string): Promise<Map<string, string | null>> {
  const rader = await alle<{ kontonr: string; navn: string | null }>(
    db,
    `select kontonr, null::text as navn from faktura.organisasjoner where id = $1 and kontonr is not null
     union all
     select kontonr, navn from faktura.kontoer where org_id = $1`,
    [orgId],
  );
  const egne = new Map<string, string | null>();
  for (const r of rader) if (!egne.get(r.kontonr)) egne.set(r.kontonr, r.navn);
  return egne;
}

// Hvor neste henting fra kontoen starter, eller null for de siste 60 dagene (en konto som
// ikke er lest før).
const hentesFra = (k: Bankkobling, x: BankKonto) => x.hent_fra ?? (x.valgt && k.hent_fra ? somDato(k.hent_fra)!.slice(0, 10) : null);

const hentKobling = (db: Db, orgId: string, id: string) =>
  en<Bankkobling>(db, "select * from faktura.bankkoblinger where id = $1 and org_id = $2", [id, orgId]);

// Oppdaterer koblingen (kolonnenavnene kommer fra koden, ikke fra brukeren).
async function oppdater(id: string, felt: Partial<Bankkobling>) {
  const kolonner = Object.keys(felt) as (keyof Bankkobling)[];
  if (!kolonner.length) return;
  const verdier = kolonner.map((k) => (k === "kontoer" ? JSON.stringify(felt[k]) : felt[k]));
  await somSystem((db) => db.query(`update faktura.bankkoblinger set ${kolonner.map((k, i) => `${k} = $${i + 2}`).join(", ")} where id = $1`, [id, ...verdier]));
}

// ---------------------------------------------------------------------------
// Kobling til banken
// ---------------------------------------------------------------------------

// Ny BankID-adresse for koblingen: for en ny bank (navnet sjekkes mot Enable Banking
// først), eller for å fornye samtykket. Appen venter på auth_url.
export async function lagBankAdresse(orgId: string, koblingId: string) {
  const [app, k] = await somSystem(async (db) => [await bankApp(db, orgId), await hentKobling(db, orgId, koblingId)] as const);
  if (!app || !k) return;
  const naa = new Date().toISOString();
  try {
    let bank = k.bank;
    let maks = k.maks_sek;
    if (maks == null) {
      const b = velgBank(await hentBanker(app.nokkel, k.land), k.bank, k.psu_type);
      bank = b.name;
      maks = b.maximum_consent_validity ?? null;
    }
    const state = nyState(orgId);
    const gyldig = gyldigTil(maks);
    const url = await startAutorisering(app.nokkel, { bank, land: k.land, psuType: k.psu_type, gyldigTil: gyldig, state, redirect: tilbakeUrl() });
    await oppdater(k.id, { bank, maks_sek: maks, state, auth_url: url, auth_tid: naa, auth_gyldig_til: gyldig.toISOString(), siste_feil: null });
  } catch (e) {
    // 23505: banken (med det nøyaktige navnet) er lagt til fra før.
    const melding = (e as { code?: string }).code === "23505" ? "Banken er allerede lagt til. Forny tilgangen på den i stedet." : (e as Error).message;
    await oppdater(k.id, { state: null, auth_url: null, auth_tid: naa, siste_feil: `Kunne ikke starte BankID: ${melding}` });
  }
}

// Koden fra banken (etter BankID) byttes mot en økt med lesetilgang til kontoene. Alle
// kontoene i økten lagres, men bare de som er lagt inn i HI4 Faktura leses (også de som
// legges inn senere). Hvor langt hver konto er hentet, følger kontonummeret fra forrige økt.
export async function fullforBankOkt(orgId: string, koblingId: string, kode: string) {
  const [app, k] = await somSystem(async (db) => [await bankApp(db, orgId), await hentKobling(db, orgId, koblingId)] as const);
  if (!app || !k) return;
  try {
    const okt = await opprettOkt(app.nokkel, kode);
    const tidligere = new Map((k.kontoer ?? []).map((x) => [x.kontonr, x]));
    const kontoer: BankKonto[] = okt.accounts.map((a) => {
      const nr = kontonr(a);
      const f = tidligere.get(nr);
      const fra = f ? hentesFra(k, f) : null;
      return { uid: a.uid, kontonr: nr, navn: a.name ?? a.product ?? a.details ?? null, ...(fra ? { hent_fra: fra } : {}) };
    });
    await oppdater(k.id, {
      status: "aktiv",
      okt_id: okt.session_id,
      gyldig_til: okt.access?.valid_until ?? somDato(k.auth_gyldig_til),
      fullfort: new Date().toISOString(),
      kontoer,
      state: null,
      auth_url: null,
      varslet_utlop: null,
      siste_feil: kontoer.length
        ? null
        : "Banken ga ikke tilgang til noen kontoer. Sjekk at kontoen er koblet til applikasjonen hos Enable Banking, og koble til på nytt.",
    });
    // Den gamle økten (ved fornyelse) trengs ikke lenger.
    if (k.okt_id && k.okt_id !== okt.session_id) await slettOkt(app.nokkel, k.okt_id).catch(() => undefined);
    if (kontoer.length) await leggIKo({ type: "bank-hent", org_id: orgId, kobling_id: k.id });
  } catch (e) {
    await oppdater(k.id, { state: null, auth_url: null, siste_feil: `Koblingen til banken ble ikke fullført: ${(e as Error).message}` });
  }
}

// Avslutter øktene hos Enable Banking (så godt det går). alt: hele bankkoblingen er
// koblet fra, og applikasjonen med nøkkelen slettes etterpå.
export async function slettBankOkter(orgId: string, oktIder: string[], alt = false) {
  const app = await somSystem((db) => bankAppUansett(db, orgId)).catch(() => null);
  for (const id of oktIder) {
    if (!app) break;
    try {
      await slettOkt(app.nokkel, id);
    } catch (e) {
      logg("WARNING", "Kunne ikke avslutte bankøkten", { org_id: orgId, feil: (e as Error).message });
    }
  }
  if (alt) await somSystem((db) => db.query("delete from faktura.integrasjoner where org_id = $1 and type = 'bank' and status = 'frakoblet'", [orgId]));
}

// Som bankApp, men også når koblingen er i ferd med å fjernes.
async function bankAppUansett(db: Db, orgId: string): Promise<{ nokkel: BankNokkel } | null> {
  const k = await en(db, "select konfig, hemmelighet_kryptert from faktura.integrasjoner where org_id = $1 and type = 'bank'", [orgId]);
  if (!k?.hemmelighet_kryptert || !k.konfig?.app_id) return null;
  return { nokkel: { appId: k.konfig.app_id, privatNokkel: await dekrypter(k.hemmelighet_kryptert) } };
}

// ---------------------------------------------------------------------------
// Kobling av innbetalinger til fakturaer
// ---------------------------------------------------------------------------

export type ApenFaktura = { id: string; fakturanummer: number; kid: string | null; kunde: string; utestaende: number; forfallsdato: string };
export type Treff = { status: "koblet" | "forslag" | "uavklart"; faktura_id?: string; grunn: string | null };

const STOPPORD = new Set(["as", "asa", "ans", "da", "ba", "sa", "enk", "nuf", "ltd", "ab", "og"]);
function navneord(navn: string | null): Set<string> {
  const s = (navn ?? "").toLowerCase().replace(/æ/g, "ae").replace(/ø/g, "oe").replace(/å/g, "aa").normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  return new Set(s.split(/[^a-z0-9]+/).filter((o) => o.length > 1 && !STOPPORD.has(o)));
}

// Er betaleren kunden? Alle ordene i det korteste navnet finnes i det andre (rekkefølgen
// spiller ingen rolle: banker skriver ofte etternavnet først).
export function sammeNavn(a: string | null, b: string | null): boolean {
  const x = navneord(a);
  const y = navneord(b);
  if (!x.size || !y.size) return false;
  const [kort, lang] = x.size <= y.size ? [x, y] : [y, x];
  return [...kort].every((o) => lang.has(o));
}

// Tall i teksten, med om det står «faktura», «nr» e.l. rett foran.
function tallITekst(tekst: string): { tall: string; merket: boolean }[] {
  return [...tekst.matchAll(/(?<!\d)(\d{1,12})(?!\d)/g)].map((m) => ({
    tall: m[1].replace(/^0+(?=\d)/, ""),
    merket: /(faktura|fakt|fa|invoice|inv|nr|no|#)\.?\s*:?\s*$/i.test(tekst.slice(Math.max(0, m.index! - 12), m.index)),
  }));
}

const like = (a: number, b: number) => Math.abs(a - b) < 0.005;

export function finnFaktura(t: Innbetaling, apne: ApenFaktura[]): Treff {
  const tekst = [t.melding, t.referanse].filter(Boolean).join(" ");
  const kidRef = (t.referanse ?? "").replace(/\s/g, "");
  const tall = tallITekst(tekst);

  // KID: entydig, registreres når beløpet ikke er for høyt.
  const viaKid = apne.filter((f) => f.kid && (f.kid === kidRef || tall.some((x) => x.tall === f.kid)));
  if (viaKid.length === 1) {
    const f = viaKid[0];
    if (t.belop <= f.utestaende + 0.005) return { status: "koblet", faktura_id: f.id, grunn: `KID ${f.kid}${t.belop < f.utestaende - 0.005 ? " (delbetaling)" : ""}` };
    return { status: "forslag", faktura_id: f.id, grunn: `KID ${f.kid}, men beløpet er høyere enn det som gjenstår (${kr(f.utestaende)})` };
  }

  // Fakturanummer i meldingen.
  const viaNummer = apne.filter((f) => tall.some((x) => x.tall === String(f.fakturanummer)));
  if (viaNummer.length === 1) {
    const f = viaNummer[0];
    const merket = tall.some((x) => x.tall === String(f.fakturanummer) && x.merket);
    const grunn = `Fakturanummer ${f.fakturanummer} i meldingen`;
    if (t.belop > f.utestaende + 0.005) return { status: "forslag", faktura_id: f.id, grunn: `${grunn}, men beløpet er høyere enn det som gjenstår (${kr(f.utestaende)})` };
    // Et tall i meldingen kan være noe annet (et årstall, en leilighet): da må også beløpet
    // eller betaleren stemme, eller det må stå «faktura»/«nr» foran.
    if (like(t.belop, f.utestaende) || sammeNavn(t.betaler, f.kunde) || merket)
      return { status: "koblet", faktura_id: f.id, grunn: t.belop < f.utestaende - 0.005 ? `${grunn} (delbetaling)` : grunn };
    return { status: "forslag", faktura_id: f.id, grunn: `${grunn}, men beløpet er ${kr(t.belop)} av ${kr(f.utestaende)}` };
  }
  if (viaNummer.length > 1) {
    return { status: "uavklart", grunn: `Kan gjelde fakturaene ${viaNummer.map((f) => f.fakturanummer).join(", ")}` };
  }

  // Samme beløp og betaler (den eldste ubetalte), eller bare samme beløp på én faktura.
  const sammeBelop = apne.filter((f) => like(f.utestaende, t.belop));
  const sammeBetaler = sammeBelop.filter((f) => sammeNavn(t.betaler, f.kunde));
  const kandidater = sammeBetaler.length ? sammeBetaler : sammeBelop.length === 1 ? sammeBelop : [];
  if (kandidater.length) {
    const eldste = [...kandidater].sort((a, b) => (a.forfallsdato ?? "").localeCompare(b.forfallsdato ?? "") || a.fakturanummer - b.fakturanummer)[0];
    const grunn = sammeBetaler.length
      ? `Samme beløp og betaler${kandidater.length > 1 ? ` (den eldste av ${kandidater.length} ubetalte)` : ""}`
      : "Samme beløp";
    return { status: "forslag", faktura_id: eldste.id, grunn };
  }
  return { status: "uavklart", grunn: null };
}

export const apneFakturaer = (db: Db, orgId: string) =>
  alle<ApenFaktura>(
    db,
    `select f.id, f.fakturanummer, f.kid, coalesce(f.kunde ->> 'navn', k.navn) as kunde, f.forfallsdato,
            f.sum_inkl_mva - f.kreditert_belop - f.betalt_belop as utestaende
       from faktura.fakturaer f join faktura.kunder k on k.id = f.kunde_id
      where f.org_id = $1 and f.type = 'faktura' and f.status = 'utstedt'
        and f.sum_inkl_mva - f.kreditert_belop - f.betalt_belop > 0`,
    [orgId],
  );

// ---------------------------------------------------------------------------
// Henting
// ---------------------------------------------------------------------------

// Samtykket er gått ut eller trukket tilbake (eller nøkkelen virker ikke lenger): brukeren
// må koble til på nytt. Andre feil (banken svarer ikke o.l.) prøves igjen neste gang.
const utloptFeil = (f: BankFeil) =>
  f.status === 401 || f.status === 403 || /(EXPIRED|REVOKED|CLOSED|INVALID)_?SESSION|SESSION_?(EXPIRED|REVOKED|CLOSED|INVALID)|CONSENT/i.test(f.kode ?? "");

type Resultat = { nye: number; koblet: number; forslag: number };
// Hvor mange innbetalinger AI-en kan se på i én henting (tak på kostnaden, og den første
// hentingen kan ha mange). feil: feil på rad; etter to prøves det ikke mer denne gangen.
type AiBudsjett = { igjen: number; feil: number };
const AI_PER_HENTING = 20;

// Lagrer innbetalingen (én gang) og kobler den til en faktura om det går.
async function lagreOgKoble(orgId: string, kontonummer: string, t: Innbetaling, r: Resultat, ai: AiBudsjett) {
  const ny = await somSystem((db) =>
    en<{ id: string }>(
      db,
      `insert into faktura.banktransaksjoner (org_id, konto, ekstern_id, dato, belop, valuta, betaler, betaler_konto, melding, referanse)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       on conflict (org_id, konto, ekstern_id) do nothing returning id`,
      [orgId, kontonummer, t.ekstern_id, t.dato, t.belop, t.valuta, t.betaler, t.betaler_konto, t.melding, t.referanse],
    ),
  );
  if (!ny) return;
  r.nye++;
  if (t.valuta !== "NOK") return;
  let treff = finnFaktura(t, await somSystem((db) => apneFakturaer(db, orgId)));
  if (treff.status === "koblet") {
    try {
      await somSystem((db) => db.query("select faktura.koble_banktransaksjon($1, $2, $3)", [ny.id, treff.faktura_id, treff.grunn]));
      r.koblet++;
      return;
    } catch (e) {
      logg("WARNING", "Kunne ikke registrere innbetalingen automatisk", { org_id: orgId, id: ny.id, feil: (e as Error).message });
      treff.status = "forslag";
    }
  }
  if (treff.status === "uavklart" && ai.igjen > 0) treff = await medAi(orgId, ny.id, t, treff, ai);
  if (treff.status === "forslag") r.forslag++;
  await somSystem((db) =>
    db.query("update faktura.banktransaksjoner set status = $2, faktura_id = $3, grunn = $4 where id = $1", [
      ny.id,
      treff.status,
      treff.status === "forslag" ? treff.faktura_id : null,
      treff.grunn,
    ]),
  );
}

// Reglene fant ingen faktura: et forslag fra AI-en når den er rimelig sikker (alltid
// bare et forslag som brukeren bekrefter). Går det galt, blir innbetalingen uavklart.
async function medAi(orgId: string, id: string, t: Innbetaling, treff: Treff, ai: AiBudsjett): Promise<Treff> {
  ai.igjen--;
  try {
    const f = await foreslaFaktura(somSystem, orgId, { id, ...t });
    ai.feil = 0;
    if (f.faktura && f.sikkerhet !== "lav") return { status: "forslag", faktura_id: f.faktura.id, grunn: `AI: ${f.grunn}` };
  } catch (e) {
    // Kvoten for måneden er brukt opp: ikke flere forsøk denne gangen.
    if ((e as { status?: number }).status === 429 || ++ai.feil >= 2) ai.igjen = 0;
    logg("WARNING", "AI-forslaget for innbetalingen feilet", { org_id: orgId, id, feil: (e as Error).message });
  }
  return treff;
}

// Neste henting fra kontoene starter her, uten å røre resten av koblingen: en fornyelse
// kan ha byttet ut kontoene i mellomtiden.
const merkHentet = (id: string, kontonr: string[], fra: string) =>
  somSystem((db) =>
    db.query(
      `update faktura.bankkoblinger
          set kontoer = (select coalesce(jsonb_agg(case when x ->> 'kontonr' = any($2::text[]) then x || jsonb_build_object('hent_fra', $3::text) else x end
                                                   order by n), '[]')
                           from jsonb_array_elements(kontoer) with ordinality as e(x, n)),
              sist_hentet = now(), siste_feil = null
        where id = $1`,
      [id, kontonr, fra],
    ),
  );

// Henter nye innbetalinger fra kontoene som er lagt inn i HI4 Faktura, i én eller alle
// bankene, og kobler dem til fakturaene.
export async function hentInnbetalinger(orgId: string, valg: { koblingId?: string; psu?: Psu } = {}): Promise<Resultat> {
  const resultat: Resultat = { nye: 0, koblet: 0, forslag: 0 };
  const [app, koblinger, egne, start, aiAktiv] = await somSystem(
    async (db) =>
      [
        await bankApp(db, orgId),
        await alle<Bankkobling>(
          db,
          "select * from faktura.bankkoblinger where org_id = $1 and status = 'aktiv' and okt_id is not null and ($2::uuid is null or id = $2) order by opprettet",
          [orgId, valg.koblingId ?? null],
        ),
        await egneKontoer(db, orgId),
        (await en<{ fra: string | null }>(db, "select faktura.bank_fra($1)::text as fra", [orgId]))?.fra ?? null,
        Boolean((await en<{ ai_aktiv: boolean }>(db, "select ai_aktiv from faktura.organisasjoner where id = $1", [orgId]))?.ai_aktiv),
      ] as const,
  );
  if (!app) return resultat;
  const ai: AiBudsjett = { igjen: aiPaa() && aiAktiv ? AI_PER_HENTING : 0, feil: 0 };
  // Innbetalinger fra før startdatoen (som standard dagen organisasjonen begynte med HI4
  // Faktura) hentes ikke, og de som er hentet fra før, ryddes bort.
  const startdato = start ?? iDag(-60);
  try {
    await somSystem((db) => db.query("select faktura.rydd_banktransaksjoner($1)", [orgId]));
  } catch (e) {
    logg("ERROR", "Kunne ikke rydde gamle innbetalinger", { org_id: orgId, feil: (e as Error).message });
  }

  for (const k of koblinger) {
    const kontoer = (k.kontoer ?? []).filter((x) => egne.has(x.kontonr));
    if (!kontoer.length) continue;
    try {
      for (const konto of kontoer) {
        const fra = senest(hentesFra(k, konto) ?? iDag(-60), startdato);
        for (const t of tilInnbetalinger(await hentTransaksjoner(app.nokkel, konto.uid, fra, valg.psu)))
          if (t.dato >= startdato) await lagreOgKoble(orgId, konto.kontonr, t, resultat, ai);
      }
      // Neste gang hentes de siste dagene på nytt: banker kan bokføre noen dager etter.
      await merkHentet(k.id, kontoer.map((x) => x.kontonr), iDag(-5));
    } catch (e) {
      const f = e instanceof BankFeil ? e : new BankFeil((e as Error).message, 500);
      const utlopt = utloptFeil(f);
      logg(utlopt ? "WARNING" : "ERROR", "Henting fra banken feilet", { org_id: orgId, bank: k.bank, status: f.status, feil: f.message });
      await oppdater(
        k.id,
        utlopt
          ? { sist_hentet: new Date().toISOString(), status: "feil", siste_feil: "Tilgangen til banken har gått ut eller er trukket tilbake. Koble til banken på nytt." }
          : { sist_hentet: new Date().toISOString(), siste_feil: f.message },
      );
      if (utlopt)
        await varsle(orgId, `Koble til ${k.bank} på nytt`, `Appen får ikke lenger lese innbetalingene fra ${k.bank}. Forny tilgangen med BankID.`, "/innstillinger?fane=betaling");
    }
  }
  if (resultat.forslag > 0)
    await varsle(
      orgId,
      resultat.forslag === 1 ? "En innbetaling må bekreftes" : `${resultat.forslag} innbetalinger må bekreftes`,
      "Appen har funnet fakturaen som trolig er betalt. Se over og bekreft.",
      "/innbetalinger",
    );
  return resultat;
}

async function varsle(orgId: string, tittel: string, tekst: string, url: string) {
  try {
    await sendVarsel({ hendelse: "bank", org_id: orgId, tittel, tekst, url, tag: `bank-${orgId}` });
  } catch (e) {
    logg("WARNING", "Kunne ikke sende varsel", { org_id: orgId, feil: (e as Error).message });
  }
}

// Merker banken som hentet nå, om den ikke er hentet siden hentetiden. Gir false når en
// annen kjøring (eller «Hent nå») kom først.
const taHentetid = async (id: string, naa: Date, hentetid: Date) =>
  Boolean(
    await somSystem((db) =>
      en(
        db,
        "update faktura.bankkoblinger set sist_hentet = $2 where id = $1 and (sist_hentet is null or sist_hentet < $3) returning id",
        [id, naa.toISOString(), hentetid.toISOString()],
      ),
    ),
  );

// Planlegger henting for bankene som ikke er hentet siden siste hentetid. Kjøres hvert
// minutt; en hentetid som ble gått glipp av (f.eks. under en utrulling), tas igjen til neste.
// Varsler også (på dagtid) når samtykket til en bank snart går ut.
export async function planleggBankhenting(naa = new Date()): Promise<number> {
  const hentetid = sisteHentetid(naa);
  const timeOslo = Number(iOslo(naa).klokke.slice(0, 2));
  const dagtid = timeOslo >= 6 && timeOslo <= 21;
  if (!hentetid && !dagtid) return 0;
  const uke = new Date(naa.getTime() + 7 * 86400_000).toISOString();
  const rader = await somSystem((db) =>
    alle<Bankkobling & { skal_hentes: boolean }>(
      db,
      `select k.*,
              coalesce(k.sist_hentet < $1::timestamptz, $1 is not null)
              and exists (select 1 from jsonb_array_elements(k.kontoer) x
                           where x ->> 'kontonr' in (select o.kontonr from faktura.organisasjoner o where o.id = k.org_id
                                                     union select e.kontonr from faktura.kontoer e where e.org_id = k.org_id)) as skal_hentes
         from faktura.bankkoblinger k
         join faktura.integrasjoner i on i.org_id = k.org_id and i.type = 'bank' and i.status <> 'frakoblet'
        where k.status = 'aktiv' and k.okt_id is not null
          and ((k.sist_hentet is null or k.sist_hentet < $1::timestamptz)
               or ($2 and k.gyldig_til < $3::timestamptz and k.varslet_utlop is null))`,
      [hentetid?.toISOString() ?? null, dagtid, uke],
    ),
  );
  let antall = 0;
  for (const k of rader) {
    // Banker uten noen konto som er lagt inn i HI4 Faktura, har ingenting å hente. Bare én
    // kjøring får ta hentetiden (de andre ser at banken alt er merket som hentet).
    if (k.skal_hentes && (await taHentetid(k.id, naa, hentetid!))) {
      await leggIKo({ type: "bank-hent", org_id: k.org_id, kobling_id: k.id });
      antall++;
    }
    const utlop = k.gyldig_til ? Date.parse(somDato(k.gyldig_til)!) : NaN;
    if (dagtid && Number.isFinite(utlop) && utlop - naa.getTime() < 7 * 86400_000 && !k.varslet_utlop) {
      await oppdater(k.id, { varslet_utlop: naa.toISOString() });
      await varsle(
        k.org_id,
        `Tilgangen til ${k.bank} går snart ut`,
        `Appen kan lese innbetalingene til ${new Date(utlop).toLocaleDateString("nb-NO", { timeZone: "Europe/Oslo" })}. Forny med BankID under Innstillinger → Betaling.`,
        "/innstillinger?fane=betaling",
      );
    }
  }
  return antall;
}
