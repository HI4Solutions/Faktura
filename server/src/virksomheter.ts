// Flere virksomheter og soner (Lønn K7, 0101_virksomheter.sql). Foretaket har hovedvirksomheten i
// lønnsoppsettet (virksomhet_orgnr og aga_sone) og kan ha flere virksomheter (underenhetene i
// Enhetsregisteret), hver med sonen for arbeidsgiveravgift der den ligger. Den ansatte jobber i én
// av dem (ansatte.virksomhet_id; null: hovedvirksomheten). Lønnskjøringen regner avgiften med sonen
// (lonn.ts, med fribeløpet i sone 1a per foretak), og a-meldingen har én virksomhet per underenhet
// (amelding.ts). Rapporten «Arbeidsgiveravgift per virksomhet og sone».
import { Hono, type Context } from "hono";
import { z } from "zod";
import { alle, en, somBruker, type Db } from "./db.js";
import { ApiFeil } from "./feil.js";
import { rund } from "./lonnsberegning.js";
import type { Rapportdef } from "./rapportmodul.js";
import { orgnrGyldig } from "./regler.js";

const uuid = z.string().uuid();
const orgId = (c: Context) => uuid.parse(c.req.param("org"));
const bruk = <T>(c: Context, fn: (db: Db) => Promise<T>) => somBruker<T>(c.get("bruker").id, fn);

export const SONER = ["1", "1a", "2", "3", "4", "4a", "5"] as const;
const skjema = z.object({
  orgnr: z
    .string()
    .transform((s) => s.replace(/\s/g, ""))
    .refine((s) => /^\d{9}$/.test(s) && orgnrGyldig(s), "Organisasjonsnummeret til virksomheten er ikke gyldig"),
  navn: z.string().trim().min(1, "Skriv navnet på virksomheten").max(200),
  aga_sone: z.enum(SONER, { error: "Velg sone for arbeidsgiveravgift" }),
});

export type Virksomhet = { id: string; orgnr: string; navn: string; aga_sone: string; ansatte: number };

const LISTE = `
  select v.id, v.orgnr, v.navn, v.aga_sone,
         (select count(*) from faktura.ansatte a where a.org_id = v.org_id and a.virksomhet_id = v.id)::int as ansatte
    from faktura.virksomheter v`;

// Organisasjonsnummeret kan ikke være foretakets eget (den juridiske enheten) eller
// hovedvirksomhetens, og ikke finnes fra før.
async function sjekkOrgnr(db: Db, org: string, orgnr: string, unntatt: string | null) {
  const o = await en<{ orgnr: string | null; hoved: string | null }>(
    db,
    "select o.orgnr, (select virksomhet_orgnr from faktura.lonn_oppsett where org_id = o.id) as hoved from faktura.organisasjoner o where o.id = $1",
    [org],
  );
  if (o?.orgnr === orgnr)
    throw new ApiFeil(400, "Det er organisasjonsnummeret til foretaket (den juridiske enheten). Bruk virksomhetens (underenhetens) organisasjonsnummer.");
  if (o?.hoved === orgnr) throw new ApiFeil(400, "Det er hovedvirksomheten (under A-melding i lønnsoppsettet).");
  if (await en(db, "select 1 from faktura.virksomheter where org_id = $1 and orgnr = $2 and id is distinct from $3::uuid", [org, orgnr, unntatt]))
    throw new ApiFeil(409, "Virksomheten finnes allerede.");
}

export function virksomhetRuter() {
  const r = new Hono();

  r.get("/lonn/virksomheter", async (c) =>
    c.json(
      await bruk(c, async (db) => {
        await db.query("select faktura.krev($1, 'personal_les')", [orgId(c)]);
        const hoved = await en<{ orgnr: string | null; aga_sone: string | null; navn: string }>(
          db,
          `select l.virksomhet_orgnr as orgnr, l.aga_sone, o.navn
             from faktura.organisasjoner o left join faktura.lonn_oppsett l on l.org_id = o.id where o.id = $1`,
          [orgId(c)],
        );
        return {
          hoved: { orgnr: hoved?.orgnr ?? null, navn: hoved?.navn ?? "", aga_sone: hoved?.aga_sone ?? "1" },
          andre: await alle<Virksomhet>(db, `${LISTE} where v.org_id = $1 order by v.navn, v.orgnr`, [orgId(c)]),
        };
      }),
    ),
  );

  r.post("/lonn/virksomheter", async (c) => {
    const b = skjema.parse(await c.req.json().catch(() => ({})));
    const v = await bruk(c, async (db) => {
      await db.query("select faktura.krev($1, 'admin')", [orgId(c)]);
      await sjekkOrgnr(db, orgId(c), b.orgnr, null);
      const ny = await en<{ id: string }>(db, "insert into faktura.virksomheter (org_id, orgnr, navn, aga_sone) values ($1, $2, $3, $4) returning id", [
        orgId(c),
        b.orgnr,
        b.navn,
        b.aga_sone,
      ]);
      return en<Virksomhet>(db, `${LISTE} where v.org_id = $1 and v.id = $2`, [orgId(c), ny!.id]);
    });
    return c.json(v, 201);
  });

  r.patch("/lonn/virksomheter/:id", async (c) => {
    const id = uuid.parse(c.req.param("id"));
    const b = skjema.partial().parse(await c.req.json().catch(() => ({})));
    const v = await bruk(c, async (db) => {
      await db.query("select faktura.krev($1, 'admin')", [orgId(c)]);
      if (b.orgnr) await sjekkOrgnr(db, orgId(c), b.orgnr, id);
      const felt = Object.entries(b).filter(([, x]) => x !== undefined);
      if (felt.length) {
        const res = await db.query(`update faktura.virksomheter set ${felt.map(([k], i) => `${k} = $${i + 3}`).join(", ")} where org_id = $1 and id = $2`, [
          orgId(c),
          id,
          ...felt.map(([, x]) => x),
        ]);
        if (!res.rowCount) throw new ApiFeil(404, "Fant ikke virksomheten");
      }
      const v = await en<Virksomhet>(db, `${LISTE} where v.org_id = $1 and v.id = $2`, [orgId(c), id]);
      if (!v) throw new ApiFeil(404, "Fant ikke virksomheten");
      return v;
    });
    return c.json(v);
  });

  // En virksomhet med ansatte slettes ikke (de flyttes først); lønnsslippene beholder
  // organisasjonsnummeret og sonen.
  r.delete("/lonn/virksomheter/:id", async (c) => {
    const id = uuid.parse(c.req.param("id"));
    await bruk(c, async (db) => {
      await db.query("select faktura.krev($1, 'admin')", [orgId(c)]);
      const n = (await en<{ n: number }>(db, "select count(*)::int as n from faktura.ansatte where org_id = $1 and virksomhet_id = $2", [orgId(c), id]))!.n;
      if (n) throw new ApiFeil(409, `${n === 1 ? "Én ansatt jobber" : `${n} ansatte jobber`} i virksomheten. Flytt dem til en annen virksomhet først.`);
      const res = await db.query("delete from faktura.virksomheter where org_id = $1 and id = $2", [orgId(c), id]);
      if (!res.rowCount) throw new ApiFeil(404, "Fant ikke virksomheten");
    });
    return c.body(null, 204);
  });

  return r;
}

// --- Rapporten --------------------------------------------------------------------------------

export const virksomhetRapporter: Rapportdef[] = [
  {
    id: "lonn.aga_soner",
    modul: "lonn",
    navn: "Arbeidsgiveravgift per virksomhet og sone",
    beskrivelse:
      "Grunnlaget og arbeidsgiveravgiften i terminen per virksomhet (underenhet) og sone, fra de godkjente lønnskjøringene og AFP-premiene som er betalt.",
    funksjon: "lonn",
    tilgang: "personal_les",
    parameter: "termin",
    maanedlig: true,
    hent: async (db, org, v) => {
      const rader = await alle<{ orgnr: string | null; navn: string | null; sone: string; grunnlag: number; aga: number }>(
        db,
        `with o as (select l.virksomhet_orgnr, coalesce(l.aga_sone, '1') as aga_sone, g.navn
                      from faktura.organisasjoner g left join faktura.lonn_oppsett l on l.org_id = g.id where g.id = $1),
              rader as (
                select coalesce(s.virksomhet_orgnr, (select virksomhet_orgnr from o)) as orgnr, coalesce(s.aga_sone, (select aga_sone from o)) as sone,
                       s.aga_grunnlag as grunnlag, s.aga
                  from faktura.lonnsslipper s join faktura.lonnskjoringer k on k.id = s.kjoring_id
                 where s.org_id = $1 and k.status = 'godkjent' and k.utbetalingsdato between $2::date and $3::date
                union all
                select (select virksomhet_orgnr from o), coalesce(p.aga_sone, (select aga_sone from o)), p.afp, p.aga
                  from faktura.afp_premier p where p.org_id = $1 and p.dato between $2::date and $3::date
              )
         select r.orgnr, coalesce(v.navn, case when r.orgnr is not distinct from (select virksomhet_orgnr from o) then (select navn from o) end) as navn,
                r.sone, sum(r.grunnlag)::float8 as grunnlag, sum(r.aga)::float8 as aga
           from rader r left join faktura.virksomheter v on v.org_id = $1 and v.orgnr = r.orgnr
          group by r.orgnr, v.navn, r.sone
         having sum(r.grunnlag) <> 0 or sum(r.aga) <> 0
          order by (r.orgnr is not distinct from (select virksomhet_orgnr from o)) desc, v.navn nulls first, r.orgnr, r.sone`,
        [org, v.fra, v.til],
      );
      return {
        kolonner: [
          { nokkel: "virksomhet", navn: "Virksomhet" },
          { nokkel: "orgnr", navn: "Org.nr.", type: "tekst" },
          { nokkel: "sone", navn: "Sone", type: "tekst" },
          { nokkel: "grunnlag", navn: "Grunnlag", type: "kr", sum: true },
          { nokkel: "sats", navn: "Sats", type: "prosent" },
          { nokkel: "aga", navn: "Arbeidsgiveravgift", type: "kr", sum: true },
        ],
        rader: rader.map((r) => ({
          virksomhet: r.navn ?? "Ukjent virksomhet",
          orgnr: r.orgnr ?? "",
          sone: r.sone,
          grunnlag: rund(r.grunnlag),
          sats: r.grunnlag ? rund((r.aga / r.grunnlag) * 100) : null,
          aga: rund(r.aga),
        })),
        merknad:
          "Sonen er den lønnen ble regnet med (virksomheten den ansatte jobbet i). I sone 1a gjelder fribeløpet for hele foretaket, så satsen kan være mellom 10,6 og 14,1 %. AFP-premien er på hovedvirksomheten.",
      };
    },
  },
];
