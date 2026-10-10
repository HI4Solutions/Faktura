// Kildeskatt på lønn (Lønn K6, 0100_kildeskatt.sql): rapporten «Kildeskatt på lønn» for de ansatte
// på kildeskatteordningen for utenlandske arbeidstakere (PAYE): satsen, den trekkpliktige lønnen og
// skattetrekket i året (også fra et tidligere lønnssystem), og om lønnen er over grensen for
// ordningen. Trekket regner summer i lonnsberegning.ts (erKildeskatt).
import { alle } from "./db.js";
import { kildeskattGrense, tall } from "./lonnsberegning.js";
import type { Rapportdef } from "./rapportmodul.js";

export const kildeskattRapporter: Rapportdef[] = [
  {
    id: "lonn.kildeskatt",
    modul: "lonn",
    navn: "Kildeskatt på lønn",
    beskrivelse:
      "De ansatte på kildeskatteordningen for utenlandske arbeidstakere (PAYE): satsen, lønnen og skattetrekket i året, og om lønnen er over grensen for ordningen.",
    funksjon: "lonn",
    tilgang: "personal_les",
    parameter: "aar",
    hent: async (db, org, v) => {
      const grense = kildeskattGrense(v.aar);
      // De som er på ordningen nå (prosenttrekk), og dem som har hatt kildeskatt i en kjøring i året.
      const rader = await alle<{ ansattnummer: number; navn: string; sats: number | null; lonn: number; skattetrekk: number }>(
        db,
        `with lonn as (
           select s.ansatt_id, sum(s.trekkpliktig) as trekkpliktig, sum(s.skattetrekk) as skattetrekk,
                  bool_or(s.trekkmetode like 'Kildeskatt på lønn%') as kildeskatt
             from faktura.lonnsslipper s join faktura.lonnskjoringer k on k.id = s.kjoring_id
            where k.org_id = $1 and k.status = 'godkjent' and extract(year from k.utbetalingsdato) = $2
            group by s.ansatt_id
         )
         select a.ansattnummer, a.fornavn || ' ' || a.etternavn as navn,
                case when a.skattekort = 'prosent' then a.skatt_prosent::float8 end as sats,
                (coalesce(lonn.trekkpliktig, 0) + coalesce(i.trekkpliktig, 0))::float8 as lonn,
                (coalesce(lonn.skattetrekk, 0) + coalesce(i.forskuddstrekk, 0))::float8 as skattetrekk
           from faktura.ansatte a
           left join lonn on lonn.ansatt_id = a.id
           left join faktura.lonn_inngaende i on i.org_id = a.org_id and i.ansatt_id = a.id and i.aar = $2
          where a.org_id = $1 and a.arbeidstaker and ((a.kildeskatt and a.skattekort = 'prosent') or coalesce(lonn.kildeskatt, false))
          order by a.ansattnummer`,
        [org, v.aar],
      );
      return {
        kolonner: [
          { nokkel: "ansattnummer", navn: "Nr", type: "tekst" },
          { nokkel: "navn", navn: "Ansatt" },
          { nokkel: "sats", navn: "Sats", type: "prosent" },
          { nokkel: "lonn", navn: "Lønn i året", type: "kr", sum: true },
          { nokkel: "skattetrekk", navn: "Skattetrekk", type: "kr", sum: true },
          { nokkel: "grense", navn: "Grensen" },
        ],
        rader: rader.map((r) => ({
          ansattnummer: String(r.ansattnummer),
          navn: r.navn,
          sats: r.sats,
          lonn: r.lonn,
          skattetrekk: r.skattetrekk,
          grense: r.lonn > grense ? "Over grensen: nytt skattekort" : "Under grensen",
        })),
        merknad: `Kildeskatt på lønn for utenlandske arbeidstakere: satsen på skattekortet trekkes av all lønn, også feriepengene, uten fradrag for fagforeningskontingent og uten halv skatt, og er ordinært forskuddstrekk i a-meldingen. Ordningen gjelder ikke når lønnen i året er over grensen (${tall(grense)} kr i ${v.aar}); da skal den ansatte skattlegges etter de vanlige reglene og ha nytt skattekort. Lønnen i året er den trekkpliktige lønnen her (også fra et tidligere lønnssystem).`,
      };
    },
  },
];
