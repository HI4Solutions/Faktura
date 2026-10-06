import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage, type PDFImage } from "pdf-lib";
import { dato, kontonr, kr, linjebelop, linjerabatt, orgnr, summer, type Linje } from "./regler.js";

// Data som trengs for å tegne en faktura. For utstedte fakturaer kommer selger og
// kunde fra kopiene på fakturaen; for utkast fra organisasjonen og kunden nå.
export interface PdfFaktura {
  type: "faktura" | "kreditnota";
  utkast: boolean;
  fakturanummer: number | null;
  kreditnota_for_nummer?: number | null;
  fakturadato: string | null;
  forfallsdato: string | null;
  periode_fra?: string | null;
  periode_til?: string | null;
  kid?: string | null;
  deres_referanse?: string | null;
  var_referanse?: string | null;
  selger: {
    navn: string;
    orgnr?: string | null;
    mva_registrert?: boolean;
    foretaksregisteret?: boolean;
    adresse?: string | null;
    postnr?: string | null;
    poststed?: string | null;
    telefon?: string | null;
    epost?: string | null;
    kontonr?: string | null;
    farge?: string | null;
  };
  kunde: {
    kundenummer?: number | null;
    type?: string;
    navn: string;
    orgnr?: string | null;
    adresse?: string | null;
    postnr?: string | null;
    poststed?: string | null;
  };
  linjer: Linje[];
  kommentar?: string | null; // notat til kunden
  vedlegg?: string[]; // filnavnene på vedleggene
  logo?: { bytes: Uint8Array; type: "png" | "jpg" } | null;
}

const A4: [number, number] = [595.28, 841.89];
const MARG = 50;
const BUNN = 90;

function farge(hex: string | null | undefined) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex ?? "");
  if (!m) return rgb(0.12, 0.23, 0.45);
  return rgb(parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255);
}

// Standardfontene har bare Windows-1252-tegn. Andre tegn byttes ut eller tas bort, så en
// emoji eller en pil i en tekst ikke stopper PDF-en.
const ERSTATT: Record<string, string> = { "→": "->", "←": "<-", "⇒": "=>", "≥": ">=", "≤": "<=", "≠": "!=", "−": "-", "✓": "v", "✔": "v", "\u202f": " ", "\u2009": " " };
const tegnsett = new WeakMap<PDFFont, Set<number>>();
export function rensTekst(tekst: string, font: PDFFont): string {
  let lov = tegnsett.get(font);
  if (!lov) tegnsett.set(font, (lov = new Set(font.getCharacterSet())));
  let ut = "";
  for (const c of tekst) {
    if (c === "\n" || lov.has(c.codePointAt(0)!)) ut += c;
    else if (ERSTATT[c]) ut += ERSTATT[c];
    else {
      // Bokstaver med aksenter uten egen kode (ł, ő …): bruk bokstaven uten aksent.
      const enkel = c.normalize("NFD").replace(/\p{M}/gu, "");
      if (enkel && [...enkel].every((x) => lov!.has(x.codePointAt(0)!))) ut += enkel;
      else if (!/\p{Extended_Pictographic}|\p{M}|\p{Cf}/u.test(c)) ut += "?";
    }
  }
  return ut;
}

// Bryter tekst så den får plass i en gitt bredde.
function bryt(tekst: string, font: PDFFont, storrelse: number, bredde: number): string[] {
  tekst = rensTekst(tekst, font);
  const linjer: string[] = [];
  for (const avsnitt of tekst.split("\n")) {
    let linje = "";
    for (const ord of avsnitt.split(/\s+/)) {
      const forsok = linje ? `${linje} ${ord}` : ord;
      if (font.widthOfTextAtSize(forsok, storrelse) <= bredde || !linje) linje = forsok;
      else {
        linjer.push(linje);
        linje = ord;
      }
    }
    linjer.push(linje);
  }
  return linjer;
}

export async function lagPdf(f: PdfFaktura): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const fet = await doc.embedFont(StandardFonts.HelveticaBold);
  const aksent = farge(f.selger.farge);
  const gra = rgb(0.4, 0.4, 0.4);
  const kreditnota = f.type === "kreditnota";

  let logo: PDFImage | undefined;
  if (f.logo) {
    try {
      logo = f.logo.type === "png" ? await doc.embedPng(f.logo.bytes) : await doc.embedJpg(f.logo.bytes);
    } catch {
      logo = undefined; // Et ugyldig bilde gir en PDF uten logo, ikke en feil.
    }
  }

  const tittel = f.utkast ? (kreditnota ? "KREDITNOTAUTKAST" : "FAKTURAUTKAST") : kreditnota ? "KREDITNOTA" : "FAKTURA";
  const nummer = f.fakturanummer ? String(f.fakturanummer) : "tildeles ved sending";

  const sider: PDFPage[] = [];
  let side!: PDFPage;
  let y = 0;

  const tekst = (t: string, x: number, yy: number, opts: { str?: number; f?: PDFFont; c?: ReturnType<typeof rgb> } = {}) =>
    side.drawText(rensTekst(t, opts.f ?? font), { x, y: yy, size: opts.str ?? 9, font: opts.f ?? font, color: opts.c ?? rgb(0, 0, 0) });
  const hoyre = (t: string, xh: number, yy: number, opts: { str?: number; f?: PDFFont } = {}) => {
    const w = (opts.f ?? font).widthOfTextAtSize(rensTekst(t, opts.f ?? font), opts.str ?? 9);
    tekst(t, xh - w, yy, opts);
  };

  // Tallkolonnene står etter høyre kant. Med rabatt på en linje får rabatten egen
  // kolonne, og beskrivelsen blir smalere.
  const harRabatt = f.linjer.some((l) => l.rabatt_prosent != null || l.rabatt_belop != null);
  const kol = harRabatt
    ? { beskr: MARG, antall: 315, pris: 380, rabatt: 435, mva: 480, belop: A4[0] - MARG }
    : { beskr: MARG, antall: 360, pris: 440, rabatt: 0, mva: 480, belop: A4[0] - MARG };
  // Selgere uten mva får ingen mva-kolonne (med mindre en linje faktisk har mva, f.eks. på en kreditnota).
  const visMva = f.selger.mva_registrert !== false || f.linjer.some((l) => l.mva_sats !== 0);

  const linjeHode = () => {
    side.drawRectangle({ x: MARG - 4, y: y - 4, width: A4[0] - 2 * MARG + 8, height: 16, color: rgb(0.95, 0.95, 0.95) });
    tekst("Beskrivelse", kol.beskr, y, { f: fet });
    hoyre("Antall", kol.antall, y, { f: fet });
    hoyre("Pris", kol.pris, y, { f: fet });
    if (harRabatt) hoyre("Rabatt", kol.rabatt, y, { f: fet });
    if (visMva) hoyre("Mva", kol.mva, y, { f: fet });
    hoyre("Beløp", kol.belop, y, { f: fet });
    y -= 20;
  };

  const nySide = (forste: boolean) => {
    side = doc.addPage(A4);
    sider.push(side);
    y = A4[1] - MARG;
    if (!forste) {
      tekst(`${tittel} ${nummer} (fortsatt)`, MARG, y, { str: 11, f: fet, c: aksent });
      y -= 30;
      linjeHode();
    }
  };

  nySide(true);

  // Topp: tittel til venstre, logo til høyre.
  tekst(tittel, MARG, y - 18, { str: 22, f: fet, c: aksent });
  if (logo) {
    const s = Math.min(150 / logo.width, 50 / logo.height);
    side.drawImage(logo, { x: A4[0] - MARG - logo.width * s, y: y - logo.height * s, width: logo.width * s, height: logo.height * s });
  }
  y -= 60;

  // Avsender og kunde.
  const topp = y;
  const s = f.selger;
  const selgerLinjer = [
    s.navn,
    s.adresse ?? "",
    [s.postnr, s.poststed].filter(Boolean).join(" "),
    s.orgnr ? `Org.nr. ${orgnr(s.orgnr)}${s.mva_registrert ? " MVA" : ""}` : "",
    s.foretaksregisteret ? "Foretaksregisteret" : "",
  ].filter(Boolean);
  tekst("Fra", MARG, y, { f: fet, c: gra, str: 8 });
  y -= 13;
  for (const l of selgerLinjer) {
    tekst(l, MARG, y);
    y -= 12;
  }
  let y2 = topp;
  const k = f.kunde;
  tekst("Til", 300, y2, { f: fet, c: gra, str: 8 });
  y2 -= 13;
  for (const l of [k.navn, k.orgnr ? `Org.nr. ${orgnr(k.orgnr)}` : "", k.adresse ?? "", [k.postnr, k.poststed].filter(Boolean).join(" ")].filter(Boolean)) {
    tekst(l, 300, y2);
    y2 -= 12;
  }
  y = Math.min(y, y2) - 18;

  // Fakta.
  const fakta: [string, string][] = [
    [kreditnota ? "Kreditnotanr." : "Fakturanr.", nummer],
    [kreditnota ? "Dato" : "Fakturadato", dato(f.fakturadato) || "ved sending"],
  ];
  if (!kreditnota) fakta.push(["Forfallsdato", dato(f.forfallsdato) || "ved sending"]);
  if (k.kundenummer) fakta.push(["Kundenr.", String(k.kundenummer)]);
  if (f.kid) fakta.push(["KID", f.kid]);
  if (f.periode_fra && f.periode_til) fakta.push(["Periode", `${dato(f.periode_fra)} – ${dato(f.periode_til)}`]);
  if (f.deres_referanse) fakta.push(["Deres ref.", f.deres_referanse]);
  if (f.var_referanse) fakta.push(["Vår ref.", f.var_referanse]);
  if (kreditnota && f.kreditnota_for_nummer) fakta.push(["Krediterer", `faktura ${f.kreditnota_for_nummer}`]);
  for (let i = 0; i < fakta.length; i += 2) {
    for (let j = 0; j < 2 && i + j < fakta.length; j++) {
      const [n, v] = fakta[i + j];
      const x = j === 0 ? MARG : 300;
      tekst(n, x, y, { c: gra });
      tekst(v, x + 85, y);
    }
    y -= 13;
  }
  y -= 15;

  // Notat til kunden, med en strek i aksentfargen foran.
  const kommentar = f.kommentar?.trim() ? bryt(f.kommentar.trim(), font, 9, A4[0] - 2 * MARG - 12) : [];
  if (kommentar.length) {
    const h = kommentar.length * 11;
    side.drawRectangle({ x: MARG, y: y - h + 8, width: 2, height: h, color: aksent });
    kommentar.forEach((t, i) => tekst(t, MARG + 10, y - i * 11));
    y -= h + 14;
  }
  // Vedleggene som følger med fakturaen.
  if (f.vedlegg?.length) {
    const linjer = bryt(f.vedlegg.join(", "), font, 9, A4[0] - 2 * MARG - 50);
    tekst("Vedlegg", MARG, y, { c: gra });
    linjer.forEach((t, i) => tekst(t, MARG + 50, y - i * 11));
    y -= linjer.length * 11 + 14;
  }

  // Linjer, med ny side når det ikke er plass.
  linjeHode();
  for (const l of f.linjer) {
    const beskr = bryt(l.beskrivelse, font, 9, kol.antall - kol.beskr - 50);
    const hoyde = beskr.length * 11 + 4;
    if (y - hoyde < BUNN) nySide(false);
    const b = linjebelop(l);
    beskr.forEach((t, i) => tekst(t, kol.beskr, y - i * 11));
    const antall = Number.isInteger(l.antall) ? String(l.antall) : kr(l.antall);
    hoyre(`${antall}${l.enhet && l.enhet !== "stk" ? " " + l.enhet : ""}`, kol.antall, y);
    hoyre(kr(l.enhetspris), kol.pris, y);
    if (l.rabatt_prosent != null) hoyre(`${String(l.rabatt_prosent).replace(".", ",")} %`, kol.rabatt, y);
    else if (l.rabatt_belop != null) hoyre(kr(l.rabatt_belop), kol.rabatt, y);
    if (visMva) hoyre(`${l.mva_sats.toString().replace(".", ",")} %`, kol.mva, y);
    hoyre(kr(b.eks), kol.belop, y);
    y -= hoyde;
  }

  // Summer og betalingsinformasjon må stå samlet.
  const sum = summer(f.linjer);
  const rabatt = f.linjer.reduce((s, l) => s + linjerabatt(l), 0);
  if (y - (harRabatt ? 176 : 150) < BUNN) nySide(false);
  y -= 8;
  // Streken står midt mellom siste linje og første sum, ikke oppi teksten.
  side.drawLine({ start: { x: 330, y: y + 15 }, end: { x: A4[0] - MARG, y: y + 15 }, thickness: 0.5, color: gra });
  const sumLinje = (navn: string, verdi: string, uthev = false) => {
    tekst(navn, 330, y, { f: uthev ? fet : font, str: uthev ? 11 : 9 });
    hoyre(verdi, kol.belop, y, { f: uthev ? fet : font, str: uthev ? 11 : 9 });
    y -= uthev ? 18 : 13;
  };
  const utenMva = !visMva;
  if (harRabatt) {
    sumLinje("Sum før rabatt", kr(sum.eks + rabatt));
    sumLinje("Rabatt", kr(-rabatt));
  }
  if (utenMva) {
    sumLinje("Sum", kr(sum.eks));
  } else {
    sumLinje("Sum eks. mva", kr(sum.eks));
    sumLinje("Merverdiavgift", kr(sum.mva));
  }
  sumLinje(kreditnota ? "Til gode (NOK)" : "Å betale (NOK)", kr(kreditnota ? -sum.inkl : sum.inkl), true);
  if (utenMva) {
    tekst("Selger er ikke merverdiavgiftspliktig.", 330, y, { str: 8, c: gra });
    y -= 12;
  }

  if (!kreditnota && s.kontonr) {
    y -= 10;
    side.drawRectangle({ x: MARG, y: y - 46, width: A4[0] - 2 * MARG, height: 56, borderColor: aksent, borderWidth: 1 });
    const felter: [string, string][] = [
      ["Kontonummer", kontonr(s.kontonr)],
      ["Beløp", `${kr(sum.inkl)} kr`],
      ["Forfallsdato", dato(f.forfallsdato) || "ved sending"],
      [f.kid ? "KID" : "Merk betalingen med", f.kid ?? `Fakturanr. ${nummer}`],
    ];
    felter.forEach(([n, v], i) => {
      const x = MARG + 10 + (i % 2) * 250;
      const yy = y - 6 - Math.floor(i / 2) * 22;
      tekst(n, x, yy, { c: gra, str: 8 });
      tekst(v, x, yy - 11, { f: fet });
    });
  }

  // Bunnlinje og sidetall på alle sider.
  const bunn = [s.navn, s.orgnr ? `Org.nr. ${orgnr(s.orgnr)}${s.mva_registrert ? " MVA" : ""}` : "", s.epost ?? "", s.telefon ?? ""]
    .filter(Boolean)
    .join("  ·  ");
  sider.forEach((p, i) => {
    side = p;
    side.drawLine({ start: { x: MARG, y: 50 }, end: { x: A4[0] - MARG, y: 50 }, thickness: 0.5, color: gra });
    tekst(bunn, MARG, 36, { str: 8, c: gra });
    if (sider.length > 1) hoyre(`Side ${i + 1} av ${sider.length}`, A4[0] - MARG, 36, { str: 8 });
  });

  doc.setTitle(`${tittel} ${nummer}`);
  doc.setAuthor(s.navn);
  doc.setCreator("HI4 Faktura");
  // Klassisk xref-tabell i stedet for objektstrømmer: leses av alle PDF-lesere og
  // forhåndsvisere, også eldre.
  return doc.save({ useObjectStreams: false });
}
