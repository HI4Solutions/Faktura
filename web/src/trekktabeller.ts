// Skatteetatens trekktabeller i tekstformat (lastes inn av plattformadministratoren under
// Administrasjon → Drift; lønnskjøringen bruker dem til tabelltrekket, server/src/lonn.ts). Fila
// (én for alle tabellene, ofte i en zip-fil) har én rad per tabell, periode og trekkgrunnlag,
// 18 siffer: tabellnummeret (4), trekkperioden (1; 1 = måned), tabelltypen (1; 0 = lønn),
// trekkgrunnlaget (6) og trekket (6). Bare månedstabellene for lønn tas med.
import { lesZip } from "./importer";

export type Trekkrad = [tabell: number, grunnlag: number, trekk: number];

const erZip = (b: Uint8Array) => b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;

// Teksten i fila (eller i tekstfila i zip-fila; den største om det er flere).
async function tekstFra(b: Uint8Array): Promise<string> {
  if (!erZip(b)) return new TextDecoder("latin1").decode(b);
  let filer: Map<string, () => Promise<Uint8Array>>;
  try {
    filer = lesZip(b);
  } catch {
    throw new Error("Zip-fila er skadet.");
  }
  let best: Uint8Array | null = null;
  for (const [navn, hent] of filer) {
    if (navn.endsWith("/")) continue;
    const data = await hent();
    if (!best || data.length > best.length) best = data;
  }
  if (!best) throw new Error("Zip-fila er tom.");
  return new TextDecoder("latin1").decode(best);
}

// Radene for lønn per måned. Rader med skilletegn (fem tall) godtas også.
export function lesTrekktabeller(tekst: string): { rader: Trekkrad[]; tabeller: number; hoppetOver: number } {
  const rader: Trekkrad[] = [];
  const tabeller = new Set<number>();
  let hoppetOver = 0;
  for (const linje of tekst.split(/\r?\n/)) {
    const l = linje.trim();
    if (!l) continue;
    let felt: string[] | null = null;
    if (/^\d{18}$/.test(l)) felt = [l.slice(0, 4), l.slice(4, 5), l.slice(5, 6), l.slice(6, 12), l.slice(12, 18)];
    else {
      const deler = l.split(/[\s;,]+/);
      if (deler.length === 5 && deler.every((d) => /^\d+$/.test(d))) felt = deler;
    }
    if (!felt) {
      hoppetOver++;
      continue;
    }
    const [tabell, periode, type, grunnlag, trekk] = felt.map(Number) as [number, number, number, number, number];
    if (periode !== 1 || type !== 0) continue;
    rader.push([tabell, grunnlag, trekk]);
    tabeller.add(tabell);
  }
  return { rader, tabeller: tabeller.size, hoppetOver };
}

export async function lesTrekktabellFil(fil: File) {
  const b = new Uint8Array(await fil.arrayBuffer());
  return lesTrekktabeller(await tekstFra(b));
}

// Året i filnavnet (f.eks. «trekktabeller_2026.zip»), ellers inneværende år.
export const aarFraFilnavn = (navn: string, iAar: number) => {
  const m = /(?:^|\D)(20\d\d)(?:\D|$)/.exec(navn);
  return m ? Number(m[1]) : iAar;
};
