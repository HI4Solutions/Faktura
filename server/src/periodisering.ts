// Periodiseringene i regnskapet (0087_regnskap_bilag.sql): et beløp som fordeles på månedene det
// gjelder, mellom en balansekonto og en resultatkonto, bokført måned for måned i bilagserie P.
//
// - Forskuddsbetalt kostnad (f.eks. forsikring eller leie betalt for et år): kostnaden føres hver
//   måned mot 1700. Beløpet kommer på 1700 med en start: flyttet fra resultatkontoen (fakturaen er
//   ført der), fra bank eller leverandørgjeld (med inngående mva), eller er alt ført der.
// - Påløpt kostnad (f.eks. bonus eller strøm som faktureres senere): kostnaden føres hver måned mot
//   2960, og fakturaen føres mot 2960 når den kommer.
// - Uopptjent inntekt (forskuddsfakturert, f.eks. et årsabonnement): inntekten føres hver måned fra
//   2970. Starten flytter beløpet fra inntektskontoen, eller fører det fra kundefordringer eller bank
//   (med utgående mva).
// - Opptjent, ikke fakturert inntekt: inntekten føres hver måned mot 1530, og fakturaen mot 1530.
//
// Beløpet fordeles likt på månedene (i øre, den siste tar resten). Endres antallet måneder, fordeles
// det som står igjen på månedene som er igjen.
import { alle, en, type Db } from "./db.js";
import { ApiFeil } from "./feil.js";
import { maanedNavn } from "./lonnsberegning.js";
import { mnd, mndMellom, plussMnd, sisteDag, type Regnskapsrolle } from "./anlegg.js";

export type Periodiseringstype = "forskuddsbetalt_kostnad" | "paalopt_kostnad" | "uopptjent_inntekt" | "opptjent_inntekt";
export const PERIODISERINGSTYPER: Record<Periodiseringstype, { navn: string; kostnad: boolean; forskudd: boolean; balanse: Regnskapsrolle; resultat: string }> = {
  forskuddsbetalt_kostnad: { navn: "Forskuddsbetalt kostnad", kostnad: true, forskudd: true, balanse: "forskuddsbetalt_kostnad", resultat: "7500" },
  paalopt_kostnad: { navn: "Påløpt kostnad", kostnad: true, forskudd: false, balanse: "paalopt_kostnad", resultat: "7700" },
  uopptjent_inntekt: { navn: "Uopptjent inntekt (forskuddsfakturert)", kostnad: false, forskudd: true, balanse: "uopptjent_inntekt", resultat: "3000" },
  opptjent_inntekt: { navn: "Opptjent, ikke fakturert inntekt", kostnad: false, forskudd: false, balanse: "opptjent_inntekt", resultat: "3000" },
};
export const PERIODISERINGSKODER = Object.keys(PERIODISERINGSTYPER) as [Periodiseringstype, ...Periodiseringstype[]];

export type Periodisering = {
  id: string;
  nummer: number;
  navn: string;
  type: Periodiseringstype;
  belop: number;
  fra: string; // ÅÅÅÅ-MM-01
  antall_maaneder: number;
  resultatkonto: string;
  balansekonto: string;
  start: "ingen" | "flytt" | "motkonto";
  tekst: string | null;
};
export type Periodiseringspost = {
  id: string;
  periodisering_id: string;
  type: "start" | "maaned";
  maaned: string | null; // ÅÅÅÅ-MM
  belop: number;
  dato: string;
  bilag_id: string;
  bilag: string;
  reversert: boolean;
};

export const PERIODISERINGER = `
  select p.id, p.nummer, p.navn, p.type, p.belop::float8 as belop, to_char(p.fra, 'YYYY-MM-DD') as fra, p.antall_maaneder,
         p.resultatkonto, p.balansekonto, p.start, p.tekst
    from faktura.periodiseringer p`;
const POSTER = `
  select x.id, x.periodisering_id, x.type, to_char(x.maaned, 'YYYY-MM') as maaned, x.belop::float8 as belop,
         to_char(b.dato, 'YYYY-MM-DD') as dato, x.bilag_id, b.serie || '-' || b.aar || '-' || b.nummer as bilag, x.reversert
    from faktura.periodiseringsposter x join faktura.bilag b on b.org_id = x.org_id and b.id = x.bilag_id`;

export async function hentPeriodiseringer(db: Db, org: string, id?: string) {
  const periodiseringer = await alle<Periodisering>(db, `${PERIODISERINGER} where p.org_id = $1 ${id ? "and p.id = $2" : ""} order by p.nummer`, id ? [org, id] : [org]);
  const poster = periodiseringer.length
    ? await alle<Periodiseringspost>(db, `${POSTER} where x.org_id = $1 and x.periodisering_id = any($2::uuid[]) order by b.dato, b.nummer`, [org, periodiseringer.map((p) => p.id)])
    : [];
  return { periodiseringer, poster };
}

const ore = (n: number) => Math.round(Number(n) * 100);
const kr = (o: number) => o / 100;
export const sisteMaaned = (p: Periodisering) => plussMnd(mnd(p.fra), p.antall_maaneder - 1);

export type Fordelingsmaaned = { maaned: string; belop: number; bokfort: boolean; bilag: string | null; igjen: number };

// Fordelingen måned for måned: det som er bokført, og resten likt på månedene som er igjen.
export function fordeling(p: Periodisering, poster: Periodiseringspost[]): Fordelingsmaaned[] {
  const bokfort = new Map(poster.filter((x) => x.periodisering_id === p.id && !x.reversert && x.type === "maaned").map((x) => [x.maaned!, x]));
  const slutt = sisteMaaned(p);
  let rest = ore(p.belop);
  const ut: Fordelingsmaaned[] = [];
  for (let m = mnd(p.fra); m <= slutt; m = plussMnd(m, 1)) {
    const b = bokfort.get(m);
    const igjenMnd = mndMellom(m, slutt) + 1;
    const belop = b ? ore(b.belop) : Math.max(0, igjenMnd <= 1 ? rest : Math.round(rest / igjenMnd));
    rest -= belop;
    ut.push({ maaned: m, belop: kr(belop), bokfort: !!b, bilag: b?.bilag ?? null, igjen: kr(rest) });
  }
  return ut;
}

// Starten som er bokført (beløpet til balansekontoen for et forskudd), eller null.
const startpost = (p: Periodisering, poster: Periodiseringspost[]) => poster.find((x) => x.periodisering_id === p.id && x.type === "start" && !x.reversert) ?? null;
// Et forskudd med start fordeles først når starten er bokført.
export const manglerStart = (p: Periodisering, poster: Periodiseringspost[]) => p.start !== "ingen" && !startpost(p, poster);

export function status(p: Periodisering, poster: Periodiseringspost[]) {
  const f = fordeling(p, poster);
  const fordelt = kr(f.filter((x) => x.bokfort).reduce((s, x) => s + ore(x.belop), 0));
  const neste = f.find((x) => !x.bokfort && x.belop > 0) ?? null;
  return {
    fordelt,
    igjen: kr(ore(p.belop) - ore(fordelt)),
    slutt: sisteMaaned(p),
    neste: neste ? { maaned: neste.maaned, belop: neste.belop } : null,
    start_bilag: startpost(p, poster)?.bilag ?? null,
    mangler_start: manglerStart(p, poster),
    ferdig: !neste,
  };
}

// --- Bilagene --------------------------------------------------------------------------------------

export type Postering = { konto: string; belop: number; tekst: string; mva_kode?: string | null };
export type Bilagsforslag = {
  dato: string;
  tekst: string;
  posteringer: Postering[];
  poster: { periodisering_id: string; type: "start" | "maaned"; maaned?: string; belop: number }[];
};
const navnPaa = (p: Periodisering) => `${p.navn} (nr. ${p.nummer})`;

// Månedens del: kostnaden mot balansekontoen, eller inntekten fra den.
export function maanedsbilag(maaned: string, linjer: { p: Periodisering; belop: number }[]): Bilagsforslag {
  const ok = linjer.filter((l) => ore(l.belop) > 0);
  return {
    dato: sisteDag(maaned),
    tekst: `Periodiseringer ${maanedNavn(`${maaned}-01`)}`,
    posteringer: ok.flatMap(({ p, belop }) => {
      const t = navnPaa(p);
      return PERIODISERINGSTYPER[p.type].kostnad
        ? [
            { konto: p.resultatkonto, belop, tekst: t },
            { konto: p.balansekonto, belop: -belop, tekst: t },
          ]
        : [
            { konto: p.balansekonto, belop, tekst: t },
            { konto: p.resultatkonto, belop: -belop, tekst: t },
          ];
    }),
    poster: ok.map(({ p, belop }) => ({ periodisering_id: p.id, type: "maaned", maaned: `${maaned}-01`, belop })),
  };
}

// Starten for et forskudd: beløpet til balansekontoen, flyttet fra resultatkontoen eller fra
// motkontoen (med mva).
export function startbilag(p: Periodisering, v: { dato: string; motkonto?: string | null; mva?: number }, k: Record<Regnskapsrolle, string>): Bilagsforslag {
  const t = `${PERIODISERINGSTYPER[p.type].navn}: ${navnPaa(p)}`;
  const mva = ore(v.mva ?? 0);
  const kostnad = PERIODISERINGSTYPER[p.type].kostnad;
  let posteringer: Postering[];
  if (p.start === "flytt")
    posteringer = kostnad
      ? [
          { konto: p.balansekonto, belop: p.belop, tekst: t },
          { konto: p.resultatkonto, belop: -p.belop, tekst: t },
        ]
      : [
          { konto: p.resultatkonto, belop: p.belop, tekst: t },
          { konto: p.balansekonto, belop: -p.belop, tekst: t },
        ];
  else {
    if (!v.motkonto) throw new ApiFeil(400, "Velg motkontoen");
    posteringer = kostnad
      ? [
          { konto: p.balansekonto, belop: p.belop, tekst: t },
          ...(mva > 0 ? [{ konto: k.inngaende_mva, belop: kr(mva), tekst: "Inngående merverdiavgift" }] : []),
          { konto: v.motkonto, belop: -kr(ore(p.belop) + mva), tekst: t },
        ]
      : [
          { konto: v.motkonto, belop: kr(ore(p.belop) + mva), tekst: t },
          { konto: p.balansekonto, belop: -p.belop, tekst: t },
          ...(mva > 0 ? [{ konto: k.utgaende_mva, belop: -kr(mva), tekst: "Utgående merverdiavgift" }] : []),
        ];
  }
  return { dato: v.dato, tekst: t, posteringer, poster: [{ periodisering_id: p.id, type: "start", belop: p.belop }] };
}

// Det som ikke er bokført til og med måneden, per måned (månedsavslutningen). Et forskudd der starten
// ikke er bokført, venter.
export function periodiseringsforslag(periodiseringer: Periodisering[], poster: Periodiseringspost[], til: string) {
  const per = new Map<string, { p: Periodisering; belop: number }[]>();
  for (const p of periodiseringer.filter((x) => !manglerStart(x, poster)))
    for (const f of fordeling(p, poster)) {
      if (f.bokfort || f.maaned > til || ore(f.belop) <= 0) continue;
      per.set(f.maaned, [...(per.get(f.maaned) ?? []), { p, belop: f.belop }]);
    }
  return [...per.entries()].sort(([x], [y]) => x.localeCompare(y)).map(([maaned, linjer]) => ({ maaned, linjer }));
}

export async function bokforPeriodisering(db: Db, org: string, b: Bilagsforslag) {
  const r = await en<{ id: string }>(db, "select faktura.bokfor_periodisering($1, $2, $3, $4, $5) as id", [
    org,
    b.dato,
    b.tekst,
    JSON.stringify(b.posteringer),
    JSON.stringify(b.poster),
  ]);
  return (await en<{ id: string; bilagsnummer: string; dato: string; tekst: string }>(
    db,
    "select id, serie || '-' || aar || '-' || nummer as bilagsnummer, to_char(dato, 'YYYY-MM-DD') as dato, tekst from faktura.bilag where id = $1",
    [r!.id],
  ))!;
}
