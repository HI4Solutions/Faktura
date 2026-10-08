// Kontogodkjenning: en ny konto kommer ikke inn før plattformadministratoren har godkjent den.
// Den nye brukeren velger modulene sine (Faktura, Bemanning, ...) ved registreringen, og
// administratorene får e-post med modulene når e-posten er bekreftet, navnet skrevet inn og
// modulene valgt. De godkjenner med modulene (eller andre), og brukeren får e-post om utfallet.
// Organisasjonene brukeren lager etterpå, får bare funksjonene i modulene. En invitasjon fra en
// organisasjon godkjenner kontoen.
import { beforeAll, describe, expect, it } from "vitest";
import { lagApi } from "../src/api.js";
import { config } from "../src/config.js";
import { settLokalOppgavekjorer, type Oppgave } from "../src/tjenester.js";

describe.skipIf(!process.env.DATABASE_URL)("kontogodkjenning", () => {
  const app = lagApi();
  const ko: Oppgave[] = [];
  const admin = "Bearer test:uid-konto-admin:konto-admin@server.test:mfa";
  // Nye brukere som venter (tokenet har «venter»).
  const nina = "Bearer test:uid-konto-nina:nina.konto@server.test:mfa::venter";
  const per = "Bearer test:uid-konto-per:per.konto@server.test:mfa:Per%20Pedersen:venter";
  const ivar = "Bearer test:uid-konto-ivar:ivar.konto@server.test:mfa:Ivar%20Invitert:venter";
  // Rett fra registreringen: e-postadressen er ikke bekreftet ennå, og så er den det.
  const unni = "Bearer test:uid-konto-unni:unni.konto@server.test:mfa:Unni%20Ung:venter:ubekreftet";
  const unniBekreftet = "Bearer test:uid-konto-unni:unni.konto@server.test:mfa:Unni%20Ung:venter";
  const eier = "Bearer test:uid-konto-eier:eier.konto@server.test:mfa";

  const kall = async (m: string, sti: string, hvem: string | null, k?: unknown) => {
    const r = await app.request(sti, {
      method: m,
      headers: { ...(hvem ? { authorization: hvem } : {}), "content-type": "application/json" },
      body: k === undefined ? undefined : JSON.stringify(k),
    });
    return { status: r.status, data: (await r.json().catch(() => null)) as any, headers: r.headers };
  };
  const eposter = (til: string) => ko.filter((o): o is Extract<Oppgave, { type: "epost" }> => o.type === "epost" && o.til.includes(til));
  const tilAdmin = (om: string) => eposter("konto-admin@server.test").filter((e) => e.tekst.includes(om));

  beforeAll(() => {
    settLokalOppgavekjorer(async (o) => {
      ko.push(o);
    });
    config.adminEposter.push("konto-admin@server.test");
  });

  it("modulene kan hentes uten innlogging", async () => {
    const r = await kall("GET", "/api/offentlig/moduler", null);
    expect(r.status).toBe(200);
    expect(r.data.map((m: any) => m.kode)).toEqual(["faktura", "bemanning"]);
    expect(r.data[1]).toMatchObject({ navn: "Bemanning", beskrivelse: expect.stringContaining("vaktplan") });
    expect(r.headers.get("cache-control")).toContain("max-age");
  });

  it("en ny konto venter, ser ingen organisasjoner og slipper ikke inn i resten", async () => {
    const meg = (await kall("GET", "/api/meg", nina)).data;
    expect(meg.bruker).toMatchObject({ epost: "nina.konto@server.test", status: "venter", moduler: [] });
    expect(meg.organisasjoner).toEqual([]);
    const r = await kall("POST", "/api/organisasjoner", nina, { navn: "Ninas firma AS" });
    expect(r.status).toBe(403);
    expect(r.data.error).toBe("Kontoen venter på godkjenning fra HI4 Faktura");
    expect((await kall("GET", "/api/kpi", nina)).status).toBe(403);
    expect(tilAdmin("nina.konto@server.test")).toHaveLength(0);
  });

  it("administratorene får e-post med modulene én gang når navn og moduler er på plass", async () => {
    // Navnet alene er ikke nok.
    expect((await kall("PATCH", "/api/meg", nina, { navn: "Nina Nilsen" })).data).toMatchObject({ navn: "Nina Nilsen", status: "venter", moduler: [] });
    expect(tilAdmin("nina.konto@server.test")).toHaveLength(0);
    // Modulene må finnes, og minst én.
    expect((await kall("PATCH", "/api/meg", nina, { moduler: [] })).status).toBe(400);
    expect((await kall("PATCH", "/api/meg", nina, { moduler: ["finnes_ikke"] })).data.error).toBe("Ukjent modul");
    expect((await kall("PATCH", "/api/meg", nina, {})).status).toBe(400);
    expect((await kall("PATCH", "/api/meg", nina, { moduler: ["bemanning", "faktura"] })).data).toMatchObject({ moduler: ["faktura", "bemanning"] });
    await kall("GET", "/api/meg", nina);
    const e = tilAdmin("nina.konto@server.test");
    expect(e).toHaveLength(1);
    expect(e[0]!.emne).toBe("Ny konto venter på godkjenning: Nina Nilsen");
    expect(e[0]!.tekst).toContain("Moduler: Faktura og Bemanning");
    expect(e[0]!.tekst).toContain("/admin?fane=venter");
    // Med navnet fra innloggingen går e-posten når modulene er valgt.
    await kall("GET", "/api/meg", per);
    expect(tilAdmin("per.konto@server.test")).toHaveLength(0);
    await kall("PATCH", "/api/meg", per, { moduler: ["bemanning"] });
    expect(tilAdmin("per.konto@server.test").map((x) => x.tekst)).toEqual([expect.stringContaining("Moduler: Bemanning")]);
  });

  it("modulene lagres rett fra registreringen, og forespørselen går når e-postadressen er bekreftet", async () => {
    expect((await kall("POST", "/api/organisasjoner", unni, { navn: "Unnis firma AS" })).data.error).toBe("Bekreft e-postadressen din først");
    expect((await kall("PATCH", "/api/meg", unni, { navn: "Unni Ung", moduler: ["faktura"] })).data).toMatchObject({ moduler: ["faktura"] });
    expect(tilAdmin("unni.konto@server.test")).toHaveLength(0);
    await kall("GET", "/api/meg", unniBekreftet);
    expect(tilAdmin("unni.konto@server.test").map((x) => x.tekst)).toEqual([expect.stringContaining("Moduler: Faktura")]);
  });

  it("bare plattformadministratoren ser og godkjenner kontoene, med modulene", async () => {
    expect((await kall("GET", "/api/admin/kontoer", nina)).status).toBe(403);
    const venter = (await kall("GET", "/api/admin/kontoer", admin)).data;
    expect(venter.map((v: any) => v.epost)).toEqual(expect.arrayContaining(["nina.konto@server.test", "per.konto@server.test"]));
    expect(venter.find((v: any) => v.epost === "nina.konto@server.test").moduler).toEqual(["faktura", "bemanning"]);
    expect((await kall("GET", "/api/admin/brukere", admin)).data.find((b: any) => b.epost === "nina.konto@server.test")).toMatchObject({ status: "venter" });
    const id = venter.find((v: any) => v.epost === "nina.konto@server.test").id;
    expect((await kall("POST", `/api/admin/brukere/${id}/godkjenning`, nina, { godkjent: true })).status).toBe(403);
    expect((await kall("POST", `/api/admin/brukere/${id}/godkjenning`, admin, { godkjent: true, moduler: [] })).status).toBe(400);
    // Administratoren godkjenner bare Faktura.
    const r = await kall("POST", `/api/admin/brukere/${id}/godkjenning`, admin, { godkjent: true, moduler: ["faktura"] });
    expect(r.data).toMatchObject({ status: "godkjent", moduler: ["Faktura"] });
    const e = eposter("nina.konto@server.test").at(-1)!;
    expect(e.emne).toBe("Kontoen din i HI4 Faktura er godkjent");
    expect(e.tekst).toContain("Hei Nina,");
    expect(e.tekst).toContain("godkjent med Faktura");
    expect((await kall("GET", "/api/admin/brukere", admin)).data.find((b: any) => b.id === id)).toMatchObject({ status: "godkjent", moduler: ["faktura"] });
    // Nå kommer Nina inn, og organisasjonen hennes får bare funksjonene i Faktura.
    const meg = (await kall("GET", "/api/meg", nina)).data;
    expect(meg.bruker).toMatchObject({ status: "godkjent", moduler: ["faktura"] });
    // Modulene endres ikke av brukeren etter godkjenningen.
    expect((await kall("PATCH", "/api/meg", nina, { moduler: ["bemanning"] })).data.error).toBe("Kontoen er alt behandlet");
    const org = (await kall("POST", "/api/organisasjoner", nina, { navn: "Ninas firma AS" })).data;
    expect(org.id).toBeTruthy();
    const funksjoner = (await kall("GET", "/api/meg", nina)).data.organisasjoner.find((o: any) => o.id === org.id).funksjoner;
    expect(funksjoner).toContain("bank");
    expect(funksjoner).not.toContain("ansatte");
    expect(funksjoner).not.toContain("vaktplan");
    expect((await kall("GET", `/api/org/${org.id}/ansatte`, nina)).status).toBe(403);
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
