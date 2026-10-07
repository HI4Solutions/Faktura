// Innbetalinger fra banken (Enable Banking): signerte forespørsler, tolkning av
// transaksjoner, reglene for å koble dem til fakturaer, og hele flyten fra tilkobling med
// BankID til innbetalinger som registreres, foreslås, angres og ignoreres, med flere banker
// (DNB og Storebrand) på samme applikasjon.
import { describe, expect, it, beforeAll } from "vitest";
import { generateKeyPairSync, verify } from "node:crypto";
import { config } from "../src/config.js";
import { lagApi } from "../src/api.js";
import { alle, en, somSystem } from "../src/db.js";
import { settKryptering } from "../src/kryptering.js";
import { lagJwt, nokkelFeil, normaliserPem, settBankFetch, tilInnbetalinger, velgBank, type Bank, type Innbetaling } from "../src/enableBanking.js";
import { finnFaktura, fullforBankOkt, hentInnbetalinger, lagBankAdresse, planleggBankhenting, sammeNavn, sisteHentetid, slettBankOkter, type ApenFaktura } from "../src/bank.js";
import { settLokalOppgavekjorer, type Oppgave } from "../src/tjenester.js";

const { privateKey: privat, publicKey: offentlig } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const APP = "8a5e1a0e-6b3c-4c1f-9a77-1b2c3d4e5f60";

describe("Enable Banking: signatur og transaksjoner", () => {
  it("lager en JWT signert med applikasjonens nøkkel", () => {
    const jwt = lagJwt({ appId: APP, privatNokkel: privat }, 1_800_000_000);
    const [h, i, s] = jwt.split(".");
    expect(JSON.parse(Buffer.from(h, "base64url").toString())).toEqual({ typ: "JWT", alg: "RS256", kid: APP });
    expect(JSON.parse(Buffer.from(i, "base64url").toString())).toEqual({ iss: "enablebanking.com", aud: "api.enablebanking.com", iat: 1_800_000_000, exp: 1_800_003_600 });
    expect(verify("RSA-SHA256", Buffer.from(`${h}.${i}`), offentlig, Buffer.from(s, "base64url"))).toBe(true);
  });

  it("tar med bokførte innbetalinger, ikke utbetalinger og reserverte", () => {
    const ut = tilInnbetalinger([
      { entry_reference: "e2", transaction_amount: { amount: "2500.00", currency: "NOK" }, credit_debit_indicator: "CRDT", status: "BOOK", booking_date: "2026-10-03", debtor: { name: "FJORDLINE" }, remittance_information: ["Faktura 2", "takk"] },
      { entry_reference: "e1", transaction_amount: { amount: "1000", currency: "NOK" }, credit_debit_indicator: "CRDT", status: "BOOK", booking_date: "2026-10-01", reference_number: "0100001" },
      { entry_reference: "u1", transaction_amount: { amount: "500", currency: "NOK" }, credit_debit_indicator: "DBIT", status: "BOOK", booking_date: "2026-10-02" },
      { entry_reference: "p1", transaction_amount: { amount: "700", currency: "NOK" }, credit_debit_indicator: "CRDT", status: "PDNG", booking_date: "2026-10-04" },
      // Uten id: fingeravtrykk, og to like samme dag holdes fra hverandre.
      { transaction_amount: { amount: "50", currency: "NOK" }, credit_debit_indicator: "CRDT", booking_date: "2026-10-05", debtor: { name: "Kiosk" } },
      { transaction_amount: { amount: "50", currency: "NOK" }, credit_debit_indicator: "CRDT", booking_date: "2026-10-05", debtor: { name: "Kiosk" } },
    ]);
    expect(ut.map((t) => [t.ekstern_id.startsWith("fp:") ? "fp" : t.ekstern_id, t.dato, t.belop])).toEqual([
      ["e1", "2026-10-01", 1000],
      ["e2", "2026-10-03", 2500],
      ["fp", "2026-10-05", 50],
      ["fp", "2026-10-05", 50],
    ]);
    expect(ut[1]).toMatchObject({ betaler: "FJORDLINE", melding: "Faktura 2 takk", valuta: "NOK" });
    expect(ut[0].referanse).toBe("0100001");
    expect(ut[2].ekstern_id).not.toBe(ut[3].ekstern_id);
  });

  it("gjør om en nøkkel limt inn på én linje til vanlig PEM", () => {
    const enLinje = privat.replace(/\n/g, "");
    expect(nokkelFeil(enLinje)).not.toBeNull();
    expect(normaliserPem(enLinje)).toBe(privat.trim());
    expect(nokkelFeil(normaliserPem(enLinje))).toBeNull();
    expect(normaliserPem(`  ${privat.replace(/\n/g, " \r\n ")}  `)).toBe(privat.trim());
    expect(normaliserPem("ikke en nøkkel ")).toBe("ikke en nøkkel");
  });

  it("finner banken med det nøyaktige navnet Enable Banking krever", () => {
    const banker: Bank[] = [
      { name: "DNB", country: "NO", psu_types: ["business", "personal"] },
      { name: "Storebrand Bank", country: "NO", psu_types: ["business", "personal"] },
      { name: "SpareBank 1 SR-Bank", country: "NO" },
      { name: "SpareBank 1 SMN", country: "NO" },
      { name: "Bare Privat", country: "NO", psu_types: ["personal"] },
    ];
    expect(velgBank(banker, "dnb", "business").name).toBe("DNB");
    expect(velgBank(banker, " Storebrand ", "business").name).toBe("Storebrand Bank");
    expect(velgBank(banker, "sparebank 1 smn", "business").name).toBe("SpareBank 1 SMN");
    expect(() => velgBank(banker, "SpareBank 1", "business")).toThrow("Flere banker passer med «SpareBank 1»: SpareBank 1 SR-Bank, SpareBank 1 SMN. Skriv hele navnet.");
    expect(() => velgBank(banker, "Bare Privat", "business")).toThrow("Bare Privat støtter ikke bedriftskontoer gjennom Enable Banking.");
    expect(velgBank(banker, "Bare Privat", "personal").name).toBe("Bare Privat");
    expect(() => velgBank(banker, "Sbanken", "business")).toThrow("Fant ikke banken «Sbanken» hos Enable Banking.");
  });
});

describe("kobling av innbetalinger til fakturaer", () => {
  const f = (fakturanummer: number, kunde: string, utestaende: number, ekstra: Partial<ApenFaktura> = {}): ApenFaktura => ({
    id: `f${fakturanummer}`,
    fakturanummer,
    kid: null,
    kunde,
    utestaende,
    forfallsdato: `2026-10-${String(10 + fakturanummer).padStart(2, "0")}`,
    ...ekstra,
  });
  const apne = [f(1041, "Kari Hansen", 1000), f(1042, "Fjordline Logistikk AS", 2500, { kid: "0100010420" }), f(1043, "Kari Hansen", 1000), f(2026, "Per Olsen", 14500)];
  const inn = (belop: number, betaler: string | null, melding: string | null, referanse: string | null = null): Innbetaling => ({
    ekstern_id: "x",
    dato: "2026-10-06",
    belop,
    valuta: "NOK",
    betaler,
    betaler_konto: null,
    melding,
    referanse,
  });

  it("sammenligner navn uten å bry seg om rekkefølge, store bokstaver, AS og æøå", () => {
    expect(sammeNavn("HANSEN KARI", "Kari Hansen")).toBe(true);
    expect(sammeNavn("FJORDLINE LOGISTIKK", "Fjordline Logistikk AS")).toBe(true);
    expect(sammeNavn("KARI HANSEN", "Kari Marie Hansen")).toBe(true);
    expect(sammeNavn("BJOERN AAS", "Bjørn Ås")).toBe(true);
    expect(sammeNavn("Per Olsen", "Kari Hansen")).toBe(false);
    expect(sammeNavn(null, "Kari Hansen")).toBe(false);
  });

  it("KID og fakturanummer registreres med en gang", () => {
    expect(finnFaktura(inn(2500, "Noen", null, "0100010420"), apne)).toEqual({ status: "koblet", faktura_id: "f1042", grunn: "KID 0100010420" });
    expect(finnFaktura(inn(1000, "Ukjent", "Faktura 1041"), apne)).toEqual({ status: "koblet", faktura_id: "f1041", grunn: "Fakturanummer 1041 i meldingen" });
    // Delbetaling med «nr» foran tallet.
    expect(finnFaktura(inn(400, "Ukjent", "fakt.nr 1043"), apne)).toEqual({ status: "koblet", faktura_id: "f1043", grunn: "Fakturanummer 1043 i meldingen (delbetaling)" });
    // Delbetaling uten merke, men fra kunden.
    expect(finnFaktura(inn(400, "HANSEN KARI", "1043"), apne).status).toBe("koblet");
  });

  it("et tall som bare ligner et fakturanummer, blir et forslag", () => {
    // «2026» er et årstall her: beløpet og betaleren stemmer ikke.
    expect(finnFaktura(inn(9000, "Fjordline Logistikk", "Husleie oktober 2026"), apne)).toEqual({
      status: "forslag",
      faktura_id: "f2026",
      grunn: "Fakturanummer 2026 i meldingen, men beløpet er 9 000,00 av 14 500,00",
    });
    expect(finnFaktura(inn(3000, "Fjordline", "Faktura 1042"), apne)).toMatchObject({ status: "forslag", faktura_id: "f1042" });
    expect(finnFaktura(inn(2000, null, "Faktura 1041 og 1043"), apne)).toEqual({ status: "uavklart", grunn: "Kan gjelde fakturaene 1041, 1043" });
  });

  it("samme beløp og betaler gir forslag om den eldste fakturaen", () => {
    expect(finnFaktura(inn(1000, "KARI HANSEN", "Husleie"), apne)).toEqual({ status: "forslag", faktura_id: "f1041", grunn: "Samme beløp og betaler (den eldste av 2 ubetalte)" });
    expect(finnFaktura(inn(2500, "Noen andre", null), apne)).toEqual({ status: "forslag", faktura_id: "f1042", grunn: "Samme beløp" });
    // Samme beløp på flere fakturaer og ukjent betaler: ingen gjetning.
    expect(finnFaktura(inn(1000, "Noen andre", null), apne)).toEqual({ status: "uavklart", grunn: null });
    expect(finnFaktura(inn(123, "Kari Hansen", null), apne)).toEqual({ status: "uavklart", grunn: null });
  });
});

type Kall = { metode: string; sti: string; auth: string | null; psu: string | null; kropp: any };

describe.skipIf(!process.env.DATABASE_URL)("innbetalinger fra banken", () => {
  const app = lagApi();
  const eier = "Bearer test:uid-bank:bank@server.test:mfa";
  const fremmed = "Bearer test:uid-bank-2:fremmed-bank@server.test:mfa";
  const ko: (Oppgave & { oppgave_id: string })[] = [];
  const kall: Kall[] = [];
  let svar: Record<string, (k: Kall) => Response> = {};
  let org: string;
  let dnbId: string;
  let sbId: string;
  let husleie: string;
  const fakturaer: Record<number, string> = {};
  const json = (status: number, data: unknown) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
  const dnb = { name: "DNB", country: "NO", psu_types: ["business", "personal"], maximum_consent_validity: 15552000 };
  const storebrand = { name: "Storebrand Bank", country: "NO", psu_types: ["business", "personal"], maximum_consent_validity: 7776000 };
  const dagerSiden = (n: number) => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Oslo" }).format(new Date(Date.now() - n * 86400_000));
  const dag = dagerSiden(0);

  const api = async (m: string, sti: string, k?: unknown, hvem = eier) => {
    const r = await app.request(sti, { method: m, headers: { authorization: hvem, "content-type": "application/json", "user-agent": "Testleser/1.0", "x-forwarded-for": "203.0.113.9" }, body: k === undefined ? undefined : JSON.stringify(k) });
    const type = r.headers.get("content-type") ?? "";
    return { status: r.status, data: type.includes("json") ? ((await r.json()) as any) : null };
  };
  const integrasjon = () => somSystem((db) => en(db, "select status, konfig, siste_feil, hemmelighet_kryptert from faktura.integrasjoner where org_id = $1 and type = 'bank'", [org]));
  const kobling = (id: string) => somSystem((db) => en(db, "select * from faktura.bankkoblinger where id = $1", [id]));
  const bankStatus = async () => (await api("GET", `/api/org/${org}/bank`)).data;
  const banken = async (id: string) => (await bankStatus()).koblinger.find((k: any) => k.id === id);
  const status = async (nr: number) => (await api("GET", `/api/org/${org}/fakturaer/${fakturaer[nr]}`)).data.status;
  const transaksjoner = () => somSystem((db) => alle(db, "select * from faktura.banktransaksjoner where org_id = $1 order by dato, belop, ekstern_id", [org]));
  const inn = (id: string, belop: number, debtor: string | null, melding?: string) => ({
    entry_reference: id,
    transaction_amount: { amount: belop.toFixed(2), currency: "NOK" },
    credit_debit_indicator: "CRDT",
    status: "BOOK",
    booking_date: dag,
    ...(debtor ? { debtor: { name: debtor } } : {}),
    ...(melding ? { remittance_information: [melding] } : {}),
  });

  beforeAll(async () => {
    (config as any).enableBankingUrl = "https://eb.test";
    settKryptering(async (t) => Buffer.from(`kryptert:${t}`), async (d) => d.toString().replace(/^kryptert:/, ""));
    settLokalOppgavekjorer(async (o) => void ko.push(o));
    settBankFetch(async (url, init) => {
      const u = new URL(String(url));
      const h = new Headers(init?.headers);
      const k: Kall = { metode: init?.method ?? "GET", sti: u.pathname + u.search, auth: h.get("authorization"), psu: h.get("psu-ip-address"), kropp: init?.body ? JSON.parse(String(init.body)) : null };
      kall.push(k);
      const nokkel = `${k.metode} ${u.pathname.replace(/\/accounts\/[^/]+\//, "/accounts/:uid/").replace(/\/sessions\/.+/, "/sessions/:id")}`;
      const f = svar[nokkel];
      if (!f) throw new Error(`Uventet kall til Enable Banking: ${nokkel}`);
      return f(k);
    });

    org = (await api("POST", "/api/organisasjoner", { navn: "Bank Test AS" })).data.id;
    expect((await api("PATCH", `/api/org/${org}`, { kontonr: "86011117947", mva_registrert: true })).status).toBe(200);
    // Organisasjonen er opprettet i dag; testene henter de siste 60 dagene (se «startdato» under).
    expect((await api("PUT", `/api/org/${org}/bank/fra`, { fra: "2026-01-01" })).status).toBe(200);
    const kari = (await api("POST", `/api/org/${org}/kunder`, { navn: "Kari Hansen", type: "person", epost: "kari@hansen.no" })).data.id;
    const fjord = (await api("POST", `/api/org/${org}/kunder`, { navn: "Fjordline Logistikk AS", epost: "faktura@fjordline.no" })).data.id;
    for (const [kunde, pris] of [[kari, 800], [fjord, 2000], [kari, 800]] as const) {
      const f = (await api("POST", `/api/org/${org}/fakturaer`, { kunde_id: kunde, linjer: [{ beskrivelse: "Husleie", antall: 1, enhet: "mnd", enhetspris: pris, mva_sats: 25 }] })).data;
      const u = await api("POST", `/api/org/${org}/fakturaer/${f.id}/utsted`, { send_epost: false });
      expect(u.status).toBe(200);
      fakturaer[u.data.fakturanummer] = f.id;
    }
    expect(Object.keys(fakturaer)).toEqual(["1", "2", "3"]);
  });

  it("kobler til: sjekker nøkkelen, applikasjonen og banken, og sender brukeren til BankID", async () => {
    expect(await bankStatus()).toMatchObject({ app: null, koblinger: [], tilkoblet: false });
    const kropp = { app_id: APP, privat_nokkel: privat, bank: "dnb", psu_type: "business" };
    expect((await api("PUT", `/api/org/${org}/bank`, { ...kropp, privat_nokkel: "-----BEGIN PRIVATE KEY-----\n" + "x".repeat(200) + "\n-----END PRIVATE KEY-----" })).data.error).toContain("Fant ingen gyldig privat nøkkel");

    svar["GET /application"] = () => json(401, { message: "Invalid JWT", error: "UNAUTHORIZED" });
    expect((await api("PUT", `/api/org/${org}/bank`, kropp)).data.error).toContain("Enable Banking godtok ikke nøkkelen");

    svar["GET /application"] = () => json(200, { name: "HI4 Faktura", redirect_urls: ["https://annen.no/tilbake"] });
    svar["GET /aspsps"] = () => json(200, { aspsps: [dnb, storebrand, { name: "Nordea", country: "NO" }] });
    expect((await api("PUT", `/api/org/${org}/bank`, kropp)).data.error).toBe(
      "Legg inn http://localhost:5173/bank/tilbake som «Allowed redirect URL» i applikasjonen hos Enable Banking, og prøv igjen.",
    );
    svar["GET /application"] = () => json(200, { name: "HI4 Faktura", redirect_urls: ["http://localhost:5173/bank/tilbake"] });
    expect((await api("PUT", `/api/org/${org}/bank`, { ...kropp, bank: "Sbanken" })).data.error).toBe("Fant ikke banken «Sbanken» hos Enable Banking.");
    expect((await api("PUT", `/api/org/${org}/bank`, kropp, fremmed)).status).toBe(403);
    expect(await integrasjon()).toBeUndefined();

    svar["POST /auth"] = () => json(200, { url: "https://bank.test/bankid?x=1", authorization_id: "a1" });
    // Nøkkelen limt inn i det skjulte feltet (én linje): lagres som vanlig PEM.
    const r = await api("PUT", `/api/org/${org}/bank`, { ...kropp, privat_nokkel: privat.replace(/\n/g, "") });
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ url: "https://bank.test/bankid?x=1", tilkoblet: false, app: { app_id: APP, app_navn: "HI4 Faktura" } });
    expect(r.data.koblinger).toHaveLength(1);
    expect(r.data.koblinger[0]).toMatchObject({ id: r.data.kobling_id, bank: "DNB", psu_type: "business", status: "venter", tilkoblet: false, kontoer: [] });
    dnbId = r.data.kobling_id;
    expect(JSON.stringify(r.data)).not.toContain("PRIVATE KEY");
    const auth = kall.at(-1)!;
    expect(auth.metode).toBe("POST");
    expect(auth.kropp).toMatchObject({ aspsp: { name: "DNB", country: "NO" }, psu_type: "business", redirect_url: "http://localhost:5173/bank/tilbake" });
    expect(auth.kropp.state).toMatch(new RegExp(`^${org}\\.`));
    const dager = (Date.parse(auth.kropp.access.valid_until) - Date.now()) / 86400_000;
    expect(dager).toBeGreaterThan(179);
    expect(dager).toBeLessThan(180);
    expect(JSON.parse(Buffer.from(auth.auth!.split(" ")[1].split(".")[0], "base64url").toString()).kid).toBe(APP);
    const i = await integrasjon();
    expect(i!.hemmelighet_kryptert.toString()).toBe(`kryptert:${privat.trim()}`);
    expect(i!.konfig).toEqual({ leverandor: "enablebanking", app_id: APP, app_navn: "HI4 Faktura" });
    expect((await kobling(dnbId))!.state).toBe(auth.kropp.state);
  });

  it("fullfører etter BankID: viser bare kontoen som er lagt inn i HI4 Faktura", async () => {
    expect((await api("POST", `/api/org/${org}/bank/fullfor`, { code: "kode-1", state: `${org}.feil-tilstand` })).status).toBe(400);
    const state = (await kobling(dnbId))!.state;
    const r = await api("POST", `/api/org/${org}/bank/fullfor`, { code: "kode-1", state });
    expect(r.status).toBe(202);
    expect(r.data).toEqual({ ok: true, kobling_id: dnbId, forrige: null });
    expect((await api("POST", `/api/org/${org}/bank/fullfor`, { code: "kode-1", state })).status).toBe(400); // engangs
    expect(ko.at(-1)).toMatchObject({ type: "bank-okt", org_id: org, kobling_id: dnbId, kode: "kode-1" });

    svar["POST /sessions"] = () =>
      json(200, {
        session_id: "s-1",
        access: { valid_until: "2027-04-04T10:00:00Z" },
        accounts: [
          { uid: "k-drift", account_id: { iban: "NO9386011117947" }, name: "Driftskonto", currency: "NOK" },
          { uid: "k-spare", account_id: { iban: "NO0215035656262" }, name: "Sparekonto", currency: "NOK" },
        ],
      });
    await fullforBankOkt(org, dnbId, "kode-1");
    expect(kall.at(-1)!.kropp).toEqual({ code: "kode-1" });
    const s = await bankStatus();
    expect(s.tilkoblet).toBe(true);
    expect(s.hentetider).toEqual(["06:00", "12:00", "18:00"]);
    expect(s.koblinger[0]).toMatchObject({ id: dnbId, bank: "DNB", tilkoblet: true, status: "aktiv", gyldig_til: "2027-04-04T10:00:00.000Z", siste_feil: null, auth_url: null });
    expect(s.koblinger[0].fullfort).toBeTruthy();
    // Organisasjonens kontonummer er lagt inn; sparekontoen er ikke det, og vises ikke.
    expect(s.koblinger[0].kontoer).toEqual([{ kontonr: "86011117947", navn: "Driftskonto" }]);
    expect(s.koblinger[0].andre_kontoer).toBe(1);
    expect(JSON.stringify(s)).not.toContain("15035656262");
    expect(ko.at(-1)).toMatchObject({ type: "bank-hent", org_id: org, kobling_id: dnbId });
  });

  it("henter innbetalinger: registrerer, foreslår og lar resten stå uavklart", async () => {
    // Side 2 (continuation_key) har resten.
    svar["GET /accounts/:uid/transactions"] = (k) =>
      !k.sti.includes("k-drift")
        ? json(500, { message: "Feil konto" })
        : k.sti.includes("continuation_key=side-2")
          ? json(200, { transactions: [inn("t3", 1000, "KARI HANSEN")] })
          : json(200, {
              transactions: [
                inn("t1", 1000, "HANSEN KARI", "Faktura 1"),
                inn("t2", 2500, "FJORDLINE LOGISTIKK AS", "Betaling"),
                inn("t4", 99, "Ukjent"),
                { entry_reference: "t5", transaction_amount: { amount: "500.00", currency: "NOK" }, credit_debit_indicator: "DBIT", status: "BOOK", booking_date: dag },
              ],
              continuation_key: "side-2",
            });

    expect(await hentInnbetalinger(org)).toEqual({ nye: 4, koblet: 1, forslag: 2 });
    // Bare driftskontoen leses, de siste 60 dagene første gang.
    expect(kall.filter((k) => k.sti.startsWith("/accounts/")).every((k) => k.sti.startsWith("/accounts/k-drift/") && k.psu === null)).toBe(true);
    expect(kall.find((k) => k.sti.startsWith("/accounts/k-drift/"))!.sti).toBe(`/accounts/k-drift/transactions?date_from=${dagerSiden(60)}`);
    const t = await transaksjoner();
    expect(t.map((x: any) => [x.ekstern_id, x.konto, x.status, x.faktura_id && Object.entries(fakturaer).find(([, id]) => id === x.faktura_id)![0], x.grunn])).toEqual([
      ["t4", "86011117947", "uavklart", null, null],
      ["t1", "86011117947", "koblet", "1", "Fakturanummer 1 i meldingen"],
      ["t3", "86011117947", "forslag", "3", "Samme beløp og betaler"],
      ["t2", "86011117947", "forslag", "2", "Samme beløp og betaler"],
    ]);
    expect(await status(1)).toBe("betalt");
    const betaling = await somSystem((db) => en(db, "select kilde, notat, belop from faktura.betalinger where faktura_id = $1", [fakturaer[1]]));
    expect(betaling).toEqual({ kilde: "bank", notat: "Fra HANSEN KARI: Faktura 1", belop: 1000 });

    // Neste henting: ingenting nytt, og ingenting registreres to ganger.
    expect(await hentInnbetalinger(org)).toEqual({ nye: 0, koblet: 0, forslag: 0 });
    // Neste henting fra kontoen starter fem dager tilbake: banker kan bokføre noen dager etter.
    const k = (await kobling(dnbId))!;
    expect(k.kontoer.map((x: any) => [x.kontonr, x.hent_fra ?? null])).toEqual([
      ["86011117947", dagerSiden(5)],
      ["15035656262", null],
    ]);
    expect(k.sist_hentet).toBeTruthy();
  });

  it("brukeren bekrefter forslag, angrer, ignorerer og velger faktura selv", async () => {
    const liste = (await api("GET", `/api/org/${org}/banktransaksjoner`)).data;
    expect(liste.transaksjoner.map((x: any) => x.status).sort()).toEqual(["forslag", "forslag", "uavklart"]);
    expect(liste.antall).toEqual({ forslag: 2, uavklart: 1, koblet: 1, ignorert: 0 });
    const rader = await transaksjoner();
    const id = (ekstern: string) => rader.find((x: any) => x.ekstern_id === ekstern)!.id;

    // Bekreft forslaget for Fjordline.
    expect((await api("POST", `/api/org/${org}/banktransaksjoner/${id("t2")}/koble`, { faktura_id: fakturaer[2] })).data.status).toBe("koblet");
    expect(await status(2)).toBe("betalt");
    // Angre den automatiske registreringen: faktura 1 er ubetalt igjen.
    expect((await api("POST", `/api/org/${org}/banktransaksjoner/${id("t1")}/angre`)).data.status).toBe("uavklart");
    expect(await status(1)).toBe("utstedt");
    // Avvis forslaget for faktura 3, og koble innbetalingen til faktura 1 i stedet.
    expect((await api("POST", `/api/org/${org}/banktransaksjoner/${id("t3")}/angre`)).data).toMatchObject({ status: "uavklart", faktura_id: null });
    expect((await api("POST", `/api/org/${org}/banktransaksjoner/${id("t3")}/koble`, { faktura_id: fakturaer[1] })).data).toMatchObject({ status: "koblet", grunn: "Koblet for hånd" });
    expect(await status(1)).toBe("betalt");
    // Ignorer den ukjente.
    expect((await api("POST", `/api/org/${org}/banktransaksjoner/${id("t4")}/ignorer`, {})).data.status).toBe("ignorert");
    expect((await api("GET", `/api/org/${org}/banktransaksjoner?status=ignorert`)).data.transaksjoner).toHaveLength(1);
    // Andre ser og endrer ingenting.
    expect((await api("GET", `/api/org/${org}/banktransaksjoner`, undefined, fremmed)).status).toBe(403);
    expect((await api("POST", `/api/org/${org}/banktransaksjoner/${id("t1")}/koble`, { faktura_id: fakturaer[3] }, fremmed)).status).toBe(403);
    expect((await api("GET", `/api/org/${org}/bank`, undefined, fremmed)).status).toBe(403);
  });

  it("legger til en bank til (Storebrand) med samme applikasjon", async () => {
    const ny = { bank: "Storebrand", psu_type: "business" };
    expect((await api("POST", `/api/org/${org}/bank/koblinger`, ny, fremmed)).status).toBe(403);
    const r = await api("POST", `/api/org/${org}/bank/koblinger`, ny);
    expect(r.status).toBe(202);
    expect(r.data).toMatchObject({ ok: true, ny: true });
    sbId = r.data.kobling_id;
    expect(ko.at(-1)).toMatchObject({ type: "bank-auth", org_id: org, kobling_id: sbId });
    expect(await banken(sbId)).toMatchObject({ bank: "Storebrand", status: "venter", tilkoblet: false, auth_url: null, siste_feil: null });

    // Workeren finner det nøyaktige navnet og lager BankID-adressen.
    svar["POST /auth"] = () => json(200, { url: "https://storebrand.test/bankid" });
    await lagBankAdresse(org, sbId);
    const auth = kall.at(-1)!;
    expect(kall.at(-2)!.sti).toBe("/aspsps?country=NO");
    expect(auth.kropp).toMatchObject({ aspsp: { name: "Storebrand Bank", country: "NO" }, psu_type: "business" });
    const dager = (Date.parse(auth.kropp.access.valid_until) - Date.now()) / 86400_000;
    expect(dager).toBeGreaterThan(89);
    expect(dager).toBeLessThan(90);
    expect(await banken(sbId)).toMatchObject({ bank: "Storebrand Bank", status: "venter", auth_url: "https://storebrand.test/bankid", siste_feil: null });

    // Samme bank igjen: den som finnes, brukes.
    expect((await api("POST", `/api/org/${org}/bank/koblinger`, { bank: "storebrand bank", psu_type: "business" })).data).toMatchObject({ kobling_id: sbId, ny: false });
    await lagBankAdresse(org, sbId);

    const state = (await kobling(sbId))!.state;
    expect((await api("POST", `/api/org/${org}/bank/fullfor`, { code: "kode-sb", state })).data).toEqual({ ok: true, kobling_id: sbId, forrige: null });
    svar["POST /sessions"] = () =>
      json(200, { session_id: "s-sb", access: { valid_until: "2027-01-04T10:00:00Z" }, accounts: [{ uid: "k-husleie", account_id: { iban: "NO2895300000003" }, name: "Brukskonto" }] });
    await fullforBankOkt(org, sbId, "kode-sb");
    const s = await bankStatus();
    expect(s.koblinger.map((k: any) => [k.bank, k.status, k.tilkoblet])).toEqual([
      ["DNB", "aktiv", true],
      ["Storebrand Bank", "aktiv", true],
    ]);
    expect(ko.at(-1)).toMatchObject({ type: "bank-hent", org_id: org, kobling_id: sbId });
    // Husleiekontoen er ikke lagt inn i HI4 Faktura ennå: den vises ikke, og ingenting hentes.
    expect(s.koblinger[1]).toMatchObject({ kontoer: [], andre_kontoer: 1 });
    svar["GET /accounts/:uid/transactions"] = (k) =>
      k.sti.startsWith("/accounts/k-husleie/") ? json(200, { transactions: [inn("sb1", 1000, "KARI HANSEN", "Husleie faktura 3")] }) : json(200, { transactions: [] });
    const for0 = kall.length;
    expect(await hentInnbetalinger(org, { koblingId: sbId })).toEqual({ nye: 0, koblet: 0, forslag: 0 });
    expect(kall.length).toBe(for0);

    // Lagt inn under Flere kontonumre: vises med navnet derfra og leses uten ny BankID, de
    // siste 60 dagene. Husleien betaler faktura 3.
    husleie = (await api("POST", `/api/org/${org}/kontoer`, { navn: "Husleiekonto", kontonr: "9530.00.00003" })).data.id;
    expect(await banken(sbId)).toMatchObject({ kontoer: [{ kontonr: "95300000003", navn: "Husleiekonto" }], andre_kontoer: 0 });
    const for_ = kall.length;
    expect(await hentInnbetalinger(org, { koblingId: sbId })).toEqual({ nye: 1, koblet: 1, forslag: 0 });
    expect(kall.slice(for_).map((k) => k.sti)).toEqual([`/accounts/k-husleie/transactions?date_from=${dagerSiden(60)}`]);
    expect(await status(3)).toBe("betalt");
    expect((await transaksjoner()).find((x: any) => x.ekstern_id === "sb1")).toMatchObject({ konto: "95300000003", status: "koblet" });

    // Uten kobling_id hentes fra begge bankene.
    const for2 = kall.length;
    expect(await hentInnbetalinger(org)).toEqual({ nye: 0, koblet: 0, forslag: 0 });
    expect(kall.slice(for2).map((k) => k.sti.split("?")[0])).toEqual(["/accounts/k-drift/transactions", "/accounts/k-husleie/transactions"]);
  });

  it("en bank som ikke finnes, gir en forklaring", async () => {
    const r = await api("POST", `/api/org/${org}/bank/koblinger`, { bank: "Sbanken", psu_type: "business" });
    await lagBankAdresse(org, r.data.kobling_id);
    expect(await banken(r.data.kobling_id)).toMatchObject({ status: "venter", auth_url: null, siste_feil: "Kunne ikke starte BankID: Fant ikke banken «Sbanken» hos Enable Banking." });
    expect((await api("DELETE", `/api/org/${org}/bank/koblinger/${r.data.kobling_id}`)).status).toBe(204);
    expect(ko.at(-1)).not.toMatchObject({ type: "bank-slett", kobling_id: r.data.kobling_id }); // ingen økt å avslutte
    // «Storebrand» igjen når «Storebrand Bank» finnes: samme bank.
    const igjen = await api("POST", `/api/org/${org}/bank/koblinger`, { bank: "Storebrand", psu_type: "business" });
    await lagBankAdresse(org, igjen.data.kobling_id);
    expect((await banken(igjen.data.kobling_id)).siste_feil).toBe("Kunne ikke starte BankID: Banken er allerede lagt til. Forny tilgangen på den i stedet.");
    expect((await api("DELETE", `/api/org/${org}/bank/koblinger/${igjen.data.kobling_id}`)).status).toBe(204);
    expect((await bankStatus()).koblinger).toHaveLength(2);
  });

  it("«Hent nå» sender med at brukeren er til stede", async () => {
    expect((await api("POST", `/api/org/${org}/bank/hent`)).status).toBe(202);
    const o = ko.at(-1) as any;
    expect(o).toMatchObject({ type: "bank-hent", org_id: org, psu: { ip: "203.0.113.9", agent: "Testleser/1.0" } });
    expect(o.kobling_id).toBeUndefined();
    // Kontoer fra før appen leste kontoene som er lagt inn (valgt, med koblingens dato)
    // hentes fra koblingens dato.
    await somSystem((db) =>
      db.query(
        `update faktura.bankkoblinger set hent_fra = '2026-09-20',
                kontoer = '[{"uid": "k-drift", "kontonr": "86011117947", "navn": "Driftskonto", "valgt": true},
                            {"uid": "k-spare", "kontonr": "15035656262", "navn": "Sparekonto", "valgt": false}]'
          where id = $1`,
        [dnbId],
      ),
    );
    const for_ = kall.length;
    await hentInnbetalinger(org, { psu: o.psu });
    expect(kall.slice(for_).map((k) => [k.sti, k.psu])).toEqual([
      ["/accounts/k-drift/transactions?date_from=2026-09-20", "203.0.113.9"],
      [`/accounts/k-husleie/transactions?date_from=${dagerSiden(5)}`, "203.0.113.9"],
    ]);
    expect((await kobling(dnbId))!.kontoer[0]).toMatchObject({ kontonr: "86011117947", hent_fra: dagerSiden(5) });
  });

  it("hentetidene følger norsk tid, også vintertid", () => {
    expect(sisteHentetid(new Date("2026-10-06T03:59:00Z"))).toBeNull(); // 05:59 (sommertid)
    expect(sisteHentetid(new Date("2026-10-06T04:00:00Z"))!.toISOString()).toBe("2026-10-06T04:00:00.000Z"); // 06:00
    expect(sisteHentetid(new Date("2026-10-06T15:59:00Z"))!.toISOString()).toBe("2026-10-06T10:00:00.000Z"); // 17:59 → 12:00
    expect(sisteHentetid(new Date("2026-12-01T11:30:00Z"))!.toISOString()).toBe("2026-12-01T11:00:00.000Z"); // 12:30 (vintertid) → 12:00
    expect(sisteHentetid(new Date("2026-12-01T22:30:00Z"))!.toISOString()).toBe("2026-12-01T17:00:00.000Z"); // 23:30 → 18:00
    expect(sisteHentetid(new Date("2026-12-01T23:30:00Z"))).toBeNull(); // 00:30 neste dag
  });

  it("henter på de faste hentetidene, én gang per hentetid og bank", async () => {
    const natt = new Date("2026-10-06T01:00:00Z"); // 03:00 i Oslo
    const middag = new Date("2026-10-06T10:00:00Z"); // 12:00 i Oslo
    const kveld = new Date("2026-10-06T16:00:00Z"); // 18:00 i Oslo
    const lagt = (fra: number) => ko.slice(fra).filter((o: any) => o.type === "bank-hent" && o.org_id === org).map((o: any) => o.kobling_id).sort();
    const nullstill = () => somSystem((db) => db.query("update faktura.bankkoblinger set sist_hentet = '2026-01-01T00:00:00Z' where org_id = $1", [org]));
    // En bank uten noen konto som er lagt inn i HI4 Faktura, har ingenting å hente.
    expect((await api("DELETE", `/api/org/${org}/kontoer/${husleie}`)).status).toBe(204);
    await nullstill();
    let fra = ko.length;
    await planleggBankhenting(middag);
    expect(lagt(fra)).toEqual([dnbId]);
    husleie = (await api("POST", `/api/org/${org}/kontoer`, { navn: "Husleiekonto", kontonr: "95300000003" })).data.id;

    // Om natten hentes ingenting; på hentetiden hentes hver bank én gang, også når to
    // kjøringer går samtidig.
    await nullstill();
    fra = ko.length;
    expect(await planleggBankhenting(natt)).toBe(0);
    await Promise.all([planleggBankhenting(middag), planleggBankhenting(middag)]);
    expect(lagt(fra)).toEqual([dnbId, sbId].sort());
    expect(new Date((await kobling(dnbId))!.sist_hentet).getTime()).toBe(middag.getTime());
    // Resten av dagen fram til neste hentetid: ikke igjen.
    fra = ko.length;
    await planleggBankhenting(new Date(middag.getTime() + 3600_000));
    await planleggBankhenting(new Date(kveld.getTime() - 60_000));
    expect(lagt(fra)).toEqual([]);
    // «Hent nå» like etter klokka 18 tar hentetiden for den banken; den andre hentes.
    await somSystem((db) => db.query("update faktura.bankkoblinger set sist_hentet = $2 where id = $1", [dnbId, new Date(kveld.getTime() + 30_000).toISOString()]));
    await planleggBankhenting(new Date(kveld.getTime() + 60_000));
    expect(lagt(fra)).toEqual([sbId]);
    // En hentetid som ble gått glipp av (worker nede), tas igjen senere samme kveld.
    await somSystem((db) => db.query("update faktura.bankkoblinger set sist_hentet = $2 where id = $1", [sbId, middag.toISOString()]));
    fra = ko.length;
    await planleggBankhenting(new Date(kveld.getTime() + 4 * 3600_000)); // 22:00
    expect(lagt(fra)).toEqual([sbId]);

    // Samtykket til Storebrand går ut om tre dager: varsles én gang, og bare på dagtid.
    await somSystem((db) => db.query("update faktura.bankkoblinger set gyldig_til = '2026-10-09T10:00:00Z', varslet_utlop = null where id = $1", [sbId]));
    await planleggBankhenting(new Date(kveld.getTime() + 4 * 3600_000 + 60_000)); // 22:01
    expect((await kobling(sbId))!.varslet_utlop).toBeNull();
    await planleggBankhenting(middag);
    const varslet = (await kobling(sbId))!.varslet_utlop;
    expect(varslet).toBeTruthy();
    expect((await kobling(dnbId))!.varslet_utlop).toBeNull();
    await planleggBankhenting(new Date(middag.getTime() + 7200_000));
    expect((await kobling(sbId))!.varslet_utlop).toEqual(varslet);
  });

  it("utløpt samtykke i én bank: den får feil, den andre hentes som før, og fornyelse gir ny økt", async () => {
    svar["GET /accounts/:uid/transactions"] = (k) =>
      k.sti.startsWith("/accounts/k-drift/") ? json(401, { message: "Session expired", error: "EXPIRED_SESSION" }) : json(200, { transactions: [] });
    await hentInnbetalinger(org);
    let s = await bankStatus();
    expect(s.tilkoblet).toBe(true);
    expect(s.koblinger.find((k: any) => k.id === dnbId)).toMatchObject({
      tilkoblet: false,
      status: "feil",
      siste_feil: "Tilgangen til banken har gått ut eller er trukket tilbake. Koble til banken på nytt.",
    });
    expect(s.koblinger.find((k: any) => k.id === sbId)).toMatchObject({ tilkoblet: true, status: "aktiv", siste_feil: null });

    expect((await api("POST", `/api/org/${org}/bank/koblinger/${dnbId}/forny`, undefined, fremmed)).status).toBe(403);
    expect((await api("POST", `/api/org/${org}/bank/koblinger/${dnbId}/forny`)).status).toBe(202);
    expect(ko.at(-1)).toMatchObject({ type: "bank-auth", org_id: org, kobling_id: dnbId });
    expect(await banken(dnbId)).toMatchObject({ siste_feil: null, auth_url: null });
    svar["POST /auth"] = () => json(200, { url: "https://bank.test/bankid?x=2" });
    const for_ = kall.length;
    await lagBankAdresse(org, dnbId);
    // Banken er kjent fra før: rett til BankID.
    expect(kall.slice(for_).map((k) => `${k.metode} ${k.sti}`)).toEqual(["POST /auth"]);
    expect(kall.at(-1)!.kropp.aspsp).toEqual({ name: "DNB", country: "NO" });
    expect((await banken(dnbId)).auth_url).toBe("https://bank.test/bankid?x=2");

    const forrige = (await banken(dnbId)).fullfort;
    const state = (await kobling(dnbId))!.state;
    expect((await api("POST", `/api/org/${org}/bank/fullfor`, { code: "kode-2", state })).data).toEqual({ ok: true, kobling_id: dnbId, forrige });
    svar["POST /sessions"] = () => json(200, { session_id: "s-2", accounts: [{ uid: "k-drift-2", account_id: { iban: "NO9386011117947" }, name: "Driftskonto" }] });
    svar["DELETE /sessions/:id"] = () => new Response(null, { status: 204 });
    await fullforBankOkt(org, dnbId, "kode-2");
    // Den gamle økten avsluttes.
    expect(kall.some((k) => k.metode === "DELETE" && k.sti === "/sessions/s-1")).toBe(true);
    s = await bankStatus();
    const d = s.koblinger.find((k: any) => k.id === dnbId);
    expect(d).toMatchObject({ tilkoblet: true, status: "aktiv", siste_feil: null });
    expect(d.fullfort).not.toBe(forrige);
    // Uten utløpsdato fra banken: den som ble bedt om.
    expect(d.gyldig_til).toBe(new Date((await kobling(dnbId))!.auth_gyldig_til).toISOString());
    expect(d).toMatchObject({ kontoer: [{ kontonr: "86011117947", navn: "Driftskonto" }], andre_kontoer: 0 });
    // Hvor langt kontoen er hentet, følger kontonummeret over i den nye økten.
    expect((await kobling(dnbId))!.kontoer).toEqual([{ uid: "k-drift-2", kontonr: "86011117947", navn: "Driftskonto", hent_fra: dagerSiden(5) }]);
  });

  it("fjerner én bank: økten avsluttes, og den andre banken blir", async () => {
    expect((await api("DELETE", `/api/org/${org}/bank/koblinger/${sbId}`, undefined, fremmed)).status).toBe(403);
    expect((await api("DELETE", `/api/org/${org}/bank/koblinger/${sbId}`)).status).toBe(204);
    expect(ko.at(-1)).toMatchObject({ type: "bank-slett", org_id: org, okt_ider: ["s-sb"] });
    expect((ko.at(-1) as any).alt).toBeUndefined();
    await slettBankOkter(org, ["s-sb"]);
    expect(kall.at(-1)).toMatchObject({ metode: "DELETE", sti: "/sessions/s-sb" });
    expect(await integrasjon()).toBeTruthy();
    const s = await bankStatus();
    expect(s.koblinger.map((k: any) => k.bank)).toEqual(["DNB"]);
    expect(s.tilkoblet).toBe(true);
    expect((await api("DELETE", `/api/org/${org}/bank/koblinger/${sbId}`)).status).toBe(404);
  });

  it("startdato: eldre innbetalinger hentes ikke, og de som er hentet, ryddes bort", async () => {
    const per = (await api("POST", `/api/org/${org}/kunder`, { navn: "Per Olsen", type: "person", epost: "per@olsen.no" })).data.id;
    const f = (await api("POST", `/api/org/${org}/fakturaer`, { kunde_id: per, linjer: [{ beskrivelse: "Husleie", antall: 1, enhet: "mnd", enhetspris: 800, mva_sats: 25 }] })).data;
    const u = await api("POST", `/api/org/${org}/fakturaer/${f.id}/utsted`, { send_epost: false });
    expect(u.data.fakturanummer).toBe(4);
    fakturaer[4] = f.id;
    // Husleien for september (betalt før startdatoen) har samme beløp og fakturanummer i meldingen.
    svar["GET /accounts/:uid/transactions"] = () =>
      json(200, { transactions: [{ ...inn("g1", 1000, "PER OLSEN", "Faktura 4"), booking_date: "2026-09-15" }, { ...inn("g2", 77, "Ukjent"), booking_date: "2026-09-16" }, inn("n1", 55, "Ukjent")] });
    expect(await hentInnbetalinger(org)).toEqual({ nye: 3, koblet: 1, forslag: 0 });
    expect(await status(4)).toBe("betalt");

    expect((await api("PUT", `/api/org/${org}/bank/fra`, { fra: dag }, fremmed)).status).toBe(403);
    expect((await api("PUT", `/api/org/${org}/bank/fra`, { fra: "2026-13-01" })).status).toBe(400);
    expect((await api("PUT", `/api/org/${org}/bank/fra`, { fra: "2999-01-01" })).data.error).toBe("Startdatoen kan ikke være fram i tid");
    // Fra i dag: den gamle som ble registrert av seg selv, angres, og begge de gamle fjernes.
    const r = await api("PUT", `/api/org/${org}/bank/fra`, { fra: dag });
    expect(r.data).toMatchObject({ fra: dag, fra_satt: true, fjernet: 2 });
    expect(await status(4)).toBe("utstedt");
    expect((await transaksjoner()).map((x: any) => x.ekstern_id).filter((x: string) => /^[gn]\d$/.test(x))).toEqual(["n1"]);
    // Neste henting starter på startdatoen, og eldre innbetalinger lagres ikke.
    const for_ = kall.length;
    expect(await hentInnbetalinger(org)).toEqual({ nye: 0, koblet: 0, forslag: 0 });
    expect(kall.slice(for_).map((k) => k.sti)).toEqual([`/accounts/k-drift-2/transactions?date_from=${dag}`]);
    // Workeren rydder også bort gamle innbetalinger ved hver henting.
    await somSystem((db) => db.query("insert into faktura.banktransaksjoner (org_id, konto, ekstern_id, dato, belop) values ($1, '86011117947', 'gammel', '2026-08-01', 10)", [org]));
    await hentInnbetalinger(org);
    expect((await transaksjoner()).some((x: any) => x.ekstern_id === "gammel")).toBe(false);

    // Standard er dagen organisasjonen ble opprettet (i dag).
    expect((await api("PUT", `/api/org/${org}/bank/fra`, { fra: null })).data).toMatchObject({ fra: dag, fra_satt: false, fjernet: 0 });
    // Bakover: kontoene hentes på nytt fra den nye datoen.
    expect((await api("PUT", `/api/org/${org}/bank/fra`, { fra: "2026-09-01" })).data).toMatchObject({ fra: "2026-09-01", fra_satt: true });
    const for2 = kall.length;
    expect(await hentInnbetalinger(org)).toEqual({ nye: 2, koblet: 1, forslag: 0 });
    expect(kall.slice(for2).map((k) => k.sti)).toEqual(["/accounts/k-drift-2/transactions?date_from=2026-09-01"]);
  });

  it("kobler fra alt: øktene avsluttes, og nøkkelen og bankene slettes", async () => {
    expect((await api("DELETE", `/api/org/${org}/bank`, undefined, fremmed)).status).toBe(403);
    expect((await api("DELETE", `/api/org/${org}/bank`)).status).toBe(204);
    expect(await bankStatus()).toMatchObject({ app: null, koblinger: [], tilkoblet: false });
    expect(ko.at(-1)).toMatchObject({ type: "bank-slett", org_id: org, okt_ider: ["s-2"], alt: true });
    await slettBankOkter(org, ["s-2"], true);
    expect(kall.at(-1)).toMatchObject({ metode: "DELETE", sti: "/sessions/s-2" });
    expect(await integrasjon()).toBeUndefined();
    expect(await somSystem((db) => alle(db, "select id from faktura.bankkoblinger where org_id = $1", [org]))).toEqual([]);
    expect((await api("DELETE", `/api/org/${org}/bank`)).status).toBe(404);
    expect((await api("POST", `/api/org/${org}/bank/koblinger`, { bank: "DNB", psu_type: "business" })).status).toBe(409);
    // Innbetalingene og betalingene står igjen.
    expect((await api("GET", `/api/org/${org}/banktransaksjoner?status=alle`)).data.transaksjoner).toHaveLength(8);
  });
});
