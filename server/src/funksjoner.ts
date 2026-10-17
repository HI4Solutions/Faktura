// Funksjoner per organisasjon (0041_funksjoner.sql): plattformadministratoren velger hvilke
// organisasjoner som har tilgang til hvilke funksjoner. Rutene under /org/:org som hører til en
// funksjon, avvises når organisasjonen ikke har den (mellomvaren under), og bakgrunnsjobbene
// hopper over organisasjonene (harFunksjon). Appen skjuler det som ikke er slått på. Modulene
// (0110_moduler.sql) er kjernefunksjonene: fakturaene (faktura), personalet (ansatte), lønnen
// og regnskapet. Mellomvaren sier også hvilken modul forespørselen gjelder (modulKontekst i
// db.ts), så de egne rollene får tilgangen fra riktig modul (0111_tilgangsroller.sql).
import { Hono, type Context, type Next } from "hono";
import { z } from "zod";
import { alle, en, modulKontekst, somBetrodd, somBruker, somSystem } from "./db.js";
import { ApiFeil } from "./feil.js";

// Rutene (stien etter /org/:org) og funksjonene de krever. En rute kan kreve flere (AI-forslag
// på en innbetaling krever både AI og bank).
const RUTER: [RegExp, string][] = [
  // Fakturaene, kundene og produktene (og AI-fakturaen): modulen Faktura.
  [/^\/(fakturaer|kunder|produkter|vedlegg|startnummer)(\/|$)/, "faktura"],
  [/^\/ai\/faktura(\/|$)/, "faktura"],
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
  [/^\/(ansatte|ansattgrupper|timer|timebank|lonn-oppsett|beskjeder|yrkesskader)(\/|$)/, "ansatte"],
  [/^\/(vakter|vaktbytter|tavle|fravaer|egenmelding|feriebank|ferie|kolleger|turnus)(\/|$)/, "vaktplan"],
  [/^\/sjekklister(\/|$)/, "sjekklister"],
  [/^\/ekstratimer(\.csv|\.pdf)?$/, "vaktplan"],
  [/^\/lonn(\/|$)/, "lonn"],
  [/^\/skattekort(\/|$)/, "lonn"],
  [/^\/(amelding|amelding-virksomheter)(\/|$)/, "lonn"],
  [/^\/nav(\/|$)/, "lonn"],
  [/^\/regnskap(\/|$)/, "regnskap"],
];

export const funksjonerFor = (sti: string) => [...new Set(RUTER.filter(([re]) => re.test(sti)).map(([, kode]) => kode))];
// Funksjonene som bygger på en annen (som i funksjoner.krever): den andre sjekkes først, så
// feilmeldingen sier hva som mangler.
export const KREVER: Record<string, string> = {
  vaktplan: "ansatte",
  sjekklister: "ansatte",
  lonn: "ansatte",
  ehf: "faktura",
  gjentakende: "faktura",
  flere: "faktura",
  paaminnelser: "faktura",
  rapporter: "faktura",
  google_disk: "faktura",
};
const medKrav = (koder: string[]) => [...new Set(koder.flatMap((k) => (KREVER[k] ? [KREVER[k]!, k] : [k])))];

// Funksjonene en organisasjon har, husket en liten stund (en endring i administrasjonen tømmer
// minnet her; andre instanser ser den innen et halvt minutt).
const MINNE_MS = 30_000;
// kreverOrgnr: funksjonene organisasjonen mangler fordi den ikke har organisasjonsnummer
// (0119_uten_orgnr.sql), så feilmeldingen kan si det.
type Husket = { tid: number; koder: Set<string> | null; kreverOrgnr: Set<string> };
const minne = new Map<string, Husket>();
export const glemFunksjoner = (org?: string) => (org ? minne.delete(org) : minne.clear());

// koder er null når organisasjonen ikke finnes (er slettet).
async function funksjonerTil(brukerId: string, org: string): Promise<Husket> {
  const husket = minne.get(org);
  if (husket && Date.now() - husket.tid < MINNE_MS) return husket;
  const r = (await somBruker(brukerId, (db) =>
    en<{ k: string[] | null; o: string[] | null }>(
      db,
      `select faktura.org_funksjonsliste($1) as k,
              case when exists (select 1 from faktura.organisasjoner x where x.id = $1 and x.orgnr is null)
                   then array(select f.kode from faktura.funksjoner f where not f.uten_orgnr) end as o`,
      [org],
    ),
  ))!;
  const ny = { tid: Date.now(), koder: r.k ? new Set(r.k) : null, kreverOrgnr: new Set(r.o ?? []) };
  minne.set(org, ny);
  return ny;
}

const NAVN: Record<string, string> = {
  faktura: "Faktura",
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
  sjekklister: "Sjekklister",
  lonn: "Lønn",
  regnskap: "Regnskap",
};
export const ikkePaa = (kode: string) => new ApiFeil(403, `${NAVN[kode] ?? kode} er ikke slått på for organisasjonen`);
export const kreverOrgnr = (kode: string) =>
  new ApiFeil(403, `${NAVN[kode] ?? kode} krever organisasjonsnummer. Legg det inn under Innstillinger → Organisasjon.`);

// Modulen en rute gjelder, for tilgangen med de egne rollene (faktura.kan): lønnen (og reisene,
// skattekortene, a-meldingen og NAV) og regnskapet, med rapportene deres. Ellers ingen: da er
// det Personal som gir tilgangen til personaldataene.
export function modulFor(sti: string): "lonn" | "regnskap" | null {
  if (/^\/(lonn|skattekort|amelding|amelding-virksomheter|nav|reiser)(\/|$)/.test(sti) || /^\/rapportmodul\/lonn\./.test(sti)) return "lonn";
  if (/^\/regnskap(\/|$)/.test(sti) || /^\/rapportmodul\/regnskap\./.test(sti)) return "regnskap";
  return null;
}

// Mellomvare for /org/:org: avviser rutene til funksjoner organisasjonen ikke har, og sier
// hvilken modul forespørselen gjelder.
export function krevFunksjoner() {
  return async (c: Context, next: Next) => {
    const org = c.req.param("org");
    const sti = c.req.path.replace(/^.*?\/org\/[^/]+/, "") || "/";
    const krever = medKrav(funksjonerFor(sti));
    if (krever.length && org && z.string().uuid().safeParse(org).success) {
      // Finnes ikke organisasjonen, avgjør tilgangen at det ikke er noe å se (som før).
      const har = await funksjonerTil(c.get("bruker").id, org);
      const mangler = har.koder && krever.find((k) => !har.koder!.has(k));
      if (mangler) throw har.kreverOrgnr.has(mangler) ? kreverOrgnr(mangler) : ikkePaa(mangler);
    }
    const modul = modulFor(sti);
    if (modul) await modulKontekst.run(modul, next);
    else await next();
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
