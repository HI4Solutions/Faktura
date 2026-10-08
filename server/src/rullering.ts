// Rullering på tavla (0051_tavle_rullering.sql): de som er på jobb, fordeles på oppgavene, så
// alle får gjøre alt etter tur, fra dag til dag og mellom fasene samme dag. Dagene og fasene
// regnes én om gangen, i rekkefølge:
//
// - Plassene i en fase: behovet i hver oppgave (satt for fasen, ellers på oppgaven) fylles
//   først, og hver oppgave får én før noen får to. Mangler det folk, fylles oppgavene i den
//   rekkefølgen de står på tavla. Er det flere på jobb enn behovet, fordeles resten jevnt på
//   oppgavene uten behov; har alle oppgavene behov, står resten som ikke plassert. Behov 0 betyr
//   at ingen settes i oppgaven i fasen.
// - Hvem som får hvilken plass: den som har hatt oppgaven minst i det siste (andelen av plassene
//   de siste ukene, der de nyeste teller mest), helst ikke det samme som forrige arbeidsdag og
//   en annen oppgave enn i fasene før samme dag. Faser som overlapper i tid, gir samme oppgave
//   (den ansatte er jo på ett sted); med «samme oppgave hele dagen» gjelder det alle fasene.
// - Ingen settes i en oppgave de er utelatt fra, og plassene som står (satt for hånd), teller
//   med i behovet og i rulleringen.
// - De med fast oppgave (0059_tavle_fast_oppgave.sql) rulleres ikke: de settes i oppgaven i alle
//   fasene de er på jobb og den trengs (også når behovet er dekket), og teller med i behovet. Der
//   oppgaven ikke trengs (behov 0), står de uten plass.
//
// Hver fase fordeles som en tilordning med lavest mulig samlet «kostnad» (den ungarske metoden),
// så den er den beste for fasen og ikke bare grådig, og den blir lik hver gang for de samme
// dataene (forhåndsvisningen og lagringen gir det samme).

export type RTid = { fra: string | null; til: string | null };
export type RFase = RTid & { id: string };
export type ROppgave = { id: string; behov: number | null };
export type RBehov = { fase_id: string; oppgave_id: string; antall: number };
export type RPlass = { dato: string; fase_id: string; oppgave_id: string; ansatt_id: string };
export type RDag = {
  dato: string;
  // De som er på jobb og ikke borte, med vaktene (fra og til null: hel dag).
  folk: { ansatt_id: string; vakter: RTid[] }[];
  // Plassene som står (satt for hånd).
  faste: Omit<RPlass, "dato">[];
};
export type RInn = {
  faser: RFase[];
  oppgaver: ROppgave[];
  behov: RBehov[];
  utelatt: { ansatt_id: string; oppgave_id: string }[];
  // Faste oppgaver: den ansatte får alltid denne.
  fast?: { ansatt_id: string; oppgave_id: string }[];
  dager: RDag[];
  // Plassene før perioden (uten dem den ansatte var borte fra).
  historikk: RPlass[];
  sammeHeleDagen?: boolean;
};
export type RUt = {
  plasser: RPlass[];
  // Behov som ikke ble dekket, og de som er på jobb i fasen uten plass (men ikke utelatt fra alt).
  mangler: (Omit<RPlass, "ansatt_id"> & { antall: number })[];
  ikkePlassert: Omit<RPlass, "oppgave_id">[];
};

const minutter = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));

// Vakten overlapper fasen (begge kan gå over midnatt). En fase uten tidsrom gjelder hele dagen,
// og en hel dag hører til alle fasene. Samme regel som tavla i appen (iFasen i Tavle.tsx).
export function iFasen(v: RTid, f: RTid) {
  if (!f.fra || !f.til || !v.fra || !v.til) return true;
  const vf = minutter(v.fra);
  const ff = minutter(f.fra);
  const vt = minutter(v.til) + (minutter(v.til) <= vf ? 1440 : 0);
  const ft = minutter(f.til) + (minutter(f.til) <= ff ? 1440 : 0);
  return vf < ft && ff < vt;
}
// To faser overlapper bare når begge har tidsrom som går i hverandre.
const overlapper = (a: RTid, b: RTid) => !!(a.fra && a.til && b.fra && b.til) && iFasen(a, b);

// Kostnadene (hele tall). Rekkefølgen av hensyn: lov eller ikke, behov før fordeling av resten,
// runden (den første i hver oppgave før den andre), oppgavens plass på tavla, og til slutt
// rulleringen (spennet i den er mindre enn ett steg i oppgaverekkefølgen).
const UTELATT = 1e13;
const FRI = 1e10;
const RUNDE = 1e8;
const OPPGAVE = 1e6;
const ANDEL = 100_000;
const FORRIGE_DAG = 25_000;
const SAMME_DAG = 150_000;
const FORTSETT = -300_000;
const HALVERING = 14; // dager: en plass for to uker siden teller halvparten

const dagnr = (iso: string) => Math.round(Date.parse(`${iso}T12:00:00Z`) / 86_400_000);

// Litt «tilfeldig», men alltid likt, for å skille likeverdige valg (FNV-1a).
function stoy(s: string) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % 100;
}

// Den ungarske metoden for n rader og m kolonner, n <= m: kolonnen hver rad får, slik at summen
// blir lavest mulig.
function ungarsk(a: number[][]): number[] {
  const n = a.length;
  const m = a[0]!.length;
  const u = new Array<number>(n + 1).fill(0);
  const v = new Array<number>(m + 1).fill(0);
  const p = new Array<number>(m + 1).fill(0);
  const vei = new Array<number>(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array<number>(m + 1).fill(Infinity);
    const brukt = new Array<boolean>(m + 1).fill(false);
    do {
      brukt[j0] = true;
      const i0 = p[j0]!;
      let delta = Infinity;
      let j1 = 0;
      for (let j = 1; j <= m; j++) {
        if (brukt[j]) continue;
        const k = a[i0 - 1]![j - 1]! - u[i0]! - v[j]!;
        if (k < minv[j]!) {
          minv[j] = k;
          vei[j] = j0;
        }
        if (minv[j]! < delta) {
          delta = minv[j]!;
          j1 = j;
        }
      }
      for (let j = 0; j <= m; j++) {
        if (brukt[j]) {
          u[p[j]!] = u[p[j]!]! + delta;
          v[j] = v[j]! - delta;
        } else minv[j] = minv[j]! - delta;
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do {
      const j1 = vei[j0]!;
      p[j0] = p[j1]!;
      j0 = j1;
    } while (j0);
  }
  const svar = new Array<number>(n).fill(-1);
  for (let j = 1; j <= m; j++) if (p[j]) svar[p[j]! - 1] = j - 1;
  return svar;
}

// Kolonnen hver rad får (-1: ingen), for et hvilket som helst antall rader og kolonner.
export function tilordne(kost: number[][]): number[] {
  const n = kost.length;
  const m = n ? kost[0]!.length : 0;
  if (!n || !m) return new Array<number>(n).fill(-1);
  if (n <= m) return ungarsk(kost);
  const snudd = Array.from({ length: m }, (_, j) => kost.map((rad) => rad[j]!));
  const svar = new Array<number>(n).fill(-1);
  ungarsk(snudd).forEach((i, j) => {
    if (i >= 0) svar[i] = j;
  });
  return svar;
}

type Plass = { oppgave: string; prioritet: number };

export function rullere(inn: RInn): RUt {
  const ut: RUt = { plasser: [], mangler: [], ikkePlassert: [] };
  const oppgaveNr = new Map(inn.oppgaver.map((o, i) => [o.id, i]));
  const utelatt = new Set(inn.utelatt.map((u) => `${u.ansatt_id}|${u.oppgave_id}`));
  const kan = (a: string, o: string) => !utelatt.has(`${a}|${o}`);
  const iRulleringen = (a: string) => inn.oppgaver.some((o) => kan(a, o.id));
  const trengs = (f: string, o: ROppgave) => inn.behov.find((b) => b.fase_id === f && b.oppgave_id === o.id)?.antall ?? o.behov;
  // Den faste oppgaven (når oppgaven finnes på tavla).
  const fast = new Map((inn.fast ?? []).flatMap((x) => (oppgaveNr.has(x.oppgave_id) ? [[x.ansatt_id, inn.oppgaver[oppgaveNr.get(x.oppgave_id)!]!] as const] : [])));
  const historikk = [...inn.historikk];

  for (const dag of [...inn.dager].sort((x, y) => x.dato.localeCompare(y.dato))) {
    const d = dagnr(dag.dato);
    // Andelen av plassene hver ansatt har hatt i hver oppgave før denne dagen (de nyeste teller
    // mest), og oppgavene på den ansattes forrige arbeidsdag.
    const vekt = new Map<string, Map<string, number>>();
    const sum = new Map<string, number>();
    const sist = new Map<string, { dag: number; oppgaver: Set<string> }>();
    for (const h of historikk) {
      const n = dagnr(h.dato);
      if (n >= d) continue;
      const w = 0.5 ** ((d - n) / HALVERING);
      const per = vekt.get(h.ansatt_id) ?? new Map<string, number>();
      per.set(h.oppgave_id, (per.get(h.oppgave_id) ?? 0) + w);
      vekt.set(h.ansatt_id, per);
      sum.set(h.ansatt_id, (sum.get(h.ansatt_id) ?? 0) + w);
      const s = sist.get(h.ansatt_id);
      if (!s || n > s.dag) sist.set(h.ansatt_id, { dag: n, oppgaver: new Set([h.oppgave_id]) });
      else if (n === s.dag) s.oppgaver.add(h.oppgave_id);
    }
    const andel = (a: string, o: string) => (sum.get(a) ? (vekt.get(a)?.get(o) ?? 0) / sum.get(a)! : 0);

    // Plassene i dag så langt: de som står (alle fasene), og de rulleringen setter fase for fase.
    const iDag = new Map<string, { fase: RFase; oppgave: string }[]>();
    const leggTil = (a: string, fase: RFase, oppgave: string) => iDag.set(a, [...(iDag.get(a) ?? []), { fase, oppgave }]);
    const faseAv = new Map(inn.faser.map((f) => [f.id, f]));
    for (const p of dag.faste) {
      const f = faseAv.get(p.fase_id);
      if (f) leggTil(p.ansatt_id, f, p.oppgave_id);
    }

    const rotasjon = (a: string, o: string, f: RFase) => {
      let k = Math.round(ANDEL * andel(a, o)) + stoy(`${a}|${o}|${dag.dato}|${f.id}`);
      if (sist.get(a)?.oppgaver.has(o)) k += FORRIGE_DAG;
      const andre = (iDag.get(a) ?? []).filter((x) => x.fase.id !== f.id && x.oppgave === o);
      if (andre.some((x) => inn.sammeHeleDagen || overlapper(x.fase, f))) k += FORTSETT;
      else if (andre.length) k += SAMME_DAG;
      return k;
    };

    for (const f of inn.faser) {
      const paJobb = dag.folk.filter((p) => p.vakter.some((v) => iFasen(v, f))).map((p) => p.ansatt_id);
      const her = new Set(paJobb);
      const staar = dag.faste.filter((p) => p.fase_id === f.id && her.has(p.ansatt_id));
      const laast = new Set(dag.faste.filter((p) => p.fase_id === f.id).map((p) => p.ansatt_id));
      const fylt = new Map<string, number>();
      for (const p of staar) fylt.set(p.oppgave_id, (fylt.get(p.oppgave_id) ?? 0) + 1);
      // De med fast oppgave: i oppgaven når den trengs i fasen, ellers uten plass.
      for (const a of paJobb.filter((x) => !laast.has(x) && fast.has(x)).sort()) {
        const o = fast.get(a)!;
        if (trengs(f.id, o) === 0) {
          ut.ikkePlassert.push({ dato: dag.dato, fase_id: f.id, ansatt_id: a });
          continue;
        }
        ut.plasser.push({ dato: dag.dato, fase_id: f.id, oppgave_id: o.id, ansatt_id: a });
        fylt.set(o.id, (fylt.get(o.id) ?? 0) + 1);
        leggTil(a, f, o.id);
      }
      const folk = paJobb.filter((a) => !laast.has(a) && !fast.has(a) && iRulleringen(a)).sort();

      // Plassene: behovet i runder (den første i hver oppgave, så den andre ...), deretter resten
      // jevnt på oppgavene uten behov.
      const plasser: Plass[] = [];
      for (const o of inn.oppgaver) {
        const n = trengs(f.id, o);
        if (n === 0) continue;
        const har = fylt.get(o.id) ?? 0;
        const til = n === null ? har + folk.length : Math.min(n, har + folk.length);
        for (let r = har + 1; r <= til; r++) plasser.push({ oppgave: o.id, prioritet: (n === null ? FRI : 0) + r * RUNDE + oppgaveNr.get(o.id)! * OPPGAVE });
      }

      const kost = folk.map((a) => plasser.map((p) => (kan(a, p.oppgave) ? p.prioritet + rotasjon(a, p.oppgave, f) : UTELATT)));
      const valg = tilordne(kost);
      const fikk = new Map<string, number>();
      folk.forEach((a, i) => {
        const j = valg[i]!;
        if (j < 0 || kost[i]![j]! >= UTELATT) {
          ut.ikkePlassert.push({ dato: dag.dato, fase_id: f.id, ansatt_id: a });
          return;
        }
        const o = plasser[j]!.oppgave;
        ut.plasser.push({ dato: dag.dato, fase_id: f.id, oppgave_id: o, ansatt_id: a });
        fikk.set(o, (fikk.get(o) ?? 0) + 1);
        leggTil(a, f, o);
      });
      for (const o of inn.oppgaver) {
        const n = trengs(f.id, o);
        const har = (fylt.get(o.id) ?? 0) + (fikk.get(o.id) ?? 0);
        if (n && har < n) ut.mangler.push({ dato: dag.dato, fase_id: f.id, oppgave_id: o.id, antall: n - har });
      }
    }

    // Dagens plasser teller med for dagene etter.
    const paJobb = new Set(dag.folk.map((p) => p.ansatt_id));
    for (const [a, l] of iDag) if (paJobb.has(a)) for (const x of l) historikk.push({ dato: dag.dato, fase_id: x.fase.id, oppgave_id: x.oppgave, ansatt_id: a });
  }
  return ut;
}
