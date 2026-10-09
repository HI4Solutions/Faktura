// Maskinporten (Digdir): tilgangstoken til Altinn og Skatteetaten. Leverandøren av løsningen
// (config.leverandorOrgnr, Medinnova AS) har én klient i Maskinporten med en privat RSA-nøkkel;
// den offentlige nøkkelen er lagt inn på klienten i Samarbeidsportalen, med nøkkel-ID-en (kid)
// i config.maskinportenNokkelId. Tokenet bestilles med et JWT signert med nøkkelen (RFC 7523).
// Med kunde bestilles tokenet for systembrukeren kunden har gitt systemet i Altinn
// (authorization_details av typen urn:altinn:systemuser), og da gjelder det bare den kunden.
// https://docs.digdir.no/docs/Maskinporten/maskinporten_protocol_token
// https://docs.altinn.studio/nb/authorization/guides/system-vendor/system-user/usetoken/
import { randomUUID, sign } from "node:crypto";
import { config } from "./config.js";

// Én fetch for Maskinporten, Altinn og Skatteetaten, så testene kan svare for alle tre.
export let etatFetch: typeof fetch = (...a) => fetch(...a);
export function settEtatFetch(f: typeof fetch) {
  etatFetch = f;
  tokener.clear();
}

// Feil fra Maskinporten, Altinn eller Skatteetaten. status 0: fikk ikke svar.
export class EtatFeil extends Error {
  constructor(
    melding: string,
    readonly status: number,
    readonly kode: string | null = null,
  ) {
    super(melding);
  }
}

const ADRESSER = {
  test: { maskinporten: "https://test.maskinporten.no", altinn: "https://platform.tt02.altinn.no", skattekort: "https://api-test.sits.no/api/forskudd" },
  prod: { maskinporten: "https://maskinporten.no", altinn: "https://platform.altinn.no", skattekort: "https://api.skatteetaten.no/api/forskudd" },
};

export function adresser() {
  const a = ADRESSER[config.skatteetatenMiljo];
  return {
    maskinporten: config.maskinportenUrl ?? a.maskinporten,
    altinn: config.altinnUrl ?? a.altinn,
    skattekort: config.skattekortUrl ?? a.skattekort,
  };
}

// Systemet i Altinns systemregister: leverandørens organisasjonsnummer og et navn.
export const systemId = () => config.altinnSystemId ?? `${config.leverandorOrgnr}_lonn`;

// Satt opp: Maskinporten-klienten finnes (appen viser funksjonen). Nøkkelen har bare workeren.
export const skattekortSattOpp = () => Boolean(config.maskinportenKlientId);

export const SCOPE = {
  systemregister: "altinn:authentication/systemregister.write",
  foresporselLes: "altinn:authentication/systemuser.request.read",
  foresporselSkriv: "altinn:authentication/systemuser.request.write",
  skattekort: "skatteetaten:skattekorttilarbeidsgiver",
};

const b64 = (x: string | Buffer) => Buffer.from(x).toString("base64url");

// JWT-en tokenet bestilles med (gyldig i 100 sekunder; Maskinporten godtar høyst 120).
export function lagGrant(scope: string, kunde?: string, naa = Math.floor(Date.now() / 1000)): string {
  if (!config.maskinportenKlientId) throw new EtatFeil("Maskinporten er ikke satt opp (mangler klient-ID).", 503);
  if (!config.maskinportenNokkel) throw new EtatFeil("Nøkkelen til Maskinporten mangler. Legg den inn i Secret Manager (maskinporten-nokkel).", 503);
  if (!config.maskinportenNokkelId) throw new EtatFeil("Nøkkel-ID-en (kid) til Maskinporten mangler.", 503);
  const hode = b64(JSON.stringify({ alg: "RS256", typ: "JWT", kid: config.maskinportenNokkelId }));
  const innhold = b64(
    JSON.stringify({
      aud: `${adresser().maskinporten}/`,
      iss: config.maskinportenKlientId,
      scope,
      iat: naa,
      exp: naa + 100,
      jti: randomUUID(),
      ...(kunde
        ? { authorization_details: [{ type: "urn:altinn:systemuser", systemuser_org: { authority: "iso6523-actorid-upis", ID: `0192:${kunde}` } }] }
        : {}),
    }),
  );
  let signatur: Buffer;
  try {
    signatur = sign("RSA-SHA256", Buffer.from(`${hode}.${innhold}`), config.maskinportenNokkel);
  } catch {
    throw new EtatFeil("Nøkkelen til Maskinporten er ikke en gyldig privat RSA-nøkkel (PEM).", 503);
  }
  return `${hode}.${innhold}.${b64(signatur)}`;
}

// Feilen fra Maskinporten på norsk. MP-303 (invalid_altinn_customer_configuration): kunden har
// ikke (lenger) en systembruker for systemet, eller systemet mangler klient-ID-en.
function tokenfeil(data: any, status: number, kunde?: string): EtatFeil {
  const kode = typeof data?.error === "string" ? data.error : null;
  const tekst = typeof data?.error_description === "string" ? data.error_description : "";
  if (kode === "invalid_altinn_customer_configuration" || /MP-303/.test(tekst))
    return new EtatFeil(
      kunde
        ? "Altinn fant ingen godkjent systemtilgang for organisasjonen. Be om tilgang på nytt og godkjenn den i Altinn."
        : "Systemet er ikke riktig registrert i Altinn (klient-ID-en mangler i systemregisteret).",
      403,
      "MP-303",
    );
  if (kode === "invalid_scope") return new EtatFeil(`Maskinporten-klienten har ikke tilgang til scopet: ${tekst || "ukjent"}`, 403, kode);
  return new EtatFeil(`Maskinporten svarte ${status}${kode ? ` (${kode})` : ""}${tekst ? `: ${tekst}` : ""}`, status, kode);
}

// Tokenene gjenbrukes til de nesten er utløpt (per scope og kunde).
const tokener = new Map<string, { token: string; utloper: number }>();

export async function hentToken(scope: string, kunde?: string): Promise<string> {
  const nokkel = `${scope}|${kunde ?? ""}`;
  const lagret = tokener.get(nokkel);
  if (lagret && lagret.utloper > Date.now()) return lagret.token;
  let r: Response;
  try {
    r = await etatFetch(`${adresser().maskinporten}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: lagGrant(scope, kunde) }).toString(),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    if (e instanceof EtatFeil) throw e;
    throw new EtatFeil(`Fikk ikke svar fra Maskinporten: ${(e as Error).message}`, 0);
  }
  const data: any = await r.json().catch(() => null);
  if (!r.ok || typeof data?.access_token !== "string") throw tokenfeil(data, r.status, kunde);
  const sek = Number(data.expires_in) > 0 ? Number(data.expires_in) : 120;
  tokener.set(nokkel, { token: data.access_token, utloper: Date.now() + Math.max(10, sek - 60) * 1000 });
  return data.access_token;
}

// Kall med token. Gir svaret som JSON (null uten innhold), eller kaster EtatFeil med meldingen.
export async function etatKall(
  url: string,
  token: string,
  valg: { metode?: "GET" | "POST" | "PUT" | "DELETE"; kropp?: unknown; hvem: string },
): Promise<{ status: number; data: any; tekst: string; headers: Headers }> {
  let r: Response;
  try {
    r = await etatFetch(url, {
      method: valg.metode ?? "GET",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        ...(valg.kropp === undefined ? {} : { "content-type": "application/json" }),
      },
      body: valg.kropp === undefined ? undefined : JSON.stringify(valg.kropp),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (e) {
    throw new EtatFeil(`Fikk ikke svar fra ${valg.hvem}: ${(e as Error).message}`, 0);
  }
  const tekst = await r.text().catch(() => "");
  let data: any = null;
  try {
    data = tekst ? JSON.parse(tekst) : null;
  } catch {
    data = null;
  }
  return { status: r.status, data, tekst, headers: r.headers };
}
