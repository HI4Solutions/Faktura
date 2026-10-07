// Push-varsler: abonnementer, valg, VAPID-nøkkel og sending.
import { describe, expect, it, beforeAll } from "vitest";
import { lagApi } from "../src/api.js";
import { settLokalOppgavekjorer, type Oppgave } from "../src/tjenester.js";
import { settKryptering } from "../src/kryptering.js";
import { gyldigEndepunkt, sendVarsel, settPushSender } from "../src/push.js";
import { varsleForfalte, varsleOmHendelse } from "../src/varsler.js";

describe("Push – endepunkter", () => {
  it("godtar bare kjente push-tjenester over https", () => {
    expect(gyldigEndepunkt("https://fcm.googleapis.com/fcm/send/abc")).toBe(true);
    expect(gyldigEndepunkt("https://updates.push.services.mozilla.com/wpush/v2/abc")).toBe(true);
    expect(gyldigEndepunkt("https://web.push.apple.com/QGh")).toBe(true);
    expect(gyldigEndepunkt("https://wns2-par02p.notify.windows.com/w/?token=x")).toBe(true);
    expect(gyldigEndepunkt("http://fcm.googleapis.com/fcm/send/abc")).toBe(false);
    expect(gyldigEndepunkt("https://fcm.googleapis.com:8443/x")).toBe(false);
    expect(gyldigEndepunkt("https://metadata.google.internal/computeMetadata")).toBe(false);
    expect(gyldigEndepunkt("https://evil.com/fcm.googleapis.com")).toBe(false);
    expect(gyldigEndepunkt("https://push.apple.com.evil.com/x")).toBe(false);
    expect(gyldigEndepunkt("ikke en adresse")).toBe(false);
  });
});

describe.skipIf(!process.env.DATABASE_URL)("Push – abonnementer og sending", () => {
  const app = lagApi();
  const ko: Oppgave[] = [];
  const ola = "Bearer test:uid-push:push@server.test:mfa";
  const kari = "Bearer test:uid-push2:push2@server.test:mfa";
  const sendt: { endpoint: string; innhold: any }[] = [];
  let svarStatus: Record<string, number> = {};

  const kall = async (m: string, sti: string, t: string, k?: unknown) => {
    const r = await app.request(sti, { method: m, headers: { authorization: t, "content-type": "application/json" }, body: k === undefined ? undefined : JSON.stringify(k) });
    const type = r.headers.get("content-type") ?? "";
    return { status: r.status, data: type.includes("json") ? ((await r.json()) as any) : null };
  };
  const abonnement = (n: number) => ({
    endpoint: `https://fcm.googleapis.com/fcm/send/enhet-${n}-${Date.now()}`,
    p256dh: "B".repeat(87),
    auth: "a".repeat(22),
    enhet: `Telefon ${n}`,
  });

  beforeAll(() => {
    settLokalOppgavekjorer(async (o) => {
      ko.push(o);
    });
    settKryptering(async (t) => Buffer.from(`kryptert:${t}`), async (b) => b.toString().replace("kryptert:", ""));
    settPushSender(async (a, innhold, valg) => {
      expect(valg.vapidDetails?.privateKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const status = svarStatus[a.endpoint];
      if (status) throw Object.assign(new Error("Feil fra push-tjenesten"), { statusCode: status });
      sendt.push({ endpoint: a.endpoint, innhold: JSON.parse(innhold) });
      return {};
    });
  });

  it("lager VAPID-nøkkel og lar brukeren registrere enheter og velge varsler", async () => {
    const start = await kall("GET", "/api/push", ola);
    expect(start.status).toBe(200);
    const nokkel = Buffer.from(start.data.nokkel, "base64url");
    expect(nokkel).toHaveLength(65);
    expect(nokkel[0]).toBe(4); // ukomprimert P-256-punkt
    expect((await kall("GET", "/api/push", kari)).data.nokkel).toBe(start.data.nokkel); // samme for alle
    expect(start.data.valg).toEqual({ betaling: true, forfalt: true, epostfeil: true, gjentakende: true, indeksregulering: true, bank: true, paaminnelse: true });
    expect(start.data.abonnementer).toEqual([]);

    expect((await kall("POST", "/api/push/abonnement", ola, { ...abonnement(1), endpoint: "https://evil.com/x" })).status).toBe(400);
    expect((await kall("POST", "/api/push/abonnement", ola, { ...abonnement(1), p256dh: "kort" })).status).toBe(400);
    const a1 = abonnement(1);
    expect((await kall("POST", "/api/push/abonnement", ola, a1)).status).toBe(201);
    expect((await kall("GET", "/api/push", ola)).data.abonnementer).toMatchObject([{ enhet: "Telefon 1" }]);

    // Logger Kari inn på samme enhet, flyttes abonnementet til henne.
    expect((await kall("POST", "/api/push/abonnement", kari, a1)).status).toBe(201);
    expect((await kall("GET", "/api/push", ola)).data.abonnementer).toEqual([]);
    const kariListe = (await kall("GET", "/api/push", kari)).data.abonnementer;
    expect(kariListe).toHaveLength(1);
    expect((await kall("DELETE", `/api/push/abonnement/${kariListe[0].id}`, ola)).status).toBe(404); // ikke hennes
    expect((await kall("POST", "/api/push/avmeld", kari, { endpoint: a1.endpoint })).status).toBe(204);
    expect((await kall("GET", "/api/push", kari)).data.abonnementer).toEqual([]);

    expect((await kall("PUT", "/api/push/valg", ola, { betaling: false })).status).toBe(200);
    expect((await kall("PUT", "/api/push/valg", ola, { ukjent: true })).status).toBe(400);
    expect((await kall("GET", "/api/push", ola)).data.valg).toMatchObject({ betaling: false, forfalt: true });

    ko.length = 0;
    expect((await kall("POST", "/api/push/test", ola)).status).toBe(200);
    expect(ko[0]).toMatchObject({ type: "varsel", varsel: { hendelse: "test", tittel: "Varsler er slått på" } });
  });

  it("sender til medlemmene som vil ha varselet, og rydder bort døde abonnementer", async () => {
    const org = (await kall("POST", "/api/organisasjoner", ola, { navn: "Push AS" })).data.id;
    await kall("PATCH", `/api/org/${org}`, ola, { kontonr: "86011117947" });
    const inv = await kall("POST", `/api/org/${org}/invitasjoner`, ola, { epost: "push2@server.test", rolle: "fakturerer" });
    expect((await kall("POST", "/api/invitasjoner/aksepter", kari, { token: inv.data.lenke.split("/").pop() })).status).toBe(200);

    const olaEnhet = abonnement(2);
    const kariEnhet = abonnement(3);
    const dodEnhet = abonnement(4);
    await kall("POST", "/api/push/abonnement", ola, olaEnhet);
    await kall("POST", "/api/push/abonnement", kari, kariEnhet);
    await kall("POST", "/api/push/abonnement", kari, dodEnhet);
    svarStatus = { [dodEnhet.endpoint]: 410 };

    // Ola har slått av betalingsvarsler; Kari får dem.
    sendt.length = 0;
    const r = await sendVarsel({ hendelse: "betaling", org_id: org, tittel: "Betaling mottatt", tekst: "Kunde har betalt.", url: "/fakturaer/x" });
    expect(r).toEqual({ sendt: 1, fjernet: 1 });
    expect(sendt.map((s) => s.endpoint)).toEqual([kariEnhet.endpoint]);
    // Lenken bytter til riktig organisasjon når den åpnes.
    expect(sendt[0].innhold).toMatchObject({ tittel: "Betaling mottatt", url: `/fakturaer/x?org=${org}` });
    expect((await kall("GET", "/api/push", kari)).data.abonnementer).toHaveLength(1); // den døde er borte

    // Unntatt: den som utløste hendelsen får ikke varsel.
    sendt.length = 0;
    await sendVarsel({ hendelse: "forfalt", org_id: org, unntatt: (await kall("GET", "/api/meg", kari)).data.bruker.id, tittel: "t", tekst: "t", url: "/" });
    expect(sendt.map((s) => s.endpoint)).toEqual([olaEnhet.endpoint]);
    expect(sendt[0].innhold.tekst).toBe("t"); // Ola er bare med i én organisasjon ennå
  });

  it("varsler om fakturaer som forfalt i går, én gang per dag", async () => {
    const org = (await kall("POST", "/api/organisasjoner", ola, { navn: "Forfall AS" })).data.id;
    await kall("PATCH", `/api/org/${org}`, ola, { kontonr: "86011117947" });
    const kunde = (await kall("POST", `/api/org/${org}/kunder`, ola, { navn: "Treg Betaler" })).data.id;
    const igaar = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Oslo" }).format(new Date(Date.now() - 86_400_000));
    const forrige = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Oslo" }).format(new Date(Date.now() - 15 * 86_400_000));
    const f = await kall("POST", `/api/org/${org}/fakturaer`, ola, {
      kunde_id: kunde,
      fakturadato: forrige,
      forfallsdato: igaar,
      linjer: [{ beskrivelse: "Arbeid", antall: 1, enhetspris: 1000, mva_sats: 25 }],
    });
    const u = await kall("POST", `/api/org/${org}/fakturaer/${f.data.id}/utsted`, ola, { send_epost: false });
    expect(u.data.forfallsdato).toBe(igaar);

    sendt.length = 0;
    await varsleForfalte();
    const mine = sendt.filter((s) => s.innhold.url.includes(org));
    expect(mine).toHaveLength(1);
    expect(mine[0].innhold).toMatchObject({ tittel: "Faktura har forfalt", url: `/fakturaer/${f.data.id}?org=${org}` });
    // Ola er nå med i flere organisasjoner, så organisasjonen står først. Uten mva-registrering er beløpet 1 000.
    expect(mine[0].innhold.tekst).toBe("Forfall AS: Faktura 1 til Treg Betaler (1 000,00 kr) forfalt i går uten å være betalt.");

    sendt.length = 0;
    await varsleForfalte();
    expect(sendt.filter((s) => s.innhold.url.includes(org))).toHaveLength(0);
  });

  it("varsler om betaling fra utboksen, men ikke den som registrerte den, og bare én gang", async () => {
    const org = (await kall("POST", "/api/organisasjoner", ola, { navn: "Betaling AS" })).data.id;
    await kall("PATCH", `/api/org/${org}`, ola, { kontonr: "86011117947" });
    const inv = await kall("POST", `/api/org/${org}/invitasjoner`, ola, { epost: "push2@server.test", rolle: "fakturerer" });
    await kall("POST", "/api/invitasjoner/aksepter", kari, { token: inv.data.lenke.split("/").pop() });
    await kall("PUT", "/api/push/valg", ola, { betaling: true });
    const kunde = (await kall("POST", `/api/org/${org}/kunder`, ola, { navn: "God Betaler" })).data.id;
    const f = await kall("POST", `/api/org/${org}/fakturaer`, ola, {
      kunde_id: kunde,
      linjer: [{ beskrivelse: "Arbeid", antall: 1, enhetspris: 1000, mva_sats: 25 }],
    });
    await kall("POST", `/api/org/${org}/fakturaer/${f.data.id}/utsted`, ola, { send_epost: false });
    const idag = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Oslo" }).format(new Date());
    expect((await kall("POST", `/api/org/${org}/fakturaer/${f.data.id}/betalinger`, kari, { belop: 1000, dato: idag })).data.status).toBe("betalt");

    sendt.length = 0;
    const data = { faktura_id: f.data.id, type: "faktura", status: "betalt" };
    await varsleOmHendelse("faktura.betalt", org, "test-utboks-1", data);
    await varsleOmHendelse("faktura.betalt", org, "test-utboks-1", data); // levert to ganger
    const mine = sendt.filter((s) => s.innhold.url.includes(org));
    expect(mine).toHaveLength(1); // Ola; Kari registrerte betalingen selv
    expect(mine[0].innhold.tekst).toContain("God Betaler har betalt faktura");
    expect(mine[0].innhold.tekst).toContain("1 000,00 kr");
  });
});
