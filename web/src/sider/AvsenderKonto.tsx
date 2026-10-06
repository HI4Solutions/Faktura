// Valg av avsender (firmanavn/innehaver) og kontonummer på fakturaer, gjentakelser og
// produkter. Vises bare når organisasjonen har innehaver eller flere kontonumre.
import { useEffect, useRef } from "react";
import { hent } from "../api";
import { useData } from "../felles";
import { useKonto } from "../konto";

export function AvsenderKonto({ org: o, verdi, endre, forProdukt = false }: {
  org: any;
  verdi: { konto_id?: string | null; avsender?: string | null; standardkonto?: boolean };
  endre: (v: { konto_id: string | null; avsender: string | null; standardkonto?: boolean }) => void;
  forProdukt?: boolean; // fast valg på produktet: tomt betyr «velges på fakturaen»
}) {
  const { org } = useKonto();
  const kontoer = useData(() => hent<any[]>(`/org/${org!.id}/kontoer`), [org?.id]);
  const harInnehaver = Boolean(o?.innehaver) && o?.type !== "privatperson";
  if (!o || (!harInnehaver && !kontoer.data?.length)) return null;
  const v = { konto_id: verdi.konto_id ?? null, avsender: verdi.avsender ?? null };
  // På produktet kan standardkontoen også være det faste valget.
  const kontoVerdi = forProdukt && verdi.standardkonto ? STANDARD : (v.konto_id ?? "");
  const velgKonto = (k: string) =>
    endre(forProdukt ? { ...v, konto_id: k && k !== STANDARD ? k : null, standardkonto: k === STANDARD } : { ...v, konto_id: k || null });
  const kto = (n: string) => n?.replace(/^(\d{4})(\d{2})(\d{5})$/, "$1.$2.$3");
  const ikkeFast = "Ikke fast (velges på fakturaen)";

  return (
    <div className="rad">
      {harInnehaver && (
        <label className="hel">
          {forProdukt ? "Fast avsender" : "Avsender"}
          <select value={v.avsender ?? ""} onChange={(e) => endre({ ...v, avsender: e.target.value || null })}>
            <option value="">{forProdukt ? ikkeFast : `Standard (${o.standard_avsender === "innehaver" ? o.innehaver : o.navn})`}</option>
            <option value="firma">{o.navn}</option>
            <option value="innehaver">{o.innehaver}</option>
          </select>
        </label>
      )}
      {(kontoer.data?.length ?? 0) > 0 && (
        <label className="hel">
          {forProdukt ? "Fast konto" : "Betales til konto"}
          <select value={kontoVerdi} onChange={(e) => velgKonto(e.target.value)}>
            <option value="">{forProdukt ? ikkeFast : `Standard (${kto(o.kontonr) ?? "ikke satt"})`}</option>
            {forProdukt && <option value={STANDARD}>Standardkontoen ({kto(o.kontonr) ?? "ikke satt"})</option>}
            {kontoer.data!.map((k) => (
              <option key={k.id} value={k.id}>
                {k.navn} ({kto(k.kontonr)})
              </option>
            ))}
          </select>
        </label>
      )}
    </div>
  );
}

const STANDARD = "standard";

// Fast avsender og konto fra produktene på linjene (det første produktet som har det).
// konto: id-en til en ekstra konto, «standard» for standardkontoen, null når ingen er fast.
export function fasteValg(linjer: { produkt_id: string | null }[], produkter: any[] | undefined) {
  const p = linjer.map((l) => (l.produkt_id ? produkter?.find((x) => x.id === l.produkt_id) : null)).filter(Boolean);
  const avsendere = p.map((x) => x.avsender).filter(Boolean) as string[];
  const kontoer = p.map((x) => (x.standardkonto ? STANDARD : x.konto_id)).filter(Boolean) as string[];
  return {
    avsender: avsendere[0] ?? null,
    konto: kontoer[0] ?? null,
    ulike: new Set(avsendere).size > 1 || new Set(kontoer).size > 1,
  };
}

// Kontoen på fakturaen for et fast kontovalg (standardkontoen er null på fakturaen).
export const fastKontoId = (konto: string) => (konto === STANDARD ? null : konto);

// Når et produkt med fast avsender eller konto legges på, velges det på fakturaen. Det som
// står fra før (et lagret utkast), endres ikke når skjemaet åpnes. Gir en advarsel når
// produktene har ulike faste valg.
export function useFasteValg(
  linjer: { produkt_id: string | null }[],
  produkter: any[] | undefined,
  klar: boolean,
  endre: (v: { avsender?: string; konto_id?: string | null }) => void,
): string | null {
  const ider = linjer.map((l) => l.produkt_id ?? "").join(",");
  const forrige = useRef<string[] | null>(null);
  useEffect(() => {
    if (!klar || !produkter) return;
    const naa = ider.split(",").filter(Boolean);
    if (forrige.current === null) {
      forrige.current = naa;
      return;
    }
    const nye = naa.filter((id) => !forrige.current!.includes(id));
    forrige.current = naa;
    const f = fasteValg(nye.map((produkt_id) => ({ produkt_id })), produkter);
    if (f.avsender || f.konto) endre({ ...(f.avsender ? { avsender: f.avsender } : {}), ...(f.konto ? { konto_id: fastKontoId(f.konto) } : {}) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ider, produkter, klar]);
  return fasteValg(linjer, produkter).ulike ? "Produktene på fakturaen har ulik fast avsender eller konto. Sjekk hva som er valgt." : null;
}
