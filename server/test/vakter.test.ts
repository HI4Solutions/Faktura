// Vaktplan: advarslene etter arbeidsmiljøloven (rene funksjoner), og i appen: planlegging,
// publisering med varsler, endringer som varsles, ledige vakter som tas, kopiering av uker og
// timer ført fra vakten. Datoene regnes fra neste uke, så testene ikke avhenger av datoen.
import { beforeAll, describe, expect, it } from "vitest";
import { lagApi } from "../src/api.js";
import { AML, uke } from "../src/arbeidstid.js";
import { advarsler, tidsrom, type PlanVakt } from "../src/vaktregler.js";
import { iDag } from "../src/regler.js";
import { settLokalOppgavekjorer, type Oppgave } from "../src/tjenester.js";

const pluss = (iso: string, n: number) => new Date(Date.parse(`${iso}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

describe("advarsler i vaktplanen", () => {
  const M = "2026-10-12"; // en mandag
  let n = 0;
  const v = (dag: number, fra: string, til: string, ansatt: string | null = "a"): PlanVakt => {
    const t = tidsrom({ dato: pluss(M, dag), fra, til });
    return { id: `v${++n}`, ansatt_id: ansatt, dato: pluss(M, dag), fra, til, timer: (t.slutt - t.start) / 60 };
  };
  const ansatt = new Map([["a", { ansatt_fra: "2026-01-01", ansatt_til: null, aktiv: true }]]);
  const sjekk = (vakter: PlanVakt[], a = ansatt) => {
    const r = advarsler(vakter, AML, a);
    return { vakt: (x: PlanVakt) => r.perVakt.get(x.id) ?? [], uke: r.perUke.get(`a:${M}`) ?? [] };
  };

  it("vakter over midnatt", () => {
    const t = tidsrom({ dato: M, fra: "22:00", til: "06:00" });
    expect(t.slutt - t.start).toBe(8 * 60);
  });

  it("minst 11 timer hvile mellom arbeidsdagene, men delte vakter samme dag er greit", () => {
    const kveld = v(0, "14:00", "22:00");
    const morgen = v(1, "06:00", "14:00");
    expect(sjekk([kveld, morgen]).vakt(morgen)).toEqual(["Bare 8 timer hvile før vakten (minst 11)"]);
    const delt = [v(0, "08:00", "12:00"), v(0, "16:00", "20:00")];
    expect(delt.map((x) => sjekk(delt).vakt(x))).toEqual([[], []]);
    // Nattevakt og en vakt rett etter.
    const natt = v(2, "22:00", "06:00");
    const etter = v(3, "06:00", "09:00");
    expect(sjekk([natt, etter]).vakt(etter)).toEqual(["Bare 0 timer hvile før vakten (minst 11)"]);
  });

  it("overlapp, overtid per dag og per uke", () => {
    const a = v(0, "08:00", "16:00");
    const b = v(0, "15:00", "18:00");
    expect([sjekk([a, b]).vakt(a), sjekk([a, b]).vakt(b)]).toEqual([
      ["Overlapper med en annen vakt", "Over 9 timer denne dagen (overtid)"],
      ["Overlapper med en annen vakt", "Over 9 timer denne dagen (overtid)"],
    ]);
    const uke45 = [0, 1, 2, 3, 4].map((d) => v(d, "07:00", "16:00")); // 9 timer, fem dager
    const r = sjekk(uke45);
    expect(uke45.map((x) => r.vakt(x))).toEqual([[], [], [], [], []]);
    expect(r.uke).toEqual(["Planlagt 45 timer (over 40)"]);
  });

  it("minst 35 timer sammenhengende fri i uka", () => {
    const hverDag = [0, 1, 2, 3, 4, 5, 6].map((d) => v(d, "08:00", "13:00"));
    expect(sjekk(hverDag).uke).toEqual(["Mindre enn 35 timer sammenhengende fri i uka"]);
    expect(sjekk(hverDag.slice(0, 5)).uke).toEqual([]); // helgen fri
  });

  it("ledige vakter og ansatte som har sluttet", () => {
    const ledig = v(0, "08:00", "16:00", null);
    expect(advarsler([ledig], AML, ansatt).perVakt.size).toBe(0);
    const sluttet = v(0, "08:00", "16:00");
    expect(sjekk([sluttet], new Map([["a", { ansatt_fra: "2026-01-01", ansatt_til: "2026-09-30", aktiv: true }]])).vakt(sluttet)).toEqual(["Ikke ansatt denne dagen"]);
    expect(sjekk([sluttet], new Map([["a", { ansatt_fra: "2026-01-01", ansatt_til: null, aktiv: false }]])).vakt(sluttet)).toEqual(["Den ansatte er ikke aktiv"]);
  });
});

describe.skipIf(!process.env.DATABASE_URL)("vaktplan i appen", () => {
  const app = lagApi();
  const eier = "Bearer test:uid-vakt-eier:vakt-eier@server.test:mfa";
  const ola = "Bearer test:uid-vakt-ola:ola.vakt@server.test";
  const kari = "Bearer test:uid-vakt-kari:kari.vakt@server.test";
  const fakturerer = "Bearer test:uid-vakt-fakt:vakt-fakt@server.test:mfa";
  const ko: Oppgave[] = [];
  let org: string;
  let olaId: string;
  let kariId: string;
  let eierBruker: string;
  let olaBruker: string;
  let kariBruker: string;
  // Neste uke (alltid fram i tid).
  const M = uke(pluss(iDag(), 7)).fra;
  const d = (n: number) => pluss(M, n);
  const vakter: Record<string, string> = {};

  const kall = async (m: string, sti: string, k?: unknown, hvem = eier) => {
    const r = await app.request(sti, { method: m, headers: { authorization: hvem, "content-type": "application/json" }, body: k === undefined ? undefined : JSON.stringify(k) });
    return { status: r.status, data: (r.headers.get("content-type") ?? "").includes("json") ? ((await r.json()) as any) : null };
  };
  const varsler = () => ko.filter((o): o is Extract<Oppgave, { type: "varsel" }> => o.type === "varsel").map((o) => o.varsel);
  const nye = (for_: number) => varsler().slice(for_);
  const dag = (iso: string) => new Intl.DateTimeFormat("nb-NO", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${iso}T12:00:00Z`));

  beforeAll(async () => {
    settLokalOppgavekjorer(async (o) => {
      ko.push(o);
    });
    org = (await kall("POST", "/api/organisasjoner", { navn: "Vaktplan Test AS" })).data.id;
    eierBruker = (await kall("GET", "/api/meg")).data.bruker.id;
    await kall("PUT", `/api/org/${org}/lonn-oppsett`, { aktiv: true });
    const ansatt = async (fornavn: string, epost: string, hvem: string) => {
      const a = (await kall("POST", `/api/org/${org}/ansatte`, { fornavn, etternavn: "Nordmann", epost, ansatt_fra: pluss(iDag(), -30) })).data;
      const inv = (await kall("POST", `/api/org/${org}/ansatte/${a.id}/inviter`)).data;
      expect((await kall("POST", "/api/invitasjoner/aksepter", { token: inv.lenke.split("/").pop() }, hvem)).status).toBe(200);
      return { id: a.id as string, bruker: (await kall("GET", "/api/meg", undefined, hvem)).data.bruker.id as string };
    };
    ({ id: olaId, bruker: olaBruker } = await ansatt("Ola", "ola.vakt@server.test", ola));
    ({ id: kariId, bruker: kariBruker } = await ansatt("Kari", "kari.vakt@server.test", kari));
  });

  it("eieren planlegger uka, med advarsler og sum per ansatt", async () => {
    const ny = async (k: Record<string, unknown>) => {
      const r = await kall("POST", `/api/org/${org}/vakter`, k);
      expect(r.status).toBe(201);
      return r.data;
    };
    vakter.olaMan = (await ny({ ansatt_id: olaId, dato: d(0), fra: "14:00", til: "22:00", oppgave: "Kasse" })).id;
    const tir = await ny({ ansatt_id: olaId, dato: d(1), fra: "06:00", til: "14:30", pause_min: 30 });
    expect(tir).toMatchObject({ timer: 8, publisert: false, fort: false, ansatt_navn: "Ola Nordmann", fra: "06:00", til: "14:30" });
    vakter.olaTir = tir.id;
    vakter.ledig = (await ny({ dato: d(2), fra: "10:00", til: "14:00", oppgave: "Lager" })).id;
    vakter.kariMan = (await ny({ ansatt_id: kariId, dato: d(0), fra: "12:00", til: "20:00" })).id;
    expect((await kall("POST", `/api/org/${org}/vakter`, { ansatt_id: olaId, dato: d(0), fra: "08:00", til: "08:00" })).data.error).toBe("Fra og til kan ikke være like");
    expect((await kall("POST", `/api/org/${org}/vakter`, { dato: d(0), fra: "8:00", til: "12:00" })).data.error).toBe("Skriv klokkeslettet som TT:MM");

    const plan = (await kall("GET", `/api/org/${org}/vakter?fra=${d(0)}&til=${d(6)}`)).data;
    expect(plan.vakter).toHaveLength(4);
    expect(plan.upubliserte).toBe(4);
    expect(plan.vakter.find((v: any) => v.id === vakter.olaTir).advarsler).toEqual(["Bare 8 timer hvile før vakten (minst 11)"]);
    expect(plan.uker).toEqual(expect.arrayContaining([{ ansatt_id: olaId, fra: M, planlagt: 16, avtalt: 37.5, advarsler: [] }]));

    // Utkast vises ikke for de ansatte, og de kan ikke planlegge.
    expect((await kall("GET", `/api/org/${org}/vakter?fra=${d(0)}&til=${d(6)}`, undefined, ola)).data.vakter).toEqual([]);
    expect((await kall("POST", `/api/org/${org}/vakter`, { ansatt_id: olaId, dato: d(3), fra: "08:00", til: "12:00" }, ola)).status).toBe(403);
  });

  it("publiserer uka: hver ansatt får én melding, og alle får beskjed om ledige vakter", async () => {
    const for_ = varsler().length;
    expect((await kall("POST", `/api/org/${org}/vakter/publiser`, { fra: d(0), til: d(6) })).data).toEqual({ publisert: 4, varslet: 2 });
    const u = uke(M).uke;
    expect(nye(for_)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ hendelse: "vakter", bruker_ider: [olaBruker], tittel: `Vaktplan for uke ${u}`, tekst: "Du har 2 nye vakter (16 t).", url: `/vakter?uke=${M}` }),
        expect.objectContaining({ bruker_ider: [kariBruker], tekst: "Du har 1 ny vakt (8 t)." }),
        expect.objectContaining({ bruker_ider: [olaBruker], tittel: "Ny ledig vakt", url: "/vakter?fane=ledige" }),
        expect.objectContaining({ bruker_ider: [kariBruker], tittel: "Ny ledig vakt" }),
      ]),
    );
    expect(nye(for_)).toHaveLength(4);

    // Ola ser hele den publiserte planen (også Karis vakt, 0063), uten advarsler.
    const olas = (await kall("GET", `/api/org/${org}/vakter?fra=${d(0)}&til=${d(6)}`, undefined, ola)).data;
    expect(olas.vakter.map((v: any) => [v.dato, v.ansatt_navn, v.oppgave, v.advarsler])).toEqual([
      [d(0), "Kari Nordmann", null, []],
      [d(0), "Ola Nordmann", "Kasse", []],
      [d(1), "Ola Nordmann", null, []],
      [d(2), null, "Lager", []],
    ]);
    expect(olas.uker).toEqual([]);
    expect((await kall("PATCH", `/api/org/${org}/vakter/${vakter.olaMan}`, { fra: "15:00" }, ola)).status).toBe(403);
  });

  it("endringer i publiserte vakter varsles til dem det gjelder", async () => {
    let for_ = varsler().length;
    expect((await kall("PATCH", `/api/org/${org}/vakter/${vakter.olaMan}`, { fra: "15:00" })).data).toMatchObject({ fra: "15:00", timer: 7 });
    expect(nye(for_)).toEqual([
      expect.objectContaining({ bruker_ider: [olaBruker], tittel: "Vakten din er endret", tekst: `${dag(d(0))} 15:00–22:00 (var ${dag(d(0))} 14:00–22:00).` }),
    ]);
    // Bare oppgaven endret: ingen melding.
    for_ = varsler().length;
    await kall("PATCH", `/api/org/${org}/vakter/${vakter.olaMan}`, { oppgave: "Kasse 2" });
    expect(nye(for_)).toEqual([]);
    // Karis vakt blir ledig: Kari får beskjed om at den er fjernet, Ola om en ny ledig vakt.
    for_ = varsler().length;
    expect((await kall("PATCH", `/api/org/${org}/vakter/${vakter.kariMan}`, { ansatt_id: null })).data.ansatt_id).toBe(null);
    expect(nye(for_)).toEqual([
      expect.objectContaining({ bruker_ider: [kariBruker], tittel: "Vakt fjernet", tekst: `Vakten din ${dag(d(0))} 12:00–20:00 er tatt bort fra planen.` }),
      expect.objectContaining({ bruker_ider: [olaBruker], tittel: "Ledig vakt" }),
    ]);
  });

  it("en ledig vakt tas av den første, og eieren får beskjed", async () => {
    const for_ = varsler().length;
    expect((await kall("POST", `/api/org/${org}/vakter/${vakter.ledig}/ta`, undefined, kari)).data).toMatchObject({ ansatt_id: kariId, ansatt_navn: "Kari Nordmann" });
    expect(nye(for_)).toEqual([
      expect.objectContaining({ hendelse: "vakter", bruker_ider: [eierBruker], tittel: "Vakt tatt: Kari Nordmann", tekst: `Kari Nordmann tok den ledige vakten ${dag(d(2))} 10:00–14:00.` }),
    ]);
    expect((await kall("POST", `/api/org/${org}/vakter/${vakter.ledig}/ta`, undefined, ola)).data.error).toBe("Vakten er ikke ledig lenger");
    // Ola har en vakt som overlapper den andre ledige (15–22 mot 12–20).
    expect((await kall("POST", `/api/org/${org}/vakter/${vakter.kariMan}/ta`, undefined, ola)).data.error).toBe("Du har allerede en vakt som overlapper");
    expect((await kall("POST", `/api/org/${org}/vakter/${vakter.kariMan}/ta`)).status).toBe(403); // eieren er ikke ansatt
  });

  it("timer føres fra vakten, og planlagte timer vises i timelisten", async () => {
    const t = await kall("POST", `/api/org/${org}/timer`, { dato: d(1), fra: "06:00", til: "14:30", pause_min: 30, vakt_id: vakter.olaTir }, ola);
    expect(t.status).toBe(201);
    expect(t.data.vakt_id).toBe(vakter.olaTir);
    expect((await kall("POST", `/api/org/${org}/timer`, { dato: d(2), timer: 4, vakt_id: vakter.ledig }, ola)).data.error).toBe("Vakten hører ikke til den ansatte");
    expect((await kall("GET", `/api/org/${org}/vakter?fra=${d(1)}&til=${d(1)}`, undefined, ola)).data.vakter[0].fort).toBe(true);
    const timer = (await kall("GET", `/api/org/${org}/timer?fra=${d(0)}&til=${d(6)}`, undefined, ola)).data;
    expect(timer.uker[0]).toMatchObject({ sum: 8, planlagt: 15 });
  });

  it("en publisert vakt som slettes, varsles; uker kopieres som utkast, uten dobbeltvakter", async () => {
    const for_ = varsler().length;
    expect((await kall("DELETE", `/api/org/${org}/vakter/${vakter.olaMan}`)).status).toBe(204);
    expect(nye(for_)).toEqual([expect.objectContaining({ bruker_ider: [olaBruker], tittel: "Vakt fjernet" })]);

    expect((await kall("POST", `/api/org/${org}/vakter/kopier`, { fra: d(0), til: d(0) })).data.error).toBe("Velg en annen uke å kopiere til");
    expect((await kall("POST", `/api/org/${org}/vakter/kopier`, { fra: d(0), til: d(7), antall: 2 })).data).toEqual({ kopiert: 6, hoppet_over: 0 });
    expect((await kall("POST", `/api/org/${org}/vakter/kopier`, { fra: d(0), til: d(7) })).data).toEqual({ kopiert: 0, hoppet_over: 3 });
    const neste = (await kall("GET", `/api/org/${org}/vakter?fra=${d(7)}&til=${d(13)}`)).data;
    expect(neste.vakter.map((v: any) => [v.dato, v.fra, v.publisert])).toEqual([
      [d(7), "12:00", false],
      [d(8), "06:00", false],
      [d(9), "10:00", false],
    ]);
    expect(neste.upubliserte).toBe(3);
    expect((await kall("POST", `/api/org/${org}/vakter/kopier`, { fra: d(0), til: d(7) }, ola)).status).toBe(403);
  });

  it("andre roller ser ikke vaktplanen", async () => {
    const inv = await kall("POST", `/api/org/${org}/invitasjoner`, { epost: "vakt-fakt@server.test", rolle: "fakturerer" });
    expect((await kall("POST", "/api/invitasjoner/aksepter", { token: inv.data.lenke.split("/").pop() }, fakturerer)).status).toBe(200);
    expect((await kall("GET", `/api/org/${org}/vakter?fra=${d(0)}&til=${d(6)}`, undefined, fakturerer)).data.vakter).toEqual([]);
    expect((await kall("POST", `/api/org/${org}/vakter`, { dato: d(3), fra: "08:00", til: "12:00" }, fakturerer)).status).toBe(403);
    expect((await kall("POST", `/api/org/${org}/vakter/publiser`, { fra: d(0), til: d(6) }, fakturerer)).status).toBe(403);
  });
});
