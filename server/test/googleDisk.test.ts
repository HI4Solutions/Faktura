import { describe, expect, it, beforeAll } from "vitest";
import { config } from "../src/config.js";
import { lagApi } from "../src/api.js";
import { lesState, settGoogleFetch, settKryptering, signerState, slettFraDisk, synkOrganisasjon } from "../src/googleDisk.js";
import { pdfFilnavn } from "../src/dokument.js";
import { settLokalOppgavekjorer, type Oppgave } from "../src/tjenester.js";

const c = config as any;

describe("Google Disk – state", () => {
  beforeAll(() => {
    c.googleClientId = "klient";
    c.googleClientSecret = "hemmelig";
  });
  it("signert state kan leses, men ikke forfalskes eller brukes etter utløp", () => {
    const s = signerState({ bruker: "b1" });
    expect(lesState(s)).toEqual({ bruker: "b1" });
    const falsk = Buffer.from(JSON.stringify({ bruker: "annen", exp: Date.now() + 60000 })).toString("base64url");
    expect(() => lesState(`${falsk}.${s.split(".")[1]}`)).toThrow();
    expect(() => lesState(`${s.split(".")[0]}.feil`)).toThrow();
    expect(() => lesState(s, Date.now() + 11 * 60_000)).toThrow();
  });
});

describe.skipIf(!process.env.DATABASE_URL)("Google Disk – kobling per bruker", () => {
  const app = lagApi();
  const token = "Bearer test:uid-disk:disk@server.test:mfa";
  const annen = "Bearer test:uid-disk2:disk2@server.test:mfa";
  const ko: Oppgave[] = [];
  const idToken = `x.${Buffer.from(JSON.stringify({ email: "privat@gmail.com" })).toString("base64url")}.y`;

  const kall = async (m: string, sti: string, t: string, k?: unknown) => {
    const r = await app.request(sti, { method: m, headers: { authorization: t, "content-type": "application/json" }, body: k === undefined ? undefined : JSON.stringify(k) });
    return { status: r.status, data: r.status === 204 ? null : ((await r.json()) as any) };
  };

  beforeAll(() => {
    c.googleClientId = "klient";
    c.googleClientSecret = "hemmelig";
    settKryptering(async (t) => Buffer.from(`kryptert:${t}`), async (b) => b.toString().replace("kryptert:", ""));
    settLokalOppgavekjorer(async (o) => {
      ko.push(o);
    });
    settGoogleFetch((async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("oauth2.googleapis.com/token")) return Response.json({ access_token: "at", refresh_token: "rt", id_token: idToken });
      if (u.includes("/drive/v3/files")) return Response.json({ id: "rotmappe-1" });
      return new Response("{}", { status: 404 });
    }) as typeof fetch);
  });

  it("kobler brukerens egen Disk og velger organisasjoner", async () => {
    const org1 = (await kall("POST", "/api/organisasjoner", token, { navn: "Disk AS" })).data.id;
    const org2 = (await kall("POST", "/api/organisasjoner", token, { navn: "Annen AS" })).data.id;
    const fremmed = (await kall("POST", "/api/organisasjoner", annen, { navn: "Fremmed AS" })).data.id;

    expect((await kall("PUT", `/api/disk/organisasjoner/${org1}`, token, { aktiv: true })).status).toBe(409); // ikke koblet ennå

    const start = await kall("POST", "/api/disk/start", token);
    const url = new URL(start.data.url);
    expect(url.searchParams.get("scope")).toContain("https://www.googleapis.com/auth/drive.file");

    const cb = await app.request(`/api/offentlig/google/callback?code=abc&state=${encodeURIComponent(url.searchParams.get("state")!)}`);
    expect(cb.headers.get("location")).toContain("disk=ok");

    const status = await kall("GET", "/api/disk", token);
    expect(status.data.kobling).toMatchObject({ google_epost: "privat@gmail.com", status: "aktiv" });
    expect(status.data.organisasjoner.filter((o: any) => o.aktiv).map((o: any) => o.id).sort()).toEqual([org1, org2].sort());
    // Eldre fakturaer synkes for hver organisasjon.
    expect(ko.filter((o) => o.type === "disk-synk")).toHaveLength(2);

    expect((await kall("PUT", `/api/disk/organisasjoner/${org2}`, token, { aktiv: false })).data.aktiv).toBe(false);
    expect((await kall("PUT", `/api/disk/organisasjoner/${fremmed}`, token, { aktiv: true })).status).toBe(403);

    // Velg mappe med Google Picker.
    c.googlePickerNokkel = "nokkel";
    c.googleProsjektnummer = "123";
    expect((await kall("GET", "/api/disk", token)).data).toMatchObject({
      velger: { klientId: "klient", nokkel: "nokkel", appId: "123" },
      kobling: { rotmappe_navn: "HI4 Faktura" },
    });
    expect((await kall("PUT", "/api/disk/mappe", token, { id: "../../ugyldig", navn: "x" })).status).toBe(400);
    expect((await kall("PUT", "/api/disk/mappe", annen, { id: "mappe-fra-picker1", navn: "Regnskap" })).status).toBe(409);
    ko.length = 0;
    expect((await kall("PUT", "/api/disk/mappe", token, { id: "mappe-fra-picker1", navn: "Regnskap" })).data).toEqual({ rotmappe_navn: "Regnskap" });
    expect((await kall("GET", "/api/disk", token)).data.kobling).toMatchObject({ rotmappe_navn: "Regnskap", undermapper: false });
    // Bare aktive organisasjoner kopieres på nytt til den nye mappen.
    expect(ko).toEqual([expect.objectContaining({ type: "disk-synk", org_id: org1 })]);
    expect((await kall("PUT", "/api/disk/mappe", token, { standard: true })).data).toEqual({ rotmappe_navn: "HI4 Faktura" });

    // Den andre brukeren ser ikke koblingen.
    expect((await kall("GET", "/api/disk", annen)).data.kobling).toBeUndefined();

    expect((await kall("DELETE", "/api/disk", token)).status).toBe(204);
    expect((await kall("GET", "/api/disk", token)).data.kobling).toBeUndefined();
  });

  it("legger fakturaene rett i mappen brukeren valgte", async () => {
    const t = "Bearer test:uid-disk3:disk3@server.test:mfa";
    const opplastet: any[] = [];
    const lagtIPapirkurv: string[] = [];
    let funnet = false;
    settGoogleFetch((async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("oauth2.googleapis.com/token")) return Response.json({ access_token: "at", refresh_token: "rt", id_token: idToken });
      if (u.includes("/upload/drive/v3/files")) {
        const kropp = Buffer.from(init!.body as Uint8Array).toString("latin1");
        opplastet.push(JSON.parse(kropp.split("\r\n")[3]));
        return Response.json({ id: "fil" });
      }
      if (init?.method === "PATCH") {
        lagtIPapirkurv.push(u.split("/files/")[1].split("?")[0]);
        return Response.json({ id: "fil" });
      }
      if (u.includes("/drive/v3/files?") && (init?.method ?? "GET") === "GET") return Response.json({ files: funnet ? [{ id: "fil" }] : [] });
      if (u.includes("/drive/v3/files")) return Response.json({ id: "ny-mappe" });
      return new Response("{}", { status: 404 });
    }) as typeof fetch);

    const org = (await kall("POST", "/api/organisasjoner", t, { navn: "Flat AS" })).data.id;
    await kall("PATCH", `/api/org/${org}`, t, { kontonr: "86011117947", epost: "post@flat.no" });
    const kunde = (await kall("POST", `/api/org/${org}/kunder`, t, { navn: "Kunde", epost: "k@kunde.no" })).data.id;
    const f = await kall("POST", `/api/org/${org}/fakturaer`, t, {
      kunde_id: kunde,
      linjer: [{ beskrivelse: "Arbeid", antall: 1, enhet: "stk", enhetspris: 100, mva_sats: 25 }],
    });
    expect((await kall("POST", `/api/org/${org}/fakturaer/${f.data.id}/utsted`, t, { send_epost: false })).status).toBe(200);

    const url = new URL((await kall("POST", "/api/disk/start", t)).data.url);
    await app.request(`/api/offentlig/google/callback?code=abc&state=${encodeURIComponent(url.searchParams.get("state")!)}`);
    await kall("PUT", "/api/disk/mappe", t, { id: "valgt-mappe-123", navn: "Regnskap" });

    const brukerId = (await kall("GET", "/api/meg", t)).data.bruker.id;
    await synkOrganisasjon(brukerId, org, async () => ({ data: new Uint8Array([1]) }), pdfFilnavn);
    expect(opplastet).toEqual([{ name: "Faktura-1.pdf", parents: ["valgt-mappe-123"], appProperties: { faktura_id: f.data.id } }]);

    // Allerede kopiert: ingen ny opplasting.
    funnet = true;
    await synkOrganisasjon(brukerId, org, async () => ({ data: new Uint8Array([1]) }), pdfFilnavn);
    expect(opplastet).toHaveLength(1);

    // Slettet testfaktura: kopien legges i papirkurven.
    const s = await kall("POST", `/api/org/${org}/fakturaer/${f.data.id}/slett`, t, { grunn: "Testfaktura" });
    expect(s.status).toBe(200);
    await slettFraDisk(org, s.data.slettet, pdfFilnavn);
    expect(lagtIPapirkurv).toEqual(["fil"]);
  });

  it("forfalsket state avvises", async () => {
    expect((await app.request(`/api/offentlig/google/callback?code=abc&state=falsk.state`)).status).toBe(400);
  });
});
