// Valg av avsender (firmanavn/innehaver) og kontonummer på fakturaer og gjentakelser.
// Vises bare når organisasjonen har innehaver eller flere kontonumre.
import { hent } from "../api";
import { useData } from "../felles";
import { useKonto } from "../konto";

export function AvsenderKonto({ org: o, verdi, endre }: { org: any; verdi: { konto_id?: string | null; avsender?: string | null }; endre: (v: { konto_id: string | null; avsender: string | null }) => void }) {
  const { org } = useKonto();
  const kontoer = useData(() => hent<any[]>(`/org/${org!.id}/kontoer`), [org?.id]);
  const harInnehaver = Boolean(o?.innehaver) && o?.type !== "privatperson";
  if (!o || (!harInnehaver && !kontoer.data?.length)) return null;
  const v = { konto_id: verdi.konto_id ?? null, avsender: verdi.avsender ?? null };
  const kto = (n: string) => n?.replace(/^(\d{4})(\d{2})(\d{5})$/, "$1.$2.$3");

  return (
    <div className="rad">
      {harInnehaver && (
        <label>
          Avsender
          <select value={v.avsender ?? ""} onChange={(e) => endre({ ...v, avsender: e.target.value || null })}>
            <option value="">Standard ({o.standard_avsender === "innehaver" ? o.innehaver : o.navn})</option>
            <option value="firma">{o.navn}</option>
            <option value="innehaver">{o.innehaver}</option>
          </select>
        </label>
      )}
      {(kontoer.data?.length ?? 0) > 0 && (
        <label>
          Betales til konto
          <select value={v.konto_id ?? ""} onChange={(e) => endre({ ...v, konto_id: e.target.value || null })}>
            <option value="">Standard ({kto(o.kontonr) ?? "ikke satt"})</option>
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
