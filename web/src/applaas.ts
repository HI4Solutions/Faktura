// Applås: krever Face ID / Touch ID (eller Windows Hello / fingeravtrykk) når appen
// åpnes og etter en stund i bakgrunnen. Nettleseren når biometri bare gjennom passkeys
// (WebAuthn), så låsen bruker brukerens passkey på enheten, og API-et bekrefter at
// den hører til kontoen.
//
// Innstillingen gjelder denne enheten og nettleseren (lagres lokalt), siden en lås
// som krever Face ID ikke gir mening på en PC uten.
import { startAuthentication } from "@simplewebauthn/browser";
import { api } from "./api";

export interface Laas {
  bruker: string; // gjelder bare denne brukeren
  minutter: number; // låses etter så lang tid i bakgrunnen; 0 = hver gang
  legitimasjon: string[]; // passkey(er) som har låst opp på denne enheten (for bruk uten nett)
}

const NOKKEL = "faktura.applaas";
const SIST_AKTIV = "faktura.sist-aktiv";
const ENDRET = "faktura-applaas";

function les<T>(nokkel: string): T | null {
  try {
    const v = localStorage.getItem(nokkel);
    return v ? (JSON.parse(v) as T) : null;
  } catch {
    return null;
  }
}
function skriv(nokkel: string, verdi: unknown) {
  try {
    if (verdi === null) localStorage.removeItem(nokkel);
    else localStorage.setItem(nokkel, JSON.stringify(verdi));
  } catch {
    /* privat modus o.l.: låsen blir av */
  }
}

export function lesLaas(bruker: string): Laas | null {
  const l = les<Laas>(NOKKEL);
  return l && l.bruker === bruker ? l : null;
}

export function lagreLaas(l: Laas | null) {
  skriv(NOKKEL, l);
  window.dispatchEvent(new Event(ENDRET));
}

export function lyttPaLaas(f: () => void) {
  window.addEventListener(ENDRET, f);
  return () => window.removeEventListener(ENDRET, f);
}

export function merkAktiv() {
  skriv(SIST_AKTIV, Date.now());
}

// Skal appen være låst nå? Lenger tid siden sist den var i bruk enn valgt grense.
export function skalLases(bruker: string): boolean {
  const l = lesLaas(bruker);
  if (!l) return false;
  const sist = les<number>(SIST_AKTIV) ?? 0;
  return Date.now() - sist > Math.max(l.minutter, 0) * 60_000;
}

export async function stotterApplaas(): Promise<boolean> {
  try {
    return Boolean(window.PublicKeyCredential) && (await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable());
  } catch {
    return false;
  }
}

export function biometriNavn(): string {
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)) return "Face ID / Touch ID";
  if (/Mac OS X/.test(ua)) return "Touch ID";
  if (/Android/.test(ua)) return "fingeravtrykk eller ansikt";
  if (/Windows/.test(ua)) return "Windows Hello";
  return "skjermlåsen";
}

const tilfeldig = () => {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

// Bekreft med passkey. På nett sjekker API-et signaturen og at passkeyen hører til
// kontoen. Uten nett (ingen data kan vises uansett) holder det at enheten bekrefter
// med en passkey som har låst opp her før. Returnerer passkeyens id.
export async function bekreftMedPasskey(bruker: string): Promise<string> {
  if (navigator.onLine) {
    let start: { utfordring_id: string; valg: any } | undefined;
    try {
      start = await api("POST", "/passkeys/bekreft/start");
    } catch (e) {
      if (!(e instanceof TypeError)) throw e; // nettverksfeil: prøv lokalt
    }
    if (start) {
      const svar = await startAuthentication({ optionsJSON: start.valg });
      await api("POST", "/passkeys/bekreft/fullfor", { utfordring_id: start.utfordring_id, svar });
      return svar.id;
    }
  }
  const kjente = lesLaas(bruker)?.legitimasjon ?? [];
  if (!kjente.length) throw new Error("Du er uten nett. Koble til internett for å låse opp.");
  const svar = await startAuthentication({
    optionsJSON: {
      challenge: tilfeldig(),
      rpId: window.location.hostname,
      allowCredentials: kjente.map((id) => ({ id, type: "public-key", transports: ["internal", "hybrid"] })),
      userVerification: "required",
      timeout: 60_000,
    },
  });
  return svar.id;
}
