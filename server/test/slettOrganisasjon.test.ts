// Sletting av organisasjoner: eieren (med grunn) sletter en organisasjon uten utstedte fakturaer
// helt, og plattformadministratorene får e-post med grunnen. Plattformadministratoren stenger en
// organisasjon med utstedte fakturaer (de oppbevares), og eierne får e-post. Administrasjonen
// viser de slettede med grunnen.
import { beforeAll, describe, expect, it } from "vitest";
import { lagApi } from "../src/api.js";
import { config } from "../src/config.js";
import { settLokalOppgavekjorer, type Oppgave } from "../src/tjenester.js";

describe.skipIf(!process.env.DATABASE_URL)("Sletting av organisasjoner", () => {
  const app = lagApi();
  const ko: Oppgave[] = [];
  const admin = "Bearer test:uid-slettorg-admin:slettorg-admin@server.test:mfa";
  const eier = "Bearer test:uid-slettorg-eier:slettorg-eier@server.test:mfa:Eva%20Eier";
  const fakt = "Bearer test:uid-slettorg-fakt:slettorg-fakt@server.test:mfa";
  let a: string;
  let b: string;

  const kall = async (m: string, sti: string, k?: unknown, hvem = eier) => {
    const r = await app.request(sti, { method: m, headers: { authorization: hvem, "content-type": "application/json" }, body: k === undefined ? undefined : JSON.stringify(k) });
    return { status: r.status, data: (r.headers.get("content-type") ?? "").includes("json") ? ((await r.json()) as any) : null };
  };
  const eposter = (til: string) => ko.filter((o): o is Extract<Oppgave, { type: "epost" }> => o.type === "epost" && o.til.includes(til));

  beforeAll(async () => {
    settLokalOppgavekjorer(async (o) => {
      ko.push(o);
    });
    config.adminEposter.push("slettorg-admin@server.test");
    a = (await kall("POST", "/api/organisasjoner", { navn: "Prøve AS" })).data.id;
    await kall("POST", `/api/org/${a}/kunder`, { navn: "Kari Kunde", type: "person" });
    const inv = await kall("POST", `/api/org/${a}/invitasjoner`, { epost: "slettorg-fakt@server.test", rolle: "fakturerer" });
    expect((await kall("POST", "/api/invitasjoner/aksepter", { token: inv.data.lenke.split("/").pop() }, fakt)).status).toBe(200);
    // B har en utstedt faktura.
    b = (await kall("POST", "/api/organisasjoner", { navn: "Ferdig Drift AS" })).data.id;
    await kall("PATCH", `/api/org/${b}`, { kontonr: "86011117947" });
    const kunde = (await kall("POST", `/api/org/${b}/kunder`, { navn: "Berit Kunde", type: "person", epost: "berit@kunde.no" })).data.id;
    const f = await kall("POST", `/api/org/${b}/fakturaer`, { kunde_id: kunde, linjer: [{ beskrivelse: "Husleie", antall: 1, enhetspris: 1000, mva_sats: 0 }] });
    expect((await kall("POST", `/api/org/${b}/fakturaer/${f.data.id}/utsted`, {})).status).toBe(200);
  });

  it("bare eieren sletter, og alltid med grunn", async () => {
    expect((await kall("POST", `/api/org/${a}/slett`, { grunn: "Vil ikke mer" }, fakt)).status).toBe(403);
    expect((await kall("POST", `/api/org/${a}/slett`, {})).data.error).toBe("Skriv hvorfor organisasjonen slettes");
    expect((await kall("POST", `/api/org/${a}/slett`, { grunn: "  " })).status).toBe(400);
  });

  it("eieren sletter en organisasjon uten utstedte fakturaer helt", async () => {
    const r = await kall("POST", `/api/org/${a}/slett`, { grunn: "Laget for å prøve" });
    expect(r.data).toMatchObject({ navn: "Prøve AS", grunn: "Laget for å prøve", antall_fakturaer: 0, oppbevares_til: null });
    expect((await kall("GET", "/api/meg")).data.organisasjoner.map((o: any) => o.id)).not.toContain(a);
    expect((await kall("GET", "/api/meg", undefined, fakt)).data.organisasjoner).toEqual([]);
    expect((await kall("GET", `/api/org/${a}`)).status).toBe(404);
    expect((await kall("GET", `/api/org/${a}/kunder`)).data).toEqual([]);
    const e = eposter("slettorg-admin@server.test").at(-1)!;
    expect(e.emne).toBe("Organisasjon slettet: Prøve AS");
    expect(e.tekst).toContain("er slettet av eieren, Eva Eier (slettorg-eier@server.test)");
    expect(e.tekst).toContain("Grunn: Laget for å prøve");
    expect(e.tekst).toContain("Alt er slettet.");
  });

  it("plattformadministratoren stenger en organisasjon med utstedte fakturaer, og eierne får vite hvorfor", async () => {
    expect((await kall("POST", `/api/admin/organisasjoner/${b}/slett`, { grunn: "Konkurs" })).status).toBe(403);
    expect((await kall("POST", `/api/admin/organisasjoner/${b}/slett`, { grunn: "" }, admin)).status).toBe(400);
    const r = await kall("POST", `/api/admin/organisasjoner/${b}/slett`, { grunn: "Konkurs" }, admin);
    const aar = new Date().getFullYear() + 5;
    expect(r.data).toMatchObject({ navn: "Ferdig Drift AS", antall_fakturaer: 1, oppbevares_til: `${aar}-12-31` });
    expect((await kall("GET", "/api/meg")).data.organisasjoner.map((o: any) => o.id)).not.toContain(b);
    const e = eposter("slettorg-eier@server.test").at(-1)!;
    expect(e.emne).toBe("Ferdig Drift AS er slettet fra HI4 Faktura");
    expect(e.tekst).toContain("Grunn: Konkurs");
    expect(e.tekst).toContain(`1 utstedt faktura oppbevares til 31.12.${aar}`);
    // Ikke i administrasjonens liste, men blant de slettede, med grunnen.
    expect((await kall("GET", "/api/admin/organisasjoner", undefined, admin)).data.map((o: any) => o.id)).not.toContain(b);
    const slettede = (await kall("GET", "/api/admin/slettede", undefined, admin)).data;
    expect(slettede.find((s: any) => s.id === b)).toMatchObject({ grunn: "Konkurs", av_plattformen: true, antall_fakturaer: 1 });
    expect(slettede.find((s: any) => s.id === a)).toMatchObject({ grunn: "Laget for å prøve", av_plattformen: false, oppbevares_til: null });
    expect((await kall("GET", "/api/admin/slettede")).status).toBe(403);
    expect((await kall("POST", `/api/admin/organisasjoner/${b}/slett`, { grunn: "Igjen" }, admin)).status).toBe(404);
  });
});
