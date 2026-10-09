// Månedsavslutningen i regnskapet (server/src/regnskapBilagRuter.ts): avskrivningene og
// periodiseringene som ikke er bokført, bokført måned for måned (et bilag per måned i serie A for
// avskrivningene og i serie P for periodiseringene). Står under Bilag, Anleggsmidler og
// Periodiseringer.
import { useState } from "react";
import { api, hent } from "../api";
import { Dialog, Feil, Laster, useData, useHandling } from "../felles";
import { useKonto } from "../konto";
import { kr } from "../format";
import { maaned } from "../lonn";

type Del = { sum: number; linjer: { nummer: number; navn: string; belop: number }[] };
type Forslag = { til: string; maaneder: { maaned: string; navn: string; avskrivninger: Del; periodiseringer: Del }[] };
export type Bilagsvar = { id: string; bilagsnummer: string; dato: string; tekst: string; sum?: number };

export const mndNavn = (m: string) => maaned(`${m}-01`);
const stor = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// visBokfort: vis «bokført til og med» når alt er bokført (når det finnes noe å bokføre).
export function Maanedsavslutning({ bokfort, visBokfort = false }: { bokfort: () => void; visBokfort?: boolean }) {
  const { org } = useKonto();
  const sti = `/org/${org!.id}/regnskap/maanedsavslutning`;
  const f = useData(() => hent<Forslag>(sti), [sti]);
  const [til, settTil] = useState<string | null>(null);
  const [vis, settVis] = useState(false);
  const [melding, settMelding] = useState<string | null>(null);
  const h = useHandling();

  if (f.feil) return <Feil melding={f.feil} />;
  if (!f.data) return null;
  const naa = f.data.til;
  const alle = f.data.maaneder;
  // Månedene som er over, og som ikke er bokført; denne måneden kan bokføres når som helst.
  const forfalt = alle.filter((m) => m.maaned < naa);
  const valgt = til ?? (forfalt.at(-1)?.maaned ?? naa);
  const med = alle.filter((m) => m.maaned <= valgt);
  const sum = (l: typeof alle) => l.reduce((s, m) => s + m.avskrivninger.sum + m.periodiseringer.sum, 0);
  const antall = med.reduce((n, m) => n + (m.avskrivninger.linjer.length ? 1 : 0) + (m.periodiseringer.linjer.length ? 1 : 0), 0);
  const forrige = (m: string) => {
    const [a, b] = m.split("-").map(Number) as [number, number];
    return b === 1 ? `${a - 1}-12` : `${a}-${String(b - 1).padStart(2, "0")}`;
  };
  const valg: string[] = alle.length ? [...new Set([...alle.map((m) => m.maaned), naa])].sort() : [];

  async function bokfor() {
    const r = await h.kjor(() => api<{ bilag: Bilagsvar[] }>("POST", sti, { til: valgt }));
    if (r) {
      settVis(false);
      settTil(null);
      settMelding(
        r.bilag.length
          ? `Månedsavslutningen er bokført: ${r.bilag.length === 1 ? `bilag ${r.bilag[0]!.bilagsnummer}` : `${r.bilag.length} bilag (${r.bilag.map((b) => b.bilagsnummer).join(", ")})`}.`
          : "Det var ingenting å bokføre.",
      );
      void f.last();
      bokfort();
    }
  }

  const ok = melding && (
    <div className="melding ok" role="status">
      {melding}
    </div>
  );
  if (!alle.length)
    return (
      <>
        {ok}
        {visBokfort && (
          <p className="liten regnskap-bokfort">
            <span className="merke merke-ok">Bokført</span> Avskrivningene og periodiseringene er bokført til og med {mndNavn(naa)}.
          </p>
        )}
      </>
    );

  return (
    <div className={`kort regnskap-avslutning${forfalt.length ? " forfalt" : ""}`}>
      {ok}
      {forfalt.length ? (
        <p style={{ marginTop: 0 }}>
          <strong>Månedsavslutning:</strong> avskrivningene og periodiseringene er ikke bokført{" "}
          {forfalt.length === 1 ? `for ${mndNavn(forfalt[0]!.maaned)}` : `fra ${mndNavn(forfalt[0]!.maaned)} til og med ${mndNavn(forfalt.at(-1)!.maaned)}`} ({kr(sum(forfalt))} kr).
        </p>
      ) : (
        <p className="liten" style={{ marginTop: 0 }}>
          <span className="merke merke-ok">Bokført</span> Avskrivningene og periodiseringene er bokført til og med {mndNavn(forrige(naa))}. {stor(mndNavn(naa))} kan bokføres når
          måneden er over (eller nå).
        </p>
      )}
      <div className="knapper">
        {valg.length > 1 && (
          <label className="liten">
            Til og med{" "}
            <select value={valgt} onChange={(e) => settTil(e.target.value)}>
              {valg.map((m) => (
                <option key={m} value={m}>
                  {mndNavn(m)}
                </option>
              ))}
            </select>
          </label>
        )}
        <button type="button" className={forfalt.length ? "primar" : undefined} onClick={() => settVis(true)}>
          {forfalt.length ? "Se og bokfør" : `Bokfør ${mndNavn(naa)}`}
        </button>
      </div>
      <Dialog apen={vis} lukk={() => settVis(false)} tittel={`Månedsavslutning til og med ${mndNavn(valgt)}`}>
        {!f.data ? (
          <Laster />
        ) : (
          <>
            <p className="dempet liten">
              Et bilag per måned og del, datert den siste dagen i måneden: avskrivningskostnaden mot balansekontoen for hvert anleggsmiddel (serie A), og månedens del
              av hver periodisering mellom resultatkontoen og balansekontoen (serie P).
            </p>
            <div className="tabell">
              <table>
                <tbody>
                  {med.map((m) => (
                    <tr key={m.maaned}>
                      <td>
                        <strong>{stor(m.navn)}</strong>
                        {m.avskrivninger.linjer.length > 0 && (
                          <div className="liten dempet">Avskrivninger: {m.avskrivninger.linjer.map((l) => `${l.nummer}. ${l.navn} ${kr(l.belop)}`).join(" · ")}</div>
                        )}
                        {m.periodiseringer.linjer.length > 0 && (
                          <div className="liten dempet">Periodiseringer: {m.periodiseringer.linjer.map((l) => `${l.nummer}. ${l.navn} ${kr(l.belop)}`).join(" · ")}</div>
                        )}
                      </td>
                      <td className="tall">{kr(m.avskrivninger.sum + m.periodiseringer.sum)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td>Sum</td>
                    <td className="tall">{kr(sum(med))}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
            <Feil melding={h.feil} />
            <div className="knapper">
              <button type="button" className="primar" disabled={h.opptatt || !antall} onClick={() => void bokfor()}>
                Bokfør {antall} bilag
              </button>
              <button type="button" onClick={() => settVis(false)}>
                Avbryt
              </button>
            </div>
          </>
        )}
      </Dialog>
    </div>
  );
}
