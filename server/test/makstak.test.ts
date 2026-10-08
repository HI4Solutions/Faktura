// Makstak: kunden faktureres aldri mer enn makstaket. Kundens makstak følger med til nye
// fakturaer, flere på én gang og gjentakelser, og kan fjernes eller endres per faktura.
// Utkast viser fratrekket, utstedte fakturaer har det som linjer, EHF-en er gyldig, og
// forhåndsvisningen i appen regner likt med databasen.
import { beforeAll, describe, expect, it } from "vitest";
import { lagApi } from "../src/api.js";
import { lagEhf } from "../src/ehf.js";
import { settLokalOppgavekjorer } from "../src/tjenester.js";
import { somBruker, en } from "../src/db.js";
// Forhåndsvisningen i appen (samme kode som i nettleseren).
import { makstakFratrekk, summerMedMakstak } from "../../web/src/format.js";
import { lagValidator, type Funn } from "./ehfValidator.js";

describe.skipIf(!process.env.DATABASE_URL)("Makstak", () => {
  const app = lagApi();
  const eier = "Bearer test:uid-makstak:makstak@server.test:mfa";
  let org: string;
  let lege: string;
  let annen: string;
  let brukerId: string;
  let valider: (xml: string) => Funn[];

  const kall = async (m: string, sti: string, k?: unknown) => {
    const r = await app.request(sti, { method: m, headers: { authorization: eier, "content-type": "application/json" }, body: k === undefined ? undefined : JSON.stringify(k) });
    const type = r.headers.get("content-type") ?? "";
    return { status: r.status, data: type.includes("json") ? ((await r.json()) as any) : null };
  };
  const hentF = async (id: string) => (await kall("GET", `/api/org/${org}/fakturaer/${id}`)).data;
  // Små beløp: nye (uverifiserte) organisasjoner kan fakturere høyst 50 000 kr i måneden.
  const linjer = [
    { beskrivelse: "Hjelpepersonell", antall: 1, enhetspris: 5000, mva_sats: 25 },
    { beskrivelse: "Kontorleie", antall: 1, enhetspris: 4000, mva_sats: 0 },
  ];

  beforeAll(async () => {
    settLokalOppgavekjorer(async () => {});
    valider = lagValidator();
    org = (await kall("POST", "/api/organisasjoner", { navn: "Makstak Legesenter AS" })).data.id;
    expect((await kall("PATCH", `/api/org/${org}`, { kontonr: "86011117947", mva_registrert: true })).status).toBe(200);
    brukerId = (await kall("GET", "/api/meg")).data.bruker.id;
    lege = (await kall("POST", `/api/org/${org}/kunder`, { navn: "Dr. Lege", epost: "lege@test.no", makstak: 7000 })).data.id;
    annen = (await kall("POST", `/api/org/${org}/kunder`, { navn: "Dr. Annen", epost: "annen@test.no" })).data.id;
  }, 300_000);

  it("makstaket står på kunden og må være mer enn 0", async () => {
    expect((await kall("GET", `/api/org/${org}/kunder/${lege}`)).data.makstak).toBe(7000);
    const feil = await kall("PATCH", `/api/org/${org}/kunder/${annen}`, { makstak: 0 });
    expect(feil.status).toBe(400);
    expect(feil.data.error).toContain("Makstaket må være mer enn 0 kr");
  });

  it("nye fakturaer får kundens makstak, og det kan fjernes eller endres per faktura", async () => {
    const f = (await kall("POST", `/api/org/${org}/fakturaer`, { kunde_id: lege, linjer })).data;
    expect(f.makstak).toBe(7000);
    const u = await hentF(f.id);
    expect(u.makstak_linjer.map((l: any) => [l.beskrivelse, l.mva_sats, l.belop_eks, l.mva_belop])).toEqual([
      ["Fratrekk etter avtalt makstak (7 000 kr)", 25, -1585.37, -396.34],
      ["Fratrekk etter avtalt makstak (7 000 kr)", 0, -1268.29, 0],
    ]);
    const liste = (await kall("GET", `/api/org/${org}/fakturaer?status=utkast`)).data;
    expect(liste.find((x: any) => x.id === f.id).sum_inkl_mva).toBe(7000);

    // Fjernet på denne fakturaen.
    const uten = (await kall("PUT", `/api/org/${org}/fakturaer/${f.id}`, { kunde_id: lege, linjer, makstak: null })).data;
    expect(uten.makstak).toBeNull();
    expect((await hentF(f.id)).makstak_linjer).toEqual([]);
    // Et annet makstak på denne fakturaen.
    expect((await kall("PUT", `/api/org/${org}/fakturaer/${f.id}`, { kunde_id: lege, linjer, makstak: 10000 })).data.makstak).toBe(10000);
    // En kunde uten makstak: ingen.
    expect((await kall("PUT", `/api/org/${org}/fakturaer/${f.id}`, { kunde_id: annen, linjer })).data.makstak).toBeNull();
    expect((await kall("POST", `/api/org/${org}/fakturaer`, { kunde_id: lege, linjer, makstak: null })).data.makstak).toBeNull();
  });

  it("utstedt: fratrekket er linjer, summen er makstaket, og EHF-en er gyldig", async () => {
    const f = (await kall("POST", `/api/org/${org}/fakturaer`, { kunde_id: lege, linjer, deres_referanse: "Lise" })).data;
    const u = (await kall("POST", `/api/org/${org}/fakturaer/${f.id}/utsted`, { send_epost: false })).data;
    expect([u.sum_eks_mva, u.mva, u.sum_inkl_mva]).toEqual([6146.34, 853.66, 7000]);
    const full = await hentF(f.id);
    expect(full.makstak_linjer).toEqual([]);
    expect(full.linjer.filter((l: any) => l.makstak).map((l: any) => [l.antall, l.enhetspris, l.mva_sats])).toEqual([
      [-1, 1585.37, 25],
      [-1, 1268.29, 0],
    ]);
    // EHF krever org.nr. hos begge; ellers som den er.
    const xml = lagEhf({
      ...full,
      selger: { ...full.selger, orgnr: "923609016", firmanavn: full.selger.navn, adresse: "Storgata 1", postnr: "0155", poststed: "Oslo" },
      kunde: { ...full.kunde, orgnr: "974760673", adresse: "Kaigata 5", postnr: "5003", poststed: "Bergen" },
    });
    expect(xml).toContain("<cbc:PayableAmount currencyID=\"NOK\">7000.00</cbc:PayableAmount>");
    expect(xml).toContain("<cbc:InvoicedQuantity unitCode=\"C62\">-1</cbc:InvoicedQuantity>");
    const funn = valider(xml);
    expect(funn.filter((x) => x.flagg === "fatal")).toEqual([]);
  }, 300_000);

  it("delvis kreditering tar bare det som var over makstaket", async () => {
    const f = (await kall("POST", `/api/org/${org}/fakturaer`, { kunde_id: lege, linjer })).data;
    await kall("POST", `/api/org/${org}/fakturaer/${f.id}/utsted`, { send_epost: false });
    const leie = (await hentF(f.id)).linjer.find((l: any) => l.beskrivelse === "Kontorleie");
    const kn = await kall("POST", `/api/org/${org}/fakturaer/${f.id}/krediter`, { linjer: [{ linje_id: leie.id, antall: 1 }], send_epost: false });
    expect(kn.status).toBe(201);
    expect(kn.data.sum_inkl_mva).toBe(-750);
    const etter = await hentF(f.id);
    expect(etter.sum_inkl_mva - etter.kreditert_belop).toBe(6250);
  });

  it("flere på én gang og gjentakelser får kundens makstak", async () => {
    const r = await kall("POST", `/api/org/${org}/fakturaer/flere`, {
      fakturaer: [
        { kunde_id: lege, linjer },
        { kunde_id: annen, linjer },
        { kunde_id: lege, linjer, makstak: null },
      ],
    });
    expect(r.status).toBe(201);
    expect(r.data.fakturaer.map((f: any) => f.sum_inkl_mva)).toEqual([7000, 10250, 10250]);

    const g = await kall("POST", `/api/org/${org}/gjentakelser`, { kunde_id: lege, linjer, intervall: "maaned", forfall_dag: 20, neste_forfall: "2027-01-20" });
    expect(g.data.makstak).toBe(7000);
    expect((await kall("PATCH", `/api/org/${org}/gjentakelser/${g.data.id}`, { kunde_id: annen })).data.makstak).toBeNull();
    expect((await kall("PATCH", `/api/org/${org}/gjentakelser/${g.data.id}`, { kunde_id: lege })).data.makstak).toBe(7000);
    expect((await kall("PATCH", `/api/org/${org}/gjentakelser/${g.data.id}`, { makstak: 6500 })).data.makstak).toBe(6500);
  });

  it("nytt makstak på kunden gjelder utkast og gjentakelser som hadde det gamle", async () => {
    const a = (await kall("POST", `/api/org/${org}/fakturaer`, { kunde_id: lege, linjer })).data;
    const b = (await kall("POST", `/api/org/${org}/fakturaer`, { kunde_id: lege, linjer, makstak: null })).data;
    const g = (await kall("POST", `/api/org/${org}/gjentakelser`, { kunde_id: lege, linjer, intervall: "maaned", forfall_dag: 20, neste_forfall: "2027-01-20" })).data;
    expect((await kall("PATCH", `/api/org/${org}/kunder/${lege}`, { makstak: 7500 })).status).toBe(200);
    expect((await hentF(a.id)).makstak).toBe(7500);
    expect((await hentF(b.id)).makstak).toBeNull();
    const gs = (await kall("GET", `/api/org/${org}/gjentakelser`)).data;
    expect(gs.find((x: any) => x.id === g.id).makstak).toBe(7500);
  });

  it("forhåndsvisningen i appen regner likt med databasen", async () => {
    const tilfeller: { linjer: { antall: number; enhetspris: number; mva_sats: number; rabatt_prosent?: number | null; rabatt_belop?: number | null }[]; tak: number }[] = [
      { linjer, tak: 7000 },
      { linjer, tak: 10250 },
      { linjer: [{ antall: 1, enhetspris: 50000, mva_sats: 25 }, { antall: 1, enhetspris: 40000, mva_sats: 0 }], tak: 70000 },
      { linjer: [{ antall: 3, enhetspris: 333.33, mva_sats: 15, rabatt_prosent: 33.33 }, { antall: 1, enhetspris: 1234.57, mva_sats: 25 }], tak: 1500 },
      { linjer: [{ antall: 1, enhetspris: 80.01, mva_sats: 25 }], tak: 100 },
      { linjer: [{ antall: 2, enhetspris: 999.99, mva_sats: 12 }, { antall: 1, enhetspris: 0.5, mva_sats: 0 }, { antall: 1, enhetspris: 500, mva_sats: 25, rabatt_belop: 50 }], tak: 2000 },
      { linjer: [{ antall: 1, enhetspris: 5000, mva_sats: 25 }, { antall: -1, enhetspris: 300, mva_sats: 0 }], tak: 3000 },
    ];
    // Tilfeldige linjer med øre og flere satser.
    let x = 7;
    const neste = () => ((x = (x * 48271) % 2147483647) / 2147483647);
    for (let i = 0; i < 40; i++) {
      const ls = Array.from({ length: 1 + Math.floor(neste() * 4) }, () => ({
        antall: [1, 2, 3, 1.5][Math.floor(neste() * 4)]!,
        enhetspris: Math.round(neste() * 2_000_000) / 100,
        mva_sats: [25, 15, 12, 0][Math.floor(neste() * 4)]!,
      }));
      const sum = summerMedMakstak(ls, null).inkl;
      tilfeller.push({ linjer: ls, tak: Math.max(1, Math.round(sum * (0.3 + neste() * 0.6) * 100) / 100) });
    }
    await somBruker(brukerId, async (db) => {
      for (const t of tilfeller) {
        const grupper = new Map<number, number>();
        for (const l of t.linjer) {
          const r = await en<{ inkl: number }>(
            db,
            `select round(faktura.linje_netto($1, $2, $3, $4), 2) + round(faktura.linje_netto($1, $2, $3, $4) * $5 / 100, 2) as inkl`,
            [l.antall, l.enhetspris, l.rabatt_prosent ?? null, l.rabatt_belop ?? null, l.mva_sats],
          );
          grupper.set(l.mva_sats, Math.round(((grupper.get(l.mva_sats) ?? 0) + r!.inkl) * 100) / 100);
        }
        const satser = [...grupper.keys()].sort((a, b) => b - a);
        const db_ = await db.query(
          "select mva_sats, belop_eks, mva_belop from faktura.makstak_fordel($1, $2::numeric[], $3::numeric[]) order by mva_sats desc",
          [t.tak, satser, satser.map((s) => grupper.get(s))],
        );
        const app_ = makstakFratrekk(t.linjer, t.tak);
        expect(app_.map((f) => [f.mva_sats, f.eks, f.mva]), JSON.stringify(t)).toEqual(db_.rows.map((r: any) => [r.mva_sats, r.belop_eks, r.mva_belop]));
        const s = summerMedMakstak(t.linjer, t.tak);
        // Aldri over makstaket, og høyst ett øre under (i øre, så flyttall ikke teller).
        const under = Math.round((t.tak - s.inkl) * 100);
        expect(under).toBeGreaterThanOrEqual(0);
        if (s.foer > t.tak) expect(under).toBeLessThanOrEqual(1);
      }
    });
  });
});
