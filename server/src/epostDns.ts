// E-post fra domenet (docs/domene.md): DKIM-nøkkelen fra Resend og DMARC-oppføringen for
// avsenderdomenet, slått opp i DNS fra API-et og vist under Plattform → Drift. Uten DMARC består
// e-posten DKIM og SPF, men Outlook og Hotmail kan ikke knytte det til avsenderen: de viser «We
// can't verify this email came from the sender» og legger den ofte i søppelposten.
import { resolveTxt } from "node:dns/promises";

type Oppslag = (navn: string) => Promise<string[][]>;
let slaOpp: Oppslag = resolveTxt;
// For testene: DNS byttet ut.
export function settDnsOppslag(fn: Oppslag) {
  slaOpp = fn;
}

export type Domenesjekk = {
  domene: string;
  adresse: string;
  dkim: { ok: boolean; navn: string; feil: string | null };
  dmarc: { ok: boolean; navn: string; verdi: string | null; policy: string | null; feil: string | null; forslag: string };
};

// TXT-oppføringene for et navn (delene i hver satt sammen). Et navn uten oppføringer gir en tom
// liste; andre feil (tidsavbrudd, DNS svarer ikke) kommer med som feil.
async function txt(navn: string): Promise<{ verdier: string[]; feil: string | null }> {
  let tid: ReturnType<typeof setTimeout> | undefined;
  try {
    const r = await Promise.race([
      slaOpp(navn),
      new Promise<never>((_, nei) => {
        tid = setTimeout(() => nei(new Error("DNS svarte ikke innen 5 sekunder")), 5000);
      }),
    ]);
    return { verdier: r.map((deler) => deler.join("")), feil: null };
  } catch (e) {
    const kode = (e as { code?: string }).code;
    if (kode === "ENOTFOUND" || kode === "ENODATA") return { verdier: [], feil: null };
    return { verdier: [], feil: (e as Error).message || "Oppslaget feilet" };
  } finally {
    clearTimeout(tid);
  }
}

// DKIM: nøkkelen Resend signerer med (resend._domainkey). DMARC: én oppføring som begynner med
// v=DMARC1 og har en policy (p=none, quarantine eller reject); flere oppføringer er det samme som
// ingen. Forslaget er oppføringen i docs/domene.md, med rapportene til avsenderadressen.
export async function sjekkEpostdomene(adresse: string): Promise<Domenesjekk> {
  const domene = (adresse.split("@")[1] ?? adresse).toLowerCase();
  const dkimNavn = `resend._domainkey.${domene}`;
  const dmarcNavn = `_dmarc.${domene}`;
  const [dkim, dmarc] = await Promise.all([txt(dkimNavn), txt(dmarcNavn)]);
  const dmarcer = dmarc.verdier.filter((v) => /^\s*v=DMARC1\s*(;|$)/i.test(v));
  const verdi = dmarcer.length === 1 ? dmarcer[0]!.trim() : null;
  const policy = verdi?.match(/(?:^|;)\s*p\s*=\s*(none|quarantine|reject)\s*(?:;|$)/i)?.[1]?.toLowerCase() ?? null;
  return {
    domene,
    adresse,
    dkim: { ok: dkim.verdier.some((v) => /(^|;)\s*p=[A-Za-z0-9+/]/.test(v)), navn: dkimNavn, feil: dkim.feil },
    dmarc: {
      ok: Boolean(policy),
      navn: dmarcNavn,
      verdi: verdi ?? (dmarcer.length > 1 ? `${dmarcer.length} DMARC-oppføringer (det skal bare være én)` : null),
      policy,
      feil: dmarc.feil,
      forslag: `v=DMARC1; p=none; rua=mailto:${adresse}; adkim=r; aspf=r`,
    },
  };
}

// Avsenderadressen og reserveadressen (config.epostAvsender og epostAvsenderReserve), ett domene
// én gang.
export async function sjekkEpostdomener(adresser: (string | undefined | null)[]): Promise<Domenesjekk[]> {
  const unike = new Map<string, string>();
  for (const a of adresser) {
    if (!a) continue;
    const d = (a.split("@")[1] ?? a).toLowerCase();
    if (!unike.has(d)) unike.set(d, a);
  }
  return Promise.all([...unike.values()].map(sjekkEpostdomene));
}
