// Indeksregulering: KPI fra SSB, planlegging og varsel til kundene.
import { describe, expect, it, beforeAll } from "vitest";
import { lagApi } from "../src/api.js";
import { settLokalOppgavekjorer, type Oppgave } from "../src/tjenester.js";
import { lesJsonStat, settSsbFetch } from "../src/kpi.js";
import { kjorIndeksregulering } from "../src/indeksregulering.js";

// Slik SSB svarer (JSON-stat 2), forkortet.
const ssbSvar = {
  version: "2.0",
  class: "dataset",
  id: ["Konsumgrp", "ContentsCode", "Tid"],
  size: [1, 1, 3],
  dimension: {
    Konsumgrp: { category: { index: { TOTAL: 0 } } },
    ContentsCode: { category: { index: { KpiIndMnd: 0 } } },
    Tid: { category: { index: { "2025M08": 0, "2026M08": 1, "2026M09": 2 } } },
  },
  value: [100.0, 103.5, 103.0],
};

describe("KPI fra SSB", () => {
  it("leser JSON-stat", () => {
    expect(lesJsonStat(ssbSvar)).toEqual([
      { maaned: "2025-08-01", verdi: 100 },
      { maaned: "2026-08-01", verdi: 103.5 },
      { maaned: "2026-09-01", verdi: 103 },
    ]);
    expect(() => lesJsonStat({ feil: true })).toThrow();
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
