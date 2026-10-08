// Fast arbeidsplan: ukedager med klokkeslett eller hel dag fra en dato, faste dager i
// vaktplanen (der det ikke er vakt), ekstratimer mot planen (eller mot avtalt arbeidstid i uka
// uten plan, og alle timene for tilkallingsvikarer), planlagte timer, tavla, vakt fra planen
// og rapporten over ekstratimer som JSON, CSV og PDF.
import { beforeAll, describe, expect, it } from "vitest";
import { lagApi } from "../src/api.js";
import { uke } from "../src/arbeidstid.js";
import { iDag } from "../src/regler.js";
import { helligdag } from "../src/helligdager.js";

const pluss = (iso: string, n: number) => new Date(Date.parse(`${iso}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

describe.skipIf(!process.env.DATABASE_URL)("fast arbeidsplan og ekstratimer", () => {
  const app = lagApi();
  const eier = "Bearer test:uid-plan-api-eier:plan-api-eier@server.test:mfa";
  const linda = "Bearer test:uid-plan-api-linda:linda.plan@server.test";
  let org: string;
  const id: Record<string, string> = {};
  // Neste uke (alltid fram i tid), mandag til søndag, og uka etter, uten helligdager: da gjelder
  // ikke de faste dagene, og testene skal gi det samme hver gang de kjøres.
  let M = uke(pluss(iDag(), 7)).fra;
  while (Array.from({ length: 14 }, (_, i) => pluss(M, i)).some(helligdag)) M = pluss(M, 7);
  const d = (n: number) => pluss(M, n);

  const kall = async (m: string, sti: string, k?: unknown, hvem = eier) => {
    const r = await app.request(sti, { method: m, headers: { authorization: hvem, "content-type": "application/json" }, body: k === undefined ? undefined : JSON.stringify(k) });
    const type = r.headers.get("content-type") ?? "";
    return { status: r.status, type, data: type.includes("json") ? ((await r.json()) as any) : type.includes("pdf") ? new Uint8Array(await r.arrayBuffer()) : await r.text() };
  };
  const vakt = async (navn: string, dag: number, fra: string, til: string, pause_min = 0) =>
    (await kall("POST", `/api/org/${org}/vakter`, { ansatt_id: id[navn], dato: d(dag), fra, til, pause_min })).data.id as string;

  beforeAll(async () => {
    org = (await kall("POST", "/api/organisasjoner", { navn: "Arbeidsplan Test AS" })).data.id;
    await kall("PUT", `/api/org/${org}/lonn-oppsett`, { aktiv: true });
    for (const [navn, ekstra] of [
      ["Linda", { stillingsprosent: 60, epost: "linda.plan@server.test" }],
      ["Ola", {}],
      ["Vera", { ansettelsestype: "tilkalling", lonnstype: "time" }],
    ] as const) {
      id[navn] = (await kall("POST", `/api/org/${org}/ansatte`, { fornavn: navn, etternavn: "Plan", ansatt_fra: pluss(iDag(), -30), ...ekstra })).data.id;
    }
    const inv = (await kall("POST", `/api/org/${org}/ansatte/${id.Linda}/inviter`)).data;
    expect((await kall("POST", "/api/invitasjoner/aksepter", { token: inv.lenke.split("/").pop() }, linda)).status).toBe(200);
  });

  it("planen lagres med hel dag eller klokkeslett, og den ansatte ser sin egen", async () => {
    const plan = (k: unknown, hvem = eier) => kall("PUT", `/api/org/${org}/ansatte/${id.Linda}/arbeidsplan`, k, hvem);
    const r = await plan({
      gjelder_fra: d(0),
      dager: [{ ukedag: 1 }, { ukedag: 3, fra: "08:00", til: "15:30" }, { ukedag: 5, fra: "08:00", til: "16:00", pause_min: 30 }],
    });
    expect(r.status).toBe(200);
    expect(r.data).toEqual([
      expect.objectContaining({
        gjelder_fra: d(0),
        dager: [
          { ukedag: 1, fra: null, til: null, pause_min: 0 },
          { ukedag: 3, fra: "08:00", til: "15:30", pause_min: 0 },
          { ukedag: 5, fra: "08:00", til: "16:00", pause_min: 30 },
        ],
      }),
    ]);
    expect((await plan({ gjelder_fra: d(0), dager: [{ ukedag: 1 }, { ukedag: 1 }] })).data.error).toBe("Hver ukedag kan bare stå én gang");
    expect((await plan({ gjelder_fra: d(0), dager: [{ ukedag: 2, fra: "08:00" }] })).data.error).toBe("Skriv både fra og til, eller velg hel dag");
    expect((await plan({ gjelder_fra: d(0), dager: [{ ukedag: 2, pause_min: 30 }] })).data.error).toBe("Pause kan bare settes sammen med klokkeslett");
    expect((await plan({ gjelder_fra: d(0), dager: [] }, linda)).status).toBe(403);
    expect((await kall("GET", `/api/org/${org}/ansatte/${id.Linda}/arbeidsplan`, undefined, linda)).data).toHaveLength(1);
    // Ukedagene som gjelder i dag, står på den ansatte (planen begynner neste uke).
    expect((await kall("GET", `/api/org/${org}/ansatte/${id.Linda}`)).data.arbeidsdager).toEqual([]);
  });

  it("de faste dagene står i vaktplanen, og en vakt den dagen gjelder i stedet", async () => {
    const plan = (await kall("GET", `/api/org/${org}/vakter?fra=${d(0)}&til=${d(6)}`)).data;
    expect(plan.faste.map((f: any) => [f.dato, f.fra, f.til, f.timer])).toEqual([
      [d(0), null, null, 7.5],
      [d(2), "08:00", "15:30", 7.5],
      [d(4), "08:00", "16:00", 7.5],
    ]);
    expect(plan.uker.find((u: any) => u.ansatt_id === id.Linda)).toMatchObject({ planlagt: 22.5 });
    // Vakt onsdag 08–19: den gjelder i stedet for planen, og 3,5 timer er ekstra.
    id.onsdag = await vakt("Linda", 2, "08:00", "19:00");
    // Vakt tirsdag (ikke i planen): alle timene er ekstra.
    await vakt("Linda", 1, "08:00", "15:30");
    const etter = (await kall("GET", `/api/org/${org}/vakter?fra=${d(0)}&til=${d(6)}`)).data;
    expect(etter.faste.map((f: any) => f.dato)).toEqual([d(0), d(4)]);
    expect(etter.ekstra.filter((e: any) => e.ansatt_id === id.Linda).map((e: any) => [e.dato, e.timer, e.plan]).sort()).toEqual([
      [d(1), 7.5, true],
      [d(2), 3.5, true],
    ]);
    // Den ansatte ser sine egne faste dager; vaktene er ikke publisert, så onsdag er fortsatt fast for henne.
    expect((await kall("GET", `/api/org/${org}/vakter?fra=${d(0)}&til=${d(6)}`, undefined, linda)).data.faste.map((f: any) => f.dato)).toEqual([d(0), d(2), d(4)]);
  });

  it("uten plan er ekstratimene timene utover avtalt arbeidstid i uka, og alle for tilkallingsvikarer", async () => {
    for (let n = 0; n < 6; n++) await vakt("Ola", n, "08:00", "15:30");
    await vakt("Vera", 3, "10:00", "14:00");
    const ekstra = (await kall("GET", `/api/org/${org}/vakter?fra=${d(0)}&til=${d(6)}`)).data.ekstra;
    expect(ekstra.filter((e: any) => e.ansatt_id === id.Ola).map((e: any) => [e.dato, e.timer, e.plan])).toEqual([[d(5), 7.5, false]]);
    expect(ekstra.filter((e: any) => e.ansatt_id === id.Vera).map((e: any) => [e.dato, e.timer, e.plan])).toEqual([[d(3), 4, false]]);
  });

  it("fravær på en fast dag teller ikke som planlagt arbeid", async () => {
    expect((await kall("POST", `/api/org/${org}/fravaer`, { ansatt_id: id.Linda, type: "syk", fra: d(4), til: d(4) })).status).toBe(201);
    const plan = (await kall("GET", `/api/org/${org}/vakter?fra=${d(0)}&til=${d(6)}`)).data;
    expect(plan.faste.find((f: any) => f.dato === d(4))).toMatchObject({ fravaer: "syk" });
    // Mandag (fast, 7,5) + tirsdag og onsdag (vakter, 7,5 + 11); fredag er hun syk.
    expect(plan.uker.find((u: any) => u.ansatt_id === id.Linda)).toMatchObject({ planlagt: 26 });
  });

  it("tavla har med dem som har fast dag, og en vakt kan lages fra planen", async () => {
    const t = (await kall("GET", `/api/org/${org}/tavle?dato=${d(0)}`)).data;
    expect(t.ressurser.find((r: any) => r.ansatt_id === id.Linda)).toMatchObject({ vakter: [expect.objectContaining({ fast: true, fra: null, til: null, timer: 7.5 })] });
    const v = await kall("POST", `/api/org/${org}/vakter/fra-plan`, { ansatt_id: id.Linda, dato: d(0) });
    expect(v.status).toBe(201);
    expect(v.data).toMatchObject({ ansatt_id: id.Linda, dato: d(0), fra: "08:00", til: "15:30", publisert: true });
    expect((await kall("POST", `/api/org/${org}/vakter/fra-plan`, { ansatt_id: id.Linda, dato: d(0) })).data.id).toBe(v.data.id);
    expect((await kall("POST", `/api/org/${org}/vakter/fra-plan`, { ansatt_id: id.Ola, dato: d(0) })).data.id).toBeTruthy(); // Ola har en vakt
    expect((await kall("POST", `/api/org/${org}/vakter/fra-plan`, { ansatt_id: id.Vera, dato: d(0) })).data.error).toBe("Den ansatte har ingen fast arbeidsdag denne dagen");
  });

  it("rapporten over ekstratimer per ansatt kan tas ut som JSON, CSV og PDF", async () => {
    const r = (await kall("GET", `/api/org/${org}/ekstratimer?fra=${d(0)}&til=${d(6)}`)).data;
    expect(r.ansatte.map((a: any) => [a.navn, a.timer, a.dager.length])).toEqual([
      ["Linda Plan", 11, 2],
      ["Ola Plan", 7.5, 1],
      ["Vera Plan", 4, 1],
    ]);
    expect(r.sum).toBe(22.5);
    expect(r.ansatte[0].dager[1]).toMatchObject({ dato: d(2), timer: 3.5, vakter: "08:00–19:00" });
    const c = await kall("GET", `/api/org/${org}/ekstratimer.csv?fra=${d(0)}&til=${d(6)}`);
    expect(c.type).toContain("text/csv");
    expect(c.data).toContain("Ansattnr.;Navn;Gruppe;Stilling;Stillingsprosent;Ekstratimer;Dager med ekstratimer;Datoer");
    expect(c.data).toContain(";Linda Plan;;;60;11;2;");
    const p = await kall("GET", `/api/org/${org}/ekstratimer.pdf?fra=${d(0)}&til=${d(6)}`);
    expect(p.type).toBe("application/pdf");
    expect(new TextDecoder().decode((p.data as Uint8Array).slice(0, 5))).toBe("%PDF-");
    expect((await kall("GET", `/api/org/${org}/ekstratimer?fra=${d(6)}&til=${d(0)}`)).data.error).toBe("Slutten er før starten");
    expect((await kall("GET", `/api/org/${org}/ekstratimer?fra=${d(0)}&til=${d(6)}`, undefined, linda)).status).toBe(403);
  });

  it("en ny plan gjelder fra datoen sin, og den gamle før", async () => {
    const r = await kall("PUT", `/api/org/${org}/ansatte/${id.Linda}/arbeidsplan`, { gjelder_fra: d(7), dager: [{ ukedag: 2 }, { ukedag: 4 }] });
    expect(r.data.map((p: any) => p.gjelder_fra)).toEqual([d(0), d(7)]);
    const neste = (await kall("GET", `/api/org/${org}/vakter?fra=${d(7)}&til=${d(13)}`)).data.faste.filter((f: any) => f.ansatt_id === id.Linda);
    expect(neste.map((f: any) => f.dato)).toEqual([d(8), d(10)]);
    expect((await kall("DELETE", `/api/org/${org}/ansatte/${id.Linda}/arbeidsplan/${r.data[1].id}`)).status).toBe(204);
    const igjen = (await kall("GET", `/api/org/${org}/vakter?fra=${d(7)}&til=${d(13)}`)).data.faste.filter((f: any) => f.ansatt_id === id.Linda);
    expect(igjen.map((f: any) => f.dato)).toEqual([d(7), d(9), d(11)]);
  });

  it("en plan uten dager betyr at den ansatte ikke har faste dager fra da (som uten plan)", async () => {
    const r = await kall("PUT", `/api/org/${org}/ansatte/${id.Linda}/arbeidsplan`, { gjelder_fra: d(7), dager: [] });
    expect(r.data.map((p: any) => [p.gjelder_fra, p.dager.length])).toEqual([
      [d(0), 3],
      [d(7), 0],
    ]);
    // En vakt den uka regnes mot avtalt arbeidstid i uka (60 % = 22,5 t), ikke mot planen.
    await vakt("Linda", 8, "08:00", "15:30");
    const neste = (await kall("GET", `/api/org/${org}/vakter?fra=${d(7)}&til=${d(13)}`)).data;
    expect(neste.faste.filter((f: any) => f.ansatt_id === id.Linda)).toEqual([]);
    expect(neste.ekstra.filter((e: any) => e.ansatt_id === id.Linda)).toEqual([]);
    expect(neste.uker.find((u: any) => u.ansatt_id === id.Linda)).toMatchObject({ planlagt: 7.5 });
  });
});
