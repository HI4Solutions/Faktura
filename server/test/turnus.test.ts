// Turnus i appen (turnus.ts): vakttypene, behovet, reglene og hvem som går hvilke vakttyper;
// forslaget for en periode (lagrer ingenting), innleggingen som utkast i vaktplanen, en ny kjøring
// som erstatter utkastene fra den forrige (men ikke vakter endret for hånd), angring av en kjøring
// (publiserte vakter står), vakter med vakttype i vaktplanen, og ledige vakter for en rolle.
import { beforeAll, describe, expect, it } from "vitest";
import { lagApi } from "../src/api.js";
import { uke } from "../src/arbeidstid.js";
import { iDag } from "../src/regler.js";
import { settLokalOppgavekjorer } from "../src/tjenester.js";

const pluss = (iso: string, n: number) => new Date(Date.parse(`${iso}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

describe.skipIf(!process.env.DATABASE_URL)("turnus i appen", () => {
  const app = lagApi();
  const eier = "Bearer test:uid-turnus-eier:turnus-eier@server.test:mfa";
  const ola = "Bearer test:uid-turnus-ola:ola.turnus@server.test";
  let org: string;
  let spl: string;
  let ass: string;
  const ansatte: Record<string, string> = {};
  const typer: Record<string, string> = {};
  // To hele uker fra neste mandag (alltid fram i tid).
  const M = uke(pluss(iDag(), 7)).fra;
  const T = pluss(M, 13);
  let kjoring1: string;

  const kall = async (m: string, sti: string, k?: unknown, hvem = eier) => {
    const r = await app.request(sti, { method: m, headers: { authorization: hvem, "content-type": "application/json" }, body: k === undefined ? undefined : JSON.stringify(k) });
    return { status: r.status, data: (r.headers.get("content-type") ?? "").includes("json") ? ((await r.json()) as any) : null };
  };
  const vakter = async () => (await kall("GET", `/api/org/${org}/vakter?fra=${M}&til=${T}`)).data.vakter as any[];

  beforeAll(async () => {
    settLokalOppgavekjorer(async () => undefined);
    org = (await kall("POST", "/api/organisasjoner", { navn: "Turnus Test AS" })).data.id;
    await kall("PUT", `/api/org/${org}/lonn-oppsett`, { aktiv: true });
    spl = (await kall("POST", `/api/org/${org}/ansattgrupper`, { navn: "Sykepleier" })).data.id;
    ass = (await kall("POST", `/api/org/${org}/ansattgrupper`, { navn: "Assistent" })).data.id;
    const ny = async (fornavn: string, gruppe_id: string, k: Record<string, unknown> = {}) =>
      (await kall("POST", `/api/org/${org}/ansatte`, { fornavn, etternavn: "Turnus", ansatt_fra: pluss(iDag(), -60), gruppe_id, ...k })).data.id as string;
    for (const n of ["Kari", "Lise", "Mona", "Nils"]) ansatte[n] = await ny(n, spl);
    ansatte.Ola = await ny("Ola", ass, { epost: "ola.turnus@server.test" });
    ansatte.Per = await ny("Per", ass);
    const inv = (await kall("POST", `/api/org/${org}/ansatte/${ansatte.Ola}/inviter`)).data;
    expect((await kall("POST", "/api/invitasjoner/aksepter", { token: inv.lenke.split("/").pop() }, ola)).status).toBe(200);
  });

  it("vakttypene: dag, kveld og natt, med unik kode", async () => {
    const ny = async (k: Record<string, unknown>) => {
      const r = await kall("POST", `/api/org/${org}/turnus/vakttyper`, k);
      expect(r.status).toBe(201);
      return r.data;
    };
    const dag = await ny({ navn: "Dagvakt", kode: "d", fra: "07:00", til: "15:00", pause_min: 30 });
    expect(dag).toMatchObject({ navn: "Dagvakt", kode: "D", fra: "07:00", til: "15:00", pause_min: 30, timer: 7.5, aktiv: true, rekkefolge: 0, farge: 0 });
    typer.D = dag.id;
    typer.K = (await ny({ navn: "Kveldsvakt", kode: "K", fra: "15:00", til: "23:00", pause_min: 30 })).id;
    const natt = await ny({ navn: "Nattevakt", kode: "N", fra: "23:00", til: "07:00" });
    expect(natt).toMatchObject({ timer: 8, rekkefolge: 2, farge: 2 });
    typer.N = natt.id;
    expect((await kall("POST", `/api/org/${org}/turnus/vakttyper`, { navn: "Dag igjen", kode: "D", fra: "08:00", til: "16:00" })).data).toEqual({ error: "Koden D er allerede i bruk" });
    expect((await kall("POST", `/api/org/${org}/turnus/vakttyper`, { navn: "Feil", kode: "D-1", fra: "08:00", til: "16:00" })).status).toBe(400);
    // De ansatte ser vakttypene, men ikke resten, og endrer ingenting.
    const sett = (await kall("GET", `/api/org/${org}/turnus`, undefined, ola)).data;
    expect(sett.vakttyper.map((t: any) => t.kode)).toEqual(["D", "K", "N"]);
    expect([sett.ansatte, sett.kjoringer]).toEqual([[], []]);
    expect((await kall("POST", `/api/org/${org}/turnus/vakttyper`, { navn: "Egen", kode: "E", fra: "08:00", til: "16:00" }, ola)).status).toBe(403);
  });

  it("behovet, reglene og hvem som går hvilke vakttyper", async () => {
    const behov = [1, 2, 3, 4, 5, 6, 7].flatMap((ukedag) => [
      { vakttype_id: typer.D, ukedag, rolle_id: spl, antall: 1 },
      { vakttype_id: typer.D, ukedag, rolle_id: null, antall: 1 },
      { vakttype_id: typer.K, ukedag, antall: 1 },
      { vakttype_id: typer.N, ukedag, rolle_id: spl, antall: 1 },
      { vakttype_id: typer.N, ukedag: 8 - ukedag, antall: 0 },
    ]);
    expect((await kall("PUT", `/api/org/${org}/turnus/behov`, { behov })).data).toEqual({ behov: 28 });
    expect((await kall("PUT", `/api/org/${org}/turnus/behov`, { behov: [behov[0], behov[0]] })).data).toEqual({ error: "Det samme behovet er med to ganger" });
    expect((await kall("PUT", `/api/org/${org}/turnus/regler`, { hvile: 7, dager_paa_rad: 5, netter_paa_rad: 3, helg: 1 })).status).toBe(400);
    expect((await kall("PUT", `/api/org/${org}/turnus/regler`, { hvile: 11, dager_paa_rad: 5, netter_paa_rad: 3, helg: 1 })).data).toEqual({
      hvile: 11,
      dager_paa_rad: 5,
      netter_paa_rad: 3,
      helg: 1,
    });
    // Sykepleierne går alt; assistentene dag og kveld.
    const valg = [
      ...["Kari", "Lise", "Mona", "Nils"].map((n) => ({ ansatt_id: ansatte[n]!, vakttyper: [typer.D, typer.K, typer.N] })),
      ...["Ola", "Per"].map((n) => ({ ansatt_id: ansatte[n]!, vakttyper: [typer.D, typer.K] })),
    ];
    expect((await kall("PUT", `/api/org/${org}/turnus/ansatte`, { ansatte: valg })).status).toBe(204);
    const sett = (await kall("GET", `/api/org/${org}/turnus`)).data;
    expect(sett.behov).toHaveLength(28);
    expect(sett.ansatte.find((a: any) => a.id === ansatte.Ola).vakttyper.sort()).toEqual([typer.D, typer.K].sort());
    expect(sett.regler).toEqual({ hvile: 11, dager_paa_rad: 5, netter_paa_rad: 3, helg: 1 });
  });

  it("forslaget for to uker lagrer ingenting", async () => {
    expect((await kall("POST", `/api/org/${org}/turnus/forslag`, { fra: pluss(iDag(), -1), til: T })).data).toEqual({ error: "Turnusen kan ikke starte før i dag" });
    expect((await kall("POST", `/api/org/${org}/turnus/forslag`, { fra: M, til: T }, ola)).status).toBe(403);
    const r = (await kall("POST", `/api/org/${org}/turnus/forslag`, { fra: M, til: T })).data;
    expect(r.erstattes).toBe(0);
    // 14 dager med fire vakter (to dag, én kveld og én natt).
    expect(r.forslag.vakter).toHaveLength(56);
    // Nattevaktene og sykepleierplassen på dagen går bare til sykepleierne.
    const sykepleiere = new Set(["Kari", "Lise", "Mona", "Nils"].map((n) => ansatte[n]));
    for (const v of r.forslag.vakter.filter((v: any) => v.rolle_id === spl && v.ansatt_id)) expect(sykepleiere.has(v.ansatt_id)).toBe(true);
    expect(await vakter()).toEqual([]);
  });

  it("innleggingen gir utkast med vakttypen, og en ny kjøring erstatter dem, men ikke det som er endret for hånd", async () => {
    const r = await kall("POST", `/api/org/${org}/turnus/kjoringer`, { fra: M, til: T });
    expect(r.status).toBe(201);
    kjoring1 = r.data.kjoring_id;
    expect(r.data.vakter + r.data.ledige).toBe(56);
    const liste = await vakter();
    expect(liste).toHaveLength(56);
    const natt = liste.find((v) => v.vakttype_kode === "N");
    expect(natt).toMatchObject({ fra: "23:00", til: "07:00", timer: 8, publisert: false, vakttype_navn: "Nattevakt", rolle_navn: "Sykepleier", turnus_id: kjoring1 });
    // Ola ser ingenting før det publiseres.
    expect((await kall("GET", `/api/org/${org}/vakter?fra=${M}&til=${T}`, undefined, ola)).data.vakter).toEqual([]);

    // En vakt endres for hånd: den er ikke lenger med i kjøringen.
    const endret = liste.find((v) => v.vakttype_kode === "K" && v.ansatt_id)!;
    const etter = (await kall("PATCH", `/api/org/${org}/vakter/${endret.id}`, { vakttype_id: typer.D })).data;
    expect(etter).toMatchObject({ fra: "07:00", til: "15:00", vakttype_kode: "D", turnus_id: null });

    // Ny kjøring: de 55 andre utkastene erstattes, og den første kjøringen er borte.
    const ny = await kall("POST", `/api/org/${org}/turnus/kjoringer`, { fra: M, til: T });
    expect(ny.data.erstattet).toBe(55);
    const sett = (await kall("GET", `/api/org/${org}/turnus`)).data;
    expect(sett.kjoringer.map((k: any) => k.id)).toEqual([ny.data.kjoring_id]);
    expect(sett.kjoringer[0]).toMatchObject({ fra: M, til: T, utkast: ny.data.vakter + ny.data.ledige, publisert: 0 });
    const igjen = await vakter();
    expect(igjen.some((v) => v.id === endret.id)).toBe(true);
    // Den endrede dagvakten dekker en dagplass den dagen, så det blir én vakt mindre.
    expect(igjen).toHaveLength(56);
    kjoring1 = ny.data.kjoring_id;
  });

  it("angre en kjøring: utkastene slettes, de publiserte står", async () => {
    expect((await kall("POST", `/api/org/${org}/vakter/publiser`, { fra: M, til: pluss(M, 6) })).status).toBe(200);
    const publisert = (await vakter()).filter((v) => v.publisert && v.turnus_id === kjoring1).length;
    expect(publisert).toBeGreaterThan(0);
    const r = (await kall("DELETE", `/api/org/${org}/turnus/kjoringer/${kjoring1}`)).data;
    expect(r.publisert).toBe(publisert);
    const igjen = await vakter();
    expect(igjen.filter((v) => !v.publisert)).toEqual([]);
    expect(igjen.filter((v) => v.publisert)).toHaveLength(publisert + 1); // og den endrede
    expect((await kall("DELETE", `/api/org/${org}/turnus/kjoringer/${kjoring1}`)).status).toBe(404);
  });

  it("vakter med vakttype for hånd, og ledige vakter for en rolle", async () => {
    // Bare vakttypen: klokkeslettene og pausen kommer fra den.
    const dag = pluss(T, 1);
    const v = await kall("POST", `/api/org/${org}/vakter`, { ansatt_id: ansatte.Per, dato: dag, vakttype_id: typer.K });
    expect(v.status).toBe(201);
    expect(v.data).toMatchObject({ fra: "15:00", til: "23:00", pause_min: 30, timer: 7.5, vakttype_kode: "K" });
    expect((await kall("POST", `/api/org/${org}/vakter`, { ansatt_id: ansatte.Per, dato: dag })).data.error).toBe("Velg en vakttype eller skriv fra og til");
    // En ledig nattevakt for sykepleierne: Ola (assistent) kan ikke ta den.
    const ledig = (await kall("POST", `/api/org/${org}/vakter`, { dato: pluss(dag, 1), vakttype_id: typer.N, rolle_id: spl })).data;
    expect(ledig).toMatchObject({ ansatt_id: null, rolle_navn: "Sykepleier" });
    await kall("POST", `/api/org/${org}/vakter/publiser`, { fra: dag, til: pluss(dag, 1) });
    const ta = await kall("POST", `/api/org/${org}/vakter/${ledig.id}/ta`, undefined, ola);
    expect(ta.status).toBe(403);
    expect(ta.data.error).toBe("Vakten er for rollen Sykepleier");
    // En vakttype som ikke er i bruk lenger, kan ikke velges.
    await kall("PATCH", `/api/org/${org}/turnus/vakttyper/${typer.K}`, { aktiv: false });
    expect((await kall("POST", `/api/org/${org}/vakter`, { ansatt_id: ansatte.Ola, dato: dag, vakttype_id: typer.K })).data.error).toBe("Vakttypen Kveldsvakt er ikke i bruk lenger");
    await kall("PATCH", `/api/org/${org}/turnus/vakttyper/${typer.K}`, { aktiv: true });
  });

  it("uten ledige vakter: det som ikke kan fylles, telles som hull", async () => {
    // Bare Kari går natt nå: tre netter på rad, så hull.
    await kall("PUT", `/api/org/${org}/turnus/ansatte`, { ansatte: ["Lise", "Mona", "Nils"].map((n) => ({ ansatt_id: ansatte[n]!, vakttyper: [typer.D, typer.K] })) });
    const fra = pluss(T, 7);
    const til = pluss(fra, 6);
    const r = (await kall("POST", `/api/org/${org}/turnus/forslag`, { fra, til, ledige: false })).data.forslag;
    const netter = r.vakter.filter((v: any) => v.vakttype_id === typer.N);
    expect(new Set(netter.map((v: any) => v.ansatt_id))).toEqual(new Set([ansatte.Kari]));
    expect(r.vakter.every((v: any) => v.ansatt_id)).toBe(true);
    const nattHull = r.hull.filter((h: any) => h.vakttype_id === typer.N);
    expect(nattHull.reduce((s: number, h: any) => s + h.antall, 0)).toBe(7 - netter.length);
    const k = (await kall("POST", `/api/org/${org}/turnus/kjoringer`, { fra, til, ledige: false })).data;
    expect(k.ledige).toBe(0);
    expect(k.hull).toBeGreaterThanOrEqual(7 - netter.length);
  });

  it("slettes en vakttype, beholder vaktene klokkeslettene", async () => {
    const t = (await kall("POST", `/api/org/${org}/turnus/vakttyper`, { navn: "Mellomvakt", kode: "M", fra: "11:00", til: "19:00" })).data;
    const v = (await kall("POST", `/api/org/${org}/vakter`, { ansatt_id: ansatte.Per, dato: pluss(T, 20), vakttype_id: t.id })).data;
    expect((await kall("DELETE", `/api/org/${org}/turnus/vakttyper/${t.id}`)).status).toBe(204);
    const etter = (await kall("GET", `/api/org/${org}/vakter?fra=${pluss(T, 20)}&til=${pluss(T, 20)}`)).data.vakter.find((x: any) => x.id === v.id);
    expect(etter).toMatchObject({ fra: "11:00", til: "19:00", vakttype_id: null });
    expect((await kall("DELETE", `/api/org/${org}/turnus/vakttyper/${t.id}`)).status).toBe(404);
  });
});
