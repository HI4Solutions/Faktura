// AI med Gemini på Vertex AI (Google Cloud), i EU: europe-west3 (Frankfurt) som standard.
// Brukes til fakturautkast fra tekst eller tale (aiFaktura.ts) og til forslag om hvilken
// faktura en innbetaling gjelder (aiInnbetaling.ts). Svaret er JSON etter et fast skjema
// (responseSchema), og alt sjekkes mot dataene i appen før det brukes: AI-en lager bare
// utkast og forslag som en person ser over, den registrerer aldri noe selv.
//
// Tilgangen er tjenestekontoens (roles/aiplatform.user, se infra/terraform/iam.tf), så det
// finnes ingen nøkkel å ta vare på. Google bruker ikke dataene til å trene modellene.
// API: https://cloud.google.com/vertex-ai/generative-ai/docs/model-reference/inference
import { GoogleAuth } from "google-auth-library";
import { config } from "./config.js";
import { en, type Db } from "./db.js";
import { ApiFeil } from "./feil.js";

// Feil fra AI-tjenesten, med en melding som kan vises til brukeren. detaljer: svaret fra
// Google (for plattformadministratorene, se «Test AI» på adminsiden).
export class AiFeil extends ApiFeil {
  constructor(status: number, melding: string, readonly detaljer: string | null = null) {
    super(status, melding);
  }
}

// Svarskjemaet (OpenAPI-delmengden Vertex AI bruker). Uten grenser som maxItems: med dem blir
// store skjemaer for innviklede for Gemini («too many states»), og lengdene sjekkes uansett
// på serveren.
export type Skjema = {
  type: "STRING" | "NUMBER" | "INTEGER" | "BOOLEAN" | "ARRAY" | "OBJECT";
  description?: string;
  nullable?: boolean;
  enum?: string[];
  properties?: Record<string, Skjema>;
  required?: string[];
  propertyOrdering?: string[];
  items?: Skjema;
};

// Det som sendes til modellen: tekst, eller lyd (base64).
export type Del = { text: string } | { inlineData: { mimeType: string; data: string } };
// skjemafeil: svaret fra Google da skjemaet ble avvist, når svaret kom uten skjemaet.
export type AiSvar<T> = { data: T; tokens_inn: number; tokens_ut: number; skjemafeil?: string };
export type Funksjon = "faktura" | "innbetaling" | "assistent";

const logg = (severity: string, message: string, data: Record<string, unknown> = {}) => console.log(JSON.stringify({ severity, message, ...data }));

let auth: GoogleAuth | undefined;
let aiFetch: typeof fetch = (...a) => fetch(...a);
let hentToken = async (): Promise<string> => {
  auth ??= new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
  const t = await auth.getAccessToken();
  if (!t) throw new AiFeil(503, "Fikk ikke tilgang til AI-tjenesten");
  return t;
};
// For testene: falske svar og token.
export function settAi(v: { fetch?: typeof fetch; token?: () => Promise<string> }) {
  if (v.fetch) aiFetch = v.fetch;
  if (v.token) hentToken = v.token;
}

// AI er satt opp for plattformen (Terraform setter AI_PROSJEKT).
export const aiPaa = () => Boolean(config.aiProsjekt);

// Regioner (europe-west3), multiregionene eu og us, eller global har hver sin adresse.
export function aiAdresse(): string {
  const r = config.aiRegion;
  const vert = r === "global" ? "aiplatform.googleapis.com" : r === "eu" || r === "us" ? `aiplatform.${r}.rep.googleapis.com` : `${r}-aiplatform.googleapis.com`;
  return `https://${vert}/v1/projects/${config.aiProsjekt}/locations/${r}/publishers/google/models/${config.aiModell}:generateContent`;
}

const vent = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Hele kallet, med nye forsøk, holder seg under grensen på 60 sekunder i Firebase Hosting.
const FRIST = 50_000;
// Skjemaer Gemini nettopp har avvist: de neste kallene går rett uten skjema en stund.
const avvist = new WeakMap<Skjema, { til: number; feil: string }>();
const AVVIST_I = 15 * 60_000;

// Uten responseSchema står skjemaet i systemteksten i stedet.
const skjemaSomTekst = (s: Skjema) =>
  `Svar med ett JSON-objekt og ingenting annet, etter dette skjemaet (OpenAPI). Ta med alle feltene, med null der du ikke vet:\n${JSON.stringify(s)}`;

// JSON fra modellen, også inne i ```json … ``` eller med tekst rundt. undefined: ikke JSON.
export function lesJson(tekst: string): unknown {
  const forsok = [tekst, tekst.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1], tekst.slice(tekst.indexOf("{"), tekst.lastIndexOf("}") + 1)];
  for (const t of forsok) {
    if (!t?.trim()) continue;
    try {
      return JSON.parse(t);
    } catch {
      // neste
    }
  }
  return undefined;
}

// Enum-verdier sammenlignes uten store bokstaver, æøå og mellomrom («Høy» er hoy, «sjekk betaling» er sjekk_betaling).
const enumNokkel = (s: string) =>
  s
    .trim()
    .toLowerCase()
    .replace(/æ/g, "ae")
    .replace(/[øö]/g, "o")
    .replace(/[åä]/g, "a")
    .replace(/[\s-]+/g, "_");

// Svaret tilpasset skjemaet: felt som mangler, blir null (tom liste, false eller 0 når feltet
// ikke kan være null), og tall og sannhetsverdier som kom som tekst, gjøres om. Med
// responseSchema er svaret allerede slik; uten kan det avvike litt.
export function etterSkjema(v: unknown, s: Skjema): unknown {
  switch (s.type) {
    case "OBJECT": {
      const o = v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
      const ut: Record<string, unknown> = { ...o };
      for (const [k, d] of Object.entries(s.properties ?? {})) ut[k] = etterSkjema(o[k], d);
      return ut;
    }
    case "ARRAY":
      return (Array.isArray(v) ? v : v == null || v === "" ? [] : [v]).map((x) => (s.items ? etterSkjema(x, s.items) : x));
    case "BOOLEAN":
      return v === true || (typeof v === "string" && v.trim().toLowerCase() === "true");
    case "NUMBER":
    case "INTEGER": {
      const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v.replace(/[\s  ]/g, "").replace(",", ".")) : NaN;
      if (!Number.isFinite(n)) return s.nullable ? null : 0;
      return s.type === "INTEGER" ? Math.round(n) : n;
    }
    default: {
      const t = typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : null;
      if (t !== null && s.enum) return s.enum.find((e) => enumNokkel(e) === enumNokkel(t)) ?? (s.nullable ? null : "");
      return t ?? (s.nullable ? null : "");
    }
  }
}

// Ett kall til modellen. Svaret er JSON etter skjemaet. Gemini 3 tenker «lite» (raskere og
// billigere, godt nok for å fylle ut et skjema); andre modeller bruker standarden.
//
// Avviser Gemini skjemaet (400, eller 500 for innviklede skjemaer), prøver vi én gang til uten
// det: modellen svarer fortsatt med JSON, med skjemaet i systemteksten, og svaret tilpasses
// skjemaet og sjekkes på serveren som ellers. husk: false (for «Test AI») prøver alltid med
// skjemaet først og husker ikke at det ble avvist.
export async function generer<T>(valg: { system: string; deler: Del[]; skjema: Skjema; husk?: boolean }): Promise<AiSvar<T>> {
  if (!aiPaa()) throw new AiFeil(503, "AI er ikke satt opp");
  const husk = valg.husk !== false;
  let tenking = /^gemini-3/.test(config.aiModell);
  const husket = husk ? avvist.get(valg.skjema) : undefined;
  let skjemafeil = husket && husket.til > Date.now() ? husket.feil : null;
  const fraMinnet = skjemafeil !== null;
  let pauset = false;
  const start = Date.now();
  const brukt = () => Date.now() - start;
  for (;;) {
    const medSkjema = skjemafeil === null;
    const kropp = {
      systemInstruction: { parts: [{ text: medSkjema ? valg.system : `${valg.system}\n\n${skjemaSomTekst(valg.skjema)}` }] },
      contents: [{ role: "user", parts: valg.deler }],
      generationConfig: {
        responseMimeType: "application/json",
        ...(medSkjema ? { responseSchema: valg.skjema } : {}),
        maxOutputTokens: 16384,
        ...(tenking ? { thinkingConfig: { thinkingLevel: "low" } } : {}),
      },
    };
    let r: Response;
    try {
      r = await aiFetch(aiAdresse(), {
        method: "POST",
        headers: { authorization: `Bearer ${await hentToken()}`, "content-type": "application/json" },
        body: JSON.stringify(kropp),
        signal: AbortSignal.timeout(Math.max(1000, Math.min(45_000, FRIST - brukt()))),
      });
    } catch (e) {
      if (e instanceof AiFeil) throw e;
      const feil = (e as Error).message;
      if ((e as Error).name === "TimeoutError" || (e as Error).name === "AbortError") {
        logg("WARNING", "AI-tjenesten brukte for lang tid", { ms: brukt(), modell: config.aiModell, region: config.aiRegion });
        throw new AiFeil(504, "AI-tjenesten brukte for lang tid på å svare. Prøv igjen.", `Ikke svar etter ${Math.round(brukt() / 1000)} sekunder`);
      }
      logg("WARNING", "Fikk ikke kontakt med AI-tjenesten", { feil });
      if (!pauset && brukt() < 10_000) {
        pauset = true;
        await vent(1000);
        continue;
      }
      throw new AiFeil(503, "Fikk ikke kontakt med AI-tjenesten. Prøv igjen om litt.", feil);
    }
    const data: any = await r.json().catch(() => null);
    if (!r.ok) {
      const melding = String(data?.error?.message ?? "").slice(0, 500);
      const detaljer = `${r.status}: ${melding || "uten melding"}`;
      // Modellen kjenner ikke tenkenivået: prøv uten.
      if (r.status === 400 && tenking && /think/i.test(melding)) {
        tenking = false;
        continue;
      }
      // Skjemaet ble avvist: prøv uten (se over), når det er tid til det. Ved 500 er dette også
      // det ene nye forsøket når tjenesten har problemer.
      if ((r.status === 400 || r.status >= 500) && medSkjema && FRIST - brukt() > 15_000) {
        logg("WARNING", "AI-tjenesten avviste skjemaet, prøver uten", { status: r.status, feil: melding, modell: config.aiModell, region: config.aiRegion });
        skjemafeil = detaljer;
        if (r.status >= 500) {
          pauset = true;
          await vent(1000);
        }
        continue;
      }
      // Opptatt (kvote eller overbelastet): én gang til etter en liten pause.
      if ((r.status === 429 || r.status >= 500) && !pauset && brukt() < 15_000) {
        pauset = true;
        await vent(1500);
        continue;
      }
      logg(r.status === 429 ? "WARNING" : "ERROR", "AI-tjenesten svarte med en feil", {
        status: r.status,
        feil: melding,
        skjemafeil,
        modell: config.aiModell,
        region: config.aiRegion,
      });
      const alt = skjemafeil && skjemafeil !== detaljer ? `${detaljer} (med skjemaet: ${skjemafeil})` : detaljer;
      if (r.status === 429) throw new AiFeil(503, "AI-tjenesten er opptatt akkurat nå. Prøv igjen om litt.", alt);
      if (r.status === 401 || r.status === 403 || r.status === 404) throw new AiFeil(503, "AI-tjenesten er ikke tilgjengelig akkurat nå.", alt);
      throw new AiFeil(502, "AI-tjenesten svarte med en feil. Prøv igjen.", alt);
    }
    const kandidat = data?.candidates?.[0];
    const deler: any[] = kandidat?.content?.parts ?? [];
    const tekst = deler.filter((d) => !d?.thought && typeof d?.text === "string").map((d) => d.text).join("");
    const grunn = data?.promptFeedback?.blockReason ?? kandidat?.finishReason ?? null;
    const bruk = data?.usageMetadata ?? {};
    const tokens = { tokens_inn: Number(bruk.promptTokenCount) || 0, tokens_ut: (Number(bruk.candidatesTokenCount) || 0) + (Number(bruk.thoughtsTokenCount) || 0) };
    if (!tekst.trim()) {
      logg("WARNING", "AI-en ga ikke noe svar", { grunn });
      throw new AiFeil(
        502,
        grunn === "MAX_TOKENS" ? "Svaret fra AI-en ble for langt. Prøv med en kortere beskrivelse." : "AI-en ga ikke noe svar. Prøv å si det på en annen måte.",
        grunn,
      );
    }
    const json = lesJson(tekst);
    if (json === undefined) {
      logg("WARNING", "Svaret fra AI-en var ikke JSON", { grunn, lengde: tekst.length, skjemafeil });
      throw new AiFeil(
        502,
        grunn === "MAX_TOKENS" ? "Svaret fra AI-en ble for langt. Prøv med en kortere beskrivelse." : "AI-en svarte ikke i riktig format. Prøv igjen.",
        grunn,
      );
    }
    if (skjemafeil && husk && !fraMinnet) avvist.set(valg.skjema, { til: Date.now() + AVVIST_I, feil: skjemafeil });
    return { data: etterSkjema(json, valg.skjema) as T, ...tokens, ...(skjemafeil ? { skjemafeil } : {}) };
  }
}

// Ett kall innenfor organisasjonens kvote for måneden (AI_GRENSE). Databasen sjekker
// tilgangen (skriv for fakturautkast, bokfør for innbetalinger) og at AI er slått på for
// organisasjonen. kjor: transaksjon som brukeren (API-et) eller som systemet (workeren).
export async function medKvote<T>(
  kjor: <X>(fn: (db: Db) => Promise<X>) => Promise<X>,
  orgId: string,
  funksjon: Funksjon,
  kall: () => Promise<AiSvar<T>>,
): Promise<AiSvar<T>> {
  if (!aiPaa()) throw new AiFeil(503, "AI er ikke satt opp");
  const r = await kjor((db) => en<{ ok: boolean }>(db, "select faktura.ai_reserver($1, $2, $3) as ok", [orgId, funksjon, config.aiGrense]));
  if (!r?.ok) throw new AiFeil(429, `Organisasjonen har brukt alle de ${config.aiGrense} AI-forespørslene for denne måneden.`);
  const start = Date.now();
  const svar = await kall();
  logg("INFO", "AI-kall", { org_id: orgId, funksjon, modell: config.aiModell, ms: Date.now() - start, tokens_inn: svar.tokens_inn, tokens_ut: svar.tokens_ut });
  await kjor((db) => db.query("select faktura.ai_tokens($1, $2, $3, $4)", [orgId, funksjon, svar.tokens_inn, svar.tokens_ut])).catch((e) =>
    logg("WARNING", "Kunne ikke føre AI-bruken", { org_id: orgId, feil: (e as Error).message }),
  );
  return svar;
}

// Tekst fra registrene på én linje (navn kan inneholde linjeskift), og ikke for lang.
export const enLinje = (s: unknown, maks = 120) =>
  String(s ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maks);

// Dagens dato i Norge (ÅÅÅÅ-MM-DD) og ukedagen, så modellen kan regne om «neste fredag».
export function iDagOslo(naa = new Date()): { dato: string; ukedag: string } {
  const dato = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Oslo" }).format(naa);
  const ukedag = new Intl.DateTimeFormat("nb-NO", { timeZone: "Europe/Oslo", weekday: "long" }).format(naa);
  return { dato, ukedag };
}
