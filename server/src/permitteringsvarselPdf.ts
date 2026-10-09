// Varsel om permittering som PDF (A4, som lønnsslippen): arbeidsgiveren og den ansatte, datoen
// varselet er gitt, når permitteringen begynner og hvor stor del av stillingen den gjelder, hvor
// lenge den er ventet å vare, grunnen, lønnsplikten, og at den ansatte kan søke dagpenger fra NAV
// og legge ved varselet. Eier eller administrator skriver under og gir det til den ansatte.

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFImage, type PDFPage } from "pdf-lib";
import { rensTekst } from "./pdf.js";
import { dato, orgnr } from "./regler.js";
import { farge } from "./lonnsslippPdf.js";
import type { PdfArbeidsgiver } from "./aarsoversiktPdf.js";

export interface PdfPermittering {
  navn: string;
  ansattnummer: number;
  adresse?: string | null;
  postnr?: string | null;
  poststed?: string | null;
  fra: string;
  til: string;
  slutt_ukjent: boolean;
  prosent: number; // 1–100
  varslet: string; // datoen varselet er gitt
  lonnsplikt_til: string | null;
  grunn: string;
}

const A4: [number, number] = [595.28, 841.89];
const MARG = 60;

export async function lagPermitteringsvarselPdf(p: PdfPermittering, org: PdfArbeidsgiver, logoFil?: { bytes: Uint8Array; type: "png" | "jpg" } | null): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`Varsel om permittering – ${p.navn}`);
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
  const side: PDFPage = doc.addPage(A4);
  let y = A4[1] - MARG;
  const tekst = (t: string, x: number, yy: number, o: { str?: number; f?: PDFFont; c?: ReturnType<typeof rgb> } = {}) =>
    side.drawText(rensTekst(t, o.f ?? font), { x, y: yy, size: o.str ?? 10, font: o.f ?? font, color: o.c ?? rgb(0, 0, 0) });
  // Et avsnitt brutt i linjer innenfor margene.
  const avsnitt = (t: string, o: { f?: PDFFont; str?: number } = {}) => {
    const f = o.f ?? font;
    const str = o.str ?? 10.5;
    const bredde = A4[0] - 2 * MARG;
    let linje = "";
    for (const ord of rensTekst(t, f).split(/\s+/)) {
      const ny = linje ? `${linje} ${ord}` : ord;
      if (f.widthOfTextAtSize(ny, str) > bredde && linje) {
        tekst(linje, MARG, y, { f, str });
        y -= str + 4;
        linje = ord;
      } else linje = ny;
    }
    if (linje) {
      tekst(linje, MARG, y, { f, str });
      y -= str + 4;
    }
    y -= 8;
  };

  tekst("VARSEL OM PERMITTERING", MARG, y - 18, { str: 20, f: fet, c: aksent });
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
    tekst(l, MARG, y);
    y -= 12;
  }
  let y2 = topp;
  tekst("Til", 320, y2, { f: fet, c: gra, str: 8 });
  y2 -= 13;
  for (const l of [p.navn, p.adresse ?? "", [p.postnr, p.poststed].filter(Boolean).join(" "), `Ansattnr. ${p.ansattnummer}`].filter(Boolean)) {
    tekst(l, 320, y2);
    y2 -= 12;
  }
  y = Math.min(y, y2) - 16;
  tekst(`Dato: ${dato(p.varslet)}`, MARG, y, { f: fet });
  y -= 30;

  const delvis = p.prosent < 100;
  avsnitt(
    delvis
      ? `Du blir delvis permittert, ${p.prosent} % av stillingen din, fra og med ${dato(p.fra)}.`
      : `Du blir permittert på heltid (100 % av stillingen din) fra og med ${dato(p.fra)}.`,
    { f: fet },
  );
  avsnitt(
    p.slutt_ukjent
      ? "Permitteringen varer inntil videre. Vi gir deg beskjed når du skal tilbake i arbeid."
      : `Permitteringen er ventet å vare til og med ${dato(p.til)}. Vi gir deg beskjed om den blir kortere eller lengre.`,
  );
  avsnitt(`Grunnen til permitteringen: ${p.grunn}`);
  if (p.lonnsplikt_til)
    avsnitt(
      `Vi betaler lønnen som vanlig de første dagene av permitteringen (lønnsplikten), til og med ${dato(p.lonnsplikt_til)}. Etter det får du ikke lønn fra oss for ${delvis ? "den permitterte delen av stillingen" : "tiden du er permittert"}.`,
    );
  avsnitt("Arbeidsforholdet ditt fortsetter mens du er permittert.");
  avsnitt("Du kan ha rett til dagpenger fra NAV mens du er permittert. Les mer og søk på nav.no, og legg ved dette varselet.");

  y -= 20;
  tekst("Med vennlig hilsen", MARG, y);
  y -= 50;
  side.drawLine({ start: { x: MARG, y: y + 10 }, end: { x: MARG + 220, y: y + 10 }, thickness: 0.5, color: gra });
  tekst(org.navn, MARG, y - 4, { c: gra, str: 9 });

  const bunn = [org.navn, org.orgnr ? `Org.nr. ${orgnr(org.orgnr)}` : "", org.epost ?? "", org.telefon ?? ""].filter(Boolean).join("  ·  ");
  side.drawLine({ start: { x: MARG - 4, y: 60 }, end: { x: A4[0] - MARG + 4, y: 60 }, thickness: 0.5, color: gra });
  tekst(bunn, MARG, 46, { c: gra, str: 8 });
  return doc.save();
}
