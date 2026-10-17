// Regnskap → Årsoppgjør (server/src/aarsoppgjor.ts): sjekklisten for året (det som gjenstår i
// månedsavslutningene), resultatregnskapet og balansen med fjoråret, skatteberegningen (forslaget til
// betalbar og utsatt skatt, server/src/skatteberegning.ts), årsoppgjøret (betalbar skatt, endringen i
// utsatt skatt, utbyttet og overføringen av årsresultatet til annen egenkapital, bilagserie Å),
// periodelåsen, SAF-T og lenkene til grunnlaget for skattemeldingen (næringsspesifikasjonen og
// saldoskjemaet).
import { useState } from "react";
import { Link } from "react-router-dom";
import { api, hent, lastNed } from "../api";
import { Feil, Laster, useData, useHandling } from "../felles";
import { useKonto } from "../konto";
import { dato, iDag, kr } from "../format";
import { IkonHoyre, IkonVenstre } from "../ikoner";

type Linje = { nokkel: string; navn: string; belop: number; fjor: number; sum: boolean };
type Skattelinje = { nokkel: string; navn: string; belop: number; fast: boolean };
type Forskjell = { nokkel: string; navn: string; ib: number; ub: number; fast: boolean };
type Skatteinndata = {
  permanente_andre?: number;
  permanente_tekst?: string;
  midlertidige_andre_ib?: number;
  midlertidige_andre_ub?: number;
  midlertidige_tekst?: string;
  underskudd_ib?: number;
  skattefordel?: boolean;
};
type Skatteberegning = {
  aar: number;
  sats: number;
  resultat_for_skatt: number;
  permanente: Skattelinje[];
  sum_permanente: number;
  midlertidige: Forskjell[];
  midlertidige_ib: number;
  midlertidige_ub: number;
  endring_midlertidige: number;
  grunnlag: number;
  underskudd_ib: number;
  underskudd_kilde: "lagt_inn" | "aaret_for" | "forste_aar";
  underskudd_brukt: number;
  underskudd_ub: number;
  inntekt: number;
  betalbar: number;
  grunnlag_utsatt: number;
  skattefordel: boolean;
  utsatt_ub: number;
  utsatt_ib: number;
  endring_utsatt: number;
  skattekostnad: number;
  inndata: Skatteinndata;
};
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
    utsatt_skatt: number | null;
    utsatt_for: { skatt: number; fordel: number };
    endring_utsatt: number;
    resultat: number;
    aarsresultat: number;
    overforing: number;
    bilag: { id: string; bilagsnummer: string } | null;
    stemmer: boolean;
    trengs: boolean;
  };
  skatteberegning: Skatteberegning | null;
};

// «12 000,50» → 12000.5 (tomt: 0; ugyldig: null).
const tallFra = (s: string) => {
  const t = s.replace(/[\s ]/g, "").replace(",", ".");
  if (!t) return 0;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null;
};
const tekstFra = (n: number) => (n ? String(n).replace(".", ",") : "");
// Med fortegn (minus eller tankestrek), og tomt er null.
const tallMedFortegn = (s: string) => {
  const t = s.replace(/[\s ]/g, "").replace(/^[−–]/, "-").replace(",", ".");
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : undefined;
};
const tekstMedFortegn = (n: number | null | undefined) => (n == null ? "" : String(n).replace(".", ","));
// Beløpet som trekkes fra (uten «−0,00»).
const minus = (n: number) => kr(n ? -n : 0);
// Endringen i utsatt skatt når den utsatte skatten 31.12 er ub (som på serveren).
const endringUtsatt = (ub: number | null, f: { skatt: number; fordel: number }) =>
  ub === null ? 0 : Math.round((Math.max(ub, 0) - f.skatt - (Math.max(-ub, 0) - f.fordel)) * 100) / 100;

// Skatteberegningen: forslaget til betalbar og utsatt skatt, med det brukeren legger inn.
function SkatteberegningKort({
  sb,
  redigerbar,
  apen,
  vis,
  lagre,
  bruk,
}: {
  sb: Skatteberegning;
  redigerbar: boolean;
  apen: boolean;
  vis: (apen: boolean) => void;
  lagre: (inn: Partial<Record<keyof Skatteinndata, number | string | boolean | null>>) => void;
  bruk: (() => void) | null;
}) {
  const i = sb.inndata;
  const start = {
    permanente_andre: tekstMedFortegn(i.permanente_andre),
    permanente_tekst: i.permanente_tekst ?? "",
    midlertidige_andre_ib: tekstMedFortegn(i.midlertidige_andre_ib),
    midlertidige_andre_ub: tekstMedFortegn(i.midlertidige_andre_ub),
    midlertidige_tekst: i.midlertidige_tekst ?? "",
    underskudd_ib: tekstMedFortegn(i.underskudd_ib),
  };
  const [f, settF] = useState(start);
  const tall = {
    permanente_andre: tallMedFortegn(f.permanente_andre),
    midlertidige_andre_ib: tallMedFortegn(f.midlertidige_andre_ib),
    midlertidige_andre_ub: tallMedFortegn(f.midlertidige_andre_ub),
    underskudd_ib: tallMedFortegn(f.underskudd_ib),
  };
  const ugyldig = Object.values(tall).some((x) => x === undefined) || (tall.underskudd_ib ?? 0) < 0;
  const endret = (Object.keys(start) as (keyof typeof start)[]).some((k) => f[k].trim() !== start[k].trim());
  const andreP = sb.permanente.find((l) => !l.fast)!;
  const andreM = sb.midlertidige.find((x) => !x.fast)!;
  const felt = (k: keyof typeof f, tekst: string, bredt = false) => (
    <input
      className={bredt ? undefined : "fjor-felt"}
      inputMode={bredt ? undefined : "decimal"}
      aria-label={tekst}
      placeholder={bredt ? tekst : "0"}
      value={f[k]}
      onChange={(e) => settF({ ...f, [k]: e.target.value })}
    />
  );
  const kilde =
    sb.underskudd_kilde === "lagt_inn" ? "lagt inn" : sb.underskudd_kilde === "aaret_for" ? `regnet fra ${sb.aar - 1}` : `første år: legg inn underskuddet fra skattemeldingen for ${sb.aar - 1}`;
  return (
    <details className="aars-skatt" open={apen} onToggle={(e) => vis(e.currentTarget.open)}>
      <summary>
        <strong>Skatteberegning (forslag)</strong>
        <span className="dempet">
          {" "}
          Betalbar skatt {kr(sb.betalbar)} kr · {sb.utsatt_ub < 0 ? "utsatt skattefordel" : "utsatt skatt"} {kr(Math.abs(sb.utsatt_ub))} kr · skattekostnad{" "}
          {kr(sb.skattekostnad)} kr
        </span>
      </summary>
      <p className="liten dempet">
        Regnet fra regnskapet: kostnadene uten fradrag og de skattefrie inntektene på kontoene for det (NS 4102), forskjellen mellom den regnskapsmessige verdien
        og den skattemessige saldoen for driftsmidlene (saldoskjemaet) og gevinst- og tapskontoen. Legg til det regnskapet ikke vet. Skattemeldingen gjelder.
      </p>
      <div className="aars-tabeller">
        <div className="tabell">
          <table className="aars-tabell">
            <thead>
              <tr>
                <th>Betalbar skatt</th>
                <th className="tall">{sb.aar}</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Resultat før skattekostnad</td>
                <td className="tall">{kr(sb.resultat_for_skatt)}</td>
              </tr>
              {sb.permanente
                .filter((l) => l.fast)
                .map((l) => (
                  <tr key={l.nokkel}>
                    <td className="innrykk">{l.navn}</td>
                    <td className="tall">{kr(l.belop)}</td>
                  </tr>
                ))}
              <tr>
                <td className="innrykk">{redigerbar ? felt("permanente_tekst", "Andre permanente forskjeller", true) : andreP.navn}</td>
                <td className="tall">{redigerbar ? felt("permanente_andre", "Beløpet for andre permanente forskjeller") : kr(andreP.belop)}</td>
              </tr>
              <tr>
                <td className="innrykk">Endring i midlertidige forskjeller</td>
                <td className="tall">{minus(sb.endring_midlertidige)}</td>
              </tr>
              <tr className="sum">
                <td>Grunnlag før underskudd</td>
                <td className="tall">{kr(sb.grunnlag)}</td>
              </tr>
              <tr>
                <td className="innrykk">Fremførbart underskudd som brukes</td>
                <td className="tall">{minus(sb.underskudd_brukt)}</td>
              </tr>
              <tr className="sum">
                <td>Alminnelig inntekt</td>
                <td className="tall">{kr(sb.inntekt)}</td>
              </tr>
              <tr className="sum hoved">
                <td>Betalbar skatt ({sb.sats} %)</td>
                <td className="tall">{kr(sb.betalbar)}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div className="tabell">
          <table className="aars-tabell">
            <thead>
              <tr>
                <th>Utsatt skatt</th>
                <th className="tall">1.1.</th>
                <th className="tall">31.12.</th>
              </tr>
            </thead>
            <tbody>
              {sb.midlertidige
                .filter((x) => x.fast && (x.ib || x.ub || x.nokkel === "driftsmidler"))
                .map((x) => (
                  <tr key={x.nokkel}>
                    <td className="innrykk">{x.navn}</td>
                    <td className="tall">{kr(x.ib)}</td>
                    <td className="tall">{kr(x.ub)}</td>
                  </tr>
                ))}
              <tr>
                <td className="innrykk">{redigerbar ? felt("midlertidige_tekst", "Andre midlertidige forskjeller", true) : andreM.navn}</td>
                <td className="tall">{redigerbar ? felt("midlertidige_andre_ib", "Andre midlertidige forskjeller 1.1.") : kr(andreM.ib)}</td>
                <td className="tall">{redigerbar ? felt("midlertidige_andre_ub", "Andre midlertidige forskjeller 31.12.") : kr(andreM.ub)}</td>
              </tr>
              <tr className="sum">
                <td>Midlertidige forskjeller</td>
                <td className="tall">{kr(sb.midlertidige_ib)}</td>
                <td className="tall">{kr(sb.midlertidige_ub)}</td>
              </tr>
              <tr>
                <td className="innrykk">Fremførbart underskudd</td>
                <td className="tall">{minus(sb.underskudd_ib)}</td>
                <td className="tall">{minus(sb.underskudd_ub)}</td>
              </tr>
              <tr className="sum">
                <td>Grunnlag for utsatt skatt</td>
                <td className="tall" />
                <td className="tall">{kr(sb.grunnlag_utsatt)}</td>
              </tr>
              <tr className="sum hoved">
                <td>
                  {sb.utsatt_ub < 0 || (sb.utsatt_ub === 0 && sb.utsatt_ib < 0) ? "Utsatt skattefordel" : "Utsatt skatt"} ({sb.sats} %)
                </td>
                <td className="tall" title="I balansen før årsoppgjøret">
                  {kr(Math.abs(sb.utsatt_ib))}
                </td>
                <td className="tall">{kr(Math.abs(sb.utsatt_ub))}</td>
              </tr>
            </tbody>
          </table>
          {sb.grunnlag_utsatt < 0 && (
            <label className="aars-skattefordel">
              <input type="checkbox" checked={sb.skattefordel} disabled={!redigerbar} onChange={(e) => lagre({ skattefordel: e.target.checked })} />
              <span>
                Balanseføre den utsatte skattefordelen ({kr(Math.round((-sb.grunnlag_utsatt * sb.sats) / 100))} kr): bare når den kan brukes mot skattbart overskudd de
                neste årene.
              </span>
            </label>
          )}
        </div>
      </div>
      {redigerbar && (
        <div className="rad aars-felt aars-underskudd">
          <label>
            Fremførbart underskudd 1.1.
            <input inputMode="decimal" value={f.underskudd_ib} placeholder={kr(sb.underskudd_kilde === "lagt_inn" ? 0 : sb.underskudd_ib)} onChange={(e) => settF({ ...f, underskudd_ib: e.target.value })} />
            <span className="liten dempet">{kilde}</span>
          </label>
        </div>
      )}
      <p className="liten">
        Skattekostnad: betalbar skatt {kr(sb.betalbar)} kr {sb.endring_utsatt < 0 ? "−" : "+"} endring i utsatt skatt {kr(Math.abs(sb.endring_utsatt))} kr ={" "}
        <strong>{kr(sb.skattekostnad)} kr</strong>.
      </p>
      <div className="knapper">
        {redigerbar && endret && (
          <button
            type="button"
            className="primar"
            disabled={ugyldig}
            onClick={() =>
              lagre({
                permanente_andre: tall.permanente_andre ?? null,
                permanente_tekst: f.permanente_tekst.trim() || null,
                midlertidige_andre_ib: tall.midlertidige_andre_ib ?? null,
                midlertidige_andre_ub: tall.midlertidige_andre_ub ?? null,
                midlertidige_tekst: f.midlertidige_tekst.trim() || null,
                underskudd_ib: tall.underskudd_ib ?? null,
              })
            }
          >
            Lagre
          </button>
        )}
        {bruk && !endret && (
          <button type="button" onClick={bruk}>
            Bruk forslaget
          </button>
        )}
      </div>
      {ugyldig && <p className="liten fare-tekst">Skriv beløpene i kroner (underskuddet som et positivt beløp).</p>}
    </details>
  );
}

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
  const [skjema, settSkjema] = useState<{ skatt: string; utsatt: string; utbytte: string } | null>(null);
  const [laasDato, settLaasDato] = useState("");
  // Skatteberegningen er åpen når årsoppgjøret ikke er bokført, til brukeren åpner eller lukker den.
  const [skattApen, settSkattApen] = useState<boolean | null>(null);
  const [melding, settMelding] = useState<string | null>(null);

  if (d.feil) return <Feil melding={d.feil} />;
  const s = d.data;
  if (!s) return <Laster />;
  const o = s.oppgjor;
  const v = skjema ?? { skatt: tekstFra(o.skatt), utsatt: tekstMedFortegn(o.utsatt_skatt), utbytte: tekstFra(o.utbytte) };
  const skatt = tallFra(v.skatt);
  const utbytte = tallFra(v.utbytte);
  // Utsatt skatt 31.12: null føres ikke, undefined er ugyldig.
  const utsatt = tallMedFortegn(v.utsatt);
  const endringU = utsatt === undefined ? null : endringUtsatt(utsatt, o.utsatt_for);
  // Disponeringer som er ført i andre bilag, trekkes fra overføringen (som på serveren).
  const disponert = Math.round((o.aarsresultat - o.utbytte - o.overforing) * 100) / 100;
  const aarsresultat = skatt === null || endringU === null ? null : Math.round((o.resultat - skatt - endringU) * 100) / 100;
  const overforing = aarsresultat === null || utbytte === null ? null : Math.round((aarsresultat - utbytte - disponert) * 100) / 100;
  const endret = skatt !== o.skatt || utbytte !== o.utbytte || (utsatt !== undefined && utsatt !== o.utsatt_skatt);
  const sb = s.skatteberegning;
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
        {sb && (
          <SkatteberegningKort
            key={JSON.stringify(sb.inndata)}
            sb={sb}
            redigerbar={!s.laast}
            apen={skattApen ?? (s.over && !s.laast && !o.bilag)}
            vis={settSkattApen}
            lagre={(inn) => void kjor(() => api("PUT", `${sti}/aarsoppgjor/${s.aar}/skatteberegning`, inn), () => "Skatteberegningen er lagret.")}
            bruk={
              s.over && !s.laast
                ? () =>
                    settSkjema({
                      ...v,
                      skatt: tekstFra(sb.betalbar),
                      utsatt: sb.utsatt_ub === 0 && sb.utsatt_ib === 0 ? "" : tekstMedFortegn(sb.utsatt_ub),
                    })
                : null
            }
          />
        )}
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
                  : "Betalbar skatt og utsatt skatt: bruk forslaget i skatteberegningen, eller tallene fra skattemeldingen. Utbyttet er det generalforsamlingen vedtar. La feltene stå tomme når de ikke gjelder."}
            </p>
            {s.over && !s.laast && (
              <>
                <div className="rad aars-felt">
                  <label>
                    Betalbar skatt
                    <input inputMode="decimal" value={v.skatt} placeholder="0" onChange={(e) => settSkjema({ ...v, skatt: e.target.value })} />
                  </label>
                  <label>
                    Utsatt skatt 31.12.
                    <input
                      inputMode="decimal"
                      value={v.utsatt}
                      placeholder="Føres ikke"
                      title="Negativt beløp: utsatt skattefordel"
                      onChange={(e) => settSkjema({ ...v, utsatt: e.target.value })}
                    />
                  </label>
                  <label>
                    Utbytte
                    <input inputMode="decimal" value={v.utbytte} placeholder="0" onChange={(e) => settSkjema({ ...v, utbytte: e.target.value })} />
                  </label>
                </div>
                <p className="liten">
                  {overforing === null || skatt === null || endringU === null
                    ? "Skriv beløpene i kroner (utsatt skattefordel som et negativt beløp)."
                    : `Skattekostnad ${kr(skatt + endringU)} kr${endringU ? ` (endring i utsatt skatt ${kr(endringU)} kr)` : ""}. ${
                        overforing >= 0 ? `${kr(overforing)} kr overføres til annen egenkapital.` : `Underskuddet på ${kr(-overforing)} kr dekkes av annen egenkapital.`
                      }`}
                </p>
                <div className="knapper">
                  {(o.trengs || endret) && (!o.stemmer || endret || !o.bilag) && (
                    <button
                      type="button"
                      className="primar"
                      disabled={h.opptatt || skatt === null || utbytte === null || utsatt === undefined}
                      onClick={() =>
                        void kjor(
                          () => api<{ bilag: { bilagsnummer: string } | null }>("POST", `${sti}/aarsoppgjor/${s.aar}`, { skatt, utbytte, utsatt_skatt: utsatt }),
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
        <div className="aars-saft">
          <div>
            <strong>SAF-T Regnskap</strong>
            <p className="liten dempet">
              Hele regnskapet for {s.aar} i Skatteetatens standardformat: kontoene med saldo, kundene, leverandørene, mva-kodene og alle bilagene. Skatteetaten kan be om
              filen, og regnskapsføreren kan lese den inn.
            </p>
          </div>
          <button
            type="button"
            disabled={h.opptatt}
            onClick={() => {
              const stempel = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
              void h.kjor(() => lastNed(`${sti}/saft?aar=${s.aar}`, `SAF-T Financial_${org!.orgnr ?? "uten-orgnr"}_${stempel}.xml`));
            }}
          >
            Last ned SAF-T for {s.aar}
          </button>
        </div>
        <div className="aars-saft">
          <div>
            <strong>Skattemeldingen</strong>
            <p className="liten dempet">
              Grunnlaget for næringsspesifikasjonen: kontoene samlet på postene i næringsspesifikasjonen, med resultatregnskapet og balansen. De skattemessige saldoene
              og forskjellene står i saldoskjemaet.
            </p>
          </div>
          <div className="knapper">
            <Link className="knapp" to={`/rapporter?fane=regnskap&rapport=regnskap.naeringsspesifikasjon`}>
              Næringsspesifikasjon
            </Link>
            <Link className="knapp" to={`/rapporter?fane=regnskap&rapport=regnskap.saldoskjema`}>
              Saldoskjema
            </Link>
          </div>
        </div>
        <Feil melding={h.feil} />
      </div>
    </>
  );
}
