// scripts/maskinporten.mjs: sjekken av Maskinporten-klienten som kjøres i Cloud Shell før
// produksjon slås på (docs/miljoer.md). Scopene er de appen bruker, JWT-en er riktig signert, og
// svarene fra Maskinporten tolkes (med Maskinporten som svarer i testen).
import { describe, expect, it } from "vitest";
import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { SCOPE } from "../src/maskinporten.js";
import { grant, jwk, privatNokkel, sjekk, SCOPES } from "../../scripts/maskinporten.mjs";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const nokkel = privatNokkel(privateKey);
const URL_PROD = "https://maskinporten.no";
const ALLE = SCOPES.map(([s]: [string, string]) => s);

// Maskinporten som godtar klienten «klient-1» med nøkkel-ID-en «medinnova-prod-1» og scopene i
// «tillatt», og sjekker forespørselen slik Maskinporten gjør.
function maskinporten(tillatt: string[]) {
  const offentlig = createPublicKey({ key: jwk(nokkel, "medinnova-prod-1"), format: "jwk" });
  const scopes: string[] = [];
  const svar = (status: number, data: unknown) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
  const hent = async (adresse: string, init: RequestInit) => {
    expect(adresse).toBe(`${URL_PROD}/token`);
    const p = new URLSearchParams(String(init.body));
    expect(p.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    const [h, i, s] = p.get("assertion")!.split(".");
    const hode = JSON.parse(Buffer.from(h, "base64url").toString());
    const innhold = JSON.parse(Buffer.from(i, "base64url").toString());
    scopes.push(innhold.scope);
    const gyldig = verify("RSA-SHA256", Buffer.from(`${h}.${i}`), offentlig, Buffer.from(s, "base64url"));
    if (hode.kid !== "medinnova-prod-1" || innhold.iss !== "klient-1" || !gyldig)
      return svar(400, { error: "invalid_grant", error_description: "Invalid assertion. Client authentication failed." });
    expect(innhold.aud).toBe(`${URL_PROD}/`);
    expect(innhold.exp - innhold.iat).toBe(100);
    if (!tillatt.includes(innhold.scope)) return svar(400, { error: "invalid_scope", error_description: `Scope ${innhold.scope} not allowed` });
    return svar(200, { access_token: "hemmelig-token", expires_in: 120, scope: innhold.scope });
  };
  return { hent: hent as unknown as typeof fetch, scopes };
}

describe("sjekken av Maskinporten-klienten (scripts/maskinporten.mjs)", () => {
  it("prøver de samme scopene som appen bruker", () => {
    expect([...ALLE].sort()).toEqual(Object.values(SCOPE).sort());
  });

  it("JWK-en er den offentlige delen av nøkkelen, med nøkkel-ID-en", () => {
    const j = jwk(nokkel, "medinnova-prod-1");
    expect(j).toMatchObject({ kty: "RSA", kid: "medinnova-prod-1", alg: "RS256", use: "sig" });
    expect(Object.keys(j).sort()).toEqual(["alg", "e", "kid", "kty", "n", "use"]);
    const fraJwk = createPublicKey({ key: j, format: "jwk" }).export({ type: "spki", format: "pem" });
    expect(fraJwk).toBe(createPublicKey(privateKey).export({ type: "spki", format: "pem" }));
  });

  it("JWT-en er signert med nøkkelen og har det Maskinporten krever", () => {
    const jwt = grant({ url: URL_PROD, klientId: "klient-1", kid: "k1", scope: "skatteetaten:frister", nokkel, naa: 1_700_000_000 });
    const [h, i, s] = jwt.split(".");
    expect(verify("RSA-SHA256", Buffer.from(`${h}.${i}`), createPublicKey(privateKey), Buffer.from(s, "base64url"))).toBe(true);
    expect(JSON.parse(Buffer.from(h, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT", kid: "k1" });
    expect(JSON.parse(Buffer.from(i, "base64url").toString())).toMatchObject({
      aud: "https://maskinporten.no/",
      iss: "klient-1",
      scope: "skatteetaten:frister",
      iat: 1_700_000_000,
      exp: 1_700_000_100,
    });
  });

  it("alle scopene virker: hvert scope får sitt token, og tokenene vises ikke", async () => {
    const mp = maskinporten(ALLE);
    // Skråstreken til slutt i adressen gir ikke dobbel skråstrek.
    const r = await sjekk({ miljo: "prod", klientId: "klient-1", kid: "medinnova-prod-1", nokkel, url: `${URL_PROD}/`, hent: mp.hent });
    expect(r.ok).toBe(true);
    expect(mp.scopes).toEqual(ALLE);
    const tekst = r.linjer.join("\n");
    expect(tekst).toContain("Maskinporten produksjon (https://maskinporten.no), klient klient-1, nøkkel-ID medinnova-prod-1");
    expect(tekst).toContain("✓ skatteetaten:innrapporteringamelding  (A-meldingen og avstemmingsrapporten)");
    expect(tekst).toContain("10 av 10 scopes virker.");
    expect(tekst).not.toContain("✗");
    expect(tekst).not.toContain("hemmelig-token");
  });

  it("scopes som mangler, vises hver for seg med feilen fra Maskinporten", async () => {
    const mp = maskinporten(ALLE.filter((s: string) => s !== "skatteetaten:kravogbetalinger" && s !== "skatteetaten:frister"));
    const r = await sjekk({ miljo: "prod", klientId: "klient-1", kid: "medinnova-prod-1", nokkel, url: URL_PROD, hent: mp.hent });
    expect(r.ok).toBe(false);
    const tekst = r.linjer.join("\n");
    expect(tekst).toContain("✓ skatteetaten:skattekorttilarbeidsgiver  (Skattekort)");
    expect(tekst).toContain("✗ skatteetaten:kravogbetalinger  (Krav og betalinger)\n    invalid_scope: Scope skatteetaten:kravogbetalinger not allowed");
    expect(tekst).toContain("✗ skatteetaten:frister  (Frister)");
    expect(tekst).toContain("8 av 10 scopes virker.");
    expect(tekst).toContain("Tilganger i Samarbeidsportalen");
  });

  it("feil nøkkel-ID (eller nøkkel eller klient): én forklaring i stedet for ni like feil", async () => {
    const mp = maskinporten(ALLE);
    const r = await sjekk({ miljo: "prod", klientId: "klient-1", kid: "feil-kid", nokkel, url: URL_PROD, hent: mp.hent });
    expect(r.ok).toBe(false);
    expect(mp.scopes).toHaveLength(10);
    const tekst = r.linjer.join("\n");
    expect(tekst).toContain("✗ Alle scopene feilet: invalid_grant: Invalid assertion. Client authentication failed.");
    expect(tekst).toContain("stemmer ikke med klienten i Samarbeidsportalen for produksjon");
    expect(tekst).not.toContain("av 9 scopes virker");
  });

  it("like feil med hver sin trace_id (slik Maskinporten svarer) gir én forklaring", async () => {
    let n = 0;
    const hent = (async () =>
      new Response(
        JSON.stringify({ error: "invalid_grant", error_description: `Invalid assertion. Client authentication failed. Invalid JWT signature. (trace_id: ${++n}abc)` }),
        { status: 400, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;
    const r = await sjekk({ miljo: "prod", klientId: "klient-1", kid: "medinnova-prod-1", nokkel, url: URL_PROD, hent });
    const tekst = r.linjer.join("\n");
    expect(tekst).toContain("✗ Alle scopene feilet: invalid_grant: Invalid assertion. Client authentication failed. Invalid JWT signature. (trace_id: 1abc)");
    expect(tekst).toContain("stemmer ikke med klienten i Samarbeidsportalen for produksjon");
    expect(tekst).not.toContain("(trace_id: 2abc)");
  });

  it("uten svar fra Maskinporten", async () => {
    const hent = (async () => {
      throw new Error("getaddrinfo ENOTFOUND maskinporten.no");
    }) as unknown as typeof fetch;
    const r = await sjekk({ miljo: "test", klientId: "klient-1", kid: "medinnova-1", nokkel, url: "https://test.maskinporten.no", hent });
    expect(r.ok).toBe(false);
    expect(r.linjer.join("\n")).toContain("Maskinporten test (https://test.maskinporten.no)");
    expect(r.linjer.join("\n")).toContain("✗ Alle scopene feilet: ingen svar: getaddrinfo ENOTFOUND maskinporten.no");
  });

  it("plassholderen fra Terraform er ingen nøkkel", () => {
    expect(() => privatNokkel("ikke-satt")).toThrow("Hemmeligheten er ikke en privat nøkkel (PEM). Er nøkkelen lagt inn?");
  });
});
