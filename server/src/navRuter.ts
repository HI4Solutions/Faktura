// Sykepenger og NAV i appen (0079_nav_sykepenger.sql, navSykepenger.ts, docs/nav.md): om hentingen
// er slått på og tilgangen gitt, sykmeldingene (eier og administrator ser alle, den ansatte sine
// egne), «Hent nå», og NAVs forespørsler om inntektsmelding med inntektsmeldingen appen foreslår
// og sender.
import { Hono, type Context } from "hono";
import { z } from "zod";
import { alle, en, somBruker, type Db } from "./db.js";
import { ApiFeil } from "./feil.js";
import { config } from "./config.js";
import { NAV_SYKEPENGER, PAKKENAVN } from "./altinn.js";
import { leggIKo } from "./tjenester.js";
import { BEGRUNNELSER, ENDRINGSAARSAKER, NATURALYTELSER, forslagTilInntektsmelding, inntektsmeldingSkjema, kontrollerMotForespoersel } from "./navInntektsmelding.js";

const uuid = z.string().uuid();
const datoS = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Ugyldig dato");
const orgId = (c: Context) => uuid.parse(c.req.param("org"));
const bruk = <T>(c: Context, fn: (db: Db) => Promise<T>) => somBruker<T>(c.get("bruker").id, fn);

async function status(db: Db, org: string) {
  const t = await en<{ status: string; pakker: string[] }>(db, "select status, pakker from faktura.skattekort_tilgang where org_id = $1", [org]);
  const o = await en<{ virksomhet_orgnr: string | null; sykepenger_refusjon: boolean }>(
    db,
    "select virksomhet_orgnr, sykepenger_refusjon from faktura.lonn_oppsett where org_id = $1",
    [org],
  );
  return {
    pa: config.navSykepenger,
    refusjon: o?.sykepenger_refusjon ?? true,
    tilgang: Boolean(t && t.status === "godkjent" && t.pakker.includes(NAV_SYKEPENGER)),
    pakke: PAKKENAVN[NAV_SYKEPENGER],
    virksomhet: o?.virksomhet_orgnr ?? null,
    miljo: config.skatteetatenMiljo,
    henting: await alle(
      db,
      "select type, virksomhet_orgnr, sist_hentet, siste_feil, siste_loepenr::float8 as siste_loepenr from faktura.nav_henting where org_id = $1 order by type, virksomhet_orgnr",
      [org],
    ),
  };
}

const SYKMELDING = `
  select s.id, s.ansatt_id, coalesce(a.fornavn || ' ' || a.etternavn, s.navn) as navn, s.sykefravaer_fom, s.mottatt_av_nav, s.sendt_til_arbeidsgiver,
         s.perioder, s.egenmeldingsdager, s.melding_til_arbeidsgiver, s.tiltak_arbeidsplassen, s.behandler, s.merknader, cardinality(s.fravaer) as fravaer, s.hentet,
         s.virksomhet_orgnr
    from faktura.nav_sykmeldinger s left join faktura.ansatte a on a.org_id = s.org_id and a.id = s.ansatt_id`;

export function navRuter() {
  const r = new Hono();

  r.get("/nav", async (c) =>
    c.json(
      await bruk(c, async (db) => {
        await db.query("select faktura.krev($1, 'personal')", [orgId(c)]);
        return status(db, orgId(c));
      }),
    ),
  );

  // Sykmeldingene (nyeste først), for perioden og en ansatt. Den ansatte ser bare sine egne.
  r.get("/nav/sykmeldinger", async (c) => {
    const q = z.object({ fra: datoS.optional(), til: datoS.optional(), ansatt: uuid.optional() }).parse(c.req.query());
    return c.json(
      await bruk(c, (db) =>
        alle(
          db,
          `${SYKMELDING}
            where s.org_id = $1 and ($2::uuid is null or s.ansatt_id = $2)
              and ($3::date is null or exists (select 1 from jsonb_array_elements(s.perioder) p where (p->>'tom')::date >= $3))
              and ($4::date is null or exists (select 1 from jsonb_array_elements(s.perioder) p where (p->>'fom')::date <= $4))
            order by s.sykefravaer_fom desc nulls last, s.hentet desc
            limit 500`,
          [orgId(c), q.ansatt ?? null, q.fra ?? null, q.til ?? null],
        ),
      ),
    );
  });

  // Hent fra NAV nå (workeren gjør det).
  r.post("/nav/hent", async (c) => {
    const s = await bruk(c, async (db) => {
      await db.query("select faktura.krev($1, 'personal')", [orgId(c)]);
      return status(db, orgId(c));
    });
    if (!s.pa) throw new ApiFeil(409, "Hentingen fra NAV er ikke slått på ennå.");
    if (!s.tilgang) throw new ApiFeil(409, `Gi tilgang hos NAV i Altinn først (tilgangspakken «${s.pakke}», Innstillinger → Ansatte og timer).`);
    if (!s.virksomhet) throw new ApiFeil(409, "Legg inn virksomheten (underenheten) under Innstillinger → Ansatte og timer → A-melding først.");
    await leggIKo({ type: "nav-hent", org_id: orgId(c) });
    return c.json({ ok: true });
  });

  // NAVs forespørsler om inntektsmelding (nyeste først), med den siste inntektsmeldingen.
  r.get("/nav/forespoersler", async (c) =>
    c.json(
      await bruk(c, async (db) => {
        await db.query("select faktura.krev($1, 'personal')", [orgId(c)]);
        return alle(
          db,
          `select f.id, f.nav_referanse_id, f.ansatt_id, coalesce(a.fornavn || ' ' || a.etternavn, f.navn) as navn, f.status, f.data, f.opprettet, f.oppdatert,
                  (select json_build_object('id', m.id, 'status', m.status, 'feil', m.feil, 'sendt_at', m.sendt_at, 'opprettet', m.opprettet)
                     from faktura.nav_inntektsmeldinger m where m.forespoersel_id = f.id order by m.opprettet desc limit 1) as inntektsmelding
             from faktura.nav_forespoersler f left join faktura.ansatte a on a.org_id = f.org_id and a.id = f.ansatt_id
            where f.org_id = $1 order by f.opprettet desc limit 300`,
          [orgId(c)],
        );
      }),
    ),
  );

  // En forespørsel: det NAV ber om, inntektsmeldingen appen foreslår (fra lønnen og fraværet), og
  // inntektsmeldingene som er sendt.
  r.get("/nav/forespoersler/:id", async (c) => {
    const id = uuid.parse(c.req.param("id"));
    return c.json(
      await bruk(c, async (db) => {
        await db.query("select faktura.krev($1, 'personal')", [orgId(c)]);
        const f = await en<any>(
          db,
          `select f.id, f.nav_referanse_id, f.ansatt_id, coalesce(a.fornavn || ' ' || a.etternavn, f.navn) as navn, f.status, f.data, f.opprettet
             from faktura.nav_forespoersler f left join faktura.ansatte a on a.org_id = f.org_id and a.id = f.ansatt_id
            where f.org_id = $1 and f.id = $2`,
          [orgId(c), id],
        );
        if (!f) throw new ApiFeil(404, "Fant ikke forespørselen");
        return {
          ...f,
          forslag: f.ansatt_id && f.status !== "FORKASTET" ? await forslagTilInntektsmelding(db, orgId(c), f) : null,
          koder: { begrunnelser: BEGRUNNELSER, naturalytelser: NATURALYTELSER, endringsaarsaker: ENDRINGSAARSAKER },
          inntektsmeldinger: await alle(
            db,
            "select id, status, innhold, innsending_id, feil, opprettet, sendt_at from faktura.nav_inntektsmeldinger where org_id = $1 and forespoersel_id = $2 order by opprettet desc",
            [orgId(c), id],
          ),
        };
      }),
    );
  });

  // Send inntektsmeldingen (workeren sender den til NAV).
  r.post("/nav/forespoersler/:id/inntektsmelding", async (c) => {
    const id = uuid.parse(c.req.param("id"));
    const innhold = inntektsmeldingSkjema.parse(await c.req.json().catch(() => ({})));
    const s = await bruk(c, async (db) => {
      await db.query("select faktura.krev($1, 'personal')", [orgId(c)]);
      const f = await en<{ data: any }>(db, "select data from faktura.nav_forespoersler where org_id = $1 and id = $2", [orgId(c), id]);
      if (!f) throw new ApiFeil(404, "Fant ikke forespørselen");
      const feil = kontrollerMotForespoersel(innhold, f.data ?? {});
      if (feil.length) throw new ApiFeil(400, feil.join(" "));
      return status(db, orgId(c));
    });
    if (!s.pa || !s.tilgang) throw new ApiFeil(409, `Gi tilgang hos NAV i Altinn først (tilgangspakken «${s.pakke}»).`);
    const m = await bruk(c, (db) => en<{ id: string }>(db, "select id from faktura.bestill_inntektsmelding($1, $2)", [id, JSON.stringify(innhold)]));
    await leggIKo({ type: "nav-inntektsmelding", org_id: orgId(c), inntektsmelding_id: m!.id });
    return c.json(await bruk(c, (db) => en(db, "select id, status, innhold, opprettet from faktura.nav_inntektsmeldinger where id = $1", [m!.id])), 201);
  });

  return r;
}
