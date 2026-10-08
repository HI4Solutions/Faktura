// Fakturaer, gjentakende fakturaer og innbetalinger er én side med ett punkt i menyen
// («Fakturaer»): fanene øverst (Alle, Utkast, Ubetalt, Betalt, Kreditert, Gjentakende og
// Innbetalinger) bytter mellom dem. Gjentakende og Innbetalinger har de samme adressene som før
// (/gjentakende og /innbetalinger), så lenker og varsler virker som før.
import { useNavigate } from "react-router-dom";
import { harFunksjon, useKonto } from "./konto";

const STIER = ["/fakturaer", "/gjentakende", "/innbetalinger", "/paaminnelser"];
// Siden hører til fakturadelen (menypunktet «Fakturaer» er valgt).
export const iFakturadelen = (sti: string) => STIER.some((s) => sti === s || sti.startsWith(`${s}/`));

const STATUSER: [string, string][] = [
  ["", "Alle"],
  ["utkast", "Utkast"],
  ["utstedt", "Ubetalt"],
  ["betalt", "Betalt"],
  ["kreditert", "Kreditert"],
];

// valgt: statusen i fakturalisten («» er alle), eller «gjentakende» eller «innbetalinger».
// velgStatus: i fakturalisten byttes statusen uten å laste siden på nytt.
export function Fakturafaner({ valgt, velgStatus }: { valgt: string; velgStatus?: (status: string) => void }) {
  const { org } = useKonto();
  const nav = useNavigate();
  const faner = [...STATUSER];
  if (harFunksjon(org, "gjentakende") || harFunksjon(org, "paaminnelser")) faner.push(["gjentakende", "Gjentakende"]);
  if (harFunksjon(org, "bank")) faner.push(["innbetalinger", "Innbetalinger"]);
  const velg = (v: string) => {
    if (v === "gjentakende" || v === "innbetalinger") nav(`/${v}`);
    else if (velgStatus) velgStatus(v);
    else nav(v ? `/fakturaer?status=${v}` : "/fakturaer");
  };
  return (
    <div className="faner fakturafaner" role="tablist" aria-label="Fakturaer">
      {faner.map(([v, t]) => (
        <button key={v} type="button" role="tab" aria-selected={valgt === v} className={valgt === v ? "valgt" : ""} onClick={() => velg(v)}>
          {t}
        </button>
      ))}
    </div>
  );
}
