// Skjult fraværstype: eier, administrator og den ansatte selv ser hva slags fravær det er (syk,
// ferie ...) og notatet. Regnskap ser bare «fravaer» i fraværslista, vaktplanen og på tavla.
import { beforeAll, describe, expect, it } from "vitest";
import { lagApi } from "../src/api.js";
import { settKryptering } from "../src/kryptering.js";
import { settLokalOppgavekjorer } from "../src/tjenester.js";

const iDag = () => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Oslo" }).format(new Date());

describe.skipIf(!process.env.DATABASE_URL)("skjult fraværstype", () => {
  const app = lagApi();
  const eier = "Bearer test:uid-fsk-eier:fsk-eier@server.test:mfa";
  const regnskap = "Bearer test:uid-fsk-regn:fsk-regn@server.test:mfa";
  const kari = "Bearer test:uid-fsk-kari:kari.fsk@server.test";
  let org: string;
  let kariId: string;

  const kall = async (m: string, sti: string, k?: unknown, hvem = eier) => {
    const r = await app.request(sti, { method: m, headers: { authorization: hvem, "content-type": "application/json" }, body: k === undefined ? undefined : JSON.stringify(k) });
    return { status: r.status, data: (r.headers.get("content-type") ?? "").includes("json") ? ((await r.json()) as any) : null };
  };

  beforeAll(async () => {
    settLokalOppgavekjorer(async () => {});
    settKryptering(async (t) => Buffer.from(`kryptert:${t}`), async (b) => b.toString().replace("kryptert:", ""));
    org = (await kall("POST", "/api/organisasjoner", { navn: "Skjult Fravær AS" })).data.id;
    await kall("PUT", `/api/org/${org}/lonn-oppsett`, { aktiv: true });
    kariId = (await kall("POST", `/api/org/${org}/ansatte`, { fornavn: "Kari", etternavn: "Kake", epost: "kari.fsk@server.test" })).data.id;
    const olaId = (await kall("POST", `/api/org/${org}/ansatte`, { fornavn: "Ola", etternavn: "Olsen" })).data.id;
    const inv = await kall("POST", `/api/org/${org}/ansatte/${kariId}/inviter`);
    expect((await kall("POST", "/api/invitasjoner/aksepter", { token: inv.data.lenke.split("/").pop() }, kari)).status).toBe(200);
    const r = await kall("POST", `/api/org/${org}/invitasjoner`, { epost: "fsk-regn@server.test", rolle: "regnskap" });
    expect((await kall("POST", "/api/invitasjoner/aksepter", { token: r.data.lenke.split("/").pop() }, regnskap)).status).toBe(200);
    expect((await kall("POST", `/api/org/${org}/fravaer`, { ansatt_id: kariId, type: "syk", fra: iDag(), til: iDag(), notat: "Ring meg" })).status).toBe(201);
    expect((await kall("POST", `/api/org/${org}/fravaer`, { ansatt_id: olaId, type: "ferie", fra: iDag(), til: iDag() })).status).toBe(201);
  });

  const liste = (hvem: string) => kall("GET", `/api/org/${org}/fravaer?fra=${iDag()}&til=${iDag()}`, undefined, hvem);

  it("eieren ser hva slags fravær det er, og notatet", async () => {
    const f = (await liste(eier)).data;
    expect(f.map((x: any) => x.type).sort()).toEqual(["ferie", "syk"]);
    expect(f.find((x: any) => x.type === "syk").notat).toBe("Ring meg");
  });

  it("regnskap ser bare at de har fravær, i lista, vaktplanen og på tavla", async () => {
    const f = (await liste(regnskap)).data;
    expect(f).toHaveLength(2);
    expect(f.every((x: any) => x.type === "fravaer" && x.notat === null)).toBe(true);
    const v = (await kall("GET", `/api/org/${org}/vakter?fra=${iDag()}&til=${iDag()}`, undefined, regnskap)).data;
    expect(v.fravaer.map((x: any) => x.type)).toEqual(["fravaer", "fravaer"]);
    const t = (await kall("GET", `/api/org/${org}/tavle?dato=${iDag()}`, undefined, regnskap)).data;
    expect(t.fravaer.map((x: any) => x.type)).toEqual(["fravaer", "fravaer"]);
    expect((await kall("GET", `/api/org/${org}/tavle?dato=${iDag()}`)).data.fravaer.map((x: any) => x.type).sort()).toEqual(["ferie", "syk"]);
  });

  it("den ansatte ser sitt eget fravær med typen", async () => {
    expect((await liste(kari)).data).toMatchObject([{ ansatt_id: kariId, type: "syk", notat: "Ring meg" }]);
  });
});
