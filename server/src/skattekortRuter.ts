// Skattekort fra Skatteetaten (skattekort.ts): tilgangen under Innstillinger → Lønn og henting
// for hånd, og oppsettet hos plattformadministratoren (systemet i Altinns systemregister).
//
// Eier og administrator ber om tilgang (med totrinnsbekreftelse); workeren lager forespørselen i
// Altinn, og appen viser lenken dit til den er godkjent. Daglig leder (eller den som har
// tilgangsstyring i Altinn) godkjenner, og Altinn sender brukeren tilbake til appen, som ber
// workeren sjekke forespørselen. Regnskap ser statusen.
import { Hono, type Context } from "hono";
import { z } from "zod";
import { config } from "./config.js";
import { alle, en, somBetrodd, somBruker, type Db } from "./db.js";
import { ApiFeil } from "./feil.js";
import { krevMfa } from "./auth.js";
import { skattekortSattOpp, systemId } from "./maskinporten.js";
import { godkjentUrl, PAKKEBRUK, PAKKENAVN, TILGANGSPAKKE, tilgangspakker } from "./altinn.js";
import { leggIKo } from "./tjenester.js";

const orgId = (c: Context) => z.string().uuid().parse(c.req.param("org"));
const bruk = <T>(c: Context, fn: (db: Db) => Promise<T>) => somBruker<T>(c.get("bruker").id, fn);
const krev = (c: Context, db: Db, handling: string) => db.query("select faktura.krev($1, $2)", [orgId(c), handling]);
const iOslo = (del: "year" | "month") => Number(new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Oslo", [del]: "numeric" }).format(new Date()));
const iAar = () => iOslo("year");

type Tilgang = {
  status: "venter" | "ny" | "godkjent" | "avslatt" | "avvist" | "utlopt" | "feil";
  godkjenn_url: string | null;
  opprettet: string;
  oppdatert: string;
  sjekket: string | null;
  sist_hentet: string | null;
  siste_feil: string | null;
  // Tilgangspakkene systembrukeren har, og endringsforespørselen når systemet trenger flere (0077).
  pakker: string[];
  endring_status: string | null;
  endring_url: string | null;
  endring_feil: string | null;
};

const hentTilgang = (db: Db, org: string) =>
  en<Tilgang>(
    db,
    `select status, godkjenn_url, opprettet, oppdatert, sjekket, sist_hentet, siste_feil, pakker, endring_status, endring_url, endring_feil
       from faktura.skattekort_tilgang where org_id = $1`,
    [org],
  );

async function status(db: Db, org: string) {
  const aar = iAar();
  const tilgang = await hentTilgang(db, org);
  // De aktive ansatte (ikke rollehavere som ikke er ansatt): med fødselsnummer, med skattekortet
  // for året fra Skatteetaten, og uten fødselsnummer (kan ikke hentes).
  const antall = await en(
    db,
    `select count(*) filter (where har_fnr)::int as med_fnr,
            count(*) filter (where har_fnr and skattekort_kilde = 'skatteetaten' and skattekort_aar = $2)::int as fra_skatteetaten,
            count(*) filter (where not har_fnr)::int as uten_fnr
       from faktura.ansatte where org_id = $1 and aktiv and arbeidstaker`,
    [org, aar],
  );
  return {
    tilgjengelig: skattekortSattOpp(),
    miljo: config.skatteetatenMiljo,
    systemnavn: config.altinnSystemnavn,
    aar,
    tilgang: tilgang
      ? {
          ...tilgang,
          godkjenn_url: tilgang.status === "ny" ? tilgang.godkjenn_url : null,
          endring_url: tilgang.endring_status === "ny" ? tilgang.endring_url : null,
          // Tilgangspakkene systemet trenger nå og systembrukeren ikke har (be om å utvide tilgangen).
          mangler: tilgang.status === "godkjent" ? tilgangspakker().filter((p) => !tilgang.pakker.includes(p)).map((p) => PAKKENAVN[p] ?? p) : [],
          // Hva tilgangspakkene som mangler, brukes til (f.eks. «a-meldingen»).
          mangler_bruk: tilgang.status === "godkjent" ? tilgangspakker().filter((p) => !tilgang.pakker.includes(p)).map((p) => PAKKEBRUK[p] ?? p) : [],
          pakkenavn: tilgang.pakker.map((p) => PAKKENAVN[p] ?? p),
        }
      : null,
    antall,
  };
}

export function skattekortRuter() {
  const r = new Hono();

  r.get("/skattekort", async (c) =>
    c.json(
      await bruk(c, async (db) => {
        await krev(c, db, "personal_les");
        return status(db, orgId(c));
      }),
    ),
  );

  // Be om tilgang (på nytt): workeren lager forespørselen i Altinn.
  r.post("/skattekort/tilgang", async (c) => {
    krevMfa(c);
    if (!skattekortSattOpp()) throw new ApiFeil(503, "Henting av skattekort fra Skatteetaten er ikke satt opp ennå.");
    const s = await bruk(c, async (db) => {
      await db.query("select faktura.be_om_skattekorttilgang($1)", [orgId(c)]);
      return status(db, orgId(c));
    });
    await leggIKo({ type: "skattekort-tilgang", org_id: orgId(c) });
    return c.json(s);
  });

  // Sjekk forespørselen i Altinn nå (når brukeren kommer tilbake fra Altinn).
  r.post("/skattekort/sjekk", async (c) => {
    const t = await bruk(c, async (db) => {
      await krev(c, db, "personal_les");
      return hentTilgang(db, orgId(c));
    });
    const nylig = t?.sjekket && Date.now() - Date.parse(String(t.sjekket)) < 5000;
    if (t && (t.status === "ny" || t.status === "venter") && !nylig) await leggIKo({ type: "skattekort-status", org_id: orgId(c) });
    const endring = t?.status === "godkjent" && (t.endring_status === "ny" || t.endring_status === "venter");
    if (endring && !nylig) await leggIKo({ type: "altinn-endring", org_id: orgId(c) });
    return c.json({ ok: true, sjekkes: Boolean(t && (t.status === "ny" || t.status === "venter")) || endring });
  });

  // Utvid tilgangen i Altinn med tilgangspakkene systemet trenger nå (f.eks. «A-ordningen» for
  // a-meldingen): workeren lager endringsforespørselen, og daglig leder godkjenner den.
  r.post("/skattekort/utvid", async (c) => {
    krevMfa(c);
    const s = await bruk(c, async (db) => {
      await db.query("select faktura.be_om_utvidet_tilgang($1)", [orgId(c)]);
      return status(db, orgId(c));
    });
    await leggIKo({ type: "altinn-endring", org_id: orgId(c) });
    return c.json(s);
  });

  // Hent skattekortene til alle de ansatte nå (for året, eller neste år i desember).
  r.post("/skattekort/hent", async (c) => {
    const b = z.object({ aar: z.number().int().optional() }).parse(await c.req.json().catch(() => ({})));
    const aar = b.aar ?? iAar();
    if (aar !== iAar() && !(aar === iAar() + 1 && iOslo("month") === 12))
      throw new ApiFeil(400, "Skattekortene kan hentes for i år (og for neste år i desember).");
    const t = await bruk(c, async (db) => {
      await krev(c, db, "personal");
      return hentTilgang(db, orgId(c));
    });
    if (t?.status !== "godkjent") throw new ApiFeil(409, "Tilgangen til Skatteetaten er ikke godkjent i Altinn ennå.");
    await leggIKo({ type: "skattekort-hent", org_id: orgId(c), aar, kilde: "manuell" });
    return c.json({ ok: true, startet: true });
  });

  // Koble fra: appen henter ikke flere skattekort. Systemtilgangen fjernes i Altinn av kunden selv.
  r.delete("/skattekort/tilgang", async (c) => {
    await bruk(c, async (db) => {
      await krev(c, db, "personal");
      await db.query("delete from faktura.skattekort_tilgang where org_id = $1", [orgId(c)]);
    });
    return c.json({ ok: true });
  });

  return r;
}

// Plattformadministratoren: oppsettet (aldri nøkkelen) og systemet i Altinns systemregister.
export function skattekortAdminRuter() {
  const r = new Hono();
  r.get("/skattekort", async (c) =>
    c.json(
      await somBetrodd(c.get("bruker").id, async (db) => ({
        oppsett: {
          miljo: config.skatteetatenMiljo,
          klient_id: Boolean(config.maskinportenKlientId),
          nokkel_id: Boolean(config.maskinportenNokkelId),
          leverandor_orgnr: config.leverandorOrgnr,
          system_id: systemId(),
          systemnavn: config.altinnSystemnavn,
          tilgangspakke: TILGANGSPAKKE,
          tilgangspakker: tilgangspakker().map((p) => PAKKENAVN[p] ?? p),
          amelding: config.ameldingInnsending,
          tilbake_url: godkjentUrl(),
        },
        system: (await en(db, "select id, registrert, oppdatert, siste_feil from faktura.altinn_system where id = $1", [systemId()])) ?? null,
        organisasjoner: await alle(db, "select status, count(*)::int as antall from faktura.skattekort_tilgang group by status order by status"),
      })),
    ),
  );
  r.post("/skattekort/system", async (c) => {
    if (!skattekortSattOpp()) throw new ApiFeil(503, "Maskinporten-klienten er ikke satt opp (MASKINPORTEN_KLIENT_ID).");
    await leggIKo({ type: "altinn-system" });
    return c.json({ ok: true, startet: true });
  });
  return r;
}
