// Modulene (Faktura, Personal, Lønn, Regnskap og de som kommer, 0044_moduler.sql og
// 0110_moduler.sql): den nye brukeren velger dem når kontoen lages, og plattformadministratoren
// godkjenner kontoen med dem og slår dem av og på for organisasjonene. Lista kommer fra serveren,
// så en ny modul kommer med her av seg selv. krever: modulen den bygger på (Lønn på Personal);
// kjerne: funksjonen modulen slås av og på med.
import { useEffect, useState } from "react";

export type Modul = { kode: string; navn: string; beskrivelse: string; krever?: string | null; kjerne?: string };

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
// uten den går modulene som bygger på den.
export function ModulValg({
  moduler,
  valgt,
  endre,
  tittel = "Hva trenger du?",
  kompakt,
  navn,
}: {
  moduler: Modul[] | null;
  valgt: string[];
  endre: (moduler: string[]) => void;
  tittel?: string;
  kompakt?: boolean;
  navn?: string;
}) {
  if (!moduler?.length) return null;
  const sett = (kode: string, pa: boolean) => {
    const ny = new Set(valgt);
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
    endre(moduler.filter((m) => ny.has(m.kode)).map((m) => m.kode));
  };
  return (
    <fieldset className={`modul-valg${kompakt ? " kompakt" : ""}`}>
      <legend>{tittel}</legend>
      {moduler.map((m) => (
        <label key={m.kode} className={valgt.includes(m.kode) ? "valgt" : undefined} title={kompakt ? m.beskrivelse : undefined}>
          <input
            type="checkbox"
            aria-label={navn ? `${m.navn} for ${navn}` : undefined}
            checked={valgt.includes(m.kode)}
            onChange={(e) => sett(m.kode, e.target.checked)}
          />
          <span>
            <strong>{m.navn}</strong>
            {!kompakt && <span className="dempet liten">{m.beskrivelse}</span>}
          </span>
        </label>
      ))}
    </fieldset>
  );
}
