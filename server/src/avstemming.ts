// Avstemmingen av lønnen (lønn, fase J). For hver måned: det lønnskjøringene gir i a-meldingen nå
// (de godkjente kjøringene med utbetaling i måneden: forskuddstrekket og arbeidsgiveravgiften
// regnet som i meldingen, og lønnen etter beskrivelsen), det som er rapportert i den siste
// a-meldingen som er levert for måneden (oppsummeringen som ble lagret med den), og det som er
// bokført i lønnsbilagene (kontoene for forskuddstrekk og skyldig arbeidsgiveravgift). Avvik på
// 1 kr eller mer mellom lønnen og a-meldingen (mindre er avrunding: meldingen har hele kroner), og
// på 1 øre mellom lønnen og bokføringen, vises med hva som bør gjøres.
//
// Rapportene: «Avstemming per termin» (månedene i terminen), «Årsavstemming» (året etter
// beskrivelsen i a-meldingen, forskuddstrekket, avgiften og feriepengene som er opptjent) og
// «Refusjoner fra NAV» (det som er mottatt, 0085_nav_refusjon.sql).
import { alle, en, type Db } from "./db.js";
import { frist, hentGrunnlag, oppsummer } from "./amelding.js";
import { AMELDING_NAVN } from "./lonnsarter.js";
import { hentBokforingsoppsett, kontoplan } from "./lonnBokforing.js";
import { maanedNavn } from "./lonnsberegning.js";
import { REFUSJON, REFUSJONSTYPER, type Refusjonstype } from "./navRefusjon.js";
import type { Rapportdef } from "./rapportmodul.js";

const rund = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const visDato = (d: string) => d.split("-").reverse().join(".");
const krTekst = (n: number) =>
  `${Math.abs(n).toLocaleString("nb-NO", { minimumFractionDigits: Number.isInteger(rund(n)) ? 0 : 2, maximumFractionDigits: 2 }).replace(/[  ]/g, " ")} kr`;
const osloIDag = () => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Oslo" }).format(new Date());
const STATUS: Record<string, string> = { levert: "Levert", sendt: "Sendt", mottatt: "Mottatt" };

type Tall = { forskuddstrekk: number; aga: number };
export type Maanedsdata = {
  maaned: string; // ÅÅÅÅ-MM
  frist: string;
  // Lønnskjøringene: som i a-meldingen (hele kroner) og eksakt (summen av slippene, til bokføringen).
  lonn: (Tall & { eksakt: Tall; inntekter: Record<string, number>; mottakere: number }) | null;
  amelding: (Tall & { status: string; dato: string; inntekter: Record<string, number> }) | null;
  bokfort: Tall | null;
};

// Lønnen per beskrivelse i a-meldingen fra mottakerne i en oppsummering.
function perBeskrivelse(mottakere: { inntekter?: { beskrivelse: string; belop: number }[] }[] | undefined) {
  const ut: Record<string, number> = {};
  for (const m of mottakere ?? []) for (const i of m.inntekter ?? []) ut[i.beskrivelse] = rund((ut[i.beskrivelse] ?? 0) + Number(i.belop));
  return ut;
}
const sumAv = (x: Record<string, number>) => rund(Object.values(x).reduce((s, n) => s + n, 0));

// Tallene for en måned fra databasen (som brukeren).
export async function hentMaaned(db: Db, org: string, maaned: string, kontoer: { forskuddstrekk: string; skyldig_aga: string }): Promise<Maanedsdata> {
  const g = await hentGrunnlag(db, org, maaned);
  const o = oppsummer(g);
  const lonn = g.slipper.length
    ? {
        forskuddstrekk: o.sum_forskuddstrekk,
        aga: o.arbeidsgiveravgift,
        eksakt: { forskuddstrekk: rund(g.slipper.reduce((s, x) => s + Number(x.skattetrekk), 0)), aga: rund(g.slipper.reduce((s, x) => s + Number(x.aga), 0)) },
        inntekter: perBeskrivelse(o.mottakere),
        mottakere: o.antall_med_lonn,
      }
    : null;
  const m = await en<{ status: string; dato: string; oppsummering: any }>(
    db,
    `select status, to_char(coalesce(sendt_at, opprettet) at time zone 'Europe/Oslo', 'YYYY-MM-DD') as dato, oppsummering
       from faktura.ameldinger
      where org_id = $1 and maaned = $2::date and status in ('levert', 'sendt', 'mottatt') and oppsummering is not null
      order by opprettet desc limit 1`,
    [org, `${maaned}-01`],
  );
  const amelding = m
    ? {
        status: m.status,
        dato: m.dato,
        forskuddstrekk: Number(m.oppsummering.sum_forskuddstrekk ?? 0),
        aga: Number(m.oppsummering.arbeidsgiveravgift ?? 0),
        inntekter: perBeskrivelse(m.oppsummering.mottakere),
      }
    : null;
  const b = await en<{ forskuddstrekk: number; aga: number; bilag: number }>(
    db,
    `select coalesce(sum(case when p.konto = $3 then -p.belop end), 0)::float8 as forskuddstrekk,
            coalesce(sum(case when p.konto = $4 then -p.belop end), 0)::float8 as aga, count(distinct b.id)::int as bilag
       from faktura.bilag b join faktura.posteringer p on p.org_id = b.org_id and p.bilag_id = b.id
      where b.org_id = $1 and b.kilde = 'lonn' and b.dato between $2::date and ($2::date + interval '1 month' - interval '1 day')::date`,
    [org, `${maaned}-01`, kontoer.forskuddstrekk, kontoer.skyldig_aga],
  );
  return { maaned, frist: frist(maaned), lonn, amelding, bokfort: b && b.bilag > 0 ? { forskuddstrekk: rund(b.forskuddstrekk), aga: rund(b.aga) } : null };
}

// «forskuddstrekket 1 200 kr lavere» når forskjellen er minst grensen, ellers null.
function forskjell(navn: string, a: number, l: number, grense: number) {
  const d = rund(a - l);
  return Math.abs(d) >= grense ? `${navn} ${krTekst(d)} ${d < 0 ? "lavere" : "høyere"}` : null;
}
// «a, b og c».
const liste = (x: string[]) => (x.length > 1 ? `${x.slice(0, -1).join(", ")} og ${x.at(-1)}` : (x[0] ?? ""));

// Det som ikke stemmer i måneden, med hva som bør gjøres (tom: det stemmer).
export function avvik(m: Maanedsdata, iDag = osloIDag()): string[] {
  const ut: string[] = [];
  if (m.lonn && !m.amelding)
    ut.push(iDag > m.frist ? "A-meldingen er ikke levert." : `A-meldingen er ikke levert ennå (fristen er ${visDato(m.frist)}).`);
  if (m.amelding) {
    const l = m.lonn ?? { forskuddstrekk: 0, aga: 0, inntekter: {} as Record<string, number> };
    const f = [
      forskjell("forskuddstrekket", m.amelding.forskuddstrekk, l.forskuddstrekk, 1),
      forskjell("arbeidsgiveravgiften", m.amelding.aga, l.aga, 1),
      forskjell("lønnen", sumAv(m.amelding.inntekter), sumAv(l.inntekter), 1),
    ].filter((x): x is string => !!x);
    if (f.length) ut.push(`I a-meldingen er ${liste(f)} enn i lønnskjøringene: lag en ny a-melding for måneden (den erstatter den forrige).`);
  }
  if (m.lonn) {
    if (!m.bokfort) ut.push("Lønnen er ikke bokført.");
    else {
      const f = [
        forskjell("forskuddstrekket", m.bokfort.forskuddstrekk, m.lonn.eksakt.forskuddstrekk, 0.01),
        forskjell("arbeidsgiveravgiften", m.bokfort.aga, m.lonn.eksakt.aga, 0.01),
      ].filter((x): x is string => !!x);
      if (f.length) ut.push(`Bokført er ${liste(f)} enn i lønnskjøringene: bokfør kjøringene som mangler, eller sjekk kontoene.`);
    }
  } else if (m.bokfort && (Math.abs(m.bokfort.forskuddstrekk) >= 0.01 || Math.abs(m.bokfort.aga) >= 0.01))
    ut.push("Det er bokført lønn i måneden uten godkjente lønnskjøringer.");
  return ut;
}

const maanederI = (fra: string, til: string) => {
  const ut: string[] = [];
  for (let m = fra.slice(0, 7); m <= til.slice(0, 7); ) {
    ut.push(m);
    const [a, n] = m.split("-").map(Number) as [number, number];
    m = n === 12 ? `${a + 1}-01` : `${a}-${String(n + 1).padStart(2, "0")}`;
  }
  return ut;
};
const kontoerFor = async (db: Db, org: string) => {
  const plan = kontoplan(await hentBokforingsoppsett(db, org));
  return { forskuddstrekk: plan.forskuddstrekk, skyldig_aga: plan.skyldig_aga };
};
const MND = (m: string) => {
  const n = maanedNavn(`${m}-01`);
  return n.charAt(0).toUpperCase() + n.slice(1);
};
// Rekkefølgen på beskrivelsene som i a-meldingsgrunnlaget.
const rekke = (b: string) => {
  const i = Object.keys(AMELDING_NAVN).indexOf(b);
  return i < 0 ? 999 : i;
};

export const avstemmingRapporter: Rapportdef[] = [
  {
    id: "lonn.avstemming",
    modul: "lonn",
    navn: "Avstemming per termin",
    beskrivelse:
      "Månedene i terminen: forskuddstrekket og arbeidsgiveravgiften i lønnskjøringene, i den siste a-meldingen som er levert, og i lønnsbilagene, med det som ikke stemmer og hva som bør gjøres.",
    funksjon: "lonn",
    tilgang: "personal_les",
    parameter: "termin",
    maanedlig: true,
    hent: async (db, org, v) => {
      const kontoer = await kontoerFor(db, org);
      const iDag = osloIDag();
      const rader: Record<string, unknown>[] = [];
      for (const m of maanederI(v.fra, v.til)) {
        if (`${m}-01` > iDag) continue;
        const d = await hentMaaned(db, org, m, kontoer);
        const a = avvik(d, iDag);
        rader.push({
          maaned: MND(m),
          trekk_lonn: d.lonn?.eksakt.forskuddstrekk ?? 0,
          trekk_amelding: d.amelding?.forskuddstrekk ?? null,
          trekk_bokfort: d.bokfort?.forskuddstrekk ?? null,
          aga_lonn: d.lonn?.eksakt.aga ?? 0,
          aga_amelding: d.amelding?.aga ?? null,
          aga_bokfort: d.bokfort?.aga ?? null,
          amelding: d.amelding ? `${STATUS[d.amelding.status] ?? d.amelding.status} ${visDato(d.amelding.dato)}` : d.lonn ? "Ikke levert" : "Ingen lønn",
          avvik: a.length ? a.join(" ") : d.lonn || d.amelding ? "Stemmer" : "",
        });
      }
      return {
        merknad: `Lønnskjøringene: de godkjente kjøringene med utbetaling i måneden. A-meldingen: den siste som er levert for måneden (hele kroner). Bokført: lønnsbilagene i måneden, kontoene ${kontoer.forskuddstrekk} (forskuddstrekk) og ${kontoer.skyldig_aga} (skyldig arbeidsgiveravgift). Under 1 kr mellom lønnen og a-meldingen er avrunding. Fristene for innbetaling står i rapporten «Skattetrekk og arbeidsgiveravgift».`,
        kolonner: [
          { nokkel: "maaned", navn: "Måned" },
          { nokkel: "trekk_lonn", navn: "Forskuddstrekk", type: "kr", sum: true },
          { nokkel: "trekk_amelding", navn: "I a-meldingen", type: "kr", sum: true },
          { nokkel: "trekk_bokfort", navn: "Bokført", type: "kr", sum: true },
          { nokkel: "aga_lonn", navn: "Arbeidsgiveravgift", type: "kr", sum: true },
          { nokkel: "aga_amelding", navn: "I a-meldingen", type: "kr", sum: true },
          { nokkel: "aga_bokfort", navn: "Bokført", type: "kr", sum: true },
          { nokkel: "amelding", navn: "A-meldingen" },
          { nokkel: "avvik", navn: "Avvik" },
        ],
        rader,
      };
    },
  },
  {
    id: "lonn.avstemming_aar",
    modul: "lonn",
    navn: "Årsavstemming",
    beskrivelse:
      "Året: lønnen etter beskrivelsen i a-meldingen, forskuddstrekket og arbeidsgiveravgiften i lønnskjøringene mot a-meldingene som er levert (og bokføringen), og feriepengene som er opptjent (skyldige ved årsslutt). Månedene som ikke er levert eller ikke stemmer, står under tabellen.",
    funksjon: "lonn",
    tilgang: "personal_les",
    parameter: "aar",
    hent: async (db, org, v) => {
      const kontoer = await kontoerFor(db, org);
      const iDag = osloIDag();
      const maaneder: Maanedsdata[] = [];
      for (const m of maanederI(`${v.aar}-01-01`, `${v.aar}-12-01`)) if (`${m}-01` <= iDag) maaneder.push(await hentMaaned(db, org, m, kontoer));
      const levert = maaneder.some((m) => m.amelding);
      const beskrivelser = [...new Set(maaneder.flatMap((m) => [...Object.keys(m.lonn?.inntekter ?? {}), ...Object.keys(m.amelding?.inntekter ?? {})]))].sort(
        (a, b) => rekke(a) - rekke(b) || a.localeCompare(b),
      );
      const sum = (f: (m: Maanedsdata) => number | undefined) => rund(maaneder.reduce((s, m) => s + (f(m) ?? 0), 0));
      const rad = (hva: string, lonn: number, amelding: number | null, bokfort: number | null, merknad = "") => ({
        hva,
        lonn,
        amelding,
        bokfort,
        differanse: amelding == null ? null : rund(amelding - lonn),
        merknad,
      });
      const bokfort = maaneder.some((m) => m.bokfort);
      const rader = [
        ...beskrivelser.map((b) =>
          rad(
            AMELDING_NAVN[b] ?? b,
            sum((m) => m.lonn?.inntekter[b]),
            levert ? sum((m) => m.amelding?.inntekter[b]) : null,
            null,
          ),
        ),
        rad(
          "Forskuddstrekk",
          sum((m) => m.lonn?.forskuddstrekk),
          levert ? sum((m) => m.amelding?.forskuddstrekk) : null,
          bokfort ? sum((m) => m.bokfort?.forskuddstrekk) : null,
          "Lønnen og a-meldingen i hele kroner",
        ),
        rad(
          "Arbeidsgiveravgift",
          sum((m) => m.lonn?.aga),
          levert ? sum((m) => m.amelding?.aga) : null,
          bokfort ? sum((m) => m.bokfort?.aga) : null,
          "Lønnen og a-meldingen i hele kroner",
        ),
      ];
      const ferie = await en<{ opptjent: number }>(
        db,
        `select coalesce(sum(s.feriepenger_opptjent), 0)::float8 as opptjent
           from faktura.lonnsslipper s join faktura.lonnskjoringer k on k.id = s.kjoring_id
          where s.org_id = $1 and k.status = 'godkjent' and extract(year from s.utbetalingsdato) = $2`,
        [org, v.aar],
      );
      rader.push(rad("Feriepenger opptjent i året", rund(ferie?.opptjent ?? 0), null, null, `Skyldige feriepenger ved årsslutt, utbetales i ${v.aar + 1}`));
      const ikkeLevert = maaneder.filter((m) => m.lonn && !m.amelding).map((m) => maanedNavn(`${m.maaned}-01`).split(" ")[0]);
      const medAvvik = maaneder.filter((m) => m.amelding && avvik(m, iDag).some((a) => a.startsWith("I a-meldingen"))).map((m) => maanedNavn(`${m.maaned}-01`).split(" ")[0]);
      const ikkeBokfort = maaneder.filter((m) => avvik(m, iDag).some((a) => a.startsWith("Lønnen er ikke bokført") || a.startsWith("Bokført"))).map((m) => maanedNavn(`${m.maaned}-01`).split(" ")[0]);
      const deler = [
        ikkeLevert.length ? `A-meldingen er ikke levert for ${ikkeLevert.join(", ")}.` : "",
        medAvvik.length ? `A-meldingen stemmer ikke med lønnskjøringene for ${medAvvik.join(", ")} (se «Avstemming per termin»).` : "",
        ikkeBokfort.length ? `Bokføringen stemmer ikke for ${ikkeBokfort.join(", ")}.` : "",
      ].filter(Boolean);
      return {
        merknad: deler.length ? deler.join(" ") : "Lønnskjøringene, a-meldingene og bokføringen stemmer for månedene i året.",
        kolonner: [
          { nokkel: "hva", navn: "Hva" },
          { nokkel: "lonn", navn: "Lønnskjøringene", type: "kr" },
          { nokkel: "amelding", navn: "A-meldingene", type: "kr" },
          { nokkel: "bokfort", navn: "Bokført", type: "kr" },
          { nokkel: "differanse", navn: "Differanse", type: "kr" },
          { nokkel: "merknad", navn: "Merknad" },
        ],
        rader,
      };
    },
  },
  {
    id: "lonn.nav_refusjoner",
    modul: "lonn",
    navn: "Refusjoner fra NAV",
    beskrivelse: "Refusjonene NAV har betalt i perioden (sykepenger, omsorgspenger, foreldrepenger og andre), med den ansatte, perioden de gjelder, og bilaget.",
    funksjon: "lonn",
    // Sykepenger er helseopplysninger: bare eier og administrator (som sykepengerapporten).
    tilgang: "personal",
    parameter: "periode",
    maanedlig: true,
    hent: async (db, org, v) => {
      const rader = await alle<{ dato: string; ansattnummer: number | null; ansatt_navn: string | null; type: Refusjonstype; fra: string | null; til: string | null; belop: number; bilag: string | null; tekst: string | null }>(
        db,
        `${REFUSJON} where r.org_id = $1 and r.dato between $2 and $3 order by r.dato, r.opprettet`,
        [org, v.fra, v.til],
      );
      return {
        merknad: "Refusjonen som er beregnet for sykepengene, står i rapporten «Sykepenger og refusjon».",
        kolonner: [
          { nokkel: "dato", navn: "Mottatt", type: "dato" },
          { nokkel: "ansatt", navn: "Ansatt" },
          { nokkel: "type", navn: "Gjelder" },
          { nokkel: "periode", navn: "Periode" },
          { nokkel: "belop", navn: "Beløp", type: "kr", sum: true },
          { nokkel: "bilag", navn: "Bilag" },
        ],
        rader: rader.map((r) => ({
          dato: r.dato,
          ansatt: r.ansatt_navn ? `${r.ansatt_navn} (${r.ansattnummer})` : "",
          type: `${REFUSJONSTYPER[r.type]}${r.tekst ? ` – ${r.tekst}` : ""}`,
          periode: r.fra && r.til ? `${visDato(r.fra)}–${visDato(r.til)}` : "",
          belop: rund(r.belop),
          bilag: r.bilag ?? "",
        })),
      };
    },
  },
];
