// Årsregnskapet til Altinn (aarsregnskapInnsending.ts, rutene i aarsregnskap.ts) mot en simulert
// Maskinporten, Altinn og Brønnøysunds app: av til innsendingen er slått på, organisasjonen er
// koblet til og tilgangspakken «Regnskap og økonomirapportering» er gitt (Regnskap kan koble til
// uten Lønn); tokenbyttet, instansen, skjemaene, valideringen og låsingen; statusen til det er
// signert; tilbaketrekkingen og ny sending til samme instans; feilene fra Altinn og ryddingen.
import { generateKeyPairSync } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { lagApi } from "../src/api.js";
import { glemEnhet } from "../src/aarsregnskap.js";
import { glemAltinnTokener, planleggAarsregnskapssjekk, sendAarsregnskap } from "../src/aarsregnskapInnsending.js";
import { REGNSKAP_OKONOMI_RAPPORT, systemdefinisjon, TILGANGSPAKKE, tilgangspakker } from "../src/altinn.js";
import type { Enhet } from "../src/brreg.js";
import { config } from "../src/config.js";
import { somSystem } from "../src/db.js";
import { settEtatFetch } from "../src/maskinporten.js";
import { settLokalOppgavekjorer, type Oppgave } from "../src/tjenester.js";
import { settBrreg } from "../src/verifisering.js";
import { kjorOppgave } from "../src/worker.js";

const ORGNR = "316000029";
const PARTY = "50001234";
const GUID = "0b8e7a46-6c55-4d2e-9a3e-5b2a1f4e9c11";
const APP = "/brg/aarsregnskap-vanlig-202406";

describe("tilgangspakken for årsregnskapet", () => {
  it("«Regnskap og økonomirapportering» når innsendingen er slått på", () => {
    const foer = config.aarsregnskapInnsending;
    config.aarsregnskapInnsending = false;
    expect(tilgangspakker()).not.toContain(REGNSKAP_OKONOMI_RAPPORT);
    config.aarsregnskapInnsending = true;
    expect(REGNSKAP_OKONOMI_RAPPORT).toBe("urn:altinn:accesspackage:regnskap-okonomi-rapport");
    expect(systemdefinisjon().accessPackages).toEqual(expect.arrayContaining([{ urn: TILGANGSPAKKE }, { urn: REGNSKAP_OKONOMI_RAPPORT }]));
    expect(systemdefinisjon().description.nb).toContain("Årsregnskapet fylles ut i Altinn til Brønnøysundregistrene, og signeres der.");
    config.aarsregnskapInnsending = foer;
  });
});

describe.skipIf(!process.env.DATABASE_URL)("årsregnskapet til Altinn", () => {
  const app = lagApi();
  const eier = "Bearer test:uid-aarsinn-eier:aarsinn-eier@server.test:mfa:Kari%20Nordmann";
  const regnskap = "Bearer test:uid-aarsinn-regn:aarsinn-regn@server.test:mfa";
  const fakturerer = "Bearer test:uid-aarsinn-fakt:aarsinn-fakt@server.test:mfa";
  const ko: Oppgave[] = [];
  const kall: { metode: string; sti: string; token: string; type: string | null; kropp: string }[] = [];
  const tokener: { scope: string; kunde: string | null }[] = [];
  let org = "";

  // Instansen i Brønnøysunds app (simulert): dataelementene, steget og om den er signert.
  const inst = { finnes: false, data: [] as { id: string; dataType: string }[], steg: "data", ended: null as string | null };
  let validering: unknown[] = [];
  let feilVed: { sti: RegExp; status: number; tekst: string } | null = null;

  const api = async (m: string, sti: string, b?: unknown, hvem = eier) => {
    const r = await app.request(sti, { method: m, headers: { authorization: hvem, "content-type": "application/json" }, body: b === undefined ? undefined : JSON.stringify(b) });
    return { status: r.status, data: (r.headers.get("content-type") ?? "").includes("json") ? ((await r.json()) as any) : await r.text() };
  };
  const ok = async (m: string, sti: string, b?: unknown, hvem = eier) => {
    const r = await api(m, sti, b, hvem);
    expect(r.status, `${m} ${sti}: ${JSON.stringify(r.data)}`).toBeLessThan(300);
    return r.data;
  };
  const o = (x: string) => `/api/org/${org}${x}`;
  const json = (status: number, data: unknown) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
  const kjor = async (type: string) => {
    const mine = ko.filter((x) => x.type === type);
    ko.splice(0, ko.length, ...ko.filter((x) => x.type !== type));
    for (const x of mine) await kjorOppgave({ ...x, oppgave_id: "t" } as any);
    return mine.length;
  };
  const instansen = () => ({
    id: `${PARTY}/${GUID}`,
    instanceOwner: { partyId: PARTY, organisationNumber: ORGNR },
    data: inst.data,
    process: { currentTask: inst.ended ? null : { altinnTaskType: inst.steg, elementId: inst.steg === "data" ? "Task_1" : "Task_2" }, ended: inst.ended },
  });
  const rad = () => somSystem(async (db) => (await db.query("select * from faktura.aarsregnskap where org_id = $1 and aar = 2025", [org])).rows[0]);

  beforeAll(async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
    Object.assign(config, {
      maskinportenKlientId: "klient-1",
      maskinportenNokkelId: "kid-1",
      maskinportenNokkel: privateKey,
      maskinportenUrl: "https://mp.test",
      altinnUrl: "https://altinn.test",
      brregAppUrl: "https://brg.test",
      aarsregnskapInnsending: false,
    });
    glemAltinnTokener();
    glemEnhet();
    settLokalOppgavekjorer(async (x) => void ko.push(x));
    settBrreg(async (nr) =>
      ({
        orgnr: nr, navn: "KNALLGOD REVISOR AS", adresse: null, postnr: null, poststed: null, mva_registrert: true, foretaksregisteret: true, konkurs: false,
        under_avvikling: false, slettet: false, hjemmeside: null, epost: null, organisasjonsform: "AS", stiftelsesdato: "2018-05-01",
      }) as Enhet,
      async () => [],
    );
    settEtatFetch(async (url, init) => {
      const u = new URL(String(url));
      if (u.host === "mp.test") {
        const jwt = new URLSearchParams(String(init?.body)).get("assertion")!;
        const innhold = JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString());
        tokener.push({ scope: innhold.scope, kunde: innhold.authorization_details?.[0]?.systemuser_org?.ID ?? null });
        return json(200, { access_token: "mp-token", expires_in: 120 });
      }
      const h = (init?.headers ?? {}) as Record<string, string>;
      const sti = `${u.pathname}${u.search}`;
      const metode = init?.method ?? "GET";
      kall.push({ metode, sti, token: h.authorization ?? "", type: h["content-type"] ?? null, kropp: typeof init?.body === "string" ? init.body : "" });
      if (feilVed?.sti.test(sti)) return new Response(feilVed.tekst, { status: feilVed.status, headers: { "content-type": "application/problem+json" } });
      if (u.host === "altinn.test" && u.pathname === "/authentication/api/v1/exchange/maskinporten") return new Response('"eyJhbGc.altinn.signatur"', { status: 200 });
      if (u.host !== "brg.test") throw new Error(`Uventet kall: ${u.href}`);
      const instansSti = `${APP}/instances/${PARTY}/${GUID}`;
      if (metode === "POST" && sti === `${APP}/instances/create`) {
        Object.assign(inst, { finnes: true, data: [{ id: "d-hoved", dataType: "Hovedskjema" }], steg: "data", ended: null });
        return json(201, instansen());
      }
      if (!inst.finnes) return json(404, { title: "Not found" });
      if (metode === "GET" && sti === instansSti) return json(200, instansen());
      if (metode === "PUT" && sti.startsWith(`${instansSti}/data/`)) return json(200, { id: sti.split("/").pop() });
      if (metode === "POST" && sti === `${instansSti}/data?dataType=Underskjema`) {
        inst.data.push({ id: "d-under", dataType: "Underskjema" });
        return json(201, { id: "d-under", dataType: "Underskjema" });
      }
      if (metode === "GET" && sti === `${instansSti}/validate`) return json(200, validering);
      if (metode === "PUT" && sti === `${instansSti}/process/next`) {
        const handling = JSON.parse(String(init?.body)).action;
        if (handling === "confirm" && inst.steg === "data") inst.steg = "signing";
        else if (handling === "reject" && inst.steg === "signing") inst.steg = "data";
        else return json(409, { title: "Conflict", detail: `Kan ikke ${handling} i steget ${inst.steg}` });
        return json(200, { currentTask: { altinnTaskType: inst.steg } });
      }
      throw new Error(`Uventet kall til appen: ${metode} ${sti}`);
    });

    org = (await ok("POST", "/api/organisasjoner", { navn: "Knallgod Revisor AS", orgnr: ORGNR })).id;
    await ok("PATCH", o(""), { kontonr: "86011117947" });
    for (const [hvem, epost, rolle] of [
      [regnskap, "aarsinn-regn@server.test", "regnskap"],
      [fakturerer, "aarsinn-fakt@server.test", "fakturerer"],
    ] as const) {
      const inv = await ok("POST", o("/invitasjoner"), { epost, rolle });
      expect((await api("POST", "/api/invitasjoner/aksepter", { token: inv.lenke.split("/").pop() }, hvem)).status).toBe(200);
    }
    const bilag = (dato: string, debet: string, kredit: string, belop: number) =>
      ok("POST", o("/regnskap/bilag"), { dato, tekst: "Bilag", linjer: [{ konto: debet, debet: belop }, { konto: kredit, kredit: belop }] });
    await bilag("2025-01-02", "1920", "2000", 30000);
    await bilag("2025-03-31", "1920", "3200", 50000);
    await bilag("2025-06-30", "6300", "1920", 10000);
    await ok("POST", o("/regnskap/aarsoppgjor/2025"), { skatt: 8800 });
    await ok("PUT", o("/regnskap/aarsregnskap/2025"), { fastsettelsesdato: "2026-05-20", bekreftende: "Kari Nordmann", revideres: false, aarsverk: 0 });
  });

  it("av til innsendingen er slått på, organisasjonen er koblet til og tilgangspakken er gitt", async () => {
    const a = await ok("GET", o("/regnskap/aarsregnskap?aar=2025"));
    expect(a.feil).toEqual([]);
    expect(a.altinn).toMatchObject({ pa: false, status: null, har_pakke: false, pakke: "Regnskap og økonomirapportering" });
    expect((await api("POST", o("/regnskap/aarsregnskap/2025/send"))).data.error).toBe(
      "Innsendingen til Altinn er ikke slått på ennå. Last ned skjemaene og send dem selv i mellomtiden.",
    );
    config.aarsregnskapInnsending = true;
    expect((await api("POST", o("/regnskap/aarsregnskap/2025/send"))).data.error).toBe("Koble organisasjonen til Altinn først (Gi tilgang i Altinn).");
    // Regnskap kan be om tilgangen uten Lønn; fakturereren kan ikke.
    expect((await api("POST", o("/regnskap/altinn/tilgang"), undefined, fakturerer)).status).toBe(403);
    const t = await ok("POST", o("/regnskap/altinn/tilgang"), undefined, regnskap);
    expect(t).toMatchObject({ pa: true, status: "venter" });
    expect(ko.map((x) => x.type)).toEqual(["skattekort-tilgang"]);
    ko.length = 0;
    // Godkjent i Altinn, men uten tilgangspakken for årsregnskapet: utvid tilgangen.
    await somSystem((db) => db.query("update faktura.skattekort_tilgang set status = 'godkjent', pakker = $2 where org_id = $1", [org, [TILGANGSPAKKE]]));
    const r = await api("POST", o("/regnskap/aarsregnskap/2025/send"));
    expect(r.status).toBe(409);
    expect(r.data.error).toBe("Utvid tilgangen i Altinn med tilgangspakken «Regnskap og økonomirapportering» først.");
    expect((await ok("GET", o("/regnskap/altinn"), undefined, regnskap)).mangler).toEqual(["Regnskap og økonomirapportering"]);
    expect(await ok("POST", o("/regnskap/altinn/utvid"), undefined, regnskap)).toMatchObject({ endring_status: "venter" });
    expect(ko.map((x) => x.type)).toEqual(["altinn-endring"]);
    ko.length = 0;
    expect(kall).toEqual([]);
    // Daglig leder godkjenner endringen i Altinn, og workeren ser det (så hjerteslaget i de andre
    // testene, som bruker samme database, ikke finner en endring som venter).
    await somSystem((db) =>
      db.query("update faktura.skattekort_tilgang set endring_status = 'godkjent', sjekket = now(), pakker = $2 where org_id = $1", [
        org,
        [TILGANGSPAKKE, REGNSKAP_OKONOMI_RAPPORT],
      ]),
    );
  });

  it("sendes til signering: tokenbyttet, instansen, skjemaene, valideringen og låsingen", async () => {
    await somSystem((db) => db.query("update faktura.skattekort_tilgang set pakker = $2 where org_id = $1", [org, [TILGANGSPAKKE, REGNSKAP_OKONOMI_RAPPORT]]));
    const a = await ok("POST", o("/regnskap/aarsregnskap/2025/send"));
    expect(a.innsending).toMatchObject({ status: "sender" });
    // Sendt: opplysningene kan ikke endres, og det kan ikke sendes to ganger.
    expect((await api("PUT", o("/regnskap/aarsregnskap/2025"), { bekreftende: "Ola Nordmann" })).status).toBe(409);
    expect((await api("POST", o("/regnskap/aarsregnskap/2025/send"))).status).toBe(409);
    expect(await kjor("aarsregnskap-send")).toBe(1);

    expect(tokener).toEqual([{ scope: "altinn:instances.read altinn:instances.write", kunde: `0192:${ORGNR}` }]);
    const lagret = await rad();
    expect(kall.map((k) => [k.metode, k.sti])).toEqual([
      ["GET", "/authentication/api/v1/exchange/maskinporten?ttl=3600"],
      ["POST", `${APP}/instances/create`],
      ["PUT", `${APP}/instances/${PARTY}/${GUID}/data/d-hoved`],
      ["POST", `${APP}/instances/${PARTY}/${GUID}/data?dataType=Underskjema`],
      ["GET", `${APP}/instances/${PARTY}/${GUID}/validate`],
      ["PUT", `${APP}/instances/${PARTY}/${GUID}/process/next`],
      ["GET", `${APP}/instances/${PARTY}/${GUID}`],
    ]);
    expect(kall[0]!.token).toBe("Bearer mp-token");
    expect(kall.slice(1).every((k) => k.token === "Bearer eyJhbGc.altinn.signatur")).toBe(true);
    expect(JSON.parse(kall[1]!.kropp)).toEqual({ instanceOwner: { organisationNumber: ORGNR } });
    // Skjemaene som XML, slik de ble lagret da de ble sendt.
    expect(kall[2]).toMatchObject({ type: "application/xml", kropp: lagret.hovedskjema });
    expect(kall[3]).toMatchObject({ type: "application/xml", kropp: lagret.underskjema });
    expect(lagret.hovedskjema).toContain('<organisasjonsnummer orid="18">316000029</organisasjonsnummer>');
    expect(lagret.underskjema).toContain('<aarsresultat><aarets orid="172">31200</aarets>');
    expect(JSON.parse(kall[5]!.kropp)).toEqual({ action: "confirm" });

    const b = await ok("GET", o("/regnskap/aarsregnskap?aar=2025"));
    expect(b.innsending).toMatchObject({
      status: "til_signering",
      laast: true,
      feil: null,
      instans_url: `https://brg.test${APP}/#/instance/${PARTY}/${GUID}`,
    });
    // Skjemaene som lastes ned, er de som ble sendt.
    expect((await api("GET", o("/regnskap/aarsregnskap/2025/hovedskjema.xml"))).data).toBe(lagret.hovedskjema);
  });

  it("trekkes tilbake (låses opp i Altinn) og sendes på nytt til samme instans", async () => {
    kall.length = 0;
    expect((await api("POST", o("/regnskap/aarsregnskap/2025/tilbake"), undefined, fakturerer)).status).toBe(403);
    await ok("POST", o("/regnskap/aarsregnskap/2025/tilbake"));
    expect(await kjor("aarsregnskap-tilbake")).toBe(1);
    expect(inst.steg).toBe("data");
    expect(kall.map((k) => [k.metode, k.sti.replace(`${APP}/instances/${PARTY}/${GUID}`, "…"), k.kropp])).toEqual([
      ["GET", "…", ""],
      ["PUT", "…/process/next", '{"action":"reject"}'],
      ["GET", "…", ""],
    ]);
    let a = await ok("GET", o("/regnskap/aarsregnskap?aar=2025"));
    expect(a.innsending).toMatchObject({ status: "utkast", laast: false });
    a = await ok("PUT", o("/regnskap/aarsregnskap/2025"), { bekreftende: "Ola Nordmann" });
    expect(a.feil).toEqual([]);

    kall.length = 0;
    await ok("POST", o("/regnskap/aarsregnskap/2025/send"));
    expect(await kjor("aarsregnskap-send")).toBe(1);
    // Samme instans: ingen ny, og underskjemaet erstattes.
    expect(kall.map((k) => [k.metode, k.sti.replace(`${APP}/instances/${PARTY}/${GUID}`, "…")])).toEqual([
      ["GET", "…"],
      ["PUT", "…/data/d-hoved"],
      ["PUT", "…/data/d-under"],
      ["GET", "…/validate"],
      ["PUT", "…/process/next"],
      ["GET", "…"],
    ]);
    expect(kall[1]!.kropp).toContain("Ola Nordmann");
    expect((await rad()).status).toBe("til_signering");
  });

  it("levert når det er signert i Altinn", async () => {
    // Nylig sjekket: ingen ny sjekk ennå.
    expect(await planleggAarsregnskapssjekk()).toBe(0);
    expect((await ok("POST", o("/regnskap/aarsregnskap/2025/sjekk"))).sjekkes).toBe(false);
    await somSystem((db) => db.query("update faktura.aarsregnskap set sjekket_at = now() - interval '1 hour' where org_id = $1", [org]));
    // Ikke signert ennå.
    expect(await planleggAarsregnskapssjekk()).toBe(1);
    expect(await kjor("aarsregnskap-status")).toBe(1);
    expect((await rad()).status).toBe("til_signering");
    // Signert: levert.
    inst.ended = "2026-10-17T12:00:00Z";
    await somSystem((db) => db.query("update faktura.aarsregnskap set sjekket_at = now() - interval '1 hour' where org_id = $1", [org]));
    expect((await ok("POST", o("/regnskap/aarsregnskap/2025/sjekk"))).sjekkes).toBe(true);
    expect(await kjor("aarsregnskap-status")).toBe(1);
    const a = await ok("GET", o("/regnskap/aarsregnskap?aar=2025"));
    expect(a.innsending.status).toBe("levert");
    expect(Date.parse(a.innsending.levert_at)).toBe(Date.parse("2026-10-17T12:00:00Z"));
    expect((await api("PUT", o("/regnskap/aarsregnskap/2025"), { bekreftende: "Noen" })).data.error).toBe("Årsregnskapet er levert");
    expect((await api("POST", o("/regnskap/aarsregnskap/2025/tilbake"))).status).toBe(409);
  });

  it("feil fra Altinn: valideringsfeil, varige feil og feil som prøves igjen; revideres det, låses det ikke", async () => {
    // Fra begynnelsen igjen: uten instans i Altinn.
    const opp = async () => {
      await somSystem((db) =>
        db.query(
          `update faktura.aarsregnskap set status = 'utkast', instans = null, instans_url = null, laast = false, feil = null, valideringsfeil = null,
                  opplysninger = '{}' where org_id = $1 and aar = 2025`,
          [org],
        ),
      );
      Object.assign(inst, { finnes: false, data: [], steg: "data", ended: null });
      await ok("PUT", o("/regnskap/aarsregnskap/2025"), { fastsettelsesdato: "2026-05-20", bekreftende: "Kari Nordmann", revideres: false, aarsverk: 0 });
    };
    await opp();
    validering = [
      { severity: 1, code: "VAL_37467", description: "Du må oppgi antall årsverk.", field: "noter.noteAarsverkTjenestePensjon.antallAarsverk" },
      { severity: 2, code: "MYK_VAL_20488", description: "Aksjekapitalen er under 30 000 kr." },
    ];
    await ok("POST", o("/regnskap/aarsregnskap/2025/send"));
    await kjor("aarsregnskap-send");
    let a = await ok("GET", o("/regnskap/aarsregnskap?aar=2025"));
    expect(a.innsending).toMatchObject({ status: "feil", feil: "Altinn fant feil i årsregnskapet (se under)." });
    expect(a.innsending.valideringsfeil).toEqual([
      { alvor: "feil", kode: "VAL_37467", tekst: "Du må oppgi antall årsverk.", felt: "noter.noteAarsverkTjenestePensjon.antallAarsverk" },
      { alvor: "advarsel", kode: "MYK_VAL_20488", tekst: "Aksjekapitalen er under 30 000 kr.", felt: null },
    ]);
    // Rettet: sendes på nytt til samme instans, og advarslene blir stående.
    validering = [{ severity: 2, code: "MYK_VAL_20488", description: "Aksjekapitalen er under 30 000 kr." }];
    kall.length = 0;
    await ok("POST", o("/regnskap/aarsregnskap/2025/send"));
    await kjor("aarsregnskap-send");
    expect(kall.filter((k) => k.sti.endsWith("/instances/create"))).toEqual([]);
    a = await ok("GET", o("/regnskap/aarsregnskap?aar=2025"));
    expect(a.innsending).toMatchObject({ status: "til_signering", laast: true });
    expect(a.innsending.valideringsfeil).toHaveLength(1);
    validering = [];

    // Skal det revideres, låses det ikke (revisjonsberetningen legges ved i Altinn).
    await opp();
    await ok("PUT", o("/regnskap/aarsregnskap/2025"), { revideres: true });
    kall.length = 0;
    await ok("POST", o("/regnskap/aarsregnskap/2025/send"));
    await kjor("aarsregnskap-send");
    expect(kall.some((k) => k.sti.endsWith("/process/next"))).toBe(false);
    expect(await rad()).toMatchObject({ status: "til_signering", laast: false });

    // Altinn avviser (403): feil med Altinns tekst. Altinn svarer ikke (500): prøves igjen.
    await opp();
    feilVed = { sti: /instances\/create$/, status: 403, tekst: JSON.stringify({ title: "Forbidden", detail: "Systembrukeren har ikke tilgang til tjenesten" }) };
    await ok("POST", o("/regnskap/aarsregnskap/2025/send"));
    await kjor("aarsregnskap-send");
    expect(await rad()).toMatchObject({ status: "feil", feil: "Altinn laget ikke årsregnskapet: Systembrukeren har ikke tilgang til tjenesten" });
    feilVed = { sti: /instances\/create$/, status: 500, tekst: "Internal Server Error" };
    await ok("POST", o("/regnskap/aarsregnskap/2025/send"));
    const id = (await rad()).id;
    await expect(sendAarsregnskap(org, id)).rejects.toThrow();
    ko.length = 0;
    expect((await rad()).status).toBe("sender");
    feilVed = null;
    // En innsending som ikke ble ferdig på en halvtime, får feil, så den kan sendes på nytt.
    await somSystem((db) => db.query("update faktura.aarsregnskap set sendt_at = now() - interval '31 minutes' where id = $1", [id]));
    await planleggAarsregnskapssjekk();
    expect(await rad()).toMatchObject({ status: "feil", feil: "Innsendingen til Altinn ble ikke ferdig. Prøv igjen." });
  });
});
