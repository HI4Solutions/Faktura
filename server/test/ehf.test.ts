// EHF-filene valideres mot de offisielle reglene (EN 16931 + PEPPOL BIS Billing 3.0 med
// norske regler). Første kjøring kompilerer reglene (ca. et halvt minutt), deretter går det fort.
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { ehfHindring, enhetskode, lagEhf } from "../src/ehf.js";
import { config } from "../src/config.js";
import { lagApi } from "../src/api.js";
import { somSystem, en } from "../src/db.js";
import { settEhfOppslag } from "../src/peppol.js";
import { lagring, settLokalOppgavekjorer } from "../src/tjenester.js";
import { oppdaterEhf } from "../src/worker.js";
import { lagValidator, type Funn } from "./ehfValidator.js";

let valider: (xml: string) => Funn[];
beforeAll(() => {
  valider = lagValidator();
}, 300_000);

// Ingen feil og ingen advarsler, bortsett fra de som er riktige for avsenderen
// (NO-R-002: «Foretaksregisteret» skal bare stå når foretaket er registrert der).
const gyldig = (xml: string, tillatt: string[] = []) => {
  const funn = valider(xml);
  expect(funn.filter((f) => f.flagg === "fatal")).toEqual([]);
  expect(funn.filter((f) => !tillatt.includes(f.id))).toEqual([]);
};

const rund = (n: number) => Math.round(n * 100) / 100;
// Linjer slik utstedelsen regner dem (beløp og mva per linje, avrundet).
const linje = (beskrivelse: string, antall: number, enhetspris: number, mva_sats: number, enhet = "stk") => ({
  beskrivelse,
  antall,
  enhet,
  enhetspris,
  mva_sats,
  belop_eks: rund(antall * enhetspris),
  mva_belop: rund((antall * enhetspris * mva_sats) / 100),
});
const summer = (linjer: ReturnType<typeof linje>[]) => {
  const eks = rund(linjer.reduce((s, l) => s + l.belop_eks, 0));
  const mva = rund(linjer.reduce((s, l) => s + l.mva_belop, 0));
  return { sum_eks_mva: eks, mva, sum_inkl_mva: rund(eks + mva) };
};

const as = {
  navn: "Nordmann Eiendom AS",
  firmanavn: "Nordmann Eiendom AS",
  orgnr: "923609016",
  mva_registrert: true,
  foretaksregisteret: true,
  adresse: "Storgata 1\nPostboks 12",
  postnr: "0155",
  poststed: "Oslo",
  land: "NO",
  telefon: "22 22 22 22",
  epost: "post@nordmann.no",
  kontonr: "86011117947",
};
const kunde = { kundenummer: 10001, type: "firma", navn: "Fjordline Logistikk AS", orgnr: "974760673", adresse: "Kaigata 5", postnr: "5003", poststed: "Bergen", land: "NO", epost: "faktura@fjordline.no" };

function faktura(linjer: ReturnType<typeof linje>[], ekstra: Record<string, unknown> = {}) {
  return {
    type: "faktura",
    status: "utstedt",
    fakturanummer: 1043,
    fakturadato: "2026-10-06",
    forfallsdato: "2026-10-20",
    valuta: "NOK",
    kid: "0100010010439",
    deres_referanse: "Lise Hansen",
    var_referanse: "Ola",
    periode_fra: "2026-10-01",
    periode_til: "2026-10-31",
    selger: as,
    kunde,
    linjer,
    ...summer(linjer),
    ...ekstra,
  };
}
// Kreditnota: negative antall og summer, som i databasen.
function kreditnota(f: ReturnType<typeof faktura>, ekstra: Record<string, unknown> = {}) {
  const linjer = f.linjer.map((l) => linje(l.beskrivelse, -l.antall, l.enhetspris, l.mva_sats, l.enhet));
  return { ...f, type: "kreditnota", fakturanummer: 1044, fakturadato: "2026-10-08", forfallsdato: "2026-10-08", kid: null, linjer, ...summer(linjer), ...ekstra };
}

describe("EHF", () => {

  it("vanlig faktura med flere mva-satser, rabatt, KID, periode og PDF", () => {
    const f = faktura([
      linje("Husleie oktober, kontorlokale 2. etasje", 1, 14500, 0, "mnd"),
      linje("Parkeringsplass", 2, 950, 25, "mnd"),
      linje("Konsulentbistand\nGjennomgang av leiekontrakter og møte med styret", 1.5, 1250, 25, "time"),
      linje("Matvarer til møte", 1, 399.9, 15, "stk"),
      linje("Taxi", 1, 312.5, 12, "tur"),
      linje("Rabatt", 1, -500, 25),
    ]);
    const xml = lagEhf(f, { pdf: { filnavn: "Faktura-1043.pdf", data: new TextEncoder().encode("%PDF-1.4 test") } });
    gyldig(xml);
    expect(xml).toContain('<cbc:EndpointID schemeID="0192">974760673</cbc:EndpointID>');
    expect(xml).toContain("<cbc:CompanyID>NO923609016MVA</cbc:CompanyID>");
    expect(xml).toContain("<cbc:CompanyID>Foretaksregisteret</cbc:CompanyID>");
    expect(xml).toContain("<cbc:PaymentID>0100010010439</cbc:PaymentID>");
    expect(xml).toContain(`<cbc:PayableAmount currencyID="NOK">${f.sum_inkl_mva.toFixed(2)}</cbc:PayableAmount>`);
    // Rabatten har positiv pris og negativt antall.
    expect(xml).toMatch(/<cbc:InvoicedQuantity unitCode="C62">-1<\/cbc:InvoicedQuantity><cbc:LineExtensionAmount currencyID="NOK">-500.00<\/cbc:LineExtensionAmount>/);
  });

  it("enkeltpersonforetak uten mva, med innehaverens navn som avsender og uten referanse", () => {
    const f = faktura([linje("Snekkerarbeid", 7.5, 650, 0, "timer"), linje("Materialer", 1, 2340, 0)], {
      selger: { ...as, navn: "Ola Nordmann", firmanavn: "Nordmann Snekkerservice", mva_registrert: false, foretaksregisteret: false },
      kid: null,
      deres_referanse: null,
      var_referanse: null,
      periode_fra: null,
      periode_til: null,
    });
    const xml = lagEhf(f);
    gyldig(xml, ["NO-R-002"]);
    expect(xml).toContain("<cbc:ID>O</cbc:ID>");
    expect(xml).not.toContain("MVA</cbc:CompanyID>");
    expect(xml).toContain("<cbc:BuyerReference>Ikke oppgitt</cbc:BuyerReference>");
    expect(xml).toContain("<cac:PartyName><cbc:Name>Ola Nordmann</cbc:Name></cac:PartyName>");
    expect(xml).toContain("<cbc:RegistrationName>Nordmann Snekkerservice</cbc:RegistrationName>");
  });

  it("kreditnota med referanse til fakturaen og positive beløp", () => {
    const f = faktura([linje("Parkeringsplass", 2, 950, 25, "mnd"), linje("Husleie", 1, 14500, 0, "mnd"), linje("Rabatt", 1, -500, 25)]);
    const xml = lagEhf(kreditnota(f), { kreditertFaktura: { nummer: 1043, dato: "2026-10-06" }, pdf: { filnavn: "Kreditnota-1044.pdf", data: new Uint8Array([37, 80, 68, 70]) } });
    gyldig(xml);
    expect(xml).toContain("<CreditNote ");
    expect(xml).toContain("<cbc:CreditNoteTypeCode>381</cbc:CreditNoteTypeCode>");
    expect(xml).toContain("<cac:InvoiceDocumentReference><cbc:ID>1043</cbc:ID>");
    expect(xml).toContain(`<cbc:PayableAmount currencyID="NOK">${(-kreditnota(f).sum_inkl_mva).toFixed(2)}</cbc:PayableAmount>`);
  });

  it("kreditnota fra selger uten mva, og kunde uten adresse", () => {
    const f = faktura([linje("Kurs", 1, 1200, 0)], {
      selger: { ...as, mva_registrert: false, foretaksregisteret: false, adresse: null, telefon: null },
      kunde: { ...kunde, adresse: null, postnr: null, poststed: null, epost: null },
    });
    gyldig(lagEhf(f), ["NO-R-002"]);
    gyldig(lagEhf(kreditnota(f)), ["NO-R-002"]);
  });

  it("avslår fakturaer som ikke kan sendes som EHF", () => {
    const f = faktura([linje("X", 1, 100, 25)]);
    expect(ehfHindring(f)).toBe(null);
    expect(ehfHindring({ ...f, status: "utkast" })).toMatch(/ikke utstedt/);
    expect(ehfHindring({ ...f, kunde: { ...kunde, orgnr: null } })).toMatch(/kunden har organisasjonsnummer/);
    expect(ehfHindring({ ...f, selger: { ...as, orgnr: null } })).toMatch(/avsenderen har organisasjonsnummer/);
    expect(() => lagEhf({ ...f, kunde: { ...kunde, orgnr: null } })).toThrow();
  });

  it("enheter etter UN/ECE Rec 20", () => {
    expect([enhetskode("stk"), enhetskode("Time"), enhetskode("mnd"), enhetskode("m²"), enhetskode("pakke")]).toEqual(["C62", "HUR", "MON", "MTK", "C62"]);
  });
});

describe.skipIf(!process.env.DATABASE_URL)("EHF i API-et", () => {
  const app = lagApi();
  const eier = "Bearer test:uid-ehf:ehf@server.test:mfa";
  const registrert = new Set(["974760673"]);
  let svarUkjent = false;
  let org: string;

  const kall = async (m: string, sti: string, k?: unknown) => {
    const r = await app.request(sti, { method: m, headers: { authorization: eier, "content-type": "application/json" }, body: k === undefined ? undefined : JSON.stringify(k) });
    const type = r.headers.get("content-type") ?? "";
    return { status: r.status, type, data: type.includes("json") ? ((await r.json()) as any) : await r.text() };
  };
  const utstedt = async (kunde: string, linjer = [{ beskrivelse: "Husleie", antall: 1, enhet: "mnd", enhetspris: 10000, mva_sats: 25 }]) => {
    const f = await kall("POST", `/api/org/${org}/fakturaer`, { kunde_id: kunde, deres_referanse: "Lise", linjer });
    return (await kall("POST", `/api/org/${org}/fakturaer/${f.data.id}/utsted`, { send_epost: false })).data;
  };

  beforeAll(async () => {
    settEhfOppslag(async (orgnr) => (svarUkjent ? null : registrert.has(orgnr)));
    settLokalOppgavekjorer(async () => {});
    (config as any).fakturaBucket = "test-fakturaer";
    const filer = new Map<string, Uint8Array>();
    lagring.hent = async (_b, sti) => filer.get(sti) ?? null;
    lagring.lagre = async (_b, sti, data) => void filer.set(sti, data);
    org = (await kall("POST", "/api/organisasjoner", { navn: "EHF Avsender AS", orgnr: "923609016" })).data.id;
    expect((await kall("PATCH", `/api/org/${org}`, { kontonr: "86011117947", mva_registrert: true, foretaksregisteret: true, adresse: "Storgata 1", postnr: "0155", poststed: "Oslo" })).status).toBe(200);
  });
  afterAll(() => settEhfOppslag(undefined));

  it("sjekker om kunden kan motta EHF når den lagres og på forespørsel", async () => {
    const ja = await kall("POST", `/api/org/${org}/kunder`, { navn: "Fjordline Logistikk AS", orgnr: "974760673", adresse: "Kaigata 5", postnr: "5003", poststed: "Bergen" });
    expect([ja.data.ehf, Boolean(ja.data.ehf_sjekket)]).toEqual([true, true]);
    const nei = await kall("POST", `/api/org/${org}/kunder`, { navn: "Liten Butikk AS", orgnr: "986252932" });
    expect(nei.data.ehf).toBe(false);
    const person = await kall("POST", `/api/org/${org}/kunder`, { type: "person", navn: "Kari Hansen" });
    expect(person.data.ehf).toBe(null);

    // Butikken blir registrert i ELMA: ny sjekk gir nytt svar.
    registrert.add("986252932");
    expect((await kall("POST", `/api/org/${org}/kunder/${nei.data.id}/ehf`)).data.ehf).toBe(true);
    expect((await kall("POST", `/api/org/${org}/kunder/${person.data.id}/ehf`)).status).toBe(400);
    svarUkjent = true;
    expect((await kall("POST", `/api/org/${org}/kunder/${nei.data.id}/ehf`)).status).toBe(503);
    svarUkjent = false;

    // Workeren sjekker kunder som ikke er sjekket på 30 dager.
    await somSystem((db) => db.query("update faktura.kunder set ehf = null, ehf_sjekket = null where id = $1", [ja.data.id]));
    await oppdaterEhf();
    const etter = await somSystem((db) => en(db, "select ehf from faktura.kunder where id = $1", [ja.data.id]));
    expect(etter?.ehf).toBe(true);
  });

  it("gir gyldig EHF for utstedte fakturaer og kreditnotaer", async () => {
    const k = (await kall("POST", `/api/org/${org}/kunder`, { navn: "Fjordline Logistikk AS", orgnr: "974760673", adresse: "Kaigata 5", postnr: "5003", poststed: "Bergen", epost: "faktura@fjordline.no" })).data;
    const f = await utstedt(k.id, [
      { beskrivelse: "Husleie oktober", antall: 1, enhet: "mnd", enhetspris: 14500, mva_sats: 0 },
      { beskrivelse: "Parkering", antall: 2, enhet: "mnd", enhetspris: 950, mva_sats: 25 },
    ]);
    const ehf = await kall("GET", `/api/org/${org}/fakturaer/${f.id}/ehf`);
    expect(ehf.status).toBe(200);
    expect(ehf.type).toContain("application/xml");
    gyldig(ehf.data);
    expect(ehf.data).toContain(`<cbc:ID>${f.fakturanummer}</cbc:ID>`);
    expect(ehf.data).toContain('mimeCode="application/pdf"');

    const kn = await kall("POST", `/api/org/${org}/fakturaer/${f.id}/krediter`, { send_epost: false });
    const kehf = await kall("GET", `/api/org/${org}/fakturaer/${kn.data.id}/ehf`);
    expect(kehf.status).toBe(200);
    gyldig(kehf.data);
    expect(kehf.data).toContain(`<cac:InvoiceDocumentReference><cbc:ID>${f.fakturanummer}</cbc:ID>`);

    // Utkast og kunder uten org.nr. kan ikke få EHF.
    const utkast = await kall("POST", `/api/org/${org}/fakturaer`, { kunde_id: k.id, linjer: [{ beskrivelse: "X", antall: 1, enhetspris: 1, mva_sats: 25 }] });
    expect((await kall("GET", `/api/org/${org}/fakturaer/${utkast.data.id}/ehf`)).status).toBe(409);
    const person = (await kall("POST", `/api/org/${org}/kunder`, { type: "person", navn: "Kari Hansen" })).data;
    const pf = await utstedt(person.id);
    const nei = await kall("GET", `/api/org/${org}/fakturaer/${pf.id}/ehf`);
    expect([nei.status, nei.data.error]).toEqual([409, "EHF krever at kunden har organisasjonsnummer."]);
  });
});
