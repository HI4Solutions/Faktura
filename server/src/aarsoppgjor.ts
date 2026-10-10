// Årsoppgjøret og periodelåsen (0094_aarsoppgjor.sql, web/src/sider/RegnskapAarsoppgjor.tsx).
//
// Årsoppgjøret for et år: sjekklisten for året (det som gjenstår i månedsavslutningene: bankpostene,
// utgiftene, lønnen, avskrivningene, periodiseringene og merverdiavgiften), resultatregnskapet og
// balansen med fjoråret, og bilaget i serie Å den 31. desember: skattekostnaden og utbyttet når de er
// oppgitt, og overføringen av resten av årsresultatet til annen egenkapital (eller dekningen av
// underskuddet), så resultatkontoene går i null for året. Endres året etterpå, sier appen fra, og
// årsoppgjøret føres på nytt. Etterpå låses året: et bilag med dato i en låst periode føres på den
// første åpne dagen (databasen), og et manuelt bilag dit avvises.
import { Hono, type Context } from "hono";
import { z } from "zod";
import { hentRegnskapsoppsett, regnskapskontoer, type Regnskapsrolle } from "./anlegg.js";
import { alle, en, somBruker, type Db } from "./db.js";
import { ApiFeil } from "./feil.js";
import { maanedNavn } from "./lonnsberegning.js";
import { gjenstar, maanedsstatus, type Punkt } from "./maanedsavslutning.js";
import type { Rapportdef } from "./rapportmodul.js";
import { dato as visDato, kr } from "./regler.js";
import { bokforSalgNaa } from "./salgBokforing.js";

const rund = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const osloIDag = () => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Oslo" }).format(new Date());
const liste = (x: string[]) => (x.length > 1 ? `${x.slice(0, -1).join(", ")} og ${x.at(-1)}` : (x[0] ?? ""));

// --- Resultatregnskapet og balansen ------------------------------------------------------------------

// Linjene etter kontoklassene og -gruppene i norsk standard kontoplan (NS 4102). sum: summen av
// linjene over (driftsresultatet og så videre).
type Linjedef = { nokkel: string; navn: string; fra?: string; til?: string; sum?: string[] };
const RESULTATLINJER: Linjedef[] = [
  { nokkel: "inntekter", navn: "Driftsinntekter", fra: "3000", til: "3999" },
  { nokkel: "varekostnad", navn: "Varekostnad", fra: "4000", til: "4999" },
  { nokkel: "lonn", navn: "Lønnskostnad", fra: "5000", til: "5999" },
  { nokkel: "avskrivninger", navn: "Avskrivninger og nedskrivninger", fra: "6000", til: "6099" },
  { nokkel: "driftskostnader", navn: "Andre driftskostnader", fra: "6100", til: "7999" },
  { nokkel: "driftsresultat", navn: "Driftsresultat", sum: ["inntekter", "varekostnad", "lonn", "avskrivninger", "driftskostnader"] },
  { nokkel: "finansinntekter", navn: "Finansinntekter", fra: "8000", til: "8099" },
  { nokkel: "finanskostnader", navn: "Finanskostnader", fra: "8100", til: "8299" },
  { nokkel: "for_skatt", navn: "Resultat før skatt", sum: ["driftsresultat", "finansinntekter", "finanskostnader"] },
  { nokkel: "skatt", navn: "Skattekostnad", fra: "8300", til: "8399" },
  { nokkel: "andre", navn: "Andre resultatposter", fra: "8400", til: "8799" },
  { nokkel: "aarsresultat", navn: "Årsresultat", sum: ["for_skatt", "skatt", "andre"] },
  { nokkel: "disponeringer", navn: "Overføringer og disponeringer", fra: "8800", til: "8999" },
];
const BALANSELINJER: Linjedef[] = [
  { nokkel: "anleggsmidler", navn: "Anleggsmidler", fra: "1000", til: "1399" },
  { nokkel: "varer", navn: "Varer", fra: "1400", til: "1499" },
  { nokkel: "fordringer", navn: "Fordringer", fra: "1500", til: "1799" },
  { nokkel: "investeringer", navn: "Investeringer", fra: "1800", til: "1899" },
  { nokkel: "bank", navn: "Bankinnskudd og kontanter", fra: "1900", til: "1999" },
  { nokkel: "eiendeler", navn: "Sum eiendeler", sum: ["anleggsmidler", "varer", "fordringer", "investeringer", "bank"] },
  { nokkel: "egenkapital", navn: "Egenkapital", fra: "2000", til: "2099" },
  { nokkel: "udisponert", navn: "Resultat som ikke er disponert" },
  { nokkel: "langsiktig", navn: "Langsiktig gjeld", fra: "2100", til: "2299" },
  { nokkel: "kortsiktig", navn: "Kortsiktig gjeld", fra: "2300", til: "2999" },
  { nokkel: "ek_gjeld", navn: "Sum egenkapital og gjeld", sum: ["egenkapital", "udisponert", "langsiktig", "kortsiktig"] },
];
export type Linje = { nokkel: string; navn: string; belop: number; fjor: number; sum: boolean };

const iOmraade = (konto: string, fra: string, til: string) => konto.slice(0, 4) >= fra && konto.slice(0, 4) <= til;
const sumOver = (s: Map<string, number>, fra: string, til: string) => rund([...s].reduce((sum, [konto, b]) => (iOmraade(konto, fra, til) ? sum + b : sum), 0));

// Summen per konto (debet positivt) for bilagene datert i perioden (fra kan være null: fra starten),
// eventuelt uten årsoppgjørsbilaget for året.
async function kontosummer(db: Db, org: string, fra: string | null, til: string, utenAarsoppgjor = false) {
  const r = await alle<{ konto: string; sum: number }>(
    db,
    `select p.konto, sum(p.belop)::float8 as sum
       from faktura.posteringer p join faktura.bilag b on b.org_id = p.org_id and b.id = p.bilag_id
      where b.org_id = $1 and ($2::date is null or b.dato >= $2::date) and b.dato <= $3::date and (not $4 or b.kilde <> 'aarsoppgjor')
      group by p.konto`,
    [org, fra, til, utenAarsoppgjor],
  );
  return new Map(r.map((x) => [x.konto, rund(x.sum)]));
}

// Linjene for to perioder: inntekter og gjeld positivt (kredit), kostnader og eiendeler som de er i
// balansen (resultatet: kredit positivt; balansen: eiendelene debet positivt, egenkapitalen og gjelden
// kredit positivt).
function linjer(defs: Linjedef[], verdi: (d: Linjedef) => [number, number]): Linje[] {
  const ut: Linje[] = [];
  const per = new Map<string, [number, number]>();
  for (const d of defs) {
    const v: [number, number] = d.sum
      ? [rund(d.sum.reduce((s, n) => s + (per.get(n)?.[0] ?? 0), 0)), rund(d.sum.reduce((s, n) => s + (per.get(n)?.[1] ?? 0), 0))]
      : verdi(d);
    per.set(d.nokkel, v);
    ut.push({ nokkel: d.nokkel, navn: d.navn, belop: v[0], fjor: v[1], sum: Boolean(d.sum) });
  }
  return ut;
}

// Resultatregnskapet for perioden (og samme periode året før).
export async function resultatregnskap(db: Db, org: string, fra: string, til: string) {
  await bokforSalgNaa(db, org);
  const fjor = (d: string) => `${Number(d.slice(0, 4)) - 1}${d.slice(4)}`.replace(/-02-29$/, "-02-28");
  const [naa, foer] = await Promise.all([kontosummer(db, org, fra, til), kontosummer(db, org, fjor(fra), fjor(til))]);
  return linjer(RESULTATLINJER, (d) => [-sumOver(naa, d.fra!, d.til!), -sumOver(foer, d.fra!, d.til!)]);
}

// Balansen ved datoen (og samme dato året før). Resultatet som ikke er ført mot egenkapitalen
// (årsoppgjøret), står på en egen linje, så balansen går opp.
export async function balanse(db: Db, org: string, til: string) {
  await bokforSalgNaa(db, org);
  const fjor = `${Number(til.slice(0, 4)) - 1}${til.slice(4)}`.replace(/-02-29$/, "-02-28");
  const [naa, foer] = await Promise.all([kontosummer(db, org, null, til), kontosummer(db, org, null, fjor)]);
  const udisponert = (s: Map<string, number>) => -sumOver(s, "3000", "8999");
  return linjer(BALANSELINJER, (d) =>
    d.nokkel === "udisponert"
      ? [udisponert(naa), udisponert(foer)]
      : d.fra! < "2000"
        ? [sumOver(naa, d.fra!, d.til!), sumOver(foer, d.fra!, d.til!)]
        : [-sumOver(naa, d.fra!, d.til!), -sumOver(foer, d.fra!, d.til!)],
  );
}

// --- Årsoppgjøret ----------------------------------------------------------------------------------

export type Postering = { konto: string; belop: number; tekst: string };

// Bilaget for årsoppgjøret fra summene for året (uten årsoppgjørsbilaget): skattekostnaden og
// utbyttet som er oppgitt, og overføringen av resten av årsresultatet til annen egenkapital.
// Disponeringer som er ført i andre bilag (8800–8999), er trukket fra.
export function disponering(s: Map<string, number>, k: Record<Regnskapsrolle, string>, skatt: number, utbytte: number) {
  const resultat = -sumOver(s, "3000", "8799");
  const disponert = sumOver(s, "8800", "8999");
  const aarsresultat = rund(resultat - skatt);
  const overforing = rund(aarsresultat - utbytte - disponert);
  const p: Postering[] = [];
  if (skatt) p.push({ konto: k.skattekostnad, belop: skatt, tekst: "Betalbar skatt" }, { konto: k.betalbar_skatt, belop: -skatt, tekst: "Betalbar skatt" });
  if (utbytte) p.push({ konto: k.utbytte, belop: utbytte, tekst: "Avsatt utbytte" }, { konto: k.avsatt_utbytte, belop: -utbytte, tekst: "Avsatt utbytte" });
  if (overforing) {
    const tekst = overforing > 0 ? "Overført til annen egenkapital" : "Underskudd dekket av annen egenkapital";
    p.push({ konto: k.disponering, belop: overforing, tekst }, { konto: k.annen_egenkapital, belop: -overforing, tekst });
  }
  return { resultat, aarsresultat, overforing, disponert, posteringer: p };
}

const perKonto = (l: { konto: string; belop: number }[]) => {
  const m: Record<string, number> = {};
  for (const x of l) m[x.konto] = rund((m[x.konto] ?? 0) + x.belop);
  return Object.fromEntries(Object.entries(m).filter(([, v]) => v !== 0));
};
const like = (a: Record<string, number>, b: Record<string, number>) => {
  const x = Object.entries(a);
  return x.length === Object.keys(b).length && x.every(([k, v]) => b[k] === v);
};

async function aarsrad(db: Db, org: string, aar: number, lag = false) {
  if (lag) await db.query("insert into faktura.aarsoppgjor (org_id, aar) values ($1, $2) on conflict (org_id, aar) do nothing", [org, aar]);
  return en<{ id: string; skatt: number; utbytte: number }>(db, "select id, skatt::float8 as skatt, utbytte::float8 as utbytte from faktura.aarsoppgjor where org_id = $1 and aar = $2", [
    org,
    aar,
  ]);
}

async function gjeldende(db: Db, org: string, id: string | undefined) {
  if (!id) return null;
  const b = await en<{ id: string; bilagsnummer: string }>(
    db,
    `select id, serie || '-' || aar || '-' || nummer as bilagsnummer from faktura.bilag
      where org_id = $1 and kilde = 'aarsoppgjor' and kilde_id = $2 and reverserer is null and reversert_av is null`,
    [org, id],
  );
  if (!b) return null;
  const p = await alle<{ konto: string; belop: number }>(db, "select konto, belop::float8 as belop from faktura.posteringer where bilag_id = $1", [b.id]);
  return { ...b, kontoer: perKonto(p) };
}

export type Aarsstatus = {
  aar: number;
  over: boolean;
  laast_til: string | null;
  laast: boolean;
  punkter: Punkt[];
  resultat: Linje[];
  balanse: Linje[];
  oppgjor: {
    skatt: number;
    utbytte: number;
    resultat: number; // resultatet før skatten som oppgis
    aarsresultat: number;
    overforing: number;
    bilag: { id: string; bilagsnummer: string } | null;
    stemmer: boolean;
    trengs: boolean;
  };
};

// Det som gjenstår i månedsavslutningene for månedene i året som er over, samlet per punkt.
async function sjekkliste(db: Db, org: string, aar: number, iDag: string): Promise<Punkt[]> {
  const per = new Map<Punkt["nokkel"], { p: Punkt; mangler: string[]; tekst: string | null; lenke: string | null }>();
  for (let m = 1; m <= 12; m++) {
    const maaned = `${aar}-${String(m).padStart(2, "0")}`;
    if (`${maaned}-01` > iDag) break;
    for (const p of await maanedsstatus(db, org, maaned, iDag)) {
      if (p.nokkel === "aarsoppgjor") continue;
      const x = per.get(p.nokkel) ?? { p, mangler: [], tekst: null, lenke: null };
      if (gjenstar(p)) {
        x.mangler.push(maanedNavn(`${maaned}-01`).replace(/ \d{4}$/, ""));
        x.tekst ??= p.tekst;
        x.lenke ??= p.lenke;
      }
      per.set(p.nokkel, x);
    }
  }
  return [...per.values()].map(({ p, mangler, tekst, lenke }) => ({
    nokkel: p.nokkel,
    navn: p.navn,
    ok: !mangler.length,
    tekst: mangler.length ? `Gjenstår for ${liste(mangler)} (${tekst!.replace(/\.$/, "")}).` : "Ført for alle månedene.",
    lenke: lenke ?? p.lenke,
  }));
}

export async function aarsstatus(db: Db, org: string, aar: number, iDag = osloIDag(), medSjekkliste = true): Promise<Aarsstatus> {
  await bokforSalgNaa(db, org);
  const o = await hentRegnskapsoppsett(db, org);
  const k = regnskapskontoer(o);
  const til = `${aar}-12-31`;
  const rad = await aarsrad(db, org, aar);
  const opp = await gjeldende(db, org, rad?.id);
  const skatt = rad?.skatt ?? 0;
  const utbytte = rad?.utbytte ?? 0;
  const d = disponering(await kontosummer(db, org, `${aar}-01-01`, til, true), k, skatt, utbytte);
  const onsket = perKonto(d.posteringer);
  return {
    aar,
    over: til < iDag,
    laast_til: o.laast_til,
    laast: Boolean(o.laast_til && o.laast_til >= til),
    punkter: medSjekkliste ? await sjekkliste(db, org, aar, iDag) : [],
    resultat: await resultatregnskap(db, org, `${aar}-01-01`, til),
    balanse: await balanse(db, org, til),
    oppgjor: {
      skatt,
      utbytte,
      resultat: d.resultat,
      aarsresultat: d.aarsresultat,
      overforing: d.overforing,
      bilag: opp ? { id: opp.id, bilagsnummer: opp.bilagsnummer } : null,
      stemmer: opp ? like(onsket, opp.kontoer) : !d.posteringer.length,
      trengs: d.posteringer.length > 0,
    },
  };
}

// Fører årsoppgjøret (eller på nytt), med skattekostnaden og utbyttet. Gir bilaget, eller null når det
// stemte (eller ikke var noe å føre).
export async function bokforAarsoppgjor(db: Db, org: string, aar: number, v: { skatt?: number; utbytte?: number }, iDag = osloIDag()) {
  if (`${aar}-12-31` >= iDag) throw new ApiFeil(409, "Året er ikke over");
  await bokforSalgNaa(db, org);
  const rad = (await aarsrad(db, org, aar, true))!;
  const skatt = v.skatt ?? rad.skatt;
  const utbytte = v.utbytte ?? rad.utbytte;
  if (skatt !== rad.skatt || utbytte !== rad.utbytte)
    await db.query("update faktura.aarsoppgjor set skatt = $3, utbytte = $4, oppdatert = now() where org_id = $1 and id = $2", [org, rad.id, skatt, utbytte]);
  const k = regnskapskontoer(await hentRegnskapsoppsett(db, org));
  const d = disponering(await kontosummer(db, org, `${aar}-01-01`, `${aar}-12-31`, true), k, skatt, utbytte);
  const opp = await gjeldende(db, org, rad.id);
  if (!d.posteringer.length) {
    if (opp) await db.query("select faktura.angre_aarsoppgjor($1, $2)", [org, rad.id]);
    return null;
  }
  if (opp && like(perKonto(d.posteringer), opp.kontoer)) return null;
  const tekst = `Årsoppgjør ${aar}: ${d.aarsresultat >= 0 ? `årsresultat ${kr(d.aarsresultat)} kr` : `underskudd ${kr(-d.aarsresultat)} kr`}`;
  const id = (await en<{ id: string }>(db, "select faktura.bokfor_aarsoppgjor($1, $2, $3, $4::jsonb) as id", [org, rad.id, tekst, JSON.stringify(d.posteringer)]))!.id;
  return (await en<{ id: string; bilagsnummer: string }>(db, "select id, serie || '-' || aar || '-' || nummer as bilagsnummer from faktura.bilag where id = $1", [id]))!;
}

// Låser regnskapet til og med datoen (eller låser opp, med en tidligere dato eller null).
export async function settPeriodelas(db: Db, org: string, til: string | null, iDag = osloIDag()) {
  if (til && til >= iDag) throw new ApiFeil(400, "Perioden som låses, må være over");
  await db.query(
    `insert into faktura.regnskap_oppsett (org_id, laast_til) values ($1, $2)
     on conflict (org_id) do update set laast_til = excluded.laast_til, oppdatert = now()`,
    [org, til],
  );
}

// Kastes når et manuelt bilag føres i en låst periode (regnskapBilagRuter.ts).
export async function krevAapenPeriode(db: Db, org: string, dato: string) {
  const o = await hentRegnskapsoppsett(db, org);
  if (o.laast_til && dato <= o.laast_til)
    throw new ApiFeil(409, `Regnskapet er låst til og med ${visDato(o.laast_til)}; velg en senere dato (eller lås opp under Regnskap → Årsoppgjør)`);
}

// --- Rutene (under /api/org/:org) ------------------------------------------------------------------

const uuid = z.string().uuid();
const orgId = (c: Context) => uuid.parse(c.req.param("org"));
const bruk = <T>(c: Context, fn: (db: Db) => Promise<T>) => somBruker<T>(c.get("bruker").id, fn);
const krev = (db: Db, org: string) => db.query("select faktura.krev($1, 'regnskap')", [org]);
const aarS = z.coerce.number({ error: "Ugyldig år" }).int("Ugyldig år").min(2000, "Ugyldig år").max(2100, "Ugyldig år");
const belopS = z.number({ error: "Ugyldig beløp" }).finite().min(0, "Beløpet kan ikke være negativt").lt(1e11, "Beløpet er for stort");

export function aarsoppgjorRuter() {
  const r = new Hono();

  // Årsoppgjøret for året (standard: fjoråret når det har bilag, ellers i år).
  r.get("/regnskap/aarsoppgjor", async (c) => {
    const q = z.object({ aar: aarS.optional() }).parse(c.req.query());
    return c.json(
      await bruk(c, async (db) => {
        await krev(db, orgId(c));
        const iDag = osloIDag();
        const iAar = Number(iDag.slice(0, 4));
        let aar = q.aar ?? iAar - 1;
        if (!q.aar) {
          const har = await en<{ n: boolean }>(db, "select exists (select 1 from faktura.bilag where org_id = $1 and aar = $2) as n", [orgId(c), aar]);
          if (!har?.n) aar = iAar;
        }
        if (aar > iAar) throw new ApiFeil(400, "Året har ikke begynt");
        return aarsstatus(db, orgId(c), aar, iDag);
      }),
    );
  });

  // Fører årsoppgjøret (eller på nytt), med skattekostnaden og utbyttet.
  r.post("/regnskap/aarsoppgjor/:aar", async (c) => {
    const aar = aarS.parse(c.req.param("aar"));
    const b = z.object({ skatt: belopS.optional(), utbytte: belopS.optional() }).parse(await c.req.json().catch(() => ({})));
    return c.json(
      await bruk(c, async (db) => {
        await krev(db, orgId(c));
        const bilag = await bokforAarsoppgjor(db, orgId(c), aar, b);
        return { bilag, status: await aarsstatus(db, orgId(c), aar) };
      }),
      201,
    );
  });

  r.delete("/regnskap/aarsoppgjor/:aar", async (c) => {
    const aar = aarS.parse(c.req.param("aar"));
    return c.json(
      await bruk(c, async (db) => {
        await krev(db, orgId(c));
        const rad = await aarsrad(db, orgId(c), aar);
        if (!rad) throw new ApiFeil(409, "Årsoppgjøret er ikke bokført");
        await db.query("select faktura.angre_aarsoppgjor($1, $2)", [orgId(c), rad.id]);
        return aarsstatus(db, orgId(c), aar);
      }),
    );
  });

  // Periodelåsen: til og med datoen (null: lås opp alt).
  r.put("/regnskap/periodelas", async (c) => {
    const b = z
      .object({ til: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Ugyldig dato").nullable() })
      .parse(await c.req.json().catch(() => ({})));
    return c.json(
      await bruk(c, async (db) => {
        await krev(db, orgId(c));
        await settPeriodelas(db, orgId(c), b.til);
        return { laast_til: (await hentRegnskapsoppsett(db, orgId(c))).laast_til };
      }),
    );
  });

  return r;
}

// --- Rapportene ------------------------------------------------------------------------------------

const KOLONNER = (aar: number) => [
  { nokkel: "navn", navn: "Linje" },
  { nokkel: "belop", navn: String(aar), type: "kr" as const },
  { nokkel: "fjor", navn: String(aar - 1), type: "kr" as const },
];

export const aarsoppgjorRapporter: Rapportdef[] = [
  {
    id: "regnskap.resultat",
    modul: "regnskap",
    navn: "Resultatregnskap",
    beskrivelse:
      "Resultatregnskapet for perioden etter kontoklassene: driftsinntekter, kostnadene, driftsresultatet, finanspostene, skatten og årsresultatet, med samme periode året før.",
    funksjon: "regnskap",
    tilgang: "regnskap",
    parameter: "periode",
    maanedlig: true,
    hent: async (db, org, v) => {
      const l = await resultatregnskap(db, org, v.fra, v.til);
      const r = l.find((x) => x.nokkel === "aarsresultat")!;
      return {
        merknad: `Resultatet i perioden: ${kr(Math.abs(r.belop))} kr ${r.belop >= 0 ? "i overskudd" : "i underskudd"}. Inntektene er positive og kostnadene negative.`,
        kolonner: KOLONNER(Number(v.til.slice(0, 4))),
        rader: l.filter((x) => x.sum || x.belop || x.fjor).map((x) => ({ navn: x.navn, belop: x.belop, fjor: x.fjor })),
      };
    },
  },
  {
    id: "regnskap.balanse",
    modul: "regnskap",
    navn: "Balanse",
    beskrivelse:
      "Balansen ved slutten av perioden: anleggsmidlene, omløpsmidlene, egenkapitalen og gjelden, med resultatet som ikke er disponert, og samme dato året før.",
    funksjon: "regnskap",
    tilgang: "regnskap",
    parameter: "periode",
    maanedlig: true,
    hent: async (db, org, v) => {
      const l = await balanse(db, org, v.til);
      const e = l.find((x) => x.nokkel === "eiendeler")!;
      const g = l.find((x) => x.nokkel === "ek_gjeld")!;
      return {
        merknad: `Balansen ${visDato(v.til)}. ${e.belop === g.belop ? "Eiendelene er lik egenkapitalen og gjelden." : `Eiendelene og egenkapitalen og gjelden skiller ${kr(Math.abs(e.belop - g.belop))} kr.`}`,
        periode: visDato(v.til),
        kolonner: KOLONNER(Number(v.til.slice(0, 4))),
        rader: l.filter((x) => x.sum || x.belop || x.fjor).map((x) => ({ navn: x.navn, belop: x.belop, fjor: x.fjor })),
      };
    },
  },
];

