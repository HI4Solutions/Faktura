// Ansatte og timer (0035_ansatte_og_timer.sql): ansattregisteret, den ansattes egen
// innlogging, timeføring med levering og godkjenning, og overtiden etter grensene i
// oppsettet (arbeidsmiljøloven: over 9 timer per dag og 40 per uke, minst 40 % tillegg).
//
// Tilgangen avgjøres i databasen (kan og RLS): personal (eier, admin) styrer ansatte og
// godkjenner timer, personal_les (også regnskap) ser alt, og den ansatte (rollen ansatt) ser
// og fører bare sitt eget. Fødselsnummeret krypteres her; bare workeren kan lese det.
import { Hono, type Context } from "hono";
import { z } from "zod";
import { config } from "./config.js";
import { alle, en, somBruker, somSystem, type Db } from "./db.js";
import { ApiFeil } from "./feil.js";
import { fnrGyldig, fodselsdato } from "./fnr.js";
import { krypter } from "./kryptering.js";
import { AML, beregnUke, uke, type Regler, type Ukesum } from "./arbeidstid.js";
import { dato as visDato, iDag, kontonrGyldig } from "./regler.js";
import { leggIKo } from "./tjenester.js";

const uuid = z.string().uuid();
const orgId = (c: Context) => uuid.parse(c.req.param("org"));
const id = (c: Context) => uuid.parse(c.req.param("id"));
const bruk = <T>(c: Context, fn: (db: Db) => Promise<T>) => somBruker<T>(c.get("bruker").id, fn);

// --- Skjemaer -----------------------------------------------------------------

// Tomme felt blir null (feltet fjernes).
export const valgfri = <T extends z.ZodTypeAny>(s: T) => z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? null : v), s.nullish());
export const tekst = (maks: number, navn: string) => z.string().trim().max(maks, `${navn} kan ha høyst ${maks} tegn`);
export const datoS = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Ugyldig dato");
export const klokke = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Skriv klokkeslettet som TT:MM");
const siffer = (navn: string, antall: number, sjekk?: (s: string) => boolean, melding?: string) =>
  z
    .string()
    .transform((v) => v.replace(/[\s.]/g, ""))
    .pipe(z.string().regex(new RegExp(`^\\d{${antall}}$`), `${navn} må ha ${antall} siffer`))
    .refine((v) => !sjekk || sjekk(v), melding ?? `Ugyldig ${navn.toLowerCase()}`);

const ansattSkjema = z.object({
  fornavn: z.string({ error: "Skriv fornavnet" }).trim().min(1, "Skriv fornavnet").max(100, "Fornavnet kan ha høyst 100 tegn"),
  etternavn: z.string({ error: "Skriv etternavnet" }).trim().min(1, "Skriv etternavnet").max(100, "Etternavnet kan ha høyst 100 tegn"),
  epost: valgfri(tekst(254, "E-postadressen").regex(/^[^@\s]+@[^@\s]+\.[^@\s]+$/, "Ugyldig e-postadresse")),
  telefon: valgfri(tekst(30, "Telefonnummeret")),
  adresse: valgfri(tekst(200, "Adressen")),
  postnr: valgfri(z.string().trim().regex(/^\d{4}$/, "Postnummeret må ha fire siffer")),
  poststed: valgfri(tekst(100, "Poststedet")),
  fodselsdato: valgfri(datoS),
  // Bare til skriving: lagres kryptert og vises aldri igjen (null: fjernes).
  fnr: valgfri(siffer("Fødselsnummeret", 11, fnrGyldig, "Fødselsnummeret er ikke gyldig (sjekk sifrene)")),
  kontonr: valgfri(siffer("Kontonummeret", 11, kontonrGyldig, "Kontonummeret er ikke gyldig (sjekk sifrene)")),
  stilling: valgfri(tekst(100, "Stillingen")),
  stillingsprosent: z.number({ error: "Skriv stillingsprosenten" }).gt(0, "Stillingsprosenten må være over 0").max(100, "Stillingsprosenten kan være høyst 100").optional(),
  ukentlig_arbeidstid: z.number().gt(0, "Arbeidstiden må være over 0").max(60, "Arbeidstiden kan være høyst 60 timer i uka").optional(),
  ansatt_fra: datoS.optional(),
  ansatt_til: valgfri(datoS),
  ansettelsestype: z.enum(["fast", "midlertidig", "tilkalling"]).optional(),
  lonnstype: z.enum(["maaned", "time"]).optional(),
  maanedslonn: valgfri(z.number().min(0, "Lønnen kan ikke være negativ").max(10_000_000)),
  timelonn: valgfri(z.number().min(0, "Lønnen kan ikke være negativ").max(100_000)),
  aktiv: z.boolean().optional(),
  notat: valgfri(tekst(2000, "Notatet")),
});

const oppsettSkjema = z.object({
  aktiv: z.boolean().optional(),
  daglig_grense: z.number().gt(0, "Grensen må være over 0").max(24, "Høyst 24 timer per dag").optional(),
  ukentlig_grense: z.number().gt(0, "Grensen må være over 0").max(80, "Høyst 80 timer per uke").optional(),
  overtid_prosent: z.number().int().min(40, "Overtidstillegget er minst 40 % (arbeidsmiljøloven § 10-6)").max(200).optional(),
});

const foringSkjema = z.object({
  ansatt_id: uuid.optional(),
  dato: datoS,
  fra: valgfri(klokke),
  til: valgfri(klokke),
  pause_min: z.number().int().min(0, "Pausen kan ikke være negativ").max(600, "Pausen kan være høyst 10 timer").optional(),
  timer: valgfri(z.number().gt(0, "Skriv antall timer").max(24, "Høyst 24 timer i én føring")),
  overtid_prosent: valgfri(z.number().int().min(40, "Overtidstillegget er minst 40 %").max(200)),
  beskrivelse: valgfri(tekst(500, "Beskrivelsen")),
  vakt_id: uuid.optional(), // timene føres fra en vakt (bare når føringen lages)
});

// --- Utvalg -------------------------------------------------------------------

const ANSATT = `
  select a.id, a.ansattnummer, a.fornavn, a.etternavn, a.epost, a.telefon, a.adresse, a.postnr, a.poststed,
         a.fodselsdato, a.har_fnr, a.kontonr, a.stilling, a.stillingsprosent, a.ukentlig_arbeidstid, a.ansatt_fra,
         a.ansatt_til, a.ansettelsestype, a.lonnstype, a.maanedslonn, a.timelonn, a.aktiv, a.notat, a.opprettet, a.oppdatert,
         a.bruker_id = faktura.bruker_id() as meg,
         case when a.bruker_id is not null
                   and exists (select 1 from faktura.medlemmer m where m.org_id = a.org_id and m.bruker_id = a.bruker_id) then 'koblet'
              when exists (select 1 from faktura.invitasjoner i
                            where i.org_id = a.org_id and i.ansatt_id = a.id and i.akseptert_at is null and i.utloper > now()) then 'invitert'
         end as tilgang
    from faktura.ansatte a`;

const FORING = `
  select t.id, t.ansatt_id, a.fornavn || ' ' || a.etternavn as ansatt_navn, t.dato,
         to_char(t.fra, 'HH24:MI') as fra, to_char(t.til, 'HH24:MI') as til, t.pause_min, t.timer, t.overtid_prosent,
         t.beskrivelse, t.status, t.avvist_grunn, t.levert_at, t.godkjent_at, t.opprettet, t.vakt_id
    from faktura.timeforinger t
    join faktura.ansatte a on a.org_id = t.org_id and a.id = t.ansatt_id`;

type Foringsrad = { id: string; ansatt_id: string; ansatt_navn: string; dato: string; timer: number; overtid_prosent: number | null; status: string };

export async function regler(db: Db, org: string): Promise<Regler & { aktiv: boolean }> {
  const r = await en<Regler & { aktiv: boolean }>(
    db,
    "select aktiv, daglig_grense, ukentlig_grense, overtid_prosent from faktura.lonn_oppsett where org_id = $1",
    [org],
  );
  return r ?? { aktiv: false, ...AML };
}

// Den innloggedes egen ansattrad i organisasjonen (eller null).
const meg = (db: Db, org: string) =>
  en<{ id: string; fornavn: string; etternavn: string }>(db, "select id, fornavn, etternavn from faktura.ansatte where org_id = $1 and bruker_id = faktura.bruker_id()", [
    org,
  ]);

// Ukene med føringer: sum, ordinære timer, overtid og merarbeid per ansatt og uke, status for
// uka (den laveste: utkast før levert før godkjent; avvist foran alt), og timene som var
// planlagt i vaktplanen (publiserte vakter, nøkkel «ansatt:mandag»).
function ukesummer(foringer: Foringsrad[], r: Regler, avtalt: Map<string, number | null>, planlagt: Map<string, number>) {
  const uker = new Map<string, { ansatt_id: string; ansatt_navn: string; aar: number; uke: number; fra: string; til: string; rader: Foringsrad[] }>();
  for (const f of foringer) {
    const u = uke(f.dato);
    const nokkel = `${f.ansatt_id}:${u.fra}`;
    if (!uker.has(nokkel)) uker.set(nokkel, { ansatt_id: f.ansatt_id, ansatt_navn: f.ansatt_navn, ...u, rader: [] });
    uker.get(nokkel)!.rader.push(f);
  }
  const rekke = ["avvist", "utkast", "levert", "godkjent"];
  return [...uker.values()]
    .sort((a, b) => b.fra.localeCompare(a.fra) || a.ansatt_navn.localeCompare(b.ansatt_navn, "nb"))
    .map(({ rader, ...u }) => ({
      ...u,
      ...(beregnUke(rader, r, avtalt.get(u.ansatt_id)) as Ukesum),
      planlagt: planlagt.get(`${u.ansatt_id}:${u.fra}`) ?? null,
      status: rekke.find((s) => rader.some((x) => x.status === s))!,
      antall: rader.length,
      antall_status: Object.fromEntries(rekke.map((s) => [s, rader.filter((x) => x.status === s).length])) as Record<string, number>,
    }));
}

// Push til eier og administrator (de som godkjenner timer, planlegger vakter og får vite om
// sykdom), unntatt den som selv gjorde det. Slås opp av serveren: en ansatt ser ikke hvem de andre medlemmene er.
export async function varslePersonal(org: string, unntatt: string, hendelse: "timer" | "vakter" | "fravaer", tittel: string, tekst: string, url: string, tag: string) {
  const mottakere = await somSystem((db) =>
    alle<{ bruker_id: string }>(db, "select bruker_id from faktura.medlemmer where org_id = $1 and rolle in ('eier', 'admin') and bruker_id <> $2", [
      org,
      unntatt,
    ]),
  );
  if (mottakere.length)
    await leggIKo({ type: "varsel", varsel: { hendelse, org_id: org, bruker_ider: mottakere.map((m) => m.bruker_id), tittel, tekst, url, tag } });
}

const timerTekst = (t: number) => `${t.toLocaleString("nb-NO", { maximumFractionDigits: 2 })} t`;

export function ansattRuter() {
  const r = new Hono();

  // --- Oppsett ---------------------------------------------------------------

  r.get("/lonn-oppsett", async (c) => c.json(await bruk(c, (db) => regler(db, orgId(c)))));

  r.put("/lonn-oppsett", async (c) => {
    const b = oppsettSkjema.parse(await c.req.json().catch(() => ({})));
    return c.json(
      await bruk(c, async (db) => {
        await db.query("select faktura.krev($1, 'admin')", [orgId(c)]);
        const naa = await regler(db, orgId(c));
        const ny = { ...naa, ...Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined)) };
        await db.query(
          `insert into faktura.lonn_oppsett (org_id, aktiv, daglig_grense, ukentlig_grense, overtid_prosent) values ($1, $2, $3, $4, $5)
           on conflict (org_id) do update set aktiv = excluded.aktiv, daglig_grense = excluded.daglig_grense,
             ukentlig_grense = excluded.ukentlig_grense, overtid_prosent = excluded.overtid_prosent`,
          [orgId(c), ny.aktiv, ny.daglig_grense, ny.ukentlig_grense, ny.overtid_prosent],
        );
        return regler(db, orgId(c));
      }),
    );
  });

  // --- Ansatte ---------------------------------------------------------------

  r.get("/ansatte", async (c) => {
    const aktiv = c.req.query("aktiv");
    return c.json(
      await bruk(c, async (db) => {
        await db.query("select faktura.krev($1, 'personal_les')", [orgId(c)]);
        return alle(db, `${ANSATT} where a.org_id = $1 and ($2::boolean is null or a.aktiv = $2) order by a.aktiv desc, a.etternavn, a.fornavn`, [
          orgId(c),
          aktiv === undefined ? null : aktiv !== "false",
        ]);
      }),
    );
  });

  // Den innloggede som ansatt (for timeføringen), eller null.
  r.get("/ansatte/meg", async (c) => c.json(await bruk(c, (db) => en(db, `${ANSATT} where a.org_id = $1 and a.bruker_id = faktura.bruker_id()`, [orgId(c)]))));

  r.get("/ansatte/:id", async (c) => {
    const a = await bruk(c, (db) => en(db, `${ANSATT} where a.org_id = $1 and a.id = $2`, [orgId(c), id(c)]));
    if (!a) throw new ApiFeil(404, "Fant ikke den ansatte");
    return c.json(a);
  });

  // Fødselsnummeret krypteres, og fødselsdatoen hentes fra det.
  async function felter(b: z.infer<typeof ansattSkjema> | Partial<z.infer<typeof ansattSkjema>>) {
    const { fnr, ...resten } = b;
    const f: Record<string, unknown> = Object.fromEntries(Object.entries(resten).filter(([, v]) => v !== undefined));
    if (fnr !== undefined) {
      f.fnr_kryptert = fnr ? await krypter(fnr) : null;
      if (fnr) f.fodselsdato = fodselsdato(fnr);
    }
    if (typeof f.fodselsdato === "string" && f.fodselsdato > iDag()) throw new ApiFeil(400, "Fødselsdatoen kan ikke være fram i tid");
    return f;
  }

  r.post("/ansatte", async (c) => {
    const f = await felter(ansattSkjema.parse(await c.req.json().catch(() => ({}))));
    const navn = Object.keys(f);
    const a = await bruk(c, async (db) => {
      const ny = await en<{ id: string }>(
        db,
        `insert into faktura.ansatte (org_id, ${navn.join(", ")}) values ($1, ${navn.map((_, i) => `$${i + 2}`).join(", ")}) returning id`,
        [orgId(c), ...navn.map((k) => f[k])],
      );
      return en(db, `${ANSATT} where a.org_id = $1 and a.id = $2`, [orgId(c), ny!.id]);
    });
    return c.json(a, 201);
  });

  r.patch("/ansatte/:id", async (c) => {
    const f = await felter(ansattSkjema.partial().parse(await c.req.json().catch(() => ({}))));
    const navn = Object.keys(f);
    if (!navn.length) throw new ApiFeil(400, "Ingen felt å endre");
    const a = await bruk(c, async (db) => {
      const res = await db.query(`update faktura.ansatte set ${navn.map((k, i) => `${k} = $${i + 3}`).join(", ")} where org_id = $1 and id = $2`, [
        orgId(c),
        id(c),
        ...navn.map((k) => f[k]),
      ]);
      if (!res.rowCount) throw new ApiFeil(404, "Fant ikke den ansatte");
      return en(db, `${ANSATT} where a.org_id = $1 and a.id = $2`, [orgId(c), id(c)]);
    });
    return c.json(a);
  });

  // Bare ansatte uten timer kan slettes; ellers settes en sluttdato (og den ansatte inaktiv).
  r.delete("/ansatte/:id", async (c) => {
    await bruk(c, async (db) => {
      await db.query("select faktura.krev($1, 'personal')", [orgId(c)]);
      const t = await en<{ n: number }>(db, "select count(*)::int as n from faktura.timeforinger where org_id = $1 and ansatt_id = $2", [orgId(c), id(c)]);
      if (t!.n > 0) throw new ApiFeil(409, `Den ansatte har ${t!.n} ${t!.n === 1 ? "timeføring" : "timeføringer"} og kan ikke slettes. Sett en sluttdato i stedet.`);
      const res = await db.query("delete from faktura.ansatte where org_id = $1 and id = $2", [orgId(c), id(c)]);
      if (!res.rowCount) throw new ApiFeil(404, "Fant ikke den ansatte");
    });
    return c.body(null, 204);
  });

  // Egen innlogging: invitasjon på e-post (rollen ansatt). Er e-posten alt med i
  // organisasjonen, kobles den med en gang.
  r.post("/ansatte/:id/inviter", async (c) => {
    const svar = await bruk(c, async (db) => {
      const token = (await en<{ t: string | null }>(db, "select faktura.inviter_ansatt($1, $2) as t", [orgId(c), id(c)]))!.t;
      const a = await en<{ fornavn: string; epost: string }>(db, "select fornavn, epost from faktura.ansatte where org_id = $1 and id = $2", [orgId(c), id(c)]);
      const org = await en<{ navn: string }>(db, "select navn from faktura.organisasjoner where id = $1", [orgId(c)]);
      return { token, ansatt: a!, org: org!.navn };
    });
    if (!svar.token) return c.json({ koblet: true, lenke: null, sendt_til: null });
    const lenke = `${config.appUrl}/invitasjon/${svar.token}`;
    await leggIKo({
      type: "epost",
      til: [svar.ansatt.epost],
      emne: `Du er invitert til ${svar.org} i HI4 Faktura`,
      fra_navn: svar.org,
      tekst: [
        `Hei ${svar.ansatt.fornavn},`,
        "",
        `${svar.org} har gitt deg tilgang til HI4 Faktura, der du fører timene dine.`,
        "",
        `Åpne lenken for å logge inn (bruk denne e-postadressen): ${lenke}`,
        "",
        "Lenken gjelder i sju dager.",
      ].join("\n"),
    });
    return c.json({ koblet: false, lenke, sendt_til: svar.ansatt.epost });
  });

  r.delete("/ansatte/:id/tilgang", async (c) => {
    await bruk(c, (db) => db.query("select faktura.fjern_ansatt_tilgang($1, $2)", [orgId(c), id(c)]));
    return c.body(null, 204);
  });

  // --- Timer -------------------------------------------------------------------

  // Føringene i perioden (den ansatte ser bare sine egne), med ukene oppsummert.
  r.get("/timer", async (c) => {
    const q = z
      .object({ fra: datoS, til: datoS, ansatt: uuid.optional(), status: z.enum(["utkast", "levert", "godkjent", "avvist"]).optional() })
      .parse(c.req.query());
    if (q.til < q.fra) throw new ApiFeil(400, "Slutten er før starten");
    return c.json(
      await bruk(c, async (db) => {
        const regel = await regler(db, orgId(c));
        // Hele uker, så overtiden regnes riktig også når perioden starter midt i en uke.
        const fra = uke(q.fra).fra;
        const til = uke(q.til).til;
        const foringer = await alle<Foringsrad>(
          db,
          `${FORING} where t.org_id = $1 and t.dato between $2 and $3 and ($4::uuid is null or t.ansatt_id = $4)
            order by t.dato, t.fra nulls last, t.opprettet`,
          [orgId(c), fra, til, q.ansatt ?? null],
        );
        const avtalt = new Map(
          (
            await alle<{ id: string; avtalt: number }>(
              db,
              "select id, ukentlig_arbeidstid * stillingsprosent / 100 as avtalt from faktura.ansatte where org_id = $1 and id = any($2::uuid[])",
              [orgId(c), [...new Set(foringer.map((f) => f.ansatt_id))]],
            )
          ).map((a) => [a.id, a.avtalt] as const),
        );
        const planlagt = new Map<string, number>();
        for (const v of await alle<{ ansatt_id: string; dato: string; timer: number }>(
          db,
          `select ansatt_id, dato, timer from faktura.vakter
            where org_id = $1 and dato between $2 and $3 and publisert_at is not null and ansatt_id = any($4::uuid[])`,
          [orgId(c), fra, til, [...avtalt.keys()]],
        )) {
          const k = `${v.ansatt_id}:${uke(v.dato).fra}`;
          planlagt.set(k, Math.round(((planlagt.get(k) ?? 0) + Number(v.timer)) * 100) / 100);
        }
        let uker = ukesummer(foringer, regel, avtalt, planlagt);
        // Med status: ukene med føringer med den statusen (f.eks. levert, til godkjenning).
        if (q.status) uker = uker.filter((u) => u.antall_status[q.status!] > 0);
        const iPerioden = (d: string) => d >= q.fra && d <= q.til;
        return { regler: regel, foringer: foringer.filter((f) => iPerioden(f.dato) && (!q.status || f.status === q.status)), uker };
      }),
    );
  });

  // Ny føring: for seg selv, eller (personal) for en annen ansatt.
  r.post("/timer", async (c) => {
    const b = foringSkjema.parse(await c.req.json().catch(() => ({})));
    if (!b.fra !== !b.til) throw new ApiFeil(400, "Skriv både fra og til, eller bare antall timer");
    if (!b.fra && !b.timer) throw new ApiFeil(400, "Skriv fra og til, eller antall timer");
    const f = await bruk(c, async (db) => {
      const ansatt = b.ansatt_id ?? (await meg(db, orgId(c)))?.id;
      if (!ansatt) throw new ApiFeil(400, "Du er ikke registrert som ansatt her. Velg en ansatt.");
      const ny = await en<{ id: string }>(
        db,
        `insert into faktura.timeforinger (org_id, ansatt_id, dato, fra, til, pause_min, timer, overtid_prosent, beskrivelse, vakt_id)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id`,
        [
          orgId(c),
          ansatt,
          b.dato,
          b.fra ?? null,
          b.til ?? null,
          b.pause_min ?? 0,
          b.fra ? null : b.timer,
          b.overtid_prosent ?? null,
          b.beskrivelse ?? null,
          b.vakt_id ?? null,
        ],
      );
      return en(db, `${FORING} where t.id = $1`, [ny!.id]);
    });
    return c.json(f, 201);
  });

  r.patch("/timer/:id", async (c) => {
    const b = foringSkjema.omit({ ansatt_id: true, vakt_id: true }).partial().parse(await c.req.json().catch(() => ({})));
    const f = await bruk(c, async (db) => {
      const naa = await en<{ fra: string | null; til: string | null; status: string }>(
        db,
        "select fra, til, status from faktura.timeforinger where org_id = $1 and id = $2",
        [orgId(c), id(c)],
      );
      if (!naa) throw new ApiFeil(404, "Fant ikke føringen");
      const felt: Record<string, unknown> = Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined));
      // Bare timer: fra og til fjernes. Med fra og til regnes timene ut i databasen.
      if (felt.timer != null && felt.fra === undefined && felt.til === undefined) Object.assign(felt, { fra: null, til: null });
      const fra = felt.fra !== undefined ? felt.fra : naa.fra;
      const til = felt.til !== undefined ? felt.til : naa.til;
      if (!fra !== !til) throw new ApiFeil(400, "Skriv både fra og til, eller bare antall timer");
      if (fra) delete felt.timer;
      else if (felt.timer === null) throw new ApiFeil(400, "Skriv antall timer");
      const navn = Object.keys(felt);
      if (!navn.length) throw new ApiFeil(400, "Ingen felt å endre");
      const res = await db.query(`update faktura.timeforinger set ${navn.map((k, i) => `${k} = $${i + 3}`).join(", ")} where org_id = $1 and id = $2`, [
        orgId(c),
        id(c),
        ...navn.map((k) => felt[k]),
      ]);
      if (!res.rowCount) throw new ApiFeil(409, "Timene er levert og kan ikke endres");
      return en(db, `${FORING} where t.id = $1`, [id(c)]);
    });
    return c.json(f);
  });

  r.delete("/timer/:id", async (c) => {
    await bruk(c, async (db) => {
      const res = await db.query("delete from faktura.timeforinger where org_id = $1 and id = $2", [orgId(c), id(c)]);
      if (!res.rowCount) {
        const finnes = await en<{ status: string }>(db, "select status from faktura.timeforinger where org_id = $1 and id = $2", [orgId(c), id(c)]);
        throw finnes ? new ApiFeil(409, "Timene er levert og kan ikke slettes") : new ApiFeil(404, "Fant ikke føringen");
      }
    });
    return c.body(null, 204);
  });

  // Lever timene i perioden (vanligvis en uke): de som godkjenner, får varsel.
  r.post("/timer/lever", async (c) => {
    const b = z.object({ ansatt_id: uuid.optional(), fra: datoS, til: datoS }).parse(await c.req.json().catch(() => ({})));
    const svar = await bruk(c, async (db) => {
      const ansatt = b.ansatt_id ?? (await meg(db, orgId(c)))?.id;
      if (!ansatt) throw new ApiFeil(400, "Du er ikke registrert som ansatt her");
      const n = (await en<{ n: number }>(db, "select faktura.lever_timer($1, $2, $3, $4) as n", [orgId(c), ansatt, b.fra, b.til]))!.n;
      if (!n) throw new ApiFeil(409, "Ingen timer å levere i perioden");
      const a = await en<{ navn: string; timer: number }>(
        db,
        `select a.fornavn || ' ' || a.etternavn as navn,
                (select coalesce(sum(t.timer), 0) from faktura.timeforinger t
                  where t.org_id = a.org_id and t.ansatt_id = a.id and t.dato between $3 and $4 and t.status = 'levert') as timer
           from faktura.ansatte a where a.org_id = $1 and a.id = $2`,
        [orgId(c), ansatt, b.fra, b.til],
      );
      const u = uke(b.fra);
      const periode = u.fra === b.fra && u.til === b.til ? `uke ${u.uke}` : `${visDato(b.fra)}–${visDato(b.til)}`;
      return { levert: n, varsel: { tittel: `Timer levert: ${a!.navn}`, tekst: `${a!.navn} har levert ${timerTekst(a!.timer)} for ${periode}.` } };
    });
    await varslePersonal(orgId(c), c.get("bruker").id, "timer", svar.varsel.tittel, svar.varsel.tekst, "/timer?fane=godkjenning", `timer-${orgId(c)}`);
    return c.json({ levert: svar.levert });
  });

  // Godkjenn eller avvis (personal): den ansatte får varsel.
  for (const handling of ["godkjenn", "avvis"] as const) {
    r.post(`/timer/${handling}`, async (c) => {
      const b = z
        .object({ ider: z.array(uuid).min(1, "Velg timene").max(1000), grunn: z.string().max(500, "Grunnen kan ha høyst 500 tegn").optional() })
        .parse(await c.req.json().catch(() => ({})));
      const svar = await bruk(c, async (db) => {
        const n =
          handling === "godkjenn"
            ? (await en<{ n: number }>(db, "select faktura.godkjenn_timer($1, $2) as n", [orgId(c), b.ider]))!.n
            : (await en<{ n: number }>(db, "select faktura.avvis_timer($1, $2, $3) as n", [orgId(c), b.ider, b.grunn ?? ""]))!.n;
        // Én melding per ansatt og uke.
        const berort = await alle<{ bruker_id: string | null; dato: string }>(
          db,
          `select a.bruker_id, t.dato from faktura.timeforinger t join faktura.ansatte a on a.org_id = t.org_id and a.id = t.ansatt_id
            where t.org_id = $1 and t.id = any($2::uuid[]) and a.bruker_id is not null and a.bruker_id is distinct from faktura.bruker_id()`,
          [orgId(c), b.ider],
        );
        const meldinger = new Map<string, { bruker: string; uke: number; fra: string }>();
        for (const x of berort) meldinger.set(`${x.bruker_id}:${uke(x.dato).fra}`, { bruker: x.bruker_id!, uke: uke(x.dato).uke, fra: uke(x.dato).fra });
        for (const m of meldinger.values())
          await leggIKo({
            type: "varsel",
            varsel: {
              hendelse: "timer",
              org_id: orgId(c),
              bruker_ider: [m.bruker],
              tittel: handling === "godkjenn" ? `Timene for uke ${m.uke} er godkjent` : `Timene for uke ${m.uke} ble avvist`,
              tekst: handling === "godkjenn" ? "Trykk for å se timene." : `${b.grunn?.trim() ?? ""} Rett dem og lever på nytt.`.trim(),
              url: `/timer?uke=${m.fra}`,
              tag: `timer-${m.bruker}-${m.fra}`,
            },
          });
        return { [handling === "godkjenn" ? "godkjent" : "avvist"]: n };
      });
      return c.json(svar);
    });
  }

  return r;
}
