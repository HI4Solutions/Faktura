// Vedlegg på fakturaer: velges og lastes opp i skjemaet, vises og åpnes på fakturaen.
import { useRef, useState } from "react";
import { apneVedlegg, lastOppVedlegg, type Vedlegg } from "./api";
import { IkonBinders } from "./ikoner";

const MAKS = 10_000_000; // per fil og til sammen, som på serveren
const MAKS_ANTALL = 10;
// Typene EHF godtar. iPhone gjør bilder om til JPG når HEIC ikke står her.
const GODTATT = [
  ".pdf", ".png", ".jpg", ".jpeg", ".csv", ".xlsx", ".ods",
  "application/pdf", "image/png", "image/jpeg", "text/csv",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "application/vnd.oasis.opendocument.spreadsheet",
].join(",");

export const filstorrelse = (b: number) =>
  b < 1_000_000 ? `${Math.max(1, Math.round(b / 1000))} kB` : `${(b / 1_000_000).toFixed(1).replace(".", ",")} MB`;

// I skjemaet: filene lastes opp med en gang de velges, og følger med når utkastet lagres.
export function VedleggFelt({ orgId, vedlegg, endre, opptatt }: {
  orgId: string;
  vedlegg: Vedlegg[];
  endre: (v: Vedlegg[]) => void;
  opptatt: (laster: boolean) => void;
}) {
  const [laster, settLaster] = useState<{ nr: number; navn: string }[]>([]);
  const [feil, settFeil] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const liste = useRef(vedlegg);
  liste.current = vedlegg;
  const sum = vedlegg.reduce((s, v) => s + v.storrelse, 0);

  async function velg(filer: File[]) {
    if (input.current) input.current.value = "";
    if (!filer.length) return;
    const feil: string[] = [];
    let total = sum;
    let antall = vedlegg.length;
    const ok: File[] = [];
    for (const fil of filer) {
      if (fil.size > MAKS) feil.push(`«${fil.name}» er større enn 10 MB.`);
      else if (antall >= MAKS_ANTALL) {
        feil.push(`Høyst ${MAKS_ANTALL} vedlegg på en faktura.`);
        break;
      } else if (total + fil.size > MAKS) feil.push(`«${fil.name}» ble ikke lagt ved: vedleggene kan til sammen være høyst 10 MB.`);
      else {
        total += fil.size;
        antall++;
        ok.push(fil);
      }
    }
    settFeil(feil.length ? feil.join(" ") : null);
    if (!ok.length) return;
    const start = Date.now();
    settLaster(ok.map((f, i) => ({ nr: start + i, navn: f.name })));
    opptatt(true);
    for (const [i, fil] of ok.entries()) {
      try {
        liste.current = [...liste.current, await lastOppVedlegg(orgId, fil)];
        endre(liste.current);
      } catch (e) {
        feil.push(`«${fil.name}»: ${(e as Error).message}`);
        settFeil(feil.join(" "));
      }
      settLaster((l) => l.filter((x) => x.nr !== start + i));
    }
    opptatt(false);
  }

  return (
    <div className="vedlegg-felt">
      <div className="vedlegg-topp">
        <span className="etikett">Vedlegg</span>
        <button type="button" onClick={() => input.current?.click()} disabled={laster.length > 0 || vedlegg.length >= MAKS_ANTALL}>
          <IkonBinders storrelse={16} /> Legg ved fil
        </button>
      </div>
      {(vedlegg.length > 0 || laster.length > 0) && (
        <ul className="vedlegg-liste">
          {vedlegg.map((v) => (
            <li key={v.id}>
              <IkonBinders storrelse={16} />
              <span className="navn">{v.filnavn}</span>
              <span className="dempet liten">{filstorrelse(v.storrelse)}</span>
              <button type="button" className="lenke" aria-label={`Fjern ${v.filnavn}`} onClick={() => endre(vedlegg.filter((x) => x.id !== v.id))}>
                Fjern
              </button>
            </li>
          ))}
          {laster.map((x) => (
            <li key={x.nr} className="laster-opp">
              <span className="spinner" />
              <span className="navn">{x.navn}</span>
              <span className="dempet liten">Laster opp …</span>
            </li>
          ))}
        </ul>
      )}
      <input ref={input} type="file" multiple hidden accept={GODTATT} onChange={(e) => velg([...(e.target.files ?? [])])} />
      {feil ? (
        <span className="felt-feil" role="alert">{feil}</span>
      ) : (
        <span className="felt-hjelp">
          PDF, bilder, CSV eller regneark, til sammen høyst 10 MB. Sendes med fakturaen på e-post og EHF{vedlegg.length > 0 ? ` (${filstorrelse(sum)} nå)` : ""}.
        </span>
      )}
    </div>
  );
}

// På fakturaen: navnene åpner vedleggene.
export function VedleggListe({ orgId, fakturaId, vedlegg, feil }: { orgId: string; fakturaId: string; vedlegg: Vedlegg[]; feil: (melding: string) => void }) {
  if (!vedlegg?.length) return null;
  return (
    <div className="faktura-vedlegg">
      <div className="dempet liten">Vedlegg</div>
      <ul className="vedlegg-liste">
        {vedlegg.map((v) => (
          <li key={v.id}>
            <IkonBinders storrelse={16} />
            <button type="button" className="lenke navn" onClick={() => apneVedlegg(orgId, fakturaId, v).catch((e) => feil((e as Error).message))}>
              {v.filnavn}
            </button>
            <span className="dempet liten">{filstorrelse(v.storrelse)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
