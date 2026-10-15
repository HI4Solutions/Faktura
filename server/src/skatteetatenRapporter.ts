// Krav og frister fra Skatteetaten i rapportmodulen (modulen Regnskap, skatteetatenKrav.ts): det
// organisasjonen skylder Skatteetaten (de åpne kravene per forfall, med konto og KID), fristene for
// mva-meldingen og skattemeldingen, og innbetalingene og utbetalingene i perioden. Fra det som sist
// ble hentet; regnskapsføreren kan få dem hver måned. Eier, administrator og regnskap (funksjonen
// «Regnskap»), og bare når hentingen er slått på.
import { config } from "./config.js";
import type { Db } from "./db.js";
import type { Rapportdata, Rapportdef } from "./rapportmodul.js";
import { hentLagret } from "./skatteetatenRuter.js";

const krTekst = (n: number) => `${n.toLocaleString("nb-NO", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).replace(/[\u00a0\u202f]/g, " ").replace(/\u2212/g, "-")} kr`;
const tidTekst = (iso: string) => {
  const d = new Date(iso);
  const dag = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Oslo" }).format(d);
  const kl = new Intl.DateTimeFormat("nb-NO", { timeZone: "Europe/Oslo", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d).replace(":", ".");
  return `${dag.slice(8, 10)}.${dag.slice(5, 7)}.${dag.slice(0, 4)} kl. ${kl}`;
};

// Når det ble hentet, eller hvorfor det ikke er hentet; og feilen fra siste forsøk.
function hentetTekst(hentet: string | null, feil: string | null, hva: string) {
  const deler = [hentet ? `Hentet fra Skatteetaten ${tidTekst(hentet)}.` : `${hva} er ikke hentet fra Skatteetaten ennå.`];
  if (feil) deler.push(`Siste henting feilet: ${feil}`);
  return deler.join(" ");
}

const tom = (kolonner: Rapportdata["kolonner"], merknad: string): Rapportdata => ({ kolonner, rader: [], merknad });

const KRAV: Rapportdata["kolonner"] = [
  { nokkel: "forfall", navn: "Forfall", type: "dato" },
  { nokkel: "krav", navn: "Krav" },
  { nokkel: "periode", navn: "Periode" },
  { nokkel: "gruppe", navn: "Kravgruppe", pdf: false },
  { nokkel: "opprinnelig", navn: "Opprinnelig", type: "kr" },
  { nokkel: "gjenstaaende", navn: "Å betale", type: "kr", sum: true },
  { nokkel: "renter", navn: "Renter", type: "kr", sum: true },
  { nokkel: "konto", navn: "Konto" },
  { nokkel: "kid", navn: "KID" },
];
const FRISTER: Rapportdata["kolonner"] = [
  { nokkel: "frist", navn: "Frist", type: "dato" },
  { nokkel: "tittel", navn: "Hva" },
  { nokkel: "beskrivelse", navn: "Beskrivelse" },
  { nokkel: "kilde", navn: "Kilde", pdf: false },
];
const BETALINGER: Rapportdata["kolonner"] = [
  { nokkel: "dato", navn: "Dato", type: "dato" },
  { nokkel: "hva", navn: "Hva" },
  { nokkel: "tekst", navn: "Tekst" },
  { nokkel: "inn", navn: "Innbetalt", type: "kr", sum: true },
  { nokkel: "ut", navn: "Utbetalt", type: "kr", sum: true },
];

async function krav(db: Db, org: string): Promise<Rapportdata> {
  const r = await hentLagret(db, org);
  const k = r?.krav;
  if (!k) return tom(KRAV, hentetTekst(null, r?.krav_feil ?? null, "Kravene"));
  const s = k.summer;
  return {
    kolonner: KRAV,
    // Hvert forfall som ikke er betalt (et krav uten forfall står med det som gjenstår).
    rader: k.aapne.flatMap((x) => {
      const felles = { krav: x.beskrivelse, periode: x.periode, gruppe: x.gruppe };
      const apne = x.forfall.filter((f) => f.gjenstaaende !== 0);
      if (!apne.length) return [{ ...felles, forfall: null, opprinnelig: x.opprinnelig, gjenstaaende: x.gjenstaaende, renter: x.renter, konto: null, kid: null }];
      return apne.map((f, i) => ({
        ...felles,
        forfall: f.dato,
        opprinnelig: f.opprinnelig,
        gjenstaaende: f.gjenstaaende,
        // De stipulerte rentene står på kravet; de tas med på det første forfallet.
        renter: i === 0 ? x.renter : 0,
        konto: f.kontonummer ?? f.iban,
        kid: f.kid,
      }));
    }),
    merknad: [
      hentetTekst(r!.krav_hentet, r!.krav_feil, "Kravene"),
      `Saldo ${krTekst(s.saldo)}: forfalt ${krTekst(s.forfalt)}, ikke forfalt ${krTekst(s.ikke_forfalt)}, stipulerte renter ${krTekst(s.renter)}.`,
      s.uplassert ? `Innbetalt, men ikke plassert mot et krav: ${krTekst(s.uplassert)}.` : "",
    ]
      .filter(Boolean)
      .join(" "),
  };
}

async function frister(db: Db, org: string): Promise<Rapportdata> {
  const r = await hentLagret(db, org);
  const f = r?.frister;
  if (!f) return tom(FRISTER, hentetTekst(null, r?.frister_feil ?? null, "Fristene"));
  const feil = f.kilder.filter((k) => k.status.toUpperCase() !== "OK").map((k) => `${k.kilde} (${k.status})`);
  return {
    kolonner: FRISTER,
    rader: f.frister.map((x) => ({ frist: x.frist, tittel: x.tittel, beskrivelse: x.beskrivelse, kilde: x.kilde })),
    merknad: [hentetTekst(r!.frister_hentet, r!.frister_feil, "Fristene"), feil.length ? `Skatteetaten fikk ikke svar fra: ${feil.join(", ")}.` : ""].filter(Boolean).join(" "),
  };
}

async function betalinger(db: Db, org: string, fra: string, til: string): Promise<Rapportdata> {
  const r = await hentLagret(db, org);
  const k = r?.krav;
  if (!k) return tom(BETALINGER, hentetTekst(null, r?.krav_feil ?? null, "Betalingene"));
  const i = (d: string | null) => !!d && d >= fra && d <= til;
  const rader = [
    ...k.innbetalinger.filter((x) => i(x.dato)).map((x) => ({ dato: x.dato, hva: "Innbetaling", tekst: [x.type, x.uplassert ? `${krTekst(x.uplassert)} ikke plassert` : null].filter(Boolean).join(", "), inn: x.belop, ut: null })),
    ...k.utbetalinger.filter((x) => i(x.dato)).map((x) => ({ dato: x.dato, hva: "Utbetaling", tekst: x.melding ?? x.status ?? "", inn: null, ut: x.belop })),
  ].sort((a, b) => (a.dato ?? "").localeCompare(b.dato ?? ""));
  const utenfor = fra < k.periode.fra;
  return {
    kolonner: BETALINGER,
    rader,
    merknad: [
      hentetTekst(r!.krav_hentet, r!.krav_feil, "Betalingene"),
      utenfor ? `Betalingene er hentet fra og med ${k.periode.fra.split("-").reverse().join(".")} (Skatteetaten gir høyst ett år).` : "",
    ]
      .filter(Boolean)
      .join(" "),
  };
}

const aktiv = () => config.kravOgFrister;

export const skatteetatenRapporter: Rapportdef[] = [
  {
    id: "regnskap.skatteetaten_krav",
    modul: "regnskap",
    navn: "Krav fra Skatteetaten",
    beskrivelse:
      "Det organisasjonen skylder Skatteetaten (skatt og avgifter): hvert forfall som ikke er betalt, med det som gjenstår, stipulerte renter, kontonummer og KID, og saldoen.",
    funksjon: "regnskap",
    tilgang: "regnskap",
    parameter: "ingen",
    maanedlig: true,
    aktiv,
    hent: (db, org) => krav(db, org),
  },
  {
    id: "regnskap.skatteetaten_frister",
    modul: "regnskap",
    navn: "Frister hos Skatteetaten",
    beskrivelse: "Fristene organisasjonen har hos Skatteetaten det neste året, som mva-meldingen og skattemeldingen.",
    funksjon: "regnskap",
    tilgang: "regnskap",
    parameter: "ingen",
    maanedlig: true,
    aktiv,
    hent: (db, org) => frister(db, org),
  },
  {
    id: "regnskap.skatteetaten_betalinger",
    modul: "regnskap",
    navn: "Betalinger med Skatteetaten",
    beskrivelse: "Innbetalingene til og utbetalingene fra Skatteetaten i perioden (det siste året), for avstemming mot banken.",
    funksjon: "regnskap",
    tilgang: "regnskap",
    parameter: "periode",
    maanedlig: true,
    aktiv,
    hent: (db, org, v) => betalinger(db, org, v.fra, v.til),
  },
];
