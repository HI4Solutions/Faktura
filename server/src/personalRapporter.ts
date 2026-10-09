// Rapportene for Personal i rapportmodulen (rapportmodul.ts): timene per ansatt med overtid og
// merarbeid, timelisten, fraværet, feriebanken, ekstratimene og ansattlisten.
import { alle } from "./db.js";
import { beregnUke, uke, type Foring } from "./arbeidstid.js";
import { regler } from "./ansatte.js";
import { ekstratimer } from "./arbeidsplan.js";
import { FRAVAERTYPER } from "./fravaer.js";
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
                t.overtid_prosent, t.uten_overtid, t.status, t.beskrivelse
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
        rader: rader.map((f) => ({
          ...f,
          tid: f.fra ? `${f.fra}–${f.til}` : "",
          art: f.overtid_prosent ? `Overtid ${f.overtid_prosent} %` : f.uten_overtid ? "Uten overtid" : "Vanlig",
          status: STATUS[f.status] ?? f.status,
        })),
      };
    },
  },
  {
    id: "personal.fravaer",
    modul: "personal",
    navn: "Fravær",
    beskrivelse: "Fraværet i perioden (sykdom, sykt barn, ferie, permisjon, kurs og annet), med kalenderdagene i perioden.",
    funksjon: "vaktplan",
    tilgang: "personal",
    parameter: "periode",
    maanedlig: true,
    hent: async (db, org, v) => {
      const rader = await alle<any>(
        db,
        `select a.ansattnummer, a.fornavn || ' ' || a.etternavn as navn, faktura.fravaer_type(f.org_id, f.ansatt_id, f.type) as type,
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
        rader: rader.map((f) => ({ ...f, type: (FRAVAERTYPER as Record<string, string>)[f.type] ?? "Fravær" })),
      };
    },
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
