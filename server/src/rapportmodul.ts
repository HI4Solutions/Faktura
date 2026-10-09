// Felles rapportmodul (0070_rapportmodul.sql, siden «Rapporter»): rapportene fra alle modulene
// (Faktura, Personal, Lønn og de som kommer) på ett sted, med samme visning, eksport (CSV og PDF)
// og utsending på e-post til regnskapsføreren.
//
// Hver modul melder inn sine rapporter (Rapportdef): navnet, hvilken funksjon og hvilken tilgang
// de krever, hvilke valg de har (periode, termin, år eller ingen), og en funksjon som gir
// kolonnene og radene. Nye moduler legger rapportene sine i RAPPORTER under (se CLAUDE.md).
//
// Utsending: eier og administrator sender valgte rapporter (CSV og PDF som vedlegg), og kan la
// lønnsrapportene gå av seg selv når en lønnskjøring godkjennes, og månedsrapporter den 1. i
// måneden. Workeren lager rapportene og sender e-posten.
import { Hono, type Context } from "hono";
import { z } from "zod";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { alle, en, somBruker, somSystem, type Db } from "./db.js";
import { ApiFeil } from "./feil.js";
import { krevMfa } from "./auth.js";
import { rensTekst } from "./pdf.js";
import { csv } from "./rapporter.js";
import { epost, leggIKo, type Oppgave } from "./tjenester.js";
import { fakturaRapporter } from "./rapporter.js";
import { personalRapporter } from "./personalRapporter.js";
import { lonnRapporter } from "./lonnRapporter.js";

// --- Typene ---------------------------------------------------------------------------------------

export type Modul = "faktura" | "personal" | "lonn";
export const MODULER: { id: Modul; navn: string }[] = [
  { id: "faktura", navn: "Faktura" },
  { id: "personal", navn: "Personal" },
  { id: "lonn", navn: "Lønn" },
];

// Valgene en rapport har: en periode (fra–til), en mva-/avgiftstermin, et år, eller ingen (status nå).
export type Parameter = "periode" | "termin" | "aar" | "ingen";
export type Valg = { fra: string; til: string; aar: number; termin: number; kjoring: string | null };
export type Kolonnetype = "tekst" | "tall" | "kr" | "timer" | "dato" | "prosent" | "antall";
// sum: summeres nederst. pdf: false: bare i tabellen og CSV-en (for å få plass i PDF-en).
export type Kolonne = { nokkel: string; navn: string; type?: Kolonnetype; sum?: boolean; pdf?: false };
export type Rapportdata = { kolonner: Kolonne[]; rader: Record<string, unknown>[]; merknad?: string; periode?: string };

export type Rapportdef = {
  id: string; // f.eks. «lonn.journal»
  modul: Modul;
  navn: string;
  beskrivelse: string;
  funksjon: string; // funksjonen organisasjonen må ha (faktura.har_funksjon)
  tilgang: "les" | "personal_les" | "personal"; // handlingen brukeren må kunne (faktura.kan)
  parameter: Parameter;
  maanedlig?: boolean; // kan sendes til regnskapsføreren hver måned (for forrige måned)
  hent: (db: Db, org: string, v: Valg) => Promise<Rapportdata>;
};

export type Rapportresultat = Rapportdata & {
  id: string;
  modul: Modul;
  navn: string;
  beskrivelse: string;
  parameter: Parameter;
  periode: string;
  valg: Valg;
  sum: Record<string, number> | null;
};

// Alle rapportene, modul for modul.
export const RAPPORTER: Rapportdef[] = [...fakturaRapporter, ...personalRapporter, ...lonnRapporter];
const PER_ID = new Map(RAPPORTER.map((r) => [r.id, r]));
export const rapport = (id: string) => PER_ID.get(id);

// --- Valgene ----------------------------------------------------------------------------------------

const osloIDag = () => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Oslo" }).format(new Date());
const MAANEDER = ["januar", "februar", "mars", "april", "mai", "juni", "juli", "august", "september", "oktober", "november", "desember"];
const sisteDag = (aar: number, mnd: number) => new Date(Date.UTC(aar, mnd, 0)).toISOString().slice(0, 10); // mnd 1–12
const visDato = (d: string) => d.split("-").reverse().join(".");

export function termin(aar: number, nr: number) {
  return { fra: `${aar}-${String((nr - 1) * 2 + 1).padStart(2, "0")}-01`, til: sisteDag(aar, nr * 2) };
}

const datoS = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Ugyldig dato");
export const valgSkjema = z.object({
  fra: datoS.optional(),
  til: datoS.optional(),
  aar: z.coerce.number().int().min(2000).max(2100).optional(),
  termin: z.coerce.number().int().min(1).max(6).optional(),
  kjoring: z.string().uuid().optional(),
});
export type ValgInn = z.infer<typeof valgSkjema>;

// Valgene med standardverdier: denne måneden, terminen og året vi er i.
export function lagValg(def: Rapportdef, inn: ValgInn, iDag = osloIDag()): Valg {
  const aar = inn.aar ?? Number(iDag.slice(0, 4));
  const mnd = Number(iDag.slice(5, 7));
  const nr = inn.termin ?? Math.floor((mnd - 1) / 2) + 1;
  let fra: string;
  let til: string;
  if (def.parameter === "termin") ({ fra, til } = termin(aar, nr));
  else if (def.parameter === "aar") [fra, til] = [`${aar}-01-01`, `${aar}-12-31`];
  else if (def.parameter === "ingen") fra = til = iDag;
  else {
    fra = inn.fra ?? `${iDag.slice(0, 7)}-01`;
    til = inn.til ?? sisteDag(Number(iDag.slice(0, 4)), mnd);
  }
  if (til < fra) throw new ApiFeil(400, "Til-datoen er før fra-datoen");
  if (Date.parse(til) - Date.parse(fra) > 366 * 3 * 86400_000) throw new ApiFeil(400, "Perioden kan være høyst tre år");
  return { fra, til, aar, termin: nr, kjoring: inn.kjoring ?? null };
}

// «oktober 2026», «2026», «3. termin 2026 (mai–juni)», «01.10.2026–15.10.2026» eller «per 09.10.2026».
export function periodeTekst(p: Parameter, v: Valg): string {
  if (p === "ingen") return `per ${visDato(v.fra)}`;
  if (p === "aar") return String(v.aar);
  if (p === "termin") return `${v.termin}. termin ${v.aar} (${MAANEDER[(v.termin - 1) * 2]}–${MAANEDER[v.termin * 2 - 1]})`;
  const [fa, fm] = [Number(v.fra.slice(0, 4)), Number(v.fra.slice(5, 7))];
  if (v.fra.endsWith("-01") && v.til === sisteDag(fa, fm)) return `${MAANEDER[fm - 1]} ${fa}`;
  if (v.fra.endsWith("-01-01") && v.til === `${fa}-12-31`) return String(fa);
  return `${visDato(v.fra)}–${visDato(v.til)}`;
}

// --- Kjøringen ------------------------------------------------------------------------------------

// Rapportene brukeren kan se i organisasjonen (funksjonen slått på og tilgangen), per modul.
export async function tilgjengelige(db: Db, org: string): Promise<Rapportdef[]> {
  const par = [...new Set(RAPPORTER.map((r) => `${r.funksjon}|${r.tilgang}`))];
  const svar = await alle<{ par: string; ok: boolean }>(
    db,
    `select p as par, faktura.har_funksjon($1, split_part(p, '|', 1)) and faktura.kan($1, split_part(p, '|', 2)) as ok
       from unnest($2::text[]) p`,
    [org, par],
  );
  const ok = new Set(svar.filter((x) => x.ok).map((x) => x.par));
  return RAPPORTER.filter((r) => ok.has(`${r.funksjon}|${r.tilgang}`));
}

export async function kjorRapport(db: Db, org: string, def: Rapportdef, inn: ValgInn): Promise<Rapportresultat> {
  await db.query("select faktura.krev($1, $2)", [org, def.tilgang]);
  const har = await en<{ ok: boolean }>(db, "select faktura.har_funksjon($1, $2) as ok", [org, def.funksjon]);
  if (!har?.ok) throw new ApiFeil(403, "Funksjonen rapporten hører til, er ikke slått på");
  const valg = lagValg(def, inn);
  const data = await def.hent(db, org, valg);
  const sumKolonner = data.kolonner.filter((k) => k.sum);
  const sum = sumKolonner.length
    ? Object.fromEntries(sumKolonner.map((k) => [k.nokkel, Math.round(data.rader.reduce((s, r) => s + (Number(r[k.nokkel]) || 0), 0) * 100) / 100]))
    : null;
  return {
    id: def.id,
    modul: def.modul,
    navn: def.navn,
    beskrivelse: def.beskrivelse,
    parameter: def.parameter,
    valg,
    ...data,
    periode: data.periode ?? periodeTekst(def.parameter, valg),
    sum,
  };
}

// --- CSV og PDF -----------------------------------------------------------------------------------

const filnavn = (r: Rapportresultat) =>
  `${r.navn}-${r.periode}`
    .toLowerCase()
    .replace(/æ/g, "ae")
    .replace(/ø/g, "o")
    .replace(/å/g, "a")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

export function rapportCsv(r: Rapportresultat): { filnavn: string; tekst: string } {
  const rader = r.sum ? [...r.rader, { ...Object.fromEntries(r.kolonner.map((k, i) => [k.nokkel, i === 0 ? "Sum" : null])), ...r.sum }] : r.rader;
  return { filnavn: `${filnavn(r)}.csv`, tekst: csv(rader, r.kolonner.map((k) => [k.nokkel, k.navn])) };
}

const tallFormat = new Intl.NumberFormat("nb-NO", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const krFormat = new Intl.NumberFormat("nb-NO", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export function visVerdi(v: unknown, type: Kolonnetype = "tekst"): string {
  if (v == null || v === "") return "";
  if (type === "dato" && typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v)) return visDato(v.slice(0, 10));
  const n = Number(v);
  if (type === "kr" && Number.isFinite(n)) return krFormat.format(n).replace(/ /g, " ");
  if ((type === "tall" || type === "timer" || type === "antall") && Number.isFinite(n)) return tallFormat.format(n).replace(/ /g, " ");
  if (type === "prosent" && Number.isFinite(n)) return `${tallFormat.format(n)} %`;
  return String(v);
}
const hoyre = (t?: Kolonnetype) => t === "kr" || t === "tall" || t === "timer" || t === "antall" || t === "prosent";

export async function rapportPdf(alt: Rapportresultat, orgNavn: string): Promise<{ filnavn: string; data: Uint8Array }> {
  const r = { ...alt, kolonner: alt.kolonner.filter((k) => k.pdf !== false) };
  const doc = await PDFDocument.create();
  doc.setTitle(`${r.navn} ${r.periode}`);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const fet = await doc.embedFont(StandardFonts.HelveticaBold);
  const liggende = r.kolonner.length > 6;
  const [B, H] = liggende ? [841.89, 595.28] : [595.28, 841.89];
  const M = 40;
  const S = 8.5; // skriftstørrelsen i tabellen
  const grå = rgb(0.39, 0.45, 0.55);
  const linje = rgb(0.8, 0.83, 0.88);
  // Kolonnebreddene etter det lengste innholdet, skalert til siden.
  const tekster = (k: Kolonne) => [k.navn, ...r.rader.map((x) => visVerdi(x[k.nokkel], k.type)), r.sum?.[k.nokkel] != null ? visVerdi(r.sum[k.nokkel], k.type) : ""];
  const onsket = r.kolonner.map((k) => Math.min(220, Math.max(...tekster(k).map((t) => fet.widthOfTextAtSize(rensTekst(t, fet), S))) + 10));
  const skala = Math.min(1, (B - 2 * M) / onsket.reduce((s, w) => s + w, 0));
  const bredder = onsket.map((w) => w * skala);
  const xer = bredder.map((_, i) => M + bredder.slice(0, i).reduce((s, w) => s + w, 0));
  let side: PDFPage = doc.addPage([B, H]);
  let y = H - M;
  const kort = (t: string, f: PDFFont, maks: number) => {
    let s = rensTekst(t, f);
    if (f.widthOfTextAtSize(s, S) <= maks) return s;
    while (s.length > 1 && f.widthOfTextAtSize(`${s}…`, S) > maks) s = s.slice(0, -1);
    return `${s}…`;
  };
  const celle = (t: string, i: number, f: PDFFont, farge = rgb(0.1, 0.12, 0.18)) => {
    const k = r.kolonner[i]!;
    const s = kort(t, f, bredder[i]! - 8);
    const x = hoyre(k.type) ? xer[i]! + bredder[i]! - 4 - f.widthOfTextAtSize(s, S) : xer[i]! + 2;
    side.drawText(s, { x, y, size: S, font: f, color: farge });
  };
  const hode = () => {
    r.kolonner.forEach((k, i) => celle(k.navn, i, fet, grå));
    y -= 5;
    side.drawLine({ start: { x: M, y }, end: { x: B - M, y }, thickness: 0.6, color: linje });
    y -= 12;
  };
  const tekst = (t: string, x: number, f: PDFFont, s: number, farge = rgb(0.1, 0.12, 0.18)) => side.drawText(rensTekst(t, f), { x, y, size: s, font: f, color: farge });

  tekst(r.navn, M, fet, 16);
  y -= 18;
  tekst(`${orgNavn} · ${r.periode}`, M, font, 10, grå);
  y -= 13;
  for (const l of [r.beskrivelse, r.merknad].filter((x): x is string => !!x)) {
    tekst(kort(l, font, B - 2 * M), M, font, S, grå);
    y -= 11;
  }
  y -= 12;
  if (!r.rader.length) tekst("Ingen rader i perioden.", M, font, 10);
  else {
    hode();
    for (const rad of r.rader) {
      if (y < M + 20) {
        side = doc.addPage([B, H]);
        y = H - M;
        hode();
      }
      r.kolonner.forEach((k, i) => celle(visVerdi(rad[k.nokkel], k.type), i, font));
      y -= 12;
    }
    if (r.sum) {
      if (y < M + 26) {
        side = doc.addPage([B, H]);
        y = H - M;
        hode();
      }
      side.drawLine({ start: { x: M, y: y + 8 }, end: { x: B - M, y: y + 8 }, thickness: 0.6, color: linje });
      y -= 3;
      r.kolonner.forEach((k, i) => celle(i === 0 ? "Sum" : r.sum![k.nokkel] != null ? visVerdi(r.sum![k.nokkel], k.type) : "", i, fet));
    }
  }
  const laget = new Intl.DateTimeFormat("nb-NO", { timeZone: "Europe/Oslo", dateStyle: "short", timeStyle: "short" }).format(new Date());
  const sider = doc.getPages();
  sider.forEach((s, i) => {
    const t = `Side ${i + 1} av ${sider.length}`;
    s.drawText(t, { x: B - M - font.widthOfTextAtSize(t, 7.5), y: 22, size: 7.5, font, color: grå });
    s.drawText(rensTekst(`Laget ${laget} i HI4 Faktura`, font), { x: M, y: 22, size: 7.5, font, color: grå });
  });
  return { filnavn: `${filnavn(r)}.pdf`, data: await doc.save() };
}

// --- Utsending --------------------------------------------------------------------------------------

const logg = (severity: string, message: string, data: Record<string, unknown> = {}) => console.log(JSON.stringify({ severity, message, ...data }));

export type Utsending = {
  org_id: string;
  rapporter: { id: string; valg: ValgInn }[];
  til: string[];
  melding?: string | null;
  bruker_id?: string | null;
  automatisk?: "lonn" | "maaned" | null;
  oppgave_id: string;
};

// Lager rapportene og sender dem (CSV og PDF) på e-post. Rapporter som ikke finnes eller ikke kan
// lages (f.eks. funksjonen er slått av), hoppes over og står i e-posten.
export async function sendRapporter(o: Utsending) {
  const { org, avsender, resultater, mangler } = await somSystem(async (db) => {
    const org = await en<{ navn: string; epost: string | null }>(db, "select navn, epost from faktura.organisasjoner where id = $1", [o.org_id]);
    const avsender = o.bruker_id ? await en<{ navn: string | null; epost: string }>(db, "select navn, epost from faktura.brukere where id = $1", [o.bruker_id]) : null;
    const resultater: Rapportresultat[] = [];
    const mangler: string[] = [];
    for (const x of o.rapporter) {
      const def = rapport(x.id);
      if (!def) continue;
      try {
        resultater.push(await kjorRapport(db, o.org_id, def, x.valg));
      } catch (e) {
        mangler.push(`${def.navn}: ${(e as Error).message}`);
      }
    }
    return { org, avsender, resultater, mangler };
  });
  if (!org) return;
  if (!resultater.length) {
    await loggUtsending(o, [], `Ingen rapporter kunne lages. ${mangler.join(" ")}`.trim());
    return;
  }
  const vedlegg: { filnavn: string; data: Uint8Array; type: string }[] = [];
  for (const r of resultater) {
    const c = rapportCsv(r);
    vedlegg.push({ filnavn: c.filnavn, data: new TextEncoder().encode(c.tekst), type: "text/csv; charset=utf-8" });
    const p = await rapportPdf(r, org.navn);
    vedlegg.push({ filnavn: p.filnavn, data: p.data, type: "application/pdf" });
  }
  const grunn =
    o.automatisk === "lonn" ? "Lønnskjøringen er godkjent." : o.automatisk === "maaned" ? "Månedsrapportene sendes den 1. hver måned." : null;
  const tekst = [
    "Hei!",
    "",
    `Her er rapportene fra ${org.navn}${grunn ? ` (${grunn.toLowerCase().replace(/\.$/, "")})` : ""}:`,
    ...resultater.map((r) => `- ${r.navn}, ${r.periode} (${r.rader.length} ${r.rader.length === 1 ? "rad" : "rader"})`),
    "",
    ...(o.melding?.trim() ? [o.melding.trim(), ""] : []),
    ...(mangler.length ? ["Kunne ikke lages:", ...mangler.map((m) => `- ${m}`), ""] : []),
    "Rapportene ligger vedlagt som PDF og CSV (CSV-filene åpnes i Excel).",
    "",
    `Sendt fra HI4 Faktura${avsender ? ` av ${avsender.navn ?? avsender.epost}` : " av seg selv"}.`,
  ].join("\n");
  const esc = tekst.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
  try {
    await epost().send({
      fraNavn: org.navn,
      til: o.til,
      svarTil: avsender?.epost ?? org.epost ?? undefined,
      emne: `${org.navn}: ${resultater.map((r) => r.navn).join(", ")} (${resultater[0]!.periode})`,
      tekst,
      html: `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;white-space:pre-wrap">${esc}</div>`,
      vedlegg,
      idempotensnokkel: `rapport-${o.oppgave_id}`,
    });
    await loggUtsending(o, resultater, mangler.length ? mangler.join(" ") : null);
    logg("INFO", "Rapporter sendt", { org_id: o.org_id, rapporter: resultater.map((r) => r.id), automatisk: o.automatisk ?? null });
  } catch (e) {
    await loggUtsending(o, resultater, (e as Error).message);
    throw e;
  }
}

async function loggUtsending(o: Utsending, resultater: Rapportresultat[], feil: string | null) {
  await somSystem((db) =>
    db.query("insert into faktura.rapport_utsendinger (org_id, til, rapporter, automatisk, sendt_av, feil) values ($1, $2, $3, $4, $5, $6)", [
      o.org_id,
      o.til,
      JSON.stringify(resultater.map((r) => ({ id: r.id, navn: r.navn, periode: r.periode }))),
      o.automatisk ?? null,
      o.bruker_id ?? null,
      feil ? feil.slice(0, 1000) : null,
    ]),
  );
}

// Godkjent lønnskjøring: oppgaven som sender lønnsrapportene for kjøringen til regnskapsføreren,
// når det er slått på (leses i brukerens transaksjon; legges i kø etterpå).
export async function lonnsrapportOppgave(db: Db, org: string, kjoring: string): Promise<Oppgave | null> {
  const o = await en<{ mottakere: string[]; lonn_ved_godkjenning: boolean }>(db, "select mottakere, lonn_ved_godkjenning from faktura.rapport_oppsett where org_id = $1", [
    org,
  ]);
  if (!o?.lonn_ved_godkjenning || !o.mottakere.length) return null;
  return { type: "rapport-send", org_id: org, rapporter: LONN_VED_GODKJENNING.map((id) => ({ id, valg: { kjoring } })), til: o.mottakere, automatisk: "lonn" };
}
export const LONN_VED_GODKJENNING = ["lonn.journal", "lonn.lonnsarter"];

// Den 1. i måneden: de valgte månedsrapportene for forrige måned (terminrapporter når terminen
// er slutt, og årsrapporter i januar). Måneden tas i databasen før utsendingen legges i kø, så
// den sendes én gang per organisasjon, også om jobben kjøres flere ganger.
export async function planleggMaanedsrapporter(iDag = osloIDag()): Promise<number> {
  if (!iDag.endsWith("-01")) return 0;
  const [aar, mnd] = [Number(iDag.slice(0, 4)), Number(iDag.slice(5, 7))];
  const forrige = mnd === 1 ? { aar: aar - 1, mnd: 12 } : { aar, mnd: mnd - 1 };
  const fra = `${forrige.aar}-${String(forrige.mnd).padStart(2, "0")}-01`;
  const til = sisteDag(forrige.aar, forrige.mnd);
  const rader = await somSystem((db) =>
    alle<{ org_id: string; mottakere: string[]; maanedlig: string[] }>(
      db,
      `with tatt as (
         insert into faktura.rapport_maanedsutsendinger (org_id, maaned)
         select o.org_id, $1::date from faktura.rapport_oppsett o
          where cardinality(o.mottakere) > 0 and cardinality(o.maanedlig) > 0
         on conflict do nothing
         returning org_id
       )
       select o.org_id, o.mottakere, o.maanedlig from faktura.rapport_oppsett o join tatt using (org_id)`,
      [fra],
    ),
  );
  let antall = 0;
  for (const r of rader) {
    const rapporter = r.maanedlig
      .map((id) => rapport(id))
      .filter((d): d is Rapportdef => !!d && !!d.maanedlig)
      .flatMap((d): { id: string; valg: ValgInn }[] => {
        if (d.parameter === "periode") return [{ id: d.id, valg: { fra, til } }];
        if (d.parameter === "termin" && forrige.mnd % 2 === 0) return [{ id: d.id, valg: { aar: forrige.aar, termin: forrige.mnd / 2 } }];
        if (d.parameter === "aar" && forrige.mnd === 12) return [{ id: d.id, valg: { aar: forrige.aar } }];
        if (d.parameter === "ingen") return [{ id: d.id, valg: {} }];
        return [];
      });
    if (!rapporter.length) continue;
    try {
      await leggIKo({ type: "rapport-send", org_id: r.org_id, rapporter, til: r.mottakere, automatisk: "maaned" });
      antall++;
    } catch (e) {
      // Ikke i kø: måneden slippes, så neste kjøring prøver igjen.
      await somSystem((db) => db.query("delete from faktura.rapport_maanedsutsendinger where org_id = $1 and maaned = $2", [r.org_id, fra]));
      logg("ERROR", "Månedsrapportene ble ikke lagt i kø", { org_id: r.org_id, feil: (e as Error).message });
    }
  }
  return antall;
}

// --- Rutene (under /api/org/:org) -------------------------------------------------------------------

const orgId = (c: Context) => z.string().uuid().parse(c.req.param("org"));
const bruk = <T>(c: Context, fn: (db: Db) => Promise<T>) => somBruker<T>(c.get("bruker").id, fn);
const finn = (id: string) => {
  const d = rapport(id);
  if (!d) throw new ApiFeil(404, "Fant ikke rapporten");
  return d;
};
const epostS = z.string().trim().toLowerCase().email("Ugyldig e-postadresse").max(254);

export function rapportmodulRuter() {
  const r = new Hono();

  // Modulene og rapportene brukeren kan se.
  r.get("/rapportmodul", async (c) => {
    const defs = await bruk(c, (db) => tilgjengelige(db, orgId(c)));
    return c.json({
      moduler: MODULER.map((m) => ({
        ...m,
        rapporter: defs
          .filter((d) => d.modul === m.id)
          .map(({ id, navn, beskrivelse, parameter, maanedlig }) => ({ id, navn, beskrivelse, parameter, maanedlig: !!maanedlig })),
      })).filter((m) => m.rapporter.length),
    });
  });

  // Oppsettet for utsending, og de siste utsendingene.
  r.get("/rapportmodul/oppsett", async (c) =>
    c.json(
      await bruk(c, async (db) => {
        await db.query("select faktura.krev($1, 'les')", [orgId(c)]);
        const o = await en(db, "select mottakere, lonn_ved_godkjenning, maanedlig, oppdatert from faktura.rapport_oppsett where org_id = $1", [orgId(c)]);
        const sendt = await alle(
          db,
          `select u.id, u.tid, u.til, u.rapporter, u.automatisk, u.feil, coalesce(b.navn, b.epost) as sendt_av
             from faktura.rapport_utsendinger u left join faktura.brukere b on b.id = u.sendt_av
            where u.org_id = $1 order by u.tid desc limit 20`,
          [orgId(c)],
        );
        return { oppsett: o ?? { mottakere: [], lonn_ved_godkjenning: false, maanedlig: [], oppdatert: null }, sendt };
      }),
    ),
  );

  r.put("/rapportmodul/oppsett", async (c) => {
    const b = z
      .object({
        mottakere: z.array(epostS).max(10, "Høyst 10 mottakere"),
        lonn_ved_godkjenning: z.boolean(),
        maanedlig: z.array(z.string().max(60)).max(40),
      })
      .parse(await c.req.json().catch(() => ({})));
    const ukjent = b.maanedlig.find((id) => !rapport(id)?.maanedlig);
    if (ukjent) throw new ApiFeil(400, `Rapporten ${ukjent} kan ikke sendes hver måned`);
    // Nye mottakere får lønn og personopplysninger: totrinnsbekreftelse.
    krevMfa(c);
    return c.json(
      await bruk(c, async (db) => {
        await db.query("select faktura.krev($1, 'admin')", [orgId(c)]);
        return en(
          db,
          `insert into faktura.rapport_oppsett (org_id, mottakere, lonn_ved_godkjenning, maanedlig) values ($1, $2, $3, $4)
           on conflict (org_id) do update set mottakere = excluded.mottakere, lonn_ved_godkjenning = excluded.lonn_ved_godkjenning, maanedlig = excluded.maanedlig
           returning mottakere, lonn_ved_godkjenning, maanedlig, oppdatert`,
          [orgId(c), [...new Set(b.mottakere)], b.lonn_ved_godkjenning, [...new Set(b.maanedlig)]],
        );
      }),
    );
  });

  // Send rapporter til regnskapsføreren (eller andre adresser) nå.
  r.post("/rapportmodul/send", async (c) => {
    const b = z
      .object({
        rapporter: z.array(z.object({ id: z.string().max(60), valg: valgSkjema.default({}) })).min(1, "Velg minst én rapport").max(10, "Høyst 10 rapporter om gangen"),
        til: z.array(epostS).max(10).optional(),
        melding: z.string().trim().max(2000).optional(),
      })
      .parse(await c.req.json().catch(() => ({})));
    krevMfa(c);
    const til = await bruk(c, async (db) => {
      await db.query("select faktura.krev($1, 'admin')", [orgId(c)]);
      // Hver rapport må kunne lages av brukeren (funksjonen og tilgangen), med gyldige valg.
      for (const x of b.rapporter) {
        const def = finn(x.id);
        await db.query("select faktura.krev($1, $2)", [orgId(c), def.tilgang]);
        if (!(await en<{ ok: boolean }>(db, "select faktura.har_funksjon($1, $2) as ok", [orgId(c), def.funksjon]))?.ok)
          throw new ApiFeil(403, `${def.navn}: funksjonen er ikke slått på`);
        lagValg(def, x.valg);
      }
      if (b.til?.length) return [...new Set(b.til)];
      return (await en<{ mottakere: string[] }>(db, "select mottakere from faktura.rapport_oppsett where org_id = $1", [orgId(c)]))?.mottakere ?? [];
    });
    if (!til.length) throw new ApiFeil(400, "Legg inn e-postadressen til regnskapsføreren først (Rapporter → Utsending)");
    await leggIKo({ type: "rapport-send", org_id: orgId(c), rapporter: b.rapporter, til, melding: b.melding ?? null, bruker_id: c.get("bruker").id });
    return c.json({ ok: true, til });
  });

  // Én rapport: som tabell (JSON), CSV eller PDF.
  r.get("/rapportmodul/:id{[a-z_]+\\.[a-z_0-9]+}", async (c) => {
    const def = finn(c.req.param("id"));
    const inn = valgSkjema.parse(c.req.query());
    return c.json(await bruk(c, (db) => kjorRapport(db, orgId(c), def, inn)));
  });
  r.get("/rapportmodul/:id{[a-z_]+\\.[a-z_0-9]+}/csv", async (c) => {
    const def = finn(c.req.param("id"));
    const inn = valgSkjema.parse(c.req.query());
    const f = rapportCsv(await bruk(c, (db) => kjorRapport(db, orgId(c), def, inn)));
    return c.body(f.tekst, 200, { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${f.filnavn}"` });
  });
  r.get("/rapportmodul/:id{[a-z_]+\\.[a-z_0-9]+}/pdf", async (c) => {
    const def = finn(c.req.param("id"));
    const inn = valgSkjema.parse(c.req.query());
    const [res, navn] = await bruk(c, async (db) => [await kjorRapport(db, orgId(c), def, inn), (await en<{ navn: string }>(db, "select navn from faktura.organisasjoner where id = $1", [orgId(c)]))?.navn ?? ""] as const);
    const f = await rapportPdf(res, navn);
    return c.body(f.data as unknown as ArrayBuffer, 200, { "content-type": "application/pdf", "content-disposition": `attachment; filename="${f.filnavn}"` });
  });

  return r;
}
