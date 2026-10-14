// Sortering av tabeller: trykk på en kolonneoverskrift for å sortere etter den, og en gang til for
// motsatt vei. På mobil, der tabellen er en liste uten overskrifter, velges kolonnen i «Sorter».
// Tomme verdier står alltid sist, og like verdier i rekkefølgen siden gir (f.eks. etter navnet).
// Valget huskes på enheten (localStorage) og endrer bare visningen.
import { useState, type ReactNode } from "react";

export type Retning = "stigende" | "synkende";
type Verdi = string | number | null | undefined;
export type Kolonne<T> = {
  navn: string; // i «Sorter» på mobil
  // Verdien det sorteres etter; en liste sorteres verdi for verdi (f.eks. etternavn, så fornavn).
  verdi: (x: T) => Verdi | Verdi[];
  // Grupper som står i samme rekkefølge uansett retning (f.eks. månedslønn før timelønn).
  gruppe?: (x: T) => number;
};
export type Sortering<K extends string> = { kolonne: K; retning: Retning; velg: (k: K) => void; settRetning: (r: Retning) => void };

const ordning = new Intl.Collator("nb", { numeric: true, sensitivity: "base" });
const tom = (v: Verdi) => v == null || v === "" || (typeof v === "number" && Number.isNaN(v));
const somListe = (v: Verdi | Verdi[]) => (Array.isArray(v) ? v : [v]);

function sammenlign(a: Verdi[], b: Verdi[]) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i];
    const y = b[i];
    const r = typeof x === "number" && typeof y === "number" ? x - y : ordning.compare(tom(x) ? "" : String(x), tom(y) ? "" : String(y));
    if (r) return r;
  }
  return 0;
}

export function sorter<T>(liste: readonly T[], kolonne: Kolonne<T>, retning: Retning, deretter?: (x: T) => Verdi | Verdi[]): T[] {
  const r = retning === "synkende" ? -1 : 1;
  return liste
    .map((x, i) => ({ x, i, v: somListe(kolonne.verdi(x)), g: kolonne.gruppe?.(x) ?? 0, d: deretter ? somListe(deretter(x)) : [] }))
    .sort((a, b) => {
      const ta = a.v.every(tom);
      const tb = b.v.every(tom);
      if (ta !== tb) return ta ? 1 : -1;
      return a.g - b.g || r * sammenlign(a.v, b.v) || sammenlign(a.d, b.d) || a.i - b.i;
    })
    .map((m) => m.x);
}

// Kolonnen og retningen, husket under nøkkelen. En kolonne som ikke finnes (lenger), blir standard.
export function useSortering<K extends string>(nokkel: string, kolonner: Partial<Record<K, unknown>>, standard: K): Sortering<K> {
  const [valg, settValg] = useState<{ kolonne: string; retning: Retning }>(() => {
    try {
      const v: unknown = JSON.parse(localStorage.getItem(nokkel) ?? "null");
      if (v && typeof v === "object" && "kolonne" in v && "retning" in v && typeof v.kolonne === "string" && (v.retning === "stigende" || v.retning === "synkende"))
        return { kolonne: v.kolonne, retning: v.retning };
    } catch {
      /* ikke kritisk */
    }
    return { kolonne: standard, retning: "stigende" };
  });
  const kolonne = (Object.hasOwn(kolonner, valg.kolonne) ? valg.kolonne : standard) as K;
  const retning = kolonne === valg.kolonne ? valg.retning : "stigende";
  const lagre = (ny: { kolonne: K; retning: Retning }) => {
    settValg(ny);
    try {
      localStorage.setItem(nokkel, JSON.stringify(ny));
    } catch {
      /* ikke kritisk */
    }
  };
  return {
    kolonne,
    retning,
    velg: (k) => lagre({ kolonne: k, retning: k === kolonne && retning === "stigende" ? "synkende" : "stigende" }),
    settRetning: (r) => lagre({ kolonne, retning: r }),
  };
}

// Kolonneoverskrift som sorterer.
export function SortTh<K extends string>({ k, s, className, children }: { k: K; s: Sortering<K>; className?: string; children: ReactNode }) {
  const aktiv = s.kolonne === k;
  return (
    <th className={className} aria-sort={aktiv ? (s.retning === "stigende" ? "ascending" : "descending") : undefined}>
      <button type="button" className={aktiv ? "sorter aktiv" : "sorter"} onClick={() => s.velg(k)}>
        {children}
        <span className="sorter-pil" aria-hidden="true">
          {aktiv ? (s.retning === "stigende" ? "↑" : "↓") : "↕"}
        </span>
      </button>
    </th>
  );
}

// «Sorter» med kolonnene og retningen, for listene på mobil.
export function SorterValg<K extends string>({ s, kolonner }: { s: Sortering<K>; kolonner: [K, string][] }) {
  const stigende = s.retning === "stigende";
  return (
    <div className="sorter-valg">
      <label>
        <span>Sorter</span>
        <select value={s.kolonne} onChange={(e) => e.target.value !== s.kolonne && s.velg(e.target.value as K)}>
          {kolonner.map(([k, navn]) => (
            <option key={k} value={k}>
              {navn}
            </option>
          ))}
        </select>
      </label>
      <button
        type="button"
        className="ikon"
        aria-label={stigende ? "Stigende. Trykk for synkende" : "Synkende. Trykk for stigende"}
        title={stigende ? "Stigende" : "Synkende"}
        onClick={() => s.settRetning(stigende ? "synkende" : "stigende")}
      >
        <span aria-hidden="true">{stigende ? "↑" : "↓"}</span>
      </button>
    </div>
  );
}
