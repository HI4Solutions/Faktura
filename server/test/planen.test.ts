// De ansatte ser hele planen (0063_ansatte_ser_planen.sql): den publiserte vaktplanen med
// kollegaene, de faste dagene, rollene og tavla, bare til lesing. Notatene på kollegaenes vakter,
// typen fravær og stillingsprosenten deres ser de ikke, heller ikke utkast eller ansattregisteret.
// Den som bare fakturerer, ser ikke planen.
import { beforeAll, describe, expect, it } from "vitest";
import { lagApi } from "../src/api.js";
import { uke } from "../src/arbeidstid.js";
import { helligdag } from "../src/helligdager.js";
import { iDag } from "../src/regler.js";
import { settLokalOppgavekjorer } from "../src/tjenester.js";

const pluss = (iso: string, n: number) => new Date(Date.parse(`${iso}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

describe.skipIf(!process.env.DATABASE_URL)("de ansatte ser planen", () => {
  const app = lagApi();
  const eier = "Bearer test:uid-planen-api-eier:planen-eier@server.test:mfa";
  const ola = "Bearer test:uid-planen-api-ola:ola.planen@server.test";
  const kari = "Bearer test:uid-planen-api-kari:kari.planen@server.test";
  const fakturerer = "Bearer test:uid-planen-api-fakt:planen-fakt@server.test:mfa";
  let org: string;
  const id: Record<string, string> = {};
  // Neste uke (alltid fram i tid), og en dag i den uten helligdag til Karis faste dag.
  const M = uke(pluss(iDag(), 7)).fra;
  const d = (n: number) => pluss(M, n);
  const fastDag = [2, 3, 4, 5, 6].find((n) => !helligdag(d(n)))!;
  const syk = fastDag === 6 ? 5 : 6;

  const kall = async (m: string, sti: string, k?: unknown, hvem = eier) => {
    const r = await app.request(sti, { method: m, headers: { authorization: hvem, "content-type": "application/json" }, body: k === undefined ? undefined : JSON.stringify(k) });
    return { status: r.status, data: (r.headers.get("content-type") ?? "").includes("json") ? ((await r.json()) as any) : null };
  };

  beforeAll(async () => {
    settLokalOppgavekjorer(async () => {});
    org = (await kall("POST", "/api/organisasjoner", { navn: "Planen Test AS" })).data.id;
    await kall("PUT", `/api/org/${org}/lonn-oppsett`, { aktiv: true });
    for (const [navn, hvem, ekstra] of [
      ["Ola", ola, { stilling: "Helsesekretær", stillingsprosent: 80 }],
      ["Kari", kari, { stilling: "Sekretær", stillingsprosent: 60 }],
    ] as const) {
      const a = (
        await kall("POST", `/api/org/${org}/ansatte`, { fornavn: navn, etternavn: "Plan", epost: `${navn.toLowerCase()}.planen@server.test`, ansatt_fra: pluss(iDag(), -30), rolle: "Sekretær", ...ekstra })
      ).data;
      const inv = (await kall("POST", `/api/org/${org}/ansatte/${a.id}/inviter`)).data;
      expect((await kall("POST", "/api/invitasjoner/aksepter", { token: inv.lenke.split("/").pop() }, hvem)).status).toBe(200);
      id[navn] = a.id;
    }
    // Mandag: begge på jobb (med notater), publisert; et utkast for Kari tirsdag. Kari har en fast
    // dag, er syk en annen dag, og står i resepsjonen på tavla mandag.
    expect((await kall("POST", `/api/org/${org}/vakter`, { ansatt_id: id.Ola, dato: d(0), fra: "08:00", til: "16:00", notat: "Ta med nøkkelen" })).status).toBe(201);
    expect((await kall("POST", `/api/org/${org}/vakter`, { ansatt_id: id.Kari, dato: d(0), fra: "08:00", til: "16:00", notat: "Legetime kl. 14" })).status).toBe(201);
    expect((await kall("POST", `/api/org/${org}/vakter`, { dato: d(1), fra: "16:00", til: "20:00", oppgave: "Lab" })).status).toBe(201);
    await kall("POST", `/api/org/${org}/vakter/publiser`, { fra: d(0), til: d(6) });
    expect((await kall("POST", `/api/org/${org}/vakter`, { ansatt_id: id.Kari, dato: d(1), fra: "08:00", til: "12:00", oppgave: "Utkast" })).status).toBe(201);
    expect((await kall("PUT", `/api/org/${org}/ansatte/${id.Kari}/arbeidsplan`, { gjelder_fra: pluss(iDag(), -30), dager: [{ ukedag: fastDag + 1 }] })).status).toBe(200);
    expect((await kall("POST", `/api/org/${org}/fravaer`, { ansatt_id: id.Kari, type: "syk", fra: d(syk), til: d(syk), notat: "Influensa" })).status).toBe(201);
    id.fase = (await kall("POST", `/api/org/${org}/tavle/faser`, { navn: "Dag", fra: "08:00", til: "16:00" })).data.id;
    id.resepsjon = (await kall("POST", `/api/org/${org}/tavle/oppgaver`, { navn: "Resepsjon" })).data.id;
    expect((await kall("PUT", `/api/org/${org}/tavle/plassering`, { dato: d(0), fase_id: id.fase, ansatt_id: id.Kari, oppgave_id: id.resepsjon })).status).toBe(204);
    const inv = await kall("POST", `/api/org/${org}/invitasjoner`, { epost: "planen-fakt@server.test", rolle: "fakturerer" });
    expect((await kall("POST", "/api/invitasjoner/aksepter", { token: inv.data.lenke.split("/").pop() }, fakturerer)).status).toBe(200);
  });

  it("vaktplanen: kollegaenes publiserte vakter og faste dager, uten notatene og typen fravær", async () => {
    const meg = (await kall("GET", "/api/meg", undefined, ola)).data.organisasjoner.find((o: any) => o.id === org);
    expect(meg).toMatchObject({ rolle: "ansatt", ansatt_id: id.Ola, ser_planen: true });

    const plan = (await kall("GET", `/api/org/${org}/vakter?fra=${d(0)}&til=${d(6)}`, undefined, ola)).data;
    expect(plan.vakter.map((v: any) => [v.ansatt_navn ?? "Ledig", v.notat, v.publisert]).sort()).toEqual([
      ["Kari Plan", null, true],
      ["Ledig", null, true],
      ["Ola Plan", "Ta med nøkkelen", true],
    ]);
    expect(plan.vakter.every((v: any) => v.advarsler.length === 0)).toBe(true);
    expect(plan).toMatchObject({ uker: [], ekstra: [], upubliserte: 0 });
    expect(plan.fravaer).toEqual([expect.objectContaining({ ansatt_id: id.Kari, ansatt_navn: "Kari Plan", type: "fravaer", notat: null, fra: d(syk) })]);
    expect(plan.faste).toEqual([expect.objectContaining({ ansatt_id: id.Kari, dato: d(fastDag) })]);

    // «Mine vakter»: bare sine egne og de ledige (uten kollegaenes faste dager og fravær).
    const mine = (await kall("GET", `/api/org/${org}/vakter?fra=${d(0)}&til=${d(6)}&ansatt=${id.Ola}&ledige=1`, undefined, ola)).data;
    expect(mine.vakter.map((v: any) => v.ansatt_id)).toEqual([id.Ola, null]);
    expect(mine).toMatchObject({ faste: [], fravaer: [] });

    // Kari ser sitt eget fravær med typen og notatet.
    const egen = (await kall("GET", `/api/org/${org}/vakter?fra=${d(0)}&til=${d(6)}`, undefined, kari)).data;
    expect(egen.fravaer).toEqual([expect.objectContaining({ ansatt_id: id.Kari, type: "syk", notat: "Influensa" })]);
    // Fraværslista og ansattregisteret er som før.
    expect((await kall("GET", `/api/org/${org}/fravaer?fra=${d(0)}&til=${d(6)}`, undefined, ola)).data).toEqual([]);
    expect((await kall("GET", `/api/org/${org}/ansatte`, undefined, ola)).status).toBe(403);
  });

  it("personene og rollene i planen, uten stillingen og stillingsprosenten til kollegaene", async () => {
    const folk = await kall("GET", `/api/org/${org}/kolleger`, undefined, ola);
    expect(folk.status).toBe(200);
    const k = folk.data.find((a: any) => a.id === id.Kari);
    const o = folk.data.find((a: any) => a.id === id.Ola);
    expect(k).toMatchObject({ fornavn: "Kari", etternavn: "Plan", rolle: "Sekretær", aktiv: true, meg: false, stilling: null, stillingsprosent: null, ansettelsestype: null });
    expect(k.forkortelse).toBeTruthy();
    expect(o).toMatchObject({ stilling: "Helsesekretær", meg: true });
    expect(Number(o.stillingsprosent)).toBe(80);
    expect(k).not.toHaveProperty("epost");
    // Eieren ser alt.
    expect(Number((await kall("GET", `/api/org/${org}/kolleger`)).data.find((a: any) => a.id === id.Kari).stillingsprosent)).toBe(60);

    const roller = await kall("GET", `/api/org/${org}/ansattgrupper`, undefined, ola);
    expect(roller.status).toBe(200);
    expect(roller.data.map((g: any) => [g.navn, g.antall])).toEqual([["Sekretær", 2]]);
  });

  it("tavla: hele dagen, men den ansatte endrer den ikke", async () => {
    const t = await kall("GET", `/api/org/${org}/tavle?dato=${d(0)}`, undefined, ola);
    expect(t.status).toBe(200);
    expect(t.data.ressurser.map((r: any) => r.navn).sort()).toEqual(["Kari Plan", "Ola Plan"]);
    expect(t.data.plasseringer).toEqual([expect.objectContaining({ ansatt_id: id.Kari, oppgave_id: id.resepsjon })]);
    expect(t.data.utelatt).toEqual([]);
    expect((await kall("PUT", `/api/org/${org}/tavle/plassering`, { dato: d(0), fase_id: id.fase, ansatt_id: id.Ola, oppgave_id: id.resepsjon }, ola)).status).toBe(403);
    expect((await kall("POST", `/api/org/${org}/vakter`, { ansatt_id: id.Ola, dato: d(2), fra: "08:00", til: "12:00" }, ola)).status).toBe(403);
  });

  it("den som bare fakturerer, ser ikke planen", async () => {
    expect((await kall("GET", "/api/meg", undefined, fakturerer)).data.organisasjoner.find((o: any) => o.id === org).ser_planen).toBe(false);
    expect((await kall("GET", `/api/org/${org}/kolleger`, undefined, fakturerer)).status).toBe(403);
    expect((await kall("GET", `/api/org/${org}/ansattgrupper`, undefined, fakturerer)).status).toBe(403);
    expect((await kall("GET", `/api/org/${org}/tavle?dato=${d(0)}`, undefined, fakturerer)).status).toBe(403);
    expect((await kall("GET", `/api/org/${org}/vakter?fra=${d(0)}&til=${d(6)}`, undefined, fakturerer)).data.vakter).toEqual([]);
  });
});
