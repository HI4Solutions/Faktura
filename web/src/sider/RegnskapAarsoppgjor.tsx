// Regnskap → Årsoppgjør (server/src/aarsoppgjor.ts): sjekklisten for året (det som gjenstår i
// månedsavslutningene), resultatregnskapet og balansen med fjoråret, årsoppgjøret (skattekostnaden,
// utbyttet og overføringen av årsresultatet til annen egenkapital, bilagserie Å) og periodelåsen.
import { useState } from "react";
import { Link } from "react-router-dom";
import { api, hent } from "../api";
import { Feil, Laster, useData, useHandling } from "../felles";
import { useKonto } from "../konto";
import { dato, iDag, kr } from "../format";
import { IkonHoyre, IkonVenstre } from "../ikoner";

type Linje = { nokkel: string; navn: string; belop: number; fjor: number; sum: boolean };
type Punkt = { nokkel: string; navn: string; ok: boolean; venter?: boolean; tekst: string; lenke: string };
type Status = {
  aar: number;
  over: boolean;
  laast_til: string | null;
  laast: boolean;
  punkter: Punkt[];
  resultat: Linje[];
  balanse: Linje[];
  oppgjor: {
    skatt: number;
    utbytte: number;
    resultat: number;
    aarsresultat: number;
    overforing: number;
    bilag: { id: string; bilagsnummer: string } | null;
    stemmer: boolean;
    trengs: boolean;
  };
};

// «12 000,50» → 12000.5 (tomt: 0; ugyldig: null).
const tallFra = (s: string) => {
  const t = s.replace(/[\s ]/g, "").replace(",", ".");
  if (!t) return 0;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null;
};
const tekstFra = (n: number) => (n ? String(n).replace(".", ",") : "");

function Tabell({ tittel, linjer, aar }: { tittel: string; linjer: Linje[]; aar: number }) {
  const vis = linjer.filter((l) => l.sum || l.belop || l.fjor);
  return (
    <div className="tabell">
      <table className="aars-tabell">
        <thead>
          <tr>
            <th>{tittel}</th>
            <th className="tall">{aar}</th>
            <th className="tall aars-fjor">{aar - 1}</th>
          </tr>
        </thead>
        <tbody>
          {vis.map((l) => (
            <tr key={l.nokkel} className={l.sum ? "sum" : undefined}>
              <td>{l.navn}</td>
              <td className="tall">{kr(l.belop)}</td>
              <td className="tall dempet aars-fjor">{kr(l.fjor)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Aarsoppgjor({ aar, velg }: { aar: string | null; velg: (aar: string) => void }) {
  const { org } = useKonto();
  const sti = `/org/${org!.id}/regnskap`;
  const d = useData(() => hent<Status>(aar ? `${sti}/aarsoppgjor?aar=${aar}` : `${sti}/aarsoppgjor`), [sti, aar]);
  const h = useHandling();
  const [skjema, settSkjema] = useState<{ skatt: string; utbytte: string } | null>(null);
  const [laasDato, settLaasDato] = useState("");
  const [melding, settMelding] = useState<string | null>(null);

  if (d.feil) return <Feil melding={d.feil} />;
  const s = d.data;
  if (!s) return <Laster />;
  const o = s.oppgjor;
  const v = skjema ?? { skatt: tekstFra(o.skatt), utbytte: tekstFra(o.utbytte) };
  const skatt = tallFra(v.skatt);
  const utbytte = tallFra(v.utbytte);
  // Disponeringer som er ført i andre bilag, trekkes fra overføringen (som på serveren).
  const disponert = Math.round((o.aarsresultat - o.utbytte - o.overforing) * 100) / 100;
  const aarsresultat = skatt === null ? null : Math.round((o.resultat - skatt) * 100) / 100;
  const overforing = aarsresultat === null || utbytte === null ? null : Math.round((aarsresultat - utbytte - disponert) * 100) / 100;
  const endret = skatt !== o.skatt || utbytte !== o.utbytte;
  const gjenstar = s.punkter.filter((p) => !p.ok && !p.venter).length;
  const iAar = Number(iDag().slice(0, 4));
  const kjor = async (fn: () => Promise<unknown>, tekst: (r: any) => string) => {
    settMelding(null);
    const r = await h.kjor(fn);
    if (r) {
      settMelding(tekst(r));
      settSkjema(null);
      void d.last();
    }
  };
  const merke = s.laast ? (
    <span className="merke merke-ok">Låst</span>
  ) : !s.over ? (
    <span className="merke merke-noytral">Året pågår</span>
  ) : o.bilag && o.stemmer ? (
    <span className="merke merke-ok">Bokført</span>
  ) : o.bilag ? (
    <span className="merke merke-advarsel">Endret etterpå</span>
  ) : (
    <span className="merke merke-advarsel">Ikke bokført</span>
  );

  return (
    <>
      <p className="dempet liten">
        Når året er over: se at månedene er ført, før skattekostnaden og utbyttet (aksjeselskap), og bokfør årsoppgjøret. Resten av årsresultatet overføres til annen
        egenkapital (bilagserie Å, 31. desember), så resultatkontoene begynner på null i det nye året. Lås året etterpå: det som føres med en dato i året, havner da i det
        nye året.
      </p>
      <div className={`kort aars-kort${s.over && !s.laast && (!o.bilag || !o.stemmer || gjenstar) ? " gjenstar" : ""}`}>
        <div className="maaned-status-hode">
          <h3>Årsoppgjør</h3>
          <div className="ukevelger">
            <button type="button" className="ikon" aria-label="Forrige år" title="Forrige år" onClick={() => velg(String(s.aar - 1))}>
              <IkonVenstre storrelse={20} />
            </button>
            <div className="uke-navn" aria-live="polite">
              <strong>{s.aar}</strong>
              <span>{!s.over ? "Året er ikke over" : gjenstar ? `${gjenstar} ${gjenstar === 1 ? "punkt gjenstår" : "punkter gjenstår"}` : "Månedene er ført"}</span>
            </div>
            <button type="button" className="ikon" aria-label="Neste år" title="Neste år" disabled={s.aar >= iAar} onClick={() => velg(String(s.aar + 1))}>
              <IkonHoyre storrelse={20} />
            </button>
          </div>
        </div>
        <div className="mva-sum">
          <span className="dempet">{(aarsresultat ?? o.aarsresultat) >= 0 ? "Årsresultat" : "Underskudd"}</span>
          <strong>{kr(Math.abs(aarsresultat ?? o.aarsresultat))} kr</strong>
          {merke}
        </div>
        {melding && (
          <div className="melding ok" role="status">
            {melding}
          </div>
        )}
        {s.punkter.length > 0 && (
          <ul className="maaned-punkter">
            {s.punkter.map((p) => (
              <li key={p.nokkel}>
                <span className={`merke ${p.ok ? "merke-ok" : p.venter ? "merke-noytral" : "merke-advarsel"}`}>{p.ok ? "Ført" : p.venter ? "Venter" : "Gjenstår"}</span>
                <span>
                  <Link to={p.lenke}>{p.navn}</Link>: {p.tekst}
                </span>
              </li>
            ))}
          </ul>
        )}
        <div className="aars-tabeller">
          <Tabell tittel="Resultatregnskap" linjer={s.resultat} aar={s.aar} />
          <Tabell tittel={`Balanse ${dato(`${s.aar}-12-31`)}`} linjer={s.balanse} aar={s.aar} />
        </div>
        <div className="mva-handlinger">
          <div>
            <strong>Skatt og disponering</strong>
            <p className="liten dempet">
              {o.bilag
                ? o.stemmer
                  ? `Bokført (${o.bilag.bilagsnummer}).`
                  : `Bokført (${o.bilag.bilagsnummer}), men året er endret etterpå: bokfør det på nytt.`
                : !s.over
                  ? "Bokføres når året er over."
                  : "Skattekostnaden (betalbar skatt) står i skattemeldingen (regnskapsføreren regner den ofte ut); utbyttet er det generalforsamlingen vedtar. La feltene stå tomme når de ikke gjelder."}
            </p>
            {s.over && !s.laast && (
              <>
                <div className="rad aars-felt">
                  <label>
                    Skattekostnad
                    <input inputMode="decimal" value={v.skatt} placeholder="0" onChange={(e) => settSkjema({ ...v, skatt: e.target.value })} />
                  </label>
                  <label>
                    Utbytte
                    <input inputMode="decimal" value={v.utbytte} placeholder="0" onChange={(e) => settSkjema({ ...v, utbytte: e.target.value })} />
                  </label>
                </div>
                <p className="liten">
                  {overforing === null
                    ? "Skriv beløpene i kroner."
                    : overforing >= 0
                      ? `${kr(overforing)} kr overføres til annen egenkapital.`
                      : `Underskuddet på ${kr(-overforing)} kr dekkes av annen egenkapital.`}
                </p>
                <div className="knapper">
                  {(o.trengs || endret) && (!o.stemmer || endret || !o.bilag) && (
                    <button
                      type="button"
                      className="primar"
                      disabled={h.opptatt || skatt === null || utbytte === null}
                      onClick={() =>
                        void kjor(
                          () => api<{ bilag: { bilagsnummer: string } | null }>("POST", `${sti}/aarsoppgjor/${s.aar}`, { skatt, utbytte }),
                          (r) => (r.bilag ? `Årsoppgjøret er bokført (${r.bilag.bilagsnummer}).` : "Årsoppgjøret stemte."),
                        )
                      }
                    >
                      {o.bilag ? "Bokfør på nytt" : "Bokfør årsoppgjøret"}
                    </button>
                  )}
                  {o.bilag && (
                    <button
                      type="button"
                      disabled={h.opptatt}
                      onClick={() => confirm("Angre årsoppgjøret? Bilaget reverseres.") && void kjor(() => api("DELETE", `${sti}/aarsoppgjor/${s.aar}`), () => "Årsoppgjøret er angret.")}
                    >
                      Angre
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
          <div>
            <strong>Periodelås</strong>
            <p className="liten dempet">
              {s.laast_til ? `Regnskapet er låst til og med ${dato(s.laast_til)}.` : "Regnskapet er ikke låst."} Bilag med en dato i en låst periode føres på den første åpne
              dagen; manuelle bilag dit avvises.
            </p>
            <div className="knapper">
              {s.over && !s.laast && (
                <button
                  type="button"
                  className={o.bilag && o.stemmer ? "primar" : undefined}
                  disabled={h.opptatt}
                  onClick={() =>
                    (o.bilag || confirm(`Årsoppgjøret for ${s.aar} er ikke bokført. Låse året likevel?`)) &&
                    void kjor(() => api("PUT", `${sti}/periodelas`, { til: `${s.aar}-12-31` }), () => `${s.aar} er låst.`)
                  }
                >
                  Lås {s.aar}
                </button>
              )}
              {s.laast && (
                <button
                  type="button"
                  disabled={h.opptatt}
                  onClick={() =>
                    confirm(`Låse opp ${s.aar}? Bilag kan da føres i året igjen.`) &&
                    void kjor(() => api("PUT", `${sti}/periodelas`, { til: `${s.aar - 1}-12-31` }), () => `${s.aar} er låst opp.`)
                  }
                >
                  Lås opp {s.aar}
                </button>
              )}
            </div>
            <div className="rad mva-levert">
              <label>
                Lås til og med
                <input type="date" value={laasDato} max={iDag()} onChange={(e) => settLaasDato(e.target.value)} />
              </label>
              <button
                type="button"
                disabled={h.opptatt || !laasDato}
                onClick={() => void kjor(() => api("PUT", `${sti}/periodelas`, { til: laasDato }), () => `Regnskapet er låst til og med ${dato(laasDato)}.`)}
              >
                Lås
              </button>
            </div>
            {s.laast_til && (
              <button
                type="button"
                className="lenke"
                disabled={h.opptatt}
                onClick={() => confirm("Låse opp hele regnskapet?") && void kjor(() => api("PUT", `${sti}/periodelas`, { til: null }), () => "Regnskapet er låst opp.")}
              >
                Lås opp alt
              </button>
            )}
          </div>
        </div>
        <Feil melding={h.feil} />
      </div>
    </>
  );
}
