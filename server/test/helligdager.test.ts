// Norske helligdager (server/src/helligdager.ts): de tolv dagene med navn, likt med
// faktura.helligdager i databasen for mange år, og at de faste arbeidsdagene ikke gjelder på en
// helligdag (timene den dagen er ekstra).
import { beforeAll, describe, expect, it } from "vitest";
import { helligdag, helligdager, paaskedag } from "../src/helligdager.js";
import { lagApi } from "../src/api.js";
import { somBruker } from "../src/db.js";

describe("helligdagene", () => {
  it("påsken og de tolv dagene", () => {
    expect([2024, 2025, 2026, 2027, 2038].map(paaskedag)).toEqual(["2024-03-31", "2025-04-20", "2026-04-05", "2027-03-28", "2038-04-25"]);
    expect([...helligdager(2026)]).toEqual([
      ["2026-01-01", "1. nyttårsdag"],
      ["2026-04-02", "Skjærtorsdag"],
      ["2026-04-03", "Langfredag"],
      ["2026-04-05", "1. påskedag"],
      ["2026-04-06", "2. påskedag"],
      ["2026-05-01", "Arbeidernes dag"],
      ["2026-05-17", "Grunnlovsdag"],
      ["2026-05-14", "Kristi himmelfartsdag"],
      ["2026-05-24", "1. pinsedag"],
      ["2026-05-25", "2. pinsedag"],
      ["2026-12-25", "1. juledag"],
      ["2026-12-26", "2. juledag"],
    ]);
    expect([helligdag("2026-05-17"), helligdag("2026-05-18"), helligdag("2026-12-24")]).toEqual(["Grunnlovsdag", null, null]);
    // To på samme dag: begge navnene.
    expect(helligdag("2008-05-01")).toBe("Arbeidernes dag og Kristi himmelfartsdag");
    expect(helligdag("2027-05-17")).toBe("Grunnlovsdag og 2. pinsedag");
  });
});

describe.skipIf(!process.env.DATABASE_URL)("helligdagene i databasen og i arbeidsplanen", () => {
  const app = lagApi();
  const eier = "Bearer test:uid-hellig-eier:hellig-eier@server.test:mfa";
  let org: string;
  let mari: string;
  const kall = async (m: string, sti: string, k?: unknown) => {
    const r = await app.request(sti, { method: m, headers: { authorization: eier, "content-type": "application/json" }, body: k === undefined ? undefined : JSON.stringify(k) });
    return { status: r.status, data: (await r.json()) as any };
  };

  beforeAll(async () => {
    org = (await kall("POST", "/api/organisasjoner", { navn: "Helligdag AS" })).data.id;
    await kall("PUT", `/api/org/${org}/lonn-oppsett`, { aktiv: true });
    mari = (await kall("POST", `/api/org/${org}/ansatte`, { fornavn: "Mari", etternavn: "Mai", ansatt_fra: "2026-01-01" })).data.id;
    // Hele dager mandag til fredag.
    await kall("PUT", `/api/org/${org}/ansatte/${mari}/arbeidsplan`, { gjelder_fra: "2026-01-01", dager: [1, 2, 3, 4, 5].map((ukedag) => ({ ukedag })) });
  });

  it("likt med faktura.helligdager", async () => {
    const meg = (await kall("GET", "/api/meg")).data.bruker.id;
    const db = await somBruker(meg, (d) => d.query("select aar, array_agg(to_char(x, 'YYYY-MM-DD') order by x) as dager from generate_series(1990, 2100) aar, faktura.helligdager(aar) x group by aar"));
    for (const r of db.rows) expect([...helligdager(r.aar).keys()].sort(), String(r.aar)).toEqual([...new Set(r.dager)].sort());
  });

  it("en fast dag gjelder ikke på en helligdag, og timene den dagen er ekstra", async () => {
    // Uka med Kristi himmelfartsdag (torsdag 14. mai 2026).
    const uka = (await kall("GET", `/api/org/${org}/vakter?fra=2026-05-11&til=2026-05-17`)).data;
    expect(uka.faste.map((f: any) => f.dato)).toEqual(["2026-05-11", "2026-05-12", "2026-05-13", "2026-05-15"]);
    expect(uka.uker.find((u: any) => u.ansatt_id === mari)).toMatchObject({ planlagt: 30 });
    await kall("POST", `/api/org/${org}/vakter`, { ansatt_id: mari, dato: "2026-05-14", fra: "10:00", til: "14:00" });
    const etter = (await kall("GET", `/api/org/${org}/vakter?fra=2026-05-11&til=2026-05-17`)).data;
    expect(etter.ekstra.filter((e: any) => e.ansatt_id === mari).map((e: any) => [e.dato, e.timer])).toEqual([["2026-05-14", 4]]);
    expect((await kall("POST", `/api/org/${org}/vakter/fra-plan`, { ansatt_id: mari, dato: "2026-05-25" })).data.error).toBe("Den ansatte har ingen fast arbeidsdag denne dagen");
  });
});
