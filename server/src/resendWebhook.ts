// Hendelser fra Resend (levert, retur, klage). Resend signerer med Svix:
// signatur = base64(HMAC-SHA256(hemmelighet, "<svix-id>.<svix-timestamp>.<body>")).
import { Hono } from "hono";
import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "./config.js";
import { en, somSystem } from "./db.js";
import { ApiFeil } from "./feil.js";

export function sjekkSvix(hemmelighet: string, id: string, tidsstempel: string, kropp: string, signaturer: string, naa = Date.now()): boolean {
  const ts = Number(tidsstempel);
  if (!Number.isFinite(ts) || Math.abs(naa / 1000 - ts) > 5 * 60) return false;
  const nokkel = Buffer.from(hemmelighet.replace(/^whsec_/, ""), "base64");
  const forventet = createHmac("sha256", nokkel).update(`${id}.${tidsstempel}.${kropp}`).digest();
  return signaturer.split(" ").some((s) => {
    const [versjon, sig] = s.split(",");
    if (versjon !== "v1" || !sig) return false;
    const mottatt = Buffer.from(sig, "base64");
    return mottatt.length === forventet.length && timingSafeEqual(mottatt, forventet);
  });
}

const statuser: Record<string, string> = {
  "email.delivered": "levert",
  "email.delivery_delayed": "forsinket",
  "email.bounced": "sprett",
  "email.complained": "klage",
};

// Monteres under /api/offentlig/resend.
export function resendWebhook() {
  const r = new Hono();
  r.post("/", async (c) => {
    const hemmelighet = config.resendWebhookHemmelighet;
    if (!hemmelighet || hemmelighet === "ikke-satt") throw new ApiFeil(503, "Webhook er ikke konfigurert");
    const kropp = await c.req.text();
    const ok = sjekkSvix(hemmelighet, c.req.header("svix-id") ?? "", c.req.header("svix-timestamp") ?? "", kropp, c.req.header("svix-signature") ?? "");
    if (!ok) throw new ApiFeil(401, "Ugyldig signatur");
    const h = JSON.parse(kropp) as { type?: string; data?: { email_id?: string; bounce?: { message?: string } } };
    const status = statuser[h.type ?? ""];
    if (status && h.data?.email_id) {
      await somSystem((db) =>
        en(db, "select faktura.oppdater_epoststatus($1, $2, $3)", [h.data!.email_id, status, h.data!.bounce?.message ?? null]),
      );
    }
    return c.json({ ok: true });
  });
  return r;
}
