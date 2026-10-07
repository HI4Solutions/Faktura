// Fakturautkast fra tekst eller tale: brukeren skriver eller sier hva som skal faktureres
// («Faktura til Kari Hansen for tre timer rådgivning à 1200, forfall om 14 dager»), og
// Gemini fyller ut skjemaet. Kunder og produkter kan bare velges fra registrene, med korte
// id-er (K1, P1 …) så modellen ikke kan finne på noe, og alt sjekkes her før utkastet går
// tilbake til appen. Ingenting lagres: brukeren ser over skjemaet og lagrer selv.
import { Hono, type Context } from "hono";
import { z } from "zod";
import { alle, en, somBruker, type Db } from "./db.js";
import { ApiFeil } from "./feil.js";
import { aiPaa, enLinje, generer, iDagOslo, medKvote, type Del, type Skjema } from "./ai.js";
import { sammeNavn } from "./bank.js";

export type Kunde = { id: string; navn: string; orgnr: string | null };
export type Produkt = { id: string; navn: string; varenummer: string | null; enhet: string; enhetspris: number | null; mva_sats: number };
export type Grunnlag = { navn: string; mva: boolean; kunder: Kunde[]; produkter: Produkt[] };

// Svaret fra modellen (etter skjemaet under).
export type AiLinje = {
  produkt: string | null;
  beskrivelse: string;
  antall: number;
  enhet: string | null;
  enhetspris: number | null;
  pris_inkl_mva: boolean;
  mva_sats: number | null;
  rabatt_prosent: number | null;
};
export type AiUtkast = {
  transkripsjon: string | null;
  kunde: string | null;
  kunde_navn: string | null;
  linjer: AiLinje[];
  fakturadato: string | null;
  forfallsdato: string | null;
  periode_fra: string | null;
  periode_til: string | null;
  deres_referanse: string | null;
  kommentar: string | null;
  merknader: string[];
};

// Det appen får: klart til å fylles inn i skjemaet.
export type Utkast = {
  transkripsjon: string | null;
  kunde_id: string | null;
  kunde_navn: string | null; // navnet brukeren sa, når kunden ikke finnes i registeret
  linjer: { produkt_id: string | null; beskrivelse: string; antall: number; enhet: string; enhetspris: number | null; mva_sats: number; rabatt_prosent: number | null }[];
  fakturadato: string | null;
  forfallsdato: string | null;
  periode_fra: string | null;
  periode_til: string | null;
  deres_referanse: string | null;
  kommentar: string | null;
  merknader: string[];
};

const tekst = (beskrivelse: string, nullable = true): Skjema => ({ type: "STRING", nullable, description: beskrivelse });
const datofelt = (beskrivelse: string): Skjema => tekst(`${beskrivelse} (ÅÅÅÅ-MM-DD), eller null`);

export const utkastSkjema: Skjema = {
  type: "OBJECT",
  properties: {
    transkripsjon: tekst("Ordrett hva brukeren sa når beskrivelsen er et lydopptak, ellers null"),
    kunde: tekst("Id-en til kunden i kundelisten (K1, K2 …), eller null"),
    kunde_navn: tekst("Kunden slik brukeren sa det, eller null"),
    linjer: {
      type: "ARRAY",
      maxItems: 50,
      items: {
        type: "OBJECT",
        properties: {
          produkt: tekst("Id-en til produktet i produktlisten (P1, P2 …), eller null"),
          beskrivelse: tekst("Teksten på fakturalinjen", false),
          antall: { type: "NUMBER", description: "Antall enheter (1 om ikke noe er sagt)" },
          enhet: tekst("stk, time, dag, uke, mnd, år, km, kg, l, m eller m2"),
          enhetspris: { type: "NUMBER", nullable: true, description: "Pris for én enhet, eller null" },
          pris_inkl_mva: { type: "BOOLEAN", description: "true bare når brukeren sier at prisen er med mva" },
          mva_sats: { type: "INTEGER", nullable: true, description: "25, 15, 12 eller 0" },
          rabatt_prosent: { type: "NUMBER", nullable: true, description: "Rabatt i prosent, eller null" },
        },
        required: ["produkt", "beskrivelse", "antall", "enhet", "enhetspris", "pris_inkl_mva", "mva_sats", "rabatt_prosent"],
        propertyOrdering: ["produkt", "beskrivelse", "antall", "enhet", "enhetspris", "pris_inkl_mva", "mva_sats", "rabatt_prosent"],
      },
    },
    fakturadato: datofelt("Fakturadato bare når brukeren sier en"),
    forfallsdato: datofelt("Forfallsdato bare når brukeren sier en frist"),
    periode_fra: datofelt("Første dag i perioden som faktureres"),
    periode_til: datofelt("Siste dag i perioden"),
    deres_referanse: tekst("Kundens referanse eller bestiller, eller null"),
    kommentar: tekst("Tekst som skal stå på fakturaen til kunden, bare når brukeren ber om det"),
    merknader: { type: "ARRAY", maxItems: 8, items: { type: "STRING" }, description: "Korte setninger om det brukeren bør sjekke" },
  },
  required: ["transkripsjon", "kunde", "kunde_navn", "linjer", "fakturadato", "forfallsdato", "periode_fra", "periode_til", "deres_referanse", "kommentar", "merknader"],
  propertyOrdering: ["transkripsjon", "kunde", "kunde_navn", "linjer", "fakturadato", "forfallsdato", "periode_fra", "periode_til", "deres_referanse", "kommentar", "merknader"],
};

const krTekst = (n: number) => new Intl.NumberFormat("nb-NO", { maximumFractionDigits: 2 }).format(n).replace(/[\u00a0\u202f]/g, " ");

export function systemtekst(g: Grunnlag, naa = new Date()): string {
  const { dato, ukedag } = iDagOslo(naa);
  return [
    "Du lager utkast til fakturaer i fakturaprogrammet HI4 Faktura ut fra det brukeren skriver eller sier. Svar bare med JSON etter skjemaet.",
    "",
    `Dagens dato er ${dato} (${ukedag}). Selger er ${enLinje(g.navn)}, ${g.mva ? "som er mva-registrert" : "som ikke er mva-registrert: alle linjer skal ha mva_sats 0"}.`,
    "",
    "Regler:",
    "- Kunden: velg id-en (K1, K2 …) til kunden i kundelisten som brukeren mener, også når navnet er skrevet litt annerledes, forkortet eller uten AS. Er du ikke sikker, eller finnes ikke kunden, sett kunde til null og skriv navnet slik brukeren sa det i kunde_navn.",
    "- Linjer: én linje per vare eller tjeneste. Gjelder linjen et produkt i produktlisten, sett produkt til id-en (P1, P2 …) og bruk produktets pris når brukeren ikke sier en annen.",
    "- enhetspris er prisen for én enhet. Sier brukeren en sum for flere enheter, del summen på antallet. pris_inkl_mva er true bare når brukeren sier at prisen er med mva («inkl. mva», «med moms»).",
    "- mva_sats er 25, 15, 12 eller 0. Bruk produktets sats for produkter. Ellers 25, om ikke brukeren sier noe annet (matvarer 15, persontransport og overnatting 12, fritatt 0).",
    "- Regn om relative datoer («i morgen», «neste fredag», «om 14 dager») til ÅÅÅÅ-MM-DD. «For oktober» betyr periode_fra første og periode_til siste dag i oktober. Sett bare periode når brukeren nevner en.",
    "- forfallsdato bare når brukeren sier en frist; ellers null (appen bruker standard betalingsfrist). fakturadato bare når brukeren sier en; ellers null (i dag).",
    "- deres_referanse: kundens referanse eller bestiller når brukeren sier det («referanse Ola», «att. Kari»).",
    "- kommentar: bare tekst brukeren ber om å få på fakturaen («skriv at …»).",
    "- Ikke finn på noe: felt du ikke vet, er null. Ingen linje uten at brukeren har nevnt hva som skal faktureres.",
    "- merknader: korte setninger på norsk om det brukeren bør sjekke, for eksempel en pris som mangler eller noe du var usikker på. Ikke skriv at kunden mangler (appen viser det selv). Tom liste når alt er klart.",
    "- transkripsjon: når beskrivelsen er et lydopptak, skriv ordrett hva som ble sagt. Ellers null.",
  ].join("\n");
}

// Registrene som tekst: korte id-er og det modellen trenger for å kjenne dem igjen.
export function registertekst(g: Grunnlag): string {
  const kunder = g.kunder.map((k, i) => `K${i + 1}: ${enLinje(k.navn)}${k.orgnr ? ` (org.nr. ${k.orgnr})` : ""}`);
  const produkter = g.produkter.map((p, i) => {
    const pris = p.enhetspris == null ? "pris oppgis på fakturaen" : `${krTekst(p.enhetspris)} kr per ${enLinje(p.enhet, 20) || "stk"} eks. mva`;
    return `P${i + 1}: ${enLinje(p.navn)}${p.varenummer ? ` (varenr. ${enLinje(p.varenummer, 30)})` : ""} | ${pris} | ${g.mva ? `${p.mva_sats} % mva` : "uten mva"}`;
  });
  return [
    "Kunder:",
    ...(kunder.length ? kunder : ["(ingen)"]),
    "",
    "Produkter:",
    ...(produkter.length ? produkter : ["(ingen)"]),
  ].join("\n");
}

export async function hentGrunnlag(db: Db, orgId: string): Promise<Grunnlag> {
  const o = await en<{ navn: string; mva_registrert: boolean }>(db, "select navn, mva_registrert from faktura.organisasjoner where id = $1", [orgId]);
  if (!o) throw new ApiFeil(404, "Fant ikke organisasjonen");
  // Kundene som er fakturert sist, først (taket gjelder bare svært store registre).
  const kunder = await alle<Kunde>(
    db,
    `select k.id, k.navn, k.orgnr
       from faktura.kunder k
       left join (select kunde_id, max(opprettet) as sist from faktura.fakturaer where org_id = $1 group by kunde_id) s on s.kunde_id = k.id
      where k.org_id = $1 and k.aktiv
      order by s.sist desc nulls last, lower(k.navn)
      limit 2000`,
    [orgId],
  );
  const produkter = await alle<Produkt>(
    db,
    "select id, navn, varenummer, enhet, enhetspris, mva_sats from faktura.produkter where org_id = $1 and aktiv order by lower(navn) limit 1000",
    [orgId],
  );
  return { navn: o.navn, mva: o.mva_registrert, kunder, produkter };
}

const SATSER = [0, 12, 15, 25];
const ENHETER: Record<string, string> = {
  stk: "stk", "stk.": "stk", stykk: "stk", styk: "stk",
  time: "time", timer: "time", t: "time", h: "time",
  dag: "dag", dager: "dag", døgn: "dag",
  uke: "uke", uker: "uke",
  mnd: "mnd", "mnd.": "mnd", måned: "mnd", måneder: "mnd",
  år: "år", aar: "år",
  km: "km", kg: "kg", l: "l", liter: "l", m: "m", meter: "m", m2: "m2", "m²": "m2", kvm: "m2", m3: "m3", "m³": "m3",
};
const enhetFra = (e: unknown) => {
  const s = enLinje(e, 20).toLowerCase();
  return s ? ENHETER[s] ?? s : null;
};
const avrund = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
const endelig = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const gyldigDato = (s: unknown): string | null => {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(s) ? s : null;
};
const fraListe = <T>(id: unknown, prefiks: "K" | "P", liste: T[]): T | null => {
  const m = typeof id === "string" ? id.trim().toUpperCase().match(new RegExp(`^${prefiks}(\\d+)$`)) : null;
  return m ? liste[Number(m[1]) - 1] ?? null : null;
};
const valgfri = (s: unknown, maks: number) => enLinje(s, maks) || null;

// Sjekker svaret fra modellen mot registrene og gjør det om til et utkast.
export function tilUtkast(ai: AiUtkast, g: Grunnlag): Utkast {
  // Kunden: id-en fra listen, ellers navnet (nøyaktig, eller det eneste som passer).
  const navn = valgfri(ai.kunde_navn, 200);
  let kunde = fraListe(ai.kunde, "K", g.kunder);
  if (!kunde && navn) {
    const lik = g.kunder.filter((k) => k.navn.trim().toLowerCase() === navn.toLowerCase());
    const ligner = lik.length ? lik : g.kunder.filter((k) => sammeNavn(k.navn, navn));
    if (ligner.length === 1) kunde = ligner[0];
  }

  const linjer: Utkast["linjer"] = [];
  for (const l of (Array.isArray(ai.linjer) ? ai.linjer : []).slice(0, 50)) {
    const p = fraListe(l?.produkt, "P", g.produkter);
    const beskrivelse = enLinje(l?.beskrivelse, 1000) || p?.navn || "";
    if (!beskrivelse) continue;
    const sats = !g.mva ? 0 : p ? Number(p.mva_sats) : SATSER.includes(Number(l.mva_sats)) ? Number(l.mva_sats) : 25;
    // Prisen brukeren sa (gjort om til eks. mva), ellers produktets pris.
    let enhetspris = endelig(l.enhetspris) ? l.enhetspris : p?.enhetspris ?? null;
    if (endelig(l.enhetspris) && l.pris_inkl_mva === true && sats > 0) enhetspris = avrund(l.enhetspris / (1 + sats / 100));
    if (enhetspris != null) enhetspris = avrund(enhetspris);
    const antall = endelig(l.antall) && l.antall !== 0 && Math.abs(l.antall) < 1e7 ? avrund(l.antall, 4) : 1;
    const rabatt = endelig(l.rabatt_prosent) && l.rabatt_prosent > 0 && l.rabatt_prosent <= 100 ? avrund(l.rabatt_prosent) : null;
    linjer.push({
      produkt_id: p?.id ?? null,
      beskrivelse,
      antall,
      enhet: enhetFra(l.enhet) ?? p?.enhet ?? "stk",
      enhetspris,
      mva_sats: sats,
      rabatt_prosent: rabatt,
    });
  }

  const fakturadato = gyldigDato(ai.fakturadato);
  let forfallsdato = gyldigDato(ai.forfallsdato);
  if (forfallsdato && fakturadato && forfallsdato < fakturadato) forfallsdato = null;
  let periode_fra = gyldigDato(ai.periode_fra);
  let periode_til = gyldigDato(ai.periode_til);
  if (periode_fra && periode_til && periode_til < periode_fra) [periode_fra, periode_til] = [null, null];

  const merknader = (Array.isArray(ai.merknader) ? ai.merknader : [])
    .map((m) => enLinje(m, 300))
    .filter(Boolean)
    .slice(0, 8);
  return {
    transkripsjon: valgfri(ai.transkripsjon, 4000),
    kunde_id: kunde?.id ?? null,
    kunde_navn: kunde ? null : navn,
    linjer,
    fakturadato,
    forfallsdato,
    periode_fra,
    periode_til,
    deres_referanse: valgfri(ai.deres_referanse, 100),
    kommentar: valgfri(ai.kommentar, 1000),
    merknader,
  };
}

// Lydformatene nettlesere tar opp i (MediaRecorder) og Gemini forstår.
const LYDTYPER: Record<string, string> = {
  "audio/webm": "audio/webm",
  "audio/mp4": "audio/mp4",
  "audio/m4a": "audio/m4a",
  "audio/x-m4a": "audio/m4a",
  "audio/aac": "audio/aac",
  "audio/mpeg": "audio/mpeg",
  "audio/mp3": "audio/mp3",
  "audio/ogg": "audio/ogg",
  "audio/wav": "audio/wav",
  "audio/x-wav": "audio/wav",
  "audio/flac": "audio/flac",
};
export const MAKS_LYD = 4_000_000; // rundt fire minutter tale
const forLangt = () => new ApiFeil(413, "Opptaket er for langt. Hold det under to minutter.");

const orgId = (c: Context) => z.string().uuid().parse(c.req.param("org"));
const bruk = <T>(c: Context, fn: (db: Db) => Promise<T>) => somBruker<T>(c.get("bruker").id, fn);

export function aiRuter() {
  const r = new Hono();

  // Utkast fra tekst ({ tekst }) eller et lydopptak (rå lyd i kroppen, med lydtypen).
  r.post("/ai/faktura", async (c) => {
    if (!aiPaa()) throw new ApiFeil(503, "AI er ikke satt opp");
    const type = (c.req.header("content-type") ?? "").split(";")[0].trim().toLowerCase();
    let del: Del;
    if (type.startsWith("audio/")) {
      const mime = LYDTYPER[type];
      if (!mime) throw new ApiFeil(400, "Appen kjenner ikke lydformatet. Skriv i stedet.");
      if (Number(c.req.header("content-length") ?? 0) > MAKS_LYD) throw forLangt();
      const data = new Uint8Array(await c.req.arrayBuffer());
      if (data.length < 500) throw new ApiFeil(400, "Opptaket er tomt. Prøv igjen og snakk litt lenger.");
      if (data.length > MAKS_LYD) throw forLangt();
      del = { inlineData: { mimeType: mime, data: Buffer.from(data).toString("base64") } };
    } else {
      const b = z
        .object({ tekst: z.string().trim().min(3, "Skriv hva som skal faktureres").max(4000, "Teksten kan være høyst 4000 tegn") })
        .parse(await c.req.json().catch(() => ({})));
      del = { text: `Brukerens beskrivelse:\n${b.tekst}` };
    }
    const g = await bruk(c, async (db) => {
      await db.query("select faktura.krev($1, 'skriv')", [orgId(c)]);
      return hentGrunnlag(db, orgId(c));
    });
    const deler: Del[] = [{ text: registertekst(g) }, ...("inlineData" in del ? [{ text: "Brukeren beskriver fakturaen i lydopptaket." }, del] : [del])];
    const svar = await medKvote(
      (fn) => somBruker(c.get("bruker").id, fn),
      orgId(c),
      "faktura",
      () => generer<AiUtkast>({ system: systemtekst(g), deler, skjema: utkastSkjema }),
    );
    const u = tilUtkast(svar.data, g);
    if (!u.kunde_id && !u.kunde_navn && !u.linjer.length)
      throw new ApiFeil(422, u.transkripsjon ? `Fant ikke hva som skal faktureres i «${u.transkripsjon}». Si hvem kunden er og hva du vil fakturere.` : "Fant ikke hva som skal faktureres. Si hvem kunden er og hva du vil fakturere.");
    return c.json(u);
  });

  return r;
}
