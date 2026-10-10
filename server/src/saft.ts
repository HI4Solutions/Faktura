// SAF-T Regnskap (Norwegian SAF-T Financial, github.com/Skatteetaten/saf-t): hele regnskapet for et år i
// Skatteetatens standardformat, som Skatteetaten kan be om (bokføringsforskriften § 7-8) og som
// regnskapsføreren kan lese inn. Versjon 1.30 for årene før 2027 og 1.40 fra 2027 (den er bakover-
// kompatibel, og filen bruker ikke det nye). Filen har:
//  - Header: selskapet (organisasjonsnummer, adresse, kontakt, mva-registreringen og bankkontoen),
//    perioden (1–12) og at grunnlaget er regnskapet (A);
//  - MasterFiles: kontoene med inngående og utgående saldo og grupperingen etter næringsspesifikasjonen
//    (GroupingCategory og GroupingCode), kundene og leverandørene med saldoen på reskontrokontoen, og
//    mva-kodene (Skatteetatens standardkoder, så TaxCode og StandardTaxCode er like);
//  - GeneralLedgerEntries: alle bilagene i året, en journal per bilagserie, med linjene i debet eller
//    kredit, kunden eller leverandøren på reskontrolinjene og mva-informasjonen på grunnlagslinjene
//    (koden, satsen, grunnlaget og avgiften), ikke på avgiftslinjene (som eksempelfilen til
//    Skatteetaten).
import { Hono, type Context } from "hono";
import { z } from "zod";
import { hentRegnskapsoppsett, regnskapskontoer } from "./anlegg.js";
import { alle, en, somBruker, type Db } from "./db.js";
import { ApiFeil } from "./feil.js";
import { navnPaaKonto } from "./hovedbok.js";
import { avgiftskontoer, MVA_KODER, mvaSats, omvendtAvgift } from "./mva.js";
import { bokforSalgNaa } from "./salgBokforing.js";

const osloNaa = () => {
  const d = new Date();
  const dato = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Oslo" }).format(d);
  const tid = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Oslo", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(d);
  return { dato, tid };
};

// --- XML -------------------------------------------------------------------------------------------

type Innhold = string | number | null | undefined | false | Innhold[];
const esc = (s: unknown) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);
const flat = (n: Innhold): string => (Array.isArray(n) ? n.map(flat).join("") : n || n === 0 ? String(n) : "");
// Et element med ferdig XML inni (tomme elementer utelates).
function el(navn: string, innhold: Innhold): string {
  const inni = flat(innhold);
  return inni === "" ? "" : `<${navn}>${inni}</${navn}>`;
}
// Et element med tekst, kuttet til lengden skjemaet tillater.
const t = (navn: string, verdi: unknown, maks = 256) => {
  const s = verdi == null ? "" : String(verdi).replace(/\s+/g, " ").trim();
  return s ? `<${navn}>${esc(s.slice(0, maks))}</${navn}>` : "";
};
// Beløp i øre, så summene blir eksakte; i filen med to desimaler og punktum.
const ore = (v: number) => Math.round(v * 100);
const belop = (o: number) => `${o < 0 ? "-" : ""}${Math.floor(Math.abs(o) / 100)}.${String(Math.abs(o) % 100).padStart(2, "0")}`;
const prosent = (n: number) => String(n);

// --- Grupperingen (næringsspesifikasjonen) -----------------------------------------------------------

// Kodene i næringsspesifikasjonen per kategori (Skatteetaten/saf-t, «Grouping Category Code 2025-2026»,
// naeringsspesifikasjon.csv), uten kodene for bank, forsikring, IFRS og kommuner. Bare kodene som gjelder
// for aksjeselskaper (og de fleste enkeltpersonforetak): ikke kodene som bare gjelder petroleumsselskaper,
// samvirkeforetak, selskaper med deltakerfastsetting (ANS) eller foretak uten full regnskapsplikt
// (Skatteetatens oversikt over bransjespesifikke koder, «Guidance for Codes in Income Statements»).
const GRUPPER: Record<string, number[]> = {
  balanseverdiForAnleggsmiddel: [1000, 1020, 1070, 1080, 1105, 1115, 1117, 1120, 1130, 1150, 1160, 1180, 1205, 1221, 1225, 1238, 1280, 1290, 1312, 1313, 1320, 1331, 1332, 1340, 1350, 1360, 1370, 1380, 1390, 1395],
  balanseverdiForOmloepsmiddel: [1400, 1401, 1490, 1500, 1501, 1530, 1560, 1565, 1570, 1780, 1800, 1810, 1830, 1840, 1880, 1895, 1900, 1920, 1950],
  egenkapital: [2000, 2010, 2015, 2020, 2030, 2043, 2045, 2050, 2055, 2080],
  langsiktigGjeld: [2100, 2120, 2130, 2160, 2180, 2200, 2210, 2220, 2250, 2260, 2280, 2290],
  kortsiktigGjeld: [2310, 2320, 2330, 2380, 2400, 2460, 2500, 2510, 2600, 2740, 2770, 2790, 2800, 2900, 2910, 2920, 2949, 2950, 2970, 2980, 2990],
  salgsinntekt: [3000, 3100, 3200, 3300],
  annenDriftsinntekt: [3400, 3500, 3600, 3695, 3700, 3710, 3850, 3870, 3880, 3885, 3900],
  varekostnad: [4005, 4295, 4500, 4995],
  loennskostnad: [5000, 5300, 5400, 5420, 5900],
  annenDriftskostnad: [
    6000, 6050, 6100, 6200, 6300, 6340, 6395, 6400, 6440, 6500, 6600, 6695, 6700, 6995, 7000, 7020, 7040, 7080, 7099, 7155, 7165, 7295, 7330, 7370, 7440, 7490, 7500, 7565,
    7600, 7700, 7830, 7860, 7880, 7885,
  ],
  finansinntekt: [8005, 8030, 8050, 8060, 8074, 8079, 8080, 8090],
  finanskostnad: [8100, 8105, 8115, 8130, 8150, 8160, 8174, 8179],
  skattekostnad: [8300, 8321, 8322, 8323, 8324],
  "resultatDisponeringForSAF-T": [8800],
};
// Kategorien etter kontogruppen (NS 4102).
const KATEGORI: [number, number, string][] = [
  [1000, 1399, "balanseverdiForAnleggsmiddel"],
  [1400, 1999, "balanseverdiForOmloepsmiddel"],
  [2000, 2099, "egenkapital"],
  [2100, 2299, "langsiktigGjeld"],
  [2300, 2999, "kortsiktigGjeld"],
  [3000, 3399, "salgsinntekt"],
  [3400, 3999, "annenDriftsinntekt"],
  [4000, 4999, "varekostnad"],
  [5000, 5999, "loennskostnad"],
  [6000, 7999, "annenDriftskostnad"],
  [8000, 8099, "finansinntekt"],
  [8100, 8299, "finanskostnad"],
  [8300, 8799, "skattekostnad"],
  [8800, 8999, "resultatDisponeringForSAF-T"],
];
// Kontoene i standard kontoplan der den nærmeste koden under ikke er den riktige (det første treffet
// gjelder). Kontoene appen bruker selv er med: 1120 for fast teknisk installasjon, 1240 for varebiler,
// 3800 og 7800 for gevinst og tap ved avgang, 2970 for uopptjent inntekt.
const UNNTAK: [number, number, number][] = [
  [1081, 1099, 1020], // andre immaterielle eiendeler
  [1100, 1109, 1115], // bygninger
  [1117, 1117, 1117],
  [1110, 1129, 1120], // fast teknisk installasjon (1110 i standard kontoplan)
  [1140, 1149, 1150], // jord- og skogbrukseiendommer
  [1170, 1179, 1115], // annen fast eiendom
  [1200, 1209, 1205], // maskiner og anlegg
  [1210, 1219, 1130], // maskiner og anlegg under utførelse
  [1220, 1224, 1221], // skip og rigger
  [1225, 1229, 1225], // fly
  [1230, 1234, 1205], // personbiler
  [1235, 1249, 1238], // varebiler, lastebiler og busser
  [1250, 1279, 1205], // inventar og verktøy
  [1289, 1299, 1290], // andre driftsmidler
  [1300, 1319, 1313], // aksjer og andeler i datterselskap og konsern
  [1330, 1339, 1332], // investeringer i tilknyttet selskap
  [1390, 1393, 1390],
  [1394, 1394, 1395], // overfinansiering av pensjonsforpliktelser
  [1395, 1399, 1390], // depositum, leietakerinnskudd o.l.
  [1402, 1489, 1400],
  [1550, 1559, 1501], // kundefordringer på selskap i samme konsern
  [1580, 1584, 1500], // avsetning for tap på kundefordringer
  [1820, 1829, 1800], // ikke børsnoterte aksjer
  [1850, 1859, 1830], // markedsbaserte sertifikater
  [1870, 1879, 1880], // opsjoner
  [1960, 1999, 1920], // bankinnskudd i utlandet
  [2040, 2044, 2043], // fond for vurderingsforskjeller
  [2056, 2079, 2050], // privatkontoene i enkeltpersonforetak
  [2090, 2099, 2050],
  [2340, 2379, 2380], // valutalån og byggelån
  [2700, 2739, 2740],
  [2780, 2789, 2770],
  [2930, 2949, 2949],
  [2960, 2964, 2990], // påløpt kostnad
  [2965, 2979, 2970], // forskuddsbetalt (uopptjent) inntekt
  [2980, 2989, 2980], // avsetninger
  [3000, 3099, 3000],
  [3610, 3699, 3695], // andre leieinntekter
  [3700, 3799, 3700], // provisjon
  [3800, 3849, 3880],
  [3880, 3889, 3880], // gevinst ved avgang av immaterielle eiendeler og varige driftsmidler
  [3890, 3899, 3885], // gevinst ved avgang av finansielle anleggsmidler
  [4000, 4294, 4005],
  [4296, 4499, 4005],
  [4600, 4989, 4005], // annen varekostnad og periodisering
  [4990, 4999, 4995],
  [5430, 5499, 5400], // finansskatt
  [5500, 5599, 5300], // annen kostnadsgodtgjørelse
  [5600, 5899, 5000], // tilskudd og refusjoner (lærlingtilskudd, sykepenger)
  [5900, 5999, 5900], // også OTP (5950 i standard kontoplan); «egen pensjonsordning» gjelder bare enkeltpersonforetak
  [6000, 6049, 6000], // avskrivninger, også på goodwill og andre immaterielle eiendeler
  [6050, 6099, 6050],
  [6310, 6339, 6395], // renovasjon, vann og avløp
  [6360, 6394, 6395],
  [6410, 6439, 6400], // leie av datasystemer o.l.
  [6450, 6499, 6400],
  [6610, 6694, 6695],
  [6800, 6994, 6995],
  [6995, 6999, 6995],
  [7081, 7098, 7020], // annen kostnad transportmidler
  [7100, 7139, 7155],
  [7140, 7149, 7165],
  [7150, 7159, 7155],
  [7160, 7199, 7165],
  [7200, 7299, 7295], // provisjon
  [7300, 7349, 7330],
  [7350, 7389, 7370], // representasjon
  [7390, 7399, 7330], // annen salgskostnad
  [7400, 7419, 7490], // kontingenter
  [7420, 7489, 7440], // gaver
  [7550, 7599, 7565], // garanti og service
  [7700, 7799, 7700],
  [7800, 7819, 7880],
  [7820, 7859, 7830], // tap på fordringer
  [7880, 7889, 7880],
  [7890, 7899, 7885], // tap ved avgang av finansielle anleggsmidler
  [7900, 7999, 7700],
  [8040, 8049, 8050], // skattefrie renteinntekter
  [8070, 8074, 8090], // aksjeutbytte
  [8100, 8109, 8100],
  [8110, 8129, 8115], // nedskrivning av finansielle eiendeler
  [8140, 8149, 8150], // rentekostnad uten fradragsrett
];

// Posten i næringsspesifikasjonen for et anleggsmiddel: etter kategorien, og saldogruppen der den
// sier mer (f.eks. et fartøy registrert som maskin).
function anleggspost(a: { kategori: string; skatt: string }): number {
  const etterGruppe: Record<string, number> = { a: 1280, c: 1238, e: 1221, f: 1225, g: 1117, h: 1115, i: 1105, j: 1120 };
  switch (a.kategori) {
    case "goodwill":
      return 1080;
    case "immateriell":
      return 1020;
    case "tomt":
      return 1150;
    case "bygning":
      return a.skatt === "i" ? 1105 : 1115;
    case "teknisk_installasjon":
      return 1120;
    case "kontormaskiner":
      return 1280;
    case "varebil":
      return 1238;
    case "annet":
      return etterGruppe[a.skatt] ?? 1290;
    default:
      return etterGruppe[a.skatt] ?? 1205;
  }
}

// Balansekontoene til anleggsmidlene med posten etter hva som står på dem, når alle anleggsmidlene på
// kontoen hører til samme post (ellers gjelder kontonummeret).
export function anleggsposter(anlegg: { konto: string; kategori: string; skatt: string }[]): Map<string, string> {
  const poster = new Map<string, Set<number>>();
  for (const a of anlegg) poster.set(a.konto, (poster.get(a.konto) ?? new Set()).add(anleggspost(a)));
  return new Map([...poster].filter(([, p]) => p.size === 1).map(([konto, p]) => [konto, String([...p][0])]));
}

export async function hentAnleggsposter(db: Db, org: string) {
  return anleggsposter(await alle<{ konto: string; kategori: string; skatt: string }>(db, "select konto, kategori, skatt from faktura.anleggsmidler where org_id = $1", [org]));
}

export function gruppering(konto: string, anlegg?: Map<string, string>): { kategori: string; kode: string } {
  const n = Number(konto.slice(0, 4));
  const kategori = KATEGORI.find(([fra, til]) => n >= fra && n <= til)?.[2] ?? "annenDriftskostnad";
  const post = kategori === "balanseverdiForAnleggsmiddel" ? anlegg?.get(konto) : undefined;
  if (post) return { kategori, kode: post };
  const unntak = UNNTAK.find(([fra, til]) => n >= fra && n <= til);
  if (unntak) return { kategori, kode: String(unntak[2]) };
  const koder = GRUPPER[kategori]!;
  const kode = koder.includes(n) ? n : ([...koder].reverse().find((k) => k <= n) ?? koder[0]!);
  return { kategori, kode: String(kode) };
}

// --- Dataene ---------------------------------------------------------------------------------------

type Bilag = { id: string; serie: string; aar: number; nummer: number; dato: string; tekst: string; kilde: string; opprettet: string; kunde: string | null; utgift: string | null };
type Post = { bilag_id: string; rekke: number; konto: string; belop: number; tekst: string | null; mva_kode: string | null; dato: string };
type Part = { id: string; navn: string; orgnr: string | null };

const SERIER: Record<string, string> = {
  F: "Fakturaer og kreditnotaer",
  B: "Bank: innbetalinger, refusjoner og bankposter",
  U: "Utgifter og betalingen av dem",
  L: "Lønn og refusjoner fra NAV",
  A: "Anleggsmidler",
  P: "Periodiseringer",
  V: "Merverdiavgift: oppgjør og justering",
  Å: "Årsoppgjør",
  M: "Manuelle bilag",
};

// Leverandøren som part: organisasjonsnummeret, eller navnet (forkortet) når det mangler.
const leverandorId = (orgnr: string | null, navn: string | null) =>
  orgnr ?? `L-${(navn ?? "ukjent").toUpperCase().replace(/[^A-ZÆØÅ0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 33) || "UKJENT"}`;

export type Saft = { filnavn: string; xml: string; antallBilag: number };

export async function lagSaft(db: Db, org: string, aar: number, bruker: { navn: string | null; epost: string } | null): Promise<Saft> {
  await bokforSalgNaa(db, org);
  const fra = `${aar}-01-01`;
  const til = `${aar}-12-31`;
  const o = await en<{
    navn: string;
    orgnr: string | null;
    mva_registrert: boolean;
    adresse: string | null;
    postnr: string | null;
    poststed: string | null;
    land: string;
    epost: string | null;
    telefon: string | null;
    kontonr: string | null;
  }>(db, "select navn, orgnr, mva_registrert, adresse, postnr, poststed, land, epost, telefon, kontonr from faktura.organisasjoner where id = $1", [org]);
  if (!o) throw new ApiFeil(404, "Fant ikke organisasjonen");
  if (!o.orgnr) throw new ApiFeil(409, "SAF-T krever organisasjonsnummer (Innstillinger → Organisasjon)");
  const oppsett = await hentRegnskapsoppsett(db, org);
  const k = regnskapskontoer(oppsett);
  const avgift = avgiftskontoer(oppsett);
  const navn = await navnPaaKonto(db, org);
  const anlegg = await hentAnleggsposter(db, org);

  // Alle bilagene til og med året (saldoene trenger det som er før), med kunden (fakturaen eller
  // innbetalingen) og utgiften de kommer fra.
  const bilag = await alle<Bilag>(
    db,
    `select b.id, b.serie, b.aar, b.nummer, to_char(b.dato, 'YYYY-MM-DD') as dato, b.tekst, b.kilde,
            to_char(b.opprettet at time zone 'Europe/Oslo', 'YYYY-MM-DD') as opprettet,
            case b.kilde when 'faktura' then (select f.kunde_id::text from faktura.fakturaer f where f.id = b.kilde_id)
                         when 'innbetaling' then (select f.kunde_id::text from faktura.betalinger x join faktura.fakturaer f on f.id = x.faktura_id where x.id = b.kilde_id)
            end as kunde,
            case when b.kilde in ('utgift', 'utgift_betaling') then b.kilde_id::text end as utgift
       from faktura.bilag b
      where b.org_id = $1 and b.dato <= $2::date
      order by b.dato, b.serie, b.nummer`,
    [org, til],
  );
  const poster = await alle<Post>(
    db,
    `select p.bilag_id, p.rekke, p.konto, p.belop::float8 as belop, p.tekst, p.mva_kode, to_char(b.dato, 'YYYY-MM-DD') as dato
       from faktura.posteringer p join faktura.bilag b on b.org_id = p.org_id and b.id = p.bilag_id
      where b.org_id = $1 and b.dato <= $2::date
      order by b.dato, b.serie, b.nummer, p.rekke`,
    [org, til],
  );
  const kunder = new Map(
    (
      await alle<{ id: string; nummer: string; navn: string; orgnr: string | null }>(
        db,
        "select id::text, kundenummer::text as nummer, navn, orgnr from faktura.kunder where org_id = $1",
        [org],
      )
    ).map((x) => [x.id, { id: x.nummer, navn: x.navn, orgnr: x.orgnr } as Part]),
  );
  const utgifter = new Map(
    (
      await alle<{ id: string; leverandor: string | null; orgnr: string | null }>(db, "select id::text, leverandor, orgnr from faktura.utgifter where org_id = $1", [org])
    ).map((x) => [x.id, { id: leverandorId(x.orgnr, x.leverandor), navn: x.leverandor ?? "Ukjent leverandør", orgnr: x.orgnr } as Part]),
  );
  const perBilag = new Map(bilag.map((b) => [b.id, b]));

  // Kunden eller leverandøren på en postering på reskontrokontoen.
  const part = (p: Post): { kunde?: Part; leverandor?: Part } => {
    const b = perBilag.get(p.bilag_id)!;
    if (p.konto === k.kundefordringer && b.kunde && kunder.has(b.kunde)) return { kunde: kunder.get(b.kunde)! };
    if (p.konto === k.leverandorgjeld && b.utgift && utgifter.has(b.utgift)) return { leverandor: utgifter.get(b.utgift)! };
    return {};
  };

  // Saldoene: kontoene (resultatkontoene fra 1. januar) og partene på reskontrokontoene.
  type Saldo = { inn: number; ut: number };
  const kontoer = new Map<string, Saldo>();
  const kundeSaldo = new Map<string, Saldo & { part: Part }>();
  const levSaldo = new Map<string, Saldo & { part: Part }>();
  const leggTil = (m: Map<string, Saldo>, n: string, o: number, foer: boolean) => {
    const s = m.get(n) ?? { inn: 0, ut: 0 };
    if (foer) s.inn += o;
    s.ut += o;
    m.set(n, s);
  };
  let bevegelse = false;
  for (const p of poster) {
    const foer = p.dato < fra;
    const balanse = p.konto.startsWith("1") || p.konto.startsWith("2");
    if (foer && !balanse) continue;
    const o = ore(p.belop);
    if (!foer) bevegelse = true;
    leggTil(kontoer, p.konto, o, foer);
    const x = part(p);
    if (x.kunde) {
      const s = kundeSaldo.get(x.kunde.id) ?? { inn: 0, ut: 0, part: x.kunde };
      if (foer) s.inn += o;
      s.ut += o;
      kundeSaldo.set(x.kunde.id, s);
    }
    if (x.leverandor) {
      const s = levSaldo.get(x.leverandor.id) ?? { inn: 0, ut: 0, part: x.leverandor };
      if (foer) s.inn += o;
      s.ut += o;
      levSaldo.set(x.leverandor.id, s);
    }
  }
  if (!bevegelse && ![...kontoer.values()].some((s) => s.ut)) throw new ApiFeil(409, `Ingen bilag i regnskapet for ${aar}`);

  // Mva-informasjonen for grunnlagslinjene i et bilag: avgiften per kode fordelt på grunnlagslinjene
  // etter beløpet (den beregnede avgiften for kjøp med omvendt avgiftsplikt). Har linjene ulikt
  // fortegn (salg av et anleggsmiddel med tap: verdien som går ut, og tapet), fordeles den etter
  // fortegnet, så grunnlaget og avgiften går opp i salgssummen og avgiften.
  const iAaret = poster.filter((p) => p.dato >= fra);
  const perBilagPoster = new Map<string, Post[]>();
  for (const p of iAaret) perBilagPoster.set(p.bilag_id, [...(perBilagPoster.get(p.bilag_id) ?? []), p]);
  const brukteKoder = new Set<string>();
  const skatt = new Map<Post, { kode: string; sats: number; grunnlag: number; avgift: number; debet: boolean }>();
  for (const ps of perBilagPoster.values()) {
    const grunnlag = ps.filter((p) => p.mva_kode && !avgift.has(p.konto));
    for (const kode of new Set(grunnlag.map((p) => p.mva_kode!))) {
      const linjer = grunnlag.filter((p) => p.mva_kode === kode);
      const omvendt = omvendtAvgift(kode);
      // Avgiften (øre, debet positivt): for omvendt avgiftsplikt den beregnede (positiv for et kjøp).
      const sum = ps
        .filter((p) => (p.mva_kode ?? avgift.get(p.konto)?.kode) === kode && avgift.has(p.konto))
        .filter((p) => (omvendt ? avgift.get(p.konto)!.art === "beregnet" : avgift.get(p.konto)!.art !== "beregnet" && avgift.get(p.konto)!.art !== "fradrag_utland"))
        .reduce((s, p) => s + ore(p.belop) * (omvendt ? -1 : 1), 0);
      const total = linjer.reduce((s, p) => s + Math.abs(ore(p.belop)), 0);
      const netto = linjer.reduce((s, p) => s + ore(p.belop), 0);
      const blandet = linjer.some((p) => p.belop > 0) && linjer.some((p) => p.belop < 0) && netto !== 0;
      let rest = sum;
      linjer.forEach((p, i) => {
        const del =
          i === linjer.length - 1 || !total
            ? rest
            : blandet
              ? Math.round((sum * ore(p.belop)) / netto)
              : Math.round((sum * Math.abs(ore(p.belop))) / total);
        rest -= del;
        const sats = mvaSats(kode);
        const g = omvendt && sats ? Math.round((Math.abs(del) * 100) / sats) : Math.abs(ore(p.belop));
        // Debet eller kredit: som avgiften, eller som grunnlagslinjen når det ikke er avgift (og for
        // omvendt avgiftsplikt, der avgiften er beregnet av kjøpet).
        const debet = omvendt || !del ? p.belop > 0 : del > 0;
        skatt.set(p, { kode, sats, grunnlag: g, avgift: Math.abs(del), debet });
        brukteKoder.add(kode);
      });
    }
  }

  // --- Filen ---------------------------------------------------------------------------------------
  const versjon = aar >= 2027 ? "1.40" : "1.30";
  const naa = osloNaa();
  // Kontaktpersonen (påkrevd): den som lager filen (navnet, ellers det foran @ i e-postadressen).
  const kontakt = (bruker?.navn ?? "").trim() || (bruker?.epost ?? o.epost ?? "Kontakt").split("@")[0]!;
  const [fornavn, ...etternavn] = kontakt.split(/\s+/).filter(Boolean);
  const saldo = (inn: number, ut: number) =>
    [
      inn >= 0 ? t("OpeningDebitBalance", belop(inn)) : t("OpeningCreditBalance", belop(-inn)),
      ut >= 0 ? t("ClosingDebitBalance", belop(ut)) : t("ClosingCreditBalance", belop(-ut)),
    ].join("");
  const kontoliste = [...kontoer.entries()].sort(([a], [b]) => a.localeCompare(b));
  const brukt = new Set(iAaret.map((p) => p.konto));
  const header = el("Header", [
    t("AuditFileVersion", versjon),
    t("AuditFileCountry", "NO"),
    t("AuditFileDateCreated", naa.dato),
    t("SoftwareCompanyName", "HI4 Solutions"),
    t("SoftwareID", "HI4 Faktura"),
    t("SoftwareVersion", "1.0"),
    el("Company", [
      t("RegistrationNumber", o.orgnr, 35),
      t("Name", o.navn),
      el("Address", [t("StreetName", o.adresse), t("City", o.poststed), t("PostalCode", o.postnr, 70), t("Country", o.land || "NO")]),
      el("Contact", [
        el("ContactPerson", [t("FirstName", fornavn, 35), t("LastName", etternavn.join(" ") || "-", 70)]),
        t("Telephone", o.telefon, 18),
        t("Email", o.epost ?? bruker?.epost, 70),
      ]),
      o.mva_registrert ? el("TaxRegistration", [t("TaxRegistrationNumber", o.orgnr, 35), t("TaxType", "MVA", 9), t("TaxAuthority", "Skatteetaten")]) : "",
      o.kontonr ? el("BankAccount", [t("BankAccountNumber", o.kontonr, 35), t("CurrencyCode", "NOK"), t("GeneralLedgerAccountID", k.bank, 70)]) : "",
    ]),
    t("DefaultCurrencyCode", "NOK"),
    el("SelectionCriteria", [t("PeriodStart", 1), t("PeriodStartYear", aar), t("PeriodEnd", 12), t("PeriodEndYear", aar)]),
    t("HeaderComment", `Regnskapet for ${aar} fra HI4 Faktura: kontoene, kundene, leverandørene, mva-kodene og alle bilagene.`),
    t("TaxAccountingBasis", "A"),
  ]);
  const kontoXml = kontoliste
    .filter(([konto, s]) => s.inn || s.ut || brukt.has(konto))
    .map(([konto, s]) => {
      const g = gruppering(konto, anlegg);
      return el("Account", [
        t("AccountID", konto, 70),
        t("AccountDescription", navn(konto) || `Konto ${konto}`),
        t("GroupingCategory", g.kategori),
        t("GroupingCode", g.kode, 35),
        t("AccountType", "GL"),
        saldo(s.inn, s.ut),
      ]);
    });
  const partXml = (type: "Customer" | "Supplier", m: Map<string, Saldo & { part: Part }>, konto: string) =>
    [...m.values()]
      .sort((a, b) => a.part.id.localeCompare(b.part.id, "nb", { numeric: true }))
      .map((s) =>
        el(type, [
          t("RegistrationNumber", s.part.orgnr, 35),
          t("Name", s.part.navn),
          t(type === "Customer" ? "CustomerID" : "SupplierID", s.part.id, 35),
          el("BalanceAccount", [t("AccountID", konto, 70), saldo(s.inn, s.ut)]),
        ]),
      );
  const koder = [...brukteKoder].sort((a, b) => Number(a) - Number(b));
  const masterFiles = el("MasterFiles", [
    el("GeneralLedgerAccounts", kontoXml),
    kundeSaldo.size ? el("Customers", partXml("Customer", kundeSaldo, k.kundefordringer)) : "",
    levSaldo.size ? el("Suppliers", partXml("Supplier", levSaldo, k.leverandorgjeld)) : "",
    koder.length
      ? el(
          "TaxTable",
          el("TaxTableEntry", [
            t("TaxType", "MVA"),
            t("Description", "Merverdiavgift"),
            koder.map((kode) =>
              el("TaxCodeDetails", [
                t("TaxCode", kode, 70),
                t("Description", MVA_KODER[kode] ?? `Mva-kode ${kode}`),
                t("TaxPercentage", prosent(mvaSats(kode))),
                t("Country", "NO"),
                t("StandardTaxCode", kode),
                t("BaseRate", 100),
              ]),
            ),
          ]),
        )
      : "",
  ]);

  // Bilagene i året, en journal per serie.
  const iAaretBilag = bilag.filter((b) => b.dato >= fra);
  let debet = 0;
  let kredit = 0;
  const journaler = [...new Set(iAaretBilag.map((b) => b.serie))]
    .sort((a, b) => Object.keys(SERIER).indexOf(a) - Object.keys(SERIER).indexOf(b))
    .map((serie) =>
      el("Journal", [
        t("JournalID", serie, 18),
        t("Description", SERIER[serie] ?? `Serie ${serie}`),
        t("Type", serie, 9),
        iAaretBilag
          .filter((b) => b.serie === serie)
          .map((b) => {
            const linjer = (perBilagPoster.get(b.id) ?? []).map((p) => {
              const o = ore(p.belop);
              if (o > 0) debet += o;
              else kredit -= o;
              const x = part(p);
              const s = skatt.get(p);
              return el("Line", [
                t("RecordID", p.rekke, 18),
                t("AccountID", p.konto, 70),
                t("CustomerID", x.kunde?.id, 35),
                t("SupplierID", x.leverandor?.id, 35),
                t("Description", p.tekst || b.tekst),
                o >= 0 ? el("DebitAmount", t("Amount", belop(o))) : el("CreditAmount", t("Amount", belop(-o))),
                s
                  ? el("TaxInformation", [
                      t("TaxType", "MVA"),
                      t("TaxCode", s.kode, 70),
                      t("TaxPercentage", prosent(s.sats)),
                      t("Country", "NO"),
                      t("TaxBase", belop(s.grunnlag)),
                      s.debet ? el("DebitTaxAmount", t("Amount", belop(s.avgift))) : el("CreditTaxAmount", t("Amount", belop(s.avgift))),
                    ])
                  : "",
              ]);
            });
            return el("Transaction", [
              t("TransactionID", `${b.serie}-${b.aar}-${b.nummer}`, 70),
              t("Period", Number(b.dato.slice(5, 7))),
              t("PeriodYear", Number(b.dato.slice(0, 4))),
              t("TransactionDate", b.dato),
              t("VoucherType", b.kilde, 70),
              t("Description", b.tekst),
              t("SystemEntryDate", b.opprettet),
              t("GLPostingDate", b.dato),
              linjer,
            ]);
          }),
      ]),
    );
  const glXml = el("GeneralLedgerEntries", [t("NumberOfEntries", iAaretBilag.length), t("TotalDebit", belop(debet)), t("TotalCredit", belop(kredit)), journaler]);

  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<AuditFile xmlns="urn:StandardAuditFile-Taxation-Financial:NO" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
    header +
    masterFiles +
    glXml +
    `</AuditFile>\n`;
  const stempel = `${naa.dato.replaceAll("-", "")}${naa.tid.replaceAll(":", "")}`;
  return { filnavn: `SAF-T Financial_${o.orgnr}_${stempel}.xml`, xml, antallBilag: iAaretBilag.length };
}

// --- Ruten (under /api/org/:org) -------------------------------------------------------------------

const uuid = z.string().uuid();
const orgId = (c: Context) => uuid.parse(c.req.param("org"));
const aarS = z.coerce.number({ error: "Ugyldig år" }).int("Ugyldig år").min(2000, "Ugyldig år").max(2100, "Ugyldig år");

export function saftRuter() {
  const r = new Hono();
  r.get("/regnskap/saft", async (c) => {
    const aar = aarS.parse(c.req.query("aar"));
    const b = c.get("bruker") as { id: string; epost: string; navn?: string | null };
    const s = await somBruker(b.id, async (db) => {
      await db.query("select faktura.krev($1, 'regnskap')", [orgId(c)]);
      const u = await en<{ navn: string | null; epost: string }>(db, "select navn, epost from faktura.brukere where id = $1", [b.id]);
      return lagSaft(db, orgId(c), aar, u ?? null);
    });
    return c.body(s.xml, 200, { "content-type": "application/xml; charset=utf-8", "content-disposition": `attachment; filename="${s.filnavn}"` });
  });
  return r;
}
