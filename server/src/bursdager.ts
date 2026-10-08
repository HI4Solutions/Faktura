// Bursdager (0045_bursdager.sql): har organisasjonen slått på bursdagsvarsler, får alle de andre
// i organisasjonen push-varsel, e-post eller begge deler om den som har bursdag, kl. 08 norsk tid
// (én gang per ansatt og dag). Den som har bursdag, får ikke. Kjøres av workeren hvert minutt.
import { alle, en, somSystem } from "./db.js";
import { forsteGang } from "./push.js";
import { leggIKo } from "./tjenester.js";

const KLOKKA = "08:00";
const osloKlokke = (d: Date) => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Oslo", hour: "2-digit", minute: "2-digit", hour12: false }).format(d);

type Bursdag = { org_id: string; ansatt_id: string; navn: string; kanal: "push" | "epost" | "begge"; dag: string };

export async function sendBursdager(naa = new Date()): Promise<{ varslet: number }> {
  if (osloKlokke(naa) < KLOKKA) return { varslet: 0 };
  const dagens = await somSystem((db) => alle<Bursdag>(db, "select org_id, ansatt_id, navn, kanal, dag::text from faktura.bursdager_i_dag()"));
  let varslet = 0;
  for (const b of dagens) {
    try {
      if (!(await forsteGang(`bursdag:${b.ansatt_id}:${b.dag}`))) continue;
      const { mottakere, org } = await somSystem(async (db) => ({
        mottakere: await alle<{ bruker_id: string | null; epost: string | null }>(db, "select bruker_id, epost from faktura.bursdag_mottakere($1, $2)", [b.org_id, b.ansatt_id]),
        org: (await en<{ navn: string }>(db, "select navn from faktura.organisasjoner where id = $1", [b.org_id]))!.navn,
      }));
      const tekst = `${b.navn} har bursdag i dag 🎂`;
      const brukere = mottakere.flatMap((m) => (m.bruker_id ? [m.bruker_id] : []));
      if (b.kanal !== "epost" && brukere.length)
        await leggIKo({
          type: "varsel",
          varsel: { hendelse: "bursdag", org_id: b.org_id, bruker_ider: brukere, tittel: "Bursdag i dag", tekst, url: "/", tag: `bursdag-${b.ansatt_id}` },
        });
      // Én e-post per mottaker, så ingen ser de andres adresser.
      if (b.kanal !== "push")
        for (const m of mottakere)
          if (m.epost)
            await leggIKo({
              type: "epost",
              til: [m.epost],
              fra_navn: org,
              emne: tekst,
              tekst: [
                `Hei,`,
                ``,
                `${b.navn} i ${org} har bursdag i dag.`,
                ``,
                `Du får denne e-posten fordi ${org} har slått på bursdagsvarsler i HI4 Faktura.`,
              ].join("\n"),
            });
      varslet++;
    } catch (e) {
      console.error(JSON.stringify({ severity: "ERROR", message: "Bursdagsvarsel feilet", org: b.org_id, ansatt: b.ansatt_id, feil: (e as Error).message }));
    }
  }
  return { varslet };
}
