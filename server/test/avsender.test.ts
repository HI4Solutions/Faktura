// Avsender (firma/innehaver), privatperson og flere kontonumre.
import { describe, expect, it, beforeAll } from "vitest";
import { lagApi } from "../src/api.js";
import { settLokalOppgavekjorer } from "../src/tjenester.js";

describe.skipIf(!process.env.DATABASE_URL)("Avsender og kontonumre", () => {
  const app = lagApi();
  const t = "Bearer test:uid-avsender:avsender@server.test:mfa";
  const kall = async (m: string, sti: string, k?: unknown) => {
    const r = await app.request(sti, { method: m, headers: { authorization: t, "content-type": "application/json" }, body: k === undefined ? undefined : JSON.stringify(k) });
    const type = r.headers.get("content-type") ?? "";
    return { status: r.status, data: type.includes("json") ? ((await r.json()) as any) : null };
  };

  beforeAll(() => settLokalOppgavekjorer(async () => {}));

  it("ENK sender som innehaver med egen konto", async () => {
    const org = (await kall("POST", "/api/organisasjoner", { navn: "Nordmann Snekkerservice" })).data.id;
    expect((await kall("PATCH", `/api/org/${org}`, { standard_avsender: "innehaver" })).status).toBe(400); // mangler innehaver
    expect((await kall("PATCH", `/api/org/${org}`, { kontonr: "86011117947", innehaver: "Ola Nordmann" })).status).toBe(200);

    expect((await kall("POST", `/api/org/${org}/kontoer`, { navn: "Feil", kontonr: "12345678901" })).status).toBe(400);
    const konto = await kall("POST", `/api/org/${org}/kontoer`, { navn: "Husleiekonto", kontonr: "1234.56.78903" });
    expect(konto.status).toBe(201);
    expect(konto.data.kontonr).toBe("12345678903");
    expect((await kall("GET", `/api/org/${org}/kontoer`)).data).toHaveLength(1);

    const kunde = (await kall("POST", `/api/org/${org}/kunder`, { navn: "Kunde" })).data.id;
    const f = await kall("POST", `/api/org/${org}/fakturaer`, {
      kunde_id: kunde,
      avsender: "innehaver",
      konto_id: konto.data.id,
      linjer: [{ beskrivelse: "Arbeid", antall: 1, enhetspris: 100, mva_sats: 0 }],
    });
    expect(f.data).toMatchObject({ avsender: "innehaver", konto_id: konto.data.id });
    expect((await kall("GET", `/api/org/${org}/fakturaer/${f.data.id}/pdf`)).status).toBe(200); // forhåndsvisning
    const u = await kall("POST", `/api/org/${org}/fakturaer/${f.data.id}/utsted`, { send_epost: false });
    expect(u.data.selger).toMatchObject({ navn: "Ola Nordmann", firmanavn: "Nordmann Snekkerservice", kontonr: "12345678903" });

    // Sletter vi kontoen, blir utstedte fakturaer som de er.
    expect((await kall("DELETE", `/api/org/${org}/kontoer/${konto.data.id}`)).status).toBe(204);
    expect((await kall("GET", `/api/org/${org}/fakturaer/${f.data.id}`)).data.selger.kontonr).toBe("12345678903");
  });

  it("privatperson uten org.nr.", async () => {
    const o = await kall("POST", "/api/organisasjoner", { navn: "Kari Privat", type: "privatperson" });
    expect(o.status).toBe(201);
    expect(o.data).toMatchObject({ type: "privatperson", orgnr: null, mva_registrert: false });
  });
});
