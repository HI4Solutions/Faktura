// Fakturaene og innbetalingene i regnskapet (0089_regnskap_salg.sql). Hver faktura og kreditnota får
// et bilag i serie F på fakturadatoen: kundefordringen mot salgsinntekten og den utgående avgiften per
// mva-sats, med mva-koden fra Skatteetatens standard mva-koder for SAF-T (3, 31, 32 og 33 med avgift,
// 5 fritatt og 6 utenfor merverdiavgiftsloven; uten mva-registrering ingen kode). Hver innbetaling og
// refusjon får et bilag i serie B på betalingsdatoen: banken mot kundefordringen, og det som er
// betalt utover fakturaen, som purregebyr så langt fakturaen er purret med gebyr (resten står som
// kundens tilgode på kundefordringen til det betales tilbake).
//
// Workeren bokfører det som mangler, hvert minutt, og regnskapet gjør det når det vises; en faktura
// eller betaling som er slettet, får bilaget reversert. Det som er fra før startdatoen
// (regnskap_oppsett.salg_fra), bokføres ikke: det hører til den inngående balansen (flyttes datoen
// fram, reverseres det som er bokført før den, og flyttes den tilbake, bokføres det på nytt).
import { alle, en, somSystem, type Db } from "./db.js";
import { hentRegnskapsoppsett, regnskapskontoer, type Regnskapsrolle } from "./anlegg.js";

export type Salgspostering = { konto: string; belop: number; tekst: string; mva_kode: string | null };

const rund = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const logg = (severity: string, message: string, data: Record<string, unknown> = {}) => console.log(JSON.stringify({ severity, message, ...data }));
const prosent = (n: number) => `${n.toLocaleString("nb-NO", { maximumFractionDigits: 2 })} %`;

// Satsen gir kontoen for salget og for avgiften og koden: høy (25 %), middels (15 %), råfisk
// (11,11 %) og lav (12 %, også eldre lave satser).
export function satsFor(sats: number): { salg: Regnskapsrolle; rolle: Regnskapsrolle; kode: string } {
  if (sats >= 20) return { salg: "salg", rolle: "utgaende_mva", kode: "3" };
  if (sats >= 13) return { salg: "salg_middels", rolle: "utgaende_mva_middels", kode: "31" };
  if (Math.abs(sats - 11.11) < 0.005) return { salg: "salg_rafisk", rolle: "utgaende_mva_rafisk", kode: "32" };
  return { salg: "salg_lav", rolle: "utgaende_mva_lav", kode: "33" };
}

// Linjene samlet per konto og kode (summene til øret), uten de som blir 0.
function samle(linjer: Salgspostering[]): Salgspostering[] {
  const per = new Map<string, Salgspostering>();
  for (const l of linjer) {
    const k = `${l.konto}|${l.mva_kode ?? ""}|${l.tekst}`;
    const x = per.get(k);
    if (x) x.belop = rund(x.belop + l.belop);
    else per.set(k, { ...l, belop: rund(l.belop) });
  }
  return [...per.values()].filter((l) => l.belop !== 0);
}

export type Fakturagrunnlag = {
  fakturanummer: number;
  type: "faktura" | "kreditnota";
  sum_inkl_mva: number;
  kunde: string;
  for_nummer: number | null; // fakturaen en kreditnota krediterer
  mva_registrert: boolean;
  linjer: { mva_sats: number; eks: number; mva: number }[];
};

// Bilaget for en faktura eller kreditnota (kreditnotaen har negative beløp, så alt snus).
export function fakturabilag(f: Fakturagrunnlag, kontoer: Record<Regnskapsrolle, string>, utenMva: "unntatt" | "fritatt") {
  const navn = f.type === "kreditnota" ? "Kreditnota" : "Faktura";
  const tekst = `${navn} ${f.fakturanummer} ${f.kunde}${f.for_nummer ? ` (faktura ${f.for_nummer})` : ""}`.trim();
  const linjer: Salgspostering[] = [{ konto: kontoer.kundefordringer, belop: f.sum_inkl_mva, tekst: `${f.kunde}, ${navn.toLowerCase()} ${f.fakturanummer}`.trim(), mva_kode: null }];
  for (const l of f.linjer) {
    const sats = Number(l.mva_sats);
    if (!f.mva_registrert) {
      linjer.push({ konto: kontoer.salg_unntatt, belop: -Number(l.eks), tekst: "Salg", mva_kode: null });
    } else if (sats === 0) {
      const fritatt = utenMva === "fritatt";
      linjer.push({ konto: fritatt ? kontoer.salg_fritatt : kontoer.salg_unntatt, belop: -Number(l.eks), tekst: fritatt ? "Salg fritatt for mva" : "Salg uten mva", mva_kode: fritatt ? "5" : "6" });
    } else {
      const s = satsFor(sats);
      linjer.push({ konto: kontoer[s.salg], belop: -Number(l.eks), tekst: `Salg ${prosent(sats)} mva`, mva_kode: s.kode });
      if (Number(l.mva)) linjer.push({ konto: kontoer[s.rolle], belop: -Number(l.mva), tekst: `Utgående mva ${prosent(sats)}`, mva_kode: s.kode });
    }
  }
  return { tekst, posteringer: samle(linjer) };
}

// Bilaget for en innbetaling (eller en refusjon, med negativt beløp): gebyr er det av beløpet som er
// purregebyr.
export function betalingsbilag(
  b: { type: "betaling" | "refusjon"; belop: number; fakturanummer: number; kunde: string },
  gebyr: number,
  kontoer: Record<Regnskapsrolle, string>,
) {
  const refusjon = b.type === "refusjon";
  const tekst = `${refusjon ? "Refusjon" : "Innbetaling"} faktura ${b.fakturanummer} ${b.kunde}`.trim();
  return {
    tekst,
    posteringer: samle([
      { konto: kontoer.bank, belop: b.belop, tekst: refusjon ? "Betalt tilbake" : "Innbetalt", mva_kode: null },
      { konto: kontoer.kundefordringer, belop: -rund(b.belop - gebyr), tekst: `${b.kunde}, faktura ${b.fakturanummer}`.trim(), mva_kode: null },
      { konto: kontoer.purregebyr, belop: -gebyr, tekst: "Purregebyr", mva_kode: null },
    ]),
  };
}

// Det av betalingen som er purregebyr: det som er betalt utover fakturaen (det som står igjen etter
// kreditnotaene), så langt gebyrene på purringene ikke er bokført på de andre innbetalingene.
export function gebyrAvBetaling(b: { belop: number }, forfor: number, aaBetale: number, gebyrer: number, gebyrBokfort: number) {
  const utover = Math.max(0, forfor + b.belop - aaBetale) - Math.max(0, forfor - aaBetale);
  return rund(Math.max(0, Math.min(utover, gebyrer - gebyrBokfort)));
}

export type Gebyrgrunnlag = {
  sum: number; // fakturaens sum inkl. mva
  gebyrer: number; // gebyrene på purringene
  betalinger: { id: string; dato: string; belop: number }[]; // innbetalingene (ikke refusjonene), i rekkefølge
  kreditnotaer: { dato: string; belop: number }[]; // negative beløp
};

// Purregebyret i hver innbetaling på en faktura, i den rekkefølgen de er betalt: det som er igjen å
// betale, er fakturaen minus kreditnotaene til og med betalingsdatoen. Det samme hver gang, uansett
// når betalingene bokføres (og for dem før startdatoen, som hører til den inngående balansen).
export function gebyrPerBetaling(g: Gebyrgrunnlag): Map<string, number> {
  const ut = new Map<string, number>();
  let forfor = 0;
  let brukt = 0;
  for (const b of g.betalinger) {
    const aaBetale = rund(g.sum + g.kreditnotaer.filter((k) => k.dato <= b.dato).reduce((s, k) => s + k.belop, 0));
    const gebyr = gebyrAvBetaling(b, forfor, aaBetale, g.gebyrer, brukt);
    ut.set(b.id, gebyr);
    brukt = rund(brukt + gebyr);
    forfor = rund(forfor + b.belop);
  }
  return ut;
}

// Grunnlaget for gebyrene per faktura.
async function gebyrgrunnlag(db: Db, fakturaer: string[]): Promise<Map<string, Gebyrgrunnlag>> {
  const rader = fakturaer.length
    ? await alle<Gebyrgrunnlag & { id: string }>(
        db,
        `select f.id, f.sum_inkl_mva::float8 as sum,
                coalesce((select sum(r.gebyr) from faktura.purringer r where r.faktura_id = f.id), 0)::float8 as gebyrer,
                coalesce((select json_agg(json_build_object('id', x.id, 'dato', to_char(x.betalt_dato, 'YYYY-MM-DD'), 'belop', x.belop::float8)
                                          order by x.betalt_dato, x.opprettet, x.id)
                            from faktura.betalinger x where x.faktura_id = f.id and x.type = 'betaling'), '[]') as betalinger,
                coalesce((select json_agg(json_build_object('dato', to_char(k.fakturadato, 'YYYY-MM-DD'), 'belop', k.sum_inkl_mva::float8))
                            from faktura.fakturaer k where k.kreditnota_for = f.id and k.status <> 'utkast'), '[]') as kreditnotaer
           from faktura.fakturaer f where f.id = any($1::uuid[])`,
        [fakturaer],
      )
    : [];
  return new Map(rader.map((r) => [r.id, r]));
}

// Kundefordringene ved startdatoen: fakturaene og kreditnotaene før datoen, minus det som er betalt
// og betalt tilbake før den, men uten den delen av innbetalingene som er purregebyr (inntekt, ikke
// fordring). Det som hører til den inngående balansen på kundefordringene.
export async function kundefordringerVedStart(db: Db, org: string, dato: string) {
  const s = (await en<{ fakturert: number; betalt: number }>(
    db,
    `select coalesce((select sum(f.sum_inkl_mva) from faktura.fakturaer f where f.org_id = $1 and f.status <> 'utkast' and f.fakturadato < $2::date), 0)::float8 as fakturert,
            coalesce((select sum(p.belop) from faktura.betalinger p where p.org_id = $1 and p.betalt_dato < $2::date), 0)::float8 as betalt`,
    [org, dato],
  ))!;
  // Gebyrer kan bare være i innbetalingene på purrede fakturaer.
  const purret = await alle<{ id: string }>(
    db,
    `select distinct p.faktura_id as id from faktura.betalinger p
      where p.org_id = $1 and p.type = 'betaling' and p.betalt_dato < $2::date
        and exists (select 1 from faktura.purringer r where r.faktura_id = p.faktura_id and r.gebyr > 0)`,
    [org, dato],
  );
  let gebyr = 0;
  for (const g of (await gebyrgrunnlag(db, purret.map((p) => p.id))).values()) {
    const per = gebyrPerBetaling(g);
    for (const b of g.betalinger) if (b.dato < dato) gebyr += per.get(b.id) ?? 0;
  }
  return rund(s.fakturert - s.betalt + gebyr);
}

const FAKTURAER = `
  select f.id, f.fakturanummer::int as fakturanummer, f.type, to_char(f.fakturadato, 'YYYY-MM-DD') as dato, f.sum_inkl_mva::float8 as sum_inkl_mva,
         coalesce(f.kunde ->> 'navn', k.navn, '') as kunde, coalesce((f.selger ->> 'mva_registrert')::boolean, o.mva_registrert) as mva_registrert,
         (select x.fakturanummer::int from faktura.fakturaer x where x.id = f.kreditnota_for) as for_nummer
    from faktura.fakturaer f
    join faktura.kunder k on k.id = f.kunde_id
    join faktura.organisasjoner o on o.id = f.org_id
   where f.org_id = $1 and f.status <> 'utkast' and f.sum_inkl_mva <> 0 and ($2::date is null or f.fakturadato >= $2::date)
     and not exists (select 1 from faktura.bilag b where b.kilde_id = f.id and b.kilde = 'faktura' and b.org_id = f.org_id
                        and b.reverserer is null and b.reversert_av is null)
   order by f.fakturadato, f.fakturanummer
   limit $3`;
const BETALINGER = `
  select p.id, p.faktura_id, p.type, p.belop::float8 as belop, to_char(p.betalt_dato, 'YYYY-MM-DD') as dato, f.fakturanummer::int as fakturanummer,
         coalesce(f.kunde ->> 'navn', '') as kunde
    from faktura.betalinger p join faktura.fakturaer f on f.id = p.faktura_id
   where p.org_id = $1 and ($2::date is null or p.betalt_dato >= $2::date)
     and not exists (select 1 from faktura.bilag b where b.kilde_id = p.id and b.kilde = 'innbetaling' and b.org_id = p.org_id
                        and b.reverserer is null and b.reversert_av is null)
   order by p.betalt_dato, p.opprettet, p.id
   limit $3`;
// Gjeldende bilag for en faktura eller betaling som er slettet, eller som er fra før startdatoen.
const AA_REVERSERE = `
  select b.id from faktura.bilag b
   where b.org_id = $1 and b.kilde in ('faktura', 'innbetaling') and b.reverserer is null and b.reversert_av is null
     and (b.dato < $2::date
       or (b.kilde = 'faktura' and not exists (select 1 from faktura.fakturaer f where f.id = b.kilde_id))
       or (b.kilde = 'innbetaling' and not exists (select 1 from faktura.betalinger p where p.id = b.kilde_id)))
   order by b.dato, b.serie, b.nummer`;

// Hvert bilag for seg (et som ikke går, stopper ikke de andre).
async function hvert(db: Db, fn: () => Promise<unknown>, data: Record<string, unknown>): Promise<boolean> {
  await db.query("savepoint salg");
  try {
    await fn();
    await db.query("release savepoint salg");
    return true;
  } catch (e) {
    await db.query("rollback to savepoint salg");
    // Bokført samtidig av en annen: ingenting å gjøre.
    if (["23505", "FA409"].includes((e as { code?: string }).code ?? "")) return false;
    logg("WARNING", "Ble ikke bokført", { ...data, feil: (e as Error).message });
    return false;
  }
}

// Bokfører fakturaene og innbetalingene som mangler for organisasjonen (høyst maks av hver), og
// reverserer bilagene for det som er slettet eller fra før startdatoen.
export async function bokforSalg(db: Db, org: string, maks = 300) {
  const o = await hentRegnskapsoppsett(db, org);
  const kontoer = regnskapskontoer(o);
  const svar = { fakturaer: 0, betalinger: 0, reversert: 0 };

  for (const { id } of await alle<{ id: string }>(db, AA_REVERSERE, [org, o.salg_fra]))
    if (await hvert(db, () => db.query("select faktura.reverser_salg($1, $2)", [org, id]), { org, bilag: id })) svar.reversert++;

  const fakturaer = await alle<Omit<Fakturagrunnlag, "linjer"> & { id: string; dato: string }>(db, FAKTURAER, [org, o.salg_fra, maks]);
  const linjer = fakturaer.length
    ? await alle<{ faktura_id: string; mva_sats: number; eks: number; mva: number }>(
        db,
        `select faktura_id, mva_sats::float8 as mva_sats, coalesce(sum(belop_eks), 0)::float8 as eks, coalesce(sum(mva_belop), 0)::float8 as mva
           from faktura.faktura_linjer where faktura_id = any($1::uuid[]) group by 1, 2 order by 1, 2 desc`,
        [fakturaer.map((f) => f.id)],
      )
    : [];
  for (const f of fakturaer) {
    const b = fakturabilag({ ...f, linjer: linjer.filter((l) => l.faktura_id === f.id) }, kontoer, o.uten_mva);
    if (
      await hvert(db, () => db.query("select faktura.bokfor_salg($1, 'faktura', $2, $3, $4, $5::jsonb)", [org, f.id, f.dato, b.tekst, JSON.stringify(b.posteringer)]), {
        org,
        faktura: f.id,
      })
    )
      svar.fakturaer++;
  }

  const betalinger = await alle<{ id: string; faktura_id: string; type: "betaling" | "refusjon"; belop: number; dato: string; fakturanummer: number; kunde: string }>(
    db,
    BETALINGER,
    [org, o.salg_fra, maks],
  );
  // Purregebyrene: det samme for hver betaling hver gang (gebyrPerBetaling), men aldri mer enn det
  // som er igjen av gebyrene etter det som er bokført på de andre innbetalingene og det som er i
  // innbetalingene før startdatoen.
  const grunnlag = await gebyrgrunnlag(db, [...new Set(betalinger.filter((p) => p.type === "betaling").map((p) => p.faktura_id))]);
  for (const p of betalinger) {
    let gebyr = 0;
    const g = grunnlag.get(p.faktura_id);
    if (p.type === "betaling" && g && g.gebyrer > 0) {
      const per = gebyrPerBetaling(g);
      const forStart = o.salg_fra ? g.betalinger.filter((x) => x.dato < o.salg_fra!).reduce((s, x) => s + (per.get(x.id) ?? 0), 0) : 0;
      const bokfort = Number(
        (await en<{ n: number }>(
          db,
          `select coalesce(-sum(q.belop), 0)::float8 as n from faktura.posteringer q join faktura.bilag b on b.id = q.bilag_id
            where b.org_id = $1 and b.kilde = 'innbetaling' and b.reverserer is null and b.reversert_av is null and q.konto = $2
              and b.kilde_id in (select x.id from faktura.betalinger x where x.faktura_id = $3 and x.id <> $4)`,
          [org, kontoer.purregebyr, p.faktura_id, p.id],
        ))?.n ?? 0,
      );
      gebyr = rund(Math.max(0, Math.min(per.get(p.id) ?? 0, g.gebyrer - bokfort - forStart)));
    }
    const b = betalingsbilag(p, gebyr, kontoer);
    if (
      await hvert(db, () => db.query("select faktura.bokfor_salg($1, 'innbetaling', $2, $3, $4, $5::jsonb)", [org, p.id, p.dato, b.tekst, JSON.stringify(b.posteringer)]), {
        org,
        betaling: p.id,
      })
    )
      svar.betalinger++;
  }
  return svar;
}

// Når regnskapet vises: det som mangler, bokføres først (for den som ser regnskapet; en feil
// stopper ikke visningen).
export async function bokforSalgNaa(db: Db, org: string) {
  if (!(await en<{ k: boolean }>(db, "select faktura.kan($1, 'regnskap') as k", [org]))?.k) return;
  await db.query("savepoint salg_naa");
  try {
    await bokforSalg(db, org);
    await db.query("release savepoint salg_naa");
  } catch (e) {
    await db.query("rollback to savepoint salg_naa");
    logg("WARNING", "Salget ble ikke bokført", { org, feil: (e as Error).message });
  }
}

// Workeren hvert minutt: organisasjonene med regnskapet slått på og noe som ikke er bokført (eller
// et bilag for noe som er slettet eller fra før startdatoen), hver i sin transaksjon. Slås
// regnskapet på senere, bokføres det som mangler da. org: bare én organisasjon (testene).
export async function bokforSalgForAlle(maksOrg = 25, org: string | null = null) {
  const orgs = await somSystem((db) =>
    alle<{ org_id: string }>(
      db,
      `select x.org_id from (
         select f.org_id from faktura.fakturaer f left join faktura.regnskap_oppsett r on r.org_id = f.org_id
          where f.status <> 'utkast' and f.sum_inkl_mva <> 0 and (r.salg_fra is null or f.fakturadato >= r.salg_fra)
            and not exists (select 1 from faktura.bilag b where b.kilde_id = f.id and b.kilde = 'faktura' and b.org_id = f.org_id
                               and b.reverserer is null and b.reversert_av is null)
         union
         select p.org_id from faktura.betalinger p left join faktura.regnskap_oppsett r on r.org_id = p.org_id
          where (r.salg_fra is null or p.betalt_dato >= r.salg_fra)
            and not exists (select 1 from faktura.bilag b where b.kilde_id = p.id and b.kilde = 'innbetaling' and b.org_id = p.org_id
                               and b.reverserer is null and b.reversert_av is null)
         union
         select b.org_id from faktura.bilag b left join faktura.regnskap_oppsett r on r.org_id = b.org_id
          where b.kilde in ('faktura', 'innbetaling') and b.reverserer is null and b.reversert_av is null
            and (b.dato < r.salg_fra
              or (b.kilde = 'faktura' and not exists (select 1 from faktura.fakturaer f where f.id = b.kilde_id))
              or (b.kilde = 'innbetaling' and not exists (select 1 from faktura.betalinger p where p.id = b.kilde_id)))
       ) x join faktura.organisasjoner o on o.id = x.org_id
       where o.slettet_at is null and ($2::uuid is null or x.org_id = $2) and faktura.har_funksjon(x.org_id, 'regnskap')
       -- Tilfeldig rekkefølge: en organisasjon med noe som ikke går å bokføre, stenger ikke for de andre.
       order by random()
       limit $1`,
      [maksOrg, org],
    ),
  );
  const sum = { fakturaer: 0, betalinger: 0, reversert: 0 };
  for (const { org_id } of orgs) {
    try {
      const r = await somSystem((db) => bokforSalg(db, org_id));
      sum.fakturaer += r.fakturaer;
      sum.betalinger += r.betalinger;
      sum.reversert += r.reversert;
    } catch (e) {
      logg("ERROR", "Bokføringen av salget feilet", { org: org_id, feil: (e as Error).message });
    }
  }
  return sum;
}
