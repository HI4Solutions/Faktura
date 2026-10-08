// Vaktbytte (0060_vaktbytte.sql): en ansatt gir bort eller bytter en vakt med en kollega med samme
// rolle, kollegaen svarer, og eieren godkjenner (eller ikke, etter innstillingen). Varslene går til
// de riktige, den som godkjenner får advarslene byttet gir, og en fast arbeidsdag som byttes bort,
// kommer ikke tilbake og blir ikke ekstratimer. Datoene er i en uke uten helligdager fram i tid.
import { beforeAll, describe, expect, it } from "vitest";
import { lagApi } from "../src/api.js";
import { uke } from "../src/arbeidstid.js";
import { iDag } from "../src/regler.js";
import { helligdag } from "../src/helligdager.js";
import { settLokalOppgavekjorer, type Oppgave } from "../src/tjenester.js";

const pluss = (iso: string, n: number) => new Date(Date.parse(`${iso}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

describe.skipIf(!process.env.DATABASE_URL)("vaktbytte", () => {
  const app = lagApi();
  const eier = "Bearer test:uid-bytte-eier:bytte-eier@server.test:mfa";
  const hvem = {
    ola: "Bearer test:uid-bytte-ola:ola.bytte@server.test",
    kari: "Bearer test:uid-bytte-kari:kari.bytte@server.test",
    siri: "Bearer test:uid-bytte-siri:siri.bytte@server.test",
    lise: "Bearer test:uid-bytte-lise:lise.bytte@server.test",
  };
  const ko: Oppgave[] = [];
  let org: string;
  const id: Record<string, string> = {};
  const bruker: Record<string, string> = {};
  const vakt: Record<string, string> = {};
  // En uke uten helligdager mandag–søndag, fra neste uke.
  let M = uke(pluss(iDag(), 7)).fra;
  while ([0, 1, 2, 3, 4, 5, 6].some((n) => helligdag(pluss(M, n)))) M = pluss(M, 7);
  const d = (n: number) => pluss(M, n);
  const dag = (iso: string) => new Intl.DateTimeFormat("nb-NO", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${iso}T12:00:00Z`));

  const kall = async (m: string, sti: string, k?: unknown, som = eier) => {
    const r = await app.request(sti, { method: m, headers: { authorization: som, "content-type": "application/json" }, body: k === undefined ? undefined : JSON.stringify(k) });
    return { status: r.status, data: (r.headers.get("content-type") ?? "").includes("json") ? ((await r.json()) as any) : null };
  };
  const varsler = () => ko.filter((o): o is Extract<Oppgave, { type: "varsel" }> => o.type === "varsel").map((o) => o.varsel);
  const nye = (for_: number) => varsler().slice(for_);
  const bytter = async (som: string) => (await kall("GET", `/api/org/${org}/vaktbytter`, undefined, som)).data;

  beforeAll(async () => {
    settLokalOppgavekjorer(async (o) => {
      ko.push(o);
    });
    org = (await kall("POST", "/api/organisasjoner", { navn: "Vaktbytte Test AS" })).data.id;
    bruker.eier = (await kall("GET", "/api/meg")).data.bruker.id;
    await kall("PUT", `/api/org/${org}/lonn-oppsett`, { aktiv: true });
    for (const [navn, rolle] of [
      ["ola", "Sekretær"],
      ["kari", "Sekretær"],
      ["siri", "Sekretær"],
      ["lise", "Lege"],
    ] as const) {
      const fornavn = navn[0]!.toUpperCase() + navn.slice(1);
      const a = (await kall("POST", `/api/org/${org}/ansatte`, { fornavn, etternavn: "Bytte", epost: `${navn}.bytte@server.test`, ansatt_fra: pluss(iDag(), -30), rolle })).data;
      const inv = (await kall("POST", `/api/org/${org}/ansatte/${a.id}/inviter`)).data;
      expect((await kall("POST", "/api/invitasjoner/aksepter", { token: inv.lenke.split("/").pop() }, hvem[navn])).status).toBe(200);
      id[navn] = a.id;
      bruker[navn] = (await kall("GET", "/api/meg", undefined, hvem[navn])).data.bruker.id;
    }
    const ny = async (navn: string, ansatt: string, n: number, fra: string, til: string) => {
      const r = await kall("POST", `/api/org/${org}/vakter`, { ansatt_id: id[ansatt], dato: d(n), fra, til });
      expect(r.status).toBe(201);
      vakt[navn] = r.data.id;
    };
    await ny("olaMan", "ola", 0, "14:00", "22:00");
    await ny("kariMan", "kari", 0, "06:00", "10:00");
    await ny("kariTir", "kari", 1, "06:00", "14:00");
    await ny("olaTir", "ola", 1, "15:00", "21:00");
    await ny("olaOns", "ola", 2, "08:00", "16:00");
    await ny("kariTor", "kari", 3, "08:00", "16:00");
    await ny("liseMan", "lise", 0, "08:00", "16:00");
    expect((await kall("POST", `/api/org/${org}/vakter/publiser`, { fra: d(0), til: d(6) })).status).toBe(200);
  });

  it("gi bort til alle: kollegaene med samme rolle får varsel, tar vakten, og eieren godkjenner", async () => {
    const m = await kall("GET", `/api/org/${org}/vaktbytter/muligheter?vakt=${vakt.olaMan}`, undefined, hvem.ola);
    expect(m.status).toBe(200);
    expect(m.data.kolleger.map((k: any) => [k.navn, k.hindring])).toEqual([
      ["Kari Bytte", null],
      ["Siri Bytte", null],
    ]);
    // Karis vakter kan byttes mot (tirsdag kl. 06 gir under 11 timer hvile, men det er en advarsel).
    expect(m.data.vakter.map((v: any) => [v.navn, v.dato, v.hindring])).toEqual([
      ["Kari Bytte", d(0), null],
      ["Kari Bytte", d(1), null],
      ["Kari Bytte", d(3), null],
    ]);

    const for_ = varsler().length;
    const t = await kall("POST", `/api/org/${org}/vaktbytter`, { vakt_id: vakt.olaMan, melding: "Bursdag" }, hvem.ola);
    expect(t.status).toBe(201);
    expect(t.data).toMatchObject({ status: "tilbudt", fra_navn: "Ola Bytte", til_ansatt: null, dato: d(0), fra: "14:00", til: "22:00", melding: "Bursdag" });
    expect(nye(for_)).toEqual([
      expect.objectContaining({
        hendelse: "vakter",
        bruker_ider: expect.arrayContaining([bruker.kari, bruker.siri]),
        tittel: "Ledig vakt fra Ola",
        tekst: `Ola Bytte gir bort vakten ${dag(d(0))} 14:00–22:00. Trykk for å ta den. «Bursdag»`,
        url: "/vakter?fane=ledige",
      }),
    ]);
    expect(nye(for_)[0]!.bruker_ider).toHaveLength(2);

    // Legen ser det ikke; Kari ser det, og kan ta vakten.
    expect((await bytter(hvem.lise)).bytter).toEqual([]);
    const k = await bytter(hvem.kari);
    expect(k.innstilling).toBe("godkjenning");
    expect(k.bytter).toEqual([expect.objectContaining({ id: t.data.id, status: "tilbudt", hindring: null })]);
    expect((await kall("POST", `/api/org/${org}/vaktbytter/${t.data.id}/svar`, { ja: true }, hvem.lise)).status).toBe(404);

    const for2 = varsler().length;
    const svar = await kall("POST", `/api/org/${org}/vaktbytter/${t.data.id}/svar`, { ja: true }, hvem.kari);
    expect(svar.status).toBe(200);
    expect(svar.data).toMatchObject({ status: "akseptert", tatt_av_navn: "Kari Bytte" });
    expect(nye(for2)).toEqual([
      expect.objectContaining({ bruker_ider: [bruker.ola], tittel: "Vakten din er tatt", tekst: `Kari Bytte tar vakten din ${dag(d(0))} 14:00–22:00. Byttet venter på godkjenning.` }),
      expect.objectContaining({ bruker_ider: [bruker.eier], tittel: "Vaktbytte til godkjenning", tekst: `Kari Bytte vil ta vakten til Ola Bytte ${dag(d(0))} 14:00–22:00.` }),
    ]);
    expect((await kall("POST", `/api/org/${org}/vaktbytter/${t.data.id}/svar`, { ja: true }, hvem.siri)).data.error).toBe("Vakten er allerede tatt");

    // Eieren ser advarslene: Kari får 12 timer mandag, og bare 8 timer hvile før tirsdagsvakten kl. 06.
    const e = await bytter(eier);
    expect(e.bytter.find((b: any) => b.id === t.data.id).advarsler).toEqual([
      `Kari Bytte, ${dag(d(0))}: Over 9 timer denne dagen (overtid)`,
      `Kari Bytte, ${dag(d(1))}: Bare 8 timer hvile før vakten (minst 11)`,
    ]);
    expect((await kall("POST", `/api/org/${org}/vaktbytter/${t.data.id}/godkjenn`, {}, hvem.kari)).status).toBe(403);

    const for3 = varsler().length;
    const g = await kall("POST", `/api/org/${org}/vaktbytter/${t.data.id}/godkjenn`, {});
    expect(g.status).toBe(200);
    expect(g.data.status).toBe("godkjent");
    expect(nye(for3)).toEqual([
      expect.objectContaining({ bruker_ider: [bruker.ola], tittel: "Vaktbyttet er godkjent", tekst: `Kari Bytte tar vakten din ${dag(d(0))} 14:00–22:00.` }),
      expect.objectContaining({ bruker_ider: [bruker.kari], tittel: "Vaktbyttet er godkjent", tekst: `Vakten ${dag(d(0))} 14:00–22:00 er din.` }),
    ]);
    const plan = (await kall("GET", `/api/org/${org}/vakter?fra=${d(0)}&til=${d(6)}`)).data;
    expect(plan.vakter.find((v: any) => v.id === vakt.olaMan).ansatt_navn).toBe("Kari Bytte");
  });

  it("bytte: nei takk, avvist med grunn, og trukket tilbake", async () => {
    // Kari vil bytte torsdagen sin mot Olas onsdag; Ola sier nei takk.
    const t = await kall("POST", `/api/org/${org}/vaktbytter`, { vakt_id: vakt.kariTor, til_ansatt: id.ola, mot_vakt_id: vakt.olaOns }, hvem.kari);
    expect(t.status).toBe(201);
    expect(t.data).toMatchObject({ til_navn: "Ola Bytte", mot_dato: d(2), mot_fra: "08:00", mot_til: "16:00" });
    expect(varsler().at(-1)).toMatchObject({
      bruker_ider: [bruker.ola],
      tittel: "Vil du bytte vakt?",
      tekst: `Kari Bytte vil bytte vakten ${dag(d(3))} 08:00–16:00 mot din ${dag(d(2))} 08:00–16:00.`,
      url: "/vakter?fane=bytter",
    });
    expect((await bytter(hvem.siri)).bytter.find((b: any) => b.id === t.data.id)).toBeUndefined();
    expect((await kall("POST", `/api/org/${org}/vaktbytter/${t.data.id}/svar`, { ja: false }, hvem.ola)).data.status).toBe("avslatt");
    expect(varsler().at(-1)).toMatchObject({ bruker_ider: [bruker.kari], tittel: "Nei takk", tekst: `Ola Bytte kan ikke ta vakten ${dag(d(3))} 08:00–16:00.` });

    // Ny runde: Ola sier ja, eieren avviser med en grunn.
    const t2 = await kall("POST", `/api/org/${org}/vaktbytter`, { vakt_id: vakt.kariTor, til_ansatt: id.ola, mot_vakt_id: vakt.olaOns }, hvem.kari);
    expect((await kall("POST", `/api/org/${org}/vaktbytter/${t2.data.id}/svar`, { ja: true }, hvem.ola)).data.status).toBe("akseptert");
    const a = await kall("POST", `/api/org/${org}/vaktbytter/${t2.data.id}/avvis`, { grunn: "Ola må være på jobb onsdag" });
    expect(a.data).toMatchObject({ status: "avvist", grunn: "Ola må være på jobb onsdag" });
    expect(varsler().at(-1)).toMatchObject({
      bruker_ider: expect.arrayContaining([bruker.kari, bruker.ola]),
      tittel: "Vaktbyttet ble ikke godkjent",
      tekst: `${dag(d(3))} 08:00–16:00 og ${dag(d(2))} 08:00–16:00 blir som før. «Ola må være på jobb onsdag»`,
    });

    // Ola gir onsdagen til Siri og trekker det tilbake; Siri får beskjed.
    const t3 = await kall("POST", `/api/org/${org}/vaktbytter`, { vakt_id: vakt.olaOns, til_ansatt: id.siri }, hvem.ola);
    expect(t3.status).toBe(201);
    expect((await kall("POST", `/api/org/${org}/vaktbytter/${t3.data.id}/trekk`, {}, hvem.kari)).status).toBe(404);
    expect((await kall("POST", `/api/org/${org}/vaktbytter/${t3.data.id}/trekk`, {}, hvem.ola)).data.status).toBe("trukket");
    expect(varsler().at(-1)).toMatchObject({ bruker_ider: [bruker.siri], tittel: "Vaktbytte trukket tilbake" });
    expect((await kall("POST", `/api/org/${org}/vaktbytter/${t3.data.id}/svar`, { ja: true }, hvem.siri)).data.error).toBe("Tilbudet er trukket tilbake");
  });

  it("uten godkjenning går byttet gjennom med en gang; slått av kan ingen bytte", async () => {
    expect((await kall("PUT", `/api/org/${org}/lonn-oppsett`, { vaktbytte: "fritt" })).data.vaktbytte).toBe("fritt");
    const t = await kall("POST", `/api/org/${org}/vaktbytter`, { vakt_id: vakt.olaTir, til_ansatt: id.siri }, hvem.ola);
    const for_ = varsler().length;
    const s = await kall("POST", `/api/org/${org}/vaktbytter/${t.data.id}/svar`, { ja: true }, hvem.siri);
    expect(s.data.status).toBe("godkjent");
    expect(nye(for_)).toEqual([
      expect.objectContaining({ bruker_ider: [bruker.ola], tittel: "Vakten din er tatt", tekst: `Siri Bytte tok vakten din ${dag(d(1))} 15:00–21:00.` }),
      expect.objectContaining({ bruker_ider: [bruker.eier], tittel: "Vaktbytte", tekst: `Siri Bytte tok vakten til Ola Bytte ${dag(d(1))} 15:00–21:00.` }),
    ]);
    const mine = (await kall("GET", `/api/org/${org}/vakter?fra=${d(0)}&til=${d(6)}`, undefined, hvem.siri)).data.vakter;
    expect(mine.map((v: any) => v.id)).toContain(vakt.olaTir);

    await kall("PUT", `/api/org/${org}/lonn-oppsett`, { vaktbytte: "av" });
    expect((await kall("POST", `/api/org/${org}/vaktbytter`, { vakt_id: vakt.olaOns }, hvem.ola)).data.error).toBe("Vaktbytte er ikke slått på i organisasjonen");
    expect((await bytter(hvem.ola)).innstilling).toBe("av");
    await kall("PUT", `/api/org/${org}/lonn-oppsett`, { vaktbytte: "godkjenning" });
  });

  it("en fast arbeidsdag byttes som en vakt: den kommer ikke tilbake, og byttet blir ikke ekstratimer", async () => {
    // Siri jobber mandag, tirsdag og onsdag 08–16 etter planen.
    const p = await kall("PUT", `/api/org/${org}/ansatte/${id.siri}/arbeidsplan`, {
      gjelder_fra: M,
      dager: [1, 2, 3].map((ukedag) => ({ ukedag, fra: "08:00", til: "16:00" })),
    });
    expect(p.status).toBe(200);
    // Siri bytter onsdagen (fast dag) mot Karis torsdag 08–16.
    const m = await kall("GET", `/api/org/${org}/vaktbytter/muligheter?dato=${d(2)}`, undefined, hvem.siri);
    expect(m.data.vakter.find((v: any) => v.vakt_id === vakt.kariTor)).toMatchObject({ hindring: null });
    const t = await kall("POST", `/api/org/${org}/vaktbytter`, { dato: d(2), til_ansatt: id.kari, mot_vakt_id: vakt.kariTor }, hvem.siri);
    expect(t.status).toBe(201);
    expect(t.data).toMatchObject({ dato: d(2), fra: "08:00", til: "16:00", mot_dato: d(3) });
    expect((await kall("POST", `/api/org/${org}/vaktbytter/${t.data.id}/svar`, { ja: true }, hvem.kari)).data.status).toBe("akseptert");
    expect((await kall("POST", `/api/org/${org}/vaktbytter/${t.data.id}/godkjenn`, {})).data.status).toBe("godkjent");

    const plan = (await kall("GET", `/api/org/${org}/vakter?fra=${d(0)}&til=${d(6)}`)).data;
    const siri = (dato: string) => [
      ...plan.vakter.filter((v: any) => v.ansatt_id === id.siri && v.dato === dato).map((v: any) => `vakt ${v.fra}–${v.til}`),
      ...plan.faste.filter((f: any) => f.ansatt_id === id.siri && f.dato === dato).map((f: any) => `fast ${f.fra}–${f.til}`),
    ];
    expect(siri(d(2))).toEqual([]); // fri onsdag
    expect(siri(d(3))).toEqual(["vakt 08:00–16:00"]); // Karis torsdag
    expect(siri(d(0))).toEqual(["fast 08:00–16:00"]); // resten av planen som før
    expect(plan.vakter.find((v: any) => v.dato === d(2) && v.fra === "08:00" && v.til === "16:00" && v.ansatt_id === id.kari)).toBeTruthy();
    // Torsdagen er ikke ekstratimer for Siri: timene fra onsdagen er flyttet dit.
    expect(plan.ekstra.filter((x: any) => x.ansatt_id === id.siri)).toEqual([]);
    // Og en vikar kan ikke settes inn for en fast dag hun har gitt bort.
    expect((await kall("POST", `/api/org/${org}/vakter/fra-plan`, { ansatt_id: id.siri, dato: d(2) })).data.error).toBe("Den ansatte har ingen fast arbeidsdag denne dagen");
  });
});
