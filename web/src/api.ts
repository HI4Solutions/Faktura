import { hentAuth } from "./firebase";

export class ApiFeil extends Error {
  constructor(public status: number, melding: string) {
    super(melding);
  }
}

async function token(): Promise<string> {
  const a = await hentAuth();
  if (!a.currentUser) throw new ApiFeil(401, "Ikke innlogget");
  return a.currentUser.getIdToken();
}

export async function api<T = any>(metode: string, sti: string, kropp?: unknown): Promise<T> {
  const r = await fetch(`/api${sti}`, {
    method: metode,
    headers: { authorization: `Bearer ${await token()}`, ...(kropp !== undefined ? { "content-type": "application/json" } : {}) },
    body: kropp === undefined ? undefined : JSON.stringify(kropp),
  });
  if (r.status === 204) return undefined as T;
  const type = r.headers.get("content-type") ?? "";
  if (!r.ok) {
    const data = type.includes("json") ? await r.json().catch(() => ({})) : {};
    throw new ApiFeil(r.status, data.error ?? `Feil ${r.status}`);
  }
  if (type.includes("application/pdf") || type.includes("application/xml") || type.startsWith("image/") || type.startsWith("text/csv")) return (await r.blob()) as T;
  return r.json();
}

export const hent = <T = any>(sti: string) => api<T>("GET", sti);

// Åpner en faktura-PDF: utkast kommer som fil, utstedte som en signert lenke.
export async function apnePdf(orgId: string, fakturaId: string) {
  const vindu = window.open("", "_blank");
  try {
    const svar = await api<Blob | { url: string }>("GET", `/org/${orgId}/fakturaer/${fakturaId}/pdf`);
    const url = svar instanceof Blob ? URL.createObjectURL(svar) : svar.url;
    if (vindu) vindu.location.href = url;
    else window.location.href = url;
  } catch (e) {
    vindu?.close();
    throw e;
  }
}

export async function lastOppLogo(orgId: string, fil: File) {
  const r = await fetch(`/api/org/${orgId}/logo`, {
    method: "PUT",
    headers: { authorization: `Bearer ${await token()}`, "content-type": fil.type || "application/octet-stream" },
    body: fil,
  });
  if (!r.ok) throw new ApiFeil(r.status, (await r.json().catch(() => ({}))).error ?? `Feil ${r.status}`);
}

// Sender et lydopptak (fakturautkast fra tale): rå lyd i kroppen, med lydtypen.
export async function sendLyd<T = any>(sti: string, lyd: Blob): Promise<T> {
  const r = await fetch(`/api${sti}`, {
    method: "POST",
    headers: { authorization: `Bearer ${await token()}`, "content-type": lyd.type || "audio/webm" },
    body: lyd,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiFeil(r.status, data.error ?? (r.status === 413 ? "Opptaket er for langt. Hold det under to minutter." : `Feil ${r.status}`));
  return data;
}

// Sender en fil (f.eks. lønnsslipper til AI) rått i kroppen, med filtypen (og filnavnet).
export async function sendFil<T = any>(sti: string, fil: Blob, forStor = "Fila er for stor.", filnavn?: string): Promise<T> {
  const r = await fetch(`/api${sti}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${await token()}`,
      "content-type": fil.type || "application/octet-stream",
      ...(filnavn ? { "x-filnavn": encodeURIComponent(filnavn) } : {}),
    },
    body: fil,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiFeil(r.status, data.error ?? (r.status === 413 ? forStor : `Feil ${r.status}`));
  return data;
}

export type Vedlegg = { id: string; filnavn: string; type: string; storrelse: number };

// Laster opp et vedlegg. Det står uten faktura til utkastet lagres med det.
export async function lastOppVedlegg(orgId: string, fil: File): Promise<Vedlegg> {
  const r = await fetch(`/api/org/${orgId}/vedlegg`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${await token()}`,
      "content-type": fil.type || "application/octet-stream",
      "x-filnavn": encodeURIComponent(fil.name),
    },
    body: fil,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiFeil(r.status, data.error ?? (r.status === 413 ? "Filen er for stor. Et vedlegg kan være høyst 10 MB." : `Feil ${r.status}`));
  return data;
}

// Åpner et vedlegg med en signert lenke: PDF og bilder i en ny fane, resten lastes ned.
export async function apneVedlegg(orgId: string, fakturaId: string, v: Vedlegg) {
  const vises = v.type === "application/pdf" || v.type.startsWith("image/");
  const vindu = vises ? window.open("", "_blank") : null;
  try {
    const { url } = await api<{ url: string }>("GET", `/org/${orgId}/fakturaer/${fakturaId}/vedlegg/${v.id}`);
    if (vindu) vindu.location.href = url;
    else if (vises) window.location.href = url;
    else {
      const a = document.createElement("a");
      a.href = url;
      a.rel = "noopener";
      a.click();
    }
  } catch (e) {
    vindu?.close();
    throw e;
  }
}

export async function lastNed(sti: string, filnavn: string, metode = "GET") {
  const blob = await api<Blob>(metode, sti);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filnavn;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
