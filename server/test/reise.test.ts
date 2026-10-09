// Reiser og naturalytelser (0083_naturalytelser_reiser.sql, reise.ts, naturalytelser.ts):
// beregningen av reisene (statens satser mot de trekkfrie, døgnene, måltidene, nattillegg,
// kilometergodtgjørelse, utland, over 28 døgn og når vilkårene for trekkfri godtgjørelse ikke er
// oppfylt), fordelen av fri bil, elektronisk kommunikasjon og rentefordel, summene (naturalytelser
// i grunnlaget for trekket, men ikke i nettolønnen), og i appen: naturalytelsene på den ansatte,
// den ansatte som fører og sender reiseregningen, lederen som avviser og godkjenner, lønnskjøringen
// som betaler (trekkfritt og trekkpliktig), a-meldingen (utgiftsgodtgjørelse med antall og fri bil
// med listepris), lønnsbilaget, lønnsslippen, rapportene og varslene.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { lagApi } from "../src/api.js";
import { byggLeveranse, hentGrunnlag, tilXml, type Grunnlag } from "../src/amelding.js";
import { somSystem } from "../src/db.js";
import { summer, type Ansatt, type Linje, type Oppsett } from "../src/lonnsberegning.js";
import { bilfordel, naturallinjer, type Naturalytelse } from "../src/naturalytelser.js";
import { beregnReise, reisenavn, type Reise } from "../src/reise.js";
import { settLokalOppgavekjorer, type Oppgave } from "../src/tjenester.js";

const her = path.dirname(fileURLToPath(import.meta.url));
const harXmllint = spawnSync("xmllint", ["--version"]).status === 0;
function valider(xml: string, skjema: string) {
  if (!harXmllint) return;
  const fil = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "reise-")), "fil.xml");
  fs.writeFileSync(fil, xml);
  execFileSync("xmllint", ["--noout", "--schema", path.join(her, "xsd", `${skjema}.xsd`), fil], { stdio: "pipe" });
}

const reise = (x: Partial<Reise>): Reise => ({
  formaal: "Kundemøte",
  sted: "Drammen",
  fra: "2026-10-05T08:00",
  til: "2026-10-05T16:00",
  overnatting: "ingen",
  nattillegg: false,
  utland: false,
  land: null,
  kostsats: null,
  diett: true,
  maaltider: {},
  kjoring: [],
  utlegg: [],
  trekkfri: true,
  ...x,
});
const linjer = (b: { linjer: { lonnsart: string; tekst: string; antall: number | null; belop: number }[] }) => b.linjer.map((l) => [l.lonnsart, l.tekst, l.antall, l.belop]);

describe("reisene (uten database)", () => {
  it("dagsreise: statens sats, og det som er over den trekkfrie, er trekkpliktig", () => {
    const b = beregnReise(reise({}), "staten");
    expect(linjer(b)).toEqual([
      ["reise_kost_dag", "Drammen 5.10: kost på dagsreise (8 t)", 1, 200],
      ["reise_kost_trekk", "Drammen 5.10: kost over den trekkfrie satsen", null, 197],
    ]);
    expect(b).toMatchObject({ belop: 397, trekkfritt: 200, trekkpliktig: 197, utlegg: 0, aar: 2026, merknader: [] });
    // Over 12 timer, og lunsj dekket (30 % av dagens sats).
    expect(linjer(beregnReise(reise({ til: "2026-10-05T21:00" }), "staten")).map((l) => l[3])).toEqual([400, 336]);
    expect(linjer(beregnReise(reise({ maaltider: { "1": "L" } }), "staten")).map((l) => l[3])).toEqual([140, 137.9]);
    // Bare de trekkfrie satsene: ingenting trekkpliktig. Under 6 timer: ingen kost.
    expect(linjer(beregnReise(reise({}), "trekkfri"))).toEqual([["reise_kost_dag", "Drammen 5.10: kost på dagsreise (8 t)", 1, 200]]);
    expect(beregnReise(reise({ til: "2026-10-05T13:00" }), "staten").linjer).toEqual([]);
  });

  it("med overnatting på hotell: døgnene fra avreisen, frokosten i romprisen og resten av tiden", () => {
    // 34 timer: et døgn (frokost dekket: 1 012 × 80 % og 693 × 80 % = 554) og 10 timer
    // (statens 6–12 timer, men et helt trekkfritt døgn): alt er trekkfritt.
    const kort = beregnReise(reise({ sted: "Bergen", til: "2026-10-06T18:00", overnatting: "hotell", maaltider: { "1": "F" } }), "staten");
    expect(kort.dogn.map((d) => [d.nr, d.timer, d.maaltider, d.sats, d.trekkfri])).toEqual([
      [1, 24, "F", 809.6, 554],
      [2, 10, "", 397, 693],
    ]);
    expect(linjer(kort)).toEqual([["reise_kost_hotell", "Bergen 5.–6.10: kost 2 døgn (hotell)", 2, 1206.6]]);
    // 60 timer med frokost begge døgnene: 2 016,20 kr, av det 1 801 kr trekkfritt.
    const lang = beregnReise(reise({ sted: "Bergen", til: "2026-10-07T20:00", overnatting: "hotell", maaltider: { "1": "F", "2": "F" } }), "staten");
    expect(linjer(lang)).toEqual([
      ["reise_kost_hotell", "Bergen 5.–7.10: kost 3 døgn (hotell)", 3, 1801],
      ["reise_kost_trekk", "Bergen 5.–7.10: kost over den trekkfrie satsen", null, 215.2],
    ]);
  });

  it("privat overnatting med nattillegg (ikke frokosttrekk), og hybel", () => {
    const b = beregnReise(reise({ sted: "Hamar", til: "2026-10-07T10:00", overnatting: "privat", nattillegg: true, maaltider: { "1": "F" } }), "staten");
    expect(linjer(b)).toEqual([
      ["reise_kost_privat", "Hamar 5.–7.10: kost 2 døgn (hybel med kokemulighet/privat)", 2, 214],
      ["reise_kost_trekk", "Hamar 5.–7.10: kost over den trekkfrie satsen", null, 1810],
      ["reise_nattillegg", "Hamar 5.–7.10: nattillegg 2 netter", 2, 904],
    ]);
    expect(beregnReise(reise({ til: "2026-10-06T16:00", overnatting: "hybel" }), "trekkfri").linjer.map((l) => [l.lonnsart, l.belop])).toEqual([["reise_kost_hybel", 800]]);
  });

  it("kilometergodtgjørelse: bil med passasjer og skogsvei, og motorsykkel", () => {
    const b = beregnReise(
      reise({
        diett: false,
        kjoring: [
          { dato: "2026-10-05", fra: "Oslo", til: "Drammen", km: 100, kjoretoy: "bil", passasjerer: ["Per Hansen"], skogsvei: 10, tilhenger: false },
          { dato: "2026-10-05", fra: "Drammen", til: "Kongsberg", km: 50, kjoretoy: "mc", passasjerer: [], skogsvei: 0, tilhenger: false },
        ],
      }),
      "staten",
    );
    expect(linjer(b)).toEqual([
      ["km_bil", "Drammen 5.10: 100 km med bil", 100, 350],
      ["km_tillegg", "Drammen 5.10: tillegg for skogsvei og tilhenger", null, 10],
      ["km_passasjer", "Drammen 5.10: passasjertillegg (100 km)", 100, 100],
      ["km_bil_trekk", "Drammen 5.10: kilometergodtgjørelse over den trekkfrie satsen (100 km à 1,8 kr)", null, 180],
      ["km_annet", "Drammen 5.10: 50 km med motorsykkel over 125 ccm", 50, 147.5],
    ]);
    expect(b).toMatchObject({ belop: 787.5, trekkfritt: 607.5, trekkpliktig: 180 });
  });

  it("vilkårene for trekkfri godtgjørelse er ikke oppfylt: alt er trekkpliktig (ikke utleggene)", () => {
    const b = beregnReise(
      reise({
        trekkfri: false,
        kjoring: [{ dato: "2026-10-05", fra: "Oslo", til: "Drammen", km: 100, kjoretoy: "bil", passasjerer: [], skogsvei: 0, tilhenger: false }],
        utlegg: [
          { dato: "2026-10-05", tekst: "Parkering", belop: 120 },
          { dato: "2026-10-05", tekst: "Bom", belop: 45 },
        ],
      }),
      "staten",
    );
    expect(linjer(b)).toEqual([
      ["reise_kost_trekk", "Drammen 5.10: kost (trekkpliktig)", null, 397],
      ["km_bil_trekk", "Drammen 5.10: 100 km med bil (trekkpliktig)", 100, 530],
      ["reise_utlegg", "Drammen 5.10: utlegg etter regning (2 bilag)", null, 165],
    ]);
    expect(b).toMatchObject({ trekkfritt: 0, trekkpliktig: 927, utlegg: 165 });
    expect(b.merknader).toEqual(["Vilkårene for trekkfri godtgjørelse er ikke oppfylt: alt utenom utleggene er trekkpliktig."]);
  });

  it("utland: statens sats for landet, og over 28 døgn", () => {
    const b = beregnReise(reise({ sted: "Stockholm", til: "2026-10-07T08:00", overnatting: "hotell", utland: true, land: "Sverige", kostsats: 1200 }), "staten");
    expect(linjer(b).map((l) => l[3])).toEqual([1386, 1014]);
    const uten = beregnReise(reise({ til: "2026-10-07T08:00", overnatting: "hotell", utland: true, land: "Sverige" }), "staten");
    expect(uten.merknader).toEqual(["Statens sats for Sverige er ikke ført; den trekkfrie satsen er brukt."]);
    expect(uten.belop).toBe(1386);
    const lang = beregnReise(reise({ til: "2026-11-04T08:00", overnatting: "hotell" }), "staten");
    expect(lang.dogn).toHaveLength(30);
    expect(linjer(lang).map((l) => l[3])).toEqual([28 * 693, 30 * 1012 - 28 * 693]);
    expect(lang.merknader).toEqual(["Reisen er over 28 døgn: kosten etter 28 døgn er regnet som trekkpliktig (langvarig opphold). Kontroller satsene."]);
  });

  it("navnet på reisen, og satsene for et år som ikke er lagt inn", () => {
    expect(reisenavn({ formaal: "Messe", sted: null, fra: "2026-09-30T08:00", til: "2026-10-02T18:00" })).toBe("Messe 30.9–2.10");
    expect(beregnReise(reise({ fra: "2027-01-05T08:00", til: "2027-01-05T16:00" }), "staten").merknader).toEqual([
      "Satsene for reiser i 2027 er ikke lagt inn; satsene for 2026 er brukt.",
    ]);
    // Teksten på linjene er høyst 120 tegn (som i lønnslinjene).
    const lang = beregnReise(
      reise({
        sted: "Et svært langt stedsnavn som går over flere ord og enda flere",
        fra: "2026-09-28T08:00",
        til: "2026-10-02T18:00",
        overnatting: "hotell",
        kjoring: [{ dato: "2026-09-28", fra: "A", til: "B", km: 1234.5, kjoretoy: "bil", passasjerer: [], skogsvei: 0, tilhenger: false }],
      }),
      "staten",
    );
    expect(Math.max(...lang.linjer.map((l) => l.tekst.length))).toBeLessThanOrEqual(120);
    expect(lang.linjer[0]!.tekst).toBe("Et svært langt stedsnavn som går over f… 28.9–2.10: kost 5 døgn (hotell)");
  });
});

const natural = (x: Partial<Naturalytelse>): Naturalytelse => ({
  id: "n",
  ansatt_id: "ola",
  type: "annet",
  tekst: null,
  belop: null,
  listepris: null,
  regnr: null,
  bilpool: false,
  forstegangsreg: null,
  yrkeskjoring: false,
  laan: null,
  rente: null,
  fra: "2026-01-01",
  til: null,
  ...x,
});

describe("naturalytelsene (uten database)", () => {
  it("fri bil: 30 % opp til innslagspunktet og 20 % over, og 75 % for eldre biler og mye yrkeskjøring", () => {
    expect(bilfordel(450000, 2026, null, false)).toMatchObject({ aar: 127030, maaned: 10585.83, faktor: 1 });
    expect(bilfordel(450000, 2026, "2022-12-31", false)).toMatchObject({ maaned: 7939.38, faktor: 0.75, gammel: true });
    expect(bilfordel(450000, 2026, "2023-01-01", false).gammel).toBe(false);
    expect(bilfordel(450000, 2026, "2020-05-01", true).faktor).toBe(0.5625);
    expect(bilfordel(300000, 2025, null, false).aar).toBe(90000);
  });

  it("linjene for måneden: bil med tilleggsinformasjon, sjablongen og rentefordelen med normrenten", () => {
    const liste = [
      natural({ id: "b", type: "bil", listepris: 450000, regnr: "EL12345" }),
      natural({ id: "e", type: "ek" }),
      natural({ id: "r", type: "rentefordel", laan: 200000, rente: 1 }),
      natural({ id: "f", type: "forsikring", belop: 150, til: "2026-09-30" }),
    ];
    const okt = naturallinjer(liste, "2026-10-01", "2026-10-31");
    expect(okt.linjer.map((l) => [l.lonnsart, l.tekst, l.belop, l.nokkel, l.tillegg])).toEqual([
      ["natural_bil", "Fri bil EL12345 (listepris 450 000 kr)", 10585.83, "natural:b", { listepris: 450000, regnr: "EL12345", bilpool: false }],
      ["natural_ek", "Elektronisk kommunikasjon (sjablong)", 366, "natural:e", null],
      ["natural_rente", "Rentefordel på lån (200 000 kr, normrente 4,7 %, rente 1 %)", 616.67, "natural:r", null],
    ]);
    expect(okt.merknader).toEqual([]);
    expect(naturallinjer(liste, "2026-11-01", "2026-11-30").merknader).toEqual([
      "Normrenten for november 2026 er ikke lagt inn; 4,7 % er brukt for rentefordelen. Sjekk den på skatteetaten.no.",
    ]);
  });

  it("summene: naturalytelsene er med i grunnlaget for trekket og avgiften, men ikke i nettolønnen", () => {
    const a = { id: "ola", skattekort: "prosent", skatt_prosent: 30, skattekort_aar: 2026 } as unknown as Ansatt;
    const o = { otp_prosent: 0, feriepenger_prosent: 12 } as unknown as Oppsett;
    const t = { ansatt: a, aar: 2026, ekstra: false, halvSkatt: false, tabell: null, frikortBrukt: 0 };
    const l = (lonnsart: string, belop: number): Linje => ({ lonnsart, tekst: lonnsart, antall: null, sats: null, belop, nokkel: lonnsart });
    expect(summer([l("fastlonn", 40000), l("natural_bil", 10000), l("km_bil", 350), l("km_bil_trekk", 180)], o, t, "2026-10-20", null)).toMatchObject({
      brutto: 40000,
      naturalytelser: 10000,
      trekkpliktig: 50180,
      trekkgrunnlag: 50180,
      skattetrekk: 15054,
      utgifter: 530,
      netto: 25476,
      feriepengegrunnlag: 40000,
      aga_grunnlag: 50180,
    });
  });
});

describe.skipIf(!process.env.DATABASE_URL)("reiser og naturalytelser i appen", () => {
  const app = lagApi();
  const eier = "Bearer test:uid-reise-eier:reise-eier@server.test:mfa";
  const olaInn = "Bearer test:uid-reise-ola:ola.reise@server.test";
  let org: string;
  let ola: string;
  let kari: string;
  let reiseId: string;
  let okt: string;
  let eierId: string;
  let olaId: string;
  const ko: Oppgave[] = [];
  const varsler = () => ko.filter((o): o is Extract<Oppgave, { type: "varsel" }> => o.type === "varsel").map((o) => o.varsel);

  const kall = async (m: string, sti: string, k?: unknown, hvem = eier) => {
    const r = await app.request(sti, { method: m, headers: { authorization: hvem, "content-type": "application/json" }, body: k === undefined ? undefined : JSON.stringify(k) });
    const type = r.headers.get("content-type") ?? "";
    return { status: r.status, data: type.includes("json") ? ((await r.json()) as any) : await r.text() };
  };
  const slipp = (k: any, ansatt: string) => k.slipper.find((s: any) => s.ansatt_id === ansatt);
  const radene = (s: any) => s.linjer.filter((l: any) => !l.fjernet).map((l: any) => [l.lonnsart, l.belop]);
  const bergen = {
    formaal: "Kurs i lønn",
    sted: "Bergen",
    fra: "2026-10-05T08:00",
    til: "2026-10-07T20:00",
    overnatting: "hotell",
    maaltider: { "1": "F", "2": "F" },
    kjoring: [{ dato: "2026-10-05", fra: "Kontoret", til: "Gardermoen", km: 120, passasjerer: ["Per Hansen"] }],
    utlegg: [{ dato: "2026-10-07", tekst: "Hotell", belop: 1450 }],
  };

  beforeAll(async () => {
    settLokalOppgavekjorer(async (o) => {
      ko.push(o);
    });
    org = (await kall("POST", "/api/organisasjoner", { navn: "Reise Test AS" })).data.id;
    eierId = (await kall("GET", "/api/meg")).data.bruker.id;
    expect((await kall("PUT", `/api/org/${org}/lonn-oppsett`, { aktiv: true, otp_prosent: 0 })).status).toBe(200);
    const ny = async (b: Record<string, unknown>) => {
      const r = await kall("POST", `/api/org/${org}/ansatte`, { ansatt_fra: "2025-01-01", lonnstype: "maaned", skattekort: "prosent", skatt_prosent: 30, skattekort_aar: 2026, yrkeskode: "2221104", ...b });
      expect(r.status, JSON.stringify(r.data)).toBe(201);
      return r.data.id as string;
    };
    ola = await ny({ fornavn: "Ola", etternavn: "Reise", epost: "ola.reise@server.test", maanedslonn: 40000, kontonr: "12345678903" });
    kari = await ny({ fornavn: "Kari", etternavn: "Rente", maanedslonn: 50000, kontonr: "86011117947" });
    const inv = (await kall("POST", `/api/org/${org}/ansatte/${ola}/inviter`)).data;
    expect((await kall("POST", "/api/invitasjoner/aksepter", { token: inv.lenke.split("/").pop() }, olaInn)).status).toBe(200);
    olaId = (await kall("GET", "/api/meg", undefined, olaInn)).data.bruker.id;
  });

  it("naturalytelsene på den ansatte: kontrollene, fordelen denne måneden, og den ansatte ser sine egne", async () => {
    const sti = `/api/org/${org}/ansatte/${ola}/naturalytelser`;
    expect((await kall("POST", sti, { type: "bil", fra: "2026-01-01" })).data.error).toBe("Skriv listeprisen for bilen som ny");
    expect((await kall("POST", sti, { type: "bil", listepris: 450000, fra: "2026-01-01" })).data.error).toBe("Skriv registreringsnummeret (eller velg bilpool)");
    expect((await kall("POST", sti, { type: "bolig", fra: "2026-01-01" })).data.error).toBe("Skriv beløpet per måned");
    const r = await kall("POST", sti, { type: "bil", listepris: 450000, regnr: "el 12345", fra: "2026-01-01", belop: 99 });
    expect(r.status, JSON.stringify(r.data)).toBe(201);
    expect(r.data).toEqual([expect.objectContaining({ type: "bil", regnr: "EL12345", belop: null, maaned: 10585.83, brukt: 0, beskrivelse: "Fri bil EL12345 (listepris 450 000 kr)" })]);
    expect((await kall("POST", `/api/org/${org}/ansatte/${kari}/naturalytelser`, { type: "rentefordel", laan: 200000, rente: 1, fra: "2026-01-01" })).status).toBe(201);
    expect((await kall("GET", sti, undefined, olaInn)).data).toHaveLength(1);
    expect((await kall("POST", sti, { type: "ek", fra: "2026-01-01" }, olaInn)).status).toBe(403);
    expect((await kall("GET", `/api/org/${org}/ansatte/${kari}/naturalytelser`, undefined, olaInn)).data).toEqual([]);
  });

  it("den ansatte fører reiseregningen, ser hva den gir, og sender den", async () => {
    const b = await kall("POST", `/api/org/${org}/reiser/beregn`, bergen, olaInn);
    expect(b.status, JSON.stringify(b.data)).toBe(200);
    expect(b.data).toMatchObject({ belop: 4222.2, trekkfritt: 2341, trekkpliktig: 431.2, utlegg: 1450 });
    expect((await kall("POST", `/api/org/${org}/reiser`, { ...bergen, til: "2026-10-05T07:00" }, olaInn)).data.error).toBe("Hjemkomsten er før avreisen");
    expect((await kall("POST", `/api/org/${org}/reiser`, { ...bergen, overnatting: "ingen" }, olaInn)).data.error).toBe("En dagsreise varer høyst et døgn (velg overnattingen)");
    expect((await kall("POST", `/api/org/${org}/reiser`, { ...bergen, nattillegg: true }, olaInn)).data.error).toBe(
      "Nattillegg gis bare for overnatting i Norge som ikke er på hotell",
    );
    expect((await kall("POST", `/api/org/${org}/reiser`, { ...bergen, ansatt_id: kari }, olaInn)).data.error).toBe("Du kan bare føre reiseregninger for deg selv");
    const r = await kall("POST", `/api/org/${org}/reiser`, bergen, olaInn);
    expect(r.status, JSON.stringify(r.data)).toBe(201);
    expect(r.data).toMatchObject({ status: "utkast", navn: "Ola Reise", formaal: "Kurs i lønn", fra: "2026-10-05T08:00", sum: 4222.2, beregning: null });
    expect(r.data.kjoring[0]).toMatchObject({ kjoretoy: "bil", km: 120, passasjerer: ["Per Hansen"], skogsvei: 0, tilhenger: false });
    reiseId = r.data.id;
    expect((await kall("POST", `/api/org/${org}/reiser/${reiseId}/send`, undefined, olaInn)).data.status).toBe("sendt");
    // Eieren får varsel om reiseregningen som venter.
    expect(varsler().at(-1)).toMatchObject({
      hendelse: "reiser",
      bruker_ider: [eierId],
      tittel: "Reiseregning til godkjenning",
      tekst: "Ola Reise: Bergen 5.–7.10, 4 222,20 kr.",
      url: `/lonn?fane=reiser&reise=${reiseId}`,
    });
    expect((await kall("POST", `/api/org/${org}/reiser/${reiseId}/godkjenn`, {}, olaInn)).status).toBe(403);
    // Lederen ser den blant dem som venter; den ansatte bare sine egne.
    expect((await kall("GET", `/api/org/${org}/reiser?status=sendt`)).data.reiser.map((x: any) => x.id)).toEqual([reiseId]);
    expect((await kall("GET", `/api/org/${org}/reiser`, undefined, olaInn)).data).toMatchObject({ satser: "staten", reiser: [{ id: reiseId }] });
  });

  it("lederen avviser med en grunn; den ansatte retter og sender igjen; lederen godkjenner", async () => {
    const sti = `/api/org/${org}/reiser/${reiseId}`;
    expect((await kall("POST", `${sti}/avvis`, { grunn: " " })).data.error).toBe("Skriv hvorfor reiseregningen avvises");
    expect((await kall("POST", `${sti}/avvis`, { grunn: "Legg ved kvitteringen for hotellet" })).data).toMatchObject({ status: "avvist", avvist_grunn: "Legg ved kvitteringen for hotellet" });
    expect(varsler().at(-1)).toMatchObject({ bruker_ider: [olaId], tittel: "Reiseregningen er avvist", tekst: "Bergen 5.–7.10: Legg ved kvitteringen for hotellet" });
    expect((await kall("PUT", sti, { ...bergen, merknad: "Kvitteringen er levert" }, olaInn)).data).toMatchObject({ status: "utkast", avvist_grunn: null, merknad: "Kvitteringen er levert" });
    await kall("POST", `${sti}/send`, undefined, olaInn);
    const g = await kall("POST", `${sti}/godkjenn`, {});
    expect(g.status, JSON.stringify(g.data)).toBe(200);
    expect(g.data).toMatchObject({ status: "godkjent", belop: 4222.2, sum: 4222.2, trekkfri: true, godkjent_av: expect.any(String) });
    expect(g.data.beregning.map((l: any) => l.lonnsart)).toEqual(["reise_kost_hotell", "reise_kost_trekk", "km_bil", "km_passasjer", "km_bil_trekk", "reise_utlegg"]);
    expect(varsler().at(-1)).toMatchObject({ hendelse: "reiser", bruker_ider: [olaId], tittel: "Reiseregningen er godkjent", tekst: "Bergen 5.–7.10: 4 222,20 kr utbetales med neste lønn." });
    expect((await kall("PUT", sti, bergen, olaInn)).data.error).toBe("Reiseregningen er godkjent og kan ikke endres");
  });

  it("lønnskjøringen betaler reisen og tar med naturalytelsene", async () => {
    const k = await kall("POST", `/api/org/${org}/lonn/kjoringer`, { periode: "2026-10" });
    expect(k.status, JSON.stringify(k.data)).toBe(201);
    okt = k.data.id;
    const o = slipp(k.data, ola);
    expect(radene(o)).toEqual([
      ["fastlonn", 40000],
      ["natural_bil", 10585.83],
      ["reise_kost_hotell", 1801],
      ["reise_kost_trekk", 215.2],
      ["km_bil", 420],
      ["km_passasjer", 120],
      ["km_bil_trekk", 216],
      ["reise_utlegg", 1450],
    ]);
    expect(o).toMatchObject({ brutto: 40000, naturalytelser: 10585.83, trekkpliktig: 51017.03, skattetrekk: 15305, utgifter: 4222.2, netto: 28917.2, aga_grunnlag: 51017.03 });
    expect(radene(slipp(k.data, kari))).toEqual([
      ["fastlonn", 50000],
      ["natural_rente", 616.67],
    ]);
    expect((await kall("POST", `/api/org/${org}/lonn/kjoringer/${okt}/godkjenn`)).data.status).toBe("godkjent");
    expect((await kall("GET", `/api/org/${org}/reiser/${reiseId}`)).data).toMatchObject({ lonnskjoring_id: okt, utbetalt_periode: "2026-10-01", utbetalt_dato: "2026-10-20" });
    expect((await kall("GET", `/api/org/${org}/reiser?status=utbetalt`)).data.reiser).toHaveLength(1);
    expect((await kall("POST", `/api/org/${org}/reiser/${reiseId}/apne`)).data.error).toBe("Reiseregningen er utbetalt");
    // Lønnsslippen som PDF (med naturalytelsene) for den ansatte.
    const pdf = await app.request(`/api/org/${org}/lonn/slipper/${slipp(k.data, ola).id}/pdf`, { headers: { authorization: olaInn } });
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
  });

  it("a-meldingen: fri bil med listeprisen, og reisene som utgiftsgodtgjørelse med antall", async () => {
    const g = await somSystem((db) => hentGrunnlag(db, org, "2026-10"));
    const m = byggLeveranse({ ...g, org: { navn: "Reise Test AS", orgnr: "915000282" }, virksomhet: "915000290" } as Grunnlag, {
      meldingsId: "a1b2c3d4-0000-4000-8000-000000000083",
      tidspunkt: "2026-11-03T09:00:00Z",
      fnr: (id) => (id === ola ? "13830197340" : "24880199664"),
    }) as any;
    const o = m.leveranse.oppgave.virksomhet[0].inntektsmottaker.find((x: any) => x.norskIdentifikator === "13830197340");
    const inntekt = o.inntekt.map((i: any) => [i.fordel, i.loennsinntekt.beskrivelse, i.utloeserArbeidsgiveravgift, i.inngaarIGrunnlagForTrekk, i.beloep, i.loennsinntekt.antall ?? null]);
    expect(inntekt).toEqual([
      ["kontantytelse", "fastloenn", true, true, "40000.00", null],
      ["naturalytelse", "bil", true, true, "10585.83", null],
      ["utgiftsgodtgjoerelse", "reiseKostMedOvernattingPaaHotell", false, false, "1801.00", "3"],
      ["utgiftsgodtgjoerelse", "reiseKost", true, true, "215.20", null],
      ["utgiftsgodtgjoerelse", "kilometergodtgjoerelseBil", false, false, "420.00", "120"],
      ["utgiftsgodtgjoerelse", "kilometergodtgjoerelsePassasjertillegg", false, false, "120.00", "120"],
      ["utgiftsgodtgjoerelse", "kilometergodtgjoerelseBil", true, true, "216.00", null],
    ]);
    expect(o.inntekt[1].loennsinntekt).toEqual({ beskrivelse: "bil", tilleggsinformasjon: { bilOgBaat: { listeprisForBil: "450000.00", bilregistreringsnummer: "EL12345" } } });
    const k = m.leveranse.oppgave.virksomhet[0].inntektsmottaker.find((x: any) => x.norskIdentifikator === "24880199664");
    expect(k.inntekt.map((i: any) => [i.fordel, i.loennsinntekt.beskrivelse, i.beloep])).toContainEqual(["naturalytelse", "rentefordelLaan", "616.67"]);
    valider(tilXml(m), "amelding_v2_3");
  });

  it("lønnsbilaget: reisene og naturalytelsene på egne kontoer", async () => {
    const b = (await kall("GET", `/api/org/${org}/lonn/kjoringer/${okt}/bokforing`)).data;
    const poster = (b.gjeldende ?? b.forslag).posteringer.map((p: any) => [p.konto, p.belop, p.tekst]);
    expect(poster).toContainEqual(["7100", 756, "Kilometergodtgjørelse"]);
    expect(poster).toContainEqual(["7150", 2016.2, "Diett og nattillegg"]);
    expect(poster).toContainEqual(["7140", 1450, "Utlegg på reise"]);
    expect(poster).toContainEqual(["5280", 11202.5, "Naturalytelser"]);
    expect(poster).toContainEqual(["5290", -11202.5, "Naturalytelser"]);
    expect(poster.some((p: any) => p[0] === "7790")).toBe(false);
  });

  it("neste måned: naturalytelsene igjen, men ikke reisen som er utbetalt", async () => {
    const k = (await kall("POST", `/api/org/${org}/lonn/kjoringer`, { periode: "2026-11" })).data;
    expect(radene(slipp(k, ola))).toEqual([
      ["fastlonn", 40000],
      ["natural_bil", 10585.83],
    ]);
    expect(slipp(k, kari).merknader).toContain("Normrenten for november 2026 er ikke lagt inn; 4,7 % er brukt for rentefordelen. Sjekk den på skatteetaten.no.");
    // Naturalytelsen er brukt: den avsluttes i stedet for å slettes.
    const n = (await kall("GET", `/api/org/${org}/ansatte/${ola}/naturalytelser`)).data[0];
    expect(n.brukt).toBe(1);
    expect((await kall("DELETE", `/api/org/${org}/ansatte/${ola}/naturalytelser/${n.id}`)).data[0]).toMatchObject({ til: "2026-10-31" });
  });

  it("rapportene «Reiser og godtgjørelser» og «Naturalytelser»", async () => {
    const r = await kall("GET", `/api/org/${org}/rapportmodul/lonn.reiser?fra=2026-10-01&til=2026-10-31`);
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data.rader).toEqual([
      { utbetalt: "2026-10-20", ansattnummer: "1", navn: "Ola Reise", reise: "Bergen – Kurs i lønn", dato: "05.10.2026–07.10.2026", km: 120, trekkfritt: 2341, trekkpliktig: 431.2, utlegg: 1450, sum: 4222.2 },
    ]);
    const n = await kall("GET", `/api/org/${org}/rapportmodul/lonn.naturalytelser?fra=2026-10-01&til=2026-10-31`);
    expect(n.data.rader.map((x: any) => [x.navn, x.ytelse, x.belop])).toEqual([
      ["Ola Reise", "Fri bil", 10585.83],
      ["Kari Rente", "Rentefordel lån", 616.67],
    ]);
  });
});
