// Åpent i helgene (0064_helg.sql): eier og administrator slår helgen av og på under Ansatte og
// timer, alle i organisasjonen ser det (/api/meg), og AI-assistenten legger perioder («hele neste
// uke») på mandag–fredag når det er stengt i helgene.
import { beforeAll, describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { lagApi } from "../src/api.js";
import { settAi } from "../src/ai.js";
import { settLokalOppgavekjorer } from "../src/tjenester.js";
import { helligdag } from "../src/helligdager.js";
import { uke } from "../src/arbeidstid.js";
import { iDag } from "../src/regler.js";

const pluss = (iso: string, n: number) => new Date(Date.parse(`${iso}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

describe.skipIf(!process.env.DATABASE_URL)("åpent i helgene", () => {
  const app = lagApi();
  const eier = "Bearer test:uid-helg-api-eier:helg-eier@server.test:mfa";
  const ola = "Bearer test:uid-helg-api-ola:ola.helg@server.test";
  let org: string;
  let neste: Record<string, unknown> = {};
  const tekster: string[] = [];
  // En uke fram i tid uten helligdager.
  let man = uke(pluss(iDag(), 7)).fra;

  const kall = async (m: string, sti: string, k?: unknown, hvem = eier) => {
    const r = await app.request(sti, { method: m, headers: { authorization: hvem, "content-type": "application/json" }, body: k === undefined ? undefined : JSON.stringify(k) });
    return { status: r.status, data: (r.headers.get("content-type") ?? "").includes("json") ? ((await r.json()) as any) : null };
  };
  const spor = async (k: Record<string, unknown>) => {
    neste = k;
    const r = await kall("POST", `/api/org/${org}/ai/assistent`, { tekst: "kommando" });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    return r.data;
  };
  const helgIMeg = async (hvem: string) => (await kall("GET", "/api/meg", undefined, hvem)).data.organisasjoner.find((o: any) => o.id === org).helg;

  beforeAll(async () => {
    while ([0, 1, 2, 3, 4, 5, 6].some((i) => helligdag(pluss(man, i)))) man = pluss(man, 7);
    Object.assign(config, { aiProsjekt: "hi4-test", aiRegion: "europe-west3", aiModell: "gemini-3.5-flash", aiGrense: 1000 });
    settLokalOppgavekjorer(async () => undefined);
    settAi({
      token: async () => "test",
      fetch: async (_url, init) => {
        const kropp = JSON.parse(String(init?.body));
        tekster.push(kropp.contents[0].parts.map((p: any) => p.text ?? "").join("\n"));
        return new Response(
          JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(neste) }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 900, candidatesTokenCount: 40 } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });
    org = (await kall("POST", "/api/organisasjoner", { navn: "Helg Test AS" })).data.id;
    expect((await kall("PUT", `/api/org/${org}/lonn-oppsett`, { aktiv: true })).status).toBe(200);
    const a = (await kall("POST", `/api/org/${org}/ansatte`, { fornavn: "Ola", etternavn: "Helg", epost: "ola.helg@server.test", ansatt_fra: pluss(iDag(), -30) })).data;
    const inv = await kall("POST", `/api/org/${org}/ansatte/${a.id}/inviter`);
    expect((await kall("POST", "/api/invitasjoner/aksepter", { token: inv.data.lenke.split("/").pop() }, ola)).status).toBe(200);
  });

  it("standard er åpent, og eieren kan stenge i helgene", async () => {
    expect((await kall("GET", `/api/org/${org}/lonn-oppsett`)).data.helg).toBe(true);
    expect(await helgIMeg(eier)).toBe(true);
    expect(await helgIMeg(ola)).toBe(true);
    // Den ansatte kan ikke endre det.
    expect((await kall("PUT", `/api/org/${org}/lonn-oppsett`, { helg: false }, ola)).status).toBe(403);

    const r = await kall("PUT", `/api/org/${org}/lonn-oppsett`, { helg: false });
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ aktiv: true, helg: false });
    expect(await helgIMeg(eier)).toBe(false);
    expect(await helgIMeg(ola)).toBe(false);
    // Andre innstillinger endrer ikke helgen.
    expect((await kall("PUT", `/api/org/${org}/lonn-oppsett`, { vaktbytte: "fritt" })).data).toMatchObject({ helg: false, vaktbytte: "fritt" });
  });

  it("AI-assistenten legger en uke på mandag–fredag når det er stengt i helgene", async () => {
    const uka = await spor({ handling: "ny_vakt", ansatt: "A1", fra_dato: man, til_dato: pluss(man, 6), klokke_fra: "8", klokke_til: "16" });
    expect(uka.forslag.map((f: any) => f.dato)).toEqual([0, 1, 2, 3, 4].map((i) => pluss(man, i)));
    expect(tekster.at(-1)).toContain("Stengt i helgene");
    // Lørdagen når brukeren sier den.
    const lordag = await spor({ handling: "ny_vakt", ansatt: "A1", datoer: [pluss(man, 5)], klokke_fra: "10", klokke_til: "14" });
    expect(lordag.forslag.map((f: any) => f.dato)).toEqual([pluss(man, 5)]);
    // Hvem som jobber i helgen: ingen, og det er stengt.
    expect((await spor({ handling: "hvem_jobber", fra_dato: pluss(man, 5), til_dato: pluss(man, 6) })).tekst).toBe("Dere har stengt i helgene, og ingen er satt opp da.");

    // Åpent igjen: hele uka.
    expect((await kall("PUT", `/api/org/${org}/lonn-oppsett`, { helg: true })).data.helg).toBe(true);
    const hele = await spor({ handling: "ny_vakt", ansatt: "A1", fra_dato: man, til_dato: pluss(man, 6), klokke_fra: "8", klokke_til: "16" });
    expect(hele.forslag).toHaveLength(7);
    expect(tekster.at(-1)).not.toContain("Stengt i helgene");
  });
});
