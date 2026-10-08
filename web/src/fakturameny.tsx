// Fakturaer, gjentakende fakturaer og innbetalinger er én del av appen, med ett punkt i menyen:
// lenkene øverst på hver av de tre sidene bytter mellom dem. Adressene er de samme som før
// (/gjentakende og /innbetalinger), så lenker og varsler virker som før.
import { NavLink } from "react-router-dom";
import { harFunksjon, useKonto } from "./konto";

const STIER = ["/fakturaer", "/gjentakende", "/innbetalinger", "/paaminnelser"];
// Siden hører til fakturadelen (menypunktet «Fakturaer» er valgt).
export const iFakturadelen = (sti: string) => STIER.some((s) => sti === s || sti.startsWith(`${s}/`));

export function Fakturameny() {
  const { org } = useKonto();
  const deler = (
    [
      ["/fakturaer", "Fakturaer", true],
      ["/gjentakende", "Gjentakende", harFunksjon(org, "gjentakende") || harFunksjon(org, "paaminnelser")],
      ["/innbetalinger", "Innbetalinger", harFunksjon(org, "bank")],
    ] as const
  ).filter(([, , vis]) => vis);
  if (deler.length < 2) return null;
  return (
    <nav className="seksjonsmeny" aria-label="Fakturaer">
      {deler.map(([til, navn]) => (
        <NavLink key={til} to={til} end>
          {navn}
        </NavLink>
      ))}
    </nav>
  );
}
