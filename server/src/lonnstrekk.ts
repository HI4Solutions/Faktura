// Faste trekk i lønnen (0082_lonnstrekk.sql): trekk etter pålegg (utleggstrekk og bidragstrekk),
// fagforeningskontingent, tilbakebetaling av forskudd på lønn og andre trekk, per ansatt.
//
// Trekkpålegg fra Skatteetaten (0127_trekkpaalegg.sql, trekkpaalegg.ts) er faste trekk med
// størrelsen i pålegget: det som gjelder på utbetalingsdatoen (paaleggstrekk under).
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

// Trekkene i rekkefølgen de trekkes.
export const iRekkefolge = (trekk: Lonnstrekk[]): Lonnstrekk[] =>
  [...trekk].sort((x, y) => TREKKTYPER[x.type].rekke - TREKKTYPER[y.type].rekke || x.fra.localeCompare(y.fra) || x.id.localeCompare(y.id));

// Trekkene som gjelder i perioden (minst én dag), i rekkefølgen de trekkes.
export function aktive(trekk: Lonnstrekk[], fra: string, til: string): Lonnstrekk[] {
  return iRekkefolge(trekk.filter((t) => t.fra <= til && (!t.til || t.til >= fra)));
}

// --- Trekkpålegg fra Skatteetaten ----------------------------------------------------------------

// Trekkstørrelsen i en periode av pålegget: et beløp per måned eller en prosent av bruttolønnen
// (kan være 0). til: null når perioden ikke har en sluttdato; den kan være før fra (pålegget ble
// avsluttet før det startet).
export type Paaleggsperiode = { fra: string; til: string | null; belop: number | null; prosent: number | null };

// Perioden som gjelder på utbetalingsdatoen (Skatteetaten: «Trekkpliktig skal trekke det som står i
// den perioden som gjelder lønnsutbetalingsdatoen»). Gjelder flere, den som startet sist.
export function gjeldendePeriode(perioder: Paaleggsperiode[], dato: string): Paaleggsperiode | null {
  let funnet: Paaleggsperiode | null = null;
  for (const p of perioder) if (p.fra <= dato && (!p.til || dato <= p.til) && (!funnet || p.fra >= funnet.fra)) funnet = p;
  return funnet;
}

// Størrelsen som tekst («17 % av bruttolønnen», «5 000 kr per måned», «ikke noe trekk»).
export function storrelseTekst(p: Pick<Paaleggsperiode, "belop" | "prosent">) {
  if (p.prosent != null && p.prosent > 0) return `${String(p.prosent).replace(".", ",")} % av bruttolønnen`;
  if (p.belop != null && p.belop > 0) return `${kr(p.belop)} per måned`;
  return "ikke noe trekk";
}

// Trekket fra et pålegg i en lønnskjøring med utbetaling på datoen. En prosent trekkes av
// bruttolønnen ved hver utbetaling (også i en ekstra kjøring). Et beløp trekkes én gang i måneden:
// det som ikke alt er trukket i en annen godkjent kjøring med utbetaling i samme måned, i den
// ordinære kjøringen, eller i en ekstra kjøring når den ordinære i måneden er godkjent (det den ikke
// rakk). null: ikke noe trekk i kjøringen.
export function paaleggstrekk(
  t: Lonnstrekk,
  perioder: Paaleggsperiode[],
  dato: string,
  v: { trukketIMaaneden: number; ordinar: boolean; ordinarGodkjent: boolean },
): Lonnstrekk | null {
  const p = gjeldendePeriode(perioder, dato);
  if (!p) return null;
  if (p.prosent != null && Number(p.prosent) > 0) return { ...t, prosent: Number(p.prosent), belop: null, totalt: null };
  if (p.belop == null || !(Number(p.belop) > 0)) return null;
  if (!v.ordinar && !v.ordinarGodkjent) return null;
  const igjen = rund(Number(p.belop) - Math.max(0, v.trukketIMaaneden));
  return igjen > 0 ? { ...t, belop: igjen, prosent: null, totalt: null } : null;
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
