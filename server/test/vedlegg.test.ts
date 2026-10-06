// Vedlegg på fakturaer: opplasting med kontroll av filtypen, kobling til utkast, lås etter
// utstedelse, utsending på e-post (også purringer) og i EHF, og opprydding av filer.
import { describe, expect, it, beforeAll } from "vitest";
import { config } from "../src/config.js";
import { lagApi } from "../src/api.js";
import { alle, en, somSystem } from "../src/db.js";
import { pdfData } from "../src/dokument.js";
import { lagring, settEpost, settLokalOppgavekjorer, type EpostMelding, type Oppgave } from "../src/tjenester.js";
import { sendFaktura, sendPurring } from "../src/worker.js";
import { disposisjon, finnType, rensFilnavn, ryddVedlegg } from "../src/vedlegg.js";

const tekst = (s: string) => new TextEncoder().encode(s);
const PDF = tekst("%PDF-1.4\n1 0 obj <<>> endobj\ntrailer <<>>\n%%EOF\n");
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
const JPG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46]);
const zip = (...navn: string[]) => {
  const deler = navn.flatMap((n) => [Uint8Array.from([0x50, 0x4b, 3, 4, ...new Array(22).fill(0), n.length, 0, 0, 0]), tekst(n), tekst("innhold")]);
  return Uint8Array.from(deler.flatMap((d) => [...d]));
};
const XLSX = zip("[Content_Types].xml", "xl/workbook.xml", "xl/worksheets/sheet1.xml");
const DOCX = zip("[Content_Types].xml", "word/document.xml");
const ODS = Uint8Array.from([...zip("mimetype").slice(0, 38), ...tekst("application/vnd.oasis.opendocument.spreadsheet")]);
const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

describe("Filtype og filnavn", () => {
  it("bestemmer typen av innholdet", () => {
    expect(finnType(PDF, "x")).toBe("application/pdf");
    expect(finnType(PNG, "bilde.jpg")).toBe("image/png");
    expect(finnType(JPG, "")).toBe("image/jpeg");
    expect(finnType(XLSX, "timer.xlsx")).toBe(XLSX_TYPE);
    expect(finnType(ODS, "timer.ods")).toBe("application/vnd.oasis.opendocument.spreadsheet");
    expect(finnType(tekst("Dato;Timer\n01.10.2026;7,5\n"), "timer.CSV")).toBe("text/csv");
    // Ikke tillatt: Word, HTML, program, tekst uten .csv, og «CSV» med binære data.
    expect(finnType(DOCX, "brev.docx")).toBe(null);
    expect(finnType(tekst("<html><script>alert(1)</script></html>"), "side.html")).toBe(null);
    expect(finnType(tekst("<svg xmlns='http://www.w3.org/2000/svg'/>"), "bilde.svg")).toBe(null);
    expect(finnType(Uint8Array.from([0x4d, 0x5a, 0x90, 0]), "program.exe")).toBe(null);
    expect(finnType(tekst("Dato;Timer"), "timer.txt")).toBe(null);
    expect(finnType(Uint8Array.from([0x41, 0, 0x42]), "data.csv")).toBe(null);
  });

  it("rydder filnavnet og gir det riktig endelse", () => {
    expect(rensFilnavn("../../mappe\\Timeliste mars.PDF", "application/pdf")).toBe("Timeliste mars.pdf");
    expect(rensFilnavn("bilde.png", "image/jpeg")).toBe("bilde.jpg");
    expect(rensFilnavn("bilde.jpeg", "image/jpeg")).toBe("bilde.jpeg");
    expect(rensFilnavn("rapport", "application/pdf")).toBe("rapport.pdf");
    expect(rensFilnavn("rapport.v2", "application/pdf")).toBe("rapport.v2.pdf");
    expect(rensFilnavn("", "application/pdf")).toBe("Vedlegg.pdf");
    expect(rensFilnavn(".pdf", "application/pdf")).toBe("Vedlegg.pdf");
    expect(rensFilnavn('Avtale "endelig" <v3>?.pdf', "application/pdf")).toBe("Avtale endelig v3.pdf");
    expect(rensFilnavn("Kvittering\u0000\n Øvre  Ås.jpg", "image/jpeg")).toBe("Kvittering Øvre Ås.jpg");
    expect(rensFilnavn(`${"a".repeat(140)}.pdf`, "application/pdf")).toBe(`${"a".repeat(100)}.pdf`);
  });

  it("gir filnavnet både som ASCII og UTF-8 ved nedlasting", () => {
    expect(disposisjon("Timeliste – mars øæå (v2).pdf")).toBe(
      `attachment; filename="Timeliste _ mars oaea (v2).pdf"; filename*=UTF-8''Timeliste%20%E2%80%93%20mars%20%C3%B8%C3%A6%C3%A5%20%28v2%29.pdf`,
    );
  });
});

describe.skipIf(!process.env.DATABASE_URL)("Vedlegg på fakturaer", () => {
  const app = lagApi();
  const eier = "Bearer test:uid-vedlegg:vedlegg@server.test:mfa";
  const fremmed = "Bearer test:uid-vedlegg-2:fremmed@server.test:mfa";
  const linjer = [{ beskrivelse: "Konsulentbistand", antall: 7.5, enhet: "time", enhetspris: 1250, mva_sats: 25 }];
  const filer = new Map<string, Uint8Array>(); // «bøtte/sti»
  const slettet: string[] = [];
  const ko: Oppgave[] = [];
  const sendt: EpostMelding[] = [];
  let org: string;
  let kunde: string;

  const kall = async (m: string, sti: string, k?: unknown, hvem = eier) => {
    const r = await app.request(sti, { method: m, headers: { authorization: hvem, "content-type": "application/json" }, body: k === undefined ? undefined : JSON.stringify(k) });
    const type = r.headers.get("content-type") ?? "";
    return { status: r.status, data: type.includes("json") ? ((await r.json()) as any) : null };
  };
  const lastOpp = async (data: Uint8Array, filnavn: string, hvem = eier) => {
    const r = await app.request(`/api/org/${org}/vedlegg`, {
      method: "POST",
      headers: { authorization: hvem, "content-type": "application/octet-stream", "x-filnavn": encodeURIComponent(filnavn) },
      body: data,
    });
    return { status: r.status, data: (await r.json()) as any };
  };
  // Lenken til et vedlegg (signert lenke i 10 minutter), som { bøtte/sti, type, disposisjon }.
  const lenke = async (fakturaId: string, vedleggId: string) => {
    const r = await kall("GET", `/api/org/${org}/fakturaer/${fakturaId}/vedlegg/${vedleggId}`);
    if (r.status !== 200) return { status: r.status };
    const u = new URL(r.data.url);
    return { status: r.status, fil: u.pathname.slice(1), type: u.searchParams.get("type"), disposisjon: u.searchParams.get("disp") };
  };
  const utsendinger = (id: string) => ko.filter((x) => x.type === "send-faktura" && x.faktura_id === id) as any[];

  beforeAll(async () => {
    const c = config as any;
    c.fakturaBucket = "test-fakturaer";
    c.filerBucket = "test-filer";
    lagring.hent = async (b, sti) => filer.get(`${b}/${sti}`) ?? null;
    lagring.lagre = async (b, sti, data) => {
      // Som i Cloud Storage: fakturabøtta overskrives aldri (ifGenerationMatch: 0).
      if (b === "test-fakturaer" && filer.has(`${b}/${sti}`)) throw Object.assign(new Error("finnes"), { code: 412 });
      filer.set(`${b}/${sti}`, data);
    };
    lagring.signertUrl = async (b, sti, minutter, _filnavn, valg) =>
      `https://lagring.test/${b}/${sti}?min=${minutter}&type=${encodeURIComponent(valg?.type ?? "")}&disp=${encodeURIComponent(valg?.disposisjon ?? "")}`;
    lagring.slett = async (b, sti) => {
      slettet.push(`${b}/${sti}`);
      filer.delete(`${b}/${sti}`);
    };
    settEpost({
      async send(m) {
        sendt.push(m);
        return { id: `epost-${sendt.length}-${Math.random()}` };
      },
    });
    settLokalOppgavekjorer(async (o) => void ko.push(o));
    org = (await kall("POST", "/api/organisasjoner", { navn: "Vedlegg AS" })).data.id;
    expect((await kall("PATCH", `/api/org/${org}`, { kontonr: "86011117947", epost: "post@vedlegg.no", mva_registrert: true })).status).toBe(200);
    kunde = (await kall("POST", `/api/org/${org}/kunder`, { navn: "Kunde AS", epost: "kunde@kunde.no" })).data.id;
  });

  it("tar imot PDF, bilder, CSV og regneark, og avviser resten", async () => {
    const pdf = await lastOpp(PDF, "Timeliste – oktober.pdf");
    expect(pdf.status).toBe(201);
    expect(pdf.data).toMatchObject({ filnavn: "Timeliste – oktober.pdf", type: "application/pdf", storrelse: PDF.length });
    expect(filer.get(`test-filer/${org}/vedlegg/${pdf.data.id}`)).toEqual(PDF);
    expect((await lastOpp(XLSX, "timer")).data).toMatchObject({ filnavn: "timer.xlsx", type: XLSX_TYPE });

    const feil = await lastOpp(tekst("<html></html>"), "side.html");
    expect(feil).toEqual({ status: 400, data: { error: expect.stringContaining("Vedlegg kan være PDF, bilder (PNG eller JPG), CSV eller regneark") } });
    expect((await lastOpp(new Uint8Array(0), "tom.pdf")).status).toBe(400);
    const stor = new Uint8Array(10_000_001);
    stor.set(PDF);
    expect(await lastOpp(stor, "stor.pdf")).toEqual({ status: 413, data: { error: "Filen er for stor. Et vedlegg kan være høyst 10 MB." } });
    // Andre enn medlemmene i organisasjonen kan ikke laste opp.
    expect((await lastOpp(PDF, "a.pdf", fremmed)).status).toBe(403);
  });

  it("kobles til utkastet når det lagres, i rekkefølge, og kan fjernes og byttes", async () => {
    const a = (await lastOpp(PDF, "Avtale.pdf")).data;
    const b = (await lastOpp(PNG, "Skjermbilde.png")).data;
    const c = (await lastOpp(tekst("Dato;Timer\n"), "Timer.csv")).data;
    const f = await kall("POST", `/api/org/${org}/fakturaer`, { kunde_id: kunde, linjer, vedlegg: [b.id, a.id, b.id] });
    expect(f.status).toBe(201);
    expect(f.data.vedlegg.map((v: any) => v.filnavn)).toEqual(["Skjermbilde.png", "Avtale.pdf"]);

    // Uten vedlegg i kroppen (eldre klient) står de som de er.
    expect((await kall("PUT", `/api/org/${org}/fakturaer/${f.data.id}`, { kunde_id: kunde, linjer })).data.vedlegg.length).toBe(2);
    // Avtalen fjernes og timelista legges til.
    const p = await kall("PUT", `/api/org/${org}/fakturaer/${f.data.id}`, { kunde_id: kunde, linjer, vedlegg: [c.id, b.id] });
    expect(p.data.vedlegg.map((v: any) => v.filnavn)).toEqual(["Timer.csv", "Skjermbilde.png"]);
    const kø = await somSystem((db) => alle<{ sti: string }>(db, "select sti from faktura.slettede_filer"));
    expect(kø.map((x) => x.sti)).toContain(`${org}/vedlegg/${a.id}`);

    // Lista viser at fakturaen har vedlegg.
    const liste = (await kall("GET", `/api/org/${org}/fakturaer`)).data;
    expect(liste.find((x: any) => x.id === f.data.id).antall_vedlegg).toBe(2);

    // Åpnes med en signert lenke: bilder og PDF vises, resten lastes ned.
    expect(await lenke(f.data.id, b.id)).toEqual({
      status: 200,
      fil: `test-filer/${org}/vedlegg/${b.id}`,
      type: "image/png",
      disposisjon: `inline; filename="Skjermbilde.png"; filename*=UTF-8''Skjermbilde.png`,
    });
    expect((await lenke(f.data.id, c.id)).disposisjon).toBe(`attachment; filename="Timer.csv"; filename*=UTF-8''Timer.csv`);
    expect((await lenke(f.data.id, a.id)).status).toBe(404); // fjernet fra fakturaen
    const annen = await kall("GET", `/api/org/${org}/fakturaer/${f.data.id}/vedlegg/${b.id}`, undefined, fremmed);
    expect(annen.status).toBe(404);
  });

  it("avviser ukjente vedlegg, vedlegg fra andre fakturaer og for mye", async () => {
    const ukjent = await kall("POST", `/api/org/${org}/fakturaer`, { kunde_id: kunde, linjer, vedlegg: ["00000000-0000-4000-8000-000000000000"] });
    expect(ukjent).toEqual({ status: 400, data: { error: "Fant ikke et av vedleggene. Fjern det og legg det ved på nytt." } });
    // Ingenting ble lagret.
    expect((await kall("GET", `/api/org/${org}/fakturaer?status=utkast`)).data.length).toBe(1);

    const v = (await lastOpp(PDF, "Brukt.pdf")).data;
    await kall("POST", `/api/org/${org}/fakturaer`, { kunde_id: kunde, linjer, vedlegg: [v.id] });
    expect((await kall("POST", `/api/org/${org}/fakturaer`, { kunde_id: kunde, linjer, vedlegg: [v.id] })).status).toBe(400);

    const elleve = Array.from({ length: 11 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
    expect(await kall("POST", `/api/org/${org}/fakturaer`, { kunde_id: kunde, linjer, vedlegg: elleve })).toEqual({ status: 400, data: { error: "Høyst 10 vedlegg på en faktura" } });

    const halv = new Uint8Array(6_000_000);
    halv.set(PDF);
    const x = (await lastOpp(halv, "Del 1.pdf")).data;
    const y = (await lastOpp(halv, "Del 2.pdf")).data;
    expect(await kall("POST", `/api/org/${org}/fakturaer`, { kunde_id: kunde, linjer, vedlegg: [x.id, y.id] })).toEqual({
      status: 400,
      data: { error: "Vedleggene kan til sammen være høyst 10 MB" },
    });
  });

  it("sendes med fakturaen og purringen, arkiveres og låses ved utstedelse", async () => {
    const t = (await lastOpp(PDF, "Timeliste oktober.pdf")).data;
    const k = (await lastOpp(JPG, "Kvittering.jpg")).data;
    // Forfalt, så den kan purres.
    const f = (await kall("POST", `/api/org/${org}/fakturaer`, { kunde_id: kunde, fakturadato: "2026-01-01", forfallsdato: "2026-01-15", linjer, vedlegg: [t.id, k.id] })).data;
    const u = await kall("POST", `/api/org/${org}/fakturaer/${f.id}/utsted`, { send_epost: true });
    expect(u.status).toBe(200);

    await sendFaktura({ ...utsendinger(f.id).at(-1), oppgave_id: `vedlegg-${Math.random()}` });
    const e = sendt.at(-1)!;
    expect(e.vedlegg!.map((v) => [v.filnavn, v.type])).toEqual([
      [`Faktura-${u.data.fakturanummer}.pdf`, "application/pdf"],
      ["Timeliste oktober.pdf", "application/pdf"],
      ["Kvittering.jpg", "image/jpeg"],
    ]);
    expect(e.vedlegg![2]!.data).toEqual(JPG);
    expect(e.tekst).toContain("Vedlegg: Timeliste oktober.pdf, Kvittering.jpg");

    // Kopi i fakturabøtta (oppbevaring), som brukes deretter.
    const arkiv = await somSystem((db) => alle<{ id: string; arkiv_sti: string }>(db, "select id, arkiv_sti from faktura.vedlegg where faktura_id = $1 order by rekke", [f.id]));
    expect(arkiv.map((v) => v.arkiv_sti)).toEqual([
      `${org}/${u.data.fakturadato.slice(0, 4)}/faktura-${u.data.fakturanummer}-${f.id}-vedlegg/${t.id}.pdf`,
      `${org}/${u.data.fakturadato.slice(0, 4)}/faktura-${u.data.fakturanummer}-${f.id}-vedlegg/${k.id}.jpg`,
    ]);
    expect(filer.get(`test-fakturaer/${arkiv[1]!.arkiv_sti}`)).toEqual(JPG);
    expect((await lenke(f.id, k.id)).fil).toBe(`test-fakturaer/${arkiv[1]!.arkiv_sti}`);

    // Sendt på nytt: vedleggene hentes fra arkivkopien.
    filer.delete(`test-filer/${org}/vedlegg/${k.id}`);
    await sendFaktura({ faktura_id: f.id, send_epost: true, oppgave_id: `vedlegg-${Math.random()}` });
    expect(sendt.at(-1)!.vedlegg!.map((v) => v.data)).toEqual([expect.anything(), PDF, JPG]);

    // PDF-en har navnene på vedleggene, også når den lages fra en faktura uten dem (Google Disk).
    const rad = await somSystem((db) => en(db, "select * from faktura.fakturaer where id = $1", [f.id]));
    expect((await somSystem((db) => pdfData(db, { ...rad, linjer: [] }))).vedlegg).toEqual(["Timeliste oktober.pdf", "Kvittering.jpg"]);

    // Låst etter utstedelsen.
    expect((await kall("PUT", `/api/org/${org}/fakturaer/${f.id}`, { kunde_id: kunde, linjer, vedlegg: [] })).status).toBe(409);
    expect((await kall("GET", `/api/org/${org}/fakturaer/${f.id}`)).data.vedlegg.length).toBe(2);

    // Purringen har med fakturaen og vedleggene.
    const p = await kall("POST", `/api/org/${org}/fakturaer/${f.id}/purring`, { type: "paaminnelse" });
    expect(p.status).toBe(201);
    await sendPurring({ purring_id: p.data.id, oppgave_id: `purring-${Math.random()}` });
    expect(sendt.at(-1)!.vedlegg!.map((v) => v.filnavn)).toEqual([`Faktura-${u.data.fakturanummer}.pdf`, "Timeliste oktober.pdf", "Kvittering.jpg"]);
  });

  it("er med i EHF-filen", async () => {
    await kall("PATCH", `/api/org/${org}`, { orgnr: "923609016", adresse: "Storgata 1", postnr: "0155", poststed: "Oslo" });
    const k = (await kall("POST", `/api/org/${org}/kunder`, { navn: "Fjordline AS", orgnr: "974760673", adresse: "Kaigata 5", postnr: "5003", poststed: "Bergen" })).data;
    const v = (await lastOpp(XLSX, "Timer oktober.xlsx")).data;
    const f = (await kall("POST", `/api/org/${org}/fakturaer`, { kunde_id: k.id, deres_referanse: "Lise", linjer, vedlegg: [v.id] })).data;
    await kall("POST", `/api/org/${org}/fakturaer/${f.id}/utsted`, { send_epost: false });
    const r = await app.request(`/api/org/${org}/fakturaer/${f.id}/ehf`, { headers: { authorization: eier } });
    expect(r.status).toBe(200);
    const xml = await r.text();
    expect(xml).toContain(
      `<cac:AdditionalDocumentReference><cbc:ID>Timer oktober.xlsx</cbc:ID><cbc:DocumentDescription>Vedlegg</cbc:DocumentDescription><cac:Attachment><cbc:EmbeddedDocumentBinaryObject mimeCode="${XLSX_TYPE}" filename="Timer oktober.xlsx">${Buffer.from(XLSX).toString("base64")}</cbc:EmbeddedDocumentBinaryObject>`,
    );
  });

  // At opplastinger som aldri ble lagret ryddes etter to døgn, står i db/tests/09_vedlegg.sql.
  it("rydder filer etter vedlegg som er fjernet fra utkast, og utkast som er slettet", async () => {
    const utkast = (await kall("POST", `/api/org/${org}/fakturaer`, { kunde_id: kunde, linjer, vedlegg: [(await lastOpp(PNG, "Slettes.png")).data.id] })).data;
    expect((await kall("DELETE", `/api/org/${org}/fakturaer/${utkast.id}`)).status).toBe(204);

    // Avtalen som ble fjernet fra utkastet tidligere, og bildet på det slettede utkastet.
    expect(await ryddVedlegg()).toBe(2);
    expect(slettet).toEqual(expect.arrayContaining([`test-filer/${org}/vedlegg/${utkast.vedlegg[0].id}`]));
    expect(filer.has(`test-filer/${org}/vedlegg/${utkast.vedlegg[0].id}`)).toBe(false);
    expect(await somSystem((db) => alle(db, "select * from faktura.slettede_filer"))).toEqual([]);
    expect(await ryddVedlegg()).toBe(0);
    // Vedleggene på utstedte fakturaer står.
    const igjen = await somSystem((db) => alle<{ n: number }>(db, "select count(*)::int as n from faktura.vedlegg v join faktura.fakturaer f on f.id = v.faktura_id where f.org_id = $1 and f.status <> 'utkast'", [org]));
    expect(igjen[0]!.n).toBe(3);
  });
});
