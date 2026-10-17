// Brukeren sletter sin egen konto (DELETE /api/meg, slettKonto.ts, 0123_slett_konto.sql): bekreftet
// med e-postadressen, ikke for eneste eier, brukeren slettes i Identity Platform i samme transaksjon
// (feiler det, er ingenting endret), og en konto som venter, kan også slettes.
import { beforeAll, describe, expect, it } from "vitest";
import { lagApi } from "../src/api.js";
import { settIdentitet } from "../src/auth.js";

describe.skipIf(!process.env.DATABASE_URL)("slette sin egen konto", () => {
  const app = lagApi();
  const eier = "Bearer test:uid-sk-eier:sk-eier@server.test:mfa:Eva%20Eier";
  const ola = "Bearer test:uid-sk-ola:sk-ola@server.test:mfa:Ola%20Nordmann";
  const kari = "Bearer test:uid-sk-kari:sk-kari@server.test:mfa:Kari";
  const vera = "Bearer test:uid-sk-vera:sk-vera@server.test:mfa:Vera:venter";
  const slettet: string[] = [];
  let identitetFeiler = false;
  let org: string;

  const kall = async (m: string, sti: string, k?: unknown, hvem = eier) => {
    const r = await app.request(sti, { method: m, headers: { authorization: hvem, "content-type": "application/json" }, body: k === undefined ? undefined : JSON.stringify(k) });
    return { status: r.status, data: (await r.json().catch(() => null)) as any };
  };
  const medlem = async (hvem: string, rolle = "fakturerer") => {
    const inv = (await kall("POST", `/api/org/${org}/invitasjoner`, { epost: hvem.split(":")[2], rolle })).data;
    expect((await kall("POST", "/api/invitasjoner/aksepter", { token: inv.lenke.split("/").pop() }, hvem)).status).toBe(200);
  };
  const medlemmer = async () => (await kall("GET", `/api/org/${org}/medlemmer`)).data.map((m: any) => m.epost).sort();

  beforeAll(async () => {
    settIdentitet({
      async bekreftelseskode() {
        return "kode";
      },
      async bekreftEpost() {},
      async slettBruker(uid) {
        if (identitetFeiler) throw new Error("Identity Platform svarer ikke");
        slettet.push(uid);
      },
    });
    org = (await kall("POST", "/api/organisasjoner", { navn: "Slett Konto Server AS", orgnr: "315000203" })).data.id;
    await medlem(ola);
    await medlem(kari);
  });

  it("må bekreftes med e-postadressen", async () => {
    expect((await kall("DELETE", "/api/meg", { bekreft: "feil@server.test" }, ola)).status).toBe(400);
    expect((await kall("DELETE", "/api/meg", {}, ola)).status).toBe(400);
    expect(slettet).toEqual([]);
  });

  it("eneste eier må gi fra seg eierrollen eller slette organisasjonen først", async () => {
    const r = await kall("DELETE", "/api/meg", { bekreft: "sk-eier@server.test" });
    expect(r.status).toBe(409);
    expect(r.data.error).toContain("Slett Konto Server AS");
    expect(slettet).toEqual([]);
  });

  it("feiler slettingen i Identity Platform, er ingenting endret", async () => {
    identitetFeiler = true;
    expect((await kall("DELETE", "/api/meg", { bekreft: "sk-kari@server.test" }, kari)).status).toBe(500);
    identitetFeiler = false;
    expect(await medlemmer()).toContain("sk-kari@server.test");
    expect((await kall("GET", "/api/meg", undefined, kari)).data.organisasjoner.map((o: any) => o.id)).toContain(org);
  });

  it("kontoen slettes: borte fra organisasjonen og i Identity Platform, og en ny innlogging er en ny konto", async () => {
    const for_ = (await kall("GET", "/api/meg", undefined, ola)).data.bruker.id;
    expect((await kall("DELETE", "/api/meg", { bekreft: " SK-Ola@server.test " }, ola)).status).toBe(204);
    expect(slettet).toEqual(["uid-sk-ola"]);
    expect(await medlemmer()).toEqual(["sk-eier@server.test", "sk-kari@server.test"]);
    // Med testinnloggingen finnes brukeren fortsatt; den blir en ny konto uten noe av det gamle.
    const ny = (await kall("GET", "/api/meg", undefined, ola)).data;
    expect(ny.bruker.id).not.toBe(for_);
    expect(ny.organisasjoner).toEqual([]);
  });

  it("med en eier til kan eieren slette kontoen", async () => {
    const kariId = (await kall("GET", "/api/meg", undefined, kari)).data.bruker.id;
    expect((await kall("PATCH", `/api/org/${org}/medlemmer/${kariId}`, { rolle: "eier" })).status).toBe(204);
    expect((await kall("DELETE", "/api/meg", { bekreft: "sk-eier@server.test" })).status).toBe(204);
    expect(slettet).toContain("uid-sk-eier");
    const m = (await kall("GET", `/api/org/${org}/medlemmer`, undefined, kari)).data;
    expect(m.map((x: any) => [x.epost, x.rolle])).toEqual([["sk-kari@server.test", "eier"]]);
  });

  it("en konto som venter på godkjenning, kan også slettes", async () => {
    expect((await kall("GET", "/api/meg", undefined, vera)).data.bruker.status).toBe("venter");
    expect((await kall("GET", "/api/org/x/kunder", undefined, vera)).status).toBe(403);
    expect((await kall("DELETE", "/api/meg", { bekreft: "sk-vera@server.test" }, vera)).status).toBe(204);
    expect(slettet).toContain("uid-sk-vera");
  });
});
