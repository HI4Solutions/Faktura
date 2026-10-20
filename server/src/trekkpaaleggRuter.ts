// Trekkpålegg fra Skatteetaten i appen (trekkpaalegg.ts, fanen «Trekkpålegg» under Lønn,
// docs/trekkpaalegg.md): påleggene som sist ble hentet, med den ansatte, trekket som gjelder nå og
// det som er trukket; om funksjonen er slått på og ressursen gitt i Altinn; og «Hent nå» (workeren
// henter, høyst én gang i minuttet). De som ser lønnen.
import { Hono, type Context } from "hono";
import { z } from "zod";
import { alle, en, somBruker, type Db } from "./db.js";
import { ApiFeil } from "./feil.js";
import { config } from "./config.js";
import { PAKKENAVN, TREKKPAALEGG_RESSURS } from "./altinn.js";
import { gjeldendePeriode, type Paaleggsperiode } from "./lonnstrekk.js";
import { leggIKo } from "./tjenester.js";

const orgId = (c: Context) => z.string().uuid().parse(c.req.param("org"));
const bruk = <T>(c: Context, fn: (db: Db) => Promise<T>) => somBruker<T>(c.get("bruker").id, fn);
const osloIDag = () => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Oslo" }).format(new Date());

export type Paaleggsrad = {
  id: string;
  trekkid: string;
  trekkversjon: number;
  saksnummer: string | null;
  trekkstatus: "aktiv" | "avsluttet";
  formidlet: string | null;
  fodselsdato: string | null;
  betalingsmottaker: string | null;
  kontonr: string | null;
  kid: string | null;
  perioder: Paaleggsperiode[];
  merknader: string[];
  mottatt: string;
  endret: string;
  ansatt_id: string | null;
  navn: string | null;
  ansattnummer: number | null;
  trekk_id: string | null;
  trukket: number;
  trukket_i_aar: number;
  sist_trukket: string | null;
};

// Påleggene med den ansatte og det som er trukket i godkjente kjøringer (i alt og i år).
export async function hentPaalegg(db: Db, org: string, iDag = osloIDag()) {
  const rader = await alle<Paaleggsrad>(
    db,
    `select p.id, p.trekkid, p.trekkversjon, p.saksnummer, p.trekkstatus, p.formidlet, to_char(p.fodselsdato, 'YYYY-MM-DD') as fodselsdato,
            p.betalingsmottaker, p.kontonr, p.kid, p.perioder, p.merknader, p.mottatt, p.endret,
            a.id as ansatt_id, a.fornavn || ' ' || a.etternavn as navn, a.ansattnummer, t.id as trekk_id,
            coalesce(x.trukket, 0)::float8 as trukket, coalesce(x.i_aar, 0)::float8 as trukket_i_aar, to_char(x.sist, 'YYYY-MM-DD') as sist_trukket
       from faktura.trekkpaalegg p
       left join faktura.ansatte a on a.org_id = p.org_id and a.id = p.ansatt_id
       left join faktura.lonnstrekk t on t.paalegg_id = p.id
       left join lateral (
         select -sum(l.belop) as trukket,
                -sum(l.belop) filter (where extract(year from k.utbetalingsdato) = extract(year from $2::date)) as i_aar,
                max(k.utbetalingsdato) as sist
           from faktura.lonnslinjer l join faktura.lonnsslipper s on s.id = l.slipp_id join faktura.lonnskjoringer k on k.id = s.kjoring_id
          where l.org_id = p.org_id and l.nokkel = 'trekk:' || t.id::text and not l.fjernet and k.status = 'godkjent'
       ) x on true
      where p.org_id = $1
      order by p.trekkstatus = 'avsluttet', a.etternavn nulls first, a.fornavn, p.formidlet desc nulls last, p.trekkid`,
    [org, iDag],
  );
  // Trekket som gjelder i dag, og det neste som er bestemt.
  return rader.map((r) => ({
    ...r,
    gjeldende: gjeldendePeriode(r.perioder, iDag),
    neste: r.perioder.filter((p) => p.fra > iDag).sort((x, y) => x.fra.localeCompare(y.fra))[0] ?? null,
  }));
}

async function status(db: Db, org: string) {
  await db.query("select faktura.krev($1, 'personal_les')", [org]);
  const t = await en<{ status: string; pakker: string[] }>(db, "select status, pakker from faktura.skattekort_tilgang where org_id = $1", [org]);
  const h = await en<{ forsokt: string | null; hentet: string | null; antall: number | null; feil: string | null }>(
    db,
    "select forsokt, hentet, antall, feil from faktura.trekkpaalegg_henting where org_id = $1",
    [org],
  );
  return {
    pa: config.trekkpaalegg,
    miljo: config.skatteetatenMiljo,
    // Koblet til Skatteetaten (Lønn → Skattekort), og med ressursen «Informasjon om trekkpålegg».
    koblet: t?.status === "godkjent",
    tilgang: Boolean(t?.status === "godkjent" && t.pakker.includes(TREKKPAALEGG_RESSURS)),
    ressurs: PAKKENAVN[TREKKPAALEGG_RESSURS],
    henting: { forsokt: h?.forsokt ?? null, hentet: h?.hentet ?? null, antall: h?.antall ?? null, feil: h?.feil ?? null },
    paalegg: await hentPaalegg(db, org),
  };
}

export function trekkpaaleggRuter() {
  const r = new Hono();

  r.get("/lonn/trekkpaalegg", async (c) => c.json(await bruk(c, (db) => status(db, orgId(c)))));

  // Hent nå (workeren henter påleggene). Høyst én gang i minuttet.
  r.post("/lonn/trekkpaalegg/hent", async (c) => {
    const s = await bruk(c, (db) => status(db, orgId(c)));
    if (!s.pa) throw new ApiFeil(409, "Trekkpålegg fra Skatteetaten er ikke slått på ennå.");
    if (!s.koblet) throw new ApiFeil(409, "Koble til Skatteetaten først (Lønn → Skattekort).");
    if (!s.tilgang)
      throw new ApiFeil(409, `Gi tilgang til trekkpåleggene i Altinn først: ressursen «${s.ressurs}» (Lønn → Skattekort → «Utvid tilgangen i Altinn»).`);
    if (s.henting.forsokt && Date.now() - Date.parse(s.henting.forsokt) < 60_000) return c.json({ ok: true, allerede: true });
    await leggIKo({ type: "trekkpaalegg-hent", org_id: orgId(c) });
    return c.json({ ok: true });
  });

  return r;
}
