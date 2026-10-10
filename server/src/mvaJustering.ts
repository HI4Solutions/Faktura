// Justering av inngående merverdiavgift for kapitalvarer (0095_mva_justering.sql), etter
// merverdiavgiftsloven kapittel 9 og Skatteetatens regler for mva-meldingen:
//  - En kapitalvare er et anleggsmiddel der den inngående avgiften på kostprisen (hele, også det som
//    ikke ble trukket fra) er minst 50 000 kr for maskiner, inventar og andre driftsmidler, eller
//    100 000 kr for fast eiendom (bygninger og fast teknisk installasjon). Tomt, goodwill og
//    personbiler er ikke med (personkjøretøy har egne regler om tilbakeføring).
//  - Justeringsperioden er fem år for løsøre, fra og med året det ble anskaffet, og ti år for fast
//    eiendom, fra og med året det ble tatt i bruk (fullført; når avskrivningen begynner).
//  - Hvert år sammenlignes fradragsprosenten i året med prosenten ved anskaffelsen. Er endringen minst
//    ti prosentpoeng, justeres en femdel (en tidel) av avgiften ganger endringen: mer fradrag når
//    bruken i avgiftspliktig virksomhet har økt, tilbakebetaling når den har minket. Justeringen føres
//    den 31. desember (serie V) mot kostnadskontoen for justeringen, og står i mva-meldingen for den
//    siste terminen i året på kode 1 med spesifikasjonen «justering» (uten grunnlag og sats).
//  - Fradragsprosenten i året: en kapitalvare til felles bruk følger fradragsprosenten for
//    fellesanskaffelser i året: den som er satt for året, ellers andelen avgiftspliktig omsetning (også
//    fritatt og med omvendt avgiftsplikt) av all omsetning i året etter bilagene, ellers fradraget i
//    oppsettet. Ellers har kapitalvaren egen prosent per år, som gjelder til den endres.
//  - Selges kapitalvaren i perioden, justeres resten av perioden samlet (med salgsåret) på
//    salgsdatoen, med 100 % når salget har avgift og 0 % ellers, mot gevinst eller tap (som
//    Revisorforeningen beskriver: justeringen tas med i gevinsten eller tapet). Etter salg eller
//    utrangering justeres ikke kapitalvaren for salgsåret eller årene etter på annen måte.
import { Hono, type Context } from "hono";
import { z } from "zod";
import { hentAnlegg, hentRegnskapsoppsett, regnskapskontoer, type Anleggsmiddel, type Kategori, type Regnskapsoppsett } from "./anlegg.js";
import { alle, en, somBruker, type Db } from "./db.js";
import { ApiFeil } from "./feil.js";
import { avgiftskontoer } from "./mva.js";
import type { Rapportdef } from "./rapportmodul.js";
import { kr } from "./regler.js";
import { bokforSalgNaa } from "./salgBokforing.js";

export const GRENSE_LOSORE = 50_000;
export const GRENSE_FAST_EIENDOM = 100_000;
// Endringer under ti prosentpoeng fra prosenten ved anskaffelsen justeres ikke.
export const MINSTE_ENDRING = 10;
const FAST_EIENDOM: Kategori[] = ["bygning", "teknisk_installasjon"];
const IKKE_KAPITALVARE: Kategori[] = ["tomt", "goodwill", "personbil"];
// Omsetningen som gir fradragsrett (også fritatt og med omvendt avgiftsplikt), og den utenfor loven.
const AVGIFTSPLIKTIG = ["3", "31", "32", "33", "5", "51", "52"];
const UTENFOR = ["6"];

const rund = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const osloIDag = () => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Oslo" }).format(new Date());
const pst = (n: number) => `${String(rund(n)).replace(".", ",")} %`;

type Kapitalfelt = Pick<Anleggsmiddel, "kategori" | "anskaffet" | "avskrives_fra" | "mva_inngaende" | "mva_fradrag" | "mva_felles" | "mva_bruk">;

export const fastEiendom = (k: Kategori) => FAST_EIENDOM.includes(k);
export const kanVaereKapitalvare = (k: Kategori) => !IKKE_KAPITALVARE.includes(k);
export const kapitalvaregrense = (k: Kategori) => (fastEiendom(k) ? GRENSE_FAST_EIENDOM : GRENSE_LOSORE);
export const erKapitalvare = (a: Kapitalfelt) =>
  a.mva_inngaende != null && a.mva_fradrag != null && kanVaereKapitalvare(a.kategori) && a.mva_inngaende >= kapitalvaregrense(a.kategori);

// Kapitalvaren når avgiften ved anskaffelsen er over grensen (utgiftene og anskaffelsen): avgiften,
// fradragsprosenten og om den er til felles bruk (fradraget var mellom 0 og 100 %).
export function kapitalvarefelt(kategori: Kategori, mva: number, fradrag: number) {
  if (!kanVaereKapitalvare(kategori) || rund(mva) < kapitalvaregrense(kategori)) return {};
  const prosent = rund((fradrag / mva) * 100);
  return { mva_inngaende: rund(mva), mva_fradrag: prosent, mva_felles: prosent > 0 && prosent < 100 };
}

// Justeringsperioden: årene fra og med det første til og med det siste.
export function justeringsperiode(a: Pick<Anleggsmiddel, "kategori" | "anskaffet" | "avskrives_fra">) {
  const antall = fastEiendom(a.kategori) ? 10 : 5;
  const fra = Number((fastEiendom(a.kategori) ? a.avskrives_fra : a.anskaffet).slice(0, 4));
  return { fra, til: fra + antall - 1, antall };
}

// Fradragsprosenten for kapitalvaren i året: egen prosent for året, ellers fellesprosenten (felles
// bruk), ellers den siste egne prosenten før året, ellers prosenten ved anskaffelsen.
export function prosentIAar(a: Kapitalfelt, aar: number, felles: number): { prosent: number; kilde: "egen" | "felles" | "anskaffelse" } {
  const egen = a.mva_bruk[String(aar)];
  if (egen != null) return { prosent: egen, kilde: "egen" };
  if (a.mva_felles) return { prosent: felles, kilde: "felles" };
  const for_ = Object.keys(a.mva_bruk)
    .map(Number)
    .filter((x) => x < aar)
    .sort((x, y) => y - x)[0];
  return for_ != null ? { prosent: a.mva_bruk[String(for_)]!, kilde: "egen" } : { prosent: a.mva_fradrag!, kilde: "anskaffelse" };
}

// Justeringen for ett år (eller samlet for flere): avgiften delt på årene i perioden, ganger endringen
// i fradragsprosenten, når endringen er minst ti prosentpoeng (ellers 0). Positivt: mer fradrag.
export function justering(a: Kapitalfelt, prosent: number, antallAar = 1) {
  const endring = rund(prosent - a.mva_fradrag!);
  if (Math.abs(endring) < MINSTE_ENDRING) return { endring, belop: 0 };
  const { antall } = justeringsperiode(a);
  return { endring, belop: Math.round((Math.round(a.mva_inngaende! * 100) * endring * antallAar) / (100 * antall)) / 100 };
}

// Den samlede justeringen ved salg i året: resten av perioden med salgsåret, med prosenten for resten
// (100 når salget har avgift, ellers 0). Null når salget er etter perioden.
export function samletJustering(a: Kapitalfelt, salgsaar: number, prosent: number) {
  const p = justeringsperiode(a);
  if (salgsaar > p.til) return null;
  const fra = Math.max(salgsaar, p.fra);
  const antallAar = p.til - fra + 1;
  return { aar: fra, aar_til: p.til, antall: antallAar, prosent, ...justering(a, prosent, antallAar) };
}

// --- Fellesprosenten ---------------------------------------------------------------------------------

export type Fellesprosent = {
  prosent: number;
  kilde: "satt" | "omsetning" | "oppsett";
  satt: number | null;
  omsetning: { avgiftspliktig: number; utenfor: number; prosent: number } | null;
  oppsett: number;
};

// Fradragsprosenten for fellesanskaffelser i året: den som er satt, ellers andelen avgiftspliktig
// omsetning av all omsetning i året (grunnlaget på salgslinjene med mva-kode, hele prosent), ellers
// fradraget i oppsettet (fullt for den som er mva-registrert).
export async function fellesprosent(db: Db, org: string, aar: number, o: Regnskapsoppsett): Promise<Fellesprosent> {
  const rad = await en<{ fradrag: number | null }>(db, "select fradrag::float8 as fradrag from faktura.mva_justeringer where org_id = $1 and aar = $2", [org, aar]);
  const oms = await alle<{ kode: string; sum: number }>(
    db,
    `select p.mva_kode as kode, sum(-p.belop)::float8 as sum
       from faktura.posteringer p join faktura.bilag b on b.id = p.bilag_id
      where b.org_id = $1 and b.dato between $2::date and $3::date and b.kilde not in ('mva', 'mva_justering')
        and p.mva_kode = any($4::text[]) and not (p.konto = any($5::text[]))
      group by p.mva_kode`,
    [org, `${aar}-01-01`, `${aar}-12-31`, [...AVGIFTSPLIKTIG, ...UTENFOR], [...avgiftskontoer(o).keys()]],
  );
  const sum = (koder: string[]) => Math.max(0, rund(oms.filter((x) => koder.includes(x.kode)).reduce((s, x) => s + x.sum, 0)));
  const avgiftspliktig = sum(AVGIFTSPLIKTIG);
  const utenfor = sum(UTENFOR);
  const omsetning = avgiftspliktig + utenfor > 0 ? { avgiftspliktig, utenfor, prosent: Math.round((avgiftspliktig / (avgiftspliktig + utenfor)) * 100) } : null;
  const registrert = Boolean((await en<{ r: boolean }>(db, "select mva_registrert as r from faktura.organisasjoner where id = $1", [org]))?.r);
  const oppsett = o.mva_fradrag ?? (registrert ? 100 : 0);
  const satt = rad?.fradrag ?? null;
  return { prosent: satt ?? omsetning?.prosent ?? oppsett, kilde: satt != null ? "satt" : omsetning ? "omsetning" : "oppsett", satt, omsetning, oppsett };
}

// --- Året ------------------------------------------------------------------------------------------

export type Kapitalvarelinje = {
  anleggsmiddel_id: string;
  nummer: number;
  navn: string;
  kategori: Kategori;
  periode: { fra: number; til: number; antall: number };
  aar_nr: number; // året i perioden (1–5 eller 1–10)
  mva_inngaende: number;
  start: number;
  felles: boolean;
  prosent: number;
  kilde: "egen" | "felles" | "anskaffelse";
  endring: number;
  belop: number;
  bokfort: number | null; // det som er bokført for året
};
export type Samlet = {
  anleggsmiddel_id: string;
  nummer: number;
  navn: string;
  dato: string;
  aar: number;
  aar_til: number;
  prosent: number;
  belop: number;
  bilag: { id: string; bilagsnummer: string };
};
export type Aarsjustering = {
  aar: number;
  over: boolean;
  laast: boolean;
  felles: Fellesprosent;
  kapitalvarer: Kapitalvarelinje[];
  sum: number;
  bilag: { id: string; bilagsnummer: string } | null;
  stemmer: boolean; // det som er bokført, er det som regnes nå (eller ingenting å bokføre)
  trengs: boolean;
  samlet: Samlet[]; // samlede justeringer ved salg i året
};

// Kapitalvarene i justeringsperioden i året (ikke solgt eller utrangert i året eller før).
export const iPerioden = (a: Anleggsmiddel, aar: number) => {
  if (!erKapitalvare(a)) return false;
  const p = justeringsperiode(a);
  return p.fra <= aar && aar <= p.til && (!a.avgang_dato || Number(a.avgang_dato.slice(0, 4)) > aar);
};

async function gjeldendeBilag(db: Db, org: string, kilde: string | null | undefined) {
  if (!kilde) return null;
  return en<{ id: string; bilagsnummer: string; dato: string }>(
    db,
    `select b.id, b.serie || '-' || b.aar || '-' || b.nummer as bilagsnummer, to_char(b.dato, 'YYYY-MM-DD') as dato from faktura.bilag b
      where b.org_id = $1 and b.kilde = 'mva_justering' and b.kilde_id = $2 and b.reverserer is null and b.reversert_av is null`,
    [org, kilde],
  );
}

// Justeringen for året: kapitalvarene i perioden med prosenten og beløpet, og det som er bokført.
export async function aarsjustering(db: Db, org: string, aar: number, iDag = osloIDag(), anlegg?: Anleggsmiddel[]): Promise<Aarsjustering> {
  // Fakturaene som ikke er bokført ennå (omsetningen i året).
  await bokforSalgNaa(db, org);
  const o = await hentRegnskapsoppsett(db, org);
  const alleAnlegg = anlegg ?? (await hentAnlegg(db, org)).anlegg;
  const felles = await fellesprosent(db, org, aar, o);
  const rad = await en<{ id: string }>(db, "select id from faktura.mva_justeringer where org_id = $1 and aar = $2", [org, aar]);
  const bilag = await gjeldendeBilag(db, org, rad?.id);
  const bokfort = new Map(
    bilag
      ? (await alle<{ id: string; belop: number }>(db, "select anleggsmiddel_id as id, sum(belop)::float8 as belop from faktura.mva_justeringslinjer where bilag_id = $1 group by anleggsmiddel_id", [bilag.id])).map(
          (x) => [x.id, rund(x.belop)] as const,
        )
      : [],
  );
  const kapitalvarer = alleAnlegg
    .filter((a) => iPerioden(a, aar))
    .map((a): Kapitalvarelinje => {
      const periode = justeringsperiode(a);
      const p = prosentIAar(a, aar, felles.prosent);
      const j = justering(a, p.prosent);
      return {
        anleggsmiddel_id: a.id,
        nummer: a.nummer,
        navn: a.navn,
        kategori: a.kategori,
        periode,
        aar_nr: aar - periode.fra + 1,
        mva_inngaende: a.mva_inngaende!,
        start: a.mva_fradrag!,
        felles: a.mva_felles,
        prosent: p.prosent,
        kilde: p.kilde,
        endring: j.endring,
        belop: j.belop,
        bokfort: bokfort.get(a.id) ?? null,
      };
    });
  const onsket = kapitalvarer.filter((l) => l.belop !== 0);
  // Bokført for kapitalvarer som ikke lenger er med (f.eks. avgiften er endret), teller også.
  const stemmer = onsket.length === bokfort.size && onsket.every((l) => l.bokfort === l.belop);
  const samlet = await alle<Samlet>(
    db,
    `select l.anleggsmiddel_id, a.nummer, a.navn, to_char(b.dato, 'YYYY-MM-DD') as dato, l.aar, l.aar_til, l.fradrag::float8 as prosent,
            l.belop::float8 as belop, json_build_object('id', b.id, 'bilagsnummer', b.serie || '-' || b.aar || '-' || b.nummer) as bilag
       from faktura.mva_justeringslinjer l join faktura.bilag b on b.id = l.bilag_id join faktura.anleggsmidler a on a.id = l.anleggsmiddel_id
      where l.org_id = $1 and b.kilde_id = l.anleggsmiddel_id and b.reverserer is null and b.reversert_av is null and l.aar = $2
      order by b.dato, a.nummer`,
    [org, aar],
  );
  return {
    aar,
    over: `${aar}-12-31` < iDag,
    laast: Boolean(o.laast_til && o.laast_til >= `${aar}-12-31`),
    felles,
    kapitalvarer,
    sum: rund(onsket.reduce((s, l) => s + l.belop, 0)),
    bilag: bilag ? { id: bilag.id, bilagsnummer: bilag.bilagsnummer } : null,
    stemmer: bilag ? stemmer : !onsket.length,
    trengs: onsket.length > 0,
    samlet,
  };
}

const bilagsnummer = (db: Db, id: string) =>
  en<{ id: string; bilagsnummer: string; dato: string; tekst: string }>(
    db,
    "select id, serie || '-' || aar || '-' || nummer as bilagsnummer, to_char(dato, 'YYYY-MM-DD') as dato, tekst from faktura.bilag where id = $1",
    [id],
  ).then((b) => b!);

// Fører justeringen for året (eller på nytt når den er endret, eller angrer den når det ikke er noe
// å justere). Gir bilaget som ble ført, eller null når det stemte.
export async function bokforJustering(db: Db, org: string, aar: number, iDag = osloIDag()) {
  if (`${aar}-12-31` >= iDag) throw new ApiFeil(409, "Året er ikke over");
  const s = await aarsjustering(db, org, aar, iDag);
  if (s.laast) throw new ApiFeil(409, "Året er låst; lås det opp først");
  const linjer = s.kapitalvarer.filter((l) => l.belop !== 0);
  if (!linjer.length) {
    if (s.bilag) await db.query("select faktura.angre_mva_justering($1, $2, null)", [org, aar]);
    return null;
  }
  if (s.bilag && s.stemmer) return null;
  const k = regnskapskontoer(await hentRegnskapsoppsett(db, org));
  const posteringer = linjer.flatMap((l) => {
    const tekst = `${l.navn} (nr. ${l.nummer}), år ${l.aar_nr} av ${l.periode.antall}: ${pst(l.start)} → ${pst(l.prosent)}`.slice(0, 200);
    return [
      { konto: k.inngaende_mva, belop: l.belop, tekst, mva_kode: "1" },
      { konto: k.mva_justering, belop: -l.belop, tekst, mva_kode: null },
    ];
  });
  const id = (await en<{ id: string }>(db, "select faktura.bokfor_mva_justering($1, $2, null, $3, $4::jsonb, $5::jsonb) as id", [
    org,
    aar,
    `Mva-justering for kapitalvarer ${aar}`,
    JSON.stringify(posteringer),
    JSON.stringify(linjer.map((l) => ({ anleggsmiddel_id: l.anleggsmiddel_id, aar, aar_til: aar, fradrag: l.prosent, belop: l.belop }))),
  ]))!.id;
  return bilagsnummer(db, id);
}

// Månedsavslutningen (som systemet): justeringen for årene som slutter fra og med måneden automatikken
// startet til og med måneden som er avsluttet (de to siste årene), når året ikke er låst. Før
// mva-oppgjøret, så oppgjøret for den siste terminen tar den med.
export async function bokforJusteringTil(db: Db, org: string, maaned: string, fra: string, iDag = osloIDag()) {
  const o = await hentRegnskapsoppsett(db, org);
  const bilag: { id: string; bilagsnummer: string; tekst: string; sum: number }[] = [];
  const feil: string[] = [];
  const forste = Number(fra.slice(0, 4));
  const siste = Number(maaned.slice(0, 4)) - (maaned.endsWith("-12") ? 0 : 1);
  for (let aar = Math.max(forste, siste - 1); aar <= siste; aar++) {
    if (`${aar}-12` < fra.slice(0, 7) || (o.laast_til && o.laast_til >= `${aar}-12-31`)) continue;
    await db.query("savepoint mva_justering");
    try {
      const b = await bokforJustering(db, org, aar, iDag);
      await db.query("release savepoint mva_justering");
      if (b) bilag.push({ ...b, tekst: `Mva-justering for kapitalvarer ${aar}`, sum: 0 });
    } catch (e) {
      await db.query("rollback to savepoint mva_justering");
      feil.push(`${aar}: ${(e as Error).message}`);
    }
  }
  return { bilag, feil };
}

// --- Salget ----------------------------------------------------------------------------------------

// Om salget av anleggsmiddelet hadde utgående avgift (avgangsbilaget har avgift).
async function salgMedAvgift(db: Db, org: string, id: string, o: Regnskapsoppsett) {
  const utg = [...avgiftskontoer(o)].filter(([, a]) => a.art === "utg").map(([konto]) => konto);
  const r = await en<{ x: boolean }>(
    db,
    `select exists (select 1 from faktura.anleggshendelser h join faktura.posteringer p on p.bilag_id = h.bilag_id
                     where h.org_id = $1 and h.anleggsmiddel_id = $2 and h.type = 'avgang' and not h.reversert
                       and p.konto = any($3::text[]) and p.belop <> 0) as x`,
    [org, id, utg],
  );
  return Boolean(r?.x);
}

export type Salgsjustering = { aar: number; aar_til: number; antall: number; prosent: number; endring: number; belop: number; med_avgift: boolean };

// Den samlede justeringen for kapitalvaren som er solgt (eller null når den ikke er en kapitalvare i
// perioden eller ikke er solgt), med prosenten for resten av perioden (standard: 100 når salget hadde
// avgift, ellers 0).
export async function salgsjustering(db: Db, org: string, a: Anleggsmiddel, prosent?: number): Promise<Salgsjustering | null> {
  if (a.avgang_type !== "salg" || !a.avgang_dato || !erKapitalvare(a)) return null;
  const medAvgift = await salgMedAvgift(db, org, a.id, await hentRegnskapsoppsett(db, org));
  const s = samletJustering(a, Number(a.avgang_dato.slice(0, 4)), prosent ?? (medAvgift ? 100 : 0));
  return s ? { aar: s.aar, aar_til: s.aar_til, antall: s.antall, prosent: s.prosent, endring: s.endring, belop: s.belop, med_avgift: medAvgift } : null;
}

// Fører den samlede justeringen ved salget (eller på nytt med en annen prosent): den inngående
// avgiften mot gevinst (mer fradrag) eller tap. Gir bilaget, eller null når det ikke er noe å justere.
export async function bokforSalgsjustering(db: Db, org: string, id: string, prosent?: number) {
  const { anlegg } = await hentAnlegg(db, org, id);
  const a = anlegg[0];
  if (!a) throw new ApiFeil(404, "Fant ikke anleggsmiddelet");
  if (a.avgang_type !== "salg") throw new ApiFeil(409, "Den samlede justeringen gjelder når kapitalvaren er solgt");
  if (!erKapitalvare(a)) throw new ApiFeil(409, "Anleggsmiddelet er ikke en kapitalvare (inngående mva på kostprisen under grensen)");
  const s = await salgsjustering(db, org, a, prosent);
  const gammelt = await gjeldendeBilag(db, org, a.id);
  if (!s || s.belop === 0) {
    if (gammelt) await db.query("select faktura.angre_mva_justering($1, null, $2)", [org, a.id]);
    return null;
  }
  const k = regnskapskontoer(await hentRegnskapsoppsett(db, org));
  const tekst = `Mva-justering ved salg: ${a.navn} (nr. ${a.nummer}), ${s.aar === s.aar_til ? s.aar : `${s.aar}–${s.aar_til}`}: ${pst(a.mva_fradrag!)} → ${pst(s.prosent)}`.slice(0, 200);
  const posteringer = [
    { konto: k.inngaende_mva, belop: s.belop, tekst, mva_kode: "1" },
    { konto: s.belop > 0 ? k.gevinst : k.tap, belop: -s.belop, tekst, mva_kode: null },
  ];
  const b = (await en<{ id: string }>(db, "select faktura.bokfor_mva_justering($1, $2, $3, $4, $5::jsonb, $6::jsonb) as id", [
    org,
    Number(a.avgang_dato!.slice(0, 4)),
    a.id,
    tekst,
    JSON.stringify(posteringer),
    JSON.stringify([{ anleggsmiddel_id: a.id, aar: Number(a.avgang_dato!.slice(0, 4)), aar_til: s.aar_til, fradrag: s.prosent, belop: s.belop }]),
  ]))!.id;
  return bilagsnummer(db, b);
}

// --- Kapitalvaren (anleggsmiddelet) --------------------------------------------------------------------

export type Kapitalvarestatus = {
  kapitalvare: boolean;
  grense: number;
  periode: { fra: number; til: number; antall: number } | null;
  aar: { aar: number; prosent: number; kilde: "egen" | "felles" | "anskaffelse"; endring: number; belop: number; bokfort: { belop: number; bilagsnummer: string } | null }[];
  salg: (Salgsjustering & { bilag: { id: string; bilagsnummer: string; belop: number } | null }) | null;
};

// Justeringen år for år for kapitalvaren (til og med i år), og den samlede ved salget.
export async function kapitalvarestatus(db: Db, org: string, a: Anleggsmiddel, iDag = osloIDag()): Promise<Kapitalvarestatus> {
  const grense = kapitalvaregrense(a.kategori);
  if (!erKapitalvare(a)) return { kapitalvare: false, grense, periode: null, aar: [], salg: null };
  await bokforSalgNaa(db, org);
  const o = await hentRegnskapsoppsett(db, org);
  const periode = justeringsperiode(a);
  const bokfort = await alle<{ aar: number; belop: number; bilagsnummer: string }>(
    db,
    `select l.aar, l.belop::float8 as belop, b.serie || '-' || b.aar || '-' || b.nummer as bilagsnummer
       from faktura.mva_justeringslinjer l join faktura.bilag b on b.id = l.bilag_id
      where l.org_id = $1 and l.anleggsmiddel_id = $2 and b.kilde_id <> l.anleggsmiddel_id and b.reverserer is null and b.reversert_av is null`,
    [org, a.id],
  );
  const aar: Kapitalvarestatus["aar"] = [];
  const iAar = Number(iDag.slice(0, 4));
  for (let y = periode.fra; y <= Math.min(periode.til, iAar); y++) {
    if (a.avgang_dato && Number(a.avgang_dato.slice(0, 4)) <= y) break;
    const p = prosentIAar(a, y, a.mva_felles && !(String(y) in a.mva_bruk) ? (await fellesprosent(db, org, y, o)).prosent : a.mva_fradrag!);
    const j = justering(a, p.prosent);
    const b = bokfort.find((x) => x.aar === y);
    aar.push({ aar: y, prosent: p.prosent, kilde: p.kilde, endring: j.endring, belop: j.belop, bokfort: b ? { belop: rund(b.belop), bilagsnummer: b.bilagsnummer } : null });
  }
  // Ved salg: den samlede justeringen som er bokført (med prosenten den ble ført med), ellers forslaget.
  const sb = a.avgang_type === "salg" ? await gjeldendeBilag(db, org, a.id) : null;
  const linje = sb
    ? await en<{ fradrag: number; belop: number }>(db, "select fradrag::float8 as fradrag, sum(belop) over ()::float8 as belop from faktura.mva_justeringslinjer where bilag_id = $1 limit 1", [sb.id])
    : null;
  const s = await salgsjustering(db, org, a, linje?.fradrag);
  return {
    kapitalvare: true,
    grense,
    periode,
    aar,
    salg: s ? { ...s, bilag: sb && linje ? { id: sb.id, bilagsnummer: sb.bilagsnummer, belop: rund(linje.belop) } : null } : null,
  };
}

// --- Rutene (under /api/org/:org) ------------------------------------------------------------------

const uuid = z.string().uuid();
const orgId = (c: Context) => uuid.parse(c.req.param("org"));
const bruk = <T>(c: Context, fn: (db: Db) => Promise<T>) => somBruker<T>(c.get("bruker").id, fn);
const krev = (db: Db, org: string) => db.query("select faktura.krev($1, 'regnskap')", [org]);
const aarS = z.coerce.number({ error: "Ugyldig år" }).int("Ugyldig år").min(2000, "Ugyldig år").max(2100, "Ugyldig år");
const prosentS = z.number({ error: "Skriv fradragsprosenten" }).finite().min(0, "Fradraget er i prosent").max(100, "Fradraget er i prosent");

export function mvaJusteringRuter() {
  const r = new Hono();

  // Justeringen for året (standard: i fjor).
  r.get("/regnskap/mva-justering", async (c) => {
    const q = z.object({ aar: aarS.optional() }).parse(c.req.query());
    return c.json(
      await bruk(c, async (db) => {
        await krev(db, orgId(c));
        return aarsjustering(db, orgId(c), q.aar ?? Number(osloIDag().slice(0, 4)) - 1);
      }),
    );
  });

  // Fradragsprosenten for fellesanskaffelser i året (null: regnet fra omsetningen).
  r.put("/regnskap/mva-justering/:aar", async (c) => {
    const aar = aarS.parse(c.req.param("aar"));
    const b = z.object({ fradrag: prosentS.nullable() }).parse(await c.req.json().catch(() => ({})));
    return c.json(
      await bruk(c, async (db) => {
        await krev(db, orgId(c));
        await db.query(
          `insert into faktura.mva_justeringer (org_id, aar, fradrag) values ($1, $2, $3)
           on conflict (org_id, aar) do update set fradrag = excluded.fradrag, oppdatert = now()`,
          [orgId(c), aar, b.fradrag === null ? null : rund(b.fradrag)],
        );
        return aarsjustering(db, orgId(c), aar);
      }),
    );
  });

  // Fører justeringen for året (eller på nytt).
  r.post("/regnskap/mva-justering/:aar", async (c) => {
    const aar = aarS.parse(c.req.param("aar"));
    return c.json(
      await bruk(c, async (db) => {
        await krev(db, orgId(c));
        const bilag = await bokforJustering(db, orgId(c), aar);
        return { bilag, status: await aarsjustering(db, orgId(c), aar) };
      }),
      201,
    );
  });

  // Angrer justeringen for året.
  r.delete("/regnskap/mva-justering/:aar", async (c) => {
    const aar = aarS.parse(c.req.param("aar"));
    return c.json(
      await bruk(c, async (db) => {
        await krev(db, orgId(c));
        await db.query("select faktura.angre_mva_justering($1, $2, null)", [orgId(c), aar]);
        return aarsjustering(db, orgId(c), aar);
      }),
    );
  });

  return r;
}

// --- Rapporten -------------------------------------------------------------------------------------

export const mvaJusteringRapporter: Rapportdef[] = [
  {
    id: "regnskap.mva_justering",
    modul: "regnskap",
    navn: "Mva-justering for kapitalvarer",
    beskrivelse:
      "Kapitalvarene i justeringsperioden (inngående mva på kostprisen minst 50 000 kr, fast eiendom 100 000 kr): fradragsprosenten ved anskaffelsen og i året, endringen og justeringen (en femdel, for fast eiendom en tidel, av avgiften ganger endringen når den er minst ti prosentpoeng), og om den er bokført.",
    funksjon: "regnskap",
    tilgang: "regnskap",
    parameter: "aar",
    maanedlig: true,
    hent: async (db, org, v) => {
      const s = await aarsjustering(db, org, v.aar);
      const kilde =
        s.felles.kilde === "satt"
          ? "satt for året"
          : s.felles.kilde === "omsetning"
            ? `andelen avgiftspliktig omsetning (${kr(s.felles.omsetning!.avgiftspliktig)} kr av ${kr(s.felles.omsetning!.avgiftspliktig + s.felles.omsetning!.utenfor)} kr)`
            : "fradraget i oppsettet";
      const merknad = [
        s.kapitalvarer.length
          ? `Fradragsprosenten for fellesanskaffelser i ${v.aar} er ${pst(s.felles.prosent)} (${kilde}).`
          : `Ingen kapitalvarer i justeringsperioden i ${v.aar}.`,
        s.trengs
          ? s.bilag
            ? `Justeringen er bokført (${s.bilag.bilagsnummer})${s.stemmer ? "" : ", men den er endret etterpå"}.`
            : s.over
              ? "Justeringen er ikke bokført."
              : "Justeringen føres når året er over."
          : s.kapitalvarer.length
            ? "Ingen endring på minst ti prosentpoeng; ingenting å justere."
            : "",
        ...s.samlet.map((x) => `Samlet justering ved salg av ${x.navn} (nr. ${x.nummer}) ${x.dato.split("-").reverse().join(".")}: ${kr(x.belop)} kr (${x.bilag.bilagsnummer}).`),
      ]
        .filter(Boolean)
        .join(" ");
      return {
        merknad,
        kolonner: [
          { nokkel: "nummer", navn: "Nr.", type: "tekst" },
          { nokkel: "navn", navn: "Kapitalvare" },
          { nokkel: "periode", navn: "År i perioden", type: "tekst" },
          { nokkel: "mva", navn: "Inngående mva", type: "kr" },
          { nokkel: "start", navn: "Fradrag ved anskaffelsen", type: "prosent" },
          { nokkel: "prosent", navn: "Fradrag i året", type: "prosent" },
          { nokkel: "justering", navn: "Justering", type: "kr", sum: true },
        ],
        rader: s.kapitalvarer.map((l) => ({
          nummer: String(l.nummer),
          navn: l.navn,
          periode: `${l.aar_nr} av ${l.periode.antall}`,
          mva: l.mva_inngaende,
          start: l.start,
          prosent: l.prosent,
          justering: l.belop,
        })),
      };
    },
  },
];
