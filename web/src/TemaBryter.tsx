// Bryter for utseendet i toppfeltet (og nederst i sidemenyen på PC): som systemet, lyst
// eller mørkt. Samme valg som under Innstillinger → App.
import { settTema, useTema, type Tema } from "./tema";
import { IkonMaane, IkonSkjerm, IkonSol } from "./ikoner";

const VALG = [
  ["system", "System", IkonSkjerm],
  ["lys", "Lys", IkonSol],
  ["mork", "Mørk", IkonMaane],
] as const satisfies readonly (readonly [Tema, string, unknown])[];

export function TemaBryter() {
  const tema = useTema();
  return (
    <div className="temabryter" role="radiogroup" aria-label="Utseende">
      {VALG.map(([v, navn, Ikon]) => (
        <button
          key={v}
          type="button"
          role="radio"
          aria-checked={tema === v}
          aria-label={navn}
          title={navn}
          className={tema === v ? "valgt" : undefined}
          onClick={() => settTema(v)}
        >
          <Ikon storrelse={17} />
        </button>
      ))}
    </div>
  );
}
