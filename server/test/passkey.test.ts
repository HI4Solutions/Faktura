// Passkeys ende til ende med en programvare-autentikator (ES256, attestasjon «none»).
import { describe, expect, it, beforeAll } from "vitest";
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { lagApi } from "../src/api.js";
import { config } from "../src/config.js";
import { settInnloggingstoken } from "../src/passkey.js";

const harDb = Boolean(process.env.DATABASE_URL);
const app = lagApi();
const ORIGIN = "http://localhost:5173";
const RPID = "localhost";
const bruker = "Bearer test:uid-pk:pk@server.test";

// --- Minimal CBOR-koding (nok for WebAuthn) ---------------------------------
function hode(major: number, n: number): Buffer {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 256) return Buffer.from([(major << 5) | 24, n]);
  const b = Buffer.alloc(3);
  b[0] = (major << 5) | 25;
  b.writeUInt16BE(n, 1);
  return b;
}
function cbor(v: unknown): Buffer {
  if (typeof v === "number") return v >= 0 ? hode(0, v) : hode(1, -1 - v);
  if (typeof v === "string") return Buffer.concat([hode(3, Buffer.byteLength(v)), Buffer.from(v)]);
  if (v instanceof Uint8Array) return Buffer.concat([hode(2, v.length), Buffer.from(v)]);
  if (v instanceof Map) return Buffer.concat([hode(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
  throw new Error("ukjent type");
}

const b64u = (b: Uint8Array) => Buffer.from(b).toString("base64url");
const sha256 = (b: Uint8Array | string) => createHash("sha256").update(b).digest();

class Autentikator {
  privat: KeyObject;
  offentlig: KeyObject;
  id = randomBytes(16);
  teller = 0;
  constructor() {
    const par = generateKeyPairSync("ec", { namedCurve: "P-256" });
    this.privat = par.privateKey;
    this.offentlig = par.publicKey;
  }

  registrer(valg: any, origin = ORIGIN) {
    const jwk = this.offentlig.export({ format: "jwk" });
    const cose = cbor(new Map<number, unknown>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x!, "base64url")], [-3, Buffer.from(jwk.y!, "base64url")]]));
    const idLengde = Buffer.alloc(2);
    idLengde.writeUInt16BE(this.id.length);
    const authData = Buffer.concat([sha256(valg.rp.id), Buffer.from([0x45]), Buffer.alloc(4), Buffer.alloc(16), idLengde, this.id, cose]);
    const clientData = Buffer.from(JSON.stringify({ type: "webauthn.create", challenge: valg.challenge, origin, crossOrigin: false }));
    const attestasjon = cbor(new Map<string, unknown>([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]]));
    return {
      id: b64u(this.id),
      rawId: b64u(this.id),
      type: "public-key",
      response: { clientDataJSON: b64u(clientData), attestationObject: b64u(attestasjon), transports: ["internal"] },
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
    };
  }

  loggInn(valg: any, origin = ORIGIN, rpid = RPID) {
    this.teller += 1;
    const t = Buffer.alloc(4);
    t.writeUInt32BE(this.teller);
    const authData = Buffer.concat([sha256(rpid), Buffer.from([0x05]), t]);
    const clientData = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge: valg.challenge, origin, crossOrigin: false }));
    const signatur = sign("sha256", Buffer.concat([authData, sha256(clientData)]), this.privat);
    return {
      id: b64u(this.id),
      rawId: b64u(this.id),
      type: "public-key",
      response: { clientDataJSON: b64u(clientData), authenticatorData: b64u(authData), signature: b64u(signatur) },
      clientExtensionResults: {},
    };
  }
}

async function kall(metode: string, sti: string, token: string | null, kropp?: unknown, hoder: Record<string, string> = {}) {
  const r = await app.request(sti, {
    method: metode,
    headers: { ...(token ? { authorization: token } : {}), "content-type": "application/json", ...hoder },
    body: kropp === undefined ? undefined : JSON.stringify(kropp),
  });
  return { status: r.status, data: r.status === 204 ? null : ((await r.json()) as any) };
}

describe.skipIf(!harDb)("passkeys", () => {
  const nokkel = new Autentikator();
  const tokens: string[] = [];

  beforeAll(() => {
    settInnloggingstoken(async (uid) => {
      tokens.push(uid);
      return `custom-token-for-${uid}`;
    });
  });

  it("registrerer en passkey", async () => {
    const start = await kall("POST", "/api/passkeys/registrering/start", bruker);
    expect(start.status).toBe(200);
    expect(start.data.valg.rp.id).toBe(RPID);
    expect(start.data.valg.authenticatorSelection.userVerification).toBe("required");

    const ferdig = await kall("POST", "/api/passkeys/registrering/fullfor", bruker, {
      utfordring_id: start.data.utfordring_id,
      svar: nokkel.registrer(start.data.valg),
      navn: "Testnøkkel",
    });
    expect(ferdig.status).toBe(201);
    expect(ferdig.data.navn).toBe("Testnøkkel");

    // Samme utfordring kan ikke brukes igjen.
    const igjen = await kall("POST", "/api/passkeys/registrering/fullfor", bruker, { utfordring_id: start.data.utfordring_id, svar: nokkel.registrer(start.data.valg) });
    expect(igjen.status).toBe(400);

    expect((await kall("GET", "/api/passkeys", bruker)).data).toHaveLength(1);
    expect((await kall("GET", "/api/passkeys", "Bearer test:uid-annen:annen@server.test")).data).toHaveLength(0);
  });

  it("logger inn uten Firebase-token og gir custom token", async () => {
    const start = await kall("POST", "/api/offentlig/passkey/start", null);
    expect(start.status).toBe(200);
    const ferdig = await kall("POST", "/api/offentlig/passkey/fullfor", null, { utfordring_id: start.data.utfordring_id, svar: nokkel.loggInn(start.data.valg) });
    expect(ferdig.status).toBe(200);
    expect(ferdig.data.token).toBe("custom-token-for-uid-pk");
  });

  it("avviser feil signatur og ukjent nøkkel", async () => {
    const start = await kall("POST", "/api/offentlig/passkey/start", null);
    const svar = nokkel.loggInn(start.data.valg);
    svar.response.signature = b64u(randomBytes(70));
    expect((await kall("POST", "/api/offentlig/passkey/fullfor", null, { utfordring_id: start.data.utfordring_id, svar })).status).toBe(401);

    const start2 = await kall("POST", "/api/offentlig/passkey/start", null);
    const ukjent = new Autentikator().loggInn(start2.data.valg);
    expect((await kall("POST", "/api/offentlig/passkey/fullfor", null, { utfordring_id: start2.data.utfordring_id, svar: ukjent })).status).toBe(401);
  });

  it("bekrefter applåsen med egen passkey (Face ID / Touch ID)", async () => {
    const start = await kall("POST", "/api/passkeys/bekreft/start", bruker);
    expect(start.status).toBe(200);
    expect(start.data.valg.userVerification).toBe("required");
    expect(start.data.valg.allowCredentials.map((c: any) => c.id)).toEqual([b64u(nokkel.id)]);
    const ok = await kall("POST", "/api/passkeys/bekreft/fullfor", bruker, { utfordring_id: start.data.utfordring_id, svar: nokkel.loggInn(start.data.valg) });
    expect(ok).toEqual({ status: 200, data: { ok: true } });
    // Utfordringen kan bare brukes én gang.
    expect((await kall("POST", "/api/passkeys/bekreft/fullfor", bruker, { utfordring_id: start.data.utfordring_id, svar: nokkel.loggInn(start.data.valg) })).status).toBe(400);

    // En passkey som ikke hører til kontoen, låser ikke opp.
    const start2 = await kall("POST", "/api/passkeys/bekreft/start", bruker);
    const fremmed = new Autentikator().loggInn(start2.data.valg);
    expect((await kall("POST", "/api/passkeys/bekreft/fullfor", bruker, { utfordring_id: start2.data.utfordring_id, svar: fremmed })).status).toBe(401);

    // Feil signatur avvises.
    const start3 = await kall("POST", "/api/passkeys/bekreft/start", bruker);
    const feil = nokkel.loggInn(start3.data.valg);
    feil.response.signature = b64u(randomBytes(70));
    expect((await kall("POST", "/api/passkeys/bekreft/fullfor", bruker, { utfordring_id: start3.data.utfordring_id, svar: feil })).status).toBe(401);

    // Uten passkeys: tydelig beskjed.
    const annen = await kall("POST", "/api/passkeys/bekreft/start", "Bearer test:uid-annen:annen@server.test");
    expect(annen.status).toBe(409);
    expect(annen.data.error).toContain("Legg til en passkey");

    // Andres utfordring kan ikke brukes.
    const start4 = await kall("POST", "/api/passkeys/bekreft/start", bruker);
    expect((await kall("POST", "/api/passkeys/bekreft/fullfor", "Bearer test:uid-annen:annen@server.test", { utfordring_id: start4.data.utfordring_id, svar: nokkel.loggInn(start4.data.valg) })).status).toBe(400);
  });

  it("sletter passkeyen", async () => {
    const liste = await kall("GET", "/api/passkeys", bruker);
    expect((await kall("DELETE", `/api/passkeys/${encodeURIComponent(liste.data[0].id)}`, "Bearer test:uid-annen:annen@server.test")).status).toBe(404);
    expect((await kall("DELETE", `/api/passkeys/${encodeURIComponent(liste.data[0].id)}`, bruker)).status).toBe(204);
  });

  // Appen svarer på flere domener (docs/domene.md): en passkey lages og brukes på domenet
  // brukeren er på, og husker det.
  it("passkeys per domene når appen svarer på flere", async () => {
    const NY = "https://ny.test";
    const for_ = config.andreAppUrler;
    (config as any).andreAppUrler = [NY];
    try {
      const her = new Autentikator();
      const der = new Autentikator();
      const lag = async (a: Autentikator, origin: string) => {
        const start = await kall("POST", "/api/passkeys/registrering/start", bruker, undefined, { origin });
        const ferdig = await kall("POST", "/api/passkeys/registrering/fullfor", bruker, { utfordring_id: start.data.utfordring_id, svar: a.registrer(start.data.valg, origin) }, { origin });
        return { rp: start.data.valg.rp.id, ferdig };
      };
      const a = await lag(her, ORIGIN);
      const b = await lag(der, NY);
      expect([a.rp, a.ferdig.status, a.ferdig.data.rp_id]).toEqual([RPID, 201, RPID]);
      expect([b.rp, b.ferdig.status, b.ferdig.data.rp_id]).toEqual(["ny.test", 201, "ny.test"]);
      expect((await kall("GET", "/api/passkeys", bruker)).data.map((p: any) => p.rp_id).sort()).toEqual(["localhost", "ny.test"]);

      // Innlogging på det andre domenet.
      const inn = await kall("POST", "/api/offentlig/passkey/start", null, undefined, { origin: NY });
      expect(inn.data.valg.rpId).toBe("ny.test");
      const ok = await kall("POST", "/api/offentlig/passkey/fullfor", null, { utfordring_id: inn.data.utfordring_id, svar: der.loggInn(inn.data.valg, NY, "ny.test") }, { origin: NY });
      expect(ok).toEqual({ status: 200, data: { token: "custom-token-for-uid-pk" } });

      // Applåsen spør bare etter passkeyene som virker der brukeren er.
      const las = await kall("POST", "/api/passkeys/bekreft/start", bruker, undefined, { origin: NY });
      expect(las.data.valg.allowCredentials.map((c: any) => c.id)).toEqual([b64u(der.id)]);
      const lasHer = await kall("POST", "/api/passkeys/bekreft/start", bruker, undefined, { referer: `${ORIGIN}/innstillinger` });
      expect(lasHer.data.valg.allowCredentials.map((c: any) => c.id)).toEqual([b64u(her.id)]);

      // En passkey fra et domene appen ikke svarer på, godtas ikke.
      const start = await kall("POST", "/api/offentlig/passkey/start", null, undefined, { origin: NY });
      const fremmed = der.loggInn(start.data.valg, "https://angriper.test", "angriper.test");
      expect((await kall("POST", "/api/offentlig/passkey/fullfor", null, { utfordring_id: start.data.utfordring_id, svar: fremmed })).status).toBe(401);

      // En annen nettside får hoveddomenet.
      expect((await kall("POST", "/api/offentlig/passkey/start", null, undefined, { origin: "https://angriper.test" })).data.valg.rpId).toBe(RPID);

      // Uten passkey for domenet: beskjed om å legge til en der.
      (config as any).andreAppUrler = [NY, "https://tredje.test"];
      const tom = await kall("POST", "/api/passkeys/bekreft/start", bruker, undefined, { origin: "https://tredje.test" });
      expect(tom).toMatchObject({ status: 409, data: { error: expect.stringContaining("ingen passkey for tredje.test") } });
    } finally {
      (config as any).andreAppUrler = for_;
    }
  });
});
