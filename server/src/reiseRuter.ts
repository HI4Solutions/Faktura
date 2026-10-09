// Reiseregningene (0083_naturalytelser_reiser.sql, reise.ts): den ansatte fører sin egen (eier og
// administrator også for en ansatt), ser hva den gir (beregningen etter satsene organisasjonen
// betaler), og sender den. Eier og administrator godkjenner (beregningen lagres og utbetales med
// neste lønnskjøring), avviser med en grunn, eller åpner en godkjent som ikke er utbetalt. De som
// ser lønnen, ser alle; den ansatte sine egne. Eier og administrator får varsel når en reiseregning
// sendes, og den ansatte når den er godkjent eller avvist.
import { Hono, type Context } from "hono";
import { z } from "zod";
import { alle, en, somBruker, type Db } from "./db.js";
import { ApiFeil } from "./feil.js";
import { varslePersonal } from "./ansatte.js";
import { kr } from "./regler.js";
import { leggIKo } from "./tjenester.js";
import { beregnReise, reisenavn, type Reise, type Reiseberegning, type Reiselinje, type Reisesatser } from "./reise.js";

const uuid = z.string().uuid();
const datoS = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Ugyldig dato");
const tidS = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, "Skriv dato og klokkeslett");
const orgId = (c: Context) => uuid.parse(c.req.param("org"));
const bruk = <T>(c: Context, fn: (db: Db) => Promise<T>) => somBruker<T>(c.get("bruker").id, fn);
const tom = (v: unknown) => (typeof v === "string" && !v.trim() ? null : v);
const timer = (fra: string, til: string) => (Date.parse(`${til}:00Z`) - Date.parse(`${fra}:00Z`)) / 3_600_000;

const etappe = z.object({
  dato: datoS,
  fra: z.string().trim().min(1, "Skriv hvor kjøringen startet").max(100),
  til: z.string().trim().min(1, "Skriv hvor kjøringen gikk").max(100),
  km: z.number().positive("Skriv antall km for kjøringen").max(5000, "Høyst 5 000 km per kjøring"),
  kjoretoy: z.enum(["bil", "mc", "moped", "snoscooter", "baat"]).default("bil"),
  passasjerer: z.array(z.string().trim().min(1, "Skriv navnet på passasjeren").max(100)).max(8, "Høyst 8 passasjerer").default([]),
  skogsvei: z.number().min(0).max(5000).default(0),
  tilhenger: z.boolean().default(false),
});
const utleggS = z.object({
  dato: datoS,
  tekst: z.string().trim().min(1, "Skriv hva utlegget gjelder").max(140),
  belop: z.number().positive("Utlegget må være over 0").max(1_000_000),
});
export const reiseSkjema = z
  .object({
    ansatt_id: uuid.nullish(),
    formaal: z.string().trim().min(1, "Skriv formålet med reisen").max(200, "Formålet kan ha høyst 200 tegn"),
    sted: z.preprocess(tom, z.string().trim().max(200, "Stedet kan ha høyst 200 tegn").nullish()),
    fra: tidS,
    til: tidS,
    overnatting: z.enum(["ingen", "hotell", "hybel", "privat"]).default("ingen"),
    nattillegg: z.boolean().default(false),
    utland: z.boolean().default(false),
    land: z.preprocess(tom, z.string().trim().max(60).nullish()),
    kostsats: z.number().positive("Satsen må være over 0").max(100_000).nullish(),
    diett: z.boolean().default(true),
    maaltider: z.record(z.string().regex(/^\d{1,3}$/), z.string().regex(/^[FLM]{0,3}$/)).default({}),
    kjoring: z.array(etappe).max(200).default([]),
    utlegg: z.array(utleggS).max(200).default([]),
    merknad: z.preprocess(tom, z.string().trim().max(500, "Merknaden kan ha høyst 500 tegn").nullish()),
  })
  .refine((b) => b.til > b.fra, { message: "Hjemkomsten er før avreisen" })
  .refine((b) => timer(b.fra, b.til) <= 92 * 24, { message: "En reiseregning kan gjelde høyst 92 dager" })
  .refine((b) => b.overnatting !== "ingen" || timer(b.fra, b.til) <= 24, { message: "En dagsreise varer høyst et døgn (velg overnattingen)" })
  .refine((b) => !b.nattillegg || ((b.overnatting === "hybel" || b.overnatting === "privat") && !b.utland), {
    message: "Nattillegg gis bare for overnatting i Norge som ikke er på hotell",
  })
  .refine((b) => !b.utland || !!b.land, { message: "Skriv landet" })
  .transform((b) => ({ ...b, land: b.utland ? (b.land ?? null) : null, kostsats: b.utland ? (b.kostsats ?? null) : null }));
type Skjema = z.infer<typeof reiseSkjema>;

const RAD = `
  select r.id, r.ansatt_id, a.fornavn || ' ' || a.etternavn as navn, a.ansattnummer, r.status, r.formaal, r.sted,
         to_char(r.fra, 'YYYY-MM-DD"T"HH24:MI') as fra, to_char(r.til, 'YYYY-MM-DD"T"HH24:MI') as til, r.overnatting, r.nattillegg,
         r.utland, r.land, r.kostsats::float8 as kostsats, r.diett, r.maaltider, r.kjoring, r.utlegg, r.merknad, r.trekkfri,
         r.beregning, r.belop::float8 as belop, r.avvist_grunn, r.sendt_at, r.godkjent_at,
         (select coalesce(b.navn, b.epost) from faktura.brukere b where b.id = r.godkjent_av) as godkjent_av,
         r.lonnskjoring_id, u.periode as utbetalt_periode, u.utbetalingsdato as utbetalt_dato, r.opprettet
    from faktura.reiseregninger r
    join faktura.ansatte a on a.org_id = r.org_id and a.id = r.ansatt_id
    left join lateral (
      select to_char(s.periode, 'YYYY-MM-DD') as periode, to_char(s.utbetalingsdato, 'YYYY-MM-DD') as utbetalingsdato
        from faktura.lonnsslipper s where s.kjoring_id = r.lonnskjoring_id and s.ansatt_id = r.ansatt_id
    ) u on true`;
type Rad = Omit<Reise, "trekkfri"> & {
  id: string;
  ansatt_id: string;
  navn: string;
  ansattnummer: number;
  status: "utkast" | "sendt" | "godkjent" | "avvist";
  trekkfri: boolean;
  beregning: Reiselinje[] | null;
  belop: number | null;
  avvist_grunn: string | null;
  lonnskjoring_id: string | null;
};

const satserFor = async (db: Db, org: string): Promise<Reisesatser> =>
  ((await en<{ s: Reisesatser }>(db, "select coalesce((select reise_satser from faktura.lonn_oppsett where org_id = $1), 'staten') as s", [org]))?.s ?? "staten");

// Beregningen av en reiseregning: den lagrede når den er godkjent, ellers etter satsene nå.
function medBeregning(r: Rad, satser: Reisesatser): Rad & { utregning: Reiseberegning | null; sum: number } {
  const utregning = r.status === "godkjent" ? null : beregnReise({ ...r, kostsats: r.kostsats == null ? null : Number(r.kostsats) }, satser);
  return { ...r, utregning, sum: r.status === "godkjent" ? Number(r.belop) : (utregning?.belop ?? 0) };
}

async function hentEn(db: Db, org: string, id: string) {
  const r = await en<Rad>(db, `${RAD} where r.org_id = $1 and r.id = $2`, [org, id]);
  if (!r) throw new ApiFeil(404, "Fant ikke reiseregningen");
  return medBeregning(r, await satserFor(db, org));
}

const tilJson = (b: Skjema) => JSON.stringify({ ...b, ansatt_id: undefined });

// Varselet til den ansatte (om den har innlogging og ikke gjorde det selv).
async function varsleAnsatt(db: Db, org: string, r: { id: string; ansatt_id: string }, meg: string, tittel: string, tekst: string) {
  const b = (await en<{ bruker_id: string | null }>(db, "select bruker_id from faktura.ansatte where org_id = $1 and id = $2", [org, r.ansatt_id]))?.bruker_id;
  return b && b !== meg ? { bruker_id: b, tittel, tekst, url: `/lonn?fane=reiser&reise=${r.id}`, tag: `reise-${r.id}` } : null;
}
async function sendVarsel(org: string, v: { bruker_id: string; tittel: string; tekst: string; url: string; tag: string } | null) {
  if (v) await leggIKo({ type: "varsel", varsel: { hendelse: "reiser", org_id: org, bruker_ider: [v.bruker_id], tittel: v.tittel, tekst: v.tekst, url: v.url, tag: v.tag } });
}

export function reiseRuter() {
  const r = new Hono();
  const rid = (c: Context) => uuid.parse(c.req.param("id"));

  // Reiseregningene (de som ser lønnen: alle, ellers sine egne), nyeste først; status og ansatt kan velges.
  r.get("/reiser", async (c) => {
    const status = z.enum(["utkast", "sendt", "godkjent", "avvist", "utbetalt"]).nullish().parse(c.req.query("status") || null);
    const ansatt = uuid.nullish().parse(c.req.query("ansatt") || null);
    return c.json(
      await bruk(c, async (db) => {
        const rader = await alle<Rad>(
          db,
          `${RAD} where r.org_id = $1 and ($2::uuid is null or r.ansatt_id = $2)
              and ($3::text is null or (case $3::text when 'utbetalt' then r.lonnskjoring_id is not null
                                                       when 'godkjent' then r.status = 'godkjent' and r.lonnskjoring_id is null
                                                       else r.status = $3::text end))
            order by r.fra desc, r.opprettet desc limit 500`,
          [orgId(c), ansatt ?? null, status ?? null],
        );
        const satser = await satserFor(db, orgId(c));
        return { satser, reiser: rader.map((x) => medBeregning(x, satser)) };
      }),
    );
  });

  // Hva en reiseregning gir, uten å lagre den (skjemaet viser det mens den fylles ut).
  r.post("/reiser/beregn", async (c) => {
    const b = reiseSkjema.parse(await c.req.json().catch(() => ({})));
    return c.json(await bruk(c, async (db) => beregnReise({ ...b, sted: b.sted ?? null, trekkfri: true }, await satserFor(db, orgId(c)))));
  });

  r.get("/reiser/:id", async (c) => c.json(await bruk(c, (db) => hentEn(db, orgId(c), rid(c)))));

  r.post("/reiser", async (c) => {
    const b = reiseSkjema.parse(await c.req.json().catch(() => ({})));
    return c.json(
      await bruk(c, async (db) => {
        const ny = await en<{ id: string }>(db, "select (faktura.lagre_reiseregning($1, null, $2, $3::jsonb)).id", [orgId(c), b.ansatt_id ?? null, tilJson(b)]);
        return hentEn(db, orgId(c), ny!.id);
      }),
      201,
    );
  });

  r.put("/reiser/:id", async (c) => {
    const b = reiseSkjema.parse(await c.req.json().catch(() => ({})));
    return c.json(
      await bruk(c, async (db) => {
        await db.query("select faktura.lagre_reiseregning($1, $2, null, $3::jsonb)", [orgId(c), rid(c), tilJson(b)]);
        return hentEn(db, orgId(c), rid(c));
      }),
    );
  });

  r.post("/reiser/:id/send", async (c) => {
    const x = await bruk(c, async (db) => {
      await db.query("select faktura.send_reiseregning($1, $2)", [orgId(c), rid(c)]);
      return hentEn(db, orgId(c), rid(c));
    });
    await varslePersonal(
      orgId(c),
      c.get("bruker").id,
      "reiser",
      "Reiseregning til godkjenning",
      `${x.navn}: ${reisenavn(x)}, ${kr(x.sum)} kr.`,
      `/lonn?fane=reiser&reise=${x.id}`,
      `reise-${x.id}`,
    );
    return c.json(x);
  });

  // Godkjenner med beregningen etter satsene nå. trekkfri: false når vilkårene for trekkfri
  // godtgjørelse ikke er oppfylt (da er alt trekkpliktig).
  r.post("/reiser/:id/godkjenn", async (c) => {
    const b = z.object({ trekkfri: z.boolean().default(true) }).parse(await c.req.json().catch(() => ({})));
    const { svar, v } = await bruk(c, async (db) => {
      await db.query("select faktura.krev($1, 'personal')", [orgId(c)]);
      const x = await en<Rad>(db, `${RAD} where r.org_id = $1 and r.id = $2`, [orgId(c), rid(c)]);
      if (!x) throw new ApiFeil(404, "Fant ikke reiseregningen");
      const u = beregnReise({ ...x, kostsats: x.kostsats == null ? null : Number(x.kostsats), trekkfri: b.trekkfri }, await satserFor(db, orgId(c)));
      if (u.belop <= 0) throw new ApiFeil(400, "Reiseregningen har ingenting som skal utbetales");
      await db.query("select faktura.godkjenn_reiseregning($1, $2, $3, $4::jsonb, $5)", [orgId(c), rid(c), b.trekkfri, JSON.stringify(u.linjer), u.belop]);
      return {
        svar: await hentEn(db, orgId(c), rid(c)),
        v: await varsleAnsatt(db, orgId(c), x, c.get("bruker").id, "Reiseregningen er godkjent", `${reisenavn(x)}: ${kr(u.belop)} kr utbetales med neste lønn.`),
      };
    });
    await sendVarsel(orgId(c), v);
    return c.json(svar);
  });

  r.post("/reiser/:id/avvis", async (c) => {
    const b = z.object({ grunn: z.string().trim().min(1, "Skriv hvorfor reiseregningen avvises").max(300, "Grunnen kan ha høyst 300 tegn") }).parse(
      await c.req.json().catch(() => ({})),
    );
    const { svar, v } = await bruk(c, async (db) => {
      await db.query("select faktura.avvis_reiseregning($1, $2, $3)", [orgId(c), rid(c), b.grunn]);
      const x = await hentEn(db, orgId(c), rid(c));
      return { svar: x, v: await varsleAnsatt(db, orgId(c), x, c.get("bruker").id, "Reiseregningen er avvist", `${reisenavn(x)}: ${b.grunn}`) };
    });
    await sendVarsel(orgId(c), v);
    return c.json(svar);
  });

  r.post("/reiser/:id/apne", async (c) =>
    c.json(
      await bruk(c, async (db) => {
        await db.query("select faktura.apne_reiseregning($1, $2)", [orgId(c), rid(c)]);
        return hentEn(db, orgId(c), rid(c));
      }),
    ),
  );

  r.delete("/reiser/:id", async (c) => {
    await bruk(c, (db) => db.query("select faktura.slett_reiseregning($1, $2)", [orgId(c), rid(c)]));
    return c.body(null, 204);
  });

  return r;
}
