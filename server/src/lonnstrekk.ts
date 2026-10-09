// Faste trekk i lønnen (0082_lonnstrekk.sql): trekk etter pålegg (utleggstrekk og bidragstrekk),
// fagforeningskontingent, tilbakebetaling av forskudd på lønn og andre trekk, per ansatt.
//
// Den ordinære lønnskjøringen trekker dem i to steg: fagforeningskontingenten først (den gjør
// grunnlaget for forskuddstrekket mindre), og de andre etter forskuddstrekket, i rekkefølgen
// dekningsloven gir (bidrag før utlegg, så forskudd og andre trekk; innen samme type det eldste
// først), aldri mer enn det som er igjen av nettolønnen. Et trekk med en sum (forskudd, pålegg med
// et restbeløp) stopper når summen er trukket. Trekkene for pålegg er i hele kroner.
import type { Linje } from "./lonnsberegning.js";

export type Trekktype = "utlegg_samordnet" | "utlegg_skatt" | "utlegg_annet" | "bidrag" | "fagforening" | "forskudd" | "annet";

export type Lonnstrekk = {
  id: string;
  ansatt_id: string;
  type: Trekktype;
  tekst: string | null;
  belop: number | null;
  prosent: number | null;
  totalt: number | null;
  fra: string;
  til: string | null;
  mottaker: string | null;
  kontonr: string | null;
  kid: string | null;
  melding: string | null;
};

// Lønnsarten, navnet, rekkefølgen og om trekket er i hele kroner, for hver type.
export const TREKKTYPER: Record<Trekktype, { lonnsart: string; navn: string; rekke: number; heleKroner: boolean }> = {
  bidrag: { lonnsart: "bidragstrekk", navn: "Bidragstrekk", rekke: 1, heleKroner: true },
  utlegg_samordnet: { lonnsart: "utleggstrekk_samordnet", navn: "Utleggstrekk (samordnet, Skatteetaten)", rekke: 2, heleKroner: true },
  utlegg_skatt: { lonnsart: "utleggstrekk_skatt", navn: "Utleggstrekk for skattekrav", rekke: 3, heleKroner: true },
  utlegg_annet: { lonnsart: "utleggstrekk", navn: "Utleggstrekk (namsmannen og andre)", rekke: 4, heleKroner: true },
  forskudd: { lonnsart: "forskudd_trekk", navn: "Tilbakebetaling av forskudd", rekke: 5, heleKroner: false },
  annet: { lonnsart: "trekk_etter_skatt", navn: "Trekk", rekke: 6, heleKroner: false },
  fagforening: { lonnsart: "fagforening", navn: "Fagforeningskontingent", rekke: 0, heleKroner: false },
};
export const TREKK_LONNSARTER = Object.values(TREKKTYPER).map((t) => t.lonnsart);

const rund = (n: number) => Math.round(n * 100) / 100;
const kr = (n: number) => `${n.toLocaleString("nb-NO", { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 }).replace(/[\u00a0\u202f]/g, " ")} kr`;

// Nøkkelen på linjen for et trekk (så en linje som er endret eller fjernet for hånd, gjelder).
export const trekkNokkel = (id: string) => `trekk:${id}`;

// Trekkene som gjelder i perioden (minst én dag), i rekkefølgen de trekkes.
export function aktive(trekk: Lonnstrekk[], fra: string, til: string): Lonnstrekk[] {
  return trekk
    .filter((t) => t.fra <= til && (!t.til || t.til >= fra))
    .sort((x, y) => TREKKTYPER[x.type].rekke - TREKKTYPER[y.type].rekke || x.fra.localeCompare(y.fra) || x.id.localeCompare(y.id));
}

const navn = (t: Lonnstrekk) => `${TREKKTYPER[t.type].navn}${t.tekst ? ` – ${t.tekst}` : ""}`;

// Ett trekk: beløpet eller prosenten av bruttolønnen, høyst det som er igjen av summen.
function onsket(t: Lonnstrekk, brutto: number, trukket: number): { belop: number; igjen: number | null } {
  let b = t.belop != null ? Number(t.belop) : (Math.max(0, brutto) * Number(t.prosent ?? 0)) / 100;
  const igjen = t.totalt != null ? Math.max(0, rund(Number(t.totalt) - trukket)) : null;
  if (igjen != null) b = Math.min(b, igjen);
  b = TREKKTYPER[t.type].heleKroner ? Math.floor(b + 1e-9) : rund(b);
  return { belop: Math.max(0, b), igjen };
}

// Fagforeningskontingenten (før forskuddstrekket).
export function fagforeningslinjer(trekk: Lonnstrekk[], brutto: number, trukket: (id: string) => number): Linje[] {
  const ut: Linje[] = [];
  for (const t of trekk.filter((x) => x.type === "fagforening")) {
    const { belop } = onsket(t, brutto, trukket(t.id));
    if (belop > 0) ut.push({ lonnsart: "fagforening", tekst: navn(t), antall: null, sats: t.prosent != null ? Number(t.prosent) : null, belop: -belop, nokkel: trekkNokkel(t.id) });
  }
  return ut;
}

// De andre trekkene, etter forskuddstrekket: aldri mer enn nettolønnen som er igjen.
export function trekkEtterSkatt(trekk: Lonnstrekk[], brutto: number, netto: number, trukket: (id: string) => number): { linjer: Linje[]; merknader: string[] } {
  const linjer: Linje[] = [];
  const merknader: string[] = [];
  let rest = Math.max(0, rund(netto));
  for (const t of trekk.filter((x) => x.type !== "fagforening")) {
    const tidligere = trukket(t.id);
    const { belop: vil, igjen } = onsket(t, brutto, tidligere);
    if (igjen === 0) {
      merknader.push(`${navn(t)} er ferdig trukket (${kr(Number(t.totalt))}).`);
      continue;
    }
    const heleKroner = TREKKTYPER[t.type].heleKroner;
    const belop = Math.min(vil, heleKroner ? Math.floor(rest + 1e-9) : rest);
    if (belop < vil) merknader.push(`${navn(t)} er ${belop > 0 ? `redusert til ${kr(belop)}` : "ikke trukket"} fordi nettolønnen ikke rekker (trekket er ${kr(vil)}).`);
    if (belop <= 0) continue;
    rest = rund(rest - belop);
    const etter = igjen != null ? rund(igjen - belop) : null;
    linjer.push({
      lonnsart: TREKKTYPER[t.type].lonnsart,
      tekst: etter != null ? `${navn(t)} (${etter > 0 ? `${kr(etter)} igjen` : "siste trekk"})` : navn(t),
      antall: null,
      sats: t.prosent != null ? Number(t.prosent) : null,
      belop: -belop,
      nokkel: trekkNokkel(t.id),
    });
  }
  return { linjer, merknader };
}
