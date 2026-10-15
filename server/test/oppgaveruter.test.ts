// Workeren har en rute for hver oppgavetype. Cloud Tasks poster oppgavene til /oppgaver/<type>, og
// en type uten rute får 404 og blir aldri kjørt (f.eks. endringsforespørselen i Altinn, som da ble
// stående på «Lager endringsforespørselen …»). De andre testene kjører oppgavene direkte
// (kjorOppgave), så rutene sjekkes her.
import { describe, expect, it } from "vitest";
import { OPPGAVETYPER } from "../src/tjenester.js";
import { lagWorker } from "../src/worker.js";

describe("oppgavene til workeren", () => {
  const worker = lagWorker();

  it("har en rute for hver oppgavetype", () => {
    const ruter = new Set(worker.routes.filter((r) => r.method === "POST").map((r) => r.path));
    expect(OPPGAVETYPER.filter((t) => !ruter.has(`/oppgaver/${t}`))).toEqual([]);
  });

  it("sjekker oppgaven før den kjøres (Altinn, a-meldingen, NAV og Skatteetaten)", async () => {
    for (const t of ["altinn-endring", "amelding-lag", "amelding-status", "nav-hent", "nav-inntektsmelding", "skatteetaten-hent"]) {
      const r = await worker.request(`/oppgaver/${t}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ org_id: "ikke-en-id", oppgave_id: "x" }),
      });
      expect(r.status, t).toBe(400);
    }
  });
});
