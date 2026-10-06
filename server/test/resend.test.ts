import { describe, expect, it, beforeAll } from "vitest";
import { createHmac } from "node:crypto";
import { sjekkSvix } from "../src/resendWebhook.js";
import { lagApi } from "../src/api.js";
import { config } from "../src/config.js";

const hemmelighet = "whsec_" + Buffer.from("testhemmelighet-32-byte-lang!!!!").toString("base64");
function signer(id: string, ts: string, kropp: string) {
  const sig = createHmac("sha256", Buffer.from(hemmelighet.slice(6), "base64")).update(`${id}.${ts}.${kropp}`).digest("base64");
  return `v1,${sig}`;
}

describe("Svix-signatur", () => {
  const ts = String(Math.floor(Date.now() / 1000));
  it("godtar riktig signatur", () => {
    expect(sjekkSvix(hemmelighet, "msg_1", ts, "{}", signer("msg_1", ts, "{}"))).toBe(true);
    expect(sjekkSvix(hemmelighet, "msg_1", ts, "{}", `v1,feil ${signer("msg_1", ts, "{}")}`)).toBe(true);
  });
  it("avviser endret innhold, feil id og gammelt tidsstempel", () => {
    expect(sjekkSvix(hemmelighet, "msg_1", ts, '{"a":1}', signer("msg_1", ts, "{}"))).toBe(false);
    expect(sjekkSvix(hemmelighet, "msg_2", ts, "{}", signer("msg_1", ts, "{}"))).toBe(false);
    const gammel = String(Number(ts) - 3600);
    expect(sjekkSvix(hemmelighet, "msg_1", gammel, "{}", signer("msg_1", gammel, "{}"))).toBe(false);
  });
});

describe.skipIf(!process.env.DATABASE_URL)("Resend-webhook", () => {
  const app = lagApi();
  beforeAll(() => {
    (config as { resendWebhookHemmelighet?: string }).resendWebhookHemmelighet = hemmelighet;
  });
  it("avviser usignerte og godtar signerte hendelser", async () => {
    const kropp = JSON.stringify({ type: "email.delivered", data: { email_id: "finnes-ikke" } });
    const ts = String(Math.floor(Date.now() / 1000));
    const usignert = await app.request("/api/offentlig/resend", { method: "POST", body: kropp });
    expect(usignert.status).toBe(401);
    const signert = await app.request("/api/offentlig/resend", {
      method: "POST",
      body: kropp,
      headers: { "svix-id": "msg_x", "svix-timestamp": ts, "svix-signature": signer("msg_x", ts, kropp) },
    });
    expect(signert.status).toBe(200);
  });
});
