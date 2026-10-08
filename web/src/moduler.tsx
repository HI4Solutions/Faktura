// Modulene (Faktura, Bemanning og de som kommer, 0044_moduler.sql): den nye brukeren velger
// dem når kontoen lages, og plattformadministratoren godkjenner kontoen med dem. Lista kommer
// fra serveren, så en ny modul kommer med her av seg selv.
import { useEffect, useState } from "react";

export type Modul = { kode: string; navn: string; beskrivelse: string };

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

// «Faktura og Bemanning»
export const opplisting = (navn: string[]) => (navn.length < 2 ? (navn[0] ?? "") : `${navn.slice(0, -1).join(", ")} og ${navn.at(-1)}`);
export const modulnavn = (moduler: Modul[] | null, koder: string[]) => koder.map((k) => moduler?.find((m) => m.kode === k)?.navn ?? k);

// Avkrysning for modulene (i modulenes rekkefølge). Kompakt: bare navnene på én linje, med
// beskrivelsen som hjelpetekst.
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
  const sett = (kode: string, pa: boolean) => endre(moduler.filter((m) => (m.kode === kode ? pa : valgt.includes(m.kode))).map((m) => m.kode));
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
