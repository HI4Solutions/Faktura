// Yrkeskodene i a-meldingen: SSBs yrkeskatalog (klassifikasjon 145 i Klass), sju siffer der de
// fire første er STYRK-08. Bare koder fra katalogen godtas; en ukjent kode gir avvist a-melding
// (MAGNET_EDAG-115B). Katalogen hentes fra data.ssb.no og huskes et døgn; går hentingen galt,
// brukes den forrige.
import { Hono } from "hono";
import { z } from "zod";
import { ApiFeil } from "./feil.js";

export type Yrke = { kode: string; navn: string };

const KLASS = "https://data.ssb.no/api/klass/v1/classifications/145/codesAt";
const DOGN = 24 * 3600 * 1000;

export let klassFetch: typeof fetch = (...a) => fetch(...a);
export function settKlassFetch(f: typeof fetch) {
  klassFetch = f;
  katalog = undefined;
}

type Katalog = { hentet: number; yrker: Yrke[]; kart: Map<string, Yrke> };
let katalog: Katalog | undefined;
let henter: Promise<Katalog> | undefined;

async function hentKatalog(): Promise<Katalog> {
  const dato = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Oslo" }).format(new Date());
  const r = await klassFetch(`${KLASS}?date=${dato}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`SSB svarte ${r.status}`);
  const d = (await r.json()) as { codes?: { code?: unknown; name?: unknown }[] };
  const yrker = (Array.isArray(d?.codes) ? d.codes : [])
    .filter((x): x is { code: string; name: string } => typeof x?.code === "string" && /^\d{7}$/.test(x.code) && typeof x?.name === "string")
    .map((x) => ({ kode: x.code, navn: x.name.trim() }))
    .sort((a, b) => a.kode.localeCompare(b.kode));
  if (!yrker.length) throw new Error("Ingen yrkeskoder i svaret fra SSB");
  return { hentet: Date.now(), yrker, kart: new Map(yrker.map((y) => [y.kode, y])) };
}

export async function yrkeskatalog(): Promise<Katalog> {
  if (katalog && Date.now() - katalog.hentet < DOGN) return katalog;
  henter ??= hentKatalog()
    .then((k) => (katalog = k))
    .catch((e) => {
      if (katalog) return katalog; // den forrige brukes til SSB svarer igjen
      throw e;
    })
    .finally(() => (henter = undefined));
  return henter;
}

const ord = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

// Søk i katalogen: på koden (sifrene den begynner med) eller på ordene i navnet. De som begynner
// med søket, kommer først, så de der et ord begynner med det, og de korteste navnene først.
export function sokYrker(yrker: Yrke[], sok: string, maks = 20): Yrke[] {
  const q = ord(sok);
  if (!q) return [];
  const siffer = q.replace(/\s/g, "");
  if (/^\d+$/.test(siffer)) return yrker.filter((y) => y.kode.startsWith(siffer)).slice(0, maks);
  const deler = q.split(" ");
  const treff: { y: Yrke; poeng: number }[] = [];
  for (const y of yrker) {
    const n = ord(y.navn);
    if (!deler.every((d) => n.includes(d))) continue;
    const poeng = n === q ? 0 : n.startsWith(q) ? 1 : n.split(/[\s,()/-]+/).some((w) => w.startsWith(deler[0]!)) ? 2 : 3;
    treff.push({ y, poeng });
  }
  return treff
    .sort((a, b) => a.poeng - b.poeng || a.y.navn.length - b.y.navn.length || a.y.navn.localeCompare(b.y.navn, "nb"))
    .slice(0, maks)
    .map((t) => t.y);
}

export function yrkeskodeRuter() {
  const r = new Hono();

  // ?sok=: yrkene som passer; ?kode=: yrket med koden (tom liste når koden ikke finnes).
  r.get("/ansatte/yrkeskoder", async (c) => {
    const q = z.object({ sok: z.string().max(100).optional(), kode: z.string().max(20).optional() }).parse(c.req.query());
    let k: Katalog;
    try {
      k = await yrkeskatalog();
    } catch {
      throw new ApiFeil(503, "Fikk ikke hentet yrkeskatalogen fra SSB. Skriv yrkeskoden (7 siffer) selv, eller prøv igjen senere.");
    }
    if (q.kode !== undefined) {
      const y = k.kart.get(q.kode.replace(/\s/g, ""));
      return c.json({ yrker: y ? [y] : [] });
    }
    return c.json({ yrker: sokYrker(k.yrker, q.sok ?? "") });
  });

  return r;
}
