// Fridagen ved vaktbytte (0074_vaktbytte_fridag.sql, vaktbytte.ts): den som gir bort en fast
// arbeidsdag, velger hva fridagen tas fra (ferie, timebanken, betalt fravær; med timelønn også fri
// uten lønn). Kollegaen ser ikke valget, lederen får det i varselet og godkjenner (også når
// vaktbytte ellers går uten godkjenning), og fraværet registreres når byttet går gjennom. Permisjon
// med lønn lønnes for den med timelønn, og står i fraværsrapporten. Lederen kan velge fridagen når
// de gir bort en fast arbeidsdag i vaktplanen. Datoene er i en uke uten helligdager fram i tid.
import { beforeAll, describe, expect, it } from "vitest";
import { lagApi } from "../src/api.js";
import { uke } from "../src/arbeidstid.js";
import { iDag } from "../src/regler.js";
import { helligdag } from "../src/helligdager.js";
import { settLokalOppgavekjorer, type Oppgave } from "../src/tjenester.js";

const pluss = (iso: string, n: number) => new Date(Date.parse(`${iso}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

describe.skipIf(!process.env.DATABASE_URL)("fridagen ved vaktbytte", () => {
  const app = lagApi();
  const eier = "Bearer test:uid-fridag-eier:fridag-eier@server.test:mfa";
  const hvem = {
    kari: "Bearer test:uid-fridag-kari:kari.fridag@server.test",
    ola: "Bearer test:uid-fridag-ola:ola.fridag@server.test",
    per: "Bearer test:uid-fridag-per:per.fridag@server.test",
  };
  const ko: Oppgave[] = [];
  let org: string;
  const id: Record<string, string> = {};
  const bruker: Record<string, string> = {};
  let M = uke(pluss(iDag(), 7)).fra;
  while ([0, 1, 2, 3, 4].some((n) => helligdag(pluss(M, n)))) M = pluss(M, 7);
  const d = (n: number) => pluss(M, n);

  const kall = async (m: string, sti: string, k?: unknown, som = eier) => {
    const r = await app.request(sti, { method: m, headers: { authorization: som, "content-type": "application/json" }, body: k === undefined ? undefined : JSON.stringify(k) });
    return { status: r.status, data: (r.headers.get("content-type") ?? "").includes("json") ? ((await r.json()) as any) : null };
  };
  const varsler = () => ko.filter((o): o is Extract<Oppgave, { type: "varsel" }> => o.type === "varsel").map((o) => o.varsel);
  const nye = (for_: number) => varsler().slice(for_);
  const tilby = (k: Record<string, unknown>, som: string) => kall("POST", `/api/org/${org}/vaktbytter`, k, som);
  const bytte = async (b: string, som = eier) => (await kall("GET", `/api/org/${org}/vaktbytter`, undefined, som)).data.bytter.find((x: any) => x.id === b);
  const fravaer = async (ansatt: string, dato: string) => (await kall("GET", `/api/org/${org}/fravaer?fra=${dato}&til=${dato}&ansatt=${ansatt}`)).data;

  beforeAll(async () => {
    settLokalOppgavekjorer(async (o) => {
      ko.push(o);
    });
    org = (await kall("POST", "/api/organisasjoner", { navn: "Fridag Test AS" })).data.id;
    bruker.eier = (await kall("GET", "/api/meg")).data.bruker.id;
    await kall("PUT", `/api/org/${org}/lonn-oppsett`, { aktiv: true, timebank: true });
    for (const [navn, lonn] of [
      ["kari", { lonnstype: "maaned", maanedslonn: 50000 }],
      ["ola", { lonnstype: "time", timelonn: 250 }],
      ["per", { lonnstype: "maaned", maanedslonn: 45000 }],
    ] as const) {
      const fornavn = navn[0]!.toUpperCase() + navn.slice(1);
      const a = (await kall("POST", `/api/org/${org}/ansatte`, { fornavn, etternavn: "Fri", epost: `${navn}.fridag@server.test`, ansatt_fra: pluss(iDag(), -400), ...lonn })).data;
      const inv = (await kall("POST", `/api/org/${org}/ansatte/${a.id}/inviter`)).data;
      expect((await kall("POST", "/api/invitasjoner/aksepter", { token: inv.lenke.split("/").pop() }, hvem[navn])).status).toBe(200);
      id[navn] = a.id;
      bruker[navn] = (await kall("GET", "/api/meg", undefined, hvem[navn])).data.bruker.id;
    }
    // Faste dager mandag til fredag: Kari 08–16 med en halvtimes pause (7,5 t), Ola 08–12 (4 t).
    const dager = (fra: string, til: string, pause_min = 0) => [1, 2, 3, 4, 5].map((ukedag) => ({ ukedag, fra, til, pause_min }));
    expect((await kall("PUT", `/api/org/${org}/ansatte/${id.kari}/arbeidsplan`, { gjelder_fra: pluss(iDag(), -400), dager: dager("08:00", "16:00", 30) })).status).toBe(200);
    expect((await kall("PUT", `/api/org/${org}/ansatte/${id.ola}/arbeidsplan`, { gjelder_fra: pluss(iDag(), -400), dager: dager("08:00", "12:00") })).status).toBe(200);
    // Kari har 10 t i timebanken.
    expect((await kall("POST", `/api/org/${org}/timebank/poster`, { ansatt_id: id.kari, type: "justering", timer: 10, tekst: "Fra før" })).status).toBe(201);
  });

  it("innstillingen: på som standard, og bare eier og administrator endrer den", async () => {
    expect((await kall("GET", `/api/org/${org}/lonn-oppsett`)).data.vaktbytte_fridag).toBe(true);
    expect((await kall("PUT", `/api/org/${org}/lonn-oppsett`, { vaktbytte_fridag: false }, hvem.kari)).status).toBe(403);
    expect((await kall("PUT", `/api/org/${org}/lonn-oppsett`, { vaktbytte_fridag: false })).data.vaktbytte_fridag).toBe(false);
    expect((await kall("GET", `/api/org/${org}/vaktbytter/muligheter?dato=${d(0)}`, undefined, hvem.kari)).data.fridag).toMatchObject({ fridag: true, sporres: false });
    expect((await kall("PUT", `/api/org/${org}/lonn-oppsett`, { vaktbytte_fridag: true })).data.vaktbytte_fridag).toBe(true);
  });

  it("mulighetene viser fridagen med feriedagene og timene", async () => {
    expect((await kall("GET", `/api/org/${org}/vaktbytter/muligheter?dato=${d(0)}`, undefined, hvem.kari)).data.fridag).toEqual({
      fridag: true,
      sporres: true,
      timer: 7.5,
      lonnstype: "maaned",
      ferie_aar: Number(d(0).slice(0, 4)),
      ferie_igjen: 25,
      timebank: true,
      timebank_igjen: 10,
    });
    expect((await kall("GET", `/api/org/${org}/vaktbytter/muligheter?dato=${d(0)}`, undefined, hvem.ola)).data.fridag).toMatchObject({
      sporres: true,
      timer: 4,
      lonnstype: "time",
      timebank_igjen: 0,
    });
  });

  it("Kari tar fridagen fra ferien: kollegaen ser ikke valget, lederen godkjenner og ferien registreres", async () => {
    expect((await tilby({ dato: d(0) }, hvem.kari)).data.error).toBe("Velg hva du tar fridagen fra: en feriedag, timebanken eller betalt fravær");
    const t = await tilby({ dato: d(0), fri: "ferie" }, hvem.kari);
    expect(t.status, JSON.stringify(t.data)).toBe(201);
    expect(t.data).toMatchObject({ fri: "ferie", fri_timer: null, fravaer_id: null });
    expect(await bytte(t.data.id, hvem.per)).toMatchObject({ fri: null, fri_timer: null, fri_grunn: null });

    const for_ = varsler().length;
    expect((await kall("POST", `/api/org/${org}/vaktbytter/${t.data.id}/svar`, { ja: true }, hvem.per)).data.status).toBe("akseptert");
    expect(nye(for_)).toContainEqual(
      expect.objectContaining({ bruker_ider: [bruker.eier], tittel: "Vaktbytte til godkjenning", tekst: expect.stringContaining("Fridagen: en feriedag.") }),
    );
    expect(await bytte(t.data.id)).toMatchObject({ fri: "ferie" });

    const for2 = varsler().length;
    expect((await kall("POST", `/api/org/${org}/vaktbytter/${t.data.id}/godkjenn`, {})).data.status).toBe("godkjent");
    expect(nye(for2)).toContainEqual(
      expect.objectContaining({ bruker_ider: [bruker.kari], tittel: "Vaktbyttet er godkjent", tekst: expect.stringMatching(/^Per Fri tar vakten din .*\. Fridagen er registrert som ferie\.$/) }),
    );
    expect(await fravaer(id.kari, d(0))).toEqual([expect.objectContaining({ type: "ferie", betalt: false, timer: null, notat: "Vaktbytte: Per Fri tok vakten" })]);
    expect((await bytte(t.data.id)).fravaer_id).toBe((await fravaer(id.kari, d(0)))[0].id);
  });

  it("uten godkjenning må fridagen fra timebanken likevel godkjennes", async () => {
    expect((await kall("PUT", `/api/org/${org}/lonn-oppsett`, { vaktbytte: "fritt" })).status).toBe(200);
    const t = await tilby({ dato: d(1), fri: "avspasering" }, hvem.kari);
    expect(t.data).toMatchObject({ fri: "avspasering", fri_timer: 7.5 });
    expect((await kall("GET", `/api/org/${org}/timebank/${id.kari}`, undefined, hvem.kari)).data.saldo).toMatchObject({ saldo: 10, sokt: 7.5 });
    expect((await tilby({ dato: d(2), fri: "avspasering" }, hvem.kari)).data.error).toBe(
      "Vakten er 7,5 t, og du har 2,5 t i timebanken (utenom 7,5 t du har søkt om fra før)",
    );

    const for_ = varsler().length;
    expect((await kall("POST", `/api/org/${org}/vaktbytter/${t.data.id}/svar`, { ja: true }, hvem.per)).data.status).toBe("akseptert");
    expect(nye(for_)).toContainEqual(expect.objectContaining({ tittel: "Vaktbytte til godkjenning", tekst: expect.stringContaining("Fridagen: 7,5 t fra timebanken.") }));
    const for2 = varsler().length;
    await kall("POST", `/api/org/${org}/vaktbytter/${t.data.id}/godkjenn`, {});
    expect(nye(for2)).toContainEqual(
      expect.objectContaining({ bruker_ider: [bruker.kari], tekst: expect.stringContaining("Fridagen er registrert som avspasering (7,5 t fra timebanken).") }),
    );
    expect(await fravaer(id.kari, d(1))).toEqual([expect.objectContaining({ type: "avspasering", timer: 7.5 })]);
    expect((await kall("GET", `/api/org/${org}/timebank/${id.kari}`, undefined, hvem.kari)).data.saldo).toMatchObject({ saldo: 2.5, sokt: 0 });
  });

  it("Ola (timelønn): fri uten lønn går rett gjennom, og betalt fravær lønnes og står i rapporten", async () => {
    const u = await tilby({ dato: d(2) }, hvem.ola);
    expect(u.data.fri).toBe("uten_lonn");
    expect((await kall("POST", `/api/org/${org}/vaktbytter/${u.data.id}/svar`, { ja: true }, hvem.per)).data.status).toBe("godkjent");
    expect(await fravaer(id.ola, d(2))).toEqual([]);

    expect((await tilby({ dato: d(3), fri: "betalt" }, hvem.ola)).data.error).toBe("Skriv hva det betalte fraværet gjelder");
    const b = await tilby({ dato: d(3), fri: "betalt", fri_grunn: "Legetime" }, hvem.ola);
    expect(b.data).toMatchObject({ fri: "betalt", fri_timer: 4, fri_grunn: "Legetime" });
    const for_ = varsler().length;
    expect((await kall("POST", `/api/org/${org}/vaktbytter/${b.data.id}/svar`, { ja: true }, hvem.per)).data.status).toBe("akseptert");
    expect(nye(for_)).toContainEqual(expect.objectContaining({ tekst: expect.stringContaining("Fridagen: betalt fravær («Legetime»).") }));
    const for2 = varsler().length;
    await kall("POST", `/api/org/${org}/vaktbytter/${b.data.id}/godkjenn`, {});
    expect(nye(for2)).toContainEqual(expect.objectContaining({ bruker_ider: [bruker.ola], tekst: expect.stringContaining("Fridagen er registrert som permisjon med lønn.") }));
    expect(await fravaer(id.ola, d(3))).toEqual([expect.objectContaining({ type: "permisjon", betalt: true, timer: 4, notat: "Legetime · Vaktbytte: Per Fri tok vakten" })]);

    // Fraværsrapporten: permisjon med lønn.
    const r = await kall("GET", `/api/org/${org}/rapportmodul/personal.fravaer?fra=${d(0)}&til=${d(4)}`);
    expect(r.data.rader.map((x: any) => `${x.navn}:${x.type}`).sort()).toEqual(["Kari Fri:Avspasering", "Kari Fri:Ferie", "Ola Fri:Permisjon med lønn"]);

    // Lønnskjøringen: Olas timer lønnes; Kari har fastlønn og får ingen egne linjer for fridagene.
    const k = await kall("POST", `/api/org/${org}/lonn/kjoringer`, { periode: d(3).slice(0, 7) });
    expect(k.status, JSON.stringify(k.data)).toBe(201);
    const slipp = (ansatt: string) => k.data.slipper.find((s: any) => s.ansatt_id === ansatt);
    expect(slipp(id.ola).linjer.map((l: any) => [l.lonnsart, l.tekst, l.antall, l.sats, l.belop])).toEqual([["permisjon", "Permisjon med lønn", 4, 250, 1000]]);
    expect(slipp(id.kari).linjer.map((l: any) => l.lonnsart)).not.toContain("permisjon");
    expect(slipp(id.kari).linjer.map((l: any) => l.lonnsart)).not.toContain("avspasering");
  });

  it("lederen gir bort en fast arbeidsdag i vaktplanen og velger fridagen", async () => {
    const m = await kall("GET", `/api/org/${org}/vaktbytter/leder/muligheter?ansatt=${id.kari}&dato=${d(4)}`);
    expect(m.data.fridag).toMatchObject({ fridag: true, timer: 7.5, lonnstype: "maaned" });
    const k = { ansatt_id: id.kari, dato: d(4), til_ansatt: id.per, fri: "ferie" };
    expect((await kall("POST", `/api/org/${org}/vaktbytter/leder`, { ...k, forhandsvis: true })).status).toBe(200);
    expect(await fravaer(id.kari, d(4))).toEqual([]);
    const for_ = varsler().length;
    const r = await kall("POST", `/api/org/${org}/vaktbytter/leder`, k);
    expect(r.status, JSON.stringify(r.data)).toBe(201);
    expect(r.data).toMatchObject({ fri: "ferie", av_leder: true });
    expect(await fravaer(id.kari, d(4))).toEqual([expect.objectContaining({ type: "ferie" })]);
    expect(nye(for_)).toContainEqual(
      expect.objectContaining({ bruker_ider: [bruker.kari], tittel: "Vakten din er gitt bort", tekst: expect.stringContaining("Fridagen er registrert som ferie.") }),
    );
  });
});
