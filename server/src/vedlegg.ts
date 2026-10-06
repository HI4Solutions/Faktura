// Vedlegg på fakturaer: opplasting, nedlasting, kobling til utkast, og filene som sendes
// med fakturaen på e-post og i EHF. Se db/migrations/0023_vedlegg.sql.
import { Hono, type Context } from "hono";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { alle, en, somBruker, somSystem, type Db } from "./db.js";
import { config } from "./config.js";
import { lagring } from "./tjenester.js";
import { ApiFeil } from "./feil.js";

export const MAKS_STORRELSE = 10_000_000; // per fil, og alle vedleggene på en faktura til sammen
export const MAKS_ANTALL = 10;
const MAKS_UTEN_FAKTURA = 100; // opplastede filer i organisasjonen som ikke er lagret på en faktura ennå

// Typene EHF godtar som vedlegg, med filendelsene de kan ha (den første brukes ellers).
export const TYPER: Record<string, string[]> = {
  "application/pdf": [".pdf"],
  "image/png": [".png"],
  "image/jpeg": [".jpg", ".jpeg"],
  "text/csv": [".csv"],
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [".xlsx"],
  "application/vnd.oasis.opendocument.spreadsheet": [".ods"],
};
const ODS = "application/vnd.oasis.opendocument.spreadsheet";

const latin1 = (d: Uint8Array, fra: number, til: number) => Buffer.from(d.subarray(fra, til)).toString("latin1");
const starterMed = (d: Uint8Array, ...b: number[]) => b.every((x, i) => d[i] === x);

// Filtypen bestemmes av innholdet, ikke av filnavnet eller det nettleseren sier.
export function finnType(d: Uint8Array, filnavn: string): string | null {
  if (latin1(d, 0, 1024).includes("%PDF-")) return "application/pdf";
  if (starterMed(d, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (starterMed(d, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (starterMed(d, 0x50, 0x4b, 0x03, 0x04)) {
    // OpenDocument: den første filen i zip-arkivet heter «mimetype» og er ukomprimert.
    const start = 38 + ((d[28] ?? 0) | ((d[29] ?? 0) << 8));
    if (latin1(d, 30, 38) === "mimetype" && latin1(d, start, start + ODS.length) === ODS) return ODS;
    // Excel (xlsx): filnavnene i arkivet står ukomprimert.
    if (Buffer.from(d.buffer, d.byteOffset, d.byteLength).includes("xl/workbook.xml")) return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    return null;
  }
  if (/\.csv$/i.test(filnavn) && !d.includes(0)) return "text/csv";
  return null;
}

// Filnavnet slik det står i e-posten og EHF-filen: uten mappe og tegn som ikke er lov i
// filnavn, og med en endelse som passer til innholdet.
export function rensFilnavn(navn: string, type: string): string {
  const n = (navn.split(/[\\/]/).pop() ?? "")
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f"<>|*?:]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const endelser = TYPER[type]!;
  const kjente = Object.values(TYPER).flat();
  const punkt = n.lastIndexOf(".");
  const endelse = punkt >= 0 ? n.slice(punkt).toLowerCase() : "";
  let stamme = n;
  let ny = endelser[0]!;
  if (endelser.includes(endelse)) {
    stamme = n.slice(0, punkt);
    ny = endelse;
  } else if (kjente.includes(endelse)) {
    stamme = n.slice(0, punkt); // endelsen for en annen filtype byttes ut
  }
  stamme = stamme.replace(/^[.\s]+/, "").slice(0, 100).trim() || "Vedlegg";
  return stamme + ny;
}

// Content-Disposition med filnavnet både som ASCII og UTF-8 (RFC 6266/5987).
export function disposisjon(filnavn: string, inline = false): string {
  const ascii = filnavn
    .replace(/[æÆøØ]/g, (c) => ({ æ: "ae", Æ: "AE", ø: "o", Ø: "O" })[c]!)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\x20-\x7e]|["\\]/g, "_");
  const utf8 = encodeURIComponent(filnavn).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${inline ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

const arkivSti = (f: any, v: any) =>
  `${f.org_id}/${String(f.fakturadato).slice(0, 4)}/${f.type}-${f.fakturanummer}-${f.id}-vedlegg/${v.id}${TYPER[v.type]?.[0] ?? ""}`;

async function lesFil(v: any): Promise<Uint8Array | null> {
  if (v.arkiv_sti && config.fakturaBucket) {
    const data = await lagring.hent(config.fakturaBucket, v.arkiv_sti);
    if (data) return data;
  }
  return config.filerBucket ? lagring.hent(config.filerBucket, v.sti) : null;
}

export type Vedleggsfil = { filnavn: string; type: string; data: Uint8Array };

// Vedleggene på en faktura, i rekkefølge. Workeren (arkiver) legger første gang en kopi i
// fakturabøtta, som har oppbevaringsregel; den brukes deretter.
export async function vedleggFiler(db: Db, f: any, arkiver = false): Promise<Vedleggsfil[]> {
  const rader = await alle(db, "select * from faktura.vedlegg where faktura_id = $1 order by rekke, opprettet", [f.id]);
  const ut: Vedleggsfil[] = [];
  for (const v of rader) {
    const data = await lesFil(v);
    if (!data) throw new Error(`Fant ikke filen til vedlegget «${v.filnavn}» (${v.id})`);
    if (arkiver && !v.arkiv_sti && f.status !== "utkast" && config.fakturaBucket) {
      const sti = arkivSti(f, v);
      try {
        await lagring.lagre(config.fakturaBucket, sti, data, v.type);
      } catch (e) {
        if ((e as { code?: number }).code !== 412) throw e; // en annen kjøring rakk det først
      }
      await db.query("select faktura.arkiver_vedlegg($1, $2)", [v.id, sti]);
    }
    ut.push({ filnavn: v.filnavn, type: v.type, data });
  }
  return ut;
}

// Kobler opplastede vedlegg til et utkast (hele lista, i rekkefølge). Vedlegg som er
// fjernet, slettes; filene ryddes av workeren. Uten liste står vedleggene som de er.
export async function skrivVedlegg(db: Db, orgId: string, fakturaId: string, ider: string[] | undefined) {
  if (ider === undefined) return;
  await db.query("delete from faktura.vedlegg where faktura_id = $1 and not (id = any($2::uuid[]))", [fakturaId, ider]);
  for (const [i, id] of ider.entries()) {
    const r = await db.query(
      "update faktura.vedlegg set faktura_id = $3, rekke = $4 where id = $1 and org_id = $2 and (faktura_id is null or faktura_id = $3)",
      [id, orgId, fakturaId, i],
    );
    if (!r.rowCount) throw new ApiFeil(400, "Fant ikke et av vedleggene. Fjern det og legg det ved på nytt.");
  }
  const sum = await en(db, "select coalesce(sum(storrelse), 0)::int as sum from faktura.vedlegg where faktura_id = $1", [fakturaId]);
  if (sum!.sum > MAKS_STORRELSE) throw new ApiFeil(400, "Vedleggene kan til sammen være høyst 10 MB");
}

// Daglig (workeren): opplastinger som aldri ble lagret på en faktura, og filene etter
// vedlegg som er slettet.
export async function ryddVedlegg(): Promise<number> {
  await somSystem((db) => db.query("select faktura.rydd_vedlegg()"));
  const filer = await somSystem((db) => alle<{ sti: string }>(db, "select sti from faktura.slettede_filer order by opprettet limit 1000"));
  if (!filer.length || !config.filerBucket) return 0;
  const slettet: string[] = [];
  for (const { sti } of filer) {
    try {
      await lagring.slett(config.filerBucket, sti);
      slettet.push(sti);
    } catch (e) {
      console.log(JSON.stringify({ severity: "WARNING", message: "Kunne ikke slette fil", sti, feil: (e as Error).message }));
    }
  }
  if (slettet.length) await somSystem((db) => db.query("delete from faktura.slettede_filer where sti = any($1)", [slettet]));
  return slettet.length;
}

const uuid = z.string().uuid();
const orgId = (c: Context) => uuid.parse(c.req.param("org"));
const bruk = <T>(c: Context, fn: (db: Db) => Promise<T>) => somBruker<T>(c.get("bruker").id, fn);
const forStor = () => new ApiFeil(413, "Filen er for stor. Et vedlegg kan være høyst 10 MB.");

export function vedleggRuter() {
  const r = new Hono();

  // Laster opp en fil (rå data i kroppen, filnavnet URL-kodet i x-filnavn). Den står uten
  // faktura til utkastet lagres med den.
  r.post("/vedlegg", async (c) => {
    if (Number(c.req.header("content-length") ?? 0) > MAKS_STORRELSE) throw forStor();
    const data = new Uint8Array(await c.req.arrayBuffer());
    if (data.length === 0) throw new ApiFeil(400, "Filen er tom");
    if (data.length > MAKS_STORRELSE) throw forStor();
    let navn = "";
    try {
      navn = decodeURIComponent(c.req.header("x-filnavn") ?? "");
    } catch {
      navn = "";
    }
    const type = finnType(data, navn);
    if (!type)
      throw new ApiFeil(400, "Vedlegg kan være PDF, bilder (PNG eller JPG), CSV eller regneark (Excel eller OpenDocument). Lagre andre dokumenter som PDF først.");
    if (!config.filerBucket) throw new ApiFeil(503, "Lagring er ikke konfigurert");
    const id = randomUUID();
    const sti = `${orgId(c)}/vedlegg/${id}`;
    const v = await bruk(c, async (db) => {
      await db.query("select faktura.krev($1, 'skriv')", [orgId(c)]);
      const n = await en(db, "select count(*)::int as n from faktura.vedlegg where org_id = $1 and faktura_id is null", [orgId(c)]);
      if (n!.n >= MAKS_UTEN_FAKTURA) throw new ApiFeil(429, "For mange vedlegg som ikke er lagret på en faktura. Lagre fakturaene først, eller prøv igjen i morgen.");
      await lagring.lagre(config.filerBucket!, sti, data, type);
      try {
        return await en(
          db,
          "insert into faktura.vedlegg (id, org_id, filnavn, type, storrelse, sti) values ($1, $2, $3, $4, $5, $6) returning id, filnavn, type, storrelse",
          [id, orgId(c), rensFilnavn(navn, type), type, data.length, sti],
        );
      } catch (e) {
        await lagring.slett(config.filerBucket!, sti).catch(() => {});
        throw e;
      }
    });
    return c.json(v, 201);
  });

  // Et vedlegg på en faktura (utkast eller utstedt): en signert lenke i 10 minutter, som for
  // PDF-en. PDF og bilder vises i nettleseren, resten lastes ned.
  r.get("/fakturaer/:id/vedlegg/:vedlegg", async (c) => {
    const v = await bruk(c, (db) =>
      en(db, "select * from faktura.vedlegg where id = $1 and faktura_id = $2 and org_id = $3", [
        uuid.parse(c.req.param("vedlegg")),
        uuid.parse(c.req.param("id")),
        orgId(c),
      ]),
    );
    if (!v) throw new ApiFeil(404, "Fant ikke vedlegget");
    const [bucket, sti] = v.arkiv_sti && config.fakturaBucket ? [config.fakturaBucket, v.arkiv_sti] : [config.filerBucket, v.sti];
    if (!bucket) throw new ApiFeil(503, "Lagring er ikke konfigurert");
    const vises = v.type === "application/pdf" || v.type.startsWith("image/");
    return c.json({ url: await lagring.signertUrl(bucket, sti, 10, v.filnavn, { disposisjon: disposisjon(v.filnavn, vises), type: v.type }) });
  });

  return r;
}
