// Årsoversikten (sammenstillingsoppgaven) som PDF (A4, som lønnsslippen): arbeidsgiveren og den
// ansatte, lønnen i året gruppert som i a-meldingen, forskuddstrekket, utgiftene og trekkene
// etter skatt med det som er utbetalt, feriepengegrunnlaget og pensjonen, tallene fra et
// tidligere lønnssystem og hver utbetaling. Flere ansatte i én fil (lederen laster ned alle):
// hver ansatt begynner på en ny side, og sidetallene gjelder hver ansatt.

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFImage, type PDFPage } from "pdf-lib";
import { rensTekst } from "./pdf.js";
import { dato, kr, orgnr } from "./regler.js";
import { maanedNavn } from "./lonnsberegning.js";
import { farge } from "./lonnsslippPdf.js";
import type { Aarsoversikt } from "./lonnAarsoversikt.js";

export interface PdfAarsoversikt extends Aarsoversikt {
  ansatt: { adresse?: string | null; postnr?: string | null; poststed?: string | null; fodselsdato?: string | null };
}
export interface PdfArbeidsgiver {
  navn: string;
  orgnr?: string | null;
  adresse?: string | null;
  postnr?: string | null;
  poststed?: string | null;
  epost?: string | null;
  telefon?: string | null;
  farge?: string | null;
}

const A4: [number, number] = [595.28, 841.89];
const MARG = 50;
const BUNN = 90;

export async function lagAarsoversiktPdf(
  oversikter: PdfAarsoversikt[],
  org: PdfArbeidsgiver,
  logoFil?: { bytes: Uint8Array; type: "png" | "jpg" } | null,
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const fet = await doc.embedFont(StandardFonts.HelveticaBold);
  const aksent = farge(org.farge);
  const gra = rgb(0.4, 0.4, 0.4);
  let logo: PDFImage | undefined;
  if (logoFil) {
    try {
      logo = logoFil.type === "png" ? await doc.embedPng(logoFil.bytes) : await doc.embedJpg(logoFil.bytes);
    } catch {
      logo = undefined;
    }
  }

  let side!: PDFPage;
  let y = 0;
  const tekst = (t: string, x: number, yy: number, o: { str?: number; f?: PDFFont; c?: ReturnType<typeof rgb> } = {}) =>
    side.drawText(rensTekst(t, o.f ?? font), { x, y: yy, size: o.str ?? 9, font: o.f ?? font, color: o.c ?? rgb(0, 0, 0) });
  const hoyre = (t: string, xh: number, yy: number, o: { str?: number; f?: PDFFont; c?: ReturnType<typeof rgb> } = {}) => {
    const w = (o.f ?? font).widthOfTextAtSize(rensTekst(t, o.f ?? font), o.str ?? 9);
    tekst(t, xh - w, yy, o);
  };
  const kutt = (t: string, bredde: number, f: PDFFont = font, str = 9) => {
    let x = rensTekst(t, f);
    if (f.widthOfTextAtSize(x, str) <= bredde) return x;
    while (x.length > 1 && f.widthOfTextAtSize(`${x}...`, str) > bredde) x = x.slice(0, -1);
    return `${x.trimEnd()}...`;
  };
  const strek = () => {
    y -= 3;
    side.drawLine({ start: { x: MARG - 4, y: y + 10 }, end: { x: A4[0] - MARG + 4, y: y + 10 }, thickness: 0.5, color: gra });
    y -= 2;
  };
  const bunn = [org.navn, org.orgnr ? `Org.nr. ${orgnr(org.orgnr)}` : "", org.epost ?? "", org.telefon ?? ""].filter(Boolean).join("  ·  ");

  for (const a of oversikter) {
    const sider: PDFPage[] = [];
    const hode = (t: string) => {
      side.drawRectangle({ x: MARG - 4, y: y - 4, width: A4[0] - 2 * MARG + 8, height: 16, color: rgb(0.95, 0.95, 0.95) });
      tekst(t, MARG, y, { f: fet });
      hoyre("Beløp", A4[0] - MARG, y, { f: fet });
      y -= 20;
    };
    const nySide = (forste: boolean) => {
      side = doc.addPage(A4);
      sider.push(side);
      y = A4[1] - MARG;
      if (!forste) {
        tekst(`ÅRSOVERSIKT ${a.aar} – ${a.navn} (fortsatt)`, MARG, y, { str: 11, f: fet, c: aksent });
        y -= 30;
      }
    };
    const plass = (h: number) => {
      if (y - h < BUNN) nySide(false);
    };
    const rad = (t: string, belop: number, uthev = false) => {
      plass(13);
      tekst(kutt(t, 380, uthev ? fet : font), MARG, y, { f: uthev ? fet : font });
      hoyre(kr(belop), A4[0] - MARG, y, { f: uthev ? fet : font });
      y -= 13;
    };

    nySide(true);
    tekst(`ÅRSOVERSIKT ${a.aar}`, MARG, y - 18, { str: 22, f: fet, c: aksent });
    tekst("Sammenstillingsoppgave: lønn og trekk i året", MARG, y - 34, { c: gra });
    if (logo) {
      const k = Math.min(150 / logo.width, 50 / logo.height);
      side.drawImage(logo, { x: A4[0] - MARG - logo.width * k, y: y - logo.height * k, width: logo.width * k, height: logo.height * k });
    }
    y -= 64;

    // Arbeidsgiveren og den ansatte.
    const topp = y;
    tekst("Arbeidsgiver", MARG, y, { f: fet, c: gra, str: 8 });
    y -= 13;
    for (const l of [org.navn, org.adresse ?? "", [org.postnr, org.poststed].filter(Boolean).join(" "), org.orgnr ? `Org.nr. ${orgnr(org.orgnr)}` : ""].filter(Boolean)) {
      tekst(kutt(l, 230), MARG, y);
      y -= 12;
    }
    let y2 = topp;
    tekst("Ansatt", 300, y2, { f: fet, c: gra, str: 8 });
    y2 -= 13;
    for (const l of [
      a.navn,
      a.ansatt.adresse ?? "",
      [a.ansatt.postnr, a.ansatt.poststed].filter(Boolean).join(" "),
      a.ansatt.fodselsdato ? `Født ${dato(a.ansatt.fodselsdato)}` : "",
      `Ansattnr. ${a.ansattnummer}`,
    ].filter(Boolean)) {
      tekst(kutt(l, 245), 300, y2);
      y2 -= 12;
    }
    y = Math.min(y, y2) - 18;

    // Lønnen gruppert som i a-meldingen, og forskuddstrekket.
    hode("Lønn og godtgjørelser (som i a-meldingen)");
    for (const l of a.inntekter) rad(l.navn, l.belop);
    strek();
    rad("Bruttolønn", a.sum.brutto, true);
    rad("Herav trekkpliktig", a.sum.trekkpliktig);
    y -= 4;
    rad("Forskuddstrekk", -a.sum.skattetrekk, true);
    y -= 10;

    // Utgifter og trekk etter skatt, og det som er utbetalt.
    if (a.utgifter.length || a.trekk.length) {
      plass(40);
      hode("Utbetalt i tillegg og trukket etter skatt");
      for (const l of a.utgifter) rad(l.navn, l.belop);
      for (const l of a.trekk) rad(l.navn, l.belop);
      y -= 6;
    }
    plass(30);
    strek();
    y -= 4;
    tekst("Utbetalt i året (NOK)", 330, y, { f: fet, str: 11 });
    hoyre(kr(a.sum.netto), A4[0] - MARG, y, { f: fet, str: 11 });
    y -= 26;

    // Feriepenger og pensjon, og tallene fra et tidligere lønnssystem, i bokser.
    const boks = (x: number, tittel: string, rader: [string, string][]) => {
      const h = 22 + rader.length * 13;
      side.drawRectangle({ x, y: y - h + 12, width: 235, height: h, borderColor: aksent, borderWidth: 0.8 });
      tekst(tittel, x + 10, y, { f: fet, c: aksent });
      rader.forEach(([n, v], i) => {
        tekst(n, x + 10, y - 16 - i * 13, { c: gra });
        hoyre(v, x + 225, y - 16 - i * 13);
      });
      return h;
    };
    plass(22 + 4 * 13 + 10);
    const ferie: [string, string][] = [
      ["Feriepengegrunnlag", kr(a.sum.feriepengegrunnlag)],
      [`Feriepenger til utbetaling i ${a.aar + 1}`, kr(a.sum.feriepenger_opptjent)],
    ];
    if (a.sum.otp) ferie.push(["Pensjon (OTP) fra arbeidsgiver", kr(a.sum.otp)]);
    const h1 = boks(MARG, "Opptjent i året", ferie);
    let h2 = 0;
    if (a.tidligere)
      h2 = boks(MARG + 260, "Fra tidligere lønnssystem", [
        ["Trekkpliktig lønn", kr(a.tidligere.trekkpliktig)],
        ["Forskuddstrekk", kr(a.tidligere.forskuddstrekk)],
        ["Feriepengegrunnlag", kr(a.tidligere.feriepengegrunnlag)],
      ]);
    y -= Math.max(h1, h2) + 14;

    // Hver utbetaling.
    if (a.maaneder.length) {
      plass(60);
      const kol = { periode: MARG, utbetalt: 230, brutto: 350, trekk: 440, netto: A4[0] - MARG };
      const linjeHode = () => {
        side.drawRectangle({ x: MARG - 4, y: y - 4, width: A4[0] - 2 * MARG + 8, height: 16, color: rgb(0.95, 0.95, 0.95) });
        tekst("Lønn for", kol.periode, y, { f: fet });
        tekst("Utbetalt", kol.utbetalt, y, { f: fet });
        hoyre("Brutto", kol.brutto, y, { f: fet });
        hoyre("Forskuddstrekk", kol.trekk, y, { f: fet });
        hoyre("Netto", kol.netto, y, { f: fet });
        y -= 20;
      };
      linjeHode();
      for (const m of a.maaneder) {
        if (y - 13 < BUNN) {
          nySide(false);
          linjeHode();
        }
        tekst(maanedNavn(m.periode), kol.periode, y);
        tekst(dato(m.utbetalingsdato), kol.utbetalt, y);
        hoyre(kr(m.brutto), kol.brutto, y);
        hoyre(kr(-m.skattetrekk), kol.trekk, y);
        hoyre(kr(m.netto), kol.netto, y);
        y -= 13;
      }
      y -= 12;
    }

    // Merknaden får plass helt ned mot bunnlinjen.
    if (y - 22 < 60) nySide(false);
    for (const l of [
      "Lønnen og trekket skal være rapportert til Skatteetaten i a-meldingen, og står i skattemeldingen din.",
      "Kontroller tallene, og si fra til arbeidsgiveren hvis noe ikke stemmer.",
    ]) {
      tekst(l, MARG, y, { c: gra, str: 8 });
      y -= 11;
    }

    // Bunnlinje og sidetall (for hver ansatt).
    sider.forEach((p, i) => {
      side = p;
      side.drawLine({ start: { x: MARG, y: 50 }, end: { x: A4[0] - MARG, y: 50 }, thickness: 0.5, color: gra });
      tekst(kutt(bunn, A4[0] - 2 * MARG - 70, font, 8), MARG, 36, { str: 8, c: gra });
      if (sider.length > 1) hoyre(`Side ${i + 1} av ${sider.length}`, A4[0] - MARG, 36, { str: 8 });
    });
  }

  const en = oversikter.length === 1 ? oversikter[0] : null;
  doc.setTitle(en ? `Årsoversikt ${en.aar} – ${en.navn}` : `Årsoversikter ${oversikter[0]?.aar ?? ""}`.trim());
  doc.setAuthor(org.navn);
  doc.setCreator("HI4 Faktura");
  return doc.save({ useObjectStreams: false });
}
