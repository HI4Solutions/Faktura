// Oppslag i Enhetsregisteret (åpent API fra Brønnøysundregistrene).
import { ApiFeil } from "./feil.js";
import { orgnrGyldig } from "./regler.js";

export interface Enhet {
  orgnr: string;
  navn: string;
  adresse: string | null;
  postnr: string | null;
  poststed: string | null;
  mva_registrert: boolean;
  foretaksregisteret: boolean;
  konkurs: boolean;
  under_avvikling: boolean;
  slettet: boolean;
  hjemmeside: string | null;
  epost: string | null;
}

export async function hentEnhet(nr: string): Promise<Enhet> {
  if (!orgnrGyldig(nr)) throw new ApiFeil(400, "Ugyldig organisasjonsnummer");
  const r = await fetch(`https://data.brreg.no/enhetsregisteret/api/enheter/${nr}`, { headers: { accept: "application/json" } });
  if (r.status === 404 || r.status === 410) throw new ApiFeil(404, "Fant ikke organisasjonsnummeret i Enhetsregisteret");
  if (!r.ok) throw new ApiFeil(502, "Enhetsregisteret svarer ikke");
  const e: any = await r.json();
  const a = e.forretningsadresse ?? e.postadresse ?? {};
  return {
    orgnr: e.organisasjonsnummer,
    navn: e.navn,
    adresse: (a.adresse ?? []).join(", ") || null,
    postnr: a.postnummer ?? null,
    poststed: a.poststed ?? null,
    mva_registrert: Boolean(e.registrertIMvaregisteret),
    foretaksregisteret: Boolean(e.registrertIForetaksregisteret),
    konkurs: Boolean(e.konkurs),
    under_avvikling: Boolean(e.underAvvikling || e.underTvangsavviklingEllerTvangsopplosning),
    slettet: Boolean(e.slettedato),
    hjemmeside: e.hjemmeside ?? null,
    epost: e.epostadresse ?? e.epost ?? null,
  };
}

const gratisEpost = new Set([
  "gmail.com", "googlemail.com", "hotmail.com", "hotmail.no", "outlook.com", "live.com", "live.no", "msn.com",
  "yahoo.com", "yahoo.no", "icloud.com", "me.com", "mac.com", "online.no", "getmail.no", "proton.me",
  "protonmail.com", "aol.com", "gmx.com", "mail.com", "yandex.com",
]);

export function domene(verdi: string | null | undefined): string | null {
  if (!verdi) return null;
  const v = verdi.trim().toLowerCase();
  const d = v.includes("@") ? v.split("@").pop()! : v.replace(/^[a-z]+:\/\//, "").split(/[/?#:]/)[0];
  return d.replace(/^www\./, "") || null;
}

// Hører e-postadressen til foretakets eget domene (nettside eller e-post i registeret)?
export function epostHorerTilForetaket(epost: string, enhet: Enhet): boolean {
  const d = domene(epost);
  if (!d || gratisEpost.has(d)) return false;
  const foretak = [domene(enhet.hjemmeside), domene(enhet.epost)].filter((x): x is string => !!x && !gratisEpost.has(x));
  return foretak.some((f) => d === f || d.endsWith(`.${f}`));
}

export function maskerEpost(e: string): string {
  const [navn, dom] = e.split("@");
  return `${navn.slice(0, 2)}${"•".repeat(Math.max(1, navn.length - 2))}@${dom}`;
}
