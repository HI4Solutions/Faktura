// Lønnsberegningen uten database (lonnsberegning.ts): utbetalingsdatoen og fristene, linjene for
// fastlønn, timer, overtid, tillegg, sykepenger, feriepenger og ferietrekk, skattetrekket for
// hvert skattekort, OTP og arbeidsgiveravgiften.
import { describe, expect, it } from "vitest";
import { AML } from "../src/arbeidstid.js";
import {
  arbeidsgiveravgift,
  arbeidsgiverperiode,
  fastlonn,
  feriepengelinjer,
  ferietrekk,
  frister,
  grunnbelop,
  sykelinjer,
  summer,
  tabelloppslag,
  tilleggslinjer,
  timelinjer,
  timesats,
  utbetalingsdato,
  type Ansatt,
  type Linje,
  type Oppsett,
  type Trekkgrunnlag,
} from "../src/lonnsberegning.js";

const kari: Ansatt = {
  id: "a1",
  ansattnummer: 1,
  navn: "Kari Fast",
  fodselsdato: "1980-05-05",
  ansatt_fra: "2020-01-01",
  ansatt_til: null,
  lonnstype: "maaned",
  maanedslonn: 50000,
  timelonn: null,
  stillingsprosent: 100,
  ukentlig_arbeidstid: 37.5,
  ferie_dager: null,
  kontonr: "12345678903",
  skattekort: "prosent",
  skatt_tabell: null,
  skatt_prosent: 30,
  skatt_frikort: null,
  skattekort_aar: 2026,
};
const per: Ansatt = { ...kari, id: "a2", ansattnummer: 2, navn: "Per Time", lonnstype: "time", maanedslonn: null, timelonn: 250, stillingsprosent: 50 };
const oppsett: Oppsett = { ...AML, aga_sone: "1", otp_prosent: 2, feriepenger_prosent: 12, ferie_dager: 25 };
const trekk = (a: Ansatt, x: Partial<Trekkgrunnlag> = {}): Trekkgrunnlag => ({ ansatt: a, aar: 2026, ekstra: false, halvSkatt: false, tabell: null, frikortBrukt: 0, ...x });
const linje = (lonnsart: string, belop: number, x: Partial<Linje> = {}): Linje => ({ lonnsart, tekst: lonnsart, antall: null, sats: null, belop, nokkel: null, ...x });
const dager = (fra: string, timer: number[]) =>
  timer.map((t, i) => ({ id: `f${i}`, dato: new Date(Date.parse(`${fra}T12:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10), timer: t, overtid_prosent: null }));

describe("datoer", () => {
  it("utbetalingsdatoen er lønnsdagen, eller virkedagen før", () => {
    expect(utbetalingsdato("2026-10-01", 20)).toBe("2026-10-20");
    expect(utbetalingsdato("2026-06-01", 20)).toBe("2026-06-19"); // lørdag
    expect(utbetalingsdato("2026-02-01", 31)).toBe("2026-02-27"); // kort måned og lørdag
    expect(utbetalingsdato("2026-05-01", 17)).toBe("2026-05-15"); // grunnlovsdagen er en søndag
  });

  it("skattetrekket betales første virkedag etter, arbeidsgiveravgiften annenhver måned", () => {
    expect(frister("2026-10-20")).toEqual({ skattetrekk: "2026-10-21", aga: "2026-11-16" }); // 15. november er en søndag
    expect(frister("2026-12-18")).toEqual({ skattetrekk: "2026-12-21", aga: "2027-01-15" });
    expect(frister("2026-06-19")).toEqual({ skattetrekk: "2026-06-22", aga: "2026-07-15" });
  });

  it("grunnbeløpet fra 1. mai", () => {
    expect(grunnbelop("2026-04-30")).toBe(130160);
    expect(grunnbelop("2026-05-01")).toBe(136549);
  });
});

describe("linjene", () => {
  it("fastlønn for hele måneden, og for arbeidsdagene den ansatte er ansatt", () => {
    expect(fastlonn(kari, "2026-10-01", "2026-10-31")).toMatchObject({ lonnsart: "fastlonn", antall: 1, sats: 50000, belop: 50000 });
    expect(fastlonn({ ...kari, ansatt_fra: "2026-10-15" }, "2026-10-01", "2026-10-31")).toMatchObject({
      tekst: "Fastlønn (12 av 22 arbeidsdager)",
      belop: 27272.73,
    });
    expect(fastlonn({ ...kari, ansatt_til: "2026-09-30" }, "2026-10-01", "2026-10-31")).toBeNull();
    expect(fastlonn(per, "2026-10-01", "2026-10-31")).toBeNull();
  });

  it("timelønn for alle timene og overtidstillegg for overtiden", () => {
    // 10 timer fem dager: 1 time over dagsgrensen hver dag (5), og de 45 ordinære er 5 over uka.
    const uke = { alle: dager("2026-10-05", [10, 10, 10, 10, 10]), betalt: [] };
    const t = timelinjer(per, AML, [uke]);
    expect(t.linjer).toEqual([
      { lonnsart: "timelonn", tekst: "Timelønn", antall: 50, sats: 250, belop: 12500, nokkel: "timelonn" },
      { lonnsart: "overtid", tekst: "Overtidstillegg 40 %", antall: 10, sats: 100, belop: 1000, nokkel: "overtid:40" },
    ]);
    // Det som er lønnet før i uka, trekkes fra (overtiden regnes på hele uka).
    const resten = timelinjer(per, AML, [{ alle: uke.alle, betalt: uke.alle.slice(0, 3) }]);
    expect(resten.linjer.map((l) => [l.lonnsart, l.antall])).toEqual([
      ["timelonn", 20],
      ["overtid", 7],
    ]);
  });

  it("merarbeid og overtid for den med fastlønn", () => {
    expect(timesats(kari)).toBe(307.6923);
    const t = timelinjer(kari, AML, [{ alle: dager("2026-10-05", [8, 8, 8, 8, 10]), betalt: [] }]);
    // 42 timer: 1 time over dagsgrensen, og de 41 ordinære er 1 over uka (2 timer overtid);
    // merarbeid 40 - 37,5 = 2,5.
    expect(t.linjer).toEqual([
      { lonnsart: "merarbeid", tekst: "Merarbeid", antall: 2.5, sats: 307.6923, belop: 769.23, nokkel: "merarbeid" },
      { lonnsart: "overtid", tekst: "Overtid 40 %", antall: 2, sats: 430.7692, belop: 861.54, nokkel: "overtid:40" },
    ]);
    expect(t.ekstraTimer).toBe(4.5);
  });

  it("faste tillegg per måned (for dagene) og per time", () => {
    const l = tilleggslinjer(
      { ...per, ansatt_fra: "2026-10-17" },
      [
        { id: "t1", navn: "Ansvarstillegg", belop: 3100, per: "maaned", fra: null, til: null },
        { id: "t2", navn: "Kveldstillegg", belop: 50, per: "time", fra: null, til: null },
      ],
      "2026-10-01",
      "2026-10-31",
      20,
      0,
    );
    expect(l).toEqual([
      { lonnsart: "fast_tillegg", tekst: "Ansvarstillegg (15 av 31 dager)", antall: 0.4839, sats: 3100, belop: 1500, nokkel: "tillegg:t1" },
      { lonnsart: "fast_tillegg", tekst: "Kveldstillegg", antall: 20, sats: 50, belop: 1000, nokkel: "tillegg:t2" },
    ]);
  });

  it("arbeidsgiverperioden: 16 kalenderdager, sammenhengende fravær teller sammen, og fire uker i arbeid først", () => {
    const p = arbeidsgiverperiode(
      [
        { fra: "2026-10-01", til: "2026-10-10", type: "syk" },
        { fra: "2026-10-20", til: "2026-10-30", type: "syk" }, // 9 dager etter: samme arbeidsgiverperiode
      ],
      "2025-01-01",
    );
    expect(p.agp.size).toBe(16);
    expect([...p.agp].at(-1)).toBe("2026-10-25");
    expect(p.etter.size).toBe(5);
    const ny = arbeidsgiverperiode([{ fra: "2026-10-05", til: "2026-10-07", type: "syk" }], "2026-09-20");
    expect(ny.agp.size).toBe(0);
    expect(ny.utenOpptjening.size).toBe(3);
  });

  it("sykepenger og omsorgsdager for den med timelønn (de planlagte timene)", () => {
    const agp = new Set(["2026-10-05", "2026-10-06"]);
    const s = sykelinjer(
      per,
      [
        { dato: "2026-10-05", timer: 7.5, type: "syk" },
        { dato: "2026-10-06", timer: 0, type: "syk" },
        { dato: "2026-10-12", timer: 6, type: "sykt_barn" },
        { dato: "2026-10-13", timer: 6, type: "sykt_barn" },
      ],
      agp,
      9,
    );
    expect(s.linjer).toEqual([
      { lonnsart: "sykepenger", tekst: "Sykepenger i arbeidsgiverperioden (1 dag)", antall: 7.5, sats: 250, belop: 1875, nokkel: "sykepenger" },
      { lonnsart: "omsorgspenger", tekst: "Omsorgspenger, sykt barn (1 dag)", antall: 6, sats: 250, belop: 1500, nokkel: "omsorgspenger" },
    ]);
    expect(s.merknader[0]).toContain("1 dag med sykt barn er over de 10 omsorgsdagene");
    expect(sykelinjer(kari, [{ dato: "2026-10-05", timer: 7.5, type: "syk" }], agp, 0).linjer).toEqual([]);
  });

  it("feriepengene minus det som er utbetalt, og den ekstra ferieuka det året den ansatte fyller 60", () => {
    expect(feriepengelinjer(kari, oppsett, 2025, 600000, 0, 0, "2026-06-19")).toEqual([
      { lonnsart: "feriepenger", tekst: "Feriepenger opptjent 2025", antall: 600000, sats: 12, belop: 72000, nokkel: "feriepenger:2025", opptjeningsaar: 2025 },
    ]);
    expect(feriepengelinjer(kari, oppsett, 2025, 600000, 72000, 0, "2026-06-19")).toEqual([]);
    // Født 1966: fyller 60 i 2026, ferieåret for 2025. 2,3 % av inntil 6 G.
    const eldre = feriepengelinjer({ ...kari, fodselsdato: "1966-08-01" }, oppsett, 2025, 900000, 0, 0, "2026-06-19");
    expect(eldre[1]).toEqual({
      lonnsart: "feriepenger_60",
      tekst: "Feriepenger for den ekstra ferieuka (2025)",
      antall: 819294,
      sats: 2.3,
      belop: 18843.76,
      nokkel: "feriepenger_60:2025",
      opptjeningsaar: 2025,
    });
    expect(feriepengelinjer({ ...kari, fodselsdato: "1967-01-01" }, oppsett, 2025, 900000, 0, 0, "2026-06-19")).toHaveLength(1);
  });

  it("trekket i lønnen for ferien: årslønnen / 260 per feriedag", () => {
    expect(ferietrekk(kari, oppsett)).toEqual({
      lonnsart: "ferietrekk",
      tekst: "Trekk i lønn for ferie (25 dager)",
      antall: 25,
      sats: 2307.6923,
      belop: -57692.31,
      nokkel: "ferietrekk",
    });
    expect(ferietrekk({ ...kari, ferie_dager: 30 }, oppsett)?.antall).toBe(30);
    expect(ferietrekk(per, oppsett)).toBeNull();
  });
});

describe("skattetrekket og summene", () => {
  const tabell = [
    { grunnlag: 49800, trekk: 14000 },
    { grunnlag: 49900, trekk: 14040 },
    { grunnlag: 50000, trekk: 14080 },
  ];

  it("tabelloppslag: raden under, ingenting under tabellen, og videre over den", () => {
    expect(tabelloppslag(tabell, 49950)).toEqual({ trekk: 14040, over: false });
    expect(tabelloppslag(tabell, 1000)).toEqual({ trekk: 0, over: false });
    expect(tabelloppslag(tabell, 50050)).toEqual({ trekk: 14080, over: false });
    expect(tabelloppslag(tabell, 51000)).toEqual({ trekk: 14480, over: true });
  });

  it("prosenttrekk, med utgifter og trekk etter skatt", () => {
    const s = summer([linje("fastlonn", 50000), linje("utgift", 600), linje("trekk_etter_skatt", -1000)], oppsett, trekk(kari), "2026-10-20", null);
    expect(s).toMatchObject({
      brutto: 50000,
      trekkpliktig: 50000,
      skattetrekk: 15000,
      trekkmetode: "Prosenttrekk 30 %",
      utgifter: 600,
      trekk_etter_skatt: -1000,
      netto: 34600,
      feriepengegrunnlag: 50000,
      feriepenger_opptjent: 6000,
      otp_grunnlag: 50000,
      otp: 1000,
      aga_grunnlag: 51000,
      merknader: [],
    });
  });

  it("tabelltrekk, halv skatt, og prosentsatsen når tabellene ikke er lastet inn", () => {
    const a = { ...kari, skattekort: "tabell" as const, skatt_tabell: 7100, skatt_prosent: 31 };
    expect(summer([linje("fastlonn", 49950)], oppsett, trekk(a, { tabell }), "2026-10-20", null)).toMatchObject({ skattetrekk: 14040, trekkmetode: "Tabell 7100" });
    expect(summer([linje("fastlonn", 49950)], oppsett, trekk(a, { tabell, halvSkatt: true }), "2026-12-18", null)).toMatchObject({
      skattetrekk: 7020,
      trekkmetode: "Tabell 7100 (halv skatt)",
    });
    const uten = summer([linje("fastlonn", 50000)], oppsett, trekk(a), "2026-10-20", null);
    expect(uten.skattetrekk).toBe(15500);
    expect(uten.merknader[0]).toContain("Trekktabellene for 2026 er ikke lastet inn");
    // En ekstra kjøring: prosentsatsen på tabellkortet.
    expect(summer([linje("bonus", 10000)], oppsett, trekk(a, { tabell, ekstra: true }), "2026-10-20", null)).toMatchObject({
      skattetrekk: 3100,
      trekkmetode: "Prosenttrekk 31 % (tabellkort, ekstra kjøring)",
    });
  });

  it("ikke tabelltrekk av feriepengene i ferieåret, men av tillegget for den ekstra ferieuka", () => {
    const a = { ...kari, skattekort: "tabell" as const, skatt_tabell: 7100, skatt_prosent: 31 };
    const s = summer(
      [
        linje("fastlonn", 50000),
        linje("feriepenger", 72000, { opptjeningsaar: 2025 }),
        linje("feriepenger_60", 10000, { opptjeningsaar: 2025 }),
        linje("ferietrekk", -57692.31),
      ],
      oppsett,
      trekk(a, { tabell }),
      "2026-06-19",
      null,
    );
    // Grunnlaget for tabelltrekket: 50 000 - 57 692,31 (ferietrekket) = under tabellen; 31 % av 10 000.
    expect(s.trekkpliktig).toBe(74307.69);
    expect(s.trekkgrunnlag).toBe(0);
    expect(s.skattetrekk).toBe(3100);
    expect(s.feriepengegrunnlag).toBe(50000);
    expect(s.merknader).toContain("Det trekkes ikke skatt av feriepengene (tabelltrekk).");
  });

  it("frikort til beløpet er brukt opp, og 50 % uten skattekort", () => {
    const fri = { ...kari, skattekort: "frikort" as const, skatt_prosent: null, skatt_frikort: 65000 };
    expect(summer([linje("timelonn", 10000)], oppsett, trekk(fri, { frikortBrukt: 50000 }), "2026-10-20", null)).toMatchObject({
      skattetrekk: 0,
      trekkmetode: "Frikort (5 000 kr igjen)",
    });
    const over = summer([linje("timelonn", 10000)], oppsett, trekk(fri, { frikortBrukt: 60000 }), "2026-10-20", null);
    expect(over).toMatchObject({ skattetrekk: 2500, trekkgrunnlag: 5000 });
    expect(over.merknader[0]).toContain("Frikortet er brukt opp");
    const ingen = summer([linje("timelonn", 10000)], oppsett, trekk({ ...kari, skattekort: null, skatt_prosent: null }), "2026-10-20", null);
    expect(ingen).toMatchObject({ skattetrekk: 5000, trekkmetode: "Uten skattekort (50 %)" });
    expect(ingen.merknader[0]).toContain("Mangler skattekort");
  });

  it("frikort uten beløpsgrense (og ikke trekkplikt) gir ikke trekk", () => {
    const fri = { ...kari, skattekort: "frikort" as const, skatt_prosent: null, skatt_frikort: null };
    const s = summer([linje("timelonn", 80000)], oppsett, trekk(fri, { frikortBrukt: 500000 }), "2026-10-20", null);
    expect(s).toMatchObject({ skattetrekk: 0, trekkgrunnlag: 0, trekkmetode: "Frikort uten beløpsgrense", netto: 80000 });
    expect(s.merknader).toEqual([]);
  });

  it("tilleggsopplysninger og arbeidstillatelse fra Skatteetaten gir merknader", () => {
    const a = { ...kari, skattekort_tillegg: ["oppholdPaaSvalbard", "oppholdITiltakssone"], skattekort_resultat: "vurderArbeidstillatelse" };
    const s = summer([linje("fastlonn", 30000)], oppsett, trekk(a), "2026-10-20", null);
    expect(s.merknader.some((m) => m.includes("Svalbard"))).toBe(true);
    expect(s.merknader.some((m) => m.includes("arbeidstillatelse"))).toBe(true);
    expect(s.merknader.some((m) => m.includes("tiltakssonen"))).toBe(false);
  });

  it("skattetrekket satt for hånd, og skattekort for et annet år", () => {
    const s = summer([linje("fastlonn", 50000)], oppsett, trekk({ ...kari, skattekort_aar: 2025 }), "2026-10-20", 12345);
    expect(s).toMatchObject({ skattetrekk: 12345, trekkmetode: "Prosenttrekk 30 % – endret for hånd", netto: 37655 });
    expect(s.merknader).toContain("Skattekortet er for 2025, ikke 2026. Hent det nye skattekortet.");
  });

  it("OTP opp til 12 G i året, og ikke av overtid og bonus", () => {
    const s = summer([linje("fastlonn", 200000), linje("overtid", 5000), linje("bonus", 10000)], oppsett, trekk(kari), "2026-10-20", null);
    expect(s.otp_grunnlag).toBe(200000);
    expect(s.otp).toBe(2730.98); // 2 % av 136 549 (12 G / 12)
    expect(s.aga_grunnlag).toBe(217730.98);
  });
});

describe("arbeidsgiveravgiften", () => {
  it("satsen i sonen", () => {
    expect(arbeidsgiveravgift("1", [100000, 50000], 0)).toEqual([
      { aga: 14100, sats: 14.1 },
      { aga: 7050, sats: 14.1 },
    ]);
    expect(arbeidsgiveravgift("5", [100000], 0)).toEqual([{ aga: 0, sats: 0 }]);
  });

  it("sone 1a: redusert sats til fribeløpet er brukt, deretter full sats", () => {
    // Spart avgift er 3,5 % av grunnlaget; 849 000 kr er brukt, så 1 000 kr igjen.
    const r = arbeidsgiveravgift("1a", [20000, 50000], 849000);
    expect(r[0]).toEqual({ aga: 2120, sats: 10.6 }); // spart 700
    expect(r[1]).toEqual({ aga: 6750, sats: 13.5 }); // 7 050 - 300 som er igjen
  });
});
