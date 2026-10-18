// Mva-meldingen som XML til Skatteetaten (mvaInnsending.ts, docs/mva-innsending.md): meldingen
// (skattemelding for merverdiavgift, versjon 1.0, med navnerommet under) og konvolutten
// (MvaMeldingInnsending), etter Skatteetatens XSD-er, og svarene fra Skatteetaten:
// valideringsresultatet og betalingsinformasjonen.
//
// Konvolutten er uten navnerom, som i Skatteetatens eksempler og slik Altinn-appen selv lagrer den.
// Den har ett vedlegg: meldingen (de binære vedleggene må stå i konvolutten med samme filnavn som
// de lastes opp med; appen sender ingen). Valideringsresultatet finnes i to formater: det eldre fra
// valideringstjenesten (status og valideringsfeil) og det nyere i tilbakemeldingen
// (avvikVedMeldingslevering og avvik); begge leses. «Ugyldig» stopper innsendingen; «avvikende»
// er avvik Skatteetaten kan følge opp, men meldingen er levert.
// https://github.com/Skatteetaten/mva-meldingen (docs/informasjonsmodell_filer)
import type { Mvalinje, Termin } from "./mva.js";
import { MERKNAD_NAVN, MERKNADER_MOTSATT } from "./mvaMerknader.js";

export const MELDING_NS = "no:skatteetaten:fastsetting:avgift:mva:skattemeldingformerverdiavgift:v1.0";
// Konvoluttens navnerom i XSD-en (testene legger det til før valideringen).
export const KONVOLUTT_NS = "no:skatteetaten:fastsetting:avgift:mva:mvameldinginnsending:v1.0";
// Filnavnet meldingen lastes opp med (og står med i konvolutten).
export const MELDING_FILNAVN = "mvaMelding.xml";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
// Hele kroner (beløpene i meldingen er uten desimaler, regel R082).
const heltall = (n: number) => String(Math.round(n) || 0);

// Satsen slik den står i kodelisten (11,11 med komma).
export const satsTekst = (sats: number) => String(sats).replace(".", ",");

// Skattleggingsperioden: elementet etter terminlengden, med navnet fra kodelisten
// («januar-februar», «januar» eller «aarlig»).
export function periodeXml(t: Termin, innrykk = ""): string {
  const el = t.type === "tomaaneder" ? "skattleggingsperiodeToMaaneder" : t.type === "maaned" ? "skattleggingsperiodeMaaned" : "skattleggingsperiodeAar";
  return [`${innrykk}<periode>`, `${innrykk}  <${el}>${esc(t.periode)}</${el}>`, `${innrykk}</periode>`, `${innrykk}<aar>${t.aar}</aar>`].join("\n");
}

// --- Merknadene -----------------------------------------------------------------------------------

export type Merknad = { utvalgt: string } | { beskrivelse: string };
export type Merknadsvalg = { koder: { kode: string; navn: string }[]; fritekst: boolean };

// Fortegnet linjen har: avgiften, eller grunnlaget når avgiften er 0 (salg uten avgift).
export function fortegn(l: Mvalinje): "+" | "-" | null {
  const b = l.merverdiavgift !== 0 ? l.merverdiavgift : (l.grunnlag ?? 0);
  return b > 0 ? "+" : b < 0 ? "-" : null;
}
// Det vanlige fortegnet: fradrag er negative; salg, utgående og beregnet avgift og justeringen for
// kapitalvarer positive.
export const vanligFortegn = (l: Mvalinje): "+" | "-" => (l.fradrag && l.spesifikasjon !== "justering" ? "-" : "+");

// Merknadene som kan forklare en linje med motsatt fortegn (regel R020 og R021), eller null når
// linjen ikke trenger noen.
export function merknadsvalg(l: Mvalinje): Merknadsvalg | null {
  const f = fortegn(l);
  if (!f || f === vanligFortegn(l)) return null;
  const liste = MERKNADER_MOTSATT[`${l.kode}|${f}|${l.spesifikasjon ?? ""}`] ?? ["fritekstfelt"];
  return { koder: liste.filter((k) => k !== "fritekstfelt").map((k) => ({ kode: k, navn: MERKNAD_NAVN[k] ?? k })), fritekst: liste.includes("fritekstfelt") };
}

// Er merknaden gyldig for linjen? Gir feilen på norsk, eller null.
export function sjekkMerknad(l: Mvalinje, m: Merknad | null | undefined): string | null {
  const v = merknadsvalg(l);
  const hva = `kode ${l.kode}${l.spesifikasjon === "justering" ? " (justering)" : ""}`;
  if (!v) return m ? `Linjen med ${hva} skal ikke ha merknad.` : null;
  if (!m) return `Linjen med ${hva} har motsatt fortegn av det vanlige og må forklares med en merknad.`;
  if ("utvalgt" in m) return v.koder.some((k) => k.kode === m.utvalgt) ? null : `Merknaden «${m.utvalgt}» passer ikke til linjen med ${hva}.`;
  if (!v.fritekst) return `Linjen med ${hva} må ha en av merknadene i listen.`;
  return m.beskrivelse.trim().length >= 3 ? null : `Skriv en forklaring på linjen med ${hva}.`;
}

function merknadXml(m: Merknad, innrykk: string) {
  return "utvalgt" in m
    ? `${innrykk}<merknad>\n${innrykk}  <utvalgtMerknad>${esc(m.utvalgt)}</utvalgtMerknad>\n${innrykk}</merknad>`
    : `${innrykk}<merknad>\n${innrykk}  <beskrivelse>${esc(m.beskrivelse.trim().slice(0, 4000))}</beskrivelse>\n${innrykk}</merknad>`;
}

// --- Meldingen ------------------------------------------------------------------------------------

export type Meldingsdata = {
  orgnr: string;
  termin: Termin;
  linjer: Mvalinje[];
  sum: number;
  // Systemets referanse til innsendingen (innsendingens id).
  referanse: string;
  systemnavn: string;
  systemversjon?: string | null;
  // Merknaden på hver linje (samme rekkefølge som linjene), der den trengs.
  merknader?: (Merknad | null)[];
};

export function mvaMeldingXml(m: Meldingsdata): string {
  const linjer = m.linjer.map((l, i) => {
    const mk = m.merknader?.[i] ?? null;
    return [
      "    <mvaSpesifikasjonslinje>",
      `      <mvaKode>${esc(l.kode)}</mvaKode>`,
      l.spesifikasjon ? `      <spesifikasjon>${esc(l.spesifikasjon)}</spesifikasjon>` : null,
      l.grunnlag !== null ? `      <grunnlag>${heltall(l.grunnlag)}</grunnlag>` : null,
      l.sats !== null ? `      <sats>${satsTekst(l.sats)}</sats>` : null,
      `      <merverdiavgift>${heltall(l.merverdiavgift)}</merverdiavgift>`,
      mk ? merknadXml(mk, "      ") : null,
      "    </mvaSpesifikasjonslinje>",
    ]
      .filter((x) => x !== null)
      .join("\n");
  });
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<mvaMeldingDto xmlns="${MELDING_NS}">`,
    "  <innsending>",
    `    <regnskapssystemsreferanse>${esc(m.referanse)}</regnskapssystemsreferanse>`,
    "    <regnskapssystem>",
    `      <systemnavn>${esc(m.systemnavn)}</systemnavn>`,
    ...(m.systemversjon ? [`      <systemversjon>${esc(m.systemversjon)}</systemversjon>`] : []),
    "    </regnskapssystem>",
    "  </innsending>",
    "  <skattegrunnlagOgBeregnetSkatt>",
    "    <skattleggingsperiode>",
    periodeXml(m.termin, "      "),
    "    </skattleggingsperiode>",
    `    <fastsattMerverdiavgift>${heltall(m.sum)}</fastsattMerverdiavgift>`,
    ...linjer,
    "  </skattegrunnlagOgBeregnetSkatt>",
    "  <betalingsinformasjon/>",
    "  <skattepliktig>",
    `    <organisasjonsnummer>${esc(m.orgnr)}</organisasjonsnummer>`,
    "  </skattepliktig>",
    "  <meldingskategori>alminnelig</meldingskategori>",
    "</mvaMeldingDto>",
    "",
  ].join("\n");
}

// --- Konvolutten ----------------------------------------------------------------------------------

// opprettetAv: navnet på den som sender (vises i Altinn). tidspunkt: ISO 8601 med tidssone.
export function konvoluttXml(k: { orgnr: string; termin: Termin; opprettetAv: string; tidspunkt: string }): string {
  const av = esc(k.opprettetAv.slice(0, 4000));
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<mvaMeldingInnsending>",
    "  <norskIdentifikator>",
    `    <organisasjonsnummer>${esc(k.orgnr)}</organisasjonsnummer>`,
    "  </norskIdentifikator>",
    "  <skattleggingsperiode>",
    periodeXml(k.termin, "    "),
    "  </skattleggingsperiode>",
    "  <meldingskategori>alminnelig</meldingskategori>",
    "  <innsendingstype>komplett</innsendingstype>",
    "  <instansstatus>default</instansstatus>",
    `  <opprettetAv>${av}</opprettetAv>`,
    `  <opprettingstidspunkt>${esc(k.tidspunkt)}</opprettingstidspunkt>`,
    "  <vedlegg>",
    "    <vedleggstype>mva-melding</vedleggstype>",
    "    <kildegruppe>sluttbrukersystem</kildegruppe>",
    `    <opprettetAv>${av}</opprettetAv>`,
    `    <opprettingstidspunkt>${esc(k.tidspunkt)}</opprettingstidspunkt>`,
    "    <vedleggsfil>",
    `      <filnavn>${MELDING_FILNAVN.replace(/\.xml$/, "")}</filnavn>`,
    "      <filekstensjon>xml</filekstensjon>",
    "      <filinnhold>Mva-melding</filinnhold>",
    "    </vedleggsfil>",
    "  </vedlegg>",
    "</mvaMeldingInnsending>",
    "",
  ].join("\n");
}

// --- Svarene --------------------------------------------------------------------------------------

const entiteter: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const dekod = (s: string) =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (hele, e: string) =>
      e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : (entiteter[e] ?? hele),
    )
    .trim();

// Innholdet i elementene med det lokale navnet (uten prefiks), i rekkefølge. Svarene er små og
// flate, så et enkelt søk holder.
export function elementer(xml: string, navn: string): string[] {
  const re = new RegExp(`<(?:[\\w-]+:)?${navn}(?:\\s[^>]*)?(?:/>|>([\\s\\S]*?)</(?:[\\w-]+:)?${navn}\\s*>)`, "g");
  return [...xml.matchAll(re)].map((m) => m[1] ?? "");
}
const forste = (xml: string, navn: string) => {
  const e = elementer(xml, navn)[0];
  return e === undefined ? null : dekod(e) || null;
};

export type Avvik = { alvor: "ugyldig" | "avvik" | "info"; tekst: string; kode: string | null; regel: string | null; sti: string | null; mvaKode: string | null };
export type Valideringsresultat = { status: "gyldig" | "avvik" | "ugyldig"; avvik: Avvik[] };

// «ugyldig skattemelding» (og den gamle «mangelfull») stopper, «avvikende skattemelding» er avvik;
// «ingen avvik» og GYLDIG_SKATTEMELDING er i orden.
const alvorFra = (s: string | null): Avvik["alvor"] => {
  const x = (s ?? "").toLowerCase().replace(/_/g, " ");
  if (x.includes("ingen avvik")) return "info";
  return x.includes("ugyldig") || x.includes("mangelfull") ? "ugyldig" : x.includes("avvik") ? "avvik" : "info";
};

// Valideringsresultatet (begge formatene). Uten noe gjenkjennelig er det ugyldig.
export function lesValideringsresultat(xml: string): Valideringsresultat {
  const avvik: Avvik[] = [];
  // Det nyere formatet: avvikVedMeldingslevering og avvik med avviksinformasjon.
  const samlet = forste(xml, "avvikVedMeldingslevering");
  for (const a of elementer(xml, "avvik")) {
    const sti = forste(a, "stiTilAvvik");
    const mvaKode = forste(a, "mvaKode");
    for (const info of elementer(a, "avviksinformasjon")) {
      const detaljer = forste(info, "detaljer");
      const begrunnelse = forste(info, "begrunnelse") ?? forste(info, "regelDefinisjon") ?? "Ukjent avvik";
      avvik.push({
        alvor: alvorFra(forste(info, "avvikstype")),
        tekst: (detaljer && detaljer !== begrunnelse ? `${begrunnelse} (${detaljer})` : begrunnelse).slice(0, 1000),
        kode: forste(info, "avvikKode"),
        regel: forste(info, "regelDefinisjon"),
        sti,
        mvaKode,
      });
    }
  }
  // Det eldre formatet: status og valideringsfeil med valideringsDetaljer.
  const status = forste(xml, "status");
  for (const f of elementer(xml, "valideringsfeil")) {
    const sti = forste(f, "stiTilFeil");
    for (const d of elementer(f, "valideringsDetaljer")) {
      const informasjon = forste(d, "informasjon");
      const feilmelding = forste(d, "feilmelding") ?? "Ukjent feil";
      avvik.push({
        alvor: alvorFra(forste(d, "alvorlighetsgrad")),
        tekst: (informasjon ? `${feilmelding} (${informasjon})` : feilmelding).slice(0, 1000),
        kode: forste(d, "avvikKode"),
        regel: null,
        sti,
        mvaKode: forste(d, "mvaKode"),
      });
    }
  }
  const overordnet = samlet ?? status;
  if (overordnet === null && !avvik.length) return { status: "ugyldig", avvik: [{ alvor: "ugyldig", tekst: "Skatteetaten svarte uten valideringsresultat.", kode: null, regel: null, sti: null, mvaKode: null }] };
  const ugyldig = alvorFra(overordnet) === "ugyldig" || avvik.some((a) => a.alvor === "ugyldig");
  const harAvvik = alvorFra(overordnet) === "avvik" || avvik.some((a) => a.alvor === "avvik");
  return { status: ugyldig ? "ugyldig" : harAvvik ? "avvik" : "gyldig", avvik };
}

export type Betalingsinformasjon = { kid: string | null; belop: number | null; frist: string | null; konto: string | null; betaleTil: string | null; informasjon: string | null };

// Betalingsinformasjonen etter innsendingen (positivt beløp å betale, negativt til gode).
export function lesBetalingsinformasjon(xml: string): Betalingsinformasjon {
  const belop = forste(xml, "beloep");
  return {
    kid: forste(xml, "kundeidentifikasjonsnummer"),
    belop: belop !== null && Number.isFinite(Number(belop)) ? Number(belop) : null,
    frist: forste(xml, "betalingsfrist"),
    konto: forste(xml, "norskKontonummer"),
    betaleTil: forste(xml, "betaleTil"),
    informasjon: forste(xml, "informasjon"),
  };
}
