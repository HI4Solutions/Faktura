// Fravær (0037_tavle_og_fravaer.sql): sykdom, sykt barn, ferie, permisjon, kurs og annet. Eier og
// administrator registrerer alt fravær; den ansatte melder selv sykdom, og da får eier og
// administrator varsel om hvor mange vakter som trenger vikar. Fravær er helseopplysninger:
// databasen viser det bare til dem som ser de ansatte, og til den ansatte selv.
//
// Egenmelding (0071_egenmelding.sql): den ansatte sender egenmelding for sykdom eller sykt barn
// (med erklæringen), når sykdommen meldes eller etterpå; databasen sjekker reglene (dager per
// gang, ganger og dager i løpet av 12 måneder, to måneder i jobben). Lederen registrerer
// sykmelding fra lege (legeerklæring for sykt barn), eller en egenmelding på papir.
//
// Avspasering (0073_timebank.sql): fri fra timebanken i hele dager, med timene den tar fra banken.
// Lederen registrerer den her; den ansatte søker om den (server/src/timebank.ts).
//
// Permisjon med lønn (0074_vaktbytte_fridag.sql, betalt): med fastlønn går lønnen som vanlig, med
// timelønn lønnes timene. Den registreres også når den som gir bort en fast arbeidsdag, tar
// fridagen som betalt fravær (server/src/vaktbytte.ts).
//
// Permisjon og permittering (0084_permisjon_permittering.sql, server/src/permisjoner.ts): arten
// (som i a-meldingen; permittering er en egen), prosenten av stillingen, om sluttdatoen er ukjent,
// og for permitteringen datoen varselet ble gitt og lønnsplikten (standard: de 15 første
// arbeidsdagene). Delvis permisjon gjør ikke den ansatte borte i planen. Eier og administrator
// lager varselet om permittering som PDF.
import { Hono, type Context } from "hono";
import { z } from "zod";
import { alle, en, somBruker, type Db } from "./db.js";
import { ApiFeil } from "./feil.js";
import { datoS, tekst, valgfri, varslePersonal } from "./ansatte.js";
import { leggIKo } from "./tjenester.js";
import { virkedag } from "./lonnsberegning.js";
import { ARTER, fritaksperiode, lonnspliktDager, lonnspliktSlutt, permisjonNavn } from "./permisjoner.js";
import { lagPermitteringsvarselPdf } from "./permitteringsvarselPdf.js";
import { hentLogo } from "./dokument.js";

const uuid = z.string().uuid();
const orgId = (c: Context) => uuid.parse(c.req.param("org"));
const id = (c: Context) => uuid.parse(c.req.param("id"));
const bruk = <T>(c: Context, fn: (db: Db) => Promise<T>) => somBruker<T>(c.get("bruker").id, fn);

export const FRAVAERTYPER = {
  syk: "Syk",
  sykt_barn: "Sykt barn",
  ferie: "Ferie",
  permisjon: "Permisjon",
  kurs: "Kurs",
  avspasering: "Avspasering",
  annet: "Annet fravær",
} as const;
type Type = keyof typeof FRAVAERTYPER;
// Permisjon: arten («Foreldrepermisjon», «Permittering», «Permisjon med lønn» …), ellers typen.
export const fravaerNavn = (type: Type, betalt?: boolean | null, art?: string | null) => (type === "permisjon" ? permisjonNavn(art, betalt) : FRAVAERTYPER[type]);

const dagFormat = new Intl.DateTimeFormat("nb-NO", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
const dag = (iso: string) => dagFormat.format(new Date(`${iso}T12:00:00Z`));
const visDato = (iso: string) => iso.split("-").reverse().join(".");
export const periode = (fra: string, til: string) => (fra === til ? dag(fra) : `${dag(fra)}–${dag(til)}`);

const skjema = z.object({
  ansatt_id: uuid.optional(), // standard: den innloggede selv
  type: z.enum(["syk", "sykt_barn", "ferie", "permisjon", "kurs", "avspasering", "annet"], { error: "Velg hva slags fravær" }),
  fra: datoS,
  til: datoS,
  notat: valgfri(tekst(500, "Notatet")),
  // Avspasering: timene den tar fra timebanken. Permisjon med lønn: timene som lønnes.
  timer: z.number({ error: "Skriv antall timer" }).gt(0, "Skriv antall timer").max(2000, "For mange timer").nullable().optional(),
  betalt: z.boolean().optional(), // permisjon med lønn
  // Sykdom: egenmelding eller sykmelding (legeerklæring for sykt barn), og den ansattes svar på om
  // fraværet har sammenheng med arbeidet. erklaering: den ansatte bekrefter egenmeldingen.
  dokumentasjon: z.enum(["egenmelding", "sykmelding"]).nullable().optional(),
  arbeidsrelatert: z.boolean().nullable().optional(),
  erklaering: z.boolean().optional(),
  // Gradert sykmelding: graden (1–99 %; null er 100 %).
  sykmeldingsgrad: z.number({ error: "Skriv sykmeldingsgraden" }).int("Sykmeldingsgraden er et helt tall").min(1, "Graden er minst 1 %").max(100, "Graden er høyst 100 %").nullable().optional(),
  // Permisjon (0084): arten, prosenten av stillingen (null er 100 %), om sluttdatoen er ukjent, og
  // for permitteringen datoen varselet ble gitt og den siste dagen med lønnsplikt (null: ingen).
  permisjon_art: z.enum(ARTER, { error: "Velg hva slags permisjon" }).nullable().optional(),
  prosent: z.number({ error: "Skriv prosenten" }).int("Prosenten er et helt tall").min(1, "Prosenten er minst 1").max(100, "Prosenten er høyst 100").nullable().optional(),
  slutt_ukjent: z.boolean().optional(),
  varslet: datoS.nullable().optional(),
  lonnsplikt_til: datoS.nullable().optional(),
});

// Datoene på en permittering: varselet er gitt før den begynner, og lønnsplikten slutter ikke før.
function sjekkPermittering(fra: string, varslet: string | null | undefined, lonnspliktTil: string | null | undefined) {
  if (varslet && varslet > fra) throw new ApiFeil(400, "Varselet må være gitt før permitteringen begynner");
  if (lonnspliktTil && lonnspliktTil < fra) throw new ApiFeil(400, "Lønnsplikten kan ikke slutte før permitteringen begynner");
}

// Merknadene til en permittering som lagres: når fritaksperioden (26 uker i løpet av 18 måneder)
// blir brukt opp, og meldingen til NAV når minst 10 ansatte permitteres (arbeidsmarkedsloven § 8;
// regnet som permitteringene som begynner innen 30 dager før eller etter denne).
async function permitteringsmerknader(db: Db, org: string, f: { id: string; ansatt_id: string; fra: string; til: string }) {
  const ut: string[] = [];
  const egne = await alle<{ id: string; fra: string; til: string; lonnsplikt_til: string | null }>(
    db,
    `select id, to_char(fra, 'YYYY-MM-DD') as fra, to_char(til, 'YYYY-MM-DD') as til, to_char(lonnsplikt_til, 'YYYY-MM-DD') as lonnsplikt_til
       from faktura.fravaer
      where org_id = $1 and ansatt_id = $2 and type = 'permisjon' and permisjon_art = 'permittering' and til >= ($3::date - interval '19 months') and fra <= $4`,
    [org, f.ansatt_id, f.fra, f.til],
  );
  const igjen = fritaksperiode(egne).get(f.id);
  if (igjen)
    ut.push(
      `Fritaksperioden (26 uker i løpet av 18 måneder) blir brukt opp: lønnsplikten gjelder igjen fra ${visDato(igjen)}, og lønnskjøringen trekker ikke lønnen etter det. Avslutt permitteringen før, eller betal lønnen.`,
    );
  const n = await en<{ n: number }>(
    db,
    `select count(distinct ansatt_id)::int as n from faktura.fravaer
      where org_id = $1 and type = 'permisjon' and permisjon_art = 'permittering' and fra between ($2::date - 30) and ($2::date + 30)`,
    [org, f.fra],
  );
  if ((n?.n ?? 0) >= 10)
    ut.push(
      `${n!.n} ansatte permitteres innen 30 dager. Når minst 10 permitteres, skal arbeidsgiveren gi melding til NAV senest samtidig med varselet til de ansatte (arbeidsmarkedsloven § 8, på nav.no).`,
    );
  return ut;
}

// Typen og notatet ser bare eier, administrator og den ansatte selv (0047_fravaer_skjult.sql);
// andre får typen «fravaer» og ikke notatet.
// Dokumentasjonen (egenmelding eller sykmelding) følger typen: bare for dem som ser den.
const FRAVAER = `
  select f.id, f.ansatt_id, a.fornavn || ' ' || a.etternavn as ansatt_navn, faktura.fravaer_type(f.org_id, f.ansatt_id, f.type) as type, f.fra, f.til,
         case when s.ser then f.notat end as notat,
         case when s.ser then f.dokumentasjon end as dokumentasjon,
         case when s.ser then f.arbeidsrelatert end as arbeidsrelatert,
         case when s.ser then f.egenmeldt end as egenmeldt,
         case when s.ser then f.timer end as timer,
         case when s.ser then f.betalt end as betalt,
         case when s.ser then f.sykmeldingsgrad end as sykmeldingsgrad,
         case when s.ser then f.nav_sykmelding is not null end as fra_nav,
         case when s.ser then f.permisjon_art end as permisjon_art,
         case when s.ser then f.prosent end as prosent,
         case when s.ser then f.slutt_ukjent end as slutt_ukjent,
         case when s.ser then f.varslet end as varslet,
         case when s.ser then f.lonnsplikt_til end as lonnsplikt_til,
         f.prosent is not null as delvis,
         case when s.ser and f.egenmeldt is not null then f.egenmeldt_av is not distinct from a.bruker_id end as egenmeldt_selv,
         f.opprettet, f.opprettet_av = faktura.bruker_id() as min
    from faktura.fravaer f
    join faktura.ansatte a on a.org_id = f.org_id and a.id = f.ansatt_id
    cross join lateral (select faktura.ser_fravaertype(f.org_id, f.ansatt_id) as ser) s`;

type Fravaer = {
  id: string;
  ansatt_id: string;
  ansatt_navn: string;
  type: Type;
  fra: string;
  til: string;
  dokumentasjon: "egenmelding" | "sykmelding" | null;
  betalt: boolean | null;
  permisjon_art: string | null;
};
const ERKLAERING = "Bekreft erklæringen for å sende egenmeldingen";

// Ukedagene (1 = mandag) i den faste arbeidsplanen som gjelder på datoen; tom uten fast plan.
async function planUkedager(db: Db, org: string, ansatt: string, dato: string): Promise<number[]> {
  const r = await en<{ dager: number[] }>(
    db,
    `select coalesce(array_agg(d.ukedag order by d.ukedag), '{}') as dager
       from faktura.arbeidsplan_dager d
      where d.org_id = $1
        and d.plan_id = (select p.id from faktura.arbeidsplaner p where p.org_id = $1 and p.ansatt_id = $2 and p.gjelder_fra <= $3::date
                          order by p.gjelder_fra desc limit 1)`,
    [org, ansatt, dato],
  );
  return r?.dager ?? [];
}

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
    const permittering = b.type === "permisjon" && b.permisjon_art === "permittering";
    if (permittering) sjekkPermittering(b.fra, b.varslet, b.lonnsplikt_til);
    const meg = c.get("bruker").id;
    const svar = await bruk(c, async (db) => {
      const selv = (await en<{ id: string | null }>(db, "select faktura.min_ansatt($1) as id", [orgId(c)]))!.id;
      const ansatt = b.ansatt_id ?? selv;
      if (!ansatt) throw new ApiFeil(400, "Velg hvem fraværet gjelder");
      // Den ansatte sender egenmeldingen selv, med erklæringen.
      if (b.dokumentasjon === "egenmelding" && ansatt === selv && !b.erklaering) throw new ApiFeil(400, ERKLAERING);
      const ny = await en<{ id: string }>(
        db,
        `insert into faktura.fravaer (org_id, ansatt_id, type, fra, til, notat, dokumentasjon, arbeidsrelatert, timer, betalt, sykmeldingsgrad,
                                      permisjon_art, prosent, slutt_ukjent, varslet, lonnsplikt_til)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) returning id`,
        [
          orgId(c),
          ansatt,
          b.type,
          b.fra,
          b.til,
          b.notat ?? null,
          b.dokumentasjon ?? null,
          b.arbeidsrelatert ?? null,
          b.type === "avspasering" || (b.type === "permisjon" && b.betalt) ? (b.timer ?? null) : null,
          b.type === "permisjon" && !!b.betalt && !permittering,
          b.type === "syk" && b.sykmeldingsgrad != null && b.sykmeldingsgrad < 100 ? b.sykmeldingsgrad : null,
          b.type === "permisjon" ? (b.permisjon_art ?? null) : null,
          b.type === "permisjon" && b.prosent != null && b.prosent < 100 ? b.prosent : null,
          b.type === "permisjon" && !!b.slutt_ukjent,
          permittering ? (b.varslet ?? null) : null,
          // Lønnsplikten: standard de 15 første arbeidsdagene etter arbeidsplanen (de permitterte timene
          // summert ved delvis permittering).
          permittering
            ? b.lonnsplikt_til === undefined
              ? lonnspliktSlutt(b.fra, lonnspliktDager(b.prosent), await planUkedager(db, orgId(c), ansatt, b.fra))
              : b.lonnsplikt_til
            : null,
        ],
      );
      const f = (await en<Fravaer>(db, `${FRAVAER} where f.id = $1`, [ny!.id]))!;
      const merknader = permittering ? await permitteringsmerknader(db, orgId(c), f) : [];
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
      return { f, vakter, selv: ansatt === selv, bruker, merknader };
    });
    const { f, vakter, merknader } = svar;
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
          tittel: `${fravaerNavn(f.type, f.betalt, f.permisjon_art)} registrert`,
          tekst: `${periode(f.fra, f.til)}.`,
          url: "/vakter?fane=mine",
          tag: `fravaer-${f.id}`,
        },
      });
    }
    return c.json({ ...f, vakter, merknader }, 201);
  });

  // Endre fraværet. Den ansatte endrer sluttdatoen og sender egenmelding (med erklæringen) for
  // sykdom som er meldt; lederen får beskjed om egenmeldingen.
  r.patch("/fravaer/:id", async (c) => {
    const { erklaering, ...b } = skjema.omit({ ansatt_id: true }).partial().parse(await c.req.json().catch(() => ({})));
    // 100 % er det samme som ingen grad.
    if (b.sykmeldingsgrad === 100) b.sykmeldingsgrad = null;
    if (b.prosent === 100) b.prosent = null;
    const svar = await bruk(c, async (db) => {
      const naa = await en<{
        dokumentasjon: string | null;
        selv: boolean;
        ansatt_id: string;
        fra: string;
        permisjon_art: string | null;
        varslet: string | null;
        lonnsplikt_til: string | null;
        prosent: number | null;
      }>(
        db,
        `select dokumentasjon, faktura.er_meg(org_id, ansatt_id) as selv, ansatt_id, fra, permisjon_art, varslet, lonnsplikt_til, prosent
           from faktura.fravaer where org_id = $1 and id = $2`,
        [orgId(c), id(c)],
      );
      if (!naa) throw new ApiFeil(404, "Fant ikke fraværet");
      // Blir fraværet en permittering, er lønnsplikten standard de 15 første arbeidsdagene.
      const art = b.permisjon_art !== undefined ? b.permisjon_art : naa.permisjon_art;
      if (art === "permittering" && (b.type ?? "permisjon") === "permisjon") {
        if (b.lonnsplikt_til === undefined && naa.permisjon_art !== "permittering")
          b.lonnsplikt_til = lonnspliktSlutt(
            b.fra ?? naa.fra,
            lonnspliktDager(b.prosent !== undefined ? b.prosent : naa.prosent),
            await planUkedager(db, orgId(c), naa.ansatt_id, b.fra ?? naa.fra),
          );
        sjekkPermittering(
          b.fra ?? naa.fra,
          b.varslet !== undefined ? b.varslet : naa.varslet,
          b.lonnsplikt_til !== undefined ? b.lonnsplikt_til : naa.lonnsplikt_til,
        );
      }
      const felt = Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined));
      const navn = Object.keys(felt);
      if (!navn.length) throw new ApiFeil(400, "Ingen felt å endre");
      const egenmelding = b.dokumentasjon === "egenmelding" && naa.dokumentasjon !== "egenmelding";
      if (egenmelding && naa.selv && !erklaering) throw new ApiFeil(400, ERKLAERING);
      const res = await db.query(`update faktura.fravaer set ${navn.map((k, i) => `${k} = $${i + 3}`).join(", ")} where org_id = $1 and id = $2`, [
        orgId(c),
        id(c),
        ...navn.map((k) => felt[k]),
      ]);
      if (!res.rowCount) throw new ApiFeil(404, "Fant ikke fraværet");
      const f = (await en<Fravaer>(db, `${FRAVAER} where f.id = $1`, [id(c)]))!;
      const merknader = f.permisjon_art === "permittering" ? await permitteringsmerknader(db, orgId(c), f) : [];
      return { f, egenmeldt: egenmelding && naa.selv, merknader };
    });
    if (svar.egenmeldt)
      await varslePersonal(
        orgId(c),
        c.get("bruker").id,
        "fravaer",
        `Egenmelding fra ${svar.f.ansatt_navn}`,
        `${fravaerNavn(svar.f.type, svar.f.betalt, svar.f.permisjon_art)}, ${periode(svar.f.fra, svar.f.til)}.`,
        `/ansatte/${svar.f.ansatt_id}`,
        `egenmelding-${svar.f.id}`,
      );
    return c.json({ ...svar.f, merknader: svar.merknader });
  });

  r.delete("/fravaer/:id", async (c) => {
    await bruk(c, async (db) => {
      const res = await db.query("delete from faktura.fravaer where org_id = $1 and id = $2", [orgId(c), id(c)]);
      if (!res.rowCount) throw new ApiFeil(404, "Fant ikke fraværet");
    });
    return c.body(null, 204);
  });

  // Varselet om permittering som PDF (eier og administrator).
  r.get("/fravaer/:id/permitteringsvarsel", async (c) => {
    const x = await bruk(c, async (db) => {
      await db.query("select faktura.krev($1, 'personal')", [orgId(c)]);
      const f = await en<{
        permisjon_art: string | null;
        fra: string;
        til: string;
        prosent: number | null;
        slutt_ukjent: boolean;
        varslet: string | null;
        lonnsplikt_til: string | null;
        notat: string | null;
        navn: string;
        ansattnummer: number;
        adresse: string | null;
        postnr: string | null;
        poststed: string | null;
        i_dag: string;
      }>(
        db,
        `select f.permisjon_art, f.fra, f.til, f.prosent, f.slutt_ukjent, f.varslet, f.lonnsplikt_til, f.notat,
                a.fornavn || ' ' || a.etternavn as navn, a.ansattnummer, a.adresse, a.postnr, a.poststed, faktura.i_dag()::text as i_dag
           from faktura.fravaer f join faktura.ansatte a on a.org_id = f.org_id and a.id = f.ansatt_id
          where f.org_id = $1 and f.id = $2`,
        [orgId(c), id(c)],
      );
      if (!f) throw new ApiFeil(404, "Fant ikke fraværet");
      if (f.permisjon_art !== "permittering") throw new ApiFeil(400, "Fraværet er ikke en permittering");
      if (!f.notat) throw new ApiFeil(400, "Skriv grunnen til permitteringen først (i notatet)");
      const o = (await en<any>(db, "select navn, orgnr, adresse, postnr, poststed, epost, telefon, farge, logo_sti from faktura.organisasjoner where id = $1", [orgId(c)]))!;
      return { f, o };
    });
    const { f, o } = x;
    const pdf = await lagPermitteringsvarselPdf(
      {
        navn: f.navn,
        ansattnummer: f.ansattnummer,
        adresse: f.adresse,
        postnr: f.postnr,
        poststed: f.poststed,
        fra: f.fra,
        til: f.til,
        slutt_ukjent: f.slutt_ukjent,
        prosent: f.prosent ?? 100,
        varslet: f.varslet ?? f.i_dag,
        lonnsplikt_til: f.lonnsplikt_til,
        grunn: f.notat!,
      },
      o,
      await hentLogo(o.logo_sti),
    );
    return c.body(Buffer.from(pdf), 200, {
      "content-type": "application/pdf",
      "content-disposition": `inline; filename="permitteringsvarsel-${f.ansattnummer}-${f.fra}.pdf"`,
    });
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
