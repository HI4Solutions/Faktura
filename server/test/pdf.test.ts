import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { lagPdf, type PdfFaktura } from "../src/pdf.js";
import { kr, summer, dato, orgnrGyldig } from "../src/regler.js";

const grunn: PdfFaktura = {
  type: "faktura",
  utkast: false,
  fakturanummer: 1000004,
  fakturadato: "2026-10-05",
  forfallsdato: "2026-10-19",
  kid: "01000110000014",
  selger: { navn: "Firma AS", orgnr: "923609016", mva_registrert: true, kontonr: "86011117947", adresse: "Gate 1", postnr: "0150", poststed: "Oslo" },
  kunde: { kundenummer: 10001, navn: "Kunde AS", orgnr: "974760673" },
  linjer: [{ beskrivelse: "Konsulenttime", antall: 2, enhetspris: 1000, mva_sats: 25 }],
};

describe("regler", () => {
  it("formaterer beløp og datoer", () => {
    expect(kr(1008.75)).toBe("1 008,75");
    expect(kr(-250)).toBe("-250,00");
    expect(dato("2026-10-05")).toBe("05.10.2026");
  });
  it("runder per linje som databasen", () => {
    expect(summer([{ beskrivelse: "x", antall: 3, enhetspris: 0.335, mva_sats: 25 }, { beskrivelse: "y", antall: 1, enhetspris: 8, mva_sats: 25 }]))
      .toEqual({ eks: 9.01, mva: 2.25, inkl: 11.26 });
  });
  it("sjekker organisasjonsnummer", () => {
    expect(orgnrGyldig("923609016")).toBe(true);
    expect(orgnrGyldig("923609017")).toBe(false);
  });
});

describe("PDF", () => {
  it("lager en gyldig én-sides faktura", async () => {
    const doc = await PDFDocument.load(await lagPdf(grunn));
    expect(doc.getPageCount()).toBe(1);
    expect(doc.getTitle()).toBe("FAKTURA 1000004");
  });

  it("bryter til flere sider når linjene ikke får plass", async () => {
    const linjer = Array.from({ length: 120 }, (_, i) => ({ beskrivelse: `Linje ${i + 1} med en lang beskrivelse som må brytes over flere linjer på fakturaen`, antall: 1, enhetspris: 10, mva_sats: 25 }));
    const doc = await PDFDocument.load(await lagPdf({ ...grunn, linjer }));
    expect(doc.getPageCount()).toBeGreaterThan(2);
  });

  it("tegner kreditnota og utkast med æøå", async () => {
    const doc = await PDFDocument.load(await lagPdf({ ...grunn, type: "kreditnota", utkast: true, fakturanummer: null, kunde: { navn: "Blåbær & Søtt ÆØÅ AS" } }));
    expect(doc.getTitle()).toBe("KREDITNOTAUTKAST tildeles ved sending");
  });
});

describe("PDF med logo og uten mva", () => {
  // 1x1 piksel PNG.
  const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));

  it("tar med logoen", async () => {
    const doc = await PDFDocument.load(await lagPdf({ ...grunn, logo: { bytes: png, type: "png" } }));
    expect(doc.getPageCount()).toBe(1);
  });

  it("et ødelagt bilde gir PDF uten logo, ikke feil", async () => {
    const doc = await PDFDocument.load(await lagPdf({ ...grunn, logo: { bytes: new Uint8Array([1, 2, 3]), type: "png" } }));
    expect(doc.getPageCount()).toBe(1);
  });

  it("lager faktura uten mva", async () => {
    const doc = await PDFDocument.load(
      await lagPdf({ ...grunn, selger: { ...grunn.selger, mva_registrert: false }, linjer: [{ beskrivelse: "Tjeneste", antall: 1, enhetspris: 500, mva_sats: 0 }] }),
    );
    expect(doc.getPageCount()).toBe(1);
  });
});
