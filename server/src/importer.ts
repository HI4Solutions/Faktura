// Import av kunder, produkter og ansatte fra andre systemer. Nettleseren leser fila (CSV, Excel)
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
  if (felt === "enhetspris") return "Prisen er ikke et tall";
  return `Ugyldig ${FELT[felt] ?? felt}`;
}

// Kunder er like når org.nr. er likt; uten org.nr. når e-posten er lik; uten noen av
// dem når navnet er likt. Produkter er like når varenummeret (ellers navnet) er likt.
export const kundenokler = (k: { orgnr?: string | null; epost?: string | null; navn: string }) =>
  k.orgnr ? [`orgnr:${k.orgnr}`] : k.epost ? [`epost:${k.epost.toLowerCase()}`] : [`navn:${k.navn.trim().toLowerCase()}`];
export const produktnokler = (p: { varenummer?: string | null; navn: string }) =>
  p.varenummer ? [`varenr:${p.varenummer.trim().toLowerCase()}`] : [`navn:${p.navn.trim().toLowerCase()}`];

export const kundeSjekk = (k: { orgnr?: string | null }) => (k.orgnr && !orgnrGyldig(k.orgnr) ? "Ugyldig org.nr. (kontrollsifferet stemmer ikke)" : null);

// nokler: like rader i fila. oppslag: nøklene raden slås opp med blant dem som finnes (som
// standard de samme). melding: feilmeldingen når raden ikke passer skjemaet.
export function planlegg<T>(
  rader: unknown[],
  skjema: z.ZodType<T>,
  nokler: (d: T) => string[],
  finnes: Map<string, string>,
  duplikater: "hopp" | "oppdater",
  sjekk?: (d: T) => string | null,
  valg: { oppslag?: (d: T) => string[]; melding?: (e: z.ZodError) => string } = {},
): Planrad<T>[] {
  const iFila = new Set<string>();
  return rader.map((rad, i) => {
    const nr = i + 1;
    const p = skjema.safeParse(rad);
    if (!p.success) return { nr, status: "feil", grunn: (valg.melding ?? feilmelding)(p.error) };
    const feil = sjekk?.(p.data);
    if (feil) return { nr, status: "feil", grunn: feil };
    const ks = nokler(p.data);
    if (ks.some((k) => iFila.has(k))) return { nr, status: "hopp", grunn: "Står tidligere i fila" };
    for (const k of ks) iFila.add(k);
    const id = (valg.oppslag?.(p.data) ?? ks).map((k) => finnes.get(k)).find(Boolean);
    if (id) return { nr, status: duplikater === "oppdater" ? "oppdater" : "hopp", id, data: p.data, grunn: "Finnes fra før" };
    return { nr, status: "ny", data: p.data };
  });
}

// Ansatte er like når e-posten er lik; uten e-post når navnet er likt. En rad med e-post er
// også den samme som en ansatt med samme navn som ikke har e-post (men ikke som en med en
// annen e-post: to med samme navn kan være to forskjellige).
const ansattNavn = (a: { fornavn: string; etternavn: string }) => `${a.fornavn} ${a.etternavn}`.trim().replace(/\s+/g, " ").toLowerCase();
export const ansattnokler = (a: { fornavn: string; etternavn: string; epost?: string | null }) =>
  a.epost ? [`epost:${a.epost.trim().toLowerCase()}`] : [`navn:${ansattNavn(a)}`];
export const ansattOppslag = (a: { fornavn: string; etternavn: string; epost?: string | null }) =>
  a.epost ? [`epost:${a.epost.trim().toLowerCase()}`, `navn-uten-epost:${ansattNavn(a)}`] : [`navn:${ansattNavn(a)}`];
// Nøklene til en ansatt som finnes.
export const ansattFinnes = (a: { fornavn: string; etternavn: string; epost: string | null }) =>
  [`navn:${ansattNavn(a)}`, a.epost ? `epost:${a.epost.trim().toLowerCase()}` : `navn-uten-epost:${ansattNavn(a)}`];

const ANSATTFELT: Record<string, string> = {
  fornavn: "fornavn",
  etternavn: "etternavn",
  epost: "e-postadresse",
  telefon: "telefonnummer",
  adresse: "adresse",
  postnr: "postnummer",
  poststed: "poststed",
  fodselsdato: "fødselsdato",
  fnr: "fødselsnummer",
  kontonr: "kontonummer",
  stilling: "stilling",
  stillingsprosent: "stillingsprosent",
  ukentlig_arbeidstid: "arbeidstid per uke",
  ansatt_fra: "startdato",
  ansatt_til: "sluttdato",
  ansettelsestype: "ansettelsestype (fast, midlertidig eller tilkalling)",
  lonnstype: "lønnstype (måned eller time)",
  maanedslonn: "månedslønn",
  timelonn: "timelønn",
  ferie_dager: "antall feriedager",
  notat: "notat",
  aktiv: "aktiv (ja/nei)",
  tillegg: "fast tillegg",
};

// Meldingene fra skjemaet for ansatte brukes når de sier hva som er galt (f.eks. «Fødselsnummeret
// er ikke gyldig (sjekk sifrene)»); ellers (feil type, ukjent valg) sies hvilket felt det gjelder.
export function ansattFeil(e: z.ZodError): string {
  const i = e.issues[0];
  if (!i) return "Ugyldig rad";
  const felt = String(i.path[0] ?? "");
  if ((felt === "fornavn" || felt === "etternavn") && (i.code === "invalid_type" || i.code === "too_small")) return `Mangler ${ANSATTFELT[felt]}`;
  if (i.code === "invalid_type" || i.code === "invalid_value" || i.message === "Ugyldig dato" || /^(Invalid|Too |Expected)/.test(i.message))
    return `Ugyldig ${ANSATTFELT[felt] ?? felt}`;
  return i.message;
}
