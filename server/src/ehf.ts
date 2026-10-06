// EHF: elektronisk faktura i PEPPOL-nettverket. Fakturaer og kreditnotaer lages som
// UBL 2.1 etter PEPPOL BIS Billing 3.0, som er EHF Billing 3.0 når norske regler gjelder
// (org.nr. med skjema 0192, «NO…MVA», «Foretaksregisteret»). Testene validerer filene mot
// de offisielle reglene (EN 16931 og PEPPOL BIS 3).
//
// Mva-kategorier: S (25, 15, 12 % …), E (0 % hos mva-registrert selger: unntatt) og
// O (selgeren er ikke mva-registrert).

import { linjerabatt } from "./regler.js";

export const CUSTOMIZATION_ID = "urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0";
export const PROFIL_ID = "urn:fdc:peppol.eu:2017:poacc:billing:01:1.0";
export const DOKUMENTTYPE = {
  faktura: `urn:oasis:names:specification:ubl:schema:xsd:Invoice-2::Invoice##${CUSTOMIZATION_ID}::2.1`,
  kreditnota: `urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2::CreditNote##${CUSTOMIZATION_ID}::2.1`,
};

// Hvorfor fakturaen ikke kan lages som EHF (null: den kan).
export function ehfHindring(f: any): string | null {
  if (f.status === "utkast") return "Fakturaen er ikke utstedt ennå.";
  if (!f.selger?.orgnr) return "EHF krever at avsenderen har organisasjonsnummer.";
  if (!f.kunde?.orgnr) return "EHF krever at kunden har organisasjonsnummer.";
  if (f.kunde.land && f.kunde.land !== "NO") return "EHF med organisasjonsnummer gjelder norske kunder.";
  return null;
}

// --- XML ---------------------------------------------------------------------------

type Innhold = string | number | null | undefined | false | Innhold[];
const esc = (s: unknown) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);
const flat = (n: Innhold): string => (Array.isArray(n) ? n.map(flat).join("") : n || n === 0 ? String(n) : "");

// Et element med ferdig XML inni. Tomme elementer utelates (PEPPOL tillater dem ikke).
function el(navn: string, innhold: Innhold, attr: Record<string, string | null | undefined> = {}): string {
  const inni = flat(innhold);
  if (inni === "") return "";
  const a = Object.entries(attr)
    .filter(([, v]) => v != null && v !== "")
    .map(([k, v]) => ` ${k}="${esc(v)}"`)
    .join("");
  return `<${navn}${a}>${inni}</${navn}>`;
}
// Et element med tekst (escapes).
const t = (navn: string, verdi: unknown, attr?: Record<string, string | null | undefined>) =>
  verdi == null || String(verdi).trim() === "" ? "" : el(navn, esc(String(verdi).trim()), attr);

// Beløp regnes i øre, så summene blir eksakte.
const ore = (v: unknown) => Math.round(Number(v) * 100);
const kroner = (o: number) => `${o < 0 ? "-" : ""}${Math.floor(Math.abs(o) / 100)}.${String(Math.abs(o) % 100).padStart(2, "0")}`;
const tall = (v: number) => {
  const r = Math.round(v * 1e6) / 1e6;
  return Object.is(r, -0) ? "0" : String(r).includes("e") ? r.toFixed(6) : String(r);
};

// Enheter etter UN/ECE Rec 20 (C62 = stk/enhet).
const ENHETER: Record<string, string> = {
  stk: "C62", "stk.": "C62", stykk: "C62", enhet: "C62", pcs: "C62", ea: "C62",
  t: "HUR", time: "HUR", timer: "HUR", h: "HUR", min: "MIN", minutt: "MIN", minutter: "MIN",
  dag: "DAY", dager: "DAY", døgn: "DAY", uke: "WEE", uker: "WEE",
  mnd: "MON", "mnd.": "MON", måned: "MON", måneder: "MON", maaned: "MON",
  kvartal: "QAN", år: "ANN", aar: "ANN",
  km: "KMT", m: "MTR", m2: "MTK", "m²": "MTK", m3: "MTQ", "m³": "MTQ",
  kg: "KGM", g: "GRM", tonn: "TNE", l: "LTR", liter: "LTR", kwh: "KWH",
};
export const enhetskode = (enhet: unknown) => ENHETER[String(enhet ?? "").trim().toLowerCase()] ?? "C62";

interface Kategori {
  id: "S" | "E" | "O";
  sats?: number;
  grunnKode?: string;
  grunn?: string;
}
const kategori = (selger: any, sats: number): Kategori =>
  !selger.mva_registrert
    ? { id: "O", grunnKode: "VATEX-EU-O", grunn: "Ikke merverdiavgiftspliktig" }
    : sats > 0
      ? { id: "S", sats }
      : { id: "E", sats: 0, grunn: "Unntatt merverdiavgift" };

const skattekategori = (navn: string, k: Kategori, medGrunn: boolean) =>
  el(navn, [
    t("cbc:ID", k.id),
    k.sats != null ? el("cbc:Percent", tall(k.sats)) : "",
    medGrunn ? t("cbc:TaxExemptionReasonCode", k.grunnKode) : "",
    medGrunn ? t("cbc:TaxExemptionReason", k.grunn) : "",
    el("cac:TaxScheme", t("cbc:ID", "VAT")),
  ]);

function adresse(p: any) {
  const [gate, ...mer] = String(p?.adresse ?? "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  return el("cac:PostalAddress", [
    t("cbc:StreetName", gate),
    t("cbc:AdditionalStreetName", mer.join(", ")),
    t("cbc:CityName", p?.poststed),
    t("cbc:PostalZone", p?.postnr),
    el("cac:Country", t("cbc:IdentificationCode", p?.land || "NO")),
  ]);
}

export interface EhfValg {
  pdf?: { filnavn: string; data: Uint8Array }; // fakturaen som PDF-vedlegg (anbefalt)
  vedlegg?: { filnavn: string; type: string; data: Uint8Array }[]; // vedleggene på fakturaen
  kreditertFaktura?: { nummer: string | number; dato?: string | null }; // for kreditnotaer
}

// Lager EHF-fil (UBL 2.1) for en utstedt faktura eller kreditnota.
export function lagEhf(f: any, valg: EhfValg = {}): string {
  const hindring = ehfHindring(f);
  if (hindring) throw new Error(hindring);
  const kreditnota = f.type === "kreditnota";
  const fortegn = kreditnota ? -1 : 1; // kreditnotaer har positive beløp i EHF
  const valuta = f.valuta ?? "NOK";
  const s = f.selger;
  const k = f.kunde;
  const belop = (navn: string, o: number) => el(navn, kroner(o), { currencyID: valuta });

  const linjer = (f.linjer as any[]).map((l, i) => {
    // Rabatt på linjen blir et fradrag på linjen (AllowanceCharge), og linjebeløpet er etter rabatt.
    const rabattOre = fortegn * ore(linjerabatt({ ...l, antall: Number(l.antall), enhetspris: Number(l.enhetspris) }));
    const belopOre = fortegn * ore(l.belop_eks ?? Number(l.antall) * Number(l.enhetspris)) - (l.belop_eks == null ? rabattOre : 0);
    const mvaOre = fortegn * ore(l.mva_belop ?? 0);
    let antall = fortegn * Number(l.antall);
    let pris = Number(l.enhetspris);
    // Prisen kan ikke være negativ i EHF: en rabattlinje får negativt antall i stedet.
    if (pris < 0) {
      pris = -pris;
      antall = -antall;
    }
    return { nr: i + 1, l, belopOre, rabattOre, mvaOre, antall, pris, k: kategori(s, Number(l.mva_sats ?? 0)) };
  });

  const grupper = new Map<string, { k: Kategori; grunnlag: number; mva: number }>();
  for (const x of linjer) {
    const nokkel = `${x.k.id}:${x.k.sats ?? ""}`;
    const g = grupper.get(nokkel) ?? { k: x.k, grunnlag: 0, mva: 0 };
    g.grunnlag += x.belopOre;
    g.mva += x.k.id === "O" ? 0 : x.mvaOre;
    grupper.set(nokkel, g);
  }
  const linjesum = linjer.reduce((sum, x) => sum + x.belopOre, 0);
  const mvaSum = [...grupper.values()].reduce((sum, g) => sum + g.mva, 0);

  // «Deres ref.» er påkrevd i PEPPOL (eller en bestillingsreferanse).
  const kjoperRef = f.deres_referanse?.trim() || "Ikke oppgitt";
  const linjeNavn = (tekst: string) => {
    const forste = tekst.split(/\r?\n/)[0]!.trim();
    return forste.length > 100 ? `${forste.slice(0, 97)}...` : forste || "Vare/tjeneste";
  };

  const deler: Innhold[] = [
    t("cbc:CustomizationID", CUSTOMIZATION_ID),
    t("cbc:ProfileID", PROFIL_ID),
    t("cbc:ID", f.fakturanummer),
    t("cbc:IssueDate", f.fakturadato),
    !kreditnota && t("cbc:DueDate", f.forfallsdato),
    kreditnota ? t("cbc:CreditNoteTypeCode", "381") : t("cbc:InvoiceTypeCode", "380"),
    // PEPPOL tillater ett notat: notatet til kunden og vår referanse.
    t("cbc:Note", [f.kommentar?.trim(), f.var_referanse && `Vår referanse: ${f.var_referanse}`].filter(Boolean).join("\n")),
    t("cbc:DocumentCurrencyCode", valuta),
    t("cbc:BuyerReference", kjoperRef),
    (f.periode_fra || f.periode_til) && el("cac:InvoicePeriod", [t("cbc:StartDate", f.periode_fra), t("cbc:EndDate", f.periode_til)]),
    kreditnota &&
      valg.kreditertFaktura &&
      el("cac:BillingReference", el("cac:InvoiceDocumentReference", [t("cbc:ID", valg.kreditertFaktura.nummer), t("cbc:IssueDate", valg.kreditertFaktura.dato)])),
    valg.pdf &&
      el("cac:AdditionalDocumentReference", [
        t("cbc:ID", f.fakturanummer),
        t("cbc:DocumentDescription", kreditnota ? "Kreditnota" : "Faktura"),
        el(
          "cac:Attachment",
          el("cbc:EmbeddedDocumentBinaryObject", Buffer.from(valg.pdf.data).toString("base64"), { mimeCode: "application/pdf", filename: valg.pdf.filnavn }),
        ),
      ]),
    // Vedleggene, med filnavnet som referanse.
    ...(valg.vedlegg ?? []).map((v) =>
      el("cac:AdditionalDocumentReference", [
        t("cbc:ID", v.filnavn),
        t("cbc:DocumentDescription", "Vedlegg"),
        el("cac:Attachment", el("cbc:EmbeddedDocumentBinaryObject", Buffer.from(v.data).toString("base64"), { mimeCode: v.type, filename: v.filnavn })),
      ]),
    ),
    el(
      "cac:AccountingSupplierParty",
      el("cac:Party", [
        el("cbc:EndpointID", esc(s.orgnr), { schemeID: "0192" }),
        s.firmanavn && s.navn && s.navn !== s.firmanavn && el("cac:PartyName", t("cbc:Name", s.navn)),
        adresse(s),
        s.mva_registrert && el("cac:PartyTaxScheme", [t("cbc:CompanyID", `NO${s.orgnr}MVA`), el("cac:TaxScheme", t("cbc:ID", "VAT"))]),
        s.foretaksregisteret && el("cac:PartyTaxScheme", [t("cbc:CompanyID", "Foretaksregisteret"), el("cac:TaxScheme", t("cbc:ID", "TAX"))]),
        el("cac:PartyLegalEntity", [t("cbc:RegistrationName", s.firmanavn ?? s.navn), el("cbc:CompanyID", esc(s.orgnr), { schemeID: "0192" })]),
        el("cac:Contact", [t("cbc:Telephone", s.telefon), t("cbc:ElectronicMail", s.epost)]),
      ]),
    ),
    el(
      "cac:AccountingCustomerParty",
      el("cac:Party", [
        el("cbc:EndpointID", esc(k.orgnr), { schemeID: "0192" }),
        adresse(k),
        el("cac:PartyLegalEntity", [t("cbc:RegistrationName", k.navn), el("cbc:CompanyID", esc(k.orgnr), { schemeID: "0192" })]),
        el("cac:Contact", t("cbc:ElectronicMail", k.epost)),
      ]),
    ),
    !kreditnota &&
      el("cac:PaymentMeans", [t("cbc:PaymentMeansCode", "30"), t("cbc:PaymentID", f.kid), el("cac:PayeeFinancialAccount", t("cbc:ID", s.kontonr))]),
    // Kreditnotaer har ikke forfallsdato; EN 16931 krever da betalingsvilkår som tekst.
    kreditnota && el("cac:PaymentTerms", t("cbc:Note", "Kreditnota. Beløpet trekkes fra det kunden skylder, eller betales tilbake.")),
    el("cac:TaxTotal", [
      belop("cbc:TaxAmount", mvaSum),
      ...[...grupper.values()].map((g) =>
        el("cac:TaxSubtotal", [belop("cbc:TaxableAmount", g.grunnlag), belop("cbc:TaxAmount", g.mva), skattekategori("cac:TaxCategory", g.k, true)]),
      ),
    ]),
    el("cac:LegalMonetaryTotal", [
      belop("cbc:LineExtensionAmount", linjesum),
      belop("cbc:TaxExclusiveAmount", linjesum),
      belop("cbc:TaxInclusiveAmount", linjesum + mvaSum),
      belop("cbc:PayableAmount", linjesum + mvaSum),
    ]),
    ...linjer.map((x) =>
      el(kreditnota ? "cac:CreditNoteLine" : "cac:InvoiceLine", [
        t("cbc:ID", x.nr),
        el(kreditnota ? "cbc:CreditedQuantity" : "cbc:InvoicedQuantity", tall(x.antall), { unitCode: enhetskode(x.l.enhet) }),
        belop("cbc:LineExtensionAmount", x.belopOre),
        x.rabattOre !== 0 &&
          el("cac:AllowanceCharge", [
            t("cbc:ChargeIndicator", "false"),
            t("cbc:AllowanceChargeReasonCode", "95"), // rabatt (UNCL 5189)
            t("cbc:AllowanceChargeReason", "Rabatt"),
            x.l.rabatt_prosent != null && el("cbc:MultiplierFactorNumeric", tall(Number(x.l.rabatt_prosent))),
            belop("cbc:Amount", x.rabattOre),
            x.l.rabatt_prosent != null && belop("cbc:BaseAmount", x.belopOre + x.rabattOre),
          ]),
        el("cac:Item", [
          linjeNavn(x.l.beskrivelse) !== String(x.l.beskrivelse).trim() && t("cbc:Description", x.l.beskrivelse),
          t("cbc:Name", linjeNavn(String(x.l.beskrivelse ?? ""))),
          skattekategori("cac:ClassifiedTaxCategory", x.k, false),
        ]),
        el("cac:Price", el("cbc:PriceAmount", tall(x.pris), { currencyID: valuta })),
      ]),
    ),
  ];

  const rot = kreditnota ? "CreditNote" : "Invoice";
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<${rot} xmlns="urn:oasis:names:specification:ubl:schema:xsd:${rot}-2" ` +
    `xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" ` +
    `xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">` +
    flat(deler) +
    `</${rot}>\n`
  );
}

export const ehfFilnavn = (f: any) => `${f.type === "kreditnota" ? "Kreditnota" : "Faktura"}-${f.fakturanummer}.xml`;
