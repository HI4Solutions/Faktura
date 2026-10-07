// Kan en norsk organisasjon motta EHF? Oppslag i PEPPOL-nettverket slik aksesspunktene
// gjør det: SML-en (DNS, NAPTR-post) peker til mottakerens SMP (for de fleste norske
// mottakere ELMA), og SMP-en svarer for dokumenttypen (EHF-faktura, PEPPOL BIS Billing 3).
//
// Oppslaget skal tåle det som kan gå galt underveis. DNS-en i Cloud Run svarer ikke på
// NAPTR-oppslag, så finner den ingenting, spørres Google og Cloudflare (DNS over HTTPS).
// Finner ingen av dem SMP-en, spørres ELMA direkte (der er de fleste norske mottakerne).
// SMP-en spørres om dokumenttypen (det avsenderne gjør), med identifikatorene kodet på to
// måter, og tjenestelisten leses om det ikke gir svar. Stegene logges, så Admin kan se
// hva som skjedde.
import { createHash } from "node:crypto";
import dns from "node:dns/promises";
import { CUSTOMIZATION_ID } from "./ehf.js";
import { config } from "./config.js";

const SML = "edelivery.tech.ec.europa.eu";
const ELMA = "https://smp.elma-smp.no";
const FAKTURA = `urn:oasis:names:specification:ubl:schema:xsd:Invoice-2::Invoice##${CUSTOMIZATION_ID}`;
// Dokumenttypen slik avsenderne spør etter den (med UBL-versjonen).
const DOKUMENTTYPE = `busdox-docid-qns::${FAKTURA}::2.1`;
const deltaker = (orgnr: string) => `iso6523-actorid-upis::0192:${orgnr}`;
const HODER = { "User-Agent": "HI4 Faktura (+https://faktura.hi4.no)", Accept: "application/xml, text/xml;q=0.9, */*;q=0.5" };

// Base32 (RFC 4648) uten utfylling, som SML-en bruker for SHA-256 av deltaker-id-en.
function base32(data: Uint8Array) {
  const a = "abcdefghijklmnopqrstuvwxyz234567";
  let bits = 0;
  let verdi = 0;
  let ut = "";
  for (const b of data) {
    verdi = (verdi << 8) | b;
    bits += 8;
    while (bits >= 5) {
      ut += a[(verdi >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) ut += a[(verdi << (5 - bits)) & 31];
  return ut;
}

export const smlNavn = (orgnr: string) => `${base32(createHash("sha256").update(`0192:${orgnr}`.toLowerCase()).digest())}.iso6523-actorid-upis.${SML}`;

export type Naptr = { flags: string; service: string; regexp: string; order: number; preference: number };
export interface Oppslag {
  naptr?: (navn: string) => Promise<Naptr[]>; // DNS-en i miljøet
  hent?: typeof fetch; // SMP-en og DNS over HTTPS
}
// svar: true (mottar EHF-faktura), false (ikke registrert for det), null (oppslaget feilet,
// prøv igjen senere). steg: hva som ble spurt om og svaret, til feilsøking.
export type EhfOppslag = { svar: boolean | null; smp: string | null; steg: string[] };

let resolver: dns.Resolver | undefined;
const systemet = () => (resolver ??= new dns.Resolver({ timeout: 2000, tries: 2 }));
const systemetsDns = (navn: string) => systemet().resolveNaptr(navn);

// SMP-adressen i NAPTR-posten: regexp har formen «!.*!https://smp.example.com/!» (skilletegnet
// er første tegn).
function smpAdresse(poster: Naptr[]): string | null {
  const p = poster
    .filter((x) => x.service.toLowerCase() === "meta:smp" && x.flags.toUpperCase() === "U")
    .sort((a, b) => a.order - b.order || a.preference - b.preference)[0];
  const url = p?.regexp.split(p.regexp[0]!)[2];
  return url && /^https?:\/\//.test(url) ? url.replace(/\/+$/, "") : null;
}

// NAPTR-data slik DNS over HTTPS viser den: 100 10 "U" "Meta:SMP" "!.*!https://smp.example.com/!" .
// (feltene kan også stå uten anførselstegn).
export function lesNaptr(data: string): Naptr | null {
  const felt = (data.trim().match(/"(?:[^"\\]|\\.)*"|\S+/g) ?? []).map((t) => (t.length >= 2 && t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1).replace(/\\(.)/g, "$1") : t));
  const [order, preference, flags, service, regexp] = felt;
  if (felt.length < 5 || !/^\d+$/.test(order!) || !/^\d+$/.test(preference!)) return null;
  return { order: Number(order), preference: Number(preference), flags: flags!, service: service!, regexp: regexp! };
}

// DNS over HTTPS. poster: svaret (tomt: ingen post); null: fikk ikke svar.
const DOH = [
  ["Google", (navn: string) => `https://dns.google/resolve?name=${navn}&type=35`],
  ["Cloudflare", (navn: string) => `https://cloudflare-dns.com/dns-query?name=${navn}&type=35`],
] as const;
async function dnsOverHttps(kilde: string, url: string, hent: typeof fetch, steg: string[]): Promise<Naptr[] | null> {
  try {
    const r = await hent(url, { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(4000) });
    if (!r.ok) {
      steg.push(`DNS hos ${kilde}: HTTP ${r.status}`);
      return null;
    }
    const d = (await r.json()) as { Status?: number; Answer?: { type: number; data: string }[] };
    // 3: navnet finnes ikke (NXDOMAIN). 0 uten NAPTR-svar: ingen slik post.
    if (d.Status === 3) {
      steg.push(`DNS hos ${kilde}: finnes ikke (NXDOMAIN)`);
      return [];
    }
    if (d.Status !== 0) {
      steg.push(`DNS hos ${kilde}: status ${d.Status}`);
      return null;
    }
    const svar = d.Answer ?? [];
    const naptr = svar.filter((a) => Number(a.type) === 35);
    const poster = naptr.map((a) => lesNaptr(String(a.data))).filter((p): p is Naptr => p !== null);
    steg.push(
      `DNS hos ${kilde}: ${
        poster.length
          ? poster.map((p) => p.regexp).join(", ")
          : naptr.length
            ? `kunne ikke lese «${String(naptr[0]!.data).slice(0, 120)}»`
            : svar.length
              ? `svar uten NAPTR (typer ${svar.map((a) => a.type).join(", ")})`
              : "ingen post (NOERROR uten svar)"
      }`,
    );
    return poster;
  } catch (e) {
    steg.push(`DNS hos ${kilde}: ${(e as Error).message}`);
    return null;
  }
}

// Svaret fra SMP-en for dokumenttypen (en ServiceMetadata, signert eller ikke).
const ER_TJENESTE = /<(?:[\w-]+:)?(?:Signed)?ServiceMetadata[\s>]/;

// Dokumenttypene i tjenestelisten (ServiceGroup), dekodet (noen SMP-er koder dem to ganger).
function dokumenttyper(xml: string): string[] {
  return [...xml.matchAll(/href\s*=\s*["']([^"']+)["']/g)].map((m) => {
    let s = m[1]!.replace(/&amp;/g, "&");
    try {
      for (let i = 0; i < 3 && /%[0-9a-f]{2}/i.test(s); i++) s = decodeURIComponent(s);
    } catch {
      /* ugyldig koding: bruk lenken som den er */
    }
    return s.replace(/^.*\/services\//, "");
  });
}
const erFaktura = (doktype: string) => doktype.toLowerCase().includes(FAKTURA.toLowerCase());
const kort = (doktype: string) => doktype.replace(/^[^:]+::/, "").replace(/^urn:oasis:names:specification:ubl:schema:xsd:/, "");

// Spør SMP-en om EHF-fakturaen. true: mottakeren tar imot den. false: SMP-en kjenner ikke
// mottakeren, eller tjenestelisten er uten EHF-faktura. null: fikk ikke svar.
async function sporSmp(smp: string, orgnr: string, hent: typeof fetch, steg: string[], hvem = "SMP"): Promise<boolean | null> {
  // Direkte, med identifikatorene kodet fullt ut (standard) og bare med # kodet (noen SMP-er
  // vil ha :: som det er).
  const former: [string, (s: string) => string][] = [
    ["kodet", encodeURIComponent],
    ["med ::", (s) => s.replace(/%/g, "%25").replace(/#/g, "%23")],
  ];
  let feilet = false;
  const spor = async (beskrivelse: string, url: string) => {
    try {
      const r = await hent(url, { headers: HODER, signal: AbortSignal.timeout(6000) });
      const tekst = r.ok ? await r.text() : "";
      steg.push(`${hvem}, ${beskrivelse}: HTTP ${r.status}`);
      if (r.status !== 404 && !r.ok) feilet = true;
      return { status: r.status, tekst };
    } catch (e) {
      steg.push(`${hvem}, ${beskrivelse}: ${(e as Error).message}`);
      feilet = true;
      return { status: 0, tekst: "" };
    }
  };
  for (const [form, kod] of former) {
    const r = await spor(`EHF-faktura (${form})`, `${smp}/${kod(deltaker(orgnr))}/services/${kod(DOKUMENTTYPE)}`);
    if (r.status === 200 && ER_TJENESTE.test(r.tekst)) return true;
  }
  // Tjenestelisten: alle dokumenttypene mottakeren tar imot.
  for (const [form, kod] of former) {
    const r = await spor(`tjenesteliste (${form})`, `${smp}/${kod(deltaker(orgnr))}`);
    if (r.status !== 200) continue;
    const typer = dokumenttyper(r.tekst);
    steg.push(
      `${typer.length} ${typer.length === 1 ? "dokumenttype" : "dokumenttyper"}${typer.length ? `: ${typer.slice(0, 8).map(kort).join(" | ")}${typer.length > 8 ? " …" : ""}` : ""}`,
    );
    return typer.some(erFaktura) || r.tekst.toLowerCase().includes(FAKTURA.toLowerCase());
  }
  // SMP-en kjenner ikke mottakeren (bare 404): nei. Ellers ukjent.
  return feilet ? null : false;
}

export async function ehfOppslag(orgnr: string, o: Oppslag = {}): Promise<EhfOppslag> {
  if (!/^\d{9}$/.test(orgnr)) return { svar: false, smp: null, steg: ["Ugyldig org.nr."] };
  const navn = smlNavn(orgnr);
  const steg: string[] = [`Navn i SML: ${navn}`];
  const hent = o.hent ?? fetch;

  // 1. Hvilken SMP mottakeren er registrert hos (SML-en), først med DNS-en i miljøet.
  // sikkertIkke: et DNS-svar sa at mottakeren ikke er registrert i PEPPOL.
  let smp: string | null = null;
  let sikkertIkke = false;
  const hvilken = o.naptr ? "DNS" : `DNS i miljøet (${systemet().getServers().join(", ") || "standard"})`;
  try {
    const poster = await (o.naptr ?? systemetsDns)(navn);
    smp = smpAdresse(poster);
    steg.push(`${hvilken}: ${smp ?? `ingen SMP i svaret (${poster.length} poster)`}`);
    sikkertIkke = !smp;
  } catch (e) {
    const kode = (e as { code?: string }).code ?? (e as Error).message;
    sikkertIkke = kode === "ENOTFOUND" || kode === "ENODATA";
    steg.push(`${hvilken}: ${kode === "ENOTFOUND" ? "finnes ikke (ENOTFOUND)" : kode === "ENODATA" ? "ingen post (ENODATA)" : `feil (${kode})`}`);
  }
  // 2. Google og Cloudflare (DNS over HTTPS), til en av dem finner SMP-en.
  for (const [kilde, url] of DOH) {
    if (smp) break;
    const poster = await dnsOverHttps(kilde, url(navn), hent, steg);
    if (!poster) continue;
    smp = smpAdresse(poster);
    sikkertIkke ||= !smp;
  }
  if (smp) return { svar: await sporSmp(smp, orgnr, hent, steg), smp, steg };

  // 3. Ingen DNS fant SMP-en: spør ELMA direkte, der de fleste norske mottakerne er.
  // Nei bare når både DNS-en og ELMA sier det; ellers er svaret ukjent.
  const elma = await sporSmp(ELMA, orgnr, hent, steg, "ELMA direkte");
  if (elma) return { svar: true, smp: ELMA, steg };
  return { svar: elma === false && sikkertIkke ? false : null, smp: null, steg };
}

// true: mottar EHF-faktura (PEPPOL BIS Billing 3). false: ikke registrert for det.
// null: oppslaget feilet (prøv igjen senere).
export const kanMottaEhf = async (orgnr: string, o: Oppslag = {}): Promise<boolean | null> => (await ehfOppslag(orgnr, { ...nett, ...o })).svar;

// Brukes av API-et og workeren. Testene setter inn et eget oppslag (eller ingen), eller
// falske DNS- og SMP-svar (nett).
let overstyrt: ((orgnr: string) => Promise<boolean | null>) | undefined;
let nett: Oppslag = {};
export function settEhfOppslag(f?: (orgnr: string) => Promise<boolean | null>) {
  overstyrt = f;
}
export function settEhfNett(o: Oppslag = {}) {
  nett = o;
}
// Svarene huskes en time (samme org.nr. hos flere organisasjoner, og sjekken i kundeskjemaet
// før kunden lagres). Ukjent svar huskes ikke. fersk: slå opp på nytt («Sjekk nå»).
const HUSK_MS = 3600_000;
const husket = new Map<string, { svar: boolean; tid: number }>();
export async function sjekkEhf(orgnr: string, { fersk = false } = {}): Promise<boolean | null> {
  if (overstyrt) return overstyrt(orgnr);
  if (!config.ehfOppslag) return null;
  const h = husket.get(orgnr);
  if (!fersk && h && Date.now() - h.tid < HUSK_MS) return h.svar;
  const svar = await kanMottaEhf(orgnr);
  if (svar !== null) {
    husket.delete(orgnr);
    husket.set(orgnr, { svar, tid: Date.now() });
    if (husket.size > 5000) husket.delete(husket.keys().next().value!);
  }
  return svar;
}
// For Admin: hele oppslaget med stegene, også når oppslag ellers er slått av.
export const testEhf = (orgnr: string) => ehfOppslag(orgnr, nett);
