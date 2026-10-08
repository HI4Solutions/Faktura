// Lønnsslippen som PDF (A4, standardfontene som fakturaen): arbeidsgiveren og den ansatte,
// perioden, utbetalingsdatoen og kontoen, linjene (lønn, forskuddstrekk, utgifter og trekk etter
// skatt) med beløpet som utbetales, tallene hittil i år og det som er opptjent i perioden
// (feriepenger og pensjon).

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFImage, type PDFPage } from "pdf-lib";
import { rensTekst } from "./pdf.js";
import { dato, kontonr, kr, orgnr } from "./regler.js";
import { lonnsart } from "./lonnsarter.js";
import { maanedNavn } from "./lonnsberegning.js";

export interface PdfLonnsslipp {
  godkjent: boolean;
  navn: string;
  ansattnummer: number;
  periode: string;
  utbetalingsdato: string;
  kontonr: string | null;
  trekkmetode: string | null;
  trekkgrunnlag: number;
  brutto: number;
  skattetrekk: number;
  utgifter: number;
  trekk_etter_skatt: number;
  netto: number;
  feriepengegrunnlag: number;
  feriepenger_opptjent: number;
  feriepenger_prosent?: number | null;
  otp: number;
  linjer: { lonnsart: string; tekst: string; antall: number | null; sats: number | null; belop: number }[];
  hittil: { brutto: number; trekkpliktig: number; skattetrekk: number; feriepengegrunnlag: number; otp: number };
  org: {
    navn: string;
    orgnr?: string | null;
    adresse?: string | null;
    postnr?: string | null;
    poststed?: string | null;
    epost?: string | null;
    telefon?: string | null;
    farge?: string | null;
  };
  ansatt: { adresse?: string | null; postnr?: string | null; poststed?: string | null };
  logo?: { bytes: Uint8Array; type: "png" | "jpg" } | null;
}

const A4: [number, number] = [595.28, 841.89];
const MARG = 50;
const BUNN = 90;

function farge(hex: string | null | undefined) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex ?? "");
  if (!m) return rgb(0.12, 0.23, 0.45);
  return rgb(parseInt(m[1]!, 16) / 255, parseInt(m[2]!, 16) / 255, parseInt(m[3]!, 16) / 255);
}
// Tall uten unødvendige desimaler («37,5», «1»), med vanlig mellomrom og bindestrek som minus.
const tall = (n: number, maks = 2) =>
  new Intl.NumberFormat("nb-NO", { maximumFractionDigits: maks }).format(n).replace(/[\u00a0\u202f]/g, " ").replace(/\u2212/g, "-");
const antallTekst = (n: number) => tall(n, Math.abs(n) < 1 ? 4 : 2);

export async function lagLonnsslippPdf(s: PdfLonnsslipp): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const fet = await doc.embedFont(StandardFonts.HelveticaBold);
  const aksent = farge(s.org.farge);
  const gra = rgb(0.4, 0.4, 0.4);
  let logo: PDFImage | undefined;
  if (s.logo) {
    try {
      logo = s.logo.type === "png" ? await doc.embedPng(s.logo.bytes) : await doc.embedJpg(s.logo.bytes);
    } catch {
      logo = undefined;
    }
  }

  const sider: PDFPage[] = [];
  let side!: PDFPage;
  let y = 0;
  const tekst = (t: string, x: number, yy: number, o: { str?: number; f?: PDFFont; c?: ReturnType<typeof rgb> } = {}) =>
    side.drawText(rensTekst(t, o.f ?? font), { x, y: yy, size: o.str ?? 9, font: o.f ?? font, color: o.c ?? rgb(0, 0, 0) });
  const hoyre = (t: string, xh: number, yy: number, o: { str?: number; f?: PDFFont; c?: ReturnType<typeof rgb> } = {}) => {
    const w = (o.f ?? font).widthOfTextAtSize(rensTekst(t, o.f ?? font), o.str ?? 9);
    tekst(t, xh - w, yy, o);
  };
  // Kutter en tekst som ikke får plass i bredden.
  const kutt = (t: string, bredde: number, f: PDFFont = font, str = 9) => {
    let x = rensTekst(t, f);
    if (f.widthOfTextAtSize(x, str) <= bredde) return x;
    while (x.length > 1 && f.widthOfTextAtSize(`${x}...`, str) > bredde) x = x.slice(0, -1);
    return `${x.trimEnd()}...`;
  };

  const tittel = s.godkjent ? "LØNNSSLIPP" : "LØNNSSLIPP – UTKAST";
  const kol = { tekst: MARG, antall: 360, sats: 440, belop: A4[0] - MARG };
  const linjeHode = () => {
    side.drawRectangle({ x: MARG - 4, y: y - 4, width: A4[0] - 2 * MARG + 8, height: 16, color: rgb(0.95, 0.95, 0.95) });
    tekst("Beskrivelse", kol.tekst, y, { f: fet });
    hoyre("Antall", kol.antall, y, { f: fet });
    hoyre("Sats", kol.sats, y, { f: fet });
    hoyre("Beløp", kol.belop, y, { f: fet });
    y -= 20;
  };
  const nySide = (forste: boolean) => {
    side = doc.addPage(A4);
    sider.push(side);
    y = A4[1] - MARG;
    if (!forste) {
      tekst(`${tittel} ${maanedNavn(s.periode)} – ${s.navn} (fortsatt)`, MARG, y, { str: 11, f: fet, c: aksent });
      y -= 30;
      linjeHode();
    }
  };
  nySide(true);

  tekst(tittel, MARG, y - 18, { str: 22, f: fet, c: aksent });
  if (logo) {
    const k = Math.min(150 / logo.width, 50 / logo.height);
    side.drawImage(logo, { x: A4[0] - MARG - logo.width * k, y: y - logo.height * k, width: logo.width * k, height: logo.height * k });
  }
  y -= 60;

  // Arbeidsgiveren og den ansatte.
  const topp = y;
  tekst("Arbeidsgiver", MARG, y, { f: fet, c: gra, str: 8 });
  y -= 13;
  for (const l of [s.org.navn, s.org.adresse ?? "", [s.org.postnr, s.org.poststed].filter(Boolean).join(" "), s.org.orgnr ? `Org.nr. ${orgnr(s.org.orgnr)}` : ""].filter(Boolean)) {
    tekst(kutt(l, 230), MARG, y);
    y -= 12;
  }
  let y2 = topp;
  tekst("Ansatt", 300, y2, { f: fet, c: gra, str: 8 });
  y2 -= 13;
  for (const l of [s.navn, s.ansatt.adresse ?? "", [s.ansatt.postnr, s.ansatt.poststed].filter(Boolean).join(" ")].filter(Boolean)) {
    tekst(kutt(l, 245), 300, y2);
    y2 -= 12;
  }
  y = Math.min(y, y2) - 18;

  // Fakta.
  const fakta: [string, string][] = [
    ["Periode", maanedNavn(s.periode)],
    [s.godkjent ? "Utbetalt" : "Utbetales", dato(s.utbetalingsdato)],
    ["Ansattnr.", String(s.ansattnummer)],
    ["Kontonr.", s.kontonr ? kontonr(s.kontonr) : "mangler"],
  ];
  for (let i = 0; i < fakta.length; i += 2) {
    for (let j = 0; j < 2 && i + j < fakta.length; j++) {
      const [n, v] = fakta[i + j]!;
      const x = j === 0 ? MARG : 300;
      tekst(n, x, y, { c: gra });
      tekst(v, x + 70, y);
    }
    y -= 13;
  }
  if (s.trekkmetode) {
    tekst("Skattetrekk", MARG, y, { c: gra });
    tekst(kutt(s.trekkmetode, A4[0] - 2 * MARG - 70), MARG + 70, y);
    y -= 13;
  }
  y -= 15;

  // Linjene: lønnen, forskuddstrekket, utgiftene og trekkene etter skatt.
  linjeHode();
  const rad = (l: { tekst: string; antall?: string; sats?: string; belop: number }, uthev = false) => {
    if (y - 13 < BUNN) nySide(false);
    tekst(kutt(l.tekst, kol.antall - kol.tekst - 55, uthev ? fet : font), kol.tekst, y, { f: uthev ? fet : font });
    if (l.antall) hoyre(l.antall, kol.antall, y);
    if (l.sats) hoyre(l.sats, kol.sats, y);
    hoyre(kr(l.belop), kol.belop, y, { f: uthev ? fet : font });
    y -= 13;
  };
  const strek = () => {
    y -= 3;
    side.drawLine({ start: { x: MARG - 4, y: y + 10 }, end: { x: A4[0] - MARG + 4, y: y + 10 }, thickness: 0.5, color: gra });
    y -= 2;
  };
  const prosentArt = (art: string) => art === "feriepenger" || art === "feriepenger_60";
  const linjeRad = (l: PdfLonnsslipp["linjer"][number]) =>
    rad({
      tekst: l.tekst,
      antall: l.antall != null ? (prosentArt(l.lonnsart) ? kr(Number(l.antall)) : antallTekst(Number(l.antall))) : undefined,
      sats: l.sats != null ? (prosentArt(l.lonnsart) ? `${tall(Number(l.sats))} %` : kr(Number(l.sats))) : undefined,
      belop: Number(l.belop),
    });
  const lonn = s.linjer.filter((l) => lonnsart(l.lonnsart).type === "lonn");
  const utgifter = s.linjer.filter((l) => lonnsart(l.lonnsart).type === "utgift");
  const trekk = s.linjer.filter((l) => lonnsart(l.lonnsart).type === "trekk");
  for (const l of lonn) linjeRad(l);
  strek();
  rad({ tekst: "Bruttolønn", belop: s.brutto }, true);
  y -= 4;
  rad({ tekst: s.trekkgrunnlag && s.skattetrekk ? `Forskuddstrekk (grunnlag ${kr(s.trekkgrunnlag)})` : "Forskuddstrekk", belop: -s.skattetrekk });
  for (const l of utgifter) linjeRad(l);
  for (const l of trekk) linjeRad(l);
  if (y - 40 < BUNN) nySide(false);
  strek();
  y -= 4;
  tekst("Utbetales (NOK)", 330, y, { f: fet, str: 11 });
  hoyre(kr(s.netto), kol.belop, y, { f: fet, str: 11 });
  y -= 14;
  if (s.kontonr) {
    hoyre(`til konto ${kontonr(s.kontonr)}`, kol.belop, y, { c: gra, str: 8 });
    y -= 12;
  }
  y -= 16;

  // Hittil i år og opptjent i perioden, i to bokser.
  const boks = (x: number, tittelTekst: string, rader: [string, string][]) => {
    const h = 22 + rader.length * 13;
    side.drawRectangle({ x, y: y - h + 12, width: 235, height: h, borderColor: aksent, borderWidth: 0.8 });
    tekst(tittelTekst, x + 10, y, { f: fet, c: aksent });
    rader.forEach(([n, v], i) => {
      tekst(n, x + 10, y - 16 - i * 13, { c: gra });
      hoyre(v, x + 225, y - 16 - i * 13);
    });
    return h;
  };
  const aar = s.utbetalingsdato.slice(0, 4);
  const hoydeBoks = 22 + 5 * 13 + 10;
  if (y - hoydeBoks < BUNN) nySide(false);
  const opptjent: [string, string][] = [
    ["Feriepengegrunnlag", kr(s.feriepengegrunnlag)],
    [`Opptjente feriepenger${s.feriepenger_prosent ? ` (${tall(s.feriepenger_prosent)} %)` : ""}`, kr(s.feriepenger_opptjent)],
  ];
  if (s.otp) opptjent.push(["Pensjon (OTP) fra arbeidsgiver", kr(s.otp)]);
  const h1 = boks(MARG, `Hittil i ${aar}`, [
    ["Bruttolønn", kr(s.hittil.brutto)],
    ["Trekkpliktig lønn", kr(s.hittil.trekkpliktig)],
    ["Forskuddstrekk", kr(s.hittil.skattetrekk)],
    ["Feriepengegrunnlag", kr(s.hittil.feriepengegrunnlag)],
  ]);
  const h2 = boks(MARG + 260, "Opptjent denne måneden", opptjent);
  y -= Math.max(h1, h2) + 8;
  if (!s.godkjent) {
    tekst("Utkast: lønnskjøringen er ikke godkjent, og tallene kan endres.", MARG, y, { c: gra, str: 8 });
    y -= 12;
  }

  // Bunnlinje og sidetall.
  const bunn = [s.org.navn, s.org.orgnr ? `Org.nr. ${orgnr(s.org.orgnr)}` : "", s.org.epost ?? "", s.org.telefon ?? ""].filter(Boolean).join("  ·  ");
  sider.forEach((p, i) => {
    side = p;
    side.drawLine({ start: { x: MARG, y: 50 }, end: { x: A4[0] - MARG, y: 50 }, thickness: 0.5, color: gra });
    tekst(kutt(bunn, A4[0] - 2 * MARG - 70, font, 8), MARG, 36, { str: 8, c: gra });
    if (sider.length > 1) hoyre(`Side ${i + 1} av ${sider.length}`, A4[0] - MARG, 36, { str: 8 });
  });

  doc.setTitle(`Lønnsslipp ${maanedNavn(s.periode)} – ${s.navn}`);
  doc.setAuthor(s.org.navn);
  doc.setCreator("HI4 Faktura");
  return doc.save({ useObjectStreams: false });
}
