// Rapportene for sjekklistene (sjekklister.ts) i rapportmodulen, under Personal: sjekklistene i
// perioden (når de ble gjort, av hvem og antall avvik, og de faste som ikke ble gjort), og avvikene
// med det som er gjort med dem.
import { alle, en } from "./db.js";
import { iDag } from "./regler.js";
import { FREKVENSNAVN, perioder, periodeSlutt, type Frekvens } from "./sjekklister.js";
import type { Rapportdef } from "./rapportmodul.js";

// Den siste dagen i perioden utfyllingen hører til (som periodeSlutt).
const SLUTT = `(case u.frekvens when 'ukentlig' then u.periode + 6
                                when 'maanedlig' then (u.periode + interval '1 month' - interval '1 day')::date
                                else u.periode end)`;

type Fast = { id: string; navn: string; frekvens: Frekvens; opprettet: string };

// Lørdag eller søndag.
const erHelg = (dato: string) => [0, 6].includes(new Date(`${dato}T00:00:00Z`).getUTCDay());

// De faste sjekklistene som ikke ble gjort: periodene i fra–til som er over (før i dag), etter at
// sjekklisten ble laget, uten noen utfylling (nøkkel «id|frekvens|periode»). Med stengt i helgene
// (helg = false) er lørdag og søndag ikke med for de daglige.
export function ikkeGjort(faste: Fast[], startet: Set<string>, fra: string, til: string, idag: string, helg = true) {
  const ut: { periode: string; sjekkliste: string; frekvens: Frekvens }[] = [];
  for (const s of faste)
    for (const p of perioder(s.frekvens, fra, til)) {
      const slutt = periodeSlutt(s.frekvens, p);
      if (slutt >= idag || slutt < s.opprettet || startet.has(`${s.id}|${s.frekvens}|${p}`)) continue;
      if (!helg && s.frekvens === "daglig" && erHelg(p)) continue;
      ut.push({ periode: p, sjekkliste: s.navn, frekvens: s.frekvens });
    }
  return ut;
}

type Utfylling = {
  sjekkliste_id: string;
  sjekkliste: string;
  frekvens: Frekvens;
  periode: string;
  status: "pagar" | "fullfort";
  gjort_av: string;
  fullfort: string | null;
  avvik: number;
};

export const sjekklisteRapporter: Rapportdef[] = [
  {
    id: "personal.sjekklister",
    modul: "personal",
    navn: "Sjekklister",
    beskrivelse: "Sjekklistene i perioden: når de ble gjort, av hvem og hvor mange avvik, og de faste (daglig, ukentlig, månedlig) som ikke ble gjort.",
    funksjon: "sjekklister",
    tilgang: "personal_les",
    parameter: "periode",
    hent: async (db, org, v) => {
      const utfyllinger = await alle<Utfylling>(
        db,
        `select u.sjekkliste_id, s.navn as sjekkliste, u.frekvens, to_char(u.periode, 'YYYY-MM-DD') as periode, u.status,
                coalesce(u.fullfort_navn, u.startet_navn) as gjort_av,
                to_char(u.fullfort at time zone 'Europe/Oslo', 'DD.MM.YYYY HH24:MI') as fullfort,
                (select count(*)::int from faktura.sjekkliste_svar x where x.org_id = u.org_id and x.utfylling_id = u.id and x.svar = 'avvik') as avvik
           from faktura.sjekkliste_utfyllinger u join faktura.sjekklister s on s.org_id = u.org_id and s.id = u.sjekkliste_id
          where u.org_id = $1 and u.periode <= $3 and ${SLUTT} >= $2
          order by u.periode, lower(s.navn), u.startet`,
        [org, v.fra, v.til],
      );
      // De faste som ikke ble fullført: periodene som er over, etter at sjekklisten ble laget.
      const faste = await alle<Fast>(
        db,
        `select s.id, s.navn, s.frekvens, to_char(s.opprettet at time zone 'Europe/Oslo', 'YYYY-MM-DD') as opprettet
           from faktura.sjekklister s where s.org_id = $1 and s.aktiv and s.frekvens <> 'ved_behov'`,
        [org],
      );
      const startet = new Set(utfyllinger.map((u) => `${u.sjekkliste_id}|${u.frekvens}|${u.periode}`));
      const idag = iDag();
      const { helg } = (await en<{ helg: boolean }>(db, "select coalesce((select l.helg from faktura.lonn_oppsett l where l.org_id = $1), true) as helg", [org]))!;
      const rader: Record<string, unknown>[] = utfyllinger.map((u) => ({
        periode: u.periode,
        sjekkliste: u.sjekkliste,
        frekvens: FREKVENSNAVN[u.frekvens],
        status: u.status === "fullfort" ? "Fullført" : periodeSlutt(u.frekvens, u.periode) < idag ? "Påbegynt, ikke fullført" : "Påbegynt",
        gjort_av: u.gjort_av,
        fullfort: u.fullfort ?? "",
        avvik: u.avvik,
      }));
      for (const m of ikkeGjort(faste, startet, v.fra, v.til, idag, helg))
        rader.push({ periode: m.periode, sjekkliste: m.sjekkliste, frekvens: FREKVENSNAVN[m.frekvens], status: "Ikke gjort", gjort_av: "", fullfort: "", avvik: 0 });
      rader.sort((a, b) => String(a.periode).localeCompare(String(b.periode)) || String(a.sjekkliste).localeCompare(String(b.sjekkliste), "nb"));
      const ikke = rader.filter((r) => r.status === "Ikke gjort").length;
      const perioden = `Perioden er dagen, uka (fra mandag) eller måneden.${helg ? "" : " Lørdag og søndag er ikke med for de daglige (stengt i helgene)."}`;
      return {
        kolonner: [
          { nokkel: "periode", navn: "Periode", type: "dato" },
          { nokkel: "sjekkliste", navn: "Sjekkliste" },
          { nokkel: "frekvens", navn: "Hvor ofte" },
          { nokkel: "status", navn: "Status" },
          { nokkel: "gjort_av", navn: "Gjort av" },
          { nokkel: "fullfort", navn: "Fullført" },
          { nokkel: "avvik", navn: "Avvik", type: "antall", sum: true },
        ],
        rader,
        merknad: ikke ? `${ikke === 1 ? "Én fast sjekkliste" : `${ikke} faste sjekklister`} ble ikke gjort i perioden. ${perioden}` : perioden,
      };
    },
  },
  {
    id: "personal.sjekkliste_avvik",
    modul: "personal",
    navn: "Avvik fra sjekklistene",
    beskrivelse: "Avvikene som ble meldt i perioden: punktet, hva avviket var, hvem som meldte det, og om det er lukket og hva som ble gjort.",
    funksjon: "sjekklister",
    tilgang: "personal_les",
    parameter: "periode",
    hent: async (db, org, v) => {
      const rader = await alle(
        db,
        `select to_char(x.besvart at time zone 'Europe/Oslo', 'YYYY-MM-DD') as meldt, s.navn as sjekkliste, x.punkt_tekst as punkt, x.kommentar,
                x.besvart_navn as meldt_av, case when x.avvik_lukket is null then 'Åpent' else 'Lukket' end as status,
                coalesce(x.tiltak, '') as tiltak, coalesce(x.avvik_lukket_navn, '') as lukket_av,
                to_char(x.avvik_lukket at time zone 'Europe/Oslo', 'YYYY-MM-DD') as lukket
           from faktura.sjekkliste_svar x
           join faktura.sjekkliste_utfyllinger u on u.org_id = x.org_id and u.id = x.utfylling_id
           join faktura.sjekklister s on s.org_id = u.org_id and s.id = u.sjekkliste_id
          where x.org_id = $1 and x.svar = 'avvik' and (x.besvart at time zone 'Europe/Oslo')::date between $2 and $3
          order by x.besvart, lower(s.navn)`,
        [org, v.fra, v.til],
      );
      const apne = rader.filter((r) => (r as { status: string }).status === "Åpent").length;
      return {
        kolonner: [
          { nokkel: "meldt", navn: "Meldt", type: "dato" },
          { nokkel: "sjekkliste", navn: "Sjekkliste" },
          { nokkel: "punkt", navn: "Punkt" },
          { nokkel: "kommentar", navn: "Avvik" },
          { nokkel: "meldt_av", navn: "Meldt av" },
          { nokkel: "status", navn: "Status" },
          { nokkel: "tiltak", navn: "Tiltak" },
          { nokkel: "lukket_av", navn: "Lukket av", pdf: false },
          { nokkel: "lukket", navn: "Lukket", type: "dato" },
        ],
        rader,
        merknad: rader.length ? `${rader.length} avvik, ${apne === 0 ? "alle lukket" : `${apne} ${apne === 1 ? "åpent" : "åpne"}`}.` : undefined,
      };
    },
  },
];
