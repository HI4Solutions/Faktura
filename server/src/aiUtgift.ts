// Leverandørfakturaer og kvitteringer leses med AI (utgifter.ts): Gemini henter ut leverandøren,
// fakturanummeret, datoene, KID og kontonummeret, beløpet, linjene per mva-sats med hva slags
// kostnad det er, om det er et varig driftsmiddel, perioden kostnaden gjelder, og om det er
// tjenester kjøpt fra utlandet uten norsk mva. Det som ikke stemmer (organisasjonsnummer og
// kontonummer med feil kontrollsiffer, datoer som ikke finnes), tas ut og sies fra om; kontoen,
// fradraget og behandlingen bestemmes etterpå av reglene (utgiftVurdering.ts).
import { enLinje, iDagOslo, type Del, type Skjema } from "./ai.js";
import { KATEGORIER as ANLEGGSKATEGORIER, KATEGORIKODER, type Kategori } from "./anlegg.js";
import { kontonrGyldig, orgnrGyldig } from "./regler.js";
import { KOSTNADSKATEGORIER, KOSTNADSKODER, type Kostnadskategori } from "./utgiftVurdering.js";

// Filene Gemini kan lese, og hvor store de kan være.
export const UTGIFTSTYPER: Record<string, string> = {
  "application/pdf": "application/pdf",
  "image/jpeg": "image/jpeg",
  "image/jpg": "image/jpeg",
  "image/png": "image/png",
  "image/webp": "image/webp",
  "image/heic": "image/heic",
  "image/heif": "image/heif",
};
export const MAKS_UTGIFT = 12_000_000;

type AiLinje = { beskrivelse: string | null; kategori: string | null; belop: number | null; mva_sats: number | null; mva: number | null };
export type AiUtgift = {
  type: string | null;
  leverandor: string | null;
  orgnr: string | null;
  fakturanummer: string | null;
  dato: string | null;
  forfallsdato: string | null;
  kid: string | null;
  kontonr: string | null;
  valuta: string | null;
  belop: number | null;
  mva: number | null;
  utland: boolean | null;
  linjer: AiLinje[];
  varig: boolean | null;
  anlegg_kategori: string | null;
  periode_fra: string | null;
  periode_til: string | null;
  merknader: string[];
};

const tekst = (beskrivelse: string): Skjema => ({ type: "STRING", nullable: true, description: beskrivelse });
const tall = (beskrivelse: string): Skjema => ({ type: "NUMBER", nullable: true, description: beskrivelse });
const ANLEGG = KATEGORIKODER.filter((k) => k !== "goodwill" && k !== "tomt");

export const utgiftSkjema: Skjema = {
  type: "OBJECT",
  properties: {
    type: {
      type: "STRING",
      nullable: true,
      enum: ["faktura", "kvittering"],
      description: "faktura for en leverandørfaktura som skal betales (forfallsdato, kontonummer eller KID), kvittering for et kjøp som er betalt",
    },
    leverandor: tekst("Navnet på selgeren eller leverandøren (firmanavnet), ikke kjøperen"),
    orgnr: tekst("Leverandørens organisasjonsnummer, 9 siffer (står ofte med MVA etter)"),
    fakturanummer: tekst("Fakturanummeret eller kvitteringsnummeret"),
    dato: tekst("Fakturadatoen eller kjøpsdatoen (ÅÅÅÅ-MM-DD)"),
    forfallsdato: tekst("Forfallsdatoen (ÅÅÅÅ-MM-DD)"),
    kid: tekst("KID-nummeret, bare sifrene"),
    kontonr: tekst("Kontonummeret det skal betales til, 11 siffer uten punktum"),
    valuta: tekst("Valutaen, tre bokstaver (NOK, EUR, USD …)"),
    belop: tall("Det som skal betales eller er betalt, med mva"),
    mva: tall("Merverdiavgiften til sammen"),
    utland: {
      type: "BOOLEAN",
      nullable: true,
      description: "true når leverandøren holder til i utlandet og fakturaen er uten norsk mva (f.eks. programvare, nettjenester eller annonser, ofte med «reverse charge»)",
    },
    linjer: {
      type: "ARRAY",
      description: "Kostnadene uten mva, én linje per mva-sats og slags kjøp (slå sammen like linjer), høyst 10",
      items: {
        type: "OBJECT",
        properties: {
          beskrivelse: tekst("Kort hva det er (høyst noen få ord)"),
          kategori: {
            type: "STRING",
            nullable: true,
            enum: KOSTNADSKODER,
            description: `Hva slags kostnad: ${KOSTNADSKODER.map((k) => `${k} (${KOSTNADSKATEGORIER[k].navn})`).join(", ")}`,
          },
          belop: tall("Beløpet uten mva"),
          mva_sats: tall("Mva-satsen i prosent: 25, 15, 12, 11.11 eller 0"),
          mva: tall("Merverdiavgiften for linja"),
        },
        required: ["beskrivelse", "kategori", "belop", "mva_sats", "mva"],
        propertyOrdering: ["beskrivelse", "kategori", "belop", "mva_sats", "mva"],
      },
    },
    varig: {
      type: "BOOLEAN",
      nullable: true,
      description: "true når det er et driftsmiddel som skal brukes i virksomheten i minst tre år (maskin, inventar, PC, bil, medisinsk utstyr), ikke forbruksvarer eller tjenester",
    },
    anlegg_kategori: {
      type: "STRING",
      nullable: true,
      enum: ANLEGG,
      description: `Når varig: hva slags driftsmiddel: ${ANLEGG.map((k) => `${k} (${ANLEGGSKATEGORIER[k].navn})`).join(", ")}`,
    },
    periode_fra: tekst("Når kostnaden gjelder en periode (forsikring, leie, abonnement, lisens): den første dagen (ÅÅÅÅ-MM-DD)"),
    periode_til: tekst("Den siste dagen i perioden (ÅÅÅÅ-MM-DD)"),
    merknader: { type: "ARRAY", items: { type: "STRING" }, description: "Korte setninger på norsk om det som var uklart eller uleselig" },
  },
  required: ["type", "leverandor", "dato", "belop", "linjer", "merknader"],
  propertyOrdering: [
    "type", "leverandor", "orgnr", "fakturanummer", "dato", "forfallsdato", "kid", "kontonr", "valuta", "belop", "mva", "utland", "linjer",
    "varig", "anlegg_kategori", "periode_fra", "periode_til", "merknader",
  ],
};

export function utgiftSystem(kjoper: string, naa = new Date()): string {
  const { dato } = iDagOslo(naa);
  return [
    `Du leser leverandørfakturaer og kvitteringer (PDF eller bilde) for ${kjoper} og henter ut opplysningene til regnskapet. Svar bare med JSON etter skjemaet.`,
    `Dagens dato er ${dato}.`,
    "",
    "Regler:",
    `- Leverandøren er den som selger og sender fakturaen, ikke kjøperen (${kjoper}).`,
    "- Skriv bare det som står. Det som ikke står: null. Aldri gjett.",
    "- Datoer som ÅÅÅÅ-MM-DD. Beløp som tall i fakturaens valuta, uten tusenskille (1234.5). Organisasjonsnummer, kontonummer og KID: bare sifrene.",
    "- linjer: kostnadene uten mva, slått sammen per mva-sats og slags kjøp. Beløpene på linjene med mva skal til sammen være det som skal betales (er det rabatt eller øreavrunding, ta den med på linjene). Er det ikke norsk mva på fakturaen, er mva 0.",
    "- kategori: den som passer best for hver linje. Mat og drikke til møter, kunder eller ansatte er representasjon.",
    "- varig og anlegg_kategori: bare for ting som skal brukes i virksomheten i minst tre år.",
    "- periode_fra og periode_til: bare når fakturaen sier hvilken periode den gjelder (f.eks. «forsikring 01.01.2026–31.12.2026» eller «abonnement oktober–desember»).",
    "- merknader: korte setninger om det som var uklart eller uleselig. Tom liste når alt er klart.",
  ].join("\n");
}

export const utgiftForesporsel = (fil: { mimeType: string; data: string }, kjoper: string, naa = new Date()): { system: string; deler: Del[]; skjema: Skjema } => ({
  system: utgiftSystem(kjoper, naa),
  deler: [{ text: "Hent ut opplysningene fra fakturaen eller kvitteringen." }, { inlineData: fil }],
  skjema: utgiftSkjema,
});

const iso = (v: unknown) => {
  const s = enLinje(v, 20);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T12:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s ? null : s;
};
const belop = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && Math.abs(v) < 1e11 ? Math.round(v * 100) / 100 : null);
const siffer = (v: unknown) => String(v ?? "").replace(/\D/g, "");
const SATSER = [25, 15, 12, 11.11, 0];

export type LestUtgift = {
  type: "faktura" | "kvittering";
  leverandor: string | null;
  orgnr: string | null;
  fakturanummer: string | null;
  dato: string | null;
  forfallsdato: string | null;
  kid: string | null;
  kontonr: string | null;
  valuta: string;
  belop: number | null;
  utland: boolean;
  linjer: { beskrivelse: string | null; kategori: Kostnadskategori; belop: number; mva_sats: number; mva: number }[];
  varig: boolean;
  anlegg_kategori: Kategori | null;
  periode_fra: string | null;
  periode_til: string | null;
  merknader: string[];
};

// Svaret fra modellen, kontrollert: det som ikke stemmer, tas ut og sies fra om.
export function tilUtgift(a: AiUtgift, iDag: string): LestUtgift {
  const merknader = (Array.isArray(a?.merknader) ? a.merknader : []).map((m) => enLinje(m, 300)).filter(Boolean).slice(0, 10);
  const orgnr = siffer(a?.orgnr);
  if (orgnr && !orgnrGyldig(orgnr)) merknader.push("Organisasjonsnummeret til leverandøren stemmer ikke (kontrollsifferet), og er ikke tatt med.");
  const kontonr = siffer(a?.kontonr);
  if (kontonr && !kontonrGyldig(kontonr)) merknader.push("Kontonummeret stemmer ikke (kontrollsifferet), og er ikke tatt med.");
  const kid = siffer(a?.kid);
  let dato = iso(a?.dato);
  if (dato && dato > iDag) {
    merknader.push("Datoen er fram i tid, og er ikke tatt med.");
    dato = null;
  }
  const valuta = /^[A-Z]{3}$/.test(enLinje(a?.valuta, 3).toUpperCase()) ? enLinje(a?.valuta, 3).toUpperCase() : "NOK";
  const utland = a?.utland === true;
  const linjer = (Array.isArray(a?.linjer) ? a.linjer : [])
    .map((l) => {
      const b = belop(l?.belop);
      if (b === null || b === 0) return null;
      const raa = typeof l?.mva_sats === "number" ? l.mva_sats : 0;
      const sats = utland ? 0 : (SATSER.find((s) => Math.abs(s - raa) < 0.06) ?? 0);
      const mva = sats === 0 ? 0 : (belop(l?.mva) ?? Math.round(b * sats) / 100);
      const kategori = (KOSTNADSKODER as string[]).includes(String(l?.kategori)) ? (l!.kategori as Kostnadskategori) : "annet";
      return { beskrivelse: enLinje(l?.beskrivelse, 200) || null, kategori, belop: b, mva_sats: sats, mva };
    })
    .filter((l): l is NonNullable<typeof l> => l !== null)
    .slice(0, 20);
  const total = belop(a?.belop);
  const anleggKategori = (KATEGORIKODER as string[]).includes(String(a?.anlegg_kategori)) ? (a.anlegg_kategori as Kategori) : null;
  return {
    type: a?.type === "kvittering" ? "kvittering" : "faktura",
    leverandor: enLinje(a?.leverandor, 200) || null,
    orgnr: orgnr && orgnrGyldig(orgnr) ? orgnr : null,
    fakturanummer: enLinje(a?.fakturanummer, 60) || null,
    dato,
    forfallsdato: iso(a?.forfallsdato),
    kid: kid.length >= 2 && kid.length <= 25 ? kid : null,
    kontonr: kontonr && kontonrGyldig(kontonr) ? kontonr : null,
    valuta,
    belop: total !== null && total > 0 ? total : null,
    utland,
    linjer,
    varig: a?.varig === true,
    anlegg_kategori: anleggKategori,
    periode_fra: iso(a?.periode_fra),
    periode_til: iso(a?.periode_til),
    merknader: [...new Set(merknader)],
  };
}
