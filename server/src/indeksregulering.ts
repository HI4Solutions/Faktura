// Daglig indeksregulering: hent KPI, gi gjentakelser og produkter ny pris når datoen
// nærmer seg/er nådd, og planlegg årets reguleringer med varsel til kundene.
import { alle, en, somSystem } from "./db.js";
import { oppdaterKpi } from "./kpi.js";
import { leggIKo } from "./tjenester.js";
import { dato, kr } from "./regler.js";

const logg = (severity: string, message: string, data?: unknown) => console.log(JSON.stringify({ severity, message, ...((data as object) ?? {}) }));

const maanedNavn = (d: string) =>
  new Intl.DateTimeFormat("nb-NO", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${String(d).slice(0, 10)}T00:00:00Z`));
const prosent = (faktor: number) => `${((faktor - 1) * 100).toLocaleString("nb-NO", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} %`;

export async function kjorIndeksregulering() {
  try {
    const n = await oppdaterKpi();
    if (n) logg("INFO", "KPI oppdatert", { nye: n });
  } catch (e) {
    // Uten ny KPI brukes siste kjente; reguleringen venter til den finnes.
    logg("WARNING", "Kunne ikke hente KPI fra SSB", { feil: (e as Error).message });
  }
  const anvendt = await somSystem(async (db) => (await en(db, "select faktura.anvend_indeksreguleringer() as n"))!.n);
  const nye = await somSystem((db) => alle(db, "select * from faktura.planlegg_indeksreguleringer()"));
  for (const r of nye) {
    try {
      await varsle(r);
    } catch (e) {
      logg("ERROR", "Varsel om indeksregulering feilet", { regulering: r.id, feil: (e as Error).message });
    }
  }
  if (anvendt || nye.length) logg("INFO", "Indeksregulering kjørt", { anvendt, planlagt: nye.length });
  return { anvendt, planlagt: nye.length };
}

// Ett varsel per kunde med gjentakende faktura for produktet, med kundens egne beløp.
async function varsle(r: any) {
  const mottakere = await somSystem(async (db) => {
    const p = await en(db, "select navn, indeks_varsle, mva_sats from faktura.produkter where id = $1", [r.produkt_id]);
    if (!p?.indeks_varsle) return [];
    const org = await en(db, "select navn, epost from faktura.organisasjoner where id = $1", [r.org_id]);
    const kunder = await alle(
      db,
      `select k.id, k.navn, k.epost,
              jsonb_agg(l || jsonb_build_object('ny', faktura.indeks_pris((l ->> 'enhetspris')::numeric, $4, $5))) as linjer
         from faktura.gjentakelser g
         join faktura.kunder k on k.id = g.kunde_id
         cross join lateral jsonb_array_elements(g.linjer) l
        where g.org_id = $1 and g.aktiv and k.aktiv and k.epost is not null
          and l ->> 'produkt_id' = $2::text and g.opprettet < $3
        group by k.id, k.navn, k.epost`,
      [r.org_id, r.produkt_id, r.opprettet, r.faktor, r.hele_kroner],
    );
    return kunder.map((k: any) => ({ ...k, produkt: p, org }));
  });

  for (const k of mottakere) {
    const linjer = k.linjer.map((l: any) => {
      const gammel = Number(l.enhetspris);
      const ny = Number(l.ny);
      const mva = Number(l.mva_sats ?? 0);
      const inkl = (n: number) => (mva ? ` (${kr(n * (1 + mva / 100))} inkl. mva)` : "");
      return `  ${l.beskrivelse}: ${kr(gammel)}${inkl(gammel)} → ${kr(ny)}${inkl(ny)}`;
    });
    const tekst = [
      `Hei ${k.navn},`,
      "",
      `Prisen for ${k.produkt.navn} reguleres etter endringen i konsumprisindeksen (KPI) fra SSB.`,
      "",
      `Ny pris gjelder fra ${dato(r.gjelder_fra)}:`,
      ...linjer,
      "",
      `KPI ${maanedNavn(r.kpi_fra)}: ${Number(r.kpi_fra_verdi).toLocaleString("nb-NO")}`,
      `KPI ${maanedNavn(r.kpi_til)}: ${Number(r.kpi_til_verdi).toLocaleString("nb-NO")}`,
      `Endring: ${prosent(Number(r.kpi_til_verdi) / Number(r.kpi_fra_verdi))}` +
        (Number(r.andel) < 100 ? ` (${Number(r.andel).toLocaleString("nb-NO")} % av endringen gir ${prosent(Number(r.faktor))})` : ""),
      "",
      "Fakturaene med forfall fra denne datoen får ny pris automatisk.",
      "",
      "Med vennlig hilsen",
      k.org.navn,
    ].join("\n");
    await leggIKo({
      type: "epost",
      til: [k.epost],
      emne: `Varsel om indeksregulering av ${k.produkt.navn.toLowerCase()} fra ${dato(r.gjelder_fra)}`,
      tekst,
      fra_navn: k.org.navn,
      svar_til: k.org.epost ?? undefined,
    });
  }
  await somSystem((db) => db.query("select faktura.marker_regulering_varslet($1, $2)", [r.id, mottakere.length]));
}
