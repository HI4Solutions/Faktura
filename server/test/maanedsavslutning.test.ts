// Månedsavslutningen går av seg selv (maanedsavslutning.ts, 0092_maanedsavslutning.sql): ikke før kl.
// 08; avskrivningene og periodiseringene for måneden som er over bokføres (én gang), sjekklisten
// (bankpostene, utgiftene, lønnen, avskrivningene og periodiseringene) lagres og varsles; det som
// ikke er bokført fra før automatikken gikk første gang, stopper den; den kan slås av; sjekklisten og
// avslutningen i appen, rapporten, og tilgangen. Månedene regnes fra i dag (forrige måned).
import { beforeAll, describe, expect, it } from "vitest";
import { lagApi } from "../src/api.js";
import { plussMnd } from "../src/anlegg.js";
import { en, somSystem } from "../src/db.js";
import { avsluttMaanederForAlle, forrigeMaaned, perioden, varseltekst, type Avslutning } from "../src/maanedsavslutning.js";
import { settLokalOppgavekjorer, type Oppgave } from "../src/tjenester.js";

const osloDag = () => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Oslo" }).format(new Date());

describe("månedsavslutningen: tekstene", () => {
  it("perioden, forrige måned og varselet", () => {
    expect(perioden(["2026-09"])).toBe("september 2026");
    expect(perioden(["2026-03", "2026-04", "2026-09"])).toBe("mars–september 2026");
    expect(perioden(["2025-11", "2026-01"])).toBe("november 2025–januar 2026");
    expect(forrigeMaaned("2026-10-10")).toBe("2026-09");
    expect(forrigeMaaned("2026-01-01")).toBe("2025-12");
    const punkt = (ok: boolean, tekst: string) => ({ nokkel: "bank" as const, navn: "Bankpostene", ok, tekst, lenke: "/regnskap?fane=bank" });
    const a: Avslutning = {
      maaned: "2026-09",
      bilag: [
        { id: "a", bilagsnummer: "A-2026-9", tekst: "Avskrivninger", sum: 1000 },
        { id: "p", bilagsnummer: "P-2026-4", tekst: "Periodiseringer", sum: 500 },
      ],
      sperret: null,
      punkter: [punkt(false, "3 bankposter er ikke ført."), punkt(true, "Utgiftene er bokført."), punkt(false, "Lønnskjøringen er ikke godkjent.")],
    };
    expect(varseltekst(a)).toBe("Bokført: A-2026-9 og P-2026-4. Gjenstår: 3 bankposter er ikke ført; lønnskjøringen er ikke godkjent.");
    expect(varseltekst({ ...a, bilag: [], punkter: [punkt(true, "Alle bankpostene er ført.")] })).toBe("Alt er ført.");
    expect(varseltekst({ ...a, bilag: [], sperret: "x", punkter: [] })).toBe(
      "Avskrivningene og periodiseringene ble ikke bokført av seg selv: noe fra før er ikke bokført. Alt er ført.",
    );
  });
});

describe.skipIf(!process.env.DATABASE_URL)("månedsavslutningen i appen", () => {
  const app = lagApi();
  const eier = "Bearer test:uid-mavsl-eier:mavsl-eier@server.test:mfa";
  const fakturerer = "Bearer test:uid-mavsl-fakt:mavsl-fakt@server.test:mfa";
  const iDag = osloDag();
  const M = forrigeMaaned(iDag);
  const M1 = plussMnd(M, -1);
  const sisteDag = (m: string) => {
    const [a, b] = m.split("-").map(Number) as [number, number];
    return `${m}-${String(new Date(Date.UTC(a, b, 0)).getUTCDate()).padStart(2, "0")}`;
  };
  // Kl. 06–07 og 11–12 norsk tid i dag.
  const morgen = new Date(`${iDag}T05:00:00Z`);
  const formiddag = new Date(`${iDag}T10:00:00Z`);
  const oppgaver: Oppgave[] = [];
  let org = "";
  let org2 = "";
  let org3 = "";

  const kall = async (metode: string, sti: string, kropp?: unknown, hvem = eier) => {
    const r = await app.request(sti, {
      method: metode,
      headers: { authorization: hvem, "content-type": "application/json" },
      body: kropp === undefined ? undefined : JSON.stringify(kropp),
    });
    return { status: r.status, data: (r.headers.get("content-type") ?? "").includes("json") ? ((await r.json()) as any) : null };
  };
  const ok = async (metode: string, sti: string, kropp?: unknown) => {
    const r = await kall(metode, sti, kropp);
    expect(r.status, `${metode} ${sti}: ${JSON.stringify(r.data)}`).toBeLessThan(300);
    return r.data;
  };
  const nyOrg = async (navn: string) => (await ok("POST", "/api/organisasjoner", { navn })).id as string;
  const anlegg = (o: string, anskaffet: string) => ok("POST", `/api/org/${o}/regnskap/anleggsmidler`, { navn: "PC-er", kategori: "kontormaskiner", anskaffet, kostpris: 36000, levetid_mnd: 36 });

  beforeAll(async () => {
    settLokalOppgavekjorer(async (o) => void oppgaver.push(o));
    org = await nyOrg("Månedsslutt AS");
    const inv = await ok("POST", `/api/org/${org}/invitasjoner`, { epost: "mavsl-fakt@server.test", rolle: "fakturerer" });
    expect((await kall("POST", "/api/invitasjoner/aksepter", { token: inv.lenke.split("/").pop() }, fakturerer)).status).toBe(200);
    // Et anleggsmiddel og en periodisering fra forrige måned, en utgift som ikke er bokført, en
    // lønnskjøring som ikke er godkjent og en bankpost som ikke er ført.
    await anlegg(org, `${M}-03`);
    await ok("POST", `/api/org/${org}/regnskap/periodiseringer`, { navn: "Strøm", type: "paalopt_kostnad", belop: 3000, fra: M, antall_maaneder: 3, resultatkonto: "7700" });
    await ok("POST", `/api/org/${org}/regnskap/utgifter`, {
      type: "kvittering",
      leverandor: "Clas Ohlson AS",
      dato: `${M}-24`,
      belop: 499,
      betaling: "bank",
      linjer: [{ kategori: "forbruk", konto: "6560", belop: 399.2, mva_sats: 25, mva: 99.8 }],
    });
    await ok("PUT", `/api/org/${org}/lonn-oppsett`, { aktiv: true, skatt_kontonr: "63450635008" });
    await ok("POST", `/api/org/${org}/ansatte`, { fornavn: "Ingrid", etternavn: "Sekretær", ansatt_fra: "2025-01-01", lonnstype: "maaned", maanedslonn: 50000, skattekort: "prosent", skatt_prosent: 30 });
    await ok("POST", `/api/org/${org}/lonn/kjoringer`, { periode: M });
    await somSystem((db) =>
      db.query("insert into faktura.bankposter (org_id, konto, ekstern_id, dato, belop, melding) values ($1, '86011117947', 'gebyr', $2, -45, 'Gebyr')", [org, `${M}-15`]),
    );
  });

  it("sjekklisten for forrige måned, og ingenting før kl. 08", async () => {
    expect(await avsluttMaanederForAlle(morgen, 25, org)).toEqual({ avsluttet: 0, ferdig: false });
    const s = await ok("GET", `/api/org/${org}/regnskap/maanedsstatus`);
    expect(s).toMatchObject({ maaned: M, over: true, auto: true, avslutning: null });
    expect(s.punkter.map((p: any) => [p.nokkel, p.ok, p.tekst])).toEqual([
      ["bank", false, "1 bankpost er ikke ført."],
      ["utgifter", false, "1 utgift er ikke bokført."],
      ["lonn", false, "Lønnskjøringen er ikke godkjent."],
      ["avskrivninger", false, `Avskrivningene for ${perioden([M])} er ikke bokført.`],
      ["periodiseringer", false, `Periodiseringene for ${perioden([M])} er ikke bokført.`],
    ]);
    expect((await kall("GET", `/api/org/${org}/regnskap/maanedsstatus?maaned=${plussMnd(M, 2)}`)).data.error).toBe("Måneden kan ikke være fram i tid");
    expect((await kall("GET", `/api/org/${org}/regnskap/maanedsstatus`, undefined, fakturerer)).status).toBe(403);
  });

  it("bokfører avskrivningene og periodiseringene, lagrer sjekklisten og varsler, én gang", async () => {
    oppgaver.length = 0;
    expect(await avsluttMaanederForAlle(formiddag, 25, org)).toEqual({ avsluttet: 1, ferdig: true });
    const b = await ok("GET", `/api/org/${org}/regnskap/bilag?fra=${M}-01&til=${sisteDag(M)}`);
    const bokfort = b.bilag.filter((x: any) => x.kilde === "anlegg" || x.kilde === "periodisering");
    const sum = (x: any) => x.posteringer.filter((p: any) => p.belop > 0).reduce((a: number, p: any) => a + p.belop, 0);
    expect(bokfort.map((x: any) => [x.bilagsnummer.slice(0, 1), x.dato, sum(x)])).toEqual([
      ["A", sisteDag(M), 1000],
      ["P", sisteDag(M), 1000],
    ]);
    const rad = await somSystem((db) =>
      en<{ varslet: boolean; sperret: string | null; antall: number; fra: string }>(
        db,
        `select m.varslet, m.sperret, cardinality(m.bilag) as antall, to_char(r.maaned_fra, 'YYYY-MM') as fra
           from faktura.maanedsavslutninger m join faktura.regnskap_oppsett r using (org_id) where m.org_id = $1 and m.maaned = $2::date`,
        [org, `${M}-01`],
      ),
    );
    expect(rad).toEqual({ varslet: true, sperret: null, antall: 2, fra: M });
    const varsel = oppgaver.find((o) => o.type === "varsel") as Extract<Oppgave, { type: "varsel" }>;
    expect(varsel.varsel).toMatchObject({ hendelse: "regnskap", org_id: org, tittel: `Månedsavslutningen for ${perioden([M])}`, url: "/regnskap?fane=bilag" });
    expect(varsel.varsel.tekst).toBe(
      `Bokført: ${bokfort.map((x: any) => x.bilagsnummer).join(" og ")}. Gjenstår: 1 bankpost er ikke ført; 1 utgift er ikke bokført; lønnskjøringen er ikke godkjent.`,
    );
    // Én gang: neste hjerteslag gjør ingenting.
    oppgaver.length = 0;
    expect(await avsluttMaanederForAlle(formiddag, 25, org)).toEqual({ avsluttet: 0, ferdig: true });
    expect(oppgaver).toEqual([]);
    const s = await ok("GET", `/api/org/${org}/regnskap/maanedsstatus`);
    expect(s.avslutning).toMatchObject({ sperret: null, bilag: bokfort.map((x: any) => ({ id: x.id, bilagsnummer: x.bilagsnummer })) });
    expect(s.punkter.filter((p: any) => p.ok).map((p: any) => [p.nokkel, p.tekst])).toEqual([
      ["avskrivninger", "Avskrivningene er bokført."],
      ["periodiseringer", "Periodiseringene er bokført."],
    ]);
  });

  it("lønnen: godkjent og bokført, men a-meldingen er ikke levert", async () => {
    const k = (await ok("GET", `/api/org/${org}/lonn/kjoringer`)).find((x: any) => x.periode.startsWith(M) && x.type === "ordinar");
    expect(k, "kjøringen for måneden").toBeTruthy();
    await ok("PUT", `/api/org/${org}/lonn/kjoringer/${k.id}/forskuddstrekk-kid`, { kid: "0012345678905260917" });
    await ok("POST", `/api/org/${org}/lonn/kjoringer/${k.id}/godkjenn`);
    const lonn = (await ok("GET", `/api/org/${org}/regnskap/maanedsstatus`)).punkter.find((p: any) => p.nokkel === "lonn");
    expect(lonn.ok).toBe(false);
    expect(lonn.tekst).toMatch(/^A-meldingen er ikke levert( ennå)? \(fristen (var|er) \d{2}\.\d{2}\.\d{4}\)\.$/);
    expect(lonn.lenke).toBe("/lonn?fane=amelding");
  });

  it("rapporten: sjekklisten for hver måned i perioden, og når den gikk av seg selv", async () => {
    const r = await ok("GET", `/api/org/${org}/rapportmodul/regnskap.maanedsavslutning?fra=${M}-01&til=${sisteDag(M)}`);
    expect(r.rader.map((x: any) => [x.punkt, x.status])).toEqual([
      ["Bankpostene", "Gjenstår"],
      ["Utgiftene", "Gjenstår"],
      ["Lønnen", "Gjenstår"],
      ["Avskrivningene", "Ført"],
      ["Periodiseringene", "Ført"],
    ]);
    expect(r.merknad).toMatch(new RegExp(`^${perioden([M]).replace(/^./, (c) => c.toUpperCase())}: gikk av seg selv \\d{2}\\.\\d{2}\\.\\d{4} \\(bokført [AP]-\\d{4}-\\d+ og [AP]-\\d{4}-\\d+\\); 3 punkter gjenstår\\.$`));
  });

  it("det som ikke er bokført fra før, stopper automatikken, og den kan slås av", async () => {
    org2 = await nyOrg("Etterslep AS");
    await anlegg(org2, `${M1}-05`);
    oppgaver.length = 0;
    expect(await avsluttMaanederForAlle(formiddag, 25, org2)).toEqual({ avsluttet: 1, ferdig: true });
    const s = await ok("GET", `/api/org/${org2}/regnskap/maanedsstatus`);
    expect(s.avslutning).toMatchObject({ bilag: [], sperret: `Avskrivningene eller periodiseringene for ${perioden([M1])} er ikke bokført. Bokfør dem under Regnskap → Bilag (månedsavslutningen); da går den av seg selv igjen.` });
    expect(s.punkter).toEqual([
      { nokkel: "avskrivninger", navn: "Avskrivningene", ok: false, tekst: `Avskrivningene for ${perioden([M1, M])} er ikke bokført.`, lenke: "/regnskap?fane=anlegg" },
    ]);
    expect((oppgaver[0] as any)?.varsel?.tekst).toBe(
      `Avskrivningene og periodiseringene ble ikke bokført av seg selv: noe fra før er ikke bokført. Gjenstår: avskrivningene for ${perioden([M1, M])} er ikke bokført.`,
    );
    // Brukeren bokfører dem.
    const m = await ok("POST", `/api/org/${org2}/regnskap/maanedsavslutning`, { til: M });
    expect(m.bilag.map((x: any) => x.dato)).toEqual([sisteDag(M1), sisteDag(M)]);

    // Slått av: ingenting skjer.
    org3 = await nyOrg("Manuell AS");
    await anlegg(org3, `${M}-02`);
    expect((await ok("PUT", `/api/org/${org3}/regnskap/oppsett`, { maaned_auto: false })).maaned_auto).toBe(false);
    expect((await ok("GET", `/api/org/${org3}/regnskap/maanedsavslutning`)).auto).toBe(false);
    expect(await avsluttMaanederForAlle(formiddag, 25, org3)).toEqual({ avsluttet: 0, ferdig: true });
    expect((await ok("GET", `/api/org/${org3}/regnskap/maanedsstatus`)).avslutning).toBe(null);
  });
});
