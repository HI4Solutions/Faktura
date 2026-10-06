// Google Disk: OAuth med scope drive.file (bare filer appen selv lager, og mapper
// brukeren velger i Google Picker), kryptert refresh token (Cloud KMS) og kopi av
// fakturaer rett i mappen brukeren har valgt, eller i «HI4 Faktura/<organisasjon>/<år>/».
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
  const d = await drive(token, "/drive/v3/files?fields=id&supportsAllDrives=true", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: navn, mimeType: "application/vnd.google-apps.folder", ...(forelder ? { parents: [forelder] } : {}) }),
  });
  return d.id;
}

const q = (s: string) => s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

async function finnFil(token: string, navn: string, forelder: string): Promise<string | null> {
  const d = await drive(token, `/drive/v3/files?fields=files(id)&supportsAllDrives=true&includeItemsFromAllDrives=true&q=${encodeURIComponent(`name='${q(navn)}' and '${forelder}' in parents and trashed=false`)}`);
  return d.files?.[0]?.id ?? null;
}

// Fakturaen merkes med id-en sin, så samme faktura ikke kopieres to ganger.
async function finnFaktura(token: string, fakturaId: string, forelder: string): Promise<boolean> {
  const sok = `appProperties has { key='faktura_id' and value='${q(fakturaId)}' } and '${forelder}' in parents and trashed=false`;
  const d = await drive(token, `/drive/v3/files?fields=files(id)&supportsAllDrives=true&includeItemsFromAllDrives=true&q=${encodeURIComponent(sok)}`);
  return Boolean(d.files?.length);
}

async function lastOpp(token: string, navn: string, forelder: string, data: Uint8Array, fakturaId: string): Promise<string> {
  const grense = `faktura${randomBytes(8).toString("hex")}`;
  const kropp = Buffer.concat([
    Buffer.from(`--${grense}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name: navn, parents: [forelder], appProperties: { faktura_id: fakturaId } })}\r\n`),
    Buffer.from(`--${grense}\r\nContent-Type: application/pdf\r\n\r\n`),
    Buffer.from(data),
    Buffer.from(`\r\n--${grense}--`),
  ]);
  const d = await drive(token, "/upload/drive/v3/files?uploadType=multipart&fields=id&supportsAllDrives=true", {
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
        // Oppsett for Google Picker i nettleseren (offentlige verdier).
        velger:
          config.googlePickerNokkel && config.googleProsjektnummer && diskKonfigurert()
            ? { klientId: config.googleClientId, nokkel: config.googlePickerNokkel, appId: config.googleProsjektnummer }
            : null,
        kobling: await en(
          db,
          "select google_epost, status, siste_feil, rotmappe_navn, undermapper, opprettet from faktura.disk_koblinger where bruker_id = faktura.bruker_id()",
        ),
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

  // Bytt mappe: { id, navn } fra Google Picker i nettleseren (fakturaene legges rett i
  // mappen), eller { standard: true } for en ny «HI4 Faktura» med undermapper. Picker gir appen tilgang til mappen selv med drive.file.
  // API-et kan ikke dekryptere Google-tilgangen, så workeren oppdager en ugyldig mappe
  // ved neste kopiering og markerer koblingen med feil. Valgte organisasjoner kopieres
  // på nytt til den nye mappen.
  r.put("/mappe", async (c) => {
    const valg = z
      .union([z.object({ id: z.string().regex(/^[\w-]{10,200}$/), navn: z.string().trim().min(1).max(200) }), z.object({ standard: z.literal(true) })])
      .parse(await c.req.json());
    const b = c.get("bruker");
    const mappe = "id" in valg ? valg : { id: null, navn: ROTMAPPE };
    const orgs = await somBruker(b.id, async (db) => {
      const k = await en(
        db,
        `update faktura.disk_koblinger set rotmappe = $1, rotmappe_navn = $2, undermapper = $3, status = 'aktiv', siste_feil = null
          where bruker_id = faktura.bruker_id() returning bruker_id`,
        [mappe.id, mappe.navn, mappe.id === null],
      );
      if (!k) throw new ApiFeil(409, "Koble til Google Disk først");
      return alle<{ id: string }>(
        db,
        `update faktura.disk_organisasjoner set mappe = null, aarsmapper = '{}'
          where bruker_id = faktura.bruker_id() and aktiv returning org_id as id`,
      );
    });
    for (const o of orgs) await leggIKo({ type: "disk-synk", bruker_id: b.id, org_id: o.id });
    return c.json({ rotmappe_navn: mappe.navn });
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
          `insert into faktura.disk_koblinger (bruker_id, google_epost, rotmappe, rotmappe_navn, undermapper, hemmelighet_kryptert)
           values (faktura.bruker_id(), $1, $2, $3, true, $4)`,
          [googleEpost, rotmappe, ROTMAPPE, kryptert],
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

type Tilgang = { token: string; rotmappe: string; undermapper: boolean };

async function tokenFor(db: Db, brukerId: string): Promise<Tilgang | null> {
  const k = await en(db, "select rotmappe, undermapper, hemmelighet_kryptert from faktura.disk_koblinger where bruker_id = $1 and status = 'aktiv'", [brukerId]);
  if (!k) return null;
  const { access_token } = await tokenKall({ refresh_token: await dekrypter(k.hemmelighet_kryptert), grant_type: "refresh_token" });
  // Ingen mappe valgt (brukeren gikk tilbake til standard): lag «HI4 Faktura».
  let rotmappe: string = k.rotmappe;
  if (!rotmappe) {
    const ny = await lagMappe(access_token, ROTMAPPE);
    await db.query("update faktura.disk_koblinger set rotmappe = $2 where bruker_id = $1 and rotmappe is null", [brukerId, ny]);
    rotmappe = (await en(db, "select rotmappe from faktura.disk_koblinger where bruker_id = $1", [brukerId]))!.rotmappe;
  }
  return { token: access_token, rotmappe, undermapper: k.undermapper };
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

async function kopierEn(db: Db, d: any, tilgang: Tilgang, f: any, orgNavn: string, hentPdf: HentPdf, filnavn: Filnavn) {
  let mappe: string;
  let navn = filnavn(f);
  if (tilgang.undermapper) {
    mappe = await mappeFor(db, d, tilgang.token, tilgang.rotmappe, orgNavn, String(f.fakturadato).slice(0, 4));
    // Eldre kopier har ikke faktura-id på seg; da holder det at navnet finnes i mappen.
    if (await finnFil(tilgang.token, navn, mappe)) return;
  } else {
    // Rett i mappen brukeren valgte. Kopierer brukeren fra flere organisasjoner,
    // får filnavnet organisasjonen med, så fakturanumrene ikke blandes.
    mappe = tilgang.rotmappe;
    const flere = await en(db, "select count(*) > 1 as flere from faktura.disk_organisasjoner where bruker_id = $1 and aktiv", [d.bruker_id]);
    if (flere!.flere) navn = navn.replace(/\.pdf$/, ` - ${mappenavn(orgNavn)}.pdf`);
  }
  if (await finnFaktura(tilgang.token, f.id, mappe)) return; // allerede kopiert (Pub/Sub kan levere to ganger)
  const linjer = await alle(db, "select * from faktura.faktura_linjer where faktura_id = $1 order by rekke", [f.id]);
  const { data } = await hentPdf(db, { ...f, linjer });
  await lastOpp(tilgang.token, navn, mappe, data, f.id);
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

// Slettede (test)fakturaer: legg kopiene i papirkurven hos alle brukere som har
// organisasjonen koblet. Kopier merket med faktura-id finnes overalt; eldre kopier
// uten merke finnes på filnavn i mappene appen selv har laget eller fått valgt.
export async function slettFraDisk(orgId: string, fakturaIder: string[], filnavn: Filnavn) {
  if (!diskKonfigurert() || !fakturaIder.length) return;
  const midlertidige: unknown[] = [];
  await somSystem(async (db) => {
    const slettede = await alle(
      db,
      `select rad_id as id, endring ->> 'type' as type, (endring ->> 'fakturanummer')::bigint as fakturanummer
         from faktura.revisjonslogg where org_id = $1 and handling = 'SLETTET' and rad_id = any($2)`,
      [orgId, fakturaIder],
    );
    const org = await en(db, "select navn from faktura.organisasjoner where id = $1", [orgId]);
    const brukere = await alle(
      db,
      `select d.*, k.rotmappe from faktura.disk_organisasjoner d join faktura.disk_koblinger k on k.bruker_id = d.bruker_id
        where d.org_id = $1 and k.status = 'aktiv'`,
      [orgId],
    );
    for (const d of brukere) {
      try {
        const tilgang = await tokenFor(db, d.bruker_id);
        if (!tilgang) continue;
        const mapper = [tilgang.rotmappe, d.mappe, ...Object.values(d.aarsmapper ?? {})].filter(Boolean) as string[];
        const filer = new Set<string>();
        for (const f of slettede) {
          const sok = `appProperties has { key='faktura_id' and value='${q(f.id)}' } and trashed=false`;
          const merket = await drive(tilgang.token, `/drive/v3/files?fields=files(id)&supportsAllDrives=true&includeItemsFromAllDrives=true&q=${encodeURIComponent(sok)}`);
          for (const x of merket.files ?? []) filer.add(x.id);
          const navn = filnavn(f);
          const navnene = [navn, navn.replace(/\.pdf$/, ` - ${mappenavn(org?.navn ?? "")}.pdf`)];
          for (const mappe of mapper) {
            const sokNavn = `(${navnene.map((n) => `name='${q(n)}'`).join(" or ")}) and '${mappe}' in parents and trashed=false`;
            const funnet = await drive(tilgang.token, `/drive/v3/files?fields=files(id,appProperties)&supportsAllDrives=true&includeItemsFromAllDrives=true&q=${encodeURIComponent(sokNavn)}`);
            for (const x of funnet.files ?? []) if (!x.appProperties?.faktura_id) filer.add(x.id);
          }
        }
        for (const id of filer) {
          await drive(tilgang.token, `/drive/v3/files/${id}?supportsAllDrives=true&fields=id`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ trashed: true }),
          });
        }
      } catch (e) {
        if (erPermanent(e)) console.error(JSON.stringify({ severity: "WARNING", message: "Kunne ikke fjerne slettet faktura fra Disk", feil: (e as Error).message }));
        else midlertidige.push(e);
      }
    }
  });
  if (midlertidige.length) throw midlertidige[0];
}
