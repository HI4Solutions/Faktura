// Timebank (0073_timebank.sql): timer den ansatte har jobbet utover det avtalte, som tas ut som
// fri (avspasering) senere i stedet for å lønnes nå. Overtid og ekstratimer føres «til
// timebanken» i timeføringen (server/src/ansatte.ts); eier og administrator justerer for hånd og
// betaler ut timer i neste lønnskjøring. Den ansatte søker om avspasering (hele dager eller noen
// timer én dag), og eier eller administrator godkjenner eller avslår; den andre parten får
// beskjed. Saldoen og reglene ligger i databasen.
//
// Hvem ser hva: den ansatte sin egen timebank; eier og administrator alle, med historikken og
// søknadene; regnskap saldoene (som er en forpliktelse i regnskapet).
import { Hono, type Context } from "hono";
import { z } from "zod";
import { alle, en, somBruker, type Db } from "./db.js";
import { ApiFeil } from "./feil.js";
import { datoS, tekst, valgfri, varslePersonal } from "./ansatte.js";
import { leggIKo } from "./tjenester.js";
import { periode } from "./fravaer.js";

const uuid = z.string().uuid();
const orgId = (c: Context) => uuid.parse(c.req.param("org"));
const id = (c: Context) => uuid.parse(c.req.param("id"));
const bruk = <T>(c: Context, fn: (db: Db) => Promise<T>) => somBruker<T>(c.get("bruker").id, fn);

// «7,5 t»
export const timerTekst = (t: number) => `${Number(t).toLocaleString("nb-NO", { maximumFractionDigits: 2 })} t`;

// Saldoen per ansatt (faktura.timebank): inn (godkjente timer i banken), venter_inn (levert),
// avspasert, utbetalt, justert, saldo, sokt (søknader som venter), dag_timer (en vanlig
// arbeidsdag) og sats (timelønnen eller timesatsen, for verdien av saldoen).
export type Saldo = {
  ansatt_id: string;
  navn: string;
  aktiv: boolean;
  lonnstype: "maaned" | "time";
  sats: number | null;
  inn: number;
  venter_inn: number;
  avspasert: number;
  utbetalt: number;
  justert: number;
  saldo: number;
  sokt: number;
  dag_timer: number | null;
};
export const SALDO = `
  select ansatt_id, navn, aktiv, lonnstype, sats::float8 as sats, inn::float8 as inn, venter_inn::float8 as venter_inn,
         avspasert::float8 as avspasert, utbetalt::float8 as utbetalt, justert::float8 as justert, saldo::float8 as saldo,
         sokt::float8 as sokt, dag_timer::float8 as dag_timer
    from faktura.timebank($1)`;

export type Soknad = {
  id: string;
  ansatt_id: string;
  ansatt_navn: string;
  fra: string;
  til: string;
  timer: number;
  hele_dager: boolean;
  melding: string | null;
  status: "venter" | "godkjent" | "avslatt" | "trukket";
  svar: string | null;
  opprettet: string;
  behandlet_at: string | null;
  behandlet_av_navn: string | null;
  fjernet: boolean; // godkjent, men fraværet eller posten er slettet etterpå
};
const SOKNAD = `
  select s.id, s.ansatt_id, a.fornavn || ' ' || a.etternavn as ansatt_navn, to_char(s.fra, 'YYYY-MM-DD') as fra, to_char(s.til, 'YYYY-MM-DD') as til,
         s.timer::float8 as timer, s.hele_dager, s.melding, s.status, s.svar, s.opprettet, s.behandlet_at,
         coalesce(b.navn, b.epost) as behandlet_av_navn, s.status = 'godkjent' and s.fravaer_id is null and s.post_id is null as fjernet
    from faktura.avspasering_soknader s
    join faktura.ansatte a on a.org_id = s.org_id and a.id = s.ansatt_id
    left join faktura.brukere b on b.id = s.behandlet_av`;

// Historikken for én ansatt, nyeste først: timer inn (levert og godkjent), avspasering (fravær i
// hele dager og timer), utbetaling og justering. timer: pluss inn, minus ut.
type Hendelse = {
  kilde: "timer" | "fravaer" | "post";
  id: string;
  dato: string;
  til: string | null;
  type: "overtid" | "ekstratimer" | "avspasering" | "utbetaling" | "justering";
  timer: number;
  tekst: string | null;
  status: string | null;
  overtid_prosent: number | null;
  lonnet: boolean;
};
const HISTORIKK = `
  select 'timer' as kilde, t.id, to_char(t.dato, 'YYYY-MM-DD') as dato, null as til,
         case when t.overtid_prosent is not null then 'overtid' else 'ekstratimer' end as type,
         t.timer::float8 as timer, t.beskrivelse as tekst, t.status, t.overtid_prosent, t.lonnskjoring_id is not null as lonnet
    from faktura.timeforinger t
   where t.org_id = $1 and t.ansatt_id = $2 and t.timebank and t.status in ('levert', 'godkjent')
  union all
  select 'fravaer', f.id, to_char(f.fra, 'YYYY-MM-DD'), to_char(f.til, 'YYYY-MM-DD'), 'avspasering', -f.timer::float8, f.notat, null, null, false
    from faktura.fravaer f
   where f.org_id = $1 and f.ansatt_id = $2 and f.type = 'avspasering'
  union all
  select 'post', p.id, to_char(p.dato, 'YYYY-MM-DD'), null, p.type, p.timer::float8, p.tekst, null, null, p.lonnskjoring_id is not null
    from faktura.timebank_poster p
   where p.org_id = $1 and p.ansatt_id = $2
   order by 3 desc, 1`;

const postSkjema = z.object({
  ansatt_id: uuid,
  type: z.enum(["justering", "avspasering", "utbetaling"], { error: "Velg hva som skal gjøres" }),
  dato: datoS.optional(), // standard: i dag
  // Justering: pluss eller minus. Avspasering og utbetaling: timene som tas ut.
  timer: z
    .number({ error: "Skriv antall timer" })
    .min(-2000, "For mange timer")
    .max(2000, "For mange timer")
    .refine((t) => t !== 0, "Skriv antall timer"),
  tekst: valgfri(tekst(300, "Teksten")),
});

const soknadSkjema = z.object({
  fra: datoS,
  til: datoS.optional(), // standard: samme dag
  timer: z.number({ error: "Skriv hvor mange timer" }).gt(0, "Skriv hvor mange timer").max(2000, "For mange timer"),
  hele_dager: z.boolean().optional(), // standard: hele dager (fri); ellers noen timer én dag
  melding: valgfri(tekst(300, "Meldingen")),
});

const melding = (m: string | null | undefined) => (m ? ` «${m}»` : "");

// Innloggingen til den ansatte (eller null), for varslene.
const bruker = async (db: Db, org: string, ansatt: string) =>
  (await en<{ bruker_id: string | null }>(db, "select bruker_id from faktura.ansatte where org_id = $1 and id = $2", [org, ansatt]))?.bruker_id ?? null;

async function varsleAnsatt(org: string, mottaker: string | null, unntatt: string, hendelse: "timer" | "fravaer", tittel: string, tekst: string, tag: string) {
  if (!mottaker || mottaker === unntatt) return;
  await leggIKo({ type: "varsel", varsel: { hendelse, org_id: org, bruker_ider: [mottaker], tittel, tekst, url: "/timer?fane=timebank", tag } });
}

export function timebankRuter() {
  const r = new Hono();

  // Timebanken: om den er på, saldoene (alle for eier, administrator og regnskap; ellers bare en
  // selv), og søknadene som venter eller er behandlet de siste 30 dagene.
  r.get("/timebank", async (c) =>
    c.json(
      await bruk(c, async (db) => ({
        paa: (await en<{ paa: boolean }>(db, "select faktura.timebank_paa($1) as paa", [orgId(c)]))!.paa,
        ansatte: await alle<Saldo>(db, SALDO, [orgId(c)]),
        soknader: await alle<Soknad>(
          db,
          `${SOKNAD} where s.org_id = $1 and (s.status = 'venter' or coalesce(s.behandlet_at, s.opprettet) > now() - interval '30 days')
            order by s.status <> 'venter', s.fra, s.opprettet`,
          [orgId(c)],
        ),
      })),
    ),
  );

  // Forslag til timene en avspasering tar: de planlagte timene (vakter og faste dager), ellers en
  // vanlig arbeidsdag for hver arbeidsdag. Standard: den innloggede selv.
  r.get("/timebank/forslag", async (c) => {
    const q = z.object({ ansatt: uuid.optional(), fra: datoS, til: datoS.optional() }).parse(c.req.query());
    return c.json(
      await bruk(c, async (db) => {
        const ansatt = q.ansatt ?? (await en<{ id: string | null }>(db, "select faktura.min_ansatt($1) as id", [orgId(c)]))!.id;
        if (!ansatt) throw new ApiFeil(400, "Du er ikke registrert som ansatt her");
        const t = await en<{ timer: number }>(db, "select faktura.avspasering_forslag($1, $2, $3, $4)::float8 as timer", [orgId(c), ansatt, q.fra, q.til ?? q.fra]);
        return { timer: t!.timer };
      }),
    );
  });

  // Justering, avspasering i timer eller utbetaling (eier og administrator). Den ansatte får beskjed.
  r.post("/timebank/poster", async (c) => {
    const b = postSkjema.parse(await c.req.json().catch(() => ({})));
    const meg = c.get("bruker").id;
    const svar = await bruk(c, async (db) => {
      await db.query("select faktura.krev($1, 'personal')", [orgId(c)]);
      const ny = await en<{ id: string; dato: string; timer: number; tekst: string | null }>(
        db,
        `insert into faktura.timebank_poster (org_id, ansatt_id, dato, type, timer, tekst) values ($1, $2, coalesce($3::date, faktura.i_dag()), $4, $5, $6)
         returning id, to_char(dato, 'YYYY-MM-DD') as dato, timer::float8 as timer, tekst`,
        [orgId(c), b.ansatt_id, b.dato ?? null, b.type, b.timer, b.tekst ?? null],
      );
      const saldo = await en<Saldo>(db, `${SALDO} where ansatt_id = $2`, [orgId(c), b.ansatt_id]);
      return { post: { ...ny!, type: b.type }, saldo, mottaker: await bruker(db, orgId(c), b.ansatt_id) };
    });
    const { post } = svar;
    const t = Math.abs(post.timer);
    const etter = svar.saldo ? ` Saldo: ${timerTekst(svar.saldo.saldo)}.` : "";
    const [tittel, tekstV] =
      post.type === "justering"
        ? [`Timebanken din: ${post.timer > 0 ? "+" : "−"}${timerTekst(t)}`, `${post.tekst ?? ""}${/[.!?]$/.test(post.tekst ?? "") ? "" : "."}${etter}`]
        : post.type === "avspasering"
          ? ["Avspasering registrert", `${periode(post.dato, post.dato)}: ${timerTekst(t)} fra timebanken.${melding(post.tekst)}${etter}`]
          : ["Timer fra timebanken utbetales", `${timerTekst(t)} utbetales med neste lønn.${melding(post.tekst)}${etter}`];
    await varsleAnsatt(orgId(c), svar.mottaker, meg, "timer", tittel, tekstV, `timebank-${post.id}`);
    return c.json({ ...post, saldo: svar.saldo }, 201);
  });

  r.delete("/timebank/poster/:id", async (c) => {
    await bruk(c, async (db) => {
      await db.query("select faktura.krev($1, 'personal')", [orgId(c)]);
      const res = await db.query("delete from faktura.timebank_poster where org_id = $1 and id = $2", [orgId(c), id(c)]);
      if (!res.rowCount) throw new ApiFeil(404, "Fant ikke posten");
    });
    return c.body(null, 204);
  });

  // Søknad om avspasering (den ansatte for seg selv). Eier og administrator får beskjed.
  r.post("/timebank/soknader", async (c) => {
    const b = soknadSkjema.parse(await c.req.json().catch(() => ({})));
    const s = await bruk(c, async (db) => {
      const ny = await en<{ id: string }>(db, "select (faktura.sok_avspasering($1, $2, $3, $4, $5, $6)).id as id", [
        orgId(c),
        b.fra,
        b.til ?? b.fra,
        b.timer,
        b.hele_dager ?? true,
        b.melding ?? null,
      ]);
      return (await en<Soknad>(db, `${SOKNAD} where s.id = $1`, [ny!.id]))!;
    });
    await varslePersonal(
      orgId(c),
      c.get("bruker").id,
      "fravaer",
      `${s.ansatt_navn} søker om avspasering`,
      `${periode(s.fra, s.til)} (${timerTekst(s.timer)}${s.hele_dager ? "" : ", noen timer"}).${melding(s.melding)}`,
      "/timer?fane=timebank",
      `avspasering-${s.id}`,
    );
    return c.json(s, 201);
  });

  // Godkjenn (med timene, som kan endres) eller avslå, med et svar. Den ansatte får beskjed.
  for (const handling of ["godkjenn", "avslaa"] as const) {
    r.post(`/timebank/soknader/:id/${handling}`, async (c) => {
      const b = z
        .object({ timer: z.number().gt(0, "Skriv antall timer").max(2000, "For mange timer").optional(), svar: valgfri(tekst(300, "Svaret")) })
        .parse(await c.req.json().catch(() => ({})));
      const svar = await bruk(c, async (db) => {
        await db.query("select faktura.behandle_avspasering($1, $2, $3, $4, $5)", [orgId(c), id(c), handling === "godkjenn", b.svar ?? null, b.timer ?? null]);
        const s = (await en<Soknad>(db, `${SOKNAD} where s.id = $1`, [id(c)]))!;
        return { s, mottaker: await bruker(db, orgId(c), s.ansatt_id) };
      });
      const { s } = svar;
      await varsleAnsatt(
        orgId(c),
        svar.mottaker,
        c.get("bruker").id,
        "fravaer",
        s.status === "godkjent" ? "Avspasering godkjent" : "Avspasering ikke godkjent",
        `${periode(s.fra, s.til)} (${timerTekst(s.timer)}).${melding(s.svar)}`,
        `avspasering-${s.id}`,
      );
      return c.json(s);
    });
  }

  // Trekk en søknad som venter (den ansatte selv, eller eier og administrator).
  r.post("/timebank/soknader/:id/trekk", async (c) =>
    c.json(
      await bruk(c, async (db) => {
        await db.query("select faktura.trekk_avspasering($1, $2)", [orgId(c), id(c)]);
        return (await en<Soknad>(db, `${SOKNAD} where s.id = $1`, [id(c)]))!;
      }),
    ),
  );

  // Én ansatt: saldoen, historikken og søknadene (eier og administrator, og den ansatte selv).
  r.get("/timebank/:ansatt", async (c) => {
    const ansatt = uuid.parse(c.req.param("ansatt"));
    return c.json(
      await bruk(c, async (db) => {
        const tilgang = await en<{ ok: boolean }>(db, "select faktura.kan($1, 'personal') or faktura.er_meg($1, $2) as ok", [orgId(c), ansatt]);
        const saldo = tilgang?.ok ? await en<Saldo>(db, `${SALDO} where ansatt_id = $2`, [orgId(c), ansatt]) : null;
        if (!saldo) throw new ApiFeil(404, "Fant ikke timebanken");
        return {
          saldo,
          historikk: await alle<Hendelse>(db, HISTORIKK, [orgId(c), ansatt]),
          soknader: await alle<Soknad>(db, `${SOKNAD} where s.org_id = $1 and s.ansatt_id = $2 order by s.opprettet desc limit 50`, [orgId(c), ansatt]),
        };
      }),
    );
  });

  return r;
}
