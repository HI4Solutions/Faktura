// Grunnlaget for næringsspesifikasjonen i skattemeldingen (rapporten «Næringsspesifikasjon»): kontoene i
// regnskapet samlet på postene i næringsspesifikasjonen etter Skatteetatens gruppering av standard
// kontoplan (som GroupingCategory og GroupingCode i SAF-T, saft.ts), med navnene på postene fra
// Skatteetaten (github.com/Skatteetaten/saf-t, «Grouping Category Code 2025-2026»,
// naeringsspesifikasjon.csv): resultatregnskapet for året og balansen 31. desember. Regnskapsføreren
// fører postene inn i næringsspesifikasjonen (eller leser inn SAF-T-filen); de skattemessige saldoene og
// forskjellene står i saldoskjemaet.
import { alle, type Db } from "./db.js";
import type { Rapportdef } from "./rapportmodul.js";
import { dato as visDato, kr } from "./regler.js";
import { gruppering } from "./saft.js";
import { bokforSalgNaa } from "./salgBokforing.js";

// Navnet på posten (koden) i næringsspesifikasjonen.
export const POSTNAVN: Record<string, string> = {
  "1000": "Utvikling", "1020": "Varige konsesjoner, patenter, lisenser, rettigheter med mer", "1070": "Utsatt skattefordel", "1080": "Goodwill",
  "1101": "Aktiverte letekostnader", "1102": "Felt under utbygging", "1103": "Produksjonsinnretning og rørledning",
  "1104": "Fjernings- og nedstengningseiendeler", "1105": "Forretningsbygg", "1115": "Bygg, anlegg, hotell o.l.",
  "1117": "Elektroteknisk utrustning i kraftforetak mv.", "1120": "Fast teknisk installasjon i bygninger",
  "1130": "Anlegg og maskiner under bygging", "1140": "Jord- og skogbrukseiendommer", "1150": "Tomter og andre grunnarealer",
  "1160": "Bolig inkl. boligtomter, hytter mv.", "1180": "Investeringseiendommer", "1205": "Personbiler, maskiner, inventar",
  "1221": "Skip, rigger mv.", "1225": "Fly, helikopter mv.", "1238": "Vare- og lastebiler, busser, inkludert varebiler med nullutslipp mv.",
  "1280": "Kontormaskiner o.l.", "1290": "Andre driftsmidler", "1295": "Driftsmidler som avskrives lineært", "1296": "Negativ gevinst- og tapskonto",
  "1298": "Negativ tømmerkonto", "1299": "Negativ jordbrukskonto", "1312": "Investeringer i datter- og konsernselskap med deltakerfastsetting",
  "1313": "Investeringer i andre datter- og konsernselskap", "1320": "Lån til foretak i samme konsern",
  "1331": "Investeringer i tilknyttede selskap med deltakerfastsetting", "1332": "Investeringer i andre tilknyttede selskap",
  "1340": "Lån til tilknyttet selskap og felles kontrollert virksomhet", "1350": "Investeringer i aksjer, andeler og verdipapirfondsandeler",
  "1360": "Obligasjoner", "1370": "Fordringer på personlige eiere, styremedl. o.l.", "1380": "Krav/fordringer mot ansatte",
  "1390": "Andre langsiktige fordringer", "1395": "Netto pensjonsmidler", "1400": "Varelager",
  "1401": "Beholdning av egenproduserte varer for bruk i egen jordbruksvirksomhet", "1470": "Mindreuttak av petroleumsprodukter",
  "1490": "Biologiske eiendeler", "1500": "Kundefordringer", "1501": "Kundefordringer på selskap i samme konsern",
  "1530": "Opptjente ikke fakturerte driftsinntekter", "1560": "Andre fordringer på selskap i samme konsern",
  "1565": "Kortsiktige fordringer mot personlig eier, styremedlem o.l.", "1570": "Andre kortsiktige krav/fordringer",
  "1780": "Krav på innbetalt selskapskapital", "1800": "Ikke-markedsbaserte aksjer og verdipapirfondsandeler",
  "1810": "Markedsbaserte aksjer og verdipapirfondsandeler", "1830": "Markedsbaserte obligasjoner, sertifikater mv.",
  "1840": "Andre obligasjoner og sertifikater", "1880": "Andre finansielle instrumenter", "1895": "Andel i selskap med deltakerfastsetting",
  "1900": "Kontanter", "1920": "Bankinnskudd", "1950": "Innskudd på skattetrekkskonto", "2000": "Aksjekapital/Egenkapital andre foretak",
  "2010": "Egne aksjer", "2015": "Felleseid andelskapital", "2020": "Overkurs", "2030": "Annen innskutt egenkapital", "2041": "Etterbetalingsfond",
  "2042": "Medlemskapitalkonti", "2043": "Fond for vurderingsforskjeller", "2045": "Fond for urealiserte gevinster", "2050": "Positiv egenkapital",
  "2055": "Avsatt utbytte - IFRS", "2080": "Negativ egenkapital", "2095": "Negativ saldo", "2096": "Positiv gevinst og tapskonto",
  "2097": "Betinget avsatt gevinst", "2098": "Positiv tømmerkonto", "2099": "Positiv jordbrukskonto", "2100": "Pensjonsforpliktelser",
  "2120": "Utsatt skatt", "2130": "Derivater", "2160": "Uopptjent inntekt", "2180": "Avsetninger for forpliktelser",
  "2185": "Avsetninger for fjerning- og nedstengningsforpliktelser", "2200": "Konvertible lån", "2210": "Obligasjonslån",
  "2220": "Langsiktig gjeld til banker og andre kredittinstitusjoner", "2250": "Gjeld til ansatte og personlige eiere",
  "2260": "Gjeld til selskap i samme konsern", "2280": "Stille interessentinnskudd og ansvarlig lånekapital", "2290": "Annen langsiktig gjeld",
  "2310": "Konvertible lån", "2320": "Obligasjonslån", "2330": "Derivater", "2380": "Kortsiktig gjeld til banker og andre kredittinstitusjoner",
  "2400": "Gjeld til leverandører", "2460": "Leverandørgjeld til selskap i samme konsern", "2470": "Meruttak av petroleumsprodukter",
  "2500": "Betalbar skatt, ikke fastsatt", "2510": "Betalbar skatt, fastsatt", "2600": "Skattetrekk og andre trekk",
  "2740": "Skyldig merverdiavgift", "2770": "Skyldig arbeidsgiveravgift", "2790": "Andre offentlige avgifter", "2800": "Avsatt utbytte",
  "2900": "Forskudd fra kunder", "2910": "Gjeld til ansatte og personlige eiere", "2920": "Gjeld til selskap i samme konsern",
  "2949": "Skyldig lønn og feriepenger med mer", "2950": "Skyldige gjeldsrenter", "2970": "Uopptjent inntekt",
  "2980": "Avsetninger for forpliktelser", "2981": "Avsatt etterbetaling til utbetaling", "2990": "Annen kortsiktig gjeld",
  "3000": "Salg og uttak med mva-plikt", "3001": "Salgsinntekter og uttak av olje", "3002": "Salgsinntekter og uttak av tørrgass",
  "3003": "Salgsinntekter og uttak av våtgass", "3004": "Tariffinntekt rørledning", "3005": "Tariffinntekt prosessering",
  "3006": "Timer viderefakturert", "3007": "Annen kostnad viderefakturert", "3008": "Endring i mer-/mindreuttak av petroleumsprodukter",
  "3100": "Salg og uttak med 0 prosent mva.", "3200": "Salg og uttak utenfor mva-loven", "3300": "Offentlige særavgifter ved salg",
  "3400": "Offentlige tilskudd og refusjoner", "3500": "Endring uopptjent inntekt", "3600": "Inntekt fra utleie av eiendom",
  "3650": "Utleie av rettigheter til jakt og fiske med mer", "3695": "Andre leieinntekter", "3700": "Provisjon",
  "3710": "Lisens-, patent- og royalty-inntekter", "3850": "Verdiendringer av investeringseiendommer etter IFRS",
  "3870": "Verdiendringer biologiske eiendeler etter IFRS", "3880": "Gevinst ved avgang av immaterielle eiendeler og varige driftsmidler",
  "3885": "Gevinst ved avgang av finansielle anleggsmidler", "3886": "Gevinst ved overdragelse av tillatelse til petroleumsvirksomhet",
  "3890": "Inntekt fra gevinst-/tapskonto", "3895": "Inntekt fra saldo", "3900": "Andre driftsinntekter", "3910": "Inntekt fra tømmerkonto",
  "3911": "Inntekt fra jordbrukskonto", "4001": "Letekostnader", "4002": "Utbyggingskostnader", "4003": "Produksjonskostnader",
  "4004": "Handling fee / Service fee / Trading fee", "4005": "Varekostnader inklusiv endring i beholdningen",
  "4007": "Endring i mer-/mindreuttak av petroleumsprodukter", "4008": "Fjernings- og nedstengningskostnader",
  "4295": "Endring i beholdningen av ferdige og uferdige egenproduserte varerr", "4500": "Innleid arbeidskraft",
  "4995": "Beholdningsendring av egentilvirkede anleggsmidler", "5000": "Lønn og feriepenger med mer",
  "5300": "Andre opplysningspliktige godtgjørelser", "5400": "Arbeidsgiveravgift", "5420": "Opplysningspliktige pensjonskostnader",
  "5600": "Arbeidsgodtgjørelse til eiere i ANS mv.", "5900": "Andre personalkostnader", "5950": "Egen pensjonsordning",
  "6000": "Avskrivning på varige driftsmidler", "6001": "Avskrivning på produksjonsinnretning  og rørledning",
  "6002": "Avskrivning på fjernings- og nedstengningseiendeler", "6004": "Annen avskrivning",
  "6050": "Nedskrivning på varige driftsmidler og immaterielle eiendeler", "6051": "Nedskrivning på produksjonsinnretning og rørledning",
  "6052": "Nedskrivning på aktiverte letekostnader", "6053": "Nedskrivning på anlegg under utførelse", "6054": "Annen nedskrivning",
  "6100": "Frakt- og transportkostnader ved salg", "6110": "Frakt- og transportkostnad vedrørende salg av olje",
  "6120": "Frakt- og transportkostnad vedrørende salg av tørrgass", "6130": "Frakt- og transportkostnad vedrørende salg av LNG",
  "6140": "Frakt- og transportkostnad vedrørende salg av våtgass", "6200": "Energi og brensel med mer til produksjon", "6300": "Leie av lokaler",
  "6340": "Strøm og oppvarming", "6350": "IT kostnader", "6395": "Renovasjon, vann, avløp, renhold med mer",
  "6400": "Leie av maskiner, inventar og utstyr med mer", "6440": "Langtidsleie/leasing av bil",
  "6500": "Verktøy, inventar med mer som skal kostnadsføres direkte", "6600": "Reparasjoner og vedlikehold av bygninger",
  "6695": "Reparasjoner og vedlikehold av utstyr med mer", "6700": "Regnskapstjenester, rådgivning med mer", "6750": "Konserntjenester",
  "6751": "Kostnadsreduksjon timer viderefakturert", "6752": "Kostnadsreduksjon annen kostnad viderefakturert",
  "6995": "Kontorrekvisita, elektronisk kommunikasjon, porto med mer", "6998": "Privat bruk av elektronisk kommunikasjon", "7000": "Drivstoff",
  "7020": "Vedlikehold", "7040": "Forsikring og avgifter", "7080": "Fradrag for bruk av privat bil i næringsvirksomheten",
  "7099": "Privat bruk av næringsbil", "7155": "Reise-, diett- og bilgodtgjørelser, med opplysningsplikt",
  "7165": "Reise- og diettkostnader, uten opplysningsplikt", "7295": "Provisjonskostnader", "7330": "Salgs- og reklamekostnader",
  "7350": "Representasjonskostnader med fradragsrett", "7370": "Representasjonskostnader", "7400": "Kontingenter med fradragsrett",
  "7420": "Gaver med fradragsrett", "7440": "Gaver", "7490": "Kontingenter", "7500": "Forsikringspremier", "7501": "Driftsforsikring",
  "7502": "Utbyggingsforsikring", "7503": "Annen forsikring", "7565": "Garanti- og servicekostnader", "7600": "Lisenser, patenter og royalties",
  "7650": "Forskning og utviklingskostnad", "7651": "Tilskudd til vitenskapelig forskning mv jf sktl § 6-42", "7700": "Andre kostnader",
  "7701": "Co2-avgift", "7830": "Tap på fordringer", "7860": "Tap på kontrakter",
  "7880": "Tap ved avgang av immaterielle eiendeler og varige driftsmidler", "7885": "Tap ved avgang av finansielle anleggsmidler",
  "7886": "Tap ved overdragelse av tillatelse til petroleumsvirksomhet", "7890": "Fradrag fra gevinst- og tapskonto",
  "7897": "Endring i skattemessig tap på fordringer", "7910": "Overført til tømmerkonto av årets overskudd/underskudd",
  "7911": "Kostnadsføring tømmerkonto", "7912": "Overført til jordbrukskonto av årets overskudd/underskudd",
  "7913": "Kostnadsføring fra jordbrukskonto", "8005": "Netto positiv resultatandel vedrørende investering i DS, TS og FKV",
  "8030": "Renteinntekt fra foretak i samme konsern", "8050": "Annen renteinntekt", "8054": "Garantiinntekter fra foretak i samme konsern",
  "8059": "Garantiinntekt", "8060": "Gevinst ved kursendring på valuta",
  "8074": "Gevinst ved realisasjon av aksjer, egenkapitalbevis og fondsandeler", "8075": "Finansinntekt fra foretak i samme konsern",
  "8079": "Andre finansinntekter", "8080": "Verdiøkning av finansielle instrumenter vurdert til virkelig verdi",
  "8090": "Inntekt av andre investeringer/utbytte",
  "8091": "3 % av netto skattefrie inntekter etter fritaksmetoden og 3 % av utdeling fra selskap med deltakerfastsetting til selskapsdeltaker",
  "8100": "Verdireduksjon av finansielle instrumenter vurdert til virkelig verdi",
  "8105": "Netto negativ resultatandel vedrørende investering i DS, TS og FKV", "8115": "Nedskriving av finansielle eiendeler",
  "8120": "Kalkulatorisk rente fjernings- og nedstengningsforpliktelse", "8130": "Rentekostnad til foretak i samme konsern",
  "8150": "Annen rentekostnad", "8154": "Garantikostnad til foretak i samme konsern", "8159": "Annen garantikostnad",
  "8160": "Tap ved kursendring på valuta", "8174": "Tap ved realisasjon av aksjer, egenkapitalbevis og fondsandeler",
  "8175": "Finanskostnader til foretak i samme konsern", "8179": "Andre finanskostnader", "8300": "Betalbar skatt på ordinært resultat",
  "8321": "Økning i utsatt skatt/nedgang i utsatt skattefordel på ordinært resultat",
  "8322": "Nedgang i utsatt skatt/økning i utsatt skattefordel på ordinært resultat", "8323": "For lite avsatt skatt fra forrige år",
  "8324": "For mye avsatt skatt fra forrige år", "8800": "Disponering av årets overskudd/dekning av årets underskudd",
};

// Delene og kategoriene i rekkefølge, med fortegnet: inntektene, egenkapitalen og gjelden er kredit
// (positive), kostnadene og eiendelene debet.
const KATEGORIER: { kategori: string; navn: string; del: "Resultatregnskap" | "Balanse"; fortegn: 1 | -1 }[] = [
  { kategori: "salgsinntekt", navn: "Salgsinntekt", del: "Resultatregnskap", fortegn: -1 },
  { kategori: "annenDriftsinntekt", navn: "Annen driftsinntekt", del: "Resultatregnskap", fortegn: -1 },
  { kategori: "varekostnad", navn: "Varekostnad", del: "Resultatregnskap", fortegn: 1 },
  { kategori: "loennskostnad", navn: "Lønnskostnad", del: "Resultatregnskap", fortegn: 1 },
  { kategori: "annenDriftskostnad", navn: "Annen driftskostnad", del: "Resultatregnskap", fortegn: 1 },
  { kategori: "finansinntekt", navn: "Finansinntekt", del: "Resultatregnskap", fortegn: -1 },
  { kategori: "finanskostnad", navn: "Finanskostnad", del: "Resultatregnskap", fortegn: 1 },
  { kategori: "skattekostnad", navn: "Skattekostnad", del: "Resultatregnskap", fortegn: 1 },
  { kategori: "balanseverdiForAnleggsmiddel", navn: "Anleggsmidler", del: "Balanse", fortegn: 1 },
  { kategori: "balanseverdiForOmloepsmiddel", navn: "Omløpsmidler", del: "Balanse", fortegn: 1 },
  { kategori: "egenkapital", navn: "Egenkapital", del: "Balanse", fortegn: -1 },
  { kategori: "langsiktigGjeld", navn: "Langsiktig gjeld", del: "Balanse", fortegn: -1 },
  { kategori: "kortsiktigGjeld", navn: "Kortsiktig gjeld", del: "Balanse", fortegn: -1 },
];
const rund = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export type Post = { del: string; kategori: string; post: string; navn: string; kontoer: string[]; belop: number };

// Postene for året: resultatkontoene (3000–8799) med bevegelsen i året, balansekontoene (1000–2999)
// med saldoen 31. desember. Disponeringene (8800–8999) er ikke med i næringsspesifikasjonen.
export async function naeringsspesifikasjon(db: Db, org: string, aar: number) {
  await bokforSalgNaa(db, org);
  const kontoer = await alle<{ konto: string; aaret: number; saldo: number }>(
    db,
    `select p.konto,
            coalesce(sum(p.belop) filter (where b.dato >= $2::date), 0)::float8 as aaret,
            sum(p.belop)::float8 as saldo
       from faktura.posteringer p join faktura.bilag b on b.id = p.bilag_id
      where b.org_id = $1 and b.dato <= $3::date
      group by p.konto`,
    [org, `${aar}-01-01`, `${aar}-12-31`],
  );
  const per = new Map<string, Post>();
  let disponert = 0;
  for (const k of kontoer) {
    const n = Number(k.konto.slice(0, 4));
    if (n >= 8800 && n <= 8999) {
      disponert = rund(disponert + k.aaret);
      continue;
    }
    const balanse = n < 3000;
    const verdi = balanse ? k.saldo : k.aaret;
    if (!rund(verdi)) continue;
    const g = gruppering(k.konto);
    const def = KATEGORIER.find((x) => x.kategori === g.kategori);
    if (!def) continue;
    const nokkel = `${g.kategori}|${g.kode}`;
    const p = per.get(nokkel) ?? { del: def.del, kategori: def.navn, post: g.kode, navn: POSTNAVN[g.kode] ?? "", kontoer: [], belop: 0 };
    p.kontoer.push(k.konto);
    p.belop = rund(p.belop + def.fortegn * verdi);
    per.set(nokkel, p);
  }
  const rekke = (p: Post) => KATEGORIER.findIndex((x) => x.navn === p.kategori);
  const poster = [...per.values()]
    .filter((p) => p.belop !== 0)
    .map((p) => ({ ...p, kontoer: p.kontoer.sort() }))
    .sort((a, b) => rekke(a) - rekke(b) || a.post.localeCompare(b.post));
  const sum = (kategorier: string[]) => rund(poster.filter((p) => kategorier.includes(p.kategori)).reduce((s, p) => s + p.belop, 0));
  const inntekter = sum(["Salgsinntekt", "Annen driftsinntekt"]);
  const kostnader = sum(["Varekostnad", "Lønnskostnad", "Annen driftskostnad"]);
  const finans = rund(sum(["Finansinntekt"]) - sum(["Finanskostnad"]));
  const aarsresultat = rund(inntekter - kostnader + finans - sum(["Skattekostnad"]));
  const eiendeler = sum(["Anleggsmidler", "Omløpsmidler"]);
  const ekGjeld = sum(["Egenkapital", "Langsiktig gjeld", "Kortsiktig gjeld"]);
  return { poster, inntekter, kostnader, finans, aarsresultat, disponert, eiendeler, ek_gjeld: ekGjeld, udisponert: rund(eiendeler - ekGjeld) };
}

export const naeringsspesifikasjonRapporter: Rapportdef[] = [
  {
    id: "regnskap.naeringsspesifikasjon",
    modul: "regnskap",
    navn: "Næringsspesifikasjon (grunnlag)",
    beskrivelse:
      "Grunnlaget for næringsspesifikasjonen i skattemeldingen: kontoene samlet på postene i næringsspesifikasjonen (Skatteetatens gruppering, som i SAF-T), resultatregnskapet for året og balansen 31. desember, med årsresultatet og kontrollen av balansen. De skattemessige saldoene og forskjellene står i saldoskjemaet.",
    funksjon: "regnskap",
    tilgang: "regnskap",
    parameter: "aar",
    hent: async (db, org, v) => {
      const s = await naeringsspesifikasjon(db, org, v.aar);
      const merknad = [
        `Driftsinntekter ${kr(s.inntekter)} kr, driftskostnader ${kr(s.kostnader)} kr, netto finans ${kr(s.finans)} kr og årsresultat ${kr(s.aarsresultat)} kr.`,
        `Eiendeler ${kr(s.eiendeler)} kr, egenkapital og gjeld ${kr(s.ek_gjeld)} kr per ${visDato(`${v.aar}-12-31`)}.`,
        Math.abs(s.udisponert) >= 0.005
          ? `Resultat som ikke er disponert: ${kr(s.udisponert)} kr (årsoppgjøret for ${v.aar} er ikke bokført, eller noe er ført etterpå), så egenkapitalen er ikke ferdig.`
          : "",
        "Postene er etter Skatteetatens gruppering av standard kontoplan; kontroller kontoer som ikke er i standard kontoplan, og før de skattemessige forskjellene fra saldoskjemaet.",
      ]
        .filter(Boolean)
        .join(" ");
      return {
        merknad,
        kolonner: [
          { nokkel: "del", navn: "Del", type: "tekst" },
          { nokkel: "post", navn: "Post", type: "tekst" },
          { nokkel: "navn", navn: "Navn" },
          { nokkel: "kontoer", navn: "Kontoer", type: "tekst" },
          { nokkel: "belop", navn: "Beløp", type: "kr" },
        ],
        rader: s.poster.map((p) => ({ del: p.del, post: p.post, navn: p.navn || p.kategori, kontoer: p.kontoer.join(", "), belop: p.belop })),
      };
    },
  },
];
