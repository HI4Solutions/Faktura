// Appens adresser: hoveddomenet (APP_URL) og de andre domenene den samme appen svarer på
// (ANDRE_APP_URLER), f.eks. det nye domenet før det blir hoveddomenet, eller det gamle etter
// flyttingen, og nettstedets domene (NETTSTED_URL), der appen ligger under /app ved siden av
// nettstedet (scripts/publiser-hosting.sh), så «Logg inn» på nettstedet åpner appen på samme domene.
// Innloggingen i nettleseren gjelder ett domene om gangen, så det brukeren gjør der (passkeys,
// tilbakeadressene fra banken, Altinn og Google) følger adressen brukeren er på. Lenkene i e-post og
// varsler peker alltid til hoveddomenet.
import type { Context } from "hono";
import { config } from "./config.js";

const nettstedet = (): string[] => {
  if (!config.nettstedUrl) return [];
  try {
    return [new URL(config.nettstedUrl).origin];
  } catch {
    return [];
  }
};

// Hoveddomenet først, så de andre, de gamle og nettstedets.
export const appUrler = (): string[] => [...new Set([config.appUrl, ...config.andreAppUrler, ...config.gamleAppUrler, ...nettstedet()])];

const opprinnelse = (url: string | undefined): string | null => {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
};

// Adressen forespørselen kommer fra, når den er en av appens egne; ellers hoveddomenet. Nettleseren
// sender Origin med POST og Referer med GET (Referrer-Policy i firebase.json), og ingen av dem kan
// settes av en nettside, så en annen side kan ikke få tilbakeadressene til å peke ut av appen.
export function appUrlFra(c: Context | undefined): string {
  const egne = appUrler();
  for (const kandidat of [c?.req.header("origin"), c?.req.header("referer")]) {
    const o = opprinnelse(kandidat);
    if (o && egne.includes(o)) return o;
  }
  return config.appUrl;
}

// Domenet (vertsnavnet) til en adresse.
export const domene = (url: string) => new URL(url).hostname;
