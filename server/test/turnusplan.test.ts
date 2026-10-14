// Automatisk turnus (server/src/turnusplan.ts) for seg: behovet fylles uten å bryte reglene
// (hviletid, én vakt per døgn, dager og netter på rad, helger, timer i uka, 35 timer fri,
// avtalt arbeidstid), rollene, fraværet og vaktene som står, tas hensyn til, og det som ikke kan
// fylles, blir ledige vakter med en grunn.
import { describe, expect, it } from "vitest";
import { erNatt, planlegg, type TBehov, type TInn, type TNyVakt, type TPerson, type TVakt, type TVakttype } from "../src/turnusplan.js";

const pluss = (iso: string, n: number) => new Date(Date.parse(`${iso}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const D: TVakttype = { id: "D", kode: "D", navn: "Dagvakt", fra: "07:00", til: "15:00", pause_min: 30, timer: 7.5 };
const K: TVakttype = { id: "K", kode: "K", navn: "Kveldsvakt", fra: "15:00", til: "23:00", pause_min: 30, timer: 7.5 };
const N: TVakttype = { id: "N", kode: "N", navn: "Nattevakt", fra: "23:00", til: "07:00", pause_min: 0, timer: 8 };
const ALLE = ["D", "K", "N"];
// Mandag 2. november 2026: fire hele uker uten helligdager.
const FRA = "2026-11-02";
const TIL = "2026-11-29";
const person = (id: string, p: Partial<TPerson> = {}): TPerson => ({
  id,
  navn: id,
  rolle_id: null,
  ansatt_fra: "2020-01-01",
  ansatt_til: null,
  arbeidstaker: true,
  avtalt: 37.5,
  vakttyper: ALLE,
  ...p,
});
const hverDag = (type: string, antall: number, rolle_id: string | null = null): TBehov[] =>
  [1, 2, 3, 4, 5, 6, 7].map((ukedag) => ({ vakttype_id: type, ukedag, rolle_id, antall }));
const kjor = (k: Partial<TInn> & Pick<TInn, "personer" | "behov">) =>
  planlegg({
    fra: FRA,
    til: TIL,
    vakttyper: [D, K, N],
    vakter: [],
    fravaer: [],
    regler: { hvile: 11, dager_paa_rad: 5, netter_paa_rad: 3, helg: 1, ukentlig_grense: 40 },
    ledige: true,
    ...k,
  });

const minutter = (dato: string, kl: string) => Date.parse(`${dato}T${kl}:00Z`) / 60_000;
const tidsrom = (v: Pick<TNyVakt, "dato" | "fra" | "til">) => {
  const start = minutter(v.dato, v.fra);
  let slutt = minutter(v.dato, v.til);
  if (slutt <= start) slutt += 1440;
  return { start, slutt };
};
const mandagen = (d: string) => pluss(d, -((new Date(`${d}T12:00:00Z`).getUTCDay() + 6) % 7));

// Reglene, sjekket på det ferdige forslaget (sammen med vaktene som sto fra før).
function sjekkRegler(vakter: (TNyVakt | TVakt)[], r: { hvile: number; dager_paa_rad: number; netter_paa_rad: number; ukentlig_grense: number }) {
  const perPerson = new Map<string, (TNyVakt | TVakt)[]>();
  for (const v of vakter) if (v.ansatt_id) perPerson.set(v.ansatt_id, [...(perPerson.get(v.ansatt_id) ?? []), v]);
  for (const [, liste] of perPerson) {
    const sortert = liste.map((v) => ({ v, ...tidsrom(v) })).sort((a, b) => a.start - b.start);
    for (let i = 1; i < sortert.length; i++) expect(sortert[i]!.start - sortert[i - 1]!.slutt).toBeGreaterThanOrEqual(r.hvile * 60);
    const datoer = new Set(liste.map((v) => v.dato));
    expect(datoer.size).toBe(liste.length); // én vakt per døgn
    for (const d of datoer) {
      let n = 1;
      while (datoer.has(pluss(d, n))) n++;
      expect(n).toBeLessThanOrEqual(r.dager_paa_rad);
    }
    const netter = new Set(liste.filter((v) => erNatt(v)).map((v) => v.dato));
    for (const d of netter) {
      let n = 1;
      while (netter.has(pluss(d, n))) n++;
      expect(n).toBeLessThanOrEqual(r.netter_paa_rad);
    }
    const uker = new Map<string, number>();
    for (const v of liste) uker.set(mandagen(v.dato), (uker.get(mandagen(v.dato)) ?? 0) + v.timer);
    for (const t of uker.values()) expect(t).toBeLessThanOrEqual(r.ukentlig_grense);
    // Minst 35 timer sammenhengende fri i hver uke.
    for (const mandag of uker.keys()) {
      const a = minutter(mandag, "00:00");
      const b = a + 7 * 1440;
      let lengst = 0;
      let fri = a;
      for (const s of sortert.filter((x) => x.slutt > a && x.start < b)) {
        lengst = Math.max(lengst, Math.max(s.start, a) - fri);
        fri = Math.max(fri, Math.min(s.slutt, b));
      }
      expect(Math.max(lengst, b - fri)).toBeGreaterThanOrEqual(35 * 60);
    }
  }
}

describe("automatisk turnus", () => {
  it("kjenner igjen nattevakter", () => {
    expect(erNatt(N)).toBe(true);
    expect(erNatt({ fra: "22:00", til: "08:00" })).toBe(true);
    expect(erNatt({ fra: "01:00", til: "09:00" })).toBe(true);
    expect(erNatt(K)).toBe(false);
    expect(erNatt({ fra: "15:00", til: "00:00" })).toBe(false);
    expect(erNatt(D)).toBe(false);
  });

  it("fyller dag, kveld og natt i fire uker uten å bryte reglene, og fordeler timene og nettene", () => {
    const personer = ["a", "b", "c", "d", "e", "f", "g", "h"].map((id) => person(id));
    const r = kjor({ personer, behov: [...hverDag("D", 2), ...hverDag("K", 2), ...hverDag("N", 1)] });
    const med = r.vakter.filter((v) => v.ansatt_id);
    sjekkRegler(med, { hvile: 11, dager_paa_rad: 5, netter_paa_rad: 3, ukentlig_grense: 40 });
    // Nesten alt dekket (28 dager × 5 vakter), og det som ikke er dekket, er ledige vakter.
    expect(med.length).toBeGreaterThanOrEqual(130);
    expect(r.vakter.length).toBe(140);
    expect(r.hull.reduce((s, h) => s + h.antall, 0)).toBe(140 - med.length);
    // Ingen over det avtalte (150 timer) med mer enn en halv vakt, og jevnt fordelt.
    for (const p of r.personer) {
      expect(p.maal).toBe(150);
      expect(p.timer).toBeLessThanOrEqual(150 + 4);
      expect(p.timer).toBeGreaterThanOrEqual(150 - 30);
    }
    const netter = r.personer.map((p) => p.netter);
    expect(Math.max(...netter) - Math.min(...netter)).toBeLessThanOrEqual(4);
    // Nattevaktene kommer i blokker: de fleste har en natt dagen før eller etter.
    const natt = new Set(med.filter((v) => v.vakttype_id === "N").map((v) => `${v.ansatt_id}:${v.dato}`));
    const iBlokk = [...natt].filter((k) => {
      const [a, d] = k.split(":") as [string, string];
      return natt.has(`${a}:${pluss(d, -1)}`) || natt.has(`${a}:${pluss(d, 1)}`);
    });
    expect(iBlokk.length / natt.size).toBeGreaterThan(0.6);
    // Det samme hver gang for de samme dataene.
    expect(kjor({ personer, behov: [...hverDag("D", 2), ...hverDag("K", 2), ...hverDag("N", 1)] })).toEqual(r);
  });

  it("deltid får timer etter stillingsprosenten, og tilkallingsvikaren brukes bare når ingen andre kan", () => {
    const r = kjor({
      personer: [person("hel"), person("halv", { avtalt: 18.75 }), person("vikar", { avtalt: 0 })],
      behov: hverDag("D", 1),
      regler: { hvile: 11, dager_paa_rad: 7, netter_paa_rad: 3, helg: 1, ukentlig_grense: 40 },
    });
    const timer = (id: string) => r.personer.find((p) => p.ansatt_id === id)!.timer;
    expect(timer("hel")).toBeGreaterThanOrEqual(142.5);
    expect(timer("halv")).toBeGreaterThanOrEqual(67.5);
    expect(timer("halv")).toBeLessThanOrEqual(75 + 3.75);
    // 28 dagvakter: hel og halv tar det de kan (rundt 30), og vikaren resten.
    expect(r.vakter.filter((v) => v.ansatt_id).length).toBe(28);
    expect(timer("vikar")).toBe(rundt(28 * 7.5 - timer("hel") - timer("halv")));
    expect(r.hull).toEqual([]);
  });

  it("hviletid, netter på rad og helger: plassen blir ledig med grunnen", () => {
    // Kveldsvakt mandag (fra før) og dagvakt tirsdag gir bare 8 timer hvile.
    const kveld: TVakt = { ansatt_id: "a", dato: FRA, fra: "15:00", til: "23:00", timer: 7.5, vakttype_id: "K", rolle_id: null };
    const hvile = planlegg({
      fra: pluss(FRA, 1),
      til: pluss(FRA, 1),
      vakttyper: [D, K, N],
      behov: [{ vakttype_id: "D", ukedag: 2, rolle_id: null, antall: 1 }],
      personer: [person("a")],
      vakter: [kveld],
      fravaer: [],
      regler: { hvile: 11, dager_paa_rad: 5, netter_paa_rad: 3, helg: 1, ukentlig_grense: 40 },
      ledige: true,
    });
    expect(hvile.vakter).toEqual([{ ansatt_id: null, dato: pluss(FRA, 1), vakttype_id: "D", rolle_id: null, fra: "07:00", til: "15:00", pause_min: 30, timer: 7.5 }]);
    expect(hvile.hull).toEqual([{ dato: pluss(FRA, 1), vakttype_id: "D", rolle_id: null, antall: 1, grunn: "1 for lite hvile" }]);
    // Med 8 timers hvile (avtale) går det.
    const avtale = planlegg({ ...hvile, fra: pluss(FRA, 1), til: pluss(FRA, 1), vakttyper: [D, K, N], behov: [{ vakttype_id: "D", ukedag: 2, rolle_id: null, antall: 1 }], personer: [person("a")], vakter: [kveld], fravaer: [], regler: { hvile: 8, dager_paa_rad: 5, netter_paa_rad: 3, helg: 1, ukentlig_grense: 40 }, ledige: true } as TInn);
    expect(avtale.vakter.map((v) => v.ansatt_id)).toEqual(["a"]);

    // Bare nattevakter i fem netter, høyst tre på rad: N N N – N.
    const natt = planlegg({
      fra: FRA,
      til: pluss(FRA, 4),
      vakttyper: [N],
      behov: hverDag("N", 1),
      personer: [person("a", { vakttyper: ["N"] })],
      vakter: [],
      fravaer: [],
      regler: { hvile: 11, dager_paa_rad: 7, netter_paa_rad: 3, helg: 1, ukentlig_grense: 40 },
      ledige: false,
    });
    expect(natt.vakter.map((v) => v.dato)).toEqual([FRA, pluss(FRA, 1), pluss(FRA, 2), pluss(FRA, 4)]);
    expect(natt.hull).toEqual([{ dato: pluss(FRA, 3), vakttype_id: "N", rolle_id: null, antall: 1, grunn: "1 for mange netter på rad" }]);

    // Annenhver helg: a jobbet helgen før perioden, så b tar lørdag og søndag; uten b blir de ledige.
    const lordag = pluss(FRA, 5);
    const forrigeHelg: TVakt = { ansatt_id: "a", dato: pluss(FRA, -2), fra: "07:00", til: "15:00", timer: 7.5, vakttype_id: "D", rolle_id: null };
    const helg = (personer: TPerson[]) =>
      planlegg({
        fra: lordag,
        til: pluss(lordag, 1),
        vakttyper: [D],
        behov: hverDag("D", 1),
        personer,
        vakter: [forrigeHelg],
        fravaer: [],
        regler: { hvile: 11, dager_paa_rad: 5, netter_paa_rad: 3, helg: 2, ukentlig_grense: 40 },
        ledige: true,
      });
    expect(helg([person("a"), person("b")]).vakter.map((v) => v.ansatt_id)).toEqual(["b", "b"]);
    const bareA = helg([person("a")]);
    expect(bareA.vakter.map((v) => v.ansatt_id)).toEqual([null, null]);
    expect(bareA.hull.map((h) => h.grunn)).toEqual(["1 jobber helg for ofte", "1 jobber helg for ofte"]);
  });

  it("rollene: plassene for en rolle går til dem med rollen, og en ledig vakt får rollen", () => {
    const behov: TBehov[] = [
      { vakttype_id: "D", ukedag: 1, rolle_id: "spl", antall: 1 },
      { vakttype_id: "D", ukedag: 1, rolle_id: null, antall: 1 },
    ];
    const inn = (fravaer: TInn["fravaer"]): TInn => ({
      fra: FRA,
      til: FRA,
      vakttyper: [D],
      behov,
      personer: [person("ola", { rolle_id: "ass" }), person("kari", { rolle_id: "spl" })],
      vakter: [],
      fravaer,
      regler: { hvile: 11, dager_paa_rad: 5, netter_paa_rad: 3, helg: 1, ukentlig_grense: 40 },
      ledige: true,
    });
    const begge = planlegg(inn([]));
    expect(begge.vakter.map((v) => `${v.ansatt_id}/${v.rolle_id}`).sort()).toEqual(["kari/spl", "ola/null"]);
    // Kari er borte: Ola tar plassen uten rolle, og sykepleierplassen blir en ledig vakt for rollen.
    const borte = planlegg(inn([{ ansatt_id: "kari", fra: FRA, til: FRA }]));
    expect(borte.vakter.map((v) => `${v.ansatt_id}/${v.rolle_id}`).sort()).toEqual(["null/spl", "ola/null"]);
    expect(borte.hull).toEqual([{ dato: FRA, vakttype_id: "D", rolle_id: "spl", antall: 1, grunn: "1 borte" }]);
    // Det avtalte regnes for hele uka, uten dagen Kari er borte.
    expect(borte.personer.find((p) => p.ansatt_id === "kari")!.maal).toBe(32.14);
  });

  it("vaktene som står, dekker behovet (også uten vakttype med de samme klokkeslettene), men ikke når personen er borte", () => {
    const behov = [{ vakttype_id: "D", ukedag: 1, rolle_id: null, antall: 2 }];
    const inn = (vakter: TVakt[], fravaer: TInn["fravaer"] = []): TInn => ({
      fra: FRA,
      til: FRA,
      vakttyper: [D],
      behov,
      personer: [person("a"), person("b"), person("c")],
      vakter,
      fravaer,
      regler: { hvile: 11, dager_paa_rad: 5, netter_paa_rad: 3, helg: 1, ukentlig_grense: 40 },
      ledige: true,
    });
    const typet: TVakt = { ansatt_id: "a", dato: FRA, fra: "07:00", til: "15:00", timer: 7.5, vakttype_id: "D", rolle_id: null };
    const utenType: TVakt = { ...typet, ansatt_id: "b", vakttype_id: null };
    expect(planlegg(inn([typet])).vakter).toHaveLength(1);
    expect(planlegg(inn([typet, utenType])).vakter).toEqual([]);
    // Ledige vakter teller også.
    expect(planlegg(inn([{ ...typet, ansatt_id: null }, utenType])).vakter).toEqual([]);
    // a er borte: vakten hennes dekker ikke, så to nye trengs, men ikke a.
    const r = planlegg(inn([typet], [{ ansatt_id: "a", fra: FRA, til: FRA }]));
    expect(r.vakter.map((v) => v.ansatt_id).sort()).toEqual(["b", "c"]);
  });

  it("helligdager bemannes som søndager, og bare med dem som er ansatt", () => {
    // 25. desember 2026 er en fredag.
    const r = planlegg({
      fra: "2026-12-25",
      til: "2026-12-25",
      vakttyper: [D],
      behov: [
        { vakttype_id: "D", ukedag: 5, rolle_id: null, antall: 3 },
        { vakttype_id: "D", ukedag: 7, rolle_id: null, antall: 1 },
      ],
      personer: [person("a"), person("ny", { ansatt_fra: "2027-01-01" })],
      vakter: [],
      fravaer: [],
      regler: { hvile: 11, dager_paa_rad: 5, netter_paa_rad: 3, helg: 1, ukentlig_grense: 40 },
      ledige: false,
    });
    expect(r.vakter.map((v) => v.ansatt_id)).toEqual(["a"]);
    expect(r.hull).toEqual([]);
  });

  it("ingen som kan gå vakttypen: grunnen sier det", () => {
    const r = kjor({ personer: [person("a", { vakttyper: ["D"] })], behov: [{ vakttype_id: "N", ukedag: 1, rolle_id: null, antall: 1 }] });
    expect(r.hull[0]).toMatchObject({ vakttype_id: "N", grunn: "Ingen kan gå vakttypen" });
    const rolle = kjor({ personer: [person("a")], behov: [{ vakttype_id: "D", ukedag: 1, rolle_id: "lege", antall: 1 }] });
    expect(rolle.hull[0]).toMatchObject({ rolle_id: "lege", grunn: "Ingen med rollen kan gå vakttypen" });
  });
});

const rundt = (t: number) => Math.round(t * 100) / 100;
