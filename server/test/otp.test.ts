// OTP-medlemskapet (0097, lonnsberegning.ts, amelding.ts): OTP fra 13-årsdagen, ikke for dem som
// har fylt 75 år når ordningen ikke tar dem opp (innstillingen), påminnelsene i a-meldingen om å
// melde den ansatte inn og ut hos pensjonsleverandøren, og datoene på den ansatte.
import { beforeAll, describe, expect, it } from "vitest";
import { lagApi } from "../src/api.js";
import { settLokalOppgavekjorer } from "../src/tjenester.js";

describe.skipIf(!process.env.DATABASE_URL)("OTP-medlemskapet", () => {
  const app = lagApi();
  const eier = "Bearer test:uid-otp-eier:otp-eier@server.test:mfa";
  let org: string;
  let ung: string;
  let eldre: string;

  const kall = async (m: string, sti: string, k?: unknown) => {
    const r = await app.request(sti, { method: m, headers: { authorization: eier, "content-type": "application/json" }, body: k === undefined ? undefined : JSON.stringify(k) });
    return { status: r.status, data: (r.headers.get("content-type") ?? "").includes("json") ? ((await r.json()) as any) : await r.text() };
  };
  const slipp = (k: any, ansatt: string) => k.slipper.find((s: any) => s.ansatt_id === ansatt);
  const otpAvvik = async (maaned: string) =>
    ((await kall("GET", `/api/org/${org}/amelding/${maaned}`)).data.avvik as { tekst: string }[]).map((a) => a.tekst).filter((t) => t.includes("OTP"));

  beforeAll(async () => {
    settLokalOppgavekjorer(async () => undefined);
    org = (await kall("POST", "/api/organisasjoner", { navn: "OTP Test AS" })).data.id;
    expect((await kall("PUT", `/api/org/${org}/lonn-oppsett`, { aktiv: true, otp_prosent: 2 })).data).toMatchObject({ otp_prosent: 2, otp_unntak_75: false });
    const ny = async (k: Record<string, unknown>) => {
      const r = await kall("POST", `/api/org/${org}/ansatte`, { lonnstype: "maaned", skattekort: "prosent", skatt_prosent: 20, skattekort_aar: 2026, yrkeskode: "5223101", ...k });
      expect(r.status, JSON.stringify(r.data)).toBe(201);
      return r.data.id as string;
    };
    // Fyller 13 år 10. november 2026, og fylte 75 år 1. mars 2026.
    ung = await ny({ fornavn: "Una", etternavn: "Ung", fodselsdato: "2013-11-10", ansatt_fra: "2026-09-01", maanedslonn: 5000 });
    eldre = await ny({ fornavn: "Egil", etternavn: "Eldre", fodselsdato: "1951-03-01", ansatt_fra: "2020-01-01", maanedslonn: 40000 });
  });

  it("OTP fra 13-årsdagen, og for dem over 75 til ordningen sier noe annet", async () => {
    const okt = (await kall("POST", `/api/org/${org}/lonn/kjoringer`, { periode: "2026-10" })).data;
    expect(slipp(okt, ung)).toMatchObject({ brutto: 5000, otp_grunnlag: 5000, otp: 0, aga_grunnlag: 5000 });
    expect(slipp(okt, ung).merknader).toContain("Ikke med i OTP: under 13 år (med fra 10.11.2026).");
    expect(slipp(okt, eldre)).toMatchObject({ otp: 800, aga_grunnlag: 40800 });
    // Ordningen tar ikke opp dem som har fylt 75 år: utkastet regnes ut på nytt uten OTP.
    expect((await kall("PUT", `/api/org/${org}/lonn-oppsett`, { otp_unntak_75: true })).data.otp_unntak_75).toBe(true);
    const ny = (await kall("POST", `/api/org/${org}/lonn/kjoringer/${okt.id}/beregn`)).data;
    expect(slipp(ny, eldre)).toMatchObject({ otp: 0, aga_grunnlag: 40000 });
    expect(slipp(ny, eldre).merknader).toContain("Ikke med i OTP: har fylt 75 år (ordningen tar ikke opp dem).");
    expect((await kall("POST", `/api/org/${org}/lonn/kjoringer/${okt.id}/godkjenn`)).status).toBe(200);
    const nov = (await kall("POST", `/api/org/${org}/lonn/kjoringer`, { periode: "2026-11" })).data;
    expect(slipp(nov, ung)).toMatchObject({ otp: 100 });
  });

  it("a-meldingen minner om inn- og utmelding hos pensjonsleverandøren", async () => {
    // Oktober: Una er ikke med ennå; Egil var med til og med 28.02.2026 og er ikke meldt inn.
    expect(await otpAvvik("2026-10")).toEqual([]);
    expect(await otpAvvik("2026-02")).toEqual(["Egil Eldre er med i OTP fra 01.01.2020: meld den ansatte inn hos pensjonsleverandøren, og før datoen på den ansatte."]);
    expect(await otpAvvik("2026-11")).toEqual(["Una Ung er med i OTP fra 10.11.2026: meld den ansatte inn hos pensjonsleverandøren, og før datoen på den ansatte."]);
    // Meldt inn: Egil skal meldes ut (han fylte 75 år).
    expect((await kall("PATCH", `/api/org/${org}/ansatte/${eldre}`, { otp_innmeldt: "2020-01-15" })).data).toMatchObject({ otp_innmeldt: "2020-01-15", otp_utmeldt: null });
    expect(await otpAvvik("2026-10")).toEqual(["Egil Eldre er med i OTP til og med 28.02.2026: meld den ansatte ut hos pensjonsleverandøren, og før datoen på den ansatte."]);
    expect((await kall("PATCH", `/api/org/${org}/ansatte/${eldre}`, { otp_utmeldt: "2019-12-31" })).data.error).toBe(
      "Datoen den ansatte ble meldt ut av OTP, kan ikke være før innmeldingen",
    );
    expect((await kall("PATCH", `/api/org/${org}/ansatte/${eldre}`, { otp_utmeldt: "2026-03-05" })).data.otp_utmeldt).toBe("2026-03-05");
    expect((await kall("PATCH", `/api/org/${org}/ansatte/${ung}`, { otp_innmeldt: "2026-11-12" })).status).toBe(200);
    expect(await otpAvvik("2026-10")).toEqual([]);
    expect(await otpAvvik("2026-11")).toEqual([]);
  });

  it("rapporten «OTP» har datoene for inn- og utmelding", async () => {
    const r = await kall("GET", `/api/org/${org}/rapportmodul/lonn.otp?fra=2026-10-01&til=2026-10-31`);
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data.rader.map((x: any) => [x.navn, x.otp, x.innmeldt, x.utmeldt])).toEqual([
      ["Una Ung", 0, "2026-11-12", null],
      ["Egil Eldre", 0, "2020-01-15", "2026-03-05"],
    ]);
  });
});
