// Krav og betalinger og frister fra Skatteetaten i appen (skatteetatenKrav.ts, fanen «Skatteetaten»
// under Regnskap, docs/skatteetaten-krav.md): det som sist ble hentet, om funksjonen er slått på og
// tilgangspakken gitt i Altinn, og «Hent nå» (workeren henter). Eier, administrator og regnskap
// (og en egen rolle med Regnskap); stiene under /regnskap krever funksjonen «Regnskap».
import { Hono, type Context } from "hono";
import { z } from "zod";
import { en, somBruker, type Db } from "./db.js";
import { ApiFeil } from "./feil.js";
import { config } from "./config.js";
import { KRAV_OG_UTLEGG, PAKKENAVN } from "./altinn.js";
import { leggIKo } from "./tjenester.js";
import type { Fristoversikt, Kravoversikt } from "./skatteetatenKrav.js";

const orgId = (c: Context) => z.string().uuid().parse(c.req.param("org"));
const bruk = <T>(c: Context, fn: (db: Db) => Promise<T>) => somBruker<T>(c.get("bruker").id, fn);

type Rad = {
  krav: Kravoversikt | null;
  krav_hentet: string | null;
  krav_feil: string | null;
  frister: Fristoversikt | null;
  frister_hentet: string | null;
  frister_feil: string | null;
  forsokt: string | null;
};

export const hentLagret = (db: Db, org: string) =>
  en<Rad>(db, "select krav, krav_hentet, krav_feil, frister, frister_hentet, frister_feil, forsokt from faktura.skatteetaten_krav where org_id = $1", [org]);

async function status(db: Db, org: string) {
  await db.query("select faktura.krev($1, 'regnskap')", [org]);
  const t = await en<{ status: string; pakker: string[] }>(db, "select status, pakker from faktura.skattekort_tilgang where org_id = $1", [org]);
  const r = await hentLagret(db, org);
  return {
    pa: config.kravOgFrister,
    miljo: config.skatteetatenMiljo,
    // Koblet til Skatteetaten (Innstillinger → Lønn → Skattekort), og med tilgangspakken.
    koblet: t?.status === "godkjent",
    tilgang: Boolean(t?.status === "godkjent" && t.pakker.includes(KRAV_OG_UTLEGG)),
    pakke: PAKKENAVN[KRAV_OG_UTLEGG],
    forsokt: r?.forsokt ?? null,
    krav: { data: r?.krav ?? null, hentet: r?.krav_hentet ?? null, feil: r?.krav_feil ?? null },
    frister: { data: r?.frister ?? null, hentet: r?.frister_hentet ?? null, feil: r?.frister_feil ?? null },
  };
}

export function skatteetatenRuter() {
  const r = new Hono();

  r.get("/regnskap/skatteetaten", async (c) => c.json(await bruk(c, (db) => status(db, orgId(c)))));

  // Hent nå (workeren henter krav og frister). Høyst én gang i minuttet.
  r.post("/regnskap/skatteetaten/hent", async (c) => {
    const s = await bruk(c, (db) => status(db, orgId(c)));
    if (!s.pa) throw new ApiFeil(409, "Krav og frister fra Skatteetaten er ikke slått på ennå.");
    if (!s.koblet) throw new ApiFeil(409, "Koble til Skatteetaten først (Innstillinger → Lønn → Skattekort).");
    if (!s.tilgang)
      throw new ApiFeil(409, `Gi tilgang til kravene og fristene i Altinn først: tilgangspakken «${s.pakke}» (Innstillinger → Lønn → Skattekort → «Utvid tilgangen i Altinn»).`);
    if (s.forsokt && Date.now() - Date.parse(s.forsokt) < 60_000) return c.json({ ok: true, allerede: true });
    await leggIKo({ type: "skatteetaten-hent", org_id: orgId(c) });
    return c.json({ ok: true });
  });

  return r;
}
