// Kontogodkjenning (0043_kontogodkjenning.sql): en ny konto kommer ikke inn før
// plattformadministratoren har godkjent den. Når e-postadressen er bekreftet og navnet skrevet
// inn, får administratorene e-post om forespørselen; de godkjenner eller avviser under
// Administrasjon → Venter, og brukeren får e-post om utfallet. Til da slipper API-et bare
// gjennom /meg (status og navn) og invitasjoner (en invitasjon fra en organisasjon godkjenner
// kontoen).
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { z } from "zod";
import { config } from "./config.js";
import { alle, en, somBetrodd, somBruker } from "./db.js";
import { ApiFeil } from "./feil.js";
import { leggIKo } from "./tjenester.js";

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

// Når kontoen venter, e-postadressen er bekreftet og navnet skrevet inn: e-post til
// plattformadministratorene (én gang).
export async function meldNyKonto(c: Context) {
  const b = c.get("bruker");
  if (b.status !== "venter" || !b.epostBekreftet || !config.adminEposter.length) return;
  const ny = await somBruker(b.id, async (db) => {
    if (!(await en<{ ny: boolean }>(db, "select faktura.meld_konto() as ny"))!.ny) return null;
    return en<{ navn: string; epost: string }>(db, "select navn, epost from faktura.brukere where id = faktura.bruker_id()");
  });
  if (!ny) return;
  await leggIKo({
    type: "epost",
    til: config.adminEposter,
    emne: `Ny konto venter på godkjenning: ${ny.navn}`,
    tekst: [
      `${ny.navn} (${ny.epost}) har laget en konto i HI4 Faktura og bekreftet e-postadressen.`,
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

  // Godkjenn eller avvis en konto. Brukeren får e-post om utfallet.
  r.post("/brukere/:id/godkjenning", async (c) => {
    const k = z.object({ godkjent: z.boolean(), grunn: z.string().trim().max(500).optional() }).parse(await c.req.json().catch(() => ({})));
    const b = (await somBetrodd(c.get("bruker").id, (db) =>
      en<{ id: string; epost: string; navn: string | null; status: string; avvist_grunn: string | null }>(
        db,
        "select id, epost, navn, status, avvist_grunn from faktura.behandle_konto($1, $2, $3)",
        [id(c), k.godkjent, k.grunn ?? null],
      ),
    ))!;
    const hei = b.navn ? `Hei ${b.navn.split(" ")[0]},` : "Hei,";
    await leggIKo({
      type: "epost",
      til: [b.epost],
      ...(k.godkjent
        ? {
            emne: "Kontoen din i HI4 Faktura er godkjent",
            tekst: [hei, ``, `Kontoen din i HI4 Faktura er godkjent, og du kan logge inn nå:`, config.appUrl].join("\n"),
          }
        : {
            emne: "Kontoen din i HI4 Faktura er ikke godkjent",
            tekst: [hei, ``, `Kontoen din i HI4 Faktura ble ikke godkjent.${b.avvist_grunn ? ` Begrunnelse: ${b.avvist_grunn}` : ""}`, ``, `Ta kontakt med HI4 Faktura hvis du mener dette er feil.`].join(
              "\n",
            ),
          }),
    }).catch((e) => console.warn("Kunne ikke sende e-post om kontoen", e));
    return c.json({ id: b.id, status: b.status, avvist_grunn: b.avvist_grunn });
  });

  return r;
}
