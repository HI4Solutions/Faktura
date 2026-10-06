// Konsumprisindeksen fra SSB (tabell 03013, totalindeks, 2015=100), månedlig.
// Hentes av workeren hver dag og lagres i faktura.kpi.
import { somSystem } from "./db.js";

const V2 =
  "https://data.ssb.no/api/pxwebapi/v2/tables/03013/data?lang=no&outputFormat=json-stat2" +
  "&valueCodes[Konsumgrp]=TOTAL&valueCodes[ContentsCode]=KpiIndMnd&valueCodes[Tid]=top(36)";
const V0 = "https://data.ssb.no/api/v0/no/table/03013";
const V0_SPORRING = {
  query: [
    { code: "Konsumgrp", selection: { filter: "item", values: ["TOTAL"] } },
    { code: "ContentsCode", selection: { filter: "item", values: ["KpiIndMnd"] } },
    { code: "Tid", selection: { filter: "top", values: ["36"] } },
  ],
  response: { format: "json-stat2" },
};

export let ssbFetch: typeof fetch = (...a) => fetch(...a);
export function settSsbFetch(f: typeof fetch) {
  ssbFetch = f;
}

export type KpiVerdi = { maaned: string; verdi: number };

// JSON-stat 2: dimensjonen «Tid» har koder som «2026M08»; verdiene ligger i samme
// rekkefølge (de andre dimensjonene har bare én verdi hver).
export function lesJsonStat(d: any): KpiVerdi[] {
  const tid = d?.dimension?.Tid?.category?.index;
  if (!tid || !Array.isArray(d.value)) throw new Error("Uventet svar fra SSB");
  const ut: KpiVerdi[] = [];
  for (const [kode, pos] of Object.entries(tid) as [string, number][]) {
    const m = /^(\d{4})M(\d{2})$/.exec(kode);
    const verdi = d.value[pos];
    if (m && typeof verdi === "number" && verdi > 0) ut.push({ maaned: `${m[1]}-${m[2]}-01`, verdi });
  }
  if (!ut.length) throw new Error("Ingen KPI-verdier i svaret fra SSB");
  return ut.sort((a, b) => a.maaned.localeCompare(b.maaned));
}

export async function hentKpi(): Promise<KpiVerdi[]> {
  try {
    const r = await ssbFetch(V2, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
    if (!r.ok) throw new Error(`SSB ${r.status}`);
    return lesJsonStat(await r.json());
  } catch (e) {
    // Reserve: det eldre API-et.
    const r = await ssbFetch(V0, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(V0_SPORRING),
      signal: AbortSignal.timeout(20_000),
    });
    if (!r.ok) throw new Error(`SSB: ${(e as Error).message}; reserve ${r.status}`);
    return lesJsonStat(await r.json());
  }
}

export async function oppdaterKpi(): Promise<number> {
  const verdier = await hentKpi();
  return somSystem(async (db) => (await db.query("select faktura.lagre_kpi($1) as n", [JSON.stringify(verdier)])).rows[0].n as number);
}
