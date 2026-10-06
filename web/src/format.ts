export const kr = (n: number | null | undefined) =>
  n == null ? "" : new Intl.NumberFormat("nb-NO", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);

export const dato = (iso: string | null | undefined) => {
  if (!iso) return "";
  const [a, m, d] = iso.slice(0, 10).split("-");
  return `${d}.${m}.${a}`;
};

export const orgnr = (n: string | null | undefined) => (n ? n.replace(/^(\d{3})(\d{3})(\d{3})$/, "$1 $2 $3") : "");

export const iDag = () => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Oslo" }).format(new Date());

export const leggTilDager = (iso: string, dager: number) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dager);
  return d.toISOString().slice(0, 10);
};

const rund = (n: number) => Math.sign(n) * Number(Math.round(Number(`${Math.abs(n)}e2`)) + "e-2");

export function summer(linjer: { antall: number; enhetspris: number; mva_sats: number }[]) {
  let eks = 0;
  let mva = 0;
  for (const l of linjer) {
    eks += rund(l.antall * l.enhetspris);
    mva += rund((l.antall * l.enhetspris * l.mva_sats) / 100);
  }
  return { eks: rund(eks), mva: rund(mva), inkl: rund(eks + mva) };
}

export const statusTekst: Record<string, string> = {
  utkast: "Utkast",
  utstedt: "Sendt",
  betalt: "Betalt",
  kreditert: "Kreditert",
};

export function fakturaMerke(f: { status: string; forfalt?: boolean; type?: string; refusjon_belop?: number; betalt_belop?: number; kreditert_belop?: number }) {
  if (f.type === "kreditnota") return { tekst: "Kreditnota", klasse: "merke-noytral" };
  if (f.status === "utstedt" && f.forfalt) return { tekst: "Forfalt", klasse: "merke-fare" };
  if (f.status === "utstedt" && (f.kreditert_belop ?? 0) > 0) return { tekst: "Delvis kreditert", klasse: "merke-noytral" };
  if (f.status === "utstedt" && (f.betalt_belop ?? 0) > 0) return { tekst: "Delbetalt", klasse: "merke-advarsel" };
  if (f.status === "betalt" && (f.refusjon_belop ?? 0) > 0) return { tekst: "Refundert", klasse: "merke-noytral" };
  const klasse = { utkast: "merke-noytral", utstedt: "merke-info", betalt: "merke-ok", kreditert: "merke-noytral" }[f.status] ?? "merke-noytral";
  return { tekst: statusTekst[f.status] ?? f.status, klasse };
}
