// Stien appen ligger under. På appens eget domene ligger den øverst (""), og på nettstedets domene
// under /app, ved siden av nettstedet, så «Logg inn» på nettstedet åpner appen på samme domene (og inne
// i snarveien på Hjem-skjermen). Siden for appen der (app/index.html) har
// <meta name="app-sti" content="/app">, satt av scripts/publiser-hosting.sh (docs/domene.md).
const fraSiden = typeof document === "undefined" ? null : document.querySelector('meta[name="app-sti"]')?.getAttribute("content");

export const APP_STI = fraSiden && /^\/[a-z0-9-]+$/.test(fraSiden) ? fraSiden : "";

// Forsiden i appen, og adressen til den (f.eks. tilbake fra e-postene fra Firebase).
export const APP_FORSIDE = APP_STI || "/";
export const appAdresse = () => `${window.location.origin}${APP_STI}`;

// En adresse fra før (tilbakeadressene fra banken, Altinn og Google, varsler og gamle lenker) som
// ikke har stien foran, får den, før ruteren starter. Nettstedet sender alt det ikke har selv til
// appen (scripts/publiser-hosting.sh).
export function leggTilAppSti() {
  if (!APP_STI) return;
  const { pathname, search, hash } = window.location;
  if (pathname === APP_STI || pathname.startsWith(`${APP_STI}/`)) return;
  window.history.replaceState(window.history.state, "", `${APP_STI}${pathname === "/" ? "" : pathname}${search}${hash}`);
}
