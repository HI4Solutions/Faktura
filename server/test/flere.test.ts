// Mange fakturaer på én gang: til forskjellige kunder med forskjellige produkter.
import { describe, expect, it, beforeAll } from "vitest";
import { lagApi } from "../src/api.js";
import { settLokalOppgavekjorer, type Oppgave } from "../src/tjenester.js";

describe.skipIf(!process.env.DATABASE_URL)("Flere fakturaer på én gang", () => {
  const app = lagApi();
  const ko: Oppgave[] = [];
  const eier = "Bearer test:uid-flere:flere@server.test:mfa";
  const fremmed = "Bearer test:uid-flere2:flere2@server.test:mfa";
  let org: string;
  let annenOrg: string;
  const k: string[] = [];

  const kall = async (m: string, sti: string, k?: unknown, t = eier) => {
    const r = await app.request(sti, { method: m, headers: { authorization: t, "content-type": "application/json" }, body: k === undefined ? undefined : JSON.stringify(k) });
    const type = r.headers.get("content-type") ?? "";
    return { status: r.status, data: type.includes("json") ? ((await r.json()) as any) : null };
  };
  const linje = (beskrivelse: string, enhetspris: number, antall = 1) => ({ beskrivelse, antall, enhet: "stk", enhetspris, mva_sats: 25 });
  const antall = async () => (await kall("GET", `/api/org/${org}/fakturaer`)).data.length as number;
  const sendinger = () => ko.filter((o) => o.type === "send-faktura").map((o: any) => o.faktura_id as string);

  beforeAll(async () => {
    settLokalOppgavekjorer(async (o) => {
      ko.push(o);
    });
    org = (await kall("POST", "/api/organisasjoner", { navn: "Flere AS" })).data.id;
    expect((await kall("PATCH", `/api/org/${org}`, { kontonr: "86011117947", mva_registrert: true })).status).toBe(200);
    for (const [navn, epost] of [["Leietaker 1", "en@test.no"], ["Leietaker 2", "to@test.no"], ["Uten e-post", null]] as const) {
      k.push((await kall("POST", `/api/org/${org}/kunder`, { navn, epost })).data.id);
    }
    annenOrg = (await kall("POST", "/api/organisasjoner", { navn: "Fremmed AS" }, fremmed)).data.id;
  });

  it("lager utkast til flere kunder med hver sine linjer", async () => {
    const r = await kall("POST", `/api/org/${org}/fakturaer/flere`, {
      fakturadato: "2026-10-06",
      forfallsdato: "2026-10-20",
      fakturaer: [
        { kunde_id: k[0], linjer: [linje("Husleie", 10000), linje("Parkering", 800)] },
        { kunde_id: k[1], linjer: [linje("Strøm", 400, 2)], kopi_til: ["regnskap@to.no"] },
      ],
    });
    expect(r.status).toBe(201);
    expect(r.data.fakturaer.map((f: any) => [f.kunde_navn, f.status, Number(f.sum_inkl_mva)])).toEqual([
      ["Leietaker 1", "utkast", 13500],
      ["Leietaker 2", "utkast", 1000],
    ]);
    expect(r.data.ikke_sendt).toEqual([]);
    expect(sendinger()).toEqual([]);

    // Listen viser sum, antall linjer og kundens e-post for utkast.
    const utkast = (await kall("GET", `/api/org/${org}/fakturaer?status=utkast`)).data;
    const f1 = utkast.find((f: any) => f.id === r.data.fakturaer[0].id);
    expect([Number(f1.sum_inkl_mva), f1.antall_linjer, f1.kunde_epost]).toEqual([13500, 2, "en@test.no"]);
    const f2 = await kall("GET", `/api/org/${org}/fakturaer/${r.data.fakturaer[1].id}`);
    expect([f2.data.fakturadato, f2.data.forfallsdato, f2.data.kopi_til]).toEqual(["2026-10-06", "2026-10-20", ["regnskap@to.no"]]);
  });

  it("utsteder og sender alle, med fortløpende nummer og fakturagebyr på hver", async () => {
    await kall("PATCH", `/api/org/${org}`, { standard_gebyr: 50 });
    ko.length = 0;
    const r = await kall("POST", `/api/org/${org}/fakturaer/flere`, {
      utsted: true,
      gebyr: true,
      fakturaer: [
        { kunde_id: k[0], linjer: [linje("Husleie", 10000)] },
        { kunde_id: k[1], linjer: [linje("Bod", 300)] },
        { kunde_id: k[2], linjer: [linje("Konsulenttime", 1000, 3)] },
      ],
    });
    expect(r.status).toBe(201);
    const nr = r.data.fakturaer.map((f: any) => Number(f.fakturanummer));
    expect(nr).toEqual([nr[0], nr[0] + 1, nr[0] + 2]);
    expect(r.data.fakturaer.every((f: any) => f.status === "utstedt")).toBe(true);
    expect(r.data.fakturaer.map((f: any) => Number(f.sum_inkl_mva))).toEqual([12562.5, 437.5, 3812.5]);
    expect(r.data.fakturaer[2].kunde_epost).toBe(null);
    expect(sendinger()).toEqual(r.data.fakturaer.map((f: any) => f.id));
    await kall("PATCH", `/api/org/${org}`, { standard_gebyr: 0 });
  });

  it("lagrer ingenting når én av fakturaene feiler, og sier hvilken", async () => {
    const for_ = await antall();
    const r = await kall("POST", `/api/org/${org}/fakturaer/flere`, {
      utsted: true,
      fakturaer: [
        { kunde_id: k[0], linjer: [linje("Husleie", 10000)] },
        { kunde_id: "00000000-0000-4000-8000-000000000000", linjer: [linje("Husleie", 10000)] },
      ],
    });
    expect(r.status).toBe(404);
    expect(r.data.error).toBe("Faktura 2: Fant ikke kunden");
    expect(await antall()).toBe(for_);

    // Negativ sum stoppes av utstedelsen; meldingen har kundens navn.
    const n = await kall("POST", `/api/org/${org}/fakturaer/flere`, {
      utsted: true,
      fakturaer: [
        { kunde_id: k[0], linjer: [linje("Husleie", 100)] },
        { kunde_id: k[1], linjer: [linje("Rabatt", -500)] },
      ],
    });
    expect(n.status).toBe(400);
    expect(n.data.error).toMatch(/^Faktura 2 \(Leietaker 2\): En faktura kan ikke ha negativ sum/);
    expect(await antall()).toBe(for_);

    expect((await kall("POST", `/api/org/${org}/fakturaer/flere`, { fakturaer: [{ kunde_id: k[0], linjer: [] }] })).status).toBe(400);
    expect((await kall("POST", `/api/org/${org}/fakturaer/flere`, { fakturaer: [] })).status).toBe(400);
    // En annen organisasjon kan ikke lage fakturaer her.
    expect((await kall("POST", `/api/org/${org}/fakturaer/flere`, { fakturaer: [{ kunde_id: k[0], linjer: [linje("X", 1)] }] }, fremmed)).status).toBe(403);
  });

  it("sender valgte utkast og hopper over de som allerede er sendt", async () => {
    const u = await kall("POST", `/api/org/${org}/fakturaer/flere`, {
      fakturaer: [
        { kunde_id: k[0], linjer: [linje("Vask", 500)] },
        { kunde_id: k[1], linjer: [linje("Vask", 700)] },
      ],
    });
    const [a, b] = u.data.fakturaer.map((f: any) => f.id);
    expect((await kall("POST", `/api/org/${org}/fakturaer/${a}/utsted`, { send_epost: false })).status).toBe(200);

    // En faktura fra en annen organisasjon stopper alt.
    const fremmedUtkast = await kall("POST", `/api/org/${annenOrg}/fakturaer`, { kunde_id: (await kall("POST", `/api/org/${annenOrg}/kunder`, { navn: "X" }, fremmed)).data.id, linjer: [linje("X", 1)] }, fremmed);
    const stopp = await kall("POST", `/api/org/${org}/fakturaer/utsted-flere`, { ider: [b, fremmedUtkast.data.id] });
    expect(stopp.status).toBe(404);
    expect(stopp.data.error).toBe("Faktura 2: Fant ikke fakturaen");
    expect((await kall("GET", `/api/org/${org}/fakturaer/${b}`)).data.status).toBe("utkast");

    ko.length = 0;
    const r = await kall("POST", `/api/org/${org}/fakturaer/utsted-flere`, { ider: [a, b, b] });
    expect(r.status).toBe(200);
    expect(r.data.fakturaer.map((f: any) => [f.id, f.status])).toEqual([[b, "utstedt"]]);
    expect(r.data.hoppet_over).toEqual([a]);
    expect(sendinger()).toEqual([b]);
  });
});
