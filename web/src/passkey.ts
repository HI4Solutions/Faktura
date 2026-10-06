import { browserSupportsWebAuthn, startAuthentication, startRegistration, WebAuthnAbortService } from "@simplewebauthn/browser";
import { signInWithCustomToken } from "firebase/auth";
import { hentAuth } from "./firebase";
import { api, ApiFeil } from "./api";

export const stotterPasskey = () => browserSupportsWebAuthn();

// SimpleWebAuthn avbryter forrige passkey-forespørsel når en ny starter, også når den
// forrige for lengst er ferdig. I WebKit (Safari og alle nettlesere på iPhone) settes den
// nye forespørselen da i kø til avbrytingen er gjort, og den mister trykket som startet den:
// iPhone viser ingenting, og et nytt trykk hjelper ikke. Derfor glemmes den forrige her
// uten å avbrytes, før og etter hver forespørsel. Kall fn med en gang i trykket.
export async function utenAvbrudd<T>(fn: () => Promise<T>): Promise<T> {
  const tjeneste = WebAuthnAbortService as unknown as { controller?: AbortController };
  tjeneste.controller = undefined;
  try {
    return await fn();
  } finally {
    tjeneste.controller = undefined;
  }
}

async function offentlig(sti: string, kropp?: unknown) {
  const r = await fetch(`/api/offentlig/passkey${sti}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(kropp ?? {}),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiFeil(r.status, data.error ?? `Feil ${r.status}`);
  return data;
}

// Avbrutt av brukeren er ikke en feil som skal vises.
export const erAvbrutt = (e: unknown) => (e as Error)?.name === "AbortError";

// Forklaring på feil fra nettleserens passkey-dialog. NotAllowedError kommer både når
// brukeren avbryter, når tiden går ut, og når nettleseren blokkerer passkeys på siden.
export function passkeyFeil(e: unknown): string {
  const navn = (e as Error)?.name;
  const melding = (e as Error)?.message ?? "";
  if (navn === "NotAllowedError")
    return "Passkey ble avbrutt eller ikke tillatt. Fikk du ikke opp noe vindu, sjekk at adresselinjen viser hengelås og ikke «Ikke sikker» (start nettleseren på nytt om nødvendig), og at enheten har skjermlås, Face ID, Touch ID eller Windows Hello slått på.";
  if (navn === "InvalidStateError") return "Denne enheten har allerede en passkey for kontoen din.";
  if (navn === "SecurityError") return `Nettleseren godtok ikke domenet for passkey (${melding}). Bruk https://faktura.hi4.no.`;
  if (navn === "NotSupportedError") return "Enheten eller nettleseren støtter ikke passkeys.";
  return melding || "Noe gikk galt med passkey.";
}

export async function loggInnMedPasskey() {
  const start = await offentlig("/start");
  const svar = await utenAvbrudd(() => startAuthentication({ optionsJSON: start.valg }));
  const { token } = await offentlig("/fullfor", { utfordring_id: start.utfordring_id, svar });
  await signInWithCustomToken(await hentAuth(), token);
}

export async function leggTilPasskey(navn: string) {
  const start = await api("POST", "/passkeys/registrering/start");
  const svar = await utenAvbrudd(() => startRegistration({ optionsJSON: start.valg }));
  return api("POST", "/passkeys/registrering/fullfor", { utfordring_id: start.utfordring_id, svar, navn });
}

export function foreslattNavn() {
  const ua = navigator.userAgent;
  if (/iPhone|iPad/.test(ua)) return "iPhone/iPad";
  if (/Mac/.test(ua)) return "Mac";
  if (/Android/.test(ua)) return "Android";
  if (/Windows/.test(ua)) return "Windows";
  return "Passkey";
}
