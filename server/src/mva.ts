// Mva-meldingen fra bilagene (0093_mva.sql). For hver termin regnes linjene i mva-meldingen fra
// posteringene i bilagene som er datert i terminen, etter Skatteetatens regler for meldingen
// (github.com/Skatteetaten/mva-meldingen, informasjonsmodellen og forretningsreglene):
//  - utgående avgift (kode 3, 31, 32 og 33) med grunnlag, sats og merverdiavgift; omsetning uten
//    avgift (5, 6, 51, 52) med grunnlaget og sats 0;
//  - inngående avgift (1, 11, 12, 13) bare med merverdiavgiften, negativ, uten grunnlag og sats;
//  - tjenester kjøpt fra utlandet: den beregnede avgiften med grunnlag og sats, og fradraget på egen
//    linje med samme kode (86 og 88; 87 og 89 har ikke fradrag);
//  - hele kroner, og summen av linjene er det som skal betales (eller er til gode).
// Grunnlaget er grunnlagslinjene med koden (salget); for kjøp fra utlandet regnes det fra den beregnede
// avgiften, siden kostnaden også kan ha avgiften uten fradrag i seg (og et anleggsmiddel har ikke koden
// på balansekontoen). Avgiften er posteringene på avgiftskontoene (koden på posteringen, ellers
// kontoens kode). Oppgjøret føres i et bilag i
// serie V: avgiftskontoene mot oppgjørskontoen (2740) med øredifferansen på 7740, og føres på nytt
// når terminen endres. Den som fører regnskapet merker terminen som levert når meldingen er levert i
// Altinn; endres den etterpå, sier appen fra.
import { Hono, type Context } from "hono";
import { z } from "zod";
import { hentRegnskapsoppsett, mnd, plussMnd, regnskapskontoer, sisteDag, type Regnskapsoppsett, type Regnskapsrolle } from "./anlegg.js";
import { alle, en, somBruker, type Db } from "./db.js";
import { ApiFeil } from "./feil.js";
import { pluss, virkedag } from "./lonnsberegning.js";
import type { Rapportdef } from "./rapportmodul.js";
import { dato as visDato, kr } from "./regler.js";
import { bokforSalgNaa } from "./salgBokforing.js";

const MND = ["januar", "februar", "mars", "april", "mai", "juni", "juli", "august", "september", "oktober", "november", "desember"];
const pad = (n: number) => String(n).padStart(2, "0");
const rund = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
// Hele kroner (halve kroner bort fra null).
const krone = (n: number) => Math.sign(n) * Math.round(Math.abs(rund(n)));
const osloIDag = () => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Oslo" }).format(new Date());

// --- Terminene -------------------------------------------------------------------------------------

export type Termintype = "tomaaneder" | "aar" | "maaned";
export type Termin = {
  aar: number;
  type: Termintype;
  termin: number;
  fra: string;
  til: string;
  navn: string; // «4. termin 2026 (juli–august)»
  periode: string; // som i mva-meldingen: «juli-august», «september» eller «aarlig»
  frist: string;
};

// Fristen for meldingen (og betalingen): en måned og ti dager etter terminen; for mai–juni 31. august,
// for årstermin 10. mars; flyttes til neste virkedag.
export function mvaFrist(aar: number, type: Termintype, termin: number) {
  const sisteMnd = type === "tomaaneder" ? termin * 2 : type === "maaned" ? termin : 12;
  let d = type === "aar" ? `${aar + 1}-03-10` : type === "tomaaneder" && termin === 3 ? `${aar}-08-31` : `${plussMnd(`${aar}-${pad(sisteMnd)}`, 2)}-10`;
  while (!virkedag(d)) d = pluss(d, 1);
  return d;
}

export function lagTermin(aar: number, type: Termintype, termin: number): Termin {
  const [m1, m2] = type === "tomaaneder" ? [termin * 2 - 1, termin * 2] : type === "maaned" ? [termin, termin] : [1, 12];
  return {
    aar,
    type,
    termin,
    fra: `${aar}-${pad(m1)}-01`,
    til: sisteDag(`${aar}-${pad(m2)}`),
    navn: type === "tomaaneder" ? `${termin}. termin ${aar} (${MND[m1 - 1]}–${MND[m2 - 1]})` : type === "maaned" ? `${MND[m1 - 1]} ${aar}` : `${aar} (årstermin)`,
    periode: type === "tomaaneder" ? `${MND[m1 - 1]}-${MND[m2 - 1]}` : type === "maaned" ? MND[m1 - 1]! : "aarlig",
    frist: mvaFrist(aar, type, termin),
  };
}

export function terminFor(dato: string, type: Termintype): Termin {
  const aar = Number(dato.slice(0, 4));
  const m = Number(dato.slice(5, 7));
  return lagTermin(aar, type, type === "tomaaneder" ? Math.ceil(m / 2) : type === "maaned" ? m : 1);
}

// Terminen som slutter med måneden (ÅÅÅÅ-MM), eller null.
export function terminSomSlutter(maaned: string, type: Termintype): Termin | null {
  const t = terminFor(`${maaned}-01`, type);
  return mnd(t.til) === maaned ? t : null;
}

const TYPENAVN: Record<Termintype, string> = { tomaaneder: "annenhver måned", aar: "årstermin", maaned: "hver måned" };

// Terminlengden for året: den som er brukt (oppgjøret er bokført eller meldingen levert), ellers
// innstillingen. Byttes innstillingen (f.eks. til årstermin fra nyttår), står årene før som de ble
// levert, og avgiften gjøres ikke opp to ganger.
export async function terminType(db: Db, org: string, aar: number, standard: Termintype): Promise<Termintype> {
  const r = await en<{ type: Termintype }>(
    db,
    `select t.type from faktura.mva_terminer t
      where t.org_id = $1 and t.aar = $2
        and (t.levert is not null
             or exists (select 1 from faktura.bilag b where b.org_id = t.org_id and b.kilde = 'mva' and b.kilde_id = t.id
                                                         and b.reverserer is null and b.reversert_av is null))
      order by t.type = $3 desc
      limit 1`,
    [org, aar, standard],
  );
  return r?.type ?? standard;
}

// --- Kodene ----------------------------------------------------------------------------------------

// Skatteetatens standard mva-koder (SAF-T), de som kan stå i en alminnelig mva-melding.
export const MVA_KODER: Record<string, string> = {
  "1": "Fradragsberettiget innenlands inngående merverdiavgift, 25 %",
  "11": "Fradragsberettiget innenlands inngående merverdiavgift, 15 %",
  "12": "Fradragsberettiget innenlands inngående merverdiavgift, 11,11 %",
  "13": "Fradragsberettiget innenlands inngående merverdiavgift, 12 %",
  "14": "Fradragsberettiget innførselsmerverdiavgift, 25 %",
  "15": "Fradragsberettiget innførselsmerverdiavgift, 15 %",
  "3": "Utgående merverdiavgift, 25 %",
  "31": "Utgående merverdiavgift, 15 %",
  "32": "Utgående merverdiavgift, 11,11 %",
  "33": "Utgående merverdiavgift, 12 %",
  "5": "Innenlands omsetning og uttak fritatt for merverdiavgift",
  "51": "Innenlandsk omsetning med omvendt avgiftsplikt",
  "52": "Utførsel av varer og tjenester",
  "6": "Omsetning og uttak utenfor merverdiavgiftsloven",
  "81": "Innførsel av varer med fradragsrett, 25 %",
  "82": "Innførsel av varer uten fradragsrett, 25 %",
  "83": "Innførsel av varer med fradragsrett, 15 %",
  "84": "Innførsel av varer uten fradragsrett, 15 %",
  "85": "Innførsel av varer som det ikke skal beregnes merverdiavgift av",
  "86": "Tjenester kjøpt fra utlandet med fradragsrett, 25 %",
  "87": "Tjenester kjøpt fra utlandet uten fradragsrett, 25 %",
  "88": "Tjenester kjøpt fra utlandet med fradragsrett, 12 %",
  "89": "Tjenester kjøpt fra utlandet uten fradragsrett, 12 %",
  "91": "Kjøp av klimakvoter eller gull med fradragsrett",
  "92": "Kjøp av klimakvoter eller gull uten fradragsrett",
};
const UTGAENDE: Record<string, number> = { "3": 25, "31": 15, "32": 11.11, "33": 12 };
const UTEN_AVGIFT = ["5", "6", "51", "52", "85"]; // sats 0; 85 er kjøp (innførsel), de andre salg
const OMVENDT: Record<string, number> = { "81": 25, "82": 25, "83": 15, "84": 15, "86": 25, "87": 25, "88": 12, "89": 12, "91": 25, "92": 25 };
const INNGAENDE = ["1", "11", "12", "13", "14", "15"];
const INN_SATS: Record<string, number> = { "1": 25, "11": 15, "12": 11.11, "13": 12, "14": 25, "15": 15 };
// Satsen for koden (0 for omsetning uten avgift), og om avgiften beregnes av kjøperen (omvendt
// avgiftsplikt: grunnlaget er det kjøpet avgiften er beregnet av). Til SAF-T (saft.ts).
export const mvaSats = (kode: string) => UTGAENDE[kode] ?? OMVENDT[kode] ?? INN_SATS[kode] ?? 0;
export const omvendtAvgift = (kode: string) => kode in OMVENDT;
const FRADRAG_OMVENDT = ["81", "83", "86", "88", "91"];

// Avgiftskontoene: utgående (med kode), beregnet ved kjøp fra utlandet, inngående (med kode) og
// fradraget ved kjøp fra utlandet.
type Avgiftskonto = { art: "utg" | "beregnet" | "inn" | "fradrag_utland"; kode: string };
const AVGIFTSROLLER: [Regnskapsrolle, Avgiftskonto][] = [
  ["utgaende_mva", { art: "utg", kode: "3" }],
  ["utgaende_mva_middels", { art: "utg", kode: "31" }],
  ["utgaende_mva_rafisk", { art: "utg", kode: "32" }],
  ["utgaende_mva_lav", { art: "utg", kode: "33" }],
  ["utgaende_mva_utland", { art: "beregnet", kode: "86" }],
  ["inngaende_mva", { art: "inn", kode: "1" }],
  ["inngaende_mva_middels", { art: "inn", kode: "11" }],
  ["inngaende_mva_rafisk", { art: "inn", kode: "12" }],
  ["inngaende_mva_lav", { art: "inn", kode: "13" }],
  ["inngaende_mva_utland", { art: "fradrag_utland", kode: "86" }],
];
export function avgiftskontoer(o: Regnskapsoppsett) {
  const k = regnskapskontoer(o);
  return new Map(AVGIFTSROLLER.map(([rolle, a]) => [k[rolle], a]));
}
const gyldigPaa = (art: Avgiftskonto["art"], kode: string) =>
  art === "utg" ? kode in UTGAENDE : art === "beregnet" ? kode in OMVENDT : art === "inn" ? INNGAENDE.includes(kode) : FRADRAG_OMVENDT.includes(kode);

// --- Meldingen -------------------------------------------------------------------------------------

export type Mvalinje = { kode: string; beskrivelse: string; grunnlag: number | null; sats: number | null; merverdiavgift: number; fradrag: boolean };
export type Postering = { konto: string; belop: number; mva_kode: string | null };
export type Mvaberegning = { linjer: Mvalinje[]; sum: number; kontoer: Record<string, number>; kontroller: string[] };

// Linjene i meldingen fra posteringene i terminen (uten oppgjørsbilagene).
export function beregnMva(poster: Postering[], konti: Map<string, Avgiftskonto>): Mvaberegning {
  const grunnlag = new Map<string, number>();
  const avgift = new Map<string, number>(); // utgående og beregnet (positivt)
  const fradrag = new Map<string, number>(); // inngående (negativt)
  const kontoer: Record<string, number> = {}; // bevegelsen på hver avgiftskonto
  const leggTil = (m: Map<string, number>, k: string, b: number) => m.set(k, rund((m.get(k) ?? 0) + b));
  let utenKode = 0;
  const ugyldige = new Set<string>();
  const ukjente = new Set<string>();
  for (const p of poster) {
    const a = konti.get(p.konto);
    if (a) {
      kontoer[p.konto] = rund((kontoer[p.konto] ?? 0) + p.belop);
      let kode = p.mva_kode ?? a.kode;
      if (!p.mva_kode) utenKode++;
      else if (!gyldigPaa(a.art, kode)) {
        ugyldige.add(`kode ${kode} på ${p.konto}`);
        kode = a.kode;
      }
      if (a.art === "utg" || a.art === "beregnet") leggTil(avgift, kode, -p.belop);
      else leggTil(fradrag, kode, -p.belop);
    } else if (p.mva_kode) {
      if (p.mva_kode in UTGAENDE || (UTEN_AVGIFT.includes(p.mva_kode) && p.mva_kode !== "85")) leggTil(grunnlag, p.mva_kode, -p.belop);
      else if (p.mva_kode in OMVENDT || p.mva_kode === "85") leggTil(grunnlag, p.mva_kode, p.belop);
      else if (!INNGAENDE.includes(p.mva_kode)) ukjente.add(p.mva_kode);
    }
  }
  const linjer: Mvalinje[] = [];
  const koder = [...new Set([...grunnlag.keys(), ...avgift.keys(), ...fradrag.keys()])].sort((x, y) => Number(x) - Number(y));
  for (const kode of koder) {
    const a = avgift.get(kode) ?? 0;
    const g = kode in OMVENDT && a !== 0 ? rund((a * 100) / OMVENDT[kode]!) : (grunnlag.get(kode) ?? 0);
    const f = fradrag.get(kode) ?? 0;
    const sats = UTGAENDE[kode] ?? OMVENDT[kode] ?? (UTEN_AVGIFT.includes(kode) ? 0 : null);
    if (sats !== null && (krone(g) !== 0 || krone(a) !== 0))
      linjer.push({ kode, beskrivelse: MVA_KODER[kode] ?? `Kode ${kode}`, grunnlag: krone(g), sats, merverdiavgift: krone(a), fradrag: false });
    if (krone(f) !== 0) linjer.push({ kode, beskrivelse: MVA_KODER[kode] ?? `Kode ${kode}`, grunnlag: null, sats: null, merverdiavgift: krone(f), fradrag: true });
  }
  const sum = linjer.reduce((s, l) => s + l.merverdiavgift, 0);
  const kontroller: string[] = [];
  if (utenKode) kontroller.push(`${utenKode} ${utenKode === 1 ? "postering" : "posteringer"} på avgiftskontoene har ikke mva-kode; de er regnet med kontoens kode.`);
  if (ugyldige.size) kontroller.push(`Ugyldig mva-kode for kontoen (${[...ugyldige].join(", ")}); regnet med kontoens kode.`);
  if (ukjente.size) kontroller.push(`Mva-kode ${[...ukjente].join(", ")} er ikke med i meldingen.`);
  for (const l of linjer) {
    if (l.fradrag || !l.sats || l.grunnlag === null) continue;
    const venter = (l.grunnlag * l.sats) / 100;
    if (Math.abs(venter - l.merverdiavgift) > 1 + Math.abs(l.grunnlag) * 0.0005)
      kontroller.push(`Kode ${l.kode}: avgiften er ${kr(l.merverdiavgift)} kr, men ${String(l.sats).replace(".", ",")} % av grunnlaget er ${kr(venter)} kr.`);
  }
  for (const l of linjer.filter((x) => !x.fradrag && x.grunnlag !== null && x.grunnlag < 0))
    kontroller.push(`Grunnlaget for kode ${l.kode} er negativt (f.eks. kreditnotaer); i Altinn må det forklares med en merknad.`);
  for (const kode of FRADRAG_OMVENDT) {
    const b = linjer.find((l) => l.kode === kode && !l.fradrag)?.merverdiavgift ?? 0;
    const f = -(linjer.find((l) => l.kode === kode && l.fradrag)?.merverdiavgift ?? 0);
    if (f > b) kontroller.push(`Kode ${kode}: fradraget (${kr(f)} kr) er større enn den beregnede avgiften (${kr(b)} kr).`);
  }
  return { linjer, sum, kontoer, kontroller };
}

// Oppgjørsbilaget: avgiftskontoene mot oppgjørskontoen (det som skal betales i hele kroner) og
// øredifferansen.
export function oppgjorsposter(b: Mvaberegning, k: Record<Regnskapsrolle, string>, tekst: string) {
  const linjer = Object.entries(b.kontoer)
    .filter(([, belop]) => belop !== 0)
    .sort(([x], [y]) => x.localeCompare(y))
    .map(([konto, belop]) => ({ konto, belop: rund(-belop), tekst }));
  if (!linjer.length) return [];
  const rest = rund(-linjer.reduce((s, l) => s + l.belop, 0) + b.sum);
  linjer.push({ konto: k.oppgjor_mva, belop: -b.sum, tekst });
  if (rest !== 0) linjer.push({ konto: k.oreavrunding, belop: rest, tekst: "Øreavrunding" });
  return linjer.filter((l) => l.belop !== 0);
}

export type Mvastatus = {
  termin: Termin;
  over: boolean;
  registrert: boolean;
  linjer: Mvalinje[];
  sum: number;
  kontroller: string[];
  oppgjor: { bilag: { id: string; bilagsnummer: string } | null; stemmer: boolean; trengs: boolean };
  levert: { dato: string; belop: number; av: string | null } | null;
  endret: boolean; // endret etter at meldingen ble levert
};

async function hentPoster(db: Db, org: string, t: Termin, konti: Map<string, Avgiftskonto>) {
  return alle<Postering>(
    db,
    `select p.konto, p.belop::float8 as belop, p.mva_kode
       from faktura.posteringer p join faktura.bilag b on b.id = p.bilag_id
      where b.org_id = $1 and b.dato between $2::date and $3::date and b.kilde <> 'mva'
        and (p.mva_kode is not null or p.konto = any($4::text[]))
      order by b.dato, b.serie, b.nummer, p.rekke`,
    [org, t.fra, t.til, [...konti.keys()]],
  );
}

async function terminrad(db: Db, org: string, t: Termin, lag = false) {
  if (lag)
    await db.query("insert into faktura.mva_terminer (org_id, aar, type, termin) values ($1, $2, $3, $4) on conflict (org_id, aar, type, termin) do nothing", [
      org,
      t.aar,
      t.type,
      t.termin,
    ]);
  return en<{ id: string; levert: string | null; levert_belop: number | null; levert_av: string | null }>(
    db,
    `select t.id, to_char(t.levert, 'YYYY-MM-DD') as levert, t.levert_belop::float8 as levert_belop,
            (select coalesce(u.navn, u.epost) from faktura.brukere u where u.id = t.levert_av) as levert_av
       from faktura.mva_terminer t where t.org_id = $1 and t.aar = $2 and t.type = $3 and t.termin = $4`,
    [org, t.aar, t.type, t.termin],
  );
}

// Det gjeldende oppgjøret for terminen, med summen per konto.
async function gjeldendeOppgjor(db: Db, org: string, terminId: string | undefined) {
  if (!terminId) return null;
  const b = await en<{ id: string; bilagsnummer: string }>(
    db,
    `select b.id, b.serie || '-' || b.aar || '-' || b.nummer as bilagsnummer from faktura.bilag b
      where b.org_id = $1 and b.kilde = 'mva' and b.kilde_id = $2 and b.reverserer is null and b.reversert_av is null`,
    [org, terminId],
  );
  if (!b) return null;
  const p = await alle<{ konto: string; belop: number }>(db, "select konto, sum(belop)::float8 as belop from faktura.posteringer where bilag_id = $1 group by konto", [b.id]);
  return { ...b, kontoer: Object.fromEntries(p.map((x) => [x.konto, rund(x.belop)])) as Record<string, number> };
}
const perKonto = (l: { konto: string; belop: number }[]) => {
  const m: Record<string, number> = {};
  for (const x of l) m[x.konto] = rund((m[x.konto] ?? 0) + x.belop);
  return m;
};
// Fører linjene det samme på hver konto som det gjeldende oppgjøret?
const sammeKontoer = (a: { konto: string; belop: number }[], b: Record<string, number>) => {
  const x = Object.entries(perKonto(a)).filter(([, v]) => v !== 0);
  const y = Object.entries(b).filter(([, v]) => v !== 0);
  return x.length === y.length && x.every(([k, v]) => b[k] === v);
};

// Meldingen for terminen, med oppgjøret og om den er levert.
export async function mvaStatus(db: Db, org: string, t: Termin, iDag = osloIDag()): Promise<Mvastatus> {
  // Fakturaene og innbetalingene som ikke er bokført ennå (workeren gjør det hvert minutt).
  await bokforSalgNaa(db, org);
  const o = await hentRegnskapsoppsett(db, org);
  const k = regnskapskontoer(o);
  const konti = avgiftskontoer(o);
  const b = beregnMva(await hentPoster(db, org, t, konti), konti);
  const registrert = Boolean((await en<{ r: boolean }>(db, "select mva_registrert as r from faktura.organisasjoner where id = $1", [org]))?.r);
  if (!registrert && b.linjer.some((l) => l.merverdiavgift !== 0))
    b.kontroller.unshift("Organisasjonen er ikke registrert for merverdiavgift (Innstillinger → Organisasjon), men har avgift i terminen.");
  const rad = await terminrad(db, org, t);
  const opp = await gjeldendeOppgjor(db, org, rad?.id);
  const onsket = oppgjorsposter(b, k, `Mva-oppgjør ${t.navn}`);
  return {
    termin: t,
    over: t.til < iDag,
    registrert,
    linjer: b.linjer,
    sum: b.sum,
    kontroller: b.kontroller,
    oppgjor: { bilag: opp ? { id: opp.id, bilagsnummer: opp.bilagsnummer } : null, stemmer: opp ? sammeKontoer(onsket, opp.kontoer) : !onsket.length, trengs: onsket.length > 0 },
    levert: rad?.levert ? { dato: rad.levert, belop: rad.levert_belop ?? 0, av: rad.levert_av } : null,
    endret: Boolean(rad?.levert && rad.levert_belop !== b.sum),
  };
}

// Fører oppgjøret for terminen (eller på nytt når terminen er endret, eller angrer det når det ikke
// er noe å gjøre opp). Gir bilaget som ble ført, eller null når oppgjøret stemte.
export async function bokforOppgjor(db: Db, org: string, t: Termin, iDag = osloIDag()) {
  if (t.til >= iDag) throw new ApiFeil(409, "Terminen er ikke over");
  await bokforSalgNaa(db, org);
  const o = await hentRegnskapsoppsett(db, org);
  const k = regnskapskontoer(o);
  const konti = avgiftskontoer(o);
  const b = beregnMva(await hentPoster(db, org, t, konti), konti);
  const tekst = `Mva-oppgjør ${t.navn}`;
  const poster = oppgjorsposter(b, k, tekst);
  const avrunding = Math.abs(poster.find((p) => p.konto === k.oreavrunding && p.tekst === "Øreavrunding")?.belop ?? 0);
  if (avrunding > 0.5 * (b.linjer.length + 1))
    throw new ApiFeil(409, `Posteringene på avgiftskontoene stemmer ikke med mva-meldingen (${kr(avrunding)} kr); se kontrollene`);
  const rad = (await terminrad(db, org, t, true))!;
  const opp = await gjeldendeOppgjor(db, org, rad.id);
  if (!poster.length) {
    if (opp) await db.query("select faktura.angre_mva_oppgjor($1, $2)", [org, rad.id]);
    return null;
  }
  if (opp && sammeKontoer(poster, opp.kontoer)) return null;
  const id = (await en<{ id: string }>(db, "select faktura.bokfor_mva_oppgjor($1, $2, $3, $4, $5::jsonb) as id", [org, rad.id, t.til, tekst, JSON.stringify(poster)]))!.id;
  return (await en<{ id: string; bilagsnummer: string }>(db, "select id, serie || '-' || aar || '-' || nummer as bilagsnummer from faktura.bilag where id = $1", [id]))!;
}

// Månedsavslutningen (maanedsavslutning.ts, som systemet): oppgjøret for terminene som slutter fra og
// med måneden automatikken startet til og med måneden som er avsluttet (de to siste årene), når
// organisasjonen er mva-registrert eller har avgift i terminen.
export async function bokforOppgjorTil(db: Db, org: string, maaned: string, fra: string, iDag = osloIDag()) {
  const o = await hentRegnskapsoppsett(db, org);
  const bilag: { id: string; bilagsnummer: string; tekst: string; sum: number }[] = [];
  const feil: string[] = [];
  const start = fra > plussMnd(maaned, -24) ? fra : plussMnd(maaned, -24);
  const typer = new Map<number, Termintype>();
  for (let m = start; m <= maaned; m = plussMnd(m, 1)) {
    const aar = Number(m.slice(0, 4));
    if (!typer.has(aar)) typer.set(aar, await terminType(db, org, aar, o.mva_termin));
    const t = terminSomSlutter(m, typer.get(aar)!);
    if (!t) continue;
    await db.query("savepoint mva_oppgjor");
    try {
      const b = await bokforOppgjor(db, org, t, iDag);
      await db.query("release savepoint mva_oppgjor");
      if (b) bilag.push({ ...b, tekst: `Mva-oppgjør ${t.navn}`, sum: 0 });
    } catch (e) {
      await db.query("rollback to savepoint mva_oppgjor");
      feil.push(`${t.navn}: ${(e as Error).message}`);
    }
  }
  return { bilag, feil };
}

// --- Rutene (under /api/org/:org) ------------------------------------------------------------------

const uuid = z.string().uuid();
const orgId = (c: Context) => uuid.parse(c.req.param("org"));
const bruk = <T>(c: Context, fn: (db: Db) => Promise<T>) => somBruker<T>(c.get("bruker").id, fn);
const krev = (db: Db, org: string) => db.query("select faktura.krev($1, 'regnskap')", [org]);
const aarS = z.coerce.number({ error: "Ugyldig år" }).int("Ugyldig år").min(2000, "Ugyldig år").max(2100, "Ugyldig år");
const terminS = z.coerce.number({ error: "Ugyldig termin" }).int("Ugyldig termin").min(1, "Ugyldig termin").max(12, "Ugyldig termin");

async function terminFraSti(db: Db, c: Context) {
  const o = await hentRegnskapsoppsett(db, orgId(c));
  const aar = aarS.parse(c.req.param("aar"));
  const termin = terminS.parse(c.req.param("termin"));
  const type = await terminType(db, orgId(c), aar, o.mva_termin);
  if ((type === "tomaaneder" && termin > 6) || (type === "aar" && termin !== 1)) throw new ApiFeil(400, "Ugyldig termin");
  return lagTermin(aar, type, termin);
}

export function mvaRuter() {
  const r = new Hono();

  // Terminen (standard: den siste som er over) og terminene i året med summen.
  r.get("/regnskap/mva", async (c) => {
    const q = z.object({ aar: aarS.optional(), termin: terminS.optional() }).parse(c.req.query());
    return c.json(
      await bruk(c, async (db) => {
        await krev(db, orgId(c));
        const o = await hentRegnskapsoppsett(db, orgId(c));
        const iDag = osloIDag();
        const typeFor = (dato: string) => terminType(db, orgId(c), Number(dato.slice(0, 4)), o.mva_termin);
        let t: Termin;
        if (q.aar) {
          const type = await typeFor(String(q.aar));
          if (q.termin && type === "tomaaneder" && q.termin > 6) throw new ApiFeil(400, "Ugyldig termin");
          t = lagTermin(q.aar, type, type === "aar" ? 1 : (q.termin ?? 1));
        } else {
          // Den siste terminen som er over.
          const naa = terminFor(iDag, await typeFor(iDag));
          const dagFor = pluss(naa.fra, -1);
          t = terminFor(dagFor, await typeFor(dagFor));
        }
        if (t.fra > iDag) throw new ApiFeil(400, "Terminen har ikke begynt");
        const antall = t.type === "tomaaneder" ? 6 : t.type === "maaned" ? 12 : 1;
        const terminer = [];
        for (let n = 1; n <= antall; n++) {
          const x = lagTermin(t.aar, t.type, n);
          if (x.fra > iDag) break;
          const s = n === t.termin ? null : await mvaStatus(db, orgId(c), x, iDag);
          terminer.push({ termin: n, navn: x.navn, frist: x.frist, over: x.til < iDag, sum: s?.sum ?? null, levert: s ? s.levert !== null : null });
        }
        const status = await mvaStatus(db, orgId(c), t, iDag);
        if (t.type !== o.mva_termin && t.aar >= Number(iDag.slice(0, 4)))
          status.kontroller.push(
            `Terminene i ${t.aar} er ${TYPENAVN[t.type]}, som oppgjørene og meldingene som er bokført og levert; innstillingen (${TYPENAVN[o.mva_termin]}) gjelder fra ${t.aar + 1}, eller fra ${t.aar} når de er angret.`,
          );
        return {
          type: t.type,
          ...status,
          terminer: terminer.map((x) => (x.termin === t.termin ? { ...x, sum: status.sum, levert: status.levert !== null } : x)),
          laast_til: o.laast_til,
        };
      }),
    );
  });

  // Fører oppgjøret (eller på nytt).
  r.post("/regnskap/mva/:aar/:termin/oppgjor", async (c) =>
    c.json(
      await bruk(c, async (db) => {
        await krev(db, orgId(c));
        const t = await terminFraSti(db, c);
        const bilag = await bokforOppgjor(db, orgId(c), t);
        return { bilag, status: await mvaStatus(db, orgId(c), t) };
      }),
      201,
    ),
  );

  // Angrer oppgjøret.
  r.delete("/regnskap/mva/:aar/:termin/oppgjor", async (c) =>
    c.json(
      await bruk(c, async (db) => {
        await krev(db, orgId(c));
        const t = await terminFraSti(db, c);
        const rad = await terminrad(db, orgId(c), t);
        if (!rad) throw new ApiFeil(409, "Oppgjøret for terminen er ikke bokført");
        await db.query("select faktura.angre_mva_oppgjor($1, $2)", [orgId(c), rad.id]);
        return mvaStatus(db, orgId(c), t);
      }),
    ),
  );

  // Meldingen er levert i Altinn (datoen; beløpet er det appen regner nå).
  r.put("/regnskap/mva/:aar/:termin/levert", async (c) => {
    const b = z.object({ dato: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Ugyldig dato") }).parse(await c.req.json().catch(() => ({})));
    return c.json(
      await bruk(c, async (db) => {
        await krev(db, orgId(c));
        const t = await terminFraSti(db, c);
        const iDag = osloIDag();
        if (t.til >= iDag) throw new ApiFeil(409, "Terminen er ikke over");
        if (b.dato > iDag) throw new ApiFeil(400, "Datoen kan ikke være fram i tid");
        if (b.dato <= t.til) throw new ApiFeil(400, "Meldingen kan ikke være levert før terminen var over");
        const s = await mvaStatus(db, orgId(c), t, iDag);
        await terminrad(db, orgId(c), t, true);
        await db.query(
          `update faktura.mva_terminer set levert = $5, levert_belop = $6, levert_av = faktura.bruker_id(), oppdatert = now()
            where org_id = $1 and aar = $2 and type = $3 and termin = $4`,
          [orgId(c), t.aar, t.type, t.termin, b.dato, s.sum],
        );
        return mvaStatus(db, orgId(c), t, iDag);
      }),
    );
  });

  r.delete("/regnskap/mva/:aar/:termin/levert", async (c) =>
    c.json(
      await bruk(c, async (db) => {
        await krev(db, orgId(c));
        const t = await terminFraSti(db, c);
        await db.query(
          "update faktura.mva_terminer set levert = null, levert_belop = null, levert_av = null, oppdatert = now() where org_id = $1 and aar = $2 and type = $3 and termin = $4",
          [orgId(c), t.aar, t.type, t.termin],
        );
        return mvaStatus(db, orgId(c), t);
      }),
    ),
  );

  return r;
}

// --- Rapporten -------------------------------------------------------------------------------------

export const mvaRapporter: Rapportdef[] = [
  {
    id: "regnskap.mva",
    modul: "regnskap",
    navn: "Mva-melding",
    beskrivelse:
      "Linjene i mva-meldingen for terminen, regnet fra bilagene: mva-koden, grunnlaget og satsen for utgående avgift, fradraget for inngående avgift, og summen å betale eller til gode, med fristen, oppgjøret og kontrollene.",
    funksjon: "regnskap",
    tilgang: "regnskap",
    parameter: "termin",
    maanedlig: true,
    hent: async (db, org, v) => {
      const o = await hentRegnskapsoppsett(db, org);
      // Terminen etter årets terminlengde som inneholder den valgte tomånedersterminen.
      const type = await terminType(db, org, v.aar, o.mva_termin);
      const t = type === "tomaaneder" ? lagTermin(v.aar, "tomaaneder", v.termin) : terminFor(`${v.aar}-${pad(v.termin * 2)}-01`, type);
      const s = await mvaStatus(db, org, t);
      const merknad = [
        `${t.navn}: ${s.sum >= 0 ? `${kr(s.sum)} kr å betale` : `${kr(-s.sum)} kr til gode`}, fristen er ${visDato(t.frist)}.`,
        s.levert ? `Levert ${visDato(s.levert.dato)}${s.endret ? ` med ${kr(s.levert.belop)} kr; endret etterpå, lever en korrigert melding.` : "."}` : s.over ? "Ikke levert." : "Terminen er ikke over.",
        s.oppgjor.bilag ? `Oppgjøret er bokført (${s.oppgjor.bilag.bilagsnummer})${s.oppgjor.stemmer ? "" : ", men terminen er endret etterpå"}.` : s.oppgjor.trengs && s.over ? "Oppgjøret er ikke bokført." : "",
        ...s.kontroller,
      ]
        .filter(Boolean)
        .join(" ");
      return {
        merknad,
        kolonner: [
          { nokkel: "kode", navn: "Kode", type: "tekst" },
          { nokkel: "hva", navn: "Hva" },
          { nokkel: "grunnlag", navn: "Grunnlag", type: "kr" },
          { nokkel: "sats", navn: "Sats", type: "prosent" },
          { nokkel: "mva", navn: "Merverdiavgift", type: "kr", sum: true },
        ],
        rader: s.linjer.map((l) => ({ kode: l.kode, hva: l.fradrag && l.kode in OMVENDT ? `${l.beskrivelse} (fradrag)` : l.beskrivelse, grunnlag: l.grunnlag ?? "", sats: l.sats ?? "", mva: l.merverdiavgift })),
      };
    },
  },
];
