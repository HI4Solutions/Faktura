// Rapportene for Lønn i rapportmodulen (rapportmodul.ts), fra de godkjente lønnskjøringene:
// lønnsjournalen, summene per lønnsart, lønnsbilaget (konteringen, lonnBokforing.ts), skattetrekk
// og arbeidsgiveravgift per termin med fristene, feriepengelisten, årsoversikten og OTP; og
// lønns- og stillingsendringene som gjelder fra perioden (lonnsendringer.ts).
// Journalen, lønnsartene og bilaget kan gjelde én kjøring (valget kjoring); de sendes til
// regnskapsføreren når kjøringen godkjennes, om det er slått på.
import { alle, en, type Db } from "./db.js";
import { AMELDING_NAVN, lonnsart } from "./lonnsarter.js";
import { frister, maanedNavn } from "./lonnsberegning.js";
import { hentBilag } from "./lonnBokforing.js";
import type { Rapportdef, Valg } from "./rapportmodul.js";
import { gjeldende, kjent, type Lonnsendring } from "./lonnsendringer.js";
import type { Ansatt } from "./lonnsberegning.js";

const rund = (n: number) => Math.round(n * 100) / 100;
// Rekkefølgen på beskrivelsene i a-meldingsgrunnlaget (forskuddstrekket sist).
const rekke = (navn: string) => {
  const i = Object.values(AMELDING_NAVN).indexOf(navn);
  return navn === "Forskuddstrekk" ? 1000 : i < 0 ? 999 : i;
};
const visDato = (d: string) => d.split("-").reverse().join(".");
const krTekst = (n: number) => `${n.toLocaleString("nb-NO", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).replace(/[\u00a0\u202f]/g, " ")} kr`;
// «Fastlønn, 45 000,00 kr i måneden, 80 % stilling».
const lonnTekst = (x: Pick<Ansatt, "lonnstype" | "maanedslonn" | "timelonn" | "stillingsprosent">) =>
  [
    x.lonnstype === "maaned" ? `fastlønn ${krTekst(Number(x.maanedslonn ?? 0))} i måneden` : `timelønn ${krTekst(Number(x.timelonn ?? 0))} i timen`,
    `${String(Number(x.stillingsprosent)).replace(".", ",")} % stilling`,
  ].join(", ");

// De godkjente kjøringene rapporten gjelder: én kjøring, eller de med utbetaling i perioden.
const KJORINGER = `k.org_id = $1 and k.status = 'godkjent' and (case when $4::uuid is not null then k.id = $4::uuid else k.utbetalingsdato between $2 and $3 end)`;
const parametre = (org: string, v: Valg) => [org, v.fra, v.til, v.kjoring];

// Teksten for perioden når rapporten gjelder én kjøring.
async function kjoringTekst(db: Db, org: string, v: Valg): Promise<string | undefined> {
  if (!v.kjoring) return undefined;
  const k = await en<{ periode: string; type: string; utbetalingsdato: string }>(
    db,
    "select to_char(periode, 'YYYY-MM-DD') as periode, type, to_char(utbetalingsdato, 'YYYY-MM-DD') as utbetalingsdato from faktura.lonnskjoringer where org_id = $1 and id = $2",
    [org, v.kjoring],
  );
  return k ? `${k.type === "ekstra" ? "ekstra kjøring" : "lønnskjøring"} ${maanedNavn(k.periode)}, utbetalt ${visDato(k.utbetalingsdato)}` : "ukjent kjøring";
}

export const lonnRapporter: Rapportdef[] = [
  {
    id: "lonn.journal",
    modul: "lonn",
    navn: "Lønnsjournal",
    beskrivelse: "Lønnsslippene i de godkjente kjøringene med utbetaling i perioden: brutto, trekk, netto, feriepenger, OTP og arbeidsgiveravgift.",
    funksjon: "lonn",
    tilgang: "personal_les",
    parameter: "periode",
    maanedlig: true,
    hent: async (db, org, v) => ({
      periode: await kjoringTekst(db, org, v),
      kolonner: [
        { nokkel: "utbetalt", navn: "Utbetalt", type: "dato" },
        { nokkel: "ansattnummer", navn: "Nr", type: "tekst" },
        { nokkel: "navn", navn: "Ansatt" },
        { nokkel: "brutto", navn: "Brutto", type: "kr", sum: true },
        { nokkel: "skattetrekk", navn: "Skattetrekk", type: "kr", sum: true },
        { nokkel: "trekk_etter_skatt", navn: "Trekk", type: "kr", sum: true },
        { nokkel: "utgifter", navn: "Utgifter", type: "kr", sum: true },
        { nokkel: "netto", navn: "Netto", type: "kr", sum: true },
        { nokkel: "feriepengegrunnlag", navn: "Feriep.grunnlag", type: "kr", sum: true },
        { nokkel: "feriepenger_opptjent", navn: "Feriepenger", type: "kr", sum: true },
        { nokkel: "otp", navn: "OTP", type: "kr", sum: true },
        { nokkel: "aga", navn: "AGA", type: "kr", sum: true },
      ],
      rader: await alle(
        db,
        `select to_char(k.utbetalingsdato, 'YYYY-MM-DD') as utbetalt, s.ansattnummer, s.navn, s.brutto, s.skattetrekk, s.trekk_etter_skatt, s.utgifter, s.netto,
                s.feriepengegrunnlag, s.feriepenger_opptjent, s.otp, s.aga
           from faktura.lonnsslipper s join faktura.lonnskjoringer k on k.id = s.kjoring_id
          where ${KJORINGER}
          order by k.utbetalingsdato, k.type, s.ansattnummer`,
        parametre(org, v),
      ),
    }),
  },
  {
    id: "lonn.lonnsarter",
    modul: "lonn",
    navn: "Sum per lønnsart",
    beskrivelse: "Grunnlaget for bokføringen: lønnsartene, skattetrekket, netto utbetalt, arbeidsgiveravgiften, OTP og opptjente feriepenger.",
    funksjon: "lonn",
    tilgang: "personal_les",
    parameter: "periode",
    maanedlig: true,
    hent: async (db, org, v) => {
      const arter = await alle<{ lonnsart: string; antall: number; belop: number }>(
        db,
        `select l.lonnsart, count(*)::int as antall, sum(l.belop)::float8 as belop
           from faktura.lonnslinjer l join faktura.lonnsslipper s on s.id = l.slipp_id join faktura.lonnskjoringer k on k.id = s.kjoring_id
          where ${KJORINGER} and not l.fjernet
          group by l.lonnsart order by l.lonnsart`,
        parametre(org, v),
      );
      const s = await en<Record<string, number>>(
        db,
        `select coalesce(sum(s.brutto), 0)::float8 as brutto, coalesce(sum(s.skattetrekk), 0)::float8 as skattetrekk, coalesce(sum(s.netto), 0)::float8 as netto,
                coalesce(sum(s.aga), 0)::float8 as aga, coalesce(sum(s.otp), 0)::float8 as otp, coalesce(sum(s.feriepenger_opptjent), 0)::float8 as feriepenger,
                count(*)::int as slipper
           from faktura.lonnsslipper s join faktura.lonnskjoringer k on k.id = s.kjoring_id
          where ${KJORINGER}`,
        parametre(org, v),
      );
      const gruppe = { lonn: "Lønn", utgift: "Utgift", trekk: "Trekk" } as const;
      const rader = [
        ...arter.map((a) => ({ post: lonnsart(a.lonnsart).navn, gruppe: gruppe[lonnsart(a.lonnsart).type], antall: a.antall, belop: rund(a.belop) })),
        ...(s && s.slipper
          ? [
              { post: "Bruttolønn", gruppe: "Sum", antall: s.slipper, belop: rund(s.brutto) },
              { post: "Forskuddstrekk", gruppe: "Trekk", antall: s.slipper, belop: -rund(s.skattetrekk) },
              { post: "Netto utbetalt", gruppe: "Utbetaling", antall: s.slipper, belop: rund(s.netto) },
              { post: "Arbeidsgiveravgift", gruppe: "Arbeidsgiver", antall: s.slipper, belop: rund(s.aga) },
              { post: "OTP", gruppe: "Arbeidsgiver", antall: s.slipper, belop: rund(s.otp) },
              { post: "Feriepenger opptjent", gruppe: "Avsetning", antall: s.slipper, belop: rund(s.feriepenger) },
            ]
          : []),
      ];
      return {
        periode: await kjoringTekst(db, org, v),
        kolonner: [
          { nokkel: "post", navn: "Post" },
          { nokkel: "gruppe", navn: "Gruppe" },
          { nokkel: "antall", navn: "Linjer", type: "antall" },
          { nokkel: "belop", navn: "Beløp", type: "kr" },
        ],
        rader,
      };
    },
  },
  {
    id: "lonn.bokforing",
    modul: "lonn",
    navn: "Lønnsbilag",
    beskrivelse:
      "Lønnsbilagene i HI4 Fakturas regnskap (serie L) med dato i perioden: lønn, feriepenger, trekk, nettolønn og arbeidsgiveravgift på kontoene, og bilagene som er reversert fordi kjøringen ble åpnet igjen.",
    funksjon: "lonn",
    tilgang: "personal_les",
    parameter: "periode",
    maanedlig: true,
    hent: async (db, org, v) => {
      // For én kjøring: det gjeldende bilaget; for perioden: alle bilagene (også reverseringene).
      const bilag = (await hentBilag(db, org, v.kjoring ? { kjoring: v.kjoring } : { fra: v.fra, til: v.til })).filter(
        (b) => !v.kjoring || (!b.reverserer && !b.reversert_av),
      );
      const rader = bilag.flatMap((b) =>
        b.posteringer.map((p) => ({
          bilag: b.bilagsnummer,
          dato: b.dato,
          bilagstekst: b.tekst,
          konto: p.konto,
          kontonavn: p.navn,
          tekst: p.tekst,
          debet: p.belop > 0 ? p.belop : null,
          kredit: p.belop < 0 ? -p.belop : null,
        })),
      );
      return {
        periode: await kjoringTekst(db, org, v),
        kolonner: [
          { nokkel: "bilag", navn: "Bilag", type: "tekst" },
          { nokkel: "dato", navn: "Dato", type: "dato" },
          { nokkel: "bilagstekst", navn: "Bilagstekst" },
          { nokkel: "konto", navn: "Konto", type: "tekst" },
          { nokkel: "kontonavn", navn: "Kontonavn" },
          { nokkel: "tekst", navn: "Tekst" },
          { nokkel: "debet", navn: "Debet", type: "kr", sum: true },
          { nokkel: "kredit", navn: "Kredit", type: "kr", sum: true },
        ],
        rader,
        merknad: v.kjoring && !bilag.length ? "Kjøringen er ikke bokført." : undefined,
      };
    },
  },
  {
    id: "lonn.skatt_aga",
    modul: "lonn",
    navn: "Skattetrekk og arbeidsgiveravgift",
    beskrivelse: "Kjøringene med utbetaling i terminen: skattetrekket og arbeidsgiveravgiften, med fristene for innbetaling.",
    funksjon: "lonn",
    tilgang: "personal_les",
    parameter: "termin",
    maanedlig: true,
    hent: async (db, org, v) => {
      const rader = await alle<any>(
        db,
        `select to_char(k.utbetalingsdato, 'YYYY-MM-DD') as utbetalt, to_char(k.periode, 'YYYY-MM-DD') as periode, k.type, count(s.id)::int as slipper,
                coalesce(sum(s.skattetrekk), 0)::float8 as skattetrekk, coalesce(sum(s.aga_grunnlag), 0)::float8 as aga_grunnlag, coalesce(sum(s.aga), 0)::float8 as aga
           from faktura.lonnskjoringer k left join faktura.lonnsslipper s on s.kjoring_id = k.id
          where ${KJORINGER}
          group by k.id order by k.utbetalingsdato, k.type`,
        parametre(org, v),
      );
      return {
        kolonner: [
          { nokkel: "utbetalt", navn: "Utbetalt", type: "dato" },
          { nokkel: "kjoring", navn: "Kjøring" },
          { nokkel: "slipper", navn: "Slipper", type: "antall", sum: true },
          { nokkel: "skattetrekk", navn: "Skattetrekk", type: "kr", sum: true },
          { nokkel: "frist_skattetrekk", navn: "Frist trekk", type: "dato" },
          { nokkel: "aga_grunnlag", navn: "AGA-grunnlag", type: "kr", sum: true },
          { nokkel: "aga", navn: "Arbeidsgiveravgift", type: "kr", sum: true },
          { nokkel: "frist_aga", navn: "Frist AGA", type: "dato" },
        ],
        rader: rader.map((r) => {
          const f = frister(r.utbetalt);
          return { ...r, kjoring: `${maanedNavn(r.periode)}${r.type === "ekstra" ? " (ekstra)" : ""}`, frist_skattetrekk: f.skattetrekk, frist_aga: f.aga };
        }),
      };
    },
  },
  {
    id: "lonn.amelding",
    modul: "lonn",
    navn: "A-meldingsgrunnlag",
    beskrivelse: "Lønnen per ansatt og måned etter beskrivelsen i a-meldingen, og forskuddstrekket, fra de godkjente kjøringene med utbetaling i perioden (til avstemming mot a-meldingen).",
    funksjon: "lonn",
    tilgang: "personal_les",
    parameter: "periode",
    maanedlig: true,
    hent: async (db, org, v) => {
      const linjer = await alle<{ maaned: string; ansattnummer: number; navn: string; lonnsart: string; belop: number }>(
        db,
        `select to_char(s.utbetalingsdato, 'YYYY-MM') as maaned, s.ansattnummer, s.navn, l.lonnsart, sum(l.belop)::float8 as belop
           from faktura.lonnslinjer l join faktura.lonnsslipper s on s.id = l.slipp_id join faktura.lonnskjoringer k on k.id = s.kjoring_id
          where ${KJORINGER} and not l.fjernet
          group by 1, 2, 3, 4`,
        parametre(org, v),
      );
      const trekk = await alle<{ maaned: string; ansattnummer: number; navn: string; skattetrekk: number }>(
        db,
        `select to_char(s.utbetalingsdato, 'YYYY-MM') as maaned, s.ansattnummer, s.navn, sum(round(s.skattetrekk))::float8 as skattetrekk
           from faktura.lonnsslipper s join faktura.lonnskjoringer k on k.id = s.kjoring_id
          where ${KJORINGER}
          group by 1, 2, 3`,
        parametre(org, v),
      );
      const per = new Map<string, { maaned: string; ansattnummer: number; navn: string; beskrivelse: string; belop: number | null; forskuddstrekk: number | null }>();
      for (const l of linjer) {
        const art = lonnsart(l.lonnsart);
        if (art.type !== "lonn" || !art.amelding) continue;
        const nokkel = `${l.maaned}|${l.ansattnummer}|${art.amelding}`;
        const x = per.get(nokkel) ?? { maaned: l.maaned, ansattnummer: l.ansattnummer, navn: l.navn, beskrivelse: AMELDING_NAVN[art.amelding] ?? art.amelding, belop: 0, forskuddstrekk: null };
        x.belop = rund((x.belop ?? 0) + l.belop);
        per.set(nokkel, x);
      }
      for (const t of trekk)
        if (t.skattetrekk) per.set(`${t.maaned}|${t.ansattnummer}|~trekk`, { ...t, beskrivelse: "Forskuddstrekk", belop: null, forskuddstrekk: rund(t.skattetrekk) });
      return {
        kolonner: [
          { nokkel: "maaned", navn: "Måned", type: "tekst" },
          { nokkel: "ansattnummer", navn: "Nr", type: "tekst" },
          { nokkel: "navn", navn: "Ansatt" },
          { nokkel: "beskrivelse", navn: "Beskrivelse" },
          { nokkel: "belop", navn: "Lønn", type: "kr", sum: true },
          { nokkel: "forskuddstrekk", navn: "Forskuddstrekk", type: "kr", sum: true },
        ],
        // Måned, ansatt, beskrivelsene i a-meldingens rekkefølge, og forskuddstrekket sist.
        rader: [...per.values()]
          .filter((x) => x.belop !== 0)
          .sort((a, b) => a.maaned.localeCompare(b.maaned) || a.ansattnummer - b.ansattnummer || rekke(a.beskrivelse) - rekke(b.beskrivelse))
          .map(({ maaned, ansattnummer, navn, beskrivelse, belop, forskuddstrekk }) => ({ maaned, ansattnummer, navn, beskrivelse, belop, forskuddstrekk })),
      };
    },
  },
  {
    id: "lonn.feriepenger",
    modul: "lonn",
    navn: "Feriepengeliste",
    beskrivelse: "Feriepengene opptjent i året (opptjeningsåret) per ansatt, utbetalt så langt, og det som gjenstår.",
    funksjon: "lonn",
    tilgang: "personal_les",
    parameter: "aar",
    hent: async (db, org, v) => {
      const sats = (await en<{ sats: number }>(db, "select coalesce((select feriepenger_prosent from faktura.lonn_oppsett where org_id = $1), 12)::float8 as sats", [org]))!.sats;
      const rader = await alle<any>(
        db,
        `with lonn as (
           select s.ansatt_id, sum(s.feriepengegrunnlag)::float8 as grunnlag, sum(s.feriepenger_opptjent)::float8 as opptjent
             from faktura.lonnsslipper s join faktura.lonnskjoringer k on k.id = s.kjoring_id
            where k.org_id = $1 and k.status = 'godkjent' and extract(year from k.utbetalingsdato) = $2
            group by s.ansatt_id
         ), utbetalt as (
           select s.ansatt_id, sum(l.belop)::float8 as belop
             from faktura.lonnslinjer l join faktura.lonnsslipper s on s.id = l.slipp_id join faktura.lonnskjoringer k on k.id = s.kjoring_id
            where k.org_id = $1 and k.status = 'godkjent' and not l.fjernet and l.lonnsart in ('feriepenger', 'feriepenger_60') and l.opptjeningsaar = $2
            group by s.ansatt_id
         )
         select a.ansattnummer, a.fornavn || ' ' || a.etternavn as navn, coalesce(lonn.grunnlag, 0) as grunnlag_lonn,
                coalesce(i.feriepengegrunnlag, 0)::float8 as grunnlag_tidligere, coalesce(lonn.opptjent, 0) as opptjent_lonn,
                coalesce(utbetalt.belop, 0) + coalesce(i.feriepenger_utbetalt, 0)::float8 as utbetalt
           from faktura.ansatte a
           left join lonn on lonn.ansatt_id = a.id
           left join utbetalt on utbetalt.ansatt_id = a.id
           left join faktura.lonn_inngaende i on i.org_id = a.org_id and i.ansatt_id = a.id and i.aar = $2
          where a.org_id = $1 and a.arbeidstaker and (lonn.ansatt_id is not null or utbetalt.ansatt_id is not null or i.ansatt_id is not null)
          order by a.ansattnummer`,
        [org, v.aar],
      );
      return {
        merknad: `Feriepengene av grunnlaget fra et tidligere lønnssystem er regnet med satsen i oppsettet (${String(sats).replace(".", ",")} %).`,
        kolonner: [
          { nokkel: "ansattnummer", navn: "Nr", type: "tekst" },
          { nokkel: "navn", navn: "Ansatt" },
          { nokkel: "grunnlag", navn: "Grunnlag", type: "kr", sum: true },
          { nokkel: "opptjent", navn: "Opptjent", type: "kr", sum: true },
          { nokkel: "utbetalt", navn: "Utbetalt", type: "kr", sum: true },
          { nokkel: "igjen", navn: "Igjen", type: "kr", sum: true },
        ],
        rader: rader.map((r) => {
          const opptjent = rund(r.opptjent_lonn + (r.grunnlag_tidligere * sats) / 100);
          return { ansattnummer: r.ansattnummer, navn: r.navn, grunnlag: rund(r.grunnlag_lonn + r.grunnlag_tidligere), opptjent, utbetalt: rund(r.utbetalt), igjen: rund(opptjent - r.utbetalt) };
        }),
      };
    },
  },
  {
    id: "lonn.aarsoversikt",
    modul: "lonn",
    navn: "Årsoversikt per ansatt",
    beskrivelse: "Lønn, forskuddstrekk, feriepengegrunnlag, OTP og arbeidsgiveravgift i året per ansatt (med tallene fra et tidligere lønnssystem).",
    funksjon: "lonn",
    tilgang: "personal_les",
    parameter: "aar",
    hent: async (db, org, v) => ({
      kolonner: [
        { nokkel: "ansattnummer", navn: "Nr", type: "tekst" },
        { nokkel: "navn", navn: "Ansatt" },
        { nokkel: "brutto", navn: "Brutto", type: "kr", sum: true },
        { nokkel: "trekkpliktig", navn: "Trekkpliktig", type: "kr", sum: true },
        { nokkel: "forskuddstrekk", navn: "Forskuddstrekk", type: "kr", sum: true },
        { nokkel: "feriepengegrunnlag", navn: "Feriep.grunnlag", type: "kr", sum: true },
        { nokkel: "otp", navn: "OTP", type: "kr", sum: true },
        { nokkel: "aga", navn: "AGA", type: "kr", sum: true },
      ],
      rader: await alle(
        db,
        `with lonn as (
           select s.ansatt_id, sum(s.brutto) as brutto, sum(s.trekkpliktig) as trekkpliktig, sum(s.skattetrekk) as skattetrekk,
                  sum(s.feriepengegrunnlag) as feriepengegrunnlag, sum(s.otp) as otp, sum(s.aga) as aga
             from faktura.lonnsslipper s join faktura.lonnskjoringer k on k.id = s.kjoring_id
            where k.org_id = $1 and k.status = 'godkjent' and extract(year from k.utbetalingsdato) = $2
            group by s.ansatt_id
         )
         select a.ansattnummer, a.fornavn || ' ' || a.etternavn as navn, coalesce(lonn.brutto, 0)::float8 as brutto,
                (coalesce(lonn.trekkpliktig, 0) + coalesce(i.trekkpliktig, 0))::float8 as trekkpliktig,
                (coalesce(lonn.skattetrekk, 0) + coalesce(i.forskuddstrekk, 0))::float8 as forskuddstrekk,
                (coalesce(lonn.feriepengegrunnlag, 0) + coalesce(i.feriepengegrunnlag, 0))::float8 as feriepengegrunnlag,
                coalesce(lonn.otp, 0)::float8 as otp, coalesce(lonn.aga, 0)::float8 as aga
           from faktura.ansatte a
           left join lonn on lonn.ansatt_id = a.id
           left join faktura.lonn_inngaende i on i.org_id = a.org_id and i.ansatt_id = a.id and i.aar = $2
          where a.org_id = $1 and a.arbeidstaker and (lonn.ansatt_id is not null or i.ansatt_id is not null)
          order by a.ansattnummer`,
        [org, v.aar],
      ),
    }),
  },
  {
    id: "lonn.otp",
    modul: "lonn",
    navn: "OTP",
    beskrivelse: "Grunnlaget for obligatorisk tjenestepensjon og OTP per ansatt i perioden, til pensjonsleverandøren.",
    funksjon: "lonn",
    tilgang: "personal_les",
    parameter: "periode",
    maanedlig: true,
    hent: async (db, org, v) => ({
      kolonner: [
        { nokkel: "ansattnummer", navn: "Nr", type: "tekst" },
        { nokkel: "navn", navn: "Ansatt" },
        { nokkel: "otp_grunnlag", navn: "OTP-grunnlag", type: "kr", sum: true },
        { nokkel: "otp", navn: "OTP", type: "kr", sum: true },
      ],
      rader: await alle(
        db,
        `select s.ansattnummer, s.navn, sum(s.otp_grunnlag)::float8 as otp_grunnlag, sum(s.otp)::float8 as otp
           from faktura.lonnsslipper s join faktura.lonnskjoringer k on k.id = s.kjoring_id
          where ${KJORINGER}
          group by s.ansattnummer, s.navn order by s.ansattnummer`,
        parametre(org, v),
      ),
    }),
  },
  {
    id: "lonn.endringer",
    modul: "lonn",
    navn: "Lønns- og stillingsendringer",
    beskrivelse: "Endringene i lønn og stillingsprosent som gjelder fra perioden (også nyansatte), med lønnen før og etter, grunnen og når de ble registrert.",
    funksjon: "lonn",
    tilgang: "personal_les",
    parameter: "periode",
    maanedlig: true,
    hent: async (db, org, v) => {
      const rader = await alle<Lonnsendring & { grunn: string | null; registrert: string }>(
        db,
        `select id, ansatt_id, to_char(gjelder_fra, 'YYYY-MM-DD') as gjelder_fra, lonnstype, maanedslonn::float8 as maanedslonn, timelonn::float8 as timelonn,
                stillingsprosent::float8 as stillingsprosent, grunn, to_char(opprettet at time zone 'Europe/Oslo', 'YYYY-MM-DD') as registrert,
                (extract(epoch from opprettet) * 1000)::float8 as opprettet, null::float8 as slettet
           from faktura.lonnsendringer where org_id = $1 and slettet is null order by gjelder_fra`,
        [org],
      );
      const ansatte = await alle<Ansatt>(
        db,
        `select id, ansattnummer, fornavn || ' ' || etternavn as navn, lonnstype, maanedslonn::float8 as maanedslonn, timelonn::float8 as timelonn,
                stillingsprosent::float8 as stillingsprosent from faktura.ansatte where org_id = $1`,
        [org],
      );
      const ut: Record<string, unknown>[] = [];
      for (const a of ansatte.sort((x, y) => x.ansattnummer - y.ansattnummer)) {
        const egne = kjent(rader.filter((r) => r.ansatt_id === a.id));
        egne.forEach((r, i) => {
          if (r.gjelder_fra < v.fra || r.gjelder_fra > v.til) return;
          const etter = gjeldende(a, egne, r.gjelder_fra);
          const foer = i > 0 ? gjeldende(a, egne.slice(0, i), r.gjelder_fra) : null;
          ut.push({
            gjelder_fra: r.gjelder_fra,
            ansattnummer: a.ansattnummer,
            navn: a.navn,
            foer: foer ? lonnTekst(foer) : "Ny ansatt",
            etter: lonnTekst(etter),
            grunn: (rader.find((x) => x.id === r.id)?.grunn ?? "") as string,
            registrert: rader.find((x) => x.id === r.id)?.registrert ?? null,
          });
        });
      }
      return {
        kolonner: [
          { nokkel: "gjelder_fra", navn: "Gjelder fra", type: "dato" },
          { nokkel: "ansattnummer", navn: "Nr", type: "tekst" },
          { nokkel: "navn", navn: "Ansatt" },
          { nokkel: "foer", navn: "Før" },
          { nokkel: "etter", navn: "Etter" },
          { nokkel: "grunn", navn: "Grunn" },
          { nokkel: "registrert", navn: "Registrert", type: "dato", pdf: false },
        ],
        rader: ut.sort((x, y) => String(x.gjelder_fra).localeCompare(String(y.gjelder_fra)) || Number(x.ansattnummer) - Number(y.ansattnummer)),
      };
    },
  },
];
