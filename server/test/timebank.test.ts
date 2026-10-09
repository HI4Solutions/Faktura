// Timebank (0073_timebank.sql, timebank.ts): overtid og ekstratimer føres til timebanken og
// godkjennes, lederen justerer, den ansatte søker om avspasering og lederen godkjenner eller
// avslår (med varsler begge veier), og lønnskjøringen lønner ikke timene i banken, men betaler
// overtidstillegget, avspasering for den med timelønn og utbetalinger fra banken. Datoene regnes
// fra i dag.
import { beforeAll, describe, expect, it } from "vitest";
import { lagApi } from "../src/api.js";
import { iDag } from "../src/regler.js";
import { settLokalOppgavekjorer, type Oppgave } from "../src/tjenester.js";

const pluss = (iso: string, n: number) => new Date(Date.parse(`${iso}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const dag = (iso: string) => new Intl.DateTimeFormat("nb-NO", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${iso}T12:00:00Z`));

describe.skipIf(!process.env.DATABASE_URL)("timebank", () => {
  const app = lagApi();
  const eier = "Bearer test:uid-tbank-eier:tbank-eier@server.test:mfa";
  const hvem = {
    kari: "Bearer test:uid-tbank-kari:kari.tbank@server.test",
    ola: "Bearer test:uid-tbank-ola:ola.tbank@server.test",
  };
  const ko: Oppgave[] = [];
  let org: string;
  const id: Record<string, string> = {};
  const bruker: Record<string, string> = {};
  const idag = iDag();
  const [p1, p2, f1, f2] = [pluss(idag, -10), pluss(idag, -9), pluss(idag, 10), pluss(idag, 12)];

  const kall = async (m: string, sti: string, k?: unknown, som = eier) => {
    const r = await app.request(sti, { method: m, headers: { authorization: som, "content-type": "application/json" }, body: k === undefined ? undefined : JSON.stringify(k) });
    return { status: r.status, data: (r.headers.get("content-type") ?? "").includes("json") ? ((await r.json()) as any) : null };
  };
  const varsler = () => ko.filter((o): o is Extract<Oppgave, { type: "varsel" }> => o.type === "varsel").map((o) => o.varsel);
  const nye = (for_: number) => varsler().slice(for_);
  const saldo = async (ansatt: string, som = eier) => (await kall("GET", `/api/org/${org}/timebank`, undefined, som)).data.ansatte.find((a: any) => a.ansatt_id === ansatt);
  const fore = async (k: Record<string, unknown>, som: string) => {
    const r = await kall("POST", `/api/org/${org}/timer`, k, som);
    expect(r.status, JSON.stringify(r.data)).toBe(201);
    return r.data;
  };

  beforeAll(async () => {
    settLokalOppgavekjorer(async (o) => {
      ko.push(o);
    });
    org = (await kall("POST", "/api/organisasjoner", { navn: "Timebank Test AS" })).data.id;
    bruker.eier = (await kall("GET", "/api/meg")).data.bruker.id;
    await kall("PUT", `/api/org/${org}/lonn-oppsett`, { aktiv: true });
    for (const [navn, lonn] of [
      ["kari", { lonnstype: "maaned", maanedslonn: 50000 }],
      ["ola", { lonnstype: "time", timelonn: 250 }],
    ] as const) {
      const fornavn = navn[0]!.toUpperCase() + navn.slice(1);
      const a = (await kall("POST", `/api/org/${org}/ansatte`, { fornavn, etternavn: "Bank", epost: `${navn}.tbank@server.test`, ansatt_fra: pluss(idag, -60), ...lonn })).data;
      const inv = (await kall("POST", `/api/org/${org}/ansatte/${a.id}/inviter`)).data;
      expect((await kall("POST", "/api/invitasjoner/aksepter", { token: inv.lenke.split("/").pop() }, hvem[navn])).status).toBe(200);
      id[navn] = a.id;
      bruker[navn] = (await kall("GET", "/api/meg", undefined, hvem[navn])).data.bruker.id;
    }
  });

  it("slått av: ingenting går i banken; slått på: synlig i appen", async () => {
    expect((await kall("POST", `/api/org/${org}/timer`, { dato: p1, timer: 2, uten_overtid: true, timebank: true }, hvem.kari)).data.error).toBe(
      "Timebanken er ikke slått på (Innstillinger → Ansatte og timer)",
    );
    expect((await kall("GET", `/api/org/${org}/timebank`)).data.paa).toBe(false);
    expect((await kall("PUT", `/api/org/${org}/lonn-oppsett`, { timebank: true }, hvem.kari)).status).toBe(403);
    expect((await kall("PUT", `/api/org/${org}/lonn-oppsett`, { timebank: true })).data.timebank).toBe(true);
    expect((await kall("GET", "/api/meg", undefined, hvem.kari)).data.organisasjoner.find((o: any) => o.id === org).timebank).toBe(true);
  });

  it("overtid og ekstratimer føres til banken og teller når de er godkjent", async () => {
    expect((await kall("POST", `/api/org/${org}/timer`, { dato: p1, timer: 1, timebank: true }, hvem.kari)).data.error).toBe(
      "Bare overtid og ekstratimer (uten overtid) kan settes i timebanken",
    );
    const t1 = await fore({ dato: p1, timer: 2, uten_overtid: true, timebank: true, beskrivelse: "Kveldsvakt" }, hvem.kari);
    const t2 = await fore({ dato: p2, timer: 3, overtid_prosent: 50, timebank: true }, hvem.kari);
    expect([t1.timebank, t2.timebank]).toEqual([true, true]);
    // Blir føringen vanlige timer, er den ikke lenger i banken.
    const t3 = await fore({ dato: p2, timer: 1, uten_overtid: true, timebank: true }, hvem.kari);
    expect((await kall("PATCH", `/api/org/${org}/timer/${t3.id}`, { uten_overtid: false }, hvem.kari)).data).toMatchObject({ uten_overtid: false, timebank: false });

    const uke = (await kall("GET", `/api/org/${org}/timer?fra=${p1}&til=${p2}&ansatt=${id.kari}`)).data;
    expect(uke.uker.reduce((s: number, u: any) => s + u.timebank, 0)).toBe(5);

    expect((await kall("POST", `/api/org/${org}/timer/lever`, { fra: p1, til: p2 }, hvem.kari)).status).toBe(200);
    expect(await saldo(id.kari, hvem.kari)).toMatchObject({ inn: 0, venter_inn: 5, saldo: 0, sats: null });
    expect((await kall("POST", `/api/org/${org}/timer/godkjenn`, { ider: [t1.id, t2.id, t3.id] })).data).toEqual({ godkjent: 3 });
    expect(await saldo(id.kari)).toMatchObject({ inn: 5, venter_inn: 0, saldo: 5, dag_timer: 7.5, sats: 307.6923 });
    // Den ansatte ser bare seg selv.
    expect((await kall("GET", `/api/org/${org}/timebank`, undefined, hvem.ola)).data.ansatte.map((a: any) => a.navn)).toEqual(["Ola Bank"]);
  });

  it("lederen justerer, og den ansatte får beskjed", async () => {
    expect((await kall("POST", `/api/org/${org}/timebank/poster`, { ansatt_id: id.kari, type: "justering", timer: 7.5, tekst: "Selv" }, hvem.kari)).status).toBe(403);
    expect((await kall("POST", `/api/org/${org}/timebank/poster`, { ansatt_id: id.kari, type: "justering", timer: 7.5 })).data.error).toBe("Skriv hvorfor timebanken justeres");
    const for_ = varsler().length;
    const j = await kall("POST", `/api/org/${org}/timebank/poster`, { ansatt_id: id.kari, type: "justering", timer: 7.5, tekst: "Jobbet 1. mai" });
    expect(j.status).toBe(201);
    expect(j.data).toMatchObject({ type: "justering", timer: 7.5, saldo: expect.objectContaining({ saldo: 12.5 }) });
    expect(nye(for_)).toEqual([
      expect.objectContaining({ hendelse: "timer", bruker_ider: [bruker.kari], tittel: "Timebanken din: +7,5 t", tekst: "Jobbet 1. mai. Saldo: 12,5 t.", url: "/timer?fane=timebank" }),
    ]);
  });

  it("søknad om avspasering: hele dager blir fravær, og lederen kan endre timene", async () => {
    const forslag = await kall("GET", `/api/org/${org}/timebank/forslag?fra=${f1}`, undefined, hvem.kari);
    expect(forslag.data.timer).toBeGreaterThanOrEqual(0);
    const for_ = varsler().length;
    const s = await kall("POST", `/api/org/${org}/timebank/soknader`, { fra: f1, timer: 7.5, melding: "Tannlege" }, hvem.kari);
    expect(s.status, JSON.stringify(s.data)).toBe(201);
    expect(s.data).toMatchObject({ status: "venter", hele_dager: true, fra: f1, til: f1, timer: 7.5, ansatt_navn: "Kari Bank" });
    expect(nye(for_)).toEqual([
      expect.objectContaining({ hendelse: "fravaer", bruker_ider: [bruker.eier], tittel: "Kari Bank søker om avspasering", tekst: `${dag(f1)} (7,5 t). «Tannlege»` }),
    ]);
    expect((await kall("POST", `/api/org/${org}/timebank/soknader`, { fra: f2, timer: 6, hele_dager: false }, hvem.kari)).data.error).toBe(
      "Du har 5 t i timebanken (utenom 7,5 t du har søkt om fra før)",
    );
    expect((await kall("POST", `/api/org/${org}/timebank/soknader/${s.data.id}/godkjenn`, {}, hvem.kari)).status).toBe(403);

    const for2 = varsler().length;
    const g = await kall("POST", `/api/org/${org}/timebank/soknader/${s.data.id}/godkjenn`, { timer: 7, svar: "God bedring" });
    expect(g.data).toMatchObject({ status: "godkjent", timer: 7, svar: "God bedring", behandlet_av_navn: expect.any(String), fjernet: false });
    expect(nye(for2)).toEqual([expect.objectContaining({ bruker_ider: [bruker.kari], tittel: "Avspasering godkjent", tekst: `${dag(f1)} (7 t). «God bedring»` })]);
    const fravaer = (await kall("GET", `/api/org/${org}/fravaer?fra=${f1}&til=${f1}`)).data;
    expect(fravaer).toEqual([expect.objectContaining({ ansatt_id: id.kari, type: "avspasering", timer: 7, notat: "Tannlege" })]);
    expect(await saldo(id.kari)).toMatchObject({ saldo: 5.5, avspasert: 7, sokt: 0 });

    // Noen timer, avslått med en grunn.
    const n = await kall("POST", `/api/org/${org}/timebank/soknader`, { fra: f2, timer: 2, hele_dager: false }, hvem.kari);
    const for3 = varsler().length;
    expect((await kall("POST", `/api/org/${org}/timebank/soknader/${n.data.id}/avslaa`, { svar: "Travelt den dagen" })).data).toMatchObject({ status: "avslatt" });
    expect(nye(for3)).toEqual([expect.objectContaining({ tittel: "Avspasering ikke godkjent", tekst: `${dag(f2)} (2 t). «Travelt den dagen»` })]);
    expect((await kall("POST", `/api/org/${org}/timebank/soknader/${n.data.id}/godkjenn`, {})).status).toBe(409);

    // Trekke en søknad.
    const t = await kall("POST", `/api/org/${org}/timebank/soknader`, { fra: f2, timer: 1, hele_dager: false }, hvem.kari);
    expect((await kall("POST", `/api/org/${org}/timebank/soknader/${t.data.id}/trekk`, {}, hvem.ola)).status).toBe(404);
    expect((await kall("POST", `/api/org/${org}/timebank/soknader/${t.data.id}/trekk`, {}, hvem.kari)).data.status).toBe("trukket");
  });

  it("historikken for én ansatt: bare lederen og den ansatte selv", async () => {
    const h = await kall("GET", `/api/org/${org}/timebank/${id.kari}`, undefined, hvem.kari);
    expect(h.status).toBe(200);
    expect(h.data.saldo.saldo).toBe(5.5);
    // Nyeste først: avspaseringen fram i tid, justeringen i dag, og timene inn.
    expect(h.data.historikk.map((x: any) => [x.kilde, x.type, x.timer, x.dato])).toEqual([
      ["fravaer", "avspasering", -7, f1],
      ["post", "justering", 7.5, idag],
      ["timer", "overtid", 3, p2],
      ["timer", "ekstratimer", 2, p1],
    ]);
    expect(h.data.soknader.map((s: any) => s.status)).toEqual(["trukket", "avslatt", "godkjent"]);
    expect((await kall("GET", `/api/org/${org}/timebank/${id.kari}`, undefined, hvem.ola)).status).toBe(404);
  });

  it("lønnskjøringen: timene i banken lønnes ikke, men overtidstillegget, avspasering (timelønn) og utbetaling gjør", async () => {
    // Ola (timelønn) jobber i dag 7,5 timer og 2 timer overtid til banken, avspaserer 1,5 timer og
    // får 0,5 timer utbetalt.
    const v = await fore({ dato: idag, timer: 7.5 }, hvem.ola);
    const o = await fore({ dato: idag, timer: 2, overtid_prosent: 50, timebank: true }, hvem.ola);
    await kall("POST", `/api/org/${org}/timer/lever`, { fra: idag, til: idag }, hvem.ola);
    await kall("POST", `/api/org/${org}/timer/godkjenn`, { ider: [v.id, o.id] });
    expect((await kall("POST", `/api/org/${org}/timebank/poster`, { ansatt_id: id.ola, type: "avspasering", dato: idag, timer: 1.5, tekst: "Gikk tidlig" })).status).toBe(201);
    const u = await kall("POST", `/api/org/${org}/timebank/poster`, { ansatt_id: id.ola, type: "utbetaling", timer: 0.5 });
    expect(u.data).toMatchObject({ type: "utbetaling", timer: -0.5, saldo: expect.objectContaining({ saldo: 0 }) });

    const k = await kall("POST", `/api/org/${org}/lonn/kjoringer`, { periode: idag.slice(0, 7) });
    expect(k.status, JSON.stringify(k.data)).toBe(201);
    const slipp = (ansatt: string) => k.data.slipper.find((s: any) => s.ansatt_id === ansatt);
    expect(slipp(id.ola).linjer.map((l: any) => [l.lonnsart, l.tekst, l.antall, l.sats, l.belop])).toEqual([
      ["timelonn", "Timelønn", 7.5, 250, 1875],
      ["overtid", "Overtidstillegg 50 % (timene er i timebanken)", 2, 125, 250],
      ["avspasering", "Avspasering fra timebanken", 1.5, 250, 375],
      ["timebank", "Utbetalt fra timebanken", 0.5, 250, 125],
    ]);
    // Kari (fastlønn): bare overtidstillegget for overtiden i banken; ekstratimene og avspaseringen
    // er ikke med (lønnen går som vanlig).
    expect(slipp(id.kari).linjer.map((l: any) => [l.lonnsart, l.antall, l.sats, l.belop])).toEqual([
      ["fastlonn", 1, 50000, 50000],
      ["overtid", 3, 153.8462, 461.54],
    ]);

    // Godkjent: utbetalingen er lønnet og kan ikke slettes før kjøringen åpnes igjen.
    expect((await kall("POST", `/api/org/${org}/lonn/kjoringer/${k.data.id}/godkjenn`)).data.status).toBe("godkjent");
    expect((await kall("DELETE", `/api/org/${org}/timebank/poster/${u.data.id}`)).status).toBe(409);
    const h = (await kall("GET", `/api/org/${org}/timebank/${id.ola}`)).data.historikk;
    expect(h.find((x: any) => x.id === u.data.id)).toMatchObject({ type: "utbetaling", lonnet: true });
    expect((await kall("POST", `/api/org/${org}/lonn/kjoringer/${k.data.id}/gjenapne`)).data.status).toBe("utkast");
    expect((await kall("DELETE", `/api/org/${org}/timebank/poster/${u.data.id}`)).status).toBe(204);
  });
});
