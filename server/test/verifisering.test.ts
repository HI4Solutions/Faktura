// Verifisering og plattformadministrasjon, med Enhetsregisteret byttet ut.
import { describe, expect, it, beforeAll } from "vitest";
import { lagApi } from "../src/api.js";
import { config } from "../src/config.js";
import { settLokalOppgavekjorer, type Oppgave } from "../src/tjenester.js";
import { settBrreg } from "../src/verifisering.js";
import { epostHorerTilForetaket, domene, maskerEpost, type Enhet } from "../src/brreg.js";

const harDb = Boolean(process.env.DATABASE_URL);
const app = lagApi();
const ko: Oppgave[] = [];

const enhet = (nr: string, ekstra: Partial<Enhet> = {}): Enhet => ({
  orgnr: nr, navn: `Foretak ${nr}`, adresse: null, postnr: null, poststed: null, mva_registrert: true, foretaksregisteret: true,
  konkurs: false, under_avvikling: false, slettet: false, hjemmeside: null, epost: null, ...ekstra,
});
const register: Record<string, Enhet> = {
  "910000012": enhet("910000012", { hjemmeside: "www.domene-as.no" }),
  "910000020": enhet("910000020", { epost: "post@kode-as.no" }),
  "910000039": enhet("910000039"),
  "910000047": enhet("910000047", { konkurs: true }),
};

async function kall(metode: string, sti: string, token: string, kropp?: unknown) {
  const r = await app.request(sti, { method: metode, headers: { authorization: token, "content-type": "application/json" }, body: kropp === undefined ? undefined : JSON.stringify(kropp) });
  return { status: r.status, data: (await r.json()) as any };
}

async function nyOrg(token: string, orgnr: string) {
  return (await kall("POST", "/api/organisasjoner", token, { navn: `Org ${orgnr}`, orgnr })).data.id as string;
}

describe("domeneregler", () => {
  it("godtar bare foretakets eget domene", () => {
    const e = enhet("1", { hjemmeside: "https://www.firma.no/om", epost: "post@gmail.com" });
    expect(epostHorerTilForetaket("ola@firma.no", e)).toBe(true);
    expect(epostHorerTilForetaket("ola@avd.firma.no", e)).toBe(true);
    expect(epostHorerTilForetaket("ola@gmail.com", e)).toBe(false);
    expect(epostHorerTilForetaket("ola@firma.no.svindel.com", e)).toBe(false);
    expect(domene("https://www.firma.no/om")).toBe("firma.no");
    expect(maskerEpost("post@firma.no")).toBe("po••@firma.no");
  });
});

describe.skipIf(!harDb)("verifisering", () => {
  beforeAll(() => {
    settBrreg(async (nr) => {
      const e = register[nr];
      if (!e) throw Object.assign(new Error("Fant ikke"), { status: 404 });
      return e;
    });
    settLokalOppgavekjorer(async (o) => {
      ko.push(o);
    });
    config.adminEposter.push("admin@server.test");
  });

  it("verifiserer automatisk når e-postdomenet hører til foretaket", async () => {
    const t = "Bearer test:uid-v1:ola@domene-as.no:mfa";
    const org = await nyOrg(t, "910000012");
    const r = await kall("POST", `/api/org/${org}/verifisering/start`, t);
    expect(r.data).toEqual({ status: "verifisert", metode: "epostdomene" });
    expect((await kall("GET", `/api/org/${org}/verifisering`, t)).data.verifisering).toBe("verifisert");
  });

  it("sender kode til e-posten i Enhetsregisteret", async () => {
    const t = "Bearer test:uid-v2:kari@gmail.com:mfa";
    const org = await nyOrg(t, "910000020");
    const r = await kall("POST", `/api/org/${org}/verifisering/start`, t);
    expect(r.data.status).toBe("kode_sendt");
    expect(r.data.sendt_til).toBe("po••@kode-as.no");
    const e = ko.at(-1) as Extract<Oppgave, { type: "epost" }>;
    expect(e.til).toEqual(["post@kode-as.no"]);
    const kode = /Bekreftelseskode: (\d{6})/.exec(e.tekst)![1];
    expect((await kall("POST", `/api/org/${org}/verifisering/kode`, t, { kode: "000000" === kode ? "111111" : "000000" })).status).toBe(400);
    expect((await kall("POST", `/api/org/${org}/verifisering/kode`, t, { kode })).data.status).toBe("verifisert");
  });

  it("uten e-post i registeret: manuell forespørsel som admin godkjenner", async () => {
    const t = "Bearer test:uid-v3:per@gmail.com:mfa";
    const admin = "Bearer test:uid-adm:admin@server.test:mfa";
    const org = await nyOrg(t, "910000039");
    expect((await kall("POST", `/api/org/${org}/verifisering/start`, t)).data.status).toBe("manuell");
    expect((await kall("POST", `/api/org/${org}/verifisering/manuell`, t, { notat: "Jeg er daglig leder" })).data.status).toBe("venter");
    expect((ko.at(-1) as any).til).toEqual(["admin@server.test"]);

    expect((await kall("GET", "/api/admin/organisasjoner", t)).status).toBe(403);
    const liste = await kall("GET", "/api/admin/organisasjoner", admin);
    expect(liste.data.find((o: any) => o.id === org).venter_manuell).toBe(true);
    expect((await kall("GET", "/api/meg", admin)).data.plattformadmin).toBe(true);
    const brukere = await kall("GET", "/api/admin/brukere", admin);
    expect(brukere.data.find((b: any) => b.epost === "per@gmail.com").organisasjoner[0]).toMatchObject({ rolle: "eier" });
    expect((await kall("GET", "/api/admin/brukere", t)).status).toBe(403);

    // Oversikt, detaljer og driftsstatus: bare for plattformadministratorer.
    for (const sti of ["/api/admin/oversikt", "/api/admin/drift", `/api/admin/organisasjoner/${org}`]) expect((await kall("GET", sti, t)).status).toBe(403);
    const oversikt = (await kall("GET", "/api/admin/oversikt", admin)).data;
    expect(oversikt.organisasjoner.totalt).toBeGreaterThanOrEqual(1);
    expect(oversikt.venter).toBeGreaterThanOrEqual(1);
    expect(Object.keys(oversikt.problemer).sort()).toEqual(["banker", "ehf", "epost", "integrasjoner", "utboks"]);
    const detaljer = (await kall("GET", `/api/admin/organisasjoner/${org}`, admin)).data;
    expect(detaljer).toMatchObject({ id: org, orgnr: "910000039", verifisering: "ny" });
    expect(detaljer.medlemmer).toEqual([expect.objectContaining({ epost: "per@gmail.com", rolle: "eier" })]);
    expect(detaljer.verifiseringer[0]).toMatchObject({ metode: "manuell", status: "venter", notat: "Jeg er daglig leder" });
    expect((await kall("GET", "/api/admin/organisasjoner/00000000-0000-4000-8000-000000000000", admin)).status).toBe(404);
    expect((await kall("GET", "/api/admin/organisasjoner/ikke-en-id", admin)).status).toBe(400);
    const drift = (await kall("GET", "/api/admin/drift", admin)).data;
    expect(Object.keys(drift).sort()).toEqual(["ai", "banker", "ehf", "ehf_problemer", "epost", "epost_problemer", "integrasjoner", "utboks"]);
    expect(drift.ai).toMatchObject({ satt_opp: false, modell: "gemini-3.5-flash", region: "europe-west3", grense: 1000 });
    expect(Object.keys(drift.ai.sum).sort()).toEqual(["antall", "tokens_inn", "tokens_ut"]);

    expect((await kall("POST", `/api/admin/organisasjoner/${org}/status`, admin, { status: "sperret" })).status).toBe(400);
    expect((await kall("POST", `/api/admin/organisasjoner/${org}/status`, admin, { status: "verifisert" })).data.verifisering).toBe("verifisert");
  });

  it("avviser konkurs og krever admin i organisasjonen", async () => {
    const t = "Bearer test:uid-v4:konk@gmail.com:mfa";
    const org = await nyOrg(t, "910000047");
    expect((await kall("POST", `/api/org/${org}/verifisering/start`, t)).status).toBe(409);
    expect((await kall("POST", `/api/org/${org}/verifisering/start`, "Bearer test:uid-v5:annen@gmail.com:mfa")).status).toBe(403);
  });
});
