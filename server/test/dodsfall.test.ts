// Dødsfall, konkurs og lønnsgaranti (Lønn K5, 0099_dodsfall.sql, ansatte.ts, lonn.ts,
// lonnsberegning.ts, amelding.ts, lonnsgaranti.ts): dødsdatoen avslutter arbeidsforholdet (sluttdato
// og sluttårsak), lønn som utbetales etter dødsfallet går til dødsboet uten forskuddstrekk og
// arbeidsgiveravgift («lønn etter dødsfall» i a-meldingen), feriepengene tas med i oppgjøret (også i
// kjøringen etter dødsmåneden), og rapporten «Lønnskrav ved konkurs» med 2 G-grensen.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { lagApi } from "../src/api.js";
import { somSystem } from "../src/db.js";
import { byggLeveranse, hentGrunnlag, kontroller, tilXml } from "../src/amelding.js";
import { settLokalOppgavekjorer } from "../src/tjenester.js";

const her = path.dirname(fileURLToPath(import.meta.url));
const harXmllint = spawnSync("xmllint", ["--version"]).status === 0;
function valider(xml: string) {
  const fil = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "amelding-")), "melding.xml");
  fs.writeFileSync(fil, xml);
  execFileSync("xmllint", ["--noout", "--schema", path.join(her, "xsd", "amelding_v2_3.xsd"), fil], { stdio: "pipe" });
}

describe.skipIf(!process.env.DATABASE_URL)("dødsfall og lønnsgaranti", () => {
  const app = lagApi();
  const eier = "Bearer test:uid-dod-eier:dod-eier@server.test:mfa";
  let org: string;
  let dag: string;
  let eva: string;
  let liv: string;
  let fred: string;

  const kall = async (m: string, sti: string, k?: unknown) => {
    const r = await app.request(sti, { method: m, headers: { authorization: eier, "content-type": "application/json" }, body: k === undefined ? undefined : JSON.stringify(k) });
    return { status: r.status, data: (r.headers.get("content-type") ?? "").includes("json") ? ((await r.json()) as any) : await r.text() };
  };
  const slipp = (k: any, ansatt: string) => k.slipper.find((s: any) => s.ansatt_id === ansatt);
  const linjer = (s: any) => s.linjer.filter((l: any) => !l.fjernet).map((l: any) => [l.lonnsart, l.belop]);
  const kjor = async (periode: string) => {
    const k = await kall("POST", `/api/org/${org}/lonn/kjoringer`, { periode });
    expect(k.status, JSON.stringify(k.data)).toBe(201);
    return k.data;
  };
  const godkjenn = async (k: any) => {
    const g = await kall("POST", `/api/org/${org}/lonn/kjoringer/${k.id}/godkjenn`);
    expect(g.status, JSON.stringify(g.data)).toBe(200);
  };

  beforeAll(async () => {
    settLokalOppgavekjorer(async () => undefined);
    org = (await kall("POST", "/api/organisasjoner", { navn: "Dødsfall Test AS" })).data.id;
    expect((await kall("PUT", `/api/org/${org}/lonn-oppsett`, { aktiv: true, otp_prosent: 0 })).status).toBe(200);
    const ny = async (k: Record<string, unknown>) => {
      const r = await kall("POST", `/api/org/${org}/ansatte`, {
        lonnstype: "maaned",
        skattekort: "prosent",
        skatt_prosent: 30,
        skattekort_aar: 2026,
        yrkeskode: "5223101",
        ansatt_fra: "2024-01-01",
        fodselsdato: "1970-02-02",
        kontonr: "86011117947",
        ...k,
      });
      expect(r.status, JSON.stringify(r.data)).toBe(201);
      return r.data.id as string;
    };
    dag = await ny({ fornavn: "Dag", etternavn: "Død", maanedslonn: 40000 });
    eva = await ny({ fornavn: "Eva", etternavn: "Etter", maanedslonn: 30000 });
    liv = await ny({ fornavn: "Liv", etternavn: "Krav", maanedslonn: 150000 });
    fred = await ny({ fornavn: "Fred", etternavn: "Frilans", maanedslonn: 10000, arbeidsforhold_type: "frilanserOppdragstakerHonorarPersonerMm" });
    // August og september er utbetalt før dødsfallene.
    for (const periode of ["2026-08", "2026-09"]) await godkjenn(await kjor(periode));
  });

  it("dødsdatoen avslutter arbeidsforholdet: sluttdatoen og sluttårsaken settes", async () => {
    expect((await kall("PATCH", `/api/org/${org}/ansatte/${dag}`, { dodsdato: "2099-01-01" })).data.error).toBe("Dødsdatoen kan ikke være fram i tid");
    const r = await kall("PATCH", `/api/org/${org}/ansatte/${dag}`, { dodsdato: "2026-10-05" });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data).toMatchObject({ dodsdato: "2026-10-05", ansatt_til: "2026-10-05", aarsak_sluttdato: "arbeidstakerHarSagtOppSelv" });
    // Sluttdatoen kan ikke være en annen enn dødsdatoen.
    const feil = await kall("PATCH", `/api/org/${org}/ansatte/${dag}`, { ansatt_til: "2026-10-31" });
    expect(feil.status).toBe(400);
    expect(feil.data.error).toBe("Sluttdatoen er dødsdatoen når den ansatte er død");
    // Registrert ved en feil: dødsdatoen kan fjernes (og settes igjen).
    expect((await kall("PATCH", `/api/org/${org}/ansatte/${dag}`, { dodsdato: null, ansatt_til: null, aarsak_sluttdato: null })).data).toMatchObject({ dodsdato: null, ansatt_til: null });
    expect((await kall("PATCH", `/api/org/${org}/ansatte/${dag}`, { dodsdato: "2026-10-05" })).data).toMatchObject({ dodsdato: "2026-10-05", ansatt_til: "2026-10-05" });
    // Eva døde etter at septemberlønnen var utbetalt.
    expect((await kall("PATCH", `/api/org/${org}/ansatte/${eva}`, { dodsdato: "2026-09-25" })).status).toBe(200);
  });

  it("lønnskjøringen: lønn og feriepenger til dødsboet uten forskuddstrekk og arbeidsgiveravgift", async () => {
    const k = await kjor("2026-10");
    expect(k.utbetalingsdato).toBe("2026-10-20");
    // Dag: lønnen for 1.–5. oktober og feriepengene (oppgjøret til dødsboet).
    const d = slipp(k, dag);
    const lonn = d.linjer.find((l: any) => l.lonnsart === "fastlonn" && !l.fjernet).belop;
    expect(lonn).toBeGreaterThan(0);
    expect(lonn).toBeLessThan(40000);
    const ferie = d.linjer.find((l: any) => l.lonnsart === "feriepenger" && !l.fjernet).belop;
    expect(ferie).toBeCloseTo(((80000 + lonn) * 12) / 100, 2);
    expect(d).toMatchObject({ etter_dodsfall: true, skattetrekk: 0, aga: 0, aga_grunnlag: 0, trekkmetode: "Ikke forskuddstrekk (lønn etter dødsfall)" });
    expect(d.netto).toBeCloseTo(lonn + ferie, 2);
    expect(d.merknader).toContain("Døde 05.10.2026: feriepengene er tatt med (oppgjøret til dødsboet).");
    expect(d.merknader).toContain(
      "Utbetalt etter dødsfallet 05.10.2026: lønn etter dødsfall til dødsboet, uten forskuddstrekk og arbeidsgiveravgift. Kontonummeret på den ansatte skal være dødsboets.",
    );
    // Eva døde i september: feriepengene som ikke er utbetalt, kommer i oktober (ingen lønn).
    const e = slipp(k, eva);
    expect(linjer(e)).toEqual([["feriepenger", 7200]]);
    expect(e).toMatchObject({ etter_dodsfall: true, skattetrekk: 0, aga: 0, netto: 7200 });
    expect(e.merknader).toContain("Døde 25.09.2026: feriepengene som ikke er utbetalt, er tatt med (til dødsboet).");
    // Liv: vanlig lønn med trekk og avgift.
    expect(slipp(k, liv)).toMatchObject({ etter_dodsfall: false, skattetrekk: 45000, aga_grunnlag: 150000 });
    await godkjenn(k);
    // November: ingenting igjen til dødsboene.
    const nov = await kjor("2026-11");
    expect(slipp(nov, dag)).toBeUndefined();
    expect(slipp(nov, eva)).toBeUndefined();
    expect(slipp(nov, liv)).toBeDefined();
  });

  it("a-meldingen: «lønn etter dødsfall» uten trekk og avgift, og sluttårsaken (skjemaet)", async () => {
    const a = await kall("GET", `/api/org/${org}/amelding/2026-10`);
    const d = a.data.grunnlag.mottakere.find((m: any) => m.ansatt_id === dag);
    expect(d.inntekter.every((i: any) => i.beskrivelse === "loennEtterDoedsfall" && !i.trekk && !i.aga)).toBe(true);
    const e = a.data.grunnlag.mottakere.find((m: any) => m.ansatt_id === eva);
    expect(e.inntekter).toEqual([expect.objectContaining({ beskrivelse: "loennEtterDoedsfall", belop: 7200, trekk: false, aga: false })]);
    // Ingen avvik om sluttårsaken for de døde.
    expect(a.data.avvik.filter((x: any) => [dag, eva].includes(x.ansatt_id) && x.tekst.includes("sluttdato"))).toEqual([]);
    // Leveransen (med organisasjonsnumre): skjemaet godtar den.
    const g = { ...(await somSystem((db) => hentGrunnlag(db, org, "2026-10"))), org: { navn: "Dødsfall Test AS", orgnr: "915000177" }, virksomhet: "915000185" };
    expect(kontroller(g).filter((x) => x.niva === "feil" && !x.tekst.includes("fødselsnummer"))).toEqual([]);
    const valg = { meldingsId: "d0d5fa11-0000-4000-8000-000000000001", tidspunkt: "2026-11-03T09:15:00Z", fnr: () => "13830197340" };
    const { leveranse } = byggLeveranse(g, valg) as any;
    const mottakere = leveranse.oppgave.virksomhet[0].inntektsmottaker;
    const forDag = mottakere.find((m: any) => m.arbeidsforhold[0].sluttdato === "2026-10-05");
    expect(forDag.arbeidsforhold[0].aarsakTilSluttdato).toBe("arbeidstakerHarSagtOppSelv");
    expect(forDag.inntekt.every((i: any) => i.loennsinntekt.beskrivelse === "loennEtterDoedsfall" && !i.utloeserArbeidsgiveravgift && !i.inngaarIGrunnlagForTrekk)).toBe(true);
    // Avgiften og trekket er bare for Liv og frilanseren (honoraret på 10 000 kr).
    expect(leveranse.oppgave.betalingsinformasjon).toEqual({
      sumArbeidsgiveravgift: 22560,
      sumForskuddstrekkPerLoennsutbetalingsdato: [{ loennsutbetalingsdato: "2026-10-20", beloep: 48000 }],
    });
    if (harXmllint) valider(tilXml(byggLeveranse(g, valg)));
  });

  it("rapporten «Lønnskrav ved konkurs»: lønnen i perioden, feriepengene og 2 G-grensen", async () => {
    const r = await kall("GET", `/api/org/${org}/rapportmodul/lonn.lonnsgaranti?fra=2026-08-01&til=2026-10-10`);
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data.kolonner.map((k: any) => k.navn)).toEqual(["Nr", "Ansatt", "Stilling", "Lønn", "Lønn i perioden", "Feriepenger 2025", "Feriepenger 2026", "Sum krav", "Lønnsgarantien"]);
    // Liv: august og september (oktober utbetales etter fristdagen), og feriepengene opptjent i år.
    expect(r.data.rader.find((x: any) => x.navn === "Liv Krav")).toMatchObject({
      lonnsats: "150 000 kr per måned",
      lonn: 300000,
      ferie_fjor: 0,
      ferie_aar: 36000,
      sum: 336000,
      grense: "Over 2 G: dekkes med 273 098 kr",
    });
    // Frilansere er ikke med.
    expect(r.data.rader.some((x: any) => x.navn === "Fred Frilans")).toBe(false);
    expect(r.data.merknad).toContain("Fristdagen er 10.10.2026");
    // Med en kortere periode er kravet innenfor 2 G.
    const sept = await kall("GET", `/api/org/${org}/rapportmodul/lonn.lonnsgaranti?fra=2026-09-01&til=2026-10-10`);
    expect(sept.data.rader.find((x: any) => x.navn === "Liv Krav")).toMatchObject({ lonn: 150000, ferie_aar: 36000, sum: 186000, grense: "Innenfor 2 G" });
    expect(fred).toBeTruthy();
  });
});
