// Naturalytelsene til en ansatt (0083_naturalytelser_reiser.sql, naturalytelser.ts): lista med
// fordelen denne måneden og antall godkjente kjøringer de er med i, og nye, endrede og fjernede.
// De som ser lønnen, og den ansatte selv, ser dem; eier og administrator endrer dem.
import { Hono, type Context } from "hono";
import { z } from "zod";
import { alle, en, somBruker, type Db } from "./db.js";
import { ApiFeil } from "./feil.js";
import { iDag } from "./regler.js";
import { maanedsfordel, type Naturalytelse } from "./naturalytelser.js";

const uuid = z.string().uuid();
const datoS = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Ugyldig dato");
const orgId = (c: Context) => uuid.parse(c.req.param("org"));
const bruk = <T>(c: Context, fn: (db: Db) => Promise<T>) => somBruker<T>(c.get("bruker").id, fn);
const tom = (v: unknown) => (typeof v === "string" && !v.trim() ? null : v);

const skjema = z
  .object({
    type: z.enum(["bil", "ek", "forsikring", "rentefordel", "bolig", "annet"], { error: "Velg hva slags naturalytelse det er" }),
    tekst: z.preprocess(tom, z.string().trim().max(100, "Beskrivelsen kan ha høyst 100 tegn").nullish()),
    belop: z.number().positive("Beløpet må være over 0").max(10_000_000).nullish(),
    listepris: z.number().positive("Listeprisen må være over 0").max(100_000_000).nullish(),
    regnr: z.preprocess(
      (v) => (typeof v === "string" ? v.replace(/[\s-]/g, "").toUpperCase() || null : v),
      z.string().regex(/^[A-ZÆØÅ0-9]{2,10}$/, "Registreringsnummeret har 2–10 bokstaver og tall").nullish(),
    ),
    bilpool: z.boolean().optional(),
    forstegangsreg: z.preprocess(tom, datoS.nullish()),
    yrkeskjoring: z.boolean().optional(),
    laan: z.number().positive("Lånet må være over 0").max(1_000_000_000).nullish(),
    rente: z.number().min(0, "Renten kan ikke være negativ").max(100, "Renten kan være høyst 100 %").nullish(),
    fra: datoS,
    til: z.preprocess(tom, datoS.nullish()),
  })
  .refine((b) => b.type !== "bil" || b.listepris != null, { message: "Skriv listeprisen for bilen som ny" })
  .refine((b) => b.type !== "bil" || !!b.regnr || !!b.bilpool, { message: "Skriv registreringsnummeret (eller velg bilpool)" })
  .refine((b) => b.type !== "rentefordel" || (b.laan != null && b.rente != null), { message: "Skriv lånet og renten den ansatte betaler" })
  .refine((b) => ["bil", "ek", "rentefordel"].includes(b.type) || b.belop != null, { message: "Skriv beløpet per måned" })
  .refine((b) => !b.til || b.til >= b.fra, { message: "Til-datoen er før fra-datoen" });

// Feltene som lagres (det som ikke hører til typen, tømmes).
function felt(b: z.infer<typeof skjema>) {
  const bil = b.type === "bil";
  const rente = b.type === "rentefordel";
  return {
    type: b.type,
    tekst: b.tekst ?? null,
    belop: bil || rente ? null : (b.belop ?? null),
    listepris: bil ? (b.listepris ?? null) : null,
    regnr: bil && !b.bilpool ? (b.regnr ?? null) : null,
    bilpool: bil && !!b.bilpool,
    forstegangsreg: bil ? (b.forstegangsreg ?? null) : null,
    yrkeskjoring: bil && !!b.yrkeskjoring,
    laan: rente ? (b.laan ?? null) : null,
    rente: rente ? (b.rente ?? null) : null,
    fra: b.fra,
    til: b.til ?? null,
  };
}
const FELT = ["type", "tekst", "belop", "listepris", "regnr", "bilpool", "forstegangsreg", "yrkeskjoring", "laan", "rente", "fra", "til"] as const;

// Naturalytelsene til en ansatt, med fordelen denne måneden og antall godkjente kjøringer de er med i.
async function liste(db: Db, org: string, ansatt: string) {
  const rader = await alle<Naturalytelse & { brukt: number }>(
    db,
    `select n.id, n.ansatt_id, n.type, n.tekst, n.belop::float8 as belop, n.listepris::float8 as listepris, n.regnr, n.bilpool,
            to_char(n.forstegangsreg, 'YYYY-MM-DD') as forstegangsreg, n.yrkeskjoring, n.laan::float8 as laan, n.rente::float8 as rente,
            to_char(n.fra, 'YYYY-MM-DD') as fra, to_char(n.til, 'YYYY-MM-DD') as til,
            (select count(distinct k.id) from faktura.lonnslinjer l join faktura.lonnsslipper s on s.id = l.slipp_id join faktura.lonnskjoringer k on k.id = s.kjoring_id
              where l.org_id = n.org_id and l.nokkel = 'natural:' || n.id::text and not l.fjernet and k.status = 'godkjent')::int as brukt
       from faktura.naturalytelser n where n.org_id = $1 and n.ansatt_id = $2
      order by n.til is not null and n.til < faktura.i_dag(), n.fra, n.opprettet`,
    [org, ansatt],
  );
  const maaned = `${iDag().slice(0, 7)}-01`;
  return rader.map((n) => {
    const f = maanedsfordel(n, maaned);
    return { ...n, maaned: f.belop, beskrivelse: f.tekst, merknad: f.merknad };
  });
}

export function naturalytelserRuter() {
  const r = new Hono();
  const ansatt = (c: Context) => uuid.parse(c.req.param("ansatt"));

  r.get("/ansatte/:ansatt/naturalytelser", async (c) => c.json(await bruk(c, (db) => liste(db, orgId(c), ansatt(c)))));

  r.post("/ansatte/:ansatt/naturalytelser", async (c) => {
    const b = felt(skjema.parse(await c.req.json().catch(() => ({}))));
    return c.json(
      await bruk(c, async (db) => {
        await db.query("select faktura.krev($1, 'personal')", [orgId(c)]);
        if (!(await en(db, "select 1 from faktura.ansatte where org_id = $1 and id = $2", [orgId(c), ansatt(c)]))) throw new ApiFeil(404, "Fant ikke den ansatte");
        await db.query(
          `insert into faktura.naturalytelser (org_id, ansatt_id, ${FELT.join(", ")}) values ($1, $2, ${FELT.map((_, i) => `$${i + 3}`).join(", ")})`,
          [orgId(c), ansatt(c), ...FELT.map((f) => b[f])],
        );
        return liste(db, orgId(c), ansatt(c));
      }),
      201,
    );
  });

  r.put("/ansatte/:ansatt/naturalytelser/:id", async (c) => {
    const b = felt(skjema.parse(await c.req.json().catch(() => ({}))));
    const nid = uuid.parse(c.req.param("id"));
    return c.json(
      await bruk(c, async (db) => {
        await db.query("select faktura.krev($1, 'personal')", [orgId(c)]);
        const res = await db.query(
          `update faktura.naturalytelser set ${FELT.map((f, i) => `${f} = $${i + 4}`).join(", ")} where org_id = $1 and ansatt_id = $2 and id = $3`,
          [orgId(c), ansatt(c), nid, ...FELT.map((f) => b[f])],
        );
        if (!res.rowCount) throw new ApiFeil(404, "Fant ikke naturalytelsen");
        return liste(db, orgId(c), ansatt(c));
      }),
    );
  });

  // En naturalytelse som er med i en godkjent kjøring, avsluttes etter den siste måneden den er med
  // i (den står i kjøringene); ellers slettes den.
  r.delete("/ansatte/:ansatt/naturalytelser/:id", async (c) => {
    const nid = uuid.parse(c.req.param("id"));
    return c.json(
      await bruk(c, async (db) => {
        await db.query("select faktura.krev($1, 'personal')", [orgId(c)]);
        const n = await en<{ sist: string | null }>(
          db,
          `select (select to_char(max((k.periode + interval '1 month' - interval '1 day')::date), 'YYYY-MM-DD')
                     from faktura.lonnslinjer l join faktura.lonnsslipper s on s.id = l.slipp_id join faktura.lonnskjoringer k on k.id = s.kjoring_id
                    where l.org_id = n.org_id and l.nokkel = 'natural:' || n.id::text and k.status = 'godkjent') as sist
             from faktura.naturalytelser n where n.org_id = $1 and n.ansatt_id = $2 and n.id = $3`,
          [orgId(c), ansatt(c), nid],
        );
        if (!n) throw new ApiFeil(404, "Fant ikke naturalytelsen");
        if (n.sist) await db.query("update faktura.naturalytelser set til = $2 where id = $1", [nid, n.sist]);
        else await db.query("delete from faktura.naturalytelser where org_id = $1 and id = $2", [orgId(c), nid]);
        return liste(db, orgId(c), ansatt(c));
      }),
    );
  });

  return r;
}
