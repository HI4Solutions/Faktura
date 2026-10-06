// Import av kunder og produkter fra andre systemer.
import { describe, expect, it, beforeAll } from "vitest";
import { lagApi } from "../src/api.js";

describe.skipIf(!process.env.DATABASE_URL)("Import av kunder og produkter", () => {
  const app = lagApi();
  const eier = "Bearer test:uid-import:import@server.test:mfa";
  const fremmed = "Bearer test:uid-import2:import2@server.test:mfa";
  let org: string;
  let a: any;

  const kall = async (m: string, sti: string, k?: unknown, t = eier) => {
    const r = await app.request(sti, { method: m, headers: { authorization: t, "content-type": "application/json" }, body: k === undefined ? undefined : JSON.stringify(k) });
    return { status: r.status, data: (await r.json()) as any };
  };
  const kunder = async () => (await kall("GET", `/api/org/${org}/kunder`)).data as any[];

  beforeAll(async () => {
    org = (await kall("POST", "/api/organisasjoner", { navn: "Import AS" })).data.id;
    a = (await kall("POST", `/api/org/${org}/kunder`, { navn: "Fjordline AS", orgnr: "923609016", epost: "a@fjordline.no", telefon: "22 22 22 22" })).data;
    await kall("POST", `/api/org/${org}/kunder`, { navn: "Bakeriet", epost: "post@bakeriet.no" });
    await kall("POST", `/api/org/${org}/kunder`, { type: "person", navn: "Kari Hansen" });
  });

  it("prøvekjøring viser nye, eksisterende og feil uten å lagre noe", async () => {
    const r = await kall("POST", `/api/org/${org}/kunder/importer`, {
      proving: true,
      rader: [
        { navn: "Nordlys Tannklinikk AS", orgnr: "974760673", epost: "faktura@nordlys.no", postnr: "0155", poststed: "Oslo" },
        { navn: "Fjordline Logistikk AS", orgnr: "923609016" },
        { navn: "Bakeriet i Bergen", epost: "Post@Bakeriet.no" },
        { type: "person", navn: "kari hansen" },
        { navn: "Feil AS", orgnr: "923609017" },
        { navn: "" },
        { navn: "Nordlys igjen", orgnr: "974760673" },
        { navn: "Rart", epost: "ikke-en-adresse" },
      ],
    });
    expect(r.status).toBe(200);
    expect(r.data.antall).toEqual({ ny: 1, oppdater: 0, hopp: 4, feil: 3 });
    expect(r.data.rader.map((x: any) => [x.nr, x.status, x.grunn ?? null])).toEqual([
      [1, "ny", null],
      [2, "hopp", "Finnes fra før"],
      [3, "hopp", "Finnes fra før"],
      [4, "hopp", "Finnes fra før"],
      [5, "feil", "Ugyldig org.nr. (kontrollsifferet stemmer ikke)"],
      [6, "feil", "Mangler navn"],
      [7, "hopp", "Står tidligere i fila"],
      [8, "feil", "Ugyldig e-postadresse"],
    ]);
    expect((await kunder()).length).toBe(3);
  });

  it("importerer nye og oppdaterer eksisterende uten å slette det som står fra før", async () => {
    const r = await kall("POST", `/api/org/${org}/kunder/importer`, {
      duplikater: "oppdater",
      rader: [
        { navn: "Nordlys Tannklinikk AS", orgnr: "974760673", epost: "faktura@nordlys.no", postnr: "0155", poststed: "Oslo" },
        { navn: "Fjordline Logistikk AS", orgnr: "923609016", adresse: "Kaigata 5", epost: null },
        { navn: "Feil AS", orgnr: "923609017" },
      ],
    });
    expect(r.data.antall).toEqual({ ny: 1, oppdater: 1, hopp: 0, feil: 1 });
    const alle = await kunder();
    expect(alle.length).toBe(4);
    const ny = alle.find((k) => k.orgnr === "974760673");
    expect([ny.navn, ny.postnr, ny.poststed, ny.kundenummer > a.kundenummer]).toEqual(["Nordlys Tannklinikk AS", "0155", "Oslo", true]);
    const oppdatert = alle.find((k) => k.id === a.id);
    expect([oppdatert.navn, oppdatert.adresse, oppdatert.epost, oppdatert.telefon]).toEqual(["Fjordline Logistikk AS", "Kaigata 5", "a@fjordline.no", "22 22 22 22"]);
  });

  it("notatet fra fila legges til det som står fra før, én gang", async () => {
    const k = (await kall("POST", `/api/org/${org}/kunder`, { navn: "Notat AS", epost: "post@notat.no", notat: "Viktig kunde" })).data;
    const importer = () =>
      kall("POST", `/api/org/${org}/kunder/importer`, { duplikater: "oppdater", rader: [{ navn: "Notat AS", epost: "post@notat.no", notat: "Kundenr. i tidligere system: 7" }] });
    expect((await importer()).data.antall).toEqual({ ny: 0, oppdater: 1, hopp: 0, feil: 0 });
    await importer();
    expect((await kall("GET", `/api/org/${org}/kunder/${k.id}`)).data.notat).toBe("Viktig kunde\nKundenr. i tidligere system: 7");
  });

  it("produkter: like varenummer eller navn finnes fra før, pris er påkrevd", async () => {
    await kall("POST", `/api/org/${org}/produkter`, { varenummer: "100", navn: "Husleie", enhetspris: 14500, mva_sats: 0, enhet: "mnd" });
    await kall("POST", `/api/org/${org}/produkter`, { navn: "Parkering", enhetspris: 950 });
    const r = await kall("POST", `/api/org/${org}/produkter/importer`, {
      rader: [
        { varenummer: "100", navn: "Husleie leilighet 2B", enhetspris: 15000, mva_sats: 0 },
        { navn: "parkering", enhetspris: 900 },
        { varenummer: "300", navn: "Bod", enhetspris: 300, mva_sats: 25, enhet: "mnd" },
        { navn: "Uten pris" },
      ],
    });
    expect(r.data.antall).toEqual({ ny: 1, oppdater: 0, hopp: 2, feil: 1 });
    expect(r.data.rader[3]).toEqual({ nr: 4, status: "feil", grunn: "Mangler pris, eller prisen er ikke et tall" });
    const produkter = (await kall("GET", `/api/org/${org}/produkter`)).data as any[];
    expect(produkter.map((p) => [p.varenummer, p.navn, Number(p.enhetspris)]).sort()).toEqual([
      ["100", "Husleie", 14500],
      ["300", "Bod", 300],
      [null, "Parkering", 950],
    ].sort());
  });

  it("krever skrivetilgang og setter en grense på antall rader", async () => {
    const fremmedOrg = (await kall("POST", "/api/organisasjoner", { navn: "Fremmed AS" }, fremmed)).data.id;
    expect((await kall("POST", `/api/org/${fremmedOrg}/kunder/importer`, { rader: [{ navn: "X" }] })).status).toBe(403);
    expect((await kall("POST", `/api/org/${org}/kunder/importer`, { rader: [] })).status).toBe(400);
    expect((await kall("POST", `/api/org/${org}/kunder/importer`, { rader: Array.from({ length: 5001 }, (_, i) => ({ navn: `K${i}` })) })).status).toBe(400);
  });
});
