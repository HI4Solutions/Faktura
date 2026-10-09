// Årsoversikten (sammenstillingsoppgaven, server/src/lonnAarsoversikt.ts): den ansatte ser sin
// egen under «Mine lønnsslipper» (årene som knapper; ?aar= åpner året, som varselet i januar gjør),
// og lederen har fanen «Årsoversikt» med de ansatte i året, PDF for én eller alle, og varsel til de
// ansatte med innlogging.
import { useEffect, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { api, hent } from "../api";
import { Dialog, Feil, Laster, Tom, useData, useHandling, useSmal } from "../felles";
import { erAdmin, useKonto } from "../konto";
import { dato, kr } from "../format";
import { IkonLonn } from "../ikoner";
import { apnePdf, MND } from "../lonn";

type Aarsoversikt = {
  aar: number;
  ansatt_id: string;
  navn: string;
  ansattnummer: number;
  inntekter: { kode: string; navn: string; belop: number }[];
  utgifter: { navn: string; belop: number }[];
  trekk: { navn: string; belop: number }[];
  sum: {
    brutto: number;
    trekkpliktig: number;
    skattetrekk: number;
    utgifter: number;
    trekk_etter_skatt: number;
    netto: number;
    feriepengegrunnlag: number;
    feriepenger_opptjent: number;
    otp: number;
  };
  maaneder: { periode: string; utbetalingsdato: string; brutto: number; skattetrekk: number; netto: number }[];
  tidligere: { trekkpliktig: number; forskuddstrekk: number; feriepengegrunnlag: number; feriepenger_utbetalt: number } | null;
};
type AnsattIAaret = { ansatt_id: string; navn: string; ansattnummer: number; brutto: number; skattetrekk: number; netto: number; innlogging: boolean };
type Liste = {
  aar: number;
  aar_liste: number[];
  utkast: number;
  varslet: { varslet: string; antall: number; varslet_av: string | null } | null;
  ansatte: AnsattIAaret[];
};

const pdfSti = (orgId: string, aar: number, ansatt?: string) => `/org/${orgId}/lonn/aarsoversikt/${aar}/pdf${ansatt ? `?ansatt=${ansatt}` : ""}`;

// Året i adressen (?aar=), som et tall eller null.
function useAar(): [number | null, (aar: number | null) => void] {
  const [sok, settSok] = useSearchParams();
  const aar = Number(sok.get("aar")) || null;
  const sett = (ny: number | null) => {
    const p = new URLSearchParams(sok);
    if (ny) p.set("aar", String(ny));
    else p.delete("aar");
    settSok(p, { replace: true });
  };
  return [aar, sett];
}

// --- Den ansatte ------------------------------------------------------------------------------

export function MineAarsoversikter() {
  const { org } = useKonto();
  const liste = useData(() => hent<{ ansatt_id: string; aar: number[] }>(`/org/${org!.id}/lonn/aarsoversikt`), [org?.id]);
  const [aar, settAar] = useAar();
  const aarene = liste.data?.aar ?? [];
  if (!aarene.length) return null;
  return (
    <>
      <div className="kort lonn-aar">
        <div className="lonn-aar-tekst">
          <strong>Årsoversikt</strong>
          <span className="dempet liten">Lønnen og skattetrekket i året, til kontroll av skattemeldingen.</span>
        </div>
        <div className="lonn-aar-knapper">
          {aarene.slice(0, 4).map((a) => (
            <button key={a} type="button" onClick={() => settAar(a)}>
              {a}
            </button>
          ))}
        </div>
      </div>
      <Dialog bred apen={!!aar && aarene.includes(aar)} lukk={() => settAar(null)} tittel={`Årsoversikt for ${aar ?? ""}`}>
        {aar && <AarsoversiktVisning aar={aar} />}
      </Dialog>
    </>
  );
}

// --- Visningen (den ansatte selv, eller en ansatt lederen har valgt) --------------------------

function AarsoversiktVisning({ aar, ansatt }: { aar: number; ansatt?: string }) {
  const { org } = useKonto();
  const smal = useSmal();
  const d = useData(() => hent<Aarsoversikt>(`/org/${org!.id}/lonn/aarsoversikt/${aar}${ansatt ? `?ansatt=${ansatt}` : ""}`), [org?.id, aar, ansatt]);
  const h = useHandling();
  if (d.feil) return <Feil melding={d.feil} />;
  if (!d.data) return <Laster />;
  const a = d.data;
  const rad = (nokkel: string, navn: ReactNode, verdi: number, klasse?: string) => (
    <div key={nokkel} className={klasse}>
      <span>{navn}</span>
      <span>{kr(verdi)}</span>
    </div>
  );
  return (
    <div className="lonn-visning">
      {ansatt && (
        <p className="dempet liten">
          {a.navn} · ansattnr. {a.ansattnummer}
        </p>
      )}
      <h3>Lønn og godtgjørelser</h3>
      <div className="summer lonn-summer">
        {a.inntekter.map((l) => rad(`i-${l.kode}`, l.navn, l.belop))}
        {rad("brutto", "Bruttolønn", a.sum.brutto, "total")}
        {rad("trekk", "Forskuddstrekk", -a.sum.skattetrekk)}
        {a.utgifter.map((l) => rad(`u-${l.navn}`, l.navn, l.belop))}
        {a.trekk.map((l) => rad(`t-${l.navn}`, l.navn, l.belop))}
        {rad("netto", "Utbetalt i året", a.sum.netto, "total")}
      </div>
      <p className="liten dempet">
        Opptjent i året: feriepengegrunnlag {kr(a.sum.feriepengegrunnlag)}, og {kr(a.sum.feriepenger_opptjent)} i feriepenger til utbetaling i {a.aar + 1}
        {a.sum.otp ? `. Pensjon (OTP) fra arbeidsgiveren: ${kr(a.sum.otp)}` : ""}.
      </p>
      {a.tidligere && (
        <p className="liten dempet">
          Fra et tidligere lønnssystem: trekkpliktig lønn {kr(a.tidligere.trekkpliktig)} og forskuddstrekk {kr(a.tidligere.forskuddstrekk)}.
        </p>
      )}
      {a.maaneder.length > 0 && (
        <>
          <h3>Hver utbetaling</h3>
          <div className="tabell">
            <table className="lonn-linjer">
              <thead>
                <tr>
                  <th>Lønn for</th>
                  {!smal && <th>Utbetalt</th>}
                  <th className="hoyre">Brutto</th>
                  <th className="hoyre">{smal ? "Trekk" : "Forskuddstrekk"}</th>
                  <th className="hoyre">Netto</th>
                </tr>
              </thead>
              <tbody>
                {a.maaneder.map((m, i) => (
                  <tr key={i}>
                    <td>{MND[Number(m.periode.slice(5, 7)) - 1]}</td>
                    {!smal && <td>{dato(m.utbetalingsdato)}</td>}
                    <td className="tall">{kr(m.brutto)}</td>
                    <td className="tall">{kr(-m.skattetrekk)}</td>
                    <td className="tall">{kr(m.netto)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      <p className="liten dempet">Tallene skal stemme med a-meldingen og skattemeldingen. Si fra til arbeidsgiveren hvis noe ikke stemmer.</p>
      <Feil melding={h.feil} />
      <div className="knapper">
        <button type="button" className="primar" disabled={h.opptatt} onClick={() => void h.kjor(() => apnePdf(pdfSti(org!.id, aar, ansatt)))}>
          Last ned som PDF
        </button>
      </div>
    </div>
  );
}

// --- Lederen ----------------------------------------------------------------------------------

export function Aarsoversikter() {
  const { org } = useKonto();
  const admin = erAdmin(org?.rolle);
  const smal = useSmal();
  const naa = new Date();
  const [valgtAar, settAar] = useAar();
  // Standard: året før i januar og februar (da årsoversikten skal ut), ellers i år.
  const aar = valgtAar ?? (naa.getMonth() < 2 ? naa.getFullYear() - 1 : naa.getFullYear());
  const d = useData(() => hent<Liste>(`/org/${org!.id}/lonn/aarsoversikt/${aar}/ansatte`), [org?.id, aar], { oppdater: true });
  const [vis, settVis] = useState<AnsattIAaret | null>(null);
  const [melding, settMelding] = useState<string | null>(null);
  const h = useHandling();

  // Uten lønn i det valgte året (og uten valg i adressen): det siste året med lønn.
  useEffect(() => {
    if (!valgtAar && d.data && !d.data.ansatte.length && d.data.aar_liste.length && !d.data.aar_liste.includes(aar)) settAar(d.data.aar_liste[0]!);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d.data]);

  const aarene = [...new Set([aar, ...(d.data?.aar_liste ?? [])])].sort((x, y) => y - x);
  const uten = d.data?.ansatte.filter((a) => !a.innlogging).length ?? 0;
  const varsle = async () => {
    settMelding(null);
    const r = await h.kjor(() => api<{ antall: number }>("POST", `/org/${org!.id}/lonn/aarsoversikt/${aar}/varsle`));
    if (r) {
      settMelding(r.antall ? `${r.antall} ${r.antall === 1 ? "ansatt" : "ansatte"} har fått varsel om årsoversikten.` : "Ingen av de ansatte har innlogging, så ingen fikk varsel.");
      void d.last();
    }
  };

  return (
    <>
      <p className="undertittel">
        Arbeidsgiveren skal gi hver ansatt en oversikt over lønnen og trekket i året innen 31. januar. De ansatte med innlogging ser sin egen under Lønnsslipper, og
        får varsel i januar. Gi PDF-en til dem uten innlogging.
      </p>
      <div className="knapper lonn-knapper lonn-aar-valg">
        <label>
          År{" "}
          <select value={aar} onChange={(e) => settAar(Number(e.target.value))}>
            {aarene.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </label>
        {!!d.data?.ansatte.length && (
          <>
            <button type="button" disabled={h.opptatt} onClick={() => void h.kjor(() => apnePdf(pdfSti(org!.id, aar, "alle")))}>
              Last ned alle (PDF)
            </button>
            {admin && (
              <button type="button" className="primar" disabled={h.opptatt} onClick={() => void varsle()}>
                {d.data.varslet ? "Varsle de ansatte igjen" : "Varsle de ansatte"}
              </button>
            )}
          </>
        )}
      </div>
      <Feil melding={h.feil} />
      {melding && <p className="ok-tekst">{melding}</p>}
      {d.feil ? (
        <Feil melding={d.feil} />
      ) : !d.data ? (
        <Laster />
      ) : !d.data.ansatte.length ? (
        <div className="kort">
          <Tom ikon={<IkonLonn storrelse={22} />} tittel={`Ingen godkjent lønn i ${aar}`}>
            <p>Årsoversikten lages av de godkjente lønnskjøringene med utbetaling i året.</p>
          </Tom>
        </div>
      ) : (
        <>
          <p className="liten dempet lonn-aar-status">
            {d.data.varslet
              ? `De ansatte fikk varsel ${dato(d.data.varslet.varslet.slice(0, 10))}${d.data.varslet.varslet_av ? ` (av ${d.data.varslet.varslet_av})` : " (automatisk)"}: ${d.data.varslet.antall} med innlogging.`
              : `De ansatte med innlogging får varsel i januar, når ingen lønnskjøring for ${aar} står som utkast (senest 25. januar).`}
            {uten > 0 && ` ${uten} ${uten === 1 ? "ansatt har" : "ansatte har"} ikke innlogging.`}
          </p>
          {d.data.utkast > 0 && (
            <p className="advarsel-tekst liten">
              {d.data.utkast === 1 ? "Én lønnskjøring" : `${d.data.utkast} lønnskjøringer`} med utbetaling i {aar} står som utkast og er ikke med før{" "}
              {d.data.utkast === 1 ? "den" : "de"} er godkjent.
            </p>
          )}
          {smal ? (
            <div className="kort liste">
              {d.data.ansatte.map((a) => (
                <div key={a.ansatt_id} className="liste-rad-ramme">
                  <button type="button" className="liste-rad" onClick={() => settVis(a)}>
                    <span className="linje">
                      <span className="tittel">{a.navn}</span>
                      <span className="belop">{kr(a.netto)}</span>
                    </span>
                    <span className="linje">
                      <span className="under">
                        Brutto {kr(a.brutto)} · trekk {kr(a.skattetrekk)}
                      </span>
                    </span>
                    {!a.innlogging && (
                      <span className="linje">
                        <span className="under">Uten innlogging: gi PDF-en</span>
                      </span>
                    )}
                  </button>
                  <button type="button" className="lenke lonn-pdf" onClick={() => void h.kjor(() => apnePdf(pdfSti(org!.id, aar, a.ansatt_id)))}>
                    PDF
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <div className="kort tabell">
              <table>
                <thead>
                  <tr>
                    <th>Nr.</th>
                    <th>Ansatt</th>
                    <th className="hoyre">Bruttolønn</th>
                    <th className="hoyre">Forskuddstrekk</th>
                    <th className="hoyre">Utbetalt</th>
                    <th>Innlogging</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {d.data.ansatte.map((a) => (
                    <tr key={a.ansatt_id} className="klikkbar" onClick={() => settVis(a)}>
                      <td>{a.ansattnummer}</td>
                      <td>
                        <strong>{a.navn}</strong>
                      </td>
                      <td className="tall">{kr(a.brutto)}</td>
                      <td className="tall">{kr(a.skattetrekk)}</td>
                      <td className="tall sterk">{kr(a.netto)}</td>
                      <td>{a.innlogging ? "Ja" : <span className="dempet">Nei, gi PDF-en</span>}</td>
                      <td className="hoyre">
                        <button
                          type="button"
                          className="lenke"
                          onClick={(e) => {
                            e.stopPropagation();
                            void h.kjor(() => apnePdf(pdfSti(org!.id, aar, a.ansatt_id)));
                          }}
                        >
                          PDF
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
      <Dialog bred apen={!!vis} lukk={() => settVis(null)} tittel={vis ? `Årsoversikt for ${aar}: ${vis.navn}` : "Årsoversikt"}>
        {vis && <AarsoversiktVisning aar={aar} ansatt={vis.ansatt_id} />}
      </Dialog>
    </>
  );
}
