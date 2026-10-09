// Rapportene for Personal i rapportmodulen (rapportmodul.ts): timene per ansatt med overtid og
// merarbeid, timelisten, fraværet, sykefraværet med egenmeldingene, feriebanken, timebanken,
// ekstratimene og ansattlisten.
import { alle } from "./db.js";
import { beregnUke, uke, type Foring } from "./arbeidstid.js";
import { regler } from "./ansatte.js";
import { ekstratimer } from "./arbeidsplan.js";
import { FRAVAERTYPER, fravaerNavn } from "./fravaer.js";
import { SALDO, type Saldo } from "./timebank.js";
import type { Rapportdef } from "./rapportmodul.js";

const rund = (n: number) => Math.round(n * 100) / 100;
const kroner = new Intl.NumberFormat("nb-NO", { maximumFractionDigits: 2 });
const STATUS: Record<string, string> = { utkast: "Ikke levert", levert: "Levert", godkjent: "Godkjent", avvist: "Avvist" };

type Foringsrad = Foring & { ansatt_id: string; ansattnummer: number; navn: string; avtalt: number | null; status: string };

export const personalRapporter: Rapportdef[] = [
  {
    id: "personal.timer",
    modul: "personal",
    navn: "Timer per ansatt",
    beskrivelse: "Timene i perioden per ansatt: ordinære, overtid, merarbeid og timer uten overtid. Overtiden regnes uke for uke av timene i perioden.",
    funksjon: "ansatte",
    tilgang: "personal_les",
    parameter: "periode",
    maanedlig: true,
    hent: async (db, org, v) => {
      const r = await regler(db, org);
      const foringer = await alle<Foringsrad>(
        db,
        `select t.ansatt_id, a.ansattnummer, a.fornavn || ' ' || a.etternavn as navn, to_char(t.dato, 'YYYY-MM-DD') as dato, t.timer::float8 as timer,
                t.overtid_prosent, t.uten_overtid, t.status, (a.ukentlig_arbeidstid * a.stillingsprosent / 100)::float8 as avtalt
           from faktura.timeforinger t join faktura.ansatte a on a.org_id = t.org_id and a.id = t.ansatt_id
          where t.org_id = $1 and t.dato between $2 and $3
          order by a.ansattnummer, t.dato`,
        [org, v.fra, v.til],
      );
      const perAnsatt = new Map<string, Foringsrad[]>();
      for (const f of foringer) perAnsatt.set(f.ansatt_id, [...(perAnsatt.get(f.ansatt_id) ?? []), f]);
      const rader = [...perAnsatt.values()].map((liste) => {
        const uker = new Map<string, Foringsrad[]>();
        for (const f of liste) uker.set(uke(f.dato).fra, [...(uker.get(uke(f.dato).fra) ?? []), f]);
        const s = { ordinare: 0, overtid: 0, merarbeid: 0, uten_overtid: 0, sum: 0 };
        for (const u of uker.values()) {
          const b = beregnUke(u, r, liste[0]!.avtalt);
          s.ordinare += b.ordinare;
          s.overtid += b.overtid.reduce((x, o) => x + o.timer, 0);
          s.merarbeid += b.merarbeid;
          s.uten_overtid += b.uten_overtid;
          s.sum += b.sum;
        }
        const godkjent = liste.filter((f) => f.status === "godkjent").reduce((x, f) => x + Number(f.timer), 0);
        return {
          ansattnummer: liste[0]!.ansattnummer,
          navn: liste[0]!.navn,
          ordinare: rund(s.ordinare),
          overtid: rund(s.overtid),
          merarbeid: rund(s.merarbeid),
          uten_overtid: rund(s.uten_overtid),
          sum: rund(s.sum),
          godkjent: rund(godkjent),
          ikke_godkjent: rund(s.sum - godkjent),
        };
      });
      return {
        kolonner: [
          { nokkel: "ansattnummer", navn: "Nr", type: "tekst" },
          { nokkel: "navn", navn: "Ansatt" },
          { nokkel: "ordinare", navn: "Ordinære", type: "timer", sum: true },
          { nokkel: "overtid", navn: "Overtid", type: "timer", sum: true },
          { nokkel: "merarbeid", navn: "Merarbeid", type: "timer", sum: true },
          { nokkel: "uten_overtid", navn: "Uten overtid", type: "timer", sum: true },
          { nokkel: "sum", navn: "Sum timer", type: "timer", sum: true },
          { nokkel: "godkjent", navn: "Godkjent", type: "timer", sum: true },
          { nokkel: "ikke_godkjent", navn: "Ikke godkjent", type: "timer", sum: true },
        ],
        rader,
      };
    },
  },
  {
    id: "personal.timeliste",
    modul: "personal",
    navn: "Timeliste",
    beskrivelse: "Alle timeføringene i perioden, med type og status.",
    funksjon: "ansatte",
    tilgang: "personal_les",
    parameter: "periode",
    maanedlig: true,
    hent: async (db, org, v) => {
      const rader = await alle<any>(
        db,
        `select to_char(t.dato, 'YYYY-MM-DD') as dato, a.ansattnummer, a.fornavn || ' ' || a.etternavn as navn,
                to_char(t.fra, 'HH24:MI') as fra, to_char(t.til, 'HH24:MI') as til, t.pause_min, t.timer::float8 as timer,
                t.overtid_prosent, t.uten_overtid, t.timebank, t.status, t.beskrivelse
           from faktura.timeforinger t join faktura.ansatte a on a.org_id = t.org_id and a.id = t.ansatt_id
          where t.org_id = $1 and t.dato between $2 and $3
          order by t.dato, a.ansattnummer, t.fra nulls last`,
        [org, v.fra, v.til],
      );
      return {
        kolonner: [
          { nokkel: "dato", navn: "Dato", type: "dato" },
          { nokkel: "ansattnummer", navn: "Nr", type: "tekst" },
          { nokkel: "navn", navn: "Ansatt" },
          { nokkel: "tid", navn: "Tid" },
          { nokkel: "pause_min", navn: "Pause (min)", type: "antall" },
          { nokkel: "timer", navn: "Timer", type: "timer", sum: true },
          { nokkel: "art", navn: "Type" },
          { nokkel: "status", navn: "Status" },
          { nokkel: "beskrivelse", navn: "Beskrivelse" },
        ],
        rader: rader.map(({ timebank, ...f }) => ({
          ...f,
          tid: f.fra ? `${f.fra}–${f.til}` : "",
          art: (f.overtid_prosent ? `Overtid ${f.overtid_prosent} %` : f.uten_overtid ? "Uten overtid" : "Vanlig") + (timebank ? ", til timebanken" : ""),
          status: STATUS[f.status] ?? f.status,
        })),
      };
    },
  },
  {
    id: "personal.fravaer",
    modul: "personal",
    navn: "Fravær",
    beskrivelse: "Fraværet i perioden (sykdom, sykt barn, ferie, avspasering, permisjon med og uten lønn, kurs og annet), med kalenderdagene i perioden.",
    funksjon: "vaktplan",
    tilgang: "personal",
    parameter: "periode",
    maanedlig: true,
    hent: async (db, org, v) => {
      const rader = await alle<any>(
        db,
        `select a.ansattnummer, a.fornavn || ' ' || a.etternavn as navn, faktura.fravaer_type(f.org_id, f.ansatt_id, f.type) as type, f.betalt,
                to_char(greatest(f.fra, $2::date), 'YYYY-MM-DD') as fra, to_char(least(f.til, $3::date), 'YYYY-MM-DD') as til,
                least(f.til, $3::date) - greatest(f.fra, $2::date) + 1 as dager
           from faktura.fravaer f join faktura.ansatte a on a.org_id = f.org_id and a.id = f.ansatt_id
          where f.org_id = $1 and f.fra <= $3 and f.til >= $2
          order by a.ansattnummer, f.fra`,
        [org, v.fra, v.til],
      );
      return {
        kolonner: [
          { nokkel: "ansattnummer", navn: "Nr", type: "tekst" },
          { nokkel: "navn", navn: "Ansatt" },
          { nokkel: "type", navn: "Fravær" },
          { nokkel: "fra", navn: "Fra", type: "dato" },
          { nokkel: "til", navn: "Til", type: "dato" },
          { nokkel: "dager", navn: "Dager", type: "antall", sum: true },
        ],
        rader: rader.map(({ betalt, ...f }) => ({ ...f, type: f.type in FRAVAERTYPER ? fravaerNavn(f.type, betalt) : "Fravær" })),
      };
    },
  },
  {
    id: "personal.sykefravaer",
    modul: "personal",
    navn: "Sykefravær og egenmeldinger",
    beskrivelse:
      "Sykefraværet i perioden per ansatt: dager med egenmelding, med sykmelding (og hvor mange av dem som er gradert) og uten dokumentasjon, dager med sykt barn, og egenmeldingene i løpet av 12 måneder.",
    funksjon: "vaktplan",
    tilgang: "personal",
    parameter: "periode",
    maanedlig: true,
    hent: async (db, org, v) => ({
      merknad: "Dagene er kalenderdager i perioden. «Siste 12 mnd» er egenmeldingene for egen sykdom i 12 måneder fram til slutten av perioden.",
      kolonner: [
        { nokkel: "ansattnummer", navn: "Nr", type: "tekst" },
        { nokkel: "navn", navn: "Ansatt" },
        { nokkel: "egenmeldinger", navn: "Egenmeldinger", type: "antall", sum: true },
        { nokkel: "egenmeldt", navn: "Egenmeldt", type: "antall", sum: true },
        { nokkel: "sykmeldt", navn: "Sykmeldt", type: "antall", sum: true },
        { nokkel: "gradert", navn: "Herav gradert", type: "antall", sum: true },
        { nokkel: "udokumentert", navn: "Uten dokumentasjon", type: "antall", sum: true },
        { nokkel: "sykt_barn", navn: "Sykt barn", type: "antall", sum: true },
        { nokkel: "ganger_12", navn: "Siste 12 mnd (ganger)", type: "antall" },
        { nokkel: "dager_12", navn: "Siste 12 mnd (dager)", type: "antall" },
      ],
      rader: await alle(
        db,
        `with d as (
           select f.ansatt_id, f.type, f.dokumentasjon, f.sykmeldingsgrad, least(f.til, $3::date) - greatest(f.fra, $2::date) + 1 as dager
             from faktura.fravaer f
            where f.org_id = $1 and f.type in ('syk', 'sykt_barn') and f.fra <= $3 and f.til >= $2
         ), p as (
           select d.ansatt_id,
                  coalesce(sum(d.dager) filter (where d.type = 'syk' and d.dokumentasjon = 'egenmelding'), 0)::int as egenmeldt,
                  coalesce(sum(d.dager) filter (where d.type = 'syk' and d.dokumentasjon = 'sykmelding'), 0)::int as sykmeldt,
                  coalesce(sum(d.dager) filter (where d.type = 'syk' and d.sykmeldingsgrad is not null), 0)::int as gradert,
                  coalesce(sum(d.dager) filter (where d.type = 'syk' and d.dokumentasjon is null), 0)::int as udokumentert,
                  coalesce(sum(d.dager) filter (where d.type = 'sykt_barn'), 0)::int as sykt_barn
             from d group by d.ansatt_id
         )
         select a.ansattnummer, a.fornavn || ' ' || a.etternavn as navn,
                (select count(*) from faktura.egenmelding_tilfeller($1, a.id, 'syk') t where t.fra between $2 and $3)::int as egenmeldinger,
                p.egenmeldt, p.sykmeldt, p.gradert, p.udokumentert, p.sykt_barn, b.ganger as ganger_12, b.dager as dager_12
           from p join faktura.ansatte a on a.org_id = $1 and a.id = p.ansatt_id
           cross join lateral faktura.egenmelding_brukt($1, a.id, $3::date) b
          order by a.ansattnummer`,
        [org, v.fra, v.til],
      ),
    }),
  },
  {
    id: "personal.ferie",
    modul: "personal",
    navn: "Feriebank",
    beskrivelse: "Feriedagene hver ansatt har i året: rett, overført, avviklet, planlagt og igjen.",
    funksjon: "vaktplan",
    tilgang: "personal",
    parameter: "aar",
    hent: async (db, org, v) => ({
      kolonner: [
        { nokkel: "navn", navn: "Ansatt" },
        { nokkel: "rett", navn: "Rett", type: "tall", sum: true },
        { nokkel: "overfort_inn", navn: "Overført inn", type: "tall", sum: true },
        { nokkel: "overfort_ut", navn: "Overført ut", type: "tall", sum: true },
        { nokkel: "avviklet", navn: "Avviklet", type: "tall", sum: true },
        { nokkel: "planlagt", navn: "Planlagt", type: "tall", sum: true },
        { nokkel: "igjen", navn: "Igjen", type: "tall", sum: true },
      ],
      rader: await alle(
        db,
        `select navn, rett::float8 as rett, overfort_inn::float8 as overfort_inn, overfort_ut::float8 as overfort_ut, avviklet::float8 as avviklet,
                planlagt::float8 as planlagt, igjen::float8 as igjen
           from faktura.feriebank($1, $2)`,
        [org, v.aar],
      ),
    }),
  },
  {
    id: "personal.timebank",
    modul: "personal",
    navn: "Timebank",
    beskrivelse:
      "Timene hver ansatt har i timebanken (til avspasering): inn, avspasert, utbetalt, justert og saldoen, med verdien av saldoen (en forpliktelse i regnskapet).",
    funksjon: "ansatte",
    tilgang: "personal_les",
    parameter: "ingen",
    maanedlig: true,
    hent: async (db, org) => {
      const rader = (await alle<Saldo>(db, SALDO, [org])).filter((x) => x.saldo !== 0 || x.inn !== 0 || x.avspasert !== 0 || x.utbetalt !== 0 || x.justert !== 0);
      return {
        kolonner: [
          { nokkel: "navn", navn: "Ansatt" },
          { nokkel: "inn", navn: "Inn", type: "timer", sum: true },
          { nokkel: "avspasert", navn: "Avspasert", type: "timer", sum: true },
          { nokkel: "utbetalt", navn: "Utbetalt", type: "timer", sum: true },
          { nokkel: "justert", navn: "Justert", type: "timer", sum: true },
          { nokkel: "saldo", navn: "Saldo", type: "timer", sum: true },
          { nokkel: "dager", navn: "Dager", type: "tall" },
          { nokkel: "sats", navn: "Sats", type: "kr" },
          { nokkel: "verdi", navn: "Verdi", type: "kr", sum: true },
        ],
        rader: rader.map((x) => ({
          navn: x.navn,
          inn: x.inn,
          avspasert: x.avspasert,
          utbetalt: x.utbetalt,
          justert: x.justert,
          saldo: x.saldo,
          dager: x.dag_timer ? rund(x.saldo / x.dag_timer) : null,
          sats: x.sats,
          verdi: x.sats != null ? rund(x.saldo * x.sats) : null,
        })),
        merknad: "Verdien er saldoen ganger timelønnen (eller timesatsen for dem med fastlønn), uten feriepenger og arbeidsgiveravgift.",
      };
    },
  },
  {
    id: "personal.ekstratimer",
    modul: "personal",
    navn: "Ekstratimer",
    beskrivelse: "Timer utover den faste arbeidsplanen (eller utover avtalt arbeidstid i uka for dem uten plan).",
    funksjon: "vaktplan",
    tilgang: "personal_les",
    parameter: "periode",
    maanedlig: true,
    hent: async (db, org, v) => {
      const r = await ekstratimer(db, org, v.fra, v.til);
      return {
        kolonner: [
          { nokkel: "ansattnummer", navn: "Nr", type: "tekst" },
          { nokkel: "navn", navn: "Ansatt" },
          { nokkel: "gruppe", navn: "Rolle" },
          { nokkel: "stilling", navn: "Stilling" },
          { nokkel: "dager", navn: "Dager", type: "antall", sum: true },
          { nokkel: "timer", navn: "Ekstratimer", type: "timer", sum: true },
        ],
        rader: r.ansatte.map((a) => ({ ansattnummer: a.ansattnummer, navn: a.navn, gruppe: a.gruppe, stilling: a.stilling, dager: a.dager.length, timer: a.timer })),
      };
    },
  },
  {
    id: "personal.ansatte",
    modul: "personal",
    navn: "Ansatte",
    beskrivelse: "De aktive ansatte med stilling, arbeidstid, ansettelse og lønn.",
    funksjon: "ansatte",
    tilgang: "personal_les",
    parameter: "ingen",
    hent: async (db, org) => ({
      kolonner: [
        { nokkel: "ansattnummer", navn: "Nr", type: "tekst" },
        { nokkel: "navn", navn: "Navn" },
        { nokkel: "stilling", navn: "Stilling" },
        { nokkel: "rolle", navn: "Rolle" },
        { nokkel: "stillingsprosent", navn: "Stilling %", type: "prosent" },
        { nokkel: "ukentlig_arbeidstid", navn: "Timer/uke", type: "tall" },
        { nokkel: "ansatt_fra", navn: "Ansatt fra", type: "dato" },
        { nokkel: "ansatt_til", navn: "Til", type: "dato" },
        { nokkel: "ansettelsestype", navn: "Ansettelse" },
        { nokkel: "lonn", navn: "Lønn" },
      ],
      rader: (
        await alle<any>(
          db,
          `select a.ansattnummer, a.fornavn || ' ' || a.etternavn as navn, a.stilling, g.navn as rolle, a.stillingsprosent::float8 as stillingsprosent,
                  a.ukentlig_arbeidstid::float8 as ukentlig_arbeidstid, to_char(a.ansatt_fra, 'YYYY-MM-DD') as ansatt_fra, to_char(a.ansatt_til, 'YYYY-MM-DD') as ansatt_til,
                  case a.ansettelsestype when 'fast' then 'Fast' when 'midlertidig' then 'Midlertidig' else 'Tilkalling' end as ansettelsestype,
                  a.lonnstype, a.maanedslonn::float8 as maanedslonn, a.timelonn::float8 as timelonn
             from faktura.ansatte a left join faktura.ansattgrupper g on g.org_id = a.org_id and g.id = a.gruppe_id
            where a.org_id = $1 and a.aktiv and a.arbeidstaker
            order by a.ansattnummer`,
          [org],
        )
      ).map(({ lonnstype, maanedslonn, timelonn, ...a }) => ({
        ...a,
        lonn:
          lonnstype === "maaned" && maanedslonn != null
            ? `${kroner.format(maanedslonn)} kr/mnd`
            : lonnstype === "time" && timelonn != null
              ? `${kroner.format(timelonn)} kr/t`
              : null,
      })),
    }),
  },
];
