// EHF-sending gjennom organisasjonens egen Recommand-konto: tilkobling med nøkkel,
// sending til kunder som kan ta imot EHF, kopi på e-post, e-post når EHF ikke kommer
// fram, kvittering som kommer senere, kreditnotaer og sending på nytt.
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { config } from "../src/config.js";
import { lagApi } from "../src/api.js";
import { alle, en, somSystem } from "../src/db.js";
import { settKryptering } from "../src/kryptering.js";
import { settEhfOppslag } from "../src/peppol.js";
import { settRecommandFetch } from "../src/recommand.js";
import { oppdaterEhfKoblinger, sjekkEhfLevering } from "../src/ehfSending.js";
import { lagring, settEpost, settLokalOppgavekjorer, type EpostMelding, type Oppgave } from "../src/tjenester.js";
import { sendFaktura } from "../src/worker.js";

type Kall = { metode: string; sti: string; auth: string | null; kropp: any };

describe.skipIf(!process.env.DATABASE_URL)("EHF-sending via Recommand", () => {
  const app = lagApi();
  const eier = "Bearer test:uid-ehfsend:ehfsend@server.test:mfa";
  const fremmed = "Bearer test:uid-ehfsend-2:fremmed-ehf@server.test:mfa";
  const orgnr = "923609016";
  // Små beløp: nye (uverifiserte) organisasjoner kan fakturere høyst 50 000 kr i måneden.
  const linjer = [{ beskrivelse: "Konsulentbistand", antall: 2, enhet: "time", enhetspris: 500, mva_sats: 25 }];
  const ko: (Oppgave & { oppgave_id: string })[] = [];
  const sendt: EpostMelding[] = [];
  const kall: Kall[] = [];
  // Svaret fra Recommand på neste kall (per sti-type).
  let svar: Record<string, () => Response> = {};
  let org: string;
  let ehfKunde: string;
  let epostKunde: string;

  const json = (status: number, data: unknown) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
  const selskap = { id: "c_123", name: "EHF Sender AS", enterpriseNumber: orgnr, enterpriseNumberScheme: "0192", country: "NO", isVerified: true, isSmpRecipient: false };
  const levert = (status = "delivered") => () =>
    json(200, { success: true, sentOverPeppol: true, sentOverEmail: false, id: `doc_${kall.length}`, deliveryStatus: status, deliveries: [{ channel: "peppol", address: "0192:974760673", status: status === "delivered" ? "delivered" : "pending" }] });

  const api = async (m: string, sti: string, k?: unknown, hvem = eier) => {
    const r = await app.request(sti, { method: m, headers: { authorization: hvem, "content-type": "application/json" }, body: k === undefined ? undefined : JSON.stringify(k) });
    const type = r.headers.get("content-type") ?? "";
    return { status: r.status, data: type.includes("json") ? ((await r.json()) as any) : null };
  };
  // Lager, utsteder og sender en faktura slik workeren gjør det.
  const send = async (kunde: string, ekstra: Record<string, unknown> = {}) => {
    const f = (await api("POST", `/api/org/${org}/fakturaer`, { kunde_id: kunde, deres_referanse: "Lise", linjer, ...ekstra })).data;
    const u = await api("POST", `/api/org/${org}/fakturaer/${f.id}/utsted`, { send_epost: true });
    expect(u.status).toBe(200);
    await kjor(f.id);
    return u.data;
  };
  const kjor = async (fakturaId: string, oppgave?: Oppgave & { oppgave_id: string }) => {
    const o = oppgave ?? (ko.filter((x) => x.type === "send-faktura" && x.faktura_id === fakturaId).at(-1) as any);
    await sendFaktura(o);
  };
  const sendinger = (fakturaId: string) => somSystem((db) => alle(db, "select * from faktura.ehf_sendinger where faktura_id = $1 order by opprettet", [fakturaId]));

  beforeAll(async () => {
    const c = config as any;
    c.fakturaBucket = "test-fakturaer";
    c.filerBucket = "test-filer";
    c.recommandUrl = "https://recommand.test";
    const filer = new Map<string, Uint8Array>();
    lagring.hent = async (b, sti) => filer.get(`${b}/${sti}`) ?? null;
    lagring.lagre = async (b, sti, data) => void filer.set(`${b}/${sti}`, data);
    settKryptering(async (t) => Buffer.from(`kryptert:${t}`), async (d) => d.toString().replace(/^kryptert:/, ""));
    settEpost({ async send(m) { sendt.push(m); return { id: `epost-${sendt.length}-${Math.random()}` }; } });
    settLokalOppgavekjorer(async (o) => void ko.push(o));
    settEhfOppslag(async (nr) => nr === "974760673");
    settRecommandFetch(async (url, init) => {
      const u = new URL(String(url));
      const sti = u.pathname + u.search;
      const k: Kall = { metode: init?.method ?? "GET", sti, auth: new Headers(init?.headers).get("authorization"), kropp: init?.body ? JSON.parse(String(init.body)) : null };
      kall.push(k);
      const type = sti.includes("/companies") ? "selskaper" : sti.includes("/documents/") ? "dokument" : sti.endsWith("/send") ? "send" : "?";
      const f = svar[type];
      if (!f) throw new Error(`Uventet kall til Recommand: ${sti}`);
      return f();
    });

    org = (await api("POST", "/api/organisasjoner", { navn: "EHF Sender AS" })).data.id;
    expect((await api("PATCH", `/api/org/${org}`, { kontonr: "86011117947", mva_registrert: true, adresse: "Storgata 1", postnr: "0155", poststed: "Oslo", epost: "post@ehfsender.no" })).status).toBe(200);
    ehfKunde = (await api("POST", `/api/org/${org}/kunder`, { navn: "Fjordline Logistikk AS", orgnr: "974760673", adresse: "Kaigata 5", postnr: "5003", poststed: "Bergen", epost: "faktura@fjordline.no" })).data.id;
    epostKunde = (await api("POST", `/api/org/${org}/kunder`, { navn: "Kari Hansen", type: "person", epost: "kari@hansen.no" })).data.id;
  });
  afterAll(() => settEhfOppslag(undefined));

  it("kobler til med nøkkelen fra Recommand, og sjekker den først", async () => {
    const nokkel = { nokkel_id: "key_abc123", hemmelighet: "hemmelig-verdi-123" };
    expect((await api("PUT", `/api/org/${org}/ehf`, nokkel)).data.error).toBe("Legg inn organisasjonsnummeret under Innstillinger først. EHF sendes fra det.");
    expect((await api("PATCH", `/api/org/${org}`, { orgnr })).status).toBe(200);

    svar.selskaper = () => json(401, { success: false, errors: { root: ["Unauthorized"] } });
    expect((await api("PUT", `/api/org/${org}/ehf`, nokkel)).data.error).toContain("Recommand godtok ikke nøkkelen");
    svar.selskaper = () => json(200, { success: true, companies: [] });
    expect((await api("PUT", `/api/org/${org}/ehf`, nokkel)).data.error).toBe(
      `Fant ikke selskapet med org.nr. ${orgnr} på Recommand-kontoen. Legg det inn hos Recommand med identifikatoren 0192:${orgnr}, eller bruk en nøkkel fra riktig konto.`,
    );
    expect((await api("PUT", `/api/org/${org}/ehf`, nokkel, fremmed)).status).toBe(403);

    svar.selskaper = () => json(200, { success: true, companies: [{ ...selskap, enterpriseNumber: "999999999" }, selskap] });
    const r = await api("PUT", `/api/org/${org}/ehf`, nokkel);
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ tilkoblet: true, leverandor: "recommand", nokkel_id: "key_abc123", selskap: "EHF Sender AS", orgnr, verifisert: true, tar_imot: false, siste_feil: null });
    expect(JSON.stringify(r.data)).not.toContain("hemmelig-verdi");
    expect(kall.at(-1)).toMatchObject({ metode: "GET", sti: `/api/v1/companies?enterpriseNumber=${orgnr}`, auth: `Basic ${Buffer.from("key_abc123:hemmelig-verdi-123").toString("base64")}` });
    const lagret = await somSystem((db) => en(db, "select konfig, hemmelighet_kryptert from faktura.integrasjoner where org_id = $1 and type = 'peppol'", [org]));
    expect([lagret!.konfig.selskap_id, lagret!.hemmelighet_kryptert.toString()]).toEqual(["c_123", "kryptert:hemmelig-verdi-123"]);
    expect((await api("GET", `/api/org/${org}/ehf`)).data.tilkoblet).toBe(true);
  });

  it("sender som EHF til kunder som kan ta imot det, med kopi på e-post", async () => {
    svar.send = levert();
    const f = await send(ehfKunde, { kopi_til: ["regnskap@fjordline.no"] });
    const k = kall.at(-1)!;
    expect(k).toMatchObject({ metode: "POST", sti: "/api/v1/c_123/send" });
    expect(k.kropp).toMatchObject({
      recipient: "0192:974760673",
      documentType: "xml",
      doctypeId: "urn:oasis:names:specification:ubl:schema:xsd:Invoice-2::Invoice##urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0::2.1",
      processId: "urn:fdc:peppol.eu:2017:poacc:billing:01:1.0",
    });
    expect(k.kropp.document).toContain(`<cbc:ID>${f.fakturanummer}</cbc:ID>`);
    expect(k.kropp.document).toContain('mimeCode="application/pdf"');

    // Kunden får ikke e-post; kopimottakeren og organisasjonen får en kopi.
    const e = sendt.at(-1)!;
    expect([e.til, e.kopi, e.blindkopi, e.emne]).toEqual([["regnskap@fjordline.no"], [], ["post@ehfsender.no"], `Kopi: Faktura ${f.fakturanummer} fra EHF Sender AS`]);
    expect(e.tekst).toContain("er sendt som EHF (elektronisk faktura) til Fjordline Logistikk AS. Her er en kopi.");

    const [s] = await sendinger(f.id);
    expect(s).toMatchObject({ mottaker: "0192:974760673", status: "levert", dokument_id: `doc_${kall.length}` });
    const vis = (await api("GET", `/api/org/${org}/fakturaer/${f.id}`)).data;
    expect([vis.sendt_til, vis.ehf.map((x: any) => x.status)]).toEqual(["EHF (org.nr. 974760673)", ["levert"]]);
    expect((await api("GET", `/api/org/${org}/fakturaer`)).data.find((x: any) => x.id === f.id).ehf_status).toBe("levert");

    // Samme oppgave på nytt (Cloud Tasks prøver igjen): EHF-en sendes ikke to ganger.
    const antall = kall.length;
    await kjor(f.id);
    expect(kall.length).toBe(antall);
    expect((await sendinger(f.id)).length).toBe(1);

    // Send på nytt: EHF-en kom fram, så den nye går på e-post til kunden.
    const p = await api("POST", `/api/org/${org}/fakturaer/${f.id}/send`, {});
    expect(p.data).toEqual({ ok: true, kanal: "epost" });
    await kjor(f.id);
    expect(kall.length).toBe(antall);
    expect(sendt.at(-1)!.til).toEqual(["faktura@fjordline.no"]);
  });

  it("uten kopimottakere går kopien til organisasjonen", async () => {
    svar.send = levert();
    await send(ehfKunde);
    expect([sendt.at(-1)!.til, sendt.at(-1)!.blindkopi]).toEqual([["post@ehfsender.no"], []]);
  });

  it("sender e-post i stedet når EHF ikke kommer fram", async () => {
    svar.send = () =>
      json(422, { success: false, errors: { root: ["Failed to send document over Peppol network. Recipient not found"] }, deliveryFailure: { channel: "peppol", category: "recipient_not_found" } });
    const f = await send(ehfKunde);
    expect(await sendinger(f.id)).toMatchObject([{ status: "feilet", feil_kategori: "recipient_not_found", detaljer: "Failed to send document over Peppol network. Recipient not found" }]);
    const e = sendt.at(-1)!;
    expect([e.til, e.emne]).toEqual([["faktura@fjordline.no"], `Faktura ${f.fakturanummer} fra EHF Sender AS`]);
    expect((await api("GET", `/api/org/${org}/fakturaer/${f.id}`)).data.sendt_til).toBe("faktura@fjordline.no");
  });

  it("venter på kvittering, sjekker igjen og sender e-post hvis den feilet", async () => {
    svar.send = levert("pending");
    const f = await send(ehfKunde);
    const [s] = await sendinger(f.id);
    expect(s.status).toBe("venter");
    const sjekk = ko.filter((x) => x.type === "sjekk-ehf").at(-1) as any;
    expect(sjekk.sending_id).toBe(s.id);
    const epostFor = sendt.length;

    svar.dokument = () => json(200, { success: true, document: { id: s.dokument_id, deliveryStatus: "pending", deliveries: [] } });
    await sjekkEhfLevering(sjekk);
    expect(kall.at(-1)!.sti).toBe(`/api/v1/documents/${s.dokument_id}`);
    expect((await sendinger(f.id))[0].sjekket).toBe(1);
    expect((ko.filter((x) => x.type === "sjekk-ehf").at(-1) as any).sending_id).toBe(s.id);

    svar.dokument = () =>
      json(200, {
        success: true,
        document: {
          id: s.dokument_id,
          deliveryStatus: "failed",
          deliveries: [{ channel: "peppol", address: "0192:974760673", status: "failed", failure: { category: "transport", message: "Receiver AP unavailable" } }],
        },
      });
    await sjekkEhfLevering(sjekk);
    expect(await sendinger(f.id)).toMatchObject([{ status: "feilet", feil_kategori: "transport", detaljer: "Receiver AP unavailable" }]);
    const ny = ko.at(-1) as any;
    expect(ny).toMatchObject({ type: "send-faktura", faktura_id: f.id, send_epost: true, ehf: false });
    await kjor(f.id, ny);
    expect(sendt.length).toBe(epostFor + 1);
    expect(sendt.at(-1)!.til).toEqual(["faktura@fjordline.no"]);
  });

  it("kreditnotaer sendes som EHF med henvisning til fakturaen", async () => {
    svar.send = levert();
    const f = await send(ehfKunde);
    const kn = await api("POST", `/api/org/${org}/fakturaer/${f.id}/krediter`, { send_epost: true });
    await kjor(kn.data.id);
    const k = kall.at(-1)!;
    expect(k.kropp.doctypeId).toBe(
      "urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2::CreditNote##urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0::2.1",
    );
    expect(k.kropp.document).toContain(`<cac:InvoiceDocumentReference><cbc:ID>${f.fakturanummer}</cbc:ID>`);
    expect(sendt.at(-1)!.emne).toBe(`Kopi: Kreditnota ${kn.data.fakturanummer} fra EHF Sender AS`);
  });

  it("uten svar fra Recommand sendes ingen e-post, så kunden ikke får fakturaen to ganger", async () => {
    svar.send = () => {
      throw new TypeError("fetch failed");
    };
    const epostFor = sendt.length;
    const f = await send(ehfKunde);
    expect(await sendinger(f.id)).toMatchObject([{ status: "sender", detaljer: "Fikk ikke svar fra Recommand: fetch failed" }]);
    expect(sendt.length).toBe(epostFor);
  });

  it("kunder som ikke kan ta imot EHF, får e-post som før", async () => {
    const antall = kall.length;
    const f = await send(epostKunde);
    expect(kall.length).toBe(antall);
    expect(await sendinger(f.id)).toEqual([]);
    expect(sendt.at(-1)!.til).toEqual(["kari@hansen.no"]);
  });

  it("feil med nøkkelen vises i innstillingene, og fakturaen går på e-post", async () => {
    svar.send = () => json(401, { success: false, errors: { root: ["This team cannot exchange documents"] } });
    const f = await send(ehfKunde);
    expect((await sendinger(f.id))[0].status).toBe("feilet");
    expect(sendt.at(-1)!.til).toEqual(["faktura@fjordline.no"]);
    expect((await api("GET", `/api/org/${org}/ehf`)).data.siste_feil).toBe("This team cannot exchange documents");
  });

  it("oppdaterer selskapets status og sjekker nøkkelen hver dag", async () => {
    svar.selskaper = () => json(200, { success: true, companies: [{ ...selskap, name: "EHF Sender AS (nytt navn)", isSmpRecipient: true }] });
    expect(await oppdaterEhfKoblinger()).toBeGreaterThanOrEqual(1);
    expect((await api("GET", `/api/org/${org}/ehf`)).data).toMatchObject({ selskap: "EHF Sender AS (nytt navn)", tar_imot: true, siste_feil: null });
    svar.selskaper = () => json(401, { success: false, errors: { root: ["Unauthorized"] } });
    await oppdaterEhfKoblinger();
    expect((await api("GET", `/api/org/${org}/ehf`)).data).toMatchObject({ tilkoblet: true, siste_feil: "Unauthorized" });
  });

  it("kan kobles fra", async () => {
    expect((await api("DELETE", `/api/org/${org}/ehf`)).status).toBe(204);
    expect((await api("GET", `/api/org/${org}/ehf`)).data).toEqual({ tilkoblet: false });
    const antall = kall.length;
    await send(ehfKunde);
    expect(kall.length).toBe(antall);
    expect(sendt.at(-1)!.til).toEqual(["faktura@fjordline.no"]);
  });
});
