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
import { bokforKjoring } from "./lonnBokforing.js";
import { fribelopBrukt as fribelopIAar } from "./afpPremier.js";
import { endringstekster, etterbetaling, fastlonnLinjer, gjeldende, kjent, ukeDato, type Etterbetalt, type GodkjentKjoring, type Lonnsendring } from "./lonnsendringer.js";
import { aktive, fagforeningslinjer, trekkEtterSkatt, type Lonnstrekk } from "./lonnstrekk.js";
import { hentBetalinger } from "./lonnBetalinger.js";
import { naturallinjer, type Naturalytelse } from "./naturalytelser.js";
import type { Reiselinje } from "./reise.js";
import {
  afpLonn,
  andelAnsatt,
  arbeidsgiverperiode,
  arbeidsgiveravgift,
  erFrilanser,
  feriepengelinjer,
  honorarArt,
  honorarTimer,
  SOM_HONORAR,
  somHonorar,
  ferietrekk,
  frister,
  maanedNavn,
  periodeSlutt,
  pluss,
  rund,
  summer,
  sykelinjer,
  tall,
  tilleggslinjer,
  timebanklinjer,
  timelinjer,
  avspasertIPerioden,
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
import { fritaksperiode, permisjonslinjer, type Permisjon } from "./permisjoner.js";
import { hentLogo } from "./dokument.js";
import { leggIKo } from "./tjenester.js";
import { lonnsrapportOppgave } from "./rapportmodul.js";
import { lagBetalingsfil, meldingId, type Format } from "./betalingsfil.js";
import { kontonrGyldig } from "./regler.js";

const uuid = z.string().uuid();
const orgId = (c: Context) => uuid.parse(c.req.param("org"));
const bruk = <T>(c: Context, fn: (db: Db) => Promise<T>) => somBruker<T>(c.get("bruker").id, fn);
const datoS = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Ugyldig dato");
// Klokka nå i norsk tid (ÅÅÅÅ-MM-DDTtt:mm:ss), til betalingsfila.
const osloTid = () =>
  new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Oslo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" })
    .format(new Date())
    .replace(" ", "T");

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
    `select l.daglig_grense, l.ukentlig_grense, l.overtid_prosent, l.ferie_dager, l.aga_sone, l.otp_prosent, l.feriepenger_prosent, l.lonnsdag, l.halv_skatt,
            l.sykepenger_refusjon, l.otp_unntak_75, l.afp, l.afp_sats::float8 as afp_sats, l.ou_premie::float8 as ou_premie
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
    otp_unntak_75: o?.otp_unntak_75 ?? false,
    afp: o?.afp ?? false,
    afp_sats: Number(o?.afp_sats ?? 2.7),
    ou_premie: Number(o?.ou_premie ?? 0),
    feriepenger_prosent: Number(o?.feriepenger_prosent ?? 12),
    lonnsdag: Number(o?.lonnsdag ?? 20),
    halv_skatt: o?.halv_skatt ?? "desember",
    sykepenger_refusjon: o?.sykepenger_refusjon ?? true,
  };
}

// --- Beregningen ------------------------------------------------------------------------------

// Dødsfall (0099): død før perioden, innen et år. Den første ordinære kjøringen etter dødsmåneden
// tar med feriepengene som ikke er utbetalt (til dødsboet), selv om den ansatte ikke har noe annet.
const dodForPerioden = (a: Ansatt, fra: string) =>
  !!a.dodsdato && a.ansatt_til === a.dodsdato && a.dodsdato < fra && a.dodsdato >= pluss(fra, -366);

const ANSATTE = `
  select a.id, a.ansattnummer, a.fornavn || ' ' || a.etternavn as navn, to_char(a.fodselsdato, 'YYYY-MM-DD') as fodselsdato,
         to_char(a.ansatt_fra, 'YYYY-MM-DD') as ansatt_fra, to_char(a.ansatt_til, 'YYYY-MM-DD') as ansatt_til, a.lonnstype,
         a.maanedslonn::float8 as maanedslonn, a.timelonn::float8 as timelonn, a.stillingsprosent::float8 as stillingsprosent,
         a.ukentlig_arbeidstid::float8 as ukentlig_arbeidstid, a.ferie_dager::float8 as ferie_dager, a.kontonr, a.skattekort,
         a.skatt_tabell, a.skatt_prosent::float8 as skatt_prosent, a.skatt_frikort::float8 as skatt_frikort, a.skattekort_aar,
         a.skattekort_resultat, a.skattekort_tillegg, a.aktiv, a.arbeidsforhold_type, a.honorar_art, to_char(a.dodsdato, 'YYYY-MM-DD') as dodsdato, a.kildeskatt
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
  // Øyeblikksbildet før grunnlaget leses (0088_lonn_automatikk.sql): det som endres etterpå, gjør
  // utkastet utdatert, så det regnes ut på nytt.
  await db.query("select faktura.lonn_beregnes($1)", [k.id]);
  const org = k.org_id;
  const fra = k.periode;
  const til = periodeSlutt(fra);
  const aar = Number(k.utbetalingsdato.slice(0, 4));
  const o = await hentOppsett(db, org);
  const ordinar = k.type === "ordinar";

  const ansatte = await alle<Ansatt & { aktiv: boolean }>(db, `${ANSATTE} where a.org_id = $1 and a.arbeidstaker order by a.ansattnummer`, [org]);
  // Faste trekk (0082, lonnstrekk.ts) i den ordinære kjøringen, og det som alt er trukket for
  // hvert av dem i godkjente kjøringer.
  const lonnstrekk = ordinar
    ? aktive(
        await alle<Lonnstrekk>(
          db,
          `select id, ansatt_id, type, tekst, belop::float8 as belop, prosent::float8 as prosent, totalt::float8 as totalt,
                  to_char(fra, 'YYYY-MM-DD') as fra, to_char(til, 'YYYY-MM-DD') as til, mottaker, kontonr, kid, melding
             from faktura.lonnstrekk where org_id = $1 and fra <= $3::date and (til is null or til >= $2::date)`,
          [org, fra, til],
        ),
        fra,
        til,
      )
    : [];
  const trukketSum = new Map(
    (lonnstrekk.length
      ? await alle<{ nokkel: string; trukket: number }>(
          db,
          `select l.nokkel, -sum(l.belop)::float8 as trukket
             from faktura.lonnslinjer l join faktura.lonnsslipper s on s.id = l.slipp_id join faktura.lonnskjoringer k on k.id = s.kjoring_id
            where l.org_id = $1 and k.status = 'godkjent' and k.id <> $2 and not l.fjernet and l.nokkel like 'trekk:%'
            group by l.nokkel`,
          [org, k.id],
        )
      : []
    ).map((x) => [x.nokkel, Number(x.trukket)]),
  );
  const trukket = (id: string) => trukketSum.get(`trekk:${id}`) ?? 0;
  // Naturalytelsene (0083) i den ordinære kjøringen, og reiseregningene som er godkjent og ikke
  // utbetalt (i hver kjøring den ansatte er med i; den første som godkjennes, betaler dem).
  const naturalytelser = ordinar
    ? await alle<Naturalytelse>(
        db,
        `select id, ansatt_id, type, tekst, belop::float8 as belop, listepris::float8 as listepris, regnr, bilpool,
                to_char(forstegangsreg, 'YYYY-MM-DD') as forstegangsreg, yrkeskjoring, laan::float8 as laan, rente::float8 as rente,
                to_char(fra, 'YYYY-MM-DD') as fra, to_char(til, 'YYYY-MM-DD') as til
           from faktura.naturalytelser where org_id = $1 and fra <= $3::date and (til is null or til >= $2::date) order by fra, opprettet`,
        [org, fra, til],
      )
    : [];
  const reiser = await alle<{ id: string; ansatt_id: string; beregning: Reiselinje[] }>(
    db,
    `select id, ansatt_id, beregning from faktura.reiseregninger
      where org_id = $1 and status = 'godkjent' and lonnskjoring_id is null order by fra, opprettet`,
    [org],
  );
  const tillegg = await alle<Tillegg & { ansatt_id: string }>(
    db,
    `select id, ansatt_id, navn, belop::float8 as belop, per, to_char(fra, 'YYYY-MM-DD') as fra, to_char(til, 'YYYY-MM-DD') as til
       from faktura.ansatt_tillegg where org_id = $1 order by opprettet, id`,
    [org],
  );
  // De godkjente timene i ukene som har timer som ikke er lønnet (uker som begynner i perioden
  // eller før), i ordinære kjøringer: hele uka, også det som er lønnet før (overtiden regnes på uka).
  const foringer = ordinar
    ? await alle<{
        id: string;
        ansatt_id: string;
        dato: string;
        timer: number;
        overtid_prosent: number | null;
        uten_overtid: boolean;
        timebank: boolean;
        lonnskjoring_id: string | null;
      }>(
        db,
        `with uker as (
           select distinct ansatt_id, date_trunc('week', dato)::date as uke from faktura.timeforinger
            where org_id = $1 and status = 'godkjent' and lonnskjoring_id is null and dato <= $2 and dato >= $3
         )
         select t.id, t.ansatt_id, to_char(t.dato, 'YYYY-MM-DD') as dato, t.timer::float8 as timer, t.overtid_prosent, t.uten_overtid, t.timebank, t.lonnskjoring_id
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
    x.alle.push({ id: f.id, dato: f.dato, timer: Number(f.timer), overtid_prosent: f.overtid_prosent, uten_overtid: f.uten_overtid, timebank: f.timebank });
    if (f.lonnskjoring_id)
      x.betalt.push({ dato: f.dato, timer: Number(f.timer), overtid_prosent: f.overtid_prosent, uten_overtid: f.uten_overtid, timebank: f.timebank });
    else x.ider.push(f.id);
  }
  // Timebanken (0073): avspasering i perioden (hele dager som fravær, og timer), og utbetalinger fra
  // banken som ikke er lønnet ennå (i ordinære kjøringer). Permisjon med lønn (0074) lønnes som
  // avspasering (betalt).
  const avspasering = ordinar
    ? await alle<{ ansatt_id: string; fra: string; til: string; timer: number; betalt: boolean }>(
        db,
        `select ansatt_id, to_char(fra, 'YYYY-MM-DD') as fra, to_char(til, 'YYYY-MM-DD') as til, timer::float8 as timer, betalt
           from faktura.fravaer where org_id = $1 and (type = 'avspasering' or betalt) and til >= $2 and fra <= $3
         union all
         select ansatt_id, to_char(dato, 'YYYY-MM-DD'), to_char(dato, 'YYYY-MM-DD'), -timer::float8, false
           from faktura.timebank_poster where org_id = $1 and type = 'avspasering' and dato between $2 and $3`,
        [org, fra, til],
      )
    : [];
  const utbetalinger = ordinar
    ? await alle<{ id: string; ansatt_id: string; timer: number }>(
        db,
        `select id, ansatt_id, -timer::float8 as timer from faktura.timebank_poster
          where org_id = $1 and type = 'utbetaling' and lonnskjoring_id is null and dato <= $2 order by dato, opprettet`,
        [org, til],
      )
    : [];
  // Sykefravær og sykt barn (for arbeidsgiverperioden og omsorgsdagene), og de planlagte timene.
  const fravaer = ordinar
    ? await alle<{ ansatt_id: string; fra: string; til: string; type: string; grad: number }>(
        db,
        `select ansatt_id, to_char(fra, 'YYYY-MM-DD') as fra, to_char(til, 'YYYY-MM-DD') as til, type, coalesce(sykmeldingsgrad, 100) as grad
           from faktura.fravaer where org_id = $1 and type in ('syk', 'sykt_barn') and til >= $2 and fra <= $3`,
        [org, `${fra.slice(0, 4)}-01-01` < pluss(fra, -90) ? `${fra.slice(0, 4)}-01-01` : pluss(fra, -90), til],
      )
    : [];
  // Permisjon uten lønn og permittering (0084): trekket i fastlønnen, og lønnsplikten ved permittering.
  const permisjoner = ordinar
    ? await alle<Permisjon>(
        db,
        `select id, ansatt_id, to_char(fra, 'YYYY-MM-DD') as fra, to_char(til, 'YYYY-MM-DD') as til, permisjon_art as art,
                coalesce(prosent, 100)::int as prosent, to_char(lonnsplikt_til, 'YYYY-MM-DD') as lonnsplikt_til
           from faktura.fravaer where org_id = $1 and type = 'permisjon' and not betalt and til >= $2 and fra <= $3`,
        [org, fra, til],
      )
    : [];
  // Fritaksperioden ved permittering (26 uker i løpet av 18 måneder): permitteringene til de samme
  // ansatte de siste 18 månedene, og dagen lønnsplikten gjelder igjen.
  const permittert = permisjoner.filter((p) => p.art === "permittering");
  if (permittert.length) {
    const tidligere = await alle<{ id: string; ansatt_id: string; fra: string; til: string; lonnsplikt_til: string | null }>(
      db,
      `select id, ansatt_id, to_char(fra, 'YYYY-MM-DD') as fra, to_char(til, 'YYYY-MM-DD') as til, to_char(lonnsplikt_til, 'YYYY-MM-DD') as lonnsplikt_til
         from faktura.fravaer
        where org_id = $1 and type = 'permisjon' and permisjon_art = 'permittering' and til >= ($2::date - interval '19 months') and fra <= $3
          and ansatt_id = any($4::uuid[])`,
      [org, fra, til, [...new Set(permittert.map((p) => p.ansatt_id))]],
    );
    for (const ansattId of new Set(permittert.map((p) => p.ansatt_id))) {
      const igjen = fritaksperiode(tidligere.filter((x) => x.ansatt_id === ansattId));
      for (const p of permittert) if (p.ansatt_id === ansattId) p.lonnsplikt_igjen = igjen.get(p.id) ?? null;
    }
  }
  const planlagt = new Map<string, number>(); // «ansatt|dato» → timer
  if (
    ordinar &&
    (fravaer.some((f) => f.til >= fra) || permittert.some((p) => (p.lonnsplikt_til && p.lonnsplikt_til >= fra) || (p.lonnsplikt_igjen && p.lonnsplikt_igjen <= til)))
  ) {
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
  // AFP (0098): den avgiftspliktige kontantlønnen i år før denne kjøringen (godkjente kjøringer),
  // regnet av linjene, så den er riktig også når AFP slås på i løpet av året.
  const afpFor = new Map<string, number>();
  if (o.afp)
    for (const r of await alle<{ ansatt_id: string; lonnsart: string; belop: number }>(
      db,
      `select s.ansatt_id, l.lonnsart, sum(l.belop)::float8 as belop
         from faktura.lonnslinjer l join faktura.lonnsslipper s on s.id = l.slipp_id join faktura.lonnskjoringer k on k.id = s.kjoring_id
        where l.org_id = $1 and k.status = 'godkjent' and k.id <> $2 and not l.fjernet and k.utbetalingsdato between $3::date and $4::date
          and s.ansatt_id = any($5)
        group by 1, 2`,
      [org, k.id, `${aar}-01-01`, `${aar}-12-31`, ider],
    ))
      if (afpLonn(r.lonnsart)) afpFor.set(r.ansatt_id, (afpFor.get(r.ansatt_id) ?? 0) + Number(r.belop));
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
  // Fribeløpet i sone 1a: den sparte avgiften i godkjente kjøringer i år, og på AFP-premiene som er
  // betalt (0098).
  const fribelopBrukt = o.aga_sone === "1a" ? await fribelopIAar(db, org, aar, k.id) : 0;

  // Lønnshistorikken (0080): lønnen og stillingen per dag, og det som var kjent da tidligere
  // kjøringer ble godkjent (etterbetaling når en endring gjelder tilbake i tid).
  const historikk = await alle<Lonnsendring>(
    db,
    `select id, ansatt_id, to_char(gjelder_fra, 'YYYY-MM-DD') as gjelder_fra, lonnstype, maanedslonn::float8 as maanedslonn, timelonn::float8 as timelonn,
            stillingsprosent::float8 as stillingsprosent, (extract(epoch from opprettet) * 1000)::float8 as opprettet,
            (extract(epoch from slettet) * 1000)::float8 as slettet
       from faktura.lonnsendringer where org_id = $1 order by gjelder_fra, opprettet`,
    [org],
  );
  const godkjente = ordinar
    ? await alle<{ id: string; periode: string; godkjent: number }>(
        db,
        `select id, to_char(periode, 'YYYY-MM-DD') as periode, (extract(epoch from godkjent_at) * 1000)::float8 as godkjent
           from faktura.lonnskjoringer
          where org_id = $1 and status = 'godkjent' and type = 'ordinar' and periode < $2::date and periode >= $2::date - interval '24 months'`,
        [org, fra],
      )
    : [];
  const sistEndret = Math.max(0, ...historikk.map((r) => Math.max(r.opprettet, r.slettet ?? 0)));
  const tilEtterbetaling = godkjente.filter((g) => g.godkjent < sistEndret);
  const kjIder = tilEtterbetaling.map((g) => g.id);
  const lonnetTimer = kjIder.length
    ? await alle<{ kjoring_id: string; ansatt_id: string; dato: string; timer: number }>(
        db,
        `select lonnskjoring_id as kjoring_id, ansatt_id, to_char(dato, 'YYYY-MM-DD') as dato, timer::float8 as timer
           from faktura.timeforinger where org_id = $1 and lonnskjoring_id = any($2::uuid[]) and not timebank`,
        [org, kjIder],
      )
    : [];
  const timelinjerFor = kjIder.length
    ? await alle<{ kjoring_id: string; ansatt_id: string; lonnsart: string; nokkel: string | null; antall: number }>(
        db,
        `select s.kjoring_id, s.ansatt_id, l.lonnsart, l.nokkel, coalesce(l.antall, 0)::float8 as antall
           from faktura.lonnslinjer l join faktura.lonnsslipper s on s.id = l.slipp_id
          where s.org_id = $1 and s.kjoring_id = any($2::uuid[]) and l.kilde = 'auto' and not l.fjernet and l.lonnsart in ('overtid', 'merarbeid', 'ekstratimer')`,
        [org, kjIder],
      )
    : [];
  const etterbetalt = kjIder.length
    ? await alle<Etterbetalt & { ansatt_id: string }>(
        db,
        `select s.kjoring_id, s.ansatt_id, l.lonnsart, to_char(l.opptjent_fra, 'YYYY-MM-DD') as opptjent_fra, l.belop::float8 as belop
           from faktura.lonnslinjer l join faktura.lonnsslipper s on s.id = l.slipp_id join faktura.lonnskjoringer k on k.id = s.kjoring_id
          where l.org_id = $1 and k.status = 'godkjent' and k.id <> $2 and not l.fjernet and l.opptjent_fra is not null
            and l.lonnsart in ('etterbetaling', 'etterbetaling_time', 'etterbetaling_overtid')`,
        [org, k.id],
      )
    : [];
  const godkjentFor = (ansattId: string, lonnstype: string): GodkjentKjoring[] =>
    tilEtterbetaling.map((g) => ({
      id: g.id,
      periode: g.periode,
      godkjent: g.godkjent,
      timer: lonnetTimer.filter((t) => t.kjoring_id === g.id && t.ansatt_id === ansattId).map(({ dato, timer }) => ({ dato, timer: Number(timer) })),
      overtid: timelinjerFor
        .filter((l) => l.kjoring_id === g.id && l.ansatt_id === ansattId && l.lonnsart === "overtid" && l.nokkel)
        .map((l) => ({
          prosent: Number(l.nokkel!.split(":")[1] ?? 0),
          antall: Number(l.antall),
          tillegg: lonnstype === "time" || l.nokkel!.startsWith("overtid_timebank"),
        })),
      merarbeid: timelinjerFor
        .filter((l) => l.kjoring_id === g.id && l.ansatt_id === ansattId && (l.lonnsart === "merarbeid" || l.lonnsart === "ekstratimer"))
        .reduce((x, l) => x + Number(l.antall), 0),
    }));

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

  type Resultat = {
    a: Ansatt;
    slipp: Slipp | undefined;
    auto: Linje[];
    manuelle: LagretLinje[];
    timeforinger: string[];
    timebankPoster: string[];
    merknader: string[];
    ouAndel: number; // andelen av en heltidsansatt måned (OU-premien, 0098)
  };
  const resultater: Resultat[] = [];
  for (const a of ansatte) {
    const slipp = slipper.find((s) => s.ansatt_id === a.id);
    const manuelle = slipp ? linjer.filter((l) => l.slipp_id === slipp.id && l.kilde === "manuell") : [];
    // Ansatt i perioden (og aktiv): fastlønn og faste tillegg per måned. Timene som er godkjent,
    // lønnes uansett.
    const ansatt = a.aktiv && andelAnsatt(a, fra, til).andel > 0;
    const ukeliste = [...(ukerPer.get(a.id)?.entries() ?? [])].filter(([, u]) => u.ider.length > 0).sort((x, y) => x[0].localeCompare(y[0]));
    const uker = ukeliste.map(([, u]) => u);
    const merknader: string[] = [];
    // Lønnen og stillingen etter historikken: ved månedsslutt (eller sluttdatoen) for det som ikke deles.
    const historie = kjent(historikk.filter((r) => r.ansatt_id === a.id));
    const aSlutt = gjeldende(a, historie, a.ansatt_til && a.ansatt_til < til ? a.ansatt_til : til);
    const auto: Linje[] = [];
    let timeforinger: string[] = [];
    let timebankPoster: string[] = [];
    // Frilanser, oppdragstaker eller styremedlem (0096): honorar i stedet for lønn (fast honorar, og
    // timene med timelønn uten overtid), og ingen sykepenger, permisjon, timebank eller ferietrekk.
    const frilanser = erFrilanser(a);
    if (ordinar) {
      if (ansatt) auto.push(...fastlonnLinjer(a, historie, fra, til).map((l) => (frilanser ? somHonorar(a, l) : l)));
      // Timene: med lønnen og stillingen som gjelder for hver uke (endres de i perioden, får hver del sin linje).
      const grupper = new Map<string, { a: Ansatt; uker: Ferieuke[] }>();
      for (const [mandag, u] of ukeliste) {
        const x = gjeldende(a, historie, ukeDato(mandag, fra));
        const nokkel = `${x.lonnstype}|${x.timelonn}|${x.maanedslonn}|${x.stillingsprosent}`;
        const g = grupper.get(nokkel) ?? { a: x, uker: [] };
        grupper.set(nokkel, g);
        g.uker.push(u);
      }
      const t = { linjer: [] as Linje[], timer: 0, ekstraTimer: 0 };
      [...grupper.values()].forEach((g, i, alle) => {
        const r = frilanser ? { ...honorarTimer(g.a, g.uker), ekstraTimer: 0 } : timelinjer(g.a, o, g.uker);
        const fraDato = i > 0 ? ukeDato(uke(g.uker[0]!.alle[0]!.dato).fra, fra) : null;
        for (const l of r.linjer)
          t.linjer.push(alle.length > 1 && fraDato ? { ...l, tekst: `${l.tekst} (fra ${fraDato.split("-").reverse().join(".")})`, nokkel: l.nokkel ? `${l.nokkel}:${fraDato}` : null } : l);
        t.timer += r.timer;
        t.ekstraTimer += r.ekstraTimer;
      });
      auto.push(...t.linjer);
      timeforinger = uker.flatMap((u) => u.ider);
      const egneTillegg = tillegg.filter((x) => x.ansatt_id === a.id && (ansatt || (x.per === "time" && a.lonnstype === "time")));
      if (frilanser) {
        // De faste tilleggene som honorar; med fast honorar gir timene ikke noe i tillegg.
        auto.push(...tilleggslinjer(aSlutt, egneTillegg, fra, til, t.timer, 0).map((l) => ({ ...l, lonnsart: honorarArt(a) })));
        if (t.timer > 0 && aSlutt.lonnstype !== "time")
          merknader.push(`${tall(t.timer)} ${t.timer === 1 ? "time" : "timer"} er ført, men med fast honorar gir timene ikke honorar i tillegg (velg timelønn for honorar per time).`);
      } else {
        // Timebanken: avspasering og permisjon med lønn (timelønn), og utbetaling; timene teller også
        // for tilleggene per time.
        const iPerioden = (betalt: boolean) =>
          a.lonnstype === "time"
            ? avspasering.filter((x) => x.ansatt_id === a.id && x.betalt === betalt).reduce((sum, x) => sum + avspasertIPerioden(x, fra, til), 0)
            : 0;
        const avspasert = iPerioden(false);
        const permisjon = iPerioden(true);
        const egneUtbetalinger = utbetalinger.filter((x) => x.ansatt_id === a.id);
        const utbetalt = egneUtbetalinger.reduce((sum, x) => sum + Number(x.timer), 0);
        auto.push(...timebanklinjer(aSlutt, avspasert, utbetalt, permisjon));
        timebankPoster = egneUtbetalinger.map((x) => x.id);
        auto.push(...tilleggslinjer(aSlutt, egneTillegg, fra, til, t.timer + avspasert + permisjon + utbetalt, t.ekstraTimer + utbetalt));
        // Sykdom: arbeidsgiverperioden, og sykt barn (omsorgsdagene i året).
        const egne = fravaer.filter((x) => x.ansatt_id === a.id);
        if (egne.length) {
          const p = arbeidsgiverperiode(egne, a.ansatt_fra);
          const dager: Sykedag[] = [];
          let omsorgBrukt = 0;
          for (const x of egne) {
            for (let d = x.fra; d <= x.til; d = pluss(d, 1)) {
              const timer = planlagt.get(`${a.id}|${d}`) ?? 0;
              if (d >= fra && d <= til) dager.push({ dato: d, timer, type: x.type as Sykedag["type"], grad: Number(x.grad) });
              else if (x.type === "sykt_barn" && d < fra && d.slice(0, 4) === fra.slice(0, 4) && virkedag(d)) omsorgBrukt++;
            }
          }
          const refusjon = o.sykepenger_refusjon !== false;
          const navDager = new Set([...p.etter, ...p.utenOpptjening]);
          const s = sykelinjer(aSlutt, dager, p.agp, omsorgBrukt, { dager: navDager, refusjon, fra, til });
          auto.push(...s.linjer);
          merknader.push(...s.merknader);
          const etter = dager.filter((d) => d.type === "syk" && p.etter.has(d.dato)).length;
          if (etter)
            merknader.push(
              refusjon
                ? `Syk ${etter} ${etter === 1 ? "dag" : "dager"} etter arbeidsgiverperioden (16 dager): lønnen betales (dere forskutterer sykepengene), og refusjonen kreves i inntektsmeldingen til NAV (Lønn → Sykepenger).`
                : `Syk ${etter} ${etter === 1 ? "dag" : "dager"} etter arbeidsgiverperioden (16 dager): NAV betaler sykepengene til den ansatte, og lønnen for de dagene er trukket.`,
            );
          const uten = dager.filter((d) => d.type === "syk" && p.utenOpptjening.has(d.dato)).length;
          if (uten)
            merknader.push(
              `Syk ${uten} ${uten === 1 ? "dag" : "dager"} før fire uker i arbeid: arbeidsgiveren har ikke plikt til å betale sykepenger da (NAV kan).${refusjon ? " Lønnen er betalt som om dere forskutterer." : ""}`,
            );
        }
        // Permisjon uten lønn og permittering: trekket i fastlønnen, og lønnen for de planlagte timene i
        // lønnspliktperioden (timelønn). Et trekk for permisjon lagt inn for hånd erstatter det som
        // regnes ut av permisjonen.
        const egnePermisjoner = permisjoner.filter((x) => x.ansatt_id === a.id);
        if (ansatt && egnePermisjoner.length) {
          const forHand = manuelle.some((m) => !m.fjernet && m.lonnsart === "trekk_permisjon" && !m.nokkel);
          const p = permisjonslinjer(a, historie, forHand ? egnePermisjoner.filter((x) => x.art === "permittering") : egnePermisjoner, fra, til, (d) => planlagt.get(`${a.id}|${d}`) ?? 0);
          auto.push(...p.linjer);
          merknader.push(...p.merknader);
          if (forHand && egnePermisjoner.some((x) => x.art !== "permittering")) merknader.push("Trekket for permisjon er lagt inn for hånd, så det regnes ikke ut av permisjonen.");
        }
        if (aSlutt.lonnstype === "maaned" && !aSlutt.maanedslonn && ansatt) merknader.push("Mangler månedslønn på den ansatte.");
      }
      if (aSlutt.lonnstype === "time" && !aSlutt.timelonn && uker.length) merknader.push("Mangler timelønn på den ansatte.");
      // Endringer i perioden, og etterbetaling (eller trekk) for tidligere måneder (som honorar for
      // en frilanser).
      merknader.push(...endringstekster(a, historie, fra, til));
      if (tilEtterbetaling.length) {
        const e = etterbetaling(
          a,
          historikk.filter((r) => r.ansatt_id === a.id),
          godkjentFor(a.id, aSlutt.lonnstype),
          etterbetalt.filter((x) => x.ansatt_id === a.id),
        );
        auto.push(...e.linjer.map((l) => (frilanser && SOM_HONORAR.has(l.lonnsart) ? { ...l, lonnsart: honorarArt(a) } : l)));
        merknader.push(...e.merknader);
      }
    }
    // Feriepenger for i fjor (vanligvis i juni), med ferietrekket for dem med fastlønn.
    if (k.feriepenger) {
      const y = aar - 1;
      const grunnlag = Number(iAar(a.id, y)?.feriepengegrunnlag ?? 0) + Number(inn(a.id, y)?.feriepengegrunnlag ?? 0);
      const utbetalt = ferieUtbetalt(a.id, y, "feriepenger") + Number(inn(a.id, y)?.feriepenger_utbetalt ?? 0);
      const fp = feriepengelinjer(a, o, y, grunnlag, utbetalt, ferieUtbetalt(a.id, y, "feriepenger_60"), k.utbetalingsdato);
      auto.push(...fp);
      if (fp.length && ordinar && ansatt && !frilanser) {
        const t = ferietrekk(aSlutt, o);
        if (t) {
          auto.push(t);
          const sum = fp.reduce((s, l) => s + l.belop, 0);
          if (-t.belop > sum) merknader.push("Trekket for ferie er større enn feriepengene (den ansatte har ikke vært ansatt hele opptjeningsåret). Sjekk antall dager.");
        }
      }
    }
    // Naturalytelsene for måneden, og reiseregningene som skal utbetales (én linje per del).
    if (ordinar && ansatt) {
      const n = naturallinjer(
        naturalytelser.filter((x) => x.ansatt_id === a.id),
        fra,
        til,
      );
      auto.push(...n.linjer);
      merknader.push(...n.merknader);
    }
    for (const x of reiser.filter((y) => y.ansatt_id === a.id))
      x.beregning.forEach((l, i) => auto.push({ lonnsart: l.lonnsart, tekst: l.tekst, antall: l.antall, sats: l.sats, belop: Number(l.belop), nokkel: `reise:${x.id}:${i}` }));
    if (!ansatt && !uker.length && !auto.length && !manuelle.length && !slipp && !(ordinar && dodForPerioden(a, fra))) continue;
    if (!ordinar && !k.feriepenger && !slipp) continue;
    // OU-premien (0098): stillingsprosenten ved månedsslutt ganger andelen av måneden den ansatte er
    // ansatt (bare i den ordinære kjøringen).
    const ouAndel = ordinar && a.aktiv ? (Number(aSlutt.stillingsprosent ?? 0) / 100) * andelAnsatt(a, fra, til).andel : 0;
    resultater.push({ a, slipp, auto, manuelle, timeforinger, timebankPoster, merknader, ouAndel });
  }

  // Sluttoppgjør: feriepengene opptjent i år (og i fjor, om de ikke er utbetalt) for den som slutter
  // i perioden.
  for (const r of resultater) {
    const a = r.a;
    // Dødsfall (0099): feriepengene som ikke er utbetalt, tas med i den første ordinære kjøringen
    // etter dødsmåneden også (innen et år), og utbetales til dødsboet.
    const dodEtter = dodForPerioden(a, fra);
    if (!ordinar || !a.ansatt_til || a.ansatt_til > til || (a.ansatt_til < fra && !dodEtter)) continue;
    const forFerie = r.auto.length;
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
    // En frilanser får ikke feriepenger (bare de som er opptjent som ansatt, om noen). Etter
    // dødsmåneden bare når det er feriepenger igjen.
    if (dodEtter) {
      if (r.auto.length > forFerie) r.merknader.push(`Døde ${a.ansatt_til.split("-").reverse().join(".")}: feriepengene som ikke er utbetalt, er tatt med (til dødsboet).`);
    } else if (!erFrilanser(a) || r.auto.some((l) => l.lonnsart === "feriepenger" || l.lonnsart === "feriepenger_60"))
      r.merknader.push(
        a.dodsdato
          ? `Døde ${a.ansatt_til.split("-").reverse().join(".")}: feriepengene er tatt med (oppgjøret til dødsboet).`
          : `Slutter ${a.ansatt_til.split("-").reverse().join(".")}: feriepengene er tatt med (sluttoppgjør).`,
      );
  }

  // Summene, skattetrekket og arbeidsgiveravgiften, og lagringen.
  const halv = k.halv_skatt;
  const beregnet = resultater.map((r) => {
    const hoppOver = new Set(r.manuelle.map((m) => m.nokkel).filter(Boolean));
    const frikortBrukt = Number(iAar(r.a.id, aar)?.trekkpliktig ?? 0) + Number(inn(r.a.id, aar)?.trekkpliktig ?? 0);
    const regn = (linjer: Linje[]) =>
      summer(
        [...linjer, ...r.manuelle],
        o,
        {
          ansatt: r.a,
          aar,
          ekstra: !ordinar,
          halvSkatt: halv,
          tabell: r.a.skattekort === "tabell" && r.a.skatt_tabell ? (tabellrader.get(Number(r.a.skatt_tabell)) ?? null) : null,
          frikortBrukt,
          // AFP: lønnen i år før kjøringen (fra et tidligere lønnssystem: den trekkpliktige lønnen).
          afpGrunnlagFor: (afpFor.get(r.a.id) ?? 0) + Number(inn(r.a.id, aar)?.trekkpliktig ?? 0),
          ouAndel: r.ouAndel,
          etterDodsfall: !!r.a.dodsdato && k.utbetalingsdato > r.a.dodsdato,
        },
        k.utbetalingsdato,
        r.slipp?.skattetrekk_manuell ? Number(r.slipp.skattetrekk) : null,
      );
    const uten = (l: Linje[]) => l.filter((x) => !x.nokkel || !hoppOver.has(x.nokkel));
    let auto = uten(r.auto);
    let s = regn(auto);
    // Faste trekk: fagforeningskontingenten (gjør grunnlaget for skattetrekket mindre), så de andre.
    // (Et trekk med en linje som er endret eller fjernet for hånd, er med slik det er der.)
    const egneTrekk = lonnstrekk.filter((t) => t.ansatt_id === r.a.id && !hoppOver.has(`trekk:${t.id}`));
    if (egneTrekk.length) {
      const f = fagforeningslinjer(egneTrekk, s.brutto, trukket);
      if (f.length) {
        auto = [...auto, ...f];
        s = regn(auto);
      }
      const t = trekkEtterSkatt(egneTrekk, s.brutto, s.netto, trukket);
      if (t.linjer.length) {
        auto = [...auto, ...t.linjer];
        s = regn(auto);
      }
      s.merknader.push(...t.merknader);
    }
    if (r.manuelle.some((m) => !m.fjernet && m.nokkel?.startsWith("reise:") && !reiser.some((x) => m.nokkel!.startsWith(`reise:${x.id}:`))))
      s.merknader.push("En linje fra en reiseregning som ikke er godkjent (eller er utbetalt), er med fordi den er endret for hånd. Angre endringen eller fjern linjen.");
    if (!r.a.kontonr && s.netto > 0) s.merknader.push("Mangler kontonummer på den ansatte.");
    return { r, auto, s };
  });
  const aga = arbeidsgiveravgift(o.aga_sone, beregnet.map((b) => b.s.aga_grunnlag), fribelopBrukt);

  const behold = new Set<string>();
  for (const [i, { r, auto, s }] of beregnet.entries()) {
    // Ingenting å lønne (og ingenting lagt til for hånd): ingen slipp.
    if (!auto.length && !r.manuelle.length && !r.slipp?.skattetrekk_manuell && !r.merknader.length) continue;
    // Reiseregningene som utbetales på slippen (en linje fra dem er med, og ikke fjernet for hånd).
    const reiseIder = [
      ...new Set(
        [...auto.map((l) => l.nokkel), ...r.manuelle.filter((m) => !m.fjernet).map((m) => m.nokkel)]
          .filter((n): n is string => !!n && n.startsWith("reise:"))
          .map((n) => n.split(":")[1]!),
      ),
    ].filter((id) => reiser.some((x) => x.id === id));
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
      // Utbetalingene fra timebanken, om linjen ikke er fjernet for hånd.
      auto.some((l) => l.nokkel === "timebank") || r.manuelle.some((m) => m.nokkel === "timebank" && !m.fjernet) ? r.timebankPoster : [],
      s.naturalytelser,
      reiseIder,
      s.afp_grunnlag,
      s.afp,
      s.ou,
      !!r.a.dodsdato && k.utbetalingsdato > r.a.dodsdato,
    ];
    let slippId = r.slipp?.id;
    if (slippId) {
      await db.query(
        `update faktura.lonnsslipper set navn = $2, ansattnummer = $3, lonnstype = $4, periode = $5, utbetalingsdato = $6, trekkmetode = $7, trekkpliktig = $8,
                trekkgrunnlag = $9, skattetrekk = $10, skattetrekk_manuell = $11, brutto = $12, utgifter = $13, trekk_etter_skatt = $14, netto = $15,
                feriepengegrunnlag = $16, feriepenger_opptjent = $17, otp_grunnlag = $18, otp = $19, aga_grunnlag = $20, aga = $21, aga_sats = $22,
                timeforinger = $23, merknader = $24, timebank_poster = $25, naturalytelser = $26, reiseregninger = $27, afp_grunnlag = $28,
                afp = $29, ou = $30, etter_dodsfall = $31
          where id = $1`,
        [slippId, ...felles],
      );
      await db.query("delete from faktura.lonnslinjer where slipp_id = $1 and kilde = 'auto'", [slippId]);
    } else {
      slippId = (await en<{ id: string }>(
        db,
        `insert into faktura.lonnsslipper (org_id, kjoring_id, ansatt_id, navn, ansattnummer, lonnstype, periode, utbetalingsdato, trekkmetode, trekkpliktig,
                trekkgrunnlag, skattetrekk, skattetrekk_manuell, brutto, utgifter, trekk_etter_skatt, netto, feriepengegrunnlag, feriepenger_opptjent,
                otp_grunnlag, otp, aga_grunnlag, aga, aga_sats, timeforinger, merknader, timebank_poster, naturalytelser, reiseregninger,
                afp_grunnlag, afp, ou, etter_dodsfall)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29,
                 $30, $31, $32, $33) returning id`,
        [org, k.id, r.a.id, ...felles],
      ))!.id;
    }
    behold.add(slippId);
    for (const [n, l] of auto.entries())
      await db.query(
        `insert into faktura.lonnslinjer (org_id, slipp_id, lonnsart, tekst, antall, sats, belop, kilde, nokkel, opptjeningsaar, rekkefolge, opptjent_fra, opptjent_til, tillegg)
         values ($1, $2, $3, $4, $5, $6, $7, 'auto', $8, $9, $10, $11, $12, $13::jsonb)`,
        [org, slippId, l.lonnsart, l.tekst, l.antall, l.sats, l.belop, l.nokkel, l.opptjeningsaar ?? null, n, l.opptjent_fra ?? null, l.opptjent_til ?? null, l.tillegg ? JSON.stringify(l.tillegg) : null],
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
         s.aga_sats::float8 as aga_sats, cardinality(s.timeforinger) as antall_timeforinger, s.merknader, s.naturalytelser::float8 as naturalytelser,
         s.afp_grunnlag::float8 as afp_grunnlag, s.afp::float8 as afp, s.ou::float8 as ou, s.etter_dodsfall
    from faktura.lonnsslipper s`;
const LINJE = `
  select l.id, l.slipp_id, l.lonnsart, l.tekst, l.antall::float8 as antall, l.sats::float8 as sats, l.belop::float8 as belop, l.kilde, l.nokkel,
         l.fjernet, l.opptjeningsaar, to_char(l.opptjent_fra, 'YYYY-MM-DD') as opptjent_fra, to_char(l.opptjent_til, 'YYYY-MM-DD') as opptjent_til
    from faktura.lonnslinjer l`;

export async function hentKjoring(db: Db, org: string, id: string) {
  const k = await en<any>(
    db,
    `select k.id, to_char(k.periode, 'YYYY-MM-DD') as periode, k.type, to_char(k.utbetalingsdato, 'YYYY-MM-DD') as utbetalingsdato, k.status,
            k.feriepenger, k.halv_skatt, k.notat, k.godkjent_at, k.opprettet,
            (select coalesce(b.navn, b.epost) from faktura.brukere b where b.id = k.godkjent_av) as godkjent_av,
            k.betalingsfil_lastet, k.betalingsfil_antall, k.forskuddstrekk_kid, k.automatisk,
            (select coalesce(b.navn, b.epost) from faktura.brukere b where b.id = k.betalingsfil_av) as betalingsfil_av,
            (select x.beregnet from faktura.lonnskjoring_beregning x where x.kjoring_id = k.id) as beregnet,
            coalesce(faktura.lonn_utdatert(k.id), false) as utdatert
       from faktura.lonnskjoringer k where k.org_id = $1 and k.id = $2`,
    [org, id],
  );
  if (!k) throw new ApiFeil(404, "Fant ikke lønnskjøringen");
  // Timene i måneden (og før) som ikke er lønnet: levert og venter på godkjenning, eller ført og
  // ikke levert. De kommer med i den ordinære kjøringen når de er godkjent.
  const timer =
    k.type === "ordinar" && k.status === "utkast"
      ? await en<{ levert: number; utkast: number }>(
          db,
          `select count(*) filter (where status = 'levert')::int as levert, count(*) filter (where status = 'utkast')::int as utkast
             from faktura.timeforinger where org_id = $1 and lonnskjoring_id is null and status in ('levert', 'utkast') and dato between $2 and $3`,
          [org, pluss(k.periode, -400), periodeSlutt(k.periode)],
        )
      : null;
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
    timer: timer ?? { levert: 0, utkast: 0 },
    aga_sone: o.aga_sone,
    otp_prosent: o.otp_prosent,
    afp: o.afp,
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
      afp: sum("afp"),
      ou: sum("ou"),
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

// Ny kjøring for en måned (ÅÅÅÅ-MM): utbetalingsdatoen fra lønnsdagen, feriepengene i juni og halv
// skatt i måneden valgt i oppsettet (kan endres etterpå), og slippene regnet ut med en gang. Brukes
// av ruten og av workeren (automatisk: den ordinære kjøringen for måneden, lonnAutomatikk.ts).
export async function lagKjoring(
  db: Db,
  org: string,
  b: { periode: string; type?: "ordinar" | "ekstra"; utbetalingsdato?: string; feriepenger?: boolean; notat?: string | null; automatisk?: boolean },
): Promise<string> {
  await db.query("select faktura.krev($1, 'personal')", [org]);
  const o = await hentOppsett(db, org);
  const periode = `${b.periode}-01`;
  const dato = b.utbetalingsdato ?? utbetalingsdato(periode, o.lonnsdag);
  const mnd = Number(dato.slice(5, 7));
  const type = b.type ?? "ordinar";
  if (type === "ordinar" && (await en(db, "select 1 from faktura.lonnskjoringer where org_id = $1 and periode = $2 and type = 'ordinar'", [org, periode])))
    throw new ApiFeil(409, `Det finnes alt en lønnskjøring for ${maanedNavn(periode)}. Lag en ekstra kjøring i stedet.`);
  const k = await en<{ id: string }>(
    db,
    `insert into faktura.lonnskjoringer (org_id, periode, type, utbetalingsdato, feriepenger, halv_skatt, notat${b.automatisk ? ", automatisk" : ""})
     values ($1, $2, $3, $4, $5, $6, $7${b.automatisk ? ", true" : ""}) returning id`,
    [org, periode, type, dato, b.feriepenger ?? (type === "ordinar" && Number(periode.slice(5, 7)) === 6), type === "ordinar" && mnd === (o.halv_skatt === "november" ? 11 : 12), b.notat ?? null],
  );
  await beregnKjoring(db, k!.id);
  return k!.id;
}

// Utkastene som er utdatert (noe i grunnlaget er endret etter at de ble regnet ut, 0088), regnes ut
// på nytt når den som ser dem, kan endre lønnen; ellers vises det som sist ble regnet ut (workeren
// tar dem hvert minutt). En feil i utregningen stopper ikke visningen.
async function oppdaterUtkast(db: Db, org: string, kjoring: string | null = null) {
  if (!(await en<{ k: boolean }>(db, "select faktura.kan($1, 'personal') as k", [org]))?.k) return;
  const ider = await alle<{ id: string }>(
    db,
    "select id from faktura.lonnskjoringer where org_id = $1 and ($2::uuid is null or id = $2) and status = 'utkast' and faktura.lonn_utdatert(id) order by periode",
    [org, kjoring],
  );
  for (const { id } of ider) {
    await db.query("savepoint omregning");
    try {
      await beregnKjoring(db, id);
      await db.query("release savepoint omregning");
    } catch (e) {
      await db.query("rollback to savepoint omregning");
      console.log(JSON.stringify({ severity: "WARNING", message: "Lønnskjøringen ble ikke regnet ut på nytt", kjoring: id, feil: (e as Error).message }));
    }
  }
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
        await oppdaterUtkast(db, orgId(c));
        return alle(
          db,
          `select k.id, to_char(k.periode, 'YYYY-MM-DD') as periode, k.type, to_char(k.utbetalingsdato, 'YYYY-MM-DD') as utbetalingsdato, k.status,
                  k.feriepenger, k.godkjent_at, k.automatisk, count(s.id)::int as antall, coalesce(sum(s.brutto), 0)::float8 as brutto,
                  coalesce(sum(s.skattetrekk), 0)::float8 as skattetrekk, coalesce(sum(s.netto), 0)::float8 as netto, coalesce(sum(s.aga), 0)::float8 as aga,
                  coalesce(sum(cardinality(s.merknader)), 0)::int as merknader
             from faktura.lonnskjoringer k left join faktura.lonnsslipper s on s.kjoring_id = k.id
            where k.org_id = $1 group by k.id order by k.periode desc, k.type, k.opprettet desc limit 120`,
          [orgId(c)],
        );
      }),
    ),
  );

  // Ny kjøring for en måned (lagKjoring).
  r.post("/lonn/kjoringer", async (c) => {
    const b = nyKjoring.parse(await c.req.json().catch(() => ({})));
    const svar = await bruk(c, async (db) => hentKjoring(db, orgId(c), await lagKjoring(db, orgId(c), b)));
    return c.json(svar, 201);
  });

  r.get("/lonn/kjoringer/:id", async (c) =>
    c.json(
      await bruk(c, async (db) => {
        await oppdaterUtkast(db, orgId(c), id(c));
        return hentKjoring(db, orgId(c), id(c));
      }),
    ),
  );

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
  // lønnet, lønnsbilaget bokføres (lonnBokforing.ts), og de ansatte med innlogging får varsel om
  // lønnsslippen.
  r.post("/lonn/kjoringer/:id/godkjenn", async (c) => {
    const svar = await bruk(c, async (db) => {
      await utkast(db, orgId(c), id(c));
      await beregnKjoring(db, id(c));
      await db.query(
        "delete from faktura.lonnsslipper s where s.kjoring_id = $1 and not exists (select 1 from faktura.lonnslinjer l where l.slipp_id = s.id and not l.fjernet)",
        [id(c)],
      );
      await db.query("select faktura.lonn_godkjenn($1)", [id(c)]);
      await bokforKjoring(db, orgId(c), id(c));
      const k = await hentKjoring(db, orgId(c), id(c));
      const brukere = await alle<{ bruker_id: string }>(
        db,
        "select a.bruker_id from faktura.lonnsslipper s join faktura.ansatte a on a.org_id = s.org_id and a.id = s.ansatt_id where s.kjoring_id = $1 and a.bruker_id is not null",
        [id(c)],
      );
      return { k, brukere: brukere.map((b) => b.bruker_id), rapporter: await lonnsrapportOppgave(db, orgId(c), id(c)) };
    });
    // Lønnsrapportene for kjøringen til regnskapsføreren, når det er slått på (Rapporter → Utsending).
    if (svar.rapporter)
      await leggIKo(svar.rapporter).catch((e) =>
        console.log(JSON.stringify({ severity: "WARNING", message: "Lønnsrapportene ble ikke sendt", feil: (e as Error).message })),
      );
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

  // Betalingsfila til nettbanken (0076, betalingsfil.ts) for en godkjent kjøring: nettolønnen til
  // hver ansatt fra lønnskontoen på utbetalingsdatoen. Kjøringen merkes med når og av hvem.
  r.post("/lonn/kjoringer/:id/betalingsfil", async (c) => {
    const f = await bruk(c, async (db) => {
      const k = await hentKjoring(db, orgId(c), id(c));
      if (k.status !== "godkjent") throw new ApiFeil(409, "Godkjenn lønnen før betalingsfila lastes ned");
      const o = await en<{ lonnskonto: string | null; bank_bic: string | null; betalingsfil_format: Format }>(
        db,
        "select lonnskonto, bank_bic, betalingsfil_format from faktura.lonn_oppsett where org_id = $1",
        [orgId(c)],
      );
      const org = await en<{ navn: string; orgnr: string | null; kontonr: string | null }>(db, "select navn, orgnr, kontonr from faktura.organisasjoner where id = $1", [
        orgId(c),
      ]);
      const fra = o?.lonnskonto ?? org?.kontonr ?? null;
      if (!fra) throw new ApiFeil(400, "Legg inn lønnskontoen (kontoen lønnen betales fra) under Innstillinger → Ansatte og timer.");
      if (!o?.bank_bic) throw new ApiFeil(400, "Legg inn BIC for banken lønnskontoen er i (står i nettbanken, f.eks. DNBANOKK for DNB) under Innstillinger → Ansatte og timer.");
      const betales = (k.slipper as any[]).filter((s) => Number(s.netto) > 0);
      if (!betales.length) throw new ApiFeil(400, "Ingen har noe til utbetaling i denne kjøringen.");
      const mangler = betales.filter((s) => !s.kontonr || !kontonrGyldig(s.kontonr));
      if (mangler.length)
        throw new ApiFeil(400, `${mangler.length === 1 ? "Mangler" : "Disse mangler"} gyldig kontonummer: ${mangler.map((s) => s.navn).join(", ")}. Legg det inn på den ansatte.`);
      // Forskuddstrekket og trekkene med mottaker og kontonummer (0082), første virkedag etter.
      const b = await hentBetalinger(db, orgId(c), k);
      const trekk = [...(b.forskuddstrekk ? [b.forskuddstrekk] : []), ...b.trekk].filter((x) => !x.mangler && x.kontonr);
      await db.query("select faktura.lonn_betalingsfil($1)", [id(c)]);
      const mid = meldingId(k.periode, k.id, new Date(k.godkjent_at).toISOString());
      return {
        navn: `lonn-${k.periode.slice(0, 7)}${k.type === "ekstra" ? "-ekstra" : ""}.xml`,
        xml: lagBetalingsfil({
          format: o.betalingsfil_format,
          meldingId: mid,
          opprettet: osloTid(),
          avsender: { navn: org!.navn, orgnr: org!.orgnr },
          fraKonto: fra,
          bic: o.bank_bic,
          dato: k.utbetalingsdato,
          tekst: `Lønn ${maanedNavn(k.periode)}`,
          betalinger: betales.map((s) => ({ navn: s.navn, kontonr: s.kontonr, belop: Number(s.netto), referanse: `${mid}-${s.ansattnummer}` })),
          trekk: trekk.length
            ? {
                dato: b.trekkdato,
                betalinger: trekk.map((x, i) => ({ navn: x.mottaker, kontonr: x.kontonr!, belop: x.belop, referanse: `${mid}-T${i + 1}`, kid: x.kid, tekst: x.tekst })),
              }
            : null,
        }),
      };
    });
    return c.body(f.xml, 200, { "content-type": "application/xml; charset=utf-8", "content-disposition": `attachment; filename="${f.navn}"` });
  });

  // Betalingene fra kjøringen (lonnBetalinger.ts): nettolønnen, forskuddstrekket og trekkene, med
  // det som mangler for at de skal være med i betalingsfila.
  r.get("/lonn/kjoringer/:id/betalinger", async (c) => c.json(await bruk(c, async (db) => hentBetalinger(db, orgId(c), await hentKjoring(db, orgId(c), id(c))))));

  // KID-en for forskuddstrekket i måneden (fra Skatteetatens KID-generator), også når kjøringen er
  // godkjent.
  r.put("/lonn/kjoringer/:id/forskuddstrekk-kid", async (c) => {
    const b = z
      .object({ kid: z.string().trim().transform((x) => x.replace(/\s/g, "")).pipe(z.string().regex(/^(\d{19})?$/, "KID-en for forskuddstrekk har 19 siffer")).nullable() })
      .parse(await c.req.json().catch(() => ({})));
    return c.json(
      await bruk(c, async (db) => {
        await db.query("select faktura.sett_forskuddstrekk_kid($1, $2)", [id(c), b.kid || null]);
        return hentBetalinger(db, orgId(c), await hentKjoring(db, orgId(c), id(c)));
      }),
    );
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
