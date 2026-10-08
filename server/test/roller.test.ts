// Roller (0056_roller.sql): organisasjonen lager rollene selv, f.eks. lege og sekretær, og en
// rolle kan være for dem som ikke er ansatt (f.eks. leger som er aksjonærer). De er med i
// vaktplanen som de andre, men arbeidsmiljølovens advarsler (overtid, hvile) gjelder ikke dem, og
// de har ingen ekstratimer og ingen feriebank. Overlapp sjekkes fortsatt.
import { beforeAll, describe, expect, it } from "vitest";
import { lagApi } from "../src/api.js";
import { settLokalOppgavekjorer } from "../src/tjenester.js";
import { helligdag } from "../src/helligdager.js";
import { uke } from "../src/arbeidstid.js";

const iDag = () => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Oslo" }).format(new Date());
const pluss = (d: string, n: number) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

describe.skipIf(!process.env.DATABASE_URL)("Roller", () => {
  const app = lagApi();
  const eier = "Bearer test:uid-rolle-eier:rolle-eier@server.test:mfa";
  let org: string;
  let ola: string;
  let lise: string;
  let lege: string;
  let sekretaer: string;
  // En hverdag uten helligdag neste uke.
  let dag = pluss(uke(pluss(iDag(), 7)).fra, 1);

  const kall = async (m: string, sti: string, k?: unknown) => {
    const r = await app.request(sti, { method: m, headers: { authorization: eier, "content-type": "application/json" }, body: k === undefined ? undefined : JSON.stringify(k) });
    return { status: r.status, data: (r.headers.get("content-type") ?? "").includes("json") ? ((await r.json()) as any) : null };
  };
  const person = async (id: string) => (await kall("GET", `/api/org/${org}/ansatte/${id}`)).data;

  beforeAll(async () => {
    settLokalOppgavekjorer(async () => undefined);
    while (helligdag(dag)) dag = pluss(dag, 7);
    org = (await kall("POST", "/api/organisasjoner", { navn: "Legesenteret AS" })).data.id;
    expect((await kall("PUT", `/api/org/${org}/lonn-oppsett`, { aktiv: true })).status).toBe(200);
  });

  it("rollene lages med navnet de har hos dere, og en rolle kan være for dem som ikke er ansatt", async () => {
    lege = (await kall("POST", `/api/org/${org}/ansattgrupper`, { navn: "Lege", behov: 3, ikke_ansatt: true })).data.id;
    sekretaer = (await kall("POST", `/api/org/${org}/ansattgrupper`, { navn: "Sekretær", behov: 2 })).data.id;
    expect((await kall("GET", `/api/org/${org}/ansattgrupper`)).data.map((g: any) => [g.navn, g.ikke_ansatt])).toEqual([
      ["Lege", true],
      ["Sekretær", false],
    ]);
    // Begge på tilkalling, så alle timene til en ansatt er ekstratimer.
    ola = (await kall("POST", `/api/org/${org}/ansatte`, { fornavn: "Ola", etternavn: "Sekretær", gruppe_id: sekretaer, ansettelsestype: "tilkalling", ansatt_fra: "2025-01-01" })).data.id;
    const l = await kall("POST", `/api/org/${org}/ansatte`, { fornavn: "Lise", etternavn: "Lege", gruppe_id: lege, ansettelsestype: "tilkalling", ansatt_fra: "2025-01-01" });
    expect(l.status, JSON.stringify(l.data)).toBe(201);
    lise = l.data.id;
    expect(l.data).toMatchObject({ rolle: "Lege", arbeidstaker: false });
    expect(await person(ola)).toMatchObject({ rolle: "Sekretær", arbeidstaker: true });
    // Tilknytningen fra før finnes ikke lenger; det er rollen som avgjør.
    expect((await kall("PATCH", `/api/org/${org}/ansatte/${ola}`, { tilknytning: "eier", stilling: "Sekretær" })).data).toMatchObject({ stilling: "Sekretær", arbeidstaker: true });
  });

  it("rollen med navn: den som finnes, eller en ny", async () => {
    const per = await kall("POST", `/api/org/${org}/ansatte`, { fornavn: "Per", etternavn: "Lege", rolle: "lege", ansatt_fra: "2025-01-01" });
    expect(per.data).toMatchObject({ gruppe_id: lege, rolle: "Lege", arbeidstaker: false });
    const ny = await kall("PATCH", `/api/org/${org}/ansatte/${per.data.id}`, { rolle: "sykepleier" });
    expect(ny.data).toMatchObject({ rolle: "Sykepleier", arbeidstaker: true });
    expect((await kall("GET", `/api/org/${org}/ansattgrupper`)).data.map((g: any) => g.navn)).toEqual(["Lege", "Sekretær", "Sykepleier"]);
    expect((await kall("DELETE", `/api/org/${org}/ansatte/${per.data.id}`)).status).toBe(204);
    const syk = (await kall("GET", `/api/org/${org}/ansattgrupper`)).data.find((g: any) => g.navn === "Sykepleier");
    expect((await kall("DELETE", `/api/org/${org}/ansattgrupper/${syk.id}`)).status).toBe(204);
  });

  it("arbeidsmiljølovens advarsler og ekstratimene gjelder bare de ansatte", async () => {
    for (const [ansatt, fra, til] of [
      [ola, "08:00", "22:00"],
      [lise, "08:00", "22:00"],
      [lise, "21:00", "23:00"],
    ] as const)
      expect((await kall("POST", `/api/org/${org}/vakter`, { ansatt_id: ansatt, dato: dag, fra, til })).status).toBe(201);
    const v = (await kall("GET", `/api/org/${org}/vakter?fra=${dag}&til=${dag}`)).data;
    const advarsler = (id: string) => v.vakter.filter((x: any) => x.ansatt_id === id).map((x: any) => x.advarsler);
    expect(advarsler(ola)).toEqual([[`Over 9 timer denne dagen (overtid)`]]);
    // Lise er lege uten å være ansatt: ingen overtid, men overlappet sies fortsatt.
    expect(advarsler(lise)).toEqual([["Overlapper med en annen vakt"], ["Overlapper med en annen vakt"]]);
    const e = (await kall("GET", `/api/org/${org}/ekstratimer?fra=${dag}&til=${dag}`)).data;
    expect(e.ansatte.map((a: any) => a.navn)).toEqual(["Ola Sekretær"]);
  });

  it("feriebanken er bare for de ansatte, og alle med rollen følger rollen", async () => {
    const bank = async () => (await kall("GET", `/api/org/${org}/feriebank`)).data.map((b: any) => b.navn);
    expect(await bank()).toEqual(["Ola Sekretær"]);
    // Begge er i lista over ansatte, og med i vaktplanen.
    expect((await kall("GET", `/api/org/${org}/ansatte`)).data.map((a: any) => [a.fornavn, a.rolle, a.arbeidstaker])).toEqual([
      ["Lise", "Lege", false],
      ["Ola", "Sekretær", true],
    ]);
    // Rollen blir for ansatte: Lise blir ansatt; og tilbake.
    expect((await kall("PATCH", `/api/org/${org}/ansattgrupper/${lege}`, { ikke_ansatt: false })).status).toBe(204);
    expect((await person(lise)).arbeidstaker).toBe(true);
    expect(await bank()).toEqual(["Lise Lege", "Ola Sekretær"]);
    expect((await kall("PATCH", `/api/org/${org}/ansattgrupper/${lege}`, { ikke_ansatt: true })).status).toBe(204);
    expect((await person(lise)).arbeidstaker).toBe(false);
    // Uten rolle er man ansatt.
    expect((await kall("PATCH", `/api/org/${org}/ansatte/${lise}`, { gruppe_id: null })).data).toMatchObject({ rolle: null, arbeidstaker: true });
    expect((await kall("PATCH", `/api/org/${org}/ansatte/${lise}`, { gruppe_id: lege })).data.arbeidstaker).toBe(false);
  });

  it("en rolle kan stå utenfor tavla: legene står ikke der og fordeles ikke", async () => {
    const fase = (await kall("POST", `/api/org/${org}/tavle/faser`, { navn: "Dag", fra: "08:00", til: "16:00" })).data.id;
    const resepsjon = (await kall("POST", `/api/org/${org}/tavle/oppgaver`, { navn: "Resepsjon", behov: 1 })).data.id;
    const tavla = async () => (await kall("GET", `/api/org/${org}/tavle?dato=${dag}`)).data;
    const plasser = (ansatt_id: string) => kall("PUT", `/api/org/${org}/tavle/plassering`, { dato: dag, fase_id: fase, ansatt_id, oppgave_id: resepsjon });

    // Med på tavla (standard): Lise kan plasseres.
    expect((await tavla()).ressurser.map((r: any) => r.navn).sort()).toEqual(["Lise Lege", "Ola Sekretær"]);
    expect((await plasser(lise)).status).toBe(204);
    expect((await person(lise)).tavle).toBe(true);

    // Legene tas ut av tavla: plassen hennes forsvinner, og hun står ikke der.
    expect((await kall("PATCH", `/api/org/${org}/ansattgrupper/${lege}`, { tavle: false })).status).toBe(204);
    expect((await kall("GET", `/api/org/${org}/ansattgrupper`)).data.find((g: any) => g.id === lege).tavle).toBe(false);
    expect((await person(lise)).tavle).toBe(false);
    const t = await tavla();
    expect(t.ressurser.map((r: any) => r.navn)).toEqual(["Ola Sekretær"]);
    expect(t.plasseringer).toEqual([]);
    expect((await plasser(lise)).data.error).toBe("Lise Lege er ikke med på tavla (rollen Lege)");
    // Rulleringen fordeler bare Ola.
    const r = (await kall("POST", `/api/org/${org}/tavle/rullering`, { fra: dag, til: dag })).data;
    expect(r.ansatte.map((a: any) => a.navn)).toEqual(["Ola Sekretær"]);
    // I vaktplanen er hun med som før.
    expect((await kall("GET", `/api/org/${org}/vakter?fra=${dag}&til=${dag}`)).data.vakter.some((v: any) => v.ansatt_id === lise)).toBe(true);

    // Tilbake på tavla, og ut igjen ved å få en annen rolle som ikke er med.
    expect((await kall("PATCH", `/api/org/${org}/ansattgrupper/${lege}`, { tavle: true })).status).toBe(204);
    expect((await plasser(lise)).status).toBe(204);
    const utenfor = (await kall("POST", `/api/org/${org}/ansattgrupper`, { navn: "Overlege", tavle: false })).data.id;
    expect((await kall("PATCH", `/api/org/${org}/ansatte/${lise}`, { gruppe_id: utenfor })).status).toBe(200);
    expect((await tavla()).plasseringer).toEqual([]);
  });
});
