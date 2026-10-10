// AFP-premien til Fellesordningen (0098_afp.sql): det som er avsatt på slippene per kvartal (det
// fakturaen fra Fellesordningen bygger på; den kommer kvartalsvis etterskudd), og betalingene av
// fakturaene. Arbeidsgiveravgiften av AFP-premien følger innbetalingen (avgiftsplikten knytter seg
// til den faktiske innbetalingen av premien): den regnes når betalingen registreres, med satsen for
// sonen (sone 1a: redusert sats til fribeløpet for året er brukt), og kommer i a-meldingen for
// måneden premien ble betalt (amelding.ts). OU-premien har ikke arbeidsgiveravgift.
//
// Hver betaling bokføres med et bilag i lønnsserien: den påløpte premien (når lønnsbilagene avsetter
// den) eller kostnaden mot banken, og avgiften mot skyldig arbeidsgiveravgift. En betaling som
// slettes, reverseres. Eier og administrator registrerer og sletter; de som ser lønnen, ser
// oversikten og rapporten «AFP og OU».
import { Hono, type Context } from "hono";
import { z } from "zod";
import { alle, en, somBruker, type Db } from "./db.js";
import { ApiFeil } from "./feil.js";
import { hentBokforingsoppsett, kontoplan, type Bokforingsoppsett, type Kontorolle } from "./lonnBokforing.js";
import { AGA_FULL, arbeidsgiveravgift, rund } from "./lonnsberegning.js";
import type { Rapportdef } from "./rapportmodul.js";

const uuid = z.string().uuid();
const orgId = (c: Context) => uuid.parse(c.req.param("org"));
const bruk = <T>(c: Context, fn: (db: Db) => Promise<T>) => somBruker<T>(c.get("bruker").id, fn);
const datoS = z.string({ error: "Velg datoen" }).regex(/^\d{4}-\d{2}-\d{2}$/, "Ugyldig dato");
const krTekst = (n: number) => `${n.toLocaleString("nb-NO", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).replace(/[  ]/g, " ")} kr`;

export const kvartalNavn = (aar: number, kvartal: number) => `${kvartal}. kvartal ${aar}`;
// Kvartalet en dato (ÅÅÅÅ-MM-DD eller ÅÅÅÅ-MM) er i, og første og siste dag i et kvartal.
export const kvartalFor = (dato: string) => ({ aar: Number(dato.slice(0, 4)), kvartal: Math.floor((Number(dato.slice(5, 7)) - 1) / 3) + 1 });
export const kvartalFra = (aar: number, kvartal: number) => `${aar}-${String((kvartal - 1) * 3 + 1).padStart(2, "0")}-01`;
export const kvartalTil = (aar: number, kvartal: number) => new Date(Date.UTC(aar, kvartal * 3, 0)).toISOString().slice(0, 10);
// Kvartalet før.
export const forrigeKvartal = (aar: number, kvartal: number) => (kvartal === 1 ? { aar: aar - 1, kvartal: 4 } : { aar, kvartal: kvartal - 1 });

// Teksten på bilaget: «AFP- og OU-premie 3. kvartal 2026 (Fellesordningen)».
export const bilagstekst = (b: { aar: number; kvartal: number; afp: number; ou: number }) =>
  `${b.afp > 0 && b.ou > 0 ? "AFP- og OU-premie" : b.ou > 0 ? "OU-premie" : "AFP-premie"} ${kvartalNavn(b.aar, b.kvartal)} (Fellesordningen)`;

// Posteringene i bilaget for en betaling (kroner, debet positivt; går i null): den påløpte premien
// (med avsetning) eller kostnaden mot banken, og avgiften av AFP-premien mot skyldig avgift.
export function premiebilag(b: { afp: number; ou: number; aga: number }, o: Pick<Bokforingsoppsett, "kontoer" | "afp">, tekst: string) {
  const k = kontoplan(o);
  const ore = (n: number) => Math.round(Number(n) * 100);
  const p: { konto: string; belop: number; tekst: string }[] = [];
  const legg = (rolle: Kontorolle, belopOre: number, t: string) => {
    if (belopOre !== 0) p.push({ konto: k[rolle], belop: belopOre / 100, tekst: t });
  };
  const afp = ore(b.afp);
  const ou = ore(b.ou);
  const aga = ore(b.aga);
  if (o.afp) legg("paalopt_afp", afp + ou, "AFP- og OU-premie betalt");
  else {
    legg("afp", afp, "AFP-premie");
    legg("ou", ou, "OU-premie");
  }
  legg("bank", -(afp + ou), tekst);
  legg("aga", aga, "Arbeidsgiveravgift av AFP-premien");
  legg("skyldig_aga", -aga, "Arbeidsgiveravgift av AFP-premien");
  return p;
}

// Fribeløpet i sone 1a som er brukt i året (per foretak): den sparte avgiften i godkjente kjøringer
// (utenom en) og på premiene som er betalt, i sone 1a (sonen på slippen og premien, 0101; eldre
// har sonen i lønnsoppsettet).
export async function fribelopBrukt(db: Db, org: string, aar: number, utenomKjoring: string | null = null) {
  const r = await en<{ n: number }>(
    db,
    `with o as (select coalesce((select aga_sone from faktura.lonn_oppsett where org_id = $1), '1') as sone)
     select (coalesce((select sum(s.aga_grunnlag * ${AGA_FULL} / 100 - s.aga)
                         from faktura.lonnsslipper s join faktura.lonnskjoringer k on k.id = s.kjoring_id
                        where s.org_id = $1 and k.status = 'godkjent' and k.id is distinct from $3::uuid
                          and coalesce(s.aga_sone, (select sone from o)) = '1a'
                          and k.utbetalingsdato between $2::date and ($2::date + interval '1 year' - interval '1 day')::date), 0)
           + coalesce((select sum(p.afp * ${AGA_FULL} / 100 - p.aga) from faktura.afp_premier p
                        where p.org_id = $1 and coalesce(p.aga_sone, (select sone from o)) = '1a'
                          and p.dato between $2::date and ($2::date + interval '1 year' - interval '1 day')::date), 0))::float8 as n`,
    [org, `${aar}-01-01`, utenomKjoring],
  );
  return Number(r?.n ?? 0);
}

// Arbeidsgiveravgiften av en AFP-premie som betales på datoen, i sonen til hovedvirksomheten.
export async function avgiftAvPremie(db: Db, org: string, afp: number, dato: string) {
  const o = await en<{ aga_sone: string }>(db, "select aga_sone from faktura.lonn_oppsett where org_id = $1", [org]);
  const sone = o?.aga_sone ?? "1";
  const brukt = sone === "1a" ? await fribelopBrukt(db, org, Number(dato.slice(0, 4))) : 0;
  return { ...arbeidsgiveravgift(sone, [afp], brukt)[0]!, sone };
}

export type Kvartal = {
  aar: number;
  kvartal: number;
  navn: string;
  ansatte: number;
  grunnlag: number;
  afp: number; // avsatt på slippene
  ou: number;
  betalt: { afp: number; ou: number; aga: number; antall: number };
};

// Det som er avsatt og betalt per kvartal i året.
export async function kvartaler(db: Db, org: string, aar: number): Promise<Kvartal[]> {
  const avsatt = await alle<{ kvartal: number; ansatte: number; grunnlag: number; afp: number; ou: number }>(
    db,
    `select extract(quarter from k.utbetalingsdato)::int as kvartal, count(distinct s.ansatt_id) filter (where s.afp > 0 or s.ou > 0)::int as ansatte,
            sum(s.afp_grunnlag)::float8 as grunnlag, sum(s.afp)::float8 as afp, sum(s.ou)::float8 as ou
       from faktura.lonnsslipper s join faktura.lonnskjoringer k on k.id = s.kjoring_id
      where s.org_id = $1 and k.status = 'godkjent' and k.utbetalingsdato between $2::date and $3::date
      group by 1`,
    [org, `${aar}-01-01`, `${aar}-12-31`],
  );
  const betalt = await alle<{ kvartal: number; afp: number; ou: number; aga: number; antall: number }>(
    db,
    "select kvartal, sum(afp)::float8 as afp, sum(ou)::float8 as ou, sum(aga)::float8 as aga, count(*)::int as antall from faktura.afp_premier where org_id = $1 and aar = $2 group by 1",
    [org, aar],
  );
  return [1, 2, 3, 4].map((kvartal) => {
    const a = avsatt.find((x) => x.kvartal === kvartal);
    const b = betalt.find((x) => x.kvartal === kvartal);
    return {
      aar,
      kvartal,
      navn: kvartalNavn(aar, kvartal),
      ansatte: a?.ansatte ?? 0,
      grunnlag: rund(Number(a?.grunnlag ?? 0)),
      afp: rund(Number(a?.afp ?? 0)),
      ou: rund(Number(a?.ou ?? 0)),
      betalt: { afp: rund(Number(b?.afp ?? 0)), ou: rund(Number(b?.ou ?? 0)), aga: rund(Number(b?.aga ?? 0)), antall: b?.antall ?? 0 },
    };
  });
}

export const BETALING = `
  select p.id, to_char(p.dato, 'YYYY-MM-DD') as dato, p.aar, p.kvartal, p.afp::float8 as afp, p.ou::float8 as ou, p.aga_sats::float8 as aga_sats,
         p.aga::float8 as aga, p.tekst, b.serie || '-' || b.aar || '-' || b.nummer as bilag, p.opprettet
    from faktura.afp_premier p
    left join faktura.bilag b on b.org_id = p.org_id and b.id = p.bilag_id`;

const skjema = z
  .object({
    dato: datoS,
    aar: z.number({ error: "Velg året" }).int().min(2000).max(2100),
    kvartal: z.number({ error: "Velg kvartalet" }).int().min(1, "Velg kvartalet").max(4, "Velg kvartalet"),
    afp: z.number({ error: "Skriv AFP-premien" }).min(0, "Beløpet kan ikke være negativt").lt(100_000_000, "Beløpet er for stort"),
    ou: z.number().min(0, "Beløpet kan ikke være negativt").lt(10_000_000, "Beløpet er for stort").optional(),
    tekst: z.string().trim().max(200, "Teksten kan være høyst 200 tegn").nullable().optional(),
  })
  .refine((b) => b.afp + (b.ou ?? 0) > 0, { message: "Skriv beløpet som er betalt" })
  .refine((b) => b.dato >= kvartalFra(b.aar, b.kvartal), { message: "Premien for kvartalet kan ikke være betalt før kvartalet begynte" });

export function afpRuter() {
  const r = new Hono();

  // Oversikten for året: oppsettet, det som er avsatt og betalt per kvartal, og betalingene.
  r.get("/lonn/afp", async (c) => {
    const aar = z.coerce.number().int().min(2015).max(2100).parse(c.req.query("aar") ?? new Date().getFullYear());
    return c.json(
      await bruk(c, async (db) => {
        await db.query("select faktura.krev($1, 'personal_les')", [orgId(c)]);
        const o = await en<{ afp: boolean; afp_sats: number; ou_premie: number; bokforing_afp: boolean; aga_sone: string }>(
          db,
          "select afp, afp_sats::float8 as afp_sats, ou_premie::float8 as ou_premie, bokforing_afp, aga_sone from faktura.lonn_oppsett where org_id = $1",
          [orgId(c)],
        );
        return {
          aar,
          oppsett: { afp: o?.afp ?? false, afp_sats: o?.afp_sats ?? 2.7, ou_premie: o?.ou_premie ?? 0, bokforing_afp: o?.bokforing_afp ?? false, aga_sone: o?.aga_sone ?? "1" },
          kvartaler: await kvartaler(db, orgId(c), aar),
          betalinger: await alle(db, `${BETALING} where p.org_id = $1 and p.aar = $2 order by p.dato desc, p.opprettet desc`, [orgId(c), aar]),
        };
      }),
    );
  });

  // En betaling av fakturaen fra Fellesordningen: raden (med arbeidsgiveravgiften av AFP-premien)
  // og bilaget.
  r.post("/lonn/afp", async (c) => {
    const b = skjema.parse(await c.req.json().catch(() => ({})));
    return c.json(
      await bruk(c, async (db) => {
        await db.query("select faktura.krev($1, 'personal')", [orgId(c)]);
        const ou = b.ou ?? 0;
        const a = await avgiftAvPremie(db, orgId(c), b.afp, b.dato);
        const tekst = bilagstekst({ ...b, ou });
        const posteringer = premiebilag({ afp: b.afp, ou, aga: a.aga }, await hentBokforingsoppsett(db, orgId(c)), tekst);
        const ny = await en<{ id: string }>(db, "select faktura.registrer_afp_premie($1, $2, $3, $4) as id", [
          orgId(c),
          JSON.stringify({ dato: b.dato, aar: b.aar, kvartal: b.kvartal, afp: b.afp, ou, aga_sats: a.sats, aga: a.aga, aga_sone: a.sone, tekst: b.tekst ?? null }),
          tekst,
          JSON.stringify(posteringer),
        ]);
        return (await en(db, `${BETALING} where p.org_id = $1 and p.id = $2`, [orgId(c), ny!.id]))!;
      }),
      201,
    );
  });

  // Slett en betaling som er registrert feil (bilaget reverseres).
  r.delete("/lonn/afp/:id", async (c) => {
    const id = uuid.parse(c.req.param("id"));
    await bruk(c, async (db) => {
      await db.query("select faktura.krev($1, 'personal')", [orgId(c)]);
      const x = await en<{ id: string }>(db, "select id from faktura.afp_premier where org_id = $1 and id = $2", [orgId(c), id]);
      if (!x) throw new ApiFeil(404, "Fant ikke betalingen");
      await db.query("select faktura.slett_afp_premie($1, $2)", [orgId(c), id]);
    });
    return c.body(null, 204);
  });

  return r;
}

// --- Rapporten -----------------------------------------------------------------------------------

export const afpRapporter: Rapportdef[] = [
  {
    id: "lonn.afp",
    modul: "lonn",
    navn: "AFP og OU",
    beskrivelse:
      "Grunnlaget for AFP-premien (lønnen i perioden), AFP- og OU-premien som er avsatt per ansatt, og betalingene til Fellesordningen med arbeidsgiveravgiften av AFP-premien.",
    funksjon: "lonn",
    tilgang: "personal_les",
    parameter: "periode",
    maanedlig: true,
    hent: async (db, org, v) => {
      const rader = await alle<Record<string, unknown>>(
        db,
        `select s.ansattnummer, s.navn, sum(s.afp_grunnlag)::float8 as grunnlag, sum(s.afp)::float8 as afp, sum(s.ou)::float8 as ou
           from faktura.lonnsslipper s join faktura.lonnskjoringer k on k.id = s.kjoring_id
          where k.org_id = $1 and k.status = 'godkjent'
            and (case when $4::uuid is not null then k.id = $4::uuid else k.utbetalingsdato between $2 and $3 end)
          group by s.ansattnummer, s.navn
         having sum(s.afp_grunnlag) <> 0 or sum(s.afp) <> 0 or sum(s.ou) <> 0
          order by s.ansattnummer`,
        [org, v.fra, v.til, v.kjoring],
      );
      const betalt = await alle<{ dato: string; aar: number; kvartal: number; afp: number; ou: number; aga: number }>(
        db,
        `select to_char(dato, 'YYYY-MM-DD') as dato, aar, kvartal, afp::float8 as afp, ou::float8 as ou, aga::float8 as aga
           from faktura.afp_premier where org_id = $1 and dato between $2 and $3 order by dato`,
        [org, v.fra, v.til],
      );
      const betalinger = betalt.length
        ? `Betalt til Fellesordningen i perioden: ${betalt
            .map((b) => `${b.dato.split("-").reverse().join(".")} for ${kvartalNavn(b.aar, b.kvartal)} ${krTekst(Number(b.afp) + Number(b.ou))} (arbeidsgiveravgift ${krTekst(Number(b.aga))})`)
            .join(", ")}.`
        : "Ingen betalinger til Fellesordningen er registrert i perioden.";
      return {
        kolonner: [
          { nokkel: "ansattnummer", navn: "Nr", type: "tekst" },
          { nokkel: "navn", navn: "Ansatt" },
          { nokkel: "grunnlag", navn: "Grunnlag", type: "kr", sum: true },
          { nokkel: "afp", navn: "AFP-premie", type: "kr", sum: true },
          { nokkel: "ou", navn: "OU-premie", type: "kr", sum: true },
        ],
        rader,
        merknad: `Avsatt i de godkjente lønnskjøringene: AFP-premien av lønnen mellom 1 og 7,1 G i året (13–61 år), og OU-premien per heltidsansatt. Fakturaen fra Fellesordningen kommer kvartalsvis etterskudd. ${betalinger}`,
      };
    },
  },
];
