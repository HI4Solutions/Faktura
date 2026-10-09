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

// --- Roller ------------------------------------------------------------------------

export interface Rolle {
  kode: string; // DAGL, LEDE, INNH …
  rolle: string; // «Daglig leder»
  navn: string;
}

// Kortere navn på de vanligste rollene (Brreg skriver f.eks. «Daglig leder/ adm.direktør»).
const ROLLENAVN: Record<string, string> = {
  DAGL: "Daglig leder", LEDE: "Styreleder", NEST: "Nestleder", MEDL: "Styremedlem", VARA: "Varamedlem", OBS: "Observatør",
  INNH: "Innehaver", KOMP: "Komplementar", DTPR: "Deltaker", DTSO: "Deltaker", BEST: "Bestyrende reder",
  REPR: "Norsk representant", KONT: "Kontaktperson", "FFØR": "Forretningsfører", SAM: "Sameier",
};
// Rollene som kan representere foretaket utad (ikke varamedlem, observatør o.l.).
export const LEDERROLLER = new Set(["DAGL", "LEDE", "NEST", "MEDL", "INNH", "KOMP", "DTPR", "DTSO", "BEST", "REPR", "KONT", "FFØR"]);

// Personene med roller i foretaket, fra Brregs åpne API (fratrådte og døde tas ikke med).
export async function hentRoller(nr: string): Promise<Rolle[]> {
  if (!orgnrGyldig(nr)) throw new ApiFeil(400, "Ugyldig organisasjonsnummer");
  const r = await fetch(`https://data.brreg.no/enhetsregisteret/api/enheter/${nr}/roller`, { headers: { accept: "application/json" } });
  if (r.status === 404 || r.status === 410) return [];
  if (!r.ok) throw new ApiFeil(502, "Enhetsregisteret svarer ikke");
  return tilRoller(await r.json());
}

export function tilRoller(data: any): Rolle[] {
  const ut: Rolle[] = [];
  for (const g of data?.rollegrupper ?? []) {
    for (const r of g?.roller ?? []) {
      const p = r?.person;
      if (!p || r.fratraadt || p.erDoed) continue;
      const n = p.navn ?? {};
      const navn = [n.fornavn, n.mellomnavn, n.etternavn].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
      if (!navn) continue;
      const kode = String(r.type?.kode ?? g.type?.kode ?? "");
      ut.push({ kode, rolle: ROLLENAVN[kode] ?? String(r.type?.beskrivelse ?? g.type?.beskrivelse ?? kode), navn });
    }
  }
  return ut;
}

const navneord = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\s-]/gu, " ")
    .split(/[\s-]+/)
    .filter(Boolean);

// Samme fornavn og etternavn (mellomnavn kan mangle hos den ene). Bare et hint: navnet en
// bruker oppgir, kan hvem som helst skrive, så det verifiserer ingen alene.
export function sammePerson(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = navneord(a ?? "");
  const y = navneord(b ?? "");
  if (x.length < 2 || y.length < 2) return false;
  return x[0] === y[0] && x[x.length - 1] === y[y.length - 1];
}

// Den viktigste rollen personen med dette navnet har i foretaket, om noen.
export function finnRolle(roller: Rolle[], navn: string | null | undefined): Rolle | null {
  const treff = roller.filter((r) => sammePerson(navn, r.navn));
  return treff.find((r) => LEDERROLLER.has(r.kode)) ?? treff[0] ?? null;
}

// Er e-postadressen nøyaktig den som står på foretaket (også gratis e-post som Gmail)?
export const erForetaketsEpost = (epost: string, enhet: Enhet) => Boolean(enhet.epost && enhet.epost.trim().toLowerCase() === epost.trim().toLowerCase());

// Underenhetene (virksomhetene) til en juridisk enhet, til a-meldingen (arbeidsforholdene
// rapporteres under virksomheten). Nedlagte er ikke med.
export async function hentUnderenheter(nr: string): Promise<{ orgnr: string; navn: string; adresse: string | null }[]> {
  if (!orgnrGyldig(nr)) throw new ApiFeil(400, "Ugyldig organisasjonsnummer");
  const r = await fetch(`https://data.brreg.no/enhetsregisteret/api/underenheter?overordnetEnhet=${nr}&size=50`, { headers: { accept: "application/json" } });
  if (!r.ok) throw new ApiFeil(502, "Enhetsregisteret svarer ikke");
  const d: any = await r.json();
  return ((d?._embedded?.underenheter ?? []) as any[])
    .filter((u) => !u.nedleggelsesdato && !u.slettedato)
    .map((u) => {
      const a = u.beliggenhetsadresse ?? u.postadresse ?? {};
      return {
        orgnr: String(u.organisasjonsnummer),
        navn: String(u.navn ?? ""),
        adresse: [(a.adresse ?? []).join(", "), [a.postnummer, a.poststed].filter(Boolean).join(" ")].filter(Boolean).join(", ") || null,
      };
    });
}
