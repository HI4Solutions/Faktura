// Applås: krever Face ID / Touch ID (eller Windows Hello / fingeravtrykk) når appen
// åpnes og etter en stund i bakgrunnen. Nettleseren når biometri bare gjennom passkeys
// (WebAuthn), så låsen bruker brukerens passkey på enheten.
//
// Innstillingen gjelder denne enheten og nettleseren (lagres lokalt), siden en lås
// som krever Face ID ikke gir mening på en PC uten.
//
// Når låsen slås på, bekrefter API-et at passkeyen hører til kontoen. Opplåsingen
// sjekkes deretter på enheten mot kontoens passkeys (listen holdes oppdatert mens appen
// er åpen). Da trengs verken nett eller innlogging før Face ID kan starte, så det skjer
// med en gang appen åpnes. Låsen skjuler appen på enheten; API-et krever innlogging som før.
import { startAuthentication } from "@simplewebauthn/browser";
import { api } from "./api";
import { utenAvbrudd } from "./passkey";

export interface Laas {
  bruker: string; // brukerens id i databasen
  uid?: string; // Firebase-id, så låsen kan vises før innloggingen har lastet
  minutter: number; // låses etter så lang tid i bakgrunnen; 0 = hver gang
  legitimasjon: string[]; // id-ene til kontoens passkeys
}

const NOKKEL = "faktura.applaas";
const SIST_AKTIV = "faktura.sist-aktiv";
const INNLOGGET = "faktura.innlogget";
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

// Låsen for denne brukeren (id i databasen eller Firebase-id).
export function lesLaas(id: string | undefined): Laas | null {
  const l = les<Laas>(NOKKEL);
  return id && l && (l.bruker === id || l.uid === id) ? l : null;
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

// Skal appen være låst nå? Lenger tid siden sist den var i bruk enn valgt grense, og
// minst to sekunder, så appen ikke låses i det låsen slås på med «hver gang».
export function skalLases(id: string | undefined): boolean {
  const l = lesLaas(id);
  if (!l) return false;
  const sist = les<number>(SIST_AKTIV) ?? 0;
  return Date.now() - sist > Math.max(l.minutter * 60_000, 2_000);
}

// Hvem som er logget inn på enheten (Firebase-id), så låsen kan vises i det appen
// starter, før innloggingen er lastet.
export function huskInnlogget(uid: string | null) {
  skriv(INNLOGGET, uid);
}
export const sistInnlogget = () => les<string>(INNLOGGET) ?? undefined;

// Hold listen over kontoens passkeys oppdatert. Uten passkeys kan appen ikke låses
// opp, så da slås låsen av.
export function oppdaterLegitimasjon(id: string, passkeys: string[]) {
  const l = lesLaas(id);
  if (!l) return;
  if (!passkeys.length) return lagreLaas(null);
  if (passkeys.length === l.legitimasjon.length && passkeys.every((p) => l.legitimasjon.includes(p))) return;
  lagreLaas({ ...l, legitimasjon: passkeys });
}

export const hentPasskeyIder = async () => (await api<{ id: string }[]>("GET", "/passkeys")).map((p) => p.id);

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

// Safari (og alle nettlesere på iPhone/iPad) er strengere med passkeys uten trykk.
export function erWebKit(): boolean {
  const ua = navigator.userAgent;
  const apple = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  return apple || (/Safari\//.test(ua) && /Mac OS X/.test(ua) && !/Chrome|Chromium|Edg|OPR|Firefox/.test(ua));
}

// --- Passkeys -------------------------------------------------------------------------

const base64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fraBase64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (t) => t.charCodeAt(0));
const utfordring = () => base64url(crypto.getRandomValues(new Uint8Array(32)));

// Bekreft med API-et at passkeyen på enheten hører til kontoen (når låsen slås på).
// Returnerer passkeyens id.
export async function bekreftMedServer(): Promise<string> {
  const s = await api<{ utfordring_id: string; valg: any }>("POST", "/passkeys/bekreft/start");
  const svar = await utenAvbrudd(() => startAuthentication({ optionsJSON: s.valg }));
  await api("POST", "/passkeys/bekreft/fullfor", { utfordring_id: s.utfordring_id, svar });
  return svar.id;
}

// Lås opp med en av kontoens passkeys på denne enheten. Nettleseren spørres i samme
// øyeblikk som funksjonen kalles, uten å vente på nettet: Safari godtar bare
// passkey-forespørsler som starter med en gang etter et trykk (eller når siden åpnes).
export function lasOppMedPasskey(laas: Laas): Promise<string> {
  return utenAvbrudd(() =>
    startAuthentication({
      optionsJSON: {
        challenge: utfordring(),
        rpId: window.location.hostname,
        allowCredentials: laas.legitimasjon.map((id) => ({ id, type: "public-key", transports: ["internal", "hybrid"] })),
        userVerification: "required",
        timeout: 60_000,
      },
    }),
  ).then((svar) => {
    // Enheten skal ha bekreftet at det er eieren (Face ID, Touch ID eller kode), med en av kontoens passkeys.
    const flagg = fraBase64url(svar.response.authenticatorData)[32] ?? 0;
    if (!(flagg & 0x04) || !laas.legitimasjon.includes(svar.id)) throw new Error("Kunne ikke bekrefte at det er deg. Prøv igjen.");
    return svar.id;
  });
}

// Safari lar en side starte Face ID uten trykk én gang; en passkey-forespørsel som
// startes av et trykk, gir en ny sjanse. Etter en automatisk opplåsing gis den nye
// sjansen ved neste trykk i appen, med en forespørsel i autofyll-modus som avbrytes med
// en gang (den viser ingenting, siden ingen felt i appen ber om passkeys). Uten dette
// ville annenhver opplåsing etter at appen har vært i bakgrunnen krevd et trykk.
let autofyll = false;
try {
  void PublicKeyCredential.isConditionalMediationAvailable?.().then(
    (ja) => (autofyll = ja),
    () => {},
  );
} catch {
  /* nettleseren har ikke passkeys */
}

export function gjenopprettAutomatikk(): () => void {
  if (!erWebKit()) return () => {};
  const vedTrykk = (e: Event) => {
    stopp();
    // Trykk som selv starter en passkey (låseskjermen, passkey-knapper) gir den nye sjansen.
    // Forespørselen her avbrytes med en gang, og i samme trykk ville den satt den andre i kø.
    if (!autofyll || (e.target as Element | null)?.closest?.(".laas, [data-passkey]")) return;
    const a = new AbortController();
    navigator.credentials
      .get({
        mediation: "conditional",
        signal: a.signal,
        publicKey: { challenge: crypto.getRandomValues(new Uint8Array(32)), rpId: window.location.hostname, allowCredentials: [], userVerification: "preferred" },
      } as CredentialRequestOptions)
      .catch(() => {});
    a.abort();
  };
  const stopp = () => window.removeEventListener("click", vedTrykk, true);
  window.addEventListener("click", vedTrykk, true);
  return stopp;
}

// Når appen sist kom fra bakgrunnen.
let sistSynlig = 0;
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") sistSynlig = Date.now();
});
export const tidSidenSynlig = () => Date.now() - sistSynlig;

// Vent til appen er synlig og har fokus: nettleseren avviser passkey-forespørsler ellers.
// Avbrytes ventingen, løses løftet også (den som venter, sjekker signalet).
export function ventPaFokus(signal?: AbortSignal): Promise<void> {
  const klar = () => document.visibilityState === "visible" && document.hasFocus();
  if (klar() || signal?.aborted) return Promise.resolve();
  return new Promise((ok) => {
    const ferdig = () => {
      window.removeEventListener("focus", sjekk);
      document.removeEventListener("visibilitychange", sjekk);
      signal?.removeEventListener("abort", ferdig);
      clearInterval(t);
      ok();
    };
    const sjekk = () => klar() && ferdig();
    window.addEventListener("focus", sjekk);
    document.addEventListener("visibilitychange", sjekk);
    signal?.addEventListener("abort", ferdig);
    const t = setInterval(sjekk, 150);
  });
}
