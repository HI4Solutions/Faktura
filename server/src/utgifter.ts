// Utgiftene (0090_utgifter.sql): leverandørfakturaer og kvitteringer. Fila lastes opp (eller tas
// bilde av) og lagres; AI leser den (aiUtgift.ts) når AI er slått på; reglene finner kontoen
// (leverandøren sist for samme slags kjøp, ellers kategorien), fradraget for mva og hvordan den skal
// føres (utgiftVurdering.ts). Den bokføres når den godkjennes, eller av seg selv når leverandøren er
// kjent og alt stemmer: kostnaden i serie U, et anleggsmiddel med anskaffelsen i serie A eller en
// periodisering med starten i serie P. Fila kopieres da til fakturabøtta, som oppbevarer den.
// Leverandørgjelden står til betalingen bokføres; bokføringen kan angres.
import { Hono, type Context } from "hono";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { alle, en, somBruker, type Db } from "./db.js";
import { ApiFeil } from "./feil.js";
import { config } from "./config.js";
import { lagring } from "./tjenester.js";
import { aiPaa, generer, iDagOslo, medKvote } from "./ai.js";
import { MAKS_UTGIFT, tilUtgift, UTGIFTSTYPER, utgiftForesporsel, type AiUtgift, type LestUtgift } from "./aiUtgift.js";
import { bokfor as bokforAnlegg, hentRegnskapsoppsett, KATEGORIER, KATEGORIKODER, regnskapskontoer, type Kategori, type Regnskapsoppsett } from "./anlegg.js";
import { bokforPeriodisering } from "./periodisering.js";
import { lagAnleggsmiddel } from "./regnskapRuter.js";
import { disposisjon } from "./vedlegg.js";
import {
  balansebilag,
  betalingsbilag,
  fradragFor,
  fradragsmerknader,
  kostnadsbilag,
  kostpris,
  KOSTNADSKATEGORIER,
  sumLinjer,
  utgiftstekst,
  vurder,
  type AiTolkning,
  type Kostnadskategori,
  type Utgiftsgrunnlag,
  type Utgiftslinje,
} from "./utgiftVurdering.js";

const uuid = z.string().uuid();
const orgId = (c: Context) => uuid.parse(c.req.param("org"));
const bruk = <T>(c: Context, fn: (db: Db) => Promise<T>) => somBruker<T>(c.get("bruker").id, fn);
const krev = (db: Db, org: string) => db.query("select faktura.krev($1, 'regnskap')", [org]);
const rund = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const iDag = () => iDagOslo().dato;
const ENDELSE: Record<string, string> = {
  "application/pdf": ".pdf",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/heic": ".heic",
  "image/heif": ".heif",
};

export type Utgift = Utgiftsgrunnlag & {
  id: string;
  status: "kladd" | "bokfort";
  orgnr: string | null;
  forfallsdato: string | null;
  kid: string | null;
  kontonr: string | null;
  valuta: string;
  betalt_dato: string | null;
  behandling: "kostnad" | "anlegg" | "periodisering";
  anlegg_kategori: Kategori | null;
  levetid_mnd: number | null;
  periode_fra: string | null;
  antall_maaneder: number | null;
  vurdering: string | null;
  fil_type: string | null;
  fil_navn: string | null;
  fil_sti: string | null;
  arkiv_sti: string | null;
  ai: { tolkning?: AiTolkning; merknader?: string[]; feil?: string; laert?: boolean } | null;
  auto: boolean;
  bilag_id: string | null;
  betaling_bilag_id: string | null;
  anlegg_id: string | null;
  periodisering_id: string | null;
  opprettet: string;
};

const KOLONNER = `u.id, u.status, u.type, u.leverandor, u.orgnr, u.fakturanummer, to_char(u.dato, 'YYYY-MM-DD') as dato,
  to_char(u.forfallsdato, 'YYYY-MM-DD') as forfallsdato, u.kid, u.kontonr, u.belop::float8 as belop, u.valuta, u.beskrivelse, u.betaling,
  to_char(u.betalt_dato, 'YYYY-MM-DD') as betalt_dato, u.behandling, u.anlegg_kategori, u.levetid_mnd, to_char(u.periode_fra, 'YYYY-MM-DD') as periode_fra,
  u.antall_maaneder, u.vurdering, u.utland, u.fil_type, u.fil_navn, u.fil_sti, u.arkiv_sti, u.ai, u.auto, u.bilag_id, u.betaling_bilag_id,
  u.anlegg_id, u.periodisering_id, u.opprettet,
  (select b.serie || '-' || b.aar || '-' || b.nummer from faktura.bilag b where b.id = u.bilag_id) as bilagsnummer,
  (select b.serie || '-' || b.aar || '-' || b.nummer from faktura.bilag b where b.id = u.betaling_bilag_id) as betaling_bilagsnummer`;

async function hentUtgift(db: Db, org: string, id: string) {
  const u = await en<Utgift & { bilagsnummer: string | null; betaling_bilagsnummer: string | null }>(
    db,
    `select ${KOLONNER} from faktura.utgifter u where u.org_id = $1 and u.id = $2`,
    [org, id],
  );
  if (!u) throw new ApiFeil(404, "Fant ikke utgiften");
  u.linjer = await alle<Utgiftslinje>(
    db,
    `select beskrivelse, kategori, konto, belop::float8 as belop, mva_sats::float8 as mva_sats, mva::float8 as mva, fradrag::float8 as fradrag
       from faktura.utgift_linjer where utgift_id = $1 order by rekke`,
    [id],
  );
  return u;
}

// Fradraget for inngående mva i prosent: oppsettet, ellers fullt for den som er mva-registrert.
async function standardFradrag(db: Db, org: string, o: Regnskapsoppsett) {
  if (o.mva_fradrag !== null) return o.mva_fradrag;
  const r = await en<{ m: boolean }>(db, "select mva_registrert as m from faktura.organisasjoner where id = $1", [org]);
  return r?.m ? 100 : 0;
}

// Det reglene foreslår for utgiften slik den er nå, med kontrollene som må stemme før den bokføres.
export function forslag(u: Utgift, o: Pick<Regnskapsoppsett, "periodiser_fra">) {
  const tolkning: AiTolkning = u.ai?.tolkning ?? { varig: false, anlegg_kategori: null, periode_fra: null, periode_til: null };
  const v = u.dato && u.linjer.length ? vurder({ utland: u.utland, linjer: u.linjer, dato: u.dato }, tolkning, o.periodiser_fra) : null;
  const mangler: string[] = [];
  if (!u.dato) mangler.push("Skriv datoen");
  else if (u.dato > iDag()) mangler.push("Datoen kan ikke være fram i tid");
  if (!u.belop) mangler.push("Skriv beløpet");
  if (!u.linjer.length) mangler.push("Legg inn minst én linje med konto og beløp");
  if (u.valuta !== "NOK") mangler.push(`Utgiften er i ${u.valuta}: skriv beløpene i kroner (det som ble betalt), og sett valutaen til NOK`);
  if (u.belop && u.linjer.length && Math.abs(sumLinjer(u) - u.belop) >= 0.005)
    mangler.push(`Linjene er ${kroner(sumLinjer(u))} kr${u.utland ? "" : " med mva"}, men utgiften er ${kroner(u.belop)} kr`);
  if (u.behandling === "anlegg" && (!u.anlegg_kategori || !u.levetid_mnd)) mangler.push("Velg hva slags anleggsmiddel det er og levetiden");
  if (u.behandling === "periodisering" && (!u.periode_fra || !u.antall_maaneder)) mangler.push("Velg den første måneden og antall måneder");
  return { forslag: v, mangler, merknader: fradragsmerknader(u.linjer) };
}
const kroner = (n: number) => n.toLocaleString("nb-NO", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).replace(/[\u00a0\u202f]/g, " ");

async function detalj(db: Db, org: string, id: string) {
  const u = await hentUtgift(db, org, id);
  const o = await hentRegnskapsoppsett(db, org);
  const { ai, fil_sti, arkiv_sti, ...resten } = u;
  return {
    ...resten,
    har_fil: Boolean(fil_sti || arkiv_sti),
    merknader_ai: ai?.merknader ?? [],
    ai_feil: ai?.feil ?? null,
    laert: ai?.laert ?? false,
    ...forslag(u, o),
  };
}

// Kontoene leverandøren har fått før, per slags kjøp (det siste først).
async function leverandorKontoer(db: Db, org: string, orgnr: string | null, navn: string | null) {
  if (!orgnr && !navn) return { kjent: false, kontoer: new Map<string, string>() };
  const rader = await alle<{ kategori: string | null; konto: string }>(
    db,
    `select l.kategori, l.konto from faktura.utgift_linjer l join faktura.utgifter u on u.id = l.utgift_id
      where u.org_id = $1 and u.status = 'bokfort'
        and (($2::text is not null and u.orgnr = $2) or ($2::text is null and lower(u.leverandor) = lower($3)))
      order by u.bokfort_at desc, l.rekke
      limit 200`,
    [org, orgnr, navn],
  );
  const kontoer = new Map<string, string>();
  for (const r of rader) if (!kontoer.has(r.kategori ?? "")) kontoer.set(r.kategori ?? "", r.konto);
  return { kjent: rader.length > 0, kontoer };
}

// Det AI leste lagres på utgiften (kladden): feltene, linjene med kontoen og fradraget, og
// vurderingen. Gir om alt er lært fra leverandøren (kontoen for hver linje).
async function fyllUt(db: Db, org: string, id: string, les: LestUtgift) {
  const o = await hentRegnskapsoppsett(db, org);
  const standard = await standardFradrag(db, org, o);
  const mvaRegistrert = (await en<{ m: boolean }>(db, "select mva_registrert as m from faktura.organisasjoner where id = $1", [org]))?.m ?? false;
  const { kjent, kontoer } = await leverandorKontoer(db, org, les.orgnr, les.leverandor);
  // Tjenester fra utlandet: snudd avregning bare for den som er mva-registrert.
  const utland = les.utland && mvaRegistrert;
  const merknader = [...les.merknader];
  if (les.utland && !mvaRegistrert)
    merknader.push("Tjenester kjøpt fra utlandet: den som ikke er mva-registrert, kan måtte betale mva på dem med en særskilt melding.");
  let laert = kjent;
  const linjer: Utgiftslinje[] = les.linjer.map((l) => {
    const konto = kontoer.get(l.kategori);
    if (!konto) laert = false;
    return {
      beskrivelse: l.beskrivelse,
      kategori: l.kategori,
      konto: konto ?? KOSTNADSKATEGORIER[l.kategori].konto,
      belop: l.belop,
      mva_sats: utland ? 0 : l.mva_sats,
      mva: utland ? 0 : l.mva,
      fradrag: l.mva_sats > 0 || utland ? fradragFor(l.kategori, standard) : 0,
    };
  });
  const tolkning: AiTolkning = { varig: les.varig, anlegg_kategori: les.anlegg_kategori, periode_fra: les.periode_fra, periode_til: les.periode_til };
  const dato = les.dato ?? iDag();
  const v = linjer.length ? vurder({ utland, linjer, dato }, tolkning, o.periodiser_fra) : null;
  await db.query(
    `update faktura.utgifter set type = $3, leverandor = $4, orgnr = $5, fakturanummer = $6, dato = $7, forfallsdato = $8, kid = $9, kontonr = $10,
            belop = $11, valuta = $12, betaling = $13, utland = $14, behandling = $15, anlegg_kategori = $16, levetid_mnd = $17, periode_fra = $18,
            antall_maaneder = $19, vurdering = $20, ai = $21
      where org_id = $1 and id = $2`,
    [
      org,
      id,
      les.type,
      les.leverandor,
      les.orgnr,
      les.fakturanummer,
      dato,
      les.forfallsdato,
      les.kid,
      les.kontonr,
      les.belop,
      les.valuta,
      les.type === "kvittering" ? "bank" : "ubetalt",
      utland,
      v?.behandling ?? "kostnad",
      v?.anlegg_kategori ?? null,
      v?.levetid_mnd ?? null,
      v?.periode_fra ?? null,
      v?.antall_maaneder ?? null,
      v?.vurdering ?? null,
      JSON.stringify({ tolkning, merknader, laert }),
    ],
  );
  await skrivLinjer(db, org, id, linjer);
  return { laert, merknader, v };
}

async function skrivLinjer(db: Db, org: string, id: string, linjer: Utgiftslinje[]) {
  await db.query("delete from faktura.utgift_linjer where utgift_id = $1", [id]);
  for (const [i, l] of linjer.entries())
    await db.query(
      `insert into faktura.utgift_linjer (org_id, utgift_id, rekke, beskrivelse, kategori, konto, belop, mva_sats, mva, fradrag)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [org, id, i + 1, l.beskrivelse, l.kategori, l.konto, l.belop, l.mva_sats, l.mva, l.fradrag],
    );
}

// AI er slått på for organisasjonen (og satt opp).
async function aiTilgjengelig(db: Db, org: string) {
  if (!aiPaa()) return false;
  return (await en<{ k: boolean }>(db, "select faktura.har_funksjon(o.id, 'ai') and o.ai_aktiv as k from faktura.organisasjoner o where o.id = $1", [org]))?.k ?? false;
}

// Leser fila med AI (i kvoten for organisasjonen).
async function lesFil(brukerId: string, org: string, data: Uint8Array, mime: string, kjoper: string) {
  const kjor = <X>(fn: (db: Db) => Promise<X>) => somBruker<X>(brukerId, fn);
  const svar = await medKvote(kjor, org, "utgift", () =>
    generer<AiUtgift>(utgiftForesporsel({ mimeType: UTGIFTSTYPER[mime] ?? mime, data: Buffer.from(data).toString("base64") }, kjoper)),
  );
  return tilUtgift(svar.data, iDag());
}

// --- Bokføringen --------------------------------------------------------------------------------

// Bokfører utgiften slik den står (kladden), og kopierer fila til fakturabøtta.
export async function bokforUtgift(db: Db, org: string, id: string, auto = false) {
  const u = await hentUtgift(db, org, id);
  if (u.status !== "kladd") throw new ApiFeil(409, "Utgiften er alt bokført");
  const o = await hentRegnskapsoppsett(db, org);
  const { mangler } = forslag(u, o);
  if (mangler.length) throw new ApiFeil(400, mangler[0]!);
  const k = regnskapskontoer(o);
  if (u.behandling === "kostnad") {
    const b = kostnadsbilag(u, k);
    await db.query("select faktura.bokfor_utgift($1, $2, $3, $4::jsonb, $5)", [org, id, b.tekst, JSON.stringify(b.posteringer), auto]);
  } else if (u.behandling === "anlegg") {
    const kategori = u.anlegg_kategori!;
    const navn = (u.beskrivelse || u.linjer[0]?.beskrivelse || utgiftstekst(u)).slice(0, 120);
    const anlegg = await lagAnleggsmiddel(db, org, {
      navn,
      beskrivelse: utgiftstekst(u).slice(0, 500),
      kategori,
      anskaffet: u.dato,
      kostpris: kostpris(u),
      levetid_mnd: u.levetid_mnd,
    });
    const tekst = `Anskaffelse: ${navn}`;
    const bilag = await bokforAnlegg(db, org, {
      dato: u.dato,
      tekst,
      posteringer: balansebilag(u, KATEGORIER[kategori].konto, tekst, k),
      hendelser: [{ anleggsmiddel_id: anlegg, type: "anskaffelse", belop: kostpris(u) }],
    });
    await db.query("select faktura.koble_utgift($1, $2, $3, $4, null, $5)", [org, id, bilag.id, anlegg, auto]);
  } else {
    const navn = (u.beskrivelse || u.linjer[0]?.beskrivelse || utgiftstekst(u)).slice(0, 120);
    const resultatkonto = [...u.linjer].sort((a, b) => Math.abs(b.belop) - Math.abs(a.belop))[0]!.konto;
    if (resultatkonto === k.forskuddsbetalt_kostnad) throw new ApiFeil(400, "Kostnadskontoen kan ikke være balansekontoen for forskuddet");
    const p = await en<{ id: string; nummer: number }>(
      db,
      `insert into faktura.periodiseringer (org_id, navn, type, belop, fra, antall_maaneder, resultatkonto, balansekonto, start, tekst)
       values ($1, $2, 'forskuddsbetalt_kostnad', $3, $4, $5, $6, $7, 'motkonto', $8) returning id, nummer`,
      [org, navn, kostpris(u), u.periode_fra, u.antall_maaneder, resultatkonto, k.forskuddsbetalt_kostnad, utgiftstekst(u).slice(0, 300)],
    );
    const tekst = `Forskuddsbetalt kostnad: ${navn} (nr. ${p!.nummer})`;
    const bilag = await bokforPeriodisering(db, org, {
      dato: u.dato,
      tekst,
      posteringer: balansebilag(u, k.forskuddsbetalt_kostnad, tekst, k),
      poster: [{ periodisering_id: p!.id, type: "start", belop: kostpris(u) }],
    });
    await db.query("select faktura.koble_utgift($1, $2, $3, null, $4, $5)", [org, id, bilag.id, p!.id, auto]);
  }
  await arkiver(db, org, id);
  return detalj(db, org, id);
}

// Kopien av fila i fakturabøtta (oppbevares i fem år etter regnskapsåret, bokføringsloven § 13).
async function arkiver(db: Db, org: string, id: string) {
  const u = await en<{ fil_sti: string | null; fil_type: string | null; arkiv_sti: string | null; bilagsnummer: string; dato: string }>(
    db,
    `select u.fil_sti, u.fil_type, u.arkiv_sti, b.serie || '-' || b.aar || '-' || b.nummer as bilagsnummer, to_char(u.dato, 'YYYY-MM-DD') as dato
       from faktura.utgifter u join faktura.bilag b on b.id = u.bilag_id where u.org_id = $1 and u.id = $2`,
    [org, id],
  );
  if (!u?.fil_sti || u.arkiv_sti || !config.fakturaBucket || !config.filerBucket) return;
  const data = await lagring.hent(config.filerBucket, u.fil_sti);
  if (!data) return;
  const sti = `${org}/${u.dato.slice(0, 4)}/utgift-${u.bilagsnummer}-${id}${ENDELSE[u.fil_type ?? ""] ?? ""}`;
  try {
    await lagring.lagre(config.fakturaBucket, sti, data, u.fil_type ?? "application/octet-stream");
  } catch (e) {
    if ((e as { code?: number }).code !== 412) throw e; // lagret før (bokført, angret og bokført igjen)
  }
  await db.query("select faktura.arkiver_utgift($1, $2, $3)", [org, id, sti]);
}

// Bokfører av seg selv når leverandøren er kjent (kontoen for hver linje er lært), utgiften er en
// kostnad i kroner uten merknader, og alt stemmer.
async function bokforAutomatisk(db: Db, org: string, id: string) {
  const o = await hentRegnskapsoppsett(db, org);
  if (!o.utgifter_auto) return false;
  const u = await hentUtgift(db, org, id);
  const { forslag: v, mangler } = forslag(u, o);
  if (!u.ai?.laert || u.ai.merknader?.length || mangler.length || u.behandling !== "kostnad" || v?.behandling !== "kostnad" || !u.orgnr) return false;
  await db.query("savepoint auto");
  try {
    await bokforUtgift(db, org, id, true);
    await db.query("release savepoint auto");
    return true;
  } catch {
    await db.query("rollback to savepoint auto");
    return false;
  }
}

// --- Rutene -------------------------------------------------------------------------------------

const datoS = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Ugyldig dato");
const linjeS = z.object({
  beskrivelse: z.string().trim().max(200, "Beskrivelsen kan være høyst 200 tegn").nullable().optional(),
  kategori: z.string().regex(/^[a-z_]{2,40}$/).nullable().optional(),
  konto: z.string({ error: "Velg kontoen" }).regex(/^\d{4,6}$/, "Kontonummeret må ha 4–6 siffer"),
  belop: z.number({ error: "Skriv beløpet" }).finite().refine((n) => n !== 0, "Beløpet kan ikke være 0").refine((n) => Math.abs(n) < 1e11, "Beløpet er for stort"),
  mva_sats: z.number().finite().min(0).max(100).optional(),
  mva: z.number().finite().refine((n) => Math.abs(n) < 1e11).optional(),
  fradrag: z.number().finite().min(0, "Fradraget er i prosent").max(100, "Fradraget er i prosent").optional(),
});
const utgiftS = z.object({
  type: z.enum(["faktura", "kvittering"]).optional(),
  leverandor: z.string().trim().max(200, "Navnet kan være høyst 200 tegn").nullable().optional(),
  orgnr: z.string().regex(/^\d{9}$/, "Organisasjonsnummeret må ha 9 siffer").nullable().optional(),
  fakturanummer: z.string().trim().max(60).nullable().optional(),
  dato: datoS.nullable().optional(),
  forfallsdato: datoS.nullable().optional(),
  kid: z.string().regex(/^\d{2,25}$/, "KID-nummeret er 2–25 siffer").nullable().optional(),
  kontonr: z.string().regex(/^\d{11}$/, "Kontonummeret må ha 11 siffer").nullable().optional(),
  belop: z.number().finite().positive("Beløpet må være over 0").lt(1e11, "Beløpet er for stort").nullable().optional(),
  valuta: z.string().regex(/^[A-Z]{3}$/, "Valutaen er tre bokstaver").optional(),
  beskrivelse: z.string().trim().max(500).nullable().optional(),
  betaling: z.enum(["ubetalt", "bank", "kontant", "ansatt"]).optional(),
  behandling: z.enum(["kostnad", "anlegg", "periodisering"]).optional(),
  anlegg_kategori: z.enum(KATEGORIKODER).nullable().optional(),
  levetid_mnd: z.number().int().min(1).max(1200).nullable().optional(),
  periode_fra: z.string().regex(/^\d{4}-\d{2}(-01)?$/, "Ugyldig måned").nullable().optional(),
  antall_maaneder: z.number().int().min(1, "Minst én måned").max(120, "Høyst 120 måneder").nullable().optional(),
  utland: z.boolean().optional(),
  linjer: z.array(linjeS).max(100, "Høyst 100 linjer").optional(),
});
const FELT = [
  "type", "leverandor", "orgnr", "fakturanummer", "dato", "forfallsdato", "kid", "kontonr", "belop", "valuta", "beskrivelse", "betaling",
  "behandling", "anlegg_kategori", "levetid_mnd", "periode_fra", "antall_maaneder", "utland",
] as const;

// Endrer kladden: feltene som er med, og linjene (hele lista). Vurderingen regnes på nytt.
async function endre(db: Db, org: string, id: string, b: z.infer<typeof utgiftS>) {
  const naa = await hentUtgift(db, org, id);
  if (naa.status !== "kladd") throw new ApiFeil(409, "Utgiften er bokført. Angre bokføringen for å endre den.");
  const sett: string[] = [];
  const verdier: unknown[] = [org, id];
  for (const f of FELT) {
    if (b[f] === undefined) continue;
    let v: unknown = b[f];
    if (f === "periode_fra" && typeof v === "string") v = `${v.slice(0, 7)}-01`;
    if (typeof v === "string" && v.trim() === "") v = null;
    verdier.push(v);
    sett.push(`${f} = $${verdier.length}`);
  }
  if (b.anlegg_kategori && b.levetid_mnd === undefined && !naa.levetid_mnd) {
    verdier.push(KATEGORIER[b.anlegg_kategori].levetid);
    sett.push(`levetid_mnd = $${verdier.length}`);
  }
  if (sett.length) await db.query(`update faktura.utgifter set ${sett.join(", ")} where org_id = $1 and id = $2`, verdier);
  if (b.linjer) {
    const o = await hentRegnskapsoppsett(db, org);
    const standard = await standardFradrag(db, org, o);
    await skrivLinjer(
      db,
      org,
      id,
      b.linjer.map((l) => ({
        beskrivelse: l.beskrivelse ?? null,
        kategori: l.kategori ?? null,
        konto: l.konto,
        belop: rund(l.belop),
        mva_sats: l.mva_sats ?? 0,
        mva: rund(l.mva ?? 0),
        fradrag: l.fradrag ?? (l.mva_sats ? fradragFor(l.kategori ?? null, standard) : 0),
      })),
    );
  }
  // Vurderingen etter endringen (teksten; behandlingen er den som er valgt).
  const u = await hentUtgift(db, org, id);
  const o = await hentRegnskapsoppsett(db, org);
  const v = forslag(u, o).forslag;
  await db.query("update faktura.utgifter set vurdering = $3 where org_id = $1 and id = $2", [org, id, v?.vurdering ?? null]);
}

export function utgiftRuter() {
  const r = new Hono();

  // Lista: kladdene (til godkjenning), de ubetalte og de siste bokførte.
  r.get("/regnskap/utgifter", async (c) =>
    c.json(
      await bruk(c, async (db) => {
        await krev(db, orgId(c));
        const rader = await alle<Utgift & { bilagsnummer: string | null; betaling_bilagsnummer: string | null; sum_linjer: number }>(
          db,
          `select ${KOLONNER} from faktura.utgifter u
            where u.org_id = $1 and (u.status = 'kladd' or u.betaling = 'ubetalt' or u.dato >= faktura.i_dag() - 365 or u.dato is null)
            order by (u.status = 'kladd') desc, (u.betaling = 'ubetalt') desc, u.dato desc nulls first, u.opprettet desc
            limit 500`,
          [orgId(c)],
        );
        const o = await hentRegnskapsoppsett(db, orgId(c));
        return {
          utgifter: rader.map(({ ai, fil_sti, arkiv_sti, ...u }) => ({ ...u, har_fil: Boolean(fil_sti || arkiv_sti), laert: ai?.laert ?? false })),
          ai: await aiTilgjengelig(db, orgId(c)),
          auto: o.utgifter_auto,
          kategorier: Object.entries(KOSTNADSKATEGORIER).map(([kode, k]) => ({ kode, navn: k.navn, konto: k.konto, fradrag: k.fradrag })),
          anleggskategorier: KATEGORIKODER.filter((k) => k !== "goodwill" && k !== "tomt").map((kode) => ({ kode, navn: KATEGORIER[kode].navn, levetid: KATEGORIER[kode].levetid })),
        };
      }),
    ),
  );

  // Ny utgift: en fil (rå data i kroppen med filtypen, filnavnet URL-kodet i x-filnavn) som lagres og
  // leses med AI, eller JSON (fylt ut for hånd).
  r.post("/regnskap/utgifter", async (c) => {
    const type = (c.req.header("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    const brukerId = c.get("bruker").id as string;
    const org = orgId(c);
    if (type === "application/json") {
      const b = utgiftS.parse(await c.req.json().catch(() => ({})));
      return c.json(
        await bruk(c, async (db) => {
          await krev(db, org);
          const ny = await en<{ id: string }>(db, "insert into faktura.utgifter (org_id, dato) values ($1, $2) returning id", [org, b.dato ?? iDag()]);
          await endre(db, org, ny!.id, b);
          return detalj(db, org, ny!.id);
        }),
        201,
      );
    }
    const mime = UTGIFTSTYPER[type];
    if (!mime) throw new ApiFeil(400, "Fakturaen eller kvitteringen må være en PDF eller et bilde (JPG, PNG, WebP eller HEIC).");
    if (Number(c.req.header("content-length") ?? 0) > MAKS_UTGIFT) throw forStor();
    const data = new Uint8Array(await c.req.arrayBuffer());
    if (data.length < 100) throw new ApiFeil(422, "Fila er tom.");
    if (data.length > MAKS_UTGIFT) throw forStor();
    if (mime === "application/pdf" && !Buffer.from(data).subarray(0, 1024).includes("%PDF")) throw new ApiFeil(422, "Fila er ikke en PDF.");
    if (!config.filerBucket) throw new ApiFeil(503, "Lagring er ikke konfigurert");
    let filnavn = "";
    try {
      filnavn = decodeURIComponent(c.req.header("x-filnavn") ?? "");
    } catch {
      filnavn = "";
    }
    filnavn = (filnavn.split(/[\\/]/).pop() ?? "").replace(/[\u0000-\u001f\u007f"<>|*?:]/g, "").trim().slice(0, 200) || `utgift${ENDELSE[mime] ?? ""}`;

    // Fila lagres og kladden lages først (fila er dokumentasjonen, også når AI ikke kan lese den).
    const id = randomUUID();
    const sti = `${org}/utgifter/${id}${ENDELSE[mime] ?? ""}`;
    const { ai, kjoper } = await bruk(c, async (db) => {
      await krev(db, org);
      await lagring.lagre(config.filerBucket!, sti, data, mime);
      try {
        await db.query(
          `insert into faktura.utgifter (id, org_id, dato, fil_sti, fil_type, fil_navn, fil_storrelse) values ($1, $2, $3, $4, $5, $6, $7)`,
          [id, org, iDag(), sti, mime, filnavn, data.length],
        );
      } catch (e) {
        await lagring.slett(config.filerBucket!, sti).catch(() => {});
        throw e;
      }
      const navn = (await en<{ navn: string }>(db, "select navn from faktura.organisasjoner where id = $1", [org]))!.navn;
      return { ai: await aiTilgjengelig(db, org), kjoper: navn };
    });
    if (ai) {
      let les: LestUtgift | null = null;
      let feil: string | null = null;
      try {
        les = await lesFil(brukerId, org, data, mime, kjoper);
      } catch (e) {
        feil = e instanceof ApiFeil ? e.message : "AI-en kunne ikke lese fila.";
      }
      await bruk(c, async (db) => {
        if (les) {
          await fyllUt(db, org, id, les);
          await bokforAutomatisk(db, org, id);
        } else await db.query("update faktura.utgifter set ai = $3 where org_id = $1 and id = $2", [org, id, JSON.stringify({ feil })]);
      });
    }
    return c.json(await bruk(c, (db) => detalj(db, org, id)), 201);
  });

  r.get("/regnskap/utgifter/:id", async (c) =>
    c.json(
      await bruk(c, async (db) => {
        await krev(db, orgId(c));
        return detalj(db, orgId(c), uuid.parse(c.req.param("id")));
      }),
    ),
  );

  // Fila: en signert lenke i 10 minutter (PDF og bilder vises i nettleseren).
  r.get("/regnskap/utgifter/:id/fil", async (c) => {
    const u = await bruk(c, async (db) => {
      await krev(db, orgId(c));
      return en<{ fil_sti: string | null; arkiv_sti: string | null; fil_type: string | null; fil_navn: string | null }>(
        db,
        "select fil_sti, arkiv_sti, fil_type, fil_navn from faktura.utgifter where org_id = $1 and id = $2",
        [orgId(c), uuid.parse(c.req.param("id"))],
      );
    });
    if (!u) throw new ApiFeil(404, "Fant ikke utgiften");
    const [bucket, sti] = u.arkiv_sti && config.fakturaBucket ? [config.fakturaBucket, u.arkiv_sti] : [config.filerBucket, u.fil_sti];
    if (!sti) throw new ApiFeil(404, "Utgiften har ingen fil");
    if (!bucket) throw new ApiFeil(503, "Lagring er ikke konfigurert");
    const navn = u.fil_navn ?? "utgift";
    return c.json({ url: await lagring.signertUrl(bucket, sti, 10, navn, { disposisjon: disposisjon(navn, true), type: u.fil_type ?? undefined }) });
  });

  r.patch("/regnskap/utgifter/:id", async (c) => {
    const b = utgiftS.parse(await c.req.json().catch(() => ({})));
    return c.json(
      await bruk(c, async (db) => {
        await krev(db, orgId(c));
        const id = uuid.parse(c.req.param("id"));
        await endre(db, orgId(c), id, b);
        return detalj(db, orgId(c), id);
      }),
    );
  });

  // Leser fila på nytt med AI (kladden fylles ut på nytt).
  r.post("/regnskap/utgifter/:id/les", async (c) => {
    const org = orgId(c);
    const id = uuid.parse(c.req.param("id"));
    const brukerId = c.get("bruker").id as string;
    const { u, kjoper } = await bruk(c, async (db) => {
      await krev(db, org);
      const u = await hentUtgift(db, org, id);
      if (u.status !== "kladd") throw new ApiFeil(409, "Utgiften er bokført. Angre bokføringen for å lese den på nytt.");
      if (!(await aiTilgjengelig(db, org))) throw new ApiFeil(409, "AI er ikke slått på for organisasjonen");
      return { u, kjoper: (await en<{ navn: string }>(db, "select navn from faktura.organisasjoner where id = $1", [org]))!.navn };
    });
    if (!u.fil_sti || !u.fil_type || !config.filerBucket) throw new ApiFeil(409, "Utgiften har ingen fil å lese");
    const data = await lagring.hent(config.filerBucket, u.fil_sti);
    if (!data) throw new ApiFeil(404, "Fant ikke fila");
    const les = await lesFil(brukerId, org, data, u.fil_type, kjoper);
    return c.json(
      await bruk(c, async (db) => {
        await fyllUt(db, org, id, les);
        return detalj(db, org, id);
      }),
    );
  });

  r.post("/regnskap/utgifter/:id/bokfor", async (c) =>
    c.json(
      await bruk(c, async (db) => {
        await krev(db, orgId(c));
        return bokforUtgift(db, orgId(c), uuid.parse(c.req.param("id")));
      }),
    ),
  );

  // Betalingen av leverandørgjelden (fra banken eller i kontanter).
  r.post("/regnskap/utgifter/:id/betal", async (c) => {
    const b = z.object({ dato: datoS, fra: z.enum(["bank", "kontant"]).optional() }).parse(await c.req.json().catch(() => ({})));
    return c.json(
      await bruk(c, async (db) => {
        await krev(db, orgId(c));
        const id = uuid.parse(c.req.param("id"));
        const u = await hentUtgift(db, orgId(c), id);
        const k = regnskapskontoer(await hentRegnskapsoppsett(db, orgId(c)));
        const bilag = betalingsbilag(u, b.fra ?? "bank", k);
        await db.query("select faktura.betal_utgift($1, $2, $3, $4, $5, $6::jsonb)", [orgId(c), id, b.dato, b.fra ?? "bank", bilag.tekst, JSON.stringify(bilag.posteringer)]);
        return detalj(db, orgId(c), id);
      }),
    );
  });

  r.post("/regnskap/utgifter/:id/angre", async (c) =>
    c.json(
      await bruk(c, async (db) => {
        await krev(db, orgId(c));
        const id = uuid.parse(c.req.param("id"));
        await db.query("select faktura.angre_utgift($1, $2)", [orgId(c), id]);
        return detalj(db, orgId(c), id);
      }),
    ),
  );

  // En kladd slettes (med fila, når den ikke er arkivert).
  r.delete("/regnskap/utgifter/:id", async (c) => {
    const sti = await bruk(c, async (db) => {
      await krev(db, orgId(c));
      const u = await en<{ fil_sti: string | null; arkiv_sti: string | null }>(
        db,
        "delete from faktura.utgifter where org_id = $1 and id = $2 returning fil_sti, arkiv_sti",
        [orgId(c), uuid.parse(c.req.param("id"))],
      );
      if (!u) throw new ApiFeil(404, "Fant ikke utgiften");
      return u.fil_sti;
    });
    if (sti && config.filerBucket) await lagring.slett(config.filerBucket, sti).catch(() => {});
    return c.body(null, 204);
  });

  return r;
}

const forStor = () => new ApiFeil(413, "Fila er for stor. Fakturaer og kvitteringer kan være høyst 12 MB.");

export type { Kostnadskategori };
