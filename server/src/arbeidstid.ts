// Arbeidstid: ukene (ISO, mandag–søndag) og overtiden i dem.
//
// Overtid etter grensene i oppsettet (arbeidsmiljøloven § 10-4 og § 10-6: over 9 timer per
// dag og 40 per uke, minst 40 % tillegg): timene over daglig grense hver dag, og timene over
// ukentlig grense av resten i uka. Føringer som er merket som overtid (f.eks. pålagt overtid
// med 100 %), er overtid i sin helhet med sitt tillegg. Føringer uten overtid (ekstratimer etter
// avtale, f.eks. fleksitid) er aldri overtid og regnes ikke med i grensene. Merarbeid: ordinære
// timer over den avtalte arbeidstiden (deltid), som ikke er overtid.

export type Regler = { daglig_grense: number; ukentlig_grense: number; overtid_prosent: number };
export type Foring = { dato: string; timer: number; overtid_prosent: number | null; uten_overtid?: boolean };
export type Ukesum = { ordinare: number; overtid: { prosent: number; timer: number }[]; merarbeid: number; uten_overtid: number; sum: number };

export const AML: Regler = { daglig_grense: 9, ukentlig_grense: 40, overtid_prosent: 40 };

const DAG = 86_400_000;
const iso = (d: Date) => d.toISOString().slice(0, 10);

// Uka datoen hører til: år og nummer (ISO 8601) og datoene for mandag og søndag.
export function uke(dato: string): { aar: number; uke: number; fra: string; til: string } {
  const d = new Date(`${dato}T12:00:00Z`);
  const mandag = new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * DAG);
  const aar = new Date(mandag.getTime() + 3 * DAG).getUTCFullYear(); // torsdagen bestemmer året
  const jan4 = new Date(Date.UTC(aar, 0, 4, 12));
  const forsteMandag = new Date(jan4.getTime() - ((jan4.getUTCDay() + 6) % 7) * DAG);
  return { aar, uke: Math.round((mandag.getTime() - forsteMandag.getTime()) / (7 * DAG)) + 1, fra: iso(mandag), til: iso(new Date(mandag.getTime() + 6 * DAG)) };
}

// Regnes i minutter, så summene blir eksakte.
const min = (timer: number) => Math.round(timer * 60);
const timer = (minutter: number) => Math.round((minutter / 60) * 100) / 100;

// Én ukes føringer for én ansatt. avtalt: den avtalte arbeidstiden i uka (for merarbeid).
export function beregnUke(foringer: Foring[], r: Regler, avtalt?: number | null): Ukesum {
  const perDag = new Map<string, number>();
  const overtid = new Map<number, number>();
  let uten = 0;
  for (const f of foringer) {
    if (f.uten_overtid) uten += min(f.timer);
    else if (f.overtid_prosent) overtid.set(f.overtid_prosent, (overtid.get(f.overtid_prosent) ?? 0) + min(f.timer));
    else perDag.set(f.dato, (perDag.get(f.dato) ?? 0) + min(f.timer));
  }
  let ordinare = 0;
  let over = 0;
  for (const m of perDag.values()) {
    const dagOver = Math.max(0, m - min(r.daglig_grense));
    over += dagOver;
    ordinare += m - dagOver;
  }
  const ukeOver = Math.max(0, ordinare - min(r.ukentlig_grense));
  ordinare -= ukeOver;
  over += ukeOver;
  if (over > 0) overtid.set(r.overtid_prosent, (overtid.get(r.overtid_prosent) ?? 0) + over);
  const alleOvertid = [...overtid.values()].reduce((s, m) => s + m, 0);
  return {
    ordinare: timer(ordinare),
    overtid: [...overtid.entries()].sort((a, b) => a[0] - b[0]).map(([prosent, m]) => ({ prosent, timer: timer(m) })),
    merarbeid: avtalt != null ? timer(Math.max(0, ordinare - min(avtalt))) : 0,
    uten_overtid: timer(uten),
    sum: timer(ordinare + alleOvertid + uten),
  };
}
