// Påminnelser: lage, endre og slette i appen (med tilgang og kontroller), og utsendingen fra
// workeren: push-varsel til den som lagde påminnelsen eller alle som kan fakturere, e-post om
// det er valgt, lenke til en ny faktura, og neste dato.
import { beforeAll, describe, expect, it } from "vitest";
import { lagApi } from "../src/api.js";
import { en, somSystem } from "../src/db.js";
import { settKryptering } from "../src/kryptering.js";
import { settPushSender } from "../src/push.js";
import { sendPaaminnelser } from "../src/paaminnelser.js";
import { settLokalOppgavekjorer, type Oppgave } from "../src/tjenester.js";

const dag = (n = 0) => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Oslo" }).format(new Date(Date.now() + n * 86400_000));

describe.skipIf(!process.env.DATABASE_URL)("Påminnelser", () => {
  const app = lagApi();
  const eier = "Bearer test:uid-paam-eier:paam-eier@server.test:mfa";
  const fakturerer = "Bearer test:uid-paam-fakt:paam-fakt@server.test:mfa";
  const leser = "Bearer test:uid-paam-les:paam-les@server.test:mfa";
  const ko: Oppgave[] = [];
  const sendt: { endpoint: string; innhold: any }[] = [];
  const enheter: Record<string, string> = {};
  let org: string;
  let kari: string;
  let strom: string;
  let leie: string;

  const kall = async (m: string, sti: string, k?: unknown, hvem = eier) => {
    const r = await app.request(sti, { method: m, headers: { authorization: hvem, "content-type": "application/json" }, body: k === undefined ? undefined : JSON.stringify(k) });
    return { status: r.status, data: (r.headers.get("content-type") ?? "").includes("json") ? ((await r.json()) as any) : null };
  };
  const enhet = async (hvem: string, navn: string) => {
    enheter[navn] = `https://fcm.googleapis.com/fcm/send/paam-${navn}-${Date.now()}`;
    expect((await kall("POST", "/api/push/abonnement", { endpoint: enheter[navn], p256dh: "B".repeat(87), auth: "a".repeat(22), enhet: navn }, hvem)).status).toBe(201);
  };
  const til = (navn: string) => sendt.filter((s) => s.endpoint === enheter[navn]);
  // Gjør en påminnelse klar til å sendes nå (som om tiden er inne).
  const forfall = (id: string, dato = dag()) => somSystem((db) => db.query("update faktura.paaminnelser set neste_dato = $2, aktiv = true where id = $1", [id, dato]));

  beforeAll(async () => {
    settLokalOppgavekjorer(async (o) => {
      ko.push(o);
    });
    settKryptering(async (t) => Buffer.from(`kryptert:${t}`), async (b) => b.toString().replace("kryptert:", ""));
    settPushSender(async (a, innhold) => {
      sendt.push({ endpoint: a.endpoint, innhold: JSON.parse(innhold) });
      return {};
    });
    org = (await kall("POST", "/api/organisasjoner", { navn: "Påminnelse Utleie AS" })).data.id;
    kari = (await kall("POST", `/api/org/${org}/kunder`, { navn: "Kari Hansen", type: "person", epost: "kari@hansen.no" })).data.id;
    strom = (await kall("POST", `/api/org/${org}/produkter`, { navn: "Strøm", enhet: "kWh", enhetspris: null, mva_sats: 25 })).data.id;
    leie = (await kall("POST", `/api/org/${org}/produkter`, { navn: "Husleie", enhet: "mnd", enhetspris: 8000, mva_sats: 0 })).data.id;
    for (const [epost, rolle, hvem] of [
      ["paam-fakt@server.test", "fakturerer", fakturerer],
      ["paam-les@server.test", "les", leser],
    ] as const) {
      const inv = await kall("POST", `/api/org/${org}/invitasjoner`, { epost, rolle });
      expect((await kall("POST", "/api/invitasjoner/aksepter", { token: inv.data.lenke.split("/").pop() }, hvem)).status).toBe(200);
    }
    expect((await kall("GET", "/api/push")).status).toBe(200); // VAPID-nøkkelen
    await enhet(eier, "eier");
    await enhet(fakturerer, "fakturerer");
    await enhet(leser, "leser");
  });

  it("lages med kunde og produkter, og fyller ut det som ikke er valgt", async () => {
    const r = await kall("POST", `/api/org/${org}/paaminnelser`, {
      tekst: "  Send strømfaktura til Kari  ",
      kunde_id: kari,
      produkter: [strom, leie],
      intervall: "maaned",
      neste_dato: "2030-01-31",
    });
    expect(r.status).toBe(201);
    expect(r.data).toMatchObject({
      tekst: "Send strømfaktura til Kari",
      kunde_id: kari,
      kunde_navn: "Kari Hansen",
      produkter: [strom, leie],
      produktliste: [
        { id: strom, navn: "Strøm", fast_pris: false, aktiv: true },
        { id: leie, navn: "Husleie", fast_pris: true, aktiv: true },
      ],
      intervall: "maaned",
      dag: 31,
      neste_dato: "2030-01-31",
      klokkeslett: "08:00",
      hvem: "meg",
      epost: false,
      aktiv: true,
      sist_varslet: null,
      min: true,
    });
    expect((await kall("GET", `/api/org/${org}/paaminnelser/${r.data.id}`)).data.tekst).toBe("Send strømfaktura til Kari");

    // Endre: ny dato gir ny dag i måneden; kunden kan tas bort.
    const e = await kall("PATCH", `/api/org/${org}/paaminnelser/${r.data.id}`, { neste_dato: "2030-02-15", klokkeslett: "07:30", kunde_id: null, hvem: "alle", epost: true });
    expect(e.data).toMatchObject({ dag: 15, neste_dato: "2030-02-15", klokkeslett: "07:30", kunde_id: null, kunde_navn: null, hvem: "alle", epost: true });

    // Alle i organisasjonen ser den; den som bare kan lese, kan ikke endre.
    expect((await kall("GET", `/api/org/${org}/paaminnelser`, undefined, leser)).data.map((p: any) => [p.tekst, p.min])).toEqual([["Send strømfaktura til Kari", false]]);
    expect((await kall("POST", `/api/org/${org}/paaminnelser`, { tekst: "X", intervall: "uke", neste_dato: dag(1) }, leser)).status).toBe(403);
    expect((await kall("PATCH", `/api/org/${org}/paaminnelser/${r.data.id}`, { aktiv: false }, leser)).status).toBe(404);
    expect((await kall("DELETE", `/api/org/${org}/paaminnelser/${r.data.id}`, undefined, leser)).status).toBe(404);
    expect((await kall("DELETE", `/api/org/${org}/paaminnelser/${r.data.id}`)).status).toBe(204);
    expect((await kall("GET", `/api/org/${org}/paaminnelser/${r.data.id}`)).status).toBe(404);
  });

  it("sier fra om det som mangler eller ikke stemmer", async () => {
    const ny = (k: Record<string, unknown>) => kall("POST", `/api/org/${org}/paaminnelser`, { tekst: "Send faktura", intervall: "maaned", neste_dato: dag(), ...k });
    expect((await ny({ tekst: " " })).data.error).toBe("Skriv hva påminnelsen gjelder");
    expect((await ny({ neste_dato: dag(-1) })).data.error).toBe("Velg en dato fra og med i dag");
    expect((await ny({ neste_dato: undefined })).data.error).toBe("Velg en dato");
    expect((await ny({ klokkeslett: "25:00" })).data.error).toBe("Ugyldig klokkeslett");
    expect((await ny({ intervall: "daglig" })).data.error).toBe("Velg hvor ofte");
    const annen = (await kall("POST", "/api/organisasjoner", { navn: "Annen Påminnelse AS" })).data.id;
    const fremmed = (await kall("POST", `/api/org/${annen}/produkter`, { navn: "Annet", enhetspris: 1, mva_sats: 25 })).data.id;
    expect((await ny({ produkter: [fremmed] })).data.error).toBe("Fant ikke produktet");
  });

  it("sendes til den som lagde den, med lenke til en ny faktura, og så neste måned", async () => {
    const p = (await kall("POST", `/api/org/${org}/paaminnelser`, { tekst: "Send strømfaktura til Kari", kunde_id: kari, produkter: [strom], intervall: "maaned", neste_dato: dag(1) })).data;
    // Ikke før tiden er inne.
    expect(await sendPaaminnelser()).toBe(0);
    await forfall(p.id);
    sendt.length = 0;
    ko.length = 0;
    expect(await sendPaaminnelser()).toBe(1);
    expect(til("eier").map((s) => s.innhold)).toEqual([
      expect.objectContaining({
        tittel: "Send strømfaktura til Kari",
        // Med i flere organisasjoner: organisasjonen står først.
        tekst: "Påminnelse Utleie AS: Trykk for å lage fakturaen til Kari Hansen for Strøm.",
        url: `/fakturaer/ny?paaminnelse=${p.id}&org=${org}`,
        tag: `paaminnelse-${p.id}`,
      }),
    ]);
    expect(til("fakturerer")).toEqual([]);
    expect(til("leser")).toEqual([]);
    expect(ko.filter((o) => o.type === "epost")).toEqual([]);
    // Én gang, og neste dato er neste måned.
    expect(await sendPaaminnelser()).toBe(0);
    const etter = (await kall("GET", `/api/org/${org}/paaminnelser/${p.id}`)).data;
    expect(etter.neste_dato > dag()).toBe(true);
    expect(etter.neste_dato.slice(5, 7)).not.toBe(dag().slice(5, 7));
    expect(etter.sist_varslet).not.toBeNull();

    // Har brukeren slått av påminnelser, kommer det ikke noe varsel.
    expect((await kall("PUT", "/api/push/valg", { paaminnelse: false })).status).toBe(200);
    await forfall(p.id);
    sendt.length = 0;
    expect(await sendPaaminnelser()).toBe(1);
    expect(til("eier")).toEqual([]);
    expect((await kall("PUT", "/api/push/valg", { paaminnelse: true })).status).toBe(200);
    await kall("DELETE", `/api/org/${org}/paaminnelser/${p.id}`);
  });

  it("til alle som kan fakturere, også på e-post, og én gang stopper etterpå", async () => {
    const p = (await kall("POST", `/api/org/${org}/paaminnelser`, { tekst: "Fakturer strøm for oktober", intervall: "en_gang", neste_dato: dag(), klokkeslett: "00:00", hvem: "alle", epost: true }, fakturerer)).data;
    expect(p.min).toBe(true);
    sendt.length = 0;
    ko.length = 0;
    expect(await sendPaaminnelser()).toBe(1);
    expect(til("eier").map((s) => s.innhold.tittel)).toEqual(["Fakturer strøm for oktober"]);
    expect(til("fakturerer").map((s) => s.innhold.tekst)).toEqual(["Trykk for å lage fakturaen."]);
    expect(til("eier").map((s) => s.innhold.tekst)).toEqual(["Påminnelse Utleie AS: Trykk for å lage fakturaen."]);
    expect(til("leser")).toEqual([]);
    const eposter = ko.filter((o): o is Extract<Oppgave, { type: "epost" }> => o.type === "epost");
    expect(eposter.map((e) => e.til).sort()).toEqual([["paam-eier@server.test"], ["paam-fakt@server.test"]]);
    expect(eposter[0].emne).toBe("Påminnelse: Fakturer strøm for oktober");
    expect(eposter[0].tekst).toContain("Dette er en påminnelse du har satt opp i HI4 Faktura for Påminnelse Utleie AS:");
    expect(eposter[0].tekst).toContain(`/fakturaer/ny?paaminnelse=${p.id}&org=${org}`);
    expect(eposter[0].tekst).toContain("Dette var den siste påminnelsen.");

    // Stoppet etterpå; en ny dato må velges for å starte den igjen.
    const etter = (await kall("GET", `/api/org/${org}/paaminnelser/${p.id}`)).data;
    expect(etter.aktiv).toBe(false);
    expect((await kall("PATCH", `/api/org/${org}/paaminnelser/${p.id}`, { aktiv: true })).data.error).toBe("Velg en ny dato for påminnelsen");
    expect((await kall("PATCH", `/api/org/${org}/paaminnelser/${p.id}`, { aktiv: true, neste_dato: dag(7), intervall: "uke" })).data).toMatchObject({ aktiv: true, neste_dato: dag(7) });
    // Kunden slettes: påminnelser om kunden forsvinner med den.
    const k = (await kall("POST", `/api/org/${org}/kunder`, { navn: "Per Olsen", type: "person" })).data.id;
    const q = (await kall("POST", `/api/org/${org}/paaminnelser`, { tekst: "Fakturer Per", kunde_id: k, intervall: "maaned", neste_dato: dag(3) })).data;
    expect((await kall("DELETE", `/api/org/${org}/kunder/${k}`)).status).toBe(204);
    expect(await somSystem((db) => en(db, "select id from faktura.paaminnelser where id = $1", [q.id]))).toBeUndefined();
  });
});
