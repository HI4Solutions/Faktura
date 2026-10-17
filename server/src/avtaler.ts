// Bruksvilkårene og databehandleravtalen (0122_avtaler.sql, landingsside/vilkar.html og
// databehandleravtale.html). Versjonene som gjelder står i databasen, med adressen på nettstedet.
// Eier eller administrator godtar dem på vegne av organisasjonen når den opprettes, og på nytt når
// en ny versjon gjelder (appen ber om det).
import { Hono, type Context } from "hono";
import { z } from "zod";
import { config } from "./config.js";
import { alle, en, somBruker, somSystem, type Db } from "./db.js";

// Nettstedet, der dokumentene ligger.
export const nettsted = () => config.nettstedUrl ?? "https://adminkonsoll.no";

export type Avtaletype = "vilkar" | "databehandleravtale";
export type Avtale = { type: Avtaletype; navn: string; versjon: string; oppdatert: string; url: string };

export async function gjeldendeAvtaler(db: Db): Promise<Record<Avtaletype, Avtale>> {
  const rader = await alle<Omit<Avtale, "url"> & { sti: string }>(
    db,
    "select type, navn, versjon, to_char(oppdatert, 'YYYY-MM-DD') as oppdatert, sti from faktura.avtaler order by type",
  );
  return Object.fromEntries(
    rader.map(({ sti, ...a }) => [a.type, { ...a, url: `${nettsted()}${sti}` }]),
  ) as Record<Avtaletype, Avtale>;
}

// Versjonene brukeren fikk se og godtok.
export const godkjenningSkjema = z
  .object({
    vilkar: z.string().trim().min(1).max(20),
    databehandleravtale: z.string().trim().min(1).max(20),
  })
  .strict();

export const godtaAvtaler = (db: Db, org: string, v: z.infer<typeof godkjenningSkjema>) =>
  en(db, "select * from faktura.godta_avtaler($1, $2, $3)", [org, v.vilkar, v.databehandleravtale]);

// Åpent: versjonene og adressene (for skjemaet når en organisasjon opprettes).
export function avtalerOffentlig() {
  const app = new Hono();
  app.get("/", async (c) => {
    c.header("cache-control", "public, max-age=300");
    return c.json(await somSystem(gjeldendeAvtaler));
  });
  return app;
}

// For organisasjonen (monteres under /api/org/:org/avtaler): godkjenningene og å godta.
export function avtaleRuter() {
  const app = new Hono();
  const bruk = <T>(c: Context, fn: (db: Db) => Promise<T>) => somBruker(c.get("bruker").id, fn);
  const org = (c: Context) => z.string().uuid().parse(c.req.param("org"));

  app.get("/", async (c) =>
    c.json(
      await bruk(c, async (db) => ({
        gjeldende: await gjeldendeAvtaler(db),
        godtatt: (await en<{ ok: boolean }>(db, "select faktura.avtaler_godtatt($1) as ok", [org(c)]))!.ok,
        // RLS: bare eier og administrator ser hvem som har godtatt og når.
        godkjenninger: await alle(
          db,
          `select g.id, g.vilkar_versjon, g.databehandleravtale_versjon, g.godtatt_at, b.navn as godtatt_av_navn, b.epost as godtatt_av_epost
             from faktura.avtalegodkjenninger g left join faktura.brukere b on b.id = g.godtatt_av
            where g.org_id = $1 order by g.godtatt_at desc`,
          [org(c)],
        ),
      })),
    ),
  );

  app.post("/", async (c) => {
    let json: unknown = {};
    try {
      json = await c.req.json();
    } catch {
      json = {};
    }
    const v = godkjenningSkjema.parse(json);
    return c.json(await bruk(c, (db) => godtaAvtaler(db, org(c), v)), 201);
  });
  return app;
}
