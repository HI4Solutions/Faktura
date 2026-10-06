import { browserSupportsWebAuthn, startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { signInWithCustomToken } from "firebase/auth";
import { hentAuth } from "./firebase";
import { api, ApiFeil } from "./api";

export const stotterPasskey = () => browserSupportsWebAuthn();

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
export const erAvbrutt = (e: unknown) => (e as Error)?.name === "NotAllowedError" || (e as Error)?.name === "AbortError";

export async function loggInnMedPasskey() {
  const start = await offentlig("/start");
  const svar = await startAuthentication({ optionsJSON: start.valg });
  const { token } = await offentlig("/fullfor", { utfordring_id: start.utfordring_id, svar });
  await signInWithCustomToken(await hentAuth(), token);
}

export async function leggTilPasskey(navn: string) {
  const start = await api("POST", "/passkeys/registrering/start");
  const svar = await startRegistration({ optionsJSON: start.valg });
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
