// Mva-meldingen til Skatteetaten fra appen (mvaInnsending.ts, idporten.ts, 0125_mva_innsending.sql)
// mot en simulert ID-porten, Skatteetatens validering og Skatteetatens app i Altinn: av til den er
// slått på; sjekkene før innloggingen (terminen, tilgangen, mva-registreringen og merknadene);
// innloggingen med PKCE og nonce, tokenbyttet med klientens nøkkel og ID-tokenet; valideringen,
// tokenbyttet til Altinn, instansen, konvolutten, meldingen og innsendingen; terminen som levert,
// betalingsinformasjonen og tilbakemeldingen med kvitteringen; avbrutt innlogging, feil fra
// ID-porten, ugyldig melding, manglende rettigheter og avvisning i Altinn; svar som ikke kom fram
// etter innsendingen; og ryddingen.
import { createHash, generateKeyPairSync, sign, verify } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { lagApi } from "../src/api.js";
import { config } from "../src/config.js";
import { somSystem } from "../src/db.js";
import { glemIdportenOppsett, IDPORTEN_SCOPE } from "../src/idporten.js";
import { settKryptering } from "../src/kryptering.js";
import { settEtatFetch } from "../src/maskinporten.js";
import { ryddMvaInnsendinger } from "../src/mvaInnsending.js";
import { settLokalOppgavekjorer, type Oppgave } from "../src/tjenester.js";
import { kjorOppgave } from "../src/worker.js";

const ORGNR = "811001007";
const PARTY = "50012345";
const GUID = "7d1f3c2a-5b6e-4f80-9a1b-2c3d4e5f6a7b";
const INSTANS = `${PARTY}/${GUID}`;
const APP = "/skd/mva-melding-innsending-test";
const UTSTEDER = "https://idporten.test";
const VALIDERING = "https://validering.test/api/mva/grensesnittstoette/mva-melding/valider";
const KLIENT = "mva-klient";

const b64 = (x: unknown) => Buffer.from(typeof x === "string" ? x : JSON.stringify(x)).toString("base64url");
const fraB64 = (x: string) => JSON.parse(Buffer.from(x, "base64url").toString());

// ID-portens nøkkel (signerer ID-tokenet) og klientens nøkkel (tokenbyttet, private_key_jwt).
const idp = generateKeyPairSync("rsa", { modulusLength: 2048 });
const klient = generateKeyPairSync("rsa", { modulusLength: 2048 });
const idToken = (innhold: Record<string, unknown>) => {
  const h = b64({ alg: "RS256", typ: "JWT", kid: "idp-1" });
  const i = b64(innhold);
  return `${h}.${i}.${sign("RSA-SHA256", Buffer.from(`${h}.${i}`), idp.privateKey).toString("base64url")}`;
};
const ALTINN_TOKEN = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ iss: "altinn", exp: Math.floor(Date.now() / 1000) + 1800 })}.c2lnbmF0dXI`;

const GYLDIG = '<?xml version="1.0" encoding="UTF-8"?><valideringsresultat><status>GYLDIG_SKATTEMELDING</status></valideringsresultat>';
const AVVIKENDE = `<?xml version="1.0" encoding="UTF-8"?><valideringsresultat>
  <status>AVVIKENDE_SKATTEMELDING</status>
  <valideringsfeil>
    <stiTilFeil>/mvaMeldingDto/skattegrunnlagOgBeregnetSkatt/mvaSpesifikasjonslinje[2]</stiTilFeil>
    <valideringsDetaljer>
      <feilmelding>Grunnlaget er høyt sammenlignet med tidligere terminer</feilmelding>
      <alvorlighetsgrad>AVVIKENDE_SKATTEMELDING</alvorlighetsgrad>
      <avvikKode>R099</avvikKode>
      <mvaKode>3</mvaKode>
    </valideringsDetaljer>
  </valideringsfeil>
</valideringsresultat>`;
const UGYLDIG = `<?xml version="1.0" encoding="UTF-8"?><valideringsresultat>
  <status>UGYLDIG_SKATTEMELDING</status>
  <valideringsfeil>
    <stiTilFeil>/mvaMeldingDto/skattegrunnlagOgBeregnetSkatt/fastsattMerverdiavgift</stiTilFeil>
    <valideringsDetaljer>
      <feilmelding>Summen av linjene stemmer ikke med fastsatt merverdiavgift</feilmelding>
      <alvorlighetsgrad>UGYLDIG_SKATTEMELDING</alvorlighetsgrad>
      <avvikKode>R018</avvikKode>
    </valideringsDetaljer>
  </valideringsfeil>
</valideringsresultat>`;
const BETALING = `<?xml version='1.0' encoding='UTF-8'?>
<betalingsinformasjon xmlns="no:skatteetaten:fastsetting:avgift:mva:skattemeldingformerverdiavgift:betalingsinformasjon:v1.0">
  <innsendingsreferanse>${INSTANS}</innsendingsreferanse>
  <kundeidentifikasjonsnummer>40000123456789</kundeidentifikasjonsnummer>
  <beloep>750</beloep>
  <betaleTil>Skatteetaten</betaleTil>
  <betalingsfrist>2026-10-12</betalingsfrist>
  <betalesTilKonto><norskKontonummer>63450618065</norskKontonummer></betalesTilKonto>
</betalingsinformasjon>`;
const INGEN_AVVIK =
  '<valideringsresultat xmlns="no:skatteetaten:fastsetting:avgift:mva:valideringsresultat:v1"><avvikVedMeldingslevering>ingen avvik</avvikVedMeldingslevering></valideringsresultat>';
const KVITTERING = Buffer.from("%PDF-1.7\nkvittering for mva-meldingen\n%%EOF");

describe.skipIf(!process.env.DATABASE_URL)("mva-meldingen til Skatteetaten fra appen", () => {
  const app = lagApi();
  const eier = "Bearer test:uid-mvainn-eier:mvainn-eier@server.test:mfa:Kari%20Nordmann";
  const regnskap = "Bearer test:uid-mvainn-regn:mvainn-regn@server.test:mfa:Rune%20Regnskap";
  const fakturerer = "Bearer test:uid-mvainn-fakt:mvainn-fakt@server.test:mfa";
  const ko: Oppgave[] = [];
  const kall: { metode: string; url: string; token: string; type: string | null; kropp: string; hoder: Record<string, string> }[] = [];
  let org = "";

  // ID-porten (simulert): kodene den har gitt ut, med det appen sendte med til ID-porten.
  const koder = new Map<string, { utfordring: string; nonce: string; tilbake: string; brukt: boolean }>();
  const bytter: { felt: Record<string, string>; hode: any; innhold: any; signatur: boolean }[] = [];
  let tokenSvar: { status: number; data: unknown } | null = null;
  let feilNonce = false;
  let valideringssvar = GYLDIG;

  // Instansen i Skatteetatens app (simulert): steget, dataelementene og tilbakemeldingen.
  const inst = {
    steg: "utfylling" as "utfylling" | "bekreftelse" | "tilbakemelding" | "ferdig",
    data: [] as { id: string; dataType: string; contentType: string }[],
    konvolutt: "",
    melding: "",
    nektInstans: false,
    avvisInnsending: false,
    bruddEtterInnsending: false,
  };
  const instansen = () => ({
    id: INSTANS,
    instanceOwner: { partyId: PARTY, organisationNumber: ORGNR },
    appId: "skd/mva-melding-innsending-test",
    data: inst.data,
    process:
      inst.steg === "ferdig"
        ? { currentTask: null, ended: "2026-10-18T10:15:00Z" }
        : {
            currentTask: {
              utfylling: { elementId: "Task_1", name: "Utfylling", altinnTaskType: "data" },
              bekreftelse: { elementId: "Task_2", name: "Bekreftelse", altinnTaskType: "confirmation" },
              tilbakemelding: { elementId: "Task_3", name: "Tilbakemelding", altinnTaskType: "feedback" },
            }[inst.steg],
            ended: null,
          },
    status: inst.steg === "ferdig" ? { substatus: { label: "Mottatt", description: "Skatteetaten har mottatt mva-meldingen." } } : null,
  });

  const api = async (m: string, sti: string, b?: unknown, hvem = eier) => {
    const r = await app.request(sti, { method: m, headers: { authorization: hvem, "content-type": "application/json" }, body: b === undefined ? undefined : JSON.stringify(b) });
    const type = r.headers.get("content-type") ?? "";
    return { status: r.status, type, data: type.includes("json") ? ((await r.json()) as any) : Buffer.from(await r.arrayBuffer()) };
  };
  const ok = async (m: string, sti: string, b?: unknown, hvem = eier) => {
    const r = await api(m, sti, b, hvem);
    expect(r.status, `${m} ${sti}: ${JSON.stringify(r.data)}`).toBeLessThan(300);
    return r.data;
  };
  const o = (x: string) => `/api/org/${org}${x}`;
  const json = (status: number, data: unknown) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
  const kjor = async (type: Oppgave["type"]) => {
    const mine = ko.filter((x) => x.type === type);
    ko.splice(0, ko.length, ...ko.filter((x) => x.type !== type));
    for (const x of mine) await kjorOppgave({ ...x, oppgave_id: "t" } as any);
    return mine;
  };
  const rad = (id: string) => somSystem(async (db) => (await db.query("select * from faktura.mva_innsendinger where id = $1", [id])).rows[0]);
  const terminrad = (termin: number) =>
    somSystem(async (db) => (await db.query("select * from faktura.mva_terminer where org_id = $1 and aar = 2026 and type = 'tomaaneder' and termin = $2", [org, termin])).rows[0]);
  // Innloggingen i ID-porten: brukeren logger inn, og ID-porten gir appen en kode.
  const logginn = (url: string, kode: string) => {
    const u = new URL(url);
    const p = Object.fromEntries(u.searchParams);
    koder.set(kode, { utfordring: p.code_challenge!, nonce: p.nonce!, tilbake: p.redirect_uri!, brukt: false });
    return p;
  };
  // Appen starter innsendingen, brukeren logger inn, og appen gir koden til API-et.
  const sendInn = async (termin: number, kode: string, merknader?: unknown[]) => {
    const s = await ok("POST", o(`/regnskap/mva/2026/${termin}/send`), merknader ? { merknader } : {});
    const p = logginn(s.url, kode);
    const t = await ok("POST", o("/regnskap/mva/idporten"), { state: p.state, code: kode });
    expect(t).toEqual({ id: s.id, aar: 2026, termin, status: "sender" });
    return s.id as string;
  };

  beforeAll(async () => {
    Object.assign(config, {
      mvaInnsending: false,
      idportenKlientId: KLIENT,
      idportenNokkelId: "kid-klient",
      idportenNokkel: klient.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      idportenHemmelighet: undefined,
      idportenUrl: UTSTEDER,
      mvaValideringUrl: VALIDERING,
      mvaAppUrl: `https://skd.test${APP}`,
      altinnUrl: "https://altinn.test",
      versjon: "api-00042-abc",
    });
    glemIdportenOppsett();
    settKryptering(async (t) => Buffer.from(`kryptert:${t}`), async (d) => d.toString().replace(/^kryptert:/, ""));
    settLokalOppgavekjorer(async (x) => void ko.push(x));
    settEtatFetch(async (url, init) => {
      const u = new URL(String(url));
      const metode = init?.method ?? "GET";
      const hoder = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
      const kropp = typeof init?.body === "string" ? init.body : "";
      kall.push({ metode, url: `${u.host}${u.pathname}${u.search}`, token: hoder.authorization ?? "", type: hoder["content-type"] ?? null, kropp, hoder });

      // ID-porten: oppsettet, nøklene og tokenbyttet.
      if (u.href === `${UTSTEDER}/.well-known/openid-configuration`)
        return json(200, { issuer: UTSTEDER, authorization_endpoint: "https://login.idporten.test/authorize", token_endpoint: `${UTSTEDER}/token`, jwks_uri: `${UTSTEDER}/jwks.json` });
      if (u.href === `${UTSTEDER}/jwks.json`) return json(200, { keys: [{ ...idp.publicKey.export({ format: "jwk" }), kid: "idp-1", use: "sig", alg: "RS256" }] });
      if (u.href === `${UTSTEDER}/token` && metode === "POST") {
        const felt = Object.fromEntries(new URLSearchParams(kropp));
        const [h, i, s] = (felt.client_assertion ?? "..").split(".");
        const signatur = verify("RSA-SHA256", Buffer.from(`${h}.${i}`), klient.publicKey, Buffer.from(s ?? "", "base64url"));
        bytter.push({ felt, hode: fraB64(h!), innhold: fraB64(i!), signatur });
        if (tokenSvar) return json(tokenSvar.status, tokenSvar.data);
        const k = koder.get(felt.code ?? "");
        if (!k || k.brukt) return json(400, { error: "invalid_grant", error_description: "Invalid authorization code" });
        k.brukt = true;
        const pkce = createHash("sha256").update(felt.code_verifier ?? "").digest("base64url") === k.utfordring;
        if (!signatur || !pkce || felt.redirect_uri !== k.tilbake) return json(400, { error: "invalid_client" });
        const naa = Math.floor(Date.now() / 1000);
        return json(200, {
          access_token: "idporten-token",
          id_token: idToken({ iss: UTSTEDER, aud: KLIENT, sub: "pers-1", acr: "idporten-loa-substantial", iat: naa, exp: naa + 120, nonce: feilNonce ? "en-annen" : k.nonce }),
          token_type: "Bearer",
          expires_in: 1800,
          scope: IDPORTEN_SCOPE,
        });
      }
      // Skatteetatens validering.
      if (`https://${u.host}${u.pathname}` === VALIDERING && metode === "POST") return new Response(valideringssvar, { status: 200, headers: { "content-type": "application/xml" } });
      // Altinn: ID-porten-tokenet byttes til et Altinn-token.
      if (u.host === "altinn.test" && u.pathname === "/authentication/api/v1/exchange/id-porten")
        return new Response(`"${ALTINN_TOKEN}"`, { status: 200, headers: { "content-type": "text/plain" } });
      if (u.host !== "skd.test") throw new Error(`Uventet kall: ${u.href}`);

      // Skatteetatens app i Altinn.
      const sti = `${u.pathname}${u.search}`;
      const i = `${APP}/instances/${INSTANS}`;
      if (metode === "POST" && sti === `${APP}/instances/`) {
        if (inst.nektInstans) return json(403, { title: "Forbidden", status: 403 });
        Object.assign(inst, {
          steg: "utfylling",
          data: [{ id: "d-konvolutt", dataType: "no.skatteetaten.fastsetting.avgift.mva.mvameldinginnsending.v1.0", contentType: "application/xml" }],
          konvolutt: "",
          melding: "",
        });
        return json(201, instansen());
      }
      if (metode === "GET" && sti === i) return json(200, instansen());
      if (metode === "PUT" && sti === `${i}/data/d-konvolutt`) {
        inst.konvolutt = kropp;
        return json(200, inst.data[0]);
      }
      if (metode === "POST" && sti === `${i}/data?dataType=mvamelding`) {
        inst.melding = kropp;
        inst.data.push({ id: "d-melding", dataType: "mvamelding", contentType: "text/xml" });
        return json(201, inst.data.at(-1));
      }
      if (metode === "PUT" && sti === `${i}/process/next`) {
        if (inst.steg === "utfylling") inst.steg = "bekreftelse";
        else if (inst.steg === "bekreftelse") {
          if (inst.avvisInnsending) return new Response(UGYLDIG, { status: 409, headers: { "content-type": "application/xml" } });
          inst.steg = "tilbakemelding";
          inst.data.push({ id: "d-betaling", dataType: "betalingsinformasjon", contentType: "application/xml" });
          if (inst.bruddEtterInnsending) {
            inst.bruddEtterInnsending = false;
            throw new TypeError("fetch failed (socket hang up)");
          }
        } else return json(409, { title: "Conflict", detail: `Prosessen kan ikke gå videre fra ${inst.steg}` });
        return json(200, instansen().process);
      }
      if (metode === "GET" && sti === `${i}/feedback/status`) return json(200, { isFeedbackProvided: inst.steg === "ferdig" });
      if (metode === "GET" && sti === `${i}/data/d-betaling`) return new Response(BETALING, { status: 200, headers: { "content-type": "application/xml" } });
      if (metode === "GET" && sti === `${i}/data/d-resultat`) return new Response(INGEN_AVVIK, { status: 200, headers: { "content-type": "application/xml" } });
      if (metode === "GET" && sti === `${i}/data/d-kvittering`) return new Response(KVITTERING, { status: 200, headers: { "content-type": "application/pdf" } });
      throw new Error(`Uventet kall til appen: ${metode} ${sti}`);
    });

    org = (await ok("POST", "/api/organisasjoner", { navn: "Mva til Skatteetaten AS", orgnr: ORGNR })).id;
    await ok("PATCH", o(""), { kontonr: "86011117947", mva_registrert: true });
    for (const [hvem, epost, rolle] of [
      [regnskap, "mvainn-regn@server.test", "regnskap"],
      [fakturerer, "mvainn-fakt@server.test", "fakturerer"],
    ] as const) {
      const inv = await ok("POST", o("/invitasjoner"), { epost, rolle });
      expect((await api("POST", "/api/invitasjoner/aksepter", { token: inv.lenke.split("/").pop() }, hvem)).status).toBe(200);
    }
    const kunde = (await ok("POST", o("/kunder"), { navn: "Pasient AS", epost: "post@pasient.test" })).id;
    // 4. termin 2026: salg med 25 % mva og en utgift med fradrag (å betale 750 kr).
    const f = await ok("POST", o("/fakturaer"), { kunde_id: kunde, fakturadato: "2026-07-10", forfallsdato: "2026-07-24", linjer: [{ beskrivelse: "Konsultasjon", antall: 1, enhetspris: 4000, mva_sats: 25 }] });
    await ok("POST", o(`/fakturaer/${f.id}/utsted`), { send_epost: false });
    const u4 = await ok("POST", o("/regnskap/utgifter"), {
      type: "faktura",
      leverandor: "Telenor Norge AS",
      dato: "2026-08-10",
      forfallsdato: "2026-08-24",
      belop: 1250,
      linjer: [{ kategori: "telefon", konto: "6900", belop: 1000, mva_sats: 25, mva: 250 }],
    });
    await ok("POST", o(`/regnskap/utgifter/${u4.id}/bokfor`));
    // 3. termin 2026: en kreditnota fra leverandøren gir inngående avgift med motsatt fortegn (250 kr å betale).
    const u3 = await ok("POST", o("/regnskap/utgifter"), {
      type: "faktura",
      leverandor: "Telenor Norge AS",
      dato: "2026-05-10",
      forfallsdato: "2026-05-24",
      belop: 750,
      linjer: [
        { kategori: "telefon", konto: "6900", belop: 2000, mva_sats: 0, mva: 0 },
        { kategori: "telefon", konto: "6900", belop: -1000, mva_sats: 25, mva: -250 },
      ],
    });
    await ok("POST", o(`/regnskap/utgifter/${u3.id}/bokfor`));
    // Fakturaen la sendingen i kø; den hører ikke til her.
    ko.length = 0;
  });

  // Den simulerte ID-porten, valideringen og appen svarer normalt i hver test.
  beforeEach(() => {
    Object.assign(inst, { nektInstans: false, avvisInnsending: false, bruddEtterInnsending: false });
    tokenSvar = null;
    feilNonce = false;
    valideringssvar = GYLDIG;
  });

  it("av til innsendingen er slått på", async () => {
    const m = await ok("GET", o("/regnskap/mva?aar=2026&termin=4"));
    expect(m.linjer.map((l: any) => [l.kode, l.grunnlag, l.sats, l.merverdiavgift, l.merknad_valg])).toEqual([
      ["1", null, null, -250, null],
      ["3", 4000, 25, 1000, null],
    ]);
    expect(m).toMatchObject({ sum: 750, innsending_paa: false, innsending: null });
    expect((await api("POST", o("/regnskap/mva/2026/4/send"))).data.error).toBe("Innsending av mva-meldingen fra appen er ikke slått på.");
    expect(kall).toEqual([]);
  });

  it("sjekkene før innloggingen: terminen, tilgangen, mva-registreringen og merknadene", async () => {
    config.mvaInnsending = true;
    expect((await ok("GET", o("/regnskap/mva?aar=2026&termin=4"))).innsending_paa).toBe(true);
    expect((await api("POST", o("/regnskap/mva/2099/1/send"))).data.error).toBe("Terminen er ikke over. Meldingen sendes når den er over.");
    expect((await api("POST", o("/regnskap/mva/2026/4/send"), {}, fakturerer)).status).toBe(403);
    await ok("PATCH", o(""), { mva_registrert: false });
    expect((await api("POST", o("/regnskap/mva/2026/4/send"))).data.error).toBe("Organisasjonen er ikke registrert for merverdiavgift (Innstillinger → Organisasjon).");
    await ok("PATCH", o(""), { mva_registrert: true });

    // 3. termin: inngående avgift med motsatt fortegn må forklares med en av merknadene (eller egen tekst).
    const m3 = await ok("GET", o("/regnskap/mva?aar=2026&termin=3"));
    expect(m3.sum).toBe(250);
    expect(m3.linjer).toHaveLength(1);
    expect(m3.linjer[0]).toMatchObject({ kode: "1", merverdiavgift: 250 });
    expect(m3.linjer[0].merknad_valg.fritekst).toBe(true);
    expect(m3.linjer[0].merknad_valg.koder).toContainEqual({ kode: "kreditnota", navn: "Kreditnota" });
    expect((await api("POST", o("/regnskap/mva/2026/3/send"))).data.error).toBe("Linjen med kode 1 har motsatt fortegn av det vanlige og må forklares med en merknad.");
    expect((await api("POST", o("/regnskap/mva/2026/3/send"), { merknader: [{ utvalgt: "store anskaffelser" }] })).data.error).toBe(
      "Merknaden «store anskaffelser» passer ikke til linjen med kode 1.",
    );
    expect((await api("POST", o("/regnskap/mva/2026/3/send"), { merknader: [{ beskrivelse: " " }] })).data.error).toBe("Skriv en forklaring på linjen med kode 1.");
    expect((await api("POST", o("/regnskap/mva/2026/4/send"), { merknader: [{ utvalgt: "kreditnota" }] })).data.error).toBe("Linjen med kode 1 skal ikke ha merknad.");
    // Ingenting er lagret, og ingenting er sendt (bare ID-portens oppsett er hentet).
    expect(await somSystem(async (db) => (await db.query("select count(*)::int as n from faktura.mva_innsendinger where org_id = $1", [org])).rows[0].n)).toBe(0);
    expect(kall.map((k) => k.url)).toEqual(["idporten.test/.well-known/openid-configuration"]);
    expect(ko).toEqual([]);
  });

  it("sendes: innloggingen i ID-porten, valideringen, instansen i Altinn og innsendingen", async () => {
    kall.length = 0;
    valideringssvar = AVVIKENDE;
    const s = await ok("POST", o("/regnskap/mva/2026/4/send"), {});
    expect(s.id).toMatch(/^[0-9a-f-]{36}$/);
    // Adressen i ID-porten: koden med PKCE, nonce, nivå «betydelig» og ny innlogging.
    const u = new URL(s.url);
    expect(`${u.origin}${u.pathname}`).toBe("https://login.idporten.test/authorize");
    const p = Object.fromEntries(u.searchParams);
    expect(p).toMatchObject({
      client_id: KLIENT,
      redirect_uri: `${config.appUrl}/mva/idporten`,
      response_type: "code",
      scope: "openid skatteetaten:mvameldingvalidering altinn:instances.read altinn:instances.write",
      code_challenge_method: "S256",
      acr_values: "idporten-loa-substantial",
      prompt: "login",
      ui_locales: "nb",
    });
    expect(p.state).toMatch(new RegExp(`^${org}\\.[\\w-]{20,}$`));
    expect(p.code_challenge).toMatch(/^[\w-]{43}$/);
    expect(p.nonce!.length).toBeGreaterThanOrEqual(20);
    // Meldingen er frosset, og innloggingen er lagret (verifikatoren og nonce ser ikke API-et).
    let r = await rad(s.id);
    expect(r).toMatchObject({ status: "innlogging", state: p.state, nonce: p.nonce, aar: 2026, type: "tomaaneder", termin: 4, sum: 750, steg: null });
    expect(createHash("sha256").update(r.verifikator).digest("base64url")).toBe(p.code_challenge);
    expect(r.melding).toContain("<fastsattMerverdiavgift>750</fastsattMerverdiavgift>");
    expect(r.melding).toContain(`<organisasjonsnummer>${ORGNR}</organisasjonsnummer>`);
    expect(r.melding).toContain(`<regnskapssystemsreferanse>${s.id}</regnskapssystemsreferanse>`);
    expect(r.melding).toContain("<systemversjon>api-00042-abc</systemversjon>");
    const m = await ok("GET", o("/regnskap/mva?aar=2026&termin=4"));
    expect(m.innsending).toMatchObject({ id: s.id, status: "innlogging", egen: true, startet_av: "Kari Nordmann", sum: 750, har_kvittering: false });
    expect(m.innsending).not.toHaveProperty("nonce");
    expect(m.innsending).not.toHaveProperty("verifikator");

    // Tilbake fra ID-porten: koden går til workeren, og innloggingen kan ikke brukes på nytt.
    logginn(s.url, "kode-1");
    expect((await api("POST", o("/regnskap/mva/idporten"), { state: p.state, code: "kode-1" }, regnskap)).data.error).toBe("Innloggingen ble startet av en annen bruker.");
    expect(await ok("POST", o("/regnskap/mva/idporten"), { state: p.state, code: "kode-1" })).toEqual({ id: s.id, aar: 2026, termin: 4, status: "sender" });
    expect((await api("POST", o("/regnskap/mva/idporten"), { state: p.state, code: "kode-1" })).status).toBe(404);
    expect(ko).toEqual([{ type: "mva-send", org_id: org, innsending_id: s.id, kode: "kode-1", oppgave_id: expect.any(String) }]);
    // Bare én sending om gangen for terminen.
    expect((await api("POST", o("/regnskap/mva/2026/4/send"))).data.error).toBe("Meldingen for terminen sendes allerede. Vent til den er ferdig.");
    const oppgave = (await kjor("mva-send"))[0]!;

    // Tokenbyttet: koden, PKCE-verifikatoren og et JWT signert med klientens nøkkel.
    expect(bytter).toHaveLength(1);
    const b = bytter[0]!;
    expect(b.felt).toMatchObject({
      grant_type: "authorization_code",
      code: "kode-1",
      redirect_uri: `${config.appUrl}/mva/idporten`,
      client_id: KLIENT,
      client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
    });
    expect(b.signatur).toBe(true);
    expect(b.hode).toEqual({ alg: "RS256", typ: "JWT", kid: "kid-klient" });
    expect(b.innhold).toMatchObject({ iss: KLIENT, sub: KLIENT, aud: UTSTEDER });
    expect(b.innhold.exp - b.innhold.iat).toBe(100);
    // Kallene etter tokenbyttet: nøklene, valideringen, Altinn-tokenet, instansen, konvolutten,
    // meldingen, utfyllingen og innsendingen, og så betalingsinformasjonen og tilbakemeldingen.
    const i = `skd.test${APP}/instances/${INSTANS}`;
    expect(kall.map((k) => `${k.metode} ${k.url}`)).toEqual([
      "POST idporten.test/token",
      "GET idporten.test/jwks.json",
      "POST validering.test/api/mva/grensesnittstoette/mva-melding/valider",
      "GET altinn.test/authentication/api/v1/exchange/id-porten",
      `POST skd.test${APP}/instances/`,
      `PUT ${i}/data/d-konvolutt`,
      `POST ${i}/data?dataType=mvamelding`,
      `PUT ${i}/process/next`,
      `PUT ${i}/process/next`,
      `GET ${i}`,
      `GET ${i}/data/d-betaling`,
      `GET ${i}/feedback/status`,
    ]);
    const [, , validering, bytte, lag, konvolutt, melding, neste] = kall;
    r = await rad(s.id);
    expect(validering).toMatchObject({ token: "Bearer idporten-token", type: "application/xml", kropp: r.melding });
    expect(bytte!.token).toBe("Bearer idporten-token");
    expect(kall.slice(4).every((k) => k.token === `Bearer ${ALTINN_TOKEN}`)).toBe(true);
    expect(JSON.parse(lag!.kropp)).toEqual({ instanceOwner: { organisationNumber: ORGNR } });
    expect(konvolutt!.type).toBe("application/xml");
    expect(inst.konvolutt).toContain(`<organisasjonsnummer>${ORGNR}</organisasjonsnummer>`);
    expect(inst.konvolutt).toContain("<skattleggingsperiodeToMaaneder>juli-august</skattleggingsperiodeToMaaneder>");
    expect(inst.konvolutt).toMatch(/<vedleggstype>mva-melding<\/vedleggstype>[\s\S]*<filnavn>mvaMelding<\/filnavn>\s*<filekstensjon>xml<\/filekstensjon>/);
    expect(inst.konvolutt).toContain("<opprettetAv>Kari Nordmann</opprettetAv>");
    expect(melding).toMatchObject({ type: "text/xml", kropp: r.melding });
    expect(melding!.hoder["content-disposition"]).toBe("attachment; filename=mvaMelding.xml");
    expect(neste!.type).toBe(null);
    expect(neste!.kropp).toBe("");

    // Sendt: terminen er levert i dag med beløpet som ble sendt, av den som sendte. Avviket fra
    // valideringen stoppet ikke sendingen. Altinn-tokenet er lagret kryptert til tilbakemeldingen er hentet.
    expect(r).toMatchObject({ status: "sendt", steg: "sendt", instans: INSTANS, nonce: null, verifikator: null, state: null, feil: null });
    expect(r.altinn_token.toString()).toBe(`kryptert:${ALTINN_TOKEN}`);
    expect(r.avvik).toEqual([
      { alvor: "avvik", tekst: "Grunnlaget er høyt sammenlignet med tidligere terminer", kode: "R099", regel: null, sti: "/mvaMeldingDto/skattegrunnlagOgBeregnetSkatt/mvaSpesifikasjonslinje[2]", mvaKode: "3" },
    ]);
    expect(r.betaling).toEqual({ kid: "40000123456789", belop: 750, frist: "2026-10-12", konto: "63450618065", betaleTil: "Skatteetaten", informasjon: null });
    const t4 = await terminrad(4);
    expect([Number(t4.levert_belop), t4.levert_av]).toEqual([750, r.startet_av]);
    const m2 = await ok("GET", o("/regnskap/mva?aar=2026&termin=4"));
    expect(m2.levert).toMatchObject({ belop: 750, av: "Kari Nordmann" });
    expect(m2.endret).toBe(false);
    expect(m2.innsending).toMatchObject({ status: "sendt", har_kvittering: false, betaling: { kid: "40000123456789", belop: 750 } });
    expect((await api("POST", o("/regnskap/mva/2026/4/send"))).data.error).toMatch(/^Meldingen for terminen er levert \d{2}\.\d{2}\.\d{4}\. Endres terminen etterpå, kan en korrigert melding sendes\.$/);
    expect((await api("GET", o(`/regnskap/mva/innsending/${s.id}/kvittering`))).status).toBe(404);

    // Tilbakemeldingen er ikke klar: workeren spør igjen senere. En ny levering av sendingen gjør ingenting.
    expect(ko).toEqual([{ type: "mva-tilbakemelding", org_id: org, innsending_id: s.id, forsok: 1, oppgave_id: expect.any(String) }]);
    kall.length = 0;
    await kjorOppgave(oppgave as any);
    expect(kall).toEqual([]);
  });

  it("tilbakemeldingen fra Skatteetaten med kvitteringen", async () => {
    const id = (await ok("GET", o("/regnskap/mva/2026/4/innsending"))).innsending.id;
    // Ikke klar ved første spørsmål.
    kall.length = 0;
    const [forste] = await kjor("mva-tilbakemelding");
    expect(kall.map((k) => k.url.replace(`skd.test${APP}/instances/${INSTANS}`, "…"))).toEqual(["…", "…/feedback/status"]);
    expect(ko).toEqual([{ type: "mva-tilbakemelding", org_id: org, innsending_id: id, forsok: 2, oppgave_id: expect.any(String) }]);
    // Samme oppgave levert to ganger: den andre gjør ingenting.
    kall.length = 0;
    await kjorOppgave(forste as any);
    expect(kall).toEqual([]);

    // Skatteetaten har behandlet meldingen: kvitteringen, valideringsresultatet og statusen.
    inst.steg = "ferdig";
    inst.data.push(
      { id: "d-resultat", dataType: "valideringsresultat", contentType: "application/xml" },
      { id: "d-kvittering", dataType: "kvittering", contentType: "application/pdf" },
    );
    await kjor("mva-tilbakemelding");
    expect(kall.map((k) => k.url.replace(`skd.test${APP}/instances/${INSTANS}`, "…"))).toEqual(["…", "…/feedback/status", "…", "…/data/d-kvittering", "…/data/d-resultat"]);
    expect(ko).toEqual([]);
    const r = await rad(id);
    expect(r).toMatchObject({ status: "mottatt", altinn_token: null, token_utloper: null });
    expect(r.mottatt_at).not.toBe(null);
    expect(r.tilbakemelding).toEqual({ status: "Mottatt", beskrivelse: "Skatteetaten har mottatt mva-meldingen.", resultat: "gyldig" });
    // Det endelige valideringsresultatet erstatter avvikene fra forhåndsvalideringen.
    expect(r.avvik).toEqual([]);
    expect(Buffer.from(r.kvittering).equals(KVITTERING)).toBe(true);

    const k = await api("GET", o(`/regnskap/mva/innsending/${id}/kvittering`));
    expect(k.status).toBe(200);
    expect(k.type).toBe("application/pdf");
    expect((k.data as Buffer).equals(KVITTERING)).toBe(true);
    expect((await api("GET", o(`/regnskap/mva/innsending/${id}/kvittering`), undefined, fakturerer)).status).toBe(403);
    // Rapporten «Mva-melding» har sendingen og betalingen (til regnskapsføreren).
    const rapport = await ok("GET", o("/rapportmodul/regnskap.mva?aar=2026&termin=4"));
    expect(rapport.merknad).toMatch(/Sendt til Skatteetaten \d{2}\.\d{2}\.\d{4} av Kari Nordmann, mottatt \d{2}\.\d{2}\.\d{4}\. Betal 750,00 kr til konto 63450618065 med KID 40000123456789 innen 12\.10\.2026\./);
    expect((await ok("GET", o("/regnskap/mva/2026/4/innsending"))).innsending).toMatchObject({
      status: "mottatt",
      har_kvittering: true,
      tilbakemelding: { status: "Mottatt" },
      betaling: { kid: "40000123456789" },
    });
  });

  it("ugyldig melding: valideringen stopper sendingen, og ingenting sendes til Altinn", async () => {
    kall.length = 0;
    valideringssvar = UGYLDIG;
    const id = await sendInn(3, "kode-3a", [{ utvalgt: "kreditnota" }]);
    await kjor("mva-send");
    expect(kall.map((k) => k.url).filter((u) => u !== "idporten.test/jwks.json")).toEqual(["idporten.test/token", "validering.test/api/mva/grensesnittstoette/mva-melding/valider"]);
    const r = await rad(id);
    expect(r.melding).toContain("<merknad>\n        <utvalgtMerknad>kreditnota</utvalgtMerknad>\n      </merknad>");
    expect(r.linjer[0]).toMatchObject({ kode: "1", merverdiavgift: 250, merknad: { utvalgt: "kreditnota" } });
    expect(r).toMatchObject({ status: "feil", steg: "validering", instans: null, feil: "Skatteetaten fant feil i meldingen (se under). Den er ikke sendt." });
    expect(r.avvik).toEqual([
      { alvor: "ugyldig", tekst: "Summen av linjene stemmer ikke med fastsatt merverdiavgift", kode: "R018", regel: null, sti: "/mvaMeldingDto/skattegrunnlagOgBeregnetSkatt/fastsattMerverdiavgift", mvaKode: null },
    ]);
    expect(await terminrad(3)).toBeUndefined();
    expect((await ok("GET", o("/regnskap/mva?aar=2026&termin=3"))).innsending).toMatchObject({ id, status: "feil", avvik: [{ kode: "R018" }] });
    valideringssvar = GYLDIG;
  });

  it("avbrutt eller utløpt innlogging, og feil fra ID-porten", async () => {
    kall.length = 0;
    // Brukeren avbrøt i ID-porten.
    let s = await ok("POST", o("/regnskap/mva/2026/3/send"), { merknader: [{ beskrivelse: "Kreditnota fra Telenor for feilfakturert abonnement" }] });
    let p = logginn(s.url, "kode-3b");
    expect(await ok("POST", o("/regnskap/mva/idporten"), { state: p.state, error: "access_denied", error_description: "Brukeren avbrøt innloggingen" })).toEqual({
      id: s.id,
      aar: 2026,
      termin: 3,
      status: "avbrutt",
    });
    expect(await rad(s.id)).toMatchObject({ status: "avbrutt", state: null, feil: "Innloggingen i ID-porten ble avbrutt (Brukeren avbrøt innloggingen). Meldingen er ikke sendt." });
    expect((await rad(s.id)).melding).toContain("<beskrivelse>Kreditnota fra Telenor for feilfakturert abonnement</beskrivelse>");
    // Innloggingen tok for lang tid.
    s = await ok("POST", o("/regnskap/mva/2026/3/send"), { merknader: [{ utvalgt: "kreditnota" }] });
    p = logginn(s.url, "kode-3c");
    await somSystem((db) => db.query("update faktura.mva_innsendinger set utloper = now() - interval '1 minute' where id = $1", [s.id]));
    expect((await ok("POST", o("/regnskap/mva/idporten"), { state: p.state, code: "kode-3c" })).status).toBe("avbrutt");
    expect((await rad(s.id)).feil).toBe("Innloggingen tok for lang tid. Send meldingen på nytt.");
    expect((await api("POST", o("/regnskap/mva/idporten"), { state: "ukjent-state-12345", code: "x" })).status).toBe(404);
    expect(ko).toEqual([]);

    // Koden er allerede brukt (eller utløpt) hos ID-porten.
    tokenSvar = { status: 400, data: { error: "invalid_grant", error_description: "Authorization code is expired" } };
    let id = await sendInn(3, "kode-3d", [{ utvalgt: "kreditnota" }]);
    await kjor("mva-send");
    expect(await rad(id)).toMatchObject({
      status: "feil",
      feil: "Innloggingen i ID-porten er utløpt eller allerede brukt. Prøv igjen. Meldingen er ikke sendt.",
      nonce: null,
      verifikator: null,
    });
    tokenSvar = null;
    // ID-tokenet hører til en annen innlogging (nonce).
    feilNonce = true;
    id = await sendInn(3, "kode-3e", [{ utvalgt: "kreditnota" }]);
    await kjor("mva-send");
    expect((await rad(id)).feil).toBe("ID-tokenet hører ikke til denne innloggingen (nonce). Meldingen er ikke sendt.");
    feilNonce = false;
    expect(kall.filter((k) => !k.url.startsWith("idporten.test"))).toEqual([]);
  });

  it("Altinn: uten rett til å sende for organisasjonen, og avvist ved innsendingen", async () => {
    kall.length = 0;
    inst.nektInstans = true;
    let id = await sendInn(3, "kode-3f", [{ utvalgt: "kreditnota" }]);
    await kjor("mva-send");
    expect(await rad(id)).toMatchObject({
      status: "feil",
      instans: null,
      feil: "Den som logget inn, har ikke rett til å sende mva-meldingen for organisasjonen i Altinn. Det trengs tilgangspakken «Merverdiavgift» (eller regnskapsfører med signeringsrett) for organisasjonen. Meldingen er ikke sendt.",
    });
    expect(kall.filter((k) => k.metode === "POST" && k.url.endsWith("/instances/"))).toHaveLength(1);
    inst.nektInstans = false;

    // Skatteetaten avviser meldingen ved innsendingen (409 med valideringsresultatet).
    inst.avvisInnsending = true;
    kall.length = 0;
    id = await sendInn(3, "kode-3g", [{ utvalgt: "kreditnota" }]);
    await kjor("mva-send");
    expect(kall.map((k) => `${k.metode} ${k.url.replace(`skd.test${APP}/instances/${INSTANS}`, "…")}`).slice(-4)).toEqual([
      "POST …/data?dataType=mvamelding",
      "PUT …/process/next",
      "PUT …/process/next",
      "GET …",
    ]);
    expect(await rad(id)).toMatchObject({ status: "feil", instans: INSTANS, steg: "bekreftelse", feil: "Skatteetaten avviste meldingen ved innsendingen (se under). Den er ikke sendt." });
    expect((await rad(id)).avvik).toMatchObject([{ alvor: "ugyldig", kode: "R018" }]);
    expect(await terminrad(3)).toBeUndefined();
    inst.avvisInnsending = false;
  });

  it("sendingen kom ikke i kø: feil, og meldingen sendes på nytt", async () => {
    settLokalOppgavekjorer(async (x) => {
      if (x.type === "mva-send") throw new Error("Cloud Tasks svarte ikke");
      ko.push(x);
    });
    const s = await ok("POST", o("/regnskap/mva/2026/3/send"), { merknader: [{ utvalgt: "kreditnota" }] });
    const p = logginn(s.url, "kode-3k");
    expect(await ok("POST", o("/regnskap/mva/idporten"), { state: p.state, code: "kode-3k" })).toEqual({ id: s.id, aar: 2026, termin: 3, status: "feil" });
    expect(await rad(s.id)).toMatchObject({ status: "feil", feil: "Sendingen kom ikke i gang. Meldingen er ikke sendt; send den på nytt." });
    settLokalOppgavekjorer(async (x) => void ko.push(x));
    expect(ko).toEqual([]);
  });

  it("svaret på innsendingen kom ikke fram, men meldingen er sendt", async () => {
    kall.length = 0;
    inst.bruddEtterInnsending = true;
    const id = await sendInn(3, "kode-3h", [{ utvalgt: "kreditnota" }]);
    await kjor("mva-send");
    // Det nye forsøket blir avvist (innsendingen kom fram), og instansen viser at den er sendt.
    expect(kall.map((k) => `${k.metode} ${k.url.replace(`skd.test${APP}/instances/${INSTANS}`, "…")}`).slice(-7)).toEqual([
      "PUT …/process/next",
      "PUT …/process/next",
      "PUT …/process/next",
      "GET …",
      "GET …",
      "GET …/data/d-betaling",
      "GET …/feedback/status",
    ]);
    expect(await rad(id)).toMatchObject({ status: "sendt", feil: null, instans: INSTANS });
    const t3 = await terminrad(3);
    expect(Number(t3.levert_belop)).toBe(250);
    expect(ko.map((x) => x.type)).toEqual(["mva-tilbakemelding"]);
    ko.length = 0;
  });

  it("ryddingen: innlogginger som ikke ble fullført, sendinger som stoppet og utløpte tokener", async () => {
    // I 1. og 2. termin (bare én sending om gangen per termin).
    const [a, b, c, d] = await somSystem(async (db) => {
      const lag = async (felt: string, termin: number) =>
        (
          await db.query(
            `insert into faktura.mva_innsendinger (org_id, aar, type, termin, state, nonce, verifikator, utloper, melding, sum)
             values ($1, 2026, 'tomaaneder', $3, $2, 'n', 'v', now() - interval '1 minute', '<x/>', 0) returning id`,
            [org, `${org}.${felt}-rydd-0123456789`, termin],
          )
        ).rows[0].id as string;
      const ider = [await lag("a", 2), await lag("b", 1), await lag("c", 2), await lag("d", 2)];
      await db.query("update faktura.mva_innsendinger set status = 'sender', state = null, oppdatert = now() - interval '31 minutes' where id = $1", [ider[1]]);
      await db.query("update faktura.mva_innsendinger set status = 'sender', state = null, instans = $2, oppdatert = now() - interval '31 minutes' where id = $1", [ider[2], INSTANS]);
      await db.query(
        `update faktura.mva_innsendinger set status = 'sendt', state = null, instans = $2, altinn_token = 'kryptert:x', token_utloper = now() - interval '11 minutes',
                opprettet = now() + interval '1 second' where id = $1`,
        [ider[3], INSTANS],
      );
      return ider;
    });
    expect(await ryddMvaInnsendinger()).toBeGreaterThanOrEqual(3);
    expect(await rad(a!)).toMatchObject({ status: "avbrutt", state: null, nonce: null, verifikator: null, feil: "Innloggingen i ID-porten ble ikke fullført. Meldingen er ikke sendt." });
    expect(await rad(b!)).toMatchObject({ status: "feil", feil: "Innsendingen ble ikke ferdig. Meldingen er ikke sendt; send den på nytt." });
    expect(await rad(c!)).toMatchObject({ status: "feil", feil: "Innsendingen ble ikke ferdig. Sjekk meldingen i Altinn før du sender på nytt, så den ikke sendes to ganger." });
    expect(await rad(d!)).toMatchObject({
      status: "sendt",
      altinn_token: null,
      tilbakemelding: { melding: "Kvitteringen ligger i Altinn (innloggingen er utløpt, så appen kan ikke hente den)." },
    });
    // Den siste innsendingen for terminen er den som vises.
    expect((await ok("GET", o("/regnskap/mva?aar=2026&termin=2"))).innsending).toMatchObject({ id: d, status: "sendt" });
  });
});
