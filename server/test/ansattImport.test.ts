// Faste tillegg på lønnen (0052_faste_tillegg.sql) og import av ansatte fra andre systemer:
// tilleggene legges inn, endres og fjernes med den ansatte, regnskap og den ansatte selv ser
// dem, og importen kjenner igjen ansatte som finnes (e-post, ellers navn), sier hva som er
// galt, krypterer fødselsnumrene og tar med tilleggene.
import { beforeAll, describe, expect, it } from "vitest";
import { lagApi } from "../src/api.js";
import { config } from "../src/config.js";
import { alle, en, somSystem } from "../src/db.js";
import { settKryptering } from "../src/kryptering.js";
import { settLokalOppgavekjorer } from "../src/tjenester.js";

describe.skipIf(!process.env.DATABASE_URL)("Faste tillegg og import av ansatte", () => {
  const app = lagApi();
  const eier = "Bearer test:uid-aimp-eier:aimp-eier@server.test:mfa";
  const regnskap = "Bearer test:uid-aimp-regn:aimp-regn@server.test:mfa";
  const fakturerer = "Bearer test:uid-aimp-fakt:aimp-fakt@server.test:mfa";
  const kari = "Bearer test:uid-aimp-kari:kari.imp@server.test";
  const plattform = "Bearer test:uid-aimp-admin:aimp-admin@server.test:mfa";
  let org: string;
  let kariId: string;
  let perId: string;
  const krypteringer: string[] = [];

  const kall = async (m: string, sti: string, k?: unknown, hvem = eier) => {
    const r = await app.request(sti, { method: m, headers: { authorization: hvem, "content-type": "application/json" }, body: k === undefined ? undefined : JSON.stringify(k) });
    return { status: r.status, data: (r.headers.get("content-type") ?? "").includes("json") ? ((await r.json()) as any) : null };
  };
  const inviter = async (epost: string, rolle: string, hvem: string) => {
    const r = await kall("POST", `/api/org/${org}/invitasjoner`, { epost, rolle });
    expect((await kall("POST", "/api/invitasjoner/aksepter", { token: r.data.lenke.split("/").pop() }, hvem)).status).toBe(200);
  };
  const importer = (rader: unknown[], valg: Record<string, unknown> = {}, hvem = eier) => kall("POST", `/api/org/${org}/ansatte/importer`, { rader, ...valg }, hvem);

  beforeAll(async () => {
    config.adminEposter.push("aimp-admin@server.test");
    settLokalOppgavekjorer(async () => undefined);
    settKryptering(
      async (t) => {
        krypteringer.push(t);
        return Buffer.from(`kryptert:${t}`);
      },
      async (b) => b.toString().replace("kryptert:", ""),
    );
    org = (await kall("POST", "/api/organisasjoner", { navn: "Tillegg og Import AS" })).data.id;
    expect((await kall("PUT", `/api/org/${org}/lonn-oppsett`, { aktiv: true, full_stilling: 37.5 })).status).toBe(200);
    await inviter("aimp-regn@server.test", "regnskap", regnskap);
    await inviter("aimp-fakt@server.test", "fakturerer", fakturerer);
  });

  it("faste tillegg legges inn med den ansatte, og endres, legges til og fjernes", async () => {
    const ny = await kall("POST", `/api/org/${org}/ansatte`, {
      fornavn: "Kari",
      etternavn: "Hansen",
      epost: "kari.imp@server.test",
      lonnstype: "maaned",
      maanedslonn: 42000,
      tillegg: [
        { navn: " Funksjonstillegg ", belop: 1500 },
        { navn: "Fagbrevtillegg", belop: 15.5, per: "time", fra: "2026-01-01" },
      ],
    });
    expect(ny.status, JSON.stringify(ny.data)).toBe(201);
    kariId = ny.data.id;
    expect(ny.data.tillegg).toEqual([
      { id: expect.any(String), navn: "Funksjonstillegg", belop: 1500, per: "maaned", fra: null, til: null },
      { id: expect.any(String), navn: "Fagbrevtillegg", belop: 15.5, per: "time", fra: "2026-01-01", til: null },
    ]);
    const [funksjon, fagbrev] = ny.data.tillegg;

    // Hele listen sendes: det som er med, endres eller legges til, resten fjernes.
    const endret = await kall("PATCH", `/api/org/${org}/ansatte/${kariId}`, {
      tillegg: [
        { id: funksjon.id, navn: "Funksjonstillegg", belop: 2000, fra: "2026-01-01", til: "2026-12-31" },
        { navn: "Ansiennitetstillegg", belop: 800 },
      ],
    });
    expect(endret.status, JSON.stringify(endret.data)).toBe(200);
    expect(endret.data.tillegg).toEqual([
      { id: funksjon.id, navn: "Funksjonstillegg", belop: 2000, per: "maaned", fra: "2026-01-01", til: "2026-12-31" },
      { id: expect.any(String), navn: "Ansiennitetstillegg", belop: 800, per: "maaned", fra: null, til: null },
    ]);
    expect(await somSystem((db) => en(db, "select count(*)::int as n from faktura.ansatt_tillegg where id = $1", [fagbrev.id]))).toEqual({ n: 0 });
    // Uten tillegg i kroppen endres de ikke.
    expect((await kall("PATCH", `/api/org/${org}/ansatte/${kariId}`, { stilling: "Kokk" })).data.tillegg).toHaveLength(2);

    // Kontrollene.
    const feil = async (t: unknown) => (await kall("PATCH", `/api/org/${org}/ansatte/${kariId}`, { tillegg: [t] })).data.error;
    expect(await feil({ navn: "Tillegg", belop: 0 })).toBe("Beløpet for tillegget må være over 0");
    expect(await feil({ navn: "", belop: 100 })).toBe("Skriv hva tillegget heter");
    expect(await feil({ navn: "Tillegg", belop: 100, fra: "2026-05-01", til: "2026-04-01" })).toBe("Tillegget slutter før det begynner");
    expect(await feil({ navn: "Tillegg", belop: 100, per: "uke" })).toBe("Velg om tillegget er per måned eller per time");
    expect(await feil({ id: "00000000-0000-4000-8000-000000000000", navn: "Tillegg", belop: 100 })).toBe("Fant ikke tillegget");
  });

  it("regnskap og den ansatte selv ser tilleggene, men bare eier og administrator endrer dem", async () => {
    expect((await kall("GET", `/api/org/${org}/ansatte/${kariId}`, undefined, regnskap)).data.tillegg.map((t: any) => t.navn)).toEqual(["Funksjonstillegg", "Ansiennitetstillegg"]);
    expect((await kall("PATCH", `/api/org/${org}/ansatte/${kariId}`, { tillegg: [] }, regnskap)).status).toBe(403);
    const inv = await kall("POST", `/api/org/${org}/ansatte/${kariId}/inviter`);
    expect((await kall("POST", "/api/invitasjoner/aksepter", { token: inv.data.lenke.split("/").pop() }, kari)).status).toBe(200);
    expect((await kall("GET", `/api/org/${org}/ansatte/meg`, undefined, kari)).data.tillegg).toHaveLength(2);
    // Loggen over tilleggene er for dem som ser de ansatte.
    const logg = await somSystem((db) => alle<{ tabell: string }>(db, "select tabell from faktura.revisjonslogg where org_id = $1 and tabell = 'ansatt_tillegg'", [org]));
    expect(logg.length).toBeGreaterThan(0);
  });

  it("prøvekjøring av importen viser nye, de som finnes og feil, uten å lagre noe", async () => {
    perId = (await kall("POST", `/api/org/${org}/ansatte`, { fornavn: "Per", etternavn: "Olsen" })).data.id;
    const r = await importer(
      [
        { fornavn: "Nina", etternavn: "Berg", epost: "nina@berg.no", fnr: "15038510190", stillingsprosent: 80, ansatt_fra: "2025-08-01", lonnstype: "maaned", maanedslonn: 39000 },
        { fornavn: "Kari", etternavn: "Hansen-Lie", epost: "KARI.IMP@server.test" }, // samme e-post som Kari
        { fornavn: "per", etternavn: "olsen", epost: "per@olsen.no" }, // samme navn som Per, som ikke har e-post
        { fornavn: "Kari", etternavn: "Hansen", epost: "en.annen.kari@server.test" }, // samme navn, annen e-post: en annen
        { fornavn: "Nina", etternavn: "Berg", epost: "nina@berg.no" }, // står før i fila
        { fornavn: "Ole", etternavn: "Feil", fnr: "15038510191" },
        { fornavn: "Ole", etternavn: "" },
        { fornavn: "Ole", etternavn: "Prosent", stillingsprosent: "åtti" },
        { fornavn: "Ole", etternavn: "Født", fodselsdato: "2999-01-01" },
        { fornavn: "Ole", etternavn: "Slutt", ansatt_fra: "2026-05-01", ansatt_til: "2026-04-01" },
        { fornavn: "Ole", etternavn: "Dato", ansatt_fra: "1. mai" },
        { fornavn: "Ole", etternavn: "Type", ansettelsestype: "sommerjobb" },
      ],
      { proving: true },
    );
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data.antall).toEqual({ ny: 2, oppdater: 0, hopp: 3, feil: 7 });
    expect(r.data.rader).toEqual([
      { nr: 1, status: "ny" },
      { nr: 2, status: "hopp", grunn: "Finnes fra før" },
      { nr: 3, status: "hopp", grunn: "Finnes fra før" },
      { nr: 4, status: "ny" },
      { nr: 5, status: "hopp", grunn: "Står tidligere i fila" },
      { nr: 6, status: "feil", grunn: "Fødselsnummeret er ikke gyldig (sjekk sifrene)" },
      { nr: 7, status: "feil", grunn: "Mangler etternavn" },
      { nr: 8, status: "feil", grunn: "Ugyldig stillingsprosent" },
      { nr: 9, status: "feil", grunn: "Fødselsdatoen kan ikke være fram i tid" },
      { nr: 10, status: "feil", grunn: "Sluttdatoen er før startdatoen" },
      { nr: 11, status: "feil", grunn: "Ugyldig startdato" },
      { nr: 12, status: "feil", grunn: "Ugyldig ansettelsestype (fast, midlertidig eller tilkalling)" },
    ]);
    expect((await kall("GET", `/api/org/${org}/ansatte`)).data).toHaveLength(2);
    expect(krypteringer).toEqual([]);
  });

  it("importerer nye og oppdaterer dem som finnes, med fødselsnummer og faste tillegg", async () => {
    const rader = [
      {
        fornavn: "Nina",
        etternavn: "Berg",
        epost: "nina@berg.no",
        fnr: "15038510190",
        kontonr: "86011117947",
        stillingsprosent: 80,
        ansatt_fra: "2025-08-01",
        lonnstype: "maaned",
        maanedslonn: 39000,
        tillegg: [{ navn: "Funksjonstillegg", belop: 1200, per: "maaned" }],
        notat: "Ansattnr. i tidligere system: 17",
      },
      // Kari finnes: tomme felt endrer ingenting, notatet legges til, og et tillegg med samme navn endres.
      { fornavn: "Kari", etternavn: "Hansen", epost: "kari.imp@server.test", telefon: "912 34 567", notat: "Fra lønnssystemet", tillegg: [{ navn: "funksjonstillegg", belop: 2500 }, { navn: "Telefontillegg", belop: 300 }] },
      { fornavn: "Tom", etternavn: "Ny", ansettelsestype: "tilkalling", lonnstype: "time", timelonn: 210 },
      { fornavn: "Feil", etternavn: "Rad", kontonr: "12345678901" },
    ];
    const r = await importer(rader, { duplikater: "oppdater" });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data.antall).toEqual({ ny: 2, oppdater: 1, hopp: 0, feil: 1 });
    expect(r.data.rader[3]).toEqual({ nr: 4, status: "feil", grunn: "Kontonummeret er ikke gyldig (sjekk sifrene)" });
    expect(krypteringer).toEqual(["15038510190"]);

    const ansatte = (await kall("GET", `/api/org/${org}/ansatte`)).data as any[];
    const nina = ansatte.find((a) => a.fornavn === "Nina");
    expect(nina).toMatchObject({
      ansattnummer: 3,
      har_fnr: true,
      fodselsdato: "1985-03-15",
      kontonr: "86011117947",
      stillingsprosent: 80,
      ukentlig_arbeidstid: 37.5,
      ansatt_fra: "2025-08-01",
      maanedslonn: 39000,
      notat: "Ansattnr. i tidligere system: 17",
      tillegg: [{ navn: "Funksjonstillegg", belop: 1200, per: "maaned", fra: null, til: null, id: expect.any(String) }],
    });
    expect(ansatte.find((a) => a.fornavn === "Tom")).toMatchObject({ ansettelsestype: "tilkalling", lonnstype: "time", timelonn: 210, tillegg: [] });
    const k = ansatte.find((a) => a.id === kariId);
    expect(k).toMatchObject({ telefon: "912 34 567", stilling: "Kokk", maanedslonn: 42000, notat: "Fra lønnssystemet" });
    expect(k.tillegg.map((t: any) => [t.navn, t.belop])).toEqual([
      ["Funksjonstillegg", 2500],
      ["Ansiennitetstillegg", 800],
      ["Telefontillegg", 300],
    ]);
    // Samme fil på nytt: alt finnes, og notatet står bare én gang.
    expect((await importer(rader, { duplikater: "oppdater" })).data.antall).toEqual({ ny: 0, oppdater: 3, hopp: 0, feil: 1 });
    expect((await kall("GET", `/api/org/${org}/ansatte/${kariId}`)).data.notat).toBe("Fra lønnssystemet");
    expect((await kall("GET", `/api/org/${org}/ansatte/${kariId}`)).data.tillegg).toHaveLength(3);
    expect(perId).toBeTruthy();
  });

  it("bare eier og administrator importerer, og bare når Import er slått på", async () => {
    expect((await importer([{ fornavn: "A", etternavn: "B" }], { proving: true }, regnskap)).status).toBe(403);
    expect((await importer([{ fornavn: "A", etternavn: "B" }], { proving: true }, fakturerer)).status).toBe(403);
    expect((await kall("POST", `/api/org/${org}/ansatte/importer`, { rader: [] })).status).toBe(400);
    expect((await kall("PUT", `/api/admin/organisasjoner/${org}/funksjoner`, { import: false }, plattform)).status).toBe(200);
    const av = await importer([{ fornavn: "A", etternavn: "B" }], { proving: true });
    expect([av.status, av.data.error]).toEqual([403, "Import er ikke slått på for organisasjonen"]);
    expect((await kall("PUT", `/api/admin/organisasjoner/${org}/funksjoner`, { import: true }, plattform)).status).toBe(200);
    expect((await importer([{ fornavn: "A", etternavn: "B" }], { proving: true })).status).toBe(200);
  });
});
