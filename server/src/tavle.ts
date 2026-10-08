// Tavla (ressursfordeling, 0037_tavle_og_fravaer.sql): dagen er delt i faser (rader) og
// oppgaver (kolonner) som organisasjonen lager selv, med hvor mange som trengs i oppgaven
// (behov), eventuelt forskjellig fra fase til fase (0038_tavle_behov.sql). Ressursene en
// dag er de ansatte med vakt den dagen i vaktplanen; de som er borte, er med, men merket, og
// vaktene deres står som «mangler vikar» til en vikar er satt inn. Hvem som hører til hvilken
// fase (vakten overlapper fasens tidsrom), finner appen ut. Eier og administrator plasserer
// de ansatte i oppgavene, for hånd eller med rulleringen (/tavle/rullering, 0051); regnskap ser
// tavla, og den ansatte ser sine egne plasser (/tavle/mine). De med en rolle som ikke er med på
// tavla (f.eks. legene, 0057_rolle_tavle.sql), står ikke der og fordeles ikke. En ansatt kan ha
// en fast oppgave (0059_tavle_fast_oppgave.sql): rulleringen setter dem alltid der, og uten en
// plass i fasen står de der likevel (fastePlasser, regnes ut og lagres ikke).
import { Hono, type Context } from "hono";
import { z } from "zod";
import { alle, en, somBruker, type Db } from "./db.js";
import { ApiFeil } from "./feil.js";
import { datoS, klokke, tekst } from "./ansatte.js";
import { beregnBemanning } from "./arbeidsplan.js";
import { iFasen, rullere, type RBehov, type RDag, type RTid } from "./rullering.js";

const uuid = z.string().uuid();
const orgId = (c: Context) => uuid.parse(c.req.param("org"));
const id = (c: Context) => uuid.parse(c.req.param("id"));
const bruk = <T>(c: Context, fn: (db: Db) => Promise<T>) => somBruker<T>(c.get("bruker").id, fn);
const leggTilDager = (iso: string, n: number) => new Date(Date.parse(`${iso}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const dagerMellom = (a: string, b: string) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86_400_000);
// Rulleringen ser så langt tilbake for å vite hvem som har hatt hva.
const HISTORIKK_DAGER = 56;

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
const UTELATT = "select oppgave_id, ansatt_id from faktura.tavle_utelatt where org_id = $1";
// De som har en rolle som ikke er med på tavla (0057_rolle_tavle.sql).
async function utenforTavla(db: Db, org: string) {
  const rader = await alle<{ id: string }>(
    db,
    "select a.id from faktura.ansatte a join faktura.ansattgrupper g on g.org_id = a.org_id and g.id = a.gruppe_id where a.org_id = $1 and not g.tavle",
    [org],
  );
  return new Set(rader.map((x) => x.id));
}

const FASTE = "select ansatt_id, oppgave_id from faktura.tavle_fast_oppgave where org_id = $1 and ($2::uuid is null or ansatt_id = $2)";
type Plass = { dato: string; fase_id: string; oppgave_id: string; ansatt_id: string };

// Plassene til dem med fast oppgave (0059_tavle_fast_oppgave.sql) som ikke har noen plass i fasen
// (satt for hånd eller av rulleringen): i alle fasene de er på jobb og ikke borte, når oppgaven
// trengs der. De lagres ikke; tavla, «Mine vakter», vikaren og AI-assistenten regner med dem.
export async function fastePlasser(db: Db, org: string, fra: string, til: string, ansatt?: string | null): Promise<Plass[]> {
  const faste = await alle<{ ansatt_id: string; oppgave_id: string }>(db, FASTE, [org, ansatt ?? null]);
  if (!faste.length) return [];
  const faser = await alle<RTid & { id: string }>(db, FASER, [org]);
  const oppgaver = new Map((await alle<{ id: string; behov: number | null }>(db, OPPGAVER, [org])).map((o) => [o.id, o]));
  const behov = await alle<RBehov>(db, BEHOV, [org]);
  const trengs = (f: string, o: string) => behov.find((b) => b.fase_id === f && b.oppgave_id === o)?.antall ?? oppgaver.get(o)?.behov ?? null;
  const utenfor = await utenforTavla(db, org);
  const bem = await beregnBemanning(db, org, fra, til, ansatt);
  const person = new Map(bem.ansatte.map((a) => [a.id, a]));
  const lagret = new Set(
    (
      await alle<Plass>(db, "select dato, fase_id, ansatt_id from faktura.tavle_plasseringer where org_id = $1 and dato between $2 and $3 and ($4::uuid is null or ansatt_id = $4)", [
        org,
        fra,
        til,
        ansatt ?? null,
      ])
    ).map((p) => `${p.dato}|${p.fase_id}|${p.ansatt_id}`),
  );
  const ut: Plass[] = [];
  for (const { ansatt_id: a, oppgave_id: o } of faste) {
    const x = person.get(a);
    if (!x || !x.aktiv || utenfor.has(a) || !oppgaver.has(o)) continue;
    for (let d = fra; d <= til; d = leggTilDager(d, 1)) {
      if (d < x.ansatt_fra || (x.ansatt_til && d > x.ansatt_til)) continue;
      const tider: RTid[] = [
        ...bem.vakter.filter((v) => v.ansatt_id === a && v.dato === d && !v.borte),
        ...bem.faste.filter((f) => f.ansatt_id === a && f.dato === d && !f.fravaer),
      ];
      for (const f of faser)
        if (tider.some((t) => iFasen(t, f)) && trengs(f.id, o) !== 0 && !lagret.has(`${d}|${f.id}|${a}`)) ut.push({ dato: d, fase_id: f.id, oppgave_id: o, ansatt_id: a });
    }
  }
  return ut;
}

export function tavleRuter() {
  const r = new Hono();

  // --- Oppsett: faser og oppgaver ---------------------------------------------------

  r.get("/tavle/oppsett", async (c) =>
    c.json(
      await bruk(c, async (db) => ({
        faser: await alle(db, FASER, [orgId(c)]),
        oppgaver: await alle(db, OPPGAVER, [orgId(c)]),
        behov: await alle(db, BEHOV, [orgId(c)]),
        utelatt: await alle(db, UTELATT, [orgId(c)]),
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
        const utenfor = await utenforTavla(db, orgId(c));
        const vakter = (await alle<{
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
        )).filter((v) => !utenfor.has(v.ansatt_id));
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
        for (const f of b.faste.filter((x) => x.dato === dato && !utenfor.has(x.ansatt_id)))
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
          plasseringer: [
            ...(
              await alle<{ ansatt_id: string }>(db, "select id, fase_id, oppgave_id, ansatt_id, rullert from faktura.tavle_plasseringer where org_id = $1 and dato = $2", [
                orgId(c),
                dato,
              ])
            ).filter((p) => !utenfor.has(p.ansatt_id)),
            // De med fast oppgave og uten plass i fasen står der (fast: regnet ut, ikke lagret).
            ...(await fastePlasser(db, orgId(c), dato, dato)).map((p) => ({
              id: `fast:${p.fase_id}:${p.ansatt_id}`,
              fase_id: p.fase_id,
              oppgave_id: p.oppgave_id,
              ansatt_id: p.ansatt_id,
              rullert: false,
              fast: true,
            })),
          ],
          utelatt: await alle(db, UTELATT, [orgId(c)]),
          fast_oppgave: (await alle<{ ansatt_id: string }>(db, FASTE, [orgId(c), null])).filter((x) => !utenfor.has(x.ansatt_id)),
          fravaer: (
            await alle<{ ansatt_id: string }>(
              db,
              `select f.id, f.ansatt_id, a.fornavn || ' ' || a.etternavn as navn, faktura.fravaer_type(f.org_id, f.ansatt_id, f.type) as type, f.fra, f.til
                 from faktura.fravaer f join faktura.ansatte a on a.org_id = f.org_id and a.id = f.ansatt_id
                where f.org_id = $1 and $2 between f.fra and f.til order by a.etternavn, a.fornavn`,
              [orgId(c), dato],
            )
          ).filter((f) => !utenfor.has(f.ansatt_id)),
          mangler_vikar: vakter
            .filter((v) => v.fravaer && !v.har_vikar)
            .map((v) => ({ vakt_id: v.id, ansatt_id: v.ansatt_id, navn: v.navn, fra: v.fra, til: v.til, oppgave: v.oppgave, type: v.fravaer })),
        };
      }),
    );
  });

  // Den innloggedes egne plasser i perioden (for «Mine vakter»), også de som kommer av den faste
  // oppgaven.
  r.get("/tavle/mine", async (c) => {
    const q = z.object({ fra: datoS, til: datoS }).parse(c.req.query());
    if (q.til < q.fra) throw new ApiFeil(400, "Slutten er før starten");
    if (Date.parse(q.til) - Date.parse(q.fra) > 93 * 86_400_000) throw new ApiFeil(400, "Velg en periode på høyst tre måneder");
    return c.json(
      await bruk(c, async (db) => {
        const meg = (await en<{ id: string | null }>(db, "select faktura.min_ansatt($1) as id", [orgId(c)]))?.id;
        if (!meg) return [];
        return egnePlasser(db, orgId(c), meg, q.fra, q.til);
      }),
    );
  });

  // Fast oppgave for en ansatt (null: ingen). Rulleringen setter dem alltid der, og uten en plass
  // i fasen står de der på tavla.
  r.put("/tavle/fast-oppgave", async (c) => {
    const b = z.object({ ansatt_id: uuid, oppgave_id: uuid.nullable() }).parse(await c.req.json().catch(() => ({})));
    await bruk(c, async (db) => {
      await db.query("select faktura.krev($1, 'personal')", [orgId(c)]);
      const a = await en<{ navn: string; rolle: string | null; tavle: boolean }>(
        db,
        `select a.fornavn || ' ' || a.etternavn as navn, g.navn as rolle, coalesce(g.tavle, true) as tavle
           from faktura.ansatte a left join faktura.ansattgrupper g on g.org_id = a.org_id and g.id = a.gruppe_id
          where a.org_id = $1 and a.id = $2`,
        [orgId(c), b.ansatt_id],
      );
      if (!a) throw new ApiFeil(404, "Fant ikke den ansatte");
      if (!b.oppgave_id) {
        await db.query("delete from faktura.tavle_fast_oppgave where org_id = $1 and ansatt_id = $2", [orgId(c), b.ansatt_id]);
        return;
      }
      if (!a.tavle) throw new ApiFeil(400, `${a.navn} er ikke med på tavla (rollen ${a.rolle})`);
      if (!(await en(db, "select 1 from faktura.tavle_oppgaver where org_id = $1 and id = $2", [orgId(c), b.oppgave_id]))) throw new ApiFeil(404, "Fant ikke oppgaven");
      await db.query(
        `insert into faktura.tavle_fast_oppgave (org_id, ansatt_id, oppgave_id) values ($1, $2, $3)
         on conflict (org_id, ansatt_id) do update set oppgave_id = excluded.oppgave_id`,
        [orgId(c), b.ansatt_id, b.oppgave_id],
      );
    });
    return c.body(null, 204);
  });

  // Plasser en ansatt i en oppgave i en fase (eller ta den ut, med oppgave_id null). En plass
  // som settes for hånd, er ikke lenger rulleringens, og står når rulleringen kjøres igjen.
  r.put("/tavle/plassering", async (c) => {
    const b = z.object({ dato: datoS, fase_id: uuid, ansatt_id: uuid, oppgave_id: uuid.nullable() }).parse(await c.req.json().catch(() => ({})));
    await bruk(c, async (db) => {
      await db.query("select faktura.krev($1, 'personal')", [orgId(c)]);
      // En rolle som ikke er med på tavla (databasen hopper over plassen; her sies det fra).
      const utenfor = await en<{ navn: string; rolle: string }>(
        db,
        `select a.fornavn || ' ' || a.etternavn as navn, g.navn as rolle from faktura.ansatte a join faktura.ansattgrupper g on g.org_id = a.org_id and g.id = a.gruppe_id
          where a.org_id = $1 and a.id = $2 and not g.tavle`,
        [orgId(c), b.ansatt_id],
      );
      if (utenfor && b.oppgave_id) throw new ApiFeil(400, `${utenfor.navn} er ikke med på tavla (rollen ${utenfor.rolle})`);
      if (!b.oppgave_id)
        await db.query("delete from faktura.tavle_plasseringer where org_id = $1 and dato = $2 and fase_id = $3 and ansatt_id = $4", [orgId(c), b.dato, b.fase_id, b.ansatt_id]);
      else
        await db.query(
          `insert into faktura.tavle_plasseringer (org_id, dato, fase_id, oppgave_id, ansatt_id) values ($1, $2, $3, $4, $5)
           on conflict (org_id, dato, fase_id, ansatt_id) do update set oppgave_id = excluded.oppgave_id, rullert = false`,
          [orgId(c), b.dato, b.fase_id, b.oppgave_id, b.ansatt_id],
        );
    });
    return c.body(null, 204);
  });

  // Hvem rulleringen kan sette i en oppgave (uten oppgave_id: alle oppgavene). Alle kan, til de
  // tas ut her; for hånd kan de fortsatt plasseres hvor som helst.
  r.put("/tavle/utelatt", async (c) => {
    const b = z.object({ ansatt_id: uuid, oppgave_id: uuid.optional(), kan: z.boolean() }).parse(await c.req.json().catch(() => ({})));
    await bruk(c, async (db) => {
      await db.query("select faktura.krev($1, 'personal')", [orgId(c)]);
      if (!(await en(db, "select 1 from faktura.ansatte where org_id = $1 and id = $2", [orgId(c), b.ansatt_id]))) throw new ApiFeil(404, "Fant ikke den ansatte");
      if (b.kan)
        await db.query("delete from faktura.tavle_utelatt where org_id = $1 and ansatt_id = $2 and ($3::uuid is null or oppgave_id = $3)", [orgId(c), b.ansatt_id, b.oppgave_id ?? null]);
      else {
        const res = await db.query(
          `insert into faktura.tavle_utelatt (org_id, oppgave_id, ansatt_id)
           select org_id, id, $2 from faktura.tavle_oppgaver where org_id = $1 and ($3::uuid is null or id = $3)
           on conflict do nothing`,
          [orgId(c), b.ansatt_id, b.oppgave_id ?? null],
        );
        if (b.oppgave_id && !res.rowCount && !(await en(db, "select 1 from faktura.tavle_oppgaver where org_id = $1 and id = $2", [orgId(c), b.oppgave_id])))
          throw new ApiFeil(404, "Fant ikke oppgaven");
      }
    });
    return c.body(null, 204);
  });

  // Rulleringen (server/src/rullering.ts): fordel de som er på jobb på oppgavene i perioden, så
  // alle får gjøre alt etter tur. Uten lagre er det en forhåndsvisning. Plassene rulleringen satte
  // før i perioden, byttes ut; de som er satt for hånd, står (med behold: false fordeles også de).
  r.post("/tavle/rullering", async (c) => {
    const b = z
      .object({ fra: datoS, til: datoS, behold: z.boolean().optional(), samme_hele_dagen: z.boolean().optional(), lagre: z.boolean().optional() })
      .parse(await c.req.json().catch(() => ({})));
    return c.json(await bruk(c, (db) => kjorRullering(db, orgId(c), b)));
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

// Plassene den faste oppgaven gir i et tidsrom en dag (f.eks. vakten til en som er borte, som en
// vikar tar over): fasene tidsrommet overlapper og oppgaven trengs i, uten dem den ansatte har en
// plass i (den kopieres for seg).
export async function fasteFaser(db: Db, org: string, ansatt: string, dato: string, tid: RTid) {
  const fast = await en<{ oppgave_id: string }>(db, FASTE, [org, ansatt]);
  if (!fast) return [];
  const faser = await alle<RTid & { id: string }>(db, FASER, [org]);
  const oppgave = await en<{ behov: number | null }>(db, "select behov from faktura.tavle_oppgaver where org_id = $1 and id = $2", [org, fast.oppgave_id]);
  const behov = await alle<RBehov>(db, BEHOV, [org]);
  const har = new Set(
    (await alle<{ fase_id: string }>(db, "select fase_id from faktura.tavle_plasseringer where org_id = $1 and dato = $2 and ansatt_id = $3", [org, dato, ansatt])).map((p) => p.fase_id),
  );
  const trengs = (f: string) => behov.find((b) => b.fase_id === f && b.oppgave_id === fast.oppgave_id)?.antall ?? oppgave?.behov ?? null;
  return faser.filter((f) => iFasen(tid, f) && !har.has(f.id) && trengs(f.id) !== 0).map((f) => ({ fase_id: f.id, oppgave_id: fast.oppgave_id }));
}

// Plassene til én ansatt i perioden: de lagrede og de som kommer av den faste oppgaven, med
// navnet på fasen og oppgaven («Mine vakter» og AI-assistenten).
export async function egnePlasser(db: Db, org: string, ansatt: string, fra: string, til: string) {
  const lagret = await alle<{ dato: string; fase_id: string; oppgave_id: string }>(
    db,
    "select dato, fase_id, oppgave_id from faktura.tavle_plasseringer where org_id = $1 and ansatt_id = $2 and dato between $3 and $4",
    [org, ansatt, fra, til],
  );
  const alleP = [...lagret, ...(await fastePlasser(db, org, fra, til, ansatt))];
  if (!alleP.length) return [];
  const faser = await alle<{ id: string; navn: string; fra: string | null; til: string | null }>(db, FASER, [org]);
  const oppgaver = new Map((await alle<{ id: string; navn: string }>(db, OPPGAVER, [org])).map((o) => [o.id, o.navn]));
  const nr = new Map(faser.map((f, i) => [f.id, i]));
  return alleP
    .filter((p) => nr.has(p.fase_id) && oppgaver.has(p.oppgave_id))
    .sort((x, y) => x.dato.localeCompare(y.dato) || nr.get(x.fase_id)! - nr.get(y.fase_id)!)
    .map((p) => {
      const f = faser[nr.get(p.fase_id)!]!;
      return { dato: p.dato, fase: f.navn, fra: f.fra, til: f.til, oppgave: oppgaver.get(p.oppgave_id)! };
    });
}

export type RulleringValg = { fra: string; til: string; behold?: boolean; samme_hele_dagen?: boolean; lagre?: boolean };

// Rulleringen for perioden (også for AI-assistenten, som viser et sammendrag før den lagres).
export async function kjorRullering(db: Db, org: string, b: RulleringValg) {
  if (b.til < b.fra) throw new ApiFeil(400, "Slutten er før starten");
  if (dagerMellom(b.fra, b.til) > 30) throw new ApiFeil(400, "Velg en periode på høyst 31 dager");
  const behold = b.behold !== false;
  await db.query("select faktura.krev($1, 'personal')", [org]);
  const faser = await alle<RTid & { id: string; navn: string }>(db, FASER, [org]);
  const oppgaver = await alle<{ id: string; navn: string; behov: number | null }>(db, OPPGAVER, [org]);
  if (!faser.length || !oppgaver.length) throw new ApiFeil(400, "Sett opp fasene og oppgavene på tavla først");
  const start = leggTilDager(b.fra, -HISTORIKK_DAGER);
  const plasser = await alle<{ dato: string; fase_id: string; oppgave_id: string; ansatt_id: string; rullert: boolean }>(
    db,
    "select dato, fase_id, oppgave_id, ansatt_id, rullert from faktura.tavle_plasseringer where org_id = $1 and dato between $2 and $3",
    [org, start, b.til],
  );
  // Plassene før perioden er historikken, uten dem den ansatte var borte fra.
  const borte = await alle<{ ansatt_id: string; fra: string; til: string }>(db, "select ansatt_id, fra, til from faktura.fravaer where org_id = $1 and til >= $2 and fra < $3", [
    org,
    start,
    b.fra,
  ]);
  // De med en rolle som ikke er med på tavla, fordeles ikke (og plassene deres teller ikke).
  const utenfor = await utenforTavla(db, org);
  const historikk = plasser.filter((p) => p.dato < b.fra && !utenfor.has(p.ansatt_id) && !borte.some((f) => f.ansatt_id === p.ansatt_id && f.fra <= p.dato && f.til >= p.dato));
  const iPerioden = plasser.filter((p) => p.dato >= b.fra && !utenfor.has(p.ansatt_id));
  const staar = behold ? iPerioden.filter((p) => !p.rullert) : [];

  // De som er på jobb hver dag (som på tavla): vaktene og de faste arbeidsdagene, uten dem
  // som er borte eller ikke ansatt den dagen.
  const bem = await beregnBemanning(db, org, b.fra, b.til);
  const ansatt = new Map(bem.ansatte.map((a) => [a.id, a]));
  const ansattDag = (a: string, d: string) => {
    const x = ansatt.get(a);
    return !!x && x.aktiv && !utenfor.has(a) && d >= x.ansatt_fra && (!x.ansatt_til || d <= x.ansatt_til);
  };
  const dager: RDag[] = [];
  for (let d = b.fra; d <= b.til; d = leggTilDager(d, 1)) {
    const folk = new Map<string, RTid[]>();
    const leggTil = (a: string, v: RTid) => folk.set(a, [...(folk.get(a) ?? []), v]);
    for (const v of bem.vakter) if (v.dato === d && !v.borte && ansattDag(v.ansatt_id, d)) leggTil(v.ansatt_id, { fra: v.fra, til: v.til });
    for (const f of bem.faste) if (f.dato === d && !f.fravaer && ansattDag(f.ansatt_id, d)) leggTil(f.ansatt_id, { fra: f.fra, til: f.til });
    dager.push({
      dato: d,
      folk: [...folk].map(([ansatt_id, vakter]) => ({ ansatt_id, vakter })),
      faste: staar.filter((p) => p.dato === d),
    });
  }

  const r = rullere({
    faser,
    oppgaver,
    behov: await alle(db, BEHOV, [org]),
    utelatt: await alle(db, UTELATT, [org]),
    fast: (await alle<{ ansatt_id: string; oppgave_id: string }>(db, FASTE, [org, null])).filter((x) => !utenfor.has(x.ansatt_id)),
    dager,
    historikk,
    sammeHeleDagen: !!b.samme_hele_dagen,
  });

  // Hvor mange plasser som blir annerledes enn før (nye, flyttet eller tatt bort).
  const nokkel = (p: { dato: string; fase_id: string; ansatt_id: string }) => `${p.dato}|${p.fase_id}|${p.ansatt_id}`;
  const foer = new Map(iPerioden.map((p) => [nokkel(p), p.oppgave_id]));
  const etter = new Map([...staar, ...r.plasser].map((p) => [nokkel(p), p.oppgave_id]));
  const endret = [...new Set([...foer.keys(), ...etter.keys()])].filter((k) => foer.get(k) !== etter.get(k)).length;

  if (b.lagre) {
    await db.query("delete from faktura.tavle_plasseringer where org_id = $1 and dato between $2 and $3 and (rullert or not $4)", [org, b.fra, b.til, behold]);
    if (r.plasser.length)
      await db.query(
        `insert into faktura.tavle_plasseringer (org_id, dato, fase_id, oppgave_id, ansatt_id, rullert)
         select $1, x.dato, x.fase_id, x.oppgave_id, x.ansatt_id, true
           from jsonb_to_recordset($2::jsonb) as x(dato date, fase_id uuid, oppgave_id uuid, ansatt_id uuid)`,
        [org, JSON.stringify(r.plasser)],
      );
  }

  // Dagene slik de blir: plassene som teller (de som er på jobb i fasen), de som står uten
  // plass, og behovet som ikke er dekket.
  const fase = new Map(faser.map((f) => [f.id, f]));
  const navn = new Set<string>();
  const svarDager = dager.map((d) => {
    const vakter = new Map(d.folk.map((p) => [p.ansatt_id, p.vakter]));
    const teller = (p: { fase_id: string; ansatt_id: string }) => !!vakter.get(p.ansatt_id)?.some((v) => iFasen(v, fase.get(p.fase_id)!));
    const dagens = [
      ...d.faste.filter(teller).map((p) => ({ fase_id: p.fase_id, oppgave_id: p.oppgave_id, ansatt_id: p.ansatt_id, rullert: false })),
      ...r.plasser.filter((p) => p.dato === d.dato).map((p) => ({ fase_id: p.fase_id, oppgave_id: p.oppgave_id, ansatt_id: p.ansatt_id, rullert: true })),
    ];
    const ikke = r.ikkePlassert.filter((p) => p.dato === d.dato).map(({ fase_id, ansatt_id }) => ({ fase_id, ansatt_id }));
    for (const p of [...dagens, ...ikke]) navn.add(p.ansatt_id);
    return {
      dato: d.dato,
      plasser: dagens,
      ikke_plassert: ikke,
      mangler: r.mangler.filter((m) => m.dato === d.dato).map(({ fase_id, oppgave_id, antall }) => ({ fase_id, oppgave_id, antall })),
    };
  });
  return {
    fra: b.fra,
    til: b.til,
    lagret: !!b.lagre,
    plasser: r.plasser.length,
    endret,
    faser: faser.map(({ id, navn }) => ({ id, navn })),
    oppgaver: oppgaver.map(({ id, navn }) => ({ id, navn })),
    ansatte: [...navn].map((a) => ({ id: a, navn: ansatt.get(a)?.navn ?? "" })).sort((x, y) => x.navn.localeCompare(y.navn, "nb")),
    dager: svarDager,
  };
}
