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

// Den nye adressen når appen er åpnet på et domene den er flyttet fra (server/src/appadresse.ts).
function useNyAdresse(): string | null {
  const [ny, settNy] = useState<string | null>(null);
  useEffect(() => {
    let aktiv = true;
    fetch("/api/offentlig/adresse")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { hovedadresse?: unknown; gamle?: unknown } | null) => {
        const her = window.location.origin;
        if (aktiv && d && typeof d.hovedadresse === "string" && d.hovedadresse !== her && Array.isArray(d.gamle) && d.gamle.includes(her))
          settNy(d.hovedadresse);
      })
      .catch(() => {});
    return () => {
      aktiv = false;
    };
  }, []);
  return ny;
}

export function PwaBannere() {
  const { nyVersjon } = usePwa();
  const paNett = usePaNett();
  const nyAdresse = useNyAdresse();
  return (
    <div className="bannere" aria-live="polite">
      {nyAdresse && (
        <div className="banner">
          <span>
            Admin Konsoll har ny adresse: <strong>{new URL(nyAdresse).host}</strong>. Logg inn der, og legg til passkey og appen på
            nytt.
          </span>
          <button className="primar" onClick={() => window.location.assign(nyAdresse)}>
            Gå dit
          </button>
        </div>
      )}
      {!paNett && (
        <div className="banner frakoblet">
          <span className="prikk" /> Du er frakoblet. Endringer kan ikke lagres før du er på nett igjen.
        </div>
      )}
      {nyVersjon && (
        <div className="banner">
          En ny versjon av Admin Konsoll er klar.
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
