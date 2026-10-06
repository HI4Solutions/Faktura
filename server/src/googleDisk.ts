// Google Disk: OAuth med scope drive.file (bare filer appen selv lager), kryptert
// refresh token (Cloud KMS) og kopi av fakturaer til «HI4 Faktura/ÅÅÅÅ/».
import { Hono, type Context } from "hono";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { KeyManagementServiceClient } from "@google-cloud/kms";
import { z } from "zod";
import { config } from "./config.js";
import { alle, en, somBruker, somSystem, type Db } from "./db.js";
import { ApiFeil } from "./feil.js";
import { leggIKo } from "./tjenester.js";

// drive.file gir bare tilgang til filer appen selv lager; e-post viser hvilken konto som er koblet.
const SCOPE = "openid email https://www.googleapis.com/auth/drive.file";
const ROTMAPPE = "HI4 Faktura";
const redirectUri = () => `${config.appUrl}/api/offentlig/google/callback`;

export const diskKonfigurert = () =>
  Boolean(config.googleClientId && config.googleClientSecret && config.googleClientSecret !== "ikke-satt");

// --- Signert state, så callbacken vet hvilken organisasjon og bruker det gjelder ---
export function signerState(data: { bruker: string }, naa = Date.now()): string {
  const kropp = Buffer.from(JSON.stringify({ ...data, n: randomBytes(8).toString("hex"), exp: naa + 10 * 60_000 })).toString("base64url");
  const sig = createHmac("sha256", config.googleClientSecret ?? "").update(kropp).digest("base64url");
  return `${kropp}.${sig}`;
}

export function lesState(state: string, naa = Date.now()): { bruker: string } {
  const [kropp, sig] = state.split(".");
  if (!kropp || !sig) throw new ApiFeil(400, "Ugyldig state");
  const forventet = createHmac("sha256", config.googleClientSecret ?? "").update(kropp).digest();
  const mottatt = Buffer.from(sig, "base64url");
  if (mottatt.length !== forventet.length || !timingSafeEqual(mottatt, forventet)) throw new ApiFeil(400, "Ugyldig state");
  const d = JSON.parse(Buffer.from(kropp, "base64url").toString());
  if (d.exp < naa) throw new ApiFeil(400, "Koblingen tok for lang tid. Prøv igjen.");
  return { bruker: d.bruker };
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
  return d as { access_token: string; refresh_token?: string; id_token?: string };
}

async function drive(token: string, sti: string, init: RequestInit = {}) {
  const r = await googleFetch(`https://www.googleapis.com${sti}`, { ...init, headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) } });
  const d: any = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(`Google Disk: ${d.error?.message ?? r.status}`), { status: r.status });
  return d;
}

// Mappenavn kan ikke inneholde skråstrek på Disk; resten er greit.
const mappenavn = (navn: string) => navn.replace(/[\\/]/g, "-").trim() || "Uten navn";

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

// --- API-ruter (per bruker, monteres under /api/disk) ---------------------------

export function diskRuter() {
  const r = new Hono();

  r.get("/", async (c) => {
    const b = c.get("bruker");
    return c.json(
      await somBruker(b.id, async (db) => ({
        tilgjengelig: diskKonfigurert(),
        kobling: await en(db, "select google_epost, status, siste_feil, opprettet from faktura.disk_koblinger where bruker_id = faktura.bruker_id()"),
        organisasjoner: await alle(
          db,
          `select o.id, o.navn, o.direkte_medlem, coalesce(d.aktiv, false) as aktiv, d.sist_kopiert
             from faktura.mine_organisasjoner o
             left join faktura.disk_organisasjoner d on d.org_id = o.id and d.bruker_id = faktura.bruker_id()
            order by o.direkte_medlem desc, o.navn`,
        ),
      })),
    );
  });

  r.post("/start", async (c) => {
    if (!diskKonfigurert()) throw new ApiFeil(503, "Google Disk er ikke satt opp på plattformen ennå");
    const b = c.get("bruker");
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.search = new URLSearchParams({
      client_id: config.googleClientId!,
      redirect_uri: redirectUri(),
      response_type: "code",
      scope: SCOPE,
      access_type: "offline",
      prompt: "consent select_account",
      state: signerState({ bruker: b.id }),
    }).toString();
    return c.json({ url: url.toString() });
  });

  r.put("/organisasjoner/:org", async (c) => {
    const org = z.string().uuid().parse(c.req.param("org"));
    const { aktiv } = z.object({ aktiv: z.boolean() }).parse(await c.req.json());
    const b = c.get("bruker");
    await somBruker(b.id, async (db) => {
      if (!(await en(db, "select 1 from faktura.disk_koblinger where bruker_id = faktura.bruker_id()"))) throw new ApiFeil(409, "Koble til Google Disk først");
      if (!(await en(db, "select faktura.kan($1, 'les') as k", [org]))!.k) throw new ApiFeil(403, "Ingen tilgang");
      await db.query(
        `insert into faktura.disk_organisasjoner (bruker_id, org_id, aktiv) values (faktura.bruker_id(), $1, $2)
         on conflict (bruker_id, org_id) do update set aktiv = excluded.aktiv`,
        [org, aktiv],
      );
    });
    if (aktiv) await leggIKo({ type: "disk-synk", bruker_id: b.id, org_id: org });
    return c.json({ aktiv });
  });

  r.delete("/", async (c) => {
    const rad = await somBruker(c.get("bruker").id, (db) =>
      en(db, "delete from faktura.disk_koblinger where bruker_id = faktura.bruker_id() returning bruker_id"),
    );
    if (!rad) throw new ApiFeil(404, "Google Disk er ikke koblet til");
    return c.body(null, 204);
  });

  return r;
}

// Google sender brukeren hit etter samtykke (monteres under /api/offentlig/google).
export function googleCallback() {
  const r = new Hono();
  r.get("/callback", async (c) => {
    const tilbake = (status: string) => c.redirect(`${config.appUrl}/innstillinger?disk=${status}`);
    if (c.req.query("error")) return tilbake("avbrutt");
    const { bruker } = lesState(c.req.query("state") ?? "");
    const kode = c.req.query("code");
    if (!kode) return tilbake("feil");
    try {
      const t = await tokenKall({ code: kode, grant_type: "authorization_code", redirect_uri: redirectUri() });
      if (!t.refresh_token) return tilbake("mangler-tilgang");
      let googleEpost: string | null = null;
      try {
        googleEpost = t.id_token ? JSON.parse(Buffer.from(t.id_token.split(".")[1], "base64url").toString()).email ?? null : null;
      } catch {
        googleEpost = null;
      }
      const rotmappe = await lagMappe(t.access_token, ROTMAPPE);
      const kryptert = await krypter(t.refresh_token);
      const orgs = await somBruker(bruker, async (db) => {
        await db.query("delete from faktura.disk_koblinger where bruker_id = faktura.bruker_id()");
        await db.query(
          `insert into faktura.disk_koblinger (bruker_id, google_epost, rotmappe, hemmelighet_kryptert)
           values (faktura.bruker_id(), $1, $2, $3)`,
          [googleEpost, rotmappe, kryptert],
        );
        // Start med organisasjonene brukeren er direkte medlem av.
        return alle<{ id: string }>(
          db,
          `insert into faktura.disk_organisasjoner (bruker_id, org_id)
           select faktura.bruker_id(), m.org_id from faktura.medlemmer m where m.bruker_id = faktura.bruker_id()
           returning org_id as id`,
        );
      });
      for (const o of orgs) await leggIKo({ type: "disk-synk", bruker_id: bruker, org_id: o.id });
      return tilbake("ok");
    } catch (e) {
      console.error(JSON.stringify({ severity: "ERROR", message: "Google Disk-kobling feilet", feil: (e as Error).message }));
      return tilbake("feil");
    }
  });
  return r;
}

// --- Worker: kopier PDF-er til brukernes Disk ------------------------------------

type HentPdf = (db: Db, f: any) => Promise<{ data: Uint8Array }>;
type Filnavn = (f: any) => string;

const erPermanent = (e: unknown) => {
  const melding = (e as Error).message;
  const status = (e as { status?: number }).status ?? 0;
  return /invalid_grant|unauthorized_client/.test(melding) || [401, 403, 404].includes(status);
};

async function tokenFor(db: Db, brukerId: string): Promise<{ token: string; rotmappe: string } | null> {
  const k = await en(db, "select rotmappe, hemmelighet_kryptert from faktura.disk_koblinger where bruker_id = $1 and status = 'aktiv'", [brukerId]);
  if (!k) return null;
  const { access_token } = await tokenKall({ refresh_token: await dekrypter(k.hemmelighet_kryptert), grant_type: "refresh_token" });
  return { token: access_token, rotmappe: k.rotmappe };
}

async function mappeFor(db: Db, d: any, token: string, rotmappe: string, orgNavn: string, aar: string): Promise<string> {
  let orgMappe: string = d.mappe;
  if (!orgMappe) {
    const navn = mappenavn(orgNavn);
    orgMappe = (await finnFil(token, navn, rotmappe)) ?? (await lagMappe(token, navn, rotmappe));
    await db.query("update faktura.disk_organisasjoner set mappe = $3 where bruker_id = $1 and org_id = $2", [d.bruker_id, d.org_id, orgMappe]);
    d.mappe = orgMappe;
  }
  if (d.aarsmapper?.[aar]) return d.aarsmapper[aar];
  const id = (await finnFil(token, aar, orgMappe)) ?? (await lagMappe(token, aar, orgMappe));
  await db.query(
    "update faktura.disk_organisasjoner set aarsmapper = aarsmapper || jsonb_build_object($3::text, $4::text) where bruker_id = $1 and org_id = $2",
    [d.bruker_id, d.org_id, aar, id],
  );
  d.aarsmapper = { ...(d.aarsmapper ?? {}), [aar]: id };
  return id;
}

async function kopierEn(db: Db, d: any, tilgang: { token: string; rotmappe: string }, f: any, orgNavn: string, hentPdf: HentPdf, filnavn: Filnavn) {
  const mappe = await mappeFor(db, d, tilgang.token, tilgang.rotmappe, orgNavn, String(f.fakturadato).slice(0, 4));
  const navn = filnavn(f);
  if (await finnFil(tilgang.token, navn, mappe)) return; // allerede kopiert (Pub/Sub kan levere to ganger)
  const linjer = await alle(db, "select * from faktura.faktura_linjer where faktura_id = $1 order by rekke", [f.id]);
  const { data } = await hentPdf(db, { ...f, linjer });
  await lastOpp(tilgang.token, navn, mappe, data);
}

async function markerFeil(db: Db, brukerId: string, e: unknown) {
  await db.query("update faktura.disk_koblinger set status = 'feil', siste_feil = $2 where bruker_id = $1", [brukerId, (e as Error).message]);
}

// Ny faktura: kopier til alle brukere som har valgt organisasjonen. En feil hos én
// bruker stopper ikke de andre; midlertidige feil kastes til slutt så Pub/Sub prøver igjen.
export async function kopierTilDisk(fakturaId: string, hentPdf: HentPdf, filnavn: Filnavn) {
  if (!diskKonfigurert()) return;
  const midlertidige: unknown[] = [];
  await somSystem(async (db) => {
    const f = await en(db, "select * from faktura.fakturaer where id = $1", [fakturaId]);
    if (!f || f.status === "utkast") return;
    const org = await en(db, "select navn from faktura.organisasjoner where id = $1", [f.org_id]);
    const mottakere = await alle(
      db,
      `select d.* from faktura.disk_organisasjoner d join faktura.disk_koblinger k on k.bruker_id = d.bruker_id
        where d.org_id = $1 and d.aktiv and k.status = 'aktiv'`,
      [f.org_id],
    );
    for (const d of mottakere) {
      if (!(await en(db, "select faktura.bruker_kan_lese($1, $2) as k", [d.bruker_id, d.org_id]))!.k) {
        await db.query("update faktura.disk_organisasjoner set aktiv = false where bruker_id = $1 and org_id = $2", [d.bruker_id, d.org_id]);
        continue;
      }
      try {
        const tilgang = await tokenFor(db, d.bruker_id);
        if (!tilgang) continue;
        await kopierEn(db, d, tilgang, f, org.navn, hentPdf, filnavn);
        await db.query("update faktura.disk_organisasjoner set sist_kopiert = now() where bruker_id = $1 and org_id = $2", [d.bruker_id, d.org_id]);
      } catch (e) {
        if (erPermanent(e)) await markerFeil(db, d.bruker_id, e);
        else midlertidige.push(e);
      }
    }
  });
  if (midlertidige.length) throw midlertidige[0];
}

// Når en bruker slår på en organisasjon: kopier alle fakturaer som allerede er sendt.
export async function synkOrganisasjon(brukerId: string, orgId: string, hentPdf: HentPdf, filnavn: Filnavn) {
  if (!diskKonfigurert()) return;
  await somSystem(async (db) => {
    const d = await en(db, "select * from faktura.disk_organisasjoner where bruker_id = $1 and org_id = $2 and aktiv", [brukerId, orgId]);
    if (!d) return;
    if (!(await en(db, "select faktura.bruker_kan_lese($1, $2) as k", [brukerId, orgId]))!.k) return;
    const org = await en(db, "select navn from faktura.organisasjoner where id = $1", [orgId]);
    try {
      const tilgang = await tokenFor(db, brukerId);
      if (!tilgang) return;
      const fakturaer = await alle(db, "select * from faktura.fakturaer where org_id = $1 and status <> 'utkast' order by fakturadato, fakturanummer", [orgId]);
      for (const f of fakturaer) await kopierEn(db, d, tilgang, f, org.navn, hentPdf, filnavn);
      await db.query("update faktura.disk_organisasjoner set sist_kopiert = now() where bruker_id = $1 and org_id = $2", [brukerId, orgId]);
    } catch (e) {
      if (erPermanent(e)) await markerFeil(db, brukerId, e);
      else throw e;
    }
  });
}
