// Anleggsmidlene i regnskapet (0086_regnskap_anlegg.sql): anleggsregisteret med avskrivningsplanen
// over flere år, og bilagene for anskaffelsen, avskrivningene, nedskrivning (og reversering av den)
// og avgangen (salg eller utrangering). Bilagene føres i serie A.
//
// Avskrivningsplanen er lineær (regnskapsloven § 5-3: en fornuftig avskrivningsplan): kostprisen
// minus restverdien fordeles på månedene i levetiden fra den første måneden (når anleggsmiddelet
// ble tatt i bruk). Hver måned avskrives det som står igjen ned til restverdien, delt på månedene
// som er igjen, så en nedskrivning, en reversering eller en ny levetid gjelder framover, og den
// siste måneden tar det som er igjen (beløpene regnes i øre). En nedskrivning eller reversering
// gjelder fra måneden etter (avskrivningen for måneden den er datert i, regnes som før).
// Avskrivningene bokføres måned for måned (bilag datert den siste dagen i måneden), og ved avgang
// avskrives det til og med avgangsmåneden. Goodwill avskrives som de andre over levetiden, og en
// nedskrivning av goodwill reverseres ikke. Tomt avskrives ikke.
import { alle, en, type Db } from "./db.js";
import { ApiFeil } from "./feil.js";
import { maanedNavn } from "./lonnsberegning.js";

export type Kategori =
  | "goodwill"
  | "immateriell"
  | "tomt"
  | "bygning"
  | "teknisk_installasjon"
  | "maskiner"
  | "inventar"
  | "kontormaskiner"
  | "personbil"
  | "varebil"
  | "annet";
export type Saldogruppe = "a" | "b" | "c" | "d" | "e" | "f" | "g" | "h" | "i" | "j";
export type Skatt = Saldogruppe | "lineaer" | "ingen";

// Kontoene i regnskapet (det organisasjonen kan endre under oppsettet).
export type Regnskapsrolle =
  | "avskrivning_bygg"
  | "avskrivning_driftsmidler"
  | "avskrivning_immaterielle"
  | "nedskrivning"
  | "gevinst"
  | "tap"
  | "bank"
  | "leverandorgjeld"
  | "kundefordringer"
  | "inngaende_mva"
  | "utgaende_mva"
  | "forskuddsbetalt_kostnad"
  | "paalopt_kostnad"
  | "uopptjent_inntekt"
  | "opptjent_inntekt"
  | "salg"
  | "salg_middels"
  | "salg_rafisk"
  | "salg_lav"
  | "salg_fritatt"
  | "salg_unntatt"
  | "utgaende_mva_middels"
  | "utgaende_mva_rafisk"
  | "utgaende_mva_lav"
  | "purregebyr"
  | "inngaende_mva_middels"
  | "inngaende_mva_rafisk"
  | "inngaende_mva_lav"
  | "inngaende_mva_utland"
  | "utgaende_mva_utland"
  | "kontanter"
  | "gjeld_ansatte"
  | "bankgebyr"
  | "renteinntekt"
  | "rentekostnad"
  | "oppgjor_mva";
export const REGNSKAPSKONTOER: { rolle: Regnskapsrolle; navn: string; standard: string }[] = [
  { rolle: "avskrivning_bygg", navn: "Avskrivning på bygninger og annen fast eiendom", standard: "6000" },
  { rolle: "avskrivning_driftsmidler", navn: "Avskrivning på transportmidler, maskiner og inventar", standard: "6010" },
  { rolle: "avskrivning_immaterielle", navn: "Avskrivning på immaterielle eiendeler (også goodwill)", standard: "6020" },
  { rolle: "nedskrivning", navn: "Nedskrivning av varige driftsmidler og immaterielle eiendeler", standard: "6050" },
  { rolle: "gevinst", navn: "Gevinst ved avgang av anleggsmidler", standard: "3800" },
  { rolle: "tap", navn: "Tap ved avgang av anleggsmidler", standard: "7800" },
  { rolle: "bank", navn: "Bank", standard: "1920" },
  { rolle: "leverandorgjeld", navn: "Leverandørgjeld", standard: "2400" },
  { rolle: "kundefordringer", navn: "Kundefordringer", standard: "1500" },
  { rolle: "inngaende_mva", navn: "Inngående merverdiavgift (høy sats)", standard: "2710" },
  // Utgiftene (utgiftVurdering.ts): den inngående avgiften per sats, avgiften for tjenester kjøpt fra
  // utlandet (snudd avregning), kontantene og gjelden til de ansatte for utlegg.
  { rolle: "inngaende_mva_middels", navn: "Inngående merverdiavgift, middels sats", standard: "2711" },
  { rolle: "inngaende_mva_rafisk", navn: "Inngående merverdiavgift, råfisk", standard: "2712" },
  { rolle: "inngaende_mva_lav", navn: "Inngående merverdiavgift, lav sats", standard: "2713" },
  { rolle: "inngaende_mva_utland", navn: "Inngående merverdiavgift, tjenester fra utlandet", standard: "2714" },
  { rolle: "utgaende_mva_utland", navn: "Utgående merverdiavgift, tjenester fra utlandet", standard: "2704" },
  { rolle: "kontanter", navn: "Kontanter", standard: "1900" },
  { rolle: "gjeld_ansatte", navn: "Gjeld til ansatte (utlegg)", standard: "2910" },
  { rolle: "utgaende_mva", navn: "Utgående merverdiavgift (høy sats)", standard: "2700" },
  // Fakturaene og innbetalingene (salgBokforing.ts): avgiften og salgsinntekten per sats (kontoene i
  // Skatteetatens standard kontoplan for SAF-T) og purregebyret.
  { rolle: "utgaende_mva_middels", navn: "Utgående merverdiavgift, middels sats", standard: "2701" },
  { rolle: "utgaende_mva_rafisk", navn: "Utgående merverdiavgift, råfisk", standard: "2702" },
  { rolle: "utgaende_mva_lav", navn: "Utgående merverdiavgift, lav sats", standard: "2703" },
  { rolle: "salg", navn: "Salgsinntekt, avgiftspliktig, høy sats", standard: "3000" },
  { rolle: "salg_middels", navn: "Salgsinntekt, avgiftspliktig, middels sats", standard: "3030" },
  { rolle: "salg_rafisk", navn: "Salgsinntekt råfisk, avgiftspliktig, middels sats", standard: "3035" },
  { rolle: "salg_lav", navn: "Salgsinntekt, avgiftspliktig, lav sats", standard: "3050" },
  { rolle: "salg_fritatt", navn: "Salgsinntekt, fritatt for merverdiavgift", standard: "3100" },
  { rolle: "salg_unntatt", navn: "Salgsinntekt, utenfor merverdiavgiftsloven", standard: "3200" },
  { rolle: "purregebyr", navn: "Purregebyr", standard: "3900" },
  // Banken (0091_bankposter.sql, bankAvstemming.ts): gebyrene og rentene fra banken, og betalingen
  // av merverdiavgiften.
  { rolle: "bankgebyr", navn: "Bank- og kortgebyrer", standard: "7770" },
  { rolle: "renteinntekt", navn: "Renteinntekt fra banken", standard: "8050" },
  { rolle: "rentekostnad", navn: "Rentekostnad til banken", standard: "8150" },
  { rolle: "oppgjor_mva", navn: "Oppgjørskonto merverdiavgift", standard: "2740" },
  // Periodiseringene (periodisering.ts): balansekontoene som foreslås.
  { rolle: "forskuddsbetalt_kostnad", navn: "Forskuddsbetalt kostnad", standard: "1700" },
  { rolle: "paalopt_kostnad", navn: "Påløpt kostnad", standard: "2960" },
  { rolle: "uopptjent_inntekt", navn: "Uopptjent inntekt (forskuddsfakturert)", standard: "2970" },
  { rolle: "opptjent_inntekt", navn: "Opptjent, ikke fakturert inntekt", standard: "1530" },
];
export const REGNSKAPSROLLER = REGNSKAPSKONTOER.map((k) => k.rolle) as [Regnskapsrolle, ...Regnskapsrolle[]];

// Kategoriene: balansekontoen, kostnadskontoen for avskrivningen, den skattemessige behandlingen og
// levetiden som foreslås (alt kan endres på anleggsmiddelet).
export const KATEGORIER: Record<Kategori, { navn: string; konto: string; avskrivning: Regnskapsrolle | null; skatt: Skatt; levetid: number | null }> = {
  goodwill: { navn: "Goodwill (forretningsverdi)", konto: "1080", avskrivning: "avskrivning_immaterielle", skatt: "b", levetid: 60 },
  immateriell: { navn: "Andre immaterielle eiendeler (lisenser, patenter, programvare)", konto: "1020", avskrivning: "avskrivning_immaterielle", skatt: "lineaer", levetid: 36 },
  tomt: { navn: "Tomt og grunn", konto: "1150", avskrivning: null, skatt: "ingen", levetid: null },
  bygning: { navn: "Bygninger", konto: "1100", avskrivning: "avskrivning_bygg", skatt: "h", levetid: 300 },
  teknisk_installasjon: { navn: "Fast teknisk installasjon i bygninger", konto: "1120", avskrivning: "avskrivning_bygg", skatt: "j", levetid: 180 },
  maskiner: { navn: "Maskiner og anlegg", konto: "1200", avskrivning: "avskrivning_driftsmidler", skatt: "d", levetid: 120 },
  inventar: { navn: "Inventar", konto: "1250", avskrivning: "avskrivning_driftsmidler", skatt: "d", levetid: 60 },
  kontormaskiner: { navn: "Kontormaskiner og IT-utstyr", konto: "1280", avskrivning: "avskrivning_driftsmidler", skatt: "a", levetid: 36 },
  personbil: { navn: "Personbiler", konto: "1230", avskrivning: "avskrivning_driftsmidler", skatt: "d", levetid: 60 },
  varebil: { navn: "Varebiler, lastebiler og busser", konto: "1240", avskrivning: "avskrivning_driftsmidler", skatt: "c", levetid: 60 },
  annet: { navn: "Andre driftsmidler", konto: "1290", avskrivning: "avskrivning_driftsmidler", skatt: "d", levetid: 60 },
};
export const KATEGORIKODER = Object.keys(KATEGORIER) as [Kategori, ...Kategori[]];

export type Regnskapsoppsett = {
  kontoer: Partial<Record<Regnskapsrolle, string>>;
  saldo_fra_aar: number | null;
  saldo_inngaende: Partial<Record<"a" | "c" | "d" | "gevinst_tap", number>>;
  // Fakturaene og innbetalingene bokføres fra og med datoen (null: alle), og salg uten avgift for den
  // som er mva-registrert, er unntatt eller fritatt (0089_regnskap_salg.sql).
  salg_fra: string | null;
  uten_mva: "unntatt" | "fritatt";
  // Utgiftene (0090_utgifter.sql): prosenten av den inngående avgiften som trekkes fra (null: 100 for
  // den som er mva-registrert, ellers 0), beløpet en utgift over flere måneder periodiseres fra, og
  // om utgiftene fra kjente leverandører bokføres av seg selv.
  mva_fradrag: number | null;
  periodiser_fra: number;
  utgifter_auto: boolean;
  // Banken (0091_bankposter.sql): bankpostene føres fra og med datoen (null: alle som er hentet), av
  // seg selv eller bare som forslag, og kontoen i regnskapet for hver bankkonto (ellers bankkontoen).
  bank_fra: string | null;
  bank_auto: boolean;
  bankkontoer: Record<string, string>;
};
export async function hentRegnskapsoppsett(db: Db, org: string): Promise<Regnskapsoppsett> {
  const o = await en<Regnskapsoppsett>(
    db,
    `select kontoer, saldo_fra_aar, saldo_inngaende, to_char(salg_fra, 'YYYY-MM-DD') as salg_fra, uten_mva, mva_fradrag::float8 as mva_fradrag,
            periodiser_fra::float8 as periodiser_fra, utgifter_auto, to_char(bank_fra, 'YYYY-MM-DD') as bank_fra, bank_auto, bankkontoer
       from faktura.regnskap_oppsett where org_id = $1`,
    [org],
  );
  return {
    kontoer: o?.kontoer ?? {},
    saldo_fra_aar: o?.saldo_fra_aar ?? null,
    saldo_inngaende: o?.saldo_inngaende ?? {},
    salg_fra: o?.salg_fra ?? null,
    uten_mva: o?.uten_mva ?? "unntatt",
    mva_fradrag: o?.mva_fradrag ?? null,
    periodiser_fra: o?.periodiser_fra ?? 5000,
    utgifter_auto: o?.utgifter_auto ?? true,
    bank_fra: o?.bank_fra ?? null,
    bank_auto: o?.bank_auto ?? true,
    bankkontoer: o?.bankkontoer ?? {},
  };
}
// Kontoene som brukes: standarden, med det organisasjonen har endret.
export function regnskapskontoer(o: Pick<Regnskapsoppsett, "kontoer">): Record<Regnskapsrolle, string> {
  return Object.fromEntries(REGNSKAPSKONTOER.map((k) => [k.rolle, o.kontoer[k.rolle] ?? k.standard])) as Record<Regnskapsrolle, string>;
}

export type Anleggsmiddel = {
  id: string;
  nummer: number;
  navn: string;
  beskrivelse: string | null;
  kategori: Kategori;
  anskaffet: string;
  avskrives_fra: string; // ÅÅÅÅ-MM-01
  kostpris: number;
  restverdi: number;
  levetid_mnd: number | null;
  konto: string;
  avskrivningskonto: string | null;
  skatt: Skatt;
  skatt_kostpris: number | null;
  skatt_sats: number | null;
  tidligere_til: string | null;
  tidligere_avskrevet: number;
  skatt_inngaende: number | null;
  avgang_dato: string | null;
  avgang_type: "salg" | "utrangering" | null;
  avgang_vederlag: number | null;
};
export type Hendelsestype = "anskaffelse" | "avskrivning" | "nedskrivning" | "reversering" | "avgang";
export type Hendelse = {
  id: string;
  anleggsmiddel_id: string;
  type: Hendelsestype;
  dato: string;
  maaned: string | null; // ÅÅÅÅ-MM for avskrivningen
  belop: number;
  vederlag: number | null;
  tekst: string | null;
  bilag_id: string;
  bilag: string; // A-2026-3
  reversert: boolean;
};

export const ANLEGG = `
  select a.id, a.nummer, a.navn, a.beskrivelse, a.kategori, to_char(a.anskaffet, 'YYYY-MM-DD') as anskaffet,
         to_char(a.avskrives_fra, 'YYYY-MM-DD') as avskrives_fra, a.kostpris::float8 as kostpris, a.restverdi::float8 as restverdi,
         a.levetid_mnd, a.konto, a.avskrivningskonto, a.skatt, a.skatt_kostpris::float8 as skatt_kostpris, a.skatt_sats::float8 as skatt_sats,
         to_char(a.tidligere_til, 'YYYY-MM-DD') as tidligere_til, a.tidligere_avskrevet::float8 as tidligere_avskrevet,
         a.skatt_inngaende::float8 as skatt_inngaende, to_char(a.avgang_dato, 'YYYY-MM-DD') as avgang_dato, a.avgang_type,
         a.avgang_vederlag::float8 as avgang_vederlag
    from faktura.anleggsmidler a`;
export const HENDELSER = `
  select h.id, h.anleggsmiddel_id, h.type, to_char(h.dato, 'YYYY-MM-DD') as dato, to_char(h.maaned, 'YYYY-MM') as maaned,
         h.belop::float8 as belop, h.vederlag::float8 as vederlag, h.tekst, h.bilag_id, b.serie || '-' || b.aar || '-' || b.nummer as bilag, h.reversert
    from faktura.anleggshendelser h join faktura.bilag b on b.org_id = h.org_id and b.id = h.bilag_id`;

export async function hentAnlegg(db: Db, org: string, id?: string) {
  const anlegg = await alle<Anleggsmiddel>(db, `${ANLEGG} where a.org_id = $1 ${id ? "and a.id = $2" : ""} order by a.nummer`, id ? [org, id] : [org]);
  const hendelser = anlegg.length
    ? await alle<Hendelse>(db, `${HENDELSER} where h.org_id = $1 and h.anleggsmiddel_id = any($2::uuid[]) order by h.dato, h.opprettet`, [org, anlegg.map((a) => a.id)])
    : [];
  return { anlegg, hendelser };
}

// --- Månedene ----------------------------------------------------------------------------------

const ore = (n: number) => Math.round(Number(n) * 100);
const kr = (o: number) => o / 100;
export const mnd = (dato: string) => dato.slice(0, 7);
export function plussMnd(m: string, n: number) {
  const [a, b] = m.split("-").map(Number) as [number, number];
  const t = a * 12 + (b - 1) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`;
}
export function mndMellom(fra: string, til: string) {
  const [a1, m1] = fra.split("-").map(Number) as [number, number];
  const [a2, m2] = til.split("-").map(Number) as [number, number];
  return a2 * 12 + m2 - (a1 * 12 + m1);
}
export function sisteDag(m: string) {
  const [a, b] = m.split("-").map(Number) as [number, number];
  return `${m}-${String(new Date(Date.UTC(a, b, 0)).getUTCDate()).padStart(2, "0")}`;
}
const storst = (a: string, b: string) => (a > b ? a : b);

// --- Planen --------------------------------------------------------------------------------------

export type Planmaaned = { maaned: string; belop: number; bokfort: boolean; bilag: string | null; verdi: number };

const gjelder = (a: Anleggsmiddel, hendelser: Hendelse[]) => hendelser.filter((h) => h.anleggsmiddel_id === a.id && !h.reversert);
const endring = (h: Hendelse) => (h.type === "nedskrivning" ? -ore(h.belop) : h.type === "reversering" ? ore(h.belop) : 0);

// Den første måneden som avskrives i HI4 (etter det som er ført i et annet system), og den siste i
// levetiden.
export function forsteMaaned(a: Anleggsmiddel) {
  const start = mnd(a.avskrives_fra);
  return a.tidligere_til ? storst(start, plussMnd(mnd(a.tidligere_til), 1)) : start;
}
export const sisteMaaned = (a: Anleggsmiddel) => (a.levetid_mnd ? plussMnd(mnd(a.avskrives_fra), a.levetid_mnd - 1) : null);

// Avskrivningsplanen måned for måned, med det som er bokført, og verdien etter hver måned. Uten
// levetid (tomt) er planen tom.
export function avskrivningsplan(a: Anleggsmiddel, hendelser: Hendelse[]): Planmaaned[] {
  const slutt = sisteMaaned(a);
  if (!slutt) return [];
  const mine = gjelder(a, hendelser);
  const bokfort = new Map(mine.filter((h) => h.type === "avskrivning").map((h) => [h.maaned!, h]));
  const andre = mine.filter((h) => h.type === "nedskrivning" || h.type === "reversering").sort((x, y) => x.dato.localeCompare(y.dato));
  const avgang = a.avgang_dato ? mnd(a.avgang_dato) : null;
  const forst = forsteMaaned(a);
  const sistBokfort = [...bokfort.keys()].sort().at(-1) ?? null;
  const sist = sistBokfort && sistBokfort > slutt ? sistBokfort : slutt;
  const rest = ore(a.restverdi);
  let verdi = ore(a.kostpris) - ore(a.tidligere_avskrevet);
  let i = 0;
  while (i < andre.length && mnd(andre[i]!.dato) < forst) verdi += endring(andre[i++]!);
  const ut: Planmaaned[] = [];
  const legg = (m: string) => {
    const b = bokfort.get(m);
    let belop: number;
    if (b) belop = ore(b.belop);
    else {
      const igjen = mndMellom(m, slutt) + 1;
      belop = Math.max(0, igjen <= 1 ? verdi - rest : Math.round((verdi - rest) / igjen));
    }
    verdi -= belop;
    while (i < andre.length && mnd(andre[i]!.dato) === m) verdi += endring(andre[i++]!);
    ut.push({ maaned: m, belop: kr(belop), bokfort: !!b, bilag: b?.bilag ?? null, verdi: kr(verdi) });
  };
  let m = forst;
  for (; m <= sist && (!avgang || m <= avgang); m = plussMnd(m, 1)) legg(m);
  // Levetiden er gjort kortere enn det som er bokført: resten avskrives måneden etter.
  if (m > slutt && (!avgang || m <= avgang) && verdi - rest > 0 && ut.at(-1)?.bokfort) legg(m);
  return ut;
}

// Den bokførte verdien per dato (det som er bokført til og med datoen): kostprisen minus det som er
// avskrevet før HI4, avskrivningene, nedskrivningene og reverseringene; null etter avgangen.
export function bokfortVerdi(a: Anleggsmiddel, hendelser: Hendelse[], dato: string) {
  const mine = gjelder(a, hendelser).filter((h) => h.dato <= dato);
  if (mine.some((h) => h.type === "avgang")) return 0;
  if (a.anskaffet > dato) return 0;
  const o =
    ore(a.kostpris) -
    ore(a.tidligere_avskrevet) -
    mine.reduce((s, h) => s + (h.type === "avskrivning" || h.type === "nedskrivning" ? ore(h.belop) : h.type === "reversering" ? -ore(h.belop) : 0), 0);
  return kr(o);
}

// Summene for registeret: det som er avskrevet (før HI4 og bokført) og nedskrevet (netto) til og
// med datoen, og verdien.
export function status(a: Anleggsmiddel, hendelser: Hendelse[], dato: string) {
  const mine = gjelder(a, hendelser).filter((h) => h.dato <= dato);
  const sum = (t: Hendelsestype) => kr(mine.filter((h) => h.type === t).reduce((s, h) => s + ore(h.belop), 0));
  const plan = avskrivningsplan(a, hendelser);
  const bokfortTil = [...plan].reverse().find((p) => p.bokfort)?.maaned ?? (a.tidligere_til ? mnd(a.tidligere_til) : null);
  const neste = plan.find((p) => !p.bokfort && p.belop > 0) ?? null;
  const verdi = bokfortVerdi(a, hendelser, dato);
  const slutt = sisteMaaned(a);
  return {
    avskrevet: kr(ore(a.tidligere_avskrevet) + ore(sum("avskrivning"))),
    nedskrevet: kr(ore(sum("nedskrivning")) - ore(sum("reversering"))),
    verdi,
    bokfort_til: bokfortTil,
    neste: neste ? { maaned: neste.maaned, belop: neste.belop } : null,
    slutt,
    tilstand: a.avgang_type
      ? a.avgang_type === "salg"
        ? "solgt"
        : "utrangert"
      : !slutt
        ? "aktiv"
        : !neste && plan.length && plan.at(-1)!.verdi <= a.restverdi
          ? "avskrevet"
          : "aktiv",
  } as const;
}

// Planen per år: verdien ved inngangen, avskrivningene, nedskrivningene (netto), avgangen og verdien
// ved utgangen (bokført for månedene som er bokført, ellers etter planen).
export type Planaar = { aar: number; inngaende: number; avskrivning: number; nedskrivning: number; avgang: number; utgaende: number; bokfort: boolean };
export function aarsplan(a: Anleggsmiddel, hendelser: Hendelse[]): Planaar[] {
  const plan = avskrivningsplan(a, hendelser);
  const mine = gjelder(a, hendelser);
  const forst = Number((plan[0]?.maaned ?? mnd(a.tidligere_til ? plussMnd(mnd(a.tidligere_til), 1) : a.anskaffet)).slice(0, 4));
  const avgang = mine.find((h) => h.type === "avgang") ?? null;
  const sist = Number((avgang?.dato ?? plan.at(-1)?.maaned ?? a.anskaffet).slice(0, 4));
  let verdi = ore(a.kostpris) - ore(a.tidligere_avskrevet);
  // Nedskrivninger før den første måneden i planen er med i verdien ved inngangen.
  const forsteMnd = plan[0]?.maaned ?? null;
  const tidlig = (h: Hendelse) => !!forsteMnd && mnd(h.dato) < forsteMnd;
  for (const h of mine) if (endring(h) && tidlig(h)) verdi += endring(h);
  const ut: Planaar[] = [];
  for (let aar = forst; aar <= sist; aar++) {
    const i = verdi;
    const avskr = plan.filter((p) => p.maaned.startsWith(`${aar}-`)).reduce((s, p) => s + ore(p.belop), 0);
    const ned = mine.filter((h) => endring(h) && h.dato.startsWith(`${aar}-`) && !tidlig(h)).reduce((s, h) => s - endring(h), 0);
    const ut_ = avgang && avgang.dato.startsWith(`${aar}-`) ? i - avskr - ned : 0;
    verdi = i - avskr - ned - ut_;
    ut.push({
      aar,
      inngaende: kr(i),
      avskrivning: kr(avskr),
      nedskrivning: kr(ned),
      avgang: kr(ut_),
      utgaende: kr(verdi),
      bokfort: plan.filter((p) => p.maaned.startsWith(`${aar}-`)).every((p) => p.bokfort),
    });
  }
  return ut;
}

// --- Bilagene ----------------------------------------------------------------------------------

export type Postering = { konto: string; belop: number; tekst: string; mva_kode?: string | null };
export type Bilagsforslag = {
  dato: string;
  tekst: string;
  posteringer: Postering[];
  hendelser: { anleggsmiddel_id: string; type: Hendelsestype; maaned?: string; belop: number; vederlag?: number; avgang_type?: string; tekst?: string | null }[];
};
const navnPaa = (a: Anleggsmiddel) => `${a.navn} (nr. ${a.nummer})`;
export const avskrivningskonto = (a: Anleggsmiddel, k: Record<Regnskapsrolle, string>) =>
  a.avskrivningskonto ?? k[KATEGORIER[a.kategori].avskrivning ?? "avskrivning_driftsmidler"];

// Avskrivningene for en måned: kostnaden mot balansekontoen for hvert anleggsmiddel. Bilaget står
// på den siste dagen i måneden (eller avgangsdatoen når det er den siste måneden før en avgang).
export function avskrivningsbilag(maaned: string, linjer: { a: Anleggsmiddel; belop: number }[], k: Record<Regnskapsrolle, string>, dato = sisteDag(maaned)): Bilagsforslag {
  const ok = linjer.filter((l) => ore(l.belop) > 0);
  return {
    dato,
    tekst: `Avskrivninger ${maanedNavn(`${maaned}-01`)}`,
    posteringer: ok.flatMap(({ a, belop }) => [
      { konto: avskrivningskonto(a, k), belop, tekst: `Avskrivning: ${navnPaa(a)}` },
      { konto: a.konto, belop: -belop, tekst: `Avskrivning: ${navnPaa(a)}` },
    ]),
    hendelser: ok.map(({ a, belop }) => ({ anleggsmiddel_id: a.id, type: "avskrivning", maaned: `${maaned}-01`, belop })),
  };
}

// Det som ikke er bokført til og med måneden, per måned (månedsavslutningen).
export function avskrivningsforslag(anlegg: Anleggsmiddel[], hendelser: Hendelse[], til: string) {
  const per = new Map<string, { a: Anleggsmiddel; belop: number }[]>();
  for (const a of anlegg) {
    if (a.avgang_dato) continue;
    for (const p of avskrivningsplan(a, hendelser)) {
      if (p.bokfort || p.maaned > til || ore(p.belop) <= 0) continue;
      per.set(p.maaned, [...(per.get(p.maaned) ?? []), { a, belop: p.belop }]);
    }
  }
  return [...per.entries()].sort(([x], [y]) => x.localeCompare(y)).map(([maaned, linjer]) => ({ maaned, linjer }));
}

export function anskaffelsesbilag(a: Anleggsmiddel, motkonto: string, mva: number, k: Record<Regnskapsrolle, string>): Bilagsforslag {
  const tekst = `Anskaffelse: ${navnPaa(a)}`;
  return {
    dato: a.anskaffet,
    tekst,
    posteringer: [
      { konto: a.konto, belop: a.kostpris, tekst },
      ...(ore(mva) > 0 ? [{ konto: k.inngaende_mva, belop: mva, tekst: "Inngående merverdiavgift" }] : []),
      { konto: motkonto, belop: -kr(ore(a.kostpris) + ore(mva)), tekst },
    ],
    hendelser: [{ anleggsmiddel_id: a.id, type: "anskaffelse", belop: a.kostpris }],
  };
}

export function nedskrivningsbilag(a: Anleggsmiddel, dato: string, belop: number, reversering: boolean, grunn: string | null, k: Record<Regnskapsrolle, string>): Bilagsforslag {
  const tekst = `${reversering ? "Reversert nedskrivning" : "Nedskrivning"}: ${navnPaa(a)}`;
  const kostnad = { konto: k.nedskrivning, belop: reversering ? -belop : belop, tekst };
  const eiendel = { konto: a.konto, belop: reversering ? belop : -belop, tekst };
  return {
    dato,
    tekst,
    posteringer: reversering ? [eiendel, kostnad] : [kostnad, eiendel],
    hendelser: [{ anleggsmiddel_id: a.id, type: reversering ? "reversering" : "nedskrivning", belop, tekst: grunn }],
  };
}

// Salg eller utrangering: vederlaget (med mva) på motkontoen, mva-en, den bokførte verdien ut, og
// forskjellen som gevinst eller tap.
export function avgangsbilag(
  a: Anleggsmiddel,
  v: { dato: string; type: "salg" | "utrangering"; vederlag: number; mva: number; motkonto: string; verdi: number; tekst: string | null },
  k: Record<Regnskapsrolle, string>,
): Bilagsforslag {
  const tekst = `${v.type === "salg" ? "Salg" : "Utrangering"}: ${navnPaa(a)}`;
  const vederlag = ore(v.vederlag);
  const mva = ore(v.mva);
  const verdi = ore(v.verdi);
  const p: Postering[] = [];
  if (vederlag + mva > 0) p.push({ konto: v.motkonto, belop: kr(vederlag + mva), tekst });
  if (mva > 0) p.push({ konto: k.utgaende_mva, belop: kr(-mva), tekst: "Utgående merverdiavgift" });
  if (verdi !== 0) p.push({ konto: a.konto, belop: kr(-verdi), tekst });
  const diff = vederlag - verdi;
  if (diff > 0) p.push({ konto: k.gevinst, belop: kr(-diff), tekst: `Gevinst: ${navnPaa(a)}` });
  if (diff < 0) p.push({ konto: k.tap, belop: kr(-diff), tekst: `Tap: ${navnPaa(a)}` });
  return {
    dato: v.dato,
    tekst,
    posteringer: p,
    hendelser: [{ anleggsmiddel_id: a.id, type: "avgang", belop: kr(verdi), vederlag: kr(vederlag), avgang_type: v.type, tekst: v.tekst }],
  };
}

// Fører bilaget i databasen (som brukeren) og gir nummeret.
export async function bokfor(db: Db, org: string, b: Bilagsforslag) {
  if (!b.hendelser.length) throw new ApiFeil(400, "Ingenting å bokføre");
  const r = await en<{ id: string }>(db, "select faktura.bokfor_anlegg($1, $2, $3, $4, $5) as id", [
    org,
    b.dato,
    b.tekst,
    JSON.stringify(b.posteringer),
    JSON.stringify(b.hendelser),
  ]);
  return (await en<{ id: string; bilagsnummer: string; dato: string; tekst: string }>(
    db,
    "select id, serie || '-' || aar || '-' || nummer as bilagsnummer, to_char(dato, 'YYYY-MM-DD') as dato, tekst from faktura.bilag where id = $1",
    [r!.id],
  ))!;
}
