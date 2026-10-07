// Vaktplan: eier og administrator planlegger uka (tabell på PC, dag for dag på mobil),
// publiserer den og kopierer uker; regnskap ser planen. Ansatte ser sine egne vakter og de
// ledige, som de kan ta, og melder seg syke. Advarslene etter arbeidsmiljøloven (hviletid,
// overtid) kommer fra serveren (server/src/vaktregler.ts). Tavla (Tavle.tsx), kalenderen
// (Bemanning.tsx) og fraværet (Fravaer.tsx) er egne faner.
//
// Fanen står i adressen (?fane=plan|tavle|kalender|fravaer|mine|ledige), uka med mandagen
// (?uke=2026-10-12), dagen på tavla (?dato=2026-10-14) og måneden i kalenderen (?maaned=2026-10).
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, hent } from "../api";
import { Dialog, Feil, Laster, Tom, tall, useData, useHandling, useSmal } from "../felles";
import { erAdmin, kanPersonal, kanSePersonal, useKonto } from "../konto";
import { iDag, leggTilDager } from "../format";
import { IkonKalender, IkonPluss, IkonVarsel } from "../ikoner";
import { gyldigDato, mandag, middag, regnTimer, tallformat, timer, ukedagFormat, ukedager, ukenr, ukePeriode, Ukevelger, visDag } from "../uke";
import { borteTekst, fravaerKlasse, fravaerTekst, FravaerListe, MittFravaer, VikarSkjema, type Fravaer, type FravaerType } from "./Fravaer";
import { iFasen, Tavle } from "./Tavle";
import { Bemanning, gyldigMaaned } from "./Bemanning";

export type Vakt = {
  id: string;
  ansatt_id: string | null;
  ansatt_navn: string | null;
  dato: string;
  fra: string;
  til: string;
  pause_min: number;
  timer: number;
  oppgave: string | null;
  notat: string | null;
  publisert: boolean;
  fort: boolean;
  advarsler: string[];
  // Vikar: vakten dekker for en som er borte (navnet ser bare den som ser hele planen).
  vikar_for: string | null;
  vikar_for_navn: string | null;
  har_vikar: boolean; // en vikar dekker denne vakten
  fravaer: FravaerType | null; // den ansatte er borte den dagen
};
type Ukesum = { ansatt_id: string; fra: string; planlagt: number; avtalt: number | null; advarsler: string[] };
export type VaktSvar = { vakter: Vakt[]; uker: Ukesum[]; upubliserte: number; fravaer: Fravaer[] };
type MinPlass = { dato: string; fase: string; fra: string | null; til: string | null; oppgave: string };
type Ansatt = { id: string; fornavn: string; etternavn: string; ansatt_fra: string; ansatt_til: string | null; aktiv: boolean };

const tid = (v: Pick<Vakt, "fra" | "til">) => `${v.fra}–${v.til}`;
const fornavn = (navn: string) => navn.split(" ")[0];

// Forrige vakt som ble lagret på denne enheten: nye vakter starter med samme tider.
const SIST = "faktura.vakt.sist";
type Sist = { fra: string; til: string; pause_min: number; oppgave: string };
function lesSist(): Sist | null {
  try {
    const v = JSON.parse(localStorage.getItem(SIST) ?? "null");
    return v && typeof v.fra === "string" ? v : null;
  } catch {
    return null;
  }
}
function huskSist(v: Sist) {
  try {
    localStorage.setItem(SIST, JSON.stringify(v));
  } catch {
    /* ikke kritisk */
  }
}

const TITLER: Record<string, string> = {
  plan: "Vaktplan",
  tavle: "Tavle",
  kalender: "Bemanningskalender",
  fravaer: "Fravær",
  mine: "Vakter",
  ledige: "Vakter",
};

export function Vakter() {
  const { org } = useKonto();
  const [sok, settSok] = useSearchParams();
  const [versjon, settVersjon] = useState(0);
  const endret = () => settVersjon((v) => v + 1);
  const seHelePlanen = kanSePersonal(org?.rolle);
  const egen = org?.ansatt_id ?? null;

  // Egne og ledige vakter de neste åtte ukene (for ansatte).
  const fra = iDag();
  const egne = useData(
    () => (egen && org?.personal ? hent<VaktSvar>(`/org/${org.id}/vakter?fra=${fra}&til=${leggTilDager(fra, 55)}`) : Promise.resolve(null)),
    [org?.id, org?.personal, egen, versjon],
  );
  const plasser = useData(
    () => (egen && org?.personal ? hent<MinPlass[]>(`/org/${org.id}/tavle/mine?fra=${fra}&til=${leggTilDager(fra, 55)}`) : Promise.resolve([])),
    [org?.id, org?.personal, egen, versjon],
  );
  const ledige = (egne.data?.vakter ?? []).filter((v) => !v.ansatt_id && v.publisert && v.dato >= fra);

  const faner: [string, ReactNode][] = [];
  if (seHelePlanen) faner.push(["plan", "Vaktplan"], ["tavle", "Tavle"], ["kalender", "Kalender"], ["fravaer", "Fravær"]);
  if (egen)
    faner.push(
      ["mine", "Mine vakter"],
      [
        "ledige",
        <>
          Ledige vakter
          {ledige.length > 0 && <span className="teller">{ledige.length}</span>}
        </>,
      ],
    );
  const fane = faner.find(([v]) => v === sok.get("fane"))?.[0] ?? faner[0]?.[0] ?? null;
  const uke = mandag(gyldigDato(sok.get("uke")) ? sok.get("uke")! : iDag());
  const dato = gyldigDato(sok.get("dato")) ? sok.get("dato")! : iDag();
  const maaned = gyldigMaaned(sok.get("maaned")) ? sok.get("maaned")! : iDag().slice(0, 7);
  const ga = (endring: Record<string, string | null>) => {
    const p = new URLSearchParams(sok);
    for (const [k, v] of Object.entries(endring)) {
      if (v === null) p.delete(k);
      else p.set(k, v);
    }
    settSok(p, { replace: true });
  };

  if (!org?.personal || !fane)
    return (
      <>
        <h1>Vaktplan</h1>
        <div className="kort">
          <Tom ikon={<IkonKalender storrelse={22} />} tittel={!org?.personal ? "Vaktplanen er ikke slått på" : "Du har ingen vakter her"}>
            {!org?.personal && erAdmin(org?.rolle) ? (
              <p>
                Slå på ansatte og timer under <Link to="/innstillinger?fane=personal">Innstillinger → Ansatte og timer</Link>.
              </p>
            ) : (
              <p>Ta kontakt med den som administrerer {org?.navn}.</p>
            )}
          </Tom>
        </div>
      </>
    );

  return (
    <>
      <div className="topp">
        <h1>{TITLER[fane] ?? "Vakter"}</h1>
      </div>
      {faner.length > 1 && (
        <div className="faner tett" role="tablist">
          {faner.map(([v, t]) => (
            <button key={v} type="button" role="tab" aria-selected={fane === v} className={fane === v ? "valgt" : undefined} onClick={() => ga({ fane: v })}>
              {t}
            </button>
          ))}
        </div>
      )}
      {fane === "plan" && <Vaktplan uke={uke} velgUke={(u) => ga({ uke: u === mandag(iDag()) ? null : u })} kanPlanlegge={kanPersonal(org.rolle)} versjon={versjon} endret={endret} />}
      {fane === "tavle" && <Tavle dato={dato} velgDato={(d) => ga({ dato: d === iDag() ? null : d })} kanEndre={kanPersonal(org.rolle)} />}
      {fane === "kalender" && (
        <Bemanning
          maaned={maaned}
          velgMaaned={(m) => ga({ maaned: m === iDag().slice(0, 7) ? null : m })}
          kanEndre={kanPersonal(org.rolle)}
          tilTavle={(d) => ga({ fane: "tavle", dato: d === iDag() ? null : d })}
          tilUke={(m) => ga({ fane: "plan", uke: m === mandag(iDag()) ? null : m })}
        />
      )}
      {fane === "fravaer" && <FravaerListe versjon={versjon} endret={endret} />}
      {fane === "mine" && (
        <MineVakter
          svar={egne.data ?? undefined}
          feil={egne.feil}
          egen={egen!}
          plasser={plasser.data ?? []}
          ledige={ledige.length}
          tilLedige={() => ga({ fane: "ledige" })}
          endret={endret}
        />
      )}
      {fane === "ledige" && <LedigeVakter vakter={egne.data ? ledige : undefined} feil={egne.feil} endret={endret} />}
    </>
  );
}

// --- Planen (eier, administrator og regnskap) -----------------------------------------

function Vaktplan({ uke, velgUke, kanPlanlegge, versjon, endret }: { uke: string; velgUke: (mandag: string) => void; kanPlanlegge: boolean; versjon: number; endret: () => void }) {
  const { org } = useKonto();
  const til = leggTilDager(uke, 6);
  const ansatte = useData(() => hent<Ansatt[]>(`/org/${org!.id}/ansatte`), [org?.id, versjon]);
  const { data, feil } = useData(() => hent<VaktSvar>(`/org/${org!.id}/vakter?fra=${uke}&til=${til}`), [org?.id, uke, versjon]);
  const [apen, settApen] = useState<Partial<Vakt> | null>(null);
  const [vikarFor, settVikarFor] = useState<Vakt | null>(null);
  const [kopierer, settKopierer] = useState(false);
  const [melding, settMelding] = useState<string | null>(null);
  const h = useHandling();
  const smal = useSmal(1099);
  const dager = ukedager(uke);
  const nr = ukenr(uke).uke;
  // Ny uke: ikke vis meldingen eller feilen fra den forrige.
  useEffect(() => {
    settMelding(null);
    h.settFeil(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uke]);

  const publiser = () =>
    h.kjor(async () => {
      const r = await api<{ publisert: number; varslet: number }>("POST", `/org/${org!.id}/vakter/publiser`, { fra: uke, til });
      settMelding(
        `Uke ${nr} er publisert (${r.publisert} ${r.publisert === 1 ? "vakt" : "vakter"}).` +
          (r.varslet ? ` ${r.varslet} ${r.varslet === 1 ? "ansatt har" : "ansatte har"} fått varsel.` : ""),
      );
      endret();
    });
  const kopierForrige = () =>
    h.kjor(async () => {
      const r = await api<{ kopiert: number; hoppet_over: number }>("POST", `/org/${org!.id}/vakter/kopier`, { fra: leggTilDager(uke, -7), til: uke });
      settMelding(kopiMelding(r, `uke ${nr}`));
      endret();
    });

  const verktoy = (
    <div className="uke-verktoy">
      <Ukevelger uke={uke} velgUke={velgUke} />
      {kanPlanlegge && data && (
        <div className="knapper">
          {data.vakter.length > 0 && (
            <button type="button" onClick={() => settKopierer(true)}>
              Kopier uka
            </button>
          )}
          {data.upubliserte > 0 && (
            <button type="button" className="primar" disabled={h.opptatt} onClick={publiser}>
              Publiser ({data.upubliserte})
            </button>
          )}
          <button type="button" className={data.upubliserte > 0 ? undefined : "primar"} onClick={() => settApen({ dato: dager.includes(iDag()) ? iDag() : uke })}>
            <IkonPluss storrelse={18} /> Ny vakt
          </button>
        </div>
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
  if (!data || !ansatte.data)
    return (
      <>
        {verktoy}
        <Laster />
      </>
    );

  // Radene: ansatte i jobb denne uka, og alle som har vakter i den. Ledige vakter øverst.
  const rader = ansatte.data.filter(
    (a) => data.vakter.some((v) => v.ansatt_id === a.id) || (a.aktiv && a.ansatt_fra <= til && (!a.ansatt_til || a.ansatt_til >= uke)),
  );
  const ledige = data.vakter.filter((v) => !v.ansatt_id);
  const sum = (a: string) => data.uker.find((u) => u.ansatt_id === a);
  const advarsler = [
    ...data.vakter.flatMap((v) => v.advarsler.map((t) => ({ hvem: v.ansatt_navn ?? "Ledig vakt", nar: `${visDag(v.dato)} ${tid(v)}`, tekst: t }))),
    ...data.uker.flatMap((u) => {
      const a = ansatte.data!.find((x) => x.id === u.ansatt_id);
      return u.advarsler.map((t) => ({ hvem: a ? `${a.fornavn} ${a.etternavn}` : "", nar: `Uke ${nr}`, tekst: t }));
    }),
  ];
  const nyVakt = (dato: string, ansatt_id: string | null) => kanPlanlegge && settApen({ dato, ansatt_id });
  // Fraværet til en ansatt en dag, og hvor mange som er på jobb (de som er borte, teller ikke).
  const borteDag = (a: string, d: string) => data.fravaer.find((f) => f.ansatt_id === a && f.fra <= d && f.til >= d);
  const paJobb = (d: string) => new Set(data.vakter.filter((v) => v.dato === d && v.ansatt_id && !v.fravaer).map((v) => v.ansatt_id)).size;
  const manglerVikar = (d: string) => data.vakter.filter((v) => v.dato === d && v.ansatt_id && v.fravaer && !v.har_vikar).length;

  const chip = (v: Vakt, medNavn = false) => {
    const mangler = !!v.fravaer && !v.har_vikar;
    return (
      <button
        key={v.id}
        type="button"
        className={`vakt-chip${v.publisert ? "" : " utkast"}${v.advarsler.length ? " advarsel" : ""}${v.fravaer ? " borte" : ""}${mangler ? " mangler" : ""}${v.vikar_for ? " vikar" : ""}`}
        title={
          [
            v.publisert ? "" : "Ikke publisert",
            v.fravaer ? `${fravaerTekst[v.fravaer]}: ${v.har_vikar ? "vikar er satt inn" : "mangler vikar"}` : "",
            v.vikar_for_navn ? `Vikar for ${v.vikar_for_navn}` : "",
            ...v.advarsler,
          ]
            .filter(Boolean)
            .join("\n") || undefined
        }
        onClick={(e) => {
          e.stopPropagation();
          settApen(v);
        }}
      >
        <span className="vakt-tid">
          {v.advarsler.length > 0 && <IkonVarsel storrelse={13} />}
          {tid(v)}
        </span>
        {medNavn && <span className="vakt-navn">{v.ansatt_navn ?? "Ledig vakt"}</span>}
        {v.fravaer ? (
          <span className="vakt-fravaer">
            {fravaerTekst[v.fravaer]} · {v.har_vikar ? "vikar inne" : "mangler vikar"}
          </span>
        ) : (
          v.vikar_for && <span className="vakt-vikar">Vikar{v.vikar_for_navn ? ` for ${fornavn(v.vikar_for_navn)}` : ""}</span>
        )}
        {v.oppgave && <span className="vakt-oppgave">{v.oppgave}</span>}
      </button>
    );
  };

  return (
    <>
      {verktoy}
      {melding && (
        <div className="melding ok" role="status">
          {melding}
        </div>
      )}
      <Feil melding={h.feil} />
      {kanPlanlegge && data.upubliserte > 0 && (
        <p className="liten dempet utkast-info">
          {data.upubliserte === 1 ? "Én vakt" : `${data.upubliserte} vakter`} med stiplet kant er ikke publisert. De ansatte ser dem først når du publiserer.
        </p>
      )}
      {!data.vakter.length ? (
        <div className="kort">
          <Tom ikon={<IkonKalender storrelse={22} />} tittel={`Ingen vakter i uke ${nr}`}>
            {kanPlanlegge ? (
              <>
                <p>Legg inn vakter for de ansatte, eller kopier forrige ukes plan. Vaktene er utkast til du publiserer uka.</p>
                <div className="knapper" style={{ justifyContent: "center" }}>
                  <button type="button" disabled={h.opptatt} onClick={kopierForrige}>
                    Kopier uke {ukenr(leggTilDager(uke, -7)).uke}
                  </button>
                  <button type="button" className="primar" onClick={() => settApen({ dato: dager.includes(iDag()) ? iDag() : uke })}>
                    Ny vakt
                  </button>
                </div>
              </>
            ) : (
              <p>Vaktene vises her når de er planlagt.</p>
            )}
          </Tom>
        </div>
      ) : smal ? (
        <div className="kort liste uke-dager vaktdager">
          {dager.map((d) => {
            const dagens = data.vakter.filter((v) => v.dato === d);
            const borte = data.fravaer.filter((f) => f.fra <= d && f.til >= d);
            const mangler = manglerVikar(d);
            return (
              <section key={d} className={`dag${d === iDag() ? " i-dag" : ""}`} aria-label={visDag(d)}>
                <div className="dag-topp">
                  <span className="dag-navn">{visDag(d)}</span>
                  {dagens.length > 0 && <span className="dag-sum">{paJobb(d)} på jobb</span>}
                  {kanPlanlegge && (
                    <button type="button" className="kopier" aria-label={`Ny vakt ${visDag(d)}`} title="Ny vakt" onClick={() => nyVakt(d, null)}>
                      <IkonPluss storrelse={18} />
                    </button>
                  )}
                </div>
                {(borte.length > 0 || mangler > 0) && (
                  <div className="dag-fravaer">
                    {mangler > 0 && <span className="merke merke-fare">{mangler} mangler vikar</span>}
                    {borte.map((f) => (
                      <span key={f.id} className={`merke ${fravaerKlasse[f.type]}`}>
                        {fornavn(f.ansatt_navn)}: {fravaerTekst[f.type].toLowerCase()}
                      </span>
                    ))}
                  </div>
                )}
                {dagens.length > 0 && <div className="vakt-rad">{dagens.map((v) => chip(v, true))}</div>}
              </section>
            );
          })}
        </div>
      ) : (
        <div className="kort tabell vaktplan">
          <table>
            <thead>
              <tr>
                <th>Ansatt</th>
                {dager.map((d) => (
                  <th key={d} className={d === iDag() ? "i-dag" : undefined}>
                    {ukedagFormat.format(middag(d))} {Number(d.slice(8))}.
                  </th>
                ))}
                <th className="tall">Timer</th>
              </tr>
            </thead>
            <tbody>
              {(ledige.length > 0 || kanPlanlegge) && (
                <tr className="ledige-rad">
                  <td>
                    <strong>Ledige vakter</strong>
                    <span className="liten dempet">Alle ansatte kan ta dem</span>
                  </td>
                  {dager.map((d) => (
                    <td key={d} className={kanPlanlegge ? "ny-vakt" : undefined} onClick={() => nyVakt(d, null)}>
                      {ledige.filter((v) => v.dato === d).map((v) => chip(v))}
                    </td>
                  ))}
                  <td className="tall dempet">{ledige.length ? timer(ledige.reduce((s, v) => s + Number(v.timer), 0)) : ""}</td>
                </tr>
              )}
              {rader.map((a) => {
                const u = sum(a.id);
                return (
                  <tr key={a.id}>
                    <td>
                      {a.fornavn} {a.etternavn}
                    </td>
                    {dager.map((d) => {
                      const vakter = data.vakter.filter((v) => v.ansatt_id === a.id && v.dato === d);
                      const f = vakter.length ? undefined : borteDag(a.id, d);
                      return (
                        <td key={d} className={kanPlanlegge ? "ny-vakt" : undefined} onClick={() => nyVakt(d, a.id)}>
                          {vakter.map((v) => chip(v))}
                          {f && (
                            <span className={`fravaer-dag ${f.type}`} title={`${fravaerTekst[f.type]} ${f.fra === f.til ? visDag(f.fra) : `${visDag(f.fra)}–${visDag(f.til)}`}`}>
                              {fravaerTekst[f.type]}
                            </span>
                          )}
                        </td>
                      );
                    })}
                    <td className={`tall${u?.advarsler.length ? " advarsel-tekst" : ""}`} title={u?.advarsler.join("\n") || undefined}>
                      {u ? tallformat.format(u.planlagt) : "–"}
                      {u?.avtalt != null && <span className="dempet"> / {tallformat.format(u.avtalt)}</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="bemanning-rad">
                <td>På jobb</td>
                {dager.map((d) => (
                  <td key={d}>
                    <strong>{paJobb(d)}</strong>
                    {manglerVikar(d) > 0 && <span className="mangler-tekst">{manglerVikar(d)} mangler vikar</span>}
                  </td>
                ))}
                <td></td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
      {data.vakter.length > 0 && !smal && <p className="liten dempet">Timer: planlagt / avtalt arbeidstid i uka. {kanPlanlegge ? "Trykk i en rute for å legge inn en vakt." : ""}</p>}
      {advarsler.length > 0 && (
        <div className="kort advarsler">
          <h2>
            <IkonVarsel storrelse={18} /> {advarsler.length === 1 ? "Én advarsel" : `${advarsler.length} advarsler`}
          </h2>
          <ul className="liste-enkel">
            {advarsler.map((x, i) => (
              <li key={i}>
                <span>
                  <strong>{x.hvem}</strong> <span className="dempet">{x.nar}</span>
                </span>
                <span>{x.tekst}</span>
              </li>
            ))}
          </ul>
          <p className="liten dempet">
            Arbeidsmiljøloven: minst 11 timer hvile mellom arbeidsdagene og 35 timer sammenhengende fri i uka. Overtid etter grensene under Innstillinger →
            Ansatte og timer.
          </p>
        </div>
      )}
      <Dialog apen={!!apen} lukk={() => settApen(null)} tittel={apen?.id ? (kanPlanlegge ? "Endre vakt" : "Vakt") : "Ny vakt"}>
        {apen && (
          <VaktSkjema
            vakt={apen}
            ansatte={ansatte.data}
            oppgaver={[...new Set(data.vakter.map((v) => v.oppgave).filter((o): o is string => !!o))]}
            kanEndre={kanPlanlegge}
            ferdig={(tekst) => {
              settApen(null);
              settMelding(tekst ?? null);
              endret();
            }}
            avbryt={() => settApen(null)}
            settInnVikar={(v) => {
              settApen(null);
              settVikarFor(v);
            }}
          />
        )}
      </Dialog>
      <Dialog apen={!!vikarFor} lukk={() => settVikarFor(null)} tittel="Sett inn vikar">
        {vikarFor && (
          <VikarSkjema
            vakt={vikarFor}
            ansatte={ansatte.data}
            fravaer={data.fravaer}
            opptatt={new Map(data.vakter.filter((v) => v.dato === vikarFor.dato && v.ansatt_id).map((v) => [v.ansatt_id!, tid(v)]))}
            ferdig={(tekst) => {
              settVikarFor(null);
              settMelding(tekst);
              endret();
            }}
            avbryt={() => settVikarFor(null)}
          />
        )}
      </Dialog>
      <Dialog apen={kopierer} lukk={() => settKopierer(false)} tittel={`Kopier uke ${nr}`}>
        <KopierSkjema
          uke={uke}
          ferdig={(tekst) => {
            settKopierer(false);
            settMelding(tekst);
            endret();
          }}
          avbryt={() => settKopierer(false)}
        />
      </Dialog>
    </>
  );
}

const kopiMelding = (r: { kopiert: number; hoppet_over: number }, hvor: string) =>
  `${r.kopiert ? `Kopierte ${r.kopiert} ${r.kopiert === 1 ? "vakt" : "vakter"} til ${hvor}, som utkast.` : "Ingen nye vakter å kopiere."}` +
  (r.hoppet_over ? ` ${r.hoppet_over} ble hoppet over (finnes fra før, eller den ansatte er ikke ansatt da).` : "");

function KopierSkjema({ uke, ferdig, avbryt }: { uke: string; ferdig: (tekst: string) => void; avbryt: () => void }) {
  const { org } = useKonto();
  const [antall, settAntall] = useState("1");
  const h = useHandling();
  const n = Math.min(12, Math.max(1, Math.round(tall(antall)) || 1));
  const forste = leggTilDager(uke, 7);
  async function kopier(e: FormEvent) {
    e.preventDefault();
    const r = await h.kjor(() => api<{ kopiert: number; hoppet_over: number }>("POST", `/org/${org!.id}/vakter/kopier`, { fra: uke, til: forste, antall: n }));
    if (r) ferdig(kopiMelding(r, n === 1 ? `uke ${ukenr(forste).uke}` : `uke ${ukenr(forste).uke}–${ukenr(leggTilDager(forste, 7 * (n - 1))).uke}`));
  }
  return (
    <form onSubmit={kopier}>
      <p className="dempet" style={{ marginTop: 0 }}>
        Vaktene i uke {ukenr(uke).uke} kopieres til uka etter, som utkast. Vakter som finnes fra før, og ansatte som ikke er ansatt da, hoppes over.
      </p>
      <label>
        Antall uker framover
        <input inputMode="numeric" value={antall} onChange={(e) => settAntall(e.target.value)} />
        <span className="felt-hjelp">
          {n === 1 ? `Til uke ${ukenr(forste).uke} (${ukePeriode(forste)}).` : `Til uke ${ukenr(forste).uke}–${ukenr(leggTilDager(forste, 7 * (n - 1))).uke}.`} Høyst 12.
        </span>
      </label>
      <Feil melding={h.feil} />
      <div className="knapper">
        <button className="primar" disabled={h.opptatt}>
          Kopier
        </button>
        <button type="button" onClick={avbryt}>
          Avbryt
        </button>
      </div>
    </form>
  );
}

function VaktSkjema({
  vakt,
  ansatte,
  oppgaver,
  kanEndre,
  ferdig,
  avbryt,
  settInnVikar,
}: {
  vakt: Partial<Vakt>;
  ansatte: Ansatt[];
  oppgaver: string[];
  kanEndre: boolean;
  ferdig: (melding?: string) => void;
  avbryt: () => void;
  settInnVikar: (v: Vakt) => void;
}) {
  const { org } = useKonto();
  const [v, settV] = useState(() => {
    const sist = vakt.id ? null : lesSist();
    return {
      ansatt_id: vakt.ansatt_id ?? "",
      dato: vakt.dato ?? iDag(),
      fra: vakt.fra ?? sist?.fra ?? "",
      til: vakt.til ?? sist?.til ?? "",
      pause: String(vakt.pause_min ?? sist?.pause_min ?? 0),
      oppgave: vakt.oppgave ?? sist?.oppgave ?? "",
      notat: vakt.notat ?? "",
    };
  });
  const h = useHandling();
  const sett = (e: Partial<typeof v>) => settV({ ...v, ...e });
  const pause = v.pause.trim() === "" ? 0 : tall(v.pause);
  const klokke = (s: string) => /^\d{2}:\d{2}$/.test(s);
  const utregnet = klokke(v.fra) && klokke(v.til) && v.fra !== v.til && Number.isFinite(pause) ? regnTimer(v.fra, v.til, pause) : null;
  // Ansatte som kan settes på vakten: aktive og ansatt den dagen (og den som har den nå).
  const valg = ansatte.filter((a) => a.id === vakt.ansatt_id || (a.aktiv && a.ansatt_fra <= v.dato && (!a.ansatt_til || a.ansatt_til >= v.dato)));

  async function lagre(e: FormEvent) {
    e.preventDefault();
    const kropp = {
      ansatt_id: v.ansatt_id || null,
      dato: v.dato,
      fra: v.fra,
      til: v.til,
      pause_min: Math.round(pause),
      oppgave: v.oppgave.trim() || null,
      notat: v.notat.trim() || null,
    };
    const r = await h.kjor(() => (vakt.id ? api("PATCH", `/org/${org!.id}/vakter/${vakt.id}`, kropp) : api("POST", `/org/${org!.id}/vakter`, kropp)));
    if (!r) return;
    huskSist({ fra: v.fra, til: v.til, pause_min: Math.round(pause), oppgave: v.oppgave.trim() });
    ferdig(vakt.publisert && vakt.ansatt_id ? "Vakten er endret, og den ansatte har fått beskjed." : undefined);
  }

  async function slett() {
    if (!confirm(`Slette vakten ${visDag(vakt.dato!)} ${tid(vakt as Vakt)}?${vakt.publisert && vakt.ansatt_id ? " Den ansatte får beskjed." : ""}`)) return;
    const r = await h.kjor(async () => (await api("DELETE", `/org/${org!.id}/vakter/${vakt.id}`), true));
    if (r) ferdig("Vakten er slettet.");
  }

  return (
    <form onSubmit={lagre}>
      {vakt.id && (
        <p className={`liten vakt-status${vakt.publisert ? "" : " utkast"}`}>
          {vakt.publisert ? "Publisert. Endringer varsles til den ansatte." : "Ikke publisert ennå. Den ansatte ser vakten når uka publiseres."}
          {vakt.fort ? " Timene er ført fra vakten." : ""}
          {vakt.vikar_for_navn ? ` Vikar for ${vakt.vikar_for_navn}.` : ""}
        </p>
      )}
      {vakt.id && vakt.fravaer && (
        <div className={`melding ${vakt.har_vikar ? "info" : "feil"} vikar-info`}>
          <span>
            {vakt.ansatt_navn} {borteTekst[vakt.fravaer]} denne dagen. {vakt.har_vikar ? "Vikar er satt inn." : "Vakten mangler vikar."}
          </span>
          {!vakt.har_vikar && kanEndre && (
            <button type="button" className="primar" onClick={() => settInnVikar(vakt as Vakt)}>
              Sett inn vikar
            </button>
          )}
        </div>
      )}
      {(vakt.advarsler ?? []).length > 0 && (
        <div className="melding advarsel">
          {(vakt.advarsler ?? []).map((t) => (
            <div key={t}>{t}</div>
          ))}
        </div>
      )}
      <fieldset className="naken" disabled={!kanEndre}>
        <label>
          Ansatt
          <select value={v.ansatt_id} onChange={(e) => sett({ ansatt_id: e.target.value })}>
            <option value="">Ledig vakt (alle ansatte kan ta den)</option>
            {valg.map((a) => (
              <option key={a.id} value={a.id}>
                {a.fornavn} {a.etternavn}
              </option>
            ))}
          </select>
        </label>
        <label>
          Dato
          <input type="date" required value={v.dato} onChange={(e) => sett({ dato: e.target.value })} />
        </label>
        <div className="rad tre">
          <label>
            Fra
            <input type="time" required value={v.fra} onChange={(e) => sett({ fra: e.target.value })} />
          </label>
          <label>
            Til
            <input type="time" required value={v.til} onChange={(e) => sett({ til: e.target.value })} />
          </label>
          <label>
            Pause (min)
            <input inputMode="numeric" value={v.pause} onChange={(e) => sett({ pause: e.target.value })} />
          </label>
        </div>
        <p className="utregnet" aria-live="polite">
          {v.fra && v.fra === v.til
            ? "Fra og til kan ikke være like."
            : utregnet === null
              ? " "
              : utregnet > 0
                ? `= ${timer(utregnet)}${v.til < v.fra ? " (over midnatt)" : ""}`
                : "Pausen er like lang som vakten."}
        </p>
        <label>
          Oppgave eller avdeling
          <input list="vakt-oppgaver" maxLength={60} placeholder="F.eks. Kasse eller Lager (valgfritt)" value={v.oppgave} onChange={(e) => sett({ oppgave: e.target.value })} />
          <datalist id="vakt-oppgaver">
            {oppgaver.map((o) => (
              <option key={o} value={o} />
            ))}
          </datalist>
        </label>
        <label>
          Notat til den ansatte
          <textarea rows={2} maxLength={500} value={v.notat} onChange={(e) => sett({ notat: e.target.value })} />
        </label>
      </fieldset>
      <Feil melding={h.feil} />
      <div className="knapper">
        {kanEndre && (
          <button className="primar" disabled={h.opptatt}>
            Lagre
          </button>
        )}
        <button type="button" onClick={avbryt}>
          {kanEndre ? "Avbryt" : "Lukk"}
        </button>
        {vakt.id && kanEndre && (
          <button type="button" className="fare" style={{ marginLeft: "auto" }} disabled={h.opptatt} onClick={slett}>
            Slett
          </button>
        )}
      </div>
    </form>
  );
}

// --- For den ansatte --------------------------------------------------------------------

function MineVakter({
  svar,
  feil,
  egen,
  plasser,
  ledige,
  tilLedige,
  endret,
}: {
  svar?: VaktSvar;
  feil: string | null;
  egen: string;
  plasser: MinPlass[];
  ledige: number;
  tilLedige: () => void;
  endret: () => void;
}) {
  if (feil) return <Feil melding={feil} />;
  if (!svar) return <Laster />;
  const mine = svar.vakter.filter((v) => v.ansatt_id === egen && v.publisert);
  const uker = new Map<string, Vakt[]>();
  for (const v of mine) uker.set(mandag(v.dato), [...(uker.get(mandag(v.dato)) ?? []), v]);
  // Plassene på tavla som hører til vakten (fasene vakten overlapper).
  const plassTekst = (v: Vakt) =>
    plasser
      .filter((p) => p.dato === v.dato && iFasen(v, { id: "", navn: p.fase, fra: p.fra, til: p.til }))
      .map((p) => `${p.fase}: ${p.oppgave}`)
      .join(" · ");
  return (
    <>
      <MittFravaer fravaer={svar.fravaer.filter((f) => f.ansatt_id === egen)} endret={endret} />
      {ledige > 0 && (
        <div className="melding info venter">
          <span>{ledige === 1 ? "Én ledig vakt" : `${ledige} ledige vakter`} de neste ukene.</span>
          <button type="button" className="lenke" onClick={tilLedige}>
            Se {ledige === 1 ? "den" : "dem"}
          </button>
        </div>
      )}
      {!mine.length ? (
        <div className="kort">
          <Tom ikon={<IkonKalender storrelse={22} />} tittel="Ingen vakter de neste ukene">
            <p>Du får varsel når vaktplanen er publisert.</p>
          </Tom>
        </div>
      ) : (
        [...uker.entries()].map(([m, vakter]) => (
          <div key={m} className="kort liste mine-vakter">
            <div className="mine-vakter-topp">
              <strong>Uke {ukenr(m).uke}</strong>
              <span className="dempet">{ukePeriode(m)}</span>
              <span className="tall">{timer(vakter.filter((v) => !v.fravaer).reduce((s, v) => s + Number(v.timer), 0))}</span>
            </div>
            {vakter.map((v) => {
              const plass = v.fravaer ? "" : plassTekst(v);
              return (
                <div key={v.id} className={`liste-rad statisk${v.dato === iDag() ? " i-dag" : ""}${v.fravaer ? " borte" : ""}`}>
                  <span className="linje">
                    <span className="tittel">
                      {visDag(v.dato)} · <span className="vakt-tid-tekst">{tid(v)}</span>
                    </span>
                    {v.fravaer ? <span className={`merke ${fravaerKlasse[v.fravaer]}`}>{fravaerTekst[v.fravaer]}</span> : <span className="belop">{timer(v.timer)}</span>}
                  </span>
                  {plass && <span className="under plass">{plass}</span>}
                  {(v.oppgave || v.notat || v.fort) && !v.fravaer && (
                    <span className="linje">
                      <span className="under">{[v.oppgave, v.notat].filter(Boolean).join(" · ")}</span>
                      {v.fort ? (
                        <span className="merke merke-ok">Ført</span>
                      ) : (
                        v.dato <= iDag() && (
                          <Link className="liten" to={`/timer?uke=${mandag(v.dato)}`}>
                            Før timer
                          </Link>
                        )
                      )}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        ))
      )}
    </>
  );
}

function LedigeVakter({ vakter, feil, endret }: { vakter?: Vakt[]; feil: string | null; endret: () => void }) {
  const { org } = useKonto();
  const h = useHandling();
  const [melding, settMelding] = useState<string | null>(null);
  if (feil) return <Feil melding={feil} />;
  if (!vakter) return <Laster />;
  const ta = (v: Vakt) =>
    h.kjor(async () => {
      if (!confirm(`Ta vakten ${visDag(v.dato)} ${tid(v)}?`)) return;
      await api("POST", `/org/${org!.id}/vakter/${v.id}/ta`);
      settMelding(`Vakten ${visDag(v.dato)} ${tid(v)} er din.`);
      endret();
    });
  return (
    <>
      {melding && (
        <div className="melding ok" role="status">
          {melding}
        </div>
      )}
      <Feil melding={h.feil} />
      {!vakter.length ? (
        <div className="kort">
          <Tom ikon={<IkonKalender storrelse={22} />} tittel="Ingen ledige vakter nå">
            <p>Du får varsel når det kommer ledige vakter.</p>
          </Tom>
        </div>
      ) : (
        <div className="kort liste">
          {vakter.map((v) => (
            <div key={v.id} className="liste-rad statisk ledig-vakt">
              <span className="linje">
                <span className="tittel">
                  {visDag(v.dato)} · {tid(v)}
                </span>
                <button type="button" className="primar" disabled={h.opptatt} onClick={() => ta(v)}>
                  Ta vakten
                </button>
              </span>
              <span className="under">{[timer(v.timer), v.oppgave, v.notat].filter(Boolean).join(" · ")}</span>
            </div>
          ))}
        </div>
      )}
      <p className="liten dempet">Den første som tar en ledig vakt, får den. Du kan ikke ta en vakt som overlapper en av dine egne.</p>
    </>
  );
}
