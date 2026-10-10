// Regnskapsmodulen, anleggsmidlene (anlegg.ts, saldo.ts, regnskapRuter.ts, regnskapRapporter.ts):
// avskrivningsplanen (lineær ned til restverdien, avrunding, nedskrivning og ny levetid framover,
// det som er ført før HI4, avgang), planen per år, bilagene (salg med gevinst og tap, utrangering),
// saldoavskrivningene (samlesaldo med tilgang og vederlag, lav og negativ saldo, goodwill i gruppe
// b, lineært, tomt, gevinst- og tapskontoen), og i appen: registrering med bokført anskaffelse,
// månedsavslutningen, nedskrivning og reversering (ikke for goodwill), salg, reversering av bilag,
// endringer som stoppes, rapportene og tilgangen.
import { beforeAll, describe, expect, it } from "vitest";
import { lagApi } from "../src/api.js";
import { aarsplan, avgangsbilag, avskrivningsplan, status, type Anleggsmiddel, type Hendelse } from "../src/anlegg.js";
import { saldoskjema } from "../src/saldo.js";

const anlegg = (x: Partial<Anleggsmiddel>): Anleggsmiddel => ({
  id: "a",
  nummer: 1,
  navn: "Varebil",
  beskrivelse: null,
  kategori: "varebil",
  anskaffet: "2026-01-10",
  avskrives_fra: "2026-01-01",
  kostpris: 120000,
  restverdi: 0,
  levetid_mnd: 60,
  konto: "1240",
  avskrivningskonto: null,
  skatt: "c",
  skatt_kostpris: null,
  skatt_sats: null,
  tidligere_til: null,
  tidligere_avskrevet: 0,
  skatt_inngaende: null,
  avgang_dato: null,
  avgang_type: null,
  avgang_vederlag: null,
  ...x,
});
let n = 0;
const h = (x: Partial<Hendelse>): Hendelse => ({
  id: `h${++n}`,
  anleggsmiddel_id: "a",
  type: "avskrivning",
  dato: "2026-01-31",
  maaned: null,
  belop: 0,
  vederlag: null,
  tekst: null,
  bilag_id: "b",
  bilag: `A-2026-${n}`,
  reversert: false,
  ...x,
});
// Avskrivningene bokført for månedene (ÅÅÅÅ-MM) med beløpet.
const bokfort = (fra: number, til: number, belop: number, aar = 2026) =>
  Array.from({ length: til - fra + 1 }, (_, i) => {
    const m = `${aar}-${String(fra + i).padStart(2, "0")}`;
    const d = new Date(Date.UTC(aar, fra + i, 0)).getUTCDate();
    return h({ type: "avskrivning", maaned: m, dato: `${m}-${d}`, belop });
  });

describe("avskrivningsplanen (uten database)", () => {
  it("lineært over levetiden, ned til restverdien, og den siste måneden tar resten", () => {
    const p = avskrivningsplan(anlegg({}), []);
    expect(p).toHaveLength(60);
    expect(p[0]).toEqual({ maaned: "2026-01", belop: 2000, bokfort: false, bilag: null, verdi: 118000 });
    expect(p.at(-1)).toMatchObject({ maaned: "2030-12", belop: 2000, verdi: 0 });
    expect(avskrivningsplan(anlegg({ restverdi: 12000 }), [])[0]!.belop).toBe(1800);
    // 100 000 over 36 måneder: øre for øre, og summen er kostprisen.
    const r = avskrivningsplan(anlegg({ kostpris: 100000, levetid_mnd: 36 }), []);
    expect(r[0]!.belop).toBe(2777.78);
    expect(Math.round(r.reduce((s, x) => s + x.belop * 100, 0))).toBe(10000000);
    expect(r.at(-1)!.verdi).toBe(0);
    // Tomt avskrives ikke.
    expect(avskrivningsplan(anlegg({ kategori: "tomt", levetid_mnd: null, skatt: "ingen" }), [])).toEqual([]);
  });

  it("det som er bokført, og en nedskrivning gjelder framover (fra måneden etter)", () => {
    const hendelser = [...bokfort(1, 6, 2000), h({ type: "nedskrivning", dato: "2026-06-30", belop: 18000 })];
    const p = avskrivningsplan(anlegg({}), hendelser);
    expect(p.slice(0, 6).every((x) => x.bokfort && x.bilag)).toBe(true);
    expect(p[5]).toMatchObject({ maaned: "2026-06", belop: 2000, verdi: 90000 });
    // 90 000 over de 54 månedene som er igjen.
    expect(p[6]).toMatchObject({ maaned: "2026-07", belop: 1666.67, bokfort: false });
    expect(p.at(-1)).toMatchObject({ maaned: "2030-12", verdi: 0 });
    // En reversering av nedskrivningen (den gjelder ikke) gir planen som før.
    const rev = [...bokfort(1, 6, 2000), h({ type: "nedskrivning", dato: "2026-06-30", belop: 18000, reversert: true })];
    expect(avskrivningsplan(anlegg({}), rev)[6]!.belop).toBe(2000);
  });

  it("ny levetid gjelder framover; kortere enn det som er bokført gir resten måneden etter", () => {
    const aaret = bokfort(1, 12, 2000);
    // 96 000 igjen over 24 måneder (levetid 36 fra januar 2026).
    expect(avskrivningsplan(anlegg({ levetid_mnd: 36 }), aaret)[12]).toMatchObject({ maaned: "2027-01", belop: 4000 });
    const kort = avskrivningsplan(anlegg({ levetid_mnd: 6 }), aaret);
    expect(kort).toHaveLength(13);
    expect(kort.at(-1)).toEqual({ maaned: "2027-01", belop: 96000, bokfort: false, bilag: null, verdi: 0 });
  });

  it("ført i et annet system før: fra måneden etter, med det som er igjen", () => {
    const a = anlegg({ kostpris: 60000, avskrives_fra: "2024-01-01", anskaffet: "2024-01-05", tidligere_til: "2025-12-31", tidligere_avskrevet: 24000 });
    const p = avskrivningsplan(a, []);
    expect(p[0]).toMatchObject({ maaned: "2026-01", belop: 1000, verdi: 35000 });
    expect(p).toHaveLength(36);
  });

  it("avgang: avskrives til og med avgangsmåneden; status og planen per år", () => {
    const a = anlegg({ avskrives_fra: "2026-07-01", anskaffet: "2026-07-01" });
    expect(aarsplan(a, []).map((x) => [x.aar, x.inngaende, x.avskrivning, x.utgaende])).toEqual([
      [2026, 120000, 12000, 108000],
      [2027, 108000, 24000, 84000],
      [2028, 84000, 24000, 60000],
      [2029, 60000, 24000, 36000],
      [2030, 36000, 24000, 12000],
      [2031, 12000, 12000, 0],
    ]);
    const solgt = anlegg({ avgang_dato: "2026-03-15", avgang_type: "salg", avgang_vederlag: 100000 });
    const hend = [...bokfort(1, 3, 2000), h({ type: "avgang", dato: "2026-03-15", belop: 114000, vederlag: 100000 })];
    expect(avskrivningsplan(solgt, hend)).toHaveLength(3);
    expect(status(solgt, hend, "2026-12-31")).toMatchObject({ avskrevet: 6000, verdi: 0, tilstand: "solgt", neste: null });
    expect(aarsplan(solgt, hend)).toEqual([{ aar: 2026, inngaende: 120000, avskrivning: 6000, nedskrivning: 0, avgang: 114000, utgaende: 0, bokfort: true }]);
    expect(status(anlegg({}), bokfort(1, 9, 2000), "2026-10-09")).toMatchObject({ avskrevet: 18000, verdi: 102000, bokfort_til: "2026-09", neste: { maaned: "2026-10", belop: 2000 }, tilstand: "aktiv" });
  });

  it("bilaget for salg (gevinst med mva, og tap) og utrangering", () => {
    const k = { gevinst: "3800", tap: "7800", utgaende_mva: "2700" } as any;
    const poster = (b: ReturnType<typeof avgangsbilag>) => b.posteringer.map((p) => [p.konto, p.belop]);
    expect(poster(avgangsbilag(anlegg({}), { dato: "2026-10-05", type: "salg", vederlag: 70000, mva: 17500, motkonto: "1920", verdi: 60000, tekst: null }, k))).toEqual([
      ["1920", 87500],
      ["2700", -17500],
      ["1240", -60000],
      ["3800", -10000],
    ]);
    // Med avgift: avgiften og grunnlaget (verdien og gevinsten, til sammen salgssummen) får koden.
    expect(avgangsbilag(anlegg({}), { dato: "2026-10-05", type: "salg", vederlag: 70000, mva: 17500, motkonto: "1920", verdi: 60000, tekst: null }, k).posteringer.map((p) => p.mva_kode ?? null)).toEqual([
      null,
      "3",
      "3",
      "3",
    ]);
    expect(avgangsbilag(anlegg({}), { dato: "2026-10-05", type: "salg", vederlag: 10000, mva: 1500, motkonto: "1920", verdi: 12000, tekst: null }, k).posteringer.map((p) => p.mva_kode ?? null)).toEqual([
      null,
      "31",
      "31",
      "31",
    ]);
    expect(poster(avgangsbilag(anlegg({}), { dato: "2026-10-05", type: "salg", vederlag: 50000, mva: 0, motkonto: "1500", verdi: 60000, tekst: null }, k))).toEqual([
      ["1500", 50000],
      ["1240", -60000],
      ["7800", 10000],
    ]);
    const u = avgangsbilag(anlegg({}), { dato: "2026-10-05", type: "utrangering", vederlag: 0, mva: 0, motkonto: "1920", verdi: 5000, tekst: "Kondemnert" }, k);
    expect(poster(u)).toEqual([
      ["1240", -5000],
      ["7800", 5000],
    ]);
    expect(u.hendelser).toEqual([{ anleggsmiddel_id: "a", type: "avgang", belop: 5000, vederlag: 0, avgang_type: "utrangering", tekst: "Kondemnert" }]);
  });
});

describe("saldoavskrivningene (uten database)", () => {
  const oppsett = { saldo_fra_aar: 2026, saldo_inngaende: { a: 10000, d: 200000 } };
  const liste = [
    anlegg({ id: "bil", nummer: 1, navn: "Personbil", kategori: "personbil", skatt: "d", anskaffet: "2026-03-10", kostpris: 400000 }),
    anlegg({ id: "pc", nummer: 2, navn: "PC-er", kategori: "kontormaskiner", skatt: "a", anskaffet: "2026-05-01", kostpris: 40000, levetid_mnd: 36 }),
    anlegg({ id: "gw", nummer: 3, navn: "Goodwill Kafé", kategori: "goodwill", skatt: "b", anskaffet: "2026-01-15", kostpris: 1000000 }),
    // I inngående saldo for gruppe d, solgt i 2026.
    anlegg({ id: "maskin", nummer: 4, navn: "Maskin", kategori: "maskiner", skatt: "d", anskaffet: "2022-04-01", avskrives_fra: "2022-04-01", kostpris: 90000, avgang_dato: "2026-06-10", avgang_type: "salg", avgang_vederlag: 50000 }),
    anlegg({ id: "bygg", nummer: 5, navn: "Lagerbygg", kategori: "bygning", skatt: "h", anskaffet: "2026-02-01", kostpris: 2000000, levetid_mnd: 300 }),
    anlegg({ id: "tomt", nummer: 6, navn: "Tomt", kategori: "tomt", skatt: "ingen", anskaffet: "2026-02-01", kostpris: 500000, levetid_mnd: null }),
    anlegg({ id: "lisens", nummer: 7, navn: "Lisens", kategori: "immateriell", skatt: "lineaer", anskaffet: "2026-01-01", kostpris: 36000, levetid_mnd: 36 }),
  ];
  const rad = (s: ReturnType<typeof saldoskjema>, navn: string) => {
    const r = s.rader.find((x) => x.navn.includes(navn))!;
    return [r.inngaende, r.tilgang, r.vederlag, r.grunnlag, r.sats, r.avskrivning, r.utgaende];
  };

  it("det første året: samlesaldo med tilgang og vederlag, egen saldo, lineært og tomt", () => {
    const s = saldoskjema(2026, liste, oppsett);
    expect(s.fra_aar).toBe(2026);
    expect(rad(s, "Gruppe a")).toEqual([10000, 40000, 0, 50000, 30, 15000, 35000]);
    expect(rad(s, "Gruppe d")).toEqual([200000, 400000, 50000, 550000, 20, 110000, 440000]);
    expect(s.rader.find((x) => x.gruppe === "c")).toBeUndefined();
    expect(rad(s, "Goodwill")).toEqual([0, 1000000, 0, 1000000, 20, 200000, 800000]);
    expect(rad(s, "Lagerbygg")).toEqual([0, 2000000, 0, 2000000, 4, 80000, 1920000]);
    expect(rad(s, "Tomt")).toEqual([0, 500000, 0, 500000, null, 0, 500000]);
    expect(rad(s, "Lisens")).toEqual([0, 36000, 0, 36000, null, 12000, 24000]);
    expect(s.sum).toEqual({ avskrivning: 417000, inntekt: 0, gevinst_tap: 0 });
    expect(s.rader.find((x) => x.gruppe === "d")!.merknad).toBe("Tilgang: Personbil (nr. 1). Solgt eller utrangert: Maskin (nr. 4).");
  });

  it("året etter, lav saldo, lavere sats og negativ saldo", () => {
    const s = saldoskjema(2027, liste, oppsett, { "2027:d": 15 });
    expect(rad(s, "Gruppe a")).toEqual([35000, 0, 0, 35000, 30, 10500, 24500]);
    expect(rad(s, "Gruppe d")).toEqual([440000, 0, 0, 440000, 15, 66000, 374000]);
    expect(rad(s, "Lisens")[5]).toBe(12000);
    // Under 15 000 kr: alt fradragsføres.
    const lav = saldoskjema(2026, [], { saldo_fra_aar: 2026, saldo_inngaende: { a: 12000 } });
    expect(rad(lav, "Gruppe a")).toEqual([12000, 0, 0, 12000, 30, 12000, 0]);
    // Negativ saldo: 20 % inntektsføres (alt under 15 000 kr).
    const solgt = [anlegg({ id: "m", navn: "Maskin", skatt: "d", anskaffet: "2020-01-01", avskrives_fra: "2020-01-01", avgang_dato: "2026-05-01", avgang_type: "salg", avgang_vederlag: 60000 })];
    expect(rad(saldoskjema(2026, solgt, { saldo_fra_aar: 2026, saldo_inngaende: { d: 10000 } }), "Gruppe d")).toEqual([10000, 0, 60000, -50000, 20, -10000, -40000]);
    expect(rad(saldoskjema(2026, solgt, { saldo_fra_aar: 2026, saldo_inngaende: { d: 52000 } }), "Gruppe d")).toEqual([52000, 0, 60000, -8000, 20, -8000, 0]);
  });

  it("goodwill selges: gevinsten til gevinst- og tapskontoen, 20 % inntektsføres", () => {
    const solgt = liste.map((a) => (a.id === "gw" ? { ...a, avgang_dato: "2027-08-01", avgang_type: "salg" as const, avgang_vederlag: 900000 } : a));
    const s = saldoskjema(2027, solgt, oppsett);
    const gw = s.rader.find((x) => x.anleggsmiddel_id === "gw")!;
    expect([gw.inngaende, gw.grunnlag, gw.avskrivning, gw.gevinst_tap, gw.utgaende]).toEqual([800000, 800000, 0, 100000, 0]);
    expect(rad(s, "Gevinst- og tapskonto")).toEqual([0, 100000, 0, 100000, 20, -20000, 80000]);
    expect(s.sum.inntekt).toBe(20000);
    // Året etter: 20 % av 80 000.
    expect(rad(saldoskjema(2028, solgt, oppsett), "Gevinst- og tapskonto")).toEqual([80000, 0, 0, 80000, 20, -16000, 64000]);
    expect(saldoskjema(2028, solgt, oppsett).rader.find((x) => x.anleggsmiddel_id === "gw")).toBeUndefined();
  });

  it("det første året uten oppsett, og driftsmidler med egen saldo fra et annet system", () => {
    expect(saldoskjema(2026, [liste[0]!], { saldo_fra_aar: null, saldo_inngaende: {} }).fra_aar).toBe(2026);
    const gammelt = anlegg({ id: "g", navn: "Gammelt bygg", kategori: "bygning", skatt: "h", anskaffet: "2010-01-01", avskrives_fra: "2010-01-01", levetid_mnd: 600, tidligere_til: "2025-12-31", tidligere_avskrevet: 400000, skatt_sats: 10 });
    const s = saldoskjema(2026, [gammelt], { saldo_fra_aar: null, saldo_inngaende: {} });
    expect(s.fra_aar).toBe(2026);
    expect(s.rader[0]!.merknad).toBe("Inngående saldo mangler: legg den inn på anleggsmiddelet.");
    expect(rad(saldoskjema(2026, [{ ...gammelt, skatt_inngaende: 500000 }], { saldo_fra_aar: null, saldo_inngaende: {} }), "Gammelt bygg")).toEqual([500000, 0, 0, 500000, 10, 50000, 450000]);
  });
});

describe.skipIf(!process.env.DATABASE_URL)("regnskapsmodulen: anleggsmidlene i appen", () => {
  const app = lagApi();
  const eier = "Bearer test:uid-regn-eier:regn-eier@server.test:mfa";
  const regnskap = "Bearer test:uid-regn-regn:regn-regn@server.test:mfa";
  const fakturerer = "Bearer test:uid-regn-fakt:regn-fakt@server.test:mfa";
  const admin = "Bearer test:uid-regn-admin:regn-admin@server.test:mfa";
  let org: string;
  let inventar: string;
  let goodwill: string;
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

  beforeAll(async () => {
    const { config } = await import("../src/config.js");
    config.adminEposter.push("regn-admin@server.test");
    org = (await kall("POST", "/api/organisasjoner", { navn: "Regnskap Test AS", orgnr: "915000320" })).data.id;
    for (const [epost, rolle, hvem] of [
      ["regn-regn@server.test", "regnskap", regnskap],
      ["regn-fakt@server.test", "fakturerer", fakturerer],
    ] as const) {
      const inv = await kall("POST", `/api/org/${org}/invitasjoner`, { epost, rolle });
      expect((await kall("POST", "/api/invitasjoner/aksepter", { token: inv.data.lenke.split("/").pop() }, hvem)).status).toBe(200);
    }
  });

  it("oppsettet: kontoene, kategoriene og saldogruppene", async () => {
    const o = (await kall("GET", sti("/oppsett"))).data;
    expect(o.kontoer.find((k: any) => k.rolle === "nedskrivning")).toEqual({ rolle: "nedskrivning", navn: "Nedskrivning av varige driftsmidler og immaterielle eiendeler", standard: "6050", konto: "6050", endret: false });
    expect(o.kategorier.find((k: any) => k.kode === "goodwill")).toMatchObject({ konto: "1080", avskrivningskonto: "6020", skatt: "b" });
    expect(o.saldogrupper.map((g: any) => `${g.gruppe}:${g.sats}`).join(" ")).toBe("a:30 b:20 c:24 d:20 e:14 f:12 g:5 h:4 i:2 j:10");
    expect((await kall("PUT", sti("/oppsett"), { kontoer: { nedskrivning: "60" } })).data.error).toBe("Kontonummeret må ha 4–6 siffer");
    const ny = (await kall("PUT", sti("/oppsett"), { kontoer: { gevinst: "3810", tap: "7800" }, saldo_fra_aar: 2026, saldo_inngaende: { d: 200000 } }, regnskap)).data;
    expect(ny.kontoer.filter((k: any) => k.endret).map((k: any) => [k.rolle, k.konto])).toEqual([["gevinst", "3810"]]);
    expect(ny).toMatchObject({ saldo_fra_aar: 2026, saldo_inngaende: { d: 200000 } });
    expect((await kall("PUT", sti("/oppsett"), { kontoer: { gevinst: null } })).data.kontoer.find((k: any) => k.rolle === "gevinst").konto).toBe("3800");
  });

  it("nytt anleggsmiddel med anskaffelsen bokført (inngående mva), og kontrollene", async () => {
    const ok = { navn: "Kontorinventar", kategori: "inventar", anskaffet: "2026-01-15", kostpris: 120000, levetid_mnd: 60, anskaffelse: { motkonto: "2400", mva: 30000 } };
    expect((await kall("POST", sti("/anleggsmidler"), { ...ok, levetid_mnd: undefined })).data.error).toBe("Skriv levetiden");
    expect((await kall("POST", sti("/anleggsmidler"), { ...ok, restverdi: 120000 })).data.error).toBe("Restverdien må være lavere enn kostprisen");
    expect((await kall("POST", sti("/anleggsmidler"), { ...ok, avskrives_fra: "2025-12" })).data.error).toBe("Avskrivningen kan ikke begynne før anleggsmiddelet er anskaffet");
    expect((await kall("POST", sti("/anleggsmidler"), { ...ok, anskaffet: "2099-01-01" })).data.error).toBe("Anskaffelsesdatoen kan ikke være fram i tid");
    expect((await kall("POST", sti("/anleggsmidler"), { ...ok, tidligere_til: "2026-03", tidligere_avskrevet: 4000 })).data.error).toBe(
      "Anskaffelsen av et anleggsmiddel som er ført i et annet system, bokføres ikke her",
    );
    const r = await kall("POST", sti("/anleggsmidler"), ok);
    expect(r.status, JSON.stringify(r.data)).toBe(201);
    inventar = r.data.anleggsmiddel.id;
    expect(r.data.anleggsmiddel).toMatchObject({ nummer: 1, konto: "1250", skatt: "d", avskrives_fra: "2026-01-01", verdi: 120000, tilstand: "aktiv", neste: { maaned: "2026-01", belop: 2000 } });
    expect(r.data.hendelser).toMatchObject([{ type: "anskaffelse", belop: 120000, bilag: "A-2026-1" }]);
    expect(r.data.plan).toHaveLength(60);
    expect(r.data.aar[0]).toMatchObject({ aar: 2026, inngaende: 120000, avskrivning: 24000, utgaende: 96000 });
    const b = await rapport("regnskap.avskrivninger", "fra=2026-01-01&til=2026-01-31");
    expect(b.rader).toEqual([expect.objectContaining({ dato: "2026-01-15", bilag: "A-2026-1", hva: "Anskaffelse", anskaffelse: 120000 })]);
    // Goodwill: gruppe b uansett, avskrives over fem år.
    const g = await kall("POST", sti("/anleggsmidler"), { navn: "Goodwill Kafé", kategori: "goodwill", anskaffet: "2026-03-01", kostpris: 600000, levetid_mnd: 60, skatt: "d" }, regnskap);
    expect(g.status, JSON.stringify(g.data)).toBe(201);
    goodwill = g.data.anleggsmiddel.id;
    expect(g.data.anleggsmiddel).toMatchObject({ nummer: 2, konto: "1080", skatt: "b", neste: { maaned: "2026-03", belop: 10000 } });
  });

  it("månedsavslutningen: avskrivningene som mangler, et bilag per måned", async () => {
    const f = (await kall("GET", sti("/avskrivninger?til=2026-09"))).data;
    expect(f.maaneder.map((m: any) => [m.maaned, m.sum])).toEqual([
      ["2026-01", 2000],
      ["2026-02", 2000],
      ["2026-03", 12000],
      ["2026-04", 12000],
      ["2026-05", 12000],
      ["2026-06", 12000],
      ["2026-07", 12000],
      ["2026-08", 12000],
      ["2026-09", 12000],
    ]);
    expect(f.maaneder[2].linjer.map((l: any) => [l.navn, l.belop])).toEqual([
      ["Kontorinventar", 2000],
      ["Goodwill Kafé", 10000],
    ]);
    expect((await kall("POST", sti("/avskrivninger"), { til: "2099-01" })).data.error).toBe("Avskrivningene kan ikke bokføres for en måned fram i tid");
    const r = await kall("POST", sti("/avskrivninger"), { til: "2026-09" });
    expect(r.status, JSON.stringify(r.data)).toBe(201);
    expect(r.data.bilag.map((b: any) => [b.bilagsnummer, b.dato, b.tekst, b.sum])).toEqual([
      ["A-2026-2", "2026-01-31", "Avskrivninger januar 2026", 2000],
      ["A-2026-3", "2026-02-28", "Avskrivninger februar 2026", 2000],
      ["A-2026-4", "2026-03-31", "Avskrivninger mars 2026", 12000],
      ["A-2026-5", "2026-04-30", "Avskrivninger april 2026", 12000],
      ["A-2026-6", "2026-05-31", "Avskrivninger mai 2026", 12000],
      ["A-2026-7", "2026-06-30", "Avskrivninger juni 2026", 12000],
      ["A-2026-8", "2026-07-31", "Avskrivninger juli 2026", 12000],
      ["A-2026-9", "2026-08-31", "Avskrivninger august 2026", 12000],
      ["A-2026-10", "2026-09-30", "Avskrivninger september 2026", 12000],
    ]);
    expect((await kall("GET", sti("/avskrivninger?til=2026-09"))).data.maaneder).toEqual([]);
    expect((await kall("POST", sti("/avskrivninger"), { til: "2026-09" })).data.bilag).toEqual([]);
    const l = (await kall("GET", sti("/anleggsmidler"))).data.anleggsmidler;
    expect(l.map((a: any) => [a.navn, a.avskrevet, a.verdi, a.bokfort_til])).toEqual([
      ["Kontorinventar", 18000, 102000, "2026-09"],
      ["Goodwill Kafé", 70000, 530000, "2026-09"],
    ]);
  });

  it("nedskrivning gjelder framover; goodwill reverseres ikke; reverseringen har en grense", async () => {
    expect((await kall("POST", sti(`/anleggsmidler/${goodwill}/nedskrivning`), { dato: "2026-09-30", belop: 530000.01 })).data.error).toBe(
      "Nedskrivningen kan være høyst den bokførte verdien (530 000 kr)",
    );
    const n = await kall("POST", sti(`/anleggsmidler/${goodwill}/nedskrivning`), { dato: "2026-09-30", belop: 100000, tekst: "Lavere omsetning" });
    expect(n.status, JSON.stringify(n.data)).toBe(201);
    expect(n.data.bilag).toMatchObject({ bilagsnummer: "A-2026-11", tekst: "Nedskrivning: Goodwill Kafé (nr. 2)" });
    // 430 000 over de 53 månedene som er igjen.
    expect(n.data.anleggsmiddel).toMatchObject({ verdi: 430000, nedskrevet: 100000, neste: { maaned: "2026-10", belop: 8113.21 } });
    expect(n.data.kan_reversere).toBe(false);
    expect((await kall("POST", sti(`/anleggsmidler/${goodwill}/nedskrivning`), { dato: "2026-09-30", belop: 1000, reverser: true })).data.error).toBe(
      "Nedskrivning av goodwill kan ikke reverseres",
    );
    // Inventaret: nedskrevet 10 000 og reversert 5 000 (ikke mer enn nedskrevet).
    expect((await kall("POST", sti(`/anleggsmidler/${inventar}/nedskrivning`), { dato: "2026-09-30", belop: 10000 })).status).toBe(201);
    expect((await kall("POST", sti(`/anleggsmidler/${inventar}/nedskrivning`), { dato: "2026-09-30", belop: 12000, reverser: true })).data.error).toBe(
      "Reverseringen kan være høyst 10 000 kr (nedskrivningene, og ikke mer enn verdien etter planen uten nedskrivning)",
    );
    const r = await kall("POST", sti(`/anleggsmidler/${inventar}/nedskrivning`), { dato: "2026-09-30", belop: 5000, reverser: true });
    expect(r.status, JSON.stringify(r.data)).toBe(201);
    expect(r.data.anleggsmiddel).toMatchObject({ verdi: 97000, nedskrevet: 5000, neste: { maaned: "2026-10", belop: 1901.96 } });
    expect(r.data.bilag.tekst).toBe("Reversert nedskrivning: Kontorinventar (nr. 1)");
  });

  it("endringer som stoppes når noe er bokført, og sletting", async () => {
    expect((await kall("PATCH", sti(`/anleggsmidler/${inventar}`), { kostpris: 130000 })).data.error).toBe(
      "Anleggsmiddelet har bokførte bilag: kategorien, kostprisen, datoene og kontoen kan ikke endres. Reverser bilagene først, eller bruk nedskrivning.",
    );
    const p = await kall("PATCH", sti(`/anleggsmidler/${inventar}`), { navn: "Kontormøbler", restverdi: 7000 });
    expect(p.status, JSON.stringify(p.data)).toBe(200);
    // (97 000 − 7 000) over 51 måneder.
    expect(p.data.anleggsmiddel).toMatchObject({ navn: "Kontormøbler", restverdi: 7000, neste: { belop: 1764.71 } });
    expect((await kall("PATCH", sti(`/anleggsmidler/${inventar}`), { restverdi: 0 })).status).toBe(200);
    expect((await kall("DELETE", sti(`/anleggsmidler/${inventar}`))).data.error).toBe(
      "Anleggsmiddelet har bokførte bilag. Reverser dem først, eller registrer salg eller utrangering.",
    );
    const t = await kall("POST", sti("/anleggsmidler"), { navn: "Tomt", kategori: "tomt", anskaffet: "2026-02-01", kostpris: 500000 });
    expect(t.status, JSON.stringify(t.data)).toBe(201);
    expect(t.data.anleggsmiddel).toMatchObject({ levetid_mnd: null, skatt: "ingen", konto: "1150", neste: null });
    expect((await kall("DELETE", sti(`/anleggsmidler/${t.data.anleggsmiddel.id}`))).status).toBe(204);
  });

  it("salg: avskrivningen for måneden bokføres først, så salget med gevinsten; reverseres det siste først", async () => {
    expect((await kall("POST", sti(`/anleggsmidler/${inventar}/avgang`), { dato: "2026-10-05", type: "salg" })).data.error).toBe("Skriv salgssummen (uten mva)");
    const s = await kall("POST", sti(`/anleggsmidler/${inventar}/avgang`), { dato: "2026-10-05", type: "salg", vederlag: 100000, mva: 25000, motkonto: "1500" });
    expect(s.status, JSON.stringify(s.data)).toBe(201);
    expect(s.data.bilag.map((b: any) => [b.bilagsnummer, b.tekst])).toEqual([
      ["A-2026-14", "Avskrivninger oktober 2026"],
      ["A-2026-15", "Salg: Kontormøbler (nr. 1)"],
    ]);
    expect(s.data.anleggsmiddel).toMatchObject({ avgang_dato: "2026-10-05", avgang_type: "salg", verdi: 0, tilstand: "solgt" });
    const r = await rapport("regnskap.avskrivninger", "fra=2026-10-01&til=2026-10-31");
    expect(r.rader.map((x: any) => [x.bilag, x.hva, x.avskrivning, x.ut, x.vederlag])).toEqual([
      ["A-2026-14", "Avskrivning oktober 2026", 1901.96, null, null],
      ["A-2026-15", "Salg", null, 95098.04, 100000],
    ]);
    // Bilaget: kundefordringen med mva, mva-en, verdien ut og gevinsten.
    const bilag = s.data.hendelser.find((h: any) => h.type === "avgang");
    expect(bilag).toMatchObject({ belop: 95098.04, vederlag: 100000 });
    // Avskrivningen for oktober kan ikke reverseres før salget.
    const okt = s.data.hendelser.find((h: any) => h.type === "avskrivning" && h.maaned === "2026-10");
    expect((await kall("POST", sti(`/bilag/${okt.bilag_id}/reverser`))).data.error).toBe("Anleggsmiddel 1 har senere bokføringer. Reverser dem først.");
    const rev = await kall("POST", sti(`/bilag/${bilag.bilag_id}/reverser`), {}, regnskap);
    expect(rev.status, JSON.stringify(rev.data)).toBe(201);
    expect(rev.data).toMatchObject({ bilagsnummer: "A-2026-16", tekst: "Reversert: Salg: Kontormøbler (nr. 1)" });
    expect((await kall("GET", sti(`/anleggsmidler/${inventar}`))).data.anleggsmiddel).toMatchObject({ avgang_dato: null, tilstand: "aktiv", verdi: 95098.04 });
    expect((await kall("POST", sti(`/bilag/${okt.bilag_id}/reverser`))).status).toBe(201);
    expect((await kall("GET", sti(`/anleggsmidler/${inventar}`))).data.anleggsmiddel).toMatchObject({ bokfort_til: "2026-09", verdi: 97000 });
  });

  it("rapportene: anleggsregister, avskrivningsplan og saldoskjema; satsen kan settes lavere", async () => {
    const reg = await rapport("regnskap.anleggsregister", "aar=2026");
    expect(reg.rader.map((x: any) => [x.navn, x.kostpris, x.avskrevet, x.nedskrevet, x.verdi, x.aarets, x.levetid, x.saldogruppe, x.status])).toEqual([
      ["Kontormøbler", 120000, 18000, 5000, 97000, 18000, "5 år", "d", "I bruk"],
      ["Goodwill Kafé", 600000, 70000, 100000, 430000, 70000, "5 år", "b", "I bruk"],
    ]);
    expect(reg.merknad).toContain("Avskrivningene er ikke bokført for alle månedene til og med");
    const plan = await rapport("regnskap.avskrivningsplan", "aar=2027");
    expect(plan.rader.filter((x: any) => x.navn === "Goodwill Kafé").map((x: any) => [x.aar, x.avskrivning, x.grunnlag])[0]).toEqual(["2027", 97358.52, "Plan"]);
    expect(plan.merknad).toMatch(/^Avskrivningene per år: 2027: /);
    const saldo = await rapport("regnskap.saldoskjema", "aar=2026");
    expect(saldo.rader.map((x: any) => [x.navn, x.inngaende, x.tilgang, x.avskrivning, x.utgaende])).toEqual([
      ["Gruppe d: Personbiler, traktorer, maskiner, redskap, instrumenter, inventar o.l.", 200000, 120000, 64000, 256000],
      ["Gruppe b: Goodwill Kafé (nr. 2)", 0, 600000, 120000, 480000],
    ]);
    expect(saldo.rader[1]).toMatchObject({ regnskap: 430000, forskjell: -50000 });
    const satser = await kall("PUT", sti("/saldo/2026"), { satser: { d: 25 } });
    expect(satser.data.error).toBe("Satsen for gruppe d kan være høyst 20 %");
    const ned = (await kall("PUT", sti("/saldo/2026"), { satser: { d: 10 } })).data;
    expect(ned.rader[0]).toMatchObject({ sats: 10, avskrivning: 32000, utgaende: 288000 });
    expect(ned.satser.find((s: any) => s.gruppe === "d")).toEqual({ gruppe: "d", navn: "Personbiler, traktorer, maskiner, redskap, instrumenter, inventar o.l.", maks: 20, sats: 10 });
    expect((await kall("PUT", sti("/saldo/2026"), { satser: { d: null } })).data.rader[0].sats).toBe(20);
  });

  it("tilgangen: regnskap fører, fakturerer ikke; funksjonen kan slås av", async () => {
    expect((await kall("GET", sti("/anleggsmidler"), undefined, regnskap)).status).toBe(200);
    expect((await kall("GET", sti("/anleggsmidler"), undefined, fakturerer)).status).toBe(403);
    expect((await kall("POST", sti("/avskrivninger"), { til: "2026-09" }, fakturerer)).status).toBe(403);
    expect((await kall("GET", `/api/org/${org}/rapportmodul/regnskap.anleggsregister?aar=2026`, undefined, fakturerer)).status).toBe(403);
    expect((await kall("PUT", `/api/admin/organisasjoner/${org}/funksjoner`, { regnskap: false }, admin)).status).toBe(200);
    expect((await kall("GET", sti("/anleggsmidler"))).data.error).toBe("Regnskap er ikke slått på for organisasjonen");
    expect((await kall("PUT", `/api/admin/organisasjoner/${org}/funksjoner`, { regnskap: true }, admin)).status).toBe(200);
  });
});
