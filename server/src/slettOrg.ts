// Sletting av organisasjoner (0046_slett_organisasjon.sql): eieren eller plattformadministratoren
// sletter en organisasjon, alltid med en grunn. Uten utstedte fakturaer slettes alt; med utstedte
// fakturaer stenges organisasjonen, og fakturaene oppbevares så lenge bokføringsloven krever.
// Sletter eieren, får plattformadministratorene e-post med grunnen; sletter
// plattformadministratoren, får eierne det.
import { Hono, type Context } from "hono";
import { z } from "zod";
import { config } from "./config.js";
import { alle, en, somBetrodd, type Db } from "./db.js";
import { ApiFeil } from "./feil.js";
import { glemFunksjoner } from "./funksjoner.js";
import { dato } from "./regler.js";
import { leggIKo } from "./tjenester.js";

export type Sletting = {
  id: string;
  navn: string;
  orgnr: string | null;
  grunn: string;
  antall_fakturaer: number;
  oppbevares_til: string | null;
  slettet_av_navn: string | null;
  slettet_av_epost: string | null;
};

export const grunnSkjema = z.object({
  grunn: z
    .string({ error: "Skriv hvorfor organisasjonen slettes" })
    .trim()
    .min(3, "Skriv hvorfor organisasjonen slettes")
    .max(1000, "Grunnen kan ha høyst 1000 tegn"),
});

export const slettOrganisasjon = (db: Db, org: string, grunn: string) =>
  en<Sletting>(
    db,
    `select id, navn, orgnr, grunn, antall_fakturaer, oppbevares_til::text, slettet_av_navn, slettet_av_epost
       from faktura.slett_organisasjon($1, $2)`,
    [org, grunn],
  ).then((s) => {
    glemFunksjoner(org);
    return s!;
  });

const utfall = (s: Sletting) =>
  s.oppbevares_til
    ? `Organisasjonen er stengt: ingen har tilgang lenger, og ingenting sendes. ${s.antall_fakturaer} ${s.antall_fakturaer === 1 ? "utstedt faktura" : "utstedte fakturaer"} oppbevares til ${dato(s.oppbevares_til)} (bokføringsloven § 13).`
    : "Alt er slettet.";
const hvem = (s: Sletting) => [s.navn, s.orgnr ? `(org.nr. ${s.orgnr})` : null].filter(Boolean).join(" ");

// Eieren har slettet organisasjonen: plattformadministratorene får vite hvorfor.
export async function meldSlettingTilAdmin(s: Sletting) {
  if (!config.adminEposter.length) return;
  await leggIKo({
    type: "epost",
    til: config.adminEposter,
    emne: `Organisasjon slettet: ${s.navn}`,
    tekst: [`${hvem(s)} er slettet av eieren, ${s.slettet_av_navn ?? ""} (${s.slettet_av_epost ?? ""}).`, ``, `Grunn: ${s.grunn}`, ``, utfall(s)].join("\n"),
  }).catch((e) => console.warn("Kunne ikke varsle administratorer om slettingen", e));
}

// --- Administrasjon (montert under /api/admin, som krever plattformadmin) -------------------

export function slettAdminRuter() {
  const r = new Hono();
  const id = (c: Context) => z.string().uuid().parse(c.req.param("id"));

  // Slett eller steng en organisasjon. Eierne får e-post med grunnen.
  r.post("/organisasjoner/:id/slett", async (c) => {
    const { grunn } = grunnSkjema.parse(await c.req.json().catch(() => ({})));
    const { s, eiere } = await somBetrodd(c.get("bruker").id, async (db) => {
      const d = (await en<{ d: { medlemmer?: { epost: string; rolle: string }[] } | null }>(db, "select faktura.admin_organisasjon($1) as d", [id(c)]))?.d;
      if (!d) throw new ApiFeil(404, "Fant ikke organisasjonen");
      const eiere = (d.medlemmer ?? []).filter((m) => m.rolle === "eier").map((m) => m.epost);
      return { s: await slettOrganisasjon(db, id(c), grunn), eiere };
    });
    if (eiere.length)
      await leggIKo({
        type: "epost",
        til: eiere,
        emne: `${s.navn} er slettet fra HI4 Faktura`,
        tekst: [`Hei,`, ``, `${hvem(s)} er slettet fra HI4 Faktura.`, ``, `Grunn: ${s.grunn}`, ``, utfall(s), ``, `Ta kontakt med HI4 Faktura hvis du har spørsmål.`].join("\n"),
      }).catch((e) => console.warn("Kunne ikke varsle eierne om slettingen", e));
    return c.json(s);
  });

  // Organisasjonene som er slettet eller stengt, med grunnen.
  r.get("/slettede", async (c) =>
    c.json(
      await somBetrodd(c.get("bruker").id, (db) =>
        alle(
          db,
          `select id, navn, orgnr, type, slettet_at, slettet_av_navn, slettet_av_epost, av_plattformen, grunn, antall_fakturaer, oppbevares_til::text
             from faktura.slettede_organisasjoner order by slettet_at desc`,
        ),
      ),
    ),
  );

  return r;
}
