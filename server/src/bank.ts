// Innbetalinger fra organisasjonens bankkonto (Enable Banking). Workeren henter nye
// transaksjoner noen ganger om dagen, lagrer innbetalingene og kobler dem til fakturaene:
//
//   KID, eller fakturanummeret i meldingen sammen med riktig beløp, riktig betaler eller
//   ordet «faktura»/«nr»: registreres som betaling med en gang.
//   Samme beløp og betaler (eller bare samme beløp på én faktura): forslag som brukeren
//   bekrefter.
//   Resten: uavklart, og brukeren velger faktura selv eller ignorerer den.
//
// Den private nøkkelen til Enable Banking-applikasjonen er kryptert; bare workeren kan
// dekryptere den.
import { randomBytes } from "node:crypto";
import { config } from "./config.js";
import { alle, en, somSystem, type Db } from "./db.js";
import { dekrypter } from "./kryptering.js";
import {
  BankFeil,
  gyldigTil,
  hentTransaksjoner,
  kontonr,
  opprettOkt,
  slettOkt,
  startAutorisering,
  tilInnbetalinger,
  type BankNokkel,
  type Innbetaling,
  type Psu,
} from "./enableBanking.js";
import { sendVarsel } from "./push.js";
import { kr } from "./regler.js";
import { leggIKo } from "./tjenester.js";

const logg = (severity: string, message: string, data: Record<string, unknown> = {}) => console.log(JSON.stringify({ severity, message, ...data }));

export type BankKontoValg = { uid: string; kontonr: string; navn: string | null; valgt: boolean };
export type BankKonfig = {
  leverandor: "enablebanking";
  app_id: string;
  app_navn?: string | null;
  bank: string;
  land: string;
  psu_type: "business" | "personal";
  maks_sek?: number | null; // lengste samtykke banken tillater
  state?: string | null; // BankID-innloggingen som pågår
  auth_url?: string | null; // adressen til banken, laget av workeren (fornyelse)
  auth_tid?: string | null;
  auth_gyldig_til?: string | null;
  okt_id?: string | null;
  gyldig_til?: string | null;
  kontoer?: BankKontoValg[];
  hent_fra?: string | null; // neste henting starter fra denne datoen
  sist_hentet?: string | null;
  varslet_utlop?: string | null;
};

export const tilbakeUrl = () => `${config.appUrl}/bank/tilbake`;
export const nyState = (orgId: string) => `${orgId}.${randomBytes(18).toString("base64url")}`;

const iDag = (dager = 0) => {
  const d = new Date(Date.now() + dager * 86400_000);
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Oslo" }).format(d);
};

// Organisasjonens kobling med nøkkelen dekryptert (bare workeren kan dekryptere).
export async function bankKobling(db: Db, orgId: string): Promise<{ status: string; konfig: BankKonfig; nokkel: BankNokkel } | null> {
  const k = await en(db, "select status, konfig, hemmelighet_kryptert from faktura.integrasjoner where org_id = $1 and type = 'bank'", [orgId]);
  if (!k?.hemmelighet_kryptert || k.konfig?.leverandor !== "enablebanking" || !k.konfig.app_id) return null;
  return { status: k.status, konfig: k.konfig, nokkel: { appId: k.konfig.app_id, privatNokkel: await dekrypter(k.hemmelighet_kryptert) } };
}

// Oppdaterer konfig (flettes inn), og eventuelt status og siste feil.
async function lagre(orgId: string, endring: Partial<BankKonfig>, felt: { status?: string; siste_feil?: string | null } = {}) {
  await somSystem((db) =>
    db.query(
      `update faktura.integrasjoner
          set konfig = konfig || $2::jsonb, status = coalesce($3, status),
              siste_feil = case when $4 then $5 else siste_feil end
        where org_id = $1 and type = 'bank'`,
      [orgId, JSON.stringify(endring), felt.status ?? null, "siste_feil" in felt, felt.siste_feil ?? null],
    ),
  );
}

// ---------------------------------------------------------------------------
// Kobling til banken
// ---------------------------------------------------------------------------

// Ny adresse til banken (BankID) for å fornye samtykket. Appen venter på auth_url.
export async function lagBankAdresse(orgId: string) {
  const k = await somSystem((db) => bankKobling(db, orgId));
  if (!k || k.status === "frakoblet") return;
  const state = nyState(orgId);
  const gyldig = gyldigTil(k.konfig.maks_sek);
  try {
    const url = await startAutorisering(k.nokkel, { bank: k.konfig.bank, land: k.konfig.land, psuType: k.konfig.psu_type, gyldigTil: gyldig, state, redirect: tilbakeUrl() });
    await lagre(orgId, { state, auth_url: url, auth_tid: new Date().toISOString(), auth_gyldig_til: gyldig.toISOString() }, { siste_feil: null });
  } catch (e) {
    await lagre(orgId, { state: null, auth_url: null, auth_tid: new Date().toISOString() }, { siste_feil: `Kunne ikke starte BankID hos banken: ${(e as Error).message}` });
  }
}

// Koden fra banken (etter BankID) byttes mot en økt med lesetilgang til kontoene.
// Kontoene med organisasjonens kontonumre velges; finnes ingen av dem, velges alle.
export async function fullforBankOkt(orgId: string, kode: string) {
  const k = await somSystem((db) => bankKobling(db, orgId));
  if (!k || k.status === "frakoblet") return;
  try {
    const okt = await opprettOkt(k.nokkel, kode);
    const egne = await somSystem(async (db) => {
      const o = await en(db, "select kontonr from faktura.organisasjoner where id = $1", [orgId]);
      const ekstra = await alle<{ kontonr: string }>(db, "select kontonr from faktura.kontoer where org_id = $1", [orgId]);
      return new Set([o?.kontonr, ...ekstra.map((x) => x.kontonr)].filter(Boolean) as string[]);
    });
    const tidligere = new Map((k.konfig.kontoer ?? []).map((x) => [x.kontonr, x.valgt]));
    const kontoer: BankKontoValg[] = okt.accounts.map((a) => {
      const nr = kontonr(a);
      return { uid: a.uid, kontonr: nr, navn: a.name ?? a.product ?? a.details ?? null, valgt: tidligere.get(nr) ?? egne.has(nr) };
    });
    if (!kontoer.some((x) => x.valgt)) kontoer.forEach((x) => (x.valgt = true));
    await lagre(
      orgId,
      { okt_id: okt.session_id, gyldig_til: okt.access?.valid_until ?? k.konfig.auth_gyldig_til ?? null, kontoer, state: null, auth_url: null, varslet_utlop: null },
      { status: "aktiv", siste_feil: kontoer.length ? null : "Banken ga ikke tilgang til noen kontoer. Koble til på nytt og velg kontoen i banken." },
    );
    if (kontoer.length) await leggIKo({ type: "bank-hent", org_id: orgId });
  } catch (e) {
    await lagre(orgId, { state: null, auth_url: null }, { siste_feil: `Koblingen til banken ble ikke fullført: ${(e as Error).message}` });
  }
}

// Koble fra: økten avsluttes hos Enable Banking (så godt det går) og koblingen slettes.
export async function slettBankKobling(orgId: string) {
  const k = await somSystem((db) => bankKobling(db, orgId)).catch(() => null);
  if (k?.konfig.okt_id) {
    try {
      await slettOkt(k.nokkel, k.konfig.okt_id);
    } catch (e) {
      logg("WARNING", "Kunne ikke avslutte bankøkten", { org_id: orgId, feil: (e as Error).message });
    }
  }
  await somSystem((db) => db.query("delete from faktura.integrasjoner where org_id = $1 and type = 'bank' and status = 'frakoblet'", [orgId]));
}

// ---------------------------------------------------------------------------
// Kobling av innbetalinger til fakturaer
// ---------------------------------------------------------------------------

export type ApenFaktura = { id: string; fakturanummer: number; kid: string | null; kunde: string; utestaende: number; forfallsdato: string };
export type Treff = { status: "koblet" | "forslag" | "uavklart"; faktura_id?: string; grunn: string | null };

const STOPPORD = new Set(["as", "asa", "ans", "da", "ba", "sa", "enk", "nuf", "ltd", "ab", "og"]);
function navneord(navn: string | null): Set<string> {
  const s = (navn ?? "").toLowerCase().replace(/æ/g, "ae").replace(/ø/g, "oe").replace(/å/g, "aa").normalize("NFKD").replace(/[̀-ͯ]/g, "");
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

// Henter nye innbetalinger fra de valgte kontoene og kobler dem til fakturaene.
export async function hentInnbetalinger(orgId: string, psu?: Psu): Promise<{ nye: number; koblet: number; forslag: number }> {
  const resultat = { nye: 0, koblet: 0, forslag: 0 };
  const k = await somSystem((db) => bankKobling(db, orgId));
  if (!k || k.status !== "aktiv" || !k.konfig.okt_id) return resultat;
  const kontoer = (k.konfig.kontoer ?? []).filter((x) => x.valgt);
  const fra = k.konfig.hent_fra ?? iDag(-60);

  try {
    for (const konto of kontoer) {
      const innbetalinger = tilInnbetalinger(await hentTransaksjoner(k.nokkel, konto.uid, fra, psu));
      for (const t of innbetalinger) {
        const ny = await somSystem((db) =>
          en<{ id: string }>(
            db,
            `insert into faktura.banktransaksjoner (org_id, konto, ekstern_id, dato, belop, valuta, betaler, betaler_konto, melding, referanse)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
             on conflict (org_id, konto, ekstern_id) do nothing returning id`,
            [orgId, konto.kontonr, t.ekstern_id, t.dato, t.belop, t.valuta, t.betaler, t.betaler_konto, t.melding, t.referanse],
          ),
        );
        if (!ny) continue;
        resultat.nye++;
        if (t.valuta !== "NOK") continue;
        const treff = finnFaktura(t, await somSystem((db) => apneFakturaer(db, orgId)));
        if (treff.status === "koblet") {
          try {
            await somSystem((db) => db.query("select faktura.koble_banktransaksjon($1, $2, $3)", [ny.id, treff.faktura_id, treff.grunn]));
            resultat.koblet++;
            continue;
          } catch (e) {
            logg("WARNING", "Kunne ikke registrere innbetalingen automatisk", { org_id: orgId, id: ny.id, feil: (e as Error).message });
            treff.status = "forslag";
          }
        }
        if (treff.status === "forslag") resultat.forslag++;
        await somSystem((db) =>
          db.query("update faktura.banktransaksjoner set status = $2, faktura_id = $3, grunn = $4 where id = $1", [
            ny.id,
            treff.status,
            treff.status === "forslag" ? treff.faktura_id : null,
            treff.grunn,
          ]),
        );
      }
    }
    // Neste gang hentes de siste dagene på nytt: banker kan bokføre noen dager etter.
    await lagre(orgId, { hent_fra: iDag(-5) < fra ? fra : iDag(-5), sist_hentet: new Date().toISOString() }, { siste_feil: null });
  } catch (e) {
    const f = e instanceof BankFeil ? e : new BankFeil((e as Error).message, 500);
    const utlopt = utloptFeil(f);
    logg(utlopt ? "WARNING" : "ERROR", "Henting fra banken feilet", { org_id: orgId, status: f.status, feil: f.message });
    await lagre(
      orgId,
      { sist_hentet: new Date().toISOString() },
      utlopt ? { status: "feil", siste_feil: "Tilgangen til banken har gått ut eller er trukket tilbake. Koble til banken på nytt." } : { siste_feil: f.message },
    );
    if (utlopt) await varsle(orgId, "Koble til banken på nytt", "Appen får ikke lenger lese innbetalingene fra banken. Forny tilgangen med BankID.", "/innstillinger?fane=betaling");
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

// Planlegger henting for organisasjonene som ikke er hentet de siste timene. Kjøres jevnlig;
// med seks timer mellom blir det høyst fire hentinger i døgnet uten brukeren (PSD2).
// Varsler også når samtykket snart går ut.
export async function planleggBankhenting(naa = new Date()): Promise<number> {
  const timeOslo = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Oslo", hour: "2-digit", hourCycle: "h23" }).format(naa));
  if (timeOslo < 6 || timeOslo > 21) return 0;
  const rader = await somSystem((db) =>
    alle<{ org_id: string; konfig: BankKonfig }>(
      db,
      `select org_id, konfig from faktura.integrasjoner
        where type = 'bank' and status = 'aktiv' and konfig ->> 'okt_id' is not null`,
    ),
  );
  let antall = 0;
  for (const r of rader) {
    const sist = r.konfig.sist_hentet ? Date.parse(r.konfig.sist_hentet) : 0;
    if (naa.getTime() - sist >= 5 * 3600_000 + 50 * 60_000) {
      // Merkes med en gang, så neste kjøring ikke legger den i kø igjen.
      await lagre(r.org_id, { sist_hentet: naa.toISOString() });
      await leggIKo({ type: "bank-hent", org_id: r.org_id });
      antall++;
    }
    const utlop = r.konfig.gyldig_til ? Date.parse(r.konfig.gyldig_til) : NaN;
    if (Number.isFinite(utlop) && utlop - naa.getTime() < 7 * 86400_000 && !r.konfig.varslet_utlop) {
      await lagre(r.org_id, { varslet_utlop: naa.toISOString() });
      await varsle(
        r.org_id,
        "Tilgangen til banken går snart ut",
        `Appen kan lese innbetalingene til ${new Date(utlop).toLocaleDateString("nb-NO", { timeZone: "Europe/Oslo" })}. Forny med BankID under Innstillinger → Betaling.`,
        "/innstillinger?fane=betaling",
      );
    }
  }
  return antall;
}
