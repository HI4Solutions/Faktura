import type { MiddlewareHandler } from "hono";
import { initializeApp, getApps } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { config } from "./config.js";
import { somBetrodd, somSystem, en } from "./db.js";
import { ApiFeil } from "./feil.js";

export interface Innlogget {
  id: string; // faktura.brukere.id
  eksternId: string;
  epost: string;
  epostBekreftet: boolean;
  mfa: boolean;
  // Kontoen er godkjent av plattformadministratoren (0043_kontogodkjenning.sql), venter
  // eller er avvist.
  status: "venter" | "godkjent" | "avvist";
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
    // test:<uid>:<epost>[:mfa[:navn[:venter]]] – testbrukere godkjennes med en gang, med mindre
    // tokenet slutter med «venter».
    const [, uid, epost, mfa, navn, venter] = token.split(":");
    return {
      uid,
      email: epost,
      email_verified: true,
      mfa: mfa === "mfa" || mfa === "passkey",
      navn: navn ? decodeURIComponent(navn) : (undefined as string | undefined),
      godkjennTest: venter !== "venter",
    };
  }
  const t = await firebase().verifyIdToken(token, true);
  return {
    uid: t.uid,
    email: t.email,
    email_verified: t.email_verified === true,
    // Totrinn: TOTP via Identity Platform, eller innlogging med passkey (custom token med kravet «passkey»).
    mfa: Boolean(t.firebase?.sign_in_second_factor) || t.passkey === true,
    navn: t.name as string | undefined,
    godkjennTest: false,
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
  const b = (await somSystem((db) =>
    en<{ id: string; status: Innlogget["status"] }>(db, "select id, status from faktura.registrer_bruker($1, $2, $3)", [t.uid, t.email, t.navn ?? null]),
  ))!;
  // Plattformadministratorene (med bekreftet e-post) trenger ingen godkjenning, og heller ikke
  // testbrukerne.
  if (b.status === "venter" && ((t.email_verified && config.adminEposter.includes(t.email.toLowerCase())) || t.godkjennTest)) {
    await somBetrodd(b.id, (db) => db.query("select faktura.behandle_konto($1, true)", [b.id]));
    b.status = "godkjent";
  }
  c.set("bruker", { id: b.id, eksternId: t.uid, epost: t.email, epostBekreftet: t.email_verified, mfa: t.mfa, status: b.status });
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
