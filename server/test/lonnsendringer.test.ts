// Lønns- og stillingsendringer med virkningsdato (0080_lonnsendringer.sql, lonnsendringer.ts,
// lonn.ts): det som gjelder en dag og det som var kjent på et tidspunkt, fastlønnen delt når lønnen
// endres i måneden, etterbetaling og trekk for måneder som er godkjent, og i appen: historikken,
// en endring tilbake i tid som gir etterbetaling i neste kjøring, en endring midt i måneden,
// sletting, endring med dato fra skjemaet, a-meldingen (stillingen ved månedsslutt, datoene for
// siste endring og opptjeningsperioden) og rapporten «Lønns- og stillingsendringer».
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { lagApi } from "../src/api.js";
import { byggLeveranse, hentGrunnlag, tilXml } from "../src/amelding.js";
import { somSystem } from "../src/db.js";
import type { Ansatt } from "../src/lonnsberegning.js";
import { endringstekster, etterbetaling, fastlonnLinjer, gjeldende, kjent, ukeDato, type GodkjentKjoring, type Lonnsendring } from "../src/lonnsendringer.js";
import { settLokalOppgavekjorer } from "../src/tjenester.js";

const her = path.dirname(fileURLToPath(import.meta.url));
const harXmllint = spawnSync("xmllint", ["--version"]).status === 0;

const A: Ansatt = {
  id: "ola",
  ansattnummer: 1,
  navn: "Ola Fast",
  fodselsdato: null,
  ansatt_fra: "2025-01-01",
  ansatt_til: null,
  lonnstype: "maaned",
  maanedslonn: 40000,
  timelonn: null,
  stillingsprosent: 80,
  ukentlig_arbeidstid: 37.5,
  ferie_dager: null,
  kontonr: null,
  skattekort: null,
  skatt_tabell: null,
  skatt_prosent: null,
  skatt_frikort: null,
  skattekort_aar: null,
};
const rad = (gjelder_fra: string, felt: Partial<Lonnsendring>, opprettet: number, slettet: number | null = null): Lonnsendring => ({
  id: `${gjelder_fra}-${opprettet}`,
  ansatt_id: "ola",
  gjelder_fra,
  lonnstype: null,
  maanedslonn: null,
  timelonn: null,
  stillingsprosent: null,
  ...felt,
  opprettet,
  slettet,
});
const FORSTE = rad("2025-01-01", { lonnstype: "maaned", maanedslonn: 40000, stillingsprosent: 80 }, 1000);
const SEPTEMBER: GodkjentKjoring = { id: "k9", periode: "2026-09-01", godkjent: 2000, timer: [], overtid: [], merarbeid: 0 };

describe("lønnshistorikken (uten database)", () => {
  it("det som gjelder en dag, og det som var kjent på et tidspunkt", () => {
    const rader = [
      FORSTE,
      rad("2026-03-01", { stillingsprosent: 100 }, 2000),
      rad("2026-09-01", { maanedslonn: 41000 }, 2500, 3000),
      rad("2026-09-01", { maanedslonn: 42000 }, 3000),
    ];
    const naa = kjent(rader);
    expect(naa.map((r) => r.id)).toEqual(["2025-01-01-1000", "2026-03-01-2000", "2026-09-01-3000"]);
    expect(kjent(rader, 1500).map((r) => r.id)).toEqual(["2025-01-01-1000"]);
    expect(kjent(rader, 2600).map((r) => r.maanedslonn)).toEqual([40000, null, 41000]);
    const felt = (x: Ansatt) => [x.lonnstype, x.maanedslonn, x.stillingsprosent];
    // Før den første raden gjelder den første; ellers det siste som er satt for hvert felt.
    expect(felt(gjeldende(A, naa, "2024-06-01"))).toEqual(["maaned", 40000, 80]);
    expect(felt(gjeldende(A, naa, "2026-03-15"))).toEqual(["maaned", 40000, 100]);
    expect(felt(gjeldende(A, naa, "2026-09-15"))).toEqual(["maaned", 42000, 100]);
    expect(felt(gjeldende(A, kjent(rader, 2600), "2026-09-15"))).toEqual(["maaned", 41000, 100]);
    expect(gjeldende(A, [], "2026-09-15")).toBe(A);
  });

  it("fastlønnen deles når lønnen endres i måneden (andelen av arbeidsdagene)", () => {
    expect(fastlonnLinjer(A, [FORSTE], "2026-10-01", "2026-10-31")).toEqual([
      { lonnsart: "fastlonn", tekst: "Fastlønn", antall: 1, sats: 40000, belop: 40000, nokkel: "fastlonn" },
    ]);
    // Oktober 2026 har 22 arbeidsdager: 10 før den 15., 12 fra den 15.
    expect(fastlonnLinjer(A, [FORSTE, rad("2026-10-15", { maanedslonn: 45000 }, 2000)], "2026-10-01", "2026-10-31")).toEqual([
      { lonnsart: "fastlonn", tekst: "Fastlønn 01.10.–14.10. (10 av 22 arbeidsdager)", antall: 0.4545, sats: 40000, belop: 18181.82, nokkel: "fastlonn" },
      { lonnsart: "fastlonn", tekst: "Fastlønn 15.10.–31.10. (12 av 22 arbeidsdager)", antall: 0.5455, sats: 45000, belop: 24545.45, nokkel: "fastlonn:2026-10-15" },
    ]);
    // Bare stillingen endret: én linje.
    expect(fastlonnLinjer(A, [FORSTE, rad("2026-10-15", { stillingsprosent: 100 }, 2000)], "2026-10-01", "2026-10-31")).toHaveLength(1);
    // Ansatt midt i måneden, og lønnen endret en uke etter.
    const ny = { ...A, ansatt_fra: "2026-10-12" };
    const linjer = fastlonnLinjer(ny, [{ ...FORSTE, gjelder_fra: "2026-10-12" }, rad("2026-10-20", { maanedslonn: 45000 }, 2000)], "2026-10-01", "2026-10-31");
    expect(linjer.map((l) => [l.tekst, l.belop])).toEqual([
      ["Fastlønn 12.10.–19.10. (6 av 22 arbeidsdager)", 10909.09],
      ["Fastlønn 20.10.–31.10. (9 av 22 arbeidsdager)", 18409.09],
    ]);
  });

  it("timene: lønnen fra uka begynner (eller periodens første dag); endringene som merknad", () => {
    expect(ukeDato("2026-09-28", "2026-10-01")).toBe("2026-10-01");
    expect(ukeDato("2026-10-05", "2026-10-01")).toBe("2026-10-05");
    const rader = [FORSTE, rad("2026-10-15", { maanedslonn: 45000, stillingsprosent: 100 }, 2000), rad("2026-11-01", { lonnstype: "time", timelonn: 312.5 }, 2000)];
    expect(endringstekster(A, rader, "2026-10-01", "2026-10-31")).toEqual(["Lønnen eller stillingen er endret fra 15.10.2026: 45 000 kr i måneden, 100 % stilling."]);
    expect(endringstekster(A, rader, "2026-11-01", "2026-11-30")).toEqual(["Lønnen eller stillingen er endret fra 01.11.2026: timelønn, 312,5 kr i timen."]);
    // Den første raden er ingen endring.
    expect(endringstekster(A, rader, "2025-01-01", "2025-01-31")).toEqual([]);
  });

  it("etterbetaling og trekk for en måned som er godkjent", () => {
    const opp = rad("2026-09-01", { maanedslonn: 42000 }, 3000);
    expect(etterbetaling(A, [FORSTE, opp], [SEPTEMBER], [])).toEqual({
      linjer: [
        {
          lonnsart: "etterbetaling",
          tekst: "Etterbetaling fastlønn for september 2026",
          antall: null,
          sats: null,
          belop: 2000,
          nokkel: "etterbetaling:2026-09",
          opptjent_fra: "2026-09-01",
          opptjent_til: "2026-09-30",
        },
      ],
      merknader: [],
    });
    // Alt etterbetalt i en annen kjøring.
    expect(etterbetaling(A, [FORSTE, opp], [SEPTEMBER], [{ kjoring_id: "k10", lonnsart: "etterbetaling", opptjent_fra: "2026-09-01", belop: 2000 }]).linjer).toEqual([]);
    // Kjent da kjøringen ble godkjent: ingenting.
    expect(etterbetaling(A, [FORSTE, opp], [{ ...SEPTEMBER, godkjent: 4000 }], []).linjer).toEqual([]);
    // Lavere lønn: trekk.
    expect(etterbetaling(A, [FORSTE, rad("2026-09-01", { maanedslonn: 39000 }, 3000)], [SEPTEMBER], []).linjer.map((l) => [l.tekst, l.belop])).toEqual([
      ["Trekk for for mye fastlønn i september 2026", -1000],
    ]);
    // En slettet endring etter godkjenningen: tilbake til det som gjaldt.
    const fjernet = rad("2026-08-01", { maanedslonn: 41000 }, 1500, 3000);
    expect(etterbetaling(A, [FORSTE, fjernet], [SEPTEMBER], []).linjer.map((l) => [l.lonnsart, l.belop])).toEqual([["etterbetaling", -1000]]);
    // Måneder før den ansatte begynte eller etter at den ansatte sluttet, regnes ikke.
    expect(etterbetaling({ ...A, ansatt_til: "2026-08-31" }, [FORSTE, opp], [SEPTEMBER], []).linjer).toEqual([]);
  });

  it("timelønnen med satsen hver dag, og overtiden med satsen ved månedsslutt", () => {
    const B: Ansatt = { ...A, id: "kari", lonnstype: "time", maanedslonn: null, timelonn: 250, stillingsprosent: 50 };
    const forste = rad("2025-01-01", { lonnstype: "time", timelonn: 250, stillingsprosent: 50 }, 1000);
    const k: GodkjentKjoring = {
      ...SEPTEMBER,
      timer: [
        { dato: "2026-09-14", timer: 8 },
        { dato: "2026-09-16", timer: 7.5 },
      ],
      overtid: [{ prosent: 50, antall: 2, tillegg: true }],
    };
    const e = etterbetaling(B, [forste, rad("2026-09-16", { timelonn: 275 }, 3000)], [k], []);
    expect(e.linjer.map((l) => [l.lonnsart, l.tekst, l.belop, l.nokkel])).toEqual([
      ["etterbetaling_time", "Etterbetaling timelønn for september 2026", 187.5, "etterbetaling_time:2026-09"],
      ["etterbetaling_overtid", "Etterbetaling overtid for september 2026", 25, "etterbetaling_overtid:2026-09"],
    ]);
  });

  it("kjøringer godkjent før lønnshistorikken: en merknad, ikke for den første raden", () => {
    const forste = { ...FORSTE, opprettet: 5000 };
    expect(etterbetaling(A, [forste, rad("2026-09-01", { maanedslonn: 42000 }, 6000)], [SEPTEMBER], [])).toEqual({
      linjer: [],
      merknader: ["Lønnen er endret med virkning for september 2026, som ble godkjent før lønnshistorikken kom. Legg til etterbetalingen for den måneden for hånd."],
    });
    expect(etterbetaling(A, [forste], [SEPTEMBER], [])).toEqual({ linjer: [], merknader: [] });
  });
});

describe.skipIf(!process.env.DATABASE_URL)("lønnsendringer i appen", () => {
  const app = lagApi();
  const eier = "Bearer test:uid-lsendr-eier:lsendr-eier@server.test:mfa";
  const kariBruker = "Bearer test:uid-lsendr-kari:kari.lsendr@server.test";
  const idag = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Oslo" }).format(new Date());
  let org: string;
  let ola: string;
  let kari: string;
  let okt: string;

  const kall = async (m: string, sti: string, k?: unknown, hvem = eier) => {
    const r = await app.request(sti, { method: m, headers: { authorization: hvem, "content-type": "application/json" }, body: k === undefined ? undefined : JSON.stringify(k) });
    return { status: r.status, data: (r.headers.get("content-type") ?? "").includes("json") ? ((await r.json()) as any) : await r.text() };
  };
  const slipp = (k: any, ansatt: string) => k.slipper.find((s: any) => s.ansatt_id === ansatt);
  const linjer = (s: any, ...arter: string[]) => s.linjer.filter((l: any) => !l.fjernet && arter.includes(l.lonnsart));
  const timer = async (dato: string, t: number, fra: string, til: string) => {
    const r = await kall("POST", `/api/org/${org}/timer`, { ansatt_id: kari, dato, timer: t });
    expect(r.status, JSON.stringify(r.data)).toBe(201);
    expect((await kall("POST", `/api/org/${org}/timer/lever`, { ansatt_id: kari, fra, til })).status).toBe(200);
    expect((await kall("POST", `/api/org/${org}/timer/godkjenn`, { ider: [r.data.id] })).data).toEqual({ godkjent: 1 });
  };
  const endring = (ansatt: string, b: Record<string, unknown>, hvem = eier) => kall("POST", `/api/org/${org}/ansatte/${ansatt}/lonnsendringer`, b, hvem);

  beforeAll(async () => {
    settLokalOppgavekjorer(async () => {});
    org = (await kall("POST", "/api/organisasjoner", { navn: "Lønnsendring Test AS" })).data.id;
    expect((await kall("PUT", `/api/org/${org}/lonn-oppsett`, { aktiv: true })).status).toBe(200);
    const ny = async (b: Record<string, unknown>) => {
      const r = await kall("POST", `/api/org/${org}/ansatte`, { ansatt_fra: "2025-01-01", yrkeskode: "2221104", skattekort: "prosent", skattekort_aar: 2026, ...b });
      expect(r.status, JSON.stringify(r.data)).toBe(201);
      return r.data.id as string;
    };
    ola = await ny({ fornavn: "Ola", etternavn: "Fast", lonnstype: "maaned", maanedslonn: 40000, stillingsprosent: 80, skatt_prosent: 30 });
    kari = await ny({ fornavn: "Kari", etternavn: "Time", lonnstype: "time", timelonn: 250, stillingsprosent: 50, skatt_prosent: 20, epost: "kari.lsendr@server.test" });
    const inv = await kall("POST", `/api/org/${org}/ansatte/${kari}/inviter`);
    expect((await kall("POST", "/api/invitasjoner/aksepter", { token: inv.data.lenke.split("/").pop() }, kariBruker)).status).toBe(200);
  });

  it("den første lønnen er historikken fra ansettelsen", async () => {
    const r = await kall("GET", `/api/org/${org}/ansatte/${ola}/lonnsendringer`);
    expect(r.status).toBe(200);
    expect(r.data).toEqual([
      expect.objectContaining({ gjelder_fra: "2025-01-01", lonnstype: "maaned", maanedslonn: 40000, timelonn: null, stillingsprosent: 80, grunn: "Ansatt", forste: true }),
    ]);
  });

  it("september godkjennes med lønnen som gjaldt da", async () => {
    await timer("2026-09-14", 8, "2026-09-14", "2026-09-20");
    await timer("2026-09-16", 7.5, "2026-09-14", "2026-09-20");
    const k = await kall("POST", `/api/org/${org}/lonn/kjoringer`, { periode: "2026-09" });
    expect(k.status, JSON.stringify(k.data)).toBe(201);
    expect(linjer(slipp(k.data, ola), "fastlonn").map((l: any) => l.belop)).toEqual([40000]);
    expect(linjer(slipp(k.data, kari), "timelonn").map((l: any) => [l.antall, l.belop])).toEqual([[15.5, 3875]]);
    expect((await kall("POST", `/api/org/${org}/lonn/kjoringer/${k.data.id}/godkjenn`)).data.status).toBe("godkjent");
  });

  it("en endring tilbake i tid: kontrollene, tilgangen og feltene på den ansatte", async () => {
    expect((await endring(ola, {})).data.error).toBe("Velg datoen endringen gjelder fra");
    expect((await endring(ola, { gjelder_fra: "2026-09-01" })).data.error).toBe("Skriv hva som endres");
    expect((await endring(ola, { gjelder_fra: "2024-12-01", maanedslonn: 41000 })).data.error).toBe("Endringen kan ikke gjelde fra før den ansatte begynte (01.01.2025)");
    expect((await endring(ola, { gjelder_fra: "2026-09-01", maanedslonn: 42000 }, kariBruker)).status).toBe(403);
    const r = await endring(ola, { gjelder_fra: "2026-09-01", maanedslonn: 42000, grunn: "Lønnsoppgjør" });
    expect(r.status, JSON.stringify(r.data)).toBe(201);
    expect(r.data.endringer.map((e: any) => [e.gjelder_fra, e.maanedslonn, e.grunn, e.forste])).toEqual([
      ["2026-09-01", 42000, "Lønnsoppgjør", false],
      ["2025-01-01", 40000, "Ansatt", true],
    ]);
    expect(r.data.ansatt).toMatchObject({ maanedslonn: 42000, stillingsprosent: 80, siste_lonnsendring: "2026-09-01" });
    // Kari får ny sats fra onsdag 16. september.
    expect((await endring(kari, { gjelder_fra: "2026-09-16", timelonn: 275 })).data.ansatt).toMatchObject({ timelonn: 275, siste_lonnsendring: "2026-09-16" });
    // Den ansatte ser sin egen historikk, men ikke andres.
    expect((await kall("GET", `/api/org/${org}/ansatte/${kari}/lonnsendringer`, undefined, kariBruker)).data.map((e: any) => e.timelonn)).toEqual([275, 250]);
    expect((await kall("GET", `/api/org/${org}/ansatte/${ola}/lonnsendringer`, undefined, kariBruker)).data).toEqual([]);
  });

  it("neste kjøring etterbetaler september, med opptjeningsperioden", async () => {
    await timer("2026-10-05", 8, "2026-10-05", "2026-10-11");
    const r = await kall("POST", `/api/org/${org}/lonn/kjoringer`, { periode: "2026-10" });
    expect(r.status, JSON.stringify(r.data)).toBe(201);
    okt = r.data.id;
    const o = slipp(r.data, ola);
    expect(linjer(o, "fastlonn").map((l: any) => [l.tekst, l.belop])).toEqual([["Fastlønn", 42000]]);
    expect(linjer(o, "etterbetaling")).toEqual([
      expect.objectContaining({
        tekst: "Etterbetaling fastlønn for september 2026",
        belop: 2000,
        nokkel: "etterbetaling:2026-09",
        opptjent_fra: "2026-09-01",
        opptjent_til: "2026-09-30",
      }),
    ]);
    const k = slipp(r.data, kari);
    expect(linjer(k, "timelonn", "etterbetaling_time").map((l: any) => [l.lonnsart, l.antall, l.belop])).toEqual([
      ["timelonn", 8, 2200],
      ["etterbetaling_time", null, 187.5],
    ]);
    // Beregnet på nytt: det samme (det som er etterbetalt i denne kjøringen, teller ikke).
    const b = (await kall("POST", `/api/org/${org}/lonn/kjoringer/${okt}/beregn`)).data;
    expect(linjer(slipp(b, ola), "etterbetaling").map((l: any) => l.belop)).toEqual([2000]);
  });

  it("en endring midt i måneden deler fastlønnen; sletting", async () => {
    const r = await endring(ola, { gjelder_fra: "2026-10-15", maanedslonn: 45000, stillingsprosent: 100, grunn: "Ny stilling" });
    expect(r.status).toBe(201);
    expect(r.data.ansatt.maanedslonn).toBe(idag >= "2026-10-15" ? 45000 : 42000);
    let k = (await kall("POST", `/api/org/${org}/lonn/kjoringer/${okt}/beregn`)).data;
    // Antallet lagres med to desimaler.
    expect(linjer(slipp(k, ola), "fastlonn").map((l: any) => [l.tekst, l.antall, l.sats, l.belop])).toEqual([
      ["Fastlønn 01.10.–14.10. (10 av 22 arbeidsdager)", 0.45, 42000, 19090.91],
      ["Fastlønn 15.10.–31.10. (12 av 22 arbeidsdager)", 0.55, 45000, 24545.45],
    ]);
    expect(slipp(k, ola).merknader).toContain("Lønnen eller stillingen er endret fra 15.10.2026: 45 000 kr i måneden, 100 % stilling.");
    // Den første kan ikke slettes; endringen kan.
    const forste = r.data.endringer.find((e: any) => e.forste);
    expect((await kall("DELETE", `/api/org/${org}/ansatte/${ola}/lonnsendringer/${forste.id}`)).data.error).toBe(
      "Den første lønnen kan ikke slettes; legg inn en endring i stedet",
    );
    const midt = r.data.endringer.find((e: any) => e.gjelder_fra === "2026-10-15");
    // Den ansatte ser ikke andres endringer.
    expect((await kall("DELETE", `/api/org/${org}/ansatte/${ola}/lonnsendringer/${midt.id}`, undefined, kariBruker)).status).toBe(404);
    const s = await kall("DELETE", `/api/org/${org}/ansatte/${ola}/lonnsendringer/${midt.id}`);
    expect(s.data.endringer.map((e: any) => e.gjelder_fra)).toEqual(["2026-09-01", "2025-01-01"]);
    expect(s.data.ansatt).toMatchObject({ maanedslonn: 42000, stillingsprosent: 80 });
    k = (await kall("POST", `/api/org/${org}/lonn/kjoringer/${okt}/beregn`)).data;
    expect(linjer(slipp(k, ola), "fastlonn").map((l: any) => l.belop)).toEqual([42000]);
    // Lagt inn igjen.
    expect((await endring(ola, { gjelder_fra: "2026-10-15", maanedslonn: 45000, stillingsprosent: 100, grunn: "Ny stilling" })).status).toBe(201);
  });

  it("endring fra skjemaet med datoen den gjelder fra", async () => {
    const p = await kall("PATCH", `/api/org/${org}/ansatte/${kari}`, { stillingsprosent: 60, lonn_gjelder_fra: "2026-10-01", lonn_grunn: "Flere vakter" });
    expect(p.status, JSON.stringify(p.data)).toBe(200);
    expect(p.data).toMatchObject({ stillingsprosent: 60, siste_stillingsendring: "2026-10-01" });
    const h = (await kall("GET", `/api/org/${org}/ansatte/${kari}/lonnsendringer`)).data;
    expect(h[0]).toMatchObject({ gjelder_fra: "2026-10-01", stillingsprosent: 60, timelonn: null, grunn: "Flere vakter" });
    expect((await kall("PATCH", `/api/org/${org}/ansatte/${kari}`, { stillingsprosent: 70, lonn_gjelder_fra: "2024-01-01" })).data.error).toBe(
      "Endringen kan ikke gjelde fra før den ansatte begynte (01.01.2025)",
    );
    // Fram i tid: feltet endres ikke før dagen kommer.
    const f = await kall("PATCH", `/api/org/${org}/ansatte/${kari}`, { timelonn: 300, lonn_gjelder_fra: "2026-11-01", lonn_grunn: "Ny sats" });
    expect(f.data.timelonn).toBe(idag >= "2026-11-01" ? 300 : 275);
  });

  it("a-meldingen: stillingen ved månedsslutt, datoene for siste endring og opptjeningsperioden", async () => {
    await kall("POST", `/api/org/${org}/lonn/kjoringer/${okt}/beregn`);
    expect((await kall("POST", `/api/org/${org}/lonn/kjoringer/${okt}/godkjenn`)).data.status).toBe("godkjent");
    const g = await somSystem((db) => hentGrunnlag(db, org, "2026-10"));
    const f = (id: string) => g.arbeidsforhold.find((x) => x.id === id)!;
    expect(f(ola)).toMatchObject({ stillingsprosent: 100, siste_lonnsendring: "2026-10-15", siste_stillingsendring: "2026-10-15" });
    expect(f(kari)).toMatchObject({ stillingsprosent: 60, siste_lonnsendring: "2026-09-16", siste_stillingsendring: "2026-10-01" });
    const fnr = (id: string) => (id === ola ? "13830197340" : "24880199664");
    const m = byggLeveranse({ ...g, org: { navn: "Lønnsendring Test AS", orgnr: "915000177" }, virksomhet: "915000185" }, { meldingsId: "a1b2c3d4-0000-4000-8000-000000000055", tidspunkt: "2026-11-03T09:00:00Z", fnr });
    const mottakere = (m.leveranse as any).oppgave.virksomhet[0].inntektsmottaker;
    const inntekt = (nr: string) => mottakere.find((x: any) => x.norskIdentifikator === nr).inntekt;
    expect(inntekt("13830197340")).toEqual([
      { fordel: "kontantytelse", utloeserArbeidsgiveravgift: true, inngaarIGrunnlagForTrekk: true, beloep: "43636.36", arbeidsforholdId: "1", loennsinntekt: { beskrivelse: "fastloenn" } },
      {
        startdatoOpptjeningsperiode: "2026-09-01",
        sluttdatoOpptjeningsperiode: "2026-09-30",
        fordel: "kontantytelse",
        utloeserArbeidsgiveravgift: true,
        inngaarIGrunnlagForTrekk: true,
        beloep: "2000.00",
        arbeidsforholdId: "1",
        loennsinntekt: { beskrivelse: "fastloenn" },
      },
    ]);
    expect(inntekt("24880199664").map((i: any) => [i.loennsinntekt.beskrivelse, i.beloep, i.startdatoOpptjeningsperiode ?? null])).toEqual([
      ["timeloenn", "2200.00", null],
      ["timeloenn", "187.50", "2026-09-01"],
    ]);
    if (harXmllint) {
      const fil = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "lonnsendring-")), "melding.xml");
      fs.writeFileSync(fil, tilXml(m));
      execFileSync("xmllint", ["--noout", "--schema", path.join(her, "xsd", "amelding_v2_3.xsd"), fil], { stdio: "pipe" });
    }
  });

  it("rapporten «Lønns- og stillingsendringer»", async () => {
    const r = await kall("GET", `/api/org/${org}/rapportmodul/lonn.endringer?fra=2026-09-01&til=2026-10-31`);
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data.rader.map((x: any) => [x.gjelder_fra, x.navn, x.foer, x.etter, x.grunn])).toEqual([
      ["2026-09-01", "Ola Fast", "fastlønn 40 000,00 kr i måneden, 80 % stilling", "fastlønn 42 000,00 kr i måneden, 80 % stilling", "Lønnsoppgjør"],
      ["2026-09-16", "Kari Time", "timelønn 250,00 kr i timen, 50 % stilling", "timelønn 275,00 kr i timen, 50 % stilling", ""],
      ["2026-10-01", "Kari Time", "timelønn 275,00 kr i timen, 50 % stilling", "timelønn 275,00 kr i timen, 60 % stilling", "Flere vakter"],
      ["2026-10-15", "Ola Fast", "fastlønn 42 000,00 kr i måneden, 80 % stilling", "fastlønn 45 000,00 kr i måneden, 100 % stilling", "Ny stilling"],
    ]);
    expect((await kall("GET", `/api/org/${org}/rapportmodul/lonn.endringer?fra=2026-09-01&til=2026-10-31`, undefined, kariBruker)).status).toBe(403);
  });
});
