// Forslag fra AI om hvilken faktura en innbetaling gjelder, når reglene i bank.ts ikke fant
// noen: for eksempel «husleie okt» betalt av en annen enn kunden, et beløp som ikke stemmer
// helt, eller en melding uten fakturanummer. Gemini ser innbetalingen, de ubetalte
// fakturaene (med linjene) og hvem betaleren har betalt for før. Svaret blir bare et forslag
// som en person bekrefter; workeren tar med forslag modellen er rimelig sikker på, og
// brukeren kan be om et forslag selv for hver uavklarte innbetaling.
import { alle, type Db } from "./db.js";
import { enLinje, generer, medKvote, type Skjema } from "./ai.js";
import { kr } from "./regler.js";

export type Innbetalingen = {
  id?: string;
  dato: string;
  belop: number;
  betaler: string | null;
  betaler_konto: string | null;
  melding: string | null;
  referanse: string | null;
};
export type FakturaForAi = {
  id: string;
  fakturanummer: number;
  kid: string | null;
  kunde: string;
  utestaende: number;
  forfallsdato: string | null;
  periode_fra: string | null;
  periode_til: string | null;
  deres_referanse: string | null;
  linjer: string | null;
};
export type Sikkerhet = "hoy" | "middels" | "lav";
export type AiTreff = { faktura: FakturaForAi | null; sikkerhet: Sikkerhet; grunn: string };

type AiSvar = { faktura: string | null; sikkerhet: Sikkerhet; grunn: string };

export const forslagSkjema: Skjema = {
  type: "OBJECT",
  properties: {
    faktura: { type: "STRING", nullable: true, description: "Id-en til fakturaen (F1, F2 …), eller null når ingen passer" },
    sikkerhet: { type: "STRING", enum: ["hoy", "middels", "lav"], description: "Hvor sikker du er" },
    grunn: { type: "STRING", description: "Én kort setning på norsk som forklarer valget, med fakturanummeret (ikke id-en)" },
  },
  required: ["faktura", "sikkerhet", "grunn"],
  propertyOrdering: ["faktura", "sikkerhet", "grunn"],
};

export const forslagSystem = [
  "Du hjelper et norsk firma å finne hvilken faktura en innbetaling på bankkontoen gjelder. Du får innbetalingen og de ubetalte fakturaene. Svar bare med JSON etter skjemaet.",
  "",
  "- Velg fakturaen (F1, F2 …) som innbetalingen mest sannsynlig betaler, eller null.",
  "- Se på beløpet mot det som gjenstår (en delbetaling kan stemme, et høyere beløp passer dårlig), betaleren mot kunden (banker skriver ofte etternavnet først, og andre kan betale for kunden, for eksempel en forelder, en ektefelle eller et firma kunden eier), meldingen (fakturanummer, KID, periode som «okt» eller «oktober», adresse, hva som er kjøpt), datoen mot forfallsdatoen, og hvem betaleren har betalt for før.",
  "- sikkerhet: «hoy» når flere ting stemmer og ingen annen faktura passer like godt; «middels» når det er det beste valget, men noe er usikkert; «lav» når det er en gjetning.",
  "- Velg null når innbetalingen ikke ser ut til å gjelde en faktura (overføring mellom egne kontoer, refusjon, renter, lønn) eller når flere fakturaer passer like godt.",
  "- grunn: én kort setning på norsk, med fakturanummeret, ikke id-en.",
].join("\n");

// De ubetalte fakturaene, med de første linjene og perioden (de nyeste først).
export const fakturaerForAi = (db: Db, orgId: string) =>
  alle<FakturaForAi>(
    db,
    `select f.id, f.fakturanummer, f.kid, coalesce(f.kunde ->> 'navn', k.navn) as kunde, f.forfallsdato, f.periode_fra, f.periode_til,
            f.deres_referanse, f.sum_inkl_mva - f.kreditert_belop - f.betalt_belop as utestaende,
            (select string_agg(l.beskrivelse, '; ' order by l.rekke)
               from (select beskrivelse, rekke from faktura.faktura_linjer where faktura_id = f.id order by rekke limit 3) l) as linjer
       from faktura.fakturaer f join faktura.kunder k on k.id = f.kunde_id
      where f.org_id = $1 and f.type = 'faktura' and f.status = 'utstedt'
        and f.sum_inkl_mva - f.kreditert_belop - f.betalt_belop > 0
      order by f.forfallsdato desc nulls last, f.fakturanummer desc
      limit 200`,
    [orgId],
  );

// Kundene betaleren (samme konto eller samme navn) har betalt fakturaer for før.
export const tidligereBetalt = (db: Db, orgId: string, t: Innbetalingen) =>
  alle<{ kunde: string; n: number }>(
    db,
    `select coalesce(f.kunde ->> 'navn', k.navn) as kunde, count(*)::int as n
       from faktura.banktransaksjoner b
       join faktura.fakturaer f on f.id = b.faktura_id
       join faktura.kunder k on k.id = f.kunde_id
      where b.org_id = $1 and b.status = 'koblet' and b.id is distinct from $4::uuid
        and ((b.betaler_konto is not null and b.betaler_konto = $2) or (b.betaler is not null and lower(b.betaler) = lower($3)))
      group by 1 order by 2 desc, 1 limit 5`,
    [orgId, t.betaler_konto, t.betaler, t.id ?? null],
  );

const dato = (d: unknown) => (d == null ? "–" : String(d).slice(0, 10));

export function forslagTekst(t: Innbetalingen, apne: FakturaForAi[], historikk: { kunde: string; n: number }[]): string {
  const fra = [
    `${dato(t.dato)}, ${kr(t.belop)} kr`,
    t.betaler ? `fra «${enLinje(t.betaler)}»` : "fra ukjent betaler",
    t.betaler_konto ? `konto ${enLinje(t.betaler_konto, 40)}` : null,
    t.melding ? `melding «${enLinje(t.melding, 300)}»` : "uten melding",
    t.referanse && t.referanse !== t.melding ? `referanse «${enLinje(t.referanse, 60)}»` : null,
  ].filter(Boolean);
  const linjer = apne.map((f, i) =>
    [
      `F${i + 1}: faktura ${f.fakturanummer}`,
      enLinje(f.kunde),
      `gjenstår ${kr(f.utestaende)}`,
      `forfall ${dato(f.forfallsdato)}`,
      f.periode_fra || f.periode_til ? `periode ${dato(f.periode_fra)}–${dato(f.periode_til)}` : null,
      f.kid ? `KID ${f.kid}` : null,
      f.deres_referanse ? `ref. ${enLinje(f.deres_referanse, 60)}` : null,
      f.linjer ? `«${enLinje(f.linjer, 200)}»` : null,
    ]
      .filter(Boolean)
      .join(" | "),
  );
  return [
    `Innbetaling: ${fra.join(", ")}.`,
    historikk.length
      ? `Betaleren har betalt fakturaer for: ${historikk.map((h) => `${enLinje(h.kunde)} (${h.n} ${h.n === 1 ? "gang" : "ganger"})`).join(", ")}.`
      : "Betaleren har ikke betalt fakturaer før.",
    "",
    "Ubetalte fakturaer:",
    ...linjer,
  ].join("\n");
}

// Spør modellen. kjor: transaksjon som brukeren (fra appen) eller som systemet (workeren);
// kvoten og tilgangen (bokfør) sjekkes i databasen.
export async function foreslaFaktura(
  kjor: <X>(fn: (db: Db) => Promise<X>) => Promise<X>,
  orgId: string,
  t: Innbetalingen,
): Promise<AiTreff> {
  const [apne, historikk] = await kjor(async (db) => [await fakturaerForAi(db, orgId), await tidligereBetalt(db, orgId, t)] as const);
  if (!apne.length) return { faktura: null, sikkerhet: "lav", grunn: "Ingen ubetalte fakturaer å koble til." };
  const svar = await medKvote(kjor, orgId, "innbetaling", () =>
    generer<AiSvar>({ system: forslagSystem, deler: [{ text: forslagTekst(t, apne, historikk) }], skjema: forslagSkjema }),
  );
  return tilTreff(svar.data, apne);
}

// Sjekker svaret: bare en faktura fra listen, og en grunn som kan vises.
export function tilTreff(s: AiSvar, apne: FakturaForAi[]): AiTreff {
  const m = typeof s?.faktura === "string" ? s.faktura.trim().toUpperCase().match(/^F(\d+)$/) : null;
  const faktura = m ? apne[Number(m[1]) - 1] ?? null : null;
  const sikkerhet: Sikkerhet = s?.sikkerhet === "hoy" || s?.sikkerhet === "middels" ? s.sikkerhet : "lav";
  const grunn = enLinje(s?.grunn, 300) || (faktura ? `Faktura ${faktura.fakturanummer} passer best.` : "Fant ingen faktura som passer.");
  return { faktura, sikkerhet, grunn };
}
