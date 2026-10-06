// Det brukeren ser av PWA-en: banner for ny versjon og frakoblet, og navigering fra varsler.
import { useEffect, useReducer, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useKonto } from "./konto";
import { kanInstallere, lyttPaPwa, nyVersjonKlar, oppdaterApp } from "./pwa";

export function usePwa() {
  const [, oppfrisk] = useReducer((n: number) => n + 1, 0);
  useEffect(() => lyttPaPwa(oppfrisk), []);
  return { kanInstallere: kanInstallere(), nyVersjon: nyVersjonKlar() };
}

function usePaNett() {
  const [paNett, settPaNett] = useState(navigator.onLine);
  useEffect(() => {
    const pa = () => settPaNett(true);
    const av = () => settPaNett(false);
    window.addEventListener("online", pa);
    window.addEventListener("offline", av);
    return () => {
      window.removeEventListener("online", pa);
      window.removeEventListener("offline", av);
    };
  }, []);
  return paNett;
}

export function PwaBannere() {
  const { nyVersjon } = usePwa();
  const paNett = usePaNett();
  return (
    <div className="bannere" aria-live="polite">
      {!paNett && (
        <div className="banner frakoblet">
          <span className="prikk" /> Du er frakoblet. Endringer kan ikke lagres før du er på nett igjen.
        </div>
      )}
      {nyVersjon && (
        <div className="banner">
          En ny versjon av HI4 Faktura er klar.
          <button className="primar" onClick={oppdaterApp}>
            Oppdater
          </button>
        </div>
      )}
    </div>
  );
}

// Lenker fra varsler: «?org=<id>» bytter til riktig organisasjon, og et trykk på et varsel
// mens appen er åpen navigerer i stedet for å åpne et nytt vindu.
export function useVarselNavigering() {
  const nav = useNavigate();
  const sted = useLocation();
  const { meg, org, velgOrg } = useKonto();

  useEffect(() => {
    const p = new URLSearchParams(sted.search);
    const onsket = p.get("org");
    if (!onsket) return;
    if (onsket !== org?.id && meg?.organisasjoner.some((o) => o.id === onsket)) velgOrg(onsket);
    p.delete("org");
    const rest = p.toString();
    nav(`${sted.pathname}${rest ? `?${rest}` : ""}`, { replace: true });
  }, [sted.search]);

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const melding = (e: MessageEvent) => {
      if (e.data?.type === "NAVIGER" && typeof e.data.url === "string" && e.data.url.startsWith("/")) nav(e.data.url);
    };
    navigator.serviceWorker.addEventListener("message", melding);
    return () => navigator.serviceWorker.removeEventListener("message", melding);
  }, []);
}
