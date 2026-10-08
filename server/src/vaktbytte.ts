// Vaktbytte (0060_vaktbytte.sql): den ansatte gir bort eller bytter en vakt (eller en fast
// arbeidsdag) med en kollega med samme rolle; kollegaen tar den, bytter eller sier nei takk, og eier
// eller administrator godkjenner (etter innstillingen under Ansatte og timer). Hvem som ser og kan
// gjøre hva, og selve byttet (vaktene, tavla og fri på faste dager), ligger i databasefunksjonene.
// Her er rutene, varslene, og advarslene etter arbeidsmiljøloven byttet gir, for den som godkjenner.
import { Hono, type Context } from "hono";
import { z } from "zod";
import { alle, en, somBruker, somSystem, type Db } from "./db.js";
import { ApiFeil } from "./feil.js";
import { uke, type Regler } from "./arbeidstid.js";
import { advarsler, type Ansettelse, type PlanVakt } from "./vaktregler.js";
import { datoS, regler, tekst, valgfri, varslePersonal } from "./ansatte.js";
import { leggIKo } from "./tjenester.js";
import { iDag } from "./regler.js";

const uuid = z.string().uuid();
const orgId = (c: Context) => uuid.parse(c.req.param("org"));
const id = (c: Context) => uuid.parse(c.req.param("id"));
const bruk = <T>(c: Context, fn: (db: Db) => Promise<T>) => somBruker<T>(c.get("bruker").id, fn);

const leggTilDager = (iso: string, n: number) => new Date(Date.parse(`${iso}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const dagFormat = new Intl.DateTimeFormat("nb-NO", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
const dag = (iso: string) => dagFormat.format(new Date(`${iso}T12:00:00Z`));

export type Bytte = {
  id: string;
  status: "tilbudt" | "akseptert" | "godkjent" | "avslatt" | "avvist" | "trukket" | "utgatt";
  fra_ansatt: string;
  fra_navn: string;
  til_ansatt: string | null;
  til_navn: string | null;
  tatt_av: string | null;
  tatt_av_navn: string | null;
  vakt_id: string;
  dato: string;
  fra: string;
  til: string;
  timer: number;
  oppgave: string | null;
  mot_vakt_id: string | null;
  mot_dato: string | null;
  mot_fra: string | null;
  mot_til: string | null;
  mot_timer: number | null;
  mot_oppgave: string | null;
  melding: string | null;
  grunn: string | null;
  opprettet: string;
  svart_at: string | null;
  behandlet_at: string | null;
  behandlet_av_navn: string | null;
  hindring: string | null; // hva som hindrer den innloggede i å ta vakten
};

// Hindringene (fra vaktbytte_hindring) for den innloggede selv, og for en kollega (der sies bare
// at det er en annen vakt; fraværet er bare for eier, administrator og den ansatte selv).
const SELV: Record<string, string> = {
  overlapp: "Du har en annen vakt som overlapper",
  borte: "Du er borte denne dagen",
  ikke_ansatt: "Du er ikke ansatt denne dagen",
  ikke_aktiv: "Du er ikke aktiv",
};
const selv = (kode: string | null) => (kode ? (SELV[kode] ?? "Du kan ikke ta vakten") : null);
const kollega = (kode: string | null) => (!kode ? null : kode === "overlapp" ? "Har en annen vakt som overlapper" : "Kan ikke ta vakten denne dagen");

const tid = (d: string, fra: string, til: string) => `${dag(d)} ${fra}–${til}`;
const vaktTid = (b: Bytte) => tid(b.dato, b.fra, b.til);
const motTid = (b: Bytte) => (b.mot_dato ? tid(b.mot_dato, b.mot_fra!, b.mot_til!) : "");
const fornavn = (navn: string | null) => (navn ?? "").split(" ")[0] || "En kollega";

const LISTE = "select * from faktura.vaktbytte_liste($1)";
const enBytte = async (db: Db, org: string, bytte: string) => (await alle<Bytte>(db, `${LISTE} where id = $2`, [org, bytte]))[0];

// --- Varsler ------------------------------------------------------------------------

type Varsel = { bruker_ider: string[]; tittel: string; tekst: string; url: string };

async function send(org: string, bytte: Bytte, varsler: Varsel[]) {
  for (const v of varsler)
    if (v.bruker_ider.length)
      await leggIKo({ type: "varsel", varsel: { hendelse: "vakter", org_id: org, bruker_ider: v.bruker_ider, tittel: v.tittel, tekst: v.tekst, url: v.url, tag: `vaktbytte-${bytte.id}` } });
}

// Innloggingen til de ansatte (uten den som selv gjorde det). Som system: den ansatte ser ikke
// kollegaenes ansattrad.
async function innlogging(org: string, ansatte: (string | null)[], unntatt: string) {
  const ider = ansatte.filter(Boolean) as string[];
  if (!ider.length) return [];
  const rader = await somSystem((db) =>
    alle<{ bruker_id: string }>(
      db,
      `select a.bruker_id from faktura.ansatte a join faktura.medlemmer m on m.org_id = a.org_id and m.bruker_id = a.bruker_id
        where a.org_id = $1 and a.id = any($2::uuid[]) and a.bruker_id <> $3`,
      [org, ider, unntatt],
    ),
  );
  return rader.map((r) => r.bruker_id);
}

// Et åpent tilbud går til kollegaene med samme rolle som kan ta vakten.
async function kanTa(org: string, b: Bytte, unntatt: string) {
  const rader = await somSystem((db) =>
    alle<{ bruker_id: string }>(
      db,
      `select a.bruker_id from faktura.ansatte a
        where a.org_id = $1 and a.bruker_id <> $6 and faktura.vaktbytte_kollega($1, $2, a.id)
          and faktura.vaktbytte_hindring($1, $3::date, $4::time, $5::time, a.id, null, null) is null`,
      [org, b.fra_ansatt, b.dato, b.fra, b.til, unntatt],
    ),
  );
  return rader.map((r) => r.bruker_id);
}

const melding = (b: Bytte) => (b.melding ? ` «${b.melding}»` : "");

async function varsleTilbud(org: string, b: Bytte, bruker: string) {
  if (b.til_ansatt)
    await send(org, b, [
      {
        bruker_ider: await innlogging(org, [b.til_ansatt], bruker),
        tittel: b.mot_vakt_id ? "Vil du bytte vakt?" : "Vil du ta en vakt?",
        tekst: b.mot_vakt_id
          ? `${b.fra_navn} vil bytte vakten ${vaktTid(b)} mot din ${motTid(b)}.${melding(b)}`
          : `${b.fra_navn} vil gi deg vakten ${vaktTid(b)}.${melding(b)}`,
        url: "/vakter?fane=bytter",
      },
    ]);
  else
    await send(org, b, [
      {
        bruker_ider: await kanTa(org, b, bruker),
        tittel: `Ledig vakt fra ${fornavn(b.fra_navn)}`,
        tekst: `${b.fra_navn} gir bort vakten ${vaktTid(b)}. Trykk for å ta den.${melding(b)}`,
        url: "/vakter?fane=ledige",
      },
    ]);
}

// --- Advarsler for den som godkjenner -----------------------------------------------

// Advarslene etter arbeidsmiljøloven (hviletid, overtid) som byttet gir de to: vaktene deres rundt
// dagene, før og etter byttet, og det som er nytt etter. Vakter de er borte fra, teller ikke.
async function advarslerEtterBytte(db: Db, org: string, bytter: Bytte[], r: Regler) {
  const ut = new Map<string, string[]>();
  if (!bytter.length) return ut;
  const ansettelser = new Map(
    (await alle<Ansettelse & { id: string }>(db, "select id, ansatt_fra, ansatt_til, aktiv, arbeidstaker from faktura.ansatte where org_id = $1", [org])).map((a) => [a.id, a]),
  );
  for (const b of bytter) {
    if (!b.tatt_av) continue;
    const datoer = [b.dato, b.mot_dato].filter(Boolean).sort() as string[];
    const navn = new Map([
      [b.fra_ansatt, b.fra_navn],
      [b.tatt_av, b.tatt_av_navn ?? ""],
    ]);
    const foer = await alle<PlanVakt>(
      db,
      `select v.id, v.ansatt_id, v.dato, to_char(v.fra, 'HH24:MI') as fra, to_char(v.til, 'HH24:MI') as til, v.timer
         from faktura.vakter v
        where v.org_id = $1 and v.ansatt_id = any($2::uuid[]) and v.dato between $3 and $4
          and not exists (select 1 from faktura.fravaer f where f.org_id = v.org_id and f.ansatt_id = v.ansatt_id and v.dato between f.fra and f.til)
        order by v.dato, v.fra`,
      [org, [b.fra_ansatt, b.tatt_av], leggTilDager(uke(datoer[0]!).fra, -1), leggTilDager(uke(datoer.at(-1)!).til, 1)],
    );
    const etter = foer.map((v) => (v.id === b.vakt_id ? { ...v, ansatt_id: b.tatt_av } : v.id === b.mot_vakt_id ? { ...v, ansatt_id: b.fra_ansatt } : v));
    const a = advarsler(foer, r, ansettelser);
    const e = advarsler(etter, r, ansettelser);
    const nye: string[] = [];
    for (const v of etter) {
      const flyttet = v.id === b.vakt_id || v.id === b.mot_vakt_id;
      for (const t of e.perVakt.get(v.id) ?? [])
        if (flyttet || !(a.perVakt.get(v.id) ?? []).includes(t)) nye.push(`${navn.get(v.ansatt_id!)}, ${dag(v.dato)}: ${t}`);
    }
    for (const [k, liste] of e.perUke) {
      const [ansatt, mandag] = k.split(":") as [string, string];
      for (const t of liste) if (!(a.perUke.get(k) ?? []).includes(t)) nye.push(`${navn.get(ansatt)}, uke ${uke(mandag).uke}: ${t}`);
    }
    ut.set(b.id, [...new Set(nye)]);
  }
  return ut;
}

// --- Rutene -------------------------------------------------------------------------

const tilbudSkjema = z
  .object({
    vakt_id: uuid.optional(),
    dato: datoS.optional(), // en fast arbeidsdag uten vakt
    til_ansatt: uuid.nullable().optional(), // null: alle med samme rolle
    mot_vakt_id: uuid.nullable().optional(), // et bytte: kollegaens vakt
    mot_dato: datoS.nullable().optional(), // eller kollegaens faste arbeidsdag
    melding: valgfri(tekst(300, "Meldingen")),
  })
  .refine((b) => !b.vakt_id !== !b.dato, "Velg vakten du vil bytte");

export function vaktbytteRuter() {
  const r = new Hono();

  // Byttene den innloggede ser, og innstillingen. Den som godkjenner, får advarslene byttene som
  // venter, gir.
  r.get("/vaktbytter", async (c) =>
    c.json(
      await bruk(c, async (db) => {
        const oppsett = await regler(db, orgId(c));
        const bytter = await alle<Bytte>(db, LISTE, [orgId(c)]);
        const leder = (await en<{ k: boolean }>(db, "select faktura.kan($1, 'personal_les') as k", [orgId(c)]))!.k;
        const nye = leder ? await advarslerEtterBytte(db, orgId(c), bytter.filter((b) => b.status === "akseptert"), oppsett) : new Map<string, string[]>();
        return {
          innstilling: oppsett.vaktbytte,
          bytter: bytter.map((b) => ({ ...b, hindring: selv(b.hindring), advarsler: nye.get(b.id) ?? [] })),
        };
      }),
    ),
  );

  // Hvem vakten (eller den faste arbeidsdagen) kan gis til, og vaktene den kan byttes mot de neste
  // åtte ukene.
  r.get("/vaktbytter/muligheter", async (c) => {
    const q = z
      .object({ vakt: uuid.optional(), dato: datoS.optional() })
      .refine((x) => !x.vakt !== !x.dato, "Velg vakten du vil bytte")
      .parse(c.req.query());
    return c.json(
      await bruk(c, async (db) => {
        const fra = iDag();
        const kolleger = await alle<{ ansatt_id: string; navn: string; hindring: string | null }>(db, "select * from faktura.vaktbytte_kolleger($1, $2, $3)", [
          orgId(c),
          q.vakt ?? null,
          q.dato ?? null,
        ]);
        const vakter = await alle<{
          vakt_id: string | null;
          ansatt_id: string;
          navn: string;
          dato: string;
          fra: string;
          til: string;
          timer: number;
          oppgave: string | null;
          hel_dag: boolean;
          hindring_meg: string | null;
          hindring_annen: string | null;
        }>(db, "select * from faktura.vaktbytte_kandidater($1, $2, $3, $4, $5)", [orgId(c), q.vakt ?? null, q.dato ?? null, fra, leggTilDager(fra, 55)]);
        return {
          kolleger: kolleger.map((k) => ({ ...k, hindring: kollega(k.hindring) })),
          vakter: vakter.map(({ hindring_meg, hindring_annen, ...v }) => ({ ...v, hindring: selv(hindring_meg) ?? kollega(hindring_annen) })),
        };
      }),
    );
  });

  // Tilby vakten: til en kollega, til alle med samme rolle, eller som et bytte.
  r.post("/vaktbytter", async (c) => {
    const b = tilbudSkjema.parse(await c.req.json().catch(() => ({})));
    if ((b.mot_vakt_id || b.mot_dato) && !b.til_ansatt) throw new ApiFeil(400, "Velg hvem du vil bytte med");
    const bytte = await bruk(c, async (db) => {
      const ny = await en<{ id: string }>(db, "select (faktura.tilby_vaktbytte($1, $2, $3, $4, $5, $6, $7)).id as id", [
        orgId(c),
        b.vakt_id ?? null,
        b.dato ?? null,
        b.til_ansatt ?? null,
        b.mot_vakt_id ?? null,
        b.mot_dato ?? null,
        b.melding ?? null,
      ]);
      return (await enBytte(db, orgId(c), ny!.id))!;
    });
    await varsleTilbud(orgId(c), bytte, c.get("bruker").id);
    return c.json(bytte, 201);
  });

  // Svar: ta vakten (eller bytt), eller nei takk (etter at den er tatt: angre).
  r.post("/vaktbytter/:id/svar", async (c) => {
    const s = z.object({ ja: z.boolean({ error: "Svar ja eller nei" }) }).parse(await c.req.json().catch(() => ({})));
    const bruker = c.get("bruker").id;
    const { foer, etter } = await bruk(c, async (db) => {
      const foer = await enBytte(db, orgId(c), id(c));
      await db.query("select faktura.svar_vaktbytte($1, $2, $3)", [orgId(c), id(c), s.ja]);
      return { foer, etter: (await enBytte(db, orgId(c), id(c)))! };
    });
    const b = etter;
    const giver = await innlogging(orgId(c), [b.fra_ansatt], bruker);
    if (b.status === "akseptert") {
      await send(orgId(c), b, [
        {
          bruker_ider: giver,
          tittel: b.mot_vakt_id ? "Ja til bytte" : "Vakten din er tatt",
          tekst: b.mot_vakt_id
            ? `${b.tatt_av_navn} vil bytte ${motTid(b)} mot vakten din ${vaktTid(b)}. Byttet venter på godkjenning.`
            : `${b.tatt_av_navn} tar vakten din ${vaktTid(b)}. Byttet venter på godkjenning.`,
          url: "/vakter?fane=bytter",
        },
      ]);
      await varslePersonal(
        orgId(c),
        bruker,
        "vakter",
        "Vaktbytte til godkjenning",
        b.mot_vakt_id
          ? `${b.fra_navn} og ${b.tatt_av_navn} vil bytte ${vaktTid(b)} og ${motTid(b)}.`
          : `${b.tatt_av_navn} vil ta vakten til ${b.fra_navn} ${vaktTid(b)}.`,
        "/vakter?fane=bytter",
        `vaktbytte-${b.id}`,
      );
    } else if (b.status === "godkjent") {
      await send(orgId(c), b, [
        {
          bruker_ider: giver,
          tittel: b.mot_vakt_id ? "Vakten er byttet" : "Vakten din er tatt",
          tekst: b.mot_vakt_id ? `Du har nå ${motTid(b)} i stedet for ${vaktTid(b)} (byttet med ${b.tatt_av_navn}).` : `${b.tatt_av_navn} tok vakten din ${vaktTid(b)}.`,
          url: "/vakter?fane=mine",
        },
      ]);
      await varslePersonal(
        orgId(c),
        bruker,
        "vakter",
        "Vaktbytte",
        b.mot_vakt_id ? `${b.fra_navn} og ${b.tatt_av_navn} byttet ${vaktTid(b)} og ${motTid(b)}.` : `${b.tatt_av_navn} tok vakten til ${b.fra_navn} ${vaktTid(b)}.`,
        `/vakter?uke=${uke(b.dato).fra}`,
        `vaktbytte-${b.id}`,
      );
    } else if (foer?.status === "akseptert")
      // Angret etter å ha tatt vakten.
      await send(orgId(c), b, [
        {
          bruker_ider: giver,
          tittel: "Vaktbytte",
          tekst: `${foer.tatt_av_navn} kan likevel ikke ta vakten ${vaktTid(b)}.${b.status === "tilbudt" ? " Tilbudet er åpent igjen." : ""}`,
          url: "/vakter?fane=bytter",
        },
      ]);
    else if (b.status === "avslatt")
      await send(orgId(c), b, [
        {
          bruker_ider: giver,
          tittel: "Nei takk",
          tekst: `${b.til_navn} kan ikke ta vakten ${vaktTid(b)}.`,
          url: "/vakter?fane=bytter",
        },
      ]);
    return c.json(b);
  });

  // Godkjenn eller avvis (eier og administrator): de to får beskjed.
  for (const handling of ["godkjenn", "avvis"] as const)
    r.post(`/vaktbytter/:id/${handling}`, async (c) => {
      const s = z.object({ grunn: valgfri(tekst(300, "Grunnen")) }).parse(await c.req.json().catch(() => ({})));
      const b = await bruk(c, async (db) => {
        await db.query("select faktura.behandle_vaktbytte($1, $2, $3, $4)", [orgId(c), id(c), handling === "godkjenn", s.grunn ?? null]);
        return (await enBytte(db, orgId(c), id(c)))!;
      });
      const bruker = c.get("bruker").id;
      const [giver, taker] = await Promise.all([innlogging(orgId(c), [b.fra_ansatt], bruker), innlogging(orgId(c), [b.tatt_av], bruker)]);
      if (handling === "godkjenn")
        await send(orgId(c), b, [
          {
            bruker_ider: giver,
            tittel: "Vaktbyttet er godkjent",
            tekst: b.mot_vakt_id ? `Du har nå ${motTid(b)} i stedet for ${vaktTid(b)}.` : `${b.tatt_av_navn} tar vakten din ${vaktTid(b)}.`,
            url: "/vakter?fane=mine",
          },
          {
            bruker_ider: taker,
            tittel: "Vaktbyttet er godkjent",
            tekst: b.mot_vakt_id ? `Du har nå ${vaktTid(b)} i stedet for ${motTid(b)}.` : `Vakten ${vaktTid(b)} er din.`,
            url: "/vakter?fane=mine",
          },
        ]);
      else {
        const grunn = b.grunn ? ` «${b.grunn}»` : "";
        await send(orgId(c), b, [
          { bruker_ider: [...giver, ...taker], tittel: "Vaktbyttet ble ikke godkjent", tekst: `${vaktTid(b)}${b.mot_vakt_id ? ` og ${motTid(b)}` : ""} blir som før.${grunn}`, url: "/vakter?fane=bytter" },
        ]);
      }
      return c.json(b);
    });

  // Trekk tilbake: den det var til (eller som hadde tatt vakten) får beskjed.
  r.post("/vaktbytter/:id/trekk", async (c) => {
    const { foer, b } = await bruk(c, async (db) => {
      const foer = await enBytte(db, orgId(c), id(c));
      await db.query("select faktura.trekk_vaktbytte($1, $2)", [orgId(c), id(c)]);
      return { foer, b: (await enBytte(db, orgId(c), id(c)))! };
    });
    const bruker = c.get("bruker").id;
    const mottakere = await innlogging(orgId(c), [foer?.tatt_av ?? b.til_ansatt, b.fra_ansatt], bruker);
    await send(orgId(c), b, [{ bruker_ider: mottakere, tittel: "Vaktbytte trukket tilbake", tekst: `Tilbudet om vakten ${vaktTid(b)} er trukket tilbake.`, url: "/vakter?fane=bytter" }]);
    return c.json(b);
  });

  return r;
}
