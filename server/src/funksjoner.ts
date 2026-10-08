// Funksjoner per organisasjon (0041_funksjoner.sql): plattformadministratoren velger hvilke
// organisasjoner som har tilgang til hvilke funksjoner. Rutene under /org/:org som hører til en
// funksjon, avvises når organisasjonen ikke har den (mellomvaren under), og bakgrunnsjobbene
// hopper over organisasjonene (harFunksjon). Appen skjuler det som ikke er slått på.
import { Hono, type Context, type Next } from "hono";
import { z } from "zod";
import { alle, en, somBetrodd, somBruker, somSystem } from "./db.js";
import { ApiFeil } from "./feil.js";

// Rutene (stien etter /org/:org) og funksjonene de krever. En rute kan kreve flere (AI-forslag
// på en innbetaling krever både AI og bank).
const RUTER: [RegExp, string][] = [
  [/^\/ehf(\/|$)/, "ehf"],
  [/^\/kunder\/[^/]+\/ehf$/, "ehf"],
  [/^\/fakturaer\/[^/]+\/ehf$/, "ehf"],
  [/^\/(bank|banktransaksjoner)(\/|$)/, "bank"],
  [/^\/ai(\/|$)/, "ai"],
  [/^\/banktransaksjoner\/[^/]+\/ai$/, "ai"],
  [/^\/ai\/lonnsslipp$/, "ansatte"],
  [/^\/(gjentakelser|prisreguleringer)(\/|$)/, "gjentakende"],
  [/^\/produkter\/[^/]+\/indeksregulering$/, "gjentakende"],
  [/^\/fakturaer\/(flere|utsted-flere)$/, "flere"],
  [/^\/paaminnelser(\/|$)/, "paaminnelser"],
  [/^\/(rapporter|eksport)(\/|$)/, "rapporter"],
  [/^\/(kunder|produkter|ansatte)\/importer$/, "import"],
  [/^\/ansatte\/[^/]+\/arbeidsplan(\/|$)/, "vaktplan"],
  // Rollene (ansattgrupper) hører til de ansatte: om personen er ansatt, følger rollen. Beskjedene
  // går til rollene (0062_beskjeder.sql).
  [/^\/(ansatte|ansattgrupper|timer|lonn-oppsett|beskjeder)(\/|$)/, "ansatte"],
  [/^\/(vakter|vaktbytter|tavle|fravaer|feriebank|ferie)(\/|$)/, "vaktplan"],
  [/^\/ekstratimer(\.csv|\.pdf)?$/, "vaktplan"],
];

export const funksjonerFor = (sti: string) => [...new Set(RUTER.filter(([re]) => re.test(sti)).map(([, kode]) => kode))];
// Funksjonene som bygger på en annen (som i funksjoner.krever): den andre sjekkes først, så
// feilmeldingen sier hva som mangler.
const KREVER: Record<string, string> = { vaktplan: "ansatte" };
const medKrav = (koder: string[]) => [...new Set(koder.flatMap((k) => (KREVER[k] ? [KREVER[k]!, k] : [k])))];

// Funksjonene en organisasjon har, husket en liten stund (en endring i administrasjonen tømmer
// minnet her; andre instanser ser den innen et halvt minutt).
const MINNE_MS = 30_000;
const minne = new Map<string, { tid: number; koder: Set<string> }>();
export const glemFunksjoner = (org?: string) => (org ? minne.delete(org) : minne.clear());

async function funksjonerTil(brukerId: string, org: string) {
  const husket = minne.get(org);
  if (husket && Date.now() - husket.tid < MINNE_MS) return husket.koder;
  const koder = new Set((await somBruker(brukerId, (db) => en<{ k: string[] }>(db, "select faktura.org_funksjonsliste($1) as k", [org])))!.k);
  minne.set(org, { tid: Date.now(), koder });
  return koder;
}

const NAVN: Record<string, string> = {
  ehf: "EHF",
  bank: "Bank",
  ai: "AI",
  gjentakende: "Gjentakende fakturaer",
  flere: "Flere fakturaer",
  paaminnelser: "Påminnelser",
  rapporter: "Rapporter",
  import: "Import",
  google_disk: "Google Disk",
  ansatte: "Ansatte og timer",
  vaktplan: "Vaktplan og bemanning",
};
export const ikkePaa = (kode: string) => new ApiFeil(403, `${NAVN[kode] ?? kode} er ikke slått på for organisasjonen`);

// Mellomvare for /org/:org: avviser rutene til funksjoner organisasjonen ikke har.
export function krevFunksjoner() {
  return async (c: Context, next: Next) => {
    const org = c.req.param("org");
    const sti = c.req.path.replace(/^.*?\/org\/[^/]+/, "") || "/";
    const krever = medKrav(funksjonerFor(sti));
    if (krever.length && org && z.string().uuid().safeParse(org).success) {
      const har = await funksjonerTil(c.get("bruker").id, org);
      const mangler = krever.find((k) => !har.has(k));
      if (mangler) throw ikkePaa(mangler);
    }
    await next();
  };
}

// For bakgrunnsjobbene.
export async function harFunksjon(org: string, kode: string) {
  return (await somSystem((db) => en<{ k: boolean }>(db, "select faktura.har_funksjon($1, $2) as k", [org, kode])))!.k;
}

// --- Administrasjon (montert under /api/admin, som krever plattformadmin) -------------------

export function funksjonAdminRuter() {
  const r = new Hono();
  const id = (c: Context) => z.string().uuid().parse(c.req.param("id"));
  const kode = (c: Context) => z.string().regex(/^[a-z_]{2,30}$/, "Ukjent funksjon").parse(c.req.param("kode"));

  // Funksjonene, standarden for nye organisasjoner og hva hver organisasjon har.
  r.get("/funksjoner", async (c) => c.json((await somBetrodd(c.get("bruker").id, (db) => en(db, "select faktura.admin_funksjoner() as d")))!.d));

  // Standarden for nye organisasjoner.
  r.put("/funksjoner/:kode", async (c) => {
    const b = z.object({ standard: z.boolean() }).parse(await c.req.json().catch(() => ({})));
    await somBetrodd(c.get("bruker").id, (db) => db.query("select faktura.admin_sett_standard($1, $2)", [kode(c), b.standard]));
    return c.body(null, 204);
  });

  // Slå funksjoner av eller på for en organisasjon: { kode: aktiv, ... }.
  r.put("/organisasjoner/:id/funksjoner", async (c) => {
    const b = z.record(z.string().regex(/^[a-z_]{2,30}$/), z.boolean()).parse(await c.req.json().catch(() => ({})));
    if (!Object.keys(b).length) throw new ApiFeil(400, "Ingen funksjoner å endre");
    const aktive = await somBetrodd(c.get("bruker").id, async (db) => {
      for (const [k, aktiv] of Object.entries(b)) await db.query("select faktura.admin_sett_funksjon($1, $2, $3)", [id(c), k, aktiv]);
      return (await alle<{ kode: string }>(db, "select kode from faktura.org_funksjoner where org_id = $1 and aktiv order by kode", [id(c)])).map((x) => x.kode);
    });
    glemFunksjoner(id(c));
    return c.json({ aktive });
  });

  return r;
}
