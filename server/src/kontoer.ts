// Kontogodkjenning (0043_kontogodkjenning.sql): en ny konto kommer ikke inn før
// plattformadministratoren har godkjent den. Når e-postadressen er bekreftet, navnet skrevet
// inn og modulene valgt (0044_moduler.sql), får administratorene e-post om forespørselen; de
// godkjenner (med modulene brukeren ba om, eller andre) eller avviser under Administrasjon →
// Venter, og brukeren får e-post om utfallet. Til da slipper API-et bare gjennom /meg (status,
// navn og moduler) og invitasjoner (en invitasjon fra en organisasjon godkjenner kontoen).
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { z } from "zod";
import { config } from "./config.js";
import { alle, en, somBetrodd, somBruker, somSystem, type Db } from "./db.js";
import { ApiFeil } from "./feil.js";
import { leggIKo } from "./tjenester.js";

// Modulene (Faktura, Bemanning og de som kommer), for registreringen: åpent, og husket fem
// minutter.
export type Modul = { kode: string; navn: string; beskrivelse: string };
let modulMinne: { tid: number; liste: Promise<Modul[]> } | undefined;
export function hentModuler(): Promise<Modul[]> {
  if (!modulMinne || Date.now() - modulMinne.tid > 5 * 60_000) {
    const liste = somSystem((db) => alle<Modul>(db, "select kode, navn, beskrivelse from faktura.moduler order by rekkefolge"));
    modulMinne = { tid: Date.now(), liste };
    liste.catch(() => (modulMinne = undefined));
  }
  return modulMinne.liste;
}
export const modulKoder = z.array(z.string().regex(/^[a-z_]{2,30}$/, "Ukjent modul")).min(1, "Velg minst én modul").max(20);
// «Faktura og Bemanning»
export const opplisting = (navn: string[]) => (navn.length < 2 ? (navn[0] ?? "") : `${navn.slice(0, -1).join(", ")} og ${navn.at(-1)}`);
// Navnene på modulene til en bruker, i modulenes rekkefølge (RLS: egne, eller betrodd).
const modulnavn = async (db: Db, bruker: string) =>
  (
    await alle<{ navn: string }>(
      db,
      "select m.navn from faktura.bruker_moduler b join faktura.moduler m on m.kode = b.modul where b.bruker_id = $1 order by m.rekkefolge",
      [bruker],
    )
  ).map((m) => m.navn);

// Det en konto som venter, får bruke.
const APNE: [string, string][] = [
  ["GET", "/api/meg"],
  ["PATCH", "/api/meg"],
  ["POST", "/api/invitasjoner/aksepter"],
];

export const krevGodkjentKonto: MiddlewareHandler = async (c, next) => {
  const b = c.get("bruker");
  if (c.req.path.startsWith("/api/offentlig/") || b.status === "godkjent" || APNE.some(([m, sti]) => m === c.req.method && sti === c.req.path)) return next();
  throw new ApiFeil(403, b.status === "avvist" ? "Kontoen er ikke godkjent" : "Kontoen venter på godkjenning fra HI4 Faktura");
};

// Når kontoen venter, e-postadressen er bekreftet, navnet skrevet inn og modulene valgt: e-post
// til plattformadministratorene (én gang), med modulene brukeren ber om.
export async function meldNyKonto(c: Context) {
  const b = c.get("bruker");
  if (b.status !== "venter" || !b.epostBekreftet || !config.adminEposter.length) return;
  const ny = await somBruker(b.id, async (db) => {
    if (!(await en<{ ny: boolean }>(db, "select faktura.meld_konto() as ny"))!.ny) return null;
    const meg = (await en<{ navn: string; epost: string }>(db, "select navn, epost from faktura.brukere where id = faktura.bruker_id()"))!;
    return { ...meg, moduler: await modulnavn(db, b.id) };
  });
  if (!ny) return;
  await leggIKo({
    type: "epost",
    til: config.adminEposter,
    emne: `Ny konto venter på godkjenning: ${ny.navn}`,
    tekst: [
      `${ny.navn} (${ny.epost}) har laget en konto i HI4 Faktura og bekreftet e-postadressen.`,
      ``,
      `Moduler: ${opplisting(ny.moduler)}`,
      ``,
      `Kontoen kommer ikke inn før den er godkjent. Godkjenn eller avvis den på ${config.appUrl}/admin?fane=venter`,
    ].join("\n"),
  }).catch((e) => console.warn("Kunne ikke varsle administratorer om ny konto", e));
}

// --- Administrasjon (montert under /api/admin, som krever plattformadmin) -------------------

export function kontoAdminRuter() {
  const r = new Hono();
  const id = (c: Context) => z.string().uuid().parse(c.req.param("id"));

  // Kontoene som venter på godkjenning.
  r.get("/kontoer", async (c) => c.json(await somBetrodd(c.get("bruker").id, (db) => alle(db, "select * from faktura.admin_kontoer_venter()"))));

  // Godkjenn eller avvis en konto, eventuelt med andre moduler enn brukeren ba om. Brukeren får
  // e-post om utfallet.
  r.post("/brukere/:id/godkjenning", async (c) => {
    const k = z
      .object({ godkjent: z.boolean(), grunn: z.string().trim().max(500).optional(), moduler: modulKoder.optional() })
      .parse(await c.req.json().catch(() => ({})));
    const b = (await somBetrodd(c.get("bruker").id, async (db) => {
      const b = (await en<{ id: string; epost: string; navn: string | null; status: string; avvist_grunn: string | null }>(
        db,
        "select id, epost, navn, status, avvist_grunn from faktura.behandle_konto($1, $2, $3, $4)",
        [id(c), k.godkjent, k.grunn ?? null, k.moduler ?? null],
      ))!;
      return { ...b, moduler: await modulnavn(db, b.id) };
    }))!;
    const hei = b.navn ? `Hei ${b.navn.split(" ")[0]},` : "Hei,";
    await leggIKo({
      type: "epost",
      til: [b.epost],
      ...(k.godkjent
        ? {
            emne: "Kontoen din i HI4 Faktura er godkjent",
            tekst: [
              hei,
              ``,
              `Kontoen din i HI4 Faktura er godkjent${b.moduler.length ? ` med ${opplisting(b.moduler)}` : ""}, og du kan logge inn nå:`,
              config.appUrl,
            ].join("\n"),
          }
        : {
            emne: "Kontoen din i HI4 Faktura er ikke godkjent",
            tekst: [hei, ``, `Kontoen din i HI4 Faktura ble ikke godkjent.${b.avvist_grunn ? ` Begrunnelse: ${b.avvist_grunn}` : ""}`, ``, `Ta kontakt med HI4 Faktura hvis du mener dette er feil.`].join(
              "\n",
            ),
          }),
    }).catch((e) => console.warn("Kunne ikke sende e-post om kontoen", e));
    return c.json({ id: b.id, status: b.status, avvist_grunn: b.avvist_grunn, moduler: b.moduler });
  });

  return r;
}
