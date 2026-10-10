// Permittering (Lønn K4, permisjoner.ts, fravaer.ts, lonn.ts, amelding.ts): lønnsplikten ved
// delvis permittering (de permitterte timene summert til 15 dager), fritaksperioden på 26 uker i
// løpet av 18 måneder (lønnsplikten gjelder igjen, og lønnskjøringen trekker ikke lønnen etter det),
// meldingen til NAV når minst 10 permitteres, og arten for eldre permisjoner rett fra a-meldingen.
import { beforeAll, describe, expect, it } from "vitest";
import { lagApi } from "../src/api.js";
import type { Ansatt } from "../src/lonnsberegning.js";
import { fritaksperiode, lonnspliktDager, lonnspliktSlutt, maanederFor, permisjonslinjer, type Permisjon } from "../src/permisjoner.js";
import { settLokalOppgavekjorer } from "../src/tjenester.js";

const ansatt = (x: Partial<Ansatt> = {}): Ansatt =>
  ({ id: "a", ansatt_fra: "2025-01-01", ansatt_til: null, lonnstype: "maaned", maanedslonn: 30000, timelonn: null, stillingsprosent: 100, ...x }) as Ansatt;
const p = (id: string, fra: string, til: string, lonnsplikt_til: string | null = null) => ({ id, fra, til, lonnsplikt_til });

describe("permitteringen (uten database)", () => {
  it("lønnsplikten ved delvis permittering: de permitterte timene summeres til 15 dager", () => {
    expect([100, 50, 40, 20, null].map(lonnspliktDager)).toEqual([15, 30, 38, 75, 15]);
    // 50 % fra 1. oktober 2026: 22 arbeidsdager i oktober og 8 i november.
    expect(lonnspliktSlutt("2026-10-01", lonnspliktDager(50))).toBe("2026-11-11");
  });

  it("arbeidsdagene etter den faste arbeidsplanen: dager den ansatte uansett har fri, teller ikke", () => {
    // Mandag–onsdag fra mandag 5. oktober 2026: 15 arbeidsdager er fem uker.
    expect(lonnspliktSlutt("2026-10-05", 15, [1, 2, 3])).toBe("2026-11-04");
    // Tirsdag, torsdag og lørdag: lørdagene teller, men ikke 2. juledag (lørdag 26. desember).
    expect(lonnspliktSlutt("2026-12-01", 15, [2, 4, 6])).toBe("2027-01-05");
    // Uten plan: mandag–fredag.
    expect(lonnspliktSlutt("2026-10-05", 15, [])).toBe(lonnspliktSlutt("2026-10-05"));
  });

  it("18 måneder før (siste dag i måneden når dagen ikke finnes)", () => {
    expect(maanederFor("2026-08-31", 18)).toBe("2025-02-28");
    expect(maanederFor("2026-07-25", 18)).toBe("2025-01-25");
    expect(maanederFor("2026-01-15", 1)).toBe("2025-12-15");
  });

  it("fritaksperioden: 26 uker uten lønnsplikt i løpet av 18 måneder, for alle permitteringene", () => {
    // Lønnsplikt til og med 23. januar; fritaket fra 24. januar i 182 dager.
    expect(fritaksperiode([p("a", "2026-01-05", "2026-12-31", "2026-01-23")])).toEqual(new Map([["a", "2026-07-25"]]));
    // Avsluttet før: ikke brukt opp.
    expect(fritaksperiode([p("a", "2026-01-05", "2026-07-24", "2026-01-23")]).get("a")).toBeNull();
    // 122 dager i 2025 innenfor 18 måneder: 60 dager igjen i 2026.
    expect(fritaksperiode([p("a", "2025-03-01", "2025-06-30"), p("b", "2026-01-01", "2026-12-31")])).toEqual(
      new Map([
        ["a", null],
        ["b", "2026-03-02"],
      ]),
    );
    // Permitteringen for mer enn 18 måneder siden teller ikke.
    expect(fritaksperiode([p("a", "2024-01-01", "2024-06-30"), p("b", "2026-01-01", "2026-12-31")]).get("b")).toBe("2026-07-02");
  });

  it("lønnskjøringen: lønnen trekkes ikke når fritaksperioden er brukt opp", () => {
    const perm: Permisjon = { id: "x", ansatt_id: "a", fra: "2026-01-05", til: "2026-12-31", art: "permittering", prosent: 100, lonnsplikt_til: "2026-01-23", lonnsplikt_igjen: "2026-07-25" };
    // Juli 2026: 23 arbeidsdager, trekk for de 18 før 25. juli.
    const r = permisjonslinjer(ansatt(), [], [perm], "2026-07-01", "2026-07-31", () => 0);
    expect(r.linjer.map((l) => [l.lonnsart, l.tekst, l.belop])).toEqual([["trekk_permittering", "Trekk for permittering etter lønnsplikten (18 arbeidsdager)", -23478.26]]);
    expect(r.merknader).toContain(
      "Fritaksperioden for permitteringen (26 uker i løpet av 18 måneder) er brukt opp: lønnsplikten gjelder igjen fra 25.07.2026, så lønnen trekkes ikke etter det (permitteringslønnsloven § 3). Avslutt permitteringen, eller betal lønnen.",
    );
    // August: ikke noe trekk.
    expect(permisjonslinjer(ansatt(), [], [perm], "2026-08-01", "2026-08-31", () => 0).linjer).toEqual([]);
  });
});

describe.skipIf(!process.env.DATABASE_URL)("permitteringen i appen", () => {
  const app = lagApi();
  const eier = "Bearer test:uid-permk4-eier:permk4-eier@server.test:mfa";
  let org: string;
  let siv: string;
  let gamle: string;
  const andre: string[] = [];
  let sivPerm: string;

  const kall = async (m: string, sti: string, k?: unknown) => {
    const r = await app.request(sti, { method: m, headers: { authorization: eier, "content-type": "application/json" }, body: k === undefined ? undefined : JSON.stringify(k) });
    return { status: r.status, data: (r.headers.get("content-type") ?? "").includes("json") ? ((await r.json()) as any) : await r.text() };
  };
  const ny = async (b: Record<string, unknown>) => {
    const r = await kall("POST", `/api/org/${org}/ansatte`, {
      ansatt_fra: "2024-01-01",
      lonnstype: "maaned",
      maanedslonn: 30000,
      skattekort: "prosent",
      skatt_prosent: 30,
      skattekort_aar: 2026,
      yrkeskode: "2221104",
      kontonr: "86011117947",
      ...b,
    });
    expect(r.status, JSON.stringify(r.data)).toBe(201);
    return r.data.id as string;
  };
  const permitter = (ansatt_id: string, fra: string, til: string, x: Record<string, unknown> = {}) =>
    kall("POST", `/api/org/${org}/fravaer`, { ansatt_id, type: "permisjon", permisjon_art: "permittering", fra, til, varslet: "2025-12-15", ...x });

  beforeAll(async () => {
    settLokalOppgavekjorer(async () => undefined);
    org = (await kall("POST", "/api/organisasjoner", { navn: "Permittering Test AS" })).data.id;
    expect((await kall("PUT", `/api/org/${org}/lonn-oppsett`, { aktiv: true, otp_prosent: 0 })).status).toBe(200);
    siv = await ny({ fornavn: "Siv", etternavn: "Sesong" });
    gamle = await ny({ fornavn: "Gunn", etternavn: "Gammel" });
  });

  it("permitteringen i et helt år: fritaksperioden blir brukt opp 25.07.2026", async () => {
    const r = await permitter(siv, "2026-01-05", "2026-12-31");
    expect(r.status, JSON.stringify(r.data)).toBe(201);
    sivPerm = r.data.id;
    expect(r.data.lonnsplikt_til).toBe("2026-01-23");
    expect(r.data.merknader).toEqual([
      "Fritaksperioden (26 uker i løpet av 18 måneder) blir brukt opp: lønnsplikten gjelder igjen fra 25.07.2026, og lønnskjøringen trekker ikke lønnen etter det. Avslutt permitteringen før, eller betal lønnen.",
    ]);
    // Forkortes den, blir den ikke brukt opp.
    expect((await kall("PATCH", `/api/org/${org}/fravaer/${sivPerm}`, { til: "2026-06-30" })).data.merknader).toEqual([]);
    expect((await kall("PATCH", `/api/org/${org}/fravaer/${sivPerm}`, { til: "2026-12-31" })).data.merknader).toHaveLength(1);
    // Lønnskjøringen for juli: trekket for dagene før 25. juli, og merknaden.
    const k = await kall("POST", `/api/org/${org}/lonn/kjoringer`, { periode: "2026-07" });
    expect(k.status, JSON.stringify(k.data)).toBe(201);
    const s = k.data.slipper.find((x: any) => x.ansatt_id === siv);
    expect(s.linjer.filter((l: any) => !l.fjernet).map((l: any) => [l.lonnsart, l.belop])).toEqual([
      ["fastlonn", 30000],
      ["trekk_permittering", -23478.26],
    ]);
    expect(s.merknader.some((m: string) => m.startsWith("Fritaksperioden for permitteringen") && m.includes("25.07.2026"))).toBe(true);
    // Rapporten har datoen.
    const rap = await kall("GET", `/api/org/${org}/rapportmodul/lonn.permisjoner?fra=2026-01-01&til=2026-12-31`);
    expect(rap.data.rader.find((x: any) => x.navn === "Siv Sesong")).toMatchObject({ lonnsplikt_til: "2026-01-23", lonnsplikt_igjen: "2026-07-25" });
  });

  it("delvis permittering: lønnsplikten summeres til 15 dager", async () => {
    const r = await permitter(gamle, "2026-10-01", "2026-12-31", { prosent: 50, varslet: "2026-09-15" });
    expect(r.status, JSON.stringify(r.data)).toBe(201);
    expect(r.data.lonnsplikt_til).toBe("2026-11-11");
  });

  it("fast arbeidsplan: lønnsplikten telles på dagene den ansatte jobber", async () => {
    const tre = await ny({ fornavn: "Tea", etternavn: "Tredager" });
    const plan = await kall("PUT", `/api/org/${org}/ansatte/${tre}/arbeidsplan`, { gjelder_fra: "2026-01-01", dager: [{ ukedag: 1 }, { ukedag: 2 }, { ukedag: 3 }] });
    expect(plan.status, JSON.stringify(plan.data)).toBe(200);
    const r = await permitter(tre, "2026-10-05", "2026-12-31", { varslet: "2026-09-15" });
    expect(r.status, JSON.stringify(r.data)).toBe(201);
    expect(r.data.lonnsplikt_til).toBe("2026-11-04");
  });

  it("minst 10 permitteres: melding til NAV (i svaret og i a-meldingen for måneden)", async () => {
    for (let i = 0; i < 9; i++) andre.push(await ny({ fornavn: `Ansatt${i}`, etternavn: "Permittert" }));
    const svar: any[] = [];
    for (const [i, a] of [...andre, gamle].entries()) svar.push((await permitter(a, `2026-03-0${2 + (i % 3)}`, "2026-04-30", { varslet: "2026-02-10" })).data);
    // Gunn har alt en permittering i oktober; den nye i mars er den tiende.
    expect(svar.slice(0, 8).every((x) => !x.merknader.some((m: string) => m.includes("NAV")))).toBe(true);
    expect(svar.at(-1).merknader.find((m: string) => m.includes("NAV"))).toBe(
      "10 ansatte permitteres innen 30 dager. Når minst 10 permitteres, skal arbeidsgiveren gi melding til NAV senest samtidig med varselet til de ansatte (arbeidsmarkedsloven § 8, på nav.no).",
    );
    const avvik = (await kall("GET", `/api/org/${org}/amelding/2026-03`)).data.avvik as { tekst: string }[];
    expect(avvik.map((a) => a.tekst)).toContain(
      "10 ansatte er permittert fra en dag i måneden. Når minst 10 permitteres, skal arbeidsgiveren gi melding til NAV senest samtidig med varselet til de ansatte (arbeidsmarkedsloven § 8, på nav.no). Gjør det om det ikke er gjort.",
    );
  });

  it("en eldre permisjon uten art: arten velges rett fra a-meldingen", async () => {
    const f = await kall("POST", `/api/org/${org}/fravaer`, { ansatt_id: siv, type: "permisjon", fra: "2027-02-01", til: "2027-03-31" });
    expect(f.status, JSON.stringify(f.data)).toBe(201);
    const avvik = (await kall("GET", `/api/org/${org}/amelding/2027-02`)).data.avvik as { tekst: string; fravaer_id?: string }[];
    const a = avvik.find((x) => x.tekst.startsWith("Velg hva slags permisjon Siv Sesong"));
    expect(a?.fravaer_id).toBe(f.data.id);
    expect((await kall("PATCH", `/api/org/${org}/fravaer/${a!.fravaer_id}`, { permisjon_art: "utdanning" })).status).toBe(200);
    const etter = (await kall("GET", `/api/org/${org}/amelding/2027-02`)).data.avvik as { tekst: string }[];
    expect(etter.some((x) => x.tekst.startsWith("Velg hva slags permisjon"))).toBe(false);
  });
});
