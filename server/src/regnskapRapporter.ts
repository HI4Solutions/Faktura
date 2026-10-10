// Regnskapet i rapportmodulen (rapportmodul.ts, modulen Regnskap): saldobalansen, hovedboken og
// bilagsjournalen (alle bilagene: lønn, refusjoner fra NAV, anleggsmidler, periodiseringer og
// manuelle bilag), anleggsregisteret ved utgangen av året, avskrivningsplanen over årene framover,
// det som er bokført for anleggsmidlene i perioden (avskrivninger, nedskrivninger, anskaffelser og
// avganger), saldoskjemaet med de skattemessige avskrivningene og periodiseringene. Eier,
// administrator og regnskap (funksjonen «Regnskap»).
import { aarsplan, avskrivningsplan, hentAnlegg, KATEGORIER, mnd, status, type Hendelse } from "./anlegg.js";
import { hentRegnskapsbilag, hovedbok, KILDER, saldobalanse } from "./hovedbok.js";
import { maanedNavn } from "./lonnsberegning.js";
import { hentPeriodiseringer, PERIODISERINGSTYPER, sisteMaaned, status as periodiseringsstatus } from "./periodisering.js";
import type { Rapportdef } from "./rapportmodul.js";
import { hentSaldo } from "./regnskapRuter.js";

const rund = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const visDato = (d: string) => d.split("-").reverse().join(".");
const krTekst = (n: number) => `${n.toLocaleString("nb-NO", { minimumFractionDigits: Number.isInteger(rund(n)) ? 0 : 2, maximumFractionDigits: 2 }).replace(/[\u00a0\u202f]/g, " ")} kr`;
const levetid = (m: number | null) => (m == null ? "Avskrives ikke" : m % 12 === 0 ? `${m / 12} år` : m < 12 ? `${m} mnd` : `${Math.floor(m / 12)} år ${m % 12} mnd`);
const skattTekst = (s: string) => (s === "lineaer" ? "Lineært" : s === "ingen" ? "Ingen" : s);
const osloIDag = () => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Oslo" }).format(new Date());
const HVA: Record<Hendelse["type"], string> = {
  anskaffelse: "Anskaffelse",
  avskrivning: "Avskrivning",
  nedskrivning: "Nedskrivning",
  reversering: "Reversert nedskrivning",
  avgang: "Avgang",
};

const kortMnd = (m: string) => `${m.slice(5, 7)}.${m.slice(0, 4)}`;

export const regnskapRapporter: Rapportdef[] = [
  {
    id: "regnskap.saldobalanse",
    modul: "regnskap",
    navn: "Saldobalanse",
    beskrivelse:
      "Saldoen per konto: inngående saldo, debet og kredit i perioden og utgående saldo, fra alle bilagene (lønn, refusjoner fra NAV, anleggsmidler, periodiseringer og manuelle bilag), med resultatet i perioden.",
    funksjon: "regnskap",
    tilgang: "regnskap",
    parameter: "periode",
    maanedlig: true,
    hent: async (db, org, v) => {
      const s = await saldobalanse(db, org, v.fra, v.til);
      const rader: Record<string, unknown>[] = s.rader.map((r) => ({ ...r }));
      if (s.tidligere) rader.push({ konto: "", navn: "Resultat fra tidligere år (ikke ført mot egenkapitalen)", inngaende: s.tidligere, debet: 0, kredit: 0, utgaende: s.tidligere });
      return {
        merknad: [
          `Resultatet i perioden: ${krTekst(Math.abs(s.resultat))} ${s.resultat >= 0 ? "i overskudd" : "i underskudd"}.`,
          "Balansekontoene (klasse 1 og 2) har saldo fra starten; resultatkontoene (klasse 3–8) begynner på null 1. januar.",
          v.fra.slice(0, 4) !== v.til.slice(0, 4) ? `Perioden går over et årsskifte: resultatkontoene er regnet fra 1. januar ${v.fra.slice(0, 4)}.` : "",
          s.tidligere ? "Resultatet fra tidligere år som ikke er ført mot egenkapitalen (årsoppgjøret), står på en egen linje." : "",
        ]
          .filter(Boolean)
          .join(" "),
        kolonner: [
          { nokkel: "konto", navn: "Konto", type: "tekst" },
          { nokkel: "navn", navn: "Kontonavn" },
          { nokkel: "inngaende", navn: "Inngående", type: "kr", sum: true },
          { nokkel: "debet", navn: "Debet", type: "kr", sum: true },
          { nokkel: "kredit", navn: "Kredit", type: "kr", sum: true },
          { nokkel: "utgaende", navn: "Utgående", type: "kr", sum: true },
        ],
        rader,
      };
    },
  },
  {
    id: "regnskap.hovedbok",
    modul: "regnskap",
    navn: "Hovedbok",
    beskrivelse: "Posteringene per konto i perioden med inngående saldo og saldoen etter hver postering, fra alle bilagene.",
    funksjon: "regnskap",
    tilgang: "regnskap",
    parameter: "periode",
    hent: async (db, org, v) => {
      const kontoer = await hovedbok(db, org, v.fra, v.til);
      const rader = kontoer.flatMap((k) => [
        { konto: k.konto, navn: k.navn, dato: null, bilag: "", tekst: `${k.navn}: inngående saldo`, debet: null, kredit: null, saldo: k.inngaende },
        ...k.poster.map((p) => ({ konto: k.konto, navn: k.navn, dato: p.dato, bilag: p.bilag, tekst: p.tekst || p.bilagstekst, debet: p.debet, kredit: p.kredit, saldo: p.saldo })),
      ]);
      return {
        merknad: kontoer.length
          ? `${kontoer.length} kontoer. Saldoen er debet minus kredit (negativ saldo er kredit). Resultatkontoene begynner på null 1. januar.`
          : "Ingen posteringer eller saldoer i perioden.",
        kolonner: [
          { nokkel: "konto", navn: "Konto", type: "tekst" },
          { nokkel: "navn", navn: "Kontonavn", pdf: false },
          { nokkel: "dato", navn: "Dato", type: "dato" },
          { nokkel: "bilag", navn: "Bilag" },
          { nokkel: "tekst", navn: "Tekst" },
          { nokkel: "debet", navn: "Debet", type: "kr", sum: true },
          { nokkel: "kredit", navn: "Kredit", type: "kr", sum: true },
          { nokkel: "saldo", navn: "Saldo", type: "kr" },
        ],
        rader,
      };
    },
  },
  {
    id: "regnskap.bilagsjournal",
    modul: "regnskap",
    navn: "Bilagsjournal",
    beskrivelse:
      "Alle bilagene i perioden med posteringene og mva-kodene, i rekkefølgen dato og bilagsnummer: fakturaer og innbetalinger, utgifter, lønn, refusjoner fra NAV, anleggsmidler, periodiseringer og manuelle bilag.",
    funksjon: "regnskap",
    tilgang: "regnskap",
    parameter: "periode",
    maanedlig: true,
    hent: async (db, org, v) => {
      const bilag = await hentRegnskapsbilag(db, org, { fra: v.fra, til: v.til });
      const rader = bilag.flatMap((b) =>
        b.posteringer.map((p) => ({
          dato: b.dato,
          bilag: b.bilagsnummer,
          kilde: KILDER[b.kilde] ?? b.kilde,
          konto: p.konto,
          navn: p.navn,
          tekst: p.tekst || b.tekst,
          mva_kode: p.mva_kode ?? null,
          debet: p.belop > 0 ? p.belop : null,
          kredit: p.belop < 0 ? -p.belop : null,
        })),
      );
      const reversert = bilag.filter((b) => b.reverserer || b.reversert_av).length;
      return {
        merknad: `${bilag.length} bilag. Serie F: fakturaer og kreditnotaer, B: bank (innbetalinger, refusjoner og andre bankposter), U: utgifter, L: lønn og refusjoner fra NAV, A: anleggsmidler, P: periodiseringer, M: manuelle bilag.${reversert ? ` ${reversert} av bilagene er reversert eller reverseringer (de går mot hverandre).` : ""}`,
        kolonner: [
          { nokkel: "dato", navn: "Dato", type: "dato" },
          { nokkel: "bilag", navn: "Bilag" },
          { nokkel: "kilde", navn: "Kilde", pdf: false },
          { nokkel: "konto", navn: "Konto", type: "tekst" },
          { nokkel: "navn", navn: "Kontonavn" },
          { nokkel: "tekst", navn: "Tekst" },
          { nokkel: "mva_kode", navn: "Mva-kode", type: "tekst" },
          { nokkel: "debet", navn: "Debet", type: "kr", sum: true },
          { nokkel: "kredit", navn: "Kredit", type: "kr", sum: true },
        ],
        rader,
      };
    },
  },
  {
    id: "regnskap.anleggsregister",
    modul: "regnskap",
    navn: "Anleggsregister",
    beskrivelse:
      "Anleggsmidlene ved utgangen av året (også goodwill): kostprisen, det som er avskrevet og nedskrevet, den bokførte verdien, årets avskrivning, levetiden og saldogruppen.",
    funksjon: "regnskap",
    tilgang: "regnskap",
    parameter: "aar",
    hent: async (db, org, v) => {
      const slutt = `${v.aar}-12-31`;
      const { anlegg, hendelser } = await hentAnlegg(db, org);
      const iDag = osloIDag();
      const sisteMnd = mnd(slutt < iDag ? slutt : iDag);
      const mangler: string[] = [];
      const rader = anlegg
        .filter((a) => a.anskaffet <= slutt && (!a.avgang_dato || a.avgang_dato >= `${v.aar}-01-01`))
        .map((a) => {
          const s = status(a, hendelser, slutt);
          const iAar = hendelser.filter((h) => h.anleggsmiddel_id === a.id && !h.reversert && h.type === "avskrivning" && h.dato.startsWith(`${v.aar}-`));
          if (avskrivningsplan(a, hendelser).some((p) => !p.bokfort && p.belop > 0 && p.maaned <= sisteMnd)) mangler.push(`${a.navn} (nr. ${a.nummer})`);
          return {
            nummer: a.nummer,
            navn: a.navn,
            kategori: KATEGORIER[a.kategori].navn,
            anskaffet: a.anskaffet,
            kostpris: a.kostpris,
            avskrevet: s.avskrevet,
            nedskrevet: s.nedskrevet,
            verdi: s.verdi,
            aarets: rund(iAar.reduce((t, h) => t + h.belop, 0)),
            levetid: levetid(a.levetid_mnd),
            saldogruppe: skattTekst(a.skatt),
            status: a.avgang_dato && a.avgang_dato <= slutt ? `${a.avgang_type === "salg" ? "Solgt" : "Utrangert"} ${visDato(a.avgang_dato)}` : s.tilstand === "avskrevet" ? "Avskrevet" : "I bruk",
          };
        });
      return {
        merknad: mangler.length
          ? `Avskrivningene er ikke bokført for alle månedene til og med ${maanedNavn(`${sisteMnd}-01`)} for: ${mangler.join(", ")}. Bokfør dem med månedsavslutningen under Regnskap → Anleggsmidler.`
          : "Verdiene er det som er bokført (avskrivningene måned for måned, nedskrivninger og avganger), og det som er avskrevet før anleggsmiddelet kom inn i HI4.",
        kolonner: [
          { nokkel: "nummer", navn: "Nr", type: "tekst" },
          { nokkel: "navn", navn: "Anleggsmiddel" },
          { nokkel: "kategori", navn: "Kategori", pdf: false },
          { nokkel: "anskaffet", navn: "Anskaffet", type: "dato" },
          { nokkel: "kostpris", navn: "Kostpris", type: "kr", sum: true },
          { nokkel: "avskrevet", navn: "Avskrevet", type: "kr", sum: true },
          { nokkel: "nedskrevet", navn: "Nedskrevet", type: "kr", sum: true },
          { nokkel: "verdi", navn: `Verdi 31.12.${v.aar}`, type: "kr", sum: true },
          { nokkel: "aarets", navn: "Avskrevet i år", type: "kr", sum: true },
          { nokkel: "levetid", navn: "Levetid" },
          { nokkel: "saldogruppe", navn: "Saldogruppe" },
          { nokkel: "status", navn: "Status" },
        ],
        rader,
      };
    },
  },
  {
    id: "regnskap.avskrivningsplan",
    modul: "regnskap",
    navn: "Avskrivningsplan",
    beskrivelse:
      "Avskrivningene år for år fra året som velges og ut levetiden (bokført for månedene som er bokført, ellers etter planen), med verdien ved inngangen og utgangen av hvert år.",
    funksjon: "regnskap",
    tilgang: "regnskap",
    parameter: "aar",
    hent: async (db, org, v) => {
      const { anlegg, hendelser } = await hentAnlegg(db, org);
      const perAar = new Map<number, number>();
      const rader = anlegg
        .filter((a) => !a.avgang_dato || Number(a.avgang_dato.slice(0, 4)) >= v.aar)
        .flatMap((a) =>
          aarsplan(a, hendelser)
            .filter((p) => p.aar >= v.aar)
            .map((p) => {
              perAar.set(p.aar, rund((perAar.get(p.aar) ?? 0) + p.avskrivning));
              return {
                nummer: a.nummer,
                navn: a.navn,
                aar: String(p.aar),
                inngaende: p.inngaende,
                avskrivning: p.avskrivning,
                nedskrivning: p.nedskrivning,
                avgang: p.avgang,
                utgaende: p.utgaende,
                grunnlag: p.bokfort ? "Bokført" : "Plan",
              };
            }),
        );
      const aarene = [...perAar.entries()].sort(([x], [y]) => x - y);
      return {
        merknad: aarene.length
          ? `Avskrivningene per år: ${aarene.map(([a, b]) => `${a}: ${krTekst(b)}`).join(", ")}. Lineært over levetiden ned til restverdien; en nedskrivning eller ny levetid gjelder framover.`
          : "Ingen anleggsmidler å avskrive.",
        kolonner: [
          { nokkel: "nummer", navn: "Nr", type: "tekst" },
          { nokkel: "navn", navn: "Anleggsmiddel" },
          { nokkel: "aar", navn: "År" },
          { nokkel: "inngaende", navn: "Verdi 1.1.", type: "kr" },
          { nokkel: "avskrivning", navn: "Avskrivning", type: "kr", sum: true },
          { nokkel: "nedskrivning", navn: "Nedskrivning", type: "kr", sum: true },
          { nokkel: "avgang", navn: "Avgang", type: "kr", sum: true },
          { nokkel: "utgaende", navn: "Verdi 31.12.", type: "kr" },
          { nokkel: "grunnlag", navn: "" },
        ],
        rader,
      };
    },
  },
  {
    id: "regnskap.avskrivninger",
    modul: "regnskap",
    navn: "Avskrivninger og avganger",
    beskrivelse: "Det som er bokført for anleggsmidlene i perioden: avskrivningene, nedskrivninger og reverseringer, anskaffelser, salg og utrangering, med bilaget.",
    funksjon: "regnskap",
    tilgang: "regnskap",
    parameter: "periode",
    maanedlig: true,
    hent: async (db, org, v) => {
      const { anlegg, hendelser } = await hentAnlegg(db, org);
      const navn = new Map(anlegg.map((a) => [a.id, a]));
      const rader = hendelser
        .filter((h) => !h.reversert && h.dato >= v.fra && h.dato <= v.til)
        .sort((x, y) => x.dato.localeCompare(y.dato) || x.bilag.localeCompare(y.bilag, "nb", { numeric: true }))
        .map((h) => {
          const a = navn.get(h.anleggsmiddel_id)!;
          return {
            dato: h.dato,
            bilag: h.bilag,
            nummer: a.nummer,
            navn: a.navn,
            hva:
              h.type === "avskrivning"
                ? `Avskrivning ${maanedNavn(`${h.maaned}-01`)}`
                : h.type === "avgang"
                  ? a.avgang_type === "utrangering"
                    ? "Utrangering"
                    : "Salg"
                  : `${HVA[h.type]}${h.tekst ? `: ${h.tekst}` : ""}`,
            avskrivning: h.type === "avskrivning" ? h.belop : null,
            nedskrivning: h.type === "nedskrivning" ? h.belop : h.type === "reversering" ? -h.belop : null,
            anskaffelse: h.type === "anskaffelse" ? h.belop : null,
            ut: h.type === "avgang" ? h.belop : null,
            vederlag: h.type === "avgang" ? h.vederlag : null,
          };
        });
      return {
        merknad: "Bilagene er i serie A. Reverserte bilag er ikke med.",
        kolonner: [
          { nokkel: "dato", navn: "Dato", type: "dato" },
          { nokkel: "bilag", navn: "Bilag" },
          { nokkel: "nummer", navn: "Nr", type: "tekst" },
          { nokkel: "navn", navn: "Anleggsmiddel" },
          { nokkel: "hva", navn: "Hva" },
          { nokkel: "avskrivning", navn: "Avskrivning", type: "kr", sum: true },
          { nokkel: "nedskrivning", navn: "Nedskrivning", type: "kr", sum: true },
          { nokkel: "anskaffelse", navn: "Anskaffet", type: "kr", sum: true },
          { nokkel: "ut", navn: "Verdi ut", type: "kr", sum: true },
          { nokkel: "vederlag", navn: "Salgssum", type: "kr", sum: true },
        ],
        rader,
      };
    },
  },
  {
    id: "regnskap.saldoskjema",
    modul: "regnskap",
    navn: "Saldoskjema (skattemessige avskrivninger)",
    beskrivelse:
      "Saldoavskrivningene for året (skatteloven kapittel 14): saldogruppene a–j, goodwill i gruppe b, lineære avskrivninger og gevinst- og tapskontoen, med forskjellen mot den regnskapsmessige verdien.",
    funksjon: "regnskap",
    tilgang: "regnskap",
    parameter: "aar",
    hent: async (db, org, v) => {
      const s = await hentSaldo(db, org, v.aar);
      return {
        merknad: `${v.aar < s.fra_aar ? `Saldoene regnes fra ${s.fra_aar}. ` : `Saldoene regnes fra ${s.fra_aar}${s.oppsett.saldo_fra_aar ? "" : " (velg første år og inngående saldoer under Regnskap → Saldoavskrivninger)"}. `}Avskrivning: fradrag (negativt er inntektsføring). Forskjell: regnskapsmessig verdi minus skattemessig saldo (midlertidig forskjell). Kontroller satsene og saldoene mot skattemeldingen.`,
        kolonner: [
          { nokkel: "navn", navn: "Saldo" },
          { nokkel: "inngaende", navn: "Inngående", type: "kr" },
          { nokkel: "tilgang", navn: "Tilgang", type: "kr" },
          { nokkel: "vederlag", navn: "Vederlag", type: "kr" },
          { nokkel: "grunnlag", navn: "Grunnlag", type: "kr" },
          { nokkel: "sats", navn: "Sats", type: "prosent" },
          { nokkel: "avskrivning", navn: "Avskrivning", type: "kr", sum: true },
          { nokkel: "gevinst_tap", navn: "Gevinst/tap", type: "kr", sum: true },
          { nokkel: "utgaende", navn: "Utgående", type: "kr" },
          { nokkel: "regnskap", navn: "Regnskap", type: "kr", pdf: false },
          { nokkel: "forskjell", navn: "Forskjell", type: "kr", sum: true, pdf: false },
          { nokkel: "merknad", navn: "Merknad", pdf: false },
        ],
        rader: s.rader.map((r) => ({ ...r })),
      };
    },
  },
  {
    id: "regnskap.periodiseringer",
    modul: "regnskap",
    navn: "Periodiseringer",
    beskrivelse:
      "Periodiseringene i perioden (forskuddsbetalte og påløpte kostnader, uopptjente og opptjente inntekter): beløpet, månedene, det som er fordelt i perioden og til og med perioden, og det som står igjen.",
    funksjon: "regnskap",
    tilgang: "regnskap",
    parameter: "periode",
    hent: async (db, org, v) => {
      const { periodiseringer, poster } = await hentPeriodiseringer(db, org);
      const [fraM, tilM] = [mnd(v.fra), mnd(v.til)];
      const iDag = mnd(osloIDag());
      const sisteMnd = tilM < iDag ? tilM : iDag;
      const mangler: string[] = [];
      const rader = periodiseringer.flatMap((p) => {
        const mine = poster.filter((x) => x.periodisering_id === p.id && !x.reversert && x.type === "maaned");
        const sum = (l: typeof mine) => rund(l.reduce((t, x) => t + x.belop, 0));
        const fordelt = sum(mine.filter((x) => x.maaned! <= tilM));
        const igjen = rund(p.belop - fordelt);
        const slutt = sisteMaaned(p);
        if (mnd(p.fra) > tilM || (slutt < fraM && igjen <= 0)) return [];
        const s = periodiseringsstatus(p, poster);
        if (s.neste && s.neste.maaned <= sisteMnd) mangler.push(`${p.navn} (nr. ${p.nummer})`);
        return [
          {
            nummer: p.nummer,
            navn: p.navn,
            type: PERIODISERINGSTYPER[p.type].navn,
            kontoer: `${p.resultatkonto} / ${p.balansekonto}`,
            belop: p.belop,
            maaneder: `${kortMnd(mnd(p.fra))}–${kortMnd(slutt)}`,
            i_perioden: sum(mine.filter((x) => x.maaned! >= fraM && x.maaned! <= tilM)),
            fordelt,
            igjen,
            status: s.ferdig ? "Ferdig" : s.neste ? `Neste: ${maanedNavn(`${s.neste.maaned}-01`)}` : "",
          },
        ];
      });
      return {
        merknad: mangler.length
          ? `Periodiseringene er ikke bokført for alle månedene til og med ${maanedNavn(`${sisteMnd}-01`)} for: ${mangler.join(", ")}. Bokfør dem med månedsavslutningen under Regnskap → Periodiseringer.`
          : "Fordelt: det som er bokført måned for måned (bilagserie P). Kontoer: resultatkontoen / balansekontoen.",
        kolonner: [
          { nokkel: "nummer", navn: "Nr", type: "tekst" },
          { nokkel: "navn", navn: "Periodisering" },
          { nokkel: "type", navn: "Type", pdf: false },
          { nokkel: "kontoer", navn: "Kontoer" },
          { nokkel: "belop", navn: "Beløp", type: "kr", sum: true },
          { nokkel: "maaneder", navn: "Måneder" },
          { nokkel: "i_perioden", navn: "I perioden", type: "kr", sum: true },
          { nokkel: "fordelt", navn: "Fordelt til og med", type: "kr", sum: true },
          { nokkel: "igjen", navn: "Igjen", type: "kr", sum: true },
          { nokkel: "status", navn: "Status" },
        ],
        rader,
      };
    },
  },
];
