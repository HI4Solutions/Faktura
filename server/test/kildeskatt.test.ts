// Kildeskatt på lønn (Lønn K6, 0100_kildeskatt.sql, lonnsberegning.ts, ansatte.ts, kildeskatt.ts):
// utenlandske arbeidstakere på kildeskatteordningen (PAYE) får trekket etter satsen på skattekortet
// av all lønn, merknad når lønnen i året er over grensen for ordningen, ordinært forskuddstrekk i
// a-meldingen, og rapporten «Kildeskatt på lønn».
import { beforeAll, describe, expect, it } from "vitest";
import { lagApi } from "../src/api.js";
import { somSystem } from "../src/db.js";
import { byggLeveranse, hentGrunnlag } from "../src/amelding.js";
import { settLokalOppgavekjorer } from "../src/tjenester.js";

describe.skipIf(!process.env.DATABASE_URL)("kildeskatt på lønn", () => {
  const app = lagApi();
  const eier = "Bearer test:uid-kpl-eier:kpl-eier@server.test:mfa";
  let org: string;
  let ana: string;
  let bo: string;

  const kall = async (m: string, sti: string, k?: unknown) => {
    const r = await app.request(sti, { method: m, headers: { authorization: eier, "content-type": "application/json" }, body: k === undefined ? undefined : JSON.stringify(k) });
    return { status: r.status, data: r.status === 204 ? null : (r.headers.get("content-type") ?? "").includes("json") ? ((await r.json()) as any) : await r.text() };
  };
  const slipp = (k: any, ansatt: string) => k.slipper.find((s: any) => s.ansatt_id === ansatt);

  beforeAll(async () => {
    settLokalOppgavekjorer(async () => undefined);
    org = (await kall("POST", "/api/organisasjoner", { navn: "Kildeskatt Test AS" })).data.id;
    expect((await kall("PUT", `/api/org/${org}/lonn-oppsett`, { aktiv: true, otp_prosent: 0 })).status).toBe(200);
    const ny = async (k: Record<string, unknown>) => {
      const r = await kall("POST", `/api/org/${org}/ansatte`, {
        lonnstype: "maaned",
        skattekort: "prosent",
        skattekort_aar: 2026,
        yrkeskode: "7212105",
        ansatt_fra: "2026-01-01",
        fodselsdato: "1988-03-03",
        kontonr: "86011117947",
        ...k,
      });
      expect(r.status, JSON.stringify(r.data)).toBe(201);
      return r.data;
    };
    const a = await ny({ fornavn: "Ana", etternavn: "Kildeskatt", maanedslonn: 65000, skatt_prosent: 25, kildeskatt: true });
    expect(a.kildeskatt).toBe(true);
    ana = a.id;
    bo = (await ny({ fornavn: "Bo", etternavn: "Vanlig", maanedslonn: 40000, skatt_prosent: 30 })).id;
    // Lønnen i år fra et tidligere lønnssystem (januar–september).
    expect((await kall("PUT", `/api/org/${org}/lonn/inngaende/${ana}/2026`, { trekkpliktig: 680000, forskuddstrekk: 170000 })).status).toBe(204);
  });

  it("lønnskjøringen: satsen av lønnen, og merknad når lønnen i året er over grensen", async () => {
    const k = (await kall("POST", `/api/org/${org}/lonn/kjoringer`, { periode: "2026-10" })).data;
    const s = slipp(k, ana);
    expect(s).toMatchObject({ trekkpliktig: 65000, skattetrekk: 16250, trekkmetode: "Kildeskatt på lønn 25 %" });
    expect(s.merknader).toContain(
      "Lønnen i år (745 000 kr) er over grensen for kildeskatt på lønn (725 050 kr i 2026): da gjelder ikke ordningen, og den ansatte skal skattlegges etter de vanlige reglene. Be den ansatte søke om nytt skattekort hos Skatteetaten.",
    );
    expect(slipp(k, bo)).toMatchObject({ skattetrekk: 12000, trekkmetode: "Prosenttrekk 30 %" });
    // Uten kildeskatt (vanlig prosenttrekk): ingen merknad om grensen.
    expect((await kall("PATCH", `/api/org/${org}/ansatte/${ana}`, { kildeskatt: false })).data.kildeskatt).toBe(false);
    const uten = slipp((await kall("POST", `/api/org/${org}/lonn/kjoringer/${k.id}/beregn`)).data, ana);
    expect(uten.trekkmetode).toBe("Prosenttrekk 25 %");
    expect(uten.merknader.some((m: string) => m.includes("kildeskatt"))).toBe(false);
    expect((await kall("PATCH", `/api/org/${org}/ansatte/${ana}`, { kildeskatt: true })).data.kildeskatt).toBe(true);
    const igjen = (await kall("POST", `/api/org/${org}/lonn/kjoringer/${k.id}/beregn`)).data;
    expect(slipp(igjen, ana).trekkmetode).toBe("Kildeskatt på lønn 25 %");
    expect((await kall("POST", `/api/org/${org}/lonn/kjoringer/${k.id}/godkjenn`)).status).toBe(200);
  });

  it("a-meldingen: ordinært forskuddstrekk med de vanlige beskrivelsene", async () => {
    const g = { ...(await somSystem((db) => hentGrunnlag(db, org, "2026-10"))), org: { navn: "Kildeskatt Test AS", orgnr: "915000177" }, virksomhet: "915000185" };
    const { leveranse } = byggLeveranse(g, { meldingsId: "c0de0000-0000-4000-8000-000000000006", tidspunkt: "2026-11-03T09:15:00Z", fnr: (id) => (id === ana ? "13830197340" : "24880199664") }) as any;
    const m = leveranse.oppgave.virksomhet[0].inntektsmottaker.find((x: any) => x.norskIdentifikator === "13830197340");
    // Forskuddstrekket er negativt i a-meldingen.
    expect(m.forskuddstrekk).toEqual([{ beskrivelse: "ordinaert", beloep: -16250 }]);
    expect(m.inntekt.map((i: any) => i.loennsinntekt.beskrivelse)).toEqual(["fastloenn"]);
  });

  it("rapporten «Kildeskatt på lønn»: satsen, lønnen og trekket i året, og grensen", async () => {
    const r = await kall("GET", `/api/org/${org}/rapportmodul/lonn.kildeskatt?aar=2026`);
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data.rader).toEqual([{ ansattnummer: "1", navn: "Ana Kildeskatt", sats: 25, lonn: 745000, skattetrekk: 186250, grense: "Over grensen: nytt skattekort" }]);
    expect(r.data.merknad).toContain("725 050 kr i 2026");
    expect(bo).toBeTruthy();
  });
});
