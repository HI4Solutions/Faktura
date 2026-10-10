// Lønnsartene i lønnskjøringen (0065_lonn.sql): hva hver linje er, og om den er trekkpliktig
// (forskuddstrekk), avgiftspliktig (arbeidsgiveravgift), med i feriepengegrunnlaget og i
// grunnlaget for OTP. type: lønn (bruttolønnen), utgift (godtgjørelse, utbetales i tillegg; den
// trekkpliktige delen av reisegodtgjørelsen er trekk- og avgiftspliktig), trekk (trekkes etter
// skatt) eller natural (naturalytelse: trekk- og avgiftspliktig, men utbetales ikke; 0083).
// fortegn: vanlig fortegn på beløpet (trekk er negative). manuell: kan velges når en linje legges
// til.
// amelding: beskrivelsen i a-meldingen (steg 4). fradrag: trekket reduserer grunnlaget for
// forskuddstrekket (fagforeningskontingent, 0082). prosenttrekk: med tabellkort trekkes skatten av
// linjen etter prosentsatsen (ytelser som ikke er lønn for en bestemt periode: tillegget for den
// ekstra ferieuka, honorar, styrehonorar og sluttvederlag).
//
// Feriepenger er trekkpliktige, men ved tabelltrekk trekkes det ikke skatt av feriepenger som
// utbetales i ferieåret (opptjent året før); tillegget for den ekstra ferieuka over 60 år trekkes
// alltid (etter prosentsatsen). OTP-grunnlaget er den faste og den vanlige lønnen (ikke overtid,
// bonus og feriepenger, og ferietrekket gjør det ikke mindre).

export type Lonnsart = {
  kode: string;
  navn: string;
  type: "lonn" | "utgift" | "trekk" | "natural";
  trekk: boolean;
  aga: boolean;
  ferie: boolean;
  otp: boolean;
  fortegn: 1 | -1;
  manuell: boolean;
  amelding: string | null;
  fradrag?: boolean;
  prosenttrekk?: boolean;
};

const lonn = (kode: string, navn: string, x: Partial<Lonnsart> = {}): Lonnsart => ({
  kode,
  navn,
  type: "lonn",
  trekk: true,
  aga: true,
  ferie: true,
  otp: true,
  fortegn: 1,
  manuell: true,
  amelding: null,
  ...x,
});

const trekk = (kode: string, navn: string, x: Partial<Lonnsart> = {}): Lonnsart => ({
  kode,
  navn,
  type: "trekk",
  trekk: false,
  aga: false,
  ferie: false,
  otp: false,
  fortegn: -1,
  manuell: true,
  amelding: null,
  ...x,
});

const utgift = (kode: string, navn: string, amelding: string | null, x: Partial<Lonnsart> = {}): Lonnsart => ({
  kode,
  navn,
  type: "utgift",
  trekk: false,
  aga: false,
  ferie: false,
  otp: false,
  fortegn: 1,
  manuell: false,
  amelding,
  ...x,
});

const natural = (kode: string, navn: string, amelding: string, x: Partial<Lonnsart> = {}): Lonnsart => ({
  kode,
  navn,
  type: "natural",
  trekk: true,
  aga: true,
  ferie: false,
  otp: false,
  fortegn: 1,
  manuell: true,
  amelding,
  ...x,
});

export const LONNSARTER: Lonnsart[] = [
  lonn("fastlonn", "Fastlønn", { amelding: "fastloenn" }),
  lonn("timelonn", "Timelønn", { amelding: "timeloenn" }),
  lonn("merarbeid", "Merarbeid", { amelding: "timeloenn" }),
  // Timer uten overtidstillegg etter avtale (fastlønn: timesatsen; timelønn: med i timelønnen).
  lonn("ekstratimer", "Ekstratimer (uten overtid)", { amelding: "timeloenn" }),
  lonn("overtid", "Overtid", { otp: false, amelding: "overtidsgodtgjoerelse" }),
  // Timebanken (0073): timer tatt ut som fri lønnes for den med timelønn når de tas ut, og timer
  // kan betales ut fra banken. Regnes av banken, så de legges ikke til for hånd.
  lonn("avspasering", "Avspasering fra timebanken", { manuell: false, amelding: "timeloenn" }),
  lonn("timebank", "Utbetalt fra timebanken", { manuell: false, amelding: "timeloenn" }),
  // Permisjon med lønn (0074): timene lønnes for den med timelønn (med fastlønn går lønnen som
  // vanlig). Regnes av fraværet.
  lonn("permisjon", "Permisjon med lønn", { manuell: false, amelding: "timeloenn" }),
  lonn("fast_tillegg", "Fast tillegg", { amelding: "fastTillegg" }),
  lonn("uregelmessig_tillegg", "Tillegg for kveld, natt eller helg", { amelding: "uregelmessigeTilleggKnyttetTilArbeidetTid" }),
  lonn("bonus", "Bonus", { otp: false, amelding: "bonus" }),
  // Sluttvederlag (sluttpakke) fra arbeidsgiveren når arbeidsforholdet slutter (0098): trekk- og
  // avgiftspliktig, ikke med i feriepengene og OTP. Lønn i oppsigelsestiden er vanlig lønn. (Den
  // tariffestede sluttvederlagsordningen LO/NHO er avviklet; utbetalinger fra den kom fra ordningen.)
  lonn("sluttvederlag", "Sluttvederlag", { ferie: false, otp: false, amelding: "sluttvederlag", prosenttrekk: true }),
  lonn("etterbetaling", "Etterbetaling", { amelding: "fastloenn" }),
  // Etterbetaling (eller trekk) når lønnen er endret tilbake i tid (0080): timelønn og merarbeid, og
  // overtid. Regnes av lønnshistorikken.
  lonn("etterbetaling_time", "Etterbetaling timelønn", { manuell: false, amelding: "timeloenn" }),
  lonn("etterbetaling_overtid", "Etterbetaling overtid", { otp: false, manuell: false, amelding: "overtidsgodtgjoerelse" }),
  lonn("sykepenger", "Sykepenger i arbeidsgiverperioden", { amelding: "timeloenn" }),
  // Etter arbeidsgiverperioden (0079): arbeidsgiveren betaler (forskutterer) og krever refusjon fra
  // NAV, eller NAV betaler, og da trekkes fastlønnen for de dagene. Regnes av fraværet.
  lonn("sykepenger_nav", "Sykepenger etter arbeidsgiverperioden (refusjon fra NAV)", { manuell: false, amelding: "timeloenn" }),
  lonn("trekk_sykdom", "Trekk for sykdom (NAV betaler sykepengene)", { fortegn: -1, manuell: false, amelding: "fastloenn" }),
  lonn("omsorgspenger", "Omsorgspenger (sykt barn)", { amelding: "timeloenn" }),
  lonn("feriepenger", "Feriepenger", { ferie: false, otp: false, amelding: "feriepenger" }),
  lonn("feriepenger_60", "Feriepenger for den ekstra ferieuka (over 60 år)", { ferie: false, otp: false, amelding: "feriepenger", prosenttrekk: true }),
  lonn("ferietrekk", "Trekk i lønn for ferie", { ferie: false, otp: false, fortegn: -1, amelding: "trekkILoennForFerie" }),
  lonn("trekk_permisjon", "Trekk for permisjon uten lønn", { fortegn: -1, amelding: "fastloenn" }),
  // Permittering (0084, permisjoner.ts): fastlønnen trekkes etter lønnsplikten, og med timelønn
  // lønnes de planlagte timene i lønnspliktperioden. Regnes av fraværet.
  lonn("trekk_permittering", "Trekk for permittering", { fortegn: -1, manuell: false, amelding: "fastloenn" }),
  lonn("lonnsplikt", "Lønn i lønnspliktperioden ved permittering", { manuell: false, amelding: "timeloenn" }),
  // Frilansere, oppdragstakere og styremedlemmer (0096): honorar i stedet for lønn, trekk- og
  // avgiftspliktig, men ikke med i feriepengene og OTP. Det faste honoraret og timene regnes som
  // honorar av den typen den ansatte har; de kan også legges til for hånd.
  lonn("honorar", "Honorar (oppdrag)", { ferie: false, otp: false, amelding: "honorarAkkordProsentProvisjon", prosenttrekk: true }),
  lonn("styrehonorar", "Styrehonorar og godtgjørelse for verv", { ferie: false, otp: false, amelding: "styrehonorarOgGodtgjoerelseVerv", prosenttrekk: true }),
  { kode: "utgift", navn: "Utgiftsgodtgjørelse (ikke skattepliktig)", type: "utgift", trekk: false, aga: false, ferie: false, otp: false, fortegn: 1, manuell: true, amelding: null },
  { kode: "trekk_etter_skatt", navn: "Trekk etter skatt", type: "trekk", trekk: false, aga: false, ferie: false, otp: false, fortegn: -1, manuell: true, amelding: null },
  // Faste trekk (0082, lonnstrekk.ts): etter pålegg (utleggstrekk og bidragstrekk, i a-meldingen
  // bare utleggstrekkene til Skatteetaten), fagforeningskontingent (fradrag i a-meldingen, og
  // grunnlaget for forskuddstrekket blir mindre) og tilbakebetaling av forskudd. Forskuddet selv er
  // et lån som utbetales uten skatt (ikke i a-meldingen).
  trekk("utleggstrekk_samordnet", "Utleggstrekk (samordnet, Skatteetaten)"),
  trekk("utleggstrekk_skatt", "Utleggstrekk for skattekrav"),
  trekk("utleggstrekk", "Utleggstrekk (namsmannen og andre)"),
  trekk("bidragstrekk", "Bidragstrekk"),
  trekk("fagforening", "Fagforeningskontingent", { fradrag: true }),
  trekk("forskudd_trekk", "Tilbakebetaling av forskudd"),
  { kode: "forskudd_utbetalt", navn: "Forskudd på lønn (lån)", type: "utgift", trekk: false, aga: false, ferie: false, otp: false, fortegn: 1, manuell: true, amelding: null },
  // Reiser (0083, reise.ts): kost, nattillegg og kilometergodtgjørelse innenfor de trekkfrie
  // satsene (trekkfri utgiftsgodtgjørelse med antall døgn, netter eller km), det som er over
  // (trekkpliktig), og utlegg etter regning (rapporteres ikke). Regnes av reiseregningene.
  utgift("reise_kost_hotell", "Kost på reise med overnatting (hotell)", "reiseKostMedOvernattingPaaHotell"),
  utgift("reise_kost_hybel", "Kost på reise med overnatting (hybel, pensjonat, brakke)", "reiseKostMedOvernattingPaaHybelUtenKokEllerPensjonatEllerBrakke"),
  utgift("reise_kost_privat", "Kost på reise med overnatting (hybel med kokemulighet, privat)", "reiseKostMedOvernattingPaaHybelMedKokEllerPrivat"),
  utgift("reise_kost_dag", "Kost på dagsreise", "reiseKostUtenOvernatting"),
  utgift("reise_nattillegg", "Nattillegg", "reiseNattillegg"),
  utgift("reise_kost_trekk", "Kost på reise (trekkpliktig)", "reiseKost", { trekk: true, aga: true }),
  utgift("reise_annet_trekk", "Annen godtgjørelse på reise (trekkpliktig)", "reiseAnnet", { trekk: true, aga: true }),
  utgift("km_bil", "Kilometergodtgjørelse", "kilometergodtgjoerelseBil"),
  utgift("km_tillegg", "Tillegg for skogsvei og tilhenger", "kilometergodtgjoerelseBil"),
  utgift("km_passasjer", "Passasjertillegg", "kilometergodtgjoerelsePassasjertillegg"),
  utgift("km_annet", "Kilometergodtgjørelse (andre kjøretøy)", "kilometergodtgjoerelseAndreFremkomstmidler"),
  utgift("km_bil_trekk", "Kilometergodtgjørelse (trekkpliktig)", "kilometergodtgjoerelseBil", { trekk: true, aga: true }),
  utgift("km_annet_trekk", "Kilometergodtgjørelse, andre kjøretøy (trekkpliktig)", "kilometergodtgjoerelseAndreFremkomstmidler", { trekk: true, aga: true }),
  utgift("reise_utlegg", "Utlegg på reise (etter regning)", null),
  // Naturalytelser (0083, naturalytelser.ts): faste per ansatt (fri bil regnes av listeprisen), og
  // de som legges til for hånd (personalrabatt og gaver over grensene).
  natural("natural_bil", "Fri bil", "bil", { manuell: false }),
  natural("natural_ek", "Elektronisk kommunikasjon", "elektroniskKommunikasjon"),
  natural("natural_forsikring", "Forsikring (skattepliktig del av premien)", "skattepliktigDelForsikringer"),
  natural("natural_rente", "Rentefordel på lån", "rentefordelLaan"),
  natural("natural_bolig", "Fri bolig", "bolig"),
  natural("natural_rabatt", "Personalrabatt (skattepliktig del)", "skattepliktigPersonalrabatt"),
  natural("natural_annet", "Annen naturalytelse (f.eks. gave over grensen)", "annet"),
];

// Beskrivelsene i a-meldingen som lønnsartene rapporteres som, med navnet den ansatte ser
// (årsoversikten og a-meldingen).
export const AMELDING_NAVN: Record<string, string> = {
  fastloenn: "Fastlønn",
  timeloenn: "Timelønn",
  overtidsgodtgjoerelse: "Overtidsgodtgjørelse",
  fastTillegg: "Faste tillegg",
  uregelmessigeTilleggKnyttetTilArbeidetTid: "Uregelmessige tillegg knyttet til arbeidet tid",
  bonus: "Bonus",
  sluttvederlag: "Sluttvederlag",
  feriepenger: "Feriepenger",
  trekkILoennForFerie: "Trekk i lønn for ferie",
  honorarAkkordProsentProvisjon: "Honorar, akkord-, prosent- eller provisjonslønn",
  styrehonorarOgGodtgjoerelseVerv: "Styrehonorar og godtgjørelse i forbindelse med verv",
  // Naturalytelser og utgiftsgodtgjørelser (0083).
  bil: "Fri bil",
  elektroniskKommunikasjon: "Elektronisk kommunikasjon",
  skattepliktigDelForsikringer: "Skattepliktig del av forsikringer",
  rentefordelLaan: "Rentefordel lån",
  bolig: "Fri bolig",
  skattepliktigPersonalrabatt: "Skattepliktig personalrabatt",
  annet: "Andre naturalytelser",
  reiseKostMedOvernattingPaaHotell: "Kost med overnatting på hotell",
  reiseKostMedOvernattingPaaHybelUtenKokEllerPensjonatEllerBrakke: "Kost med overnatting på hybel, pensjonat eller brakke",
  reiseKostMedOvernattingPaaHybelMedKokEllerPrivat: "Kost med overnatting på hybel med kokemulighet eller privat",
  reiseKostUtenOvernatting: "Kost uten overnatting",
  reiseNattillegg: "Nattillegg",
  reiseKost: "Trekkpliktig kostgodtgjørelse",
  reiseAnnet: "Annen trekkpliktig reisegodtgjørelse",
  kilometergodtgjoerelseBil: "Bilgodtgjørelse",
  kilometergodtgjoerelsePassasjertillegg: "Passasjertillegg",
  kilometergodtgjoerelseAndreFremkomstmidler: "Kilometergodtgjørelse, andre fremkomstmidler",
};

// Navnet på en linje etter beskrivelsen i a-meldingen (den trekkpliktige delen av en
// utgiftsgodtgjørelse merkes).
export const ameldingNavn = (art: Lonnsart) =>
  `${(art.amelding && AMELDING_NAVN[art.amelding]) || art.navn}${art.type === "utgift" && art.trekk ? " (trekkpliktig)" : ""}`;

const PER_KODE = new Map(LONNSARTER.map((l) => [l.kode, l]));
export const lonnsart = (kode: string): Lonnsart => PER_KODE.get(kode) ?? lonn(kode, kode);
export const LONNSART_KODER = LONNSARTER.map((l) => l.kode) as [string, ...string[]];
