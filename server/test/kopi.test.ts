// Kopi av fakturaer: kopimottakere per faktura (synlig kopi) og fast kopiadresse per
// organisasjon (blindkopi), med varsel til eierne når den faste adressen endres.
import { describe, expect, it, beforeAll } from "vitest";
import { config } from "../src/config.js";
import { lagApi } from "../src/api.js";
import { somSystem, en } from "../src/db.js";
import { lagring, settEpost, settLokalOppgavekjorer, type EpostMelding, type Oppgave } from "../src/tjenester.js";
import { publiserUtboks, sendFaktura } from "../src/worker.js";

const c = config as any;

describe.skipIf(!process.env.DATABASE_URL)("Kopi av fakturaer", () => {
  const app = lagApi();
  const ko: Oppgave[] = [];
  const sendt: EpostMelding[] = [];
  const eier = "Bearer test:uid-kopi:kopi@server.test:mfa";
  const linjer = [{ beskrivelse: "Arbeid", antall: 1, enhet: "stk", enhetspris: 1000, mva_sats: 25 }];
  let org: string;
  let kunde: string;

  const kall = async (m: string, sti: string, k?: unknown) => {
    const r = await app.request(sti, { method: m, headers: { authorization: eier, "content-type": "application/json" }, body: k === undefined ? undefined : JSON.stringify(k) });
    const type = r.headers.get("content-type") ?? "";
    return { status: r.status, data: type.includes("json") ? ((await r.json()) as any) : null };
  };
  // Kjører utsendingen som workeren ville gjort, og gir e-posten som ble sendt.
  const send = async (fakturaId: string) => {
    const o = ko.filter((x) => x.type === "send-faktura" && x.faktura_id === fakturaId).at(-1) as any;
    expect(o).toBeTruthy();
    const for_ = sendt.length;
    await sendFaktura({ ...o, oppgave_id: `kopi-${Math.random()}` });
    expect(sendt.length).toBe(for_ + 1);
    return sendt.at(-1)!;
  };

  beforeAll(async () => {
    c.fakturaBucket = "test-fakturaer";
    const filer = new Map<string, Uint8Array>();
    lagring.hent = async (_b, sti) => filer.get(sti) ?? null;
    lagring.lagre = async (_b, sti, data) => void filer.set(sti, data);
    settEpost({
      async send(m) {
        sendt.push(m);
        return { id: `epost-${sendt.length}-${Math.random()}` };
      },
    });
    settLokalOppgavekjorer(async (o) => {
      ko.push(o);
    });
    org = (await kall("POST", "/api/organisasjoner", { navn: "Kopi AS" })).data.id;
    expect((await kall("PATCH", `/api/org/${org}`, { kontonr: "86011117947", epost: "post@kopi.no" })).status).toBe(200);
    kunde = (await kall("POST", `/api/org/${org}/kunder`, { navn: "Kunde AS", epost: "kunde@kunde.no" })).data.id;
  });

  it("sender kopi til kopimottakerne på fakturaen og blindkopi til organisasjonen", async () => {
    expect((await kall("POST", `/api/org/${org}/fakturaer`, { kunde_id: kunde, kopi_til: ["ikke-en-adresse"], linjer })).status).toBe(400);

    const f = await kall("POST", `/api/org/${org}/fakturaer`, {
      kunde_id: kunde,
      kopi_til: ["Lise@kunde.no", "lise@kunde.no", "kunde@kunde.no", "per@kunde.no"],
      linjer,
    });
    expect(f.status).toBe(201);
    expect(f.data.kopi_til).toEqual(["Lise@kunde.no", "kunde@kunde.no", "per@kunde.no"]);

    // Endring uten kopimottakere i kroppen (eldre klient) beholder dem.
    const p = await kall("PUT", `/api/org/${org}/fakturaer/${f.data.id}`, { kunde_id: kunde, linjer });
    expect(p.data.kopi_til).toEqual(["Lise@kunde.no", "kunde@kunde.no", "per@kunde.no"]);

    expect((await kall("POST", `/api/org/${org}/fakturaer/${f.data.id}/utsted`, { send_epost: true })).status).toBe(200);
    const e = await send(f.data.id);
    // Kunden står ikke også som kopi; uten fast kopiadresse får organisasjonen blindkopi.
    expect(e.til).toEqual(["kunde@kunde.no"]);
    expect(e.kopi).toEqual(["Lise@kunde.no", "per@kunde.no"]);
    expect(e.blindkopi).toEqual(["post@kopi.no"]);

    const vis = await kall("GET", `/api/org/${org}/fakturaer/${f.data.id}`);
    expect(vis.data.eposter.at(-1)).toMatchObject({ til: "kunde@kunde.no", kopi: ["Lise@kunde.no", "per@kunde.no"] });
  });

  it("fast kopiadresse erstatter organisasjonens e-post, og eierne får beskjed når den endres", async () => {
    expect((await kall("PATCH", `/api/org/${org}`, { kopi_til: ["feil"] })).status).toBe(400);
    expect((await kall("PATCH", `/api/org/${org}`, { kopi_til: ["a@b.no", "c@b.no", "d@b.no", "e@b.no", "f@b.no", "g@b.no"] })).status).toBe(400);
    const o = await kall("PATCH", `/api/org/${org}`, { kopi_til: ["regnskap@byraa.no", "Regnskap@byraa.no"] });
    expect(o.status).toBe(200);
    expect(o.data.kopi_til).toEqual(["regnskap@byraa.no"]);

    const hendelse = await somSystem((db) => en(db, "select data from faktura.utboks where org_id = $1 and hendelse = 'organisasjon.kopi_endret'", [org]));
    expect(hendelse?.data).toMatchObject({ fra: [], til: ["regnskap@byraa.no"] });
    await publiserUtboks();
    const varsel = sendt.find((m) => m.emne === "Kopi av fakturaene til Kopi AS går til en ny adresse");
    expect(varsel?.til).toEqual(["kopi@server.test"]);
    expect(varsel?.tekst).toContain("Til: regnskap@byraa.no");

    // Ny faktura uten kopimottakere: bare blindkopi til den faste adressen.
    const f = await kall("POST", `/api/org/${org}/fakturaer`, { kunde_id: kunde, linjer });
    await kall("POST", `/api/org/${org}/fakturaer/${f.data.id}/utsted`, { send_epost: true });
    const e = await send(f.data.id);
    expect(e.kopi).toEqual([]);
    expect(e.blindkopi).toEqual(["regnskap@byraa.no"]);
  });

  it("sender på nytt til kundens nye e-post, med kopimottakere lagt til etter utstedelse", async () => {
    const f = await kall("POST", `/api/org/${org}/fakturaer`, { kunde_id: kunde, linjer });
    await kall("POST", `/api/org/${org}/fakturaer/${f.data.id}/utsted`, { send_epost: false });
    expect((await kall("PATCH", `/api/org/${org}/kunder/${kunde}`, { epost: "ny@kunde.no" })).status).toBe(200);

    expect((await kall("POST", `/api/org/${org}/fakturaer/${f.data.id}/send`, { kopi_til: ["x"] })).status).toBe(400);
    expect((await kall("POST", `/api/org/${org}/fakturaer/${f.data.id}/send`, { kopi_til: ["okonomi@kunde.no"] })).status).toBe(202);
    const e = await send(f.data.id);
    expect(e.til).toEqual(["ny@kunde.no"]);
    expect(e.kopi).toEqual(["okonomi@kunde.no"]);
    expect((await kall("GET", `/api/org/${org}/fakturaer/${f.data.id}`)).data.kopi_til).toEqual(["okonomi@kunde.no"]);
  });

  it("gjentakende fakturaer tar med kopimottakerne", async () => {
    const idag = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Oslo" }).format(new Date());
    const g = await kall("POST", `/api/org/${org}/gjentakelser`, {
      kunde_id: kunde,
      linjer,
      intervall: "maaned",
      forfall_dag: 1,
      neste_forfall: idag,
      kopi_til: ["utleie@kunde.no"],
    });
    expect(g.status).toBe(201);
    expect(g.data.kopi_til).toEqual(["utleie@kunde.no"]);
    const f = await kall("POST", `/api/org/${org}/gjentakelser/${g.data.id}/kjor`);
    expect(f.status).toBe(201);
    expect(f.data.kopi_til).toEqual(["utleie@kunde.no"]);
  });
});
