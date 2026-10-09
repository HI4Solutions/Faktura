// Bokføringen av lønnen i HI4 Fakturas eget regnskap (server/src/lonnBokforingRuter.ts):
// kontoene og valgene under Innstillinger → Ansatte og timer, og lønnsbilaget på lønnskjøringen
// (bilagserien L: det gjeldende bilaget, og de som er reversert fordi kjøringen ble åpnet igjen).
import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { api, hent, lastNed } from "../api";
import { Feil, Laster, useData, useHandling, useSmal } from "../felles";
import { erAdmin, useKonto } from "../konto";
import { dato, kr } from "../format";

type Kontorad = { rolle: string; navn: string; standard: string; konto: string; endret: boolean };
type Oppsett = { kontoer: Kontorad[]; feriepenger: "avsetning" | "utbetaling"; netto: "skyldig" | "bank"; otp: boolean };
type Postering = { rolle: string; konto: string; navn: string; tekst: string; belop: number };
type Bilag = {
  id: string;
  bilagsnummer: string;
  dato: string;
  tekst: string;
  reverserer: string | null;
  reversert_av: string | null;
  opprettet: string;
  opprettet_av: string | null;
  posteringer: Postering[];
};
type Forslag = { dato: string; tekst: string; posteringer: Postering[]; sum: number };

// --- Innstillinger → Ansatte og timer -------------------------------------------------------------

export function BokforingOppsett() {
  const { org } = useKonto();
  const { data, settData, feil } = useData(() => hent<Oppsett>(`/org/${org!.id}/lonn/bokforing`), [org?.id]);
  const h = useHandling();
  const [skjema, settSkjema] = useState<{ kontoer: Record<string, string>; feriepenger: Oppsett["feriepenger"]; netto: Oppsett["netto"]; otp: boolean } | null>(null);
  const [lagret, settLagret] = useState(false);

  useEffect(() => {
    if (data && !skjema)
      settSkjema({ kontoer: Object.fromEntries(data.kontoer.map((k) => [k.rolle, k.endret ? k.konto : ""])), feriepenger: data.feriepenger, netto: data.netto, otp: data.otp });
  }, [data, skjema]);

  if (feil) return <Feil melding={feil} />;
  if (!data || !skjema) return null;
  const konto = (rolle: string) => data.kontoer.find((k) => k.rolle === rolle)?.konto;

  async function lagre(e: FormEvent) {
    e.preventDefault();
    settLagret(false);
    const r = await h.kjor(() =>
      api<Oppsett>("PUT", `/org/${org!.id}/lonn/bokforing`, { ...skjema, kontoer: Object.fromEntries(Object.entries(skjema!.kontoer).map(([k, v]) => [k, v.trim() || null])) }),
    );
    if (r) {
      settData(r);
      settSkjema({ ...skjema!, kontoer: Object.fromEntries(r.kontoer.map((k) => [k.rolle, k.endret ? k.konto : ""])) });
      settLagret(true);
    }
  }

  return (
    <form className="kort" id="bokforing" onSubmit={lagre}>
      <h2 style={{ marginTop: 0 }}>Bokføring av lønn</h2>
      <p className="dempet liten">
        Når en lønnskjøring godkjennes, føres lønnsbilaget i HI4 Fakturas regnskap (bilagserie L): lønnen, feriepengene, trekkene, nettolønnen og
        arbeidsgiveravgiften på kontoene under. Åpnes kjøringen igjen, reverseres bilaget, og et nytt føres når den godkjennes på nytt. Bilagene står på
        lønnskjøringen og under <Link to="/rapporter?fane=lonn&rapport=lonn.bokforing">Rapporter → Lønn → Lønnsbilag</Link> (CSV og PDF, og til
        regnskapsføreren med de andre lønnsrapportene). De blir en del av regnskapsmodulen.
      </p>

      <h4 className="lonn-under">Feriepenger, nettolønn og OTP</h4>
      <div className="rad">
        <label>
          Feriepengene
          <select value={skjema.feriepenger} onChange={(e) => settSkjema({ ...skjema, feriepenger: e.target.value as Oppsett["feriepenger"] })}>
            <option value="avsetning">Avsettes hver måned</option>
            <option value="utbetaling">Kostnadsføres når de utbetales</option>
          </select>
          <span className="felt-hjelp">
            {skjema.feriepenger === "avsetning"
              ? `Opptjente feriepenger og avgiften av dem føres som kostnad hver måned (mot ${konto("skyldige_feriepenger")} og ${konto("paalopt_aga_feriepenger")}), og utbetalingen tas fra avsetningen.`
              : "Feriepengene føres som kostnad når de utbetales (i juni og ved sluttoppgjør)."}
          </span>
        </label>
        <label>
          Nettolønnen
          <select value={skjema.netto} onChange={(e) => settSkjema({ ...skjema, netto: e.target.value as Oppsett["netto"] })}>
            <option value="skyldig">Til skyldig lønn (betales fra banken)</option>
            <option value="bank">Rett fra bankkontoen</option>
          </select>
          <span className="felt-hjelp">
            {skjema.netto === "skyldig"
              ? `Nettolønnen krediteres ${konto("skyldig_lonn")} og avstemmes mot utbetalingen i banken.`
              : `Nettolønnen krediteres bankkontoen ${konto("bank")} på utbetalingsdatoen.`}
          </span>
        </label>
      </div>
      <label>
        <input type="checkbox" checked={skjema.otp} onChange={(e) => settSkjema({ ...skjema, otp: e.target.checked })} />
        Avsett OTP fra lønnen (ellers føres den fra fakturaen fra pensjonsleverandøren)
      </label>

      <h4 className="lonn-under">Kontoer</h4>
      <p className="liten dempet">Standarden er norsk standard kontoplan (NS 4102). Tomt felt: standardkontoen. Endringer gjelder bilagene som føres etterpå.</p>
      <div className="bokforing-kontoer">
        {data.kontoer.map((k) => (
          <label key={k.rolle}>
            {k.navn}
            <input
              inputMode="numeric"
              placeholder={k.standard}
              value={skjema.kontoer[k.rolle] ?? ""}
              onChange={(e) => settSkjema({ ...skjema, kontoer: { ...skjema.kontoer, [k.rolle]: e.target.value } })}
            />
          </label>
        ))}
      </div>
      <Feil melding={h.feil} />
      {lagret && (
        <div className="melding ok" role="status">
          Lagret.
        </div>
      )}
      <div className="knapper">
        <button className="primar" disabled={h.opptatt}>
          Lagre
        </button>
      </div>
    </form>
  );
}

// --- Lønnskjøringen --------------------------------------------------------------------------

function Bilagstabell({ b }: { b: { dato: string; tekst: string; posteringer: Postering[] } }) {
  const smal = useSmal();
  const sum = b.posteringer.filter((p) => p.belop > 0).reduce((a, p) => a + p.belop, 0);
  return (
    <div className="tabell lonn-bilag">
      <table className="lonn-linjer">
        <thead>
          <tr>
            <th>Konto</th>
            {!smal && <th>Tekst</th>}
            <th className="hoyre">Debet</th>
            <th className="hoyre">Kredit</th>
          </tr>
        </thead>
        <tbody>
          {b.posteringer.map((p, i) => (
            <tr key={i}>
              <td>
                {p.konto} {p.navn}
                {smal && <span className="lonn-art">{p.tekst}</span>}
              </td>
              {!smal && <td>{p.tekst}</td>}
              <td className="tall">{p.belop > 0 ? kr(p.belop) : ""}</td>
              <td className="tall">{p.belop < 0 ? kr(-p.belop) : ""}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td colSpan={smal ? 1 : 2}>Sum</td>
            <td className="tall">{kr(sum)}</td>
            <td className="tall">{kr(sum)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

export function KjoringBokforing({ kjoringId, godkjent, godkjentAt }: { kjoringId: string; godkjent: boolean; godkjentAt: string | null }) {
  const { org } = useKonto();
  const admin = erAdmin(org?.rolle);
  const sti = `/org/${org!.id}/lonn/kjoringer/${kjoringId}`;
  const d = useData(() => hent<{ gjeldende: Bilag | null; bilag: Bilag[]; forslag: Forslag | null }>(`${sti}/bokforing`), [sti, godkjent, godkjentAt]);
  const h = useHandling();
  const [vis, settVis] = useState(false);

  if (d.feil) return <Feil melding={d.feil} />;
  if (!d.data) return godkjent ? <Laster /> : null;
  const { gjeldende, bilag, forslag } = d.data;
  const reverserte = bilag.filter((b) => b.reversert_av);
  if (!godkjent && !bilag.length) return null;
  const bokfor = async () => {
    if (await h.kjor(() => api("POST", `${sti}/bokfor`))) void d.last();
  };
  const vist = gjeldende ?? forslag;

  return (
    <section className="kort lonn-bokforing">
      <div className="lonn-bokforing-topp">
        <h3>Lønnsbilag{gjeldende ? ` ${gjeldende.bilagsnummer}` : ""}</h3>
        {gjeldende ? (
          <span className="merke merke-ok">Bokført {dato(gjeldende.dato)}</span>
        ) : godkjent ? (
          <span className="merke merke-advarsel">Ikke bokført</span>
        ) : (
          <span className="merke merke-noytral">Reversert</span>
        )}
      </div>
      {gjeldende && (
        <p className="liten dempet">
          {gjeldende.tekst}, ført {dato(gjeldende.opprettet.slice(0, 10))}
          {gjeldende.opprettet_av ? ` av ${gjeldende.opprettet_av}` : ""}.
        </p>
      )}
      {!gjeldende && godkjent && forslag && (
        <p className="liten">Kjøringen ble godkjent før lønnen ble bokført i HI4 Faktura. Bokfør den, så får den lønnsbilaget under.</p>
      )}
      {reverserte.map((b) => (
        <p key={b.id} className="liten dempet">
          {b.bilagsnummer} er reversert ({bilag.find((x) => x.id === b.reversert_av)?.bilagsnummer ?? "nytt bilag"}) fordi kjøringen ble åpnet igjen.
        </p>
      ))}
      <Feil melding={h.feil} />
      {vist && (
        <div className="knapper">
          {!gjeldende && godkjent && admin && (
            <button type="button" className="primar" disabled={h.opptatt} onClick={() => void bokfor()}>
              Bokfør
            </button>
          )}
          <button type="button" onClick={() => settVis(!vis)} aria-expanded={vis}>
            {vis ? "Skjul bilaget" : "Vis bilaget"}
          </button>
          {gjeldende && (
            <button
              type="button"
              disabled={h.opptatt}
              onClick={() => void h.kjor(() => lastNed(`/org/${org!.id}/rapportmodul/lonn.bokforing/csv?kjoring=${kjoringId}`, `lonnsbilag-${gjeldende.bilagsnummer}.csv`))}
            >
              Last ned (CSV)
            </button>
          )}
        </div>
      )}
      {vis && vist && <Bilagstabell b={vist} />}
    </section>
  );
}
