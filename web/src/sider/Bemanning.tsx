// Bemanningskalenderen: en måned om gangen, med hvor mange som er på jobb hver dag (fra
// vaktplanen), hvem som er borte (ferie, sykdom, permisjon), vakter som mangler vikar og
// ledige vakter. Velg en dag for å se bemanningen den dagen, sette inn vikar eller gå videre
// til tavla og uka i vaktplanen.
import { useEffect, useRef, useState } from "react";
import { hent } from "../api";
import { Dialog, Feil, Laster, useData } from "../felles";
import { useKonto } from "../konto";
import { iDag, leggTilDager, leggTilMaaneder } from "../format";
import { IkonHoyre, IkonVenstre } from "../ikoner";
import { mandag, middag, ukedager, ukenr, visDag } from "../uke";
import { fravaerKlasse, fravaerPeriode, fravaerTekst, FravaerSkjema, VikarSkjema, type Ansatt, type Fravaer, type FravaerType } from "./Fravaer";
import { visLangDag } from "./Tavle";
import type { Vakt, VaktSvar } from "./Vakter";

const maanedFormat = new Intl.DateTimeFormat("nb-NO", { month: "long", year: "numeric", timeZone: "UTC" });
const UKEDAGER = ["Man", "Tir", "Ons", "Tor", "Fre", "Lør", "Søn"];
const TYPER: FravaerType[] = ["ferie", "syk", "sykt_barn", "permisjon", "annet"];
const fornavn = (navn: string) => navn.split(" ")[0];
export const gyldigMaaned = (s: string | null): s is string => !!s && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);

type Dag = { paJobb: Vakt[]; antall: number; borte: Fravaer[]; mangler: Vakt[]; ledige: Vakt[] };
function dagInfo(data: VaktSvar, d: string): Dag {
  const vakter = data.vakter.filter((v) => v.dato === d);
  const paJobb = vakter.filter((v) => v.ansatt_id && !v.fravaer);
  return {
    paJobb,
    antall: new Set(paJobb.map((v) => v.ansatt_id)).size,
    borte: data.fravaer.filter((f) => f.fra <= d && f.til >= d),
    mangler: vakter.filter((v) => v.ansatt_id && v.fravaer && !v.har_vikar),
    ledige: vakter.filter((v) => !v.ansatt_id),
  };
}

export function Bemanning({
  maaned,
  velgMaaned,
  kanEndre,
  tilTavle,
  tilUke,
}: {
  maaned: string; // «2026-10»
  velgMaaned: (maaned: string) => void;
  kanEndre: boolean;
  tilTavle: (dato: string) => void;
  tilUke: (mandag: string) => void;
}) {
  const { org } = useKonto();
  const forste = `${maaned}-01`;
  const siste = leggTilDager(leggTilMaaneder(forste, 1), -1);
  const fra = mandag(forste);
  const til = leggTilDager(mandag(siste), 6);
  const [versjon, settVersjon] = useState(0);
  const { data, feil } = useData(() => hent<VaktSvar>(`/org/${org!.id}/vakter?fra=${fra}&til=${til}`), [org?.id, fra, til, versjon]);
  const ansatte = useData(() => hent<Ansatt[]>(`/org/${org!.id}/ansatte`), [org?.id, versjon]);
  const standard = iDag().startsWith(maaned) ? iDag() : forste;
  const [valgt, settValgt] = useState(standard);
  const [vikar, settVikar] = useState<Vakt | null>(null);
  const [nyttFravaer, settNyttFravaer] = useState(false);
  const [melding, settMelding] = useState<string | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  // Velg en dag; på mobil, der dagen vises under kalenderen, rulles den fram.
  const velg = (d: string) => {
    settValgt(d);
    requestAnimationFrame(() => {
      const r = panel.current?.getBoundingClientRect();
      if (r && r.top > window.innerHeight - 160) panel.current!.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  };
  // Ny måned: velg i dag (eller den første), og ikke vis meldingen fra den forrige.
  useEffect(() => {
    settValgt(standard);
    settMelding(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [maaned]);
  const denne = iDag().slice(0, 7);
  const navn = maanedFormat.format(middag(forste));
  const uker: string[][] = [];
  for (let m = fra; m <= til; m = leggTilDager(m, 7)) uker.push(ukedager(m));

  const verktoy = (
    <div className="uke-verktoy">
      <div className="ukevelger">
        <button type="button" className="ikon" aria-label="Forrige måned" title="Forrige måned" onClick={() => velgMaaned(leggTilMaaneder(forste, -1).slice(0, 7))}>
          <IkonVenstre storrelse={20} />
        </button>
        <div className="uke-navn" aria-live="polite">
          <strong>{navn.charAt(0).toUpperCase() + navn.slice(1)}</strong>
          <span>
            Uke {ukenr(fra).uke}–{ukenr(til).uke}
          </span>
        </div>
        <button type="button" className="ikon" aria-label="Neste måned" title="Neste måned" onClick={() => velgMaaned(leggTilMaaneder(forste, 1).slice(0, 7))}>
          <IkonHoyre storrelse={20} />
        </button>
        {maaned !== denne && (
          <button type="button" className="lenke" onClick={() => velgMaaned(denne)}>
            Denne måneden
          </button>
        )}
      </div>
      {kanEndre && (
        <button type="button" className="primar" onClick={() => settNyttFravaer(true)}>
          Registrer fravær
        </button>
      )}
    </div>
  );

  if (feil || ansatte.feil)
    return (
      <>
        {verktoy}
        <Feil melding={feil ?? ansatte.feil} />
      </>
    );
  if (!data)
    return (
      <>
        {verktoy}
        <Laster />
      </>
    );

  const celle = (d: string) => {
    const i = dagInfo(data, d);
    const typer = TYPER.filter((t) => i.borte.some((f) => f.type === t));
    const hvem = (t: FravaerType) => i.borte.filter((f) => f.type === t);
    const etikett = [
      visLangDag(d),
      `${i.antall} på jobb`,
      ...typer.map((t) => `${fravaerTekst[t]}: ${hvem(t).map((f) => f.ansatt_navn).join(", ")}`),
      i.mangler.length ? `${i.mangler.length} mangler vikar` : "",
      i.ledige.length ? `${i.ledige.length} ${i.ledige.length === 1 ? "ledig vakt" : "ledige vakter"}` : "",
    ]
      .filter(Boolean)
      .join(". ");
    return (
      <button
        key={d}
        type="button"
        aria-label={etikett}
        aria-pressed={valgt === d}
        title={etikett}
        className={`kal-dag${d.slice(0, 7) !== maaned ? " utenfor" : ""}${d === iDag() ? " i-dag" : ""}${valgt === d ? " valgt" : ""}`}
        onClick={() => velg(d)}
      >
        <span className="kal-dato">{Number(d.slice(8))}</span>
        {i.antall > 0 && (
          <span className="kal-antall">
            <strong>{i.antall}</strong>
            <span className="kal-lang"> på jobb</span>
          </span>
        )}
        <span className="kal-merker">
          {typer.map((t) => (
            <span key={t} className={`kal-fravaer ${t}`}>
              <span className="kal-lang">{hvem(t).map((f) => fornavn(f.ansatt_navn)).join(", ")}</span>
            </span>
          ))}
          {i.mangler.length > 0 && (
            <span className="kal-mangler">
              <span className="kal-lang">{i.mangler.length} uten vikar</span>
            </span>
          )}
          {i.ledige.length > 0 && (
            <span className="kal-ledige">
              <span className="kal-lang">
                {i.ledige.length} {i.ledige.length === 1 ? "ledig" : "ledige"}
              </span>
            </span>
          )}
        </span>
      </button>
    );
  };

  const i = dagInfo(data, valgt);
  const perAnsatt = [...new Set(i.paJobb.map((v) => v.ansatt_id!))].map((id) => ({ id, vakter: i.paJobb.filter((v) => v.ansatt_id === id) }));

  return (
    <>
      {verktoy}
      {melding && (
        <div className="melding ok" role="status">
          {melding}
        </div>
      )}
      <div className="kalender-rad">
        <div className="kort kalender-kort">
          <div className="kalender">
            <div className="kal-hode">
              <span className="kal-uke">Uke</span>
              {UKEDAGER.map((n) => (
                <span key={n}>{n}</span>
              ))}
            </div>
            {uker.map((u) => (
              <div key={u[0]} className="kal-uke-rad">
                <button type="button" className="kal-uke" title={`Uke ${ukenr(u[0]!).uke} i vaktplanen`} onClick={() => tilUke(u[0]!)}>
                  {ukenr(u[0]!).uke}
                </button>
                {u.map(celle)}
              </div>
            ))}
          </div>
          <div className="kal-forklaring">
            <span className="kal-fravaer ferie">Ferie</span>
            <span className="kal-fravaer syk">Syk eller sykt barn</span>
            <span className="kal-fravaer permisjon">Permisjon og annet</span>
            <span className="kal-mangler">Mangler vikar</span>
            <span className="kal-ledige">Ledig vakt</span>
            <span className="kal-tall-forklaring">Tallet: på jobb</span>
          </div>
        </div>
        <div className="kort kal-panel" aria-live="polite" ref={panel}>
          <div className="kal-panel-topp">
            <h2>{visLangDag(valgt)}</h2>
            <div className="knapper">
              <button type="button" onClick={() => tilTavle(valgt)}>
                Tavla
              </button>
              <button type="button" onClick={() => tilUke(mandag(valgt))}>
                Uke {ukenr(valgt).uke}
              </button>
            </div>
          </div>
          {i.mangler.length > 0 && (
            <section className="kal-del mangler">
              <h3>Mangler vikar ({i.mangler.length})</h3>
              <ul className="liste-enkel">
                {i.mangler.map((v) => (
                  <li key={v.id}>
                    <span>
                      <span className="tittel">{v.ansatt_navn}</span>{" "}
                      <span className="dempet">
                        {v.fra}–{v.til}
                        {v.oppgave ? ` · ${v.oppgave}` : ""}
                      </span>
                    </span>
                    {kanEndre && (
                      <button type="button" onClick={() => settVikar(v)}>
                        Sett inn vikar
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}
          <section className="kal-del">
            <h3>På jobb ({i.antall})</h3>
            {perAnsatt.length ? (
              <ul className="liste-enkel">
                {perAnsatt.map(({ id, vakter }) => (
                  <li key={id}>
                    <span className="tittel">
                      {vakter[0]!.ansatt_navn}
                      {vakter.some((v) => v.vikar_for) && <span className="merke merke-info">Vikar</span>}
                    </span>
                    <span className="dempet tid">
                      {vakter.map((v) => `${v.fra}–${v.til}`).join(", ")}
                      {vakter.every((v) => !v.publisert) ? " (utkast)" : ""}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="liten dempet">Ingen vakter {valgt === iDag() ? "i dag" : "denne dagen"}.</p>
            )}
          </section>
          {i.borte.length > 0 && (
            <section className="kal-del">
              <h3>Borte ({i.borte.length})</h3>
              <ul className="liste-enkel">
                {i.borte.map((f) => (
                  <li key={f.id}>
                    <span>
                      <span className="tittel">{f.ansatt_navn}</span> <span className="dempet">{fravaerPeriode(f)}</span>
                    </span>
                    <span className={`merke ${fravaerKlasse[f.type]}`}>{fravaerTekst[f.type]}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {i.ledige.length > 0 && (
            <section className="kal-del">
              <h3>Ledige vakter ({i.ledige.length})</h3>
              <ul className="liste-enkel">
                {i.ledige.map((v) => (
                  <li key={v.id}>
                    <span className="tid">
                      {v.fra}–{v.til}
                    </span>
                    <span className="dempet">{v.oppgave ?? ""}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </div>
      <Dialog apen={nyttFravaer} lukk={() => settNyttFravaer(false)} tittel="Registrer fravær">
        {nyttFravaer && (
          <FravaerSkjema
            fravaer={{ fra: valgt, til: valgt }}
            ansatte={ansatte.data ?? []}
            ferdig={(m, berort) => {
              settNyttFravaer(false);
              settMelding(
                berort?.length
                  ? `${m} ${berort.length === 1 ? "Én vakt" : `${berort.length} vakter`} i perioden mangler vikar: ${berort.map((v) => `${visDag(v.dato)} ${v.fra}–${v.til}`).join(", ")}.`
                  : m,
              );
              settVersjon((x) => x + 1);
            }}
            avbryt={() => settNyttFravaer(false)}
          />
        )}
      </Dialog>
      <Dialog apen={!!vikar} lukk={() => settVikar(null)} tittel="Sett inn vikar">
        {vikar && (
          <VikarSkjema
            vakt={vikar}
            ansatte={ansatte.data ?? []}
            fravaer={data.fravaer}
            opptatt={new Map(data.vakter.filter((v) => v.dato === vikar.dato && v.ansatt_id).map((v) => [v.ansatt_id!, `${v.fra}–${v.til}`]))}
            ferdig={(m) => {
              settVikar(null);
              settMelding(m);
              settVersjon((x) => x + 1);
            }}
            avbryt={() => settVikar(null)}
          />
        )}
      </Dialog>
    </>
  );
}
