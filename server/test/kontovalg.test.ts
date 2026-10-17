// Kontoen (og avsenderen) som er valgt for en faktura, følger med når fakturaen sendes fra
// gjentakelsen («Send nå» og den daglige jobben) og fra en påminnelse, også når utkastet lagres
// på nytt uten kontoen (0107_paaminnelse_konto.sql).
import { describe, expect, it, beforeAll } from "vitest";
import { lagApi } from "../src/api.js";
import { en, somSystem } from "../src/db.js";
import { settLokalOppgavekjorer } from "../src/tjenester.js";
import { gjenta } from "../src/worker.js";

describe.skipIf(!process.env.DATABASE_URL)("Kontoen fra gjentakelser og påminnelser", () => {
  const app = lagApi();
  const eier = "Bearer test:uid-kontogjenta:kontogjenta@server.test:mfa";
  let org: string;
  let kunde: string;
  let konto: string;
  const KONTONR = "12345678903"; // den ekstra kontoen (standarden er 86011117947)

  const kall = async (m: string, sti: string, k?: unknown) => {
    const r = await app.request(sti, { method: m, headers: { authorization: eier, "content-type": "application/json" }, body: k === undefined ? undefined : JSON.stringify(k) });
    const type = r.headers.get("content-type") ?? "";
    return { status: r.status, data: type.includes("json") ? ((await r.json()) as any) : null };
  };
  const linjer = [{ beskrivelse: "Husleie", antall: 1, enhet: "mnd", enhetspris: 10000, mva_sats: 0 }];
  const faktura = async (id: string) => (await kall("GET", `/api/org/${org}/fakturaer/${id}`)).data;

  beforeAll(async () => {
    settLokalOppgavekjorer(async () => {});
    org = (await kall("POST", "/api/organisasjoner", { navn: "Kontogjenta AS", orgnr: "811000515" })).data.id;
    expect((await kall("PATCH", `/api/org/${org}`, { kontonr: "86011117947", innehaver: "Kari Nordmann" })).status).toBe(200);
    konto = (await kall("POST", `/api/org/${org}/kontoer`, { navn: "Husleiekonto", kontonr: KONTONR })).data.id;
    kunde = (await kall("POST", `/api/org/${org}/kunder`, { navn: "Leietaker AS", epost: "leie@test.no" })).data.id;
  });

  it("gjentakelsen fra en faktura bruker kontoen fakturaen fikk (Send nå)", async () => {
    const f = await kall("POST", `/api/org/${org}/fakturaer`, {
      kunde_id: kunde,
      forfallsdato: "2026-10-20",
      konto_id: konto,
      avsender: "innehaver",
      gjenta: { intervall: "maaned", neste_forfall: "2026-11-20" },
      linjer,
    });
    expect(f.status).toBe(201);
    const u = (await kall("POST", `/api/org/${org}/fakturaer/${f.data.id}/utsted`, { send_epost: false })).data;
    expect(u.selger.kontonr).toBe(KONTONR);
    const g = ((await kall("GET", `/api/org/${org}/gjentakelser`)).data as any[]).find((x) => x.id === u.gjentakelse_id);
    expect(g).toMatchObject({ konto_id: konto, avsender: "innehaver" });

    const ny = await kall("POST", `/api/org/${org}/gjentakelser/${g.id}/kjor`);
    expect(ny.status).toBe(201);
    expect(ny.data).toMatchObject({ konto_id: konto, avsender: "innehaver" });
    expect(ny.data.selger).toMatchObject({ kontonr: KONTONR, navn: "Kari Nordmann" });
  });

  it("den daglige jobben bruker kontoen på gjentakelsen", async () => {
    const g = await kall("POST", `/api/org/${org}/gjentakelser`, {
      kunde_id: kunde,
      linjer,
      intervall: "maaned",
      forfall_dag: 1,
      neste_forfall: (await somSystem((db) => en<{ d: string }>(db, "select to_char(faktura.i_dag(), 'YYYY-MM-DD') as d")))!.d,
      send_dager_foer: 0,
      konto_id: konto,
    });
    expect(g.status).toBe(201);
    await gjenta();
    const f = await somSystem((db) => en<{ id: string }>(db, "select id from faktura.fakturaer where gjentakelse_id = $1", [g.data.id]));
    expect(f).toBeTruthy();
    const ny = await faktura(f!.id);
    expect(ny.konto_id).toBe(konto);
    expect(ny.selger.kontonr).toBe(KONTONR);
  });

  it("påminnelsen husker kontoen og avsenderen, og kan settes tilbake til standard", async () => {
    const p = await kall("POST", `/api/org/${org}/paaminnelser`, {
      tekst: "Send husleie til Leietaker AS",
      kunde_id: kunde,
      intervall: "maaned",
      neste_dato: "2027-01-01",
      konto_id: konto,
      avsender: "innehaver",
    });
    expect(p.status).toBe(201);
    expect(p.data).toMatchObject({ konto_id: konto, avsender: "innehaver" });
    expect((await kall("GET", `/api/org/${org}/paaminnelser/${p.data.id}`)).data).toMatchObject({ konto_id: konto, avsender: "innehaver" });

    // Endres noe annet, står kontoen; null gir standard igjen.
    expect((await kall("PATCH", `/api/org/${org}/paaminnelser/${p.data.id}`, { tekst: "Husleie" })).data).toMatchObject({ konto_id: konto, avsender: "innehaver" });
    expect((await kall("PATCH", `/api/org/${org}/paaminnelser/${p.data.id}`, { konto_id: null, avsender: null })).data).toMatchObject({ konto_id: null, avsender: null });

    // Bare organisasjonens egne kontoer.
    const annen = (await kall("POST", "/api/organisasjoner", { navn: "Annen kontogjenta AS", orgnr: "811000523" })).data.id;
    const fremmed = (await kall("POST", `/api/org/${annen}/kontoer`, { navn: "Fremmed", kontonr: KONTONR })).data.id;
    expect((await kall("PATCH", `/api/org/${org}/paaminnelser/${p.data.id}`, { konto_id: fremmed })).status).toBe(409);
    expect((await kall("PATCH", `/api/org/${org}/paaminnelser/${p.data.id}`, { avsender: "kari" })).status).toBe(400);
  });

  it("fakturaen fra påminnelsen får kontoen, også når utkastet lagres på nytt uten den", async () => {
    // Som siden for påminnelsen: utkastet lagres med kontoen, sendingen feiler, og utkastet
    // lagres på nytt (en eldre app sendte ikke kontoen med da).
    const f = await kall("POST", `/api/org/${org}/fakturaer`, { kunde_id: kunde, konto_id: konto, avsender: "innehaver", linjer });
    expect(f.status).toBe(201);
    expect(f.data).toMatchObject({ konto_id: konto, avsender: "innehaver" });
    const lagret = await kall("PUT", `/api/org/${org}/fakturaer/${f.data.id}`, { kunde_id: kunde, linjer });
    expect(lagret.status).toBe(200);
    expect(lagret.data).toMatchObject({ konto_id: konto, avsender: "innehaver" });

    // Null betyr standard, og kontoen kan velges igjen.
    expect((await kall("PUT", `/api/org/${org}/fakturaer/${f.data.id}`, { kunde_id: kunde, linjer, konto_id: null, avsender: null })).data).toMatchObject({
      konto_id: null,
      avsender: null,
    });
    expect((await kall("PUT", `/api/org/${org}/fakturaer/${f.data.id}`, { kunde_id: kunde, linjer, konto_id: konto, avsender: "innehaver" })).data).toMatchObject({
      konto_id: konto,
      avsender: "innehaver",
    });

    const u = await kall("POST", `/api/org/${org}/fakturaer/${f.data.id}/utsted`, { send_epost: false });
    expect(u.status).toBe(200);
    expect(u.data.selger).toMatchObject({ kontonr: KONTONR, navn: "Kari Nordmann" });
  });
});
