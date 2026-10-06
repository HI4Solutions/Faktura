import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { hent, lastNed } from "../api";
import { Feil, Laster, useData, useHandling } from "../felles";
import { useKonto } from "../konto";
import { dato, kr } from "../format";

const naa = new Date();
const iAar = naa.getFullYear();
const naaTermin = Math.floor(naa.getMonth() / 2) + 1;
const maanedNavn = ["jan", "feb", "mar", "apr", "mai", "jun", "jul", "aug", "sep", "okt", "nov", "des"];
const terminNavn = ["jan–feb", "mar–apr", "mai–jun", "jul–aug", "sep–okt", "nov–des"];

export function Rapporter() {
  const [fane, settFane] = useState<"reskontro" | "mva" | "salg" | "eksport">("reskontro");
  return (
    <>
      <h1>Rapporter</h1>
      <div className="knapper" style={{ marginBottom: 16 }}>
        {(
          [
            ["reskontro", "Kundereskontro"],
            ["mva", "Mva"],
            ["salg", "Salg per måned"],
            ["eksport", "Eksport"],
          ] as const
        ).map(([v, t]) => (
          <button key={v} className={fane === v ? "primar" : ""} onClick={() => settFane(v)}>
            {t}
          </button>
        ))}
      </div>
      {fane === "reskontro" && <Reskontro />}
      {fane === "mva" && <Mva />}
      {fane === "salg" && <Salg />}
      {fane === "eksport" && <Eksport />}
    </>
  );
}

function Reskontro() {
  const { org } = useKonto();
  const nav = useNavigate();
  const { data, feil } = useData(() => hent<any[]>(`/org/${org!.id}/rapporter/reskontro`), [org?.id]);
  if (feil) return <Feil melding={feil} />;
  if (!data) return <Laster />;
  const sum = (k: string) => data.reduce((s, r) => s + (r[k] ?? 0), 0);
  return (
    <div className="kort tabell">
      <p className="dempet liten">Utestående per kunde, fordelt på dager etter forfall.</p>
      <table>
        <thead>
          <tr>
            <th>Kunde</th>
            <th className="hoyre">Ikke forfalt</th>
            <th className="hoyre">1–30</th>
            <th className="hoyre">31–60</th>
            <th className="hoyre">61–90</th>
            <th className="hoyre">Over 90</th>
            <th className="hoyre">Totalt</th>
          </tr>
        </thead>
        <tbody>
          {data.map((r) => (
            <tr key={r.kunde_id} className="klikkbar" onClick={() => nav(`/fakturaer`)}>
              <td>
                {r.navn} <span className="dempet liten">({r.antall})</span>
              </td>
              <td className="tall">{kr(r.ikke_forfalt)}</td>
              <td className="tall">{kr(r.d1_30)}</td>
              <td className="tall">{kr(r.d31_60)}</td>
              <td className="tall">{kr(r.d61_90)}</td>
              <td className="tall" style={{ color: r.over_90 ? "var(--fare)" : undefined }}>{kr(r.over_90)}</td>
              <td className="tall">
                <strong>{kr(r.utestaende)}</strong>
              </td>
            </tr>
          ))}
          {data.length === 0 ? (
            <tr>
              <td colSpan={7} className="dempet">
                Ingen utestående fakturaer.
              </td>
            </tr>
          ) : (
            <tr>
              <td>
                <strong>Sum</strong>
              </td>
              {["ikke_forfalt", "d1_30", "d31_60", "d61_90", "over_90", "utestaende"].map((k) => (
                <td key={k} className="tall">
                  <strong>{kr(sum(k))}</strong>
                </td>
              ))}
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function Mva() {
  const { org } = useKonto();
  const [aar, settAar] = useState(iAar);
  const [termin, settTermin] = useState(naaTermin);
  const { data, feil } = useData(() => hent(`/org/${org!.id}/rapporter/mva?aar=${aar}&termin=${termin}`), [org?.id, aar, termin]);
  return (
    <div className="kort">
      <div className="knapper" style={{ marginBottom: 12 }}>
        <select value={aar} onChange={(e) => settAar(Number(e.target.value))} style={{ width: "auto" }}>
          {[iAar - 2, iAar - 1, iAar, iAar + 1].map((a) => (
            <option key={a}>{a}</option>
          ))}
        </select>
        <select value={termin} onChange={(e) => settTermin(Number(e.target.value))} style={{ width: "auto" }}>
          {terminNavn.map((t, i) => (
            <option key={i} value={i + 1}>
              {i + 1}. termin ({t})
            </option>
          ))}
        </select>
      </div>
      <Feil melding={feil} />
      {!data ? (
        <Laster />
      ) : (
        <>
          <p className="dempet liten">
            Utgående mva for fakturaer og kreditnotaer datert {dato(data.fra)}–{dato(data.til)}. Inngående mva (kjøp) er ikke med.
          </p>
          <table>
            <thead>
              <tr>
                <th>Sats</th>
                <th className="hoyre">Grunnlag</th>
                <th className="hoyre">Mva</th>
                <th className="hoyre">Herav kreditnotaer (mva)</th>
              </tr>
            </thead>
            <tbody>
              {data.satser.map((s: any) => (
                <tr key={s.mva_sats}>
                  <td>{s.mva_sats} %</td>
                  <td className="tall">{kr(s.grunnlag)}</td>
                  <td className="tall">{kr(s.mva)}</td>
                  <td className="tall">{kr(s.kreditert_mva ?? 0)}</td>
                </tr>
              ))}
              {data.satser.length === 0 && (
                <tr>
                  <td colSpan={4} className="dempet">
                    Ingen fakturaer i terminen.
                  </td>
                </tr>
              )}
              {data.satser.length > 0 && (
                <tr>
                  <td>
                    <strong>Sum</strong>
                  </td>
                  <td className="tall">
                    <strong>{kr(data.satser.reduce((s: number, r: any) => s + r.grunnlag, 0))}</strong>
                  </td>
                  <td className="tall">
                    <strong>{kr(data.satser.reduce((s: number, r: any) => s + r.mva, 0))}</strong>
                  </td>
                  <td></td>
                </tr>
              )}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

function Salg() {
  const { org } = useKonto();
  const [aar, settAar] = useState(iAar);
  const { data, feil } = useData(() => hent<any[]>(`/org/${org!.id}/rapporter/salg?aar=${aar}`), [org?.id, aar]);
  return (
    <div className="kort tabell">
      <select value={aar} onChange={(e) => settAar(Number(e.target.value))} style={{ width: "auto", marginBottom: 12 }}>
        {[iAar - 2, iAar - 1, iAar].map((a) => (
          <option key={a}>{a}</option>
        ))}
      </select>
      <Feil melding={feil} />
      {!data ? (
        <Laster />
      ) : (
        <table>
          <thead>
            <tr>
              <th>Måned</th>
              <th className="hoyre">Fakturaer</th>
              <th className="hoyre">Kreditnotaer</th>
              <th className="hoyre">Netto eks. mva</th>
              <th className="hoyre">Netto inkl. mva</th>
            </tr>
          </thead>
          <tbody>
            {data.map((m, i) => (
              <tr key={m.maaned}>
                <td>{maanedNavn[i]}</td>
                <td className="tall">{m.antall_fakturaer}</td>
                <td className="tall">{m.antall_kreditnotaer}</td>
                <td className="tall">{kr(m.eks_mva)}</td>
                <td className="tall">{kr(m.inkl_mva)}</td>
              </tr>
            ))}
            <tr>
              <td>
                <strong>Sum</strong>
              </td>
              <td className="tall">{data.reduce((s, m) => s + m.antall_fakturaer, 0)}</td>
              <td className="tall">{data.reduce((s, m) => s + m.antall_kreditnotaer, 0)}</td>
              <td className="tall">
                <strong>{kr(data.reduce((s, m) => s + m.eks_mva, 0))}</strong>
              </td>
              <td className="tall">
                <strong>{kr(data.reduce((s, m) => s + m.inkl_mva, 0))}</strong>
              </td>
            </tr>
          </tbody>
        </table>
      )}
    </div>
  );
}

function Eksport() {
  const { org } = useKonto();
  const [fra, settFra] = useState(`${iAar}-01-01`);
  const [til, settTil] = useState(`${iAar}-12-31`);
  const h = useHandling();
  return (
    <div className="kort" style={{ maxWidth: 560 }}>
      <p className="dempet">CSV-filer som åpnes i Excel eller importeres i regnskapssystemet.</p>
      <div className="rad">
        <label>
          Fra
          <input type="date" value={fra} onChange={(e) => settFra(e.target.value)} />
        </label>
        <label>
          Til
          <input type="date" value={til} onChange={(e) => settTil(e.target.value)} />
        </label>
      </div>
      <div className="knapper">
        <button disabled={h.opptatt} onClick={() => h.kjor(() => lastNed(`/org/${org!.id}/eksport/fakturaer.csv?fra=${fra}&til=${til}`, `fakturaer-${fra}-${til}.csv`))}>
          Fakturaer (CSV)
        </button>
        <button disabled={h.opptatt} onClick={() => h.kjor(() => lastNed(`/org/${org!.id}/eksport/betalinger.csv?fra=${fra}&til=${til}`, `betalinger-${fra}-${til}.csv`))}>
          Betalinger (CSV)
        </button>
      </div>
      <Feil melding={h.feil} />
    </div>
  );
}
