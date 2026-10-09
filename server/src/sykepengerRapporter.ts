// Sykepengene i rapportmodulen (rapportmodul.ts, del av Lønn): sykefraværet i perioden per ansatt
// fordelt på arbeidsgiverperioden (arbeidsgiveren betaler) og dagene etter (NAV), gradert
// sykmelding, og inntektsmeldingen med refusjonskravet til NAV og det refusjonen er beregnet til
// for perioden (for regnskapet: krav på refusjon av sykepenger), og refusjonene for sykepenger
// som er mottatt fra NAV i perioden (0085_nav_refusjon.sql). Helseopplysninger: bare eier og
// administrator (og regnskapsføreren når de sendes).
import { alle, type Db } from "./db.js";
import { arbeidsgiverperiode, grunnbelop, pluss, rund, virkedag } from "./lonnsberegning.js";
import type { Rapportdef } from "./rapportmodul.js";

type Fravaer = { ansatt_id: string; fra: string; til: string; grad: number };
type Refusjon = { beloepPerMaaned: number; endringer: { beloep: number; startdato: string }[] } | null;
const visDato = (d: string) => d.split("-").reverse().join(".");
const IM_STATUS: Record<string, string> = { sender: "Sendes", sendt: "Sendt", godkjent: "Godkjent", avvist: "Avvist", feil: "Ikke sendt" };

// Refusjonen per måned på en dag: beløpet, eller det siste nye beløpet fra en dato før.
export function refusjonPaaDag(r: Refusjon, dag: string): number {
  if (!r) return 0;
  let belop = Number(r.beloepPerMaaned);
  for (const e of [...r.endringer].sort((a, b) => a.startdato.localeCompare(b.startdato))) if (e.startdato <= dag) belop = Number(e.beloep);
  return belop;
}

// Beregnet refusjon for dagene: dagsatsen (månedsbeløpet, høyst 6 G, ganger 12 delt på 260) for
// virkedagene, ganget med sykmeldingsgraden. NAV fastsetter beløpet.
export function beregnetRefusjon(r: Refusjon, dager: { dato: string; grad: number }[]): number {
  let sum = 0;
  for (const d of dager) {
    if (!virkedag(d.dato)) continue;
    const maaned = Math.min(refusjonPaaDag(r, d.dato), (grunnbelop(d.dato) * 6) / 12);
    sum += ((maaned * 12) / 260) * (d.grad / 100);
  }
  return rund(sum);
}

export const sykepengerRapporter: Rapportdef[] = [
  {
    id: "lonn.sykepenger",
    modul: "lonn",
    navn: "Sykepenger og refusjon",
    beskrivelse:
      "Sykefraværet i perioden per ansatt: dager i arbeidsgiverperioden og etter (NAV), gradert sykmelding, og inntektsmeldingen med refusjonskravet til NAV og refusjonen for perioden.",
    funksjon: "lonn",
    tilgang: "personal",
    parameter: "periode",
    maanedlig: true,
    hent: async (db: Db, org: string, v) => {
      const fravaer = await alle<Fravaer>(
        db,
        `select ansatt_id, to_char(fra, 'YYYY-MM-DD') as fra, to_char(til, 'YYYY-MM-DD') as til, coalesce(sykmeldingsgrad, 100) as grad
           from faktura.fravaer where org_id = $1 and type = 'syk' and til >= $2::date - 120 and fra <= $3 order by fra`,
        [org, v.fra, v.til],
      );
      const ansatte = await alle<{ id: string; ansattnummer: number; navn: string; ansatt_fra: string }>(
        db,
        `select id, ansattnummer, fornavn || ' ' || etternavn as navn, to_char(ansatt_fra, 'YYYY-MM-DD') as ansatt_fra
           from faktura.ansatte where org_id = $1 order by ansattnummer`,
        [org],
      );
      // Den siste inntektsmeldingen for sykefraværet (forespørselen gjelder perioden).
      const im = await alle<{ ansatt_id: string; status: string; refusjon: Refusjon; sendt: string | null }>(
        db,
        `select distinct on (m.ansatt_id) m.ansatt_id, m.status, m.innhold->'refusjon' as refusjon, to_char(coalesce(m.sendt_at, m.opprettet), 'YYYY-MM-DD') as sendt
           from faktura.nav_inntektsmeldinger m join faktura.nav_forespoersler f on f.id = m.forespoersel_id
          where m.org_id = $1 and m.ansatt_id is not null and m.status <> 'feil' and f.status <> 'FORKASTET'
            and exists (select 1 from jsonb_array_elements(coalesce(f.data->'sykmeldingsperioder', '[]')) p
                         where (p->>'tom')::date >= $2 and (p->>'fom')::date <= $3)
          order by m.ansatt_id, (m.status = 'godkjent') desc, m.opprettet desc`,
        [org, v.fra, v.til],
      );
      // Refusjonene for sykepenger som er mottatt fra NAV i perioden.
      const mottatt = await alle<{ ansatt_id: string; belop: number }>(
        db,
        `select ansatt_id, sum(belop)::float8 as belop from faktura.nav_refusjoner
          where org_id = $1 and type = 'sykepenger' and ansatt_id is not null and dato between $2 and $3 group by 1`,
        [org, v.fra, v.til],
      );
      const rader: Record<string, unknown>[] = [];
      for (const a of ansatte) {
        const egne = fravaer.filter((f) => f.ansatt_id === a.id);
        const m = im.find((x) => x.ansatt_id === a.id);
        const fraNav = rund(Number(mottatt.find((x) => x.ansatt_id === a.id)?.belop ?? 0));
        if (!egne.length && !m && !fraNav) continue;
        const p = arbeidsgiverperiode(
          egne.map((f) => ({ fra: f.fra, til: f.til, type: "syk" })),
          a.ansatt_fra,
        );
        const dager: { dato: string; grad: number }[] = [];
        for (const f of egne) for (let d = f.fra > v.fra ? f.fra : v.fra; d <= f.til && d <= v.til; d = pluss(d, 1)) dager.push({ dato: d, grad: Number(f.grad) });
        if (!dager.length && !m && !fraNav) continue;
        const nav = dager.filter((d) => p.etter.has(d.dato) || p.utenOpptjening.has(d.dato));
        const refusjon = m?.refusjon ?? null;
        rader.push({
          ansattnummer: a.ansattnummer,
          navn: a.navn,
          syk: dager.length,
          gradert: dager.filter((d) => d.grad < 100).length,
          agp: dager.filter((d) => p.agp.has(d.dato)).length,
          nav: nav.length,
          refusjon_mnd: refusjon ? refusjonPaaDag(refusjon, v.til) : 0,
          refusjon: refusjon && m!.status !== "avvist" ? beregnetRefusjon(refusjon, nav) : 0,
          mottatt: fraNav,
          inntektsmelding: m ? `${IM_STATUS[m.status] ?? m.status}${m.sendt ? ` ${visDato(m.sendt)}` : ""}` : "",
        });
      }
      return {
        merknad:
          "Dagene er kalenderdager i perioden. Refusjonen er beregnet som dagsats (månedsbeløpet i inntektsmeldingen, høyst 6 G, ganger 12 delt på 260) for virkedagene etter arbeidsgiverperioden, ganget med sykmeldingsgraden; NAV fastsetter beløpet. Mottatt: refusjonene for sykepenger som er registrert med dato i perioden (Lønn → Sykepenger).",
        kolonner: [
          { nokkel: "ansattnummer", navn: "Nr", type: "tekst" },
          { nokkel: "navn", navn: "Ansatt" },
          { nokkel: "syk", navn: "Sykedager", type: "antall", sum: true },
          { nokkel: "gradert", navn: "Gradert", type: "antall", sum: true },
          { nokkel: "agp", navn: "Arbeidsgiverperioden", type: "antall", sum: true },
          { nokkel: "nav", navn: "Etter (NAV)", type: "antall", sum: true },
          { nokkel: "refusjon_mnd", navn: "Refusjon per måned", type: "kr", sum: true, pdf: false },
          { nokkel: "refusjon", navn: "Beregnet refusjon", type: "kr", sum: true },
          { nokkel: "mottatt", navn: "Mottatt fra NAV", type: "kr", sum: true },
          { nokkel: "inntektsmelding", navn: "Inntektsmelding" },
        ],
        rader,
      };
    },
  },
];
