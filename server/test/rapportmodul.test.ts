// Rapportmodulen (0070_rapportmodul.sql, rapportmodul.ts): valgene og periodene, rapportene etter
// funksjon og rolle, rapportene for Faktura, Personal og Lønn som tabell, CSV og PDF, oppsettet
// for utsending (totrinn, bare eier og administrator, varsel til eierne), utsending på e-post med
// vedlegg, lønnsrapportene når en kjøring godkjennes, og månedsrapportene den 1.
import { beforeAll, describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { config } from "../src/config.js";
import { lagApi } from "../src/api.js";
import { alle, en, somSystem } from "../src/db.js";
import { settEpost, settLokalOppgavekjorer, type EpostMelding, type Oppgave } from "../src/tjenester.js";
import { kjorOppgave, varsleRapportmottakere } from "../src/worker.js";
import { lagValg, periodeTekst, planleggMaanedsrapporter, rapport, RAPPORTER, termin, type Valg } from "../src/rapportmodul.js";

describe("rapportmodulen: valg og perioder", () => {
  const def = (id: string) => rapport(id)!;

  it("standardvalgene er denne måneden, terminen og året, og perioden kan være høyst tre år", () => {
    expect(lagValg(def("faktura.journal"), {}, "2026-10-09")).toEqual({ fra: "2026-10-01", til: "2026-10-31", aar: 2026, termin: 5, kjoring: null });
    expect(lagValg(def("faktura.journal"), { fra: "2026-02-03", til: "2026-02-10" }, "2026-10-09")).toMatchObject({ fra: "2026-02-03", til: "2026-02-10" });
    expect(lagValg(def("faktura.mva"), {}, "2026-10-09")).toMatchObject({ fra: "2026-09-01", til: "2026-10-31", aar: 2026, termin: 5 });
    expect(lagValg(def("faktura.mva"), { aar: 2025, termin: 1 }, "2026-10-09")).toMatchObject({ fra: "2025-01-01", til: "2025-02-28" });
    expect(termin(2028, 1)).toEqual({ fra: "2028-01-01", til: "2028-02-29" });
    expect(termin(2026, 6)).toEqual({ fra: "2026-11-01", til: "2026-12-31" });
    expect(lagValg(def("faktura.salg"), { aar: 2025 }, "2026-10-09")).toMatchObject({ fra: "2025-01-01", til: "2025-12-31", aar: 2025 });
    expect(lagValg(def("faktura.reskontro"), {}, "2026-10-09")).toMatchObject({ fra: "2026-10-09", til: "2026-10-09" });
    expect(lagValg(def("lonn.journal"), { kjoring: "6f1c1d1e-0000-4000-8000-000000000001" }, "2026-10-09").kjoring).toBe("6f1c1d1e-0000-4000-8000-000000000001");
    expect(() => lagValg(def("faktura.journal"), { fra: "2026-10-10", til: "2026-10-01" })).toThrow("Til-datoen er før fra-datoen");
    expect(() => lagValg(def("faktura.journal"), { fra: "2020-01-01", til: "2026-01-01" })).toThrow("Perioden kan være høyst tre år");
  });

  it("teksten for perioden", () => {
    const v = (x: Partial<Valg>): Valg => ({ fra: "", til: "", aar: 2026, termin: 3, kjoring: null, ...x });
    expect(periodeTekst("periode", v({ fra: "2026-10-01", til: "2026-10-31" }))).toBe("oktober 2026");
    expect(periodeTekst("periode", v({ fra: "2026-02-01", til: "2026-02-28" }))).toBe("februar 2026");
    expect(periodeTekst("periode", v({ fra: "2026-01-01", til: "2026-12-31" }))).toBe("2026");
    expect(periodeTekst("periode", v({ fra: "2026-10-01", til: "2026-10-15" }))).toBe("01.10.2026–15.10.2026");
    expect(periodeTekst("termin", v({}))).toBe("3. termin 2026 (mai–juni)");
    expect(periodeTekst("aar", v({}))).toBe("2026");
    expect(periodeTekst("ingen", v({ fra: "2026-10-09", til: "2026-10-09" }))).toBe("per 09.10.2026");
  });

  it("hver rapport har en unik id med modulen foran, og månedsrapportene finnes", () => {
    const ider = RAPPORTER.map((r) => r.id);
    expect(new Set(ider).size).toBe(ider.length);
    for (const r of RAPPORTER) {
      expect(r.id).toMatch(/^[a-z_]+\.[a-z_0-9]+$/); // som i rutene
      expect(r.id.startsWith(`${r.modul}.`)).toBe(true);
    }
    expect(RAPPORTER.filter((r) => r.maanedlig).map((r) => r.id)).toEqual(
      expect.arrayContaining(["faktura.journal", "faktura.mva", "personal.timer", "lonn.journal", "lonn.lonnsarter", "lonn.skatt_aga", "lonn.avstemming", "lonn.nav_refusjoner", "regnskap.avskrivninger"]),
    );
  });
});

describe.skipIf(!process.env.DATABASE_URL)("rapportmodulen", () => {
  const app = lagApi();
  const eier = "Bearer test:uid-rapp-eier:rapp-eier@server.test:mfa";
  const eierUtenMfa = "Bearer test:uid-rapp-eier:rapp-eier@server.test";
  const regnskap = "Bearer test:uid-rapp-regn:rapp-regn@server.test:mfa";
  const fakturerer = "Bearer test:uid-rapp-fakt:rapp-fakt@server.test:mfa";
  const ola = "Bearer test:uid-rapp-ola:ola.rapp@server.test";
  const admin = "Bearer test:uid-rapp-admin:rapp-admin@server.test:mfa";
  const ko: (Oppgave & { oppgave_id: string })[] = [];
  const sendt: EpostMelding[] = [];
  let org: string;
  let kari: string;
  let olaId: string;
  let kjoring: string;

  const kall = async (m: string, sti: string, k?: unknown, hvem = eier) => {
    const r = await app.request(sti, { method: m, headers: { authorization: hvem, "content-type": "application/json" }, body: k === undefined ? undefined : JSON.stringify(k) });
    const type = r.headers.get("content-type") ?? "";
    return {
      status: r.status,
      type,
      disposisjon: r.headers.get("content-disposition"),
      data: type.includes("json") ? ((await r.json()) as any) : type.includes("pdf") ? new Uint8Array(await r.arrayBuffer()) : await r.text(),
    };
  };
  const moduler = async (hvem = eier) => {
    const r = await kall("GET", `/api/org/${org}/rapportmodul`, undefined, hvem);
    expect(r.status).toBe(200);
    return Object.fromEntries(r.data.moduler.map((m: any) => [m.id, m.rapporter.map((x: any) => x.id)]));
  };
  const mine = (type: string) => ko.filter((o) => o.type === type && (o as any).org_id === org);
  const tom = () => {
    ko.length = 0;
    sendt.length = 0;
  };

  beforeAll(async () => {
    settLokalOppgavekjorer(async (o) => void ko.push(o));
    settEpost({
      async send(m) {
        sendt.push(m);
        return { id: `epost-${sendt.length}` };
      },
    });
    config.adminEposter.push("rapp-admin@server.test");
    org = (await kall("POST", "/api/organisasjoner", { navn: "Rapport Test AS" })).data.id;
    expect((await kall("PATCH", `/api/org/${org}`, { kontonr: "86011117947", epost: "post@rapport-test.no", mva_registrert: true })).status).toBe(200);
    expect((await kall("PUT", `/api/org/${org}/lonn-oppsett`, { aktiv: true })).status).toBe(200);
    for (const [epost, rolle, hvem] of [
      ["rapp-regn@server.test", "regnskap", regnskap],
      ["rapp-fakt@server.test", "fakturerer", fakturerer],
    ] as const) {
      const inv = await kall("POST", `/api/org/${org}/invitasjoner`, { epost, rolle });
      expect((await kall("POST", "/api/invitasjoner/aksepter", { token: inv.data.lenke.split("/").pop() }, hvem)).status).toBe(200);
    }

    // Faktura: en kunde, en utstedt faktura i oktober og en betaling.
    const kunde = (await kall("POST", `/api/org/${org}/kunder`, { navn: "Kunde AS", epost: "kunde@kunde.no", orgnr: "974760673" })).data.id;
    const f = await kall("POST", `/api/org/${org}/fakturaer`, {
      kunde_id: kunde,
      fakturadato: "2026-10-02",
      forfallsdato: "2026-10-16",
      linjer: [{ beskrivelse: "Konsulenttimer", antall: 10, enhetspris: 1000, mva_sats: 25 }],
    });
    expect(f.status, JSON.stringify(f.data)).toBe(201);
    expect((await kall("POST", `/api/org/${org}/fakturaer/${f.data.id}/utsted`, {})).status).toBe(200);

    // Personal og lønn: Kari med fastlønn og Ola med timer (logger inn selv).
    const ny = async (k: Record<string, unknown>) => {
      const r = await kall("POST", `/api/org/${org}/ansatte`, { ansatt_fra: "2025-01-01", ...k });
      expect(r.status, JSON.stringify(r.data)).toBe(201);
      return r.data.id as string;
    };
    kari = await ny({ fornavn: "Kari", etternavn: "Fast", lonnstype: "maaned", maanedslonn: 50000, kontonr: "86011117947", skattekort: "prosent", skatt_prosent: 30, skattekort_aar: 2026 });
    olaId = await ny({ fornavn: "Ola", etternavn: "Time", lonnstype: "time", timelonn: 250, epost: "ola.rapp@server.test" });
    const inv = await kall("POST", `/api/org/${org}/ansatte/${olaId}/inviter`);
    expect((await kall("POST", "/api/invitasjoner/aksepter", { token: inv.data.lenke.split("/").pop() }, ola)).status).toBe(200);
    for (const [dato, timer, ekstra] of [
      ["2026-10-05", 8, {}],
      ["2026-10-06", 8, {}],
      ["2026-10-07", 8, {}],
      ["2026-10-08", 8, {}],
      ["2026-10-09", 8, {}],
      ["2026-10-12", 10, {}],
      ["2026-10-13", 2, { uten_overtid: true, beskrivelse: "Kveldsvakt" }],
    ] as const) {
      const r = await kall("POST", `/api/org/${org}/timer`, { ansatt_id: olaId, dato, timer, ...ekstra });
      expect(r.status, JSON.stringify(r.data)).toBe(201);
    }
    expect((await kall("POST", `/api/org/${org}/fravaer`, { ansatt_id: kari, type: "syk", fra: "2026-10-14", til: "2026-10-16" })).status).toBe(201);
    tom();
  });

  it("rapportene etter rolle og funksjon", async () => {
    expect(await moduler()).toEqual({
      faktura: ["faktura.reskontro", "faktura.mva", "faktura.salg", "faktura.journal", "faktura.innbetalinger"],
      personal: [
        "personal.timer",
        "personal.timeliste",
        "personal.fravaer",
        "personal.sykefravaer",
        "personal.ferie",
        "personal.timebank",
        "personal.ekstratimer",
        "personal.ansatte",
      ],
      lonn: [
        "lonn.journal",
        "lonn.lonnsarter",
        "lonn.bokforing",
        "lonn.skatt_aga",
        "lonn.amelding",
        "lonn.feriepenger",
        "lonn.aarsoversikt",
        "lonn.otp",
        "lonn.endringer",
        "lonn.trekk",
        "lonn.reiser",
        "lonn.naturalytelser",
        "lonn.permisjoner",
        "lonn.avstemming",
        "lonn.avstemming_aar",
        "lonn.nav_refusjoner",
        "lonn.sykepenger",
      ],
      regnskap: ["regnskap.anleggsregister", "regnskap.avskrivningsplan", "regnskap.avskrivninger", "regnskap.saldoskjema"],
    });
    const liste = (await kall("GET", `/api/org/${org}/rapportmodul`)).data;
    expect(liste.moduler.map((m: any) => m.navn)).toEqual(["Faktura", "Personal", "Lønn", "Regnskap"]);
    expect(liste.moduler[2].rapporter[0]).toEqual({ id: "lonn.journal", navn: "Lønnsjournal", beskrivelse: expect.any(String), parameter: "periode", maanedlig: true });
    // Regnskap ser lønn og timer, men ikke fraværet og feriebanken (som i personalmodulen).
    const r = await moduler(regnskap);
    expect(r.personal).toEqual(["personal.timer", "personal.timeliste", "personal.timebank", "personal.ekstratimer", "personal.ansatte"]);
    // Sykepengene og refusjonene fra NAV (helseopplysninger) og permisjonene (fravær) ser bare eier
    // og administrator; avstemmingen ser regnskap.
    expect(r.lonn).toHaveLength(14);
    expect(r.lonn).not.toContain("lonn.sykepenger");
    expect(r.lonn).not.toContain("lonn.nav_refusjoner");
    expect(r.lonn).not.toContain("lonn.permisjoner");
    expect(r.lonn).toEqual(expect.arrayContaining(["lonn.avstemming", "lonn.avstemming_aar"]));
    // Regnskapet (anleggsmidlene og saldoavskrivningene) ser regnskap, men ikke fakturerer.
    expect(r.regnskap).toEqual(["regnskap.anleggsregister", "regnskap.avskrivningsplan", "regnskap.avskrivninger", "regnskap.saldoskjema"]);
    expect((await kall("GET", `/api/org/${org}/rapportmodul/lonn.sykepenger`, undefined, regnskap)).status).toBe(403);
    expect(await moduler(fakturerer)).toEqual({ faktura: ["faktura.reskontro", "faktura.mva", "faktura.salg", "faktura.journal", "faktura.innbetalinger"] });
    expect(await moduler(ola)).toEqual({});
    expect((await kall("GET", `/api/org/${org}/rapportmodul/lonn.journal`, undefined, fakturerer)).status).toBe(403);
    expect((await kall("GET", `/api/org/${org}/rapportmodul/personal.fravaer`, undefined, regnskap)).status).toBe(403);
    expect((await kall("GET", `/api/org/${org}/rapportmodul/faktura.journal`, undefined, ola)).status).toBe(403);
    expect((await kall("GET", `/api/org/${org}/rapportmodul/finnes.ikke`)).status).toBe(404);

    // Funksjonen «Lønn» slått av: lønnsrapportene forsvinner og avvises.
    expect((await kall("PUT", `/api/admin/organisasjoner/${org}/funksjoner`, { lonn: false }, admin)).status).toBe(200);
    expect(Object.keys(await moduler())).toEqual(["faktura", "personal", "regnskap"]);
    const av = await kall("GET", `/api/org/${org}/rapportmodul/lonn.journal`);
    expect(av.status).toBe(403);
    expect(av.data.error).toBe("Funksjonen rapporten hører til, er ikke slått på");
    expect((await kall("PUT", `/api/admin/organisasjoner/${org}/funksjoner`, { lonn: true }, admin)).status).toBe(200);
  });

  it("fakturarapportene som tabell, CSV og PDF", async () => {
    const j = await kall("GET", `/api/org/${org}/rapportmodul/faktura.journal?fra=2026-10-01&til=2026-10-31`);
    expect(j.status, JSON.stringify(j.data)).toBe(200);
    expect(j.data).toMatchObject({ id: "faktura.journal", modul: "faktura", navn: "Fakturajournal", periode: "oktober 2026", valg: { fra: "2026-10-01", til: "2026-10-31" } });
    expect(j.data.rader).toEqual([
      expect.objectContaining({ type: "Faktura", fakturadato: "2026-10-02", kunde: "Kunde AS", kunde_orgnr: "974760673", sum_eks_mva: 10000, mva: 2500, sum_inkl_mva: 12500, status: "Utstedt" }),
    ]);
    expect(j.data.sum).toMatchObject({ sum_eks_mva: 10000, mva: 2500, sum_inkl_mva: 12500, betalt_belop: 0 });
    expect((await kall("GET", `/api/org/${org}/rapportmodul/faktura.journal?fra=2026-11-01&til=2026-11-30`)).data.rader).toEqual([]);
    expect((await kall("GET", `/api/org/${org}/rapportmodul/faktura.journal?fra=2026-10-31&til=2026-10-01`)).data.error).toBe("Til-datoen er før fra-datoen");
    expect((await kall("GET", `/api/org/${org}/rapportmodul/faktura.journal?fra=1.10.2026`)).status).toBe(400);

    const mva = await kall("GET", `/api/org/${org}/rapportmodul/faktura.mva?aar=2026&termin=5`);
    expect(mva.data.periode).toBe("5. termin 2026 (september–oktober)");
    expect(mva.data.rader).toEqual([{ sats: 25, grunnlag: 10000, mva: 2500, kreditert_mva: 0 }]);
    const res = await kall("GET", `/api/org/${org}/rapportmodul/faktura.reskontro`);
    expect(res.data.rader).toEqual([expect.objectContaining({ navn: "Kunde AS", antall: 1, utestaende: 12500 })]);
    expect((await kall("GET", `/api/org/${org}/rapportmodul/faktura.salg?aar=2026`)).data.rader).toHaveLength(12);

    // CSV: semikolon, BOM og norske desimaler, med summen nederst. De smale kolonnene er med.
    const csv = await kall("GET", `/api/org/${org}/rapportmodul/faktura.journal/csv?fra=2026-10-01&til=2026-10-31`);
    expect(csv.type).toContain("text/csv");
    expect(csv.disposisjon).toBe('attachment; filename="fakturajournal-oktober-2026.csv"');
    const linjer = (csv.data as string).trim().split("\r\n");
    expect(linjer[0]).toBe("Nummer;Type;Dato;Forfall;Kundenr;Kunde;Kundens orgnr;Eks. mva;Mva;Inkl. mva;Betalt;Kreditert;Refundert;Status;KID;Krediterer faktura");
    expect(linjer[1]).toContain(";Faktura;2026-10-02;2026-10-16;");
    expect(linjer.at(-1)).toBe("Sum;;;;;;;10000;2500;12500;0;0;0;;;");
    // BOM først, så Excel leser UTF-8 (text() tar den bort).
    const raa = await app.request(`/api/org/${org}/rapportmodul/faktura.journal/csv?fra=2026-10-01&til=2026-10-31`, { headers: { authorization: eier } });
    expect([...new Uint8Array(await raa.arrayBuffer()).slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);

    // PDF: liggende når det er mange kolonner, uten de smale kolonnene.
    const pdf = await kall("GET", `/api/org/${org}/rapportmodul/faktura.journal/pdf?fra=2026-10-01&til=2026-10-31`);
    expect(pdf.type).toBe("application/pdf");
    expect(pdf.disposisjon).toBe('attachment; filename="fakturajournal-oktober-2026.pdf"');
    const doc = await PDFDocument.load(pdf.data as Uint8Array);
    expect(doc.getTitle()).toBe("Fakturajournal oktober 2026");
    const { width, height } = doc.getPage(0).getSize();
    expect(width).toBeGreaterThan(height);
    const smal = await PDFDocument.load((await kall("GET", `/api/org/${org}/rapportmodul/faktura.mva/pdf?aar=2026&termin=5`)).data as Uint8Array);
    expect(smal.getPage(0).getSize().width).toBeLessThan(smal.getPage(0).getSize().height);
  });

  it("personalrapportene: timer med overtid og uten overtid, timeliste, fravær og ansatte", async () => {
    const t = await kall("GET", `/api/org/${org}/rapportmodul/personal.timer?fra=2026-10-01&til=2026-10-31`);
    expect(t.status, JSON.stringify(t.data)).toBe(200);
    // Uke 41: 40 timer. Uke 42: 10 timer mandag (1 over dagsgrensen) og 2 timer uten overtid.
    expect(t.data.rader).toEqual([expect.objectContaining({ navn: "Ola Time", ordinare: 49, overtid: 1, uten_overtid: 2, sum: 52, godkjent: 0, ikke_godkjent: 52 })]);
    expect(t.data.sum).toMatchObject({ sum: 52, overtid: 1 });

    const liste = await kall("GET", `/api/org/${org}/rapportmodul/personal.timeliste?fra=2026-10-12&til=2026-10-18`);
    expect(liste.data.rader.map((r: any) => [r.dato, r.timer, r.art, r.status, r.beskrivelse])).toEqual([
      ["2026-10-12", 10, "Vanlig", "Ikke levert", null],
      ["2026-10-13", 2, "Uten overtid", "Ikke levert", "Kveldsvakt"],
    ]);
    expect(liste.data.sum).toEqual({ timer: 12 });

    // Fraværet tas med de dagene som er i perioden.
    const fr = await kall("GET", `/api/org/${org}/rapportmodul/personal.fravaer?fra=2026-10-15&til=2026-10-31`);
    expect(fr.data.rader).toEqual([expect.objectContaining({ navn: "Kari Fast", type: "Syk", fra: "2026-10-15", til: "2026-10-16", dager: 2 })]);

    const a = await kall("GET", `/api/org/${org}/rapportmodul/personal.ansatte`);
    expect(a.data.rader.map((r: any) => [r.navn, r.lonn])).toEqual([
      ["Kari Fast", "50\u00a0000 kr/mnd"],
      ["Ola Time", "250 kr/t"],
    ]);
    expect(a.data.periode).toMatch(/^per \d{2}\.\d{2}\.\d{4}$/);

    // Timebanken (0073): saldoen med verdien (timelønnen, eller timesatsen for fastlønn).
    expect((await kall("PUT", `/api/org/${org}/lonn-oppsett`, { timebank: true })).data.timebank).toBe(true);
    for (const [ansatt, timer, tekst] of [
      [kari, 7.5, "Jobbet 1. mai"],
      [olaId, 4, "Saldo fra før"],
    ] as const)
      expect((await kall("POST", `/api/org/${org}/timebank/poster`, { ansatt_id: ansatt, type: "justering", timer, tekst })).status).toBe(201);
    const tb = await kall("GET", `/api/org/${org}/rapportmodul/personal.timebank`);
    expect(tb.status, JSON.stringify(tb.data)).toBe(200);
    expect(tb.data.rader).toEqual([
      expect.objectContaining({ navn: "Kari Fast", justert: 7.5, saldo: 7.5, dager: 1, sats: 307.6923, verdi: 2307.69 }),
      expect.objectContaining({ navn: "Ola Time", justert: 4, saldo: 4, sats: 250, verdi: 1000 }),
    ]);
    expect(tb.data.sum).toMatchObject({ saldo: 11.5, verdi: 3307.69 });
    expect(tb.data.merknad).toContain("uten feriepenger og arbeidsgiveravgift");
    expect((await kall("GET", `/api/org/${org}/rapportmodul/personal.timebank`, undefined, regnskap)).status).toBe(200);
    expect((await kall("GET", `/api/org/${org}/rapportmodul/personal.timebank`, undefined, fakturerer)).status).toBe(403);
  });

  it("utsendingsoppsettet: bare eier og administrator, med totrinn, og eierne varsles om nye mottakere", async () => {
    const sti = `/api/org/${org}/rapportmodul/oppsett`;
    expect((await kall("GET", sti)).data).toEqual({ oppsett: { mottakere: [], lonn_ved_godkjenning: false, maanedlig: [], oppdatert: null }, sendt: [] });
    const ok = { mottakere: ["Regnskap@Byraa.no"], lonn_ved_godkjenning: true, maanedlig: ["faktura.journal", "faktura.mva", "lonn.skatt_aga", "personal.timer"] };
    // Totrinnsbekreftelse kreves (bare i produksjon).
    (config as any).produksjon = true;
    const utenMfa = await kall("PUT", sti, ok, eierUtenMfa);
    (config as any).produksjon = false;
    expect(utenMfa.data.error).toBe("Denne handlingen krever totrinnsbekreftelse (MFA)");
    expect((await kall("PUT", sti, ok, regnskap)).status).toBe(403);
    expect((await kall("PUT", sti, { ...ok, mottakere: ["ikke en adresse"] })).data.error).toBe("Ugyldig e-postadresse");
    expect((await kall("PUT", sti, { ...ok, maanedlig: ["faktura.salg"] })).data.error).toBe("Rapporten faktura.salg kan ikke sendes hver måned");
    expect((await kall("PUT", sti, { ...ok, mottakere: Array.from({ length: 11 }, (_, i) => `r${i}@byraa.no`) })).data.error).toBe("Høyst 10 mottakere");
    const lagret = await kall("PUT", sti, ok);
    expect(lagret.status, JSON.stringify(lagret.data)).toBe(200);
    expect(lagret.data).toMatchObject({ mottakere: ["regnskap@byraa.no"], lonn_ved_godkjenning: true, maanedlig: ok.maanedlig });
    expect((await kall("GET", sti, undefined, regnskap)).data.oppsett.mottakere).toEqual(["regnskap@byraa.no"]);

    // Ny mottaker: hendelse i utboksen, og eierne får e-post.
    const h = await somSystem((db) =>
      alle<any>(db, "select * from faktura.utboks where org_id = $1 and hendelse = 'organisasjon.rapportmottakere_endret' order by id", [org]),
    );
    expect(h.map((r) => r.data)).toEqual([{ nye: ["regnskap@byraa.no"], alle: ["regnskap@byraa.no"], endret_av: expect.any(String) }]);
    await somSystem((db) => varsleRapportmottakere(db, h[0]));
    expect(sendt.at(-1)).toMatchObject({ til: ["rapp-eier@server.test"], emne: "Rapportene fra Rapport Test AS sendes til en ny adresse" });
    expect(sendt.at(-1)!.tekst).toContain("sendes nå også til: regnskap@byraa.no");
    // Samme mottakere igjen (eller færre): ingen ny hendelse.
    expect((await kall("PUT", sti, { ...ok, lonn_ved_godkjenning: false })).status).toBe(200);
    expect((await kall("PUT", sti, ok)).status).toBe(200);
    expect(await somSystem((db) => en<any>(db, "select count(*)::int as n from faktura.utboks where org_id = $1 and hendelse = 'organisasjon.rapportmottakere_endret'", [org]))).toEqual({ n: 1 });
    tom();
  });

  it("rapporter sendes på e-post med PDF og CSV, og utsendingen logges", async () => {
    const sti = `/api/org/${org}/rapportmodul/send`;
    const b = { rapporter: [{ id: "faktura.journal", valg: { fra: "2026-10-01", til: "2026-10-31" } }, { id: "personal.timer", valg: { fra: "2026-10-01", til: "2026-10-31" } }], melding: "Hilsen fra oss" };
    (config as any).produksjon = true;
    const utenMfa = await kall("POST", sti, b, eierUtenMfa);
    (config as any).produksjon = false;
    expect(utenMfa.status).toBe(403);
    expect((await kall("POST", sti, b, regnskap)).status).toBe(403);
    expect((await kall("POST", sti, { rapporter: [] })).data.error).toBe("Velg minst én rapport");
    expect((await kall("POST", sti, { rapporter: [{ id: "finnes.ikke", valg: {} }] })).status).toBe(404);
    expect((await kall("POST", sti, { rapporter: [{ id: "faktura.journal", valg: { fra: "2026-10-31", til: "2026-10-01" } }] })).data.error).toBe("Til-datoen er før fra-datoen");
    const r = await kall("POST", sti, b);
    expect(r.data).toEqual({ ok: true, til: ["regnskap@byraa.no"] });
    expect(sendt).toEqual([]); // sendes av workeren
    const [o] = mine("rapport-send");
    expect(o).toMatchObject({ type: "rapport-send", org_id: org, til: ["regnskap@byraa.no"], melding: "Hilsen fra oss", bruker_id: expect.any(String) });
    await kjorOppgave(o!);
    expect(sendt).toHaveLength(1);
    const e = sendt[0]!;
    expect(e).toMatchObject({
      fraNavn: "Rapport Test AS",
      til: ["regnskap@byraa.no"],
      svarTil: "rapp-eier@server.test",
      emne: "Rapport Test AS: Fakturajournal, Timer per ansatt (oktober 2026)",
      idempotensnokkel: `rapport-${o!.oppgave_id}`,
    });
    expect(e.tekst).toContain("- Fakturajournal, oktober 2026 (1 rad)");
    expect(e.tekst).toContain("- Timer per ansatt, oktober 2026 (1 rad)");
    expect(e.tekst).toContain("Hilsen fra oss");
    expect(e.vedlegg!.map((v) => [v.filnavn, v.type])).toEqual([
      ["fakturajournal-oktober-2026.csv", "text/csv; charset=utf-8"],
      ["fakturajournal-oktober-2026.pdf", "application/pdf"],
      ["timer-per-ansatt-oktober-2026.csv", "text/csv; charset=utf-8"],
      ["timer-per-ansatt-oktober-2026.pdf", "application/pdf"],
    ]);
    expect(new TextDecoder().decode(e.vedlegg![0]!.data)).toContain("Kunde AS");
    expect((await PDFDocument.load(e.vedlegg![3]!.data)).getTitle()).toBe("Timer per ansatt oktober 2026");

    // Til andre adresser enn oppsettet.
    expect((await kall("POST", sti, { ...b, til: ["Revisor@Firma.no"] })).data.til).toEqual(["revisor@firma.no"]);

    const logg = (await kall("GET", `/api/org/${org}/rapportmodul/oppsett`, undefined, regnskap)).data.sendt;
    expect(logg).toEqual([
      expect.objectContaining({
        til: ["regnskap@byraa.no"],
        automatisk: null,
        feil: null,
        sendt_av: "rapp-eier@server.test",
        rapporter: [
          { id: "faktura.journal", navn: "Fakturajournal", periode: "oktober 2026" },
          { id: "personal.timer", navn: "Timer per ansatt", periode: "oktober 2026" },
        ],
      }),
    ]);
    tom();
  });

  it("uten mottakere i oppsettet må adressen skrives inn", async () => {
    const sti = `/api/org/${org}/rapportmodul/oppsett`;
    const naa = (await kall("GET", sti)).data.oppsett;
    expect((await kall("PUT", sti, { mottakere: [], lonn_ved_godkjenning: naa.lonn_ved_godkjenning, maanedlig: naa.maanedlig })).status).toBe(200);
    expect((await kall("POST", `/api/org/${org}/rapportmodul/send`, { rapporter: [{ id: "faktura.mva", valg: {} }] })).data.error).toBe(
      "Legg inn e-postadressen til regnskapsføreren først (Rapporter → Utsending)",
    );
    expect((await kall("PUT", sti, { mottakere: ["regnskap@byraa.no"], lonn_ved_godkjenning: naa.lonn_ved_godkjenning, maanedlig: naa.maanedlig })).status).toBe(200);
    tom();
  });

  it("en godkjent lønnskjøring sender lønnsjournalen, summen per lønnsart og lønnsbilaget", async () => {
    const k = await kall("POST", `/api/org/${org}/lonn/kjoringer`, { periode: "2026-10" });
    expect(k.status, JSON.stringify(k.data)).toBe(201);
    kjoring = k.data.id;
    // Utkast er ikke med i rapportene.
    expect((await kall("GET", `/api/org/${org}/rapportmodul/lonn.journal?kjoring=${kjoring}`)).data.rader).toEqual([]);
    expect((await kall("POST", `/api/org/${org}/lonn/kjoringer/${kjoring}/godkjenn`)).data.status).toBe("godkjent");
    const [o] = mine("rapport-send");
    expect(o).toMatchObject({
      automatisk: "lonn",
      til: ["regnskap@byraa.no"],
      rapporter: [
        { id: "lonn.journal", valg: { kjoring } },
        { id: "lonn.lonnsarter", valg: { kjoring } },
        { id: "lonn.bokforing", valg: { kjoring } },
      ],
    });
    await kjorOppgave(o!);
    const e = sendt.find((m) => m.emne.includes("Lønnsjournal"))!;
    expect(e.emne).toBe("Rapport Test AS: Lønnsjournal, Sum per lønnsart, Lønnsbilag (lønnskjøring oktober 2026, utbetalt 20.10.2026)");
    expect(e.tekst).toContain("(lønnskjøringen er godkjent)");
    expect(e.tekst).toContain("Sendt fra HI4 Faktura av seg selv.");
    expect(e.vedlegg).toHaveLength(6);

    const j = (await kall("GET", `/api/org/${org}/rapportmodul/lonn.journal?kjoring=${kjoring}`)).data;
    expect(j.periode).toBe("lønnskjøring oktober 2026, utbetalt 20.10.2026");
    expect(j.rader).toEqual([expect.objectContaining({ navn: "Kari Fast", utbetalt: "2026-10-20", brutto: 50000, skattetrekk: 15000, netto: 35000, otp: 1000, aga: 7191 })]);
    // Det samme for perioden: kjøringene med utbetaling i oktober.
    expect((await kall("GET", `/api/org/${org}/rapportmodul/lonn.journal?fra=2026-10-01&til=2026-10-31`)).data.sum).toMatchObject({ brutto: 50000, netto: 35000 });
    expect((await kall("GET", `/api/org/${org}/rapportmodul/lonn.journal?fra=2026-11-01&til=2026-11-30`)).data.rader).toEqual([]);

    const arter = (await kall("GET", `/api/org/${org}/rapportmodul/lonn.lonnsarter?kjoring=${kjoring}`)).data.rader;
    expect(arter.map((r: any) => [r.post, r.belop])).toEqual([
      ["Fastlønn", 50000],
      ["Bruttolønn", 50000],
      ["Forskuddstrekk", -15000],
      ["Netto utbetalt", 35000],
      ["Arbeidsgiveravgift", 7191],
      ["OTP", 1000],
      ["Feriepenger opptjent", 6000],
    ]);
    const sa = (await kall("GET", `/api/org/${org}/rapportmodul/lonn.skatt_aga?aar=2026&termin=5`)).data;
    expect(sa.rader).toEqual([expect.objectContaining({ utbetalt: "2026-10-20", kjoring: "oktober 2026", slipper: 1, skattetrekk: 15000, aga: 7191, frist_aga: "2026-11-16" })]);
    // A-meldingsgrunnlaget: lønnen etter beskrivelsen i a-meldingen, og forskuddstrekket.
    expect((await kall("GET", `/api/org/${org}/rapportmodul/lonn.amelding?fra=2026-10-01&til=2026-10-31`)).data.rader).toEqual([
      expect.objectContaining({ maaned: "2026-10", navn: "Kari Fast", beskrivelse: "Fastlønn", belop: 50000, forskuddstrekk: null }),
      expect.objectContaining({ maaned: "2026-10", navn: "Kari Fast", beskrivelse: "Forskuddstrekk", belop: null, forskuddstrekk: 15000 }),
    ]);
    expect((await kall("GET", `/api/org/${org}/rapportmodul/lonn.aarsoversikt?aar=2026`)).data.rader).toEqual([
      expect.objectContaining({ navn: "Kari Fast", brutto: 50000, forskuddstrekk: 15000, aga: 7191 }),
    ]);
    expect((await kall("GET", `/api/org/${org}/rapportmodul/lonn.feriepenger?aar=2026`)).data.rader).toEqual([
      expect.objectContaining({ navn: "Kari Fast", grunnlag: 50000, opptjent: 6000, utbetalt: 0, igjen: 6000 }),
    ]);
    const pdf = await PDFDocument.load((await kall("GET", `/api/org/${org}/rapportmodul/lonn.journal/pdf?kjoring=${kjoring}`)).data as Uint8Array);
    expect(pdf.getTitle()).toBe("Lønnsjournal lønnskjøring oktober 2026, utbetalt 20.10.2026");
    // Uten «send ved godkjenning» går ingenting.
    tom();
    const sti = `/api/org/${org}/rapportmodul/oppsett`;
    const naa = (await kall("GET", sti)).data.oppsett;
    expect((await kall("PUT", sti, { mottakere: naa.mottakere, lonn_ved_godkjenning: false, maanedlig: naa.maanedlig })).status).toBe(200);
    expect((await kall("POST", `/api/org/${org}/lonn/kjoringer/${kjoring}/gjenapne`)).status).toBe(200);
    expect((await kall("POST", `/api/org/${org}/lonn/kjoringer/${kjoring}/godkjenn`)).status).toBe(200);
    expect(mine("rapport-send")).toEqual([]);
    tom();
  });

  it("månedsrapportene den 1. for forrige måned, termin når den er slutt, og én gang per dag", async () => {
    expect(await planleggMaanedsrapporter("2026-11-02")).toBe(0);
    await planleggMaanedsrapporter("2026-11-01");
    const [o] = mine("rapport-send");
    expect(o).toMatchObject({
      automatisk: "maaned",
      til: ["regnskap@byraa.no"],
      rapporter: [
        { id: "faktura.journal", valg: { fra: "2026-10-01", til: "2026-10-31" } },
        { id: "faktura.mva", valg: { aar: 2026, termin: 5 } },
        { id: "lonn.skatt_aga", valg: { aar: 2026, termin: 5 } },
        { id: "personal.timer", valg: { fra: "2026-10-01", til: "2026-10-31" } },
      ],
    });
    // Desember: november er ikke slutten på en termin.
    tom();
    await planleggMaanedsrapporter("2026-12-01");
    expect(mine("rapport-send")[0]!.rapporter.map((r) => r.id)).toEqual(["faktura.journal", "personal.timer"]);

    // En funksjon som er slått av: rapporten står som «Kunne ikke lages».
    expect((await kall("PUT", `/api/admin/organisasjoner/${org}/funksjoner`, { lonn: false }, admin)).status).toBe(200);
    await kjorOppgave(o!);
    expect((await kall("PUT", `/api/admin/organisasjoner/${org}/funksjoner`, { lonn: true }, admin)).status).toBe(200);
    const e = sendt.find((m) => m.emne.startsWith("Rapport Test AS: Fakturajournal, Mva per sats"))!;
    expect(e.tekst).toContain("(månedsrapportene sendes den 1. hver måned)");
    expect(e.tekst).toContain("Kunne ikke lages:\n- Skattetrekk og arbeidsgiveravgift: Funksjonen rapporten hører til, er ikke slått på");
    expect(e.vedlegg).toHaveLength(6);
    const logg = (await kall("GET", `/api/org/${org}/rapportmodul/oppsett`)).data.sendt[0];
    expect(logg).toMatchObject({ automatisk: "maaned", feil: expect.stringContaining("Skattetrekk og arbeidsgiveravgift") });

    // Allerede sendt i dag: ikke en gang til.
    tom();
    await planleggMaanedsrapporter("2026-11-01");
    expect(mine("rapport-send")).toEqual([]);
  });

  it("databasen: bare eier og administrator endrer oppsettet, og loggen kan ikke skrives av appen", async () => {
    const rad = await somSystem((db) => en<any>(db, "select * from faktura.rapport_oppsett where org_id = $1", [org]));
    expect(rad).toMatchObject({ mottakere: ["regnskap@byraa.no"], oppdatert_av: expect.any(String) });
    await expect(
      somSystem((db) => db.query("update faktura.rapport_oppsett set mottakere = array['ikke en adresse'] where org_id = $1", [org])),
    ).rejects.toThrow();
  });
});
