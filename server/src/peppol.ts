// Kan en norsk organisasjon motta EHF? Oppslag i PEPPOL-nettverket slik aksesspunktene
// gjør det: SML-en (DNS, NAPTR-post) peker til mottakerens SMP (for de fleste norske
// mottakere ELMA), og SMP-en svarer for dokumenttypen (EHF-faktura, PEPPOL BIS Billing 3).
//
// Oppslaget skal tåle det som kan gå galt underveis: finner ikke DNS-en i miljøet noe,
// spørres Google eller Cloudflare (DNS over HTTPS) før svaret er nei. SMP-en spørres direkte
// om dokumenttypen (det avsenderne gjør), med identifikatorene kodet på to måter, og
// tjenestelisten leses om det ikke gir svar. Stegene logges, så Admin kan se hva som skjedde.
import { createHash } from "node:crypto";
import dns from "node:dns/promises";
import { CUSTOMIZATION_ID } from "./ehf.js";
import { config } from "./config.js";

const SML = "edelivery.tech.ec.europa.eu";
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
const systemetsDns = (navn: string) => (resolver ??= new dns.Resolver({ timeout: 2000, tries: 2 })).resolveNaptr(navn);

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
const tekstfelt = String.raw`"((?:[^"\\]|\\.)*)"`;
const NAPTR_DATA = new RegExp(String.raw`^(\d+)\s+(\d+)\s+${tekstfelt}\s+${tekstfelt}\s+${tekstfelt}\s+\S+\s*$`);
const lesNaptr = (data: string): Naptr | null => {
  const m = NAPTR_DATA.exec(data.trim());
  if (!m) return null;
  const ut = (s: string) => s.replace(/\\(.)/g, "$1");
  return { order: Number(m[1]), preference: Number(m[2]), flags: ut(m[3]!), service: ut(m[4]!), regexp: ut(m[5]!) };
};

// DNS over HTTPS (Google, så Cloudflare). poster: svaret; null: fikk ikke svar.
async function dnsOverHttps(navn: string, hent: typeof fetch, steg: string[]): Promise<Naptr[] | null> {
  for (const [kilde, url] of [
    ["Google", `https://dns.google/resolve?name=${navn}&type=NAPTR`],
    ["Cloudflare", `https://cloudflare-dns.com/dns-query?name=${navn}&type=NAPTR`],
  ] as const) {
    try {
      const r = await hent(url, { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(4000) });
      if (!r.ok) {
        steg.push(`DNS hos ${kilde}: HTTP ${r.status}`);
        continue;
      }
      const d = (await r.json()) as { Status?: number; Answer?: { type: number; data: string }[] };
      // 3: navnet finnes ikke (NXDOMAIN). 0 uten NAPTR-svar: ingen slik post.
      if (d.Status === 3) {
        steg.push(`DNS hos ${kilde}: ingen post`);
        return [];
      }
      if (d.Status !== 0) {
        steg.push(`DNS hos ${kilde}: status ${d.Status}`);
        continue;
      }
      const poster = (d.Answer ?? []).filter((a) => a.type === 35).map((a) => lesNaptr(a.data)).filter((p): p is Naptr => p !== null);
      steg.push(`DNS hos ${kilde}: ${poster.length ? poster.map((p) => p.regexp).join(", ") : "ingen post"}`);
      return poster;
    } catch (e) {
      steg.push(`DNS hos ${kilde}: ${(e as Error).message}`);
    }
  }
  return null;
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

export async function ehfOppslag(orgnr: string, o: Oppslag = {}): Promise<EhfOppslag> {
  const steg: string[] = [];
  if (!/^\d{9}$/.test(orgnr)) return { svar: false, smp: null, steg: ["Ugyldig org.nr."] };
  const navn = smlNavn(orgnr);
  const hent = o.hent ?? fetch;

  // 1. Hvilken SMP mottakeren er registrert hos (SML-en). sikkertIkke: et DNS-svar sa
  // at mottakeren ikke er registrert i PEPPOL.
  let smp: string | null = null;
  let sikkertIkke = false;
  try {
    const poster = await (o.naptr ?? systemetsDns)(navn);
    smp = smpAdresse(poster);
    steg.push(`DNS: ${smp ?? "ingen SMP i svaret"}`);
    sikkertIkke = !smp;
  } catch (e) {
    const kode = (e as { code?: string }).code ?? (e as Error).message;
    sikkertIkke = kode === "ENOTFOUND" || kode === "ENODATA";
    steg.push(`DNS: ${sikkertIkke ? "ingen post" : `feil (${kode})`}`);
  }
  if (!smp) {
    const poster = await dnsOverHttps(navn, hent, steg);
    if (poster) {
      smp = smpAdresse(poster);
      sikkertIkke ||= !smp;
    }
  }
  if (!smp) return { svar: sikkertIkke ? false : null, smp: null, steg };

  // 2. Spør SMP-en om EHF-fakturaen direkte, med identifikatorene kodet fullt ut (standard)
  // og bare med # kodet (noen SMP-er vil ha :: som det er).
  const former: [string, (s: string) => string][] = [
    ["kodet", encodeURIComponent],
    ["med ::", (s) => s.replace(/%/g, "%25").replace(/#/g, "%23")],
  ];
  let feilet = false;
  const spor = async (beskrivelse: string, url: string) => {
    try {
      const r = await hent(url, { headers: HODER, signal: AbortSignal.timeout(6000) });
      const tekst = r.ok ? await r.text() : "";
      steg.push(`${beskrivelse}: HTTP ${r.status}`);
      if (r.status !== 404 && !r.ok) feilet = true;
      return { status: r.status, tekst };
    } catch (e) {
      steg.push(`${beskrivelse}: ${(e as Error).message}`);
      feilet = true;
      return { status: 0, tekst: "" };
    }
  };
  for (const [form, kod] of former) {
    const r = await spor(`SMP, EHF-faktura (${form})`, `${smp}/${kod(deltaker(orgnr))}/services/${kod(DOKUMENTTYPE)}`);
    if (r.status === 200 && ER_TJENESTE.test(r.tekst)) return { svar: true, smp, steg };
  }

  // 3. Tjenestelisten: alle dokumenttypene mottakeren tar imot.
  let fantListe = false;
  for (const [form, kod] of former) {
    const r = await spor(`SMP, tjenesteliste (${form})`, `${smp}/${kod(deltaker(orgnr))}`);
    if (r.status !== 200) continue;
    fantListe = true;
    const typer = dokumenttyper(r.tekst);
    steg.push(
      `${typer.length} ${typer.length === 1 ? "dokumenttype" : "dokumenttyper"}${typer.length ? `: ${typer.slice(0, 8).map(kort).join(" | ")}${typer.length > 8 ? " …" : ""}` : ""}`,
    );
    if (typer.some(erFaktura) || r.tekst.toLowerCase().includes(FAKTURA.toLowerCase())) return { svar: true, smp, steg };
    break;
  }
  // Listen uten EHF-faktura, eller SMP-en kjenner ikke mottakeren: nei. Ellers ukjent.
  return { svar: fantListe || !feilet ? false : null, smp, steg };
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
export const sjekkEhf = (orgnr: string): Promise<boolean | null> =>
  overstyrt ? overstyrt(orgnr) : config.ehfOppslag ? kanMottaEhf(orgnr) : Promise.resolve(null);
// For Admin: hele oppslaget med stegene, også når oppslag ellers er slått av.
export const testEhf = (orgnr: string) => ehfOppslag(orgnr, nett);
