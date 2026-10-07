// AI-assistenten (falske svar fra Gemini): ny faktura, utkast, sende på nytt, betaling,
// purring, utestående, åpne sider, tilgang, lyd og samtalen før. Forslagene utføres med de
// vanlige rutene, som i appen.
import { beforeAll, describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { lagApi } from "../src/api.js";
import { alle, en, somSystem } from "../src/db.js";
import { settAi } from "../src/ai.js";
import { settLokalOppgavekjorer } from "../src/tjenester.js";
import type { AiKommando } from "../src/aiAssistent.js";

type Foresporsel = { kropp: any; tekst: string };
const foresporsler: Foresporsel[] = [];
let neste: Partial<AiKommando> = {};
const kommando = (k: Partial<AiKommando>): AiKommando => ({
  transkripsjon: null, handling: "annet", kunde: null, kunde_navn: null, betaler: null, fakturanumre: [], alle_forfalte: false, belop: null,
  dato: null, send: false, side: "ingen", linjer: [], fakturadato: null, forfallsdato: null, periode_fra: null, periode_til: null,
  deres_referanse: null, kommentar: null, svar: null, merknader: [], ...k,
});
const dag = (n = 0) => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Oslo" }).format(new Date(Date.now() + n * 86400_000));
const norsk = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}`;

describe.skipIf(!process.env.DATABASE_URL)("AI-assistenten", () => {
  const app = lagApi();
  const eier = "Bearer test:uid-assistent-eier:assistent-eier@server.test:mfa";
  const leser = "Bearer test:uid-assistent-les:assistent-les@server.test:mfa";
  let org: string;
  let kari: string;
  let fjord: string;
  let leie: string;
  let time: string;
  const nr: Record<string, { id: string; nummer: number }> = {};
  let utkastId: string;

  const kall = async (m: string, sti: string, k?: unknown, hvem = eier) => {
    const r = await app.request(sti, { method: m, headers: { authorization: hvem, "content-type": "application/json" }, body: k === undefined ? undefined : JSON.stringify(k) });
    return { status: r.status, data: (r.headers.get("content-type") ?? "").includes("json") ? ((await r.json()) as any) : null };
  };
  const spor = async (k: Partial<AiKommando>, kropp: Record<string, unknown> = { tekst: "kommando" }, hvem = eier) => {
    neste = k;
    const r = await kall("POST", `/api/org/${org}/ai/assistent`, kropp, hvem);
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    return r.data;
  };
  const faktura = async (kunde: string, linjer: unknown[], datoer: { fakturadato?: string; forfallsdato?: string } = {}) => {
    const f = (await kall("POST", `/api/org/${org}/fakturaer`, { kunde_id: kunde, linjer, ...datoer })).data;
    const u = await kall("POST", `/api/org/${org}/fakturaer/${f.id}/utsted`, { send_epost: false });
    expect(u.status, JSON.stringify(u.data)).toBe(200);
    return { id: f.id as string, nummer: u.data.fakturanummer as number };
  };

  beforeAll(async () => {
    Object.assign(config, { aiProsjekt: "hi4-test", aiRegion: "europe-west3", aiModell: "gemini-3.5-flash", aiGrense: 1000 });
    settLokalOppgavekjorer(async () => undefined);
    settAi({
      token: async () => "test",
      fetch: async (_url, init) => {
        const kropp = JSON.parse(String(init?.body));
        foresporsler.push({ kropp, tekst: kropp.contents[0].parts.map((p: any) => p.text ?? "").join("\n") });
        return new Response(
          JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(kommando(neste)) }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 800, candidatesTokenCount: 40 } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });
    org = (await kall("POST", "/api/organisasjoner", { navn: "Assistent Utleie AS" })).data.id;
    expect((await kall("PATCH", `/api/org/${org}`, { kontonr: "86011117947", mva_registrert: true })).status).toBe(200);
    kari = (await kall("POST", `/api/org/${org}/kunder`, { navn: "Kari Hansen", type: "person", epost: "kari@hansen.no" })).data.id;
    fjord = (await kall("POST", `/api/org/${org}/kunder`, { navn: "Fjordline Logistikk AS", epost: "faktura@fjordline.no" })).data.id;
    await kall("POST", `/api/org/${org}/kunder`, { navn: "Per Olsen", type: "person" });
    leie = (await kall("POST", `/api/org/${org}/produkter`, { navn: "Husleie", enhet: "mnd", enhetspris: 8000, mva_sats: 0 })).data.id;
    time = (await kall("POST", `/api/org/${org}/produkter`, { navn: "Konsulenttime", enhet: "time", enhetspris: 1200, mva_sats: 25 })).data.id;
    const husleie = [{ produkt_id: leie, beskrivelse: "Husleie", antall: 1, enhet: "mnd", enhetspris: 8000, mva_sats: 0 }];
    // 1: forfalt for 26 dager siden. 2: betalt. 3: ikke forfalt.
    nr.forfalt = await faktura(kari, husleie, { fakturadato: dag(-40), forfallsdato: dag(-26) });
    nr.betalt = await faktura(kari, husleie, { fakturadato: dag(-70), forfallsdato: dag(-56) });
    expect((await kall("POST", `/api/org/${org}/fakturaer/${nr.betalt.id}/betalinger`, { belop: 8000, dato: dag(-50) })).status).toBe(200);
    nr.fersk = await faktura(fjord, [{ produkt_id: time, beskrivelse: "Konsulenttime", antall: 2, enhet: "time", enhetspris: 1200, mva_sats: 25 }]);
    utkastId = (await kall("POST", `/api/org/${org}/fakturaer`, { kunde_id: fjord, linjer: [{ beskrivelse: "Transport", antall: 1, enhetspris: 400, mva_sats: 25 }] })).data.id;
    // En innbetaling fra noen som ikke er kunde, som ikke er koblet.
    await somSystem((db) =>
      db.query("insert into faktura.banktransaksjoner (org_id, konto, ekstern_id, dato, belop, betaler, melding) values ($1, '86011117947', 'a1', $2, 1500, 'OLSEN PER', 'depositum')", [
        org,
        dag(-1),
      ]),
    );
    const inv = await kall("POST", `/api/org/${org}/invitasjoner`, { epost: "assistent-les@server.test", rolle: "les" });
    expect((await kall("POST", "/api/invitasjoner/aksepter", { token: inv.data.lenke.split("/").pop() }, leser)).status).toBe(200);
  });

  it("sender kommandoen med registrene, dagens dato og samtalen før", async () => {
    const svar = await spor(
      { handling: "annet", svar: "Jeg kan lage og sende fakturaer, sjekke betalinger og sende purringer." },
      { tekst: "Hva kan du?", historikk: [{ rolle: "bruker", tekst: "Har Kari betalt?" }, { rolle: "assistent", tekst: "Faktura 1 er ikke betalt." }] },
    );
    expect(svar).toEqual({
      transkripsjon: null,
      tekst: "Jeg kan lage og sende fakturaer, sjekke betalinger og sende purringer.",
      forslag: [],
      lenker: [],
      gaa_til: null,
      utkast: null,
    });
    const f = foresporsler.at(-1)!;
    expect(f.kropp.systemInstruction.parts[0].text).toContain(`Dagens dato er ${dag()}`);
    expect(f.kropp.generationConfig.responseSchema.properties.handling.enum).toContain("registrer_betaling");
    expect(f.tekst).toContain("K2: Kari Hansen");
    expect(f.tekst).toContain("P1: Husleie | 8 000 kr per mnd eks. mva | 0 % mva");
    expect(f.tekst).toContain("Samtalen så langt:\nBrukeren: Har Kari betalt?\nAssistenten: Faktura 1 er ikke betalt.");
    expect(f.tekst).toContain("Kommandoen:\nHva kan du?");
  });

  it("lager en faktura som kan sendes med ett trykk", async () => {
    const svar = await spor({
      handling: "ny_faktura",
      send: true,
      kunde: "K2",
      linjer: [{ produkt: "P1", beskrivelse: "Husleie november", antall: 1, enhet: "mnd", enhetspris: null, pris_inkl_mva: false, mva_sats: 0, rabatt_prosent: null }],
      periode_fra: "2026-11-01",
      periode_til: "2026-11-30",
      forfallsdato: dag(20),
    });
    expect(svar.tekst).toBe(`Faktura til Kari Hansen: Husleie november. Å betale 8 000,00 kr, forfall ${norsk(dag(20))}. Periode 01.11.2026–30.11.2026.`);
    expect(svar.forslag).toEqual([{ type: "ny_faktura", send: true, gebyr: false, utkast: svar.utkast, tekst: "Sendes på e-post til kari@hansen.no.", knapp: "Send faktura" }]);
    expect(svar.utkast).toMatchObject({ kunde_id: kari, linjer: [{ produkt_id: leie, enhetspris: 8000, mva_sats: 0 }] });
    // Appen utfører forslaget med de vanlige rutene.
    const u = svar.utkast;
    const f = (await kall("POST", `/api/org/${org}/fakturaer`, { kunde_id: u.kunde_id, forfallsdato: u.forfallsdato, periode_fra: u.periode_fra, periode_til: u.periode_til, linjer: u.linjer })).data;
    const sendt = await kall("POST", `/api/org/${org}/fakturaer/${f.id}/utsted`, { send_epost: true });
    expect(sendt.data).toMatchObject({ status: "utstedt", sum_inkl_mva: 8000, forfallsdato: dag(20) });
    nr.ny = { id: f.id, nummer: sendt.data.fakturanummer };
  });

  it("en ny faktura uten kunde eller pris kan åpnes i skjemaet", async () => {
    const svar = await spor({
      handling: "ny_faktura",
      send: true,
      kunde_navn: "Ola Nordmann",
      linjer: [{ produkt: null, beskrivelse: "Vask", antall: 2, enhet: "time", enhetspris: null, pris_inkl_mva: false, mva_sats: 25, rabatt_prosent: null }],
    });
    expect(svar.tekst).toBe("Fant ikke «Ola Nordmann» i kunderegisteret. Prisen mangler for «Vask». Åpne skjemaet for å fylle ut resten.");
    expect(svar.forslag).toEqual([]);
    expect(svar.utkast).toMatchObject({ kunde_id: null, kunde_navn: "Ola Nordmann", linjer: [{ beskrivelse: "Vask", enhetspris: null }] });
  });

  it("svarer om kunden har betalt, og tilbyr purring på det som har forfalt", async () => {
    // Kundelisten er sortert etter siste faktura, så her brukes navnet.
    const svar = await spor({ handling: "sjekk_betaling", kunde_navn: "Kari Hansen" });
    expect(svar.tekst).toBe(
      `Kari Hansen har 2 ubetalte fakturaer på til sammen 16 000,00 kr. ` +
        `Faktura ${nr.forfalt.nummer} (8 000,00 kr) er ikke betalt, forfalt ${norsk(dag(-26))}. ` +
        `Faktura ${nr.ny.nummer} (8 000,00 kr) er ikke betalt, forfall ${norsk(dag(20))}. ` +
        `Faktura ${nr.betalt.nummer} (8 000,00 kr) er betalt ${norsk(dag(-50))}.`,
    );
    expect(svar.forslag).toEqual([
      {
        type: "purring",
        faktura_id: nr.forfalt.id,
        fakturanummer: nr.forfalt.nummer,
        purring: "paaminnelse",
        tekst: `Betalingspåminnelse på faktura ${nr.forfalt.nummer} til Kari Hansen: 8 000,00 kr, forfalt ${norsk(dag(-26))}.`,
        knapp: "Send påminnelse",
      },
    ]);
    expect(svar.lenker[0]).toEqual({ tekst: `Faktura ${nr.forfalt.nummer}`, til: `/fakturaer/${nr.forfalt.id}` });
    // Med fakturanummer.
    expect((await spor({ handling: "sjekk_betaling", fakturanumre: [nr.betalt.nummer] })).tekst).toBe(`Faktura ${nr.betalt.nummer} (8 000,00 kr) er betalt ${norsk(dag(-50))}.`);
    expect((await spor({ handling: "sjekk_betaling", fakturanumre: [999] })).tekst).toBe("Fant ikke faktura 999.");
  });

  it("finner innbetalinger fra noen som ikke er kunde, og de siste betalingene", async () => {
    const svar = await spor({ handling: "sjekk_betaling", betaler: "Per Olsen" });
    expect(svar.tekst).toBe(`Det har kommet 1 500,00 kr fra OLSEN PER ${norsk(dag(-1))} som ikke er registrert på en faktura («depositum»).`);
    expect(svar.lenker).toEqual([{ tekst: "Innbetalinger", til: "/innbetalinger" }]);
    const siste = await spor({ handling: "sjekk_betaling" });
    expect(siste.tekst).toBe("Det er ikke registrert noen betalinger de siste sju dagene. 1 innbetaling fra banken er ikke registrert på en faktura ennå.");
  });

  it("foreslår å registrere en betaling, og sier fra om beløp og dato", async () => {
    const svar = await spor({ handling: "registrer_betaling", fakturanumre: [nr.forfalt.nummer], belop: 5000, dato: dag(-1) });
    expect(svar.tekst).toBe("Skal jeg registrere betalingen?");
    expect(svar.forslag).toEqual([
      {
        type: "betaling",
        faktura_id: nr.forfalt.id,
        fakturanummer: nr.forfalt.nummer,
        belop: 5000,
        dato: dag(-1),
        tekst: `Registrer 5 000,00 kr betalt ${norsk(dag(-1))} på faktura ${nr.forfalt.nummer} (Kari Hansen). Da gjenstår 3 000,00 kr.`,
        knapp: "Registrer betaling",
      },
    ]);
    const fram = await spor({ handling: "registrer_betaling", fakturanumre: [nr.forfalt.nummer], dato: dag(3) });
    expect(fram.tekst).toBe("Betalingsdatoen kan ikke være fram i tid, så jeg bruker i dag.");
    expect(fram.forslag[0]).toMatchObject({ belop: 8000, dato: dag() });
    // Kunden har to ubetalte: beløpet avgjør, ellers velger brukeren.
    expect((await spor({ handling: "registrer_betaling", kunde_navn: "Kari Hansen" })).forslag).toHaveLength(2);
    expect((await spor({ handling: "registrer_betaling", fakturanumre: [nr.betalt.nummer] })).tekst).toBe(`Faktura ${nr.betalt.nummer} (8 000,00 kr) er betalt ${norsk(dag(-50))}.`);
    expect((await spor({ handling: "registrer_betaling", kunde_navn: "Ukjent Kunde" })).tekst).toBe("Fant ikke «Ukjent Kunde» i kunderegisteret.");
    // Utført med den vanlige ruten.
    const b = svar.forslag[0];
    expect((await kall("POST", `/api/org/${org}/fakturaer/${b.faktura_id}/betalinger`, { belop: b.belop, dato: b.dato, notat: "Registrert med AI-assistenten" })).status).toBe(200);
  });

  it("purrer det som har forfalt, og forklarer resten", async () => {
    const alle_ = await spor({ handling: "send_purring", alle_forfalte: true });
    expect(alle_.tekst).toBe("Skal jeg sende purringen?");
    expect(alle_.forslag).toEqual([expect.objectContaining({ type: "purring", faktura_id: nr.forfalt.id, purring: "paaminnelse", knapp: "Send påminnelse" })]);
    expect(alle_.forslag[0].tekst).toBe(`Betalingspåminnelse på faktura ${nr.forfalt.nummer} til Kari Hansen: 3 000,00 kr, forfalt ${norsk(dag(-26))}.`);
    const ikke = await spor({ handling: "send_purring", fakturanumre: [nr.fersk.nummer] });
    expect(ikke.forslag).toEqual([]);
    expect(ikke.tekst).toBe(`Faktura ${nr.fersk.nummer} har ikke forfalt ennå (forfall ${norsk(dag(14))}).`);
    // Utført, og da er fristen ikke ute for en ny.
    const p = alle_.forslag[0];
    expect((await kall("POST", `/api/org/${org}/fakturaer/${p.faktura_id}/purring`, { type: p.purring })).status).toBe(201);
    expect((await spor({ handling: "send_purring", fakturanumre: [nr.forfalt.nummer] })).tekst).toBe(
      `Fristen i forrige purring på faktura ${nr.forfalt.nummer} er ${norsk(dag(14))}.`,
    );
  });

  it("sender utkast og fakturaer på nytt", async () => {
    const u = await spor({ handling: "send_utkast", kunde_navn: "Fjordline Logistikk AS" });
    expect(u.tekst).toBe("Skal jeg sende utkastet?");
    expect(u.forslag).toEqual([{ type: "send_utkast", faktura_id: utkastId, tekst: `Utkast til Fjordline Logistikk AS: 500,00 kr (laget ${norsk(dag())}).`, knapp: "Send faktura" }]);
    expect((await spor({ handling: "send_utkast", kunde_navn: "Kari Hansen" })).tekst).toBe("Fant ingen utkast til Kari Hansen.");
    const igjen = await spor({ handling: "send_igjen", fakturanumre: [nr.fersk.nummer] });
    expect(igjen.forslag).toEqual([
      { type: "send_igjen", faktura_id: nr.fersk.id, fakturanummer: nr.fersk.nummer, tekst: `Send faktura ${nr.fersk.nummer} til Fjordline Logistikk AS på nytt (faktura@fjordline.no).`, knapp: "Send på nytt" },
    ]);
  });

  it("gir oversikt over utestående og åpner sider", async () => {
    const svar = await spor({ handling: "utestaende" });
    expect(svar.tekst).toBe(
      "Utestående er 14 000,00 kr på 3 fakturaer. 3 000,00 kr har forfalt (1 faktura). Mest: Kari Hansen 11 000,00 kr, Fjordline Logistikk AS 3 000,00 kr. " +
        "Si «send purring på alle forfalte» for å purre dem.",
    );
    expect(svar.lenker).toEqual([{ tekst: "Ubetalte fakturaer", til: "/fakturaer?status=utstedt" }, { tekst: "Reskontro", til: "/rapporter" }]);
    expect(await spor({ handling: "vis", side: "faktura", fakturanumre: [nr.fersk.nummer] })).toMatchObject({
      tekst: `Åpner faktura ${nr.fersk.nummer} til Fjordline Logistikk AS.`,
      gaa_til: `/fakturaer/${nr.fersk.id}`,
    });
    expect(await spor({ handling: "vis", side: "innbetalinger" })).toMatchObject({ tekst: "Åpner innbetalingene.", gaa_til: "/innbetalinger" });
  });

  it("med lesetilgang kan man spørre, men ikke registrere eller sende", async () => {
    expect((await spor({ handling: "registrer_betaling", fakturanumre: [nr.forfalt.nummer] }, undefined, leser)).tekst).toBe("Du har ikke tilgang til å registrere betalinger.");
    expect((await spor({ handling: "send_purring", alle_forfalte: true }, undefined, leser)).tekst).toBe("Du har ikke tilgang til å sende purringer.");
    expect((await spor({ handling: "ny_faktura", kunde_navn: "Kari Hansen" }, undefined, leser)).tekst).toBe("Du har ikke tilgang til å lage fakturaer.");
    const s = await spor({ handling: "sjekk_betaling", kunde_navn: "Fjordline Logistikk AS" }, undefined, leser);
    expect(s.tekst).toContain("Fjordline Logistikk AS har 1 ubetalt faktura");
    expect(s.forslag).toEqual([]); // ingen purring uten tilgang
  });

  it("tar med fakturagebyret i summen, som skjemaet", async () => {
    expect((await kall("PATCH", `/api/org/${org}`, { standard_gebyr: 50 })).status).toBe(200);
    const svar = await spor({
      handling: "ny_faktura",
      send: false,
      kunde_navn: "Fjordline Logistikk AS",
      linjer: [{ produkt: null, beskrivelse: "Transport", antall: 2, enhet: "stk", enhetspris: 1000, pris_inkl_mva: false, mva_sats: 25, rabatt_prosent: null }],
    });
    expect(svar.tekst).toBe(`Faktura til Fjordline Logistikk AS: Transport (2 stk). Å betale 2 562,50 kr inkl. mva og fakturagebyr på 50,00 kr, forfall ${norsk(dag(14))}.`);
    expect(svar.forslag).toEqual([expect.objectContaining({ type: "ny_faktura", send: false, gebyr: true, tekst: "Lagres som utkast du kan sende senere.", knapp: "Lagre utkast" })]);
    expect((await kall("PATCH", `/api/org/${org}`, { standard_gebyr: 0 })).status).toBe(200);
  });

  it("tar imot lyd og teller i taket for måneden", async () => {
    const lyd = Buffer.from(new Uint8Array(3000).map((_, i) => i % 199)).toString("base64");
    const svar = await spor({ handling: "vis", side: "utkast", transkripsjon: "Vis utkastene" }, { lyd: { data: lyd, type: "audio/webm;codecs=opus" } });
    expect(svar).toMatchObject({ transkripsjon: "Vis utkastene", gaa_til: "/fakturaer?status=utkast" });
    const del = foresporsler.at(-1)!.kropp.contents[0].parts.find((p: any) => p.inlineData);
    expect(del.inlineData).toEqual({ mimeType: "audio/webm", data: lyd });
    expect((await kall("POST", `/api/org/${org}/ai/assistent`, { lyd: { data: lyd, type: "audio/midi" } })).status).toBe(400);
    expect((await kall("POST", `/api/org/${org}/ai/assistent`, {})).data.error).toBe("Si eller skriv hva du vil gjøre");
    const bruk = await somSystem((db) => en(db, "select antall from faktura.ai_bruk where org_id = $1 and funksjon = 'assistent'", [org]));
    expect(bruk!.antall).toBe(foresporsler.length);
    expect(await somSystem((db) => alle(db, "select funksjon from faktura.ai_bruk where org_id = $1", [org]))).toEqual([{ funksjon: "assistent" }]);
  });
});
