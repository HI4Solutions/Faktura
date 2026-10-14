// Egne roller (0111_tilgangsroller.sql) og modulene (0110_moduler.sql) gjennom API-et: eieren lager
// rollene og velger modulene, inviterer med en rolle og bytter rolle; hver rolle får det modulene
// gir (fakturaene, de ansatte, lønnen, regnskapet og rapportene), og ikke administrasjonen.
// Varslene går til dem med modulen, og plattformadministratoren kan slå av Faktura.
import { beforeAll, describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { lagApi } from "../src/api.js";
import { glemFunksjoner } from "../src/funksjoner.js";
import { settLokalOppgavekjorer, type Oppgave } from "../src/tjenester.js";

describe.skipIf(!process.env.DATABASE_URL)("egne roller med modultilgang", () => {
  const app = lagApi();
  const eier = "Bearer test:uid-troller-eier:troller-eier@server.test:mfa";
  const anne = "Bearer test:uid-troller-anne:troller-anne@server.test:mfa";
  const admin = "Bearer test:uid-troller-admin:troller-admin@server.test:mfa";
  const ko: Oppgave[] = [];
  const roller: Record<string, string> = {};
  let org: string;
  let kari: string;
  let anneId: string;

  const kall = async (m: string, sti: string, k?: unknown, hvem = eier) => {
    const r = await app.request(sti, { method: m, headers: { authorization: hvem, "content-type": "application/json" }, body: k === undefined ? undefined : JSON.stringify(k) });
    const type = r.headers.get("content-type") ?? "";
    return { status: r.status, data: type.includes("json") ? ((await r.json()) as any) : await r.text() };
  };
  const somAnne = (sti: string) => kall("GET", `/api/org/${org}${sti}`, undefined, anne);
  const giRolle = async (rolle: string) =>
    expect((await kall("PATCH", `/api/org/${org}/medlemmer/${anneId}`, { rolle: "tilpasset", tilgangsrolle_id: roller[rolle] })).status).toBe(204);
  const rapportmoduler = async () => ((await somAnne("/rapportmodul")).data.moduler as { id: string }[]).map((m) => m.id);

  beforeAll(async () => {
    settLokalOppgavekjorer(async (o) => {
      ko.push(o);
    });
    config.adminEposter.push("troller-admin@server.test");
    org = (await kall("POST", "/api/organisasjoner", { navn: "Rolleklinikken AS" })).data.id;
    expect((await kall("PUT", `/api/org/${org}/lonn-oppsett`, { aktiv: true })).status).toBe(200);
    expect((await kall("POST", `/api/org/${org}/kunder`, { navn: "Pasient AS" })).status).toBe(201);
    const k = await kall("POST", `/api/org/${org}/ansatte`, { fornavn: "Kari", etternavn: "Hansen", ansatt_fra: "2025-01-01", lonnstype: "maaned", maanedslonn: 50000 });
    expect(k.status).toBe(201);
    kari = k.data.id;
    expect((await kall("POST", `/api/org/${org}/lonn/kjoringer`, { periode: "2026-10" })).status).toBe(201);
  });

  it("eieren lager rollene, og Lønn tar med Personal", async () => {
    const lag = (navn: string, moduler: string[]) => kall("POST", `/api/org/${org}/tilgangsroller`, { navn, moduler });
    const ok = await lag("Økonomiansvarlig", ["regnskap", "faktura"]);
    expect(ok.status).toBe(201);
    expect(ok.data).toMatchObject({ navn: "Økonomiansvarlig", moduler: ["faktura", "regnskap"], brukere: 0, invitert: 0 });
    roller.okonomi = ok.data.id;
    roller.hr = (await lag("Personalansvarlig", ["personal"])).data.id;
    const l = await lag("Lønnsansvarlig", ["lonn"]);
    expect(l.data.moduler).toEqual(["personal", "lonn"]);
    roller.lonn = l.data.id;
    roller.leder = (await lag("Daglig leder", ["faktura", "personal", "lonn", "regnskap"])).data.id;
    roller.vikar = (await lag("Vikar", [])).data.id;
    expect((await lag(" økonomiansvarlig ", [])).status).toBe(409);
    expect((await lag("X", [])).status).toBe(400);
    expect((await lag("Ukjent", ["bemanning"])).status).toBe(400);
    const liste = (await kall("GET", `/api/org/${org}/tilgangsroller`)).data as { navn: string }[];
    expect(liste.map((r) => r.navn).sort()).toEqual(["Daglig leder", "Lønnsansvarlig", "Personalansvarlig", "Vikar", "Økonomiansvarlig"].sort());
    const endret = await kall("PUT", `/api/org/${org}/tilgangsroller/${roller.vikar}`, { navn: "Vikar uten tilgang", beskrivelse: "Bare sitt eget", moduler: [] });
    expect(endret.data).toMatchObject({ navn: "Vikar uten tilgang", beskrivelse: "Bare sitt eget", moduler: [] });
  });

  it("invitasjonen gir rollen, og appen får rollen og modulene", async () => {
    expect((await kall("POST", `/api/org/${org}/invitasjoner`, { epost: "x@server.test", rolle: "tilpasset" })).status).toBe(400);
    expect((await kall("POST", `/api/org/${org}/invitasjoner`, { epost: "x@server.test", rolle: "les", tilgangsrolle_id: roller.hr })).status).toBe(400);
    const inv = await kall("POST", `/api/org/${org}/invitasjoner`, { epost: "troller-anne@server.test", rolle: "tilpasset", tilgangsrolle_id: roller.okonomi });
    expect(inv.status).toBe(201);
    const rolle = async () => ((await kall("GET", `/api/org/${org}/tilgangsroller`)).data as any[]).find((r) => r.id === roller.okonomi);
    expect(await rolle()).toMatchObject({ brukere: 0, invitert: 1 });
    expect((await kall("POST", "/api/invitasjoner/aksepter", { token: inv.data.lenke.split("/").pop() }, anne)).status).toBe(200);
    expect(await rolle()).toMatchObject({ brukere: 1, invitert: 0 });
    const meg = (await kall("GET", "/api/meg", undefined, anne)).data;
    anneId = meg.bruker.id;
    expect(meg.organisasjoner.find((o: any) => o.id === org)).toMatchObject({
      rolle: "tilpasset",
      tilgangsrolle: "Økonomiansvarlig",
      rollemoduler: ["faktura", "regnskap"],
      moduler: ["faktura", "personal", "lonn", "regnskap"],
    });
    const medlemmer = (await kall("GET", `/api/org/${org}/medlemmer`)).data as any[];
    expect(medlemmer.find((m) => m.bruker_id === anneId)).toMatchObject({ rolle: "tilpasset", tilgangsrolle: "Økonomiansvarlig" });
  });

  it("økonomiansvarlig: fakturaene og regnskapet, ikke personalet, lønnen eller administrasjonen", async () => {
    expect((await somAnne("/kunder")).data).toHaveLength(1);
    expect((await kall("POST", `/api/org/${org}/kunder`, { navn: "Ny kunde AS" }, anne)).status).toBe(201);
    expect((await somAnne("/regnskap/saldobalanse?aar=2026")).status).toBe(200);
    expect((await somAnne("/ansatte")).status).toBe(403);
    expect((await somAnne("/lonn/kjoringer")).status).toBe(403);
    expect((await kall("POST", `/api/org/${org}/tilgangsroller`, { navn: "Egen", moduler: [] }, anne)).status).toBe(403);
    expect((await kall("PATCH", `/api/org/${org}/medlemmer/${anneId}`, { rolle: "admin" }, anne)).status).toBe(403);
    expect(await rapportmoduler()).toEqual(expect.arrayContaining(["faktura", "regnskap"]));
    expect(await rapportmoduler()).not.toContain("personal");
    expect(await rapportmoduler()).not.toContain("lonn");
  });

  it("personalansvarlig: de ansatte, men ikke lønnskjøringene eller fakturaene", async () => {
    await giRolle("hr");
    expect((await somAnne("/ansatte")).data).toHaveLength(1);
    expect((await somAnne("/lonn/kjoringer")).status).toBe(403);
    expect((await somAnne("/kunder")).data).toHaveLength(0);
    expect((await kall("POST", `/api/org/${org}/kunder`, { navn: "Ikke lov AS" }, anne)).status).toBe(403);
    expect((await somAnne("/regnskap/saldobalanse?aar=2026")).status).toBe(403);
    const moduler = await rapportmoduler();
    expect(moduler).toContain("personal");
    expect(moduler).not.toContain("lonn");
    expect(moduler).not.toContain("faktura");
    // Varslene om timer går til personalansvarlig.
    ko.length = 0;
    expect((await kall("POST", `/api/org/${org}/timer`, { ansatt_id: kari, dato: "2026-10-05", fra: "08:00", til: "16:00", pause_min: 30 })).status).toBe(201);
    expect((await kall("POST", `/api/org/${org}/timer/lever`, { ansatt_id: kari, fra: "2026-10-05", til: "2026-10-11" })).status).toBe(200);
    const varsel = ko.find((o: any) => o.type === "varsel" && o.varsel.hendelse === "timer") as any;
    expect(varsel?.varsel.bruker_ider).toContain(anneId);
  });

  it("lønnsansvarlig: lønnen og de ansatte", async () => {
    await giRolle("lonn");
    expect((await somAnne("/lonn/kjoringer")).data).toHaveLength(1);
    expect((await somAnne("/ansatte")).data).toHaveLength(1);
    expect((await somAnne("/kunder")).data).toHaveLength(0);
    expect(await rapportmoduler()).toEqual(expect.arrayContaining(["personal", "lonn"]));
  });

  it("en rolle uten moduler er som rollen ansatt", async () => {
    await giRolle("vikar");
    expect((await somAnne("/ansatte")).status).toBe(403);
    expect((await somAnne("/kunder")).data).toHaveLength(0);
    expect((await somAnne("/lonn/kjoringer")).status).toBe(403);
    // Og en egen rolle kan byttes til (og fra) den faste rollen ansatt.
    expect((await kall("PATCH", `/api/org/${org}/medlemmer/${anneId}`, { rolle: "ansatt" })).status).toBe(204);
    expect((await kall("GET", "/api/meg", undefined, anne)).data.organisasjoner.find((x: any) => x.id === org)).toMatchObject({ rolle: "ansatt", tilgangsrolle: null });
    await giRolle("vikar");
  });

  it("en rolle kan ikke slettes mens noen har den", async () => {
    expect((await kall("DELETE", `/api/org/${org}/tilgangsroller/${roller.vikar}`)).status).toBe(409);
    await giRolle("leder");
    expect((await kall("DELETE", `/api/org/${org}/tilgangsroller/${roller.vikar}`)).status).toBe(204);
    expect(((await kall("GET", `/api/org/${org}/tilgangsroller`)).data as any[]).find((r) => r.id === roller.leder).brukere).toBe(1);
  });

  it("plattformadministratoren slår av Faktura: rutene avvises og appen får modulene", async () => {
    expect((await kall("PUT", `/api/admin/organisasjoner/${org}/funksjoner`, { faktura: false }, admin)).status).toBe(200);
    glemFunksjoner();
    const f = await kall("GET", `/api/org/${org}/fakturaer`);
    expect(f.status).toBe(403);
    expect(f.data.error).toBe("Faktura er ikke slått på for organisasjonen");
    expect((await kall("GET", `/api/org/${org}/kunder`)).status).toBe(403);
    expect((await kall("GET", `/api/org/${org}/ansatte`)).status).toBe(200);
    const o = (await kall("GET", "/api/meg")).data.organisasjoner.find((x: any) => x.id === org);
    expect(o.moduler).toEqual(["personal", "lonn", "regnskap"]);
    expect(o.funksjoner).not.toContain("ehf");
    // En rolle kan ikke få en modul som er av.
    expect((await kall("POST", `/api/org/${org}/tilgangsroller`, { navn: "Fakturaansvarlig", moduler: ["faktura"] })).status).toBe(400);
    // Daglig leder med alle modulene får bare de som er på.
    expect((await kall("GET", "/api/meg", undefined, anne)).data.organisasjoner.find((x: any) => x.id === org).rollemoduler).toEqual(["personal", "lonn", "regnskap"]);
    expect((await kall("PUT", `/api/admin/organisasjoner/${org}/funksjoner`, { faktura: true }, admin)).status).toBe(200);
    glemFunksjoner();
    expect((await kall("GET", `/api/org/${org}/fakturaer`)).status).toBe(200);
  });

  it("modulene til registreringen: med det de bygger på", async () => {
    const moduler = (await kall("GET", "/api/offentlig/moduler")).data as { kode: string; krever: string | null; kjerne: string }[];
    expect(moduler.map((m) => m.kode)).toEqual(["faktura", "personal", "lonn", "regnskap"]);
    expect(moduler.find((m) => m.kode === "lonn")?.krever).toBe("personal");
    expect(moduler.map((m) => m.kjerne)).toEqual(["faktura", "ansatte", "lonn", "regnskap"]);
  });
});
