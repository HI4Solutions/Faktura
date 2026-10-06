// Lyst, mørkt eller systemets utseende. Valget gjelder denne enheten (lagres lokalt).
// index.html setter data-tema før siden tegnes; her følges endringer i valget og i systemet.
import { useSyncExternalStore } from "react";

export type Tema = "system" | "lys" | "mork";

const NOKKEL = "faktura.tema";
const ENDRET = "faktura-tema";
const systemet = () => window.matchMedia("(prefers-color-scheme: dark)");

export function lesTema(): Tema {
  try {
    const t = localStorage.getItem(NOKKEL);
    return t === "lys" || t === "mork" ? t : "system";
  } catch {
    return "system";
  }
}

export function brukTema(t: Tema = lesTema()) {
  const mork = t === "mork" || (t === "system" && systemet().matches);
  document.documentElement.setAttribute("data-tema", mork ? "mork" : "lys");
  document.querySelector('meta[name="color-scheme"]')?.setAttribute("content", mork ? "dark" : "light");
}

export function settTema(t: Tema) {
  try {
    if (t === "system") localStorage.removeItem(NOKKEL);
    else localStorage.setItem(NOKKEL, t);
  } catch {
    /* privat modus: gjelder til appen lukkes */
  }
  brukTema(t);
  window.dispatchEvent(new Event(ENDRET));
}

// Valget, oppdatert når det endres her (bryteren i toppfeltet og i innstillingene) eller i
// en annen fane.
function lytt(f: () => void) {
  window.addEventListener(ENDRET, f);
  window.addEventListener("storage", f);
  return () => {
    window.removeEventListener(ENDRET, f);
    window.removeEventListener("storage", f);
  };
}
export const useTema = () => useSyncExternalStore(lytt, lesTema);

// Følg systemet når det bytter (f.eks. mørkt om kvelden) så lenge valget er «System».
export function startTema() {
  brukTema();
  systemet().addEventListener("change", () => lesTema() === "system" && brukTema());
  window.addEventListener("storage", (e) => e.key === NOKKEL && brukTema());
}
