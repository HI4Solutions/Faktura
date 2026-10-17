// Maskinporten-klienten til Admin Konsoll: den offentlige nøkkelen (JWK) til Samarbeidsportalen, og
// en sjekk av hvilke scopes klienten får token for. Kjøres av scripts/maskinporten.sh i Cloud Shell,
// som sender den private nøkkelen fra Secret Manager inn på stdin. Nøkkelen skrives aldri til disk
// eller skjermen, og tokenene vises ikke.
//
//   node scripts/maskinporten.mjs jwk <kid>                           < privat.pem
//   node scripts/maskinporten.mjs sjekk <test|prod> <klient-id> <kid> < privat.pem
//
// MASKINPORTEN_URL overstyrer adressen til Maskinporten.
import { createPrivateKey, createPublicKey, randomUUID, sign } from "node:crypto";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

// Scopene appen bruker (SCOPE i server/src/maskinporten.ts; testen passer på at listene er like), og
// hva de trengs til.
export const SCOPES = [
  ["altinn:authentication/systemregister.write", "Altinn: registrere systemet"],
  ["altinn:authentication/systemuser.request.read", "Altinn: se forespørslene om tilgang"],
  ["altinn:authentication/systemuser.request.write", "Altinn: be kundene om tilgang"],
  ["skatteetaten:skattekorttilarbeidsgiver", "Skattekort"],
  ["skatteetaten:innrapporteringamelding", "A-meldingen og avstemmingsrapporten"],
  ["digdir:dialogporten", "Tilbakemeldingen på a-meldingen"],
  ["nav:helseytelser/sykepenger", "Sykepenger fra NAV"],
  ["skatteetaten:kravogbetalinger", "Krav og betalinger"],
  ["skatteetaten:frister", "Frister"],
];

export const MASKINPORTEN = { test: "https://test.maskinporten.no", prod: "https://maskinporten.no" };

const b64 = (x) => Buffer.from(x).toString("base64url");

// Den private nøkkelen (PEM). Plassholderen fra Terraform («ikke-satt») er ingen nøkkel.
export function privatNokkel(pem) {
  let k;
  try {
    k = createPrivateKey(pem);
  } catch {
    throw new Error("Hemmeligheten er ikke en privat nøkkel (PEM). Er nøkkelen lagt inn?");
  }
  if (k.asymmetricKeyType !== "rsa") throw new Error("Nøkkelen er ikke en RSA-nøkkel.");
  return k;
}

// Den offentlige delen som JWK, slik den legges inn på klienten i Samarbeidsportalen.
export function jwk(nokkel, kid) {
  const j = createPublicKey(nokkel).export({ format: "jwk" });
  return { kty: j.kty, e: j.e, n: j.n, kid, alg: "RS256", use: "sig" };
}

// JWT-en tokenet bestilles med, som lagGrant i server/src/maskinporten.ts (uten kunde).
export function grant({ url, klientId, kid, scope, nokkel, naa = Math.floor(Date.now() / 1000) }) {
  const hode = b64(JSON.stringify({ alg: "RS256", typ: "JWT", kid }));
  const innhold = b64(JSON.stringify({ aud: `${url}/`, iss: klientId, scope, iat: naa, exp: naa + 100, jti: randomUUID() }));
  return `${hode}.${innhold}.${b64(sign("RSA-SHA256", Buffer.from(`${hode}.${innhold}`), nokkel))}`;
}

// Ber om et token for scopet. null: det virket. Ellers feilen fra Maskinporten.
export async function provScope({ url, klientId, kid, scope, nokkel, hent = fetch }) {
  let r;
  try {
    r = await hent(`${url}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: grant({ url, klientId, kid, scope, nokkel }),
      }).toString(),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    return { kode: "ingen svar", tekst: e.message };
  }
  const data = await r.json().catch(() => null);
  if (r.ok && typeof data?.access_token === "string") return null;
  return {
    kode: typeof data?.error === "string" ? data.error : `HTTP ${r.status}`,
    tekst: typeof data?.error_description === "string" ? data.error_description : "",
  };
}

const MANGLER_SCOPE =
  "invalid_scope: scopet er ikke lagt på klienten, eller Medinnova har ikke fått tilgang til det ennå (Tilganger i Samarbeidsportalen viser hva dere har fått).";
// Feil med klienten eller nøkkelen: da feiler alle scopene likt.
const KLIENTFEIL = new Set(["invalid_client", "invalid_grant", "unauthorized_client"]);

// Prøver alle scopene. Gir linjene som skal skrives ut, og om alle virket.
export async function sjekk({ miljo, klientId, kid, nokkel, url = MASKINPORTEN[miljo], hent = fetch }) {
  url = url.replace(/\/+$/, "");
  const navn = miljo === "prod" ? "produksjon" : "test";
  const svar = [];
  for (const [scope, bruk] of SCOPES) svar.push({ scope, bruk, feil: await provScope({ url, klientId, kid, scope, nokkel, hent }) });
  const feilet = svar.filter((s) => s.feil);
  const linjer = [`Maskinporten ${navn} (${url}), klient ${klientId}, nøkkel-ID ${kid}`, ""];
  const f = feilet[0]?.feil;
  if (feilet.length === svar.length && feilet.every((s) => s.feil.kode === f.kode && s.feil.tekst === f.tekst)) {
    linjer.push(`✗ Alle scopene feilet: ${f.kode}${f.tekst ? `: ${f.tekst}` : ""}`);
    if (KLIENTFEIL.has(f.kode))
      linjer.push(
        "",
        `Klient-ID-en, nøkkelen eller nøkkel-ID-en (kid) stemmer ikke med klienten i Samarbeidsportalen for ${navn}. Sjekk at den offentlige nøkkelen fra «nokkel» er lagt inn på klienten, og at KLIENT_ID og NOKKEL_ID er riktige.`,
      );
    else if (f.kode === "invalid_scope") linjer.push("", MANGLER_SCOPE);
  } else {
    for (const s of svar) {
      linjer.push(`${s.feil ? "✗" : "✓"} ${s.scope}  (${s.bruk})`);
      if (s.feil) linjer.push(`    ${s.feil.kode}${s.feil.tekst ? `: ${s.feil.tekst}` : ""}`);
    }
    linjer.push("", `${svar.length - feilet.length} av ${svar.length} scopes virker.`);
    if (feilet.some((s) => s.feil.kode === "invalid_scope")) linjer.push(MANGLER_SCOPE);
  }
  return { ok: feilet.length === 0, linjer };
}

async function lesStdin() {
  let s = "";
  for await (const del of process.stdin) s += del;
  return s;
}

async function main([kommando, ...arg]) {
  if (kommando === "jwk" && arg.length === 1) {
    console.log(JSON.stringify(jwk(privatNokkel(await lesStdin()), arg[0])));
    return 0;
  }
  if (kommando === "sjekk" && arg.length === 3 && (arg[0] === "test" || arg[0] === "prod")) {
    const [miljo, klientId, kid] = arg;
    const nokkel = privatNokkel(await lesStdin());
    const r = await sjekk({ miljo, klientId, kid, nokkel, url: process.env.MASKINPORTEN_URL || MASKINPORTEN[miljo] });
    console.log(r.linjer.join("\n"));
    return r.ok ? 0 : 1;
  }
  console.error("Bruk: node scripts/maskinporten.mjs jwk <kid> | sjekk <test|prod> <klient-id> <kid>, med den private nøkkelen på stdin");
  return 2;
}

// Bare når skriptet kjøres, ikke når testen importerer det.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main(process.argv.slice(2)).then(
    (kode) => {
      process.exitCode = kode;
    },
    (e) => {
      console.error(e.message);
      process.exitCode = 2;
    },
  );
}
