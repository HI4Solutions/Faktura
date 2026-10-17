// Årsregnskapet til Regnskapsregisteret i Brønnøysund (0120_aarsregnskap.sql, aarsregnskapXml.ts,
// aarsregnskapInnsending.ts, web/src/sider/RegnskapAarsregnskap.tsx).
//
// Oppstillingen for små foretak: resultatregnskapet for året og balansen 31. desember, med
// fjoråret, etter postene i Brønnøysunds skjema. Tallene hentes fra kontoene (norsk standard
// kontoplan, NS 4102) etter årsoppgjøret (skattekostnaden og disponeringene) og vises i hele
// kroner, med inntektene, kostnadene, eiendelene, egenkapitalen og gjelden som positive tall.
// Øreavrundingen føres mot annen egenkapital (balansen) og overføringene til annen egenkapital
// (resultatet), så summene går opp. Fjorårstallene kan legges inn for hånd (fra fjorårets
// årsregnskap) når regnskapet for fjoråret ikke ligger her.
//
// Notene for små foretak: regnskapsprinsippene (en standardtekst som kan endres), usikkerhet om
// fortsatt drift, antall årsverk (forslag fra de ansatte), lån og sikkerhetsstillelse til ledende
// personer og aksjeeiere, lønnskostnadene (fra kontoene), gjelden og ytterligere opplysninger.
// Fastsettelsen (datoen og hvem som bekrefter den) og revisjonen fyller brukeren ut.
//
// Kontrollene sier hva som må rettes før innsending (feil) og hva som bør sjekkes (advarsler).
// Foreløpig aksjeselskap som er små foretak, uten konsern.
import { Hono, type Context } from "hono";
import { z } from "zod";
import { aarsstatus, kontosummer } from "./aarsoppgjor.js";
import { PAKKENAVN, REGNSKAP_OKONOMI_RAPPORT, tilgangspakker } from "./altinn.js";
import { krevMfa } from "./auth.js";
import { config } from "./config.js";
import { skattekortSattOpp } from "./maskinporten.js";
import { leggIKo } from "./tjenester.js";
import type { Enhet, Rolle } from "./brreg.js";
import { en, somBruker, type Db } from "./db.js";
import { ApiFeil } from "./feil.js";
import { dato as visDato, kr } from "./regler.js";
import type { Rapportdef } from "./rapportmodul.js";
import { slaOppEnhet, slaOppRoller } from "./verifisering.js";
import { aarsregnskapPdf } from "./aarsregnskapPdf.js";
import { hovedskjemaXml, underskjemaXml, type Tall } from "./aarsregnskapXml.js";

const osloIDag = () => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Oslo" }).format(new Date());
// Hele kroner (halve kroner bort fra null), uten minus null.
const helKr = (n: number) => Math.sign(n) * Math.round(Math.abs(n)) || 0;

// --- Postene ------------------------------------------------------------------------------------

// o: overskrift (nivå 1–3), p: post fra kontoene (fortegn: Brønnøysunds fortegn er fortegn × summen
// med debet positivt; del: bare debet- eller kreditsaldoen), s: sum av postene over (ledd med «-»
// trekkes fra). Nøklene er postene i underskjemaet (aarsregnskapXml.ts).
type Def =
  | { t: "o"; navn: string; niva: 1 | 2 | 3 }
  | { t: "p"; nokkel: string; navn: string; kontoer: [string, string][]; fortegn: 1 | -1; del?: "debet" | "kredit" }
  | { t: "s"; nokkel: string; navn: string; ledd: [string, 1 | -1][]; hoved: boolean };

const o = (navn: string, niva: 1 | 2 | 3 = 2): Def => ({ t: "o", navn, niva });
const p = (nokkel: string, navn: string, kontoer: string, fortegn: 1 | -1 = 1, del?: "debet" | "kredit"): Def => ({
  t: "p",
  nokkel,
  navn,
  kontoer: kontoer.split(",").map((x) => x.split("-") as [string, string]),
  fortegn,
  del,
});
const s = (nokkel: string, navn: string, ledd: string, hoved = false): Def => ({
  t: "s",
  nokkel,
  navn,
  ledd: ledd.split(" ").map((x) => (x.startsWith("-") ? [x.slice(1), -1] : [x, 1])),
  hoved,
});

// Resultatregnskapet: bevegelsen i året. Kontoene 8400–8799 har ingen post (kontrollene).
export const RESULTAT: Def[] = [
  o("Driftsinntekter"),
  p("salgsinntekt", "Salgsinntekt", "3000-3399", -1),
  p("annenDriftsinntekt", "Annen driftsinntekt", "3400-3999", -1),
  s("driftsinntektSum", "Sum driftsinntekter", "salgsinntekt annenDriftsinntekt"),
  o("Driftskostnader"),
  p("varekostnad", "Varekostnad", "4000-4999"),
  p("loennskostnad", "Lønnskostnad", "5000-5999"),
  p("avskrivning", "Avskrivning på varige driftsmidler og immaterielle eiendeler", "6000-6049"),
  p("nedskrivning", "Nedskrivning av varige driftsmidler og immaterielle eiendeler", "6050-6099"),
  p("annenDriftskostnad", "Annen driftskostnad", "6100-7999"),
  s("sumDriftskostnad", "Sum driftskostnader", "varekostnad loennskostnad avskrivning nedskrivning annenDriftskostnad"),
  s("driftsresultat", "Driftsresultat", "driftsinntektSum -sumDriftskostnad", true),
  o("Finansinntekter og finanskostnader"),
  p("investeringDatterTilknyttet", "Inntekt på investering i datterselskap og tilknyttet selskap", "8000-8029", -1),
  p("renteinntektKonsern", "Renteinntekt fra foretak i samme konsern", "8030-8039", -1),
  p("annenRenteinntekt", "Annen renteinntekt", "8040-8059", -1),
  p("annenFinansinntekt", "Annen finansinntekt", "8060-8079", -1),
  p("verdioekningFinansielle", "Verdiøkning av finansielle instrumenter vurdert til virkelig verdi", "8080-8089", -1),
  p("andreInvesteringer", "Inntekt på andre investeringer", "8090-8099", -1),
  s(
    "sumFinansinntekter",
    "Sum finansinntekter",
    "investeringDatterTilknyttet renteinntektKonsern annenRenteinntekt annenFinansinntekt verdioekningFinansielle andreInvesteringer",
  ),
  p("verdireduksjonFinansielle", "Verdireduksjon av finansielle instrumenter vurdert til virkelig verdi", "8100-8109"),
  p("nedskrivningFinansielle", "Nedskrivning av finansielle eiendeler", "8110-8129"),
  p("rentekostnadKonsern", "Rentekostnad til foretak i samme konsern", "8130-8139"),
  p("annenRentekostnad", "Annen rentekostnad", "8140-8159"),
  p("annenFinanskostnad", "Annen finanskostnad", "8160-8299"),
  s("sumFinanskostnader", "Sum finanskostnader", "verdireduksjonFinansielle nedskrivningFinansielle rentekostnadKonsern annenRentekostnad annenFinanskostnad"),
  s("nettoFinans", "Netto finans", "sumFinansinntekter -sumFinanskostnader"),
  s("resultatFoerSkatt", "Resultat før skattekostnad", "driftsresultat nettoFinans", true),
  p("skattekostnad", "Skattekostnad", "8300-8399"),
  s("aarsresultat", "Årsresultat", "resultatFoerSkatt -skattekostnad", true),
  o("Overføringer og disponeringer"),
  p("overfoeringFond", "Overføringer til/fra fond", "8900-8919"),
  p("utbytte", "Utbytte", "8920-8929"),
  // Konsernbidraget etter saldoen: mottatt (kredit, trekkes fra i summen) eller avgitt (debet).
  p("konsernbidrag", "Mottatt konsernbidrag", "8930-8949", -1, "kredit"),
  p("avgittKonsernbidrag", "Avgitt konsernbidrag", "8930-8949", 1, "debet"),
  p("fondsemisjon", "Fondsemisjon", "8950-8959"),
  p("udekketTapOverfoering", "Udekket tap", "8990-8999"),
  p("overfoeringAnnenEK", "Overføringer til/fra annen egenkapital", "8800-8899,8960-8989"),
  s(
    "sumOverfoeringer",
    "Sum overføringer og disponeringer",
    "overfoeringFond utbytte -konsernbidrag avgittKonsernbidrag fondsemisjon udekketTapOverfoering overfoeringAnnenEK",
  ),
];

// Balansen: saldoen 31. desember. Resultatkontoene (3000–8999) er med i annen egenkapital: resultat
// som ikke er disponert (fra år uten årsoppgjør), hører til egenkapitalen.
export const BALANSE: Def[] = [
  o("Eiendeler", 1),
  o("Anleggsmidler", 2),
  o("Immaterielle eiendeler", 3),
  p("forskningUtvikling", "Utvikling", "1000-1019"),
  p("konsesjoner", "Konsesjoner, patenter, lisenser, varemerker o.l.", "1020-1069"),
  p("utsattSkattefordel", "Utsatt skattefordel", "1070-1079"),
  p("goodwill", "Goodwill", "1080-1099"),
  s("sumImmaterielle", "Sum immaterielle eiendeler", "forskningUtvikling konsesjoner utsattSkattefordel goodwill"),
  o("Varige driftsmidler", 3),
  p("tomterBygninger", "Tomter, bygninger og annen fast eiendom", "1100-1199"),
  p("maskinAnlegg", "Maskiner og anlegg", "1200-1219"),
  p("skipRiggFly", "Skip, rigger, fly o.l.", "1220-1229"),
  p("driftsloesoere", "Driftsløsøre, inventar, verktøy, kontormaskiner o.l.", "1230-1299"),
  s("sumVarigeDriftsmidler", "Sum varige driftsmidler", "tomterBygninger maskinAnlegg skipRiggFly driftsloesoere"),
  o("Finansielle anleggsmidler", 3),
  p("investeringDatterselskap", "Investeringer i datterselskap", "1300-1309"),
  p("investeringKonsern", "Investeringer i annet foretak i samme konsern", "1310-1319"),
  p("laanKonsern", "Lån til foretak i samme konsern", "1320-1329"),
  p("investeringTilknyttet", "Investeringer i tilknyttet selskap", "1330-1339"),
  p("laanTilknyttet", "Lån til tilknyttet selskap og felles kontrollert virksomhet", "1340-1349"),
  p("investeringAksjer", "Investeringer i aksjer og andeler", "1350-1359"),
  p("obligasjoner", "Obligasjoner", "1360-1369"),
  p("andreFordringerAnlegg", "Andre fordringer", "1370-1399"),
  s(
    "sumFinansielleAnleggsmidler",
    "Sum finansielle anleggsmidler",
    "investeringDatterselskap investeringKonsern laanKonsern investeringTilknyttet laanTilknyttet investeringAksjer obligasjoner andreFordringerAnlegg",
  ),
  s("sumAnleggsmidler", "Sum anleggsmidler", "sumImmaterielle sumVarigeDriftsmidler sumFinansielleAnleggsmidler"),
  o("Omløpsmidler", 2),
  o("Varer", 3),
  p("varer", "Lagerbeholdning", "1400-1499"),
  s("sumVarer", "Sum varer", "varer"),
  o("Fordringer", 3),
  p("kundefordringer", "Kundefordringer", "1500-1549,1580-1589"),
  p("andreFordringer", "Andre fordringer", "1570-1579,1590-1779,1790-1799"),
  p("konsernfordringer", "Konsernfordringer", "1550-1569"),
  p("kravInnbetaling", "Krav på innbetaling av selskapskapital", "1780-1789"),
  s("sumFordringer", "Sum fordringer", "kundefordringer andreFordringer konsernfordringer kravInnbetaling"),
  o("Investeringer", 3),
  p("aksjerKonsern", "Aksjer og andeler i foretak i samme konsern", "1800-1809"),
  p("markedsbaserteAksjer", "Markedsbaserte aksjer", "1810-1819"),
  p("markedsbaserteObligasjoner", "Markedsbaserte obligasjoner", "1820-1829"),
  p("andreMarkedsbaserte", "Andre markedsbaserte finansielle instrumenter", "1830-1869"),
  p("andreFinansielleInstrumenter", "Andre finansielle instrumenter", "1870-1899"),
  s("sumInvesteringer", "Sum investeringer", "aksjerKonsern markedsbaserteAksjer markedsbaserteObligasjoner andreMarkedsbaserte andreFinansielleInstrumenter"),
  o("Bankinnskudd, kontanter o.l.", 3),
  p("bankinnskudd", "Bankinnskudd, kontanter o.l.", "1900-1999"),
  s("sumBankinnskudd", "Sum bankinnskudd, kontanter o.l.", "bankinnskudd"),
  s("sumOmloepsmidler", "Sum omløpsmidler", "sumVarer sumFordringer sumInvesteringer sumBankinnskudd"),
  s("sumEiendeler", "Sum eiendeler", "sumAnleggsmidler sumOmloepsmidler", true),
  o("Egenkapital og gjeld", 1),
  o("Egenkapital", 2),
  o("Innskutt egenkapital", 3),
  p("selskapskapital", "Selskapskapital", "2000-2009", -1),
  p("egneAksjer", "Egne aksjer", "2010-2019", -1),
  p("overkursfond", "Overkursfond", "2020-2029", -1),
  p("annenInnskuttEK", "Annen innskutt egenkapital", "2030-2039", -1),
  s("sumInnskuttEK", "Sum innskutt egenkapital", "selskapskapital egneAksjer overkursfond annenInnskuttEK"),
  o("Opptjent egenkapital", 3),
  p("fond", "Fond", "2040-2049", -1),
  p("annenEgenkapital", "Annen egenkapital", "2050-2079,3000-8999", -1),
  p("udekketTap", "Udekket tap", "2080-2099", -1),
  s("sumOpptjentEK", "Sum opptjent egenkapital", "fond annenEgenkapital udekketTap"),
  s("sumEgenkapital", "Sum egenkapital", "sumInnskuttEK sumOpptjentEK"),
  o("Gjeld", 2),
  o("Avsetninger for forpliktelser", 3),
  p("pensjonsforpliktelser", "Pensjonsforpliktelser", "2100-2119", -1),
  p("utsattSkatt", "Utsatt skatt", "2120-2129", -1),
  p("andreAvsetninger", "Andre avsetninger for forpliktelser", "2130-2199", -1),
  s("sumAvsetninger", "Sum avsetninger for forpliktelser", "pensjonsforpliktelser utsattSkatt andreAvsetninger"),
  o("Annen langsiktig gjeld", 3),
  p("konvertibleLaanLang", "Konvertible lån", "2200-2209", -1),
  p("obligasjonslaan", "Obligasjonslån", "2210-2219", -1),
  p("gjeldKredittLang", "Gjeld til kredittinstitusjoner", "2220-2249", -1),
  p("konserngjeldLang", "Langsiktig konserngjeld", "2260-2269", -1),
  p("ansvarligLaanekapital", "Ansvarlig lånekapital", "2280-2289", -1),
  p("oevrigLangsiktig", "Øvrig langsiktig gjeld", "2250-2259,2270-2279,2290-2299", -1),
  s("sumAnnenLangsiktig", "Sum annen langsiktig gjeld", "konvertibleLaanLang obligasjonslaan gjeldKredittLang konserngjeldLang ansvarligLaanekapital oevrigLangsiktig"),
  s("sumLangsiktigGjeld", "Sum langsiktig gjeld", "sumAvsetninger sumAnnenLangsiktig"),
  o("Kortsiktig gjeld", 3),
  p("konvertibleLaanKort", "Konvertible lån", "2300-2309", -1),
  p("sertifikatlaan", "Sertifikatlån", "2310-2319", -1),
  p("gjeldKredittKort", "Gjeld til kredittinstitusjoner", "2320-2399", -1),
  p("leverandoergjeld", "Leverandørgjeld", "2400-2459,2470-2499", -1),
  p("betalbarSkatt", "Betalbar skatt", "2500-2599", -1),
  p("skyldigeOffentligeAvgifter", "Skyldige offentlige avgifter", "2600-2609,2700-2799", -1),
  p("utbytteGjeld", "Utbytte", "2800-2899", -1),
  p("konserngjeldKort", "Kortsiktig konserngjeld", "2460-2469,2920-2929", -1),
  p("annenKortsiktigGjeld", "Annen kortsiktig gjeld", "2610-2699,2900-2919,2930-2999", -1),
  s(
    "sumKortsiktigGjeld",
    "Sum kortsiktig gjeld",
    "konvertibleLaanKort sertifikatlaan gjeldKredittKort leverandoergjeld betalbarSkatt skyldigeOffentligeAvgifter utbytteGjeld konserngjeldKort annenKortsiktigGjeld",
  ),
  s("sumGjeld", "Sum gjeld", "sumLangsiktigGjeld sumKortsiktigGjeld"),
  s("sumEgenkapitalGjeld", "Sum egenkapital og gjeld", "sumEgenkapital sumGjeld", true),
];

// Postene som alltid er med (Brønnøysund krever dem).
const PAAKREVD = new Set(["aarsresultat", "sumEiendeler", "sumEgenkapitalGjeld"]);
// Postene fra kontoene (de som kan legges inn for hånd for fjoråret).
export const POSTER = [...RESULTAT, ...BALANSE].filter((d): d is Def & { t: "p" } => d.t === "p").map((d) => d.nokkel);

const iKontoer = (konto: string, k: [string, string][]) => {
  const n = konto.slice(0, 4);
  return k.some(([a, b]) => n >= a && n <= b);
};

type Kolonne = { raa: Record<string, number>; v: Record<string, number> };

function summer(defs: Def[], v: Record<string, number>) {
  for (const d of defs) if (d.t === "s") v[d.nokkel] = d.ledd.reduce((x, [k, f]) => x + f * (v[k] ?? 0), 0);
}

// Postene for kontosummene (debet positivt): uten avrunding (raa) og i hele kroner (v).
function kolonne(defs: Def[], sum: Map<string, number>): Kolonne {
  const raa: Record<string, number> = {};
  const v: Record<string, number> = {};
  for (const d of defs) {
    if (d.t !== "p") continue;
    let x = 0;
    for (const [konto, b] of sum) if (iKontoer(konto, d.kontoer)) x += b;
    raa[d.nokkel] = d.del === "debet" ? Math.max(x, 0) : d.del === "kredit" ? Math.max(-x, 0) : d.fortegn * x;
    v[d.nokkel] = helKr(raa[d.nokkel]!);
  }
  summer(defs, raa);
  summer(defs, v);
  return { raa, v };
}

// Øreavrundingen: når summene a og b er like før avrundingen, føres differansen etter avrundingen på
// posten (som hører til b), så de er like i hele kroner også. Går de ikke opp, sier kontrollene fra.
function avrund(defs: Def[], k: Kolonne, a: string, b: string, post: string) {
  if (Math.abs(k.raa[a]! - k.raa[b]!) >= 0.005) return;
  const diff = k.v[a]! - k.v[b]!;
  if (!diff) return;
  k.v[post] = (k.v[post] ?? 0) + diff;
  summer(defs, k.v);
}

export type Linje = { type: "overskrift" | "post" | "sum"; nokkel: string | null; navn: string; niva: number; aarets: number; fjor: number; vis: boolean };

// Linjene til visningen (og XML-en): en post vises når den har beløp; en sum når noe under den vises
// (eller den har beløp); en overskrift når en post under den vises.
function linjer(defs: Def[], n: Record<string, number>, f: Record<string, number>, harFjor: boolean): Linje[] {
  const vis = new Map<string, boolean>();
  const ut: Linje[] = defs.map((d) => {
    if (d.t === "o") return { type: "overskrift", nokkel: null, navn: d.navn, niva: d.niva, aarets: 0, fjor: 0, vis: false };
    const aarets = n[d.nokkel] ?? 0;
    const fjor = harFjor ? (f[d.nokkel] ?? 0) : 0;
    const v = d.t === "p" ? aarets !== 0 || fjor !== 0 : PAAKREVD.has(d.nokkel) || aarets !== 0 || fjor !== 0 || d.ledd.some(([k]) => vis.get(k));
    vis.set(d.nokkel, v);
    return { type: d.t === "p" ? "post" : "sum", nokkel: d.nokkel, navn: d.navn, niva: d.t === "s" && d.hoved ? 1 : 0, aarets, fjor, vis: v };
  });
  for (let i = 0; i < ut.length; i++) {
    const l = ut[i]!;
    if (l.type !== "overskrift") continue;
    for (let j = i + 1; j < ut.length; j++) {
      const m = ut[j]!;
      if (m.type === "overskrift" && m.niva <= l.niva) break;
      if (m.type === "post" && m.vis) {
        l.vis = true;
        break;
      }
    }
  }
  return ut;
}

// --- Opplysningene brukeren fyller ut -------------------------------------------------------------

const tekst = (maks: number, navn: string) => z.string().trim().max(maks, `${navn} kan ha opptil ${maks} tegn`).nullable().optional();
const belop = z.number({ error: "Ugyldig beløp" }).finite().min(0, "Beløpet kan ikke være negativt").lt(1e13, "Beløpet er for stort").nullable().optional();
export const opplysningerS = z.object({
  fastsettelsesdato: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Ugyldig dato").nullable().optional(),
  bekreftende: tekst(70, "Navnet"),
  revideres: z.boolean().nullable().optional(),
  utarbeidet_av_regnskapsforer: z.boolean().optional(),
  bistand_regnskapsforer: z.boolean().optional(),
  kontakt_epost: z.string().trim().email("Ugyldig e-postadresse").max(70).nullable().optional(),
  prinsipper: tekst(9999, "Regnskapsprinsippene"),
  usikkerhet_drift: z.boolean().optional(),
  usikkerhet_tekst: tekst(9999, "Teksten"),
  aarsverk: z.number({ error: "Ugyldig antall årsverk" }).min(0, "Antall årsverk kan ikke være negativt").max(1e6).nullable().optional(),
  laan: z
    .object({
      gitt: z.boolean(),
      laan_styret: belop,
      laan_andre: belop,
      sikkerhet_styret: belop,
      sikkerhet_andre: belop,
      rente_styret: tekst(12, "Rentesatsen"),
      rente_andre: tekst(12, "Rentesatsen"),
      vilkaar_styret: tekst(3000, "Vilkårene"),
      vilkaar_andre: tekst(3000, "Vilkårene"),
      tekst: tekst(9999, "Teksten"),
    })
    .nullable()
    .optional(),
  gjeld: z
    .object({ over_fem_aar: belop, pantsikret: belop, pantsatte_eiendeler: belop, garantier: belop, tekst: tekst(9999, "Teksten") })
    .nullable()
    .optional(),
  ytterligere: tekst(9999, "Opplysningene"),
  fjor: z.record(z.string(), z.number({ error: "Ugyldig beløp" }).finite().int("Fjorårstallene er i hele kroner")).nullable().optional(),
});
export type Opplysninger = z.infer<typeof opplysningerS>;

// Standardteksten for regnskapsprinsippene (små foretak).
export function standardPrinsipper(utsattSkatt: boolean) {
  return [
    "Årsregnskapet er satt opp i samsvar med regnskapsloven og god regnskapsskikk for små foretak.",
    "Salgsinntekter: Inntekter ved salg av varer og tjenester resultatføres når de er opptjent, normalt ved levering.",
    "Klassifisering og vurdering av eiendeler og gjeld: Eiendeler bestemt til varig eie eller bruk er klassifisert som anleggsmidler. " +
      "Andre eiendeler er klassifisert som omløpsmidler. Fordringer som skal tilbakebetales innen ett år, er klassifisert som omløpsmidler. " +
      "Ved klassifisering av kortsiktig og langsiktig gjeld er tilsvarende kriterier lagt til grunn. Anleggsmidler vurderes til " +
      "anskaffelseskost fratrukket planmessige avskrivninger, og nedskrives til virkelig verdi ved verdifall som ikke er forbigående. " +
      "Omløpsmidler vurderes til laveste av anskaffelseskost og virkelig verdi.",
    "Fordringer: Kundefordringer og andre fordringer er oppført til pålydende etter fradrag for avsetning til forventet tap.",
    utsattSkatt
      ? "Skatt: Skattekostnaden omfatter betalbar skatt for perioden og endring i utsatt skatt. Utsatt skatt er beregnet med 22 prosent " +
        "av de midlertidige forskjellene mellom regnskapsmessige og skattemessige verdier og av underskudd til fremføring ved utgangen av året."
      : "Skatt: Skattekostnaden er betalbar skatt for perioden.",
  ].join("\n\n");
}

const STANDARD_LAAN = "Det er ikke gitt lån eller stilt sikkerhet for daglig leder, styremedlemmer, aksjeeiere eller andre ledende personer.";
const aarsverkTekst = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

// --- Årsregnskapet --------------------------------------------------------------------------------

export type Innsending = {
  status: "utkast" | "sender" | "til_signering" | "levert" | "feil";
  instans_url: string | null;
  laast: boolean;
  sendt_at: string | null;
  levert_at: string | null;
  sjekket_at: string | null;
  feil: string | null;
  valideringsfeil: unknown;
};

export type Aarsregnskap = {
  aar: number;
  over: boolean;
  start: string;
  slutt: string;
  orgnr: string | null;
  navn: string;
  organisasjonsform: string | null;
  har_fjor: boolean;
  fjor_for_haand: boolean;
  resultat: Linje[];
  balanse: Linje[];
  noter: {
    prinsipper: string;
    prinsipper_standard: string;
    aarsverk: number | null;
    aarsverk_forslag: number;
    lonn: { navn: string; aarets: number; fjor: number }[] | null;
  };
  opplysninger: Opplysninger;
  forslag: { bekreftende: string | null; kontakt_epost: string | null };
  roller: { rolle: string; navn: string }[];
  aarsoppgjor: { bokfort: boolean; stemmer: boolean; trengs: boolean };
  innsending: Innsending;
  altinn: Altinnstatus;
  feil: string[];
  advarsler: string[];
};

// Tilgangen i Altinn (systembrukeren, den samme som for skattekortene): om innsendingen er slått på,
// om organisasjonen er koblet til, og om systembrukeren har tilgangspakken for årsregnskapet.
export type Altinnstatus = {
  pa: boolean;
  miljo: string;
  status: string | null;
  godkjenn_url: string | null;
  endring_status: string | null;
  endring_url: string | null;
  har_pakke: boolean;
  pakke: string;
  mangler: string[];
};
export async function altinnstatus(db: Db, org: string): Promise<Altinnstatus> {
  const t = await en<{ status: string; godkjenn_url: string | null; pakker: string[]; endring_status: string | null; endring_url: string | null }>(
    db,
    "select status, godkjenn_url, pakker, endring_status, endring_url from faktura.skattekort_tilgang where org_id = $1",
    [org],
  );
  const godkjent = t?.status === "godkjent";
  return {
    pa: config.aarsregnskapInnsending && skattekortSattOpp(),
    miljo: config.skatteetatenMiljo,
    status: t?.status ?? null,
    godkjenn_url: t?.status === "ny" ? t.godkjenn_url : null,
    endring_status: godkjent ? (t.endring_status ?? null) : null,
    endring_url: godkjent && t.endring_status === "ny" ? t.endring_url : null,
    har_pakke: Boolean(godkjent && t.pakker.includes(REGNSKAP_OKONOMI_RAPPORT)),
    pakke: PAKKENAVN[REGNSKAP_OKONOMI_RAPPORT]!,
    mangler: godkjent ? tilgangspakker().filter((p) => !t.pakker.includes(p)).map((p) => PAKKENAVN[p] ?? p) : [],
  };
}

// Enhetsregisteret huskes en time: organisasjonsformen, navnet og stiftelsesdatoen, og rollene
// (daglig leder og styret: forslaget til hvem som bekrefter fastsettelsen, og signaturene i PDF-en).
const enhetMinne = new Map<string, { tid: number; e: Enhet | null; roller: Rolle[] }>();
async function enhet(orgnr: string | null): Promise<{ e: Enhet | null; roller: Rolle[] }> {
  if (!orgnr) return { e: null, roller: [] };
  const h = enhetMinne.get(orgnr);
  if (h && Date.now() - h.tid < 3_600_000) return h;
  const [e, roller] = await Promise.all([slaOppEnhet(orgnr).catch(() => null), slaOppRoller(orgnr)]);
  const ny = { tid: Date.now(), e, roller };
  enhetMinne.set(orgnr, ny);
  return ny;
}
// Styret og daglig leder, i den rekkefølgen de signerer.
const SIGNATUR = ["LEDE", "NEST", "MEDL", "DAGL"];
export const glemEnhet = () => enhetMinne.clear();

async function rad(db: Db, org: string, aar: number) {
  return en<{ opplysninger: Opplysninger } & Innsending>(
    db,
    `select opplysninger, status, instans_url, laast, sendt_at, levert_at, sjekket_at, feil, valideringsfeil
       from faktura.aarsregnskap where org_id = $1 and aar = $2`,
    [org, aar],
  );
}

// Lønnskostnadene i noten: lønn, arbeidsgiveravgift, pensjon og andre ytelser. Den største delen tar
// øreavrundingen, så summen er lik lønnskostnaden i resultatregnskapet.
function lonnsnote(sum: Map<string, number>, total: number) {
  const del = (fra: string, til: string) => {
    let x = 0;
    for (const [konto, b] of sum) if (iKontoer(konto, [[fra, til]])) x += b;
    return helKr(x);
  };
  const d = [del("5000", "5399"), del("5400", "5419"), del("5420", "5499"), del("5500", "5999")];
  const diff = total - d.reduce((a, b) => a + b, 0);
  if (diff) {
    const i = d.reduce((m, x, j) => (Math.abs(x) > Math.abs(d[m]!) ? j : m), 0);
    d[i]! += diff;
  }
  return d;
}

export async function hentAarsregnskap(db: Db, org: string, aar: number, brukerId?: string, iDag = osloIDag()): Promise<Aarsregnskap> {
  const status = await aarsstatus(db, org, aar, iDag, false);
  const o = (await en<{ navn: string; orgnr: string | null }>(db, "select navn, orgnr from faktura.organisasjoner where id = $1", [org]))!;
  const r = await rad(db, org, aar);
  const opp: Opplysninger = r?.opplysninger ?? {};
  const { e, roller } = await enhet(o.orgnr);

  // Første regnskapsår: fra stiftelsen (eller registreringen).
  const stiftet = e?.stiftelsesdato ?? null;
  const start = stiftet && stiftet > `${aar}-01-01` && stiftet <= `${aar}-12-31` ? stiftet : `${aar}-01-01`;
  const slutt = `${aar}-12-31`;
  const forrige = `${aar - 1}-12-31`;

  const [rN, rF, bN, bF] = [
    await kontosummer(db, org, `${aar}-01-01`, slutt),
    await kontosummer(db, org, `${aar - 1}-01-01`, forrige),
    await kontosummer(db, org, null, slutt),
    await kontosummer(db, org, null, forrige),
  ];
  const res = { n: kolonne(RESULTAT, rN), f: kolonne(RESULTAT, rF) };
  const bal = { n: kolonne(BALANSE, bN), f: kolonne(BALANSE, bF) };
  for (const k of [res.n, res.f]) avrund(RESULTAT, k, "aarsresultat", "sumOverfoeringer", "overfoeringAnnenEK");
  for (const k of [bal.n, bal.f]) avrund(BALANSE, k, "sumEiendeler", "sumEgenkapitalGjeld", "annenEgenkapital");

  // Fjorårstallene for hånd erstatter dem fra regnskapet.
  const forHaand = Boolean(opp.fjor && Object.keys(opp.fjor).length);
  if (forHaand) {
    for (const [defs, k] of [
      [RESULTAT, res.f],
      [BALANSE, bal.f],
    ] as const) {
      for (const d of defs) if (d.t === "p") k.v[d.nokkel] = opp.fjor![d.nokkel] ?? 0;
      summer(defs, k.v);
    }
  }
  const harFjor = start === `${aar}-01-01` && (forHaand || rF.size > 0 || bF.size > 0);

  const resultat = linjer(RESULTAT, res.n.v, res.f.v, harFjor);
  const balanse = linjer(BALANSE, bal.n.v, bal.f.v, harFjor);
  const n = { ...res.n.v, ...bal.n.v };
  const f = { ...res.f.v, ...bal.f.v };

  const utsatt = [n.utsattSkatt, n.utsattSkattefordel, f.utsattSkatt, f.utsattSkattefordel].some((x) => x);
  const prinsipperStandard = standardPrinsipper(utsatt);
  const forslagAarsverk = Number((await en<{ n: number }>(db, "select faktura.aarsverk($1, $2)::float8 as n", [org, aar]))!.n);
  const lonnN = lonnsnote(rN, n.loennskostnad!);
  const lonnF = lonnsnote(rF, f.loennskostnad!);
  const lonn = n.loennskostnad || (harFjor && f.loennskostnad)
    ? ["Lønn", "Arbeidsgiveravgift", "Pensjonskostnader", "Andre ytelser"].map((navn, i) => ({ navn, aarets: lonnN[i]!, fjor: harFjor ? lonnF[i]! : 0 }))
    : null;

  const bruker = brukerId ? await en<{ navn: string | null; epost: string | null }>(db, "select navn, epost from faktura.brukere where id = $1", [brukerId]) : undefined;

  const a: Aarsregnskap = {
    aar,
    over: slutt < iDag,
    start,
    slutt,
    orgnr: o.orgnr,
    navn: e?.navn ?? o.navn,
    organisasjonsform: e?.organisasjonsform ?? null,
    har_fjor: harFjor,
    fjor_for_haand: forHaand,
    resultat,
    balanse,
    noter: {
      prinsipper: opp.prinsipper || prinsipperStandard,
      prinsipper_standard: prinsipperStandard,
      aarsverk: opp.aarsverk ?? null,
      aarsverk_forslag: forslagAarsverk,
      lonn,
    },
    opplysninger: opp,
    // Den som bekrefter fastsettelsen: daglig leder, ellers styrelederen, ellers brukeren.
    forslag: {
      bekreftende: roller.find((x) => x.kode === "DAGL")?.navn ?? roller.find((x) => x.kode === "LEDE")?.navn ?? bruker?.navn ?? null,
      kontakt_epost: bruker?.epost ?? null,
    },
    roller: roller
      .filter((x) => SIGNATUR.includes(x.kode))
      .sort((x, y) => SIGNATUR.indexOf(x.kode) - SIGNATUR.indexOf(y.kode))
      .map((x) => ({ rolle: x.rolle, navn: x.navn })),
    aarsoppgjor: { bokfort: Boolean(status.oppgjor.bilag), stemmer: status.oppgjor.stemmer, trengs: status.oppgjor.trengs },
    innsending: {
      status: r?.status ?? "utkast",
      instans_url: r?.instans_url ?? null,
      laast: r?.laast ?? false,
      sendt_at: r?.sendt_at ?? null,
      levert_at: r?.levert_at ?? null,
      sjekket_at: r?.sjekket_at ?? null,
      feil: r?.feil ?? null,
      valideringsfeil: r?.valideringsfeil ?? null,
    },
    altinn: await altinnstatus(db, org),
    feil: [],
    advarsler: [],
  };
  kontroller(a, { n, f, rN, bF, iDag, ukjente: [...bN.keys()].filter((k) => k.slice(0, 4) < "1000" || k.slice(0, 4) > "8999") });
  return a;
}

// --- Kontrollene ----------------------------------------------------------------------------------

function kontroller(
  a: Aarsregnskap,
  x: { n: Record<string, number>; f: Record<string, number>; rN: Map<string, number>; bF: Map<string, number>; iDag: string; ukjente: string[] },
) {
  const { feil, advarsler } = a;
  const opp = a.opplysninger;
  const { n, f } = x;

  if (!a.orgnr) feil.push("Organisasjonen mangler organisasjonsnummer.");
  if (!a.organisasjonsform) feil.push("Fant ikke organisasjonsformen i Enhetsregisteret; prøv igjen senere.");
  else if (a.organisasjonsform !== "AS")
    feil.push(`Årsregnskapet kan foreløpig bare sendes herfra for aksjeselskap (organisasjonsformen er ${a.organisasjonsform}).`);
  if (!a.over) feil.push(`Regnskapsåret ${a.aar} er ikke over.`);

  // Årsoppgjøret: skattekostnaden og disponeringene må være bokført, så resultatkontoene går i null.
  if (a.aarsoppgjor.trengs && !a.aarsoppgjor.bokfort) feil.push(`Årsoppgjøret for ${a.aar} er ikke bokført (Regnskap → Årsoppgjør).`);
  else if (!a.aarsoppgjor.stemmer) feil.push(`Regnskapet for ${a.aar} er endret etter årsoppgjøret; før årsoppgjøret på nytt.`);

  const ekstra = [...x.rN].filter(([k, b]) => k.slice(0, 4) >= "8400" && k.slice(0, 4) <= "8799" && Math.abs(b) >= 0.005).map(([k]) => k);
  if (ekstra.length)
    feil.push(`Kontoene ${ekstra.join(", ")} har ingen post i årsregnskapet for små foretak (ekstraordinære poster); før beløpene på riktig konto.`);
  if (x.ukjente.length) feil.push(`Kontoene ${x.ukjente.join(", ")} er utenfor kontoplanen (1000–8999); før beløpene på riktig konto.`);
  if (n.sumEiendeler !== n.sumEgenkapitalGjeld)
    feil.push(`Balansen går ikke opp: eiendelene er ${kr(n.sumEiendeler!)} kr og egenkapitalen og gjelden ${kr(n.sumEgenkapitalGjeld!)} kr.`);
  if (a.aarsoppgjor.bokfort && n.aarsresultat !== n.sumOverfoeringer)
    feil.push(`Overføringene og disponeringene (${kr(n.sumOverfoeringer!)} kr) er ikke lik årsresultatet (${kr(n.aarsresultat!)} kr).`);
  if (a.har_fjor && a.fjor_for_haand) {
    if (f.sumEiendeler !== f.sumEgenkapitalGjeld) feil.push("Fjorårstallene går ikke opp: sum eiendeler er ikke lik sum egenkapital og gjeld.");
    if (f.aarsresultat !== f.sumOverfoeringer && f.sumOverfoeringer) feil.push("Fjorårstallene går ikke opp: overføringene er ikke lik årsresultatet.");
  }

  // Fastsettelsen og revisjonen.
  const fastsatt = opp.fastsettelsesdato;
  if (!fastsatt) feil.push("Oppgi datoen årsregnskapet ble fastsatt (generalforsamlingen).");
  else if (fastsatt <= a.slutt) feil.push("Årsregnskapet kan ikke være fastsatt før regnskapsåret er over.");
  else if (fastsatt > x.iDag) feil.push("Fastsettelsesdatoen kan ikke være frem i tid.");
  else if (fastsatt > `${a.aar + 1}-06-30`) advarsler.push("Generalforsamlingen skal holdes innen seks måneder etter at regnskapsåret er over (aksjeloven § 5-5).");
  const bekreftende = opp.bekreftende?.trim() ?? "";
  if (bekreftende.length < 3) feil.push("Oppgi navnet på den som bekrefter at årsregnskapet er fastsatt (minst tre tegn).");
  if (opp.revideres === null || opp.revideres === undefined) feil.push("Svar på om årsregnskapet skal revideres.");

  // Notene.
  const aarsverk = opp.aarsverk ?? a.noter.aarsverk_forslag;
  if (opp.usikkerhet_drift && !opp.usikkerhet_tekst?.trim()) feil.push("Beskriv usikkerheten om fortsatt drift i noten.");
  if (opp.laan?.gitt && !opp.laan.tekst?.trim() && !opp.laan.laan_styret && !opp.laan.laan_andre && !opp.laan.sikkerhet_styret && !opp.laan.sikkerhet_andre)
    feil.push("Fyll ut noten om lån og sikkerhetsstillelse til ledende personer og aksjeeiere.");

  // Advarslene.
  if (opp.revideres === false) {
    const over: string[] = [];
    if (n.driftsinntektSum! >= 7_000_000) over.push("driftsinntektene er 7 millioner kroner eller mer");
    if (n.sumEiendeler! >= 27_000_000) over.push("balansesummen er 27 millioner kroner eller mer");
    if (aarsverk >= 10) over.push("selskapet har 10 årsverk eller mer");
    if (over.length) advarsler.push(`Selskapet kan ikke la være å revidere årsregnskapet når ${over.join(" og ")} (aksjeloven § 7-6).`);
  }
  if (a.organisasjonsform === "AS" && n.selskapskapital! < 30_000) advarsler.push("Aksjekapitalen er under 30 000 kr (aksjeloven § 3-1).");
  if (n.sumEgenkapital! < 0 && !opp.usikkerhet_drift)
    advarsler.push("Egenkapitalen er negativ. Vurder om det er usikkerhet om fortsatt drift, og husk handleplikten i aksjeloven § 3-5.");
  if (n.annenEgenkapital! < 0) advarsler.push("Annen egenkapital er negativ; vanligvis står det som udekket tap.");
  if (n.bankinnskudd! < 0) advarsler.push("Bankinnskuddene er negative; en overtrukket konto eller en kassekreditt hører til kortsiktig gjeld (2380).");
  if (n.loennskostnad! > 0 && aarsverk === 0) advarsler.push("Det er lønnskostnader, men ingen årsverk; sjekk antall årsverk i noten.");
  if (!a.har_fjor && a.start === `${a.aar}-01-01` && a.aar > 2000)
    advarsler.push("Fjorårstallene mangler. Ble selskapet stiftet før i år, legger du dem inn fra fjorårets årsregnskap.");
  else if (a.har_fjor && !a.fjor_for_haand && !f.driftsinntektSum && !f.sumDriftskostnad && f.sumEiendeler)
    advarsler.push("Fjorårets resultatregnskap er tomt; legg inn fjorårstallene fra fjorårets årsregnskap.");
  // Resultatet for årene før som ikke er disponert (årsoppgjøret er ikke ført for dem).
  const udisponert = -[...x.bF].reduce((sum, [k, b]) => (k.slice(0, 4) >= "3000" && k.slice(0, 4) <= "8999" ? sum + b : sum), 0);
  if (Math.abs(udisponert) >= 1)
    advarsler.push(`Resultat fra tidligere år (${kr(udisponert)} kr) er ikke ført mot egenkapitalen og er tatt med i annen egenkapital. Før årsoppgjøret for de årene.`);
}

// --- Skjemaene ------------------------------------------------------------------------------------

export function underskjemaData(a: Aarsregnskap) {
  const poster: Record<string, Tall> = {};
  for (const l of [...a.resultat, ...a.balanse]) if (l.type !== "overskrift" && l.vis) poster[l.nokkel!] = { aarets: l.aarets, fjor: l.fjor };
  const opp = a.opplysninger;
  const laan = opp.laan;
  const gjeld = opp.gjeld;
  const lonn = a.noter.lonn;
  const felt: Record<string, string | number | null | undefined> = {
    prinsipper: a.noter.prinsipper,
    usikkerhetDrift: opp.usikkerhet_drift ? "true" : "false",
    usikkerhetTekst: opp.usikkerhet_drift ? opp.usikkerhet_tekst : null,
    aarsverk: aarsverkTekst(opp.aarsverk ?? a.noter.aarsverk_forslag),
    laanStyret: laan?.gitt ? laan.laan_styret : null,
    laanAndre: laan?.gitt ? laan.laan_andre : null,
    sikkerhetStyret: laan?.gitt ? laan.sikkerhet_styret : null,
    sikkerhetAndre: laan?.gitt ? laan.sikkerhet_andre : null,
    renteStyret: laan?.gitt ? laan.rente_styret : null,
    renteAndre: laan?.gitt ? laan.rente_andre : null,
    vilkaarStyret: laan?.gitt ? laan.vilkaar_styret : null,
    vilkaarAndre: laan?.gitt ? laan.vilkaar_andre : null,
    laanTekst: laan?.gitt ? laan.tekst : STANDARD_LAAN,
    gjeldFemAar: gjeld?.over_fem_aar,
    gjeldPant: gjeld?.pantsikret,
    pantsatteEiendeler: gjeld?.pantsatte_eiendeler,
    garantier: gjeld?.garantier,
    gjeldTekst: gjeld?.tekst,
    ytterligere: opp.ytterligere,
  };
  if (lonn) {
    const [l, aga, p, andre] = lonn;
    Object.assign(felt, {
      lonn: l!.aarets,
      aga: aga!.aarets,
      pensjon: p!.aarets,
      andreYtelser: andre!.aarets,
      sumLonn: lonn.reduce((s, x) => s + x.aarets, 0),
      ...(a.har_fjor
        ? { lonnFjor: l!.fjor, agaFjor: aga!.fjor, pensjonFjor: p!.fjor, andreYtelserFjor: andre!.fjor, sumLonnFjor: lonn.reduce((s, x) => s + x.fjor, 0) }
        : {}),
    });
  }
  return { poster, harFjor: a.har_fjor, felt };
}

export function skjemaer(a: Aarsregnskap) {
  const opp = a.opplysninger;
  const hoved = hovedskjemaXml({
    orgnr: a.orgnr ?? "",
    organisasjonsform: a.organisasjonsform ?? "AS",
    navn: a.navn,
    epost: opp.kontakt_epost ?? a.forslag.kontakt_epost,
    aar: a.aar,
    start: a.start,
    slutt: a.slutt,
    fastsettelsesdato: opp.fastsettelsesdato ?? "",
    bekreftende: opp.bekreftende?.trim() ?? "",
    revideres: opp.revideres ?? true,
    utarbeidetAvRegnskapsforer: opp.utarbeidet_av_regnskapsforer ?? false,
    bistandRegnskapsforer: opp.bistand_regnskapsforer ?? false,
    system: "Admin Konsoll",
  });
  return { hoved, under: underskjemaXml(underskjemaData(a)) };
}

// --- Rutene (under /api/org/:org) ------------------------------------------------------------------

const uuid = z.string().uuid();
const orgId = (c: Context) => uuid.parse(c.req.param("org"));
const bruk = <T>(c: Context, fn: (db: Db) => Promise<T>) => somBruker<T>(c.get("bruker").id, fn);
const krev = (db: Db, org: string) => db.query("select faktura.krev($1, 'regnskap')", [org]);
const aarS = z.coerce.number({ error: "Ugyldig år" }).int("Ugyldig år").min(2000, "Ugyldig år").max(2100, "Ugyldig år");
export const SENDT = ["sender", "til_signering", "levert"];

// Standardåret: fjoråret når det har bilag, ellers i år.
async function standardAar(db: Db, org: string, iDag: string) {
  const iAar = Number(iDag.slice(0, 4));
  const har = await en<{ n: boolean }>(db, "select exists (select 1 from faktura.bilag where org_id = $1 and aar = $2) as n", [org, iAar - 1]);
  return har?.n ? iAar - 1 : iAar;
}

export function aarsregnskapRuter() {
  const r = new Hono();

  r.get("/regnskap/aarsregnskap", async (c) => {
    const q = z.object({ aar: aarS.optional() }).parse(c.req.query());
    return c.json(
      await bruk(c, async (db) => {
        await krev(db, orgId(c));
        const iDag = osloIDag();
        const aar = q.aar ?? (await standardAar(db, orgId(c), iDag));
        if (aar > Number(iDag.slice(0, 4))) throw new ApiFeil(400, "Året har ikke begynt");
        return hentAarsregnskap(db, orgId(c), aar, c.get("bruker").id, iDag);
      }),
    );
  });

  // Opplysningene (det som sendes, slås sammen med det som er lagret; null fjerner).
  r.put("/regnskap/aarsregnskap/:aar", async (c) => {
    const aar = aarS.parse(c.req.param("aar"));
    const b = opplysningerS.parse(await c.req.json().catch(() => ({})));
    if (b.fjor) {
      const ukjent = Object.keys(b.fjor).filter((k) => !POSTER.includes(k));
      if (ukjent.length) throw new ApiFeil(400, `Ukjente poster: ${ukjent.join(", ")}`);
    }
    return c.json(
      await bruk(c, async (db) => {
        await krev(db, orgId(c));
        const gammel = await rad(db, orgId(c), aar);
        if (gammel && SENDT.includes(gammel.status))
          throw new ApiFeil(409, gammel.status === "levert" ? "Årsregnskapet er levert" : "Årsregnskapet er sendt til Altinn; trekk det tilbake for å endre det");
        const ny = Object.fromEntries(Object.entries({ ...(gammel?.opplysninger ?? {}), ...b }).filter(([, v]) => v !== null && v !== undefined));
        await db.query(
          `insert into faktura.aarsregnskap (org_id, aar, opplysninger) values ($1, $2, $3::jsonb)
           on conflict (org_id, aar) do update set opplysninger = excluded.opplysninger, oppdatert = now()`,
          [orgId(c), aar, JSON.stringify(ny)],
        );
        return hentAarsregnskap(db, orgId(c), aar, c.get("bruker").id);
      }),
    );
  });

  // Skjemaene som XML (det som sendes til Altinn, eller det som ble sendt).
  r.get("/regnskap/aarsregnskap/:aar/:skjema{(hovedskjema|underskjema)\\.xml}", async (c) => {
    const aar = aarS.parse(c.req.param("aar"));
    const skjema = c.req.param("skjema").replace(".xml", "") as "hovedskjema" | "underskjema";
    const xml = await bruk(c, async (db) => {
      await krev(db, orgId(c));
      const lagret = await en<{ hovedskjema: string | null; underskjema: string | null; status: string }>(
        db,
        "select hovedskjema, underskjema, status from faktura.aarsregnskap where org_id = $1 and aar = $2",
        [orgId(c), aar],
      );
      if (lagret && SENDT.includes(lagret.status) && lagret[skjema]) return lagret[skjema]!;
      const s = skjemaer(await hentAarsregnskap(db, orgId(c), aar, c.get("bruker").id));
      return skjema === "hovedskjema" ? s.hoved : s.under;
    });
    return c.body(xml, 200, { "content-type": "application/xml; charset=utf-8", "content-disposition": `attachment; filename="aarsregnskap-${aar}-${skjema}.xml"` });
  });

  // Årsregnskapet som PDF (til signaturene og arkivet).
  r.get("/regnskap/aarsregnskap/:aar/aarsregnskap.pdf", async (c) => {
    const aar = aarS.parse(c.req.param("aar"));
    const a = await bruk(c, async (db) => {
      await krev(db, orgId(c));
      return hentAarsregnskap(db, orgId(c), aar, c.get("bruker").id);
    });
    const f = await aarsregnskapPdf(a);
    return c.body(f.data as unknown as ArrayBuffer, 200, { "content-type": "application/pdf", "content-disposition": `attachment; filename="${f.filnavn}"` });
  });

  // Send til signering i Altinn: skjemaene lagres slik de sendes, og workeren lager instansen,
  // laster dem opp og låser skjemaet (aarsregnskapInnsending.ts).
  r.post("/regnskap/aarsregnskap/:aar/send", async (c) => {
    krevMfa(c);
    const aar = aarS.parse(c.req.param("aar"));
    const { id, svar } = await bruk(c, async (db) => {
      await krev(db, orgId(c));
      const a = await hentAarsregnskap(db, orgId(c), aar, c.get("bruker").id);
      if (SENDT.includes(a.innsending.status))
        throw new ApiFeil(409, a.innsending.status === "levert" ? "Årsregnskapet er levert" : "Årsregnskapet er sendt til Altinn");
      if (a.feil.length) throw new ApiFeil(409, `Rett dette før årsregnskapet sendes: ${a.feil.join(" ")}`);
      if (!a.altinn.pa) throw new ApiFeil(409, "Innsendingen til Altinn er ikke slått på ennå. Last ned skjemaene og send dem selv i mellomtiden.");
      if (a.altinn.status !== "godkjent") throw new ApiFeil(409, "Koble organisasjonen til Altinn først (Gi tilgang i Altinn).");
      if (!a.altinn.har_pakke) throw new ApiFeil(409, `Utvid tilgangen i Altinn med tilgangspakken «${a.altinn.pakke}» først.`);
      const s = skjemaer(a);
      const rad = (await en<{ id: string }>(
        db,
        `insert into faktura.aarsregnskap (org_id, aar) values ($1, $2) on conflict (org_id, aar) do update set oppdatert = now() returning id`,
        [orgId(c), aar],
      ))!;
      await db.query(
        `update faktura.aarsregnskap set status = 'sender', hovedskjema = $3, underskjema = $4, sendt_at = now(), sendt_av = $5, feil = null,
                valideringsfeil = null, levert_at = null, oppdatert = now()
          where org_id = $1 and id = $2`,
        [orgId(c), rad.id, s.hoved, s.under, c.get("bruker").id],
      );
      return { id: rad.id, svar: await hentAarsregnskap(db, orgId(c), aar, c.get("bruker").id) };
    });
    await leggIKo({ type: "aarsregnskap-send", org_id: orgId(c), aarsregnskap_id: id });
    return c.json(svar);
  });

  // Sjekk statusen i Altinn nå (når siden åpnes eller brukeren kommer tilbake fra Altinn).
  r.post("/regnskap/aarsregnskap/:aar/sjekk", async (c) => {
    const aar = aarS.parse(c.req.param("aar"));
    const rad = await bruk(c, async (db) => {
      await krev(db, orgId(c));
      return en<{ id: string; status: string; sjekket_at: string | null }>(
        db,
        "select id, status, sjekket_at from faktura.aarsregnskap where org_id = $1 and aar = $2",
        [orgId(c), aar],
      );
    });
    const nylig = rad?.sjekket_at && Date.now() - Date.parse(String(rad.sjekket_at)) < 20_000;
    if (rad?.status === "til_signering" && !nylig) await leggIKo({ type: "aarsregnskap-status", org_id: orgId(c), aarsregnskap_id: rad.id });
    return c.json({ ok: true, sjekkes: rad?.status === "til_signering" && !nylig });
  });

  // Trekk tilbake fra signeringen: skjemaet låses opp i Altinn, og årsregnskapet kan endres.
  r.post("/regnskap/aarsregnskap/:aar/tilbake", async (c) => {
    krevMfa(c);
    const aar = aarS.parse(c.req.param("aar"));
    const rad = await bruk(c, async (db) => {
      await krev(db, orgId(c));
      return en<{ id: string; status: string }>(db, "select id, status from faktura.aarsregnskap where org_id = $1 and aar = $2", [orgId(c), aar]);
    });
    if (rad?.status !== "til_signering") throw new ApiFeil(409, "Årsregnskapet venter ikke på signering i Altinn");
    await leggIKo({ type: "aarsregnskap-tilbake", org_id: orgId(c), aarsregnskap_id: rad.id });
    return c.json({ ok: true });
  });

  // Tilgangen i Altinn for Regnskap (den samme systembrukeren som for skattekortene, så den kan gis
  // uten Lønn): be om tilgang, utvid den med tilgangspakken for årsregnskapet, og sjekk den.
  r.get("/regnskap/altinn", async (c) =>
    c.json(
      await bruk(c, async (db) => {
        await krev(db, orgId(c));
        return altinnstatus(db, orgId(c));
      }),
    ),
  );
  r.post("/regnskap/altinn/tilgang", async (c) => {
    krevMfa(c);
    if (!skattekortSattOpp()) throw new ApiFeil(503, "Koblingen til Altinn er ikke satt opp ennå.");
    const s = await bruk(c, async (db) => {
      await db.query("select faktura.be_om_altinntilgang_regnskap($1)", [orgId(c)]);
      return altinnstatus(db, orgId(c));
    });
    await leggIKo({ type: "skattekort-tilgang", org_id: orgId(c) });
    return c.json(s);
  });
  r.post("/regnskap/altinn/utvid", async (c) => {
    krevMfa(c);
    const s = await bruk(c, async (db) => {
      await db.query("select faktura.be_om_utvidet_tilgang_regnskap($1)", [orgId(c)]);
      return altinnstatus(db, orgId(c));
    });
    await leggIKo({ type: "altinn-endring", org_id: orgId(c) });
    return c.json(s);
  });
  r.post("/regnskap/altinn/sjekk", async (c) => {
    const t = await bruk(c, async (db) => {
      await krev(db, orgId(c));
      return en<{ status: string; endring_status: string | null; sjekket: string | null }>(
        db,
        "select status, endring_status, sjekket from faktura.skattekort_tilgang where org_id = $1",
        [orgId(c)],
      );
    });
    const nylig = t?.sjekket && Date.now() - Date.parse(String(t.sjekket)) < 5000;
    const venter = t && (t.status === "ny" || t.status === "venter");
    const endring = t?.status === "godkjent" && (t.endring_status === "ny" || t.endring_status === "venter");
    if (venter && !nylig) await leggIKo({ type: "skattekort-status", org_id: orgId(c) });
    if (endring && !nylig) await leggIKo({ type: "altinn-endring", org_id: orgId(c) });
    return c.json({ ok: true, sjekkes: Boolean(venter || endring) });
  });

  return r;
}

// --- Rapporten (rapportmodulen) ----------------------------------------------------------------------

const STATUSTEKST: Record<Innsending["status"], string> = {
  utkast: "Ikke sendt",
  sender: "Sendes til Altinn",
  til_signering: "Til signering i Altinn",
  levert: "Levert",
  feil: "Feil ved innsendingen",
};

export const aarsregnskapRapporter: Rapportdef[] = [
  {
    id: "regnskap.aarsregnskap",
    modul: "regnskap",
    navn: "Årsregnskap",
    beskrivelse:
      "Årsregnskapet etter oppstillingen for små foretak (Regnskapsregisteret i Brønnøysund): resultatregnskapet for året og balansen 31. desember, med fjoråret, i hele kroner.",
    funksjon: "regnskap",
    tilgang: "regnskap",
    parameter: "aar",
    hent: async (db, org, v) => {
      const a = await hentAarsregnskap(db, org, v.aar);
      const i = a.innsending;
      const status = i.status === "levert" && i.levert_at ? `Levert ${visDato(String(i.levert_at).slice(0, 10))}` : STATUSTEKST[i.status];
      return {
        merknad: `${status}.${a.feil.length && i.status !== "levert" ? ` ${a.feil.length === 1 ? "Ett punkt" : `${a.feil.length} punkter`} må rettes før innsendingen (Regnskap → Årsregnskap).` : ""}`,
        periode: `${visDato(a.start)}–${visDato(a.slutt)}`,
        kolonner: [
          { nokkel: "post", navn: "Post" },
          { nokkel: "aarets", navn: String(a.aar), type: "tall" as const },
          ...(a.har_fjor ? [{ nokkel: "fjor", navn: String(a.aar - 1), type: "tall" as const }] : []),
        ],
        rader: [...a.resultat, ...a.balanse]
          .filter((l) => l.vis)
          .map((l) =>
            l.type === "overskrift"
              ? { post: l.navn.toUpperCase(), aarets: null, fjor: null }
              : { post: l.type === "post" ? `  ${l.navn}` : l.navn, aarets: l.aarets, fjor: a.har_fjor ? l.fjor : null },
          ),
      };
    },
  },
];

export const _test = { kolonne, avrund, linjer, lonnsnote };
