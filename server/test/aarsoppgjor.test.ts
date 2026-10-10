// Årsoppgjøret og periodelåsen (aarsoppgjor.ts, 0094_aarsoppgjor.sql): resultatregnskapet og balansen,
// bilaget i serie Å med skatten, utbyttet og overføringen til annen egenkapital (én gang, på nytt når
// året endres, og angre), låsen (manuelle bilag avvises, det automatikken fører havner i den åpne
// perioden), sjekklisten i desember, rapportene og tilgangen.
import { beforeAll, describe, expect, it } from "vitest";
import { lagApi } from "../src/api.js";
import { regnskapskontoer, type Regnskapsoppsett } from "../src/anlegg.js";
import { disponering } from "../src/aarsoppgjor.js";
import { settLokalOppgavekjorer } from "../src/tjenester.js";

describe("årsoppgjøret uten database", () => {
  it("skatten, utbyttet og overføringen; underskudd dekkes av egenkapitalen; disponeringer ført ellers trekkes fra", () => {
    const k = regnskapskontoer({ kontoer: {} } as unknown as Regnskapsoppsett);
    const s = new Map([
      ["3200", -100000],
      ["5000", 20000],
      ["6300", 30000],
      ["1920", 50000],
    ]);
    const d = disponering(s, k, 11000, 20000);
    expect([d.resultat, d.aarsresultat, d.overforing]).toEqual([50000, 39000, 19000]);
    expect(d.posteringer.map((p) => [p.konto, p.belop])).toEqual([
      ["8300", 11000],
      ["2500", -11000],
      ["8920", 20000],
      ["2800", -20000],
      ["8960", 19000],
      ["2050", -19000],
    ]);
    const tap = disponering(new Map([["6300", 8000]]), k, 0, 0);
    expect(tap.posteringer).toEqual([
      { konto: "8960", belop: -8000, tekst: "Underskudd dekket av annen egenkapital" },
      { konto: "2050", belop: 8000, tekst: "Underskudd dekket av annen egenkapital" },
    ]);
    expect(disponering(new Map([["3200", -1000], ["8920", 400]]), k, 0, 0).overforing).toBe(600);
    expect(disponering(new Map(), k, 0, 0).posteringer).toEqual([]);
  });
});

describe.skipIf(!process.env.DATABASE_URL)("årsoppgjøret i appen", () => {
  const app = lagApi();
  const eier = "Bearer test:uid-aars-eier:aars-eier@server.test:mfa";
  const fakturerer = "Bearer test:uid-aars-fakt:aars-fakt@server.test:mfa";
  let org = "";
  const kall = async (metode: string, sti: string, kropp?: unknown, hvem = eier) => {
    const r = await app.request(sti, { method: metode, headers: { authorization: hvem, "content-type": "application/json" }, body: kropp === undefined ? undefined : JSON.stringify(kropp) });
    return { status: r.status, data: (r.headers.get("content-type") ?? "").includes("json") ? ((await r.json()) as any) : null };
  };
  const ok = async (metode: string, sti: string, kropp?: unknown) => {
    const r = await kall(metode, sti, kropp);
    expect(r.status, `${metode} ${sti}: ${JSON.stringify(r.data)}`).toBeLessThan(300);
    return r.data;
  };
  const o = (x: string) => `/api/org/${org}${x}`;
  const bilag = (dato: string, tekst: string, debet: string, kredit: string, belop: number) =>
    kall("POST", o("/regnskap/bilag"), { dato, tekst, linjer: [{ konto: debet, debet: belop }, { konto: kredit, kredit: belop }] });
  const linje = (l: any[], nokkel: string) => l.find((x) => x.nokkel === nokkel)?.belop;

  beforeAll(async () => {
    settLokalOppgavekjorer(async () => {});
    org = (await ok("POST", "/api/organisasjoner", { navn: "Årsoppgjøret AS" })).id;
    await ok("PATCH", o(""), { kontonr: "86011117947" });
    const inv = await ok("POST", o("/invitasjoner"), { epost: "aars-fakt@server.test", rolle: "fakturerer" });
    expect((await kall("POST", "/api/invitasjoner/aksepter", { token: inv.lenke.split("/").pop() }, fakturerer)).status).toBe(200);
    // 2025: aksjekapitalen, inntektene, lønnen og husleien.
    for (const [dato, tekst, d, k, b] of [
      ["2025-01-02", "Aksjekapital", "1920", "2000", 50000],
      ["2025-03-31", "Konsultasjoner", "1920", "3200", 100000],
      ["2025-06-30", "Lønn", "5000", "1920", 20000],
      ["2025-09-30", "Husleie", "6300", "1920", 30000],
    ] as const)
      expect((await bilag(dato, tekst, d, k, b)).status).toBe(201);
  });

  it("resultatregnskapet og balansen, og årsoppgjøret med skatt og utbytte", async () => {
    const s = await ok("GET", o("/regnskap/aarsoppgjor?aar=2025"));
    expect(s).toMatchObject({ aar: 2025, over: true, laast: false, laast_til: null });
    expect([linje(s.resultat, "inntekter"), linje(s.resultat, "lonn"), linje(s.resultat, "driftskostnader"), linje(s.resultat, "driftsresultat"), linje(s.resultat, "aarsresultat")]).toEqual([
      100000, -20000, -30000, 50000, 50000,
    ]);
    expect([linje(s.balanse, "bank"), linje(s.balanse, "eiendeler"), linje(s.balanse, "egenkapital"), linje(s.balanse, "udisponert"), linje(s.balanse, "ek_gjeld")]).toEqual([
      100000, 100000, 50000, 50000, 100000,
    ]);
    expect(s.oppgjor).toEqual({ skatt: 0, utbytte: 0, resultat: 50000, aarsresultat: 50000, overforing: 50000, bilag: null, stemmer: false, trengs: true });

    const r = await ok("POST", o("/regnskap/aarsoppgjor/2025"), { skatt: 11000, utbytte: 20000 });
    expect(r.bilag.bilagsnummer).toBe("Å-2025-1");
    expect(r.status.oppgjor).toMatchObject({ skatt: 11000, utbytte: 20000, aarsresultat: 39000, overforing: 19000, stemmer: true });
    expect([linje(r.status.resultat, "skatt"), linje(r.status.resultat, "aarsresultat"), linje(r.status.resultat, "disponeringer")]).toEqual([-11000, 39000, -39000]);
    expect([linje(r.status.balanse, "egenkapital"), linje(r.status.balanse, "udisponert"), linje(r.status.balanse, "kortsiktig"), linje(r.status.balanse, "ek_gjeld")]).toEqual([
      69000, 0, 31000, 100000,
    ]);
    const b = (await ok("GET", o("/regnskap/bilag?fra=2025-12-31&til=2025-12-31&kilde=aarsoppgjor"))).bilag;
    expect(b.map((x: any) => [x.bilagsnummer, x.tekst, x.lenke])).toEqual([["Å-2025-1", "Årsoppgjør 2025: årsresultat 39 000,00 kr", "/regnskap?fane=aarsoppgjor&aar=2025"]]);
    expect(b[0].posteringer.map((p: any) => [p.konto, p.belop])).toEqual([
      ["8300", 11000],
      ["2500", -11000],
      ["8920", 20000],
      ["2800", -20000],
      ["8960", 19000],
      ["2050", -19000],
    ]);
    // Én gang; et sent bilag i året gjør at det føres på nytt.
    expect((await ok("POST", o("/regnskap/aarsoppgjor/2025"), {})).bilag).toBe(null);
    expect((await bilag("2025-12-20", "Strøm desember", "6300", "1920", 5000)).status).toBe(201);
    expect((await ok("GET", o("/regnskap/aarsoppgjor?aar=2025"))).oppgjor).toMatchObject({ overforing: 14000, stemmer: false });
    expect((await ok("POST", o("/regnskap/aarsoppgjor/2025"), {})).bilag.bilagsnummer).toBe("Å-2025-3");
    // Den generelle reverseringen gjelder ikke årsoppgjøret.
    const id = (await ok("GET", o("/regnskap/bilag?fra=2025-12-31&til=2025-12-31&kilde=aarsoppgjor"))).bilag.find((x: any) => !x.reverserer && !x.reversert_av).id;
    expect((await kall("POST", o(`/regnskap/bilag/${id}/reverser`), {})).data.error).toBe("Årsoppgjøret rettes under Regnskap → Årsoppgjør");
  });

  it("låsen: manuelle bilag avvises, det automatikken fører havner i den åpne perioden, og årsoppgjøret står", async () => {
    expect((await kall("PUT", o("/regnskap/periodelas"), { til: "2099-12-31" })).data.error).toBe("Perioden som låses, må være over");
    expect((await ok("PUT", o("/regnskap/periodelas"), { til: "2025-12-31" })).laast_til).toBe("2025-12-31");
    expect((await ok("GET", o("/regnskap/aarsoppgjor?aar=2025"))).laast).toBe(true);
    expect((await bilag("2025-12-30", "For sent", "6300", "1920", 100)).data.error).toBe(
      "Regnskapet er låst til og med 31.12.2025; velg en senere dato (eller lås opp under Regnskap → Årsoppgjør)",
    );
    expect((await kall("POST", o("/regnskap/aarsoppgjor/2025"), { skatt: 12000 })).data.error).toBe("Året er låst; lås det opp først");
    expect((await kall("DELETE", o("/regnskap/aarsoppgjor/2025"))).data.error).toBe("Året er låst; lås det opp først");
    // En faktura datert i 2025 bokføres 1. januar 2026, med datoen i teksten.
    const kunde = (await ok("POST", o("/kunder"), { navn: "Sen kunde AS", epost: "post@sen.test" })).id;
    const f = await ok("POST", o("/fakturaer"), { kunde_id: kunde, fakturadato: "2025-11-15", forfallsdato: "2025-11-29", linjer: [{ beskrivelse: "Konsultasjon", antall: 1, enhetspris: 800, mva_sats: 0 }] });
    await ok("POST", o(`/fakturaer/${f.id}/utsted`), { send_epost: false });
    const fb = (await ok("GET", o("/regnskap/bilag?fra=2025-01-01&til=2026-12-31&kilde=faktura"))).bilag;
    expect(fb.map((x: any) => [x.dato, x.tekst.endsWith("(datert 15.11.2025, perioden er låst)")])).toEqual([["2026-01-01", true]]);
    // Årsoppgjøret for 2025 er uendret (bilaget havnet i 2026).
    expect((await ok("GET", o("/regnskap/aarsoppgjor?aar=2025"))).oppgjor).toMatchObject({ overforing: 14000, stemmer: true });
    // Lås opp og angre.
    expect((await ok("PUT", o("/regnskap/periodelas"), { til: null })).laast_til).toBe(null);
    expect((await ok("DELETE", o("/regnskap/aarsoppgjor/2025"))).oppgjor).toMatchObject({ bilag: null, stemmer: false });
    expect((await kall("DELETE", o("/regnskap/aarsoppgjor/2025"))).data.error).toBe("Årsoppgjøret er ikke bokført");
  });

  it("sjekklisten i desember, rapportene, året som ikke er over, og tilgangen", async () => {
    const des = await ok("GET", o("/regnskap/maanedsstatus?maaned=2025-12"));
    expect(des.punkter.find((p: any) => p.nokkel === "aarsoppgjor")).toEqual({
      nokkel: "aarsoppgjor",
      navn: "Årsoppgjøret",
      ok: false,
      tekst: "Årsoppgjøret for 2025 er ikke bokført: skatten og disponeringen av årsresultatet, og så låses året.",
      lenke: "/regnskap?fane=aarsoppgjor&aar=2025",
    });
    // Sjekklisten for året tar ikke med årsoppgjøret selv.
    expect((await ok("GET", o("/regnskap/aarsoppgjor?aar=2025"))).punkter.some((p: any) => p.nokkel === "aarsoppgjor")).toBe(false);
    const res = await ok("GET", o("/rapportmodul/regnskap.resultat?fra=2025-01-01&til=2025-12-31"));
    expect(res.rader.map((x: any) => [x.navn, x.belop])).toEqual([
      ["Driftsinntekter", 100000],
      ["Lønnskostnad", -20000],
      ["Andre driftskostnader", -35000],
      ["Driftsresultat", 45000],
      ["Resultat før skatt", 45000],
      ["Årsresultat", 45000],
    ]);
    expect(res.kolonner.map((k: any) => k.navn)).toEqual(["Linje", "2025", "2024"]);
    const bal = await ok("GET", o("/rapportmodul/regnskap.balanse?fra=2025-12-01&til=2025-12-31"));
    expect(bal.rader.find((x: any) => x.navn === "Sum eiendeler").belop).toBe(95000);
    expect(bal.merknad).toBe("Balansen 31.12.2025. Eiendelene er lik egenkapitalen og gjelden.");
    expect((await kall("POST", o("/regnskap/aarsoppgjor/2026"), {})).data.error).toBe("Året er ikke over");
    expect((await kall("GET", o("/regnskap/aarsoppgjor?aar=2099"))).data.error).toBe("Året har ikke begynt");
    expect((await kall("GET", o("/regnskap/aarsoppgjor?aar=2025"), undefined, fakturerer)).status).toBe(403);
    expect((await kall("PUT", o("/regnskap/periodelas"), { til: "2025-12-31" }, fakturerer)).status).toBe(403);
  });
});
