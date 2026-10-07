// Vaktplan: advarsler etter arbeidsmiljøloven mens vaktene planlegges. Planen kan ha grunner
// til å avvike (en avtale om kortere hvile, gjennomsnittsberegning), så dette er advarsler og
// ikke feil:
//   - minst 11 timer sammenhengende hvile mellom to arbeidsdager (§ 10-8 første ledd); delte
//     vakter samme dag regnes som én arbeidsdag
//   - minst 35 timer sammenhengende fri i løpet av uka (§ 10-8 andre ledd)
//   - over grensen for alminnelig arbeidstid per dag og per uke (overtid, § 10-4), etter
//     grensene i oppsettet
//   - vakter som overlapper, og vakter når den ansatte ikke er aktiv eller ansatt
// Klokkeslettene regnes som lokal tid uten sommertid; natten klokka stilles, kan hvilen bli en
// time feil.
import { uke, type Regler } from "./arbeidstid.js";

export type PlanVakt = { id: string; ansatt_id: string | null; dato: string; fra: string; til: string; timer: number };
export type Ansettelse = { ansatt_fra: string; ansatt_til: string | null; aktiv: boolean };

const DAG = 24 * 60;
const minutter = (dato: string, klokke: string) => Date.parse(`${dato}T${klokke.slice(0, 5)}:00Z`) / 60_000;
const tall = (n: number) => n.toLocaleString("nb-NO", { maximumFractionDigits: 2 });

// Når vakten starter og slutter (i minutter), over midnatt når til er før fra.
export function tidsrom(v: Pick<PlanVakt, "dato" | "fra" | "til">) {
  const start = minutter(v.dato, v.fra);
  let slutt = minutter(v.dato, v.til);
  if (slutt <= start) slutt += DAG;
  return { start, slutt };
}

// Advarslene per vakt og per ansatt og uke (nøkkel «ansatt:mandag»).
export function advarsler(vakter: PlanVakt[], r: Regler, ansettelser: Map<string, Ansettelse>) {
  const perVakt = new Map<string, string[]>();
  const perUke = new Map<string, string[]>();
  const legg = (m: Map<string, string[]>, k: string, tekst: string) => {
    const l = m.get(k) ?? [];
    if (!l.includes(tekst)) l.push(tekst);
    m.set(k, l);
  };

  const perAnsatt = new Map<string, PlanVakt[]>();
  for (const v of vakter) if (v.ansatt_id) perAnsatt.set(v.ansatt_id, [...(perAnsatt.get(v.ansatt_id) ?? []), v]);

  for (const [ansatt, liste] of perAnsatt) {
    const a = ansettelser.get(ansatt);
    for (const v of liste) {
      if (a && !a.aktiv) legg(perVakt, v.id, "Den ansatte er ikke aktiv");
      else if (a && (v.dato < a.ansatt_fra || (a.ansatt_til && v.dato > a.ansatt_til))) legg(perVakt, v.id, "Ikke ansatt denne dagen");
    }

    const tider = liste.map((v) => ({ v, ...tidsrom(v) })).sort((x, y) => x.start - y.start);
    for (let i = 0; i < tider.length; i++)
      for (let j = i + 1; j < tider.length && tider[j]!.start < tider[i]!.slutt; j++) {
        legg(perVakt, tider[i]!.v.id, "Overlapper med en annen vakt");
        legg(perVakt, tider[j]!.v.id, "Overlapper med en annen vakt");
      }

    // Hvile mellom arbeidsdagene: fra slutten av den ene til starten av den neste.
    const dager = new Map<string, { start: number; slutt: number; forste: string; timer: number; vakter: string[] }>();
    for (const t of tider) {
      const d = dager.get(t.v.dato);
      if (!d) dager.set(t.v.dato, { start: t.start, slutt: t.slutt, forste: t.v.id, timer: Number(t.v.timer), vakter: [t.v.id] });
      else Object.assign(d, { slutt: Math.max(d.slutt, t.slutt), timer: d.timer + Number(t.v.timer), vakter: [...d.vakter, t.v.id] });
    }
    const dagliste = [...dager.entries()].sort(([x], [y]) => x.localeCompare(y));
    for (let k = 1; k < dagliste.length; k++) {
      const hvile = dagliste[k]![1].start - dagliste[k - 1]![1].slutt;
      if (hvile >= 0 && hvile < 11 * 60) legg(perVakt, dagliste[k]![1].forste, `Bare ${tall(hvile / 60)} timer hvile før vakten (minst 11)`);
    }
    for (const [, d] of dagliste)
      if (d.timer > r.daglig_grense) for (const id of d.vakter) legg(perVakt, id, `Over ${tall(r.daglig_grense)} timer denne dagen (overtid)`);

    // Per uke: timer over grensen, og 35 timer sammenhengende fri.
    const uker = new Map<string, PlanVakt[]>();
    for (const v of liste) {
      const m = uke(v.dato).fra;
      uker.set(m, [...(uker.get(m) ?? []), v]);
    }
    for (const [mandag, ukevakter] of uker) {
      const sum = ukevakter.reduce((s, v) => s + Number(v.timer), 0);
      if (sum > r.ukentlig_grense) legg(perUke, `${ansatt}:${mandag}`, `Planlagt ${tall(sum)} timer (over ${tall(r.ukentlig_grense)})`);
      const start = minutter(mandag, "00:00");
      const slutt = start + 7 * DAG;
      const arbeid = tider.filter((t) => t.slutt > start && t.start < slutt).map((t) => [Math.max(t.start, start), Math.min(t.slutt, slutt)] as const);
      let lengst = 0;
      let fri = start;
      for (const [s, e] of arbeid) {
        lengst = Math.max(lengst, s - fri);
        fri = Math.max(fri, e);
      }
      lengst = Math.max(lengst, slutt - fri);
      if (lengst < 35 * 60) legg(perUke, `${ansatt}:${mandag}`, "Mindre enn 35 timer sammenhengende fri i uka");
    }
  }
  return { perVakt, perUke };
}
