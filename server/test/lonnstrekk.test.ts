// Faste trekk i lønnen (0082_lonnstrekk.sql, lonnstrekk.ts, lonnBetalinger.ts): rekkefølgen og
// grensene (bidrag før utlegg, aldri mer enn nettolønnen, til summen er trukket, hele kroner for
// pålegg), fagforeningskontingenten som gjør grunnlaget for skattetrekket mindre, betalingsfila med
// forskuddstrekket og trekkene første virkedag etter (KID som SCOR), a-meldingen (fradrag,
// utleggstrekk og «ordinaert» forskuddstrekk), lønnsbilaget med egne kontoer, og i appen: trekkene
// på den ansatte, lønnskjøringen, betalingene med KID-en, avslutning av trekk og rapporten
// «Trekk og betalinger».
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { lagApi } from "../src/api.js";
import { byggLeveranse, hentGrunnlag, tilXml, type Grunnlag } from "../src/amelding.js";
import { lagBetalingsfil } from "../src/betalingsfil.js";
import { somSystem } from "../src/db.js";
import { lagLonnsbilag } from "../src/lonnBokforing.js";
import { summer, type Ansatt, type Linje, type Oppsett } from "../src/lonnsberegning.js";
import { aktive, fagforeningslinjer, trekkEtterSkatt, type Lonnstrekk } from "../src/lonnstrekk.js";
import { settLokalOppgavekjorer } from "../src/tjenester.js";

const her = path.dirname(fileURLToPath(import.meta.url));
const harXmllint = spawnSync("xmllint", ["--version"]).status === 0;
function valider(xml: string, skjema: string) {
  if (!harXmllint) return;
  const fil = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "trekk-")), "fil.xml");
  fs.writeFileSync(fil, xml);
  execFileSync("xmllint", ["--noout", "--schema", path.join(her, "xsd", `${skjema}.xsd`), fil], { stdio: "pipe" });
}

const trekk = (id: string, x: Partial<Lonnstrekk>): Lonnstrekk => ({
  id,
  ansatt_id: "ola",
  type: "annet",
  tekst: null,
  belop: null,
  prosent: null,
  totalt: null,
  fra: "2026-01-01",
  til: null,
  mottaker: null,
  kontonr: null,
  kid: null,
  melding: null,
  ...x,
});
const ingen = () => 0;

describe("trekkene (uten database)", () => {
  it("de som gjelder i perioden, i rekkefølgen dekningsloven gir", () => {
    const liste = aktive(
      [
        trekk("a", { type: "annet", belop: 100 }),
        trekk("u", { type: "utlegg_samordnet", belop: 100 }),
        trekk("b", { type: "bidrag", belop: 100 }),
        trekk("f", { type: "forskudd", belop: 100 }),
        trekk("gammel", { type: "bidrag", belop: 100, til: "2026-09-30" }),
        trekk("ny", { type: "bidrag", belop: 100, fra: "2026-11-01" }),
      ],
      "2026-10-01",
      "2026-10-31",
    );
    expect(liste.map((t) => t.id)).toEqual(["b", "u", "f", "a"]);
  });

  it("fagforeningskontingenten: prosent av bruttolønnen eller et beløp", () => {
    expect(fagforeningslinjer([trekk("f", { type: "fagforening", prosent: 1.4, tekst: "Fellesforbundet" })], 40000, ingen)).toEqual([
      { lonnsart: "fagforening", tekst: "Fagforeningskontingent – Fellesforbundet", antall: null, sats: 1.4, belop: -560, nokkel: "trekk:f" },
    ]);
    expect(fagforeningslinjer([trekk("f", { type: "fagforening", belop: 450 })], 40000, ingen).map((l) => l.belop)).toEqual([-450]);
  });

  it("etter skatt: bidrag før utlegg, aldri mer enn nettolønnen, og hele kroner for pålegg", () => {
    const t = trekkEtterSkatt(
      [trekk("b", { type: "bidrag", belop: 3000 }), trekk("u", { type: "utlegg_samordnet", prosent: 12.5 }), trekk("a", { type: "annet", belop: 100, tekst: "Kantine" })],
      40001,
      8000.5,
      ingen,
    );
    // 12,5 % av 40 001 er 5 000,125: 5 000 kr; nettolønnen etter bidraget rekker til 5 000.
    expect(t.linjer.map((l) => [l.lonnsart, l.tekst, l.belop])).toEqual([
      ["bidragstrekk", "Bidragstrekk", -3000],
      ["utleggstrekk_samordnet", "Utleggstrekk (samordnet, Skatteetaten)", -5000],
      ["trekk_etter_skatt", "Trekk – Kantine", -0.5],
    ]);
    expect(t.merknader).toEqual(["Trekk – Kantine er redusert til 0,50 kr fordi nettolønnen ikke rekker (trekket er 100 kr)."]);
    // Ingenting igjen: ikke trukket.
    expect(trekkEtterSkatt([trekk("u", { type: "utlegg_skatt", belop: 2000 })], 1000, 0, ingen)).toEqual({
      linjer: [],
      merknader: ["Utleggstrekk for skattekrav er ikke trukket fordi nettolønnen ikke rekker (trekket er 2 000 kr)."],
    });
  });

  it("til summen er trukket", () => {
    const forskudd = trekk("f", { type: "forskudd", belop: 2000, totalt: 5000 });
    expect(trekkEtterSkatt([forskudd], 40000, 30000, ingen).linjer.map((l) => [l.tekst, l.belop])).toEqual([["Tilbakebetaling av forskudd (3 000 kr igjen)", -2000]]);
    expect(trekkEtterSkatt([forskudd], 40000, 30000, () => 4000).linjer.map((l) => [l.tekst, l.belop])).toEqual([["Tilbakebetaling av forskudd (siste trekk)", -1000]]);
    expect(trekkEtterSkatt([forskudd], 40000, 30000, () => 5000)).toEqual({ linjer: [], merknader: ["Tilbakebetaling av forskudd er ferdig trukket (5 000 kr)."] });
  });

  it("fagforeningskontingenten gjør grunnlaget for skattetrekket mindre (en tolvdel av det årlige fradraget)", () => {
    const a = { id: "ola", skattekort: "prosent", skatt_prosent: 30, skattekort_aar: 2026 } as unknown as Ansatt;
    const o = { otp_prosent: 0, feriepenger_prosent: 12 } as unknown as Oppsett;
    const t = { ansatt: a, aar: 2026, ekstra: false, halvSkatt: false, tabell: null, frikortBrukt: 0 };
    const lonn: Linje = { lonnsart: "fastlonn", tekst: "Fastlønn", antall: 1, sats: 40000, belop: 40000, nokkel: "fastlonn" };
    const fag = (belop: number): Linje => ({ lonnsart: "fagforening", tekst: "Fagforeningskontingent", antall: null, sats: null, belop: -belop, nokkel: "trekk:f" });
    expect(summer([lonn], o, t, "2026-10-20", null)).toMatchObject({ trekkgrunnlag: 40000, skattetrekk: 12000, netto: 28000 });
    expect(summer([lonn, fag(560)], o, t, "2026-10-20", null)).toMatchObject({ trekkgrunnlag: 39440, skattetrekk: 11832, trekk_etter_skatt: -560, netto: 27608 });
    // Over en tolvdel av 8 700 kr (725 kr): bare 725 kr i grunnlaget.
    expect(summer([lonn, fag(1000)], o, t, "2026-10-20", null)).toMatchObject({ trekkgrunnlag: 39275, skattetrekk: 11782 });
    // Ikke i ekstra kjøringer.
    expect(summer([lonn, fag(560)], o, { ...t, ekstra: true }, "2026-10-20", null)).toMatchObject({ trekkgrunnlag: 40000 });
  });

  it("betalingsfila: forskuddstrekket og trekkene som egen betaling dagen etter, med KID (SCOR) eller tekst", () => {
    for (const format of ["pain.001.001.03", "pain.001.001.09"] as const) {
      const xml = lagBetalingsfil({
        format,
        meldingId: "LONN-202610-ABCDEF1234",
        opprettet: "2026-10-19T10:15:00",
        avsender: { navn: "Trekk AS", orgnr: "915000177" },
        fraKonto: "86011117947",
        bic: "DNBANOKK",
        dato: "2026-10-20",
        tekst: "Lønn oktober 2026",
        betalinger: [{ navn: "Ola Trekk", kontonr: "12345678903", belop: 24608, referanse: "LONN-202610-ABCDEF1234-1" }],
        trekk: {
          dato: "2026-10-21",
          betalinger: [
            { navn: "Skatteetaten", kontonr: "86011117947", belop: 11832, referanse: "LONN-202610-ABCDEF1234-T1", kid: "0091500017705261012" },
            { navn: "Fellesforbundet", kontonr: "12345678903", belop: 560, referanse: "LONN-202610-ABCDEF1234-T2", tekst: "Kontingent" },
          ],
        },
      });
      expect(xml).toContain("<NbOfTxs>3</NbOfTxs>");
      expect(xml).toContain("<CtrlSum>37000.00</CtrlSum>");
      expect(xml).toContain("<PmtInfId>LONN-202610-ABCDEF1234-2</PmtInfId>");
      expect(xml).toContain("<BtchBookg>false</BtchBookg>");
      expect(xml).toContain(format === "pain.001.001.03" ? "<ReqdExctnDt>2026-10-21</ReqdExctnDt>" : "<ReqdExctnDt><Dt>2026-10-21</Dt></ReqdExctnDt>");
      expect(xml).toContain("<RmtInf><Strd><CdtrRefInf><Tp><CdOrPrtry><Cd>SCOR</Cd></CdOrPrtry></Tp><Ref>0091500017705261012</Ref></CdtrRefInf></Strd></RmtInf>");
      expect(xml).toContain("<RmtInf><Ustrd>Kontingent</Ustrd></RmtInf>");
      expect(xml.match(/<CtgyPurp><Cd>SALA<\/Cd><\/CtgyPurp>/g)).toHaveLength(1);
      valider(xml, format);
    }
  });

  it("lønnsbilaget: utleggstrekk, bidragstrekk og forskudd på egne kontoer", () => {
    const b = lagLonnsbilag(
      {
        kjoring: { id: "k", periode: "2026-10-01", type: "ordinar", utbetalingsdato: "2026-10-20" },
        slipper: [
          {
            brutto: 40000,
            skattetrekk: 11832,
            utgifter: 5000,
            trekk_etter_skatt: -6560,
            netto: 26608,
            feriepenger_opptjent: 0,
            otp: 0,
            aga: 5640,
            aga_sats: 14.1,
            feriepenger: 0,
            feriepenger_60: 0,
            paaleggstrekk: 3000,
            bidragstrekk: 1000,
            forskudd_trekk: 2000,
            forskudd_utbetalt: 5000,
          },
        ],
      },
      { kontoer: {}, feriepenger: "utbetaling", netto: "skyldig", otp: false },
    );
    expect(b.posteringer.map((p) => [p.konto, p.belop, p.tekst])).toEqual([
      ["5000", 40000, "Lønn"],
      ["1570", 5000, "Forskudd på lønn"],
      ["2600", -11832, "Forskuddstrekk"],
      ["2610", -3000, "Utleggstrekk"],
      ["2620", -1000, "Bidragstrekk"],
      ["1570", -2000, "Tilbakebetalt forskudd"],
      ["2690", -560, "Trekk i lønn"],
      ["2930", -26608, "Nettolønn"],
      ["5400", 5640, "Arbeidsgiveravgift"],
      ["2770", -5640, "Arbeidsgiveravgift"],
    ]);
  });
});

describe.skipIf(!process.env.DATABASE_URL)("trekk i lønnen i appen", () => {
  const app = lagApi();
  const eier = "Bearer test:uid-lontrekk-eier:lontrekk-eier@server.test:mfa";
  let org: string;
  let ola: string;
  let kari: string;
  let okt: string;
  let utlegg: string;

  const kall = async (m: string, sti: string, k?: unknown, hvem = eier) => {
    const r = await app.request(sti, { method: m, headers: { authorization: hvem, "content-type": "application/json" }, body: k === undefined ? undefined : JSON.stringify(k) });
    const type = r.headers.get("content-type") ?? "";
    return { status: r.status, data: type.includes("json") ? ((await r.json()) as any) : await r.text() };
  };
  const slipp = (k: any, ansatt: string) => k.slipper.find((s: any) => s.ansatt_id === ansatt);
  const linjer = (s: any) => s.linjer.filter((l: any) => !l.fjernet).map((l: any) => [l.lonnsart, l.tekst, l.belop]);
  const kjoring = async (periode: string) => {
    const r = await kall("POST", `/api/org/${org}/lonn/kjoringer`, { periode });
    expect(r.status, JSON.stringify(r.data)).toBe(201);
    return r.data;
  };

  beforeAll(async () => {
    settLokalOppgavekjorer(async () => {});
    org = (await kall("POST", "/api/organisasjoner", { navn: "Lønnstrekk Test AS" })).data.id;
    expect((await kall("PUT", `/api/org/${org}/lonn-oppsett`, { aktiv: true, otp_prosent: 0, lonnskonto: "86011117947", bank_bic: "DNBANOKK" })).status).toBe(200);
    const ny = async (b: Record<string, unknown>) => {
      const r = await kall("POST", `/api/org/${org}/ansatte`, { ansatt_fra: "2025-01-01", lonnstype: "maaned", skattekort: "prosent", skatt_prosent: 30, skattekort_aar: 2026, yrkeskode: "2221104", ...b });
      expect(r.status, JSON.stringify(r.data)).toBe(201);
      return r.data.id as string;
    };
    ola = await ny({ fornavn: "Ola", etternavn: "Trekk", maanedslonn: 40000, kontonr: "12345678903" });
    kari = await ny({ fornavn: "Kari", etternavn: "Forskudd", maanedslonn: 50000, kontonr: "86011117947" });
  });

  it("trekkene på den ansatte: kontrollene, og lista med det som er trukket", async () => {
    const sti = `/api/org/${org}/ansatte/${ola}/trekk`;
    expect((await kall("POST", sti, { type: "annet", fra: "2026-10-01" })).data.error).toBe("Skriv enten et beløp eller en prosent av bruttolønnen");
    expect((await kall("POST", sti, { type: "bidrag", belop: 100, fra: "2026-10-01", kontonr: "1234 56 78904" })).data.error).toBe("Kontonummeret er ikke gyldig (sjekk sifrene)");
    expect((await kall("POST", sti, { type: "bidrag", belop: 100, fra: "2026-10-01", til: "2026-09-01" })).data.error).toBe("Til-datoen er før fra-datoen");
    expect(
      (await kall("POST", sti, { type: "fagforening", prosent: 1.4, fra: "2026-01-01", tekst: "Fellesforbundet", mottaker: "Fellesforbundet", kontonr: "1234.56.78903", melding: "Kontingent" })).status,
    ).toBe(201);
    const r = await kall("POST", sti, { type: "utlegg_samordnet", belop: 3000, fra: "2026-09-01", kontonr: "86011117947", kid: "12345678903" });
    expect(r.status, JSON.stringify(r.data)).toBe(201);
    expect(r.data.map((t: any) => [t.type, t.belop, t.prosent, t.kontonr, t.trukket])).toEqual([
      ["fagforening", null, 1.4, "12345678903", 0],
      ["utlegg_samordnet", 3000, null, "86011117947", 0],
    ]);
    utlegg = r.data[1].id;
    expect((await kall("POST", `/api/org/${org}/ansatte/${kari}/trekk`, { type: "forskudd", belop: 2000, totalt: 3000, fra: "2026-10-01" })).status).toBe(201);
    expect((await kall("PUT", `/api/org/${org}/lonn-oppsett`, { skatt_kontonr: "8601 11 17947" })).data.skatt_kontonr).toBe("86011117947");
  });

  it("lønnskjøringen trekker dem: fagforeningen før skattetrekket, de andre etter", async () => {
    const k = await kjoring("2026-10");
    okt = k.id;
    const o = slipp(k, ola);
    expect(linjer(o)).toEqual([
      ["fastlonn", "Fastlønn", 40000],
      ["fagforening", "Fagforeningskontingent – Fellesforbundet", -560],
      ["utleggstrekk_samordnet", "Utleggstrekk (samordnet, Skatteetaten)", -3000],
    ]);
    expect(o).toMatchObject({ trekkgrunnlag: 39440, skattetrekk: 11832, trekk_etter_skatt: -3560, netto: 24608 });
    const ka = slipp(k, kari);
    expect(linjer(ka)).toEqual([
      ["fastlonn", "Fastlønn", 50000],
      ["forskudd_trekk", "Tilbakebetaling av forskudd (1 000 kr igjen)", -2000],
    ]);
    expect(ka).toMatchObject({ skattetrekk: 15000, netto: 33000 });
    expect((await kall("POST", `/api/org/${org}/lonn/kjoringer/${okt}/godkjenn`)).data.status).toBe("godkjent");
  });

  it("betalingene: KID-en for forskuddstrekket, og betalingsfila", async () => {
    const sti = `/api/org/${org}/lonn/kjoringer/${okt}`;
    let b = (await kall("GET", `${sti}/betalinger`)).data;
    expect(b.lonn).toEqual({ dato: "2026-10-20", antall: 2, sum: 57608 });
    expect(b.trekkdato).toBe("2026-10-21");
    expect(b.forskuddstrekk).toMatchObject({ mottaker: "Skatteetaten", kontonr: "86011117947", kid: null, belop: 26832, antall: 2 });
    expect(b.forskuddstrekk.mangler).toBe("Legg inn KID-en for forskuddstrekk i oktober 2026 (fra Skatteetatens KID-generator).");
    expect(b.trekk).toEqual([
      { mottaker: "Fellesforbundet", kontonr: "12345678903", kid: null, tekst: "Kontingent", belop: 560, antall: 1, hva: "Fagforeningskontingent", mangler: null },
      { mottaker: "Skatteetaten", kontonr: "86011117947", kid: "12345678903", tekst: null, belop: 3000, antall: 1, hva: "Utleggstrekk (samordnet, Skatteetaten)", mangler: null },
    ]);
    expect((await kall("PUT", `${sti}/forskuddstrekk-kid`, { kid: "123" })).data.error).toBe("KID-en for forskuddstrekk har 19 siffer");
    b = (await kall("PUT", `${sti}/forskuddstrekk-kid`, { kid: "0091500017 7052610 12" })).data;
    expect(b.forskuddstrekk).toMatchObject({ kid: "0091500017705261012", mangler: null });
    const fil = await kall("POST", `${sti}/betalingsfil`);
    expect(fil.status).toBe(200);
    const xml = fil.data as string;
    expect(xml).toContain("<NbOfTxs>5</NbOfTxs>");
    expect(xml).toContain("<ReqdExctnDt>2026-10-21</ReqdExctnDt>");
    expect(xml).toContain("<Ref>0091500017705261012</Ref>");
    expect(xml).toContain("<Ref>12345678903</Ref>");
    expect(xml).toContain("<Ustrd>Kontingent</Ustrd>");
    valider(xml, "pain.001.001.03");
  });

  it("a-meldingen: fradraget, utleggstrekket og forskuddstrekket", async () => {
    const g = await somSystem((db) => hentGrunnlag(db, org, "2026-10"));
    const m = byggLeveranse({ ...g, org: { navn: "Lønnstrekk Test AS", orgnr: "915000177" }, virksomhet: "915000185" } as Grunnlag, {
      meldingsId: "a1b2c3d4-0000-4000-8000-000000000082",
      tidspunkt: "2026-11-03T09:00:00Z",
      fnr: (id) => (id === ola ? "13830197340" : "24880199664"),
    }) as any;
    const o = m.leveranse.oppgave.virksomhet[0].inntektsmottaker.find((x: any) => x.norskIdentifikator === "13830197340");
    expect(o.fradrag).toEqual([{ beskrivelse: "fagforeningskontingent", beloep: "-560.00" }]);
    expect(o.forskuddstrekk).toEqual([{ beskrivelse: "ordinaert", beloep: -11832 }]);
    expect(o.utleggstrekk).toEqual([{ beskrivelse: "utleggstrekkSamordnet", beloep: -3000, datoForUtleggstrekk: "2026-10-20" }]);
    expect(Object.keys(o)).toEqual(["norskIdentifikator", "arbeidsforhold", "fradrag", "forskuddstrekk", "inntekt", "utleggstrekk"]);
    expect(m.leveranse.oppgave.betalingsinformasjon.sumUtleggstrekk).toBe(3000);
    // Forskuddet til Kari er ikke med (et lån).
    const k = m.leveranse.oppgave.virksomhet[0].inntektsmottaker.find((x: any) => x.norskIdentifikator === "24880199664");
    expect(k.fradrag).toBeUndefined();
    expect(k.utleggstrekk).toBeUndefined();
    valider(tilXml(m), "amelding_v2_3");
  });

  it("lønnsbilaget: trekkene på egne kontoer", async () => {
    const b = (await kall("GET", `/api/org/${org}/lonn/kjoringer/${okt}/bokforing`)).data;
    const poster = (b.gjeldende ?? b.forslag).posteringer.map((p: any) => [p.konto, p.belop]);
    expect(poster).toContainEqual(["2610", -3000]);
    expect(poster).toContainEqual(["1570", -2000]);
    expect(poster).toContainEqual(["2690", -560]);
  });

  it("neste måned: det siste av forskuddet, og et trekk som er brukt, avsluttes i stedet for å slettes", async () => {
    const k = await kjoring("2026-11");
    expect(linjer(slipp(k, kari))).toContainEqual(["forskudd_trekk", "Tilbakebetaling av forskudd (siste trekk)", -1000]);
    // Utleggstrekket er brukt i oktober: det avsluttes etter oktober, og er ikke med i november.
    const l = (await kall("DELETE", `/api/org/${org}/ansatte/${ola}/trekk/${utlegg}`)).data;
    expect(l.find((t: any) => t.id === utlegg)).toMatchObject({ til: "2026-10-31", trukket: 3000 });
    const b = (await kall("POST", `/api/org/${org}/lonn/kjoringer/${k.id}/beregn`)).data;
    expect(linjer(slipp(b, ola)).map((x: any) => x[0])).toEqual(["fastlonn", "fagforening"]);
    // Et trekk som aldri er brukt, slettes.
    const nytt = (await kall("POST", `/api/org/${org}/ansatte/${ola}/trekk`, { type: "annet", belop: 50, fra: "2027-01-01", tekst: "Kantine" })).data.find((t: any) => t.tekst === "Kantine");
    expect((await kall("DELETE", `/api/org/${org}/ansatte/${ola}/trekk/${nytt.id}`)).data.some((t: any) => t.id === nytt.id)).toBe(false);
  });

  it("rapporten «Trekk og betalinger»", async () => {
    const r = await kall("GET", `/api/org/${org}/rapportmodul/lonn.trekk?fra=2026-10-01&til=2026-10-31`);
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data.rader.map((x: any) => [x.betales, x.hva, x.navn, x.mottaker, x.kid, x.belop])).toEqual([
      ["2026-10-21", "Forskuddstrekk", "", "Skatteetaten", "0091500017705261012", 26832],
      ["2026-10-21", "Fagforeningskontingent", "Ola Trekk", "Fellesforbundet", "Kontingent", 560],
      ["2026-10-21", "Utleggstrekk (samordnet, Skatteetaten)", "Ola Trekk", "Skatteetaten", "12345678903", 3000],
      [null, "Tilbakebetaling av forskudd", "Kari Forskudd", "Arbeidsgiveren", "", 2000],
    ]);
  });
});
