// Avstemmingen av lønnen (avstemming.ts) og refusjonene fra NAV (navRefusjon.ts,
// 0085_nav_refusjon.sql): avvikene med hva som bør gjøres (a-meldingen som ikke er levert, som
// ikke stemmer med lønnskjøringene, og lønn som ikke er bokført), og i appen: rapportene per termin
// og per år, merket «Lønnen er endret» på måneden i a-meldingen, refusjonene som registreres og
// bokføres (og reverseres når de slettes), rapporten og tilgangen (sykepenger er helseopplysninger).
import { beforeAll, describe, expect, it } from "vitest";
import { lagApi } from "../src/api.js";
import { hentGrunnlag, oppsummer } from "../src/amelding.js";
import { avvik, type Maanedsdata } from "../src/avstemming.js";
import { somBruker, somSystem } from "../src/db.js";
import { settKryptering } from "../src/kryptering.js";
import { bilagstekst } from "../src/navRefusjon.js";
import { settLokalOppgavekjorer } from "../src/tjenester.js";

const maaned = (x: Partial<Maanedsdata>): Maanedsdata => ({
  maaned: "2026-09",
  frist: "2026-10-05",
  lonn: { forskuddstrekk: 19000, aga: 9870, eksakt: { forskuddstrekk: 19000, aga: 9870 }, inntekter: { fastloenn: 70000 }, mottakere: 2 },
  amelding: { status: "levert", dato: "2026-10-02", forskuddstrekk: 19000, aga: 9870, inntekter: { fastloenn: 70000 } },
  bokfort: { forskuddstrekk: 19000, aga: 9870 },
  ...x,
});

describe("avvikene i avstemmingen (uten database)", () => {
  it("alt stemmer: ingen avvik", () => {
    expect(avvik(maaned({}), "2026-10-09")).toEqual([]);
    // Under 1 kr mellom lønnen og a-meldingen er avrunding (meldingen har hele kroner).
    expect(avvik(maaned({ lonn: { ...maaned({}).lonn!, forskuddstrekk: 19000.4 } }), "2026-10-09")).toEqual([]);
    // Ingen lønn, ingen melding og ingenting bokført.
    expect(avvik(maaned({ lonn: null, amelding: null, bokfort: null }), "2026-10-09")).toEqual([]);
  });

  it("a-meldingen er ikke levert: før og etter fristen", () => {
    expect(avvik(maaned({ amelding: null }), "2026-10-05")).toEqual(["A-meldingen er ikke levert ennå (fristen er 05.10.2026)."]);
    expect(avvik(maaned({ amelding: null }), "2026-10-06")).toEqual(["A-meldingen er ikke levert."]);
  });

  it("a-meldingen stemmer ikke med lønnskjøringene", () => {
    const a = maaned({ amelding: { status: "mottatt", dato: "2026-10-02", forskuddstrekk: 17500, aga: 9870, inntekter: { fastloenn: 65000 } } });
    expect(avvik(a, "2026-10-09")).toEqual([
      "I a-meldingen er forskuddstrekket 1 500 kr lavere og lønnen 5 000 kr lavere enn i lønnskjøringene: lag en ny a-melding for måneden (den erstatter den forrige).",
    ]);
    // Levert for en måned der lønnskjøringene er åpnet igjen eller slettet.
    expect(avvik(maaned({ lonn: null, bokfort: null }), "2026-10-09")).toEqual([
      "I a-meldingen er forskuddstrekket 19 000 kr høyere, arbeidsgiveravgiften 9 870 kr høyere og lønnen 70 000 kr høyere enn i lønnskjøringene: lag en ny a-melding for måneden (den erstatter den forrige).",
    ]);
  });

  it("bokføringen: ikke bokført, et øre forskjell, og bokført uten lønn", () => {
    expect(avvik(maaned({ bokfort: null }), "2026-10-09")).toEqual(["Lønnen er ikke bokført."]);
    expect(avvik(maaned({ bokfort: { forskuddstrekk: 19000, aga: 9869.99 } }), "2026-10-09")).toEqual([
      "Bokført er arbeidsgiveravgiften 0,01 kr lavere enn i lønnskjøringene: bokfør kjøringene som mangler, eller sjekk kontoene.",
    ]);
    expect(avvik(maaned({ lonn: null, amelding: null }), "2026-10-09")).toEqual(["Det er bokført lønn i måneden uten godkjente lønnskjøringer."]);
    // Et bilag som er reversert (summen null) er ikke lønn.
    expect(avvik(maaned({ lonn: null, amelding: null, bokfort: { forskuddstrekk: 0, aga: 0 } }), "2026-10-09")).toEqual([]);
  });

  it("teksten på bilaget for en refusjon (uten navnet)", () => {
    expect(bilagstekst("sykepenger", "2026-09-01", "2026-09-30")).toBe("Refusjon fra NAV: sykepenger 01.09.2026–30.09.2026");
    expect(bilagstekst("annet")).toBe("Refusjon fra NAV: annen refusjon");
  });
});

describe.skipIf(!process.env.DATABASE_URL)("avstemmingen og refusjonene fra NAV i appen", () => {
  const app = lagApi();
  const eier = "Bearer test:uid-avst-eier:avst-eier@server.test:mfa";
  const regnskap = "Bearer test:uid-avst-regn:avst-regn@server.test:mfa";
  let org: string;
  let kari: string;
  let kjoring: string;
  let meldingId: string;
  let refusjonId: string;

  const kall = async (m: string, sti: string, k?: unknown, hvem = eier) => {
    const r = await app.request(sti, { method: m, headers: { authorization: hvem, "content-type": "application/json" }, body: k === undefined ? undefined : JSON.stringify(k) });
    return { status: r.status, data: (r.headers.get("content-type") ?? "").includes("json") ? ((await r.json()) as any) : await r.text() };
  };
  const rapport = async (id: string, valg: string, hvem = eier) => {
    const r = await kall("GET", `/api/org/${org}/rapportmodul/${id}?${valg}`, undefined, hvem);
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    return r.data;
  };
  const september = async () => (await rapport("lonn.avstemming", "aar=2026&termin=5")).rader.find((r: any) => r.maaned === "September 2026");
  const aaret = async () => Object.fromEntries((await rapport("lonn.avstemming_aar", "aar=2026")).rader.map((r: any) => [r.hva, [r.lonn, r.amelding, r.bokfort, r.differanse]]));
  // A-meldingen for september, levert med oppsummeringen av lønnen nå (som workeren og «Levert»).
  const lever = async () => {
    const m = await kall("POST", `/api/org/${org}/amelding/2026-09`, { innsending: "fil" });
    expect(m.status, JSON.stringify(m.data)).toBe(201);
    meldingId = m.data.id;
    const o = oppsummer(await somSystem((db) => hentGrunnlag(db, org, "2026-09")));
    await somSystem((db) => db.query("update faktura.ameldinger set status = 'levert', oppsummering = $2, sendt_at = '2026-10-02T10:00:00Z' where id = $1", [meldingId, JSON.stringify(o)]));
  };

  beforeAll(async () => {
    settLokalOppgavekjorer(async () => {});
    settKryptering(async (t) => Buffer.from(`kryptert:${t}`), async (d) => d.toString().replace(/^kryptert:/, ""));
    org = (await kall("POST", "/api/organisasjoner", { navn: "Avstemming Test AS", orgnr: "915000312" })).data.id;
    expect((await kall("PUT", `/api/org/${org}/lonn-oppsett`, { aktiv: true, otp_prosent: 0, virksomhet_orgnr: "915000320" })).status).toBe(200);
    const inv = await kall("POST", `/api/org/${org}/invitasjoner`, { epost: "avst-regn@server.test", rolle: "regnskap" });
    expect((await kall("POST", "/api/invitasjoner/aksepter", { token: inv.data.lenke.split("/").pop() }, regnskap)).status).toBe(200);
    const ny = async (b: Record<string, unknown>) => {
      const r = await kall("POST", `/api/org/${org}/ansatte`, { ansatt_fra: "2025-01-01", lonnstype: "maaned", skattekort: "prosent", skattekort_aar: 2026, yrkeskode: "2221104", ...b });
      expect(r.status, JSON.stringify(r.data)).toBe(201);
      return r.data.id as string;
    };
    kari = await ny({ fornavn: "Kari", etternavn: "Avstemming", fnr: "13830197340", maanedslonn: 50000, skatt_prosent: 30, kontonr: "12345678903" });
    await ny({ fornavn: "Per", etternavn: "Avstemming", fnr: "24880199664", maanedslonn: 20000, skatt_prosent: 20, kontonr: "86011117947" });
    const k = await kall("POST", `/api/org/${org}/lonn/kjoringer`, { periode: "2026-09" });
    expect(k.status, JSON.stringify(k.data)).toBe(201);
    kjoring = k.data.id;
    expect((await kall("POST", `/api/org/${org}/lonn/kjoringer/${kjoring}/godkjenn`)).status).toBe(200);
  });

  it("før a-meldingen: lønnen er bokført, men a-meldingen er ikke levert", async () => {
    expect(await september()).toEqual({
      maaned: "September 2026",
      trekk_lonn: 19000,
      trekk_amelding: null,
      trekk_bokfort: 19000,
      aga_lonn: 9870,
      aga_amelding: null,
      aga_bokfort: 9870,
      amelding: "Ikke levert",
      avvik: "A-meldingen er ikke levert.",
    });
    const r = await rapport("lonn.avstemming", "aar=2026&termin=5");
    expect(r.periode).toBe("5. termin 2026 (september–oktober)");
    expect(r.merknad).toContain("kontoene 2600 (forskuddstrekk) og 2770 (skyldig arbeidsgiveravgift)");
  });

  it("levert: alt stemmer, og måneden er ikke endret", async () => {
    await lever();
    expect(await september()).toMatchObject({ trekk_amelding: 19000, aga_amelding: 9870, amelding: "Levert 02.10.2026", avvik: "Stemmer" });
    const m = (await kall("GET", `/api/org/${org}/amelding?aar=2026`)).data.maaneder.find((x: any) => x.maaned === "2026-09");
    expect(m).toMatchObject({ endret: false, siste: { id: meldingId, status: "levert" } });
    const a = await rapport("lonn.avstemming_aar", "aar=2026");
    expect(a.merknad).toBe("Lønnskjøringene, a-meldingene og bokføringen stemmer for månedene i året.");
    expect(await aaret()).toMatchObject({
      Fastlønn: [70000, 70000, null, 0],
      Forskuddstrekk: [19000, 19000, 19000, 0],
      Arbeidsgiveravgift: [9870, 9870, 9870, 0],
    });
  });

  it("lønnen endres etter leveringen: avviket med hva som bør gjøres, og merket i a-meldingen", async () => {
    expect((await kall("POST", `/api/org/${org}/lonn/kjoringer/${kjoring}/gjenapne`)).status).toBe(200);
    const l = await kall("POST", `/api/org/${org}/lonn/kjoringer/${kjoring}/linjer`, { ansatt_id: kari, lonnsart: "bonus", belop: 5000 });
    expect(l.status, JSON.stringify(l.data)).toBe(200);
    expect((await kall("POST", `/api/org/${org}/lonn/kjoringer/${kjoring}/godkjenn`)).status).toBe(200);
    // Bilaget ble reversert og ført på nytt (samme dato), så bokføringen stemmer med lønnen.
    expect(await september()).toMatchObject({
      trekk_lonn: 20500,
      trekk_amelding: 19000,
      trekk_bokfort: 20500,
      aga_lonn: 10575,
      aga_amelding: 9870,
      aga_bokfort: 10575,
      avvik:
        "I a-meldingen er forskuddstrekket 1 500 kr lavere, arbeidsgiveravgiften 705 kr lavere og lønnen 5 000 kr lavere enn i lønnskjøringene: lag en ny a-melding for måneden (den erstatter den forrige).",
    });
    expect((await kall("GET", `/api/org/${org}/amelding?aar=2026`)).data.maaneder.find((x: any) => x.maaned === "2026-09").endret).toBe(true);
    const a = await rapport("lonn.avstemming_aar", "aar=2026");
    expect(a.merknad).toBe("A-meldingen stemmer ikke med lønnskjøringene for september (se «Avstemming per termin»).");
    expect(await aaret()).toMatchObject({ Bonus: [5000, 0, null, -5000], Forskuddstrekk: [20500, 19000, 20500, -1500] });
    // En ny a-melding erstatter den forrige, og da stemmer det igjen.
    await lever();
    expect((await september()).avvik).toBe("Stemmer");
    expect((await kall("GET", `/api/org/${org}/amelding?aar=2026`)).data.maaneder.find((x: any) => x.maaned === "2026-09").endret).toBe(false);
  });

  it("en kjøring som ikke er bokført, og når kontoen er en annen enn bilagene har", async () => {
    const k = await kall("POST", `/api/org/${org}/lonn/kjoringer`, { periode: "2026-09", type: "ekstra", utbetalingsdato: "2026-09-25" });
    expect(k.status, JSON.stringify(k.data)).toBe(201);
    expect((await kall("POST", `/api/org/${org}/lonn/kjoringer/${k.data.id}/linjer`, { ansatt_id: kari, lonnsart: "bonus", belop: 1000 })).status).toBe(200);
    // Godkjent uten bilag (som før bokføringen kom).
    await somBruker((await kall("GET", "/api/meg")).data.bruker.id, (db) => db.query("select faktura.lonn_godkjenn($1)", [k.data.id]));
    expect((await september()).avvik).toBe(
      "I a-meldingen er forskuddstrekket 300 kr lavere, arbeidsgiveravgiften 141 kr lavere og lønnen 1 000 kr lavere enn i lønnskjøringene: lag en ny a-melding for måneden (den erstatter den forrige). " +
        "Bokført er forskuddstrekket 300 kr lavere og arbeidsgiveravgiften 141 kr lavere enn i lønnskjøringene: bokfør kjøringene som mangler, eller sjekk kontoene.",
    );
    expect((await kall("POST", `/api/org/${org}/lonn/kjoringer/${k.data.id}/bokfor`)).status).toBe(201);
    await lever();
    expect((await september()).avvik).toBe("Stemmer");
    // Kontoen for forskuddstrekket endres: bilagene som er ført, har den gamle.
    expect((await kall("PUT", `/api/org/${org}/lonn/bokforing`, { kontoer: { forskuddstrekk: "2601" } })).status).toBe(200);
    expect((await september()).avvik).toBe("Bokført er forskuddstrekket 20 800 kr lavere enn i lønnskjøringene: bokfør kjøringene som mangler, eller sjekk kontoene.");
    expect((await rapport("lonn.avstemming_aar", "aar=2026")).merknad).toBe("Bokføringen stemmer ikke for september.");
    expect((await kall("PUT", `/api/org/${org}/lonn/bokforing`, { kontoer: { forskuddstrekk: "2600" } })).status).toBe(200);
    expect((await september()).avvik).toBe("Stemmer");
  });

  it("refusjon fra NAV: kontrollene, registrert og bokført, listen og rapportene", async () => {
    const sti = `/api/org/${org}/lonn/nav-refusjoner`;
    const ok = { type: "sykepenger", ansatt_id: kari, dato: "2026-10-05", belop: 12345.5, fra: "2026-09-01", til: "2026-09-30" };
    expect((await kall("POST", sti, { ...ok, type: undefined })).data.error).toBe("Velg hva refusjonen gjelder");
    expect((await kall("POST", sti, { ...ok, belop: 0 })).data.error).toBe("Beløpet må være over 0");
    expect((await kall("POST", sti, { ...ok, til: null })).data.error).toBe("Velg både fra- og til-datoen for perioden (eller ingen)");
    expect((await kall("POST", sti, { ...ok, til: "2026-08-31" })).data.error).toBe("Til-datoen er før fra-datoen");
    const r = await kall("POST", sti, ok);
    expect(r.status, JSON.stringify(r.data)).toBe(201);
    refusjonId = r.data.id;
    expect(r.data).toMatchObject({ type: "sykepenger", ansatt_navn: "Kari Avstemming", dato: "2026-10-05", belop: 12345.5, fra: "2026-09-01", til: "2026-09-30", tekst: null });
    expect(r.data.bilag).toMatch(/^L-2026-\d+$/);
    // Uten den ansatte og perioden.
    const annen = await kall("POST", sti, { type: "annet", dato: "2026-10-06", belop: 100, tekst: "Tilskudd" });
    expect(annen.status, JSON.stringify(annen.data)).toBe(201);
    const liste = (await kall("GET", `${sti}?aar=2026`)).data;
    expect(liste.refusjoner.map((x: any) => [x.type, x.belop])).toEqual([
      ["annet", 100],
      ["sykepenger", 12345.5],
    ]);
    expect(liste.sum).toMatchObject({ sykepenger: 12345.5, annet: 100, foreldrepenger: 0 });
    expect((await kall("GET", `${sti}?aar=2025`)).data.refusjoner).toEqual([]);
    // Bilaget: banken i debet og kontoen for refusjon fra NAV (5800) i kredit.
    const b = await rapport("lonn.bokforing", "fra=2026-10-01&til=2026-10-31");
    expect(b.rader.filter((x: any) => x.bilag === r.data.bilag).map((x: any) => [x.konto, x.debet, x.kredit, x.bilagstekst])).toEqual([
      ["1920", 12345.5, null, "Refusjon fra NAV: sykepenger 01.09.2026–30.09.2026"],
      ["5800", null, 12345.5, "Refusjon fra NAV: sykepenger 01.09.2026–30.09.2026"],
    ]);
    // Rapportene: refusjonene i perioden, og det som er mottatt i sykepengerapporten.
    const n = await rapport("lonn.nav_refusjoner", "fra=2026-10-01&til=2026-10-31");
    expect(n.rader).toEqual([
      { dato: "2026-10-05", ansatt: "Kari Avstemming (1)", type: "Sykepenger", periode: "01.09.2026–30.09.2026", belop: 12345.5, bilag: r.data.bilag },
      { dato: "2026-10-06", ansatt: "", type: "Annen refusjon – Tilskudd", periode: "", belop: 100, bilag: annen.data.bilag },
    ]);
    const s = await rapport("lonn.sykepenger", "fra=2026-10-01&til=2026-10-31");
    expect(s.rader.map((x: any) => [x.navn, x.mottatt])).toEqual([["Kari Avstemming", 12345.5]]);
    // Refusjonene er ikke lønn: avstemmingen er som før.
    expect((await september()).avvik).toBe("Stemmer");
  });

  it("regnskap ser avstemmingen og bilagene, men ikke refusjonene (sykepenger)", async () => {
    const sti = `/api/org/${org}/lonn/nav-refusjoner`;
    expect((await kall("GET", `${sti}?aar=2026`, undefined, regnskap)).status).toBe(403);
    expect((await kall("POST", sti, { type: "annet", dato: "2026-10-06", belop: 100 }, regnskap)).status).toBe(403);
    expect((await kall("DELETE", `${sti}/${refusjonId}`, undefined, regnskap)).status).toBe(403);
    expect((await kall("GET", `/api/org/${org}/rapportmodul/lonn.nav_refusjoner?fra=2026-10-01&til=2026-10-31`, undefined, regnskap)).status).toBe(403);
    expect((await rapport("lonn.avstemming", "aar=2026&termin=5", regnskap)).rader.find((r: any) => r.maaned === "September 2026").avvik).toBe("Stemmer");
    expect((await rapport("lonn.bokforing", "fra=2026-10-01&til=2026-10-31", regnskap)).rader.some((x: any) => x.konto === "5800")).toBe(true);
  });

  it("en refusjon som slettes, reverseres i regnskapet", async () => {
    const sti = `/api/org/${org}/lonn/nav-refusjoner`;
    expect((await kall("DELETE", `${sti}/${refusjonId}`)).status).toBe(204);
    expect((await kall("DELETE", `${sti}/${refusjonId}`)).data.error).toBe("Fant ikke refusjonen");
    expect((await kall("GET", `${sti}?aar=2026`)).data.refusjoner.map((x: any) => x.type)).toEqual(["annet"]);
    const b = await rapport("lonn.bokforing", "fra=2026-10-01&til=2026-10-31");
    const paa5800 = b.rader.filter((x: any) => x.konto === "5800");
    expect(paa5800.map((x: any) => [x.debet, x.kredit])).toEqual([
      [null, 12345.5],
      [null, 100],
      [12345.5, null],
    ]);
    expect(paa5800.at(-1).bilagstekst).toBe("Reversert: refusjonen fra NAV er slettet");
  });
});
