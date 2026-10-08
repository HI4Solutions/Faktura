// Ansatte og timer: fødselsnummer og uker og overtid (rene funksjoner), og i appen: ansatte
// med kryptert fødselsnummer, egen innlogging for den ansatte (rollen ansatt, som ser bare sitt
// eget), timeføring, levering, godkjenning og avvisning med push-varsler, og at varsler til
// hele organisasjonen ikke går til ansatte.
import { beforeAll, describe, expect, it } from "vitest";
import { lagApi } from "../src/api.js";
import { en, somSystem } from "../src/db.js";
import { fnrGyldig, fodselsdato } from "../src/fnr.js";
import { AML, beregnUke, uke } from "../src/arbeidstid.js";
import { settKryptering } from "../src/kryptering.js";
import { sendVarsel, settPushSender } from "../src/push.js";
import { settLokalOppgavekjorer, type Oppgave } from "../src/tjenester.js";

describe("fødselsnummer", () => {
  it("godtar gyldige numre og finner fødselsdatoen", () => {
    // Kontrollsifrene er regnet ut uavhengig (Python).
    expect(fnrGyldig("15038510190")).toBe(true);
    expect(fodselsdato("15038510190")).toBe("1985-03-15");
    expect(fodselsdato("01010750160")).toBe("2007-01-01"); // individnummer 500–999, år 00–39
    expect(fodselsdato("12125695076")).toBe("1956-12-12"); // individnummer 900–999, år 40–99
    expect(fnrGyldig("41019020183")).toBe(true); // D-nummer
    expect(fodselsdato("41019020183")).toBe("1990-01-01");
    expect(fodselsdato("29028010042")).toBe("1980-02-29");
  });

  it("avviser feil kontrollsiffer, feil lengde og datoer som ikke finnes", () => {
    expect(fnrGyldig("15038510191")).toBe(false);
    expect(fnrGyldig("1503851019")).toBe(false);
    expect(fnrGyldig("1503851019a")).toBe(false);
    expect(fodselsdato("31028010042")).toBeNull(); // 31. februar
  });
});

describe("uker og overtid", () => {
  it("finner ISO-uka", () => {
    expect(uke("2026-10-07")).toEqual({ aar: 2026, uke: 41, fra: "2026-10-05", til: "2026-10-11" });
    expect(uke("2026-01-01")).toMatchObject({ aar: 2026, uke: 1, fra: "2025-12-29" });
    expect(uke("2027-01-01")).toMatchObject({ aar: 2026, uke: 53 });
    expect(uke("2024-12-30")).toMatchObject({ aar: 2025, uke: 1 });
  });

  const dager = (timer: number[], start = 5) => timer.map((t, i) => ({ dato: `2026-10-${String(start + i).padStart(2, "0")}`, timer: t, overtid_prosent: null }));

  it("arbeidsmiljøloven: over 9 timer per dag og 40 per uke", () => {
    expect(beregnUke(dager([8, 8, 8, 8, 8]), AML)).toEqual({ ordinare: 40, overtid: [], merarbeid: 0, sum: 40 });
    // 10 timer i fem dager: én time overtid hver dag, og 45 ordinære blir 40.
    expect(beregnUke(dager([10, 10, 10, 10, 10]), AML)).toEqual({ ordinare: 40, overtid: [{ prosent: 40, timer: 10 }], merarbeid: 0, sum: 50 });
    // Fire lange dager: bare døgngrensen.
    expect(beregnUke(dager([10, 10, 10, 10]), AML)).toMatchObject({ ordinare: 36, overtid: [{ prosent: 40, timer: 4 }] });
    // Flere føringer samme dag legges sammen.
    expect(beregnUke([...dager([6]), ...dager([4.5])], AML)).toMatchObject({ ordinare: 9, overtid: [{ prosent: 40, timer: 1.5 }] });
  });

  it("egne grenser og satser, føringer merket som overtid, og merarbeid for deltid", () => {
    const tariff = { daglig_grense: 7.5, ukentlig_grense: 37.5, overtid_prosent: 50 };
    expect(beregnUke(dager([8, 8, 8, 8, 8]), tariff)).toEqual({ ordinare: 37.5, overtid: [{ prosent: 50, timer: 2.5 }], merarbeid: 0, sum: 40 });
    const medFast = [...dager([7.5, 7.5]), { dato: "2026-10-11", timer: 4, overtid_prosent: 100 }];
    expect(beregnUke(medFast, tariff)).toEqual({ ordinare: 15, overtid: [{ prosent: 100, timer: 4 }], merarbeid: 0, sum: 19 });
    // 60 % stilling (22,5 av 37,5 timer) som jobber 30 timer: 7,5 timer merarbeid, ikke overtid.
    expect(beregnUke(dager([6, 6, 6, 6, 6]), AML, 22.5)).toEqual({ ordinare: 30, overtid: [], merarbeid: 7.5, sum: 30 });
    // Kvarter og minutter blir eksakte.
    expect(beregnUke(dager([7.25, 7.75, 0.5]), AML).sum).toBe(15.5);
  });
});

describe.skipIf(!process.env.DATABASE_URL)("ansatte og timer i appen", () => {
  const app = lagApi();
  const eier = "Bearer test:uid-pers-eier:pers-eier@server.test:mfa";
  const ola = "Bearer test:uid-pers-ola:ola.ansatt@server.test";
  const fakturerer = "Bearer test:uid-pers-fakt:pers-fakt@server.test:mfa";
  const ko: Oppgave[] = [];
  const sendt: { endpoint: string; innhold: any }[] = [];
  let org: string;
  let olaId: string;
  let eierBruker: string;
  let olaBruker: string;

  const kall = async (m: string, sti: string, k?: unknown, hvem = eier) => {
    const r = await app.request(sti, { method: m, headers: { authorization: hvem, "content-type": "application/json" }, body: k === undefined ? undefined : JSON.stringify(k) });
    return { status: r.status, data: (r.headers.get("content-type") ?? "").includes("json") ? ((await r.json()) as any) : null };
  };
  const varsler = () => ko.filter((o): o is Extract<Oppgave, { type: "varsel" }> => o.type === "varsel");

  beforeAll(async () => {
    settLokalOppgavekjorer(async (o) => {
      ko.push(o);
    });
    settKryptering(async (t) => Buffer.from(`kryptert:${t}`), async (b) => b.toString().replace("kryptert:", ""));
    settPushSender(async (a, innhold) => {
      sendt.push({ endpoint: a.endpoint, innhold: JSON.parse(innhold) });
      return {};
    });
    org = (await kall("POST", "/api/organisasjoner", { navn: "Bemanning Test AS" })).data.id;
    eierBruker = (await kall("GET", "/api/meg")).data.bruker.id;
  });

  it("slås på i oppsettet, med arbeidsmiljølovens grenser som standard", async () => {
    expect((await kall("GET", `/api/org/${org}/lonn-oppsett`)).data).toEqual({ aktiv: false, daglig_grense: 9, ukentlig_grense: 40, overtid_prosent: 40, bursdag_varsel: "av" });
    expect((await kall("PUT", `/api/org/${org}/lonn-oppsett`, { overtid_prosent: 30 })).data.error).toBe("Overtidstillegget er minst 40 % (arbeidsmiljøloven § 10-6)");
    expect((await kall("PUT", `/api/org/${org}/lonn-oppsett`, { aktiv: true })).data).toMatchObject({ aktiv: true, daglig_grense: 9 });
    expect((await kall("GET", "/api/meg")).data.organisasjoner.find((o: any) => o.id === org)).toMatchObject({ rolle: "eier", personal: true });
  });

  it("ansatte med fødselsnummer (kryptert) og kontonummer", async () => {
    const feil = (await kall("POST", `/api/org/${org}/ansatte`, { fornavn: "Ola", etternavn: "Nordmann", fnr: "15038510191" })).data.error;
    expect(feil).toBe("Fødselsnummeret er ikke gyldig (sjekk sifrene)");
    expect((await kall("POST", `/api/org/${org}/ansatte`, { fornavn: "Ola", etternavn: "Nordmann", kontonr: "1234.56.78901" })).data.error).toBe(
      "Kontonummeret er ikke gyldig (sjekk sifrene)",
    );
    expect((await kall("POST", `/api/org/${org}/ansatte`, { fornavn: " ", etternavn: "Nordmann" })).data.error).toBe("Skriv fornavnet");
    const a = await kall("POST", `/api/org/${org}/ansatte`, {
      fornavn: "Ola",
      etternavn: "Nordmann",
      epost: "Ola.Ansatt@server.test",
      fnr: "150385 10190",
      kontonr: "8601.11.17947",
      stilling: "Butikkmedarbeider",
      stillingsprosent: 60,
      ansatt_fra: "2026-01-01",
      lonnstype: "time",
      timelonn: 245.5,
      telefon: "",
    });
    expect(a.status).toBe(201);
    expect(a.data).toMatchObject({ ansattnummer: 1, fornavn: "Ola", epost: "ola.ansatt@server.test", har_fnr: true, fodselsdato: "1985-03-15", kontonr: "86011117947", telefon: null, tilgang: null });
    expect(a.data.fnr_kryptert).toBeUndefined();
    olaId = a.data.id;
    const lagret = await somSystem((db) => en(db, "select fnr_kryptert from faktura.ansatte where id = $1", [olaId]));
    expect(lagret!.fnr_kryptert.toString()).toBe("kryptert:15038510190");
    // Endre: fødselsnummeret kan byttes eller fjernes.
    expect((await kall("PATCH", `/api/org/${org}/ansatte/${olaId}`, { fnr: null })).data).toMatchObject({ har_fnr: false, fodselsdato: "1985-03-15" });
    expect((await kall("PATCH", `/api/org/${org}/ansatte/${olaId}`, { fnr: "15038510190", stillingsprosent: 60 })).data.har_fnr).toBe(true);
    expect((await kall("GET", `/api/org/${org}/ansatte`)).data.map((x: any) => x.fornavn)).toEqual(["Ola"]);
  });

  it("den ansatte inviteres på e-post og ser bare sitt eget", async () => {
    const inv = await kall("POST", `/api/org/${org}/ansatte/${olaId}/inviter`);
    expect(inv.data).toMatchObject({ koblet: false, sendt_til: "ola.ansatt@server.test" });
    const epost = ko.find((o) => o.type === "epost") as Extract<Oppgave, { type: "epost" }>;
    expect(epost).toMatchObject({ til: ["ola.ansatt@server.test"], emne: "Du er invitert til Bemanning Test AS i HI4 Faktura" });
    expect(epost.tekst).toContain(inv.data.lenke);
    expect((await kall("GET", `/api/org/${org}/ansatte/${olaId}`)).data.tilgang).toBe("invitert");

    expect((await kall("POST", "/api/invitasjoner/aksepter", { token: inv.data.lenke.split("/").pop() }, ola)).status).toBe(200);
    olaBruker = (await kall("GET", "/api/meg", undefined, ola)).data.bruker.id;
    expect((await kall("GET", "/api/meg", undefined, ola)).data.organisasjoner).toMatchObject([
      { id: org, navn: "Bemanning Test AS", rolle: "ansatt", personal: true, ansatt_id: olaId },
    ]);
    expect((await kall("GET", "/api/meg")).data.organisasjoner).toMatchObject([{ id: org, rolle: "eier", ansatt_id: null }]);
    // Organisasjonens innstillinger og Google Disk-kopiering er ikke for ansatte.
    expect((await kall("GET", `/api/org/${org}`, undefined, ola)).status).toBe(403);
    expect((await kall("GET", "/api/disk", undefined, ola)).data.organisasjoner).toEqual([]);
    expect((await kall("GET", `/api/org/${org}/ansatte/meg`, undefined, ola)).data).toMatchObject({ id: olaId, meg: true });
    expect((await kall("GET", `/api/org/${org}/ansatte`, undefined, ola)).status).toBe(403);

    // Ingen fakturadata.
    await kall("POST", `/api/org/${org}/kunder`, { navn: "Hemmelig Kunde AS" });
    expect((await kall("GET", `/api/org/${org}/kunder`, undefined, ola)).data).toEqual([]);
    expect((await kall("GET", `/api/org/${org}/fakturaer`, undefined, ola)).data).toEqual([]);
    expect((await kall("POST", `/api/org/${org}/kunder`, { navn: "Ny" }, ola)).status).toBe(403);
    expect((await kall("GET", `/api/org/${org}/ansatte/${olaId}`)).data.tilgang).toBe("koblet");
  });

  it("fører timer, leverer uka, og eieren godkjenner eller avviser", async () => {
    const nye = await Promise.all([
      kall("POST", `/api/org/${org}/timer`, { dato: "2026-10-05", fra: "08:00", til: "18:30", pause_min: 30 }, ola),
      kall("POST", `/api/org/${org}/timer`, { dato: "2026-10-06", fra: "22:00", til: "06:00" }, ola),
      kall("POST", `/api/org/${org}/timer`, { dato: "2026-10-07", timer: 3, overtid_prosent: 100, beskrivelse: "Varetelling" }, ola),
    ]);
    expect(nye.map((n) => [n.status, n.data.timer])).toEqual([
      [201, 10],
      [201, 8],
      [201, 3],
    ]);
    expect(nye[0].data).toMatchObject({ fra: "08:00", til: "18:30", status: "utkast", ansatt_navn: "Ola Nordmann" });
    expect((await kall("POST", `/api/org/${org}/timer`, { dato: "2026-10-05", fra: "08:00" }, ola)).data.error).toBe("Skriv både fra og til, eller bare antall timer");
    expect((await kall("POST", `/api/org/${org}/timer`, { dato: "2025-12-01", timer: 2 }, ola)).data.error).toBe("Datoen er utenfor ansettelsen (01.01.2026–)");

    // Uka: 10 timer mandag gir én time overtid; føringen merket med 100 % er overtid i sin helhet.
    const u = (await kall("GET", `/api/org/${org}/timer?fra=2026-10-05&til=2026-10-11`, undefined, ola)).data;
    expect(u.foringer).toHaveLength(3);
    expect(u.uker).toEqual([
      expect.objectContaining({ ansatt_id: olaId, uke: 41, ordinare: 17, overtid: [{ prosent: 40, timer: 1 }, { prosent: 100, timer: 3 }], sum: 21, status: "utkast" }),
    ]);

    // Endre: til bare timer og tilbake.
    expect((await kall("PATCH", `/api/org/${org}/timer/${nye[1].data.id}`, { timer: 7.5 }, ola)).data).toMatchObject({ timer: 7.5, fra: null, til: null });
    expect((await kall("PATCH", `/api/org/${org}/timer/${nye[1].data.id}`, { fra: "22:00", til: "06:30" }, ola)).data).toMatchObject({ timer: 8.5, fra: "22:00" });

    // Lever: eieren får varsel.
    const for_ = ko.length;
    expect((await kall("POST", `/api/org/${org}/timer/lever`, { fra: "2026-10-05", til: "2026-10-11" }, ola)).data).toEqual({ levert: 3 });
    expect(varsler().slice(-1)[0].varsel).toMatchObject({
      hendelse: "timer",
      org_id: org,
      bruker_ider: [eierBruker],
      tittel: "Timer levert: Ola Nordmann",
      tekst: "Ola Nordmann har levert 21,5 t for uke 41.",
    });
    expect(ko.length).toBe(for_ + 1);
    expect((await kall("POST", `/api/org/${org}/timer/lever`, { fra: "2026-10-05", til: "2026-10-11" }, ola)).status).toBe(409);
    expect((await kall("PATCH", `/api/org/${org}/timer/${nye[0].data.id}`, { timer: 1 }, ola)).data.error).toBe("Timene er levert og kan ikke endres");
    expect((await kall("DELETE", `/api/org/${org}/timer/${nye[0].data.id}`, undefined, ola)).status).toBe(409);
    expect((await kall("POST", `/api/org/${org}/timer/godkjenn`, { ider: [nye[0].data.id] }, ola)).status).toBe(403);

    // Til godkjenning: uka vises for eieren.
    const venter = (await kall("GET", `/api/org/${org}/timer?fra=2026-09-01&til=2026-10-31&status=levert`)).data;
    expect(venter.uker.map((x: any) => [x.ansatt_navn, x.uke, x.antall_status.levert])).toEqual([["Ola Nordmann", 41, 3]]);

    // Avvis én føring med grunn: den ansatte får varsel, retter og leverer på nytt.
    expect((await kall("POST", `/api/org/${org}/timer/avvis`, { ider: [nye[2].data.id], grunn: "" })).data.error).toBe("Skriv hvorfor timene avvises");
    expect((await kall("POST", `/api/org/${org}/timer/avvis`, { ider: [nye[2].data.id], grunn: "Overtiden var ikke avtalt." })).data).toEqual({ avvist: 1 });
    expect(varsler().slice(-1)[0].varsel).toMatchObject({
      bruker_ider: [olaBruker],
      tittel: "Timene for uke 41 ble avvist",
      tekst: "Overtiden var ikke avtalt. Rett dem og lever på nytt.",
    });
    expect((await kall("PATCH", `/api/org/${org}/timer/${nye[2].data.id}`, { overtid_prosent: null }, ola)).data).toMatchObject({ status: "utkast", avvist_grunn: "Overtiden var ikke avtalt." });
    expect((await kall("POST", `/api/org/${org}/timer/lever`, { fra: "2026-10-05", til: "2026-10-11" }, ola)).data).toEqual({ levert: 1 });
    expect((await kall("POST", `/api/org/${org}/timer/godkjenn`, { ider: nye.map((n) => n.data.id) })).data).toEqual({ godkjent: 3 });
    expect(varsler().slice(-1)[0].varsel).toMatchObject({ bruker_ider: [olaBruker], tittel: "Timene for uke 41 er godkjent", url: "/timer?uke=2026-10-05" });
    expect((await kall("GET", `/api/org/${org}/timer?fra=2026-10-05&til=2026-10-11`, undefined, ola)).data.uker[0].status).toBe("godkjent");
  });

  it("eieren fører for en ansatt, og ansatte med timer kan ikke slettes", async () => {
    const kari = (await kall("POST", `/api/org/${org}/ansatte`, { fornavn: "Kari", etternavn: "Hansen", ansatt_fra: "2026-09-01", lonnstype: "maaned", maanedslonn: 52000 })).data;
    expect((await kall("POST", `/api/org/${org}/timer`, { ansatt_id: kari.id, dato: "2026-10-05", timer: 7.5 })).status).toBe(201);
    expect((await kall("POST", `/api/org/${org}/timer`, { dato: "2026-10-05", timer: 7.5 })).data.error).toBe("Du er ikke registrert som ansatt her. Velg en ansatt.");
    expect((await kall("POST", `/api/org/${org}/timer`, { ansatt_id: kari.id, dato: "2026-10-05", timer: 1 }, ola)).status).toBe(403);
    expect((await kall("GET", `/api/org/${org}/timer?fra=2026-10-05&til=2026-10-11`, undefined, ola)).data.foringer.every((f: any) => f.ansatt_id === olaId)).toBe(true);
    expect((await kall("DELETE", `/api/org/${org}/ansatte/${kari.id}`)).data.error).toBe("Den ansatte har 1 timeføring og kan ikke slettes. Sett en sluttdato i stedet.");
    expect((await kall("PATCH", `/api/org/${org}/ansatte/${kari.id}`, { ansatt_til: "2026-12-31", aktiv: false })).data).toMatchObject({ ansatt_til: "2026-12-31", aktiv: false });
  });

  it("varsler til hele organisasjonen går ikke til ansatte, men varsler til dem gjør", async () => {
    const enhet = async (hvem: string, navn: string) => {
      const endpoint = `https://fcm.googleapis.com/fcm/send/pers-${navn}-${Date.now()}`;
      expect((await kall("POST", "/api/push/abonnement", { endpoint, p256dh: "B".repeat(87), auth: "a".repeat(22), enhet: navn }, hvem)).status).toBe(201);
      return endpoint;
    };
    expect((await kall("GET", "/api/push")).status).toBe(200); // VAPID-nøkkelen
    const eiersEnhet = await enhet(eier, "eier");
    const olasEnhet = await enhet(ola, "ola");
    await sendVarsel({ hendelse: "betaling", org_id: org, tittel: "Betaling mottatt", tekst: "Hemmelig Kunde AS betalte 10 000 kr", url: "/fakturaer" });
    expect(sendt.filter((s) => s.endpoint === eiersEnhet)).toHaveLength(1);
    expect(sendt.filter((s) => s.endpoint === olasEnhet)).toHaveLength(0);
    await sendVarsel({ hendelse: "timer", org_id: org, bruker_ider: [olaBruker], tittel: "Timene er godkjent", tekst: "", url: "/timer" });
    expect(sendt.filter((s) => s.endpoint === olasEnhet)).toHaveLength(1);
  });

  it("andre roller ser ikke ansatte, og tilgangen kan tas bort", async () => {
    const inv = await kall("POST", `/api/org/${org}/invitasjoner`, { epost: "pers-fakt@server.test", rolle: "fakturerer" });
    expect((await kall("POST", "/api/invitasjoner/aksepter", { token: inv.data.lenke.split("/").pop() }, fakturerer)).status).toBe(200);
    expect((await kall("GET", `/api/org/${org}/ansatte`, undefined, fakturerer)).status).toBe(403);
    expect((await kall("GET", `/api/org/${org}/timer?fra=2026-10-05&til=2026-10-11`, undefined, fakturerer)).data.foringer).toEqual([]);

    expect((await kall("DELETE", `/api/org/${org}/ansatte/${olaId}/tilgang`)).status).toBe(204);
    expect((await kall("GET", `/api/org/${org}`, undefined, ola)).status).toBe(404);
    expect((await kall("GET", "/api/meg", undefined, ola)).data.organisasjoner).toEqual([]);
    expect((await kall("GET", `/api/org/${org}/ansatte/${olaId}`)).data.tilgang).toBe(null);
  });
});
