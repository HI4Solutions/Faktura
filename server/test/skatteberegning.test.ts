// Skatteberegningen i årsoppgjøret (skatteberegning.ts, aarsoppgjor.ts, 0121_skatteberegning.sql):
// betalbar skatt med permanente og midlertidige forskjeller og fremførbart underskudd, utsatt skatt
// og utsatt skattefordel, bilaget i årsoppgjøret med endringen i utsatt skatt, og det brukeren legger
// inn.
import { beforeAll, describe, expect, it } from "vitest";
import { lagApi } from "../src/api.js";
import { regnskapskontoer, type Regnskapsoppsett } from "../src/anlegg.js";
import { disponering } from "../src/aarsoppgjor.js";
import { beregnSkatt, permanenteForskjeller, skattesats, type Forskjell, type Skattelinje } from "../src/skatteberegning.js";
import { settLokalOppgavekjorer } from "../src/tjenester.js";

const ingen: Skattelinje[] = [];
const midl = (ib: number, ub: number): Forskjell[] => [{ nokkel: "driftsmidler", navn: "Driftsmidler", ib, ub, fast: true }];
const beregn = (x: Partial<Parameters<typeof beregnSkatt>[0]>) =>
  beregnSkatt({ aar: 2025, resultatForSkatt: 0, permanente: ingen, midlertidige: midl(0, 0), underskuddIb: 0, underskuddKilde: "forste_aar", utsattIb: 0, inndata: {}, ...x });

describe("skatteberegningen uten database", () => {
  it("skattesatsen for selskaper", () => {
    expect([2026, 2019, 2018, 2017, 2016, 2015, 2014, 2013].map(skattesats)).toEqual([22, 22, 23, 24, 25, 27, 27, 28]);
  });

  it("overskudd: permanente forskjeller legges til, økningen i midlertidige forskjeller trekkes fra", () => {
    const s = beregn({ resultatForSkatt: 500000, permanente: [{ nokkel: "uten_fradrag", navn: "Kostnader uten fradrag", belop: 10000, fast: true }], midlertidige: midl(0, 12000) });
    expect([s.grunnlag, s.inntekt, s.betalbar, s.grunnlag_utsatt, s.utsatt_ub, s.endring_utsatt, s.skattekostnad]).toEqual([498000, 498000, 109560, 12000, 2640, 2640, 112200]);
    // Skattekostnaden er 22 % av resultatet med de permanente forskjellene.
    expect(s.skattekostnad).toBeCloseTo(0.22 * 510000, 2);
  });

  it("underskudd: fremføres, og den utsatte skattefordelen balanseføres bare når det er valgt", () => {
    const tap = beregn({ resultatForSkatt: -100000 });
    expect([tap.grunnlag, tap.inntekt, tap.betalbar, tap.underskudd_ub, tap.grunnlag_utsatt, tap.utsatt_ub, tap.skattekostnad]).toEqual([-100000, 0, 0, 100000, -100000, 0, 0]);
    const fordel = beregn({ resultatForSkatt: -100000, inndata: { skattefordel: true } });
    expect([fordel.utsatt_ub, fordel.endring_utsatt, fordel.skattekostnad]).toEqual([-22000, -22000, -22000]);
    // Året etter: underskuddet brukes, og fordelen går ned tilsvarende.
    const neste = beregn({ resultatForSkatt: 60000, underskuddIb: 100000, underskuddKilde: "aaret_for", utsattIb: -22000, inndata: { skattefordel: true } });
    expect([neste.underskudd_brukt, neste.inntekt, neste.betalbar, neste.underskudd_ub, neste.utsatt_ub, neste.endring_utsatt, neste.skattekostnad]).toEqual([
      60000, 0, 0, 40000, -8800, 13200, 13200,
    ]);
    // Mer overskudd enn underskudd: resten skattlegges.
    const rest = beregn({ resultatForSkatt: 150000, underskuddIb: 100000 });
    expect([rest.underskudd_brukt, rest.inntekt, rest.betalbar, rest.underskudd_ub]).toEqual([100000, 50000, 11000, 0]);
  });

  it("de permanente forskjellene fra kontoene i NS 4102", () => {
    const s = new Map([
      ["7350", 2000], // representasjon med fradrag: ingen forskjell
      ["7360", 5000],
      ["7410", 1000],
      ["7430", 500],
      ["8140", 300],
      ["8040", -400],
      ["8070", -10000], // utbytte etter fritaksmetoden
      ["8177", 2000], // tap på aksjer etter fritaksmetoden
      ["8078", -3000], // gevinst utenfor fritaksmetoden: skattepliktig
    ]);
    expect(permanenteForskjeller(s, { permanente_andre: -250, permanente_tekst: "Skattefri gave" }).map((l) => [l.nokkel, l.navn, l.belop])).toEqual([
      ["uten_fradrag", "Kostnader uten fradrag (representasjon, kontingenter, gaver og renter)", 6800],
      ["skattefrie", "Skattefrie renteinntekter", -400],
      ["fritak", "Aksjeinntekter og -tap etter fritaksmetoden", -8000],
      ["tre_prosent", "3 % av utbyttet etter fritaksmetoden", 300],
      ["andre", "Skattefri gave", -250],
    ]);
    expect(permanenteForskjeller(new Map(), {}).map((l) => [l.nokkel, l.belop])).toEqual([["andre", 0]]);
  });

  it("årsoppgjøret fører endringen i utsatt skatt mot utsatt skatt og utsatt skattefordel", () => {
    const k = regnskapskontoer({ kontoer: {} } as unknown as Regnskapsoppsett);
    const s = new Map([
      ["3200", -183000],
      ["6300", 183000 - 100000],
    ]);
    // Fra utsatt skattefordel 8 800 til utsatt skatt 1 320: endringen er 10 120.
    const d = disponering(s, k, 31240, 0, { for: { skatt: 0, fordel: 8800 }, ub: 1320 });
    expect([d.endring_utsatt, d.aarsresultat, d.overforing]).toEqual([10120, 100000 - 31240 - 10120, 100000 - 31240 - 10120]);
    expect(d.posteringer.map((p) => [p.konto, p.belop])).toEqual([
      ["8300", 31240],
      ["2500", -31240],
      ["8320", 10120],
      ["2120", -1320],
      ["1070", -8800],
      ["8960", 58640],
      ["2050", -58640],
    ]);
    expect(d.posteringer.reduce((t, p) => t + p.belop, 0)).toBe(0);
    // Uten utsatt skatt som før.
    expect(disponering(s, k, 0, 0).endring_utsatt).toBe(0);
  });
});

describe.skipIf(!process.env.DATABASE_URL)("skatteberegningen i appen", () => {
  const app = lagApi();
  const eier = "Bearer test:uid-skatt-eier:skatt-eier@server.test:mfa";
  const fakturerer = "Bearer test:uid-skatt-fakt:skatt-fakt@server.test:mfa";
  let org = "";
  const kall = async (metode: string, sti: string, kropp?: unknown, hvem = eier) => {
    const r = await app.request(sti, { method: metode, headers: { authorization: hvem, "content-type": "application/json" }, body: kropp === undefined ? undefined : JSON.stringify(kropp) });
    return { status: r.status, data: (r.headers.get("content-type") ?? "").includes("json") ? ((await r.json()) as any) : null };
  };
  const ok = async (metode: string, sti: string, kropp?: unknown) => {
    const r = await kall(metode, sti, kropp);
    expect(r.status, `${metode} ${sti}: ${JSON.stringify(r.data)}`).toBeLessThan(300);
    return r.data;
  };
  const o = (x: string) => `/api/org/${org}${x}`;
  const bilag = (dato: string, tekst: string, debet: string, kredit: string, belop: number) =>
    ok("POST", o("/regnskap/bilag"), { dato, tekst, linjer: [{ konto: debet, debet: belop }, { konto: kredit, kredit: belop }] });
  const posteringer = async (aar: number) => {
    const b = (await ok("GET", o(`/regnskap/bilag?fra=${aar}-12-31&til=${aar}-12-31&kilde=aarsoppgjor`))).bilag.filter((x: any) => !x.reverserer && !x.reversert_av);
    expect(b).toHaveLength(1);
    return b[0].posteringer.map((p: any) => [p.konto, p.belop]);
  };

  beforeAll(async () => {
    settLokalOppgavekjorer(async () => {});
    org = (await ok("POST", "/api/organisasjoner", { navn: "Skatteberegning AS", orgnr: "315000149" })).id;
    const inv = await ok("POST", o("/invitasjoner"), { epost: "skatt-fakt@server.test", rolle: "fakturerer" });
    expect((await kall("POST", "/api/invitasjoner/aksepter", { token: inv.lenke.split("/").pop() }, fakturerer)).status).toBe(200);
    // 2024: underskudd. 2025: overskudd, representasjon uten fradrag og en datamaskin som avskrives
    // fortere skattemessig (30 % saldo) enn i regnskapet (fem år).
    await bilag("2024-01-02", "Aksjekapital", "1920", "2000", 100000);
    await bilag("2024-06-30", "Husleie", "6300", "1920", 40000);
    await bilag("2025-03-31", "Konsultasjoner", "1920", "3200", 300000);
    await bilag("2025-06-30", "Husleie", "6300", "1920", 100000);
    await bilag("2025-09-30", "Kundemiddag", "7360", "1920", 5000);
    const a = await kall("POST", o("/regnskap/anleggsmidler"), {
      navn: "Datamaskiner",
      kategori: "kontormaskiner",
      anskaffet: "2025-01-15",
      kostpris: 60000,
      levetid_mnd: 60,
      anskaffelse: { motkonto: "1920", mva: 0 },
    });
    expect(a.status, JSON.stringify(a.data)).toBe(201);
    await ok("POST", o("/regnskap/avskrivninger"), { til: "2025-12" });
  });

  it("2024: underskuddet fremføres; utsatt skattefordel balanseføres når det er valgt", async () => {
    const s = (await ok("GET", o("/regnskap/aarsoppgjor?aar=2024"))).skatteberegning;
    expect(s).toMatchObject({
      aar: 2024,
      sats: 22,
      resultat_for_skatt: -40000,
      grunnlag: -40000,
      underskudd_ib: 0,
      underskudd_kilde: "forste_aar",
      underskudd_ub: 40000,
      inntekt: 0,
      betalbar: 0,
      grunnlag_utsatt: -40000,
      skattefordel: false,
      utsatt_ub: 0,
      skattekostnad: 0,
    });
    const m = await ok("PUT", o("/regnskap/aarsoppgjor/2024/skatteberegning"), { skattefordel: true });
    expect(m.skatteberegning).toMatchObject({ skattefordel: true, utsatt_ub: -8800, endring_utsatt: -8800, skattekostnad: -8800 });
    const r = await ok("POST", o("/regnskap/aarsoppgjor/2024"), { skatt: 0, utsatt_skatt: -8800 });
    expect(r.status.oppgjor).toMatchObject({ utsatt_skatt: -8800, endring_utsatt: -8800, aarsresultat: -31200, stemmer: true });
    expect(await posteringer(2024)).toEqual([
      ["8320", -8800],
      ["1070", 8800],
      ["8960", -31200],
      ["2050", 31200],
    ]);
  });

  it("2025: underskuddet fra 2024 brukes, forskjellene for driftsmidlene og utsatt skatt i stedet for skattefordelen", async () => {
    const s = (await ok("GET", o("/regnskap/aarsoppgjor?aar=2025"))).skatteberegning;
    expect(s.permanente.map((l: any) => [l.nokkel, l.belop])).toEqual([
      ["uten_fradrag", 5000],
      ["andre", 0],
    ]);
    expect(s.midlertidige.map((f: any) => [f.nokkel, f.ib, f.ub])).toEqual([
      ["driftsmidler", 0, 6000], // regnskapsmessig 48 000, skattemessig 42 000
      ["gevinst_tap", 0, 0],
      ["andre", 0, 0],
    ]);
    expect(s).toMatchObject({
      resultat_for_skatt: 183000,
      sum_permanente: 5000,
      endring_midlertidige: 6000,
      grunnlag: 182000,
      underskudd_ib: 40000,
      underskudd_kilde: "aaret_for",
      underskudd_brukt: 40000,
      underskudd_ub: 0,
      inntekt: 142000,
      betalbar: 31240,
      grunnlag_utsatt: 6000,
      utsatt_ub: 1320,
      utsatt_ib: -8800,
      endring_utsatt: 10120,
      skattekostnad: 41360,
    });
    // Skattekostnaden er 22 % av resultatet med de permanente forskjellene, over de to årene.
    expect(s.skattekostnad - 8800).toBeCloseTo(0.22 * (183000 + 5000 - 40000), 2);

    const r = await ok("POST", o("/regnskap/aarsoppgjor/2025"), { skatt: s.betalbar, utsatt_skatt: s.utsatt_ub });
    expect(r.status.oppgjor).toMatchObject({ skatt: 31240, utsatt_skatt: 1320, endring_utsatt: 10120, aarsresultat: 141640, overforing: 141640, stemmer: true });
    expect(await posteringer(2025)).toEqual([
      ["8300", 31240],
      ["2500", -31240],
      ["8320", 10120],
      ["2120", -1320],
      ["1070", -8800],
      ["8960", 141640],
      ["2050", -141640],
    ]);
    // Resultatregnskapet og balansen etter årsoppgjøret.
    const linje = (l: any[], n: string) => l.find((x) => x.nokkel === n)?.belop;
    expect([linje(r.status.resultat, "skatt"), linje(r.status.resultat, "aarsresultat")]).toEqual([-41360, 141640]);
    expect([linje(r.status.balanse, "langsiktig"), linje(r.status.balanse, "udisponert")]).toEqual([1320, 0]);
    // Bokført på nytt med det samme: stemmer.
    expect((await ok("POST", o("/regnskap/aarsoppgjor/2025"), {})).bilag).toBe(null);
  });

  it("det brukeren legger inn: underskudd fra skattemeldingen, andre forskjeller, og null fjerner", async () => {
    const m = (
      await ok("PUT", o("/regnskap/aarsoppgjor/2025/skatteberegning"), {
        underskudd_ib: 10000,
        permanente_andre: 1000,
        permanente_tekst: "Bøter",
        midlertidige_andre_ub: -2000,
        midlertidige_tekst: "Avsetning for garantier",
      })
    ).skatteberegning;
    expect(m.permanente.at(-1)).toMatchObject({ nokkel: "andre", navn: "Bøter", belop: 1000 });
    expect(m.midlertidige.at(-1)).toMatchObject({ nokkel: "andre", navn: "Avsetning for garantier", ib: 0, ub: -2000 });
    expect(m).toMatchObject({
      sum_permanente: 6000,
      midlertidige_ub: 4000,
      grunnlag: 185000,
      underskudd_ib: 10000,
      underskudd_kilde: "lagt_inn",
      inntekt: 175000,
      betalbar: 38500,
      utsatt_ub: 880,
      utsatt_ib: -8800,
      endring_utsatt: 9680,
      skattekostnad: 48180,
    });
    // Det bokførte årsoppgjøret er det samme til det bokføres på nytt.
    expect((await ok("GET", o("/regnskap/aarsoppgjor?aar=2025"))).oppgjor).toMatchObject({ skatt: 31240, utsatt_skatt: 1320, stemmer: true });
    const n = (await ok("PUT", o("/regnskap/aarsoppgjor/2025/skatteberegning"), { underskudd_ib: null })).skatteberegning;
    expect(n).toMatchObject({ underskudd_ib: 40000, underskudd_kilde: "aaret_for" });
    expect(n.inndata).toEqual({ permanente_andre: 1000, permanente_tekst: "Bøter", midlertidige_andre_ub: -2000, midlertidige_tekst: "Avsetning for garantier" });
    // Året etter: de andre midlertidige forskjellene følger med.
    const neste = (await ok("GET", o("/regnskap/aarsoppgjor?aar=2026"))).skatteberegning;
    expect(neste.midlertidige.at(-1)).toMatchObject({ ib: -2000, ub: -2000 });
  });

  it("rapporten i rapportmodulen", async () => {
    await ok("PUT", o("/regnskap/aarsoppgjor/2025/skatteberegning"), { permanente_andre: null, permanente_tekst: null, midlertidige_andre_ub: null, midlertidige_tekst: null });
    const r = await ok("GET", o("/rapportmodul/regnskap.skatteberegning?aar=2025"));
    expect(r).toMatchObject({ id: "regnskap.skatteberegning", navn: "Skatteberegning", periode: "2025" });
    expect(r.merknad).toBe("Forslag regnet fra regnskapet; skattemeldingen gjelder. Fremførbart underskudd 1.1. er regnet fra 2024.");
    expect(r.kolonner.map((k: any) => k.navn)).toEqual(["Post", "1.1.", "Beløp"]);
    expect(r.rader).toContainEqual({ post: "Resultat før skattekostnad", ib: null, belop: 183000 });
    expect(r.rader).toContainEqual({ post: "  Kostnader uten fradrag (representasjon, kontingenter, gaver og renter)", ib: null, belop: 5000 });
    expect(r.rader).toContainEqual({ post: "  Fremførbart underskudd som brukes", ib: null, belop: -40000 });
    expect(r.rader).toContainEqual({ post: "Betalbar skatt (22 %)", ib: null, belop: 31240 });
    expect(r.rader).toContainEqual({ post: "  Driftsmidler", ib: 0, belop: 6000 });
    expect(r.rader).toContainEqual({ post: "Utsatt skatt (22 %)", ib: -8800, belop: 1320 });
    expect(r.rader.at(-1)).toEqual({ post: "Skattekostnad", ib: null, belop: 41360 });
  });

  it("kontrollene og tilgangen", async () => {
    expect((await kall("PUT", o("/regnskap/aarsoppgjor/2025/skatteberegning"), { underskudd_ib: -5 })).data.error).toBe("Underskuddet skrives som et positivt beløp");
    expect((await kall("PUT", o("/regnskap/aarsoppgjor/2025/skatteberegning"), { ukjent: 1 })).status).toBe(400);
    expect((await kall("PUT", o("/regnskap/aarsoppgjor/2099/skatteberegning"), {})).data.error).toBe("Året har ikke begynt");
    expect((await kall("PUT", o("/regnskap/aarsoppgjor/2025/skatteberegning"), { skattefordel: true }, fakturerer)).status).toBe(403);
    expect((await kall("GET", o("/regnskap/aarsoppgjor?aar=2025"), undefined, fakturerer)).status).toBe(403);
  });
});
