// Regnskapsmodulen, andre del (0087_regnskap_bilag.sql): periodiseringene, månedsavslutningen
// (avskrivningene og periodiseringene som mangler, bokført måned for måned), bilagene (lista fra alle
// kildene, manuelle bilag og reversering), saldobalansen og hovedboken. Eier, administrator og
// regnskap (funksjonen «Regnskap»). Beregningene: periodisering.ts og hovedbok.ts.
import { Hono, type Context } from "hono";
import { z } from "zod";
import { en, somBruker, type Db } from "./db.js";
import { ApiFeil } from "./feil.js";
import { avskrivningsforslag, hentAnlegg, hentRegnskapsoppsett, mnd, regnskapskontoer } from "./anlegg.js";
import { hentRegnskapsbilag, hovedbok, KILDER, navnPaaKonto, saldobalanse } from "./hovedbok.js";
import { STANDARDKONTOER } from "./kontoplan.js";
import { maanedNavn } from "./lonnsberegning.js";
import {
  bokforPeriodisering,
  fordeling,
  hentPeriodiseringer,
  maanedsbilag,
  PERIODISERINGSKODER,
  PERIODISERINGSTYPER,
  periodiseringsforslag,
  startbilag,
  status,
  type Periodisering,
} from "./periodisering.js";
import { bokforAvskrivninger } from "./regnskapRuter.js";

const uuid = z.string().uuid();
const orgId = (c: Context) => uuid.parse(c.req.param("org"));
const bruk = <T>(c: Context, fn: (db: Db) => Promise<T>) => somBruker<T>(c.get("bruker").id, fn);
const krev = (db: Db, org: string) => db.query("select faktura.krev($1, 'regnskap')", [org]);
const datoS = z.string({ error: "Velg datoen" }).regex(/^\d{4}-\d{2}-\d{2}$/, "Ugyldig dato");
const mndS = z.string({ error: "Velg måneden" }).regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Ugyldig måned");
const kontoS = z.string({ error: "Skriv kontonummeret" }).trim().regex(/^\d{4,6}$/, "Kontonummeret må ha 4–6 siffer");
const osloIDag = () => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Oslo" }).format(new Date());
const rund = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const periodeS = z.object({ fra: datoS.optional(), til: datoS.optional() });
const standardPeriode = (q: { fra?: string; til?: string }) => {
  const iDag = osloIDag();
  return { fra: q.fra ?? `${iDag.slice(0, 4)}-01-01`, til: q.til ?? iDag };
};

// --- Periodiseringene -------------------------------------------------------------------------

const periodiseringSkjema = z.object({
  navn: z.string({ error: "Skriv navnet" }).trim().min(1, "Skriv navnet").max(120, "Navnet kan være høyst 120 tegn"),
  type: z.enum(PERIODISERINGSKODER, { error: "Velg hva slags periodisering det er" }),
  belop: z.number({ error: "Skriv beløpet" }).finite().positive("Beløpet må være over 0").lt(1e12, "Beløpet er for stort"),
  fra: mndS,
  antall_maaneder: z.number({ error: "Skriv antall måneder" }).int("Antall måneder må være et helt tall").min(1, "Minst én måned").max(120, "Høyst 120 måneder"),
  resultatkonto: kontoS,
  balansekonto: kontoS.optional(),
  start: z.enum(["ingen", "flytt", "motkonto"]).optional(),
  motkonto: kontoS.nullable().optional(),
  mva: z.number().finite().min(0, "Mva-en kan ikke være negativ").lt(1e12).optional(),
  start_dato: datoS.optional(),
  tekst: z.string().trim().max(300, "Teksten kan være høyst 300 tegn").nullable().optional(),
});

// Starten dateres den første dagen i den første måneden, eller i dag når den er fram i tid.
const startdato = (fra: string) => (fra < osloIDag() ? fra : osloIDag());

async function periodiseringDetalj(db: Db, org: string, id: string) {
  const { periodiseringer, poster } = await hentPeriodiseringer(db, org, id);
  const p = periodiseringer[0];
  if (!p) throw new ApiFeil(404, "Fant ikke periodiseringen");
  return { periodisering: { ...p, ...status(p, poster) }, poster, fordeling: fordeling(p, poster) };
}

// --- Månedsavslutningen -----------------------------------------------------------------------

async function maanedsforslag(db: Db, org: string, til: string) {
  const { anlegg, hendelser } = await hentAnlegg(db, org);
  const { periodiseringer, poster } = await hentPeriodiseringer(db, org);
  const avskr = avskrivningsforslag(anlegg, hendelser, til);
  const per = periodiseringsforslag(periodiseringer, poster, til);
  const maaneder = [...new Set([...avskr.map((m) => m.maaned), ...per.map((m) => m.maaned)])].sort();
  const sum = (l: { belop: number }[]) => rund(l.reduce((s, x) => s + x.belop, 0));
  return {
    til,
    maaneder: maaneder.map((m) => {
      const a = avskr.find((x) => x.maaned === m)?.linjer ?? [];
      const p = per.find((x) => x.maaned === m)?.linjer ?? [];
      return {
        maaned: m,
        navn: maanedNavn(`${m}-01`),
        avskrivninger: { sum: sum(a), linjer: a.map((l) => ({ nummer: l.a.nummer, navn: l.a.navn, belop: l.belop })) },
        periodiseringer: { sum: sum(p), linjer: p.map((l) => ({ nummer: l.p.nummer, navn: l.p.navn, belop: l.belop })) },
      };
    }),
  };
}

async function bokforPeriodiseringer(db: Db, org: string, til: string) {
  const { periodiseringer, poster } = await hentPeriodiseringer(db, org);
  const bilag = [];
  for (const m of periodiseringsforslag(periodiseringer, poster, til))
    bilag.push({ ...(await bokforPeriodisering(db, org, maanedsbilag(m.maaned, m.linjer))), sum: rund(m.linjer.reduce((s, l) => s + l.belop, 0)) });
  return bilag;
}

// --- Manuelle bilag ---------------------------------------------------------------------------

const linjeS = z.object({
  konto: kontoS,
  tekst: z.string().trim().max(200, "Teksten på en linje kan være høyst 200 tegn").nullable().optional(),
  debet: z.number().finite().min(0, "Beløpet kan ikke være negativt").lt(1e12).nullable().optional(),
  kredit: z.number().finite().min(0, "Beløpet kan ikke være negativt").lt(1e12).nullable().optional(),
});
const bilagSkjema = z.object({
  dato: datoS,
  tekst: z.string({ error: "Skriv teksten for bilaget" }).trim().min(1, "Skriv teksten for bilaget").max(300, "Teksten kan være høyst 300 tegn"),
  linjer: z.array(linjeS).min(2, "Bilaget må ha minst to linjer").max(200, "Høyst 200 linjer"),
});

export function regnskapBilagRuter() {
  const r = new Hono();

  r.get("/regnskap/periodiseringer", async (c) =>
    c.json(
      await bruk(c, async (db) => {
        await krev(db, orgId(c));
        const { periodiseringer, poster } = await hentPeriodiseringer(db, orgId(c));
        const k = regnskapskontoer(await hentRegnskapsoppsett(db, orgId(c)));
        return {
          periodiseringer: periodiseringer.map((p) => ({ ...p, ...status(p, poster) })),
          // Typene med kontoene som foreslås (balansekontoen fra Regnskap → Kontoer).
          typer: PERIODISERINGSKODER.map((t) => {
            const x = PERIODISERINGSTYPER[t];
            return { type: t, navn: x.navn, kostnad: x.kostnad, forskudd: x.forskudd, balansekonto: k[x.balanse], resultatkonto: x.resultat };
          }),
        };
      }),
    ),
  );

  r.post("/regnskap/periodiseringer", async (c) => {
    const b = periodiseringSkjema.parse(await c.req.json().catch(() => ({})));
    const t = PERIODISERINGSTYPER[b.type];
    const start = t.forskudd ? (b.start ?? "ingen") : "ingen";
    if (!t.forskudd && b.start && b.start !== "ingen") throw new ApiFeil(400, "Bare forskudd har en start");
    if (start === "motkonto" && !b.motkonto) throw new ApiFeil(400, "Velg motkontoen");
    if (b.start_dato && b.start_dato > osloIDag()) throw new ApiFeil(400, "Datoen kan ikke være fram i tid");
    return c.json(
      await bruk(c, async (db) => {
        await krev(db, orgId(c));
        const k = regnskapskontoer(await hentRegnskapsoppsett(db, orgId(c)));
        const balansekonto = b.balansekonto ?? k[t.balanse];
        if (balansekonto === b.resultatkonto) throw new ApiFeil(400, "Resultatkontoen og balansekontoen må være forskjellige");
        const ny = await en<{ id: string }>(
          db,
          `insert into faktura.periodiseringer (org_id, navn, type, belop, fra, antall_maaneder, resultatkonto, balansekonto, start, tekst)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id`,
          [orgId(c), b.navn, b.type, b.belop, `${b.fra}-01`, b.antall_maaneder, b.resultatkonto, balansekonto, start, b.tekst ?? null],
        );
        let bilag = null;
        if (start !== "ingen") {
          const { periodiseringer } = await hentPeriodiseringer(db, orgId(c), ny!.id);
          bilag = await bokforPeriodisering(db, orgId(c), startbilag(periodiseringer[0]!, { dato: b.start_dato ?? startdato(`${b.fra}-01`), motkonto: b.motkonto, mva: b.mva }, k));
        }
        return { ...(await periodiseringDetalj(db, orgId(c), ny!.id)), bilag };
      }),
      201,
    );
  });

  r.get("/regnskap/periodiseringer/:id", async (c) =>
    c.json(
      await bruk(c, async (db) => {
        await krev(db, orgId(c));
        return periodiseringDetalj(db, orgId(c), uuid.parse(c.req.param("id")));
      }),
    ),
  );

  r.patch("/regnskap/periodiseringer/:id", async (c) => {
    const id = uuid.parse(c.req.param("id"));
    const b = periodiseringSkjema
      .pick({ navn: true, belop: true, fra: true, antall_maaneder: true, resultatkonto: true, balansekonto: true, start: true, tekst: true })
      .partial()
      .parse(await c.req.json().catch(() => ({})));
    return c.json(
      await bruk(c, async (db) => {
        await krev(db, orgId(c));
        const { periodiseringer } = await hentPeriodiseringer(db, orgId(c), id);
        const p: Periodisering | undefined = periodiseringer[0];
        if (!p) throw new ApiFeil(404, "Fant ikke periodiseringen");
        const ny = {
          navn: b.navn ?? p.navn,
          belop: b.belop ?? p.belop,
          fra: b.fra ? `${b.fra}-01` : p.fra,
          antall_maaneder: b.antall_maaneder ?? p.antall_maaneder,
          resultatkonto: b.resultatkonto ?? p.resultatkonto,
          balansekonto: b.balansekonto ?? p.balansekonto,
          start: b.start ?? p.start,
          tekst: b.tekst !== undefined ? b.tekst : p.tekst,
        };
        if (ny.resultatkonto === ny.balansekonto) throw new ApiFeil(400, "Resultatkontoen og balansekontoen må være forskjellige");
        if (ny.start !== "ingen" && !PERIODISERINGSTYPER[p.type].forskudd) throw new ApiFeil(400, "Bare forskudd har en start");
        await db.query(
          `update faktura.periodiseringer set navn = $3, belop = $4, fra = $5, antall_maaneder = $6, resultatkonto = $7, balansekonto = $8, start = $9, tekst = $10
            where org_id = $1 and id = $2`,
          [orgId(c), id, ny.navn, ny.belop, ny.fra, ny.antall_maaneder, ny.resultatkonto, ny.balansekonto, ny.start, ny.tekst],
        );
        return periodiseringDetalj(db, orgId(c), id);
      }),
    );
  });

  // Bokfører starten for et forskudd (når den ikke ble bokført da periodiseringen ble lagt inn, eller
  // er reversert).
  r.post("/regnskap/periodiseringer/:id/start", async (c) => {
    const id = uuid.parse(c.req.param("id"));
    const b = z
      .object({ dato: datoS.optional(), motkonto: kontoS.nullable().optional(), mva: z.number().finite().min(0, "Mva-en kan ikke være negativ").lt(1e12).optional() })
      .parse(await c.req.json().catch(() => ({})));
    if (b.dato && b.dato > osloIDag()) throw new ApiFeil(400, "Datoen kan ikke være fram i tid");
    return c.json(
      await bruk(c, async (db) => {
        await krev(db, orgId(c));
        const { periodiseringer, poster } = await hentPeriodiseringer(db, orgId(c), id);
        const p = periodiseringer[0];
        if (!p) throw new ApiFeil(404, "Fant ikke periodiseringen");
        if (p.start === "ingen") throw new ApiFeil(409, "Periodiseringen har ingen start å bokføre");
        if (!status(p, poster).mangler_start) throw new ApiFeil(409, "Starten er alt bokført");
        const k = regnskapskontoer(await hentRegnskapsoppsett(db, orgId(c)));
        const bilag = await bokforPeriodisering(db, orgId(c), startbilag(p, { dato: b.dato ?? startdato(p.fra), motkonto: b.motkonto, mva: b.mva }, k));
        return { ...(await periodiseringDetalj(db, orgId(c), id)), bilag };
      }),
      201,
    );
  });

  r.delete("/regnskap/periodiseringer/:id", async (c) => {
    const id = uuid.parse(c.req.param("id"));
    await bruk(c, async (db) => {
      await krev(db, orgId(c));
      const n = await db.query("delete from faktura.periodiseringer where org_id = $1 and id = $2", [orgId(c), id]);
      if (!n.rowCount) throw new ApiFeil(404, "Fant ikke periodiseringen");
    });
    return c.body(null, 204);
  });

  // Månedsavslutningen: avskrivningene og periodiseringene som ikke er bokført til og med måneden.
  r.get("/regnskap/maanedsavslutning", async (c) => {
    const til = mndS.parse(c.req.query("til") ?? mnd(osloIDag()));
    return c.json(
      await bruk(c, async (db) => {
        await krev(db, orgId(c));
        return maanedsforslag(db, orgId(c), til);
      }),
    );
  });

  r.post("/regnskap/maanedsavslutning", async (c) => {
    const b = z.object({ til: mndS }).parse(await c.req.json().catch(() => ({})));
    if (b.til > mnd(osloIDag())) throw new ApiFeil(400, "Måneden kan ikke være fram i tid");
    return c.json(
      await bruk(c, async (db) => {
        await krev(db, orgId(c));
        return { bilag: [...(await bokforAvskrivninger(db, orgId(c), b.til)), ...(await bokforPeriodiseringer(db, orgId(c), b.til))] };
      }),
      201,
    );
  });

  // Bilagene fra alle kildene i perioden.
  r.get("/regnskap/bilag", async (c) => {
    const q = periodeS.extend({ kilde: z.enum(Object.keys(KILDER) as [string, ...string[]]).optional() }).parse(c.req.query());
    const { fra, til } = standardPeriode(q);
    return c.json(
      await bruk(c, async (db) => {
        await krev(db, orgId(c));
        return { fra, til, bilag: await hentRegnskapsbilag(db, orgId(c), { fra, til, kilde: q.kilde ?? null }) };
      }),
    );
  });

  // Manuelt bilag (serie M): linjene med debet eller kredit, som går i null.
  r.post("/regnskap/bilag", async (c) => {
    const b = bilagSkjema.parse(await c.req.json().catch(() => ({})));
    if (b.dato > osloIDag()) throw new ApiFeil(400, "Datoen kan ikke være fram i tid");
    const linjer = b.linjer.map((l, i) => {
      const d = Math.round((l.debet ?? 0) * 100);
      const k = Math.round((l.kredit ?? 0) * 100);
      if ((d > 0) === (k > 0)) throw new ApiFeil(400, `Linje ${i + 1}: skriv beløpet enten i debet eller i kredit`);
      return { konto: l.konto, belop: (d - k) / 100, tekst: l.tekst ?? null };
    });
    const sum = linjer.reduce((s, l) => s + Math.round(l.belop * 100), 0);
    if (sum !== 0) throw new ApiFeil(400, `Bilaget går ikke i null: debet og kredit skiller ${(Math.abs(sum) / 100).toLocaleString("nb-NO", { minimumFractionDigits: 2 }).replace(/[\u00a0\u202f]/g, " ")} kr`);
    return c.json(
      await bruk(c, async (db) => {
        await krev(db, orgId(c));
        const ny = await en<{ id: string }>(db, "select faktura.bokfor_manuelt($1, $2, $3, $4) as id", [orgId(c), b.dato, b.tekst, JSON.stringify(linjer)]);
        return (await hentRegnskapsbilag(db, orgId(c), { id: ny!.id }))[0]!;
      }),
      201,
    );
  });

  // Reverserer et bilag (det siste først for anleggsmidlene og periodiseringene). Lønnsbilagene og
  // refusjonene fra NAV reverseres der de kommer fra.
  r.post("/regnskap/bilag/:id/reverser", async (c) => {
    const id = uuid.parse(c.req.param("id"));
    const b = z.object({ tekst: z.string().trim().max(300).nullable().optional() }).parse(await c.req.json().catch(() => ({})));
    return c.json(
      await bruk(c, async (db) => {
        await krev(db, orgId(c));
        const bilag = await en<{ kilde: string }>(db, "select kilde from faktura.bilag where org_id = $1 and id = $2", [orgId(c), id]);
        if (!bilag) throw new ApiFeil(404, "Fant ikke bilaget");
        const fn: Record<string, string> = { anlegg: "reverser_anlegg", periodisering: "reverser_periodisering", manuell: "reverser_manuelt" };
        if (bilag.kilde === "lonn") throw new ApiFeil(409, "Et lønnsbilag reverseres ved å åpne lønnskjøringen igjen (Lønn → Lønnskjøringer)");
        if (bilag.kilde === "nav_refusjon") throw new ApiFeil(409, "En refusjon fra NAV reverseres ved å slette den (Lønn → Sykepenger)");
        if (!fn[bilag.kilde]) throw new ApiFeil(409, "Bilaget kan ikke reverseres her");
        const ny = await en<{ id: string }>(db, `select faktura.${fn[bilag.kilde]}($1, $2, $3) as id`, [orgId(c), id, b.tekst ?? null]);
        return (await hentRegnskapsbilag(db, orgId(c), { id: ny!.id }))[0]!;
      }),
      201,
    );
  });

  r.get("/regnskap/saldobalanse", async (c) => {
    const { fra, til } = standardPeriode(periodeS.parse(c.req.query()));
    return c.json(
      await bruk(c, async (db) => {
        await krev(db, orgId(c));
        return saldobalanse(db, orgId(c), fra, til);
      }),
    );
  });

  r.get("/regnskap/hovedbok", async (c) => {
    const q = periodeS.extend({ konto: z.string().regex(/^\d{4,6}$/).optional() }).parse(c.req.query());
    const { fra, til } = standardPeriode(q);
    return c.json(
      await bruk(c, async (db) => {
        await krev(db, orgId(c));
        return { fra, til, kontoer: await hovedbok(db, orgId(c), fra, til, q.konto ?? null) };
      }),
    );
  });

  // Kontoene med navn (de vanlige og de som er brukt), til skjemaet for manuelle bilag.
  r.get("/regnskap/kontoliste", async (c) =>
    c.json(
      await bruk(c, async (db) => {
        await krev(db, orgId(c));
        const navn = await navnPaaKonto(db, orgId(c));
        const brukt = await db.query<{ konto: string }>(
          "select distinct p.konto from faktura.posteringer p join faktura.bilag b on b.org_id = p.org_id and b.id = p.bilag_id where b.org_id = $1",
          [orgId(c)],
        );
        const alle_ = [...new Set([...Object.keys(STANDARDKONTOER), ...brukt.rows.map((x) => x.konto)])].sort();
        return { kontoer: alle_.map((k) => ({ konto: k, navn: navn(k) })) };
      }),
    ),
  );

  return r;
}
