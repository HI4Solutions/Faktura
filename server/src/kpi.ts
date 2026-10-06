// Konsumprisindeksen fra SSB, månedlig totalindeks. Fra 2026 har KPI nytt basisår:
// tabell 14709 «Konsumprisindeks (2025=100), etter måned» erstatter tabell 03013
// (2015=100), som ble avsluttet i desember 2025. Den nye tabellen har hele serien
// tilbake til 1920 regnet om til ny basis, og hele serien hentes hver gang. Da har alle
// lagrede tall samme basis, og forholdet mellom to måneder (som reguleringen bruker)
// stemmer. Hentes av workeren hver dag og lagres i faktura.kpi.
import { somSystem } from "./db.js";

const TABELL = "14709";
const V2 = `https://data.ssb.no/api/pxwebapi/v2/tables/${TABELL}/data?lang=no&outputFormat=json-stat2`;
const V0 = `https://data.ssb.no/api/v0/no/table/${TABELL}`;
const alle = (code: string) => ({ code, selection: { filter: "all", values: ["*"] } });
// Variabelkodene i tabellen er ikke låst her: først med «ContentsCode», så uten.
const FORSOK: { url: string; kropp?: unknown }[] = [
  { url: `${V2}&valueCodes[ContentsCode]=*&valueCodes[Tid]=*` },
  { url: `${V2}&valueCodes[Tid]=*` },
  { url: V0, kropp: { query: [alle("ContentsCode"), alle("Tid")], response: { format: "json-stat2" } } },
  { url: V0, kropp: { query: [alle("Tid")], response: { format: "json-stat2" } } },
];

export let ssbFetch: typeof fetch = (...a) => fetch(...a);
export function settSsbFetch(f: typeof fetch) {
  ssbFetch = f;
}

export type KpiVerdi = { maaned: string; verdi: number };

const koder = (kategori: any): string[] =>
  Array.isArray(kategori?.index)
    ? kategori.index
    : Object.entries(kategori?.index ?? {})
        .sort((a, b) => (a[1] as number) - (b[1] as number))
        .map(([k]) => k);

// Hvilken verdi i en dimensjon som er selve indeksen (ikke endring eller vekt), og
// hvilken konsumgruppe som er totalen.
function velg(dimensjon: any): number {
  const k = koder(dimensjon?.category);
  if (k.length <= 1) return 0;
  const etikett = (kode: string) => String(dimensjon.category.label?.[kode] ?? kode).toLowerCase();
  const ikkeEndring = (kode: string) => !/endr|vekt|prosent|pst|change|weight/i.test(`${kode} ${etikett(kode)}`);
  const treff = [
    k.findIndex((kode) => /^KpiInd/i.test(kode)),
    k.findIndex((kode) => /indeks|index/.test(etikett(kode)) && ikkeEndring(kode)),
    k.findIndex((kode) => /^(TOTAL|00|0)$/i.test(kode) || /totalindeks|i alt|total/.test(etikett(kode))),
  ].find((i) => i >= 0);
  return treff ?? 0;
}

// JSON-stat 2: verdiene ligger i én liste, ordnet etter dimensjonene i «id» (den siste
// varierer raskest). Tiden har koder som «2026M08».
export function lesJsonStat(d: any): KpiVerdi[] {
  if (!d?.dimension || (!Array.isArray(d.value) && typeof d.value !== "object")) throw new Error("Uventet svar fra SSB");
  const ider: string[] = Array.isArray(d.id) ? d.id : Object.keys(d.dimension);
  const storrelser: number[] = Array.isArray(d.size) ? d.size : ider.map((id) => koder(d.dimension[id]?.category).length);
  const tid = ider.find((id) => id === "Tid") ?? ider.find((id) => /tid|time|month|maaned/i.test(id));
  if (!tid) throw new Error("Uventet svar fra SSB: mangler tid");
  const steg = ider.map((_, i) => storrelser.slice(i + 1).reduce((a, b) => a * b, 1));
  const fast = ider.reduce((sum, id, i) => (id === tid ? sum : sum + velg(d.dimension[id]) * steg[i]!), 0);
  const ti = ider.indexOf(tid);

  const ut: KpiVerdi[] = [];
  koder(d.dimension[tid].category).forEach((kode, pos) => {
    const m = /^(\d{4})M(\d{2})$/.exec(kode);
    const verdi = d.value[fast + pos * steg[ti]!];
    if (m && typeof verdi === "number" && verdi > 0) ut.push({ maaned: `${m[1]}-${m[2]}-01`, verdi });
  });
  if (!ut.length) throw new Error("Ingen KPI-verdier i svaret fra SSB");
  return ut.sort((a, b) => a.maaned.localeCompare(b.maaned));
}

// Sikring mot å blande basisår: snittet for 2025 skal være 100 (2025=100).
export function sjekkBasis(verdier: KpiVerdi[]) {
  const aar = verdier.filter((v) => v.maaned.startsWith("2025-"));
  if (aar.length < 12) return;
  const snitt = aar.reduce((s, v) => s + v.verdi, 0) / aar.length;
  if (snitt < 97 || snitt > 103) throw new Error(`KPI fra SSB har uventet basis (snitt for 2025 er ${snitt.toFixed(1)}, ventet 100)`);
}

export async function hentKpi(): Promise<KpiVerdi[]> {
  const feil: string[] = [];
  for (const f of FORSOK) {
    try {
      const r = await ssbFetch(f.url, {
        method: f.kropp ? "POST" : "GET",
        headers: f.kropp ? { "content-type": "application/json", accept: "application/json" } : { accept: "application/json" },
        body: f.kropp ? JSON.stringify(f.kropp) : undefined,
        signal: AbortSignal.timeout(30_000),
      });
      if (!r.ok) throw new Error(`SSB ${r.status}`);
      const verdier = lesJsonStat(await r.json());
      sjekkBasis(verdier);
      return verdier;
    } catch (e) {
      feil.push((e as Error).message);
    }
  }
  throw new Error(`Fikk ikke KPI fra SSB: ${feil.join("; ")}`);
}

export async function oppdaterKpi(): Promise<number> {
  const verdier = await hentKpi();
  return somSystem(async (db) => (await db.query("select faktura.lagre_kpi($1) as n", [JSON.stringify(verdier)])).rows[0].n as number);
}
