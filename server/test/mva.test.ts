// Mva-meldingen fra bilagene (mva.ts, 0093_mva.sql): terminene og fristene, linjene etter
// Skatteetatens regler (utgående med grunnlag og sats, inngående bare avgiften, kjøp fra utlandet
// med to linjer, hele kroner, kodene uten kode på avgiftskontoene), oppgjøret med øreavrundingen
// (føres én gang, på nytt når terminen endres), levert og endret etterpå, sjekklisten i
// månedsavslutningen, merverdiavgift til gode fra banken, rapporten og tilgangen.
import { beforeAll, describe, expect, it } from "vitest";
import { lagApi } from "../src/api.js";
import { regnskapskontoer, type Regnskapsoppsett } from "../src/anlegg.js";
import { en, somSystem } from "../src/db.js";
import { avstemBankForAlle } from "../src/bankAvstemming.js";
import { avgiftskontoer, beregnMva, lagTermin, oppgjorsposter, terminFor, terminSomSlutter } from "../src/mva.js";
import { settLokalOppgavekjorer } from "../src/tjenester.js";

const oppsett = { kontoer: {} } as unknown as Regnskapsoppsett;

describe("mva: terminene og linjene", () => {
  it("terminene, periodene og fristene (en måned og ti dager, mai–juni 31. august, årstermin 10. mars, neste virkedag)", () => {
    expect(lagTermin(2026, "tomaaneder", 4)).toEqual({
      aar: 2026,
      type: "tomaaneder",
      termin: 4,
      fra: "2026-07-01",
      til: "2026-08-31",
      navn: "4. termin 2026 (juli–august)",
      periode: "juli-august",
      frist: "2026-10-12",
    });
    expect([1, 2, 3, 5, 6].map((t) => lagTermin(2026, "tomaaneder", t).frist)).toEqual(["2026-04-10", "2026-06-10", "2026-08-31", "2026-12-10", "2027-02-10"]);
    expect(lagTermin(2026, "aar", 1)).toMatchObject({ fra: "2026-01-01", til: "2026-12-31", navn: "2026 (årstermin)", periode: "aarlig", frist: "2027-03-10" });
    expect(lagTermin(2026, "maaned", 9)).toMatchObject({ fra: "2026-09-01", til: "2026-09-30", navn: "september 2026", periode: "september", frist: "2026-11-10" });
    expect(terminFor("2026-10-10", "tomaaneder").termin).toBe(5);
    expect(terminSomSlutter("2026-08", "tomaaneder")?.termin).toBe(4);
    expect(terminSomSlutter("2026-09", "tomaaneder")).toBe(null);
    expect(terminSomSlutter("2026-12", "aar")?.termin).toBe(1);
  });

  it("linjene: utgående med grunnlag og sats, inngående bare avgiften, utlandet på to linjer, hele kroner og kontroller", () => {
    const konti = avgiftskontoer(oppsett);
    const b = beregnMva(
      [
        // Salg 25 % og 12 %, salg utenfor loven, og en kreditnota.
        { konto: "3000", belop: -10000.4, mva_kode: "3" },
        { konto: "2700", belop: -2500.1, mva_kode: "3" },
        { konto: "3000", belop: 400, mva_kode: "3" },
        { konto: "2700", belop: 100, mva_kode: "3" },
        { konto: "3050", belop: -1000, mva_kode: "33" },
        { konto: "2703", belop: -120, mva_kode: "33" },
        { konto: "3200", belop: -5000, mva_kode: "6" },
        // Kjøp med fradrag (kostnaden har koden, men gir ikke grunnlag), og et anleggsmiddel uten kode.
        { konto: "6900", belop: 4000, mva_kode: "1" },
        { konto: "2710", belop: 1000, mva_kode: "1" },
        { konto: "2710", belop: 250.5, mva_kode: null },
        // Tjenester fra utlandet med fradrag.
        { konto: "6420", belop: 2000, mva_kode: "86" },
        { konto: "2714", belop: 500, mva_kode: "86" },
        { konto: "2704", belop: -500, mva_kode: "86" },
      ],
      konti,
    );
    expect(b.linjer.map((l) => [l.kode, l.grunnlag, l.sats, l.merverdiavgift, l.fradrag])).toEqual([
      ["1", null, null, -1251, true],
      ["3", 9600, 25, 2400, false],
      ["6", 5000, 0, 0, false],
      ["33", 1000, 12, 120, false],
      ["86", 2000, 25, 500, false],
      ["86", null, null, -500, true],
    ]);
    expect(b.sum).toBe(1269);
    expect(b.kontoer).toEqual({ "2700": -2400.1, "2703": -120, "2710": 1250.5, "2714": 500, "2704": -500 });
    expect(b.kontroller).toEqual(["1 postering på avgiftskontoene har ikke mva-kode; de er regnet med kontoens kode."]);
    // Oppgjøret: avgiftskontoene mot 2740 (hele kroner) og øredifferansen på 7740.
    const k = regnskapskontoer(oppsett);
    expect(oppgjorsposter(b, k, "Mva-oppgjør").map((p) => [p.konto, p.belop])).toEqual([
      ["2700", 2400.1],
      ["2703", 120],
      ["2704", 500],
      ["2710", -1250.5],
      ["2714", -500],
      ["2740", -1269],
      ["7740", -0.6],
    ]);
    // Feil kode for kontoen, avgift som ikke stemmer med grunnlaget, og fradrag uten beregnet avgift.
    const c = beregnMva(
      [
        { konto: "3000", belop: -1000, mva_kode: "3" },
        { konto: "2700", belop: -300, mva_kode: "1" },
        { konto: "2714", belop: 100, mva_kode: "86" },
      ],
      konti,
    );
    expect(c.kontroller).toEqual([
      "Ugyldig mva-kode for kontoen (kode 1 på 2700); regnet med kontoens kode.",
      "Kode 3: avgiften er 300,00 kr, men 25 % av grunnlaget er 250,00 kr.",
      "Kode 86: fradraget (100,00 kr) er større enn den beregnede avgiften (0,00 kr).",
    ]);
    // Kjøp fra utlandet: grunnlaget regnes fra den beregnede avgiften, både når kostnaden har avgiften
    // uten fradrag i seg (87) og når kjøpet er et anleggsmiddel uten koden på balansekontoen (86).
    const d = beregnMva(
      [
        { konto: "6420", belop: 3000, mva_kode: "87" },
        { konto: "2704", belop: -600, mva_kode: "87" },
        { konto: "2714", belop: 10000, mva_kode: "86" },
        { konto: "2704", belop: -10000, mva_kode: "86" },
      ],
      konti,
    );
    expect(d.linjer.map((l) => [l.kode, l.grunnlag, l.sats, l.merverdiavgift, l.fradrag])).toEqual([
      ["86", 40000, 25, 10000, false],
      ["86", null, null, -10000, true],
      ["87", 2400, 25, 600, false],
    ]);
    expect([d.sum, d.kontroller]).toEqual([600, []]);
  });
});

describe.skipIf(!process.env.DATABASE_URL)("mva-meldingen i appen", () => {
  const app = lagApi();
  const eier = "Bearer test:uid-mva-eier:mva-eier@server.test:mfa";
  const fakturerer = "Bearer test:uid-mva-fakt:mva-fakt@server.test:mfa";
  let org = "";
  let kunde = "";
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
  const faktura = async (enhetspris: number, mva_sats: number, fakturadato: string) => {
    const f = await ok("POST", o("/fakturaer"), { kunde_id: kunde, fakturadato, forfallsdato: fakturadato, linjer: [{ beskrivelse: "Legeerklæring", antall: 1, enhetspris, mva_sats }] });
    return ok("POST", o(`/fakturaer/${f.id}/utsted`), { send_epost: false });
  };

  beforeAll(async () => {
    settLokalOppgavekjorer(async () => {});
    org = (await ok("POST", "/api/organisasjoner", { navn: "Mva i regnskapet AS" })).id;
    await ok("PATCH", o(""), { kontonr: "86011117947", mva_registrert: true });
    const inv = await ok("POST", o("/invitasjoner"), { epost: "mva-fakt@server.test", rolle: "fakturerer" });
    expect((await kall("POST", "/api/invitasjoner/aksepter", { token: inv.lenke.split("/").pop() }, fakturerer)).status).toBe(200);
    kunde = (await ok("POST", o("/kunder"), { navn: "Forsikring AS", epost: "post@forsikring.test" })).id;
    // 4. termin 2026: to legeerklæringer med 25 % mva, én konsultasjon uten, og en utgift med fradrag.
    await faktura(1000, 25, "2026-07-10");
    await faktura(2000.4, 25, "2026-08-20");
    await faktura(600, 0, "2026-08-21");
    const u = await ok("POST", o("/regnskap/utgifter"), {
      type: "faktura",
      leverandor: "Telenor Norge AS",
      dato: "2026-08-10",
      forfallsdato: "2026-08-24",
      belop: 1250,
      linjer: [{ kategori: "telefon", konto: "6900", belop: 1000, mva_sats: 25, mva: 250 }],
    });
    await ok("POST", o(`/regnskap/utgifter/${u.id}/bokfor`));
  });

  it("linjene for terminen, som de føres i Altinn, og terminene i året", async () => {
    const m = await ok("GET", o("/regnskap/mva?aar=2026&termin=4"));
    expect(m.termin).toMatchObject({ navn: "4. termin 2026 (juli–august)", frist: "2026-10-12" });
    expect(m.linjer.map((l: any) => [l.kode, l.grunnlag, l.sats, l.merverdiavgift])).toEqual([
      ["1", null, null, -250],
      ["3", 3000, 25, 750],
      ["6", 600, 0, 0],
    ]);
    expect(m).toMatchObject({ sum: 500, registrert: true, over: true, kontroller: [], levert: null, endret: false, oppgjor: { bilag: null, stemmer: false, trengs: true } });
    expect(m.terminer.slice(0, 4).map((t: any) => [t.termin, t.sum])).toEqual([
      [1, 0],
      [2, 0],
      [3, 0],
      [4, 500],
    ]);
    expect((await kall("GET", o("/regnskap/mva?aar=2099&termin=1"))).data.error).toBe("Terminen har ikke begynt");
    expect((await kall("GET", o("/regnskap/mva?aar=2026&termin=7"))).data.error).toBe("Ugyldig termin");
    expect((await kall("GET", o("/regnskap/mva?aar=2026&termin=4"), undefined, fakturerer)).status).toBe(403);
  });

  it("oppgjøret: avgiftskontoene mot 2740, én gang, og på nytt når terminen endres", async () => {
    const r = await ok("POST", o("/regnskap/mva/2026/4/oppgjor"));
    expect(r.bilag.bilagsnummer).toBe("V-2026-1");
    expect(r.status.oppgjor).toEqual({ bilag: { id: r.bilag.id, bilagsnummer: "V-2026-1" }, stemmer: true, trengs: true });
    const b = (await ok("GET", o("/regnskap/bilag?fra=2026-08-31&til=2026-08-31&kilde=mva"))).bilag;
    expect(b.map((x: any) => [x.bilagsnummer, x.tekst, x.lenke])).toEqual([["V-2026-1", "Mva-oppgjør 4. termin 2026 (juli–august)", "/regnskap?fane=mva&aar=2026&termin=4"]]);
    expect(b[0].posteringer.map((p: any) => [p.konto, p.belop])).toEqual([
      ["2700", 750.1],
      ["2710", -250],
      ["2740", -500],
      ["7740", -0.1],
    ]);
    // Én gang: neste gang stemmer det.
    expect((await ok("POST", o("/regnskap/mva/2026/4/oppgjor"))).bilag).toBe(null);
    // Levert i Altinn.
    expect((await kall("PUT", o("/regnskap/mva/2026/4/levert"), { dato: "2026-08-31" })).data.error).toBe("Meldingen kan ikke være levert før terminen var over");
    const l = await ok("PUT", o("/regnskap/mva/2026/4/levert"), { dato: "2026-09-15" });
    expect(l).toMatchObject({ levert: { dato: "2026-09-15", belop: 500 }, endret: false });
    // En faktura til i terminen: oppgjøret stemmer ikke, og meldingen er endret etter at den ble levert.
    await faktura(400, 25, "2026-08-25");
    const e = await ok("GET", o("/regnskap/mva?aar=2026&termin=4"));
    expect(e).toMatchObject({ sum: 600, endret: true, oppgjor: { stemmer: false } });
    const ny = await ok("POST", o("/regnskap/mva/2026/4/oppgjor"));
    expect(ny.bilag.bilagsnummer).toBe("V-2026-3");
    const alle = (await ok("GET", o("/regnskap/bilag?fra=2026-08-31&til=2026-08-31&kilde=mva"))).bilag;
    expect(alle.map((x: any) => [x.bilagsnummer, x.reverserer !== null, x.reversert_av !== null])).toEqual([
      ["V-2026-1", false, true],
      ["V-2026-2", true, false],
      ["V-2026-3", false, false],
    ]);
    // Sjekklisten for august: meldingen er endret etter at den ble levert.
    const s = await ok("GET", o("/regnskap/maanedsstatus?maaned=2026-08"));
    expect(s.punkter.find((p: any) => p.nokkel === "mva")).toEqual({
      nokkel: "mva",
      navn: "Merverdiavgiften",
      ok: false,
      tekst: "Mva-meldingen er endret etter at den ble levert (nå 600,00 kr å betale): lever en korrigert melding.",
      lenke: "/regnskap?fane=mva&aar=2026&termin=4",
    });
    await ok("PUT", o("/regnskap/mva/2026/4/levert"), { dato: "2026-09-20" });
    const s2 = await ok("GET", o("/regnskap/maanedsstatus?maaned=2026-08"));
    expect(s2.punkter.find((p: any) => p.nokkel === "mva")).toMatchObject({ ok: true, tekst: "Mva-meldingen for 4. termin 2026 (juli–august) er levert (600,00 kr å betale)." });
    // Den generelle reverseringen gjelder ikke oppgjøret.
    expect((await kall("POST", o(`/regnskap/bilag/${ny.bilag.id}/reverser`), {})).data.error).toBe("Mva-oppgjøret rettes under Regnskap → Mva");
  });

  it("til gode: oppgjøret fører 2740 i debet, og innbetalingen fra Skatteetaten føres av seg selv", async () => {
    // 3. termin 2026: bare en utgift med fradrag.
    const u = await ok("POST", o("/regnskap/utgifter"), {
      type: "faktura",
      leverandor: "Dell AS",
      dato: "2026-06-10",
      forfallsdato: "2026-06-24",
      belop: 5000,
      linjer: [{ kategori: "kontorrekvisita", konto: "6800", belop: 4000, mva_sats: 25, mva: 1000 }],
    });
    await ok("POST", o(`/regnskap/utgifter/${u.id}/bokfor`));
    const r = await ok("POST", o("/regnskap/mva/2026/3/oppgjor"));
    expect(r.status.sum).toBe(-1000);
    await somSystem((db) =>
      db.query("insert into faktura.bankposter (org_id, konto, ekstern_id, dato, belop, motpart, melding) values ($1, '86011117947', 'mva-tilgode', '2026-09-02', 1000, 'SKATTEETATEN', 'Merverdiavgift')", [org]),
    );
    await avstemBankForAlle(5, org);
    const p = await somSystem((db) => en<{ status: string; regel: string }>(db, "select status, regel from faktura.bankposter where org_id = $1 and ekstern_id = 'mva-tilgode'", [org]));
    expect(p).toEqual({ status: "avstemt", regel: "Merverdiavgiften til gode (3. termin 2026 (mai–juni))" });
  });

  it("rapporten og terminene i oppsettet", async () => {
    const r = await ok("GET", o("/rapportmodul/regnskap.mva?aar=2026&termin=4"));
    expect(r.rader.map((x: any) => [x.kode, x.grunnlag, x.sats, x.mva])).toEqual([
      ["1", "", "", -250],
      ["3", 3400, 25, 850],
      ["6", 600, 0, 0],
    ]);
    expect(r.merknad).toBe("4. termin 2026 (juli–august): 600,00 kr å betale, fristen er 12.10.2026. Levert 20.09.2026. Oppgjøret er bokført (V-2026-3).");
    expect((await ok("PUT", o("/regnskap/oppsett"), { mva_termin: "aar" })).mva_termin).toBe("aar");
    // 2026 har oppgjør og meldinger annenhver måned: året beholder terminene (også i sjekklisten), så
    // avgiften ikke gjøres opp to ganger; 2025 har ingen, og får årstermin.
    const m = (await kall("GET", o("/regnskap/mva?aar=2026&termin=4"))).data;
    expect(m).toMatchObject({ type: "tomaaneder", termin: { navn: "4. termin 2026 (juli–august)" } });
    expect(m.kontroller).toContain(
      "Terminene i 2026 er annenhver måned, som oppgjørene og meldingene som er bokført og levert; innstillingen (årstermin) gjelder fra 2027, eller fra 2026 når de er angret.",
    );
    expect((await ok("GET", o("/regnskap/maanedsstatus?maaned=2026-08"))).punkter.find((p: any) => p.nokkel === "mva")).toMatchObject({ ok: true });
    expect((await ok("POST", o("/regnskap/mva/2026/4/oppgjor"))).bilag).toBe(null);
    expect((await kall("GET", o("/regnskap/mva?aar=2025&termin=4"))).data.termin.navn).toBe("2025 (årstermin)");
    expect((await kall("POST", o("/regnskap/mva/2025/2/oppgjor"))).data.error).toBe("Ugyldig termin");
    await ok("PUT", o("/regnskap/oppsett"), { mva_termin: "tomaaneder" });
  });
});
