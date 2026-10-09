// Lønns- og stillingsendringer med virkningsdato (0080_lonnsendringer.sql): det som gjelder for en
// ansatt en dag, fastlønnen delt når lønnen endres i måneden, og etterbetalingen (eller trekket)
// når en endring gjelder tilbake i tid.
//
// Etterbetalingen for en måned med en godkjent kjøring er forskjellen mellom det lønnen blir med
// endringene som gjelder nå, og det den ble med endringene som var kjent da kjøringen ble godkjent,
// minus det som alt er etterbetalt for måneden i andre kjøringer. Fastlønnen regnes på nytt;
// timelønnen for timene som ble lønnet i kjøringen (med satsen på hver dag); overtid og merarbeid
// med satsen ved månedsslutt. Kjøringer godkjent før lønnshistorikken kom (ingen endringer kjent
// da), får en merknad i stedet.
import { en, somSystem } from "./db.js";
import { arbeidsdager, fastlonn, periodeSlutt, pluss, rund, timesats, type Ansatt, type Linje } from "./lonnsberegning.js";

// Hver morgen (workeren): endringer som gjelder fra i dag (eller de siste dagene), tas i bruk på de ansatte.
export async function aktiverLonnsendringer(): Promise<number> {
  return Number((await somSystem((db) => en<{ n: number }>(db, "select faktura.aktiver_lonnsendringer() as n")))?.n ?? 0);
}

export type Lonnsendring = {
  id: string;
  ansatt_id: string;
  gjelder_fra: string;
  lonnstype: "maaned" | "time" | null;
  maanedslonn: number | null;
  timelonn: number | null;
  stillingsprosent: number | null;
  opprettet: number; // ms
  slettet: number | null; // ms
};

const MND = ["januar", "februar", "mars", "april", "mai", "juni", "juli", "august", "september", "oktober", "november", "desember"];
const maanedNavn = (periode: string) => `${MND[Number(periode.slice(5, 7)) - 1]} ${periode.slice(0, 4)}`;
const visDato = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}.`;
const maks = (a: string, b: string) => (a > b ? a : b);
const min = (a: string, b: string) => (a < b ? a : b);

// Endringene slik de var kjent på et tidspunkt (ms), eller de gjeldende (uten tidspunkt), i datoorden.
export function kjent(rader: Lonnsendring[], naar?: number | null): Lonnsendring[] {
  return rader
    .filter((r) => (naar == null ? r.slettet == null : r.opprettet <= naar && (r.slettet == null || r.slettet > naar)))
    .sort((x, y) => x.gjelder_fra.localeCompare(y.gjelder_fra));
}

// Det som gjelder for den ansatte en dag, felt for felt (før den første endringen: den første).
export function gjeldende(a: Ansatt, rader: Lonnsendring[], dato: string): Ansatt {
  if (!rader.length) return a;
  const forste = rader[0]!.gjelder_fra;
  const med = rader.filter((r) => r.gjelder_fra <= dato || r.gjelder_fra === forste);
  function siste<K extends "lonnstype" | "maanedslonn" | "timelonn" | "stillingsprosent">(felt: K): Lonnsendring[K] | null {
    for (let i = med.length - 1; i >= 0; i--) if (med[i]![felt] != null) return med[i]![felt];
    return null;
  }
  return {
    ...a,
    lonnstype: siste("lonnstype") ?? a.lonnstype,
    maanedslonn: siste("maanedslonn") ?? a.maanedslonn,
    timelonn: siste("timelonn") ?? a.timelonn,
    stillingsprosent: siste("stillingsprosent") ?? a.stillingsprosent,
  };
}

// Fastlønnen for perioden: én linje, eller én for hver del av måneden med sin lønn (andelen av
// arbeidsdagene).
export function fastlonnLinjer(a: Ansatt, rader: Lonnsendring[], fra: string, til: string): Linje[] {
  const datoer = [...new Set(rader.map((r) => r.gjelder_fra).filter((d) => d > fra && d <= til))].sort();
  const deler: { fra: string; til: string; a: Ansatt }[] = [];
  [fra, ...datoer].forEach((start, i, liste) => {
    const x = gjeldende(a, rader, start);
    const slutt = i + 1 < liste.length ? pluss(liste[i + 1]!, -1) : til;
    const forrige = deler.at(-1);
    if (forrige && forrige.a.lonnstype === x.lonnstype && Number(forrige.a.maanedslonn ?? 0) === Number(x.maanedslonn ?? 0)) forrige.til = slutt;
    else deler.push({ fra: start, til: slutt, a: x });
  });
  if (deler.length === 1) {
    const f = fastlonn(deler[0]!.a, fra, til);
    return f ? [f] : [];
  }
  const alle = arbeidsdager(fra, til);
  const linjer: Linje[] = [];
  for (const d of deler) {
    if (d.a.lonnstype !== "maaned" || !d.a.maanedslonn || !alle) continue;
    const start = maks(d.fra, a.ansatt_fra);
    const slutt = a.ansatt_til ? min(d.til, a.ansatt_til) : d.til;
    if (slutt < start) continue;
    const dager = arbeidsdager(start, slutt);
    if (!dager) continue;
    const andel = dager / alle;
    linjer.push({
      lonnsart: "fastlonn",
      tekst: `Fastlønn ${visDato(start)}–${visDato(slutt)} (${dager} av ${alle} arbeidsdager)`,
      antall: Math.round(andel * 10000) / 10000,
      sats: Number(d.a.maanedslonn),
      belop: rund(Number(d.a.maanedslonn) * andel),
      nokkel: linjer.length ? `fastlonn:${d.fra}` : "fastlonn",
    });
  }
  return linjer;
}

// Datoen som gir lønnen for timene i en uke (mandag): periodens første dag når uka begynner før
// den, ellers mandagen. (En endring midt i en uke gjelder timene fra uka etter.)
export const ukeDato = (mandag: string, fra: string) => (mandag < fra && pluss(mandag, 6) >= fra ? fra : mandag);

// Endringene i perioden som merknad, f.eks. «Lønnen er endret fra 15.10.2026: 45 000 kr i måneden».
export function endringstekster(a: Ansatt, rader: Lonnsendring[], fra: string, til: string): string[] {
  const kr = (n: number) => `${n.toLocaleString("nb-NO", { maximumFractionDigits: 2 }).replace(/[\u00a0\u202f]/g, " ")} kr`;
  const ut: string[] = [];
  const forste = rader[0]?.gjelder_fra;
  for (const r of rader.filter((x) => x.gjelder_fra >= fra && x.gjelder_fra <= til && x.gjelder_fra !== forste)) {
    const deler: string[] = [];
    if (r.lonnstype) deler.push(r.lonnstype === "maaned" ? "fastlønn" : "timelønn");
    if (r.maanedslonn != null) deler.push(`${kr(Number(r.maanedslonn))} i måneden`);
    if (r.timelonn != null) deler.push(`${kr(Number(r.timelonn))} i timen`);
    if (r.stillingsprosent != null) deler.push(`${String(Number(r.stillingsprosent)).replace(".", ",")} % stilling`);
    ut.push(`Lønnen eller stillingen er endret fra ${r.gjelder_fra.split("-").reverse().join(".")}: ${deler.join(", ")}.`);
  }
  return ut;
}

// --- Etterbetalingen ---------------------------------------------------------------------------

export type GodkjentKjoring = {
  id: string;
  periode: string; // første dag i måneden
  godkjent: number; // ms
  // Den ansattes timer som ble lønnet i kjøringen, og overtid, merarbeid og ekstratimer (de automatiske linjene).
  timer: { dato: string; timer: number }[];
  // tillegg: bare overtidstillegget er betalt (timelønn, og timer i timebanken); ellers timesatsen med tillegget.
  overtid: { prosent: number; antall: number; tillegg: boolean }[];
  merarbeid: number;
};
export type Etterbetalt = { kjoring_id: string; lonnsart: string; opptjent_fra: string; belop: number };

const ART = { fast: "etterbetaling", time: "etterbetaling_time", overtid: "etterbetaling_overtid" } as const;
const TEKST = { fast: "fastlønn", time: "timelønn", overtid: "overtid" } as const;

// Lønnen for måneden etter endringene: fastlønnen, timelønnen for timene og overtid og merarbeid.
function lonnFor(a: Ansatt, rader: Lonnsendring[], k: GodkjentKjoring) {
  const slutt = periodeSlutt(k.periode);
  const fast = fastlonnLinjer(a, rader, k.periode, slutt).reduce((s, l) => s + l.belop, 0);
  let time = 0;
  for (const t of k.timer) {
    const x = gjeldende(a, rader, t.dato);
    if (x.lonnstype === "time") time += t.timer * Number(x.timelonn ?? 0);
  }
  const x = gjeldende(a, rader, slutt);
  const sats = x.lonnstype === "time" ? Number(x.timelonn ?? 0) : timesats(x);
  if (x.lonnstype !== "time") time += k.merarbeid * sats;
  let overtid = 0;
  for (const o of k.overtid) overtid += o.antall * sats * (o.tillegg ? o.prosent / 100 : 1 + o.prosent / 100);
  return { fast, time, overtid };
}

// Etterbetalingen (eller trekket) for tidligere måneder: linjene, og merknadene for måneder det
// ikke kan regnes for.
export function etterbetaling(a: Ansatt, rader: Lonnsendring[], kjoringer: GodkjentKjoring[], etterbetalt: Etterbetalt[]): { linjer: Linje[]; merknader: string[] } {
  const linjer: Linje[] = [];
  const merknader: string[] = [];
  const naa = kjent(rader);
  for (const k of [...kjoringer].sort((x, y) => x.periode.localeCompare(y.periode))) {
    const slutt = periodeSlutt(k.periode);
    if (slutt < a.ansatt_fra || (a.ansatt_til && k.periode > a.ansatt_til)) continue;
    // Endret etter at kjøringen ble godkjent, og gjelder måneden?
    const endret = rader.filter((r) => (r.opprettet > k.godkjent || (r.slettet != null && r.slettet > k.godkjent)) && r.gjelder_fra <= slutt);
    if (!endret.length) continue;
    const da = kjent(rader, k.godkjent);
    if (!da.length) {
      // Den første raden (lønnen fra før lønnshistorikken) er ingen endring.
      if (!endret.some((r) => r.gjelder_fra !== naa[0]?.gjelder_fra)) continue;
      merknader.push(
        `Lønnen er endret med virkning for ${maanedNavn(k.periode)}, som ble godkjent før lønnshistorikken kom. Legg til etterbetalingen for den måneden for hånd.`,
      );
      continue;
    }
    const ny = lonnFor(a, naa, k);
    const gammel = lonnFor(a, da, k);
    for (const del of ["fast", "time", "overtid"] as const) {
      const alt = etterbetalt.filter((e) => e.lonnsart === ART[del] && e.opptjent_fra >= k.periode && e.opptjent_fra <= slutt).reduce((s, e) => s + e.belop, 0);
      const belop = rund(ny[del] - gammel[del] - alt);
      if (Math.abs(belop) < 0.01) continue;
      linjer.push({
        lonnsart: ART[del],
        tekst: belop > 0 ? `Etterbetaling ${TEKST[del]} for ${maanedNavn(k.periode)}` : `Trekk for for mye ${TEKST[del]} i ${maanedNavn(k.periode)}`,
        antall: null,
        sats: null,
        belop,
        nokkel: `${ART[del]}:${k.periode.slice(0, 7)}`,
        opptjent_fra: k.periode,
        opptjent_til: slutt,
      });
    }
  }
  return { linjer, merknader };
}
