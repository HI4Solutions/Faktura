// Fakturaene og innbetalingene i regnskapet (0089_regnskap_salg.sql, salgBokforing.ts): bilaget for
// en faktura per mva-sats med mva-kodene (og uten mva-registrering), en kreditnota, en innbetaling med
// purregebyret, en refusjon, at det bokføres av seg selv (når regnskapet vises og av workeren), at en
// slettet faktura og en betaling som tas bort får bilaget reversert, at bilagene ikke reverseres i
// regnskapet, startdatoen og kundefordringene ved den, og at kundefordringen stemmer med det som er
// ubetalt.
import { beforeAll, describe, expect, it } from "vitest";
import { lagApi } from "../src/api.js";
import { config } from "../src/config.js";
import { regnskapskontoer } from "../src/anlegg.js";
import { en, somSystem } from "../src/db.js";
import { betalingsbilag, bokforSalgForAlle, fakturabilag, gebyrAvBetaling, gebyrPerBetaling, satsFor } from "../src/salgBokforing.js";
import { settLokalOppgavekjorer } from "../src/tjenester.js";

const K = regnskapskontoer({ kontoer: {} });

describe("bilagene for salget (uten database)", () => {
  it("en faktura per mva-sats med mva-kodene, og uten mva-registrering", () => {
    const f = {
      fakturanummer: 12,
      type: "faktura" as const,
      sum_inkl_mva: 1250 + 115 + 112 + 300 + 111.11,
      kunde: "Kunde AS",
      for_nummer: null,
      mva_registrert: true,
      linjer: [
        { mva_sats: 25, eks: 1000, mva: 250 },
        { mva_sats: 15, eks: 100, mva: 15 },
        { mva_sats: 12, eks: 100, mva: 12 },
        { mva_sats: 11.11, eks: 100, mva: 11.11 },
        { mva_sats: 0, eks: 300, mva: 0 },
      ],
    };
    const b = fakturabilag(f, K, "unntatt");
    expect(b.tekst).toBe("Faktura 12 Kunde AS");
    expect(b.posteringer.map((p) => [p.konto, p.belop, p.mva_kode])).toEqual([
      ["1500", 1888.11, null],
      ["3000", -1000, "3"],
      ["2700", -250, "3"],
      ["3030", -100, "31"],
      ["2701", -15, "31"],
      ["3050", -100, "33"],
      ["2703", -12, "33"],
      ["3035", -100, "32"],
      ["2702", -11.11, "32"],
      ["3200", -300, "6"],
    ]);
    expect(b.posteringer.reduce((s, p) => s + p.belop, 0)).toBeCloseTo(0, 6);
    // Fritatt: 3100 og kode 5.
    expect(fakturabilag({ ...f, linjer: [{ mva_sats: 0, eks: 300, mva: 0 }], sum_inkl_mva: 300 }, K, "fritatt").posteringer.map((p) => [p.konto, p.mva_kode])).toEqual([
      ["1500", null],
      ["3100", "5"],
    ]);
    // Uten mva-registrering: alt utenfor merverdiavgiftsloven, uten kode.
    expect(fakturabilag({ ...f, mva_registrert: false, linjer: [{ mva_sats: 0, eks: 300, mva: 0 }], sum_inkl_mva: 300 }, K, "unntatt").posteringer).toEqual([
      { konto: "1500", belop: 300, tekst: "Kunde AS, faktura 12", mva_kode: null },
      { konto: "3200", belop: -300, tekst: "Salg", mva_kode: null },
    ]);
  });

  it("en kreditnota snur alt, og sier hvilken faktura den krediterer", () => {
    const b = fakturabilag(
      { fakturanummer: 13, type: "kreditnota", sum_inkl_mva: -625, kunde: "Kunde AS", for_nummer: 12, mva_registrert: true, linjer: [{ mva_sats: 25, eks: -500, mva: -125 }] },
      K,
      "unntatt",
    );
    expect(b.tekst).toBe("Kreditnota 13 Kunde AS (faktura 12)");
    expect(b.posteringer.map((p) => [p.konto, p.belop])).toEqual([
      ["1500", -625],
      ["3000", 500],
      ["2700", 125],
    ]);
  });

  it("innbetaling med purregebyr, refusjon og satsene", () => {
    expect(betalingsbilag({ type: "betaling", belop: 1285, fakturanummer: 12, kunde: "Kunde AS" }, 35, K).posteringer.map((p) => [p.konto, p.belop])).toEqual([
      ["1920", 1285],
      ["1500", -1250],
      ["3900", -35],
    ]);
    expect(betalingsbilag({ type: "refusjon", belop: -200, fakturanummer: 12, kunde: "Kunde AS" }, 0, K)).toEqual({
      tekst: "Refusjon faktura 12 Kunde AS",
      posteringer: [
        { konto: "1920", belop: -200, tekst: "Betalt tilbake", mva_kode: null },
        { konto: "1500", belop: 200, tekst: "Kunde AS, faktura 12", mva_kode: null },
      ],
    });
    // Gebyret: det som er betalt utover fakturaen, høyst gebyrene som ikke er bokført.
    expect(gebyrAvBetaling({ belop: 1285 }, 0, 1250, 35, 0)).toBe(35);
    expect(gebyrAvBetaling({ belop: 1300 }, 0, 1250, 35, 0)).toBe(35); // 15 kr står som tilgode
    expect(gebyrAvBetaling({ belop: 600 }, 700, 1250, 35, 0)).toBe(35);
    expect(gebyrAvBetaling({ belop: 600 }, 0, 1250, 35, 0)).toBe(0);
    expect(gebyrAvBetaling({ belop: 50 }, 1250, 1250, 35, 35)).toBe(0);
    expect(gebyrAvBetaling({ belop: -100 }, 1300, 1250, 35, 0)).toBe(0);
    expect([25, 15, 12, 11.11, 6, 8].map((s) => satsFor(s).kode)).toEqual(["3", "31", "33", "32", "33", "33"]);
  });

  it("gebyret per innbetaling er det samme uansett når de bokføres, og en senere kreditnota endrer det ikke", () => {
    const g = {
      sum: 1100,
      gebyrer: 35,
      betalinger: [
        { id: "a", dato: "2026-09-20", belop: 600 },
        { id: "b", dato: "2026-09-25", belop: 535 },
      ],
      kreditnotaer: [{ dato: "2026-10-09", belop: -1100 }],
    };
    expect([...gebyrPerBetaling(g)]).toEqual([
      ["a", 0],
      ["b", 35],
    ]);
    // En kreditnota før betalingen: det som er betalt utover, er gebyret (resten er tilgode).
    expect([...gebyrPerBetaling({ ...g, kreditnotaer: [{ dato: "2026-09-21", belop: -600 }] })]).toEqual([
      ["a", 0],
      ["b", 35],
    ]);
    expect([...gebyrPerBetaling({ ...g, kreditnotaer: [{ dato: "2026-09-01", belop: -600 }] })]).toEqual([
      ["a", 35],
      ["b", 0],
    ]);
  });
});

describe.skipIf(!process.env.DATABASE_URL)("fakturaene og innbetalingene i regnskapet", () => {
  const app = lagApi();
  const eier = "Bearer test:uid-salg-eier:salg-eier@server.test:mfa";
  let org: string;
  let kunde: string;
  let f1: string;

  const kall = async (m: string, sti: string, k?: unknown) => {
    const r = await app.request(sti, { method: m, headers: { authorization: eier, "content-type": "application/json" }, body: k === undefined ? undefined : JSON.stringify(k) });
    return { status: r.status, data: (r.headers.get("content-type") ?? "").includes("json") ? ((await r.json()) as any) : await r.text() };
  };
  const faktura = async (linjer: unknown[], datoer: Record<string, string> = {}) => {
    const f = await kall("POST", `/api/org/${org}/fakturaer`, { kunde_id: kunde, linjer, ...datoer });
    expect(f.status, JSON.stringify(f.data)).toBe(201);
    const u = await kall("POST", `/api/org/${org}/fakturaer/${f.data.id}/utsted`, { send_epost: false });
    expect(u.status, JSON.stringify(u.data)).toBe(200);
    return u.data;
  };
  const bilag = async (kilde?: string) =>
    (await kall("GET", `/api/org/${org}/regnskap/bilag?fra=2026-01-01&til=2026-12-31${kilde ? `&kilde=${kilde}` : ""}`)).data.bilag as any[];
  const saldo = async (konto: string, til = "2026-12-31") =>
    (await kall("GET", `/api/org/${org}/regnskap/saldobalanse?fra=2026-01-01&til=${til}`)).data.rader.find((r: any) => r.konto === konto)?.utgaende ?? 0;
  const poster = (b: any) => b.posteringer.map((p: any) => [p.konto, p.belop, p.mva_kode ?? null]);

  beforeAll(async () => {
    settLokalOppgavekjorer(async () => {});
    org = (await kall("POST", "/api/organisasjoner", { navn: "Salg i regnskapet AS" })).data.id;
    expect((await kall("PATCH", `/api/org/${org}`, { kontonr: "86011117947", mva_registrert: true, purregebyr: 35 })).status).toBe(200);
    kunde = (await kall("POST", `/api/org/${org}/kunder`, { navn: "Pasient Hansen", epost: "hansen@test.no" })).data.id;
  });

  it("en ny organisasjon bokfører alt: fakturaen per sats når regnskapet vises", async () => {
    const o = (await kall("GET", `/api/org/${org}/regnskap/oppsett`)).data;
    expect(o).toMatchObject({ salg_fra: null, uten_mva: "unntatt", kundefordringer_ved_start: null });
    const f = await faktura(
      [
        { beskrivelse: "Konsultasjon", antall: 1, enhetspris: 600, mva_sats: 0 },
        { beskrivelse: "Hudkrem", antall: 2, enhetspris: 200, mva_sats: 25 },
      ],
      { fakturadato: "2026-09-01", forfallsdato: "2026-09-15" },
    );
    f1 = f.id;
    const b = (await bilag("faktura"))!;
    expect(b.map((x) => [x.bilagsnummer, x.dato, x.tekst, x.lenke])).toEqual([["F-2026-1", "2026-09-01", `Faktura ${f.fakturanummer} Pasient Hansen`, `/fakturaer/${f.id}`]]);
    expect(poster(b[0])).toEqual([
      ["1500", 1100, null],
      ["3000", -400, "3"],
      ["2700", -100, "3"],
      ["3200", -600, "6"],
    ]);
    // Bare én gang.
    expect((await bilag("faktura")).length).toBe(1);
    expect(await saldo("1500")).toBe(1100);
    // Bilagsjournalen har mva-kodene.
    const j = (await kall("GET", `/api/org/${org}/rapportmodul/regnskap.bilagsjournal?fra=2026-09-01&til=2026-09-30`)).data;
    expect(j.rader.map((r: any) => [r.bilag, r.kilde, r.konto, r.mva_kode, r.debet, r.kredit])).toEqual([
      ["F-2026-1", "Faktura", "1500", null, 1100, null],
      ["F-2026-1", "Faktura", "3000", "3", null, 400],
      ["F-2026-1", "Faktura", "2700", "3", null, 100],
      ["F-2026-1", "Faktura", "3200", "6", null, 600],
    ]);
  });

  it("purret med gebyr og betalt med gebyret: banken mot kundefordringen og purregebyret", async () => {
    const p = await kall("POST", `/api/org/${org}/fakturaer/${f1}/purring`, { type: "paaminnelse" });
    expect(p.status, JSON.stringify(p.data)).toBe(201);
    expect(Number(p.data.gebyr)).toBe(35);
    expect((await kall("POST", `/api/org/${org}/fakturaer/${f1}/betalinger`, { belop: 600, dato: "2026-09-20" })).status).toBe(200);
    expect((await kall("POST", `/api/org/${org}/fakturaer/${f1}/betalinger`, { belop: 535, dato: "2026-09-25" })).status).toBe(200);
    const b = await bilag("innbetaling");
    expect(b.map((x) => [x.bilagsnummer, x.dato, x.lenke])).toEqual([
      ["B-2026-1", "2026-09-20", `/fakturaer/${f1}`],
      ["B-2026-2", "2026-09-25", `/fakturaer/${f1}`],
    ]);
    expect(poster(b[0])).toEqual([
      ["1920", 600, null],
      ["1500", -600, null],
    ]);
    expect(poster(b[1])).toEqual([
      ["1920", 535, null],
      ["1500", -500, null],
      ["3900", -35, null],
    ]);
    expect(await saldo("1500")).toBe(0);
    expect(await saldo("3900")).toBe(-35);
  });

  it("en kreditnota og en refusjon av det som er betalt", async () => {
    const kn = await kall("POST", `/api/org/${org}/fakturaer/${f1}/krediter`, { send_epost: false });
    expect(kn.status, JSON.stringify(kn.data)).toBe(201);
    expect((await kall("POST", `/api/org/${org}/fakturaer/${f1}/refusjoner`, { belop: 1100, dato: kn.data.fakturadato })).status).toBe(200);
    const k = (await bilag("faktura")).find((x) => x.tekst.startsWith("Kreditnota"))!;
    expect(k.bilagsnummer).toBe("F-2026-2");
    expect(poster(k)).toEqual([
      ["1500", -1100, null],
      ["3000", 400, "3"],
      ["2700", 100, "3"],
      ["3200", 600, "6"],
    ]);
    const r = (await bilag("innbetaling")).find((x) => x.tekst.startsWith("Refusjon"))!;
    expect(poster(r)).toEqual([
      ["1920", -1100, null],
      ["1500", 1100, null],
    ]);
    // Kundefordringen er 0, og salget er borte (gebyret står).
    expect(await saldo("1500")).toBe(0);
    expect(await saldo("3000")).toBe(0);
    expect(await saldo("1920")).toBe(35);
  });

  it("workeren bokfører det som mangler; en betaling som tas bort og en slettet faktura reverseres", async () => {
    const f = await faktura([{ beskrivelse: "Time", antall: 1, enhetspris: 800, mva_sats: 0 }], { fakturadato: "2026-10-01", forfallsdato: "2026-10-15" });
    expect((await kall("POST", `/api/org/${org}/fakturaer/${f.id}/betalinger`, { belop: 800, dato: "2026-10-05" })).status).toBe(200);
    expect(await bokforSalgForAlle(25, org)).toEqual({ fakturaer: 1, betalinger: 1, reversert: 0 });
    expect(await bokforSalgForAlle(25, org)).toEqual({ fakturaer: 0, betalinger: 0, reversert: 0 });
    // Bilagene reverseres ikke i regnskapet.
    const fb = (await bilag("faktura")).find((x) => x.lenke === `/fakturaer/${f.id}`)!;
    expect((await kall("POST", `/api/org/${org}/regnskap/bilag/${fb.id}/reverser`, {})).data.error).toBe(
      "En faktura rettes med en kreditnota (Fakturaer), og kreditnotaen bokføres av seg selv",
    );
    // Fakturaen slettes (med betalingen): begge bilagene reverseres.
    expect((await kall("POST", `/api/org/${org}/fakturaer/${f.id}/slett`, { grunn: "Testfaktura" })).status).toBe(200);
    expect(await bokforSalgForAlle(25, org)).toEqual({ fakturaer: 0, betalinger: 0, reversert: 2 });
    const alle = await bilag();
    expect(alle.filter((x) => x.reversert_av).map((x) => x.kilde).sort()).toEqual(["faktura", "innbetaling"]);
    expect(alle.filter((x) => x.reverserer).map((x) => x.tekst)).toEqual([
      `Reversert, fakturaen er slettet: Faktura ${f.fakturanummer} Pasient Hansen`,
      `Reversert, betalingen er tatt bort: Innbetaling faktura ${f.fakturanummer} Pasient Hansen`,
    ]);
    expect(await saldo("1500")).toBe(0);
    expect(await saldo("3200")).toBe(0);
  });

  it("startdatoen: det som er fra før, bokføres ikke (og reverseres), og kundefordringene ved den vises", async () => {
    const f = await faktura([{ beskrivelse: "Time", antall: 1, enhetspris: 500, mva_sats: 0 }], { fakturadato: "2026-10-02", forfallsdato: "2026-10-16" });
    const o = await kall("PUT", `/api/org/${org}/regnskap/oppsett`, { salg_fra: "2026-10-03", uten_mva: "fritatt" });
    expect(o.status, JSON.stringify(o.data)).toBe(200);
    // Den første fakturaen er betalt (gebyret er inntekt, ikke fordring), og den nye står åpen.
    expect(o.data).toMatchObject({ salg_fra: "2026-10-03", uten_mva: "fritatt", kundefordringer_ved_start: 500 });
    const alle = await bilag();
    expect(alle.some((x) => x.kilde === "faktura" && x.lenke === `/fakturaer/${f.id}`)).toBe(false);
    // Det som var bokført før datoen, er reversert (fakturaen og de to innbetalingene).
    expect(alle.filter((x) => x.dato < "2026-10-03" && !x.reverserer && !x.reversert_av)).toEqual([]);
    expect(alle.filter((x) => x.reverserer && x.tekst.startsWith("Reversert, fra før startdatoen for salget: ")).map((x) => x.dato)).toEqual([
      "2026-09-01",
      "2026-09-20",
      "2026-09-25",
    ]);
    // Reverseringen har mva-kodene.
    expect(poster(alle.find((x) => x.reverserer && x.dato === "2026-09-01"))).toEqual([
      ["1500", -1100, null],
      ["3000", 400, "3"],
      ["2700", 100, "3"],
      ["3200", 600, "6"],
    ]);
    // Betalt etter startdatoen: bokført (kundefordringen er med i den inngående balansen).
    expect((await kall("POST", `/api/org/${org}/fakturaer/${f.id}/betalinger`, { belop: 500, dato: "2026-10-04" })).status).toBe(200);
    expect((await bilag("innbetaling")).filter((x) => x.lenke === `/fakturaer/${f.id}` && !x.reversert_av).length).toBe(1);
    // En faktura etter datoen: fritatt (3100, kode 5).
    const g = await faktura([{ beskrivelse: "Eksport", antall: 1, enhetspris: 1000, mva_sats: 0 }], { fakturadato: "2026-10-05", forfallsdato: "2026-10-19" });
    expect(poster((await bilag("faktura")).find((x) => x.lenke === `/fakturaer/${g.id}`))).toEqual([
      ["1500", 1000, null],
      ["3100", -1000, "5"],
    ]);
    // Uten den inngående balansen (500, den nye fakturaen) er kundefordringen det som er åpent (g, 1000) minus 500.
    expect(await saldo("1500")).toBe(500);

    // Datoen flyttes tilbake: det bokføres på nytt, med gebyret på den samme innbetalingen.
    const t = await kall("PUT", `/api/org/${org}/regnskap/oppsett`, { salg_fra: "2026-09-01" });
    expect(t.data).toMatchObject({ salg_fra: "2026-09-01", uten_mva: "fritatt", kundefordringer_ved_start: 0 });
    const igjen = (await bilag()).filter((x) => !x.reverserer && !x.reversert_av);
    expect(igjen.filter((x) => x.dato < "2026-10-03").map((x) => [x.kilde, x.dato])).toEqual([
      ["faktura", "2026-09-01"],
      ["innbetaling", "2026-09-20"],
      ["innbetaling", "2026-09-25"],
      ["faktura", "2026-10-02"],
    ]);
    expect(poster(igjen.find((x) => x.dato === "2026-09-25"))).toEqual([
      ["1920", 535, null],
      ["1500", -500, null],
      ["3900", -35, null],
    ]);
    expect(await saldo("1500")).toBe(1000);
    expect(await saldo("3900")).toBe(-35);
    expect(await bokforSalgForAlle(25, org)).toEqual({ fakturaer: 0, betalinger: 0, reversert: 0 });
  });

  it("bare den som ser regnskapet, bokfører og ser bilagene", async () => {
    const fakturerer = "Bearer test:uid-salg-fakt:salg-fakt@server.test:mfa";
    const inv = await kall("POST", `/api/org/${org}/invitasjoner`, { epost: "salg-fakt@server.test", rolle: "fakturerer" });
    expect(inv.status, JSON.stringify(inv.data)).toBe(201);
    const token = inv.data.lenke.split("/").pop();
    const r = await app.request("/api/invitasjoner/aksepter", {
      method: "POST",
      headers: { authorization: fakturerer, "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    expect(r.status).toBe(200);
    const meg = (await (await app.request("/api/meg", { headers: { authorization: fakturerer } })).json()) as any;
    const n = await somSystem((db) => en<{ n: number }>(db, "select count(*)::int as n from faktura.bilag where org_id = $1", [org]));
    const sett = await (await import("../src/db.js")).somBruker(meg.bruker.id, (db) =>
      en<{ n: number }>(db, "select count(*)::int as n from faktura.bilag where org_id = $1", [org]),
    );
    expect(n!.n).toBeGreaterThan(0);
    expect(sett!.n).toBe(0);
  });

  it("workeren hopper over organisasjonene uten regnskapet, og bokfører når det slås på", async () => {
    const admin = "Bearer test:uid-salg-admin:salg-admin@server.test:mfa";
    if (!config.adminEposter.includes("salg-admin@server.test")) config.adminEposter.push("salg-admin@server.test");
    const funksjon = async (paa: boolean) => {
      const r = await app.request(`/api/admin/organisasjoner/${org}/funksjoner`, {
        method: "PUT",
        headers: { authorization: admin, "content-type": "application/json" },
        body: JSON.stringify({ regnskap: paa }),
      });
      expect(r.status).toBe(200);
    };
    await funksjon(false);
    await faktura([{ beskrivelse: "Time", antall: 1, enhetspris: 300, mva_sats: 0 }], { fakturadato: "2026-10-06", forfallsdato: "2026-10-20" });
    expect(await bokforSalgForAlle(25, org)).toEqual({ fakturaer: 0, betalinger: 0, reversert: 0 });
    await funksjon(true);
    expect(await bokforSalgForAlle(25, org)).toEqual({ fakturaer: 1, betalinger: 0, reversert: 0 });
  });
});
