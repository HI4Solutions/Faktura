// Grupper av ansatte for bemanningskalenderen (0039_bemanning.sql): f.eks. sekretærer og
// leger, hver med hvor mange som trengs på jobb per dag. Kalenderen viser måneden med
// datoene nedover og de ansatte bortover, gruppe for gruppe, og hvor mange som er på jobb i
// hver gruppe mot behovet. Den regnes ut i appen fra vaktplanen og fraværet; her styres
// gruppene. Eier og administrator endrer dem; regnskap ser dem.
import { Hono, type Context } from "hono";
import { z } from "zod";
import { alle, en, somBruker, type Db } from "./db.js";
import { ApiFeil } from "./feil.js";
import { tekst, valgfri } from "./ansatte.js";

const uuid = z.string().uuid();
const orgId = (c: Context) => uuid.parse(c.req.param("org"));
const id = (c: Context) => uuid.parse(c.req.param("id"));
const bruk = <T>(c: Context, fn: (db: Db) => Promise<T>) => somBruker<T>(c.get("bruker").id, fn);

const skjema = z.object({
  navn: tekst(40, "Navnet").min(1, "Skriv et navn på gruppen"),
  kort: valgfri(tekst(8, "Forkortelsen").min(1)),
  behov: valgfri(z.number().int("Skriv behovet som et helt tall").min(0, "Behovet kan ikke være negativt").max(500, "Behovet kan være høyst 500")),
});

const GRUPPER = `
  select g.id, g.navn, g.kort, g.behov, g.rekkefolge,
         (select count(*)::int from faktura.ansatte a where a.org_id = g.org_id and a.gruppe_id = g.id and a.aktiv) as antall
    from faktura.ansattgrupper g
   where g.org_id = $1
   order by g.rekkefolge, g.opprettet`;

export function bemanningRuter() {
  const r = new Hono();

  r.get("/ansattgrupper", async (c) =>
    c.json(
      await bruk(c, async (db) => {
        await db.query("select faktura.krev($1, 'personal_les')", [orgId(c)]);
        return alle(db, GRUPPER, [orgId(c)]);
      }),
    ),
  );

  r.post("/ansattgrupper", async (c) => {
    const b = skjema.parse(await c.req.json().catch(() => ({})));
    const ny = await bruk(c, async (db) => {
      await db.query("select faktura.krev($1, 'personal')", [orgId(c)]);
      return en(
        db,
        `insert into faktura.ansattgrupper (org_id, navn, kort, behov, rekkefolge)
         values ($1, $2, $3, $4, (select coalesce(max(rekkefolge), 0) + 1 from faktura.ansattgrupper where org_id = $1))
         returning id`,
        [orgId(c), b.navn, b.kort ?? null, b.behov ?? null],
      );
    });
    return c.json(ny, 201);
  });

  r.patch("/ansattgrupper/:id", async (c) => {
    const b = skjema.partial().parse(await c.req.json().catch(() => ({})));
    const felt = (["navn", "kort", "behov"] as const).filter((k) => b[k] !== undefined);
    if (!felt.length) throw new ApiFeil(400, "Ingen felt å endre");
    await bruk(c, async (db) => {
      await db.query("select faktura.krev($1, 'personal')", [orgId(c)]);
      const res = await db.query(`update faktura.ansattgrupper set ${felt.map((k, i) => `${k} = $${i + 3}`).join(", ")} where org_id = $1 and id = $2`, [
        orgId(c),
        id(c),
        ...felt.map((k) => b[k] ?? null),
      ]);
      if (!res.rowCount) throw new ApiFeil(404, "Fant ikke gruppen");
    });
    return c.body(null, 204);
  });

  // Slettes gruppen, står de ansatte i den uten gruppe.
  r.delete("/ansattgrupper/:id", async (c) => {
    await bruk(c, async (db) => {
      await db.query("select faktura.krev($1, 'personal')", [orgId(c)]);
      const res = await db.query("delete from faktura.ansattgrupper where org_id = $1 and id = $2", [orgId(c), id(c)]);
      if (!res.rowCount) throw new ApiFeil(404, "Fant ikke gruppen");
    });
    return c.body(null, 204);
  });

  // Ny rekkefølge: id-ene i den rekkefølgen gruppene skal stå (fra venstre).
  r.post("/ansattgrupper/rekkefolge", async (c) => {
    const b = z.object({ ider: z.array(uuid).min(1).max(100) }).parse(await c.req.json().catch(() => ({})));
    await bruk(c, async (db) => {
      await db.query("select faktura.krev($1, 'personal')", [orgId(c)]);
      await db.query(
        `update faktura.ansattgrupper g set rekkefolge = n.i
           from unnest($2::uuid[]) with ordinality as n(id, i)
          where g.org_id = $1 and g.id = n.id`,
        [orgId(c), b.ider],
      );
    });
    return c.body(null, 204);
  });

  // Grupper fra stillingene: de aktive ansatte uten gruppe havner i en gruppe med samme navn som
  // stillingen (en som finnes fra før, eller en ny). Store og små bokstaver teller ikke.
  r.post("/ansattgrupper/fra-stillinger", async (c) => {
    const svar = await bruk(c, async (db) => {
      await db.query("select faktura.krev($1, 'personal')", [orgId(c)]);
      const stillinger = await alle<{ stilling: string }>(
        db,
        `select distinct on (lower(btrim(stilling))) btrim(stilling) as stilling from faktura.ansatte
          where org_id = $1 and aktiv and gruppe_id is null and btrim(coalesce(stilling, '')) <> ''
          order by lower(btrim(stilling)), btrim(stilling)`,
        [orgId(c)],
      );
      let grupper = 0;
      let ansatte = 0;
      for (const { stilling } of stillinger) {
        const navn = (stilling.charAt(0).toUpperCase() + stilling.slice(1)).slice(0, 40);
        let g = await en<{ id: string }>(db, "select id from faktura.ansattgrupper where org_id = $1 and lower(navn) = lower($2) limit 1", [orgId(c), navn]);
        if (!g) {
          g = await en<{ id: string }>(
            db,
            `insert into faktura.ansattgrupper (org_id, navn, rekkefolge)
             values ($1, $2, (select coalesce(max(rekkefolge), 0) + 1 from faktura.ansattgrupper where org_id = $1)) returning id`,
            [orgId(c), navn],
          );
          grupper++;
        }
        const res = await db.query(
          "update faktura.ansatte set gruppe_id = $3 where org_id = $1 and aktiv and gruppe_id is null and lower(btrim(stilling)) = lower($2)",
          [orgId(c), stilling, g!.id],
        );
        ansatte += res.rowCount ?? 0;
      }
      return { grupper, ansatte };
    });
    return c.json(svar);
  });

  return r;
}
