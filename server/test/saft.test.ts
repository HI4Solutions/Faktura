// SAF-T Regnskap (saft.ts): grupperingen etter næringsspesifikasjonen, og filen for et år fra bilagene
// (fakturaer med og uten avgift, innbetalinger, utgifter med fradrag og fra utlandet, betalingen og et
// manuelt bilag): headeren, kontoene med saldo, kundene og leverandørene, mva-kodene, journalene med
// mva-informasjonen på grunnlagslinjene, og at filen er gyldig etter Skatteetatens XSD (1.30 og 1.40).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { XMLParser } from "fast-xml-parser";
import { beforeAll, describe, expect, it } from "vitest";
import { lagApi } from "../src/api.js";
import { gruppering } from "../src/saft.js";
import { settLokalOppgavekjorer } from "../src/tjenester.js";

const her = path.dirname(fileURLToPath(import.meta.url));
const harXmllint = spawnSync("xmllint", ["--version"]).status === 0;

describe("SAF-T: grupperingen", () => {
  it("kontoene i standard kontoplan får kategorien og koden i næringsspesifikasjonen", () => {
    const g = (k: string) => {
      const x = gruppering(k);
      return `${x.kategori} ${x.kode}`;
    };
    expect(
      ["1250", "1280", "1500", "1920", "2050", "2400", "2600", "2700", "2714", "2740", "2785", "2940", "2960", "3000", "3030", "3200", "3900"].map(g),
    ).toEqual([
      "balanseverdiForAnleggsmiddel 1205",
      "balanseverdiForAnleggsmiddel 1280",
      "balanseverdiForOmloepsmiddel 1500",
      "balanseverdiForOmloepsmiddel 1920",
      "egenkapital 2050",
      "kortsiktigGjeld 2400",
      "kortsiktigGjeld 2600",
      "kortsiktigGjeld 2740",
      "kortsiktigGjeld 2740",
      "kortsiktigGjeld 2740",
      "kortsiktigGjeld 2770",
      "kortsiktigGjeld 2949",
      "kortsiktigGjeld 2990",
      "salgsinntekt 3000",
      "salgsinntekt 3000",
      "salgsinntekt 3200",
      "annenDriftsinntekt 3900",
    ]);
    expect(["5000", "5405", "5800", "6010", "6300", "6420", "6800", "6900", "7140", "7150", "7740", "7800", "8050", "8150", "8300", "8960"].map(g)).toEqual([
      "loennskostnad 5000",
      "loennskostnad 5400",
      "loennskostnad 5000",
      "annenDriftskostnad 6000",
      "annenDriftskostnad 6300",
      "annenDriftskostnad 6350",
      "annenDriftskostnad 6995",
      "annenDriftskostnad 6995",
      "annenDriftskostnad 7165",
      "annenDriftskostnad 7155",
      "annenDriftskostnad 7700",
      "annenDriftskostnad 7880",
      "finansinntekt 8050",
      "finanskostnad 8150",
      "skattekostnad 8300",
      "resultatDisponeringForSAF-T 8800",
    ]);
  });
});

describe.skipIf(!process.env.DATABASE_URL)("SAF-T-filen", () => {
  const app = lagApi();
  const eier = "Bearer test:uid-saft-eier:saft-eier@server.test:mfa";
  const fakturerer = "Bearer test:uid-saft-fakt:saft-fakt@server.test:mfa";
  let org = "";
  let xml = "";
  let filnavn = "";
  const kall = async (metode: string, sti: string, kropp?: unknown, hvem = eier) => {
    const r = await app.request(sti, { method: metode, headers: { authorization: hvem, "content-type": "application/json" }, body: kropp === undefined ? undefined : JSON.stringify(kropp) });
    const type = r.headers.get("content-type") ?? "";
    return { status: r.status, data: type.includes("json") ? ((await r.json()) as any) : await r.text(), disp: r.headers.get("content-disposition") };
  };
  const ok = async (metode: string, sti: string, kropp?: unknown) => {
    const r = await kall(metode, sti, kropp);
    expect(r.status, `${metode} ${sti}: ${JSON.stringify(r.data)}`).toBeLessThan(300);
    return r.data;
  };
  const o = (x: string) => `/api/org/${org}${x}`;
  const liste = <T>(x: T | T[] | undefined): T[] => (x === undefined ? [] : Array.isArray(x) ? x : [x]);

  beforeAll(async () => {
    settLokalOppgavekjorer(async () => {});
    org = (await ok("POST", "/api/organisasjoner", { navn: "SAF-T Legesenter AS", orgnr: "915000533" })).id;
    await ok("PATCH", o(""), { kontonr: "86011117947", mva_registrert: true, adresse: "Fjordgata 1", postnr: "5003", poststed: "Bergen", epost: "post@saft.test" });
    const inv = await ok("POST", o("/invitasjoner"), { epost: "saft-fakt@server.test", rolle: "fakturerer" });
    expect((await kall("POST", "/api/invitasjoner/aksepter", { token: inv.lenke.split("/").pop() }, fakturerer)).status).toBe(200);
    const kunde = (await ok("POST", o("/kunder"), { navn: "Vestland Forsikring AS", orgnr: "915000541", epost: "post@vestland.test" })).id;
    // 2025: en legeerklæring med 25 % og en konsultasjon uten avgift, innbetalingen, telefonen (fradrag),
    // en nettjeneste fra utlandet, betalingen av telefonen og et manuelt bilag.
    const f = await ok("POST", o("/fakturaer"), {
      kunde_id: kunde,
      fakturadato: "2025-03-10",
      forfallsdato: "2025-03-24",
      linjer: [
        { beskrivelse: "Legeerklæring", antall: 2, enhetspris: 1000, mva_sats: 25 },
        { beskrivelse: "Konsultasjon", antall: 1, enhetspris: 600, mva_sats: 0 },
      ],
    });
    await ok("POST", o(`/fakturaer/${f.id}/utsted`), { send_epost: false });
    await ok("POST", o(`/fakturaer/${f.id}/betalinger`), { belop: 1000, dato: "2025-03-20" });
    const tel = await ok("POST", o("/regnskap/utgifter"), {
      type: "faktura",
      leverandor: "Telenor Norge AS",
      orgnr: "976967631",
      dato: "2025-04-10",
      forfallsdato: "2025-04-24",
      belop: 1250,
      linjer: [{ kategori: "telefon", konto: "6900", belop: 1000, mva_sats: 25, mva: 250 }],
    });
    await ok("POST", o(`/regnskap/utgifter/${tel.id}/bokfor`));
    await ok("POST", o(`/regnskap/utgifter/${tel.id}/betal`), { dato: "2025-04-20", fra: "bank" });
    const sky = await ok("POST", o("/regnskap/utgifter"), {
      type: "faktura",
      leverandor: "Nordic Cloud Ltd",
      dato: "2025-05-02",
      forfallsdato: "2025-05-16",
      belop: 400,
      utland: true,
      linjer: [{ kategori: "programvare", konto: "6420", belop: 400, mva_sats: 0, mva: 0 }],
    });
    await ok("POST", o(`/regnskap/utgifter/${sky.id}/bokfor`));
    await ok("POST", o("/regnskap/bilag"), { dato: "2025-01-02", tekst: "Aksjekapital", linjer: [{ konto: "1920", debet: 30000 }, { konto: "2000", kredit: 30000 }] });
    const r = await kall("GET", o("/regnskap/saft?aar=2025"));
    expect(r.status, String(r.data)).toBe(200);
    xml = r.data;
    filnavn = r.disp ?? "";
  });

  it("headeren, kontoene, kundene, leverandørene og mva-kodene", () => {
    expect(filnavn).toMatch(/^attachment; filename="SAF-T Financial_915000533_\d{14}\.xml"$/);
    const a = new XMLParser({ parseTagValue: false }).parse(xml).AuditFile;
    expect(a.Header).toMatchObject({
      AuditFileVersion: "1.30",
      AuditFileCountry: "NO",
      SoftwareID: "HI4 Faktura",
      Company: { RegistrationNumber: "915000533", Name: "SAF-T Legesenter AS", Address: { StreetName: "Fjordgata 1", City: "Bergen", PostalCode: "5003", Country: "NO" } },
      DefaultCurrencyCode: "NOK",
      SelectionCriteria: { PeriodStart: "1", PeriodStartYear: "2025", PeriodEnd: "12", PeriodEndYear: "2025" },
      TaxAccountingBasis: "A",
    });
    expect(a.Header.Company.TaxRegistration).toMatchObject({ TaxRegistrationNumber: "915000533", TaxType: "MVA", TaxAuthority: "Skatteetaten" });
    const kontoer = liste<any>(a.MasterFiles.GeneralLedgerAccounts.Account);
    const konto = (id: string) => kontoer.find((x) => x.AccountID === id);
    expect(konto("1920")).toMatchObject({ GroupingCategory: "balanseverdiForOmloepsmiddel", GroupingCode: "1920", AccountType: "GL", OpeningDebitBalance: "0.00" });
    expect(konto("3000")).toMatchObject({ AccountDescription: "Salgsinntekt, avgiftspliktig", GroupingCategory: "salgsinntekt", GroupingCode: "3000", ClosingCreditBalance: "2000.00" });
    expect(konto("1500")).toMatchObject({ ClosingDebitBalance: "2100.00" });
    expect(konto("2700")).toMatchObject({ GroupingCode: "2740", ClosingCreditBalance: "500.00" });
    const kunde = liste<any>(a.MasterFiles.Customers.Customer)[0];
    expect(kunde).toMatchObject({ RegistrationNumber: "915000541", Name: "Vestland Forsikring AS", CustomerID: "10001", BalanceAccount: { AccountID: "1500", OpeningDebitBalance: "0.00", ClosingDebitBalance: "2100.00" } });
    const lev = liste<any>(a.MasterFiles.Suppliers.Supplier);
    expect(lev.map((x) => [x.SupplierID, x.Name, x.BalanceAccount.ClosingDebitBalance ?? `-${x.BalanceAccount.ClosingCreditBalance}`])).toEqual([
      ["976967631", "Telenor Norge AS", "0.00"],
      ["L-NORDIC-CLOUD-LTD", "Nordic Cloud Ltd", "-400.00"],
    ]);
    const koder = liste<any>(a.MasterFiles.TaxTable.TaxTableEntry.TaxCodeDetails);
    expect(koder.map((x) => [x.TaxCode, x.TaxPercentage, x.StandardTaxCode, x.BaseRate])).toEqual([
      ["1", "25", "1", "100"],
      ["3", "25", "3", "100"],
      ["6", "0", "6", "100"],
      ["86", "25", "86", "100"],
    ]);
  });

  it("journalene: mva-informasjonen på grunnlagslinjene, kunden og leverandøren på reskontrolinjene, og summene", () => {
    const a = new XMLParser({ parseTagValue: false }).parse(xml).AuditFile;
    const gl = a.GeneralLedgerEntries;
    expect(gl.TotalDebit).toBe(gl.TotalCredit);
    const journaler = liste<any>(gl.Journal);
    expect(journaler.map((j) => j.JournalID)).toEqual(["F", "B", "U", "M"]);
    const tr = journaler.flatMap((j) => liste<any>(j.Transaction));
    expect(Number(gl.NumberOfEntries)).toBe(tr.length);
    const faktura = tr.find((x) => x.TransactionID === "F-2025-1");
    expect(faktura).toMatchObject({ Period: "3", PeriodYear: "2025", TransactionDate: "2025-03-10", VoucherType: "faktura" });
    const linjer = liste<any>(faktura.Line);
    const salg = linjer.find((l) => l.AccountID === "3000");
    expect(salg.TaxInformation).toEqual({ TaxType: "MVA", TaxCode: "3", TaxPercentage: "25", Country: "NO", TaxBase: "2000.00", CreditTaxAmount: { Amount: "500.00" } });
    expect(linjer.find((l) => l.AccountID === "3200").TaxInformation).toMatchObject({ TaxCode: "6", TaxPercentage: "0", TaxBase: "600.00", CreditTaxAmount: { Amount: "0.00" } });
    expect(linjer.find((l) => l.AccountID === "2700").TaxInformation).toBeUndefined();
    expect(linjer.find((l) => l.AccountID === "1500")).toMatchObject({ CustomerID: "10001", DebitAmount: { Amount: "3100.00" } });
    const tel = tr.find((x) => x.Description.includes("Telenor") && liste<any>(x.Line).some((l: any) => l.AccountID === "6900"));
    expect(liste<any>(tel.Line).find((l) => l.AccountID === "6900").TaxInformation).toMatchObject({ TaxCode: "1", TaxBase: "1000.00", DebitTaxAmount: { Amount: "250.00" } });
    expect(liste<any>(tel.Line).find((l) => l.AccountID === "2400")).toMatchObject({ SupplierID: "976967631", CreditAmount: { Amount: "1250.00" } });
    const sky = tr.find((x) => liste<any>(x.Line).some((l: any) => l.AccountID === "6420"));
    expect(liste<any>(sky.Line).find((l) => l.AccountID === "6420").TaxInformation).toMatchObject({ TaxCode: "86", TaxPercentage: "25", TaxBase: "400.00", DebitTaxAmount: { Amount: "100.00" } });
  });

  it.skipIf(!harXmllint)("filen er gyldig etter Skatteetatens XSD (1.30, og 1.40 som gjelder fra 2027)", () => {
    const mappe = fs.mkdtempSync(path.join(os.tmpdir(), "saft-"));
    for (const v of ["1.30", "1.40"]) {
      const fil = path.join(mappe, `saft-${v}.xml`);
      fs.writeFileSync(fil, xml.replace("<AuditFileVersion>1.30</AuditFileVersion>", `<AuditFileVersion>${v}</AuditFileVersion>`));
      const r = spawnSync("xmllint", ["--noout", "--schema", path.join(her, "saft", `Norwegian_SAF-T_Financial_Schema_v_${v}.xsd`), fil], { encoding: "utf8" });
      expect(r.status, `${v}: ${r.stderr}`).toBe(0);
    }
  });

  it("organisasjonsnummer, år uten bilag og tilgangen", async () => {
    expect((await kall("GET", o("/regnskap/saft?aar=2019"))).data.error).toBe("Ingen bilag i regnskapet for 2019");
    expect((await kall("GET", o("/regnskap/saft?aar=2025"), undefined, fakturerer)).status).toBe(403);
    const uten = (await ok("POST", "/api/organisasjoner", { navn: "Uten orgnr AS" })).id;
    expect((await kall("GET", `/api/org/${uten}/regnskap/saft?aar=2025`)).data.error).toBe("SAF-T krever organisasjonsnummer (Innstillinger → Organisasjon)");
  });
});
