// A-meldingen (0077_amelding.sql, amelding.ts, ameldingInnsending.ts, ameldingRuter.ts):
// leveransen (JSON til API-et og XML som valideres mot skjemaet for format 2.3 når xmllint finnes),
// summene for forskuddstrekket og arbeidsgiveravgiften (også sone 1a), kontrollen, tolkningen av
// tilbakemeldingen, og hele flyten i appen: månedene og grunnlaget med avvikene, fila som workeren
// lager (med fødselsnumrene) og som merkes som levert, innsendingen til Skatteetaten med
// systembrukeren (når den er slått på og tilgangen har «A-ordningen»), tilbakemeldingen fra
// Dialogporten, og utvidelsen av tilgangen i Altinn.
import { execFileSync, spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { lagApi } from "../src/api.js";
import { somSystem } from "../src/db.js";
import { settKryptering } from "../src/kryptering.js";
import { lagring, settLokalOppgavekjorer, type Oppgave } from "../src/tjenester.js";
import { settEtatFetch } from "../src/maskinporten.js";
import { avgiftsgrunnlag, byggLeveranse, kontroller, oppsummer, sumAvgift, tilXml, type Grunnlag } from "../src/amelding.js";
import { tilbakemeldingUrl, tolkTilbakemelding } from "../src/ameldingInnsending.js";
import { frist } from "../src/ameldingRuter.js";
import { kjorOppgave } from "../src/worker.js";

const her = path.dirname(fileURLToPath(import.meta.url));
const harXmllint = spawnSync("xmllint", ["--version"]).status === 0;
function valider(xml: string) {
  const fil = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "amelding-")), "melding.xml");
  fs.writeFileSync(fil, xml);
  execFileSync("xmllint", ["--noout", "--schema", path.join(her, "xsd", "amelding_v2_3.xsd"), fil], { stdio: "pipe" });
}

const fast = (id: string, nr: number, navn: string, ekstra: Partial<Grunnlag["arbeidsforhold"][number]> = {}) => ({
  id,
  ansattnummer: nr,
  navn,
  har_fnr: true,
  ansatt_fra: "2025-01-01",
  ansatt_til: null,
  stillingsprosent: 100,
  ansettelsestype: "fast" as const,
  yrkeskode: "2221104",
  arbeidsforhold_type: "ordinaertArbeidsforhold",
  arbeidstidsordning: "ikkeSkift",
  aarsak_sluttdato: null,
  siste_lonnsendring: null,
  siste_stillingsendring: "2026-03-01",
  ...ekstra,
});

const GRUNNLAG: Grunnlag = {
  maaned: "2026-11",
  org: { navn: "Hansen & Co AS", orgnr: "915000177" },
  virksomhet: "915000185",
  pensjonsinnretning: "915000193",
  sone: "1",
  fullStilling: 37.5,
  arbeidsforhold: [
    fast("kari", 1, "Kari Hansen"),
    fast("per", 2, "Per Time", { stillingsprosent: 50, ansettelsestype: "tilkalling", ansatt_til: "2026-11-30", aarsak_sluttdato: "kontraktEngasjementEllerVikariatErUtloept" }),
  ],
  slipper: [
    {
      ansatt_id: "kari",
      utbetalingsdato: "2026-11-20",
      skattetrekk: 15000.4,
      aga: 7191,
      aga_grunnlag: 51000,
      aga_sats: 14.1,
      otp: 1000,
      linjer: [
        { lonnsart: "fastlonn", belop: 50000, antall: null },
        { lonnsart: "utgift", belop: 300, antall: null },
        { lonnsart: "trekk_etter_skatt", belop: -200, antall: null },
      ],
    },
    {
      ansatt_id: "per",
      utbetalingsdato: "2026-11-20",
      skattetrekk: 600,
      aga: 324.3,
      aga_grunnlag: 2300,
      aga_sats: 14.1,
      otp: 0,
      linjer: [
        { lonnsart: "timelonn", belop: 2000, antall: 10 },
        { lonnsart: "overtid", belop: 300, antall: 1 },
      ],
    },
    { ansatt_id: "kari", utbetalingsdato: "2026-11-30", skattetrekk: 2500, aga: 705, aga_grunnlag: 5000, aga_sats: 14.1, otp: 0, linjer: [{ lonnsart: "bonus", belop: 5000, antall: null }] },
  ],
  utkast: [],
  permisjoner: [],
};
const VALG = { meldingsId: "a1b2c3d4-0000-4000-8000-000000000001", tidspunkt: "2026-12-03T09:15:00Z", fnr: (id: string) => (id === "kari" ? "13830197340" : "24880199664") };

describe("a-meldingen (uten database)", () => {
  it("leveransen: arbeidsforhold, inntekter etter beskrivelsen, forskuddstrekk og avgift", () => {
    const { leveranse } = byggLeveranse(GRUNNLAG, VALG) as any;
    expect(leveranse).toMatchObject({
      kalendermaaned: "2026-11",
      kildesystem: "HI4 Faktura",
      meldingsId: VALG.meldingsId,
      opplysningspliktig: { norskIdentifikator: "915000177" },
      spraakForTilbakemelding: "bokmaal",
    });
    expect(leveranse.erstatterMeldingsId).toBeUndefined();
    // Feltene i rekkefølgen skjemaet krever.
    expect(Object.keys(leveranse)).toEqual(["leveringstidspunkt", "kalendermaaned", "kildesystem", "meldingsId", "opplysningspliktig", "oppgave", "spraakForTilbakemelding"]);
    expect(leveranse.oppgave.betalingsinformasjon).toEqual({
      sumArbeidsgiveravgift: 8220,
      sumForskuddstrekkPerLoennsutbetalingsdato: [
        { loennsutbetalingsdato: "2026-11-20", beloep: 15600 },
        { loennsutbetalingsdato: "2026-11-30", beloep: 2500 },
      ],
    });
    expect(leveranse.oppgave.pensjonsinnretning).toEqual([{ identifikator: "915000193" }]);
    const v = leveranse.oppgave.virksomhet[0];
    expect(v.norskIdentifikator).toBe("915000185");
    const [kari, per] = v.inntektsmottaker;
    expect(kari.norskIdentifikator).toBe("13830197340");
    expect(kari.arbeidsforhold).toEqual([
      {
        arbeidsforholdId: "1",
        typeArbeidsforhold: "ordinaertArbeidsforhold",
        startdato: "2025-01-01",
        antallTimerPerUkeSomEnFullStillingTilsvarer: "37.5",
        yrke: "2221104",
        arbeidstidsordning: "ikkeSkift",
        stillingsprosent: "100",
        sisteLoennsendringsdato: "2025-01-01",
        sisteDatoForStillingsprosentendring: "2026-03-01",
        formForAnsettelse: "fast",
      },
    ]);
    // Trekket er negativt for den ansatte; utgiften og trekket etter skatt er ikke med.
    expect(kari.forskuddstrekk).toEqual([{ beskrivelse: "ordinaert", beloep: -17500 }]);
    expect(kari.inntekt).toEqual([
      { fordel: "kontantytelse", utloeserArbeidsgiveravgift: true, inngaarIGrunnlagForTrekk: true, beloep: "50000.00", arbeidsforholdId: "1", loennsinntekt: { beskrivelse: "fastloenn" } },
      { fordel: "kontantytelse", utloeserArbeidsgiveravgift: true, inngaarIGrunnlagForTrekk: true, beloep: "5000.00", arbeidsforholdId: "1", loennsinntekt: { beskrivelse: "bonus" } },
    ]);
    expect(per.arbeidsforhold[0]).toMatchObject({ sluttdato: "2026-11-30", stillingsprosent: "50", aarsakTilSluttdato: "kontraktEngasjementEllerVikariatErUtloept", formForAnsettelse: "midlertidigAnsattSomTilkallingsvikar" });
    expect(per.inntekt.map((i: any) => [i.loennsinntekt.beskrivelse, i.beloep, i.loennsinntekt.antall])).toEqual([
      ["timeloenn", "2000.00", "10"],
      ["overtidsgodtgjoerelse", "300.00", undefined],
    ]);
    // Arbeidsgiveravgiften: lønnen og pensjonen (OTP) for seg.
    expect(v.arbeidsgiveravgift).toEqual({
      loennOgGodtgjoerelse: [{ beregningskodeForArbeidsgiveravgift: "generelleNaeringer", sone: "1", avgiftsgrunnlagBeloep: "57300.00", prosentsatsForAvgiftsberegning: "14.1" }],
      tilskuddOgPremieTilPensjon: [{ beregningskodeForArbeidsgiveravgift: "generelleNaeringer", sone: "1", avgiftsgrunnlagBeloep: "1000.00", prosentsatsForAvgiftsberegning: "14.1" }],
    });
    // En rettet melding erstatter den forrige.
    expect((byggLeveranse(GRUNNLAG, { ...VALG, erstatter: "forrige-id" }) as any).leveranse.erstatterMeldingsId).toBe("forrige-id");
  });

  it("XML-en har samme innhold og følger skjemaet", () => {
    const xml = tilXml(byggLeveranse(GRUNNLAG, VALG));
    expect(xml).toContain('<melding xmlns="urn:ske:fastsetting:innsamling:a-meldingen:v2_3">');
    expect(xml).toContain("<Leveranse>");
    expect(xml).toContain("<norskIdentifikator>13830197340</norskIdentifikator>");
    expect(xml).toContain("<utloeserArbeidsgiveravgift>true</utloeserArbeidsgiveravgift>");
    if (harXmllint) valider(xml);
    // Også uten lønn i måneden (bare arbeidsforholdene).
    const tom = tilXml(byggLeveranse({ ...GRUNNLAG, slipper: [] }, VALG));
    expect(tom).not.toContain("betalingsinformasjon");
    if (harXmllint) valider(tom);
  });

  it("sone 1a: slippen der fribeløpet ble brukt opp, deles i redusert og full sats", () => {
    const g = avgiftsgrunnlag([{ ansatt_id: "a", utbetalingsdato: "2026-11-20", skattetrekk: 0, aga: 1235, aga_grunnlag: 10000, aga_sats: 12.35, otp: 0, linjer: [] }], "1a");
    expect(g).toEqual([
      { sats: 14.1, lonn: 5000, pensjon: 0 },
      { sats: 10.6, lonn: 5000, pensjon: 0 },
    ]);
    expect(sumAvgift(g)).toBe(1235);
  });

  it("AFP (0098): premien som er betalt i måneden, er pensjonspremie med avgift (også uten lønn i måneden)", () => {
    const premier = [{ afp: 1111.36, aga: 156.7, aga_sats: 14.1 }];
    const g = avgiftsgrunnlag(GRUNNLAG.slipper, "1", premier);
    expect(g).toEqual([{ sats: 14.1, lonn: 57300, pensjon: 2111.36 }]);
    expect(sumAvgift(g)).toBe(sumAvgift(avgiftsgrunnlag(GRUNNLAG.slipper, "1")) + 157);
    // Bare premien i måneden: betalingsinformasjonen og avgiften er med.
    const bare: Grunnlag = { ...GRUNNLAG, slipper: [], premier };
    const { leveranse } = byggLeveranse(bare, VALG) as any;
    expect(leveranse.oppgave.betalingsinformasjon).toEqual({ sumArbeidsgiveravgift: 157 });
    expect(leveranse.oppgave.virksomhet[0].arbeidsgiveravgift).toEqual({
      tilskuddOgPremieTilPensjon: [{ beregningskodeForArbeidsgiveravgift: "generelleNaeringer", sone: "1", avgiftsgrunnlagBeloep: "1111.36", prosentsatsForAvgiftsberegning: "14.1" }],
    });
    if (harXmllint) valider(tilXml(byggLeveranse(bare, VALG)));
    // Sluttvederlaget (0098) har sin egen beskrivelse.
    const slutt: Grunnlag = { ...GRUNNLAG, slipper: GRUNNLAG.slipper.map((x, i) => (i ? x : { ...x, linjer: [...x.linjer, { lonnsart: "sluttvederlag", belop: 100000, antall: null }] })) };
    const inntekt = (byggLeveranse(slutt, VALG) as any).leveranse.oppgave.virksomhet[0].inntektsmottaker[0].inntekt;
    expect(inntekt.find((i: any) => i.loennsinntekt?.beskrivelse === "sluttvederlag")).toMatchObject({ fordel: "kontantytelse", utloeserArbeidsgiveravgift: true, inngaarIGrunnlagForTrekk: true, beloep: "100000.00", loennsinntekt: { beskrivelse: "sluttvederlag" } });
    if (harXmllint) valider(tilXml(byggLeveranse(slutt, VALG)));
    expect(oppsummer(bare)).toMatchObject({ arbeidsgiveravgift: 157, afp_premie: 1111.36 });
    // Påminnelsen når premien for forrige kvartal ikke er registrert som betalt.
    expect(kontroller({ ...GRUNNLAG, afpIkkeBetalt: { kvartal: "3. kvartal 2026", avsatt: 12345.6 } }).map((a) => a.tekst)).toContain(
      "AFP-premien for 3. kvartal 2026 (avsatt 12 345,60 kr) er ikke registrert som betalt. Registrer betalingen under Lønn → AFP når fakturaen fra Fellesordningen er betalt, så kommer arbeidsgiveravgiften av premien med i a-meldingen for den måneden.",
    );
  });

  it("frilansere og styremedlemmer (0096): honorar og styrehonorar, arbeidsforholdet uten ansettelsesform og sluttårsak", () => {
    const frilans = { arbeidsforhold_type: "frilanserOppdragstakerHonorarPersonerMm" };
    const g: Grunnlag = {
      ...GRUNNLAG,
      pensjonsinnretning: null,
      arbeidsforhold: [
        fast("lege", 3, "Lise Lege", { ...frilans, ansatt_fra: "2026-11-02", ansatt_til: "2026-11-30", aarsak_sluttdato: "kontraktEngasjementEllerVikariatErUtloept", yrkeskode: "2211107" }),
        fast("styre", 4, "Sverre Styre", { ...frilans, yrkeskode: "1120119" }),
      ],
      slipper: [
        { ansatt_id: "lege", utbetalingsdato: "2026-11-20", skattetrekk: 7040, aga: 2481.6, aga_grunnlag: 17600, aga_sats: 14.1, otp: 0, linjer: [{ lonnsart: "honorar", belop: 17600, antall: 22 }] },
        { ansatt_id: "styre", utbetalingsdato: "2026-11-20", skattetrekk: 18600, aga: 8460, aga_grunnlag: 60000, aga_sats: 14.1, otp: 0, linjer: [{ lonnsart: "styrehonorar", belop: 60000, antall: null }] },
      ],
    };
    const valg = { ...VALG, fnr: (id: string) => (id === "lege" ? "13830197340" : "24880199664") };
    const { leveranse } = byggLeveranse(g, valg) as any;
    const [lege, styre] = leveranse.oppgave.virksomhet[0].inntektsmottaker;
    // Arbeidsforholdet: startdatoen for oppdraget, yrket og sluttdatoen, ikke ansettelsesform,
    // arbeidstid, stillingsprosent eller sluttårsak.
    expect(lege.arbeidsforhold).toEqual([
      { arbeidsforholdId: "3", typeArbeidsforhold: "frilanserOppdragstakerHonorarPersonerMm", startdato: "2026-11-02", sluttdato: "2026-11-30", yrke: "2211107" },
    ]);
    expect(lege.inntekt).toEqual([
      { fordel: "kontantytelse", utloeserArbeidsgiveravgift: true, inngaarIGrunnlagForTrekk: true, beloep: "17600.00", arbeidsforholdId: "3", loennsinntekt: { beskrivelse: "honorarAkkordProsentProvisjon" } },
    ]);
    expect(styre.inntekt).toEqual([
      { fordel: "kontantytelse", utloeserArbeidsgiveravgift: true, inngaarIGrunnlagForTrekk: true, beloep: "60000.00", arbeidsforholdId: "4", loennsinntekt: { beskrivelse: "styrehonorarOgGodtgjoerelseVerv" } },
    ]);
    expect(leveranse.oppgave.virksomhet[0].arbeidsgiveravgift.loennOgGodtgjoerelse).toEqual([
      { beregningskodeForArbeidsgiveravgift: "generelleNaeringer", sone: "1", avgiftsgrunnlagBeloep: "77600.00", prosentsatsForAvgiftsberegning: "14.1" },
    ]);
    // Uten OTP trengs ingen pensjonsinnretning; ingen sluttårsak å velge for frilanseren.
    expect(kontroller(g)).toEqual([]);
    // Yrket må også oppgis for frilansere og styremedlemmer.
    expect(kontroller({ ...g, arbeidsforhold: [g.arbeidsforhold[0]!, { ...g.arbeidsforhold[1]!, yrkeskode: null }] }).map((x) => x.tekst)).toEqual([
      "Sverre Styre mangler yrkeskode (7 siffer, SSBs yrkeskoder).",
    ]);
    if (harXmllint) valider(tilXml(byggLeveranse(g, valg)));
  });

  it("kontrollen: virksomheten, pensjonsinnretningen, fødselsnummer, yrkeskode, sluttdato, utkast og permisjon", () => {
    const a = kontroller({
      ...GRUNNLAG,
      virksomhet: null,
      pensjonsinnretning: null,
      arbeidsforhold: [fast("kari", 1, "Kari Hansen", { har_fnr: false, yrkeskode: null }), fast("per", 2, "Per Time", { ansatt_til: "2026-11-15" })],
      utkast: [{ periode: "2026-11-01", type: "ekstra" }],
      // Permisjon (0084): uten art (må velges), kort (rapporteres ikke) og permittering som slutter
      // i måneden uten bekreftet sluttdato.
      permisjoner: [
        { id: "p1", ansatt_id: "per", fra: "2026-11-01", til: "2026-11-20", art: null, prosent: 100, slutt_ukjent: false, betalt: false },
        { id: "p2", ansatt_id: "kari", fra: "2026-11-02", til: "2026-11-06", art: null, prosent: 100, slutt_ukjent: false, betalt: true },
        { id: "p3", ansatt_id: "kari", fra: "2026-11-09", til: "2026-11-27", art: "permittering", prosent: 50, slutt_ukjent: true, betalt: false },
      ],
    });
    expect(a.map((x) => [x.niva, x.tekst])).toEqual([
      ["feil", "Legg inn organisasjonsnummeret til virksomheten (underenheten i Enhetsregisteret) under Innstillinger → Ansatte og timer → A-melding."],
      ["feil", "Det er OTP i måneden: legg inn organisasjonsnummeret til pensjonsleverandøren under Innstillinger → Ansatte og timer → A-melding."],
      ["feil", "Kari Hansen mangler fødselsnummer (eller D-nummer)."],
      ["feil", "Kari Hansen mangler yrkeskode (7 siffer, SSBs yrkeskoder)."],
      ["advarsel", "Per Time slutter 15.11.2026: velg årsaken til sluttdatoen."],
      ["advarsel", "Lønnskjøringen for 2026-11 (ekstra) med utbetaling i måneden står som utkast og er ikke med."],
      ["feil", "Velg hva slags permisjon Per Time har (01.11.2026–20.11.2026, under Fravær): permisjon over 14 dager skal med i a-meldingen."],
      [
        "advarsel",
        "Permittering for Kari Hansen står til og med 27.11.2026 uten bekreftet sluttdato, og den datoen rapporteres som sluttdato. Forleng den om den varer lenger.",
      ],
    ]);
    expect(kontroller(GRUNNLAG)).toEqual([]);
    expect(oppsummer(GRUNNLAG)).toMatchObject({ antall_arbeidsforhold: 2, antall_med_lonn: 2, inntekt: 57300, sum_forskuddstrekk: 18100, arbeidsgiveravgift: 8220 });
  });

  it("fristen er den 5. i måneden etter, eller neste virkedag", () => {
    expect(frist("2026-11")).toBe("2026-12-07"); // 5. desember 2026 er en lørdag
    expect(frist("2026-12")).toBe("2027-01-05");
  });

  it("tilbakemeldingen: lenken i dialogen, status og avvik (uten fødselsnumre)", () => {
    const dialog = {
      transmissions: [
        {
          attachments: [
            {
              urls: [
                { url: "https://skatt-test.sits.no/web/aor-tilbakemelding/uthenting/v1/dialoger/1", consumerType: "Gui" },
                { url: "https://ameldingtilbakemelding.api.skatteetaten-test.no/v1/forsendelser/2", consumerType: "Api" },
              ],
            },
          ],
        },
      ],
    };
    expect(tilbakemeldingUrl(dialog)).toBe("https://ameldingtilbakemelding.api.skatteetaten-test.no/v1/forsendelser/2");
    expect(tilbakemeldingUrl({ transmissions: [] })).toBe(null);
    expect(tolkTilbakemelding({ mottak: { mottakstatus: "MOTTATT", avvik: [{ kode: "F123", beskrivelse: "Feil for 13830197340", alvorlighetsgrad: "opplysning" }] } })).toEqual({
      status: "mottatt",
      avvik: [{ kode: "F123", tekst: "Feil for •••••••••••", alvorlighet: "opplysning" }],
    });
    expect(tolkTilbakemelding({ mottak: { mottakstatus: "avvist" } }).status).toBe("avvist");
    expect(tolkTilbakemelding({}).status).toBe(null);
    expect(tolkTilbakemelding({ status: "IKKE_MOTTATT" }).status).toBe(null);
    expect(tolkTilbakemelding({ forsendelse: { status: "underBehandling" } }).status).toBe(null);
    expect(tolkTilbakemelding({ status: "OK" }).status).toBe("mottatt");
  });
});

describe.skipIf(!process.env.DATABASE_URL)("a-meldingen i appen", () => {
  const app = lagApi();
  const eier = "Bearer test:uid-amelding-eier:amelding-eier@server.test:mfa";
  const ko: Oppgave[] = [];
  const filer = new Map<string, Uint8Array>();
  const kall: { metode: string; url: string; kropp: any }[] = [];
  let org: string;
  let kari: string;
  let per: string;
  let filId: string;
  let filMelding: string;

  const api = async (m: string, sti: string, b?: unknown, hvem = eier) => {
    const r = await app.request(sti, { method: m, headers: { authorization: hvem, "content-type": "application/json" }, body: b === undefined ? undefined : JSON.stringify(b) });
    return { status: r.status, data: (r.headers.get("content-type") ?? "").includes("json") ? ((await r.json()) as any) : await r.text() };
  };
  const json = (status: number, data: unknown) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
  const kjor = async (type: string) => {
    const mine = ko.filter((o) => o.type === type);
    ko.splice(0, ko.length, ...ko.filter((o) => o.type !== type));
    for (const o of mine) await kjorOppgave({ ...o, oppgave_id: "t" } as any);
  };

  beforeAll(async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
    Object.assign(config, {
      maskinportenKlientId: "klient-1",
      maskinportenNokkelId: "kid-1",
      maskinportenNokkel: privateKey,
      maskinportenUrl: "https://mp.test",
      altinnUrl: "https://altinn.test",
      ameldingUrl: "https://amelding.test/v1",
      filerBucket: "test-filer",
      ameldingInnsending: false,
    });
    settKryptering(async (t) => Buffer.from(`kryptert:${t}`), async (d) => d.toString().replace(/^kryptert:/, ""));
    settLokalOppgavekjorer(async (o) => void ko.push(o));
    lagring.lagre = async (_b, sti, data) => void filer.set(sti, data);
    lagring.signertUrl = async (_b, sti) => `https://lagring.test/${sti}`;
    settEtatFetch(async (url, init) => {
      const u = new URL(String(url));
      const tekst = init?.body ? String(init.body) : null;
      const k = { metode: init?.method ?? "GET", url: `${u.host}${u.pathname}${u.search}`, kropp: tekst && tekst.startsWith("{") ? JSON.parse(tekst) : tekst };
      if (u.host === "mp.test") return json(200, { access_token: "tok", expires_in: 120 });
      kall.push(k);
      if (k.metode === "POST" && u.host === "amelding.test" && u.pathname.startsWith("/v1/innsending/"))
        return json(200, { dialogId: "dialog-1", forsendelseId: "forsendelse-1", meldingsId: k.kropp.leveranse.meldingsId });
      if (u.host === "altinn.test" && u.pathname === "/dialogporten/api/v1/enduser/dialogs/dialog-1")
        return json(200, { transmissions: [{ attachments: [{ urls: [{ url: "https://tilbakemelding.test/v1/forsendelser/forsendelse-1", consumerType: "Api" }] }] }] });
      if (u.host === "tilbakemelding.test") return json(200, { mottak: { mottakstatus: "mottatt", avvik: [{ kode: "F999", beskrivelse: "Bare en opplysning", alvorlighetsgrad: "opplysning" }] } });
      if (k.metode === "POST" && u.pathname === "/authentication/api/v1/systemuser/changerequest/vendor")
        return json(201, { id: "4f0d7c4e-0000-4000-8000-0000000000e1", status: "New", confirmUrl: "https://altinn.test/godkjenn/endring" });
      if (u.pathname === "/authentication/api/v1/systemuser/changerequest/vendor/4f0d7c4e-0000-4000-8000-0000000000e1") return json(200, { id: "4f0d7c4e-0000-4000-8000-0000000000e1", status: "Accepted" });
      throw new Error(`Uventet kall: ${k.metode} ${k.url}`);
    });

    org = (await api("POST", "/api/organisasjoner", { navn: "A-melding Test AS", orgnr: "915000177" })).data.id;
    expect((await api("PUT", `/api/org/${org}/lonn-oppsett`, { aktiv: true })).status).toBe(200);
    const ny = async (b: Record<string, unknown>) => {
      const r = await api("POST", `/api/org/${org}/ansatte`, { ansatt_fra: "2025-01-01", ...b });
      expect(r.status, JSON.stringify(r.data)).toBe(201);
      return r.data.id as string;
    };
    kari = await ny({ fornavn: "Kari", etternavn: "Melding", fnr: "13830197340", lonnstype: "maaned", maanedslonn: 50000, kontonr: "12345678903", skattekort: "prosent", skatt_prosent: 30, yrkeskode: "2221104" });
    per = await ny({ fornavn: "Per", etternavn: "Melding", fnr: "24880199664", lonnstype: "maaned", maanedslonn: 20000, skattekort: "prosent", skatt_prosent: 20 });
    const k = (await api("POST", `/api/org/${org}/lonn/kjoringer`, { periode: "2026-09" })).data;
    expect((await api("POST", `/api/org/${org}/lonn/kjoringer/${k.id}/godkjenn`)).status).toBe(200);
  });

  it("månedene, grunnlaget og avvikene; feltene på den ansatte og i oppsettet", async () => {
    const l = (await api("GET", `/api/org/${org}/amelding?aar=2026`)).data;
    expect(l.innsending).toEqual({ pa: false, tilgang: false, miljo: "test" });
    expect(l.maaneder.find((m: any) => m.maaned === "2026-09")).toMatchObject({ frist: "2026-10-05", med_lonn: 2, arbeidsforhold: 2, siste: null });
    const g = (await api("GET", `/api/org/${org}/amelding/2026-09`)).data;
    expect(g.avvik.map((a: any) => a.tekst)).toEqual([
      "Legg inn organisasjonsnummeret til virksomheten (underenheten i Enhetsregisteret) under Innstillinger → Ansatte og timer → A-melding.",
      "Det er OTP i måneden: legg inn organisasjonsnummeret til pensjonsleverandøren under Innstillinger → Ansatte og timer → A-melding.",
      "Per Melding mangler yrkeskode (7 siffer, SSBs yrkeskoder).",
      // OTP (0097): de som er med i ordningen, meldes inn hos pensjonsleverandøren.
      "Kari Melding er med i OTP fra 01.01.2025: meld den ansatte inn hos pensjonsleverandøren, og før datoen på den ansatte.",
      "Per Melding er med i OTP fra 01.01.2025: meld den ansatte inn hos pensjonsleverandøren, og før datoen på den ansatte.",
    ]);
    expect(g.grunnlag).toMatchObject({ antall_med_lonn: 2, inntekt: 70000 });
    expect((await api("POST", `/api/org/${org}/amelding/2026-09`, { innsending: "fil" })).data.error).toContain("mangler yrkeskode");
    // Feltene.
    expect((await api("PUT", `/api/org/${org}/lonn-oppsett`, { virksomhet_orgnr: "915000186" })).data.error).toBe("Organisasjonsnummeret til virksomheten er ikke gyldig");
    expect((await api("PUT", `/api/org/${org}/lonn-oppsett`, { virksomhet_orgnr: "915 000 185", pensjonsinnretning_orgnr: "915000193" })).data).toMatchObject({
      virksomhet_orgnr: "915000185",
      pensjonsinnretning_orgnr: "915000193",
    });
    expect((await api("PATCH", `/api/org/${org}/ansatte/${per}`, { yrkeskode: "12" })).data.error).toBe("Yrkeskoden må ha 7 siffer");
    const p = (await api("PATCH", `/api/org/${org}/ansatte/${per}`, { yrkeskode: "4110101", arbeidstidsordning: "skift365" })).data;
    expect((await api("GET", `/api/org/${org}/ansatte/${per}`)).data).toMatchObject({ yrkeskode: "4110101", arbeidstidsordning: "skift365", arbeidsforhold_type: "ordinaertArbeidsforhold" });
    expect(p).toBeTruthy();
    for (const a of [kari, per]) expect((await api("PATCH", `/api/org/${org}/ansatte/${a}`, { otp_innmeldt: "2025-01-10" })).status).toBe(200);
    expect((await api("GET", `/api/org/${org}/amelding/2026-09`)).data.avvik).toEqual([]);
  });

  it("fila: workeren lager den med fødselsnumrene, lenken, og merket som levert", async () => {
    const m = await api("POST", `/api/org/${org}/amelding/2026-09`, { innsending: "fil" });
    expect(m.status).toBe(201);
    expect(m.data).toMatchObject({ maaned: "2026-09", innsending: "fil", status: "lages", erstatter: null });
    filId = m.data.id;
    filMelding = m.data.meldings_id;
    expect((await api("GET", `/api/org/${org}/amelding/fil/${filId}`)).data.error).toBe("Fila er ikke klar ennå.");
    await kjor("amelding-lag");
    const rad = (await api("GET", `/api/org/${org}/amelding/2026-09`)).data.meldinger[0];
    expect(rad).toMatchObject({ id: filId, status: "klar", feil: null });
    expect(rad.oppsummering).toMatchObject({ antall_med_lonn: 2, inntekt: 70000 });
    const xml = new TextDecoder().decode(filer.get(`amelding/${org}/2026-09/${filMelding}.xml`)!);
    expect(xml).toContain("<norskIdentifikator>13830197340</norskIdentifikator>");
    expect(xml).toContain("<norskIdentifikator>915000185</norskIdentifikator>");
    expect(xml).toContain(`<meldingsId>${filMelding}</meldingsId>`);
    if (harXmllint) valider(xml);
    expect((await api("GET", `/api/org/${org}/amelding/fil/${filId}`)).data).toEqual({ url: `https://lagring.test/amelding/${org}/2026-09/${filMelding}.xml` });
    expect((await api("POST", `/api/org/${org}/amelding/fil/${filId}/levert`, { levert: true })).status).toBe(200);
    expect((await api("GET", `/api/org/${org}/amelding?aar=2026`)).data.maaneder.find((x: any) => x.maaned === "2026-09").siste).toMatchObject({ status: "levert" });
  });

  it("innsending til Skatteetaten: slått på, med «A-ordningen», og tilbakemeldingen", async () => {
    expect((await api("POST", `/api/org/${org}/amelding/2026-09`, { innsending: "api" })).data.error).toContain("ikke slått på ennå");
    config.ameldingInnsending = true;
    expect((await api("POST", `/api/org/${org}/amelding/2026-09`, { innsending: "api" })).data.error).toContain("Gi tilgang til a-meldingen i Altinn først");
    await somSystem((db) =>
      db.query("insert into faktura.skattekort_tilgang (org_id, status, pakker) values ($1, 'godkjent', '{urn:altinn:accesspackage:lonn,urn:altinn:accesspackage:a-ordning}')", [org]),
    );
    const m = await api("POST", `/api/org/${org}/amelding/2026-09`, { innsending: "api" });
    expect(m.status).toBe(201);
    // Den nye meldingen erstatter fila som ble lastet opp.
    expect(m.data.erstatter).toBe(filMelding);
    await kjor("amelding-lag");
    const sendt = kall.find((k) => k.metode === "POST" && k.url.startsWith("amelding.test/v1/innsending/"))!;
    expect(sendt.url).toBe(`amelding.test/v1/innsending/2026-09/915000177?idempotencyKey=${m.data.id}`);
    expect(sendt.kropp.leveranse).toMatchObject({ erstatterMeldingsId: filMelding, meldingsId: m.data.meldings_id, kalendermaaned: "2026-09" });
    let rad = (await api("GET", `/api/org/${org}/amelding/2026-09`)).data.meldinger[0];
    expect(rad).toMatchObject({ status: "sendt", forsendelse_id: "forsendelse-1" });
    // Mens den venter på tilbakemelding, får måneden ikke en ny.
    expect((await api("POST", `/api/org/${org}/amelding/2026-09`, { innsending: "api" })).status).toBe(409);
    await kjor("amelding-status");
    rad = (await api("GET", `/api/org/${org}/amelding/2026-09`)).data.meldinger[0];
    expect(rad).toMatchObject({ status: "mottatt" });
    expect(rad.tilbakemelding.avvik).toEqual([{ kode: "F999", tekst: "Bare en opplysning", alvorlighet: "opplysning" }]);
    expect(ko.filter((o: any) => o.type === "varsel" && o.varsel.tittel === "A-meldingen er mottatt")).toHaveLength(1);
    config.ameldingInnsending = false;
  });

  it("utvidelsen av tilgangen i Altinn med tilgangspakkene systemet trenger nå", async () => {
    await somSystem((db) => db.query("update faktura.skattekort_tilgang set pakker = '{urn:altinn:accesspackage:lonn}' where org_id = $1", [org]));
    config.ameldingInnsending = true;
    expect((await api("GET", `/api/org/${org}/skattekort`)).data.tilgang).toMatchObject({ status: "godkjent", mangler: ["A-ordningen"], pakkenavn: ["Lønn"] });
    expect((await api("POST", `/api/org/${org}/skattekort/utvid`)).status).toBe(200);
    await kjor("altinn-endring");
    const endring = kall.find((k) => k.url.endsWith("/systemuser/changerequest/vendor"))!;
    expect(endring.kropp).toMatchObject({ partyOrgNo: "915000177", requiredAccessPackages: [{ urn: "urn:altinn:accesspackage:a-ordning" }] });
    expect((await api("GET", `/api/org/${org}/skattekort`)).data.tilgang).toMatchObject({ endring_status: "ny", endring_url: "https://altinn.test/godkjenn/endring" });
    // Brukeren kommer tilbake fra Altinn: endringen sjekkes, og pakken er med.
    expect((await api("POST", `/api/org/${org}/skattekort/sjekk`)).data).toMatchObject({ sjekkes: true });
    await kjor("altinn-endring");
    expect((await api("GET", `/api/org/${org}/skattekort`)).data.tilgang).toMatchObject({ endring_status: "godkjent", mangler: [], pakkenavn: ["Lønn", "A-ordningen"] });
    config.ameldingInnsending = false;
  });
});
