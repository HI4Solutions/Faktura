// Lønnsslipper lest med AI (falske svar fra Gemini): fila går til modellen som den er, svaret
// gjøres om til rader for importen av ansatte, fødselsnummer og kontonummer som ikke stemmer,
// tas ut og sies fra om, og bare eier og administrator kan bruke det. Bruken telles i taket.
import { beforeAll, describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { lagApi } from "../src/api.js";
import { alle, somSystem } from "../src/db.js";
import { settAi } from "../src/ai.js";
import { funksjonerFor } from "../src/funksjoner.js";
import { settLokalOppgavekjorer } from "../src/tjenester.js";

const ansatt = (a: Record<string, unknown>) => ({
  fornavn: null, etternavn: null, adresse: null, postnr: null, poststed: null, fnr: null, fodselsdato: null, kontonr: null, ansattnummer: null,
  stilling: null, stillingsprosent: null, ansatt_fra: null, lonnstype: null, maanedslonn: null, timelonn: null, tillegg: [], annet: [], ...a,
});

describe.skipIf(!process.env.DATABASE_URL)("Lønnsslipper lest med AI", () => {
  const app = lagApi();
  const eier = "Bearer test:uid-slipp-eier:slipp-eier@server.test:mfa";
  const regnskap = "Bearer test:uid-slipp-regn:slipp-regn@server.test:mfa";
  let org: string;
  const foresporsler: any[] = [];
  let neste: unknown = { ansatte: [], merknader: [] };

  const kall = async (m: string, sti: string, k?: unknown, hvem = eier) => {
    const r = await app.request(sti, { method: m, headers: { authorization: hvem, "content-type": "application/json" }, body: k === undefined ? undefined : JSON.stringify(k) });
    return { status: r.status, data: (r.headers.get("content-type") ?? "").includes("json") ? ((await r.json()) as any) : null };
  };
  const pdf = new Uint8Array(3000).map((_, i) => (i < 8 ? "%PDF-1.4".charCodeAt(i) : i % 251));
  const send = async (body: Uint8Array, type = "application/pdf", hvem = eier) => {
    const r = await app.request(`/api/org/${org}/ai/lonnsslipp`, { method: "POST", headers: { authorization: hvem, "content-type": type }, body });
    return { status: r.status, data: (await r.json()) as any };
  };

  beforeAll(async () => {
    Object.assign(config, { aiProsjekt: "hi4-test", aiRegion: "europe-west3", aiModell: "gemini-3.5-flash", aiGrense: 1000 });
    settLokalOppgavekjorer(async () => undefined);
    settAi({
      token: async () => "test",
      fetch: async (_url, init) => {
        const kropp = JSON.parse(String(init?.body));
        foresporsler.push(kropp);
        return new Response(
          JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(neste) }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 1800, candidatesTokenCount: 300 } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });
    org = (await kall("POST", "/api/organisasjoner", { navn: "Lønnsslipp AS" })).data.id;
    expect((await kall("PUT", `/api/org/${org}/lonn-oppsett`, { aktiv: true })).status).toBe(200);
    const inv = await kall("POST", `/api/org/${org}/invitasjoner`, { epost: "slipp-regn@server.test", rolle: "regnskap" });
    expect((await kall("POST", "/api/invitasjoner/aksepter", { token: inv.data.lenke.split("/").pop() }, regnskap)).status).toBe(200);
  });

  it("sender fila til modellen og gjør svaret om til rader for importen", async () => {
    neste = {
      ansatte: [
        ansatt({
          fornavn: "Nina",
          etternavn: "Berg",
          adresse: "Storgata 5",
          postnr: "155",
          poststed: "Oslo",
          fnr: "150385 10190",
          kontonr: "8601.11.17947",
          ansattnummer: "17",
          stilling: "Butikkmedarbeider",
          stillingsprosent: 80,
          ansatt_fra: "2024-08-01",
          maanedslonn: 45000,
          tillegg: [
            { navn: "Funksjonstillegg", belop: 1500, per: "maaned" },
            { navn: "funksjonstillegg", belop: 1500, per: "maaned" },
            { navn: "Overtid", belop: 0, per: "time" },
          ],
          annet: ["Skattetrekk: tabell 7100.", "Feriepenger 12 %."],
        }),
        ansatt({ fornavn: "Ola", etternavn: "Feil", fnr: "15038510191", fodselsdato: "1985-03-15", kontonr: "12345678901", lonnstype: "time", timelonn: 210.5, ansatt_fra: "1. mai" }),
        ansatt({ fornavn: "", etternavn: null, stilling: "Uten navn" }),
      ],
      merknader: ["Den andre slippen var utydelig."],
    };
    const r = await send(pdf);
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data).toEqual({
      ansatte: [
        {
          fornavn: "Nina",
          etternavn: "Berg",
          adresse: "Storgata 5",
          postnr: "0155",
          poststed: "Oslo",
          fnr: "15038510190",
          kontonr: "86011117947",
          stilling: "Butikkmedarbeider",
          stillingsprosent: 80,
          ansatt_fra: "2024-08-01",
          maanedslonn: 45000,
          lonnstype: "maaned",
          tillegg: [{ navn: "Funksjonstillegg", belop: 1500, per: "maaned" }],
          notat: "Ansattnr. i tidligere system: 17\nFra lønnsslippen: Skattetrekk: tabell 7100. Feriepenger 12 %.",
        },
        { fornavn: "Ola", etternavn: "Feil", fodselsdato: "1985-03-15", timelonn: 210.5, lonnstype: "time" },
      ],
      merknader: [
        "Den andre slippen var utydelig.",
        "Fødselsnummeret til Ola Feil stemmer ikke (kontrollsifrene), og er ikke tatt med.",
        "Kontonummeret til Ola Feil stemmer ikke (kontrollsifrene), og er ikke tatt med.",
      ],
    });
    const f = foresporsler.at(-1)!;
    expect(f.systemInstruction.parts[0].text).toContain("Du leser lønnsslipper");
    expect(f.generationConfig.responseSchema.propertyOrdering).toEqual(["ansatte", "merknader"]);
    expect(f.contents[0].parts.find((p: any) => p.inlineData).inlineData).toEqual({ mimeType: "application/pdf", data: Buffer.from(pdf).toString("base64") });

    // Radene går rett inn i importen.
    const plan = await kall("POST", `/api/org/${org}/ansatte/importer`, { rader: r.data.ansatte, proving: true });
    expect(plan.data.antall).toEqual({ ny: 2, oppdater: 0, hopp: 0, feil: 0 });
  });

  it("bilder går også, og fila må være en PDF eller et bilde med noe i", async () => {
    neste = { ansatte: [ansatt({ fornavn: "Kari", etternavn: "Hansen" })], merknader: [] };
    expect((await send(pdf, "image/jpeg")).data).toEqual({ ansatte: [{ fornavn: "Kari", etternavn: "Hansen" }], merknader: [] });
    expect(foresporsler.at(-1)!.contents[0].parts.find((p: any) => p.inlineData).inlineData.mimeType).toBe("image/jpeg");
    expect((await send(pdf, "text/plain")).data.error).toBe("Lønnsslippen må være en PDF eller et bilde (JPG, PNG, WebP eller HEIC).");
    expect((await send(new Uint8Array(50))).data.error).toBe("Fila er tom.");
    neste = { ansatte: [ansatt({ stilling: "Bare stilling" })], merknader: [] };
    expect(await send(pdf)).toEqual({
      status: 422,
      data: { error: "Fant ingen lønnsslipp med navn på den ansatte i fila. Prøv en tydeligere fil, eller legg inn den ansatte selv." },
    });
    neste = { ansatte: [], merknader: ["Fila er ikke en lønnsslipp."] };
    expect((await send(pdf)).data.error).toBe("Fila er ikke en lønnsslipp.");
  });

  it("bare eier og administrator, og bruken telles i taket for måneden", async () => {
    const n = foresporsler.length;
    expect((await send(pdf, "application/pdf", regnskap)).status).toBe(403);
    expect(foresporsler.length).toBe(n);
    expect(funksjonerFor("/ai/lonnsslipp").sort()).toEqual(["ai", "ansatte"]);
    const bruk = await somSystem((db) => alle<{ funksjon: string; antall: number }>(db, "select funksjon, antall from faktura.ai_bruk where org_id = $1", [org]));
    expect(bruk).toEqual([{ funksjon: "lonnsslipp", antall: foresporsler.length }]);
  });
});
