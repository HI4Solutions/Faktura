// ID-porten (Digdir): innloggingen for den som sender mva-meldingen (mvaInnsending.ts,
// docs/mva-innsending.md). Appen er en OIDC-klient i ID-porten: en integrasjon av typen API-klient
// i Digdirs selvbetjening, eid av leverandøren (config.leverandorOrgnr), med appens
// tilbakeadresser. Innloggingen går med autorisasjonskode og PKCE:
//  - API-et lager adressen til ID-porten med state, nonce og PKCE-utfordringen (verifikatoren lagres
//    på innsendingen) og sender brukeren dit;
//  - ID-porten sender brukeren tilbake til appen med koden, og workeren bytter den mot tokenene
//    med klientens private nøkkel (private_key_jwt, som Digdir anbefaler) eller hemmelighet
//    (client_secret_basic). Dem har bare workeren;
//  - ID-tokenet sjekkes: signaturen mot ID-portens nøkler, utstederen, mottakeren (klienten), nonce
//    og utløpet.
// Adressene (authorize, token og nøklene) hentes fra ID-portens oppsett for utstederen
// (/.well-known/openid-configuration; test.idporten.no i test, idporten.no i produksjon).
// https://docs.digdir.no/docs/idporten/oidc/oidc_protocol_authorize
// https://docs.digdir.no/docs/idporten/oidc/oidc_protocol_token
import { createHash, createPublicKey, randomBytes, randomUUID, sign, verify, type webcrypto } from "node:crypto";
import { config } from "./config.js";
import { adresser, EtatFeil, etatFetch } from "./maskinporten.js";

// Scopene: validering av mva-meldingen hos Skatteetaten, og instansene i Skatteetatens app i Altinn.
export const IDPORTEN_SCOPE = "openid skatteetaten:mvameldingvalidering altinn:instances.read altinn:instances.write";

// Satt opp: klienten finnes (appen viser innsendingen). Nøkkelen eller hemmeligheten har bare workeren.
export const idportenSattOpp = () => Boolean(config.idportenKlientId);
// Mva-meldingen kan sendes fra appen: slått på, og klienten finnes.
export const mvaInnsendingPaa = () => config.mvaInnsending && idportenSattOpp();

type Oppsett = { issuer: string; authorization_endpoint: string; token_endpoint: string; jwks_uri: string };
let oppsett: { for: string; data: Oppsett; hentet: number } | null = null;
// ID-portens offentlige nøkler (JWK).
type Jwk = webcrypto.JsonWebKey & { kid?: string };
let nokler: { for: string; keys: Jwk[]; hentet: number } | null = null;
export function glemIdportenOppsett() {
  oppsett = null;
  nokler = null;
}

async function hentJson(url: string, hva: string): Promise<any> {
  let r: Response;
  try {
    r = await etatFetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
  } catch (e) {
    throw new EtatFeil(`Fikk ikke svar fra ID-porten (${hva}): ${(e as Error).message}`, 0);
  }
  const data: any = await r.json().catch(() => null);
  if (!r.ok || !data) throw new EtatFeil(`ID-porten svarte ${r.status} på ${hva}`, r.status >= 500 ? r.status : 502);
  return data;
}

// ID-portens oppsett for utstederen (gjenbrukes en time).
export async function idportenOppsett(): Promise<Oppsett> {
  const utsteder = adresser().idporten.replace(/\/+$/, "");
  if (oppsett?.for === utsteder && oppsett.hentet > Date.now() - 3600_000) return oppsett.data;
  const d = await hentJson(`${utsteder}/.well-known/openid-configuration`, "oppsettet");
  for (const k of ["issuer", "authorization_endpoint", "token_endpoint", "jwks_uri"] as const)
    if (typeof d[k] !== "string") throw new EtatFeil(`ID-portens oppsett mangler ${k}`, 502);
  oppsett = { for: utsteder, data: d, hentet: Date.now() };
  return d;
}

const b64 = (x: string | Buffer) => Buffer.from(x).toString("base64url");
const tilfeldig = (n = 32) => randomBytes(n).toString("base64url");

// PKCE: verifikatoren (hemmelig, lagres) og utfordringen (i adressen).
export function lagPkce() {
  const verifikator = tilfeldig(48);
  return { verifikator, utfordring: b64(createHash("sha256").update(verifikator).digest()) };
}
export const lagNonce = () => tilfeldig(24);

// Adressen brukeren sendes til i ID-porten. prompt=login: den som sender, logger inn på nytt, så
// riktig person sender (ikke en innlogging som fortsatt gjelder i nettleseren).
export async function autoriseringsadresse(v: { state: string; nonce: string; utfordring: string; tilbake: string }): Promise<string> {
  if (!config.idportenKlientId) throw new EtatFeil("Innloggingen med ID-porten er ikke satt opp (mangler klient-ID).", 503);
  const o = await idportenOppsett();
  const u = new URL(o.authorization_endpoint);
  u.search = new URLSearchParams({
    client_id: config.idportenKlientId,
    redirect_uri: v.tilbake,
    response_type: "code",
    scope: IDPORTEN_SCOPE,
    state: v.state,
    nonce: v.nonce,
    code_challenge: v.utfordring,
    code_challenge_method: "S256",
    acr_values: "idporten-loa-substantial",
    prompt: "login",
    ui_locales: "nb",
  }).toString();
  return u.toString();
}

// Klientens innlogging ved tokenbyttet: et JWT signert med den private nøkkelen (aud er
// utstederen), ellers hemmeligheten.
async function klientInnlogging(): Promise<{ hoder: Record<string, string>; felt: Record<string, string> }> {
  const klient = config.idportenKlientId;
  if (!klient) throw new EtatFeil("Innloggingen med ID-porten er ikke satt opp (mangler klient-ID).", 503);
  if (config.idportenNokkel) {
    if (!config.idportenNokkelId) throw new EtatFeil("Nøkkel-ID-en (kid) til ID-porten-klienten mangler.", 503);
    const o = await idportenOppsett();
    const naa = Math.floor(Date.now() / 1000);
    const hode = b64(JSON.stringify({ alg: "RS256", typ: "JWT", kid: config.idportenNokkelId }));
    const innhold = b64(JSON.stringify({ iss: klient, sub: klient, aud: o.issuer, iat: naa, exp: naa + 100, jti: randomUUID() }));
    let signatur: Buffer;
    try {
      signatur = sign("RSA-SHA256", Buffer.from(`${hode}.${innhold}`), config.idportenNokkel);
    } catch {
      throw new EtatFeil("Nøkkelen til ID-porten-klienten er ikke en gyldig privat RSA-nøkkel (PEM).", 503);
    }
    return {
      hoder: {},
      felt: { client_id: klient, client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer", client_assertion: `${hode}.${innhold}.${b64(signatur)}` },
    };
  }
  if (config.idportenHemmelighet) {
    const enc = (x: string) => encodeURIComponent(x);
    return { hoder: { authorization: `Basic ${Buffer.from(`${enc(klient)}:${enc(config.idportenHemmelighet)}`).toString("base64")}` }, felt: {} };
  }
  throw new EtatFeil("Nøkkelen (idporten-nokkel) eller hemmeligheten (idporten-klienthemmelighet) til ID-porten-klienten mangler i Secret Manager.", 503);
}

export type Idportentokener = { access_token: string; id_token: string; expires_in: number; scope: string };

// Bytter koden fra innloggingen mot tokenene. invalid_grant: koden er brukt eller utløpt.
export async function byttKode(v: { kode: string; verifikator: string; tilbake: string }): Promise<Idportentokener> {
  const o = await idportenOppsett();
  const k = await klientInnlogging();
  let r: Response;
  try {
    r = await etatFetch(o.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json", ...k.hoder },
      body: new URLSearchParams({ grant_type: "authorization_code", code: v.kode, redirect_uri: v.tilbake, code_verifier: v.verifikator, ...k.felt }).toString(),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    throw new EtatFeil(`Fikk ikke svar fra ID-porten: ${(e as Error).message}`, 0);
  }
  const data: any = await r.json().catch(() => null);
  if (!r.ok || typeof data?.access_token !== "string" || typeof data?.id_token !== "string") {
    const kode = typeof data?.error === "string" ? data.error : null;
    const tekst = typeof data?.error_description === "string" ? data.error_description : "";
    if (kode === "invalid_grant") throw new EtatFeil("Innloggingen i ID-porten er utløpt eller allerede brukt. Prøv igjen.", 400, kode);
    if (kode === "invalid_client")
      throw new EtatFeil(`ID-porten godtok ikke klienten (nøkkelen eller hemmeligheten)${tekst ? `: ${tekst}` : ""}.`, 401, kode);
    if (kode === "invalid_scope") throw new EtatFeil(`ID-porten-klienten har ikke tilgang til scopene${tekst ? `: ${tekst}` : ""}.`, 403, kode);
    throw new EtatFeil(`ID-porten svarte ${r.status}${kode ? ` (${kode})` : ""}${tekst ? `: ${tekst}` : ""}`, r.status >= 500 ? r.status : 502, kode);
  }
  return { access_token: data.access_token, id_token: data.id_token, expires_in: Number(data.expires_in) || 0, scope: String(data.scope ?? "") };
}

// Innholdet i et JWT (uten å sjekke signaturen).
export function jwtInnhold(jwt: string): any {
  try {
    return JSON.parse(Buffer.from(jwt.split(".")[1] ?? "", "base64url").toString());
  } catch {
    return null;
  }
}

async function nokkel(kid: string | undefined, nyHenting = false): Promise<Jwk | null> {
  const o = await idportenOppsett();
  if (nyHenting || !nokler || nokler.for !== o.jwks_uri || nokler.hentet < Date.now() - 3600_000) {
    const d = await hentJson(o.jwks_uri, "nøklene");
    nokler = { for: o.jwks_uri, keys: Array.isArray(d.keys) ? d.keys : [], hentet: Date.now() };
  }
  return nokler.keys.find((k) => k.kty === "RSA" && (!kid || k.kid === kid)) ?? null;
}

// Sjekker ID-tokenet og gir innholdet. Feiler når signaturen, utstederen, mottakeren, nonce eller
// utløpet ikke stemmer.
export async function sjekkIdToken(jwt: string, nonce: string, naa = Date.now()): Promise<Record<string, unknown>> {
  const deler = jwt.split(".");
  if (deler.length !== 3) throw new EtatFeil("ID-tokenet fra ID-porten er ikke et JWT", 502);
  let hode: any;
  try {
    hode = JSON.parse(Buffer.from(deler[0]!, "base64url").toString());
  } catch {
    throw new EtatFeil("ID-tokenet fra ID-porten er ikke et JWT", 502);
  }
  if (hode?.alg !== "RS256") throw new EtatFeil(`ID-tokenet er signert med ${hode?.alg ?? "ukjent algoritme"}, ikke RS256`, 502);
  const jwk = (await nokkel(hode.kid)) ?? (await nokkel(hode.kid, true));
  if (!jwk) throw new EtatFeil("Fant ikke nøkkelen ID-tokenet er signert med", 502);
  const gyldig = verify("RSA-SHA256", Buffer.from(`${deler[0]}.${deler[1]}`), createPublicKey({ key: jwk, format: "jwk" }), Buffer.from(deler[2]!, "base64url"));
  if (!gyldig) throw new EtatFeil("Signaturen på ID-tokenet stemmer ikke", 502);
  const c = jwtInnhold(jwt) ?? {};
  const o = await idportenOppsett();
  const sek = Math.floor(naa / 1000);
  const mottakere = Array.isArray(c.aud) ? c.aud : [c.aud];
  if (c.iss !== o.issuer) throw new EtatFeil("ID-tokenet er fra feil utsteder", 502);
  if (!mottakere.includes(config.idportenKlientId)) throw new EtatFeil("ID-tokenet er ikke til denne klienten", 502);
  if (typeof c.exp !== "number" || c.exp < sek - 60) throw new EtatFeil("ID-tokenet er utløpt", 400);
  if (c.nonce !== nonce) throw new EtatFeil("ID-tokenet hører ikke til denne innloggingen (nonce)", 400);
  return c;
}
