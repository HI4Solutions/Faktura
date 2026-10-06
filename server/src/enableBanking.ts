// Enable Banking (open banking etter PSD2): leser transaksjonene på organisasjonens egen
// bankkonto. Hver organisasjon registrerer sin egen applikasjon hos Enable Banking og
// kobler kontoen sin til den («restricted mode»: bare egne kontoer, uten kostnad).
// Forespørslene signeres med applikasjonens private nøkkel (JWT, RS256).
// API: https://enablebanking.com/docs/api/reference/
import { createHash, createPrivateKey, sign } from "node:crypto";
import { config } from "./config.js";

export type BankNokkel = { appId: string; privatNokkel: string };
// Brukeren er til stede (trykket «Hent nå»): teller ikke mot bankens grense for henting
// uten brukeren (fire ganger i døgnet etter PSD2).
export type Psu = { ip: string; agent: string };

export let bankFetch: typeof fetch = (...a) => fetch(...a);
export function settBankFetch(f: typeof fetch) {
  bankFetch = f;
}

// Feil fra Enable Banking eller banken. status 0: fikk ikke svar.
export class BankFeil extends Error {
  constructor(
    melding: string,
    readonly status: number,
    readonly kode: string | null = null,
  ) {
    super(melding);
  }
}

const b64 = (x: string | Buffer) => Buffer.from(x).toString("base64url");

export function lagJwt(n: BankNokkel, naa = Math.floor(Date.now() / 1000)): string {
  const hode = b64(JSON.stringify({ typ: "JWT", alg: "RS256", kid: n.appId }));
  const innhold = b64(JSON.stringify({ iss: "enablebanking.com", aud: "api.enablebanking.com", iat: naa, exp: naa + 3600 }));
  const signatur = sign("RSA-SHA256", Buffer.from(`${hode}.${innhold}`), n.privatNokkel);
  return `${hode}.${innhold}.${b64(signatur)}`;
}

// Hva som er galt med nøkkelen, eller null om den er en privat RSA-nøkkel (PEM).
export function nokkelFeil(pem: string): string | null {
  try {
    const k = createPrivateKey(pem);
    return k.asymmetricKeyType === "rsa" ? null : "Nøkkelen må være en RSA-nøkkel.";
  } catch {
    return "Fant ingen gyldig privat nøkkel. Bruk .pem-filen du fikk da du registrerte applikasjonen hos Enable Banking.";
  }
}

function feilmelding(data: any, status: number): string {
  const d = data?.message ?? data?.detail ?? data?.error;
  if (typeof d === "string" && d) return d;
  if (Array.isArray(d)) {
    const m = d.map((x: any) => x?.msg ?? x?.message).filter((x: unknown) => typeof x === "string");
    if (m.length) return m.join(" ");
  }
  return `Enable Banking svarte ${status}`;
}

async function kall(n: BankNokkel, metode: "GET" | "POST" | "DELETE", sti: string, kropp?: unknown, psu?: Psu): Promise<any> {
  let r: Response;
  try {
    r = await bankFetch(`${config.enableBankingUrl}${sti}`, {
      method: metode,
      headers: {
        authorization: `Bearer ${lagJwt(n)}`,
        accept: "application/json",
        ...(kropp === undefined ? {} : { "content-type": "application/json" }),
        ...(psu ? { "psu-ip-address": psu.ip, "psu-user-agent": psu.agent } : {}),
      },
      body: kropp === undefined ? undefined : JSON.stringify(kropp),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (e) {
    throw new BankFeil(`Fikk ikke svar fra Enable Banking: ${(e as Error).message}`, 0);
  }
  const data: any = await r.json().catch(() => null);
  if (!r.ok) throw new BankFeil(feilmelding(data, r.status), r.status, typeof data?.error === "string" ? data.error : null);
  return data;
}

export type Bank = { name: string; country: string; psu_types?: string[]; maximum_consent_validity?: number; beta?: boolean };

export const hentApplikasjon = (n: BankNokkel): Promise<any> => kall(n, "GET", "/application");

export async function hentBanker(n: BankNokkel, land = "NO"): Promise<Bank[]> {
  return (await kall(n, "GET", `/aspsps?country=${encodeURIComponent(land)}`))?.aspsps ?? [];
}

// Banken brukeren mener: Enable Banking krever det nøyaktige navnet. Store og små
// bokstaver spiller ingen rolle, og «Storebrand» finner «Storebrand Bank» når det bare er
// én bank som passer. Feiler med en forklaring (og forslag) ellers.
export function velgBank(banker: Bank[], navn: string, psuType: "business" | "personal"): Bank {
  const v = navn.trim().toLowerCase();
  const like = banker.filter((b) => b.name.toLowerCase() === v);
  const delvis = banker.filter((b) => b.name.toLowerCase().includes(v) || v.includes(b.name.toLowerCase()));
  const treff = like.length ? like : delvis;
  const medType = treff.filter((b) => !b.psu_types?.length || b.psu_types.includes(psuType));
  if (medType.length === 1 || (medType.length > 1 && like.length)) return medType[0];
  const type = psuType === "business" ? "bedriftskontoer" : "privatkontoer";
  if (treff.length && !medType.length) throw new BankFeil(`${treff[0].name} støtter ikke ${type} gjennom Enable Banking.`, 400);
  const forslag = (medType.length ? medType : banker.filter((b) => b.name.toLowerCase().includes(v.split(/\s+/)[0] ?? ""))).map((b) => b.name);
  throw new BankFeil(
    medType.length > 1
      ? `Flere banker passer med «${navn}»: ${forslag.slice(0, 6).join(", ")}. Skriv hele navnet.`
      : `Fant ikke banken «${navn}» hos Enable Banking.${forslag.length ? ` Mente du ${forslag.slice(0, 5).join(", ")}?` : ""}`,
    400,
  );
}

// Samtykket varer så lenge banken tillater (oftest 180 dager), litt kortere for å ha margin.
export function gyldigTil(maksSekunder: number | null | undefined, naa = Date.now()): Date {
  const sek = Math.min(maksSekunder && maksSekunder > 0 ? maksSekunder : 90 * 86400, 180 * 86400);
  return new Date(naa + sek * 1000 - 3 * 3600_000);
}

// Starter BankID-innloggingen hos banken. Brukeren sendes til url og kommer tilbake til
// redirect med ?code=…&state=….
export async function startAutorisering(
  n: BankNokkel,
  a: { bank: string; land: string; psuType: "business" | "personal"; gyldigTil: Date; state: string; redirect: string },
): Promise<string> {
  const d = await kall(n, "POST", "/auth", {
    access: { valid_until: a.gyldigTil.toISOString() },
    aspsp: { name: a.bank, country: a.land },
    state: a.state,
    redirect_url: a.redirect,
    psu_type: a.psuType,
  });
  if (typeof d?.url !== "string") throw new BankFeil("Enable Banking ga ingen adresse til banken", 502);
  return d.url;
}

export type BankKonto = { uid: string; account_id?: { iban?: string; other?: { identification?: string } }; name?: string; product?: string; details?: string; currency?: string };
export type BankOkt = { session_id: string; accounts: BankKonto[]; access?: { valid_until?: string } };

export async function opprettOkt(n: BankNokkel, kode: string): Promise<BankOkt> {
  const d = await kall(n, "POST", "/sessions", { code: kode });
  if (typeof d?.session_id !== "string") throw new BankFeil("Enable Banking ga ingen økt", 502);
  return { session_id: d.session_id, accounts: Array.isArray(d.accounts) ? d.accounts : [], access: d.access };
}

export const slettOkt = (n: BankNokkel, id: string) => kall(n, "DELETE", `/sessions/${encodeURIComponent(id)}`);

// Alle transaksjoner på kontoen fra og med datoen (side for side).
export async function hentTransaksjoner(n: BankNokkel, kontoUid: string, fra: string, psu?: Psu): Promise<any[]> {
  const alle: any[] = [];
  let fortsett: string | undefined;
  for (let side = 0; side < 50; side++) {
    const q = new URLSearchParams({ date_from: fra });
    if (fortsett) q.set("continuation_key", fortsett);
    const d = await kall(n, "GET", `/accounts/${encodeURIComponent(kontoUid)}/transactions?${q}`, undefined, psu);
    alle.push(...(Array.isArray(d?.transactions) ? d.transactions : []));
    fortsett = typeof d?.continuation_key === "string" && d.continuation_key ? d.continuation_key : undefined;
    if (!fortsett) break;
  }
  return alle;
}

// Kontonummeret (11 siffer) for en norsk konto, ellers IBAN eller det banken oppgir.
export function kontonr(k: BankKonto): string {
  const iban = k.account_id?.iban?.replace(/\s/g, "").toUpperCase();
  if (iban?.startsWith("NO") && iban.length === 15) return iban.slice(4);
  const annen = k.account_id?.other?.identification?.replace(/[\s.]/g, "");
  return annen || iban || k.uid;
}

export type Innbetaling = {
  ekstern_id: string;
  dato: string;
  belop: number;
  valuta: string;
  betaler: string | null;
  betaler_konto: string | null;
  melding: string | null;
  referanse: string | null;
};

const tekst = (x: unknown): string | null => (typeof x === "string" && x.trim() ? x.trim() : null);

// Innbetalingene (bokførte penger inn) blant transaksjonene, i datoorden. Uten id fra
// banken får transaksjonen et fingeravtrykk; like transaksjoner samme dag nummereres.
export function tilInnbetalinger(transaksjoner: any[]): Innbetaling[] {
  const sett = new Map<string, number>();
  const ut: Innbetaling[] = [];
  for (const t of transaksjoner) {
    const belop = Math.abs(Number(t?.transaction_amount?.amount));
    const inn = t?.credit_debit_indicator ? t.credit_debit_indicator === "CRDT" : Number(t?.transaction_amount?.amount) > 0;
    if (!inn || !Number.isFinite(belop) || belop <= 0) continue;
    if (t?.status && t.status !== "BOOK") continue; // reservert, ikke bokført ennå
    const dato = tekst(t?.booking_date) ?? tekst(t?.value_date) ?? tekst(t?.transaction_date);
    if (!dato) continue;
    const info = Array.isArray(t?.remittance_information) ? t.remittance_information : [t?.remittance_information];
    const melding = [...info, t?.note].map(tekst).filter(Boolean).join(" ") || null;
    const i = {
      dato: dato.slice(0, 10),
      belop: Math.round(belop * 100) / 100,
      valuta: tekst(t?.transaction_amount?.currency)?.toUpperCase() ?? "NOK",
      betaler: tekst(t?.debtor?.name),
      betaler_konto: tekst(t?.debtor_account?.iban) ?? tekst(t?.debtor_account?.other?.identification) ?? tekst(t?.debtor_account?.bban),
      melding,
      referanse: tekst(t?.reference_number),
    };
    let id = tekst(t?.entry_reference) ?? tekst(t?.transaction_id);
    if (!id) {
      const avtrykk = createHash("sha256").update(JSON.stringify(i)).digest("base64url").slice(0, 32);
      const nr = (sett.get(avtrykk) ?? 0) + 1;
      sett.set(avtrykk, nr);
      id = `fp:${avtrykk}:${nr}`;
    }
    ut.push({ ekstern_id: id, ...i });
  }
  return ut.sort((a, b) => a.dato.localeCompare(b.dato));
}
