// Permisjoner og permittering (0084_permisjon_permittering.sql): artene med beskrivelsen i
// a-meldingen, lønnsplikten ved permittering, hvilke som skal rapporteres, og trekket i lønnen.
//
// Permisjon uten lønn: fastlønnen trekkes for arbeidsdagene (mandag–fredag) i permisjonen, med
// andelen av stillingen. Permittering: arbeidsgiveren betaler lønnen i lønnspliktperioden (normalt
// de 15 første arbeidsdagene, lagt inn på permitteringen); deretter trekkes fastlønnen for den
// permitterte delen. Med timelønn lønnes de planlagte timene (vakter og faste dager) i
// lønnspliktperioden; ellers lønnes bare timene som føres. Permisjon med lønn: lønnen går som
// vanlig (timelønn: timene på fraværet, server/src/lonnsberegning.ts).
//
// A-meldingen: permisjon over 14 dager (med og uten lønn, hel eller delvis) og all permittering
// rapporteres hver måned fra startmåneden til og med sluttmåneden, med id-en (den samme hver
// måned), startdatoen, prosenten, beskrivelsen og sluttdatoen når den er kjent. Elementet
// <permittering> i format 2.3 er utsatt på ubestemt tid, så permitteringen rapporteres som
// permisjon med beskrivelsen «permittering».

import { gjeldende, type Lonnsendring } from "./lonnsendringer.js";
import { pluss, rund, virkedag, type Ansatt, type Linje } from "./lonnsberegning.js";

export type PermisjonsArt = "annen" | "lovfestet" | "foreldre" | "utdanning_lovfestet" | "utdanning" | "militaer" | "permittering";

// navn: det som vises på fraværet; valg: teksten i listen; amelding: beskrivelsen i a-meldingen;
// trekk: teksten på trekket i lønnen.
export const PERMISJONSARTER: Record<PermisjonsArt, { navn: string; valg: string; amelding: string; trekk: string }> = {
  annen: { navn: "Permisjon", valg: "Annen permisjon (ikke lovfestet, f.eks. velferdspermisjon)", amelding: "andreIkkeLovfestedePermisjoner", trekk: "Trekk for permisjon uten lønn" },
  lovfestet: {
    navn: "Lovfestet permisjon",
    valg: "Annen lovfestet permisjon (omsorgspermisjon, pleiepenger, utvidet foreldrepermisjon)",
    amelding: "andreLovfestedePermisjoner",
    trekk: "Trekk for lovfestet permisjon",
  },
  foreldre: { navn: "Foreldrepermisjon", valg: "Foreldrepermisjon (med foreldrepenger)", amelding: "permisjonMedForeldrepenger", trekk: "Trekk for foreldrepermisjon" },
  utdanning_lovfestet: { navn: "Utdanningspermisjon", valg: "Utdanningspermisjon (lovfestet)", amelding: "utdanningspermisjonLovfestet", trekk: "Trekk for utdanningspermisjon" },
  utdanning: { navn: "Utdanningspermisjon", valg: "Utdanningspermisjon (ikke lovfestet)", amelding: "utdanningspermisjonIkkeLovfestet", trekk: "Trekk for utdanningspermisjon" },
  militaer: { navn: "Militærtjeneste", valg: "Militærtjeneste, sivilforsvar eller heimevern", amelding: "permisjonVedMilitaertjeneste", trekk: "Trekk for militærtjeneste" },
  permittering: { navn: "Permittering", valg: "Permittering", amelding: "permittering", trekk: "Trekk for permittering" },
};
export const ARTER = Object.keys(PERMISJONSARTER) as [PermisjonsArt, ...PermisjonsArt[]];

// Navnet på en permisjon: arten, eller «Permisjon med lønn» / «Permisjon».
export const permisjonNavn = (art: string | null | undefined, betalt?: boolean | null) =>
  art && art in PERMISJONSARTER && art !== "annen" ? PERMISJONSARTER[art as PermisjonsArt].navn : betalt ? "Permisjon med lønn" : "Permisjon";

// Lønnsplikten ved permittering: normalt de 15 første arbeidsdagene (permitteringslønnsloven).
// Arbeidsdagene er virkedagene (ikke helg og helligdager).
export const LONNSPLIKT_DAGER = 15;
export function lonnspliktSlutt(fra: string, dager = LONNSPLIKT_DAGER): string | null {
  if (dager <= 0) return null;
  let n = 0;
  let d = fra;
  for (let i = 0; i < 400; i++, d = pluss(d, 1)) if (virkedag(d) && ++n === dager) return d;
  return d;
}

const dagerI = (fra: string, til: string) => Math.round((Date.parse(`${til}T12:00:00Z`) - Date.parse(`${fra}T12:00:00Z`)) / 86_400_000) + 1;

// Skal permisjonen med i a-meldingen? Permittering alltid; permisjon når den varer over 14 dager.
export const rapporteres = (p: { art: string | null; fra: string; til: string }) => p.art === "permittering" || dagerI(p.fra, p.til) > 14;

// Sluttdatoen i a-meldingen for måneden: når den er kjent, og ellers i måneden permisjonen slutter.
export const sluttdatoKjent = (p: { til: string; slutt_ukjent: boolean }, sisteIMnd: string) => !p.slutt_ukjent || p.til <= sisteIMnd;

// --- Lønnen -----------------------------------------------------------------------------------

export type Permisjon = {
  id: string;
  ansatt_id: string;
  fra: string;
  til: string;
  art: PermisjonsArt | null;
  prosent: number; // 1–100
  lonnsplikt_til: string | null;
};

const rund4 = (n: number) => Math.round((n + Number.EPSILON) * 10000) / 10000;
const ukedag = (d: string) => new Date(`${d}T12:00:00Z`).getUTCDay();
const hverdag = (d: string) => ukedag(d) !== 0 && ukedag(d) !== 6;
const visDato = (d: string) => d.split("-").reverse().join(".");
const flertall = (n: number, en: string, flere: string) => `${n} ${n === 1 ? en : flere}`;

// Trekket for permisjon uten lønn og permittering etter lønnsplikten (fastlønn: månedslønnen den
// dagen ganger prosenten, delt på arbeidsdagene i måneden), og lønnen for de planlagte timene i
// lønnspliktperioden (timelønn). planlagt: de planlagte timene en dag (vakter og faste dager).
export function permisjonslinjer(
  a: Ansatt,
  historie: Lonnsendring[],
  liste: Permisjon[],
  fra: string,
  til: string,
  planlagt: (dato: string) => number,
): { linjer: Linje[]; merknader: string[] } {
  const linjer: Linje[] = [];
  const merknader: string[] = [];
  let alle = 0;
  for (let d = fra; d <= til; d = pluss(d, 1)) if (hverdag(d)) alle++;
  if (!alle) return { linjer, merknader };
  for (const p of [...liste].sort((x, y) => x.fra.localeCompare(y.fra))) {
    const start = [p.fra, fra, a.ansatt_fra].reduce((x, y) => (x > y ? x : y));
    const slutt = [p.til, til, a.ansatt_til ?? til].reduce((x, y) => (x < y ? x : y));
    if (slutt < start) continue;
    const andel = p.prosent / 100;
    const permittering = p.art === "permittering";
    let dager = 0;
    let trekk = 0;
    const satser = new Set<number>();
    let pliktDager = 0; // virkedagene i lønnsplikten (timelønn)
    let pliktPlanlagt = 0; // dagene med planlagte timer
    let pliktTimer = 0;
    let pliktBelop = 0;
    const timesatser = new Set<number>();
    for (let d = start; d <= slutt; d = pluss(d, 1)) {
      const x = gjeldende(a, historie, d);
      if (permittering && p.lonnsplikt_til && d <= p.lonnsplikt_til) {
        // Lønnsplikten: fastlønnen går som vanlig; med timelønn lønnes den permitterte delen av de
        // planlagte timene (også vakter i helgene).
        if (x.lonnstype === "time") {
          if (virkedag(d)) pliktDager++;
          const t = planlagt(d) * andel;
          if (t > 0) {
            pliktPlanlagt++;
            pliktTimer += t;
            pliktBelop += t * Number(x.timelonn ?? 0);
            timesatser.add(Number(x.timelonn ?? 0));
          }
        }
        continue;
      }
      if (!hverdag(d) || x.lonnstype !== "maaned" || !x.maanedslonn) continue;
      dager++;
      trekk += (Number(x.maanedslonn) * andel) / alle;
      satser.add(Number(x.maanedslonn));
    }
    const del = p.prosent < 100 ? `, ${p.prosent} %` : "";
    if (dager && trekk > 0)
      linjer.push({
        lonnsart: permittering ? "trekk_permittering" : "trekk_permisjon",
        tekst: `${permittering ? (p.lonnsplikt_til ? "Trekk for permittering etter lønnsplikten" : "Trekk for permittering") : PERMISJONSARTER[p.art ?? "annen"].trekk} (${flertall(dager, "arbeidsdag", "arbeidsdager")}${del})`,
        antall: rund4((dager * andel) / alle),
        sats: satser.size === 1 ? [...satser][0]! : null,
        belop: -rund(trekk),
        nokkel: `permisjon:${p.id}`,
      });
    const timer = rund(pliktTimer);
    if (timer > 0)
      linjer.push({
        lonnsart: "lonnsplikt",
        tekst: `Lønn i lønnspliktperioden ved permittering (${flertall(pliktPlanlagt, "dag", "dager")}${del})`,
        antall: timer,
        sats: timesatser.size === 1 ? [...timesatser][0]! : null,
        belop: rund(pliktBelop),
        nokkel: `lonnsplikt:${p.id}`,
      });
    else if (pliktDager)
      merknader.push(`Permittert i lønnspliktperioden (${flertall(pliktDager, "virkedag", "virkedager")}) uten planlagte timer: legg inn lønnen for lønnspliktdagene for hånd.`);
    if (permittering && p.fra >= fra && p.fra <= til)
      merknader.push(
        `Permittert fra ${visDato(p.fra)} (${p.prosent} %)${p.lonnsplikt_til ? `: lønnsplikt til og med ${visDato(p.lonnsplikt_til)}, deretter trekkes lønnen` : ": uten lønnsplikt, lønnen trekkes fra første dag"}. Den ansatte kan søke dagpenger fra NAV.`,
      );
  }
  return { linjer, merknader };
}
