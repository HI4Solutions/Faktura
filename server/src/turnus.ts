// Turnus i vaktplanen (0106_turnus.sql): vakttypene (dag, kveld, natt …), bemanningsbehovet per
// vakttype og ukedag, reglene og hvem som går hvilke vakttyper, og automatisk turnus
// (turnusplan.ts): et forslag for en periode, som kan legges inn som utkast i vaktplanen. En ny
// kjøring kan erstatte utkastene fra de forrige (vakter som er endret for hånd eller publisert,
// står), og en kjøring kan angres. Vaktene publiseres som før, med varsel til de ansatte.
import { Hono, type Context } from "hono";
import { z } from "zod";
import { alle, en, somBruker, type Db } from "./db.js";
import { ApiFeil } from "./feil.js";
import { datoS, klokke, regler as oppsettRegler, tekst } from "./ansatte.js";
import { beregnBemanning } from "./arbeidsplan.js";
import { planlegg, type TForslag, type TInn, type TRegler, type TVakt } from "./turnusplan.js";
import { iDag } from "./regler.js";

const uuid = z.string().uuid();
const orgId = (c: Context) => uuid.parse(c.req.param("org"));
const id = (c: Context) => uuid.parse(c.req.param("id"));
const bruk = <T>(c: Context, fn: (db: Db) => Promise<T>) => somBruker<T>(c.get("bruker").id, fn);
const leggTil = (iso: string, n: number) => new Date(Date.parse(`${iso}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const dagerMellom = (a: string, b: string) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86_400_000);

export const STANDARDREGLER = { hvile: 11, dager_paa_rad: 5, netter_paa_rad: 3, helg: 3 };

const vakttypeSkjema = z.object({
  navn: tekst(40, "Navnet").min(1, "Skriv navnet på vakttypen"),
  kode: z
    .string()
    .trim()
    .min(1, "Skriv en kode, f.eks. D")
    .max(3, "Koden kan ha høyst 3 tegn")
    .regex(/^[A-Za-z0-9ÆØÅæøå]+$/, "Koden kan bare ha bokstaver og tall")
    .transform((s) => s.toUpperCase()),
  fra: klokke,
  til: klokke,
  pause_min: z.number().int().min(0, "Pausen kan ikke være negativ").max(600, "Pausen kan være høyst 10 timer").optional(),
  farge: z.number().int().min(0).max(7).optional(),
  aktiv: z.boolean().optional(),
  rekkefolge: z.number().int().min(0).max(1000).optional(),
});

const reglerSkjema = z.object({
  hvile: z.number().min(8, "Hvilen kan ikke være under 8 timer").max(24, "Hvilen kan være høyst 24 timer"),
  dager_paa_rad: z.number().int().min(1).max(14, "Høyst 14 dager på rad"),
  netter_paa_rad: z.number().int().min(1).max(14, "Høyst 14 netter på rad"),
  helg: z.number().int().min(1).max(6, "Høyst hver sjette helg"),
});

const kjoringSkjema = z.object({
  fra: datoS,
  til: datoS,
  // Bare disse (ellers alle som går i turnusen).
  ansatte: z.array(uuid).max(500).optional(),
  // Erstatt utkastene fra tidligere kjøringer i perioden (standard).
  erstatt: z.boolean().optional(),
  // Lag ledige vakter for det som ikke kan fylles (standard).
  ledige: z.boolean().optional(),
});

type Vakttype = { id: string; navn: string; kode: string; fra: string; til: string; pause_min: number; timer: number; farge: number; aktiv: boolean; rekkefolge: number };
const VAKTTYPE = `select id, navn, kode, to_char(fra, 'HH24:MI') as fra, to_char(til, 'HH24:MI') as til, pause_min, timer::float8 as timer, farge, aktiv, rekkefolge
                    from faktura.vakttyper`;

export async function turnusRegler(db: Db, org: string) {
  const r = await en<{ hvile: number; dager_paa_rad: number; netter_paa_rad: number; helg: number }>(
    db,
    "select hvile::float8 as hvile, dager_paa_rad, netter_paa_rad, helg from faktura.turnus_regler where org_id = $1",
    [org],
  );
  return r ?? STANDARDREGLER;
}

// Alt planleggeren trenger for perioden. Med erstatt regnes utkastene fra tidligere kjøringer i
// perioden som borte (de slettes før innleggingen).
async function grunnlag(db: Db, org: string, b: z.infer<typeof kjoringSkjema>): Promise<TInn> {
  const fra = leggTil(b.fra, -42);
  const til = leggTil(b.til, 14);
  const erstatt = b.erstatt !== false;
  const turnus = await turnusRegler(db, org);
  const oppsett = await oppsettRegler(db, org);
  const regler: TRegler = { ...turnus, ukentlig_grense: Number(oppsett.ukentlig_grense) };
  const vakttyper = await alle<Vakttype>(db, `${VAKTTYPE} where org_id = $1 and aktiv order by rekkefolge, fra`, [org]);
  const behov = await alle<{ vakttype_id: string; ukedag: number; rolle_id: string | null; antall: number }>(
    db,
    "select vakttype_id, ukedag, rolle_id, antall from faktura.vakttype_behov where org_id = $1",
    [org],
  );
  const personer = await alle<TInn["personer"][number] & { ansettelsestype: string }>(
    db,
    `select a.id, a.fornavn || ' ' || a.etternavn as navn, a.gruppe_id as rolle_id, a.ansatt_fra::text as ansatt_fra, a.ansatt_til::text as ansatt_til,
            a.arbeidstaker, a.ansettelsestype,
            case when a.ansettelsestype = 'tilkalling' then 0 else (a.ukentlig_arbeidstid * a.stillingsprosent / 100)::float8 end as avtalt,
            coalesce(array_agg(av.vakttype_id::text) filter (where av.vakttype_id is not null), '{}'::text[]) as vakttyper
       from faktura.ansatte a
       join faktura.ansatt_vakttyper av on av.org_id = a.org_id and av.ansatt_id = a.id
      where a.org_id = $1 and a.aktiv and a.ansatt_fra <= $3 and (a.ansatt_til is null or a.ansatt_til >= $2)
        and ($4::uuid[] is null or a.id = any($4))
      group by a.id
      order by a.etternavn, a.fornavn`,
    [org, b.fra, b.til, b.ansatte ?? null],
  );
  const vakter = await alle<TVakt>(
    db,
    `select ansatt_id, dato::text as dato, to_char(fra, 'HH24:MI') as fra, to_char(til, 'HH24:MI') as til, timer::float8 as timer, vakttype_id, rolle_id
       from faktura.vakter
      where org_id = $1 and dato between $2 and $3
        and not ($6 and turnus_id is not null and publisert_at is null and dato between $4 and $5)`,
    [org, fra, til, b.fra, b.til, erstatt],
  );
  // De faste arbeidsdagene (arbeidsplanen) opptar dagen som en vakt (en hel dag fra kl. 08).
  const bemanning = await beregnBemanning(db, org, fra, til);
  const timeplan = new Map(personer.map((p) => [p.id, p]));
  for (const f of bemanning.faste) {
    if (!timeplan.has(f.ansatt_id) || f.fravaer) continue;
    const start = f.fra ?? "08:00";
    const slutt = f.til ?? klokkeslett(8 * 60 + Math.round(Number(f.timer) * 60));
    vakter.push({ ansatt_id: f.ansatt_id, dato: f.dato, fra: start, til: slutt, timer: Number(f.timer), vakttype_id: null, rolle_id: null });
  }
  const fravaer = await alle<{ ansatt_id: string; fra: string; til: string }>(
    db,
    "select ansatt_id, fra::text as fra, til::text as til from faktura.fravaer where org_id = $1 and til >= $2 and fra <= $3",
    [org, fra, til],
  );
  return { fra: b.fra, til: b.til, vakttyper, behov, personer, vakter, fravaer, regler, ledige: b.ledige !== false };
}

const klokkeslett = (m: number) => `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

function sjekkPeriode(b: { fra: string; til: string }) {
  if (b.til < b.fra) throw new ApiFeil(400, "Slutten er før starten");
  if (dagerMellom(b.fra, b.til) > 91) throw new ApiFeil(400, "Velg en periode på høyst 13 uker");
  if (b.fra < iDag()) throw new ApiFeil(400, "Turnusen kan ikke starte før i dag");
}

// Forslaget, med navnene og kodene til visningen.
async function lagForslag(db: Db, org: string, b: z.infer<typeof kjoringSkjema>) {
  const inn = await grunnlag(db, org, b);
  if (!inn.vakttyper.length) throw new ApiFeil(400, "Legg inn vakttypene først (f.eks. dag, kveld og natt)");
  if (!inn.behov.length) throw new ApiFeil(400, "Legg inn hvor mange som trengs på hver vakttype først");
  if (!inn.personer.length) throw new ApiFeil(400, "Velg hvem som går hvilke vakttyper først");
  const forslag = planlegg(inn);
  const erstattes = b.erstatt === false
    ? 0
    : (await en<{ n: number }>(
        db,
        "select count(*)::int as n from faktura.vakter where org_id = $1 and dato between $2 and $3 and turnus_id is not null and publisert_at is null",
        [org, b.fra, b.til],
      ))!.n;
  return { forslag, erstattes };
}

export function turnusRuter() {
  const r = new Hono();

  // Oppsettet: vakttypene (alle som ser planen), og for dem som ser de ansatte også behovet,
  // reglene, hvem som går hvilke vakttyper og de siste kjøringene.
  r.get("/turnus", async (c) =>
    c.json(
      await bruk(c, async (db) => {
        await db.query("select faktura.krev($1, 'plan')", [orgId(c)]);
        const vakttyper = await alle<Vakttype>(db, `${VAKTTYPE} where org_id = $1 order by not aktiv, rekkefolge, fra`, [orgId(c)]);
        const behov = await alle(db, "select vakttype_id, ukedag, rolle_id, antall from faktura.vakttype_behov where org_id = $1 order by ukedag", [orgId(c)]);
        const regler = await turnusRegler(db, orgId(c));
        const helPlan = (await en<{ k: boolean }>(db, "select faktura.kan($1, 'personal_les') as k", [orgId(c)]))!.k;
        if (!helPlan) return { vakttyper, behov, regler, ansatte: [], kjoringer: [] };
        const ansatte = await alle(
          db,
          `select a.id, a.fornavn || ' ' || a.etternavn as navn, a.gruppe_id as rolle_id, a.aktiv, a.ansettelsestype,
                  (a.ukentlig_arbeidstid * a.stillingsprosent / 100)::float8 as avtalt,
                  coalesce((select array_agg(av.vakttype_id::text) from faktura.ansatt_vakttyper av where av.org_id = a.org_id and av.ansatt_id = a.id), '{}'::text[]) as vakttyper
             from faktura.ansatte a
            where a.org_id = $1 and a.aktiv and (a.ansatt_til is null or a.ansatt_til >= $2)
            order by a.etternavn, a.fornavn`,
          [orgId(c), iDag()],
        );
        const kjoringer = await alle(
          db,
          `select k.id, k.fra::text as fra, k.til::text as til, k.vakter, k.ledige, k.hull, k.opprettet,
                  (select count(*)::int from faktura.vakter v where v.org_id = k.org_id and v.turnus_id = k.id and v.publisert_at is null) as utkast,
                  (select count(*)::int from faktura.vakter v where v.org_id = k.org_id and v.turnus_id = k.id and v.publisert_at is not null) as publisert
             from faktura.turnus_kjoringer k
            where k.org_id = $1
            order by k.opprettet desc
            limit 5`,
          [orgId(c)],
        );
        return { vakttyper, behov, regler, ansatte, kjoringer };
      }),
    ),
  );

  r.post("/turnus/vakttyper", async (c) => {
    const b = vakttypeSkjema.parse(await c.req.json().catch(() => ({})));
    const t = await bruk(c, async (db) => {
      await db.query("select faktura.krev($1, 'personal')", [orgId(c)]);
      const rekkefolge =
        b.rekkefolge ?? (await en<{ n: number }>(db, "select coalesce(max(rekkefolge) + 1, 0)::int as n from faktura.vakttyper where org_id = $1", [orgId(c)]))!.n;
      const ny = (await en<{ id: string }>(
        db,
        `insert into faktura.vakttyper (org_id, navn, kode, fra, til, pause_min, farge, aktiv, rekkefolge)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
        [orgId(c), b.navn, b.kode, b.fra, b.til, b.pause_min ?? 0, b.farge ?? rekkefolge % 8, b.aktiv ?? true, rekkefolge],
      ))!;
      return en<Vakttype>(db, `${VAKTTYPE} where id = $1`, [ny.id]);
    });
    return c.json(t, 201);
  });

  // Endre en vakttype. Vaktene som har den, beholder klokkeslettene sine.
  r.patch("/turnus/vakttyper/:id", async (c) => {
    const b = vakttypeSkjema.partial().parse(await c.req.json().catch(() => ({})));
    const felt = Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined));
    const navn = Object.keys(felt);
    if (!navn.length) throw new ApiFeil(400, "Ingen felt å endre");
    const t = await bruk(c, async (db) => {
      await db.query("select faktura.krev($1, 'personal')", [orgId(c)]);
      const rad = await en<{ id: string }>(
        db,
        `update faktura.vakttyper set ${navn.map((k, i) => `${k} = $${i + 3}`).join(", ")} where org_id = $1 and id = $2 returning id`,
        [orgId(c), id(c), ...navn.map((k) => felt[k])],
      );
      if (!rad) throw new ApiFeil(404, "Fant ikke vakttypen");
      return en<Vakttype>(db, `${VAKTTYPE} where id = $1`, [id(c)]);
    });
    return c.json(t);
  });

  // Slett en vakttype: vaktene beholder klokkeslettene, og behovet og valgene for den forsvinner.
  r.delete("/turnus/vakttyper/:id", async (c) => {
    await bruk(c, async (db) => {
      await db.query("select faktura.krev($1, 'personal')", [orgId(c)]);
      const rad = await en(db, "delete from faktura.vakttyper where org_id = $1 and id = $2 returning id", [orgId(c), id(c)]);
      if (!rad) throw new ApiFeil(404, "Fant ikke vakttypen");
    });
    return c.body(null, 204);
  });

  // Bemanningsbehovet, hele på én gang: hvor mange på hver vakttype hver ukedag (med eller uten
  // rolle). Det som ikke er med, trengs ikke.
  r.put("/turnus/behov", async (c) => {
    const b = z
      .object({
        behov: z
          .array(z.object({ vakttype_id: uuid, ukedag: z.number().int().min(1).max(7), rolle_id: uuid.nullable().optional(), antall: z.number().int().min(0).max(50, "Høyst 50 på én vakt") }))
          .max(2000),
      })
      .parse(await c.req.json().catch(() => ({})));
    const n = await bruk(c, async (db) => {
      await db.query("select faktura.krev($1, 'personal')", [orgId(c)]);
      await db.query("delete from faktura.vakttype_behov where org_id = $1", [orgId(c)]);
      const rader = b.behov.filter((x) => x.antall > 0);
      const nokler = new Set<string>();
      for (const x of rader) {
        const k = `${x.vakttype_id}:${x.ukedag}:${x.rolle_id ?? ""}`;
        if (nokler.has(k)) throw new ApiFeil(400, "Det samme behovet er med to ganger");
        nokler.add(k);
      }
      if (rader.length)
        await db.query(
          `insert into faktura.vakttype_behov (org_id, vakttype_id, ukedag, rolle_id, antall)
           select $1, x.vakttype_id, x.ukedag, x.rolle_id, x.antall
             from json_to_recordset($2::json) as x(vakttype_id uuid, ukedag int, rolle_id uuid, antall int)`,
          [orgId(c), JSON.stringify(rader.map((x) => ({ ...x, rolle_id: x.rolle_id ?? null })))],
        );
      return rader.length;
    });
    return c.json({ behov: n });
  });

  r.put("/turnus/regler", async (c) => {
    const b = reglerSkjema.parse(await c.req.json().catch(() => ({})));
    const regler = await bruk(c, async (db) => {
      await db.query("select faktura.krev($1, 'personal')", [orgId(c)]);
      await db.query(
        `insert into faktura.turnus_regler (org_id, hvile, dager_paa_rad, netter_paa_rad, helg) values ($1, $2, $3, $4, $5)
         on conflict (org_id) do update set hvile = excluded.hvile, dager_paa_rad = excluded.dager_paa_rad,
           netter_paa_rad = excluded.netter_paa_rad, helg = excluded.helg`,
        [orgId(c), b.hvile, b.dager_paa_rad, b.netter_paa_rad, b.helg],
      );
      return turnusRegler(db, orgId(c));
    });
    return c.json(regler);
  });

  // Hvem som går hvilke vakttyper: for de ansatte som er med, erstatter valgene de hadde.
  r.put("/turnus/ansatte", async (c) => {
    const b = z
      .object({ ansatte: z.array(z.object({ ansatt_id: uuid, vakttyper: z.array(uuid).max(50) })).max(1000) })
      .parse(await c.req.json().catch(() => ({})));
    await bruk(c, async (db) => {
      await db.query("select faktura.krev($1, 'personal')", [orgId(c)]);
      const ider = b.ansatte.map((a) => a.ansatt_id);
      await db.query("delete from faktura.ansatt_vakttyper where org_id = $1 and ansatt_id = any($2::uuid[])", [orgId(c), ider]);
      const rader = b.ansatte.flatMap((a) => [...new Set(a.vakttyper)].map((v) => ({ ansatt_id: a.ansatt_id, vakttype_id: v })));
      if (rader.length)
        await db.query(
          `insert into faktura.ansatt_vakttyper (org_id, ansatt_id, vakttype_id)
           select $1, x.ansatt_id, x.vakttype_id from json_to_recordset($2::json) as x(ansatt_id uuid, vakttype_id uuid)`,
          [orgId(c), JSON.stringify(rader)],
        );
    });
    return c.body(null, 204);
  });

  // Forslaget for perioden: ingenting lagres.
  r.post("/turnus/forslag", async (c) => {
    const b = kjoringSkjema.parse(await c.req.json().catch(() => ({})));
    sjekkPeriode(b);
    return c.json(
      await bruk(c, async (db) => {
        await db.query("select faktura.krev($1, 'personal')", [orgId(c)]);
        return lagForslag(db, orgId(c), b);
      }),
    );
  });

  // Legg forslaget inn som utkast i vaktplanen (de ansatte ser dem når de publiseres). Med erstatt
  // (standard) slettes først utkastene fra tidligere kjøringer i perioden.
  r.post("/turnus/kjoringer", async (c) => {
    const b = kjoringSkjema.parse(await c.req.json().catch(() => ({})));
    sjekkPeriode(b);
    const svar = await bruk(c, async (db) => {
      await db.query("select faktura.krev($1, 'personal')", [orgId(c)]);
      const { forslag, erstattes } = await lagForslag(db, orgId(c), b);
      if (b.erstatt !== false) {
        await db.query(
          "delete from faktura.vakter where org_id = $1 and dato between $2 and $3 and turnus_id is not null and publisert_at is null",
          [orgId(c), b.fra, b.til],
        );
        // Kjøringer uten vakter igjen, er erstattet.
        await db.query(
          "delete from faktura.turnus_kjoringer k where k.org_id = $1 and not exists (select 1 from faktura.vakter v where v.org_id = k.org_id and v.turnus_id = k.id)",
          [orgId(c)],
        );
      }
      return lagre(db, orgId(c), b, forslag, erstattes);
    });
    return c.json(svar, 201);
  });

  // Angre en kjøring: utkastene den laget, slettes; de som er publisert, står.
  r.delete("/turnus/kjoringer/:id", async (c) => {
    const svar = await bruk(c, async (db) => {
      await db.query("select faktura.krev($1, 'personal')", [orgId(c)]);
      const k = await en(db, "select id from faktura.turnus_kjoringer where org_id = $1 and id = $2", [orgId(c), id(c)]);
      if (!k) throw new ApiFeil(404, "Fant ikke kjøringen");
      const slettet = await alle(db, "delete from faktura.vakter where org_id = $1 and turnus_id = $2 and publisert_at is null returning id", [orgId(c), id(c)]);
      const publisert = (await en<{ n: number }>(db, "select count(*)::int as n from faktura.vakter where org_id = $1 and turnus_id = $2", [orgId(c), id(c)]))!.n;
      await db.query("delete from faktura.turnus_kjoringer where org_id = $1 and id = $2", [orgId(c), id(c)]);
      return { slettet: slettet.length, publisert };
    });
    return c.json(svar);
  });

  return r;
}

async function lagre(db: Db, org: string, b: { fra: string; til: string }, forslag: TForslag, erstattet: number) {
  const medAnsatt = forslag.vakter.filter((v) => v.ansatt_id).length;
  const ledige = forslag.vakter.length - medAnsatt;
  const hull = forslag.hull.reduce((s, h) => s + h.antall, 0) - ledige;
  const k = (await en<{ id: string }>(
    db,
    "insert into faktura.turnus_kjoringer (org_id, fra, til, vakter, ledige, hull) values ($1, $2, $3, $4, $5, $6) returning id",
    [org, b.fra, b.til, medAnsatt, ledige, Math.max(0, hull)],
  ))!;
  if (forslag.vakter.length)
    await db.query(
      `insert into faktura.vakter (org_id, ansatt_id, dato, fra, til, pause_min, vakttype_id, rolle_id, turnus_id)
       select $1, x.ansatt_id, x.dato, x.fra, x.til, x.pause_min, x.vakttype_id, x.rolle_id, $2
         from json_to_recordset($3::json) as x(ansatt_id uuid, dato date, fra time, til time, pause_min int, vakttype_id uuid, rolle_id uuid)`,
      [org, k.id, JSON.stringify(forslag.vakter)],
    );
  return { kjoring_id: k.id, vakter: medAnsatt, ledige, hull: Math.max(0, hull), erstattet, personer: forslag.personer };
}
