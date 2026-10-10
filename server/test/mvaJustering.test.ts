// Mva-justeringen for kapitalvarer (mvaJustering.ts, 0095_mva_justering.sql): grensene, perioden,
// fradragsprosenten i året (fellesprosenten fra omsetningen, satt for året, egen per år), den årlige
// justeringen (bokført, på nytt, angret, låst år) med linjen i mva-meldingen, månedsavslutningen,
// den samlede justeringen ved salg (og at den reverseres med salget), rapporten og tilgangen.
import { beforeAll, describe, expect, it } from "vitest";
import { lagApi } from "../src/api.js";
import type { Anleggsmiddel } from "../src/anlegg.js";
import { somSystem } from "../src/db.js";
import { avsluttMaaned } from "../src/maanedsavslutning.js";
import { erKapitalvare, justering, justeringsperiode, kapitalvarefelt, prosentIAar, samletJustering } from "../src/mvaJustering.js";
import { settLokalOppgavekjorer } from "../src/tjenester.js";

const kv = (x: Partial<Anleggsmiddel>) =>
  ({ kategori: "maskiner", anskaffet: "2024-03-15", avskrives_fra: "2024-03-01", mva_inngaende: 100000, mva_fradrag: 60, mva_felles: true, mva_bruk: {}, ...x }) as Anleggsmiddel;

describe("mva-justeringen uten database", () => {
  it("grensene: 50 000 kr for løsøre og 100 000 kr for fast eiendom, ikke tomt, goodwill og personbiler", () => {
    expect([49999.99, 50000].map((m) => erKapitalvare(kv({ mva_inngaende: m })))).toEqual([false, true]);
    expect([99999, 100000].map((m) => erKapitalvare(kv({ kategori: "bygning", mva_inngaende: m })))).toEqual([false, true]);
    expect(erKapitalvare(kv({ kategori: "personbil", mva_inngaende: 80000 }))).toBe(false);
    expect(erKapitalvare(kv({ mva_inngaende: null, mva_fradrag: null }))).toBe(false);
    expect(kapitalvarefelt("maskiner", 100000, 60000)).toEqual({ mva_inngaende: 100000, mva_fradrag: 60, mva_felles: true });
    expect(kapitalvarefelt("inventar", 62500, 62500)).toEqual({ mva_inngaende: 62500, mva_fradrag: 100, mva_felles: false });
    expect(kapitalvarefelt("maskiner", 40000, 40000)).toEqual({});
    expect(kapitalvarefelt("personbil", 100000, 0)).toEqual({});
  });

  it("perioden: fem år fra anskaffelsesåret, ti år for fast eiendom fra året den ble tatt i bruk", () => {
    expect(justeringsperiode(kv({}))).toEqual({ fra: 2024, til: 2028, antall: 5 });
    expect(justeringsperiode(kv({ kategori: "bygning", anskaffet: "2024-11-01", avskrives_fra: "2025-07-01" }))).toEqual({ fra: 2025, til: 2034, antall: 10 });
  });

  it("fradragsprosenten i året: fellesprosenten, egen for året, den siste egne før, ellers ved anskaffelsen", () => {
    expect(prosentIAar(kv({}), 2025, 30)).toEqual({ prosent: 30, kilde: "felles" });
    expect(prosentIAar(kv({ mva_bruk: { "2025": 45 } }), 2025, 30)).toEqual({ prosent: 45, kilde: "egen" });
    const egen = kv({ mva_felles: false, mva_bruk: { "2025": 20 } });
    expect([2024, 2025, 2027].map((y) => prosentIAar(egen, y, 99))).toEqual([
      { prosent: 60, kilde: "anskaffelse" },
      { prosent: 20, kilde: "egen" },
      { prosent: 20, kilde: "egen" },
    ]);
  });

  it("justeringen: en femdel (tidel) av avgiften ganger endringen, bare fra ti prosentpoeng", () => {
    expect(justering(kv({}), 40)).toEqual({ endring: -20, belop: -4000 });
    expect(justering(kv({}), 70)).toEqual({ endring: 10, belop: 2000 });
    expect(justering(kv({}), 69.99)).toEqual({ endring: 9.99, belop: 0 });
    expect(justering(kv({}), 50.01)).toEqual({ endring: -9.99, belop: 0 });
    expect(justering(kv({ kategori: "bygning", mva_inngaende: 200000, mva_fradrag: 100 }), 50)).toEqual({ endring: -50, belop: -10000 });
    expect(justering(kv({ mva_inngaende: 123456.78 }), 33)).toEqual({ endring: -27, belop: -6666.67 });
  });

  it("samlet ved salg: resten av perioden med salgsåret; ingenting etter perioden", () => {
    expect(samletJustering(kv({}), 2026, 100)).toEqual({ aar: 2026, aar_til: 2028, antall: 3, prosent: 100, endring: 40, belop: 24000 });
    expect(samletJustering(kv({}), 2028, 0)).toEqual({ aar: 2028, aar_til: 2028, antall: 1, prosent: 0, endring: -60, belop: -12000 });
    expect(samletJustering(kv({ mva_fradrag: 100 }), 2026, 100)).toMatchObject({ belop: 0 });
    expect(samletJustering(kv({}), 2029, 100)).toBe(null);
  });
});

describe.skipIf(!process.env.DATABASE_URL)("mva-justeringen i appen", () => {
  const app = lagApi();
  const eier = "Bearer test:uid-mvaj-eier:mvaj-eier@server.test:mfa";
  const fakturerer = "Bearer test:uid-mvaj-fakt:mvaj-fakt@server.test:mfa";
  let org = "";
  let kunde = "";
  let maskin = "";
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
  const faktura = async (enhetspris: number, mva_sats: number, fakturadato: string) => {
    const f = await ok("POST", o("/fakturaer"), { kunde_id: kunde, fakturadato, forfallsdato: fakturadato, linjer: [{ beskrivelse: "Konsultasjon", antall: 1, enhetspris, mva_sats }] });
    return ok("POST", o(`/fakturaer/${f.id}/utsted`), { send_epost: false });
  };
  const justeringsbilag = async (fra: string, til: string) => (await ok("GET", o(`/regnskap/bilag?fra=${fra}&til=${til}&kilde=mva_justering`))).bilag;

  beforeAll(async () => {
    settLokalOppgavekjorer(async () => {});
    org = (await ok("POST", "/api/organisasjoner", { navn: "Kapitalvarer AS" })).id;
    await ok("PATCH", o(""), { kontonr: "86011117947", mva_registrert: true });
    const inv = await ok("POST", o("/invitasjoner"), { epost: "mvaj-fakt@server.test", rolle: "fakturerer" });
    expect((await kall("POST", "/api/invitasjoner/aksepter", { token: inv.lenke.split("/").pop() }, fakturerer)).status).toBe(200);
    // Fradraget for fellesanskaffelser er 60 %.
    await ok("PUT", o("/regnskap/oppsett"), { mva_fradrag: 60 });
    kunde = (await ok("POST", o("/kunder"), { navn: "Pasient Hansen", epost: "hansen@kunde.test" })).id;
    // 2025: 15 000 kr med avgift og 35 000 kr utenfor merverdiavgiftsloven (helsetjenester).
    await faktura(15000, 25, "2025-03-10");
    await faktura(35000, 0, "2025-04-10");
    // 2024: et røntgenapparat til 400 000 kr + 100 000 kr i mva, med 60 % fradrag.
    const u = await ok("POST", o("/regnskap/utgifter"), {
      type: "faktura",
      leverandor: "Medisinsk Utstyr AS",
      dato: "2024-03-15",
      forfallsdato: "2024-04-15",
      belop: 500000,
      behandling: "anlegg",
      anlegg_kategori: "maskiner",
      levetid_mnd: 60,
      linjer: [{ beskrivelse: "Røntgenapparat", konto: "1200", belop: 400000, mva_sats: 25, mva: 100000, fradrag: 60 }],
    });
    maskin = (await ok("POST", o(`/regnskap/utgifter/${u.id}/bokfor`))).anlegg_id;
  });

  it("utgiften blir en kapitalvare, og justeringen for året regnes fra omsetningen", async () => {
    const d = await ok("GET", o(`/regnskap/anleggsmidler/${maskin}`));
    expect(d.anleggsmiddel).toMatchObject({ kostpris: 440000, mva_inngaende: 100000, mva_fradrag: 60, mva_felles: true, mva_bruk: {} });
    expect(d.mva_justering).toMatchObject({ kapitalvare: true, grense: 50000, periode: { fra: 2024, til: 2028, antall: 5 }, salg: null });
    expect(d.mva_justering.aar.slice(0, 2)).toEqual([
      { aar: 2024, prosent: 60, kilde: "felles", endring: 0, belop: 0, bokfort: null },
      { aar: 2025, prosent: 30, kilde: "felles", endring: -30, belop: -6000, bokfort: null },
    ]);
    const s = await ok("GET", o("/regnskap/mva-justering?aar=2025"));
    expect(s).toMatchObject({
      aar: 2025,
      over: true,
      laast: false,
      felles: { prosent: 30, kilde: "omsetning", satt: null, omsetning: { avgiftspliktig: 15000, utenfor: 35000, prosent: 30 }, oppsett: 60 },
      sum: -6000,
      bilag: null,
      stemmer: false,
      trengs: true,
      samlet: [],
    });
    expect(s.kapitalvarer).toEqual([
      {
        anleggsmiddel_id: maskin,
        nummer: 1,
        navn: "Røntgenapparat",
        kategori: "maskiner",
        periode: { fra: 2024, til: 2028, antall: 5 },
        aar_nr: 2,
        mva_inngaende: 100000,
        start: 60,
        felles: true,
        prosent: 30,
        kilde: "felles",
        endring: -30,
        belop: -6000,
        bokfort: null,
      },
    ]);
    // 2024: ingen omsetning, fradraget i oppsettet (60 %): ingenting å justere.
    expect(await ok("GET", o("/regnskap/mva-justering?aar=2024"))).toMatchObject({ felles: { prosent: 60, kilde: "oppsett" }, sum: 0, trengs: false, stemmer: true });
    expect((await kall("GET", o("/regnskap/mva-justering?aar=2025"), undefined, fakturerer)).status).toBe(403);
    expect((await kall("POST", o("/regnskap/mva-justering/2099"))).data.error).toBe("Året er ikke over");
  });

  it("månedsavslutningen for desember fører justeringen før mva-oppgjøret, og meldingen har linjen", async () => {
    const a = await somSystem((db) => avsluttMaaned(db, org, "2025-12"));
    expect(a.bilag.map((b) => [b.bilagsnummer, b.tekst])).toEqual([
      ["V-2025-1", "Mva-justering for kapitalvarer 2025"],
      ["V-2025-2", "Mva-oppgjør 6. termin 2025 (november–desember)"],
    ]);
    expect(a.punkter.find((p) => p.nokkel === "mva_justering")).toEqual({
      nokkel: "mva_justering",
      navn: "Mva-justeringen",
      ok: true,
      tekst: "Mva-justeringen for kapitalvarene i 2025 er bokført (V-2025-1: 6 000,00 kr å betale tilbake).",
      lenke: "/regnskap?fane=mva&aar=2025&termin=6",
    });
    const b = await justeringsbilag("2025-12-31", "2025-12-31");
    expect(b.map((x: any) => [x.bilagsnummer, x.tekst, x.lenke])).toEqual([["V-2025-1", "Mva-justering for kapitalvarer 2025", "/regnskap?fane=mva&aar=2025&termin=6"]]);
    expect(b[0].posteringer.map((p: any) => [p.konto, p.belop, p.mva_kode ?? null, p.tekst])).toEqual([
      ["2710", -6000, "1", "Røntgenapparat (nr. 1), år 2 av 5: 60 % → 30 %"],
      ["7798", 6000, null, "Røntgenapparat (nr. 1), år 2 av 5: 60 % → 30 %"],
    ]);
    expect(b[0].posteringer[1].navn).toBe("Justering av inngående merverdiavgift (kapitalvarer)");
    const m = await ok("GET", o("/regnskap/mva?aar=2025&termin=6"));
    expect(m.linjer).toEqual([
      { kode: "1", beskrivelse: "Justering av merverdiavgift for kapitalvarer", grunnlag: null, sats: null, merverdiavgift: 6000, fradrag: true, spesifikasjon: "justering" },
    ]);
    expect(m).toMatchObject({ sum: 6000, kontroller: [], oppgjor: { stemmer: true } });
    expect(await ok("GET", o("/regnskap/mva-justering?aar=2025"))).toMatchObject({ bilag: { bilagsnummer: "V-2025-1" }, stemmer: true, kapitalvarer: [{ bokfort: -6000 }] });
    // Den generelle reverseringen gjelder ikke justeringen.
    expect((await kall("POST", o(`/regnskap/bilag/${b[0].id}/reverser`), {})).data.error).toBe(
      "Mva-justeringen rettes under Regnskap → Mva (for året) eller på anleggsmiddelet (ved salg)",
    );
  });

  it("fellesprosenten satt for året: føres på nytt, angres når endringen er under ti prosentpoeng, og låst år", async () => {
    let s = await ok("PUT", o("/regnskap/mva-justering/2025"), { fradrag: 40 });
    expect(s).toMatchObject({ felles: { prosent: 40, kilde: "satt", satt: 40 }, sum: -4000, stemmer: false });
    expect((await ok("POST", o("/regnskap/mva-justering/2025"))).bilag.bilagsnummer).toBe("V-2025-4");
    expect((await ok("POST", o("/regnskap/mva-justering/2025"))).bilag).toBe(null);
    expect((await ok("GET", o("/regnskap/mva?aar=2025&termin=6"))).oppgjor.stemmer).toBe(false);
    s = await ok("PUT", o("/regnskap/mva-justering/2025"), { fradrag: 55 });
    expect(s).toMatchObject({ sum: 0, trengs: false, stemmer: false, kapitalvarer: [{ endring: -5, belop: 0, bokfort: -4000 }] });
    const r = await ok("POST", o("/regnskap/mva-justering/2025"));
    expect([r.bilag, r.status.bilag, r.status.stemmer]).toEqual([null, null, true]);
    await ok("PUT", o("/regnskap/mva-justering/2025"), { fradrag: 40 });
    expect((await ok("POST", o("/regnskap/mva-justering/2025"))).bilag.bilagsnummer).toBe("V-2025-6");
    // Låst år: verken føres eller angres.
    await ok("PUT", o("/regnskap/periodelas"), { til: "2025-12-31" });
    await ok("PUT", o("/regnskap/mva-justering/2025"), { fradrag: 20 });
    expect((await kall("POST", o("/regnskap/mva-justering/2025"))).data.error).toBe("Året er låst; lås det opp først");
    expect((await kall("DELETE", o("/regnskap/mva-justering/2025"))).data.error).toBe("Året er låst; lås det opp først");
    await ok("PUT", o("/regnskap/periodelas"), { til: null });
    await ok("PUT", o("/regnskap/mva-justering/2025"), { fradrag: 40 });
    expect((await ok("DELETE", o("/regnskap/mva-justering/2025"))).bilag).toBe(null);
    expect((await ok("POST", o("/regnskap/mva-justering/2025"))).bilag.bilagsnummer).toBe("V-2025-8");
    // Rapporten for året.
    const rapport = (await kall("GET", o("/rapportmodul/regnskap.mva_justering?aar=2025"))).data;
    expect(rapport.rader).toEqual([{ nummer: "1", navn: "Røntgenapparat", periode: "2 av 5", mva: 100000, start: 60, prosent: 40, justering: -4000 }]);
    expect(rapport.merknad).toBe("Fradragsprosenten for fellesanskaffelser i 2025 er 40 % (satt for året). Justeringen er bokført (V-2025-8).");
  });

  it("egen prosent per år på kapitalvaren", async () => {
    const d = await ok("PATCH", o(`/regnskap/anleggsmidler/${maskin}`), { mva_felles: false, mva_bruk: { "2025": 40, "2026": 100 } });
    expect(d.mva_justering.aar.slice(1, 3)).toEqual([
      { aar: 2025, prosent: 40, kilde: "egen", endring: -20, belop: -4000, bokfort: { belop: -4000, bilagsnummer: "V-2025-8" } },
      { aar: 2026, prosent: 100, kilde: "egen", endring: 40, belop: 8000, bokfort: null },
    ]);
    expect((await kall("PATCH", o(`/regnskap/anleggsmidler/${maskin}`), { mva_bruk: { "2026": 120 } })).data.error).toBe("Fradraget er i prosent");
    expect((await kall("PATCH", o(`/regnskap/anleggsmidler/${maskin}`), { mva_fradrag: null })).data.error).toBe("Skriv fradragsprosenten ved anskaffelsen");
  });

  it("salget: samlet justering for resten av perioden mot gevinst, reversert med salget, og uten", async () => {
    const r = await ok("POST", o(`/regnskap/anleggsmidler/${maskin}/avgang`), { dato: "2026-06-15", type: "salg", vederlag: 300000, mva: 75000 });
    const just = r.bilag.at(-1);
    expect(just.bilagsnummer).toBe("V-2026-1");
    expect(r.mva_justering.salg).toEqual({
      aar: 2026,
      aar_til: 2028,
      antall: 3,
      prosent: 100,
      endring: 40,
      belop: 24000,
      med_avgift: true,
      bilag: { id: just.id, bilagsnummer: "V-2026-1", belop: 24000 },
    });
    const b = await justeringsbilag("2026-06-15", "2026-06-15");
    expect(b.map((x: any) => [x.bilagsnummer, x.lenke])).toEqual([["V-2026-1", `/regnskap?fane=anlegg&anlegg=${maskin}`]]);
    expect(b[0].posteringer.map((p: any) => [p.konto, p.belop, p.mva_kode ?? null])).toEqual([
      ["2710", 24000, "1"],
      ["3800", -24000, null],
    ]);
    expect(b[0].tekst).toBe("Mva-justering ved salg: Røntgenapparat (nr. 1), 2026–2028: 60 % → 100 %");
    // Meldingen for terminen med salget; den årlige justeringen for 2026 har ikke maskinen.
    const m = await ok("GET", o("/regnskap/mva?aar=2026&termin=3"));
    expect(m.linjer.map((l: any) => [l.kode, l.grunnlag, l.merverdiavgift, l.spesifikasjon])).toEqual([
      ["1", null, -24000, "justering"],
      ["3", 300000, 75000, null],
    ]);
    const s = await ok("GET", o("/regnskap/mva-justering?aar=2026"));
    expect([s.kapitalvarer, s.samlet.map((x: any) => [x.navn, x.aar, x.aar_til, x.prosent, x.belop, x.bilag.bilagsnummer])]).toEqual([
      [],
      [["Røntgenapparat", 2026, 2028, 100, 24000, "V-2026-1"]],
    ]);
    // Avgiften kan ikke endres etter salget.
    expect((await kall("PATCH", o(`/regnskap/anleggsmidler/${maskin}`), { mva_bruk: {} })).data.error).toBe("Anleggsmiddelet er solgt eller utrangert");

    // Salget reverseres: den samlede justeringen også.
    const salg = r.hendelser.find((h: any) => h.type === "avgang" && !h.reversert);
    await ok("POST", o(`/regnskap/bilag/${salg.bilag_id}/reverser`), {});
    const etter = await justeringsbilag("2026-06-15", "2026-06-15");
    expect(etter.map((x: any) => [x.bilagsnummer, x.reverserer !== null, x.reversert_av !== null])).toEqual([
      ["V-2026-1", false, true],
      ["V-2026-2", true, false],
    ]);
    expect((await ok("GET", o(`/regnskap/anleggsmidler/${maskin}`))).mva_justering.salg).toBe(null);

    // Selges uten justering (kjøperen overtar justeringsplikten), så føres den etterpå og angres.
    const r2 = await ok("POST", o(`/regnskap/anleggsmidler/${maskin}/avgang`), { dato: "2026-06-15", type: "salg", vederlag: 300000, mva: 75000, mva_justering: false });
    expect(r2.mva_justering.salg).toMatchObject({ belop: 24000, bilag: null });
    const f = await ok("POST", o(`/regnskap/anleggsmidler/${maskin}/mva-justering`), { fradrag: 80 });
    expect([f.bilag.bilagsnummer, f.mva_justering.salg.belop, f.mva_justering.salg.bilag.belop]).toEqual(["V-2026-3", 12000, 12000]);
    expect((await ok("DELETE", o(`/regnskap/anleggsmidler/${maskin}/mva-justering`))).mva_justering.salg.bilag).toBe(null);
    expect((await kall("DELETE", o(`/regnskap/anleggsmidler/${maskin}/mva-justering`))).data.error).toBe("Justeringen er ikke bokført");
  });

  it("anleggsmidler lagt inn for hånd: kapitalvare fra anskaffelsen, og ikke for personbiler", async () => {
    const ny = await ok("POST", o("/regnskap/anleggsmidler"), {
      navn: "Ultralyd",
      kategori: "inventar",
      anskaffet: "2025-05-02",
      kostpris: 240000,
      levetid_mnd: 60,
      anskaffelse: { motkonto: "2400", mva: 60000 },
    });
    expect(ny.anleggsmiddel).toMatchObject({ mva_inngaende: 60000, mva_fradrag: 100, mva_felles: false });
    expect(ny.mva_justering).toMatchObject({ kapitalvare: true, periode: { fra: 2025, til: 2029 } });
    const liten = await ok("POST", o("/regnskap/anleggsmidler"), { navn: "PC", kategori: "kontormaskiner", anskaffet: "2025-05-02", kostpris: 40000, levetid_mnd: 36, anskaffelse: { motkonto: "2400", mva: 10000 } });
    expect([liten.anleggsmiddel.mva_inngaende, liten.mva_justering.kapitalvare]).toEqual([null, false]);
    expect(
      (await kall("POST", o("/regnskap/anleggsmidler"), { navn: "Bil", kategori: "personbil", anskaffet: "2025-05-02", kostpris: 500000, levetid_mnd: 60, mva_inngaende: 125000, mva_fradrag: 0 }))
        .data.error,
    ).toBe("Tomt, goodwill og personbiler justeres ikke for merverdiavgift");
  });
});
