// AFP og OU (0098, lonnsberegning.ts, lonn.ts, afpPremier.ts, amelding.ts, avstemming.ts): premien
// avsettes måned for måned (2,7 % av lønnen mellom 1 og 7,1 G i året, 13–61 år), OU-premien per
// heltidsansatt, lønnsbilaget fører avsetningen, betalingen av fakturaen fra Fellesordningen gir
// arbeidsgiveravgiften i a-meldingen for måneden den er betalt, og påminnelsen når den mangler.
// Sluttvederlaget er med i AFP-grunnlaget, men ikke i feriepengene.
import { beforeAll, describe, expect, it } from "vitest";
import { lagApi } from "../src/api.js";
import { settLokalOppgavekjorer } from "../src/tjenester.js";

describe.skipIf(!process.env.DATABASE_URL)("AFP og OU", () => {
  const app = lagApi();
  const eier = "Bearer test:uid-afp-eier:afp-eier@server.test:mfa";
  let org: string;
  let anne: string;
  let petter: string;
  let gamle: string;
  let frida: string;

  const kall = async (m: string, sti: string, k?: unknown) => {
    const r = await app.request(sti, { method: m, headers: { authorization: eier, "content-type": "application/json" }, body: k === undefined ? undefined : JSON.stringify(k) });
    return { status: r.status, data: (r.headers.get("content-type") ?? "").includes("json") ? ((await r.json()) as any) : await r.text() };
  };
  const slipp = (k: any, ansatt: string) => k.slipper.find((s: any) => s.ansatt_id === ansatt);
  const kjor = async (periode: string, foer?: (k: any) => Promise<void>) => {
    let k = (await kall("POST", `/api/org/${org}/lonn/kjoringer`, { periode })).data;
    if (foer) {
      await foer(k);
      k = (await kall("POST", `/api/org/${org}/lonn/kjoringer/${k.id}/beregn`)).data;
    }
    const g = await kall("POST", `/api/org/${org}/lonn/kjoringer/${k.id}/godkjenn`);
    expect(g.status, JSON.stringify(g.data)).toBe(200);
    return k;
  };
  const afpAvvik = async (maaned: string) =>
    ((await kall("GET", `/api/org/${org}/amelding/${maaned}`)).data.avvik as { tekst: string }[]).map((a) => a.tekst).filter((t) => t.includes("AFP"));

  beforeAll(async () => {
    settLokalOppgavekjorer(async () => undefined);
    org = (await kall("POST", "/api/organisasjoner", { navn: "AFP Test AS" })).data.id;
    const o = await kall("PUT", `/api/org/${org}/lonn-oppsett`, { aktiv: true, otp_prosent: 2, afp: true, afp_sats: 2.7, ou_premie: 46 });
    expect(o.data).toMatchObject({ afp: true, afp_sats: 2.7, ou_premie: 46 });
    expect((await kall("PUT", `/api/org/${org}/lonn/bokforing`, { afp: true })).data.afp).toBe(true);
    const ny = async (k: Record<string, unknown>) => {
      const r = await kall("POST", `/api/org/${org}/ansatte`, {
        lonnstype: "maaned",
        skattekort: "prosent",
        skatt_prosent: 20,
        skattekort_aar: 2026,
        yrkeskode: "5223101",
        ansatt_fra: "2020-01-01",
        kontonr: "86011117947",
        ...k,
      });
      expect(r.status, JSON.stringify(r.data)).toBe(201);
      return r.data.id as string;
    };
    anne = await ny({ fornavn: "Anne", etternavn: "Afp", fodselsdato: "1980-04-01", maanedslonn: 50000 });
    petter = await ny({ fornavn: "Petter", etternavn: "Deltid", fodselsdato: "1990-01-01", maanedslonn: 20000, stillingsprosent: 50 });
    // Fyller 63 år i 2026: ikke med i AFP-grunnlaget (13–61 år), men OU-premien gjelder.
    gamle = await ny({ fornavn: "Gunnar", etternavn: "Gamle", fodselsdato: "1963-06-01", maanedslonn: 40000 });
    frida = await ny({ fornavn: "Frida", etternavn: "Frilans", fodselsdato: "1985-01-01", maanedslonn: 10000, arbeidsforhold_type: "frilanserOppdragstakerHonorarPersonerMm" });
  });

  it("avsetter AFP-premien av lønnen over 1 G i året, og OU-premien per heltidsansatt", async () => {
    const jan = await kjor("2026-01");
    expect(slipp(jan, anne)).toMatchObject({ afp_grunnlag: 50000, afp: 0, ou: 46, aga_grunnlag: 51000 });
    expect(slipp(jan, petter)).toMatchObject({ afp_grunnlag: 20000, afp: 0, ou: 23 });
    expect(slipp(jan, gamle)).toMatchObject({ afp_grunnlag: 0, afp: 0, ou: 46 });
    expect(slipp(jan, frida)).toMatchObject({ afp_grunnlag: 0, afp: 0, ou: 0 });
    expect(jan.sum).toMatchObject({ afp: 0, ou: 115 });
    await kjor("2026-02");
    // Mars: Anne har 150 000 i år, 15 580,67 over gjennomsnittlig G (134 419,33). Petter får et
    // sluttvederlag på 100 000 (med i grunnlaget, ikke i feriepengene): 160 000 i år.
    const mars = await kjor("2026-03", async (k) => {
      const l = await kall("POST", `/api/org/${org}/lonn/kjoringer/${k.id}/linjer`, { ansatt_id: petter, lonnsart: "sluttvederlag", tekst: "Sluttvederlag", belop: 100000 });
      expect(l.status, JSON.stringify(l.data)).toBe(200);
    });
    expect(slipp(mars, anne)).toMatchObject({ afp_grunnlag: 50000, afp: 420.68, ou: 46, aga_grunnlag: 51000 });
    expect(slipp(mars, petter)).toMatchObject({ afp_grunnlag: 120000, afp: 690.68, feriepengegrunnlag: 20000 });
    expect(mars.sum).toMatchObject({ afp: 1111.36, ou: 115 });
    // Lønnsbilaget fører avsetningen: kostnad mot påløpt premie.
    const b = (await kall("GET", `/api/org/${org}/lonn/kjoringer/${mars.id}/bokforing`)).data.gjeldende.posteringer as { konto: string; belop: number }[];
    expect(b.filter((p) => ["5942", "5941", "2989"].includes(p.konto)).map((p) => [p.konto, p.belop])).toEqual([
      ["5942", 1111.36],
      ["5941", 115],
      ["2989", -1226.36],
    ]);
    // Sluttvederlaget i a-meldingen.
    const a = (await kall("GET", `/api/org/${org}/amelding/2026-03`)).data.grunnlag;
    const p = a.mottakere.find((m: any) => m.ansatt_id === petter);
    expect(p.inntekter.find((i: any) => i.beskrivelse === "sluttvederlag")).toMatchObject({ belop: 100000, trekk: true, aga: true });
  });

  it("oversikten per kvartal, og påminnelsen om betalingen i a-meldingen", async () => {
    const o = (await kall("GET", `/api/org/${org}/lonn/afp?aar=2026`)).data;
    expect(o.oppsett).toMatchObject({ afp: true, afp_sats: 2.7, ou_premie: 46, bokforing_afp: true });
    expect(o.kvartaler[0]).toMatchObject({ kvartal: 1, navn: "1. kvartal 2026", ansatte: 3, grunnlag: 310000, afp: 1111.36, ou: 345, betalt: { afp: 0, ou: 0, aga: 0, antall: 0 } });
    expect(o.kvartaler[1]).toMatchObject({ kvartal: 2, afp: 0, ou: 0 });
    // April er første måned i kvartalet (fakturaen er ikke kommet); i mai og juni minner a-meldingen om den.
    expect(await afpAvvik("2026-04")).toEqual([]);
    expect(await afpAvvik("2026-05")).toEqual([
      "AFP-premien for 1. kvartal 2026 (avsatt 1 456,36 kr) er ikke registrert som betalt. Registrer betalingen under Lønn → AFP når fakturaen fra Fellesordningen er betalt, så kommer arbeidsgiveravgiften av premien med i a-meldingen for den måneden.",
    ]);
  });

  it("betalingen gir bilaget og arbeidsgiveravgiften i a-meldingen for måneden den er betalt", async () => {
    const feil = await kall("POST", `/api/org/${org}/lonn/afp`, { dato: "2026-05-10", aar: 2026, kvartal: 1, afp: 0, ou: 0 });
    expect(feil.data.error).toBe("Skriv beløpet som er betalt");
    const r = await kall("POST", `/api/org/${org}/lonn/afp`, { dato: "2026-05-10", aar: 2026, kvartal: 1, afp: 1111.36, ou: 345 });
    expect(r.status, JSON.stringify(r.data)).toBe(201);
    expect(r.data).toMatchObject({ dato: "2026-05-10", aar: 2026, kvartal: 1, afp: 1111.36, ou: 345, aga_sats: 14.1, aga: 156.7 });
    expect(r.data.bilag).toMatch(/^L-2026-\d+$/);
    // Bilaget: den påløpte premien mot banken, og avgiften mot skyldig arbeidsgiveravgift.
    const bilag = (await kall("GET", `/api/org/${org}/rapportmodul/lonn.bokforing?fra=2026-05-01&til=2026-05-31`)).data.rader as any[];
    expect(bilag.map((x) => [x.konto, x.debet, x.kredit])).toEqual([
      ["2989", 1456.36, null],
      ["1920", null, 1456.36],
      ["5400", 156.7, null],
      ["2770", null, 156.7],
    ]);
    expect(bilag[0].bilagstekst).toBe("AFP- og OU-premie 1. kvartal 2026 (Fellesordningen)");
    // A-meldingen for mai: AFP-premien som pensjonspremie med avgift, og ingen påminnelse.
    const mai = (await kall("GET", `/api/org/${org}/amelding/2026-05`)).data;
    expect(mai.avvik.filter((a: any) => a.tekst.includes("AFP"))).toEqual([]);
    expect(mai.grunnlag.afp_premie).toBe(1111.36);
    expect(mai.grunnlag.avgiftsgrunnlag).toEqual([{ sone: "1", sats: 14.1, lonn: 0, pensjon: 1111.36 }]);
    expect(mai.grunnlag.arbeidsgiveravgift).toBe(157);
    // Avstemmingen for 3. termin: avgiften i bilaget stemmer med det a-meldingen gir.
    const t = (await kall("GET", `/api/org/${org}/rapportmodul/lonn.avstemming?aar=2026&termin=3`)).data.rader as any[];
    expect(t[0]).toMatchObject({ maaned: expect.stringMatching(/^Mai/), aga_lonn: 156.7, aga_bokfort: 156.7 });
    expect(t[0].avvik).toBe("A-meldingen er ikke levert.");
    // Oversikten viser betalingen.
    const o = (await kall("GET", `/api/org/${org}/lonn/afp?aar=2026`)).data;
    expect(o.kvartaler[0].betalt).toEqual({ afp: 1111.36, ou: 345, aga: 156.7, antall: 1 });
    expect(o.betalinger).toHaveLength(1);
  });

  it("rapporten «AFP og OU»", async () => {
    const r = await kall("GET", `/api/org/${org}/rapportmodul/lonn.afp?fra=2026-01-01&til=2026-06-30`);
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data.rader.map((x: any) => [x.navn, x.grunnlag, x.afp, x.ou])).toEqual([
      ["Anne Afp", 150000, 420.68, 138],
      ["Petter Deltid", 160000, 690.68, 69],
      ["Gunnar Gamle", 0, 0, 138],
    ]);
    expect(r.data.merknad).toContain("Betalt til Fellesordningen i perioden: 10.05.2026 for 1. kvartal 2026 1 456,36 kr (arbeidsgiveravgift 156,70 kr).");
  });

  it("en betaling som slettes, reverseres, og påminnelsen kommer tilbake", async () => {
    const o = (await kall("GET", `/api/org/${org}/lonn/afp?aar=2026`)).data;
    expect((await kall("DELETE", `/api/org/${org}/lonn/afp/${o.betalinger[0].id}`)).status).toBe(204);
    expect((await kall("DELETE", `/api/org/${org}/lonn/afp/${o.betalinger[0].id}`)).status).toBe(404);
    const bilag = (await kall("GET", `/api/org/${org}/rapportmodul/lonn.bokforing?fra=2026-05-01&til=2026-12-31`)).data.rader as any[];
    expect(bilag.filter((x) => x.konto === "2770").map((x) => [x.debet, x.kredit])).toEqual([
      [null, 156.7],
      [156.7, null],
    ]);
    expect(await afpAvvik("2026-06")).toHaveLength(1);
    const mai = (await kall("GET", `/api/org/${org}/amelding/2026-05`)).data.grunnlag;
    expect(mai.arbeidsgiveravgift).toBe(0);
  });

  it("kontoene for honorar, styrehonorar og AFP kan endres", async () => {
    const r = await kall("PUT", `/api/org/${org}/lonn/bokforing`, { kontoer: { honorar: "5391", styrehonorar: "5331", afp: "5943", ou: "5944", paalopt_afp: "2961" } });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    const k = Object.fromEntries((r.data.kontoer as { rolle: string; konto: string }[]).map((x) => [x.rolle, x.konto]));
    expect(k).toMatchObject({ honorar: "5391", styrehonorar: "5331", afp: "5943", ou: "5944", paalopt_afp: "2961" });
  });
});
