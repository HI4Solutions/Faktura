import { Hono, type Context } from "hono";
import { z } from "zod";
import { krevBekreftetEpost, krevInnlogging, krevMfa } from "./auth.js";
import { alle, en, somBruker, type Db } from "./db.js";
import { ApiFeil, feilhandterer, tilHttp } from "./feil.js";
import { hentFaktura, pdfData, pdfFilnavn, sikrePdf } from "./dokument.js";
import { lagPdf } from "./pdf.js";
import { erPng, normaliserLogo } from "./logo.js";
import { config } from "./config.js";
import { lagring, leggIKo } from "./tjenester.js";
import { passkeyInnlogging, passkeyRuter } from "./passkey.js";
import { adminRuter, erPlattformadmin, verifiseringRuter } from "./verifisering.js";
import { hentEnhet } from "./brreg.js";
import { rapportRuter } from "./rapporter.js";
import { resendWebhook } from "./resendWebhook.js";
import { diskRuter, googleCallback } from "./googleDisk.js";
import { pushRuter } from "./push.js";
import { ehfFilnavn, ehfHindring, lagEhf } from "./ehf.js";
import { sjekkEhf } from "./peppol.js";
import { kundenokler, kundeSjekk, planlegg, produktnokler } from "./importer.js";
import { MAKS_ANTALL, skrivVedlegg, vedleggFiler, vedleggRuter } from "./vedlegg.js";
import { ehfRuter } from "./ehfRuter.js";
import { bankRuter } from "./bankRuter.js";
import { aiRuter } from "./aiFaktura.js";
import { assistentRuter } from "./aiAssistent.js";
import { paaminnelseRuter } from "./paaminnelser.js";
import { ansattRuter } from "./ansatte.js";
import { vaktRuter } from "./vakter.js";
import { tavleRuter } from "./tavle.js";
import { fravaerRuter } from "./fravaer.js";
import { bemanningRuter } from "./bemanning.js";
import { arbeidsplanRuter } from "./arbeidsplan.js";
import { krevFunksjoner } from "./funksjoner.js";
import { aiPaa } from "./ai.js";

const uuid = z.string().uuid();
const datoS = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "må være ÅÅÅÅ-MM-DD");
const tekstS = (maks = 500) => z.string().trim().max(maks);
const valgfriTekst = (maks = 500) => tekstS(maks).nullish().transform((v) => (v === "" ? null : v ?? null));
// E-postadresser for kopi; like adresser (uansett store/små bokstaver) tas med én gang.
const epostliste = (maks: number) =>
  z
    .array(z.string().trim().max(254).email("Ugyldig e-postadresse"))
    .max(maks, `Høyst ${maks} adresser`)
    .transform((l) => l.filter((e, i) => l.findIndex((x) => x.toLowerCase() === e.toLowerCase()) === i));

// Bygger «update ... set a = $1, b = $2» av de feltene som faktisk er sendt.
function settFelter(data: Record<string, unknown>, start = 1) {
  const nokler = Object.keys(data).filter((k) => data[k] !== undefined);
  return {
    sql: nokler.map((k, i) => `${k} = $${i + start}`).join(", "),
    verdier: nokler.map((k) => data[k]),
    tom: nokler.length === 0,
  };
}

// Nytt org.nr. på en kunde: EHF-svaret gjelder det gamle, så kunden sjekkes på nytt (workeren
// tar kunder som ikke er sjekket, hvert minutt). Bruker samme parameter som orgnr i settFelter.
// (Importen endrer aldri org.nr.: den kjenner igjen kunder på org.nr. når raden har det.)
function nyttOrgnr(data: Record<string, unknown>, start = 1): string | null {
  const i = Object.keys(data)
    .filter((k) => data[k] !== undefined)
    .indexOf("orgnr");
  return i < 0 ? null : `ehf_sjekket = case when orgnr is distinct from $${i + start} then null else ehf_sjekket end`;
}

async function kropp<T extends z.ZodTypeAny>(c: Context, skjema: T): Promise<z.infer<T>> {
  let json: unknown = {};
  try {
    json = await c.req.json();
  } catch {
    json = {};
  }
  return skjema.parse(json);
}

const bruk = <T>(c: Context, fn: (db: Db) => Promise<T>) => somBruker(c.get("bruker").id, fn);

// ---------------------------------------------------------------------------
// Skjemaer
// ---------------------------------------------------------------------------

const orgSkjema = z.object({
  navn: tekstS(200).min(1).optional(),
  orgnr: z.string().regex(/^\d{9}$/).nullish(),
  mva_registrert: z.boolean().optional(),
  foretaksregisteret: z.boolean().optional(),
  adresse: valgfriTekst(200).optional(),
  postnr: z.string().regex(/^\d{4}$/).nullish(),
  poststed: valgfriTekst(100).optional(),
  land: z.string().length(2).optional(),
  epost: z.string().email().nullish(),
  telefon: valgfriTekst(30).optional(),
  kontonr: z.string().regex(/^\d{11}$/).nullish(),
  farge: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullish(),
  standard_forfall_dager: z.number().int().min(0).max(120).optional(),
  standard_gebyr: z.number().min(0).optional(),
  bruk_kid: z.boolean().optional(),
  standard_dager_foer_forfall: z.number().int().min(0).max(60).optional(),
  purring_auto: z.boolean().optional(),
  purring_dager: z.number().int().min(0).max(60).optional(),
  purregebyr: z.number().min(0).max(200).optional(),
  innehaver: valgfriTekst(200).optional(),
  standard_avsender: z.enum(["firma", "innehaver"]).optional(),
  kopi_til: epostliste(5).optional(), // fast blindkopi av alle fakturaer
  ai_aktiv: z.boolean().optional(), // AI (Gemini): fakturautkast og forslag på innbetalinger
});

const kundeSkjema = z.object({
  type: z.enum(["person", "firma"]).optional(),
  navn: tekstS(200).min(1),
  orgnr: z.string().regex(/^\d{9}$/).nullish(),
  adresse: valgfriTekst(200),
  postnr: valgfriTekst(10),
  poststed: valgfriTekst(100),
  land: z.string().length(2).optional(),
  epost: z.string().email().nullish().or(z.literal("").transform(() => null)),
  telefon: valgfriTekst(30),
  deres_referanse: valgfriTekst(100),
  notat: valgfriTekst(2000),
  aktiv: z.boolean().optional(),
});

const produktSkjema = z.object({
  varenummer: valgfriTekst(50),
  navn: tekstS(200).min(1),
  beskrivelse: valgfriTekst(2000),
  enhet: tekstS(20).optional(),
  enhetspris: z.number().nullish(), // null: variabel pris, fylles inn på fakturaen
  mva_sats: z.number().min(0).max(100).optional(),
  aktiv: z.boolean().optional(),
  // Fast avsender og konto: velges på fakturaen når produktet brukes (null: ikke fast).
  // standardkonto: fast på organisasjonens standardkonto (da er konto_id null).
  avsender: z.enum(["firma", "innehaver"]).nullish(),
  konto_id: uuid.nullish(),
  standardkonto: z.boolean().optional(),
  // Indeksregulering (KPI)
  indeks_aktiv: z.boolean().optional(),
  indeks_maaned: z.number().int().min(1).max(12).nullish(),
  indeks_basis: z.string().regex(/^\d{4}-\d{2}-01$/, "Velg en KPI-måned").nullish(),
  indeks_andel: z.number().gt(0).max(100).optional(),
  indeks_bare_okning: z.boolean().optional(),
  indeks_hele_kroner: z.boolean().optional(),
  indeks_varsle: z.boolean().optional(),
});

const linjeSkjema = z
  .object({
    produkt_id: uuid.nullish(),
    beskrivelse: tekstS(1000).min(1),
    antall: z.number().refine((n) => n !== 0, "kan ikke være 0"),
    enhet: tekstS(20).optional(),
    enhetspris: z.number(),
    mva_sats: z.number().min(0).max(100).optional(),
    // Rabatt i prosent av linjebeløpet, eller i kroner for hele linjen (ikke begge).
    rabatt_prosent: z.number().gt(0, "Rabatten må være mer enn 0 %").max(100, "Rabatten kan ikke være mer enn 100 %").nullish(),
    rabatt_belop: z.number().gt(0, "Rabatten må være mer enn 0 kr").nullish(),
  })
  .superRefine((l, ctx) => {
    if (l.rabatt_prosent != null && l.rabatt_belop != null) ctx.addIssue({ code: "custom", path: ["rabatt_belop"], message: "Velg rabatt i prosent eller i kroner, ikke begge" });
    const brutto = Math.round(l.antall * l.enhetspris * 100) / 100;
    if (l.rabatt_belop != null && l.rabatt_belop > brutto)
      ctx.addIssue({ code: "custom", path: ["rabatt_belop"], message: `Rabatten på «${l.beskrivelse}» er større enn beløpet på linjen` });
  });

const fakturaSkjema = z.object({
  kunde_id: uuid,
  fakturadato: datoS.nullish(),
  forfallsdato: datoS.nullish(),
  periode_fra: datoS.nullish(),
  periode_til: datoS.nullish(),
  deres_referanse: valgfriTekst(100),
  var_referanse: valgfriTekst(100),
  notat: valgfriTekst(2000), // internt, vises ikke på fakturaen
  kommentar: valgfriTekst(1000), // står på fakturaen
  planlagt_sending: datoS.nullish(),
  konto_id: uuid.nullish(),
  avsender: z.enum(["firma", "innehaver"]).nullish(),
  kopi_til: epostliste(10).optional(), // får fakturaen sammen med kunden
  // Gjør fakturaen gjentakende: gjentakelsen opprettes når fakturaen sendes.
  gjenta: z
    .object({
      intervall: z.enum(["maaned", "kvartal", "aar"]),
      neste_forfall: datoS.nullish(),
      send_dager_foer: z.number().int().min(0).max(60).nullish(),
      slutt_dato: datoS.nullish(),
    })
    .nullish(),
  linjer: z.array(linjeSkjema).max(500),
  gebyr: z.boolean().optional(), // legg til organisasjonens standard fakturagebyr som egen linje
  // Alle vedleggene på fakturaen, i rekkefølge (lastet opp på forhånd). Uten: som før.
  vedlegg: z
    .array(uuid)
    .transform((l) => [...new Set(l)])
    .refine((l) => l.length <= MAKS_ANTALL, `Høyst ${MAKS_ANTALL} vedlegg på en faktura`)
    .optional(),
});

async function skrivLinjer(db: Db, orgId: string, fakturaId: string, linjer: z.infer<typeof linjeSkjema>[], gebyr: boolean) {
  await db.query("delete from faktura.faktura_linjer where faktura_id = $1", [fakturaId]);
  const alleLinjer = [...linjer];
  if (gebyr) {
    const o = await en(db, "select standard_gebyr from faktura.organisasjoner where id = $1", [orgId]);
    if (o?.standard_gebyr > 0) alleLinjer.push({ beskrivelse: "Fakturagebyr", antall: 1, enhetspris: o.standard_gebyr, mva_sats: 25 });
  }
  let rekke = 0;
  for (const l of alleLinjer) {
    rekke += 1;
    await db.query(
      `insert into faktura.faktura_linjer (org_id, faktura_id, rekke, produkt_id, beskrivelse, antall, enhet, enhetspris, mva_sats,
                                          rabatt_prosent, rabatt_belop)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [orgId, fakturaId, rekke, l.produkt_id ?? null, l.beskrivelse, l.antall, l.enhet ?? "stk", l.enhetspris, l.mva_sats ?? 25,
       l.rabatt_prosent ?? null, l.rabatt_belop ?? null],
    );
  }
}

// ---------------------------------------------------------------------------
// Ruter
// ---------------------------------------------------------------------------

export function lagApi() {
  const app = new Hono();
  app.onError(feilhandterer);

  app.get("/helse", (c) => c.json({ ok: true }));
  app.get("/api/helse", (c) => c.json({ ok: true }));

  // Oppslag i Enhetsregisteret (åpent API) for skjemaer.
  app.get("/api/brreg/:orgnr", async (c) => c.json(await hentEnhet(c.req.param("orgnr"))));

  // Åpne ruter (uten innlogging) ligger under /api/offentlig.
  app.route("/api/offentlig/passkey", passkeyInnlogging());
  app.route("/api/offentlig/resend", resendWebhook());
  app.route("/api/offentlig/google", googleCallback());

  const api = new Hono();
  api.use("*", async (c, next) => (c.req.path.startsWith("/api/offentlig/") ? next() : krevInnlogging(c, next)));
  api.use("*", async (c, next) => (c.req.path.startsWith("/api/offentlig/") ? next() : krevBekreftetEpost(c, next)));
  api.route("/passkeys", passkeyRuter());
  api.route("/admin", adminRuter());
  api.route("/disk", diskRuter());
  api.route("/push", pushRuter());

  // Kan et org.nr. motta EHF? For kundeskjemaet, før kunden er lagret (svaret huskes en time,
  // så lagringen etterpå bruker det samme). ehf: null når oppslaget ikke ga svar.
  api.get("/peppol/:orgnr", async (c) => {
    const orgnr = c.req.param("orgnr").replace(/\s/g, "");
    if (!/^\d{9}$/.test(orgnr)) throw new ApiFeil(400, "Ugyldig organisasjonsnummer");
    return c.json({ orgnr, ehf: await sjekkEhf(orgnr) });
  });

  // Konsumprisindeksen (SSB), siste tre år.
  api.get("/kpi", async (c) =>
    c.json(await somBruker(c.get("bruker").id, (db) => alle(db, "select maaned, verdi from faktura.kpi order by maaned desc limit 36"))),
  );

  api.get("/meg", async (c) =>
    c.json(
      await bruk(c, async (db) => ({
        bruker: await en(db, "select id, epost, navn from faktura.brukere where id = faktura.bruker_id()"),
        mfa: c.get("bruker").mfa,
        plattformadmin: erPlattformadmin(c.get("bruker").epost),
        organisasjoner: await alle(db, "select * from faktura.mine_organisasjoner order by direkte_medlem desc, navn"),
      })),
    ),
  );

  api.patch("/meg", async (c) => {
    const b = await kropp(c, z.object({ navn: tekstS(120).min(2, "må ha minst to tegn") }));
    return c.json(await bruk(c, (db) => en(db, "update faktura.brukere set navn = $1 where id = faktura.bruker_id() returning id, epost, navn", [b.navn])));
  });

  api.post("/organisasjoner", async (c) => {
    const b = await kropp(c, z.object({ navn: tekstS(200).min(1), orgnr: z.string().regex(/^\d{9}$/).nullish(), type: z.enum(["foretak", "regnskapsbyraa", "privatperson"]).optional() }));
    const o = await bruk(c, (db) => en(db, "select * from faktura.opprett_organisasjon($1, $2, $3)", [b.navn, b.orgnr ?? null, b.type ?? "foretak"]));
    return c.json(o, 201);
  });

  api.post("/invitasjoner/aksepter", async (c) => {
    const b = await kropp(c, z.object({ token: z.string().min(10) }));
    return c.json({ org_id: await bruk(c, async (db) => (await en(db, "select faktura.aksepter_invitasjon($1) as id", [b.token]))!.id) });
  });

  api.post("/tilgang/:id/svar", async (c) => {
    const b = await kropp(c, z.object({ aksepter: z.boolean() }));
    return c.json(await bruk(c, (db) => en(db, "select * from faktura.svar_tilgang($1, $2)", [uuid.parse(c.req.param("id")), b.aksepter])));
  });

  api.delete("/tilgang/:id", async (c) => {
    await bruk(c, (db) => db.query("select faktura.trekk_tilgang($1)", [uuid.parse(c.req.param("id"))]));
    return c.body(null, 204);
  });

  // Alt under /org/:org gjelder én organisasjon.
  const org = new Hono<{ Variables: { org: string } }>();
  org.use("*", async (c, next) => {
    c.set("org", uuid.parse(c.req.param("org")));
    await next();
  });
  // Rutene til funksjoner organisasjonen ikke har (Administrasjon → Funksjoner), avvises.
  org.use("*", krevFunksjoner());
  const orgId = (c: Context) => c.get("org") as string;

  org.get("/", async (c) => {
    const o = await bruk(c, async (db) => {
      // Med neste nummer i fakturaserien: fakturaen får det når den sendes.
      const o = await en(
        db,
        "select o.*, s.neste_fakturanummer from faktura.organisasjoner o left join faktura.nummerserier s on s.org_id = o.id where o.id = $1",
        [orgId(c)],
      );
      if (!o) throw new ApiFeil(404, "Fant ikke organisasjonen");
      // Ansatte (rollen ansatt) ser organisasjonens navn i /meg, men ikke innstillingene.
      if (!(await en<{ k: boolean }>(db, "select faktura.kan($1, 'les') as k", [orgId(c)]))!.k) throw new ApiFeil(403, "Ingen tilgang");
      const direkte = await en(db, "select 1 from faktura.medlemmer where org_id = $1 and bruker_id = faktura.bruker_id()", [orgId(c)]);
      if (!direkte) await db.query("select faktura.logg_oppslag($1, 'organisasjon')", [orgId(c)]);
      // ai_tilgjengelig: AI er satt opp for plattformen og organisasjonen har funksjonen (og
      // ai_aktiv: slått på av organisasjonen selv).
      const r = (await en<{ r: string; ai: boolean }>(db, "select faktura.rolle($1) as r, faktura.har_funksjon($1, 'ai') as ai", [orgId(c)]))!;
      return { ...o, rolle: r.r, ai_tilgjengelig: aiPaa() && r.ai };
    });
    return c.json(o);
  });

  org.patch("/", async (c) => {
    const b = await kropp(c, orgSkjema);
    if (b.kontonr !== undefined || b.kopi_til !== undefined) krevMfa(c);
    const s = settFelter(b, 2);
    if (s.tom) throw new ApiFeil(400, "Ingen felt å endre");
    const o = await bruk(c, async (db) => {
      const o = await en(db, `update faktura.organisasjoner set ${s.sql} where id = $1 returning *`, [orgId(c), ...s.verdier]);
      if (!o) throw new ApiFeil(403, "Ingen tilgang");
      return o;
    });
    return c.json(o);
  });

  org.post("/startnummer", async (c) => {
    const b = await kropp(c, z.object({ neste_fakturanummer: z.number().int().min(1) }));
    await bruk(c, (db) => db.query("select faktura.sett_startnummer($1, $2)", [orgId(c), b.neste_fakturanummer]));
    return c.body(null, 204);
  });

  org.route("/verifisering", verifiseringRuter());
  org.route("/", rapportRuter());
  org.route("/", vedleggRuter());
  org.route("/", ehfRuter());
  org.route("/", bankRuter());
  org.route("/", aiRuter());
  org.route("/", assistentRuter());
  org.route("/", paaminnelseRuter());
  org.route("/", ansattRuter());
  org.route("/", vaktRuter());
  org.route("/", tavleRuter());
  org.route("/", fravaerRuter());
  org.route("/", bemanningRuter());
  org.route("/", arbeidsplanRuter());

  // --- Logo ----------------------------------------------------------------
  // Lastes opp som PNG/JPG (maks 5 MB) og skaleres ned før lagring. Hver opplasting
  // får nytt filnavn, så fakturaer som allerede viser til en eldre logo, beholder den.
  org.put("/logo", async (c) => {
    const raa = new Uint8Array(await c.req.arrayBuffer());
    if (raa.length === 0) throw new ApiFeil(400, "Mangler bilde");
    if (raa.length > 5_000_000) throw new ApiFeil(400, "Logoen kan være høyst 5 MB");
    const erJpg = raa[0] === 0xff && raa[1] === 0xd8 && raa[2] === 0xff;
    if (!erPng(raa) && !erJpg) throw new ApiFeil(400, "Logoen må være PNG eller JPG");
    let data: Uint8Array;
    try {
      data = await normaliserLogo(raa);
    } catch {
      throw new ApiFeil(400, "Kunne ikke lese bildet");
    }
    const png = erPng(data);
    if (!config.filerBucket) throw new ApiFeil(503, "Lagring er ikke konfigurert");
    const sti = `${orgId(c)}/logo/${Date.now()}.${png ? "png" : "jpg"}`;
    const o = await bruk(c, async (db) => {
      if (!(await en(db, "select faktura.kan($1, 'admin') as k", [orgId(c)]))!.k) throw new ApiFeil(403, "Ingen tilgang");
      await lagring.lagre(config.filerBucket!, sti, data, png ? "image/png" : "image/jpeg");
      return en(db, "update faktura.organisasjoner set logo_sti = $2 where id = $1 returning logo_sti", [orgId(c), sti]);
    });
    return c.json(o);
  });

  org.delete("/logo", async (c) => {
    const r = await bruk(c, (db) => db.query("update faktura.organisasjoner set logo_sti = null where id = $1", [orgId(c)]));
    if (!r.rowCount) throw new ApiFeil(403, "Ingen tilgang");
    return c.body(null, 204);
  });

  org.get("/logo", async (c) => {
    const sti = await bruk(c, async (db) => (await en(db, "select logo_sti from faktura.organisasjoner where id = $1", [orgId(c)]))?.logo_sti);
    if (!sti || !config.filerBucket) throw new ApiFeil(404, "Ingen logo");
    const data = await lagring.hent(config.filerBucket, sti);
    if (!data) throw new ApiFeil(404, "Ingen logo");
    return c.body(Buffer.from(data), 200, {
      "content-type": sti.endsWith(".png") ? "image/png" : "image/jpeg",
      "cache-control": "private, max-age=300",
    });
  });

  // --- Medlemmer og regnskapsfører ---------------------------------------
  org.get("/medlemmer", async (c) =>
    c.json(
      await bruk(c, (db) =>
        alle(
          db,
          `select m.bruker_id, m.rolle, m.opprettet, b.epost, b.navn
             from faktura.medlemmer m join faktura.brukere b on b.id = m.bruker_id
            where m.org_id = $1 order by m.opprettet`,
          [orgId(c)],
        ),
      ),
    ),
  );

  org.post("/invitasjoner", async (c) => {
    const b = await kropp(c, z.object({ epost: z.string().email(), rolle: z.enum(["admin", "fakturerer", "regnskap", "les"]) }));
    const token = await bruk(c, async (db) => (await en(db, "select faktura.inviter_medlem($1, $2, $3) as t", [orgId(c), b.epost, b.rolle]))!.t);
    return c.json({ lenke: `${config.appUrl}/invitasjon/${token}` }, 201);
  });

  org.patch("/medlemmer/:bruker", async (c) => {
    const b = await kropp(c, z.object({ rolle: z.enum(["eier", "admin", "fakturerer", "regnskap", "les"]) }));
    await bruk(c, (db) => db.query("select faktura.endre_rolle($1, $2, $3)", [orgId(c), uuid.parse(c.req.param("bruker")), b.rolle]));
    return c.body(null, 204);
  });

  org.delete("/medlemmer/:bruker", async (c) => {
    await bruk(c, (db) => db.query("select faktura.fjern_medlem($1, $2)", [orgId(c), uuid.parse(c.req.param("bruker"))]));
    return c.body(null, 204);
  });

  org.get("/tilgang", async (c) =>
    c.json(
      await bruk(c, (db) =>
        alle(
          db,
          `select t.*, k.navn as klient_navn, k.orgnr as klient_orgnr, b.navn as byraa_navn, b.orgnr as byraa_orgnr
             from faktura.org_tilgang t
             join faktura.organisasjoner k on k.id = t.klient_org_id
             join faktura.organisasjoner b on b.id = t.byraa_org_id
            where t.klient_org_id = $1 or t.byraa_org_id = $1
            order by t.opprettet desc`,
          [orgId(c)],
        ),
      ),
    ),
  );

  org.post("/tilgang", async (c) => {
    const b = await kropp(c, z.object({ orgnr: z.string().regex(/^\d{9}$/), rolle: z.enum(["les", "bokfor"]).optional(), utloper: datoS.nullish() }));
    return c.json(
      await bruk(c, (db) => en(db, "select * from faktura.opprett_tilgang($1, $2, $3, $4)", [orgId(c), b.orgnr, b.rolle ?? "les", b.utloper ?? null])),
      201,
    );
  });

  // --- Kunder og produkter -----------------------------------------------
  // Kan kunden motta EHF? Sjekkes i PEPPOL når kunden lagres med org.nr. Feiler oppslaget,
  // står svaret som før (workeren prøver igjen om litt). fersk: slå opp på nytt.
  const medEhf = async (c: Context, k: any, fersk = false) => {
    if (!k?.orgnr || (k.land && k.land !== "NO")) return k;
    const ja = await sjekkEhf(k.orgnr, { fersk });
    if (ja === null) return k;
    return (await bruk(c, (db) => en(db, "update faktura.kunder set ehf = $2, ehf_sjekket = now() where id = $1 returning *", [k.id, ja]))) ?? k;
  };

  for (const [sti, tabell, skjema, sorter] of [
    ["kunder", "kunder", kundeSkjema, "navn"],
    ["produkter", "produkter", produktSkjema, "navn"],
  ] as const) {
    org.get(`/${sti}`, async (c) => {
      const sok = c.req.query("sok");
      const aktiv = c.req.query("aktiv");
      const vilkar = ["org_id = $1"];
      const verdier: unknown[] = [orgId(c)];
      if (sok) {
        verdier.push(`%${sok}%`);
        vilkar.push(`navn ilike $${verdier.length}`);
      }
      if (aktiv !== undefined) {
        verdier.push(aktiv !== "false");
        vilkar.push(`aktiv = $${verdier.length}`);
      }
      return c.json(await bruk(c, (db) => alle(db, `select * from faktura.${tabell} where ${vilkar.join(" and ")} order by ${sorter} limit 10000`, verdier)));
    });

    org.get(`/${sti}/:id`, async (c) => {
      const r = await bruk(c, (db) => en(db, `select * from faktura.${tabell} where id = $1 and org_id = $2`, [uuid.parse(c.req.param("id")), orgId(c)]));
      if (!r) throw new ApiFeil(404, "Finnes ikke");
      return c.json(r);
    });

    org.post(`/${sti}`, async (c) => {
      const b = (await kropp(c, skjema)) as Record<string, unknown>;
      const felter = Object.keys(b).filter((k) => b[k] !== undefined);
      const r = await bruk(c, (db) =>
        en(
          db,
          `insert into faktura.${tabell} (org_id, ${felter.join(", ")}) values ($1, ${felter.map((_, i) => `$${i + 2}`).join(", ")}) returning *`,
          [orgId(c), ...felter.map((k) => b[k])],
        ),
      );
      return c.json(tabell === "kunder" ? await medEhf(c, r) : r, 201);
    });

    org.patch(`/${sti}/:id`, async (c) => {
      const b = (await kropp(c, skjema.partial())) as Record<string, unknown>;
      const s = settFelter(b, 3);
      if (s.tom) throw new ApiFeil(400, "Ingen felt å endre");
      const ehfPaNytt = tabell === "kunder" ? nyttOrgnr(b, 3) : null;
      const r = await bruk(c, (db) =>
        en(db, `update faktura.${tabell} set ${s.sql}${ehfPaNytt ? `, ${ehfPaNytt}` : ""} where id = $1 and org_id = $2 returning *`, [
          uuid.parse(c.req.param("id")),
          orgId(c),
          ...s.verdier,
        ]),
      );
      if (!r) throw new ApiFeil(404, "Finnes ikke");
      return c.json(tabell === "kunder" && b.orgnr !== undefined ? await medEhf(c, r) : r);
    });

    // Bare kunder og produkter som ikke er brukt, kan slettes; ellers settes de inaktive.
    org.delete(`/${sti}/:id`, async (c) => {
      const id = uuid.parse(c.req.param("id"));
      const r = await bruk(c, async (db) => {
        const bruk =
          tabell === "kunder"
            ? await en(
                db,
                `select (select count(*) from faktura.fakturaer where kunde_id = $1)::int as fakturaer,
                        (select count(*) from faktura.gjentakelser where kunde_id = $1)::int as gjentakelser`,
                [id],
              )
            : await en(db, "select (select count(*) from faktura.faktura_linjer where produkt_id = $1)::int as fakturaer, 0 as gjentakelser", [id]);
        if (bruk!.fakturaer > 0)
          throw new ApiFeil(409, `${tabell === "kunder" ? "Kunden" : "Produktet"} er brukt på ${bruk!.fakturaer} faktura(er) og kan ikke slettes. Sett ${tabell === "kunder" ? "kunden" : "produktet"} som inaktiv i stedet.`);
        if (bruk!.gjentakelser > 0) throw new ApiFeil(409, `Kunden har ${bruk!.gjentakelser} gjentakende faktura(er). Slett dem først.`);
        return db.query(`delete from faktura.${tabell} where id = $1 and org_id = $2`, [id, orgId(c)]);
      });
      if (!r.rowCount) throw new ApiFeil(404, "Finnes ikke");
      return c.body(null, 204);
    });
  }

  // --- Kontonumre -----------------------------------------------------------
  const kontoSkjema = z.object({ navn: tekstS(100).min(1), kontonr: z.string().transform((v) => v.replace(/[\s.]/g, "")).pipe(z.string().regex(/^\d{11}$/, "Kontonummeret må ha 11 siffer")) });

  org.get("/kontoer", async (c) =>
    c.json(await bruk(c, (db) => alle(db, "select * from faktura.kontoer where org_id = $1 order by navn", [orgId(c)]))),
  );

  org.post("/kontoer", async (c) => {
    const b = await kropp(c, kontoSkjema);
    const r = await bruk(c, (db) => en(db, "insert into faktura.kontoer (org_id, navn, kontonr) values ($1, $2, $3) returning *", [orgId(c), b.navn, b.kontonr]));
    return c.json(r, 201);
  });

  org.patch("/kontoer/:id", async (c) => {
    const b = await kropp(c, kontoSkjema);
    const r = await bruk(c, (db) =>
      en(db, "update faktura.kontoer set navn = $3, kontonr = $4 where id = $1 and org_id = $2 returning *", [uuid.parse(c.req.param("id")), orgId(c), b.navn, b.kontonr]),
    );
    if (!r) throw new ApiFeil(404, "Finnes ikke");
    return c.json(r);
  });

  // Utkast og gjentakelser som brukte kontoen, går tilbake til standardkontoen.
  org.delete("/kontoer/:id", async (c) => {
    const r = await bruk(c, (db) => db.query("delete from faktura.kontoer where id = $1 and org_id = $2", [uuid.parse(c.req.param("id")), orgId(c)]));
    if (!r.rowCount) throw new ApiFeil(404, "Finnes ikke");
    return c.body(null, 204);
  });

  // --- Indeksregulering ----------------------------------------------------
  org.get("/produkter/:id/indeksregulering", async (c) => {
    const id = uuid.parse(c.req.param("id"));
    return c.json(
      await bruk(c, async (db) => ({
        beregning: (await en(db, "select * from faktura.beregn_indeksregulering($1)", [id])) ?? null,
        reguleringer: await alle(
          db,
          `select r.*, (select count(*) from faktura.prisregulering_gjentakelser pg where pg.regulering_id = r.id)::int as gjentakelser
             from faktura.prisreguleringer r where r.produkt_id = $1 and r.org_id = $2 order by r.gjelder_fra desc`,
          [id, orgId(c)],
        ),
      })),
    );
  });

  org.post("/prisreguleringer/:id/avbryt", async (c) => {
    const id = uuid.parse(c.req.param("id"));
    await bruk(c, (db) => db.query("select faktura.avbryt_indeksregulering($1, $2)", [orgId(c), id]));
    return c.json({ status: "avbrutt" });
  });

  // --- Fakturaer ---------------------------------------------------------
  org.get("/fakturaer", async (c) => {
    const vilkar = ["f.org_id = $1"];
    const verdier: unknown[] = [orgId(c)];
    const status = c.req.query("status");
    const kunde = c.req.query("kunde_id");
    const type = c.req.query("type");
    if (status === "kreditert" && c.req.query("kreditnotaer")) {
      // Krediterte fakturaer sammen med kreditnotaene (som ikke skal betales).
      vilkar.push(`(f.status = 'kreditert' or (f.type = 'kreditnota' and f.status <> 'utkast'))`);
    } else if (status) {
      verdier.push(status);
      vilkar.push(`f.status = $${verdier.length}`);
    }
    if (kunde) {
      verdier.push(uuid.parse(kunde));
      vilkar.push(`f.kunde_id = $${verdier.length}`);
    }
    if (type) {
      verdier.push(type);
      vilkar.push(`f.type = $${verdier.length}`);
    }
    return c.json(
      await bruk(c, (db) =>
        alle(
          db,
          `select f.id, f.fakturanummer, f.type, f.status, f.kunde_id, coalesce(f.kunde->>'navn', k.navn) as kunde_navn,
                  f.fakturadato, f.forfallsdato, f.betalt_belop, f.kreditert_belop, f.refusjon_belop,
                  coalesce(f.sum_inkl_mva, (select sum(round(faktura.linje_netto(l.antall, l.enhetspris, l.rabatt_prosent, l.rabatt_belop), 2)
                                                     + round(faktura.linje_netto(l.antall, l.enhetspris, l.rabatt_prosent, l.rabatt_belop) * l.mva_sats / 100, 2))
                                              from faktura.faktura_linjer l where l.faktura_id = f.id)) as sum_inkl_mva,
                  case when f.status = 'utkast' then (select count(*)::int from faktura.faktura_linjer l where l.faktura_id = f.id) end as antall_linjer,
                  case when f.status = 'utkast' then k.epost end as kunde_epost,
                  f.sendt_at, f.kreditnota_for, f.planlagt_sending,
                  (f.status = 'utstedt' and f.type = 'faktura' and f.forfallsdato < faktura.i_dag()) as forfalt,
                  (select count(*) from faktura.purringer p where p.faktura_id = f.id) as antall_purringer,
                  (select count(*)::int from faktura.vedlegg v where v.faktura_id = f.id) as antall_vedlegg,
                  (select s.status from faktura.ehf_sendinger s where s.faktura_id = f.id order by s.opprettet desc limit 1) as ehf_status,
                  (select e.status from faktura.eposter e where e.faktura_id = f.id order by e.opprettet desc limit 1) as epost_status
             from faktura.fakturaer f join faktura.kunder k on k.id = f.kunde_id
            where ${vilkar.join(" and ")}
            order by f.fakturanummer desc nulls first, f.opprettet desc
            limit 500`,
          verdier,
        ),
      ),
    );
  });

  org.get("/fakturaer/:id", async (c) =>
    c.json(
      await bruk(c, async (db) => {
        const f = await hentFaktura(db, orgId(c), uuid.parse(c.req.param("id")));
        const betalinger = await alle(db, "select * from faktura.betalinger where faktura_id = $1 order by betalt_dato, opprettet", [f.id]);
        const kreditnotaer = await alle(db, "select id, fakturanummer, sum_inkl_mva, fakturadato from faktura.fakturaer where kreditnota_for = $1 order by fakturanummer", [f.id]);
        const purringer = await alle(db, "select * from faktura.purringer where faktura_id = $1 order by nummer", [f.id]);
        const eposter = await alle(db, "select id, purring_id, til, kopi, emne, status, detaljer, siste_hendelse_at, opprettet from faktura.eposter where faktura_id = $1 order by opprettet", [f.id]);
        const ehf = await alle(db, "select id, mottaker, status, feil_kategori, detaljer, opprettet, oppdatert from faktura.ehf_sendinger where faktura_id = $1 order by opprettet", [f.id]);
        // Et utkast får neste nummer i serien når det sendes.
        const neste =
          f.status === "utkast"
            ? ((await en(db, "select neste_fakturanummer from faktura.nummerserier where org_id = $1", [orgId(c)]))?.neste_fakturanummer ?? null)
            : null;
        return { ...f, betalinger, kreditnotaer, purringer, eposter, ehf, neste_fakturanummer: neste };
      }),
    ),
  );

  org.post("/fakturaer", async (c) => {
    const b = await kropp(c, fakturaSkjema);
    const f = await bruk(c, async (db) => {
      const f = await en(
        db,
        `insert into faktura.fakturaer (org_id, kunde_id, fakturadato, forfallsdato, periode_fra, periode_til,
                                        deres_referanse, var_referanse, notat, kommentar, planlagt_sending, konto_id, avsender, kopi_til, gjenta, opprettet_av)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, faktura.bruker_id()) returning id`,
        [orgId(c), b.kunde_id, b.fakturadato ?? null, b.forfallsdato ?? null, b.periode_fra ?? null, b.periode_til ?? null,
         b.deres_referanse, b.var_referanse, b.notat, b.kommentar, b.planlagt_sending ?? null, b.konto_id ?? null, b.avsender ?? null, b.kopi_til ?? [],
         b.gjenta ? JSON.stringify(b.gjenta) : null],
      );
      await skrivLinjer(db, orgId(c), f.id, b.linjer, b.gebyr ?? false);
      await skrivVedlegg(db, orgId(c), f.id, b.vedlegg);
      return hentFaktura(db, orgId(c), f.id);
    });
    return c.json(f, 201);
  });

  org.put("/fakturaer/:id", async (c) => {
    const b = await kropp(c, fakturaSkjema);
    const id = uuid.parse(c.req.param("id"));
    const f = await bruk(c, async (db) => {
      const r = await db.query(
        `update faktura.fakturaer set kunde_id = $3, fakturadato = $4, forfallsdato = $5, periode_fra = $6, periode_til = $7,
                deres_referanse = $8, var_referanse = $9, notat = $10, planlagt_sending = $11, konto_id = $12, avsender = $13,
                kopi_til = coalesce($14, kopi_til), kommentar = $15, gjenta = $16
          where id = $1 and org_id = $2 and status = 'utkast'`,
        [id, orgId(c), b.kunde_id, b.fakturadato ?? null, b.forfallsdato ?? null, b.periode_fra ?? null, b.periode_til ?? null,
         b.deres_referanse, b.var_referanse, b.notat, b.planlagt_sending ?? null, b.konto_id ?? null, b.avsender ?? null, b.kopi_til ?? null,
         b.kommentar, b.gjenta ? JSON.stringify(b.gjenta) : null],
      );
      if (!r.rowCount) throw new ApiFeil(409, "Bare utkast kan endres");
      await skrivLinjer(db, orgId(c), id, b.linjer, b.gebyr ?? false);
      await skrivVedlegg(db, orgId(c), id, b.vedlegg);
      return hentFaktura(db, orgId(c), id);
    });
    return c.json(f);
  });

  // --- Import fra andre systemer ------------------------------------------
  // Radene er allerede lest og koblet i nettleseren. «proving» gir bare planen (hva som
  // blir nytt, oppdatert, hoppet over eller har feil); ellers lagres de gyldige radene
  // samlet. Rader med feil hoppes over.
  const importSkjema = z.object({
    rader: z.array(z.record(z.string(), z.unknown())).min(1).max(5000, "Høyst 5000 rader om gangen"),
    duplikater: z.enum(["hopp", "oppdater"]).optional(),
    proving: z.boolean().optional(),
  });
  for (const sti of ["kunder", "produkter"] as const) {
    org.post(`/${sti}/importer`, async (c) => {
      const b = await kropp(c, importSkjema);
      const svar = await bruk(c, async (db) => {
        await db.query("select faktura.krev($1, 'skriv')", [orgId(c)]);
        const finnes = new Map<string, string>();
        const nokkel = (k: string | false | null | undefined, id: string) => k && !finnes.has(k) && finnes.set(k, id);
        if (sti === "kunder") {
          for (const r of await alle(db, "select id, orgnr, epost, navn from faktura.kunder where org_id = $1 order by kundenummer", [orgId(c)])) {
            nokkel(r.orgnr && `orgnr:${r.orgnr}`, r.id);
            nokkel(r.epost && `epost:${r.epost.toLowerCase()}`, r.id);
            nokkel(`navn:${r.navn.trim().toLowerCase()}`, r.id);
          }
        } else {
          for (const r of await alle(db, "select id, varenummer, navn from faktura.produkter where org_id = $1 order by opprettet", [orgId(c)])) {
            nokkel(r.varenummer && `varenr:${r.varenummer.trim().toLowerCase()}`, r.id);
            nokkel(`navn:${r.navn.trim().toLowerCase()}`, r.id);
          }
        }
        const plan =
          sti === "kunder"
            ? planlegg(b.rader, kundeSkjema, kundenokler, finnes, b.duplikater ?? "hopp", kundeSjekk)
            : planlegg(b.rader, produktSkjema, produktnokler, finnes, b.duplikater ?? "hopp");
        if (!b.proving) {
          for (const p of plan) {
            if (p.status !== "ny" && p.status !== "oppdater") continue;
            const d = p.data as Record<string, unknown>;
            try {
              if (p.status === "ny") {
                const felter = Object.keys(d).filter((k) => d[k] !== undefined);
                await db.query(`insert into faktura.${sti} (org_id, ${felter.join(", ")}) values ($1, ${felter.map((_, i) => `$${i + 2}`).join(", ")})`, [
                  orgId(c),
                  ...felter.map((k) => d[k]),
                ]);
              } else {
                // Tomme felt i fila sletter ikke det som står fra før, og et notat legges til
                // det som står der (med mindre det står der allerede).
                const { notat, ...felter } = Object.fromEntries(Object.entries(d).filter(([, v]) => v !== undefined && v !== null && v !== ""));
                const s = settFelter(felter, 3);
                const sett = s.tom ? [] : [s.sql];
                const verdier = [...s.verdier];
                if (notat !== undefined) {
                  verdier.push(notat);
                  const n = `$${verdier.length + 2}::text`;
                  sett.push(`notat = case when coalesce(notat, '') = '' then ${n} when strpos(notat, ${n}) > 0 then notat else notat || E'\\n' || ${n} end`);
                }
                if (sett.length) await db.query(`update faktura.${sti} set ${sett.join(", ")} where id = $1 and org_id = $2`, [p.id, orgId(c), ...verdier]);
              }
            } catch (e) {
              throw new ApiFeil(tilHttp(e).status, `Rad ${p.nr}: ${tilHttp(e).error}`);
            }
          }
        }
        const antall = { ny: 0, oppdater: 0, hopp: 0, feil: 0 };
        for (const p of plan) antall[p.status]++;
        return { antall, rader: plan.map(({ nr, status, grunn }) => ({ nr, status, grunn })) };
      });
      return c.json(svar);
    });
  }

  // Sjekk på nytt om kunden kan motta EHF.
  org.post("/kunder/:id/ehf", async (c) => {
    const k = await bruk(c, async (db) => {
      await db.query("select faktura.krev($1, 'skriv')", [orgId(c)]);
      return en(db, "select * from faktura.kunder where id = $1 and org_id = $2", [uuid.parse(c.req.param("id")), orgId(c)]);
    });
    if (!k) throw new ApiFeil(404, "Finnes ikke");
    if (!k.orgnr) throw new ApiFeil(400, "Kunden har ikke organisasjonsnummer. EHF krever org.nr.");
    const ny = await medEhf(c, k, true);
    if (ny === k) throw new ApiFeil(503, "Fikk ikke svar fra EHF-registeret. Prøv igjen om litt.");
    return c.json(ny);
  });

  // EHF-filen (UBL etter PEPPOL BIS Billing 3.0) for en utstedt faktura, med PDF-en og
  // vedleggene lagt ved.
  org.get("/fakturaer/:id/ehf", async (c) => {
    const id = uuid.parse(c.req.param("id"));
    const { xml, navn } = await bruk(c, async (db) => {
      const f = await hentFaktura(db, orgId(c), id);
      const hindring = ehfHindring(f);
      if (hindring) throw new ApiFeil(409, hindring);
      const { data } = await sikrePdf(db, f);
      const kreditert = f.kreditnota_for
        ? await en(db, "select fakturanummer as nummer, fakturadato as dato from faktura.fakturaer where id = $1", [f.kreditnota_for])
        : null;
      const vedlegg = await vedleggFiler(db, f);
      return { xml: lagEhf(f, { pdf: { filnavn: pdfFilnavn(f), data }, vedlegg, kreditertFaktura: kreditert ?? undefined }), navn: ehfFilnavn(f) };
    });
    return c.body(xml, 200, { "content-type": "application/xml; charset=utf-8", "content-disposition": `attachment; filename="${navn}"` });
  });

  // --- Mange fakturaer på én gang ------------------------------------------
  // Alt eller ingenting: stopper én faktura (kunde, linjer, grenser), lagres ingen, og
  // feilmeldingen sier hvilken. Utsendingen legges i kø etter at alt er lagret.
  const feilFor = (nr: number, navn: string | undefined, e: unknown): never => {
    const h = tilHttp(e);
    throw new ApiFeil(h.status, `Faktura ${nr}${navn ? ` (${navn})` : ""}: ${h.error}`);
  };
  const oppsummer = (db: Db, ider: string[]) =>
    alle(
      db,
      `select f.id, f.fakturanummer, f.status, f.kunde_id, coalesce(f.kunde->>'navn', k.navn) as kunde_navn, k.epost as kunde_epost,
              coalesce(f.sum_inkl_mva, (select sum(round(faktura.linje_netto(l.antall, l.enhetspris, l.rabatt_prosent, l.rabatt_belop), 2)
                                                     + round(faktura.linje_netto(l.antall, l.enhetspris, l.rabatt_prosent, l.rabatt_belop) * l.mva_sats / 100, 2))
                                          from faktura.faktura_linjer l where l.faktura_id = f.id)) as sum_inkl_mva
         from faktura.fakturaer f join faktura.kunder k on k.id = f.kunde_id
        where f.id = any($1::uuid[]) order by array_position($1::uuid[], f.id)`,
      [ider],
    );
  // Ti om gangen; feiler køen for noen, kan de sendes på nytt fra fakturaen.
  const leggUtsendingIKo = async (ider: string[]) => {
    const feilet: string[] = [];
    for (let i = 0; i < ider.length; i += 10) {
      const del = ider.slice(i, i + 10);
      const r = await Promise.allSettled(del.map((id) => leggIKo({ type: "send-faktura", faktura_id: id, send_epost: true })));
      r.forEach((x, j) => x.status === "rejected" && feilet.push(del[j]!));
    }
    return feilet;
  };

  const flereSkjema = z.object({
    fakturadato: datoS.nullish(),
    forfallsdato: datoS.nullish(),
    periode_fra: datoS.nullish(),
    periode_til: datoS.nullish(),
    var_referanse: valgfriTekst(100),
    kommentar: valgfriTekst(1000),
    konto_id: uuid.nullish(),
    avsender: z.enum(["firma", "innehaver"]).nullish(),
    gebyr: z.boolean().optional(),
    utsted: z.boolean().optional(), // utsted og send med en gang (ellers lagres utkast)
    fakturaer: z
      .array(
        z.object({
          kunde_id: uuid,
          deres_referanse: valgfriTekst(100),
          kopi_til: epostliste(10).optional(),
          // Overstyrer det felles valget for denne fakturaen (utelatt: felles).
          avsender: z.enum(["firma", "innehaver"]).nullish(),
          konto_id: uuid.nullish(),
          kommentar: valgfriTekst(1000).optional(),
          linjer: z.array(linjeSkjema).min(1, "Fakturaen trenger minst én linje").max(100),
        }),
      )
      .min(1)
      .max(200, "Høyst 200 fakturaer om gangen"),
  });

  org.post("/fakturaer/flere", async (c) => {
    const b = await kropp(c, flereSkjema);
    if (b.utsted) krevMfa(c);
    const fakturaer = await bruk(c, async (db) => {
      await db.query("select faktura.krev($1, $2)", [orgId(c), b.utsted ? "utsted" : "skriv"]);
      const kunder = new Map(
        (await alle<{ id: string; navn: string }>(db, "select id, navn from faktura.kunder where org_id = $1 and id = any($2::uuid[])", [orgId(c), b.fakturaer.map((f) => f.kunde_id)])).map((k) => [k.id, k.navn]),
      );
      const ider: string[] = [];
      for (const [i, x] of b.fakturaer.entries()) {
        try {
          if (!kunder.has(x.kunde_id)) throw new ApiFeil(404, "Fant ikke kunden");
          const f = await en(
            db,
            `insert into faktura.fakturaer (org_id, kunde_id, fakturadato, forfallsdato, periode_fra, periode_til,
                                            deres_referanse, var_referanse, konto_id, avsender, kopi_til, kommentar, opprettet_av)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, faktura.bruker_id()) returning id`,
            [orgId(c), x.kunde_id, b.fakturadato ?? null, b.forfallsdato ?? null, b.periode_fra ?? null, b.periode_til ?? null,
             x.deres_referanse, b.var_referanse, x.konto_id === undefined ? (b.konto_id ?? null) : x.konto_id,
             x.avsender === undefined ? (b.avsender ?? null) : x.avsender, x.kopi_til ?? [], x.kommentar === undefined ? b.kommentar : x.kommentar],
          );
          await skrivLinjer(db, orgId(c), f.id, x.linjer, b.gebyr ?? false);
          if (b.utsted) await db.query("select faktura.utsted($1)", [f.id]);
          ider.push(f.id);
        } catch (e) {
          feilFor(i + 1, kunder.get(x.kunde_id), e);
        }
      }
      return oppsummer(db, ider);
    });
    const ikkeSendt = b.utsted ? await leggUtsendingIKo(fakturaer.map((f) => f.id)) : [];
    return c.json({ fakturaer, ikke_sendt: ikkeSendt }, 201);
  });

  // Utsteder og sender valgte utkast. Fakturaer som allerede er sendt, hoppes over.
  org.post("/fakturaer/utsted-flere", async (c) => {
    krevMfa(c);
    const b = await kropp(c, z.object({ ider: z.array(uuid).min(1).max(200, "Høyst 200 fakturaer om gangen"), send_epost: z.boolean().optional() }));
    const ider = [...new Set(b.ider)];
    const { fakturaer, hoppetOver } = await bruk(c, async (db) => {
      await db.query("select faktura.krev($1, 'utsted')", [orgId(c)]);
      const rader = await alle<{ id: string; status: string; kunde_navn: string }>(
        db,
        `select f.id, f.status, coalesce(f.kunde->>'navn', k.navn) as kunde_navn
           from faktura.fakturaer f join faktura.kunder k on k.id = f.kunde_id where f.org_id = $1 and f.id = any($2::uuid[])`,
        [orgId(c), ider],
      );
      const finnes = new Map(rader.map((r) => [r.id, r]));
      const utstedt: string[] = [];
      const hoppetOver: string[] = [];
      for (const [i, id] of ider.entries()) {
        const r = finnes.get(id);
        try {
          if (!r) throw new ApiFeil(404, "Fant ikke fakturaen");
          if (r.status !== "utkast") {
            hoppetOver.push(id);
            continue;
          }
          await db.query("select faktura.utsted($1)", [id]);
          utstedt.push(id);
        } catch (e) {
          feilFor(i + 1, r?.kunde_navn, e);
        }
      }
      return { fakturaer: await oppsummer(db, utstedt), hoppetOver };
    });
    const ikkeSendt = b.send_epost === false ? [] : await leggUtsendingIKo(fakturaer.map((f) => f.id));
    return c.json({ fakturaer, ikke_sendt: ikkeSendt, hoppet_over: hoppetOver });
  });

  org.delete("/fakturaer/:id", async (c) => {
    const r = await bruk(c, (db) => db.query("delete from faktura.fakturaer where id = $1 and org_id = $2 and status = 'utkast'", [uuid.parse(c.req.param("id")), orgId(c)]));
    if (!r.rowCount) throw new ApiFeil(409, "Bare utkast kan slettes");
    return c.body(null, 204);
  });

  // Sletter en utstedt faktura (ment for testfakturaer) sammen med kreditnotaer,
  // betalinger og purringer. Kopier i brukernes Google Disk fjernes også.
  org.post("/fakturaer/:id/slett", async (c) => {
    krevMfa(c);
    const { grunn } = await kropp(c, z.object({ grunn: z.string().trim().min(3).max(500) }));
    const id = uuid.parse(c.req.param("id"));
    const ider = await bruk(c, async (db) => (await en(db, "select faktura.slett_faktura($1, $2, $3) as ider", [orgId(c), id, grunn]))!.ider as string[]);
    await leggIKo({ type: "disk-slett", org_id: orgId(c), faktura_ider: ider });
    return c.json({ slettet: ider });
  });

  // Utsteder og legger utsendingen (PDF + e-post) i kø.
  org.post("/fakturaer/:id/utsted", async (c) => {
    krevMfa(c);
    const b = await kropp(c, z.object({ send_epost: z.boolean().optional() }));
    const id = uuid.parse(c.req.param("id"));
    const f = await bruk(c, async (db) => {
      await hentFaktura(db, orgId(c), id);
      return en(db, "select * from faktura.utsted($1)", [id]);
    });
    await leggIKo({ type: "send-faktura", faktura_id: id, send_epost: b.send_epost ?? true });
    return c.json(f);
  });

  // Sender på nytt, eventuelt med endrede kopimottakere (de gjelder også purringer senere).
  // Kom EHF-en fram (eller venter den på kvittering), sendes den nye på e-post.
  org.post("/fakturaer/:id/send", async (c) => {
    const b = await kropp(c, z.object({ kopi_til: epostliste(10).optional() }));
    const id = uuid.parse(c.req.param("id"));
    const ehfLevert = await bruk(c, async (db) => {
      const f = await hentFaktura(db, orgId(c), id);
      if (f.status === "utkast") throw new ApiFeil(409, "Fakturaen er ikke utstedt");
      if (!(await en(db, "select faktura.kan($1, 'utsted') as k", [orgId(c)]))!.k) throw new ApiFeil(403, "Ingen tilgang");
      if (b.kopi_til) await db.query("select faktura.sett_kopi_til($1, $2)", [id, b.kopi_til]);
      const siste = await en(db, "select status from faktura.ehf_sendinger where faktura_id = $1 order by opprettet desc limit 1", [id]);
      return siste?.status === "levert" || siste?.status === "venter";
    });
    await leggIKo({ type: "send-faktura", faktura_id: id, send_epost: true, ehf: !ehfLevert });
    return c.json({ ok: true, kanal: ehfLevert ? "epost" : "auto" }, 202);
  });

  org.post("/fakturaer/:id/krediter", async (c) => {
    krevMfa(c);
    const b = await kropp(c, z.object({ linjer: z.array(z.object({ linje_id: uuid, antall: z.number() })).nullish(), send_epost: z.boolean().optional() }));
    const id = uuid.parse(c.req.param("id"));
    const kn = await bruk(c, async (db) => {
      await hentFaktura(db, orgId(c), id);
      return en(db, "select * from faktura.krediter($1, $2)", [id, b.linjer ? JSON.stringify(b.linjer) : null]);
    });
    await leggIKo({ type: "send-faktura", faktura_id: kn.id, send_epost: b.send_epost ?? true });
    return c.json(kn, 201);
  });

  org.post("/fakturaer/:id/purring", async (c) => {
    const b = await kropp(c, z.object({ type: z.enum(["paaminnelse", "inkassovarsel"]) }));
    const id = uuid.parse(c.req.param("id"));
    const p = await bruk(c, async (db) => {
      const f = await hentFaktura(db, orgId(c), id);
      const k = await en(db, "select epost from faktura.kunder where id = $1", [f.kunde_id]);
      if (!k?.epost && !f.kunde?.epost) throw new ApiFeil(400, "Kunden har ingen e-postadresse. Legg den inn under Kunder først.");
      return en(db, "select * from faktura.lag_purring($1, $2)", [id, b.type]);
    });
    await leggIKo({ type: "send-purring", purring_id: p.id });
    return c.json(p, 201);
  });

  org.post("/fakturaer/:id/betalinger", async (c) => {
    const b = await kropp(c, z.object({ belop: z.number(), dato: datoS, notat: valgfriTekst(500) }));
    const id = uuid.parse(c.req.param("id"));
    return c.json(
      await bruk(c, async (db) => {
        await hentFaktura(db, orgId(c), id);
        return en(db, "select * from faktura.registrer_betaling($1, $2, $3, $4)", [id, b.belop, b.dato, b.notat]);
      }),
    );
  });

  org.post("/fakturaer/:id/refusjoner", async (c) => {
    const b = await kropp(c, z.object({ belop: z.number().positive(), dato: datoS, notat: valgfriTekst(500) }));
    const id = uuid.parse(c.req.param("id"));
    return c.json(
      await bruk(c, async (db) => {
        await hentFaktura(db, orgId(c), id);
        return en(db, "select * from faktura.registrer_refusjon($1, $2, $3, $4)", [id, b.belop, b.dato, b.notat]);
      }),
    );
  });

  // PDF: utkast tegnes direkte (forhåndsvisning); utstedte får en signert lenke i 10 minutter.
  org.get("/fakturaer/:id/pdf", async (c) => {
    const id = uuid.parse(c.req.param("id"));
    const svar = await bruk(c, async (db) => {
      const f = await hentFaktura(db, orgId(c), id);
      if (f.status === "utkast") return { pdf: await lagPdf(await pdfData(db, f)), navn: pdfFilnavn(f) };
      const { sti } = await sikrePdf(db, f);
      if (!f.pdf_sti) await db.query("select faktura.marker_sendt($1, $2, null)", [id, sti]).catch(() => {});
      return { url: await lagring.signertUrl(config.fakturaBucket!, sti, 10, pdfFilnavn(f)) };
    });
    if ("url" in svar) return c.json({ url: svar.url });
    return c.body(Buffer.from(svar.pdf), 200, { "content-type": "application/pdf", "content-disposition": `inline; filename="${svar.navn}"` });
  });

  // --- Gjentakelser --------------------------------------------------------
  const gjentakelseSkjema = z.object({
    kunde_id: uuid,
    linjer: z.array(linjeSkjema).min(1).max(100),
    intervall: z.enum(["maaned", "kvartal", "aar"]),
    forfall_dag: z.number().int().min(1).max(31),
    neste_forfall: datoS,
    send_dager_foer: z.number().int().min(0).max(60).optional(),
    slutt_dato: datoS.nullish(),
    aktiv: z.boolean().optional(),
    deres_referanse: valgfriTekst(100),
    kommentar: valgfriTekst(1000),
    konto_id: uuid.nullish(),
    avsender: z.enum(["firma", "innehaver"]).nullish(),
    kopi_til: epostliste(10).optional(),
  });

  org.get("/gjentakelser", async (c) =>
    c.json(
      await bruk(c, (db) =>
        alle(
          db,
          `select g.*, k.navn as kunde_navn from faktura.gjentakelser g join faktura.kunder k on k.id = g.kunde_id
            where g.org_id = $1 order by g.aktiv desc, g.neste_dato`,
          [orgId(c)],
        ),
      ),
    ),
  );

  org.post("/gjentakelser", async (c) => {
    const b = await kropp(c, gjentakelseSkjema);
    return c.json(
      await bruk(c, (db) =>
        en(
          db,
          `insert into faktura.gjentakelser (org_id, kunde_id, linjer, intervall, forfall_dag, neste_forfall, send_dager_foer,
                                            slutt_dato, aktiv, deres_referanse, konto_id, avsender, kopi_til, kommentar, opprettet_av)
           values ($1, $2, $3, $4, $5, $6, coalesce($7, (select standard_dager_foer_forfall from faktura.organisasjoner where id = $1)),
                   $8, coalesce($9, true), $10, $11, $12, $13, $14, faktura.bruker_id()) returning *`,
          [orgId(c), b.kunde_id, JSON.stringify(b.linjer), b.intervall, b.forfall_dag, b.neste_forfall, b.send_dager_foer ?? null,
           b.slutt_dato ?? null, b.aktiv ?? null, b.deres_referanse, b.konto_id ?? null, b.avsender ?? null, b.kopi_til ?? [], b.kommentar],
        ),
      ),
      201,
    );
  });

  org.patch("/gjentakelser/:id", async (c) => {
    const b = await kropp(c, gjentakelseSkjema.partial());
    const data: Record<string, unknown> = { ...b, linjer: b.linjer ? JSON.stringify(b.linjer) : undefined };
    const s = settFelter(data, 3);
    if (s.tom) throw new ApiFeil(400, "Ingen felt å endre");
    const r = await bruk(c, (db) => en(db, `update faktura.gjentakelser set ${s.sql} where id = $1 and org_id = $2 returning *`, [uuid.parse(c.req.param("id")), orgId(c), ...s.verdier]));
    if (!r) throw new ApiFeil(404, "Finnes ikke");
    return c.json(r);
  });

  // Lager og sender neste faktura fra gjentakelsen med en gang.
  org.post("/gjentakelser/:id/kjor", async (c) => {
    krevMfa(c);
    const id = uuid.parse(c.req.param("id"));
    const f = await bruk(c, async (db) => {
      const g = await en(db, "select id from faktura.gjentakelser where id = $1 and org_id = $2", [id, orgId(c)]);
      if (!g) throw new ApiFeil(404, "Finnes ikke");
      const fid = (await en(db, "select faktura.lag_fra_gjentakelse($1) as id", [id]))!.id;
      if (!fid) throw new ApiFeil(409, "Gjentakelsen er stoppet, utløpt eller kunden er inaktiv");
      return en(db, "select * from faktura.utsted($1)", [fid]);
    });
    await leggIKo({ type: "send-faktura", faktura_id: f.id, send_epost: true });
    return c.json(f, 201);
  });

  org.delete("/gjentakelser/:id", async (c) => {
    const r = await bruk(c, (db) => db.query("delete from faktura.gjentakelser where id = $1 and org_id = $2", [uuid.parse(c.req.param("id")), orgId(c)]));
    if (!r.rowCount) throw new ApiFeil(404, "Finnes ikke");
    return c.body(null, 204);
  });

  // --- Revisjonslogg -----------------------------------------------------
  org.get("/revisjonslogg", async (c) =>
    c.json(
      await bruk(c, (db) =>
        alle(
          db,
          `select r.*, b.epost as bruker_epost from faktura.revisjonslogg r left join faktura.brukere b on b.id = r.bruker_id
            where r.org_id = $1 order by r.tid desc limit 200`,
          [orgId(c)],
        ),
      ),
    ),
  );

  api.route("/org/:org", org);
  app.route("/api", api);
  app.notFound((c) => c.json({ error: "Finnes ikke" }, 404));
  return app;
}
