// Google Disk: OAuth med scope drive.file (bare filer appen selv lager), kryptert
// refresh token (Cloud KMS) og kopi av fakturaer til «HI4 Faktura/ÅÅÅÅ/».
import { Hono, type Context } from "hono";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { KeyManagementServiceClient } from "@google-cloud/kms";
import { z } from "zod";
import { config } from "./config.js";
import { alle, en, somBruker, somSystem, type Db } from "./db.js";
import { ApiFeil } from "./feil.js";

const SCOPE = "https://www.googleapis.com/auth/drive.file";
const ROTMAPPE = "HI4 Faktura";
const redirectUri = () => `${config.appUrl}/api/offentlig/google/callback`;

export const diskKonfigurert = () =>
  Boolean(config.googleClientId && config.googleClientSecret && config.googleClientSecret !== "ikke-satt");

// --- Signert state, så callbacken vet hvilken organisasjon og bruker det gjelder ---
export function signerState(data: { org: string; bruker: string }, naa = Date.now()): string {
  const kropp = Buffer.from(JSON.stringify({ ...data, n: randomBytes(8).toString("hex"), exp: naa + 10 * 60_000 })).toString("base64url");
  const sig = createHmac("sha256", config.googleClientSecret ?? "").update(kropp).digest("base64url");
  return `${kropp}.${sig}`;
}

export function lesState(state: string, naa = Date.now()): { org: string; bruker: string } {
  const [kropp, sig] = state.split(".");
  if (!kropp || !sig) throw new ApiFeil(400, "Ugyldig state");
  const forventet = createHmac("sha256", config.googleClientSecret ?? "").update(kropp).digest();
  const mottatt = Buffer.from(sig, "base64url");
  if (mottatt.length !== forventet.length || !timingSafeEqual(mottatt, forventet)) throw new ApiFeil(400, "Ugyldig state");
  const d = JSON.parse(Buffer.from(kropp, "base64url").toString());
  if (d.exp < naa) throw new ApiFeil(400, "Koblingen tok for lang tid. Prøv igjen.");
  return { org: d.org, bruker: d.bruker };
}

// --- Kryptering med Cloud KMS (byttes ut i tester) ---------------------------
let kms: KeyManagementServiceClient | undefined;
export let krypter = async (tekst: string): Promise<Buffer> => {
  kms ??= new KeyManagementServiceClient();
  const [r] = await kms.encrypt({ name: config.kmsNokkel, plaintext: Buffer.from(tekst) });
  return Buffer.from(r.ciphertext as Uint8Array);
};
export let dekrypter = async (data: Buffer): Promise<string> => {
  kms ??= new KeyManagementServiceClient();
  const [r] = await kms.decrypt({ name: config.kmsNokkel, ciphertext: data });
  return Buffer.from(r.plaintext as Uint8Array).toString();
};
export function settKryptering(k: typeof krypter, d: typeof dekrypter) {
  krypter = k;
  dekrypter = d;
}

// --- Google-kall ------------------------------------------------------------
export let googleFetch: typeof fetch = (...a) => fetch(...a);
export function settGoogleFetch(f: typeof fetch) {
  googleFetch = f;
}

async function tokenKall(parametre: Record<string, string>) {
  const r = await googleFetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: config.googleClientId!, client_secret: config.googleClientSecret!, ...parametre }),
  });
  const d: any = await r.json();
  if (!r.ok) throw new Error(`Google token: ${d.error_description ?? d.error ?? r.status}`);
  return d as { access_token: string; refresh_token?: string };
}

async function drive(token: string, sti: string, init: RequestInit = {}) {
  const r = await googleFetch(`https://www.googleapis.com${sti}`, { ...init, headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) } });
  const d: any = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(`Google Disk: ${d.error?.message ?? r.status}`), { status: r.status });
  return d;
}

async function lagMappe(token: string, navn: string, forelder?: string): Promise<string> {
  const d = await drive(token, "/drive/v3/files?fields=id", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: navn, mimeType: "application/vnd.google-apps.folder", ...(forelder ? { parents: [forelder] } : {}) }),
  });
  return d.id;
}

const q = (s: string) => s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

async function finnFil(token: string, navn: string, forelder: string): Promise<string | null> {
  const d = await drive(token, `/drive/v3/files?fields=files(id)&q=${encodeURIComponent(`name='${q(navn)}' and '${forelder}' in parents and trashed=false`)}`);
  return d.files?.[0]?.id ?? null;
}

async function lastOpp(token: string, navn: string, forelder: string, data: Uint8Array): Promise<string> {
  const grense = `faktura${randomBytes(8).toString("hex")}`;
  const kropp = Buffer.concat([
    Buffer.from(`--${grense}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name: navn, parents: [forelder] })}\r\n`),
    Buffer.from(`--${grense}\r\nContent-Type: application/pdf\r\n\r\n`),
    Buffer.from(data),
    Buffer.from(`\r\n--${grense}--`),
  ]);
  const d = await drive(token, "/upload/drive/v3/files?uploadType=multipart&fields=id", {
    method: "POST",
    headers: { "content-type": `multipart/related; boundary=${grense}` },
    body: kropp,
  });
  return d.id;
}

// --- API-ruter ----------------------------------------------------------------

// Monteres under /api/org/:org/integrasjoner.
export function integrasjonRuter() {
  const r = new Hono();
  const orgId = (c: Context) => z.string().uuid().parse(c.req.param("org"));

  r.get("/", async (c) =>
    c.json({
      google_disk_tilgjengelig: diskKonfigurert(),
      integrasjoner: await somBruker(c.get("bruker").id, (db) =>
        alle(db, "select type, status, konfig - 'mapper' as konfig, siste_feil, oppdatert from faktura.integrasjoner where org_id = $1", [orgId(c)]),
      ),
    }),
  );

  r.post("/google-disk/start", async (c) => {
    if (!diskKonfigurert()) throw new ApiFeil(503, "Google Disk er ikke satt opp på plattformen ennå");
    const b = c.get("bruker");
    const org = orgId(c);
    await somBruker(b.id, async (db) => {
      if (!(await en(db, "select faktura.kan($1, 'admin') as k", [org]))!.k) throw new ApiFeil(403, "Bare administratorer kan koble til Google Disk");
    });
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.search = new URLSearchParams({
      client_id: config.googleClientId!,
      redirect_uri: redirectUri(),
      response_type: "code",
      scope: SCOPE,
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
      login_hint: b.epost,
      state: signerState({ org, bruker: b.id }),
    }).toString();
    return c.json({ url: url.toString() });
  });

  r.delete("/google-disk", async (c) => {
    const org = orgId(c);
    const rad = await somBruker(c.get("bruker").id, async (db) => {
      if (!(await en(db, "select faktura.kan($1, 'admin') as k", [org]))!.k) throw new ApiFeil(403, "Ingen tilgang");
      return en(db, "delete from faktura.integrasjoner where org_id = $1 and type = 'google_drive' returning id", [org]);
    });
    if (!rad) throw new ApiFeil(404, "Google Disk er ikke koblet til");
    return c.body(null, 204);
  });

  return r;
}

// Monteres under /api/offentlig/google. Google sender brukeren hit etter samtykke.
export function googleCallback() {
  const r = new Hono();
  r.get("/callback", async (c) => {
    const tilbake = (status: string) => c.redirect(`${config.appUrl}/innstillinger?disk=${status}`);
    if (c.req.query("error")) return tilbake("avbrutt");
    const { org, bruker } = lesState(c.req.query("state") ?? "");
    const kode = c.req.query("code");
    if (!kode) return tilbake("feil");
    try {
      const t = await tokenKall({ code: kode, grant_type: "authorization_code", redirect_uri: redirectUri() });
      if (!t.refresh_token) return tilbake("mangler-tilgang");
      const mappe = await lagMappe(t.access_token, ROTMAPPE);
      const kryptert = await krypter(t.refresh_token);
      await somBruker(bruker, async (db) => {
        await db.query("delete from faktura.integrasjoner where org_id = $1 and type = 'google_drive'", [org]);
        await db.query(
          `insert into faktura.integrasjoner (org_id, type, status, konfig, hemmelighet_kryptert, koblet_av)
           values ($1, 'google_drive', 'aktiv', $2, $3, faktura.bruker_id())`,
          [org, JSON.stringify({ rotmappe: mappe, mapper: {} }), kryptert],
        );
      });
      return tilbake("ok");
    } catch (e) {
      console.error(JSON.stringify({ severity: "ERROR", message: "Google Disk-kobling feilet", feil: (e as Error).message }));
      return tilbake("feil");
    }
  });
  return r;
}

// --- Worker: kopier PDF til Disk ved utstedelse ---------------------------------

async function aarsmappe(db: Db, integrasjonId: string, konfig: any, token: string, aar: string): Promise<string> {
  if (konfig.mapper?.[aar]) return konfig.mapper[aar];
  const id = (await finnFil(token, aar, konfig.rotmappe)) ?? (await lagMappe(token, aar, konfig.rotmappe));
  await db.query("update faktura.integrasjoner set konfig = jsonb_set(konfig, array['mapper', $2::text], to_jsonb($3::text)) where id = $1", [integrasjonId, aar, id]);
  return id;
}

// Returnerer true når hendelsen er ferdigbehandlet (også når det ikke er noe å gjøre).
export async function kopierTilDisk(fakturaId: string, hentPdf: (db: Db, f: any) => Promise<{ data: Uint8Array }>, filnavn: (f: any) => string) {
  if (!diskKonfigurert()) return;
  await somSystem(async (db) => {
    const f = await en(db, "select * from faktura.fakturaer where id = $1", [fakturaId]);
    if (!f || f.status === "utkast") return;
    const i = await en(db, "select id, konfig, siste_feil, hemmelighet_kryptert from faktura.integrasjoner where org_id = $1 and type = 'google_drive' and status = 'aktiv'", [f.org_id]);
    if (!i) return;
    try {
      const { access_token } = await tokenKall({ refresh_token: await dekrypter(i.hemmelighet_kryptert), grant_type: "refresh_token" });
      const mappe = await aarsmappe(db, i.id, i.konfig, access_token, String(f.fakturadato).slice(0, 4));
      const navn = filnavn(f);
      if (await finnFil(access_token, navn, mappe)) return; // allerede kopiert (Pub/Sub kan levere to ganger)
      const linjer = await alle(db, "select * from faktura.faktura_linjer where faktura_id = $1 order by rekke", [f.id]);
      const { data } = await hentPdf(db, { ...f, linjer });
      await lastOpp(access_token, navn, mappe, data);
      if (i.siste_feil) await db.query("update faktura.integrasjoner set siste_feil = null, status = 'aktiv' where id = $1", [i.id]);
    } catch (e) {
      const melding = (e as Error).message;
      // Tilbakekalt tilgang eller slettet mappe: marker som feil, ikke prøv igjen i det uendelige.
      const permanent = /invalid_grant|404|403/.test(melding) || [403, 404].includes((e as { status?: number }).status ?? 0);
      await db.query("update faktura.integrasjoner set status = $2, siste_feil = $3 where id = $1", [i.id, permanent ? "feil" : "aktiv", melding]);
      if (!permanent) throw e;
    }
  });
}
