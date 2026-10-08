// Arbeidstiden i full stilling for organisasjonen (0048_full_stilling.sql): standarden nye ansatte
// får, så den ikke må skrives inn for hver ansatt. Den enkelte kan ha sin egen.
import { beforeAll, describe, expect, it } from "vitest";
import { lagApi } from "../src/api.js";
import { settKryptering } from "../src/kryptering.js";
import { settLokalOppgavekjorer } from "../src/tjenester.js";

describe.skipIf(!process.env.DATABASE_URL)("arbeidstid i full stilling", () => {
  const app = lagApi();
  const eier = "Bearer test:uid-full-eier:full-eier@server.test:mfa";
  let org: string;
  const kall = async (m: string, sti: string, k?: unknown) => {
    const r = await app.request(sti, { method: m, headers: { authorization: eier, "content-type": "application/json" }, body: k === undefined ? undefined : JSON.stringify(k) });
    return { status: r.status, data: (r.headers.get("content-type") ?? "").includes("json") ? ((await r.json()) as any) : null };
  };

  beforeAll(async () => {
    settLokalOppgavekjorer(async () => {});
    settKryptering(async (t) => Buffer.from(`kryptert:${t}`), async (b) => b.toString().replace("kryptert:", ""));
    org = (await kall("POST", "/api/organisasjoner", { navn: "Turnus AS" })).data.id;
  });

  it("standarden er 37,5 og kan endres av organisasjonen", async () => {
    expect((await kall("GET", `/api/org/${org}/lonn-oppsett`)).data.full_stilling).toBe(37.5);
    expect((await kall("PUT", `/api/org/${org}/lonn-oppsett`, { aktiv: true, full_stilling: 0 })).status).toBe(400);
    expect((await kall("PUT", `/api/org/${org}/lonn-oppsett`, { aktiv: true, full_stilling: 35.5 })).data).toMatchObject({ aktiv: true, full_stilling: 35.5 });
  });

  it("nye ansatte får standarden, med mindre de har sin egen", async () => {
    expect((await kall("POST", `/api/org/${org}/ansatte`, { fornavn: "Tone", etternavn: "Turnus" })).data.ukentlig_arbeidstid).toBe(35.5);
    expect((await kall("POST", `/api/org/${org}/ansatte`, { fornavn: "Dag", etternavn: "Dagtid", ukentlig_arbeidstid: 37.5 })).data.ukentlig_arbeidstid).toBe(37.5);
  });
});
