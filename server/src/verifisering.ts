// Verifisering av organisasjoner og plattformadministrasjon.
import { Hono, type Context } from "hono";
import { randomInt } from "node:crypto";
import { z } from "zod";
import { config } from "./config.js";
import { alle, en, somBetrodd, somBruker } from "./db.js";
import { ApiFeil } from "./feil.js";
import { epostHorerTilForetaket, hentEnhet as ekteHentEnhet, maskerEpost, type Enhet } from "./brreg.js";
import { leggIKo } from "./tjenester.js";

let hentEnhet = ekteHentEnhet;
export function settBrreg(fn: typeof ekteHentEnhet) {
  hentEnhet = fn;
}

export const erPlattformadmin = (epost: string) => config.adminEposter.includes(epost.toLowerCase());

const orgId = (c: Context) => z.string().uuid().parse(c.req.param("org"));

function sjekkAktiv(e: Enhet) {
  if (e.slettet) throw new ApiFeil(409, "Foretaket er slettet i Enhetsregisteret");
  if (e.konkurs) throw new ApiFeil(409, "Foretaket er konkurs");
  if (e.under_avvikling) throw new ApiFeil(409, "Foretaket er under avvikling");
}

// Monteres under /api/org/:org/verifisering.
export function verifiseringRuter() {
  const r = new Hono();

  r.get("/", async (c) => {
    const b = c.get("bruker");
    return c.json(
      await somBruker(b.id, async (db) => {
        const o = await en(db, "select verifisering, verifisert_at, verifisert_metode, sperret_grunn, orgnr from faktura.organisasjoner where id = $1", [orgId(c)]);
        if (!o) throw new ApiFeil(404, "Fant ikke organisasjonen");
        const siste = await alle(db, "select metode, status, sendt_til, utloper, opprettet from faktura.verifiseringer where org_id = $1 order by opprettet desc limit 5", [orgId(c)]);
        return { ...o, forsok: siste };
      }),
    );
  });

  // Prøver automatisk verifisering; ellers sendes kode til e-posten i Enhetsregisteret.
  r.post("/start", async (c) => {
    const b = c.get("bruker");
    const org = orgId(c);
    const o = await somBruker(b.id, async (db) => {
      if (!(await en(db, "select faktura.kan($1, 'admin') as k", [org]))!.k) throw new ApiFeil(403, "Bare administratorer kan verifisere organisasjonen");
      return en(db, "select id, navn, orgnr, verifisering from faktura.organisasjoner where id = $1", [org]);
    });
    if (!o.orgnr) throw new ApiFeil(400, "Legg inn organisasjonsnummer under Innstillinger først");
    if (o.verifisering !== "ny") return c.json({ status: o.verifisering });

    const enhet = await hentEnhet(o.orgnr);
    sjekkAktiv(enhet);

    if (b.epostBekreftet && epostHorerTilForetaket(b.epost, enhet)) {
      await somBetrodd(b.id, (db) => db.query("select faktura.verifiser_epostdomene($1, $2)", [org, b.epost]));
      return c.json({ status: "verifisert", metode: "epostdomene" });
    }

    if (enhet.epost) {
      const kode = String(randomInt(0, 1_000_000)).padStart(6, "0");
      await somBruker(b.id, (db) => db.query("select faktura.start_verifiseringskode($1, $2, $3)", [org, enhet.epost, kode]));
      await leggIKo({
        type: "epost",
        til: [enhet.epost],
        emne: `Bekreftelseskode for ${enhet.navn} i HI4 Faktura`,
        tekst: [
          `Hei,`,
          ``,
          `${b.epost} vil bruke HI4 Faktura til å fakturere på vegne av ${enhet.navn} (org.nr. ${enhet.orgnr}).`,
          `Denne adressen står som foretakets e-post i Enhetsregisteret.`,
          ``,
          `Bekreftelseskode: ${kode}`,
          ``,
          `Koden gjelder i 30 minutter. Hvis du ikke kjenner til dette, kan du se bort fra e-posten – da får personen ikke fakturere i foretakets navn.`,
        ].join("\n"),
      });
      return c.json({ status: "kode_sendt", sendt_til: maskerEpost(enhet.epost) });
    }

    return c.json({ status: "manuell" });
  });

  r.post("/kode", async (c) => {
    const k = z.object({ kode: z.string().regex(/^\s*\d{6}\s*$/, "må være seks sifre") }).parse(await c.req.json());
    const ok = await somBruker(c.get("bruker").id, async (db) => (await en(db, "select faktura.sjekk_verifiseringskode($1, $2) as ok", [orgId(c), k.kode]))!.ok);
    if (!ok) throw new ApiFeil(400, "Feil kode");
    return c.json({ status: "verifisert", metode: "brreg_epost" });
  });

  r.post("/manuell", async (c) => {
    const b = c.get("bruker");
    const k = z.object({ notat: z.string().trim().max(1000).optional() }).parse(await c.req.json().catch(() => ({})));
    const o = await somBruker(b.id, async (db) => {
      await db.query("select faktura.be_om_manuell_verifisering($1, $2)", [orgId(c), k.notat ?? null]);
      return en(db, "select navn, orgnr from faktura.organisasjoner where id = $1", [orgId(c)]);
    });
    if (config.adminEposter.length) {
      await leggIKo({
        type: "epost",
        til: config.adminEposter,
        emne: `Ny forespørsel om verifisering: ${o.navn}`,
        tekst: `${b.epost} ber om verifisering av ${o.navn} (org.nr. ${o.orgnr ?? "mangler"}).\n\n${k.notat ?? ""}\n\nBehandle den på ${config.appUrl}/admin`,
      }).catch((e) => console.warn("Kunne ikke varsle administratorer", e));
    }
    return c.json({ status: "venter" });
  });

  return r;
}

// Monteres under /api/admin. Krever plattformadmin med totrinn.
export function adminRuter() {
  const r = new Hono();

  r.use("*", async (c, next) => {
    const b = c.get("bruker");
    if (!erPlattformadmin(b.epost) || !b.epostBekreftet) throw new ApiFeil(403, "Ingen tilgang");
    if (config.produksjon && !b.mfa) throw new ApiFeil(403, "Administrasjon krever totrinnsbekreftelse (MFA eller passkey)");
    await next();
  });

  const id = (c: Context) => z.string().uuid().parse(c.req.param("id"));

  // Tellinger for oversikten, og driftsstatus.
  r.get("/oversikt", async (c) => c.json((await somBetrodd(c.get("bruker").id, (db) => en(db, "select faktura.admin_oversikt() as d")))!.d));
  // Med AI-bruken denne måneden (modellen og regionen fra konfigurasjonen).
  r.get("/drift", async (c) =>
    c.json(
      (await somBetrodd(c.get("bruker").id, (db) =>
        en(db, "select faktura.admin_drift() || jsonb_build_object('ai', faktura.admin_ai() || $1::jsonb) as d", [
          JSON.stringify({ satt_opp: Boolean(config.aiProsjekt), modell: config.aiModell, region: config.aiRegion, grense: config.aiGrense }),
        ]),
      ))!.d,
    ),
  );

  r.get("/organisasjoner", async (c) => c.json(await somBetrodd(c.get("bruker").id, (db) => alle(db, "select * from faktura.admin_organisasjoner()"))));

  r.get("/brukere", async (c) => c.json(await somBetrodd(c.get("bruker").id, (db) => alle(db, "select * from faktura.admin_brukere()"))));

  // Alt om én organisasjon: medlemmer, bruk, integrasjoner, kontonummerendringer og aktivitet.
  r.get("/organisasjoner/:id", async (c) => {
    const d = (await somBetrodd(c.get("bruker").id, (db) => en(db, "select faktura.admin_organisasjon($1) as d", [id(c)])))?.d;
    if (!d) throw new ApiFeil(404, "Fant ikke organisasjonen");
    return c.json(d);
  });

  r.get("/organisasjoner/:id/brreg", async (c) => {
    const o = await somBetrodd(c.get("bruker").id, (db) => en(db, "select orgnr from faktura.admin_organisasjoner() where id = $1", [id(c)]));
    if (!o?.orgnr) throw new ApiFeil(404, "Mangler organisasjonsnummer");
    return c.json(await hentEnhet(o.orgnr));
  });

  r.post("/organisasjoner/:id/status", async (c) => {
    const k = z.object({ status: z.enum(["verifisert", "sperret", "ny"]), grunn: z.string().trim().max(500).optional() }).parse(await c.req.json());
    if (k.status === "sperret" && !k.grunn) throw new ApiFeil(400, "Oppgi grunn for sperring");
    const o = await somBetrodd(c.get("bruker").id, (db) =>
      en(db, "select id, verifisering from faktura.sett_verifisering($1, $2, 'manuell', $3)", [id(c), k.status, k.grunn ?? null]),
    );
    return c.json(o);
  });

  return r;
}
