// Rabatt på linjene, produkter uten fast pris, fast avsender og konto på produkter, og
// notat til kunden på fakturaen.
import { describe, expect, it, beforeAll } from "vitest";
import { lagApi } from "../src/api.js";
import { en, somBruker, somSystem } from "../src/db.js";
import { fakturaEpost } from "../src/dokument.js";
import { lagPdf } from "../src/pdf.js";
import { summer } from "../src/regler.js";
import { settLokalOppgavekjorer } from "../src/tjenester.js";

describe.skipIf(!process.env.DATABASE_URL)("Rabatt, variabel pris, fast avsender og notat", () => {
  const app = lagApi();
  const eier = "Bearer test:uid-rabatt:rabatt@server.test:mfa";
  let org: string;
  let kunde: string;

  const kall = async (m: string, sti: string, k?: unknown) => {
    const r = await app.request(sti, { method: m, headers: { authorization: eier, "content-type": "application/json" }, body: k === undefined ? undefined : JSON.stringify(k) });
    const type = r.headers.get("content-type") ?? "";
    return { status: r.status, data: type.includes("json") ? ((await r.json()) as any) : null };
  };
  const hentF = async (id: string) => (await kall("GET", `/api/org/${org}/fakturaer/${id}`)).data;
  const utsted = async (id: string) => (await kall("POST", `/api/org/${org}/fakturaer/${id}/utsted`, { send_epost: false })).data;
  const tall = (f: any) => [Number(f.sum_eks_mva), Number(f.mva), Number(f.sum_inkl_mva)];

  beforeAll(async () => {
    settLokalOppgavekjorer(async () => {});
    org = (await kall("POST", "/api/organisasjoner", { navn: "Rabatt AS" })).data.id;
    expect((await kall("PATCH", `/api/org/${org}`, { kontonr: "86011117947", mva_registrert: true, innehaver: "Ola Nordmann" })).status).toBe(200);
    kunde = (await kall("POST", `/api/org/${org}/kunder`, { navn: "Leietaker AS", epost: "leie@test.no" })).data.id;
  });

  it("rabatt i prosent og kroner: summer i utkast, ved utstedelse, i PDF og som i nettleseren", async () => {
    const linjer = [
      { beskrivelse: "Husleie", antall: 2, enhet: "mnd", enhetspris: 1000, mva_sats: 25, rabatt_prosent: 10 },
      { beskrivelse: "Parkering", antall: 1, enhet: "mnd", enhetspris: 500, mva_sats: 25, rabatt_belop: 100 },
      { beskrivelse: "Mat", antall: 3, enhetspris: 333.33, mva_sats: 15, rabatt_prosent: 33.33 },
      { beskrivelse: "Strøm", antall: 1, enhetspris: 250, mva_sats: 25 },
    ];
    const f = await kall("POST", `/api/org/${org}/fakturaer`, { kunde_id: kunde, kommentar: "Takk for handelen! 😊 → Ny adresse fra november.", linjer });
    expect(f.status).toBe(201);
    // 1800 + 400 + (999,99 − 333,30) + 250; mva 450 + 100 + 100,00 + 62,50
    const forventet = [3116.69, 712.5, 3829.19];
    const utkast = (await kall("GET", `/api/org/${org}/fakturaer?status=utkast`)).data.find((x: any) => x.id === f.data.id);
    expect(Number(utkast.sum_inkl_mva)).toBe(forventet[2]);
    const js = summer(linjer);
    expect([js.eks, js.mva, js.inkl]).toEqual(forventet);

    const u = await utsted(f.data.id);
    expect(tall(u)).toEqual(forventet);
    const full = await hentF(f.data.id);
    expect(full.kommentar).toBe("Takk for handelen! 😊 → Ny adresse fra november.");
    expect(full.linjer.map((l: any) => [l.rabatt_prosent, l.rabatt_belop, Number(l.belop_eks)])).toEqual([
      [10, null, 1800],
      [null, 100, 400],
      [33.33, null, 666.69],
      [null, null, 250],
    ]);

    // PDF-en tåler tegn standardfontene ikke har (emoji, piler).
    const pdf = await lagPdf({
      type: "faktura",
      utkast: false,
      fakturanummer: u.fakturanummer,
      fakturadato: u.fakturadato,
      forfallsdato: u.forfallsdato,
      selger: { navn: "Rabatt AS", kontonr: "86011117947", mva_registrert: true },
      kunde: { navn: "Leietaker AS → avd. Øst" },
      linjer: full.linjer.map((l: any) => ({ ...l, antall: Number(l.antall), enhetspris: Number(l.enhetspris), mva_sats: Number(l.mva_sats) })),
      kommentar: full.kommentar,
    });
    expect(new TextDecoder().decode(pdf.slice(0, 5))).toBe("%PDF-");
    // … og står i e-posten med fakturaen.
    const epost = fakturaEpost(full);
    expect(epost.tekst).toContain("med forfall");
    expect(epost.tekst).toContain("\n\nTakk for handelen! 😊 → Ny adresse fra november.\n\nKontonummer:");

    // Notatet står som det ble sendt: en utstedt faktura kan ikke endres.
    const meg = (await kall("GET", "/api/meg")).data;
    const endring = await somBruker(meg.bruker.id, (db) => db.query("update faktura.fakturaer set kommentar = 'Endret' where id = $1", [f.data.id]));
    expect(endring.rowCount).toBe(0);
    expect((await kall("PUT", `/api/org/${org}/fakturaer/${f.data.id}`, { kunde_id: kunde, kommentar: "Endret", linjer })).status).toBe(409);
    expect((await hentF(f.data.id)).kommentar).toBe(full.kommentar);
  });

  it("avviser rabatt som ikke går opp", async () => {
    const feil = async (l: Record<string, unknown>) =>
      (await kall("POST", `/api/org/${org}/fakturaer`, { kunde_id: kunde, linjer: [{ beskrivelse: "Husleie", antall: 1, enhetspris: 1000, mva_sats: 25, ...l }] })).data.error;
    expect(await feil({ rabatt_prosent: 10, rabatt_belop: 50 })).toBe("Velg rabatt i prosent eller i kroner, ikke begge");
    expect(await feil({ rabatt_belop: 1000.01 })).toBe("Rabatten på «Husleie» er større enn beløpet på linjen");
    expect(await feil({ rabatt_prosent: 101 })).toBe("Rabatten kan ikke være mer enn 100 %");
    expect(await feil({ rabatt_belop: -5 })).toBe("Rabatten må være mer enn 0 kr");
    // 100 % rabatt er lov (gratis), og hele linjebeløpet i kroner også.
    const gratis = await kall("POST", `/api/org/${org}/fakturaer`, {
      kunde_id: kunde,
      linjer: [
        { beskrivelse: "Første måned gratis", antall: 1, enhetspris: 1000, mva_sats: 25, rabatt_prosent: 100 },
        { beskrivelse: "Nøkkel", antall: 1, enhetspris: 200, mva_sats: 25, rabatt_belop: 200 },
        { beskrivelse: "Depositum", antall: 1, enhetspris: 300, mva_sats: 0 },
      ],
    });
    expect(tall(await utsted(gratis.data.id))).toEqual([300, 0, 300]);
  });

  it("kreditnota: rabatten følger med, og kronerabatten fordeles så det går opp i øret", async () => {
    const f = await kall("POST", `/api/org/${org}/fakturaer`, {
      kunde_id: kunde,
      linjer: [
        { beskrivelse: "Kurs", antall: 3, enhetspris: 100, mva_sats: 25, rabatt_belop: 100 },
        { beskrivelse: "Husleie", antall: 2, enhetspris: 1000, mva_sats: 25, rabatt_prosent: 10 },
      ],
    });
    const u = await utsted(f.data.id);
    expect(tall(u)).toEqual([2000, 500, 2500]);
    const [kurs, husleie] = (await hentF(f.data.id)).linjer;

    const krediter = async (linjer: unknown) => (await kall("POST", `/api/org/${org}/fakturaer/${f.data.id}/krediter`, { linjer, send_epost: false })).data;
    const k1 = await krediter([{ linje_id: kurs.id, antall: 1 }]);
    const k2 = await krediter([{ linje_id: kurs.id, antall: 1 }]);
    const k3 = await krediter([{ linje_id: kurs.id, antall: 1 }]);
    const rabatter = [];
    for (const k of [k1, k2, k3]) rabatter.push(Number((await hentF(k.id)).linjer[0].rabatt_belop));
    expect(rabatter).toEqual([-33.33, -33.33, -33.34]);
    expect([k1, k2, k3].map((k) => Number(k.sum_eks_mva))).toEqual([-66.67, -66.67, -66.66]);

    const k4 = await krediter(null); // resten: husleien
    const linje = (await hentF(k4.id)).linjer[0];
    expect([Number(linje.antall), linje.rabatt_prosent, Number(linje.belop_eks)]).toEqual([-2, 10, -1800]);
    // Beløpet eks. mva går opp i øret; mvaen rundes per kreditnota og kan avvike med et øre.
    const etter = await hentF(f.data.id);
    expect(etter.status).toBe("kreditert");
    expect(Math.abs(Number(etter.kreditert_belop) - 2500)).toBeLessThanOrEqual(0.02);
    expect(husleie.rabatt_prosent).toBe(10);
  });

  it("produkter uten fast pris, og indeksregulering krever pris", async () => {
    const p = await kall("POST", `/api/org/${org}/produkter`, { navn: "Konsulenttime", enhet: "time" });
    expect([p.status, p.data.enhetspris]).toEqual([201, null]);
    const fast = await kall("POST", `/api/org/${org}/produkter`, { navn: "Husleie", enhetspris: 14500 });
    expect((await kall("PATCH", `/api/org/${org}/produkter/${fast.data.id}`, { enhetspris: null })).data.enhetspris).toBe(null);
    const kpi = await kall("PATCH", `/api/org/${org}/produkter/${p.data.id}`, { indeks_aktiv: true, indeks_maaned: 1, indeks_basis: "2026-01-01" });
    expect([kpi.status, kpi.data.error]).toEqual([400, "Indeksregulering krever fast pris på produktet"]);

    // Importen tar også produkter uten pris.
    const imp = await kall("POST", `/api/org/${org}/produkter/importer`, { proving: true, rader: [{ navn: "Timepris etter avtale" }, { navn: "Rar pris", enhetspris: "abc" }] });
    expect(imp.data.rader.map((r: any) => [r.status, r.grunn ?? null])).toEqual([
      ["ny", null],
      ["feil", "Prisen er ikke et tall"],
    ]);
  });

  it("fast avsender og konto på produkter", async () => {
    const konto = (await kall("POST", `/api/org/${org}/kontoer`, { navn: "Husleiekonto", kontonr: "12345678903" })).data;
    const p = await kall("POST", `/api/org/${org}/produkter`, { navn: "Husleie privat", enhetspris: 9000, avsender: "innehaver", konto_id: konto.id });
    expect([p.data.avsender, p.data.konto_id]).toEqual(["innehaver", konto.id]);
    expect((await kall("POST", `/api/org/${org}/produkter`, { navn: "Feil", enhetspris: 1, avsender: "naboen" })).status).toBe(400);
    expect((await kall("PATCH", `/api/org/${org}/produkter/${p.data.id}`, { avsender: null })).data.avsender).toBe(null);
    // Slettes kontoen, er produktet uten fast konto.
    expect((await kall("DELETE", `/api/org/${org}/kontoer/${konto.id}`)).status).toBe(204);
    expect((await kall("GET", `/api/org/${org}/produkter/${p.data.id}`)).data.konto_id).toBe(null);
  });

  it("notat og rabatt i gjentakende fakturaer og flere på én gang", async () => {
    const g = await kall("POST", `/api/org/${org}/gjentakelser`, {
      kunde_id: kunde,
      linjer: [{ beskrivelse: "Husleie", antall: 1, enhetspris: 10000, mva_sats: 0, rabatt_prosent: 5 }],
      intervall: "maaned",
      forfall_dag: 1,
      neste_forfall: "2026-11-01",
      kommentar: "Husleien reguleres i januar.",
    });
    expect(g.status).toBe(201);
    const f = await kall("POST", `/api/org/${org}/gjentakelser/${g.data.id}/kjor`);
    expect(f.status).toBe(201);
    const fra = await hentF(f.data.id);
    expect([fra.kommentar, Number(fra.sum_inkl_mva), fra.linjer[0].rabatt_prosent]).toEqual(["Husleien reguleres i januar.", 9500, 5]);

    const r = await kall("POST", `/api/org/${org}/fakturaer/flere`, {
      kommentar: "Felles beskjed",
      avsender: "firma",
      fakturaer: [
        { kunde_id: kunde, linjer: [{ beskrivelse: "A", antall: 1, enhetspris: 100, mva_sats: 25, rabatt_belop: 20 }] },
        { kunde_id: kunde, avsender: "innehaver", kommentar: "Egen beskjed", linjer: [{ beskrivelse: "B", antall: 1, enhetspris: 100, mva_sats: 25 }] },
        { kunde_id: kunde, avsender: null, kommentar: null, linjer: [{ beskrivelse: "C", antall: 1, enhetspris: 100, mva_sats: 25 }] },
      ],
    });
    expect(r.status).toBe(201);
    const fs = await Promise.all(r.data.fakturaer.map((x: any) => hentF(x.id)));
    expect(fs.map((x) => [x.avsender, x.kommentar, Number(x.linjer[0].rabatt_belop ?? 0)])).toEqual([
      ["firma", "Felles beskjed", 20],
      ["innehaver", "Egen beskjed", 0],
      [null, null, 0],
    ]);
    expect(Number(r.data.fakturaer[0].sum_inkl_mva)).toBe(100);
    // Fakturaen fra gjentakelsen arver notatet også når den lages av workeren.
    const neste = await somSystem((db) => en(db, "select faktura.lag_fra_gjentakelse($1) as id", [g.data.id]));
    expect((await hentF(neste!.id)).kommentar).toBe("Husleien reguleres i januar.");
  });
});
