// Yrkesskader (Lønn K8, 0102_yrkesskader.sql): yrkesskadeforsikringen (selskapet og
// polisenummeret), registeret over personskadene under arbeidet (arbeidsmiljøloven § 5-1), og det som
// gjenstår å melde for hver skade: skademeldingen til NAV (så snart som mulig, også ved tvil),
// meldingen til forsikringsselskapet, og ved dødsfall eller alvorlig personskade varselet til
// Arbeidstilsynet og politiet (straks, § 5-2). Registeret har helseopplysninger: bare eier og
// administrator. Rapporten «Skaderegister (yrkesskader)» i rapportmodulen.
import { Hono, type Context } from "hono";
import { z } from "zod";
import { alle, en, somBruker, type Db } from "./db.js";
import { ApiFeil } from "./feil.js";
import type { Rapportdef } from "./rapportmodul.js";
import { iDag } from "./regler.js";

const uuid = z.string().uuid();
const orgId = (c: Context) => uuid.parse(c.req.param("org"));
const bruk = <T>(c: Context, fn: (db: Db) => Promise<T>) => somBruker<T>(c.get("bruker").id, fn);
const datoS = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Ugyldig dato");
const tom = (v: unknown) => (typeof v === "string" && v.trim() === "" ? null : v);
const tekst = (maks: number) => z.preprocess(tom, z.string().trim().max(maks).nullish());
const dato = z.preprocess(tom, datoS.nullish());

const skjema = z.object({
  ansatt_id: uuid,
  dato: datoS,
  klokkeslett: z.preprocess(tom, z.string().regex(/^\d{2}:\d{2}$/, "Ugyldig klokkeslett").nullish()),
  type: z.enum(["ulykke", "sykdom"]).default("ulykke"),
  sted: tekst(300),
  beskrivelse: z.string().trim().min(1, "Beskriv hva som skjedde").max(4000),
  skade: tekst(1000),
  alvorlig: z.boolean().default(false),
  fravaer: z.boolean().default(false),
  tiltak: tekst(2000),
  meldt_nav: dato,
  meldt_forsikring: dato,
  meldt_arbeidstilsynet: dato,
  meldt_politi: dato,
});

export type Yrkesskade = {
  id: string;
  ansatt_id: string;
  navn: string;
  dato: string;
  klokkeslett: string | null;
  type: "ulykke" | "sykdom";
  sted: string | null;
  beskrivelse: string;
  skade: string | null;
  alvorlig: boolean;
  fravaer: boolean;
  tiltak: string | null;
  meldt_nav: string | null;
  meldt_forsikring: string | null;
  meldt_arbeidstilsynet: string | null;
  meldt_politi: string | null;
};
type Forsikring = { selskap: string | null; polise: string | null };

const SKADE = `
  select y.id, y.ansatt_id, a.fornavn || ' ' || a.etternavn as navn, to_char(y.dato, 'YYYY-MM-DD') as dato,
         to_char(y.klokkeslett, 'HH24:MI') as klokkeslett, y.type, y.sted, y.beskrivelse, y.skade, y.alvorlig, y.fravaer, y.tiltak,
         to_char(y.meldt_nav, 'YYYY-MM-DD') as meldt_nav, to_char(y.meldt_forsikring, 'YYYY-MM-DD') as meldt_forsikring,
         to_char(y.meldt_arbeidstilsynet, 'YYYY-MM-DD') as meldt_arbeidstilsynet, to_char(y.meldt_politi, 'YYYY-MM-DD') as meldt_politi
    from faktura.yrkesskader y join faktura.ansatte a on a.org_id = y.org_id and a.id = y.ansatt_id`;

// Det som gjenstår å melde for skaden (tom liste: alt er meldt).
export function oppgaver(s: Pick<Yrkesskade, "alvorlig" | "meldt_nav" | "meldt_forsikring" | "meldt_arbeidstilsynet" | "meldt_politi">, f: Forsikring): string[] {
  const ut: string[] = [];
  if (s.alvorlig && !s.meldt_arbeidstilsynet)
    ut.push("Varsle Arbeidstilsynet straks (arbeidsmiljøloven § 5-2): ved dødsfall eller alvorlig personskade skal Arbeidstilsynet varsles på raskeste måte.");
  if (s.alvorlig && !s.meldt_politi) ut.push("Varsle politiet straks: dødsfall og alvorlig personskade på jobben skal også meldes til politiet.");
  if (!s.meldt_nav)
    ut.push("Send skademelding til NAV så snart som mulig (nav.no/arbeidsgiver/meldyrkesskade), også om dere er i tvil om det er en yrkesskade.");
  if (!s.meldt_forsikring)
    ut.push(
      f.selskap
        ? `Meld skaden til yrkesskadeforsikringen (${f.selskap}${f.polise ? `, polise ${f.polise}` : ""}).`
        : "Meld skaden til yrkesskadeforsikringen (legg inn selskapet og polisenummeret i registeret).",
    );
  return ut;
}

async function forsikring(db: Db, org: string): Promise<Forsikring> {
  const f = await en<{ selskap: string | null; polise: string | null }>(
    db,
    "select yrkesskade_selskap as selskap, yrkesskade_polise as polise from faktura.lonn_oppsett where org_id = $1",
    [org],
  );
  return { selskap: f?.selskap ?? null, polise: f?.polise ?? null };
}

export function yrkesskadeRuter() {
  const r = new Hono();

  // Registeret (nyeste først), med forsikringen og det som gjenstår å melde.
  r.get("/yrkesskader", async (c) =>
    c.json(
      await bruk(c, async (db) => {
        await db.query("select faktura.krev($1, 'personal')", [orgId(c)]);
        const f = await forsikring(db, orgId(c));
        const skader = await alle<Yrkesskade>(db, `${SKADE} where y.org_id = $1 order by y.dato desc, y.opprettet desc`, [orgId(c)]);
        return { forsikring: f, skader: skader.map((s) => ({ ...s, oppgaver: oppgaver(s, f) })) };
      }),
    ),
  );

  r.put("/yrkesskader/forsikring", async (c) => {
    const b = z.object({ selskap: tekst(200), polise: tekst(100) }).parse(await c.req.json().catch(() => ({})));
    return c.json(
      await bruk(c, async (db) => {
        await db.query("select faktura.krev($1, 'admin')", [orgId(c)]);
        await db.query(
          `insert into faktura.lonn_oppsett (org_id, yrkesskade_selskap, yrkesskade_polise) values ($1, $2, $3)
           on conflict (org_id) do update set yrkesskade_selskap = excluded.yrkesskade_selskap, yrkesskade_polise = excluded.yrkesskade_polise`,
          [orgId(c), b.selskap ?? null, b.polise ?? null],
        );
        return forsikring(db, orgId(c));
      }),
    );
  });

  async function lagre(db: Db, org: string, f: Record<string, unknown>, id: string | null) {
    if (typeof f.ansatt_id === "string" && !(await en(db, "select 1 from faktura.ansatte where org_id = $1 and id = $2", [org, f.ansatt_id])))
      throw new ApiFeil(400, "Fant ikke den ansatte");
    if (typeof f.dato === "string" && f.dato > iDag()) throw new ApiFeil(400, "Datoen for skaden kan ikke være fram i tid");
    const k = Object.keys(f);
    if (id) {
      if (!k.length) throw new ApiFeil(400, "Ingen felt å endre");
      const res = await db.query(`update faktura.yrkesskader set ${k.map((x, i) => `${x} = $${i + 3}`).join(", ")} where org_id = $1 and id = $2`, [
        org,
        id,
        ...k.map((x) => f[x]),
      ]);
      if (!res.rowCount) throw new ApiFeil(404, "Fant ikke skaden");
      return id;
    }
    return (await en<{ id: string }>(db, `insert into faktura.yrkesskader (org_id, ${k.join(", ")}) values ($1, ${k.map((_, i) => `$${i + 2}`).join(", ")}) returning id`, [
      org,
      ...k.map((x) => f[x]),
    ]))!.id;
  }
  const svar = async (db: Db, org: string, id: string) => {
    const s = (await en<Yrkesskade>(db, `${SKADE} where y.org_id = $1 and y.id = $2`, [org, id]))!;
    return { ...s, oppgaver: oppgaver(s, await forsikring(db, org)) };
  };

  r.post("/yrkesskader", async (c) => {
    const b = skjema.parse(await c.req.json().catch(() => ({})));
    const s = await bruk(c, async (db) => {
      await db.query("select faktura.krev($1, 'personal')", [orgId(c)]);
      const f = Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined));
      return svar(db, orgId(c), await lagre(db, orgId(c), f, null));
    });
    return c.json(s, 201);
  });

  r.patch("/yrkesskader/:id", async (c) => {
    const id = uuid.parse(c.req.param("id"));
    const raa = await c.req.json().catch(() => ({}));
    const b = skjema.partial().parse(raa);
    return c.json(
      await bruk(c, async (db) => {
        await db.query("select faktura.krev($1, 'personal')", [orgId(c)]);
        // Bare feltene som er sendt (standardverdiene i skjemaet gjelder ikke ved endring).
        const f = Object.fromEntries(Object.entries(b).filter(([k, v]) => v !== undefined && k in raa));
        return svar(db, orgId(c), await lagre(db, orgId(c), f, id));
      }),
    );
  });

  r.delete("/yrkesskader/:id", async (c) => {
    const id = uuid.parse(c.req.param("id"));
    await bruk(c, async (db) => {
      await db.query("select faktura.krev($1, 'personal')", [orgId(c)]);
      const res = await db.query("delete from faktura.yrkesskader where org_id = $1 and id = $2", [orgId(c), id]);
      if (!res.rowCount) throw new ApiFeil(404, "Fant ikke skaden");
    });
    return c.body(null, 204);
  });

  return r;
}

// --- Rapporten --------------------------------------------------------------------------------

const ja = (b: boolean) => (b ? "Ja" : "Nei");
export const yrkesskadeRapporter: Rapportdef[] = [
  {
    id: "personal.yrkesskader",
    modul: "personal",
    navn: "Skaderegister (yrkesskader)",
    beskrivelse:
      "Personskadene under arbeidet i året (arbeidsmiljøloven § 5-1): hva som skjedde, skaden, fraværet, tiltakene, og når det ble meldt til NAV, forsikringen, Arbeidstilsynet og politiet.",
    funksjon: "ansatte",
    tilgang: "personal",
    parameter: "aar",
    hent: async (db, org, v) => {
      const f = await forsikring(db, org);
      const rader = await alle<Yrkesskade>(db, `${SKADE} where y.org_id = $1 and extract(year from y.dato) = $2 order by y.dato, y.opprettet`, [org, v.aar]);
      return {
        kolonner: [
          { nokkel: "dato", navn: "Dato", type: "dato" },
          { nokkel: "navn", navn: "Ansatt" },
          { nokkel: "type", navn: "Type" },
          { nokkel: "sted", navn: "Sted" },
          { nokkel: "beskrivelse", navn: "Hva skjedde" },
          { nokkel: "skade", navn: "Skade" },
          { nokkel: "alvorlig", navn: "Alvorlig" },
          { nokkel: "fravaer", navn: "Fravær" },
          { nokkel: "tiltak", navn: "Tiltak", pdf: false },
          { nokkel: "meldt_nav", navn: "Meldt NAV", type: "dato" },
          { nokkel: "meldt_forsikring", navn: "Meldt forsikring", type: "dato" },
          { nokkel: "meldt_arbeidstilsynet", navn: "Arbeidstilsynet", type: "dato", pdf: false },
        ],
        rader: rader.map((s) => ({
          dato: s.dato,
          navn: s.navn,
          type: s.type === "sykdom" ? "Yrkessykdom" : "Arbeidsulykke",
          sted: s.sted ?? "",
          beskrivelse: s.beskrivelse,
          skade: s.skade ?? "",
          alvorlig: ja(s.alvorlig),
          fravaer: ja(s.fravaer),
          tiltak: s.tiltak ?? "",
          meldt_nav: s.meldt_nav,
          meldt_forsikring: s.meldt_forsikring,
          meldt_arbeidstilsynet: s.meldt_arbeidstilsynet,
        })),
        merknad: `Registeret over personskader under arbeidet (arbeidsmiljøloven § 5-1) skal være tilgjengelig for verneombudet, arbeidsmiljøutvalget, bedriftshelsetjenesten og Arbeidstilsynet. Yrkesskadeforsikring: ${f.selskap ? `${f.selskap}${f.polise ? `, polise ${f.polise}` : ""}` : "ikke registrert"}.`,
      };
    },
  },
];
