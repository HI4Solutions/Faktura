// Bursdager: eier og administrator slår på bursdagsvarsler (push, e-post eller begge) under
// Innstillinger → Ansatte og timer; de ansatte kan ikke. Workeren varsler alle andre enn den som
// har bursdag fra kl. 08 norsk tid, én gang, og hver bruker kan slå av push-varslene om
// bursdager for seg selv.
import { beforeAll, describe, expect, it } from "vitest";
import { lagApi } from "../src/api.js";
import { sendBursdager } from "../src/bursdager.js";
import { settKryptering } from "../src/kryptering.js";
import { sendVarsel, settPushSender, type Varsel } from "../src/push.js";
import { settLokalOppgavekjorer, type Oppgave } from "../src/tjenester.js";

const iDag = () => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Oslo" }).format(new Date());
// Samme dag for n år siden (n går opp i fire, så 29. februar også stemmer).
const aarSiden = (n: number) => `${Number(iDag().slice(0, 4)) - n}${iDag().slice(4)}`;
// En bursdag som ikke er i dag.
const ikkeIDag = () => `1990-${iDag().slice(5, 7) === "01" ? "02" : "01"}-15`;
// Klokkeslett i dag (UTC): 04:30 er før kl. 08 norsk tid, 10:00 etter, både sommer og vinter.
const klokka = (utc: string) => new Date(`${iDag()}T${utc}:00Z`);

describe.skipIf(!process.env.DATABASE_URL)("Bursdager", () => {
  const app = lagApi();
  const eier = "Bearer test:uid-burs-eier:burs-eier@server.test:mfa:Eva%20Eier";
  const kari = "Bearer test:uid-burs-kari:kari.burs@server.test:mfa:Kari%20Kake";
  const ola = "Bearer test:uid-burs-ola:ola.burs@server.test:mfa:Ola%20Olsen";
  const ko: Oppgave[] = [];
  const sendt: { endpoint: string; innhold: any }[] = [];
  const enheter: Record<string, string> = {};
  const brukere: Record<string, string> = {};
  let org: string;

  const kall = async (m: string, sti: string, k?: unknown, hvem = eier) => {
    const r = await app.request(sti, { method: m, headers: { authorization: hvem, "content-type": "application/json" }, body: k === undefined ? undefined : JSON.stringify(k) });
    return { status: r.status, data: (r.headers.get("content-type") ?? "").includes("json") ? ((await r.json()) as any) : null };
  };
  const enhet = async (hvem: string, navn: string) => {
    enheter[navn] = `https://fcm.googleapis.com/fcm/send/burs-${navn}-${Date.now()}`;
    expect((await kall("POST", "/api/push/abonnement", { endpoint: enheter[navn], p256dh: "B".repeat(87), auth: "a".repeat(22), enhet: navn }, hvem)).status).toBe(201);
    brukere[navn] = (await kall("GET", "/api/meg", undefined, hvem)).data.bruker.id;
  };
  const til = (navn: string) => sendt.filter((s) => s.endpoint === enheter[navn]);
  const varsler = () => ko.filter((o): o is Extract<Oppgave, { type: "varsel" }> => o.type === "varsel" && o.varsel.hendelse === ("bursdag" as Varsel["hendelse"]));
  const eposter = () => ko.filter((o): o is Extract<Oppgave, { type: "epost" }> => o.type === "epost" && o.emne.includes("bursdag"));
  const ansatt = async (k: Record<string, unknown>) => (await kall("POST", `/api/org/${org}/ansatte`, k)).data.id as string;
  const gi = async (id: string, hvem: string) => {
    const inv = await kall("POST", `/api/org/${org}/ansatte/${id}/inviter`);
    expect((await kall("POST", "/api/invitasjoner/aksepter", { token: inv.data.lenke.split("/").pop() }, hvem)).status).toBe(200);
  };

  beforeAll(async () => {
    settLokalOppgavekjorer(async (o) => {
      ko.push(o);
    });
    settKryptering(async (t) => Buffer.from(`kryptert:${t}`), async (b) => b.toString().replace("kryptert:", ""));
    settPushSender(async (a, innhold) => {
      sendt.push({ endpoint: a.endpoint, innhold: JSON.parse(innhold) });
      return {};
    });
    org = (await kall("POST", "/api/organisasjoner", { navn: "Bursdag Test AS" })).data.id;
    expect((await kall("PUT", `/api/org/${org}/lonn-oppsett`, { aktiv: true })).status).toBe(200);
    const kariId = await ansatt({ fornavn: "Kari", etternavn: "Kake", epost: "kari.burs@server.test", fodselsdato: aarSiden(28) });
    const olaId = await ansatt({ fornavn: "Ola", etternavn: "Olsen", epost: "ola.burs@server.test", fodselsdato: ikkeIDag() });
    await ansatt({ fornavn: "Per", etternavn: "Privat", epost: "per.privat@server.test" });
    await gi(kariId, kari);
    await gi(olaId, ola);
    await enhet(eier, "eier");
    await enhet(kari, "kari");
    await enhet(ola, "ola");
    ko.length = 0;
  });

  it("bare eier og administrator slår på bursdagsvarsler", async () => {
    expect((await kall("GET", `/api/org/${org}/lonn-oppsett`)).data.bursdag_varsel).toBe("av");
    expect((await kall("PUT", `/api/org/${org}/lonn-oppsett`, { bursdag_varsel: "push" }, ola)).status).toBe(403);
    expect((await kall("PUT", `/api/org/${org}/lonn-oppsett`, { bursdag_varsel: "sms" })).status).toBe(400);
    expect((await kall("PUT", `/api/org/${org}/lonn-oppsett`, { bursdag_varsel: "begge" })).data).toMatchObject({ aktiv: true, bursdag_varsel: "begge" });
    // Brukerne kan slå av push om bursdager for seg selv.
    expect((await kall("GET", "/api/push", undefined, ola)).data.typer.bursdag).toBe("Bursdager i organisasjonen");
  });

  it("før kl. 08 sendes ingenting", async () => {
    expect(await sendBursdager(klokka("04:30"))).toEqual({ varslet: 0 });
    expect(varsler()).toHaveLength(0);
  });

  it("alle andre enn den som har bursdag får push og e-post, én gang", async () => {
    expect((await sendBursdager(klokka("10:00"))).varslet).toBe(1);
    const [v] = varsler();
    expect(v!.varsel).toMatchObject({ org_id: org, tittel: "Bursdag i dag", tekst: "Kari Kake har bursdag i dag 🎂", url: "/" });
    expect(v!.varsel.bruker_ider).toEqual(expect.arrayContaining([brukere.eier, brukere.ola]));
    expect(v!.varsel.bruker_ider).not.toContain(brukere.kari);
    await sendVarsel(v!.varsel);
    expect(til("eier")).toHaveLength(1);
    expect(til("ola")[0]!.innhold).toMatchObject({ tittel: "Bursdag i dag", tekst: "Kari Kake har bursdag i dag 🎂" });
    expect(til("kari")).toHaveLength(0);
    // E-post til hver for seg, også den ansatte uten innlogging, men ikke til Kari.
    expect(eposter().map((e) => e.til)).toEqual(expect.arrayContaining([["burs-eier@server.test"], ["ola.burs@server.test"], ["per.privat@server.test"]]));
    expect(eposter().flatMap((e) => e.til)).not.toContain("kari.burs@server.test");
    expect(eposter()[0]).toMatchObject({ emne: "Kari Kake har bursdag i dag 🎂", fra_navn: "Bursdag Test AS" });
    expect(eposter()[0]!.tekst).toContain("Kari Kake i Bursdag Test AS har bursdag i dag.");
    // Bare én gang.
    expect(await sendBursdager(klokka("10:01"))).toEqual({ varslet: 0 });
  });

  it("en ansatt kan unntas, og en bruker kan slå av push om bursdager", async () => {
    ko.length = 0;
    await ansatt({ fornavn: "Siri", etternavn: "Stille", fodselsdato: aarSiden(32), bursdag_varsel: false });
    expect((await kall("GET", `/api/org/${org}/ansatte`)).data.find((a: any) => a.fornavn === "Siri").bursdag_varsel).toBe(false);
    expect(await sendBursdager(klokka("10:02"))).toEqual({ varslet: 0 });
    // Ola vil ikke ha push om bursdager.
    expect((await kall("PUT", "/api/push/valg", { bursdag: false }, ola)).status).toBe(200);
    await ansatt({ fornavn: "Tor", etternavn: "Tidlig", fodselsdato: aarSiden(36) });
    expect((await sendBursdager(klokka("10:03"))).varslet).toBe(1);
    const for_ = sendt.length;
    await sendVarsel(varsler()[0]!.varsel);
    expect(sendt.slice(for_).map((s) => s.endpoint)).toEqual(expect.arrayContaining([enheter.eier, enheter.kari]));
    expect(sendt.slice(for_).map((s) => s.endpoint)).not.toContain(enheter.ola);
  });
});
