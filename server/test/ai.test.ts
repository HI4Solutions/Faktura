// AI med Gemini på Vertex AI (falske svar fra modellen): forespørselen som sendes, tolkning og
// feil, fakturautkast fra tekst og tale som sjekkes mot registrene, taket per organisasjon,
// og forslag på innbetalinger fra workeren og fra appen.
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { config } from "../src/config.js";
import { lagApi } from "../src/api.js";
import { alle, en, somSystem } from "../src/db.js";
import { aiAdresse, etterSkjema, generer, lesJson, settAi, type Skjema } from "../src/ai.js";
import { registertekst, systemtekst, tilUtkast, utkastSkjema, type AiUtkast, type Grunnlag } from "../src/aiFaktura.js";
import { forslagTekst, tilTreff, type FakturaForAi } from "../src/aiInnbetaling.js";
import { settKryptering } from "../src/kryptering.js";
import { settBankFetch } from "../src/enableBanking.js";
import { fullforBankOkt, hentInnbetalinger } from "../src/bank.js";
import { settLokalOppgavekjorer } from "../src/tjenester.js";

type Foresporsel = { url: string; auth: string | null; kropp: any };
const foresporsler: Foresporsel[] = [];
let modell: (f: Foresporsel) => Response = () => new Response("{}", { status: 500 });
const json = (status: number, data: unknown) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
const svar = (data: unknown, ekstra: Record<string, unknown> = {}) =>
  json(200, {
    candidates: [{ content: { role: "model", parts: [{ text: "tenker …", thought: true }, { text: JSON.stringify(data) }] }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 50, thoughtsTokenCount: 20 },
    ...ekstra,
  });
const tekstIForesporsel = (f: Foresporsel) => f.kropp.contents[0].parts.map((p: any) => p.text ?? "").join("\n");

beforeAll(() => {
  Object.assign(config, { aiProsjekt: "hi4-test", aiRegion: "europe-west3", aiModell: "gemini-3.5-flash", aiGrense: 1000 });
  settAi({
    token: async () => "ya29.test-token",
    fetch: async (url, init) => {
      const f: Foresporsel = { url: String(url), auth: new Headers(init?.headers).get("authorization"), kropp: JSON.parse(String(init?.body)) };
      foresporsler.push(f);
      return modell(f);
    },
  });
});
afterEach(() => {
  Object.assign(config, { aiProsjekt: "hi4-test", aiRegion: "europe-west3", aiModell: "gemini-3.5-flash", aiGrense: 1000 });
});

describe("Gemini på Vertex AI", () => {
  const skjema: Skjema = { type: "OBJECT", properties: { svar: { type: "STRING" } }, required: ["svar"] };

  it("bruker regionen i EU (eller multiregionen eu og global)", () => {
    expect(aiAdresse()).toBe("https://europe-west3-aiplatform.googleapis.com/v1/projects/hi4-test/locations/europe-west3/publishers/google/models/gemini-3.5-flash:generateContent");
    (config as any).aiRegion = "eu";
    expect(aiAdresse()).toBe("https://aiplatform.eu.rep.googleapis.com/v1/projects/hi4-test/locations/eu/publishers/google/models/gemini-3.5-flash:generateContent");
    (config as any).aiRegion = "global";
    expect(aiAdresse()).toBe("https://aiplatform.googleapis.com/v1/projects/hi4-test/locations/global/publishers/google/models/gemini-3.5-flash:generateContent");
  });

  it("sender skjemaet og tjenestekontoens token, og leser svaret uten tankene", async () => {
    modell = () => svar({ svar: "hei" });
    const r = await generer<{ svar: string }>({ system: "Vær kort.", deler: [{ text: "Si hei" }], skjema });
    expect(r).toEqual({ data: { svar: "hei" }, tokens_inn: 1000, tokens_ut: 70 });
    const f = foresporsler.at(-1)!;
    expect(f.auth).toBe("Bearer ya29.test-token");
    expect(f.kropp).toEqual({
      systemInstruction: { parts: [{ text: "Vær kort." }] },
      contents: [{ role: "user", parts: [{ text: "Si hei" }] }],
      generationConfig: { responseMimeType: "application/json", responseSchema: skjema, maxOutputTokens: 16384, thinkingConfig: { thinkingLevel: "low" } },
    });
    // Andre modeller enn Gemini 3 bruker standarden for tenking.
    (config as any).aiModell = "gemini-2.5-flash";
    await generer({ system: "x", deler: [{ text: "y" }], skjema });
    expect(foresporsler.at(-1)!.kropp.generationConfig.thinkingConfig).toBeUndefined();
  });

  it("prøver igjen når modellen er opptatt, og uten tenkenivå når det ikke støttes", async () => {
    let n = 0;
    modell = () => (++n === 1 ? json(429, { error: { code: 429, message: "Resource exhausted" } }) : svar({ svar: "ok" }));
    expect((await generer<{ svar: string }>({ system: "x", deler: [{ text: "y" }], skjema })).data.svar).toBe("ok");
    expect(n).toBe(2);

    n = 0;
    modell = (f) => {
      n++;
      return f.kropp.generationConfig.thinkingConfig ? json(400, { error: { code: 400, message: "thinking_level is not supported for this model." } }) : svar({ svar: "uten" });
    };
    expect((await generer<{ svar: string }>({ system: "x", deler: [{ text: "y" }], skjema })).data.svar).toBe("uten");
    expect(n).toBe(2);
  });

  it("gir forståelige feil", async () => {
    modell = () => json(429, { error: { message: "Resource exhausted" } });
    await expect(generer({ system: "x", deler: [{ text: "y" }], skjema })).rejects.toMatchObject({ status: 503, message: "AI-tjenesten er opptatt akkurat nå. Prøv igjen om litt." });
    modell = () => json(403, { error: { message: "Permission denied" } });
    await expect(generer({ system: "x", deler: [{ text: "y" }], skjema })).rejects.toMatchObject({ status: 503, message: "AI-tjenesten er ikke tilgjengelig akkurat nå." });
    modell = () => json(200, { candidates: [{ content: { parts: [{ text: '{"svar": "avbr' }] }, finishReason: "MAX_TOKENS" }] });
    await expect(generer({ system: "x", deler: [{ text: "y" }], skjema })).rejects.toThrow("Svaret fra AI-en ble for langt");
    modell = () => json(200, { promptFeedback: { blockReason: "SAFETY" } });
    await expect(generer({ system: "x", deler: [{ text: "y" }], skjema })).rejects.toThrow("AI-en ga ikke noe svar");
    modell = () => {
      throw new TypeError("fetch failed");
    };
    await expect(generer({ system: "x", deler: [{ text: "y" }], skjema })).rejects.toMatchObject({ status: 503, message: "Fikk ikke kontakt med AI-tjenesten. Prøv igjen om litt." });
    modell = () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    };
    await expect(generer({ system: "x", deler: [{ text: "y" }], skjema })).rejects.toMatchObject({ status: 504, message: "AI-tjenesten brukte for lang tid på å svare. Prøv igjen." });
    (config as any).aiProsjekt = undefined;
    await expect(generer({ system: "x", deler: [{ text: "y" }], skjema })).rejects.toMatchObject({ status: 503, message: "AI er ikke satt opp" });
  });

  it("prøver uten skjemaet når Gemini avviser det, og husker det en stund", async () => {
    const stort: Skjema = {
      type: "OBJECT",
      properties: {
        svar: { type: "STRING" },
        antall: { type: "INTEGER", nullable: true },
        ok: { type: "BOOLEAN" },
        sikkerhet: { type: "STRING", enum: ["hoy", "middels", "lav"] },
        liste: { type: "ARRAY", items: { type: "STRING" } },
      },
      required: ["svar", "antall", "ok", "sikkerhet", "liste"],
    };
    const avvisning = "The specified schema produces a constraint that has too many states for serving.";
    let n = 0;
    modell = (f) => {
      n++;
      if (f.kropp.generationConfig.responseSchema) return json(400, { error: { code: 400, message: avvisning } });
      // Uten skjemaet: fortsatt JSON, og skjemaet står i systemteksten.
      expect(f.kropp.generationConfig.responseMimeType).toBe("application/json");
      expect(f.kropp.systemInstruction.parts[0].text).toMatch(/^Vær kort\.\n\nSvar med ett JSON-objekt/);
      expect(f.kropp.systemInstruction.parts[0].text).toContain('"sikkerhet":{"type":"STRING","enum":["hoy","middels","lav"]}');
      return json(200, { candidates: [{ content: { parts: [{ text: '```json\n{"svar": "ok", "antall": "3", "ok": "true", "sikkerhet": "Høy"}\n```' }] }, finishReason: "STOP" }] });
    };
    const r = await generer({ system: "Vær kort.", deler: [{ text: "y" }], skjema: stort });
    expect(r).toEqual({ data: { svar: "ok", antall: 3, ok: true, sikkerhet: "hoy", liste: [] }, tokens_inn: 0, tokens_ut: 0, skjemafeil: `400: ${avvisning}` });
    expect(n).toBe(2);
    // Neste kall går rett uten skjemaet; «Test AI» (husk: false) prøver med det igjen.
    expect((await generer({ system: "Vær kort.", deler: [{ text: "y" }], skjema: stort })).skjemafeil).toBe(`400: ${avvisning}`);
    expect(n).toBe(3);
    await generer({ system: "Vær kort.", deler: [{ text: "y" }], skjema: stort, husk: false });
    expect(n).toBe(5);
  });

  it("prøver uten skjemaet også ved 500, og viser begge svarene fra Google når det ikke hjelper", async () => {
    const eget: Skjema = { type: "OBJECT", properties: { svar: { type: "STRING" } }, required: ["svar"] };
    let n = 0;
    modell = (f) => {
      n++;
      return f.kropp.generationConfig.responseSchema ? json(500, { error: { code: 500, message: "Internal error encountered." } }) : svar({ svar: "uten" });
    };
    const r = await generer<{ svar: string }>({ system: "x", deler: [{ text: "y" }], skjema: eget, husk: false });
    expect(r).toMatchObject({ data: { svar: "uten" }, skjemafeil: "500: Internal error encountered." });
    expect(n).toBe(2);

    modell = (f) => json(400, { error: { message: f.kropp.generationConfig.responseSchema ? "too many states" : "Unsupported MIME type: audio/x-test" } });
    await expect(generer({ system: "x", deler: [{ text: "y" }], skjema: eget, husk: false })).rejects.toMatchObject({
      status: 502,
      message: "AI-tjenesten svarte med en feil. Prøv igjen.",
      detaljer: "400: Unsupported MIME type: audio/x-test (med skjemaet: 400: too many states)",
    });
    // Feiler alt med 500, blir det bare ett nytt forsøk (uten skjemaet).
    n = 0;
    modell = () => {
      n++;
      return json(500, { error: { message: "Internal" } });
    };
    await expect(generer({ system: "x", deler: [{ text: "y" }], skjema: eget, husk: false })).rejects.toMatchObject({ status: 502, detaljer: "500: Internal" });
    expect(n).toBe(2);
  });

  it("leser JSON med tekst rundt og tilpasser svaret skjemaet", () => {
    expect(lesJson('{"a": 1}')).toEqual({ a: 1 });
    expect(lesJson('Her er svaret:\n```json\n{"a": 2}\n```')).toEqual({ a: 2 });
    expect(lesJson('Svaret er {"a": 3}.')).toEqual({ a: 3 });
    expect(lesJson("ikke json")).toBeUndefined();

    expect(
      etterSkjema(
        { kunde: "K1", linjer: [{ beskrivelse: "Vask", antall: "2", enhetspris: "1 500,50", pris_inkl_mva: "false", mva_sats: "25" }, "rot"], merknader: "Sjekk prisen" },
        utkastSkjema,
      ),
    ).toEqual({
      kunde: "K1",
      kunde_navn: null,
      linjer: [
        { produkt: null, beskrivelse: "Vask", antall: 2, enhet: null, enhetspris: 1500.5, pris_inkl_mva: false, mva_sats: 25, rabatt_prosent: null },
        { produkt: null, beskrivelse: "", antall: 0, enhet: null, enhetspris: null, pris_inkl_mva: false, mva_sats: null, rabatt_prosent: null },
      ],
      fakturadato: null,
      forfallsdato: null,
      periode_fra: null,
      periode_til: null,
      deres_referanse: null,
      kommentar: null,
      merknader: ["Sjekk prisen"],
    });
    const valg: Skjema = { type: "OBJECT", properties: { handling: { type: "STRING", enum: ["sjekk_betaling", "utestaende", "annet"] } } };
    expect(etterSkjema({ handling: "Sjekk betaling" }, valg)).toEqual({ handling: "sjekk_betaling" });
    expect(etterSkjema({ handling: "utestående" }, valg)).toEqual({ handling: "utestaende" });
    expect(etterSkjema({ handling: "fly" }, valg)).toEqual({ handling: "" });
    expect(etterSkjema(null, valg)).toEqual({ handling: "" });
  });
});

describe("fakturautkast: svaret sjekkes mot registrene", () => {
  const g: Grunnlag = {
    navn: "Utleie AS",
    mva: true,
    kunder: [
      { id: "k-kari", navn: "Kari Hansen", orgnr: null },
      { id: "k-fjord", navn: "Fjordline Logistikk AS", orgnr: "987654321" },
    ],
    produkter: [
      { id: "p-leie", navn: "Husleie", varenummer: "100", enhet: "mnd", enhetspris: 8000, mva_sats: 0 },
      { id: "p-time", navn: "Konsulenttime", varenummer: null, enhet: "time", enhetspris: 1200, mva_sats: 25 },
      { id: "p-vask", navn: "Vask", varenummer: null, enhet: "stk", enhetspris: null, mva_sats: 25 },
    ],
  };
  const linje = (l: Partial<AiUtkast["linjer"][number]>) => ({ produkt: null, beskrivelse: "", antall: 1, enhet: null, enhetspris: null, pris_inkl_mva: false, mva_sats: null, rabatt_prosent: null, ...l });
  const ai = (u: Partial<AiUtkast>): AiUtkast => ({
    kunde: null, kunde_navn: null, linjer: [], fakturadato: null, forfallsdato: null, periode_fra: null,
    periode_til: null, deres_referanse: null, kommentar: null, merknader: [], ...u,
  });

  it("gir modellen registrene med korte id-er og dagens dato", () => {
    expect(registertekst(g)).toBe(
      [
        "Kunder:",
        "K1: Kari Hansen",
        "K2: Fjordline Logistikk AS (org.nr. 987654321)",
        "",
        "Produkter:",
        "P1: Husleie (varenr. 100) | 8 000 kr per mnd eks. mva | 0 % mva",
        "P2: Konsulenttime | 1 200 kr per time eks. mva | 25 % mva",
        "P3: Vask | pris oppgis på fakturaen | 25 % mva",
      ].join("\n"),
    );
    const s = systemtekst(g, new Date("2026-10-07T10:00:00Z"));
    expect(s).toContain("Dagens dato er 2026-10-07 (onsdag). Selger er Utleie AS, som er mva-registrert.");
    expect(systemtekst({ ...g, mva: false })).toContain("som ikke er mva-registrert: alle linjer skal ha mva_sats 0");
  });

  it("bruker id-ene fra listene, produktenes pris og sats, og regner om pris med mva", () => {
    const u = tilUtkast(
      ai({
        kunde: "K2",
        kunde_navn: "Fjordline",
        linjer: [
          linje({ produkt: "P2", beskrivelse: "Rådgivning", antall: 3, enhet: "timer" }),
          linje({ produkt: "P1", beskrivelse: "Husleie oktober", antall: 1, mva_sats: 25 }),
          linje({ beskrivelse: "Parkering", antall: 2, enhet: "mnd", enhetspris: 1250, pris_inkl_mva: true, mva_sats: 25 }),
          linje({ produkt: "P3", beskrivelse: "Vask av trapp", antall: 1 }),
          linje({ produkt: "P9", beskrivelse: "Ukjent produkt", enhetspris: 100, mva_sats: 7, rabatt_prosent: 150 }),
          linje({ beskrivelse: "  " }),
        ],
        periode_fra: "2026-10-01",
        periode_til: "2026-10-31",
        forfallsdato: "2026-10-21",
        deres_referanse: "Ola",
        merknader: ["Prisen for vask er ikke oppgitt.", ""],
      }),
      g,
    );
    expect(u).toEqual({
      kunde_id: "k-fjord",
      kunde_navn: null,
      linjer: [
        { produkt_id: "p-time", beskrivelse: "Rådgivning", antall: 3, enhet: "time", enhetspris: 1200, mva_sats: 25, rabatt_prosent: null },
        { produkt_id: "p-leie", beskrivelse: "Husleie oktober", antall: 1, enhet: "mnd", enhetspris: 8000, mva_sats: 0, rabatt_prosent: null },
        { produkt_id: null, beskrivelse: "Parkering", antall: 2, enhet: "mnd", enhetspris: 1000, mva_sats: 25, rabatt_prosent: null },
        { produkt_id: "p-vask", beskrivelse: "Vask av trapp", antall: 1, enhet: "stk", enhetspris: null, mva_sats: 25, rabatt_prosent: null },
        { produkt_id: null, beskrivelse: "Ukjent produkt", antall: 1, enhet: "stk", enhetspris: 100, mva_sats: 25, rabatt_prosent: null },
      ],
      fakturadato: null,
      forfallsdato: "2026-10-21",
      periode_fra: "2026-10-01",
      periode_til: "2026-10-31",
      deres_referanse: "Ola",
      kommentar: null,
      merknader: ["Prisen for vask er ikke oppgitt."],
    });
  });

  it("finner kunden på navnet når modellen ikke valgte, og holder ugyldige datoer ute", () => {
    expect(tilUtkast(ai({ kunde_navn: "hansen" }), g)).toMatchObject({ kunde_id: "k-kari", kunde_navn: null });
    expect(tilUtkast(ai({ kunde: "K7", kunde_navn: "Per Olsen" }), g)).toMatchObject({ kunde_id: null, kunde_navn: "Per Olsen" });
    expect(tilUtkast(ai({ fakturadato: "2026-10-10", forfallsdato: "2026-10-01", periode_fra: "2026-11-01", periode_til: "2026-10-01" }), g)).toMatchObject({
      fakturadato: "2026-10-10",
      forfallsdato: null,
      periode_fra: null,
      periode_til: null,
    });
    expect(tilUtkast(ai({ forfallsdato: "2026-02-30", periode_fra: "i morgen" }), g)).toMatchObject({ forfallsdato: null, periode_fra: null });
  });

  it("uten mva: alle linjer får 0 % og prisen brukes som den er", () => {
    const u = tilUtkast(ai({ linjer: [linje({ produkt: "P2", antall: 2 }), linje({ beskrivelse: "Kurs", enhetspris: 500, pris_inkl_mva: true, mva_sats: 25 })] }), { ...g, mva: false });
    expect(u.linjer.map((l) => [l.beskrivelse, l.enhetspris, l.mva_sats])).toEqual([
      ["Konsulenttime", 1200, 0],
      ["Kurs", 500, 0],
    ]);
  });
});

describe("forslag på innbetalinger: svaret sjekkes mot fakturaene", () => {
  const apne: FakturaForAi[] = [
    { id: "f-1041", fakturanummer: 1041, kid: null, kunde: "Kari Hansen", utestaende: 8000, forfallsdato: "2026-10-20", periode_fra: "2026-10-01", periode_til: "2026-10-31", deres_referanse: null, linjer: "Husleie Storgata 5" },
    { id: "f-1042", fakturanummer: 1042, kid: "0100010420", kunde: "Fjordline Logistikk AS", utestaende: 2500, forfallsdato: null, periode_fra: null, periode_til: null, deres_referanse: "Ola", linjer: null },
  ];

  it("beskriver innbetalingen, historikken og fakturaene", () => {
    const t = forslagTekst({ dato: "2026-10-06", belop: 8000, betaler: "HANSEN OLA", betaler_konto: "12345678903", melding: "husleie okt", referanse: null }, apne, [{ kunde: "Kari Hansen", n: 3 }]);
    expect(t).toBe(
      [
        "Innbetaling: 2026-10-06, 8 000,00 kr, fra «HANSEN OLA», konto 12345678903, melding «husleie okt».",
        "Betaleren har betalt fakturaer for: Kari Hansen (3 ganger).",
        "",
        "Ubetalte fakturaer:",
        "F1: faktura 1041 | Kari Hansen | gjenstår 8 000,00 | forfall 2026-10-20 | periode 2026-10-01–2026-10-31 | «Husleie Storgata 5»",
        "F2: faktura 1042 | Fjordline Logistikk AS | gjenstår 2 500,00 | forfall – | KID 0100010420 | ref. Ola",
      ].join("\n"),
    );
  });

  it("godtar bare fakturaer fra listen", () => {
    expect(tilTreff({ faktura: "F1", sikkerhet: "hoy", grunn: "Husleie for oktober." }, apne)).toEqual({ faktura: apne[0], sikkerhet: "hoy", grunn: "Husleie for oktober." });
    expect(tilTreff({ faktura: "F3", sikkerhet: "hoy", grunn: "?" }, apne)).toMatchObject({ faktura: null });
    expect(tilTreff({ faktura: "f-1042", sikkerhet: "middels", grunn: "" }, apne)).toEqual({ faktura: null, sikkerhet: "middels", grunn: "Fant ingen faktura som passer." });
    expect(tilTreff({ faktura: "F2", sikkerhet: "sikker" as any, grunn: "" }, apne)).toEqual({ faktura: apne[1], sikkerhet: "lav", grunn: "Faktura 1042 passer best." });
  });
});

describe.skipIf(!process.env.DATABASE_URL)("AI i appen", () => {
  const app = lagApi();
  const eier = "Bearer test:uid-ai-eier:ai-eier@server.test:mfa";
  const leser = "Bearer test:uid-ai-les:ai-les@server.test:mfa";
  const fremmed = "Bearer test:uid-ai-fremmed:ai-fremmed@server.test:mfa";
  let org: string;
  let kari: string;
  let fjord: string;
  let leie: string;
  const fakturaer: Record<number, string> = {};
  const dag = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Oslo" }).format(new Date());

  const kall = async (m: string, sti: string, k?: unknown, hvem = eier, type = "application/json") => {
    const r = await app.request(sti, {
      method: m,
      headers: { authorization: hvem, "content-type": type },
      body: k === undefined ? undefined : k instanceof Uint8Array ? k : JSON.stringify(k),
    });
    return { status: r.status, data: (r.headers.get("content-type") ?? "").includes("json") ? ((await r.json()) as any) : null };
  };
  const bruk = () => somSystem((db) => alle(db, "select funksjon, antall from faktura.ai_bruk where org_id = $1 order by funksjon", [org]));

  beforeAll(async () => {
    org = (await kall("POST", "/api/organisasjoner", { navn: "AI Utleie AS" })).data.id;
    expect((await kall("PATCH", `/api/org/${org}`, { kontonr: "86011117947", mva_registrert: true })).status).toBe(200);
    kari = (await kall("POST", `/api/org/${org}/kunder`, { navn: "Kari Hansen", type: "person", epost: "kari@hansen.no" })).data.id;
    fjord = (await kall("POST", `/api/org/${org}/kunder`, { navn: "Fjordline Logistikk AS", epost: "faktura@fjordline.no" })).data.id;
    leie = (await kall("POST", `/api/org/${org}/produkter`, { navn: "Husleie", enhet: "mnd", enhetspris: 8000, mva_sats: 0 })).data.id;
    const inv = await kall("POST", `/api/org/${org}/invitasjoner`, { epost: "ai-les@server.test", rolle: "les" });
    expect((await kall("POST", "/api/invitasjoner/aksepter", { token: inv.data.lenke.split("/").pop() }, leser)).status).toBe(200);
  });

  it("organisasjonen ser om AI er tilgjengelig, og administratoren kan slå det av", async () => {
    expect((await kall("GET", `/api/org/${org}`)).data).toMatchObject({ ai_aktiv: true, ai_tilgjengelig: true });
    expect((await kall("PATCH", `/api/org/${org}`, { ai_aktiv: false })).data.ai_aktiv).toBe(false);
    expect((await kall("POST", `/api/org/${org}/ai/faktura`, { tekst: "Faktura til Kari" })).data).toEqual({ error: "AI er slått av for organisasjonen" });
    expect((await kall("PATCH", `/api/org/${org}`, { ai_aktiv: true })).data.ai_aktiv).toBe(true);
    (config as any).aiProsjekt = undefined;
    expect((await kall("GET", `/api/org/${org}`)).data.ai_tilgjengelig).toBe(false);
    expect((await kall("POST", `/api/org/${org}/ai/faktura`, { tekst: "Faktura til Kari" })).status).toBe(503);
  });

  it("lager et fakturautkast fra tekst", async () => {
    modell = (f) => {
      expect(f.kropp.systemInstruction.parts[0].text).toContain("Selger er AI Utleie AS, som er mva-registrert.");
      expect(tekstIForesporsel(f)).toContain("K1: Fjordline Logistikk AS");
      expect(tekstIForesporsel(f)).toContain("K2: Kari Hansen");
      expect(tekstIForesporsel(f)).toContain("P1: Husleie | 8 000 kr per mnd eks. mva | 0 % mva");
      expect(tekstIForesporsel(f)).toContain("Brukerens beskrivelse:\nHusleie for oktober til Kari, og to timer vask à 500 inkl. mva");
      return svar({
        kunde: "K2",
        kunde_navn: "Kari",
        linjer: [
          { produkt: "P1", beskrivelse: "Husleie oktober", antall: 1, enhet: "mnd", enhetspris: null, pris_inkl_mva: false, mva_sats: 0, rabatt_prosent: null },
          { produkt: null, beskrivelse: "Vask", antall: 2, enhet: "timer", enhetspris: 500, pris_inkl_mva: true, mva_sats: 25, rabatt_prosent: null },
        ],
        fakturadato: null,
        forfallsdato: null,
        periode_fra: "2026-10-01",
        periode_til: "2026-10-31",
        deres_referanse: null,
        kommentar: null,
        merknader: [],
      });
    };
    const r = await kall("POST", `/api/org/${org}/ai/faktura`, { tekst: "Husleie for oktober til Kari, og to timer vask à 500 inkl. mva" });
    expect(r.status).toBe(200);
    expect(r.data).toEqual({
      kunde_id: kari,
      kunde_navn: null,
      linjer: [
        { produkt_id: leie, beskrivelse: "Husleie oktober", antall: 1, enhet: "mnd", enhetspris: 8000, mva_sats: 0, rabatt_prosent: null },
        { produkt_id: null, beskrivelse: "Vask", antall: 2, enhet: "time", enhetspris: 400, mva_sats: 25, rabatt_prosent: null },
      ],
      fakturadato: null,
      forfallsdato: null,
      periode_fra: "2026-10-01",
      periode_til: "2026-10-31",
      deres_referanse: null,
      kommentar: null,
      merknader: [],
    });
    // Utkastet kan lagres som det er.
    const lagret = await kall("POST", `/api/org/${org}/fakturaer`, { kunde_id: r.data.kunde_id, periode_fra: r.data.periode_fra, periode_til: r.data.periode_til, linjer: r.data.linjer });
    expect(lagret.status).toBe(201);
    const utkast = (await kall("GET", `/api/org/${org}/fakturaer/${lagret.data.id}`)).data;
    expect(utkast.linjer.map((l: any) => [l.produkt_id, l.beskrivelse, l.antall, l.enhet, l.enhetspris, l.mva_sats])).toEqual([
      [leie, "Husleie oktober", 1, "mnd", 8000, 0],
      [null, "Vask", 2, "time", 400, 25],
    ]);
    expect(await bruk()).toEqual([{ funksjon: "faktura", antall: 1 }]);
    const tokens = await somSystem((db) => en(db, "select tokens_inn, tokens_ut from faktura.ai_bruk where org_id = $1", [org]));
    expect(tokens).toEqual({ tokens_inn: 1000, tokens_ut: 70 });
  });

  it("skriver ned tale, så brukeren ser teksten før utkastet lages", async () => {
    const opptak = new Uint8Array(2000).map((_, i) => i % 251);
    modell = (f) => {
      expect(f.kropp.systemInstruction.parts[0].text).toMatch(/^Du skriver ned tale på norsk, ordrett\./);
      expect(f.kropp.contents[0].parts.find((p: any) => p.inlineData).inlineData).toEqual({ mimeType: "audio/webm", data: Buffer.from(opptak).toString("base64") });
      return svar({ tale: true, tekst: "Faktura til Per Olsen for en konsulenttime." });
    };
    const r = await kall("POST", `/api/org/${org}/ai/faktura/tale`, opptak, eier, "audio/webm;codecs=opus");
    expect(r).toEqual({ status: 200, data: { tekst: "Faktura til Per Olsen for en konsulenttime." } });
    expect((await bruk()).find((b: any) => b.funksjon === "faktura")).toEqual({ funksjon: "faktura", antall: 2 });

    // Ingen tale i opptaket: sier fra i stedet for å gjette.
    modell = () => svar({ tale: false, tekst: "" });
    expect((await kall("POST", `/api/org/${org}/ai/faktura/tale`, opptak, eier, "audio/webm")).data).toEqual({ error: "Hørte ingen tale. Prøv igjen, eller skriv i stedet." });
    expect((await kall("POST", `/api/org/${org}/ai/faktura/tale`, new Uint8Array(100), eier, "audio/webm")).data.error).toContain("Opptaket er tomt");
    expect((await kall("POST", `/api/org/${org}/ai/faktura/tale`, opptak, eier, "audio/x-midi")).status).toBe(400);
    // Bare de som kan lage fakturaer; eldre versjoner av appen sendte lyden rett til utkastet.
    expect((await kall("POST", `/api/org/${org}/ai/faktura/tale`, opptak, leser, "audio/webm")).status).toBe(403);
    expect((await kall("POST", `/api/org/${org}/ai/faktura`, opptak, eier, "audio/webm")).data).toEqual({ error: "Appen er oppdatert. Last inn siden på nytt for å bruke tale." });
  });

  it("sier fra når teksten ikke beskriver en faktura, og andre får ikke bruke det", async () => {
    modell = () => svar({ kunde: null, kunde_navn: null, linjer: [], fakturadato: null, forfallsdato: null, periode_fra: null, periode_til: null, deres_referanse: null, kommentar: null, merknader: [] });
    const r = await kall("POST", `/api/org/${org}/ai/faktura`, { tekst: "Hvordan blir været i morgen?" });
    expect(r.status).toBe(422);
    expect(r.data.error).toBe("Fant ikke hva som skal faktureres. Si hvem kunden er og hva du vil fakturere.");
    expect((await kall("POST", `/api/org/${org}/ai/faktura`, { tekst: "" })).data.error).toBe("Skriv hva som skal faktureres");
    const n = foresporsler.length;
    expect((await kall("POST", `/api/org/${org}/ai/faktura`, { tekst: "Faktura til Kari" }, leser)).status).toBe(403);
    expect((await kall("POST", `/api/org/${org}/ai/faktura`, { tekst: "Faktura til Kari" }, fremmed)).status).toBe(403);
    expect(foresporsler.length).toBe(n);
  });

  it("plattformadministratoren kan teste oppsettet og se svaret fra Google", async () => {
    const admin = "Bearer test:uid-ai-admin:ai-admin@server.test:mfa";
    (config as any).adminEposter = ["ai-admin@server.test"];
    // Samme forespørsler som fakturautkast og assistenten, med eksempelregistrene.
    const modellSvar = (f: Foresporsel, avvisSkjema = false, hort = "") => {
      const system = f.kropp.systemInstruction.parts[0].text as string;
      if (system.startsWith("Du skriver ned tale")) {
        expect(f.kropp.contents[0].parts.find((p: any) => p.inlineData).inlineData.mimeType).toBe("audio/wav");
        return svar(hort ? { tale: true, tekst: hort } : { tale: false, tekst: "" });
      }
      if (avvisSkjema && f.kropp.generationConfig.responseSchema && !system.startsWith("Svar kort")) return json(400, { error: { message: "too many states" } });
      if (system.startsWith("Du lager utkast")) {
        expect(tekstIForesporsel(f)).toContain("K1: Kari Hansen");
        expect(tekstIForesporsel(f)).toContain("Brukerens beskrivelse:\nHusleie for oktober til Kari Hansen");
        return svar({
          kunde: "K1", kunde_navn: "Kari Hansen",
          linjer: [{ produkt: "P1", beskrivelse: "Husleie oktober", antall: 1, enhet: "mnd", enhetspris: null, pris_inkl_mva: false, mva_sats: 0, rabatt_prosent: null }],
          fakturadato: null, forfallsdato: "2026-10-21", periode_fra: null, periode_til: null, deres_referanse: null, kommentar: null, merknader: [],
        });
      }
      if (system.startsWith("Du er assistenten")) {
        expect(tekstIForesporsel(f)).toContain("Kommandoen:\nHar Kari Hansen betalt?");
        return svar({ handling: "sjekk_betaling", kunde: "K1" });
      }
      return svar({ svar: "Hei fra Gemini" });
    };
    modell = (f) => modellSvar(f);
    const ok = (await kall("POST", "/api/admin/ai-test", undefined, admin)).data;
    expect(ok).toMatchObject({ ok: true, svar: "Hei fra Gemini", modell: "gemini-3.5-flash", region: "europe-west3", tokens_inn: 4000, tokens_ut: 280, feil: null });
    expect(ok.tester).toMatchObject([
      { navn: "Enkelt svar", ok: true, svar: "Hei fra Gemini", skjemafeil: null },
      { navn: "Fakturautkast", ok: true, svar: "Kari Hansen: Husleie oktober (14500), forfall 2026-10-21", skjemafeil: null },
      { navn: "Assistent", ok: true, svar: "sjekk_betaling (K1)", skjemafeil: null },
      { navn: "Tale (stille opptak)", ok: true, svar: "Ingen tale, som ventet", skjemafeil: null },
    ]);
    // Finner AI-en tale i stillheten, er det en feil.
    modell = (f) => modellSvar(f, false, "Takk for at du så på.");
    const hallusinasjon = (await kall("POST", "/api/admin/ai-test", undefined, admin)).data;
    expect(hallusinasjon).toMatchObject({ ok: false, feil: "Tale (stille opptak): AI-en fant tale i et stille opptak: «Takk for at du så på.»" });

    // Gemini avviser de store skjemaene: testen viser det, og svaret kommer likevel.
    modell = (f) => modellSvar(f, true);
    const uten = (await kall("POST", "/api/admin/ai-test", undefined, admin)).data;
    expect(uten.ok).toBe(true);
    expect(uten.tester.map((t: any) => [t.navn, t.ok, t.skjemafeil])).toEqual([
      ["Enkelt svar", true, null],
      ["Fakturautkast", true, "400: too many states"],
      ["Assistent", true, "400: too many states"],
      ["Tale (stille opptak)", true, null],
    ]);

    modell = () => json(404, { error: { code: 404, message: "Publisher Model `gemini-3.5-flash` was not found or your project does not have access to it." } });
    const feil = (await kall("POST", "/api/admin/ai-test", undefined, admin)).data;
    expect(feil).toMatchObject({
      ok: false,
      feil: "Enkelt svar: AI-tjenesten er ikke tilgjengelig akkurat nå.",
      detaljer: "404: Publisher Model `gemini-3.5-flash` was not found or your project does not have access to it.",
    });
    expect(feil.tester.map((t: any) => t.ok)).toEqual([false, false, false, false]);
    (config as any).aiProsjekt = undefined;
    expect((await kall("POST", "/api/admin/ai-test", undefined, admin)).data).toMatchObject({ ok: false, feil: "AI er ikke satt opp (AI_PROSJEKT mangler)." });
    expect((await kall("POST", "/api/admin/ai-test")).status).toBe(403);
    (config as any).adminEposter = [];
  });

  it("feil fra Google vises til plattformadministratorene, ikke til andre", async () => {
    modell = () => json(400, { error: { code: 400, message: "Request contains an invalid argument." } });
    const vanlig = await kall("POST", `/api/org/${org}/ai/faktura`, { tekst: "Faktura til Kari" });
    expect(vanlig).toEqual({ status: 502, data: { error: "AI-tjenesten svarte med en feil. Prøv igjen." } });
    (config as any).adminEposter = ["ai-eier@server.test"];
    const admin = await kall("POST", `/api/org/${org}/ai/faktura`, { tekst: "Faktura til Kari" });
    expect(admin.data.error).toBe("AI-tjenesten svarte med en feil. Prøv igjen. (Google: 400: Request contains an invalid argument.)");
    (config as any).adminEposter = [];
  });

  it("stopper ved taket for måneden", async () => {
    const brukt = (await bruk()).reduce((s: number, b: any) => s + b.antall, 0);
    (config as any).aiGrense = brukt;
    const n = foresporsler.length;
    const r = await kall("POST", `/api/org/${org}/ai/faktura`, { tekst: "Faktura til Kari" });
    expect(r.status).toBe(429);
    expect(r.data.error).toBe(`Organisasjonen har brukt alle de ${brukt} AI-forespørslene for denne måneden.`);
    expect(foresporsler.length).toBe(n);
  });

  describe("forslag på innbetalinger", () => {
    const { privateKey: privat } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
    let transaksjoner: any[] = [];
    const inn = (id: string, belop: number, debtor: string, melding: string) => ({
      entry_reference: id,
      transaction_amount: { amount: belop.toFixed(2), currency: "NOK" },
      credit_debit_indicator: "CRDT",
      status: "BOOK",
      booking_date: dag,
      debtor: { name: debtor },
      remittance_information: [melding],
    });
    const rad = (ekstern: string) => somSystem((db) => en(db, "select * from faktura.banktransaksjoner where org_id = $1 and ekstern_id = $2", [org, ekstern]));

    beforeAll(async () => {
      (config as any).enableBankingUrl = "https://eb.test";
      settKryptering(async (t) => Buffer.from(`kryptert:${t}`), async (d) => d.toString().replace(/^kryptert:/, ""));
      settLokalOppgavekjorer(async () => undefined);
      settBankFetch(async (url) => {
        const u = new URL(String(url));
        if (u.pathname === "/application") return json(200, { name: "HI4 Faktura", redirect_urls: ["http://localhost:5173/bank/tilbake"] });
        if (u.pathname === "/aspsps") return json(200, { aspsps: [{ name: "DNB", country: "NO", psu_types: ["business"], maximum_consent_validity: 15552000 }] });
        if (u.pathname === "/auth") return json(200, { url: "https://bank.test/bankid" });
        if (u.pathname === "/sessions") return json(200, { session_id: "s-ai", access: { valid_until: "2027-04-04T10:00:00Z" }, accounts: [{ uid: "k-drift", account_id: { iban: "NO9386011117947" }, name: "Drift" }] });
        if (u.pathname.startsWith("/accounts/k-drift/transactions")) return json(200, { transactions: transaksjoner });
        throw new Error(`Uventet kall til Enable Banking: ${u.pathname}`);
      });
      const r = await kall("PUT", `/api/org/${org}/bank`, { app_id: "8a5e1a0e-6b3c-4c1f-9a77-1b2c3d4e5f60", privat_nokkel: privat, bank: "DNB", psu_type: "business" });
      expect(r.status).toBe(200);
      await fullforBankOkt(org, r.data.kobling_id, "kode");
      // To utstedte fakturaer: husleie til Kari og en til Fjordline.
      for (const [kunde, linjer] of [
        [kari, [{ produkt_id: leie, beskrivelse: "Husleie Storgata 5, oktober", antall: 1, enhet: "mnd", enhetspris: 8000, mva_sats: 0 }]],
        [fjord, [{ beskrivelse: "Transport", antall: 1, enhetspris: 2000, mva_sats: 25 }]],
      ] as const) {
        const f = (await kall("POST", `/api/org/${org}/fakturaer`, { kunde_id: kunde, periode_fra: "2026-10-01", periode_til: "2026-10-31", linjer })).data;
        const u = await kall("POST", `/api/org/${org}/fakturaer/${f.id}/utsted`, { send_epost: false });
        expect(u.status).toBe(200);
        fakturaer[u.data.fakturanummer] = f.id;
      }
    });

    it("workeren tar med forslag AI-en er rimelig sikker på", async () => {
      (config as any).aiGrense = 1000;
      transaksjoner = [
        inn("a1", 7000, "HANSEN OLA", "husleie okt storgata"),
        inn("a2", 450, "Ukjent Person", "lodd"),
        inn("a3", 1999, "FJORDLINE", "transport"),
      ];
      const sett: string[] = [];
      modell = (f) => {
        const tekst = tekstIForesporsel(f);
        sett.push(tekst);
        expect(f.kropp.systemInstruction.parts[0].text).toContain("hvilken faktura en innbetaling på bankkontoen gjelder");
        if (tekst.includes("HANSEN OLA")) {
          const nr = tekst.match(/(F\d+): faktura \d+ \| Kari Hansen/)![1];
          return svar({ faktura: nr, sikkerhet: "hoy", grunn: "Husleie for oktober i Storgata 5, betalt av en i familien." });
        }
        if (tekst.includes("Ukjent Person")) return svar({ faktura: null, sikkerhet: "lav", grunn: "Ser ikke ut til å gjelde en faktura." });
        return svar({ faktura: "F1", sikkerhet: "lav", grunn: "Kanskje." });
      };
      expect(await hentInnbetalinger(org)).toEqual({ nye: 3, koblet: 0, forslag: 1 });
      expect(sett).toHaveLength(3);
      const ola = sett.find((t) => t.includes("HANSEN OLA"))!;
      expect(ola).toContain("Innbetaling: " + dag + ", 7 000,00 kr, fra «HANSEN OLA», melding «husleie okt storgata».");
      expect(ola).toMatch(/faktura \d+ \| Kari Hansen \| gjenstår 8 000,00 \| forfall \d{4}-\d{2}-\d{2} \| periode 2026-10-01–2026-10-31 \| «Husleie Storgata 5, oktober»/);
      expect(await rad("a1")).toMatchObject({ status: "forslag", faktura_id: fakturaer[1], grunn: "AI: Husleie for oktober i Storgata 5, betalt av en i familien." });
      expect(await rad("a2")).toMatchObject({ status: "uavklart", faktura_id: null, grunn: null });
      expect(await rad("a3")).toMatchObject({ status: "uavklart", faktura_id: null });
      expect((await bruk()).find((b: any) => b.funksjon === "innbetaling")).toEqual({ funksjon: "innbetaling", antall: 3 });

      // Brukeren bekrefter forslaget som før.
      const a1 = (await rad("a1"))!;
      expect((await kall("POST", `/api/org/${org}/banktransaksjoner/${a1.id}/koble`, { faktura_id: a1.faktura_id })).data.status).toBe("koblet");
    });

    it("går AI-en galt, blir innbetalingen uavklart, og etter to feil spør workeren ikke mer", async () => {
      transaksjoner = [inn("b1", 300, "A", "x"), inn("b2", 301, "B", "y"), inn("b3", 302, "C", "z")];
      let n = 0;
      modell = () => {
        n++;
        return json(500, { error: { message: "Internal" } });
      };
      expect(await hentInnbetalinger(org)).toEqual({ nye: 3, koblet: 0, forslag: 0 });
      expect(n).toBe(4); // to innbetalinger, hver prøvd to ganger
      expect((await rad("b3"))!.status).toBe("uavklart");
    });

    it("AI slått av: workeren spør ikke", async () => {
      expect((await kall("PATCH", `/api/org/${org}`, { ai_aktiv: false })).status).toBe(200);
      transaksjoner = [inn("c1", 555, "D", "w")];
      const n = foresporsler.length;
      expect(await hentInnbetalinger(org)).toEqual({ nye: 1, koblet: 0, forslag: 0 });
      expect(foresporsler.length).toBe(n);
      expect((await kall("PATCH", `/api/org/${org}`, { ai_aktiv: true })).status).toBe(200);
    });

    it("brukeren ber om et forslag for en uavklart innbetaling", async () => {
      const a3 = (await rad("a3"))!;
      modell = (f) => {
        const nr = tekstIForesporsel(f).match(/(F\d+): faktura \d+ \| Fjordline Logistikk AS/)![1];
        return svar({ faktura: nr, sikkerhet: "lav", grunn: "Beløpet er nesten det samme som transportfakturaen." });
      };
      expect((await kall("POST", `/api/org/${org}/banktransaksjoner/${a3.id}/ai`, undefined, leser)).status).toBe(403);
      const r = await kall("POST", `/api/org/${org}/banktransaksjoner/${a3.id}/ai`);
      expect(r.status).toBe(200);
      expect(r.data.grunn).toBe("AI (usikker): Beløpet er nesten det samme som transportfakturaen.");
      expect(r.data.transaksjon).toMatchObject({ id: a3.id, status: "forslag", faktura_id: fakturaer[2] });
      expect((await kall("POST", `/api/org/${org}/banktransaksjoner/${a3.id}/ai`)).data.error).toBe("Innbetalingen er allerede behandlet");

      // Ingen faktura passer: forklaringen kommer tilbake, og ingenting endres.
      const a2 = (await rad("a2"))!;
      modell = () => svar({ faktura: null, sikkerhet: "lav", grunn: "Ser ut som et loddsalg, ikke en faktura." });
      expect((await kall("POST", `/api/org/${org}/banktransaksjoner/${a2.id}/ai`)).data).toEqual({ transaksjon: null, grunn: "Ser ut som et loddsalg, ikke en faktura." });
      expect((await rad("a2"))!.status).toBe("uavklart");
    });
  });
});
