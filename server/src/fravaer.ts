// Fravær (0037_tavle_og_fravaer.sql): sykdom, sykt barn, ferie, permisjon, kurs og annet. Eier og
// administrator registrerer alt fravær; den ansatte melder selv sykdom, og da får eier og
// administrator varsel om hvor mange vakter som trenger vikar. Fravær er helseopplysninger:
// databasen viser det bare til dem som ser de ansatte, og til den ansatte selv.
//
// Egenmelding (0071_egenmelding.sql): den ansatte sender egenmelding for sykdom eller sykt barn
// (med erklæringen), når sykdommen meldes eller etterpå; databasen sjekker reglene (dager per
// gang, ganger og dager i løpet av 12 måneder, to måneder i jobben). Lederen registrerer
// sykmelding fra lege (legeerklæring for sykt barn), eller en egenmelding på papir.
import { Hono, type Context } from "hono";
import { z } from "zod";
import { alle, en, somBruker, type Db } from "./db.js";
import { ApiFeil } from "./feil.js";
import { datoS, tekst, valgfri, varslePersonal } from "./ansatte.js";
import { leggIKo } from "./tjenester.js";
import { virkedag } from "./lonnsberegning.js";

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
  // Sykdom: egenmelding eller sykmelding (legeerklæring for sykt barn), og den ansattes svar på om
  // fraværet har sammenheng med arbeidet. erklaering: den ansatte bekrefter egenmeldingen.
  dokumentasjon: z.enum(["egenmelding", "sykmelding"]).nullable().optional(),
  arbeidsrelatert: z.boolean().nullable().optional(),
  erklaering: z.boolean().optional(),
});

// Typen og notatet ser bare eier, administrator og den ansatte selv (0047_fravaer_skjult.sql);
// andre får typen «fravaer» og ikke notatet.
// Dokumentasjonen (egenmelding eller sykmelding) følger typen: bare for dem som ser den.
const FRAVAER = `
  select f.id, f.ansatt_id, a.fornavn || ' ' || a.etternavn as ansatt_navn, faktura.fravaer_type(f.org_id, f.ansatt_id, f.type) as type, f.fra, f.til,
         case when s.ser then f.notat end as notat,
         case when s.ser then f.dokumentasjon end as dokumentasjon,
         case when s.ser then f.arbeidsrelatert end as arbeidsrelatert,
         case when s.ser then f.egenmeldt end as egenmeldt,
         case when s.ser and f.egenmeldt is not null then f.egenmeldt_av is not distinct from a.bruker_id end as egenmeldt_selv,
         f.opprettet, f.opprettet_av = faktura.bruker_id() as min
    from faktura.fravaer f
    join faktura.ansatte a on a.org_id = f.org_id and a.id = f.ansatt_id
    cross join lateral (select faktura.ser_fravaertype(f.org_id, f.ansatt_id) as ser) s`;

type Fravaer = { id: string; ansatt_id: string; ansatt_navn: string; type: Type; fra: string; til: string; dokumentasjon: "egenmelding" | "sykmelding" | null };
const ERKLAERING = "Bekreft erklæringen for å sende egenmeldingen";

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
      // Den ansatte sender egenmeldingen selv, med erklæringen.
      if (b.dokumentasjon === "egenmelding" && ansatt === selv && !b.erklaering) throw new ApiFeil(400, ERKLAERING);
      const ny = await en<{ id: string }>(
        db,
        "insert into faktura.fravaer (org_id, ansatt_id, type, fra, til, notat, dokumentasjon, arbeidsrelatert) values ($1, $2, $3, $4, $5, $6, $7, $8) returning id",
        [orgId(c), ansatt, b.type, b.fra, b.til, b.notat ?? null, b.dokumentasjon ?? null, b.arbeidsrelatert ?? null],
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
        `${periode(f.fra, f.til)}.${f.dokumentasjon === "egenmelding" ? " Egenmelding er sendt." : ""} ${n ? `${n} ${n === 1 ? "vakt trenger" : "vakter trenger"} vikar.` : "Ingen vakter i perioden."}`,
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

  // Endre fraværet. Den ansatte endrer sluttdatoen og sender egenmelding (med erklæringen) for
  // sykdom som er meldt; lederen får beskjed om egenmeldingen.
  r.patch("/fravaer/:id", async (c) => {
    const { erklaering, ...b } = skjema.omit({ ansatt_id: true }).partial().parse(await c.req.json().catch(() => ({})));
    const felt = Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined));
    const navn = Object.keys(felt);
    if (!navn.length) throw new ApiFeil(400, "Ingen felt å endre");
    const svar = await bruk(c, async (db) => {
      const naa = await en<{ dokumentasjon: string | null; selv: boolean }>(
        db,
        "select dokumentasjon, faktura.er_meg(org_id, ansatt_id) as selv from faktura.fravaer where org_id = $1 and id = $2",
        [orgId(c), id(c)],
      );
      if (!naa) throw new ApiFeil(404, "Fant ikke fraværet");
      const egenmelding = b.dokumentasjon === "egenmelding" && naa.dokumentasjon !== "egenmelding";
      if (egenmelding && naa.selv && !erklaering) throw new ApiFeil(400, ERKLAERING);
      const res = await db.query(`update faktura.fravaer set ${navn.map((k, i) => `${k} = $${i + 3}`).join(", ")} where org_id = $1 and id = $2`, [
        orgId(c),
        id(c),
        ...navn.map((k) => felt[k]),
      ]);
      if (!res.rowCount) throw new ApiFeil(404, "Fant ikke fraværet");
      return { f: (await en<Fravaer>(db, `${FRAVAER} where f.id = $1`, [id(c)]))!, egenmeldt: egenmelding && naa.selv };
    });
    if (svar.egenmeldt)
      await varslePersonal(
        orgId(c),
        c.get("bruker").id,
        "fravaer",
        `Egenmelding fra ${svar.f.ansatt_navn}`,
        `${FRAVAERTYPER[svar.f.type]}, ${periode(svar.f.fra, svar.f.til)}.`,
        `/ansatte/${svar.f.ansatt_id}`,
        `egenmelding-${svar.f.id}`,
      );
    return c.json(svar.f);
  });

  r.delete("/fravaer/:id", async (c) => {
    await bruk(c, async (db) => {
      const res = await db.query("delete from faktura.fravaer where org_id = $1 and id = $2", [orgId(c), id(c)]);
      if (!res.rowCount) throw new ApiFeil(404, "Fant ikke fraværet");
    });
    return c.body(null, 204);
  });

  // Egenmeldingene til en ansatt (standard: den innloggede selv): reglene, når retten begynner
  // (to måneder i jobben), hva som er brukt i løpet av 12 måneder (egen sykdom), og dagene med
  // sykt barn i år (omsorgsdagene: virkedagene).
  r.get("/egenmelding", async (c) => {
    const q = z.object({ ansatt: uuid.optional() }).parse(c.req.query());
    return c.json(
      await bruk(c, async (db) => {
        const ansatt = q.ansatt ?? (await en<{ id: string | null }>(db, "select faktura.min_ansatt($1) as id", [orgId(c)]))!.id;
        if (!ansatt) throw new ApiFeil(400, "Du er ikke registrert som ansatt her");
        const a = await en<{ ansatt_fra: string; opptjent_fra: string; i_dag: string; tilgang: boolean }>(
          db,
          `select to_char(a.ansatt_fra, 'YYYY-MM-DD') as ansatt_fra, to_char((a.ansatt_fra + interval '2 months')::date, 'YYYY-MM-DD') as opptjent_fra,
                  to_char(faktura.i_dag(), 'YYYY-MM-DD') as i_dag, faktura.er_meg(a.org_id, a.id) or faktura.kan(a.org_id, 'personal_les') as tilgang
             from faktura.ansatte a where a.org_id = $1 and a.id = $2`,
          [orgId(c), ansatt],
        );
        if (!a?.tilgang) throw new ApiFeil(404, "Fant ikke den ansatte");
        const regler = (await en<{ dager: number; ganger: number | null; dager_aar: number | null; barn_dager: number }>(
          db,
          "select * from faktura.egenmelding_regler($1)",
          [orgId(c)],
        ))!;
        const brukt = (await en<{ ganger: number; dager: number }>(db, "select * from faktura.egenmelding_brukt($1, $2, faktura.i_dag())", [orgId(c), ansatt]))!;
        const tilfeller = await alle<{ fra: string; til: string; dager: number }>(
          db,
          `select to_char(x.fra, 'YYYY-MM-DD') as fra, to_char(x.til, 'YYYY-MM-DD') as til, x.til - x.fra + 1 as dager
             from faktura.egenmelding_tilfeller($1, $2, 'syk') x
            where x.til > (faktura.i_dag() - interval '12 months')::date order by x.fra desc`,
          [orgId(c), ansatt],
        );
        const aar = a.i_dag.slice(0, 4);
        const barn = await alle<{ fra: string; til: string }>(
          db,
          `select to_char(greatest(fra, make_date($3, 1, 1)), 'YYYY-MM-DD') as fra, to_char(least(til, make_date($3, 12, 31)), 'YYYY-MM-DD') as til
             from faktura.fravaer where org_id = $1 and ansatt_id = $2 and type = 'sykt_barn' and til >= make_date($3, 1, 1) and fra <= make_date($3, 12, 31)`,
          [orgId(c), ansatt, Number(aar)],
        );
        let barnedager = 0;
        for (const f of barn) for (let d = f.fra; d <= f.til; d = nesteDag(d)) if (virkedag(d)) barnedager++;
        return { ansatt_id: ansatt, regler, ansatt_fra: a.ansatt_fra, opptjent_fra: a.opptjent_fra, brukt, tilfeller, sykt_barn: { aar: Number(aar), dager: barnedager } };
      }),
    );
  });

  return r;
}

const nesteDag = (d: string) => new Date(Date.parse(`${d}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
