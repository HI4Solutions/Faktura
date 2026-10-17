// Sjekklister (0114_sjekklister.sql, sjekklister.ts): administrator lager sjekklistene, de med
// rollen (eller alle) fyller dem ut med «Normalt» eller «Avvik» med kommentar, administrator får
// varsel om avvikene og lukker dem med et tiltak (den som meldte, får vite det), og rapportene viser
// det som er gjort, det som ikke ble gjort, og avvikene.
import { beforeAll, describe, expect, it } from "vitest";
import { lagApi } from "../src/api.js";
import { config } from "../src/config.js";
import { funksjonerFor } from "../src/funksjoner.js";
import { settLokalOppgavekjorer, type Oppgave } from "../src/tjenester.js";
import { periodeFor, periodeSlutt, perioder } from "../src/sjekklister.js";
import { ikkeGjort } from "../src/sjekklisteRapporter.js";
import { iDag } from "../src/regler.js";

const minus = (dato: string, dager: number) => new Date(new Date(`${dato}T00:00:00Z`).getTime() - dager * 86_400_000).toISOString().slice(0, 10);

describe("periodene (uten database)", () => {
  it("dagen, uka fra mandag og måneden, med slutten", () => {
    expect(periodeFor("daglig", "2026-10-15")).toBe("2026-10-15");
    expect(periodeFor("ukentlig", "2026-10-15")).toBe("2026-10-12");
    expect(periodeFor("ukentlig", "2026-10-18")).toBe("2026-10-12");
    expect(periodeFor("ukentlig", "2026-10-12")).toBe("2026-10-12");
    expect(periodeFor("maanedlig", "2026-10-31")).toBe("2026-10-01");
    expect(periodeSlutt("ukentlig", "2026-09-28")).toBe("2026-10-04");
    expect(periodeSlutt("maanedlig", "2028-02-01")).toBe("2028-02-29");
    expect(periodeSlutt("daglig", "2026-10-15")).toBe("2026-10-15");
  });

  it("periodene som overlapper et tidsrom", () => {
    expect(perioder("daglig", "2026-10-30", "2026-11-02")).toEqual(["2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02"]);
    expect(perioder("ukentlig", "2026-10-01", "2026-10-31")).toEqual(["2026-09-28", "2026-10-05", "2026-10-12", "2026-10-19", "2026-10-26"]);
    expect(perioder("maanedlig", "2026-11-15", "2027-01-10")).toEqual(["2026-11-01", "2026-12-01", "2027-01-01"]);
    expect(perioder("ved_behov", "2026-10-01", "2026-10-31")).toEqual([]);
    expect(perioder("daglig", "2026-10-31", "2026-10-01")).toEqual([]);
  });

  it("de faste som ikke ble gjort: periodene som er over, etter at sjekklisten ble laget, uten utfylling", () => {
    const daglig = { id: "a", navn: "Åpning", frekvens: "daglig" as const, opprettet: "2026-10-11" };
    expect(ikkeGjort([daglig], new Set(["a|daglig|2026-10-14"]), "2026-10-10", "2026-10-16", "2026-10-16").map((x) => x.periode)).toEqual([
      "2026-10-11",
      "2026-10-12",
      "2026-10-13",
      "2026-10-15",
    ]);
    const ukentlig = { id: "b", navn: "Renhold", frekvens: "ukentlig" as const, opprettet: "2026-09-30" };
    expect(ikkeGjort([ukentlig], new Set(), "2026-09-01", "2026-10-31", "2026-10-16").map((x) => x.periode)).toEqual(["2026-09-28", "2026-10-05"]);
    // En utfylling med en annen frekvens (lista er endret) teller ikke for denne.
    expect(ikkeGjort([ukentlig], new Set(["b|daglig|2026-09-28"]), "2026-09-28", "2026-10-04", "2026-10-16")).toEqual([
      { periode: "2026-09-28", sjekkliste: "Renhold", frekvens: "ukentlig" },
    ]);
    // Stengt i helgene: lørdag og søndag er ikke med for de daglige, men uka er med.
    const fra9 = { ...daglig, opprettet: "2026-10-09" };
    expect(ikkeGjort([fra9], new Set(["a|daglig|2026-10-14"]), "2026-10-09", "2026-10-16", "2026-10-16", false).map((x) => x.periode)).toEqual([
      "2026-10-09",
      "2026-10-12",
      "2026-10-13",
      "2026-10-15",
    ]);
    expect(ikkeGjort([ukentlig], new Set(), "2026-10-05", "2026-10-11", "2026-10-16", false)).toHaveLength(1);
  });

  it("rutene hører til funksjonen", () => {
    expect(funksjonerFor("/sjekklister")).toEqual(["sjekklister"]);
    expect(funksjonerFor("/sjekklister/utfyllinger/x/fullfor")).toEqual(["sjekklister"]);
  });
});

describe.skipIf(!process.env.DATABASE_URL)("sjekklistene i appen", () => {
  const app = lagApi();
  const eier = "Bearer test:uid-sjekk-eier:sjekk-eier@server.test:mfa";
  const ola = "Bearer test:uid-sjekk-ola:ola.sjekk@server.test";
  const kari = "Bearer test:uid-sjekk-kari:kari.sjekk@server.test";
  const admin = "Bearer test:uid-sjekk-admin:sjekk-admin@server.test:mfa";
  const ko: Oppgave[] = [];
  let org: string;
  let eierId: string;
  let olaId: string;
  let lager: string;
  let aapning: string;
  let vare: string;
  let utfylling: string;
  let punkter: { id: string; tekst: string }[];

  const kall = async (m: string, sti: string, k?: unknown, hvem = eier) => {
    const r = await app.request(sti, { method: m, headers: { authorization: hvem, "content-type": "application/json" }, body: k === undefined ? undefined : JSON.stringify(k) });
    return { status: r.status, data: (r.headers.get("content-type") ?? "").includes("json") ? ((await r.json()) as any) : await r.text() };
  };
  const tom = () => ko.splice(0, ko.length);
  const varsler = (liste: Oppgave[]) => liste.filter((o): o is Extract<Oppgave, { type: "varsel" }> => o.type === "varsel").map((o) => o.varsel);
  const ansatt = async (fornavn: string, epost: string, hvem: string, gruppe_id?: string) => {
    const a = await kall("POST", `/api/org/${org}/ansatte`, { fornavn, etternavn: "Sjekk", epost, ansatt_fra: "2026-01-01", gruppe_id });
    expect(a.status, JSON.stringify(a.data)).toBe(201);
    const inv = await kall("POST", `/api/org/${org}/ansatte/${a.data.id}/inviter`, {});
    expect((await kall("POST", "/api/invitasjoner/aksepter", { token: inv.data.lenke.split("/").pop() }, hvem)).status).toBe(200);
    return (await kall("GET", "/api/meg", undefined, hvem)).data.bruker.id as string;
  };

  beforeAll(async () => {
    settLokalOppgavekjorer(async (o) => void ko.push(o));
    org = (await kall("POST", "/api/organisasjoner", { navn: "Sjekkliste Test AS", orgnr: "811000817" })).data.id;
    eierId = (await kall("GET", "/api/meg")).data.bruker.id;
    expect((await kall("PUT", `/api/org/${org}/lonn-oppsett`, { aktiv: true })).status).toBe(200);
    lager = (await kall("POST", `/api/org/${org}/ansattgrupper`, { navn: "Lager" })).data.id;
    olaId = await ansatt("Ola", "ola.sjekk@server.test", ola);
    await ansatt("Kari", "kari.sjekk@server.test", kari, lager);
  });

  it("administrator lager sjekklistene; navnet, punktene og hvor ofte sjekkes", async () => {
    expect((await kall("GET", `/api/org/${org}/sjekklister`)).data).toMatchObject({ kan_endre: true, ser_alle: true, lister: [], apne_avvik: 0, roller: [{ id: lager, navn: "Lager" }] });
    const punkt = [{ tekst: "Lys og varme på" }, { tekst: "Kassen telt", hjelp: "Skriv beløpet om det ikke stemmer" }, { tekst: "Alarmen av" }];
    expect((await kall("POST", `/api/org/${org}/sjekklister`, { navn: "Å", frekvens: "daglig", punkter: punkt })).data.error).toBe("Gi sjekklisten et navn (minst 2 tegn)");
    expect((await kall("POST", `/api/org/${org}/sjekklister`, { navn: "Åpning", frekvens: "daglig", punkter: [] })).data.error).toBe("Legg inn minst ett punkt");
    expect((await kall("POST", `/api/org/${org}/sjekklister`, { navn: "Åpning", frekvens: "hver time", punkter: punkt })).data.error).toBe("Velg hvor ofte sjekklisten skal gjøres");
    const ny = await kall("POST", `/api/org/${org}/sjekklister`, { navn: "Åpning", beskrivelse: "Hver morgen", frekvens: "daglig", punkter: punkt });
    expect(ny.status).toBe(201);
    aapning = ny.data.id;
    expect((await kall("POST", `/api/org/${org}/sjekklister`, { navn: "åpning", frekvens: "ukentlig", punkter: punkt })).data.error).toBe(
      "Det finnes allerede en sjekkliste med det navnet",
    );
    vare = (await kall("POST", `/api/org/${org}/sjekklister`, { navn: "Varemottak", frekvens: "ved_behov", roller: [lager], punkter: [{ tekst: "Antall kolli stemmer" }, { tekst: "Ingen skader" }] })).data
      .id;
    const l = (await kall("GET", `/api/org/${org}/sjekklister`)).data.lister;
    // I alfabetisk rekkefølge (Å sist).
    expect(l.map((x: any) => [x.navn, x.frekvens, x.punkter.length, x.min, x.naa])).toEqual([
      ["Varemottak", "ved_behov", 2, true, null],
      ["Åpning", "daglig", 3, true, null],
    ]);
    expect(l.find((x: any) => x.navn === "Åpning")).toMatchObject({ periode: iDag(), forrige: null, forrige_gjort: null, punkter: [{ tekst: "Lys og varme på" }, { tekst: "Kassen telt", hjelp: "Skriv beløpet om det ikke stemmer" }, { tekst: "Alarmen av" }] });
  });

  it("de andre ser bare sine og lager ikke sjekklister", async () => {
    const o = (await kall("GET", `/api/org/${org}/sjekklister`, undefined, ola)).data;
    expect(o).toMatchObject({ kan_endre: false, ser_alle: false });
    expect(o.lister.map((x: any) => x.navn)).toEqual(["Åpning"]);
    expect((await kall("GET", `/api/org/${org}/sjekklister`, undefined, kari)).data.lister.map((x: any) => x.navn)).toEqual(["Varemottak", "Åpning"]);
    expect((await kall("POST", `/api/org/${org}/sjekklister`, { navn: "Egen", frekvens: "daglig", punkter: [{ tekst: "A" }] }, ola)).status).toBe(403);
    expect((await kall("POST", `/api/org/${org}/sjekklister/${vare}/start`, {}, ola)).data.error).toBe("Fant ikke sjekklisten");
  });

  it("utfyllingen: normalt, avvik med kommentar, «Alt normalt», fullfør, og varsel til administrator", async () => {
    tom();
    const u = await kall("POST", `/api/org/${org}/sjekklister/${aapning}/start`, {}, ola);
    expect(u.data).toMatchObject({ navn: "Åpning", frekvens: "daglig", periode: iDag(), status: "pagar", kan_svare: true, startet_navn: "Ola Sjekk" });
    utfylling = u.data.id;
    punkter = u.data.punkter;
    expect(punkter.map((p: any) => [p.tekst, p.svar])).toEqual([
      ["Lys og varme på", null],
      ["Kassen telt", null],
      ["Alarmen av", null],
    ]);
    // Samme dag fortsetter den samme.
    expect((await kall("POST", `/api/org/${org}/sjekklister/${aapning}/start`, {}, kari)).data.id).toBe(utfylling);
    const svar = (p: number, b: unknown, hvem = ola) => kall("PUT", `/api/org/${org}/sjekklister/utfyllinger/${utfylling}/punkter/${punkter[p]!.id}`, b, hvem);
    expect((await svar(0, { svar: "ok" })).status).toBe(204);
    expect((await svar(1, { svar: "avvik", kommentar: " " })).data.error).toBe("Skriv hva avviket er");
    expect((await svar(1, { svar: "avvik", kommentar: "Mangler 200 kr" })).status).toBe(204);
    expect((await kall("POST", `/api/org/${org}/sjekklister/utfyllinger/${utfylling}/fullfor`, {}, ola)).data.error).toBe("Svar på alle punktene først (1 gjenstår)");
    const alt = (await kall("POST", `/api/org/${org}/sjekklister/utfyllinger/${utfylling}/alt-normalt`, {}, ola)).data;
    expect(alt.punkter.map((p: any) => [p.tekst, p.svar.svar, p.svar.kommentar])).toEqual([
      ["Lys og varme på", "ok", null],
      ["Kassen telt", "avvik", "Mangler 200 kr"],
      ["Alarmen av", "ok", null],
    ]);
    expect(varsler(tom())).toEqual([]);
    expect((await kall("POST", `/api/org/${org}/sjekklister/utfyllinger/${utfylling}/fullfor`, { kommentar: "Fin morgen" }, ola)).data).toEqual({ avvik: 1 });
    const [v] = varsler(tom());
    expect(v).toMatchObject({
      hendelse: "sjekklister",
      org_id: org,
      bruker_ider: [eierId],
      tittel: "Avvik i «Åpning»",
      tekst: "Kassen telt: Mangler 200 kr",
      url: "/sjekklister?fane=avvik",
    });
    // Fullført kan ikke endres, og dagens står som gjort.
    expect((await svar(1, { svar: "ok" })).status).toBe(409);
    const l = (await kall("GET", `/api/org/${org}/sjekklister`, undefined, ola)).data;
    expect(l.lister.find((x: any) => x.id === aapning).naa).toMatchObject({ id: utfylling, status: "fullfort", fullfort_navn: "Ola Sjekk", besvart: 3, avvik: 1 });
    expect(l.apne_avvik).toBe(1);
    expect((await kall("GET", `/api/org/${org}/sjekklister/utfyllinger/${utfylling}`, undefined, ola)).data).toMatchObject({ status: "fullfort", kommentar: "Fin morgen", kan_svare: false });
  });

  it("avvikene: administrator ser alle og lukker dem med tiltaket; den som meldte, får vite det", async () => {
    expect((await kall("GET", `/api/org/${org}/sjekklister/avvik`, undefined, ola)).data).toMatchObject([{ punkt_tekst: "Kassen telt", kommentar: "Mangler 200 kr", eget: true }]);
    expect((await kall("GET", `/api/org/${org}/sjekklister/avvik`, undefined, kari)).data).toEqual([]);
    const a = (await kall("GET", `/api/org/${org}/sjekklister/avvik`)).data;
    expect(a).toMatchObject([{ sjekkliste: "Åpning", punkt_tekst: "Kassen telt", besvart_navn: "Ola Sjekk", utfylling_status: "fullfort", avvik_lukket: null }]);
    const lukk = (b: unknown, hvem = eier) => kall("POST", `/api/org/${org}/sjekklister/avvik/${a[0].utfylling_id}/${a[0].punkt_id}/lukk`, b, hvem);
    expect((await lukk({ tiltak: "Telt" }, ola)).status).toBe(403);
    expect((await lukk({ tiltak: " " })).data.error).toBe("Skriv hva som er gjort med avviket");
    tom();
    expect((await lukk({ tiltak: "Kassen telt på nytt, stemmer" })).status).toBe(204);
    expect(varsler(tom())).toMatchObject([
      { hendelse: "sjekklister", bruker_ider: [olaId], tittel: "Avviket i «Åpning» er lukket", tekst: "Kassen telt: Kassen telt på nytt, stemmer" },
    ]);
    expect((await lukk({ tiltak: "Igjen" })).status).toBe(404);
    expect((await kall("GET", `/api/org/${org}/sjekklister/avvik`)).data).toEqual([]);
    expect((await kall("GET", `/api/org/${org}/sjekklister/avvik?alle=1`)).data).toMatchObject([{ tiltak: "Kassen telt på nytt, stemmer", avvik_lukket_navn: "sjekk-eier@server.test" }]);
    expect((await kall("GET", `/api/org/${org}/sjekklister`)).data.apne_avvik).toBe(0);
  });

  it("ved behov: hver gang sin egen; historikken og endringer i lista", async () => {
    const v1 = (await kall("POST", `/api/org/${org}/sjekklister/${vare}/start`, {}, kari)).data;
    expect((await kall("POST", `/api/org/${org}/sjekklister/${vare}/start`, {}, kari)).data.id).toBe(v1.id);
    await kall("POST", `/api/org/${org}/sjekklister/utfyllinger/${v1.id}/alt-normalt`, {}, kari);
    expect((await kall("POST", `/api/org/${org}/sjekklister/utfyllinger/${v1.id}/fullfor`, {}, kari)).data).toEqual({ avvik: 0 });
    const v2 = (await kall("POST", `/api/org/${org}/sjekklister/${vare}/start`, {}, kari)).data;
    expect(v2.id).not.toBe(v1.id);
    const h = (await kall("GET", `/api/org/${org}/sjekklister/utfyllinger`)).data;
    expect(h.map((x: any) => [x.navn, x.status, x.besvart, x.avvik])).toEqual(
      expect.arrayContaining([
        ["Åpning", "fullfort", 3, 1],
        ["Varemottak", "fullfort", 2, 0],
        ["Varemottak", "pagar", 0, 0],
      ]),
    );
    expect((await kall("GET", `/api/org/${org}/sjekklister/utfyllinger`, undefined, ola)).data.map((x: any) => x.navn)).toEqual(["Åpning"]);
    // Et besvart punkt tas ut av lista, men står i den fullførte.
    const l = (await kall("GET", `/api/org/${org}/sjekklister`)).data.lister.find((x: any) => x.id === aapning);
    expect(
      (await kall("PUT", `/api/org/${org}/sjekklister/${aapning}`, { navn: "Åpning", frekvens: "daglig", punkter: [{ id: l.punkter[0].id, tekst: "Lys på" }, { tekst: "Dørene låst opp" }] }))
        .status,
    ).toBe(200);
    const etter = (await kall("GET", `/api/org/${org}/sjekklister`)).data.lister.find((x: any) => x.id === aapning);
    expect(etter.punkter.map((p: any) => p.tekst)).toEqual(["Lys på", "Dørene låst opp"]);
    expect((await kall("GET", `/api/org/${org}/sjekklister/utfyllinger/${utfylling}`)).data.punkter.map((p: any) => p.tekst)).toEqual(["Lys og varme på", "Kassen telt", "Alarmen av"]);
  });

  it("rapportene: det som er gjort og avvikene (sjekklisten er fra i dag, så ingen dager mangler)", async () => {
    const idag = iDag();
    // I går føres etter (påbegynt, ikke fullført).
    expect((await kall("POST", `/api/org/${org}/sjekklister/${aapning}/start`, { dato: minus(idag, 1) }, ola)).status).toBe(200);
    expect((await kall("POST", `/api/org/${org}/sjekklister/${aapning}/start`, { dato: minus(idag, 90) }, ola)).data.error).toBe("Datoen kan være høyst to måneder tilbake");
    expect((await kall("GET", `/api/org/${org}/sjekklister`)).data.lister.find((x: any) => x.id === aapning).forrige_gjort).toBe(null);
    const r = (await kall("GET", `/api/org/${org}/rapportmodul/personal.sjekklister?fra=${minus(idag, 3)}&til=${idag}`)).data;
    expect(r.rader.filter((x: any) => x.sjekkliste === "Åpning").map((x: any) => [x.periode, x.status, x.gjort_av, x.avvik])).toEqual([
      [minus(idag, 1), "Påbegynt, ikke fullført", "Ola Sjekk", 0],
      [idag, "Fullført", "Ola Sjekk", 1],
    ]);
    expect(r.merknad).toBe("Perioden er dagen, uka (fra mandag) eller måneden.");
    const a = (await kall("GET", `/api/org/${org}/rapportmodul/personal.sjekkliste_avvik?fra=${idag}&til=${idag}`)).data;
    expect(a.rader).toMatchObject([{ sjekkliste: "Åpning", punkt: "Kassen telt", kommentar: "Mangler 200 kr", meldt_av: "Ola Sjekk", status: "Lukket", tiltak: "Kassen telt på nytt, stemmer" }]);
    expect((await kall("GET", `/api/org/${org}/rapportmodul/personal.sjekklister`, undefined, ola)).status).toBe(403);
  });

  it("arkivert eller slettet, og uten funksjonen", async () => {
    expect((await kall("DELETE", `/api/org/${org}/sjekklister/${vare}`)).data).toEqual({ resultat: "arkivert" });
    expect((await kall("GET", `/api/org/${org}/sjekklister`, undefined, kari)).data.lister.map((x: any) => x.navn)).toEqual(["Åpning"]);
    expect((await kall("POST", `/api/org/${org}/sjekklister/${vare}/start`, {}, kari)).data.error).toBe("Sjekklisten er arkivert");
    expect((await kall("POST", `/api/org/${org}/sjekklister/${vare}/aktiv`, { aktiv: true })).status).toBe(204);
    const ubrukt = (await kall("POST", `/api/org/${org}/sjekklister`, { navn: "Brannvern", frekvens: "maanedlig", punkter: [{ tekst: "Slukkeren er sjekket" }] })).data.id;
    expect((await kall("DELETE", `/api/org/${org}/sjekklister/${ubrukt}`)).data).toEqual({ resultat: "slettet" });
    // Plattformadministratoren slår funksjonen av.
    config.adminEposter.push("sjekk-admin@server.test");
    expect((await kall("PUT", `/api/admin/organisasjoner/${org}/funksjoner`, { sjekklister: false }, admin)).status).toBe(200);
    expect((await kall("GET", `/api/org/${org}/sjekklister`)).data.error).toBe("Sjekklister er ikke slått på for organisasjonen");
    expect((await kall("PUT", `/api/admin/organisasjoner/${org}/funksjoner`, { sjekklister: true }, admin)).status).toBe(200);
  });
});
