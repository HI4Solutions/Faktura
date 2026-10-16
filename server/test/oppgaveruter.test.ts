// Workeren har en rute for hver oppgavetype. Cloud Tasks poster oppgavene til /oppgaver/<type>, og
// en type uten rute får 404 og blir aldri kjørt (f.eks. endringsforespørselen i Altinn, som da ble
// stående på «Lager endringsforespørselen …»). De andre testene kjører oppgavene direkte
// (kjorOppgave), så rutene sjekkes her.
import { describe, expect, it } from "vitest";
import { OPPGAVETYPER, workerAdresse } from "../src/tjenester.js";
import { lagWorker } from "../src/worker.js";

describe("oppgavene til workeren", () => {
  const worker = lagWorker();

  it("har en rute for hver oppgavetype", () => {
    const ruter = new Set(worker.routes.filter((r) => r.method === "POST").map((r) => r.path));
    expect(OPPGAVETYPER.filter((t) => !ruter.has(`/oppgaver/${t}`))).toEqual([]);
  });

  it("sjekker oppgaven før den kjøres (Altinn, a-meldingen, NAV og Skatteetaten)", async () => {
    for (const t of ["altinn-endring", "amelding-lag", "amelding-status", "nav-hent", "nav-inntektsmelding", "skatteetaten-hent", "aordning-hent"]) {
      const r = await worker.request(`/oppgaver/${t}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ org_id: "ikke-en-id", oppgave_id: "x" }),
      });
      expect(r.status, t).toBe(400);
    }
    // Adressen til rapporten fra a-ordningen må være en adresse.
    const r = await worker.request("/oppgaver/aordning-hent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ org_id: "00000000-0000-4000-8000-000000000000", oppgave_id: "x", bestilling: "ikke en adresse" }),
    });
    expect(r.status).toBe(400);
  });

  // WORKER_URL har bare API-et. Uten adressen ble alt workeren selv la i kø (nye forsøk, sjekkene
  // fra hjerteslaget, sendingen av gjentakende fakturaer), borte uten feil.
  it("tar sin egen adresse fra forespørslene fra Cloud Scheduler, Cloud Tasks og Pub/Sub", async () => {
    const send = (sti: string, vert: string, metode = "POST") =>
      worker.request(sti, { method: metode, headers: { host: vert, "content-type": "application/json" }, body: metode === "POST" ? "{}" : undefined });
    await send("/oppgaver/amelding-status", "faktura-worker-abc123-lz.a.run.app");
    expect(workerAdresse()).toBe("https://faktura-worker-abc123-lz.a.run.app");
    // Andre forespørsler (helsesjekken) endrer den ikke.
    await send("/helse", "10.0.0.7:8080", "GET");
    expect(workerAdresse()).toBe("https://faktura-worker-abc123-lz.a.run.app");
    await send("/jobber/ukjent", "faktura-worker-555-ew.a.run.app");
    expect(workerAdresse()).toBe("https://faktura-worker-555-ew.a.run.app");
  });
});
