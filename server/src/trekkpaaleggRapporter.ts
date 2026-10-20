// Trekkpålegg fra Skatteetaten i rapportmodulen (modulen Lønn, trekkpaalegg.ts): påleggene med den
// ansatte, trekket som gjelder nå og den neste endringen, KID-en og kontonummeret, og det som er
// trukket i år og i alt. Fra det som sist ble hentet; regnskapsføreren kan få den hver måned. De
// som ser lønnen, og bare når hentingen er slått på.
import { config } from "./config.js";
import { en, type Db } from "./db.js";
import type { Rapportdata, Rapportdef } from "./rapportmodul.js";
import { storrelseTekst } from "./lonnstrekk.js";
import { hentPaalegg } from "./trekkpaaleggRuter.js";

const visDato = (d: string) => d.split("-").reverse().join(".");
const tidTekst = (iso: string) => {
  const d = new Date(iso);
  const dag = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Oslo" }).format(d);
  const kl = new Intl.DateTimeFormat("nb-NO", { timeZone: "Europe/Oslo", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d).replace(":", ".");
  return `${visDato(dag)} kl. ${kl}`;
};

const KOLONNER: Rapportdata["kolonner"] = [
  { nokkel: "ansatt", navn: "Ansatt" },
  { nokkel: "sak", navn: "Sak" },
  { nokkel: "trekkid", navn: "Trekk-ID", pdf: false },
  { nokkel: "status", navn: "Status" },
  { nokkel: "trekk", navn: "Trekk nå" },
  { nokkel: "fra", navn: "Fra", type: "dato" },
  { nokkel: "neste", navn: "Neste endring", pdf: false },
  { nokkel: "kid", navn: "KID" },
  { nokkel: "kontonr", navn: "Konto", pdf: false },
  { nokkel: "trukket_i_aar", navn: "Trukket i år", type: "kr", sum: true },
  { nokkel: "trukket", navn: "Trukket i alt", type: "kr", sum: true, pdf: false },
  { nokkel: "endret", navn: "Sist endret", type: "dato", pdf: false },
];

async function paalegg(db: Db, org: string): Promise<Rapportdata> {
  const h = await en<{ hentet: string | null; feil: string | null }>(db, "select hentet, feil from faktura.trekkpaalegg_henting where org_id = $1", [org]);
  const liste = await hentPaalegg(db, org);
  return {
    kolonner: KOLONNER,
    rader: liste.map((p) => ({
      ansatt: p.navn ?? `Ikke registrert${p.fodselsdato ? ` (født ${visDato(p.fodselsdato)})` : ""}`,
      sak: p.saksnummer ?? "",
      trekkid: p.trekkid,
      status: p.trekkstatus === "avsluttet" ? "Avsluttet" : "Aktiv",
      trekk: p.gjeldende ? storrelseTekst(p.gjeldende) : "–",
      fra: p.gjeldende?.fra ?? null,
      neste: p.neste ? `${storrelseTekst(p.neste)} fra ${visDato(p.neste.fra)}` : "",
      kid: p.kid ?? "",
      kontonr: p.kontonr ?? "",
      trukket_i_aar: p.trukket_i_aar,
      trukket: p.trukket,
      endret: p.formidlet ? new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Oslo" }).format(new Date(p.formidlet)) : null,
    })),
    merknad: [
      h?.hentet ? `Hentet fra Skatteetaten ${tidTekst(h.hentet)}.` : "Trekkpåleggene er ikke hentet fra Skatteetaten ennå.",
      h?.feil ? `Siste henting feilet: ${h.feil}` : "",
      liste.some((p) => !p.ansatt_id && p.trekkstatus === "aktiv") ? "Pålegg for noen som ikke er registrert med fødselsnummer, trekkes ikke før fødselsnummeret er lagt inn på den ansatte." : "",
    ]
      .filter(Boolean)
      .join(" "),
  };
}

export const trekkpaaleggRapporter: Rapportdef[] = [
  {
    id: "lonn.trekkpaalegg",
    modul: "lonn",
    navn: "Trekkpålegg fra Skatteetaten",
    beskrivelse:
      "Påleggene om utleggstrekk fra Skatteetaten: den ansatte, saken, trekket som gjelder nå og den neste endringen, KID-en og kontonummeret, og det som er trukket i år og i alt.",
    funksjon: "lonn",
    tilgang: "personal_les",
    parameter: "ingen",
    maanedlig: true,
    aktiv: () => config.trekkpaalegg,
    hent: (db, org) => paalegg(db, org),
  },
];
