export const kr = (n: number | null | undefined) =>
  n == null ? "" : new Intl.NumberFormat("nb-NO", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);

export const dato = (iso: string | null | undefined) => {
  if (!iso) return "";
  const [a, m, d] = iso.slice(0, 10).split("-");
  return `${d}.${m}.${a}`;
};

export const orgnr = (n: string | null | undefined) => (n ? n.replace(/^(\d{3})(\d{3})(\d{3})$/, "$1 $2 $3") : "");

export const iDag = () => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Oslo" }).format(new Date());

// Antall dager fra a til b (datoer som «åååå-mm-dd»).
export const dagerMellom = (a: string, b: string) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86_400_000);

export const leggTilDager = (iso: string, dager: number) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dager);
  return d.toISOString().slice(0, 10);
};

// Samme dag n måneder senere; finnes ikke dagen (31. i april), blir det siste dag i måneden.
export const leggTilMaaneder = (iso: string, n: number) => {
  const [a, m, d] = iso.split("-").map(Number) as [number, number, number];
  const ny = new Date(Date.UTC(a, m - 1 + n, 1));
  const siste = new Date(Date.UTC(ny.getUTCFullYear(), ny.getUTCMonth() + 1, 0)).getUTCDate();
  ny.setUTCDate(Math.min(d, siste));
  return ny.toISOString().slice(0, 10);
};

export const intervallTekst: Record<string, string> = { maaned: "Hver måned", kvartal: "Hvert kvartal", aar: "Hvert år" };

const rund = (n: number) => Math.sign(n) * Number(Math.round(Number(`${Math.abs(n)}e2`)) + "e-2");

export interface Tallinje {
  antall: number;
  enhetspris: number;
  mva_sats: number;
  rabatt_prosent?: number | null;
  rabatt_belop?: number | null;
}

// Rabatten i kroner på en linje (som faktura.linje_netto i databasen).
export const linjerabatt = (l: Tallinje) =>
  l.rabatt_belop != null ? Number(l.rabatt_belop) : l.rabatt_prosent != null ? rund((l.antall * l.enhetspris * Number(l.rabatt_prosent)) / 100) : 0;

// Linjebeløpet eks. mva etter rabatt.
export const linjebelop = (l: Tallinje) => rund(l.antall * l.enhetspris - linjerabatt(l));

export function summer(linjer: Tallinje[]) {
  let eks = 0;
  let mva = 0;
  for (const l of linjer) {
    const netto = l.antall * l.enhetspris - linjerabatt(l);
    eks += rund(netto);
    mva += rund((netto * l.mva_sats) / 100);
  }
  return { eks: rund(eks), mva: rund(mva), inkl: rund(eks + mva) };
}

// Deler og runder halvt bort fra null, som round() på numeric i Postgres.
const delRund = (t: bigint, n: bigint): bigint => {
  const a = t < 0n ? -t : t;
  const b = n < 0n ? -n : n;
  const q = a / b + (2n * (a % b) >= b ? 1n : 0n);
  return (t < 0n) !== (n < 0n) ? -q : q;
};

// Fratrekket som tar summen å betale ned til makstaket, regnet som faktura.makstak_fordel i
// databasen (i øre, så det blir likt på øret): én linje per mva-sats, fordelt etter hvor mye
// satsen utgjør av summen inkl. mva. Beløpene er negative. Tomt når summen er under makstaket.
export function makstakFratrekk(linjer: Tallinje[], tak: number | null | undefined): { mva_sats: number; eks: number; mva: number }[] {
  if (tak == null || !(tak > 0)) return [];
  const ore = (n: number) => BigInt(Math.round(n * 100));
  const grupper = new Map<number, bigint>();
  for (const l of linjer) {
    const netto = l.antall * l.enhetspris - linjerabatt(l);
    const sats = Number(l.mva_sats);
    grupper.set(sats, (grupper.get(sats) ?? 0n) + ore(rund(netto)) + ore(rund((netto * sats) / 100)));
  }
  const satser = [...grupper.entries()].sort((a, b) => b[0] - a[0]);
  const total = satser.reduce((s, [, v]) => s + v, 0n);
  const rest = total - ore(tak);
  if (rest <= 0n) return [];
  const positiv = satser.reduce((s, [, v]) => (v > 0n ? s + v : s), 0n);
  // Satsen som tar øreavrundingen: 0 % når den får minst 1 kr av fratrekket, ellers den største.
  let siste = -1;
  satser.forEach(([, v], i) => {
    if (v > 0n && (siste < 0 || v > satser[siste]![1])) siste = i;
  });
  satser.forEach(([sats, v], i) => {
    if (v > 0n && sats === 0 && rest * v >= positiv * 100n) siste = i;
  });
  const hundredeler = (sats: number) => BigInt(Math.round(sats * 100)); // 25 % -> 2500
  const mvaAv = (e: bigint, s: bigint) => delRund(e * s, 10000n);
  const ut: { mva_sats: number; eks: number; mva: number }[] = [];
  const legg = (sats: number, e: bigint, m: bigint) => {
    if (e !== 0n || m !== 0n) ut.push({ mva_sats: sats, eks: Number(-e) / 100, mva: Number(-m) / 100 });
  };
  let trukket = 0n;
  satser.forEach(([sats, v], i) => {
    if (v <= 0n || i === siste) return;
    const s = hundredeler(sats);
    const e = delRund(delRund(rest * v, positiv) * 10000n, 10000n + s);
    const m = mvaAv(e, s);
    trukket += e + m;
    legg(sats, e, m);
  });
  // Resten på den siste satsen: det minste beløpet som med mvaen tar minst resten (aldri over makstaket).
  const sats = satser[siste]![0];
  const s = hundredeler(sats);
  const r = rest - trukket;
  const e0 = delRund(r * 10000n, 10000n + s);
  let best: bigint | null = null;
  for (let d = -3n; d <= 3n; d++) if (e0 + d + mvaAv(e0 + d, s) >= r && (best === null || e0 + d < best)) best = e0 + d;
  const e = best! < 0n ? 0n : best!;
  legg(sats, e, mvaAv(e, s));
  return ut.sort((a, b) => b.mva_sats - a.mva_sats);
}

// Summene etter fratrekket for makstaket.
export function summerMedMakstak(linjer: Tallinje[], tak: number | null | undefined) {
  const sum = summer(linjer);
  const fratrekk = makstakFratrekk(linjer, tak);
  const eks = rund(fratrekk.reduce((s, f) => s + f.eks, 0));
  const mva = rund(fratrekk.reduce((s, f) => s + f.mva, 0));
  return { ...sum, fratrekk: rund(eks + mva), eks: rund(sum.eks + eks), mva: rund(sum.mva + mva), inkl: rund(sum.inkl + eks + mva), foer: sum.inkl };
}

export const statusTekst: Record<string, string> = {
  utkast: "Utkast",
  utstedt: "Sendt",
  betalt: "Betalt",
  kreditert: "Kreditert",
};

export function fakturaMerke(f: { status: string; forfalt?: boolean; type?: string; refusjon_belop?: number; betalt_belop?: number; kreditert_belop?: number; antall_purringer?: number; epost_status?: string | null; ehf_status?: string | null; reservert?: boolean }) {
  // En innbetaling som trolig gjelder fakturaen, er reservert i banken (ikke bokført ennå).
  if (f.status === "utstedt" && f.reservert) return { tekst: "Betaling reservert", klasse: "merke-ok" };
  // EHF som ikke kom fram (uten e-post i stedet), eller der vi ikke vet om den ble sendt.
  if (f.status === "utstedt" && f.ehf_status === "sender") return { tekst: "EHF usikker", klasse: "merke-advarsel" };
  if (f.status === "utstedt" && f.ehf_status === "feilet" && !f.epost_status) return { tekst: "EHF feilet", klasse: "merke-fare" };
  if (f.type === "kreditnota") return { tekst: "Kreditnota", klasse: "merke-noytral" };
  if (f.status === "utstedt" && (f.epost_status === "sprett" || f.epost_status === "klage")) return { tekst: "E-post i retur", klasse: "merke-fare" };
  if (f.status === "utstedt" && (f.antall_purringer ?? 0) > 0) return { tekst: `Purret${(f.antall_purringer ?? 0) > 1 ? ` (${f.antall_purringer})` : ""}`, klasse: "merke-fare" };
  if (f.status === "utstedt" && f.forfalt) return { tekst: "Forfalt", klasse: "merke-fare" };
  if (f.status === "utstedt" && (f.kreditert_belop ?? 0) > 0) return { tekst: "Delvis kreditert", klasse: "merke-noytral" };
  if (f.status === "utstedt" && (f.betalt_belop ?? 0) > 0) return { tekst: "Delbetalt", klasse: "merke-advarsel" };
  if (f.status === "betalt" && (f.refusjon_belop ?? 0) > 0) return { tekst: "Refundert", klasse: "merke-noytral" };
  const klasse = { utkast: "merke-noytral", utstedt: "merke-info", betalt: "merke-ok", kreditert: "merke-noytral" }[f.status] ?? "merke-noytral";
  return { tekst: statusTekst[f.status] ?? f.status, klasse };
}

export const ehfStatus: Record<string, { tekst: string; klasse: string }> = {
  sender: { tekst: "Usikker", klasse: "merke-advarsel" },
  venter: { tekst: "Venter på kvittering", klasse: "merke-info" },
  levert: { tekst: "Levert", klasse: "merke-ok" },
  feilet: { tekst: "Kom ikke fram", klasse: "merke-fare" },
};

// Hvorfor en EHF ikke kom fram (kategoriene fra aksesspunktet).
export const ehfFeil: Record<string, string> = {
  recipient_not_found: "mottakeren er ikke registrert for EHF",
  document_not_supported: "mottakeren tar ikke imot denne typen dokument",
  validation: "fakturaen ble avvist av en regel",
  transport: "den kunne ikke overføres",
  recipient_rejected: "mottakeren avviste den",
  duplicate: "den er sendt før",
  other: "ukjent feil",
};

export const epostStatus: Record<string, { tekst: string; klasse: string }> = {
  sendt: { tekst: "Sendt", klasse: "merke-info" },
  levert: { tekst: "Levert", klasse: "merke-ok" },
  forsinket: { tekst: "Forsinket", klasse: "merke-advarsel" },
  sprett: { tekst: "I retur", klasse: "merke-fare" },
  klage: { tekst: "Merket som søppelpost", klasse: "merke-fare" },
};
