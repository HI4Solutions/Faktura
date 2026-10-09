// Lønnsberegningen (uten database, så den kan testes for seg): linjene på en lønnsslipp
// (fastlønn, timelønn, overtid og merarbeid, faste tillegg, sykepenger og omsorgspenger,
// feriepenger og ferietrekk), skattetrekket, feriepengene, OTP og arbeidsgiveravgiften.
// lonn.ts henter grunnlaget og lagrer resultatet.
//
// Satsene (2026): arbeidsgiveravgift per sone (1a: 10,6 % til fribeløpet på 850 000 kr i spart
// avgift er brukt, deretter 14,1 %), grunnbeløpet (G) fra 1. mai hvert år, OTP opp til 12 G,
// feriepenger 10,2 eller 12 % (og 2,3 % av inntil 6 G for den ekstra ferieuka det året den
// ansatte fyller 60), arbeidsgiverperioden for sykepenger (16 kalenderdager, etter fire ukers
// ansettelse) og omsorgspenger for sykt barn (10 dager i året). Nye satser legges inn her.

import { beregnUke, type Foring, type Regler, type Ukesum } from "./arbeidstid.js";
import { helligdag } from "./helligdager.js";
import { lonnsart } from "./lonnsarter.js";

// --- Satser -----------------------------------------------------------------------------------

export const GRUNNBELOP: [string, number][] = [
  ["2023-05-01", 118620],
  ["2024-05-01", 124028],
  ["2025-05-01", 130160],
  ["2026-05-01", 136549],
];
export const grunnbelop = (dato: string) => [...GRUNNBELOP].reverse().find(([fra]) => fra <= dato)?.[1] ?? GRUNNBELOP[0]![1];

export const AGA_SATS: Record<string, number> = { "1": 14.1, "1a": 10.6, "2": 10.6, "3": 6.4, "4": 5.1, "4a": 7.9, "5": 0 };
export const AGA_FULL = 14.1;
export const AGA_FRIBELOP = 850_000;
export const AGP_DAGER = 16; // arbeidsgiverperioden
export const OPPTJENING_DAGER = 28; // fire uker i arbeid før arbeidsgiveren betaler sykepenger
export const OMSORG_DAGER = 10; // omsorgsdager (sykt barn) arbeidsgiveren betaler i året
export const UTEN_SKATTEKORT = 50; // prosent trekk uten skattekort, og når frikortet er brukt opp
export const FERIE_60 = 2.3; // prosent ekstra feriepenger (inntil 6 G) det året den ansatte fyller 60
export const ARBEIDSDAGER_AAR = 260; // dagsats for ferietrekket: årslønn / 260

// --- Hjelpere ---------------------------------------------------------------------------------

export const rund = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const rund4 = (n: number) => Math.round((n + Number.EPSILON) * 10000) / 10000;
export const pluss = (iso: string, n: number) => new Date(Date.parse(`${iso}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const ukedagNr = (iso: string) => new Date(`${iso}T12:00:00Z`).getUTCDay(); // 0 = søndag
export const virkedag = (iso: string) => ukedagNr(iso) !== 0 && ukedagNr(iso) !== 6 && !helligdag(iso);
// Den siste dagen i måneden («2026-10» eller «2026-10-01» gir 2026-10-31).
export const periodeSlutt = (periode: string) => new Date(Date.UTC(Number(periode.slice(0, 4)), Number(periode.slice(5, 7)), 0, 12)).toISOString().slice(0, 10);
const dagerMellom = (fra: string, til: string) => Math.round((Date.parse(`${til}T12:00:00Z`) - Date.parse(`${fra}T12:00:00Z`)) / 86_400_000);
const maks = (a: string, b: string) => (a > b ? a : b);
const min = (a: string, b: string) => (a < b ? a : b);
const tall = (n: number) => n.toLocaleString("nb-NO", { maximumFractionDigits: 2 }).replace(/[\u00a0\u202f]/g, " ").replace(/\u2212/g, "-");
const MND = ["januar", "februar", "mars", "april", "mai", "juni", "juli", "august", "september", "oktober", "november", "desember"];
// «oktober 2026» for perioden 2026-10-01.
export const maanedNavn = (periode: string) => `${MND[Number(periode.slice(5, 7)) - 1]} ${periode.slice(0, 4)}`;

// Arbeidsdagene (mandag–fredag) fra og med fra til og med til.
export function arbeidsdager(fra: string, til: string) {
  let n = 0;
  for (let d = fra; d <= til; d = pluss(d, 1)) if (ukedagNr(d) !== 0 && ukedagNr(d) !== 6) n++;
  return n;
}

// Utbetalingsdatoen: lønnsdagen i måneden, eller virkedagen før når den faller på en helg eller
// helligdag (den siste dagen i måneden når måneden er kortere).
export function utbetalingsdato(periode: string, lonnsdag: number) {
  const slutt = periodeSlutt(periode);
  let d = `${periode.slice(0, 7)}-${String(Math.min(lonnsdag, Number(slutt.slice(8)))).padStart(2, "0")}`;
  while (!virkedag(d)) d = pluss(d, -1);
  return d;
}

// Fristene: skattetrekket betales til Skatteetaten senest første virkedag etter
// utbetalingen (fra 2026); arbeidsgiveravgiften for to måneder om gangen den 15. i måneden
// etter (januar–februar 15. mars osv., november–desember 15. januar).
export function frister(utbetalt: string) {
  let trekk = pluss(utbetalt, 1);
  while (!virkedag(trekk)) trekk = pluss(trekk, 1);
  const aar = Number(utbetalt.slice(0, 4));
  const mnd = Number(utbetalt.slice(5, 7));
  const forfall = mnd >= 11 ? `${aar + 1}-01-15` : `${aar}-${String(mnd + (mnd % 2 === 1 ? 2 : 1)).padStart(2, "0")}-15`;
  let aga = forfall;
  while (!virkedag(aga)) aga = pluss(aga, 1);
  return { skattetrekk: trekk, aga };
}

// --- Typer ------------------------------------------------------------------------------------

export type Oppsett = Regler & {
  aga_sone: string;
  otp_prosent: number;
  feriepenger_prosent: number;
  ferie_dager: number;
};

export type Ansatt = {
  id: string;
  ansattnummer: number;
  navn: string;
  fodselsdato: string | null;
  ansatt_fra: string;
  ansatt_til: string | null;
  lonnstype: "maaned" | "time";
  maanedslonn: number | null;
  timelonn: number | null;
  stillingsprosent: number;
  ukentlig_arbeidstid: number;
  ferie_dager: number | null;
  kontonr: string | null;
  skattekort: "tabell" | "prosent" | "frikort" | null;
  skatt_tabell: number | null;
  skatt_prosent: number | null;
  skatt_frikort: number | null; // frikort uten beløp: uten grense (ingen trekk)
  skattekort_aar: number | null;
  // Fra Skatteetaten (0068): svaret og tilleggsopplysningene (Svalbard, kildeskatt, tiltakssonen).
  skattekort_resultat?: string | null;
  skattekort_tillegg?: string[] | null;
};

// Tilleggsopplysningene på skattekortet som bør sjekkes i lønnskjøringen (bor den ansatte i
// tiltakssonen, er det alt regnet med i skattekortet).
export const TILLEGGSOPPLYSNINGER: Record<string, string> = {
  oppholdPaaSvalbard: "Skattekortet sier at den ansatte bor på Svalbard. Lønn for arbeid på Svalbard har egne trekkregler (svalbardskatt); kontroller trekket.",
  kildeskattPaaLoenn: "Den ansatte er på kildeskatteordningen for utenlandske arbeidstakere (PAYE). Trekket følger skattekortet; kontroller at lønnen rapporteres med kildeskatt i a-meldingen.",
};

export type Linje = {
  lonnsart: string;
  tekst: string;
  antall: number | null;
  sats: number | null;
  belop: number;
  nokkel: string | null;
  opptjeningsaar?: number | null;
  kilde?: "auto" | "manuell";
  fjernet?: boolean;
};

export type Tillegg = { id: string; navn: string; belop: number; per: "maaned" | "time"; fra: string | null; til: string | null };
export type Ferieuke = { alle: (Foring & { id: string })[]; betalt: Foring[] }; // godkjente timer i uka, og de som er lønnet
export type Sykedag = { dato: string; timer: number; type: "syk" | "sykt_barn" };
export type Fravaersperiode = { fra: string; til: string; type: string };

// --- Linjene ----------------------------------------------------------------------------------

// Timelønnen for en med fastlønn: årslønnen delt på de avtalte timene i året.
export const timesats = (a: Ansatt) =>
  a.maanedslonn && a.ukentlig_arbeidstid > 0 ? rund4((Number(a.maanedslonn) * 12) / ((Number(a.ukentlig_arbeidstid) * Number(a.stillingsprosent)) / 100) / 52) : 0;

// Hvor stor del av måneden den ansatte er ansatt (arbeidsdagene).
export function andelAnsatt(a: Ansatt, fra: string, til: string) {
  const start = maks(fra, a.ansatt_fra);
  const slutt = a.ansatt_til ? min(til, a.ansatt_til) : til;
  if (slutt < start) return { andel: 0, dager: 0, alle: arbeidsdager(fra, til) };
  const alle = arbeidsdager(fra, til);
  const dager = arbeidsdager(start, slutt);
  return { andel: alle ? dager / alle : 0, dager, alle };
}

export function fastlonn(a: Ansatt, fra: string, til: string): Linje | null {
  if (a.lonnstype !== "maaned" || !a.maanedslonn) return null;
  const { andel, dager, alle } = andelAnsatt(a, fra, til);
  if (andel <= 0) return null;
  const hel = andel >= 1;
  return {
    lonnsart: "fastlonn",
    tekst: hel ? "Fastlønn" : `Fastlønn (${dager} av ${alle} arbeidsdager)`,
    antall: hel ? 1 : rund4(andel),
    sats: Number(a.maanedslonn),
    belop: rund(Number(a.maanedslonn) * andel),
    nokkel: "fastlonn",
  };
}

// Timene som ikke er lønnet: for hver uke det som er godkjent i alt, minus det som er lønnet før
// (så overtiden regnes på hele uka). Timelønn for alle timene og overtidstillegg; med fastlønn
// merarbeid (timelønnen) og overtid (timelønnen med tillegget).
export function timelinjer(a: Ansatt, r: Regler, uker: Ferieuke[]) {
  const avtalt = (Number(a.ukentlig_arbeidstid) * Number(a.stillingsprosent)) / 100;
  let timer = 0;
  let merarbeid = 0;
  const overtid = new Map<number, number>();
  for (const u of uker) {
    const alle: Ukesum = beregnUke(u.alle, r, avtalt);
    const betalt: Ukesum = beregnUke(u.betalt, r, avtalt);
    timer += alle.sum - betalt.sum;
    merarbeid += alle.merarbeid - betalt.merarbeid;
    for (const o of alle.overtid) overtid.set(o.prosent, (overtid.get(o.prosent) ?? 0) + o.timer);
    for (const o of betalt.overtid) overtid.set(o.prosent, (overtid.get(o.prosent) ?? 0) - o.timer);
  }
  const linjer: Linje[] = [];
  const overtidsliste = [...overtid.entries()].filter(([, t]) => rund(t) > 0).sort((x, y) => x[0] - y[0]);
  if (a.lonnstype === "time") {
    const sats = Number(a.timelonn ?? 0);
    if (rund(timer) > 0) linjer.push({ lonnsart: "timelonn", tekst: "Timelønn", antall: rund(timer), sats, belop: rund(rund(timer) * sats), nokkel: "timelonn" });
    for (const [p, t] of overtidsliste)
      linjer.push({ lonnsart: "overtid", tekst: `Overtidstillegg ${p} %`, antall: rund(t), sats: rund4((sats * p) / 100), belop: rund((rund(t) * sats * p) / 100), nokkel: `overtid:${p}` });
  } else {
    const sats = timesats(a);
    if (rund(merarbeid) > 0) linjer.push({ lonnsart: "merarbeid", tekst: "Merarbeid", antall: rund(merarbeid), sats, belop: rund(rund(merarbeid) * sats), nokkel: "merarbeid" });
    for (const [p, t] of overtidsliste)
      linjer.push({ lonnsart: "overtid", tekst: `Overtid ${p} %`, antall: rund(t), sats: rund4(sats * (1 + p / 100)), belop: rund(rund(t) * sats * (1 + p / 100)), nokkel: `overtid:${p}` });
  }
  return { linjer, timer: rund(timer), ekstraTimer: rund(merarbeid + overtidsliste.reduce((s, [, t]) => s + t, 0)) };
}

// De faste tilleggene: per måned for dagene de gjelder (og den ansatte er ansatt), per time for
// timene (timelønn: de lønnede timene; fastlønn: de avtalte timene i måneden og timene utover).
export function tilleggslinjer(a: Ansatt, tillegg: Tillegg[], fra: string, til: string, timer: number, ekstraTimer: number): Linje[] {
  const dagerIMnd = dagerMellom(fra, til) + 1;
  const ut: Linje[] = [];
  for (const t of tillegg) {
    const start = maks(maks(fra, t.fra ?? fra), a.ansatt_fra);
    const slutt = min(min(til, t.til ?? til), a.ansatt_til ?? til);
    if (slutt < start) continue;
    if (t.per === "maaned") {
      const andel = (dagerMellom(start, slutt) + 1) / dagerIMnd;
      ut.push({ lonnsart: "fast_tillegg", tekst: andel >= 1 ? t.navn : `${t.navn} (${dagerMellom(start, slutt) + 1} av ${dagerIMnd} dager)`, antall: andel >= 1 ? 1 : rund4(andel), sats: Number(t.belop), belop: rund(Number(t.belop) * andel), nokkel: `tillegg:${t.id}` });
    } else {
      // Fastlønn: de avtalte timene i måneden (for arbeidsdagene tillegget gjelder) og timene utover.
      const avtalte = ((Number(a.ukentlig_arbeidstid) * Number(a.stillingsprosent)) / 100) * (52 / 12) * (arbeidsdager(start, slutt) / Math.max(1, arbeidsdager(fra, til)));
      const t2 = rund(a.lonnstype === "maaned" ? avtalte + ekstraTimer : timer);
      if (t2 > 0) ut.push({ lonnsart: "fast_tillegg", tekst: t.navn, antall: t2, sats: Number(t.belop), belop: rund(t2 * Number(t.belop)), nokkel: `tillegg:${t.id}` });
    }
  }
  return ut;
}

// Arbeidsgiverperioden: de første 16 kalenderdagene i hvert sykefravær (et nytt fravær innen 16
// dager etter det forrige hører til det samme), og om den ansatte har vært ansatt fire uker.
export function arbeidsgiverperiode(perioder: Fravaersperiode[], ansattFra: string) {
  const syk = perioder.filter((p) => p.type === "syk").sort((x, y) => x.fra.localeCompare(y.fra));
  const agp = new Set<string>();
  const etter = new Set<string>();
  const utenOpptjening = new Set<string>();
  let brukt = 0;
  let forrigeSlutt: string | null = null;
  let start: string | null = null;
  for (const p of syk) {
    if (!forrigeSlutt || dagerMellom(forrigeSlutt, p.fra) - 1 > AGP_DAGER) {
      brukt = 0;
      start = p.fra;
    }
    for (let d = p.fra; d <= p.til; d = pluss(d, 1)) {
      if (dagerMellom(ansattFra, start!) < OPPTJENING_DAGER) utenOpptjening.add(d);
      else if (brukt < AGP_DAGER) {
        agp.add(d);
        brukt++;
      } else etter.add(d);
    }
    if (!forrigeSlutt || p.til > forrigeSlutt) forrigeSlutt = p.til;
  }
  return { agp, etter, utenOpptjening };
}

// Sykepenger og omsorgspenger for den med timelønn: de planlagte timene (vakter og faste dager)
// i arbeidsgiverperioden og de ti omsorgsdagene i året. Med fastlønn går lønnen som vanlig.
export function sykelinjer(a: Ansatt, dager: Sykedag[], agp: Set<string>, omsorgBrukt: number): { linjer: Linje[]; merknader: string[] } {
  const merknader: string[] = [];
  if (a.lonnstype !== "time") return { linjer: [], merknader };
  const sats = Number(a.timelonn ?? 0);
  const linjer: Linje[] = [];
  const syk = dager.filter((d) => d.type === "syk" && agp.has(d.dato) && d.timer > 0);
  const sykTimer = rund(syk.reduce((s, d) => s + d.timer, 0));
  if (sykTimer > 0)
    linjer.push({ lonnsart: "sykepenger", tekst: `Sykepenger i arbeidsgiverperioden (${syk.length} ${syk.length === 1 ? "dag" : "dager"})`, antall: sykTimer, sats, belop: rund(sykTimer * sats), nokkel: "sykepenger" });
  const barn = dager.filter((d) => d.type === "sykt_barn" && d.timer > 0).sort((x, y) => x.dato.localeCompare(y.dato));
  const igjen = Math.max(0, OMSORG_DAGER - omsorgBrukt);
  const betalt = barn.slice(0, igjen);
  const barnTimer = rund(betalt.reduce((s, d) => s + d.timer, 0));
  if (barnTimer > 0)
    linjer.push({ lonnsart: "omsorgspenger", tekst: `Omsorgspenger, sykt barn (${betalt.length} ${betalt.length === 1 ? "dag" : "dager"})`, antall: barnTimer, sats, belop: rund(barnTimer * sats), nokkel: "omsorgspenger" });
  if (barn.length > betalt.length)
    merknader.push(`${barn.length - betalt.length} ${barn.length - betalt.length === 1 ? "dag" : "dager"} med sykt barn er over de ${OMSORG_DAGER} omsorgsdagene arbeidsgiveren betaler i året; NAV dekker dem (søk refusjon om dere betaler).`);
  return { linjer, merknader };
}

// Feriepengene for et opptjeningsår: grunnlaget ganger satsen, minus det som er utbetalt; og
// 2,3 % av grunnlaget (inntil 6 G) det året den ansatte fyller 60.
export function feriepengelinjer(a: Ansatt, o: Oppsett, aar: number, grunnlag: number, utbetalt: number, utbetalt60: number, dato: string, sluttoppgjor = false): Linje[] {
  const ut: Linje[] = [];
  const belop = rund((grunnlag * Number(o.feriepenger_prosent)) / 100 - utbetalt);
  if (belop > 0)
    ut.push({
      lonnsart: "feriepenger",
      tekst: `Feriepenger opptjent ${aar}${sluttoppgjor ? " (sluttoppgjør)" : ""}`,
      antall: rund(grunnlag),
      sats: Number(o.feriepenger_prosent),
      belop,
      nokkel: `feriepenger:${aar}`,
      opptjeningsaar: aar,
    });
  const fodt = a.fodselsdato ? Number(a.fodselsdato.slice(0, 4)) : null;
  // Den ekstra ferieuka: ferieåret er året etter opptjeningsåret, og den ansatte fyller 60 i det.
  if (fodt && fodt <= aar + 1 - 60) {
    const g6 = 6 * grunnbelop(dato);
    const ekstra = rund((Math.min(grunnlag, g6) * FERIE_60) / 100 - utbetalt60);
    if (ekstra > 0)
      ut.push({ lonnsart: "feriepenger_60", tekst: `Feriepenger for den ekstra ferieuka (${aar})`, antall: rund(Math.min(grunnlag, g6)), sats: FERIE_60, belop: ekstra, nokkel: `feriepenger_60:${aar}`, opptjeningsaar: aar });
  }
  return ut;
}

// Trekket i lønnen for ferien (fastlønn): dagsatsen (årslønnen / 260) ganger feriedagene.
export function ferietrekk(a: Ansatt, o: Oppsett): Linje | null {
  if (a.lonnstype !== "maaned" || !a.maanedslonn) return null;
  const dager = Number(a.ferie_dager ?? o.ferie_dager);
  if (!(dager > 0)) return null;
  const dagsats = rund4((Number(a.maanedslonn) * 12) / ARBEIDSDAGER_AAR);
  return { lonnsart: "ferietrekk", tekst: `Trekk i lønn for ferie (${tall(dager)} dager)`, antall: dager, sats: dagsats, belop: -rund(dager * dagsats), nokkel: "ferietrekk" };
}

// --- Summene og skattetrekket -----------------------------------------------------------------

export type Trekkrad = { grunnlag: number; trekk: number };
export type Summer = {
  brutto: number;
  trekkpliktig: number;
  trekkgrunnlag: number;
  skattetrekk: number;
  trekkmetode: string;
  utgifter: number;
  trekk_etter_skatt: number;
  netto: number;
  feriepengegrunnlag: number;
  feriepenger_opptjent: number;
  otp_grunnlag: number;
  otp: number;
  aga_grunnlag: number;
  merknader: string[];
};

// Trekket etter tabellen: raden med det høyeste grunnlaget som ikke er større. Over tabellen:
// trekket øverst pluss marginalsatsen mellom de to øverste radene av det som er over.
export function tabelloppslag(rader: Trekkrad[], grunnlag: number): { trekk: number; over: boolean } {
  if (!rader.length) return { trekk: 0, over: false };
  let lo = 0;
  let hi = rader.length - 1;
  if (grunnlag < rader[0]!.grunnlag) return { trekk: 0, over: false };
  if (grunnlag >= rader[hi]!.grunnlag) {
    const siste = rader[hi]!;
    const forrige = rader[hi - 1];
    const sats = forrige && siste.grunnlag > forrige.grunnlag ? (siste.trekk - forrige.trekk) / (siste.grunnlag - forrige.grunnlag) : 0;
    const stepp = forrige ? siste.grunnlag - forrige.grunnlag : 0;
    const over = stepp > 0 && grunnlag >= siste.grunnlag + stepp;
    return { trekk: Math.floor(siste.trekk + Math.max(0, grunnlag - siste.grunnlag) * (over ? sats : 0)), over };
  }
  while (lo < hi) {
    const m = Math.ceil((lo + hi) / 2);
    if (rader[m]!.grunnlag <= grunnlag) lo = m;
    else hi = m - 1;
  }
  return { trekk: rader[lo]!.trekk, over: false };
}

export type Trekkgrunnlag = {
  ansatt: Ansatt;
  aar: number; // året lønnen utbetales (skatteåret)
  ekstra: boolean; // ekstra kjøring: tabelltrekk etter prosentsatsen
  halvSkatt: boolean;
  tabell: Trekkrad[] | null; // null: tabellen for året er ikke lastet inn
  frikortBrukt: number; // trekkpliktig lønn i år før denne kjøringen
};

export function summer(linjer: Linje[], o: Oppsett, t: Trekkgrunnlag, dato: string, manueltTrekk: number | null): Summer {
  const aktive = linjer.filter((l) => !l.fjernet);
  const merknader: string[] = [];
  let brutto = 0;
  let trekkpliktig = 0;
  let utgifter = 0;
  let trekkEtter = 0;
  let ferie = 0;
  let otpGrunnlag = 0;
  let agaGrunnlag = 0;
  let unntatt = 0; // feriepenger uten tabelltrekk (utbetalt i ferieåret)
  let ferie60 = 0;
  for (const l of aktive) {
    const art = lonnsart(l.lonnsart);
    const b = Number(l.belop);
    if (art.type === "utgift") utgifter += b;
    else if (art.type === "trekk") trekkEtter += b;
    else brutto += b;
    if (art.type === "lonn" && art.trekk) trekkpliktig += b;
    if (art.ferie) ferie += b;
    if (art.otp) otpGrunnlag += b;
    if (art.aga) agaGrunnlag += b;
    if (l.lonnsart === "feriepenger" && l.opptjeningsaar != null && l.opptjeningsaar < t.aar) unntatt += b;
    if (l.lonnsart === "feriepenger_60") ferie60 += b;
  }
  brutto = rund(brutto);
  trekkpliktig = rund(trekkpliktig);

  // Skattetrekket.
  const a = t.ansatt;
  const prosent = (p: number, g: number) => Math.max(0, Math.floor((g * p) / 100));
  let trekk = 0;
  let metode = "";
  let grunnlag = trekkpliktig;
  if (!a.skattekort) {
    trekk = prosent(UTEN_SKATTEKORT, trekkpliktig);
    metode = `Uten skattekort (${UTEN_SKATTEKORT} %)`;
    if (trekkpliktig > 0) merknader.push(`Mangler skattekort: det trekkes ${UTEN_SKATTEKORT} %. Registrer skattekortet på den ansatte.`);
  } else if (a.skattekort === "prosent") {
    trekk = prosent(Number(a.skatt_prosent), trekkpliktig);
    metode = `Prosenttrekk ${tall(Number(a.skatt_prosent))} %`;
  } else if (a.skattekort === "frikort" && a.skatt_frikort == null) {
    // Frikort uten beløpsgrense (eller ikke trekkplikt): ingen trekk.
    grunnlag = 0;
    metode = "Frikort uten beløpsgrense";
  } else if (a.skattekort === "frikort") {
    const igjen = Math.max(0, Number(a.skatt_frikort) - t.frikortBrukt);
    const over = Math.max(0, trekkpliktig - igjen);
    trekk = prosent(UTEN_SKATTEKORT, over);
    grunnlag = rund(over);
    metode = over > 0 ? `Frikort (brukt opp, ${UTEN_SKATTEKORT} % av det som er over)` : `Frikort (${tall(rund(igjen - trekkpliktig))} kr igjen)`;
    if (over > 0) merknader.push(`Frikortet er brukt opp: det trekkes ${UTEN_SKATTEKORT} % av ${tall(rund(over))} kr.`);
  } else {
    const p = Number(a.skatt_prosent ?? 0);
    if (t.ekstra) {
      grunnlag = rund(trekkpliktig - unntatt);
      trekk = prosent(p, grunnlag);
      metode = `Prosenttrekk ${tall(p)} % (tabellkort, ekstra kjøring)`;
    } else {
      grunnlag = rund(trekkpliktig - unntatt - ferie60);
      if (t.tabell) {
        const oppslag = tabelloppslag(t.tabell, Math.max(0, grunnlag));
        trekk = oppslag.trekk;
        if (oppslag.over) merknader.push(`Lønnen er over den høyeste raden i tabell ${a.skatt_tabell}; trekket er regnet videre med satsen øverst i tabellen. Kontroller trekket.`);
      } else {
        trekk = prosent(p, grunnlag);
        merknader.push(`Trekktabellene for ${t.aar} er ikke lastet inn ennå: trekket er regnet med prosentsatsen på skattekortet (${tall(p)} %). Kontroller trekket mot tabell ${a.skatt_tabell}.`);
      }
      if (t.halvSkatt) trekk = Math.floor(trekk / 2);
      trekk += prosent(p, ferie60);
      metode = `Tabell ${a.skatt_tabell}${t.halvSkatt ? " (halv skatt)" : ""}`;
    }
    if (unntatt > 0 && !t.ekstra) merknader.push("Det trekkes ikke skatt av feriepengene (tabelltrekk).");
  }
  if (a.skattekort && a.skattekort_aar && a.skattekort_aar !== t.aar) merknader.push(`Skattekortet er for ${a.skattekort_aar}, ikke ${t.aar}. Hent det nye skattekortet.`);
  if (a.skattekort_resultat === "vurderArbeidstillatelse")
    merknader.push("Skatteetaten ber arbeidsgiveren vurdere om den ansatte har arbeidstillatelse (gjelder ofte utenlandske arbeidstakere).");
  for (const x of a.skattekort_tillegg ?? []) if (TILLEGGSOPPLYSNINGER[x] && trekkpliktig > 0) merknader.push(TILLEGGSOPPLYSNINGER[x]);
  if (manueltTrekk != null) {
    trekk = manueltTrekk;
    metode = `${metode} – endret for hånd`;
  }

  const feriepengegrunnlag = rund(ferie);
  const otpProsent = Number(o.otp_prosent);
  const otpTak = (12 * grunnbelop(dato)) / 12;
  const otp = otpProsent > 0 ? rund((Math.max(0, Math.min(otpGrunnlag, otpTak)) * otpProsent) / 100) : 0;
  const netto = rund(brutto - trekk + utgifter + trekkEtter);
  if (netto < 0) merknader.push("Nettolønnen er negativ. Sjekk trekkene.");
  return {
    brutto,
    trekkpliktig,
    trekkgrunnlag: rund(Math.max(0, grunnlag)),
    skattetrekk: trekk,
    trekkmetode: metode,
    utgifter: rund(utgifter),
    trekk_etter_skatt: rund(trekkEtter),
    netto,
    feriepengegrunnlag,
    feriepenger_opptjent: rund((feriepengegrunnlag * Number(o.feriepenger_prosent)) / 100),
    otp_grunnlag: rund(otpGrunnlag),
    otp,
    aga_grunnlag: rund(agaGrunnlag + otp),
    merknader,
  };
}

// Arbeidsgiveravgiften for slippene i en kjøring (i rekkefølge), med fribeløpet i sone 1a:
// redusert sats til den sparte avgiften i året (brukt før + i kjøringen) når 850 000 kr.
export function arbeidsgiveravgift(sone: string, grunnlag: number[], fribelopBrukt: number): { aga: number; sats: number }[] {
  const sats = AGA_SATS[sone] ?? AGA_FULL;
  let brukt = fribelopBrukt;
  return grunnlag.map((g) => {
    if (sone !== "1a") return { aga: rund((g * sats) / 100), sats };
    const full = (g * AGA_FULL) / 100;
    const redusert = (g * sats) / 100;
    const spart = full - redusert;
    const igjen = Math.max(0, AGA_FRIBELOP - brukt);
    if (spart <= igjen) {
      brukt += spart;
      return { aga: rund(redusert), sats };
    }
    brukt = AGA_FRIBELOP;
    const aga = rund(full - igjen);
    return { aga, sats: g ? rund((aga / g) * 100) : AGA_FULL };
  });
}
