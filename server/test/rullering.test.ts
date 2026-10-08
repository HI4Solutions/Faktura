// Rullering på tavla: fordelingen (server/src/rullering.ts) for seg, og API-et med
// forhåndsvisning, lagring, plasser satt for hånd og hvem som kan ta hvilke oppgaver.
import { beforeAll, describe, expect, it } from "vitest";
import { lagApi } from "../src/api.js";
import { uke } from "../src/arbeidstid.js";
import { iDag } from "../src/regler.js";
import { settLokalOppgavekjorer } from "../src/tjenester.js";
import { helligdag } from "../src/helligdager.js";
import { rullere, tilordne, type RDag, type RFase, type RInn, type ROppgave, type RPlass, type RTid } from "../src/rullering.js";

const pluss = (iso: string, n: number) => new Date(Date.parse(`${iso}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const HEL: RTid = { fra: null, til: null };
const F = (id: string, fra: string | null = null, til: string | null = null): RFase => ({ id, fra, til });
const O = (id: string, behov: number | null = null): ROppgave => ({ id, behov });
const dag = (dato: string, folk: string[], vakt: RTid = HEL, faste: RDag["faste"] = []): RDag => ({ dato, folk: folk.map((a) => ({ ansatt_id: a, vakter: [vakt] })), faste });
const kjor = (k: Partial<RInn> & Pick<RInn, "faser" | "oppgaver" | "dager">) => rullere({ behov: [], utelatt: [], historikk: [], ...k });
// Oppgaven en ansatt fikk i en fase en dag.
const fikk = (p: RPlass[], dato: string, fase: string, a: string) => p.find((x) => x.dato === dato && x.fase_id === fase && x.ansatt_id === a)?.oppgave_id;
const antall = (p: RPlass[], a: string, o: string) => p.filter((x) => x.ansatt_id === a && x.oppgave_id === o).length;

describe("rulleringen", () => {
  const D = "2026-11-02";
  const d = (n: number) => pluss(D, n);

  it("alle får alle oppgavene etter tur", () => {
    const r = kjor({ faser: [F("dag")], oppgaver: [O("T"), O("R"), O("L")], dager: [0, 1, 2].map((n) => dag(d(n), ["a", "b", "c"])) });
    for (const n of [0, 1, 2]) {
      // Hver dag: alle har én oppgave, og hver oppgave har én.
      expect(new Set(["a", "b", "c"].map((a) => fikk(r.plasser, d(n), "dag", a)))).toEqual(new Set(["T", "R", "L"]));
    }
    for (const a of ["a", "b", "c"]) expect(new Set([0, 1, 2].map((n) => fikk(r.plasser, d(n), "dag", a)))).toEqual(new Set(["T", "R", "L"]));
    expect(r.mangler).toEqual([]);
    expect(r.ikkePlassert).toEqual([]);
  });

  it("en annen oppgave etter lunsj, men samme oppgave i faser som overlapper", () => {
    const folk = ["a", "b", "c"];
    const lunsj = kjor({ faser: [F("for", "08:00", "11:30"), F("etter", "12:00", "16:00")], oppgaver: [O("T"), O("R"), O("L")], dager: [dag(d(0), folk)] });
    for (const a of folk) expect(fikk(lunsj.plasser, d(0), "for", a)).not.toBe(fikk(lunsj.plasser, d(0), "etter", a));

    // Forvakt 07–15 og mellomvakt 11–19 går i hverandre: den som er i begge, er på ett sted.
    const vakter = kjor({
      faser: [F("forvakt", "07:00", "15:00"), F("mellomvakt", "11:00", "19:00")],
      oppgaver: [O("T"), O("L")],
      dager: [{ dato: d(0), faste: [], folk: [{ ansatt_id: "a", vakter: [{ fra: "07:00", til: "15:00" }] }, { ansatt_id: "b", vakter: [{ fra: "11:00", til: "19:00" }] }] }],
    });
    for (const a of ["a", "b"]) expect(fikk(vakter.plasser, d(0), "mellomvakt", a)).toBe(fikk(vakter.plasser, d(0), "forvakt", a));

    // «Samme oppgave hele dagen»: også før og etter lunsj.
    const samme = kjor({ faser: [F("for"), F("etter")], oppgaver: [O("T"), O("R"), O("L")], dager: [dag(d(0), folk)], sammeHeleDagen: true });
    for (const a of folk) expect(fikk(samme.plasser, d(0), "etter", a)).toBe(fikk(samme.plasser, d(0), "for", a));
  });

  it("behovet fylles først, én i hver oppgave før noen får to, og resten går til oppgavene uten behov", () => {
    const oppgaver = [O("T", 2), O("R", 1), O("L", 1)];
    const tre = kjor({ faser: [F("dag")], oppgaver, dager: [dag(d(0), ["a", "b", "c"])] });
    expect(["T", "R", "L"].map((o) => tre.plasser.filter((p) => p.oppgave_id === o).length)).toEqual([1, 1, 1]);
    expect(tre.mangler).toEqual([{ dato: d(0), fase_id: "dag", oppgave_id: "T", antall: 1 }]);

    // To: oppgavene fylles i rekkefølgen på tavla.
    const to = kjor({ faser: [F("dag")], oppgaver, dager: [dag(d(0), ["a", "b"])] });
    expect(to.plasser.map((p) => p.oppgave_id).sort()).toEqual(["R", "T"]);
    expect(to.mangler.map((m) => [m.oppgave_id, m.antall])).toEqual([
      ["T", 1],
      ["L", 1],
    ]);

    // Flere enn behovet: resten står uten plass, eller går til oppgavene uten behov.
    const fem = kjor({ faser: [F("dag")], oppgaver, dager: [dag(d(0), ["a", "b", "c", "d", "e"])] });
    expect(fem.plasser).toHaveLength(4);
    expect(fem.ikkePlassert).toHaveLength(1);
    const medAnnet = kjor({ faser: [F("dag")], oppgaver: [...oppgaver, O("K")], dager: [dag(d(0), ["a", "b", "c", "d", "e", "f"])] });
    expect(["T", "R", "L", "K"].map((o) => medAnnet.plasser.filter((p) => p.oppgave_id === o).length)).toEqual([2, 1, 1, 2]);
    expect(medAnnet.ikkePlassert).toEqual([]);
  });

  it("behov 0 i en fase: ingen i oppgaven der", () => {
    const r = kjor({
      faser: [F("for"), F("etter")],
      oppgaver: [O("T"), O("L")],
      behov: [{ fase_id: "etter", oppgave_id: "L", antall: 0 }],
      dager: [dag(d(0), ["a", "b", "c"])],
    });
    expect(r.plasser.filter((p) => p.fase_id === "etter").map((p) => p.oppgave_id)).toEqual(["T", "T", "T"]);
    expect(r.plasser.filter((p) => p.fase_id === "for" && p.oppgave_id === "L").length).toBeGreaterThan(0);
  });

  it("ingen settes i en oppgave de er utelatt fra, og den som er utelatt fra alt, står utenfor", () => {
    const r = kjor({
      faser: [F("dag")],
      oppgaver: [O("T", 1), O("R", 1), O("L", 1)],
      utelatt: [{ ansatt_id: "c", oppgave_id: "L" }, ...["T", "R", "L"].map((o) => ({ ansatt_id: "leder", oppgave_id: o }))],
      dager: [0, 1, 2, 3, 4, 5].map((n) => dag(d(n), ["a", "b", "c", "leder"])),
    });
    expect(antall(r.plasser, "c", "L")).toBe(0);
    expect(antall(r.plasser, "c", "T") + antall(r.plasser, "c", "R")).toBe(6);
    expect(r.plasser.filter((p) => p.ansatt_id === "leder")).toEqual([]);
    expect(r.ikkePlassert).toEqual([]);
    // Bare c kan ikke ta laben: a og b deler den.
    expect([antall(r.plasser, "a", "L"), antall(r.plasser, "b", "L")]).toEqual([3, 3]);
  });

  it("plasser satt for hånd står og teller med", () => {
    const r = kjor({
      faser: [F("forvakt", "07:00", "15:00"), F("mellomvakt", "11:00", "19:00")],
      oppgaver: [O("T", 1), O("L", 1)],
      dager: [dag(d(0), ["a", "b"], { fra: "08:00", til: "16:00" }, [{ fase_id: "forvakt", oppgave_id: "L", ansatt_id: "a" }])],
    });
    // a står i laben om morgenen; b tar telefonen, og a fortsetter i laben (fasene overlapper).
    expect(r.plasser.filter((p) => p.fase_id === "forvakt")).toEqual([{ dato: d(0), fase_id: "forvakt", oppgave_id: "T", ansatt_id: "b" }]);
    expect(fikk(r.plasser, d(0), "mellomvakt", "a")).toBe("L");
    expect(fikk(r.plasser, d(0), "mellomvakt", "b")).toBe("T");
  });

  it("fast oppgave: alltid den, også utover behovet; der den ikke trengs, ingen plass, og en plass for hånd står", () => {
    const r = kjor({
      faser: [F("for", "08:00", "12:00"), F("etter", "12:00", "16:00")],
      oppgaver: [O("T", 1), O("L", 1)],
      behov: [{ fase_id: "etter", oppgave_id: "L", antall: 0 }],
      fast: [
        { ansatt_id: "a", oppgave_id: "L" },
        { ansatt_id: "b", oppgave_id: "L" },
      ],
      dager: [
        dag(d(0), ["a", "b", "c"], { fra: "08:00", til: "16:00" }),
        dag(d(1), ["a", "b", "c"], { fra: "08:00", til: "16:00" }, [{ fase_id: "for", oppgave_id: "T", ansatt_id: "a" }]),
      ],
    });
    // a og b i laben om formiddagen (to, selv om behovet er én), og c tar telefonen.
    expect(["a", "b", "c"].map((x) => fikk(r.plasser, d(0), "for", x))).toEqual(["L", "L", "T"]);
    // Etter lunsj trengs ikke laben: a og b står uten plass (de rulleres ikke), og c tar telefonen.
    expect(["a", "b"].map((x) => fikk(r.plasser, d(0), "etter", x))).toEqual([undefined, undefined]);
    expect(r.ikkePlassert.filter((p) => p.dato === d(0) && p.fase_id === "etter").map((p) => p.ansatt_id)).toEqual(["a", "b"]);
    expect(fikk(r.plasser, d(0), "etter", "c")).toBe("T");
    // Dag to står a i telefonen (satt for hånd), b i laben (fast), og c får ingen plass (behovet er dekket).
    expect(["a", "b", "c"].map((x) => fikk(r.plasser, d(1), "for", x))).toEqual([undefined, "L", undefined]);
    expect(r.ikkePlassert.filter((p) => p.dato === d(1) && p.fase_id === "for").map((p) => p.ansatt_id)).toEqual(["c"]);
    expect(r.mangler).toEqual([]);
  });

  it("den som har hatt en oppgave mye i det siste, får en annen", () => {
    const historikk: RPlass[] = [1, 2, 3, 4, 5].map((n) => ({ dato: d(-n), fase_id: "dag", oppgave_id: "T", ansatt_id: "a" }));
    historikk.push(...[1, 2, 3, 4, 5].map((n) => ({ dato: d(-n), fase_id: "dag", oppgave_id: "L", ansatt_id: "b" })));
    const r = kjor({ faser: [F("dag")], oppgaver: [O("T", 1), O("L", 1)], dager: [dag(d(0), ["a", "b"])], historikk });
    expect([fikk(r.plasser, d(0), "dag", "a"), fikk(r.plasser, d(0), "dag", "b")]).toEqual(["L", "T"]);
  });

  it("over tid får alle like mye av hver oppgave", () => {
    const folk = ["a", "b", "c", "d"];
    const r = kjor({ faser: [F("dag")], oppgaver: [O("T", 2), O("R", 1), O("L", 1)], dager: Array.from({ length: 20 }, (_, n) => dag(d(n), folk)) });
    for (const a of folk) {
      expect(Math.abs(antall(r.plasser, a, "T") - 10)).toBeLessThanOrEqual(1);
      expect(Math.abs(antall(r.plasser, a, "R") - 5)).toBeLessThanOrEqual(1);
      expect(Math.abs(antall(r.plasser, a, "L") - 5)).toBeLessThanOrEqual(1);
    }
    // Og ingen har den samme oppgaven to dager på rad, utenom telefonen (to av fire hver dag).
    for (const a of folk)
      for (let n = 1; n < 20; n++) {
        const i = fikk(r.plasser, d(n), "dag", a);
        if (i !== "T") expect(i).not.toBe(fikk(r.plasser, d(n - 1), "dag", a));
      }
  });

  it("tilordningen er den beste, uansett form", () => {
    // Enkel, fast pseudotilfeldighet, og alle måtene å velge på for små matriser.
    let s = 7;
    const tall = () => ((s = (s * 48271) % 2147483647) % 1000) - 200;
    const best = (k: number[][]) => {
      const n = k.length;
      const m = k[0]!.length;
      let min = Infinity;
      const prov = (i: number, brukt: Set<number>, sum: number) => {
        if (i === n || brukt.size === m) return void (min = Math.min(min, sum));
        if (n - i > m - brukt.size) prov(i + 1, brukt, sum); // raden står uten
        for (let j = 0; j < m; j++) if (!brukt.has(j)) prov(i + 1, new Set([...brukt, j]), sum + k[i]![j]!);
      };
      prov(0, new Set(), 0);
      return min;
    };
    for (const [n, m] of [
      [3, 5],
      [5, 3],
      [4, 4],
      [1, 6],
      [6, 1],
    ] as const)
      for (let x = 0; x < 5; x++) {
        const k = Array.from({ length: n }, () => Array.from({ length: m }, tall));
        const valg = tilordne(k);
        const brukt = valg.filter((j) => j >= 0);
        expect(new Set(brukt).size).toBe(brukt.length);
        expect(brukt).toHaveLength(Math.min(n, m));
        expect(valg.reduce((sum, j, i) => sum + (j >= 0 ? k[i]![j]! : 0), 0)).toBe(best(k));
      }
    expect(tilordne([])).toEqual([]);
    expect(tilordne([[], []])).toEqual([-1, -1]);
  });
});

describe.skipIf(!process.env.DATABASE_URL)("rullering i API-et", () => {
  const app = lagApi();
  const eier = "Bearer test:uid-rull-eier:rull-eier@server.test:mfa";
  const ola = "Bearer test:uid-rull-ola:ola.rull@server.test";
  let org: string;
  const id: Record<string, string> = {};
  // Neste uke uten helligdager, mandag til fredag (på en helligdag gjelder ikke de faste dagene).
  let M = uke(pluss(iDag(), 7)).fra;
  while ([0, 1, 2, 3, 4].map((i) => pluss(M, i)).some(helligdag)) M = pluss(M, 7);
  const d = (n: number) => pluss(M, n);
  const kall = async (m: string, sti: string, k?: unknown, hvem = eier) => {
    const r = await app.request(sti, { method: m, headers: { authorization: hvem, "content-type": "application/json" }, body: k === undefined ? undefined : JSON.stringify(k) });
    return { status: r.status, data: (r.headers.get("content-type") ?? "").includes("json") ? ((await r.json()) as any) : null };
  };
  const rull = (k: Record<string, unknown> = {}, hvem = eier) => kall("POST", `/api/org/${org}/tavle/rullering`, { fra: d(0), til: d(4), ...k }, hvem);
  const tavle = async (dato: string) => (await kall("GET", `/api/org/${org}/tavle?dato=${dato}`)).data;
  type Dag = { dato: string; plasser: { fase_id: string; oppgave_id: string; ansatt_id: string; rullert: boolean }[]; ikke_plassert: unknown[]; mangler: unknown[] };

  beforeAll(async () => {
    settLokalOppgavekjorer(async () => {});
    org = (await kall("POST", "/api/organisasjoner", { navn: "Rullering AS" })).data.id;
    await kall("PUT", `/api/org/${org}/lonn-oppsett`, { aktiv: true });
    for (const navn of ["Ola", "Kari", "Per"]) {
      const a = (await kall("POST", `/api/org/${org}/ansatte`, { fornavn: navn, etternavn: "Rull", epost: `${navn.toLowerCase()}.rull@server.test`, ansatt_fra: pluss(iDag(), -30) })).data;
      id[navn] = a.id;
      // Hele dager mandag til fredag.
      expect((await kall("PUT", `/api/org/${org}/ansatte/${a.id}/arbeidsplan`, { gjelder_fra: pluss(iDag(), -30), dager: [1, 2, 3, 4, 5].map((ukedag) => ({ ukedag })) })).status).toBe(200);
    }
    const inv = (await kall("POST", `/api/org/${org}/ansatte/${id.Ola}/inviter`)).data;
    expect((await kall("POST", "/api/invitasjoner/aksepter", { token: inv.lenke.split("/").pop() }, ola)).status).toBe(200);
    for (const [navn, fra, til] of [
      ["Før lunsj", "08:00", "11:30"],
      ["Etter lunsj", "12:00", "16:00"],
    ])
      id[navn!] = (await kall("POST", `/api/org/${org}/tavle/faser`, { navn, fra, til })).data.id;
    for (const navn of ["Telefon", "Resepsjon", "Lab"]) id[navn] = (await kall("POST", `/api/org/${org}/tavle/oppgaver`, { navn })).data.id;
  });

  it("forhåndsvisningen fordeler alle uten å lagre", async () => {
    const r = await rull();
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ fra: d(0), til: d(4), lagret: false, plasser: 30, endret: 30 });
    expect(r.data.ansatte.map((a: any) => a.navn)).toEqual(["Kari Rull", "Ola Rull", "Per Rull"]);
    for (const dg of r.data.dager as Dag[]) {
      for (const f of [id["Før lunsj"], id["Etter lunsj"]]) expect(new Set(dg.plasser.filter((p) => p.fase_id === f).map((p) => p.oppgave_id)).size).toBe(3);
      // En annen oppgave etter lunsj.
      for (const a of [id.Ola, id.Kari, id.Per]) {
        const [for_, etter] = [id["Før lunsj"], id["Etter lunsj"]].map((f) => dg.plasser.find((p) => p.fase_id === f && p.ansatt_id === a)?.oppgave_id);
        expect(for_).not.toBe(etter);
      }
    }
    expect((await tavle(d(0))).plasseringer).toEqual([]);
  });

  it("lagret: plassene er rulleringens, og kjøres den igjen, blir ingenting endret", async () => {
    expect((await rull({ lagre: true })).data).toMatchObject({ lagret: true, plasser: 30 });
    const t = await tavle(d(0));
    expect(t.plasseringer).toHaveLength(6);
    expect(t.plasseringer.every((p: any) => p.rullert)).toBe(true);
    // Ti plasser hver i uka: tre eller fire av hver oppgave.
    const uka = await Promise.all([0, 1, 2, 3, 4].map((n) => tavle(d(n))));
    for (const a of [id.Ola, id.Kari, id.Per])
      for (const o of [id.Telefon, id.Resepsjon, id.Lab]) {
        const n = uka.flatMap((x) => x.plasseringer).filter((p: any) => p.ansatt_id === a && p.oppgave_id === o).length;
        expect(n === 3 || n === 4).toBe(true);
      }
    expect((await rull()).data).toMatchObject({ plasser: 30, endret: 0 });
    // Den ansatte ser plassene sine.
    expect((await kall("GET", `/api/org/${org}/tavle/mine?fra=${d(0)}&til=${d(4)}`, undefined, ola)).data).toHaveLength(10);
  });

  it("en plass som flyttes for hånd, står når rulleringen kjøres igjen", async () => {
    const for_ = (await tavle(d(0))).plasseringer.find((p: any) => p.ansatt_id === id.Ola && p.fase_id === id["Før lunsj"]);
    const annen = [id.Telefon, id.Resepsjon, id.Lab].find((o) => o !== for_.oppgave_id)!;
    expect((await kall("PUT", `/api/org/${org}/tavle/plassering`, { dato: d(0), fase_id: id["Før lunsj"], ansatt_id: id.Ola, oppgave_id: annen })).status).toBe(204);
    expect((await tavle(d(0))).plasseringer.find((p: any) => p.ansatt_id === id.Ola && p.fase_id === id["Før lunsj"])).toMatchObject({ oppgave_id: annen, rullert: false });

    const r = (await rull({ lagre: true })).data;
    expect(r.plasser).toBe(29);
    const mandag = (r.dager as Dag[]).find((x) => x.dato === d(0))!;
    expect(mandag.plasser.find((p) => p.ansatt_id === id.Ola && p.fase_id === id["Før lunsj"])).toEqual({ fase_id: id["Før lunsj"], oppgave_id: annen, ansatt_id: id.Ola, rullert: false });
    // De andre før lunsj tar de to andre oppgavene.
    expect(new Set(mandag.plasser.filter((p) => p.fase_id === id["Før lunsj"]).map((p) => p.oppgave_id)).size).toBe(3);

    // Med behold: false fordeles også den.
    const alle = (await rull({ behold: false })).data;
    expect(alle.plasser).toBe(30);
    expect((alle.dager as Dag[]).flatMap((x) => x.plasser).every((p) => p.rullert)).toBe(true);
  });

  it("hvem som kan ta hvilke oppgaver, og den som er borte, er ikke med", async () => {
    const utelat = (k: Record<string, unknown>, hvem = eier) => kall("PUT", `/api/org/${org}/tavle/utelatt`, k, hvem);
    expect((await utelat({ ansatt_id: id.Kari, oppgave_id: id.Lab, kan: false })).status).toBe(204);
    expect((await utelat({ ansatt_id: id.Kari, oppgave_id: id.Lab, kan: false })).status).toBe(204);
    expect((await kall("GET", `/api/org/${org}/tavle/oppsett`)).data.utelatt).toEqual([{ oppgave_id: id.Lab, ansatt_id: id.Kari }]);
    expect((await utelat({ ansatt_id: id.Kari, oppgave_id: id.Ola, kan: false })).status).toBe(404);
    expect((await utelat({ ansatt_id: id.Kari, kan: true }, ola)).status).toBe(403);

    // Kari har ferie onsdag.
    expect((await kall("POST", `/api/org/${org}/fravaer`, { ansatt_id: id.Kari, type: "ferie", fra: d(2), til: d(2) })).status).toBe(201);
    const r = (await rull()).data;
    const alle = (r.dager as Dag[]).flatMap((x) => x.plasser.map((p) => ({ ...p, dato: x.dato })));
    expect(alle.filter((p) => p.ansatt_id === id.Kari && p.oppgave_id === id.Lab)).toEqual([]);
    expect(alle.filter((p) => p.ansatt_id === id.Kari && p.dato === d(2))).toEqual([]);
    expect((r.dager as Dag[]).find((x) => x.dato === d(2))!.plasser).toHaveLength(4);

    // Per er ikke med i rulleringen i det hele tatt (alle oppgavene), og står ikke som uplassert.
    expect((await utelat({ ansatt_id: id.Per, kan: false })).status).toBe(204);
    const uten = (await rull({ behold: false })).data;
    expect((uten.dager as Dag[]).flatMap((x) => x.plasser).filter((p) => p.ansatt_id === id.Per)).toEqual([]);
    expect((uten.dager as Dag[]).flatMap((x) => x.ikke_plassert)).toEqual([]);
    expect((await utelat({ ansatt_id: id.Per, kan: true })).status).toBe(204);
    expect((await utelat({ ansatt_id: id.Kari, kan: true })).status).toBe(204);
    expect((await kall("GET", `/api/org/${org}/tavle/oppsett`)).data.utelatt).toEqual([]);
  });

  it("fast oppgave: står der hver dag uten en annen plass, rulleringen setter dem alltid der, og vikaren tar over", async () => {
    let N = d(7);
    while ([0, 1].map((i) => pluss(N, i)).some(helligdag)) N = pluss(N, 7);
    const fast = (k: Record<string, unknown>, hvem = eier) => kall("PUT", `/api/org/${org}/tavle/fast-oppgave`, k, hvem);
    expect((await fast({ ansatt_id: id.Ola, oppgave_id: id.Lab })).status).toBe(204);
    expect((await fast({ ansatt_id: id.Ola, oppgave_id: id.Lab }, ola)).status).toBe(403);
    expect((await fast({ ansatt_id: id.Ola, oppgave_id: id.Kari })).data.error).toBe("Fant ikke oppgaven");

    // Uten noen plass står Ola i laben både før og etter lunsj (regnet ut, ikke lagret).
    const t = await tavle(N);
    expect(t.fast_oppgave).toEqual([{ ansatt_id: id.Ola, oppgave_id: id.Lab }]);
    expect(t.plasseringer.map((p: any) => [p.fase_id, p.oppgave_id, p.ansatt_id, p.fast])).toEqual([
      [id["Før lunsj"], id.Lab, id.Ola, true],
      [id["Etter lunsj"], id.Lab, id.Ola, true],
    ]);
    // Ola ser det under Mine vakter.
    expect((await kall("GET", `/api/org/${org}/tavle/mine?fra=${N}&til=${N}`, undefined, ola)).data.map((p: any) => [p.fase, p.oppgave])).toEqual([
      ["Før lunsj", "Lab"],
      ["Etter lunsj", "Lab"],
    ]);

    // Rulleringen setter Ola i laben hele uka, og de andre deler resten.
    const r = (await kall("POST", `/api/org/${org}/tavle/rullering`, { fra: N, til: pluss(N, 4) })).data;
    const alle = (r.dager as Dag[]).flatMap((x) => x.plasser);
    expect(alle.filter((p) => p.ansatt_id === id.Ola).map((p) => p.oppgave_id)).toEqual(new Array(10).fill(id.Lab));
    expect(alle.filter((p) => p.ansatt_id !== id.Ola && p.oppgave_id === id.Lab)).toEqual([]);

    // En plass for hånd står foran den faste oppgaven, bare den dagen og den fasen.
    expect((await kall("PUT", `/api/org/${org}/tavle/plassering`, { dato: N, fase_id: id["Før lunsj"], ansatt_id: id.Ola, oppgave_id: id.Telefon })).status).toBe(204);
    expect((await tavle(N)).plasseringer.map((p: any) => [p.fase_id, p.oppgave_id, !!p.fast])).toEqual([
      [id["Før lunsj"], id.Telefon, false],
      [id["Etter lunsj"], id.Lab, true],
    ]);

    // Ola er syk dagen etter: vikaren (Per) tar over plassene i laben.
    const N1 = pluss(N, 1);
    const vakt = (await kall("POST", `/api/org/${org}/vakter`, { ansatt_id: id.Ola, dato: N1, fra: "08:00", til: "16:00" })).data;
    expect((await kall("POST", `/api/org/${org}/fravaer`, { ansatt_id: id.Ola, type: "syk", fra: N1, til: N1 })).status).toBe(201);
    expect((await kall("POST", `/api/org/${org}/vakter/${vakt.id}/vikar`, { ansatt_id: id.Per, publiser: false })).status).toBe(201);
    const t1 = await tavle(N1);
    expect(t1.plasseringer.filter((p: any) => p.ansatt_id === id.Ola)).toEqual([]);
    expect(t1.plasseringer.filter((p: any) => p.ansatt_id === id.Per).map((p: any) => [p.fase_id, p.oppgave_id, !!p.fast])).toEqual([
      [id["Før lunsj"], id.Lab, false],
      [id["Etter lunsj"], id.Lab, false],
    ]);

    // Uten fast oppgave er Ola med i rulleringen igjen, og står ikke i laben av seg selv.
    expect((await fast({ ansatt_id: id.Ola, oppgave_id: null })).status).toBe(204);
    expect((await tavle(N)).plasseringer.map((p: any) => [p.fase_id, p.oppgave_id])).toEqual([[id["Før lunsj"], id.Telefon]]);
    expect((await tavle(N)).fast_oppgave).toEqual([]);
  });

  it("bare eier og administrator kjører rulleringen, for høyst 31 dager", async () => {
    expect((await rull({}, ola)).status).toBe(403);
    expect((await rull({ fra: d(4), til: d(0) })).data.error).toBe("Slutten er før starten");
    expect((await rull({ til: d(31) })).data.error).toBe("Velg en periode på høyst 31 dager");
    expect((await rull({ til: d(30) })).status).toBe(200);
  });
});
