// Felles for API og worker: henter en faktura med linjer og lager PDF og e-post.
import { alle, en, type Db } from "./db.js";
import { config } from "./config.js";
import { lagPdf, type PdfFaktura } from "./pdf.js";
import { dato, kontonr, kr } from "./regler.js";
import { lagring } from "./tjenester.js";
import { ApiFeil } from "./feil.js";
import { erPng, normaliserLogo } from "./logo.js";

export async function hentFaktura(db: Db, orgId: string, id: string) {
  const f = await en(db, "select * from faktura.fakturaer where id = $1 and org_id = $2", [id, orgId]);
  if (!f) throw new ApiFeil(404, "Fant ikke fakturaen");
  const linjer = await alle(db, "select * from faktura.faktura_linjer where faktura_id = $1 order by rekke, opprettet", [id]);
  return { ...f, linjer };
}

async function hentLogo(sti: string | null | undefined) {
  if (!sti || !config.filerBucket) return null;
  try {
    const bytes = await lagring.hent(config.filerBucket, sti);
    if (!bytes) return null;
    // Eldre logoer ble lagret i full størrelse; skaler dem ned her også.
    const liten = await normaliserLogo(bytes);
    return { bytes: liten, type: (erPng(liten) ? "png" : "jpg") as "png" | "jpg" };
  } catch {
    return null;
  }
}

export async function pdfData(db: Db, f: any): Promise<PdfFaktura> {
  const utkast = f.status === "utkast";
  let selger = f.selger;
  let kunde = f.kunde;
  // Utkast har ikke kopier ennå; bruk organisasjonen og kunden slik de er nå.
  if (utkast) {
    selger = (await en(db, "select faktura.selger_for($1, $2, $3) as s", [f.org_id, f.konto_id ?? null, f.avsender ?? null]))?.s;
    kunde = await en(db, "select * from faktura.kunder where id = $1", [f.kunde_id]);
  }
  const kreditnotaFor = f.kreditnota_for
    ? (await en(db, "select fakturanummer from faktura.fakturaer where id = $1", [f.kreditnota_for]))?.fakturanummer
    : null;
  return {
    type: f.type,
    utkast,
    fakturanummer: f.fakturanummer,
    kreditnota_for_nummer: kreditnotaFor,
    fakturadato: f.fakturadato,
    forfallsdato: f.forfallsdato,
    periode_fra: f.periode_fra,
    periode_til: f.periode_til,
    kid: f.kid,
    deres_referanse: f.deres_referanse ?? (utkast ? kunde?.deres_referanse : null),
    var_referanse: f.var_referanse,
    selger,
    kunde,
    linjer: f.linjer.map((l: any) => ({
      beskrivelse: l.beskrivelse,
      antall: l.antall,
      enhet: l.enhet,
      enhetspris: l.enhetspris,
      mva_sats: l.mva_sats,
    })),
    logo: await hentLogo(selger?.logo_sti),
  };
}

// Id-en er med fordi et fakturanummer kan brukes på nytt når testfakturaer slettes,
// og PDF-en til den slettede fakturaen blir liggende (bøtta har oppbevaringsregel).
export function pdfSti(f: any): string {
  return `${f.org_id}/${String(f.fakturadato).slice(0, 4)}/${f.type}-${f.fakturanummer}-${f.id}.pdf`;
}

export function pdfFilnavn(f: any): string {
  return `${f.type === "kreditnota" ? "Kreditnota" : "Faktura"}-${f.fakturanummer ?? "utkast"}.pdf`;
}

// PDF-en for en utstedt faktura lages én gang og gjenbrukes; bøtta tillater ikke overskriving.
export async function sikrePdf(db: Db, f: any): Promise<{ sti: string; data: Uint8Array }> {
  if (!config.fakturaBucket) throw new Error("FAKTURA_BUCKET er ikke satt");
  const sti = f.pdf_sti ?? pdfSti(f);
  const finnes = await lagring.hent(config.fakturaBucket, sti);
  if (finnes) return { sti, data: finnes };
  const data = await lagPdf(await pdfData(db, f));
  try {
    await lagring.lagre(config.fakturaBucket, sti, data, "application/pdf");
  } catch (e) {
    // En annen kjøring rakk å lagre den først.
    if ((e as { code?: number }).code !== 412) throw e;
    return { sti, data: (await lagring.hent(config.fakturaBucket, sti))! };
  }
  return { sti, data };
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export function fakturaEpost(f: any) {
  const kreditnota = f.type === "kreditnota";
  const s = f.selger;
  const navn = f.kunde?.navn ?? "";
  const emne = `${kreditnota ? "Kreditnota" : "Faktura"} ${f.fakturanummer} fra ${s.navn}`;
  const linjer = kreditnota
    ? [`Hei ${navn},`, "", `Vedlagt er kreditnota ${f.fakturanummer} på ${kr(-f.sum_inkl_mva)} kr.`]
    : [
        `Hei ${navn},`,
        "",
        `Vedlagt er faktura ${f.fakturanummer} på ${kr(f.sum_inkl_mva)} kr med forfall ${dato(f.forfallsdato)}.`,
        "",
        `Kontonummer: ${kontonr(s.kontonr)}`,
        f.kid ? `KID: ${f.kid}` : `Merk betalingen med fakturanummer ${f.fakturanummer}.`,
      ];
  linjer.push("", `Spørsmål om fakturaen kan sendes til ${s.epost ?? s.navn} ved å svare på denne e-posten.`, "", "Med vennlig hilsen", s.navn);
  const tekst = linjer.join("\n");
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#222">${linjer
    .map((l) => (l ? `<p style="margin:0">${esc(l)}</p>` : "<br>"))
    .join("")}<p style="margin-top:24px;font-size:12px;color:#888">Sendt med HI4 Faktura</p></div>`;
  return { emne, tekst, html };
}

export function purringEpost(f: any, p: any) {
  const s = f.selger;
  const inkasso = p.type === "inkassovarsel";
  const totalt = Number(p.utestaende) + Number(p.gebyr);
  const emne = inkasso ? `Inkassovarsel – faktura ${f.fakturanummer} fra ${s.navn}` : `Påminnelse – faktura ${f.fakturanummer} fra ${s.navn}`;
  const linjer = [
    `Hei ${f.kunde?.navn ?? ""},`,
    "",
    inkasso
      ? `Vi har fortsatt ikke mottatt betaling for faktura ${f.fakturanummer}, som forfalt ${dato(f.forfallsdato)}, selv om vi har sendt betalingspåminnelse.`
      : `Vi kan ikke se å ha mottatt betaling for faktura ${f.fakturanummer}, som forfalt ${dato(f.forfallsdato)}. Fakturaen er vedlagt.`,
    "",
    `Utestående: ${kr(Number(p.utestaende))} kr`,
    ...(Number(p.gebyr) > 0 ? [`Purregebyr: ${kr(Number(p.gebyr))} kr`, `Å betale: ${kr(totalt)} kr`] : []),
    `Ny betalingsfrist: ${dato(p.ny_frist)}`,
    "",
    `Kontonummer: ${kontonr(s.kontonr)}`,
    f.kid ? `KID: ${f.kid}` : `Merk betalingen med fakturanummer ${f.fakturanummer}.`,
    "",
    ...(inkasso
      ? [
          `Dette er et inkassovarsel. Er beløpet ikke betalt innen ${dato(p.ny_frist)}, kan kravet bli sendt til inkasso. Det medfører ekstra kostnader for deg.`,
          "Har du innsigelser mot kravet, må du gi beskjed før fristen ved å svare på denne e-posten.",
          "",
        ]
      : ["Har du allerede betalt, kan du se bort fra denne påminnelsen.", ""]),
    `Spørsmål kan sendes til ${s.epost ?? s.navn} ved å svare på denne e-posten.`,
    "",
    "Med vennlig hilsen",
    s.navn,
  ];
  const tekst = linjer.join("\n");
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#222">${linjer
    .map((l) => (l ? `<p style="margin:0">${esc(l)}</p>` : "<br>"))
    .join("")}<p style="margin-top:24px;font-size:12px;color:#888">Sendt med HI4 Faktura</p></div>`;
  return { emne, tekst, html };
}
