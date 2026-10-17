// Yrkeskodene fra SSBs yrkeskatalog (Klass 145, yrkeskoder.ts): søket på navn og kode, oppslaget
// av en kode, og at katalogen huskes (og brukes når SSB ikke svarer).
import { beforeEach, describe, expect, it } from "vitest";
import { lagApi } from "../src/api.js";
import { settKlassFetch, sokYrker, yrkeskatalog, type Yrke } from "../src/yrkeskoder.js";

const KODER = [
  { code: "2223", parentCode: null, level: "1", name: "Sykepleiere" },
  { code: "2223101", parentCode: "2223", level: "2", name: "Sykepleier" },
  { code: "2223108", parentCode: "2223", level: "2", name: "Avdelingssykepleier" },
  { code: "2221104", parentCode: "2221", level: "2", name: "Spesialsykepleier (anestesi)" },
  { code: "5223101", parentCode: "5223", level: "2", name: "Butikkmedarbeider" },
  { code: "4110101", parentCode: "4110", level: "2", name: "Kontormedarbeider" },
  { code: "5163121", parentCode: "5163", level: "2", name: "Vaktmester" },
];
const YRKER: Yrke[] = KODER.filter((k) => k.code.length === 7).map((k) => ({ kode: k.code, navn: k.name }));

describe("søket i yrkeskatalogen", () => {
  it("på navnet: de som begynner med søket først, så de der et ord begynner med det", () => {
    expect(sokYrker(YRKER, "sykepleier").map((y) => y.navn)).toEqual(["Sykepleier", "Avdelingssykepleier", "Spesialsykepleier (anestesi)"]);
    expect(sokYrker(YRKER, "anest").map((y) => y.kode)).toEqual(["2221104"]);
    expect(sokYrker(YRKER, "medarbeider kontor").map((y) => y.kode)).toEqual(["4110101"]);
    expect(sokYrker(YRKER, "  ")).toEqual([]);
  });

  it("på koden (sifrene den begynner med, også med mellomrom)", () => {
    expect(sokYrker(YRKER, "2223").map((y) => y.kode)).toEqual(["2223101", "2223108"]);
    expect(sokYrker(YRKER, "5163 121")).toEqual([{ kode: "5163121", navn: "Vaktmester" }]);
    expect(sokYrker(YRKER, "2", 1)).toHaveLength(1);
  });
});

describe("yrkeskatalogen fra SSB", () => {
  let kall: string[] = [];
  beforeEach(() => {
    kall = [];
    settKlassFetch(async (url) => {
      kall.push(String(url));
      return new Response(JSON.stringify({ codes: KODER }), { status: 200, headers: { "content-type": "application/json" } });
    });
  });

  it("henter de sjusifrede kodene som gjelder i dag, og husker dem", async () => {
    const k = await yrkeskatalog();
    expect(k.yrker).toHaveLength(6);
    expect(k.kart.get("2223108")?.navn).toBe("Avdelingssykepleier");
    await yrkeskatalog();
    expect(kall).toHaveLength(1);
    expect(kall[0]).toMatch(/^https:\/\/data\.ssb\.no\/api\/klass\/v1\/classifications\/145\/codesAt\?date=\d{4}-\d{2}-\d{2}$/);
  });
});

describe.skipIf(!process.env.DATABASE_URL)("yrkeskodene i appen", () => {
  const app = lagApi();
  const eier = "Bearer test:uid-yrke-eier:yrke-eier@server.test:mfa";
  const kall = async (sti: string) => {
    const r = await app.request(sti, { headers: { authorization: eier } });
    return { status: r.status, data: (await r.json()) as any };
  };

  it("søk og oppslag av en kode for dem som har personalmodulen", async () => {
    let feiler = false;
    settKlassFetch(async () => (feiler ? new Response("", { status: 500 }) : new Response(JSON.stringify({ codes: KODER }), { status: 200 })));
    feiler = true;
    const org = (await app.request("/api/organisasjoner", { method: "POST", headers: { authorization: eier, "content-type": "application/json" }, body: JSON.stringify({ navn: "Yrke AS", orgnr: "811000981" }) }).then((r) => r.json()) as any).id;
    const nede = await kall(`/api/org/${org}/ansatte/yrkeskoder?sok=syk`);
    expect(nede.status).toBe(503);
    expect(nede.data.error).toBe("Fikk ikke hentet yrkeskatalogen fra SSB. Skriv yrkeskoden (7 siffer) selv, eller prøv igjen senere.");
    feiler = false;
    expect((await kall(`/api/org/${org}/ansatte/yrkeskoder?sok=sykepleier`)).data.yrker.map((y: any) => y.kode)).toEqual(["2223101", "2223108", "2221104"]);
    expect((await kall(`/api/org/${org}/ansatte/yrkeskoder?kode=2223 108`)).data).toEqual({ yrker: [{ kode: "2223108", navn: "Avdelingssykepleier" }] });
    expect((await kall(`/api/org/${org}/ansatte/yrkeskoder?kode=9999999`)).data).toEqual({ yrker: [] });
    // SSB nede igjen: katalogen som er hentet, brukes.
    feiler = true;
    expect((await kall(`/api/org/${org}/ansatte/yrkeskoder?sok=vakt`)).data.yrker).toEqual([{ kode: "5163121", navn: "Vaktmester" }]);
  });
});
