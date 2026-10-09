// Sykepenger og NAV (0079_nav_sykepenger.sql, navSykepenger.ts, navInntektsmelding.ts): tolkingen
// av sykmeldinger og forespørsler, arbeidsgiverperioden, inntektsmeldingen (skjemaet, kontrollen
// mot forespørselen og meldingen til NAV), lønnen under sykdom etter arbeidsgiverperioden, og hele
// flyten mot NAV (simulert): sykmeldingen blir fravær, forespørselen gir et forslag, og
// inntektsmeldingen sendes, godkjennes eller avvises.
import { generateKeyPairSync } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { lagApi } from "../src/api.js";
import { somSystem } from "../src/db.js";
import { settKryptering } from "../src/kryptering.js";
import { settLokalOppgavekjorer, type Oppgave } from "../src/tjenester.js";
import { settEtatFetch } from "../src/maskinporten.js";
import { NAV_SYKEPENGER } from "../src/altinn.js";
import { tolkForespoersel, tolkSykmelding } from "../src/navSykepenger.js";
import { antallDager, arbeidsgiverperioden, fritekst, inntektsmaaneder, inntektsmeldingSkjema, kontrollerMotForespoersel, tilNav, type Inntektsmelding } from "../src/navInntektsmelding.js";
import { beregnetRefusjon, refusjonPaaDag } from "../src/sykepengerRapporter.js";
import { sykelinjer, type Ansatt } from "../src/lonnsberegning.js";
import { kjorOppgave } from "../src/worker.js";

const IM: Inntektsmelding = {
  agp: { perioder: [{ fom: "2026-09-01", tom: "2026-09-16" }], redusertLoennIAgp: null },
  inntekt: { beloep: 50000, inntektsdato: "2026-09-01", endringAarsaker: [] },
  refusjon: { beloepPerMaaned: 50000, endringer: [] },
  naturalytelser: [],
  kontaktinformasjon: "Kari Nordmann",
  arbeidsgiverTlf: "22225555",
};
const feilene = (x: unknown) => {
  const r = inntektsmeldingSkjema.safeParse(x);
  return r.success ? [] : r.error.issues.map((i) => i.message);
};

describe("sykepenger fra NAV (uten database)", () => {
  it("tolker sykmeldingen: hel, gradert, avventende og behandlingsdager, egenmeldingsdagene og fødselsnummeret", () => {
    const s = tolkSykmelding({
      loepenr: 7,
      sykmeldingId: "sm-1",
      mottattAvNav: "2026-09-04T10:00:00",
      sendtTilArbeidsgiver: "2026-09-04T12:00:00",
      sykmeldt: { fnr: "138301 97340", navn: "Ola Syk" },
      egenmeldingsdager: [{ fom: "2026-09-01", tom: "2026-09-03" }],
      sykefravaerFom: "2026-09-01",
      sykmeldingPerioder: [
        { fom: "2026-09-18", tom: "2026-09-30", aktivitet: { gradertSykmelding: { sykmeldingsgrad: 50, harReisetilskudd: false } } },
        { fom: "2026-09-04", tom: "2026-09-17", aktivitet: { aktivitetIkkeMulig: { manglendeTilretteleggingPaaArbeidsplassen: false } } },
        { fom: "2026-10-01", tom: "2026-10-05", aktivitet: { avventendeSykmelding: "Kan jobbe med tilrettelegging" } },
        { fom: "2026-10-06", tom: "2026-10-10", aktivitet: { antallBehandlingsdagerUke: 1 } },
      ],
      oppfoelging: { meldingTilArbeidsgiver: " Trenger rolig plass ", tiltakArbeidsplassen: null },
      behandler: { navn: "Lege Legesen", tlf: "11223344" },
    })!;
    expect(s).toMatchObject({ loepenr: 7, sykmeldingId: "sm-1", fnr: "13830197340", navn: "Ola Syk", sykefravaerFom: "2026-09-01", meldingTilArbeidsgiver: "Trenger rolig plass", behandler: "Lege Legesen, 11223344" });
    expect(s.perioder.map((p) => [p.fom, p.type, p.grad])).toEqual([
      ["2026-09-04", "full", 100],
      ["2026-09-18", "gradert", 50],
      ["2026-10-01", "avventende", 0],
      ["2026-10-06", "behandlingsdager", 0],
    ]);
    expect(s.egenmeldingsdager).toEqual([{ fom: "2026-09-01", tom: "2026-09-03" }]);
    expect(tolkSykmelding({})).toBeNull();
  });

  it("tolker forespørselen: periodene, inntektsdatoen og det NAV ber om (påkrevd når flaggene mangler)", () => {
    const f = tolkForespoersel({
      loepenr: 5,
      navReferanseId: "ref-1",
      orgnr: "915000177",
      fnr: "13830197340",
      status: "AKTIV",
      sykmeldingsperioder: [{ fom: "2026-09-04", tom: "2026-09-30" }],
      egenmeldingsperioder: [{ fom: "2026-09-01", tom: "2026-09-03" }],
      inntektsdato: "2026-09-01",
      arbeidsgiverperiodePaakrevd: true,
      inntektPaakrevd: false,
      opprettetTid: "2026-10-01T08:00:00",
    })!;
    expect(f).toMatchObject({ loepenr: 5, navReferanseId: "ref-1", fnr: "13830197340", status: "AKTIV" });
    expect(f.data).toEqual({
      sykmeldingsperioder: [{ fom: "2026-09-04", tom: "2026-09-30" }],
      egenmeldingsperioder: [{ fom: "2026-09-01", tom: "2026-09-03" }],
      inntektsdato: "2026-09-01",
      arbeidsgiverperiodePaakrevd: true,
      inntektPaakrevd: false,
      opprettetTid: "2026-10-01T08:00:00",
    });
    expect(tolkForespoersel({ navReferanseId: "ref-2", status: "RAR" })!.data).toMatchObject({ arbeidsgiverperiodePaakrevd: true, inntektPaakrevd: true });
    expect(tolkForespoersel({ navReferanseId: "ref-3", status: "FORKASTET" })!.status).toBe("FORKASTET");
    expect(tolkForespoersel({})).toBeNull();
  });

  it("arbeidsgiverperioden: de første 16 dagene i sykefraværstilfellet, og et nytt tilfelle etter mer enn 16 dager", () => {
    expect(arbeidsgiverperioden([{ fom: "2026-09-04", tom: "2026-09-30" }, { fom: "2026-09-01", tom: "2026-09-03" }])).toEqual([{ fom: "2026-09-01", tom: "2026-09-16" }]);
    // Opphold på 4 dager: samme tilfelle, dagene telles videre.
    expect(arbeidsgiverperioden([{ fom: "2026-09-01", tom: "2026-09-05" }, { fom: "2026-09-10", tom: "2026-09-30" }])).toEqual([
      { fom: "2026-09-01", tom: "2026-09-05" },
      { fom: "2026-09-10", tom: "2026-09-20" },
    ]);
    // Mer enn 16 dager mellom: et nytt tilfelle.
    expect(arbeidsgiverperioden([{ fom: "2026-08-01", tom: "2026-08-05" }, { fom: "2026-09-01", tom: "2026-09-30" }])).toEqual([{ fom: "2026-09-01", tom: "2026-09-16" }]);
    // Overlappende perioder telles én gang.
    expect(antallDager(arbeidsgiverperioden([{ fom: "2026-09-01", tom: "2026-09-10" }, { fom: "2026-09-05", tom: "2026-09-12" }]))).toBe(12);
    expect(inntektsmaaneder("2026-09-14")).toEqual(["2026-06", "2026-07", "2026-08"]);
    expect(inntektsmaaneder("2026-01-01")).toEqual(["2025-10", "2025-11", "2025-12"]);
  });

  it("skjemaet følger NAVs regler: 16 dager, refusjon ikke over inntekten, endringer etter perioden, telefon og navn", () => {
    expect(feilene(IM)).toEqual([]);
    expect(inntektsmeldingSkjema.parse({ ...IM, arbeidsgiverTlf: "22 22 55 55" }).arbeidsgiverTlf).toBe("22225555");
    expect(feilene({ ...IM, agp: { perioder: [{ fom: "2026-09-01", tom: "2026-09-17" }], redusertLoennIAgp: null } })).toEqual(["Arbeidsgiverperioden er høyst 16 dager (nå 17)."]);
    expect(feilene({ ...IM, agp: { perioder: [{ fom: "2026-09-01", tom: "2026-09-10" }], redusertLoennIAgp: null } })[0]).toContain("kortere enn 16 dager");
    expect(feilene({ ...IM, agp: { perioder: [{ fom: "2026-09-01", tom: "2026-09-10" }], redusertLoennIAgp: { beloep: 0, begrunnelse: "ManglerOpptjening" } } })).toEqual([]);
    expect(feilene({ ...IM, agp: { perioder: [{ fom: "2026-09-01", tom: "2026-09-10" }], redusertLoennIAgp: { beloep: 0, begrunnelse: "Tull" } } })).toEqual(["Velg begrunnelsen"]);
    expect(feilene({ ...IM, refusjon: { beloepPerMaaned: 60000, endringer: [] } })).toEqual(["Refusjonen kan ikke være større enn månedsinntekten."]);
    expect(feilene({ ...IM, refusjon: { beloepPerMaaned: 50000, endringer: [{ beloep: 0, startdato: "2026-09-10" }] } })).toEqual([
      "Endringene i refusjonen må gjelde fra etter arbeidsgiverperioden.",
    ]);
    expect(feilene({ ...IM, refusjon: { beloepPerMaaned: 50000, endringer: [{ beloep: 0, startdato: "2026-11-01" }] } })).toEqual([]);
    expect(feilene({ ...IM, arbeidsgiverTlf: "123" })).toEqual(["Telefonnummeret må ha 8 til 15 sifre (eller starte med + eller 00)"]);
    expect(feilene({ ...IM, kontaktinformasjon: "kari@firma.no" })[0]).toContain("Navnet på kontaktpersonen");
    expect(feilene({ ...IM, inntekt: { ...IM.inntekt!, beloep: 1_000_000 } })).toEqual(["Beløpet må være under 1 000 000 kr"]);
    const ferie = { aarsak: "Ferie", ferier: [{ fom: "2026-07-06", tom: "2026-07-24" }] };
    expect(feilene({ ...IM, inntekt: { ...IM.inntekt!, endringAarsaker: [ferie, { aarsak: "VarigLoennsendring", gjelderFra: "2026-08-01" }, { aarsak: "Bonus" }] } })).toEqual([]);
    expect(feilene({ ...IM, inntekt: { ...IM.inntekt!, endringAarsaker: [ferie, ferie] } })).toEqual(["Den samme endringsårsaken står to ganger."]);
    expect(feilene({ ...IM, inntekt: { ...IM.inntekt!, endringAarsaker: [{ aarsak: "VarigLoennsendring" }] } }).length).toBe(1);
    expect(feilene({ ...IM, naturalytelser: [{ naturalytelse: "BIL", verdiBeloep: 0, sluttdato: "2026-09-17" }] })).toEqual(["Verdien må være over 0"]);
  });

  it("kontrollen mot forespørselen, og meldingen til NAV med alle nøklene og ingen andre", () => {
    expect(kontrollerMotForespoersel(IM, { arbeidsgiverperiodePaakrevd: true, inntektPaakrevd: true })).toEqual([]);
    expect(kontrollerMotForespoersel({ ...IM, agp: null }, { arbeidsgiverperiodePaakrevd: true })).toEqual(["NAV ber om arbeidsgiverperioden."]);
    expect(kontrollerMotForespoersel({ ...IM, inntekt: null }, { inntektPaakrevd: true })).toEqual(["NAV ber om inntekten."]);
    expect(kontrollerMotForespoersel(IM, { inntektPaakrevd: false })[0]).toContain("ber ikke om inntekten");
    const m = tilNav({ ...IM, inntekt: null, refusjon: null }, "ref-1", "13830197340", "Ny", { systemNavn: "HI4 Faktura", systemVersjon: "1.0" });
    expect(Object.keys(m).sort()).toEqual(
      ["agp", "aarsakInnsending", "arbeidsgiverTlf", "avsender", "inntekt", "kontaktinformasjon", "navReferanseId", "naturalytelser", "refusjon", "sykmeldtFnr"].sort(),
    );
    expect(m).toMatchObject({ inntekt: null, refusjon: null, naturalytelser: [], sykmeldtFnr: "13830197340", aarsakInnsending: "Ny" });
    expect(Object.keys(m.agp!)).toEqual(["perioder", "redusertLoennIAgp"]);
    expect(fritekst("Åse Ærlig-Øst — José O'Neil")).toBe("Åse Ærlig-Øst Jose O Neil");
    expect(fritekst("@")).toBeNull();
  });

  it("lønnen etter arbeidsgiverperioden: forskuttert med timelønn, trekk i fastlønnen når NAV betaler, og gradert", () => {
    const a = (x: Partial<Ansatt>): Ansatt =>
      ({ id: "a", ansattnummer: 1, navn: "A", ansatt_fra: "2025-01-01", ansatt_til: null, lonnstype: "time", maanedslonn: null, timelonn: 300, stillingsprosent: 100, ukentlig_arbeidstid: 37.5, ...x }) as Ansatt;
    const dager = ["2026-09-17", "2026-09-18", "2026-09-21"].map((dato) => ({ dato, timer: 7.5, type: "syk" as const, grad: 50 }));
    const etter = (refusjon: boolean) => ({ dager: new Set(dager.map((d) => d.dato)), refusjon, fra: "2026-09-01", til: "2026-09-30" });
    expect(sykelinjer(a({}), dager, new Set(), 0, etter(true)).linjer).toEqual([
      { lonnsart: "sykepenger_nav", tekst: "Sykepenger etter arbeidsgiverperioden (3 dager, gradert; refusjon fra NAV)", antall: 11.25, sats: 300, belop: 3375, nokkel: "sykepenger_nav" },
    ]);
    expect(sykelinjer(a({}), dager, new Set(), 0, etter(false)).linjer).toEqual([]);
    // Fastlønn: lønnen går som vanlig når arbeidsgiveren forskutterer; ellers trekkes den sykmeldte
    // delen av virkedagene (22 virkedager i september 2026).
    const fast = a({ lonnstype: "maaned", maanedslonn: 44000, timelonn: null });
    expect(sykelinjer(fast, dager, new Set(), 0, etter(true)).linjer).toEqual([]);
    expect(sykelinjer(fast, dager, new Set(), 0, etter(false)).linjer).toEqual([
      {
        lonnsart: "trekk_sykdom",
        tekst: "Trekk for sykdom etter arbeidsgiverperioden (3 virkedager, gradert; NAV betaler sykepengene)",
        antall: 0.0682,
        sats: 44000,
        belop: -3000,
        nokkel: "trekk_sykdom",
      },
    ]);
  });

  it("refusjonen: beløpet på en dag (med endringer og stopp), og beregnet for virkedagene, høyst 6 G", () => {
    const r = { beloepPerMaaned: 52000, endringer: [{ beloep: 0, startdato: "2026-10-01" }, { beloep: 30000, startdato: "2026-09-21" }] };
    expect(refusjonPaaDag(r, "2026-09-20")).toBe(52000);
    expect(refusjonPaaDag(r, "2026-09-21")).toBe(30000);
    expect(refusjonPaaDag(r, "2026-10-01")).toBe(0);
    expect(refusjonPaaDag(null, "2026-10-01")).toBe(0);
    // 17. og 18. september (torsdag og fredag), 19. og 20. er helg: 2 dager à 52 000 * 12 / 260.
    expect(beregnetRefusjon(r, ["2026-09-17", "2026-09-18", "2026-09-19", "2026-09-20"].map((dato) => ({ dato, grad: 100 })))).toBe(4800);
    // Over 6 G (136 549 * 6 / 12 = 68 274,50 i måneden): dagsatsen av 6 G.
    expect(beregnetRefusjon({ beloepPerMaaned: 90000, endringer: [] }, [{ dato: "2026-09-17", grad: 50 }])).toBe(1575.57);
  });
});

describe.skipIf(!process.env.DATABASE_URL)("sykepenger fra NAV i appen", () => {
  const app = lagApi();
  const eier = "Bearer test:uid-nav-eier:nav-eier@server.test:mfa";
  const regnskap = "Bearer test:uid-nav-regn:nav-regn@server.test:mfa";
  const ko: Oppgave[] = [];
  const innsendinger: any[] = [];
  const kall: { metode: string; sti: string; kropp: any }[] = [];
  let org: string;
  let ola: string;
  let foresporsel: string;
  let navStatus: "AKTIV" | "BESVART" | "FORKASTET" = "AKTIV";

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
  const FORESPOERSEL = {
    loepenr: 5,
    navReferanseId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    orgnr: "915000177",
    fnr: "13830197340",
    sykmeldingsperioder: [{ fom: "2026-09-04", tom: "2026-09-30" }],
    egenmeldingsperioder: [{ fom: "2026-09-01", tom: "2026-09-03" }],
    inntektsdato: "2026-09-01",
    arbeidsgiverperiodePaakrevd: true,
    inntektPaakrevd: true,
    opprettetTid: "2026-10-01T08:00:00",
  };

  beforeAll(async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
    Object.assign(config, {
      maskinportenKlientId: "klient-1",
      maskinportenNokkelId: "kid-1",
      maskinportenNokkel: privateKey,
      maskinportenUrl: "https://mp.test",
      navUrl: "https://nav.test",
      navSykepenger: false,
    });
    settKryptering(async (t) => Buffer.from(`kryptert:${t}`), async (d) => d.toString().replace(/^kryptert:/, ""));
    settLokalOppgavekjorer(async (o) => void ko.push(o));
    settEtatFetch(async (url, init) => {
      const u = new URL(String(url));
      const tekst = init?.body ? String(init.body) : null;
      const kropp = tekst && tekst.startsWith("{") ? JSON.parse(tekst) : tekst;
      if (u.host === "mp.test") return json(200, { access_token: "tok", expires_in: 120 });
      const metode = init?.method ?? "GET";
      kall.push({ metode, sti: `${u.pathname}${u.search}`, kropp });
      if (u.host !== "nav.test") throw new Error(`Uventet kall: ${metode} ${u.href}`);
      if (metode === "POST" && u.pathname === "/v1/sykmeldinger")
        return json(
          200,
          (kropp.fraLoepenr ?? 0) >= 1
            ? []
            : [
                {
                  loepenr: 1,
                  sykmeldingId: "sm-1",
                  sykmeldt: { fnr: "13830197340", navn: "Ola Sykmeldt" },
                  egenmeldingsdager: [{ fom: "2026-09-01", tom: "2026-09-03" }],
                  sykefravaerFom: "2026-09-01",
                  sykmeldingPerioder: [{ fom: "2026-09-04", tom: "2026-09-30", aktivitet: { gradertSykmelding: { sykmeldingsgrad: 50, harReisetilskudd: false } } }],
                  oppfoelging: { meldingTilArbeidsgiver: "Kan jobbe halv dag" },
                },
              ],
        );
      if (metode === "POST" && u.pathname === "/v1/forespoersler") {
        if (kropp.status === "AKTIV") return json(200, navStatus === "AKTIV" ? [FORESPOERSEL] : []);
        return json(200, (kropp.fraLoepenr ?? 0) >= 5 ? [] : [{ ...FORESPOERSEL, status: navStatus }]);
      }
      if (u.pathname === "/v1/inntekt")
        return json(200, { inntektPerMaaned: { "2026-06": 50000, "2026-07": 50000, "2026-08": 50000 }, gjennomsnittAvMaaneder: 50000 });
      if (u.pathname === `/v1/forespoersel/${FORESPOERSEL.navReferanseId}`) return json(200, { ...FORESPOERSEL, status: navStatus });
      if (metode === "POST" && u.pathname === "/v1/inntektsmelding") {
        innsendinger.push(kropp);
        return json(201, { innsendingId: `inn-${innsendinger.length}` });
      }
      if (u.pathname === "/v1/inntektsmelding/inn-1") return json(200, { id: "inn-1", status: "GODKJENT" });
      if (u.pathname === "/v1/inntektsmelding/inn-2") return json(200, { id: "inn-2", status: "FEILET", valideringsfeil: { feilkode: "INNTEKT_AVVIKER_FRA_A_ORDNINGEN" } });
      throw new Error(`Uventet kall: ${metode} ${u.pathname}`);
    });

    org = (await api("POST", "/api/organisasjoner", { navn: "Sykepenger Test AS", orgnr: "915000258" })).data.id;
    expect((await api("PUT", `/api/org/${org}/lonn-oppsett`, { aktiv: true, virksomhet_orgnr: "915000177" })).status).toBe(200);
    const r = await api("POST", `/api/org/${org}/ansatte`, {
      fornavn: "Ola",
      etternavn: "Sykmeldt",
      fnr: "13830197340",
      ansatt_fra: "2025-01-01",
      lonnstype: "maaned",
      maanedslonn: 50000,
      skattekort: "prosent",
      skatt_prosent: 30,
    });
    expect(r.status, JSON.stringify(r.data)).toBe(201);
    ola = r.data.id;
    // Lønnen de tre månedene før inntektsdatoen.
    for (const periode of ["2026-06", "2026-07", "2026-08"]) {
      const k = (await api("POST", `/api/org/${org}/lonn/kjoringer`, { periode })).data;
      expect((await api("POST", `/api/org/${org}/lonn/kjoringer/${k.id}/godkjenn`)).status).toBe(200);
    }
    const inv = await api("POST", `/api/org/${org}/invitasjoner`, { epost: "nav-regn@server.test", rolle: "regnskap" });
    expect((await api("POST", "/api/invitasjoner/aksepter", { token: inv.data.lenke.split("/").pop() }, regnskap)).status).toBe(200);
  });

  it("hentingen: av til den er slått på og tilgangen gitt, så blir sykmeldingen gradert fravær med egenmeldingen", async () => {
    expect((await api("GET", `/api/org/${org}/nav`)).data).toMatchObject({ pa: false, tilgang: false, refusjon: true, virksomhet: "915000177" });
    expect((await api("POST", `/api/org/${org}/nav/hent`)).data.error).toContain("ikke slått på");
    config.navSykepenger = true;
    expect((await api("POST", `/api/org/${org}/nav/hent`)).data.error).toContain("Gi tilgang hos NAV i Altinn");
    await somSystem((db) => db.query("insert into faktura.skattekort_tilgang (org_id, status, pakker) values ($1, 'godkjent', $2)", [org, ["urn:altinn:accesspackage:lonn", NAV_SYKEPENGER]]));
    expect((await api("POST", `/api/org/${org}/nav/hent`)).status).toBe(200);
    await kjor("nav-hent");
    const s = (await api("GET", `/api/org/${org}/nav/sykmeldinger`)).data;
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ ansatt_id: ola, navn: "Ola Sykmeldt", melding_til_arbeidsgiver: "Kan jobbe halv dag", fravaer: 2, merknader: [] });
    const f = (await api("GET", `/api/org/${org}/fravaer?fra=2026-09-01&til=2026-09-30`)).data;
    expect(f.map((x: any) => [x.fra, x.til, x.dokumentasjon, x.sykmeldingsgrad, x.fra_nav])).toEqual([
      ["2026-09-01", "2026-09-03", "egenmelding", null, true],
      ["2026-09-04", "2026-09-30", "sykmelding", 50, true],
    ]);
    expect(ko.filter((o: any) => o.type === "varsel" && o.varsel.tittel === "Ny sykmelding fra NAV")).toHaveLength(1);
    // Neste gang hentes det fra siste løpenummer: ingen nye.
    expect((await api("POST", `/api/org/${org}/nav/hent`)).status).toBe(200);
    await kjor("nav-hent");
    expect(kall.filter((k) => k.sti === "/v1/sykmeldinger").map((k) => k.kropp)).toEqual([{ orgnr: "915000177" }, { orgnr: "915000177", fraLoepenr: 1 }]);
    expect((await api("GET", `/api/org/${org}/nav/sykmeldinger`)).data).toHaveLength(1);
    // Regnskap ser ikke sykmeldingene eller statusen.
    expect((await api("GET", `/api/org/${org}/nav`, undefined, regnskap)).status).toBe(403);
  });

  it("forespørselen: hentet med inntekten i a-ordningen, og forslaget til inntektsmelding", async () => {
    const l = (await api("GET", `/api/org/${org}/nav/forespoersler`)).data;
    expect(l).toHaveLength(1);
    expect(l[0]).toMatchObject({ ansatt_id: ola, status: "AKTIV", inntektsmelding: null });
    foresporsel = l[0].id;
    expect(ko.filter((o: any) => o.type === "varsel" && o.varsel.tittel === "NAV ber om inntektsmelding")).toHaveLength(1);
    const d = (await api("GET", `/api/org/${org}/nav/forespoersler/${foresporsel}`)).data;
    expect(d.data.inntekt).toEqual({ inntektsdato: "2026-09-01", perMaaned: { "2026-06": 50000, "2026-07": 50000, "2026-08": 50000 }, snitt: 50000 });
    expect(d.forslag.aarsak).toBe("Ny");
    expect(d.forslag.innhold).toEqual({
      agp: { perioder: [{ fom: "2026-09-01", tom: "2026-09-16" }], redusertLoennIAgp: null },
      inntekt: { beloep: 50000, inntektsdato: "2026-09-01", endringAarsaker: [] },
      refusjon: { beloepPerMaaned: 50000, endringer: [] },
      naturalytelser: [],
      kontaktinformasjon: "nav-eier",
      arbeidsgiverTlf: "",
    });
    expect(d.forslag.grunnlag).toMatchObject({ agp_dager: 16, snitt_lonn: 50000, snitt_nav: 50000, maanedslonn: 50000, refusjon: true });
    expect(d.forslag.grunnlag.maaneder).toEqual([
      { maaned: "2026-06", lonn: 50000, nav: 50000 },
      { maaned: "2026-07", lonn: 50000, nav: 50000 },
      { maaned: "2026-08", lonn: 50000, nav: 50000 },
    ]);
    expect(Object.keys(d.koder)).toEqual(["begrunnelser", "naturalytelser", "endringsaarsaker"]);
  });

  it("inntektsmeldingen: kontrollert, sendt med fødselsnummeret fra workeren, og godkjent", async () => {
    const forslag = (await api("GET", `/api/org/${org}/nav/forespoersler/${foresporsel}`)).data.forslag.innhold;
    const sti = `/api/org/${org}/nav/forespoersler/${foresporsel}/inntektsmelding`;
    expect((await api("POST", sti, { ...forslag, arbeidsgiverTlf: "22 22 55 55", agp: null })).data.error).toBe("NAV ber om arbeidsgiverperioden.");
    expect((await api("POST", sti, { ...forslag, arbeidsgiverTlf: "22 22 55 55" }, regnskap)).status).toBe(403);
    const r = await api("POST", sti, { ...forslag, arbeidsgiverTlf: "22 22 55 55" });
    expect(r.status, JSON.stringify(r.data)).toBe(201);
    expect(r.data).toMatchObject({ status: "sender" });
    expect(r.data.innhold.arbeidsgiverTlf).toBe("22225555");
    // Mens den sendes, får forespørselen ikke en ny.
    expect((await api("POST", sti, { ...forslag, arbeidsgiverTlf: "22225555" })).status).toBe(409);
    await kjor("nav-inntektsmelding");
    expect(innsendinger).toHaveLength(1);
    expect(innsendinger[0]).toEqual({
      navReferanseId: FORESPOERSEL.navReferanseId,
      agp: { perioder: [{ fom: "2026-09-01", tom: "2026-09-16" }], redusertLoennIAgp: null },
      inntekt: { beloep: 50000, inntektsdato: "2026-09-01", endringAarsaker: [] },
      refusjon: { beloepPerMaaned: 50000, endringer: [] },
      naturalytelser: [],
      sykmeldtFnr: "13830197340",
      aarsakInnsending: "Ny",
      kontaktinformasjon: "nav-eier",
      arbeidsgiverTlf: "22225555",
      avsender: { systemNavn: "HI4 Faktura", systemVersjon: expect.any(String) },
    });
    let d = (await api("GET", `/api/org/${org}/nav/forespoersler/${foresporsel}`)).data;
    expect(d.inntektsmeldinger[0]).toMatchObject({ status: "sendt", innsending_id: "inn-1", feil: null });
    // Statusen hentes (om to minutter): godkjent, og forespørselen er besvart.
    navStatus = "BESVART";
    await kjor("nav-hent");
    d = (await api("GET", `/api/org/${org}/nav/forespoersler/${foresporsel}`)).data;
    expect(d.status).toBe("BESVART");
    expect(d.inntektsmeldinger[0]).toMatchObject({ status: "godkjent" });
    expect(ko.filter((o: any) => o.type === "varsel" && o.varsel.tittel === "NAV har godkjent inntektsmeldingen")).toHaveLength(1);
    // Neste forslag er en korrigering av det som ble godkjent.
    expect(d.forslag.aarsak).toBe("Endring");
    expect(d.forslag.innhold.arbeidsgiverTlf).toBe("22225555");
  });

  it("en korrigering som NAV avviser (inntekten avviker fra a-ordningen), og rapporten for sykepengene", async () => {
    const d = (await api("GET", `/api/org/${org}/nav/forespoersler/${foresporsel}`)).data;
    const r = await api("POST", `/api/org/${org}/nav/forespoersler/${foresporsel}/inntektsmelding`, {
      ...d.forslag.innhold,
      inntekt: { ...d.forslag.innhold.inntekt, beloep: 60000 },
    });
    expect(r.status, JSON.stringify(r.data)).toBe(201);
    await kjor("nav-inntektsmelding");
    expect(innsendinger[1]).toMatchObject({ aarsakInnsending: "Endring", inntekt: { beloep: 60000 } });
    await kjor("nav-hent");
    const m = (await api("GET", `/api/org/${org}/nav/forespoersler/${foresporsel}`)).data.inntektsmeldinger[0];
    expect(m).toMatchObject({ status: "avvist" });
    expect(m.feil).toContain("avviker mer enn 1 000 kr");
    // Rapporten: 30 dager syk i september (27 gradert), 16 i arbeidsgiverperioden, 14 etter; den
    // godkjente inntektsmeldingen gjelder (10 virkedager à 50 000 * 12 / 260, halvparten).
    const rap = (await api("GET", `/api/org/${org}/rapportmodul/lonn.sykepenger?fra=2026-09-01&til=2026-09-30`)).data;
    expect(rap.rader).toEqual([
      { ansattnummer: 1, navn: "Ola Sykmeldt", syk: 30, gradert: 27, agp: 16, nav: 14, refusjon_mnd: 50000, refusjon: 11538.46, inntektsmelding: expect.stringMatching(/^Godkjent \d{2}\.\d{2}\.\d{4}$/) },
    ]);
  });

  it("lønnen for september: fastlønnen går som vanlig (refusjon), og trekkes når NAV betaler", async () => {
    const k = (await api("POST", `/api/org/${org}/lonn/kjoringer`, { periode: "2026-09" })).data;
    const slipp = async () => (await api("GET", `/api/org/${org}/lonn/kjoringer/${k.id}`)).data.slipper[0];
    let s = await slipp();
    expect(s.linjer.map((l: any) => l.lonnsart)).toEqual(["fastlonn"]);
    expect(s.merknader.join(" ")).toContain("refusjonen kreves i inntektsmeldingen");
    expect((await api("PUT", `/api/org/${org}/lonn-oppsett`, { sykepenger_refusjon: false })).status).toBe(200);
    expect((await api("POST", `/api/org/${org}/lonn/kjoringer/${k.id}/beregn`)).status).toBe(200);
    s = await slipp();
    const trekk = s.linjer.find((l: any) => l.lonnsart === "trekk_sykdom");
    // 10 virkedager etter arbeidsgiverperioden i september, halvparten syk: 5 av 22 virkedager.
    expect(trekk).toMatchObject({ belop: -11363.64, sats: 50000 });
    expect(s.merknader.join(" ")).toContain("NAV betaler sykepengene til den ansatte");
    expect((await api("PUT", `/api/org/${org}/lonn-oppsett`, { sykepenger_refusjon: true })).status).toBe(200);
  });
});
