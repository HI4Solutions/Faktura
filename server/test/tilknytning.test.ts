// Personer som ikke er ansatt (0054_tilknytning.sql): f.eks. leger som er aksjonærer. De er med
// i vaktplanen som de ansatte, men arbeidsmiljølovens advarsler (overtid, hvile) gjelder ikke dem,
// og de har ingen ekstratimer og ingen feriebank. Overlapp sjekkes fortsatt.
import { beforeAll, describe, expect, it } from "vitest";
import { lagApi } from "../src/api.js";
import { settLokalOppgavekjorer } from "../src/tjenester.js";
import { helligdag } from "../src/helligdager.js";
import { uke } from "../src/arbeidstid.js";

const iDag = () => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Oslo" }).format(new Date());
const pluss = (d: string, n: number) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

describe.skipIf(!process.env.DATABASE_URL)("Personer som ikke er ansatt", () => {
  const app = lagApi();
  const eier = "Bearer test:uid-tilk-eier:tilk-eier@server.test:mfa";
  let org: string;
  let ola: string;
  let lise: string;
  // En hverdag uten helligdag neste uke.
  let dag = pluss(uke(pluss(iDag(), 7)).fra, 1);

  const kall = async (m: string, sti: string, k?: unknown) => {
    const r = await app.request(sti, { method: m, headers: { authorization: eier, "content-type": "application/json" }, body: k === undefined ? undefined : JSON.stringify(k) });
    return { status: r.status, data: (r.headers.get("content-type") ?? "").includes("json") ? ((await r.json()) as any) : null };
  };

  beforeAll(async () => {
    settLokalOppgavekjorer(async () => undefined);
    while (helligdag(dag)) dag = pluss(dag, 7);
    org = (await kall("POST", "/api/organisasjoner", { navn: "Legesenteret AS" })).data.id;
    expect((await kall("PUT", `/api/org/${org}/lonn-oppsett`, { aktiv: true })).status).toBe(200);
  });

  it("tilknytningen lagres, og bare de kjente verdiene godtas", async () => {
    // Begge på tilkalling, så alle timene til en ansatt er ekstratimer.
    ola = (await kall("POST", `/api/org/${org}/ansatte`, { fornavn: "Ola", etternavn: "Sekretær", ansettelsestype: "tilkalling", ansatt_fra: "2025-01-01" })).data.id;
    const l = await kall("POST", `/api/org/${org}/ansatte`, {
      fornavn: "Lise",
      etternavn: "Lege",
      stilling: "Lege",
      tilknytning: "eier",
      ansettelsestype: "tilkalling",
      ansatt_fra: "2025-01-01",
    });
    expect(l.status, JSON.stringify(l.data)).toBe(201);
    lise = l.data.id;
    expect(l.data.tilknytning).toBe("eier");
    expect((await kall("GET", `/api/org/${org}/ansatte/${ola}`)).data.tilknytning).toBe("ansatt");
    expect((await kall("POST", `/api/org/${org}/ansatte`, { fornavn: "X", etternavn: "Y", tilknytning: "frilanser" })).data.error).toBe(
      "Velg tilknytning (ansatt, eier, selvstendig eller innleid)",
    );
    expect((await kall("PATCH", `/api/org/${org}/ansatte/${lise}`, { tilknytning: "selvstendig" })).data.tilknytning).toBe("selvstendig");
    expect((await kall("PATCH", `/api/org/${org}/ansatte/${lise}`, { tilknytning: "eier" })).status).toBe(200);
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
    // Lise er aksjonær: ingen overtid, men overlappet sies fortsatt.
    expect(advarsler(lise)).toEqual([["Overlapper med en annen vakt"], ["Overlapper med en annen vakt"]]);
    const e = (await kall("GET", `/api/org/${org}/ekstratimer?fra=${dag}&til=${dag}`)).data;
    expect(e.ansatte.map((a: any) => a.navn)).toEqual(["Ola Sekretær"]);
  });

  it("feriebanken er bare for de ansatte", async () => {
    const bank = (await kall("GET", `/api/org/${org}/feriebank`)).data;
    expect(bank.map((b: any) => b.navn)).toEqual(["Ola Sekretær"]);
    // Men begge er i lista over ansatte, og med i vaktplanen.
    expect((await kall("GET", `/api/org/${org}/ansatte`)).data.map((a: any) => [a.fornavn, a.tilknytning])).toEqual([
      ["Lise", "eier"],
      ["Ola", "ansatt"],
    ]);
  });
});
