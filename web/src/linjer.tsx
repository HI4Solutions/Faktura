// Fakturalinjer i skjemaene: én faktura og mange fakturaer på én gang.
import { useMemo } from "react";
import { tall } from "./felles";
import { kr, summer } from "./format";
import { produktValg, Sokefelt } from "./sokefelt";

export interface LinjeUtkast {
  produkt_id: string | null;
  beskrivelse: string;
  antall: string;
  enhet: string;
  enhetspris: string;
  mva_sats: string;
}

export const tomLinje = (): LinjeUtkast => ({ produkt_id: null, beskrivelse: "", antall: "1", enhet: "stk", enhetspris: "", mva_sats: "25" });
export const erTom = (l: LinjeUtkast) => !l.produkt_id && !l.beskrivelse.trim() && l.enhetspris === "";
export const fraProdukt = (p: any): Partial<LinjeUtkast> => ({
  produkt_id: p.id,
  beskrivelse: p.beskrivelse ? `${p.navn} – ${p.beskrivelse}` : p.navn,
  enhet: p.enhet,
  enhetspris: String(p.enhetspris).replace(".", ","),
  mva_sats: String(p.mva_sats),
});

// Legger produktet på linjen `hvor`, ellers på første tomme linje (eller en ny linje).
export function medProdukt(linjer: LinjeUtkast[], p: any, hvor: number | "ny", antall?: string): LinjeUtkast[] {
  const endring = { ...fraProdukt(p), ...(antall?.trim() ? { antall: antall.trim() } : {}) };
  const i = hvor === "ny" ? linjer.findIndex(erTom) : hvor;
  if (i < 0 || i >= linjer.length) return [...linjer, { ...tomLinje(), ...endring }];
  return linjer.map((l, j) => (j === i ? { ...l, ...endring } : l));
}

// Utfylte linjer som tall, slik API-et vil ha dem.
export const tilTallLinjer = (linjer: LinjeUtkast[], utenMva: boolean) =>
  linjer
    .filter((l) => l.beskrivelse.trim() && l.enhetspris !== "")
    .map((l) => ({
      produkt_id: l.produkt_id,
      beskrivelse: l.beskrivelse,
      antall: tall(l.antall),
      enhet: l.enhet,
      enhetspris: tall(l.enhetspris),
      mva_sats: utenMva ? 0 : Number(l.mva_sats),
    }));

// Fakturagebyret som egen linje i summen (API-et legger den til ved lagring).
export const gebyrLinjer = (gebyr: boolean, o: any) =>
  gebyr && o?.standard_gebyr > 0 ? [{ antall: 1, enhetspris: Number(o.standard_gebyr), mva_sats: o.mva_registrert ? 25 : 0 }] : [];

export function LinjeTabell({ linjer, endre, produkter, utenMva, nyttProdukt }: {
  linjer: LinjeUtkast[];
  endre: (linjer: LinjeUtkast[]) => void;
  produkter: any[];
  utenMva: boolean;
  nyttProdukt?: (linje: number, navn: string) => void;
}) {
  const settLinje = (i: number, endring: Partial<LinjeUtkast>) => endre(linjer.map((l, j) => (j === i ? { ...l, ...endring } : l)));
  const valg = useMemo(() => produktValg(produkter), [produkter]);
  const velgProdukt = (i: number, id: string | null) => {
    const p = id ? produkter.find((x) => x.id === id) : null;
    settLinje(i, p ? fraProdukt(p) : { produkt_id: null });
  };

  return (
    <table className="stabel">
      <thead>
        <tr>
          <th style={{ width: "20%" }}>Produkt</th>
          <th>Beskrivelse</th>
          <th style={{ width: 90 }}>Antall</th>
          <th style={{ width: 80 }}>Enhet</th>
          <th style={{ width: 120 }}>Pris eks. mva</th>
          {!utenMva && <th style={{ width: 90 }}>Mva</th>}
          <th className="hoyre" style={{ width: 110 }}>
            Beløp
          </th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {linjer.map((l, i) => {
          const b = l.enhetspris !== "" ? summer([{ antall: tall(l.antall), enhetspris: tall(l.enhetspris), mva_sats: 0 }]).eks : null;
          return (
            <tr key={i}>
              <td className="hel" data-label="Produkt">
                <Sokefelt
                  etikett={`Produkt på linje ${i + 1}`}
                  valg={valg}
                  verdi={l.produkt_id}
                  velg={(id) => velgProdukt(i, id)}
                  tom="Fritekst"
                  plassholder="Søk produkt"
                  ny={nyttProdukt ? { tekst: "+ Nytt produkt", handling: (navn) => nyttProdukt(i, navn) } : undefined}
                />
              </td>
              <td className="hel" data-label="Beskrivelse">
                <input value={l.beskrivelse} onChange={(e) => settLinje(i, { beskrivelse: e.target.value })} />
              </td>
              <td data-label="Antall">
                <input inputMode="decimal" value={l.antall} onChange={(e) => settLinje(i, { antall: e.target.value })} />
              </td>
              <td data-label="Enhet">
                <input value={l.enhet} onChange={(e) => settLinje(i, { enhet: e.target.value })} />
              </td>
              <td data-label="Pris eks. mva">
                <input inputMode="decimal" value={l.enhetspris} onChange={(e) => settLinje(i, { enhetspris: e.target.value })} />
              </td>
              {!utenMva && (
                <td data-label="Mva">
                  <select value={l.mva_sats} onChange={(e) => settLinje(i, { mva_sats: e.target.value })}>
                    <option value="25">25 %</option>
                    <option value="15">15 %</option>
                    <option value="12">12 %</option>
                    <option value="0">0 %</option>
                  </select>
                </td>
              )}
              <td className="tall sum">{b == null || Number.isNaN(b) ? "" : kr(b)}</td>
              <td className="fjern">
                <button type="button" className="lenke" aria-label="Fjern linje" onClick={() => endre(linjer.filter((_, j) => j !== i))}>
                  ✕
                </button>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
