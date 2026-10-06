// Kan en norsk organisasjon motta EHF? Oppslag i PEPPOL-nettverket slik aksesspunktene
// gjør det: SML-en (DNS, NAPTR-post) peker til mottakerens SMP (for de fleste norske
// mottakere ELMA), og SMP-en lister dokumenttypene mottakeren tar imot.
import { createHash } from "node:crypto";
import dns from "node:dns/promises";
import { CUSTOMIZATION_ID } from "./ehf.js";
import { config } from "./config.js";

const SML = "edelivery.tech.ec.europa.eu";
const FAKTURA = `urn:oasis:names:specification:ubl:schema:xsd:Invoice-2::Invoice##${CUSTOMIZATION_ID}`;

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

export interface Oppslag {
  naptr?: (navn: string) => Promise<{ flags: string; service: string; regexp: string; order: number; preference: number }[]>;
  hent?: typeof fetch;
}

// true: mottar EHF-faktura (PEPPOL BIS Billing 3). false: ikke registrert for det.
// null: oppslaget feilet (prøv igjen senere).
export async function kanMottaEhf(orgnr: string, o: Oppslag = {}): Promise<boolean | null> {
  if (!/^\d{9}$/.test(orgnr)) return false;
  const naptr = o.naptr ?? ((n: string) => (resolver ??= new dns.Resolver({ timeout: 2000, tries: 2 })).resolveNaptr(n));
  const hent = o.hent ?? fetch;
  let poster;
  try {
    poster = await naptr(smlNavn(orgnr));
  } catch (e) {
    const kode = (e as { code?: string }).code;
    return kode === "ENOTFOUND" || kode === "ENODATA" ? false : null;
  }
  const smp = poster
    .filter((p) => p.service === "Meta:SMP" && p.flags.toUpperCase() === "U")
    .sort((a, b) => a.order - b.order || a.preference - b.preference)[0];
  if (!smp) return false;
  // regexp har formen «!.*!https://smp.example.com/!» (skilletegnet er første tegn).
  const url = smp.regexp.split(smp.regexp[0]!)[2];
  if (!url) return null;
  try {
    const r = await hent(`${url.replace(/\/+$/, "")}/${encodeURIComponent(`iso6523-actorid-upis::0192:${orgnr}`)}`, { signal: AbortSignal.timeout(5000) });
    if (r.status === 404) return false;
    if (!r.ok) return null;
    const xml = await r.text();
    const lenker = [...xml.matchAll(/href="([^"]+)"/g)].map((m) => {
      let s = m[1]!.replace(/&amp;/g, "&");
      try {
        for (let i = 0; i < 3 && /%[0-9a-f]{2}/i.test(s); i++) s = decodeURIComponent(s);
      } catch {
        /* ugyldig koding: bruk lenken som den er */
      }
      return s;
    });
    return lenker.some((l) => l.includes(FAKTURA));
  } catch {
    return null;
  }
}

let resolver: dns.Resolver | undefined;

// Brukes av API-et og workeren. Testene setter inn et eget oppslag (eller ingen).
let overstyrt: ((orgnr: string) => Promise<boolean | null>) | undefined;
export function settEhfOppslag(f?: (orgnr: string) => Promise<boolean | null>) {
  overstyrt = f;
}
export const sjekkEhf = (orgnr: string): Promise<boolean | null> =>
  overstyrt ? overstyrt(orgnr) : config.ehfOppslag ? kanMottaEhf(orgnr) : Promise.resolve(null);
