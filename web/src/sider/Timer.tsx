// Timer: den ansatte fører timene sine og leverer uka; eier og administrator godkjenner eller
// avviser og ser alle ansattes uker (regnskap ser dem også). Overtiden regnes av serveren
// (server/src/arbeidstid.ts) etter grensene under Innstillinger → Ansatte og timer.
//
// Fanen står i adressen (?fane=mine|alle|godkjenning), uka med mandagen (?uke=2026-10-05),
// og den ansatte man ser på under «Alle ansatte» med ?ansatt=.
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, hent } from "../api";
import { Dialog, Feil, Laster, Tom, tall, useData, useHandling, useSmal } from "../felles";
import { erAdmin, harFunksjon, kanPersonal, kanSePersonal, useKonto } from "../konto";
import { dato, iDag, leggTilDager } from "../format";
import { IkonHake, IkonKlokke, IkonPluss, IkonVenstre } from "../ikoner";
import { gyldigDato, Klokkeslett, mandag, middag, regnTimer, tallformat, timer, ukedagFormat, ukenr, ukePeriode, Ukevelger, visDag } from "../uke";
import type { VaktSvar } from "./Vakter";
import { fastTid } from "./Arbeidsplan";
import { fravaerKlasse, fravaerTekst } from "./Fravaer";

type Status = "utkast" | "levert" | "godkjent" | "avvist";

type Foring = {
  id: string;
  ansatt_id: string;
  ansatt_navn: string;
  dato: string;
  fra: string | null;
  til: string | null;
  pause_min: number;
  timer: number;
  overtid_prosent: number | null;
  beskrivelse: string | null;
  status: Status;
  avvist_grunn: string | null;
  levert_at: string | null;
  godkjent_at: string | null;
  vakt_id?: string | null;
};

type Uke = {
  ansatt_id: string;
  ansatt_navn: string;
  aar: number;
  uke: number;
  fra: string;
  til: string;
  ordinare: number;
  overtid: { prosent: number; timer: number }[];
  merarbeid: number;
  sum: number;
  status: Status;
  antall: number;
  antall_status: Record<Status, number>;
  planlagt: number | null; // publiserte vakter i uka
};

type Regler = { aktiv: boolean; daglig_grense: number; ukentlig_grense: number; overtid_prosent: number };
type TimerSvar = { regler: Regler; foringer: Foring[]; uker: Uke[] };
type Ansatt = {
  id: string;
  ansattnummer: number;
  fornavn: string;
  etternavn: string;
  stilling: string | null;
  ansatt_fra: string;
  ansatt_til: string | null;
  aktiv: boolean;
};

const statusMerke: Record<Status, { tekst: string; klasse: string }> = {
  utkast: { tekst: "Ikke levert", klasse: "merke-noytral" },
  levert: { tekst: "Levert", klasse: "merke-info" },
  godkjent: { tekst: "Godkjent", klasse: "merke-ok" },
  avvist: { tekst: "Avvist", klasse: "merke-fare" },
};

const antallForinger = (n: number) => `${n} ${n === 1 ? "føring" : "føringer"}`;

// Forrige føring fra denne enheten: nye føringer starter med samme tider.
const SIST = "faktura.timer.sist";
type Sist = { modus: "tid" | "timer"; fra: string; til: string; pause_min: number };
function lesSist(): Sist | null {
  try {
    const v = JSON.parse(localStorage.getItem(SIST) ?? "null");
    return v && (v.modus === "tid" || v.modus === "timer") ? v : null;
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

// --- Siden ------------------------------------------------------------------------

export function Timer() {
  const { org } = useKonto();
  const [sok, settSok] = useSearchParams();
  const [versjon, settVersjon] = useState(0);
  const endret = () => settVersjon((v) => v + 1);
  const egen = org?.ansatt_id ?? null;
  const personal = kanPersonal(org?.rolle);
  const seAlle = kanSePersonal(org?.rolle);

  // Ukene som venter på godkjenning (det siste året): til fanen og tallet på den.
  const venter = useData(
    () =>
      personal && org?.personal
        ? hent<TimerSvar>(`/org/${org.id}/timer?fra=${leggTilDager(iDag(), -366)}&til=${leggTilDager(iDag(), 62)}&status=levert`)
        : Promise.resolve(null),
    [org?.id, org?.personal, personal, versjon],
  );
  const antallVenter = venter.data?.uker.length ?? 0;

  const faner: [string, ReactNode][] = [];
  if (egen) faner.push(["mine", "Mine timer"]);
  if (seAlle) faner.push(["alle", "Alle ansatte"]);
  if (personal)
    faner.push([
      "godkjenning",
      <>
        Til godkjenning
        {antallVenter > 0 && <span className="teller">{antallVenter}</span>}
      </>,
    ]);
  const fane = faner.find(([v]) => v === sok.get("fane"))?.[0] ?? (seAlle ? "alle" : egen ? "mine" : null);
  const uke = mandag(gyldigDato(sok.get("uke")) ? sok.get("uke")! : iDag());
  const valgt = sok.get("ansatt");

  const ga = (endring: Record<string, string | null>) => {
    const p = new URLSearchParams(sok);
    for (const [k, v] of Object.entries(endring)) {
      if (v === null) p.delete(k);
      else p.set(k, v);
    }
    settSok(p, { replace: true });
  };
  const velgUke = (u: string) => ga({ uke: u === mandag(iDag()) ? null : u });

  if (!org?.personal || !fane)
    return (
      <>
        <h1>Timer</h1>
        <div className="kort">
          <Tom ikon={<IkonKlokke storrelse={22} />} tittel={!org?.personal ? "Timeføringen er ikke slått på" : "Du fører ikke timer her"}>
            {!org?.personal && erAdmin(org?.rolle) ? (
              <p>
                Slå den på under <Link to="/innstillinger?fane=personal">Innstillinger → Ansatte og timer</Link>.
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
        <h1>Timer</h1>
      </div>
      {faner.length > 1 && (
        <div className="faner tett" role="tablist">
          {faner.map(([v, t]) => (
            <button key={v} type="button" role="tab" aria-selected={fane === v} className={fane === v ? "valgt" : undefined} onClick={() => ga({ fane: v, ansatt: null })}>
              {t}
            </button>
          ))}
        </div>
      )}
      {fane === "mine" && egen && <Ukeside key={egen} ansattId={egen} uke={uke} velgUke={velgUke} egen personal={personal} versjon={versjon} endret={endret} />}
      {fane === "alle" &&
        (valgt ? (
          <Ukeside
            key={valgt}
            ansattId={valgt}
            uke={uke}
            velgUke={velgUke}
            egen={valgt === egen}
            personal={personal}
            versjon={versjon}
            endret={endret}
            tilbake={() => ga({ ansatt: null })}
          />
        ) : (
          <Ukeoversikt
            uke={uke}
            velgUke={velgUke}
            apne={(id) => ga({ ansatt: id })}
            versjon={versjon}
            venter={antallVenter}
            tilGodkjenning={personal ? () => ga({ fane: "godkjenning", ansatt: null }) : undefined}
          />
        ))}
      {fane === "godkjenning" && (
        <Godkjenning svar={venter.data ?? undefined} feil={venter.feil} endret={endret} apne={(id, u) => ga({ fane: "alle", ansatt: id, uke: u })} />
      )}
    </>
  );
}

// Delene av ukesummen: ordinære timer, overtid per tillegg og merarbeid.
function Summer({ u }: { u?: Pick<Uke, "ordinare" | "overtid" | "merarbeid"> }) {
  return (
    <div className="summer">
      <div>
        <span>Ordinære timer</span>
        <span className="tall">{timer(u?.ordinare ?? 0)}</span>
      </div>
      {(u?.overtid ?? []).map((o) => (
        <div key={o.prosent}>
          <span>Overtid {o.prosent} %</span>
          <span className="tall">{timer(o.timer)}</span>
        </div>
      ))}
      {!!u?.merarbeid && (
        <div title="Timer ut over avtalt arbeidstid (deltid) som ikke er overtid">
          <span>Merarbeid</span>
          <span className="tall">{timer(u.merarbeid)}</span>
        </div>
      )}
    </div>
  );
}

// Én ansatts uke: dagene med føringene, summen, og levering eller godkjenning.
function Ukeside({
  ansattId,
  uke,
  velgUke,
  egen,
  personal,
  versjon,
  endret,
  tilbake,
}: {
  ansattId: string;
  uke: string;
  velgUke: (mandag: string) => void;
  egen: boolean;
  personal: boolean;
  versjon: number;
  endret: () => void;
  tilbake?: () => void;
}) {
  const { org } = useKonto();
  const til = leggTilDager(uke, 6);
  const ansatt = useData(() => hent<Ansatt>(`/org/${org!.id}/ansatte/${ansattId}`), [org?.id, ansattId, versjon]);
  const { data, feil } = useData(() => hent<TimerSvar>(`/org/${org!.id}/timer?fra=${uke}&til=${til}&ansatt=${ansattId}`), [org?.id, ansattId, uke, versjon]);
  // Vaktene, de faste dagene og fraværet (med vaktplanen slått på for organisasjonen).
  const vaktsvar = useData(
    () => (harFunksjon(org, "vaktplan") ? hent<VaktSvar>(`/org/${org!.id}/vakter?fra=${uke}&til=${til}&ansatt=${ansattId}`) : Promise.resolve(null)),
    [org?.id, ansattId, uke, versjon],
  );
  const vakter = (vaktsvar.data?.vakter ?? []).filter((v) => v.publisert);
  // De faste arbeidsdagene etter arbeidsplanen (dager uten vakt).
  const faste = (vaktsvar.data?.faste ?? []).filter((f) => f.ansatt_id === ansattId);
  // Vakter og faste dager den ansatte er borte fra, er ikke planlagt arbeid.
  const iArbeid = vakter.filter((v) => !v.fravaer);
  const fasteIArbeid = faste.filter((f) => !f.fravaer);
  const planlagt = [...iArbeid, ...fasteIArbeid].reduce((s, v) => s + Number(v.timer), 0);
  const fravaer = vaktsvar.data?.fravaer ?? [];
  const [apen, settApen] = useState<Partial<Foring> | null>(null);
  const [avviser, settAvviser] = useState(false);
  const [melding, settMelding] = useState<string | null>(null);
  const h = useHandling();
  useEffect(() => {
    settMelding(null);
    h.settFeil(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uke, ansattId]);

  const a = ansatt.data;
  const foringer = data?.foringer ?? [];
  const sum = data?.uker.find((u) => u.ansatt_id === ansattId && u.fra === uke);
  const ikkeLevert = foringer.filter((f) => f.status === "utkast" || f.status === "avvist");
  const levert = foringer.filter((f) => f.status === "levert");
  const godkjent = foringer.filter((f) => f.status === "godkjent");
  const avvist = foringer.find((f) => f.status === "avvist");
  const iDagIso = iDag();
  const ansattDag = (d: string) => !!a && d >= a.ansatt_fra && (!a.ansatt_til || d <= a.ansatt_til);
  // Den ansatte fører sine egne timer så lenge den er aktiv; eier og administrator alltid.
  const kanFore = !!a && (personal || (egen && a.aktiv));
  // Endre en føring: eier og administrator alltid, den ansatte selv før den er levert (eller når
  // den er avvist). Regnskap ser bare.
  const kanEndre = (f: Partial<Foring>) => personal || (kanFore && (!f.id || f.status === "utkast" || f.status === "avvist"));
  const nr = ukenr(uke).uke;

  const lever = () =>
    h.kjor(async () => {
      await api("POST", `/org/${org!.id}/timer/lever`, { ansatt_id: ansattId, fra: uke, til });
      settMelding(egen ? `Uke ${nr} er levert. Du får beskjed når timene er godkjent.` : `Uke ${nr} er levert for ${a?.fornavn}.`);
      endret();
    });
  const godkjenn = () =>
    h.kjor(async () => {
      await api("POST", `/org/${org!.id}/timer/godkjenn`, { ider: levert.map((f) => f.id) });
      settMelding(`Uke ${nr} er godkjent.`);
      endret();
    });

  if (feil || ansatt.feil) return <Feil melding={feil ?? ansatt.feil} />;
  if (!data || !a) return <Laster />;

  const nyFra = ansattDag(iDagIso) && iDagIso >= uke && iDagIso <= til ? iDagIso : [0, 1, 2, 3, 4, 5, 6].map((i) => leggTilDager(uke, i)).find(ansattDag);

  return (
    <>
      {tilbake && (
        <div className="ansatt-topp">
          <button type="button" className="lenke" onClick={tilbake}>
            <IkonVenstre storrelse={16} /> Alle ansatte
          </button>
          <h2>
            {a.fornavn} {a.etternavn}
          </h2>
          <span className="dempet">
            Nr. {a.ansattnummer}
            {a.stilling ? ` · ${a.stilling}` : ""}
            {!a.aktiv ? " · ikke aktiv" : ""}
          </span>
        </div>
      )}
      <div className="uke-verktoy">
        <Ukevelger uke={uke} velgUke={velgUke} />
        {kanFore && nyFra && (
          <button type="button" className="primar" onClick={() => settApen({ dato: nyFra })}>
            <IkonPluss storrelse={18} /> Før timer
          </button>
        )}
      </div>
      {egen && !a.aktiv && <div className="melding info">Du er ikke lenger registrert som aktiv ansatt og kan ikke føre nye timer.</div>}
      {avvist && (
        <div className="melding feil" role="status">
          <strong>Timene ble avvist.</strong> {avvist.avvist_grunn} {egen ? "Rett dem og lever på nytt." : ""}
        </div>
      )}
      {melding && (
        <div className="melding ok" role="status">
          {melding}
        </div>
      )}
      <Feil melding={h.feil} />
      <div className="uke-rad">
        <div className="kort ukesum">
          <div className="ukesum-topp">
            <h2>Uke {nr}</h2>
            <strong>{timer(sum?.sum ?? 0)}</strong>
          </div>
          {iArbeid.length + fasteIArbeid.length > 0 && (
            <p className="liten dempet planlagt">
              Planlagt: {timer(Math.round(planlagt * 100) / 100)} (
              {[
                iArbeid.length ? `${iArbeid.length} ${iArbeid.length === 1 ? "vakt" : "vakter"}` : "",
                fasteIArbeid.length ? `${fasteIArbeid.length} ${fasteIArbeid.length === 1 ? "fast dag" : "faste dager"}` : "",
              ]
                .filter(Boolean)
                .join(" og ")}
              )
            </p>
          )}
          <Summer u={sum} />
          {!ikkeLevert.length && levert.length > 0 && <p className="ukestatus info">Levert, venter på godkjenning.</p>}
          {!ikkeLevert.length && !levert.length && godkjent.length > 0 && <p className="ukestatus ok">Godkjent.</p>}
          <div className="knapper">
            {ikkeLevert.length > 0 && (egen || personal) && (
              <button type="button" className="primar" disabled={h.opptatt} onClick={lever}>
                {egen ? `Lever uke ${nr}` : `Lever for ${a.fornavn}`}
              </button>
            )}
            {personal && levert.length > 0 && (
              <button type="button" className="primar" disabled={h.opptatt} onClick={godkjenn}>
                Godkjenn
              </button>
            )}
            {personal && levert.length + godkjent.length > 0 && (
              <button type="button" className="fare" disabled={h.opptatt} onClick={() => settAvviser(true)}>
                Avvis
              </button>
            )}
          </div>
          {ikkeLevert.length > 0 && egen && <p className="liten dempet">Når uka er levert, kan timene ikke endres før de eventuelt blir avvist.</p>}
        </div>
        <div className="kort liste uke-dager">
          {[0, 1, 2, 3, 4, 5, 6].map((i) => {
            const d = leggTilDager(uke, i);
            const dagens = foringer.filter((f) => f.dato === d);
            const sumDag = dagens.reduce((s, f) => s + Number(f.timer), 0);
            const borte = fravaer.find((f) => f.ansatt_id === ansattId && f.fra <= d && f.til >= d)?.type;
            return (
              <section key={d} className={`dag${d === iDagIso ? " i-dag" : ""}`} aria-label={visDag(d)}>
                <div className="dag-topp">
                  <span className="dag-navn">{visDag(d)}</span>
                  {borte && <span className={`merke ${fravaerKlasse[borte]}`}>{fravaerTekst[borte]}</span>}
                  {sumDag > 0 && <span className="dag-sum">{timer(sumDag)}</span>}
                  {kanFore && ansattDag(d) && (
                    <button type="button" className="kopier" aria-label={`Før timer ${visDag(d)}`} title="Før timer" onClick={() => settApen({ dato: d })}>
                      <IkonPluss storrelse={18} />
                    </button>
                  )}
                </div>
                {vakter
                  .filter((v) => v.dato === d)
                  .map((v) => {
                    const fort = v.fort || foringer.some((f) => f.vakt_id === v.id);
                    // Timer føres fra vakten når den har vært (eller er i dag), og ikke er ført
                    // på annen måte samme dag.
                    const kanForeFraVakt = kanFore && ansattDag(d) && d <= iDagIso && !borte && !dagens.some((f) => !f.vakt_id);
                    return (
                      <div key={v.id} className="vakt-linje">
                        <span>
                          <span className="vakt-merke">Vakt</span> {v.fra}–{v.til}
                          {v.oppgave && <span className="dempet"> · {v.oppgave}</span>}
                        </span>
                        {fort ? (
                          <span className="merke merke-ok">Ført</span>
                        ) : (
                          kanForeFraVakt && (
                            <button
                              type="button"
                              className="lenke"
                              onClick={() => settApen({ dato: v.dato, fra: v.fra, til: v.til, pause_min: v.pause_min, beskrivelse: v.oppgave, vakt_id: v.id })}
                            >
                              Før timer
                            </button>
                          )
                        )}
                      </div>
                    );
                  })}
                {faste
                  .filter((x) => x.dato === d)
                  .map((x) => (
                    // Fast arbeidsdag: timene føres etter planen (klokkeslettene, eller antall timer
                    // for en hel dag), med mindre noe allerede er ført den dagen.
                    <div key={`fast-${d}`} className="vakt-linje">
                      <span>
                        <span className="vakt-merke">Fast</span> {fastTid(x)}
                        {!x.fra && <span className="dempet"> · {timer(x.timer)}</span>}
                      </span>
                      {dagens.length > 0 ? (
                        <span className="merke merke-ok">Ført</span>
                      ) : (
                        kanFore &&
                        ansattDag(d) &&
                        d <= iDagIso &&
                        !borte && (
                          <button
                            type="button"
                            className="lenke"
                            onClick={() => settApen(x.fra && x.til ? { dato: d, fra: x.fra, til: x.til, pause_min: x.pause_min } : { dato: d, timer: x.timer })}
                          >
                            Før timer
                          </button>
                        )
                      )}
                    </div>
                  ))}
                {dagens.map((f) => (
                  <button key={f.id} type="button" className="foring" onClick={() => settApen(f)}>
                    <span className="linje">
                      <span className="tid">
                        {f.fra ? `${f.fra}–${f.til}` : <span className="dempet">Antall timer</span>}
                        {f.pause_min > 0 && <span className="dempet"> · {f.pause_min} min pause</span>}
                      </span>
                      <span className="belop">{timer(f.timer)}</span>
                    </span>
                    {(f.beskrivelse || f.overtid_prosent || f.status !== "utkast") && (
                      <span className="linje">
                        <span className="under">{f.beskrivelse}</span>
                        <span className="merker">
                          {f.overtid_prosent && <span className="merke merke-advarsel">Overtid {f.overtid_prosent} %</span>}
                          {f.status !== "utkast" && <span className={`merke ${statusMerke[f.status].klasse}`}>{statusMerke[f.status].tekst}</span>}
                        </span>
                      </span>
                    )}
                  </button>
                ))}
              </section>
            );
          })}
        </div>
      </div>
      <p className="liten dempet regler">
        Overtid: over {tallformat.format(data.regler.daglig_grense)} timer per dag eller {tallformat.format(data.regler.ukentlig_grense)} per uke, med{" "}
        {data.regler.overtid_prosent} % tillegg.
      </p>
      <Dialog apen={!!apen} lukk={() => settApen(null)} tittel={!apen?.id ? "Før timer" : apen && kanEndre(apen) ? "Endre timer" : "Timer"}>
        {apen && (
          <ForingSkjema
            foring={apen}
            ansatt={a}
            regler={data.regler}
            kanEndre={kanEndre(apen)}
            ferdig={() => {
              settApen(null);
              settMelding(null);
              endret();
            }}
            avbryt={() => settApen(null)}
          />
        )}
      </Dialog>
      <Dialog apen={avviser} lukk={() => settAvviser(false)} tittel="Avvis timene">
        <AvvisSkjema
          ider={[...levert, ...godkjent].map((f) => f.id)}
          hvem={`${a.fornavn} ${a.etternavn}, uke ${nr}`}
          ferdig={() => {
            settAvviser(false);
            settMelding(`Uke ${nr} er avvist. ${a.fornavn} får beskjed.`);
            endret();
          }}
          avbryt={() => settAvviser(false)}
        />
      </Dialog>
    </>
  );
}

function ForingSkjema({
  foring,
  ansatt,
  regler,
  kanEndre,
  ferdig,
  avbryt,
}: {
  foring: Partial<Foring>;
  ansatt: Ansatt;
  regler: Regler;
  kanEndre: boolean;
  ferdig: () => void;
  avbryt: () => void;
}) {
  const { org } = useKonto();
  const [f, settF] = useState(() => {
    // Ny føring: tidene fra vakten eller den faste dagen den føres fra (en hel fast dag som
    // antall timer), ellers fra forrige føring.
    const sist = foring.id || foring.fra || foring.timer != null ? null : lesSist();
    return {
      dato: foring.dato ?? iDag(),
      modus: foring.fra ? "tid" : foring.id || foring.timer != null ? "timer" : (sist?.modus ?? "tid"),
      fra: foring.fra ?? sist?.fra ?? "",
      til: foring.til ?? sist?.til ?? "",
      pause: String(foring.pause_min ?? sist?.pause_min ?? 0),
      timer: !foring.fra && foring.timer != null ? tallformat.format(Number(foring.timer)) : "",
      overtid: !!foring.overtid_prosent,
      prosent: String(foring.overtid_prosent ?? regler.overtid_prosent),
      beskrivelse: foring.beskrivelse ?? "",
    };
  });
  const h = useHandling();
  const sett = (e: Partial<typeof f>) => settF({ ...f, ...e });
  const pause = f.pause.trim() === "" ? 0 : tall(f.pause);
  const klokke = (s: string) => /^\d{2}:\d{2}$/.test(s);
  const utregnet = f.modus === "tid" && klokke(f.fra) && klokke(f.til) && f.fra !== f.til && Number.isFinite(pause) ? regnTimer(f.fra, f.til, pause) : null;
  const tillegg = [...new Set([40, 50, 100, regler.overtid_prosent, foring.overtid_prosent ?? 40])].sort((x, y) => x - y);

  async function lagre(e: FormEvent) {
    e.preventDefault();
    const kropp = {
      dato: f.dato,
      ...(f.modus === "tid"
        ? { fra: f.fra, til: f.til, pause_min: Math.round(pause) }
        : { fra: null, til: null, pause_min: 0, timer: tall(f.timer) }),
      overtid_prosent: f.overtid ? Number(f.prosent) : null,
      beskrivelse: f.beskrivelse.trim() || null,
    };
    const r = await h.kjor(() =>
      foring.id
        ? api("PATCH", `/org/${org!.id}/timer/${foring.id}`, kropp)
        : api("POST", `/org/${org!.id}/timer`, { ...kropp, ansatt_id: ansatt.id, ...(foring.vakt_id ? { vakt_id: foring.vakt_id } : {}) }),
    );
    if (!r) return;
    const sist = lesSist();
    huskSist(
      f.modus === "tid"
        ? { modus: "tid", fra: f.fra, til: f.til, pause_min: Math.round(pause) }
        : { modus: "timer", fra: sist?.fra ?? "", til: sist?.til ?? "", pause_min: sist?.pause_min ?? 0 },
    );
    ferdig();
  }

  async function slett() {
    if (!confirm(`Slette føringen ${visDag(foring.dato!)}?`)) return;
    const r = await h.kjor(async () => (await api("DELETE", `/org/${org!.id}/timer/${foring.id}`), true));
    if (r) ferdig();
  }

  return (
    <form onSubmit={lagre} className="foring-skjema">
      {!kanEndre && (
        <div className="melding info">
          {foring.status === "godkjent"
            ? "Timene er godkjent og kan ikke endres."
            : foring.status === "levert"
              ? "Timene er levert og kan ikke endres før de eventuelt blir avvist."
              : "Du kan se timene, men ikke endre dem."}
        </div>
      )}
      {foring.status === "avvist" && foring.avvist_grunn && <div className="melding feil">Avvist: {foring.avvist_grunn}</div>}
      <fieldset className="naken" disabled={!kanEndre}>
        <label>
          Dato
          <input type="date" required value={f.dato} min={ansatt.ansatt_fra} max={ansatt.ansatt_til ?? undefined} onChange={(e) => sett({ dato: e.target.value })} />
        </label>
        <div className="faner valg" role="radiogroup" aria-label="Hvordan timene føres">
          {(
            [
              ["tid", "Fra og til"],
              ["timer", "Antall timer"],
            ] as const
          ).map(([v, t]) => (
            <button key={v} type="button" role="radio" aria-checked={f.modus === v} className={f.modus === v ? "valgt" : undefined} onClick={() => sett({ modus: v })}>
              {t}
            </button>
          ))}
        </div>
        {f.modus === "tid" ? (
          <>
            <div className="rad tre">
              <label>
                Fra
                <Klokkeslett required value={f.fra} onChange={(fra) => sett({ fra })} />
              </label>
              <label>
                Til
                <Klokkeslett required value={f.til} onChange={(til) => sett({ til })} />
              </label>
              <label>
                Pause (min)
                <input inputMode="numeric" value={f.pause} onChange={(e) => sett({ pause: e.target.value })} />
              </label>
            </div>
            <p className="utregnet" aria-live="polite">
              {f.fra && f.fra === f.til
                ? "Fra og til kan ikke være like."
                : utregnet === null
                  ? " "
                  : utregnet > 0
                    ? `= ${timer(utregnet)}${f.til < f.fra ? " (over midnatt)" : ""}`
                    : "Pausen er like lang som arbeidstiden."}
            </p>
          </>
        ) : (
          <label>
            Timer
            <input inputMode="decimal" required placeholder="7,5" value={f.timer} onChange={(e) => sett({ timer: e.target.value })} />
          </label>
        )}
        <label>
          <input type="checkbox" checked={f.overtid} onChange={(e) => sett({ overtid: e.target.checked })} />
          Hele føringen er overtid
        </label>
        {f.overtid && (
          <label>
            Overtidstillegg
            <select value={f.prosent} onChange={(e) => sett({ prosent: e.target.value })}>
              {tillegg.map((p) => (
                <option key={p} value={p}>
                  {p} %
                </option>
              ))}
            </select>
          </label>
        )}
        <span className="felt-hjelp overtid-hjelp">
          Timer over {tallformat.format(regler.daglig_grense)} per dag eller {tallformat.format(regler.ukentlig_grense)} per uke blir overtid av seg selv. Kryss av
          når hele føringen er pålagt overtid, for eksempel med 100 % tillegg.
        </span>
        <label>
          Beskrivelse
          <input value={f.beskrivelse} maxLength={500} placeholder="Hva du jobbet med (valgfritt)" onChange={(e) => sett({ beskrivelse: e.target.value })} />
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
        {foring.id && kanEndre && (
          <button type="button" className="fare" style={{ marginLeft: "auto" }} disabled={h.opptatt} onClick={slett}>
            Slett
          </button>
        )}
      </div>
    </form>
  );
}

function AvvisSkjema({ ider, hvem, ferdig, avbryt }: { ider: string[]; hvem: string; ferdig: () => void; avbryt: () => void }) {
  const { org } = useKonto();
  const [grunn, settGrunn] = useState("");
  const h = useHandling();
  async function avvis(e: FormEvent) {
    e.preventDefault();
    const r = await h.kjor(() => api("POST", `/org/${org!.id}/timer/avvis`, { ider, grunn: grunn.trim() }));
    if (r) ferdig();
  }
  return (
    <form onSubmit={avvis}>
      <p className="dempet" style={{ marginTop: 0 }}>
        Timene for {hvem} sendes tilbake. Den ansatte får beskjed, retter og leverer på nytt.
      </p>
      <label>
        Hva må rettes?
        <textarea required rows={3} maxLength={500} value={grunn} onChange={(e) => settGrunn(e.target.value)} />
      </label>
      <Feil melding={h.feil} />
      <div className="knapper">
        <button className="fare" disabled={h.opptatt || !grunn.trim()}>
          Avvis timene
        </button>
        <button type="button" onClick={avbryt}>
          Avbryt
        </button>
      </div>
    </form>
  );
}

// Alle ansattes uke: timer per dag, sum, overtid og status. Trykk for å se (og føre) uka.
function Ukeoversikt({
  uke,
  velgUke,
  apne,
  versjon,
  venter,
  tilGodkjenning,
}: {
  uke: string;
  velgUke: (mandag: string) => void;
  apne: (ansattId: string) => void;
  versjon: number;
  venter: number;
  tilGodkjenning?: () => void;
}) {
  const { org } = useKonto();
  const til = leggTilDager(uke, 6);
  const ansatte = useData(() => hent<Ansatt[]>(`/org/${org!.id}/ansatte`), [org?.id, versjon]);
  const { data, feil } = useData(() => hent<TimerSvar>(`/org/${org!.id}/timer?fra=${uke}&til=${til}`), [org?.id, uke, versjon]);
  const smal = useSmal();
  const dager = [0, 1, 2, 3, 4, 5, 6].map((i) => leggTilDager(uke, i));

  const toppen = (
    <>
      {venter > 0 && tilGodkjenning && (
        <div className="melding info venter">
          <span>
            {venter === 1 ? "Én uke venter" : `${venter} uker venter`} på godkjenning.
          </span>
          <button type="button" className="lenke" onClick={tilGodkjenning}>
            Se {venter === 1 ? "den" : "dem"}
          </button>
        </div>
      )}
      <div className="uke-verktoy">
        <Ukevelger uke={uke} velgUke={velgUke} />
      </div>
    </>
  );
  if (feil || ansatte.feil)
    return (
      <>
        {toppen}
        <Feil melding={feil ?? ansatte.feil} />
      </>
    );
  if (!data || !ansatte.data)
    return (
      <>
        {toppen}
        <Laster />
      </>
    );

  // Ansatte i jobb denne uka, og alle som har timer i den.
  const rader = ansatte.data
    .filter((a) => data.uker.some((u) => u.ansatt_id === a.id) || (a.aktiv && a.ansatt_fra <= til && (!a.ansatt_til || a.ansatt_til >= uke)))
    .map((a) => {
      const u = data.uker.find((x) => x.ansatt_id === a.id);
      const perDag = dager.map((d) => data.foringer.filter((f) => f.ansatt_id === a.id && f.dato === d).reduce((s, f) => s + Number(f.timer), 0));
      return { a, u, perDag, overtid: (u?.overtid ?? []).reduce((s, o) => s + o.timer, 0) };
    });

  if (!ansatte.data.length)
    return (
      <>
        {toppen}
        <div className="kort">
          <Tom ikon={<IkonKlokke storrelse={22} />} tittel="Ingen ansatte ennå">
            <p>
              Legg inn de ansatte under <Link to="/ansatte">Ansatte</Link>. De kan få egen innlogging og føre timene sine selv.
            </p>
          </Tom>
        </div>
      </>
    );

  const merke = (u?: Uke) => (u ? <span className={`merke ${statusMerke[u.status].klasse}`}>{statusMerke[u.status].tekst}</span> : <span className="dempet">–</span>);

  return (
    <>
      {toppen}
      {smal ? (
        <div className="kort liste">
          {rader.map(({ a, u, overtid }) => (
            <button key={a.id} type="button" className="liste-rad" onClick={() => apne(a.id)}>
              <span className="linje">
                <span className="tittel">
                  {a.fornavn} {a.etternavn}
                </span>
                <span className="belop">{timer(u?.sum ?? 0)}</span>
              </span>
              <span className="linje">
                <span className="under">
                  {overtid > 0 ? `Overtid ${timer(overtid)}` : u ? antallForinger(u.antall) : "Ingen timer"}
                  {u?.merarbeid ? ` · merarbeid ${timer(u.merarbeid)}` : ""}
                </span>
                {u && merke(u)}
              </span>
            </button>
          ))}
          {!rader.length && <p className="dempet ingen-enna" style={{ padding: 16 }}>Ingen ansatte i jobb denne uka.</p>}
        </div>
      ) : (
        <div className="kort tabell">
          <table className="ukeoversikt">
            <thead>
              <tr>
                <th>Ansatt</th>
                {dager.map((d) => (
                  <th key={d} className={`tall${d === iDag() ? " i-dag" : ""}`}>
                    {ukedagFormat.format(middag(d))} {Number(d.slice(8))}.
                  </th>
                ))}
                <th className="tall">Sum</th>
                <th className="tall">Overtid</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {rader.map(({ a, u, perDag, overtid }) => (
                <tr key={a.id} className="klikkbar" onClick={() => apne(a.id)}>
                  <td>
                    {a.fornavn} {a.etternavn}
                  </td>
                  {perDag.map((t, i) => (
                    <td key={i} className={`tall${t ? "" : " dempet"}`}>
                      {t ? tallformat.format(t) : "–"}
                    </td>
                  ))}
                  <td className="tall">
                    <strong>{tallformat.format(u?.sum ?? 0)}</strong>
                  </td>
                  <td className="tall">{overtid ? tallformat.format(overtid) : ""}</td>
                  <td>{merke(u)}</td>
                </tr>
              ))}
              {!rader.length && (
                <tr>
                  <td colSpan={11} className="dempet">
                    Ingen ansatte i jobb denne uka.
                  </td>
                </tr>
              )}
            </tbody>
            {rader.length > 1 && (
              <tfoot>
                <tr>
                  <td>Sum</td>
                  {dager.map((d, i) => {
                    const t = rader.reduce((s, r) => s + r.perDag[i]!, 0);
                    return (
                      <td key={d} className={`tall${t ? "" : " dempet"}`}>
                        {t ? tallformat.format(t) : "–"}
                      </td>
                    );
                  })}
                  <td className="tall">{tallformat.format(rader.reduce((s, r) => s + (r.u?.sum ?? 0), 0))}</td>
                  <td className="tall">{tallformat.format(rader.reduce((s, r) => s + r.overtid, 0))}</td>
                  <td />
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}
      <p className="liten dempet">{smal ? "" : "Timer per dag. "}Trykk på en ansatt for å se uka, føre timer eller godkjenne.</p>
    </>
  );
}

// Leverte uker som venter på godkjenning, eldste nederst.
function Godkjenning({ svar, feil, endret, apne }: { svar?: TimerSvar; feil: string | null; endret: () => void; apne: (ansattId: string, uke: string) => void }) {
  const { org } = useKonto();
  const [avviser, settAvviser] = useState<{ ider: string[]; hvem: string; fornavn: string } | null>(null);
  const [melding, settMelding] = useState<string | null>(null);
  const h = useHandling();
  if (feil) return <Feil melding={feil} />;
  if (!svar) return <Laster />;

  const ider = (u: Uke) => svar.foringer.filter((f) => f.ansatt_id === u.ansatt_id && f.dato >= u.fra && f.dato <= u.til).map((f) => f.id);
  const godkjenn = (uker: Uke[]) =>
    h.kjor(async () => {
      await api("POST", `/org/${org!.id}/timer/godkjenn`, { ider: uker.flatMap(ider) });
      settMelding(uker.length === 1 ? `Uke ${uker[0]!.uke} for ${uker[0]!.ansatt_navn} er godkjent.` : `${uker.length} uker er godkjent.`);
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
      {!svar.uker.length ? (
        <div className="kort">
          <Tom ikon={<IkonHake storrelse={22} />} tittel="Ingenting venter på godkjenning">
            <p>Når en ansatt leverer timene for en uke, kommer de hit, og du får varsel.</p>
          </Tom>
        </div>
      ) : (
        <>
          {svar.uker.length > 1 && (
            <div className="knapper godkjenn-alle">
              <button type="button" className="primar" disabled={h.opptatt} onClick={() => godkjenn(svar.uker)}>
                Godkjenn alle ({svar.uker.length} uker)
              </button>
            </div>
          )}
          {svar.uker.map((u) => {
            const leverte = svar.foringer.filter((f) => f.ansatt_id === u.ansatt_id && f.dato >= u.fra && f.dato <= u.til);
            return (
              <div key={`${u.ansatt_id}:${u.fra}`} className="kort godkjenn-uke">
                <div className="kort-topp">
                  <div style={{ minWidth: 0 }}>
                    <h2>{u.ansatt_navn}</h2>
                    <span className="dempet">
                      Uke {u.uke} · {ukePeriode(u.fra)}
                    </span>
                  </div>
                  <strong className="tall godkjenn-sum">{timer(u.sum)}</strong>
                </div>
                <p className="godkjenn-tall">
                  {u.planlagt != null && <span>Planlagt {timer(u.planlagt)}</span>}
                  <span>Ordinære {timer(u.ordinare)}</span>
                  {u.overtid.map((o) => (
                    <span key={o.prosent}>
                      Overtid {o.prosent} %: {timer(o.timer)}
                    </span>
                  ))}
                  {u.merarbeid > 0 && <span>Merarbeid {timer(u.merarbeid)}</span>}
                  {u.antall_status.utkast + u.antall_status.avvist > 0 && (
                    <span className="advarsel-tekst">
                      {antallForinger(u.antall_status.utkast + u.antall_status.avvist)} i uka er ikke levert
                    </span>
                  )}
                </p>
                <table className="kompakt foringer">
                  <tbody>
                    {leverte.map((f) => (
                      <tr key={f.id}>
                        <td>{visDag(f.dato)}</td>
                        <td>
                          {f.fra ? `${f.fra}–${f.til}` : ""}
                          {f.pause_min > 0 ? <span className="dempet liten"> · {f.pause_min} min pause</span> : null}
                        </td>
                        <td className="tall">{timer(f.timer)}</td>
                        <td className="dempet">{f.beskrivelse}</td>
                        <td className="hoyre">{f.overtid_prosent ? <span className="merke merke-advarsel">Overtid {f.overtid_prosent} %</span> : null}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="knapper">
                  <button type="button" className="primar" disabled={h.opptatt} onClick={() => godkjenn([u])}>
                    Godkjenn
                  </button>
                  <button
                    type="button"
                    className="fare"
                    disabled={h.opptatt}
                    onClick={() => settAvviser({ ider: ider(u), hvem: `${u.ansatt_navn}, uke ${u.uke}`, fornavn: u.ansatt_navn.split(" ")[0]! })}
                  >
                    Avvis
                  </button>
                  <button type="button" className="lenke" onClick={() => apne(u.ansatt_id, u.fra)}>
                    Åpne uka
                  </button>
                  <span className="liten dempet" style={{ marginLeft: "auto" }}>
                    Levert {dato(leverte.map((f) => f.levert_at ?? "").sort().at(-1))}
                  </span>
                </div>
              </div>
            );
          })}
        </>
      )}
      <Dialog apen={!!avviser} lukk={() => settAvviser(null)} tittel="Avvis timene">
        {avviser && (
          <AvvisSkjema
            ider={avviser.ider}
            hvem={avviser.hvem}
            ferdig={() => {
              settMelding(`Timene for ${avviser.hvem} er avvist. ${avviser.fornavn} får beskjed.`);
              settAvviser(null);
              endret();
            }}
            avbryt={() => settAvviser(null)}
          />
        )}
      </Dialog>
    </>
  );
}
