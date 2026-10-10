// Konkurs og lønnsgaranti (Lønn K5): rapporten «Lønnskrav ved konkurs», grunnlaget for kravene de
// ansatte sender til bostyreren når arbeidsgiveren går konkurs (lønnsgarantiloven). For hver
// arbeidstaker (ikke frilansere og oppdragstakere): stillingen og lønnen, lønnen i perioden fra de
// godkjente lønnskjøringene (perioden er det som ikke er utbetalt, til og med fristdagen), og
// feriepengene som er opptjent i fristdagens år og året før, minus det som er utbetalt. Summen
// merkes når den er over 2 G (det garantien dekker høyst, med G på fristdagen).
import { alle, en } from "./db.js";
import { grunnbelop, rund } from "./lonnsberegning.js";
import type { Rapportdef } from "./rapportmodul.js";

const krTekst = (n: number) => `${n.toLocaleString("nb-NO", { minimumFractionDigits: 0, maximumFractionDigits: 2 }).replace(/[  ]/g, " ")} kr`;
const visDato = (d: string) => d.split("-").reverse().join(".");

export const lonnsgarantiRapporter: Rapportdef[] = [
  {
    id: "lonn.lonnsgaranti",
    modul: "lonn",
    navn: "Lønnskrav ved konkurs",
    beskrivelse:
      "Grunnlaget for de ansattes krav til lønnsgarantien når arbeidsgiveren går konkurs: lønnen i perioden (til og med fristdagen) og feriepengene som er opptjent i år og i fjor og ikke utbetalt, med 2 G-grensen.",
    funksjon: "lonn",
    tilgang: "personal_les",
    parameter: "periode",
    hent: async (db, org, v) => {
      const aar = Number(v.til.slice(0, 4));
      const sats = (await en<{ sats: number }>(db, "select coalesce((select feriepenger_prosent from faktura.lonn_oppsett where org_id = $1), 12)::float8 as sats", [org]))!.sats;
      const rader = await alle<{
        id: string;
        ansattnummer: number;
        navn: string;
        stillingsprosent: number;
        lonnstype: string;
        maanedslonn: number | null;
        timelonn: number | null;
        lonn: number;
        opptjent_fjor: number;
        opptjent_aar: number;
        utbetalt_fjor: number;
        utbetalt_aar: number;
        inn_fjor: number;
        inn_aar: number;
        inn_utbetalt_fjor: number;
        inn_utbetalt_aar: number;
      }>(
        db,
        `with slipp as (
           select s.ansatt_id,
                  sum(case when k.utbetalingsdato between $2::date and $3::date then s.brutto else 0 end) as lonn,
                  sum(case when extract(year from k.utbetalingsdato) = $4 - 1 then s.feriepenger_opptjent else 0 end) as opptjent_fjor,
                  sum(case when extract(year from k.utbetalingsdato) = $4 then s.feriepenger_opptjent else 0 end) as opptjent_aar
             from faktura.lonnsslipper s join faktura.lonnskjoringer k on k.id = s.kjoring_id
            where k.org_id = $1 and k.status = 'godkjent' and k.utbetalingsdato between make_date($4 - 1, 1, 1) and $3::date
            group by s.ansatt_id
         ), utbetalt as (
           select s.ansatt_id,
                  sum(case when l.opptjeningsaar = $4 - 1 then l.belop else 0 end) as fjor,
                  sum(case when l.opptjeningsaar = $4 then l.belop else 0 end) as aar
             from faktura.lonnslinjer l join faktura.lonnsslipper s on s.id = l.slipp_id join faktura.lonnskjoringer k on k.id = s.kjoring_id
            where k.org_id = $1 and k.status = 'godkjent' and not l.fjernet and l.lonnsart = 'feriepenger' and l.opptjeningsaar in ($4 - 1, $4)
              and k.utbetalingsdato <= $3::date
            group by s.ansatt_id
         )
         select a.id, a.ansattnummer, a.fornavn || ' ' || a.etternavn as navn, a.stillingsprosent::float8 as stillingsprosent, a.lonnstype,
                a.maanedslonn::float8 as maanedslonn, a.timelonn::float8 as timelonn,
                coalesce(slipp.lonn, 0)::float8 as lonn, coalesce(slipp.opptjent_fjor, 0)::float8 as opptjent_fjor, coalesce(slipp.opptjent_aar, 0)::float8 as opptjent_aar,
                coalesce(utbetalt.fjor, 0)::float8 as utbetalt_fjor, coalesce(utbetalt.aar, 0)::float8 as utbetalt_aar,
                coalesce(f.feriepengegrunnlag, 0)::float8 as inn_fjor, coalesce(i.feriepengegrunnlag, 0)::float8 as inn_aar,
                coalesce(f.feriepenger_utbetalt, 0)::float8 as inn_utbetalt_fjor, coalesce(i.feriepenger_utbetalt, 0)::float8 as inn_utbetalt_aar
           from faktura.ansatte a
           left join slipp on slipp.ansatt_id = a.id
           left join utbetalt on utbetalt.ansatt_id = a.id
           left join faktura.lonn_inngaende f on f.org_id = a.org_id and f.ansatt_id = a.id and f.aar = $4 - 1
           left join faktura.lonn_inngaende i on i.org_id = a.org_id and i.ansatt_id = a.id and i.aar = $4
          where a.org_id = $1 and a.arbeidstaker and a.arbeidsforhold_type <> 'frilanserOppdragstakerHonorarPersonerMm'
            and a.ansatt_fra <= $3::date and (a.ansatt_til is null or a.ansatt_til >= ($3::date - interval '12 months'))
          order by a.ansattnummer`,
        [org, v.fra, v.til, aar],
      );
      const toG = rund(2 * grunnbelop(v.til));
      return {
        kolonner: [
          { nokkel: "ansattnummer", navn: "Nr", type: "tekst" },
          { nokkel: "navn", navn: "Ansatt" },
          { nokkel: "stilling", navn: "Stilling", type: "prosent" },
          { nokkel: "lonnsats", navn: "Lønn" },
          { nokkel: "lonn", navn: "Lønn i perioden", type: "kr", sum: true },
          { nokkel: "ferie_fjor", navn: `Feriepenger ${aar - 1}`, type: "kr", sum: true },
          { nokkel: "ferie_aar", navn: `Feriepenger ${aar}`, type: "kr", sum: true },
          { nokkel: "sum", navn: "Sum krav", type: "kr", sum: true },
          { nokkel: "grense", navn: "Lønnsgarantien" },
        ],
        rader: rader.map((r) => {
          // Feriepengene til gode: opptjent (også fra et tidligere lønnssystem) minus utbetalt.
          const fjor = rund(Math.max(0, r.opptjent_fjor + (r.inn_fjor * sats) / 100 - r.utbetalt_fjor - r.inn_utbetalt_fjor));
          const iAar = rund(Math.max(0, r.opptjent_aar + (r.inn_aar * sats) / 100 - r.utbetalt_aar - r.inn_utbetalt_aar));
          const sum = rund(r.lonn + fjor + iAar);
          return {
            ansattnummer: String(r.ansattnummer),
            navn: r.navn,
            stilling: r.stillingsprosent,
            lonnsats: r.lonnstype === "time" ? `${krTekst(Number(r.timelonn ?? 0))} per time` : `${krTekst(Number(r.maanedslonn ?? 0))} per måned`,
            lonn: rund(r.lonn),
            ferie_fjor: fjor,
            ferie_aar: iAar,
            sum,
            grense: sum > toG ? `Over 2 G: dekkes med ${krTekst(toG)}` : "Innenfor 2 G",
          };
        }),
        merknad: `Fristdagen er ${visDato(v.til)} (dagen konkursbegjæringen kom inn til tingretten). Lønn i perioden: de godkjente lønnskjøringene med utbetaling ${visDato(v.fra)}–${visDato(v.til)}; ta med bare det som ikke er utbetalt. Feriepengene: opptjent i ${aar - 1} og ${aar} til og med fristdagen, minus det som er utbetalt. Lønnsgarantien dekker høyst 2 G per ansatt (${krTekst(toG)} med G på fristdagen), lønn som forfalt tidligst 12 måneder før fristdagen, og høyst én måned etter konkursåpningen. De ansatte søker på nav.no, og kravene sendes til bostyreren. Frilansere og oppdragstakere er ikke med.`,
      };
    },
  },
];
