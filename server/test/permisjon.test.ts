// Permisjon og permittering (0084_permisjon_permittering.sql, permisjoner.ts): lønnsplikten (de
// 15 første arbeidsdagene), hvilke som rapporteres i a-meldingen, trekket i fastlønnen (med
// prosenten og lønnen hver dag) og lønnen for de planlagte timene i lønnspliktperioden; og i appen:
// fraværet med arten, prosenten, varselet og lønnsplikten, at delvis permittering ikke gjør den
// ansatte borte i planen, lønnskjøringen, a-meldingen (validert mot skjemaet), kontrollen,
// varselet som PDF og rapporten.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { lagApi } from "../src/api.js";
import { byggLeveranse, hentGrunnlag, kontroller, oppsummer, tilXml, type Grunnlag } from "../src/amelding.js";
import { somSystem } from "../src/db.js";
import type { Ansatt } from "../src/lonnsberegning.js";
import type { Lonnsendring } from "../src/lonnsendringer.js";
import { lonnspliktSlutt, permisjonslinjer, rapporteres, sluttdatoKjent, type Permisjon } from "../src/permisjoner.js";
import { settLokalOppgavekjorer, type Oppgave } from "../src/tjenester.js";

const her = path.dirname(fileURLToPath(import.meta.url));
const harXmllint = spawnSync("xmllint", ["--version"]).status === 0;
function valider(xml: string, skjema: string) {
  if (!harXmllint) return;
  const fil = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "permisjon-")), "fil.xml");
  fs.writeFileSync(fil, xml);
  execFileSync("xmllint", ["--noout", "--schema", path.join(her, "xsd", `${skjema}.xsd`), fil], { stdio: "pipe" });
}

const ansatt = (x: Partial<Ansatt>): Ansatt =>
  ({ id: "a", ansatt_fra: "2025-01-01", ansatt_til: null, lonnstype: "maaned", maanedslonn: 40000, timelonn: null, stillingsprosent: 100, ...x }) as Ansatt;
const permisjon = (x: Partial<Permisjon>): Permisjon => ({ id: "p", ansatt_id: "a", fra: "2026-10-12", til: "2026-10-16", art: "annen", prosent: 100, lonnsplikt_til: null, ...x });
const linjer = (r: { linjer: { lonnsart: string; tekst: string; antall: number | null; sats: number | null; belop: number }[] }) =>
  r.linjer.map((l) => [l.lonnsart, l.tekst, l.antall, l.sats, l.belop]);
const ingen = () => 0;

describe("permisjonene (uten database)", () => {
  it("lønnsplikten: de 15 første virkedagene (ikke helg og helligdager)", () => {
    expect(lonnspliktSlutt("2026-09-01")).toBe("2026-09-21");
    expect(lonnspliktSlutt("2026-10-01")).toBe("2026-10-21");
    // Påsken 2026: skjærtorsdag, langfredag og andre påskedag teller ikke.
    expect(lonnspliktSlutt("2026-03-30")).toBe("2026-04-22");
    expect(lonnspliktSlutt("2026-09-01", 0)).toBeNull();
  });

  it("a-meldingen: permittering alltid, permisjon over 14 dager, og sluttdatoen når den er kjent", () => {
    expect(rapporteres({ art: "annen", fra: "2026-01-01", til: "2026-01-14" })).toBe(false);
    expect(rapporteres({ art: "foreldre", fra: "2026-01-01", til: "2026-01-15" })).toBe(true);
    expect(rapporteres({ art: "permittering", fra: "2026-01-05", til: "2026-01-05" })).toBe(true);
    expect(sluttdatoKjent({ til: "2026-12-31", slutt_ukjent: false }, "2026-10-31")).toBe(true);
    expect(sluttdatoKjent({ til: "2026-12-31", slutt_ukjent: true }, "2026-10-31")).toBe(false);
    expect(sluttdatoKjent({ til: "2026-10-30", slutt_ukjent: true }, "2026-10-31")).toBe(true);
  });

  it("permisjon uten lønn: fastlønnen trekkes for arbeidsdagene, med prosenten og lønnen hver dag", () => {
    // Oktober 2026 har 22 arbeidsdager.
    expect(linjer(permisjonslinjer(ansatt({}), [], [permisjon({})], "2026-10-01", "2026-10-31", ingen))).toEqual([
      ["trekk_permisjon", "Trekk for permisjon uten lønn (5 arbeidsdager)", 0.2273, 40000, -9090.91],
    ]);
    expect(linjer(permisjonslinjer(ansatt({}), [], [permisjon({ art: "foreldre", prosent: 40, til: "2026-11-30" })], "2026-10-01", "2026-10-31", ingen))).toEqual([
      ["trekk_permisjon", "Trekk for foreldrepermisjon (15 arbeidsdager, 40 %)", 0.2727, 40000, -10909.09],
    ]);
    // Lønnen endres 15. oktober: tre dager med 40 000 og to med 44 000 kr.
    const historie: Lonnsendring[] = [
      { id: "1", ansatt_id: "a", gjelder_fra: "2025-01-01", lonnstype: "maaned", maanedslonn: 40000, timelonn: null, stillingsprosent: 100, opprettet: 0, slettet: null },
      { id: "2", ansatt_id: "a", gjelder_fra: "2026-10-15", lonnstype: null, maanedslonn: 44000, timelonn: null, stillingsprosent: null, opprettet: 0, slettet: null },
    ];
    expect(linjer(permisjonslinjer(ansatt({}), historie, [permisjon({})], "2026-10-01", "2026-10-31", ingen))).toEqual([
      ["trekk_permisjon", "Trekk for permisjon uten lønn (5 arbeidsdager)", 0.2273, null, -9454.55],
    ]);
    // Timelønn: ikke noe trekk (timene føres ikke).
    expect(permisjonslinjer(ansatt({ lonnstype: "time", maanedslonn: null, timelonn: 250 }), [], [permisjon({})], "2026-10-01", "2026-10-31", ingen).linjer).toEqual([]);
  });

  it("permittering: lønnen går i lønnspliktperioden og trekkes etterpå; med timelønn lønnes de planlagte timene", () => {
    const p = permisjon({ art: "permittering", fra: "2026-10-01", til: "2026-12-31", lonnsplikt_til: "2026-10-21" });
    const r = permisjonslinjer(ansatt({}), [], [p], "2026-10-01", "2026-10-31", ingen);
    expect(linjer(r)).toEqual([["trekk_permittering", "Trekk for permittering etter lønnsplikten (7 arbeidsdager)", 0.3182, 40000, -12727.27]]);
    expect(r.merknader).toEqual([
      "Permittert fra 01.10.2026 (100 %): lønnsplikt til og med 21.10.2026, deretter trekkes lønnen. Den ansatte kan søke dagpenger fra NAV.",
    ]);
    // Neste måned: hele måneden trekkes (21 arbeidsdager i november), og ingen ny merknad.
    const nov = permisjonslinjer(ansatt({}), [], [{ ...p, prosent: 50 }], "2026-11-01", "2026-11-30", ingen);
    expect(linjer(nov)).toEqual([["trekk_permittering", "Trekk for permittering etter lønnsplikten (21 arbeidsdager, 50 %)", 0.5, 40000, -20000]]);
    expect(nov.merknader).toEqual([]);
    // Uten lønnsplikt: trekket fra første dag.
    expect(linjer(permisjonslinjer(ansatt({}), [], [{ ...p, lonnsplikt_til: null }], "2026-10-01", "2026-10-31", ingen))[0]).toEqual([
      "trekk_permittering",
      "Trekk for permittering (22 arbeidsdager)",
      1,
      40000,
      -40000,
    ]);
    // Timelønn: de planlagte timene i lønnspliktperioden (7,5 timer på hverdagene), og uten
    // planlagte timer en merknad.
    const time = ansatt({ lonnstype: "time", maanedslonn: null, timelonn: 250 });
    const hverdag = (d: string) => (new Date(`${d}T12:00:00Z`).getUTCDay() % 6 === 0 ? 0 : 7.5);
    expect(linjer(permisjonslinjer(time, [], [p], "2026-10-01", "2026-10-31", hverdag))).toEqual([
      ["lonnsplikt", "Lønn i lønnspliktperioden ved permittering (15 dager)", 112.5, 250, 28125],
    ]);
    expect(permisjonslinjer(time, [], [p], "2026-10-01", "2026-10-31", ingen).merknader[0]).toBe(
      "Permittert i lønnspliktperioden (15 virkedager) uten planlagte timer: legg inn lønnen for lønnspliktdagene for hånd.",
    );
  });
});

describe.skipIf(!process.env.DATABASE_URL)("permisjon og permittering i appen", () => {
  const app = lagApi();
  const eier = "Bearer test:uid-perm-eier:perm-eier@server.test:mfa";
  const olaInn = "Bearer test:uid-perm-ola:ola.perm@server.test";
  let org: string;
  let ola: string;
  let kari: string;
  let per: string;
  let permId: string;
  let foreldreId: string;
  let ferieId: string;
  const ko: Oppgave[] = [];
  const varsler = () => ko.filter((o): o is Extract<Oppgave, { type: "varsel" }> => o.type === "varsel").map((o) => o.varsel);

  const kall = async (m: string, sti: string, k?: unknown, hvem = eier) => {
    const r = await app.request(sti, { method: m, headers: { authorization: hvem, "content-type": "application/json" }, body: k === undefined ? undefined : JSON.stringify(k) });
    const type = r.headers.get("content-type") ?? "";
    return { status: r.status, type, data: type.includes("json") ? ((await r.json()) as any) : await r.text() };
  };
  const slipp = (k: any, a: string) => k.slipper.find((s: any) => s.ansatt_id === a);
  const radene = (s: any) => s.linjer.filter((l: any) => !l.fjernet).map((l: any) => [l.lonnsart, l.tekst, l.belop]);
  const leveranse = async (maaned: string) => {
    const g = await somSystem((db) => hentGrunnlag(db, org, maaned));
    const fnr: Record<string, string> = { [ola]: "13830197340", [kari]: "24880199664", [per]: "07850199850" };
    const m = byggLeveranse({ ...g, org: { navn: "Permisjon Test AS", orgnr: "915000282" }, virksomhet: "915000290" } as Grunnlag, {
      meldingsId: "a1b2c3d4-0000-4000-8000-000000000084",
      tidspunkt: "2026-11-03T09:00:00Z",
      fnr: (id) => fnr[id] ?? null,
    }) as any;
    const mottaker = (a: string) => m.leveranse.oppgave.virksomhet[0].inntektsmottaker.find((x: any) => x.norskIdentifikator === fnr[a]);
    return { g, m, mottaker };
  };

  beforeAll(async () => {
    settLokalOppgavekjorer(async (o) => {
      ko.push(o);
    });
    org = (await kall("POST", "/api/organisasjoner", { navn: "Permisjon Test AS" })).data.id;
    expect((await kall("PUT", `/api/org/${org}/lonn-oppsett`, { aktiv: true, otp_prosent: 0 })).status).toBe(200);
    const ny = async (b: Record<string, unknown>) => {
      const r = await kall("POST", `/api/org/${org}/ansatte`, { ansatt_fra: "2025-01-01", lonnstype: "maaned", skattekort: "prosent", skatt_prosent: 30, skattekort_aar: 2026, yrkeskode: "2221104", ...b });
      expect(r.status, JSON.stringify(r.data)).toBe(201);
      return r.data.id as string;
    };
    ola = await ny({ fornavn: "Ola", etternavn: "Permittert", epost: "ola.perm@server.test", maanedslonn: 40000, kontonr: "12345678903" });
    kari = await ny({ fornavn: "Kari", etternavn: "Foreldre", maanedslonn: 50000, kontonr: "86011117947" });
    per = await ny({ fornavn: "Per", etternavn: "Gammel", maanedslonn: 30000, kontonr: "86011117947" });
    const inv = (await kall("POST", `/api/org/${org}/ansatte/${ola}/inviter`)).data;
    expect((await kall("POST", "/api/invitasjoner/aksepter", { token: inv.lenke.split("/").pop() }, olaInn)).status).toBe(200);
  });

  it("permitteringen: arten, prosenten, varselet og lønnsplikten (standard 15 arbeidsdager), og den ansatte får beskjed", async () => {
    const kropp = { ansatt_id: ola, type: "permisjon", permisjon_art: "permittering", fra: "2026-10-01", til: "2026-12-31", prosent: 50, slutt_ukjent: true, notat: "Ordremangel" };
    expect((await kall("POST", `/api/org/${org}/fravaer`, { ...kropp, varslet: "2026-10-02" })).data.error).toBe("Varselet må være gitt før permitteringen begynner");
    expect((await kall("POST", `/api/org/${org}/fravaer`, { ...kropp, lonnsplikt_til: "2026-09-30" })).data.error).toBe("Lønnsplikten kan ikke slutte før permitteringen begynner");
    const r = await kall("POST", `/api/org/${org}/fravaer`, { ...kropp, varslet: "2026-09-10", betalt: true });
    expect(r.status, JSON.stringify(r.data)).toBe(201);
    permId = r.data.id;
    expect(r.data).toMatchObject({ type: "permisjon", permisjon_art: "permittering", prosent: 50, delvis: true, slutt_ukjent: true, varslet: "2026-09-10", lonnsplikt_til: "2026-10-21", betalt: false });
    expect(varsler().at(-1)).toMatchObject({ tittel: "Permittering registrert", tekst: "tor. 1. okt.–tor. 31. des.." });
    // Foreldrepermisjon over ett år (lov for permisjon).
    const f = await kall("POST", `/api/org/${org}/fravaer`, { ansatt_id: kari, type: "permisjon", permisjon_art: "foreldre", fra: "2026-10-12", til: "2027-10-31" });
    expect(f.status, JSON.stringify(f.data)).toBe(201);
    foreldreId = f.data.id;
    // Permisjon uten art (som før arten kom): må velges før a-meldingen.
    expect((await kall("POST", `/api/org/${org}/fravaer`, { ansatt_id: per, type: "permisjon", fra: "2026-10-01", til: "2026-10-31" })).status).toBe(201);
  });

  it("delvis permittert: kan ha annet fravær, er på jobb i planen, men kan ikke ha en annen permisjon", async () => {
    const ferie = await kall("POST", `/api/org/${org}/fravaer`, { ansatt_id: ola, type: "ferie", fra: "2026-10-26", til: "2026-10-28" });
    expect(ferie.status, JSON.stringify(ferie.data)).toBe(201);
    ferieId = ferie.data.id;
    const dobbel = await kall("POST", `/api/org/${org}/fravaer`, { ansatt_id: ola, type: "permisjon", permisjon_art: "utdanning", prosent: 20, fra: "2026-11-02", til: "2026-11-30" });
    expect([dobbel.status, dobbel.data.error]).toEqual([409, "Den ansatte har allerede permisjon eller permittering i perioden"]);
    const plan = (await kall("GET", `/api/org/${org}/vakter?fra=2026-10-12&til=2026-10-18`)).data;
    expect(plan.fravaer.map((x: any) => [x.ansatt_id, x.type]).sort()).toEqual(
      [
        [kari, "permisjon"],
        [per, "permisjon"],
      ].sort(),
    );
    // Den ansatte ser sin egen permittering med prosenten og varselet.
    const egne = (await kall("GET", `/api/org/${org}/fravaer?fra=2026-10-01&til=2026-10-31&ansatt=${ola}`, undefined, olaInn)).data;
    expect(egne.find((x: any) => x.id === permId)).toMatchObject({ permisjon_art: "permittering", prosent: 50, varslet: "2026-09-10" });
  });

  it("lønnskjøringen: trekket etter lønnsplikten og for foreldrepermisjonen", async () => {
    const k = await kall("POST", `/api/org/${org}/lonn/kjoringer`, { periode: "2026-10" });
    expect(k.status, JSON.stringify(k.data)).toBe(201);
    expect(radene(slipp(k.data, ola))).toEqual([
      ["fastlonn", "Fastlønn", 40000],
      ["trekk_permittering", "Trekk for permittering etter lønnsplikten (7 arbeidsdager, 50 %)", -6363.64],
    ]);
    expect(slipp(k.data, ola).merknader).toContain(
      "Permittert fra 01.10.2026 (50 %): lønnsplikt til og med 21.10.2026, deretter trekkes lønnen. Den ansatte kan søke dagpenger fra NAV.",
    );
    expect(radene(slipp(k.data, kari))).toEqual([
      ["fastlonn", "Fastlønn", 50000],
      ["trekk_permisjon", "Trekk for foreldrepermisjon (15 arbeidsdager)", -34090.91],
    ]);
    expect(radene(slipp(k.data, per))).toEqual([
      ["fastlonn", "Fastlønn", 30000],
      ["trekk_permisjon", "Trekk for permisjon uten lønn (22 arbeidsdager)", -30000],
    ]);
    expect((await kall("POST", `/api/org/${org}/lonn/kjoringer/${k.data.id}/godkjenn`)).data.status).toBe("godkjent");
  });

  it("a-meldingen: permitteringen og permisjonene med id, prosent og beskrivelse; arten mangler for den gamle", async () => {
    const { g, m, mottaker } = await leveranse("2026-10");
    expect(mottaker(ola).arbeidsforhold[0].permisjon).toEqual([{ startdato: "2026-10-01", permisjonsprosent: "50", permisjonId: permId, beskrivelse: "permittering" }]);
    expect(mottaker(kari).arbeidsforhold[0].permisjon).toEqual([
      { startdato: "2026-10-12", sluttdato: "2027-10-31", permisjonsprosent: "100", permisjonId: foreldreId, beskrivelse: "permisjonMedForeldrepenger" },
    ]);
    expect(mottaker(per).arbeidsforhold[0].permisjon).toBeUndefined();
    expect(kontroller(g).filter((a) => a.tekst.includes("permisjon"))).toEqual([
      { niva: "feil", tekst: "Velg hva slags permisjon Per Gammel har (01.10.2026–31.10.2026, under Fravær): permisjon over 14 dager skal med i a-meldingen.", ansatt_id: per },
    ]);
    expect(oppsummer(g).mottakere.find((x) => x.ansatt_id === ola)!.permisjoner).toEqual([{ navn: "Permittering", fra: "2026-10-01", til: null, prosent: 50 }]);
    valider(tilXml(m), "amelding_v2_3");
    // Permitteringen avsluttes i oktober uten bekreftet sluttdato: datoen rapporteres, med en advarsel.
    expect((await kall("PATCH", `/api/org/${org}/fravaer/${permId}`, { til: "2026-10-30" })).status).toBe(200);
    const ny = await leveranse("2026-10");
    expect(ny.mottaker(ola).arbeidsforhold[0].permisjon[0].sluttdato).toBe("2026-10-30");
    expect(kontroller(ny.g).find((a) => a.ansatt_id === ola && a.tekst.startsWith("Permittering"))?.tekst).toBe(
      "Permittering for Ola Permittert står til og med 30.10.2026 uten bekreftet sluttdato, og den datoen rapporteres som sluttdato. Forleng den om den varer lenger.",
    );
    expect((await kall("PATCH", `/api/org/${org}/fravaer/${permId}`, { til: "2026-12-31" })).status).toBe(200);
  });

  it("varselet om permittering som PDF: for eier og administrator, bare for permittering", async () => {
    const pdf = await app.request(`/api/org/${org}/fravaer/${permId}/permitteringsvarsel`, { headers: { authorization: eier } });
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
    expect(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString()).toBe("%PDF-");
    expect((await kall("GET", `/api/org/${org}/fravaer/${permId}/permitteringsvarsel`, undefined, olaInn)).status).toBe(403);
    expect((await kall("GET", `/api/org/${org}/fravaer/${ferieId}/permitteringsvarsel`)).data.error).toBe("Fraværet er ikke en permittering");
  });

  it("rapportene «Permisjoner og permitteringer» og «Fravær»", async () => {
    const fr = await kall("GET", `/api/org/${org}/rapportmodul/personal.fravaer?fra=2026-10-01&til=2026-10-31`);
    expect(fr.data.rader.map((x: any) => [x.navn, x.type])).toEqual([
      ["Ola Permittert", "Permittering (50 %)"],
      ["Ola Permittert", "Ferie"],
      ["Kari Foreldre", "Foreldrepermisjon"],
      ["Per Gammel", "Permisjon"],
    ]);
    const r = await kall("GET", `/api/org/${org}/rapportmodul/lonn.permisjoner?fra=2026-10-01&til=2026-10-31`);
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data.rader.map((x: any) => [x.navn, x.art, x.prosent, x.lonn, x.lonnsplikt_til, x.amelding, x.trekk])).toEqual([
      ["Ola Permittert", "Permittering", 50, "Lønnsplikt", "2026-10-21", "Ja (sluttdato ukjent)", -6363.64],
      ["Per Gammel", "Permisjon", 100, "Uten", null, "Ja", -30000],
      ["Kari Foreldre", "Foreldrepermisjon", 100, "Uten", null, "Ja", -34090.91],
    ]);
  });
});
