// Norske helligdager: de offentlige høytidsdagene (helligdagsloven) og 1. og 17. mai, med
// påsken etter den gregorianske kalenderen. Samme dager som server/src/helligdager.ts og
// faktura.helligdager i databasen; kalenderne (bemanningskalenderen, vaktplanen, timene og
// tavla) viser dem, og en fast arbeidsdag gjelder ikke på en helligdag.

// Første påskedag (algoritmen til Meeus/Jones/Butcher).
export function paaskedag(aar: number): string {
  const a = aar % 19;
  const b = Math.floor(aar / 100);
  const c = aar % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const maaned = Math.floor((h + l - 7 * m + 114) / 31);
  const dag = ((h + l - 7 * m + 114) % 31) + 1;
  return `${aar}-${String(maaned).padStart(2, "0")}-${String(dag).padStart(2, "0")}`;
}

const pluss = (iso: string, n: number) => new Date(Date.parse(`${iso}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const huske = new Map<number, Map<string, string>>();

// Helligdagene i året: dato → navn.
export function helligdager(aar: number): Map<string, string> {
  const funnet = huske.get(aar);
  if (funnet) return funnet;
  const p = paaskedag(aar);
  const dager = new Map<string, string>();
  // Faller to på samme dag (f.eks. 17. mai og Kristi himmelfartsdag), får dagen begge navnene.
  for (const [dato, navn] of [
    [`${aar}-01-01`, "1. nyttårsdag"],
    [pluss(p, -3), "Skjærtorsdag"],
    [pluss(p, -2), "Langfredag"],
    [p, "1. påskedag"],
    [pluss(p, 1), "2. påskedag"],
    [`${aar}-05-01`, "Arbeidernes dag"],
    [`${aar}-05-17`, "Grunnlovsdag"],
    [pluss(p, 39), "Kristi himmelfartsdag"],
    [pluss(p, 49), "1. pinsedag"],
    [pluss(p, 50), "2. pinsedag"],
    [`${aar}-12-25`, "1. juledag"],
    [`${aar}-12-26`, "2. juledag"],
  ] as const)
    dager.set(dato, dager.has(dato) ? `${dager.get(dato)} og ${navn}` : navn);
  huske.set(aar, dager);
  return dager;
}

// Navnet på helligdagen, eller null.
export const helligdag = (iso: string): string | null => helligdager(Number(iso.slice(0, 4))).get(iso) ?? null;
