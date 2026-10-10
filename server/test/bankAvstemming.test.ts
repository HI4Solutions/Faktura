// Avstemmingen av banken (bankAvstemming.ts, regnskapBank.ts, bankRapporter.ts, 0091_bankposter.sql):
// bankpostene (inn og ut) fra hentingen, med tilbakehenting fra startdatoen; reglene som fører dem
// (innbetalingen på fakturaen, kvitteringen betalt med kort, leverandørfakturaen med KID-en,
// nettolønnen, forskuddstrekket, arbeidsgiveravgiften, overføringen til sparekontoen, gebyret og
// rentene); det brukeren gjør (før på en konto og lær motparten, ikke en fakturabetaling, angre og
// godta forslaget); startdatoen; avstemmingen per konto; rapportene; og tilgangen.
import { beforeAll, describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { config } from "../src/config.js";
import { lagApi } from "../src/api.js";
import { alle, en, somSystem } from "../src/db.js";
import { settKryptering } from "../src/kryptering.js";
import { rentKontonr, settBankFetch, tilBankposter, tilInnbetalinger } from "../src/enableBanking.js";
import { hentInnbetalinger } from "../src/bank.js";
import { avstemBankForAlle, sisteTermin } from "../src/bankAvstemming.js";
import { bokforSalgForAlle } from "../src/salgBokforing.js";
import { settLokalOppgavekjorer } from "../src/tjenester.js";

const { privateKey: privat } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
const osloDag = (n = 0) => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Oslo" }).format(new Date(Date.now() + n * 86400_000));

describe("bankpostene fra banken", () => {
  it("tilBankposter: inn og ut, samme id som innbetalingene, motparten og saldoen", () => {
    const rader = [
      {
        entry_reference: "e1",
        transaction_amount: { amount: "1000.00", currency: "NOK" },
        credit_debit_indicator: "CRDT",
        status: "BOOK",
        booking_date: "2026-09-20",
        debtor: { name: "KARI HANSEN" },
        debtor_account: { iban: "NO93 8601 1117 947" },
        remittance_information: ["Faktura 1"],
      },
      { transaction_amount: { amount: "45.00", currency: "NOK" }, credit_debit_indicator: "DBIT", status: "BOOK", booking_date: "2026-09-21", remittance_information: ["Gebyr"], balance_after_transaction: { amount: "955.00", currency: "NOK" } },
      { transaction_amount: { amount: "45.00", currency: "NOK" }, credit_debit_indicator: "DBIT", status: "BOOK", booking_date: "2026-09-21", remittance_information: ["Gebyr"] },
      {
        entry_reference: "e3",
        transaction_amount: { amount: "1250.00", currency: "NOK" },
        credit_debit_indicator: "DBIT",
        status: "BOOK",
        booking_date: "2026-09-24",
        creditor: { name: "TELENOR NORGE AS" },
        creditor_account: { bban: "9710.05.12347" },
        reference_number: "1234567890",
      },
      { entry_reference: "r1", transaction_amount: { amount: "300.00", currency: "NOK" }, credit_debit_indicator: "DBIT", status: "PDNG", transaction_date: "2026-09-25" },
    ];
    const p = tilBankposter(rader);
    expect(p.map((x) => [x.dato, x.belop, x.motpart, x.motpart_konto, x.referanse, x.saldo])).toEqual([
      ["2026-09-20", 1000, "KARI HANSEN", "86011117947", null, null],
      ["2026-09-21", -45, null, null, null, 955],
      ["2026-09-21", -45, null, null, null, null],
      ["2026-09-24", -1250, "TELENOR NORGE AS", "97100512347", "1234567890", null],
    ]);
    // Innbetalingen har samme id som blant innbetalingene; like utbetalinger samme dag nummereres.
    expect(p[0]!.ekstern_id).toBe(tilInnbetalinger(rader)[0]!.ekstern_id);
    expect(p[1]!.ekstern_id).toMatch(/^fu:.+:1$/);
    expect(p[2]!.ekstern_id).toBe(p[1]!.ekstern_id.replace(/:1$/, ":2"));
    expect(rentKontonr("NO93 8601 1117 947")).toBe("86011117947");
    expect(rentKontonr("DE89 3704 0044 0532 0130 00")).toBe("DE89370400440532013000");
    expect(rentKontonr(" ")).toBe(null);
  });

  it("terminen for arbeidsgiveravgiften som sist er avsluttet", () => {
    expect(sisteTermin("2026-09-14")).toEqual({ fra: "2026-07-01", til: "2026-08-31", navn: "juli–august 2026" });
    expect(sisteTermin("2026-10-05")).toMatchObject({ fra: "2026-07-01", til: "2026-08-31" });
    expect(sisteTermin("2026-01-15")).toMatchObject({ fra: "2025-11-01", til: "2025-12-31" });
    expect(sisteTermin("2026-02-10")).toMatchObject({ fra: "2025-11-01", til: "2025-12-31" });
    expect(sisteTermin("2026-03-15")).toMatchObject({ fra: "2026-01-01", til: "2026-02-28" });
  });
});

describe.skipIf(!process.env.DATABASE_URL)("avstemmingen av banken i appen", () => {
  const app = lagApi();
  const eier = "Bearer test:uid-bavst-eier:bavst-eier@server.test:mfa";
  const fakturerer = "Bearer test:uid-bavst-fakt:bavst-fakt@server.test:mfa";
  const KID_SKATT = "0012345678905260917";
  const kall: string[] = [];
  const transaksjoner: Record<string, any[]> = {};
  let org: string;
  let utbetaling: string;
  let trekkdato: string;
  let telenor: string;
  let kvittering: string;

  const json = (status: number, data: unknown) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
  const api = async (m: string, sti: string, b?: unknown, hvem = eier) => {
    const r = await app.request(sti, { method: m, headers: { authorization: hvem, "content-type": "application/json" }, body: b === undefined ? undefined : JSON.stringify(b) });
    return { status: r.status, data: (r.headers.get("content-type") ?? "").includes("json") ? ((await r.json()) as any) : await r.text() };
  };
  const o = (x: string) => `/api/org/${org}${x}`;
  const post = (ekstern: string) =>
    somSystem((db) =>
      en<any>(
        db,
        `select p.id, p.status, p.regel, p.auto, p.forslag, p.belop::float8 as belop, b.serie || '-' || b.aar || '-' || b.nummer as bilag, b.id as bilag_id,
                (select string_agg(x.konto || ':' || x.belop, ',' order by x.rekke) from faktura.posteringer x where x.bilag_id = b.id) as poster
           from faktura.bankposter p left join faktura.bilag b on b.id = p.bilag_id where p.org_id = $1 and p.ekstern_id = $2`,
        [org, ekstern],
      ),
    );
  const avstem = () => avstemBankForAlle(5, org);
  const ut = (id: string, belop: number, dato: string, x: Record<string, unknown> = {}) => ({
    entry_reference: id,
    transaction_amount: { amount: belop.toFixed(2), currency: "NOK" },
    credit_debit_indicator: "DBIT",
    status: "BOOK",
    booking_date: dato,
    ...x,
  });
  const inn = (id: string, belop: number, dato: string, x: Record<string, unknown> = {}) => ({ ...ut(id, belop, dato, x), credit_debit_indicator: "CRDT" });

  beforeAll(async () => {
    (config as any).enableBankingUrl = "https://eb.test";
    settKryptering(async (t) => Buffer.from(`kryptert:${t}`), async (d) => d.toString().replace(/^kryptert:/, ""));
    settLokalOppgavekjorer(async () => {});
    settBankFetch(async (url) => {
      const u = new URL(String(url));
      kall.push(u.pathname + u.search);
      const m = u.pathname.match(/^\/accounts\/([^/]+)\/transactions$/);
      if (m) return json(200, { transactions: u.search.includes("transaction_status") ? [] : (transaksjoner[m[1]!] ?? []) });
      throw new Error(`Uventet kall til Enable Banking: ${u.pathname}`);
    });

    org = (await api("POST", "/api/organisasjoner", { navn: "Bankavstemming AS" })).data.id;
    expect((await api("PATCH", o(""), { kontonr: "86011117947", mva_registrert: true })).status).toBe(200);
    expect((await api("POST", o("/kontoer"), { navn: "Sparekonto", kontonr: "15035656267" })).status).toBe(201);
    // Innbetalingene fra 1. september; bankpostene føres fra samme dag, sparekontoen på 1921.
    expect((await api("PUT", o("/bank/fra"), { fra: "2026-09-01" })).status).toBe(200);
    const r = await api("PUT", o("/regnskap/oppsett"), { bank_fra: "2026-09-01", bankkontoer: { "15035656267": "1921" } });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data).toMatchObject({ bank_fra: "2026-09-01", bank_auto: true, bankkontoer: { "15035656267": "1921" } });
    expect(r.data.kontoer.find((k: any) => k.rolle === "bankgebyr")).toMatchObject({ konto: "7770", navn: "Bank- og kortgebyrer" });

    // Lønnen for september (nettolønnen som skyldig lønn), med Skatteetatens kontonummer og KID-en.
    expect((await api("PUT", o("/lonn-oppsett"), { aktiv: true, skatt_kontonr: "63450635008" })).status).toBe(200);
    const a = await api("POST", o("/ansatte"), { fornavn: "Kari", etternavn: "Bank", ansatt_fra: "2025-01-01", lonnstype: "maaned", maanedslonn: 50000, skattekort: "prosent", skatt_prosent: 30 });
    expect(a.status, JSON.stringify(a.data)).toBe(201);
    const k = (await api("POST", o("/lonn/kjoringer"), { periode: "2026-09" })).data;
    expect((await api("PUT", o(`/lonn/kjoringer/${k.id}/forskuddstrekk-kid`), { kid: KID_SKATT })).status).toBe(200);
    expect((await api("POST", o(`/lonn/kjoringer/${k.id}/godkjenn`))).status).toBe(200);
    const b = (await api("GET", o(`/lonn/kjoringer/${k.id}/betalinger`))).data;
    utbetaling = b.lonn.dato;
    trekkdato = b.trekkdato;
    expect(b.lonn.sum).toBe(35000);
    expect(b.forskuddstrekk).toMatchObject({ belop: 15000, kid: KID_SKATT, kontonr: "63450635008", rolle: "forskuddstrekk" });

    // En faktura til Kari Hansen på 1 000 kr.
    const kunde = (await api("POST", o("/kunder"), { navn: "Kari Hansen", type: "person", epost: "kari@hansen.no" })).data.id;
    const f = (await api("POST", o("/fakturaer"), { kunde_id: kunde, linjer: [{ beskrivelse: "Konsultasjon", antall: 1, enhet: "stk", enhetspris: 800, mva_sats: 25 }] })).data;
    expect((await api("POST", o(`/fakturaer/${f.id}/utsted`), { send_epost: false })).data.fakturanummer).toBe(1);

    // Telenor-fakturaen (ubetalt, med KID) og en kvittering betalt med kort.
    telenor = (
      await api("POST", o("/regnskap/utgifter"), {
        type: "faktura",
        leverandor: "Telenor Norge AS",
        orgnr: "976967631",
        dato: "2026-09-10",
        forfallsdato: "2026-09-24",
        kid: "1234567890",
        kontonr: "97100512347",
        belop: 1250,
        linjer: [{ kategori: "telefon", konto: "6900", belop: 1000, mva_sats: 25, mva: 250 }],
      })
    ).data.id;
    expect((await api("POST", o(`/regnskap/utgifter/${telenor}/bokfor`))).status).toBe(200);
    kvittering = (
      await api("POST", o("/regnskap/utgifter"), {
        type: "kvittering",
        leverandor: "Clas Ohlson AS",
        dato: "2026-09-24",
        belop: 499,
        betaling: "bank",
        linjer: [{ kategori: "forbruk", konto: "6560", belop: 399.2, mva_sats: 25, mva: 99.8 }],
      })
    ).data.id;
    expect((await api("POST", o(`/regnskap/utgifter/${kvittering}/bokfor`))).status).toBe(200);

    // Banken: DNB med driftskontoen og sparekontoen, hentet til 5. oktober før.
    await somSystem(async (db) => {
      await db.query("insert into faktura.integrasjoner (org_id, type, status, konfig, hemmelighet_kryptert) values ($1, 'bank', 'aktiv', $2, $3)", [
        org,
        { leverandor: "enablebanking", app_id: "app-1" },
        Buffer.from(`kryptert:${privat}`),
      ]);
      const kb = await en<{ id: string }>(db, "insert into faktura.bankkoblinger (org_id, bank, psu_type, status) values ($1, 'DNB', 'business', 'aktiv') returning id", [org]);
      await db.query("update faktura.bankkoblinger set okt_id = 's-1', kontoer = $2, gyldig_til = now() + interval '90 days', hent_fra = '2026-10-05' where id = $1", [
        kb!.id,
        JSON.stringify([
          { uid: "k-drift", kontonr: "86011117947", navn: "Driftskonto" },
          { uid: "k-spare", kontonr: "15035656267", navn: "Sparekonto" },
        ]),
      ]);
    });

    const skatt = { creditor: { name: "SKATTEETATEN" }, creditor_account: { bban: "63450635008" } };
    const ola = { creditor: { name: "OLA EIER" }, creditor_account: { bban: "12345678903" }, remittance_information: ["Lån"] };
    transaksjoner["k-drift"] = [
      ut("lonn", 35000, utbetaling, { remittance_information: ["Lønn september 2026"] }),
      inn("kari", 1000, "2026-09-20", { debtor: { name: "KARI HANSEN" }, remittance_information: ["Faktura 1"] }),
      ut("gebyr", 45, "2026-09-21", { remittance_information: ["Gebyr nettbank"] }),
      ut("skatt", 15000, trekkdato, { ...skatt, reference_number: KID_SKATT }),
      inn("renter", 12.34, "2026-09-22", { remittance_information: ["Kreditrenter"] }),
      ut("telenor", 1250, "2026-09-24", { creditor: { name: "TELENOR NORGE AS" }, creditor_account: { bban: "97100512347" }, reference_number: "1234567890" }),
      ut("clas", 499, "2026-09-25", { creditor: { name: "CLAS OHLSON AS" }, remittance_information: ["Varekjøp"] }),
      ut("spar", 10000, "2026-09-26", { creditor_account: { iban: "NO0215035656267" }, remittance_information: ["Til sparekonto"] }),
      ut("ola-1", 2000, "2026-09-28", ola),
      ut("ola-2", 2000, "2026-10-02", ola),
      ut("aga", 7191, "2026-10-05", { ...skatt, remittance_information: ["Arbeidsgiveravgift"], balance_after_transaction: { amount: "28027.34", currency: "NOK" } }),
      inn("per", 777, "2026-10-06", { debtor: { name: "PER OLSEN" }, remittance_information: ["Takk for hjelpen"], balance_after_transaction: { amount: "28804.34", currency: "NOK" } }),
    ];
    transaksjoner["k-spare"] = [inn("spar-inn", 10000, "2026-09-26", { debtor_account: { iban: "NO9386011117947" }, remittance_information: ["Fra driftskonto"] })];
  });

  it("hentingen lagrer bankpostene inn og ut, og henter dem fra startdatoen den første gangen", async () => {
    const for_ = kall.length;
    await hentInnbetalinger(org);
    const fra = "2026-09-01" > osloDag(-89) ? "2026-09-01" : osloDag(-89);
    expect(kall.slice(for_)).toEqual([`/accounts/k-drift/transactions?date_from=${fra}`, `/accounts/k-spare/transactions?date_from=${fra}`]);
    const lagret = await somSystem((db) => alle<any>(db, "select konto, ekstern_id, belop::float8 as belop, status from faktura.bankposter where org_id = $1 order by konto, dato, ekstern_id", [org]));
    expect(lagret).toHaveLength(13);
    expect(lagret.every((p) => p.status === "ny")).toBe(true);
    expect(lagret.find((p) => p.ekstern_id === "spar-inn")).toMatchObject({ konto: "15035656267", belop: 10000 });
    // Innbetalingen er registrert på fakturaen som før (samme id som bankposten).
    expect(await somSystem((db) => en<any>(db, "select status from faktura.banktransaksjoner where org_id = $1 and ekstern_id = 'kari'", [org]))).toEqual({ status: "koblet" });
    // Neste gang hentes bare de siste dagene.
    const for2 = kall.length;
    await hentInnbetalinger(org);
    expect(kall.slice(for2)[0]).toMatch(/date_from=\d{4}-\d{2}-\d{2}$/);
    expect(kall.slice(for2)[0]).not.toContain(`date_from=${fra}`);
    expect(await somSystem((db) => alle(db, "select konto, to_char(hentet_fra, 'YYYY-MM-DD') as fra from faktura.bankpost_kontoer where org_id = $1 order by konto", [org]))).toEqual([
      { konto: "15035656267", fra },
      { konto: "86011117947", fra },
    ]);
  });

  it("reglene fører det de er sikre på, og resten blir uavklart", async () => {
    await avstem();
    // Nettolønnen (skyldig lønn), forskuddstrekket med KID-en og arbeidsgiveravgiften som står på 2770.
    expect(await post("lonn")).toMatchObject({ status: "avstemt", regel: "Nettolønnen for september 2026 (1 ansatt)", poster: "1920:-35000.00,2930:35000.00" });
    expect(await post("skatt")).toMatchObject({ status: "avstemt", regel: `Forskuddstrekket for september 2026 (KID ${KID_SKATT})`, poster: "1920:-15000.00,2600:15000.00" });
    expect(await post("aga")).toMatchObject({ status: "avstemt", regel: "Arbeidsgiveravgiften som står på 2770", poster: "1920:-7191.00,2770:7191.00" });
    // Gebyret og rentene fra banken; renteinntekten var ikke en fakturabetaling.
    expect(await post("gebyr")).toMatchObject({ status: "avstemt", regel: "Gebyr fra banken", poster: "1920:-45.00,7770:45.00" });
    expect(await post("renter")).toMatchObject({ status: "avstemt", regel: "Renter fra banken", poster: "1920:12.34,8050:-12.34" });
    expect(await somSystem((db) => en<any>(db, "select status from faktura.banktransaksjoner where org_id = $1 and ekstern_id = 'renter'", [org]))).toEqual({ status: "ignorert" });
    // Telenor-fakturaen med KID-en betales (serie U), og kvitteringen betalt med kort kobles.
    expect(await post("telenor")).toMatchObject({ status: "avstemt", regel: "KID 1234567890 på fakturaen fra Telenor Norge AS", poster: "2400:1250.00,1920:-1250.00" });
    expect((await api("GET", o(`/regnskap/utgifter/${telenor}`))).data).toMatchObject({ betaling: "bank", betalt_dato: "2026-09-24" });
    const clas = await post("clas");
    expect(clas).toMatchObject({ status: "avstemt", bilag: "U-2026-2" });
    expect(clas.regel).toMatch(/^Samme beløp som bilag U-2026-2 /);
    // Overføringen til sparekontoen (1921): ett bilag for begge postene.
    const spar = await post("spar");
    expect(spar).toMatchObject({ status: "avstemt", regel: "Overføring til egen konto 1503.56.56267", poster: "1920:-10000.00,1921:10000.00" });
    expect((await post("spar-inn")).bilag_id).toBe(spar.bilag_id);
    expect(await somSystem((db) => en<any>(db, "select status from faktura.banktransaksjoner where org_id = $1 and ekstern_id = 'spar-inn'", [org]))).toEqual({ status: "ignorert" });
    // Innbetalingen på fakturaen venter på at salget bokføres; lånet og gaven er uavklart.
    expect(await post("kari")).toMatchObject({ status: "ny", regel: "Venter på at innbetalingen bokføres." });
    expect(await post("ola-1")).toMatchObject({ status: "uavklart", regel: "Last opp kvitteringen eller fakturaen under Utgifter, eller velg kontoen." });
    expect((await post("per")).status).toBe("uavklart");
    expect((await post("per")).regel).toContain("Fakturaer → Innbetalinger");
    // Salget bokføres, og innbetalingen kobles til bilaget for den.
    await bokforSalgForAlle(25, org);
    await avstem();
    expect(await post("kari")).toMatchObject({ status: "avstemt", regel: "Innbetaling på faktura 1", poster: "1920:1000.00,1500:-1000.00" });
  });

  it("det brukeren gjør: før på en konto og lær motparten, ikke en fakturabetaling", async () => {
    const ola1 = await post("ola-1");
    expect((await api("POST", o(`/regnskap/bank/${ola1.id}/konto`), { konto: "1920" })).data.error).toBe("Velg en annen konto enn bankkontoen (1920)");
    const r = await api("POST", o(`/regnskap/bank/${ola1.id}/konto`), { konto: "1570", tekst: "Lån til Ola Eier", husk: true });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data).toMatchObject({ status: "avstemt", regel: "Ført på 1570; neste gang av seg selv", av_seg_selv: false });
    expect((await post("ola-1")).poster).toBe("1920:-2000.00,1570:2000.00");
    expect((await api("GET", o("/regnskap/bank/regler"))).data).toEqual([expect.objectContaining({ retning: "ut", motpart_konto: "12345678903", motpart: null, konto: "1570", tekst: "Lån til Ola Eier" })]);
    // Neste betaling til samme konto føres av seg selv.
    const ola2 = await post("ola-2");
    expect((await api("POST", o(`/regnskap/bank/${ola2.id}/vurder`))).data.status).toBe("ny");
    await avstem();
    expect(await post("ola-2")).toMatchObject({ status: "avstemt", regel: "Lært: OLA EIER føres på 1570", poster: "1920:-2000.00,1570:2000.00" });

    // Gaven er ikke en fakturabetaling: den tas bort fra Innbetalinger og vurderes på nytt.
    const per = await post("per");
    expect((await api("POST", o(`/regnskap/bank/${per.id}/ikke-faktura`))).status).toBe(200);
    expect(await somSystem((db) => en<any>(db, "select status from faktura.banktransaksjoner where org_id = $1 and ekstern_id = 'per'", [org]))).toEqual({ status: "ignorert" });
    await avstem();
    expect(await post("per")).toMatchObject({ status: "uavklart", regel: "Velg kontoen (f.eks. innskudd fra eier, et lån eller en refusjon)." });
    expect((await api("POST", o(`/regnskap/bank/${per.id}/konto`), { konto: "3900", tekst: "Gave" })).data.status).toBe("avstemt");
    expect((await post("per")).poster).toBe("1920:777.00,3900:-777.00");
  });

  it("oversikten: avstemmingen per konto, postene og det en post kan kobles til", async () => {
    const d = (await api("GET", o("/regnskap/bank?maaned=2026-09"))).data;
    expect(d).toMatchObject({ maaned: "2026-09", bank_fra: "2026-09-01", auto: true, apne: 0 });
    expect(d.poster.filter((p: any) => p.dato.startsWith("2026-09"))).toHaveLength(10);
    const drift = d.kontoer.find((k: any) => k.konto === "86011117947");
    // Saldoen i banken etter den siste posten; den inngående saldoen (100 000) er ikke ført.
    expect(drift).toMatchObject({
      vis: "8601.11.17947",
      navn: "Kontoen på fakturaene",
      regnskapskonto: "1920",
      delt: false,
      dato: "2026-10-06",
      saldo: 28804.34,
      regnskap: -71195.66,
      apne: { antall: 0, sum: 0 },
      uten_post: { antall: 0, sum: 0 },
      differanse: 100000,
    });
    expect(d.kontoer.find((k: any) => k.konto === "15035656267")).toMatchObject({ navn: "Sparekonto", regnskapskonto: "1921", saldo: null, regnskap: 10000, differanse: null });
    // Den inngående saldoen føres som et manuelt bilag før startdatoen: avstemt.
    const m = await api("POST", o("/regnskap/bilag"), {
      dato: "2026-08-31",
      tekst: "Inngående saldo bank",
      linjer: [
        { konto: "1920", debet: 100000 },
        { konto: "2050", kredit: 100000 },
      ],
    });
    expect(m.status, JSON.stringify(m.data)).toBe(201);
    expect((await api("GET", o("/regnskap/bank"))).data.kontoer.find((k: any) => k.konto === "86011117947")).toMatchObject({ regnskap: 28804.34, differanse: 0 });
    // Detaljen: de ubetalte utgiftene og bilagene på bankkontoen med beløp som ikke er koblet.
    const telenorPost = await post("telenor");
    const x = (await api("GET", o(`/regnskap/bank/${telenorPost.id}`))).data;
    expect(x).toMatchObject({ regnskapskonto: "1920", status: "avstemt", bilagsnummer: "U-2026-3", innbetaling: null });
    expect(x.kandidater.utgifter).toEqual([]);
  });

  it("angre: betalingen av utgiften angres, og reglene foreslår den bare etterpå", async () => {
    const p = await post("telenor");
    const r = await api("POST", o(`/regnskap/bank/${p.id}/angre`));
    expect(r.data).toMatchObject({ status: "uavklart", auto: false, regel: "Angret. Velg hvordan den skal føres." });
    expect((await api("GET", o(`/regnskap/utgifter/${telenor}`))).data).toMatchObject({ betaling: "ubetalt", betalt_dato: null });
    const d = (await api("GET", o(`/regnskap/bank/${p.id}`))).data;
    expect(d.kandidater.utgifter).toEqual([expect.objectContaining({ id: telenor, belop: 1250, kid: "1234567890" })]);
    expect((await api("POST", o(`/regnskap/bank/${p.id}/vurder`))).data.status).toBe("ny");
    await avstem();
    const f = await post("telenor");
    expect(f).toMatchObject({ status: "forslag", regel: "KID 1234567890 på fakturaen fra Telenor Norge AS" });
    expect(f.forslag).toMatchObject({ type: "utgift", utgift_id: telenor });
    const g = await api("POST", o(`/regnskap/bank/${p.id}/godta`));
    expect(g.data).toMatchObject({ status: "avstemt", av_seg_selv: false });
    expect((await api("GET", o(`/regnskap/utgifter/${telenor}`))).data).toMatchObject({ betaling: "bank", betalt_dato: "2026-09-24" });
    expect((await api("POST", o(`/regnskap/bank/${p.id}/godta`))).status).toBe(409);
  });

  it("startdatoen: flyttes den fram, angres det som er ført før; flyttes den tilbake, føres det igjen", async () => {
    expect((await api("PUT", o("/regnskap/oppsett"), { bank_fra: "2026-09-23" })).status).toBe(200);
    for (const e of ["lonn", "kari", "gebyr", "skatt", "renter"]) expect((await post(e)).status, e).toBe("ny");
    const d = (await api("GET", o("/regnskap/bank?maaned=2026-09"))).data;
    expect(d.poster.filter((p: any) => p.for_start).map((p: any) => p.ekstern_id).sort()).toEqual(["gebyr", "kari", "lonn", "renter", "skatt"]);
    expect(d.apne).toBe(0);
    // Bilagene i serie B er reversert; innbetalingsbilaget står (salget fører det).
    expect(await somSystem((db) => en<any>(db, "select count(*)::int as n from faktura.bilag where org_id = $1 and kilde = 'bank' and reverserer is not null", [org]))).toEqual({ n: 4 });
    await avstem();
    expect((await post("gebyr")).status).toBe("ny");
    expect((await api("PUT", o("/regnskap/oppsett"), { bank_fra: "2026-09-01" })).status).toBe(200);
    await avstem();
    for (const e of ["lonn", "kari", "gebyr", "skatt", "renter"]) expect((await post(e)).status, e).toBe("avstemt");
    expect((await post("gebyr")).poster).toBe("1920:-45.00,7770:45.00");
  });

  it("uten automatikk blir alt forslag", async () => {
    expect((await api("PUT", o("/regnskap/oppsett"), { bank_auto: false })).status).toBe(200);
    await somSystem((db) =>
      db.query("insert into faktura.bankposter (org_id, konto, ekstern_id, dato, belop, melding) values ($1, '86011117947', 'gebyr-2', '2026-10-07', -45, 'Gebyr')", [org]),
    );
    await avstem();
    const p = await post("gebyr-2");
    expect(p).toMatchObject({ status: "forslag", regel: "Gebyr fra banken" });
    expect((await api("POST", o(`/regnskap/bank/${p.id}/godta`))).data.status).toBe("avstemt");
    expect((await api("PUT", o("/regnskap/oppsett"), { bank_auto: true })).status).toBe(200);
  });

  it("rapportene: bankavstemmingen og bankpostene", async () => {
    const a = (await api("GET", o("/rapportmodul/regnskap.bankavstemming?fra=2026-10-01&til=2026-10-31"))).data;
    expect(a.merknad).toContain("8601.11.17947 (konto 1920) 31.10.2026: 28 759,34 kr i banken, 28 759,34 kr i regnskapet;");
    expect(a.merknad).toContain("differanse 0,00 kr.");
    expect(a.rader).toEqual([]);
    const b = (await api("GET", o("/rapportmodul/regnskap.bankposter?fra=2026-09-01&til=2026-09-30"))).data;
    expect(b.rader).toHaveLength(10);
    expect(b.merknad).toBe("10 bankposter i perioden: 10 er ført (8 av seg selv), 0 må avklares under Regnskap → Bank.");
    expect(b.rader.find((r: any) => r.motpart === "OLA EIER")).toMatchObject({ belop: -2000, status: "Ført", regel: "Ført på 1570; neste gang av seg selv" });
  });

  it("fakturerer ser ikke banken i regnskapet", async () => {
    const inv = await api("POST", o("/invitasjoner"), { epost: "bavst-fakt@server.test", rolle: "fakturerer" });
    expect((await api("POST", "/api/invitasjoner/aksepter", { token: inv.data.lenke.split("/").pop() }, fakturerer)).status).toBe(200);
    expect((await api("GET", o("/regnskap/bank"), undefined, fakturerer)).status).toBe(403);
    const p = await post("gebyr");
    expect((await api("POST", o(`/regnskap/bank/${p.id}/angre`), undefined, fakturerer)).status).toBe(403);
  });
});
