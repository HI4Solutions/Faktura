// Kontonavnene i regnskapet (norsk standard kontoplan, NS 4102): de vanligste kontoene, til
// visningen av bilag, hovedbok og saldobalanse. Kontoene organisasjonen har valgt for lønnen og
// regnskapet (lonnBokforing.ts, anlegg.ts), får navnet på det de brukes til.
import type { Db } from "./db.js";
import { hentBokforingsoppsett, kontoplan as lonnskontoplan, KONTOROLLER } from "./lonnBokforing.js";

export const STANDARDKONTOER: Record<string, string> = {
  "1000": "Forskning og utvikling",
  "1020": "Konsesjoner, patenter, lisenser, varemerker o.l.",
  "1070": "Utsatt skattefordel",
  "1080": "Goodwill",
  "1100": "Bygninger",
  "1120": "Bygningsmessige anlegg",
  "1130": "Anlegg under utførelse",
  "1150": "Tomter og andre grunnarealer",
  "1160": "Boliger inkl. tomter",
  "1200": "Maskiner og anlegg",
  "1220": "Skip, rigger, fly o.l.",
  "1230": "Personbiler",
  "1240": "Varebiler, lastebiler og busser",
  "1250": "Inventar",
  "1270": "Verktøy o.l.",
  "1280": "Kontormaskiner",
  "1290": "Andre driftsmidler",
  "1500": "Kundefordringer",
  "1530": "Opptjent, ikke fakturert inntekt",
  "1570": "Andre kortsiktige fordringer",
  "1700": "Forskuddsbetalt kostnad",
  "1750": "Påløpt inntekt",
  "1900": "Kontanter",
  "1920": "Bank",
  "1950": "Bankinnskudd for skattetrekk",
  "2000": "Aksjekapital",
  "2050": "Annen egenkapital",
  "2400": "Leverandørgjeld",
  "2600": "Forskuddstrekk",
  "2700": "Utgående merverdiavgift",
  "2701": "Utgående merverdiavgift, middels sats",
  "2702": "Utgående merverdiavgift, råfisk",
  "2703": "Utgående merverdiavgift, lav sats",
  "2710": "Inngående merverdiavgift",
  "2740": "Oppgjørskonto merverdiavgift",
  "2770": "Skyldig arbeidsgiveravgift",
  "2900": "Forskudd fra kunder",
  "2960": "Påløpt kostnad",
  "2970": "Uopptjent inntekt",
  "2990": "Annen kortsiktig gjeld",
  "3000": "Salgsinntekt, avgiftspliktig",
  "3030": "Salgsinntekt, avgiftspliktig, middels sats",
  "3035": "Salgsinntekt råfisk, avgiftspliktig, middels sats",
  "3050": "Salgsinntekt tjenester, avgiftspliktig, lav sats",
  "3100": "Salgsinntekt, avgiftsfri",
  "3200": "Salgsinntekt, utenfor avgiftsområdet",
  "3600": "Leieinntekt",
  "3800": "Gevinst ved avgang av anleggsmidler",
  "3900": "Annen driftsrelatert inntekt",
  "4300": "Innkjøp av varer for videresalg",
  "6000": "Avskrivning på bygninger og annen fast eiendom",
  "6010": "Avskrivning på transportmidler, maskiner og inventar",
  "6020": "Avskrivning på immaterielle eiendeler",
  "6050": "Nedskrivning av varige driftsmidler og immaterielle eiendeler",
  "6300": "Leie lokaler",
  "6340": "Lys, varme",
  "6800": "Kontorrekvisita",
  "6900": "Telefon og internett",
  "7500": "Forsikringspremie",
  "7700": "Annen kostnad",
  "7770": "Bank- og kortgebyrer",
  "7800": "Tap ved avgang av anleggsmidler",
  "7830": "Tap på fordringer",
  "8050": "Annen renteinntekt",
  "8150": "Annen rentekostnad",
};

// Kontonavnene for organisasjonen: standarden, lønnskontoene og regnskapskontoene den har valgt.
export async function kontonavnFor(db: Db, org: string, regnskap: { rolle: string; navn: string; konto: string }[] = []) {
  const lonn = lonnskontoplan(await hentBokforingsoppsett(db, org));
  const navn: Record<string, string> = { ...STANDARDKONTOER };
  for (const k of KONTOROLLER) navn[k.standard] ??= k.navn;
  for (const k of KONTOROLLER) navn[lonn[k.rolle]] = k.navn;
  for (const k of regnskap) navn[k.konto] ??= k.navn;
  return (konto: string) => navn[konto] ?? "";
}
