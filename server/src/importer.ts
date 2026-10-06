// Import av kunder og produkter fra andre systemer. Nettleseren leser fila (CSV, Excel)
// og kobler kolonnene til feltene her. API-et validerer hver rad med de samme reglene
// som ellers, finner det som finnes fra før (eller går igjen i fila) og lager en plan
// som kan vises før noe lagres.
import type { z } from "zod";
import { orgnrGyldig } from "./regler.js";

export type Status = "ny" | "oppdater" | "hopp" | "feil";
export interface Planrad<T> {
  nr: number; // radnummer i importen (1 = første datarad)
  status: Status;
  data?: T;
  id?: string; // eksisterende rad som blir oppdatert eller hoppet over
  grunn?: string;
}

const FELT: Record<string, string> = {
  navn: "navn",
  orgnr: "org.nr. (9 siffer)",
  epost: "e-postadresse",
  telefon: "telefon",
  adresse: "adresse",
  postnr: "postnummer",
  poststed: "poststed",
  land: "landkode (to bokstaver, f.eks. NO)",
  type: "kundetype",
  deres_referanse: "referanse",
  notat: "notat",
  varenummer: "varenummer",
  beskrivelse: "beskrivelse",
  enhet: "enhet",
  enhetspris: "pris",
  mva_sats: "mva-sats (25, 15, 12 eller 0)",
  aktiv: "aktiv (ja/nei)",
};

function feilmelding(e: z.ZodError): string {
  const i = e.issues[0];
  const felt = String(i?.path[0] ?? "");
  if (felt === "navn") return "Mangler navn";
  if (felt === "enhetspris") return "Mangler pris, eller prisen er ikke et tall";
  return `Ugyldig ${FELT[felt] ?? felt}`;
}

// Kunder er like når org.nr. er likt; uten org.nr. når e-posten er lik; uten noen av
// dem når navnet er likt. Produkter er like når varenummeret (ellers navnet) er likt.
export const kundenokler = (k: { orgnr?: string | null; epost?: string | null; navn: string }) =>
  k.orgnr ? [`orgnr:${k.orgnr}`] : k.epost ? [`epost:${k.epost.toLowerCase()}`] : [`navn:${k.navn.trim().toLowerCase()}`];
export const produktnokler = (p: { varenummer?: string | null; navn: string }) =>
  p.varenummer ? [`varenr:${p.varenummer.trim().toLowerCase()}`] : [`navn:${p.navn.trim().toLowerCase()}`];

export const kundeSjekk = (k: { orgnr?: string | null }) => (k.orgnr && !orgnrGyldig(k.orgnr) ? "Ugyldig org.nr. (kontrollsifferet stemmer ikke)" : null);

export function planlegg<T>(
  rader: unknown[],
  skjema: z.ZodType<T>,
  nokler: (d: T) => string[],
  finnes: Map<string, string>,
  duplikater: "hopp" | "oppdater",
  sjekk?: (d: T) => string | null,
): Planrad<T>[] {
  const iFila = new Set<string>();
  return rader.map((rad, i) => {
    const nr = i + 1;
    const p = skjema.safeParse(rad);
    if (!p.success) return { nr, status: "feil", grunn: feilmelding(p.error) };
    const feil = sjekk?.(p.data);
    if (feil) return { nr, status: "feil", grunn: feil };
    const ks = nokler(p.data);
    if (ks.some((k) => iFila.has(k))) return { nr, status: "hopp", grunn: "Står tidligere i fila" };
    for (const k of ks) iFila.add(k);
    const id = ks.map((k) => finnes.get(k)).find(Boolean);
    if (id) return { nr, status: duplikater === "oppdater" ? "oppdater" : "hopp", id, data: p.data, grunn: "Finnes fra før" };
    return { nr, status: "ny", data: p.data };
  });
}
