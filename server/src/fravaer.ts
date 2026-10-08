// Fravær (0037_tavle_og_fravaer.sql): sykdom, sykt barn, ferie, permisjon, kurs og annet. Eier og
// administrator registrerer alt fravær; den ansatte melder selv sykdom, og da får eier og
// administrator varsel om hvor mange vakter som trenger vikar. Fravær er helseopplysninger:
// databasen viser det bare til dem som ser de ansatte, og til den ansatte selv.
import { Hono, type Context } from "hono";
import { z } from "zod";
import { alle, en, somBruker, type Db } from "./db.js";
import { ApiFeil } from "./feil.js";
import { datoS, tekst, valgfri, varslePersonal } from "./ansatte.js";
import { leggIKo } from "./tjenester.js";

const uuid = z.string().uuid();
const orgId = (c: Context) => uuid.parse(c.req.param("org"));
const id = (c: Context) => uuid.parse(c.req.param("id"));
const bruk = <T>(c: Context, fn: (db: Db) => Promise<T>) => somBruker<T>(c.get("bruker").id, fn);

export const FRAVAERTYPER = { syk: "Syk", sykt_barn: "Sykt barn", ferie: "Ferie", permisjon: "Permisjon", kurs: "Kurs", annet: "Annet fravær" } as const;
type Type = keyof typeof FRAVAERTYPER;

const dagFormat = new Intl.DateTimeFormat("nb-NO", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
const dag = (iso: string) => dagFormat.format(new Date(`${iso}T12:00:00Z`));
export const periode = (fra: string, til: string) => (fra === til ? dag(fra) : `${dag(fra)}–${dag(til)}`);

const skjema = z.object({
  ansatt_id: uuid.optional(), // standard: den innloggede selv
  type: z.enum(["syk", "sykt_barn", "ferie", "permisjon", "kurs", "annet"], { error: "Velg hva slags fravær" }),
  fra: datoS,
  til: datoS,
  notat: valgfri(tekst(500, "Notatet")),
});

// Typen og notatet ser bare eier, administrator og den ansatte selv (0047_fravaer_skjult.sql);
// andre får typen «fravaer» og ikke notatet.
const FRAVAER = `
  select f.id, f.ansatt_id, a.fornavn || ' ' || a.etternavn as ansatt_navn, faktura.fravaer_type(f.org_id, f.ansatt_id, f.type) as type, f.fra, f.til,
         case when faktura.ser_fravaertype(f.org_id, f.ansatt_id) then f.notat end as notat,
         f.opprettet, f.opprettet_av = faktura.bruker_id() as min
    from faktura.fravaer f
    join faktura.ansatte a on a.org_id = f.org_id and a.id = f.ansatt_id`;

type Fravaer = { id: string; ansatt_id: string; ansatt_navn: string; type: Type; fra: string; til: string };

export function fravaerRuter() {
  const r = new Hono();

  // Fraværet som overlapper perioden (den ansatte ser bare sitt eget).
  r.get("/fravaer", async (c) => {
    const q = z.object({ fra: datoS, til: datoS, ansatt: uuid.optional() }).parse(c.req.query());
    if (q.til < q.fra) throw new ApiFeil(400, "Slutten er før starten");
    return c.json(
      await bruk(c, (db) =>
        alle(db, `${FRAVAER} where f.org_id = $1 and f.til >= $2 and f.fra <= $3 and ($4::uuid is null or f.ansatt_id = $4) order by f.fra, a.etternavn, a.fornavn`, [
          orgId(c),
          q.fra,
          q.til,
          q.ansatt ?? null,
        ]),
      ),
    );
  });

  // Nytt fravær. Med svaret følger vaktene i perioden som ikke har vikar ennå.
  r.post("/fravaer", async (c) => {
    const b = skjema.parse(await c.req.json().catch(() => ({})));
    if (b.til < b.fra) throw new ApiFeil(400, "Sluttdatoen er før startdatoen");
    const meg = c.get("bruker").id;
    const svar = await bruk(c, async (db) => {
      const selv = (await en<{ id: string | null }>(db, "select faktura.min_ansatt($1) as id", [orgId(c)]))!.id;
      const ansatt = b.ansatt_id ?? selv;
      if (!ansatt) throw new ApiFeil(400, "Velg hvem fraværet gjelder");
      const ny = await en<{ id: string }>(
        db,
        "insert into faktura.fravaer (org_id, ansatt_id, type, fra, til, notat) values ($1, $2, $3, $4, $5, $6) returning id",
        [orgId(c), ansatt, b.type, b.fra, b.til, b.notat ?? null],
      );
      const f = (await en<Fravaer>(db, `${FRAVAER} where f.id = $1`, [ny!.id]))!;
      const vakter = await alle<{ id: string; dato: string; fra: string; til: string; oppgave: string | null }>(
        db,
        `select v.id, v.dato, to_char(v.fra, 'HH24:MI') as fra, to_char(v.til, 'HH24:MI') as til, v.oppgave
           from faktura.vakter v
          where v.org_id = $1 and v.ansatt_id = $2 and v.dato between $3 and $4
            and not exists (select 1 from faktura.vakter x where x.org_id = v.org_id and x.vikar_for = v.id)
          order by v.dato, v.fra`,
        [orgId(c), ansatt, b.fra, b.til],
      );
      const bruker =
        ansatt === selv ? null : (await en<{ bruker_id: string | null }>(db, "select bruker_id from faktura.ansatte where org_id = $1 and id = $2", [orgId(c), ansatt]))?.bruker_id;
      return { f, vakter, selv: ansatt === selv, bruker };
    });
    const { f, vakter } = svar;
    if (svar.selv) {
      // Meldt av den ansatte selv: eier og administrator får vite det, med vaktene som trenger vikar.
      const n = vakter.length;
      await varslePersonal(
        orgId(c),
        meg,
        "fravaer",
        f.type === "sykt_barn" ? `${f.ansatt_navn} har sykt barn` : `${f.ansatt_navn} er syk`,
        `${periode(f.fra, f.til)}. ${n ? `${n} ${n === 1 ? "vakt trenger" : "vakter trenger"} vikar.` : "Ingen vakter i perioden."}`,
        `/vakter?fane=tavle&dato=${f.fra}`,
        `fravaer-${f.id}`,
      );
    } else if (svar.bruker && svar.bruker !== meg) {
      // Registrert av leder: den ansatte får beskjed.
      await leggIKo({
        type: "varsel",
        varsel: {
          hendelse: "fravaer",
          org_id: orgId(c),
          bruker_ider: [svar.bruker],
          tittel: `${FRAVAERTYPER[f.type]} registrert`,
          tekst: `${periode(f.fra, f.til)}.`,
          url: "/vakter?fane=mine",
          tag: `fravaer-${f.id}`,
        },
      });
    }
    return c.json({ ...f, vakter }, 201);
  });

  r.patch("/fravaer/:id", async (c) => {
    const b = skjema.omit({ ansatt_id: true }).partial().parse(await c.req.json().catch(() => ({})));
    const felt = Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined));
    const navn = Object.keys(felt);
    if (!navn.length) throw new ApiFeil(400, "Ingen felt å endre");
    const f = await bruk(c, async (db) => {
      const res = await db.query(`update faktura.fravaer set ${navn.map((k, i) => `${k} = $${i + 3}`).join(", ")} where org_id = $1 and id = $2`, [
        orgId(c),
        id(c),
        ...navn.map((k) => felt[k]),
      ]);
      if (!res.rowCount) throw new ApiFeil(404, "Fant ikke fraværet");
      return en(db, `${FRAVAER} where f.id = $1`, [id(c)]);
    });
    return c.json(f);
  });

  r.delete("/fravaer/:id", async (c) => {
    await bruk(c, async (db) => {
      const res = await db.query("delete from faktura.fravaer where org_id = $1 and id = $2", [orgId(c), id(c)]);
      if (!res.rowCount) throw new ApiFeil(404, "Fant ikke fraværet");
    });
    return c.body(null, 204);
  });

  return r;
}
