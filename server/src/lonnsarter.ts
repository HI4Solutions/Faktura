// Lønnsartene i lønnskjøringen (0065_lonn.sql): hva hver linje er, og om den er trekkpliktig
// (forskuddstrekk), avgiftspliktig (arbeidsgiveravgift), med i feriepengegrunnlaget og i
// grunnlaget for OTP. type: lønn (bruttolønnen), utgift (godtgjørelse som ikke er
// skattepliktig, utbetales i tillegg) eller trekk (trekkes etter skatt). fortegn: vanlig fortegn
// på beløpet (trekk er negative). manuell: kan velges når en linje legges til.
// amelding: beskrivelsen i a-meldingen (steg 4).
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
  lonn("sykepenger", "Sykepenger i arbeidsgiverperioden", { amelding: "timeloenn" }),
  lonn("omsorgspenger", "Omsorgspenger (sykt barn)", { amelding: "timeloenn" }),
  lonn("feriepenger", "Feriepenger", { ferie: false, otp: false, amelding: "feriepenger" }),
  lonn("feriepenger_60", "Feriepenger for den ekstra ferieuka (over 60 år)", { ferie: false, otp: false, amelding: "feriepenger" }),
  lonn("ferietrekk", "Trekk i lønn for ferie", { ferie: false, otp: false, fortegn: -1, amelding: "trekkILoennForFerie" }),
  lonn("trekk_permisjon", "Trekk for permisjon uten lønn", { fortegn: -1, amelding: "fastloenn" }),
  { kode: "utgift", navn: "Utgiftsgodtgjørelse (ikke skattepliktig)", type: "utgift", trekk: false, aga: false, ferie: false, otp: false, fortegn: 1, manuell: true, amelding: null },
  { kode: "trekk_etter_skatt", navn: "Trekk etter skatt", type: "trekk", trekk: false, aga: false, ferie: false, otp: false, fortegn: -1, manuell: true, amelding: null },
];

const PER_KODE = new Map(LONNSARTER.map((l) => [l.kode, l]));
export const lonnsart = (kode: string): Lonnsart => PER_KODE.get(kode) ?? lonn(kode, kode);
export const LONNSART_KODER = LONNSARTER.map((l) => l.kode) as [string, ...string[]];
