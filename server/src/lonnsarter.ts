// Lønnsartene i lønnskjøringen (0065_lonn.sql): hva hver linje er, og om den er trekkpliktig
// (forskuddstrekk), avgiftspliktig (arbeidsgiveravgift), med i feriepengegrunnlaget og i
// grunnlaget for OTP. type: lønn (bruttolønnen), utgift (godtgjørelse som ikke er
// skattepliktig, utbetales i tillegg) eller trekk (trekkes etter skatt). fortegn: vanlig fortegn
// på beløpet (trekk er negative). manuell: kan velges når en linje legges til.
// amelding: beskrivelsen i a-meldingen (steg 4). fradrag: trekket reduserer grunnlaget for
// forskuddstrekket (fagforeningskontingent, 0082).
//
// Feriepenger er trekkpliktige, men ved tabelltrekk trekkes det ikke skatt av feriepenger som
// utbetales i ferieåret (opptjent året før); tillegget for den ekstra ferieuka over 60 år trekkes
// alltid (etter prosentsatsen). OTP-grunnlaget er den faste og den vanlige lønnen (ikke overtid,
// bonus og feriepenger, og ferietrekket gjør det ikke mindre).

export type Lonnsart = {
  kode: string;
  navn: string;
  type: "lonn" | "utgift" | "trekk";
  trekk: boolean;
  aga: boolean;
  ferie: boolean;
  otp: boolean;
  fortegn: 1 | -1;
  manuell: boolean;
  amelding: string | null;
  fradrag?: boolean;
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
  lonn("feriepenger_60", "Feriepenger for den ekstra ferieuka (over 60 år)", { ferie: false, otp: false, amelding: "feriepenger" }),
  lonn("ferietrekk", "Trekk i lønn for ferie", { ferie: false, otp: false, fortegn: -1, amelding: "trekkILoennForFerie" }),
  lonn("trekk_permisjon", "Trekk for permisjon uten lønn", { fortegn: -1, amelding: "fastloenn" }),
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
  feriepenger: "Feriepenger",
  trekkILoennForFerie: "Trekk i lønn for ferie",
};

const PER_KODE = new Map(LONNSARTER.map((l) => [l.kode, l]));
export const lonnsart = (kode: string): Lonnsart => PER_KODE.get(kode) ?? lonn(kode, kode);
export const LONNSART_KODER = LONNSARTER.map((l) => l.kode) as [string, ...string[]];
