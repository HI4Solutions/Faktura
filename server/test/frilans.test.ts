// Frilansere, oppdragstakere og styremedlemmer i lønnen (0096, lonn.ts, amelding.ts,
// lonnBokforing.ts): honorar i stedet for lønn (timene med timelønn uten overtid, fast honorar),
// ingen feriepenger, OTP, sykepenger eller ferietrekk, skatten etter prosentsatsen på
// tabellkortet, styrehonoraret lagt til for hånd, honorarene på egne kontoer i lønnsbilaget, og
// arbeidsforholdet i a-meldingen bare de månedene honoraret utbetales.
import { beforeAll, describe, expect, it } from "vitest";
import { lagApi } from "../src/api.js";
import { settLokalOppgavekjorer } from "../src/tjenester.js";

describe.skipIf(!process.env.DATABASE_URL)("frilansere og styremedlemmer", () => {
  const app = lagApi();
  const eier = "Bearer test:uid-frilans-eier:frilans-eier@server.test:mfa";
  let org: string;
  let kari: string;
  let lege: string;
  let styre: string;
  let okt: string;

  const kall = async (m: string, sti: string, k?: unknown) => {
    const r = await app.request(sti, { method: m, headers: { authorization: eier, "content-type": "application/json" }, body: k === undefined ? undefined : JSON.stringify(k) });
    return { status: r.status, data: (r.headers.get("content-type") ?? "").includes("json") ? ((await r.json()) as any) : await r.text() };
  };
  const slipp = (k: any, ansatt: string) => k.slipper.find((s: any) => s.ansatt_id === ansatt);

  beforeAll(async () => {
    settLokalOppgavekjorer(async () => undefined);
    org = (await kall("POST", "/api/organisasjoner", { navn: "Frilans Test AS" })).data.id;
    expect((await kall("PUT", `/api/org/${org}/lonn-oppsett`, { aktiv: true, otp_prosent: 2, feriepenger_prosent: 12, aga_sone: "1" })).status).toBe(200);
    const ny = async (k: Record<string, unknown>) => {
      const r = await kall("POST", `/api/org/${org}/ansatte`, { ansatt_fra: "2026-01-01", ...k });
      expect(r.status, JSON.stringify(r.data)).toBe(201);
      return r.data;
    };
    kari = (await ny({ fornavn: "Kari", etternavn: "Fast", lonnstype: "maaned", maanedslonn: 50000, skattekort: "prosent", skatt_prosent: 30, skattekort_aar: 2026, yrkeskode: "3311101" })).id;
    const l = await ny({
      fornavn: "Lise",
      etternavn: "Lege",
      ansatt_fra: "2026-10-01",
      lonnstype: "time",
      timelonn: 800,
      arbeidsforhold_type: "frilanserOppdragstakerHonorarPersonerMm",
      skattekort: "tabell",
      skatt_tabell: 7100,
      skatt_prosent: 40,
      skattekort_aar: 2026,
      yrkeskode: "2211107",
    });
    expect(l).toMatchObject({ arbeidsforhold_type: "frilanserOppdragstakerHonorarPersonerMm", honorar_art: "honorar" });
    lege = l.id;
    // Styrelederen har ikke fast honorar: styrehonoraret for året legges til for hånd.
    const s = await ny({
      fornavn: "Sverre",
      etternavn: "Styre",
      lonnstype: "maaned",
      arbeidsforhold_type: "frilanserOppdragstakerHonorarPersonerMm",
      honorar_art: "styrehonorar",
      skattekort: "tabell",
      skatt_tabell: 7100,
      skatt_prosent: 31,
      skattekort_aar: 2026,
      yrkeskode: "1120119",
    });
    expect(s.honorar_art).toBe("styrehonorar");
    styre = s.id;
    expect((await kall("PATCH", `/api/org/${org}/ansatte/${styre}`, { honorar_art: "styreleder" })).status).toBe(400);
  });

  it("honorar for timene uten overtid, og ingen feriepenger, OTP eller slipp uten honorar", async () => {
    // 8 timer mandag–torsdag og 12 fredag: for en ansatt ville 3 timer vært overtid.
    const ider: string[] = [];
    for (const [dato, timer] of [
      ["2026-10-05", 8],
      ["2026-10-06", 8],
      ["2026-10-07", 8],
      ["2026-10-08", 8],
      ["2026-10-09", 12],
    ] as const) {
      const r = await kall("POST", `/api/org/${org}/timer`, { ansatt_id: lege, dato, timer });
      expect(r.status, JSON.stringify(r.data)).toBe(201);
      ider.push(r.data.id);
    }
    expect((await kall("POST", `/api/org/${org}/timer/lever`, { ansatt_id: lege, fra: "2026-10-05", til: "2026-10-11" })).data).toEqual({ levert: 5 });
    expect((await kall("POST", `/api/org/${org}/timer/godkjenn`, { ider })).data).toEqual({ godkjent: 5 });

    const r = await kall("POST", `/api/org/${org}/lonn/kjoringer`, { periode: "2026-10" });
    expect(r.status, JSON.stringify(r.data)).toBe(201);
    okt = r.data.id;
    const l = slipp(r.data, lege);
    expect(l.linjer.map((x: any) => [x.lonnsart, x.tekst, x.antall, x.belop])).toEqual([["honorar", "Honorar for timer", 44, 35200]]);
    // Skatten etter prosentsatsen på tabellkortet; ingen feriepenger eller OTP, men arbeidsgiveravgift.
    expect(l).toMatchObject({
      brutto: 35200,
      skattetrekk: 14080,
      trekkmetode: "Prosenttrekk 40 % (tabellkort)",
      feriepengegrunnlag: 0,
      feriepenger_opptjent: 0,
      otp: 0,
      aga_grunnlag: 35200,
      aga: 4963.2,
      antall_timeforinger: 5,
    });
    expect(slipp(r.data, kari)).toMatchObject({ brutto: 50000, otp: 1000, feriepenger_opptjent: 6000 });
    // Styrelederen uten honorar i måneden har ingen slipp.
    expect(slipp(r.data, styre)).toBeUndefined();
  });

  it("styrehonoraret for hånd, og honorarene på egne kontoer i lønnsbilaget", async () => {
    const r = await kall("POST", `/api/org/${org}/lonn/kjoringer/${okt}/linjer`, { ansatt_id: styre, lonnsart: "styrehonorar", tekst: "Styrehonorar 2026", belop: 60000 });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(slipp(r.data, styre)).toMatchObject({ brutto: 60000, skattetrekk: 18600, trekkmetode: "Prosenttrekk 31 % (tabellkort)", otp: 0, feriepenger_opptjent: 0, aga: 8460 });

    const g = await kall("POST", `/api/org/${org}/lonn/kjoringer/${okt}/godkjenn`);
    expect(g.status, JSON.stringify(g.data)).toBe(200);
    const b = (await kall("GET", `/api/org/${org}/lonn/kjoringer/${okt}/bokforing`)).data.gjeldende;
    const konto = (nr: string) => b.posteringer.filter((p: any) => p.konto === nr).reduce((s: number, p: any) => s + p.belop, 0);
    expect(konto("5000")).toBe(50000);
    expect(konto("5390")).toBe(35200);
    expect(konto("5330")).toBe(60000);
    expect(b.posteringer.find((p: any) => p.konto === "5390")).toMatchObject({ navn: "Annen opplysningspliktig godtgjørelse (honorar)", tekst: "Honorar" });
    expect(b.posteringer.find((p: any) => p.konto === "5330")).toMatchObject({ navn: "Godtgjørelse til styremedlemmer", tekst: "Styrehonorar" });
    // Avgiften av alt; OTP og feriepenger bare av Karis lønn.
    expect(konto("2770")).toBeCloseTo(-(7191 + 4963.2 + 8460), 2);
  });

  it("a-meldingen: honorar og styrehonorar, og arbeidsforholdet bare i månedene med honorar", async () => {
    const okt = (await kall("GET", `/api/org/${org}/amelding/2026-10`)).data;
    const mottaker = (id: string) => okt.grunnlag.mottakere.find((m: any) => m.ansatt_id === id);
    expect(mottaker(lege).inntekter.map((i: any) => [i.beskrivelse, i.belop, i.trekk, i.aga])).toEqual([["honorarAkkordProsentProvisjon", 35200, true, true]]);
    expect(mottaker(styre).inntekter.map((i: any) => [i.beskrivelse, i.belop])).toEqual([["styrehonorarOgGodtgjoerelseVerv", 60000]]);
    expect(okt.grunnlag).toMatchObject({ antall_arbeidsforhold: 3, antall_med_lonn: 3 });
    // I november får ingen av dem honorar: bare Kari er med.
    const nov = (await kall("GET", `/api/org/${org}/amelding/2026-11`)).data;
    expect(nov.grunnlag.antall_arbeidsforhold).toBe(1);
    expect(nov.grunnlag.mottakere.map((m: any) => m.ansatt_id)).toEqual([kari]);
  });
});
