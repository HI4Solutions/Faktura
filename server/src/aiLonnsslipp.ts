// Lønnsslipper leses med AI: brukeren laster opp lønnsslipper (PDF eller bilde, gjerne alle de
// ansatte for en måned i én PDF), og Gemini henter ut opplysningene om hver ansatt: navn,
// adresse, fødselsnummer, kontonummer, stilling, stillingsprosent, lønn, faste tillegg og andre
// opplysninger lønnen trenger (skattetrekk, feriepenger, pensjon …). Svaret er rader i samme
// form som importen av ansatte (POST /ansatte/importer), så brukeren ser alt i
// forhåndsvisningen før noe lagres, eller fyller ut skjemaet for én ansatt. Fødselsnummer og
// kontonummer sjekkes (kontrollsifrene) her, og det som ikke stemmer, tas ut og sies fra om.
// Fila lagres ikke, og ingenting lagres før brukeren har sett over det.
import { Hono, type Context } from "hono";
import { z } from "zod";
import { somBruker, type Db } from "./db.js";
import { ApiFeil } from "./feil.js";
import { aiPaa, enLinje, generer, iDagOslo, medKvote, type Del, type Skjema } from "./ai.js";
import { fnrGyldig, fodselsdato } from "./fnr.js";
import { kontonrGyldig } from "./regler.js";

// Filene Gemini kan lese.
export const SLIPPTYPER: Record<string, string> = {
  "application/pdf": "application/pdf",
  "image/jpeg": "image/jpeg",
  "image/jpg": "image/jpeg",
  "image/png": "image/png",
  "image/webp": "image/webp",
  "image/heic": "image/heic",
  "image/heif": "image/heif",
};
export const MAKS_SLIPP = 12_000_000;

type AiTillegg = { navn: string; belop: number; per: "maaned" | "time" | null };
type AiAnsatt = {
  fornavn: string | null;
  etternavn: string | null;
  adresse: string | null;
  postnr: string | null;
  poststed: string | null;
  fnr: string | null;
  fodselsdato: string | null;
  kontonr: string | null;
  ansattnummer: string | null;
  stilling: string | null;
  stillingsprosent: number | null;
  ansatt_fra: string | null;
  lonnstype: "maaned" | "time" | null;
  maanedslonn: number | null;
  timelonn: number | null;
  tillegg: AiTillegg[];
  annet: string[];
};
export type AiSlipper = { ansatte: AiAnsatt[]; merknader: string[] };

const tekst = (beskrivelse: string, nullable = true): Skjema => ({ type: "STRING", nullable, description: beskrivelse });
const tall = (beskrivelse: string): Skjema => ({ type: "NUMBER", nullable: true, description: beskrivelse });
const FELT = [
  "fornavn", "etternavn", "adresse", "postnr", "poststed", "fnr", "fodselsdato", "kontonr", "ansattnummer", "stilling", "stillingsprosent",
  "ansatt_fra", "lonnstype", "maanedslonn", "timelonn", "tillegg", "annet",
];

export const slippSkjema: Skjema = {
  type: "OBJECT",
  properties: {
    ansatte: {
      type: "ARRAY",
      description: "Én for hver ansatt med lønnsslipp i fila",
      items: {
        type: "OBJECT",
        properties: {
          fornavn: tekst("Fornavnet, med mellomnavn"),
          etternavn: tekst("Etternavnet"),
          adresse: tekst("Gateadressen til den ansatte"),
          postnr: tekst("Postnummeret, fire siffer"),
          poststed: tekst("Poststedet"),
          fnr: tekst("Fødselsnummeret eller D-nummeret, 11 siffer uten mellomrom, når det står helt"),
          fodselsdato: tekst("Fødselsdatoen (ÅÅÅÅ-MM-DD) når den står, eller når fødselsnummeret er delvis skjult"),
          kontonr: tekst("Kontonummeret lønnen utbetales til, 11 siffer uten mellomrom"),
          ansattnummer: tekst("Ansattnummeret i lønnssystemet"),
          stilling: tekst("Stillingen eller stillingstittelen"),
          stillingsprosent: tall("Stillingsprosenten (100 for full stilling)"),
          ansatt_fra: tekst("Ansatt fra eller ansettelsesdatoen (ÅÅÅÅ-MM-DD)"),
          lonnstype: { type: "STRING", nullable: true, enum: ["maaned", "time"], description: "maaned for fast månedslønn, time for timelønn" },
          maanedslonn: tall("Den faste månedslønnen for stillingen, i kroner"),
          timelonn: tall("Timelønnen (satsen per time), i kroner"),
          tillegg: {
            type: "ARRAY",
            description: "Faste tillegg (se reglene)",
            items: {
              type: "OBJECT",
              properties: {
                navn: tekst("Navnet på tillegget, som på slippen", false),
                belop: { type: "NUMBER", description: "Satsen i kroner" },
                per: { type: "STRING", nullable: true, enum: ["maaned", "time"], description: "maaned for et tillegg per måned, time for et tillegg per time" },
              },
              required: ["navn", "belop", "per"],
              propertyOrdering: ["navn", "belop", "per"],
            },
          },
          annet: { type: "ARRAY", items: { type: "STRING" }, description: "Andre opplysninger lønnen trenger, som korte setninger (se reglene)" },
        },
        required: FELT,
        propertyOrdering: FELT,
      },
    },
    merknader: { type: "ARRAY", items: { type: "STRING" }, description: "Korte setninger på norsk om det som var uklart eller uleselig" },
  },
  required: ["ansatte", "merknader"],
  propertyOrdering: ["ansatte", "merknader"],
};

export function slippSystem(naa = new Date()): string {
  const { dato } = iDagOslo(naa);
  return [
    "Du leser lønnsslipper (lønnsspesifikasjoner) fra norske lønnssystemer, som PDF eller bilde, og henter ut opplysningene om hver ansatt til ansattregisteret i HI4 Faktura. Svar bare med JSON etter skjemaet.",
    `Dagens dato er ${dato}.`,
    "",
    "Regler:",
    "- Én rad per ansatt. Fila kan ha mange lønnsslipper (f.eks. alle de ansatte for en måned). Har samme ansatt flere slipper, ta med den nyeste én gang.",
    "- Skriv bare det som står på slippen. Det som ikke står: null (tom liste for tillegg og annet). Aldri gjett, og ikke ta opplysninger om arbeidsgiveren som om de var den ansattes (adressen øverst er ofte arbeidsgiverens).",
    "- Fødselsnummer og kontonummer: bare sifrene. Er fødselsnummeret delvis skjult (f.eks. 150385*****), sett fnr til null og fodselsdato til datoen.",
    "- Datoer som ÅÅÅÅ-MM-DD. Beløp som tall i kroner, uten tusenskille (45000.5).",
    "- maanedslonn er den faste månedslønnen for stillingen slik den står (fastlønn, månedslønn, grunnlønn), ikke det som ble utbetalt etter trekk, fravær eller en del av måneden. Står bare årslønn, del den på 12. timelonn er satsen per time, ikke summen for perioden. lonnstype er maaned for månedslønn og time for timelønn.",
    "- tillegg: bare faste tillegg som betales hver måned eller per time uansett hva som skjedde i perioden (funksjonstillegg, ledertillegg, ansiennitetstillegg, fagbrevtillegg, personlig tillegg, fast bil- eller telefongodtgjørelse). Ikke overtid, kvelds-, natt-, helge- eller helligdagstillegg som følger timene, feriepenger, bonus, refusjoner, engangsbeløp, trekk eller skatt. belop er satsen, per er maaned eller time.",
    "- annet: korte setninger med andre opplysninger lønnen trenger: skattetrekk (tabellnummer eller prosent), feriepengeprosent, pensjon (OTP-prosent), fagforening, arbeidsgiveren og lønnsperioden. Ikke beløp som bare gjelder perioden (skatt trukket, utbetalt).",
    "- merknader: korte setninger om det som var uklart eller uleselig. Tom liste når alt er klart.",
  ].join("\n");
}

export const slippForesporsel = (fil: { mimeType: string; data: string }, naa = new Date()): { system: string; deler: Del[]; skjema: Skjema } => ({
  system: slippSystem(naa),
  deler: [{ text: "Hent ut opplysningene om de ansatte fra lønnsslippene." }, { inlineData: fil }],
  skjema: slippSkjema,
});

// En rad til importen av ansatte (samme felt som POST /ansatte/importer).
export type Slipprad = Record<string, unknown> & { fornavn: string; etternavn: string };

const iso = (v: unknown) => {
  const s = enLinje(v, 20);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T12:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s ? null : s;
};
const kroner = (v: unknown, maks: number) => (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= maks ? Math.round(v * 100) / 100 : null);
const siffer = (v: unknown) => String(v ?? "").replace(/\D/g, "");

// Svaret fra modellen gjort om til rader, med det som ikke stemmer tatt ut (og sagt fra om).
export function tilRader(s: AiSlipper, iDag: string): { ansatte: Slipprad[]; merknader: string[] } {
  const merknader = (Array.isArray(s?.merknader) ? s.merknader : []).map((m) => enLinje(m, 300)).filter(Boolean).slice(0, 10);
  const ansatte: Slipprad[] = [];
  for (const a of (Array.isArray(s?.ansatte) ? s.ansatte : []).slice(0, 500)) {
    const fornavn = enLinje(a?.fornavn, 100);
    const etternavn = enLinje(a?.etternavn, 100);
    if (!fornavn && !etternavn) continue;
    const navn = [fornavn, etternavn].filter(Boolean).join(" ");
    const o: Slipprad = { fornavn, etternavn };
    const settTekst = (felt: string, verdi: unknown, maks: number) => {
      const t = enLinje(verdi, maks);
      if (t) o[felt] = t;
    };
    settTekst("adresse", a.adresse, 200);
    const postnr = siffer(a.postnr);
    if (postnr && postnr.length <= 4) o.postnr = postnr.padStart(4, "0");
    settTekst("poststed", a.poststed, 100);

    const fnr = siffer(a.fnr);
    if (fnr && fnrGyldig(fnr) && (fodselsdato(fnr) ?? "") <= iDag) o.fnr = fnr;
    else {
      if (fnr) merknader.push(`Fødselsnummeret til ${navn} stemmer ikke (kontrollsifrene), og er ikke tatt med.`);
      const fodt = iso(a.fodselsdato);
      if (fodt && fodt <= iDag) o.fodselsdato = fodt;
    }
    const konto = siffer(a.kontonr);
    if (konto && kontonrGyldig(konto)) o.kontonr = konto;
    else if (konto) merknader.push(`Kontonummeret til ${navn} stemmer ikke (kontrollsifrene), og er ikke tatt med.`);

    settTekst("stilling", a.stilling, 100);
    const prosent = typeof a.stillingsprosent === "number" && a.stillingsprosent > 0 && a.stillingsprosent <= 100 ? Math.round(a.stillingsprosent * 100) / 100 : null;
    if (prosent) o.stillingsprosent = prosent;
    const fra = iso(a.ansatt_fra);
    if (fra) o.ansatt_fra = fra;
    const maaned = kroner(a.maanedslonn, 10_000_000);
    const time = kroner(a.timelonn, 100_000);
    if (maaned !== null) o.maanedslonn = maaned;
    if (time !== null) o.timelonn = time;
    const lonnstype = a.lonnstype === "maaned" || a.lonnstype === "time" ? a.lonnstype : maaned !== null ? "maaned" : time !== null ? "time" : null;
    if (lonnstype) o.lonnstype = lonnstype;

    const tillegg = (Array.isArray(a.tillegg) ? a.tillegg : [])
      .map((t) => ({ navn: enLinje(t?.navn, 100), belop: kroner(t?.belop, 10_000_000), per: t?.per === "time" ? ("time" as const) : ("maaned" as const) }))
      .filter((t): t is { navn: string; belop: number; per: "maaned" | "time" } => !!t.navn && !!t.belop)
      .filter((t, i, alle) => alle.findIndex((x) => x.navn.toLowerCase() === t.navn.toLowerCase()) === i)
      .slice(0, 20);
    if (tillegg.length) o.tillegg = tillegg;

    // Ansattnummeret og de andre opplysningene havner i notatet, så de er der til lønnen.
    const annet = (Array.isArray(a.annet) ? a.annet : []).map((x) => enLinje(x, 200)).filter(Boolean).slice(0, 10);
    const nummer = enLinje(a.ansattnummer, 40);
    const notat = [nummer ? `Ansattnr. i tidligere system: ${nummer}` : "", annet.length ? `Fra lønnsslippen: ${annet.join(" ")}` : ""].filter(Boolean).join("\n");
    if (notat) o.notat = notat.slice(0, 2000);
    ansatte.push(o);
  }
  return { ansatte, merknader: [...new Set(merknader)] };
}

const orgId = (c: Context) => z.string().uuid().parse(c.req.param("org"));
const forStor = () => new ApiFeil(413, "Fila er for stor. Lønnsslipper kan være høyst 12 MB (del opp en stor PDF).");

export function lonnsslippRuter() {
  const r = new Hono();

  // Lønnsslipper (rå fil i kroppen, med filtypen): gir { ansatte, merknader }.
  r.post("/ai/lonnsslipp", async (c) => {
    if (!aiPaa()) throw new ApiFeil(503, "AI er ikke satt opp");
    const type = (c.req.header("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    const mime = SLIPPTYPER[type];
    if (!mime) throw new ApiFeil(400, "Lønnsslippen må være en PDF eller et bilde (JPG, PNG, WebP eller HEIC).");
    if (Number(c.req.header("content-length") ?? 0) > MAKS_SLIPP) throw forStor();
    const kjor = <X>(fn: (db: Db) => Promise<X>) => somBruker<X>(c.get("bruker").id, fn);
    await kjor((db) => db.query("select faktura.krev($1, 'personal')", [orgId(c)]));
    const data = new Uint8Array(await c.req.arrayBuffer());
    if (data.length < 100) throw new ApiFeil(422, "Fila er tom.");
    if (data.length > MAKS_SLIPP) throw forStor();
    const svar = await medKvote(kjor, orgId(c), "lonnsslipp", () =>
      generer<AiSlipper>(slippForesporsel({ mimeType: mime, data: Buffer.from(data).toString("base64") })),
    );
    const resultat = tilRader(svar.data, iDagOslo().dato);
    if (!resultat.ansatte.length)
      throw new ApiFeil(422, resultat.merknader[0] ?? "Fant ingen lønnsslipp med navn på den ansatte i fila. Prøv en tydeligere fil, eller legg inn den ansatte selv.");
    return c.json(resultat);
  });

  return r;
}
