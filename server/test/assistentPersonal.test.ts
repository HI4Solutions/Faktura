// AI-assistenten for personalmodulen (falske svar fra Gemini): hva hver bruker får (eier med
// fakturaer og personal, den ansatte bare personal, regnskap bare spørsmål), fravær med vikar,
// vakter, publisering, tavla og rullering, timer, godkjenning, ferie og spørsmål. Forslagene
// utføres med de vanlige rutene, som i appen.
import { beforeAll, describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { lagApi } from "../src/api.js";
import { en, somSystem } from "../src/db.js";
import { settAi } from "../src/ai.js";
import { settLokalOppgavekjorer } from "../src/tjenester.js";
import { helligdag } from "../src/helligdager.js";
import { uke } from "../src/arbeidstid.js";

const iDag = () => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Oslo" }).format(new Date());
const pluss = (d: string, n: number) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

describe.skipIf(!process.env.DATABASE_URL)("AI-assistenten for personal", () => {
  const app = lagApi();
  const eier = "Bearer test:uid-pa-eier:pa-eier@server.test:mfa";
  const regnskap = "Bearer test:uid-pa-regn:pa-regn@server.test:mfa";
  const ola = "Bearer test:uid-pa-ola:ola.pa@server.test";
  let org: string;
  const id: Record<string, string> = {};
  const foresporsler: { kropp: any; tekst: string; system: string }[] = [];
  let neste: Record<string, unknown> = {};
  let tale = { tale: true, tekst: "" };
  // En tirsdag neste uke (eller senere) uten helligdag.
  let dag = pluss(uke(pluss(iDag(), 7)).fra, 1);
  const igaar = pluss(iDag(), -1);

  const kall = async (m: string, sti: string, k?: unknown, hvem = eier) => {
    const r = await app.request(sti, { method: m, headers: { authorization: hvem, "content-type": "application/json" }, body: k === undefined ? undefined : JSON.stringify(k) });
    return { status: r.status, data: (r.headers.get("content-type") ?? "").includes("json") ? ((await r.json()) as any) : null };
  };
  const spor = async (k: Record<string, unknown>, hvem = eier, tekst = "kommando") => {
    neste = k;
    const r = await kall("POST", `/api/org/${org}/ai/assistent`, { tekst }, hvem);
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    return r.data;
  };

  beforeAll(async () => {
    while (helligdag(dag) || helligdag(pluss(dag, 1))) dag = pluss(dag, 7);
    Object.assign(config, { aiProsjekt: "hi4-test", aiRegion: "europe-west3", aiModell: "gemini-3.5-flash", aiGrense: 1000 });
    settLokalOppgavekjorer(async () => undefined);
    settAi({
      token: async () => "test",
      fetch: async (_url, init) => {
        const kropp = JSON.parse(String(init?.body));
        const system = String(kropp.systemInstruction.parts[0].text);
        foresporsler.push({ kropp, system, tekst: kropp.contents[0].parts.map((p: any) => p.text ?? "").join("\n") });
        const svar = system.startsWith("Du skriver ned tale") ? tale : neste;
        return new Response(
          JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(svar) }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 900, candidatesTokenCount: 40 } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });
    org = (await kall("POST", "/api/organisasjoner", { navn: "Personal Assistent AS" })).data.id;
    expect((await kall("PUT", `/api/org/${org}/lonn-oppsett`, { aktiv: true })).status).toBe(200);
    for (const [k, fornavn, etternavn, epost] of [
      ["ola", "Ola", "Nordmann", "ola.pa@server.test"],
      ["kari", "Kari", "Berg", null],
      ["per", "Per", "Olsen", null],
    ] as const)
      id[k] = (await kall("POST", `/api/org/${org}/ansatte`, { fornavn, etternavn, epost, ansatt_fra: "2025-01-01" })).data.id;
    const inv = await kall("POST", `/api/org/${org}/ansatte/${id.ola}/inviter`);
    expect((await kall("POST", "/api/invitasjoner/aksepter", { token: inv.data.lenke.split("/").pop() }, ola)).status).toBe(200);
    const r = await kall("POST", `/api/org/${org}/invitasjoner`, { epost: "pa-regn@server.test", rolle: "regnskap" });
    expect((await kall("POST", "/api/invitasjoner/aksepter", { token: r.data.lenke.split("/").pop() }, regnskap)).status).toBe(200);
    // Tavla, og en vakt for Kari og en (publisert) for Ola i går.
    id.formiddag = (await kall("POST", `/api/org/${org}/tavle/faser`, { navn: "Formiddag", fra: "08:00", til: "12:00" })).data.id;
    id.ettermiddag = (await kall("POST", `/api/org/${org}/tavle/faser`, { navn: "Ettermiddag", fra: "12:00", til: "16:00" })).data.id;
    id.kasse = (await kall("POST", `/api/org/${org}/tavle/oppgaver`, { navn: "Kasse", behov: 1 })).data.id;
    id.lager = (await kall("POST", `/api/org/${org}/tavle/oppgaver`, { navn: "Lager", behov: 1 })).data.id;
    id.kariVakt = (await kall("POST", `/api/org/${org}/vakter`, { ansatt_id: id.kari, dato: dag, fra: "08:00", til: "16:00", pause_min: 30 })).data.id;
    expect((await kall("POST", `/api/org/${org}/vakter/publiser`, { fra: dag, til: dag })).status).toBe(200);
    expect((await kall("POST", `/api/org/${org}/vakter`, { ansatt_id: id.ola, dato: igaar, fra: "08:00", til: "15:30", pause_min: 30 })).status).toBe(201);
    expect((await kall("POST", `/api/org/${org}/vakter/publiser`, { fra: igaar, til: igaar })).status).toBe(200);
  });

  it("hver bruker får det den har tilgang til", async () => {
    expect((await kall("GET", `/api/org/${org}/ai/assistent/status`)).data).toEqual({
      tilgjengelig: true,
      faktura: true,
      personal: { leder: true, se: true, ansatt: false, vaktplan: true, tavle: true },
    });
    expect((await kall("GET", `/api/org/${org}/ai/assistent/status`, undefined, ola)).data).toEqual({
      tilgjengelig: true,
      faktura: false,
      personal: { leder: false, se: false, ansatt: true, vaktplan: true, tavle: false },
    });
    expect((await kall("GET", `/api/org/${org}/ai/assistent/status`, undefined, regnskap)).data.personal).toEqual({ leder: false, se: true, ansatt: false, vaktplan: true, tavle: true });

    // Eieren: fakturaer og personal, med alle de ansatte og tavla.
    await spor({ handling: "annet", svar: "Hei" });
    let f = foresporsler.at(-1)!;
    expect(f.kropp.generationConfig.responseSchema.properties.handling.enum).toEqual(expect.arrayContaining(["sjekk_betaling", "fravaer", "rullering", "vis", "annet"]));
    expect(f.tekst).toContain("A1: Kari Berg\nA2: Ola Nordmann\nA3: Per Olsen");
    expect(f.tekst).toContain("O1: Kasse");
    expect(f.system).toContain("- fravaer: registrere fravær");
    // Den ansatte: bare personal, bare seg selv, ingen kunder.
    await spor({ handling: "annet", svar: "Hei" }, ola);
    f = foresporsler.at(-1)!;
    expect(f.kropp.generationConfig.responseSchema.properties.handling.enum).not.toContain("sjekk_betaling");
    expect(f.kropp.generationConfig.responseSchema.properties).not.toHaveProperty("kunde");
    expect(f.tekst).toContain("A1: Ola Nordmann (deg)");
    expect(f.tekst).not.toContain("Kari");
    expect(f.tekst).not.toContain("K1:");
    expect(f.system).not.toContain("ny_faktura");
  });

  it("fravær med vikar: forslaget utføres med de vanlige rutene", async () => {
    const svar = await spor({ handling: "fravaer", ansatt: "A1", fravaerstype: "syk", fra_dato: dag, vikar: "Per" });
    expect(svar.tekst).toContain("Kari Berg har 1 vakt i perioden");
    expect(svar.tekst).toContain("Per Olsen settes inn som vikar.");
    expect(svar.forslag).toEqual([
      expect.objectContaining({ type: "fravaer", ansatt_id: id.kari, fravaerstype: "syk", fra: dag, til: dag, vikar_id: id.per, faste: [], knapp: "Registrer fravær" }),
    ]);
    // Appen: fraværet, så vikar for vaktene som kommer tilbake.
    const fr = await kall("POST", `/api/org/${org}/fravaer`, { ansatt_id: id.kari, type: "syk", fra: dag, til: dag });
    expect(fr.data.vakter.map((v: any) => v.id)).toEqual([id.kariVakt]);
    expect((await kall("POST", `/api/org/${org}/vakter/${id.kariVakt}/vikar`, { ansatt_id: id.per })).status).toBe(201);
    // Spørsmålet om dagen viser det.
    const hvem = await spor({ handling: "hvem_jobber", fra_dato: dag }, regnskap);
    expect(hvem.tekst).toContain("er 1 på jobb: Per Olsen 08:00–16:00");
    expect(hvem.tekst).toContain("Borte: Kari Berg (fravær)"); // regnskap ser ikke typen
  });

  it("den ansatte melder seg syk, men registrerer ikke ferie eller fravær for andre", async () => {
    const syk = await spor({ handling: "fravaer", ansatt: "A1", fravaerstype: "syk" }, ola);
    expect(syk.forslag).toEqual([expect.objectContaining({ type: "fravaer", ansatt_id: null, fravaerstype: "syk", fra: iDag(), til: iDag(), knapp: "Meld fravær" })]);
    expect((await spor({ handling: "fravaer", fravaerstype: "ferie" }, ola)).tekst).toBe(
      "Selv kan du melde sykdom og sykt barn. Ferie, permisjon og annet fravær registrerer lederen din.",
    );
    expect((await spor({ handling: "fravaer", ansatt: "Kari", fravaerstype: "syk" }, ola)).tekst).toBe("Du har ikke tilgang til å registrere fravær for andre.");
    expect((await spor({ handling: "publiser_vakter" }, ola)).tekst).toBe("Du har ikke tilgang til å publisere vaktplanen.");
    expect((await spor({ handling: "vis", side: "tavle" }, ola)).tekst).toBe("Du har ikke tilgang til tavla.");
    expect(await spor({ handling: "vis", side: "mine_vakter" }, ola)).toMatchObject({ tekst: "Åpner vaktene dine.", gaa_til: "/vakter?fane=mine" });
  });

  it("vakter, publisering, tavla og rullering", async () => {
    const nye = await spor({ handling: "ny_vakt", ansatt: "Ola Nordmann", datoer: [dag, pluss(dag, 1)], klokke_fra: "9", klokke_til: "17:00", pause_min: 30, oppgave: "O2" });
    expect(nye.forslag).toHaveLength(2);
    expect(nye.forslag[0]).toMatchObject({ type: "ny_vakt", ansatt_id: id.ola, dato: dag, fra: "09:00", til: "17:00", pause_min: 30, oppgave: "Lager" });
    expect(nye.forslag[0].tekst).toContain(": 7,5 t.");
    for (const v of nye.forslag) expect((await kall("POST", `/api/org/${org}/vakter`, { ansatt_id: v.ansatt_id, dato: v.dato, fra: v.fra, til: v.til, pause_min: v.pause_min, oppgave: v.oppgave })).status).toBe(201);
    expect((await spor({ handling: "ny_vakt", ansatt: "Ola" })).tekst).toBe("Hvilket klokkeslett? Si for eksempel «08–16».");

    const pub = await spor({ handling: "publiser_vakter" });
    expect(pub.forslag).toEqual([expect.objectContaining({ type: "publiser", fra: uke(dag).fra, til: uke(dag).til, knapp: "Publiser" })]);
    expect(pub.forslag[0].tekst).toContain("Publiser 2 vakter");
    expect((await kall("POST", `/api/org/${org}/vakter/publiser`, { fra: pub.forslag[0].fra, til: pub.forslag[0].til })).data.publisert).toBe(2);

    const pl = await spor({ handling: "plasser", ansatt: "A2", oppgave: "kasse", fase: "F1", datoer: [dag] });
    expect(pl.forslag).toEqual([
      expect.objectContaining({ type: "plassering", plasser: [{ dato: dag, fase_id: id.formiddag, oppgave_id: id.kasse, ansatt_id: id.ola }], knapp: "Plasser" }),
    ]);
    expect((await spor({ handling: "plasser", ansatt: "A2", oppgave: "Resepsjon", datoer: [dag] })).tekst).toBe("Fant ikke oppgaven «Resepsjon» på tavla. Oppgavene er Kasse og Lager.");

    const rull = await spor({ handling: "rullering", fra_dato: dag, til_dato: dag });
    expect(rull.tekst).toContain("Rulleringen fordeler 2 ansatte");
    expect(rull.forslag).toEqual([expect.objectContaining({ type: "rullering", fra: dag, til: dag, knapp: "Lagre rulleringen" })]);
    expect((await kall("POST", `/api/org/${org}/tavle/rullering`, { fra: dag, til: dag, lagre: true })).data.lagret).toBe(true);
  });

  it("timer: føre, levere og godkjenne", async () => {
    const t = await spor({ handling: "for_timer", ansatt: "A1", timer: 7.5, notat: "Varetelling" }, ola);
    expect(t.forslag).toEqual([expect.objectContaining({ type: "timer", ansatt_id: null, dato: iDag(), timer: 7.5, fra: null, beskrivelse: "Varetelling", knapp: "Før timene" })]);
    // Uten tid: fra vakten i går.
    const v = await spor({ handling: "for_timer", datoer: [igaar] }, ola);
    expect(v.forslag[0]).toMatchObject({ dato: igaar, fra: "08:00", til: "15:30", pause_min: 30, timer: null });
    expect(v.forslag[0].tekst).toContain("7 t i går (08:00–15:30, 30 min pause) fra vakten");
    expect((await spor({ handling: "for_timer", datoer: [pluss(iDag(), 2)], timer: 4 }, ola)).tekst).toBe("Timer kan bare føres for dager som har vært (eller i dag).");
    const f = v.forslag[0];
    expect((await kall("POST", `/api/org/${org}/timer`, { dato: f.dato, fra: f.fra, til: f.til, pause_min: f.pause_min, vakt_id: f.vakt_id }, ola)).status).toBe(201);

    const lever = await spor({ handling: "lever_timer", fra_dato: uke(igaar).fra, til_dato: uke(igaar).til }, ola);
    expect(lever.forslag).toEqual([expect.objectContaining({ type: "lever_timer", ansatt_id: null, fra: uke(igaar).fra, til: uke(igaar).til })]);
    expect(lever.forslag[0].tekst).toContain("Lever 1 føring (7 t)");
    expect((await kall("POST", `/api/org/${org}/timer/lever`, { fra: uke(igaar).fra, til: uke(igaar).til }, ola)).data.levert).toBe(1);

    const godkjenn = await spor({ handling: "godkjenn_timer", ansatt: "Ola" });
    expect(godkjenn.forslag).toEqual([expect.objectContaining({ type: "godkjenn_timer", godkjent: true, knapp: "Godkjenn" })]);
    expect((await kall("POST", `/api/org/${org}/timer/godkjenn`, { ider: godkjenn.forslag[0].ider })).data.godkjent).toBe(1);
    expect((await spor({ handling: "godkjenn_timer" }, ola)).tekst).toBe("Du har ikke tilgang til å godkjenne timer.");
    const mine = await spor({ handling: "timer", ansatt: "A1", fra_dato: uke(igaar).fra, til_dato: uke(igaar).til }, ola);
    expect(mine.tekst).toContain("Du har ført 7 t");
    expect(mine.tekst).toContain("7 t godkjent");
  });

  it("ferie og vaktene den ansatte selv har", async () => {
    const ferie = await spor({ handling: "ferie", ansatt: "A1" }, ola);
    expect(ferie.tekst).toMatch(/^Du har [\d,]+ feriedager igjen i \d{4}/);
    expect((await spor({ handling: "ferie" }, regnskap)).tekst).toBe("Feriebanken ser bare eier, administrator og den ansatte selv.");
    const over = await spor({ handling: "overfor_ferie", dager: 3, notat: "Flytter i juli" }, ola);
    expect(over.forslag).toEqual([expect.objectContaining({ type: "overforing", ansatt_id: null, dager: 3, godkjent: false, knapp: "Send søknaden" })]);
    const vakter = await spor({ handling: "vakter", fra_dato: dag, til_dato: pluss(dag, 1) }, ola);
    expect(vakter.tekst).toContain("Du har 2 vakter");
    expect(vakter.tekst).toContain("09:00–17:00 (Lager)");
  });

  it("den ansatte kan snakke til assistenten, og bruken telles", async () => {
    const opptak = new Uint8Array(3000).map((_, i) => i % 199);
    tale = { tale: true, tekst: "Jeg er syk i dag" };
    const r = await app.request(`/api/org/${org}/ai/assistent/tale`, { method: "POST", headers: { authorization: ola, "content-type": "audio/webm" }, body: opptak });
    expect(await r.json()).toEqual({ tekst: "Jeg er syk i dag" });
    const bruk = await somSystem((db) => en<{ antall: number }>(db, "select antall from faktura.ai_bruk where org_id = $1 and funksjon = 'assistent'", [org]));
    expect(bruk!.antall).toBe(foresporsler.length);
  });
});
