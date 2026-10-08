// Beskjeder (0062_beskjeder.sql): alle i organisasjonen kan legge en beskjed til én eller flere roller
// (f.eks. legene og sekretærene), eller til alle, eventuelt med push-varsel til dem det gjelder (de
// aktive med rollene, eller alle). Hvem som ser og kan slette hva, avgjøres i databasen (RLS).
import { Hono, type Context } from "hono";
import { z } from "zod";
import { alle, en, somBruker, somSystem, type Db } from "./db.js";
import { leggIKo } from "./tjenester.js";

const uuid = z.string().uuid();
const orgId = (c: Context) => uuid.parse(c.req.param("org"));
const id = (c: Context) => uuid.parse(c.req.param("id"));
const bruk = <T>(c: Context, fn: (db: Db) => Promise<T>) => somBruker<T>(c.get("bruker").id, fn);

// Ny: en beskjed fra en annen etter at brukeren sist så beskjedene, men høyst 14 dager gammel (så
// en som er ny i organisasjonen, eller har vært borte lenge, ikke får alle de gamle som nye).
const NY = `(b.forfatter is distinct from faktura.bruker_id()
   and b.opprettet > greatest(now() - interval '14 days',
         coalesce((select l.lest from faktura.beskjed_lest l where l.org_id = b.org_id and l.bruker_id = faktura.bruker_id()), '-infinity')))`;
const BESKJED = `
  select b.id, b.tekst, b.roller, b.push, b.forfatter_navn, b.opprettet, b.forfatter = faktura.bruker_id() as egen,
         (b.forfatter = faktura.bruker_id() or faktura.kan(b.org_id, 'personal')) as kan_slette, ${NY} as ny
    from faktura.beskjeder b`;
const ULESTE = `select count(*)::int as n from faktura.beskjeder b where b.org_id = $1 and ${NY}`;

const nyBeskjed = z.object({
  tekst: z.string({ error: "Skriv en beskjed" }).trim().min(1, "Skriv en beskjed").max(2000, "Beskjeden kan ha høyst 2000 tegn"),
  roller: z.array(uuid).max(50).optional(), // tom: alle
  push: z.boolean().optional(),
});

export function beskjedRuter() {
  const r = new Hono();

  // Beskjedene den innloggede ser (de nyeste 200, med de nye siden sist merket), og rollene å skrive til.
  r.get("/beskjeder", async (c) =>
    c.json(
      await bruk(c, async (db) => ({
        beskjeder: await alle(db, `${BESKJED} where b.org_id = $1 order by b.opprettet desc limit 200`, [orgId(c)]),
        roller: await alle(db, "select * from faktura.beskjed_roller($1)", [orgId(c)]),
      })),
    ),
  );

  r.get("/beskjeder/uleste", async (c) => c.json({ uleste: (await bruk(c, (db) => en<{ n: number }>(db, ULESTE, [orgId(c)])))!.n }));

  // Lest: alt til nå.
  r.post("/beskjeder/lest", async (c) => {
    await bruk(c, (db) =>
      db.query(
        `insert into faktura.beskjed_lest (org_id, bruker_id, lest) values ($1, faktura.bruker_id(), now())
         on conflict (org_id, bruker_id) do update set lest = excluded.lest`,
        [orgId(c)],
      ),
    );
    return c.body(null, 204);
  });

  // Ny beskjed. Med push får de det gjelder (ikke den som skrev den) et varsel.
  r.post("/beskjeder", async (c) => {
    const b = nyBeskjed.parse(await c.req.json().catch(() => ({})));
    const bruker = c.get("bruker").id;
    const ny = await bruk(c, async (db) => {
      const rad = await en<{ id: string }>(db, "insert into faktura.beskjeder (org_id, tekst, roller, push) values ($1, $2, $3, $4) returning id", [
        orgId(c),
        b.tekst,
        b.roller ?? [],
        b.push ?? false,
      ]);
      return (await en<{ id: string; tekst: string; roller: string[]; push: boolean; forfatter_navn: string }>(db, `${BESKJED} where b.id = $1`, [rad!.id]))!;
    });
    if (ny.push) {
      const mottakere = await somSystem((db) =>
        alle<{ bruker_id: string }>(
          db,
          `select distinct m.bruker_id from faktura.medlemmer m
            where m.org_id = $1 and m.bruker_id <> $2
              and (cardinality($3::uuid[]) = 0
                   or exists (select 1 from faktura.ansatte a
                               where a.org_id = m.org_id and a.bruker_id = m.bruker_id and a.aktiv and a.gruppe_id = any ($3::uuid[])))`,
          [orgId(c), bruker, ny.roller],
        ),
      );
      if (mottakere.length)
        await leggIKo({
          type: "varsel",
          varsel: {
            hendelse: "beskjed",
            org_id: orgId(c),
            bruker_ider: mottakere.map((m) => m.bruker_id),
            tittel: ny.forfatter_navn ? `Beskjed fra ${ny.forfatter_navn}` : "Ny beskjed",
            tekst: ny.tekst.length > 160 ? `${ny.tekst.slice(0, 157)}…` : ny.tekst,
            url: "/beskjeder",
            tag: `beskjed-${ny.id}`,
          },
        });
    }
    return c.json(ny, 201);
  });

  r.delete("/beskjeder/:id", async (c) => {
    const n = await bruk(c, async (db) => (await db.query("delete from faktura.beskjeder where org_id = $1 and id = $2", [orgId(c), id(c)])).rowCount ?? 0);
    if (!n) return c.json({ error: "Fant ikke beskjeden, eller du kan ikke slette den" }, 404);
    return c.body(null, 204);
  });

  return r;
}
