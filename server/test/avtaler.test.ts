// Bruksvilkårene og databehandleravtalen (0122_avtaler.sql, server/src/avtaler.ts): versjonene og
// adressene, godkjenningen når en organisasjon opprettes og senere, og at versjonen i databasen er
// den som står i dokumentene på nettstedet (landingsside/). Også videresendingen av gamle lenker til
// appen fra nettstedet og domenet passkeys hører til når appen ligger på app.<domene>
// (docs/domene.md).
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { lagApi } from "../src/api.js";
import { config } from "../src/config.js";
import { passkeyDomene } from "../src/passkey.js";

const dokument = (fil: string) => readFileSync(new URL(`../../landingsside/${fil}`, import.meta.url), "utf8");
// «Versjon» i tittelfeltet på dokumentet.
const versjonI = (html: string) => /Versjon<\/span><span class="v">([^<]+)</.exec(html)?.[1];

describe("passkeys når appen ligger på et underdomene", () => {
  it("hører til nettstedets domene, så de gamle virker videre", () => {
    expect(passkeyDomene("app.adminkonsoll.no", "https://adminkonsoll.no")).toBe("adminkonsoll.no");
    expect(passkeyDomene("adminkonsoll.no", "https://adminkonsoll.no")).toBe("adminkonsoll.no");
    expect(passkeyDomene("app.test.adminkonsoll.no", "https://test.adminkonsoll.no")).toBe("test.adminkonsoll.no");
    expect(passkeyDomene("test.adminkonsoll.no", "https://test.adminkonsoll.no")).toBe("test.adminkonsoll.no");
  });
  it("andre domener og uten nettsted: domenet brukeren er på", () => {
    expect(passkeyDomene("faktura.hi4.no", "https://adminkonsoll.no")).toBe("faktura.hi4.no");
    expect(passkeyDomene("annet-adminkonsoll.no", "https://adminkonsoll.no")).toBe("annet-adminkonsoll.no");
    expect(passkeyDomene("localhost", undefined)).toBe("localhost");
  });
});

describe("gamle lenker til appen fra nettstedet", () => {
  const app = lagApi();
  const hent = (sti: string, vert?: string, metode = "GET") =>
    app.request(sti, { method: metode, redirect: "manual", headers: vert ? { "x-forwarded-host": vert } : {} });

  it("sendes videre til appen med samme sti og spørring", async () => {
    const r = await hent("/bank/tilbake?code=abc&state=x", "adminkonsoll.no");
    expect(r.status).toBe(301);
    expect(r.headers.get("location")).toBe(`${config.appUrl}/bank/tilbake?code=abc&state=x`);
    const h = await hent("/fakturaer/123", undefined, "HEAD");
    expect(h.status).toBe(301);
    expect(h.headers.get("location")).toBe(`${config.appUrl}/fakturaer/123`);
  });

  it("API-adressene, andre metoder og appens eget domene svarer som før", async () => {
    const api = await hent("/api/offentlig/finnes-ikke", "adminkonsoll.no");
    expect(api.status).toBe(404);
    expect(await api.json()).toEqual({ error: "Finnes ikke" });
    expect((await hent("/api/meg", "adminkonsoll.no")).status).toBe(401);
    expect((await hent("/fakturaer", "adminkonsoll.no", "POST")).status).toBe(404);
    expect((await hent("/fakturaer", new URL(config.appUrl).host)).status).toBe(404);
  });
});

describe.skipIf(!process.env.DATABASE_URL)("bruksvilkår og databehandleravtale", () => {
  const app = lagApi();
  const eier = "Bearer test:uid-avtaler-eier:avtaler-eier@server.test:mfa:Eva%20Eier";
  const fakt = "Bearer test:uid-avtaler-fakt:avtaler-fakt@server.test:mfa";
  const kall = async (m: string, sti: string, k?: unknown, hvem = eier) => {
    const r = await app.request(sti, { method: m, headers: { authorization: hvem, "content-type": "application/json" }, body: k === undefined ? undefined : JSON.stringify(k) });
    return { status: r.status, data: (await r.json().catch(() => null)) as any };
  };
  const meg = async (org: string, hvem = eier) => (await kall("GET", "/api/meg", undefined, hvem)).data.organisasjoner.find((o: any) => o.id === org);
  const gjeldende = { vilkar: "1.0", databehandleravtale: "1.0" };

  beforeAll(async () => {
    // Kontoene finnes (og er godkjent, som testbrukere) før organisasjonene opprettes.
    await kall("GET", "/api/meg");
    await kall("GET", "/api/meg", undefined, fakt);
  });

  it("versjonene og adressene på nettstedet", async () => {
    const r = await kall("GET", "/api/offentlig/avtaler", undefined, "");
    expect(r.status).toBe(200);
    expect(r.data).toEqual({
      vilkar: { type: "vilkar", navn: "Bruksvilkår", versjon: "1.0", oppdatert: "2026-10-16", url: "https://adminkonsoll.no/vilkar.html" },
      databehandleravtale: {
        type: "databehandleravtale", navn: "Databehandleravtale", versjon: "1.0", oppdatert: "2026-10-16", url: "https://adminkonsoll.no/databehandleravtale.html",
      },
    });
  });

  it("versjonen i databasen er den som står i dokumentene", async () => {
    const r = (await kall("GET", "/api/offentlig/avtaler", undefined, "")).data;
    expect(versjonI(dokument("vilkar.html"))).toBe(r.vilkar.versjon);
    expect(versjonI(dokument("databehandleravtale.html"))).toBe(r.databehandleravtale.versjon);
    expect(dokument("vilkar.html")).toContain(`<time datetime="${r.vilkar.oppdatert}">`);
    expect(dokument("databehandleravtale.html")).toContain(`<time datetime="${r.databehandleravtale.oppdatert}">`);
  });

  it("godtatt når organisasjonen opprettes med versjonene brukeren fikk se", async () => {
    const r = await kall("POST", "/api/organisasjoner", { navn: "Avtaler Med AS", orgnr: "315000165", avtaler: gjeldende });
    expect(r.status).toBe(201);
    expect((await meg(r.data.id)).avtaler_godtatt).toBe(true);
    const a = (await kall("GET", `/api/org/${r.data.id}/avtaler`)).data;
    expect(a.godtatt).toBe(true);
    expect(a.godkjenninger).toHaveLength(1);
    expect(a.godkjenninger[0]).toMatchObject({ vilkar_versjon: "1.0", databehandleravtale_versjon: "1.0", godtatt_av_navn: "Eva Eier", godtatt_av_epost: "avtaler-eier@server.test" });
    expect(a.gjeldende.vilkar.url).toBe("https://adminkonsoll.no/vilkar.html");
  });

  it("feil versjon gir 409, og organisasjonen opprettes ikke", async () => {
    const for_ = (await kall("GET", "/api/meg")).data.organisasjoner.length;
    const r = await kall("POST", "/api/organisasjoner", { navn: "Avtaler Gammel AS", orgnr: "315000173", avtaler: { vilkar: "0.9", databehandleravtale: "1.0" } });
    expect(r.status).toBe(409);
    expect(r.data.error).toContain("Last den inn på nytt");
    expect((await kall("GET", "/api/meg")).data.organisasjoner).toHaveLength(for_);
    expect((await kall("POST", "/api/organisasjoner", { navn: "X", avtaler: { vilkar: "1.0" } })).status).toBe(400);
  });

  it("uten versjonene må eier eller administrator godta etterpå", async () => {
    const org = (await kall("POST", "/api/organisasjoner", { navn: "Avtaler Uten AS", orgnr: "315000181" })).data.id;
    expect((await meg(org)).avtaler_godtatt).toBe(false);
    const inv = (await kall("POST", `/api/org/${org}/invitasjoner`, { epost: "avtaler-fakt@server.test", rolle: "fakturerer" })).data;
    expect((await kall("POST", "/api/invitasjoner/aksepter", { token: inv.lenke.split("/").pop() }, fakt)).status).toBe(200);

    // Fakturereren ser at det mangler, men kan ikke godta og ser ikke hvem som har godtatt.
    expect((await meg(org, fakt)).avtaler_godtatt).toBe(false);
    expect((await kall("POST", `/api/org/${org}/avtaler`, gjeldende, fakt)).status).toBe(403);
    expect((await kall("GET", `/api/org/${org}/avtaler`, undefined, fakt)).data.godkjenninger).toEqual([]);

    expect((await kall("POST", `/api/org/${org}/avtaler`, { vilkar: "1.0", databehandleravtale: "2.0" })).status).toBe(409);
    expect((await kall("POST", `/api/org/${org}/avtaler`, { vilkar: "1.0", databehandleravtale: "1.0", annet: 1 })).status).toBe(400);
    const g = await kall("POST", `/api/org/${org}/avtaler`, gjeldende);
    expect(g.status).toBe(201);
    expect(g.data).toMatchObject({ org_id: org, vilkar_versjon: "1.0", databehandleravtale_versjon: "1.0" });
    expect((await meg(org)).avtaler_godtatt).toBe(true);
    expect((await meg(org, fakt)).avtaler_godtatt).toBe(true);
  });
});
