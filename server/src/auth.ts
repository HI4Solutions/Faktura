import type { MiddlewareHandler } from "hono";
import { initializeApp, getApps } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { config } from "./config.js";
import { somSystem, en } from "./db.js";
import { ApiFeil } from "./feil.js";

export interface Innlogget {
  id: string; // faktura.brukere.id
  eksternId: string;
  epost: string;
  epostBekreftet: boolean;
  mfa: boolean;
}

declare module "hono" {
  interface ContextVariableMap {
    bruker: Innlogget;
  }
}

function firebase() {
  if (!getApps().length) initializeApp({ projectId: config.prosjekt });
  return getAuth();
}

async function verifiser(token: string) {
  if (config.testInnlogging && token.startsWith("test:")) {
    // test:<uid>:<epost>[:mfa]
    const [, uid, epost, mfa] = token.split(":");
    return { uid, email: epost, email_verified: true, mfa: mfa === "mfa", navn: undefined as string | undefined };
  }
  const t = await firebase().verifyIdToken(token, true);
  return {
    uid: t.uid,
    email: t.email,
    email_verified: t.email_verified === true,
    mfa: Boolean(t.firebase?.sign_in_second_factor),
    navn: t.name as string | undefined,
  };
}

// Verifiserer Identity Platform-tokenet og registrerer brukeren i databasen.
export const krevInnlogging: MiddlewareHandler = async (c, next) => {
  const header = c.req.header("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) throw new ApiFeil(401, "Ikke innlogget");
  let t;
  try {
    t = await verifiser(token);
  } catch {
    throw new ApiFeil(401, "Ugyldig eller utløpt innlogging");
  }
  if (!t.email) throw new ApiFeil(401, "Kontoen mangler e-postadresse");
  // registrer_bruker kjøres uten bruker-id; den er en betrodd funksjon for API-et.
  const b = await somSystem((db) =>
    en<{ id: string }>(db, "select id from faktura.registrer_bruker($1, $2, $3)", [t.uid, t.email, t.navn ?? null]),
  );
  c.set("bruker", { id: b!.id, eksternId: t.uid, epost: t.email, epostBekreftet: t.email_verified, mfa: t.mfa });
  await next();
};

// Endringer krever bekreftet e-postadresse.
export const krevBekreftetEpost: MiddlewareHandler = async (c, next) => {
  if (c.req.method !== "GET" && !c.get("bruker").epostBekreftet) {
    throw new ApiFeil(403, "Bekreft e-postadressen din først");
  }
  await next();
};

// Utstedelse, kreditering og endring av kontonummer krever innlogging med MFA.
export function krevMfa(c: { get(k: "bruker"): Innlogget }) {
  if (!c.get("bruker").mfa && config.produksjon) {
    throw new ApiFeil(403, "Denne handlingen krever totrinnsbekreftelse (MFA)");
  }
}
