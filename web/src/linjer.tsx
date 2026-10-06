// Fakturalinjer, rabatt og notat i skjemaene: én faktura, mange fakturaer på én gang og
// gjentakende fakturaer.
import { useEffect, useId, useMemo, useRef } from "react";
import { tall } from "./felles";
import { kr, linjebelop } from "./format";
import { produktValg, Sokefelt } from "./sokefelt";

export interface LinjeUtkast {
  produkt_id: string | null;
  beskrivelse: string;
  antall: string;
  enhet: string;
  enhetspris: string;
  mva_sats: string;
  rabatt: string; // tom: ingen rabatt
  rabatt_type: "prosent" | "kr";
}

export const tomLinje = (): LinjeUtkast => ({ produkt_id: null, beskrivelse: "", antall: "1", enhet: "stk", enhetspris: "", mva_sats: "25", rabatt: "", rabatt_type: "prosent" });
export const erTom = (l: LinjeUtkast) => !l.produkt_id && !l.beskrivelse.trim() && l.enhetspris === "";
const tallTekst = (n: number | null | undefined) => (n == null ? "" : String(n).replace(".", ","));
// Produkter uten fast pris får tom pris, som fylles inn på fakturaen.
export const fraProdukt = (p: any): Partial<LinjeUtkast> => ({
  produkt_id: p.id,
  beskrivelse: p.beskrivelse ? `${p.navn} – ${p.beskrivelse}` : p.navn,
  enhet: p.enhet,
  enhetspris: tallTekst(p.enhetspris),
  mva_sats: String(p.mva_sats),
});

// Linjer som er lagret (faktura, gjentakelse) tilbake til skjemaet.
export const tilUtkast = (l: any): LinjeUtkast => ({
  produkt_id: l.produkt_id ?? null,
  beskrivelse: l.beskrivelse,
  antall: tallTekst(l.antall ?? 1),
  enhet: l.enhet ?? "stk",
  enhetspris: tallTekst(l.enhetspris),
  mva_sats: String(l.mva_sats ?? 25),
  rabatt: tallTekst(l.rabatt_belop ?? l.rabatt_prosent),
  rabatt_type: l.rabatt_belop != null ? "kr" : "prosent",
});

// Legger produktet på linjen `hvor`, ellers på første tomme linje (eller en ny linje).
export function medProdukt(linjer: LinjeUtkast[], p: any, hvor: number | "ny", antall?: string): LinjeUtkast[] {
  const endring = { ...fraProdukt(p), ...(antall?.trim() ? { antall: antall.trim() } : {}) };
  const i = hvor === "ny" ? linjer.findIndex(erTom) : hvor;
  if (i < 0 || i >= linjer.length) return [...linjer, { ...tomLinje(), ...endring }];
  return linjer.map((l, j) => (j === i ? { ...l, ...endring } : l));
}

const rabattTall = (l: LinjeUtkast) => (l.rabatt.trim() ? tall(l.rabatt) : null);

// Utfylte linjer som tall, slik API-et vil ha dem.
export const tilTallLinjer = (linjer: LinjeUtkast[], utenMva: boolean) =>
  linjer
    .filter((l) => l.beskrivelse.trim() && l.enhetspris.trim() !== "")
    .map((l) => {
      const r = rabattTall(l);
      return {
        produkt_id: l.produkt_id,
        beskrivelse: l.beskrivelse,
        antall: tall(l.antall),
        enhet: l.enhet,
        enhetspris: tall(l.enhetspris),
        mva_sats: utenMva ? 0 : Number(l.mva_sats),
        rabatt_prosent: r && l.rabatt_type === "prosent" ? r : null,
        rabatt_belop: r && l.rabatt_type === "kr" ? r : null,
      };
    });

// Det som må rettes før linjene kan lagres (null: alt i orden).
export function linjefeil(linjer: LinjeUtkast[]): string | null {
  for (const [i, l] of linjer.entries()) {
    if (erTom(l)) continue;
    const navn = l.beskrivelse.trim() ? ` (${l.beskrivelse.trim().split("\n")[0]})` : "";
    if (!l.beskrivelse.trim()) return `Linje ${i + 1} mangler beskrivelse.`;
    if (l.enhetspris.trim() === "") return `Fyll inn pris på linje ${i + 1}${navn}.`;
    if (!Number.isFinite(tall(l.enhetspris))) return `Prisen på linje ${i + 1}${navn} er ikke et tall.`;
    if (!Number.isFinite(tall(l.antall)) || tall(l.antall) === 0) return `Antallet på linje ${i + 1}${navn} må være et tall (ikke 0).`;
    const r = rabattTall(l);
    if (r === null || r === 0) continue;
    if (!Number.isFinite(r) || r < 0) return `Rabatten på linje ${i + 1}${navn} må være et tall over 0.`;
    if (l.rabatt_type === "prosent" && r > 100) return `Rabatten på linje ${i + 1}${navn} kan ikke være mer enn 100 %.`;
    if (l.rabatt_type === "kr" && r > Math.round(tall(l.antall) * tall(l.enhetspris) * 100) / 100)
      return `Rabatten på linje ${i + 1}${navn} er større enn beløpet på linjen.`;
  }
  return null;
}

// Viser feilen i linjene og holder den oppdatert mens man retter (borte når alt er riktig).
export function useLinjefeil(linjer: LinjeUtkast[], settFeil: (f: string | null) => void) {
  const vist = useRef(false);
  useEffect(() => {
    if (!vist.current) return;
    const f = linjefeil(linjer);
    settFeil(f);
    if (!f) vist.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linjer]);
  // Kalles før lagring: true betyr at feilen er vist og lagringen skal stoppe.
  return () => {
    const f = linjefeil(linjer);
    if (f) {
      vist.current = true;
      settFeil(f);
    }
    return Boolean(f);
  };
}

// Fakturagebyret som egen linje i summen (API-et legger den til ved lagring).
export const gebyrLinjer = (gebyr: boolean, o: any) =>
  gebyr && o?.standard_gebyr > 0 ? [{ antall: 1, enhetspris: Number(o.standard_gebyr), mva_sats: o.mva_registrert ? 25 : 0 }] : [];

export function LinjeTabell({ linjer, endre, produkter, utenMva, nyttProdukt, visRabatt = false }: {
  linjer: LinjeUtkast[];
  endre: (linjer: LinjeUtkast[]) => void;
  produkter: any[];
  utenMva: boolean;
  nyttProdukt?: (linje: number, navn: string) => void;
  visRabatt?: boolean;
}) {
  const id = useId();
  const settLinje = (i: number, endring: Partial<LinjeUtkast>) => endre(linjer.map((l, j) => (j === i ? { ...l, ...endring } : l)));
  const valg = useMemo(() => produktValg(produkter), [produkter]);
  const variabel = (l: LinjeUtkast) => {
    const p = l.produkt_id ? produkter.find((x) => x.id === l.produkt_id) : null;
    return Boolean(p && p.enhetspris == null);
  };
  const velgProdukt = (i: number, pid: string | null) => {
    const p = pid ? produkter.find((x) => x.id === pid) : null;
    settLinje(i, p ? fraProdukt(p) : { produkt_id: null });
    // Uten fast pris: rett til prisfeltet.
    if (p && p.enhetspris == null) setTimeout(() => document.getElementById(`${id}-pris-${i}`)?.focus(), 50);
  };

  return (
    <table className="stabel">
      <thead>
        <tr>
          <th style={{ width: visRabatt ? "18%" : "20%" }}>Produkt</th>
          <th>Beskrivelse</th>
          <th style={{ width: visRabatt ? 74 : 90 }}>Antall</th>
          <th style={{ width: visRabatt ? 72 : 80 }}>Enhet</th>
          <th style={{ width: visRabatt ? 106 : 120 }}>Pris eks. mva</th>
          {visRabatt && <th style={{ width: 130 }}>Rabatt</th>}
          {!utenMva && <th style={{ width: 90 }}>Mva</th>}
          <th className="hoyre" style={{ width: visRabatt ? 100 : 110 }}>
            Beløp
          </th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {linjer.map((l, i) => {
          const r = rabattTall(l);
          const b =
            l.enhetspris.trim() !== ""
              ? linjebelop({
                  antall: tall(l.antall),
                  enhetspris: tall(l.enhetspris),
                  mva_sats: 0,
                  rabatt_prosent: r && l.rabatt_type === "prosent" ? r : null,
                  rabatt_belop: r && l.rabatt_type === "kr" ? r : null,
                })
              : null;
          const manglerPris = variabel(l) && l.enhetspris.trim() === "";
          return (
            <tr key={i}>
              <td className="hel" data-label="Produkt">
                <Sokefelt
                  etikett={`Produkt på linje ${i + 1}`}
                  valg={valg}
                  verdi={l.produkt_id}
                  velg={(pid) => velgProdukt(i, pid)}
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
                <input
                  id={`${id}-pris-${i}`}
                  inputMode="decimal"
                  value={l.enhetspris}
                  placeholder={variabel(l) ? "Fyll inn" : undefined}
                  aria-label={`Pris på linje ${i + 1}`}
                  aria-invalid={manglerPris || undefined}
                  title={variabel(l) ? "Produktet har ikke fast pris. Fyll inn prisen her." : undefined}
                  onChange={(e) => settLinje(i, { enhetspris: e.target.value })}
                />
              </td>
              {visRabatt && (
                <td data-label="Rabatt">
                  <div className="rabatt-felt">
                    <input
                      inputMode="decimal"
                      aria-label={`Rabatt på linje ${i + 1}`}
                      value={l.rabatt}
                      placeholder="0"
                      onChange={(e) => settLinje(i, { rabatt: e.target.value })}
                    />
                    <select aria-label={`Rabatt i prosent eller kroner, linje ${i + 1}`} value={l.rabatt_type} onChange={(e) => settLinje(i, { rabatt_type: e.target.value as LinjeUtkast["rabatt_type"] })}>
                      <option value="prosent">%</option>
                      <option value="kr">kr</option>
                    </select>
                  </div>
                </td>
              )}
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

// Rabatt vises som egen kolonne når den er slått på, eller når en linje har rabatt.
export const harRabatt = (linjer: LinjeUtkast[]) => linjer.some((l) => l.rabatt.trim() !== "");

// Rabattkolonnen på linjene slås på og av (av: rabattene fjernes).
export function RabattKnapp({ vis, veksle }: { vis: boolean; veksle: () => void }) {
  return (
    <button type="button" onClick={veksle} aria-pressed={vis}>
      {vis ? "Fjern rabatt" : "+ Rabatt"}
    </button>
  );
}

// Notat til kunden: står på fakturaen (PDF og EHF).
export function NotatFelt({ verdi, endre, etikett = "Notat på fakturaen" }: { verdi: string; endre: (v: string) => void; etikett?: string }) {
  return (
    <label>
      {etikett}
      <textarea rows={2} maxLength={1000} value={verdi} placeholder="F.eks. «Takk for handelen!» eller en beskjed til kunden" onChange={(e) => endre(e.target.value)} />
      <span className="felt-hjelp">Står på fakturaen kunden får.</span>
    </label>
  );
}
