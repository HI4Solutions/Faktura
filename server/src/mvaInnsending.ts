// Mva-meldingen sendes til Skatteetaten fra appen (docs/mva-innsending.md, 0125_mva_innsending.sql).
// Skatteetaten tar ikke imot mva-meldingen med systembruker ennå, så den som sender, logger inn i
// ID-porten (idporten.ts), og må ha rett til å sende for organisasjonen i Altinn (tilgangspakken
// «Merverdiavgift», eller regnskapsfører med signeringsrett):
//  1. Brukeren trykker «Send til Skatteetaten» under Regnskap → Mva. Meldingen fryses (XML-en,
//     linjene og summen), og appen sender brukeren til ID-porten.
//  2. ID-porten sender brukeren tilbake til appen (/mva/idporten), som gir koden til API-et. API-et
//     sjekker state mot innsendingen og brukeren, og legger sendingen i kø.
//  3. Workeren bytter koden mot tokenene og sjekker ID-tokenet, validerer meldingen hos Skatteetaten
//     (ugyldig: den sendes ikke, og avvikene vises), bytter ID-porten-tokenet til et Altinn-token,
//     lager instansen i Skatteetatens app i Altinn, laster opp konvolutten og meldingen og fullfører
//     utfyllingen og innsendingen. Da er meldingen levert: terminen merkes som levert, og
//     betalingsinformasjonen hentes.
//  4. Tilbakemeldingen (kvitteringen som PDF, valideringsresultatet og statusen i Altinn) hentes når
//     Skatteetaten har behandlet meldingen. Workeren spør igjen med litt mellomrom så lenge
//     Altinn-tokenet varer; ellers ligger kvitteringen i Altinn.
// Tokenene lagres ikke, bortsett fra Altinn-tokenet (kryptert) til tilbakemeldingen er hentet.
// Koden fra innloggingen kan bare brukes én gang, så sendingen prøves ikke på nytt av seg selv:
// feiler den, får innsendingen feil, og brukeren sender på nytt (og logger inn igjen).
// https://skatteetaten.github.io/api-dokumentasjon/api/mvameldinginnsending
import { Hono, type Context } from "hono";
import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { appUrlFra } from "./appadresse.js";
import { config } from "./config.js";
import { en, somBruker, somSystem, type Db } from "./db.js";
import { ApiFeil } from "./feil.js";
import { autoriseringsadresse, byttKode, jwtInnhold, lagNonce, lagPkce, mvaInnsendingPaa, sjekkIdToken } from "./idporten.js";
import { dekrypter, krypter } from "./kryptering.js";
import { adresser, EtatFeil, etatFetch } from "./maskinporten.js";
import { lagTermin, mvaStatus, osloIDag, sisteInnsending, terminFraSti, type Termintype } from "./mva.js";
import {
  konvoluttXml,
  lesBetalingsinformasjon,
  lesValideringsresultat,
  MELDING_FILNAVN,
  mvaMeldingXml,
  sjekkMerknad,
  type Avvik,
  type Merknad,
  type Valideringsresultat,
} from "./mvaMeldingXml.js";
import { dato as visDato } from "./regler.js";
import { leggIKo } from "./tjenester.js";

const logg = (severity: string, message: string, data: Record<string, unknown> = {}) => console.log(JSON.stringify({ severity, message, ...data }));
const melding = (e: unknown) => (e instanceof Error ? e.message : String(e));

// --- Altinn og Skatteetaten ------------------------------------------------------------------------

type Svar = { status: number; data: any; tekst: string; bytes: Buffer };
const VENT = [500, 1500];

// Kall med token. GET og PUT (og valideringen) prøves to ganger til når svaret ikke kom eller
// tjenesten var nede (502–504); andre POST bare når tjenesten svarte 503 (da er kallet ikke tatt
// imot), så instansen eller meldingen ikke lages to ganger.
async function kall(
  url: string,
  token: string,
  v: {
    metode?: "GET" | "POST" | "PUT";
    kropp?: unknown;
    xml?: string;
    innholdstype?: string;
    aksepter?: string;
    hoder?: Record<string, string>;
    provIgjen?: boolean;
  } = {},
): Promise<Svar> {
  const metode = v.metode ?? "GET";
  const provIgjen = v.provIgjen ?? metode !== "POST";
  for (let forsok = 0; ; forsok++) {
    let r: Response;
    try {
      r = await etatFetch(url, {
        method: metode,
        headers: {
          authorization: `Bearer ${token}`,
          accept: v.aksepter ?? "application/json",
          ...(v.xml !== undefined ? { "content-type": v.innholdstype ?? "application/xml" } : v.kropp !== undefined ? { "content-type": "application/json" } : {}),
          ...v.hoder,
        },
        body: v.xml ?? (v.kropp === undefined ? undefined : JSON.stringify(v.kropp)),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (e) {
      if (provIgjen && forsok < VENT.length) {
        await new Promise((ok) => setTimeout(ok, VENT[forsok]));
        continue;
      }
      throw new EtatFeil(`Fikk ikke svar (${new URL(url).host}): ${(e as Error).message}`, 0);
    }
    if ((provIgjen ? [502, 503, 504] : [503]).includes(r.status) && forsok < VENT.length) {
      await new Promise((ok) => setTimeout(ok, VENT[forsok]));
      continue;
    }
    const bytes = Buffer.from(await r.arrayBuffer().catch(() => new ArrayBuffer(0)));
    const tekst = bytes.toString("utf8");
    let data: any = null;
    try {
      data = tekst && (r.headers.get("content-type") ?? "").includes("json") ? JSON.parse(tekst) : null;
    } catch {
      data = null;
    }
    return { status: r.status, data, tekst, bytes };
  }
}

// Valideringsfeilene fra Altinn-appen (en liste med severity, code, description og field).
const altinnAvvik = (r: Svar): Avvik[] =>
  Array.isArray(r.data)
    ? r.data
        .filter((x: any) => x && typeof x === "object")
        .map((x: any) => ({
          alvor: Number(x.severity) === 1 || /error/i.test(String(x.severity)) ? ("ugyldig" as const) : ("avvik" as const),
          tekst: String(x.description ?? x.customTextKey ?? x.code ?? "Ukjent feil").slice(0, 1000),
          kode: typeof x.code === "string" ? x.code : null,
          regel: null,
          sti: typeof x.field === "string" ? x.field : null,
          mvaKode: null,
        }))
    : [];

// Den korte teksten fra et feilsvar (uten HTML).
const kort = (r: Svar) => {
  const liste = altinnAvvik(r);
  if (liste.length) return liste.map((a) => a.tekst).join("; ").slice(0, 300);
  const t = (typeof r.data === "string" ? r.data : (r.data?.detail ?? r.data?.title ?? r.data?.message ?? r.tekst) || "").toString();
  return /<html|<!doctype/i.test(t) ? "" : t.replace(/\s+/g, " ").trim().slice(0, 300);
};

// Meldingen ble avvist (valideringen eller Altinn-appen svarte med avvikene).
class Avvist extends EtatFeil {
  constructor(
    melding: string,
    readonly avvik: Avvik[],
  ) {
    super(melding, 409);
  }
}

// Valideringen hos Skatteetaten (med ID-porten-tokenet).
async function valider(token: string, melding: string): Promise<Valideringsresultat> {
  const r = await kall(adresser().mvaValidering, token, { metode: "POST", xml: melding, aksepter: "application/xml", provIgjen: true });
  if (r.status === 401 || r.status === 403)
    throw new EtatFeil(
      `Skatteetatens validering godtok ikke innloggingen (${r.status}). ID-porten-klienten må ha scopet skatteetaten:mvameldingvalidering, og leverandøren må ha fått tilgang til API-et av Skatteetaten.`,
      403,
    );
  if (r.status >= 300) throw new EtatFeil(`Skatteetatens validering svarte ${r.status}${kort(r) ? `: ${kort(r)}` : ""}`, r.status >= 500 ? r.status : 400);
  return lesValideringsresultat(r.tekst);
}

// ID-porten-tokenet byttes til et Altinn-token for Skatteetatens app.
async function altinnToken(idportenToken: string): Promise<string> {
  const r = await kall(`${adresser().altinn}/authentication/api/v1/exchange/id-porten`, idportenToken);
  if (r.status >= 300) throw new EtatFeil(`Altinn byttet ikke tokenet fra ID-porten (${r.status})${kort(r) ? `: ${kort(r)}` : ""}`, r.status >= 500 ? r.status : 401);
  const token = (typeof r.data === "string" ? r.data : r.tekst).trim().replace(/^"|"$/g, "");
  if (!/^[\w-]+\.[\w-]+\.[\w-]+$/.test(token)) throw new EtatFeil("Altinn svarte ikke med et token", 502);
  return token;
}

const app = () => adresser().mvaApp.replace(/\/+$/, "");
type Instans = {
  id: string;
  data?: { id: string; dataType: string; filename?: string | null; contentType?: string | null }[];
  process?: { currentTask?: { altinnTaskType?: string; elementId?: string; name?: string } | null; ended?: string | null } | null;
  status?: { substatus?: { label?: string | null; description?: string | null } | null } | null;
};
// Sendt inn: prosessen er i tilbakemeldingen eller ferdig.
const sendtInn = (i: Instans) =>
  Boolean(i.process?.ended) || i.process?.currentTask === null || /feedback|tilbakemelding/i.test(`${i.process?.currentTask?.altinnTaskType ?? ""} ${i.process?.currentTask?.name ?? ""}`);

function altinnFeil(r: Svar, hva: string): EtatFeil {
  if (r.status === 401) return new EtatFeil("Altinn godtok ikke innloggingen (den er utløpt). Prøv igjen.", 401);
  if (r.status === 403)
    return new EtatFeil(
      "Den som logget inn, har ikke rett til å sende mva-meldingen for organisasjonen i Altinn. Det trengs tilgangspakken «Merverdiavgift» (eller regnskapsfører med signeringsrett) for organisasjonen.",
      403,
    );
  return new EtatFeil(`${hva} (${r.status})${kort(r) ? `: ${kort(r)}` : ""}`, r.status >= 500 ? r.status : 400);
}

async function lagInstans(token: string, orgnr: string): Promise<Instans> {
  const r = await kall(`${app()}/instances/`, token, { metode: "POST", kropp: { instanceOwner: { organisationNumber: orgnr } } });
  if (r.status === 404) throw new EtatFeil(`Altinn fant ikke organisasjonen ${orgnr}.`, 404);
  if (r.status >= 300) throw altinnFeil(r, "Altinn laget ikke mva-meldingen");
  if (typeof r.data?.id !== "string") throw new EtatFeil("Altinn svarte uten instans", 502);
  return r.data;
}

async function hentInstans(token: string, instans: string): Promise<Instans> {
  const r = await kall(`${app()}/instances/${instans}`, token);
  if (r.status >= 300) throw altinnFeil(r, "Fant ikke mva-meldingen i Altinn");
  return r.data;
}

// Konvolutten: dataelementet appen lager med instansen (oppdateres med PUT).
async function lastOppKonvolutt(token: string, inst: Instans, xml: string) {
  const el = inst.data?.find((d) => /mvameldinginnsending/i.test(d.dataType)) ?? inst.data?.[0];
  if (!el) throw new EtatFeil("Instansen i Altinn mangler konvolutten (MvaMeldingInnsending)", 502);
  const r = await kall(`${app()}/instances/${inst.id}/data/${el.id}`, token, { metode: "PUT", xml });
  if (r.status >= 300) throw altinnFeil(r, "Altinn tok ikke imot konvolutten");
}

async function lastOppMelding(token: string, inst: Instans, xml: string) {
  const r = await kall(`${app()}/instances/${inst.id}/data?dataType=mvamelding`, token, {
    metode: "POST",
    xml,
    innholdstype: "text/xml",
    hoder: { "content-disposition": `attachment; filename=${MELDING_FILNAVN}` },
  });
  if (r.status >= 300) throw altinnFeil(r, "Altinn tok ikke imot mva-meldingen");
}

// Neste steg i prosessen (utfyllingen er ferdig, så innsendingen). 409: meldingen ble avvist, med
// valideringsresultatet, valideringsfeilene fra appen eller en tekst.
async function nesteSteg(token: string, inst: Instans, hva: string) {
  const r = await kall(`${app()}/instances/${inst.id}/process/next`, token, { metode: "PUT" });
  if (r.status === 409) {
    if (/valideringsresultat/i.test(r.tekst)) {
      const v = lesValideringsresultat(r.tekst);
      throw new Avvist(`Skatteetaten avviste meldingen ved ${hva} (se under). Den er ikke sendt.`, v.avvik);
    }
    const liste = altinnAvvik(r);
    if (liste.length) throw new Avvist(`Altinn avviste meldingen ved ${hva} (se under). Den er ikke sendt.`, liste);
    throw new Avvist(`Altinn avviste meldingen ved ${hva}: ${kort(r) || "ukjent grunn"}. Den er ikke sendt.`, []);
  }
  if (r.status >= 300) throw altinnFeil(r, `Altinn fullførte ikke ${hva}`);
}

// Har Skatteetaten gitt tilbakemelding? (status-endepunktet, ellers instansen)
async function tilbakemeldingGitt(token: string, inst: Instans): Promise<boolean> {
  const r = await kall(`${app()}/instances/${inst.id}/feedback/status`, token);
  if (r.status < 300 && typeof r.data?.isFeedbackProvided === "boolean") return r.data.isFeedbackProvided;
  if (r.status === 401) throw altinnFeil(r, "");
  return Boolean(inst.process?.ended) && Boolean(inst.data?.some((d) => d.dataType === "kvittering"));
}

async function hentData(token: string, inst: Instans, id: string, binar = false): Promise<Buffer> {
  const r = await kall(`${app()}/instances/${inst.id}/data/${id}`, token, { aksepter: binar ? "application/pdf, */*" : "application/xml, text/xml, */*" });
  if (r.status >= 300) throw altinnFeil(r, "Altinn ga ikke filen");
  return r.bytes;
}

// --- Rutene (under /api/org/:org) ------------------------------------------------------------------

const uuid = z.string().uuid();
const orgId = (c: Context) => uuid.parse(c.req.param("org"));
const bruk = <T>(c: Context, fn: (db: Db) => Promise<T>) => somBruker<T>(c.get("bruker").id, fn);
const krev = (db: Db, org: string) => db.query("select faktura.krev($1, 'regnskap')", [org]);
const merknadS = z.union([z.object({ utvalgt: z.string().min(1).max(200) }), z.object({ beskrivelse: z.string().max(4000) })]);

export function mvaInnsendingRuter() {
  const r = new Hono();

  // Starter innsendingen: meldingen fryses, og brukeren sendes til ID-porten.
  r.post("/regnskap/mva/:aar/:termin/send", async (c) => {
    if (!mvaInnsendingPaa()) throw new ApiFeil(503, "Innsending av mva-meldingen fra appen er ikke slått på.");
    const b = z.object({ merknader: z.array(merknadS.nullable()).max(200).optional() }).parse(await c.req.json().catch(() => ({})));
    const org = orgId(c);
    const tilbake = `${appUrlFra(c)}/mva/idporten`;
    const id = randomUUID();
    const state = `${org}.${randomBytes(18).toString("base64url")}`;
    const nonce = lagNonce();
    const { verifikator, utfordring } = lagPkce();
    // Adressen først: ID-portens oppsett hentes, og feiler det, lagres ingenting.
    const url = await autoriseringsadresse({ state, nonce, utfordring, tilbake }).catch((e) => {
      throw new ApiFeil(e instanceof EtatFeil && e.status === 503 ? 503 : 502, (e as Error).message);
    });
    await bruk(c, async (db) => {
      await krev(db, org);
      const t = await terminFraSti(db, c);
      const iDag = osloIDag();
      if (t.til >= iDag) throw new ApiFeil(409, "Terminen er ikke over. Meldingen sendes når den er over.");
      const o = await en<{ orgnr: string | null; mva_registrert: boolean }>(db, "select orgnr, mva_registrert from faktura.organisasjoner where id = $1", [org]);
      if (!o?.orgnr) throw new ApiFeil(409, "Organisasjonen mangler organisasjonsnummer.");
      if (!o.mva_registrert) throw new ApiFeil(409, "Organisasjonen er ikke registrert for merverdiavgift (Innstillinger → Organisasjon).");
      const s = await mvaStatus(db, org, t, iDag);
      if (s.levert && !s.endret)
        throw new ApiFeil(409, `Meldingen for terminen er levert ${visDato(s.levert.dato)}. Endres terminen etterpå, kan en korrigert melding sendes.`);
      const sender = await en(db, "select 1 from faktura.mva_innsendinger where org_id = $1 and aar = $2 and type = $3 and termin = $4 and status = 'sender'", [
        org,
        t.aar,
        t.type,
        t.termin,
      ]);
      if (sender) throw new ApiFeil(409, "Meldingen for terminen sendes allerede. Vent til den er ferdig.");
      const merknader: (Merknad | null)[] = s.linjer.map((_, i) => b.merknader?.[i] ?? null);
      const feil = s.linjer.map((l, i) => sjekkMerknad(l, merknader[i])).filter((x): x is string => x !== null);
      if (feil.length) throw new ApiFeil(400, feil.join(" "));
      const melding = mvaMeldingXml({
        orgnr: o.orgnr,
        termin: t,
        linjer: s.linjer,
        sum: s.sum,
        referanse: id,
        systemnavn: config.altinnSystemnavn,
        systemversjon: config.versjon,
        merknader,
      });
      await db.query(
        `insert into faktura.mva_innsendinger (id, org_id, aar, type, termin, state, nonce, verifikator, tilbake_url, utloper, melding, sum, linjer, startet_av)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, now() + interval '15 minutes', $10, $11, $12::jsonb, faktura.bruker_id())`,
        [id, org, t.aar, t.type, t.termin, state, nonce, verifikator, tilbake, melding, s.sum, JSON.stringify(s.linjer.map((l, i) => ({ ...l, merknad: merknader[i] })))],
      );
    });
    return c.json({ id, url }, 201);
  });

  // ID-porten har sendt brukeren tilbake, og appen gir videre koden (eller feilen). Sendingen legges
  // i kø; svaret sier hvilken termin det gjelder.
  r.post("/regnskap/mva/idporten", async (c) => {
    const b = z
      .object({ state: z.string().min(10).max(200), code: z.string().min(1).max(2000).optional(), error: z.string().max(200).optional(), error_description: z.string().max(1000).optional() })
      .parse(await c.req.json().catch(() => ({})));
    const org = orgId(c);
    const svar = await bruk(c, async (db) => {
      await krev(db, org);
      const rad = await en<{ id: string; aar: number; type: Termintype; termin: number; status: string; ute: boolean; egen: boolean }>(
        db,
        `select id, aar, type, termin, status, utloper < now() as ute, startet_av is not distinct from faktura.bruker_id() as egen
           from faktura.mva_innsendinger where org_id = $1 and state = $2`,
        [org, b.state],
      );
      if (!rad) throw new ApiFeil(404, "Fant ikke innsendingen. Start den på nytt under Regnskap → Mva.");
      if (!rad.egen) throw new ApiFeil(403, "Innloggingen ble startet av en annen bruker.");
      if (rad.status !== "innlogging") throw new ApiFeil(409, "Innloggingen er allerede brukt. Start innsendingen på nytt.");
      const resultat = (status: string) => ({ id: rad.id, aar: rad.aar, termin: rad.termin, status });
      const avbryt = async (feil: string) => {
        await db.query("update faktura.mva_innsendinger set status = 'avbrutt', state = null, feil = $2, oppdatert = now() where id = $1", [rad.id, feil]);
        return resultat("avbrutt");
      };
      if (b.error || !b.code) return avbryt(`Innloggingen i ID-porten ble avbrutt${b.error_description || b.error ? ` (${b.error_description ?? b.error})` : ""}. Meldingen er ikke sendt.`);
      if (rad.ute) return avbryt("Innloggingen tok for lang tid. Send meldingen på nytt.");
      await db.query("savepoint sender");
      try {
        await db.query("update faktura.mva_innsendinger set status = 'sender', state = null, feil = null, oppdatert = now() where id = $1", [rad.id]);
      } catch (e) {
        if ((e as { code?: string }).code !== "23505") throw e;
        await db.query("rollback to savepoint sender");
        return avbryt("Meldingen for terminen sendes allerede.");
      }
      return resultat("sender");
    });
    if (svar.status === "sender") {
      try {
        await leggIKo({ type: "mva-send", org_id: org, innsending_id: svar.id, kode: b.code! });
      } catch (e) {
        // Kom ikke i kø: koden er ubrukt, men meldingen sendes ikke, så brukeren sender på nytt.
        logg("ERROR", "Mva-sendingen ble ikke lagt i kø", { org_id: org, innsending_id: svar.id, feil: melding(e) });
        await bruk(c, (db) =>
          db.query("update faktura.mva_innsendinger set status = 'feil', feil = $2, oppdatert = now() where id = $1 and status = 'sender'", [
            svar.id,
            "Sendingen kom ikke i gang. Meldingen er ikke sendt; send den på nytt.",
          ]),
        );
        return c.json({ ...svar, status: "feil" });
      }
    }
    return c.json(svar);
  });

  // Den siste innsendingen for terminen (appen spør mens den sendes og tilbakemeldingen hentes).
  r.get("/regnskap/mva/:aar/:termin/innsending", async (c) =>
    c.json(
      await bruk(c, async (db) => {
        await krev(db, orgId(c));
        return { innsending: await sisteInnsending(db, orgId(c), await terminFraSti(db, c)) };
      }),
    ),
  );

  // Kvitteringen fra Skatteetaten (PDF).
  r.get("/regnskap/mva/innsending/:id/kvittering", async (c) => {
    const id = uuid.parse(c.req.param("id"));
    const k = await bruk(c, async (db) => {
      await krev(db, orgId(c));
      return en<{ kvittering: Buffer | null; aar: number; termin: number }>(db, "select kvittering, aar, termin from faktura.mva_innsendinger where org_id = $1 and id = $2", [orgId(c), id]);
    });
    if (!k?.kvittering) throw new ApiFeil(404, "Kvitteringen er ikke hentet ennå.");
    return c.body(k.kvittering as unknown as ArrayBuffer, 200, { "content-type": "application/pdf", "content-disposition": `attachment; filename="mva-kvittering-${k.aar}-${k.termin}.pdf"` });
  });

  return r;
}

// --- Workeren -------------------------------------------------------------------------------------

type Rad = {
  id: string;
  org_id: string;
  aar: number;
  type: Termintype;
  termin: number;
  status: string;
  nonce: string | null;
  verifikator: string | null;
  tilbake_url: string | null;
  melding: string;
  sum: string;
  instans: string | null;
  steg: string | null;
  betaling: unknown;
  altinn_token: Buffer | null;
  token_utloper: Date | null;
  startet_av: string | null;
  orgnr: string | null;
  navn: string | null;
};

const hentRad = (id: string) =>
  somSystem((db) =>
    en<Rad>(
      db,
      `select i.id, i.org_id, i.aar, i.type, i.termin, i.status, i.nonce, i.verifikator, i.tilbake_url, i.melding, i.sum, i.instans, i.steg, i.betaling,
              i.altinn_token, i.token_utloper, i.startet_av, o.orgnr, coalesce(u.navn, u.epost) as navn
         from faktura.mva_innsendinger i
         join faktura.organisasjoner o on o.id = i.org_id
         left join faktura.brukere u on u.id = i.startet_av
        where i.id = $1`,
      [id],
    ),
  );

// Oppdaterer raden (kolonnenavnene kommer fra koden), bare når statusen er den forventede.
async function oppdater(id: string, fra: string[], felt: Record<string, unknown>) {
  const k = Object.keys(felt);
  await somSystem((db) =>
    db.query(`update faktura.mva_innsendinger set ${k.map((x, i) => `${x} = $${i + 3}`).join(", ")}, oppdatert = now() where id = $1 and status = any($2::text[])`, [
      id,
      fra,
      ...k.map((x) => felt[x]),
    ]),
  );
}

// Sender meldingen (status sender). Bare én worker tar den (Cloud Tasks kan levere oppgaven to
// ganger), og den prøves ikke på nytt av seg selv: koden fra innloggingen kan bare brukes én gang.
export async function sendMvaMelding(org: string, id: string, kode: string) {
  const tatt = await somSystem((db) =>
    en(db, "update faktura.mva_innsendinger set steg = 'innlogging', oppdatert = now() where id = $1 and org_id = $2 and status = 'sender' and steg is null returning id", [id, org]),
  );
  if (!tatt) return;
  const r = (await hentRad(id))!;
  const t = lagTermin(r.aar, r.type, r.termin);
  let token: string | null = null;
  let inst: Instans | null = null;
  // Innsendingen (det siste steget) er bedt om: uten svar kan meldingen være sendt.
  let sendes = false;
  try {
    if (!mvaInnsendingPaa()) throw new EtatFeil("Innsending av mva-meldingen fra appen er ikke slått på.", 503);
    if (!r.orgnr || !r.verifikator || !r.nonce || !r.tilbake_url) throw new EtatFeil("Innsendingen mangler innloggingen. Send meldingen på nytt.", 409);
    const tokener = await byttKode({ kode, verifikator: r.verifikator, tilbake: r.tilbake_url });
    await sjekkIdToken(tokener.id_token, r.nonce);
    await oppdater(id, ["sender"], { verifikator: null, nonce: null, steg: "validering" });

    const v = await valider(tokener.access_token, r.melding);
    await oppdater(id, ["sender"], { avvik: JSON.stringify(v.avvik) });
    if (v.status === "ugyldig") {
      logg("WARNING", "Skatteetaten fant feil i mva-meldingen", { org_id: org, innsending_id: id, antall: v.avvik.length });
      return void (await oppdater(id, ["sender"], { status: "feil", feil: "Skatteetaten fant feil i meldingen (se under). Den er ikke sendt." }));
    }

    token = await altinnToken(tokener.access_token);
    inst = await lagInstans(token, r.orgnr);
    await oppdater(id, ["sender"], { instans: inst.id, steg: "instans" });
    await lastOppKonvolutt(token, inst, konvoluttXml({ orgnr: r.orgnr, termin: t, opprettetAv: r.navn ?? config.altinnSystemnavn, tidspunkt: new Date().toISOString() }));
    await lastOppMelding(token, inst, r.melding);
    await oppdater(id, ["sender"], { steg: "utfylt" });
    await nesteSteg(token, inst, "utfyllingen");
    await oppdater(id, ["sender"], { steg: "bekreftelse" });
    sendes = true;
    await nesteSteg(token, inst, "innsendingen");
    await merkSendt(r, token, inst.id);
  } catch (e) {
    // Instansen sier om meldingen er sendt (et nytt forsøk på det siste steget kan bli avvist fordi
    // det første kom fram). Kan den ikke hentes etter at innsendingen er bedt om, vet vi det ikke.
    let usikker = false;
    if (token && inst) {
      const naa = await hentInstans(token, inst.id).catch(() => null);
      if (naa && sendtInn(naa)) return void (await merkSendt(r, token, inst.id));
      usikker = sendes && !naa;
    }
    const tekst = melding(e);
    logg("WARNING", "Mva-meldingen ble ikke sendt", { org_id: org, innsending_id: id, feil: tekst, usikker });
    await oppdater(id, ["sender"], {
      status: "feil",
      feil: usikker
        ? `${tekst} Sjekk meldingen i Altinn før du sender på nytt, så den ikke sendes to ganger.`
        : /ikke sendt/.test(tekst)
          ? tekst
          : `${tekst.replace(/\.?$/, ".")} Meldingen er ikke sendt.`,
      verifikator: null,
      nonce: null,
      ...(e instanceof Avvist && e.avvik.length ? { avvik: JSON.stringify(e.avvik) } : {}),
    });
  }
}

// Meldingen er sendt inn: raden og terminen (levert i dag, med beløpet som ble sendt, av den som
// sendte), og så betalingsinformasjonen og tilbakemeldingen.
async function merkSendt(r: Rad, token: string, instans: string) {
  const exp = Number(jwtInnhold(token)?.exp);
  const utloper = new Date(Number.isFinite(exp) && exp > 0 ? exp * 1000 : Date.now() + 10 * 60_000);
  const kryptert = await krypter(token).catch((e) => (logg("WARNING", "Altinn-tokenet ble ikke kryptert; tilbakemeldingen hentes ikke", { feil: melding(e) }), null));
  await somSystem(async (db) => {
    await db.query(
      `update faktura.mva_innsendinger set status = 'sendt', steg = 'sendt', instans = $2, sendt_at = now(), altinn_token = $3, token_utloper = $4,
              verifikator = null, nonce = null, feil = null, oppdatert = now()
        where id = $1 and status = 'sender'`,
      [r.id, instans, kryptert, utloper],
    );
    await db.query(
      `insert into faktura.mva_terminer (org_id, aar, type, termin, levert, levert_belop, levert_av) values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (org_id, aar, type, termin) do update set levert = excluded.levert, levert_belop = excluded.levert_belop, levert_av = excluded.levert_av, oppdatert = now()`,
      [r.org_id, r.aar, r.type, r.termin, osloIDag(), r.sum, r.startet_av],
    );
  });
  logg("INFO", "Mva-meldingen er sendt til Skatteetaten", { org_id: r.org_id, innsending_id: r.id, aar: r.aar, termin: r.termin });
  await hentEtterpaa(r.org_id, r.id, token, instans, 0, null);
}

// Ventetiden før neste spørsmål om tilbakemeldingen (sekunder).
const ventetid = (forsok: number) => [10, 10, 20, 30, 60][forsok] ?? 120;
const MAKS_FORSOK = 20;

// Betalingsinformasjonen (når den mangler) og tilbakemeldingen. Er den ikke klar, spør workeren
// igjen senere så lenge tokenet varer. Feil her stopper ikke noe: meldingen er levert.
async function hentEtterpaa(org: string, id: string, token: string, instans: string, forsok: number, betaling: unknown) {
  const ferdig = async (tekst: string) => {
    await oppdater(id, ["sendt"], { altinn_token: null, token_utloper: null, tilbakemelding: JSON.stringify({ melding: tekst }) });
  };
  try {
    let inst = await hentInstans(token, instans);
    if (!betaling) {
      const el = inst.data?.find((d) => d.dataType === "betalingsinformasjon");
      if (el) {
        betaling = lesBetalingsinformasjon((await hentData(token, inst, el.id)).toString("utf8"));
        await oppdater(id, ["sendt", "mottatt"], { betaling: JSON.stringify(betaling) });
      }
    }
    if (!(await tilbakemeldingGitt(token, inst))) {
      if (forsok >= MAKS_FORSOK) return void (await ferdig("Skatteetaten har ikke gitt tilbakemelding ennå. Kvitteringen kommer i Altinn."));
      return void (await leggIKo({ type: "mva-tilbakemelding", org_id: org, innsending_id: id, forsok: forsok + 1 }, ventetid(forsok)));
    }
    inst = await hentInstans(token, instans);
    const kvittering = inst.data?.find((d) => d.dataType === "kvittering");
    const resultat = inst.data?.find((d) => d.dataType === "valideringsresultat");
    const pdf = kvittering ? await hentData(token, inst, kvittering.id, true) : null;
    const v = resultat ? lesValideringsresultat((await hentData(token, inst, resultat.id)).toString("utf8")) : null;
    await oppdater(id, ["sendt"], {
      status: "mottatt",
      mottatt_at: new Date(),
      kvittering: pdf,
      tilbakemelding: JSON.stringify({ status: inst.status?.substatus?.label ?? null, beskrivelse: inst.status?.substatus?.description ?? null, resultat: v?.status ?? null }),
      // Det endelige valideringsresultatet erstatter avvikene fra forhåndsvalideringen.
      ...(v ? { avvik: JSON.stringify(v.avvik) } : {}),
      altinn_token: null,
      token_utloper: null,
    });
    logg("INFO", "Skatteetaten har gitt tilbakemelding på mva-meldingen", { org_id: org, innsending_id: id, status: inst.status?.substatus?.label ?? null });
  } catch (e) {
    if (e instanceof EtatFeil && e.status === 401) return void (await ferdig(UTLOPT));
    logg("WARNING", "Tilbakemeldingen på mva-meldingen ble ikke hentet", { org_id: org, innsending_id: id, feil: melding(e) });
    if (forsok < MAKS_FORSOK) await leggIKo({ type: "mva-tilbakemelding", org_id: org, innsending_id: id, forsok: forsok + 1 }, ventetid(forsok));
    else await ferdig("Kvitteringen ligger i Altinn.");
  }
}

const UTLOPT = "Kvitteringen ligger i Altinn (innloggingen er utløpt, så appen kan ikke hente den).";

// Oppgaven mva-tilbakemelding: spør igjen med det lagrede Altinn-tokenet. Hvert forsøk tas én gang
// (steg), så en oppgave som leveres to ganger, ikke gir to rekker med spørsmål.
export async function hentMvaTilbakemelding(org: string, id: string, forsok: number) {
  const r = await hentRad(id);
  if (!r || r.org_id !== org || r.status !== "sendt" || !r.instans || !r.altinn_token) return;
  if (r.token_utloper && r.token_utloper.getTime() < Date.now())
    return void (await oppdater(id, ["sendt"], { altinn_token: null, token_utloper: null, tilbakemelding: JSON.stringify({ melding: UTLOPT }) }));
  const token = await dekrypter(r.altinn_token);
  const steg = `tilbakemelding ${forsok}`;
  const tatt = await somSystem((db) =>
    en(db, "update faktura.mva_innsendinger set steg = $2, oppdatert = now() where id = $1 and status = 'sendt' and steg is distinct from $2 returning id", [id, steg]),
  );
  if (!tatt) return;
  await hentEtterpaa(org, id, token, r.instans, forsok, r.betaling);
}

// Hvert minutt (hjerteslaget): innlogginger som ikke ble fullført, avbrytes, sendinger som ikke ble
// ferdige på en halvtime, får feil, og Altinn-tokenene som er utløpt, slettes (tilbakemeldingen
// ligger da i Altinn).
export async function ryddMvaInnsendinger(): Promise<number> {
  return somSystem(async (db) => {
    const a = await db.query(
      `update faktura.mva_innsendinger set status = 'avbrutt', state = null, nonce = null, verifikator = null,
              feil = coalesce(feil, 'Innloggingen i ID-porten ble ikke fullført. Meldingen er ikke sendt.'), oppdatert = now()
        where status = 'innlogging' and utloper < now()`,
    );
    // Uten instans i Altinn er meldingen ikke sendt; ellers kan den være det.
    const b = await db.query(
      `update faktura.mva_innsendinger set status = 'feil', nonce = null, verifikator = null,
              feil = case when instans is null then 'Innsendingen ble ikke ferdig. Meldingen er ikke sendt; send den på nytt.'
                          else 'Innsendingen ble ikke ferdig. Sjekk meldingen i Altinn før du sender på nytt, så den ikke sendes to ganger.' end,
              oppdatert = now()
        where status = 'sender' and oppdatert < now() - interval '30 minutes'`,
    );
    await db.query(
      `update faktura.mva_innsendinger set altinn_token = null, token_utloper = null,
              tilbakemelding = case when status = 'sendt' and tilbakemelding is null then $1::jsonb else tilbakemelding end, oppdatert = now()
        where altinn_token is not null and token_utloper < now() - interval '10 minutes'`,
      [JSON.stringify({ melding: UTLOPT })],
    );
    return (a.rowCount ?? 0) + (b.rowCount ?? 0);
  });
}
