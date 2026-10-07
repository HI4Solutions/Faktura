// Fødselsnummer og D-nummer: 11 siffer, de seks første er fødselsdatoen (dagen + 40 i et
// D-nummer, måneden + 40 i et H-nummer og + 80 i syntetiske testnummer), så individnummeret
// (som gir århundret) og to kontrollsiffer etter modulus 11.
const K1 = [3, 7, 6, 1, 8, 9, 4, 5, 2];
const K2 = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];

function kontrollsiffer(siffer: number[], vekter: number[]): number {
  const rest = 11 - (vekter.reduce((s, v, i) => s + v * siffer[i]!, 0) % 11);
  return rest === 11 ? 0 : rest;
}

// Fødselsdatoen (ÅÅÅÅ-MM-DD) i nummeret, eller null om den ikke er en gyldig dato.
export function fodselsdato(fnr: string): string | null {
  if (!/^\d{11}$/.test(fnr)) return null;
  let dag = Number(fnr.slice(0, 2));
  let maaned = Number(fnr.slice(2, 4));
  const aa = Number(fnr.slice(4, 6));
  const individ = Number(fnr.slice(6, 9));
  if (dag > 40) dag -= 40;
  if (maaned > 80) maaned -= 80;
  else if (maaned > 40) maaned -= 40;
  const aar =
    individ <= 499 ? 1900 + aa : individ <= 749 && aa >= 54 ? 1800 + aa : aa <= 39 ? 2000 + aa : individ >= 900 ? 1900 + aa : null;
  if (aar === null) return null;
  const d = new Date(Date.UTC(aar, maaned - 1, dag));
  if (d.getUTCFullYear() !== aar || d.getUTCMonth() !== maaned - 1 || d.getUTCDate() !== dag) return null;
  return d.toISOString().slice(0, 10);
}

export function fnrGyldig(fnr: string): boolean {
  if (!/^\d{11}$/.test(fnr)) return false;
  const s = [...fnr].map(Number);
  const k1 = kontrollsiffer(s, K1);
  if (k1 === 10 || k1 !== s[9]) return false;
  const k2 = kontrollsiffer(s, K2);
  if (k2 === 10 || k2 !== s[10]) return false;
  return fodselsdato(fnr) !== null;
}
