// Årsoversikten (0075_lonn_aarsoversikt.sql, lonnAarsoversikt.ts): den ansatte ser sin egen
// (lønnen gruppert som i a-meldingen, utgifter og trekk, det som er utbetalt, tidligere
// lønnssystem og hver utbetaling, også som PDF), men ikke andres; lederen ser de ansatte i året og
// laster ned alle i én PDF, og varsler de ansatte. Den daglige jobben varsler i januar (når ingen
// kjøring står som utkast, senest 25. januar), og plattformadministratorene minnes på
// trekktabellene som mangler.
import { beforeAll, describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { config } from "../src/config.js";
import { lagApi } from "../src/api.js";
import { settLokalOppgavekjorer, type Oppgave } from "../src/tjenester.js";
import { varsleAarsoversikter } from "../src/lonnAarsoversikt.js";
import { trekktabellAar, varsleTrekktabeller } from "../src/trekktabeller.js";

describe.skipIf(!process.env.DATABASE_URL)("årsoversikten", () => {
  const app = lagApi();
  const eier = "Bearer test:uid-aar-eier:aar-eier@server.test:mfa";
  const kariT = "Bearer test:uid-aar-kari:kari.aar@server.test";
  const ko: Oppgave[] = [];
  let org: string;
  let kari: string;
  let per: string;
  let kariBruker: string;
  let nov: any;

  const kall = async (m: string, sti: string, k?: unknown, hvem = eier) => {
    const r = await app.request(sti, { method: m, headers: { authorization: hvem, "content-type": "application/json" }, body: k === undefined ? undefined : JSON.stringify(k) });
    const type = r.headers.get("content-type") ?? "";
    return {
      status: r.status,
      type,
      data: type.includes("json") ? ((await r.json()) as any) : type.includes("pdf") ? new Uint8Array(await r.arrayBuffer()) : await r.text(),
    };
  };
  const varsler = (o: string) =>
    ko.filter((x: any) => x.type === "varsel" && x.varsel.org_id === o && x.varsel.tittel.startsWith("Årsoversikten")).map((x: any) => x.varsel);

  beforeAll(async () => {
    settLokalOppgavekjorer(async (o) => {
      ko.push(o);
    });
    if (!config.adminEposter.includes("aar-admin@server.test")) config.adminEposter.push("aar-admin@server.test");
    org = (await kall("POST", "/api/organisasjoner", { navn: "Årsoversikt Test AS" })).data.id;
    expect((await kall("PUT", `/api/org/${org}/lonn-oppsett`, { aktiv: true })).status).toBe(200);
    const ny = async (k: Record<string, unknown>) => {
      const r = await kall("POST", `/api/org/${org}/ansatte`, { ansatt_fra: "2025-01-01", ...k });
      expect(r.status, JSON.stringify(r.data)).toBe(201);
      return r.data.id as string;
    };
    kari = await ny({
      fornavn: "Kari",
      etternavn: "Årsen",
      lonnstype: "maaned",
      maanedslonn: 50000,
      kontonr: "86011117947",
      skattekort: "prosent",
      skatt_prosent: 30,
      skattekort_aar: 2026,
      epost: "kari.aar@server.test",
      adresse: "Storgata 1",
      postnr: "0155",
      poststed: "Oslo",
    });
    per = await ny({ fornavn: "Per", etternavn: "Uten", lonnstype: "time", timelonn: 200, skattekort: "tabell", skatt_tabell: 7100, skatt_prosent: 30, skattekort_aar: 2026 });
    const inv = await kall("POST", `/api/org/${org}/ansatte/${kari}/inviter`);
    expect((await kall("POST", "/api/invitasjoner/aksepter", { token: inv.data.lenke.split("/").pop() }, kariT)).status).toBe(200);
    kariBruker = (await kall("GET", "/api/meg", undefined, kariT)).data.bruker.id;
    expect((await kall("PUT", `/api/org/${org}/lonn/inngaende/${kari}/2026`, { trekkpliktig: 100000, forskuddstrekk: 30000, feriepengegrunnlag: 100000 })).status).toBe(204);

    // November: Karis fastlønn med bonus, utgift og trekk etter skatt, og timer for Per; godkjent.
    nov = (await kall("POST", `/api/org/${org}/lonn/kjoringer`, { periode: "2026-11" })).data;
    const linje = (b: Record<string, unknown>) => kall("POST", `/api/org/${org}/lonn/kjoringer/${nov.id}/linjer`, b);
    expect((await linje({ ansatt_id: kari, lonnsart: "bonus", tekst: "Bonus", belop: 1000 })).status).toBe(200);
    expect((await linje({ ansatt_id: kari, lonnsart: "utgift", tekst: "Telefon", belop: 500 })).status).toBe(200);
    expect((await linje({ ansatt_id: kari, lonnsart: "trekk_etter_skatt", tekst: "Kantine", belop: 200 })).status).toBe(200);
    expect((await linje({ ansatt_id: per, lonnsart: "timelonn", tekst: "Timelønn", antall: 10, sats: 200 })).status).toBe(200);
    nov = (await kall("POST", `/api/org/${org}/lonn/kjoringer/${nov.id}/godkjenn`)).data;
    expect(nov.status).toBe("godkjent");
    // Desember står som utkast.
    expect((await kall("POST", `/api/org/${org}/lonn/kjoringer`, { periode: "2026-12" })).status).toBe(201);
  });

  it("den ansatte ser sin egen årsoversikt, også som PDF", async () => {
    expect((await kall("GET", `/api/org/${org}/lonn/aarsoversikt`, undefined, kariT)).data).toEqual({ ansatt_id: kari, aar: [2026] });
    const s = nov.slipper.find((x: any) => x.ansatt_id === kari);
    const a = (await kall("GET", `/api/org/${org}/lonn/aarsoversikt/2026`, undefined, kariT)).data;
    expect(a).toMatchObject({
      aar: 2026,
      ansatt_id: kari,
      navn: "Kari Årsen",
      inntekter: [
        { kode: "fastloenn", navn: "Fastlønn", belop: 50000 },
        { kode: "bonus", navn: "Bonus", belop: 1000 },
      ],
      utgifter: [{ navn: "Telefon", belop: 500 }],
      trekk: [{ navn: "Kantine", belop: -200 }],
      sum: { brutto: 51000, skattetrekk: s.skattetrekk, utgifter: 500, trekk_etter_skatt: -200, netto: s.netto, feriepengegrunnlag: s.feriepengegrunnlag },
      maaneder: [{ periode: "2026-11-01", utbetalingsdato: nov.utbetalingsdato, brutto: 51000, skattetrekk: s.skattetrekk, netto: s.netto }],
      tidligere: { trekkpliktig: 100000, forskuddstrekk: 30000, feriepengegrunnlag: 100000, feriepenger_utbetalt: 0 },
    });
    // Utkastet for desember er ikke med, og et år uten lønn finnes ikke.
    expect(a.maaneder).toHaveLength(1);
    expect((await kall("GET", `/api/org/${org}/lonn/aarsoversikt/2025`, undefined, kariT)).data.error).toBe("Fant ingen lønn i 2025");

    const pdf = await kall("GET", `/api/org/${org}/lonn/aarsoversikt/2026/pdf`, undefined, kariT);
    expect(pdf.status).toBe(200);
    expect(pdf.type).toBe("application/pdf");
    const doc = await PDFDocument.load(pdf.data as Uint8Array);
    expect(doc.getPageCount()).toBe(1);
    expect(doc.getTitle()).toBe("Årsoversikt 2026 – Kari Årsen");
  });

  it("den ansatte ser ikke andres årsoversikt, og ikke lederens liste", async () => {
    expect((await kall("GET", `/api/org/${org}/lonn/aarsoversikt?ansatt=${per}`, undefined, kariT)).status).toBe(403);
    expect((await kall("GET", `/api/org/${org}/lonn/aarsoversikt/2026?ansatt=${per}`, undefined, kariT)).status).toBe(403);
    expect((await kall("GET", `/api/org/${org}/lonn/aarsoversikt/2026/pdf?ansatt=alle`, undefined, kariT)).status).toBe(403);
    expect((await kall("GET", `/api/org/${org}/lonn/aarsoversikt/2026/ansatte`, undefined, kariT)).status).toBe(403);
    expect((await kall("POST", `/api/org/${org}/lonn/aarsoversikt/2026/varsle`, undefined, kariT)).status).toBe(403);
    // Eieren er ikke ansatt selv.
    expect((await kall("GET", `/api/org/${org}/lonn/aarsoversikt`)).data.error).toBe("Du er ikke registrert som ansatt");
  });

  it("lederen ser de ansatte i året, en ansatt og alle i én PDF", async () => {
    const l = (await kall("GET", `/api/org/${org}/lonn/aarsoversikt/2026/ansatte`)).data;
    expect(l).toMatchObject({
      aar: 2026,
      aar_liste: [2026],
      utkast: 1,
      varslet: null,
      ansatte: [
        { ansatt_id: kari, navn: "Kari Årsen", brutto: 51000, innlogging: true },
        { ansatt_id: per, navn: "Per Uten", brutto: 2000, innlogging: false },
      ],
    });
    expect((await kall("GET", `/api/org/${org}/lonn/aarsoversikt/2026?ansatt=${per}`)).data).toMatchObject({
      navn: "Per Uten",
      inntekter: [{ kode: "timeloenn", navn: "Timelønn", belop: 2000 }],
      tidligere: null,
    });
    const pdf = await kall("GET", `/api/org/${org}/lonn/aarsoversikt/2026/pdf?ansatt=alle`);
    expect(pdf.status).toBe(200);
    const doc = await PDFDocument.load(pdf.data as Uint8Array);
    expect(doc.getPageCount()).toBe(2);
    expect(doc.getTitle()).toBe("Årsoversikter 2026");
    expect((await kall("GET", `/api/org/${org}/lonn/aarsoversikt/2025/pdf?ansatt=alle`)).data.error).toBe("Ingen lønn er godkjent med utbetaling i 2025");
  });

  it("den daglige jobben varsler i januar, når ingen kjøring står som utkast eller senest 25. januar", async () => {
    await varsleAarsoversikter("2027-01-09");
    await varsleAarsoversikter("2027-01-10");
    expect(varsler(org)).toEqual([]);
    await varsleAarsoversikter("2027-01-25");
    expect(varsler(org)).toEqual([
      expect.objectContaining({ hendelse: "lonn", bruker_ider: [kariBruker], tittel: "Årsoversikten for 2026 er klar", url: "/lonn?fane=mine&aar=2026" }),
    ]);
    // Én gang.
    await varsleAarsoversikter("2027-01-26");
    expect(varsler(org)).toHaveLength(1);
    expect((await kall("GET", `/api/org/${org}/lonn/aarsoversikt/2026/ansatte`)).data.varslet).toMatchObject({ antall: 1, varslet_av: null });

    // Lederen varsler på nytt.
    expect((await kall("POST", `/api/org/${org}/lonn/aarsoversikt/2026/varsle`)).data).toEqual({ antall: 1 });
    expect(varsler(org)).toHaveLength(2);
    expect((await kall("GET", `/api/org/${org}/lonn/aarsoversikt/2026/ansatte`)).data.varslet).toMatchObject({ antall: 1, varslet_av: "aar-eier@server.test" });
  });

  it("plattformadministratorene minnes på trekktabellene som mangler", async () => {
    // Mandager fra 10. desember (neste år) og i januar (året).
    expect(trekktabellAar("2026-12-07")).toBe(null);
    expect(trekktabellAar("2026-12-14")).toBe(2027);
    expect(trekktabellAar("2026-12-15")).toBe(null);
    expect(trekktabellAar("2027-01-04")).toBe(2027);
    expect(trekktabellAar("2027-02-01")).toBe(null);

    expect(await varsleTrekktabeller("2026-12-15")).toBe(null);
    expect(await varsleTrekktabeller("2026-12-14")).toBe(2027);
    const e = ko.filter((x: any) => x.type === "epost" && x.emne === "Trekktabellene for 2027 er ikke lastet inn") as any[];
    expect(e).toHaveLength(1);
    expect(e[0].til).toContain("aar-admin@server.test");
    expect(e[0].tekst).toContain("Administrasjon → Drift → Trekktabeller");
  });
});
