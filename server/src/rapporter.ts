// Rapporter og eksport. Alt kjøres som innlogget bruker, så RLS gjelder.
import { Hono, type Context } from "hono";
import { z } from "zod";
import { alle, somBruker } from "./db.js";
import type { Rapportdef } from "./rapportmodul.js";

const datoS = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const orgId = (c: Context) => z.string().uuid().parse(c.req.param("org"));
const bruk = <T>(c: Context, fn: Parameters<typeof somBruker<T>>[1]) => somBruker<T>(c.get("bruker").id, fn);

// Mva-terminer: seks tomånedersperioder.
export function termin(aar: number, nr: number) {
  const fra = `${aar}-${String((nr - 1) * 2 + 1).padStart(2, "0")}-01`;
  const slutt = new Date(Date.UTC(aar, nr * 2, 0));
  return { fra, til: slutt.toISOString().slice(0, 10) };
}

// CSV for norsk Excel: semikolon, desimalkomma, BOM og anførselstegn ved behov.
export function csv(rader: Record<string, unknown>[], kolonner: [string, string][]): string {
  const felt = (v: unknown) => {
    if (v == null) return "";
    const s = typeof v === "number" ? String(v).replace(".", ",") : String(v);
    return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const linjer = [kolonner.map(([, navn]) => felt(navn)).join(";"), ...rader.map((r) => kolonner.map(([k]) => felt(r[k])).join(";"))];
  return "﻿" + linjer.join("\r\n") + "\r\n";
}

function periode(c: Context) {
  const fra = datoS.optional().parse(c.req.query("fra")) ?? `${new Date().getFullYear()}-01-01`;
  const til = datoS.optional().parse(c.req.query("til")) ?? `${new Date().getFullYear()}-12-31`;
  return { fra, til };
}

// Monteres under /api/org/:org.
export function rapportRuter() {
  const r = new Hono();

  r.get("/rapporter/reskontro", async (c) =>
    c.json(
      await bruk(c, (db) =>
        alle(
          db,
          `with ute as (
             select f.kunde_id, f.forfallsdato,
                    f.sum_inkl_mva - f.kreditert_belop - f.betalt_belop as rest,
                    faktura.i_dag() - f.forfallsdato as dager
               from faktura.fakturaer f
              where f.org_id = $1 and f.type = 'faktura' and f.status = 'utstedt'
           )
           select k.id as kunde_id, k.kundenummer, k.navn,
                  count(*) as antall,
                  sum(rest) as utestaende,
                  sum(rest) filter (where dager <= 0) as ikke_forfalt,
                  sum(rest) filter (where dager between 1 and 30) as d1_30,
                  sum(rest) filter (where dager between 31 and 60) as d31_60,
                  sum(rest) filter (where dager between 61 and 90) as d61_90,
                  sum(rest) filter (where dager > 90) as over_90,
                  min(forfallsdato) as eldste_forfall
             from ute join faktura.kunder k on k.id = ute.kunde_id
            where rest > 0.005
            group by k.id, k.kundenummer, k.navn
            order by utestaende desc`,
          [orgId(c)],
        ),
      ),
    ),
  );

  // Grunnlag og mva per sats for utstedte fakturaer og kreditnotaer i perioden (etter fakturadato).
  r.get("/rapporter/mva", async (c) => {
    const aar = z.coerce.number().int().min(2000).max(2100).optional().parse(c.req.query("aar"));
    const nr = z.coerce.number().int().min(1).max(6).optional().parse(c.req.query("termin"));
    const { fra, til } = aar && nr ? termin(aar, nr) : periode(c);
    const rader = await bruk(c, (db) =>
      alle(
        db,
        `select l.mva_sats, sum(l.belop_eks) as grunnlag, sum(l.mva_belop) as mva,
                sum(l.belop_eks) filter (where f.type = 'kreditnota') as kreditert_grunnlag,
                sum(l.mva_belop) filter (where f.type = 'kreditnota') as kreditert_mva
           from faktura.faktura_linjer l join faktura.fakturaer f on f.id = l.faktura_id
          where f.org_id = $1 and f.status <> 'utkast' and f.fakturadato between $2 and $3
          group by l.mva_sats
          order by l.mva_sats desc`,
        [orgId(c), fra, til],
      ),
    );
    return c.json({ fra, til, satser: rader });
  });

  r.get("/rapporter/salg", async (c) => {
    const aar = z.coerce.number().int().min(2000).max(2100).parse(c.req.query("aar") ?? new Date().getFullYear());
    return c.json(
      await bruk(c, (db) =>
        alle(
          db,
          `select to_char(m, 'YYYY-MM') as maaned,
                  coalesce(sum(f.sum_eks_mva), 0) as eks_mva,
                  coalesce(sum(f.sum_inkl_mva), 0) as inkl_mva,
                  count(f.id) filter (where f.type = 'faktura') as antall_fakturaer,
                  count(f.id) filter (where f.type = 'kreditnota') as antall_kreditnotaer
             from generate_series(make_date($2, 1, 1), make_date($2, 12, 1), interval '1 month') m
             left join faktura.fakturaer f
               on f.org_id = $1 and f.status <> 'utkast' and date_trunc('month', f.fakturadato) = m
            group by m order by m`,
          [orgId(c), aar],
        ),
      ),
    );
  });

  r.get("/eksport/fakturaer.csv", async (c) => {
    const { fra, til } = periode(c);
    const rader = await bruk(c, (db) =>
      alle(
        db,
        `select f.fakturanummer, case f.type when 'kreditnota' then 'Kreditnota' else 'Faktura' end as type,
                f.fakturadato, f.forfallsdato, f.kunde ->> 'kundenummer' as kundenummer, f.kunde ->> 'navn' as kunde,
                f.kunde ->> 'orgnr' as kunde_orgnr, f.sum_eks_mva, f.mva, f.sum_inkl_mva, f.betalt_belop, f.kreditert_belop,
                f.refusjon_belop, f.status, f.kid, (select k.fakturanummer from faktura.fakturaer k where k.id = f.kreditnota_for) as krediterer
           from faktura.fakturaer f
          where f.org_id = $1 and f.status <> 'utkast' and f.fakturadato between $2 and $3
          order by f.fakturanummer`,
        [orgId(c), fra, til],
      ),
    );
    const tekst = csv(rader, [
      ["fakturanummer", "Nummer"], ["type", "Type"], ["fakturadato", "Fakturadato"], ["forfallsdato", "Forfall"],
      ["kundenummer", "Kundenr"], ["kunde", "Kunde"], ["kunde_orgnr", "Kundens orgnr"], ["sum_eks_mva", "Sum eks mva"],
      ["mva", "Mva"], ["sum_inkl_mva", "Sum inkl mva"], ["betalt_belop", "Betalt"], ["kreditert_belop", "Kreditert"],
      ["refusjon_belop", "Refundert"], ["status", "Status"], ["kid", "KID"], ["krediterer", "Krediterer faktura"],
    ]);
    return c.body(tekst, 200, { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="fakturaer-${fra}-${til}.csv"` });
  });

  r.get("/eksport/betalinger.csv", async (c) => {
    const { fra, til } = periode(c);
    const rader = await bruk(c, (db) =>
      alle(
        db,
        `select i.betalt_dato, i.fakturanummer, case i.type when 'refusjon' then 'Refusjon' else 'Betaling' end as type,
                i.belop, i.mva_andel, i.kilde, i.tekst
           from faktura.innbetalinger i
          where i.org_id = $1 and i.betalt_dato between $2 and $3
          order by i.betalt_dato, i.fakturanummer`,
        [orgId(c), fra, til],
      ),
    );
    const tekst = csv(rader, [
      ["betalt_dato", "Dato"], ["fakturanummer", "Fakturanr"], ["type", "Type"], ["belop", "Beløp inkl mva"],
      ["mva_andel", "Herav mva"], ["kilde", "Kilde"], ["tekst", "Tekst"],
    ]);
    return c.body(tekst, 200, { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="betalinger-${fra}-${til}.csv"` });
  });

  return r;
}

// --- Rapportmodulen: rapportene for Faktura (rapportmodul.ts) ---------------------------------------

export const fakturaRapporter: Rapportdef[] = [
  {
    id: "faktura.reskontro",
    modul: "faktura",
    navn: "Kundereskontro",
    beskrivelse: "Utestående per kunde, fordelt på dager etter forfall.",
    funksjon: "rapporter",
    tilgang: "les",
    parameter: "ingen",
    maanedlig: true,
    hent: async (db, org) => ({
      kolonner: [
        { nokkel: "kundenummer", navn: "Kundenr", type: "tekst" },
        { nokkel: "navn", navn: "Kunde" },
        { nokkel: "antall", navn: "Fakturaer", type: "antall", sum: true },
        { nokkel: "ikke_forfalt", navn: "Ikke forfalt", type: "kr", sum: true },
        { nokkel: "d1_30", navn: "1–30 dager", type: "kr", sum: true },
        { nokkel: "d31_60", navn: "31–60", type: "kr", sum: true },
        { nokkel: "d61_90", navn: "61–90", type: "kr", sum: true },
        { nokkel: "over_90", navn: "Over 90", type: "kr", sum: true },
        { nokkel: "utestaende", navn: "Utestående", type: "kr", sum: true },
      ],
      rader: await alle(
        db,
        `with ute as (
           select f.kunde_id, f.sum_inkl_mva - f.kreditert_belop - f.betalt_belop as rest, faktura.i_dag() - f.forfallsdato as dager
             from faktura.fakturaer f
            where f.org_id = $1 and f.type = 'faktura' and f.status = 'utstedt'
         )
         select k.kundenummer, k.navn, count(*)::int as antall, sum(rest) as utestaende,
                coalesce(sum(rest) filter (where dager <= 0), 0) as ikke_forfalt,
                coalesce(sum(rest) filter (where dager between 1 and 30), 0) as d1_30,
                coalesce(sum(rest) filter (where dager between 31 and 60), 0) as d31_60,
                coalesce(sum(rest) filter (where dager between 61 and 90), 0) as d61_90,
                coalesce(sum(rest) filter (where dager > 90), 0) as over_90
           from ute join faktura.kunder k on k.id = ute.kunde_id
          where rest > 0.005
          group by k.id, k.kundenummer, k.navn
          order by utestaende desc`,
        [org],
      ),
    }),
  },
  {
    id: "faktura.mva",
    modul: "faktura",
    navn: "Mva per sats",
    beskrivelse: "Utgående mva for utstedte fakturaer og kreditnotaer i terminen (etter fakturadato). Inngående mva er ikke med.",
    funksjon: "rapporter",
    tilgang: "les",
    parameter: "termin",
    maanedlig: true,
    hent: async (db, org, v) => ({
      kolonner: [
        { nokkel: "sats", navn: "Sats", type: "prosent" },
        { nokkel: "grunnlag", navn: "Grunnlag", type: "kr", sum: true },
        { nokkel: "mva", navn: "Mva", type: "kr", sum: true },
        { nokkel: "kreditert_mva", navn: "Herav kreditnotaer (mva)", type: "kr", sum: true },
      ],
      rader: await alle(
        db,
        `select l.mva_sats as sats, sum(l.belop_eks) as grunnlag, sum(l.mva_belop) as mva,
                coalesce(sum(l.mva_belop) filter (where f.type = 'kreditnota'), 0) as kreditert_mva
           from faktura.faktura_linjer l join faktura.fakturaer f on f.id = l.faktura_id
          where f.org_id = $1 and f.status <> 'utkast' and f.fakturadato between $2 and $3
          group by l.mva_sats order by l.mva_sats desc`,
        [org, v.fra, v.til],
      ),
    }),
  },
  {
    id: "faktura.salg",
    modul: "faktura",
    navn: "Salg per måned",
    beskrivelse: "Fakturaer og kreditnotaer per måned, netto eks. og inkl. mva.",
    funksjon: "rapporter",
    tilgang: "les",
    parameter: "aar",
    hent: async (db, org, v) => ({
      kolonner: [
        { nokkel: "maaned", navn: "Måned" },
        { nokkel: "antall_fakturaer", navn: "Fakturaer", type: "antall", sum: true },
        { nokkel: "antall_kreditnotaer", navn: "Kreditnotaer", type: "antall", sum: true },
        { nokkel: "eks_mva", navn: "Netto eks. mva", type: "kr", sum: true },
        { nokkel: "inkl_mva", navn: "Netto inkl. mva", type: "kr", sum: true },
      ],
      rader: await alle(
        db,
        `select (array['januar','februar','mars','april','mai','juni','juli','august','september','oktober','november','desember'])[extract(month from m)::int] as maaned, coalesce(sum(f.sum_eks_mva), 0) as eks_mva, coalesce(sum(f.sum_inkl_mva), 0) as inkl_mva,
                count(f.id) filter (where f.type = 'faktura')::int as antall_fakturaer, count(f.id) filter (where f.type = 'kreditnota')::int as antall_kreditnotaer
           from generate_series(make_date($2, 1, 1), make_date($2, 12, 1), interval '1 month') m
           left join faktura.fakturaer f on f.org_id = $1 and f.status <> 'utkast' and date_trunc('month', f.fakturadato) = m
          group by m order by m`,
        [org, v.aar],
      ),
    }),
  },
  {
    id: "faktura.journal",
    modul: "faktura",
    navn: "Fakturajournal",
    beskrivelse: "Alle utstedte fakturaer og kreditnotaer i perioden (etter fakturadato).",
    funksjon: "rapporter",
    tilgang: "les",
    parameter: "periode",
    maanedlig: true,
    hent: async (db, org, v) => ({
      // Som den gamle eksporten (/eksport/fakturaer.csv); de smale kolonnene er bare med i CSV-en.
      kolonner: [
        { nokkel: "fakturanummer", navn: "Nummer", type: "tekst" },
        { nokkel: "type", navn: "Type" },
        { nokkel: "fakturadato", navn: "Dato", type: "dato" },
        { nokkel: "forfallsdato", navn: "Forfall", type: "dato" },
        { nokkel: "kundenummer", navn: "Kundenr", type: "tekst", pdf: false },
        { nokkel: "kunde", navn: "Kunde" },
        { nokkel: "kunde_orgnr", navn: "Kundens orgnr", type: "tekst", pdf: false },
        { nokkel: "sum_eks_mva", navn: "Eks. mva", type: "kr", sum: true },
        { nokkel: "mva", navn: "Mva", type: "kr", sum: true },
        { nokkel: "sum_inkl_mva", navn: "Inkl. mva", type: "kr", sum: true },
        { nokkel: "betalt_belop", navn: "Betalt", type: "kr", sum: true },
        { nokkel: "kreditert_belop", navn: "Kreditert", type: "kr", sum: true, pdf: false },
        { nokkel: "refusjon_belop", navn: "Refundert", type: "kr", sum: true, pdf: false },
        { nokkel: "status", navn: "Status" },
        { nokkel: "kid", navn: "KID", type: "tekst", pdf: false },
        { nokkel: "krediterer", navn: "Krediterer faktura", type: "tekst", pdf: false },
      ],
      rader: await alle(
        db,
        `select f.fakturanummer, case f.type when 'kreditnota' then 'Kreditnota' else 'Faktura' end as type, f.fakturadato, f.forfallsdato,
                f.kunde ->> 'kundenummer' as kundenummer, f.kunde ->> 'navn' as kunde, f.kunde ->> 'orgnr' as kunde_orgnr,
                f.sum_eks_mva, f.mva, f.sum_inkl_mva, f.betalt_belop, f.kreditert_belop, f.refusjon_belop,
                case f.status when 'utstedt' then 'Utstedt' when 'betalt' then 'Betalt' when 'kreditert' then 'Kreditert' else initcap(f.status) end as status,
                f.kid, (select k.fakturanummer from faktura.fakturaer k where k.id = f.kreditnota_for) as krediterer
           from faktura.fakturaer f
          where f.org_id = $1 and f.status <> 'utkast' and f.fakturadato between $2 and $3
          order by f.fakturanummer`,
        [org, v.fra, v.til],
      ),
    }),
  },
  {
    id: "faktura.innbetalinger",
    modul: "faktura",
    navn: "Innbetalinger",
    beskrivelse: "Betalinger og refusjoner registrert på fakturaene i perioden.",
    funksjon: "rapporter",
    tilgang: "les",
    parameter: "periode",
    maanedlig: true,
    hent: async (db, org, v) => ({
      kolonner: [
        { nokkel: "betalt_dato", navn: "Dato", type: "dato" },
        { nokkel: "fakturanummer", navn: "Fakturanr", type: "tekst" },
        { nokkel: "type", navn: "Type" },
        { nokkel: "belop", navn: "Beløp inkl. mva", type: "kr", sum: true },
        { nokkel: "mva_andel", navn: "Herav mva", type: "kr", sum: true },
        { nokkel: "kilde", navn: "Kilde" },
        { nokkel: "tekst", navn: "Tekst" },
      ],
      rader: await alle(
        db,
        `select i.betalt_dato, i.fakturanummer, case i.type when 'refusjon' then 'Refusjon' else 'Betaling' end as type, i.belop, i.mva_andel, i.kilde, i.tekst
           from faktura.innbetalinger i
          where i.org_id = $1 and i.betalt_dato between $2 and $3
          order by i.betalt_dato, i.fakturanummer`,
        [org, v.fra, v.til],
      ),
    }),
  },
];
