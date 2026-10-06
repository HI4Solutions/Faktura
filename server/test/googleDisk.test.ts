import { describe, expect, it, beforeAll } from "vitest";
import { config } from "../src/config.js";
import { lagApi } from "../src/api.js";
import { lesState, settGoogleFetch, settKryptering, signerState } from "../src/googleDisk.js";

const c = config as any;

describe("Google Disk – state", () => {
  beforeAll(() => {
    c.googleClientId = "klient";
    c.googleClientSecret = "hemmelig";
  });
  it("signert state kan leses, men ikke forfalskes eller gjenbrukes etter utløp", () => {
    const s = signerState({ org: "o1", bruker: "b1" });
    expect(lesState(s)).toEqual({ org: "o1", bruker: "b1" });
    const [kropp] = s.split(".");
    const falsk = Buffer.from(JSON.stringify({ org: "annen", bruker: "b1", exp: Date.now() + 60000 })).toString("base64url");
    expect(() => lesState(`${falsk}.${s.split(".")[1]}`)).toThrow();
    expect(() => lesState(`${kropp}.feil`)).toThrow();
    expect(() => lesState(s, Date.now() + 11 * 60_000)).toThrow();
  });
});

describe.skipIf(!process.env.DATABASE_URL)("Google Disk – kobling", () => {
  const app = lagApi();
  const token = "Bearer test:uid-disk:disk@server.test:mfa";
  const kall: string[] = [];

  beforeAll(() => {
    c.googleClientId = "klient";
    c.googleClientSecret = "hemmelig";
    settKryptering(async (t) => Buffer.from(`kryptert:${t}`), async (b) => b.toString().replace("kryptert:", ""));
    settGoogleFetch((async (url: string | URL | Request) => {
      const u = String(url);
      kall.push(u);
      if (u.includes("oauth2.googleapis.com/token")) return Response.json({ access_token: "at", refresh_token: "rt" });
      if (u.includes("/drive/v3/files")) return Response.json({ id: "mappe-1" });
      return new Response("{}", { status: 404 });
    }) as typeof fetch);
  });

  it("start gir Google-URL med drive.file, callback lagrer kryptert token", async () => {
    const o = await (await app.request("/api/organisasjoner", { method: "POST", headers: { authorization: token, "content-type": "application/json" }, body: JSON.stringify({ navn: "Disk AS" }) })).json() as any;
    const start = await (await app.request(`/api/org/${o.id}/integrasjoner/google-disk/start`, { method: "POST", headers: { authorization: token } })).json() as any;
    const url = new URL(start.url);
    expect(url.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/drive.file");
    expect(url.searchParams.get("access_type")).toBe("offline");

    const cb = await app.request(`/api/offentlig/google/callback?code=abc&state=${encodeURIComponent(url.searchParams.get("state")!)}`);
    expect(cb.status).toBe(302);
    expect(cb.headers.get("location")).toContain("disk=ok");
    expect(kall.some((k) => k.includes("/drive/v3/files"))).toBe(true);

    const liste = await (await app.request(`/api/org/${o.id}/integrasjoner`, { headers: { authorization: token } })).json() as any;
    expect(liste.integrasjoner[0]).toMatchObject({ type: "google_drive", status: "aktiv", konfig: { rotmappe: "mappe-1" } });

    const annen = "Bearer test:uid-disk2:disk2@server.test:mfa";
    expect((await app.request(`/api/org/${o.id}/integrasjoner/google-disk`, { method: "DELETE", headers: { authorization: annen } })).status).toBe(403);
    expect((await app.request(`/api/org/${o.id}/integrasjoner/google-disk`, { method: "DELETE", headers: { authorization: token } })).status).toBe(204);
  });

  it("forfalsket state avvises", async () => {
    const r = await app.request(`/api/offentlig/google/callback?code=abc&state=falsk.state`);
    expect(r.status).toBe(400);
  });
});
