import type { Context } from "hono";
import { ZodError } from "zod";

export class ApiFeil extends Error {
  constructor(public status: number, melding: string) {
    super(melding);
  }
}

// Databasen bruker egne SQLSTATE-koder (se db/migrations/0002). Her blir de HTTP-statuser.
const pgKoder: Record<string, number> = {
  FA400: 400,
  FA403: 403,
  FA404: 404,
  FA409: 409,
  FA429: 429,
  "23505": 409, // unik
  "23503": 409, // fremmednøkkel
  "23514": 400, // check
  "23502": 400, // not null
  "22P02": 400, // ugyldig verdi (f.eks. uuid)
  "22007": 400, // ugyldig dato
  "22008": 400,
  "42501": 403, // RLS eller manglende rettighet
  P0002: 404,
};

const pgMeldinger: Record<string, string> = {
  "23505": "Finnes allerede",
  "23503": "Er i bruk eller viser til noe som ikke finnes",
  "23514": "Ugyldige data",
  "23502": "Mangler påkrevd felt",
  "22P02": "Ugyldig verdi",
  "22007": "Ugyldig dato",
  "22008": "Ugyldig dato",
  "42501": "Ingen tilgang",
};

// Begrensninger i databasen med en egen forklaring.
const begrensninger: Record<string, string> = {
  produkter_indeks_krever_pris: "Indeksregulering krever fast pris på produktet",
  faktura_linjer_en_rabatt: "Velg rabatt i prosent eller i kroner, ikke begge",
};

export function tilHttp(e: unknown): { status: number; error: string } {
  if (e instanceof ApiFeil) return { status: e.status, error: e.message };
  if (e instanceof ZodError) {
    const f = e.issues[0];
    // Egne meldinger er hele setninger («Rabatten kan ikke være mer enn 100 %»); de vises som
    // de er. Zods egne (engelske) meldinger får feltnavnet foran.
    if (f && /^[A-ZÆØÅ«]/.test(f.message) && !/^(Invalid|Too |Unrecognized|Expected|Required)/.test(f.message)) return { status: 400, error: f.message };
    return { status: 400, error: `Ugyldig ${f?.path.join(".") || "forespørsel"}: ${f?.message ?? ""}`.trim() };
  }
  const kode = (e as { code?: string })?.code;
  const begrensning = (e as { constraint?: string })?.constraint;
  if (kode === "23514" && begrensning && begrensninger[begrensning]) return { status: 400, error: begrensninger[begrensning] };
  if (kode && pgKoder[kode]) {
    const egen = kode.startsWith("FA") || kode === "P0002";
    return { status: pgKoder[kode], error: egen ? (e as Error).message : pgMeldinger[kode] ?? "Ugyldig forespørsel" };
  }
  return { status: 500, error: "Noe gikk galt" };
}

export function feilhandterer(e: Error, c: Context) {
  const { status, error } = tilHttp(e);
  if (status >= 500) console.error(JSON.stringify({ severity: "ERROR", message: e.message, stack: e.stack }));
  return c.json({ error }, status as 400);
}
