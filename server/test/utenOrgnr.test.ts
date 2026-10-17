// Uten organisasjonsnummer (0119_uten_orgnr.sql): en privatperson har bare fakturaene (ikke EHF),
// rutene til resten sier at de krever organisasjonsnummer, og når nummeret legges inn senere
// (POST /org/:org/orgnr), blir privatpersonen et foretak med opplysningene fra Enhetsregisteret.
import { beforeAll, describe, expect, it } from "vitest";
import { lagApi } from "../src/api.js";
import { config } from "../src/config.js";
import { settBrreg } from "../src/verifisering.js";
import type { Enhet } from "../src/brreg.js";
import { ApiFeil } from "../src/feil.js";

const enhet = (nr: string, ekstra: Partial<Enhet> = {}): Enhet => ({
  orgnr: nr, navn: `Foretak ${nr}`, adresse: "Storgata 1", postnr: "0155", poststed: "OSLO", mva_registrert: true, foretaksregisteret: false,
  konkurs: false, under_avvikling: false, slettet: false, hjemmeside: null, epost: null, organisasjonsform: "AS", ...ekstra,
});
const register: Record<string, Enhet> = {
  "923609016": enhet("923609016", { navn: "Ola Nordmann Snekkerservice", organisasjonsform: "ENK", mva_registrert: false }),
  "974760673": enhet("974760673", { navn: "Konkurs AS", konkurs: true }),
  "915000177": enhet("915000177", { navn: "Senere AS", foretaksregisteret: true }),
};

describe.skipIf(!process.env.DATABASE_URL)("organisasjoner uten organisasjonsnummer", () => {
  const app = lagApi();
  const ola = "Bearer test:uid-uten-orgnr-ola:ola.privat@server.test:mfa:Ola%20Nordmann";
  const annen = "Bearer test:uid-uten-orgnr-annen:annen.privat@server.test:mfa";
  const admin = "Bearer test:uid-uten-orgnr-admin:uten-orgnr-admin@server.test:mfa";
  let priv: string;

  const kall = async (m: string, sti: string, k?: unknown, hvem = ola) => {
    const r = await app.request(sti, { method: m, headers: { authorization: hvem, "content-type": "application/json" }, body: k === undefined ? undefined : JSON.stringify(k) });
    return { status: r.status, data: (await r.json().catch(() => null)) as any };
  };
  const meg = async (org: string) => (await kall("GET", "/api/meg")).data.organisasjoner.find((o: any) => o.id === org);

  beforeAll(async () => {
    config.adminEposter.push("uten-orgnr-admin@server.test");
    settBrreg(async (nr) => {
      const e = register[nr];
      if (!e) throw new ApiFeil(404, "Fant ikke organisasjonsnummeret i Enhetsregisteret");
      return e;
    });
    const r = await kall("POST", "/api/organisasjoner", { navn: "Ola Nordmann", type: "privatperson" });
    expect(r.status).toBe(201);
    priv = r.data.id;
  });

  it("en privatperson har bare fakturaene, uten EHF", async () => {
    const o = await meg(priv);
    expect(o).toMatchObject({ type: "privatperson", orgnr: null, moduler: ["faktura"], personal: false });
    expect(o.funksjoner).toEqual(["faktura", "bank", "ai", "gjentakende", "flere", "paaminnelser", "rapporter", "import", "google_disk"]);
    expect((await kall("GET", `/api/org/${priv}/fakturaer`)).status).toBe(200);
    expect((await kall("GET", `/api/org/${priv}/kunder`)).status).toBe(200);
  });

  it("plattformadministratoren ser hvilke funksjoner som krever organisasjonsnummer", async () => {
    const d = (await kall("GET", `/api/admin/organisasjoner/${priv}`, undefined, admin)).data;
    expect(d).toMatchObject({ type: "privatperson", orgnr: null });
    const f = Object.fromEntries(d.funksjoner.map((x: any) => [x.kode, x.uten_orgnr]));
    expect(f).toMatchObject({ faktura: true, bank: true, ehf: false, ansatte: false, lonn: false, regnskap: false });
  });

  it("resten sier at det krever organisasjonsnummer", async () => {
    for (const [sti, navn] of [
      ["/ansatte", "Ansatte og timer"],
      ["/lonn/kjoringer", "Ansatte og timer"], // lønnen bygger på ansatte og timer
      ["/regnskap/oppsett", "Regnskap"],
      ["/ehf", "EHF"],
    ]) {
      const r = await kall("GET", `/api/org/${priv}${sti}`);
      expect(r.status, sti).toBe(403);
      expect(r.data.error, sti).toBe(`${navn} krever organisasjonsnummer. Legg det inn under Innstillinger → Organisasjon.`);
    }
  });

  it("organisasjonsnummeret legges inn senere, og privatpersonen blir foretak", async () => {
    expect((await kall("POST", `/api/org/${priv}/orgnr`, { orgnr: "12345" })).status).toBe(400);
    expect((await kall("POST", `/api/org/${priv}/orgnr`, { orgnr: "974760673" })).data.error).toBe(
      "Foretaket er konkurs, under avvikling eller slettet i Enhetsregisteret",
    );
    expect((await kall("POST", `/api/org/${priv}/orgnr`, { orgnr: "923609016" }, annen)).status).toBe(403);

    const r = await kall("POST", `/api/org/${priv}/orgnr`, { orgnr: "923609016" });
    expect(r.status).toBe(200);
    // Navnet fra Enhetsregisteret, og et enkeltpersonforetak kan sende i innehaverens navn.
    expect(r.data).toMatchObject({
      type: "foretak", orgnr: "923609016", navn: "Ola Nordmann Snekkerservice", innehaver: "Ola Nordmann", standard_avsender: "firma",
      adresse: "Storgata 1", postnr: "0155", poststed: "OSLO", mva_registrert: false, verifisering: "ny",
    });
    const o = await meg(priv);
    expect(o.moduler).toEqual(["faktura", "personal", "lonn", "regnskap"]);
    expect(o.funksjoner).toContain("ehf");
    // Rutene virker med en gang (funksjonene huskes ikke lenger).
    expect((await kall("GET", `/api/org/${priv}/ansatte`)).status).toBe(200);
    expect((await kall("GET", `/api/org/${priv}/ehf`)).status).toBe(200);
    // Én gang: deretter endres nummeret i innstillingene (til organisasjonen er verifisert).
    expect((await kall("POST", `/api/org/${priv}/orgnr`, { orgnr: "915000177" })).status).toBe(409);
  });

  it("et foretak uten organisasjonsnummer får det samme", async () => {
    const as = (await kall("POST", "/api/organisasjoner", { navn: "Uten Nummer AS" })).data.id;
    expect((await meg(as)).moduler).toEqual(["faktura"]);
    expect((await kall("GET", `/api/org/${as}/ansatte`)).data.error).toBe(
      "Ansatte og timer krever organisasjonsnummer. Legg det inn under Innstillinger → Organisasjon.",
    );
    const r = await kall("POST", `/api/org/${as}/orgnr`, { orgnr: "915000177" });
    expect(r.data).toMatchObject({ type: "foretak", orgnr: "915000177", navn: "Senere AS", innehaver: null, foretaksregisteret: true });
    expect((await kall("GET", `/api/org/${as}/ansatte`)).status).toBe(200);

    // Nummeret kan også settes i innstillingene (til organisasjonen er verifisert).
    const as2 = (await kall("POST", "/api/organisasjoner", { navn: "Innstillinger AS" })).data.id;
    expect((await kall("GET", `/api/org/${as2}/ansatte`)).status).toBe(403);
    expect((await kall("PATCH", `/api/org/${as2}`, { orgnr: "915000177" })).status).toBe(200);
    expect((await kall("GET", `/api/org/${as2}/ansatte`)).status).toBe(200);
  });
});
