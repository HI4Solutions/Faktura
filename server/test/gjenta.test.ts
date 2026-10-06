// En faktura kan gjøres gjentakende mens den lages; gjentakelsen opprettes når den sendes.
import { describe, expect, it, beforeAll } from "vitest";
import { lagApi } from "../src/api.js";
import { en, somSystem } from "../src/db.js";
import { settLokalOppgavekjorer } from "../src/tjenester.js";

describe.skipIf(!process.env.DATABASE_URL)("Gjenta fakturaen", () => {
  const app = lagApi();
  const eier = "Bearer test:uid-gjenta:gjenta@server.test:mfa";
  let org: string;
  let kunde: string;

  const kall = async (m: string, sti: string, k?: unknown) => {
    const r = await app.request(sti, { method: m, headers: { authorization: eier, "content-type": "application/json" }, body: k === undefined ? undefined : JSON.stringify(k) });
    const type = r.headers.get("content-type") ?? "";
    return { status: r.status, data: type.includes("json") ? ((await r.json()) as any) : null };
  };
  const linjer = [
    { beskrivelse: "Husleie", antall: 1, enhet: "mnd", enhetspris: 10000, mva_sats: 0, rabatt_prosent: 10 },
    { beskrivelse: "Parkering", antall: 1, enhet: "mnd", enhetspris: 950, mva_sats: 25, rabatt_belop: 50 },
  ];
  const gjentakelser = async () => (await kall("GET", `/api/org/${org}/gjentakelser`)).data as any[];

  beforeAll(async () => {
    settLokalOppgavekjorer(async () => {});
    org = (await kall("POST", "/api/organisasjoner", { navn: "Gjenta AS" })).data.id;
    expect((await kall("PATCH", `/api/org/${org}`, { kontonr: "86011117947", mva_registrert: true, innehaver: "Ola Nordmann" })).status).toBe(200);
    kunde = (await kall("POST", `/api/org/${org}/kunder`, { navn: "Leietaker AS", epost: "leie@test.no", deres_referanse: "Standard ref" })).data.id;
  });

  it("lager gjentakelse med det samme innholdet når fakturaen sendes", async () => {
    const f = await kall("POST", `/api/org/${org}/fakturaer`, {
      kunde_id: kunde,
      fakturadato: "2026-10-06",
      forfallsdato: "2026-10-20",
      kommentar: "Husleie for leilighet 2B",
      avsender: "innehaver",
      kopi_til: ["regnskap@test.no"],
      gjenta: { intervall: "maaned", neste_forfall: "2026-11-20", send_dager_foer: 10 },
      linjer,
    });
    expect(f.status).toBe(201);
    expect((await gjentakelser()).length).toBe(0); // ikke før den sendes

    const u = (await kall("POST", `/api/org/${org}/fakturaer/${f.data.id}/utsted`, { send_epost: false })).data;
    expect(u.gjentakelse_id).toBeTruthy();
    const [g] = await gjentakelser();
    expect(g).toMatchObject({
      id: u.gjentakelse_id,
      kunde_id: kunde,
      intervall: "maaned",
      forfall_dag: 20,
      neste_forfall: "2026-11-20",
      neste_dato: "2026-11-10",
      send_dager_foer: 10,
      aktiv: true,
      deres_referanse: null, // kundens standard brukes på hver faktura
      kommentar: "Husleie for leilighet 2B",
      avsender: "innehaver",
      kopi_til: ["regnskap@test.no"],
    });
    expect(g.linjer.map((l: any) => [l.beskrivelse, Number(l.enhetspris), l.rabatt_prosent ?? null, l.rabatt_belop ?? null])).toEqual([
      ["Husleie", 10000, 10, null],
      ["Parkering", 950, null, 50],
    ]);

    // Neste faktura fra gjentakelsen har samme beløp, notat og avsender.
    const neste = await somSystem((db) => en(db, "select faktura.lag_fra_gjentakelse($1) as id", [g.id]));
    const nf = (await kall("GET", `/api/org/${org}/fakturaer/${neste!.id}`)).data;
    expect([nf.kommentar, nf.avsender, nf.kopi_til, nf.forfallsdato]).toEqual(["Husleie for leilighet 2B", "innehaver", ["regnskap@test.no"], "2026-11-20"]);
    const fra = await kall("POST", `/api/org/${org}/fakturaer/${neste!.id}/utsted`, { send_epost: false });
    expect(Number(fra.data.sum_inkl_mva)).toBe(Number(u.sum_inkl_mva));
    expect((await gjentakelser()).length).toBe(1); // fakturaen fra gjentakelsen lager ikke en ny
  });

  it("standard: ett intervall etter forfall, og utkast sendt fra lista", async () => {
    const f = await kall("POST", `/api/org/${org}/fakturaer`, {
      kunde_id: kunde,
      fakturadato: "2026-01-15",
      forfallsdato: "2026-01-31",
      gjenta: { intervall: "kvartal" },
      linjer: [linjer[0]],
    });
    const r = await kall("POST", `/api/org/${org}/fakturaer/utsted-flere`, { ider: [f.data.id], send_epost: false });
    expect(r.status).toBe(200);
    const g = (await gjentakelser()).find((x) => x.intervall === "kvartal");
    expect([g.neste_forfall, g.forfall_dag, g.send_dager_foer]).toEqual(["2026-04-30", 31, 14]);
  });

  it("neste forfall må være etter fakturaens forfall, og valget kan fjernes før sending", async () => {
    const f = await kall("POST", `/api/org/${org}/fakturaer`, {
      kunde_id: kunde,
      forfallsdato: "2026-10-20",
      gjenta: { intervall: "maaned", neste_forfall: "2026-10-20" },
      linjer,
    });
    const feil = await kall("POST", `/api/org/${org}/fakturaer/${f.data.id}/utsted`, { send_epost: false });
    expect([feil.status, feil.data.error]).toEqual([400, "Neste forfall for gjentakelsen må være etter forfallsdatoen på fakturaen (20.10.2026)"]);
    expect((await kall("GET", `/api/org/${org}/fakturaer/${f.data.id}`)).data.status).toBe("utkast");

    const antall = (await gjentakelser()).length;
    await kall("PUT", `/api/org/${org}/fakturaer/${f.data.id}`, { kunde_id: kunde, forfallsdato: "2026-10-20", gjenta: null, linjer });
    expect((await kall("POST", `/api/org/${org}/fakturaer/${f.data.id}/utsted`, { send_epost: false })).status).toBe(200);
    expect((await gjentakelser()).length).toBe(antall);
    expect((await kall("POST", `/api/org/${org}/fakturaer`, { kunde_id: kunde, gjenta: { intervall: "uke" }, linjer })).status).toBe(400);
  });
});
