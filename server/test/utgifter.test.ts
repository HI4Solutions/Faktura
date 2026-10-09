// Utgiftene (0090_utgifter.sql, utgifter.ts, aiUtgift.ts, utgiftVurdering.ts): vurderingen og
// bilagene (fradrag per sats, representasjon uten fradrag, forholdsmessig fradrag, tjenester fra
// utlandet med og uten fradrag, anleggsmiddel, periodisering), AI-svaret kontrolleres, og i appen:
// en leverandørfaktura lastes opp, leses med AI (falske svar fra Gemini), vurderes, bokføres med
// mva-kodene og betales; kontoen læres per leverandør og slags kjøp, og neste faktura bokføres av
// seg selv; anleggsmiddel og periodisering fra utgifter, og angre; kvittering betalt med kort og en
// utgift fylt ut for hånd; fila arkiveres; det som ikke stemmer, bokføres ikke; tilgangen.
import { beforeAll, describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { lagApi } from "../src/api.js";
import { settAi } from "../src/ai.js";
import { tilUtgift, type AiUtgift } from "../src/aiUtgift.js";
import { regnskapskontoer } from "../src/anlegg.js";
import { lagring, settLokalOppgavekjorer } from "../src/tjenester.js";
import { kostnadsbilag, kostpris, vurder, type Utgiftsgrunnlag } from "../src/utgiftVurdering.js";

const K = regnskapskontoer({ kontoer: {} });
const P = (p: { konto: string; belop: number; mva_kode: string | null }[]) => p.map((x) => [x.konto, x.belop, x.mva_kode]);
const ingenAi = { varig: false, anlegg_kategori: null, periode_fra: null, periode_til: null };

describe("vurderingen og bilagene for utgiftene (uten database)", () => {
  const grunn: Utgiftsgrunnlag = {
    type: "faktura",
    leverandor: "Kontorbutikken AS",
    fakturanummer: "1001",
    dato: "2026-09-10",
    belop: 1865,
    betaling: "ubetalt",
    utland: false,
    beskrivelse: null,
    linjer: [
      { beskrivelse: "Papir", kategori: "kontorrekvisita", konto: "6800", belop: 1000, mva_sats: 25, mva: 250, fradrag: 100 },
      { beskrivelse: "Lunsj med kunde", kategori: "representasjon", konto: "7350", belop: 400, mva_sats: 25, mva: 100, fradrag: 0 },
      { beskrivelse: "Kaffe", kategori: "forbruk", konto: "6560", belop: 100, mva_sats: 15, mva: 15, fradrag: 50 },
    ],
  };

  it("kostnad: fradrag per sats med mva-kodene, representasjon uten fradrag og forholdsmessig fradrag", () => {
    const b = kostnadsbilag(grunn, K);
    expect(b.tekst).toBe("Faktura 1001 Kontorbutikken AS");
    expect(P(b.posteringer)).toEqual([
      ["6800", 1000, "1"],
      ["7350", 500, null],
      ["6560", 107.5, "11"],
      ["2710", 250, "1"],
      ["2711", 7.5, "11"],
      ["2400", -1865, null],
    ]);
    // Betalt med kort, kontant eller av en ansatt: banken, kontantene eller gjelden til den ansatte.
    expect(kostnadsbilag({ ...grunn, betaling: "bank" }, K).posteringer.at(-1)!.konto).toBe("1920");
    expect(kostnadsbilag({ ...grunn, betaling: "kontant" }, K).posteringer.at(-1)!.konto).toBe("1900");
    expect(kostnadsbilag({ ...grunn, betaling: "ansatt" }, K).posteringer.at(-1)!.konto).toBe("2910");
    expect(kostnadsbilag({ ...grunn, type: "kvittering", fakturanummer: null }, K).tekst).toBe("Kvittering Kontorbutikken AS");
  });

  it("tjenester fra utlandet: avgiften beregnes (86 med fradrag, 87 uten)", () => {
    const u: Utgiftsgrunnlag = {
      ...grunn,
      leverandor: "Google Ireland Ltd",
      belop: 1000,
      utland: true,
      linjer: [{ beskrivelse: "Workspace", kategori: "programvare", konto: "6420", belop: 1000, mva_sats: 0, mva: 0, fradrag: 100 }],
    };
    expect(P(kostnadsbilag(u, K).posteringer)).toEqual([
      ["6420", 1000, "86"],
      ["2714", 250, "86"],
      ["2704", -250, "86"],
      ["2400", -1000, null],
    ]);
    expect(P(kostnadsbilag({ ...u, linjer: [{ ...u.linjer[0]!, fradrag: 0 }] }, K).posteringer)).toEqual([
      ["6420", 1250, "87"],
      ["2704", -250, "87"],
      ["2400", -1000, null],
    ]);
  });

  it("anleggsmiddel fra 30 000 kr (med mva som ikke trekkes fra), periodisering over grensen, ellers kostnad", () => {
    const pc = { utland: false, dato: "2026-09-10", linjer: [{ beskrivelse: "PC", kategori: "datautstyr", konto: "6551", belop: 40000, mva_sats: 25, mva: 10000, fradrag: 100 }] };
    expect(vurder(pc, { ...ingenAi, varig: true, anlegg_kategori: "kontormaskiner" }, 5000)).toMatchObject({
      behandling: "anlegg",
      anlegg_kategori: "kontormaskiner",
      levetid_mnd: 36,
      vurdering: expect.stringContaining("aktiveres som anleggsmiddel (kontormaskiner og IT-utstyr) og avskrives over 3 år"),
    });
    // 24 000 kr + 6 000 kr mva uten fradrag er 30 000 kr i kostpris.
    const uten = { ...pc, linjer: [{ ...pc.linjer[0]!, belop: 24000, mva: 6000, fradrag: 0 }] };
    expect(kostpris(uten)).toBe(30000);
    expect(vurder(uten, { ...ingenAi, varig: true, anlegg_kategori: null }, 5000)).toMatchObject({ behandling: "anlegg", anlegg_kategori: "annet", levetid_mnd: 60 });
    expect(vurder({ ...pc, linjer: [{ ...pc.linjer[0]!, belop: 20000, mva: 5000 }] }, { ...ingenAi, varig: true }, 5000)).toMatchObject({
      behandling: "kostnad",
      vurdering: "Kostnad i september 2026. Varig, men under 30 000 kr: kostnadsføres med en gang.",
    });
    const forsikring = { utland: false, dato: "2026-01-05", linjer: [{ beskrivelse: "Forsikring", kategori: "forsikring", konto: "7500", belop: 12000, mva_sats: 0, mva: 0, fradrag: 0 }] };
    const aar = { ...ingenAi, periode_fra: "2026-01-01", periode_til: "2026-12-31" };
    expect(vurder(forsikring, aar, 5000)).toMatchObject({ behandling: "periodisering", periode_fra: "2026-01-01", antall_maaneder: 12 });
    expect(vurder(forsikring, aar, 20000)).toMatchObject({ behandling: "kostnad", vurdering: "Kostnad i januar 2026. Gjelder 12 måneder, men er under 20 000 kr: kostnadsføres med en gang." });
    // Innenfor måneden: kostnad.
    expect(vurder(forsikring, { ...ingenAi, periode_fra: "2026-01-01", periode_til: "2026-01-31" }, 0).behandling).toBe("kostnad");
  });

  it("AI-svaret kontrolleres: organisasjons- og kontonummer, datoer, satsene og kategoriene", () => {
    const a: AiUtgift = {
      type: "kvittering",
      leverandor: "  Kiosken \n AS ",
      orgnr: "915000372",
      fakturanummer: null,
      dato: "2099-01-01",
      forfallsdato: "2026-02-30",
      kid: "12 34",
      kontonr: "86011117948",
      valuta: "eur",
      belop: 125,
      mva: 25,
      utland: false,
      linjer: [
        { beskrivelse: "Kaffe", kategori: "finnes_ikke", belop: 100, mva_sats: 24.99, mva: null },
        { beskrivelse: "Null", kategori: "annet", belop: 0, mva_sats: 25, mva: 0 },
      ],
      varig: null,
      anlegg_kategori: "goodwill",
      periode_fra: null,
      periode_til: null,
      merknader: ["Uklar dato"],
    };
    const l = tilUtgift(a, "2026-10-09");
    expect(l).toMatchObject({
      type: "kvittering",
      leverandor: "Kiosken AS",
      orgnr: null,
      dato: null,
      forfallsdato: null,
      kid: "1234",
      kontonr: null,
      valuta: "EUR",
      belop: 125,
      linjer: [{ beskrivelse: "Kaffe", kategori: "annet", belop: 100, mva_sats: 25, mva: 25 }],
      varig: false,
      anlegg_kategori: "goodwill",
    });
    expect(l.merknader).toEqual([
      "Uklar dato",
      "Organisasjonsnummeret til leverandøren stemmer ikke (kontrollsifferet), og er ikke tatt med.",
      "Kontonummeret stemmer ikke (kontrollsifferet), og er ikke tatt med.",
      "Datoen er fram i tid, og er ikke tatt med.",
    ]);
  });
});

describe.skipIf(!process.env.DATABASE_URL)("utgiftene i appen", () => {
  const app = lagApi();
  const eier = "Bearer test:uid-utg-eier:utg-eier@server.test:mfa";
  const fakturerer = "Bearer test:uid-utg-fakt:utg-fakt@server.test:mfa";
  let org: string;
  const filer = new Map<string, Uint8Array>();
  const foresporsler: any[] = [];
  let neste: unknown = null;

  const kall = async (m: string, sti: string, k?: unknown, hvem = eier) => {
    const r = await app.request(sti, { method: m, headers: { authorization: hvem, "content-type": "application/json" }, body: k === undefined ? undefined : JSON.stringify(k) });
    return { status: r.status, data: (r.headers.get("content-type") ?? "").includes("json") ? ((await r.json()) as any) : null };
  };
  const pdf = new Uint8Array(3000).map((_, i) => (i < 8 ? "%PDF-1.4".charCodeAt(i) : i % 251));
  const last = async (svar: unknown, navn = "faktura.pdf", hvem = eier) => {
    neste = svar;
    const r = await app.request(`/api/org/${org}/regnskap/utgifter`, {
      method: "POST",
      headers: { authorization: hvem, "content-type": "application/pdf", "x-filnavn": encodeURIComponent(navn) },
      body: pdf,
    });
    return { status: r.status, data: (await r.json()) as any };
  };
  const u = (s: string = "") => `/api/org/${org}/regnskap/utgifter${s}`;
  const bilag = async (kilde?: string) =>
    (await kall("GET", `/api/org/${org}/regnskap/bilag?fra=2026-01-01&til=2026-12-31${kilde ? `&kilde=${kilde}` : ""}`)).data.bilag as any[];
  const poster = (b: any) => b.posteringer.map((p: any) => [p.konto, p.belop, p.mva_kode ?? null]);
  const svar = (x: Partial<AiUtgift>): AiUtgift => ({
    type: "faktura",
    leverandor: "Telenor Norge AS",
    orgnr: "976967631",
    fakturanummer: "88123",
    dato: "2026-09-15",
    forfallsdato: "2026-09-29",
    kid: "1234567890",
    kontonr: "86011117947",
    valuta: "NOK",
    belop: 1250,
    mva: 250,
    utland: false,
    linjer: [{ beskrivelse: "Mobilabonnement september", kategori: "telefon", belop: 1000, mva_sats: 25, mva: 250 }],
    varig: false,
    anlegg_kategori: null,
    periode_fra: null,
    periode_til: null,
    merknader: [],
    ...x,
  });

  beforeAll(async () => {
    Object.assign(config, {
      aiProsjekt: "hi4-test",
      aiRegion: "europe-west3",
      aiModell: "gemini-3.5-flash",
      aiGrense: 1000,
      fakturaBucket: "test-fakturaer",
      filerBucket: "test-filer",
    });
    settLokalOppgavekjorer(async () => undefined);
    lagring.hent = async (b, sti) => filer.get(`${b}/${sti}`) ?? null;
    lagring.lagre = async (b, sti, data) => {
      if (b === "test-fakturaer" && filer.has(`${b}/${sti}`)) throw Object.assign(new Error("finnes"), { code: 412 });
      filer.set(`${b}/${sti}`, data);
    };
    lagring.slett = async (b, sti) => {
      filer.delete(`${b}/${sti}`);
    };
    lagring.signertUrl = async (b, sti, minutter) => `https://lagring.test/${b}/${sti}?min=${minutter}`;
    settAi({
      token: async () => "test",
      fetch: async (_url, init) => {
        foresporsler.push(JSON.parse(String(init?.body)));
        const tekst = typeof neste === "string" ? neste : JSON.stringify(neste);
        return new Response(
          JSON.stringify({ candidates: [{ content: { parts: [{ text: tekst }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 1500, candidatesTokenCount: 200 } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });
    org = (await kall("POST", "/api/organisasjoner", { navn: "Fjordvik Legesenter AS" })).data.id;
    expect((await kall("PATCH", `/api/org/${org}`, { kontonr: "86011117947", mva_registrert: true })).status).toBe(200);
    const inv = await kall("POST", `/api/org/${org}/invitasjoner`, { epost: "utg-fakt@server.test", rolle: "fakturerer" });
    expect((await kall("POST", "/api/invitasjoner/aksepter", { token: inv.data.lenke.split("/").pop() }, fakturerer)).status).toBe(200);
  });

  it("en leverandørfaktura leses med AI, vurderes, bokføres med mva-kodene, arkiveres og betales", async () => {
    const r = await last(svar({}));
    expect(r.status, JSON.stringify(r.data)).toBe(201);
    // Fila gikk til modellen, med kjøperen i instruksjonen.
    const f = foresporsler.at(-1);
    expect(f.contents[0].parts[1].inlineData.mimeType).toBe("application/pdf");
    expect(f.systemInstruction.parts[0].text).toContain("for Fjordvik Legesenter AS");
    expect(r.data).toMatchObject({
      status: "kladd",
      type: "faktura",
      leverandor: "Telenor Norge AS",
      orgnr: "976967631",
      dato: "2026-09-15",
      forfallsdato: "2026-09-29",
      belop: 1250,
      betaling: "ubetalt",
      behandling: "kostnad",
      vurdering: "Kostnad i september 2026.",
      har_fil: true,
      laert: false,
      mangler: [],
      fil_navn: "faktura.pdf",
    });
    expect(r.data.linjer).toEqual([{ beskrivelse: "Mobilabonnement september", kategori: "telefon", konto: "6900", belop: 1000, mva_sats: 25, mva: 250, fradrag: 100 }]);
    expect(filer.has(`test-filer/${org}/utgifter/${r.data.id}.pdf`)).toBe(true);
    // Første gang fra leverandøren: venter på godkjenning. Kontoen rettes til mobiltelefon.
    const id = r.data.id;
    const e = await kall("PATCH", u(`/${id}`), { linjer: [{ ...r.data.linjer[0], konto: "6903" }] });
    expect(e.status, JSON.stringify(e.data)).toBe(200);
    const b = await kall("POST", u(`/${id}/bokfor`));
    expect(b.status, JSON.stringify(b.data)).toBe(200);
    expect(b.data).toMatchObject({ status: "bokfort", bilagsnummer: "U-2026-1", auto: false });
    const ub = (await bilag("utgift")).find((x) => x.lenke === `/regnskap?fane=utgifter&utgift=${id}`)!;
    expect(ub.tekst).toBe("Faktura 88123 Telenor Norge AS");
    expect(poster(ub)).toEqual([
      ["6903", 1000, "1"],
      ["2710", 250, "1"],
      ["2400", -1250, null],
    ]);
    // Fila er kopiert til fakturabøtta (oppbevares), og lenken går dit.
    expect(filer.has(`test-fakturaer/${org}/2026/utgift-U-2026-1-${id}.pdf`)).toBe(true);
    expect((await kall("GET", u(`/${id}/fil`))).data.url).toBe(`https://lagring.test/test-fakturaer/${org}/2026/utgift-U-2026-1-${id}.pdf?min=10`);
    // Bokført: endres og slettes ikke, og reverseres ikke i regnskapet.
    expect((await kall("PATCH", u(`/${id}`), { belop: 1 })).status).toBe(409);
    expect((await kall("DELETE", u(`/${id}`))).status).toBe(409);
    expect((await kall("POST", `/api/org/${org}/regnskap/bilag/${ub.id}/reverser`, {})).data.error).toBe("En utgift rettes under Regnskap → Utgifter (Angre bokføringen)");
    // Betalt fra banken: leverandørgjelden mot banken.
    const p = await kall("POST", u(`/${id}/betal`), { dato: "2026-09-28" });
    expect(p.status, JSON.stringify(p.data)).toBe(200);
    expect(p.data).toMatchObject({ betaling: "bank", betalt_dato: "2026-09-28", betaling_bilagsnummer: "U-2026-2" });
    expect(poster((await bilag("utgift_betaling"))[0])).toEqual([
      ["2400", 1250, null],
      ["1920", -1250, null],
    ]);
    expect((await kall("POST", u(`/${id}/betal`), { dato: "2026-09-28" })).data.error).toBe("Utgiften er alt betalt");
  });

  it("samme leverandør igjen: kontoen er lært for samme slags kjøp, og fakturaen bokføres av seg selv", async () => {
    const r = await last(svar({ fakturanummer: "88124", dato: "2026-10-01", forfallsdato: "2026-10-15" }));
    expect(r.data).toMatchObject({ status: "bokfort", auto: true, laert: true, bilagsnummer: "U-2026-3" });
    expect(r.data.linjer[0].konto).toBe("6903");
    // Et nytt slags kjøp fra samme leverandør, en merknad fra AI, eller automatikken slått av: venter.
    expect(
      (await last(svar({ fakturanummer: "88125", linjer: [{ beskrivelse: "Ruter", kategori: "datautstyr", belop: 1000, mva_sats: 25, mva: 250 }] }))).data,
    ).toMatchObject({ status: "kladd", laert: false });
    expect((await last(svar({ fakturanummer: "88126", merknader: ["Beløpet er utydelig"] }))).data).toMatchObject({ status: "kladd", merknader_ai: ["Beløpet er utydelig"] });
    expect((await kall("PUT", `/api/org/${org}/regnskap/oppsett`, { utgifter_auto: false })).data.utgifter_auto).toBe(false);
    expect((await last(svar({ fakturanummer: "88127" }))).data.status).toBe("kladd");
    expect((await kall("PUT", `/api/org/${org}/regnskap/oppsett`, { utgifter_auto: true })).status).toBe(200);
    // Lista: kladdene først.
    const l = (await kall("GET", u())).data;
    expect(l.ai).toBe(true);
    expect(l.utgifter.filter((x: any) => x.status === "kladd").map((x: any) => x.fakturanummer).sort()).toEqual(["88125", "88126", "88127"]);
    expect(l.kategorier.find((k: any) => k.kode === "representasjon")).toEqual({ kode: "representasjon", navn: "Representasjon (mat og drikke for kunder og ansatte)", konto: "7350", fradrag: false });
    for (const x of l.utgifter.filter((x: any) => x.status === "kladd")) expect((await kall("DELETE", u(`/${x.id}`))).status).toBe(204);
  });

  it("et anleggsmiddel og en periodisering fra utgifter, og bokføringen kan angres", async () => {
    const pc = await last(
      svar({
        leverandor: "Elkjøp Nordic AS",
        orgnr: "974760673",
        fakturanummer: "E-77",
        dato: "2026-09-20",
        belop: 50000,
        mva: 10000,
        linjer: [{ beskrivelse: "Bærbare PC-er og skjermer", kategori: "datautstyr", belop: 40000, mva_sats: 25, mva: 10000 }],
        varig: true,
        anlegg_kategori: "kontormaskiner",
      }),
    );
    expect(pc.data).toMatchObject({ status: "kladd", behandling: "anlegg", anlegg_kategori: "kontormaskiner", levetid_mnd: 36, forslag: { behandling: "anlegg" } });
    const b = await kall("POST", u(`/${pc.data.id}/bokfor`));
    expect(b.status, JSON.stringify(b.data)).toBe(200);
    expect(b.data.bilagsnummer).toMatch(/^A-2026-\d+$/);
    const a = (await kall("GET", `/api/org/${org}/regnskap/anleggsmidler/${b.data.anlegg_id}`)).data;
    expect(a.anleggsmiddel ?? a).toMatchObject({ kategori: "kontormaskiner", kostpris: 40000, levetid_mnd: 36, anskaffet: "2026-09-20" });
    expect(poster((await bilag("anlegg")).find((x) => x.bilagsnummer === b.data.bilagsnummer))).toEqual([
      ["1280", 40000, null],
      ["2710", 10000, "1"],
      ["2400", -50000, null],
    ]);
    // Angre: anskaffelsen reverseres og anleggsmiddelet slettes; kladden kan slettes (arkivet står).
    const angre = await kall("POST", u(`/${pc.data.id}/angre`));
    expect(angre.status, JSON.stringify(angre.data)).toBe(200);
    expect(angre.data).toMatchObject({ status: "kladd", bilagsnummer: null, anlegg_id: null });
    expect((await kall("GET", `/api/org/${org}/regnskap/anleggsmidler/${b.data.anlegg_id}`)).status).toBe(404);
    expect((await bilag("anlegg")).filter((x) => x.reverserer).length).toBe(1);
    expect((await kall("DELETE", u(`/${pc.data.id}`))).status).toBe(204);
    expect(filer.has(`test-filer/${org}/utgifter/${pc.data.id}.pdf`)).toBe(false);
    expect([...filer.keys()].some((k) => k.startsWith(`test-fakturaer/${org}/2026/utgift-${b.data.bilagsnummer}-`))).toBe(true);

    // Forsikringen for 2026, betalt på forskudd: periodiseres over tolv måneder.
    const fors = await last(
      svar({
        leverandor: "Gjensidige Forsikring ASA",
        orgnr: "923609016",
        fakturanummer: "G-1",
        dato: "2026-01-05",
        forfallsdato: "2026-01-20",
        belop: 12000,
        mva: 0,
        linjer: [{ beskrivelse: "Forsikring 2026", kategori: "forsikring", belop: 12000, mva_sats: 0, mva: 0 }],
        periode_fra: "2026-01-01",
        periode_til: "2026-12-31",
      }),
    );
    expect(fors.data).toMatchObject({ behandling: "periodisering", periode_fra: "2026-01-01", antall_maaneder: 12 });
    const p = await kall("POST", u(`/${fors.data.id}/bokfor`));
    expect(p.status, JSON.stringify(p.data)).toBe(200);
    expect(p.data.bilagsnummer).toMatch(/^P-2026-\d+$/);
    const per = (await kall("GET", `/api/org/${org}/regnskap/periodiseringer/${p.data.periodisering_id}`)).data;
    expect(per.periodisering ?? per).toMatchObject({ type: "forskuddsbetalt_kostnad", belop: 12000, resultatkonto: "7500", balansekonto: "1700", antall_maaneder: 12 });
    expect(poster((await bilag("periodisering")).find((x) => x.bilagsnummer === p.data.bilagsnummer))).toEqual([
      ["1700", 12000, null],
      ["2400", -12000, null],
    ]);
    // Leverandørgjelden: de to ubetalte (forsikringen; mobilen er betalt).
    const lg = (await kall("GET", `/api/org/${org}/rapportmodul/regnskap.leverandorgjeld`)).data;
    expect(lg.rader.map((x: any) => [x.leverandor, x.belop, x.bilag])).toEqual([
      ["Gjensidige Forsikring ASA", 12000, p.data.bilagsnummer],
      ["Telenor Norge AS", 1250, "U-2026-3"],
    ]);
    expect(lg.merknad).toContain("Saldoen på leverandørgjelden (konto 2400) er 13 250 kr.");
    // Angre etter at en måned er periodisert: starten kan ikke reverseres før månedene.
    const mnd = await kall("POST", `/api/org/${org}/regnskap/maanedsavslutning`, { til: "2026-01" });
    expect(mnd.status, JSON.stringify(mnd.data)).toBe(201);
    expect((await kall("POST", u(`/${fors.data.id}/angre`))).data.error).toMatch(/har senere bokføringer/);
  });

  it("en kvittering betalt med kort, en utgift fylt ut for hånd, og det som ikke stemmer, bokføres ikke", async () => {
    const k = await last(
      svar({ type: "kvittering", leverandor: "Clas Ohlson AS", orgnr: null, fakturanummer: null, forfallsdato: null, kid: null, kontonr: null, belop: 250, mva: 50, dato: "2026-10-02",
        linjer: [{ beskrivelse: "Batterier", kategori: "forbruk", belop: 200, mva_sats: 25, mva: 50 }] }),
      "kvittering.jpg",
    );
    expect(k.data).toMatchObject({ type: "kvittering", betaling: "bank", status: "kladd" });
    const kb = await kall("POST", u(`/${k.data.id}/bokfor`));
    expect(kb.data).toMatchObject({ status: "bokfort", betalt_dato: "2026-10-02" });
    expect(poster((await bilag("utgift")).find((x) => x.bilagsnummer === kb.data.bilagsnummer))).toEqual([
      ["6560", 200, "1"],
      ["2710", 50, "1"],
      ["1920", -250, null],
    ]);
    // For hånd: lunsj med en kunde, betalt kontant (representasjon: ikke fradrag).
    const h = await kall("POST", u(), {
      type: "kvittering",
      leverandor: "Kafé Fjord",
      dato: "2026-10-03",
      belop: 125,
      betaling: "kontant",
      linjer: [{ beskrivelse: "Lunsj", kategori: "representasjon", konto: "7350", belop: 100, mva_sats: 25, mva: 25 }],
    });
    expect(h.status, JSON.stringify(h.data)).toBe(201);
    expect(h.data).toMatchObject({ har_fil: false, merknader: ["Representasjon: ikke fradrag for mva."] });
    expect(h.data.linjer[0].fradrag).toBe(0);
    // Linjene stemmer ikke med beløpet: bokføres ikke.
    const feil = await kall("PATCH", u(`/${h.data.id}`), { belop: 130 });
    expect(feil.data.mangler).toEqual(["Linjene er 125,00 kr med mva, men utgiften er 130,00 kr"]);
    expect((await kall("POST", u(`/${h.data.id}/bokfor`))).data.error).toBe("Linjene er 125,00 kr med mva, men utgiften er 130,00 kr");
    await kall("PATCH", u(`/${h.data.id}`), { belop: 125 });
    const hb = await kall("POST", u(`/${h.data.id}/bokfor`));
    expect(poster((await bilag("utgift")).find((x) => x.bilagsnummer === hb.data.bilagsnummer))).toEqual([
      ["7350", 125, null],
      ["1900", -125, null],
    ]);
    // Angre en kostnad: bilaget reverseres, og den kan rettes og bokføres igjen.
    const a = await kall("POST", u(`/${h.data.id}/angre`));
    expect(a.data).toMatchObject({ status: "kladd", bilagsnummer: null, betalt_dato: null });
    expect((await bilag("utgift")).find((x) => x.reverserer && x.tekst === "Reversert, utgiften er angret: Kvittering Kafé Fjord")).toBeTruthy();
    expect((await kall("POST", u(`/${h.data.id}/bokfor`))).data.status).toBe("bokfort");
    // I en annen valuta: må skrives i kroner først.
    const eur = await last(svar({ leverandor: "Hotel Berlin GmbH", orgnr: null, valuta: "EUR", belop: 100, mva: 0, linjer: [{ beskrivelse: "Hotell", kategori: "reise", belop: 100, mva_sats: 0, mva: 0 }] }));
    expect(eur.data.mangler).toEqual(["Utgiften er i EUR: skriv beløpene i kroner (det som ble betalt), og sett valutaen til NOK"]);
  });

  it("når AI ikke kan lese fila eller er slått av, lagres den som en kladd å fylle ut", async () => {
    const r = await last("dette er ikke json");
    expect(r.status).toBe(201);
    expect(r.data).toMatchObject({ status: "kladd", ai_feil: "AI-en svarte ikke i riktig format. Prøv igjen.", linjer: [], har_fil: true });
    expect((await kall("PATCH", `/api/org/${org}`, { ai_aktiv: false })).status).toBe(200);
    const antall = foresporsler.length;
    const av = await last(svar({}));
    expect(av.data).toMatchObject({ status: "kladd", ai_feil: null, linjer: [] });
    expect(foresporsler.length).toBe(antall);
    expect((await kall("POST", u(`/${av.data.id}/les`))).data.error).toBe("AI er ikke slått på for organisasjonen");
    expect((await kall("PATCH", `/api/org/${org}`, { ai_aktiv: true })).status).toBe(200);
    // Lest på nytt når AI er slått på.
    neste = svar({ fakturanummer: "88200", linjer: [{ beskrivelse: "Datautstyr", kategori: "datautstyr", belop: 1000, mva_sats: 25, mva: 250 }] });
    const les = await kall("POST", u(`/${av.data.id}/les`));
    expect(les.status, JSON.stringify(les.data)).toBe(200);
    expect(les.data).toMatchObject({ fakturanummer: "88200", linjer: [{ konto: "6551" }] });
  });

  it("bare den som fører regnskapet, ser og fører utgiftene", async () => {
    expect((await kall("GET", u(), undefined, fakturerer)).status).toBe(403);
    expect((await last(svar({}), "f.pdf", fakturerer)).status).toBe(403);
    // Filtypen og størrelsen.
    const r = await app.request(u(), { method: "POST", headers: { authorization: eier, "content-type": "text/plain" }, body: "hei" });
    expect(((await r.json()) as any).error).toBe("Fakturaen eller kvitteringen må være en PDF eller et bilde (JPG, PNG, WebP eller HEIC).");
  });
});
