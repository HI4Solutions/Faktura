// Årsregnskapet som PDF (aarsregnskap.ts): resultatregnskapet og balansen med fjoråret, notene og
// plassen for signaturene. Regnskapsloven § 3-5: årsregnskapet skal underskrives av hele styret og
// daglig leder, og det underskrevne eksemplaret oppbevares. Rollene fra Enhetsregisteret står under
// signaturlinjene.
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import type { Aarsregnskap, Linje } from "./aarsregnskap.js";
import { rensTekst } from "./pdf.js";

const tallFormat = new Intl.NumberFormat("nb-NO", { maximumFractionDigits: 0 });
const belop = (n: number) => tallFormat.format(n).replace(/\s/g, " ").replace("−", "-");
const visDato = (d: string) => d.split("-").reverse().join(".");
const visOrgnr = (n: string | null) => (n ? n.replace(/^(\d{3})(\d{3})(\d{3})$/, "$1 $2 $3") : "");

export async function aarsregnskapPdf(a: Aarsregnskap): Promise<{ filnavn: string; data: Uint8Array }> {
  const doc = await PDFDocument.create();
  doc.setTitle(`Årsregnskap ${a.aar} ${a.navn}`);
  doc.setCreator("Admin Konsoll");
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const fet = await doc.embedFont(StandardFonts.HelveticaBold);
  const [B, H] = [595.28, 841.89];
  const M = 54;
  const svart = rgb(0.1, 0.12, 0.18);
  const gra = rgb(0.39, 0.45, 0.55);
  const strek = rgb(0.78, 0.81, 0.86);
  let side: PDFPage = doc.addPage([B, H]);
  let y = H - M;

  const nySide = () => {
    side = doc.addPage([B, H]);
    y = H - M;
  };
  const plass = (h: number) => {
    if (y - h < M + 16) nySide();
  };
  const tekst = (t: string, x: number, f: PDFFont = font, s = 9.5, farge = svart) => side.drawText(rensTekst(t, f), { x, y, size: s, font: f, color: farge });
  const hoyre = (t: string, xHoyre: number, f: PDFFont = font, s = 9.5, farge = svart) => {
    const r = rensTekst(t, f);
    side.drawText(r, { x: xHoyre - f.widthOfTextAtSize(r, s), y, size: s, font: f, color: farge });
  };
  const linje = (fra: number, til: number, tykkelse = 0.6) => side.drawLine({ start: { x: fra, y }, end: { x: til, y }, thickness: tykkelse, color: strek });
  // Teksten delt i linjer som får plass i bredden.
  const bryt = (t: string, f: PDFFont, s: number, bredde: number): string[] => {
    const ut: string[] = [];
    for (const avsnitt of rensTekst(t, f).split("\n")) {
      let rad = "";
      for (const ord of avsnitt.split(/\s+/).filter(Boolean)) {
        const ny = rad ? `${rad} ${ord}` : ord;
        if (f.widthOfTextAtSize(ny, s) <= bredde || !rad) rad = ny;
        else {
          ut.push(rad);
          rad = ord;
        }
      }
      ut.push(rad);
    }
    return ut;
  };
  const avsnitt = (t: string, s = 9.5) => {
    for (const l of bryt(t, font, s, B - 2 * M)) {
      plass(13);
      tekst(l, M, font, s);
      y -= 13;
    }
  };

  // Hodet.
  tekst(`Årsregnskap ${a.aar}`, M, fet, 20);
  y -= 24;
  tekst(a.navn, M, fet, 12);
  y -= 15;
  tekst(`Org.nr. ${visOrgnr(a.orgnr)} · Regnskapsperioden ${visDato(a.start)}–${visDato(a.slutt)}`, M, font, 9.5, gra);
  y -= 30;

  // Resultatregnskapet og balansen: postene innrykket under overskriftene, summene med strek over.
  const xAar = B - M - 95;
  const xFjor = B - M;
  const tabell = (tittel: string, linjer: Linje[]) => {
    plass(70);
    tekst(tittel, M, fet, 14);
    hoyre(String(a.aar), xAar, fet, 9.5, gra);
    if (a.har_fjor) hoyre(String(a.aar - 1), xFjor, fet, 9.5, gra);
    y -= 7;
    linje(M, B - M, 0.8);
    y -= 15;
    for (const l of linjer.filter((x) => x.vis)) {
      if (l.type === "overskrift") {
        plass(l.niva === 1 ? 80 : 40);
        y -= l.niva === 1 ? 6 : 2;
        tekst(l.navn, M, fet, l.niva === 1 ? 11 : 9.5);
        y -= 15;
        continue;
      }
      plass(18);
      const f = l.type === "sum" ? fet : font;
      if (l.type === "sum") {
        y += 10;
        linje(xAar - 80, a.har_fjor ? xFjor : xAar);
        y -= 10;
      }
      tekst(l.navn, l.type === "post" ? M + 10 : M, f);
      hoyre(belop(l.aarets), xAar, f);
      if (a.har_fjor) hoyre(belop(l.fjor), xFjor, f, 9.5, gra);
      y -= l.niva === 1 ? 20 : 15;
    }
    y -= 14;
  };
  tabell("Resultatregnskap", a.resultat);
  tabell(`Balanse ${visDato(a.slutt)}`, a.balanse);

  // Notene.
  nySide();
  tekst("Noter", M, fet, 14);
  y -= 24;
  let nr = 1;
  const note = (tittel: string, innhold: () => void) => {
    plass(46);
    tekst(`Note ${nr++} – ${tittel}`, M, fet, 11);
    y -= 17;
    innhold();
    y -= 12;
  };
  const opp = a.opplysninger;
  note("Regnskapsprinsipper", () => {
    for (const p of a.noter.prinsipper.split(/\n\s*\n/)) {
      avsnitt(p);
      y -= 5;
    }
  });
  if (opp.usikkerhet_drift) note("Usikkerhet om fortsatt drift", () => avsnitt(opp.usikkerhet_tekst ?? ""));
  note(a.noter.lonn ? "Lønnskostnader og antall årsverk" : "Antall årsverk", () => {
    if (a.noter.lonn) {
      hoyre(String(a.aar), xAar, fet, 9, gra);
      if (a.har_fjor) hoyre(String(a.aar - 1), xFjor, fet, 9, gra);
      y -= 14;
      const sum = { aarets: 0, fjor: 0 };
      for (const l of a.noter.lonn) {
        plass(14);
        tekst(l.navn, M + 10);
        hoyre(belop(l.aarets), xAar);
        if (a.har_fjor) hoyre(belop(l.fjor), xFjor, font, 9.5, gra);
        sum.aarets += l.aarets;
        sum.fjor += l.fjor;
        y -= 14;
      }
      y += 10;
      linje(xAar - 80, a.har_fjor ? xFjor : xAar);
      y -= 10;
      tekst("Sum lønnskostnader", M, fet);
      hoyre(belop(sum.aarets), xAar, fet);
      if (a.har_fjor) hoyre(belop(sum.fjor), xFjor, fet, 9.5, gra);
      y -= 20;
    }
    const aarsverk = opp.aarsverk ?? a.noter.aarsverk_forslag;
    avsnitt(`Virksomheten har hatt ${String(aarsverk).replace(".", ",")} årsverk i regnskapsåret.`);
  });
  note("Lån og sikkerhetsstillelse til ledende personer og aksjeeiere", () => {
    const l = opp.laan;
    if (!l?.gitt) return avsnitt("Det er ikke gitt lån eller stilt sikkerhet for daglig leder, styremedlemmer, aksjeeiere eller andre ledende personer.");
    const rader: [string, string | null | undefined][] = [
      ["Samlet lån til styret", l.laan_styret != null ? `${belop(l.laan_styret)} kr` : null],
      ["Samlet lån til andre", l.laan_andre != null ? `${belop(l.laan_andre)} kr` : null],
      ["Sikkerhetsstillelse for styret", l.sikkerhet_styret != null ? `${belop(l.sikkerhet_styret)} kr` : null],
      ["Sikkerhetsstillelse for andre", l.sikkerhet_andre != null ? `${belop(l.sikkerhet_andre)} kr` : null],
      ["Rentesats (styret)", l.rente_styret ? `${l.rente_styret} %` : null],
      ["Rentesats (andre)", l.rente_andre ? `${l.rente_andre} %` : null],
      ["Hovedvilkår (styret)", l.vilkaar_styret],
      ["Hovedvilkår (andre)", l.vilkaar_andre],
    ];
    for (const [navn, verdi] of rader) {
      if (!verdi) continue;
      plass(14);
      tekst(navn, M + 10);
      hoyre(verdi, xFjor);
      y -= 14;
    }
    if (l.tekst) avsnitt(l.tekst);
  });
  const g = opp.gjeld;
  if (g && (g.over_fem_aar != null || g.pantsikret != null || g.pantsatte_eiendeler != null || g.garantier != null || g.tekst))
    note("Gjeld", () => {
      for (const [navn, verdi] of [
        ["Gjeld som forfaller mer enn fem år etter regnskapsårets slutt", g.over_fem_aar],
        ["Gjeld sikret ved pant eller lignende", g.pantsikret],
        ["Balanseført verdi av de pantsatte eiendelene", g.pantsatte_eiendeler],
        ["Garantiforpliktelser som ikke er regnskapsført", g.garantier],
      ] as const) {
        if (verdi == null) continue;
        plass(14);
        tekst(navn, M + 10);
        hoyre(`${belop(verdi)} kr`, xFjor);
        y -= 14;
      }
      if (g.tekst) avsnitt(g.tekst);
    });
  if (opp.ytterligere) note("Andre opplysninger", () => avsnitt(opp.ytterligere!));

  // Fastsettelsen og signaturene (to i bredden).
  plass(70 + Math.ceil(Math.max(a.roller.length, 2) / 2) * 62);
  y -= 6;
  avsnitt(opp.fastsettelsesdato ? `Årsregnskapet er fastsatt av generalforsamlingen ${visDato(opp.fastsettelsesdato)}.` : "Sted og dato: ______________________________");
  y -= 34;
  const signaturer = a.roller.length ? a.roller : [{ rolle: "Styreleder", navn: "" }, { rolle: "Daglig leder", navn: "" }];
  const bredde = (B - 2 * M - 30) / 2;
  for (let i = 0; i < signaturer.length; i += 2) {
    plass(62);
    for (let j = 0; j < 2 && i + j < signaturer.length; j++) {
      const s = signaturer[i + j]!;
      const x = M + j * (bredde + 30);
      linje(x, x + bredde);
      y -= 12;
      tekst(s.navn || " ", x, fet, 9);
      y -= 11;
      tekst(s.rolle, x, font, 8.5, gra);
      y += 23;
    }
    y -= 62;
  }

  // Bunnteksten på hver side.
  const laget = new Intl.DateTimeFormat("nb-NO", { timeZone: "Europe/Oslo", dateStyle: "short" }).format(new Date());
  const sider = doc.getPages();
  sider.forEach((s, i) => {
    const t = `Side ${i + 1} av ${sider.length}`;
    s.drawText(t, { x: B - M - font.widthOfTextAtSize(t, 7.5), y: 24, size: 7.5, font, color: gra });
    s.drawText(rensTekst(`${a.navn} · Årsregnskap ${a.aar} · Laget ${laget} i Admin Konsoll`, font), { x: M, y: 24, size: 7.5, font, color: gra });
  });
  return { filnavn: `aarsregnskap-${a.aar}${a.orgnr ? `-${a.orgnr}` : ""}.pdf`, data: await doc.save() };
}
