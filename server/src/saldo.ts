// De skattemessige avskrivningene (skatteloven kapittel 14, saldoavskrivning), regnet fra
// anleggsregisteret (anlegg.ts) år for år: saldoskjemaet til næringsspesifikasjonen.
//
// - Samlesaldo for gruppe a, c og d: saldoen ved inngangen til året, pluss det som er anskaffet i
//   året (full sats uansett når i året), minus vederlaget for det som er solgt, ganger satsen.
//   Er grunnlaget under 15 000 kr, fradragsføres alt. Blir saldoen negativ, inntektsføres en
//   andel lik satsen (alt når den er under 15 000 kr).
// - Egen saldo for hvert driftsmiddel i gruppe b (goodwill) og e–j. Når det selges eller
//   utrangeres, går forskjellen mellom vederlaget og saldoen til gevinst- og tapskontoen. Gruppe j
//   har samme regel om lav saldo som a, c og d.
// - Lineært: immaterielle rettigheter som taper seg i verdi, over den gjenværende levetiden.
// - Ingen avskrivning (tomt o.l.): gevinst eller tap ved salg går til gevinst- og tapskontoen.
// - Gevinst- og tapskontoen: minst 20 % av en positiv saldo inntektsføres hvert år, og 20 % av en
//   negativ saldo kan fradragsføres (alt når saldoen er under 15 000 kr).
//
// Saldoene regnes fra det første året i HI4 (oppsettet), med saldoene ved inngangen til det året.
// Driftsmidler anskaffet før det året er med i inngående saldo (samlesaldo) eller har sin egen
// inngående saldo. Satsen kan settes lavere for et år og en gruppe (saldo_satser), og for det
// enkelte driftsmiddelet med egen saldo (f.eks. bygg med kort brukstid, høyst 10 %).
import type { Anleggsmiddel, Regnskapsoppsett, Saldogruppe, Skatt } from "./anlegg.js";
import { mnd, mndMellom, plussMnd } from "./anlegg.js";

export const SALDOGRUPPER: Record<Saldogruppe, { navn: string; sats: number; samlet: boolean; lav: boolean }> = {
  a: { navn: "Kontormaskiner o.l.", sats: 30, samlet: true, lav: true },
  b: { navn: "Ervervet forretningsverdi (goodwill)", sats: 20, samlet: false, lav: false },
  c: { navn: "Vogntog, lastebiler, busser, varebiler, drosjebiler o.l.", sats: 24, samlet: true, lav: true },
  d: { navn: "Personbiler, traktorer, maskiner, redskap, instrumenter, inventar o.l.", sats: 20, samlet: true, lav: true },
  e: { navn: "Skip, fartøyer, rigger o.l.", sats: 14, samlet: false, lav: false },
  f: { navn: "Fly og helikoptre", sats: 12, samlet: false, lav: false },
  g: { navn: "Anlegg for overføring og distribusjon av elektrisk kraft o.l.", sats: 5, samlet: false, lav: false },
  h: { navn: "Bygg og anlegg, hoteller, losjihus, bevertningssteder o.l.", sats: 4, samlet: false, lav: false },
  i: { navn: "Forretningsbygg", sats: 2, samlet: false, lav: false },
  j: { navn: "Fast teknisk installasjon i bygninger", sats: 10, samlet: false, lav: true },
};
export const GRUPPER = Object.keys(SALDOGRUPPER) as Saldogruppe[];
export const SAMLESALDO = ["a", "c", "d"] as const;
export const LAV_SALDO = 15000;
export const GEVINST_TAP_SATS = 20;
// Den høyeste satsen for ett driftsmiddel med egen saldo (bygg med kort brukstid i gruppe h).
export const maksSats = (g: Saldogruppe, enkelt = false) => (g === "h" && enkelt ? 10 : SALDOGRUPPER[g].sats);

export type Saldorad = {
  type: "samlet" | "enkelt" | "lineaer" | "ingen" | "gevinst_tap";
  gruppe: Saldogruppe | null;
  anleggsmiddel_id: string | null;
  nummer: number | null;
  navn: string;
  inngaende: number;
  tilgang: number;
  vederlag: number;
  grunnlag: number;
  sats: number | null;
  // Fradrag (positivt) eller inntektsføring (negativt).
  avskrivning: number;
  // Til gevinst- og tapskontoen (positivt: gevinst).
  gevinst_tap: number;
  utgaende: number;
  merknad: string;
};
export type Saldoskjema = {
  aar: number;
  fra_aar: number;
  rader: Saldorad[];
  sum: { avskrivning: number; inntekt: number; gevinst_tap: number };
};

const rund = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const hel = (n: number) => Math.round(n);
const aarAv = (d: string) => Number(d.slice(0, 4));
const skattKost = (a: Anleggsmiddel) => a.skatt_kostpris ?? a.kostpris;
const navnPaa = (a: Anleggsmiddel) => `${a.navn} (nr. ${a.nummer})`;

// Avskrivning av et grunnlag: fradrag med satsen (alt under 15 000 kr der regelen gjelder), og
// inntektsføring av en negativ saldo på samme måte.
function avskriv(grunnlag: number, sats: number, lav: boolean) {
  if (grunnlag >= 0) return lav && grunnlag < LAV_SALDO ? rund(grunnlag) : hel((grunnlag * sats) / 100);
  return lav && -grunnlag < LAV_SALDO ? rund(grunnlag) : -hel((-grunnlag * sats) / 100);
}

// Det første året saldoene regnes: oppsettet; ellers året etter det som er ført i et annet system
// (det tidligste), eller det første året et driftsmiddel ble anskaffet.
export function forsteAar(anlegg: Anleggsmiddel[], o: Pick<Regnskapsoppsett, "saldo_fra_aar">, aar: number) {
  if (o.saldo_fra_aar) return o.saldo_fra_aar;
  const tidligere = anlegg.filter((a) => a.tidligere_til).map((a) => aarAv(plussMnd(mnd(a.tidligere_til!), 1)));
  if (tidligere.length) return Math.min(...tidligere);
  const aarene = anlegg.map((a) => aarAv(a.anskaffet));
  return aarene.length ? Math.min(...aarene) : aar;
}

// Skattemessig verdi ved inngangen til det første året for et driftsmiddel anskaffet før:
// det som er lagt inn, ellers (lineært og uten avskrivning) regnet fra kostprisen.
function inngaendeVerdi(a: Anleggsmiddel, fra: number) {
  if (a.skatt_inngaende != null) return Number(a.skatt_inngaende);
  if (a.skatt === "ingen") return skattKost(a);
  if (a.skatt === "lineaer" && a.levetid_mnd) {
    const brukt = Math.min(a.levetid_mnd, Math.max(0, mndMellom(mnd(a.avskrives_fra), `${fra}-01`)));
    return rund((skattKost(a) * (a.levetid_mnd - brukt)) / a.levetid_mnd);
  }
  return 0;
}

export function saldoskjema(
  aar: number,
  anlegg: Anleggsmiddel[],
  o: Pick<Regnskapsoppsett, "saldo_fra_aar" | "saldo_inngaende">,
  satser: Record<string, number> = {}, // «2026:d» → sats
): Saldoskjema {
  const fra = forsteAar(anlegg, o, aar);
  const sats = (y: number, g: Saldogruppe, a?: Anleggsmiddel) => a?.skatt_sats ?? satser[`${y}:${g}`] ?? SALDOGRUPPER[g].sats;
  const iAar = (a: Anleggsmiddel, y: number) => aarAv(a.anskaffet) === y && y >= fra;
  const solgtI = (a: Anleggsmiddel, y: number) => !!a.avgang_dato && aarAv(a.avgang_dato) === y;
  const rader: Saldorad[] = [];
  if (aar < fra) return { aar, fra_aar: fra, rader, sum: { avskrivning: 0, inntekt: 0, gevinst_tap: 0 } };

  // Samlesaldoene.
  for (const g of SAMLESALDO) {
    const mine = anlegg.filter((a) => a.skatt === g);
    let ub = Number(o.saldo_inngaende[g] ?? 0);
    for (let y = fra; y <= aar; y++) {
      const ib = ub;
      const nye = mine.filter((a) => iAar(a, y));
      const solgte = mine.filter((a) => solgtI(a, y) && aarAv(a.anskaffet) <= y);
      const tilgang = rund(nye.reduce((s, a) => s + skattKost(a), 0));
      const vederlag = rund(solgte.reduce((s, a) => s + Number(a.avgang_vederlag ?? 0), 0));
      const grunnlag = rund(ib + tilgang - vederlag);
      const s = sats(y, g);
      const avskr = avskriv(grunnlag, s, SALDOGRUPPER[g].lav);
      ub = rund(grunnlag - avskr);
      if (y === aar && (ib || tilgang || vederlag || mine.some((a) => aarAv(a.anskaffet) <= y && (!a.avgang_dato || aarAv(a.avgang_dato) >= y))))
        rader.push({
          type: "samlet",
          gruppe: g,
          anleggsmiddel_id: null,
          nummer: null,
          navn: `Gruppe ${g}: ${SALDOGRUPPER[g].navn}`,
          inngaende: ib,
          tilgang,
          vederlag,
          grunnlag,
          sats: s,
          avskrivning: avskr,
          gevinst_tap: 0,
          utgaende: ub,
          merknad: [
            nye.length ? `Tilgang: ${nye.map(navnPaa).join(", ")}.` : "",
            solgte.length ? `Solgt eller utrangert: ${solgte.map(navnPaa).join(", ")}.` : "",
            grunnlag >= 0 && SALDOGRUPPER[g].lav && grunnlag < LAV_SALDO && grunnlag > 0 ? "Saldo under 15 000 kr: fradragsført i sin helhet." : "",
            grunnlag < 0 ? "Negativ saldo: inntektsføres." : "",
          ]
            .filter(Boolean)
            .join(" "),
        });
    }
  }

  // Egen saldo, lineært og uten avskrivning: driftsmiddel for driftsmiddel.
  let gevinstTap = Number(o.saldo_inngaende.gevinst_tap ?? 0);
  const gtPerAar = new Map<number, number>();
  const leggGt = (y: number, b: number) => gtPerAar.set(y, rund((gtPerAar.get(y) ?? 0) + b));
  for (const a of anlegg.filter((x) => !(SAMLESALDO as readonly Skatt[]).includes(x.skatt))) {
    const start = Math.max(fra, aarAv(a.anskaffet));
    const slutt = a.avgang_dato ? Math.min(aar, aarAv(a.avgang_dato)) : aar;
    const forFra = aarAv(a.anskaffet) < fra;
    let ub = forFra ? inngaendeVerdi(a, fra) : 0;
    for (let y = start; y <= slutt; y++) {
      const ib = ub;
      const tilgang = iAar(a, y) ? skattKost(a) : 0;
      const grunnlag = rund(ib + tilgang);
      let avskr = 0;
      let gt = 0;
      let s: number | null = null;
      let merknad = "";
      if (solgtI(a, y)) {
        gt = rund(Number(a.avgang_vederlag ?? 0) - grunnlag);
        ub = 0;
        merknad = `${a.avgang_type === "salg" ? "Solgt" : "Utrangert"}: ${gt >= 0 ? "gevinst" : "tap"} til gevinst- og tapskontoen.`;
        leggGt(y, gt);
      } else if (a.skatt === "ingen") {
        ub = grunnlag;
        merknad = "Avskrives ikke.";
      } else if (a.skatt === "lineaer") {
        // Lineært over månedene som er igjen av levetiden (fra inngangen til året).
        const sisteMnd = a.levetid_mnd ? plussMnd(mnd(a.avskrives_fra), a.levetid_mnd - 1) : `${y}-12`;
        const fraMnd = `${y}-01` > mnd(a.avskrives_fra) ? `${y}-01` : mnd(a.avskrives_fra);
        const igjen = mndMellom(fraMnd, sisteMnd) + 1;
        const iAaret = Math.max(0, Math.min(igjen, mndMellom(fraMnd, `${y}-12`) + 1));
        avskr = igjen <= 0 ? grunnlag : igjen <= iAaret ? grunnlag : hel((grunnlag * iAaret) / igjen);
        ub = rund(grunnlag - avskr);
        merknad = "Lineært over levetiden.";
      } else {
        const g = a.skatt as Saldogruppe;
        s = sats(y, g, a);
        avskr = avskriv(grunnlag, s, SALDOGRUPPER[g].lav);
        ub = rund(grunnlag - avskr);
        if (SALDOGRUPPER[g].lav && grunnlag > 0 && grunnlag < LAV_SALDO) merknad = "Saldo under 15 000 kr: fradragsført i sin helhet.";
        if (forFra && y === fra && a.skatt_inngaende == null) merknad = "Inngående saldo mangler: legg den inn på anleggsmiddelet.";
      }
      if (y === aar)
        rader.push({
          type: a.skatt === "lineaer" ? "lineaer" : a.skatt === "ingen" ? "ingen" : "enkelt",
          gruppe: a.skatt === "lineaer" || a.skatt === "ingen" ? null : (a.skatt as Saldogruppe),
          anleggsmiddel_id: a.id,
          nummer: a.nummer,
          navn: a.skatt === "lineaer" || a.skatt === "ingen" ? navnPaa(a) : `Gruppe ${a.skatt}: ${navnPaa(a)}`,
          inngaende: ib,
          tilgang,
          vederlag: solgtI(a, y) ? Number(a.avgang_vederlag ?? 0) : 0,
          grunnlag,
          sats: s,
          avskrivning: avskr,
          gevinst_tap: gt,
          utgaende: ub,
          merknad,
        });
    }
  }

  // Gevinst- og tapskontoen.
  let gtRad: Saldorad | null = null;
  for (let y = fra; y <= aar; y++) {
    const ib = gevinstTap;
    const tillegg = gtPerAar.get(y) ?? 0;
    const grunnlag = rund(ib + tillegg);
    // Inntektsføring av en positiv saldo er negativ avskrivning; fradrag for en negativ saldo positiv.
    const avskr = grunnlag === 0 ? 0 : -avskriv(grunnlag, GEVINST_TAP_SATS, true);
    gevinstTap = rund(grunnlag + avskr);
    if (y === aar && (ib || tillegg))
      gtRad = {
        type: "gevinst_tap",
        gruppe: null,
        anleggsmiddel_id: null,
        nummer: null,
        navn: "Gevinst- og tapskonto",
        inngaende: ib,
        tilgang: tillegg,
        vederlag: 0,
        grunnlag,
        sats: GEVINST_TAP_SATS,
        avskrivning: avskr,
        gevinst_tap: 0,
        utgaende: gevinstTap,
        merknad:
          grunnlag > 0
            ? `${grunnlag < LAV_SALDO ? "Under 15 000 kr: inntektsført i sin helhet." : "20 % inntektsføres."}`
            : grunnlag < 0
              ? `${-grunnlag < LAV_SALDO ? "Under 15 000 kr: fradragsført i sin helhet." : "20 % fradragsføres."}`
              : "",
      };
  }
  if (gtRad) rader.push(gtRad);
  const sumAv = (f: (r: Saldorad) => number) => rund(rader.reduce((s, r) => s + f(r), 0));
  return {
    aar,
    fra_aar: fra,
    rader,
    sum: {
      avskrivning: sumAv((r) => (r.avskrivning > 0 ? r.avskrivning : 0)),
      inntekt: sumAv((r) => (r.avskrivning < 0 ? -r.avskrivning : 0)),
      gevinst_tap: sumAv((r) => r.gevinst_tap),
    },
  };
}
