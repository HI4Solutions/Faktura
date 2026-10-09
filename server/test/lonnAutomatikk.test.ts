// Lønnen går av seg selv (0088_lonn_automatikk.sql, lonnAutomatikk.ts, lonn.ts, arbeidsplan.ts,
// vakter.ts): et utkast regnes ut på nytt når det vises etter at timer er godkjent, og av workeren
// hvert minutt; timene som venter på godkjenning står på kjøringen; workeren lager kjøringen for
// måneden (bare der lønn er kjørt de siste tre månedene, og ikke når det er slått av), varsler eier og administrator
// og minner på før lønnsdagen; og de førte timene står i vaktplanen og teller i ekstratimene (en
// ansatt ser bare sine egne).
import { beforeAll, describe, expect, it } from "vitest";
import { lagApi } from "../src/api.js";
import { en, somSystem } from "../src/db.js";
import { lonnHverMorgen, oppdaterLonnsutkast } from "../src/lonnAutomatikk.js";
import { settLokalOppgavekjorer, type Oppgave } from "../src/tjenester.js";

describe.skipIf(!process.env.DATABASE_URL)("lønnen går av seg selv", () => {
  const app = lagApi();
  const eier = "Bearer test:uid-lauto-api-eier:lauto-eier@server.test:mfa";
  const kariBruker = "Bearer test:uid-lauto-api-kari:kari.lauto@server.test";
  const ko: Oppgave[] = [];
  let org: string;
  let ola: string;
  let kari: string;
  let okt: string;

  const kall = async (m: string, sti: string, k?: unknown, hvem = eier) => {
    const r = await app.request(sti, { method: m, headers: { authorization: hvem, "content-type": "application/json" }, body: k === undefined ? undefined : JSON.stringify(k) });
    return { status: r.status, data: (r.headers.get("content-type") ?? "").includes("json") ? ((await r.json()) as any) : await r.text() };
  };
  const timelonn = (k: any) =>
    k.slipper
      .find((s: any) => s.ansatt_id === kari)
      ?.linjer.filter((l: any) => !l.fjernet && l.lonnsart === "timelonn")
      .map((l: any) => [l.antall, l.belop]) ?? [];
  // En føring for Kari, levert (og godkjent, om ikke annet er sagt).
  const fort = async (dato: string, timer: number, godkjenn = true) => {
    const r = await kall("POST", `/api/org/${org}/timer`, { ansatt_id: kari, dato, timer });
    expect(r.status, JSON.stringify(r.data)).toBe(201);
    expect((await kall("POST", `/api/org/${org}/timer/lever`, { ansatt_id: kari, fra: dato, til: dato })).status).toBe(200);
    if (godkjenn) expect((await kall("POST", `/api/org/${org}/timer/godkjenn`, { ider: [r.data.id] })).data).toEqual({ godkjent: 1 });
    return r.data.id as string;
  };
  const utdatert = async (k: string) => (await somSystem((db) => en<{ u: boolean }>(db, "select faktura.lonn_utdatert($1) as u", [k])))?.u;
  const varsler = () => ko.filter((o) => o.type === "varsel").map((o: any) => o.varsel);

  beforeAll(async () => {
    settLokalOppgavekjorer(async (o) => void ko.push(o));
    org = (await kall("POST", "/api/organisasjoner", { navn: "Lønnsautomatikk Test AS" })).data.id;
    expect((await kall("PUT", `/api/org/${org}/lonn-oppsett`, { aktiv: true })).status).toBe(200);
    const ny = async (b: Record<string, unknown>) => {
      const r = await kall("POST", `/api/org/${org}/ansatte`, { ansatt_fra: "2025-01-01", yrkeskode: "2221104", skattekort: "prosent", skattekort_aar: 2026, ...b });
      expect(r.status, JSON.stringify(r.data)).toBe(201);
      return r.data.id as string;
    };
    ola = await ny({ fornavn: "Ola", etternavn: "Fast", lonnstype: "maaned", maanedslonn: 40000, skatt_prosent: 30 });
    kari = await ny({ fornavn: "Kari", etternavn: "Time", lonnstype: "time", timelonn: 250, stillingsprosent: 50, skatt_prosent: 20, epost: "kari.lauto@server.test" });
    const inv = await kall("POST", `/api/org/${org}/ansatte/${kari}/inviter`);
    expect((await kall("POST", "/api/invitasjoner/aksepter", { token: inv.data.lenke.split("/").pop() }, kariBruker)).status).toBe(200);
  });

  it("valget i oppsettet er på som standard", async () => {
    expect((await kall("GET", `/api/org/${org}/lonn-oppsett`)).data.auto_kjoring).toBe(true);
  });

  it("utkastet regnes ut på nytt når det vises etter at en time er godkjent", async () => {
    const k = await kall("POST", `/api/org/${org}/lonn/kjoringer`, { periode: "2026-10" });
    expect(k.status, JSON.stringify(k.data)).toBe(201);
    okt = k.data.id;
    expect(k.data).toMatchObject({ automatisk: false, utdatert: false, timer: { levert: 0, utkast: 0 } });
    expect(k.data.beregnet).toBeTruthy();
    expect(timelonn(k.data)).toEqual([]);

    await fort("2026-10-05", 3);
    expect(await utdatert(okt)).toBe(true);
    const etter = (await kall("GET", `/api/org/${org}/lonn/kjoringer/${okt}`)).data;
    expect(timelonn(etter)).toEqual([[3, 750]]);
    expect(etter.utdatert).toBe(false);
    expect(await utdatert(okt)).toBe(false);

    // En føring som er levert, venter på godkjenning og er ikke med; en som bare er ført, er ikke levert.
    await fort("2026-10-06", 2, false);
    expect((await kall("POST", `/api/org/${org}/timer`, { ansatt_id: kari, dato: "2026-10-07", timer: 1 })).status).toBe(201);
    const venter = (await kall("GET", `/api/org/${org}/lonn/kjoringer/${okt}`)).data;
    expect(venter.timer).toEqual({ levert: 1, utkast: 1 });
    expect(timelonn(venter)).toEqual([[3, 750]]);
    // Lista regner også ut utkastene som er utdatert.
    await fort("2026-10-08", 1);
    const liste = (await kall("GET", `/api/org/${org}/lonn/kjoringer`)).data;
    expect(liste.find((x: any) => x.id === okt)).toMatchObject({ automatisk: false, brutto: 40000 + 4 * 250 });
  });

  it("workeren regner ut utkastene der noe er endret, også uten at noen ser på dem", async () => {
    const ider = (await kall("GET", `/api/org/${org}/timer?fra=2026-10-05&til=2026-10-11&ansatt=${kari}&status=levert`)).data.foringer.map((f: any) => f.id);
    expect(ider.length).toBe(1);
    expect((await kall("POST", `/api/org/${org}/timer/godkjenn`, { ider })).data).toEqual({ godkjent: 1 });
    expect(await utdatert(okt)).toBe(true);
    expect(await oppdaterLonnsutkast(25, org)).toBe(1);
    expect(await utdatert(okt)).toBe(false);
    const brutto = await somSystem((db) => en<{ b: number }>(db, "select brutto::float8 as b from faktura.lonnsslipper where kjoring_id = $1 and ansatt_id = $2", [okt, kari]));
    expect(brutto?.b).toBe(6 * 250);
    // Ingenting er endret: ingenting å gjøre.
    expect(await oppdaterLonnsutkast(25, org)).toBe(0);
  });

  it("workeren lager kjøringen for måneden når lønn er kjørt før, og varsler eier og administrator", async () => {
    // Uten en kjøring før denne måneden lages ingenting (oktober er den første).
    expect((await lonnHverMorgen("2026-10-01", org)).laget).toBe(0);
    expect((await kall("POST", `/api/org/${org}/lonn/kjoringer/${okt}/godkjenn`)).data.status).toBe("godkjent");
    // Slått av: ingenting.
    expect((await kall("PUT", `/api/org/${org}/lonn-oppsett`, { auto_kjoring: false })).data.auto_kjoring).toBe(false);
    expect((await lonnHverMorgen("2026-11-01", org)).laget).toBe(0);
    expect((await kall("PUT", `/api/org/${org}/lonn-oppsett`, { auto_kjoring: true })).data.auto_kjoring).toBe(true);

    ko.length = 0;
    const r = await lonnHverMorgen("2026-11-01", org);
    expect(r.laget).toBe(1);
    const liste = (await kall("GET", `/api/org/${org}/lonn/kjoringer`)).data;
    const nov = liste.find((x: any) => x.periode === "2026-11-01" && x.type === "ordinar");
    expect(nov).toMatchObject({ automatisk: true, status: "utkast", utbetalingsdato: "2026-11-20" });
    const k = (await kall("GET", `/api/org/${org}/lonn/kjoringer/${nov.id}`)).data;
    expect(k.slipper.find((s: any) => s.ansatt_id === ola).brutto).toBe(40000);
    expect(varsler()).toEqual([
      expect.objectContaining({
        hendelse: "lonn",
        org_id: org,
        tittel: "Lønnen for november 2026 er klar som utkast",
        tekst: "Lønnskjøringen holdes oppdatert med timer, fravær og endringer til den er godkjent. Lønnen utbetales 20.11.2026.",
        url: `/lonn?kjoring=${nov.id}`,
      }),
    ]);
    expect(varsler()[0].bruker_ider.length).toBe(1);
    // Én gang per måned, og ikke når lønn ikke er kjørt de siste tre månedene (november er den siste).
    expect((await lonnHverMorgen("2026-11-02", org)).laget).toBe(0);
    expect((await lonnHverMorgen("2027-03-01", org)).laget).toBe(0);
    // En ny time i november regnes inn av seg selv.
    await fort("2026-11-03", 2);
    expect(await oppdaterLonnsutkast(25, org)).toBe(1);
    expect(timelonn((await kall("GET", `/api/org/${org}/lonn/kjoringer/${nov.id}`)).data)).toEqual([[2, 500]]);
  });

  it("påminnelsen kommer én gang, tre dager før lønnsdagen, når kjøringen ikke er godkjent", async () => {
    const nov = (await kall("GET", `/api/org/${org}/lonn/kjoringer`)).data.find((x: any) => x.periode === "2026-11-01" && x.type === "ordinar");
    await fort("2026-11-04", 1, false);
    ko.length = 0;
    expect((await lonnHverMorgen("2026-11-16", org)).paaminnet).toBe(0);
    expect((await lonnHverMorgen("2026-11-17", org)).paaminnet).toBe(1);
    expect(varsler()).toEqual([
      expect.objectContaining({
        tittel: "Lønnen for november 2026 er ikke godkjent",
        tekst:
          "Lønnen skal utbetales 20.11.2026. Se over og godkjenn lønnskjøringen, og last opp betalingsfila i nettbanken. 1 timeføring venter på godkjenning.",
        url: `/lonn?kjoring=${nov.id}`,
      }),
    ]);
    expect((await lonnHverMorgen("2026-11-18", org)).paaminnet).toBe(0);
  });

  it("de førte timene står i vaktplanen og teller i ekstratimene; den ansatte ser bare sine egne", async () => {
    // Ola har fast plan mandag–fredag 08–16 (30 minutter pause) og fører en lørdag; Kari har en vakt
    // 08–12 og fører 08–14 fra den.
    expect(
      (
        await kall("PUT", `/api/org/${org}/ansatte/${ola}/arbeidsplan`, {
          gjelder_fra: "2026-10-12",
          dager: [1, 2, 3, 4, 5].map((ukedag) => ({ ukedag, fra: "08:00", til: "16:00", pause_min: 30 })),
        })
      ).status,
    ).toBe(200);
    const vakt = (await kall("POST", `/api/org/${org}/vakter`, { ansatt_id: kari, dato: "2026-10-13", fra: "08:00", til: "12:00" })).data.id;
    const lor = await kall("POST", `/api/org/${org}/timer`, { ansatt_id: ola, dato: "2026-10-17", fra: "10:00", til: "13:00" });
    expect(lor.status, JSON.stringify(lor.data)).toBe(201);
    expect((await kall("POST", `/api/org/${org}/timer/lever`, { ansatt_id: ola, fra: "2026-10-17", til: "2026-10-17" })).status).toBe(200);
    const kariFort = await kall("POST", `/api/org/${org}/timer`, { ansatt_id: kari, dato: "2026-10-13", fra: "08:00", til: "14:00", vakt_id: vakt });
    expect(kariFort.status, JSON.stringify(kariFort.data)).toBe(201);
    expect((await kall("POST", `/api/org/${org}/timer/lever`, { ansatt_id: kari, fra: "2026-10-13", til: "2026-10-13" })).status).toBe(200);

    const plan = (await kall("GET", `/api/org/${org}/vakter?fra=2026-10-12&til=2026-10-18`)).data;
    expect(plan.forte.map((f: any) => [f.ansatt_id, f.dato, f.fra, f.til, f.timer, f.status, f.vakt_id])).toEqual([
      [kari, "2026-10-13", "08:00", "14:00", 6, "levert", vakt],
      [ola, "2026-10-17", "10:00", "13:00", 3, "levert", null],
    ]);
    // Lørdagen er utenfor planen: tre ekstratimer (de førte timene, ikke vaktene).
    expect(plan.ekstra.filter((e: any) => e.ansatt_id === ola)).toEqual([{ ansatt_id: ola, dato: "2026-10-17", timer: 3, plan: true }]);
    const rapport = (await kall("GET", `/api/org/${org}/ekstratimer?fra=2026-10-12&til=2026-10-18`)).data;
    expect(rapport.ansatte.find((a: any) => a.ansatt_id === ola).dager).toEqual([{ dato: "2026-10-17", timer: 3, vakter: "Ført 10:00–13:00" }]);

    // Kari ser sine egne førte timer, men ikke Olas.
    const egen = (await kall("GET", `/api/org/${org}/vakter?fra=2026-10-12&til=2026-10-18`, undefined, kariBruker)).data;
    expect(egen.forte.map((f: any) => f.ansatt_id)).toEqual([kari]);
  });
});
