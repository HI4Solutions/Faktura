// Integrasjonstester for API-et mot en ekte Postgres med migreringene kjørt.
// Kjøres av scripts/test-db.sh med SERVER_TESTER=1 (DATABASE_URL peker på test_api).
import { describe, expect, it, beforeAll } from "vitest";
import { lagApi } from "../src/api.js";
import { settLokalOppgavekjorer, type Oppgave } from "../src/tjenester.js";

const harDb = Boolean(process.env.DATABASE_URL);
const app = lagApi();
const ko: Oppgave[] = [];

const ola = "Bearer test:uid-ola:ola@server.test:mfa";
const per = "Bearer test:uid-per:per@server.test:mfa";

async function kall(metode: string, sti: string, token: string, kropp?: unknown) {
  const r = await app.request(sti, {
    method: metode,
    headers: { authorization: token, "content-type": "application/json" },
    body: kropp === undefined ? undefined : JSON.stringify(kropp),
  });
  const type = r.headers.get("content-type") ?? "";
  const data = type.includes("json") ? await r.json() : new Uint8Array(await r.arrayBuffer());
  return { status: r.status, data: data as any };
}

describe.skipIf(!harDb)("API", () => {
  let org: string;
  let kunde: string;
  let produkt: string;

  beforeAll(() => {
    settLokalOppgavekjorer(async (o) => {
      ko.push(o);
    });
  });

  it("krever innlogging", async () => {
    expect((await kall("GET", "/api/meg", "")).status).toBe(401);
    expect((await kall("GET", "/helse", "")).status).toBe(200);
  });

  it("oppretter organisasjon og setter opp selger", async () => {
    const o = await kall("POST", "/api/organisasjoner", ola, { navn: "Firma AS", orgnr: "923609016" });
    expect(o.status).toBe(201);
    org = o.data.id;
    const p = await kall("PATCH", `/api/org/${org}`, ola, { kontonr: "86011117947", bruk_kid: true, mva_registrert: true, standard_gebyr: 8, epost: "post@firma.no" });
    expect(p.status).toBe(200);
    expect(p.data.kontonr).toBe("86011117947");
    expect((await kall("PATCH", `/api/org/${org}`, ola, { kontonr: "123" })).status).toBe(400);
    const meg = await kall("GET", "/api/meg", ola);
    expect(meg.data.organisasjoner.map((x: any) => x.rolle)).toEqual(["eier"]);
  });

  it("lager kunde og produkt", async () => {
    const k = await kall("POST", `/api/org/${org}/kunder`, ola, { navn: "Kunde AS", orgnr: "974760673", epost: "faktura@kunde.no" });
    expect(k.status).toBe(201);
    expect(k.data.kundenummer).toBe(10001);
    kunde = k.data.id;
    const p = await kall("POST", `/api/org/${org}/produkter`, ola, { navn: "Konsulenttime", enhetspris: 1000, enhet: "time" });
    expect(p.status).toBe(201);
    produkt = p.data.id;
    expect((await kall("GET", `/api/org/${org}/kunder?sok=kunde`, ola)).data).toHaveLength(1);
  });

  it("utkast, forhåndsvisning, utstedelse, betaling og delvis kreditering", async () => {
    const f = await kall("POST", `/api/org/${org}/fakturaer`, ola, {
      kunde_id: kunde,
      gebyr: true,
      linjer: [{ produkt_id: produkt, beskrivelse: "Konsulenttime", antall: 3, enhet: "time", enhetspris: 1000, mva_sats: 25 }],
    });
    expect(f.status).toBe(201);
    expect(f.data.linjer).toHaveLength(2);
    const id = f.data.id;

    const pdf = await kall("GET", `/api/org/${org}/fakturaer/${id}/pdf`, ola);
    expect(pdf.status).toBe(200);
    expect(new TextDecoder().decode(pdf.data.slice(0, 5))).toBe("%PDF-");

    const u = await kall("POST", `/api/org/${org}/fakturaer/${id}/utsted`, ola, {});
    expect(u.status).toBe(200);
    expect(u.data.fakturanummer).toBe(1);
    expect(u.data.sum_inkl_mva).toBe(3760);
    expect(ko.at(-1)).toMatchObject({ type: "send-faktura", faktura_id: id, send_epost: true });

    expect((await kall("PUT", `/api/org/${org}/fakturaer/${id}`, ola, { kunde_id: kunde, linjer: [] })).status).toBe(409);
    expect((await kall("DELETE", `/api/org/${org}/fakturaer/${id}`, ola)).status).toBe(409);

    const idag = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Oslo" }).format(new Date());
    const b = await kall("POST", `/api/org/${org}/fakturaer/${id}/betalinger`, ola, { belop: 1000, dato: idag });
    expect(b.data.status).toBe("utstedt");

    const linje = (await kall("GET", `/api/org/${org}/fakturaer/${id}`, ola)).data.linjer[0];
    const kn = await kall("POST", `/api/org/${org}/fakturaer/${id}/krediter`, ola, { linjer: [{ linje_id: linje.id, antall: 1 }] });
    expect(kn.status).toBe(201);
    expect(kn.data.fakturanummer).toBe(2);
    expect(kn.data.sum_inkl_mva).toBe(-1250);

    const rest = await kall("POST", `/api/org/${org}/fakturaer/${id}/betalinger`, ola, { belop: 1510, dato: idag });
    expect(rest.data.status).toBe("betalt");

    const detaljer = await kall("GET", `/api/org/${org}/fakturaer/${id}`, ola);
    expect(detaljer.data.betalinger).toHaveLength(2);
    expect(detaljer.data.kreditnotaer).toHaveLength(1);

    const liste = await kall("GET", `/api/org/${org}/fakturaer`, ola);
    expect(liste.data.map((x: any) => x.fakturanummer)).toEqual([2, 1]);
  });

  it("feil fra databasen blir riktige HTTP-statuser", async () => {
    const f = await kall("POST", `/api/org/${org}/fakturaer`, ola, { kunde_id: kunde, linjer: [] });
    expect((await kall("POST", `/api/org/${org}/fakturaer/${f.data.id}/utsted`, ola, {})).status).toBe(400);
    expect((await kall("POST", `/api/org/${org}/fakturaer`, ola, { kunde_id: "ikke-uuid", linjer: [] })).status).toBe(400);
  });

  it("andre brukere ser ingenting", async () => {
    expect((await kall("GET", "/api/meg", per)).data.organisasjoner).toEqual([]);
    expect((await kall("GET", `/api/org/${org}/fakturaer`, per)).data).toEqual([]);
    expect((await kall("GET", `/api/org/${org}`, per)).status).toBe(404);
    expect((await kall("POST", `/api/org/${org}/kunder`, per, { navn: "Inntrenger" })).status).toBe(403);
  });

  it("invitasjon gir medlemskap", async () => {
    const inv = await kall("POST", `/api/org/${org}/invitasjoner`, ola, { epost: "per@server.test", rolle: "les" });
    expect(inv.status).toBe(201);
    const token = inv.data.lenke.split("/").pop();
    expect((await kall("POST", "/api/invitasjoner/aksepter", per, { token })).status).toBe(200);
    expect((await kall("GET", `/api/org/${org}/fakturaer`, per)).data.length).toBeGreaterThan(0);
    expect((await kall("POST", `/api/org/${org}/kunder`, per, { navn: "Les kan ikke skrive" })).status).toBe(403);
    expect((await kall("GET", `/api/org/${org}/medlemmer`, ola)).data).toHaveLength(2);
  });
});
