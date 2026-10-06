// Innbetalinger fra banken (Enable Banking): koblingen under Innstillinger → Betaling, og
// listen over innbetalinger som kobles til fakturaene.
//
// Koblingen: organisasjonen registrerer sin egen applikasjon hos Enable Banking og limer
// inn applikasjons-ID-en og den private nøkkelen. API-et sjekker nøkkelen og starter
// BankID-innloggingen med en gang (nøkkelen er ennå ikke kryptert), og krypterer den
// med Cloud KMS. Deretter er det bare workeren som kan bruke nøkkelen: den fullfører
// koblingen, fornyer den og henter innbetalingene. Appen venter på svaret ved å spørre
// etter statusen.
import { Hono, type Context } from "hono";
import { z } from "zod";
import { alle, en, somBruker, type Db } from "./db.js";
import { ApiFeil } from "./feil.js";
import { krevMfa } from "./auth.js";
import { krypter } from "./kryptering.js";
import { BankFeil, finnBank, gyldigTil, hentApplikasjon, hentBanker, nokkelFeil, startAutorisering, type BankNokkel } from "./enableBanking.js";
import { nyState, tilbakeUrl, type BankKonfig } from "./bank.js";
import { leggIKo } from "./tjenester.js";

const orgId = (c: Context) => z.string().uuid().parse(c.req.param("org"));
const bruk = <T>(c: Context, fn: (db: Db) => Promise<T>) => somBruker<T>(c.get("bruker").id, fn);
const krev = (c: Context, db: Db, handling: string) => db.query("select faktura.krev($1, $2)", [orgId(c), handling]);

const hent = (db: Db, org: string) =>
  en(db, "select status, konfig, siste_feil, opprettet, oppdatert from faktura.integrasjoner where org_id = $1 and type = 'bank'", [org]);

// Det appen viser om koblingen (aldri nøkkelen).
function status(r: any, antall: Record<string, number>) {
  const k: Partial<BankKonfig> = r?.konfig ?? {};
  const aktiv = r && r.status !== "frakoblet";
  // Adressen workeren lagde til BankID, så lenge den er fersk.
  const fersk = k.auth_url && k.auth_tid && Date.now() - Date.parse(k.auth_tid) < 10 * 60_000;
  return {
    tilkoblet: Boolean(aktiv && r.status === "aktiv" && k.okt_id),
    status: aktiv ? r.status : null, // aktiv, feil (må kobles til på nytt)
    venter_bankid: Boolean(aktiv && !k.okt_id),
    app_id: aktiv ? (k.app_id ?? null) : null,
    app_navn: aktiv ? (k.app_navn ?? null) : null,
    bank: aktiv ? (k.bank ?? null) : null,
    psu_type: aktiv ? (k.psu_type ?? null) : null,
    kontoer: aktiv ? (k.kontoer ?? []).map(({ uid, kontonr, navn, valgt }) => ({ uid, kontonr, navn, valgt })) : [],
    gyldig_til: aktiv ? (k.gyldig_til ?? null) : null,
    sist_hentet: aktiv ? (k.sist_hentet ?? null) : null,
    siste_feil: aktiv ? (r.siste_feil ?? null) : null,
    auth_url: aktiv && fersk ? k.auth_url : null,
    auth_tid: aktiv ? (k.auth_tid ?? null) : null,
    oppdatert: r?.oppdatert ?? null,
    tilbake_url: tilbakeUrl(),
    antall,
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
  if (f.status === 0) return new ApiFeil(503, "Fikk ikke kontakt med Enable Banking. Prøv igjen om litt.");
  return new ApiFeil(502, `Enable Banking svarte med en feil: ${f.message}`);
}

export function bankRuter() {
  const r = new Hono();

  r.get("/bank", async (c) =>
    c.json(
      await bruk(c, async (db) => {
        await krev(c, db, "les");
        return status(await hent(db, orgId(c)), await antall(db, orgId(c)));
      }),
    ),
  );

  // Koble til: sjekk nøkkelen og banken, lagre kryptert, og send brukeren til BankID.
  r.put("/bank", async (c) => {
    krevMfa(c);
    const b = z
      .object({
        app_id: z.string().trim().min(8, "Mangler applikasjons-ID-en").max(100),
        privat_nokkel: z.string().trim().min(100, "Mangler den private nøkkelen").max(20_000),
        bank: z.string().trim().min(2, "Velg banken").max(100),
        psu_type: z.enum(["business", "personal"]),
      })
      .parse(await c.req.json().catch(() => ({})));
    await bruk(c, (db) => krev(c, db, "admin"));
    const feil = nokkelFeil(b.privat_nokkel);
    if (feil) throw new ApiFeil(400, feil);
    const n: BankNokkel = { appId: b.app_id, privatNokkel: b.privat_nokkel };

    let app: any;
    let banker;
    try {
      app = await hentApplikasjon(n);
      banker = await hentBanker(n, "NO");
    } catch (e) {
      throw fraEnableBanking(e);
    }
    // Adressen brukeren sendes tilbake til, må være lagt inn i applikasjonen.
    const adresser: unknown = app?.redirect_urls;
    if (Array.isArray(adresser) && adresser.length && !adresser.includes(tilbakeUrl()))
      throw new ApiFeil(400, `Legg inn ${tilbakeUrl()} som «Allowed redirect URL» i applikasjonen hos Enable Banking, og prøv igjen.`);
    const bank = finnBank(banker, b.bank);
    if (!bank) {
      const forslag = banker.filter((x) => x.name.toLowerCase().includes(b.bank.toLowerCase().split(" ")[0])).map((x) => x.name);
      throw new ApiFeil(400, `Fant ikke banken «${b.bank}» hos Enable Banking.${forslag.length ? ` Mente du ${forslag.slice(0, 5).join(", ")}?` : ""}`);
    }
    if (bank.psu_types?.length && !bank.psu_types.includes(b.psu_type))
      throw new ApiFeil(400, `${bank.name} støtter ikke ${b.psu_type === "business" ? "bedriftskontoer" : "privatkontoer"} gjennom Enable Banking.`);

    const state = nyState(orgId(c));
    const gyldig = gyldigTil(bank.maximum_consent_validity);
    let url: string;
    try {
      url = await startAutorisering(n, { bank: bank.name, land: "NO", psuType: b.psu_type, gyldigTil: gyldig, state, redirect: tilbakeUrl() });
    } catch (e) {
      throw fraEnableBanking(e);
    }

    const kryptert = await krypter(b.privat_nokkel);
    const konfig: BankKonfig = {
      leverandor: "enablebanking",
      app_id: b.app_id,
      app_navn: typeof app?.name === "string" ? app.name : null,
      bank: bank.name,
      land: "NO",
      psu_type: b.psu_type,
      maks_sek: bank.maximum_consent_validity ?? null,
      state,
      auth_url: null,
      auth_tid: new Date().toISOString(),
      auth_gyldig_til: gyldig.toISOString(),
      okt_id: null,
      gyldig_til: null,
      kontoer: [],
      hent_fra: null,
      sist_hentet: null,
      varslet_utlop: null,
    };
    // Ikke «on conflict … excluded»: API-et har ikke lov til å lese den krypterte kolonnen.
    const rad = await bruk(c, async (db) => {
      const u = await db.query(
        "update faktura.integrasjoner set status = 'aktiv', konfig = $2, hemmelighet_kryptert = $3, siste_feil = null where org_id = $1 and type = 'bank'",
        [orgId(c), JSON.stringify(konfig), kryptert],
      );
      if (!u.rowCount)
        await db.query(
          "insert into faktura.integrasjoner (org_id, type, status, konfig, hemmelighet_kryptert, koblet_av) values ($1, 'bank', 'aktiv', $2, $3, faktura.bruker_id())",
          [orgId(c), JSON.stringify(konfig), kryptert],
        );
      return hent(db, orgId(c));
    });
    return c.json({ ...status(rad, {}), url });
  });

  // Forny samtykket (eller fullfør en kobling som ble avbrutt): workeren lager en ny
  // BankID-adresse, og appen venter på den.
  r.post("/bank/forny", async (c) => {
    const k = await bruk(c, async (db) => {
      await krev(c, db, "admin");
      const k = await hent(db, orgId(c));
      if (!k || k.status === "frakoblet") throw new ApiFeil(404, "Banken er ikke koblet til");
      await db.query("update faktura.integrasjoner set konfig = konfig || $2::jsonb where org_id = $1 and type = 'bank'", [
        orgId(c),
        JSON.stringify({ auth_url: null, auth_tid: null }),
      ]);
      return k;
    });
    await leggIKo({ type: "bank-auth", org_id: orgId(c) });
    return c.json({ ok: true, bestilt: new Date().toISOString(), bank: k.konfig?.bank ?? null }, 202);
  });

  // Tilbake fra banken med koden: workeren bytter den mot tilgang til kontoene.
  r.post("/bank/fullfor", async (c) => {
    const b = z.object({ code: z.string().min(1).max(4000), state: z.string().min(10).max(200) }).parse(await c.req.json().catch(() => ({})));
    await bruk(c, async (db) => {
      await krev(c, db, "admin");
      const k = await hent(db, orgId(c));
      if (!k || k.status === "frakoblet") throw new ApiFeil(404, "Banken er ikke koblet til");
      if (!k.konfig?.state || k.konfig.state !== b.state) throw new ApiFeil(400, "Innloggingen hos banken passer ikke med denne koblingen. Start på nytt.");
      // Engangs: samme svar fra banken kan ikke brukes to ganger.
      await db.query("update faktura.integrasjoner set konfig = konfig || $2::jsonb, siste_feil = null where org_id = $1 and type = 'bank'", [
        orgId(c),
        JSON.stringify({ state: null }),
      ]);
    });
    await leggIKo({ type: "bank-okt", org_id: orgId(c), kode: b.code });
    return c.json({ ok: true }, 202);
  });

  // Hvilke kontoer innbetalingene hentes fra.
  r.put("/bank/kontoer", async (c) => {
    const b = z.object({ valgte: z.array(z.string().max(200)).max(50) }).parse(await c.req.json().catch(() => ({})));
    const rad = await bruk(c, async (db) => {
      await krev(c, db, "admin");
      const k = await hent(db, orgId(c));
      if (!k || k.status === "frakoblet") throw new ApiFeil(404, "Banken er ikke koblet til");
      const kontoer = (k.konfig?.kontoer ?? []).map((x: any) => ({ ...x, valgt: b.valgte.includes(x.uid) }));
      if (!kontoer.some((x: any) => x.valgt)) throw new ApiFeil(400, "Velg minst én konto");
      await db.query("update faktura.integrasjoner set konfig = konfig || $2::jsonb where org_id = $1 and type = 'bank'", [orgId(c), JSON.stringify({ kontoer })]);
      return hent(db, orgId(c));
    });
    return c.json(status(rad, await bruk(c, (db) => antall(db, orgId(c)))));
  });

  // Hent nå. Brukeren er til stede, så det teller ikke mot bankens grense for henting.
  r.post("/bank/hent", async (c) => {
    await bruk(c, async (db) => {
      await krev(c, db, "bokfor");
      const k = await hent(db, orgId(c));
      if (!k || k.status !== "aktiv" || !k.konfig?.okt_id) throw new ApiFeil(409, "Banken er ikke koblet til");
    });
    const ip = (c.req.header("x-forwarded-for") ?? "").split(",")[0].trim() || "0.0.0.0";
    await leggIKo({ type: "bank-hent", org_id: orgId(c), psu: { ip, agent: (c.req.header("user-agent") ?? "HI4 Faktura").slice(0, 500) } });
    return c.json({ ok: true }, 202);
  });

  r.delete("/bank", async (c) => {
    const n = await bruk(c, async (db) => {
      await krev(c, db, "admin");
      return (await db.query("update faktura.integrasjoner set status = 'frakoblet' where org_id = $1 and type = 'bank' and status <> 'frakoblet'", [orgId(c)])).rowCount;
    });
    if (!n) throw new ApiFeil(404, "Banken er ikke koblet til");
    await leggIKo({ type: "bank-slett", org_id: orgId(c) });
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
