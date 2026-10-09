// A-meldingen i appen (0077_amelding.sql, amelding.ts, ameldingInnsending.ts): månedene i året
// med det som skal rapporteres, grunnlaget og avvikene for en måned, bestilling av fila (XML til
// opplasting på skatteetaten.no) eller innsending til Skatteetatens API, lenken til fila, og
// merking av fila som lastet opp (så en ny melding for måneden erstatter den). Eier, administrator
// og regnskap ser alt; eier og administrator bestiller (med totrinnsbekreftelse, fila har
// fødselsnumrene) og laster ned fila.
import { Hono, type Context } from "hono";
import { z } from "zod";
import { config } from "./config.js";
import { alle, en, somBruker, type Db } from "./db.js";
import { ApiFeil } from "./feil.js";
import { krevMfa } from "./auth.js";
import { hentGrunnlag, kontroller, oppsummer } from "./amelding.js";
import { A_ORDNING } from "./altinn.js";
import { hentUnderenheter } from "./brreg.js";
import { pluss, virkedag } from "./lonnsberegning.js";
import { lagring, leggIKo } from "./tjenester.js";

const uuid = z.string().uuid();
const orgId = (c: Context) => uuid.parse(c.req.param("org"));
const bruk = <T>(c: Context, fn: (db: Db) => Promise<T>) => somBruker<T>(c.get("bruker").id, fn);
const maanedS = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Velg en måned (ÅÅÅÅ-MM)");
const osloIDag = () => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Oslo" }).format(new Date());

// Fristen: den 5. i måneden etter, eller neste virkedag.
export function frist(maaned: string) {
  const [a, m] = maaned.split("-").map(Number) as [number, number];
  let d = m === 12 ? `${a + 1}-01-05` : `${a}-${String(m + 1).padStart(2, "0")}-05`;
  while (!virkedag(d)) d = pluss(d, 1);
  return d;
}

const RAD = `
  select id, to_char(maaned, 'YYYY-MM') as maaned, meldings_id, erstatter, innsending, status, oppsummering, forsendelse_id, tilbakemelding,
         feil, opprettet, sendt_at, (select coalesce(b.navn, b.epost) from faktura.brukere b where b.id = laget_av) as laget_av
    from faktura.ameldinger`;

// Om meldingen kan sendes til API-et (slått på, og systembrukeren har «A-ordningen»).
async function innsending(db: Db, org: string) {
  const t = await en<{ status: string; pakker: string[] }>(db, "select status, pakker from faktura.skattekort_tilgang where org_id = $1", [org]);
  return {
    pa: config.ameldingInnsending,
    tilgang: Boolean(t && t.status === "godkjent" && t.pakker.includes(A_ORDNING)),
    miljo: config.skatteetatenMiljo,
  };
}

export function ameldingRuter() {
  const r = new Hono();

  // Månedene i året: hva som er levert, og om noe skal rapporteres (lønn eller arbeidsforhold).
  r.get("/amelding", async (c) => {
    const aar = z.coerce.number().int().min(2015).max(2100).parse(c.req.query("aar") ?? osloIDag().slice(0, 4));
    return c.json(
      await bruk(c, async (db) => {
        await db.query("select faktura.krev($1, 'personal_les')", [orgId(c)]);
        const lonn = await alle<{ maaned: string; antall: number; skattetrekk: number; brutto: number }>(
          db,
          `select to_char(s.utbetalingsdato, 'YYYY-MM') as maaned, count(distinct s.ansatt_id)::int as antall,
                  sum(s.skattetrekk)::float8 as skattetrekk, sum(s.brutto)::float8 as brutto
             from faktura.lonnsslipper s join faktura.lonnskjoringer k on k.id = s.kjoring_id
            where s.org_id = $1 and k.status = 'godkjent' and extract(year from s.utbetalingsdato) = $2
            group by 1`,
          [orgId(c), aar],
        );
        const ansatte = await alle<{ maaned: string; antall: number }>(
          db,
          `select to_char(m, 'YYYY-MM') as maaned, count(a.id)::int as antall
             from generate_series(make_date($2, 1, 1), make_date($2, 12, 1), interval '1 month') m
             left join faktura.ansatte a on a.org_id = $1 and a.arbeidstaker and a.ansatt_fra < m + interval '1 month'
                                          and (a.ansatt_til is null or a.ansatt_til >= m)
            group by m`,
          [orgId(c), aar],
        );
        const meldinger = await alle<any>(db, `${RAD} where org_id = $1 and extract(year from maaned) = $2 order by opprettet desc`, [orgId(c), aar]);
        const iDag = osloIDag();
        const maaneder = Array.from({ length: 12 }, (_, i) => `${aar}-${String(i + 1).padStart(2, "0")}`)
          .filter((m) => `${m}-01` <= iDag)
          .map((m) => {
            const l = lonn.find((x) => x.maaned === m);
            const siste = meldinger.find((x) => x.maaned === m) ?? null;
            return {
              maaned: m,
              frist: frist(m),
              med_lonn: l?.antall ?? 0,
              arbeidsforhold: ansatte.find((x) => x.maaned === m)?.antall ?? 0,
              skattetrekk: l?.skattetrekk ?? 0,
              brutto: l?.brutto ?? 0,
              siste,
            };
          })
          .reverse();
        return { aar, maaneder, innsending: await innsending(db, orgId(c)) };
      }),
    );
  });

  // Grunnlaget for måneden (uten fødselsnumre), avvikene, meldingene som er laget, og fristen.
  r.get("/amelding/:maaned", async (c) => {
    const maaned = maanedS.parse(c.req.param("maaned"));
    return c.json(
      await bruk(c, async (db) => {
        await db.query("select faktura.krev($1, 'personal_les')", [orgId(c)]);
        const g = await hentGrunnlag(db, orgId(c), maaned);
        return {
          maaned,
          frist: frist(maaned),
          avvik: kontroller(g),
          grunnlag: oppsummer(g),
          meldinger: await alle(db, `${RAD} where org_id = $1 and maaned = $2::date order by opprettet desc`, [orgId(c), `${maaned}-01`]),
          innsending: await innsending(db, orgId(c)),
        };
      }),
    );
  });

  // Bestill fila eller innsendingen for måneden: workeren lager den. erstatt: den nye meldingen
  // erstatter den siste som er levert for måneden (standard).
  r.post("/amelding/:maaned", async (c) => {
    krevMfa(c);
    const maaned = maanedS.parse(c.req.param("maaned"));
    const b = z.object({ innsending: z.enum(["fil", "api"]), erstatt: z.boolean().optional() }).parse(await c.req.json().catch(() => ({})));
    const m = await bruk(c, async (db) => {
      await db.query("select faktura.krev($1, 'personal')", [orgId(c)]);
      if (b.innsending === "api") {
        const i = await innsending(db, orgId(c));
        if (!i.pa) throw new ApiFeil(409, "Innsending til Skatteetaten er ikke slått på ennå. Last ned fila og last den opp på skatteetaten.no.");
        if (!i.tilgang) throw new ApiFeil(409, "Gi tilgang til a-meldingen i Altinn først (Innstillinger → Ansatte og timer → Skatteetaten og Altinn).");
      }
      const feil = kontroller(await hentGrunnlag(db, orgId(c), maaned)).filter((a) => a.niva === "feil");
      if (feil.length) throw new ApiFeil(400, feil.map((f) => f.tekst).join(" "));
      return (await en<{ id: string }>(db, "select id from faktura.bestill_amelding($1, $2::date, $3, $4)", [orgId(c), `${maaned}-01`, b.innsending, b.erstatt ?? true]))!;
    });
    await leggIKo({ type: "amelding-lag", org_id: orgId(c), amelding_id: m.id });
    return c.json(await bruk(c, (db) => en(db, `${RAD} where org_id = $1 and id = $2`, [orgId(c), m.id])), 201);
  });

  // Lenken til fila (gyldig i fem minutter).
  r.get("/amelding/fil/:id", async (c) => {
    const id = uuid.parse(c.req.param("id"));
    const m = await bruk(c, async (db) => {
      await db.query("select faktura.krev($1, 'personal')", [orgId(c)]);
      return en<{ fil_sti: string | null; maaned: string; status: string }>(
        db,
        "select fil_sti, to_char(maaned, 'YYYY-MM') as maaned, status from faktura.ameldinger where org_id = $1 and id = $2 and innsending = 'fil'",
        [orgId(c), id],
      );
    });
    if (!m) throw new ApiFeil(404, "Fant ikke a-meldingsfila");
    if (!m.fil_sti || !config.filerBucket) throw new ApiFeil(409, m.status === "feil" ? "Fila ble ikke laget." : "Fila er ikke klar ennå.");
    const navn = `a-melding-${m.maaned}.xml`;
    return c.json({ url: await lagring.signertUrl(config.filerBucket, m.fil_sti, 5, navn, { disposisjon: `attachment; filename="${navn}"`, type: "application/xml" }) });
  });

  // Fila er lastet opp på skatteetaten.no (eller ikke).
  r.post("/amelding/fil/:id/levert", async (c) => {
    const id = uuid.parse(c.req.param("id"));
    const b = z.object({ levert: z.boolean() }).parse(await c.req.json().catch(() => ({})));
    await bruk(c, (db) => db.query("select faktura.amelding_levert($1, $2, $3)", [orgId(c), id, b.levert]));
    return c.json({ ok: true });
  });

  // Virksomhetene (underenhetene) i Enhetsregisteret, til valget i innstillingene.
  r.get("/amelding-virksomheter", async (c) => {
    const orgnr = await bruk(c, async (db) => {
      await db.query("select faktura.krev($1, 'personal_les')", [orgId(c)]);
      return (await en<{ orgnr: string | null }>(db, "select orgnr from faktura.organisasjoner where id = $1", [orgId(c)]))?.orgnr ?? null;
    });
    if (!orgnr) return c.json([]);
    return c.json(await hentUnderenheter(orgnr));
  });

  return r;
}

