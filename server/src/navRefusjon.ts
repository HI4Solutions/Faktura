// Refusjonene fra NAV (0085_nav_refusjon.sql): det NAV har betalt arbeidsgiveren (sykepenger og
// omsorgspenger etter refusjonskravet, foreldrepenger, svangerskapspenger, pleiepenger og annet),
// med datoen pengene kom, beløpet, perioden og den ansatte. Hver refusjon bokføres med et bilag i
// lønnsserien (bank mot kontoen for refusjon fra NAV, standard 5800), og en som slettes,
// reverseres i regnskapet. Bare eier og administrator (sykepenger er helseopplysninger); bilaget
// har ikke navnet på den ansatte. Avstemmingen mot det som er krevd: avstemming.ts.
import { Hono, type Context } from "hono";
import { z } from "zod";
import { alle, en, somBruker, type Db } from "./db.js";
import { ApiFeil } from "./feil.js";
import { hentBokforingsoppsett, kontoplan } from "./lonnBokforing.js";

const uuid = z.string().uuid();
const orgId = (c: Context) => uuid.parse(c.req.param("org"));
const bruk = <T>(c: Context, fn: (db: Db) => Promise<T>) => somBruker<T>(c.get("bruker").id, fn);
const datoS = z.string({ error: "Velg datoen" }).regex(/^\d{4}-\d{2}-\d{2}$/, "Ugyldig dato");
const visDato = (d: string) => d.split("-").reverse().join(".");

export const REFUSJONSTYPER = {
  sykepenger: "Sykepenger",
  omsorgspenger: "Omsorgspenger",
  foreldrepenger: "Foreldrepenger",
  svangerskapspenger: "Svangerskapspenger",
  pleiepenger: "Pleiepenger",
  annet: "Annen refusjon",
} as const;
export type Refusjonstype = keyof typeof REFUSJONSTYPER;
const TYPER = Object.keys(REFUSJONSTYPER) as [Refusjonstype, ...Refusjonstype[]];

// Teksten på bilaget (uten navnet): «Refusjon fra NAV: sykepenger 01.10.2026–31.10.2026».
export const bilagstekst = (type: Refusjonstype, fra?: string | null, til?: string | null) =>
  `Refusjon fra NAV: ${REFUSJONSTYPER[type].toLowerCase()}${fra && til ? ` ${visDato(fra)}–${visDato(til)}` : ""}`;

const skjema = z
  .object({
    type: z.enum(TYPER, { error: "Velg hva refusjonen gjelder" }),
    ansatt_id: uuid.nullable().optional(),
    dato: datoS,
    belop: z.number({ error: "Skriv beløpet" }).positive("Beløpet må være over 0").lt(10_000_000, "Beløpet er for stort"),
    fra: datoS.nullable().optional(),
    til: datoS.nullable().optional(),
    tekst: z.string().trim().max(200, "Teksten kan være høyst 200 tegn").nullable().optional(),
  })
  .refine((b) => !b.fra === !b.til, { message: "Velg både fra- og til-datoen for perioden (eller ingen)" })
  .refine((b) => !b.fra || !b.til || b.til >= b.fra, { message: "Til-datoen er før fra-datoen" });

export const REFUSJON = `
  select r.id, r.ansatt_id, a.ansattnummer, a.fornavn || ' ' || a.etternavn as ansatt_navn, r.type, to_char(r.dato, 'YYYY-MM-DD') as dato,
         r.belop::float8 as belop, to_char(r.fra, 'YYYY-MM-DD') as fra, to_char(r.til, 'YYYY-MM-DD') as til, r.tekst,
         b.serie || '-' || b.aar || '-' || b.nummer as bilag, r.opprettet
    from faktura.nav_refusjoner r
    left join faktura.ansatte a on a.org_id = r.org_id and a.id = r.ansatt_id
    left join faktura.bilag b on b.org_id = r.org_id and b.id = r.bilag_id`;

export function navRefusjonRuter() {
  const r = new Hono();

  // Refusjonene som har kommet i året (nyeste først), og summen per type.
  r.get("/lonn/nav-refusjoner", async (c) => {
    const aar = z.coerce.number().int().min(2015).max(2100).parse(c.req.query("aar") ?? new Date().getFullYear());
    return c.json(
      await bruk(c, async (db) => {
        await db.query("select faktura.krev($1, 'personal')", [orgId(c)]);
        const refusjoner = await alle<{ type: Refusjonstype; belop: number }>(
          db,
          `${REFUSJON} where r.org_id = $1 and extract(year from r.dato) = $2 order by r.dato desc, r.opprettet desc`,
          [orgId(c), aar],
        );
        const sum = Object.fromEntries(TYPER.map((t) => [t, Math.round(refusjoner.filter((x) => x.type === t).reduce((s, x) => s + Number(x.belop), 0) * 100) / 100]));
        return { aar, refusjoner, sum };
      }),
    );
  });

  // Ny refusjon: raden og bilaget (bank mot kontoen for refusjon fra NAV).
  r.post("/lonn/nav-refusjoner", async (c) => {
    const b = skjema.parse(await c.req.json().catch(() => ({})));
    return c.json(
      await bruk(c, async (db) => {
        await db.query("select faktura.krev($1, 'personal')", [orgId(c)]);
        const plan = kontoplan(await hentBokforingsoppsett(db, orgId(c)));
        const ny = await en<{ id: string }>(db, "select faktura.registrer_nav_refusjon($1, $2, $3, $4, $5) as id", [
          orgId(c),
          JSON.stringify({ ...b, ansatt_id: b.ansatt_id ?? null, fra: b.fra ?? null, til: b.til ?? null, tekst: b.tekst ?? null }),
          plan.bank,
          plan.nav_refusjon,
          bilagstekst(b.type, b.fra, b.til),
        ]);
        return (await en(db, `${REFUSJON} where r.org_id = $1 and r.id = $2`, [orgId(c), ny!.id]))!;
      }),
      201,
    );
  });

  // Slett en refusjon som er registrert feil (bilaget reverseres).
  r.delete("/lonn/nav-refusjoner/:id", async (c) => {
    const id = uuid.parse(c.req.param("id"));
    await bruk(c, async (db) => {
      await db.query("select faktura.krev($1, 'personal')", [orgId(c)]);
      const r = await en<{ id: string }>(db, "select id from faktura.nav_refusjoner where org_id = $1 and id = $2", [orgId(c), id]);
      if (!r) throw new ApiFeil(404, "Fant ikke refusjonen");
      await db.query("select faktura.slett_nav_refusjon($1, $2)", [orgId(c), id]);
    });
    return c.body(null, 204);
  });

  return r;
}
