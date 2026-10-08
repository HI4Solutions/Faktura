// Import av kunder, produkter og ansatte fra andre systemer (Fiken, Tripletex, Visma, PowerOffice,
// Excel …). Leser CSV, Excel (.xlsx) og tabeller limt inn fra et regneark, kjenner igjen
// kolonnene på overskriftene og gjør verdiene om til det API-et vil ha. API-et kontrollerer
// radene og sier hva som blir nytt, hva som finnes fra før og hva som har feil.
import { fnrGyldig, kontonrGyldig } from "./personnummer";

export type Importtype = "kunder" | "produkter" | "ansatte";

export interface Ark {
  navn: string;
  rader: string[][];
  radnr: number[]; // radnummeret i fila (som i Excel), for hver rad
}

// kilde: tall fra Excel og AI har punktum som desimaltegn; i tekst er komma vanligst.
export interface Innlest {
  ark: Ark[];
  kilde: "xlsx" | "tekst" | "ai";
}

// ---------------------------------------------------------------------------
// Lesing
// ---------------------------------------------------------------------------

// Lønnsslipper (PDF eller bilde) leses med AI i stedet for som tabell (server/src/aiLonnsslipp.ts).
const SLIPPTYPER: Record<string, string> = {
  pdf: "application/pdf",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  heic: "image/heic",
  heif: "image/heif",
};
export const SLIPP_ACCEPT = ".pdf,.jpg,.jpeg,.png,.webp,.heic,.heif,application/pdf,image/jpeg,image/png,image/webp,image/heic,image/heif";
export const erLonnsslipp = (fil: File) => Object.values(SLIPPTYPER).includes(fil.type) || /\.(pdf|jpe?g|png|webp|heic|heif)$/i.test(fil.name);
// Fila med riktig type (bilder fra iPhone kan komme uten type i nettleseren).
export function slippBlob(fil: File): Blob {
  if (Object.values(SLIPPTYPER).includes(fil.type)) return fil;
  return new Blob([fil], { type: SLIPPTYPER[fil.name.split(".").pop()?.toLowerCase() ?? ""] ?? "application/pdf" });
}
// Det AI-en leste fra lønnsslippene: rader til importen av ansatte, og det den var usikker på.
export type Lonnsslipper = { ansatte: Record<string, unknown>[]; merknader: string[] };

export async function lesFil(fil: File): Promise<Innlest> {
  const b = new Uint8Array(await fil.arrayBuffer());
  if (b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04) return { ark: await lesXlsx(b), kilde: "xlsx" };
  if (b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0)
    throw new Error("Gamle Excel-filer (.xls) kan ikke leses. Åpne fila i Excel og lagre den som .xlsx eller CSV.");
  if (b.subarray(0, 5).some((x) => x === 0) && !(b[0] === 0xff || b[0] === 0xfe))
    throw new Error("Fila ser ikke ut som en CSV- eller Excel-fil.");
  return lesTekst(dekod(b));
}

export function lesTekst(tekst: string): Innlest {
  const { rader, radnr } = lesCsv(tekst);
  return { ark: [{ navn: "", rader, radnr }], kilde: "tekst" };
}

// Tegnsett: UTF-8 (med eller uten BOM), UTF-16 fra «Unicode-tekst» i Excel, ellers
// Windows-1252 (CSV fra eldre Excel på norsk Windows).
export function dekod(b: Uint8Array): string {
  if (b[0] === 0xff && b[1] === 0xfe) return new TextDecoder("utf-16le").decode(b);
  if (b[0] === 0xfe && b[1] === 0xff) return new TextDecoder("utf-16be").decode(b);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(b);
  } catch {
    return new TextDecoder("windows-1252").decode(b);
  }
}

// Teller skilletegnet utenfor anførselstegn.
function tell(linje: string, skille: string) {
  let n = 0;
  let anf = false;
  for (const t of linje) {
    if (t === '"') anf = !anf;
    else if (t === skille && !anf) n++;
  }
  return n;
}

// Skilletegnet som deler flest linjer i like mange kolonner. Tabulator vinner ved likt
// (tabeller limt inn fra regneark), deretter semikolon (norsk Excel).
export function finnSkilletegn(tekst: string): string {
  const linjer = tekst.split(/\r\n|\n|\r/).filter((l) => l.trim()).slice(0, 30);
  let best = ",";
  let bestPoeng = 0;
  for (const s of ["\t", ";", ",", "|"]) {
    const antall = new Map<number, number>();
    for (const l of linjer) {
      const n = tell(l, s);
      if (n > 0) antall.set(n, (antall.get(n) ?? 0) + 1);
    }
    let poeng = 0;
    for (const [n, linjerMedN] of antall) poeng = Math.max(poeng, linjerMedN * 1000 + n);
    if (poeng > bestPoeng) {
      best = s;
      bestPoeng = poeng;
    }
  }
  return best;
}

// CSV etter RFC 4180: felt i anførselstegn kan inneholde skilletegn, linjeskift og "".
export function lesCsv(tekst: string, skille?: string): { rader: string[][]; radnr: number[] } {
  let t = tekst.replace(/^﻿/, "");
  // Excel kan skrive skilletegnet på første linje: «sep=;».
  const sep = /^sep=(.)\r?\n/i.exec(t);
  let forskyv = 0;
  if (sep) {
    skille ??= sep[1];
    t = t.slice(sep[0].length);
    forskyv = 1;
  }
  const s = skille ?? finnSkilletegn(t);
  const alle: string[][] = [];
  let rad: string[] = [];
  let celle = "";
  let anf = false;
  let start = 0; // start på teksten som ikke er lagt i cellen ennå
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (anf) {
      if (c === '"') {
        celle += t.slice(start, i);
        if (t[i + 1] === '"') {
          celle += '"';
          i++;
        } else anf = false;
        start = i + 1;
      }
    } else if (c === '"' && celle === "" && i === start) {
      anf = true;
      start = i + 1;
    } else if (c === s) {
      rad.push(celle + t.slice(start, i));
      celle = "";
      start = i + 1;
    } else if (c === "\n" || c === "\r") {
      rad.push(celle + t.slice(start, i));
      alle.push(rad);
      rad = [];
      celle = "";
      if (c === "\r" && t[i + 1] === "\n") i++;
      start = i + 1;
    }
  }
  if (start < t.length || celle !== "" || rad.length) {
    rad.push(celle + t.slice(start));
    alle.push(rad);
  }
  return rydd(alle, alle.map((_, i) => i + 1 + forskyv));
}

// Fjerner tomme rader og en eventuell tittel over overskriftene («Kundeliste»).
function rydd(rader: string[][], radnr: number[]): { rader: string[][]; radnr: number[] } {
  const r: string[][] = [];
  const n: number[] = [];
  rader.forEach((rad, i) => {
    if (rad.some((c) => rensCelle(c) !== "")) {
      r.push(rad);
      n.push(radnr[i]!);
    }
  });
  const fylt = (rad: string[]) => rad.filter((c) => rensCelle(c) !== "").length;
  while (r.length > 2 && fylt(r[0]!) === 1 && fylt(r[1]!) >= 2 && fylt(r[2]!) >= 2) {
    r.shift();
    n.shift();
  }
  return { rader: r, radnr: n };
}

// --- Excel (.xlsx): en zip-fil med XML -------------------------------------

async function pakkUt(data: Uint8Array): Promise<Uint8Array> {
  const strom = new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(strom).arrayBuffer());
}

function lesZip(b: Uint8Array): Map<string, () => Promise<Uint8Array>> {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let slutt = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) {
    if (v.getUint32(i, true) === 0x06054b50) {
      slutt = i;
      break;
    }
  }
  if (slutt < 0) throw new Error("Fila er skadet eller ikke en Excel-fil.");
  const antall = v.getUint16(slutt + 10, true);
  let p = v.getUint32(slutt + 16, true);
  const filer = new Map<string, () => Promise<Uint8Array>>();
  for (let i = 0; i < antall; i++) {
    if (v.getUint32(p, true) !== 0x02014b50) throw new Error("Fila er skadet eller ikke en Excel-fil.");
    const metode = v.getUint16(p + 10, true);
    const storrelse = v.getUint32(p + 20, true);
    const navnLengde = v.getUint16(p + 28, true);
    const ekstra = v.getUint16(p + 30, true);
    const kommentar = v.getUint16(p + 32, true);
    const lokal = v.getUint32(p + 42, true);
    const navn = new TextDecoder().decode(b.subarray(p + 46, p + 46 + navnLengde));
    p += 46 + navnLengde + ekstra + kommentar;
    filer.set(navn, async () => {
      const start = lokal + 30 + v.getUint16(lokal + 26, true) + v.getUint16(lokal + 28, true);
      const data = b.subarray(start, start + storrelse);
      if (metode === 0) return data;
      if (metode === 8) return pakkUt(data);
      throw new Error("Excel-fila er pakket på en måte som ikke støttes. Lagre den som CSV.");
    });
  }
  return filer;
}

const xml = (s: string) => new DOMParser().parseFromString(s, "application/xml");
const barn = (e: Element, navn: string) => Array.from(e.children).filter((c) => c.localName === navn);
const alleMed = (d: Document | Element, navn: string) => Array.from(d.getElementsByTagNameNS("*", navn));

// Tekst i <si>/<is>, uten uttaleveiledning (<rPh>).
const tekstI = (e: Element) =>
  alleMed(e, "t")
    .filter((t) => t.parentElement?.localName !== "rPh")
    .map((t) => t.textContent ?? "")
    .join("");

// Kolonnebokstaver (A, B … AA) til indeks.
const kolonne = (ref: string) => {
  let n = 0;
  for (const c of ref.toUpperCase()) {
    const k = c.charCodeAt(0);
    if (k < 65 || k > 90) break;
    n = n * 26 + (k - 64);
  }
  return n - 1;
};

// Tall slik Excel lagrer dem, uten flyttallsstøy (0.30000000000000004).
const tallFraExcel = (v: string) => {
  const n = Number(v);
  return v.trim() !== "" && Number.isFinite(n) ? String(Number(n.toPrecision(15))) : v;
};

export async function lesXlsx(b: Uint8Array): Promise<Ark[]> {
  const filer = lesZip(b);
  const les = async (navn: string) => {
    const f = filer.get(navn);
    return f ? new TextDecoder().decode(await f()) : null;
  };
  const relasjoner = async (sti: string) => {
    const mappe = sti.slice(0, sti.lastIndexOf("/") + 1);
    const r = await les(`${mappe}_rels/${sti.slice(mappe.length)}.rels`);
    const m = new Map<string, string>();
    if (r)
      for (const e of alleMed(xml(r), "Relationship")) {
        const mal = e.getAttribute("Target") ?? "";
        m.set(e.getAttribute("Id") ?? "", mal.startsWith("/") ? mal.slice(1) : normaliser(mappe + mal));
      }
    return m;
  };

  // Arbeidsboka står i _rels/.rels (vanligvis xl/workbook.xml).
  const rot = await les("_rels/.rels");
  const bokSti =
    (rot && alleMed(xml(rot), "Relationship").find((e) => (e.getAttribute("Type") ?? "").endsWith("/officeDocument"))?.getAttribute("Target")?.replace(/^\//, "")) ||
    "xl/workbook.xml";
  const bok = await les(bokSti);
  if (!bok) throw new Error("Fant ingen regneark i fila. Lagre den som .xlsx eller CSV.");
  const rel = await relasjoner(bokSti);
  const mappe = bokSti.slice(0, bokSti.lastIndexOf("/") + 1);

  const delte: string[] = [];
  const delteSti = [...rel.values()].find((s) => s.endsWith("sharedStrings.xml")) ?? `${mappe}sharedStrings.xml`;
  const delteXml = await les(delteSti);
  if (delteXml) for (const si of alleMed(xml(delteXml), "si")) delte.push(tekstI(si));

  const ark: (Ark & { skjult: boolean })[] = [];
  for (const a of alleMed(xml(bok), "sheet")) {
    const id = a.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id") ?? a.getAttribute("r:id") ?? "";
    const sti = rel.get(id);
    const innhold = sti ? await les(sti) : null;
    if (!innhold) continue;
    const rader: string[][] = [];
    const radnr: number[] = [];
    let forrige = 0;
    for (const r of alleMed(xml(innhold), "row")) {
      const nr = Number(r.getAttribute("r")) || forrige + 1;
      forrige = nr;
      const rad: string[] = [];
      let k = -1;
      for (const c of barn(r, "c")) {
        const ref = c.getAttribute("r");
        k = ref ? kolonne(ref) : k + 1;
        const t = c.getAttribute("t");
        const v = barn(c, "v")[0]?.textContent ?? "";
        let verdi: string;
        if (t === "s") verdi = delte[Number(v)] ?? "";
        else if (t === "inlineStr") verdi = barn(c, "is")[0] ? tekstI(barn(c, "is")[0]!) : "";
        else if (t === "b") verdi = v === "1" ? "TRUE" : "FALSE";
        else if (t === "e") verdi = "";
        else if (t === "str") verdi = v;
        else verdi = tallFraExcel(v);
        while (rad.length < k) rad.push("");
        rad[k] = verdi;
      }
      rader.push(rad);
      radnr.push(nr);
    }
    ark.push({ navn: a.getAttribute("name") ?? `Ark ${ark.length + 1}`, ...rydd(rader, radnr), skjult: (a.getAttribute("state") ?? "visible") !== "visible" });
  }
  const synlige = ark.filter((a) => !a.skjult && a.rader.length);
  const resultat = (synlige.length ? synlige : ark.filter((a) => a.rader.length)).map(({ navn, rader, radnr }) => ({ navn, rader, radnr }));
  if (!resultat.length) throw new Error("Regnearket er tomt.");
  return resultat;
}

function normaliser(sti: string) {
  const ut: string[] = [];
  for (const d of sti.split("/")) {
    if (d === "..") ut.pop();
    else if (d !== ".") ut.push(d);
  }
  return ut.join("/");
}

// ---------------------------------------------------------------------------
// Kolonner og felt
// ---------------------------------------------------------------------------

export interface Felt {
  id: string;
  navn: string;
  ord: string[]; // overskrifter som betyr dette feltet, viktigst først
  del?: string[]; // overskrifter som inneholder dette (svakere treff)
  ikke?: string[]; // … men ikke dette
}

const FELLES: Felt[] = [
  { id: "aktiv", navn: "Aktiv (ja/nei)", ord: ["aktiv", "active", "status"] },
  { id: "inaktiv", navn: "Inaktiv (ja/nei)", ord: ["inaktiv", "inactive", "arkivert", "archived", "deaktivert", "skjult", "hidden"] },
];

export const FELT: Record<Importtype, Felt[]> = {
  kunder: [
    {
      id: "navn",
      navn: "Navn",
      ord: ["navn", "kundenavn", "firmanavn", "bedriftsnavn", "foretaksnavn", "organisasjonsnavn", "selskapsnavn", "juridisknavn", "visningsnavn", "fulltnavn",
        "name", "customername", "companyname", "displayname", "fullname", "kunde", "firma", "bedrift", "selskap", "customer", "company"],
      del: ["navn", "name"],
      ikke: ["fornavn", "etternavn", "first", "last", "kontakt", "contact", "bruker", "user", "fil", "produkt", "vare", "selger"],
    },
    { id: "fornavn", navn: "Fornavn", ord: ["fornavn", "firstname", "givenname"], del: ["fornavn", "firstname"], ikke: ["kontakt", "contact"] },
    { id: "etternavn", navn: "Etternavn", ord: ["etternavn", "lastname", "surname", "familyname"], del: ["etternavn", "lastname", "surname"], ikke: ["kontakt", "contact"] },
    {
      id: "orgnr",
      navn: "Org.nr.",
      ord: ["orgnr", "organisasjonsnummer", "organisasjonsnr", "orgnummer", "foretaksnummer", "foretaksnr", "organizationnumber", "organisationnumber", "orgno",
        "orgnumber", "companynumber", "companyregistrationnumber", "registrationnumber", "regnr", "mvanummer", "mvanr", "momsnummer", "vatnumber", "vatno", "vatid"],
      del: ["orgnr", "organisasjonsn", "foretaksn", "orgnummer"],
    },
    {
      id: "epost",
      navn: "E-post for faktura",
      ord: ["fakturaepost", "epostforfaktura", "epostfaktura", "fakturaemail", "invoiceemail", "emailinvoice", "epost", "epostadresse", "email", "emailaddress",
        "mail", "epostadr", "mailadresse"],
      del: ["epost", "email", "mail"],
      ikke: ["kopi", "cc", "kontakt", "contact"],
    },
    {
      id: "telefon",
      navn: "Telefon",
      ord: ["telefon", "telefonnummer", "telefonnr", "tlf", "tlfnr", "mobil", "mobilnummer", "mobilnr", "mobiltelefon", "phone", "phonenumber", "telephone",
        "mobile", "mobilephone", "cellphone"],
      del: ["telefon", "tlf", "mobil", "phone"],
      ikke: ["fax", "faks", "kontakt", "contact"],
    },
    {
      id: "adresse",
      navn: "Adresse",
      ord: ["fakturaadresse", "postadresse", "adresse", "adresselinje1", "adresse1", "gateadresse", "billingaddress", "invoiceaddress", "postaladdress", "address",
        "addressline1", "address1", "streetaddress", "street", "besøksadresse", "forretningsadresse", "leveringsadresse"],
      del: ["adresse", "address"],
      ikke: ["epost", "email", "mail", "web", "url", "linje2", "line2", "adresse2", "address2"],
    },
    { id: "adresse2", navn: "Adresselinje 2", ord: ["adresselinje2", "adresse2", "addressline2", "address2", "co", "careof"], del: ["linje2", "line2"] },
    {
      id: "postnr",
      navn: "Postnr.",
      ord: ["postnr", "postnummer", "fakturapostnr", "fakturapostnummer", "postkode", "postalcode", "postcode", "zip", "zipcode", "postnrsted", "postnrogsted"],
      del: ["postnr", "postnummer", "zip", "postalcode", "postcode"],
    },
    { id: "poststed", navn: "Poststed", ord: ["poststed", "fakturapoststed", "sted", "by", "city", "town", "postalarea", "place"], del: ["poststed", "city"] },
    { id: "land", navn: "Land", ord: ["land", "landkode", "fakturaland", "country", "countrycode"], del: ["land", "country"], ikke: ["telefon", "phone", "tlf"] },
    { id: "type", navn: "Kundetype (firma/privat)", ord: ["kundetype", "type", "customertype", "kundekategori"] },
    {
      id: "deres_referanse",
      navn: "Kontaktperson (deres ref.)",
      ord: ["deresreferanse", "deresref", "referanse", "kontaktperson", "kontakt", "kontaktnavn", "yourreference", "reference", "contactperson", "contact",
        "contactname", "att", "attn", "attention"],
      del: ["referanse", "kontaktperson", "reference", "contactperson"],
      ikke: ["epost", "email", "mail", "telefon", "tlf", "phone", "mobil"],
    },
    {
      id: "notat",
      navn: "Notat",
      ord: ["notat", "notater", "merknad", "merknader", "kommentar", "kommentarer", "internmerknad", "note", "notes", "comment", "comments", "beskrivelse",
        "description", "info", "informasjon"],
      del: ["notat", "merknad", "kommentar", "note"],
    },
    {
      id: "kundenummer",
      navn: "Tidligere kundenr. (til notat)",
      ord: ["kundenummer", "kundenr", "kundeid", "customernumber", "customerno", "customerid", "kontaktnummer", "kontaktnr", "nummer", "nr", "id"],
      del: ["kundenummer", "kundenr", "customernumber", "customerno"],
    },
    ...FELLES,
  ],
  produkter: [
    {
      id: "navn",
      navn: "Navn",
      ord: ["navn", "produktnavn", "varenavn", "artikkelnavn", "tjenestenavn", "varebetegnelse", "betegnelse", "benevnelse", "name", "productname", "itemname",
        "produkt", "vare", "artikkel", "tjeneste", "product", "item", "tittel", "title"],
      del: ["navn", "name", "betegnelse"],
      ikke: ["kunde", "kategori", "gruppe", "leverandør", "supplier", "enhet", "unit", "fil", "bilde", "image"],
    },
    {
      id: "varenummer",
      navn: "Varenummer",
      ord: ["varenummer", "varenr", "produktnummer", "produktnr", "artikkelnummer", "artikkelnr", "artnr", "tjenestenummer", "produktkode", "varekode",
        "artikkelkode", "sku", "itemnumber", "itemno", "productnumber", "productno", "productcode", "itemcode", "produktid", "vareid", "productid", "itemid",
        "kode", "code", "nummer", "nr", "id"],
      del: ["varenummer", "varenr", "produktnummer", "produktnr", "artikkelnummer", "artikkelnr", "sku"],
      ikke: ["ean", "gtin", "strekkode", "barcode", "leverandør", "supplier", "konto", "account", "mva", "vat"],
    },
    {
      id: "beskrivelse",
      navn: "Beskrivelse",
      ord: ["beskrivelse", "produktbeskrivelse", "varebeskrivelse", "fakturatekst", "langtekst", "description", "tekst", "text", "detaljer", "details", "info"],
      del: ["beskrivelse", "description"],
    },
    {
      id: "enhet",
      navn: "Enhet",
      ord: ["enhet", "enhetstype", "salgsenhet", "måleenhet", "enhetsnavn", "unit", "unitofmeasure", "uom", "unitname"],
      del: ["enhet", "unit"],
      ikke: ["pris", "price", "antall", "quantity"],
    },
    {
      id: "enhetspris",
      navn: "Pris eks. mva",
      ord: ["priseksmva", "priseksklmva", "priseksklusivmva", "salgspriseksmva", "salgspriseksklmva", "utsalgspriseksmva", "salgspris", "utsalgspris",
        "enhetspris", "pris", "price", "unitprice", "salesprice", "priceexclvat", "priceexvat", "priceexcludingvat", "netprice", "nettopris", "listepris",
        "listprice", "timepris", "sats", "beløp", "amount"],
      del: ["pris", "price"],
      ikke: ["inkl", "incl", "inklusiv", "inclusive", "brutto", "gross", "kost", "innkjøp", "cost", "purchase", "valuta", "currency"],
    },
    {
      id: "pris_inkl",
      navn: "Pris inkl. mva",
      ord: ["prisinklmva", "prisinklusivmva", "salgsprisinklmva", "utsalgsprisinklmva", "priceinclvat", "priceincvat", "priceincludingvat", "grossprice",
        "bruttopris", "inklmva"],
      del: ["inkl", "incl", "brutto", "gross"],
      ikke: ["kost", "innkjøp", "cost", "purchase"],
    },
    {
      id: "mva_sats",
      navn: "Mva-sats",
      ord: ["mva", "mvasats", "mvaprosent", "mvakode", "mvatype", "mvagruppe", "salgsmva", "utgåendemva", "moms", "momssats", "vat", "vatrate", "vatcode",
        "vatpercent", "tax", "taxrate", "taxcode", "avgiftskode"],
      del: ["mva", "moms", "vat", "tax"],
      ikke: ["inkl", "incl", "beløp", "amount", "nummer", "number", "konto", "account"],
    },
    ...FELLES,
  ],
  ansatte: [
    {
      id: "navn",
      navn: "Navn (fornavn og etternavn)",
      ord: ["navn", "fulltnavn", "ansattnavn", "medarbeidernavn", "ansatt", "medarbeider", "arbeidstaker", "name", "fullname", "employeename", "employee"],
      del: ["navn", "name"],
      ikke: ["fornavn", "etternavn", "first", "last", "bruker", "user", "fil", "firma", "arbeidsgiver", "employer", "bank", "stilling", "leder", "tillegg", "pårørende"],
    },
    { id: "fornavn", navn: "Fornavn", ord: ["fornavn", "firstname", "givenname", "forename"], del: ["fornavn", "firstname"], ikke: ["pårørende", "leder"] },
    { id: "etternavn", navn: "Etternavn", ord: ["etternavn", "lastname", "surname", "familyname"], del: ["etternavn", "lastname", "surname"], ikke: ["pårørende", "leder"] },
    {
      id: "epost",
      navn: "E-post",
      ord: ["epost", "epostadresse", "jobbepost", "privatepost", "email", "emailaddress", "workemail", "mail", "mailadresse"],
      del: ["epost", "email", "mail"],
      ikke: ["pårørende", "leder", "kopi", "cc"],
    },
    {
      id: "telefon",
      navn: "Telefon",
      ord: ["telefon", "mobil", "mobilnummer", "mobilnr", "telefonnummer", "telefonnr", "tlf", "tlfnr", "mobiltelefon", "phone", "mobile", "mobilephone", "cellphone", "phonenumber"],
      del: ["telefon", "tlf", "mobil", "phone"],
      ikke: ["fax", "faks", "pårørende", "nærmeste", "kontaktperson"],
    },
    {
      id: "adresse",
      navn: "Adresse",
      ord: ["adresse", "postadresse", "gateadresse", "hjemmeadresse", "bostedsadresse", "adresselinje1", "adresse1", "address", "streetaddress", "street", "addressline1", "address1"],
      del: ["adresse", "address"],
      ikke: ["epost", "email", "mail", "web", "linje2", "line2", "adresse2", "address2", "arbeidsgiver", "firma", "pårørende"],
    },
    { id: "adresse2", navn: "Adresselinje 2", ord: ["adresselinje2", "adresse2", "addressline2", "address2", "co", "careof"], del: ["linje2", "line2"] },
    {
      id: "postnr",
      navn: "Postnr.",
      ord: ["postnr", "postnummer", "postkode", "postalcode", "postcode", "zip", "zipcode", "postnrsted", "postnrogsted"],
      del: ["postnr", "postnummer", "zip", "postalcode", "postcode"],
    },
    { id: "poststed", navn: "Poststed", ord: ["poststed", "sted", "by", "city", "town", "postalarea", "place"], del: ["poststed", "city"] },
    {
      id: "fodselsdato",
      navn: "Fødselsdato",
      ord: ["fødselsdato", "fodselsdato", "født", "fodt", "fdato", "birthdate", "dateofbirth", "dob", "birthday"],
      del: ["fødselsdato", "fodselsdato", "birth"],
    },
    {
      id: "fnr",
      navn: "Fødselsnummer",
      ord: ["fødselsnummer", "fodselsnummer", "personnummer", "fnr", "personnr", "fødselsnr", "fodselsnr", "dnummer", "personid", "identitetsnummer", "nationalidentitynumber",
        "nationalid", "ssn"],
      del: ["fødselsn", "fodselsn", "personn", "fnr"],
    },
    {
      id: "kontonr",
      navn: "Kontonummer for lønn",
      ord: ["kontonummer", "kontonr", "bankkonto", "bankkontonummer", "bankkontonr", "lønnskonto", "lonnskonto", "konto", "accountnumber", "bankaccount", "bankaccountnumber"],
      del: ["kontonr", "kontonummer", "bankkonto", "lønnskonto"],
    },
    {
      id: "stilling",
      navn: "Stilling",
      ord: ["stilling", "stillingstittel", "stillingsbetegnelse", "tittel", "jobbtittel", "yrke", "position", "jobtitle", "title", "role", "rolle"],
      del: ["stilling", "tittel", "title"],
      ikke: ["prosent", "pst", "prst", "andel", "kode", "percent", "type", "brøk"],
    },
    {
      id: "stillingsprosent",
      navn: "Stillingsprosent",
      ord: ["stillingsprosent", "stillingsandel", "stillingspst", "stillingsprst", "stillingsbrøk", "prosent", "andel", "percentage", "fte", "employmentpercentage"],
      del: ["stillingsprosent", "stillingsandel", "prosent", "percent"],
      ikke: ["tillegg", "ferie", "skatt", "pensjon", "mva"],
    },
    {
      id: "ukentlig_arbeidstid",
      navn: "Arbeidstid i full stilling (timer per uke)",
      ord: ["arbeidstid", "ukentligarbeidstid", "arbeidstidperuke", "timerperuke", "arbeidstimerperuke", "avtaltarbeidstid", "hoursperweek", "weeklyhours"],
      del: ["arbeidstid", "peruke", "weeklyhours"],
    },
    {
      id: "ansatt_fra",
      navn: "Ansatt fra",
      ord: ["ansattfra", "startdato", "ansattdato", "ansettelsesdato", "tiltredelse", "tiltredelsesdato", "tiltrådt", "førstearbeidsdag", "fradato", "fra", "startdate",
        "hiredate", "employmentdate", "datestarted"],
      del: ["ansattfra", "startdato", "ansettelsesdato", "tiltred", "startdate", "hiredate"],
      ikke: ["tillegg"],
    },
    {
      id: "ansatt_til",
      navn: "Sluttdato",
      ord: ["sluttdato", "ansatttil", "fratredelse", "fratredelsesdato", "fratrådt", "sistearbeidsdag", "tildato", "til", "enddate", "terminationdate", "dateleft"],
      del: ["sluttdato", "fratred", "enddate"],
      ikke: ["tillegg"],
    },
    {
      id: "ansettelsestype",
      navn: "Ansettelse (fast, midlertidig, tilkalling)",
      ord: ["ansettelsestype", "ansettelsesform", "ansettelse", "arbeidsforhold", "arbeidsforholdstype", "typeansettelse", "employmenttype", "contracttype"],
      del: ["ansettelsestype", "ansettelsesform", "arbeidsforhold", "employmenttype"],
      ikke: ["dato", "date", "fra", "til", "prosent", "id", "nummer"],
    },
    {
      id: "rolle",
      navn: "Rolle (f.eks. lege eller sekretær)",
      ord: ["rolle", "roller", "gruppe", "yrkesgruppe", "personalgruppe", "kategori", "role", "group"],
      del: ["rolle", "yrkesgruppe", "personalgruppe"],
    },
    {
      id: "lonnstype",
      navn: "Lønnstype (måned eller time)",
      ord: ["lønnstype", "lonnstype", "lønnsform", "lonnsform", "avlønning", "avlønningsform", "paytype", "salarytype", "wagetype"],
      del: ["lønnstype", "lonnstype", "lønnsform", "avlønning"],
    },
    {
      id: "maanedslonn",
      navn: "Månedslønn",
      ord: ["månedslønn", "manedslonn", "fastlønn", "fastlonn", "grunnlønn", "grunnlonn", "lønnpermåned", "monthlysalary", "basesalary", "salary", "lønn", "lonn"],
      del: ["månedslønn", "manedslonn", "fastlønn", "grunnlønn", "monthly"],
      ikke: ["årslønn", "arslonn", "annual", "yearly", "time", "hour", "konto", "type", "form", "tillegg"],
    },
    {
      id: "aarslonn",
      navn: "Årslønn (blir månedslønn)",
      ord: ["årslønn", "arslonn", "årslønn100", "lønnperår", "annualsalary", "yearlysalary"],
      del: ["årslønn", "arslonn", "annual", "yearly"],
    },
    {
      id: "timelonn",
      navn: "Timelønn",
      ord: ["timelønn", "timelonn", "timesats", "lønnpertime", "hourlyrate", "hourlywage", "hourlypay", "rate"],
      del: ["timelønn", "timelonn", "timesats", "hourly"],
      ikke: ["tillegg"],
    },
    {
      id: "ferie_dager",
      navn: "Feriedager per år",
      ord: ["feriedager", "antallferiedager", "ferierett", "ferie", "vacationdays", "holidaydays"],
      del: ["feriedag", "ferierett", "vacation"],
      ikke: ["penger", "pay", "prosent", "grunnlag"],
    },
    {
      id: "tillegg_belop",
      navn: "Fast tillegg (beløp)",
      ord: ["fasttillegg", "fastetillegg", "tillegg", "tilleggbeløp", "tilleggsbeløp", "lønnstillegg", "lonnstillegg", "funksjonstillegg", "ansiennitetstillegg", "fagbrevtillegg",
        "personligtillegg", "allowance", "fixedallowance", "supplement"],
      del: ["tillegg", "allowance"],
      ikke: ["navn", "name", "type", "per", "enhet", "tekst", "beskrivelse"],
    },
    {
      id: "tillegg_navn",
      navn: "Navn på tillegget",
      ord: ["tilleggsnavn", "tilleggnavn", "navnpåtillegg", "navnpatillegg", "tilleggstype", "typetillegg", "tilleggsbeskrivelse", "allowancename", "allowancetype"],
      del: ["tilleggsnavn", "tilleggstype", "allowancename"],
    },
    {
      id: "tillegg_per",
      navn: "Tillegget per (måned eller time)",
      ord: ["tilleggper", "tilleggsper", "tilleggperiode", "tilleggsenhet", "tilleggenhet", "allowanceper", "allowanceunit"],
      del: ["tilleggper", "tilleggsper", "tilleggsenhet"],
    },
    {
      id: "ansattnummer",
      navn: "Tidligere ansattnr. (til notat)",
      ord: ["ansattnummer", "ansattnr", "ansattid", "medarbeidernummer", "medarbeidernr", "lønnsnummer", "lonnsnummer", "employeenumber", "employeeno", "employeeid", "nummer",
        "nr", "id"],
      del: ["ansattn", "employeen", "employeeid"],
    },
    {
      id: "notat",
      navn: "Notat",
      ord: ["notat", "notater", "merknad", "merknader", "kommentar", "kommentarer", "note", "notes", "comment", "comments"],
      del: ["notat", "merknad", "kommentar", "note"],
    },
    ...FELLES,
  ],
};

export const normaliserOverskrift = (s: string) => s.toLowerCase().replace(/[^a-z0-9æøåäöü]/g, "");

// Hvor godt overskriften passer feltet (0 = ikke).
function poeng(h: string, f: Felt) {
  if (!h) return 0;
  const i = f.ord.indexOf(h);
  if (i >= 0) return 1000 - i;
  if (f.ikke?.some((x) => h.includes(x))) return 0;
  const d = f.del?.findIndex((x) => h.includes(x)) ?? -1;
  return d >= 0 ? 500 - d : 0;
}

// Kobler kolonner til felt ut fra overskriftene: beste treff først, ett felt per kolonne.
export function koble(type: Importtype, overskrifter: string[]): (string | null)[] {
  const felt = FELT[type];
  const kandidater: { k: number; f: string; p: number }[] = [];
  overskrifter.forEach((o, k) => {
    const h = normaliserOverskrift(o);
    for (const f of felt) {
      const p = poeng(h, f);
      if (p > 0) kandidater.push({ k, f: f.id, p });
    }
  });
  kandidater.sort((a, b) => b.p - a.p || a.k - b.k);
  const kobling: (string | null)[] = overskrifter.map(() => null);
  const brukt = new Set<string>();
  for (const { k, f } of kandidater) {
    if (kobling[k] || brukt.has(f)) continue;
    // Aktiv og inaktiv er samme felt sett fra hver sin side.
    if ((f === "aktiv" && brukt.has("inaktiv")) || (f === "inaktiv" && brukt.has("aktiv"))) continue;
    kobling[k] = f;
    brukt.add(f);
  }
  return kobling;
}

const erTallaktig = (s: string) => /^[-+]?[\d\s .,%]+$/.test(s.trim());

// Første rad er overskrifter når den ser slik ut: minst to kjente kolonnenavn (eller bare
// kjente navn), og ingen tall.
export function harOverskrifter(type: Importtype, rad: string[] | undefined): boolean {
  if (!rad) return false;
  const fylt = rad.map(rensCelle).filter(Boolean);
  if (!fylt.length || fylt.some(erTallaktig) || fylt.some((c) => c.includes("@"))) return false;
  const treff = koble(type, rad).filter(Boolean).length;
  return treff >= 2 || treff === fylt.length;
}

// Uten overskrifter: gjett ut fra innholdet (e-post, org.nr., postnr., tall …).
export function gjett(type: Importtype, rader: string[][]): (string | null)[] {
  const bredde = Math.max(0, ...rader.map((r) => r.length));
  const kobling: (string | null)[] = Array.from({ length: bredde }, () => null);
  const brukt = new Set<string>();
  const sett = (k: number, f: string) => {
    if (!kobling[k] && !brukt.has(f)) {
      kobling[k] = f;
      brukt.add(f);
    }
  };
  const verdier = (k: number) => rader.slice(0, 50).map((r) => rensCelle(r[k] ?? "")).filter(Boolean);
  const andel = (k: number, test: (v: string) => boolean) => {
    const v = verdier(k);
    return v.length ? v.filter(test).length / v.length : 0;
  };
  for (let k = 0; k < bredde; k++) {
    if (andel(k, (v) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) >= 0.6) sett(k, "epost");
    else if (type === "ansatte" && andel(k, (v) => fnrGyldig(v.replace(/[\s.]/g, ""))) >= 0.6) sett(k, "fnr");
    else if (type === "ansatte" && andel(k, (v) => kontonrGyldig(v.replace(/[\s.]/g, ""))) >= 0.6) sett(k, "kontonr");
    else if (type === "ansatte" && andel(k, (v) => /^\d{4}$/.test(v)) >= 0.6) sett(k, "postnr");
    else if (type === "ansatte" && andel(k, (v) => /^(\+?\d[\d\s]{7,14})$/.test(v)) >= 0.6) sett(k, "telefon");
    else if (type === "ansatte" && andel(k, (v) => tolkDato(v) !== null) >= 0.8) sett(k, brukt.has("fodselsdato") ? "ansatt_fra" : "fodselsdato");
    else if (type === "kunder" && andel(k, (v) => /^\d{9}$/.test(renOrgnr(v))) >= 0.6) sett(k, "orgnr");
    else if (type === "kunder" && andel(k, (v) => /^\d{4}$/.test(v)) >= 0.6) sett(k, "postnr");
    else if (type === "kunder" && andel(k, (v) => /^(\+?\d[\d\s]{7,14})$/.test(v)) >= 0.6) sett(k, "telefon");
    else if (type === "produkter" && andel(k, (v) => ["0", "12", "15", "25"].includes(v.replace(/[\s%]/g, ""))) >= 0.8 && brukt.has("enhetspris")) sett(k, "mva_sats");
    else if (type === "produkter" && andel(k, (v) => tolkTall(v, ",") !== null || tolkTall(v, ".") !== null) >= 0.8) sett(k, "enhetspris");
  }
  for (let k = 0; k < bredde; k++) if (!kobling[k] && andel(k, (v) => !erTallaktig(v)) >= 0.6) sett(k, "navn");
  return kobling;
}

// ---------------------------------------------------------------------------
// Verdier
// ---------------------------------------------------------------------------

// Tar bort mellomrom rundt og Excel-triks som ="0155".
export function rensCelle(s: string): string {
  const t = (s ?? "").replace(/^[\s  ]+|[\s  ]+$/g, "");
  const m = /^="(.*)"$/.exec(t);
  return m ? m[1]!.trim() : t;
}

export const renOrgnr = (s: string) => s.replace(/^NO/i, "").replace(/MVA$/i, "").replace(/[\s.\- ]/g, "");

// Tall som «1 234,50», «1.234,50», «1,234.50», «kr 950,-». `desimal` gjelder der tegnet
// er tvetydig (1.500 er 1500 med komma som desimaltegn, 1,5 med punktum).
export function tolkTall(s: string, desimal: "," | "."): number | null {
  let t = s.trim().replace(/[\s  ']/g, "");
  t = t.replace(/^(?:kr\.?|nok)/i, "").replace(/(?:kr\.?|nok|,-|\.-|,–)$/i, "");
  if (/^\(.*\)$/.test(t)) t = `-${t.slice(1, -1)}`;
  if (!/^[-+]?(?:\d|[.,]\d)[\d.,]*$/.test(t)) return null;
  const komma = t.lastIndexOf(",");
  const punktum = t.lastIndexOf(".");
  // Begge tegn: det siste er desimaltegnet.
  const d = komma >= 0 && punktum >= 0 ? (komma > punktum ? "," : ".") : desimal;
  const tusen = d === "," ? "." : ",";
  const deler = t.split(d);
  if (deler.length > 2) {
    // «1.234.567» med punktum som desimaltegn er tusenskille likevel.
    if (komma >= 0 && punktum >= 0) return null;
    const n = Number(t.split(d).join(""));
    return Number.isFinite(n) ? n : null;
  }
  const n = Number(deler[0]!.split(tusen).join("") + (deler.length === 2 ? `.${deler[1]}` : ""));
  return Number.isFinite(n) ? n : null;
}

// Desimaltegnet i en kolonne, ut fra verdiene som ikke er tvetydige.
export function desimaltegn(verdier: string[], kilde: Innlest["kilde"]): "," | "." {
  let komma = 0;
  let punktum = 0;
  for (const v0 of verdier) {
    const v = v0.replace(/[\s  ']/g, "");
    if (/,\d{1,2}(?:-|kr)?$/i.test(v) || /\d,\d{4,}$/.test(v)) komma++;
    else if (/\.\d{1,2}$/.test(v) || /\d\.\d{4,}$/.test(v)) punktum++;
  }
  if (komma !== punktum) return komma > punktum ? "," : ".";
  return kilde === "tekst" ? "," : ".";
}

const SATSER = [25, 15, 12, 0];
// Mva-sats fra prosent («25», «25 %», «0,25»), ord («høy», «fritatt») eller SAF-T-kode
// (3 = 25 %, 31 = 15 %, 33 = 12 %, 5/6 = 0 %). Ukjent: null.
export function tolkMva(s: string): number | null {
  const t = s.trim().toLowerCase();
  if (!t) return null;
  const prosent = /(\d+(?:[.,]\d+)?)\s*%/.exec(t);
  if (prosent) {
    const n = Number(prosent[1]!.replace(",", "."));
    return SATSER.includes(n) ? n : null;
  }
  if (/fritatt|unntatt|utenfor|ingen|null|exempt|zero|^fri$/.test(t)) return 0;
  if (/høy|hoy|high|standard|ordinær|alminnelig/.test(t)) return 25;
  if (/middels|medium|mat|food|næringsmidl/.test(t)) return 15;
  if (/lav|low|transport|kino|overnatting|hotell/.test(t)) return 12;
  const n = Number(t.replace(",", "."));
  if (!Number.isFinite(n)) return null;
  if (n > 0 && n < 1 && SATSER.includes(Math.round(n * 100))) return Math.round(n * 100);
  if (SATSER.includes(n)) return n;
  const kode: Record<string, number> = { "3": 25, "31": 15, "33": 12, "5": 0, "6": 0, "51": 0, "52": 0 };
  return kode[t] ?? null;
}

export function tolkJaNei(s: string): boolean | null {
  const t = s.trim().toLowerCase();
  if (["ja", "j", "yes", "y", "true", "sann", "1", "x", "aktiv", "active", "✓", "✔"].includes(t)) return true;
  if (["nei", "n", "no", "false", "usann", "0", "inaktiv", "inactive", "arkivert", "archived", "deaktivert", "slettet", "deleted", "sluttet", "avsluttet"].includes(t))
    return false;
  return null;
}

// Datoer som «31.12.2025», «31/12/2025», «2025-12-31», «31.12.85» eller et datotall fra Excel
// (dager siden 30.12.1899). To sifre i året: dette århundret til og med i år, ellers forrige.
export function tolkDato(s: string): string | null {
  const t = s.trim();
  if (!t) return null;
  if (/^\d{5}(?:\.\d+)?$/.test(t)) {
    const n = Math.floor(Number(t));
    return n >= 10000 && n <= 80000 ? new Date(Date.UTC(1899, 11, 30) + n * 86_400_000).toISOString().slice(0, 10) : null;
  }
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/.exec(t);
  const norsk = /^(\d{1,2})([./-])(\d{1,2})\2(\d{4}|\d{2})$/.exec(t);
  let aar: number;
  let mnd: number;
  let dag: number;
  if (iso) [aar, mnd, dag] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
  else if (norsk) {
    [dag, mnd, aar] = [Number(norsk[1]), Number(norsk[3]), Number(norsk[4])];
    if (norsk[4]!.length === 2) aar += aar <= new Date().getFullYear() % 100 ? 2000 : 1900;
    // Amerikansk rekkefølge (12/31/2025) når den norske ikke går.
    if (mnd > 12 && dag <= 12 && norsk[2] === "/") [dag, mnd] = [mnd, dag];
  } else return null;
  const d = new Date(Date.UTC(aar, mnd - 1, dag));
  if (d.getUTCFullYear() !== aar || d.getUTCMonth() !== mnd - 1 || d.getUTCDate() !== dag || aar < 1900) return null;
  return d.toISOString().slice(0, 10);
}

// Stillingsprosent: «80», «80 %», «80,5» eller en andel som 0,8 (Excel lagrer 80 % som 0.8).
export function tolkProsent(s: string, desimal: "," | "."): number | null {
  const n = tolkTall(s.replace(/%|prosent/gi, ""), desimal);
  if (n === null) return null;
  return n > 0 && n <= 1 ? Math.round(n * 10000) / 100 : n;
}

// Fornavn og etternavn fra hele navnet: «Etternavn, Fornavn», ellers er det siste ordet
// etternavnet («Ola Johan Hansen»).
export function delNavn(navn: string): [string, string] {
  const t = navn.trim().replace(/\s+/g, " ");
  const komma = t.indexOf(",");
  if (komma > 0) return [t.slice(komma + 1).trim(), t.slice(0, komma).trim()];
  const ord = t.split(" ");
  return ord.length < 2 ? [t, ""] : [ord.slice(0, -1).join(" "), ord.at(-1)!];
}

const tolkAnsettelse = (s: string) => {
  const t = s.trim().toLowerCase();
  if (/tilkall|ekstrahjelp|on.?call|ringevikar|timebasert/.test(t)) return "tilkalling";
  if (/midlertid|vikariat|vikar|engasjement|prosjekt|sesong|temporary|fixed.?term/.test(t)) return "midlertidig";
  if (/^fast|fast ansatt|permanent|ordinær/.test(t)) return "fast";
  return null;
};
// «Aksjonær», «Selvstendig» eller «Innleid» er ikke en ansettelse: om personen er ansatt, følger
// rollen (en rolle for dem som ikke er ansatt, under Ansatte → Roller).
const IKKE_ANSETTELSE = /aksjon|medeier|partner|shareholder|owner|selvstendig|næringsdriv|naeringsdriv|frilans|freelance|self.?employed|innleid|leid inn|bemanningsbyr|vikarbyr|contractor/;
const tolkLonnstype = (s: string) => {
  const t = s.trim().toLowerCase();
  if (/time|hour/.test(t)) return "time";
  if (/måned|maaned|maned|mnd|fast|month|salary|år/.test(t)) return "maaned";
  return null;
};
const tolkPer = (s: string) => {
  const t = s.trim().toLowerCase();
  if (/time|hour|^t$|\/t$/.test(t)) return "time";
  if (/måned|maaned|maned|mnd|month/.test(t)) return "maaned";
  return null;
};

const LAND: Record<string, string> = {
  norge: "NO", noreg: "NO", norway: "NO", nor: "NO", sverige: "SE", sweden: "SE", swe: "SE", danmark: "DK", denmark: "DK", dnk: "DK", finland: "FI",
  suomi: "FI", fin: "FI", island: "IS", iceland: "IS", tyskland: "DE", germany: "DE", deutschland: "DE", deu: "DE", storbritannia: "GB", england: "GB",
  skottland: "GB", unitedkingdom: "GB", greatbritain: "GB", uk: "GB", gbr: "GB", usa: "US", unitedstates: "US", unitedstatesofamerica: "US", nederland: "NL",
  netherlands: "NL", holland: "NL", belgia: "BE", belgium: "BE", frankrike: "FR", france: "FR", spania: "ES", spain: "ES", italia: "IT", italy: "IT",
  polen: "PL", poland: "PL", irland: "IE", ireland: "IE", sveits: "CH", switzerland: "CH", østerrike: "AT", austria: "AT", estland: "EE", estonia: "EE",
  latvia: "LV", litauen: "LT", lithuania: "LT", portugal: "PT", hellas: "GR", greece: "GR", kina: "CN", china: "CN", japan: "JP", canada: "CA",
  australia: "AU", færøyene: "FO", faroeislands: "FO", grønland: "GL", greenland: "GL",
};
export function landkode(s: string): string | null {
  const t = s.trim();
  if (!t) return null;
  const kode = LAND[t.toLowerCase().replace(/[^a-zæøå]/g, "")];
  if (kode) return kode;
  return /^[a-z]{2}$/i.test(t) ? t.toUpperCase() : null;
}

const ENHET: Record<string, string> = {
  pcs: "stk", pc: "stk", piece: "stk", pieces: "stk", each: "stk", ea: "stk", stykk: "stk", "stk.": "stk", st: "stk", unit: "stk", units: "stk",
  hour: "time", hours: "time", hrs: "time", hr: "time", h: "time", t: "time", timer: "time", "t.": "time", tim: "time",
  month: "mnd", months: "mnd", måned: "mnd", måneder: "mnd", "mnd.": "mnd", mån: "mnd",
  day: "dag", days: "dag", dager: "dag", week: "uke", weeks: "uke", uker: "uke", year: "år", years: "år",
};
const tilEnhet = (s: string) => ENHET[s.trim().toLowerCase()] ?? s.trim();

const FIRMAORD =
  /\b(as|asa|ans|da|enk|sa|ba|nuf|ks|iks|hf|sf|kf|ab|aps|gmbh|ltd|llc|inc|oy|bv|plc)\.?$|\b(kommune|fylkeskommune|borettslag|sameie|forening|stiftelse|menighet|idrettslag|barnehage|skole|universitet|sykehus|helseforetak|direktorat|departement)/i;

export interface Gjoremaal {
  kilde: Innlest["kilde"];
  mvaRegistrert: boolean;
  overskrifter?: string[]; // overskriftene i fila (navnet på et fast tillegg kan stå der)
}

// Gjør radene om til det API-et vil ha. Tomme celler tas ikke med (da gjelder
// standardverdien for nye, og det som står fra før for eksisterende). Verdier som ikke
// kan tolkes, sendes som de er, så API-et kan si hva som er feil.
export function tilRader(type: Importtype, rader: string[][], kobling: (string | null)[], valg: Gjoremaal): Record<string, unknown>[] {
  const kol = (f: string) => kobling.indexOf(f);
  const celle = (r: string[], f: string) => {
    const k = kol(f);
    return k < 0 ? "" : rensCelle(r[k] ?? "");
  };
  const tallformat = (f: string) => desimaltegn(rader.map((r) => celle(r, f)).filter(Boolean), valg.kilde);
  const prisDesimal = tallformat("enhetspris");
  const inklDesimal = tallformat("pris_inkl");
  const desimal = Object.fromEntries(
    ["stillingsprosent", "ukentlig_arbeidstid", "maanedslonn", "aarslonn", "timelonn", "ferie_dager", "tillegg_belop"].map((f) => [f, tallformat(f)]),
  );
  // Et fast tillegg i en kolonne som heter noe eget («Funksjonstillegg»): det blir navnet.
  const tilleggKolonne = valg.overskrifter?.[kol("tillegg_belop")] ? rensCelle(valg.overskrifter[kol("tillegg_belop")]!) : "";
  const tilleggNavn = /^(fast(e)?\s*)?tillegg(\s*\(?(kr|beløp|nok)\)?)?$/i.test(tilleggKolonne) ? "" : tilleggKolonne;

  return rader.map((r) => {
    const v = (f: string) => celle(r, f);
    const o: Record<string, unknown> = {};
    const notater: string[] = [];
    const settTekst = (f: string, verdi = v(f)) => {
      if (verdi) o[f] = verdi;
    };

    if (type === "kunder") {
      const fornavn = v("fornavn");
      const etternavn = v("etternavn");
      const person = [fornavn, etternavn].filter(Boolean).join(" ");
      const navn = v("navn") || person;
      o.navn = navn;
      const land = v("land");
      const kode = landkode(land);
      if (land) o.land = kode ?? land;

      // «-», «N/A» o.l. (ingen sifre) betyr at det ikke finnes noe org.nr.
      const org = v("orgnr");
      if (/\d/.test(org)) {
        const ren = renOrgnr(org);
        // Utenlandske organisasjonsnumre passer ikke i feltet; de havner i notatet.
        if (kode && kode !== "NO" && !/^\d{9}$/.test(ren)) notater.push(`Org.nr.: ${org}`);
        else o.orgnr = /^\d{9}$/.test(ren) ? ren : org;
      }

      // Bare det som ligner en adresse; «-» og «mangler» betyr ingen e-post.
      const epost = v("epost").replace(/^mailto:/i, "");
      if (epost.includes("@")) {
        const [forste, ...flere] = epost.split(/[\s,;]+/).filter(Boolean);
        o.epost = forste!.replace(/^<|>$/g, "");
        if (flere.length) notater.push(`Flere e-postadresser: ${flere.join(", ")}`);
      }
      settTekst("telefon");
      settTekst("adresse", [v("adresse"), v("adresse2")].filter(Boolean).join(", "));

      let postnr = v("postnr").replace(/^NO-/i, "");
      let poststed = v("poststed");
      const samlet = /^(\d{3,5})\s+(\D.*)$/.exec(postnr);
      if (samlet) {
        postnr = samlet[1]!;
        poststed ||= samlet[2]!;
      }
      if (/^\d{1,3}$/.test(postnr) && (!kode || kode === "NO")) postnr = postnr.padStart(4, "0");
      settTekst("postnr", postnr);
      settTekst("poststed", poststed);

      // Kundetype fra fila hvis den kan tolkes; ellers: org.nr. eller AS, kommune o.l. i
      // navnet er firma, navn satt sammen av fornavn og etternavn er en person.
      const t = v("type").toLowerCase();
      if (/privat|person|forbruker|individ|consumer|private/.test(t)) o.type = "person";
      else if (/firma|bedrift|foretak|organisasjon|selskap|company|business|corporate|offentlig/.test(t)) o.type = "firma";
      else if (o.orgnr || FIRMAORD.test(navn)) o.type = "firma";
      else if (!v("navn") && person) o.type = "person";

      // Firma med kontaktperson i egne kolonner: kontaktpersonen blir deres referanse.
      settTekst("deres_referanse", v("deres_referanse") || (v("navn") && person && person !== navn ? person : ""));
      const tidligere = v("kundenummer");
      if (tidligere) notater.unshift(`Kundenr. i tidligere system: ${tidligere}`);
      const notat = [v("notat"), ...notater].filter(Boolean).join("\n");
      if (notat) o.notat = notat;
    } else if (type === "ansatte") {
      let fornavn = v("fornavn");
      let etternavn = v("etternavn");
      if (v("navn") && (!fornavn || !etternavn)) {
        const [f, e] = delNavn(v("navn"));
        fornavn ||= f;
        etternavn ||= e;
      }
      o.fornavn = fornavn;
      o.etternavn = etternavn;
      const epost = v("epost").replace(/^mailto:/i, "");
      if (epost.includes("@")) {
        const [forste, ...flere] = epost.split(/[\s,;]+/).filter(Boolean);
        o.epost = forste!.replace(/^<|>$/g, "");
        if (flere.length) notater.push(`Flere e-postadresser: ${flere.join(", ")}`);
      }
      settTekst("telefon");
      settTekst("adresse", [v("adresse"), v("adresse2")].filter(Boolean).join(", "));
      let postnr = v("postnr").replace(/^NO-/i, "");
      let poststed = v("poststed");
      const samlet = /^(\d{3,4})\s+(\D.*)$/.exec(postnr);
      if (samlet) {
        postnr = samlet[1]!;
        poststed ||= samlet[2]!;
      }
      if (/^\d{1,3}$/.test(postnr)) postnr = postnr.padStart(4, "0");
      settTekst("postnr", postnr);
      settTekst("poststed", poststed);

      // Datoer som ikke kan tolkes, sendes som de er, så API-et sier fra.
      for (const f of ["fodselsdato", "ansatt_fra", "ansatt_til"]) if (v(f)) o[f] = tolkDato(v(f)) ?? v(f);
      // Fødselsnummer og kontonummer: bare sifrene (Excel mister nullen foran et fødselsnummer).
      const fnr = v("fnr").replace(/[\s.\-]/g, "");
      if (/\d/.test(fnr)) o.fnr = /^\d{10}$/.test(fnr) ? `0${fnr}` : fnr;
      const konto = v("kontonr").replace(/[\s.\-]/g, "");
      if (/\d/.test(konto)) o.kontonr = konto;
      settTekst("stilling");
      const tall = (f: string) => (v(f) ? (tolkTall(v(f), desimal[f]!) ?? v(f)) : undefined);
      if (v("stillingsprosent")) o.stillingsprosent = tolkProsent(v("stillingsprosent"), desimal.stillingsprosent!) ?? v("stillingsprosent");
      if (v("ukentlig_arbeidstid")) o.ukentlig_arbeidstid = tall("ukentlig_arbeidstid");
      // Rollen (f.eks. «Lege»): den som finnes med det navnet, eller en ny.
      settTekst("rolle");
      const ansettelse = v("ansettelsestype");
      if (ansettelse && !IKKE_ANSETTELSE.test(ansettelse.toLowerCase())) o.ansettelsestype = tolkAnsettelse(ansettelse) ?? ansettelse;
      if (v("ferie_dager")) o.ferie_dager = tall("ferie_dager");

      // Lønn: månedslønn (eller årslønn delt på tolv) eller timelønn. Lønnstypen følger av den
      // når den ikke står i fila.
      const maaned = tall("maanedslonn");
      const aar = tall("aarslonn");
      if (maaned !== undefined) o.maanedslonn = maaned;
      else if (typeof aar === "number") o.maanedslonn = Math.round((aar / 12) * 100) / 100;
      else if (aar !== undefined) o.maanedslonn = aar;
      if (v("timelonn")) o.timelonn = tall("timelonn");
      const lonnstype = v("lonnstype") ? tolkLonnstype(v("lonnstype")) : o.maanedslonn !== undefined ? "maaned" : o.timelonn !== undefined ? "time" : null;
      if (lonnstype) o.lonnstype = lonnstype;
      else if (v("lonnstype")) o.lonnstype = v("lonnstype");

      if (v("tillegg_belop"))
        o.tillegg = [{ navn: v("tillegg_navn") || tilleggNavn || "Fast tillegg", belop: tall("tillegg_belop"), per: tolkPer(v("tillegg_per")) ?? "maaned" }];
      const tidligere = v("ansattnummer");
      if (tidligere) notater.unshift(`Ansattnr. i tidligere system: ${tidligere}`);
      const notat = [v("notat"), ...notater].filter(Boolean).join("\n");
      if (notat) o.notat = notat;
    } else {
      const navn = v("navn");
      const beskrivelse = v("beskrivelse");
      // Uten navn brukes beskrivelsen som navn.
      o.navn = navn || beskrivelse;
      if (navn) settTekst("beskrivelse", beskrivelse);
      settTekst("varenummer");
      const enhet = v("enhet");
      if (enhet) o.enhet = tilEnhet(enhet);

      const mvaTekst = v("mva_sats");
      const mva = mvaTekst ? tolkMva(mvaTekst) : null;
      if (mvaTekst) o.mva_sats = mva ?? mvaTekst;

      const pris = v("enhetspris");
      const inkl = v("pris_inkl");
      if (pris) o.enhetspris = tolkTall(pris, prisDesimal) ?? pris;
      else if (inkl) {
        const n = tolkTall(inkl, inklDesimal);
        const sats = valg.mvaRegistrert ? (mva ?? 25) : 0;
        o.enhetspris = n === null ? inkl : Math.round((n / (1 + sats / 100)) * 100) / 100;
      }
    }

    // Aktiv/inaktiv: verdier som ikke kan tolkes (f.eks. en status som «Prospekt»), hoppes over.
    const aktiv = tolkJaNei(v("aktiv"));
    const inaktiv = tolkJaNei(v("inaktiv"));
    if (aktiv !== null) o.aktiv = aktiv;
    else if (inaktiv !== null) o.aktiv = !inaktiv;
    return o;
  });
}

// Mal med overskriftene appen kjenner igjen.
export function mal(type: Importtype): string {
  const rader =
    type === "kunder"
      ? [
          ["Navn", "Org.nr.", "E-post", "Telefon", "Adresse", "Postnr.", "Poststed", "Land", "Deres referanse", "Notat"],
          ["Eksempel Regnskap AS", "", "faktura@eksempel.no", "22 22 22 22", "Storgata 1", "0155", "Oslo", "NO", "Kari Nordmann", ""],
          ["Ola Nordmann", "", "ola@eksempel.no", "912 34 567", "Bakkeveien 2", "5003", "Bergen", "NO", "", ""],
        ]
      : type === "ansatte"
        ? [
            ["Fornavn", "Etternavn", "E-post", "Telefon", "Adresse", "Postnr.", "Poststed", "Fødselsnummer", "Fødselsdato", "Kontonummer", "Stilling", "Stillingsprosent",
              "Ansatt fra", "Ansettelse", "Månedslønn", "Timelønn", "Fast tillegg", "Navn på tillegg"],
            ["Kari", "Nordmann", "kari@eksempel.no", "912 34 567", "Storgata 1", "0155", "Oslo", "", "15.03.1990", "8601 11 17947", "Butikkmedarbeider", "80",
              "01.08.2024", "Fast", "38000", "", "1500", "Funksjonstillegg"],
            ["Ola", "Hansen", "ola@eksempel.no", "", "", "", "", "", "", "", "Lagermedarbeider", "", "01.09.2025", "Tilkalling", "", "210", "", ""],
          ]
        : [
            ["Varenummer", "Navn", "Beskrivelse", "Enhet", "Pris eks. mva", "Mva"],
            ["100", "Konsulenttime", "", "time", "1250,00", "25"],
            ["200", "Husleie", "Kontorlokale", "mnd", "14500,00", "0"],
          ];
  return "﻿" + rader.map((r) => r.map((c) => (/[;"\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(";")).join("\r\n") + "\r\n";
}
