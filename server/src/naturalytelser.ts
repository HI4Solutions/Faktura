// Naturalytelser (0083_naturalytelser_reiser.sql): de faste fordelene per ansatt som lønnslinjer i
// den ordinære lønnskjøringen, for hver måned de gjelder (påbegynt måned). De er trekkpliktige og
// gir arbeidsgiveravgift, men utbetales ikke (lønnsartene natural_*; i a-meldingen med fordelen
// naturalytelse).
//
// Fri bil (standardregelen): 30 % av listeprisen som ny opp til innslagspunktet og 20 % av det som
// er over, per år, og 75 % av det når bilen er eldre enn tre år ved årets begynnelse eller
// yrkeskjøringen er over 40 000 km (begge: 56,25 %); en tolvtedel per måned. Elbiler har ingen
// rabatt. Elektronisk kommunikasjon (arbeidsgiveren er abonnent): sjablongen 4 392 kr i året, 366
// kr per måned. Rentefordel: lånet ganger normrenten minus renten den ansatte betaler, per måned.
// Forsikring (den skattepliktige delen av premien), fri bolig og andre: beløpet per måned.
import { rund, tall, type Linje } from "./lonnsberegning.js";

export type Naturaltype = "bil" | "ek" | "forsikring" | "rentefordel" | "bolig" | "annet";
export type Naturalytelse = {
  id: string;
  ansatt_id: string;
  type: Naturaltype;
  tekst: string | null;
  belop: number | null;
  listepris: number | null;
  regnr: string | null;
  bilpool: boolean;
  forstegangsreg: string | null;
  yrkeskjoring: boolean;
  laan: number | null;
  rente: number | null;
  fra: string;
  til: string | null;
};

export const NATURALTYPER: Record<Naturaltype, { lonnsart: string; navn: string }> = {
  bil: { lonnsart: "natural_bil", navn: "Fri bil" },
  ek: { lonnsart: "natural_ek", navn: "Elektronisk kommunikasjon" },
  forsikring: { lonnsart: "natural_forsikring", navn: "Forsikring" },
  rentefordel: { lonnsart: "natural_rente", navn: "Rentefordel på lån" },
  bolig: { lonnsart: "natural_bolig", navn: "Fri bolig" },
  annet: { lonnsart: "natural_annet", navn: "Annen naturalytelse" },
};

// Innslagspunktet for fri bil (listeprisen der satsen går fra 30 til 20 %), per år.
export const BIL_INNSLAG: Record<number, number> = { 2025: 362_300, 2026: 370_300 };
// Sjablongen for elektronisk kommunikasjon per år.
export const EK_SJABLONG = 4392;
// Normrenten (prosent per år) fra og med måneden; Skatteetaten setter den for to måneder om gangen.
// Nye perioder legges inn her.
export const NORMRENTE: [string, number][] = [
  ["2026-01", 4.8],
  ["2026-03", 4.8],
  ["2026-05", 4.8],
  ["2026-07", 4.8],
  ["2026-09", 4.7],
];

const MND = ["januar", "februar", "mars", "april", "mai", "juni", "juli", "august", "september", "oktober", "november", "desember"];
const plussMaaneder = (m: string, n: number) => {
  const t = Number(m.slice(0, 4)) * 12 + Number(m.slice(5, 7)) - 1 + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`;
};

// Normrenten for måneden (ÅÅÅÅ-MM), og om perioden er lagt inn (ellers er den siste brukt).
export function normrente(maaned: string): { prosent: number; kjent: boolean } {
  const g = [...NORMRENTE].reverse().find(([m]) => m <= maaned) ?? NORMRENTE[0]!;
  return { prosent: g[1], kjent: g[0] <= maaned && maaned < plussMaaneder(g[0], 2) };
}

// Fordelen av fri bil i året og per måned.
export function bilfordel(listepris: number, aar: number, forstegangsreg: string | null, yrkeskjoring: boolean) {
  const aarene = Object.keys(BIL_INNSLAG)
    .map(Number)
    .sort((a, b) => a - b);
  const innslag = BIL_INNSLAG[[...aarene].reverse().find((a) => a <= aar) ?? aarene[0]!]!;
  const grunnlag = 0.3 * Math.min(listepris, innslag) + 0.2 * Math.max(0, listepris - innslag);
  const gammel = !!forstegangsreg && forstegangsreg < `${aar - 3}-01-01`;
  const faktor = (gammel ? 0.75 : 1) * (yrkeskjoring ? 0.75 : 1);
  return { aar: rund(grunnlag * faktor), maaned: rund((grunnlag * faktor) / 12), faktor, gammel, innslag };
}

// Fordelen per måned for én naturalytelse (månedens første dag gir året og normrenten).
export function maanedsfordel(n: Naturalytelse, periode: string): { belop: number; tekst: string; merknad: string | null } {
  const t = NATURALTYPER[n.type];
  const navn = n.tekst ? `${t.navn} – ${n.tekst}` : t.navn;
  switch (n.type) {
    case "bil": {
      const b = bilfordel(Number(n.listepris), Number(periode.slice(0, 4)), n.forstegangsreg, n.yrkeskjoring);
      const hvem = n.bilpool ? "bilpool" : (n.regnr ?? "");
      const rabatt = b.faktor < 1 ? `, ${tall(rund(b.faktor * 100))} %` : "";
      return { belop: b.maaned, tekst: `${navn} ${hvem} (listepris ${tall(Number(n.listepris))} kr${rabatt})`, merknad: null };
    }
    case "ek":
      return { belop: rund(Math.min(n.belop != null ? Number(n.belop) : Infinity, EK_SJABLONG / 12)), tekst: `${navn} (sjablong)`, merknad: null };
    case "rentefordel": {
      const maaned = periode.slice(0, 7);
      const r = normrente(maaned);
      const belop = rund((Number(n.laan) * Math.max(0, r.prosent - Number(n.rente))) / 100 / 12);
      return {
        belop,
        tekst: `${navn} (${tall(Number(n.laan))} kr, normrente ${tall(r.prosent)} %, rente ${tall(Number(n.rente))} %)`,
        merknad: r.kjent
          ? null
          : `Normrenten for ${MND[Number(maaned.slice(5, 7)) - 1]} ${maaned.slice(0, 4)} er ikke lagt inn; ${tall(r.prosent)} % er brukt for rentefordelen. Sjekk den på skatteetaten.no.`,
      };
    }
    default:
      return { belop: rund(Number(n.belop)), tekst: navn, merknad: null };
  }
}

// Linjene for måneden fra–til: hver naturalytelse som gjelder minst én dag i måneden.
export function naturallinjer(liste: Naturalytelse[], fra: string, til: string): { linjer: Linje[]; merknader: string[] } {
  const linjer: Linje[] = [];
  const merknader: string[] = [];
  for (const n of liste) {
    if (n.fra > til || (n.til && n.til < fra)) continue;
    const f = maanedsfordel(n, fra);
    if (f.merknad && !merknader.includes(f.merknad)) merknader.push(f.merknad);
    if (f.belop <= 0) continue;
    linjer.push({
      lonnsart: NATURALTYPER[n.type].lonnsart,
      tekst: f.tekst.length > 120 ? `${f.tekst.slice(0, 119)}…` : f.tekst,
      antall: null,
      sats: null,
      belop: f.belop,
      nokkel: `natural:${n.id}`,
      tillegg: n.type === "bil" ? { listepris: Number(n.listepris), regnr: n.bilpool ? null : n.regnr, bilpool: n.bilpool } : null,
    });
  }
  return { linjer, merknader };
}
