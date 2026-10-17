// Skatteberegningen i årsoppgjøret (0121_skatteberegning.sql, aarsoppgjor.ts,
// web/src/sider/RegnskapAarsoppgjor.tsx): forslaget til betalbar skatt og utsatt skatt for et
// aksjeselskap, regnet fra regnskapet, med det brukeren legger til.
//
// Grunnlaget for betalbar skatt (alminnelig inntekt): resultatet før skattekostnad, pluss de
// permanente forskjellene (kostnadene på kontoene uten fradrag i NS 4102, minus de skattefrie
// inntektene og aksjeinntektene etter fritaksmetoden, pluss 3 % av utbyttet, og det brukeren legger
// til), minus økningen i de midlertidige forskjellene (driftsmidlene: regnskapsmessig verdi minus
// skattemessig saldo fra saldoskjemaet; gevinst- og tapskontoen; og andre forskjeller brukeren
// legger inn), minus fremførbart underskudd som brukes. Betalbar skatt er skattesatsen (22 %) av
// grunnlaget.
//
// Utsatt skatt 31. desember er satsen av de midlertidige forskjellene minus underskuddet som kan
// fremføres. Er det negativt, er det en utsatt skattefordel, som balanseføres bare når brukeren
// velger det (den kan bare balanseføres når den kan utnyttes mot skattbart overskudd senere).
// Skattekostnaden er betalbar skatt pluss endringen i utsatt skatt (mot balansen før
// årsoppgjøret).
//
// Fremførbart underskudd ved inngangen til året regnes fra året før (fra det første året med
// resultatposter), eller legges inn fra skattemeldingen. Forslaget er et forslag: skattemeldingen
// gjelder.
import { z } from "zod";
import { bokfortVerdi, hentAnlegg, hentRegnskapsoppsett, regnskapskontoer, type Anleggsmiddel, type Hendelse, type Regnskapsoppsett } from "./anlegg.js";
import { alle, en, type Db } from "./db.js";
import type { Rapportdef } from "./rapportmodul.js";
import { saldoskjema } from "./saldo.js";

const rund = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const helKr = (n: number) => Math.sign(n) * Math.round(Math.abs(n)) || 0;

// Skattesatsen på alminnelig inntekt for selskaper (skatteloven § 2-2, Stortingets skattevedtak).
export const skattesats = (aar: number) => (aar >= 2019 ? 22 : aar === 2018 ? 23 : aar === 2017 ? 24 : aar === 2016 ? 25 : aar >= 2014 ? 27 : 28);

// Det brukeren legger inn for året (aarsoppgjor.skatteberegning).
export const skatteinndataS = z
  .object({
    permanente_andre: z.number().finite().gt(-1e11).lt(1e11).nullish(),
    permanente_tekst: z.string().trim().max(500).nullish(),
    midlertidige_andre_ib: z.number().finite().gt(-1e11).lt(1e11).nullish(),
    midlertidige_andre_ub: z.number().finite().gt(-1e11).lt(1e11).nullish(),
    midlertidige_tekst: z.string().trim().max(500).nullish(),
    underskudd_ib: z.number().finite().min(0, "Underskuddet skrives som et positivt beløp").lt(1e11).nullish(),
    skattefordel: z.boolean().nullish(),
  })
  .strict();
export type Skatteinndata = z.infer<typeof skatteinndataS>;

// Kontoene i NS 4102 for permanente forskjeller (fortegn: debet positivt, så en kostnad legges til
// og en inntekt trekkes fra grunnlaget).
const UTEN_FRADRAG: [string, string][] = [
  ["7360", "7369"], // representasjon, ikke fradragsberettiget
  ["7395", "7399"], // annen salgskostnad, ikke fradragsberettiget
  ["7410", "7419"], // kontingent, ikke fradragsberettiget
  ["7430", "7439"], // gave, ikke fradragsberettiget
  ["8140", "8149"], // rentekostnad, ikke fradragsberettiget
];
const SKATTEFRIE: [string, string][] = [["8040", "8049"]]; // renteinntekt, skattefri
// Aksjer etter fritaksmetoden (skatteloven § 2-38): utbyttet, gevinstene og tapene, og
// resultatandelene etter egenkapitalmetoden. Kontoene «utenfor fritaksmetoden» er skattepliktige.
const FRITAK = ["8000", "8003", "8005", "8007", "8010", "8013", "8017", "8020", "8023", "8025", "8027", "8070", "8073", "8077", "8177"];
// Utbyttet etter fritaksmetoden, der 3 % likevel skal tas med (skatteloven § 2-38 sjette ledd).
const UTBYTTE = ["8000", "8003", "8010", "8013", "8020", "8023", "8070", "8073"];

const sumOver = (s: Map<string, number>, omraader: [string, string][]) =>
  rund([...s].reduce((t, [k, b]) => (omraader.some(([fra, til]) => k.slice(0, 4) >= fra && k.slice(0, 4) <= til) ? t + b : t), 0));
const sumAv = (s: Map<string, number>, kontoer: string[]) => rund([...s].reduce((t, [k, b]) => (kontoer.includes(k.slice(0, 4)) ? t + b : t), 0));

export type Skattelinje = { nokkel: string; navn: string; belop: number; fast: boolean };
export type Forskjell = { nokkel: string; navn: string; ib: number; ub: number; fast: boolean };

// De permanente forskjellene fra kontoene for året (uten årsoppgjøret).
export function permanenteForskjeller(s: Map<string, number>, inn: Skatteinndata): Skattelinje[] {
  const utbytte = -sumAv(s, UTBYTTE);
  const l: Skattelinje[] = [
    { nokkel: "uten_fradrag", navn: "Kostnader uten fradrag (representasjon, kontingenter, gaver og renter)", belop: sumOver(s, UTEN_FRADRAG), fast: true },
    { nokkel: "skattefrie", navn: "Skattefrie renteinntekter", belop: sumOver(s, SKATTEFRIE), fast: true },
    { nokkel: "fritak", navn: "Aksjeinntekter og -tap etter fritaksmetoden", belop: sumAv(s, FRITAK), fast: true },
    { nokkel: "tre_prosent", navn: "3 % av utbyttet etter fritaksmetoden", belop: utbytte > 0 ? helKr(utbytte * 0.03) : 0, fast: true },
  ].filter((x) => x.belop !== 0);
  l.push({ nokkel: "andre", navn: inn.permanente_tekst?.trim() || "Andre permanente forskjeller", belop: rund(inn.permanente_andre ?? 0), fast: false });
  return l;
}

// De midlertidige forskjellene for driftsmidlene ved inngangen og utgangen av året: den
// regnskapsmessige verdien (anleggsregisteret) minus den skattemessige saldoen (saldoskjemaet), og
// gevinst- og tapskontoen (positiv saldo øker forskjellen).
export function driftsmiddelforskjeller(
  aar: number,
  anlegg: Anleggsmiddel[],
  hendelser: Hendelse[],
  o: Pick<Regnskapsoppsett, "saldo_fra_aar" | "saldo_inngaende">,
  satser: Record<string, number>,
) {
  const s = saldoskjema(aar, anlegg, o, satser);
  const verdi = (l: Anleggsmiddel[], dato: string) => l.reduce((t, a) => t + bokfortVerdi(a, hendelser, dato), 0);
  const ut = { driftsmidler: { ib: 0, ub: 0 }, gevinst_tap: { ib: 0, ub: 0 } };
  for (const r of s.rader) {
    if (r.type === "gevinst_tap") {
      ut.gevinst_tap = { ib: r.inngaende, ub: r.utgaende };
      continue;
    }
    const mine = r.type === "samlet" ? anlegg.filter((a) => a.skatt === r.gruppe) : anlegg.filter((a) => a.id === r.anleggsmiddel_id);
    ut.driftsmidler.ib += verdi(mine, `${aar - 1}-12-31`) - r.inngaende;
    ut.driftsmidler.ub += verdi(mine, `${aar}-12-31`) - r.utgaende;
  }
  ut.driftsmidler = { ib: rund(ut.driftsmidler.ib), ub: rund(ut.driftsmidler.ub) };
  return ut;
}

export type Skatteberegning = {
  aar: number;
  sats: number;
  resultat_for_skatt: number;
  permanente: Skattelinje[];
  sum_permanente: number;
  midlertidige: Forskjell[];
  midlertidige_ib: number;
  midlertidige_ub: number;
  endring_midlertidige: number;
  grunnlag: number;
  underskudd_ib: number;
  // Hvor underskuddet 1. januar kommer fra: lagt inn, regnet fra året før, eller ingen (det første
  // året med resultatposter, uten at noe er lagt inn).
  underskudd_kilde: "lagt_inn" | "aaret_for" | "forste_aar";
  underskudd_brukt: number;
  underskudd_ub: number;
  inntekt: number;
  betalbar: number;
  grunnlag_utsatt: number;
  skattefordel: boolean;
  utsatt_ub: number;
  utsatt_ib: number;
  endring_utsatt: number;
  skattekostnad: number;
  inndata: Skatteinndata;
};

// Selve beregningen (uten database).
export function beregnSkatt(x: {
  aar: number;
  resultatForSkatt: number;
  permanente: Skattelinje[];
  midlertidige: Forskjell[];
  underskuddIb: number;
  underskuddKilde: Skatteberegning["underskudd_kilde"];
  utsattIb: number;
  inndata: Skatteinndata;
}): Skatteberegning {
  const sats = skattesats(x.aar);
  const sumP = rund(x.permanente.reduce((t, l) => t + l.belop, 0));
  const ib = rund(x.midlertidige.reduce((t, f) => t + f.ib, 0));
  const ub = rund(x.midlertidige.reduce((t, f) => t + f.ub, 0));
  const endring = rund(ub - ib);
  const grunnlag = rund(x.resultatForSkatt + sumP - endring);
  const brukt = grunnlag > 0 ? Math.min(grunnlag, x.underskuddIb) : 0;
  const inntekt = Math.max(0, rund(grunnlag - brukt));
  const underskuddUb = rund(x.underskuddIb - brukt + Math.max(0, -grunnlag));
  const betalbar = helKr((inntekt * sats) / 100);
  const grunnlagUtsatt = rund(ub - underskuddUb);
  const skattefordel = Boolean(x.inndata.skattefordel);
  const utsattUb = grunnlagUtsatt >= 0 ? helKr((grunnlagUtsatt * sats) / 100) : skattefordel ? -helKr((-grunnlagUtsatt * sats) / 100) : 0;
  const endringUtsatt = rund(utsattUb - x.utsattIb);
  return {
    aar: x.aar,
    sats,
    resultat_for_skatt: rund(x.resultatForSkatt),
    permanente: x.permanente,
    sum_permanente: sumP,
    midlertidige: x.midlertidige,
    midlertidige_ib: ib,
    midlertidige_ub: ub,
    endring_midlertidige: endring,
    grunnlag,
    underskudd_ib: rund(x.underskuddIb),
    underskudd_kilde: x.underskuddKilde,
    underskudd_brukt: rund(brukt),
    underskudd_ub: underskuddUb,
    inntekt,
    betalbar,
    grunnlag_utsatt: grunnlagUtsatt,
    skattefordel,
    utsatt_ub: utsattUb,
    utsatt_ib: rund(x.utsattIb),
    endring_utsatt: endringUtsatt,
    skattekostnad: rund(betalbar + endringUtsatt),
    inndata: x.inndata,
  };
}

// Summen per konto (debet positivt) for bilagene datert i perioden, eventuelt uten årsoppgjøret for
// året (som aarsoppgjor.ts, men bare årsoppgjøret i perioden).
async function summer(db: Db, org: string, fra: string | null, til: string, utenAarsoppgjor: boolean) {
  const r = await alle<{ konto: string; sum: number }>(
    db,
    `select p.konto, sum(p.belop)::float8 as sum
       from faktura.posteringer p join faktura.bilag b on b.org_id = p.org_id and b.id = p.bilag_id
      where b.org_id = $1 and ($2::date is null or b.dato >= $2::date) and b.dato <= $3::date and (not $4 or b.kilde <> 'aarsoppgjor')
      group by p.konto`,
    [org, fra, til, utenAarsoppgjor],
  );
  return new Map(r.map((x) => [x.konto, rund(x.sum)]));
}

// Utsatt skatt (gjeld, kredit positivt) og utsatt skattefordel (eiendel, debet positivt) før
// årsoppgjøret for året: balansen 31. desember året før og det som er ført i året utenom årsoppgjøret.
export async function utsattFor(db: Db, org: string, aar: number, k: { utsatt_skatt: string; utsatt_skattefordel: string }) {
  const [ib, iAar] = await Promise.all([summer(db, org, null, `${aar - 1}-12-31`, false), summer(db, org, `${aar}-01-01`, `${aar}-12-31`, true)]);
  const saldo = (konto: string) => rund((ib.get(konto) ?? 0) + (iAar.get(konto) ?? 0));
  return { skatt: -saldo(k.utsatt_skatt), fordel: saldo(k.utsatt_skattefordel) };
}

// Forslaget for året: regnes år for år fra det første året med resultatposter, så det fremførbare
// underskuddet og de andre midlertidige forskjellene følger med fra året før.
export async function skatteberegning(db: Db, org: string, aar: number): Promise<Skatteberegning> {
  const o = await hentRegnskapsoppsett(db, org);
  const k = regnskapskontoer(o);
  const { anlegg, hendelser } = await hentAnlegg(db, org);
  const satser = Object.fromEntries(
    (await alle<{ aar: number; gruppe: string; sats: number }>(db, "select aar, gruppe, sats::float8 as sats from faktura.saldo_satser where org_id = $1", [org])).map((s) => [
      `${s.aar}:${s.gruppe}`,
      s.sats,
    ]),
  );
  const inndata = new Map(
    (await alle<{ aar: number; skatteberegning: Skatteinndata | null }>(db, "select aar, skatteberegning from faktura.aarsoppgjor where org_id = $1 and aar <= $2", [org, aar])).map(
      (r) => [r.aar, r.skatteberegning ?? {}],
    ),
  );
  const forste =
    (
      await en<{ aar: number | null }>(
        db,
        `select min(extract(year from b.dato))::int as aar
           from faktura.bilag b join faktura.posteringer p on p.org_id = b.org_id and p.bilag_id = b.id
          where b.org_id = $1 and left(p.konto, 4) between '3000' and '8999'`,
        [org],
      )
    )?.aar ?? aar;
  const start = Math.min(forste, aar);

  let underskudd = 0;
  let andreUb: number | null = null;
  let svar: Skatteberegning | null = null;
  for (let y = start; y <= aar; y++) {
    const inn = inndata.get(y) ?? {};
    const s = await summer(db, org, `${y}-01-01`, `${y}-12-31`, true);
    // Resultatet før skattekostnad: alt mellom 3000 og 8799 utenom skattekontoene (8300–8399).
    const resultat = -rund([...s].reduce((t, [konto, b]) => (konto.slice(0, 4) >= "3000" && konto.slice(0, 4) <= "8799" && !(konto.slice(0, 4) >= "8300" && konto.slice(0, 4) <= "8399") ? t + b : t), 0));
    const dm = driftsmiddelforskjeller(y, anlegg, hendelser, o, satser);
    const andreIb: number = inn.midlertidige_andre_ib ?? andreUb ?? 0;
    const andre: { ib: number; ub: number } = { ib: rund(andreIb), ub: rund(inn.midlertidige_andre_ub ?? andreIb) };
    const midlertidige: Forskjell[] = [
      { nokkel: "driftsmidler", navn: "Driftsmidler", ...dm.driftsmidler, fast: true },
      { nokkel: "gevinst_tap", navn: "Gevinst- og tapskonto", ...dm.gevinst_tap, fast: true },
      { nokkel: "andre", navn: inn.midlertidige_tekst?.trim() || "Andre midlertidige forskjeller", ...andre, fast: false },
    ];
    const kilde: Skatteberegning["underskudd_kilde"] = inn.underskudd_ib != null ? "lagt_inn" : y > start ? "aaret_for" : "forste_aar";
    const ub = y === aar ? await utsattFor(db, org, y, k) : { skatt: 0, fordel: 0 };
    svar = beregnSkatt({
      aar: y,
      resultatForSkatt: resultat,
      permanente: permanenteForskjeller(s, inn),
      midlertidige,
      underskuddIb: inn.underskudd_ib ?? underskudd,
      underskuddKilde: kilde,
      utsattIb: rund(ub.skatt - ub.fordel),
      inndata: inn,
    });
    underskudd = svar.underskudd_ub;
    andreUb = andre.ub;
  }
  return svar!;
}

// --- Rapporten (rapportmodulen) -------------------------------------------------------------------

export const skatteberegningRapporter: Rapportdef[] = [
  {
    id: "regnskap.skatteberegning",
    modul: "regnskap",
    navn: "Skatteberegning",
    beskrivelse:
      "Forslaget til betalbar skatt og utsatt skatt for året: resultatet før skattekostnad, de permanente og midlertidige forskjellene, fremførbart underskudd, alminnelig inntekt og skattekostnaden.",
    funksjon: "regnskap",
    tilgang: "regnskap",
    parameter: "aar",
    hent: async (db, org, v) => {
      const s = await skatteberegning(db, org, v.aar);
      const rad = (post: string, belop: number | null, ib: number | null = null) => ({ post, ib, belop });
      const minus = (n: number) => (n ? -n : 0);
      const kilde =
        s.underskudd_kilde === "lagt_inn"
          ? "Fremførbart underskudd 1.1. er lagt inn."
          : s.underskudd_kilde === "aaret_for"
            ? `Fremførbart underskudd 1.1. er regnet fra ${s.aar - 1}.`
            : "Første år med resultatposter: fremførbart underskudd fra før må legges inn (Regnskap → Årsoppgjør).";
      return {
        merknad: `Forslag regnet fra regnskapet; skattemeldingen gjelder. ${kilde}`,
        periode: String(s.aar),
        kolonner: [
          { nokkel: "post", navn: "Post" },
          { nokkel: "ib", navn: "1.1.", type: "kr" as const },
          { nokkel: "belop", navn: "Beløp", type: "kr" as const },
        ],
        rader: [
          rad("Resultat før skattekostnad", s.resultat_for_skatt),
          ...s.permanente.filter((l) => l.belop).map((l) => rad(`  ${l.navn}`, l.belop)),
          rad("  Endring i midlertidige forskjeller", minus(s.endring_midlertidige)),
          rad("Grunnlag før underskudd", s.grunnlag),
          rad("  Fremførbart underskudd som brukes", minus(s.underskudd_brukt)),
          rad("Alminnelig inntekt", s.inntekt),
          rad(`Betalbar skatt (${s.sats} %)`, s.betalbar),
          rad("MIDLERTIDIGE FORSKJELLER", null),
          ...s.midlertidige.filter((f) => f.ib || f.ub).map((f) => rad(`  ${f.navn}`, f.ub, f.ib)),
          rad("Midlertidige forskjeller", s.midlertidige_ub, s.midlertidige_ib),
          rad("Fremførbart underskudd", minus(s.underskudd_ub), minus(s.underskudd_ib)),
          rad("Grunnlag for utsatt skatt", s.grunnlag_utsatt),
          rad(`${s.utsatt_ub < 0 ? "Utsatt skattefordel" : "Utsatt skatt"} (${s.sats} %)`, s.utsatt_ub, s.utsatt_ib),
          rad("Endring i utsatt skatt", s.endring_utsatt),
          rad("Skattekostnad", s.skattekostnad),
        ],
      };
    },
  },
];
