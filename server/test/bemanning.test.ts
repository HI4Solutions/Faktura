// Bemanningskalenderen: grupper av ansatte (f.eks. sekretærer og leger) med behov per dag,
// laget for hånd eller fra stillingene, ansatte i gruppene, kurs som fraværstype, og
// fraværet med notat i vaktplanen (som kalenderen bygger på).
import { beforeAll, describe, expect, it } from "vitest";
import { lagApi } from "../src/api.js";
import { iDag } from "../src/regler.js";

const pluss = (iso: string, n: number) => new Date(Date.parse(`${iso}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

describe.skipIf(!process.env.DATABASE_URL)("bemanningskalender", () => {
  const app = lagApi();
  const eier = "Bearer test:uid-bem-api-eier:bem-api-eier@server.test:mfa";
  const aase = "Bearer test:uid-bem-api-aase:aase.bem@server.test";
  let org: string;
  let annenOrg: string;
  const id: Record<string, string> = {};

  const kall = async (m: string, sti: string, k?: unknown, hvem = eier) => {
    const r = await app.request(sti, { method: m, headers: { authorization: hvem, "content-type": "application/json" }, body: k === undefined ? undefined : JSON.stringify(k) });
    return { status: r.status, data: (r.headers.get("content-type") ?? "").includes("json") ? ((await r.json()) as any) : null };
  };

  beforeAll(async () => {
    org = (await kall("POST", "/api/organisasjoner", { navn: "Bemanning Test AS" })).data.id;
    annenOrg = (await kall("POST", "/api/organisasjoner", { navn: "Annen Bemanning AS" })).data.id;
    await kall("PUT", `/api/org/${org}/lonn-oppsett`, { aktiv: true });
    for (const [navn, stilling, epost] of [
      ["Aase", "Sekretær", "aase.bem@server.test"],
      ["Carin", "sekretær ", null],
      ["Fahim", "Lege", null],
      ["Isra", "Lege", null],
      ["Jonas", null, null],
    ] as const) {
      const a = (await kall("POST", `/api/org/${org}/ansatte`, { fornavn: navn, etternavn: "Medico", stilling, epost, ansatt_fra: pluss(iDag(), -30) })).data;
      id[navn] = a.id;
    }
    const inv = (await kall("POST", `/api/org/${org}/ansatte/${id.Aase}/inviter`)).data;
    expect((await kall("POST", "/api/invitasjoner/aksepter", { token: inv.lenke.split("/").pop() }, aase)).status).toBe(200);
  });

  it("grupper lages av eier og administrator, med behov og i den rekkefølgen de vil", async () => {
    const ny = async (k: unknown) => {
      const r = await kall("POST", `/api/org/${org}/ansattgrupper`, k);
      expect(r.status).toBe(201);
      return r.data.id as string;
    };
    id.leger = await ny({ navn: "Leger", behov: 7 });
    id.sek = await ny({ navn: "Sekretærer", kort: "Sek.", behov: 4 });
    expect((await kall("POST", `/api/org/${org}/ansattgrupper`, { navn: " " })).data.error).toBe("Skriv et navn på gruppen");
    expect((await kall("POST", `/api/org/${org}/ansattgrupper`, { navn: "Feil", behov: -1 })).data.error).toBe("Behovet kan ikke være negativt");
    expect((await kall("POST", `/api/org/${org}/ansattgrupper/rekkefolge`, { ider: [id.sek, id.leger] })).status).toBe(204);
    expect((await kall("PATCH", `/api/org/${org}/ansattgrupper/${id.leger}`, { kort: "Leg.", behov: 6 })).status).toBe(204);
    expect((await kall("GET", `/api/org/${org}/ansattgrupper`)).data.map((g: any) => [g.navn, g.kort, g.behov, g.antall])).toEqual([
      ["Sekretærer", "Sek.", 4, 0],
      ["Leger", "Leg.", 6, 0],
    ]);
    // Den ansatte ser ikke gruppene og endrer dem ikke.
    expect((await kall("GET", `/api/org/${org}/ansattgrupper`, undefined, aase)).status).toBe(403);
    expect((await kall("POST", `/api/org/${org}/ansattgrupper`, { navn: "Egen" }, aase)).status).toBe(403);
  });

  it("de ansatte settes i grupper, for hånd eller fra stillingene", async () => {
    expect((await kall("PATCH", `/api/org/${org}/ansatte/${id.Fahim}`, { gruppe_id: id.leger })).data.gruppe_id).toBe(id.leger);
    // Fra stillingene: én gruppe per stilling (store og små bokstaver og mellomrom teller ikke).
    // Fahim har gruppe fra før og blir der.
    const r = await kall("POST", `/api/org/${org}/ansattgrupper/fra-stillinger`);
    expect(r.data).toEqual({ grupper: 2, ansatte: 3 });
    const ansatte = (await kall("GET", `/api/org/${org}/ansatte`)).data as any[];
    const gruppe = (navn: string) => ansatte.find((a) => a.fornavn === navn).gruppe_id;
    expect(gruppe("Aase")).toBe(gruppe("Carin"));
    expect(gruppe("Fahim")).toBe(id.leger);
    expect(gruppe("Isra")).not.toBe(id.leger);
    expect(gruppe("Jonas")).toBeNull();
    const grupper = (await kall("GET", `/api/org/${org}/ansattgrupper`)).data as any[];
    expect(grupper.map((g) => [g.navn, g.antall])).toEqual([
      ["Sekretærer", 0],
      ["Leger", 1],
      ["Lege", 1],
      ["Sekretær", 2],
    ]);
    // Ikke en gruppe i en annen organisasjon; null tar den ansatte ut av gruppen.
    const fremmed = (await kall("POST", `/api/org/${annenOrg}/ansattgrupper`, { navn: "Fremmed" })).data.id;
    expect((await kall("PATCH", `/api/org/${org}/ansatte/${id.Jonas}`, { gruppe_id: fremmed })).data.error).toBe("Fant ikke gruppen");
    expect((await kall("PATCH", `/api/org/${org}/ansatte/${id.Isra}`, { gruppe_id: null })).data.gruppe_id).toBeNull();
  });

  it("kurs er fravær, og fraværet i vaktplanen har med notatet", async () => {
    const d = pluss(iDag(), 3);
    const f = await kall("POST", `/api/org/${org}/fravaer`, { ansatt_id: id.Fahim, type: "kurs", fra: d, til: d, notat: "Akuttmedisinkurs" });
    expect(f.status).toBe(201);
    expect(f.data).toMatchObject({ type: "kurs", ansatt_navn: "Fahim Medico" });
    expect((await kall("POST", `/api/org/${org}/fravaer`, { type: "kurs", fra: d, til: d }, aase)).data.error).toBe("Du kan bare melde sykdom selv");
    const plan = (await kall("GET", `/api/org/${org}/vakter?fra=${d}&til=${d}`)).data;
    expect(plan.fravaer).toEqual([expect.objectContaining({ ansatt_id: id.Fahim, type: "kurs", notat: "Akuttmedisinkurs" })]);
  });

  it("slettes en gruppe, står de ansatte uten gruppe", async () => {
    expect((await kall("DELETE", `/api/org/${org}/ansattgrupper/${id.leger}`)).status).toBe(204);
    expect((await kall("GET", `/api/org/${org}/ansatte/${id.Fahim}`)).data.gruppe_id).toBeNull();
    expect((await kall("DELETE", `/api/org/${org}/ansattgrupper/${id.leger}`)).status).toBe(404);
  });
});
