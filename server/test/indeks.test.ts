// Indeksregulering: KPI fra SSB, planlegging og varsel til kundene.
import { describe, expect, it, beforeAll } from "vitest";
import { lagApi } from "../src/api.js";
import { settLokalOppgavekjorer, type Oppgave } from "../src/tjenester.js";
import { lesJsonStat, settSsbFetch, sjekkBasis } from "../src/kpi.js";
import { kjorIndeksregulering } from "../src/indeksregulering.js";

// Slik SSB svarer fra tabell 14709 (JSON-stat 2, 2025=100), forkortet: indeksen og
// tolvmånedersendringen for hver måned.
const maaneder = ["2025M01", "2025M02", "2025M03", "2025M04", "2025M05", "2025M06", "2025M07", "2025M08", "2025M09", "2025M10", "2025M11", "2025M12", "2026M08", "2026M09"];
const indeks = [98.1, 99.5, 98.8, 99.4, 99.9, 100.1, 100.8, 100.0, 100.6, 100.7, 100.9, 101.0, 103.5, 103.0];
const ssbSvar = {
  version: "2.0",
  class: "dataset",
  id: ["ContentsCode", "Tid"],
  size: [2, maaneder.length],
  dimension: {
    ContentsCode: {
      category: {
        index: { KpiIndMnd: 0, Tolvmanedersendring: 1 },
        label: { KpiIndMnd: "Konsumprisindeks (2025=100)", Tolvmanedersendring: "12-måneders endring (prosent)" },
      },
    },
    Tid: { category: { index: Object.fromEntries(maaneder.map((m, i) => [m, i])) } },
  },
  value: [...indeks, ...indeks.map(() => 3.1)],
};

describe("KPI fra SSB", () => {
  it("leser indeksen (ikke endringen) fra JSON-stat", () => {
    const v = lesJsonStat(ssbSvar);
    expect(v).toHaveLength(14);
    expect(v.slice(-3)).toEqual([
      { maaned: "2025-12-01", verdi: 101 },
      { maaned: "2026-08-01", verdi: 103.5 },
      { maaned: "2026-09-01", verdi: 103 },
    ]);
    expect(() => lesJsonStat({ feil: true })).toThrow();
  });

  it("tåler andre koder, tid først og verdier som objekt", () => {
    const svar = {
      id: ["Tid", "Maal"],
      size: [2, 2],
      dimension: {
        Tid: { category: { index: ["2026M01", "2026M02"] } },
        Maal: { category: { index: { Endring: 0, Indeks: 1 }, label: { Endring: "Månedsendring (prosent)", Indeks: "Konsumprisindeks (2025=100)" } } },
      },
      value: { 0: 0.4, 1: 101.2, 2: 0.2, 3: 101.4 },
    };
    expect(lesJsonStat(svar)).toEqual([
      { maaned: "2026-01-01", verdi: 101.2 },
      { maaned: "2026-02-01", verdi: 101.4 },
    ]);
  });

  it("blander ikke basisår: 2025 skal ha snitt 100", () => {
    expect(() => sjekkBasis(lesJsonStat(ssbSvar))).not.toThrow();
    const gammel = { ...ssbSvar, value: [...indeks.map((x) => x * 1.35), ...indeks.map(() => 3.1)] };
    expect(() => sjekkBasis(lesJsonStat(gammel))).toThrow(/uventet basis/);
  });
});

describe.skipIf(!process.env.DATABASE_URL)("Indeksregulering", () => {
  const app = lagApi();
  const ko: Oppgave[] = [];
  const t = "Bearer test:uid-indeks:indeks@server.test:mfa";
  const kall = async (m: string, sti: string, k?: unknown) => {
    const r = await app.request(sti, { method: m, headers: { authorization: t, "content-type": "application/json" }, body: k === undefined ? undefined : JSON.stringify(k) });
    return { status: r.status, data: (await r.json().catch(() => null)) as any };
  };

  beforeAll(() => {
    settLokalOppgavekjorer(async (o) => {
      ko.push(o);
    });
    let forsok = 0;
    settSsbFetch((async (url: string | URL | Request) => {
      // Det nye API-et feiler første gang; reserven brukes.
      if (String(url).includes("/v2/") && forsok++ === 0) return new Response("nede", { status: 503 });
      return Response.json(ssbSvar);
    }) as typeof fetch);
  });

  it("planlegger regulering og varsler leietakeren", async () => {
    const org = (await kall("POST", "/api/organisasjoner", { navn: "Gårdeier AS" })).data.id;
    await kall("PATCH", `/api/org/${org}`, { kontonr: "86011117947", epost: "post@gardeier.no" });
    const kunde = (await kall("POST", `/api/org/${org}/kunder`, { navn: "Leietaker", epost: "leie@test.no" })).data.id;

    const om45 = new Date(Date.now() + 45 * 86_400_000);
    const p = await kall("POST", `/api/org/${org}/produkter`, {
      navn: "Husleie",
      enhet: "mnd",
      enhetspris: 10000,
      mva_sats: 0,
      indeks_aktiv: true,
      indeks_maaned: om45.getUTCMonth() + 1,
      indeks_basis: "2025-08-01",
    });
    expect(p.status).toBe(201);
    expect(p.data).toMatchObject({ indeks_aktiv: true, indeks_andel: 100, indeks_varsle: true });
    expect((await kall("POST", `/api/org/${org}/produkter`, { navn: "x", enhetspris: 1, indeks_aktiv: true })).status).toBe(400);

    const g = await kall("POST", `/api/org/${org}/gjentakelser`, {
      kunde_id: kunde,
      linjer: [{ produkt_id: p.data.id, beskrivelse: "Husleie", antall: 1, enhet: "mnd", enhetspris: 9500, mva_sats: 0 }],
      intervall: "maaned",
      forfall_dag: 1,
      neste_forfall: "2030-01-01",
    });
    expect(g.status).toBe(201);

    const k = await kjorIndeksregulering();
    expect(k.planlagt).toBeGreaterThanOrEqual(1);
    expect((await kall("GET", "/api/kpi")).data[0]).toEqual({ maaned: "2026-09-01", verdi: 103 });

    const varsel = ko.find((o) => o.type === "epost" && o.til[0] === "leie@test.no") as any;
    expect(varsel.emne).toContain("Varsel om indeksregulering av husleie");
    expect(varsel.tekst).toContain("9 785");
    expect(varsel.fra_navn).toBe("Gårdeier AS");
    expect(varsel.svar_til).toBe("post@gardeier.no");

    const status = await kall("GET", `/api/org/${org}/produkter/${p.data.id}/indeksregulering`);
    expect(status.data.beregning).toMatchObject({ ny_pris: 10300 });
    const r = status.data.reguleringer[0];
    expect(r).toMatchObject({ status: "planlagt", ny_pris: 10300, varslet: 1 });

    expect((await kall("POST", `/api/org/${org}/prisreguleringer/${r.id}/avbryt`)).data.status).toBe("avbrutt");
    expect((await kall("POST", `/api/org/${org}/prisreguleringer/${r.id}/avbryt`)).status).toBe(409);
  });
});
