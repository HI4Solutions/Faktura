// Oppslag i PEPPOL (SML via DNS og SMP), med falske svar.
import { describe, expect, it } from "vitest";
import { kanMottaEhf, smlNavn } from "../src/peppol.js";

const elma = async () => [{ flags: "U", service: "Meta:SMP", regexp: "!.*!https://smp.elma-smp.no/!", order: 100, preference: 10 }];
const tjenester = (...typer: string[]) =>
  `<?xml version="1.0"?><ServiceGroup xmlns="http://busdox.org/serviceMetadata/publishing/1.0/"><ParticipantIdentifier scheme="iso6523-actorid-upis">0192:974760673</ParticipantIdentifier><ServiceMetadataReferenceCollection>${typer
    .map((t) => `<ServiceMetadataReference href="https://smp.elma-smp.no/iso6523-actorid-upis%3A%3A0192%3A974760673/services/${encodeURIComponent(t)}"/>`)
    .join("")}</ServiceMetadataReferenceCollection></ServiceGroup>`;
const FAKTURA = "busdox-docid-qns::urn:oasis:names:specification:ubl:schema:xsd:Invoice-2::Invoice##urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0::2.1";
const ORDRE = "busdox-docid-qns::urn:oasis:names:specification:ubl:schema:xsd:Order-2::Order##urn:fdc:peppol.eu:poacc:trns:order:3::2.1";
const svar = (status: number, tekst = "") => (async () => new Response(tekst, { status })) as unknown as typeof fetch;

describe("PEPPOL-oppslag", () => {
  it("SML-navnet er base32 av SHA-256 av deltaker-id-en", () => {
    // Regnet ut uavhengig (Python: base64.b32encode(sha256("0192:974760673"))).
    expect(smlNavn("974760673")).toBe("n7xqxd72mcn4tdkkox5hzpke3kwlv6txp5samlssxx7se6eoqndq.iso6523-actorid-upis.edelivery.tech.ec.europa.eu");
  });

  it("mottaker som tar imot EHF-faktura", async () => {
    let url = "";
    const hent = (async (u: string) => {
      url = u;
      return new Response(tjenester(ORDRE, FAKTURA), { status: 200 });
    }) as unknown as typeof fetch;
    expect(await kanMottaEhf("974760673", { naptr: elma, hent })).toBe(true);
    expect(url).toBe("https://smp.elma-smp.no/iso6523-actorid-upis%3A%3A0192%3A974760673");
    // Dobbelt kodede lenker og «wildcard»-skjemaet godtas også.
    const dobbel = tjenester(FAKTURA.replace("busdox-docid-qns", "peppol-doctype-wildcard")).replace(/%/g, "%25");
    expect(await kanMottaEhf("974760673", { naptr: elma, hent: svar(200, dobbel) })).toBe(true);
  });

  it("ikke registrert, eller bare for andre dokumenter", async () => {
    expect(await kanMottaEhf("974760673", { naptr: elma, hent: svar(200, tjenester(ORDRE)) })).toBe(false);
    expect(await kanMottaEhf("974760673", { naptr: elma, hent: svar(404) })).toBe(false);
    const finnesIkke = async () => {
      throw Object.assign(new Error("queryNaptr ENOTFOUND"), { code: "ENOTFOUND" });
    };
    expect(await kanMottaEhf("974760673", { naptr: finnesIkke })).toBe(false);
    expect(await kanMottaEhf("12345", { naptr: elma })).toBe(false);
  });

  it("ukjent når oppslaget feiler", async () => {
    const tidsavbrudd = async () => {
      throw Object.assign(new Error("queryNaptr ETIMEOUT"), { code: "ETIMEOUT" });
    };
    expect(await kanMottaEhf("974760673", { naptr: tidsavbrudd })).toBe(null);
    expect(await kanMottaEhf("974760673", { naptr: elma, hent: svar(500) })).toBe(null);
    const nettfeil = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    expect(await kanMottaEhf("974760673", { naptr: elma, hent: nettfeil })).toBe(null);
  });
});
