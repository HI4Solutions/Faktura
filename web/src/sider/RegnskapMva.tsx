// Regnskap → Mva (server/src/mva.ts): mva-meldingen for terminen regnet fra bilagene, med linjene
// slik de føres i Altinn (koden, grunnlaget og satsen for utgående avgift, fradraget for inngående),
// summen å betale eller til gode, fristen, kontrollene, oppgjøret (bilagserie V) og om meldingen er
// levert. Terminene i året står under, og mva-justeringen for kapitalvarene i året
// (RegnskapMvaJustering.tsx).
import { useState } from "react";
import { Link } from "react-router-dom";
import { api, hent } from "../api";
import { Feil, Laster, Tom, useData, useHandling } from "../felles";
import { useKonto } from "../konto";
import { dato, iDag, kr } from "../format";
import { IkonHoyre, IkonRegnskap, IkonVenstre } from "../ikoner";
import { MvaJustering } from "./RegnskapMvaJustering";

// spesifikasjon: «justering» for justeringen for kapitalvarer.
type Linje = { kode: string; beskrivelse: string; grunnlag: number | null; sats: number | null; merverdiavgift: number; fradrag: boolean; spesifikasjon: "justering" | null };
type Termin = { aar: number; type: "tomaaneder" | "aar" | "maaned"; termin: number; fra: string; til: string; navn: string; frist: string };
type Status = {
  type: Termin["type"];
  termin: Termin;
  over: boolean;
  registrert: boolean;
  linjer: Linje[];
  sum: number;
  kontroller: string[];
  oppgjor: { bilag: { id: string; bilagsnummer: string } | null; stemmer: boolean; trengs: boolean };
  levert: { dato: string; belop: number; av: string | null } | null;
  endret: boolean;
  terminer: { termin: number; navn: string; frist: string; over: boolean; sum: number | null; levert: boolean | null }[];
  laast_til: string | null;
};

const prosent = (n: number) => `${String(n).replace(".", ",")} %`;
const belopTekst = (sum: number) => (sum >= 0 ? `${kr(sum)} kr å betale` : `${kr(-sum)} kr til gode`);

// Terminen før eller etter (året rundt).
function flytt(t: Termin, n: number): [number, number] {
  if (t.type === "aar") return [t.aar + n, 1];
  const antall = t.type === "tomaaneder" ? 6 : 12;
  const x = t.aar * antall + (t.termin - 1) + n;
  return [Math.floor(x / antall), (x % antall) + 1];
}

function Statusmerke({ s }: { s: Status }) {
  if (!s.over) return <span className="merke merke-noytral">Terminen pågår</span>;
  if (s.levert) return s.endret ? <span className="merke merke-advarsel">Endret etter levering</span> : <span className="merke merke-ok">Levert {dato(s.levert.dato)}</span>;
  return <span className="merke merke-advarsel">{iDag() > s.termin.frist ? "Fristen er ute" : "Ikke levert"}</span>;
}

export function Mva({ aar, termin, velg }: { aar: string | null; termin: string | null; velg: (aar: string, termin: string) => void }) {
  const { org } = useKonto();
  const sti = `/org/${org!.id}/regnskap/mva`;
  const d = useData(() => hent<Status>(aar ? `${sti}?aar=${aar}&termin=${termin ?? 1}` : sti), [sti, aar, termin]);
  const h = useHandling();
  const [levertDato, settLevertDato] = useState(iDag());
  const [melding, settMelding] = useState<string | null>(null);

  if (d.feil) return <Feil melding={d.feil} />;
  const s = d.data;
  if (!s) return <Laster />;
  const t = s.termin;
  const [na, nt] = flytt(t, 1);
  const [fa, ft] = flytt(t, -1);
  // Neste termin har begynt når dagen etter denne er i dag eller før.
  const nesteBegynt = new Date(Date.parse(`${t.til}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10) <= iDag();
  const sti2 = `${sti}/${t.aar}/${t.termin}`;
  const kjor = async (fn: () => Promise<unknown>, tekst?: (r: any) => string) => {
    settMelding(null);
    const r = await h.kjor(fn);
    if (r) {
      if (tekst) settMelding(tekst(r));
      void d.last();
    }
  };

  return (
    <>
      <p className="dempet liten">
        Mva-meldingen regnes fra bilagene i terminen: salget med utgående avgift, kjøpene med fradrag og tjenestene kjøpt fra utlandet, etter Skatteetatens standard
        mva-koder. Lever den i Altinn med linjene under. Når terminen er over, føres oppgjøret av seg selv med månedsavslutningen (bilagserie V, avgiftskontoene mot
        oppgjørskontoen), og betalingen til Skatteetaten (eller det som kommer tilbake) føres når den kommer i banken.
      </p>
      {!s.registrert && !s.linjer.length ? (
        <div className="kort">
          <Tom ikon={<IkonRegnskap storrelse={22} />} tittel="Ikke registrert for merverdiavgift">
            <p>
              Organisasjonen er ikke registrert for merverdiavgift, og det er ingen avgift i bilagene. Er den registrert, krysser du av under{" "}
              <Link to="/innstillinger?fane=organisasjon">Innstillinger → Organisasjon</Link>.
            </p>
          </Tom>
        </div>
      ) : (
        <div className={`kort mva-termin${s.over && (!s.levert || s.endret) ? " gjenstar" : ""}`}>
          <div className="maaned-status-hode">
            <h3>Mva-melding</h3>
            <div className="ukevelger">
              <button type="button" className="ikon" aria-label="Forrige termin" title="Forrige termin" onClick={() => velg(String(fa), String(ft))}>
                <IkonVenstre storrelse={20} />
              </button>
              <div className="uke-navn" aria-live="polite">
                <strong>{t.navn.replace(/^./, (c) => c.toUpperCase())}</strong>
                <span>Frist {dato(t.frist)}</span>
              </div>
              <button type="button" className="ikon" aria-label="Neste termin" title="Neste termin" disabled={!nesteBegynt} onClick={() => velg(String(na), String(nt))}>
                <IkonHoyre storrelse={20} />
              </button>
            </div>
          </div>
          <div className="mva-sum">
            <span className="dempet">{s.sum >= 0 ? "Å betale" : "Til gode"}</span>
            <strong>{kr(Math.abs(s.sum))} kr</strong>
            <Statusmerke s={s} />
          </div>
          {melding && (
            <div className="melding ok" role="status">
              {melding}
            </div>
          )}
          {s.linjer.length ? (
            <div className="tabell">
              <table className="mva-linjer">
                <thead>
                  <tr>
                    <th>Kode</th>
                    <th className="tall">Grunnlag</th>
                    <th className="tall mva-sats">Sats</th>
                    <th className="tall">
                      <span className="mva-lang">Merverdiavgift</span>
                      <span className="mva-kort">Mva</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {s.linjer.map((l, i) => (
                    <tr key={`${l.kode}-${l.fradrag}-${i}`}>
                      <td>
                        <strong>{l.kode}</strong>
                        <div className="liten dempet">
                          {l.beskrivelse}
                          {l.fradrag && !l.spesifikasjon && ["81", "83", "86", "88", "91"].includes(l.kode) ? " (fradrag)" : ""}
                        </div>
                      </td>
                      <td className="tall">
                        {l.grunnlag === null ? "–" : kr(l.grunnlag)}
                        {l.sats !== null && <div className="liten dempet mva-sats-under">{prosent(l.sats)}</div>}
                      </td>
                      <td className="tall mva-sats">{l.sats === null ? "–" : prosent(l.sats)}</td>
                      <td className="tall">{kr(l.merverdiavgift)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td>{s.sum >= 0 ? "Å betale" : "Til gode"}</td>
                    <td />
                    <td className="mva-sats" />
                    <td className="tall">{kr(s.sum)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          ) : (
            <p className="dempet liten">Ingen merverdiavgift i terminen; meldingen leveres likevel (med 0 kr) når organisasjonen er registrert.</p>
          )}
          {s.kontroller.length > 0 && (
            <div className="melding advarsel">
              <strong>Kontroller</strong>
              <ul>
                {s.kontroller.map((k) => (
                  <li key={k}>{k}</li>
                ))}
              </ul>
            </div>
          )}
          <div className="mva-handlinger">
            <div>
              <strong>Oppgjøret</strong>
              <p className="liten dempet">
                {s.oppgjor.bilag
                  ? s.oppgjor.stemmer
                    ? `Bokført (${s.oppgjor.bilag.bilagsnummer}): avgiftskontoene mot oppgjørskontoen.`
                    : `Bokført (${s.oppgjor.bilag.bilagsnummer}), men terminen er endret etterpå.`
                  : !s.oppgjor.trengs
                    ? "Ingen avgift å gjøre opp."
                    : s.over
                      ? "Ikke bokført. Månedsavslutningen gjør det av seg selv, eller bokfør det nå."
                      : "Bokføres når terminen er over."}
              </p>
              {s.over && (
                <div className="knapper">
                  {s.oppgjor.trengs && !s.oppgjor.stemmer && (
                    <button
                      type="button"
                      className="primar"
                      disabled={h.opptatt}
                      onClick={() =>
                        void kjor(
                          () => api<{ bilag: { bilagsnummer: string } | null }>("POST", `${sti2}/oppgjor`, {}),
                          (r) => (r.bilag ? `Oppgjøret er bokført (${r.bilag.bilagsnummer}).` : "Oppgjøret stemte."),
                        )
                      }
                    >
                      {s.oppgjor.bilag ? "Bokfør oppgjøret på nytt" : "Bokfør oppgjøret"}
                    </button>
                  )}
                  {s.oppgjor.bilag && (
                    <button
                      type="button"
                      disabled={h.opptatt}
                      onClick={() => confirm("Angre oppgjøret? Bilaget reverseres.") && void kjor(() => api("DELETE", `${sti2}/oppgjor`), () => "Oppgjøret er angret.")}
                    >
                      Angre oppgjøret
                    </button>
                  )}
                </div>
              )}
            </div>
            <div>
              <strong>Levert i Altinn</strong>
              {s.levert ? (
                <>
                  <p className="liten dempet">
                    Levert {dato(s.levert.dato)} med {belopTekst(s.levert.belop)}
                    {s.levert.av ? ` (merket av ${s.levert.av})` : ""}.
                    {s.endret ? ` Meldingen er endret etterpå (nå ${belopTekst(s.sum)}): lever en korrigert melding i Altinn, og merk den på nytt.` : ""}
                  </p>
                  {!s.endret && (!s.laast_til || s.laast_til < t.til) && (
                    <p className="liten dempet">
                      Lås terminen, så havner det som føres senere med en dato i terminen, i neste termin (meldingen endres ikke).{" "}
                      <button
                        type="button"
                        className="lenke"
                        disabled={h.opptatt}
                        onClick={() => void kjor(() => api("PUT", `/org/${org!.id}/regnskap/periodelas`, { til: t.til }), () => `Regnskapet er låst til og med ${dato(t.til)}.`)}
                      >
                        Lås til og med {dato(t.til)}
                      </button>
                    </p>
                  )}
                  <div className="knapper">
                    {s.endret && (
                      <button type="button" className="primar" disabled={h.opptatt} onClick={() => void kjor(() => api("PUT", `${sti2}/levert`, { dato: iDag() }), () => "Merket som levert.")}>
                        Korrigert melding levert i dag
                      </button>
                    )}
                    <button type="button" className="lenke" disabled={h.opptatt} onClick={() => void kjor(() => api("DELETE", `${sti2}/levert`))}>
                      Angre
                    </button>
                  </div>
                </>
              ) : s.over ? (
                <>
                  <p className="liten dempet">Merk terminen når meldingen er levert; endres den etterpå, sier appen fra.</p>
                  <div className="rad mva-levert">
                    <label>
                      Levert
                      <input type="date" value={levertDato} max={iDag()} min={t.til} onChange={(e) => settLevertDato(e.target.value)} />
                    </label>
                    <button type="button" disabled={h.opptatt} onClick={() => void kjor(() => api("PUT", `${sti2}/levert`, { dato: levertDato }), () => "Merket som levert.")}>
                      Merk som levert
                    </button>
                  </div>
                </>
              ) : (
                <p className="liten dempet">Meldingen leveres når terminen er over, senest {dato(t.frist)}.</p>
              )}
            </div>
          </div>
          <Feil melding={h.feil} />
        </div>
      )}
      {s.terminer.length > 1 && (
        <div className="kort liste mva-terminer">
          {s.terminer.map((x) => (
            <button key={x.termin} type="button" className={`liste-rad${x.termin === t.termin ? " valgt" : ""}`} onClick={() => velg(String(t.aar), String(x.termin))}>
              <span className="linje">
                <span className="tittel">{x.navn.replace(` ${t.aar}`, "").replace(/^./, (c) => c.toUpperCase())}</span>
                <span className="belop">{x.sum === null ? "" : belopTekst(x.sum)}</span>
              </span>
              <span className="linje">
                <span className="under">Frist {dato(x.frist)}</span>
                {!x.over ? (
                  <span className="merke merke-noytral">Pågår</span>
                ) : x.levert ? (
                  <span className="merke merke-ok">Levert</span>
                ) : (
                  <span className="merke merke-advarsel">Ikke levert</span>
                )}
              </span>
            </button>
          ))}
        </div>
      )}
      <MvaJustering key={t.aar} aar={t.aar} endret={() => void d.last()} />
    </>
  );
}
