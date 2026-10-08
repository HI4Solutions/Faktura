// Vaktplan (0036_vaktplan.sql): eier og administrator planlegger vakter og publiserer dem;
// den ansatte ser sine egne publiserte vakter og de ledige, og kan ta en ledig vakt. Varsler
// går ut når vakter publiseres, endres, fjernes eller tas. Advarslene etter
// arbeidsmiljøloven (hviletid, overtid) regnes i vaktregler.ts og vises bare for dem som ser
// hele planen. Er den ansatte borte (fravær, 0037), er vakten merket med fraværet, teller ikke
// i advarslene, og en vikar kan settes inn på en egen vakt som tar over plassene på tavla.
import { Hono, type Context } from "hono";
import { z } from "zod";
import { alle, en, somBruker, type Db } from "./db.js";
import { ApiFeil } from "./feil.js";
import { uke } from "./arbeidstid.js";
import { advarsler, type Ansettelse } from "./vaktregler.js";
import { datoS, klokke, regler, tekst, valgfri, varslePersonal } from "./ansatte.js";
import { beregnBemanning, dagTimer, hentPlaner, planFor, ukedag } from "./arbeidsplan.js";
import { leggIKo } from "./tjenester.js";
import { helligdag } from "./helligdager.js";
import { fasteFaser } from "./tavle.js";

const uuid = z.string().uuid();
const orgId = (c: Context) => uuid.parse(c.req.param("org"));
const id = (c: Context) => uuid.parse(c.req.param("id"));
const bruk = <T>(c: Context, fn: (db: Db) => Promise<T>) => somBruker<T>(c.get("bruker").id, fn);

const leggTilDager = (iso: string, n: number) => new Date(Date.parse(`${iso}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const dagerMellom = (a: string, b: string) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86_400_000);
const dagFormat = new Intl.DateTimeFormat("nb-NO", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
const dag = (iso: string) => dagFormat.format(new Date(`${iso}T12:00:00Z`));
const timer = (n: number) => `${n.toLocaleString("nb-NO", { maximumFractionDigits: 2 })} t`;

const vaktSkjema = z.object({
  ansatt_id: uuid.nullable().optional(), // null: ledig vakt
  dato: datoS,
  fra: klokke,
  til: klokke,
  pause_min: z.number().int().min(0, "Pausen kan ikke være negativ").max(600, "Pausen kan være høyst 10 timer").optional(),
  oppgave: valgfri(tekst(60, "Oppgaven")),
  notat: valgfri(tekst(500, "Notatet")),
});

// vikar_for_navn: den som er borte (bare for dem som ser hele planen); har_vikar: en annen
// vakt dekker denne; fravaer: den ansatte er borte den dagen (typen).
const VAKT = `
  select v.id, v.ansatt_id, a.fornavn || ' ' || a.etternavn as ansatt_navn, v.dato,
         to_char(v.fra, 'HH24:MI') as fra, to_char(v.til, 'HH24:MI') as til, v.pause_min, v.timer,
         v.oppgave, v.notat, v.publisert_at is not null as publisert, v.oppdatert, v.vikar_for,
         (select o.fornavn || ' ' || o.etternavn from faktura.vakter ov join faktura.ansatte o on o.org_id = ov.org_id and o.id = ov.ansatt_id
           where ov.org_id = v.org_id and ov.id = v.vikar_for) as vikar_for_navn,
         exists (select 1 from faktura.vakter x where x.org_id = v.org_id and x.vikar_for = v.id) as har_vikar,
         (select faktura.fravaer_type(f.org_id, f.ansatt_id, f.type) from faktura.fravaer f where f.org_id = v.org_id and f.ansatt_id = v.ansatt_id and v.dato between f.fra and f.til limit 1) as fravaer,
         exists (select 1 from faktura.timeforinger t where t.org_id = v.org_id and t.vakt_id = v.id) as fort
    from faktura.vakter v
    left join faktura.ansatte a on a.org_id = v.org_id and a.id = v.ansatt_id`;

type Vakt = {
  id: string;
  ansatt_id: string | null;
  ansatt_navn: string | null;
  dato: string;
  fra: string;
  til: string;
  pause_min: number;
  timer: number;
  oppgave: string | null;
  notat: string | null;
  publisert: boolean;
  vikar_for: string | null;
  fravaer: string | null;
};

type Varsel = { bruker_id: string; tittel: string; tekst: string; url: string; tag: string };
const tid = (v: Pick<Vakt, "dato" | "fra" | "til">) => `${dag(v.dato)} ${v.fra}–${v.til}`;
const ukeUrl = (dato: string) => `/vakter?uke=${uke(dato).fra}`;

async function sendVarsler(org: string, varsler: Varsel[]) {
  for (const v of varsler)
    await leggIKo({ type: "varsel", varsel: { hendelse: "vakter", org_id: org, bruker_ider: [v.bruker_id], tittel: v.tittel, tekst: v.tekst, url: v.url, tag: v.tag } });
}

// Innloggingen til de ansatte (for varsler), og alle aktive ansatte med innlogging (ledige vakter).
const brukere = async (db: Db, org: string, ansatte: (string | null)[]) =>
  new Map(
    (
      await alle<{ id: string; bruker_id: string }>(db, "select id, bruker_id from faktura.ansatte where org_id = $1 and id = any($2::uuid[]) and bruker_id is not null", [
        org,
        ansatte.filter(Boolean),
      ])
    ).map((a) => [a.id, a.bruker_id] as const),
  );
const aktiveMedInnlogging = (db: Db, org: string) =>
  alle<{ id: string; bruker_id: string }>(
    db,
    `select a.id, a.bruker_id from faktura.ansatte a
       join faktura.medlemmer m on m.org_id = a.org_id and m.bruker_id = a.bruker_id
      where a.org_id = $1 and a.aktiv`,
    [org],
  );

export function vaktRuter() {
  const r = new Hono();

  // Vaktene i perioden. Den som ser hele planen, får også advarslene og summen per ansatt og uke.
  r.get("/vakter", async (c) => {
    const q = z.object({ fra: datoS, til: datoS, ansatt: uuid.optional() }).parse(c.req.query());
    if (q.til < q.fra) throw new ApiFeil(400, "Slutten er før starten");
    if (dagerMellom(q.fra, q.til) > 93) throw new ApiFeil(400, "Velg en periode på høyst tre måneder");
    return c.json(
      await bruk(c, async (db) => {
        const helPlan = (await en<{ k: boolean }>(db, "select faktura.kan($1, 'personal_les') as k", [orgId(c)]))!.k;
        const regel = await regler(db, orgId(c));
        // Hele uker og en dag på hver side, så hviletiden og ukene regnes riktig i kantene.
        const fra = leggTilDager(uke(q.fra).fra, -1);
        const til = leggTilDager(uke(q.til).til, 1);
        const vakter = await alle<Vakt>(
          db,
          `${VAKT} where v.org_id = $1 and v.dato between $2 and $3 and ($4::uuid is null or v.ansatt_id = $4)
            order by v.dato, v.fra, a.etternavn nulls first, a.fornavn`,
          [orgId(c), fra, til, q.ansatt ?? null],
        );
        const iPerioden = vakter.filter((v) => v.dato >= q.fra && v.dato <= q.til);
        // Faste dager fra arbeidsplanene (dager i planen uten vakt) og ekstratimene.
        const bemanning = await beregnBemanning(db, orgId(c), fra, til, q.ansatt ?? null);
        const faste = bemanning.faste.filter((f) => f.dato >= q.fra && f.dato <= q.til);
        // Fraværet i perioden (den ansatte ser bare sitt eget).
        const fravaer = await alle(
          db,
          `select f.id, f.ansatt_id, a.fornavn || ' ' || a.etternavn as ansatt_navn, faktura.fravaer_type(f.org_id, f.ansatt_id, f.type) as type, f.fra, f.til,
                  case when faktura.ser_fravaertype(f.org_id, f.ansatt_id) then f.notat end as notat
             from faktura.fravaer f join faktura.ansatte a on a.org_id = f.org_id and a.id = f.ansatt_id
            where f.org_id = $1 and f.til >= $2 and f.fra <= $3 and ($4::uuid is null or f.ansatt_id = $4)
            order by f.fra`,
          [orgId(c), q.fra, q.til, q.ansatt ?? null],
        );
        if (!helPlan) return { regler: regel, vakter: iPerioden.map((v) => ({ ...v, advarsler: [] })), uker: [], upubliserte: 0, fravaer, faste, ekstra: [] };

        const ansatte = await alle<Ansettelse & { id: string; avtalt: number }>(
          db,
          "select id, ansatt_fra, ansatt_til, aktiv, arbeidstaker, ukentlig_arbeidstid * stillingsprosent / 100 as avtalt from faktura.ansatte where org_id = $1",
          [orgId(c)],
        );
        // Vakter den ansatte ikke går (borte), teller ikke i hviletid og overtid.
        const a = advarsler(
          vakter.filter((v) => !v.fravaer),
          regel,
          new Map(ansatte.map((x) => [x.id, x])),
        );
        // Sum per ansatt og uke for ukene i perioden: vaktene og de faste dagene, uten dagene den
        // ansatte er borte.
        const uker = new Map<string, { ansatt_id: string; fra: string; planlagt: number; avtalt: number | null; advarsler: string[] }>();
        for (const v of [...vakter, ...bemanning.faste]) {
          const m = uke(v.dato).fra;
          if (!v.ansatt_id || v.fravaer || m > q.til || uke(v.dato).til < q.fra) continue;
          const k = `${v.ansatt_id}:${m}`;
          const u = uker.get(k) ?? {
            ansatt_id: v.ansatt_id,
            fra: m,
            planlagt: 0,
            avtalt: ansatte.find((x) => x.id === v.ansatt_id)?.avtalt ?? null,
            advarsler: a.perUke.get(k) ?? [],
          };
          u.planlagt = Math.round((u.planlagt + Number(v.timer)) * 100) / 100;
          uker.set(k, u);
        }
        return {
          regler: regel,
          vakter: iPerioden.map((v) => ({ ...v, advarsler: a.perVakt.get(v.id) ?? [] })),
          uker: [...uker.values()],
          upubliserte: iPerioden.filter((v) => !v.publisert).length,
          fravaer,
          faste,
          // plan: ekstratimene er regnet mot den faste planen den dagen (ellers mot avtalt
          // arbeidstid i uka).
          ekstra: [...bemanning.ekstra.entries()]
            .map(([k, timer]) => {
              const [ansatt_id, dato] = k.split("|") as [string, string];
              return { ansatt_id, dato, timer, plan: !!planFor(bemanning.planer.get(ansatt_id), dato) };
            })
            .filter((e) => e.dato >= q.fra && e.dato <= q.til),
        };
      }),
    );
  });

  // Ny vakt (et utkast til den publiseres).
  r.post("/vakter", async (c) => {
    const b = vaktSkjema.parse(await c.req.json().catch(() => ({})));
    const v = await bruk(c, async (db) => {
      await db.query("select faktura.krev($1, 'personal')", [orgId(c)]);
      const ny = await en<{ id: string }>(
        db,
        `insert into faktura.vakter (org_id, ansatt_id, dato, fra, til, pause_min, oppgave, notat)
         values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
        [orgId(c), b.ansatt_id ?? null, b.dato, b.fra, b.til, b.pause_min ?? 0, b.oppgave ?? null, b.notat ?? null],
      );
      return en(db, `${VAKT} where v.id = $1`, [ny!.id]);
    });
    return c.json(v, 201);
  });

  // Endre en vakt. Er den publisert, får de ansatte det gjelder, beskjed.
  r.patch("/vakter/:id", async (c) => {
    const b = vaktSkjema.partial().parse(await c.req.json().catch(() => ({})));
    const felt = Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined));
    const navn = Object.keys(felt);
    if (!navn.length) throw new ApiFeil(400, "Ingen felt å endre");
    const { etter, varsler } = await bruk(c, async (db) => {
      await db.query("select faktura.krev($1, 'personal')", [orgId(c)]);
      const for_ = await en<Vakt>(db, `${VAKT} where v.org_id = $1 and v.id = $2`, [orgId(c), id(c)]);
      if (!for_) throw new ApiFeil(404, "Fant ikke vakten");
      await db.query(`update faktura.vakter set ${navn.map((k, i) => `${k} = $${i + 3}`).join(", ")} where org_id = $1 and id = $2`, [
        orgId(c),
        id(c),
        ...navn.map((k) => felt[k]),
      ]);
      const etter = (await en<Vakt>(db, `${VAKT} where v.id = $1`, [id(c)]))!;
      const varsler: Varsel[] = [];
      if (for_.publisert) {
        const innlogging = await brukere(db, orgId(c), [for_.ansatt_id, etter.ansatt_id]);
        const tag = `vakt-${etter.id}`;
        if (for_.ansatt_id !== etter.ansatt_id) {
          const gammel = for_.ansatt_id && innlogging.get(for_.ansatt_id);
          if (gammel) varsler.push({ bruker_id: gammel, tittel: "Vakt fjernet", tekst: `Vakten din ${tid(for_)} er tatt bort fra planen.`, url: ukeUrl(for_.dato), tag });
          const ny = etter.ansatt_id && innlogging.get(etter.ansatt_id);
          if (ny) varsler.push({ bruker_id: ny, tittel: "Ny vakt", tekst: `${tid(etter)}${etter.oppgave ? ` (${etter.oppgave})` : ""}.`, url: ukeUrl(etter.dato), tag });
          if (!etter.ansatt_id)
            for (const m of await aktiveMedInnlogging(db, orgId(c)))
              if (m.id !== for_.ansatt_id)
                varsler.push({ bruker_id: m.bruker_id, tittel: "Ledig vakt", tekst: `${tid(etter)}. Trykk for å ta den.`, url: "/vakter?fane=ledige", tag });
        } else if (etter.ansatt_id && (for_.dato !== etter.dato || for_.fra !== etter.fra || for_.til !== etter.til)) {
          const bruker = innlogging.get(etter.ansatt_id);
          if (bruker)
            varsler.push({ bruker_id: bruker, tittel: "Vakten din er endret", tekst: `${tid(etter)} (var ${tid(for_)}).`, url: ukeUrl(etter.dato), tag });
        }
      }
      return { etter, varsler };
    });
    await sendVarsler(orgId(c), varsler);
    return c.json(etter);
  });

  r.delete("/vakter/:id", async (c) => {
    const varsler = await bruk(c, async (db) => {
      await db.query("select faktura.krev($1, 'personal')", [orgId(c)]);
      const v = await en<Vakt>(db, `${VAKT} where v.org_id = $1 and v.id = $2`, [orgId(c), id(c)]);
      if (!v) throw new ApiFeil(404, "Fant ikke vakten");
      await db.query("delete from faktura.vakter where org_id = $1 and id = $2", [orgId(c), id(c)]);
      const bruker = v.publisert && v.ansatt_id ? (await brukere(db, orgId(c), [v.ansatt_id])).get(v.ansatt_id) : undefined;
      return bruker ? [{ bruker_id: bruker, tittel: "Vakt fjernet", tekst: `Vakten din ${tid(v)} er tatt bort fra planen.`, url: ukeUrl(v.dato), tag: `vakt-${v.id}` }] : [];
    });
    await sendVarsler(orgId(c), varsler);
    return c.body(null, 204);
  });

  // Publiser utkastene i perioden (vanligvis en uke). Hver ansatt får én melding om sine nye
  // vakter, og de aktive ansatte får beskjed om nye ledige vakter.
  r.post("/vakter/publiser", async (c) => {
    const b = z.object({ fra: datoS, til: datoS }).parse(await c.req.json().catch(() => ({})));
    const { publisert, varsler } = await bruk(c, async (db) => {
      const rader = await alle<{ id: string; ansatt_id: string | null; dato: string; timer: number }>(
        db,
        "select id, ansatt_id, dato, timer from faktura.publiser_vakter($1, $2, $3)",
        [orgId(c), b.fra, b.til],
      );
      const varsler: Varsel[] = [];
      const u = uke(b.fra);
      const ukenr = u.fra === uke(b.til).fra ? u.uke : null;
      const perAnsatt = new Map<string, { antall: number; timer: number }>();
      for (const v of rader)
        if (v.ansatt_id) {
          const p = perAnsatt.get(v.ansatt_id) ?? { antall: 0, timer: 0 };
          perAnsatt.set(v.ansatt_id, { antall: p.antall + 1, timer: p.timer + Number(v.timer) });
        }
      const innlogging = await brukere(db, orgId(c), [...perAnsatt.keys()]);
      for (const [ansatt, p] of perAnsatt) {
        const bruker = innlogging.get(ansatt);
        if (bruker)
          varsler.push({
            bruker_id: bruker,
            tittel: ukenr ? `Vaktplan for uke ${ukenr}` : "Ny vaktplan",
            tekst: `Du har ${p.antall} ${p.antall === 1 ? "ny vakt" : "nye vakter"} (${timer(p.timer)}).`,
            url: ukeUrl(b.fra),
            tag: `vakter-${orgId(c)}-${u.fra}`,
          });
      }
      const ledige = rader.filter((v) => !v.ansatt_id).length;
      if (ledige)
        for (const m of await aktiveMedInnlogging(db, orgId(c)))
          varsler.push({
            bruker_id: m.bruker_id,
            tittel: ledige === 1 ? "Ny ledig vakt" : `${ledige} ledige vakter`,
            tekst: ukenr ? `Ledige vakter i uke ${ukenr}. Trykk for å ta en.` : "Trykk for å se dem og ta en.",
            url: "/vakter?fane=ledige",
            tag: `ledige-${orgId(c)}-${u.fra}`,
          });
      return { publisert: rader.length, varsler };
    });
    await sendVarsler(orgId(c), varsler);
    return c.json({ publisert, varslet: new Set(varsler.map((v) => v.bruker_id)).size });
  });

  // Kopier vaktene i en uke til en annen (og eventuelt flere uker etter den), som utkast.
  // Vakter for ansatte som ikke er aktive eller ansatt den nye dagen, vakter som finnes fra
  // før, og vikarvakter, hoppes over.
  r.post("/vakter/kopier", async (c) => {
    const b = z
      .object({ fra: datoS, til: datoS, antall: z.number().int().min(1).max(12, "Høyst 12 uker om gangen").optional() })
      .parse(await c.req.json().catch(() => ({})));
    const kilde = uke(b.fra).fra;
    const mal = uke(b.til).fra;
    if (kilde === mal) throw new ApiFeil(400, "Velg en annen uke å kopiere til");
    const antall = b.antall ?? 1;
    const svar = await bruk(c, async (db) => {
      await db.query("select faktura.krev($1, 'personal')", [orgId(c)]);
      const n = (await en<{ n: number }>(db, "select count(*)::int as n from faktura.vakter where org_id = $1 and dato between $2 and $3 and vikar_for is null", [
        orgId(c),
        kilde,
        leggTilDager(kilde, 6),
      ]))!.n;
      const nye = await alle(
        db,
        `insert into faktura.vakter (org_id, ansatt_id, dato, fra, til, pause_min, oppgave, notat)
         select v.org_id, v.ansatt_id, ny.dato, v.fra, v.til, v.pause_min, v.oppgave, v.notat
           from faktura.vakter v
           cross join generate_series(0, $5::int - 1) as k(n)
           cross join lateral (select v.dato + $4::int + k.n * 7 as dato) ny
           left join faktura.ansatte a on a.org_id = v.org_id and a.id = v.ansatt_id
          where v.org_id = $1 and v.dato between $2 and $3 and v.vikar_for is null
            and (v.ansatt_id is null or (a.aktiv and ny.dato >= a.ansatt_fra and (a.ansatt_til is null or ny.dato <= a.ansatt_til)))
            and not exists (select 1 from faktura.vakter d
                             where d.org_id = v.org_id and d.dato = ny.dato and d.fra = v.fra and d.til = v.til
                               and d.ansatt_id is not distinct from v.ansatt_id)
         returning id`,
        [orgId(c), kilde, leggTilDager(kilde, 6), dagerMellom(kilde, mal), antall],
      );
      return { kopiert: nye.length, hoppet_over: n * antall - nye.length };
    });
    return c.json(svar);
  });

  // Sett inn en vikar for en vakt (vanligvis når den ansatte er borte): en egen vakt med samme
  // tid og oppgave, som tar over plassene den ansatte hadde på tavla den dagen. Med publiser
  // (standard) går den ut med en gang, og vikaren får varsel.
  r.post("/vakter/:id/vikar", async (c) => {
    const b = z.object({ ansatt_id: uuid, publiser: z.boolean().optional() }).parse(await c.req.json().catch(() => ({})));
    const { vakt, varsler } = await bruk(c, async (db) => {
      await db.query("select faktura.krev($1, 'personal')", [orgId(c)]);
      const o = await en<Vakt>(db, `${VAKT} where v.org_id = $1 and v.id = $2`, [orgId(c), id(c)]);
      if (!o) throw new ApiFeil(404, "Fant ikke vakten");
      if (o.ansatt_id === b.ansatt_id) throw new ApiFeil(400, "Velg en annen enn den som har vakten");
      const ny = (await en<{ id: string }>(
        db,
        `insert into faktura.vakter (org_id, ansatt_id, dato, fra, til, pause_min, oppgave, notat, vikar_for)
         select org_id, $3, dato, fra, til, pause_min, oppgave, $4, id from faktura.vakter where org_id = $1 and id = $2
         returning id`,
        [orgId(c), id(c), b.ansatt_id, o.ansatt_navn ? `Vikar for ${o.ansatt_navn}` : "Vikar"],
      ))!;
      if (o.ansatt_id) {
        await db.query(
          `insert into faktura.tavle_plasseringer (org_id, dato, fase_id, oppgave_id, ansatt_id)
           select org_id, dato, fase_id, oppgave_id, $4 from faktura.tavle_plasseringer where org_id = $1 and dato = $2 and ansatt_id = $3
           on conflict (org_id, dato, fase_id, ansatt_id) do nothing`,
          [orgId(c), o.dato, o.ansatt_id, b.ansatt_id],
        );
        // Og den faste oppgaven til den som er borte (0059), i fasene vakten overlapper.
        for (const p of await fasteFaser(db, orgId(c), o.ansatt_id, o.dato, { fra: o.fra, til: o.til }))
          await db.query(
            `insert into faktura.tavle_plasseringer (org_id, dato, fase_id, oppgave_id, ansatt_id) values ($1, $2, $3, $4, $5)
             on conflict (org_id, dato, fase_id, ansatt_id) do nothing`,
            [orgId(c), o.dato, p.fase_id, p.oppgave_id, b.ansatt_id],
          );
      }
      const publiser = b.publiser !== false;
      if (publiser) await db.query("select faktura.publiser_vakt($1, $2)", [orgId(c), ny.id]);
      const vakt = (await en<Vakt>(db, `${VAKT} where v.id = $1`, [ny.id]))!;
      const bruker = publiser ? (await brukere(db, orgId(c), [b.ansatt_id])).get(b.ansatt_id) : undefined;
      const varsler: Varsel[] = bruker
        ? [{ bruker_id: bruker, tittel: "Ny vakt", tekst: `${tid(vakt)}${vakt.oppgave ? ` (${vakt.oppgave})` : ""}.`, url: ukeUrl(vakt.dato), tag: `vakt-${vakt.id}` }]
        : [];
      return { vakt, varsler };
    });
    await sendVarsler(orgId(c), varsler);
    return c.json(vakt, 201);
  });

  // En vakt fra den faste arbeidsplanen en dag (den som finnes, eller en ny, publisert uten
  // varsel), f.eks. for å sette inn vikar for en fast dag. En hel dag begynner kl. 08.
  r.post("/vakter/fra-plan", async (c) => {
    const b = z.object({ ansatt_id: uuid, dato: datoS }).parse(await c.req.json().catch(() => ({})));
    const vakt = await bruk(c, async (db) => {
      await db.query("select faktura.krev($1, 'personal')", [orgId(c)]);
      const finnes = await en<Vakt>(db, `${VAKT} where v.org_id = $1 and v.ansatt_id = $2 and v.dato = $3 order by v.fra limit 1`, [orgId(c), b.ansatt_id, b.dato]);
      if (finnes) return finnes;
      const a = await en<{ ukentlig_arbeidstid: number }>(db, "select ukentlig_arbeidstid from faktura.ansatte where org_id = $1 and id = $2", [orgId(c), b.ansatt_id]);
      const dag = helligdag(b.dato) ? undefined : planFor((await hentPlaner(db, orgId(c), b.ansatt_id)).get(b.ansatt_id), b.dato)?.dager.find((d) => d.ukedag === ukedag(b.dato));
      // Gitt bort i et vaktbytte (0060): fri den dagen.
      const fri = await en(db, "select 1 from faktura.arbeidsplan_fri where org_id = $1 and ansatt_id = $2 and dato = $3", [orgId(c), b.ansatt_id, b.dato]);
      if (!a || !dag || fri) throw new ApiFeil(400, "Den ansatte har ingen fast arbeidsdag denne dagen");
      const slutt = 8 * 60 + Math.round(dagTimer(dag, a.ukentlig_arbeidstid) * 60);
      const kl = (m: number) => `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
      const ny = (await en<{ id: string }>(
        db,
        "insert into faktura.vakter (org_id, ansatt_id, dato, fra, til, pause_min) values ($1, $2, $3, $4, $5, $6) returning id",
        [orgId(c), b.ansatt_id, b.dato, dag.fra ?? "08:00", dag.til ?? kl(slutt), dag.pause_min],
      ))!;
      await db.query("select faktura.publiser_vakt($1, $2)", [orgId(c), ny.id]);
      return (await en<Vakt>(db, `${VAKT} where v.id = $1`, [ny.id]))!;
    });
    return c.json(vakt, 201);
  });

  // Ta en ledig vakt. Eier og administrator får beskjed.
  r.post("/vakter/:id/ta", async (c) => {
    const { vakt, navn } = await bruk(c, async (db) => {
      await db.query("select faktura.ta_vakt($1, $2)", [orgId(c), id(c)]);
      const vakt = (await en<Vakt>(db, `${VAKT} where v.id = $1`, [id(c)]))!;
      return { vakt, navn: vakt.ansatt_navn ?? "En ansatt" };
    });
    await varslePersonal(orgId(c), c.get("bruker").id, "vakter", `Vakt tatt: ${navn}`, `${navn} tok den ledige vakten ${tid(vakt)}.`, ukeUrl(vakt.dato), `vakt-${vakt.id}`);
    return c.json(vakt);
  });

  return r;
}
