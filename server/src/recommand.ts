// Recommand (Peppol-aksesspunkt): hver organisasjon har sin egen konto og API-nøkkel
// (Basic auth: nøkkel-ID og hemmelighet). Se https://docs.recommand.eu og kildekoden i
// github.com/brbxai/recommand-peppol (api/send-document.ts, api/companies, api/documents).
import { config } from "./config.js";
import { DOKUMENTTYPE, PROFIL_ID } from "./ehf.js";

export type RecommandNokkel = { nokkelId: string; hemmelighet: string };

export let recommandFetch: typeof fetch = (...a) => fetch(...a);
export function settRecommandFetch(f: typeof fetch) {
  recommandFetch = f;
}

// Feil fra Recommand. status 0: fikk ikke svar (nett, tidsavbrudd), så utfallet er ukjent.
export class RecommandFeil extends Error {
  constructor(
    melding: string,
    readonly status: number,
    readonly kategori: string | null = null,
  ) {
    super(melding);
  }
}

// Feilmeldingene er { success: false, errors: { felt: [melding] } } eller en tekst.
function melding(data: any, status: number): string {
  const e = data?.errors ?? data?.error ?? data?.message;
  if (typeof e === "string") return e;
  if (e && typeof e === "object") {
    const deler = Object.values(e).flat().filter((x) => typeof x === "string") as string[];
    if (deler.length) return deler.join(" ");
  }
  return `Recommand svarte ${status}`;
}

async function kall(n: RecommandNokkel, metode: "GET" | "POST", sti: string, kropp?: unknown): Promise<any> {
  let r: Response;
  try {
    r = await recommandFetch(`${config.recommandUrl}/api/v1${sti}`, {
      method: metode,
      headers: {
        authorization: `Basic ${Buffer.from(`${n.nokkelId}:${n.hemmelighet}`).toString("base64")}`,
        accept: "application/json",
        ...(kropp === undefined ? {} : { "content-type": "application/json" }),
      },
      body: kropp === undefined ? undefined : JSON.stringify(kropp),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (e) {
    throw new RecommandFeil(`Fikk ikke svar fra Recommand: ${(e as Error).message}`, 0);
  }
  const data: any = await r.json().catch(() => null);
  if (!r.ok || data?.success === false) {
    throw new RecommandFeil(melding(data, r.status), r.status || 500, data?.deliveryFailure?.category ?? null);
  }
  return data;
}

export type RecommandSelskap = {
  id: string;
  name: string;
  enterpriseNumber: string;
  enterpriseNumberScheme: string | null;
  country: string;
  isVerified: boolean;
  isSmpRecipient: boolean;
};

// Selskapet med dette organisasjonsnummeret på kontoen nøkkelen hører til.
export async function finnSelskap(n: RecommandNokkel, orgnr: string): Promise<RecommandSelskap | null> {
  const data = await kall(n, "GET", `/companies?enterpriseNumber=${encodeURIComponent(orgnr)}`);
  const selskaper: RecommandSelskap[] = data?.companies ?? [];
  const treff = selskaper.filter(
    (s) => s.enterpriseNumber?.replace(/\s/g, "") === orgnr && (s.enterpriseNumberScheme == null || s.enterpriseNumberScheme === "0192"),
  );
  return treff.find((s) => s.isVerified) ?? treff[0] ?? null;
}

export type Leveringsstatus = "pending" | "delivered" | "failed" | null;
export type Levering = { channel: string; address: string; status: string; failure?: { category: string; message: string | null } | null };
export type SendtDokument = { id: string; sentOverPeppol: boolean; deliveryStatus: Leveringsstatus; deliveries: Levering[] };

// Sender en ferdig EHF-fil (UBL) over Peppol. Ingen e-post fra Recommand: appen sender
// e-posten selv når EHF ikke kommer fram.
export async function sendEhf(n: RecommandNokkel, selskapId: string, mottaker: string, xml: string, kreditnota: boolean): Promise<SendtDokument> {
  return kall(n, "POST", `/${encodeURIComponent(selskapId)}/send`, {
    recipient: mottaker,
    documentType: "xml",
    document: xml,
    doctypeId: kreditnota ? DOKUMENTTYPE.kreditnota : DOKUMENTTYPE.faktura,
    processId: PROFIL_ID,
  });
}

// Status for et sendt dokument.
export async function hentDokument(n: RecommandNokkel, dokumentId: string): Promise<SendtDokument> {
  const data = await kall(n, "GET", `/documents/${encodeURIComponent(dokumentId)}`);
  return data?.document ?? data;
}

// Hvorfor en Peppol-levering feilet, fra svaret.
export function peppolFeil(d: SendtDokument): { kategori: string | null; melding: string | null } {
  const l = d.deliveries?.find((x) => x.channel === "peppol" && x.status === "failed");
  return { kategori: l?.failure?.category ?? null, melding: l?.failure?.message ?? null };
}
