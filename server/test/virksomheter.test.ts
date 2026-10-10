// Flere virksomheter og soner (Lønn K7, 0101_virksomheter.sql, virksomheter.ts, lonn.ts, amelding.ts,
// afpPremier.ts): virksomhetene (underenhetene) med sonen for arbeidsgiveravgift, den ansatte i én av
// dem, avgiften med sonen til virksomheten (fribeløpet i sone 1a per foretak), a-meldingen med én
// virksomhet per underenhet (skjemaet), og rapporten «Arbeidsgiveravgift per virksomhet og sone».
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { lagApi } from "../src/api.js";
import { somSystem } from "../src/db.js";
import { fribelopBrukt } from "../src/afpPremier.js";
import { byggLeveranse, hentGrunnlag, kontroller, tilXml } from "../src/amelding.js";
import { arbeidsgiveravgiftSoner } from "../src/lonnsberegning.js";
import { settLokalOppgavekjorer } from "../src/tjenester.js";

const her = path.dirname(fileURLToPath(import.meta.url));
const harXmllint = spawnSync("xmllint", ["--version"]).status === 0;
function valider(xml: string) {
  const fil = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "amelding-")), "melding.xml");
  fs.writeFileSync(fil, xml);
  execFileSync("xmllint", ["--noout", "--schema", path.join(her, "xsd", "amelding_v2_3.xsd"), fil], { stdio: "pipe" });
}

describe("arbeidsgiveravgiften per sone (uten database)", () => {
  it("fribeløpet i sone 1a gjelder for foretaket: alle virksomhetene i sone 1a, ikke de andre sonene", () => {
    const r = arbeidsgiveravgiftSoner(
      [
        { sone: "1a", grunnlag: 10_000_000 }, // sparer 350 000
        { sone: "3", grunnlag: 1_000_000 }, // 6,4 %, teller ikke
        { sone: "1a", grunnlag: 10_000_000 }, // sparer 350 000 (700 000 brukt)
        { sone: "1a", grunnlag: 10_000_000 }, // 150 000 igjen av fribeløpet
        { sone: "1", grunnlag: 100_000 },
      ],
      0,
    );
    expect(r.map((x) => x.aga)).toEqual([1_060_000, 64_000, 1_060_000, 1_260_000, 14_100]);
    expect(r.map((x) => x.sats)).toEqual([10.6, 6.4, 10.6, 12.6, 14.1]);
  });
});

describe.skipIf(!process.env.DATABASE_URL)("flere virksomheter og soner", () => {
  const app = lagApi();
  const eier = "Bearer test:uid-virk-eier:virk-eier@server.test:mfa";
  let org: string;
  let nord: string;
  let fjell: string;
  const ansatte: Record<string, string> = {};

  const kall = async (m: string, sti: string, k?: unknown) => {
    const r = await app.request(sti, { method: m, headers: { authorization: eier, "content-type": "application/json" }, body: k === undefined ? undefined : JSON.stringify(k) });
    return { status: r.status, data: r.status === 204 ? null : (r.headers.get("content-type") ?? "").includes("json") ? ((await r.json()) as any) : await r.text() };
  };

  beforeAll(async () => {
    settLokalOppgavekjorer(async () => undefined);
    org = (await kall("POST", "/api/organisasjoner", { navn: "Virksomheter Test AS" })).data.id;
    expect((await kall("PUT", `/api/org/${org}/lonn-oppsett`, { aktiv: true, otp_prosent: 0, aga_sone: "1", virksomhet_orgnr: "915000185" })).status).toBe(200);
  });

  it("virksomhetene: sonen, og organisasjonsnummeret sjekkes", async () => {
    const ny = (k: Record<string, unknown>) => kall("POST", `/api/org/${org}/lonn/virksomheter`, k);
    expect((await ny({ orgnr: "915000180", navn: "Feil", aga_sone: "1" })).data.error).toBe("Organisasjonsnummeret til virksomheten er ikke gyldig");
    expect((await ny({ orgnr: "915000185", navn: "Hoved", aga_sone: "1" })).data.error).toBe("Det er hovedvirksomheten (under A-melding i lønnsoppsettet).");
    const n = await ny({ orgnr: "915 000 118", navn: "Filial Nord", aga_sone: "1a" });
    expect(n.status, JSON.stringify(n.data)).toBe(201);
    expect(n.data).toMatchObject({ orgnr: "915000118", navn: "Filial Nord", aga_sone: "1a", ansatte: 0 });
    nord = n.data.id;
    expect((await ny({ orgnr: "915000118", navn: "Igjen", aga_sone: "2" })).status).toBe(409);
    fjell = (await ny({ orgnr: "915000126", navn: "Filial Fjell", aga_sone: "3" })).data.id;
    const l = (await kall("GET", `/api/org/${org}/lonn/virksomheter`)).data;
    expect(l.hoved).toMatchObject({ orgnr: "915000185", aga_sone: "1", navn: "Virksomheter Test AS" });
    expect(l.andre.map((v: any) => [v.navn, v.aga_sone])).toEqual([
      ["Filial Fjell", "3"],
      ["Filial Nord", "1a"],
    ]);
    expect((await kall("PATCH", `/api/org/${org}/lonn/virksomheter/${fjell}`, { navn: "Filial Fjellet" })).data.navn).toBe("Filial Fjellet");
  });

  it("lønnskjøringen: arbeidsgiveravgiften med sonen til virksomheten den ansatte jobber i", async () => {
    for (const [navn, virksomhet_id] of [
      ["Hanna", null],
      ["Nils", nord],
      ["Tora", fjell],
    ] as const) {
      const r = await kall("POST", `/api/org/${org}/ansatte`, {
        fornavn: navn,
        etternavn: "Sted",
        lonnstype: "maaned",
        maanedslonn: 50000,
        skattekort: "prosent",
        skatt_prosent: 30,
        skattekort_aar: 2026,
        yrkeskode: "3311101",
        ansatt_fra: "2025-01-01",
        fodselsdato: "1985-05-05",
        kontonr: "86011117947",
        virksomhet_id,
      });
      expect(r.status, JSON.stringify(r.data)).toBe(201);
      expect(r.data.virksomhet_id).toBe(virksomhet_id);
      ansatte[navn] = r.data.id;
    }
    expect((await kall("PATCH", `/api/org/${org}/ansatte/${ansatte.Hanna}`, { virksomhet_id: "00000000-0000-4000-8000-000000000000" })).data.error).toBe(
      "Fant ikke virksomheten",
    );
    const k = (await kall("POST", `/api/org/${org}/lonn/kjoringer`, { periode: "2026-10" })).data;
    const s = (navn: string) => k.slipper.find((x: any) => x.ansatt_id === ansatte[navn]);
    expect(s("Hanna")).toMatchObject({ aga: 7050, aga_sats: 14.1, virksomhet_orgnr: "915000185", aga_sone: "1" });
    expect(s("Nils")).toMatchObject({ aga: 5300, aga_sats: 10.6, virksomhet_orgnr: "915000118", aga_sone: "1a" });
    expect(s("Tora")).toMatchObject({ aga: 3200, aga_sats: 6.4, virksomhet_orgnr: "915000126", aga_sone: "3" });
    expect(k.aga_soner).toEqual(["1", "1a", "3"]);
    expect((await kall("POST", `/api/org/${org}/lonn/kjoringer/${k.id}/godkjenn`)).status).toBe(200);
    // Fribeløpet i sone 1a som er brukt: bare Nils (sone 3 teller ikke).
    expect(await somSystem((db) => fribelopBrukt(db, org, 2026))).toBeCloseTo(1750, 2);
  });

  it("a-meldingen: én virksomhet per underenhet med avgiften per sone (skjemaet)", async () => {
    const a = (await kall("GET", `/api/org/${org}/amelding/2026-10`)).data;
    expect(a.grunnlag.arbeidsgiveravgift).toBe(15550);
    expect(a.grunnlag.virksomheter.map((v: any) => [v.orgnr, v.sone, v.antall_arbeidsforhold, v.arbeidsgiveravgift])).toEqual([
      ["915000185", "1", 1, 7050],
      ["915000126", "3", 1, 3200],
      ["915000118", "1a", 1, 5300],
    ]);
    const g = { ...(await somSystem((db) => hentGrunnlag(db, org, "2026-10"))), org: { navn: "Virksomheter Test AS", orgnr: "915000177" } };
    expect(kontroller(g).filter((x) => x.niva === "feil" && !x.tekst.includes("fødselsnummer"))).toEqual([]);
    const valg = { meldingsId: "f1e2d3c4-0000-4000-8000-000000000007", tidspunkt: "2026-11-03T09:15:00Z", fnr: () => "13830197340" };
    const { leveranse } = byggLeveranse(g, valg) as any;
    const v = leveranse.oppgave.virksomhet;
    expect(v.map((x: any) => x.norskIdentifikator)).toEqual(["915000185", "915000126", "915000118"]);
    expect(v.map((x: any) => x.inntektsmottaker.length)).toEqual([1, 1, 1]);
    expect(v.map((x: any) => x.arbeidsgiveravgift.loennOgGodtgjoerelse)).toEqual([
      [{ beregningskodeForArbeidsgiveravgift: "generelleNaeringer", sone: "1", avgiftsgrunnlagBeloep: "50000.00", prosentsatsForAvgiftsberegning: "14.1" }],
      [{ beregningskodeForArbeidsgiveravgift: "generelleNaeringer", sone: "3", avgiftsgrunnlagBeloep: "50000.00", prosentsatsForAvgiftsberegning: "6.4" }],
      [{ beregningskodeForArbeidsgiveravgift: "generelleNaeringer", sone: "1a", avgiftsgrunnlagBeloep: "50000.00", prosentsatsForAvgiftsberegning: "10.6" }],
    ]);
    expect(leveranse.oppgave.betalingsinformasjon).toEqual({
      sumArbeidsgiveravgift: 15550,
      sumForskuddstrekkPerLoennsutbetalingsdato: [{ loennsutbetalingsdato: "2026-10-20", beloep: 45000 }],
    });
    if (harXmllint) valider(tilXml(byggLeveranse(g, valg)));
  });

  it("rapporten, og en virksomhet med ansatte slettes ikke", async () => {
    const r = await kall("GET", `/api/org/${org}/rapportmodul/lonn.aga_soner?aar=2026&termin=5`);
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data.rader).toEqual([
      { virksomhet: "Virksomheter Test AS", orgnr: "915000185", sone: "1", grunnlag: 50000, sats: 14.1, aga: 7050 },
      { virksomhet: "Filial Fjellet", orgnr: "915000126", sone: "3", grunnlag: 50000, sats: 6.4, aga: 3200 },
      { virksomhet: "Filial Nord", orgnr: "915000118", sone: "1a", grunnlag: 50000, sats: 10.6, aga: 5300 },
    ]);
    expect((await kall("DELETE", `/api/org/${org}/lonn/virksomheter/${fjell}`)).data.error).toBe(
      "Én ansatt jobber i virksomheten. Flytt dem til en annen virksomhet først.",
    );
    expect((await kall("PATCH", `/api/org/${org}/ansatte/${ansatte.Tora}`, { virksomhet_id: null })).data.virksomhet_id).toBeNull();
    expect((await kall("DELETE", `/api/org/${org}/lonn/virksomheter/${fjell}`)).status).toBe(204);
    // Slippen beholder virksomheten og sonen (a-meldingen for oktober er den samme).
    const a = (await kall("GET", `/api/org/${org}/amelding/2026-10`)).data;
    expect(a.grunnlag.arbeidsgiveravgift).toBe(15550);
  });
});
