// Automatisk turnus (0106_turnus.sql): fordeler de ansatte på vaktene i en periode etter
// bemanningsbehovet per vakttype og ukedag (helligdagene som søndager), uansett hvilke ukedager
// de pleier å jobbe. Ren funksjon uten database, så den kan testes og gir det samme hver gang for
// de samme dataene (forslaget og innleggingen blir like).
//
// Dagene regnes én om gangen, i rekkefølge. Behovet en dag er det som står igjen når vaktene som
// finnes (også ledige vakter, men ikke vaktene til dem som er borte), er trukket fra. Plassene
// fordeles som en tilordning med lavest samlet «kostnad» (den ungarske metoden, som rulleringen
// på tavla), så dagen blir best mulig og ikke bare grådig.
//
// Reglene (en vakt som bryter dem, lages aldri; plassen blir heller stående åpen):
//   - personen kan gå vakttypen, har rollen plassen krever, er ansatt og ikke borte
//   - én vakt per døgn og ingen overlapp
//   - minst så mange timer hvile mellom vaktene som i reglene (11 etter arbeidsmiljøloven § 10-8)
//   - høyst så mange dager og nattevakter på rad som i reglene
//   - høyst hver n-te helg (lørdag og søndag; begge dagene i samme helg teller som én)
//   - høyst den ukentlige grensen for alminnelig arbeidstid, og minst 35 timer sammenhengende fri
//     i uka (§ 10-8 andre ledd)
//   - ikke mer enn den avtalte arbeidstiden (stillingsprosenten) i uka, med vaktene som står der
//     fra før (dagene personen er borte eller ikke ansatt, trekkes fra): en vakt til gis bare når
//     den bringer personen nærmere det avtalte. Så blir ikke turnusen ekstratimer i lønnen.
//     Tilkallingsvikarer (uten avtalt arbeidstid) brukes bare når ingen andre kan.
// For dem som ikke er arbeidstakere (rollen, 0056_roller.sql), gjelder ikke arbeidsmiljølovens
// grenser (hvile, uke og 35 timer fri).
//
// Hvem som får plassen (kostnaden): den som ligger mest bak det avtalte så langt i ukene,
// helst samme vakttype som dagen før (vakter i blokker), og jevn fordeling av nattevakter og
// helger etter stillingsstørrelse. Begge dagene i en helg går helst til den samme, og en dagvakt
// rett etter nattevakter unngås.
//
// Klokkeslettene regnes som lokal tid uten sommertid, som advarslene i vaktplanen (vaktregler.ts).
import { tilordne } from "./rullering.js";
import { helligdag } from "./helligdager.js";
import { uke } from "./arbeidstid.js";

export type TVakttype = { id: string; kode: string; navn: string; fra: string; til: string; pause_min: number; timer: number };
// Behovet: rolle_id null er så mange til, med hvilken som helst rolle.
export type TBehov = { vakttype_id: string; ukedag: number; rolle_id: string | null; antall: number };
export type TPerson = {
  id: string;
  navn: string;
  rolle_id: string | null;
  ansatt_fra: string;
  ansatt_til: string | null;
  arbeidstaker: boolean;
  avtalt: number; // avtalt arbeidstid i uka (timer); 0: tilkallingsvikar
  vakttyper: string[]; // vakttypene personen kan gå
};
// Vaktene som står (også før og etter perioden, for hviletiden, radene og helgene). ansatt_id
// null: ledig vakt.
export type TVakt = { ansatt_id: string | null; dato: string; fra: string; til: string; timer: number; vakttype_id: string | null; rolle_id: string | null };
export type TFravaer = { ansatt_id: string; fra: string; til: string };
export type TRegler = { hvile: number; dager_paa_rad: number; netter_paa_rad: number; helg: number; ukentlig_grense: number };
export type TInn = {
  fra: string;
  til: string;
  vakttyper: TVakttype[];
  behov: TBehov[];
  personer: TPerson[];
  vakter: TVakt[];
  fravaer: TFravaer[];
  regler: TRegler;
  // Lag ledige vakter (for rollen) for det som ikke kan fylles.
  ledige: boolean;
};
export type TNyVakt = { ansatt_id: string | null; dato: string; vakttype_id: string; rolle_id: string | null; fra: string; til: string; pause_min: number; timer: number };
export type THull = { dato: string; vakttype_id: string; rolle_id: string | null; antall: number; grunn: string };
export type TOppsummering = {
  ansatt_id: string;
  navn: string;
  // I de hele ukene perioden dekker: den avtalte arbeidstiden (uten dagene personen er borte), og
  // det som er planlagt, med vaktene som sto fra før.
  maal: number;
  timer: number;
  nye: number; // nye vakter fra forslaget
  netter: number;
  helger: number;
  per_type: Record<string, number>;
};
export type TForslag = { vakter: TNyVakt[]; hull: THull[]; personer: TOppsummering[] };

const DAG = 1440;
const minutter = (dato: string, kl: string) => Date.parse(`${dato}T${kl.slice(0, 5)}:00Z`) / 60_000;
const leggTil = (iso: string, n: number) => new Date(Date.parse(`${iso}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const dagerMellom = (a: string, b: string) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86_400_000);
export const ukedag = (iso: string) => ((new Date(`${iso}T12:00:00Z`).getUTCDay() + 6) % 7) + 1; // 1 = mandag
const rund = (t: number) => Math.round(t * 100) / 100;
const kl = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));

// Når vakten starter og slutter (i minutter), over midnatt når til er før fra.
function tidsrom(dato: string, fra: string, til: string) {
  const start = minutter(dato, fra);
  let slutt = minutter(dato, til);
  if (slutt <= start) slutt += DAG;
  return { start, slutt };
}

// En nattevakt har minst tre timer mellom kl. 00 og 06 (dagen etter når den starter før midnatt).
export function erNatt(t: Pick<TVakttype, "fra" | "til">) {
  const s = kl(t.fra);
  let e = kl(t.til);
  if (e <= s) e += DAG;
  const natt = (a: number, b: number) => Math.max(0, Math.min(e, b) - Math.max(s, a));
  return natt(0, 360) + natt(DAG, DAG + 360) >= 180;
}

// Helgen datoen hører til (lørdagen), eller null på hverdager.
const helgen = (dato: string) => (ukedag(dato) === 6 ? dato : ukedag(dato) === 7 ? leggTil(dato, -1) : null);
// Dagen behovet hentes fra: helligdager som søndag.
const behovsdag = (dato: string) => (helligdag(dato) ? 7 : ukedag(dato));

// Litt «tilfeldig», men alltid likt, for å skille likeverdige valg (FNV-1a).
function stoy(s: string) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % 100;
}

type Skift = { dato: string; start: number; slutt: number; timer: number; natt: boolean; type: string | null };
type Tilstand = {
  p: TPerson;
  skift: Skift[]; // sortert etter start
  perDag: Map<string, Skift>;
  maal: number;
  ukemaal: Map<string, number>; // den avtalte arbeidstiden hver uke (mandagen)
  timer: number; // i ukene
  nye: number;
  netter: number;
  helger: Set<string>; // helgene (lørdagene) personen jobber, også før og etter perioden
  perType: Map<string, number>;
  borte: (dato: string) => boolean;
};

// Kostnadene. UMULIG: bryter en regel. RESERVE: tilkallingsvikarer, bare når ingen andre kan.
const UMULIG = 1e12;
const RESERVE = 1e9;

export function planlegg(inn: TInn): TForslag {
  const r = inn.regler;
  const typer = new Map(inn.vakttyper.map((t) => [t.id, { ...t, natt: erNatt(t) }]));
  const dager = Array.from({ length: dagerMellom(inn.fra, inn.til) + 1 }, (_, i) => leggTil(inn.fra, i));
  const iPerioden = (d: string) => d >= inn.fra && d <= inn.til;
  // De hele ukene perioden dekker (for den avtalte arbeidstiden).
  const ukene = { fra: uke(inn.fra).fra, til: uke(inn.til).til };
  const ukedager = Array.from({ length: dagerMellom(ukene.fra, ukene.til) + 1 }, (_, i) => leggTil(ukene.fra, i));
  const iUkene = (d: string) => d >= ukene.fra && d <= ukene.til;

  const lagSkift = (dato: string, fra: string, til: string, timer: number, type: string | null): Skift => {
    const t = type ? typer.get(type) : undefined;
    return { dato, ...tidsrom(dato, fra, til), timer: Number(timer), natt: t ? t.natt : erNatt({ fra, til }), type };
  };

  const tilstand = new Map<string, Tilstand>();
  for (const p of inn.personer) {
    const borte = inn.fravaer.filter((f) => f.ansatt_id === p.id);
    const erBorte = (d: string) => borte.some((f) => d >= f.fra && d <= f.til);
    const tilgjengelig = (d: string) => d >= p.ansatt_fra && (!p.ansatt_til || d <= p.ansatt_til) && !erBorte(d);
    const ukemaal = new Map<string, number>();
    for (const d of ukedager) if (tilgjengelig(d)) ukemaal.set(uke(d).fra, rund((ukemaal.get(uke(d).fra) ?? 0) + Number(p.avtalt) / 7));
    tilstand.set(p.id, {
      p,
      skift: [],
      perDag: new Map(),
      maal: rund((Number(p.avtalt) / 7) * ukedager.filter(tilgjengelig).length),
      ukemaal,
      timer: 0,
      nye: 0,
      netter: 0,
      helger: new Set(),
      perType: new Map(),
      borte: erBorte,
    });
  }

  const leggTilSkift = (s: Tilstand, sk: Skift, ny: boolean) => {
    const i = s.skift.findIndex((x) => x.start > sk.start);
    s.skift.splice(i < 0 ? s.skift.length : i, 0, sk);
    if (!s.perDag.has(sk.dato)) s.perDag.set(sk.dato, sk);
    const h = helgen(sk.dato);
    if (h) s.helger.add(h);
    if (iUkene(sk.dato)) s.timer = rund(s.timer + sk.timer);
    if (!iPerioden(sk.dato)) return;
    if (sk.natt) s.netter++;
    if (sk.type) s.perType.set(sk.type, (s.perType.get(sk.type) ?? 0) + 1);
    if (ny) s.nye++;
  };

  // En vakt uten vakttype hører til vakttypen med de samme klokkeslettene (f.eks. lagt inn før
  // turnusen).
  const typeFor = (v: TVakt) =>
    v.vakttype_id ?? inn.vakttyper.find((t) => t.fra.slice(0, 5) === v.fra.slice(0, 5) && t.til.slice(0, 5) === v.til.slice(0, 5))?.id ?? null;

  // Vaktene som står: hos personene, og som dekning av behovet (ikke når personen er borte).
  const dekning = new Map<string, TVakt[]>(); // dato:vakttype → vaktene
  for (const v of inn.vakter) {
    const type = typeFor(v);
    const s = v.ansatt_id ? tilstand.get(v.ansatt_id) : undefined;
    if (s) leggTilSkift(s, lagSkift(v.dato, v.fra, v.til, v.timer, type), false);
    const borte = v.ansatt_id ? inn.fravaer.some((f) => f.ansatt_id === v.ansatt_id && v.dato >= f.fra && v.dato <= f.til) : false;
    if (type && iPerioden(v.dato) && !borte) {
      const k = `${v.dato}:${type}`;
      dekning.set(k, [...(dekning.get(k) ?? []), v]);
    }
  }
  const rolleTil = new Map(inn.personer.map((p) => [p.id, p.rolle_id]));

  // Hvorfor personen ikke kan ta vakttypen den dagen (null: kan).
  function hindring(s: Tilstand, dato: string, t: TVakttype & { natt: boolean }): string | null {
    const p = s.p;
    if (!p.vakttyper.includes(t.id)) return "kan ikke gå vakttypen";
    if (dato < p.ansatt_fra || (p.ansatt_til && dato > p.ansatt_til)) return "ikke ansatt";
    if (s.borte(dato)) return "borte";
    if (s.perDag.has(dato)) return "har vakt";
    const { start, slutt } = tidsrom(dato, t.fra, t.til);
    const hvile = r.hvile * 60;
    const aml = p.arbeidstaker !== false;
    for (const x of s.skift) {
      if (x.start < slutt && start < x.slutt) return "har vakt";
      if (aml && x.slutt <= start && start - x.slutt < hvile) return "for lite hvile";
      if (aml && x.start >= slutt && x.start - slutt < hvile) return "for lite hvile";
    }
    // Dager (og netter) på rad, med vakten.
    const rad = (natt: boolean) => {
      const med = (d: string) => {
        const x = s.perDag.get(d);
        return !!x && (!natt || x.natt);
      };
      let n = 1;
      for (let d = leggTil(dato, -1); med(d); d = leggTil(d, -1)) n++;
      for (let d = leggTil(dato, 1); med(d); d = leggTil(d, 1)) n++;
      return n;
    };
    if (rad(false) > r.dager_paa_rad) return "for mange dager på rad";
    if (t.natt && rad(true) > r.netter_paa_rad) return "for mange netter på rad";
    // Hver n-te helg: ingen andre helger nærmere enn n uker (samme helg er greit).
    const h = helgen(dato);
    if (h && r.helg > 1 && !s.helger.has(h))
      for (let k = 1; k < r.helg; k++) if (s.helger.has(leggTil(h, -7 * k)) || s.helger.has(leggTil(h, 7 * k))) return "jobber helg for ofte";
    const u = uke(dato);
    const iUka = s.skift.filter((x) => x.dato >= u.fra && x.dato <= u.til).reduce((sum, x) => sum + x.timer, 0);
    if (s.maal > 0 && iUka + t.timer / 2 > (s.ukemaal.get(u.fra) ?? 0) + 1e-9) return "har nok timer den uka";
    if (aml) {
      if (iUka + t.timer > r.ukentlig_grense + 1e-9) return `over ${r.ukentlig_grense} timer i uka`;
      // Minst 35 timer sammenhengende fri i uka(e) vakten berører.
      for (const mandag of new Set([u.fra, uke(leggTil(dato, slutt - minutter(dato, "00:00") > DAG ? 1 : 0)).fra])) {
        const a = minutter(mandag, "00:00");
        const b = a + 7 * DAG;
        const arbeid = [...s.skift.map((x) => [x.start, x.slutt] as const), [start, slutt] as const]
          .filter(([x, y]) => y > a && x < b)
          .map(([x, y]) => [Math.max(x, a), Math.min(y, b)] as const)
          .sort((x, y) => x[0] - y[0]);
        let lengst = 0;
        let fri = a;
        for (const [x, y] of arbeid) {
          lengst = Math.max(lengst, x - fri);
          fri = Math.max(fri, y);
        }
        if (Math.max(lengst, b - fri) < 35 * 60) return "mindre enn 35 timer fri i uka";
      }
    }
    if (s.maal > 0 && s.timer + t.timer / 2 > s.maal + 1e-9) return "har nok timer";
    return null;
  }

  // Kostnaden for at personen tar vakttypen den dagen (lavere er bedre).
  function kostnad(s: Tilstand, dato: string, t: TVakttype & { natt: boolean }): number {
    const p = s.p;
    let k = s.maal > 0 ? 0 : RESERVE;
    // Bak det avtalte så langt i ukene (pro rata): jo mer bak, jo bedre.
    const forventet = (s.maal * (dagerMellom(ukene.fra, dato) + 1)) / ukedager.length;
    k -= (forventet - s.timer) * 1000;
    // Jevn fordeling av nattevakter og helger etter stillingsstørrelse.
    const stilling = Math.max(0.2, Number(p.avtalt) / 37.5);
    if (t.natt) k += (s.netter / stilling) * 1500;
    const h = helgen(dato);
    if (h) k += s.helger.has(h) ? -4000 : ([...s.helger].filter(iPerioden).length / stilling) * 2500;
    // Vakter i blokker: samme vakttype som dagen før, og helst en arbeidsdag etter en annen.
    const igaar = s.perDag.get(leggTil(dato, -1));
    if (igaar?.type === t.id) k -= 3000;
    else if (igaar) k -= 500;
    // Ikke en dagvakt rett etter nattevakter (to døgn).
    const { start } = tidsrom(dato, t.fra, t.til);
    if (!t.natt && s.skift.some((x) => x.natt && x.slutt <= start && start - x.slutt < 2 * DAG)) k += 2000;
    return k + stoy(`${p.id}:${dato}:${t.id}`);
  }

  const nye: TNyVakt[] = [];
  const hull: THull[] = [];
  for (const dato of dager) {
    // Plassene som står åpne denne dagen: vakttype og rolle (null: hvilken som helst).
    const plasser: { t: TVakttype & { natt: boolean }; rolle: string | null }[] = [];
    // Nattevakter først i lista (færrest kan dem); tilordningen ser på alle samtidig uansett.
    const sortert = [...typer.values()].sort((a, b) => Number(b.natt) - Number(a.natt) || a.fra.localeCompare(b.fra));
    for (const t of sortert) {
      const behov = inn.behov.filter((b) => b.vakttype_id === t.id && b.ukedag === behovsdag(dato));
      if (!behov.length) continue;
      // Vaktene som står, dekker først behovet for sin rolle (vaktens eller personens), og resten
      // det uten rolle.
      const igjen = new Map(behov.map((b) => [b.rolle_id ?? "", Number(b.antall)]));
      const stod = dekning.get(`${dato}:${t.id}`) ?? [];
      let fri = 0;
      for (const v of stod) {
        const rolle = v.rolle_id ?? (v.ansatt_id ? rolleTil.get(v.ansatt_id) ?? null : null);
        if (rolle && (igjen.get(rolle) ?? 0) > 0) igjen.set(rolle, igjen.get(rolle)! - 1);
        else fri++;
      }
      igjen.set("", Math.max(0, (igjen.get("") ?? 0) - fri));
      for (const [rolle, n] of igjen) for (let i = 0; i < n; i++) plasser.push({ t, rolle: rolle || null });
    }
    if (!plasser.length) continue;

    const folk = [...tilstand.values()];
    const grunner: Map<string, string>[] = plasser.map(() => new Map());
    // Det samme for alle plassene med samme vakttype: hindringen eller kostnaden.
    const huske = new Map<string, { hvorfor: string | null; k: number }>();
    const kost = plasser.map((pl, i) =>
      folk.map((s) => {
        if (pl.rolle && s.p.rolle_id !== pl.rolle) return UMULIG;
        const n = `${pl.t.id}:${s.p.id}`;
        let svar = huske.get(n);
        if (!svar) {
          const hvorfor = hindring(s, dato, pl.t);
          svar = { hvorfor, k: hvorfor ? UMULIG : kostnad(s, dato, pl.t) };
          huske.set(n, svar);
        }
        if (svar.hvorfor) grunner[i]!.set(s.p.id, svar.hvorfor);
        return svar.k;
      }),
    );
    const valgt = tilordne(kost);
    plasser.forEach((pl, i) => {
      const j = valgt[i]!;
      const s = j >= 0 && kost[i]![j]! < UMULIG ? folk[j]! : null;
      if (s) {
        leggTilSkift(s, lagSkift(dato, pl.t.fra, pl.t.til, pl.t.timer, pl.t.id), true);
        nye.push({ ansatt_id: s.p.id, dato, vakttype_id: pl.t.id, rolle_id: pl.rolle, fra: pl.t.fra, til: pl.t.til, pause_min: pl.t.pause_min, timer: pl.t.timer });
        return;
      }
      if (inn.ledige)
        nye.push({ ansatt_id: null, dato, vakttype_id: pl.t.id, rolle_id: pl.rolle, fra: pl.t.fra, til: pl.t.til, pause_min: pl.t.pause_min, timer: pl.t.timer });
      const finnes = hull.find((h) => h.dato === dato && h.vakttype_id === pl.t.id && h.rolle_id === pl.rolle);
      if (finnes) finnes.antall++;
      else hull.push({ dato, vakttype_id: pl.t.id, rolle_id: pl.rolle, antall: 1, grunn: grunn(grunner[i]!, pl.rolle !== null) });
    });
  }

  return {
    vakter: nye,
    hull,
    personer: [...tilstand.values()]
      .filter((s) => s.p.vakttyper.length > 0 || s.timer > 0)
      .map((s) => ({
        ansatt_id: s.p.id,
        navn: s.p.navn,
        maal: s.maal,
        timer: s.timer,
        nye: s.nye,
        netter: s.netter,
        helger: [...s.helger].filter((h) => iPerioden(h) || iPerioden(leggTil(h, 1))).length,
        per_type: Object.fromEntries(s.perType),
      })),
  };
}

// Hvorfor plassen ikke ble fylt: hindringene til dem som kunne ha tatt den, de vanligste først.
function grunn(hindringer: Map<string, string>, medRolle: boolean): string {
  const telt = new Map<string, number>();
  for (const h of hindringer.values()) if (h && h !== "kan ikke gå vakttypen") telt.set(h, (telt.get(h) ?? 0) + 1);
  if (!telt.size) return medRolle ? "Ingen med rollen kan gå vakttypen" : "Ingen kan gå vakttypen";
  return [...telt.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([h, n]) => `${n} ${h}`)
    .join(", ");
}
