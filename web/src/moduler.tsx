// Modulene (Faktura, Personal, Lønn, Regnskap og de som kommer, 0044_moduler.sql og
// 0110_moduler.sql): den nye brukeren velger dem når kontoen lages, og plattformadministratoren
// godkjenner kontoen med dem og slår dem av og på for organisasjonene. Lista kommer fra serveren,
// så en ny modul kommer med her av seg selv. krever: modulen den bygger på (Lønn på Personal);
// kjerne: funksjonen modulen slås av og på med; kommer_snart: ikke klar ennå i denne installasjonen
// (KOMMER_SNART på serveren, f.eks. Regnskap i produksjon). Den vises med «Kommer snart», og en ny
// bruker kan ikke velge den; plattformadministratoren kan gi den.
import { useEffect, useState, type ReactNode } from "react";

export type Modul = { kode: string; navn: string; beskrivelse: string; krever?: string | null; kjerne?: string; kommer_snart?: boolean };

// Merket på en modul som ikke er klar ennå.
export const KommerSnart = () => <span className="kommer-snart">Kommer snart</span>;

// Kodene uten modulene som kommer snart (det en ny bruker kan be om).
export const utenKommerSnart = (moduler: Modul[] | null, koder: string[]) =>
  koder.filter((k) => !moduler?.find((m) => m.kode === k)?.kommer_snart);

let lagret: Promise<Modul[]> | null = null;
export function hentModuler(): Promise<Modul[]> {
  lagret ??= fetch("/api/offentlig/moduler")
    .then((r) => (r.ok ? (r.json() as Promise<Modul[]>) : Promise.reject(new Error(`Feil ${r.status}`))))
    .catch((e) => {
      lagret = null;
      throw e;
    });
  return lagret;
}

// null mens de lastes, [] om de ikke kunne hentes.
export function useModuler(aktiv = true): Modul[] | null {
  const [moduler, settModuler] = useState<Modul[] | null>(null);
  useEffect(() => {
    if (!aktiv) return;
    let borte = false;
    hentModuler().then(
      (m) => !borte && settModuler(m),
      () => !borte && settModuler([]),
    );
    return () => {
      borte = true;
    };
  }, [aktiv]);
  return moduler;
}

// «Faktura, Personal og Lønn»
export const opplisting = (navn: string[]) => (navn.length < 2 ? (navn[0] ?? "") : `${navn.slice(0, -1).join(", ")} og ${navn.at(-1)}`);
export const modulnavn = (moduler: Modul[] | null, koder: string[]) => koder.map((k) => moduler?.find((m) => m.kode === k)?.navn ?? k);

// Avkrysning for modulene (i modulenes rekkefølge). Kompakt: bare navnene på én linje, med
// beskrivelsen som hjelpetekst. Med en modul følger den den bygger på (Lønn tar med Personal), og
// uten den går modulene som bygger på den. Modulene som kommer snart, er merket og kan ikke velges,
// unntatt av plattformadministratoren (tillatKommerSnart).
export function ModulValg({
  moduler,
  valgt,
  endre,
  tittel = "Hva trenger du?",
  kompakt,
  navn,
  tillatKommerSnart,
}: {
  moduler: Modul[] | null;
  valgt: string[];
  endre: (moduler: string[]) => void;
  tittel?: ReactNode;
  kompakt?: boolean;
  navn?: string;
  tillatKommerSnart?: boolean;
}) {
  if (!moduler?.length) return null;
  const stengt = (m: Modul) => !!m.kommer_snart && !tillatKommerSnart;
  const sett = (kode: string, pa: boolean) => {
    const ny = new Set(valgt.filter((k) => !moduler.some((m) => m.kode === k && stengt(m))));
    const legg = (k: string) => {
      ny.add(k);
      const krever = moduler.find((m) => m.kode === k)?.krever;
      if (krever && !ny.has(krever)) legg(krever);
    };
    const fjern = (k: string) => {
      ny.delete(k);
      for (const m of moduler) if (m.krever === k && ny.has(m.kode)) fjern(m.kode);
    };
    if (pa) legg(kode);
    else fjern(kode);
    endre(moduler.filter((m) => ny.has(m.kode) && !stengt(m)).map((m) => m.kode));
  };
  return (
    <fieldset className={`modul-valg${kompakt ? " kompakt" : ""}`}>
      <legend>{tittel}</legend>
      {moduler.map((m) => {
        const pa = valgt.includes(m.kode) && !stengt(m);
        const klasser = [pa && "valgt", stengt(m) && "snart"].filter(Boolean).join(" ");
        return (
          <label key={m.kode} className={klasser || undefined} title={kompakt ? m.beskrivelse : undefined}>
            <input
              type="checkbox"
              aria-label={navn ? `${m.navn} for ${navn}` : undefined}
              checked={pa}
              disabled={stengt(m)}
              onChange={(e) => sett(m.kode, e.target.checked)}
            />
            <span>
              <strong>
                {m.navn}
                {m.kommer_snart && (
                  <>
                    {" "}
                    <KommerSnart />
                  </>
                )}
              </strong>
              {!kompakt && <span className="dempet liten">{m.beskrivelse}</span>}
            </span>
          </label>
        );
      })}
    </fieldset>
  );
}
