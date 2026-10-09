// Bokføringen av lønnen i HI4 Fakturas eget regnskap (0078_lonn_bokforing.sql): lønnsbilaget for
// en godkjent lønnskjøring. Bilaget står på utbetalingsdatoen og har posteringene for lønnen,
// feriepengene, utgiftene, trekkene, nettolønnen og arbeidsgiveravgiften (og OTP når det er valgt),
// på kontoene i kontoplanen (norsk standard, NS 4102; organisasjonen kan endre dem). Det føres i
// bilagserien L når kjøringen godkjennes (bokforKjoring), og reverseres i databasen når kjøringen
// åpnes igjen. Bilagene er grunnlaget for regnskapsmodulen, og rapporten «Lønnsbilag» i
// rapportmodulen (til regnskapsføreren).
//
// Feriepengene, som standard (avsetning): de opptjente feriepengene og arbeidsgiveravgiften av
// dem avsettes hver måned (kostnad mot skyldige feriepenger og påløpt avgift), og feriepengene som
// utbetales, og avgiften av dem, tas fra avsetningen. Tillegget for den ekstra ferieuka over 60 år
// er ikke med i avsetningen og kostnadsføres når det utbetales. Med «utbetaling» kostnadsføres
// feriepengene når de utbetales.
//
// Beløpene regnes i øre, så bilaget alltid går i null.
import { alle, en, type Db } from "./db.js";
import { ApiFeil } from "./feil.js";
import { maanedNavn } from "./lonnsberegning.js";

export type Kontorolle =
  | "lonn"
  | "feriepenger"
  | "aga"
  | "aga_feriepenger"
  | "otp"
  | "utgifter"
  | "forskuddstrekk"
  | "paaleggstrekk"
  | "bidragstrekk"
  | "andre_trekk"
  | "forskudd"
  | "bilgodtgjorelse"
  | "diett"
  | "reiseutlegg"
  | "naturalytelser"
  | "naturalytelser_mot"
  | "nav_refusjon"
  | "skyldig_aga"
  | "paalopt_aga_feriepenger"
  | "skyldig_lonn"
  | "skyldige_feriepenger"
  | "skyldig_otp"
  | "bank";

// Kontoene i bilaget, med standardkontoen (NS 4102).
export const KONTOROLLER: { rolle: Kontorolle; navn: string; standard: string }[] = [
  { rolle: "lonn", navn: "Lønn til ansatte", standard: "5000" },
  { rolle: "feriepenger", navn: "Feriepenger", standard: "5020" },
  { rolle: "aga", navn: "Arbeidsgiveravgift", standard: "5400" },
  { rolle: "aga_feriepenger", navn: "Arbeidsgiveravgift av påløpte feriepenger", standard: "5405" },
  { rolle: "otp", navn: "Pensjon (OTP)", standard: "5945" },
  { rolle: "utgifter", navn: "Utgiftsgodtgjørelse", standard: "7790" },
  { rolle: "forskuddstrekk", navn: "Forskuddstrekk", standard: "2600" },
  { rolle: "paaleggstrekk", navn: "Påleggstrekk (utleggstrekk)", standard: "2610" },
  { rolle: "bidragstrekk", navn: "Bidragstrekk", standard: "2620" },
  { rolle: "andre_trekk", navn: "Andre trekk", standard: "2690" },
  { rolle: "forskudd", navn: "Forskudd til ansatte", standard: "1570" },
  { rolle: "bilgodtgjorelse", navn: "Bilgodtgjørelse", standard: "7100" },
  { rolle: "diett", navn: "Diett og nattillegg", standard: "7150" },
  { rolle: "reiseutlegg", navn: "Reisekostnader (utlegg)", standard: "7140" },
  { rolle: "naturalytelser", navn: "Naturalytelser", standard: "5280" },
  { rolle: "naturalytelser_mot", navn: "Motkonto for naturalytelser", standard: "5290" },
  // Refusjonene fra NAV (0085, navRefusjon.ts): bank mot denne kontoen når pengene kommer.
  { rolle: "nav_refusjon", navn: "Refusjon fra NAV (sykepenger o.l.)", standard: "5800" },
  { rolle: "skyldig_aga", navn: "Skyldig arbeidsgiveravgift", standard: "2770" },
  { rolle: "paalopt_aga_feriepenger", navn: "Påløpt arbeidsgiveravgift på feriepenger", standard: "2785" },
  { rolle: "skyldig_lonn", navn: "Skyldig lønn", standard: "2930" },
  { rolle: "skyldige_feriepenger", navn: "Skyldige feriepenger", standard: "2940" },
  { rolle: "skyldig_otp", navn: "Skyldig pensjon (OTP)", standard: "2990" },
  { rolle: "bank", navn: "Bank", standard: "1920" },
];
const KONTONAVN = Object.fromEntries(KONTOROLLER.map((k) => [k.rolle, k.navn])) as Record<Kontorolle, string>;

export type Bokforingsoppsett = {
  kontoer: Partial<Record<Kontorolle, string>>;
  feriepenger: "avsetning" | "utbetaling";
  netto: "skyldig" | "bank";
  otp: boolean;
};

// Kontoene som brukes: standarden, med det organisasjonen har endret.
export function kontoplan(o: Pick<Bokforingsoppsett, "kontoer">): Record<Kontorolle, string> {
  return Object.fromEntries(KONTOROLLER.map((k) => [k.rolle, o.kontoer[k.rolle] ?? k.standard])) as Record<Kontorolle, string>;
}

// En postering: beløpet i kroner, positivt i debet og negativt i kredit.
export type Postering = { rolle: Kontorolle; konto: string; navn: string; tekst: string; belop: number };
export type Lonnsbilag = { kjoring_id: string; dato: string; tekst: string; posteringer: Postering[]; sum: number };

export type Bilagsslipp = {
  brutto: number;
  skattetrekk: number;
  utgifter: number;
  trekk_etter_skatt: number;
  netto: number;
  feriepenger_opptjent: number;
  otp: number;
  aga: number;
  aga_sats: number;
  // Feriepengene som utbetales på slippen (lønnsartene feriepenger og feriepenger_60).
  feriepenger: number;
  feriepenger_60: number;
  // Trekkene (0082, positive beløp): utleggstrekk, bidragstrekk og tilbakebetalt forskudd (resten av
  // trekkene etter skatt er andre trekk), og forskudd på lønn som er utbetalt.
  paaleggstrekk?: number;
  bidragstrekk?: number;
  forskudd_trekk?: number;
  forskudd_utbetalt?: number;
  // Reisene (0083): kilometergodtgjørelsen, diett og nattillegg, og utleggene etter regning (alt
  // utgiftsgodtgjørelse), og naturalytelsene (utbetales ikke; føres mot motkontoen).
  bilgodtgjorelse?: number;
  diett?: number;
  reiseutlegg?: number;
  naturalytelser?: number;
};
export type Bilagsgrunnlag = {
  kjoring: { id: string; periode: string; type: "ordinar" | "ekstra"; utbetalingsdato: string };
  slipper: Bilagsslipp[];
};

const ore = (n: number) => Math.round(Number(n) * 100);

export function lagLonnsbilag(g: Bilagsgrunnlag, o: Bokforingsoppsett): Lonnsbilag {
  const konto = kontoplan(o);
  const sum = (f: (s: Bilagsslipp) => number) => g.slipper.reduce((a, s) => a + f(s), 0);
  const avsetning = o.feriepenger === "avsetning";

  const brutto = sum((s) => ore(s.brutto));
  const ferie = sum((s) => ore(s.feriepenger));
  const ferie60 = sum((s) => ore(s.feriepenger_60));
  const utgifter = sum((s) => ore(s.utgifter));
  const skatt = sum((s) => ore(s.skattetrekk));
  const paalegg = sum((s) => ore(s.paaleggstrekk ?? 0));
  const bidrag = sum((s) => ore(s.bidragstrekk ?? 0));
  const forskuddTrekk = sum((s) => ore(s.forskudd_trekk ?? 0));
  const forskuddUt = sum((s) => ore(s.forskudd_utbetalt ?? 0));
  const bil = sum((s) => ore(s.bilgodtgjorelse ?? 0));
  const diett = sum((s) => ore(s.diett ?? 0));
  const reiseutlegg = sum((s) => ore(s.reiseutlegg ?? 0));
  const natural = sum((s) => ore(s.naturalytelser ?? 0));
  const andreTrekk = -sum((s) => ore(s.trekk_etter_skatt)) - paalegg - bidrag - forskuddTrekk;
  const netto = sum((s) => ore(s.netto));
  const aga = sum((s) => ore(s.aga));
  // Avgiften av feriepengene som utbetales (tas fra avsetningen), og av dem som avsettes.
  const agaFerie = Math.min(aga, sum((s) => Math.round((ore(s.feriepenger) * Number(s.aga_sats)) / 100)));
  const opptjent = sum((s) => ore(s.feriepenger_opptjent));
  const agaOpptjent = sum((s) => Math.round((ore(s.feriepenger_opptjent) * Number(s.aga_sats)) / 100));
  const otp = sum((s) => ore(s.otp));

  const p: Postering[] = [];
  const post = (rolle: Kontorolle, belopOre: number, tekst: string) => {
    if (belopOre !== 0) p.push({ rolle, konto: konto[rolle], navn: KONTONAVN[rolle], tekst, belop: belopOre / 100 });
  };
  post("lonn", brutto - ferie - ferie60, "Lønn");
  if (avsetning) {
    post("skyldige_feriepenger", ferie, "Feriepenger utbetalt");
    post("feriepenger", ferie60, "Feriepenger for den ekstra ferieuka");
  } else post("feriepenger", ferie + ferie60, "Feriepenger utbetalt");
  post("utgifter", utgifter - forskuddUt - bil - diett - reiseutlegg, "Utgiftsgodtgjørelse");
  post("bilgodtgjorelse", bil, "Kilometergodtgjørelse");
  post("diett", diett, "Diett og nattillegg");
  post("reiseutlegg", reiseutlegg, "Utlegg på reise");
  post("forskudd", forskuddUt, "Forskudd på lønn");
  post("naturalytelser", natural, "Naturalytelser");
  post("naturalytelser_mot", -natural, "Naturalytelser");
  post("forskuddstrekk", -skatt, "Forskuddstrekk");
  post("paaleggstrekk", -paalegg, "Utleggstrekk");
  post("bidragstrekk", -bidrag, "Bidragstrekk");
  post("forskudd", -forskuddTrekk, "Tilbakebetalt forskudd");
  post("andre_trekk", -andreTrekk, "Trekk i lønn");
  post(o.netto === "bank" ? "bank" : "skyldig_lonn", -netto, "Nettolønn");
  if (avsetning) {
    post("aga", aga - agaFerie, "Arbeidsgiveravgift");
    post("paalopt_aga_feriepenger", agaFerie, "Arbeidsgiveravgift av utbetalte feriepenger");
  } else post("aga", aga, "Arbeidsgiveravgift");
  post("skyldig_aga", -aga, "Arbeidsgiveravgift");
  if (avsetning) {
    post("feriepenger", opptjent, "Avsatte feriepenger");
    post("skyldige_feriepenger", -opptjent, "Avsatte feriepenger");
    post("aga_feriepenger", agaOpptjent, "Arbeidsgiveravgift av avsatte feriepenger");
    post("paalopt_aga_feriepenger", -agaOpptjent, "Arbeidsgiveravgift av avsatte feriepenger");
  }
  if (o.otp) {
    post("otp", otp, "OTP");
    post("skyldig_otp", -otp, "OTP");
  }
  const rest = p.reduce((a, x) => a + ore(x.belop), 0);
  if (rest !== 0) throw new Error(`Lønnsbilaget går ikke i null (${(rest / 100).toFixed(2)} kr). Regn ut lønnskjøringen på nytt.`);
  const k = g.kjoring;
  return {
    kjoring_id: k.id,
    dato: k.utbetalingsdato,
    tekst: `Lønn ${maanedNavn(k.periode)}${k.type === "ekstra" ? " (ekstra)" : ""}`,
    posteringer: p,
    sum: p.filter((x) => x.belop > 0).reduce((a, x) => a + ore(x.belop), 0) / 100,
  };
}

// --- Databasen ------------------------------------------------------------------------------

export async function hentBokforingsoppsett(db: Db, org: string): Promise<Bokforingsoppsett> {
  const o = await en<{ bokforing_kontoer: Record<string, string>; bokforing_feriepenger: string; bokforing_netto: string; bokforing_otp: boolean }>(
    db,
    "select bokforing_kontoer, bokforing_feriepenger, bokforing_netto, bokforing_otp from faktura.lonn_oppsett where org_id = $1",
    [org],
  );
  return {
    kontoer: (o?.bokforing_kontoer ?? {}) as Bokforingsoppsett["kontoer"],
    feriepenger: o?.bokforing_feriepenger === "utbetaling" ? "utbetaling" : "avsetning",
    netto: o?.bokforing_netto === "bank" ? "bank" : "skyldig",
    otp: Boolean(o?.bokforing_otp),
  };
}

// Grunnlaget for bilaget: den godkjente kjøringen og slippene i den (null ellers).
export async function hentBilagsgrunnlag(db: Db, org: string, kjoring: string): Promise<Bilagsgrunnlag | null> {
  const k = await en<Bilagsgrunnlag["kjoring"] & { status: string }>(
    db,
    `select id, to_char(periode, 'YYYY-MM-DD') as periode, type, to_char(utbetalingsdato, 'YYYY-MM-DD') as utbetalingsdato, status
       from faktura.lonnskjoringer where org_id = $1 and id = $2`,
    [org, kjoring],
  );
  if (!k || k.status !== "godkjent") return null;
  const slipper = await alle<Bilagsslipp>(
    db,
    `select s.brutto::float8 as brutto, s.skattetrekk::float8 as skattetrekk, s.utgifter::float8 as utgifter, s.trekk_etter_skatt::float8 as trekk_etter_skatt,
            s.netto::float8 as netto, s.feriepenger_opptjent::float8 as feriepenger_opptjent, s.otp::float8 as otp, s.aga::float8 as aga, s.aga_sats::float8 as aga_sats,
            coalesce((select sum(l.belop) from faktura.lonnslinjer l where l.slipp_id = s.id and not l.fjernet and l.lonnsart = 'feriepenger'), 0)::float8 as feriepenger,
            coalesce((select sum(l.belop) from faktura.lonnslinjer l where l.slipp_id = s.id and not l.fjernet and l.lonnsart = 'feriepenger_60'), 0)::float8 as feriepenger_60,
            coalesce((select -sum(l.belop) from faktura.lonnslinjer l where l.slipp_id = s.id and not l.fjernet
                        and l.lonnsart in ('utleggstrekk_samordnet', 'utleggstrekk_skatt', 'utleggstrekk')), 0)::float8 as paaleggstrekk,
            coalesce((select -sum(l.belop) from faktura.lonnslinjer l where l.slipp_id = s.id and not l.fjernet and l.lonnsart = 'bidragstrekk'), 0)::float8 as bidragstrekk,
            coalesce((select -sum(l.belop) from faktura.lonnslinjer l where l.slipp_id = s.id and not l.fjernet and l.lonnsart = 'forskudd_trekk'), 0)::float8 as forskudd_trekk,
            coalesce((select sum(l.belop) from faktura.lonnslinjer l where l.slipp_id = s.id and not l.fjernet and l.lonnsart = 'forskudd_utbetalt'), 0)::float8 as forskudd_utbetalt,
            coalesce((select sum(l.belop) from faktura.lonnslinjer l where l.slipp_id = s.id and not l.fjernet
                        and l.lonnsart in ('km_bil', 'km_tillegg', 'km_passasjer', 'km_annet', 'km_bil_trekk', 'km_annet_trekk')), 0)::float8 as bilgodtgjorelse,
            coalesce((select sum(l.belop) from faktura.lonnslinjer l where l.slipp_id = s.id and not l.fjernet
                        and l.lonnsart in ('reise_kost_hotell', 'reise_kost_hybel', 'reise_kost_privat', 'reise_kost_dag', 'reise_nattillegg',
                                           'reise_kost_trekk', 'reise_annet_trekk')), 0)::float8 as diett,
            coalesce((select sum(l.belop) from faktura.lonnslinjer l where l.slipp_id = s.id and not l.fjernet and l.lonnsart = 'reise_utlegg'), 0)::float8 as reiseutlegg,
            s.naturalytelser::float8 as naturalytelser
       from faktura.lonnsslipper s
      where s.org_id = $1 and s.kjoring_id = $2
      order by s.ansattnummer`,
    [org, kjoring],
  );
  return { kjoring: { id: k.id, periode: k.periode, type: k.type, utbetalingsdato: k.utbetalingsdato }, slipper };
}

// Bilaget for en godkjent kjøring med organisasjonens oppsett, som det blir bokført (null når
// kjøringen ikke er godkjent).
export async function forslagTilBilag(db: Db, org: string, kjoring: string): Promise<Lonnsbilag | null> {
  const g = await hentBilagsgrunnlag(db, org, kjoring);
  return g ? lagLonnsbilag(g, await hentBokforingsoppsett(db, org)) : null;
}

// Fører lønnsbilaget for en godkjent kjøring (i transaksjonen som godkjenner den, eller for en
// kjøring som ble godkjent før bokføringen kom). Gir bilaget.
export async function bokforKjoring(db: Db, org: string, kjoring: string) {
  const b = await forslagTilBilag(db, org, kjoring);
  if (!b) throw new ApiFeil(409, "Godkjenn lønnskjøringen før den bokføres");
  return (await en<{ id: string; serie: string; aar: number; nummer: number }>(db, "select id, serie, aar, nummer from faktura.bokfor_lonn($1, $2, $3, $4)", [
    kjoring,
    b.dato,
    b.tekst,
    JSON.stringify(b.posteringer.map((p) => ({ konto: p.konto, belop: p.belop, tekst: p.tekst }))),
  ]))!;
}

// Kontonavnene etter standarden, til visningen (kontoer som er endret, får navnet til rollen).
const STANDARDNAVN: Record<string, string> = Object.fromEntries(KONTOROLLER.map((k) => [k.standard, k.navn]));
export function kontonavn(konto: string, plan: Record<Kontorolle, string>): string {
  return KONTOROLLER.find((k) => plan[k.rolle] === konto)?.navn ?? STANDARDNAVN[konto] ?? "";
}

export type LagretBilag = {
  id: string;
  bilagsnummer: string;
  dato: string;
  tekst: string;
  reverserer: string | null;
  reversert_av: string | null;
  opprettet: string;
  opprettet_av: string | null;
  posteringer: Postering[];
};

// Bilagene (med posteringene) for en kjøring, eller for kjøringene og refusjonene fra NAV (0085)
// med bilag i perioden. Nyeste først for en kjøring; i rekkefølgen i serien for perioden.
export async function hentBilag(db: Db, org: string, valg: { kjoring: string } | { fra: string; til: string }): Promise<LagretBilag[]> {
  const plan = kontoplan(await hentBokforingsoppsett(db, org));
  const enKjoring = "kjoring" in valg;
  const bilag = await alle<Omit<LagretBilag, "posteringer">>(
    db,
    `select b.id, b.serie || '-' || b.aar || '-' || b.nummer as bilagsnummer, to_char(b.dato, 'YYYY-MM-DD') as dato, b.tekst,
            b.reverserer, b.reversert_av, b.opprettet, (select coalesce(u.navn, u.epost) from faktura.brukere u where u.id = b.opprettet_av) as opprettet_av
       from faktura.bilag b
      where b.org_id = $1 and ${enKjoring ? "b.kilde = 'lonn' and b.kilde_id = $2" : "b.kilde in ('lonn', 'nav_refusjon') and b.dato between $2 and $3"}
      order by ${enKjoring ? "b.opprettet desc, b.nummer desc" : "b.aar, b.nummer"}`,
    enKjoring ? [org, valg.kjoring] : [org, valg.fra, valg.til],
  );
  if (!bilag.length) return [];
  const poster = await alle<{ bilag_id: string; konto: string; tekst: string | null; belop: number }>(
    db,
    "select bilag_id, konto, tekst, belop::float8 as belop from faktura.posteringer where org_id = $1 and bilag_id = any($2::uuid[]) order by bilag_id, rekke",
    [org, bilag.map((b) => b.id)],
  );
  return bilag.map((b) => ({
    ...b,
    posteringer: poster
      .filter((p) => p.bilag_id === b.id)
      .map((p) => ({ rolle: (KONTOROLLER.find((k) => plan[k.rolle] === p.konto)?.rolle ?? "lonn") as Kontorolle, konto: p.konto, navn: kontonavn(p.konto, plan), tekst: p.tekst ?? "", belop: p.belop })),
  }));
}
