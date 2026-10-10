// Avstemmingen av banken (0091_bankposter.sql): hver bankpost (alle bokførte transaksjoner på de
// egne kontoene, inn og ut, fra hentingene i bank.ts) føres i regnskapet. Reglene, i rekkefølge:
//  1. En innbetaling som er registrert på en faktura: bilaget for innbetalingen (salgBokforing.ts).
//  2. Et bilag som alt fører beløpet på bankkontoen og ikke er koblet til andre bankposter
//     (kvittering betalt med kort, lønnen ført mot banken, refusjon fra NAV, innbetaling registrert
//     for hånd, manuelle bilag), datert fra ti dager før til fem dager etter.
//  3. En ubetalt leverandørfaktura (utgifter.ts) med KID-en og beløpet, kontonummeret og beløpet,
//     fakturanummeret og beløpet, eller samme beløp og leverandør: betalingen bokføres (serie U).
//  4. Lønnen (godkjente kjøringer): nettolønnen når den føres som skyldig lønn (samlet eller til
//     hver ansatt), forskuddstrekket (KID-en, eller Skatteetatens kontonummer og beløpet) og
//     trekkene (mottakerens kontonummer og KID-en eller beløpet).
//  5. Betalinger til Skatteetaten: det som står på kontoene for forskuddstrekk, arbeidsgiveravgift
//     eller merverdiavgift, eller arbeidsgiveravgiften for den siste terminen; og merverdiavgift til
//     gode fra Skatteetaten (det som står på oppgjørskontoen, mva.ts).
//  6. Overføringer mellom egne kontoer: med motposten på den andre kontoen, eller mot kontoen den
//     andre bankkontoen føres på i regnskapet.
//  7. Det brukeren har lært reglene (motparten → kontoen).
//  8. Gebyrer og renter fra banken (poster uten motpartens kontonummer).
// Det reglene er sikre på, føres av seg selv (når det er slått på); resten blir forslag eller
// uavklart under Regnskap → Bank. En post brukeren har angret, føres aldri av seg selv igjen.
// Workeren avstemmer hvert minutt (og rett etter hver henting); forslag og uavklarte poster
// vurderes på nytt hvert kvarter, så de føres når det som mangler (f.eks. en utgift) er bokført.
import { hentRegnskapsoppsett, regnskapskontoer, type Regnskapsoppsett, type Regnskapsrolle } from "./anlegg.js";
import { sammeNavn } from "./bank.js";
import { alle, en, somSystem, type Db } from "./db.js";
import { rentKontonr } from "./enableBanking.js";
import { hentBetalinger } from "./lonnBetalinger.js";
import { hentBokforingsoppsett, kontoplan, type Kontorolle } from "./lonnBokforing.js";
import { maanedNavn } from "./lonnsberegning.js";
import { dato as visDato, kr } from "./regler.js";
import { betalingsbilag } from "./utgiftVurdering.js";

const logg = (severity: string, message: string, data: Record<string, unknown> = {}) => console.log(JSON.stringify({ severity, message, ...data }));
const rund = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const like = (a: number, b: number) => Math.abs(a - b) < 0.005;
const dager = (a: string, b: string) => Math.abs(Date.parse(`${a}T12:00:00Z`) - Date.parse(`${b}T12:00:00Z`)) / 86_400_000;
const siffer = (x: string | null) => (x ?? "").replace(/\D/g, "") || null;
const tallI = (x: string | null) => [...(x ?? "").matchAll(/\d{2,25}/g)].map((m) => m[0]);
const antall = (n: number, en: string, flere: string) => `${n} ${n === 1 ? en : flere}`;
const navnNokkel = (x: string | null) => (x ?? "").toLowerCase().replace(/\s+/g, " ").trim().slice(0, 200) || null;
// 86011117947 → 8601.11.17947
export const visKonto = (k: string | null) => (k && /^\d{11}$/.test(k) ? `${k.slice(0, 4)}.${k.slice(4, 6)}.${k.slice(6)}` : (k ?? ""));

export type Linje = { konto: string; belop: number; tekst?: string | null };
export type Forslag =
  | { type: "bilag"; bilag_id: string; nummer: string }
  | { type: "utgift"; utgift_id: string; leverandor: string | null }
  | { type: "bokfor"; tekst: string; posteringer: Linje[]; mot?: string | null }
  | { type: "overforing"; mot: string };
export type Vurdering =
  | { utfall: "vent"; regel: string | null }
  | { utfall: "uavklart"; regel: string }
  | { utfall: "auto" | "forslag"; regel: string; forslag: Forslag; ignorer?: string | null };

export type Post = {
  id: string;
  konto: string;
  ekstern_id: string;
  dato: string;
  belop: number;
  valuta: string;
  motpart: string | null;
  motpart_konto: string | null;
  melding: string | null;
  referanse: string | null;
  status: "ny" | "avstemt" | "forslag" | "uavklart";
  auto: boolean;
  regel: string | null;
  forslag: (Forslag & { ignorer?: string | null }) | null;
  bilag_id: string | null;
  par_id: string | null;
};
export const POSTKOLONNER = `p.id, p.konto, p.ekstern_id, to_char(p.dato, 'YYYY-MM-DD') as dato, p.belop::float8 as belop, p.valuta, p.motpart,
  p.motpart_konto, p.melding, p.referanse, p.status, p.auto, p.regel, p.forslag, p.bilag_id, p.par_id`;

export const VENTER_INNBETALING =
  "Innbetalingen er ikke registrert på en faktura ennå. Registrer den under Fakturaer → Innbetalinger, eller velg «Ikke en fakturabetaling» og før den på en konto.";
const GEBYR = /gebyr|omkostning|kontohold|årspris|arspris|pakkepris|kortavgift|årsavgift|transaksjonskost/i;
const RENTE = /(^|[^a-zæøå])(kredit|debet)?renter?([^a-zæøå]|$)|renteinntekt|rentekostnad|\binterest\b/i;

type Regel = { retning: "inn" | "ut"; motpart_konto: string | null; motpart: string | null; konto: string; tekst: string | null };
export type Grunnlag = {
  org: string;
  o: Regnskapsoppsett;
  k: Record<Regnskapsrolle, string>;
  lonn: { kontoer: Record<Kontorolle, string>; netto: "skyldig" | "bank" };
  // De egne kontonumrene, og om bankpostene for dem hentes.
  egne: Map<string, boolean>;
  skattKonto: string | null;
  regler: Regel[];
};

// Kontoen i regnskapet for en bankkonto.
export const bankKonto = (o: Pick<Regnskapsoppsett, "bankkontoer">, k: Record<Regnskapsrolle, string>, kontonr: string) => o.bankkontoer[kontonr] ?? k.bank;

export async function hentGrunnlag(db: Db, org: string): Promise<Grunnlag> {
  const o = await hentRegnskapsoppsett(db, org);
  const lb = await hentBokforingsoppsett(db, org);
  const egne = new Map<string, boolean>();
  const kontoer = await alle<{ kontonr: string | null; hentes: boolean }>(
    db,
    `select x.kontonr, exists (select 1 from faktura.bankpost_kontoer b where b.org_id = $1 and b.konto = x.kontonr) as hentes
       from (select kontonr from faktura.organisasjoner where id = $1
             union select kontonr from faktura.kontoer where org_id = $1
             union select lonnskonto from faktura.lonn_oppsett where org_id = $1
             union select e.x ->> 'kontonr' from faktura.bankkoblinger k, jsonb_array_elements(k.kontoer) as e(x) where k.org_id = $1) x
      where x.kontonr is not null`,
    [org],
  );
  for (const r of kontoer) {
    const k = rentKontonr(r.kontonr);
    if (k) egne.set(k, r.hentes || egne.get(k) === true);
  }
  return {
    org,
    o,
    k: regnskapskontoer(o),
    lonn: { kontoer: kontoplan(lb), netto: lb.netto },
    egne,
    skattKonto: rentKontonr((await en<{ k: string | null }>(db, "select skatt_kontonr as k from faktura.lonn_oppsett where org_id = $1", [org]))?.k ?? null),
    regler: await alle<Regel>(db, "select retning, motpart_konto, motpart, konto, tekst from faktura.bankregler where org_id = $1", [org]),
  };
}

const banktekst = (p: Pick<Post, "motpart" | "melding">) => (p.motpart ?? p.melding ?? "Bank").slice(0, 200);
const standardtekst = (p: Pick<Post, "motpart" | "melding">) => [p.motpart, p.melding].filter(Boolean).join(": ").slice(0, 300) || "Bankpost";
// Et bilag i serie B: bankkontoen med postens beløp, og motpostene.
function bilagFor(p: Post, konto: string, tekst: string, mot: Linje[]): Forslag {
  return { type: "bokfor", tekst: tekst.slice(0, 300), posteringer: [{ konto, belop: p.belop, tekst: banktekst(p) }, ...mot.map((l) => ({ ...l, belop: rund(l.belop) }))] };
}

// Terminen for arbeidsgiveravgiften som sist er avsluttet før datoen (to og to måneder, betales
// den 15. i måneden etter).
export function sisteTermin(iso: string): { fra: string; til: string; navn: string } {
  const aar = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7));
  let slutt = m % 2 === 1 ? m - 1 : m - 2;
  let a = aar;
  if (slutt <= 0) {
    slutt += 12;
    a -= 1;
  }
  const start = slutt - 1;
  const mm = (n: number) => String(n).padStart(2, "0");
  const sisteDag = new Date(Date.UTC(a, slutt, 0)).getUTCDate();
  return { fra: `${a}-${mm(start)}-01`, til: `${a}-${mm(slutt)}-${mm(sisteDag)}`, navn: `${maanedNavn(`${a}-${mm(start)}-01`).split(" ")[0]}–${maanedNavn(`${a}-${mm(slutt)}-01`)}` };
}

// Bilagene med det samme beløpet på bankkontoen som ikke er koblet til bankposter (resten), datert
// fra ti dager før til fem dager etter posten. Innbetalinger fra banken kobles med regel 1.
async function bilagUtenPost(db: Db, org: string, konto: string, dato: string) {
  return alle<{ id: string; nummer: string; dato: string; tekst: string; kilde: string; rest: number }>(
    db,
    `with kandidater as (
       select b.id, b.serie || '-' || b.aar || '-' || b.nummer as nummer, to_char(b.dato, 'YYYY-MM-DD') as dato, b.tekst, b.kilde, sum(p.belop) as paa_konto
         from faktura.bilag b join faktura.posteringer p on p.bilag_id = b.id and p.konto = $2
        where b.org_id = $1 and b.reverserer is null and b.reversert_av is null and b.kilde <> 'bank'
          and b.dato between $3::date - 10 and $3::date + 5
          and not (b.kilde = 'innbetaling' and exists (select 1 from faktura.banktransaksjoner t where t.org_id = b.org_id and t.betaling_id = b.kilde_id))
        group by b.id)
     select k.id, k.nummer, k.dato, k.tekst, k.kilde,
            (k.paa_konto - coalesce((select sum(x.belop) from faktura.bankposter x where x.bilag_id = k.id and faktura.bankpost_konto(x.org_id, x.konto) = $2), 0))::float8 as rest
       from kandidater k`,
    [org, konto, dato],
  );
}

// Mva-oppgjørene (mva.ts) de siste åtte månedene før datoen: beløpet på oppgjørskontoen (positivt å
// betale, negativt til gode) og teksten. Saldoen på kontoen netter terminene; hver termin betales
// (eller kommer tilbake) for seg.
async function mvaOppgjor(db: Db, org: string, konto: string, dato: string) {
  return alle<{ belop: number; tekst: string }>(
    db,
    `select -sum(p.belop)::float8 as belop, b.tekst
       from faktura.bilag b join faktura.posteringer p on p.bilag_id = b.id and p.konto = $2
      where b.org_id = $1 and b.kilde = 'mva' and b.reverserer is null and b.reversert_av is null
        and b.dato <= $3::date and b.dato > $3::date - interval '8 months'
      group by b.id, b.tekst, b.dato order by b.dato desc`,
    [org, konto, dato],
  );
}

// Hva reglene sier om en bankpost (uten å endre noe).
export async function vurder(db: Db, g: Grunnlag, p: Post): Promise<Vurdering> {
  if (p.valuta !== "NOK") return { utfall: "uavklart", regel: `Bankposten er i ${p.valuta}; bare kroner føres av seg selv. Velg kontoen.` };
  const K = bankKonto(g.o, g.k, p.konto);
  const belop = Math.abs(p.belop);
  const ref = siffer(p.referanse);
  const tall = tallI(p.melding);
  let ignorer: string | null = null;
  let venterPaaInnbetaling = false;
  let tilSkatteetaten = false;

  // 1. Innbetalingen på en faktura.
  if (p.belop > 0) {
    const t = await en<{ id: string; status: string; betalt_dato: string | null; fakturanummer: number | null; bilag_id: string | null; nummer: string | null }>(
      db,
      `select t.id, t.status, to_char(b.betalt_dato, 'YYYY-MM-DD') as betalt_dato, f.fakturanummer, g.id as bilag_id, g.serie || '-' || g.aar || '-' || g.nummer as nummer
         from faktura.banktransaksjoner t
         left join faktura.betalinger b on b.id = t.betaling_id
         left join faktura.fakturaer f on f.id = b.faktura_id
         left join faktura.bilag g on g.org_id = t.org_id and g.kilde = 'innbetaling' and g.kilde_id = t.betaling_id and g.reverserer is null and g.reversert_av is null
        where t.org_id = $1 and t.konto = $2 and t.ekstern_id = $3`,
      [g.org, p.konto, p.ekstern_id],
    );
    if (t?.status === "koblet") {
      if (t.bilag_id) return { utfall: "auto", regel: `Innbetaling på faktura ${t.fakturanummer}`, forslag: { type: "bilag", bilag_id: t.bilag_id, nummer: t.nummer! } };
      if (t.betalt_dato && g.o.salg_fra && t.betalt_dato < g.o.salg_fra)
        return {
          utfall: "uavklart",
          regel: `Innbetalingen på faktura ${t.fakturanummer} er fra før startdatoen for salget i regnskapet (${visDato(g.o.salg_fra)}): velg kontoen, eller flytt startdatoen.`,
        };
      return { utfall: "vent", regel: "Venter på at innbetalingen bokføres." };
    }
    if (t?.status === "forslag") return { utfall: "uavklart", regel: VENTER_INNBETALING };
    if (t?.status === "uavklart") {
      ignorer = t.id;
      venterPaaInnbetaling = true;
    }
  }

  // 2. Et bilag som alt fører beløpet på bankkontoen.
  const treff = (await bilagUtenPost(db, g.org, K, p.dato))
    .filter((b) => like(b.rest, p.belop))
    .sort((a, b) => dager(a.dato, p.dato) - dager(b.dato, p.dato) || a.nummer.localeCompare(b.nummer, "nb", { numeric: true }));
  if (treff.length) {
    const b = treff[0]!;
    const entydig = treff.length === 1 || dager(treff[1]!.dato, p.dato) > dager(b.dato, p.dato);
    return {
      utfall: entydig ? "auto" : "forslag",
      regel: `Samme beløp som bilag ${b.nummer} (${b.tekst.slice(0, 80)}, ${visDato(b.dato)})${entydig ? "" : `; ${treff.length} bilag har det beløpet`}`,
      forslag: { type: "bilag", bilag_id: b.id, nummer: b.nummer },
      ignorer,
    };
  }

  if (p.belop > 0 && (Boolean(g.skattKonto && p.motpart_konto === g.skattKonto) || /skatteetaten|skatteoppkrev|merverdiavgift|\bmva\b/i.test(`${p.motpart ?? ""} ${p.melding ?? ""}`))) {
    // 5b. Merverdiavgift til gode fra Skatteetaten: det som står på oppgjørskontoen (mva.ts).
    const mvaK = g.k.oppgjor_mva;
    const tilGode = rund(
      (
        await en<{ s: number }>(
          db,
          "select coalesce(sum(p.belop), 0)::float8 as s from faktura.posteringer p join faktura.bilag b on b.id = p.bilag_id where b.org_id = $1 and p.konto = $2 and b.dato <= $3",
          [g.org, mvaK, p.dato],
        )
      )?.s ?? 0,
    );
    const termin = (await mvaOppgjor(db, g.org, mvaK, p.dato)).find((x) => x.belop < 0 && like(belop, -x.belop));
    if ((tilGode > 0 && like(belop, tilGode)) || termin)
      return {
        utfall: "auto",
        regel: termin ? `Merverdiavgiften til gode (${termin.tekst.replace(/^Mva-oppgjør /, "")})` : `Merverdiavgiften til gode som står på ${mvaK}`,
        forslag: bilagFor(p, K, "Merverdiavgift til gode fra Skatteetaten", [{ konto: mvaK, belop: -belop, tekst: "Merverdiavgift til gode" }]),
        ignorer,
      };
  }

  if (p.belop < 0) {
    // 3. En ubetalt leverandørfaktura.
    const ut = await alle<{ id: string; leverandor: string | null; kid: string | null; kontonr: string | null; fakturanummer: string | null; belop: number }>(
      db,
      `select u.id, u.leverandor, u.kid, u.kontonr, u.fakturanummer, u.belop::float8 as belop
         from faktura.utgifter u
        where u.org_id = $1 and u.status = 'bokfort' and u.betaling = 'ubetalt' and u.betaling_bilag_id is null and u.dato <= $2
        order by u.forfallsdato nulls last, u.dato, u.opprettet`,
      [g.org, p.dato],
    );
    const forslag = (u: (typeof ut)[number]): Forslag => ({ type: "utgift", utgift_id: u.id, leverandor: u.leverandor });
    const fra = (u: (typeof ut)[number]) => `fakturaen fra ${u.leverandor ?? "leverandøren"}${u.fakturanummer ? ` (${u.fakturanummer})` : ""}`;
    const viaKid = ut.filter((u) => u.kid && (u.kid === ref || tall.includes(u.kid)));
    if (viaKid.length === 1) {
      const u = viaKid[0]!;
      if (like(u.belop, belop)) return { utfall: "auto", regel: `KID ${u.kid} på ${fra(u)}`, forslag: forslag(u) };
      return { utfall: "uavklart", regel: `KID ${u.kid} er på ${fra(u)}, men beløpet er ${kr(belop)} av ${kr(u.belop)}. Velg hvordan den skal føres.` };
    }
    const viaKonto = ut.filter((u) => u.kontonr && u.kontonr === p.motpart_konto && like(u.belop, belop));
    if (viaKonto.length) return { utfall: viaKonto.length === 1 ? "auto" : "forslag", regel: `Kontonummeret og beløpet på ${fra(viaKonto[0]!)}`, forslag: forslag(viaKonto[0]!) };
    const viaNummer = ut.filter((u) => u.fakturanummer && like(u.belop, belop) && tall.includes(siffer(u.fakturanummer) ?? "-"));
    if (viaNummer.length === 1) return { utfall: "auto", regel: `Fakturanummeret og beløpet på ${fra(viaNummer[0]!)}`, forslag: forslag(viaNummer[0]!) };
    const viaNavn = ut.filter((u) => like(u.belop, belop) && sammeNavn(p.motpart, u.leverandor));
    if (viaNavn.length) return { utfall: viaNavn.length === 1 ? "auto" : "forslag", regel: `Samme beløp og leverandør som ${fra(viaNavn[0]!)}`, forslag: forslag(viaNavn[0]!) };
    const viaBelop = ut.filter((u) => like(u.belop, belop));
    if (viaBelop.length === 1) return { utfall: "forslag", regel: `Samme beløp som ${fra(viaBelop[0]!)}`, forslag: forslag(viaBelop[0]!) };

    // 4. Lønnen.
    const kjoringer = await alle<{ id: string; periode: string; utbetalingsdato: string; type: string; forskuddstrekk_kid: string | null }>(
      db,
      `select k.id, to_char(k.periode, 'YYYY-MM-DD') as periode, to_char(k.utbetalingsdato, 'YYYY-MM-DD') as utbetalingsdato, k.type, k.forskuddstrekk_kid
         from faktura.lonnskjoringer k
        where k.org_id = $1 and k.status = 'godkjent' and k.utbetalingsdato between $2::date - 10 and $2::date + 10
        order by abs(k.utbetalingsdato - $2::date), k.periode desc`,
      [g.org, p.dato],
    );
    for (const kj of kjoringer) {
      const slipper = await alle<{ navn: string; kontonr: string | null; netto: number; skattetrekk: number }>(
        db,
        "select navn, kontonr, netto::float8 as netto, skattetrekk::float8 as skattetrekk from faktura.lonnsslipper where kjoring_id = $1",
        [kj.id],
      );
      const maaned = `${maanedNavn(kj.periode)}${kj.type === "ekstra" ? " (ekstra)" : ""}`;
      const netto = rund(slipper.filter((s) => s.netto > 0).reduce((a, s) => a + s.netto, 0));
      const ansatt = slipper.find((s) => s.netto > 0 && like(belop, s.netto) && s.kontonr && rentKontonr(s.kontonr) === p.motpart_konto);
      if (g.lonn.netto === "skyldig") {
        const linje = [{ konto: g.lonn.kontoer.skyldig_lonn, belop, tekst: `Nettolønn ${maaned}` }];
        if (netto > 0 && like(belop, netto))
          return { utfall: "auto", regel: `Nettolønnen for ${maaned} (${antall(slipper.filter((s) => s.netto > 0).length, "ansatt", "ansatte")})`, forslag: bilagFor(p, K, `Nettolønn ${maaned}`, linje) };
        if (ansatt) return { utfall: "auto", regel: `Nettolønnen til ${ansatt.navn} for ${maaned}`, forslag: bilagFor(p, K, `Nettolønn ${maaned}`, linje) };
      } else if (ansatt) {
        const lb = await en<{ id: string; nummer: string }>(
          db,
          "select id, serie || '-' || aar || '-' || nummer as nummer from faktura.bilag where org_id = $1 and kilde = 'lonn' and kilde_id = $2 and reverserer is null and reversert_av is null",
          [g.org, kj.id],
        );
        if (lb) return { utfall: "auto", regel: `Nettolønnen til ${ansatt.navn} for ${maaned}`, forslag: { type: "bilag", bilag_id: lb.id, nummer: lb.nummer } };
      }
      const b = await hentBetalinger(db, g.org, { ...kj, slipper });
      const f = b.forskuddstrekk;
      const fKid = Boolean(f?.kid && ref === f.kid);
      if (f && (fKid || (f.kontonr && rentKontonr(f.kontonr) === p.motpart_konto && like(belop, f.belop)))) {
        const riktig = like(belop, f.belop);
        return {
          utfall: riktig ? "auto" : "forslag",
          regel: `Forskuddstrekket for ${maaned}${fKid ? ` (KID ${f.kid})` : ""}${riktig ? "" : `, men beløpet er ${kr(belop)} av ${kr(f.belop)}`}`,
          forslag: bilagFor(p, K, `Forskuddstrekk ${maaned}`, [{ konto: g.lonn.kontoer.forskuddstrekk, belop, tekst: `Forskuddstrekk ${maaned}` }]),
        };
      }
      for (const t of b.trekk) {
        if (!t.kontonr || rentKontonr(t.kontonr) !== p.motpart_konto) continue;
        const kidLik = Boolean(t.kid && ref === t.kid);
        if (!kidLik && !like(belop, t.belop)) continue;
        const riktig = like(belop, t.belop);
        return {
          utfall: riktig ? "auto" : "forslag",
          regel: `${t.hva} til ${t.mottaker} for ${maaned}${riktig ? "" : `, men beløpet er ${kr(belop)} av ${kr(t.belop)}`}`,
          forslag: bilagFor(p, K, `${t.hva} ${maaned}`, [{ konto: g.lonn.kontoer[t.rolle], belop, tekst: `${t.hva} ${maaned}` }]),
        };
      }
    }

    // 5. Til Skatteetaten: det som står på kontoene.
    tilSkatteetaten =
      Boolean(g.skattKonto && p.motpart_konto === g.skattKonto) ||
      /skatteetaten|skatteoppkrev|arbeidsgiveravgift|forskuddstrekk|merverdiavgift|\bmva\b/i.test(`${p.motpart ?? ""} ${p.melding ?? ""}`);
    if (tilSkatteetaten) {
      // Det som står på kontoen på betalingsdatoen, eller (termin) det lønnsbilagene i terminen førte.
      const saldo = async (konto: string, termin?: { fra: string; til: string }) =>
        rund(
          -((
            await en<{ s: number }>(
              db,
              `select coalesce(sum(p.belop), 0)::float8 as s from faktura.posteringer p join faktura.bilag b on b.id = p.bilag_id
                where b.org_id = $1 and p.konto = $2 and b.dato <= $3 and ($4::date is null or (b.dato >= $4 and b.kilde = 'lonn'))`,
              [g.org, konto, termin?.til ?? p.dato, termin?.fra ?? null],
            )
          )?.s ?? 0),
        );
      const agaK = g.lonn.kontoer.skyldig_aga;
      const trekkK = g.lonn.kontoer.forskuddstrekk;
      const mvaK = g.k.oppgjor_mva;
      const aga = await saldo(agaK);
      const trekk = await saldo(trekkK);
      const mva = await saldo(mvaK);
      const termin = sisteTermin(p.dato);
      const agaTermin = await saldo(agaK, termin);
      const linje = (konto: string, b: number, tekst: string) => ({ konto, belop: b, tekst });
      const valg: [number, Linje[], string][] = [
        [aga, [linje(agaK, belop, "Arbeidsgiveravgift")], `Arbeidsgiveravgiften som står på ${agaK}`],
        [agaTermin, [linje(agaK, belop, `Arbeidsgiveravgift ${termin.navn}`)], `Arbeidsgiveravgiften for ${termin.navn}`],
        [trekk, [linje(trekkK, belop, "Forskuddstrekk")], `Forskuddstrekket som står på ${trekkK}`],
        [rund(aga + trekk), [linje(trekkK, trekk, "Forskuddstrekk"), linje(agaK, aga, "Arbeidsgiveravgift")], `Forskuddstrekket og arbeidsgiveravgiften (${trekkK} og ${agaK})`],
        [mva, [linje(mvaK, belop, "Merverdiavgift")], `Merverdiavgiften som står på ${mvaK}`],
        ...(await mvaOppgjor(db, g.org, mvaK, p.dato)).map(
          (x): [number, Linje[], string] => [x.belop, [linje(mvaK, belop, "Merverdiavgift")], `Merverdiavgiften for ${x.tekst.replace(/^Mva-oppgjør /, "")}`],
        ),
      ];
      const v = valg.find(([sum]) => sum > 0 && like(belop, sum));
      if (v) return { utfall: "auto", regel: v[2], forslag: bilagFor(p, K, `Betalt til Skatteetaten: ${v[1].map((l) => l.tekst).join(" og ")}`, v[1]) };
    }
  }

  // 6. Overføring mellom egne kontoer.
  if (p.motpart_konto && p.motpart_konto !== rentKontonr(p.konto) && g.egne.has(p.motpart_konto)) {
    const annen = p.motpart_konto;
    const K2 = bankKonto(g.o, g.k, annen);
    const hva = `Overføring ${p.belop < 0 ? "til" : "fra"} egen konto ${visKonto(annen)}`;
    if (g.egne.get(annen)) {
      const mot = await en<{ id: string; ekstern_id: string }>(
        db,
        `select id, ekstern_id from faktura.bankposter
          where org_id = $1 and konto = $2 and belop = $3 and dato between $4::date - 3 and $4::date + 3 and status <> 'avstemt' and auto and id <> $5
          order by abs(dato - $4::date), opprettet limit 1`,
        [g.org, annen, -p.belop, p.dato, p.id],
      );
      if (mot) {
        // Motposten inn på den andre kontoen er heller ikke en fakturabetaling.
        const motInn =
          p.belop < 0
            ? (
                await en<{ id: string }>(db, "select id from faktura.banktransaksjoner where org_id = $1 and konto = $2 and ekstern_id = $3 and status = 'uavklart'", [
                  g.org,
                  annen,
                  mot.ekstern_id,
                ])
              )?.id
            : null;
        const ign = ignorer ?? motInn ?? null;
        if (K2 === K) return { utfall: "auto", regel: hva, forslag: { type: "overforing", mot: mot.id }, ignorer: ign };
        return { utfall: "auto", regel: hva, forslag: { ...(bilagFor(p, K, hva, [{ konto: K2, belop: -p.belop, tekst: hva }]) as Extract<Forslag, { type: "bokfor" }>), mot: mot.id }, ignorer: ign };
      }
      return { utfall: "uavklart", regel: `${hva}: venter på motposten på den kontoen.` };
    }
    if (g.o.bankkontoer[annen]) return { utfall: "auto", regel: `${hva} (konto ${K2} i regnskapet)`, forslag: bilagFor(p, K, hva, [{ konto: K2, belop: -p.belop, tekst: hva }]), ignorer };
    return { utfall: "uavklart", regel: `${hva}, som ikke hentes fra banken: velg kontoen den føres på i regnskapet (Kontoer → Banken), eller velg kontoen her.` };
  }

  // 7. Det brukeren har lært.
  const retning = p.belop > 0 ? "inn" : "ut";
  const navn = navnNokkel(p.motpart);
  const regel =
    g.regler.find((r) => r.retning === retning && r.motpart_konto && r.motpart_konto === p.motpart_konto) ??
    g.regler.find((r) => r.retning === retning && !r.motpart_konto && navn && r.motpart === navn);
  if (regel && regel.konto !== K) {
    const tekst = regel.tekst ?? standardtekst(p);
    return {
      utfall: "auto",
      regel: `Lært: ${p.motpart ?? visKonto(p.motpart_konto)} føres på ${regel.konto}`,
      forslag: bilagFor(p, K, tekst, [{ konto: regel.konto, belop: -p.belop, tekst }]),
      ignorer,
    };
  }

  // 8. Gebyrer og renter fra banken.
  if (!p.motpart_konto) {
    const tekst = `${p.melding ?? ""} ${p.motpart ?? ""}`;
    if (p.belop < 0 && GEBYR.test(tekst) && belop <= 5000)
      return { utfall: "auto", regel: "Gebyr fra banken", forslag: bilagFor(p, K, "Gebyr fra banken", [{ konto: g.k.bankgebyr, belop, tekst: p.melding ?? "Gebyr" }]), ignorer };
    if (RENTE.test(tekst))
      return p.belop > 0
        ? { utfall: "auto", regel: "Renter fra banken", forslag: bilagFor(p, K, "Renter fra banken", [{ konto: g.k.renteinntekt, belop: -belop, tekst: p.melding ?? "Renter" }]), ignorer }
        : { utfall: "auto", regel: "Renter til banken", forslag: bilagFor(p, K, "Renter til banken", [{ konto: g.k.rentekostnad, belop, tekst: p.melding ?? "Renter" }]), ignorer };
  }

  if (venterPaaInnbetaling) return { utfall: "uavklart", regel: VENTER_INNBETALING };
  if (tilSkatteetaten)
    return {
      utfall: "uavklart",
      regel: "Betaling til Skatteetaten som ikke stemmer med det som står på kontoene for forskuddstrekk, arbeidsgiveravgift eller merverdiavgift: velg hva den gjelder.",
    };
  return {
    utfall: "uavklart",
    regel: p.belop < 0 ? "Last opp kvitteringen eller fakturaen under Utgifter, eller velg kontoen." : "Velg kontoen (f.eks. innskudd fra eier, et lån eller en refusjon).",
  };
}

// Fører posten slik forslaget sier: kobler til bilaget, betaler utgiften (serie U) og kobler til
// betalingen, eller fører et bilag i serie B (med motposten for en overføring). auto: av reglene.
export async function utfor(db: Db, org: string, p: Post, f: Forslag & { ignorer?: string | null }, regel: string, auto: boolean) {
  if (f.ignorer) await db.query("select faktura.ignorer_banktransaksjon($1, true)", [f.ignorer]);
  if (f.type === "bilag") await db.query("select faktura.avstem_bankpost($1, $2, $3, $4, $5)", [org, p.id, f.bilag_id, regel, auto]);
  else if (f.type === "overforing") await db.query("select faktura.avstem_overforing($1, $2, $3, $4, $5)", [org, p.id, f.mot, regel, auto]);
  else if (f.type === "bokfor")
    await db.query("select faktura.bokfor_bankpost($1, $2, $3, $4::jsonb, $5, $6, $7)", [org, p.id, f.tekst, JSON.stringify(f.posteringer), regel, auto, f.mot ?? null]);
  else {
    const u = await en<{ id: string; type: "faktura" | "kvittering"; leverandor: string | null; fakturanummer: string | null; beskrivelse: string | null; belop: number }>(
      db,
      "select id, type, leverandor, fakturanummer, beskrivelse, belop::float8 as belop from faktura.utgifter where org_id = $1 and id = $2",
      [org, f.utgift_id],
    );
    if (!u) throw new Error("Fant ikke utgiften");
    const o = await hentRegnskapsoppsett(db, org);
    const k = regnskapskontoer(o);
    const b = betalingsbilag(u, "bank", { ...k, bank: bankKonto(o, k, p.konto) });
    const bilag = (await en<{ id: string }>(db, "select faktura.betal_utgift($1, $2, $3, 'bank', $4, $5::jsonb) as id", [org, u.id, p.dato, b.tekst, JSON.stringify(b.posteringer)]))!.id;
    await db.query("select faktura.avstem_bankpost($1, $2, $3, $4, $5)", [org, p.id, bilag, regel, auto]);
  }
}

const sett = (db: Db, org: string, id: string, status: "ny" | "forslag" | "uavklart", regel: string | null, forslag: unknown) =>
  db.query("select faktura.sett_bankpost($1, $2, $3, $4, $5::jsonb)", [org, id, status, regel, forslag === null ? null : JSON.stringify(forslag)]);

// Avstemmer bankpostene for organisasjonen (workeren, som systemet): poster fra før startdatoen
// som er ført, angres, og de nye (og forslagene og de uavklarte som ikke er vurdert det siste
// kvarteret) vurderes og føres.
export async function avstemBank(db: Db, org: string, maks = 200) {
  const sum = { avstemt: 0, forslag: 0, uavklart: 0, angret: 0 };
  const g = await hentGrunnlag(db, org);
  if (g.o.bank_fra) {
    const gamle = await alle<{ id: string }>(db, "select id from faktura.bankposter where org_id = $1 and status = 'avstemt' and dato < $2 order by dato", [org, g.o.bank_fra]);
    for (const x of gamle) {
      if ((await en<{ status: string }>(db, "select status from faktura.bankposter where id = $1", [x.id]))?.status !== "avstemt") continue;
      await db.query("select faktura.apne_bankpost($1, $2, true)", [org, x.id]);
      sum.angret++;
    }
  }
  const poster = await alle<Post>(
    db,
    `select ${POSTKOLONNER} from faktura.bankposter p
      where p.org_id = $1 and ($2::date is null or p.dato >= $2) and p.status <> 'avstemt'
        and (p.status = 'ny' or (p.status in ('forslag', 'uavklart') and p.auto and (p.vurdert is null or p.vurdert < now() - interval '15 minutes')))
      order by p.dato, p.opprettet, p.id
      limit $3`,
    [org, g.o.bank_fra, maks],
  );
  for (const p of poster) {
    // En overføring kan ha ført denne som motpost tidligere i runden.
    if ((await en<{ status: string }>(db, "select status from faktura.bankposter where id = $1", [p.id]))?.status === "avstemt") continue;
    await db.query("savepoint bankpost");
    try {
      const v = await vurder(db, g, p);
      if (v.utfall === "vent") await sett(db, org, p.id, "ny", v.regel, null);
      else if (v.utfall === "uavklart") {
        await sett(db, org, p.id, "uavklart", v.regel, null);
        sum.uavklart++;
      } else if (v.utfall === "auto" && g.o.bank_auto && p.auto) {
        await utfor(db, org, p, { ...v.forslag, ignorer: v.ignorer ?? null }, v.regel, true);
        sum.avstemt++;
      } else {
        await sett(db, org, p.id, "forslag", v.regel, { ...v.forslag, ignorer: v.ignorer ?? null });
        sum.forslag++;
      }
      await db.query("release savepoint bankpost");
    } catch (e) {
      await db.query("rollback to savepoint bankpost");
      logg("WARNING", "Bankposten ble ikke ført", { org, id: p.id, feil: (e as Error).message });
      await sett(db, org, p.id, "uavklart", `Kunne ikke føres av seg selv: ${(e as Error).message}`.slice(0, 300), null).catch(() => {});
      sum.uavklart++;
    }
  }
  return sum;
}

// Workeren hvert minutt (og rett etter en henting, org): organisasjonene med regnskapet slått på og
// bankposter som skal vurderes, eller som er ført fra før startdatoen, hver i sin transaksjon.
export async function avstemBankForAlle(maksOrg = 25, org: string | null = null) {
  const orgs = await somSystem((db) =>
    alle<{ org_id: string }>(
      db,
      `select x.org_id from (
         select p.org_id from faktura.bankposter p left join faktura.regnskap_oppsett r on r.org_id = p.org_id
          where p.status <> 'avstemt' and (r.bank_fra is null or p.dato >= r.bank_fra)
            and (p.status = 'ny' or (p.status in ('forslag', 'uavklart') and p.auto and (p.vurdert is null or p.vurdert < now() - interval '15 minutes')))
         union
         select r.org_id from faktura.regnskap_oppsett r
          where r.bank_fra is not null and exists (select 1 from faktura.bankposter p where p.org_id = r.org_id and p.status = 'avstemt' and p.dato < r.bank_fra)
       ) x join faktura.organisasjoner o on o.id = x.org_id
       where o.slettet_at is null and ($2::uuid is null or x.org_id = $2) and faktura.har_funksjon(x.org_id, 'regnskap')
       order by random()
       limit $1`,
      [maksOrg, org],
    ),
  );
  const sum = { avstemt: 0, forslag: 0, uavklart: 0, angret: 0 };
  for (const { org_id } of orgs) {
    try {
      const r = await somSystem((db) => avstemBank(db, org_id));
      sum.avstemt += r.avstemt;
      sum.forslag += r.forslag;
      sum.uavklart += r.uavklart;
      sum.angret += r.angret;
    } catch (e) {
      logg("ERROR", "Avstemmingen av banken feilet", { org: org_id, feil: (e as Error).message });
    }
  }
  return sum;
}

// --- Avstemmingen per konto ---------------------------------------------------------------------

export type Kontoavstemming = {
  konto: string;
  vis: string;
  navn: string | null;
  regnskapskonto: string;
  delt: boolean; // kontoen i regnskapet gjelder flere bankkontoer
  hentet_fra: string | null;
  dato: string;
  saldo: number | null; // i banken på datoen (ukjent når banken ikke har oppgitt den)
  regnskap: number; // på kontoen i regnskapet på datoen
  apne: { antall: number; sum: number; poster: { dato: string; tekst: string; belop: number }[] };
  uten_post: { antall: number; sum: number; bilag: { dato: string; nummer: string; tekst: string; belop: number }[] };
  differanse: number | null; // det som ikke er forklart: saldoen før startdatoen, eller ført på andre måter
};

// Avstemmingen for hver bankkonto på datoen (til), eller nå (den siste saldoen banken oppga): saldoen
// i banken, saldoen på kontoen i regnskapet, postene som ikke er ført og bilagene på kontoen uten
// bankpost (fra startdatoen). Saldoen i banken = regnskapet + det som ikke er ført − bilagene uten
// bankpost + differansen.
export async function kontoavstemming(db: Db, org: string, til: string | null = null): Promise<Kontoavstemming[]> {
  const o = await hentRegnskapsoppsett(db, org);
  const k = regnskapskontoer(o);
  const iDag = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Oslo" }).format(new Date());
  const rader = await alle<{ konto: string; hentet_fra: string | null; saldo: number | null; saldo_dato: string | null; navn: string | null }>(
    db,
    `select x.konto, to_char(h.hentet_fra, 'YYYY-MM-DD') as hentet_fra, h.saldo::float8 as saldo, to_char(h.saldo_dato, 'YYYY-MM-DD') as saldo_dato,
            coalesce((select e.navn from faktura.kontoer e where e.org_id = $1 and e.kontonr = x.konto),
                     (select 'Kontoen på fakturaene' from faktura.organisasjoner o where o.id = $1 and o.kontonr = x.konto)) as navn
       from (select konto from faktura.bankpost_kontoer where org_id = $1 union select konto from faktura.bankposter where org_id = $1) x
       left join faktura.bankpost_kontoer h on h.org_id = $1 and h.konto = x.konto
      -- Kontoen på fakturaene først.
      order by x.konto = (select kontonr from faktura.organisasjoner where id = $1) desc nulls last, x.konto`,
    [org],
  );
  const sumPoster = async (konto: string, etter: string, tilOgMed: string) =>
    (await en<{ s: number }>(db, "select coalesce(sum(belop), 0)::float8 as s from faktura.bankposter where org_id = $1 and konto = $2 and dato > $3 and dato <= $4", [org, konto, etter, tilOgMed]))?.s ?? 0;
  const ut: Kontoavstemming[] = [];
  for (const r of rader) {
    let D: string;
    let saldo: number | null = null;
    if (til) {
      // Saldoen banken oppga etter datoen, minus postene imellom; ellers saldoen etter den siste
      // posten med saldo, pluss postene etter den.
      D = til;
      if (r.saldo !== null && r.saldo_dato! >= til) saldo = rund(r.saldo - (await sumPoster(r.konto, til, r.saldo_dato!)));
      else {
        const s = await en<{ saldo: number; etter: number }>(
          db,
          `select p.saldo::float8 as saldo,
                  (select coalesce(sum(x.belop), 0) from faktura.bankposter x
                    where x.org_id = p.org_id and x.konto = p.konto and x.dato <= $3 and (x.dato > p.dato or (x.dato = p.dato and x.opprettet > p.opprettet)))::float8 as etter
             from faktura.bankposter p where p.org_id = $1 and p.konto = $2 and p.saldo is not null and p.dato <= $3
            order by p.dato desc, p.opprettet desc limit 1`,
          [org, r.konto, til],
        );
        if (s) saldo = rund(s.saldo + s.etter);
        else if (r.saldo !== null) saldo = rund(r.saldo + (await sumPoster(r.konto, r.saldo_dato!, til)));
      }
    } else if (r.saldo !== null) {
      D = r.saldo_dato!;
      saldo = r.saldo;
    } else {
      const s = await en<{ saldo: number; dato: string }>(
        db,
        "select saldo::float8 as saldo, to_char(dato, 'YYYY-MM-DD') as dato from faktura.bankposter where org_id = $1 and konto = $2 and saldo is not null order by dato desc, opprettet desc limit 1",
        [org, r.konto],
      );
      D = s?.dato ?? iDag;
      saldo = s?.saldo ?? null;
    }
    const K = bankKonto(o, k, r.konto);
    const delt = rader.filter((x) => bankKonto(o, k, x.konto) === K).length > 1;
    const regnskap = rund(
      (
        await en<{ s: number }>(
          db,
          "select coalesce(sum(p.belop), 0)::float8 as s from faktura.posteringer p join faktura.bilag b on b.id = p.bilag_id where b.org_id = $1 and p.konto = $2 and b.dato <= $3",
          [org, K, D],
        )
      )?.s ?? 0,
    );
    const apne = await alle<{ dato: string; tekst: string; belop: number }>(
      db,
      `select to_char(dato, 'YYYY-MM-DD') as dato, coalesce(nullif(concat_ws(': ', motpart, melding), ''), 'Bankpost') as tekst, belop::float8 as belop
         from faktura.bankposter where org_id = $1 and konto = $2 and status <> 'avstemt' and ($3::date is null or dato >= $3) and dato <= $4
        order by dato, opprettet`,
      [org, r.konto, o.bank_fra, D],
    );
    const utenPost = await alle<{ dato: string; nummer: string; tekst: string; belop: number }>(
      db,
      `select dato, nummer, tekst, rest as belop from (
         select to_char(b.dato, 'YYYY-MM-DD') as dato, b.serie || '-' || b.aar || '-' || b.nummer as nummer, b.tekst, faktura.bilag_bankrest(b.id, $2)::float8 as rest
           from faktura.bilag b
          where b.org_id = $1 and b.reverserer is null and b.reversert_av is null and b.dato <= $4 and ($3::date is null or b.dato >= $3)
            and exists (select 1 from faktura.posteringer p where p.bilag_id = b.id and p.konto = $2)) x
        where rest <> 0 order by dato, nummer`,
      [org, K, o.bank_fra, D],
    );
    const apneSum = rund(apne.reduce((a, p) => a + p.belop, 0));
    const utenSum = rund(utenPost.reduce((a, b) => a + b.belop, 0));
    ut.push({
      konto: r.konto,
      vis: visKonto(r.konto),
      navn: r.navn,
      regnskapskonto: K,
      delt,
      hentet_fra: r.hentet_fra,
      dato: D,
      saldo,
      regnskap,
      apne: { antall: apne.length, sum: apneSum, poster: apne },
      uten_post: { antall: utenPost.length, sum: utenSum, bilag: utenPost },
      differanse: saldo === null || delt ? null : rund(saldo - regnskap - apneSum + utenSum),
    });
  }
  return ut;
}
