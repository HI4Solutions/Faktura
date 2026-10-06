// Innstillingen for EHF-sending: organisasjonen kobler til sin egen konto hos Recommand
// med nøkkel-ID og hemmelighet (Basic auth). Nøkkelen sjekkes mot Recommand med en gang,
// og selskapet med organisasjonens org.nr. må finnes på kontoen. Hemmeligheten krypteres
// med Cloud KMS; API-et kan bare kryptere, så den leses aldri tilbake herfra.
import { Hono, type Context } from "hono";
import { z } from "zod";
import { en, somBruker, type Db } from "./db.js";
import { ApiFeil } from "./feil.js";
import { krevMfa } from "./auth.js";
import { krypter } from "./kryptering.js";
import { finnSelskap, RecommandFeil } from "./recommand.js";

const orgId = (c: Context) => z.string().uuid().parse(c.req.param("org"));
const bruk = <T>(c: Context, fn: (db: Db) => Promise<T>) => somBruker<T>(c.get("bruker").id, fn);

// Det appen viser om koblingen (aldri hemmeligheten).
const status = (r: any) =>
  r
    ? {
        tilkoblet: r.status === "aktiv",
        leverandor: r.konfig?.leverandor ?? null,
        nokkel_id: r.konfig?.nokkel_id ?? null,
        selskap: r.konfig?.selskap_navn ?? null,
        orgnr: r.konfig?.orgnr ?? null,
        verifisert: r.konfig?.verifisert ?? null,
        tar_imot: r.konfig?.tar_imot ?? null,
        siste_feil: r.siste_feil,
        koblet: r.opprettet,
        oppdatert: r.oppdatert,
      }
    : { tilkoblet: false };

const hent = (db: Db, org: string) =>
  en(db, "select status, konfig, siste_feil, opprettet, oppdatert from faktura.integrasjoner where org_id = $1 and type = 'peppol'", [org]);

export function ehfRuter() {
  const r = new Hono();

  r.get("/ehf", async (c) => c.json(status(await bruk(c, (db) => hent(db, orgId(c))))));

  r.put("/ehf", async (c) => {
    krevMfa(c);
    const b = z
      .object({ nokkel_id: z.string().trim().min(3, "Mangler nøkkel-ID").max(200), hemmelighet: z.string().trim().min(8, "Mangler hemmeligheten").max(500) })
      .parse(await c.req.json().catch(() => ({})));
    const orgnr = await bruk(c, async (db) => {
      await db.query("select faktura.krev($1, 'admin')", [orgId(c)]);
      return (await en(db, "select orgnr from faktura.organisasjoner where id = $1", [orgId(c)]))?.orgnr as string | null;
    });
    if (!orgnr) throw new ApiFeil(400, "Legg inn organisasjonsnummeret under Innstillinger først. EHF sendes fra det.");

    let selskap;
    try {
      selskap = await finnSelskap({ nokkelId: b.nokkel_id, hemmelighet: b.hemmelighet }, orgnr);
    } catch (e) {
      const f = e as RecommandFeil;
      if (f.status === 401 || f.status === 403)
        throw new ApiFeil(400, "Recommand godtok ikke nøkkelen. Sjekk at du har limt inn nøkkel-ID og hemmelighet fra en nøkkel med Basic auth.");
      if (f.status === 0) throw new ApiFeil(503, "Fikk ikke kontakt med Recommand. Prøv igjen om litt.");
      throw new ApiFeil(502, `Recommand svarte med en feil: ${f.message}`);
    }
    if (!selskap)
      throw new ApiFeil(
        400,
        `Fant ikke selskapet med org.nr. ${orgnr} på Recommand-kontoen. Legg det inn hos Recommand med identifikatoren 0192:${orgnr}, eller bruk en nøkkel fra riktig konto.`,
      );

    const kryptert = await krypter(b.hemmelighet);
    const konfig = {
      leverandor: "recommand",
      nokkel_id: b.nokkel_id,
      selskap_id: selskap.id,
      selskap_navn: selskap.name,
      orgnr,
      verifisert: selskap.isVerified,
      tar_imot: selskap.isSmpRecipient,
    };
    // Ikke «on conflict … excluded»: API-et har ikke lov til å lese den krypterte kolonnen.
    const rad = await bruk(c, async (db) => {
      const r = await db.query(
        "update faktura.integrasjoner set status = 'aktiv', konfig = $2, hemmelighet_kryptert = $3, siste_feil = null where org_id = $1 and type = 'peppol'",
        [orgId(c), JSON.stringify(konfig), kryptert],
      );
      if (!r.rowCount)
        await db.query(
          "insert into faktura.integrasjoner (org_id, type, status, konfig, hemmelighet_kryptert, koblet_av) values ($1, 'peppol', 'aktiv', $2, $3, faktura.bruker_id())",
          [orgId(c), JSON.stringify(konfig), kryptert],
        );
      return hent(db, orgId(c));
    });
    return c.json(status(rad));
  });

  r.delete("/ehf", async (c) => {
    const n = await bruk(c, async (db) => {
      await db.query("select faktura.krev($1, 'admin')", [orgId(c)]);
      return (await db.query("delete from faktura.integrasjoner where org_id = $1 and type = 'peppol'", [orgId(c)])).rowCount;
    });
    if (!n) throw new ApiFeil(404, "EHF-sending er ikke koblet til");
    return c.body(null, 204);
  });

  return r;
}
