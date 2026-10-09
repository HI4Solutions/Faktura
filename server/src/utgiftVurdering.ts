// Vurderingen av en utgift (0090_utgifter.sql): kontoen for hver linje (kategorien AI-en ga, eller
// kontoen leverandøren fikk sist for samme slags kjøp), fradraget for inngående mva, og om utgiften
// skal kostnadsføres, aktiveres som anleggsmiddel (varig driftsmiddel på minst 30 000 kr uten
// fradragsberettiget mva, skatteloven § 14-40) eller periodiseres (gjelder flere måneder og er over
// grensen i oppsettet). Bilagene regnes her: kostnaden, avgiften per sats med mva-kodene fra
// Skatteetatens standard mva-koder (1, 11, 12 og 13 for innenlands kjøp med fradrag; 86 og 87 for
// tjenester kjøpt fra utlandet, med og uten fradrag), og leverandørgjelden, banken, kontantene eller
// gjelden til den ansatte for det som skal betales.
import { KATEGORIER as ANLEGGSKATEGORIER, type Kategori, type Regnskapsrolle } from "./anlegg.js";

const rund = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const kr = (n: number) => n.toLocaleString("nb-NO", { minimumFractionDigits: 0, maximumFractionDigits: 2 }).replace(/[\u00a0\u202f]/g, " ");
const prosent = (n: number) => `${n.toLocaleString("nb-NO", { maximumFractionDigits: 2 })} %`;

// Grensen for å aktivere et driftsmiddel (skatteloven § 14-40: kostpris minst 30 000 kr og brukstid
// minst tre år).
export const AKTIVERINGSGRENSE = 30_000;

// Hva slags kostnad: kontoen (Skatteetatens standard kontoplan for SAF-T) og om mva-en gir fradrag.
export const KOSTNADSKATEGORIER = {
  varer: { navn: "Varer for videresalg", konto: "4300", fradrag: true },
  forbruk: { navn: "Forbruksmateriell og rekvisita (også medisinsk)", konto: "6560", fradrag: true },
  frakt: { navn: "Frakt og transport av varer", konto: "6100", fradrag: true },
  strom: { navn: "Strøm og oppvarming", konto: "6200", fradrag: true },
  husleie: { navn: "Husleie og leie av lokaler", konto: "6300", fradrag: true },
  renhold: { navn: "Renhold og vask", konto: "6360", fradrag: true },
  leie_utstyr: { navn: "Leie av maskiner og utstyr", konto: "6400", fradrag: true },
  programvare: { navn: "Programvare og nettjenester (abonnement)", konto: "6420", fradrag: true },
  inventar: { navn: "Inventar og møbler", konto: "6540", fradrag: true },
  datautstyr: { navn: "Datautstyr (PC, skjerm, telefon, tilbehør)", konto: "6551", fradrag: true },
  arbeidsklaer: { navn: "Arbeidsklær og verneutstyr", konto: "6571", fradrag: true },
  vedlikehold: { navn: "Reparasjon og vedlikehold", konto: "6620", fradrag: true },
  regnskap: { navn: "Regnskap og revisjon", konto: "6705", fradrag: true },
  juridisk: { navn: "Advokat og juridisk bistand", konto: "6725", fradrag: true },
  konsulent: { navn: "Konsulenter og andre tjenester", konto: "6790", fradrag: true },
  kontorrekvisita: { navn: "Kontorrekvisita", konto: "6800", fradrag: true },
  litteratur: { navn: "Aviser, tidsskrifter og bøker", konto: "6840", fradrag: true },
  kurs: { navn: "Kurs, konferanser og møter", konto: "6860", fradrag: true },
  telefon: { navn: "Telefon og mobil", konto: "6900", fradrag: true },
  internett: { navn: "Internett og datakommunikasjon", konto: "6907", fradrag: true },
  porto: { navn: "Porto", konto: "6940", fradrag: true },
  drivstoff: { navn: "Drivstoff og lading", konto: "7000", fradrag: true },
  bil: { navn: "Bil: vedlikehold, bompenger og parkering", konto: "7020", fradrag: true },
  reise: { navn: "Reise, hotell og transport", konto: "7140", fradrag: true },
  reklame: { navn: "Reklame og markedsføring", konto: "7320", fradrag: true },
  representasjon: { navn: "Representasjon (mat og drikke for kunder og ansatte)", konto: "7350", fradrag: false },
  kontingent: { navn: "Kontingenter og medlemskap", konto: "7400", fradrag: true },
  gave: { navn: "Gaver", konto: "7420", fradrag: false },
  forsikring: { navn: "Forsikring", konto: "7500", fradrag: true },
  bankgebyr: { navn: "Bank- og kortgebyrer", konto: "7770", fradrag: true },
  annet: { navn: "Annen kostnad", konto: "7790", fradrag: true },
} as const satisfies Record<string, { navn: string; konto: string; fradrag: boolean }>;
export type Kostnadskategori = keyof typeof KOSTNADSKATEGORIER;
export const KOSTNADSKODER = Object.keys(KOSTNADSKATEGORIER) as [Kostnadskategori, ...Kostnadskategori[]];

// Satsen gir kontoen for den inngående avgiften og koden: høy (25 %), middels (15 %), råfisk
// (11,11 %) og lav (12 %).
export function innSats(sats: number): { rolle: Regnskapsrolle; kode: string } {
  if (sats >= 20) return { rolle: "inngaende_mva", kode: "1" };
  if (sats >= 13) return { rolle: "inngaende_mva_middels", kode: "11" };
  if (Math.abs(sats - 11.11) < 0.005) return { rolle: "inngaende_mva_rafisk", kode: "12" };
  return { rolle: "inngaende_mva_lav", kode: "13" };
}
// Avgiften for tjenester kjøpt fra utlandet (snudd avregning, merverdiavgiftsloven § 3-30): høy sats.
export const UTLANDSSATS = 25;

export type Utgiftslinje = { beskrivelse: string | null; kategori: string | null; konto: string; belop: number; mva_sats: number; mva: number; fradrag: number };
export type Betaling = "ubetalt" | "bank" | "kontant" | "ansatt";
export type Utgiftsgrunnlag = {
  type: "faktura" | "kvittering";
  leverandor: string | null;
  fakturanummer: string | null;
  dato: string;
  belop: number;
  betaling: Betaling;
  utland: boolean;
  beskrivelse: string | null;
  linjer: Utgiftslinje[];
};
export type Utgiftspostering = { konto: string; belop: number; tekst: string; mva_kode: string | null };

// Kontoen for det som skal betales.
export function betalingskonto(b: Betaling, k: Record<Regnskapsrolle, string>) {
  return b === "ubetalt" ? k.leverandorgjeld : b === "bank" ? k.bank : b === "kontant" ? k.kontanter : k.gjeld_ansatte;
}

// Beløpet utgiften skal være på etter linjene: med mva, eller uten for tjenester fra utlandet (der
// avgiften ikke er på fakturaen).
export function sumLinjer(u: Pick<Utgiftsgrunnlag, "utland" | "linjer">) {
  return rund(u.linjer.reduce((s, l) => s + l.belop + (u.utland ? 0 : l.mva), 0));
}

// Hver linje: det som blir kostnad (beløpet og avgiften som ikke trekkes fra), avgiften som trekkes
// fra (og den som beregnes for tjenester fra utlandet), og mva-koden.
export function linjeposter(l: Pick<Utgiftslinje, "belop" | "mva_sats" | "mva" | "fradrag">, utland: boolean) {
  const sats = utland ? UTLANDSSATS : Number(l.mva_sats);
  const mva = utland ? rund((l.belop * UTLANDSSATS) / 100) : rund(l.mva);
  const fradrag = rund((mva * Number(l.fradrag)) / 100);
  const kode = utland ? (fradrag !== 0 ? "86" : "87") : fradrag !== 0 ? innSats(sats).kode : null;
  return { sats, mva, fradrag, kostnad: rund(l.belop + mva - fradrag), kode };
}

// Avgiften som trekkes fra og (for tjenester fra utlandet) beregnes, per konto og kode.
function mvaPosteringer(u: Utgiftsgrunnlag, k: Record<Regnskapsrolle, string>): Utgiftspostering[] {
  const p: Utgiftspostering[] = [];
  for (const l of u.linjer) {
    const x = linjeposter(l, u.utland);
    if (u.utland) {
      if (x.fradrag !== 0) p.push({ konto: k.inngaende_mva_utland, belop: x.fradrag, tekst: `Inngående mva ${prosent(x.sats)}, tjenester fra utlandet`, mva_kode: x.kode });
      if (x.mva !== 0) p.push({ konto: k.utgaende_mva_utland, belop: -x.mva, tekst: `Beregnet mva ${prosent(x.sats)}, tjenester fra utlandet`, mva_kode: x.kode });
    } else if (x.fradrag !== 0) {
      p.push({ konto: k[innSats(x.sats).rolle], belop: x.fradrag, tekst: `Inngående mva ${prosent(x.sats)}`, mva_kode: x.kode });
    }
  }
  return p;
}

// Linjene samlet per konto, kode og tekst (summene til øret), uten de som blir 0.
function samle(linjer: Utgiftspostering[]): Utgiftspostering[] {
  const per = new Map<string, Utgiftspostering>();
  for (const l of linjer) {
    const n = `${l.konto}|${l.mva_kode ?? ""}|${l.tekst}`;
    const x = per.get(n);
    if (x) x.belop = rund(x.belop + l.belop);
    else per.set(n, { ...l, belop: rund(l.belop) });
  }
  return [...per.values()].filter((l) => l.belop !== 0);
}

export const utgiftstekst = (u: Pick<Utgiftsgrunnlag, "type" | "leverandor" | "fakturanummer" | "beskrivelse">) =>
  (u.type === "kvittering"
    ? `Kvittering ${u.leverandor ?? ""}`
    : `Faktura${u.fakturanummer ? ` ${u.fakturanummer}` : ""} ${u.leverandor ?? ""}`
  )
    .replace(/\s+/g, " ")
    .trim() || "Utgift";

// Bilaget for en utgift som kostnad: kostnaden per linje, avgiften, og det som skal betales.
export function kostnadsbilag(u: Utgiftsgrunnlag, k: Record<Regnskapsrolle, string>) {
  const tekst = utgiftstekst(u);
  const navn = u.leverandor ?? tekst;
  const kostnader = u.linjer.map((l) => {
    const x = linjeposter(l, u.utland);
    return { konto: l.konto, belop: x.kostnad, tekst: (l.beskrivelse ?? u.beskrivelse ?? navn).slice(0, 200), mva_kode: x.kode };
  });
  return {
    tekst,
    posteringer: samle([...kostnader, ...mvaPosteringer(u, k), { konto: betalingskonto(u.betaling, k), belop: -u.belop, tekst: navn, mva_kode: null }]),
  };
}

// Det som blir kostpris (anleggsmiddel) eller beløpet som periodiseres: linjene med avgiften som
// ikke trekkes fra.
export function kostpris(u: Pick<Utgiftsgrunnlag, "utland" | "linjer">) {
  return rund(u.linjer.reduce((s, l) => s + linjeposter(l, u.utland).kostnad, 0));
}

// Bilaget for en utgift som anleggsmiddel (anskaffelsen) eller periodisering (starten): hele
// kostprisen på balansekontoen, avgiften, og det som skal betales.
export function balansebilag(u: Utgiftsgrunnlag, balansekonto: string, tekst: string, k: Record<Regnskapsrolle, string>) {
  return samle([
    { konto: balansekonto, belop: kostpris(u), tekst, mva_kode: null },
    ...mvaPosteringer(u, k),
    { konto: betalingskonto(u.betaling, k), belop: -u.belop, tekst: u.leverandor ?? tekst, mva_kode: null },
  ]);
}

// Bilaget for betalingen av leverandørgjelden.
export function betalingsbilag(u: Pick<Utgiftsgrunnlag, "type" | "leverandor" | "fakturanummer" | "beskrivelse" | "belop">, fra: "bank" | "kontant", k: Record<Regnskapsrolle, string>) {
  const tekst = `Betalt: ${utgiftstekst(u)}`;
  return {
    tekst,
    posteringer: [
      { konto: k.leverandorgjeld, belop: u.belop, tekst: u.leverandor ?? tekst },
      { konto: fra === "bank" ? k.bank : k.kontanter, belop: -u.belop, tekst },
    ],
  };
}

// --- Vurderingen ---------------------------------------------------------------------------------

export type AiTolkning = {
  varig: boolean;
  anlegg_kategori: Kategori | null;
  periode_fra: string | null;
  periode_til: string | null;
};
export type Vurdering = {
  behandling: "kostnad" | "anlegg" | "periodisering";
  vurdering: string;
  anlegg_kategori: Kategori | null;
  levetid_mnd: number | null;
  periode_fra: string | null; // ÅÅÅÅ-MM-01
  antall_maaneder: number | null;
};

const maanedNr = (d: string) => Number(d.slice(0, 4)) * 12 + Number(d.slice(5, 7)) - 1;
const maanedTekst = (d: string) => new Date(`${d.slice(0, 7)}-15T12:00:00Z`).toLocaleDateString("nb-NO", { month: "long", year: "numeric", timeZone: "UTC" });

// Hvordan utgiften skal føres. grense: beløpet (uten fradragsberettiget mva) en utgift over flere
// måneder periodiseres fra.
export function vurder(u: Pick<Utgiftsgrunnlag, "utland" | "linjer" | "dato">, ai: AiTolkning, grense: number): Vurdering {
  const pris = kostpris(u);
  const ingen = { anlegg_kategori: null, levetid_mnd: null, periode_fra: null, antall_maaneder: null };
  if (ai.varig && pris >= AKTIVERINGSGRENSE) {
    const kategori: Kategori = ai.anlegg_kategori && ai.anlegg_kategori in ANLEGGSKATEGORIER && ai.anlegg_kategori !== "goodwill" && ai.anlegg_kategori !== "tomt" ? ai.anlegg_kategori : "annet";
    const kat = ANLEGGSKATEGORIER[kategori];
    const levetid = kat.levetid ?? 60;
    return {
      behandling: "anlegg",
      vurdering: `Et varig driftsmiddel til ${kr(pris)} kr (uten mva som trekkes fra), over ${kr(AKTIVERINGSGRENSE)} kr: aktiveres som anleggsmiddel (${kat.navn.charAt(0).toLowerCase()}${kat.navn.slice(1)}) og avskrives over ${levetid / 12 >= 1 && levetid % 12 === 0 ? `${levetid / 12} år` : `${levetid} måneder`}.`,
      anlegg_kategori: kategori,
      levetid_mnd: levetid,
      periode_fra: null,
      antall_maaneder: null,
    };
  }
  const fra = ai.periode_fra && /^\d{4}-\d{2}-\d{2}$/.test(ai.periode_fra) ? ai.periode_fra : null;
  const til = ai.periode_til && /^\d{4}-\d{2}-\d{2}$/.test(ai.periode_til) ? ai.periode_til : null;
  const maaneder = fra && til && til >= fra ? maanedNr(til) - maanedNr(fra) + 1 : 0;
  // En periode som går ut over måneden utgiften er i, og er på flere måneder.
  const flere = maaneder >= 2 && maaneder <= 120 && !!til && maanedNr(til) > maanedNr(u.dato);
  if (flere && pris >= grense) {
    return {
      behandling: "periodisering",
      vurdering: `Gjelder ${maanedTekst(fra!)} til ${maanedTekst(til!)} (${maaneder} måneder) og er på ${kr(pris)} kr: kostnaden fordeles på månedene (forskuddsbetalt kostnad).`,
      anlegg_kategori: null,
      levetid_mnd: null,
      periode_fra: `${fra!.slice(0, 7)}-01`,
      antall_maaneder: maaneder,
    };
  }
  const grunner = [`Kostnad i ${maanedTekst(u.dato)}.`];
  if (ai.varig) grunner.push(`Varig, men under ${kr(AKTIVERINGSGRENSE)} kr: kostnadsføres med en gang.`);
  if (flere) grunner.push(`Gjelder ${maaneder} måneder, men er under ${kr(grense)} kr: kostnadsføres med en gang.`);
  return { behandling: "kostnad", vurdering: grunner.join(" "), ...ingen };
}

// Fradraget for en linje: ingen for representasjon og gaver, ellers prosenten i oppsettet.
export function fradragFor(kategori: string | null, standard: number) {
  const k = kategori && kategori in KOSTNADSKATEGORIER ? KOSTNADSKATEGORIER[kategori as Kostnadskategori] : null;
  return k && !k.fradrag ? 0 : standard;
}

// Merknader om fradraget som er verdt å sjekke.
export function fradragsmerknader(linjer: Pick<Utgiftslinje, "kategori" | "mva" | "fradrag">[]) {
  const m: string[] = [];
  if (linjer.some((l) => (l.kategori === "drivstoff" || l.kategori === "bil") && l.fradrag > 0 && l.mva !== 0))
    m.push("Mva på personbil (kjøp, leie og drift) gir ikke fradrag. Sett fradraget til 0 hvis det er en personbil.");
  if (linjer.some((l) => l.kategori === "representasjon"))
    m.push("Representasjon: ikke fradrag for mva.");
  return m;
}
