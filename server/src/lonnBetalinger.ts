// Betalingene fra en godkjent lønnskjøring (betalingsfil.ts): nettolønnen til de ansatte på
// lønnsdagen, og forskuddstrekket og trekkene (0082) første virkedag etter, som Skatteetaten krever
// for forskuddstrekk og utleggstrekk. Forskuddstrekket betales til Skatteetatens kontonummer med
// KID-en for måneden; trekkene til mottakeren i trekket (pålegget), med KID eller en tekst.
// Trekk uten kontonummer (forskudd, andre trekk) betales ikke; de blir hos arbeidsgiveren.
import { alle, en, type Db } from "./db.js";
import { frister, maanedNavn } from "./lonnsberegning.js";
import { TREKKTYPER, type Trekktype } from "./lonnstrekk.js";

export type Trekkbetaling = {
  mottaker: string;
  kontonr: string | null;
  kid: string | null;
  tekst: string | null;
  belop: number;
  antall: number; // ansatte
  hva: string; // f.eks. «Fagforeningskontingent»
  mangler: string | null; // hvorfor den ikke er med i fila
};
export type Betalingsoversikt = {
  lonn: { dato: string; antall: number; sum: number };
  trekkdato: string;
  forskuddstrekk: Trekkbetaling | null;
  forventetKid: string | null; // begynnelsen på KID-en for forskuddstrekk i måneden (17 siffer)
  trekk: Trekkbetaling[];
};

const rund = (n: number) => Math.round(n * 100) / 100;
// Skatteetatens mottak av utleggstrekk (samordnet og for skattekrav).
const TIL_SKATTEETATEN: Trekktype[] = ["utlegg_samordnet", "utlegg_skatt"];

export async function hentBetalinger(
  db: Db,
  org: string,
  k: { id: string; periode: string; utbetalingsdato: string; forskuddstrekk_kid: string | null; slipper: { netto: number; skattetrekk: number }[] },
): Promise<Betalingsoversikt> {
  const o = await en<{ skatt_kontonr: string | null }>(db, "select skatt_kontonr from faktura.lonn_oppsett where org_id = $1", [org]);
  const orgnr = (await en<{ orgnr: string | null }>(db, "select orgnr from faktura.organisasjoner where id = $1", [org]))?.orgnr ?? null;
  const trekkdato = frister(k.utbetalingsdato).skattetrekk;
  const betales = k.slipper.filter((s) => Number(s.netto) > 0);
  const skatt = rund(k.slipper.reduce((x, s) => x + Number(s.skattetrekk), 0));
  const forventetKid = orgnr ? `00${orgnr}05${k.utbetalingsdato.slice(2, 4)}${k.utbetalingsdato.slice(5, 7)}` : null;
  const forskuddstrekk: Trekkbetaling | null =
    skatt > 0
      ? {
          mottaker: "Skatteetaten",
          kontonr: o?.skatt_kontonr ?? null,
          kid: k.forskuddstrekk_kid,
          tekst: null,
          belop: skatt,
          antall: k.slipper.filter((s) => Number(s.skattetrekk) > 0).length,
          hva: "Forskuddstrekk",
          mangler: !o?.skatt_kontonr
            ? "Legg inn Skatteetatens kontonummer for forskuddstrekk under Innstillinger → Ansatte og timer."
            : !k.forskuddstrekk_kid
              ? `Legg inn KID-en for forskuddstrekk i ${maanedNavn(k.utbetalingsdato.slice(0, 7) + "-01")} (fra Skatteetatens KID-generator).`
              : null,
        }
      : null;

  // Trekkene i kjøringen, per mottaker (kontonummer og KID eller tekst).
  const rader = await alle<{ type: Trekktype | null; mottaker: string | null; kontonr: string | null; kid: string | null; melding: string | null; belop: number; ansatt_id: string }>(
    db,
    `select t.type, t.mottaker, t.kontonr, t.kid, t.melding, -sum(l.belop)::float8 as belop, s.ansatt_id
       from faktura.lonnslinjer l join faktura.lonnsslipper s on s.id = l.slipp_id
       left join faktura.lonnstrekk t on t.org_id = l.org_id and 'trekk:' || t.id::text = l.nokkel
      where s.org_id = $1 and s.kjoring_id = $2 and not l.fjernet and l.nokkel like 'trekk:%'
      group by t.id, t.type, t.mottaker, t.kontonr, t.kid, t.melding, s.ansatt_id
     having sum(l.belop) < 0`,
    [org, k.id],
  );
  const per = new Map<string, Trekkbetaling & { ansatte: Set<string> }>();
  for (const r of rader) {
    const type = r.type ?? "annet";
    const tilSkatt = TIL_SKATTEETATEN.includes(type);
    // Trekk som blir hos arbeidsgiveren (forskudd og andre trekk uten mottaker), betales ikke.
    if (!r.kontonr && (type === "forskudd" || type === "annet")) continue;
    const hva = TREKKTYPER[type].navn;
    const mottaker = r.mottaker ?? (tilSkatt ? "Skatteetaten" : hva);
    const tekst = r.kid ? null : (r.melding ?? `${hva} ${maanedNavn(k.periode)}`);
    const nokkel = [r.kontonr ?? `uten:${type}:${r.mottaker ?? ""}`, r.kid ?? "", tekst ?? ""].join("|");
    const x = per.get(nokkel) ?? {
      mottaker,
      kontonr: r.kontonr,
      kid: r.kid,
      tekst,
      belop: 0,
      antall: 0,
      hva,
      mangler: r.kontonr ? null : `Legg inn kontonummeret${tilSkatt || type === "bidrag" ? " og KID-en fra pålegget" : ""} på trekket hos den ansatte.`,
      ansatte: new Set<string>(),
    };
    x.belop = rund(x.belop + Number(r.belop));
    x.ansatte.add(r.ansatt_id);
    x.antall = x.ansatte.size;
    per.set(nokkel, x);
  }
  return {
    lonn: { dato: k.utbetalingsdato, antall: betales.length, sum: rund(betales.reduce((x, s) => x + Number(s.netto), 0)) },
    trekkdato,
    forskuddstrekk,
    forventetKid,
    trekk: [...per.values()].map(({ ansatte: _, ...x }) => x).sort((a, b) => a.mottaker.localeCompare(b.mottaker, "nb")),
  };
}
