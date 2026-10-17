// Regnskapsmaterialet i stengte organisasjoner slettes når oppbevaringstiden er ute
// (0124_slett_utlopt.sql). Hver morgen fra workeren (gjenta): først databasen for organisasjonene der
// oppbevares_til er passert, så filene i Cloud Storage for alle organisasjoner som er slettet. Holder
// bøttas oppbevaringsregel fortsatt på noen filer, prøves de igjen neste morgen.
import { config } from "./config.js";
import { alle, somSystem } from "./db.js";
import { lagring } from "./tjenester.js";

const logg = (severity: string, message: string, data: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ severity, message, ...data }));

// Filene til en organisasjon: fakturaene, bilagene og vedleggene i fakturabøtta, og logoen, vedleggene,
// utgiftene og a-meldingene i filbøtta.
const mapper = (org: string): [string | undefined, string][] => [
  [config.fakturaBucket, `${org}/`],
  [config.filerBucket, `${org}/`],
  [config.filerBucket, `amelding/${org}/`],
];

export async function slettUtloptMateriale(): Promise<{ organisasjoner: number; filer: number; venter: number; feil: number }> {
  let organisasjoner = 0;
  let filer = 0;
  let venter = 0;
  let feil = 0;

  const utlopt = await somSystem((db) => alle<{ id: string }>(db, "select id from faktura.utlopt_materiale(20) id"));
  for (const { id } of utlopt) {
    try {
      const r = await somSystem((db) => alle<{ slettet: unknown }>(db, "select faktura.slett_utlopt_materiale($1) as slettet", [id]));
      organisasjoner++;
      logg("INFO", "Regnskapsmaterialet er slettet etter oppbevaringstiden", { org_id: id, ...(r[0]?.slettet as object) });
    } catch (e) {
      feil++;
      logg("ERROR", "Sletting av regnskapsmateriale etter oppbevaringstiden feilet", { org_id: id, feil: (e as Error).message });
    }
  }

  // Uten bøttene (lokalt) er det ingen filer å slette.
  if (!config.fakturaBucket && !config.filerBucket) return { organisasjoner, filer, venter, feil };
  const slettede = await somSystem((db) => alle<{ id: string }>(db, "select id from faktura.filer_til_sletting(50) id"));
  for (const { id } of slettede) {
    try {
      let igjen = 0;
      for (const [bucket, prefiks] of mapper(id)) {
        if (!bucket) continue;
        const r = await lagring.slettMappe(bucket, prefiks);
        filer += r.slettet;
        igjen += r.venter;
      }
      venter += igjen;
      if (igjen === 0) await somSystem((db) => db.query("select faktura.filer_slettet($1)", [id]));
    } catch (e) {
      feil++;
      logg("ERROR", "Sletting av filene til en slettet organisasjon feilet", { org_id: id, feil: (e as Error).message });
    }
  }
  if (organisasjoner || filer || venter) logg("INFO", "Sletting etter oppbevaringstiden", { organisasjoner, filer, venter });
  return { organisasjoner, filer, venter, feil };
}
