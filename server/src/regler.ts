// Rene regler som også brukes i PDF og e-post. Summene regnes i databasen
// (faktura.utsted); her regnes de bare for forhåndsvisning av utkast, på samme måte.

export interface Linje {
  beskrivelse: string;
  antall: number;
  enhet?: string;
  enhetspris: number;
  mva_sats: number;
  rabatt_prosent?: number | null; // av linjebeløpet
  rabatt_belop?: number | null; // kroner for hele linjen
}

// Runder halv opp til øre som Postgres' round(numeric, 2), også for f.eks. 1.005.
const rund = (n: number) => Math.sign(n) * Number(Math.round(Number(`${Math.abs(n)}e2`)) + "e-2");

// Rabatten i kroner på linjen (som faktura.linje_netto i databasen).
export function linjerabatt(l: Linje) {
  if (l.rabatt_belop != null) return Number(l.rabatt_belop);
  if (l.rabatt_prosent != null) return rund((l.antall * l.enhetspris * Number(l.rabatt_prosent)) / 100);
  return 0;
}

export function linjebelop(l: Linje) {
  const netto = l.antall * l.enhetspris - linjerabatt(l);
  return { eks: rund(netto), mva: rund((netto * l.mva_sats) / 100) };
}

export function summer(linjer: Linje[]) {
  let eks = 0;
  let mva = 0;
  for (const l of linjer) {
    const b = linjebelop(l);
    eks += b.eks;
    mva += b.mva;
  }
  eks = rund(eks);
  mva = rund(mva);
  return { eks, mva, inkl: rund(eks + mva) };
}

// «1 008,75» med vanlig mellomrom og bindestrek som minus, så standardfontene i PDF klarer det.
export function kr(n: number): string {
  return new Intl.NumberFormat("nb-NO", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    .format(n)
    .replace(/[  ]/g, " ")
    .replace(/−/g, "-");
}

export function dato(iso: string | null | undefined): string {
  if (!iso) return "";
  const [a, m, d] = iso.slice(0, 10).split("-");
  return `${d}.${m}.${a}`;
}

export function orgnr(n: string | null | undefined): string {
  if (!n) return "";
  return n.replace(/^(\d{3})(\d{3})(\d{3})$/, "$1 $2 $3");
}

export function kontonr(n: string | null | undefined): string {
  if (!n) return "";
  return n.replace(/^(\d{4})(\d{2})(\d{5})$/, "$1.$2.$3");
}

export function orgnrGyldig(n: string): boolean {
  if (!/^\d{9}$/.test(n)) return false;
  const v = [3, 2, 7, 6, 5, 4, 3, 2];
  const sum = v.reduce((s, x, i) => s + x * Number(n[i]), 0);
  let rest = 11 - (sum % 11);
  if (rest === 11) rest = 0;
  return rest !== 10 && rest === Number(n[8]);
}

// Kontonummer (11 siffer, kontrollsiffer etter modulus 11).
export function kontonrGyldig(n: string): boolean {
  if (!/^\d{11}$/.test(n)) return false;
  const v = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const sum = v.reduce((s, x, i) => s + x * Number(n[i]), 0);
  let rest = 11 - (sum % 11);
  if (rest === 11) rest = 0;
  return rest !== 10 && rest === Number(n[10]);
}

export function iDag(): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Oslo" }).format(new Date());
}
