// Sjekklister (0114_sjekklister.sql, funksjonen «Sjekklister» i Personal): administrator lager
// sjekklister med punkter som gjøres daglig, ukentlig, månedlig eller ved behov, av alle eller av
// rollene som har dem (f.eks. varemottak for lageret). Den som gjør den, svarer «Normalt» eller
// «Avvik» med en kommentar på hvert punkt (eller «Alt normalt»), og fullfører. Avvikene går til
// administrator (varsel), som lukker dem med det som er gjort; den som meldte avviket, får vite
// det. Hvem som ser og kan gjøre hva, avgjøres i databasen.
import { Hono, type Context } from "hono";
import { z } from "zod";
import { alle, en, somBruker, type Db } from "./db.js";
import { ApiFeil } from "./feil.js";
import { leggIKo } from "./tjenester.js";
import { varslePersonal } from "./ansatte.js";

const uuid = z.string().uuid();
const orgId = (c: Context) => uuid.parse(c.req.param("org"));
const id = (c: Context, navn = "id") => uuid.parse(c.req.param(navn));
const bruk = <T>(c: Context, fn: (db: Db) => Promise<T>) => somBruker<T>(c.get("bruker").id, fn);

export const FREKVENSER = ["daglig", "ukentlig", "maanedlig", "ved_behov"] as const;
export type Frekvens = (typeof FREKVENSER)[number];
export const FREKVENSNAVN: Record<Frekvens, string> = { daglig: "Daglig", ukentlig: "Ukentlig", maanedlig: "Månedlig", ved_behov: "Ved behov" };

// --- Periodene (som faktura.sjekkliste_periode) ------------------------------------------------

const dag = (d: string) => new Date(`${d}T00:00:00Z`);
const somTekst = (d: Date) => d.toISOString().slice(0, 10);

// Starten av perioden datoen hører til: dagen, mandagen i uka eller den første i måneden.
export function periodeFor(frekvens: Frekvens, dato: string): string {
  const d = dag(dato);
  if (frekvens === "ukentlig") d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  else if (frekvens === "maanedlig") d.setUTCDate(1);
  return somTekst(d);
}

// Den siste dagen i perioden.
export function periodeSlutt(frekvens: Frekvens, periode: string): string {
  const d = dag(periode);
  if (frekvens === "ukentlig") d.setUTCDate(d.getUTCDate() + 6);
  else if (frekvens === "maanedlig") return somTekst(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)));
  return somTekst(d);
}

// Periodene som overlapper fra–til (de faste; ved behov har ingen).
export function perioder(frekvens: Frekvens, fra: string, til: string): string[] {
  if (frekvens === "ved_behov" || fra > til) return [];
  const ut: string[] = [];
  let p = periodeFor(frekvens, fra);
  while (p <= til && ut.length < 1000) {
    ut.push(p);
    p = somTekst(new Date(dag(periodeSlutt(frekvens, p)).getTime() + 86_400_000));
  }
  return ut;
}

// --- Skjemaene ---------------------------------------------------------------------------------

const sjekklisteSkjema = z.object({
  navn: z.string({ error: "Gi sjekklisten et navn" }).trim().min(2, "Gi sjekklisten et navn (minst 2 tegn)").max(80, "Navnet kan ha høyst 80 tegn"),
  beskrivelse: z.string().trim().max(1000, "Beskrivelsen kan ha høyst 1000 tegn").nullish(),
  frekvens: z.enum(FREKVENSER, { error: "Velg hvor ofte sjekklisten skal gjøres" }),
  roller: z.array(uuid).max(50).optional(), // tom: alle
  punkter: z
    .array(
      z.object({
        id: uuid.optional(),
        tekst: z.string({ error: "Skriv hva som skal sjekkes" }).trim().min(1, "Skriv hva som skal sjekkes").max(200, "Et punkt kan ha høyst 200 tegn"),
        hjelp: z.string().trim().max(500, "Veiledningen kan ha høyst 500 tegn").nullish(),
      }),
    )
    .min(1, "Legg inn minst ett punkt")
    .max(100, "En sjekkliste kan ha høyst 100 punkter"),
});
const svarSkjema = z.object({
  svar: z.enum(["ok", "avvik"]).nullable(),
  kommentar: z.string().max(2000, "Kommentaren kan ha høyst 2000 tegn").nullish(),
});
const datoS = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Ugyldig dato");

// --- Spørringene -------------------------------------------------------------------------------

const TELL = (utfylling: string, ekstra = "") =>
  `(select count(*)::int from faktura.sjekkliste_svar x where x.org_id = ${utfylling}.org_id and x.utfylling_id = ${utfylling}.id${ekstra})`;

// Sjekklistene med punktene, utfyllingen den innloggede jobber på nå (de faste: denne perioden; ved
// behov: sin egen som ikke er fullført), den siste som er fullført, og om forrige periode ble gjort
// (forrige: starten av den; daglig med stengt i helgene er det hverdagen før). Laget etter at
// forrige periode var over: null.
const LISTER = `
  select s.id, s.navn, s.beskrivelse, s.frekvens, s.roller, s.aktiv,
         faktura.kan_gjore_sjekkliste(s.org_id, s.roller) as min,
         coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'tekst', p.tekst, 'hjelp', p.hjelp) order by p.rekkefolge)
                     from faktura.sjekkliste_punkter p where p.org_id = s.org_id and p.sjekkliste_id = s.id and p.aktiv), '[]'::jsonb) as punkter,
         case when s.frekvens = 'ved_behov' then null
              else to_char(faktura.sjekkliste_periode(s.frekvens, faktura.i_dag()), 'YYYY-MM-DD') end as periode,
         n.naa, sist.sist,
         case when (s.opprettet at time zone 'Europe/Oslo')::date > f.slutt then null else to_char(f.forrige, 'YYYY-MM-DD') end as forrige,
         case when f.forrige is null or (s.opprettet at time zone 'Europe/Oslo')::date > f.slutt then null
              else exists (select 1 from faktura.sjekkliste_utfyllinger u
                            where u.org_id = s.org_id and u.sjekkliste_id = s.id and u.status = 'fullfort' and u.frekvens = s.frekvens
                              and u.periode = f.forrige) end
           as forrige_gjort
    from faktura.sjekklister s
    cross join lateral (
      select p.forrige,
             case s.frekvens when 'ukentlig' then p.forrige + 6
                             when 'maanedlig' then (p.forrige + interval '1 month' - interval '1 day')::date
                             else p.forrige end as slutt
        from (select faktura.sjekkliste_forrige(s.frekvens, faktura.i_dag(),
                       coalesce((select l.helg from faktura.lonn_oppsett l where l.org_id = s.org_id), true)) as forrige) p
    ) f
    left join lateral (
      select jsonb_build_object('id', u.id, 'status', u.status, 'periode', to_char(u.periode, 'YYYY-MM-DD'), 'startet_navn', u.startet_navn,
                                'fullfort', u.fullfort, 'fullfort_navn', u.fullfort_navn, 'besvart', ${TELL("u")},
                                'avvik', ${TELL("u", " and x.svar = 'avvik'")}) as naa
        from faktura.sjekkliste_utfyllinger u
       where u.org_id = s.org_id and u.sjekkliste_id = s.id
         and case when s.frekvens = 'ved_behov' then u.status = 'pagar' and u.startet_av = faktura.bruker_id()
                  else u.frekvens = s.frekvens and u.periode = faktura.sjekkliste_periode(s.frekvens, faktura.i_dag()) end
       order by u.startet desc limit 1
    ) n on true
    left join lateral (
      select jsonb_build_object('id', u.id, 'periode', to_char(u.periode, 'YYYY-MM-DD'), 'fullfort', u.fullfort, 'fullfort_navn', u.fullfort_navn,
                                'avvik', ${TELL("u", " and x.svar = 'avvik'")}) as sist
        from faktura.sjekkliste_utfyllinger u
       where u.org_id = s.org_id and u.sjekkliste_id = s.id and u.status = 'fullfort'
       order by u.fullfort desc limit 1
    ) sist on true`;

const UTFYLLING = `
  select u.id, u.sjekkliste_id, s.navn, s.beskrivelse, u.frekvens, to_char(u.periode, 'YYYY-MM-DD') as periode, u.status, u.kommentar,
         u.startet, u.startet_navn, u.fullfort, u.fullfort_navn,
         (u.status = 'pagar' and s.aktiv and faktura.kan_gjore_sjekkliste(u.org_id, s.roller)) as kan_svare
    from faktura.sjekkliste_utfyllinger u join faktura.sjekklister s on s.org_id = u.org_id and s.id = u.sjekkliste_id
   where u.org_id = $1 and u.id = $2`;

// Punktene i utfyllingen med svarene: de i lista og de som er besvart (en fullført viser bare de
// besvarte, med teksten slik den var).
const PUNKTER = `
  select p.id, coalesce(x.punkt_tekst, p.tekst) as tekst, p.hjelp, p.aktiv,
         case when x.punkt_id is null then null
              else jsonb_build_object('svar', x.svar, 'kommentar', x.kommentar, 'besvart', x.besvart, 'besvart_navn', x.besvart_navn,
                                      'avvik_lukket', x.avvik_lukket, 'avvik_lukket_navn', x.avvik_lukket_navn, 'tiltak', x.tiltak) end as svar
    from faktura.sjekkliste_punkter p
    left join faktura.sjekkliste_svar x on x.org_id = p.org_id and x.utfylling_id = $2 and x.punkt_id = p.id
   where p.org_id = $1 and p.sjekkliste_id = $3 and (x.punkt_id is not null or (p.aktiv and $4))
   order by p.rekkefolge, p.opprettet`;

const AVVIK = `
  select x.utfylling_id, x.punkt_id, u.sjekkliste_id, s.navn as sjekkliste, u.frekvens, to_char(u.periode, 'YYYY-MM-DD') as periode,
         u.status as utfylling_status, x.punkt_tekst, x.kommentar, x.besvart, x.besvart_navn, x.avvik_lukket, x.avvik_lukket_navn, x.tiltak,
         x.besvart_av = faktura.bruker_id() as eget
    from faktura.sjekkliste_svar x
    join faktura.sjekkliste_utfyllinger u on u.org_id = x.org_id and u.id = x.utfylling_id
    join faktura.sjekklister s on s.org_id = u.org_id and s.id = u.sjekkliste_id
   where x.org_id = $1 and x.svar = 'avvik'`;

async function tilgang(db: Db, org: string) {
  return (await en<{ kan_endre: boolean; ser_alle: boolean }>(db, "select faktura.kan($1, 'personal') as kan_endre, faktura.kan($1, 'personal_les') as ser_alle", [
    org,
  ]))!;
}

async function hentUtfylling(db: Db, org: string, uid: string) {
  const u = await en<{ id: string; sjekkliste_id: string; status: string; kan_svare: boolean }>(db, UTFYLLING, [org, uid]);
  if (!u) throw new ApiFeil(404, "Fant ikke sjekklisten");
  const punkter = await alle(db, PUNKTER, [org, uid, u.sjekkliste_id, u.status === "pagar"]);
  return { ...u, punkter };
}

// --- Rutene ------------------------------------------------------------------------------------

export function sjekklisteRuter() {
  const r = new Hono();

  // Sjekklistene den innloggede gjør (administrator: alle, også de arkiverte), rollene og antall
  // åpne avvik (administrator: alle; ellers de egne).
  r.get("/sjekklister", async (c) =>
    c.json(
      await bruk(c, async (db) => {
        const t = await tilgang(db, orgId(c));
        const lister = await alle<{ min: boolean; aktiv: boolean }>(db, `${LISTER} where s.org_id = $1 order by lower(s.navn)`, [orgId(c)]);
        const apne = await en<{ n: number }>(
          db,
          `select count(*)::int as n from faktura.sjekkliste_svar x
            where x.org_id = $1 and x.svar = 'avvik' and x.avvik_lukket is null and ($2 or x.besvart_av = faktura.bruker_id())`,
          [orgId(c), t.ser_alle],
        );
        return {
          idag: (await en<{ d: string }>(db, "select to_char(faktura.i_dag(), 'YYYY-MM-DD') as d"))!.d,
          ...t,
          roller: await alle(db, "select * from faktura.beskjed_roller($1)", [orgId(c)]),
          lister: lister.filter((l) => t.kan_endre || (l.aktiv && l.min)),
          apne_avvik: apne!.n,
        };
      }),
    ),
  );

  // Ny sjekkliste (administrator).
  r.post("/sjekklister", async (c) => {
    const b = sjekklisteSkjema.parse(await c.req.json().catch(() => ({})));
    const ny = await bruk(c, (db) =>
      en<{ id: string }>(db, "select faktura.lagre_sjekkliste($1, null, $2, $3, $4, $5, $6) as id", [
        orgId(c),
        b.navn,
        b.beskrivelse ?? null,
        b.frekvens,
        b.roller ?? [],
        JSON.stringify(b.punkter),
      ]),
    );
    return c.json({ id: ny!.id }, 201);
  });

  // Endre (administrator): navnet, hvor ofte, rollene og punktene.
  r.put("/sjekklister/:id", async (c) => {
    const b = sjekklisteSkjema.parse(await c.req.json().catch(() => ({})));
    await bruk(c, (db) =>
      db.query("select faktura.lagre_sjekkliste($1, $2, $3, $4, $5, $6, $7)", [
        orgId(c),
        id(c),
        b.navn,
        b.beskrivelse ?? null,
        b.frekvens,
        b.roller ?? [],
        JSON.stringify(b.punkter),
      ]),
    );
    return c.json({ id: id(c) });
  });

  // Arkivere eller hente fram (administrator).
  r.post("/sjekklister/:id/aktiv", async (c) => {
    const b = z.object({ aktiv: z.boolean() }).parse(await c.req.json().catch(() => ({})));
    await bruk(c, (db) => db.query("select faktura.sett_sjekkliste_aktiv($1, $2, $3)", [orgId(c), id(c), b.aktiv]));
    return c.body(null, 204);
  });

  // Slette (administrator): en som er brukt, arkiveres.
  r.delete("/sjekklister/:id", async (c) => {
    const s = await bruk(c, (db) => en<{ resultat: string }>(db, "select faktura.slett_sjekkliste($1, $2) as resultat", [orgId(c), id(c)]));
    return c.json({ resultat: s!.resultat });
  });

  // Starte (eller fortsette) sjekklisten for perioden datoen hører til (i dag uten dato).
  r.post("/sjekklister/:id/start", async (c) => {
    const b = z.object({ dato: datoS.optional() }).parse(await c.req.json().catch(() => ({})));
    const u = await bruk(c, async (db) => {
      const ny = await en<{ id: string }>(db, "select faktura.start_sjekkliste($1, $2, $3) as id", [orgId(c), id(c), b.dato ?? null]);
      return hentUtfylling(db, orgId(c), ny!.id);
    });
    return c.json(u);
  });

  // Utfyllingene i en periode (de siste 30 dagene uten valg), for historikken.
  r.get("/sjekklister/utfyllinger", async (c) => {
    const q = z
      .object({ fra: datoS.optional(), til: datoS.optional(), sjekkliste: uuid.optional() })
      .parse({ fra: c.req.query("fra"), til: c.req.query("til"), sjekkliste: c.req.query("sjekkliste") });
    return c.json(
      await bruk(c, (db) =>
        alle(
          db,
          `select u.id, u.sjekkliste_id, s.navn, u.frekvens, to_char(u.periode, 'YYYY-MM-DD') as periode, u.status,
                  u.startet, u.startet_navn, u.fullfort, u.fullfort_navn, u.kommentar,
                  ${TELL("u")} as besvart, ${TELL("u", " and x.svar = 'avvik'")} as avvik,
                  ${TELL("u", " and x.svar = 'avvik' and x.avvik_lukket is null")} as apne_avvik
             from faktura.sjekkliste_utfyllinger u join faktura.sjekklister s on s.org_id = u.org_id and s.id = u.sjekkliste_id
            where u.org_id = $1 and u.periode between coalesce($2::date, faktura.i_dag() - 30) and coalesce($3::date, faktura.i_dag())
              and ($4::uuid is null or u.sjekkliste_id = $4)
            order by u.periode desc, u.startet desc limit 500`,
          [orgId(c), q.fra ?? null, q.til ?? null, q.sjekkliste ?? null],
        ),
      ),
    );
  });

  r.get("/sjekklister/utfyllinger/:id", async (c) => c.json(await bruk(c, (db) => hentUtfylling(db, orgId(c), id(c)))));

  // Svar på et punkt: «ok» eller «avvik» med kommentar (null: tar bort svaret).
  r.put("/sjekklister/utfyllinger/:id/punkter/:punkt", async (c) => {
    const b = svarSkjema.parse(await c.req.json().catch(() => ({})));
    await bruk(c, (db) => db.query("select faktura.svar_sjekkliste($1, $2, $3, $4, $5)", [orgId(c), id(c), id(c, "punkt"), b.svar, b.kommentar ?? null]));
    return c.body(null, 204);
  });

  // «Alt normalt»: punktene uten svar får «ok».
  r.post("/sjekklister/utfyllinger/:id/alt-normalt", async (c) =>
    c.json(
      await bruk(c, async (db) => {
        await db.query("select faktura.sjekkliste_alt_normalt($1, $2)", [orgId(c), id(c)]);
        return hentUtfylling(db, orgId(c), id(c));
      }),
    ),
  );

  // Fullføre. Med avvik får administrator varsel.
  r.post("/sjekklister/utfyllinger/:id/fullfor", async (c) => {
    const b = z.object({ kommentar: z.string().max(2000, "Kommentaren kan ha høyst 2000 tegn").nullish() }).parse(await c.req.json().catch(() => ({})));
    const { avvik, liste } = await bruk(c, async (db) => {
      const n = (await en<{ n: number }>(db, "select faktura.fullfor_sjekkliste($1, $2, $3) as n", [orgId(c), id(c), b.kommentar ?? null]))!.n;
      const avvik = n
        ? await alle<{ punkt_tekst: string; kommentar: string }>(
            db,
            "select punkt_tekst, kommentar from faktura.sjekkliste_svar where org_id = $1 and utfylling_id = $2 and svar = 'avvik' order by besvart",
            [orgId(c), id(c)],
          )
        : [];
      return { avvik, liste: (await en<{ navn: string; startet_navn: string }>(db, UTFYLLING, [orgId(c), id(c)]))! };
    });
    if (avvik.length) {
      const forste = avvik[0]!;
      const tekst = `${forste.punkt_tekst}: ${forste.kommentar}`;
      await varslePersonal(
        orgId(c),
        c.get("bruker").id,
        "sjekklister",
        `${avvik.length === 1 ? "Avvik" : `${avvik.length} avvik`} i «${liste.navn}»`,
        `${tekst.length > 150 ? `${tekst.slice(0, 147)}…` : tekst}${avvik.length > 1 ? ` (og ${avvik.length - 1} til)` : ""}`,
        "/sjekklister?fane=avvik",
        `sjekkliste-${id(c)}`,
      ).catch(() => undefined);
    }
    return c.json({ avvik: avvik.length });
  });

  // Avvikene: administrator (og de som ser personalet) ser alle, ellers de egne. Åpne først; de
  // lukkede med «alle=1».
  r.get("/sjekklister/avvik", async (c) => {
    const alleAvvik = c.req.query("alle") === "1";
    return c.json(
      await bruk(c, async (db) => {
        const t = await tilgang(db, orgId(c));
        return alle(
          db,
          `${AVVIK} and ($2 or x.avvik_lukket is null) and ($3 or x.besvart_av = faktura.bruker_id())
           order by (x.avvik_lukket is null) desc, coalesce(x.avvik_lukket, x.besvart) desc limit 500`,
          [orgId(c), alleAvvik, t.ser_alle],
        );
      }),
    );
  });

  // Lukke et avvik med det som er gjort (administrator). Den som meldte det, får varsel.
  r.post("/sjekklister/avvik/:id/:punkt/lukk", async (c) => {
    const b = z
      .object({ tiltak: z.string({ error: "Skriv hva som er gjort med avviket" }).trim().min(2, "Skriv hva som er gjort med avviket").max(2000) })
      .parse(await c.req.json().catch(() => ({})));
    const meg = c.get("bruker").id;
    const res = await bruk(c, async (db) => {
      const meldt = (await en<{ b: string | null }>(db, "select faktura.lukk_sjekkliste_avvik($1, $2, $3, $4) as b", [orgId(c), id(c), id(c, "punkt"), b.tiltak]))!.b;
      const rad = await en<{ sjekkliste: string; punkt_tekst: string }>(db, `${AVVIK} and x.utfylling_id = $2 and x.punkt_id = $3`, [orgId(c), id(c), id(c, "punkt")]);
      return { meldt, rad };
    });
    if (res.meldt && res.meldt !== meg && res.rad)
      await leggIKo({
        type: "varsel",
        varsel: {
          hendelse: "sjekklister",
          org_id: orgId(c),
          bruker_ider: [res.meldt],
          tittel: `Avviket i «${res.rad.sjekkliste}» er lukket`,
          tekst: `${res.rad.punkt_tekst}: ${b.tiltak.length > 150 ? `${b.tiltak.slice(0, 147)}…` : b.tiltak}`,
          url: "/sjekklister?fane=avvik",
          tag: `sjekkliste-avvik-${id(c)}-${id(c, "punkt")}`,
        },
      }).catch(() => undefined);
    return c.body(null, 204);
  });

  return r;
}
