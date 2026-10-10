// Lønnsberegningen (uten database, så den kan testes for seg): linjene på en lønnsslipp
// (fastlønn, timelønn, overtid og merarbeid, faste tillegg, sykepenger og omsorgspenger,
// feriepenger og ferietrekk, og honorar til frilansere og styremedlemmer), skattetrekket,
// feriepengene, OTP og arbeidsgiveravgiften.
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
export const tall = (n: number) => n.toLocaleString("nb-NO", { maximumFractionDigits: 2 }).replace(/[\u00a0\u202f]/g, " ").replace(/\u2212/g, "-");
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
  // Ordningen tar ikke opp arbeidstakere som har fylt 75 år (0097).
  otp_unntak_75?: boolean;
  // AFP og OU (0098): med i Fellesordningen for AFP, premiesatsen, og OU-premien per måned per
  // heltidsansatt.
  afp?: boolean;
  afp_sats?: number;
  ou_premie?: number;
  feriepenger_prosent: number;
  ferie_dager: number;
  // Lønn under sykdom etter arbeidsgiverperioden (0079): arbeidsgiveren betaler og krever refusjon
  // (standard), eller NAV betaler.
  sykepenger_refusjon?: boolean;
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
  // Arbeidsforholdet (0077) og honoraret for frilansere og styremedlemmer (0096).
  arbeidsforhold_type?: string;
  honorar_art?: "honorar" | "styrehonorar";
  // Dødsdatoen (0099): lønn utbetalt etter den er lønn etter dødsfall.
  dodsdato?: string | null;
};

// --- Frilansere, oppdragstakere og styremedlemmer (0096) ---------------------------------------
// Arbeidsforholdet «frilanser, oppdragstaker eller honorar» gir honorar i stedet for lønn:
// ferieloven, OTP-loven og arbeidsgiverens sykepenger gjelder arbeidstakere, så det blir ingen
// feriepenger, OTP eller sykepenger, overtid regnes ikke, og permisjon hører ikke til. Det faste
// honoraret (månedslønnen) og timene (med timelønn) blir honorar av typen på den ansatte.

export const FRILANSER = "frilanserOppdragstakerHonorarPersonerMm";
export const erFrilanser = (a: Pick<Ansatt, "arbeidsforhold_type">) => a.arbeidsforhold_type === FRILANSER;
export const honorarArt = (a: Pick<Ansatt, "honorar_art">) => (a.honorar_art === "styrehonorar" ? "styrehonorar" : "honorar");
// Lønnsartene som blir honorar for en frilanser (lønnen for tid; ikke sykdom, permisjon og ferie).
export const SOM_HONORAR = new Set(["fastlonn", "timelonn", "merarbeid", "ekstratimer", "overtid", "fast_tillegg", "uregelmessig_tillegg", "etterbetaling", "etterbetaling_time", "etterbetaling_overtid"]);

// Fastlønnslinjene som fast honorar (styrehonorar eller honorar for oppdrag).
export const somHonorar = (a: Pick<Ansatt, "honorar_art">, l: Linje): Linje => ({
  ...l,
  lonnsart: honorarArt(a),
  tekst: l.tekst.replace(/^Fastlønn/, a.honorar_art === "styrehonorar" ? "Fast styrehonorar" : "Fast honorar"),
});

// --- OTP-medlemskapet (0097) ------------------------------------------------------------------
// Innskuddspensjonsloven § 4-2 (fra 2022): arbeidstakere som har fylt 13 år er med i ordningen fra
// første krone og første dag, og ordningens regelverk kan si at de som har fylt 75 år ikke tas opp.
// Frilansere og oppdragstakere er ikke arbeidstakere. Uten fødselsdato regnes den ansatte som med.

export const OTP_FRA_ALDER = 13;
export const OTP_TIL_ALDER = 75;

// Datoen den ansatte fyller år (29. februar blir 1. mars i år som ikke er skuddår).
export function fyller(fodselsdato: string, alder: number) {
  const aar = Number(fodselsdato.slice(0, 4)) + alder;
  const d = `${aar}-${fodselsdato.slice(5)}`;
  return fodselsdato.slice(5) === "02-29" && !(aar % 4 === 0 && (aar % 100 !== 0 || aar % 400 === 0)) ? `${aar}-03-01` : d;
}

// Perioden den ansatte er med i OTP (fra og med, til og med; null: ingen grense), eller null når
// den ansatte ikke er med (frilanser, eller har fylt 75 år før ansettelsen når ordningen ikke tar
// dem opp).
export function otpMedlemskap(a: Pick<Ansatt, "fodselsdato" | "ansatt_fra" | "ansatt_til" | "arbeidsforhold_type">, unntak75: boolean) {
  if (erFrilanser(a)) return null;
  let fra = a.ansatt_fra;
  let til = a.ansatt_til;
  if (a.fodselsdato) {
    const tretten = fyller(a.fodselsdato, OTP_FRA_ALDER);
    if (tretten > fra) fra = tretten;
    if (unntak75) {
      const sytti = pluss(fyller(a.fodselsdato, OTP_TIL_ALDER), -1);
      if (!til || sytti < til) til = sytti;
    }
  }
  return til && til < fra ? null : { fra, til };
}

// Om den ansatte er med i OTP på datoen (lønnen utbetales), og grunnen når den ikke er det.
export function otpMedlem(a: Pick<Ansatt, "fodselsdato" | "ansatt_fra" | "ansatt_til" | "arbeidsforhold_type">, unntak75: boolean, dato: string): { medlem: boolean; grunn?: string } {
  if (erFrilanser(a)) return { medlem: false, grunn: "frilanser eller oppdragstaker" };
  if (a.fodselsdato && fyller(a.fodselsdato, OTP_FRA_ALDER) > dato) return { medlem: false, grunn: `under ${OTP_FRA_ALDER} år (med fra ${fyller(a.fodselsdato, OTP_FRA_ALDER).split("-").reverse().join(".")})` };
  if (a.fodselsdato && unntak75 && fyller(a.fodselsdato, OTP_TIL_ALDER) <= dato) return { medlem: false, grunn: `har fylt ${OTP_TIL_ALDER} år (ordningen tar ikke opp dem)` };
  return { medlem: true };
}

// --- AFP og OU (0098) --------------------------------------------------------------------------
// Fellesordningen for AFP: premien er satsen av den delen av den ansattes lønn i året som er mellom
// 1 G og 7,1 G (gjennomsnittlig G i året), fra og med året den ansatte fyller 13 til og med året den
// ansatte fyller 61. Grunnlaget er den avgiftspliktige kontantlønnen (lønn, tillegg, overtid, bonus
// og feriepenger; ikke naturalytelser og utgiftsgodtgjørelser). Lønnskjøringen avsetter premien for
// året så langt, minus det som er avsatt før i året, så den blir riktig selv om lønnen varierer
// (som Fellesordningen gjør kvartal for kvartal). OU-premien er et fast beløp per måned per
// heltidsansatt (etter stillingsprosenten og dagene den ansatte er ansatt). Arbeidsgiveravgiften av
// AFP-premien regnes når premien betales (afpPremier.ts), ikke på slippen.

export const AFP_FRA_ALDER = 13;
export const AFP_TIL_ALDER = 61;

// Gjennomsnittlig G i året (G endres 1. mai): fire måneder med G før og åtte med G etter.
export const snittG = (aar: number) => rund((4 * grunnbelop(`${aar}-04-30`) + 8 * grunnbelop(`${aar}-05-01`)) / 12);

// Lønnsartene som er med i grunnlaget for AFP-premien: trekk- og avgiftspliktig kontantlønn.
export const afpLonn = (kode: string) => {
  const art = lonnsart(kode);
  return art.type === "lonn" && art.trekk && art.aga;
};

// Om den ansatte er med i grunnlaget for AFP-premien det året (13–61 år i året; uten fødselsdato: ja).
export const afpAlder = (fodselsdato: string | null, aar: number) => {
  if (!fodselsdato) return true;
  const alder = aar - Number(fodselsdato.slice(0, 4));
  return alder >= AFP_FRA_ALDER && alder <= AFP_TIL_ALDER;
};

// AFP-premien for slippen: premien av grunnlaget i året med slippen, minus premien av grunnlaget
// før den.
export function afpPremie(sats: number, aar: number, grunnlagFor: number, grunnlag: number) {
  const g = snittG(aar);
  const premie = (sum: number) => (Math.max(0, Math.min(sum, 7.1 * g) - g) * sats) / 100;
  return rund(premie(grunnlagFor + grunnlag) - premie(grunnlagFor));
}

// Honoraret for timene med timelønn: alle de godkjente timene i ukene som ikke er lønnet (det
// som er godkjent i alt, minus det som er lønnet før), uten overtid og timebank. Med fast honorar
// gir timene ikke noe i tillegg.
export function honorarTimer(a: Ansatt, uker: Ferieuke[]): { linjer: Linje[]; timer: number } {
  let timer = 0;
  for (const u of uker) timer += u.alle.reduce((s, f) => s + Number(f.timer), 0) - u.betalt.reduce((s, f) => s + Number(f.timer), 0);
  timer = rund(timer);
  if (a.lonnstype !== "time" || timer <= 0) return { linjer: [], timer };
  const sats = Number(a.timelonn ?? 0);
  return {
    linjer: [{ lonnsart: honorarArt(a), tekst: a.honorar_art === "styrehonorar" ? "Styrehonorar for timer" : "Honorar for timer", antall: timer, sats, belop: rund(timer * sats), nokkel: "honorar_timer" }],
    timer,
  };
}

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
  // Perioden linjen gjelder når den ikke er kjøringens (etterbetaling for en tidligere måned).
  opptjent_fra?: string | null;
  opptjent_til?: string | null;
  kilde?: "auto" | "manuell";
  fjernet?: boolean;
  // Tilleggsinformasjon til a-meldingen (fri bil: listeprisen og registreringsnummeret; 0083).
  tillegg?: Record<string, unknown> | null;
};

export type Tillegg = { id: string; navn: string; belop: number; per: "maaned" | "time"; fra: string | null; til: string | null };
export type Ferieuke = { alle: (Foring & { id: string })[]; betalt: Foring[] }; // godkjente timer i uka, og de som er lønnet
// grad: sykmeldingsgraden (100 når den ikke er gradert); den gir andelen av timene som er syk.
export type Sykedag = { dato: string; timer: number; type: "syk" | "sykt_barn"; grad?: number };
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
//
// Timer i timebanken (0073; bare overtid og ekstratimer, som ikke regnes med i grensene) lønnes
// ikke nå, men overtidstillegget for dem utbetales likevel (arbeidsmiljøloven § 10-6).
export function timelinjer(a: Ansatt, r: Regler, uker: Ferieuke[]) {
  const avtalt = (Number(a.ukentlig_arbeidstid) * Number(a.stillingsprosent)) / 100;
  let timer = 0;
  let merarbeid = 0;
  let uten = 0; // ekstratimer uten overtid
  const overtid = new Map<number, number>();
  const bankTillegg = new Map<number, number>(); // overtid i timebanken: bare tillegget
  const vanlige = (l: Foring[]) => l.filter((f) => !f.timebank);
  const iBanken = (m: Map<number, number>, l: Foring[], fortegn: 1 | -1) => {
    for (const f of l) if (f.timebank && f.overtid_prosent) m.set(f.overtid_prosent, (m.get(f.overtid_prosent) ?? 0) + fortegn * Number(f.timer));
  };
  for (const u of uker) {
    const alle: Ukesum = beregnUke(vanlige(u.alle), r, avtalt);
    const betalt: Ukesum = beregnUke(vanlige(u.betalt), r, avtalt);
    timer += alle.sum - betalt.sum;
    merarbeid += alle.merarbeid - betalt.merarbeid;
    uten += alle.uten_overtid - betalt.uten_overtid;
    for (const o of alle.overtid) overtid.set(o.prosent, (overtid.get(o.prosent) ?? 0) + o.timer);
    for (const o of betalt.overtid) overtid.set(o.prosent, (overtid.get(o.prosent) ?? 0) - o.timer);
    iBanken(bankTillegg, u.alle, 1);
    iBanken(bankTillegg, u.betalt, -1);
  }
  const linjer: Linje[] = [];
  const overtidsliste = [...overtid.entries()].filter(([, t]) => rund(t) > 0).sort((x, y) => x[0] - y[0]);
  const bankliste = [...bankTillegg.entries()].filter(([, t]) => rund(t) > 0).sort((x, y) => x[0] - y[0]);
  const sats = a.lonnstype === "time" ? Number(a.timelonn ?? 0) : timesats(a);
  if (a.lonnstype === "time") {
    if (rund(timer) > 0) linjer.push({ lonnsart: "timelonn", tekst: "Timelønn", antall: rund(timer), sats, belop: rund(rund(timer) * sats), nokkel: "timelonn" });
    for (const [p, t] of overtidsliste)
      linjer.push({ lonnsart: "overtid", tekst: `Overtidstillegg ${p} %`, antall: rund(t), sats: rund4((sats * p) / 100), belop: rund((rund(t) * sats * p) / 100), nokkel: `overtid:${p}` });
  } else {
    if (rund(merarbeid) > 0) linjer.push({ lonnsart: "merarbeid", tekst: "Merarbeid", antall: rund(merarbeid), sats, belop: rund(rund(merarbeid) * sats), nokkel: "merarbeid" });
    if (rund(uten) > 0)
      linjer.push({ lonnsart: "ekstratimer", tekst: "Ekstratimer (uten overtid)", antall: rund(uten), sats, belop: rund(rund(uten) * sats), nokkel: "ekstratimer" });
    for (const [p, t] of overtidsliste)
      linjer.push({ lonnsart: "overtid", tekst: `Overtid ${p} %`, antall: rund(t), sats: rund4(sats * (1 + p / 100)), belop: rund(rund(t) * sats * (1 + p / 100)), nokkel: `overtid:${p}` });
  }
  for (const [p, t] of bankliste)
    linjer.push({
      lonnsart: "overtid",
      tekst: `Overtidstillegg ${p} % (timene er i timebanken)`,
      antall: rund(t),
      sats: rund4((sats * p) / 100),
      belop: rund((rund(t) * sats * p) / 100),
      nokkel: `overtid_timebank:${p}`,
    });
  return { linjer, timer: rund(timer), ekstraTimer: rund(merarbeid + uten + overtidsliste.reduce((s, [, t]) => s + t, 0)) };
}

// Timebanken (0073): timer tatt ut som fri (avspasering) lønnes for den med timelønn (med
// fastlønn går lønnen som vanlig), og timer betales ut fra banken med timelønnen eller timesatsen.
// Permisjon med lønn (0074) lønnes som avspasering: timene for den med timelønn.
export function timebanklinjer(a: Ansatt, avspasert: number, utbetalt: number, permisjon = 0): Linje[] {
  const sats = a.lonnstype === "time" ? Number(a.timelonn ?? 0) : timesats(a);
  const ut: Linje[] = [];
  if (a.lonnstype === "time" && rund(avspasert) > 0)
    ut.push({ lonnsart: "avspasering", tekst: "Avspasering fra timebanken", antall: rund(avspasert), sats, belop: rund(rund(avspasert) * sats), nokkel: "avspasering" });
  if (a.lonnstype === "time" && rund(permisjon) > 0)
    ut.push({ lonnsart: "permisjon", tekst: "Permisjon med lønn", antall: rund(permisjon), sats, belop: rund(rund(permisjon) * sats), nokkel: "permisjon" });
  if (rund(utbetalt) > 0)
    ut.push({ lonnsart: "timebank", tekst: "Utbetalt fra timebanken", antall: rund(utbetalt), sats, belop: rund(rund(utbetalt) * sats), nokkel: "timebank" });
  return ut;
}

// Timene en avspasering i hele dager (fra og med til og med, med timene) tar i perioden: fordelt
// på virkedagene (uten virkedager: på dagene).
export function avspasertIPerioden(x: { fra: string; til: string; timer: number }, fra: string, til: string) {
  const start = maks(x.fra, fra);
  const slutt = min(x.til, til);
  if (slutt < start) return 0;
  let alle = 0;
  let inne = 0;
  for (let d = x.fra; d <= x.til; d = pluss(d, 1))
    if (virkedag(d)) {
      alle++;
      if (d >= start && d <= slutt) inne++;
    }
  const andel = alle ? inne / alle : (dagerMellom(start, slutt) + 1) / (dagerMellom(x.fra, x.til) + 1);
  return rund(Number(x.timer) * andel);
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

// Etter arbeidsgiverperioden (og før fire uker i jobben): dagene NAV betaler sykepenger for, om
// arbeidsgiveren betaler lønnen likevel (og krever refusjon), og perioden for kjøringen.
export type EtterAgp = { dager: Set<string>; refusjon: boolean; fra: string; til: string };

// Sykepenger og omsorgspenger for den med timelønn: de planlagte timene (vakter og faste dager)
// i arbeidsgiverperioden og de ti omsorgsdagene i året. Med fastlønn går lønnen som vanlig.
//
// Etter arbeidsgiverperioden: betaler arbeidsgiveren lønnen og krever refusjon, får den med
// timelønn de planlagte timene (den sykmeldte delen); med fastlønn går lønnen som vanlig. Betaler
// NAV, trekkes fastlønnen for virkedagene (den sykmeldte delen), og timelønn betales ikke.
export function sykelinjer(a: Ansatt, dager: Sykedag[], agp: Set<string>, omsorgBrukt: number, etter: EtterAgp | null = null): { linjer: Linje[]; merknader: string[] } {
  const merknader: string[] = [];
  const andelSyk = (d: Sykedag) => (d.grad ?? 100) / 100;
  if (a.lonnstype !== "time") {
    const linjer: Linje[] = [];
    if (etter && !etter.refusjon && a.maanedslonn) {
      const syk = dager.filter((d) => d.type === "syk" && etter.dager.has(d.dato) && d.dato >= etter.fra && d.dato <= etter.til && virkedag(d.dato));
      const alle = arbeidsdager(etter.fra, etter.til);
      const andel = alle ? syk.reduce((s, d) => s + andelSyk(d), 0) / alle : 0;
      if (andel > 0)
        linjer.push({
          lonnsart: "trekk_sykdom",
          tekst: `Trekk for sykdom etter arbeidsgiverperioden (${syk.length} ${syk.length === 1 ? "virkedag" : "virkedager"}${syk.some((d) => andelSyk(d) < 1) ? ", gradert" : ""}; NAV betaler sykepengene)`,
          antall: rund4(andel),
          sats: Number(a.maanedslonn),
          belop: -rund(Number(a.maanedslonn) * andel),
          nokkel: "trekk_sykdom",
        });
    }
    return { linjer, merknader };
  }
  const sats = Number(a.timelonn ?? 0);
  const linjer: Linje[] = [];
  const syk = dager.filter((d) => d.type === "syk" && agp.has(d.dato) && d.timer > 0);
  // Gradert sykmelding: bare den sykmeldte delen av timene (resten føres som arbeidet).
  const sykTimer = rund(syk.reduce((s, d) => s + (d.timer * (d.grad ?? 100)) / 100, 0));
  const gradert = syk.some((d) => (d.grad ?? 100) < 100);
  if (sykTimer > 0)
    linjer.push({
      lonnsart: "sykepenger",
      tekst: `Sykepenger i arbeidsgiverperioden (${syk.length} ${syk.length === 1 ? "dag" : "dager"}${gradert ? ", gradert" : ""})`,
      antall: sykTimer,
      sats,
      belop: rund(sykTimer * sats),
      nokkel: "sykepenger",
    });
  if (etter?.refusjon) {
    const nav = dager.filter((d) => d.type === "syk" && etter.dager.has(d.dato) && d.timer > 0);
    const navTimer = rund(nav.reduce((s, d) => s + d.timer * andelSyk(d), 0));
    if (navTimer > 0)
      linjer.push({
        lonnsart: "sykepenger_nav",
        tekst: `Sykepenger etter arbeidsgiverperioden (${nav.length} ${nav.length === 1 ? "dag" : "dager"}${nav.some((d) => andelSyk(d) < 1) ? ", gradert" : ""}; refusjon fra NAV)`,
        antall: navTimer,
        sats,
        belop: rund(navTimer * sats),
        nokkel: "sykepenger_nav",
      });
  }
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
  naturalytelser: number; // trekkpliktige, utbetales ikke (0083)
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
  // AFP og OU (0098): grunnlaget (den avgiftspliktige kontantlønnen), AFP-premien og OU-premien som
  // avsettes.
  afp_grunnlag: number;
  afp: number;
  ou: number;
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
  // AFP (0098): grunnlaget i år før denne kjøringen, og andelen av en heltidsansatt måned for
  // OU-premien (stillingsprosenten ganger dagene den ansatte er ansatt; 0 i ekstra kjøringer).
  afpGrunnlagFor?: number;
  ouAndel?: number;
  // Lønn etter dødsfall (0099): slippen utbetales etter dødsdatoen, til dødsboet.
  etterDodsfall?: boolean;
};

// Fagforeningskontingenten som trekkes i lønnen, reduserer grunnlaget for forskuddstrekket med
// en forholdsmessig del av det årlige fradraget ved hver ordinære lønnsutbetaling (en tolvdel;
// skattebetalingshåndboken § 5-9). Det årlige fradraget fastsettes hvert år (2026: 8 700 kr).
export const fagforeningsfradrag = (aar: number) => (aar >= 2026 ? 8700 : 7700);

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
  let prosentdel = 0; // trekkes etter prosentsatsen med tabellkort (lønnsartene med prosenttrekk)
  let fradrag = 0; // fagforeningskontingent trukket i lønnen (positiv)
  let natural = 0; // naturalytelser (0083)
  let kontant = 0; // den avgiftspliktige kontantlønnen, grunnlaget for AFP (0098)
  for (const l of aktive) {
    const art = lonnsart(l.lonnsart);
    const b = Number(l.belop);
    if (art.type === "utgift") utgifter += b;
    else if (art.type === "trekk") trekkEtter += b;
    else if (art.type === "natural") natural += b;
    else brutto += b;
    // Trekkpliktig: lønnen, naturalytelsene og den trekkpliktige delen av reisegodtgjørelsen.
    if (art.type !== "trekk" && art.trekk) trekkpliktig += b;
    if (art.ferie) ferie += b;
    if (art.otp) otpGrunnlag += b;
    if (art.aga) agaGrunnlag += b;
    if (l.lonnsart === "feriepenger" && l.opptjeningsaar != null && l.opptjeningsaar < t.aar) unntatt += b;
    if (art.prosenttrekk && art.trekk) prosentdel += b;
    if (afpLonn(l.lonnsart)) kontant += b;
    if (art.fradrag) fradrag -= b;
  }
  brutto = rund(brutto);
  trekkpliktig = rund(trekkpliktig);

  // Skattetrekket. Fagforeningskontingenten trekkes fra grunnlaget (ikke i ekstra kjøringer).
  const a = t.ansatt;
  const minus = t.ekstra ? 0 : rund(Math.max(0, Math.min(fradrag, fagforeningsfradrag(t.aar) / 12)));
  const prosent = (p: number, g: number) => Math.max(0, Math.floor((g * p) / 100));
  let trekk = 0;
  let metode = "";
  let grunnlag = rund(Math.max(0, trekkpliktig - minus));
  const dod = !!t.etterDodsfall;
  if (dod) {
    // Lønn etter dødsfall (0099): opptjent før dødsfallet og utbetalt til dødsboet, uten
    // forskuddstrekk og arbeidsgiveravgift (a-meldingen: loennEtterDoedsfall).
    grunnlag = 0;
    metode = "Ikke forskuddstrekk (lønn etter dødsfall)";
    merknader.push(
      `Utbetalt etter dødsfallet${a.dodsdato ? ` ${a.dodsdato.split("-").reverse().join(".")}` : ""}: lønn etter dødsfall til dødsboet, uten forskuddstrekk og arbeidsgiveravgift. Kontonummeret på den ansatte skal være dødsboets.`,
    );
  } else if (!a.skattekort) {
    trekk = prosent(UTEN_SKATTEKORT, grunnlag);
    metode = `Uten skattekort (${UTEN_SKATTEKORT} %)`;
    if (trekkpliktig > 0) merknader.push(`Mangler skattekort: det trekkes ${UTEN_SKATTEKORT} %. Registrer skattekortet på den ansatte.`);
  } else if (a.skattekort === "prosent") {
    trekk = prosent(Number(a.skatt_prosent), grunnlag);
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
      grunnlag = rund(Math.max(0, trekkpliktig - unntatt - prosentdel - minus));
      // Tabelltrekk av lønnen for perioden, og prosentsatsen av ytelsene med prosenttrekk (tillegget
      // for den ekstra ferieuka, honorar og styrehonorar). Grunnlaget som vises, er begge delene.
      if (grunnlag > 0 || !prosentdel) {
        if (t.tabell) {
          const oppslag = tabelloppslag(t.tabell, Math.max(0, grunnlag));
          trekk = oppslag.trekk;
          if (oppslag.over) merknader.push(`Lønnen er over den høyeste raden i tabell ${a.skatt_tabell}; trekket er regnet videre med satsen øverst i tabellen. Kontroller trekket.`);
        } else {
          trekk = prosent(p, grunnlag);
          merknader.push(`Trekktabellene for ${t.aar} er ikke lastet inn ennå: trekket er regnet med prosentsatsen på skattekortet (${tall(p)} %). Kontroller trekket mot tabell ${a.skatt_tabell}.`);
        }
        if (t.halvSkatt) trekk = Math.floor(trekk / 2);
      }
      trekk += prosent(p, prosentdel);
      metode = `Tabell ${a.skatt_tabell}${t.halvSkatt ? " (halv skatt)" : ""}`;
      if (prosentdel > 0) metode = grunnlag > 0 ? `${metode} og prosenttrekk ${tall(p)} %` : `Prosenttrekk ${tall(p)} % (tabellkort)`;
      grunnlag = rund(grunnlag + prosentdel);
    }
    if (unntatt > 0 && !t.ekstra) merknader.push("Det trekkes ikke skatt av feriepengene (tabelltrekk).");
  }
  if (!dod && a.skattekort && a.skattekort_aar && a.skattekort_aar !== t.aar) merknader.push(`Skattekortet er for ${a.skattekort_aar}, ikke ${t.aar}. Hent det nye skattekortet.`);
  if (!dod && a.skattekort_resultat === "vurderArbeidstillatelse")
    merknader.push("Skatteetaten ber arbeidsgiveren vurdere om den ansatte har arbeidstillatelse (gjelder ofte utenlandske arbeidstakere).");
  if (!dod) for (const x of a.skattekort_tillegg ?? []) if (TILLEGGSOPPLYSNINGER[x] && trekkpliktig > 0) merknader.push(TILLEGGSOPPLYSNINGER[x]);
  if (manueltTrekk != null) {
    trekk = manueltTrekk;
    metode = `${metode} – endret for hånd`;
  }

  const feriepengegrunnlag = rund(ferie);
  const otpProsent = Number(o.otp_prosent);
  const otpTak = (12 * grunnbelop(dato)) / 12;
  // OTP for dem som er med i ordningen når lønnen utbetales (0097).
  const m = otpMedlem(a, !!o.otp_unntak_75, dato);
  if (!dod && otpProsent > 0 && otpGrunnlag > 0 && !m.medlem && !erFrilanser(a)) merknader.push(`Ikke med i OTP: ${m.grunn}.`);
  const otp = !dod && otpProsent > 0 && m.medlem ? rund((Math.max(0, Math.min(otpGrunnlag, otpTak)) * otpProsent) / 100) : 0;
  // AFP og OU (0098): ikke for frilansere og oppdragstakere (og ikke etter dødsfallet).
  const iAfp = !!o.afp && !erFrilanser(a) && !dod;
  const afpGrunnlag = iAfp && afpAlder(a.fodselsdato, t.aar) ? rund(kontant) : 0;
  const afp = iAfp && afpGrunnlag ? afpPremie(Number(o.afp_sats ?? 0), t.aar, Number(t.afpGrunnlagFor ?? 0), afpGrunnlag) : 0;
  const ou = iAfp ? rund(Number(o.ou_premie ?? 0) * Number(t.ouAndel ?? 0)) : 0;
  const netto = rund(brutto - trekk + utgifter + trekkEtter);
  if (netto < 0) merknader.push("Nettolønnen er negativ. Sjekk trekkene.");
  return {
    brutto,
    naturalytelser: rund(natural),
    trekkpliktig: dod ? 0 : trekkpliktig,
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
    afp_grunnlag: afpGrunnlag,
    afp,
    ou,
    // Arbeidsgiveravgift også av OTP-premien (AFP-premien: når den betales, afpPremier.ts); ikke
    // av lønn etter dødsfall.
    aga_grunnlag: dod ? 0 : rund(agaGrunnlag + otp),
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
