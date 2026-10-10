// Bokføringen av lønnen i appen (0078_lonn_bokforing.sql, lonnBokforing.ts): kontoene og valgene
// (Innstillinger → Ansatte og timer → Bokføring av lønn), og lønnsbilagene for en kjøring (det
// gjeldende og de som er reversert), med det bilaget blir når kjøringen er godkjent, men ikke
// bokført (godkjent før bokføringen kom). Eier, administrator og regnskap ser alt; eier og
// administrator endrer kontoene og bokfører.
import { Hono, type Context } from "hono";
import { z } from "zod";
import { en, somBruker, type Db } from "./db.js";
import { ApiFeil } from "./feil.js";
import { bokforKjoring, forslagTilBilag, hentBilag, hentBokforingsoppsett, KONTOROLLER, kontoplan, type Kontorolle } from "./lonnBokforing.js";

const uuid = z.string().uuid();
const orgId = (c: Context) => uuid.parse(c.req.param("org"));
const bruk = <T>(c: Context, fn: (db: Db) => Promise<T>) => somBruker<T>(c.get("bruker").id, fn);
const ROLLER = KONTOROLLER.map((k) => k.rolle) as [Kontorolle, ...Kontorolle[]];

async function oppsett(db: Db, org: string) {
  const o = await hentBokforingsoppsett(db, org);
  const plan = kontoplan(o);
  return {
    kontoer: KONTOROLLER.map((k) => ({ rolle: k.rolle, navn: k.navn, standard: k.standard, konto: plan[k.rolle], endret: o.kontoer[k.rolle] != null })),
    feriepenger: o.feriepenger,
    netto: o.netto,
    otp: o.otp,
    afp: !!o.afp,
  };
}

export function lonnBokforingRuter() {
  const r = new Hono();

  r.get("/lonn/bokforing", async (c) =>
    c.json(
      await bruk(c, async (db) => {
        await db.query("select faktura.krev($1, 'personal_les')", [orgId(c)]);
        return oppsett(db, orgId(c));
      }),
    ),
  );

  // Kontoene (null eller tomt: standarden) og valgene. Gjelder bilagene som føres etterpå.
  r.put("/lonn/bokforing", async (c) => {
    const konto = z
      .string()
      .trim()
      .regex(/^(\d{4,6})?$/, "Kontonummeret må være 4–6 siffer (f.eks. 5000)")
      .nullable();
    const b = z
      .object({
        kontoer: z.partialRecord(z.enum(ROLLER), konto).optional(),
        feriepenger: z.enum(["avsetning", "utbetaling"]).optional(),
        netto: z.enum(["skyldig", "bank"]).optional(),
        otp: z.boolean().optional(),
        afp: z.boolean().optional(),
      })
      .parse(await c.req.json().catch(() => ({})));
    return c.json(
      await bruk(c, async (db) => {
        await db.query("select faktura.krev($1, 'admin')", [orgId(c)]);
        const naa = await hentBokforingsoppsett(db, orgId(c));
        const standard = kontoplan({ kontoer: {} });
        // Bare kontoene som avviker fra standarden lagres.
        const kontoer: Record<string, string> = { ...naa.kontoer } as Record<string, string>;
        for (const [rolle, nr] of Object.entries(b.kontoer ?? {})) {
          if (!nr || nr === standard[rolle as Kontorolle]) delete kontoer[rolle];
          else kontoer[rolle] = nr;
        }
        const n = await db.query(
          `update faktura.lonn_oppsett set bokforing_kontoer = $2, bokforing_feriepenger = $3, bokforing_netto = $4, bokforing_otp = $5, bokforing_afp = $6
            where org_id = $1`,
          [orgId(c), JSON.stringify(kontoer), b.feriepenger ?? naa.feriepenger, b.netto ?? naa.netto, b.otp ?? naa.otp, b.afp ?? !!naa.afp],
        );
        if (!n.rowCount) throw new ApiFeil(409, "Slå på Ansatte og timer først");
        return oppsett(db, orgId(c));
      }),
    );
  });

  // Lønnsbilagene for kjøringen (nyeste først), og forslaget når den er godkjent uten bilag.
  r.get("/lonn/kjoringer/:id/bokforing", async (c) => {
    const id = uuid.parse(c.req.param("id"));
    return c.json(
      await bruk(c, async (db) => {
        await db.query("select faktura.krev($1, 'personal_les')", [orgId(c)]);
        const bilag = await hentBilag(db, orgId(c), { kjoring: id });
        const gjeldende = bilag.find((b) => !b.reverserer && !b.reversert_av) ?? null;
        return { gjeldende, bilag, forslag: gjeldende ? null : await forslagTilBilag(db, orgId(c), id) };
      }),
    );
  });

  // Bokfører en godkjent kjøring som ikke har et bilag (godkjent før bokføringen kom).
  r.post("/lonn/kjoringer/:id/bokfor", async (c) => {
    const id = uuid.parse(c.req.param("id"));
    const b = await bruk(c, async (db) => {
      const k = await en<{ id: string }>(db, "select id from faktura.lonnskjoringer where org_id = $1 and id = $2", [orgId(c), id]);
      if (!k) throw new ApiFeil(404, "Fant ikke lønnskjøringen");
      return bokforKjoring(db, orgId(c), id);
    });
    return c.json(b, 201);
  });

  return r;
}
