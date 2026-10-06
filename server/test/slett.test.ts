// Sletting av utstedte (test)fakturaer.
import { describe, expect, it, beforeAll } from "vitest";
import { lagApi } from "../src/api.js";
import { settLokalOppgavekjorer, type Oppgave } from "../src/tjenester.js";

describe.skipIf(!process.env.DATABASE_URL)("Sletting av fakturaer", () => {
  const app = lagApi();
  const ko: Oppgave[] = [];
  const eier = "Bearer test:uid-slett:slett@server.test:mfa";
  const fremmed = "Bearer test:uid-slett2:slett2@server.test:mfa";
  let org: string;
  let kunde: string;

  const kall = async (m: string, sti: string, t: string, k?: unknown) => {
    const r = await app.request(sti, { method: m, headers: { authorization: t, "content-type": "application/json" }, body: k === undefined ? undefined : JSON.stringify(k) });
    const type = r.headers.get("content-type") ?? "";
    return { status: r.status, data: type.includes("json") ? ((await r.json()) as any) : null };
  };
  const nyFaktura = async () => {
    const f = await kall("POST", `/api/org/${org}/fakturaer`, eier, {
      kunde_id: kunde,
      linjer: [{ beskrivelse: "Test", antall: 1, enhet: "stk", enhetspris: 100, mva_sats: 25 }],
    });
    const u = await kall("POST", `/api/org/${org}/fakturaer/${f.data.id}/utsted`, eier, { send_epost: false });
    expect(u.status).toBe(200);
    return u.data;
  };

  beforeAll(async () => {
    settLokalOppgavekjorer(async (o) => {
      ko.push(o);
    });
    org = (await kall("POST", "/api/organisasjoner", eier, { navn: "Slett AS" })).data.id;
    await kall("PATCH", `/api/org/${org}`, eier, { kontonr: "86011117947", epost: "post@slett.no" });
    kunde = (await kall("POST", `/api/org/${org}/kunder`, eier, { navn: "Kunde", epost: "k@kunde.no" })).data.id;
  });

  it("sletter testfakturaer med kreditnota og betaling, og nummerserien fortsetter uten hull", async () => {
    const f1 = await nyFaktura();
    const f2 = await nyFaktura();
    expect([f1.fakturanummer, f2.fakturanummer]).toEqual([1, 2]);

    const idag = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Oslo" }).format(new Date());
    expect((await kall("POST", `/api/org/${org}/fakturaer/${f2.id}/betalinger`, eier, { belop: 50, dato: idag })).status).toBe(200);
    const kn = await kall("POST", `/api/org/${org}/fakturaer/${f2.id}/krediter`, eier, { send_epost: false });
    expect(kn.status).toBe(201);

    // Krever grunn og tilgang (MFA kreves bare i produksjon); kreditnotaen alene kan ikke slettes.
    expect((await kall("POST", `/api/org/${org}/fakturaer/${f2.id}/slett`, eier, { grunn: "" })).status).toBe(400);
    expect((await kall("POST", `/api/org/${org}/fakturaer/${f2.id}/slett`, fremmed, { grunn: "Test" })).status).toBe(403);
    expect((await kall("POST", `/api/org/${org}/fakturaer/${kn.data.id}/slett`, eier, { grunn: "Test" })).status).toBe(409);

    // En utstedt faktura kan fortsatt ikke slettes på vanlig måte.
    expect((await kall("DELETE", `/api/org/${org}/fakturaer/${f1.id}`, eier)).status).toBe(409);

    ko.length = 0;
    const s = await kall("POST", `/api/org/${org}/fakturaer/${f2.id}/slett`, eier, { grunn: "Testfaktura" });
    expect(s.status).toBe(200);
    expect(s.data.slettet.sort()).toEqual([f2.id, kn.data.id].sort());
    expect(ko).toEqual([expect.objectContaining({ type: "disk-slett", org_id: org })]);
    expect((await kall("GET", `/api/org/${org}/fakturaer/${f2.id}`, eier)).status).toBe(404);
    expect((await kall("GET", `/api/org/${org}/fakturaer/${kn.data.id}`, eier)).status).toBe(404);

    // Nummer 2 og 3 (kreditnotaen) var de siste; neste faktura får nummer 2.
    expect((await nyFaktura()).fakturanummer).toBe(2);

    // Sletter vi nummer 1 (ikke den siste), blir det et hull som revisjonsloggen forklarer.
    expect((await kall("POST", `/api/org/${org}/fakturaer/${f1.id}/slett`, eier, { grunn: "Testfaktura" })).status).toBe(200);
    expect((await nyFaktura()).fakturanummer).toBe(3);
  });
});
