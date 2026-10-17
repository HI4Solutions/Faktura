// Årsregnskapet som XML til Regnskapsregisteret (aarsregnskap.ts, aarsregnskapInnsending.ts):
// hovedskjemaet (RR-0002, dataformat 1266/51820) med innsenderen, perioden, regnskapsreglene,
// fastsettelsen og revisjonen, og underskjemaet (RR-0002-U, 758/51980) med resultatregnskapet,
// balansen og notene. Skjemaene ligger i server/test/xsd, og testene validerer mot dem.
//
// Hvert felt har et fast orid-attributt (Brønnøysunds feltnummer). Rekkefølgen er skjemaets, så
// treet under følger XSD-en: «navn =post A F» er en post med årets (orid A) og fjorårets (orid F)
// beløp, «navn :felt O» et enkeltfelt med orid O, og en linje uten merke er en gruppe. Det som
// ikke har verdi, utelates (også grupper uten innhold). Beløpene er hele kroner (valør H).

export type Tall = { aarets: number; fjor: number };
export type Underskjemadata = {
  poster: Record<string, Tall>; // postene som skal med (nøklene i treet), med fortegnene Brønnøysund bruker
  harFjor: boolean; // fjorårets beløp sendes bare når foretaket hadde et regnskapsår før
  felt: Record<string, string | number | null | undefined>; // notene
};
export type Hovedskjemadata = {
  orgnr: string;
  organisasjonsform: string;
  navn: string;
  epost: string | null;
  aar: number;
  start: string;
  slutt: string;
  fastsettelsesdato: string;
  bekreftende: string;
  revideres: boolean;
  utarbeidetAvRegnskapsforer: boolean;
  bistandRegnskapsforer: boolean;
  system: string;
};

const UNDERSKJEMA = `
Skjemainnhold-RR0002U
 resultatregnskapDriftsresultat
  driftsresultat =driftsresultat 146 7026
  inntekt
   salgsinntekt =salgsinntekt 1340 7965
   driftsinntekt =annenDriftsinntekt 7709 7966
   driftsinntektSum =driftsinntektSum 72 6972
  kostnad
   varekostnad =varekostnad 101 6977
   loennskostnad =loennskostnad 81 6979
   avskrivning =avskrivning 2139 10181
   nedskrivning =nedskrivning 2354 10180
   annenDriftskostnad =annenDriftskostnad 82 7023
   sumDriftskostnad =sumDriftskostnad 17126 17127
 resultatregnskapFinansinntekt
  nettoFinans =nettoFinans 158 7999
  finansinntekt
   investeringDatterforetakTilknyttetSelskap =investeringDatterTilknyttet 27934 27935
   andreInvesteringer =andreInvesteringer 27936 27937
   renteinntektSammeKonsern =renteinntektKonsern 149 7029
   annenRenteinntekt =annenRenteinntekt 150 7030
   annenFinansinntekt =annenFinansinntekt 152 7032
   verdioekningFinansielleInstrumenter =verdioekningFinansielle 24998 24999
   sumFinansinntekter =sumFinansinntekter 153 7993
  finanskostnad
   verdireduksjonFinansielleInstrumenter =verdireduksjonFinansielle 25004 25005
   nedskrivningFinansielleEiendeler =nedskrivningFinansielle 7035 7036
   rentekostnad =rentekostnadKonsern 7037 7038
   annenRentekostnad =annenRentekostnad 2216 7039
   annenFinanskostnad =annenFinanskostnad 156 7041
   sumFinanskostnader =sumFinanskostnader 17130 17131
 resultatregnskapResultat
  resultat
   resultatFoerSkattekostnad =resultatFoerSkatt 167 7042
   skattekostnad =skattekostnad 11835 11836
   aarsresultat =aarsresultat 172 7054
  overfoeringer
   overfoeringTilFraFond =overfoeringFond 7055 7056
   utbytte =utbytte 6112 9952
   konsernbidrag =konsernbidrag 6113 10288
   avgittKonsernbidrag =avgittKonsernbidrag 36636 36637
   fondsemisjon =fondsemisjon 183 7064
   udekketTap =udekketTapOverfoering 185 7070
   overfoeringTilFraAnnenEgenkapital =overfoeringAnnenEK 7065 7066
   sumOverfoeringerOgDisponeringer =sumOverfoeringer 7071 7072
 balanseAnleggsmidlerOmloepsmidler
  sumEiendeler =sumEiendeler 219 7127
  balanseAnleggsmidler
   sumAnleggsmidler =sumAnleggsmidler 217 7108
   immaterielleEiendelerVarigeDriftsmidler
    immaterielleEiendeler
     forskningUtvikling =forskningUtvikling 7073 7074
     konsesjonerPatenterLisenserVaremerkerRettigheter =konsesjoner 205 7075
     utsattSkattefordel =utsattSkattefordel 202 7076
     goodwill =goodwill 206 7077
     sumImmaterielleEiendeler =sumImmaterielle 2400 8006
    varigeDriftsmidler
     tomterBygningerAnnenFastEiendom =tomterBygninger 1976 8007
     maskinAnlegg =maskinAnlegg 1975 8008
     skipRiggFly =skipRiggFly 1348 7084
     driftsloesoereInventarVerktoeyKontormaskin =driftsloesoere 7725 8009
     sumVarigeDriftsmidler =sumVarigeDriftsmidler 47 8010
   balanseFinansielleAnleggsmidler
    investeringDatterselskap =investeringDatterselskap 9686 10289
    investeringAnnetForetakSammeKonsern =investeringKonsern 7727 8012
    laanForetakSammeKonsern =laanKonsern 6500 7093
    investeringTilknyttetSelskap =investeringTilknyttet 7726 8013
    laanTilknyttetSelskapFelleskontrollertVirksomhet =laanTilknyttet 7098 7099
    investeringAksjerAndeler =investeringAksjer 7100 7101
    obligasjon =obligasjoner 27583 27584
    annenFordring =andreFordringerAnlegg 203 27585
    sumFinansielleAnleggsmidler =sumFinansielleAnleggsmidler 5267 8014
  balanseOmloepsmidler
   sumOmloepsmidler =sumOmloepsmidler 194 7126
   balanseOmloepsmidlerVarerFordringer
    varer
     lagerbeholdning =varer 326 797
     sumVarer =sumVarer 25012 25013
    fordringer
     kundefordringer =kundefordringer 116 6921
     andreFordringer =andreFordringer 282 7112
     konsernfordringer =konsernfordringer 7128 6946
     kravInnbetalingSelskapskapital =kravInnbetaling 7113 7114
     sumFordringer =sumFordringer 80 8015
   balanseOmloepsmidlerInvesteringerBankinnskuddKontanter
    investering
     aksjerAndelerForetakSammeKonsern =aksjerKonsern 7728 8016
     markedsbaserteAksjer =markedsbaserteAksjer 7117 7118
     markedsbaserteObligasjoner =markedsbaserteObligasjoner 9687 10291
     andreMarkedsbaserteFinansielleInstrumenter =andreMarkedsbaserte 7731 8017
     andreFinansielleInstrumenter =andreFinansielleInstrumenter 6429 7123
     sumInvesteringer =sumInvesteringer 6601 8018
    bankinnskuddKontanter
     bankinnskuddKontanter =bankinnskudd 786 8019
     sumBankinnskuddKontanter =sumBankinnskudd 29042 29043
 balanseEgenkapitalGjeld
  sumEgenkapitalGjeld =sumEgenkapitalGjeld 251 7185
  balanseEgenkapitalInnskuttOpptjentEgenkapital
   innskuttEgenkapital
    selskapskapital =selskapskapital 20488 20489
    egneAksjer =egneAksjer 7131 7132
    overkursfond =overkursfond 2585 7135
    annenInnskuttEgenkapital =annenInnskuttEK 17110 17111
    sumInnskuttEgenkapital =sumInnskuttEK 3730 9984
   opptjentEgenkaiptal
    fond =fond 27579 27580
    annenEgenkapital =annenEgenkapital 3274 7140
    udekketTap =udekketTap 249 7141
    sumOpptjentEgenkapital =sumOpptjentEK 9702 9985
    sumEgenkapital =sumEgenkapital 250 7142
  balanseGjeldOversikt
   sumGjeld =sumGjeld 1119 7184
   balanseGjeldAvsetningerForpliktelserAnnenLangsiktigGjeld
    sumLangsiktigGjeld =sumLangsiktigGjeld 86 7156
    avsetningForpliktelser
     pensjonsforpliktelse =pensjonsforpliktelser 238 6685
     utsattSkatt =utsattSkatt 237 7143
     andreAvsetningerForpliktelser =andreAvsetninger 7157 7146
     sumAvsetningerForpliktelser =sumAvsetninger 7231 7230
    annenLangsiktigGjeld
     konvertibleLaan =konvertibleLaanLang 7147 7148
     obligasjonslaan =obligasjonslaan 6091 7149
     gjeldKredittinstitusjoner =gjeldKredittLang 7150 7151
     langsiktigKonserngjeld =konserngjeldLang 2256 7152
     ansvarligLaanekapital =ansvarligLaanekapital 243 9989
     oevrigLangsiktigGjeld =oevrigLangsiktig 242 7155
     sumAnnenLangsiktigGjeld =sumAnnenLangsiktig 25019 25020
   balanseKortsiktigGjeld
    konvertibleLaan =konvertibleLaanKort 7158 7159
    sertifikatlaan =sertifikatlaan 9 7160
    gjeldKredittinstitusjoner =gjeldKredittKort 10926 13203
    leverandoergjeld =leverandoergjeld 220 7162
    betalbarSkatt =betalbarSkatt 2483 10293
    skyldigeOffentligeAvgifter =skyldigeOffentligeAvgifter 225 7170
    utbytte =utbytteGjeld 235 7171
    kortsiktigKonserngjeld =konserngjeldKort 2255 7175
    annenKortsiktigGjeld =annenKortsiktigGjeld 236 7182
    sumKortsiktigGjeld =sumKortsiktigGjeld 85 7183
 noter
  noteRegnskapsPrinsipp
   regnskapsPrinsippFritekst :prinsipper 37442
   usikkerhetDrift :usikkerhetDrift 37443
   usikkerhetDriftFritekst :usikkerhetTekst 37444
  noteAarsverkTjenestePensjon
   antallAarsverk :aarsverk 37467
  noteLaanLedendePerson
   samletLaanMedlemmerStyret :laanStyret 39889
   samletLaanAndreMedlemmer :laanAndre 39890
   samletSikkerhetsstillelseMedlemmerStyret :sikkerhetStyret 39891
   samletSikkerhetsstillelseAndreMedlemmer :sikkerhetAndre 39892
   rentesatsMedlemmerStyret :renteStyret 39893
   rentesatsAndreMedlemmer :renteAndre 39894
   hovedvilkaarMedlemmerStyret :vilkaarStyret 39895
   hovedvilkaarAndreMedlemmer :vilkaarAndre 39896
   laanSikkerhetLedendeFritekst :laanTekst 37477
  noteSpesifiseringResultatregnskap
   noteLoennAarets :lonn 37525
   noteLoennFjoraarets :lonnFjor 37526
   noteArbGivAvgAarets :aga 37527
   noteArbGivAvgFjoraarets :agaFjor 37528
   notePensjonskostnaderAarets :pensjon 37529
   notePensjonskostnaderFjoraarets :pensjonFjor 37530
   noteAndreYtelserAarets :andreYtelser 37531
   noteAndreYtelserFjoraarets :andreYtelserFjor 37532
   noteSumLoennAarets :sumLonn 37533
   noteSumLoennFjoraarets :sumLonnFjor 37534
  noteGjeld
   noteGjeldForfallerEtterFemAar :gjeldFemAar 40005
   noteGjeldMedSikkerhetIRegnskapsplEiendeler :gjeldPant 40006
   noteGjeldBalansefoertVerdiPantsatteEiendeler :pantsatteEiendeler 40008
   sumGarantiforpliktelserIkkeRegnskapsfoert :garantier 39936
   noteMerOmGjeldFritekst :gjeldTekst 38601
  noteYtterligereOpplysninger :ytterligere 37551
`;

type Node =
  | { navn: string; type: "post"; nokkel: string; aarets: string; fjor: string }
  | { navn: string; type: "felt"; nokkel: string; orid: string }
  | { navn: string; type: "gruppe"; barn: Node[] };

// Treet fra teksten over (innrykket med ett mellomrom per nivå).
function lesTre(tekst: string): Node {
  const rot: Node = { navn: "", type: "gruppe", barn: [] };
  const stakk: { niva: number; node: Node & { type: "gruppe" } }[] = [{ niva: -1, node: rot }];
  for (const linje of tekst.split("\n")) {
    if (!linje.trim()) continue;
    const niva = linje.length - linje.trimStart().length;
    const [navn, merke, a, b] = linje.trim().split(/\s+/);
    const node: Node = merke?.startsWith("=")
      ? { navn: navn!, type: "post", nokkel: merke.slice(1), aarets: a!, fjor: b! }
      : merke?.startsWith(":")
        ? { navn: navn!, type: "felt", nokkel: merke.slice(1), orid: a! }
        : { navn: navn!, type: "gruppe", barn: [] };
    while (stakk.at(-1)!.niva >= niva) stakk.pop();
    stakk.at(-1)!.node.barn.push(node);
    if (node.type === "gruppe") stakk.push({ niva, node });
  }
  return rot.barn[0]!;
}
const TRE = lesTre(UNDERSKJEMA);

// Nøklene til postene og feltene i underskjemaet (testene sjekker at oppstillingen bruker dem).
export const POSTNOKLER = new Set<string>();
export const FELTNOKLER = new Set<string>();
(function samle(n: Node) {
  if (n.type === "post") POSTNOKLER.add(n.nokkel);
  else if (n.type === "felt") FELTNOKLER.add(n.nokkel);
  else n.barn.forEach(samle);
})(TRE);

export const xmlTekst = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
const helt = (n: number) => String(Math.round(n));

function skriv(n: Node, d: Underskjemadata): string {
  if (n.type === "post") {
    const t = d.poster[n.nokkel];
    if (!t) return "";
    const fjor = d.harFjor ? `<fjoraarets orid="${n.fjor}">${helt(t.fjor)}</fjoraarets>` : "";
    return `<${n.navn}><aarets orid="${n.aarets}">${helt(t.aarets)}</aarets>${fjor}</${n.navn}>`;
  }
  if (n.type === "felt") {
    const v = d.felt[n.nokkel];
    if (v === null || v === undefined || v === "") return "";
    return `<${n.navn} orid="${n.orid}">${xmlTekst(String(v))}</${n.navn}>`;
  }
  const inni = n.barn.map((b) => skriv(b, d)).join("");
  return inni ? `<${n.navn}>${inni}</${n.navn}>` : "";
}

export function underskjemaXml(d: Underskjemadata): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<melding xmlns="http://schema.brreg.no/regnsys/aarsregnskap_vanlig/underskjema" dataFormatId="758" dataFormatVersion="51980" ` +
    `tjenestehandling="aarsregnskap_vanlig_underskjema" tjeneste="regnskap">` +
    `<Rapport-RR0002U><aarsregnskap><regnskapstype orid="25942">S</regnskapstype><valuta orid="34984">NOK</valuta>` +
    `<valoer orid="28974">H</valoer></aarsregnskap></Rapport-RR0002U>` +
    skriv(TRE, d) +
    `</melding>`
  );
}

const jaNei = (b: boolean) => (b ? "ja" : "nei");

export function hovedskjemaXml(d: Hovedskjemadata): string {
  const f = (navn: string, orid: string, v: string) => `<${navn} orid="${orid}">${xmlTekst(v)}</${navn}>`;
  // Revisjonsspørsmålene gjelder bare aksjeselskap.
  const as = d.organisasjonsform === "AS";
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<melding xmlns="http://schema.brreg.no/regnsys/aarsregnskap_vanlig" dataFormatId="1266" dataFormatVersion="51820" ` +
    `tjenestehandling="aarsregnskap_vanlig" tjeneste="regnskap">` +
    `<Innsender><enhet>${f("organisasjonsnummer", "18", d.orgnr)}${f("organisasjonsform", "756", d.organisasjonsform)}${f("navn", "1", d.navn.slice(0, 175))}</enhet>` +
    (d.epost ? `<kontaktperson>${f("e-post", "19022", d.epost.slice(0, 70))}</kontaktperson>` : "") +
    // Notene er fylt ut i underskjemaet etter notemalen for små foretak (10).
    `<opplysningerInnsending>${f("noteMaskinellBehandling", "37499", "10")}${f("systemNavn", "39007", d.system.slice(0, 50))}</opplysningerInnsending>` +
    `</Innsender>` +
    `<Skjemainnhold>` +
    `<regnskapsperiode>${f("regnskapsaar", "17102", String(d.aar))}${f("regnskapsstart", "17103", d.start)}${f("regnskapsslutt", "17104", d.slutt)}</regnskapsperiode>` +
    `<konsern>${f("morselskap", "4168", "nei")}</konsern>` +
    `<regnskapsprinsipper>${f("smaaForetak", "8079", "ja")}${f("regnskapsreglerSelskap", "25021", "nei")}${f("forenkletIFRS", "36639", "nei")}</regnskapsprinsipper>` +
    `<fastsettelse>${f("fastsettelsedato", "17105", d.fastsettelsesdato)}${f("bekreftendeSelskapsrepresentant", "19023", d.bekreftende.slice(0, 70))}</fastsettelse>` +
    (as
      ? `<revisjonRegnskapsfoerer>${f("aarsregnskapIkkeRevideres", "34669", jaNei(!d.revideres))}` +
        `${f("aarsregnskapUtarbeidetAutorisertRegnskapsfoerer", "34670", jaNei(d.utarbeidetAvRegnskapsforer))}` +
        `${f("tjenestebistandEksternAutorisertRegnskapsfoerer", "34671", jaNei(d.bistandRegnskapsforer))}</revisjonRegnskapsfoerer>`
      : "") +
    // Små foretak har ikke plikt til årsberetning (regnskapsloven § 3-1).
    `<aarsberetning/>` +
    `</Skjemainnhold>` +
    `</melding>`
  );
}
