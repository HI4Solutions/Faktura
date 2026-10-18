// Mva-meldingen som XML (mvaMeldingXml.ts): meldingen og konvolutten mot Skatteetatens XSD-er (når
// xmllint finnes), linjene (grunnlag og sats bare for utgående og beregnet avgift, satsen 11,11 med
// komma, fradrag uten grunnlag), periodene, merknadene for linjer med motsatt fortegn, og svarene:
// valideringsresultatet i begge formatene og betalingsinformasjonen.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { lagTermin, type Mvalinje } from "../src/mva.js";
import {
  KONVOLUTT_NS,
  MELDING_FILNAVN,
  fortegn,
  konvoluttXml,
  lesBetalingsinformasjon,
  lesValideringsresultat,
  merknadsvalg,
  mvaMeldingXml,
  sjekkMerknad,
  vanligFortegn,
} from "../src/mvaMeldingXml.js";

const her = path.dirname(fileURLToPath(import.meta.url));
const harXmllint = spawnSync("xmllint", ["--version"]).status === 0;
function valider(xml: string, skjema: "mva_skattemelding_v1_0" | "mva_konvolutt_v1_0") {
  if (!harXmllint) return;
  const fil = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mva-")), "melding.xml");
  fs.writeFileSync(fil, xml);
  execFileSync("xmllint", ["--noout", "--schema", path.join(her, "xsd", `${skjema}.xsd`), fil], { stdio: "pipe" });
}
// Konvolutten sendes uten navnerom (som i Skatteetatens eksempler); XSD-en har ett.
const medNavnerom = (xml: string) => xml.replace("<mvaMeldingInnsending>", `<mvaMeldingInnsending xmlns="${KONVOLUTT_NS}">`);

const l = (x: Partial<Mvalinje> & { kode: string; merverdiavgift: number }): Mvalinje => ({
  beskrivelse: `Kode ${x.kode}`,
  grunnlag: null,
  sats: null,
  fradrag: false,
  spesifikasjon: null,
  ...x,
});

const LINJER: Mvalinje[] = [
  l({ kode: "1", merverdiavgift: -2500, fradrag: true }),
  l({ kode: "1", merverdiavgift: -400, fradrag: true, spesifikasjon: "justering" }),
  l({ kode: "3", grunnlag: 100000, sats: 25, merverdiavgift: 25000 }),
  l({ kode: "5", grunnlag: 3000, sats: 0, merverdiavgift: 0 }),
  l({ kode: "6", grunnlag: 1200, sats: 0, merverdiavgift: 0 }),
  l({ kode: "11", merverdiavgift: -150, fradrag: true }),
  l({ kode: "31", grunnlag: 2000, sats: 15, merverdiavgift: 300 }),
  l({ kode: "32", grunnlag: 900, sats: 11.11, merverdiavgift: 100 }),
  l({ kode: "33", grunnlag: 1000, sats: 12, merverdiavgift: 120 }),
  l({ kode: "52", grunnlag: 25255, sats: 0, merverdiavgift: 0 }),
  l({ kode: "86", grunnlag: 4000, sats: 25, merverdiavgift: 1000 }),
  l({ kode: "86", merverdiavgift: -1000, fradrag: true }),
  l({ kode: "87", grunnlag: 800, sats: 25, merverdiavgift: 200 }),
];
const SUM = LINJER.reduce((s, x) => s + x.merverdiavgift, 0);
const melding = (over: Partial<Parameters<typeof mvaMeldingXml>[0]> = {}) =>
  mvaMeldingXml({
    orgnr: "316000029",
    termin: lagTermin(2026, "tomaaneder", 4),
    linjer: LINJER,
    sum: SUM,
    referanse: "0b8e7a46-6c55-4d2e-9a3e-5b2a1f4e9c11",
    systemnavn: "Admin Konsoll",
    systemversjon: "test",
    ...over,
  });

describe("meldingen", () => {
  it("gjelder skjemaet, med alle linjetypene", () => {
    const xml = melding();
    valider(xml, "mva_skattemelding_v1_0");
    expect(xml).toContain('<mvaMeldingDto xmlns="no:skatteetaten:fastsetting:avgift:mva:skattemeldingformerverdiavgift:v1.0">');
    expect(xml).toContain("<skattleggingsperiodeToMaaneder>juli-august</skattleggingsperiodeToMaaneder>");
    expect(xml).toContain("<aar>2026</aar>");
    expect(xml).toContain(`<fastsattMerverdiavgift>${SUM}</fastsattMerverdiavgift>`);
    expect(xml).toContain("<regnskapssystemsreferanse>0b8e7a46-6c55-4d2e-9a3e-5b2a1f4e9c11</regnskapssystemsreferanse>");
    expect(xml).toContain("<systemnavn>Admin Konsoll</systemnavn>");
    expect(xml).toContain("<organisasjonsnummer>316000029</organisasjonsnummer>");
    expect(xml).toContain("<meldingskategori>alminnelig</meldingskategori>");
    expect(xml).toContain("<betalingsinformasjon/>");
  });

  it("utgående avgift med grunnlag og sats, satsen 11,11 med komma, fradrag bare med avgiften", () => {
    const xml = melding();
    const linje = (kode: string, n = 0) => xml.split("<mvaSpesifikasjonslinje>").slice(1).filter((x) => x.includes(`<mvaKode>${kode}</mvaKode>`))[n]!;
    expect(linje("3")).toContain("<grunnlag>100000</grunnlag>");
    expect(linje("3")).toContain("<sats>25</sats>");
    expect(linje("32")).toContain("<sats>11,11</sats>");
    expect(linje("52")).toContain("<sats>0</sats>");
    expect(linje("52")).toContain("<merverdiavgift>0</merverdiavgift>");
    for (const x of [linje("1"), linje("11"), linje("86", 1)]) {
      expect(x).not.toContain("<grunnlag>");
      expect(x).not.toContain("<sats>");
    }
    expect(linje("86", 1)).toContain("<merverdiavgift>-1000</merverdiavgift>");
    expect(linje("1", 1)).toContain("<spesifikasjon>justering</spesifikasjon>");
  });

  it("hver terminlengde har sitt periodeelement", () => {
    const maaned = melding({ termin: lagTermin(2026, "maaned", 3) });
    const aar = melding({ termin: lagTermin(2025, "aar", 1) });
    valider(maaned, "mva_skattemelding_v1_0");
    valider(aar, "mva_skattemelding_v1_0");
    expect(maaned).toContain("<skattleggingsperiodeMaaned>mars</skattleggingsperiodeMaaned>");
    expect(aar).toContain("<skattleggingsperiodeAar>aarlig</skattleggingsperiodeAar>");
    expect(aar).toContain("<aar>2025</aar>");
  });

  it("uten avgift i terminen: 0 kr og ingen linjer", () => {
    const xml = melding({ linjer: [], sum: 0 });
    valider(xml, "mva_skattemelding_v1_0");
    expect(xml).toContain("<fastsattMerverdiavgift>0</fastsattMerverdiavgift>");
    expect(xml).not.toContain("<mvaSpesifikasjonslinje>");
  });
});

describe("konvolutten", () => {
  it("gjelder skjemaet (med navnerommet), uten navnerom i det som sendes, med meldingen som vedlegg", () => {
    const xml = konvoluttXml({ orgnr: "316000029", termin: lagTermin(2026, "tomaaneder", 1), opprettetAv: "Kari & Ola <Nordmann>", tidspunkt: "2026-10-18T10:15:00+02:00" });
    valider(medNavnerom(xml), "mva_konvolutt_v1_0");
    expect(xml).toContain("<mvaMeldingInnsending>");
    expect(xml).toContain("<skattleggingsperiodeToMaaneder>januar-februar</skattleggingsperiodeToMaaneder>");
    expect(xml).toContain("<opprettetAv>Kari &amp; Ola &lt;Nordmann&gt;</opprettetAv>");
    expect(xml).toContain("<innsendingstype>komplett</innsendingstype>");
    expect(xml).toContain("<vedleggstype>mva-melding</vedleggstype>");
    expect(xml).toContain(`<filnavn>${MELDING_FILNAVN.replace(".xml", "")}</filnavn>`);
    expect(xml).not.toContain("binaerVedlegg");
  });
});

describe("merknadene", () => {
  it("det vanlige fortegnet: fradrag negative, salg, avgift og justeringen positive", () => {
    expect(vanligFortegn(l({ kode: "1", merverdiavgift: -1, fradrag: true }))).toBe("-");
    expect(vanligFortegn(l({ kode: "3", merverdiavgift: 1, grunnlag: 4, sats: 25 }))).toBe("+");
    expect(vanligFortegn(l({ kode: "1", merverdiavgift: -1, fradrag: true, spesifikasjon: "justering" }))).toBe("+");
    expect(fortegn(l({ kode: "52", merverdiavgift: 0, grunnlag: -500, sats: 0 }))).toBe("-");
    expect(fortegn(l({ kode: "52", merverdiavgift: 0, grunnlag: 0, sats: 0 }))).toBeNull();
  });

  it("vanlige linjer trenger ingen merknad", () => {
    for (const x of LINJER.filter((y) => y.spesifikasjon !== "justering")) expect(merknadsvalg(x), `kode ${x.kode}`).toBeNull();
  });

  it("kreditnotaer (negativt salg) må forklares, f.eks. med «Kreditnota», og meldingen gjelder fortsatt skjemaet", () => {
    const kreditert = l({ kode: "3", grunnlag: -4000, sats: 25, merverdiavgift: -1000 });
    const v = merknadsvalg(kreditert)!;
    expect(v.fritekst).toBe(true);
    expect(v.koder).toContainEqual({ kode: "kreditnota", navn: "Kreditnota" });
    expect(sjekkMerknad(kreditert, null)).toMatch(/må forklares med en merknad/);
    expect(sjekkMerknad(kreditert, { utvalgt: "store anskaffelser" })).toMatch(/passer ikke/);
    expect(sjekkMerknad(kreditert, { utvalgt: "kreditnota" })).toBeNull();
    expect(sjekkMerknad(kreditert, { beskrivelse: "Retur av varer fra juni." })).toBeNull();
    expect(sjekkMerknad(kreditert, { beskrivelse: " " })).toMatch(/Skriv en forklaring/);
    const fritekst = melding({ linjer: [kreditert, l({ kode: "1", merverdiavgift: 300, fradrag: true })], sum: -700, merknader: [{ utvalgt: "kreditnota" }, { beskrivelse: "Kreditnota fra leverandør & co." }] });
    valider(fritekst, "mva_skattemelding_v1_0");
    expect(fritekst).toContain("<utvalgtMerknad>kreditnota</utvalgtMerknad>");
    expect(fritekst).toContain("<beskrivelse>Kreditnota fra leverandør &amp; co.</beskrivelse>");
  });

  it("fradrag ved kjøp fra utlandet med positivt fortegn, og negativ justering (bare egen forklaring)", () => {
    const fradrag = merknadsvalg(l({ kode: "86", merverdiavgift: 500, fradrag: true }))!;
    expect(fradrag.koder.map((k) => k.kode)).toContain("kreditnota");
    const beregnet = merknadsvalg(l({ kode: "86", grunnlag: -2000, sats: 25, merverdiavgift: -500 }))!;
    expect(beregnet.koder.length).toBeGreaterThan(0);
    const justering = l({ kode: "1", merverdiavgift: -400, fradrag: true, spesifikasjon: "justering" });
    expect(merknadsvalg(justering)).toEqual({ koder: [], fritekst: true });
    expect(sjekkMerknad(justering, { utvalgt: "kreditnota" })).toMatch(/passer ikke/);
    expect(sjekkMerknad(l({ kode: "3", grunnlag: 4, sats: 25, merverdiavgift: 1 }), { utvalgt: "kreditnota" })).toMatch(/skal ikke ha merknad/);
  });
});

describe("svarene fra Skatteetaten", () => {
  it("det eldre formatet: ugyldig med feilen fra skjemavalideringen", () => {
    const r = lesValideringsresultat(`<valideringsresultat>
      <status>UGYLDIG_SKATTEMELDING</status>
      <valideringsfeil>
        <stiTilFeil>//innsending</stiTilFeil>
        <valideringsDetaljer>
          <feilmelding>Mva meldingen må være på gyldig format og passere XML skjema valideringen</feilmelding>
          <alvorlighetsgrad>UGYLDIG_SKATTEMELDING</alvorlighetsgrad>
          <avvikKode>MvaMeldingsinnhold_Xml_SkjemaValideringsfeil</avvikKode>
          <informasjon>cvc-complex-type.2.4.b: The content of element 'mvaMeldingDto' is not complete.</informasjon>
        </valideringsDetaljer>
      </valideringsfeil>
    </valideringsresultat>`);
    expect(r.status).toBe("ugyldig");
    expect(r.avvik).toEqual([
      {
        alvor: "ugyldig",
        tekst: "Mva meldingen må være på gyldig format og passere XML skjema valideringen (cvc-complex-type.2.4.b: The content of element 'mvaMeldingDto' is not complete.)",
        kode: "MvaMeldingsinnhold_Xml_SkjemaValideringsfeil",
        regel: null,
        sti: "//innsending",
        mvaKode: null,
      },
    ]);
    expect(lesValideringsresultat("<valideringsresultat><status>GYLDIG_SKATTEMELDING</status></valideringsresultat>")).toEqual({ status: "gyldig", avvik: [] });
  });

  it("det nyere formatet: ingen avvik, avvikende (levert) og ugyldig, også med prefiks", () => {
    expect(
      lesValideringsresultat(`<?xml version='1.0' encoding='UTF-8'?>
        <valideringsresultat xmlns="no:skatteetaten:fastsetting:avgift:mva:valideringsresultat:v1"><avvikVedMeldingslevering>ingen avvik</avvikVedMeldingslevering></valideringsresultat>`),
    ).toEqual({ status: "gyldig", avvik: [] });
    const avvik = lesValideringsresultat(`<ns2:valideringsresultat xmlns:ns2="no:skatteetaten:fastsetting:avgift:mva:valideringsresultat:v1">
      <ns2:avvikVedMeldingslevering>avvikende skattemelding</ns2:avvikVedMeldingslevering>
      <ns2:avvik>
        <ns2:stiTilAvvik>/mvaMeldingDto/skattegrunnlagOgBeregnetSkatt/mvaSpesifikasjonslinje[1]</ns2:stiTilAvvik>
        <ns2:mvaKode>3</ns2:mvaKode>
        <ns2:avviksinformasjon>
          <ns2:begrunnelse>Merknad til beløp med motsatt fortegn mangler</ns2:begrunnelse>
          <ns2:avvikstype>avvikende skattemelding</ns2:avvikstype>
          <ns2:avvikKode>R020</ns2:avvikKode>
          <ns2:regelDefinisjon>Merknad til beløp med motsatt fortegn som gjelder grunnlag og utgående avgift mangler</ns2:regelDefinisjon>
        </ns2:avviksinformasjon>
      </ns2:avvik>
    </ns2:valideringsresultat>`);
    expect(avvik.status).toBe("avvik");
    expect(avvik.avvik[0]).toMatchObject({ alvor: "avvik", kode: "R020", mvaKode: "3", tekst: "Merknad til beløp med motsatt fortegn mangler" });
    const ugyldig = lesValideringsresultat(
      `<valideringsresultat><avvikVedMeldingslevering>ugyldig skattemelding</avvikVedMeldingslevering><avvik><stiTilAvvik>x</stiTilAvvik><avviksinformasjon><begrunnelse>Summen stemmer ikke</begrunnelse><avvikstype>ugyldig skattemelding</avvikstype><avvikKode>R018</avvikKode><regelDefinisjon>R018</regelDefinisjon><detaljer>15 000 mot 14 999</detaljer></avviksinformasjon></avvik></valideringsresultat>`,
    );
    expect(ugyldig.status).toBe("ugyldig");
    expect(ugyldig.avvik[0]!.tekst).toBe("Summen stemmer ikke (15 000 mot 14 999)");
  });

  it("uten noe gjenkjennelig er resultatet ugyldig", () => {
    expect(lesValideringsresultat("<html>Feil</html>").status).toBe("ugyldig");
  });

  it("betalingsinformasjonen etter innsendingen", () => {
    const b = lesBetalingsinformasjon(`<?xml version='1.0' encoding='UTF-8'?>
      <betalingsinformasjon xmlns="no:skatteetaten:fastsetting:avgift:mva:skattemeldingformerverdiavgift:betalingsinformasjon:v1.0">
        <innsendingsreferanse>50267437/55604b08-1690-4a8d-bf6b-95c11dc40c58</innsendingsreferanse>
        <skattepliktig><organisasjonsnummer>911158612</organisasjonsnummer></skattepliktig>
        <skattleggingsperiode><periode><skattleggingsperiodeToMaaneder>januar-februar</skattleggingsperiodeToMaaneder></periode><aar>2022</aar></skattleggingsperiode>
        <kundeidentifikasjonsnummer>99999999999999</kundeidentifikasjonsnummer>
        <beloep>15000</beloep>
        <betaleTil>Skatteetaten</betaleTil>
        <betalingsfrist>2022-04-11</betalingsfrist>
        <betalesTilKonto><norskKontonummer>12345678903</norskKontonummer></betalesTilKonto>
      </betalingsinformasjon>`);
    expect(b).toEqual({ kid: "99999999999999", belop: 15000, frist: "2022-04-11", konto: "12345678903", betaleTil: "Skatteetaten", informasjon: null });
  });
});
