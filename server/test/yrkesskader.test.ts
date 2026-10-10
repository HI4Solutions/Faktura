// Yrkesskader (Lønn K8, 0102_yrkesskader.sql, yrkesskader.ts): yrkesskadeforsikringen, registeret
// over personskadene (arbeidsmiljøloven § 5-1) med det som gjenstår å melde (NAV, forsikringen, og
// Arbeidstilsynet og politiet ved alvorlig skade, § 5-2), tilgangen (bare eier og administrator),
// at den ansatte ikke kan slettes med skader i registeret, og rapporten «Skaderegister».
import { beforeAll, describe, expect, it } from "vitest";
import { lagApi } from "../src/api.js";
import { oppgaver } from "../src/yrkesskader.js";
import { settLokalOppgavekjorer } from "../src/tjenester.js";

describe("det som gjenstår å melde (uten database)", () => {
  const ingen = { meldt_nav: null, meldt_forsikring: null, meldt_arbeidstilsynet: null, meldt_politi: null };
  it("vanlig skade: NAV og forsikringen; alvorlig skade: også Arbeidstilsynet og politiet først", () => {
    expect(oppgaver({ ...ingen, alvorlig: false }, { selskap: "Tryg", polise: "123" })).toEqual([
      "Send skademelding til NAV så snart som mulig (nav.no/arbeidsgiver/meldyrkesskade), også om dere er i tvil om det er en yrkesskade.",
      "Meld skaden til yrkesskadeforsikringen (Tryg, polise 123).",
    ]);
    const alvorlig = oppgaver({ ...ingen, alvorlig: true }, { selskap: null, polise: null });
    expect(alvorlig).toHaveLength(4);
    expect(alvorlig[0]).toMatch(/^Varsle Arbeidstilsynet straks/);
    expect(alvorlig[1]).toMatch(/^Varsle politiet straks/);
    expect(alvorlig[3]).toBe("Meld skaden til yrkesskadeforsikringen (legg inn selskapet og polisenummeret i registeret).");
    expect(oppgaver({ alvorlig: true, meldt_nav: "2026-10-02", meldt_forsikring: "2026-10-02", meldt_arbeidstilsynet: "2026-10-01", meldt_politi: "2026-10-01" }, { selskap: null, polise: null })).toEqual(
      [],
    );
  });
});

describe.skipIf(!process.env.DATABASE_URL)("yrkesskader i appen", () => {
  const app = lagApi();
  const eier = "Bearer test:uid-ysk-eier:ysk-eier@server.test:mfa";
  const regnskap = "Bearer test:uid-ysk-regn:ysk-regn@server.test:mfa";
  let org: string;
  let ola: string;
  let skade: string;

  const kall = async (m: string, sti: string, k?: unknown, hvem = eier) => {
    const r = await app.request(sti, { method: m, headers: { authorization: hvem, "content-type": "application/json" }, body: k === undefined ? undefined : JSON.stringify(k) });
    return { status: r.status, data: r.status === 204 ? null : (r.headers.get("content-type") ?? "").includes("json") ? ((await r.json()) as any) : await r.text() };
  };

  beforeAll(async () => {
    settLokalOppgavekjorer(async () => undefined);
    org = (await kall("POST", "/api/organisasjoner", { navn: "Yrkesskade Test AS" })).data.id;
    expect((await kall("PUT", `/api/org/${org}/lonn-oppsett`, { aktiv: true })).status).toBe(200);
    ola = (await kall("POST", `/api/org/${org}/ansatte`, { fornavn: "Ola", etternavn: "Skadet", ansatt_fra: "2024-01-01" })).data.id;
    const inv = await kall("POST", `/api/org/${org}/invitasjoner`, { epost: "ysk-regn@server.test", rolle: "regnskap" });
    expect((await kall("POST", "/api/invitasjoner/aksepter", { token: inv.data.lenke.split("/").pop() }, regnskap)).status).toBe(200);
  });

  it("forsikringen og en arbeidsulykke: det som gjenstår å melde", async () => {
    expect((await kall("PUT", `/api/org/${org}/yrkesskader/forsikring`, { selskap: "Tryg Forsikring", polise: "YS-12345" })).data).toEqual({ selskap: "Tryg Forsikring", polise: "YS-12345" });
    expect((await kall("POST", `/api/org/${org}/yrkesskader`, { ansatt_id: ola, dato: "2026-10-05" })).data.error).toBeTruthy();
    expect((await kall("POST", `/api/org/${org}/yrkesskader`, { ansatt_id: ola, dato: "2099-01-01", beskrivelse: "x" })).data.error).toBe("Datoen for skaden kan ikke være fram i tid");
    const r = await kall("POST", `/api/org/${org}/yrkesskader`, {
      ansatt_id: ola,
      dato: "2026-10-05",
      klokkeslett: "13:20",
      sted: "Lageret",
      beskrivelse: "Falt fra gardintrapp ved påfylling av hyller.",
      skade: "Brudd i håndledd",
      alvorlig: true,
      fravaer: true,
    });
    expect(r.status, JSON.stringify(r.data)).toBe(201);
    skade = r.data.id;
    expect(r.data).toMatchObject({ navn: "Ola Skadet", type: "ulykke", klokkeslett: "13:20", alvorlig: true, fravaer: true, meldt_nav: null });
    expect(r.data.oppgaver).toHaveLength(4);
    expect(r.data.oppgaver[3]).toBe("Meld skaden til yrkesskadeforsikringen (Tryg Forsikring, polise YS-12345).");
    // Varslet og meldt: det som er gjort, forsvinner fra listen.
    const p = await kall("PATCH", `/api/org/${org}/yrkesskader/${skade}`, { meldt_arbeidstilsynet: "2026-10-05", meldt_politi: "2026-10-05", meldt_nav: "2026-10-06" });
    expect(p.status, JSON.stringify(p.data)).toBe(200);
    expect(p.data.oppgaver).toEqual(["Meld skaden til yrkesskadeforsikringen (Tryg Forsikring, polise YS-12345)."]);
    expect(p.data).toMatchObject({ alvorlig: true, fravaer: true, sted: "Lageret" });
    const l = (await kall("GET", `/api/org/${org}/yrkesskader`)).data;
    expect(l.forsikring).toEqual({ selskap: "Tryg Forsikring", polise: "YS-12345" });
    expect(l.skader.map((s: any) => [s.navn, s.dato, s.oppgaver.length])).toEqual([["Ola Skadet", "2026-10-05", 1]]);
  });

  it("tilgangen: bare eier og administrator (helseopplysninger)", async () => {
    expect((await kall("GET", `/api/org/${org}/yrkesskader`, undefined, regnskap)).status).toBe(403);
    expect((await kall("GET", `/api/org/${org}/rapportmodul/personal.yrkesskader?aar=2026`, undefined, regnskap)).status).toBe(403);
  });

  it("den ansatte kan ikke slettes med skader i registeret, og rapporten", async () => {
    expect((await kall("DELETE", `/api/org/${org}/ansatte/${ola}`)).data.error).toBe(
      "Den ansatte har yrkesskader i registeret (som skal oppbevares) og kan ikke slettes. Sett en sluttdato i stedet.",
    );
    const r = await kall("GET", `/api/org/${org}/rapportmodul/personal.yrkesskader?aar=2026`);
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data.rader).toEqual([
      {
        dato: "2026-10-05",
        navn: "Ola Skadet",
        type: "Arbeidsulykke",
        sted: "Lageret",
        beskrivelse: "Falt fra gardintrapp ved påfylling av hyller.",
        skade: "Brudd i håndledd",
        alvorlig: "Ja",
        fravaer: "Ja",
        tiltak: "",
        meldt_nav: "2026-10-06",
        meldt_forsikring: null,
        meldt_arbeidstilsynet: "2026-10-05",
      },
    ]);
    expect(r.data.merknad).toContain("Tryg Forsikring, polise YS-12345");
    expect((await kall("DELETE", `/api/org/${org}/yrkesskader/${skade}`)).status).toBe(204);
  });
});
