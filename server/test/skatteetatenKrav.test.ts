// Krav, betalinger og frister fra Skatteetaten (0112_skatteetaten_krav.sql, skatteetatenKrav.ts,
// skatteetatenRuter.ts, skatteetatenRapporter.ts): tolkingen av svarene (som eksemplene i
// Skatteetatens dokumentasjon), tilgangspakken, og hele flyten mot Skatteetaten (simulert): av til
// funksjonen er slått på og tilgangen gitt, hentingen med hvert sitt token, tomme svar, feilene,
// «Hent nå» og rapportene.
import { generateKeyPairSync } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { lagApi } from "../src/api.js";
import { somSystem } from "../src/db.js";
import { settLokalOppgavekjorer, type Oppgave } from "../src/tjenester.js";
import { settEtatFetch } from "../src/maskinporten.js";
import { KRAV_OG_UTLEGG, PAKKENAVN, systemdefinisjon, TILGANGSPAKKE, tilgangspakker } from "../src/altinn.js";
import { hentKravOgFrister, nesteForfall, planleggKravOgFrister, tolkFrister, tolkKravoversikt, tolkUtbetaling } from "../src/skatteetatenKrav.js";
import { kjorOppgave } from "../src/worker.js";

const ORGNR = "915000304";

// Åpne krav: restskatt med ett forfall som er passert (delvis betalt, med KID og konto), og mva med
// et forfall framover; og en innbetaling som ikke er plassert.
const AAPNE = {
  partIdentifikator: ORGNR,
  skjermet: false,
  aapentKravMedGjenstaaendeBeloep: [
    {
      partIdentifikator: ORGNR,
      kravidentifikator: "krav-2",
      kravtype: "MERVERDIAVGIFT",
      opprinneligBeloep: 25000,
      gjenstaaendeBeloep: 25000,
      kravforfall: [
        {
          kravforfallsIdentifikator: "ff-2",
          forfallsdato: "2099-12-10",
          opprinneligBeloep: 25000,
          gjenstaaendeBeloep: 25000,
          betalingsinformasjon: { konto: { kontonummer: "76940500000" } },
        },
      ],
      kravperiode: { periodeBeskrivelse: { spraakTekst: [{ tekst: "5. termin", spraak: "nb" }] }, aar: "2026" },
      kravgruppe: "Merverdiavgift",
    },
    {
      partIdentifikator: ORGNR,
      kravidentifikator: "krav-1",
      kravtype: "RESTSKATT",
      opprinneligBeloep: 10000.0,
      gjenstaaendeBeloep: 9000.0,
      kravforfall: [
        {
          kravforfallsIdentifikator: "ff-1",
          forfallsdato: "2026-02-21",
          opprinneligBeloep: 10000.0,
          gjenstaaendeBeloep: 9000.0,
          betalingsinformasjon: {
            kidnummer: "1234 5678 90",
            konto: { bankinformasjon: "Nordea Bank Norge ASA, Postboks 1166 Sentrum, 0107 Oslo, Norge", kontonummer: "6345.06.24804", iban: "NO42 6345 06 24804", swiftBIC: "NDEANOKK" },
          },
          plassertInnbetaling: [{ innbetalingsIdentifikator: "inn-12345", plassertBeloep: -1000.0, plassertDato: "2026-02-05" }],
          plassertMotkrav: [],
        },
      ],
      stipulerteRenter: 200.0,
      kravbeskrivelse: { spraakTekst: [{ tekst: "Restskatt (nn)", spraak: "nn" }, { tekst: "Restskatt", spraak: "nb" }] },
      kravperiode: { periodeBeskrivelse: { spraakTekst: [{ tekst: "2026/02", spraak: "nb" }] } },
      opprettelsesdatoForKrav: "2026-01-30",
      kravgruppe: "Skatt",
      fastsettingsmaate: "blank",
    },
  ],
  innbetalingMedUplassertBeloep: [
    {
      partIdentifikator: ORGNR,
      innbetalingsidentifikator: "inn-9",
      innbetalingsdato: "2026-10-01",
      innbetaltBeloep: 1000.0,
      uplassertBeloep: 500.0,
      mottakersKontonummer: { kontonummer: "98766543210" },
      innbetaltFra: { konto: { kontoeiersNavn: "SKATT TEST AS", kontonummer: "******43210" } },
      innbetalingstype: "bankoverføring",
    },
  ],
};
const INNBETALINGER = {
  partIdentifikator: ORGNR,
  periode: { fraOgMed: "2025-10-16", tilOgMed: "2026-10-15" },
  skjermet: false,
  innbetaling: [
    {
      partIdentifikator: ORGNR,
      innbetalingsidentifikator: "inn-1",
      innbetalingsdato: "2026-02-05",
      innbetaltBeloep: 1000.0,
      uplassertBeloep: 0.0,
      innbetaltFra: { konto: { kontoeiersNavn: "SKATT TEST AS", kontonummer: "******43210" } },
      innbetalingstype: "bankoverføring",
    },
    AAPNE.innbetalingMedUplassertBeloep[0],
  ],
};
const UTBETALING = {
  partIdentifikator: ORGNR,
  utbetalingsidentifikator: "147654",
  utbetaltdato: "2026-08-21",
  utbetaltBeloep: 62374.0,
  betaltTil: { meldingSendtTilMottaker: "Tilgode skatt 2025", konto: { kontoeiersNavn: "SKATT TEST AS", kontonummer: "627xxxxxx" }, valutakode: "NOK" },
  grunnlagForUtbetaling: { kreditKrav: [{ kravforfallidentifikator: "6412123", opprinneligBeloep: -62374.0, gjenstaaendeBeloep: 0.0, utbetaltBeloep: 62374.0 }] },
  utbetalingstatus: "bekreftet",
};
const FRISTER = {
  kilder: [
    {
      frister: [
        { tittel: "Husk å levere skattemeldingen for selskap.", aktivitetsbeskrivelse: "Det er mulig å søke utsatt frist.", aktivitetstype: "rapporteringskrav", frist: "2099-05-31" },
        { tittel: "Mva-melding for 5. termin", aktivitetsbeskrivelse: "Mva-meldingen skal leveres.", aktivitetstype: "rapporteringskrav", frist: "2099-12-10" },
      ],
      kilde: "skatt",
      status: "OK",
    },
    { frister: [], kilde: "mva", status: "FEIL" },
  ],
  virksomhet: ORGNR,
};

describe("krav og frister fra Skatteetaten (uten database)", () => {
  it("tolker de åpne kravene: forfall, konto og KID, bokmål, perioden, og summene regnet ut", () => {
    const k = tolkKravoversikt(AAPNE, INNBETALINGER, { utbetaling: [UTBETALING] }, { fra: "2025-10-16", til: "2026-10-15" }, "2026-10-15");
    // De som forfaller først, øverst.
    expect(k.aapne.map((x) => x.id)).toEqual(["krav-1", "krav-2"]);
    expect(k.aapne[0]).toEqual({
      id: "krav-1",
      type: "RESTSKATT",
      beskrivelse: "Restskatt",
      periode: "2026/02",
      gruppe: "Skatt",
      opprinnelig: 10000,
      gjenstaaende: 9000,
      renter: 200,
      opprettet: "2026-01-30",
      forfall: [
        {
          id: "ff-1",
          dato: "2026-02-21",
          opprinnelig: 10000,
          gjenstaaende: 9000,
          kontonummer: "63450624804",
          kid: "1234567890",
          iban: "NO4263450624804",
          bic: "NDEANOKK",
          bank: "Nordea Bank Norge ASA, Postboks 1166 Sentrum, 0107 Oslo, Norge",
        },
      ],
    });
    // Uten beskrivelse: kravtypen; perioden med året.
    expect(k.aapne[1]).toMatchObject({ beskrivelse: "Merverdiavgift", periode: "5. termin 2026", renter: 0, opprettet: null });
    expect(nesteForfall(k.aapne[1]!)?.id).toBe("ff-2");
    // Forfalt: restskatten (forfall før i dag); ikke forfalt: mva-en; saldoen uten det som ikke er plassert.
    expect(k.summer).toEqual({ saldo: 33500, forfalt: 9000, ikke_forfalt: 25000, renter: 200, uplassert: 500 });
    expect(k.grupper).toEqual([
      { gruppe: "Merverdiavgift", saldo: 25000, forfalt: 0, ikke_forfalt: 25000, renter: 0 },
      { gruppe: "Skatt", saldo: 9000, forfalt: 9000, ikke_forfalt: 0, renter: 200 },
    ]);
    expect(k.uplasserte).toEqual([{ id: "inn-9", dato: "2026-10-01", belop: 1000, uplassert: 500, type: "bankoverføring", fra: "SKATT TEST AS (******43210)" }]);
    // Betalingene, de siste først.
    expect(k.innbetalinger.map((x) => x.id)).toEqual(["inn-9", "inn-1"]);
    expect(k.utbetalinger).toEqual([{ id: "147654", dato: "2026-08-21", belop: 62374, melding: "Tilgode skatt 2025", status: "bekreftet", konto: "627xxxxxx" }]);
    expect(k.periode).toEqual({ fra: "2025-10-16", til: "2026-10-15" });
    expect(k.skjermet).toBe(false);
  });

  it("bruker Skatteetatens summer når de er med, og tåler tomme svar", () => {
    const total = { saldo: 1, sumForfalteKrav: 2, sumIkkeForfalteKrav: 3, sumStipulerteRenter: 4, sumUplasserteInnbetalinger: 5 };
    const grupper = [{ kravgruppe: "Skatt", saldo: 1, sumForfalteKrav: 2, sumIkkeForfalteKrav: 3, sumStipulerteRenter: 4 }];
    const k = tolkKravoversikt({ ...AAPNE, totalOversikt: total, oversiktPerKravgruppe: grupper }, null, null, { fra: "2025-10-16", til: "2026-10-15" }, "2026-10-15");
    expect(k.summer).toEqual({ saldo: 1, forfalt: 2, ikke_forfalt: 3, renter: 4, uplassert: 5 });
    expect(k.grupper).toEqual([{ gruppe: "Skatt", saldo: 1, forfalt: 2, ikke_forfalt: 3, renter: 4 }]);
    const tom = tolkKravoversikt(null, null, null, { fra: "2025-10-16", til: "2026-10-15" }, "2026-10-15");
    expect(tom).toMatchObject({ aapne: [], uplasserte: [], innbetalinger: [], utbetalinger: [], grupper: [] });
    expect(tom.summer).toEqual({ saldo: 0, forfalt: 0, ikke_forfalt: 0, renter: 0, uplassert: 0 });
    // Krav uten id hoppes over; beløp som tekst tolkes.
    expect(tolkKravoversikt({ aapentKravMedGjenstaaendeBeloep: [{ kravtype: "X" }, { kravidentifikator: "k", gjenstaaendeBeloep: "12,5" }] }, null, null, { fra: "a", til: "b" }, "2026-10-15").aapne).toMatchObject([
      { id: "k", gjenstaaende: 12.5, beskrivelse: "Krav", forfall: [] },
    ]);
    expect(tolkUtbetaling({})).toEqual({ id: null, dato: null, belop: 0, melding: null, status: null, konto: null });
  });

  it("tolker fristene: de første først, med kilden, og kildene som ikke svarte", () => {
    const f = tolkFrister({ ...FRISTER, kilder: [FRISTER.kilder[0]!, { ...FRISTER.kilder[1]!, frister: [{ tittel: "Uten dato" }] }] });
    expect(f.frister).toEqual([
      { tittel: "Husk å levere skattemeldingen for selskap.", beskrivelse: "Det er mulig å søke utsatt frist.", type: "rapporteringskrav", frist: "2099-05-31", kilde: "skatt" },
      { tittel: "Mva-melding for 5. termin", beskrivelse: "Mva-meldingen skal leveres.", type: "rapporteringskrav", frist: "2099-12-10", kilde: "skatt" },
    ]);
    expect(f.kilder).toEqual([
      { kilde: "skatt", status: "OK" },
      { kilde: "mva", status: "FEIL" },
    ]);
    expect(tolkFrister(null)).toEqual({ frister: [], kilder: [] });
    // De forfalte og de kommende sammen: en frist som står i begge, én gang, og en kilde som ikke
    // svarte i ett av dem, med den statusen.
    const forfalt = { tittel: "Mva-melding for 3. termin", aktivitetstype: "rapporteringskrav", frist: "2026-08-31" };
    const kommende = { tittel: "Mva-melding for 5. termin", aktivitetstype: "rapporteringskrav", frist: "2099-12-10" };
    const begge = tolkFrister(
      { kilder: [{ kilde: "merverdiavgift", status: "OK", frister: [forfalt] }], virksomhet: "915000355" },
      {
        kilder: [
          { kilde: "merverdiavgift", status: "Feilet", frister: [forfalt, kommende] },
          { kilde: "skatt", status: "OK", frister: [] },
        ],
      },
    );
    expect(begge.frister.map((x) => [x.frist, x.tittel, x.kilde])).toEqual([
      ["2026-08-31", "Mva-melding for 3. termin", "merverdiavgift"],
      ["2099-12-10", "Mva-melding for 5. termin", "merverdiavgift"],
    ]);
    expect(begge.kilder).toEqual([
      { kilde: "merverdiavgift", status: "Feilet" },
      { kilde: "skatt", status: "OK" },
    ]);
  });

  it("tilgangspakken «Krav, betalinger og utlegg» når hentingen er slått på", () => {
    const foer = config.kravOgFrister;
    config.kravOgFrister = false;
    expect(tilgangspakker()).not.toContain(KRAV_OG_UTLEGG);
    expect(systemdefinisjon().description.nb).not.toContain("fristene");
    config.kravOgFrister = true;
    expect(tilgangspakker()).toEqual(expect.arrayContaining([TILGANGSPAKKE, KRAV_OG_UTLEGG]));
    expect(KRAV_OG_UTLEGG).toBe("urn:altinn:accesspackage:krav-og-utlegg");
    expect(PAKKENAVN[KRAV_OG_UTLEGG]).toBe("Krav, betalinger og utlegg");
    expect(systemdefinisjon().accessPackages).toEqual(expect.arrayContaining([{ urn: KRAV_OG_UTLEGG }]));
    expect(systemdefinisjon().description.nb).toContain("Regnskapet viser kravene, betalingene og fristene hos Skatteetaten.");
    config.kravOgFrister = foer;
  });
});

describe.skipIf(!process.env.DATABASE_URL)("krav og frister fra Skatteetaten i appen", () => {
  const app = lagApi();
  const eier = "Bearer test:uid-skatt-eier:skatt-eier@server.test:mfa";
  const regnskap = "Bearer test:uid-skatt-regn:skatt-regn@server.test:mfa";
  const fakturerer = "Bearer test:uid-skatt-fakt:skatt-fakt@server.test:mfa";
  const ko: Oppgave[] = [];
  const kall: { vert: string; sti: string; token: string }[] = [];
  const tokener: { scope: string; kunde: string | null }[] = [];
  let org: string;

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
  // Svarene fra Skatteetaten etter stien (uten søkestrengen); kan byttes i testene.
  const STANDARD: Record<string, () => Response> = {
    [`/${ORGNR}/aapnekrav`]: () => json(200, { ...AAPNE, totalOversikt: { saldo: 33500, sumForfalteKrav: 9000, sumIkkeForfalteKrav: 25000, sumStipulerteRenter: 200, sumUplasserteInnbetalinger: 500 } }),
    [`/${ORGNR}/innbetalinger`]: () => json(200, INNBETALINGER),
    [`/${ORGNR}/utbetalinger`]: () => json(404, { kode: "KB-007", melding: "Fant ingen krav/betalinger på angitt identifikator og periode.", korrelasjonsid: "k-0" }),
    [`/${ORGNR}/forfalte`]: () => json(200, { kilder: [], virksomhet: ORGNR }),
    [`/${ORGNR}/kommende`]: () => json(200, FRISTER),
  };
  let svar = { ...STANDARD };
  const lagret = async () => (await api("GET", `/api/org/${org}/regnskap/skatteetaten`)).data;
  const oslo = (d: Date) => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Oslo" }).format(d);
  const pluss = (dager: number) => new Date(Date.parse(`${oslo(new Date())}T12:00:00Z`) + dager * 86_400_000).toISOString().slice(0, 10);

  beforeAll(async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
    Object.assign(config, {
      maskinportenKlientId: "klient-1",
      maskinportenNokkelId: "kid-1",
      maskinportenNokkel: privateKey,
      maskinportenUrl: "https://mp.test",
      kravUrl: "https://krav.test",
      fristerUrl: "https://frister.test",
      kravOgFrister: false,
    });
    settLokalOppgavekjorer(async (o) => void ko.push(o));
    settEtatFetch(async (url, init) => {
      const u = new URL(String(url));
      if (u.host === "mp.test") {
        // Scopet og kunden (systembrukeren) i JWT-en tokenet bestilles med.
        const jwt = new URLSearchParams(String(init?.body)).get("assertion")!;
        const innhold = JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString());
        tokener.push({ scope: innhold.scope, kunde: innhold.authorization_details?.[0]?.systemuser_org?.ID ?? null });
        return json(200, { access_token: `tok-${innhold.scope}`, expires_in: 120 });
      }
      kall.push({ vert: u.host, sti: `${u.pathname}${u.search}`, token: String((init?.headers as any)?.authorization ?? "") });
      if (u.host !== "krav.test" && u.host !== "frister.test") throw new Error(`Uventet kall: ${u.href}`);
      const svaret = svar[u.pathname];
      return svaret ? svaret() : new Response("<html><body><h1>404 Not Found</h1></body></html>", { status: 404, headers: { "content-type": "text/html" } });
    });
    org = (await api("POST", "/api/organisasjoner", { navn: "Skatt Test AS", orgnr: ORGNR })).data.id;
    for (const [hvem, epost, rolle] of [
      [regnskap, "skatt-regn@server.test", "regnskap"],
      [fakturerer, "skatt-fakt@server.test", "fakturerer"],
    ] as const) {
      const inv = await api("POST", `/api/org/${org}/invitasjoner`, { epost, rolle });
      expect((await api("POST", "/api/invitasjoner/aksepter", { token: inv.data.lenke.split("/").pop() }, hvem)).status).toBe(200);
    }
  });

  it("av til funksjonen er slått på, organisasjonen er koblet til og tilgangspakken er godkjent", async () => {
    expect(await lagret()).toMatchObject({
      pa: false,
      koblet: false,
      tilgang: false,
      pakke: "Krav, betalinger og utlegg",
      krav: { data: null, hentet: null, feil: null },
      frister: { data: null, hentet: null, feil: null },
    });
    expect((await api("POST", `/api/org/${org}/regnskap/skatteetaten/hent`)).data.error).toContain("ikke slått på");
    config.kravOgFrister = true;
    expect((await api("POST", `/api/org/${org}/regnskap/skatteetaten/hent`)).data.error).toContain("Koble til Skatteetaten først");
    await somSystem((db) => db.query("insert into faktura.skattekort_tilgang (org_id, status, pakker) values ($1, 'godkjent', $2)", [org, [TILGANGSPAKKE]]));
    const r = await api("POST", `/api/org/${org}/regnskap/skatteetaten/hent`);
    expect(r.status).toBe(409);
    expect(r.data.error).toContain("tilgangspakken «Krav, betalinger og utlegg»");
    expect(await planleggKravOgFrister()).toBe(0);
    expect(await hentKravOgFrister(org)).toBeNull();
    expect(kall).toEqual([]);
    // Regnskap ser fanen; fakturereren ikke.
    expect((await api("GET", `/api/org/${org}/regnskap/skatteetaten`, undefined, regnskap)).status).toBe(200);
    expect((await api("GET", `/api/org/${org}/regnskap/skatteetaten`, undefined, fakturerer)).status).toBe(403);
  });

  it("hentes med en gang tilgangspakken er godkjent: kravene, betalingene og fristene, med hvert sitt token", async () => {
    await somSystem((db) => db.query("update faktura.skattekort_tilgang set pakker = $2 where org_id = $1", [org, [TILGANGSPAKKE, KRAV_OG_UTLEGG]]));
    expect(await planleggKravOgFrister()).toBe(1);
    expect(await kjor("skatteetaten-hent")).toBe(1);
    expect(tokener).toEqual([
      { scope: "skatteetaten:kravogbetalinger", kunde: `0192:${ORGNR}` },
      { scope: "skatteetaten:frister", kunde: `0192:${ORGNR}` },
    ]);
    const periode = `fraOgMed=${pluss(-364)}&tilOgMed=${pluss(0)}`;
    expect(kall.map((k) => [k.vert, k.sti, k.token])).toEqual([
      ["krav.test", `/${ORGNR}/aapnekrav`, "Bearer tok-skatteetaten:kravogbetalinger"],
      ["krav.test", `/${ORGNR}/innbetalinger?${periode}`, "Bearer tok-skatteetaten:kravogbetalinger"],
      ["krav.test", `/${ORGNR}/utbetalinger?${periode}`, "Bearer tok-skatteetaten:kravogbetalinger"],
      ["frister.test", `/${ORGNR}/forfalte`, "Bearer tok-skatteetaten:frister"],
      ["frister.test", `/${ORGNR}/kommende?fraOgMed=${pluss(0)}`, "Bearer tok-skatteetaten:frister"],
    ]);
    const s = await lagret();
    expect(s).toMatchObject({ pa: true, koblet: true, tilgang: true, krav: { feil: null }, frister: { feil: null } });
    expect(s.krav.hentet).toBeTruthy();
    expect(s.krav.data.summer).toEqual({ saldo: 33500, forfalt: 9000, ikke_forfalt: 25000, renter: 200, uplassert: 500 });
    expect(s.krav.data.aapne.map((k: any) => [k.id, k.forfall[0].kid])).toEqual([
      ["krav-1", "1234567890"],
      ["krav-2", null],
    ]);
    expect(s.krav.data.innbetalinger).toHaveLength(2);
    // Ingen utbetalinger (KB-007) er et tomt svar.
    expect(s.krav.data.utbetalinger).toEqual([]);
    expect(s.frister.data.frister.map((f: any) => f.frist)).toEqual(["2099-05-31", "2099-12-10"]);
    // Hentet nå: ikke igjen før i morgen tidlig, og «Hent nå» venter et minutt.
    expect(await planleggKravOgFrister()).toBe(0);
    expect((await api("POST", `/api/org/${org}/regnskap/skatteetaten/hent`)).data).toEqual({ ok: true, allerede: true });
    expect(ko).toEqual([]);
  });

  it("feilene: hver del for seg, de gamle dataene står, og Cloud Tasks prøver igjen når Skatteetaten ikke svarer", async () => {
    svar = {
      ...STANDARD,
      [`/${ORGNR}/aapnekrav`]: () => json(500, { kode: "KB-001", melding: "Uventet feil på tjenesten.", korrelasjonsid: "k-1" }),
      [`/${ORGNR}/forfalte`]: () => json(403, { kode: "FRI-005", melding: "Feil i forbindelse med autorisering." }),
    };
    await expect(hentKravOgFrister(org)).rejects.toThrow("Uventet feil på tjenesten.");
    let s = await lagret();
    expect(s.krav.feil).toBe("Kunne ikke hente kravene fra Skatteetaten: Uventet feil på tjenesten. (KB-001) (korrelasjons-ID k-1)");
    expect(s.frister.feil).toContain("Kunne ikke hente fristene fra Skatteetaten: Skatteetaten avviste tilgangen (403, FRI-005).");
    expect(s.frister.feil).toContain("har sendt inn noe gjennom Admin Konsoll");
    expect(s.krav.data.aapne).toHaveLength(2);
    expect(s.frister.data.frister).toHaveLength(2);
    // Ukjent adresse (en vanlig 404-side) er en feil som ikke går over; ingen frister (FRI-007) er et tomt svar.
    svar = {
      ...STANDARD,
      [`/${ORGNR}/forfalte`]: () => json(404, { kode: "FRI-007", melding: "Ingen frister" }),
      [`/${ORGNR}/kommende`]: () => json(404, { kode: "FRI-007", melding: "Ingen frister" }),
    };
    delete svar[`/${ORGNR}/aapnekrav`];
    expect(await hentKravOgFrister(org)).toEqual({ krav: false, frister: true });
    s = await lagret();
    expect(s.krav.feil).toContain("Skatteetaten svarte 404");
    expect(s.krav.feil).toContain("kjente ikke igjen adressen");
    expect(s.frister).toMatchObject({ feil: null, data: { frister: [], kilder: [] } });
    // Tilbake til det vanlige.
    svar = { ...STANDARD };
    expect(await hentKravOgFrister(org)).toEqual({ krav: true, frister: true });
    expect((await lagret()).krav.feil).toBeNull();
  });

  it("rapportene: kravene, fristene og betalingene fra det som sist ble hentet, bare når hentingen er på", async () => {
    const regnskapsrapporter = async () => (await api("GET", `/api/org/${org}/rapportmodul`)).data.moduler.find((m: any) => m.id === "regnskap").rapporter.map((r: any) => r.id);
    expect(await regnskapsrapporter()).toEqual(expect.arrayContaining(["regnskap.skatteetaten_krav", "regnskap.skatteetaten_frister", "regnskap.skatteetaten_betalinger"]));
    const k = (await api("GET", `/api/org/${org}/rapportmodul/regnskap.skatteetaten_krav`)).data;
    expect(k.rader).toEqual([
      { krav: "Restskatt", periode: "2026/02", gruppe: "Skatt", forfall: "2026-02-21", opprinnelig: 10000, gjenstaaende: 9000, renter: 200, konto: "63450624804", kid: "1234567890" },
      { krav: "Merverdiavgift", periode: "5. termin 2026", gruppe: "Merverdiavgift", forfall: "2099-12-10", opprinnelig: 25000, gjenstaaende: 25000, renter: 0, konto: "76940500000", kid: null },
    ]);
    expect(k.sum).toEqual({ gjenstaaende: 34000, renter: 200 });
    expect(k.merknad).toContain("Saldo 33 500,00 kr: forfalt 9 000,00 kr, ikke forfalt 25 000,00 kr, stipulerte renter 200,00 kr.");
    expect(k.merknad).toContain("Innbetalt, men ikke plassert mot et krav: 500,00 kr.");
    const f = (await api("GET", `/api/org/${org}/rapportmodul/regnskap.skatteetaten_frister`)).data;
    expect(f.rader.map((r: any) => [r.frist, r.tittel])).toEqual([
      ["2099-05-31", "Husk å levere skattemeldingen for selskap."],
      ["2099-12-10", "Mva-melding for 5. termin"],
    ]);
    expect(f.merknad).toContain("Skatteetaten fikk ikke svar fra: mva (FEIL).");
    const b = (await api("GET", `/api/org/${org}/rapportmodul/regnskap.skatteetaten_betalinger?fra=2026-10-01&til=2026-10-31`)).data;
    expect(b.rader).toEqual([{ dato: "2026-10-01", hva: "Innbetaling", tekst: "bankoverføring, 500,00 kr ikke plassert", inn: 1000, ut: null }]);
    expect(b.sum).toEqual({ inn: 1000, ut: 0 });
    // CSV og PDF som de andre rapportene.
    expect((await api("GET", `/api/org/${org}/rapportmodul/regnskap.skatteetaten_krav/csv`)).status).toBe(200);
    expect((await api("GET", `/api/org/${org}/rapportmodul/regnskap.skatteetaten_krav/pdf`)).status).toBe(200);
    expect((await api("GET", `/api/org/${org}/rapportmodul/regnskap.skatteetaten_krav`, undefined, fakturerer)).status).toBe(403);
    // Av: rapportene vises ikke.
    config.kravOgFrister = false;
    expect(await regnskapsrapporter()).not.toContain("regnskap.skatteetaten_krav");
    config.kravOgFrister = true;
  });
});
