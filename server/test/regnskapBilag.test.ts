// Regnskapsmodulen, andre del (periodisering.ts, hovedbok.ts, regnskapBilagRuter.ts,
// regnskapRapporter.ts): fordelingen av periodiseringene (likt på månedene, endringer framover),
// bilagene for måneden og starten (flytt eller motkonto med mva), og i appen: manuelle bilag med
// kontrollene, periodiseringene, månedsavslutningen for avskrivningene og periodiseringene samlet,
// saldobalansen (også resultatet fra tidligere år), hovedboken, bilagslista, rapportene, endringer
// som stoppes, starten som bokføres senere, reversering (det siste først, og hver kilde der den hører
// hjemme) og tilgangen.
import { beforeAll, describe, expect, it } from "vitest";
import { lagApi } from "../src/api.js";
import { regnskapskontoer } from "../src/anlegg.js";
import { fordeling, maanedsbilag, periodiseringsforslag, startbilag, status, type Periodisering, type Periodiseringspost } from "../src/periodisering.js";

const per = (x: Partial<Periodisering>): Periodisering => ({
  id: "p",
  nummer: 1,
  navn: "Forsikring",
  type: "forskuddsbetalt_kostnad",
  belop: 12000,
  fra: "2026-01-01",
  antall_maaneder: 12,
  resultatkonto: "7500",
  balansekonto: "1700",
  start: "flytt",
  tekst: null,
  ...x,
});
let n = 0;
const post = (x: Partial<Periodiseringspost>): Periodiseringspost => ({
  id: `x${++n}`,
  periodisering_id: "p",
  type: "maaned",
  maaned: "2026-01",
  belop: 1000,
  dato: "2026-01-31",
  bilag_id: `b${n}`,
  bilag: `P-2026-${n}`,
  reversert: false,
  ...x,
});
const start = (x: Partial<Periodiseringspost> = {}) => post({ type: "start", maaned: null, belop: 12000, dato: "2026-01-05", ...x });
const kort = (b: { posteringer: { konto: string; belop: number }[] }) => b.posteringer.map((p): [string, number] => [p.konto, p.belop]);
const K = regnskapskontoer({ kontoer: {} });

describe("periodiseringene (uten database)", () => {
  it("fordelingen: likt på månedene i øre, og en endring fordeler resten på månedene som er igjen", () => {
    const f = fordeling(per({}), []);
    expect(f).toHaveLength(12);
    expect(f[0]).toEqual({ maaned: "2026-01", belop: 1000, bokfort: false, bilag: null, igjen: 11000 });
    expect(f.at(-1)).toMatchObject({ maaned: "2026-12", belop: 1000, igjen: 0 });
    // 10 000 over tre måneder: summen blir beløpet.
    expect(fordeling(per({ belop: 10000, antall_maaneder: 3 }), []).map((x) => x.belop)).toEqual([3333.33, 3333.34, 3333.33]);
    // Januar og februar bokført, så seks måneder i stedet for tolv: 10 000 på mars–juni.
    const bokfort = [start(), post({ maaned: "2026-01" }), post({ maaned: "2026-02", dato: "2026-02-28" })];
    expect(fordeling(per({ antall_maaneder: 6 }), bokfort).map((x) => [x.maaned, x.belop, x.bokfort])).toEqual([
      ["2026-01", 1000, true],
      ["2026-02", 1000, true],
      ["2026-03", 2500, false],
      ["2026-04", 2500, false],
      ["2026-05", 2500, false],
      ["2026-06", 2500, false],
    ]);
    // En reversert måned regnes ikke.
    expect(fordeling(per({}), [post({ maaned: "2026-01", belop: 5000, reversert: true })])[0]).toMatchObject({ belop: 1000, bokfort: false });
  });

  it("status: fordelt, igjen, neste måned og starten", () => {
    const s = status(per({}), [start({ bilag: "P-2026-1" }), post({ maaned: "2026-01" })]);
    expect(s).toEqual({ fordelt: 1000, igjen: 11000, slutt: "2026-12", neste: { maaned: "2026-02", belop: 1000 }, start_bilag: "P-2026-1", mangler_start: false, ferdig: false });
    expect(status(per({}), []).mangler_start).toBe(true);
    expect(status(per({}), [start({ reversert: true })]).mangler_start).toBe(true);
    expect(status(per({ start: "ingen" }), []).mangler_start).toBe(false);
    expect(status(per({ start: "ingen", belop: 500, antall_maaneder: 1 }), [post({ belop: 500 })])).toMatchObject({ fordelt: 500, igjen: 0, neste: null, ferdig: true });
  });

  it("bilaget for måneden: kostnaden mot balansekontoen, inntekten fra den, og ingen linjer på null", () => {
    const inntekt = per({ id: "q", nummer: 2, navn: "Abonnement", type: "uopptjent_inntekt", resultatkonto: "3000", balansekonto: "2970" });
    const b = maanedsbilag("2026-01", [
      { p: per({}), belop: 1000 },
      { p: inntekt, belop: 500 },
      { p: per({ id: "r", nummer: 3 }), belop: 0 },
    ]);
    expect(b.dato).toBe("2026-01-31");
    expect(b.tekst).toBe("Periodiseringer januar 2026");
    expect(kort(b)).toEqual([
      ["7500", 1000],
      ["1700", -1000],
      ["2970", 500],
      ["3000", -500],
    ]);
    expect(b.posteringer[0]!.tekst).toBe("Forsikring (nr. 1)");
    expect(b.poster).toEqual([
      { periodisering_id: "p", type: "maaned", maaned: "2026-01-01", belop: 1000 },
      { periodisering_id: "q", type: "maaned", maaned: "2026-01-01", belop: 500 },
    ]);
  });

  it("starten: flyttet fra resultatkontoen, eller fra motkontoen med mva", () => {
    expect(kort(startbilag(per({}), { dato: "2026-01-05" }, K))).toEqual([
      ["1700", 12000],
      ["7500", -12000],
    ]);
    expect(kort(startbilag(per({ start: "motkonto" }), { dato: "2026-01-05", motkonto: "2400", mva: 3000 }, K))).toEqual([
      ["1700", 12000],
      ["2710", 3000],
      ["2400", -15000],
    ]);
    const inntekt = per({ type: "uopptjent_inntekt", belop: 10000, resultatkonto: "3000", balansekonto: "2970" });
    expect(kort(startbilag({ ...inntekt, start: "motkonto" }, { dato: "2026-04-01", motkonto: "1500", mva: 2500 }, K))).toEqual([
      ["1500", 12500],
      ["2970", -10000],
      ["2700", -2500],
    ]);
    expect(kort(startbilag(inntekt, { dato: "2026-04-01" }, K))).toEqual([
      ["3000", 10000],
      ["2970", -10000],
    ]);
    const b = startbilag(per({}), { dato: "2026-01-05" }, K);
    expect(b.tekst).toBe("Forskuddsbetalt kostnad: Forsikring (nr. 1)");
    expect(b.poster).toEqual([{ periodisering_id: "p", type: "start", belop: 12000 }]);
    expect(() => startbilag(per({ start: "motkonto" }), { dato: "2026-01-05" }, K)).toThrow("Velg motkontoen");
  });

  it("månedsavslutningen: det som mangler til og med måneden; et forskudd uten start venter", () => {
    const bonus = per({ id: "b", nummer: 2, navn: "Bonus", type: "paalopt_kostnad", belop: 6000, antall_maaneder: 3, resultatkonto: "5000", balansekonto: "2960", start: "ingen" });
    const f = periodiseringsforslag([per({}), bonus], [start(), post({ maaned: "2026-01" })], "2026-03");
    expect(f.map((m) => [m.maaned, m.linjer.map((l) => [l.p.navn, l.belop])])).toEqual([
      ["2026-01", [["Bonus", 2000]]],
      [
        "2026-02",
        [
          ["Forsikring", 1000],
          ["Bonus", 2000],
        ],
      ],
      [
        "2026-03",
        [
          ["Forsikring", 1000],
          ["Bonus", 2000],
        ],
      ],
    ]);
    expect(periodiseringsforslag([per({})], [], "2026-03")).toEqual([]);
  });
});

describe.skipIf(!process.env.DATABASE_URL)("regnskapet i appen: periodiseringer, bilag, hovedbok og saldobalanse", () => {
  const app = lagApi();
  const eier = "Bearer test:uid-pbil-eier:pbil-eier@server.test:mfa";
  const regnskap = "Bearer test:uid-pbil-regn:pbil-regn@server.test:mfa";
  const fakturerer = "Bearer test:uid-pbil-fakt:pbil-fakt@server.test:mfa";
  let org: string;
  let forsikring: string;
  let abonnement: string;
  let bonus: string;
  const kall = async (m: string, sti: string, k?: unknown, hvem = eier) => {
    const r = await app.request(sti, { method: m, headers: { authorization: hvem, "content-type": "application/json" }, body: k === undefined ? undefined : JSON.stringify(k) });
    return { status: r.status, data: (r.headers.get("content-type") ?? "").includes("json") ? ((await r.json()) as any) : await r.text() };
  };
  const rapport = async (id: string, valg: string, hvem = eier) => {
    const r = await kall("GET", `/api/org/${org}/rapportmodul/${id}?${valg}`, undefined, hvem);
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    return r.data;
  };
  const sti = (s = "") => `/api/org/${org}/regnskap${s}`;
  const bilag = async (valg: string) => (await kall("GET", sti(`/bilag?${valg}`))).data.bilag as any[];
  const finn = async (nr: string) => (await bilag(`fra=2025-01-01&til=2026-12-31`)).find((b) => b.bilagsnummer === nr);

  beforeAll(async () => {
    org = (await kall("POST", "/api/organisasjoner", { navn: "Periode Test AS", orgnr: "915000347" })).data.id;
    for (const [epost, rolle, hvem] of [
      ["pbil-regn@server.test", "regnskap", regnskap],
      ["pbil-fakt@server.test", "fakturerer", fakturerer],
    ] as const) {
      const inv = await kall("POST", `/api/org/${org}/invitasjoner`, { epost, rolle });
      expect((await kall("POST", "/api/invitasjoner/aksepter", { token: inv.data.lenke.split("/").pop() }, hvem)).status).toBe(200);
    }
  });

  it("manuelle bilag (serie M): den inngående balansen og en faktura, og kontrollene", async () => {
    const ok = {
      dato: "2026-01-01",
      tekst: "Inngående balanse",
      linjer: [
        { konto: "1920", debet: 100000 },
        { konto: "2000", kredit: 30000, tekst: "Aksjekapital" },
        { konto: "2050", debet: null, kredit: 70000 },
      ],
    };
    expect((await kall("POST", sti("/bilag"), { ...ok, linjer: [ok.linjer[0]] })).data.error).toBe("Bilaget må ha minst to linjer");
    expect((await kall("POST", sti("/bilag"), { ...ok, linjer: [{ konto: "1920", debet: 1, kredit: 1 }, ok.linjer[1]] })).data.error).toBe(
      "Linje 1: skriv beløpet enten i debet eller i kredit",
    );
    expect((await kall("POST", sti("/bilag"), { ...ok, linjer: [{ konto: "1920" }, ok.linjer[1]] })).data.error).toBe("Linje 1: skriv beløpet enten i debet eller i kredit");
    expect((await kall("POST", sti("/bilag"), { ...ok, linjer: [{ konto: "1920", debet: 100000.01 }, ...ok.linjer.slice(1)] })).data.error).toBe(
      "Bilaget går ikke i null: debet og kredit skiller 0,01 kr",
    );
    expect((await kall("POST", sti("/bilag"), { ...ok, linjer: [{ konto: "19", debet: 1 }, { konto: "2000", kredit: 1 }] })).data.error).toBe("Kontonummeret må ha 4–6 siffer");
    expect((await kall("POST", sti("/bilag"), { ...ok, dato: "2099-01-01" })).data.error).toBe("Datoen kan ikke være fram i tid");
    expect((await kall("POST", sti("/bilag"), { ...ok, tekst: " " })).data.error).toBe("Skriv teksten for bilaget");
    const r = await kall("POST", sti("/bilag"), ok, regnskap);
    expect(r.status, JSON.stringify(r.data)).toBe(201);
    expect(r.data).toMatchObject({ bilagsnummer: "M-2026-1", serie: "M", dato: "2026-01-01", tekst: "Inngående balanse", kilde: "manuell", reverserer: null, reversert_av: null });
    expect(r.data.posteringer).toEqual([
      { konto: "1920", navn: "Bank", tekst: "", belop: 100000 },
      { konto: "2000", navn: "Aksjekapital", tekst: "Aksjekapital", belop: -30000 },
      { konto: "2050", navn: "Annen egenkapital", tekst: "", belop: -70000 },
    ]);
    // Forsikringen for 2026 er fakturert og ført som kostnad; den periodiseres under.
    const f = await kall("POST", sti("/bilag"), { dato: "2026-01-05", tekst: "Faktura forsikring 2026", linjer: [{ konto: "7500", debet: 12000 }, { konto: "2400", kredit: 12000 }] });
    expect(f.data.bilagsnummer).toBe("M-2026-2");
    const k = (await kall("GET", sti("/kontoliste"))).data.kontoer;
    expect(k.find((x: any) => x.konto === "7500")).toEqual({ konto: "7500", navn: "Forsikringspremie" });
    expect(k.find((x: any) => x.konto === "1700")).toEqual({ konto: "1700", navn: "Forskuddsbetalt kostnad" });
  });

  it("periodiseringene: typene, kontrollene og starten (flyttet, eller fra motkontoen med mva)", async () => {
    const l = (await kall("GET", sti("/periodiseringer"))).data;
    expect(l.periodiseringer).toEqual([]);
    expect(l.typer.map((t: any) => [t.type, t.balansekonto, t.resultatkonto, t.forskudd])).toEqual([
      ["forskuddsbetalt_kostnad", "1700", "7500", true],
      ["paalopt_kostnad", "2960", "7700", false],
      ["uopptjent_inntekt", "2970", "3000", true],
      ["opptjent_inntekt", "1530", "3000", false],
    ]);
    const fors = { navn: "Forsikring 2026", type: "forskuddsbetalt_kostnad", belop: 12000, fra: "2026-01", antall_maaneder: 12, resultatkonto: "7500", start: "flytt", start_dato: "2026-01-05" };
    expect((await kall("POST", sti("/periodiseringer"), { ...fors, navn: "" })).data.error).toBe("Skriv navnet");
    expect((await kall("POST", sti("/periodiseringer"), { ...fors, type: "paalopt_kostnad" })).data.error).toBe("Bare forskudd har en start");
    expect((await kall("POST", sti("/periodiseringer"), { ...fors, start: "motkonto" })).data.error).toBe("Velg motkontoen");
    expect((await kall("POST", sti("/periodiseringer"), { ...fors, resultatkonto: "1700" })).data.error).toBe("Resultatkontoen og balansekontoen må være forskjellige");
    expect((await kall("POST", sti("/periodiseringer"), { ...fors, start_dato: "2099-01-01" })).data.error).toBe("Datoen kan ikke være fram i tid");
    expect((await kall("POST", sti("/periodiseringer"), { ...fors, antall_maaneder: 121 })).data.error).toBe("Høyst 120 måneder");
    expect((await kall("POST", sti("/periodiseringer"), { ...fors, fra: "2026-13" })).data.error).toBe("Ugyldig måned");
    const f = await kall("POST", sti("/periodiseringer"), fors, regnskap);
    expect(f.status, JSON.stringify(f.data)).toBe(201);
    forsikring = f.data.periodisering.id;
    expect(f.data.periodisering).toMatchObject({
      nummer: 1,
      balansekonto: "1700",
      start: "flytt",
      fordelt: 0,
      igjen: 12000,
      slutt: "2026-12",
      neste: { maaned: "2026-01", belop: 1000 },
      start_bilag: "P-2026-1",
      mangler_start: false,
      ferdig: false,
    });
    expect(f.data.bilag).toMatchObject({ bilagsnummer: "P-2026-1", dato: "2026-01-05", tekst: "Forskuddsbetalt kostnad: Forsikring 2026 (nr. 1)" });
    expect(f.data.fordeling).toHaveLength(12);
    expect(f.data.poster).toMatchObject([{ type: "start", belop: 12000, bilag: "P-2026-1" }]);

    const a = await kall("POST", sti("/periodiseringer"), {
      navn: "Årsabonnement Kunde AS",
      type: "uopptjent_inntekt",
      belop: 10000,
      fra: "2026-04",
      antall_maaneder: 10,
      resultatkonto: "3000",
      start: "motkonto",
      motkonto: "1500",
      mva: 2500,
      start_dato: "2026-04-01",
    });
    expect(a.status, JSON.stringify(a.data)).toBe(201);
    abonnement = a.data.periodisering.id;
    expect(a.data.periodisering).toMatchObject({ nummer: 2, balansekonto: "2970", start_bilag: "P-2026-2", slutt: "2027-01" });
    expect(kort(await finn("P-2026-2"))).toEqual([
      ["1500", 12500],
      ["2970", -10000],
      ["2700", -2500],
    ]);

    const b = await kall("POST", sti("/periodiseringer"), { navn: "Bonus", type: "paalopt_kostnad", belop: 6000, fra: "2026-07", antall_maaneder: 3, resultatkonto: "5000" }, regnskap);
    expect(b.status, JSON.stringify(b.data)).toBe(201);
    bonus = b.data.periodisering.id;
    expect(b.data.periodisering).toMatchObject({ nummer: 3, balansekonto: "2960", start: "ingen", start_bilag: null, mangler_start: false });
    expect(b.data.bilag).toBe(null);
    expect((await kall("GET", sti("/periodiseringer"))).data.periodiseringer.map((p: any) => p.nummer)).toEqual([1, 2, 3]);
  });

  it("månedsavslutningen: avskrivningene og periodiseringene som mangler, samlet per måned", async () => {
    const inv = await kall("POST", sti("/anleggsmidler"), { navn: "Inventar", kategori: "inventar", anskaffet: "2026-07-01", kostpris: 60000, levetid_mnd: 60, anskaffelse: { motkonto: "2400", mva: 15000 } });
    expect(inv.status, JSON.stringify(inv.data)).toBe(201);
    const f = (await kall("GET", sti("/maanedsavslutning?til=2026-09"))).data;
    expect(f.til).toBe("2026-09");
    expect(f.maaneder.map((m: any) => [m.maaned, m.avskrivninger.sum, m.periodiseringer.sum])).toEqual([
      ["2026-01", 0, 1000],
      ["2026-02", 0, 1000],
      ["2026-03", 0, 1000],
      ["2026-04", 0, 2000],
      ["2026-05", 0, 2000],
      ["2026-06", 0, 2000],
      ["2026-07", 1000, 4000],
      ["2026-08", 1000, 4000],
      ["2026-09", 1000, 4000],
    ]);
    expect(f.maaneder[6]).toMatchObject({
      navn: "juli 2026",
      avskrivninger: { linjer: [{ nummer: 1, navn: "Inventar", belop: 1000 }] },
      periodiseringer: {
        linjer: [
          { nummer: 1, navn: "Forsikring 2026", belop: 1000 },
          { nummer: 2, navn: "Årsabonnement Kunde AS", belop: 1000 },
          { nummer: 3, navn: "Bonus", belop: 2000 },
        ],
      },
    });
    expect((await kall("POST", sti("/maanedsavslutning"), { til: "2099-01" })).data.error).toBe("Måneden kan ikke være fram i tid");
    const r = await kall("POST", sti("/maanedsavslutning"), { til: "2026-09" }, regnskap);
    expect(r.status, JSON.stringify(r.data)).toBe(201);
    expect(r.data.bilag.map((b: any) => [b.bilagsnummer, b.dato, b.sum])).toEqual([
      ["A-2026-2", "2026-07-31", 1000],
      ["A-2026-3", "2026-08-31", 1000],
      ["A-2026-4", "2026-09-30", 1000],
      ["P-2026-3", "2026-01-31", 1000],
      ["P-2026-4", "2026-02-28", 1000],
      ["P-2026-5", "2026-03-31", 1000],
      ["P-2026-6", "2026-04-30", 2000],
      ["P-2026-7", "2026-05-31", 2000],
      ["P-2026-8", "2026-06-30", 2000],
      ["P-2026-9", "2026-07-31", 4000],
      ["P-2026-10", "2026-08-31", 4000],
      ["P-2026-11", "2026-09-30", 4000],
    ]);
    expect(kort(await finn("P-2026-9"))).toEqual([
      ["7500", 1000],
      ["1700", -1000],
      ["2970", 1000],
      ["3000", -1000],
      ["5000", 2000],
      ["2960", -2000],
    ]);
    expect((await kall("GET", sti("/maanedsavslutning?til=2026-09"))).data.maaneder).toEqual([]);
    expect((await kall("POST", sti("/maanedsavslutning"), { til: "2026-09" })).data.bilag).toEqual([]);
    expect((await kall("GET", sti(`/periodiseringer/${bonus}`))).data.periodisering).toMatchObject({ fordelt: 6000, igjen: 0, neste: null, ferdig: true });
  });

  it("saldobalansen, hovedboken og bilagslista fra alle bilagene", async () => {
    const s = (await kall("GET", sti("/saldobalanse?fra=2026-01-01&til=2026-09-30"))).data;
    expect(s.rader.map((r: any) => [r.konto, r.inngaende, r.debet, r.kredit, r.utgaende])).toEqual([
      ["1250", 0, 60000, 3000, 57000],
      ["1500", 0, 12500, 0, 12500],
      ["1700", 0, 12000, 9000, 3000],
      ["1920", 0, 100000, 0, 100000],
      ["2000", 0, 0, 30000, -30000],
      ["2050", 0, 0, 70000, -70000],
      ["2400", 0, 0, 87000, -87000],
      ["2700", 0, 0, 2500, -2500],
      ["2710", 0, 15000, 0, 15000],
      ["2960", 0, 0, 6000, -6000],
      ["2970", 0, 6000, 10000, -4000],
      ["3000", 0, 0, 6000, -6000],
      ["5000", 0, 6000, 0, 6000],
      ["6010", 0, 3000, 0, 3000],
      ["7500", 0, 21000, 12000, 9000],
    ]);
    expect(s.rader.find((r: any) => r.konto === "2970").navn).toBe("Uopptjent inntekt");
    expect(s).toMatchObject({ fra: "2026-01-01", til: "2026-09-30", tidligere: 0, resultat: -12000 });
    // Fra april: balansekontoene har saldoen fra før, resultatkontoene det som er ført i år.
    const april = (await kall("GET", sti("/saldobalanse?fra=2026-04-01&til=2026-09-30"))).data.rader;
    expect(april.find((r: any) => r.konto === "1700")).toMatchObject({ inngaende: 9000, debet: 0, kredit: 6000, utgaende: 3000 });
    expect(april.find((r: any) => r.konto === "7500")).toMatchObject({ inngaende: 3000, debet: 6000, kredit: 0, utgaende: 9000 });

    const h = (await kall("GET", sti("/hovedbok?fra=2026-01-01&til=2026-09-30&konto=1700"))).data;
    expect(h.kontoer).toHaveLength(1);
    expect(h.kontoer[0]).toMatchObject({ konto: "1700", navn: "Forskuddsbetalt kostnad", inngaende: 0, utgaende: 3000 });
    expect(h.kontoer[0].poster.map((p: any) => [p.dato, p.bilag, p.debet, p.kredit, p.saldo]).slice(0, 3)).toEqual([
      ["2026-01-05", "P-2026-1", 12000, null, 12000],
      ["2026-01-31", "P-2026-3", null, 1000, 11000],
      ["2026-02-28", "P-2026-4", null, 1000, 10000],
    ]);
    expect(h.kontoer[0].poster).toHaveLength(10);
    expect(h.kontoer[0].poster.at(-1)).toMatchObject({ bilag: "P-2026-11", saldo: 3000, tekst: "Forsikring 2026 (nr. 1)", bilagstekst: "Periodiseringer september 2026" });
    expect((await kall("GET", sti("/hovedbok?fra=2026-01-01&til=2026-09-30"))).data.kontoer).toHaveLength(15);

    const alle = await bilag("fra=2026-01-01&til=2026-12-31");
    expect(alle.map((b) => b.bilagsnummer).slice(0, 4)).toEqual(["M-2026-1", "M-2026-2", "P-2026-1", "P-2026-3"]);
    expect(alle).toHaveLength(17);
    expect((await bilag("fra=2026-01-01&til=2026-12-31&kilde=anlegg")).map((b) => b.bilagsnummer)).toEqual(["A-2026-1", "A-2026-2", "A-2026-3", "A-2026-4"]);
    expect((await kall("GET", sti("/bilag?kilde=ukjent"))).status).toBe(400);

    // Et bilag fra fjoråret: resultatet fra 2025 står på egen linje, og saldobalansen går i null.
    const ifjor = await kall("POST", sti("/bilag"), { dato: "2025-12-31", tekst: "Salg 2025", linjer: [{ konto: "1920", debet: 5000 }, { konto: "3000", kredit: 5000 }] });
    expect(ifjor.data.bilagsnummer).toBe("M-2025-1");
    const s2 = (await kall("GET", sti("/saldobalanse?fra=2026-01-01&til=2026-09-30"))).data;
    expect(s2.rader.find((r: any) => r.konto === "1920")).toMatchObject({ inngaende: 5000, utgaende: 105000 });
    expect(s2.rader.find((r: any) => r.konto === "3000")).toMatchObject({ inngaende: 0, utgaende: -6000 });
    expect(s2).toMatchObject({ tidligere: -5000, resultat: -12000 });
    const sum = (k: string) => Math.round(s2.rader.reduce((t: number, r: any) => t + r[k] * 100, 0) + s2.tidligere * 100);
    expect([sum("inngaende"), sum("utgaende")]).toEqual([0, 0]);
  });

  it("rapportene: saldobalanse, hovedbok, bilagsjournal og periodiseringer", async () => {
    const s = await rapport("regnskap.saldobalanse", "fra=2026-01-01&til=2026-09-30");
    expect(s.rader.at(-1)).toEqual({ konto: "", navn: "Resultat fra tidligere år (ikke ført mot egenkapitalen)", inngaende: -5000, debet: 0, kredit: 0, utgaende: -5000 });
    expect(s.sum).toMatchObject({ inngaende: 0, utgaende: 0 });
    expect(s.sum.debet).toBe(s.sum.kredit);
    expect(s.merknad).toContain("Resultatet i perioden: 12 000 kr i underskudd.");
    expect(s.merknad).toContain("Resultatet fra tidligere år som ikke er ført mot egenkapitalen");
    expect((await rapport("regnskap.saldobalanse", "fra=2025-07-01&til=2026-06-30")).merknad).toContain("Perioden går over et årsskifte");

    const h = await rapport("regnskap.hovedbok", "fra=2026-01-01&til=2026-01-31");
    expect(h.rader.filter((r: any) => r.konto === "1700")).toEqual([
      { konto: "1700", navn: "Forskuddsbetalt kostnad", dato: null, bilag: "", tekst: "Forskuddsbetalt kostnad: inngående saldo", debet: null, kredit: null, saldo: 0 },
      { konto: "1700", navn: "Forskuddsbetalt kostnad", dato: "2026-01-05", bilag: "P-2026-1", tekst: "Forskuddsbetalt kostnad: Forsikring 2026 (nr. 1)", debet: 12000, kredit: null, saldo: 12000 },
      { konto: "1700", navn: "Forskuddsbetalt kostnad", dato: "2026-01-31", bilag: "P-2026-3", tekst: "Forsikring 2026 (nr. 1)", debet: null, kredit: 1000, saldo: 11000 },
    ]);
    expect(h.sum.debet).toBe(h.sum.kredit);

    const j = await rapport("regnskap.bilagsjournal", "fra=2026-01-01&til=2026-01-31");
    expect([...new Set(j.rader.map((r: any) => r.bilag))]).toEqual(["M-2026-1", "M-2026-2", "P-2026-1", "P-2026-3"]);
    expect(j.rader[0]).toEqual({
      dato: "2026-01-01",
      bilag: "M-2026-1",
      kilde: "Manuelt bilag",
      konto: "1920",
      navn: "Bank",
      tekst: "Inngående balanse",
      mva_kode: null,
      debet: 100000,
      kredit: null,
    });
    expect(j.sum).toMatchObject({ debet: 125000, kredit: 125000 });
    expect(j.merknad).toBe(
      "4 bilag. Serie F: fakturaer og kreditnotaer, B: bank (innbetalinger, refusjoner og andre bankposter), U: utgifter, L: lønn og refusjoner fra NAV, A: anleggsmidler, P: periodiseringer, V: mva-oppgjør, Å: årsoppgjør, M: manuelle bilag.",
    );

    const p = await rapport("regnskap.periodiseringer", "fra=2026-07-01&til=2026-09-30");
    expect(p.rader.map((r: any) => [r.nummer, r.maaneder, r.i_perioden, r.fordelt, r.igjen, r.status])).toEqual([
      [1, "01.2026–12.2026", 3000, 9000, 3000, "Neste: oktober 2026"],
      [2, "04.2026–01.2027", 3000, 6000, 4000, "Neste: oktober 2026"],
      [3, "07.2026–09.2026", 6000, 6000, 0, "Ferdig"],
    ]);
    expect(p.rader[1]).toMatchObject({ type: "Uopptjent inntekt (forskuddsfakturert)", kontoer: "3000 / 2970" });
    expect(p.merknad).toContain("Fordelt: det som er bokført");
    // Før periodiseringene begynte: ingen rader.
    expect((await rapport("regnskap.periodiseringer", "fra=2025-01-01&til=2025-12-31")).rader).toEqual([]);
  });

  it("endringer: det som er bokført, stopper endringene; starten bokføres senere", async () => {
    expect((await kall("PATCH", sti(`/periodiseringer/${forsikring}`), { belop: 13000 })).status).toBe(409);
    expect((await kall("PATCH", sti(`/periodiseringer/${forsikring}`), { antall_maaneder: 6 })).data.error).toBe("Månedene som er bokført, må være med i periodiseringen");
    expect((await kall("PATCH", sti(`/periodiseringer/${bonus}`), { start: "flytt" })).data.error).toBe("Bare forskudd har en start");
    expect((await kall("DELETE", sti(`/periodiseringer/${abonnement}`))).data.error).toBe("Periodiseringen har bokførte bilag. Reverser dem først.");
    // 24 måneder i stedet for 12: de 3 000 som er igjen, fordeles på oktober 2026–desember 2027.
    const ny = await kall("PATCH", sti(`/periodiseringer/${forsikring}`), { antall_maaneder: 24, navn: "Forsikring 2026–2027" }, regnskap);
    expect(ny.status, JSON.stringify(ny.data)).toBe(200);
    expect(ny.data.periodisering).toMatchObject({ navn: "Forsikring 2026–2027", slutt: "2027-12", igjen: 3000, neste: { maaned: "2026-10", belop: 200 } });
    expect(ny.data.fordeling.at(-1)).toMatchObject({ maaned: "2027-12", belop: 200, igjen: 0 });

    // Starten kan bokføres senere (her etter at den er reversert), og månedene venter på den.
    const leie = await kall("POST", sti("/periodiseringer"), {
      navn: "Husleie 4. kvartal",
      type: "forskuddsbetalt_kostnad",
      belop: 30000,
      fra: "2026-10",
      antall_maaneder: 3,
      resultatkonto: "6300",
      start: "motkonto",
      motkonto: "1920",
      start_dato: "2026-09-30",
    });
    expect(leie.status, JSON.stringify(leie.data)).toBe(201);
    const id = leie.data.periodisering.id;
    expect(leie.data.bilag).toMatchObject({ bilagsnummer: "P-2026-12", dato: "2026-09-30" });
    expect((await kall("POST", sti(`/periodiseringer/${id}/start`), {})).data.error).toBe("Starten er alt bokført");
    expect((await kall("POST", sti(`/periodiseringer/${bonus}/start`), {})).data.error).toBe("Periodiseringen har ingen start å bokføre");
    expect((await kall("POST", sti(`/bilag/${leie.data.bilag.id}/reverser`), {})).status).toBe(201);
    expect((await kall("GET", sti(`/periodiseringer/${id}`))).data.periodisering).toMatchObject({ start_bilag: null, mangler_start: true });
    expect((await kall("GET", sti("/maanedsavslutning?til=2026-10"))).data.maaneder.map((m: any) => [m.maaned, m.periodiseringer.sum])).toEqual([["2026-10", 1200]]);
    expect((await kall("POST", sti(`/periodiseringer/${id}/start`), { dato: "2026-09-30" })).data.error).toBe("Velg motkontoen");
    expect((await kall("POST", sti(`/periodiseringer/${id}/start`), { dato: "2099-01-01", motkonto: "1920" })).data.error).toBe("Datoen kan ikke være fram i tid");
    const s = await kall("POST", sti(`/periodiseringer/${id}/start`), { dato: "2026-09-30", motkonto: "1920" }, regnskap);
    expect(s.status, JSON.stringify(s.data)).toBe(201);
    expect(s.data.bilag.bilagsnummer).toBe("P-2026-14");
    expect(s.data.periodisering).toMatchObject({ start_bilag: "P-2026-14", mangler_start: false });
    expect((await kall("GET", sti("/maanedsavslutning?til=2026-10"))).data.maaneder.map((m: any) => [m.maaned, m.periodiseringer.sum])).toEqual([["2026-10", 11200]]);
    // Uten noe bokført: alt kan endres, og den slettes.
    const tom = await kall("POST", sti("/periodiseringer"), { navn: "Strøm", type: "paalopt_kostnad", belop: 900, fra: "2026-09", antall_maaneder: 1, resultatkonto: "6340" });
    expect((await kall("PATCH", sti(`/periodiseringer/${tom.data.periodisering.id}`), { belop: 950, resultatkonto: "6300" })).data.periodisering).toMatchObject({ belop: 950, resultatkonto: "6300" });
    expect((await kall("DELETE", sti(`/periodiseringer/${tom.data.periodisering.id}`))).status).toBe(204);
    expect((await kall("GET", sti(`/periodiseringer/${tom.data.periodisering.id}`))).status).toBe(404);
  });

  it("reversering: det siste først, og lønn og refusjoner reverseres der de kommer fra", async () => {
    const jan = await finn("P-2026-3");
    expect((await kall("POST", sti(`/bilag/${jan.id}/reverser`), {})).data.error).toBe("Periodisering 1 har senere bokføringer. Reverser dem først.");
    const sep = await finn("P-2026-11");
    const r = await kall("POST", sti(`/bilag/${sep.id}/reverser`), {}, regnskap);
    expect(r.status, JSON.stringify(r.data)).toBe(201);
    expect(r.data).toMatchObject({ bilagsnummer: "P-2026-15", tekst: "Reversert: Periodiseringer september 2026", reverserer: sep.id, kilde: "periodisering" });
    expect(kort(r.data)).toEqual(kort(sep).map(([k, b]) => [k, -b]));
    expect((await finn("P-2026-11")).reversert_av).toBe(r.data.id);
    // September mangler igjen (forsikringen nå fordelt på 16 måneder: 4 000 / 16 = 250).
    expect((await kall("GET", sti("/maanedsavslutning?til=2026-09"))).data.maaneder.map((m: any) => [m.maaned, m.avskrivninger.sum, m.periodiseringer.sum])).toEqual([
      ["2026-09", 0, 3250],
    ]);
    // Manuelle bilag og anleggsmidlene reverseres med sin funksjon.
    const m = await finn("M-2026-2");
    expect((await kall("POST", sti(`/bilag/${m.id}/reverser`), { tekst: "Feil konto" })).data).toMatchObject({ bilagsnummer: "M-2026-3", tekst: "Feil konto" });
    expect((await kall("POST", sti(`/bilag/${m.id}/reverser`), {})).data.error).toBe("Bilaget kan ikke reverseres");
    const a = await finn("A-2026-4");
    expect((await kall("POST", sti(`/bilag/${a.id}/reverser`), {})).data.bilagsnummer).toBe("A-2026-5");
    expect((await kall("POST", sti(`/bilag/${crypto.randomUUID()}/reverser`), {})).status).toBe(404);

    // Lønnsbilaget (serie L) står i bilagslista, og reverseres ved å åpne kjøringen igjen.
    expect((await kall("PUT", `/api/org/${org}/lonn-oppsett`, { aktiv: true })).status).toBe(200);
    const ansatt = await kall("POST", `/api/org/${org}/ansatte`, {
      fornavn: "Kari",
      etternavn: "Regnskap",
      ansatt_fra: "2025-01-01",
      lonnstype: "maaned",
      maanedslonn: 50000,
      skattekort: "prosent",
      skatt_prosent: 30,
    });
    expect(ansatt.status, JSON.stringify(ansatt.data)).toBe(201);
    const kjoring = (await kall("POST", `/api/org/${org}/lonn/kjoringer`, { periode: "2026-09" })).data.id;
    expect((await kall("POST", `/api/org/${org}/lonn/kjoringer/${kjoring}/godkjenn`)).status).toBe(200);
    const lonn = await bilag("fra=2026-09-01&til=2026-12-31&kilde=lonn");
    expect(lonn.map((b) => [b.bilagsnummer, b.kilde])).toEqual([["L-2026-1", "lonn"]]);
    expect(lonn[0].posteringer.find((p: any) => p.konto === "5000")).toMatchObject({ navn: "Lønn til ansatte", belop: 50000 });
    const l = await kall("POST", sti(`/bilag/${lonn[0].id}/reverser`), {});
    expect([l.status, l.data.error]).toEqual([409, "Et lønnsbilag reverseres ved å åpne lønnskjøringen igjen (Lønn → Lønnskjøringer)"]);
  });

  it("tilgangen: eier, administrator og regnskap; ikke fakturerer", async () => {
    for (const s of ["/bilag", "/periodiseringer", "/saldobalanse", "/hovedbok", "/maanedsavslutning", "/kontoliste"])
      expect((await kall("GET", sti(s), undefined, fakturerer)).status, s).toBe(403);
    expect((await kall("POST", sti("/bilag"), { dato: "2026-01-01", tekst: "x", linjer: [{ konto: "1920", debet: 1 }, { konto: "2000", kredit: 1 }] }, fakturerer)).status).toBe(403);
    expect((await kall("GET", `/api/org/${org}/rapportmodul/regnskap.saldobalanse`, undefined, fakturerer)).status).toBe(403);
    expect((await kall("GET", sti("/saldobalanse?fra=2026-01-01&til=2026-12-31"), undefined, regnskap)).status).toBe(200);
  });
});
