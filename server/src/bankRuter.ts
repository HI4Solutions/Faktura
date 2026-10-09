// Innbetalinger fra banken (Enable Banking): koblingen under Innstillinger → Faktura, og
// listen over innbetalinger som kobles til fakturaene.
//
// Koblingen: organisasjonen registrerer sin egen applikasjon hos Enable Banking og limer
// inn applikasjons-ID-en og den private nøkkelen. API-et sjekker nøkkelen og starter
// BankID for den første banken med en gang (nøkkelen er ennå ikke kryptert), og krypterer
// den med Cloud KMS. Deretter er det bare workeren som kan bruke nøkkelen: den legger til
// flere banker, fornyer, fullfører BankID og henter innbetalingene. Appen venter på svaret
// ved å spørre etter statusen.
import { Hono, type Context } from "hono";
import { z } from "zod";
import { alle, en, somBruker, type Db } from "./db.js";
import { ApiFeil } from "./feil.js";
import { krevMfa } from "./auth.js";
import { krypter } from "./kryptering.js";
import { BankFeil, gyldigTil, hentApplikasjon, hentBanker, nokkelFeil, normaliserPem, startAutorisering, velgBank, type BankNokkel } from "./enableBanking.js";
import { egneKontoer, HENTETIDER, nyState, tilbakeUrl, type BankAppKonfig, type Bankkobling } from "./bank.js";
import { leggIKo } from "./tjenester.js";
import { aiPaa } from "./ai.js";
import { foreslaFaktura } from "./aiInnbetaling.js";

const orgId = (c: Context) => z.string().uuid().parse(c.req.param("org"));
const koblingId = (c: Context) => z.string().uuid().parse(c.req.param("id"));
const bruk = <T>(c: Context, fn: (db: Db) => Promise<T>) => somBruker<T>(c.get("bruker").id, fn);
const krev = (c: Context, db: Db, handling: string) => db.query("select faktura.krev($1, $2)", [orgId(c), handling]);

const hentApp = (db: Db, org: string) =>
  en(db, "select status, konfig, opprettet, oppdatert from faktura.integrasjoner where org_id = $1 and type = 'bank' and status <> 'frakoblet'", [org]);
const hentKoblinger = (db: Db, org: string) =>
  alle<Bankkobling>(db, "select * from faktura.bankkoblinger where org_id = $1 order by opprettet", [org]);
const tekst = (d: unknown) => (d instanceof Date ? d.toISOString() : d == null ? null : String(d));

// Det appen viser om en bank (aldri nøkkelen). Bare kontoene som er lagt inn i HI4 Faktura
// vises (og leses), med navnet brukeren har gitt dem.
function koblingStatus(k: Bankkobling, egne: Map<string, string | null>) {
  // Adressen workeren lagde til BankID, så lenge den er fersk.
  const fersk = k.auth_url && k.auth_tid && Date.now() - Date.parse(tekst(k.auth_tid)!) < 10 * 60_000;
  const kontoer = k.kontoer ?? [];
  const leses = kontoer.filter((x) => egne.has(x.kontonr));
  return {
    id: k.id,
    bank: k.bank,
    psu_type: k.psu_type,
    status: k.status, // venter (BankID ikke fullført), aktiv, feil (må kobles til på nytt)
    tilkoblet: k.status === "aktiv" && Boolean(k.okt_id),
    kontoer: leses.map((x) => ({ kontonr: x.kontonr, navn: egne.get(x.kontonr) ?? x.navn })),
    andre_kontoer: kontoer.length - leses.length, // i banken, men ikke lagt inn i HI4 Faktura
    gyldig_til: tekst(k.gyldig_til),
    fullfort: tekst(k.fullfort), // når BankID sist ble fullført
    sist_hentet: tekst(k.sist_hentet),
    siste_feil: k.siste_feil,
    auth_url: fersk ? k.auth_url : null,
    auth_tid: tekst(k.auth_tid),
  };
}

// Brukeren er til stede: IP-adressen og nettleseren sendes til banken (PSD2).
const psu = (c: Context) => ({
  ip: (c.req.header("x-forwarded-for") ?? "").split(",")[0]!.trim() || "0.0.0.0",
  agent: (c.req.header("user-agent") ?? "HI4 Faktura").slice(0, 500),
});

async function status(db: Db, org: string) {
  const app = await hentApp(db, org);
  const egne = app ? await egneKontoer(db, org) : new Map<string, string | null>();
  const koblinger = app ? (await hentKoblinger(db, org)).map((k) => koblingStatus(k, egne)) : [];
  // Innbetalinger hentes fra og med denne datoen (satt: valgt av en administrator, ellers
  // dagen organisasjonen ble opprettet).
  const start = await en<{ fra: string | null; satt: boolean; ai_aktiv: boolean }>(
    db,
    "select faktura.bank_fra(id) as fra, bank_fra is not null as satt, ai_aktiv and faktura.har_funksjon(id, 'ai') as ai_aktiv from faktura.organisasjoner where id = $1",
    [org],
  );
  return {
    app: app ? { app_id: (app.konfig as BankAppKonfig).app_id, app_navn: (app.konfig as BankAppKonfig).app_navn ?? null } : null,
    koblinger,
    fra: start?.fra ?? null,
    fra_satt: start?.satt ?? false,
    tilkoblet: koblinger.some((k) => k.tilkoblet),
    hentetider: HENTETIDER, // når workeren henter av seg selv hver dag (norsk tid)
    tilbake_url: tilbakeUrl(),
    antall: await antall(db, org),
    // De siste hentingene: hva banken sendte, og hva som ble nytt (eller feilen).
    hentinger: await alle(
      db,
      `select id, tid, bank, kilde, transaksjoner, inn, ventende, nye, koblet, forslag, to_char(nyeste, 'YYYY-MM-DD') as nyeste, feil
         from faktura.bankhentinger where org_id = $1 order by id desc limit 12`,
      [org],
    ),
    ai: aiPaa() && Boolean(start?.ai_aktiv), // AI kan foreslå fakturaen for uavklarte innbetalinger
  };
}

async function antall(db: Db, org: string): Promise<Record<string, number>> {
  const rader = await alle<{ status: string; n: number }>(
    db,
    "select status, count(*)::int as n from faktura.banktransaksjoner where org_id = $1 group by status",
    [org],
  );
  return Object.fromEntries(["forslag", "uavklart", "koblet", "ignorert"].map((s) => [s, rader.find((r) => r.status === s)?.n ?? 0]));
}

function fraEnableBanking(e: unknown): ApiFeil {
  const f = e as BankFeil;
  if (f.status === 401 || f.status === 403)
    return new ApiFeil(400, "Enable Banking godtok ikke nøkkelen. Sjekk at applikasjons-ID-en og .pem-filen er fra samme applikasjon, og at applikasjonen er aktivert.");
  if (f.status === 400) return new ApiFeil(400, f.message);
  if (f.status === 0) return new ApiFeil(503, "Fikk ikke kontakt med Enable Banking. Prøv igjen om litt.");
  return new ApiFeil(502, `Enable Banking svarte med en feil: ${f.message}`);
}

const bankSkjema = z.object({
  bank: z.string().trim().min(2, "Velg banken").max(100),
  psu_type: z.enum(["business", "personal"]),
});

export function bankRuter() {
  const r = new Hono();

  r.get("/bank", async (c) =>
    c.json(
      await bruk(c, async (db) => {
        await krev(c, db, "les");
        return status(db, orgId(c));
      }),
    ),
  );

  // Første gang (eller ny nøkkel): sjekk nøkkelen, applikasjonen og banken, lagre nøkkelen
  // kryptert, og send brukeren til BankID for banken.
  r.put("/bank", async (c) => {
    krevMfa(c);
    const b = bankSkjema
      .extend({
        app_id: z.string().trim().min(8, "Mangler applikasjons-ID-en").max(100),
        privat_nokkel: z.string().trim().min(100, "Mangler den private nøkkelen").max(20_000),
      })
      .parse(await c.req.json().catch(() => ({})));
    await bruk(c, (db) => krev(c, db, "admin"));
    // Limt inn i et skjult felt på én linje: linjeskiftene settes inn igjen.
    const pem = normaliserPem(b.privat_nokkel);
    const feil = nokkelFeil(pem);
    if (feil) throw new ApiFeil(400, feil);
    const n: BankNokkel = { appId: b.app_id, privatNokkel: pem };

    let app: any;
    let bank;
    try {
      app = await hentApplikasjon(n);
      // Adressen brukeren sendes tilbake til, må være lagt inn i applikasjonen.
      const adresser: unknown = app?.redirect_urls;
      if (Array.isArray(adresser) && adresser.length && !adresser.includes(tilbakeUrl()))
        throw new ApiFeil(400, `Legg inn ${tilbakeUrl()} som «Allowed redirect URL» i applikasjonen hos Enable Banking, og prøv igjen.`);
      bank = velgBank(await hentBanker(n, "NO"), b.bank, b.psu_type);
    } catch (e) {
      throw e instanceof ApiFeil ? e : fraEnableBanking(e);
    }

    const state = nyState(orgId(c));
    const gyldig = gyldigTil(bank.maximum_consent_validity);
    let url: string;
    try {
      url = await startAutorisering(n, { bank: bank.name, land: "NO", psuType: b.psu_type, gyldigTil: gyldig, state, redirect: tilbakeUrl() });
    } catch (e) {
      throw fraEnableBanking(e);
    }

    const kryptert = await krypter(pem);
    const konfig: BankAppKonfig = { leverandor: "enablebanking", app_id: b.app_id, app_navn: typeof app?.name === "string" ? app.name : null };
    const svar = await bruk(c, async (db) => {
      const for_ = await en(db, "select konfig from faktura.integrasjoner where org_id = $1 and type = 'bank' and status <> 'frakoblet'", [orgId(c)]);
      // Ikke «on conflict … excluded»: API-et har ikke lov til å lese den krypterte kolonnen.
      const u = await db.query(
        "update faktura.integrasjoner set status = 'aktiv', konfig = $2, hemmelighet_kryptert = $3, siste_feil = null where org_id = $1 and type = 'bank'",
        [orgId(c), JSON.stringify(konfig), kryptert],
      );
      if (!u.rowCount)
        await db.query(
          "insert into faktura.integrasjoner (org_id, type, status, konfig, hemmelighet_kryptert, koblet_av) values ($1, 'bank', 'aktiv', $2, $3, faktura.bruker_id())",
          [orgId(c), JSON.stringify(konfig), kryptert],
        );
      // Ny applikasjon: øktene fra den gamle virker ikke lenger.
      if (for_?.konfig?.app_id && for_.konfig.app_id !== b.app_id)
        await db.query(
          "update faktura.bankkoblinger set status = 'feil', okt_id = null, siste_feil = 'Ny applikasjon hos Enable Banking. Koble til banken på nytt.' where org_id = $1",
          [orgId(c)],
        );
      const k = await en<{ id: string }>(
        db,
        `insert into faktura.bankkoblinger (org_id, bank, land, psu_type, status, maks_sek, state, auth_tid, auth_gyldig_til)
         values ($1, $2, 'NO', $3, 'venter', $4, $5, now(), $6)
         on conflict (org_id, bank, psu_type) do update
           set state = excluded.state, auth_tid = excluded.auth_tid, auth_gyldig_til = excluded.auth_gyldig_til,
               maks_sek = excluded.maks_sek, auth_url = null, siste_feil = null
         returning id`,
        [orgId(c), bank.name, b.psu_type, bank.maximum_consent_validity ?? null, state, gyldig.toISOString()],
      );
      return { ...(await status(db, orgId(c))), kobling_id: k!.id };
    });
    return c.json({ ...svar, url });
  });

  // Ny bank med samme applikasjon: workeren sjekker navnet og lager BankID-adressen, og
  // appen venter på den.
  r.post("/bank/koblinger", async (c) => {
    krevMfa(c);
    const b = bankSkjema.parse(await c.req.json().catch(() => ({})));
    const { id, ny } = await bruk(c, async (db) => {
      await krev(c, db, "admin");
      if (!(await hentApp(db, orgId(c)))) throw new ApiFeil(409, "Koble til den første banken med nøkkelen fra Enable Banking først.");
      // Finnes banken fra før, fornyes den i stedet.
      const finnes = await en<{ id: string }>(
        db,
        "select id from faktura.bankkoblinger where org_id = $1 and lower(bank) = lower($2) and psu_type = $3",
        [orgId(c), b.bank, b.psu_type],
      );
      if (finnes) {
        await db.query("update faktura.bankkoblinger set auth_url = null, auth_tid = null, siste_feil = null where id = $1", [finnes.id]);
        return { id: finnes.id, ny: false };
      }
      const k = await en<{ id: string }>(
        db,
        "insert into faktura.bankkoblinger (org_id, bank, land, psu_type, status) values ($1, $2, 'NO', $3, 'venter') returning id",
        [orgId(c), b.bank, b.psu_type],
      );
      return { id: k!.id, ny: true };
    });
    await leggIKo({ type: "bank-auth", org_id: orgId(c), kobling_id: id });
    return c.json({ ok: true, kobling_id: id, ny }, 202);
  });

  // Forny samtykket (eller fullfør en BankID som ble avbrutt).
  r.post("/bank/koblinger/:id/forny", async (c) => {
    await bruk(c, async (db) => {
      await krev(c, db, "admin");
      const u = await db.query("update faktura.bankkoblinger set auth_url = null, auth_tid = null, siste_feil = null where id = $1 and org_id = $2", [
        koblingId(c),
        orgId(c),
      ]);
      if (!u.rowCount) throw new ApiFeil(404, "Fant ikke banken");
    });
    await leggIKo({ type: "bank-auth", org_id: orgId(c), kobling_id: koblingId(c) });
    return c.json({ ok: true, kobling_id: koblingId(c) }, 202);
  });

  // Tilbake fra banken med koden: workeren bytter den mot tilgang til kontoene.
  r.post("/bank/fullfor", async (c) => {
    const b = z.object({ code: z.string().min(1).max(4000), state: z.string().min(10).max(200) }).parse(await c.req.json().catch(() => ({})));
    const k = await bruk(c, async (db) => {
      await krev(c, db, "admin");
      const k = await en<{ id: string; fullfort: unknown }>(db, "select id, fullfort from faktura.bankkoblinger where org_id = $1 and state = $2", [orgId(c), b.state]);
      if (!k) throw new ApiFeil(400, "Innloggingen hos banken passer ikke med noen av koblingene. Start på nytt.");
      // Engangs: samme svar fra banken kan ikke brukes to ganger.
      await db.query("update faktura.bankkoblinger set state = null, siste_feil = null where id = $1", [k.id]);
      return k;
    });
    // Brukeren er til stede: den første hentingen etter BankID teller ikke mot bankens grense.
    await leggIKo({ type: "bank-okt", org_id: orgId(c), kobling_id: k.id, kode: b.code, psu: psu(c) });
    // Appen venter til fullfort er endret (eller det kommer en feil).
    return c.json({ ok: true, kobling_id: k.id, forrige: tekst(k.fullfort) }, 202);
  });

  // Startdato for innbetalingene (null: dagen organisasjonen ble opprettet). Eldre hentes
  // ikke, og de som allerede er hentet, ryddes bort.
  r.put("/bank/fra", async (c) => {
    const dato = z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Ugyldig dato")
      .refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().startsWith(v), "Ugyldig dato");
    const b = z.object({ fra: dato.nullable() }).parse(await c.req.json().catch(() => ({})));
    return c.json(
      await bruk(c, async (db) => {
        const r = await en<{ fjernet: number }>(db, "select faktura.sett_bank_fra($1, $2) as fjernet", [orgId(c), b.fra]);
        return { ...(await status(db, orgId(c))), fjernet: r!.fjernet };
      }),
    );
  });

  // Hent nå fra alle bankene. Brukeren er til stede, så det teller ikke mot bankenes grense.
  // apnet: appen ble åpnet (Innbetalinger, fakturaene, oversikten), og henter av seg selv når
  // det er mer enn et kvarter siden sist brukeren var til stede ved en henting; ellers skjer
  // ingenting (og ingen feil, heller ikke uten bank eller uten rett til å registrere betalinger).
  r.post("/bank/hent", async (c) => {
    const b = z.object({ apnet: z.boolean().optional() }).parse(await c.req.json().catch(() => ({})));
    const s = await bruk(c, async (db) => {
      await krev(c, db, b.apnet ? "les" : "bokfor");
      if (!b.apnet) {
        const k = await en(db, "select 1 from faktura.bankkoblinger where org_id = $1 and status = 'aktiv' and okt_id is not null limit 1", [orgId(c)]);
        if (!k) throw new ApiFeil(409, "Ingen bank er koblet til");
      }
      // banker: bankene som har en konto som er lagt inn i HI4 Faktura (de som hentes fra).
      // siste: den siste hentingen som er lagret nå.
      return en<{ kan: boolean; banker: number; nylig: boolean; siste: number }>(
        db,
        `select faktura.kan($1, 'bokfor') as kan,
                (select count(*)::int from faktura.bankkoblinger k
                  where k.org_id = $1 and k.status = 'aktiv' and k.okt_id is not null
                    and exists (select 1 from faktura.integrasjoner i where i.org_id = $1 and i.type = 'bank' and i.status <> 'frakoblet')
                    and exists (select 1 from jsonb_array_elements(k.kontoer) x
                                 where x ->> 'kontonr' in (select o.kontonr from faktura.organisasjoner o where o.id = $1
                                                           union select e.kontonr from faktura.kontoer e where e.org_id = $1))) as banker,
                exists (select 1 from faktura.bankhentinger where org_id = $1 and kilde <> 'automatisk' and tid > now() - interval '15 minutes') as nylig,
                coalesce((select max(id) from faktura.bankhentinger where org_id = $1), 0) as siste`,
        [orgId(c)],
      );
    });
    if (b.apnet && !(s?.kan && s.banker > 0 && !s.nylig)) return c.json({ ok: true, startet: false });
    await leggIKo({ type: "bank-hent", org_id: orgId(c), psu: psu(c), kilde: b.apnet ? "apnet" : "manuell" });
    // Appen venter til det er kommet en ny henting per bank.
    return c.json({ ok: true, startet: true, siste: s?.siste ?? 0, banker: s?.banker ?? 0 }, 202);
  });

  // Fjern én bank. Workeren avslutter økten hos Enable Banking.
  r.delete("/bank/koblinger/:id", async (c) => {
    const okt = await bruk(c, async (db) => {
      await krev(c, db, "admin");
      const k = await en<{ okt_id: string | null }>(db, "delete from faktura.bankkoblinger where id = $1 and org_id = $2 returning okt_id", [koblingId(c), orgId(c)]);
      if (!k) throw new ApiFeil(404, "Fant ikke banken");
      return k.okt_id;
    });
    if (okt) await leggIKo({ type: "bank-slett", org_id: orgId(c), okt_ider: [okt] });
    return c.body(null, 204);
  });

  // Koble fra alt: bankene og nøkkelen. Workeren avslutter øktene og sletter nøkkelen.
  r.delete("/bank", async (c) => {
    const okter = await bruk(c, async (db) => {
      await krev(c, db, "admin");
      const n = (await db.query("update faktura.integrasjoner set status = 'frakoblet' where org_id = $1 and type = 'bank' and status <> 'frakoblet'", [orgId(c)])).rowCount;
      if (!n) throw new ApiFeil(404, "Banken er ikke koblet til");
      const k = await alle<{ okt_id: string | null }>(db, "delete from faktura.bankkoblinger where org_id = $1 returning okt_id", [orgId(c)]);
      return k.map((x) => x.okt_id).filter(Boolean) as string[];
    });
    await leggIKo({ type: "bank-slett", org_id: orgId(c), okt_ider: okter, alt: true });
    return c.body(null, 204);
  });

  // --- Innbetalingene ------------------------------------------------------

  r.get("/banktransaksjoner", async (c) => {
    const s = z.enum(["se", "forslag", "uavklart", "koblet", "ignorert", "alle"]).catch("se").parse(c.req.query("status") ?? "se");
    const filter = s === "alle" ? "" : s === "se" ? "and t.status in ('forslag', 'uavklart')" : "and t.status = $2";
    return c.json(
      await bruk(c, async (db) => {
        await krev(c, db, "les");
        return {
          transaksjoner: await alle(
          db,
          `select t.id, t.konto, t.dato, t.belop, t.valuta, t.betaler, t.betaler_konto, t.melding, t.referanse, t.status,
                  t.faktura_id, t.grunn, t.behandlet, t.opprettet, f.fakturanummer, f.status as faktura_status,
                  coalesce(f.kunde ->> 'navn', k.navn) as kunde_navn, f.forfallsdato,
                  f.sum_inkl_mva - f.kreditert_belop - f.betalt_belop as utestaende,
                  b.navn as behandlet_av
             from faktura.banktransaksjoner t
             left join faktura.fakturaer f on f.id = t.faktura_id
             left join faktura.kunder k on k.id = f.kunde_id
             left join faktura.brukere b on b.id = t.behandlet_av
            where t.org_id = $1 ${filter}
            order by t.dato desc, t.opprettet desc
            limit 300`,
          s === "alle" || s === "se" ? [orgId(c)] : [orgId(c), s],
        ),
          antall: await antall(db, orgId(c)),
        };
      }),
    );
  });

  const id = (c: Context) => z.string().uuid().parse(c.req.param("id"));
  const iOrg = async (c: Context, db: Db) => {
    await krev(c, db, "bokfor");
    const t = await en(db, "select id from faktura.banktransaksjoner where id = $1 and org_id = $2", [id(c), orgId(c)]);
    if (!t) throw new ApiFeil(404, "Fant ikke innbetalingen");
  };

  r.post("/banktransaksjoner/:id/koble", async (c) => {
    const b = z.object({ faktura_id: z.string().uuid() }).parse(await c.req.json().catch(() => ({})));
    return c.json(
      await bruk(c, async (db) => {
        await iOrg(c, db);
        return en(db, "select * from faktura.koble_banktransaksjon($1, $2)", [id(c), b.faktura_id]);
      }),
    );
  });

  r.post("/banktransaksjoner/:id/ignorer", async (c) => {
    const b = z.object({ ignorer: z.boolean().default(true) }).parse(await c.req.json().catch(() => ({})));
    return c.json(
      await bruk(c, async (db) => {
        await iOrg(c, db);
        return en(db, "select * from faktura.ignorer_banktransaksjon($1, $2)", [id(c), b.ignorer]);
      }),
    );
  });

  // Be AI-en om et forslag for en uavklart innbetaling. Et forslag må bekreftes som før;
  // finner den ingen faktura, kommer forklaringen tilbake og ingenting endres.
  r.post("/banktransaksjoner/:id/ai", async (c) => {
    if (!aiPaa()) throw new ApiFeil(503, "AI er ikke satt opp");
    const kjor = <X>(fn: (db: Db) => Promise<X>) => somBruker<X>(c.get("bruker").id, fn);
    const t = await kjor(async (db) => {
      await iOrg(c, db);
      return en(db, "select id, dato, belop, valuta, betaler, betaler_konto, melding, referanse, status from faktura.banktransaksjoner where id = $1", [id(c)]);
    });
    if (t.status !== "uavklart") throw new ApiFeil(409, "Innbetalingen er allerede behandlet");
    if (t.valuta !== "NOK") throw new ApiFeil(400, "Bare innbetalinger i norske kroner kan registreres på fakturaer");
    const f = await foreslaFaktura(kjor, orgId(c), t);
    if (!f.faktura) return c.json({ transaksjon: null, grunn: f.grunn });
    const grunn = `AI${f.sikkerhet === "lav" ? " (usikker)" : ""}: ${f.grunn}`;
    const ny = await kjor((db) => en(db, "select * from faktura.foresla_banktransaksjon($1, $2, $3)", [id(c), f.faktura!.id, grunn]));
    return c.json({ transaksjon: ny, grunn });
  });

  r.post("/banktransaksjoner/:id/angre", async (c) =>
    c.json(
      await bruk(c, async (db) => {
        await iOrg(c, db);
        return en(db, "select * from faktura.angre_banktransaksjon($1)", [id(c)]);
      }),
    ),
  );

  return r;
}
