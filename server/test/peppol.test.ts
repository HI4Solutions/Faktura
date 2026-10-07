// Oppslag i PEPPOL (SML via DNS og SMP), med falske svar. Ingen kall går ut på nettet.
import { afterEach, describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { lagApi } from "../src/api.js";
import { ehfOppslag, kanMottaEhf, settEhfNett, smlNavn, type Naptr } from "../src/peppol.js";

const NR = "974760673";
const SMP = "https://smp.elma-smp.no";
const elma = async (): Promise<Naptr[]> => [{ flags: "U", service: "Meta:SMP", regexp: "!.*!https://smp.elma-smp.no/!", order: 100, preference: 10 }];
const tjenester = (...typer: string[]) =>
  `<?xml version="1.0"?><ServiceGroup xmlns="http://busdox.org/serviceMetadata/publishing/1.0/"><ParticipantIdentifier scheme="iso6523-actorid-upis">0192:${NR}</ParticipantIdentifier><ServiceMetadataReferenceCollection>${typer
    .map((t) => `<ServiceMetadataReference href="${SMP}/iso6523-actorid-upis%3A%3A0192%3A${NR}/services/${encodeURIComponent(t)}"/>`)
    .join("")}</ServiceMetadataReferenceCollection></ServiceGroup>`;
const FAKTURA = "busdox-docid-qns::urn:oasis:names:specification:ubl:schema:xsd:Invoice-2::Invoice##urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0::2.1";
const ORDRE = "busdox-docid-qns::urn:oasis:names:specification:ubl:schema:xsd:Order-2::Order##urn:fdc:peppol.eu:poacc:trns:order:3::2.1";
const METADATA = `<?xml version="1.0"?><SignedServiceMetadata xmlns="http://busdox.org/serviceMetadata/publishing/1.0/"><ServiceMetadata><ServiceInformation><DocumentIdentifier scheme="busdox-docid-qns">${FAKTURA.slice(18)}</DocumentIdentifier></ServiceInformation></ServiceMetadata></SignedServiceMetadata>`;

const DIREKTE = `${SMP}/iso6523-actorid-upis%3A%3A0192%3A${NR}/services/${encodeURIComponent(FAKTURA)}`;
const DIREKTE_RA = `${SMP}/iso6523-actorid-upis::0192:${NR}/services/${FAKTURA.replace(/#/g, "%23")}`;
const LISTE = `${SMP}/iso6523-actorid-upis%3A%3A0192%3A${NR}`;
const LISTE_RA = `${SMP}/iso6523-actorid-upis::0192:${NR}`;

// Falske svar per adresse (alt annet: 404). Kastes en feil, er det nettverksfeil.
type Svar = { status: number; tekst?: string; json?: unknown } | Error;
function nett(svar: Record<string, Svar>) {
  const kall: string[] = [];
  const hent = (async (u: string) => {
    kall.push(u);
    const nokkel = Object.keys(svar).find((k) => (k.endsWith("*") ? u.startsWith(k.slice(0, -1)) : u === k));
    const s = nokkel ? svar[nokkel]! : { status: 404 };
    if (s instanceof Error) throw s;
    return new Response(s.json !== undefined ? JSON.stringify(s.json) : (s.tekst ?? ""), { status: s.status });
  }) as unknown as typeof fetch;
  return { hent, kall };
}
const dnsFeil = (code: string) => async () => {
  throw Object.assign(new Error(`queryNaptr ${code}`), { code });
};
const GOOGLE = "https://dns.google/resolve?*";
const CLOUDFLARE = "https://cloudflare-dns.com/dns-query?*";
const dohElma = { status: 200, json: { Status: 0, Answer: [{ type: 35, data: '100 10 "U" "Meta:SMP" "!.*!https://smp.elma-smp.no/!" .' }] } };

describe("PEPPOL-oppslag", () => {
  it("SML-navnet er base32 av SHA-256 av deltaker-id-en", () => {
    // Regnet ut uavhengig (Python: base64.b32encode(sha256("0192:974760673"))).
    expect(smlNavn(NR)).toBe("n7xqxd72mcn4tdkkox5hzpke3kwlv6txp5samlssxx7se6eoqndq.iso6523-actorid-upis.edelivery.tech.ec.europa.eu");
  });

  it("spør SMP-en direkte om EHF-fakturaen, slik avsenderne gjør", async () => {
    const n = nett({ [DIREKTE]: { status: 200, tekst: METADATA } });
    const r = await ehfOppslag(NR, { naptr: elma, hent: n.hent });
    expect(r).toMatchObject({ svar: true, smp: SMP });
    expect(n.kall).toEqual([DIREKTE]);
    expect(r.steg).toEqual(["DNS: https://smp.elma-smp.no", "SMP, EHF-faktura (kodet): HTTP 200"]);
  });

  it("prøver identifikatorene med :: når den kodede formen ikke finnes", async () => {
    const n = nett({ [DIREKTE_RA]: { status: 200, tekst: METADATA } });
    expect(await kanMottaEhf(NR, { naptr: elma, hent: n.hent })).toBe(true);
    expect(n.kall).toEqual([DIREKTE, DIREKTE_RA]);
  });

  it("leser tjenestelisten når dokumenttypen ikke svarer direkte", async () => {
    // Listen med EHF-faktura (også dobbelt kodet, og med «wildcard»-skjemaet).
    expect(await kanMottaEhf(NR, { naptr: elma, hent: nett({ [LISTE]: { status: 200, tekst: tjenester(ORDRE, FAKTURA) } }).hent })).toBe(true);
    const dobbel = tjenester(FAKTURA.replace("busdox-docid-qns", "peppol-doctype-wildcard")).replace(/%/g, "%25");
    expect(await kanMottaEhf(NR, { naptr: elma, hent: nett({ [LISTE]: { status: 200, tekst: dobbel } }).hent })).toBe(true);
    // Lister som SMP-en bare svarer på med :: i adressen.
    const n = nett({ [LISTE_RA]: { status: 200, tekst: tjenester(FAKTURA) } });
    expect(await kanMottaEhf(NR, { naptr: elma, hent: n.hent })).toBe(true);
    expect(n.kall).toEqual([DIREKTE, DIREKTE_RA, LISTE, LISTE_RA]);
    // Et svar på dokumenttypen som ikke er en tjeneste (f.eks. en feilside med 200), teller ikke.
    expect(await kanMottaEhf(NR, { naptr: elma, hent: nett({ [DIREKTE]: { status: 200, tekst: "<html>Ikke funnet</html>" } }).hent })).toBe(false);
  });

  it("ikke registrert, eller bare for andre dokumenter", async () => {
    const r = await ehfOppslag(NR, { naptr: elma, hent: nett({ [LISTE]: { status: 200, tekst: tjenester(ORDRE) } }).hent });
    expect(r.svar).toBe(false);
    expect(r.steg.at(-1)).toBe("1 dokumenttype: Order-2::Order##urn:fdc:peppol.eu:poacc:trns:order:3::2.1");
    // SMP-en kjenner ikke mottakeren.
    expect(await kanMottaEhf(NR, { naptr: elma, hent: nett({}).hent })).toBe(false);
    // Ikke i PEPPOL: DNS-en finner ingenting, og Google bekrefter det.
    const n = nett({ [GOOGLE]: { status: 200, json: { Status: 3 } } });
    expect(await ehfOppslag(NR, { naptr: dnsFeil("ENOTFOUND"), hent: n.hent })).toMatchObject({ svar: false, steg: ["DNS: ingen post", "DNS hos Google: ingen post"] });
    expect(n.kall).toHaveLength(1);
    expect(await kanMottaEhf("12345", { naptr: elma, hent: nett({}).hent })).toBe(false);
  });

  it("DNS-en i miljøet finner ingenting, men Google eller Cloudflare gjør det", async () => {
    const n = nett({ [GOOGLE]: dohElma, [DIREKTE]: { status: 200, tekst: METADATA } });
    const r = await ehfOppslag(NR, { naptr: dnsFeil("ENODATA"), hent: n.hent });
    expect(r).toMatchObject({ svar: true, smp: SMP });
    expect(r.steg.slice(0, 2)).toEqual(["DNS: ingen post", "DNS hos Google: !.*!https://smp.elma-smp.no/!"]);
    expect(n.kall[0]).toBe(`https://dns.google/resolve?name=${smlNavn(NR)}&type=NAPTR`);
    // Google svarer ikke: Cloudflare.
    const m = nett({ [GOOGLE]: new TypeError("fetch failed"), [CLOUDFLARE]: dohElma, [DIREKTE]: { status: 200, tekst: METADATA } });
    expect(await kanMottaEhf(NR, { naptr: dnsFeil("ETIMEOUT"), hent: m.hent })).toBe(true);
    expect(m.kall[1]).toBe(`https://cloudflare-dns.com/dns-query?name=${smlNavn(NR)}&type=NAPTR`);
  });

  it("ukjent når oppslaget feiler", async () => {
    // Ingen DNS svarer.
    const ingen = nett({ [GOOGLE]: { status: 502 }, [CLOUDFLARE]: new TypeError("fetch failed") });
    expect(await kanMottaEhf(NR, { naptr: dnsFeil("ETIMEOUT"), hent: ingen.hent })).toBe(null);
    // DNS-en sier nei, men det kan ikke bekreftes: nei, som før.
    expect(await kanMottaEhf(NR, { naptr: dnsFeil("ENOTFOUND"), hent: ingen.hent })).toBe(false);
    // SMP-en feiler eller avviser oss.
    expect(await kanMottaEhf(NR, { naptr: elma, hent: nett({ [`${SMP}/*`]: { status: 500 } }).hent })).toBe(null);
    expect(await kanMottaEhf(NR, { naptr: elma, hent: nett({ [`${SMP}/*`]: { status: 403 } }).hent })).toBe(null);
    expect(await kanMottaEhf(NR, { naptr: elma, hent: nett({ [`${SMP}/*`]: new TypeError("fetch failed") }).hent })).toBe(null);
  });
});

describe.skipIf(!process.env.DATABASE_URL)("EHF-test i Admin", () => {
  const app = lagApi();
  const kall = async (sti: string, k: unknown, hvem: string) => {
    const r = await app.request(sti, { method: "POST", headers: { authorization: hvem, "content-type": "application/json" }, body: JSON.stringify(k) });
    return { status: r.status, data: (await r.json()) as any };
  };
  afterEach(() => {
    settEhfNett();
    (config as any).adminEposter = [];
  });

  it("plattformadministratoren ser hvert steg i oppslaget", async () => {
    const admin = "Bearer test:uid-ehf-admin:ehf-admin@server.test:mfa";
    (config as any).adminEposter = ["ehf-admin@server.test"];
    settEhfNett({ naptr: elma, hent: nett({ [DIREKTE]: { status: 200, tekst: METADATA } }).hent });
    const r = await kall("/api/admin/ehf-test", { orgnr: "974 760 673" }, admin);
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ orgnr: NR, svar: true, smp: SMP, steg: ["DNS: https://smp.elma-smp.no", "SMP, EHF-faktura (kodet): HTTP 200"] });
    expect(typeof r.data.ms).toBe("number");
    expect((await kall("/api/admin/ehf-test", { orgnr: "1234" }, admin)).data.error).toBe("Skriv et org.nr. med ni siffer.");
    expect((await kall("/api/admin/ehf-test", { orgnr: NR }, "Bearer test:uid-ehf-x:x@server.test:mfa")).status).toBe(403);
  });
});
