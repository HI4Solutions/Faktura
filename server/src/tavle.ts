// Tavla (ressursfordeling, 0037_tavle_og_fravaer.sql): dagen er delt i faser (rader) og
// oppgaver (kolonner) som organisasjonen lager selv, med hvor mange som trengs i oppgaven
// (behov), eventuelt forskjellig fra fase til fase (0038_tavle_behov.sql). Ressursene en
// dag er de ansatte med vakt den dagen i vaktplanen; de som er borte, er med, men merket, og
// vaktene deres står som «mangler vikar» til en vikar er satt inn. Hvem som hører til hvilken
// fase (vakten overlapper fasens tidsrom), finner appen ut. Eier og administrator plasserer
// de ansatte i oppgavene; regnskap ser tavla, og den ansatte ser sine egne plasser
// (/tavle/mine).
import { Hono, type Context } from "hono";
import { z } from "zod";
import { alle, en, somBruker, type Db } from "./db.js";
import { ApiFeil } from "./feil.js";
import { datoS, klokke, tekst } from "./ansatte.js";
import { beregnBemanning } from "./arbeidsplan.js";

const uuid = z.string().uuid();
const orgId = (c: Context) => uuid.parse(c.req.param("org"));
const id = (c: Context) => uuid.parse(c.req.param("id"));
const bruk = <T>(c: Context, fn: (db: Db) => Promise<T>) => somBruker<T>(c.get("bruker").id, fn);

const faseSkjema = z.object({
  navn: tekst(40, "Navnet").min(1, "Skriv et navn på fasen"),
  // Tidsrommet: begge eller ingen (null fjerner det).
  fra: klokke.nullable().optional(),
  til: klokke.nullable().optional(),
});
const oppgaveSkjema = z.object({
  navn: tekst(40, "Navnet").min(1, "Skriv et navn på oppgaven"),
  behov: z.number().int().min(1, "Behovet er minst 1").max(50, "Behovet kan være høyst 50").nullable().optional(),
});

const FASER = "select id, navn, to_char(fra, 'HH24:MI') as fra, to_char(til, 'HH24:MI') as til, rekkefolge from faktura.tavle_faser where org_id = $1 order by rekkefolge, opprettet";
const OPPGAVER = "select id, navn, behov, rekkefolge from faktura.tavle_oppgaver where org_id = $1 order by rekkefolge, opprettet";
const BEHOV = "select fase_id, oppgave_id, antall from faktura.tavle_behov where org_id = $1";

export function tavleRuter() {
  const r = new Hono();

  // --- Oppsett: faser og oppgaver ---------------------------------------------------

  r.get("/tavle/oppsett", async (c) =>
    c.json(
      await bruk(c, async (db) => ({
        faser: await alle(db, FASER, [orgId(c)]),
        oppgaver: await alle(db, OPPGAVER, [orgId(c)]),
        behov: await alle(db, BEHOV, [orgId(c)]),
      })),
    ),
  );

  for (const [sti, tabell, skjema, felt] of [
    ["faser", "tavle_faser", faseSkjema, ["navn", "fra", "til"]],
    ["oppgaver", "tavle_oppgaver", oppgaveSkjema, ["navn", "behov"]],
  ] as const) {
    r.post(`/tavle/${sti}`, async (c) => {
      const b = (skjema as z.ZodTypeAny).parse(await c.req.json().catch(() => ({}))) as Record<string, unknown>;
      if (sti === "faser" && !b.fra !== !b.til) throw new ApiFeil(400, "Skriv både fra og til, eller ingen av dem");
      const ny = await bruk(c, async (db) => {
        await db.query("select faktura.krev($1, 'personal')", [orgId(c)]);
        const verdier = felt.map((k) => b[k] ?? null);
        return en(
          db,
          `insert into faktura.${tabell} (org_id, ${felt.join(", ")}, rekkefolge)
           values ($1, ${felt.map((_, i) => `$${i + 2}`).join(", ")}, (select coalesce(max(rekkefolge), 0) + 1 from faktura.${tabell} where org_id = $1))
           returning id`,
          [orgId(c), ...verdier],
        );
      });
      return c.json(ny, 201);
    });

    r.patch(`/tavle/${sti}/:id`, async (c) => {
      const b = (skjema as z.ZodObject<z.ZodRawShape>).partial().parse(await c.req.json().catch(() => ({}))) as Record<string, unknown>;
      const endres = felt.filter((k) => b[k] !== undefined);
      if (!endres.length) throw new ApiFeil(400, "Ingen felt å endre");
      if (sti === "faser" && (b.fra !== undefined || b.til !== undefined) && !b.fra !== !b.til) throw new ApiFeil(400, "Skriv både fra og til, eller ingen av dem");
      await bruk(c, async (db) => {
        await db.query("select faktura.krev($1, 'personal')", [orgId(c)]);
        const res = await db.query(`update faktura.${tabell} set ${endres.map((k, i) => `${k} = $${i + 3}`).join(", ")} where org_id = $1 and id = $2`, [
          orgId(c),
          id(c),
          ...endres.map((k) => b[k] ?? null),
        ]);
        if (!res.rowCount) throw new ApiFeil(404, "Fant ikke den");
      });
      return c.body(null, 204);
    });

    // Slettes en fase eller oppgave, forsvinner plassene i den.
    r.delete(`/tavle/${sti}/:id`, async (c) => {
      await bruk(c, async (db) => {
        await db.query("select faktura.krev($1, 'personal')", [orgId(c)]);
        const res = await db.query(`delete from faktura.${tabell} where org_id = $1 and id = $2`, [orgId(c), id(c)]);
        if (!res.rowCount) throw new ApiFeil(404, "Fant ikke den");
      });
      return c.body(null, 204);
    });
  }

  // Ny rekkefølge: id-ene i den rekkefølgen de skal stå.
  r.post("/tavle/rekkefolge", async (c) => {
    const b = z.object({ type: z.enum(["faser", "oppgaver"]), ider: z.array(uuid).min(1).max(100) }).parse(await c.req.json().catch(() => ({})));
    await bruk(c, async (db) => {
      await db.query("select faktura.krev($1, 'personal')", [orgId(c)]);
      await db.query(
        `update faktura.${b.type === "faser" ? "tavle_faser" : "tavle_oppgaver"} t set rekkefolge = n.i
           from unnest($2::uuid[]) with ordinality as n(id, i)
          where t.org_id = $1 and t.id = n.id`,
        [orgId(c), b.ider],
      );
    });
    return c.body(null, 204);
  });

  // Behovet i en oppgave i én fase (null: som på oppgaven, 0: trengs ikke i fasen).
  r.put("/tavle/behov", async (c) => {
    const b = z
      .object({ fase_id: uuid, oppgave_id: uuid, antall: z.number().int().min(0, "Behovet kan ikke være negativt").max(50, "Behovet kan være høyst 50").nullable() })
      .parse(await c.req.json().catch(() => ({})));
    await bruk(c, async (db) => {
      await db.query("select faktura.krev($1, 'personal')", [orgId(c)]);
      if (b.antall === null)
        await db.query("delete from faktura.tavle_behov where org_id = $1 and fase_id = $2 and oppgave_id = $3", [orgId(c), b.fase_id, b.oppgave_id]);
      else
        await db.query(
          `insert into faktura.tavle_behov (org_id, fase_id, oppgave_id, antall) values ($1, $2, $3, $4)
           on conflict (org_id, fase_id, oppgave_id) do update set antall = excluded.antall`,
          [orgId(c), b.fase_id, b.oppgave_id, b.antall],
        );
    });
    return c.body(null, 204);
  });

  // --- Dagens tavle --------------------------------------------------------------------

  r.get("/tavle", async (c) => {
    const { dato } = z.object({ dato: datoS }).parse(c.req.query());
    return c.json(
      await bruk(c, async (db) => {
        await db.query("select faktura.krev($1, 'personal_les')", [orgId(c)]);
        const vakter = await alle<{
          id: string;
          ansatt_id: string;
          navn: string;
          fra: string;
          til: string;
          oppgave: string | null;
          publisert: boolean;
          vikar_for: string | null;
          har_vikar: boolean;
          fravaer: string | null;
        }>(
          db,
          `select v.id, v.ansatt_id, a.fornavn || ' ' || a.etternavn as navn, to_char(v.fra, 'HH24:MI') as fra, to_char(v.til, 'HH24:MI') as til,
                  v.oppgave, v.publisert_at is not null as publisert, v.vikar_for,
                  exists (select 1 from faktura.vakter x where x.org_id = v.org_id and x.vikar_for = v.id) as har_vikar,
                  (select faktura.fravaer_type(f.org_id, f.ansatt_id, f.type) from faktura.fravaer f where f.org_id = v.org_id and f.ansatt_id = v.ansatt_id and v.dato between f.fra and f.til limit 1) as fravaer
             from faktura.vakter v
             join faktura.ansatte a on a.org_id = v.org_id and a.id = v.ansatt_id
            where v.org_id = $1 and v.dato = $2
            order by v.fra, a.etternavn, a.fornavn`,
          [orgId(c), dato],
        );
        type TavleVakt = { id: string; fra: string | null; til: string | null; oppgave: string | null; vikar: boolean; publisert: boolean; fast?: boolean; timer?: number };
        const ressurser = new Map<string, { ansatt_id: string; navn: string; fravaer: string | null; vakter: TavleVakt[] }>();
        for (const v of vakter) {
          const r = ressurser.get(v.ansatt_id) ?? { ansatt_id: v.ansatt_id, navn: v.navn, fravaer: v.fravaer, vakter: [] };
          r.vakter.push({ id: v.id, fra: v.fra, til: v.til, oppgave: v.oppgave, vikar: !!v.vikar_for, publisert: v.publisert });
          ressurser.set(v.ansatt_id, r);
        }
        // De som har fast arbeidsdag i dag etter arbeidsplanen (og ingen vakt); en hel dag har
        // ingen klokkeslett og hører til alle fasene.
        const b = await beregnBemanning(db, orgId(c), dato, dato);
        const navn = new Map(b.ansatte.map((a) => [a.id, a.navn]));
        for (const f of b.faste.filter((x) => x.dato === dato))
          ressurser.set(f.ansatt_id, {
            ansatt_id: f.ansatt_id,
            navn: navn.get(f.ansatt_id) ?? "",
            fravaer: f.fravaer,
            vakter: [{ id: `fast:${f.ansatt_id}`, fra: f.fra, til: f.til, oppgave: null, vikar: false, publisert: true, fast: true, timer: f.timer }],
          });
        return {
          dato,
          faser: await alle(db, FASER, [orgId(c)]),
          oppgaver: await alle(db, OPPGAVER, [orgId(c)]),
          behov: await alle(db, BEHOV, [orgId(c)]),
          ressurser: [...ressurser.values()].sort(
            (x, y) => (x.vakter[0]?.fra ?? "00:00").localeCompare(y.vakter[0]?.fra ?? "00:00") || x.navn.localeCompare(y.navn, "nb"),
          ),
          plasseringer: await alle(db, "select id, fase_id, oppgave_id, ansatt_id from faktura.tavle_plasseringer where org_id = $1 and dato = $2", [orgId(c), dato]),
          fravaer: await alle(
            db,
            `select f.id, f.ansatt_id, a.fornavn || ' ' || a.etternavn as navn, faktura.fravaer_type(f.org_id, f.ansatt_id, f.type) as type, f.fra, f.til
               from faktura.fravaer f join faktura.ansatte a on a.org_id = f.org_id and a.id = f.ansatt_id
              where f.org_id = $1 and $2 between f.fra and f.til order by a.etternavn, a.fornavn`,
            [orgId(c), dato],
          ),
          mangler_vikar: vakter
            .filter((v) => v.fravaer && !v.har_vikar)
            .map((v) => ({ vakt_id: v.id, ansatt_id: v.ansatt_id, navn: v.navn, fra: v.fra, til: v.til, oppgave: v.oppgave, type: v.fravaer })),
        };
      }),
    );
  });

  // Den innloggedes egne plasser i perioden (for «Mine vakter»).
  r.get("/tavle/mine", async (c) => {
    const q = z.object({ fra: datoS, til: datoS }).parse(c.req.query());
    if (q.til < q.fra) throw new ApiFeil(400, "Slutten er før starten");
    if (Date.parse(q.til) - Date.parse(q.fra) > 93 * 86_400_000) throw new ApiFeil(400, "Velg en periode på høyst tre måneder");
    return c.json(
      await bruk(c, (db) =>
        alle(
          db,
          `select p.dato, f.navn as fase, to_char(f.fra, 'HH24:MI') as fra, to_char(f.til, 'HH24:MI') as til, o.navn as oppgave
             from faktura.tavle_plasseringer p
             join faktura.tavle_faser f on f.org_id = p.org_id and f.id = p.fase_id
             join faktura.tavle_oppgaver o on o.org_id = p.org_id and o.id = p.oppgave_id
            where p.org_id = $1 and p.ansatt_id = faktura.min_ansatt($1) and p.dato between $2 and $3
            order by p.dato, f.rekkefolge, f.opprettet`,
          [orgId(c), q.fra, q.til],
        ),
      ),
    );
  });

  // Plasser en ansatt i en oppgave i en fase (eller ta den ut, med oppgave_id null).
  r.put("/tavle/plassering", async (c) => {
    const b = z.object({ dato: datoS, fase_id: uuid, ansatt_id: uuid, oppgave_id: uuid.nullable() }).parse(await c.req.json().catch(() => ({})));
    await bruk(c, async (db) => {
      await db.query("select faktura.krev($1, 'personal')", [orgId(c)]);
      if (!b.oppgave_id)
        await db.query("delete from faktura.tavle_plasseringer where org_id = $1 and dato = $2 and fase_id = $3 and ansatt_id = $4", [orgId(c), b.dato, b.fase_id, b.ansatt_id]);
      else
        await db.query(
          `insert into faktura.tavle_plasseringer (org_id, dato, fase_id, oppgave_id, ansatt_id) values ($1, $2, $3, $4, $5)
           on conflict (org_id, dato, fase_id, ansatt_id) do update set oppgave_id = excluded.oppgave_id`,
          [orgId(c), b.dato, b.fase_id, b.oppgave_id, b.ansatt_id],
        );
    });
    return c.body(null, 204);
  });

  // Kopier plassene fra en annen dag (f.eks. samme dag forrige uke), for dem som er på jobb og
  // ikke borte den nye dagen. Plasser som finnes fra før, beholdes.
  r.post("/tavle/kopier", async (c) => {
    const b = z.object({ fra: datoS, til: datoS }).parse(await c.req.json().catch(() => ({})));
    if (b.fra === b.til) throw new ApiFeil(400, "Velg en annen dag å kopiere fra");
    const kopiert = await bruk(c, async (db) => {
      await db.query("select faktura.krev($1, 'personal')", [orgId(c)]);
      // De som har fast arbeidsdag den nye dagen etter arbeidsplanen, er også på jobb.
      const faste = (await beregnBemanning(db, orgId(c), b.til, b.til)).faste.filter((f) => f.dato === b.til).map((f) => f.ansatt_id);
      const nye = await alle(
        db,
        `insert into faktura.tavle_plasseringer (org_id, dato, fase_id, oppgave_id, ansatt_id)
         select p.org_id, $3, p.fase_id, p.oppgave_id, p.ansatt_id
           from faktura.tavle_plasseringer p
           join faktura.ansatte a on a.org_id = p.org_id and a.id = p.ansatt_id
          where p.org_id = $1 and p.dato = $2
            and a.aktiv and $3 >= a.ansatt_fra and (a.ansatt_til is null or $3 <= a.ansatt_til)
            and (exists (select 1 from faktura.vakter v where v.org_id = p.org_id and v.ansatt_id = p.ansatt_id and v.dato = $3) or p.ansatt_id = any($4::uuid[]))
            and not exists (select 1 from faktura.fravaer f where f.org_id = p.org_id and f.ansatt_id = p.ansatt_id and $3 between f.fra and f.til)
         on conflict (org_id, dato, fase_id, ansatt_id) do nothing
         returning id`,
        [orgId(c), b.fra, b.til, faste],
      );
      return nye.length;
    });
    return c.json({ kopiert });
  });

  return r;
}
