// Utgiftene i rapportmodulen (modulen Regnskap, utgifter.ts): leverandørgjelden (de bokførte
// fakturaene som ikke er betalt, med forfallet, mot saldoen på leverandørgjeldskontoen) og
// utgiftene som er bokført i perioden, linje for linje med kontoen, avgiften og fradraget. Eier,
// administrator og regnskap (funksjonen «Regnskap»).
import { hentRegnskapsoppsett, regnskapskontoer } from "./anlegg.js";
import { alle, en } from "./db.js";
import type { Rapportdef } from "./rapportmodul.js";
import { linjeposter } from "./utgiftVurdering.js";

const rund = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const krTekst = (n: number) => `${n.toLocaleString("nb-NO", { minimumFractionDigits: Number.isInteger(rund(n)) ? 0 : 2, maximumFractionDigits: 2 }).replace(/[  ]/g, " ")} kr`;
const osloIDag = () => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Oslo" }).format(new Date());
const dager = (fra: string, til: string) => Math.round((Date.parse(`${til}T12:00:00Z`) - Date.parse(`${fra}T12:00:00Z`)) / 86_400_000);
const BEHANDLING: Record<string, string> = { kostnad: "Kostnad", anlegg: "Anleggsmiddel", periodisering: "Periodisert" };
const BETALING: Record<string, string> = { ubetalt: "Ubetalt", bank: "Bank", kontant: "Kontant", ansatt: "Lagt ut av ansatt" };

export const utgiftRapporter: Rapportdef[] = [
  {
    id: "regnskap.leverandorgjeld",
    modul: "regnskap",
    navn: "Leverandørgjeld",
    beskrivelse: "Leverandørfakturaene som er bokført og ikke betalt, med forfallet og dagene etter forfall, mot saldoen på leverandørgjeldskontoen.",
    funksjon: "regnskap",
    tilgang: "regnskap",
    parameter: "ingen",
    maanedlig: true,
    hent: async (db, org) => {
      const iDag = osloIDag();
      const rader = await alle<{ leverandor: string | null; fakturanummer: string | null; dato: string; forfallsdato: string | null; belop: number; bilag: string; kid: string | null; kontonr: string | null }>(
        db,
        `select u.leverandor, u.fakturanummer, to_char(u.dato, 'YYYY-MM-DD') as dato, to_char(u.forfallsdato, 'YYYY-MM-DD') as forfallsdato,
                u.belop::float8 as belop, b.serie || '-' || b.aar || '-' || b.nummer as bilag, u.kid, u.kontonr
           from faktura.utgifter u join faktura.bilag b on b.id = u.bilag_id
          where u.org_id = $1 and u.status = 'bokfort' and u.betaling = 'ubetalt'
          order by u.forfallsdato nulls last, u.dato`,
        [org],
      );
      const k = regnskapskontoer(await hentRegnskapsoppsett(db, org));
      const saldo = rund(
        -((
          await en<{ s: number }>(
            db,
            "select coalesce(sum(p.belop), 0)::float8 as s from faktura.posteringer p join faktura.bilag b on b.id = p.bilag_id where b.org_id = $1 and p.konto = $2 and b.dato <= $3",
            [org, k.leverandorgjeld, iDag],
          )
        )?.s ?? 0),
      );
      const sum = rund(rader.reduce((s, r) => s + r.belop, 0));
      const forfalt = rader.filter((r) => r.forfallsdato && r.forfallsdato < iDag);
      return {
        merknad: [
          `${rader.length} ubetalte leverandørfakturaer, ${krTekst(sum)}${forfalt.length ? `, ${forfalt.length} av dem forfalt` : ""}.`,
          `Saldoen på leverandørgjelden (konto ${k.leverandorgjeld}) er ${krTekst(saldo)}.`,
          Math.abs(saldo - sum) >= 0.005 ? `Forskjellen på ${krTekst(rund(saldo - sum))} er ført på kontoen på andre måter (f.eks. manuelle bilag eller den inngående balansen).` : "",
        ]
          .filter(Boolean)
          .join(" "),
        kolonner: [
          { nokkel: "leverandor", navn: "Leverandør" },
          { nokkel: "fakturanummer", navn: "Faktura", type: "tekst" },
          { nokkel: "dato", navn: "Dato", type: "dato" },
          { nokkel: "forfallsdato", navn: "Forfall", type: "dato" },
          { nokkel: "dager", navn: "Dager over forfall", type: "tall" },
          { nokkel: "belop", navn: "Beløp", type: "kr", sum: true },
          { nokkel: "kid", navn: "KID", type: "tekst", pdf: false },
          { nokkel: "kontonr", navn: "Kontonummer", type: "tekst", pdf: false },
          { nokkel: "bilag", navn: "Bilag" },
        ],
        rader: rader.map((r) => ({
          ...r,
          leverandor: r.leverandor ?? "",
          dager: r.forfallsdato && r.forfallsdato < iDag ? dager(r.forfallsdato, iDag) : null,
        })),
      };
    },
  },
  {
    id: "regnskap.utgifter",
    modul: "regnskap",
    navn: "Utgifter",
    beskrivelse:
      "Utgiftene (leverandørfakturaer og kvitteringer) som er bokført i perioden, linje for linje: kontoen, beløpet uten mva, avgiften og det som er trukket fra, og om utgiften er kostnadsført, aktivert eller periodisert.",
    funksjon: "regnskap",
    tilgang: "regnskap",
    parameter: "periode",
    maanedlig: true,
    hent: async (db, org, v) => {
      const linjer = await alle<{
        id: string;
        dato: string;
        leverandor: string | null;
        fakturanummer: string | null;
        behandling: string;
        betaling: string;
        utland: boolean;
        auto: boolean;
        bilag: string;
        beskrivelse: string | null;
        konto: string;
        belop: number;
        mva_sats: number;
        mva: number;
        fradrag: number;
      }>(
        db,
        `select u.id, to_char(u.dato, 'YYYY-MM-DD') as dato, u.leverandor, u.fakturanummer, u.behandling, u.betaling, u.utland, u.auto,
                b.serie || '-' || b.aar || '-' || b.nummer as bilag, l.beskrivelse, l.konto, l.belop::float8 as belop,
                l.mva_sats::float8 as mva_sats, l.mva::float8 as mva, l.fradrag::float8 as fradrag
           from faktura.utgifter u join faktura.bilag b on b.id = u.bilag_id join faktura.utgift_linjer l on l.utgift_id = u.id
          where u.org_id = $1 and u.status = 'bokfort' and u.dato between $2::date and $3::date
          order by u.dato, b.serie, b.aar, b.nummer, l.rekke`,
        [org, v.fra, v.til],
      );
      const venter = (await en<{ n: number }>(db, "select count(*)::int as n from faktura.utgifter where org_id = $1 and status = 'kladd'", [org]))?.n ?? 0;
      const utgifter = new Set(linjer.map((l) => l.id));
      const auto = new Set(linjer.filter((l) => l.auto).map((l) => l.id));
      return {
        merknad: [
          `${utgifter.size} utgifter er bokført i perioden${auto.size ? `, ${auto.size} av dem av seg selv (kjent leverandør)` : ""}.`,
          venter ? `${venter} venter på å bli godkjent under Regnskap → Utgifter.` : "",
        ]
          .filter(Boolean)
          .join(" "),
        kolonner: [
          { nokkel: "dato", navn: "Dato", type: "dato" },
          { nokkel: "bilag", navn: "Bilag" },
          { nokkel: "leverandor", navn: "Leverandør" },
          { nokkel: "beskrivelse", navn: "Beskrivelse" },
          { nokkel: "konto", navn: "Konto", type: "tekst" },
          { nokkel: "behandling", navn: "Ført som", pdf: false },
          { nokkel: "belop", navn: "Uten mva", type: "kr", sum: true },
          { nokkel: "mva", navn: "Mva", type: "kr", sum: true },
          { nokkel: "fradrag", navn: "Trukket fra", type: "kr", sum: true },
          { nokkel: "betaling", navn: "Betaling", pdf: false },
        ],
        rader: linjer.map((l) => {
          const x = linjeposter(l, l.utland);
          return {
            dato: l.dato,
            bilag: l.bilag,
            leverandor: l.leverandor ?? "",
            beskrivelse: l.beskrivelse ?? (l.fakturanummer ? `Faktura ${l.fakturanummer}` : ""),
            konto: l.konto,
            behandling: BEHANDLING[l.behandling] ?? l.behandling,
            belop: l.belop,
            mva: x.mva,
            fradrag: x.fradrag,
            betaling: BETALING[l.betaling] ?? l.betaling,
          };
        }),
      };
    },
  },
];
