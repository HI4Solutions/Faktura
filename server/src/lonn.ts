// Lønnskjøringen (0065_lonn.sql): rutene under /api/org/:org/lonn. Eier og administrator lager
// en kjøring for en måned; her hentes grunnlaget (de ansatte med lønn og skattekort, de godkjente
// timene som ikke er lønnet, de faste tilleggene, sykefraværet og de planlagte timene, tallene i år
// og trekktabellene), lonnsberegning.ts regner ut slippene, og resultatet lagres. Linjene kan
// endres, fjernes og legges til før kjøringen godkjennes (lonn_godkjenn låser den og merker
// timene som lønnet); en godkjent kjøring kan åpnes igjen. De ansatte ser sine egne slipper
// (også som PDF) når kjøringen er godkjent, og får et varsel.

import { Hono, type Context } from "hono";
import { z } from "zod";
import { alle, en, somBetrodd, somBruker, somSystem, type Db } from "./db.js";
import { ApiFeil } from "./feil.js";
import { uke } from "./arbeidstid.js";
import { beregnBemanning } from "./arbeidsplan.js";
import { lonnsart, LONNSARTER } from "./lonnsarter.js";
import {
  andelAnsatt,
  arbeidsgiverperiode,
  arbeidsgiveravgift,
  AGA_FULL,
  fastlonn,
  feriepengelinjer,
  ferietrekk,
  frister,
  maanedNavn,
  periodeSlutt,
  pluss,
  rund,
  summer,
  sykelinjer,
  tilleggslinjer,
  timelinjer,
  utbetalingsdato,
  virkedag,
  type Ansatt,
  type Ferieuke,
  type Linje,
  type Oppsett,
  type Sykedag,
  type Tillegg,
  type Trekkrad,
} from "./lonnsberegning.js";
import { lagLonnsslippPdf } from "./lonnsslippPdf.js";
import { hentLogo } from "./dokument.js";
import { leggIKo } from "./tjenester.js";

const uuid = z.string().uuid();
const orgId = (c: Context) => uuid.parse(c.req.param("org"));
const bruk = <T>(c: Context, fn: (db: Db) => Promise<T>) => somBruker<T>(c.get("bruker").id, fn);
const datoS = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Ugyldig dato");

type Kjoring = {
  id: string;
  org_id: string;
  periode: string;
  type: "ordinar" | "ekstra";
  utbetalingsdato: string;
  status: "utkast" | "godkjent";
  feriepenger: boolean;
  halv_skatt: boolean;
  notat: string | null;
  godkjent_at: string | null;
};
type Slipp = {
  id: string;
  ansatt_id: string;
  skattetrekk: number;
  skattetrekk_manuell: boolean;
};
type LagretLinje = Linje & { id: string; slipp_id: string; kilde: "auto" | "manuell"; fjernet: boolean };

// --- Oppsettet --------------------------------------------------------------------------------

async function hentOppsett(db: Db, org: string): Promise<Oppsett & { lonnsdag: number; halv_skatt: string }> {
  const o = await en<any>(
    db,
    `select l.daglig_grense, l.ukentlig_grense, l.overtid_prosent, l.ferie_dager, l.aga_sone, l.otp_prosent, l.feriepenger_prosent, l.lonnsdag, l.halv_skatt
       from faktura.lonn_oppsett l where l.org_id = $1`,
    [org],
  );
  return {
    daglig_grense: Number(o?.daglig_grense ?? 9),
    ukentlig_grense: Number(o?.ukentlig_grense ?? 40),
    overtid_prosent: Number(o?.overtid_prosent ?? 40),
    ferie_dager: Number(o?.ferie_dager ?? 25),
    aga_sone: o?.aga_sone ?? "1",
    otp_prosent: Number(o?.otp_prosent ?? 2),
    feriepenger_prosent: Number(o?.feriepenger_prosent ?? 12),
    lonnsdag: Number(o?.lonnsdag ?? 20),
    halv_skatt: o?.halv_skatt ?? "desember",
  };
}

// --- Beregningen ------------------------------------------------------------------------------

const ANSATTE = `
  select a.id, a.ansattnummer, a.fornavn || ' ' || a.etternavn as navn, to_char(a.fodselsdato, 'YYYY-MM-DD') as fodselsdato,
         to_char(a.ansatt_fra, 'YYYY-MM-DD') as ansatt_fra, to_char(a.ansatt_til, 'YYYY-MM-DD') as ansatt_til, a.lonnstype,
         a.maanedslonn::float8 as maanedslonn, a.timelonn::float8 as timelonn, a.stillingsprosent::float8 as stillingsprosent,
         a.ukentlig_arbeidstid::float8 as ukentlig_arbeidstid, a.ferie_dager::float8 as ferie_dager, a.kontonr, a.skattekort,
         a.skatt_tabell, a.skatt_prosent::float8 as skatt_prosent, a.skatt_frikort::float8 as skatt_frikort, a.skattekort_aar, a.aktiv
    from faktura.ansatte a`;

// Regner ut kjøringen på nytt og lagrer slippene (bare et utkast). De manuelle linjene (lagt til,
// endret eller fjernet) og et trekk satt for hånd beholdes.
export async function beregnKjoring(db: Db, kjoringId: string): Promise<void> {
  const k = await en<Kjoring>(
    db,
    `select id, org_id, to_char(periode, 'YYYY-MM-DD') as periode, type, to_char(utbetalingsdato, 'YYYY-MM-DD') as utbetalingsdato, status, feriepenger, halv_skatt
       from faktura.lonnskjoringer where id = $1 for update`,
    [kjoringId],
  );
  if (!k) throw new ApiFeil(404, "Fant ikke lønnskjøringen");
  if (k.status !== "utkast") throw new ApiFeil(409, "Lønnskjøringen er godkjent. Åpne den igjen for å endre den.");
  await db.query("select faktura.krev($1, 'personal')", [k.org_id]);
  const org = k.org_id;
  const fra = k.periode;
  const til = periodeSlutt(fra);
  const aar = Number(k.utbetalingsdato.slice(0, 4));
  const o = await hentOppsett(db, org);
  const ordinar = k.type === "ordinar";

  const ansatte = await alle<Ansatt & { aktiv: boolean }>(db, `${ANSATTE} where a.org_id = $1 and a.arbeidstaker order by a.ansattnummer`, [org]);
  const tillegg = await alle<Tillegg & { ansatt_id: string }>(
    db,
    `select id, ansatt_id, navn, belop::float8 as belop, per, to_char(fra, 'YYYY-MM-DD') as fra, to_char(til, 'YYYY-MM-DD') as til
       from faktura.ansatt_tillegg where org_id = $1 order by opprettet, id`,
    [org],
  );
  // De godkjente timene i ukene som har timer som ikke er lønnet (uker som begynner i perioden
  // eller før), i ordinære kjøringer: hele uka, også det som er lønnet før (overtiden regnes på uka).
  const foringer = ordinar
    ? await alle<{ id: string; ansatt_id: string; dato: string; timer: number; overtid_prosent: number | null; lonnskjoring_id: string | null }>(
        db,
        `with uker as (
           select distinct ansatt_id, date_trunc('week', dato)::date as uke from faktura.timeforinger
            where org_id = $1 and status = 'godkjent' and lonnskjoring_id is null and dato <= $2 and dato >= $3
         )
         select t.id, t.ansatt_id, to_char(t.dato, 'YYYY-MM-DD') as dato, t.timer::float8 as timer, t.overtid_prosent, t.lonnskjoring_id
           from faktura.timeforinger t join uker u on u.ansatt_id = t.ansatt_id and date_trunc('week', t.dato)::date = u.uke
          where t.org_id = $1 and t.status = 'godkjent'`,
        [org, pluss(til, 6), pluss(fra, -400)],
      )
    : [];
  const ukerPer = new Map<string, Map<string, Ferieuke & { ider: string[] }>>();
  for (const f of foringer) {
    const u = uke(f.dato).fra;
    if (u > til) continue;
    const per = ukerPer.get(f.ansatt_id) ?? new Map();
    ukerPer.set(f.ansatt_id, per);
    const x = per.get(u) ?? { alle: [], betalt: [], ider: [] };
    per.set(u, x);
    x.alle.push({ id: f.id, dato: f.dato, timer: Number(f.timer), overtid_prosent: f.overtid_prosent });
    if (f.lonnskjoring_id) x.betalt.push({ dato: f.dato, timer: Number(f.timer), overtid_prosent: f.overtid_prosent });
    else x.ider.push(f.id);
  }
  // Sykefravær og sykt barn (for arbeidsgiverperioden og omsorgsdagene), og de planlagte timene.
  const fravaer = ordinar
    ? await alle<{ ansatt_id: string; fra: string; til: string; type: string }>(
        db,
        `select ansatt_id, to_char(fra, 'YYYY-MM-DD') as fra, to_char(til, 'YYYY-MM-DD') as til, type
           from faktura.fravaer where org_id = $1 and type in ('syk', 'sykt_barn') and til >= $2 and fra <= $3`,
        [org, `${fra.slice(0, 4)}-01-01` < pluss(fra, -90) ? `${fra.slice(0, 4)}-01-01` : pluss(fra, -90), til],
      )
    : [];
  const planlagt = new Map<string, number>(); // «ansatt|dato» → timer
  if (ordinar && fravaer.some((f) => f.til >= fra)) {
    const vakter = await alle<{ ansatt_id: string; dato: string; timer: number }>(
      db,
      "select ansatt_id, to_char(dato, 'YYYY-MM-DD') as dato, sum(timer)::float8 as timer from faktura.vakter where org_id = $1 and dato between $2 and $3 and ansatt_id is not null group by 1, 2",
      [org, fra, til],
    );
    for (const v of vakter) planlagt.set(`${v.ansatt_id}|${v.dato}`, Number(v.timer));
    const b = await beregnBemanning(db, org, fra, til);
    for (const f of b.faste) if (!planlagt.has(`${f.ansatt_id}|${f.dato}`)) planlagt.set(`${f.ansatt_id}|${f.dato}`, Number(f.timer));
  }

  // Tallene i år og i fjor (godkjente kjøringer, utenom denne, og tidligere lønnssystem).
  const ider = ansatte.map((a) => a.id);
  const tidligere = await alle<{ ansatt_id: string; aar: number; trekkpliktig: number; feriepengegrunnlag: number }>(
    db,
    `select s.ansatt_id, extract(year from k.utbetalingsdato)::int as aar, sum(s.trekkpliktig)::float8 as trekkpliktig, sum(s.feriepengegrunnlag)::float8 as feriepengegrunnlag
       from faktura.lonnsslipper s join faktura.lonnskjoringer k on k.id = s.kjoring_id
      where s.org_id = $1 and k.status = 'godkjent' and k.id <> $2 and s.ansatt_id = any($3) group by 1, 2`,
    [org, k.id, ider],
  );
  const utbetaltFerie = await alle<{ ansatt_id: string; lonnsart: string; aar: number; belop: number }>(
    db,
    `select s.ansatt_id, l.lonnsart, l.opptjeningsaar as aar, sum(l.belop)::float8 as belop
       from faktura.lonnslinjer l join faktura.lonnsslipper s on s.id = l.slipp_id join faktura.lonnskjoringer k on k.id = s.kjoring_id
      where l.org_id = $1 and k.status = 'godkjent' and k.id <> $2 and not l.fjernet and l.lonnsart in ('feriepenger', 'feriepenger_60') and l.opptjeningsaar is not null
      group by 1, 2, 3`,
    [org, k.id],
  );
  const inngaende = await alle<{ ansatt_id: string; aar: number; feriepengegrunnlag: number; feriepenger_utbetalt: number; trekkpliktig: number }>(
    db,
    "select ansatt_id, aar, feriepengegrunnlag::float8 as feriepengegrunnlag, feriepenger_utbetalt::float8 as feriepenger_utbetalt, trekkpliktig::float8 as trekkpliktig from faktura.lonn_inngaende where org_id = $1",
    [org],
  );
  const iAar = (a: string, y: number) => tidligere.find((t) => t.ansatt_id === a && t.aar === y);
  const inn = (a: string, y: number) => inngaende.find((t) => t.ansatt_id === a && t.aar === y);
  const ferieUtbetalt = (a: string, y: number, art: string) =>
    utbetaltFerie.filter((t) => t.ansatt_id === a && t.aar === y && t.lonnsart === art).reduce((s, t) => s + Number(t.belop), 0);

  // Trekktabellene for året (bare tabellene de ansatte har).
  const tabeller = [...new Set(ansatte.filter((a) => a.skattekort === "tabell" && a.skatt_tabell).map((a) => Number(a.skatt_tabell)))];
  const tabellrader = new Map<number, Trekkrad[]>();
  if (tabeller.length) {
    for (const r of await alle<{ tabell: number; grunnlag: number; trekk: number }>(
      db,
      "select tabell, grunnlag, trekk from faktura.trekktabeller where aar = $1 and tabell = any($2) order by tabell, grunnlag",
      [aar, tabeller],
    )) {
      const l = tabellrader.get(r.tabell) ?? [];
      tabellrader.set(r.tabell, l);
      l.push({ grunnlag: r.grunnlag, trekk: r.trekk });
    }
  }
  // Fribeløpet i sone 1a: den sparte avgiften i godkjente kjøringer i år.
  const fribelopBrukt =
    o.aga_sone === "1a"
      ? Number(
          (
            await en<{ n: number }>(
              db,
              `select coalesce(sum(s.aga_grunnlag * ${AGA_FULL} / 100 - s.aga), 0)::float8 as n
                 from faktura.lonnsslipper s join faktura.lonnskjoringer k on k.id = s.kjoring_id
                where s.org_id = $1 and k.status = 'godkjent' and k.id <> $2 and extract(year from k.utbetalingsdato) = $3`,
              [org, k.id, aar],
            )
          )?.n ?? 0,
        )
      : 0;

  // Slippene og linjene som finnes.
  const slipper = await alle<Slipp>(
    db,
    "select id, ansatt_id, skattetrekk::float8 as skattetrekk, skattetrekk_manuell from faktura.lonnsslipper where kjoring_id = $1",
    [k.id],
  );
  const linjer = await alle<LagretLinje>(
    db,
    `select l.id, l.slipp_id, l.lonnsart, l.tekst, l.antall::float8 as antall, l.sats::float8 as sats, l.belop::float8 as belop, l.kilde, l.nokkel,
            l.fjernet, l.opptjeningsaar
       from faktura.lonnslinjer l join faktura.lonnsslipper s on s.id = l.slipp_id where s.kjoring_id = $1 order by l.rekkefolge, l.opprettet`,
    [k.id],
  );

  type Resultat = { a: Ansatt; slipp: Slipp | undefined; auto: Linje[]; manuelle: LagretLinje[]; timeforinger: string[]; merknader: string[] };
  const resultater: Resultat[] = [];
  for (const a of ansatte) {
    const slipp = slipper.find((s) => s.ansatt_id === a.id);
    const manuelle = slipp ? linjer.filter((l) => l.slipp_id === slipp.id && l.kilde === "manuell") : [];
    // Ansatt i perioden (og aktiv): fastlønn og faste tillegg per måned. Timene som er godkjent,
    // lønnes uansett.
    const ansatt = a.aktiv && andelAnsatt(a, fra, til).andel > 0;
    const uker = [...(ukerPer.get(a.id)?.values() ?? [])].filter((u) => u.ider.length > 0);
    const merknader: string[] = [];
    const auto: Linje[] = [];
    let timeforinger: string[] = [];
    if (ordinar) {
      const f = ansatt ? fastlonn(a, fra, til) : null;
      if (f) auto.push(f);
      const t = timelinjer(a, o, uker);
      auto.push(...t.linjer);
      timeforinger = uker.flatMap((u) => u.ider);
      const egneTillegg = tillegg.filter((x) => x.ansatt_id === a.id && (ansatt || (x.per === "time" && a.lonnstype === "time")));
      auto.push(...tilleggslinjer(a, egneTillegg, fra, til, t.timer, t.ekstraTimer));
      // Sykdom: arbeidsgiverperioden, og sykt barn (omsorgsdagene i året).
      const egne = fravaer.filter((x) => x.ansatt_id === a.id);
      if (egne.length) {
        const p = arbeidsgiverperiode(egne, a.ansatt_fra);
        const dager: Sykedag[] = [];
        let omsorgBrukt = 0;
        for (const x of egne) {
          for (let d = x.fra; d <= x.til; d = pluss(d, 1)) {
            const timer = planlagt.get(`${a.id}|${d}`) ?? 0;
            if (d >= fra && d <= til) dager.push({ dato: d, timer, type: x.type as Sykedag["type"] });
            else if (x.type === "sykt_barn" && d < fra && d.slice(0, 4) === fra.slice(0, 4) && virkedag(d)) omsorgBrukt++;
          }
        }
        const s = sykelinjer(a, dager, p.agp, omsorgBrukt);
        auto.push(...s.linjer);
        merknader.push(...s.merknader);
        const etter = dager.filter((d) => d.type === "syk" && p.etter.has(d.dato)).length;
        if (etter) merknader.push(`Syk ${etter} ${etter === 1 ? "dag" : "dager"} etter arbeidsgiverperioden (16 dager). NAV betaler sykepenger da; betaler dere lønnen, kan dere kreve refusjon.`);
        const uten = dager.filter((d) => d.type === "syk" && p.utenOpptjening.has(d.dato)).length;
        if (uten) merknader.push(`Syk ${uten} ${uten === 1 ? "dag" : "dager"} før fire uker i arbeid: arbeidsgiveren betaler ikke sykepenger da (NAV kan).`);
      }
      if (a.lonnstype === "maaned" && !a.maanedslonn && ansatt) merknader.push("Mangler månedslønn på den ansatte.");
      if (a.lonnstype === "time" && !a.timelonn && uker.length) merknader.push("Mangler timelønn på den ansatte.");
    }
    // Feriepenger for i fjor (vanligvis i juni), med ferietrekket for dem med fastlønn.
    if (k.feriepenger) {
      const y = aar - 1;
      const grunnlag = Number(iAar(a.id, y)?.feriepengegrunnlag ?? 0) + Number(inn(a.id, y)?.feriepengegrunnlag ?? 0);
      const utbetalt = ferieUtbetalt(a.id, y, "feriepenger") + Number(inn(a.id, y)?.feriepenger_utbetalt ?? 0);
      const fp = feriepengelinjer(a, o, y, grunnlag, utbetalt, ferieUtbetalt(a.id, y, "feriepenger_60"), k.utbetalingsdato);
      auto.push(...fp);
      if (fp.length && ordinar && ansatt) {
        const t = ferietrekk(a, o);
        if (t) {
          auto.push(t);
          const sum = fp.reduce((s, l) => s + l.belop, 0);
          if (-t.belop > sum) merknader.push("Trekket for ferie er større enn feriepengene (den ansatte har ikke vært ansatt hele opptjeningsåret). Sjekk antall dager.");
        }
      }
    }
    if (!ansatt && !uker.length && !auto.length && !manuelle.length && !slipp) continue;
    if (!ordinar && !k.feriepenger && !slipp) continue;
    resultater.push({ a, slipp, auto, manuelle, timeforinger, merknader });
  }

  // Sluttoppgjør: feriepengene opptjent i år (og i fjor, om de ikke er utbetalt) for den som slutter
  // i perioden.
  for (const r of resultater) {
    const a = r.a;
    if (!ordinar || !a.ansatt_til || a.ansatt_til < fra || a.ansatt_til > til) continue;
    const egne = r.auto.filter((l) => !r.manuelle.some((m) => m.nokkel && m.nokkel === l.nokkel));
    const gjeldende = [...egne, ...r.manuelle.filter((m) => !m.fjernet)];
    const ferieNa = gjeldende.filter((l) => lonnsart(l.lonnsart).ferie).reduce((s, l) => s + Number(l.belop), 0);
    const grunnlag = Number(iAar(a.id, aar)?.feriepengegrunnlag ?? 0) + Number(inn(a.id, aar)?.feriepengegrunnlag ?? 0) + ferieNa;
    r.auto.push(...feriepengelinjer(a, o, aar, grunnlag, ferieUtbetalt(a.id, aar, "feriepenger") + Number(inn(a.id, aar)?.feriepenger_utbetalt ?? 0), ferieUtbetalt(a.id, aar, "feriepenger_60"), k.utbetalingsdato, true));
    if (!k.feriepenger) {
      const y = aar - 1;
      const g = Number(iAar(a.id, y)?.feriepengegrunnlag ?? 0) + Number(inn(a.id, y)?.feriepengegrunnlag ?? 0);
      r.auto.push(...feriepengelinjer(a, o, y, g, ferieUtbetalt(a.id, y, "feriepenger") + Number(inn(a.id, y)?.feriepenger_utbetalt ?? 0), ferieUtbetalt(a.id, y, "feriepenger_60"), k.utbetalingsdato, true));
    }
    r.merknader.push(`Slutter ${a.ansatt_til.split("-").reverse().join(".")}: feriepengene er tatt med (sluttoppgjør).`);
  }

  // Summene, skattetrekket og arbeidsgiveravgiften, og lagringen.
  const halv = k.halv_skatt;
  const beregnet = resultater.map((r) => {
    const hoppOver = new Set(r.manuelle.map((m) => m.nokkel).filter(Boolean));
    const auto = r.auto.filter((l) => !l.nokkel || !hoppOver.has(l.nokkel));
    const alleLinjer: Linje[] = [...auto, ...r.manuelle];
    const frikortBrukt = Number(iAar(r.a.id, aar)?.trekkpliktig ?? 0) + Number(inn(r.a.id, aar)?.trekkpliktig ?? 0);
    const s = summer(
      alleLinjer,
      o,
      { ansatt: r.a, aar, ekstra: !ordinar, halvSkatt: halv, tabell: r.a.skattekort === "tabell" && r.a.skatt_tabell ? (tabellrader.get(Number(r.a.skatt_tabell)) ?? null) : null, frikortBrukt },
      k.utbetalingsdato,
      r.slipp?.skattetrekk_manuell ? Number(r.slipp.skattetrekk) : null,
    );
    if (!r.a.kontonr && s.netto > 0) s.merknader.push("Mangler kontonummer på den ansatte.");
    return { r, auto, s };
  });
  const aga = arbeidsgiveravgift(o.aga_sone, beregnet.map((b) => b.s.aga_grunnlag), fribelopBrukt);

  const behold = new Set<string>();
  for (const [i, { r, auto, s }] of beregnet.entries()) {
    // Ingenting å lønne (og ingenting lagt til for hånd): ingen slipp.
    if (!auto.length && !r.manuelle.length && !r.slipp?.skattetrekk_manuell && !r.merknader.length) continue;
    const felles = [
      r.a.navn,
      r.a.ansattnummer,
      r.a.lonnstype,
      k.periode,
      k.utbetalingsdato,
      s.trekkmetode,
      s.trekkpliktig,
      s.trekkgrunnlag,
      s.skattetrekk,
      r.slipp?.skattetrekk_manuell ?? false,
      s.brutto,
      s.utgifter,
      s.trekk_etter_skatt,
      s.netto,
      s.feriepengegrunnlag,
      s.feriepenger_opptjent,
      s.otp_grunnlag,
      s.otp,
      s.aga_grunnlag,
      aga[i]!.aga,
      aga[i]!.sats,
      r.timeforinger,
      [...r.merknader, ...s.merknader],
    ];
    let slippId = r.slipp?.id;
    if (slippId) {
      await db.query(
        `update faktura.lonnsslipper set navn = $2, ansattnummer = $3, lonnstype = $4, periode = $5, utbetalingsdato = $6, trekkmetode = $7, trekkpliktig = $8,
                trekkgrunnlag = $9, skattetrekk = $10, skattetrekk_manuell = $11, brutto = $12, utgifter = $13, trekk_etter_skatt = $14, netto = $15,
                feriepengegrunnlag = $16, feriepenger_opptjent = $17, otp_grunnlag = $18, otp = $19, aga_grunnlag = $20, aga = $21, aga_sats = $22,
                timeforinger = $23, merknader = $24
          where id = $1`,
        [slippId, ...felles],
      );
      await db.query("delete from faktura.lonnslinjer where slipp_id = $1 and kilde = 'auto'", [slippId]);
    } else {
      slippId = (await en<{ id: string }>(
        db,
        `insert into faktura.lonnsslipper (org_id, kjoring_id, ansatt_id, navn, ansattnummer, lonnstype, periode, utbetalingsdato, trekkmetode, trekkpliktig,
                trekkgrunnlag, skattetrekk, skattetrekk_manuell, brutto, utgifter, trekk_etter_skatt, netto, feriepengegrunnlag, feriepenger_opptjent,
                otp_grunnlag, otp, aga_grunnlag, aga, aga_sats, timeforinger, merknader)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26) returning id`,
        [org, k.id, r.a.id, ...felles],
      ))!.id;
    }
    behold.add(slippId);
    for (const [n, l] of auto.entries())
      await db.query(
        `insert into faktura.lonnslinjer (org_id, slipp_id, lonnsart, tekst, antall, sats, belop, kilde, nokkel, opptjeningsaar, rekkefolge)
         values ($1, $2, $3, $4, $5, $6, $7, 'auto', $8, $9, $10)`,
        [org, slippId, l.lonnsart, l.tekst, l.antall, l.sats, l.belop, l.nokkel, l.opptjeningsaar ?? null, n],
      );
  }
  // Slipper uten grunnlag lenger (og uten noe lagt til for hånd) fjernes.
  for (const s of slipper)
    if (!behold.has(s.id) && !linjer.some((l) => l.slipp_id === s.id && l.kilde === "manuell") && !s.skattetrekk_manuell)
      await db.query("delete from faktura.lonnsslipper where id = $1", [s.id]);
}

// --- Visningen --------------------------------------------------------------------------------

const SLIPP = `
  select s.id, s.kjoring_id, s.ansatt_id, s.navn, s.ansattnummer, s.lonnstype, to_char(s.periode, 'YYYY-MM-DD') as periode,
         to_char(s.utbetalingsdato, 'YYYY-MM-DD') as utbetalingsdato, s.kontonr, s.trekkmetode, s.trekkpliktig::float8 as trekkpliktig,
         s.trekkgrunnlag::float8 as trekkgrunnlag, s.skattetrekk::float8 as skattetrekk, s.skattetrekk_manuell, s.brutto::float8 as brutto,
         s.utgifter::float8 as utgifter, s.trekk_etter_skatt::float8 as trekk_etter_skatt, s.netto::float8 as netto,
         s.feriepengegrunnlag::float8 as feriepengegrunnlag, s.feriepenger_opptjent::float8 as feriepenger_opptjent,
         s.otp_grunnlag::float8 as otp_grunnlag, s.otp::float8 as otp, s.aga_grunnlag::float8 as aga_grunnlag, s.aga::float8 as aga,
         s.aga_sats::float8 as aga_sats, cardinality(s.timeforinger) as antall_timeforinger, s.merknader
    from faktura.lonnsslipper s`;
const LINJE = `
  select l.id, l.slipp_id, l.lonnsart, l.tekst, l.antall::float8 as antall, l.sats::float8 as sats, l.belop::float8 as belop, l.kilde, l.nokkel,
         l.fjernet, l.opptjeningsaar
    from faktura.lonnslinjer l`;

export async function hentKjoring(db: Db, org: string, id: string) {
  const k = await en<any>(
    db,
    `select k.id, to_char(k.periode, 'YYYY-MM-DD') as periode, k.type, to_char(k.utbetalingsdato, 'YYYY-MM-DD') as utbetalingsdato, k.status,
            k.feriepenger, k.halv_skatt, k.notat, k.godkjent_at, k.opprettet,
            (select coalesce(b.navn, b.epost) from faktura.brukere b where b.id = k.godkjent_av) as godkjent_av
       from faktura.lonnskjoringer k where k.org_id = $1 and k.id = $2`,
    [org, id],
  );
  if (!k) throw new ApiFeil(404, "Fant ikke lønnskjøringen");
  const slipper = await alle<any>(db, `${SLIPP} where s.kjoring_id = $1 order by s.ansattnummer`, [id]);
  const linjer = await alle<any>(db, `${LINJE} join faktura.lonnsslipper s on s.id = l.slipp_id where s.kjoring_id = $1 order by l.rekkefolge, l.opprettet`, [id]);
  // Kontonummeret nå (før godkjenning), og om den ansatte har skattekort.
  const ansatte = await alle<any>(
    db,
    "select id, kontonr, skattekort, skatt_tabell, skattekort_aar from faktura.ansatte where org_id = $1 and id = any($2)",
    [org, slipper.map((s) => s.ansatt_id)],
  );
  const o = await hentOppsett(db, org);
  const aar = Number(k.utbetalingsdato.slice(0, 4));
  const tabell = await en<{ n: number }>(db, "select count(*)::int as n from faktura.trekktabeller where aar = $1", [aar]);
  const ut = slipper.map((s) => {
    const a = ansatte.find((x) => x.id === s.ansatt_id);
    return { ...s, kontonr: s.kontonr ?? a?.kontonr ?? null, linjer: linjer.filter((l) => l.slipp_id === s.id) };
  });
  const sum = (felt: string) => rund(ut.reduce((x, s) => x + Number(s[felt] ?? 0), 0));
  return {
    ...k,
    aga_sone: o.aga_sone,
    otp_prosent: o.otp_prosent,
    feriepenger_prosent: o.feriepenger_prosent,
    trekktabeller: { aar, lastet: (tabell?.n ?? 0) > 0 },
    frister: frister(k.utbetalingsdato),
    sum: {
      antall: ut.length,
      brutto: sum("brutto"),
      skattetrekk: sum("skattetrekk"),
      utgifter: sum("utgifter"),
      trekk_etter_skatt: sum("trekk_etter_skatt"),
      netto: sum("netto"),
      feriepengegrunnlag: sum("feriepengegrunnlag"),
      feriepenger_opptjent: sum("feriepenger_opptjent"),
      otp: sum("otp"),
      aga_grunnlag: sum("aga_grunnlag"),
      aga: sum("aga"),
      merknader: ut.reduce((n, s) => n + (s.merknader?.length ?? 0), 0),
    },
    slipper: ut,
  };
}

// Tallene hittil i år for den ansatte: godkjente slipper med utbetaling til og med datoen
// (radtilgangen gir den ansatte bare sine egne), og tall fra et tidligere lønnssystem.
async function hittil(db: Db, org: string, ansatt: string, aar: number, tilOgMed: string) {
  const s = await en<any>(
    db,
    `select coalesce(sum(s.brutto), 0)::float8 as brutto, coalesce(sum(s.trekkpliktig), 0)::float8 as trekkpliktig,
            coalesce(sum(s.skattetrekk), 0)::float8 as skattetrekk, coalesce(sum(s.feriepengegrunnlag), 0)::float8 as feriepengegrunnlag,
            coalesce(sum(s.otp), 0)::float8 as otp
       from faktura.lonnsslipper s
      where s.org_id = $1 and s.ansatt_id = $2 and s.utbetalingsdato between make_date($3, 1, 1) and $4::date
        and not faktura.lonn_utkast(s.kjoring_id)`,
    [org, ansatt, aar, tilOgMed],
  );
  const i = await en<any>(
    db,
    "select feriepengegrunnlag::float8 as feriepengegrunnlag, trekkpliktig::float8 as trekkpliktig, forskuddstrekk::float8 as forskuddstrekk from faktura.lonn_inngaende where org_id = $1 and ansatt_id = $2 and aar = $3",
    [org, ansatt, aar],
  );
  return {
    brutto: rund(Number(s?.brutto ?? 0) + Number(i?.trekkpliktig ?? 0)),
    trekkpliktig: rund(Number(s?.trekkpliktig ?? 0) + Number(i?.trekkpliktig ?? 0)),
    skattetrekk: rund(Number(s?.skattetrekk ?? 0) + Number(i?.forskuddstrekk ?? 0)),
    feriepengegrunnlag: rund(Number(s?.feriepengegrunnlag ?? 0) + Number(i?.feriepengegrunnlag ?? 0)),
    otp: rund(Number(s?.otp ?? 0)),
  };
}

// --- Rutene -----------------------------------------------------------------------------------

const periodeS = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Velg en måned (ÅÅÅÅ-MM)");
const nyKjoring = z.object({
  periode: periodeS,
  type: z.enum(["ordinar", "ekstra"]).optional(),
  utbetalingsdato: datoS.optional(),
  feriepenger: z.boolean().optional(),
  notat: z.string().trim().max(500, "Notatet kan ha høyst 500 tegn").nullish(),
});
const endreKjoring = z.object({
  utbetalingsdato: datoS.optional(),
  feriepenger: z.boolean().optional(),
  halv_skatt: z.boolean().optional(),
  notat: z.string().trim().max(500, "Notatet kan ha høyst 500 tegn").nullish(),
});
const linjeSkjema = z.object({
  slipp_id: uuid.optional(),
  ansatt_id: uuid.optional(),
  lonnsart: z.enum(LONNSARTER.filter((l) => l.manuell).map((l) => l.kode) as [string, ...string[]], { error: "Velg lønnsart" }),
  tekst: z.string().trim().max(120, "Teksten kan ha høyst 120 tegn").nullish(),
  antall: z.number().min(-100000).max(100000).nullish(),
  sats: z.number().min(-10_000_000).max(10_000_000).nullish(),
  belop: z.number().min(-100_000_000).max(100_000_000).nullish(),
});
const endreLinje = z.object({
  tekst: z.string().trim().min(1, "Skriv en tekst").max(120, "Teksten kan ha høyst 120 tegn").optional(),
  antall: z.number().min(-100000).max(100000).nullish(),
  sats: z.number().min(-10_000_000).max(10_000_000).nullish(),
  belop: z.number().min(-100_000_000).max(100_000_000).nullish(),
});
const inngaendeSkjema = z.object({
  feriepengegrunnlag: z.number().min(0).max(100_000_000).optional(),
  feriepenger_utbetalt: z.number().min(0).max(100_000_000).optional(),
  trekkpliktig: z.number().min(0).max(100_000_000).optional(),
  forskuddstrekk: z.number().min(0).max(100_000_000).optional(),
});

// Beløpet på en linje: oppgitt, eller antall ganger sats; fortegnet etter lønnsarten (trekk er
// negative).
function belopFor(art: string, b: { antall?: number | null; sats?: number | null; belop?: number | null }) {
  const verdi = b.belop ?? (b.antall != null && b.sats != null ? rund(Number(b.antall) * Number(b.sats)) : null);
  if (verdi == null) throw new ApiFeil(400, "Skriv beløpet, eller antall og sats");
  return lonnsart(art).fortegn < 0 ? -Math.abs(verdi) : verdi;
}

export function lonnRuter() {
  const r = new Hono();
  const id = (c: Context, navn = "id") => uuid.parse(c.req.param(navn));
  const utkast = async (db: Db, org: string, kjoring: string) => {
    const k = await en<{ status: string }>(db, "select status from faktura.lonnskjoringer where org_id = $1 and id = $2", [org, kjoring]);
    if (!k) throw new ApiFeil(404, "Fant ikke lønnskjøringen");
    if (k.status !== "utkast") throw new ApiFeil(409, "Lønnskjøringen er godkjent. Åpne den igjen for å endre den.");
  };

  // Lønnsartene appen kan velge (de som kan legges til for hånd).
  r.get("/lonn/lonnsarter", (c) => c.json(LONNSARTER));

  r.get("/lonn/kjoringer", async (c) =>
    c.json(
      await bruk(c, async (db) => {
        await db.query("select faktura.krev($1, 'personal_les')", [orgId(c)]);
        return alle(
          db,
          `select k.id, to_char(k.periode, 'YYYY-MM-DD') as periode, k.type, to_char(k.utbetalingsdato, 'YYYY-MM-DD') as utbetalingsdato, k.status,
                  k.feriepenger, k.godkjent_at, count(s.id)::int as antall, coalesce(sum(s.brutto), 0)::float8 as brutto,
                  coalesce(sum(s.skattetrekk), 0)::float8 as skattetrekk, coalesce(sum(s.netto), 0)::float8 as netto, coalesce(sum(s.aga), 0)::float8 as aga,
                  coalesce(sum(cardinality(s.merknader)), 0)::int as merknader
             from faktura.lonnskjoringer k left join faktura.lonnsslipper s on s.kjoring_id = k.id
            where k.org_id = $1 group by k.id order by k.periode desc, k.type, k.opprettet desc limit 120`,
          [orgId(c)],
        );
      }),
    ),
  );

  // Ny kjøring for en måned: utbetalingsdatoen fra lønnsdagen, feriepengene i juni og halv skatt i
  // måneden valgt i oppsettet (kan endres etterpå), og slippene regnet ut med en gang.
  r.post("/lonn/kjoringer", async (c) => {
    const b = nyKjoring.parse(await c.req.json().catch(() => ({})));
    const svar = await bruk(c, async (db) => {
      await db.query("select faktura.krev($1, 'personal')", [orgId(c)]);
      const o = await hentOppsett(db, orgId(c));
      const periode = `${b.periode}-01`;
      const dato = b.utbetalingsdato ?? utbetalingsdato(periode, o.lonnsdag);
      const mnd = Number(dato.slice(5, 7));
      const type = b.type ?? "ordinar";
      if (type === "ordinar" && (await en(db, "select 1 from faktura.lonnskjoringer where org_id = $1 and periode = $2 and type = 'ordinar'", [orgId(c), periode])))
        throw new ApiFeil(409, `Det finnes alt en lønnskjøring for ${maanedNavn(periode)}. Lag en ekstra kjøring i stedet.`);
      const k = await en<{ id: string }>(
        db,
        `insert into faktura.lonnskjoringer (org_id, periode, type, utbetalingsdato, feriepenger, halv_skatt, notat)
         values ($1, $2, $3, $4, $5, $6, $7) returning id`,
        [orgId(c), periode, type, dato, b.feriepenger ?? (type === "ordinar" && Number(periode.slice(5, 7)) === 6), type === "ordinar" && mnd === (o.halv_skatt === "november" ? 11 : 12), b.notat ?? null],
      );
      await beregnKjoring(db, k!.id);
      return hentKjoring(db, orgId(c), k!.id);
    });
    return c.json(svar, 201);
  });

  r.get("/lonn/kjoringer/:id", async (c) => c.json(await bruk(c, (db) => hentKjoring(db, orgId(c), id(c)))));

  r.patch("/lonn/kjoringer/:id", async (c) => {
    const b = endreKjoring.parse(await c.req.json().catch(() => ({})));
    return c.json(
      await bruk(c, async (db) => {
        await utkast(db, orgId(c), id(c));
        const felt = Object.entries(b).filter(([, v]) => v !== undefined);
        if (felt.length)
          await db.query(`update faktura.lonnskjoringer set ${felt.map(([k], i) => `${k} = $${i + 3}`).join(", ")} where org_id = $1 and id = $2`, [
            orgId(c),
            id(c),
            ...felt.map(([, v]) => v ?? null),
          ]);
        await beregnKjoring(db, id(c));
        return hentKjoring(db, orgId(c), id(c));
      }),
    );
  });

  r.post("/lonn/kjoringer/:id/beregn", async (c) =>
    c.json(
      await bruk(c, async (db) => {
        await utkast(db, orgId(c), id(c));
        await beregnKjoring(db, id(c));
        return hentKjoring(db, orgId(c), id(c));
      }),
    ),
  );

  r.delete("/lonn/kjoringer/:id", async (c) => {
    await bruk(c, async (db) => {
      await db.query("select faktura.krev($1, 'personal')", [orgId(c)]);
      await utkast(db, orgId(c), id(c));
      await db.query("delete from faktura.lonnskjoringer where org_id = $1 and id = $2", [orgId(c), id(c)]);
    });
    return c.body(null, 204);
  });

  // Godkjenner kjøringen (regnet ut på nytt først): slipper uten linjer tas ut, timene merkes som
  // lønnet, og de ansatte med innlogging får varsel om lønnsslippen.
  r.post("/lonn/kjoringer/:id/godkjenn", async (c) => {
    const svar = await bruk(c, async (db) => {
      await utkast(db, orgId(c), id(c));
      await beregnKjoring(db, id(c));
      await db.query(
        "delete from faktura.lonnsslipper s where s.kjoring_id = $1 and not exists (select 1 from faktura.lonnslinjer l where l.slipp_id = s.id and not l.fjernet)",
        [id(c)],
      );
      await db.query("select faktura.lonn_godkjenn($1)", [id(c)]);
      const k = await hentKjoring(db, orgId(c), id(c));
      const brukere = await alle<{ bruker_id: string }>(
        db,
        "select a.bruker_id from faktura.lonnsslipper s join faktura.ansatte a on a.org_id = s.org_id and a.id = s.ansatt_id where s.kjoring_id = $1 and a.bruker_id is not null",
        [id(c)],
      );
      return { k, brukere: brukere.map((b) => b.bruker_id) };
    });
    if (svar.brukere.length)
      await leggIKo({
        type: "varsel",
        varsel: {
          hendelse: "lonn",
          org_id: orgId(c),
          bruker_ider: svar.brukere,
          tittel: "Lønnsslippen er klar",
          tekst: `Lønnsslippen for ${maanedNavn(svar.k.periode)} er klar. Lønnen utbetales ${svar.k.utbetalingsdato.split("-").reverse().join(".")}.`,
          url: "/lonn?fane=mine",
          tag: `lonn-${svar.k.id}`,
        },
      }).catch(() => undefined);
    return c.json(svar.k);
  });

  r.post("/lonn/kjoringer/:id/gjenapne", async (c) =>
    c.json(
      await bruk(c, async (db) => {
        await db.query("select faktura.lonn_gjenapne($1)", [id(c)]);
        return hentKjoring(db, orgId(c), id(c));
      }),
    ),
  );

  // En ansatt i kjøringen (f.eks. i en ekstra kjøring): slippen lages, og regnes ut.
  r.post("/lonn/kjoringer/:id/slipper", async (c) => {
    const b = z.object({ ansatt_id: uuid }).parse(await c.req.json().catch(() => ({})));
    return c.json(
      await bruk(c, async (db) => {
        await utkast(db, orgId(c), id(c));
        const a = await en<any>(db, "select id, ansattnummer, fornavn || ' ' || etternavn as navn, lonnstype, arbeidstaker from faktura.ansatte where org_id = $1 and id = $2", [orgId(c), b.ansatt_id]);
        if (!a) throw new ApiFeil(404, "Fant ikke den ansatte");
        if (!a.arbeidstaker) throw new ApiFeil(400, `${a.navn} er ikke ansatt (rollen er for dem som ikke er ansatt), og får ikke lønn.`);
        const k = await en<any>(db, "select to_char(periode, 'YYYY-MM-DD') as periode, to_char(utbetalingsdato, 'YYYY-MM-DD') as utbetalingsdato from faktura.lonnskjoringer where id = $1", [id(c)]);
        await db.query(
          `insert into faktura.lonnsslipper (org_id, kjoring_id, ansatt_id, navn, ansattnummer, lonnstype, periode, utbetalingsdato, skattetrekk_manuell)
           values ($1, $2, $3, $4, $5, $6, $7, $8, false) on conflict (kjoring_id, ansatt_id) do nothing`,
          [orgId(c), id(c), a.id, a.navn, a.ansattnummer, a.lonnstype, k.periode, k.utbetalingsdato],
        );
        // En tom slipp holdes på til den får linjer: en manuell markør (fjernet) med en nøkkel som aldri lages.
        await db.query(
          `insert into faktura.lonnslinjer (org_id, slipp_id, lonnsart, tekst, belop, kilde, nokkel, fjernet)
           select $1, s.id, 'bonus', 'Lagt til', 0, 'manuell', 'lagt_til', true from faktura.lonnsslipper s
            where s.kjoring_id = $2 and s.ansatt_id = $3
              and not exists (select 1 from faktura.lonnslinjer l where l.slipp_id = s.id and l.kilde = 'manuell')`,
          [orgId(c), id(c), a.id],
        );
        await beregnKjoring(db, id(c));
        return hentKjoring(db, orgId(c), id(c));
      }),
    );
  });

  // Skattetrekket for hånd (belop), eller tilbake til det utregnede (null).
  r.put("/lonn/kjoringer/:id/slipper/:slipp/skattetrekk", async (c) => {
    const b = z.object({ belop: z.number().min(0, "Trekket kan ikke være negativt").max(100_000_000).nullable() }).parse(await c.req.json().catch(() => ({})));
    return c.json(
      await bruk(c, async (db) => {
        await utkast(db, orgId(c), id(c));
        const res = await db.query(
          "update faktura.lonnsslipper set skattetrekk = coalesce($3, skattetrekk), skattetrekk_manuell = $3 is not null where kjoring_id = $1 and id = $2",
          [id(c), id(c, "slipp"), b.belop == null ? null : Math.floor(b.belop)],
        );
        if (!res.rowCount) throw new ApiFeil(404, "Fant ikke lønnsslippen");
        await beregnKjoring(db, id(c));
        return hentKjoring(db, orgId(c), id(c));
      }),
    );
  });

  // En linje lagt til for hånd.
  r.post("/lonn/kjoringer/:id/linjer", async (c) => {
    const b = linjeSkjema.parse(await c.req.json().catch(() => ({})));
    return c.json(
      await bruk(c, async (db) => {
        await utkast(db, orgId(c), id(c));
        let slipp = b.slipp_id
          ? await en<{ id: string }>(db, "select id from faktura.lonnsslipper where kjoring_id = $1 and id = $2", [id(c), b.slipp_id])
          : b.ansatt_id
            ? await en<{ id: string }>(db, "select id from faktura.lonnsslipper where kjoring_id = $1 and ansatt_id = $2", [id(c), b.ansatt_id])
            : undefined;
        if (!slipp && b.ansatt_id) {
          const a = await en<any>(db, "select id, ansattnummer, fornavn || ' ' || etternavn as navn, lonnstype, arbeidstaker from faktura.ansatte where org_id = $1 and id = $2", [orgId(c), b.ansatt_id]);
          if (!a) throw new ApiFeil(404, "Fant ikke den ansatte");
          if (!a.arbeidstaker) throw new ApiFeil(400, `${a.navn} er ikke ansatt, og får ikke lønn.`);
          const k = await en<any>(db, "select to_char(periode, 'YYYY-MM-DD') as periode, to_char(utbetalingsdato, 'YYYY-MM-DD') as utbetalingsdato from faktura.lonnskjoringer where id = $1", [id(c)]);
          slipp = await en<{ id: string }>(
            db,
            `insert into faktura.lonnsslipper (org_id, kjoring_id, ansatt_id, navn, ansattnummer, lonnstype, periode, utbetalingsdato)
             values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
            [orgId(c), id(c), a.id, a.navn, a.ansattnummer, a.lonnstype, k.periode, k.utbetalingsdato],
          );
        }
        if (!slipp) throw new ApiFeil(400, "Velg den ansatte linjen gjelder");
        const art = lonnsart(b.lonnsart);
        const n = await en<{ n: number }>(db, "select coalesce(max(rekkefolge), 0)::int + 100 as n from faktura.lonnslinjer where slipp_id = $1", [slipp.id]);
        await db.query(
          `insert into faktura.lonnslinjer (org_id, slipp_id, lonnsart, tekst, antall, sats, belop, kilde, rekkefolge)
           values ($1, $2, $3, $4, $5, $6, $7, 'manuell', $8)`,
          [orgId(c), slipp.id, b.lonnsart, b.tekst?.trim() || art.navn, b.antall ?? null, b.sats ?? null, belopFor(b.lonnsart, b), n?.n ?? 100],
        );
        await db.query("delete from faktura.lonnslinjer where slipp_id = $1 and nokkel = 'lagt_til' and fjernet", [slipp.id]);
        await beregnKjoring(db, id(c));
        return hentKjoring(db, orgId(c), id(c));
      }),
    );
  });

  // Endrer en linje. En utregnet linje blir manuell (og lages ikke på nytt).
  r.patch("/lonn/kjoringer/:id/linjer/:linje", async (c) => {
    const b = endreLinje.parse(await c.req.json().catch(() => ({})));
    return c.json(
      await bruk(c, async (db) => {
        await utkast(db, orgId(c), id(c));
        const l = await en<any>(
          db,
          `${LINJE} join faktura.lonnsslipper s on s.id = l.slipp_id where s.kjoring_id = $1 and l.id = $2`,
          [id(c), id(c, "linje")],
        );
        if (!l) throw new ApiFeil(404, "Fant ikke linjen");
        const antall = b.antall !== undefined ? b.antall : l.antall;
        const sats = b.sats !== undefined ? b.sats : l.sats;
        const belop = b.belop != null ? b.belop : b.antall !== undefined || b.sats !== undefined ? (antall != null && sats != null ? rund(antall * sats) : l.belop) : l.belop;
        await db.query("update faktura.lonnslinjer set tekst = $2, antall = $3, sats = $4, belop = $5, kilde = 'manuell' where id = $1", [
          l.id,
          b.tekst ?? l.tekst,
          antall,
          sats,
          lonnsart(l.lonnsart).fortegn < 0 ? -Math.abs(belop) : belop,
        ]);
        await beregnKjoring(db, id(c));
        return hentKjoring(db, orgId(c), id(c));
      }),
    );
  });

  // Fjerner en linje: en manuell slettes; en utregnet merkes som fjernet (og lages ikke på nytt).
  r.delete("/lonn/kjoringer/:id/linjer/:linje", async (c) =>
    c.json(
      await bruk(c, async (db) => {
        await utkast(db, orgId(c), id(c));
        const l = await en<any>(db, `${LINJE} join faktura.lonnsslipper s on s.id = l.slipp_id where s.kjoring_id = $1 and l.id = $2`, [id(c), id(c, "linje")]);
        if (!l) throw new ApiFeil(404, "Fant ikke linjen");
        if (l.kilde === "auto" && l.nokkel) await db.query("update faktura.lonnslinjer set kilde = 'manuell', fjernet = true where id = $1", [l.id]);
        else await db.query("delete from faktura.lonnslinjer where id = $1", [l.id]);
        await beregnKjoring(db, id(c));
        return hentKjoring(db, orgId(c), id(c));
      }),
    ),
  );

  // Angrer en endring: en endret eller fjernet utregnet linje regnes ut på nytt.
  r.post("/lonn/kjoringer/:id/linjer/:linje/tilbakestill", async (c) =>
    c.json(
      await bruk(c, async (db) => {
        await utkast(db, orgId(c), id(c));
        const res = await db.query(
          "delete from faktura.lonnslinjer l using faktura.lonnsslipper s where s.id = l.slipp_id and s.kjoring_id = $1 and l.id = $2 and l.nokkel is not null and l.kilde = 'manuell'",
          [id(c), id(c, "linje")],
        );
        if (!res.rowCount) throw new ApiFeil(404, "Fant ikke linjen");
        await beregnKjoring(db, id(c));
        return hentKjoring(db, orgId(c), id(c));
      }),
    ),
  );

  // Kjøringen som CSV (til regnskapet og nettbanken).
  r.get("/lonn/kjoringer/:id/csv", async (c) => {
    const k = await bruk(c, (db) => hentKjoring(db, orgId(c), id(c)));
    const kol: [string, string][] = [
      ["ansattnummer", "Ansattnr."],
      ["navn", "Navn"],
      ["kontonr", "Kontonummer"],
      ["brutto", "Bruttolønn"],
      ["skattetrekk", "Skattetrekk"],
      ["utgifter", "Utgiftsgodtgjørelse"],
      ["trekk_etter_skatt", "Trekk etter skatt"],
      ["netto", "Utbetales"],
      ["feriepengegrunnlag", "Feriepengegrunnlag"],
      ["feriepenger_opptjent", "Opptjente feriepenger"],
      ["otp", "OTP"],
      ["aga_grunnlag", "Grunnlag arbeidsgiveravgift"],
      ["aga", "Arbeidsgiveravgift"],
      ["trekkmetode", "Skattetrekk etter"],
    ];
    const felt = (v: unknown) => {
      const t = typeof v === "number" ? v.toFixed(2).replace(".", ",") : String(v ?? "");
      return /[;"\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
    };
    const tekst = [kol.map(([, n]) => n).join(";"), ...k.slipper.map((s: any) => kol.map(([f]) => felt(s[f])).join(";"))].join("\r\n");
    return c.body(`﻿${tekst}\r\n`, 200, {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="lonn-${k.periode.slice(0, 7)}${k.type === "ekstra" ? "-ekstra" : ""}.csv"`,
    });
  });

  // Den ansattes egne lønnsslipper (godkjente kjøringer).
  r.get("/lonn/mine", async (c) =>
    c.json(
      await bruk(c, (db) =>
        alle(
          db,
          `${SLIPP} where s.org_id = $1 and faktura.min_lonnsslipp(s.id) order by s.utbetalingsdato desc, s.periode desc limit 60`,
          [orgId(c)],
        ),
      ),
    ),
  );

  // Én lønnsslipp med linjene og tallene hittil i år (den ansatte selv, eller de som ser lønnen).
  r.get("/lonn/slipper/:id", async (c) => c.json(await bruk(c, (db) => hentSlipp(db, orgId(c), id(c)))));

  r.get("/lonn/slipper/:id/pdf", async (c) => {
    const s = await bruk(c, (db) => hentSlipp(db, orgId(c), id(c)));
    // Organisasjonen og den ansatte (adressen) på slippen; tilgangen til slippen er sjekket over.
    const info = await somSystem(async (db) => ({
      org: await en<any>(db, "select navn, orgnr, adresse, postnr, poststed, epost, telefon, farge, logo_sti from faktura.organisasjoner where id = $1", [orgId(c)]),
      ansatt: await en<any>(db, "select adresse, postnr, poststed from faktura.ansatte where org_id = $1 and id = $2", [orgId(c), s.ansatt_id]),
      oppsett: await en<any>(db, "select feriepenger_prosent::float8 as p from faktura.lonn_oppsett where org_id = $1", [orgId(c)]),
    }));
    const pdf = await lagLonnsslippPdf({
      ...s,
      feriepenger_prosent: info.oppsett?.p ?? 12,
      org: info.org,
      ansatt: info.ansatt ?? {},
      logo: await hentLogo(info.org?.logo_sti),
    });
    return c.body(Buffer.from(pdf), 200, {
      "content-type": "application/pdf",
      "content-disposition": `inline; filename="lonnsslipp-${s.periode.slice(0, 7)}-${s.ansattnummer}.pdf"`,
    });
  });

  // Tall fra et tidligere lønnssystem per år (feriepengegrunnlag, utbetalte feriepenger,
  // trekkpliktig lønn og forskuddstrekk).
  r.get("/lonn/inngaende/:ansatt", async (c) =>
    c.json(
      await bruk(c, (db) =>
        alle(
          db,
          `select aar, feriepengegrunnlag::float8 as feriepengegrunnlag, feriepenger_utbetalt::float8 as feriepenger_utbetalt,
                  trekkpliktig::float8 as trekkpliktig, forskuddstrekk::float8 as forskuddstrekk
             from faktura.lonn_inngaende where org_id = $1 and ansatt_id = $2 order by aar desc`,
          [orgId(c), id(c, "ansatt")],
        ),
      ),
    ),
  );
  r.put("/lonn/inngaende/:ansatt/:aar", async (c) => {
    const aar = z.coerce.number().int().min(2000).max(2100).parse(c.req.param("aar"));
    const b = inngaendeSkjema.parse(await c.req.json().catch(() => ({})));
    await bruk(c, async (db) => {
      await db.query(
        `insert into faktura.lonn_inngaende (org_id, ansatt_id, aar, feriepengegrunnlag, feriepenger_utbetalt, trekkpliktig, forskuddstrekk)
         values ($1, $2, $3, $4, $5, $6, $7)
         on conflict (ansatt_id, aar) do update set feriepengegrunnlag = excluded.feriepengegrunnlag, feriepenger_utbetalt = excluded.feriepenger_utbetalt,
           trekkpliktig = excluded.trekkpliktig, forskuddstrekk = excluded.forskuddstrekk`,
        [orgId(c), id(c, "ansatt"), aar, b.feriepengegrunnlag ?? 0, b.feriepenger_utbetalt ?? 0, b.trekkpliktig ?? 0, b.forskuddstrekk ?? 0],
      );
    });
    return c.body(null, 204);
  });
  r.delete("/lonn/inngaende/:ansatt/:aar", async (c) => {
    const aar = z.coerce.number().int().min(2000).max(2100).parse(c.req.param("aar"));
    await bruk(c, (db) => db.query("delete from faktura.lonn_inngaende where org_id = $1 and ansatt_id = $2 and aar = $3", [orgId(c), id(c, "ansatt"), aar]));
    return c.body(null, 204);
  });

  return r;
}

async function hentSlipp(db: Db, org: string, slippId: string) {
  const s = await en<any>(db, `${SLIPP} where s.org_id = $1 and s.id = $2`, [org, slippId]);
  if (!s) throw new ApiFeil(404, "Fant ikke lønnsslippen");
  const godkjent = !(await en<{ u: boolean }>(db, "select faktura.lonn_utkast($1) as u", [s.kjoring_id]))?.u;
  const linjer = await alle<any>(db, `${LINJE} where l.slipp_id = $1 and not l.fjernet order by l.rekkefolge, l.opprettet`, [slippId]);
  const aar = Number(s.utbetalingsdato.slice(0, 4));
  const h = await hittil(db, org, s.ansatt_id, aar, s.utbetalingsdato);
  // I et utkast er slippen selv ikke med i tallene hittil ennå.
  if (!godkjent)
    for (const f of ["brutto", "trekkpliktig", "skattetrekk", "feriepengegrunnlag", "otp"] as const) h[f] = rund(h[f] + Number(s[f] ?? 0));
  return { ...s, godkjent, linjer, hittil: h };
}

// --- Trekktabellene (plattformadministratoren) ------------------------------------------------

export function trekktabellAdminRuter() {
  const r = new Hono();
  r.get("/trekktabeller", async (c) =>
    c.json(
      await somBetrodd(c.get("bruker").id, (db) =>
        alle(db, "select aar, count(distinct tabell)::int as tabeller, count(*)::int as rader from faktura.trekktabeller group by aar order by aar desc"),
      ),
    ),
  );
  // Én bit av tabellene for et år (den første tømmer året): tabellnummer, trekkgrunnlag og trekk.
  r.post("/trekktabeller", async (c) => {
    const b = z
      .object({
        aar: z.number().int().min(2000).max(2100),
        forste: z.boolean(),
        rader: z.array(z.tuple([z.number().int().min(1000).max(9999), z.number().int().min(0).max(99_999_999), z.number().int().min(0).max(99_999_999)])).max(50_000),
      })
      .parse(await c.req.json().catch(() => ({})));
    const n = await somBetrodd(c.get("bruker").id, async (db) =>
      (await en<{ n: number }>(db, "select faktura.trekktabell_last($1, $2, $3, $4, $5) as n", [
        b.aar,
        b.forste,
        b.rader.map((x) => x[0]),
        b.rader.map((x) => x[1]),
        b.rader.map((x) => x[2]),
      ]))!.n,
    );
    return c.json({ lagret: n });
  });
  return r;
}
