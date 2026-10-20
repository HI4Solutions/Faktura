// Trekkpålegg fra Skatteetaten (0127_trekkpaalegg.sql, trekkpaalegg.ts, trekkpaaleggRuter.ts,
// trekkpaaleggRapporter.ts, lonnstrekk.ts, lonn.ts): tolkingen av påleggene (som eksemplene i
// Skatteetatens dokumentasjon), perioden som gjelder på utbetalingsdatoen, ressursen i Altinn, og
// hele flyten mot Skatteetaten (simulert): av til funksjonen er slått på og ressursen gitt, hentingen
// med systembrukeren, koblingen til de ansatte, trekket i lønnskjøringen (også i en ekstra
// kjøring), nye versjoner, feilene, «Hent nå» og rapporten.
import { generateKeyPairSync } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { lagApi } from "../src/api.js";
import { somSystem } from "../src/db.js";
import { settKryptering } from "../src/kryptering.js";
import { settLokalOppgavekjorer, type Oppgave } from "../src/tjenester.js";
import { settEtatFetch } from "../src/maskinporten.js";
import { lagEndringsforesporsel, lagForesporsel, PAKKENAVN, systemdefinisjon, tilAltinn, TILGANGSPAKKE, tilgangspakker, TREKKPAALEGG_RESSURS } from "../src/altinn.js";
import { gjeldendePeriode, paaleggstrekk, storrelseTekst, type Lonnstrekk } from "../src/lonnstrekk.js";
import { hentTrekkpaalegg, planleggTrekkpaalegg, tolkPaalegg } from "../src/trekkpaalegg.js";
import { hentPaalegg } from "../src/trekkpaaleggRuter.js";
import { kjorOppgave } from "../src/worker.js";

const ORGNR = "811001015";
const betaling = { kidnummer: "6487719756", kontonummer: "70213997155", betalingsmottaker: "971648199" };

// Eksemplene i Skatteetatens dokumentasjon (fanen «Eksempler»).
const EKS_10003_V2 = {
  trekkid: "10003",
  skyldner: "10108412345",
  opprettet: "2025-08-08T15:00:00.00Z",
  saksnummer: "TREKK/2025/3",
  trekkstatus: "aktiv",
  trekkpliktig: "123456789",
  trekkversjon: 2,
  sekvensnummer: 101,
  betalingsinformasjon: betaling,
  trekkstoerrelseForPeriode: [
    { startdato: "2025-06-01", sluttdato: "2025-08-08", trekkprosent: { trekkprosent: 23.0 } },
    { startdato: "2025-08-09", trekkprosent: { trekkprosent: 17.0 } },
  ],
};
const EKS_10004_V2 = {
  trekkid: "10004",
  skyldner: "10108412345",
  opprettet: "2025-09-12T23:59:00.00Z",
  saksnummer: "TREKK/2025/4",
  trekkstatus: "avsluttet",
  trekkpliktig: "123456789",
  trekkversjon: 2,
  sekvensnummer: 159,
  betalingsinformasjon: betaling,
  trekkstoerrelseForPeriode: [{ startdato: "2025-07-01", sluttdato: "2025-09-12", trekkprosent: { trekkprosent: 17.0 } }],
};
const EKS_10005_V3 = {
  trekkid: "10005",
  skyldner: "10108412345",
  opprettet: "2025-08-31T23:59:00.00Z",
  saksnummer: "TREKK/2025/5",
  trekkstatus: "avsluttet",
  trekkpliktig: "123456789",
  trekkversjon: 3,
  sekvensnummer: 229,
  betalingsinformasjon: betaling,
  trekkstoerrelseForPeriode: [
    { startdato: "2025-07-01", sluttdato: "2025-08-09", trekkprosent: { trekkprosent: 23.0 } },
    { startdato: "2025-08-10", sluttdato: "2025-08-31", trekkbeloep: { trekkbeloep: 4400 } },
  ],
};

const trekk: Lonnstrekk = {
  id: "p",
  ansatt_id: "ola",
  type: "utlegg_samordnet",
  tekst: "Sak TREKK/2026/1",
  belop: null,
  prosent: null,
  totalt: null,
  fra: "2026-11-01",
  til: null,
  mottaker: "Skatteetaten",
  kontonr: "70213997155",
  kid: "6487719756",
  melding: null,
};

describe("trekkpålegg (uten database)", () => {
  it("tolker påleggene som i Skatteetatens eksempler", () => {
    expect(tolkPaalegg(EKS_10003_V2)).toEqual({
      trekkid: "10003",
      trekkversjon: 2,
      sekvensnummer: 101,
      saksnummer: "TREKK/2025/3",
      trekkstatus: "aktiv",
      formidlet: "2025-08-08T15:00:00.000Z",
      skyldner: "10108412345",
      trekkpliktig: "123456789",
      betalingsmottaker: "971648199",
      kontonr: "70213997155",
      kid: "6487719756",
      perioder: [
        { fra: "2025-06-01", til: "2025-08-08", belop: null, prosent: 23 },
        { fra: "2025-08-09", til: null, belop: null, prosent: 17 },
      ],
    });
    expect(tolkPaalegg(EKS_10005_V3)).toMatchObject({
      trekkstatus: "avsluttet",
      trekkversjon: 3,
      perioder: [
        { fra: "2025-07-01", til: "2025-08-09", belop: null, prosent: 23 },
        { fra: "2025-08-10", til: "2025-08-31", belop: 4400, prosent: null },
      ],
    });
    // Uten trekk-ID: ikke et pålegg. Et beløp rett i feltet og med komma godtas; en periode uten
    // startdato hoppes over; ugyldig KID, konto og fødselsnummer blir borte.
    expect(tolkPaalegg({})).toBeNull();
    expect(
      tolkPaalegg({
        trekkid: 7,
        trekkstatus: "AKTIV",
        skyldner: "123",
        betalingsinformasjon: { kidnummer: "12a", kontonummer: "7021.39.97155" },
        trekkstoerrelseForPeriode: [{ trekkbeloep: 100 }, { startdato: "2026-02-01", trekkbeloep: "1000,5" }, { startdato: "2026-01-01", trekkbeloep: 0 }],
      }),
    ).toEqual({
      trekkid: "7",
      trekkversjon: 1,
      sekvensnummer: 0,
      saksnummer: null,
      trekkstatus: "aktiv",
      formidlet: null,
      skyldner: null,
      trekkpliktig: null,
      betalingsmottaker: null,
      kontonr: "70213997155",
      kid: null,
      perioder: [
        { fra: "2026-01-01", til: null, belop: 0, prosent: null },
        { fra: "2026-02-01", til: null, belop: 1000.5, prosent: null },
      ],
    });
  });

  it("perioden som gjelder på utbetalingsdatoen, ikke alle i lønnsmåneden", () => {
    const p = tolkPaalegg(EKS_10003_V2)!.perioder;
    expect(gjeldendePeriode(p, "2025-08-08")?.prosent).toBe(23);
    // August har begge periodene; lønnen 20. august trekker bare den som gjelder da.
    expect(gjeldendePeriode(p, "2025-08-20")?.prosent).toBe(17);
    expect(gjeldendePeriode(p, "2025-05-31")).toBeNull();
    const avsluttet = tolkPaalegg(EKS_10004_V2)!.perioder;
    expect(gjeldendePeriode(avsluttet, "2025-09-12")?.prosent).toBe(17);
    expect(gjeldendePeriode(avsluttet, "2025-09-20")).toBeNull();
    // Avsluttet før det startet (sluttdatoen før startdatoen): aldri.
    expect(gjeldendePeriode([{ fra: "2026-01-10", til: "2026-01-05", belop: 100, prosent: null }], "2026-01-07")).toBeNull();
    expect(gjeldendePeriode([{ fra: "2026-01-10", til: "2026-01-05", belop: 100, prosent: null }], "2026-01-10")).toBeNull();
  });

  it("trekket i en kjøring: prosenten ved hver utbetaling, beløpet én gang i måneden", () => {
    const pros = [{ fra: "2026-11-01", til: null, belop: null, prosent: 17 }];
    const bel = [{ fra: "2026-11-01", til: null, belop: 5000, prosent: null }];
    const ordinar = { trukketIMaaneden: 0, ordinar: true, ordinarGodkjent: true };
    const ekstra = (trukketIMaaneden: number, ordinarGodkjent: boolean) => ({ trukketIMaaneden, ordinar: false, ordinarGodkjent });
    expect(paaleggstrekk(trekk, pros, "2026-11-20", ordinar)).toMatchObject({ prosent: 17, belop: null, totalt: null });
    // Prosenten også i en ekstra kjøring.
    expect(paaleggstrekk(trekk, pros, "2026-11-27", ekstra(6800, true))).toMatchObject({ prosent: 17, belop: null });
    expect(paaleggstrekk(trekk, bel, "2026-11-20", ordinar)).toMatchObject({ belop: 5000, prosent: null });
    // Det som alt er trukket i måneden, trekkes ikke igjen.
    expect(paaleggstrekk(trekk, bel, "2026-11-20", { ...ordinar, trukketIMaaneden: 1200 })?.belop).toBe(3800);
    expect(paaleggstrekk(trekk, bel, "2026-11-27", ekstra(5000, true))).toBeNull();
    // En ekstra kjøring tar det den ordinære ikke rakk, når den er godkjent; ellers venter beløpet.
    expect(paaleggstrekk(trekk, bel, "2026-11-27", ekstra(3000, true))?.belop).toBe(2000);
    expect(paaleggstrekk(trekk, bel, "2026-11-05", ekstra(0, false))).toBeNull();
    // 0, og utenfor periodene: ikke noe trekk.
    expect(paaleggstrekk(trekk, [{ fra: "2026-11-01", til: null, belop: 0, prosent: null }], "2026-11-20", ordinar)).toBeNull();
    expect(paaleggstrekk(trekk, [{ fra: "2026-11-01", til: null, belop: null, prosent: 0 }], "2026-11-20", ordinar)).toBeNull();
    expect(paaleggstrekk(trekk, bel, "2026-10-20", ordinar)).toBeNull();
    expect(storrelseTekst({ belop: 5000, prosent: null })).toBe("5 000 kr per måned");
    expect(storrelseTekst({ belop: null, prosent: 17.5 })).toBe("17,5 % av bruttolønnen");
    expect(storrelseTekst({ belop: 0, prosent: null })).toBe("ikke noe trekk");
  });

  it("ressursen «Informasjon om trekkpålegg» i Altinn når hentingen er slått på", () => {
    const foer = config.trekkpaalegg;
    config.trekkpaalegg = false;
    expect(tilgangspakker()).not.toContain(TREKKPAALEGG_RESSURS);
    expect(systemdefinisjon()).not.toHaveProperty("rights");
    config.trekkpaalegg = true;
    expect(tilgangspakker()).toEqual(expect.arrayContaining([TILGANGSPAKKE, TREKKPAALEGG_RESSURS]));
    expect(TREKKPAALEGG_RESSURS).toBe("urn:altinn:resource:ske-informasjon-om-trekkpaalegg");
    expect(PAKKENAVN[TREKKPAALEGG_RESSURS]).toBe("Informasjon om trekkpålegg");
    const def = systemdefinisjon();
    // En enkeltressurs (rights), ikke en tilgangspakke.
    expect(def.rights).toEqual([{ resource: [{ id: "urn:altinn:resource", value: "ske-informasjon-om-trekkpaalegg" }] }]);
    expect(def.accessPackages).not.toContainEqual({ urn: TREKKPAALEGG_RESSURS });
    expect(def.description.nb).toContain("Trekkpåleggene fra Skatteetaten hentes til lønnskjøringen.");
    expect(tilAltinn([TILGANGSPAKKE, TREKKPAALEGG_RESSURS])).toEqual({
      accessPackages: [{ urn: TILGANGSPAKKE }],
      rights: [{ resource: [{ id: "urn:altinn:resource", value: "ske-informasjon-om-trekkpaalegg" }] }],
    });
    config.trekkpaalegg = foer;
  });

  it("forespørselen og endringsforespørselen i Altinn ber om ressursen (rights og requiredRights)", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
    const foer = { ...config };
    Object.assign(config, { maskinportenKlientId: "klient-1", maskinportenNokkelId: "kid-1", maskinportenNokkel: privateKey, maskinportenUrl: "https://mp.test", altinnUrl: "https://altinn.test", trekkpaalegg: true });
    const kropper: { url: string; kropp: any }[] = [];
    const json = (status: number, data: unknown) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
    settEtatFetch(async (url, init) => {
      const u = new URL(String(url));
      if (u.host === "mp.test") return json(200, { access_token: "tok", expires_in: 120 });
      kropper.push({ url: `${u.pathname}${u.search}`, kropp: init?.body ? JSON.parse(String(init.body)) : null });
      if (u.pathname.endsWith("/systemuser/vendor/byquery")) return json(200, { id: "7c1d2e3f-0000-4000-8000-00000000b001" });
      return json(200, { id: "3f2a7c1e-5b4d-4e6f-8a9b-0c1d2e3f4a5b", status: "New", confirmUrl: "https://am.ui.tt02.altinn.no/accessmanagement/ui/systemuser/request?id=x" });
    });
    try {
      expect((await lagForesporsel(ORGNR)).status).toBe("ny");
      expect(kropper.at(-1)!.kropp).toMatchObject({
        partyOrgNo: ORGNR,
        accessPackages: [{ urn: TILGANGSPAKKE }],
        rights: [{ resource: [{ id: "urn:altinn:resource", value: "ske-informasjon-om-trekkpaalegg" }] }],
      });
      expect((await lagEndringsforesporsel(ORGNR, [TREKKPAALEGG_RESSURS])).status).toBe("ny");
      const endring = kropper.at(-1)!;
      expect(endring.url).toContain("/systemuser/changerequest/vendor?");
      expect(endring.kropp).toEqual({
        requiredRights: [{ resource: [{ id: "urn:altinn:resource", value: "ske-informasjon-om-trekkpaalegg" }] }],
        redirectUrl: "http://localhost:5173/skattekort/godkjent",
      });
    } finally {
      Object.assign(config, foer);
    }
  });
});

describe.skipIf(!process.env.DATABASE_URL)("trekkpålegg fra Skatteetaten i appen", () => {
  const app = lagApi();
  const eier = "Bearer test:uid-tpaal-eier:tpaal-eier@server.test:mfa";
  const fakturerer = "Bearer test:uid-tpaal-fakt:tpaal-fakt@server.test:mfa";
  const ko: Oppgave[] = [];
  const kall: { sti: string; token: string }[] = [];
  const tokener: { scope: string; kunde: string | null }[] = [];
  let svar: () => Response;
  let org: string;
  let ola: string;
  let kari: string;
  let per: string;
  let nov: string;

  const api = async (m: string, sti: string, b?: unknown, hvem = eier) => {
    const r = await app.request(sti, { method: m, headers: { authorization: hvem, "content-type": "application/json" }, body: b === undefined ? undefined : JSON.stringify(b) });
    return { status: r.status, data: (r.headers.get("content-type") ?? "").includes("json") ? ((await r.json()) as any) : await r.text() };
  };
  const json = (status: number, data: unknown) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
  const kjor = async (type: string) => {
    const mine = ko.filter((o) => o.type === type);
    ko.splice(0, ko.length, ...ko.filter((o) => o.type !== type));
    for (const o of mine) await kjorOppgave({ ...o, oppgave_id: "t" } as any);
    return mine.length;
  };
  const varsler = () => {
    const v = ko.filter((o) => o.type === "varsel").map((o) => [(o as any).varsel.hendelse, (o as any).varsel.tittel, (o as any).varsel.tekst]);
    ko.splice(0, ko.length, ...ko.filter((o) => o.type !== "varsel"));
    return v;
  };
  const status = async () => (await api("GET", `/api/org/${org}/lonn/trekkpaalegg`)).data;
  // «Hent nå» (høyst én gang i minuttet: forrige forsøk flyttes en stund tilbake).
  const hentNa = async () => {
    await somSystem((db) => db.query("update faktura.trekkpaalegg_henting set forsokt = now() - interval '2 minutes' where org_id = $1", [org]));
    const r = await api("POST", `/api/org/${org}/lonn/trekkpaalegg/hent`);
    expect(r.data, JSON.stringify(r.data)).toEqual({ ok: true });
    return kjor("trekkpaalegg-hent");
  };
  const slipp = (k: any, ansatt: string) => k.slipper.find((s: any) => s.ansatt_id === ansatt);
  const trekklinjer = (s: any) => (s?.linjer ?? []).filter((l: any) => !l.fjernet && l.lonnsart === "utleggstrekk_samordnet").map((l: any) => [l.tekst, l.belop]);
  const kjoring = async (b: Record<string, unknown>) => {
    const r = await api("POST", `/api/org/${org}/lonn/kjoringer`, b);
    expect(r.status, JSON.stringify(r.data)).toBe(201);
    return r.data;
  };

  // Ola: prosenttrekk som endres midt i november; Kari: beløpstrekk fra november; den tredje er
  // ikke registrert med fødselsnummer (Per).
  const P_OLA = {
    trekkid: "20001",
    skyldner: "13830197340",
    opprettet: "2026-09-20T10:00:00Z",
    saksnummer: "TREKK/2026/1",
    trekkstatus: "aktiv",
    trekkpliktig: ORGNR,
    trekkversjon: 2,
    sekvensnummer: 510,
    betalingsinformasjon: betaling,
    trekkstoerrelseForPeriode: [
      { startdato: "2026-10-01", sluttdato: "2026-11-15", trekkprosent: { trekkprosent: 23.0 } },
      { startdato: "2026-11-16", trekkprosent: { trekkprosent: 17.0 } },
    ],
  };
  const P_KARI = {
    trekkid: "20002",
    skyldner: "24880199664",
    opprettet: "2026-10-01T10:00:00Z",
    saksnummer: "TREKK/2026/2",
    trekkstatus: "aktiv",
    trekkpliktig: ORGNR,
    trekkversjon: 1,
    sekvensnummer: 520,
    betalingsinformasjon: { ...betaling, kidnummer: "6487719772" },
    trekkstoerrelseForPeriode: [{ startdato: "2026-11-01", trekkbeloep: { trekkbeloep: 2500 } }],
  };
  const P_PER = {
    trekkid: "20003",
    skyldner: "05829140057",
    opprettet: "2026-10-02T10:00:00Z",
    saksnummer: "TREKK/2026/3",
    trekkstatus: "aktiv",
    trekkpliktig: ORGNR,
    trekkversjon: 1,
    sekvensnummer: 530,
    betalingsinformasjon: { ...betaling, kidnummer: "6487719780" },
    trekkstoerrelseForPeriode: [{ startdato: "2026-11-01", trekkbeloep: { trekkbeloep: 1000 } }],
  };

  beforeAll(async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
    Object.assign(config, {
      maskinportenKlientId: "klient-1",
      maskinportenNokkelId: "kid-1",
      maskinportenNokkel: privateKey,
      maskinportenUrl: "https://mp.test",
      trekkpaaleggUrl: "https://trekk.test/api/trekkpaalegg/v1",
      trekkpaalegg: false,
    });
    settKryptering(async (t) => Buffer.from(`kryptert:${t}`), async (d) => d.toString().replace(/^kryptert:/, ""));
    settLokalOppgavekjorer(async (o) => void ko.push(o));
    svar = () => json(200, []);
    settEtatFetch(async (url, init) => {
      const u = new URL(String(url));
      if (u.host === "mp.test") {
        const jwt = new URLSearchParams(String(init?.body)).get("assertion")!;
        const innhold = JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString());
        tokener.push({ scope: innhold.scope, kunde: innhold.authorization_details?.[0]?.systemuser_org?.ID ?? null });
        return json(200, { access_token: `tok-${innhold.scope}`, expires_in: 120 });
      }
      if (u.host !== "trekk.test") throw new Error(`Uventet kall: ${u.href}`);
      kall.push({ sti: `${u.pathname}${u.search}`, token: String((init?.headers as any)?.authorization ?? "") });
      return svar();
    });
    org = (await api("POST", "/api/organisasjoner", { navn: "Trekkpålegg Test AS", orgnr: ORGNR })).data.id;
    expect((await api("PUT", `/api/org/${org}/lonn-oppsett`, { aktiv: true, otp_prosent: 0, lonnskonto: "86011117947", bank_bic: "DNBANOKK" })).status).toBe(200);
    const ny = async (b: Record<string, unknown>) => {
      const r = await api("POST", `/api/org/${org}/ansatte`, { ansatt_fra: "2025-01-01", lonnstype: "maaned", skattekort: "prosent", skatt_prosent: 30, skattekort_aar: 2026, yrkeskode: "2221104", ...b });
      expect(r.status, JSON.stringify(r.data)).toBe(201);
      return r.data.id as string;
    };
    ola = await ny({ fornavn: "Ola", etternavn: "Skyldner", maanedslonn: 40000, kontonr: "12345678903", fnr: "13830197340" });
    kari = await ny({ fornavn: "Kari", etternavn: "Skyldner", maanedslonn: 50000, kontonr: "86011117947", fnr: "24880199664" });
    per = await ny({ fornavn: "Per", etternavn: "Uten", maanedslonn: 30000, kontonr: "86011117947" });
    const inv = await api("POST", `/api/org/${org}/invitasjoner`, { epost: "tpaal-fakt@server.test", rolle: "fakturerer" });
    expect((await api("POST", "/api/invitasjoner/aksepter", { token: inv.data.lenke.split("/").pop() }, fakturerer)).status).toBe(200);
    ko.length = 0;
  });

  it("av til funksjonen er slått på, organisasjonen er koblet til og ressursen er gitt", async () => {
    expect(await status()).toMatchObject({
      pa: false,
      koblet: false,
      tilgang: false,
      ressurs: "Informasjon om trekkpålegg",
      henting: { forsokt: null, hentet: null, antall: null, feil: null },
      paalegg: [],
    });
    expect((await api("POST", `/api/org/${org}/lonn/trekkpaalegg/hent`)).data.error).toContain("ikke slått på");
    config.trekkpaalegg = true;
    expect((await api("POST", `/api/org/${org}/lonn/trekkpaalegg/hent`)).data.error).toContain("Koble til Skatteetaten først");
    await somSystem((db) => db.query("insert into faktura.skattekort_tilgang (org_id, status, pakker) values ($1, 'godkjent', $2)", [org, [TILGANGSPAKKE]]));
    const r = await api("POST", `/api/org/${org}/lonn/trekkpaalegg/hent`);
    expect(r.status).toBe(409);
    expect(r.data.error).toContain("ressursen «Informasjon om trekkpålegg»");
    expect(await planleggTrekkpaalegg()).toBe(0);
    expect(await hentTrekkpaalegg(org)).toBeNull();
    expect(kall).toEqual([]);
    // De som ikke ser lønnen, ser ikke påleggene.
    expect((await api("GET", `/api/org/${org}/lonn/trekkpaalegg`, undefined, fakturerer)).status).toBe(403);
  });

  it("hentes med en gang ressursen er gitt: en tom liste før Skatteetaten har lagt inn pålegg", async () => {
    await somSystem((db) => db.query("update faktura.skattekort_tilgang set pakker = $2 where org_id = $1", [org, [TILGANGSPAKKE, TREKKPAALEGG_RESSURS]]));
    expect(await planleggTrekkpaalegg()).toBe(1);
    expect(await kjor("trekkpaalegg-hent")).toBe(1);
    // Med systembrukeren (kunden) og scopet, og uten søkeparametre (alle påleggene).
    expect(tokener.at(-1)).toEqual({ scope: "skatteetaten:trekkpaalegg", kunde: `0192:${ORGNR}` });
    expect(kall).toEqual([{ sti: "/api/trekkpaalegg/v1", token: "Bearer tok-skatteetaten:trekkpaalegg" }]);
    expect((await status()).henting).toMatchObject({ hentet: expect.any(String), antall: 0, feil: null });
    expect(varsler()).toEqual([]);
    // Ikke igjen før i morgen tidlig.
    expect(await planleggTrekkpaalegg()).toBe(0);
  });

  it("påleggene kobles til de ansatte og blir faste trekk; den som ikke er registrert, får en merknad", async () => {
    svar = () => json(200, [P_OLA, P_KARI, P_PER]);
    expect(await hentNa()).toBe(1);
    expect(varsler()).toEqual([
      ["trekkpaalegg", "Nytt trekkpålegg fra Skatteetaten", "Ola Skyldner (sak TREKK/2026/1): 17 % av bruttolønnen fra 16.11.2026."],
      ["trekkpaalegg", "Nytt trekkpålegg fra Skatteetaten", "Kari Skyldner (sak TREKK/2026/2): 2 500 kr per måned fra 01.11.2026."],
      [
        "trekkpaalegg",
        "Nytt trekkpålegg fra Skatteetaten",
        "En som ikke er registrert her (født 05.02.1991) (sak TREKK/2026/3): 1 000 kr per måned fra 01.11.2026. Se merknadene i appen.",
      ],
    ]);
    const s = await status();
    expect(s.henting).toMatchObject({ antall: 3, feil: null });
    expect(s.paalegg.map((p: any) => [p.trekkid, p.navn, p.trekkstatus, p.kid, p.fodselsdato, p.merknader.length])).toEqual([
      ["20003", null, "aktiv", "6487719780", "1991-02-05", 1],
      ["20002", "Kari Skyldner", "aktiv", "6487719772", "2001-08-24", 0],
      ["20001", "Ola Skyldner", "aktiv", "6487719756", "2001-03-13", 0],
    ]);
    expect(s.paalegg[0].merknader[0]).toContain("Skyldneren (født 05.02.1991) er ikke registrert med fødselsnummer her.");
    // Trekket som gjelder og det neste, etter dagen.
    const nov20 = await somSystem((db) => hentPaalegg(db, org, "2026-11-20"));
    expect(nov20.find((p) => p.trekkid === "20001")).toMatchObject({ gjeldende: { prosent: 17 }, neste: null });
    const okt20 = await somSystem((db) => hentPaalegg(db, org, "2026-10-20"));
    expect(okt20.find((p) => p.trekkid === "20001")).toMatchObject({ gjeldende: { prosent: 23 }, neste: { fra: "2026-11-16", prosent: 17 } });
    expect(okt20.find((p) => p.trekkid === "20002")).toMatchObject({ gjeldende: null, neste: { fra: "2026-11-01", belop: 2500 } });
    // Trekket hos den ansatte, med pålegget.
    const t = (await api("GET", `/api/org/${org}/ansatte/${ola}/trekk`)).data;
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({
      type: "utlegg_samordnet",
      tekst: "Sak TREKK/2026/1",
      belop: null,
      prosent: null,
      fra: "2026-10-01",
      til: null,
      mottaker: "Skatteetaten",
      kontonr: "70213997155",
      kid: "6487719756",
      paalegg: { trekkid: "20001", saksnummer: "TREKK/2026/1", trekkstatus: "aktiv", trekkversjon: 2 },
    });
    expect((await api("GET", `/api/org/${org}/ansatte/${per}/trekk`)).data).toEqual([]);
    // Den samme lista igjen: ingen nye varsler.
    expect(await hentNa()).toBe(1);
    expect(varsler()).toEqual([]);
  });

  it("eier og administrator kan ikke endre eller fjerne trekket fra et pålegg", async () => {
    const t = (await api("GET", `/api/org/${org}/ansatte/${ola}/trekk`)).data[0];
    const endre = await api("PUT", `/api/org/${org}/ansatte/${ola}/trekk/${t.id}`, { type: "utlegg_samordnet", belop: 100, fra: "2026-10-01" });
    expect(endre.status).toBe(409);
    expect(endre.data.error).toContain("kommer fra et trekkpålegg fra Skatteetaten");
    expect((await api("DELETE", `/api/org/${org}/ansatte/${ola}/trekk/${t.id}`)).status).toBe(409);
  });

  it("lønnskjøringen trekker det som gjelder på utbetalingsdatoen, og betaler det til Skatteetaten med KID-en", async () => {
    const k = await kjoring({ periode: "2026-11", utbetalingsdato: "2026-11-20" });
    nov = k.id;
    // Ola: 17 % (gjelder fra 16.11.), ikke 23 % i tillegg.
    expect(trekklinjer(slipp(k, ola))).toEqual([["Utleggstrekk (samordnet, Skatteetaten) – Sak TREKK/2026/1", -6800]]);
    expect(trekklinjer(slipp(k, kari))).toEqual([["Utleggstrekk (samordnet, Skatteetaten) – Sak TREKK/2026/2", -2500]]);
    // Per er ikke koblet til pålegget ennå.
    expect(trekklinjer(slipp(k, per))).toEqual([]);
    expect((await api("POST", `/api/org/${org}/lonn/kjoringer/${nov}/godkjenn`)).data.status).toBe("godkjent");
    const b = (await api("GET", `/api/org/${org}/lonn/kjoringer/${nov}/betalinger`)).data;
    expect(b.trekk.map((x: any) => [x.mottaker, x.kontonr, x.kid, x.belop, x.mangler])).toEqual([
      ["Skatteetaten", "70213997155", "6487719756", 6800, null],
      ["Skatteetaten", "70213997155", "6487719772", 2500, null],
    ]);
  });

  it("en ekstra kjøring: prosenten av bonusen, og ikke beløpet en gang til", async () => {
    const k = await kjoring({ periode: "2026-11", type: "ekstra", utbetalingsdato: "2026-11-27" });
    for (const [ansatt, belop] of [
      [ola, 10000],
      [kari, 5000],
    ] as const)
      expect((await api("POST", `/api/org/${org}/lonn/kjoringer/${k.id}/linjer`, { ansatt_id: ansatt, lonnsart: "bonus", belop })).status).toBe(200);
    const e = (await api("GET", `/api/org/${org}/lonn/kjoringer/${k.id}`)).data;
    expect(trekklinjer(slipp(e, ola))).toEqual([["Utleggstrekk (samordnet, Skatteetaten) – Sak TREKK/2026/1", -1700]]);
    expect(trekklinjer(slipp(e, kari))).toEqual([]);
    expect((await api("DELETE", `/api/org/${org}/lonn/kjoringer/${k.id}`)).status).toBeLessThan(300);
  });

  it("nye versjoner: endringen og avslutningen varsles, og lønnen bruker den nye", async () => {
    svar = () =>
      json(200, [
        { ...P_OLA, trekkversjon: 3, sekvensnummer: 610, trekkstatus: "avsluttet", trekkstoerrelseForPeriode: [P_OLA.trekkstoerrelseForPeriode[0], { ...P_OLA.trekkstoerrelseForPeriode[1], sluttdato: "2026-12-10" }] },
        {
          ...P_KARI,
          trekkversjon: 2,
          sekvensnummer: 620,
          trekkstoerrelseForPeriode: [
            { startdato: "2026-11-01", sluttdato: "2026-11-30", trekkbeloep: { trekkbeloep: 2500 } },
            { startdato: "2026-12-01", trekkbeloep: { trekkbeloep: 3000 } },
          ],
        },
        P_PER,
      ]);
    expect(await hentNa()).toBe(1);
    expect(varsler()).toEqual([
      ["trekkpaalegg", "Trekkpålegg avsluttet", "Trekkpålegget for Ola Skyldner (sak TREKK/2026/1) er avsluttet fra 10.12.2026."],
      ["trekkpaalegg", "Endret trekkpålegg fra Skatteetaten", "Kari Skyldner (sak TREKK/2026/2): 3 000 kr per måned fra 01.12.2026."],
    ]);
    const t = (await api("GET", `/api/org/${org}/ansatte/${ola}/trekk`)).data[0];
    expect(t).toMatchObject({ til: "2026-12-10", trukket: 6800, paalegg: { trekkstatus: "avsluttet", trekkversjon: 3 } });
    const k = await kjoring({ periode: "2026-12", utbetalingsdato: "2026-12-18" });
    expect(trekklinjer(slipp(k, ola))).toEqual([]);
    expect(trekklinjer(slipp(k, kari))).toEqual([["Utleggstrekk (samordnet, Skatteetaten) – Sak TREKK/2026/2", -3000]]);
    expect((await api("DELETE", `/api/org/${org}/lonn/kjoringer/${k.id}`)).status).toBeLessThan(300);
  });

  it("den som ikke var registrert, kobles når fødselsnummeret er lagt inn", async () => {
    expect((await api("PATCH", `/api/org/${org}/ansatte/${per}`, { fnr: "05829140057" })).status).toBe(200);
    expect(await hentNa()).toBe(1);
    expect(varsler()).toEqual([]);
    const p = (await status()).paalegg.find((x: any) => x.trekkid === "20003");
    expect(p).toMatchObject({ navn: "Per Uten", merknader: [] });
    expect((await api("GET", `/api/org/${org}/ansatte/${per}/trekk`)).data.map((t: any) => [t.kid, t.paalegg?.trekkid])).toEqual([["6487719780", "20003"]]);
  });

  it("et utleggstrekk lagt inn for hånd: med samme KID kobles det til pålegget, med en annen får lederen en merknad", async () => {
    const sti = `/api/org/${org}/ansatte/${kari}/trekk`;
    expect((await api("POST", sti, { type: "utlegg_samordnet", belop: 999, fra: "2026-12-01", kontonr: "86011117947", kid: "12345678903" })).status).toBe(201);
    expect(await hentNa()).toBe(1);
    const p = (await status()).paalegg.find((x: any) => x.trekkid === "20002");
    expect(p.merknader).toEqual([
      "Kari Skyldner har også et samordnet utleggstrekk som er lagt inn for hånd. Er det det samme pålegget, avslutt trekket for hånd, så det ikke trekkes to ganger.",
    ]);
    varsler();
  });

  it("feilene: tilgangen avvist lagres og prøves ikke igjen; feil hos Skatteetaten prøves igjen", async () => {
    svar = () => json(403, { kode: "KB-005", melding: "Feil i forbindelse med samtykketoken.", korrelasjonsid: "k-1" });
    expect(await hentTrekkpaalegg(org)).toBeNull();
    expect((await status()).henting.feil).toBe(
      "Kunne ikke hente trekkpåleggene fra Skatteetaten: Skatteetaten avviste tilgangen (403, KB-005). Ressursen «Informasjon om trekkpålegg» må være godkjent i Altinn (Lønn → Skattekort → «Utvid tilgangen i Altinn»).",
    );
    svar = () => json(500, { kode: "KB-001", melding: "Uventet feil på tjenesten.", korrelasjonsid: "k-2" });
    await expect(hentTrekkpaalegg(org)).rejects.toThrow("Uventet feil på tjenesten.");
    expect((await status()).henting.feil).toBe("Kunne ikke hente trekkpåleggene fra Skatteetaten: Uventet feil på tjenesten. (KB-001) (korrelasjons-ID k-2)");
    svar = () => new Response("<html><body><h1>404 Not Found</h1></body></html>", { status: 404, headers: { "content-type": "text/html" } });
    expect(await hentTrekkpaalegg(org)).toBeNull();
    expect((await status()).henting.feil).toContain("Skatteetaten kjente ikke igjen adressen appen bruker");
    // Ingen pålegg (KB-009): en tom liste, og feilen er borte; påleggene som er lagret, står.
    svar = () => json(404, { kode: "KB-009", melding: "Ingen treff på oppgitt identifikator." });
    expect(await hentTrekkpaalegg(org)).toEqual({ antall: 0, nye: 0, endret: 0 });
    const s = await status();
    expect(s.henting).toMatchObject({ antall: 0, feil: null });
    expect(s.paalegg).toHaveLength(3);
  });

  it("rapporten «Trekkpålegg fra Skatteetaten»", async () => {
    const r = await api("GET", `/api/org/${org}/rapportmodul/lonn.trekkpaalegg`);
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data.rader.map((x: any) => [x.ansatt, x.sak, x.status, x.kid, x.trukket])).toEqual([
      ["Kari Skyldner", "TREKK/2026/2", "Aktiv", "6487719772", 2500],
      ["Per Uten", "TREKK/2026/3", "Aktiv", "6487719780", 0],
      ["Ola Skyldner", "TREKK/2026/1", "Avsluttet", "6487719756", 6800],
    ]);
    expect(r.data.merknad).toMatch(/^Hentet fra Skatteetaten \d{2}\.\d{2}\.\d{4} kl\. \d{2}\.\d{2}\.$/);
    expect((await api("GET", `/api/org/${org}/rapportmodul/lonn.trekkpaalegg`, undefined, fakturerer)).status).toBe(403);
  });
});
