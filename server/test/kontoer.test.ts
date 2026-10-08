// Kontogodkjenning: en ny konto kommer ikke inn før plattformadministratoren har godkjent den.
// Administratorene får e-post når e-posten er bekreftet og navnet skrevet inn, og brukeren får
// e-post om utfallet. En invitasjon fra en organisasjon godkjenner kontoen.
import { beforeAll, describe, expect, it } from "vitest";
import { lagApi } from "../src/api.js";
import { config } from "../src/config.js";
import { settLokalOppgavekjorer, type Oppgave } from "../src/tjenester.js";

describe.skipIf(!process.env.DATABASE_URL)("kontogodkjenning", () => {
  const app = lagApi();
  const ko: Oppgave[] = [];
  const admin = "Bearer test:uid-konto-admin:konto-admin@server.test:mfa";
  // Nye brukere som venter (tokenet slutter med «venter»).
  const nina = "Bearer test:uid-konto-nina:nina.konto@server.test:mfa::venter";
  const per = "Bearer test:uid-konto-per:per.konto@server.test:mfa:Per%20Pedersen:venter";
  const ivar = "Bearer test:uid-konto-ivar:ivar.konto@server.test:mfa:Ivar%20Invitert:venter";
  const eier = "Bearer test:uid-konto-eier:eier.konto@server.test:mfa";

  const kall = async (m: string, sti: string, hvem: string, k?: unknown) => {
    const r = await app.request(sti, { method: m, headers: { authorization: hvem, "content-type": "application/json" }, body: k === undefined ? undefined : JSON.stringify(k) });
    return { status: r.status, data: (await r.json().catch(() => null)) as any };
  };
  const eposter = (til: string) => ko.filter((o): o is Extract<Oppgave, { type: "epost" }> => o.type === "epost" && o.til.includes(til));

  beforeAll(() => {
    settLokalOppgavekjorer(async (o) => {
      ko.push(o);
    });
    config.adminEposter.push("konto-admin@server.test");
  });

  it("en ny konto venter, ser ingen organisasjoner og slipper ikke inn i resten", async () => {
    const meg = (await kall("GET", "/api/meg", nina)).data;
    expect(meg.bruker).toMatchObject({ epost: "nina.konto@server.test", status: "venter" });
    expect(meg.organisasjoner).toEqual([]);
    const r = await kall("POST", "/api/organisasjoner", nina, { navn: "Ninas firma AS" });
    expect(r.status).toBe(403);
    expect(r.data.error).toBe("Kontoen venter på godkjenning fra HI4 Faktura");
    expect((await kall("GET", "/api/kpi", nina)).status).toBe(403);
    // Uten navn får administratorene ikke beskjed ennå.
    expect(eposter("konto-admin@server.test").filter((e) => e.tekst.includes("nina.konto@server.test"))).toHaveLength(0);
  });

  it("administratorene får e-post én gang når navnet er skrevet inn", async () => {
    expect((await kall("PATCH", "/api/meg", nina, { navn: "Nina Nilsen" })).data).toMatchObject({ navn: "Nina Nilsen", status: "venter" });
    await kall("GET", "/api/meg", nina);
    const e = eposter("konto-admin@server.test").filter((x) => x.tekst.includes("nina.konto@server.test"));
    expect(e).toHaveLength(1);
    expect(e[0]!.emne).toBe("Ny konto venter på godkjenning: Nina Nilsen");
    expect(e[0]!.tekst).toContain("/admin?fane=venter");
    // Med navn fra innloggingen (f.eks. Google) går e-posten med en gang.
    await kall("GET", "/api/meg", per);
    expect(eposter("konto-admin@server.test").filter((x) => x.tekst.includes("per.konto@server.test"))).toHaveLength(1);
  });

  it("bare plattformadministratoren ser og godkjenner kontoene", async () => {
    expect((await kall("GET", "/api/admin/kontoer", nina)).status).toBe(403);
    const venter = (await kall("GET", "/api/admin/kontoer", admin)).data;
    expect(venter.map((v: any) => v.epost)).toEqual(expect.arrayContaining(["nina.konto@server.test", "per.konto@server.test"]));
    expect((await kall("GET", "/api/admin/brukere", admin)).data.find((b: any) => b.epost === "nina.konto@server.test")).toMatchObject({ status: "venter" });
    const id = venter.find((v: any) => v.epost === "nina.konto@server.test").id;
    expect((await kall("POST", `/api/admin/brukere/${id}/godkjenning`, nina, { godkjent: true })).status).toBe(403);
    const r = await kall("POST", `/api/admin/brukere/${id}/godkjenning`, admin, { godkjent: true });
    expect(r.data).toMatchObject({ status: "godkjent" });
    const e = eposter("nina.konto@server.test").at(-1)!;
    expect(e.emne).toBe("Kontoen din i HI4 Faktura er godkjent");
    expect(e.tekst).toContain("Hei Nina,");
    // Nå kommer Nina inn.
    expect((await kall("GET", "/api/meg", nina)).data.bruker.status).toBe("godkjent");
    expect((await kall("POST", "/api/organisasjoner", nina, { navn: "Ninas firma AS" })).status).toBe(201);
  });

  it("en avvist konto kommer ikke inn, og får vite hvorfor", async () => {
    const id = (await kall("GET", "/api/admin/kontoer", admin)).data.find((v: any) => v.epost === "per.konto@server.test").id;
    expect((await kall("POST", `/api/admin/brukere/${id}/godkjenning`, admin, { godkjent: false, grunn: "Ukjent foretak" })).data).toMatchObject({
      status: "avvist",
      avvist_grunn: "Ukjent foretak",
    });
    expect(eposter("per.konto@server.test").at(-1)!.tekst).toContain("Begrunnelse: Ukjent foretak");
    expect((await kall("GET", "/api/meg", per)).data.bruker).toMatchObject({ status: "avvist", avvist_grunn: "Ukjent foretak" });
    expect((await kall("POST", "/api/organisasjoner", per, { navn: "Pers firma AS" })).data.error).toBe("Kontoen er ikke godkjent");
  });

  it("en invitasjon fra en organisasjon godkjenner kontoen", async () => {
    const org = (await kall("POST", "/api/organisasjoner", eier, { navn: "Invitasjon Konto AS" })).data.id;
    const inv = (await kall("POST", `/api/org/${org}/invitasjoner`, eier, { epost: "ivar.konto@server.test", rolle: "fakturerer" })).data;
    const token = String(inv.lenke ?? inv.token ?? "").split("/").pop();
    expect((await kall("GET", "/api/meg", ivar)).data.bruker.status).toBe("venter");
    expect((await kall("POST", "/api/invitasjoner/aksepter", ivar, { token })).data.org_id).toBe(org);
    const meg = (await kall("GET", "/api/meg", ivar)).data;
    expect(meg.bruker.status).toBe("godkjent");
    expect(meg.organisasjoner.map((o: any) => o.id)).toContain(org);
  });

  it("plattformadministratoren og brukere fra før trenger ingen godkjenning", async () => {
    expect((await kall("GET", "/api/meg", admin)).data.bruker.status).toBe("godkjent");
    expect((await kall("GET", "/api/meg", eier)).data.bruker.status).toBe("godkjent");
  });
});
