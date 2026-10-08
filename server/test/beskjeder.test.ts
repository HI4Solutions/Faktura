// Beskjeder (0062_beskjeder.sql): alle kan skrive til rollene (eller alle), med push til dem det
// gjelder; uleste telles fra sist brukeren så beskjedene; bare den som skrev, og eier og
// administrator, kan slette.
import { beforeAll, describe, expect, it } from "vitest";
import { lagApi } from "../src/api.js";
import { iDag } from "../src/regler.js";
import { settLokalOppgavekjorer, type Oppgave } from "../src/tjenester.js";

const pluss = (iso: string, n: number) => new Date(Date.parse(`${iso}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

describe.skipIf(!process.env.DATABASE_URL)("beskjeder", () => {
  const app = lagApi();
  const eier = "Bearer test:uid-beskjed-api-eier:beskjed-eier@server.test:mfa";
  const hvem = {
    ola: "Bearer test:uid-beskjed-api-ola:ola.beskjed@server.test",
    lise: "Bearer test:uid-beskjed-api-lise:lise.beskjed@server.test",
    kari: "Bearer test:uid-beskjed-api-kari:kari.beskjed@server.test",
  };
  const ko: Oppgave[] = [];
  let org: string;
  const bruker: Record<string, string> = {};
  const kall = async (m: string, sti: string, k?: unknown, som = eier) => {
    const r = await app.request(sti, { method: m, headers: { authorization: som, "content-type": "application/json" }, body: k === undefined ? undefined : JSON.stringify(k) });
    return { status: r.status, data: (r.headers.get("content-type") ?? "").includes("json") ? ((await r.json()) as any) : null };
  };
  const varsler = () => ko.filter((o): o is Extract<Oppgave, { type: "varsel" }> => o.type === "varsel").map((o) => o.varsel);

  beforeAll(async () => {
    settLokalOppgavekjorer(async (o) => {
      ko.push(o);
    });
    org = (await kall("POST", "/api/organisasjoner", { navn: "Beskjeder Test AS" })).data.id;
    bruker.eier = (await kall("GET", "/api/meg")).data.bruker.id;
    await kall("PUT", `/api/org/${org}/lonn-oppsett`, { aktiv: true });
    for (const [navn, rolle] of [
      ["ola", "Sekretær"],
      ["lise", "Lege"],
      ["kari", "Lege"],
    ] as const) {
      const fornavn = navn[0]!.toUpperCase() + navn.slice(1);
      const a = (await kall("POST", `/api/org/${org}/ansatte`, { fornavn, etternavn: "Beskjed", epost: `${navn}.beskjed@server.test`, ansatt_fra: pluss(iDag(), -30), rolle })).data;
      const inv = (await kall("POST", `/api/org/${org}/ansatte/${a.id}/inviter`)).data;
      expect((await kall("POST", "/api/invitasjoner/aksepter", { token: inv.lenke.split("/").pop() }, hvem[navn])).status).toBe(200);
      bruker[navn] = (await kall("GET", "/api/meg", undefined, hvem[navn])).data.bruker.id;
    }
  });

  it("til en rolle med push: de med rollen får varsel, og uleste telles", async () => {
    const start = await kall("GET", `/api/org/${org}/beskjeder`, undefined, hvem.ola);
    expect(start.status).toBe(200);
    expect(start.data.roller.map((r: any) => r.navn).sort()).toEqual(["Lege", "Sekretær"]);
    const lege = start.data.roller.find((r: any) => r.navn === "Lege").id;
    expect((await kall("POST", `/api/org/${org}/beskjeder`, { tekst: "  " }, hvem.ola)).data.error).toBe("Skriv en beskjed");

    const for_ = varsler().length;
    const ny = await kall("POST", `/api/org/${org}/beskjeder`, { tekst: "Pasienten i rom 3 venter", roller: [lege], push: true }, hvem.ola);
    expect(ny.status).toBe(201);
    expect(ny.data).toMatchObject({ tekst: "Pasienten i rom 3 venter", roller: [lege], push: true, forfatter_navn: "Ola Beskjed", egen: true, kan_slette: true, ny: false });
    expect(varsler().slice(for_)).toEqual([
      expect.objectContaining({
        hendelse: "beskjed",
        org_id: org,
        bruker_ider: expect.arrayContaining([bruker.lise, bruker.kari]),
        tittel: "Beskjed fra Ola Beskjed",
        tekst: "Pasienten i rom 3 venter",
        url: "/beskjeder",
      }),
    ]);
    expect(varsler().at(-1)!.bruker_ider).toHaveLength(2);

    // Lise ser den og har én ulest; lest nullstiller. Ola har ingen (sin egen).
    expect((await kall("GET", `/api/org/${org}/beskjeder/uleste`, undefined, hvem.lise)).data.uleste).toBe(1);
    const lise = await kall("GET", `/api/org/${org}/beskjeder`, undefined, hvem.lise);
    expect(lise.data.beskjeder).toEqual([expect.objectContaining({ id: ny.data.id, egen: false, kan_slette: false, ny: true })]);
    expect((await kall("POST", `/api/org/${org}/beskjeder/lest`, {}, hvem.lise)).status).toBe(204);
    expect((await kall("GET", `/api/org/${org}/beskjeder/uleste`, undefined, hvem.lise)).data.uleste).toBe(0);
    expect((await kall("GET", `/api/org/${org}/beskjeder`, undefined, hvem.lise)).data.beskjeder[0].ny).toBe(false);
    expect((await kall("GET", `/api/org/${org}/beskjeder/uleste`, undefined, hvem.ola)).data.uleste).toBe(0);
    // Eieren ser alle.
    expect((await kall("GET", `/api/org/${org}/beskjeder`)).data.beskjeder.map((b: any) => b.id)).toContain(ny.data.id);
  });

  it("til alle uten push, og bare den som skrev (og eieren) kan slette", async () => {
    const for_ = varsler().length;
    const alle = await kall("POST", `/api/org/${org}/beskjeder`, { tekst: "Kaffemaskinen er fikset" }, hvem.lise);
    expect(alle.status).toBe(201);
    expect(varsler().length).toBe(for_);
    // Ola ser beskjeden til alle, og sin egen til legene (nyeste først).
    expect((await kall("GET", `/api/org/${org}/beskjeder`, undefined, hvem.ola)).data.beskjeder.map((b: any) => b.tekst)).toEqual(["Kaffemaskinen er fikset", "Pasienten i rom 3 venter"]);
    expect((await kall("DELETE", `/api/org/${org}/beskjeder/${alle.data.id}`, undefined, hvem.ola)).status).toBe(404);
    expect((await kall("DELETE", `/api/org/${org}/beskjeder/${alle.data.id}`, undefined, hvem.lise)).status).toBe(204);
    const til = await kall("POST", `/api/org/${org}/beskjeder`, { tekst: "Til alle, med push", push: true }, hvem.kari);
    expect(varsler().at(-1)).toMatchObject({ bruker_ider: expect.arrayContaining([bruker.eier, bruker.ola, bruker.lise]) });
    expect(varsler().at(-1)!.bruker_ider).not.toContain(bruker.kari);
    expect((await kall("DELETE", `/api/org/${org}/beskjeder/${til.data.id}`)).status).toBe(204);
  });
});
