// Skattekort fra Skatteetaten: JWT-en til Maskinporten, tolkningen av svaret, og hele flyten fra
// forespørselen om tilgang i Altinn til skattekort som hentes, lagres og regnes om (med
// Maskinporten, Altinn og Skatteetaten som svarer i testen).
import { beforeAll, describe, expect, it } from "vitest";
import { generateKeyPairSync, verify } from "node:crypto";
import { config } from "../src/config.js";
import { lagApi } from "../src/api.js";
import { en, somSystem } from "../src/db.js";
import { settKryptering } from "../src/kryptering.js";
import { settLokalOppgavekjorer, type Oppgave } from "../src/tjenester.js";
import { lagGrant, settEtatFetch } from "../src/maskinporten.js";
import {
  bestillingskropp,
  finnReferanse,
  kortFraSvar,
  kortFraTrekk,
  melding,
  mobilnummer,
  PAUSE,
  planleggDagligSkattekort,
  planleggTilgangssjekk,
  tolkSvar,
  trekkode,
  type Skattekortsvar,
} from "../src/skattekort.js";
import { kjorOppgave } from "../src/worker.js";

const { privateKey: privat, publicKey: offentlig } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

// Svaret i Skatteetatens dokumentasjon (forkortet), med tabellnummeret som tekst.
const EKSEMPEL = {
  arbeidsgiver: [
    {
      arbeidsgiveridentifikator: { organisasjonsnummer: "222121914" },
      arbeidstaker: [
        {
          arbeidstakeridentifikator: "13830197340",
          resultatForSkattekort: "skattekortopplysningerOK",
          skattekort: {
            utstedtDato: "2025-04-03",
            skattekortidentifikator: "543210",
            forskuddstrekk: [
              { trekkode: "LOENN_FRA_HOVEDARBEIDSGIVER", frikort: { frikortbeloep: 100000 } },
              { trekkode: "LOENN_FRA_BIARBEIDSGIVER", frikort: { frikortbeloep: 100000 } },
            ],
          },
          inntektsaar: "2025",
        },
        {
          arbeidstakeridentifikator: "21908899455",
          resultatForSkattekort: "skattekortopplysningerOK",
          skattekort: {
            utstedtDato: "2024-12-07",
            skattekortidentifikator: 10771,
            forskuddstrekk: [
              { trekkode: "LOENN_FRA_HOVEDARBEIDSGIVER", trekktabell: { tabellnummer: "8010", prosentsats: 41, antallMaanederForTrekk: 10.5 } },
              { trekkode: "LOENN_FRA_BIARBEIDSGIVER", trekkprosent: { prosentsats: 34 } },
              { trekkode: "LOENN_FRA_NAV", trekkprosent: { prosentsats: 34 } },
            ],
          },
          inntektsaar: "2025",
        },
        {
          arbeidstakeridentifikator: "24880199664",
          resultatForSkattekort: "skattekortopplysningerOK",
          skattekort: {
            utstedtDato: "2025-01-24",
            forskuddstrekk: [{ trekkode: "PENSJON", trekkprosent: { prosentsats: 25, antallMaanederForTrekk: 12 } }],
          },
          tilleggsopplysning: ["kildeskattPaaPensjon", "kildeskattPaaLoenn"],
          inntektsaar: "2025",
        },
        { arbeidstakeridentifikator: "10829996974", resultatForSkattekort: "ikkeSkattekort", inntektsaar: "2025" },
        { arbeidstakeridentifikator: "ikke et nummer", resultatForSkattekort: "ugyldigFoedselsEllerDnummer" },
      ],
    },
  ],
};

describe("Skatteetaten og Maskinporten: token, svar og skattekort", () => {
  it("lager JWT-en til Maskinporten, med systembrukeren til kunden", () => {
    Object.assign(config, { maskinportenKlientId: "klient-1", maskinportenNokkelId: "kid-1", maskinportenNokkel: privat, maskinportenUrl: undefined, skatteetatenMiljo: "test" });
    const jwt = lagGrant("skatteetaten:skattekorttilarbeidsgiver", "915000002", 1_800_000_000);
    const [h, i, s] = jwt.split(".");
    expect(JSON.parse(Buffer.from(h, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT", kid: "kid-1" });
    const innhold = JSON.parse(Buffer.from(i, "base64url").toString());
    expect(innhold).toMatchObject({
      aud: "https://test.maskinporten.no/",
      iss: "klient-1",
      scope: "skatteetaten:skattekorttilarbeidsgiver",
      iat: 1_800_000_000,
      exp: 1_800_000_100,
      authorization_details: [{ type: "urn:altinn:systemuser", systemuser_org: { authority: "iso6523-actorid-upis", ID: "0192:915000002" } }],
    });
    expect(innhold.jti).toMatch(/^[0-9a-f-]{36}$/);
    expect(verify("RSA-SHA256", Buffer.from(`${h}.${i}`), offentlig, Buffer.from(s, "base64url"))).toBe(true);
    // Uten kunde (systemregisteret og forespørslene): ingen systembruker.
    expect(JSON.parse(Buffer.from(lagGrant("altinn:authentication/systemregister.write").split(".")[1], "base64url").toString()).authorization_details).toBeUndefined();
    Object.assign(config, { maskinportenNokkel: undefined });
    expect(() => lagGrant("x")).toThrow("Nøkkelen til Maskinporten mangler");
    Object.assign(config, { maskinportenNokkel: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----" });
    expect(() => lagGrant("x")).toThrow("ikke en gyldig privat RSA-nøkkel");
    Object.assign(config, { maskinportenKlientId: undefined, maskinportenNokkelId: undefined, maskinportenNokkel: undefined });
  });

  it("tolker svaret: trekkodene, tabellkort, prosentkort, frikort, tilleggsopplysninger og ugyldige numre", () => {
    expect(trekkode("loennFraHovedarbeidsgiver")).toBe("LOENN_FRA_HOVEDARBEIDSGIVER");
    expect(trekkode("loennFraNAV")).toBe("LOENN_FRA_NAV");
    expect(trekkode("LOENN_FRA_BIARBEIDSGIVER")).toBe("LOENN_FRA_BIARBEIDSGIVER");
    const svar = tolkSvar(EKSEMPEL);
    expect(svar.map((s) => [s.fnr, s.resultat, s.aar])).toEqual([
      ["13830197340", "skattekortopplysningerOK", 2025],
      ["21908899455", "skattekortopplysningerOK", 2025],
      ["24880199664", "skattekortopplysningerOK", 2025],
      ["10829996974", "ikkeSkattekort", 2025],
    ]);
    expect(svar[1]).toMatchObject({
      utstedt: "2024-12-07",
      trekk: [
        { trekkode: "LOENN_FRA_HOVEDARBEIDSGIVER", tabell: 8010, prosent: 41, maaneder: 10.5 },
        { trekkode: "LOENN_FRA_BIARBEIDSGIVER", prosent: 34 },
        { trekkode: "LOENN_FRA_NAV", prosent: 34 },
      ],
    });
    expect(svar[2].tillegg).toEqual(["kildeskattPaaPensjon", "kildeskattPaaLoenn"]);
    expect(svar[3].trekk).toBeNull();
    // XML-navnene (resultatPaaForespoersel, trekkoder i camelCase) går også.
    expect(
      tolkSvar({
        arbeidsgiver: [{ arbeidstaker: [{ arbeidstakeridentifikator: "13830197340", resultatPaaForespoersel: "ikkeTrekkplikt", skattekort: { forskuddstrekk: [{ trekkode: "loennFraHovedarbeidsgiver", frikort: {} }] } }] }],
      })[0],
    ).toMatchObject({ resultat: "ikkeTrekkplikt", trekk: [{ trekkode: "LOENN_FRA_HOVEDARBEIDSGIVER", frikort: null }] });
  });

  it("velger trekket for hovedarbeidsgiver eller biarbeidsgiver, og skattekortet etter svaret", () => {
    const [fri, tabell, pensjon, ingen] = tolkSvar(EKSEMPEL);
    expect(kortFraTrekk(tabell.trekk!, false)).toEqual({ skattekort: "tabell", skatt_tabell: 8010, skatt_prosent: 41, skatt_frikort: null });
    expect(kortFraTrekk(tabell.trekk!, true)).toEqual({ skattekort: "prosent", skatt_tabell: null, skatt_prosent: 34, skatt_frikort: null });
    expect(kortFraTrekk(fri.trekk!, false)).toEqual({ skattekort: "frikort", skatt_tabell: null, skatt_prosent: null, skatt_frikort: 100000 });
    expect(kortFraTrekk([{ trekkode: "LOENN_FRA_HOVEDARBEIDSGIVER", frikort: null }], true)).toEqual({ skattekort: "frikort", skatt_tabell: null, skatt_prosent: null, skatt_frikort: null });
    // Bare pensjon: ikke noe trekk for lønn, og skattekortet endres ikke.
    expect(kortFraTrekk(pensjon.trekk!, false)).toBeNull();
    expect(kortFraSvar(pensjon, false)).toBeUndefined();
    expect(kortFraSvar(ingen, false)).toEqual({ skattekort: null, skatt_tabell: null, skatt_prosent: null, skatt_frikort: null });
    const s = (resultat: string): Skattekortsvar => ({ fnr: "13830197340", resultat, aar: 2026, utstedt: null, tillegg: [], trekk: null });
    expect(kortFraSvar(s("ikkeTrekkplikt"), false)).toEqual({ skattekort: "frikort", skatt_tabell: null, skatt_prosent: null, skatt_frikort: null });
    expect(kortFraSvar(s("ugyldigFoedselsEllerDnummer"), false)).toBeUndefined();
    expect(kortFraSvar(s("vurderArbeidstillatelse"), false)).toBeUndefined();
  });

  it("skjuler fødselsnumre i feilmeldinger", () => {
    expect(melding(new Error("Ugyldig arbeidstaker 13830197340 (FOR_001)"))).toBe("Ugyldig arbeidstaker ••••••••••• (FOR_001)");
    expect(melding(new Error("Org 915000010"))).toBe("Org 915000010");
  });

  it("finner referansen til bestillingen og lager bestillingen", () => {
    const h = new Headers();
    expect(finnReferanse({ data: { bestillingsreferanse: "BR1234" }, tekst: "", headers: h })).toBe("BR1234");
    expect(finnReferanse({ data: "BR77", tekst: '"BR77"', headers: h })).toBe("BR77");
    expect(finnReferanse({ data: null, tekst: "BR5", headers: h })).toBe("BR5");
    expect(finnReferanse({ data: null, tekst: "", headers: new Headers({ location: "/api/forskudd/skattekortTilArbeidsgiver/svar/BR9" }) })).toBe("BR9");
    expect(finnReferanse({ data: { ok: true }, tekst: "{}", headers: h })).toBeNull();
    expect(mobilnummer("+47 912 34 567")).toBe("+4791234567");
    expect(mobilnummer("0047 41234567")).toBe("+4741234567");
    expect(mobilnummer("22 33 44 55")).toBeNull();
    expect(bestillingskropp({ aar: 2026, orgnr: "915000002", fnr: ["13830197340"], kontakt: { epost: "post@firma.no", telefon: "22334455" } })).toEqual({
      inntektsaar: "2026",
      bestillingstype: "HENT_ALLE_OPPGITTE",
      kontaktinformasjon: { epostadresse: "post@firma.no" },
      varslingstype: "VARSEL_VED_FOERSTE_ENDRING",
      forespoerselOmSkattekortTilArbeidsgiver: { arbeidsgiver: [{ arbeidsgiveridentifikator: { organisasjonsnummer: "915000002" }, arbeidstakeridentifikator: ["13830197340"] }] },
    });
    expect(bestillingskropp({ aar: 2026, orgnr: "915000002", kontakt: { epost: null, telefon: "91234567" } })).toEqual({
      inntektsaar: "2026",
      bestillingstype: "HENT_KUN_ENDRING",
      kontaktinformasjon: { mobiltelefonummer: "+4791234567" },
      varslingstype: "VARSEL_VED_FOERSTE_ENDRING",
      forespoerselOmSkattekortTilArbeidsgiver: { arbeidsgiver: [{ arbeidsgiveridentifikator: { organisasjonsnummer: "915000002" } }] },
    });
  });
});

type Kall = { metode: string; url: string; auth: string | null; kropp: any };

describe.skipIf(!process.env.DATABASE_URL)("skattekort fra Skatteetaten", () => {
  const app = lagApi();
  const eier = "Bearer test:uid-skatt-eier:skatt-eier@server.test:mfa";
  const regnskap = "Bearer test:uid-skatt-regn:skatt-regn@server.test:mfa";
  const admin = "Bearer test:uid-skatt-admin:skatt-admin@server.test:mfa";
  const ORGNR = "915000010";
  const iAar = Number(new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Oslo", year: "numeric" }).format(new Date()));
  const ko: (Oppgave & { oppgave_id: string })[] = [];
  const kall: Kall[] = [];
  let svar: Record<string, (k: Kall) => Response> = {};
  let org: string;
  const ansatte: Record<string, string> = {};
  const json = (status: number, data: unknown) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
  const tom = (status = 204) => new Response(null, { status });

  const api = async (m: string, sti: string, k?: unknown, hvem = eier) => {
    const r = await app.request(sti, { method: m, headers: { authorization: hvem, "content-type": "application/json" }, body: k === undefined ? undefined : JSON.stringify(k) });
    const type = r.headers.get("content-type") ?? "";
    return { status: r.status, data: type.includes("json") ? ((await r.json()) as any) : null };
  };
  // Uten typer: kjører oppgavene i køen og de nye de legger i kø. Med typer: bare de av disse
  // typene som ligger i køen nå (de andre, og nye, blir liggende).
  const kjor = async (typer?: string[]) => {
    const kjort: string[] = [];
    const naa = typer ? ko.filter((o) => typer.includes(o.type)) : null;
    for (let i = 0; i < 20; i++) {
      const j = naa ? ko.findIndex((o) => naa.includes(o)) : ko.length ? 0 : -1;
      if (j < 0) break;
      const [o] = ko.splice(j, 1);
      kjort.push(o.type);
      await kjorOppgave(o);
    }
    return kjort;
  };
  const tilgang = () => somSystem((db) => en(db, "select * from faktura.skattekort_tilgang where org_id = $1", [org]));
  const ansatt = (id: string) =>
    somSystem((db) =>
      en(
        db,
        `select skattekort, skatt_tabell, skatt_prosent::float8 as skatt_prosent, skatt_frikort::float8 as skatt_frikort, skattekort_aar, biarbeidsgiver,
                skattekort_kilde, skattekort_resultat, skattekort_tillegg, skattekort_trekk, skattekort_hentet
           from faktura.ansatte where id = $1`,
        [id],
      ),
    );
  const token = (k: Kall) => {
    const [, i] = new URLSearchParams(k.kropp).get("assertion")!.split(".");
    return JSON.parse(Buffer.from(i, "base64url").toString());
  };
  const kort = (fnr: string, trekk: unknown[], ekstra: Record<string, unknown> = {}) => ({
    arbeidstakeridentifikator: fnr,
    resultatForSkattekort: "skattekortopplysningerOK",
    skattekort: { utstedtDato: `${iAar - 1}-12-05`, forskuddstrekk: trekk },
    inntektsaar: String(iAar),
    ...ekstra,
  });
  const skattesvar = (...arbeidstaker: unknown[]) => ({ arbeidsgiver: [{ arbeidsgiveridentifikator: { organisasjonsnummer: ORGNR }, arbeidstaker }] });

  beforeAll(async () => {
    Object.assign(config, {
      maskinportenKlientId: "klient-1",
      maskinportenNokkelId: "kid-1",
      maskinportenNokkel: privat,
      maskinportenUrl: "https://mp.test",
      altinnUrl: "https://altinn.test",
      skattekortUrl: "https://skatt.test/api/forskudd",
      adminEposter: ["skatt-admin@server.test"],
    });
    PAUSE.ms = 1;
    PAUSE.maks = 30;
    settKryptering(async (t) => Buffer.from(`kryptert:${t}`), async (d) => d.toString().replace(/^kryptert:/, ""));
    settLokalOppgavekjorer(async (o) => void ko.push(o));
    settEtatFetch(async (url, init) => {
      const u = new URL(String(url));
      const h = new Headers(init?.headers);
      const tekst = init?.body ? String(init.body) : null;
      const k: Kall = { metode: init?.method ?? "GET", url: `${u.host}${u.pathname}`, auth: h.get("authorization"), kropp: tekst && tekst.startsWith("{") ? JSON.parse(tekst) : tekst };
      kall.push(k);
      const nokkel = `${k.metode} ${k.url}`
        .replace(/\/request\/vendor\/byexternalref\/.+/, "/request/vendor/byexternalref/:ref")
        .replace(/\/request\/vendor\/[0-9a-f-]{36}$/, "/request/vendor/:id")
        .replace(/\/svar\/BR\d+$/, "/svar/:ref");
      if (nokkel === "POST mp.test/token") {
        const t = token(k);
        return json(200, { access_token: `tok:${t.scope}:${t.authorization_details?.[0]?.systemuser_org?.ID ?? ""}`, expires_in: 120 });
      }
      const f = svar[nokkel];
      if (!f) throw new Error(`Uventet kall: ${nokkel}`);
      return f(k);
    });

    org = (await api("POST", "/api/organisasjoner", { navn: "Skatt Test AS", orgnr: ORGNR })).data.id;
    expect((await api("PATCH", `/api/org/${org}`, { epost: "post@skatt-test.no" })).status).toBe(200);
    const inv = await api("POST", `/api/org/${org}/invitasjoner`, { epost: "skatt-regn@server.test", rolle: "regnskap" });
    expect((await api("POST", "/api/invitasjoner/aksepter", { token: inv.data.lenke.split("/").pop() }, regnskap)).status).toBe(200);
    for (const [navn, fnr, ekstra] of [
      ["Ola", "13830197340", {}],
      ["Kari", "24880199664", { biarbeidsgiver: true }],
      ["Per", null, {}],
    ] as const) {
      const r = await api("POST", `/api/org/${org}/ansatte`, { fornavn: navn, etternavn: "Skatt", ansatt_fra: `${iAar}-01-01`, ...(fnr ? { fnr } : {}), ...ekstra });
      expect(r.status).toBe(201);
      ansatte[navn] = r.data.id;
    }
    ko.length = 0;
  });

  it("er skjult til Maskinporten-klienten er satt opp", async () => {
    const id = config.maskinportenKlientId;
    (config as any).maskinportenKlientId = undefined;
    expect((await api("GET", `/api/org/${org}/skattekort`)).data).toMatchObject({ tilgjengelig: false, tilgang: null, aar: iAar, antall: { med_fnr: 2, uten_fnr: 1, fra_skatteetaten: 0 } });
    expect((await api("POST", `/api/org/${org}/skattekort/tilgang`)).data.error).toContain("ikke satt opp");
    (config as any).maskinportenKlientId = id;
    expect((await api("GET", `/api/org/${org}/skattekort`)).data).toMatchObject({ tilgjengelig: true, miljo: "test", systemnavn: "HI4 Faktura" });
  });

  it("plattformadministratoren registrerer systemet i Altinn, og oppdaterer det etterpå", async () => {
    expect((await api("GET", "/api/admin/skattekort", undefined, eier)).status).toBe(403);
    const forst = await api("GET", "/api/admin/skattekort", undefined, admin);
    expect(forst.data).toMatchObject({ oppsett: { klient_id: true, nokkel_id: true, system_id: "936564046_lonn", tilgangspakke: "urn:altinn:accesspackage:lonn" } });

    svar["GET altinn.test/authentication/api/v1/systemregister/vendor/936564046_lonn"] = () => json(404, { title: "Not Found", status: 404 });
    svar["POST altinn.test/authentication/api/v1/systemregister/vendor"] = () => json(200, "e0c3c1b4-1d7c-4bfc-9b6b-1c0a3a9b0f11");
    expect((await api("POST", "/api/admin/skattekort/system", {}, admin)).data).toEqual({ ok: true, startet: true });
    expect(await kjor()).toEqual(["altinn-system"]);
    const def = kall.find((k) => k.metode === "POST" && k.url.endsWith("/systemregister/vendor"))!;
    expect(def.auth).toBe("Bearer tok:altinn:authentication/systemregister.write:");
    expect(def.kropp).toEqual({
      id: "936564046_lonn",
      vendor: { authority: "iso6523-actorid-upis", ID: "0192:936564046" },
      name: { nb: "HI4 Faktura", nn: "HI4 Faktura", en: "HI4 Faktura" },
      description: expect.objectContaining({ nb: expect.stringContaining("skattekortene") }),
      accessPackages: [{ urn: "urn:altinn:accesspackage:lonn" }],
      clientId: ["klient-1"],
      allowedRedirectUrls: ["http://localhost:5173/skattekort/godkjent"],
      isVisible: false,
    });
    expect((await api("GET", "/api/admin/skattekort", undefined, admin)).data.system).toMatchObject({ id: "936564046_lonn", siste_feil: null });

    // Finnes systemet, oppdateres det (PUT erstatter hele definisjonen); feil fra Altinn lagres.
    svar["GET altinn.test/authentication/api/v1/systemregister/vendor/936564046_lonn"] = () => json(200, { id: "936564046_lonn" });
    svar["PUT altinn.test/authentication/api/v1/systemregister/vendor/936564046_lonn"] = () =>
      json(400, { title: "One or more validation errors occurred.", status: 400, validationErrors: [{ code: "AUTH.VLD-00004", detail: "One of the client id is already tagged with an existing system" }] });
    await api("POST", "/api/admin/skattekort/system", {}, admin);
    await kjor();
    expect((await api("GET", "/api/admin/skattekort", undefined, admin)).data.system.siste_feil).toBe(
      "Kunne ikke oppdatere systemet i Altinn: One of the client id is already tagged with an existing system (AUTH.VLD-00004)",
    );
    svar["PUT altinn.test/authentication/api/v1/systemregister/vendor/936564046_lonn"] = () => json(200, true);
    await api("POST", "/api/admin/skattekort/system", {}, admin);
    await kjor();
    expect((await api("GET", "/api/admin/skattekort", undefined, admin)).data.system.siste_feil).toBeNull();
  });

  it("eieren ber om tilgang; workeren lager forespørselen i Altinn, og regnskap ser lenken", async () => {
    expect((await api("POST", `/api/org/${org}/skattekort/tilgang`, {}, regnskap)).status).toBe(403);
    const fid = "3f2a7c1e-5b4d-4e6f-8a9b-0c1d2e3f4a5b";
    svar["POST altinn.test/authentication/api/v1/systemuser/request/vendor"] = () =>
      json(200, { id: fid, status: "New", confirmUrl: `https://am.ui.tt02.altinn.no/accessmanagement/ui/systemuser/request?id=${fid}` });
    const r = await api("POST", `/api/org/${org}/skattekort/tilgang`);
    expect(r.data.tilgang).toMatchObject({ status: "venter", godkjenn_url: null });
    expect(await kjor()).toEqual(["skattekort-tilgang"]);
    const k = kall.filter((x) => x.url.endsWith("/systemuser/request/vendor")).at(-1)!;
    expect(k.auth).toBe("Bearer tok:altinn:authentication/systemuser.request.write:");
    expect(k.kropp).toEqual({
      systemId: "936564046_lonn",
      partyOrgNo: ORGNR,
      accessPackages: [{ urn: "urn:altinn:accesspackage:lonn" }],
      redirectUrl: "http://localhost:5173/skattekort/godkjent",
    });
    const s = (await api("GET", `/api/org/${org}/skattekort`, undefined, regnskap)).data;
    expect(s.tilgang).toMatchObject({ status: "ny", godkjenn_url: `https://am.ui.tt02.altinn.no/accessmanagement/ui/systemuser/request?id=${fid}`, siste_feil: null });
    // Hjerteslaget sjekker den ikke igjen med en gang (den ble nettopp laget).
    expect(await planleggTilgangssjekk()).toBe(0);
  });

  it("når forespørselen er godkjent i Altinn, hentes skattekortene til alle de ansatte", async () => {
    let status = "New";
    svar["GET altinn.test/authentication/api/v1/systemuser/request/vendor/:id"] = () => json(200, { id: "3f2a7c1e-5b4d-4e6f-8a9b-0c1d2e3f4a5b", status, confirmUrl: "https://am.ui.tt02.altinn.no/x" });
    await somSystem((db) => db.query("update faktura.skattekort_tilgang set sjekket = null where org_id = $1", [org]));
    expect((await api("POST", `/api/org/${org}/skattekort/sjekk`, {}, regnskap)).data).toEqual({ ok: true, sjekkes: true });
    await kjor();
    expect((await tilgang()).status).toBe("ny");

    status = "Accepted";
    let forsok = 0;
    svar["POST skatt.test/api/forskudd/bestillSkattekort"] = () => json(200, { bestillingsreferanse: "BR1001" });
    svar["GET skatt.test/api/forskudd/skattekortTilArbeidsgiver/svar/:ref"] = () =>
      ++forsok < 3
        ? tom()
        : json(
            200,
            skattesvar(
              kort("13830197340", [
                { trekkode: "LOENN_FRA_HOVEDARBEIDSGIVER", trekktabell: { tabellnummer: "8010", prosentsats: 41, antallMaanederForTrekk: 10.5 } },
                { trekkode: "LOENN_FRA_BIARBEIDSGIVER", trekkprosent: { prosentsats: 34 } },
              ]),
              kort(
                "24880199664",
                [
                  { trekkode: "LOENN_FRA_HOVEDARBEIDSGIVER", trekktabell: { tabellnummer: "8115", prosentsats: 43, antallMaanederForTrekk: 10.5 } },
                  { trekkode: "LOENN_FRA_BIARBEIDSGIVER", trekkprosent: { prosentsats: 36 } },
                ],
                { tilleggsopplysning: ["oppholdPaaSvalbard"] },
              ),
            ),
          );
    await somSystem((db) => db.query("update faktura.skattekort_tilgang set sjekket = null where org_id = $1", [org]));
    await api("POST", `/api/org/${org}/skattekort/sjekk`, {}, regnskap);
    expect(await kjor()).toEqual(["skattekort-status", "skattekort-hent"]);
    expect((await tilgang()).status).toBe("godkjent");

    // Tokenet gjelder systembrukeren til organisasjonen, og bestillingen alle med fødselsnummer.
    const b = kall.filter((x) => x.url.endsWith("/bestillSkattekort")).at(-1)!;
    expect(b.auth).toBe(`Bearer tok:skatteetaten:skattekorttilarbeidsgiver:0192:${ORGNR}`);
    expect(b.kropp).toMatchObject({
      inntektsaar: String(iAar),
      bestillingstype: "HENT_ALLE_OPPGITTE",
      kontaktinformasjon: { epostadresse: "post@skatt-test.no" },
      forespoerselOmSkattekortTilArbeidsgiver: { arbeidsgiver: [{ arbeidsgiveridentifikator: { organisasjonsnummer: ORGNR } }] },
    });
    expect(b.kropp.forespoerselOmSkattekortTilArbeidsgiver.arbeidsgiver[0].arbeidstakeridentifikator.sort()).toEqual(["13830197340", "24880199664"]);
    expect(forsok).toBe(3);

    expect(await ansatt(ansatte.Ola)).toMatchObject({ skattekort: "tabell", skatt_tabell: 8010, skatt_prosent: 41, skattekort_aar: iAar, skattekort_kilde: "skatteetaten", skattekort_resultat: "skattekortopplysningerOK" });
    // Kari er biarbeidsgiverforhold: prosenttrekket for biarbeidsgiver.
    expect(await ansatt(ansatte.Kari)).toMatchObject({ skattekort: "prosent", skatt_tabell: null, skatt_prosent: 36, skattekort_kilde: "skatteetaten", skattekort_tillegg: ["oppholdPaaSvalbard"] });
    const s = (await api("GET", `/api/org/${org}/skattekort`)).data;
    expect(s.tilgang).toMatchObject({ status: "godkjent", godkjenn_url: null, siste_feil: null });
    expect(s.tilgang.sist_hentet).not.toBeNull();
    expect(s.antall).toEqual({ med_fnr: 2, fra_skatteetaten: 2, uten_fnr: 1 });
    // Skattekortet følger med de ansatte i appen.
    const kari = (await api("GET", `/api/org/${org}/ansatte/${ansatte.Kari}`)).data;
    expect(kari).toMatchObject({ biarbeidsgiver: true, skattekort_kilde: "skatteetaten", skattekort_tillegg: ["oppholdPaaSvalbard"] });
    expect(kari.skattekort_trekk).toHaveLength(2);
  });

  it("biarbeidsgiver av og på regner om skattekortet fra Skatteetaten; endret for hånd blir det manuelt", async () => {
    // Skjemaet sender hele skattekortet slik det står, sammen med det nye valget.
    const r = await api("PATCH", `/api/org/${org}/ansatte/${ansatte.Kari}`, { biarbeidsgiver: false, skattekort: "prosent", skatt_tabell: null, skatt_prosent: 36, skatt_frikort: null });
    expect(r.status).toBe(200);
    expect(await ansatt(ansatte.Kari)).toMatchObject({ biarbeidsgiver: false, skattekort: "tabell", skatt_tabell: 8115, skatt_prosent: 43, skattekort_kilde: "skatteetaten" });
    await api("PATCH", `/api/org/${org}/ansatte/${ansatte.Kari}`, { biarbeidsgiver: true });
    expect(await ansatt(ansatte.Kari)).toMatchObject({ skattekort: "prosent", skatt_prosent: 36, skattekort_kilde: "skatteetaten" });
    await api("PATCH", `/api/org/${org}/ansatte/${ansatte.Kari}`, { skatt_prosent: 40 });
    expect(await ansatt(ansatte.Kari)).toMatchObject({ skattekort: "prosent", skatt_prosent: 40, skattekort_kilde: "manuell" });
  });

  it("daglig: endringene siden sist, og de som mangler skattekortet fra Skatteetaten", async () => {
    const bestillinger: any[] = [];
    let ref = 2000;
    svar["POST skatt.test/api/forskudd/bestillSkattekort"] = (k) => {
      bestillinger.push(k.kropp);
      return new Response(`BR${++ref}`, { status: 200, headers: { "content-type": "text/plain" } });
    };
    svar["GET skatt.test/api/forskudd/skattekortTilArbeidsgiver/svar/:ref"] = (k) =>
      k.url.endsWith("BR2001")
        ? // Endringer: Ola har fått frikort; et nummer som ikke er ansatt her, hoppes over.
          json(200, skattesvar(kort("13830197340", [{ trekkode: "LOENN_FRA_HOVEDARBEIDSGIVER", frikort: { frikortbeloep: 65000 } }]), kort("13820499748", [])))
        : json(200, skattesvar({ arbeidstakeridentifikator: "24880199664", resultatForSkattekort: "ikkeSkattekort", inntektsaar: String(iAar) }));
    expect(await planleggDagligSkattekort()).toBeGreaterThanOrEqual(1);
    // Bare denne organisasjonen (databasen deles med de andre testene).
    for (let i = ko.length - 1; i >= 0; i--) if ((ko[i] as any).org_id !== org) ko.splice(i, 1);
    expect(ko).toMatchObject([{ type: "skattekort-hent", daglig: true, kilde: "automatisk" }]);
    await kjor(["skattekort-hent"]);
    ko.length = 0;
    expect(bestillinger.map((b) => [b.bestillingstype, b.forespoerselOmSkattekortTilArbeidsgiver.arbeidsgiver[0].arbeidstakeridentifikator ?? null])).toEqual([
      ["HENT_KUN_ENDRING", null],
      ["HENT_ALLE_OPPGITTE", ["24880199664"]], // Kari: skattekortet ble endret for hånd
    ]);
    expect(await ansatt(ansatte.Ola)).toMatchObject({ skattekort: "frikort", skatt_frikort: 65000, skatt_tabell: null, skattekort_kilde: "skatteetaten" });
    // Uten skattekort hos Skatteetaten: ingen (det trekkes 50 %).
    expect(await ansatt(ansatte.Kari)).toMatchObject({ skattekort: null, skatt_prosent: null, skattekort_kilde: "skatteetaten", skattekort_resultat: "ikkeSkattekort", skattekort_trekk: null });
  });

  it("et svar som ikke er klart, hentes i en ny oppgave; et svar for et tidligere år lagres ikke", async () => {
    let klar = false;
    svar["POST skatt.test/api/forskudd/bestillSkattekort"] = () => json(200, { bestillingsreferanse: "BR3001" });
    svar["GET skatt.test/api/forskudd/skattekortTilArbeidsgiver/svar/:ref"] = () =>
      klar
        ? json(
            200,
            skattesvar(
              kort("13830197340", [{ trekkode: "LOENN_FRA_HOVEDARBEIDSGIVER", trekkprosent: { prosentsats: 30 } }]),
              kort("24880199664", [{ trekkode: "LOENN_FRA_HOVEDARBEIDSGIVER", trekkprosent: { prosentsats: 20 } }], { inntektsaar: String(iAar - 1) }),
            ),
          )
        : tom();
    expect((await api("POST", `/api/org/${org}/skattekort/hent`, {})).data).toEqual({ ok: true, startet: true });
    expect((await api("POST", `/api/org/${org}/skattekort/hent`, { aar: iAar - 1 })).data.error).toContain("for i år");
    await kjor(["skattekort-hent"]);
    expect(ko).toMatchObject([{ type: "skattekort-svar", org_id: org, referanse: "BR3001", aar: iAar, forsok: 1 }]);
    await kjor(["skattekort-svar"]);
    expect(ko).toMatchObject([{ type: "skattekort-svar", forsok: 2 }]);
    klar = true;
    await kjor(["skattekort-svar"]);
    expect(ko).toHaveLength(0);
    expect(await ansatt(ansatte.Ola)).toMatchObject({ skattekort: "prosent", skatt_prosent: 30 });
    // Fjorårets skattekort erstatter ikke årets.
    expect(await ansatt(ansatte.Kari)).toMatchObject({ skattekort: null, skattekort_aar: iAar });
  });

  it("en ny ansatt med fødselsnummer får skattekortet hentet", async () => {
    const r = await api("POST", `/api/org/${org}/ansatte`, { fornavn: "Lise", etternavn: "Skatt", ansatt_fra: `${iAar}-03-01`, fnr: "21908899455" });
    expect(ko).toMatchObject([{ type: "skattekort-hent", org_id: org, ansatt_ider: [r.data.id], kilde: "ansatt" }]);
    ko.length = 0;
    // Uten fødselsnummer: ingenting å hente.
    await api("POST", `/api/org/${org}/ansatte`, { fornavn: "Uten", etternavn: "Nummer", ansatt_fra: `${iAar}-03-01` });
    expect(ko).toHaveLength(0);
  });

  it("uten systembruker i Altinn (MP-303) må tilgangen bes om på nytt", async () => {
    settEtatFetch(async (url, init) => {
      const u = new URL(String(url));
      if (u.host === "mp.test") return json(400, { error: "invalid_altinn_customer_configuration", error_description: "MP-303: Fant ingen systembruker" });
      throw new Error(`Uventet kall: ${init?.method} ${u.host}${u.pathname}`);
    });
    await api("POST", `/api/org/${org}/skattekort/hent`, {});
    await kjor(["skattekort-hent"]);
    const s = (await api("GET", `/api/org/${org}/skattekort`)).data;
    expect(s.tilgang).toMatchObject({ status: "feil" });
    expect(s.tilgang.siste_feil).toContain("Be om tilgang på nytt");
    expect((await api("POST", `/api/org/${org}/skattekort/hent`, {})).data.error).toContain("ikke godkjent");
  });

  it("Altinn: allerede godkjent, en forespørsel som venter, og en som ble avslått", async () => {
    const forespurt: string[] = [];
    let slettet = 0;
    const altinn: Record<string, (k: Kall) => Response> = {
      "POST /authentication/api/v1/systemuser/request/vendor": () => json(400, { title: "Bad Request", status: 400, detail: "existing SystemUser", code: "AUTH-00004" }),
    };
    settEtatFetch(async (url, init) => {
      const u = new URL(String(url));
      if (u.host === "mp.test") return json(200, { access_token: "tok", expires_in: 120 });
      const k: Kall = { metode: init?.method ?? "GET", url: u.pathname, auth: null, kropp: null };
      forespurt.push(`${k.metode} ${u.pathname.replace(/[0-9a-f-]{36}$/, ":id")}`);
      if (k.metode === "DELETE") return slettet++, json(200, true);
      const f = altinn[`${k.metode} ${u.pathname.replace(/\/byexternalref\/.+/, "/byexternalref").replace(/[0-9a-f-]{36}$/, ":id")}`];
      if (!f) throw new Error(`Uventet kall: ${k.metode} ${u.pathname}`);
      return f(k);
    });
    // Koble fra (eieren), og be om tilgang på nytt: Altinn sier at systemtilgangen finnes.
    expect((await api("DELETE", `/api/org/${org}/skattekort/tilgang`, undefined, regnskap)).status).toBe(403);
    await api("DELETE", `/api/org/${org}/skattekort/tilgang`);
    expect((await api("GET", `/api/org/${org}/skattekort`)).data.tilgang).toBeNull();
    await api("POST", `/api/org/${org}/skattekort/tilgang`);
    await kjor(["skattekort-tilgang"]);
    expect((await tilgang()).status).toBe("godkjent");
    expect(ko).toMatchObject([{ type: "skattekort-hent", kilde: "godkjent" }]);
    ko.length = 0;

    // En forespørsel som venter, brukes igjen.
    await api("DELETE", `/api/org/${org}/skattekort/tilgang`);
    altinn["POST /authentication/api/v1/systemuser/request/vendor"] = () => json(400, { status: 400, detail: "Pending Request, please reuse or delete.", code: "AUTH-00007" });
    altinn["GET /authentication/api/v1/systemuser/request/vendor/byexternalref"] = () =>
      json(200, { id: "11111111-2222-4333-8444-555555555555", status: "New", confirmUrl: "https://am.ui.tt02.altinn.no/venter" });
    await api("POST", `/api/org/${org}/skattekort/tilgang`);
    await kjor(["skattekort-tilgang"]);
    expect(await tilgang()).toMatchObject({ status: "ny", foresporsel_id: "11111111-2222-4333-8444-555555555555", godkjenn_url: "https://am.ui.tt02.altinn.no/venter" });

    // En som ble avslått, slettes og lages på nytt.
    await api("DELETE", `/api/org/${org}/skattekort/tilgang`);
    let gang = 0;
    altinn["POST /authentication/api/v1/systemuser/request/vendor"] = () =>
      ++gang === 1
        ? json(400, { status: 400, detail: "Rejected Request, please delete and renew the Request.", code: "AUTH-00009" })
        : json(200, { id: "66666666-7777-4888-8999-000000000000", status: "New", confirmUrl: "https://am.ui.tt02.altinn.no/ny" });
    altinn["GET /authentication/api/v1/systemuser/request/vendor/byexternalref"] = () => json(200, { id: "11111111-2222-4333-8444-555555555555", status: "Rejected" });
    await api("POST", `/api/org/${org}/skattekort/tilgang`);
    await kjor(["skattekort-tilgang"]);
    expect(slettet).toBe(1);
    expect(await tilgang()).toMatchObject({ status: "ny", foresporsel_id: "66666666-7777-4888-8999-000000000000", godkjenn_url: "https://am.ui.tt02.altinn.no/ny" });

    // Systemet er ikke registrert: feil med forklaring, og ingen nye forsøk.
    await api("DELETE", `/api/org/${org}/skattekort/tilgang`);
    altinn["POST /authentication/api/v1/systemuser/request/vendor"] = () => json(400, { status: 400, detail: "The Id does not refer to a Registered System.", code: "AUTH-00011" });
    await api("POST", `/api/org/${org}/skattekort/tilgang`);
    await kjor(["skattekort-tilgang"]);
    expect(await tilgang()).toMatchObject({ status: "feil", siste_feil: expect.stringContaining("ikke registrert i Altinn") });
    expect(forespurt.filter((x) => x.startsWith("POST")).length).toBe(5);
  });
});
