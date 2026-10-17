// Årsregnskapet til Regnskapsregisteret (aarsregnskap.ts, aarsregnskapXml.ts, 0120_aarsregnskap.sql):
// postene etter kontoplanen (hver konto i én post), øreavrundingen, skjemaene validert mot
// Brønnøysunds XSD-er (når xmllint finnes), oppstillingen fra regnskapet med fjoråret og
// årsoppgjøret, fjorårstall for hånd, notene, kontrollene og tilgangen.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { lagApi } from "../src/api.js";
import { BALANSE, POSTER, RESULTAT, _test, glemEnhet } from "../src/aarsregnskap.js";
import { FELTNOKLER, POSTNOKLER, hovedskjemaXml, underskjemaXml } from "../src/aarsregnskapXml.js";
import type { Enhet } from "../src/brreg.js";
import { ApiFeil } from "../src/feil.js";
import { settLokalOppgavekjorer } from "../src/tjenester.js";
import { settBrreg } from "../src/verifisering.js";

const her = path.dirname(fileURLToPath(import.meta.url));
const harXmllint = spawnSync("xmllint", ["--version"]).status === 0;
function valider(xml: string, skjema: "hovedskjema_1266_51820" | "underskjema_758_51980") {
  if (!harXmllint) return;
  const fil = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aarsregnskap-")), "skjema.xml");
  fs.writeFileSync(fil, xml);
  execFileSync("xmllint", ["--noout", "--schema", path.join(her, "xsd", `aarsregnskap_${skjema}.xsd`), fil], { stdio: "pipe" });
}

type Def = (typeof RESULTAT)[number];
const poster = (defs: Def[]) => defs.filter((d): d is Def & { t: "p" } => d.t === "p");
const dekker = (d: Def & { t: "p" }, konto: string) => d.kontoer.some(([a, b]) => konto >= a && konto <= b);

describe("årsregnskapet uten database", () => {
  it("hver konto havner i én post (8400–8799 i ingen), og postene finnes i skjemaet", () => {
    for (let k = 1000; k <= 8999; k++) {
      const konto = String(k);
      if (k >= 3000) {
        // Konsernbidraget er to poster etter saldoen (mottatt og avgitt).
        const n = poster(RESULTAT).filter((d) => dekker(d, konto) && d.nokkel !== "avgittKonsernbidrag").length;
        expect(n, `resultatet, konto ${konto}`).toBe(k >= 8400 && k <= 8799 ? 0 : 1);
      }
      expect(poster(BALANSE).filter((d) => dekker(d, konto)).length, `balansen, konto ${konto}`).toBe(1);
    }
    const nokler = [...RESULTAT, ...BALANSE].filter((d) => d.t !== "o").map((d) => (d as { nokkel: string }).nokkel);
    expect(new Set(nokler).size).toBe(nokler.length);
    expect([...POSTNOKLER].sort()).toEqual([...nokler].sort());
    expect(POSTER).toContain("salgsinntekt");
    expect(POSTER).not.toContain("sumEiendeler");
  });

  it("øreavrundingen føres mot annen egenkapital og overføringene, så summene går opp", () => {
    // Bank 100,40 + fordringer 100,40 = 200,80 (201 i hele kroner), men postene blir 100 + 100.
    const k = _test.kolonne(BALANSE, new Map([["1920", 100.4], ["1500", 100.4], ["2000", -150], ["2050", -50.8]]));
    expect([k.v.bankinnskudd, k.v.kundefordringer, k.v.sumEiendeler, k.v.selskapskapital, k.v.annenEgenkapital, k.v.sumEgenkapitalGjeld]).toEqual([
      100, 100, 200, 150, 51, 201,
    ]);
    _test.avrund(BALANSE, k, "sumEiendeler", "sumEgenkapitalGjeld", "annenEgenkapital");
    expect([k.v.annenEgenkapital, k.v.sumEgenkapital, k.v.sumEgenkapitalGjeld]).toEqual([50, 200, 200]);
    // Går ikke summene opp før avrundingen, endres ingenting (kontrollene sier fra).
    const skjev = _test.kolonne(BALANSE, new Map([["1920", 100], ["2000", -90]]));
    _test.avrund(BALANSE, skjev, "sumEiendeler", "sumEgenkapitalGjeld", "annenEgenkapital");
    expect([skjev.v.sumEiendeler, skjev.v.sumEgenkapitalGjeld]).toEqual([100, 90]);
    // Konsernbidraget etter saldoen, og fortegnene i resultatet.
    const r = _test.kolonne(RESULTAT, new Map([["3000", -1000], ["6300", 400], ["8940", -100], ["8960", 700]]));
    expect([r.v.salgsinntekt, r.v.annenDriftskostnad, r.v.aarsresultat, r.v.konsernbidrag, r.v.avgittKonsernbidrag, r.v.sumOverfoeringer]).toEqual([
      1000, 400, 600, 100, 0, 600,
    ]);
  });

  it("skjemaene validerer mot Brønnøysunds XSD-er, med alle postene og notene og med bare det påkrevde", () => {
    const alle = Object.fromEntries([...POSTNOKLER].map((k, i) => [k, { aarets: i * 1000 - 5000, fjor: -i }]));
    const felt = Object.fromEntries([...FELTNOKLER].map((k) => [k, k === "usikkerhetDrift" ? "true" : /lonn|aga|pensjon|ytelser|laan|sikkerhet|gjeld|pant|garanti/i.test(k) && !/Tekst/.test(k) ? 1000 : "Tekst & <mer> «æøå»"]));
    felt.renteStyret = "4,5";
    felt.renteAndre = "5";
    felt.aarsverk = "1.5";
    const under = underskjemaXml({ poster: alle, harFjor: true, felt });
    expect(under).toContain('<salgsinntekt><aarets orid="1340">');
    expect(under).toContain("Tekst &amp; &lt;mer&gt; «æøå»");
    valider(under, "underskjema_758_51980");
    const tom = underskjemaXml({ poster: { aarsresultat: { aarets: 0, fjor: 0 }, sumEiendeler: { aarets: 0, fjor: 0 }, sumEgenkapitalGjeld: { aarets: 0, fjor: 0 } }, harFjor: false, felt: {} });
    expect(tom).not.toContain("fjoraarets");
    expect(tom).not.toContain("<noter>");
    valider(tom, "underskjema_758_51980");
    const hoved = (organisasjonsform: string) =>
      hovedskjemaXml({
        orgnr: "312999358", organisasjonsform, navn: "Akademisk Episk Tiger AS", epost: "post@tiger.no", aar: 2025, start: "2025-01-01", slutt: "2025-12-31",
        fastsettelsesdato: "2026-05-20", bekreftende: "Kari Nordmann", revideres: false, utarbeidetAvRegnskapsforer: false, bistandRegnskapsforer: true, system: "Admin Konsoll",
      });
    expect(hoved("AS")).toContain('<aarsregnskapIkkeRevideres orid="34669">ja</aarsregnskapIkkeRevideres>');
    expect(hoved("AS")).toContain('<tjenestebistandEksternAutorisertRegnskapsfoerer orid="34671">ja</tjenestebistandEksternAutorisertRegnskapsfoerer>');
    // Revisjonsspørsmålene gjelder bare aksjeselskap.
    expect(hoved("ANS")).not.toContain("revisjonRegnskapsfoerer");
    valider(hoved("AS"), "hovedskjema_1266_51820");
    valider(hoved("ANS"), "hovedskjema_1266_51820");
  });
});

describe.skipIf(!process.env.DATABASE_URL)("årsregnskapet i appen", () => {
  const app = lagApi();
  const eier = "Bearer test:uid-aarsregnskap-eier:aarsregnskap-eier@server.test:mfa:Kari%20Nordmann";
  const fakturerer = "Bearer test:uid-aarsregnskap-fakt:aarsregnskap-fakt@server.test:mfa";
  let org = "";
  let enk = "";
  const register: Record<string, Partial<Enhet>> = {
    "312999358": { navn: "AKADEMISK EPISK TIGER AS", organisasjonsform: "AS", stiftelsesdato: "2020-03-01" },
    "316000010": { navn: "OLA NORDMANN SNEKKER", organisasjonsform: "ENK", stiftelsesdato: "2019-01-01" },
  };
  const kall = async (metode: string, sti: string, kropp?: unknown, hvem = eier) => {
    const r = await app.request(sti, { method: metode, headers: { authorization: hvem, "content-type": "application/json" }, body: kropp === undefined ? undefined : JSON.stringify(kropp) });
    const type = r.headers.get("content-type") ?? "";
    return { status: r.status, data: type.includes("json") ? ((await r.json()) as any) : await r.text() };
  };
  const ok = async (metode: string, sti: string, kropp?: unknown) => {
    const r = await kall(metode, sti, kropp);
    expect(r.status, `${metode} ${sti}: ${JSON.stringify(r.data)}`).toBeLessThan(300);
    return r.data;
  };
  const o = (x: string, id = org) => `/api/org/${id}${x}`;
  const bilag = (dato: string, tekst: string, debet: string, kredit: string, belop: number, id = org) =>
    ok("POST", o("/regnskap/bilag", id), { dato, tekst, linjer: [{ konto: debet, debet: belop }, { konto: kredit, kredit: belop }] });
  const tall = (l: any[], nokkel: string) => {
    const x = l.find((y) => y.nokkel === nokkel);
    return x ? [x.aarets, x.fjor] : undefined;
  };

  beforeAll(async () => {
    settLokalOppgavekjorer(async () => {});
    glemEnhet();
    settBrreg(async (nr) => {
      const e = register[nr];
      if (!e) throw new ApiFeil(404, "Fant ikke organisasjonsnummeret i Enhetsregisteret");
      return {
        orgnr: nr, navn: "", adresse: null, postnr: null, poststed: null, mva_registrert: false, foretaksregisteret: true, konkurs: false,
        under_avvikling: false, slettet: false, hjemmeside: null, epost: null, ...e,
      } as Enhet;
    }, async (nr) =>
      nr === "312999358"
        ? [
            { kode: "DAGL", rolle: "Daglig leder", navn: "Kari Nordmann" },
            { kode: "MEDL", rolle: "Styremedlem", navn: "Ola Medlem" },
            { kode: "VARA", rolle: "Varamedlem", navn: "Vara Person" },
            { kode: "LEDE", rolle: "Styreleder", navn: "Per Styreleder" },
          ]
        : [],
    );
    org = (await ok("POST", "/api/organisasjoner", { navn: "Episk Tiger AS", orgnr: "312999358" })).id;
    await ok("PATCH", o(""), { kontonr: "86011117947" });
    const inv = await ok("POST", o("/invitasjoner"), { epost: "aarsregnskap-fakt@server.test", rolle: "fakturerer" });
    expect((await kall("POST", "/api/invitasjoner/aksepter", { token: inv.lenke.split("/").pop() }, fakturerer)).status).toBe(200);

    // 2024: aksjekapitalen, inntektene og husleien; årsoppgjøret med skatt.
    await bilag("2024-01-02", "Aksjekapital", "1920", "2000", 30000);
    await bilag("2024-03-31", "Konsultasjoner", "1920", "3200", 80000);
    await bilag("2024-09-30", "Husleie", "6300", "1920", 20000);
    await ok("POST", o("/regnskap/aarsoppgjor/2024"), { skatt: 13200 });
    // 2025: skatten betales, inntekter med øre, lønn, husleie, en PC som avskrives og renter.
    await bilag("2025-02-15", "Betalt skatt", "2500", "1920", 13200);
    await bilag("2025-03-31", "Konsultasjoner", "1920", "3200", 100000.5);
    await bilag("2025-04-30", "Leieinntekt", "1920", "3600", 5000);
    await bilag("2025-06-30", "Lønn", "5000", "1920", 20000);
    await bilag("2025-06-30", "Arbeidsgiveravgift", "5400", "1920", 2820);
    await bilag("2025-09-30", "Husleie", "6300", "1920", 30000.3);
    await bilag("2025-10-01", "PC", "1280", "1920", 24000);
    await bilag("2025-12-15", "Renter", "1920", "8050", 150);
    await bilag("2025-12-31", "Avskrivning PC", "6010", "1280", 2000);
  });

  it("årsoppgjøret må være bokført før årsregnskapet kan sendes", async () => {
    const a = await ok("GET", o("/regnskap/aarsregnskap?aar=2025"));
    expect(a.aarsoppgjor).toMatchObject({ bokfort: false, trengs: true });
    expect(a.feil).toContain("Årsoppgjøret for 2025 er ikke bokført (Regnskap → Årsoppgjør).");
  });

  it("oppstillingen fra regnskapet med fjoråret, i hele kroner", async () => {
    await ok("POST", o("/regnskap/aarsoppgjor/2025"), { skatt: 11050, utbytte: 10000 });
    const a = await ok("GET", o("/regnskap/aarsregnskap?aar=2025"));
    expect(a).toMatchObject({
      aar: 2025, over: true, start: "2025-01-01", slutt: "2025-12-31", orgnr: "312999358", navn: "AKADEMISK EPISK TIGER AS", organisasjonsform: "AS",
      har_fjor: true, fjor_for_haand: false, aarsoppgjor: { bokfort: true, stemmer: true },
      forslag: { bekreftende: "Kari Nordmann", kontakt_epost: "aarsregnskap-eier@server.test" },
    });
    const r = a.resultat;
    expect(tall(r, "salgsinntekt")).toEqual([100001, 80000]);
    expect(tall(r, "annenDriftsinntekt")).toEqual([5000, 0]);
    expect(tall(r, "driftsinntektSum")).toEqual([105001, 80000]);
    expect(tall(r, "loennskostnad")).toEqual([22820, 0]);
    expect(tall(r, "avskrivning")).toEqual([2000, 0]);
    expect(tall(r, "annenDriftskostnad")).toEqual([30000, 20000]);
    expect(tall(r, "driftsresultat")).toEqual([50181, 60000]);
    expect(tall(r, "annenRenteinntekt")).toEqual([150, 0]);
    expect(tall(r, "resultatFoerSkatt")).toEqual([50331, 60000]);
    expect(tall(r, "skattekostnad")).toEqual([11050, 13200]);
    expect(tall(r, "aarsresultat")).toEqual([39281, 46800]);
    expect(tall(r, "utbytte")).toEqual([10000, 0]);
    // 29 280,20 kr i hele kroner, pluss én krone fra øreavrundingen, så summen er lik årsresultatet.
    expect(tall(r, "overfoeringAnnenEK")).toEqual([29281, 46800]);
    expect(tall(r, "sumOverfoeringer")).toEqual([39281, 46800]);
    expect(r.find((l: any) => l.nokkel === "varekostnad").vis).toBe(false);
    expect(r.find((l: any) => l.navn === "Driftsinntekter")).toMatchObject({ type: "overskrift", vis: true });

    const b = a.balanse;
    expect(tall(b, "driftsloesoere")).toEqual([22000, 0]);
    expect(tall(b, "bankinnskudd")).toEqual([105130, 90000]);
    expect(tall(b, "sumEiendeler")).toEqual([127130, 90000]);
    expect(tall(b, "selskapskapital")).toEqual([30000, 30000]);
    expect(tall(b, "annenEgenkapital")).toEqual([76080, 46800]);
    expect(tall(b, "betalbarSkatt")).toEqual([11050, 13200]);
    expect(tall(b, "utbytteGjeld")).toEqual([10000, 0]);
    expect(tall(b, "sumEgenkapitalGjeld")).toEqual([127130, 90000]);
    expect(b.find((l: any) => l.navn === "Immaterielle eiendeler").vis).toBe(false);

    expect(a.noter).toMatchObject({ aarsverk: null, aarsverk_forslag: 0 });
    expect(a.noter.prinsipper).toContain("god regnskapsskikk for små foretak");
    expect(a.noter.prinsipper).toContain("Skattekostnaden er betalbar skatt for perioden.");
    expect(a.noter.lonn).toEqual([
      { navn: "Lønn", aarets: 20000, fjor: 0 },
      { navn: "Arbeidsgiveravgift", aarets: 2820, fjor: 0 },
      { navn: "Pensjonskostnader", aarets: 0, fjor: 0 },
      { navn: "Andre ytelser", aarets: 0, fjor: 0 },
    ]);
    expect(a.feil).toEqual([
      "Oppgi datoen årsregnskapet ble fastsatt (generalforsamlingen).",
      "Oppgi navnet på den som bekrefter at årsregnskapet er fastsatt (minst tre tegn).",
      "Svar på om årsregnskapet skal revideres.",
    ]);
    expect(a.advarsler).toEqual(["Det er lønnskostnader, men ingen årsverk; sjekk antall årsverk i noten."]);
    expect(a.innsending).toMatchObject({ status: "utkast", instans_url: null });
    // Styret og daglig leder fra Enhetsregisteret (signaturene i PDF-en).
    expect(a.roller).toEqual([
      { rolle: "Styreleder", navn: "Per Styreleder" },
      { rolle: "Styremedlem", navn: "Ola Medlem" },
      { rolle: "Daglig leder", navn: "Kari Nordmann" },
    ]);
  });

  it("fastsettelsen, revisjonen og notene, og skjemaene som sendes", async () => {
    expect((await kall("PUT", o("/regnskap/aarsregnskap/2025"), { fastsettelsesdato: "2025-12-31" })).status).toBe(200);
    let a = await ok("GET", o("/regnskap/aarsregnskap?aar=2025"));
    expect(a.feil).toContain("Årsregnskapet kan ikke være fastsatt før regnskapsåret er over.");
    a = await ok("PUT", o("/regnskap/aarsregnskap/2025"), {
      fastsettelsesdato: "2026-05-20", bekreftende: "Kari Nordmann", revideres: false, aarsverk: 0.5, ytterligere: "Selskapet leier lokaler av daglig leder.",
    });
    expect(a.feil).toEqual([]);
    expect(a.advarsler).toEqual([]);
    expect(a.opplysninger).toMatchObject({ fastsettelsesdato: "2026-05-20", bekreftende: "Kari Nordmann", revideres: false, aarsverk: 0.5 });
    // Usikkerhet om fortsatt drift og lån til ledende personer må beskrives.
    a = await ok("PUT", o("/regnskap/aarsregnskap/2025"), { usikkerhet_drift: true, laan: { gitt: true } });
    expect(a.feil).toEqual([
      "Beskriv usikkerheten om fortsatt drift i noten.",
      "Fyll ut noten om lån og sikkerhetsstillelse til ledende personer og aksjeeiere.",
    ]);
    a = await ok("PUT", o("/regnskap/aarsregnskap/2025"), { usikkerhet_drift: false, laan: { gitt: true, laan_styret: 50000, rente_styret: "5", tekst: "Lån til daglig leder." } });
    expect(a.feil).toEqual([]);
    expect((await kall("PUT", o("/regnskap/aarsregnskap/2025"), { kontakt_epost: "ikke-epost" })).status).toBe(400);

    const hoved = (await kall("GET", o("/regnskap/aarsregnskap/2025/hovedskjema.xml"))).data as string;
    expect(hoved).toContain('<organisasjonsnummer orid="18">312999358</organisasjonsnummer><organisasjonsform orid="756">AS</organisasjonsform>');
    expect(hoved).toContain('<e-post orid="19022">aarsregnskap-eier@server.test</e-post>');
    expect(hoved).toContain('<fastsettelsedato orid="17105">2026-05-20</fastsettelsedato><bekreftendeSelskapsrepresentant orid="19023">Kari Nordmann</bekreftendeSelskapsrepresentant>');
    expect(hoved).toContain('<aarsregnskapIkkeRevideres orid="34669">ja</aarsregnskapIkkeRevideres>');
    valider(hoved, "hovedskjema_1266_51820");
    const under = (await kall("GET", o("/regnskap/aarsregnskap/2025/underskjema.xml"))).data as string;
    expect(under).toContain('<salgsinntekt><aarets orid="1340">100001</aarets><fjoraarets orid="7965">80000</fjoraarets></salgsinntekt>');
    expect(under).toContain('<aarsresultat><aarets orid="172">39281</aarets><fjoraarets orid="7054">46800</fjoraarets></aarsresultat>');
    expect(under).toContain('<antallAarsverk orid="37467">0.5</antallAarsverk>');
    expect(under).toContain('<samletLaanMedlemmerStyret orid="39889">50000</samletLaanMedlemmerStyret>');
    expect(under).toContain('<noteLoennAarets orid="37525">20000</noteLoennAarets>');
    expect(under).toContain('<noteSumLoennAarets orid="37533">22820</noteSumLoennAarets>');
    expect(under).not.toContain("varekostnad");
    valider(under, "underskjema_758_51980");

    // PDF-en til signaturene.
    const pdf = await app.request(o("/regnskap/aarsregnskap/2025/aarsregnskap.pdf"), { headers: { authorization: eier } });
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
    expect(pdf.headers.get("content-disposition")).toBe('attachment; filename="aarsregnskap-2025-312999358.pdf"');
    const data = Buffer.from(await pdf.arrayBuffer());
    expect(data.subarray(0, 5).toString()).toBe("%PDF-");
    if (process.env.AARSREGNSKAP_PDF) fs.writeFileSync(process.env.AARSREGNSKAP_PDF, data);
  });

  it("fjorårstallene for hånd", async () => {
    expect((await kall("PUT", o("/regnskap/aarsregnskap/2025"), { fjor: { sumEiendeler: 1 } })).status).toBe(400);
    let a = await ok("PUT", o("/regnskap/aarsregnskap/2025"), {
      fjor: { salgsinntekt: 70000, annenDriftskostnad: 10000, skattekostnad: 13200, overfoeringAnnenEK: 46800, bankinnskudd: 90000, selskapskapital: 30000, annenEgenkapital: 46800, betalbarSkatt: 13200 },
    });
    expect(a.fjor_for_haand).toBe(true);
    expect(tall(a.resultat, "salgsinntekt")).toEqual([100001, 70000]);
    expect(tall(a.resultat, "aarsresultat")).toEqual([39281, 46800]);
    expect(tall(a.balanse, "sumEiendeler")).toEqual([127130, 90000]);
    expect(a.feil).toEqual([]);
    a = await ok("PUT", o("/regnskap/aarsregnskap/2025"), { fjor: { salgsinntekt: 70000, bankinnskudd: 1 } });
    expect(a.feil).toEqual([
      "Fjorårstallene går ikke opp: sum eiendeler er ikke lik sum egenkapital og gjeld.",
    ]);
    a = await ok("PUT", o("/regnskap/aarsregnskap/2025"), { fjor: null });
    expect(a.fjor_for_haand).toBe(false);
    expect(tall(a.resultat, "salgsinntekt")).toEqual([100001, 80000]);
  });

  it("rapporten i rapportmodulen", async () => {
    const r = await ok("GET", o("/rapportmodul/regnskap.aarsregnskap?aar=2025"));
    expect(r).toMatchObject({ id: "regnskap.aarsregnskap", navn: "Årsregnskap", periode: "01.01.2025–31.12.2025", merknad: "Ikke sendt." });
    expect(r.kolonner.map((k: any) => k.navn)).toEqual(["Post", "2025", "2024"]);
    expect(r.rader[0]).toEqual({ post: "DRIFTSINNTEKTER", aarets: null, fjor: null });
    expect(r.rader).toContainEqual({ post: "  Salgsinntekt", aarets: 100001, fjor: 80000 });
    expect(r.rader).toContainEqual({ post: "Årsresultat", aarets: 39281, fjor: 46800 });
    expect(r.rader).toContainEqual({ post: "Sum egenkapital og gjeld", aarets: 127130, fjor: 90000 });
  });

  it("bare aksjeselskap foreløpig, og tilgangen", async () => {
    enk = (await ok("POST", "/api/organisasjoner", { navn: "Ola Nordmann Snekker", orgnr: "316000010" })).id;
    const a = await ok("GET", o("/regnskap/aarsregnskap?aar=2025", enk));
    expect(a.feil).toContain("Årsregnskapet kan foreløpig bare sendes herfra for aksjeselskap (organisasjonsformen er ENK).");
    expect((await kall("GET", o("/regnskap/aarsregnskap?aar=2025"), undefined, fakturerer)).status).toBe(403);
    expect((await kall("PUT", o("/regnskap/aarsregnskap/2025"), { bekreftende: "Noen" }, fakturerer)).status).toBe(403);
    expect((await kall("GET", o("/regnskap/aarsregnskap?aar=2099"))).status).toBe(400);
  });
});
