// Feriebank (0050_feriebank.sql): feriedagene hver ansatt har i ferieåret, hvor mange som er
// avviklet og planlagt (regnet av ferien i fraværet), og hvor mange som er igjen. Den ansatte
// søker om å overføre dager til neste år; eier og administrator godkjenner eller avslår, og den
// andre parten får beskjed. Bare eier, administrator og den ansatte selv ser feriebanken.
import { Hono, type Context } from "hono";
import { z } from "zod";
import { alle, en, somBruker, type Db } from "./db.js";
import { ApiFeil } from "./feil.js";
import { tekst, valgfri, varslePersonal } from "./ansatte.js";
import { leggIKo } from "./tjenester.js";

const uuid = z.string().uuid();
const orgId = (c: Context) => uuid.parse(c.req.param("org"));
const bruk = <T>(c: Context, fn: (db: Db) => Promise<T>) => somBruker<T>(c.get("bruker").id, fn);
const aarS = z.coerce.number().int().min(2000).max(2100);
const iAar = () => Number(new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Oslo", year: "numeric" }).format(new Date()));
const dagerTekst = (n: number) => `${String(n).replace(".", ",")} ${n === 1 ? "feriedag" : "feriedager"}`;

const OVERFORING = `
  select o.id, o.ansatt_id, a.fornavn || ' ' || a.etternavn as ansatt_navn, o.fra_aar, o.dager, o.begrunnelse, o.status, o.svar,
         o.opprettet, o.behandlet_at, b.navn as behandlet_av_navn, o.soknad_av = faktura.bruker_id() as min
    from faktura.ferie_overforinger o
    join faktura.ansatte a on a.org_id = o.org_id and a.id = o.ansatt_id
    left join faktura.brukere b on b.id = o.behandlet_av`;

const soknadSkjema = z.object({
  ansatt_id: uuid.optional(), // standard: den innloggede selv
  fra_aar: aarS.optional(), // standard: i år
  dager: z
    .number({ error: "Skriv hvor mange dager" })
    .gt(0, "Skriv hvor mange dager")
    .max(60, "Høyst 60 dager")
    .refine((n) => Number.isInteger(n * 2), "Skriv hele eller halve dager"),
  begrunnelse: valgfri(tekst(500, "Begrunnelsen")),
  godkjent: z.boolean().optional(), // eier og administrator: overfør med en gang
});

export function ferieRuter() {
  const r = new Hono();

  // Feriebanken for året: alle ansatte (eier og administrator) eller bare den ansatte selv.
  r.get("/feriebank", async (c) => {
    const aar = aarS.optional().parse(c.req.query("aar")) ?? iAar();
    return c.json(await bruk(c, (db) => alle(db, "select * from faktura.feriebank($1, $2)", [orgId(c), aar])));
  });

  // Én ansatt: saldoen, ferieperiodene med dagene som telles, og overføringene til og fra året.
  r.get("/feriebank/:ansatt", async (c) => {
    const aar = aarS.optional().parse(c.req.query("aar")) ?? iAar();
    const ansatt = uuid.parse(c.req.param("ansatt"));
    return c.json(
      await bruk(c, async (db) => {
        const saldo = await en(db, "select * from faktura.feriebank($1, $2) where ansatt_id = $3", [orgId(c), aar, ansatt]);
        if (!saldo) throw new ApiFeil(404, "Fant ikke feriebanken for den ansatte det året");
        return {
          aar,
          saldo,
          perioder: await alle(db, "select * from faktura.ferie_perioder($1, $2, $3)", [orgId(c), ansatt, aar]),
          overforinger: await alle(db, `${OVERFORING} where o.org_id = $1 and o.ansatt_id = $2 and o.fra_aar in ($3 - 1, $3) order by o.opprettet desc`, [
            orgId(c),
            ansatt,
            aar,
          ]),
        };
      }),
    );
  });

  // Søknader om overføring (status=venter: de som venter på svar).
  r.get("/ferie/overforinger", async (c) => {
    const status = z.enum(["venter", "godkjent", "avslatt"]).optional().parse(c.req.query("status"));
    return c.json(
      await bruk(c, (db) =>
        alle(db, `${OVERFORING} where o.org_id = $1 and ($2::text is null or o.status = $2) order by o.opprettet desc limit 200`, [orgId(c), status ?? null]),
      ),
    );
  });

  // Ny søknad. Den ansatte søker for seg selv; eier og administrator kan også overføre med en gang.
  r.post("/ferie/overforinger", async (c) => {
    const b = soknadSkjema.parse(await c.req.json().catch(() => ({})));
    const meg = c.get("bruker").id;
    const svar = await bruk(c, async (db) => {
      const selv = (await en<{ id: string | null }>(db, "select faktura.min_ansatt($1) as id", [orgId(c)]))!.id;
      const ansatt = b.ansatt_id ?? selv;
      if (!ansatt) throw new ApiFeil(400, "Velg hvem overføringen gjelder");
      const ny = await en<{ id: string }>(
        db,
        `insert into faktura.ferie_overforinger (org_id, ansatt_id, fra_aar, dager, begrunnelse, status)
         values ($1, $2, $3, $4, $5, $6) returning id`,
        [orgId(c), ansatt, b.fra_aar ?? iAar(), b.dager, b.begrunnelse ?? null, b.godkjent ? "godkjent" : "venter"],
      );
      const o = (await en<any>(db, `${OVERFORING} where o.id = $1`, [ny!.id]))!;
      const bruker =
        ansatt === selv ? null : (await en<{ bruker_id: string | null }>(db, "select bruker_id from faktura.ansatte where org_id = $1 and id = $2", [orgId(c), ansatt]))?.bruker_id;
      return { o, bruker };
    });
    const { o } = svar;
    if (o.status === "venter") {
      // Søkt av den ansatte: eier og administrator får vite det.
      await varslePersonal(
        orgId(c),
        meg,
        "fravaer",
        `${o.ansatt_navn} søker om å overføre ferie`,
        `${dagerTekst(o.dager)} fra ${o.fra_aar} til ${o.fra_aar + 1}.${o.begrunnelse ? ` «${o.begrunnelse}»` : ""}`,
        `/ferie?aar=${o.fra_aar}`,
        `ferie-${o.id}`,
      );
    } else if (svar.bruker && svar.bruker !== meg) {
      await varsleAnsatt(orgId(c), svar.bruker, o);
    }
    return c.json(o, 201);
  });

  // Eier og administrator godkjenner eller avslår (databasen sjekker at det er dager nok igjen).
  r.post("/ferie/overforinger/:id/behandle", async (c) => {
    const b = z.object({ godkjent: z.boolean(), svar: valgfri(tekst(500, "Svaret")) }).parse(await c.req.json().catch(() => ({})));
    const id = uuid.parse(c.req.param("id"));
    const svar = await bruk(c, async (db) => {
      await db.query("select faktura.krev($1, 'personal')", [orgId(c)]);
      const foer = await en<{ status: string }>(db, "select status from faktura.ferie_overforinger where org_id = $1 and id = $2", [orgId(c), id]);
      if (!foer) throw new ApiFeil(404, "Fant ikke søknaden");
      if (foer.status !== "venter") throw new ApiFeil(409, "Søknaden er allerede behandlet");
      await db.query("update faktura.ferie_overforinger set status = $3, svar = $4 where org_id = $1 and id = $2", [
        orgId(c),
        id,
        b.godkjent ? "godkjent" : "avslatt",
        b.svar ?? null,
      ]);
      const o = (await en<any>(db, `${OVERFORING} where o.id = $1`, [id]))!;
      const bruker = (await en<{ bruker_id: string | null }>(db, "select bruker_id from faktura.ansatte where org_id = $1 and id = $2", [orgId(c), o.ansatt_id]))?.bruker_id;
      return { o, bruker };
    });
    if (svar.bruker && svar.bruker !== c.get("bruker").id) await varsleAnsatt(orgId(c), svar.bruker, svar.o);
    return c.json(svar.o);
  });

  // Den ansatte trekker en søknad som venter; eier og administrator kan slette alle (en godkjent
  // overføring går da tilbake).
  r.delete("/ferie/overforinger/:id", async (c) => {
    await bruk(c, async (db) => {
      const res = await db.query("delete from faktura.ferie_overforinger where org_id = $1 and id = $2", [orgId(c), uuid.parse(c.req.param("id"))]);
      if (!res.rowCount) throw new ApiFeil(404, "Fant ikke søknaden, eller den er allerede behandlet");
    });
    return c.body(null, 204);
  });

  return r;
}

// Den ansatte får svar på søknaden (eller beskjed om en overføring eieren har gjort).
async function varsleAnsatt(org: string, bruker: string, o: { id: string; status: string; dager: number; fra_aar: number; svar: string | null }) {
  const tittel = o.status === "godkjent" ? "Ferieoverføring godkjent" : "Ferieoverføring avslått";
  const tekst =
    o.status === "godkjent"
      ? `${dagerTekst(o.dager)} er overført fra ${o.fra_aar} til ${o.fra_aar + 1}.`
      : `Søknaden om å overføre ${dagerTekst(o.dager)} fra ${o.fra_aar} er avslått.`;
  await leggIKo({
    type: "varsel",
    varsel: { hendelse: "fravaer", org_id: org, bruker_ider: [bruker], tittel, tekst: o.svar ? `${tekst} «${o.svar}»` : tekst, url: `/ferie?aar=${o.fra_aar}`, tag: `ferie-${o.id}` },
  });
}
