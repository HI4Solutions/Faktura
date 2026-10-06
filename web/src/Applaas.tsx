// Låseskjermen og logikken for når appen låses. Mens appen er låst vises ingenting
// av innholdet, og ingen data hentes.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useKonto } from "./konto";
import { LogoIkon } from "./Logo";
import { erAvbrutt } from "./passkey";
import { bekreftMedPasskey, biometriNavn, lesLaas, lyttPaLaas, merkAktiv, skalLases } from "./applaas";

// Nettopp logget inn med passord eller passkey: ikke be om Face ID med en gang.
function nyligInnlogget(sist: string | undefined) {
  const t = sist ? Date.parse(sist) : NaN;
  return Number.isFinite(t) && Date.now() - t < 2 * 60_000;
}

export function AppLaas({ children }: { children: ReactNode }) {
  const { meg, bruker } = useKonto();
  const id = meg!.bruker.id;
  const [last, settLast] = useState(() => !nyligInnlogget(bruker?.metadata?.lastSignInTime) && skalLases(id));
  const [, oppfrisk] = useState(0);
  const lastRef = useRef(last);
  lastRef.current = last;

  useEffect(() => lyttPaLaas(() => oppfrisk((n) => n + 1)), []);

  useEffect(() => {
    if (!last) merkAktiv();
    const synlighet = () => {
      const l = lesLaas(id);
      if (!l) return;
      if (document.visibilityState === "hidden") {
        if (!lastRef.current) merkAktiv();
        // «Hver gang»: lås før appvelgeren tar bilde av skjermen.
        if (l.minutter === 0) settLast(true);
      } else if (!lastRef.current && skalLases(id)) {
        settLast(true);
      }
    };
    document.addEventListener("visibilitychange", synlighet);
    window.addEventListener("pagehide", synlighet);
    // Mens appen er i bruk: hold «sist aktiv» oppdatert (iOS kan avslutte appen uten varsel).
    const t = setInterval(() => document.visibilityState === "visible" && !lastRef.current && merkAktiv(), 15_000);
    return () => {
      document.removeEventListener("visibilitychange", synlighet);
      window.removeEventListener("pagehide", synlighet);
      clearInterval(t);
    };
  }, [id, last]);

  if (!last) return <>{children}</>;
  return (
    <Laaseskjerm
      opplast={() => {
        merkAktiv();
        settLast(false);
      }}
    />
  );
}

function Laaseskjerm({ opplast }: { opplast: () => void }) {
  const { meg, loggUt } = useKonto();
  const [feil, settFeil] = useState<string | null>(null);
  const [opptatt, settOpptatt] = useState(false);
  const [forsok, settForsok] = useState(0);
  const forsoktAutomatisk = useRef(false);

  async function lasOpp(automatisk = false) {
    settFeil(null);
    settOpptatt(true);
    try {
      await bekreftMedPasskey(meg!.bruker.id);
      opplast();
    } catch (e) {
      // Automatisk forsøk uten trykk kan avvises av nettleseren (Safari krever et trykk).
      if (!automatisk && !erAvbrutt(e) && (e as Error).name !== "NotAllowedError") settFeil((e as Error).message);
      if (!automatisk && (e as Error).name === "NotAllowedError") settForsok((n) => n + 1);
    } finally {
      settOpptatt(false);
    }
  }

  // Start Face ID / Touch ID automatisk når appen er synlig. Nettleseren avviser
  // forespørsler fra en skjult side, så vent til den kommer i forgrunnen igjen.
  useEffect(() => {
    const prov = () => {
      if (document.visibilityState === "hidden") {
        forsoktAutomatisk.current = false;
        return;
      }
      if (forsoktAutomatisk.current) return;
      forsoktAutomatisk.current = true;
      void lasOpp(true);
    };
    prov();
    document.addEventListener("visibilitychange", prov);
    return () => document.removeEventListener("visibilitychange", prov);
  }, []);

  return (
    <div className="laas" role="dialog" aria-modal="true" aria-label="Appen er låst">
      <div className="laas-innhold">
        <LogoIkon storrelse={72} animert={false} />
        <h1>HI4 Faktura er låst</h1>
        <p className="laas-hvem">{meg?.bruker.navn ?? meg?.bruker.epost}</p>
        <button className="primar laas-knapp" disabled={opptatt} onClick={() => lasOpp()}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2" />
            <path d="M9 9.5v1M15 9.5v1M12 9.5v3.5h-1M9.5 16a4 4 0 0 0 5 0" />
          </svg>
          Lås opp med {biometriNavn()}
        </button>
        {feil && <p className="laas-feil">{feil}</p>}
        {forsok >= 2 && (
          <p className="laas-hjelp">
            Fungerer det ikke? Passkeyen kan være slettet fra enheten. Logg ut og logg inn med passord; under Innstillinger kan du lage en
            ny passkey eller slå av applåsen.
          </p>
        )}
        <button className="lenke laas-ut" onClick={loggUt}>
          Logg ut
        </button>
      </div>
    </div>
  );
}
