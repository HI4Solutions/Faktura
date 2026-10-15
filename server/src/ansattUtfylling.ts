// Den ansatte fyller ut opplysningene sine selv (0113_ansatte_enklere.sql, docs/ansatte.md):
// navn, adresse, telefon, fødselsnummer, kontonummer og nærmeste pårørende sendes inn fra Min
// side, og lederen (Personal) godkjenner dem (de skrives på den ansatte, og skattekortet hentes
// når fødselsnummeret er med) eller avviser dem med en grunn. Lederen ber om det med
// invitasjonen (POST /ansatte/:id/inviter med utfylling, ansatte.ts).
//
// Fødselsnummeret krypteres her (API-et kan bare kryptere) og vises aldri igjen.
import { Hono, type Context } from "hono";
import { z } from "zod";
import { en, somBruker, type Db } from "./db.js";
import { ApiFeil } from "./feil.js";
import { fodselsdato } from "./fnr.js";
import { krypter } from "./kryptering.js";
import { iDag } from "./regler.js";
import { leggIKo } from "./tjenester.js";
import { ANSATT, ansattSkjema, hentSkattekortFor, tekst, varslePersonal } from "./ansatte.js";

const uuid = z.string().uuid();
const orgId = (c: Context) => uuid.parse(c.req.param("org"));
const id = (c: Context) => uuid.parse(c.req.param("id"));
const bruk = <T>(c: Context, fn: (db: Db) => Promise<T>) => somBruker<T>(c.get("bruker").id, fn);

// Feltene den ansatte kan fylle ut (som i ansattskjemaet; tomme felt endrer ingenting).
const f = ansattSkjema.shape;
export const utfyllingSkjema = z.object({
  fornavn: f.fornavn.optional(),
  etternavn: f.etternavn.optional(),
  telefon: f.telefon,
  adresse: f.adresse,
  postnr: f.postnr,
  poststed: f.poststed,
  fodselsdato: f.fodselsdato,
  fnr: f.fnr,
  kontonr: f.kontonr,
  parorende_navn: f.parorende_navn,
  parorende_telefon: f.parorende_telefon,
});

// Det som skal skrives på den ansatte (tekstene), uten fødselsnummeret. Fødselsdatoen følger
// fødselsnummeret.
export function utfyllingFelt(b: z.infer<typeof utfyllingSkjema>): Record<string, string> {
  const { fnr, ...resten } = b;
  const felt: Record<string, string> = {};
  for (const [k, v] of Object.entries(resten)) if (typeof v === "string" && v !== "") felt[k] = v;
  if (fnr) felt.fodselsdato = fodselsdato(fnr)!;
  if (felt.fodselsdato && felt.fodselsdato > iDag()) throw new ApiFeil(400, "Fødselsdatoen kan ikke være fram i tid");
  return felt;
}

const avvisSkjema = z.object({
  grunn: tekst(500, "Grunnen").min(1, "Skriv hva som må rettes, så den ansatte vet det"),
});

type Ansattinfo = { navn: string; bruker_id: string | null };
const ansattinfo = (db: Db, org: string, ansatt: string) =>
  en<Ansattinfo>(db, "select fornavn || ' ' || etternavn as navn, bruker_id from faktura.ansatte where org_id = $1 and id = $2", [org, ansatt]);

// Varsel til den ansatte (når lederen har godkjent eller avvist).
async function varsleAnsatt(org: string, bruker: string | null, unntatt: string, tittel: string, tekst: string, ansatt: string) {
  if (!bruker || bruker === unntatt) return;
  await leggIKo({ type: "varsel", varsel: { hendelse: "ansatte", org_id: org, bruker_ider: [bruker], tittel, tekst, url: "/meg", tag: `utfylling-${ansatt}` } }).catch(
    () => undefined,
  );
}

export function utfyllingRuter() {
  const r = new Hono();

  // Den ansatte sender inn opplysningene sine (erstatter det som er sendt før). Lederne får varsel.
  r.post("/ansatte/meg/utfylling", async (c) => {
    const b = utfyllingSkjema.parse(await c.req.json().catch(() => ({})));
    const felt = utfyllingFelt(b);
    const kryptert = b.fnr ? await krypter(b.fnr) : null;
    const org = orgId(c);
    const { a, info } = await bruk(c, async (db) => {
      const ansatt = (await en<{ id: string }>(db, "select faktura.lever_utfylling($1, $2, $3) as id", [org, JSON.stringify(felt), kryptert]))!.id;
      return { a: (await en<{ id: string }>(db, `${ANSATT} where a.org_id = $1 and a.id = $2`, [org, ansatt]))!, info: (await ansattinfo(db, org, ansatt))! };
    });
    await varslePersonal(
      org,
      c.get("bruker").id,
      "ansatte",
      "Opplysninger fra en ansatt",
      `${info.navn} har fylt ut opplysningene sine. Se over og godkjenn dem.`,
      `/ansatte?ansatt=${a.id}`,
      `utfylling-${a.id}`,
    ).catch(() => undefined);
    return c.json(a);
  });

  // Lederen godkjenner: opplysningene skrives på den ansatte. Med fødselsnummeret hentes
  // skattekortet (med godkjent tilgang til Skatteetaten).
  r.post("/ansatte/:id/utfylling/godkjenn", async (c) => {
    const org = orgId(c);
    const { medFnr, a, info } = await bruk(c, async (db) => {
      const medFnr = (await en<{ f: boolean }>(db, "select faktura.godkjenn_utfylling($1, $2) as f", [org, id(c)]))!.f;
      return { medFnr, a: await en(db, `${ANSATT} where a.org_id = $1 and a.id = $2`, [org, id(c)]), info: await ansattinfo(db, org, id(c)) };
    });
    if (medFnr) await hentSkattekortFor(c, [id(c)]);
    await varsleAnsatt(org, info?.bruker_id ?? null, c.get("bruker").id, "Opplysningene dine er godkjent", "Opplysningene du sendte inn, er lagt inn.", id(c));
    return c.json(a);
  });

  // Lederen avviser med en grunn; den ansatte ser den på Min side og kan sende på nytt.
  r.post("/ansatte/:id/utfylling/avvis", async (c) => {
    const { grunn } = avvisSkjema.parse(await c.req.json().catch(() => ({})));
    const org = orgId(c);
    const { a, info } = await bruk(c, async (db) => {
      await db.query("select faktura.avvis_utfylling($1, $2, $3)", [org, id(c), grunn]);
      return { a: await en(db, `${ANSATT} where a.org_id = $1 and a.id = $2`, [org, id(c)]), info: await ansattinfo(db, org, id(c)) };
    });
    await varsleAnsatt(org, info?.bruker_id ?? null, c.get("bruker").id, "Opplysningene dine må rettes", `«${grunn}» Rett dem og send på nytt under Min side.`, id(c));
    return c.json(a);
  });

  return r;
}
