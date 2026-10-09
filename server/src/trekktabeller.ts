// Trekktabellene (0065_lonn.sql): plattformadministratoren laster inn Skatteetatens tabeller for
// hvert år under Administrasjon → Drift (de kommer i desember). Uten dem regnes tabelltrekket med
// prosentsatsen på skattekortet. Den daglige jobben minner plattformadministratorene (e-post) på
// mandager fra 10. desember om tabellene for neste år, og i januar om årets, så lenge de mangler
// og noen har tabelltrekk (0075_lonn_aarsoversikt.sql).

import { en, somSystem } from "./db.js";
import { config } from "./config.js";
import { leggIKo } from "./tjenester.js";

const osloIDag = () => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Oslo" }).format(new Date());

// Året tabellene mangler for i dag (null: ingen påminnelse i dag).
export function trekktabellAar(iDag: string): number | null {
  const [aar, mnd, dag] = iDag.split("-").map(Number) as [number, number, number];
  const mandag = new Date(`${iDag}T12:00:00Z`).getUTCDay() === 1;
  if (!mandag) return null;
  if (mnd === 12 && dag >= 10) return aar + 1;
  if (mnd === 1) return aar;
  return null;
}

export async function varsleTrekktabeller(iDag = osloIDag()): Promise<number | null> {
  const aar = trekktabellAar(iDag);
  if (aar === null || !config.adminEposter.length) return null;
  const mangler = await somSystem(async (db) => (await en<{ m: boolean }>(db, "select faktura.trekktabeller_mangler($1) as m", [aar]))!.m);
  if (!mangler) return null;
  await leggIKo({
    type: "epost",
    til: config.adminEposter,
    emne: `Trekktabellene for ${aar} er ikke lastet inn`,
    tekst: [
      `Skatteetatens trekktabeller for ${aar} er ikke lastet inn i HI4 Faktura, og noen organisasjoner har ansatte med tabelltrekk.`,
      ``,
      `Last ned «Trekktabeller i tekstformat» for ${aar} fra skatteetaten.no (de kommer i desember), og last dem inn under`,
      `Administrasjon → Drift → Trekktabeller: ${config.appUrl}/admin?fane=drift`,
      ``,
      `Til de er lastet inn, regnes tabelltrekket i lønnskjøringer med utbetaling i ${aar} med prosentsatsen på skattekortet.`,
    ].join("\n"),
  });
  return aar;
}
