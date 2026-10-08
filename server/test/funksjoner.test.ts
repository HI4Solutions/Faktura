// Funksjoner per organisasjon: rutene til en funksjon organisasjonen ikke har, avvises, appen
// får lista over funksjonene i /meg, og bare plattformadministratoren slår dem av og på og
// styrer standarden for nye organisasjoner.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lagApi } from "../src/api.js";
import { config } from "../src/config.js";
import { funksjonerFor, glemFunksjoner, harFunksjon } from "../src/funksjoner.js";

describe("rutene og funksjonene de krever", () => {
  it("kjenner igjen stiene", () => {
    expect(funksjonerFor("/ehf")).toEqual(["ehf"]);
    expect(funksjonerFor("/kunder/abc/ehf")).toEqual(["ehf"]);
    expect(funksjonerFor("/fakturaer/abc/ehf")).toEqual(["ehf"]);
    expect(funksjonerFor("/fakturaer/abc")).toEqual([]);
    expect(funksjonerFor("/bank/hent")).toEqual(["bank"]);
    expect(funksjonerFor("/banktransaksjoner/abc/ai").sort()).toEqual(["ai", "bank"]);
    expect(funksjonerFor("/ai/assistent")).toEqual(["ai"]);
    expect(funksjonerFor("/gjentakelser/abc/kjor")).toEqual(["gjentakende"]);
    expect(funksjonerFor("/produkter/abc/indeksregulering")).toEqual(["gjentakende"]);
    expect(funksjonerFor("/fakturaer/flere")).toEqual(["flere"]);
    expect(funksjonerFor("/fakturaer/utsted-flere")).toEqual(["flere"]);
    expect(funksjonerFor("/kunder/importer")).toEqual(["import"]);
    expect(funksjonerFor("/kunder")).toEqual([]);
    expect(funksjonerFor("/eksport/fakturaer.csv")).toEqual(["rapporter"]);
    expect(funksjonerFor("/paaminnelser/abc")).toEqual(["paaminnelser"]);
    expect(funksjonerFor("/timer/lever")).toEqual(["ansatte"]);
    expect(funksjonerFor("/ansatte/abc/arbeidsplan").sort()).toEqual(["ansatte", "vaktplan"]);
    expect(funksjonerFor("/vakter/fra-plan")).toEqual(["vaktplan"]);
    expect(funksjonerFor("/ekstratimer.pdf")).toEqual(["vaktplan"]);
    expect(funksjonerFor("/tavle/mine")).toEqual(["vaktplan"]);
  });
});

describe.skipIf(!process.env.DATABASE_URL)("funksjoner per organisasjon", () => {
  const app = lagApi();
  const eier = "Bearer test:uid-funk-api-eier:funk-api-eier@server.test:mfa";
  const admin = "Bearer test:uid-funk-api-admin:funk-api-admin@server.test:mfa";
  let org: string;

  const kall = async (m: string, sti: string, k?: unknown, hvem = eier) => {
    const r = await app.request(sti, { method: m, headers: { authorization: hvem, "content-type": "application/json" }, body: k === undefined ? undefined : JSON.stringify(k) });
    const type = r.headers.get("content-type") ?? "";
    return { status: r.status, data: type.includes("json") ? ((await r.json()) as any) : await r.text() };
  };
  const meg = async () => (await kall("GET", "/api/meg")).data.organisasjoner.find((o: any) => o.id === org);

  beforeAll(async () => {
    config.adminEposter.push("funk-api-admin@server.test");
    org = (await kall("POST", "/api/organisasjoner", { navn: "Funksjoner Test AS" })).data.id;
    await kall("PUT", `/api/org/${org}/lonn-oppsett`, { aktiv: true });
  });
  afterAll(async () => {
    await kall("PUT", "/api/admin/funksjoner/ai", { standard: true }, admin);
  });

  it("en ny organisasjon har alle funksjonene, og appen får lista", async () => {
    const o = await meg();
    expect(o.funksjoner).toEqual(["ehf", "bank", "ai", "gjentakende", "flere", "paaminnelser", "rapporter", "import", "google_disk", "ansatte", "vaktplan"]);
    expect(o.personal).toBe(true);
    expect((await kall("GET", `/api/org/${org}/vakter?fra=2026-10-05&til=2026-10-11`)).status).toBe(200);
  });

  it("bare plattformadministratoren ser og endrer funksjonene", async () => {
    expect((await kall("GET", "/api/admin/funksjoner")).status).toBe(403);
    expect((await kall("PUT", `/api/admin/organisasjoner/${org}/funksjoner`, { ehf: false })).status).toBe(403);
    expect((await kall("PUT", "/api/admin/funksjoner/ehf", { standard: false })).status).toBe(403);
    const d = (await kall("GET", "/api/admin/funksjoner", undefined, admin)).data;
    expect(d.funksjoner.find((f: any) => f.kode === "vaktplan")).toMatchObject({ navn: "Vaktplan og bemanning", krever: "ansatte", standard: true });
    expect(d.organisasjoner.find((o: any) => o.id === org)).toMatchObject({ navn: "Funksjoner Test AS", aktive: expect.arrayContaining(["ehf", "bank", "vaktplan"]) });
    expect((await kall("PUT", `/api/admin/organisasjoner/${org}/funksjoner`, { finnes_ikke: true }, admin)).data.error).toBe("Ukjent funksjon");
    expect((await kall("PUT", `/api/admin/organisasjoner/${org}/funksjoner`, {}, admin)).data.error).toBe("Ingen funksjoner å endre");
  });

  it("rutene til funksjoner som er slått av, avvises, og resten virker", async () => {
    const r = await kall("PUT", `/api/admin/organisasjoner/${org}/funksjoner`, { ehf: false, bank: false, ansatte: false }, admin);
    expect(r.status).toBe(200);
    expect(r.data.aktive).not.toContain("ehf");
    const ehf = await kall("GET", `/api/org/${org}/ehf`);
    expect(ehf.status).toBe(403);
    expect(ehf.data.error).toBe("EHF er ikke slått på for organisasjonen");
    expect((await kall("GET", `/api/org/${org}/bank`)).data.error).toBe("Bank er ikke slått på for organisasjonen");
    expect((await kall("POST", `/api/org/${org}/banktransaksjoner/00000000-0000-4000-8000-000000000000/ai`)).status).toBe(403);
    expect((await kall("GET", `/api/org/${org}/ansatte`)).data.error).toBe("Ansatte og timer er ikke slått på for organisasjonen");
    // Vaktplanen står på, men bygger på ansatte og timer.
    expect((await kall("GET", `/api/org/${org}/vakter?fra=2026-10-05&til=2026-10-11`)).data.error).toBe("Ansatte og timer er ikke slått på for organisasjonen");
    expect((await kall("GET", `/api/org/${org}/fakturaer`)).status).toBe(200);
    expect((await kall("GET", `/api/org/${org}/gjentakelser`)).status).toBe(200);
    const o = await meg();
    expect(o.funksjoner).not.toContain("vaktplan");
    expect(o.funksjoner).toContain("gjentakende");
    expect(o.personal).toBe(false);
    expect(await harFunksjon(org, "bank")).toBe(false);
    expect(await harFunksjon(org, "ai")).toBe(true);
    // Slås de på igjen, virker rutene med en gang.
    await kall("PUT", `/api/admin/organisasjoner/${org}/funksjoner`, { ehf: true, ansatte: true }, admin);
    expect((await kall("GET", `/api/org/${org}/ehf`)).status).toBe(200);
    expect((await kall("GET", `/api/org/${org}/vakter?fra=2026-10-05&til=2026-10-11`)).status).toBe(200);
  });

  it("standarden for nye organisasjoner", async () => {
    expect((await kall("PUT", "/api/admin/funksjoner/ai", { standard: false }, admin)).status).toBe(204);
    const ny = (await kall("POST", "/api/organisasjoner", { navn: "Uten AI AS" })).data.id;
    glemFunksjoner();
    expect((await kall("POST", `/api/org/${ny}/ai/faktura`, { tekst: "Faktura til Ola på 1000 kr" })).data.error).toBe("AI er ikke slått på for organisasjonen");
    expect((await kall("GET", "/api/meg")).data.organisasjoner.find((o: any) => o.id === ny).funksjoner).not.toContain("ai");
    expect((await kall("GET", "/api/admin/funksjoner", undefined, admin)).data.funksjoner.find((f: any) => f.kode === "ai").standard).toBe(false);
  });
});
