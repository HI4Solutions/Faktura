// Brukeren sletter sin egen konto (DELETE /api/meg, 0123_slett_konto.sql). Kontoen anonymiseres i
// databasen og brukeren slettes i Identity Platform i samme transaksjon: feiler slettingen der,
// rulles alt tilbake, så kontoen enten er borte begge steder eller ikke er rørt. Brukeren skriver
// e-postadressen sin for å bekrefte. Den som er eneste eier av en organisasjon, får beskjed om å gi
// eierrollen til en annen eller slette organisasjonen først (409).
import type { Context } from "hono";
import { z } from "zod";
import { identitet } from "./auth.js";
import { somBruker } from "./db.js";
import { ApiFeil } from "./feil.js";

const logg = (severity: string, message: string, data: Record<string, unknown> = {}) => console.log(JSON.stringify({ severity, message, ...data }));

export async function slettMinKonto(c: Context) {
  const b = c.get("bruker");
  let json: unknown = {};
  try {
    json = await c.req.json();
  } catch {
    json = {};
  }
  const { bekreft } = z.object({ bekreft: z.string().trim().max(320) }).parse(json);
  if (bekreft.toLowerCase() !== b.epost.toLowerCase()) throw new ApiFeil(400, "Skriv e-postadressen din for å bekrefte at kontoen skal slettes.");
  await somBruker(b.id, async (db) => {
    await db.query("select faktura.slett_min_konto()");
    await identitet().slettBruker(b.eksternId);
  });
  logg("INFO", "Kontoen er slettet av brukeren", { bruker_id: b.id });
  return c.body(null, 204);
}
