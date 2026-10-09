// Betalingsfila (0076_lonn_betalingsfil.sql, betalingsfil.ts): lønnskontoen og BIC-en i
// lønnsoppsettet, feilene (utkast, mangler BIC eller kontonummer, den ansatte), fila for en godkjent
// kjøring (lønn med SALA, nettolønnen til hver ansatt, samme meldings-ID hver gang) som valideres mot
// ISO 20022-skjemaene (.03 og .09) når xmllint finnes, og merket på kjøringen.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { lagApi } from "../src/api.js";
import { settLokalOppgavekjorer } from "../src/tjenester.js";
import { lagBetalingsfil, meldingId } from "../src/betalingsfil.js";

const her = path.dirname(fileURLToPath(import.meta.url));
const harXmllint = spawnSync("xmllint", ["--version"]).status === 0;
function valider(xml: string, format: string) {
  const fil = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pain-")), "fil.xml");
  fs.writeFileSync(fil, xml);
  execFileSync("xmllint", ["--noout", "--schema", path.join(her, "xsd", `${format}.xsd`), fil], { stdio: "pipe" });
}

describe("betalingsfila (uten database)", () => {
  const grunn = {
    meldingId: "LONN-202611-ABCDEF1234",
    opprettet: "2026-11-19T10:15:00",
    avsender: { navn: "Hansen & Sønn AS", orgnr: "915000126" },
    fraKonto: "86011117947",
    bic: "DNBANOKK",
    dato: "2026-11-20",
    tekst: "Lønn november 2026",
    betalinger: [
      { navn: "Kari <Årsen>", kontonr: "12345678903", belop: 36750.5, referanse: "LONN-202611-ABCDEF1234-1" },
      { navn: "Per Olsen", kontonr: "86011117947", belop: 0.1 + 0.2, referanse: "LONN-202611-ABCDEF1234-2" },
    ],
  };

  it("lager pain.001.001.03 med lønn (SALA), summen og hver ansatt", () => {
    const xml = lagBetalingsfil({ format: "pain.001.001.03", ...grunn });
    expect(xml).toContain('<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.001.001.03">');
    expect(xml).toContain("<NbOfTxs>2</NbOfTxs>");
    expect(xml).toContain("<CtrlSum>36750.80</CtrlSum>");
    expect(xml).toContain("<CtgyPurp><Cd>SALA</Cd></CtgyPurp>");
    expect(xml).toContain("<BtchBookg>true</BtchBookg>");
    expect(xml).toContain("<ReqdExctnDt>2026-11-20</ReqdExctnDt>");
    expect(xml).toContain("<DbtrAgt><FinInstnId><BIC>DNBANOKK</BIC></FinInstnId></DbtrAgt>");
    expect(xml).toContain("<InitgPty><Nm>Hansen &amp; Sønn AS</Nm>");
    expect(xml).toContain("<Cdtr><Nm>Kari &lt;Årsen&gt;</Nm></Cdtr>");
    expect(xml).toContain('<InstdAmt Ccy="NOK">0.30</InstdAmt>');
    expect(xml).toContain("<CdtrAcct><Id><Othr><Id>12345678903</Id><SchmeNm><Cd>BBAN</Cd></SchmeNm></Othr></Id></CdtrAcct>");
    if (harXmllint) valider(xml, "pain.001.001.03");
  });

  it("lager pain.001.001.09 (dato og BIC i egne elementer)", () => {
    const xml = lagBetalingsfil({ format: "pain.001.001.09", ...grunn });
    expect(xml).toContain("<ReqdExctnDt><Dt>2026-11-20</Dt></ReqdExctnDt>");
    expect(xml).toContain("<BICFI>DNBANOKK</BICFI>");
    if (harXmllint) valider(xml, "pain.001.001.09");
  });

  it("meldings-ID-en er lik for samme godkjenning og ny når kjøringen godkjennes på nytt", () => {
    const a = meldingId("2026-11-01", "k1", "2026-11-19T10:00:00.000Z");
    expect(a).toMatch(/^LONN-202611-[0-9A-F]{10}$/);
    expect(meldingId("2026-11-01", "k1", "2026-11-19T10:00:00.000Z")).toBe(a);
    expect(meldingId("2026-11-01", "k1", "2026-11-19T11:00:00.000Z")).not.toBe(a);
  });
});

describe.skipIf(!process.env.DATABASE_URL)("betalingsfila fra lønnskjøringen", () => {
  const app = lagApi();
  const eier = "Bearer test:uid-betfil-eier:betfil-eier@server.test:mfa";
  const kariT = "Bearer test:uid-betfil-kari:kari.betfil@server.test";
  let org: string;
  let kari: string;
  let per: string;
  let k: any;

  const kall = async (m: string, sti: string, b?: unknown, hvem = eier) => {
    const r = await app.request(sti, { method: m, headers: { authorization: hvem, "content-type": "application/json" }, body: b === undefined ? undefined : JSON.stringify(b) });
    const type = r.headers.get("content-type") ?? "";
    return { status: r.status, type, navn: r.headers.get("content-disposition"), data: type.includes("json") ? ((await r.json()) as any) : await r.text() };
  };

  beforeAll(async () => {
    settLokalOppgavekjorer(async () => undefined);
    org = (await kall("POST", "/api/organisasjoner", { navn: "Betalingsfil Test AS" })).data.id;
    expect((await kall("PUT", `/api/org/${org}/lonn-oppsett`, { aktiv: true })).status).toBe(200);
    const ny = async (b: Record<string, unknown>) => (await kall("POST", `/api/org/${org}/ansatte`, { ansatt_fra: "2025-01-01", ...b })).data.id as string;
    kari = await ny({ fornavn: "Kari", etternavn: "Betal", lonnstype: "maaned", maanedslonn: 40000, kontonr: "12345678903", skattekort: "prosent", skatt_prosent: 30, epost: "kari.betfil@server.test" });
    per = await ny({ fornavn: "Per", etternavn: "Utenkonto", lonnstype: "maaned", maanedslonn: 20000, skattekort: "prosent", skatt_prosent: 20 });
    const inv = await kall("POST", `/api/org/${org}/ansatte/${kari}/inviter`);
    expect((await kall("POST", "/api/invitasjoner/aksepter", { token: inv.data.lenke.split("/").pop() }, kariT)).status).toBe(200);
    k = (await kall("POST", `/api/org/${org}/lonn/kjoringer`, { periode: "2026-11" })).data;
  });

  it("lønnskontoen, BIC-en og formatet i lønnsoppsettet", async () => {
    expect((await kall("PUT", `/api/org/${org}/lonn-oppsett`, { lonnskonto: "12345678901" })).data.error).toBe("Lønnskontoen er ikke gyldig (sjekk sifrene)");
    expect((await kall("PUT", `/api/org/${org}/lonn-oppsett`, { bank_bic: "DNB" })).data.error).toBe("BIC har 8 eller 11 tegn, f.eks. DNBANOKK for DNB");
    expect((await kall("GET", `/api/org/${org}/lonn-oppsett`)).data).toMatchObject({ lonnskonto: null, bank_bic: null, betalingsfil_format: "pain.001.001.03" });
  });

  it("feilene: utkast, mangler BIC, mangler kontonummer, og den ansatte", async () => {
    const sti = `/api/org/${org}/lonn/kjoringer/${k.id}/betalingsfil`;
    expect((await kall("POST", sti)).data.error).toBe("Godkjenn lønnen før betalingsfila lastes ned");
    k = (await kall("POST", `/api/org/${org}/lonn/kjoringer/${k.id}/godkjenn`)).data;
    expect(k.status).toBe("godkjent");
    expect((await kall("POST", sti)).data.error).toBe("Legg inn lønnskontoen (kontoen lønnen betales fra) under Innstillinger → Ansatte og timer.");
    expect((await kall("PUT", `/api/org/${org}/lonn-oppsett`, { lonnskonto: "8601 11 17947" })).data.lonnskonto).toBe("86011117947");
    expect((await kall("POST", sti)).data.error).toBe("Legg inn BIC for banken lønnskontoen er i (står i nettbanken, f.eks. DNBANOKK for DNB) under Innstillinger → Ansatte og timer.");
    expect((await kall("PUT", `/api/org/${org}/lonn-oppsett`, { bank_bic: "dnba nokk" })).data.bank_bic).toBe("DNBANOKK");
    expect((await kall("POST", sti)).data.error).toBe("Mangler gyldig kontonummer: Per Utenkonto. Legg det inn på den ansatte.");
    // Den ansatte ser ikke kjøringen.
    expect((await kall("POST", sti, undefined, kariT)).status).toBe(404);
    // Ingenting er lastet ned ennå.
    expect((await kall("GET", `/api/org/${org}/lonn/kjoringer/${k.id}`)).data).toMatchObject({ betalingsfil_lastet: null, betalingsfil_antall: 0 });
  });

  it("fila for den godkjente kjøringen, med samme meldings-ID hver gang, og merket", async () => {
    // Kontonummeret lagt inn etter godkjenningen brukes.
    expect((await kall("PATCH", `/api/org/${org}/ansatte/${per}`, { kontonr: "86011117947" })).status).toBe(200);
    const sti = `/api/org/${org}/lonn/kjoringer/${k.id}/betalingsfil`;
    const f = await kall("POST", sti);
    expect(f.status, String(f.data?.error ?? "")).toBe(200);
    expect(f.type).toBe("application/xml; charset=utf-8");
    expect(f.navn).toBe('attachment; filename="lonn-2026-11.xml"');
    const xml = f.data as string;
    const sk = (id: string) => k.slipper.find((s: any) => s.ansatt_id === id);
    const sum = (sk(kari).netto + sk(per).netto).toFixed(2);
    expect(xml).toContain(`<CtrlSum>${sum}</CtrlSum>`);
    expect(xml).toContain("<CtgyPurp><Cd>SALA</Cd></CtgyPurp>");
    expect(xml).toContain(`<ReqdExctnDt>${k.utbetalingsdato}</ReqdExctnDt>`);
    expect(xml).toContain("<Dbtr><Nm>Betalingsfil Test AS</Nm></Dbtr>");
    expect(xml).toContain("<DbtrAcct><Id><Othr><Id>86011117947</Id>");
    expect(xml).toContain(`<InstdAmt Ccy="NOK">${sk(kari).netto.toFixed(2)}</InstdAmt>`);
    expect(xml).toContain("<Cdtr><Nm>Kari Betal</Nm></Cdtr>");
    expect(xml).toContain("<RmtInf><Ustrd>Lønn november 2026</Ustrd></RmtInf>");
    if (harXmllint) valider(xml, "pain.001.001.03");
    const mid = xml.match(/<MsgId>(.*)<\/MsgId>/)![1];

    const igjen = (await kall("POST", sti)).data as string;
    expect(igjen.match(/<MsgId>(.*)<\/MsgId>/)![1]).toBe(mid);
    const kj = (await kall("GET", `/api/org/${org}/lonn/kjoringer/${k.id}`)).data;
    expect(kj).toMatchObject({ betalingsfil_antall: 2, betalingsfil_av: "betfil-eier@server.test" });
    expect(kj.betalingsfil_lastet).toBeTruthy();

    // .09 når det er valgt.
    expect((await kall("PUT", `/api/org/${org}/lonn-oppsett`, { betalingsfil_format: "pain.001.001.09" })).status).toBe(200);
    const ni = (await kall("POST", sti)).data as string;
    expect(ni).toContain("urn:iso:std:iso:20022:tech:xsd:pain.001.001.09");
    if (harXmllint) valider(ni, "pain.001.001.09");
  });
});
