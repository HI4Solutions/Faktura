// Underenhetene til a-meldingen (brreg.ts): testbedriftene (organisasjonsnumre som begynner på 2
// eller 3, testdataene fra Tenor) slås opp i Brønnøysundregistrenes testmiljø, de ekte i
// Enhetsregisteret.
import { afterEach, describe, expect, it, vi } from "vitest";
import { erTestbedrift, hentUnderenheter } from "../src/brreg.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

const svar = (underenheter: object[]) => ({
  ok: true,
  status: 200,
  json: async () => (underenheter.length ? { _embedded: { underenheter }, page: { totalElements: underenheter.length } } : { page: { totalElements: 0 } }),
});

describe("underenhetene til a-meldingen", () => {
  it("testbedriftene slås opp i testmiljøet, de ekte i Enhetsregisteret", async () => {
    const hent = vi.fn(async (_url: string) => svar([]));
    vi.stubGlobal("fetch", hent);
    expect(await hentUnderenheter("314140729")).toEqual([]);
    expect(await hentUnderenheter("910000071")).toEqual([]);
    expect(hent.mock.calls.map((k) => k[0])).toEqual([
      "https://data.ppe.brreg.no/enhetsregisteret/api/underenheter?overordnetEnhet=314140729&size=50",
      "https://data.brreg.no/enhetsregisteret/api/underenheter?overordnetEnhet=910000071&size=50",
    ]);
    expect(["314140729", "214140729", "910000071", "810000001", "31414072"].map(erTestbedrift)).toEqual([true, true, false, false, false]);
  });

  it("navnet og adressen, uten de nedlagte", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        svar([
          { organisasjonsnummer: "315000001", navn: "KOMFORTABEL PÅLITELIG APE AVD OSLO", beliggenhetsadresse: { adresse: ["Testveien 1"], postnummer: "0150", poststed: "OSLO" } },
          { organisasjonsnummer: "315000002", navn: "NEDLAGT", nedleggelsesdato: "2024-01-01" },
        ]),
      ),
    );
    expect(await hentUnderenheter("314140729")).toEqual([{ orgnr: "315000001", navn: "KOMFORTABEL PÅLITELIG APE AVD OSLO", adresse: "Testveien 1, 0150 OSLO" }]);
  });

  it("feil fra registeret og ugyldige numre", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })),
    );
    await expect(hentUnderenheter("314140729")).rejects.toMatchObject({ status: 502 });
    await expect(hentUnderenheter("314140728")).rejects.toMatchObject({ status: 400 });
  });
});
