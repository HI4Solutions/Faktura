// Lønnskjøringen (0065_lonn.sql, lonn.ts): skattekortet og lønnsoppsettet, trekktabellene,
// en kjøring med fastlønn, timelønn og overtid, linjer som endres, fjernes, legges til og
// tilbakestilles, skattetrekket for hånd, godkjenning (låst, timene lønnet, varsel og
// lønnsslippen for den ansatte, også som PDF og CSV), åpning igjen, neste måned og tallene hittil
// i år, ekstra kjøringer, tall fra et tidligere lønnssystem, feriepenger og ferietrekk året etter,
// halv skatt og sluttoppgjør i desember, og funksjonen «Lønn».
import { beforeAll, describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { lagApi } from "../src/api.js";
import { settLokalOppgavekjorer, type Oppgave } from "../src/tjenester.js";

describe.skipIf(!process.env.DATABASE_URL)("lønnskjøring", () => {
  const app = lagApi();
  const eier = "Bearer test:uid-lonn-eier:lonn-eier@server.test:mfa";
  const per = "Bearer test:uid-lonn-per:per.lonn@server.test";
  const admin = "Bearer test:uid-lonn-admin:lonn-admin@server.test:mfa";
  const ko: Oppgave[] = [];
  let org: string;
  let kari: string;
  let perId: string;
  let lise: string;
  let perBruker: string;
  let okt: string;
  let nov: string;
  let timeider: string[] = [];

  const kall = async (m: string, sti: string, k?: unknown, hvem = eier) => {
    const r = await app.request(sti, { method: m, headers: { authorization: hvem, "content-type": "application/json" }, body: k === undefined ? undefined : JSON.stringify(k) });
    const type = r.headers.get("content-type") ?? "";
    return {
      status: r.status,
      type,
      data: type.includes("json") ? ((await r.json()) as any) : type.includes("pdf") ? new Uint8Array(await r.arrayBuffer()) : await r.text(),
    };
  };
  const slipp = (k: any, ansatt: string) => k.slipper.find((s: any) => s.ansatt_id === ansatt);
  const linje = (s: any, art: string) => s.linjer.find((l: any) => l.lonnsart === art && !l.fjernet);

  beforeAll(async () => {
    settLokalOppgavekjorer(async (o) => {
      ko.push(o);
    });
    config.adminEposter.push("lonn-admin@server.test");
    org = (await kall("POST", "/api/organisasjoner", { navn: "Lønn Test AS" })).data.id;
    expect((await kall("PUT", `/api/org/${org}/lonn-oppsett`, { aktiv: true })).status).toBe(200);
  });

  it("lønnsoppsettet og skattekortet på de ansatte", async () => {
    expect((await kall("GET", `/api/org/${org}/lonn-oppsett`)).data).toMatchObject({ aga_sone: "1", otp_prosent: 2, feriepenger_prosent: 12, lonnsdag: 20, halv_skatt: "desember" });
    expect((await kall("PUT", `/api/org/${org}/lonn-oppsett`, { otp_prosent: 1 })).data.error).toBe("OTP-satsen er 0 (uten OTP) eller fra 2 til 25 %");
    expect((await kall("PUT", `/api/org/${org}/lonn-oppsett`, { aga_sone: "6" })).data.error).toBe("Velg sone for arbeidsgiveravgift");
    expect((await kall("PUT", `/api/org/${org}/lonn-oppsett`, { lonnsdag: 20, aga_sone: "1" })).data).toMatchObject({ lonnsdag: 20, aga_sone: "1" });

    const ny = (k: Record<string, unknown>) => kall("POST", `/api/org/${org}/ansatte`, { ansatt_fra: "2025-01-01", ...k });
    // Tabelltrekk krever tabellnummer og prosentsats.
    expect((await ny({ fornavn: "Feil", etternavn: "Kort", skattekort: "tabell", skatt_tabell: 7100 })).data.error).toBe(
      "Skattekortet mangler opplysninger: tabelltrekk trenger tabellnummer og prosentsats, prosenttrekk en prosentsats og frikort et beløp",
    );
    expect((await ny({ fornavn: "Feil", etternavn: "Kort", skattekort: "tabell", skatt_tabell: 710, skatt_prosent: 30 })).data.error).toBe("Tabellnummeret har fire siffer");
    const k = await ny({
      fornavn: "Kari",
      etternavn: "Fast",
      lonnstype: "maaned",
      maanedslonn: 50000,
      kontonr: "86011117947",
      skattekort: "prosent",
      skatt_prosent: 30,
      skattekort_aar: 2026,
    });
    expect(k.status, JSON.stringify(k.data)).toBe(201);
    expect(k.data).toMatchObject({ skattekort: "prosent", skatt_prosent: 30, skatt_tabell: null, skattekort_aar: 2026 });
    kari = k.data.id;
    perId = (await ny({ fornavn: "Per", etternavn: "Time", lonnstype: "time", timelonn: 250, stillingsprosent: 50, epost: "per.lonn@server.test" })).data.id;
    lise = (
      await ny({ fornavn: "Lise", etternavn: "Tabell", lonnstype: "maaned", maanedslonn: 40000, skattekort: "tabell", skatt_tabell: 7100, skatt_prosent: 31, skattekort_aar: 2026 })
    ).data.id;
    // Per logger inn selv.
    const inv = await kall("POST", `/api/org/${org}/ansatte/${perId}/inviter`);
    expect((await kall("POST", "/api/invitasjoner/aksepter", { token: inv.data.lenke.split("/").pop() }, per)).status).toBe(200);
    perBruker = (await kall("GET", "/api/meg", undefined, per)).data.bruker.id;
  });

  it("trekktabellene lastes inn av plattformadministratoren", async () => {
    const rader = [
      [7100, 0, 0],
      [7100, 39900, 9000],
      [7100, 40000, 9040],
      [7100, 40100, 9080],
    ];
    expect((await kall("POST", "/api/admin/trekktabeller", { aar: 2026, forste: true, rader })).status).toBe(403);
    expect((await kall("POST", "/api/admin/trekktabeller", { aar: 2026, forste: true, rader }, admin)).data).toEqual({ lagret: 4 });
    expect((await kall("GET", "/api/admin/trekktabeller", undefined, admin)).data.find((x: any) => x.aar === 2026)).toEqual({ aar: 2026, tabeller: 1, rader: 4 });
  });

  it("timene føres og godkjennes", async () => {
    for (const [dato, timer] of [
      ["2026-10-05", 8],
      ["2026-10-06", 8],
      ["2026-10-07", 8],
      ["2026-10-08", 8],
      ["2026-10-09", 8],
      ["2026-10-12", 10],
    ] as const) {
      const r = await kall("POST", `/api/org/${org}/timer`, { dato, timer }, per);
      expect(r.status, JSON.stringify(r.data)).toBe(201);
      timeider.push(r.data.id);
    }
    expect((await kall("POST", `/api/org/${org}/timer/lever`, { fra: "2026-10-05", til: "2026-10-18" }, per)).data).toEqual({ levert: 6 });
    expect((await kall("POST", `/api/org/${org}/timer/godkjenn`, { ider: timeider })).data).toEqual({ godkjent: 6 });
  });

  it("en ny kjøring regner ut lønnsslippene", async () => {
    const r = await kall("POST", `/api/org/${org}/lonn/kjoringer`, { periode: "2026-10" });
    expect(r.status, JSON.stringify(r.data)).toBe(201);
    const k = r.data;
    okt = k.id;
    expect(k).toMatchObject({
      periode: "2026-10-01",
      type: "ordinar",
      status: "utkast",
      utbetalingsdato: "2026-10-20",
      feriepenger: false,
      halv_skatt: false,
      frister: { skattetrekk: "2026-10-21", aga: "2026-11-16" },
      trekktabeller: { aar: 2026, lastet: true },
    });
    expect(k.slipper).toHaveLength(3);
    expect(slipp(k, kari)).toMatchObject({ brutto: 50000, skattetrekk: 15000, netto: 35000, otp: 1000, aga_grunnlag: 51000, aga: 7191, trekkmetode: "Prosenttrekk 30 %" });
    const p = slipp(k, perId);
    // 50 timer (40 + 10), 1 time over dagsgrensen mandag 12.
    expect(p.linjer.map((l: any) => [l.lonnsart, l.antall, l.sats, l.belop])).toEqual([
      ["timelonn", 50, 250, 12500],
      ["overtid", 1, 100, 100],
    ]);
    expect(p).toMatchObject({ brutto: 12600, skattetrekk: 6300, netto: 6300, otp: 250, antall_timeforinger: 6, trekkmetode: "Uten skattekort (50 %)" });
    expect(p.merknader).toContain("Mangler skattekort: det trekkes 50 %. Registrer skattekortet på den ansatte.");
    expect(p.merknader).toContain("Mangler kontonummer på den ansatte.");
    expect(slipp(k, lise)).toMatchObject({ brutto: 40000, skattetrekk: 9040, trekkmetode: "Tabell 7100", trekkgrunnlag: 40000 });
    expect(k.sum).toMatchObject({ antall: 3, brutto: 102600, skattetrekk: 30340, netto: 72260 });

    // Én ordinær kjøring per måned.
    expect((await kall("POST", `/api/org/${org}/lonn/kjoringer`, { periode: "2026-10" })).data.error).toBe(
      "Det finnes alt en lønnskjøring for oktober 2026. Lag en ekstra kjøring i stedet.",
    );
    // Den ansatte ser ikke kjøringene, og ikke slippen før den er godkjent.
    expect((await kall("GET", `/api/org/${org}/lonn/kjoringer`, undefined, per)).status).toBe(403);
    expect((await kall("GET", `/api/org/${org}/lonn/kjoringer/${okt}`, undefined, per)).status).toBe(404);
    expect((await kall("GET", `/api/org/${org}/lonn/mine`, undefined, per)).data).toEqual([]);
    expect((await kall("GET", `/api/org/${org}/lonn/kjoringer`)).data).toMatchObject([{ id: okt, antall: 3, brutto: 102600 }]);
  });

  it("linjene kan legges til, endres, fjernes og tilbakestilles", async () => {
    const sti = `/api/org/${org}/lonn/kjoringer/${okt}`;
    expect((await kall("POST", `${sti}/linjer`, { ansatt_id: kari, lonnsart: "ukjent", belop: 1 })).data.error).toBe("Velg lønnsart");
    let k = (await kall("POST", `${sti}/linjer`, { ansatt_id: kari, lonnsart: "bonus", belop: 5000 })).data;
    expect(slipp(k, kari)).toMatchObject({ brutto: 55000, skattetrekk: 16500, otp: 1000 });
    const bonus = linje(slipp(k, kari), "bonus");
    expect(bonus).toMatchObject({ kilde: "manuell", tekst: "Bonus", belop: 5000 });

    // En utregnet linje som endres, blir manuell og regnes ikke ut på nytt.
    const fast = linje(slipp(k, kari), "fastlonn");
    expect(fast).toMatchObject({ kilde: "auto", belop: 50000 });
    k = (await kall("PATCH", `${sti}/linjer/${fast.id}`, { belop: 45000 })).data;
    expect(linje(slipp(k, kari), "fastlonn")).toMatchObject({ kilde: "manuell", belop: 45000 });
    k = (await kall("POST", `${sti}/beregn`)).data;
    expect(slipp(k, kari).brutto).toBe(50000);
    k = (await kall("POST", `${sti}/linjer/${fast.id}/tilbakestill`)).data;
    expect(linje(slipp(k, kari), "fastlonn")).toMatchObject({ kilde: "auto", belop: 50000 });

    // En utregnet linje som fjernes, merkes som fjernet (og kan tilbakestilles).
    const fast2 = linje(slipp(k, kari), "fastlonn");
    k = (await kall("DELETE", `${sti}/linjer/${fast2.id}`)).data;
    expect(slipp(k, kari).brutto).toBe(5000);
    expect(slipp(k, kari).linjer.find((l: any) => l.id === fast2.id)).toMatchObject({ fjernet: true, kilde: "manuell" });
    k = (await kall("POST", `${sti}/linjer/${fast2.id}/tilbakestill`)).data;
    expect(slipp(k, kari).brutto).toBe(55000);
    k = (await kall("DELETE", `${sti}/linjer/${bonus.id}`)).data;
    expect(slipp(k, kari).linjer.map((l: any) => l.lonnsart)).toEqual(["fastlonn"]);

    // Utgifter og trekk etter skatt.
    k = (await kall("POST", `${sti}/linjer`, { ansatt_id: perId, lonnsart: "utgift", tekst: "Bompenger", belop: 600 })).data;
    expect(slipp(k, perId)).toMatchObject({ brutto: 12600, utgifter: 600, netto: 6900 });
    k = (await kall("POST", `${sti}/linjer`, { ansatt_id: lise, lonnsart: "trekk_etter_skatt", tekst: "Kantine", antall: 4, sats: 250 })).data;
    expect(linje(slipp(k, lise), "trekk_etter_skatt")).toMatchObject({ belop: -1000, tekst: "Kantine" });
    expect(slipp(k, lise)).toMatchObject({ trekk_etter_skatt: -1000, netto: 29960 });

    // Skattetrekket for hånd, og tilbake til det utregnede.
    const ps = slipp(k, perId);
    k = (await kall("PUT", `${sti}/slipper/${ps.id}/skattetrekk`, { belop: 3000 })).data;
    expect(slipp(k, perId)).toMatchObject({ skattetrekk: 3000, skattetrekk_manuell: true, trekkmetode: "Uten skattekort (50 %) – endret for hånd" });
    k = (await kall("PUT", `${sti}/slipper/${ps.id}/skattetrekk`, { belop: null })).data;
    expect(slipp(k, perId)).toMatchObject({ skattetrekk: 6300, skattetrekk_manuell: false });
  });

  it("godkjent kjøring låses, timene er lønnet, og den ansatte får lønnsslippen", async () => {
    const sti = `/api/org/${org}/lonn/kjoringer/${okt}`;
    ko.length = 0;
    const k = (await kall("POST", `${sti}/godkjenn`)).data;
    expect(k).toMatchObject({ status: "godkjent", godkjent_av: expect.any(String) });
    expect(slipp(k, kari).kontonr).toBe("86011117947");
    const varsel = ko.find((o: any) => o.type === "varsel" && o.varsel.hendelse === "lonn") as any;
    expect(varsel.varsel).toMatchObject({ bruker_ider: [perBruker], url: "/lonn?fane=mine", tittel: "Lønnsslippen er klar" });
    expect(varsel.varsel.tekst).toBe("Lønnsslippen for oktober 2026 er klar. Lønnen utbetales 20.10.2026.");

    // Låst.
    expect((await kall("POST", `${sti}/linjer`, { ansatt_id: kari, lonnsart: "bonus", belop: 1 })).status).toBe(409);
    expect((await kall("PATCH", sti, { notat: "x" })).status).toBe(409);
    expect((await kall("DELETE", sti)).status).toBe(409);
    expect((await kall("POST", `${sti}/godkjenn`)).status).toBe(409);
    // Timene er lønnet og kan ikke avvises eller endres.
    expect((await kall("POST", `/api/org/${org}/timer/avvis`, { ider: [timeider[0]], grunn: "Feil" })).data.error).toBe(
      "Timene er lønnet og kan ikke endres. Åpne lønnskjøringen igjen først.",
    );

    // Den ansatte ser sin egen slipp, med tallene hittil i år, og som PDF.
    const mine = (await kall("GET", `/api/org/${org}/lonn/mine`, undefined, per)).data;
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ ansatt_id: perId, brutto: 12600, utgifter: 600, netto: 6900, periode: "2026-10-01" });
    const s = (await kall("GET", `/api/org/${org}/lonn/slipper/${mine[0].id}`, undefined, per)).data;
    expect(s.godkjent).toBe(true);
    expect(s.linjer.map((l: any) => l.lonnsart)).toEqual(["timelonn", "overtid", "utgift"]);
    expect(s.hittil).toMatchObject({ brutto: 12600, trekkpliktig: 12600, skattetrekk: 6300, feriepengegrunnlag: 12600 });
    expect((await kall("GET", `/api/org/${org}/lonn/slipper/${slipp(k, kari).id}`, undefined, per)).status).toBe(404);
    const pdf = await kall("GET", `/api/org/${org}/lonn/slipper/${mine[0].id}/pdf`, undefined, per);
    expect(pdf.status).toBe(200);
    expect(pdf.type).toBe("application/pdf");
    expect(new TextDecoder().decode((pdf.data as Uint8Array).slice(0, 5))).toBe("%PDF-");

    // CSV til regnskapet og nettbanken.
    const csv = await kall("GET", `${sti}/csv`);
    expect(csv.type).toContain("text/csv");
    const rader = (csv.data as string).replace(/^﻿/, "").trim().split("\r\n");
    expect(rader[0]).toBe(
      "Ansattnr.;Navn;Kontonummer;Bruttolønn;Skattetrekk;Utgiftsgodtgjørelse;Trekk etter skatt;Utbetales;Feriepengegrunnlag;Opptjente feriepenger;OTP;Grunnlag arbeidsgiveravgift;Arbeidsgiveravgift;Skattetrekk etter",
    );
    expect(rader).toHaveLength(4);
    expect(rader.find((r) => r.includes("Kari Fast"))).toContain(";86011117947;50000,00;15000,00;");
    expect((await kall("GET", `${sti}/csv`, undefined, per)).status).toBe(404);
  });

  it("en godkjent kjøring kan åpnes igjen og godkjennes på nytt", async () => {
    const sti = `/api/org/${org}/lonn/kjoringer/${okt}`;
    expect((await kall("POST", `${sti}/gjenapne`, undefined, per)).status).toBe(403);
    const k = (await kall("POST", `${sti}/gjenapne`)).data;
    expect(k.status).toBe("utkast");
    expect(slipp(k, kari).kontonr).toBe("86011117947"); // fra den ansatte igjen
    expect((await kall("GET", `/api/org/${org}/lonn/mine`, undefined, per)).data).toEqual([]);
    expect((await kall("POST", `${sti}/godkjenn`)).data.status).toBe("godkjent");
  });

  it("neste måned tar ikke med timene som er lønnet, og tallene hittil i år øker", async () => {
    // En dag til i uka som er lønnet (mandag 12. med 10 timer): overtiden regnes på hele uka.
    const sen = await kall("POST", `/api/org/${org}/timer`, { dato: "2026-10-13", timer: 9 }, per);
    expect((await kall("POST", `/api/org/${org}/timer/lever`, { fra: "2026-10-12", til: "2026-10-18" }, per)).data).toEqual({ levert: 1 });
    expect((await kall("POST", `/api/org/${org}/timer/godkjenn`, { ider: [sen.data.id] })).data).toEqual({ godkjent: 1 });
    const k = (await kall("POST", `/api/org/${org}/lonn/kjoringer`, { periode: "2026-11" })).data;
    nov = k.id;
    expect(k.utbetalingsdato).toBe("2026-11-20");
    expect(k.slipper.map((s: any) => s.navn)).toEqual(["Kari Fast", "Per Time", "Lise Tabell"]);
    expect(slipp(k, perId).linjer.map((l: any) => [l.lonnsart, l.antall, l.belop])).toEqual([["timelonn", 9, 2250]]);
    expect(slipp(k, perId).antall_timeforinger).toBe(1);
    const g = (await kall("POST", `/api/org/${org}/lonn/kjoringer/${nov}/godkjenn`)).data;
    const s = (await kall("GET", `/api/org/${org}/lonn/slipper/${slipp(g, kari).id}`)).data;
    expect(s.hittil).toMatchObject({ brutto: 100000, skattetrekk: 30000, otp: 2000 });
  });

  it("en ekstra kjøring med en bonus trekkes med prosentsatsen", async () => {
    const r = await kall("POST", `/api/org/${org}/lonn/kjoringer`, { periode: "2026-11", type: "ekstra", utbetalingsdato: "2026-11-27" });
    expect(r.status).toBe(201);
    expect(r.data.slipper).toEqual([]);
    const sti = `/api/org/${org}/lonn/kjoringer/${r.data.id}`;
    // Godkjenning uten slipper går ikke.
    expect((await kall("POST", `${sti}/godkjenn`)).data.error).toBe("Lønnskjøringen har ingen lønnsslipper");
    const k = (await kall("POST", `${sti}/linjer`, { ansatt_id: lise, lonnsart: "bonus", belop: 10000 })).data;
    expect(slipp(k, lise)).toMatchObject({ brutto: 10000, skattetrekk: 3100, trekkmetode: "Prosenttrekk 31 % (tabellkort, ekstra kjøring)" });
    expect((await kall("DELETE", sti)).status).toBe(204);
    expect((await kall("GET", sti)).status).toBe(404);
  });

  it("tall fra et tidligere lønnssystem kommer med i tallene hittil i år", async () => {
    expect((await kall("PUT", `/api/org/${org}/lonn/inngaende/${kari}/2026`, { trekkpliktig: 400000, forskuddstrekk: 120000, feriepengegrunnlag: 400000 })).status).toBe(204);
    expect((await kall("PUT", `/api/org/${org}/lonn/inngaende/${kari}/2026`, { trekkpliktig: 1 }, per)).status).toBe(403);
    expect((await kall("GET", `/api/org/${org}/lonn/inngaende/${kari}`)).data).toEqual([
      { aar: 2026, feriepengegrunnlag: 400000, feriepenger_utbetalt: 0, trekkpliktig: 400000, forskuddstrekk: 120000 },
    ]);
    expect((await kall("GET", `/api/org/${org}/lonn/inngaende/${kari}`, undefined, per)).data).toEqual([]);
    const k = (await kall("GET", `/api/org/${org}/lonn/kjoringer/${nov}`)).data;
    const s = (await kall("GET", `/api/org/${org}/lonn/slipper/${slipp(k, kari).id}`)).data;
    expect(s.hittil).toMatchObject({ brutto: 500000, trekkpliktig: 500000, skattetrekk: 150000, feriepengegrunnlag: 500000 });
  });

  it("halv skatt og sluttoppgjør med feriepengene i desember", async () => {
    expect((await kall("PATCH", `/api/org/${org}/ansatte/${lise}`, { ansatt_til: "2026-12-15" })).status).toBe(200);
    const k = (await kall("POST", `/api/org/${org}/lonn/kjoringer`, { periode: "2026-12" })).data;
    expect(k).toMatchObject({ utbetalingsdato: "2026-12-18", halv_skatt: true });
    expect(slipp(k, kari)).toMatchObject({ skattetrekk: 15000, trekkmetode: "Prosenttrekk 30 %" });
    const l = slipp(k, lise);
    expect(linje(l, "fastlonn")).toMatchObject({ tekst: "Fastlønn (11 av 23 arbeidsdager)", belop: 19130.43 });
    // Sluttoppgjøret: 12 % av 40 000 + 40 000 + 19 130,43.
    expect(linje(l, "feriepenger")).toMatchObject({ tekst: "Feriepenger opptjent 2026 (sluttoppgjør)", antall: 99130.43, belop: 11895.65, opptjeningsaar: 2026 });
    expect(l.trekkmetode).toBe("Tabell 7100 (halv skatt)");
    expect(l.merknader).toContain("Slutter 15.12.2026: feriepengene er tatt med (sluttoppgjør).");
    expect((await kall("DELETE", `/api/org/${org}/lonn/kjoringer/${k.id}`)).status).toBe(204);
    expect((await kall("PATCH", `/api/org/${org}/ansatte/${lise}`, { ansatt_til: null })).status).toBe(200);
  });

  it("feriepengene utbetales i juni året etter, med trekk i lønn for ferie", async () => {
    const k = (await kall("POST", `/api/org/${org}/lonn/kjoringer`, { periode: "2027-06" })).data;
    expect(k).toMatchObject({ utbetalingsdato: "2027-06-18", feriepenger: true, trekktabeller: { aar: 2027, lastet: false } });
    const s = slipp(k, kari);
    // 12 % av oktober og november (100 000) og det tidligere lønnssystemet (400 000).
    expect(linje(s, "feriepenger")).toMatchObject({ tekst: "Feriepenger opptjent 2026", antall: 500000, sats: 12, belop: 60000, opptjeningsaar: 2026 });
    expect(linje(s, "ferietrekk")).toMatchObject({ antall: 25, belop: -57692.31 });
    expect(s.merknader).toContain("Skattekortet er for 2026, ikke 2027. Hent det nye skattekortet.");
    expect(linje(slipp(k, perId), "feriepenger")).toMatchObject({ antall: 14850, belop: 1782 }); // 12 600 i oktober og 2 250 i november
    const l = slipp(k, lise);
    expect(l.merknader).toContain("Det trekkes ikke skatt av feriepengene (tabelltrekk).");
    expect(l.merknader.some((m: string) => m.startsWith("Trekktabellene for 2027 er ikke lastet inn ennå"))).toBe(true);
    expect((await kall("DELETE", `/api/org/${org}/lonn/kjoringer/${k.id}`)).status).toBe(204);
  });

  it("ansatte med lønnsslipper kan ikke slettes", async () => {
    expect((await kall("DELETE", `/api/org/${org}/ansatte/${kari}`)).data.error).toBe(
      "Den ansatte har lønnsslipper (som skal oppbevares) og kan ikke slettes. Sett en sluttdato i stedet.",
    );
  });

  it("uten funksjonen «Lønn» er lønnen stengt", async () => {
    expect((await kall("GET", `/api/org/${org}/lonn/lonnsarter`)).data.some((l: any) => l.kode === "bonus")).toBe(true);
    expect((await kall("PUT", `/api/admin/organisasjoner/${org}/funksjoner`, { lonn: false }, admin)).status).toBe(200);
    expect((await kall("GET", `/api/org/${org}/lonn/kjoringer`)).data.error).toBe("Lønn er ikke slått på for organisasjonen");
    expect((await kall("GET", `/api/org/${org}/lonn/mine`, undefined, per)).status).toBe(403);
    expect((await kall("PUT", `/api/admin/organisasjoner/${org}/funksjoner`, { lonn: true }, admin)).status).toBe(200);
    expect((await kall("GET", `/api/org/${org}/lonn/kjoringer`)).status).toBe(200);
  });
});
