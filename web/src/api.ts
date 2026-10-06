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
  if (type.includes("application/pdf")) return (await r.blob()) as T;
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
