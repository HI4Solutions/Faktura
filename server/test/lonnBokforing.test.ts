// Bokføringen av lønnen i eget regnskap (lonnBokforing.ts, lonnBokforingRuter.ts): lønnsbilaget
// (avsetning eller utbetaling av feriepengene, skyldig lønn eller bank, OTP, kontoene), og i appen:
// kontoene og valgene, bilaget som føres når kjøringen godkjennes (serie L), reverseringen når den
// åpnes igjen, en kjøring som ble godkjent før bokføringen kom, og rapporten.
import { beforeAll, describe, expect, it } from "vitest";
import { lagApi } from "../src/api.js";
import { somBruker } from "../src/db.js";
import { kontoplan, lagLonnsbilag, type Bilagsgrunnlag } from "../src/lonnBokforing.js";

const GRUNNLAG: Bilagsgrunnlag = {
  kjoring: { id: "k1", periode: "2026-06-01", type: "ordinar", utbetalingsdato: "2026-06-20" },
  slipper: [
    // Fastlønn 50 000, ferietrekk −10 000 og feriepenger 60 000; utgifter og trekk etter skatt.
    { brutto: 100000, skattetrekk: 15000, utgifter: 500, trekk_etter_skatt: -300, netto: 85200, feriepenger_opptjent: 4800, otp: 800, aga: 14212.8, aga_sats: 14.1, feriepenger: 60000, feriepenger_60: 0 },
    // Timelønn 20 000 og tillegget for den ekstra ferieuka (1 000).
    { brutto: 21000, skattetrekk: 4000, utgifter: 0, trekk_etter_skatt: 0, netto: 17000, feriepenger_opptjent: 2400, otp: 0, aga: 2961, aga_sats: 14.1, feriepenger: 0, feriepenger_60: 1000 },
  ],
};
const kort = (b: ReturnType<typeof lagLonnsbilag>) => b.posteringer.map((p) => [p.konto, p.belop, p.tekst]);

describe("lønnsbilaget", () => {
  it("avsetning av feriepengene, nettolønn til skyldig lønn (standard)", () => {
    const b = lagLonnsbilag(GRUNNLAG, { kontoer: {}, feriepenger: "avsetning", netto: "skyldig", otp: false });
    expect(b.dato).toBe("2026-06-20");
    expect(b.tekst).toBe("Lønn juni 2026");
    expect(kort(b)).toEqual([
      ["5000", 60000, "Lønn"],
      ["2940", 60000, "Feriepenger utbetalt"],
      ["5020", 1000, "Feriepenger for den ekstra ferieuka"],
      ["7790", 500, "Utgiftsgodtgjørelse"],
      ["2600", -19000, "Forskuddstrekk"],
      ["2690", -300, "Trekk i lønn"],
      ["2930", -102200, "Nettolønn"],
      ["5400", 8713.8, "Arbeidsgiveravgift"],
      ["2785", 8460, "Arbeidsgiveravgift av utbetalte feriepenger"],
      ["2770", -17173.8, "Arbeidsgiveravgift"],
      ["5020", 7200, "Avsatte feriepenger"],
      ["2940", -7200, "Avsatte feriepenger"],
      ["5405", 1015.2, "Arbeidsgiveravgift av avsatte feriepenger"],
      ["2785", -1015.2, "Arbeidsgiveravgift av avsatte feriepenger"],
    ]);
    expect(b.sum).toBe(146889);
    expect(b.posteringer.reduce((a, p) => a + Math.round(p.belop * 100), 0)).toBe(0);
    expect(b.posteringer[0]).toMatchObject({ rolle: "lonn", navn: "Lønn til ansatte" });
  });

  it("feriepengene kostnadsføres når de utbetales, nettolønnen fra banken, OTP og endrede kontoer", () => {
    const b = lagLonnsbilag(GRUNNLAG, { kontoer: { lonn: "5001", bank: "1921" }, feriepenger: "utbetaling", netto: "bank", otp: true });
    expect(kort(b)).toEqual([
      ["5001", 60000, "Lønn"],
      ["5020", 61000, "Feriepenger utbetalt"],
      ["7790", 500, "Utgiftsgodtgjørelse"],
      ["2600", -19000, "Forskuddstrekk"],
      ["2690", -300, "Trekk i lønn"],
      ["1921", -102200, "Nettolønn"],
      ["5400", 17173.8, "Arbeidsgiveravgift"],
      ["2770", -17173.8, "Arbeidsgiveravgift"],
      ["5945", 800, "OTP"],
      ["2990", -800, "OTP"],
    ]);
    expect(b.sum).toBe(139473.8);
  });

  it("en ekstra kjøring, beløp som er null, og et bilag som ikke går i null", () => {
    const ekstra: Bilagsgrunnlag = {
      kjoring: { id: "k2", periode: "2026-06-01", type: "ekstra", utbetalingsdato: "2026-06-25" },
      slipper: [{ brutto: 1000, skattetrekk: 0, utgifter: 0, trekk_etter_skatt: 0, netto: 1000, feriepenger_opptjent: 0, otp: 0, aga: 0, aga_sats: 0, feriepenger: 0, feriepenger_60: 0 }],
    };
    const b = lagLonnsbilag(ekstra, { kontoer: {}, feriepenger: "avsetning", netto: "skyldig", otp: true });
    expect(b.tekst).toBe("Lønn juni 2026 (ekstra)");
    expect(kort(b)).toEqual([
      ["5000", 1000, "Lønn"],
      ["2930", -1000, "Nettolønn"],
    ]);
    const feil = { ...ekstra, slipper: [{ ...ekstra.slipper[0]!, netto: 999.99 }] };
    expect(() => lagLonnsbilag(feil, { kontoer: {}, feriepenger: "avsetning", netto: "skyldig", otp: false })).toThrow("Lønnsbilaget går ikke i null (0.01 kr)");
  });

  it("kontoplanen: standarden og det som er endret", () => {
    expect(kontoplan({ kontoer: {} })).toMatchObject({ lonn: "5000", feriepenger: "5020", skyldig_lonn: "2930", bank: "1920" });
    expect(kontoplan({ kontoer: { feriepenger: "5092" } }).feriepenger).toBe("5092");
  });
});

describe.skipIf(!process.env.DATABASE_URL)("bokføringen i appen", () => {
  const app = lagApi();
  const eier = "Bearer test:uid-bokf-eier:bokforing-eier@server.test:mfa";
  let org: string;
  let kjoring: string;

  const api = async (m: string, sti: string, b?: unknown, hvem = eier) => {
    const r = await app.request(sti, { method: m, headers: { authorization: hvem, "content-type": "application/json" }, body: b === undefined ? undefined : JSON.stringify(b) });
    return { status: r.status, data: (r.headers.get("content-type") ?? "").includes("json") ? ((await r.json()) as any) : await r.text() };
  };
  const bilag = async (k = kjoring) => (await api("GET", `/api/org/${org}/lonn/kjoringer/${k}/bokforing`)).data;
  const poster = (b: any) => b.posteringer.map((p: any) => [p.konto, p.belop]);

  beforeAll(async () => {
    org = (await api("POST", "/api/organisasjoner", { navn: "Bokføring Test AS", orgnr: "915000185" })).data.id;
    expect((await api("PUT", `/api/org/${org}/lonn-oppsett`, { aktiv: true })).status).toBe(200);
    const a = await api("POST", `/api/org/${org}/ansatte`, { fornavn: "Kari", etternavn: "Bilag", ansatt_fra: "2025-01-01", lonnstype: "maaned", maanedslonn: 50000, skattekort: "prosent", skatt_prosent: 30 });
    expect(a.status, JSON.stringify(a.data)).toBe(201);
    kjoring = (await api("POST", `/api/org/${org}/lonn/kjoringer`, { periode: "2026-09" })).data.id;
  });

  it("utkastet har ikke noe bilag; godkjenningen fører det (L-2026-1)", async () => {
    expect(await bilag()).toEqual({ gjeldende: null, bilag: [], forslag: null });
    expect((await api("POST", `/api/org/${org}/lonn/kjoringer/${kjoring}/godkjenn`)).status).toBe(200);
    const d = await bilag();
    expect(d.forslag).toBe(null);
    expect(d.gjeldende).toMatchObject({ bilagsnummer: "L-2026-1", dato: "2026-09-18", tekst: "Lønn september 2026", reverserer: null, reversert_av: null });
    expect(poster(d.gjeldende)).toEqual([
      ["5000", 50000],
      ["2600", -15000],
      ["2930", -35000],
      ["5400", 7191],
      ["2770", -7191],
      ["5020", 6000],
      ["2940", -6000],
      ["5405", 846],
      ["2785", -846],
    ]);
    expect(d.gjeldende.posteringer[0]).toMatchObject({ navn: "Lønn til ansatte", tekst: "Lønn" });
    expect((await api("POST", `/api/org/${org}/lonn/kjoringer/${kjoring}/bokfor`)).data.error).toBe("Lønnskjøringen er alt bokført");
  });

  it("rapporten «Lønnsbilag»: for kjøringen og for perioden", async () => {
    const r = (await api("GET", `/api/org/${org}/rapportmodul/lonn.bokforing?kjoring=${kjoring}`)).data;
    expect(r.rader).toHaveLength(9);
    expect(r.rader[0]).toEqual({ bilag: "L-2026-1", dato: "2026-09-18", bilagstekst: "Lønn september 2026", konto: "5000", kontonavn: "Lønn til ansatte", tekst: "Lønn", debet: 50000, kredit: null });
    expect(r.sum).toMatchObject({ debet: 64037, kredit: 64037 });
    const p = (await api("GET", `/api/org/${org}/rapportmodul/lonn.bokforing?fra=2026-09-01&til=2026-09-30`)).data;
    expect(p.rader).toHaveLength(9);
  });

  it("kontoene og valgene gjelder bilagene som føres etterpå", async () => {
    const o = (await api("GET", `/api/org/${org}/lonn/bokforing`)).data;
    expect(o).toMatchObject({ feriepenger: "avsetning", netto: "skyldig", otp: false });
    expect(o.kontoer.find((k: any) => k.rolle === "lonn")).toEqual({ rolle: "lonn", navn: "Lønn til ansatte", standard: "5000", konto: "5000", endret: false });
    expect((await api("PUT", `/api/org/${org}/lonn/bokforing`, { kontoer: { lonn: "50" } })).status).toBe(400);
    const ny = (await api("PUT", `/api/org/${org}/lonn/bokforing`, { kontoer: { lonn: "5001", feriepenger: "5020" }, netto: "bank" })).data;
    expect(ny.kontoer.filter((k: any) => k.endret).map((k: any) => [k.rolle, k.konto])).toEqual([["lonn", "5001"]]);
    expect(ny.netto).toBe("bank");
    // Det førte bilaget er som det var.
    expect(poster((await bilag()).gjeldende)[0]).toEqual(["5000", 50000]);
  });

  it("åpnes kjøringen, reverseres bilaget; godkjennes den igjen, føres et nytt med kontoene nå", async () => {
    expect((await api("POST", `/api/org/${org}/lonn/kjoringer/${kjoring}/gjenapne`)).status).toBe(200);
    let d = await bilag();
    expect(d.gjeldende).toBe(null);
    expect(d.bilag.map((b: any) => [b.bilagsnummer, Boolean(b.reverserer), Boolean(b.reversert_av)])).toEqual([
      ["L-2026-2", true, false],
      ["L-2026-1", false, true],
    ]);
    expect(d.bilag[0]).toMatchObject({ dato: "2026-09-18", tekst: "Reversert: lønnskjøringen er åpnet igjen" });
    expect(poster(d.bilag[0])[0]).toEqual(["5000", -50000]);
    expect((await api("POST", `/api/org/${org}/lonn/kjoringer/${kjoring}/godkjenn`)).status).toBe(200);
    d = await bilag();
    expect(d.gjeldende.bilagsnummer).toBe("L-2026-3");
    expect(poster(d.gjeldende).slice(0, 3)).toEqual([
      ["5001", 50000],
      ["2600", -15000],
      ["1920", -35000],
    ]);
    // Perioden har alle tre (det reverserte, reverseringen og det nye), og går i null mellom de to første.
    const p = (await api("GET", `/api/org/${org}/rapportmodul/lonn.bokforing?fra=2026-09-01&til=2026-09-30`)).data;
    expect([...new Set(p.rader.map((r: any) => r.bilag))]).toEqual(["L-2026-1", "L-2026-2", "L-2026-3"]);
  });

  it("en kjøring som ble godkjent før bokføringen kom, bokføres fra kjøringen", async () => {
    const k = (await api("POST", `/api/org/${org}/lonn/kjoringer`, { periode: "2026-10" })).data.id;
    // Godkjent uten bilag (som før bokføringen kom).
    await somBruker(
      (await api("GET", "/api/meg")).data.bruker.id,
      (db) => db.query("select faktura.lonn_godkjenn($1)", [k]),
    );
    const d = await bilag(k);
    expect(d.gjeldende).toBe(null);
    expect(d.forslag.tekst).toBe("Lønn oktober 2026");
    const b = await api("POST", `/api/org/${org}/lonn/kjoringer/${k}/bokfor`);
    expect(b.status, JSON.stringify(b.data)).toBe(201);
    expect(b.data).toMatchObject({ serie: "L", aar: 2026, nummer: 4 });
    expect((await bilag(k)).gjeldende.bilagsnummer).toBe("L-2026-4");
  });
});
