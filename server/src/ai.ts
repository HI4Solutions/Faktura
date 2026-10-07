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

// Svarskjemaet (OpenAPI-delmengden Vertex AI bruker).
export type Skjema = {
  type: "STRING" | "NUMBER" | "INTEGER" | "BOOLEAN" | "ARRAY" | "OBJECT";
  description?: string;
  nullable?: boolean;
  enum?: string[];
  properties?: Record<string, Skjema>;
  required?: string[];
  propertyOrdering?: string[];
  items?: Skjema;
  maxItems?: number;
};

// Det som sendes til modellen: tekst, eller lyd (base64).
export type Del = { text: string } | { inlineData: { mimeType: string; data: string } };
export type AiSvar<T> = { data: T; tokens_inn: number; tokens_ut: number };
export type Funksjon = "faktura" | "innbetaling";

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

// Ett kall til modellen. Svaret må være JSON etter skjemaet. Gemini 3 tenker «lite» (raskere
// og billigere, godt nok for å fylle ut et skjema); andre modeller bruker standarden.
export async function generer<T>(valg: { system: string; deler: Del[]; skjema: Skjema }): Promise<AiSvar<T>> {
  if (!aiPaa()) throw new AiFeil(503, "AI er ikke satt opp");
  let tenking = /^gemini-3/.test(config.aiModell);
  const start = Date.now();
  for (let forsok = 1; ; forsok++) {
    const kropp = {
      systemInstruction: { parts: [{ text: valg.system }] },
      contents: [{ role: "user", parts: valg.deler }],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: valg.skjema,
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
        // Under grensen på 60 sekunder i Firebase Hosting.
        signal: AbortSignal.timeout(45_000),
      });
    } catch (e) {
      if (e instanceof AiFeil) throw e;
      logg("WARNING", "Fikk ikke kontakt med AI-tjenesten", { feil: (e as Error).message, forsok });
      if (forsok < 2 && Date.now() - start < 10_000) {
        await vent(1000);
        continue;
      }
      throw new AiFeil(503, "Fikk ikke kontakt med AI-tjenesten. Prøv igjen om litt.", (e as Error).message);
    }
    const data: any = await r.json().catch(() => null);
    if (!r.ok) {
      const melding = String(data?.error?.message ?? "");
      // Modellen kjenner ikke tenkenivået: prøv uten.
      if (r.status === 400 && tenking && /think/i.test(melding)) {
        tenking = false;
        continue;
      }
      // Opptatt (kvote eller overbelastet): én gang til etter en liten pause.
      if ((r.status === 429 || r.status >= 500) && forsok < 2 && Date.now() - start < 15_000) {
        await vent(1500);
        continue;
      }
      logg(r.status === 429 ? "WARNING" : "ERROR", "AI-tjenesten svarte med en feil", { status: r.status, feil: melding.slice(0, 500), modell: config.aiModell, region: config.aiRegion });
      const detaljer = `${r.status}: ${melding.slice(0, 500) || "uten melding"}`;
      if (r.status === 429) throw new AiFeil(503, "AI-tjenesten er opptatt akkurat nå. Prøv igjen om litt.", detaljer);
      if (r.status === 401 || r.status === 403 || r.status === 404) throw new AiFeil(503, "AI-tjenesten er ikke tilgjengelig akkurat nå.", detaljer);
      throw new AiFeil(502, "AI-tjenesten svarte med en feil. Prøv igjen.", detaljer);
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
    try {
      return { data: JSON.parse(tekst) as T, ...tokens };
    } catch {
      logg("WARNING", "Svaret fra AI-en var ikke JSON", { grunn, lengde: tekst.length });
      throw new AiFeil(
        502,
        grunn === "MAX_TOKENS" ? "Svaret fra AI-en ble for langt. Prøv med en kortere beskrivelse." : "AI-en svarte ikke i riktig format. Prøv igjen.",
        grunn,
      );
    }
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
