// Verifisering av organisasjoner og plattformadministrasjon.
import { Hono, type Context } from "hono";
import { randomInt } from "node:crypto";
import { z } from "zod";
import { config } from "./config.js";
import { alle, en, somBetrodd, somBruker } from "./db.js";
import { funksjonAdminRuter } from "./funksjoner.js";
import { slettAdminRuter } from "./slettOrg.js";
import { trekktabellAdminRuter } from "./lonn.js";
import { kontoAdminRuter } from "./kontoer.js";
import { ApiFeil } from "./feil.js";
import {
  epostHorerTilForetaket,
  erForetaketsEpost,
  finnRolle,
  hentEnhet as ekteHentEnhet,
  hentRoller as ekteHentRoller,
  maskerEpost,
  sammePerson,
  type Enhet,
  type Rolle,
} from "./brreg.js";
import { leggIKo } from "./tjenester.js";
import { AiFeil, aiPaa, generer, type AiSvar } from "./ai.js";
import { tilUtkast, utkastForesporsel, type AiUtkast, type Grunnlag } from "./aiFaktura.js";
import { assistentForesporsel, type AiKommando } from "./aiAssistent.js";
import type { PersonalGrunnlag } from "./aiPersonal.js";
import { taleForesporsel, talefra, type Tale } from "./aiTale.js";
import { testEhf } from "./peppol.js";

let hentEnhet = ekteHentEnhet;
let hentRoller = ekteHentRoller;
// For testene: Enhetsregisteret (og rollene) byttet ut.
export function settBrreg(fn: typeof ekteHentEnhet, roller?: typeof ekteHentRoller) {
  hentEnhet = fn;
  if (roller) hentRoller = roller;
}

// Rollene i Brreg, men uten å stoppe verifiseringen om oppslaget feiler.
const rollerEllerIngen = (orgnr: string) => hentRoller(orgnr).catch((): Rolle[] => []);
const rolleTekst = (r: Rolle) => `${r.navn} står som ${r.rolle.toLowerCase()} i Enhetsregisteret`;

export const erPlattformadmin = (epost: string) => config.adminEposter.includes(epost.toLowerCase());

const orgId = (c: Context) => z.string().uuid().parse(c.req.param("org"));

function sjekkAktiv(e: Enhet) {
  if (e.slettet) throw new ApiFeil(409, "Foretaket er slettet i Enhetsregisteret");
  if (e.konkurs) throw new ApiFeil(409, "Foretaket er konkurs");
  if (e.under_avvikling) throw new ApiFeil(409, "Foretaket er under avvikling");
}

// Eksempelregistre og -tekster for «Test AI» på adminsiden.
const TESTREGISTER: Grunnlag = {
  navn: "Testfirma AS",
  mva: true,
  kunder: [
    { id: "test-kunde-1", navn: "Kari Hansen", orgnr: null },
    { id: "test-kunde-2", navn: "Fjordline Logistikk AS", orgnr: "912345678" },
  ],
  produkter: [
    { id: "test-produkt-1", navn: "Husleie", varenummer: null, enhet: "mnd", enhetspris: 14500, mva_sats: 0 },
    { id: "test-produkt-2", navn: "Konsulenttime", varenummer: "K1", enhet: "time", enhetspris: 1200, mva_sats: 25 },
  ],
};
const TESTFAKTURA = "Husleie for oktober til Kari Hansen, og to timer konsulent. Forfall om 14 dager.";
const TESTKOMMANDO = "Har Kari Hansen betalt?";
// Personaldelen, med det største svarskjemaet (fakturaer og personal).
const TESTPERSONAL: PersonalGrunnlag = {
  ansatte: [
    { id: "test-ansatt-1", navn: "Ola Nordmann" },
    { id: "test-ansatt-2", navn: "Kari Berg" },
    { id: "test-ansatt-3", navn: "Per Olsen" },
  ],
  meg: "test-ansatt-1",
  faser: [{ id: "test-fase-1", navn: "Formiddag", fra: "08:00", til: "12:00" }],
  oppgaver: [{ id: "test-oppgave-1", navn: "Kasse" }],
  kan: { personal: true, se: true, ferie: true, plan: true },
  vaktplan: true,
  helg: true,
};
const TESTPERSONALKOMMANDO = "Kari er syk i dag, og Per tar vaktene hennes";

// Et opptak uten tale: to sekunder svak sus, som i et stille rom (WAV, 16 kHz). AI-en skal
// svare at det ikke er tale, ikke gjette.
function stilleOpptak(sek = 2, rate = 16_000): string {
  const lengde = sek * rate * 2;
  const b = Buffer.alloc(44 + lengde);
  b.write("RIFF", 0);
  b.writeUInt32LE(36 + lengde, 4);
  b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); // PCM
  b.writeUInt16LE(1, 22); // mono
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36);
  b.writeUInt32LE(lengde, 40);
  let x = 12345;
  for (let i = 0; i < lengde / 2; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    b.writeInt16LE((x % 161) - 80, 44 + i * 2);
  }
  return b.toString("base64");
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

  // Prøver automatisk verifisering: brukerens bekreftede e-post er den som står på foretaket i
  // Enhetsregisteret, eller har foretakets eget domene. Ellers sendes en kode til e-posten i
  // registeret, eller (uten e-post der) kan brukeren be om manuell godkjenning. Står brukerens
  // navn som daglig leder, styreleder, innehaver o.l. i Brreg, sies det fra om (og
  // plattformadministratorene ser det), men navnet alene verifiserer ikke: det kan hvem som
  // helst skrive.
  r.post("/start", async (c) => {
    const b = c.get("bruker");
    const org = orgId(c);
    const k = z.object({ navn: z.string().trim().max(200).optional() }).parse(await c.req.json().catch(() => ({})));
    const o = await somBruker(b.id, async (db) => {
      if (!(await en(db, "select faktura.kan($1, 'admin') as k", [org]))!.k) throw new ApiFeil(403, "Bare administratorer kan verifisere organisasjonen");
      return en(db, "select id, navn, orgnr, verifisering from faktura.organisasjoner where id = $1", [org]);
    });
    if (!o.orgnr) throw new ApiFeil(400, "Legg inn organisasjonsnummer under Innstillinger først");
    if (o.verifisering !== "ny") return c.json({ status: o.verifisering });

    const [enhet, roller] = await Promise.all([hentEnhet(o.orgnr), rollerEllerIngen(o.orgnr)]);
    sjekkAktiv(enhet);

    if (b.epostBekreftet && erForetaketsEpost(b.epost, enhet)) {
      await somBetrodd(b.id, (db) => db.query("select faktura.verifiser_epostdomene($1, $2, 'brreg_epost')", [org, b.epost]));
      return c.json({ status: "verifisert", metode: "brreg_epost" });
    }
    if (b.epostBekreftet && epostHorerTilForetaket(b.epost, enhet)) {
      await somBetrodd(b.id, (db) => db.query("select faktura.verifiser_epostdomene($1, $2)", [org, b.epost]));
      return c.json({ status: "verifisert", metode: "epostdomene" });
    }
    const navn = k.navn || (await somBruker(b.id, (db) => en<{ navn: string | null }>(db, "select navn from faktura.brukere where id = faktura.bruker_id()")))?.navn;
    const treff = finnRolle(roller, navn);
    const rolle = treff ? { rolle: treff.rolle, navn: treff.navn } : null;

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
      return c.json({ status: "kode_sendt", sendt_til: maskerEpost(enhet.epost), rolle });
    }

    return c.json({ status: "manuell", rolle });
  });

  r.post("/kode", async (c) => {
    const k = z.object({ kode: z.string().regex(/^\s*\d{6}\s*$/, "må være seks sifre") }).parse(await c.req.json());
    const ok = await somBruker(c.get("bruker").id, async (db) => (await en(db, "select faktura.sjekk_verifiseringskode($1, $2) as ok", [orgId(c), k.kode]))!.ok);
    if (!ok) throw new ApiFeil(400, "Feil kode");
    return c.json({ status: "verifisert", metode: "brreg_epost" });
  });

  // Manuell godkjenning. Står brukerens navn med en rolle i Brreg, kommer det med i forespørselen.
  r.post("/manuell", async (c) => {
    const b = c.get("bruker");
    const k = z.object({ notat: z.string().trim().max(1000).optional(), navn: z.string().trim().max(200).optional() }).parse(await c.req.json().catch(() => ({})));
    const forhand = await somBruker(b.id, async (db) => ({
      orgnr: (await en<{ orgnr: string | null }>(db, "select orgnr from faktura.organisasjoner where id = $1", [orgId(c)]))?.orgnr ?? null,
      navn: k.navn || (await en<{ navn: string | null }>(db, "select navn from faktura.brukere where id = faktura.bruker_id()"))?.navn,
    }));
    const treff = forhand.orgnr ? finnRolle(await rollerEllerIngen(forhand.orgnr), forhand.navn) : null;
    const notat = [treff ? `${rolleTekst(treff)} (samme navn som brukeren oppgir).` : null, k.notat ?? null].filter(Boolean).join("\n") || null;
    const o = await somBruker(b.id, async (db) => {
      await db.query("select faktura.be_om_manuell_verifisering($1, $2)", [orgId(c), notat]);
      return en(db, "select navn, orgnr from faktura.organisasjoner where id = $1", [orgId(c)]);
    });
    if (config.adminEposter.length) {
      await leggIKo({
        type: "epost",
        til: config.adminEposter,
        emne: `Ny forespørsel om verifisering: ${o.navn}`,
        tekst: `${b.epost} ber om verifisering av ${o.navn} (org.nr. ${o.orgnr ?? "mangler"}).\n\n${notat ?? ""}\n\nBehandle den på ${config.appUrl}/admin`,
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

  // Funksjoner per organisasjon og standarden for nye, og kontoer som venter på godkjenning.
  r.route("/", funksjonAdminRuter());
  r.route("/", kontoAdminRuter());
  // Sletting av organisasjoner, og de som er slettet.
  r.route("/", slettAdminRuter());
  // Trekktabellene for forskuddstrekk (lastes inn fra Skatteetaten hvert år).
  r.route("/", trekktabellAdminRuter());

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

  // Prøver AI-oppsettet (Gemini på Vertex AI): et enkelt svar, de samme forespørslene som
  // fakturautkast og assistenten sender (med eksempelregistrene over), og tale til tekst med
  // et stille opptak. Viser svaret fra Google
  // når noe ikke virker (manglende tilgang, modellen finnes ikke i regionen …), og om Gemini
  // avviste svarskjemaet (skjemafeil: da kom svaret uten). Alle prøver med skjemaet først.
  r.post("/ai-test", async (c) => {
    const oppsett = { modell: config.aiModell, region: config.aiRegion };
    if (!aiPaa()) return c.json({ ok: false, ...oppsett, feil: "AI er ikke satt opp (AI_PROSJEKT mangler).", detaljer: null, ms: 0, tester: [] });
    const start = Date.now();
    const test = async <T>(navn: string, kall: () => Promise<AiSvar<T>>, svar: (data: T) => string) => {
      const fra = Date.now();
      try {
        const s = await kall();
        return { navn, ok: true, ms: Date.now() - fra, svar: svar(s.data), skjemafeil: s.skjemafeil ?? null, tokens_inn: s.tokens_inn, tokens_ut: s.tokens_ut };
      } catch (e) {
        return { navn, ok: false, ms: Date.now() - fra, feil: (e as Error).message, detaljer: e instanceof AiFeil ? e.detaljer : null, tokens_inn: 0, tokens_ut: 0 };
      }
    };
    const tester = await Promise.all([
      test<{ svar: string }>(
        "Enkelt svar",
        () =>
          generer({
            system: "Svar kort på norsk.",
            deler: [{ text: "Skriv «Hei fra Gemini» i feltet svar." }],
            skjema: { type: "OBJECT", properties: { svar: { type: "STRING" } }, required: ["svar"] },
            husk: false,
          }),
        (d) => d.svar,
      ),
      test<AiUtkast>(
        "Fakturautkast",
        () => generer({ ...utkastForesporsel(TESTREGISTER, TESTFAKTURA), husk: false }),
        (d) => {
          const u = tilUtkast(d, TESTREGISTER);
          const kunde = TESTREGISTER.kunder.find((k) => k.id === u.kunde_id)?.navn ?? u.kunde_navn ?? "ingen kunde";
          return `${kunde}: ${u.linjer.map((l) => `${l.beskrivelse} (${l.enhetspris ?? "uten pris"})`).join(", ") || "ingen linjer"}${u.forfallsdato ? `, forfall ${u.forfallsdato}` : ""}`;
        },
      ),
      test<AiKommando>(
        "Assistent",
        () => generer({ ...assistentForesporsel({ g: TESTREGISTER, p: null }, TESTKOMMANDO), husk: false }),
        (d) => `${d.handling}${d.kunde ? ` (${d.kunde})` : ""}`,
      ),
      test<AiKommando>(
        "Assistent for personal",
        () => generer({ ...assistentForesporsel({ g: TESTREGISTER, p: TESTPERSONAL }, TESTPERSONALKOMMANDO), husk: false }),
        (d) => `${d.handling}${d.ansatt ? ` (${d.ansatt}${d.vikar ? `, vikar ${d.vikar}` : ""})` : ""}`,
      ),
      test<Tale>(
        "Tale (stille opptak)",
        () => generer({ ...taleForesporsel({ mimeType: "audio/wav", data: stilleOpptak() }), husk: false }),
        (d) => {
          const tekst = talefra(d);
          if (tekst) throw new Error(`AI-en fant tale i et stille opptak: «${tekst}»`);
          return "Ingen tale, som ventet";
        },
      ),
    ]);
    const feilet = tester.find((t) => !t.ok);
    return c.json({
      ok: !feilet,
      ...oppsett,
      svar: tester[0].svar ?? null,
      ms: Date.now() - start,
      tokens_inn: tester.reduce((s, t) => s + t.tokens_inn, 0),
      tokens_ut: tester.reduce((s, t) => s + t.tokens_ut, 0),
      feil: feilet ? `${feilet.navn}: ${feilet.feil}` : null,
      detaljer: feilet?.detaljer ?? null,
      tester,
    });
  });

  // Prøver EHF-oppslaget i PEPPOL for et org.nr., med hvert steg: DNS (SML), SMP-en,
  // svaret for EHF-fakturaen og dokumenttypene mottakeren er registrert for.
  r.post("/ehf-test", async (c) => {
    const { orgnr } = z
      .object({ orgnr: z.string().transform((s) => s.replace(/\s/g, "")).pipe(z.string().regex(/^\d{9}$/, "Skriv et org.nr. med ni siffer.")) })
      .parse(await c.req.json().catch(() => ({})));
    const start = Date.now();
    return c.json({ orgnr, ...(await testEhf(orgnr)), ms: Date.now() - start });
  });

  r.get("/organisasjoner", async (c) => c.json(await somBetrodd(c.get("bruker").id, (db) => alle(db, "select * from faktura.admin_organisasjoner()"))));

  r.get("/brukere", async (c) => c.json(await somBetrodd(c.get("bruker").id, (db) => alle(db, "select * from faktura.admin_brukere()"))));

  // Alt om én organisasjon: medlemmer, bruk, integrasjoner, kontonummerendringer og aktivitet.
  r.get("/organisasjoner/:id", async (c) => {
    const d = (await somBetrodd(c.get("bruker").id, (db) => en(db, "select faktura.admin_organisasjon($1) as d", [id(c)])))?.d;
    if (!d) throw new ApiFeil(404, "Fant ikke organisasjonen");
    return c.json(d);
  });

  // Enhetsregisteret og rollene i Brreg, med hvilke medlemmer som har samme navn som en
  // rolleinnehaver, og om e-posten i registeret er et medlems.
  r.get("/organisasjoner/:id/brreg", async (c) => {
    const o = await somBetrodd(c.get("bruker").id, async (db) => ({
      orgnr: (await en<{ orgnr: string | null }>(db, "select orgnr from faktura.admin_organisasjoner() where id = $1", [id(c)]))?.orgnr,
      medlemmer: ((await en(db, "select faktura.admin_organisasjon($1) as d", [id(c)]))?.d?.medlemmer ?? []) as { navn: string | null; epost: string }[],
    }));
    if (!o.orgnr) throw new ApiFeil(404, "Mangler organisasjonsnummer");
    const [enhet, roller] = await Promise.all([hentEnhet(o.orgnr), rollerEllerIngen(o.orgnr)]);
    return c.json({
      ...enhet,
      epost_medlem: o.medlemmer.find((m) => erForetaketsEpost(m.epost, enhet))?.epost ?? null,
      roller: roller.map((r) => ({ ...r, treff: o.medlemmer.filter((m) => sammePerson(m.navn, r.navn)).map((m) => m.navn ?? m.epost) })),
    });
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
