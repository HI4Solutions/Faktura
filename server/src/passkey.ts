// Passkeys med WebAuthn. Registrering krever innlogging; innlogging gir et Firebase
// custom token med kravet «passkey», som regnes som totrinnsbekreftelse.
import { Hono, type Context } from "hono";
import { z } from "zod";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { initializeApp, getApps } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { config } from "./config.js";
import { alle, en, somBruker, somSystem } from "./db.js";
import { ApiFeil } from "./feil.js";

const rp = () => {
  const url = new URL(config.appUrl);
  return { id: url.hostname, origin: url.origin, navn: "HI4 Faktura" };
};

// Enkel hastighetsgrense per IP for innlogging (per instans).
const forsok = new Map<string, { n: number; tid: number }>();
function begrens(c: Context) {
  const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "ukjent";
  const na = Date.now();
  const f = forsok.get(ip);
  if (!f || na - f.tid > 60_000) forsok.set(ip, { n: 1, tid: na });
  else if (++f.n > 20) throw new ApiFeil(429, "For mange forsøk. Vent litt og prøv igjen.");
  if (forsok.size > 10_000) forsok.clear();
}

// Lager Firebase-innloggingen. Byttes ut i tester.
export let lagInnloggingstoken = async (eksternId: string): Promise<string> => {
  if (!getApps().length) initializeApp({ projectId: config.prosjekt });
  return getAuth().createCustomToken(eksternId, { passkey: true });
};
export function settInnloggingstoken(fn: typeof lagInnloggingstoken) {
  lagInnloggingstoken = fn;
}

// Ruter som krever innlogging (monteres under /api/passkeys).
export function passkeyRuter() {
  const r = new Hono();

  r.get("/", async (c) =>
    c.json(
      await somBruker(c.get("bruker").id, (db) =>
        alle(db, "select id, navn, enhetstype, sikkerhetskopiert, opprettet, sist_brukt from faktura.passkeys order by opprettet"),
      ),
    ),
  );

  r.post("/registrering/start", async (c) => {
    const b = c.get("bruker");
    return c.json(
      await somBruker(b.id, async (db) => {
        const eksisterende = await alle<{ id: string; transporter: string[] }>(db, "select id, transporter from faktura.passkeys");
        const valg = await generateRegistrationOptions({
          rpName: rp().navn,
          rpID: rp().id,
          userName: b.epost,
          userID: new Uint8Array(Buffer.from(b.id.replace(/-/g, ""), "hex")),
          attestationType: "none",
          excludeCredentials: eksisterende.map((p) => ({ id: p.id, transports: p.transporter })),
          authenticatorSelection: { residentKey: "required", userVerification: "required" },
        });
        const u = await en(db, "insert into faktura.passkey_utfordringer (bruker_id, type, utfordring) values ($1, 'registrering', $2) returning id", [
          b.id,
          valg.challenge,
        ]);
        return { utfordring_id: u!.id, valg };
      }),
    );
  });

  r.post("/registrering/fullfor", async (c) => {
    const b = c.get("bruker");
    const k = z.object({ utfordring_id: z.string().uuid(), svar: z.any(), navn: z.string().trim().max(60).optional() }).parse(await c.req.json());
    const p = await somBruker(b.id, async (db) => {
      const u = await en(db, "select * from faktura.bruk_passkey_utfordring($1, 'registrering')", [k.utfordring_id]);
      if (u.bruker_id !== b.id) throw new ApiFeil(400, "Utfordringen tilhører en annen bruker");
      let v;
      try {
        v = await verifyRegistrationResponse({
          response: k.svar,
          expectedChallenge: u.utfordring,
          expectedOrigin: rp().origin,
          expectedRPID: rp().id,
          requireUserVerification: true,
        });
      } catch (e) {
        throw new ApiFeil(400, `Kunne ikke bekrefte passkey: ${(e as Error).message}`);
      }
      if (!v.verified) throw new ApiFeil(400, "Kunne ikke bekrefte passkey");
      const cred = v.registrationInfo.credential;
      return en(
        db,
        `insert into faktura.passkeys (id, bruker_id, offentlig_nokkel, teller, transporter, enhetstype, sikkerhetskopiert, navn)
         values ($1, $2, $3, $4, $5, $6, $7, $8)
         returning id, navn, enhetstype, sikkerhetskopiert, opprettet`,
        [cred.id, b.id, Buffer.from(cred.publicKey), cred.counter, cred.transports ?? [], v.registrationInfo.credentialDeviceType,
         v.registrationInfo.credentialBackedUp, k.navn || "Passkey"],
      );
    });
    return c.json(p, 201);
  });

  r.patch("/:id", async (c) => {
    const k = z.object({ navn: z.string().trim().min(1).max(60) }).parse(await c.req.json());
    const p = await somBruker(c.get("bruker").id, (db) => en(db, "update faktura.passkeys set navn = $2 where id = $1 returning id, navn", [c.req.param("id"), k.navn]));
    if (!p) throw new ApiFeil(404, "Fant ikke passkeyen");
    return c.json(p);
  });

  r.delete("/:id", async (c) => {
    const res = await somBruker(c.get("bruker").id, (db) => db.query("delete from faktura.passkeys where id = $1", [c.req.param("id")]));
    if (!res.rowCount) throw new ApiFeil(404, "Fant ikke passkeyen");
    return c.body(null, 204);
  });

  return r;
}

// Åpne ruter for innlogging (monteres under /api/offentlig/passkey).
export function passkeyInnlogging() {
  const r = new Hono();

  r.post("/start", async (c) => {
    begrens(c);
    const valg = await generateAuthenticationOptions({ rpID: rp().id, userVerification: "required" });
    const u = await somSystem((db) =>
      en(db, "insert into faktura.passkey_utfordringer (type, utfordring) values ('innlogging', $1) returning id", [valg.challenge]),
    );
    return c.json({ utfordring_id: u!.id, valg });
  });

  r.post("/fullfor", async (c) => {
    begrens(c);
    const k = z.object({ utfordring_id: z.string().uuid(), svar: z.object({ id: z.string() }).passthrough() }).parse(await c.req.json());
    const eksternId = await somSystem(async (db) => {
      const u = await en(db, "select * from faktura.bruk_passkey_utfordring($1, 'innlogging')", [k.utfordring_id]);
      const p = await en(db, "select * from faktura.passkey_for_innlogging($1)", [k.svar.id]);
      if (!p) throw new ApiFeil(401, "Ukjent passkey. Logg inn med passord og legg den til på nytt.");
      let v;
      try {
        v = await verifyAuthenticationResponse({
          response: k.svar as any,
          expectedChallenge: u.utfordring,
          expectedOrigin: rp().origin,
          expectedRPID: rp().id,
          credential: { id: p.id, publicKey: new Uint8Array(p.offentlig_nokkel), counter: Number(p.teller), transports: p.transporter },
          requireUserVerification: true,
        });
      } catch {
        throw new ApiFeil(401, "Kunne ikke bekrefte passkeyen");
      }
      if (!v.verified) throw new ApiFeil(401, "Kunne ikke bekrefte passkeyen");
      await db.query("select faktura.passkey_brukt($1, $2)", [p.id, v.authenticationInfo.newCounter]);
      return p.ekstern_id as string;
    });
    return c.json({ token: await lagInnloggingstoken(eksternId) });
  });

  return r;
}
