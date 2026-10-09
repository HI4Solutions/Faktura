// De faste trekkene i lønnen til en ansatt (0082_lonnstrekk.sql, lonnstrekk.ts): lista med det som
// er trukket i godkjente kjøringer, og nye, endrede og fjernede trekk. De som ser lønnen, og den
// ansatte selv, ser trekkene; eier og administrator endrer dem.
import { Hono, type Context } from "hono";
import { z } from "zod";
import { alle, en, somBruker, type Db } from "./db.js";
import { ApiFeil } from "./feil.js";
import { kontonrGyldig } from "./regler.js";

const uuid = z.string().uuid();
const datoS = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Ugyldig dato");
const orgId = (c: Context) => uuid.parse(c.req.param("org"));
const bruk = <T>(c: Context, fn: (db: Db) => Promise<T>) => somBruker<T>(c.get("bruker").id, fn);
const tom = (v: unknown) => (typeof v === "string" && !v.trim() ? null : v);

const trekkSkjema = z
  .object({
    type: z.enum(["utlegg_samordnet", "utlegg_skatt", "utlegg_annet", "bidrag", "fagforening", "forskudd", "annet"], { error: "Velg hva slags trekk det er" }),
    tekst: z.preprocess(tom, z.string().trim().max(100, "Beskrivelsen kan ha høyst 100 tegn").nullish()),
    belop: z.number().positive("Beløpet må være over 0").max(10_000_000).nullish(),
    prosent: z.number().positive("Prosenten må være over 0").max(100, "Prosenten kan være høyst 100").nullish(),
    totalt: z.number().positive("Summen må være over 0").max(100_000_000).nullish(),
    fra: datoS,
    til: z.preprocess(tom, datoS.nullish()),
    mottaker: z.preprocess(tom, z.string().trim().max(140).nullish()),
    kontonr: z.preprocess(
      (v) => (typeof v === "string" ? v.replace(/[\s.]/g, "") || null : v),
      z.string().regex(/^\d{11}$/, "Kontonummeret har 11 siffer").refine(kontonrGyldig, "Kontonummeret er ikke gyldig (sjekk sifrene)").nullish(),
    ),
    kid: z.preprocess((v) => (typeof v === "string" ? v.replace(/\s/g, "") || null : v), z.string().regex(/^\d{2,25}$/, "KID-en har bare siffer (2–25)").nullish()),
    melding: z.preprocess(tom, z.string().trim().max(140).nullish()),
  })
  .refine((b) => (b.belop != null) !== (b.prosent != null), { message: "Skriv enten et beløp eller en prosent av bruttolønnen" })
  .refine((b) => !b.til || b.til >= b.fra, { message: "Til-datoen er før fra-datoen" })
  .refine((b) => !b.kid || !b.melding, { message: "Bruk enten KID eller en melding til mottakeren" });

const FELT = ["type", "tekst", "belop", "prosent", "totalt", "fra", "til", "mottaker", "kontonr", "kid", "melding"] as const;

// Trekkene til en ansatt, med det som er trukket i godkjente kjøringer.
function liste(db: Db, org: string, ansatt: string) {
  return alle(
    db,
    `select t.id, t.type, t.tekst, t.belop::float8 as belop, t.prosent::float8 as prosent, t.totalt::float8 as totalt,
            to_char(t.fra, 'YYYY-MM-DD') as fra, to_char(t.til, 'YYYY-MM-DD') as til, t.mottaker, t.kontonr, t.kid, t.melding,
            coalesce((select -sum(l.belop) from faktura.lonnslinjer l join faktura.lonnsslipper s on s.id = l.slipp_id join faktura.lonnskjoringer k on k.id = s.kjoring_id
                       where l.org_id = t.org_id and l.nokkel = 'trekk:' || t.id::text and not l.fjernet and k.status = 'godkjent'), 0)::float8 as trukket
       from faktura.lonnstrekk t where t.org_id = $1 and t.ansatt_id = $2
      order by t.til is not null and t.til < faktura.i_dag(), t.fra, t.opprettet`,
    [org, ansatt],
  );
}

export function lonnstrekkRuter() {
  const r = new Hono();
  const ansatt = (c: Context) => uuid.parse(c.req.param("ansatt"));

  r.get("/ansatte/:ansatt/trekk", async (c) => c.json(await bruk(c, (db) => liste(db, orgId(c), ansatt(c)))));

  r.post("/ansatte/:ansatt/trekk", async (c) => {
    const b = trekkSkjema.parse(await c.req.json().catch(() => ({})));
    return c.json(
      await bruk(c, async (db) => {
        await db.query("select faktura.krev($1, 'personal')", [orgId(c)]);
        if (!(await en(db, "select 1 from faktura.ansatte where org_id = $1 and id = $2", [orgId(c), ansatt(c)]))) throw new ApiFeil(404, "Fant ikke den ansatte");
        await db.query(
          `insert into faktura.lonnstrekk (org_id, ansatt_id, ${FELT.join(", ")}) values ($1, $2, ${FELT.map((_, i) => `$${i + 3}`).join(", ")})`,
          [orgId(c), ansatt(c), ...FELT.map((f) => b[f] ?? null)],
        );
        return liste(db, orgId(c), ansatt(c));
      }),
      201,
    );
  });

  r.put("/ansatte/:ansatt/trekk/:trekk", async (c) => {
    const b = trekkSkjema.parse(await c.req.json().catch(() => ({})));
    const trekk = uuid.parse(c.req.param("trekk"));
    return c.json(
      await bruk(c, async (db) => {
        await db.query("select faktura.krev($1, 'personal')", [orgId(c)]);
        const res = await db.query(
          `update faktura.lonnstrekk set ${FELT.map((f, i) => `${f} = $${i + 4}`).join(", ")} where org_id = $1 and ansatt_id = $2 and id = $3`,
          [orgId(c), ansatt(c), trekk, ...FELT.map((f) => b[f] ?? null)],
        );
        if (!res.rowCount) throw new ApiFeil(404, "Fant ikke trekket");
        return liste(db, orgId(c), ansatt(c));
      }),
    );
  });

  // Et trekk som er brukt i en godkjent kjøring, avsluttes etter den siste måneden det er trukket i
  // (det som er trukket, står i kjøringene); ellers slettes det.
  r.delete("/ansatte/:ansatt/trekk/:trekk", async (c) => {
    const trekk = uuid.parse(c.req.param("trekk"));
    return c.json(
      await bruk(c, async (db) => {
        await db.query("select faktura.krev($1, 'personal')", [orgId(c)]);
        const t = await en<{ sist: string | null }>(
          db,
          `select (select to_char(max((k.periode + interval '1 month' - interval '1 day')::date), 'YYYY-MM-DD')
                     from faktura.lonnslinjer l join faktura.lonnsslipper s on s.id = l.slipp_id join faktura.lonnskjoringer k on k.id = s.kjoring_id
                    where l.org_id = t.org_id and l.nokkel = 'trekk:' || t.id::text and k.status = 'godkjent') as sist
             from faktura.lonnstrekk t where t.org_id = $1 and t.ansatt_id = $2 and t.id = $3`,
          [orgId(c), ansatt(c), trekk],
        );
        if (!t) throw new ApiFeil(404, "Fant ikke trekket");
        if (t.sist) await db.query("update faktura.lonnstrekk set til = $2 where id = $1", [trekk, t.sist]);
        else await db.query("delete from faktura.lonnstrekk where org_id = $1 and id = $2", [orgId(c), trekk]);
        return liste(db, orgId(c), ansatt(c));
      }),
    );
  });

  return r;
}
