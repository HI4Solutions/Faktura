// Ansatte fra a-ordningen (0113_ansatte_enklere.sql, aordning.ts): tolkingen av
// avstemmingsrapporten (strukturen kan være en annen enn ventet), feltene på den ansatte, og hele
// flyten mot Skatteetaten (simulert): tilgangen, bestillingen og hentingen av rapporten (også når
// den ikke er klar), koblingen mot dem som finnes (fødselsnummer eller navn), og innleggingen med
// fødselsnummeret, arbeidsforholdet og lønnen.
import { generateKeyPairSync } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { lagApi } from "../src/api.js";
import { alle, en, somSystem } from "../src/db.js";
import { settKryptering } from "../src/kryptering.js";
import { settLokalOppgavekjorer, type Oppgave } from "../src/tjenester.js";
import { settEtatFetch } from "../src/maskinporten.js";
import { A_ORDNING, TILGANGSPAKKE } from "../src/altinn.js";
import { arbeidsforholdFelt, AVSTEMMING_PAUSE, hentFraAordningen, lonnFelt, maanederFor, tolkAvstemming } from "../src/aordning.js";
import { iDag } from "../src/regler.js";
import { kjorOppgave } from "../src/worker.js";

const ORGNR = "915000339";
const KARI = "13830197340"; // 13.03.2001 (syntetisk)
const PER = "24880199664"; // 24.08.2001
const LISE = "17859010067"; // 17.05.1990
const SLUTTET = "02858010082"; // 02.05.1980

// Rapporten slik a-meldingene er bygd opp (måned, virksomhet, inntektsmottaker med arbeidsforhold
// og inntekt), med navnene der de kan stå.
const RAPPORT = {
  opplysningspliktig: { norskIdentifikator: ORGNR },
  kalendermaaneder: [
    {
      kalendermaaned: "2026-08",
      virksomhet: [
        {
          norskIdentifikator: "915000347",
          navn: "Avdeling Sentrum",
          inntektsmottaker: [
            {
              norskIdentifikator: KARI,
              arbeidsforhold: [
                {
                  arbeidsforholdId: "AF-1",
                  typeArbeidsforhold: "ordinaertArbeidsforhold",
                  startdato: "2019-04-01",
                  stillingsprosent: "80",
                  yrke: "2223108",
                  arbeidstidsordning: "ikkeSkift",
                  antallTimerPerUkeSomEnFullStillingTilsvarer: "37.5",
                  avloenningstype: "fast",
                  formForAnsettelse: "fast",
                },
              ],
              inntekt: [{ beloep: "40000.00", arbeidsforholdId: "AF-1", loennsinntekt: { beskrivelse: "fastloenn" } }],
            },
            {
              norskIdentifikator: SLUTTET,
              identifiserendeInformasjon: { navn: "Sluttet, Sigrid" },
              arbeidsforhold: [{ arbeidsforholdId: "9", typeArbeidsforhold: "ordinaertArbeidsforhold", startdato: "2015-01-01", sluttdato: "2026-08-15", stillingsprosent: 50 }],
            },
          ],
        },
      ],
    },
    {
      kalendermaaned: "2026-09",
      virksomhet: [
        {
          norskIdentifikator: "915000347",
          navn: "Avdeling Sentrum",
          inntektsmottaker: [
            {
              norskIdentifikator: KARI,
              identifiserendeInformasjon: { navn: "KARI HANSEN", foedselsdato: "2001-03-13" },
              arbeidsforhold: [{ arbeidsforholdId: "AF-1", startdato: "2019-04-01", stillingsprosent: "100", yrke: { kode: "2223108" } }],
              inntekt: [
                { beloep: "42000.00", arbeidsforholdId: "AF-1", loennsinntekt: { beskrivelse: "fastloenn" } },
                { beloep: "5000.00", arbeidsforholdId: "AF-1", loennsinntekt: { beskrivelse: "bonus" } },
              ],
            },
            {
              identifikator: { norskIdentifikator: PER },
              person: { fornavn: "PER", etternavn: "TIME" },
              arbeidsforhold: [
                {
                  arbeidsforholdId: 2,
                  typeArbeidsforhold: "ordinaertArbeidsforhold",
                  startdato: "2024-02-01",
                  stillingsprosent: 40,
                  yrke: "5223101",
                  avloenningstype: "time",
                  arbeidstidsordning: "andreSkift",
                },
              ],
              inntekt: [{ beloep: 4000, loennsinntekt: { beskrivelse: "timeloenn", antall: 20 } }],
            },
            {
              norskIdentifikator: LISE,
              identifiserendeInformasjon: { navn: { fornavn: "Lise", mellomnavn: "M.", etternavn: "Ny" } },
              arbeidsforhold: [{ arbeidsforholdId: "L-7", typeArbeidsforhold: "ordinaertArbeidsforhold", startdato: "2026-09-01", stillingsprosent: 60, yrke: "4110101" }],
              inntekt: [{ beloep: "30000.00", loennsinntekt: { beskrivelse: "fastloenn" } }],
            },
          ],
        },
      ],
    },
  ],
};

// Rapporten slik den er i Skatteetatens spesifikasjon (avstemmingsrapport-amelding-api 1.0.1,
// A07AOrdningenAvstemmingsinformasjon) for én måned: navnet som én tekst, tallene som tekst.
const spekRapport = (maaned: string) => ({
  mottatt: {
    avstemmingstidspunkt: "2026-10-05T10:00:00+02:00",
    fomKalendermaaned: maaned,
    tomKalendermaaned: maaned,
    opplysningspliktig: {
      norskIdentifikator: ORGNR,
      navn: "A-ORDNING TEST AS",
      innsendinger: [{ innsender: "Annet lønnssystem", kalendermaaned: maaned, status: "mottatt", meldingsId: "m-1", antallInntektsmottakere: 4 }],
    },
    oppgave: {
      virksomhet: [
        {
          norskIdentifikator: "915000347",
          navn: "AVDELING SENTRUM",
          antallPersonerInnrapportert: 4,
          inntektsmottaker: [
            {
              norskIdentifikator: KARI,
              identifiserendeInformasjon: { navn: "KARI HANSEN", foedselsdato: "2001-03-13" },
              arbeidsforhold: [
                {
                  arbeidsforholdId: "AF-1",
                  typeArbeidsforhold: "ordinaertArbeidsforhold",
                  startdato: "2019-04-01",
                  antallTimerPerUkeSomEnFullStillingTilsvarer: "37.5",
                  avloenningstype: "fast",
                  yrke: "2223108",
                  arbeidstidsordning: "ikkeSkift",
                  stillingsprosent: "100",
                  formForAnsettelse: "fast",
                },
              ],
              inntekt: [
                { fordel: "kontantytelse", utloeserArbeidsgiveravgift: true, inngaarIGrunnlagForTrekk: true, beloep: "42000", loennsinntekt: { beskrivelse: "fastloenn" } },
                { fordel: "kontantytelse", utloeserArbeidsgiveravgift: true, inngaarIGrunnlagForTrekk: true, beloep: "5000", loennsinntekt: { beskrivelse: "bonus" } },
              ],
              forskuddstrekk: [{ beskrivelse: "ordinaert", beloep: "-14000" }],
            },
            {
              norskIdentifikator: SLUTTET,
              identifiserendeInformasjon: { navn: "Sluttet, Sigrid", foedselsdato: "1980-05-02" },
              arbeidsforhold: [{ arbeidsforholdId: "9", typeArbeidsforhold: "ordinaertArbeidsforhold", startdato: "2015-01-01", sluttdato: "2026-08-15", stillingsprosent: "50" }],
            },
            {
              norskIdentifikator: PER,
              identifiserendeInformasjon: { navn: "PER TIME", foedselsdato: "2001-08-24" },
              arbeidsforhold: [
                {
                  arbeidsforholdId: "2",
                  typeArbeidsforhold: "ordinaertArbeidsforhold",
                  startdato: "2024-02-01",
                  stillingsprosent: "40",
                  yrke: "5223101",
                  avloenningstype: "time",
                  arbeidstidsordning: "andreSkift",
                },
              ],
              inntekt: [{ fordel: "kontantytelse", utloeserArbeidsgiveravgift: true, inngaarIGrunnlagForTrekk: true, beloep: "4000", loennsinntekt: { beskrivelse: "timeloenn", antall: "20" } }],
            },
            {
              norskIdentifikator: LISE,
              identifiserendeInformasjon: { navn: "LISE M. NY", foedselsdato: "1990-05-17" },
              arbeidsforhold: [{ arbeidsforholdId: "L-7", typeArbeidsforhold: "ordinaertArbeidsforhold", startdato: "2026-09-01", stillingsprosent: "60", yrke: "4110101" }],
              inntekt: [{ fordel: "kontantytelse", utloeserArbeidsgiveravgift: true, inngaarIGrunnlagForTrekk: true, beloep: "30000", loennsinntekt: { beskrivelse: "fastloenn" } }],
            },
          ],
        },
      ],
      betalingsinformasjon: { sumForskuddstrekk: "14000", sumArbeidsgiveravgift: "11000" },
    },
  },
});

describe("avstemmingsrapporten (uten database)", () => {
  it("finner personene, navnene, det gjeldende arbeidsforholdet og lønnen fra siste måned", () => {
    const p = tolkAvstemming(RAPPORT);
    expect(p.map((x) => [x.fnr, x.fornavn, x.etternavn, x.fodselsdato])).toEqual([
      [KARI, "Kari", "Hansen", "2001-03-13"],
      [LISE, "Lise M.", "Ny", "1990-05-17"],
      [SLUTTET, "Sigrid", "Sluttet", "1980-05-02"],
      [PER, "Per", "Time", "2001-08-24"],
    ]);
    const kari = p[0]!;
    // Det fra september gjelder (stillingsprosenten), med feltene fra august som ikke står i september.
    expect(kari.arbeidsforhold).toEqual([
      {
        id: "AF-1",
        type: "ordinaertArbeidsforhold",
        startdato: "2019-04-01",
        sluttdato: null,
        stillingsprosent: 100,
        yrkeskode: "2223108",
        arbeidstidsordning: "ikkeSkift",
        timer_full_stilling: 37.5,
        avlonning: "fast",
        ansettelsesform: "fast",
        maaned: "2026-09",
      },
    ]);
    // Fastlønnen i september (bonusen er ikke lønn), ikke august.
    expect(kari.lonn).toEqual({ maaned: "2026-09", fastlonn: 42000, timelonn: null, timer: null });
    const per = p[3]!;
    expect(per.arbeidsforhold[0]).toMatchObject({ id: "2", stillingsprosent: 40, avlonning: "time", arbeidstidsordning: "andreSkift" });
    expect(per.lonn).toEqual({ maaned: "2026-09", fastlonn: null, timelonn: 200, timer: 20 });
    // Virksomhetens navn er ikke personens.
    expect(p[2]!.arbeidsforhold[0]).toMatchObject({ sluttdato: "2026-08-15" });
    expect(tolkAvstemming(null)).toEqual([]);
    expect(tolkAvstemming({ status: "UNDER_BEHANDLING" })).toEqual([]);
  });

  it("tåler at rapporten er en flat liste med navn som én tekst", () => {
    const p = tolkAvstemming([{ fnr: "13830197340", navn: "Kari Mari Hansen", startdato: "2020-01-01", stillingsprosent: "50,5", yrke: "2223 108" }]);
    expect(p).toMatchObject([{ fornavn: "Kari Mari", etternavn: "Hansen", arbeidsforhold: [{ startdato: "2020-01-01", stillingsprosent: 50.5, yrkeskode: "2223108", id: null }], lonn: null }]);
  });

  it("feltene på den ansatte: bare gyldige verdier, og lønnen etter avlønningstypen", () => {
    const af = tolkAvstemming(RAPPORT)[0]!.arbeidsforhold[0]!;
    expect(arbeidsforholdFelt(af)).toEqual({
      ansatt_fra: "2019-04-01",
      stillingsprosent: 100,
      yrkeskode: "2223108",
      arbeidsforhold_type: "ordinaertArbeidsforhold",
      arbeidstidsordning: "ikkeSkift",
      ukentlig_arbeidstid: 37.5,
      arbeidsforhold_id: "AF-1",
      ansettelsestype: "fast",
    });
    expect(arbeidsforholdFelt({ ...af, type: "forenkletOppgjoersordning", arbeidstidsordning: "ukjent", stillingsprosent: 0, timer_full_stilling: 99, id: "med mellomrom" })).toEqual({
      ansatt_fra: "2019-04-01",
      yrkeskode: "2223108",
      ansettelsestype: "fast",
    });
    expect(arbeidsforholdFelt(null)).toEqual({});
    expect(lonnFelt(af, { maaned: "2026-09", fastlonn: 42000, timelonn: null, timer: null })).toEqual({ lonnstype: "maaned", maanedslonn: 42000 });
    expect(lonnFelt({ ...af, avlonning: "time" }, { maaned: "2026-09", fastlonn: null, timelonn: 200, timer: 20 })).toEqual({ lonnstype: "time", timelonn: 200 });
    expect(lonnFelt(null, { maaned: null, fastlonn: null, timelonn: 180, timer: 10 })).toEqual({ lonnstype: "time", timelonn: 180 });
    expect(lonnFelt(null, null)).toEqual({});
  });

  it("rapporten slik den er i spesifikasjonen: personene, arbeidsforholdet og lønnen for måneden", () => {
    const p = tolkAvstemming(spekRapport("2026-09"));
    expect(p.map((x) => [x.fnr, x.fornavn, x.etternavn, x.fodselsdato])).toEqual([
      [KARI, "Kari", "Hansen", "2001-03-13"],
      [LISE, "Lise M.", "Ny", "1990-05-17"],
      [SLUTTET, "Sigrid", "Sluttet", "1980-05-02"],
      [PER, "Per", "Time", "2001-08-24"],
    ]);
    expect(p[0]!.arbeidsforhold[0]).toMatchObject({ id: "AF-1", stillingsprosent: 100, yrkeskode: "2223108", timer_full_stilling: 37.5, maaned: "2026-09" });
    expect(p[0]!.lonn).toEqual({ maaned: "2026-09", fastlonn: 42000, timelonn: null, timer: null });
    expect(p[3]!.lonn).toEqual({ maaned: "2026-09", fastlonn: null, timelonn: 200, timer: 20 });
  });

  it("prøver den inneværende måneden og de to før (én måned om gangen)", () => {
    expect(maanederFor("2026-10-15")).toEqual(["2026-10", "2026-09", "2026-08"]);
    expect(maanederFor("2026-01-31")).toEqual(["2026-01", "2025-12", "2025-11"]);
  });
});

describe.skipIf(!process.env.DATABASE_URL)("ansatte fra a-ordningen i appen", () => {
  const app = lagApi();
  const eier = "Bearer test:uid-aordning-eier:aordning-eier@server.test:mfa";
  const ko: Oppgave[] = [];
  const kall: { metode: string; sti: string; kropp: unknown; token: string }[] = [];
  const tokener: { scope: string; kunde: string | null }[] = [];
  let org: string;
  let eierBruker: string;
  let kariId: string;
  let perId: string;
  let annenId: string;
  // Svarene på bestillingene, statusene og rapporten (byttes i testene).
  let bestilling: () => Response;
  let statuser: (() => Response)[] = [];
  let rapport: () => Response;

  const api = async (m: string, sti: string, b?: unknown) => {
    const r = await app.request(sti, { method: m, headers: { authorization: eier, "content-type": "application/json" }, body: b === undefined ? undefined : JSON.stringify(b) });
    return { status: r.status, data: (r.headers.get("content-type") ?? "").includes("json") ? ((await r.json()) as any) : await r.text() };
  };
  const json = (status: number, data: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } });
  const kjor = async () => {
    const mine = ko.filter((o) => o.type === "aordning-hent");
    ko.splice(0, ko.length, ...ko.filter((o) => o.type !== "aordning-hent"));
    for (const o of mine) await kjorOppgave({ ...o, oppgave_id: "t" } as any);
    return mine;
  };
  const henterIgjen = async () => {
    await somSystem((db) => db.query("update faktura.aordning_import set bestilt = now() - interval '5 minutes' where org_id = $1", [org]));
    return api("POST", `/api/org/${org}/ansatte/aordning/hent`);
  };

  beforeAll(async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
    Object.assign(config, {
      maskinportenKlientId: "klient-1",
      maskinportenNokkelId: "kid-1",
      maskinportenNokkel: privateKey,
      maskinportenUrl: "https://mp.test",
      avstemmingUrl: "https://avst.test/v1",
      ameldingInnsending: true,
    });
    AVSTEMMING_PAUSE.ms = 1;
    AVSTEMMING_PAUSE.maks = 50;
    settLokalOppgavekjorer(async (o) => void ko.push(o));
    settKryptering(async (t) => Buffer.from(`kryptert:${t}`), async (b) => b.toString().replace("kryptert:", ""));
    settEtatFetch(async (url, init) => {
      const u = new URL(String(url));
      if (u.host === "mp.test") {
        const jwt = new URLSearchParams(String(init?.body)).get("assertion")!;
        const innhold = JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString());
        tokener.push({ scope: innhold.scope, kunde: innhold.authorization_details?.[0]?.systemuser_org?.ID ?? null });
        return json(200, { access_token: `tok-${innhold.scope}`, expires_in: 120 });
      }
      if (u.host !== "avst.test") throw new Error(`Uventet kall: ${u.href}`);
      kall.push({ metode: init?.method ?? "GET", sti: `${u.pathname}${u.search}`, kropp: init?.body ? JSON.parse(String(init.body)) : null, token: String((init?.headers as any)?.authorization ?? "") });
      if (init?.method === "POST" && u.pathname === "/v1/bestillinger") return bestilling();
      if (u.pathname.startsWith("/v1/bestillinger/")) return (statuser.shift() ?? (() => json(200, { id: u.pathname.split("/").pop(), status: "OPPRETTES" })))();
      if (u.pathname.startsWith("/v1/rapporter/")) return rapport();
      return new Response("<html><body>Not Found</body></html>", { status: 404, headers: { "content-type": "text/html" } });
    });
    org = (await api("POST", "/api/organisasjoner", { navn: "A-ordning Test AS", orgnr: ORGNR })).data.id;
    eierBruker = (await api("GET", "/api/meg")).data.bruker.id;
    expect((await api("PUT", `/api/org/${org}/lonn-oppsett`, { aktiv: true })).status).toBe(200);
    // Kari er registrert med fødselsnummeret; Per uten (samme navn); en annen med et annet nummer.
    kariId = (await api("POST", `/api/org/${org}/ansatte`, { fornavn: "Kari", etternavn: "Hansen", fnr: KARI, ansatt_fra: "2026-01-01", maanedslonn: 45000, lonnstype: "maaned" })).data.id;
    perId = (await api("POST", `/api/org/${org}/ansatte`, { fornavn: "Per", etternavn: "Time", ansatt_fra: "2026-01-01" })).data.id;
    annenId = (await api("POST", `/api/org/${org}/ansatte`, { fornavn: "Anne", etternavn: "Annen", fnr: "15038510190", ansatt_fra: "2026-01-01" })).data.id;
  });

  it("kan brukes når organisasjonen er koblet til Skatteetaten med tilgangspakken «A-ordningen»", async () => {
    expect((await api("GET", `/api/org/${org}/ansatte/aordning`)).data).toEqual({ tilgjengelig: false, grunn: "Koble til Skatteetaten først under Innstillinger → Lønn → Skattekort.", henting: null });
    await somSystem((db) => db.query("insert into faktura.skattekort_tilgang (org_id, status, pakker) values ($1, 'godkjent', $2)", [org, [TILGANGSPAKKE]]));
    const r = await api("POST", `/api/org/${org}/ansatte/aordning/hent`);
    expect(r.status).toBe(409);
    expect(r.data.error).toContain("Utvid tilgangen i Altinn");
    await somSystem((db) => db.query("update faktura.skattekort_tilgang set pakker = $2 where org_id = $1", [org, [TILGANGSPAKKE, A_ORDNING]]));
    config.ameldingInnsending = false;
    expect((await api("GET", `/api/org/${org}/ansatte/aordning`)).data).toMatchObject({ tilgjengelig: false, grunn: "Hentingen fra a-ordningen er ikke slått på ennå." });
    config.ameldingInnsending = true;
    expect((await api("GET", `/api/org/${org}/ansatte/aordning`)).data).toEqual({ tilgjengelig: true, grunn: null, henting: null });
    expect(kall).toEqual([]);
  });

  it("bestiller rapporten for den siste måneden med en a-melding, venter til den er klar, og kobler personene mot dem som finnes", async () => {
    const [denne, forrige] = maanederFor(iDag()) as [string, string];
    const ider = ["b-1", "b-2"];
    bestilling = () => json(201, { id: ider.shift(), status: "OPPRETTES" });
    // Ingen a-melding for denne måneden ennå; måneden før er klar etter litt.
    statuser = [() => json(200, { id: "b-1", status: "INGEN_DATA" }), () => json(200, { id: "b-2", status: "OPPRETTES" }), () => json(200, { id: "b-2", status: "KLAR" })];
    rapport = () => json(200, spekRapport(forrige));
    const r = await api("POST", `/api/org/${org}/ansatte/aordning/hent`);
    expect(r.data.henting).toMatchObject({ status: "bestilt", personer: null, feil: null });
    // Trykket to ganger: bare én oppgave.
    expect((await api("POST", `/api/org/${org}/ansatte/aordning/hent`)).status).toBe(200);
    expect(await kjor()).toHaveLength(1);
    const token = "Bearer tok-skatteetaten:innrapporteringamelding";
    expect(kall.map((k) => [k.metode, k.sti, k.token])).toEqual([
      ["POST", "/v1/bestillinger", token],
      ["GET", "/v1/bestillinger/b-1", token],
      ["POST", "/v1/bestillinger", token],
      ["GET", "/v1/bestillinger/b-2", token],
      ["GET", "/v1/bestillinger/b-2", token],
      ["GET", "/v1/rapporter/b-2", token],
    ]);
    const mnd = (m: string) => [Number(m.slice(0, 4)), Number(m.slice(5, 7))] as const;
    expect(kall[0]!.kropp).toEqual({ opplysningspliktig: ORGNR, oensketInntektsaar: mnd(denne)[0], oensketPeriodeFra: mnd(denne)[1], oensketPeriodeTil: mnd(denne)[1] });
    expect(kall[2]!.kropp).toEqual({ opplysningspliktig: ORGNR, oensketInntektsaar: mnd(forrige)[0], oensketPeriodeFra: mnd(forrige)[1], oensketPeriodeTil: mnd(forrige)[1] });
    expect(tokener).toEqual([{ scope: "skatteetaten:innrapporteringamelding", kunde: `0192:${ORGNR}` }]);
    const o = (await api("GET", `/api/org/${org}/ansatte/aordning`)).data;
    expect(o.henting).toMatchObject({ status: "klar", periode_fra: forrige, periode_til: forrige, feil: null });
    const personer = o.henting.personer;
    expect(personer.map((x: any) => [x.nr, x.fornavn, x.etternavn, x.ansatt_id, x.forslag_id, x.sluttet])).toEqual([
      [1, "Kari", "Hansen", kariId, null, false],
      [2, "Lise M.", "Ny", null, null, false],
      [3, "Sigrid", "Sluttet", null, null, true],
      [4, "Per", "Time", null, perId, false],
    ]);
    // Det appen viser om dem som finnes, og ingen fødselsnumre.
    expect(personer[0].ansatt).toMatchObject({ id: kariId, fornavn: "Kari", har_fnr: true, ansatt_fra: "2026-01-01", arbeidsforhold_id: null });
    expect(personer[3].forslag).toMatchObject({ id: perId, har_fnr: false });
    expect(JSON.stringify(o)).not.toContain(KARI);
    expect(JSON.stringify(o)).not.toContain(LISE);
    const lagret = await somSystem((db) => en<{ fnr: Buffer[] }>(db, "select fnr from faktura.aordning_import where org_id = $1", [org]));
    expect(lagret!.fnr.map((b) => b.toString())).toEqual([`kryptert:${KARI}`, `kryptert:${LISE}`, `kryptert:${SLUTTET}`, `kryptert:${PER}`]);
    // Lederen som bestilte, får varsel.
    expect(ko.filter((x) => x.type === "varsel").map((x: any) => x.varsel)).toEqual([
      expect.objectContaining({ hendelse: "ansatte", bruker_ider: [eierBruker], tittel: "Hentet fra a-ordningen", url: "/ansatte?aordning=1" }),
    ]);
    ko.length = 0;
    // API-et kan ikke lese fødselsnumrene.
    expect((await api("GET", `/api/org/${org}/ansatte/aordning`)).data.henting.fnr).toBeUndefined();
  });

  it("legger inn de nye og oppdaterer dem som finnes, med fødselsnummeret, arbeidsforholdet og lønnen", async () => {
    // Personen med et annet fødselsnummer kan ikke være Lise.
    const feil = await api("POST", `/api/org/${org}/ansatte/aordning/legg-inn`, { valgte: [{ nr: 2, handling: "oppdater", ansatt_id: annenId }] });
    expect(feil.status).toBe(409);
    expect(feil.data.error).toBe("Lise M. Ny: den ansatte har et annet fødselsnummer");
    const r = await api("POST", `/api/org/${org}/ansatte/aordning/legg-inn`, {
      valgte: [
        { nr: 1, handling: "oppdater" },
        { nr: 2, handling: "ny", fornavn: "Lise" },
        { nr: 3, handling: "ny" },
        { nr: 4, handling: "oppdater" },
      ],
    });
    expect(r.status).toBe(200);
    expect(r.data.antall).toEqual({ ny: 2, oppdatert: 2 });
    const ansatte = await somSystem((db) =>
      alle<any>(
        db,
        `select id, fornavn, etternavn, convert_from(fnr_kryptert, 'UTF8') as fnr, to_char(fodselsdato, 'YYYY-MM-DD') as fodselsdato, to_char(ansatt_fra, 'YYYY-MM-DD') as ansatt_fra,
                to_char(ansatt_til, 'YYYY-MM-DD') as ansatt_til, aktiv, stillingsprosent::float8 as stillingsprosent, yrkeskode, arbeidsforhold_id, arbeidstidsordning,
                lonnstype, maanedslonn::float8 as maanedslonn, timelonn::float8 as timelonn, ukentlig_arbeidstid::float8 as ukentlig_arbeidstid
           from faktura.ansatte where org_id = $1 order by ansattnummer`,
        [org],
      ),
    );
    const [kari, per, , lise, sigrid] = ansatte;
    // Kari: arbeidsforholdet slik det er rapportert; lønnen hun har hos oss beholdes.
    expect(kari).toMatchObject({ fnr: `kryptert:${KARI}`, ansatt_fra: "2019-04-01", stillingsprosent: 100, yrkeskode: "2223108", arbeidsforhold_id: "AF-1", maanedslonn: 45000 });
    // Per: fødselsnummeret og fødselsdatoen, arbeidsforholdet, og timelønnen (han hadde ingen lønn).
    expect(per).toMatchObject({
      id: perId,
      fnr: `kryptert:${PER}`,
      fodselsdato: "2001-08-24",
      ansatt_fra: "2024-02-01",
      stillingsprosent: 40,
      arbeidsforhold_id: "2",
      arbeidstidsordning: "andreSkift",
      lonnstype: "time",
      timelonn: 200,
    });
    // Lise: ny, med navnet lederen rettet, fastlønnen og organisasjonens fulle stilling.
    expect(lise).toMatchObject({
      fornavn: "Lise",
      etternavn: "Ny",
      fnr: `kryptert:${LISE}`,
      fodselsdato: "1990-05-17",
      ansatt_fra: "2026-09-01",
      stillingsprosent: 60,
      yrkeskode: "4110101",
      arbeidsforhold_id: "L-7",
      lonnstype: "maaned",
      maanedslonn: 30000,
      ukentlig_arbeidstid: 37.5,
      aktiv: true,
    });
    // Sigrid har sluttet: lagt inn som sluttet.
    expect(sigrid).toMatchObject({ fornavn: "Sigrid", etternavn: "Sluttet", ansatt_til: "2026-08-15", aktiv: false, arbeidsforhold_id: "9" });
    // Skattekortene hentes for dem som fikk fødselsnummeret (ikke den som har sluttet).
    expect(ko.filter((o) => o.type === "skattekort-hent").map((o: any) => o.ansatt_ider)).toEqual([[lise.id, perId]]);
    // Hentingen husker hvem som er lagt inn: de kan ikke legges inn to ganger.
    expect(r.data.henting.personer.map((x: any) => x.ansatt_id)).toEqual([kariId, lise.id, sigrid.id, perId]);
    const igjen = await api("POST", `/api/org/${org}/ansatte/aordning/legg-inn`, { valgte: [{ nr: 2, handling: "ny" }] });
    expect(igjen.status).toBe(409);
    expect(igjen.data.error).toBe("Lise M. Ny: er registrert fra før");
  });

  it("feilene: ukjent adresse, avvist tilgang og en rapport som ikke blir klar", async () => {
    kall.length = 0;
    bestilling = () => json(404, { kode: "AMLD_1023", melding: "Finner ingen ressurs for denne urlen" });
    await henterIgjen();
    expect(await kjor()).toHaveLength(1);
    let o = (await api("GET", `/api/org/${org}/ansatte/aordning`)).data.henting;
    expect(o.status).toBe("feil");
    expect(o.feil).toContain("Skatteetaten kjente ikke igjen adressen til avstemmingsrapporten (404): Finner ingen ressurs for denne urlen (AMLD_1023)");
    // Personene fra forrige henting står.
    expect(o.personer).toHaveLength(4);

    bestilling = () => json(403, { kode: "AMLD_005", melding: "Feil i forbindelse med autorisering" });
    await henterIgjen();
    await kjor();
    o = (await api("GET", `/api/org/${org}/ansatte/aordning`)).data.henting;
    expect(o.feil).toContain("Skatteetaten avviste tilgangen til avstemmingsrapporten (403)");
    expect(o.feil).toContain("tilgangspakken «A-ordningen»");

    // Ikke klar: nytt forsøk om et minutt med bestillingen og måneden; feil fra Skatteetaten (5xx) prøves igjen.
    const [denne, , eldst] = maanederFor(iDag()) as [string, string, string];
    bestilling = () => json(201, { id: "b-3", status: "OPPRETTES" });
    statuser = [];
    await henterIgjen();
    await kjor();
    expect(ko.filter((x) => x.type === "aordning-hent")).toEqual([
      expect.objectContaining({ type: "aordning-hent", org_id: org, bestilling: "https://avst.test/v1/bestillinger/b-3", forsok: 1, maaned: denne }),
    ]);
    statuser = [() => json(500, { kode: "AMLD_001", melding: "Uventet feil på tjenesten" })];
    await expect(kjor()).rejects.toThrow("Skatteetaten avviste hentingen av avstemmingsrapporten (500)");
    o = (await api("GET", `/api/org/${org}/ansatte/aordning`)).data.henting;
    expect(o).toMatchObject({ status: "bestilt" });
    expect(o.feil).toContain("(500)");
    // En bestilling som feilet hos Skatteetaten: en feil som ikke prøves igjen.
    statuser = [() => json(200, { id: "b-3", status: "FEILET" })];
    expect(await hentFraAordningen(org, "https://avst.test/v1/bestillinger/b-3", 1, denne)).toBeNull();
    o = (await api("GET", `/api/org/${org}/ansatte/aordning`)).data.henting;
    expect(o).toMatchObject({ status: "feil", feil: "Skatteetaten klarte ikke å lage avstemmingsrapporten. Prøv å hente på nytt." });
    // Ingen a-melding de tre siste månedene (rapporten uten innhold, 204, er det samme): ingen
    // personer, og perioden som ble prøvd.
    kall.length = 0;
    bestilling = () => json(201, { id: "b-4", status: "OPPRETTES" });
    statuser = [0, 1, 2].map((i) => () => json(200, { id: "b-4", status: i === 1 ? "KLAR" : "INGEN_DATA" }));
    rapport = () => new Response(null, { status: 204 });
    await henterIgjen();
    await kjor();
    expect(kall.filter((k) => k.metode === "POST")).toHaveLength(3);
    o = (await api("GET", `/api/org/${org}/ansatte/aordning`)).data.henting;
    expect(o).toMatchObject({ status: "klar", periode_fra: eldst, periode_til: denne, personer: [] });
    // Med en gang klar.
    bestilling = () => json(201, { id: "b-5", status: "KLAR" });
    statuser = [() => json(200, { id: "b-5", status: "KLAR" })];
    rapport = () => json(200, { mottatt: { fomKalendermaaned: denne, tomKalendermaaned: denne, oppgave: { virksomhet: [{ inntektsmottaker: [{ norskIdentifikator: LISE, identifiserendeInformasjon: { navn: "Lise Ny", foedselsdato: "1990-05-17" } }] }] } } });
    await henterIgjen();
    await kjor();
    o = (await api("GET", `/api/org/${org}/ansatte/aordning`)).data.henting;
    expect(o).toMatchObject({ status: "klar", feil: null });
    // Lise finnes nå (samme fødselsnummer).
    expect(o.personer[0].ansatt_id).toBeTruthy();
  });

  it("bare eier og administrator (Personal)", async () => {
    const regnskap = "Bearer test:uid-aordning-regn:aordning-regn@server.test:mfa";
    const inv = await api("POST", `/api/org/${org}/invitasjoner`, { epost: "aordning-regn@server.test", rolle: "regnskap" });
    await app.request("/api/invitasjoner/aksepter", { method: "POST", headers: { authorization: regnskap, "content-type": "application/json" }, body: JSON.stringify({ token: inv.data.lenke.split("/").pop() }) });
    for (const [m, sti] of [
      ["GET", "/ansatte/aordning"],
      ["POST", "/ansatte/aordning/hent"],
    ] as const) {
      const r = await app.request(`/api/org/${org}${sti}`, { method: m, headers: { authorization: regnskap, "content-type": "application/json" } });
      expect(r.status).toBe(403);
    }
  });
});
