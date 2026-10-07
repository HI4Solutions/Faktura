// Tavla (ressursfordeling): dagen er delt i faser (radene) og oppgaver (kolonnene) som
// organisasjonen lager selv under «Oppsett». Ressursene er de som har vakt den dagen i
// vaktplanen, og en ansatt hører til fasene vakten overlapper. Den som er borte (fravær), tas
// ut av ressursene: plassene står overstreket og teller ikke, og vakten står som «mangler
// vikar» til en vikar er satt inn (vikaren tar over plassene). Behovet (hvor mange som trengs)
// står på oppgaven og kan settes per fase. Eier og administrator flytter de ansatte mellom
// oppgavene: dra og slipp på PC, eller trykk på navnet. Regnskap ser tavla.
import { useEffect, useState, type CSSProperties, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { api, hent } from "../api";
import { Dialog, Feil, Laster, Tom, tall, useData, useHandling } from "../felles";
import { useKonto } from "../konto";
import { iDag, leggTilDager } from "../format";
import { IkonHoyre, IkonInnstillinger, IkonKopier, IkonNed, IkonOpp, IkonPluss, IkonTavle, IkonVarsel, IkonVenstre } from "../ikoner";
import { mandag, middag, ukenr, visDag } from "../uke";
import { borteTekst, fravaerKlasse, fravaerPeriode, fravaerTekst, VikarSkjema, type Ansatt, type FravaerType } from "./Fravaer";

type Fase = { id: string; navn: string; fra: string | null; til: string | null };
type Oppgave = { id: string; navn: string; behov: number | null };
type TavleVakt = { id: string; fra: string; til: string; oppgave: string | null; vikar: boolean; publisert: boolean };
type Ressurs = { ansatt_id: string; navn: string; fravaer: FravaerType | null; vakter: TavleVakt[] };
type Plassering = { fase_id: string; oppgave_id: string; ansatt_id: string };
type Behov = { fase_id: string; oppgave_id: string; antall: number };
type ManglerVikar = { vakt_id: string; ansatt_id: string; navn: string; fra: string; til: string; oppgave: string | null; type: FravaerType };
type TavleSvar = {
  dato: string;
  faser: Fase[];
  oppgaver: Oppgave[];
  behov: Behov[];
  ressurser: Ressurs[];
  plasseringer: Plassering[];
  fravaer: { id: string; ansatt_id: string; navn: string; type: FravaerType; fra: string; til: string }[];
  mangler_vikar: ManglerVikar[];
};

const minutter = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
// Vakten overlapper fasen (begge kan gå over midnatt). En fase uten tidsrom gjelder hele dagen.
export function iFasen(v: { fra: string; til: string }, f: Fase) {
  if (!f.fra || !f.til) return true;
  const vf = minutter(v.fra);
  const ff = minutter(f.fra);
  const vt = minutter(v.til) + (minutter(v.til) <= vf ? 1440 : 0);
  const ft = minutter(f.til) + (minutter(f.til) <= ff ? 1440 : 0);
  return vf < ft && ff < vt;
}
// «07–15» eller «07:30–15»
const kortTid = (s: string) => (s.endsWith(":00") ? s.slice(0, 2) : s);
const tidKort = (v: { fra: string; til: string }) => `${kortTid(v.fra)}–${kortTid(v.til)}`;
const fasetid = (f: Fase) => (f.fra && f.til ? `${f.fra}–${f.til}` : "Hele dagen");
// Hvor mange som trengs i oppgaven i fasen: satt for fasen, ellers på oppgaven (null: ikke satt).
const trengs = (behov: Behov[], fase: string, o: Oppgave) => behov.find((b) => b.fase_id === fase && b.oppgave_id === o.id)?.antall ?? o.behov;

const langDag = new Intl.DateTimeFormat("nb-NO", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
export const visLangDag = (iso: string) => {
  const t = langDag.format(middag(iso));
  return t.charAt(0).toUpperCase() + t.slice(1);
};

const FASEFORSLAG: { navn: string; faser: [string, string, string][] }[] = [
  {
    navn: "Forvakt, mellomvakt og senvakt",
    faser: [
      ["Forvakt", "07:00", "15:00"],
      ["Mellomvakt", "11:00", "19:00"],
      ["Senvakt", "15:00", "23:00"],
    ],
  },
  {
    navn: "Før og etter lunsj",
    faser: [
      ["Før lunsj", "08:00", "11:30"],
      ["Etter lunsj", "12:00", "16:00"],
    ],
  },
  {
    navn: "Formiddag og ettermiddag",
    faser: [
      ["Formiddag", "08:00", "12:00"],
      ["Ettermiddag", "12:00", "16:00"],
    ],
  },
];
const OPPGAVEFORSLAG = ["Telefon", "Resepsjon", "Lab"];

export function Tavle({ dato, velgDato, kanEndre }: { dato: string; velgDato: (dato: string) => void; kanEndre: boolean }) {
  const { org } = useKonto();
  const { data, feil, last, settData } = useData(() => hent<TavleSvar>(`/org/${org!.id}/tavle?dato=${dato}`), [org?.id, dato]);
  const ansatte = useData(() => hent<Ansatt[]>(`/org/${org!.id}/ansatte`), [org?.id]);
  const [oppsett, settOppsett] = useState(false);
  const [kopierer, settKopierer] = useState(false);
  const [valgt, settValgt] = useState<{ ansatt: string; fase: string } | null>(null);
  const [dra, settDra] = useState<{ ansatt: string; fase: string } | null>(null);
  const [over, settOver] = useState<string | null>(null);
  const [vikar, settVikar] = useState<ManglerVikar | null>(null);
  const [melding, settMelding] = useState<string | null>(null);
  const h = useHandling();
  // Ny dag: ikke vis meldingen eller feilen fra den forrige.
  useEffect(() => {
    settMelding(null);
    h.settFeil(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dato]);

  // Flytt en ansatt til en oppgave (null: ta ut) i én eller flere faser. Tavla oppdateres med en
  // gang, og hentes på nytt hvis noe går galt.
  async function flytt(ansatt: string, faser: string[], oppgave: string | null) {
    settData(
      (d) =>
        d && {
          ...d,
          plasseringer: [
            ...d.plasseringer.filter((p) => !(p.ansatt_id === ansatt && faser.includes(p.fase_id))),
            ...(oppgave ? faser.map((fase_id) => ({ fase_id, oppgave_id: oppgave, ansatt_id: ansatt })) : []),
          ],
        },
    );
    const ok = await h.kjor(async () => {
      for (const fase_id of faser) await api("PUT", `/org/${org!.id}/tavle/plassering`, { dato, fase_id, ansatt_id: ansatt, oppgave_id: oppgave });
      return true;
    });
    if (!ok) last();
  }

  const klar = !!data && data.faser.length > 0 && data.oppgaver.length > 0;
  const verktoy = (
    <div className="uke-verktoy">
      <div className="ukevelger">
        <button type="button" className="ikon" aria-label="Forrige dag" title="Forrige dag" onClick={() => velgDato(leggTilDager(dato, -1))}>
          <IkonVenstre storrelse={20} />
        </button>
        <div className="uke-navn dag-navn-lang" aria-live="polite">
          <strong>{visLangDag(dato)}</strong>
          <span>Uke {ukenr(dato).uke}</span>
        </div>
        <button type="button" className="ikon" aria-label="Neste dag" title="Neste dag" onClick={() => velgDato(leggTilDager(dato, 1))}>
          <IkonHoyre storrelse={20} />
        </button>
        {dato !== iDag() && (
          <button type="button" className="lenke" onClick={() => velgDato(iDag())}>
            I dag
          </button>
        )}
      </div>
      {kanEndre && klar && (
        <div className="knapper">
          <button type="button" onClick={() => settKopierer(true)}>
            <IkonKopier storrelse={17} /> Kopier plasser
          </button>
          <button type="button" onClick={() => settOppsett(true)}>
            <IkonInnstillinger storrelse={17} /> Oppsett
          </button>
        </div>
      )}
    </div>
  );
  const oppsettDialog = data && (
    <Dialog apen={oppsett} lukk={() => settOppsett(false)} tittel="Oppsett av tavla" bred>
      <OppsettListe type="faser" rader={data.faser} endret={last} forslag={[]} />
      <OppsettListe
        type="oppgaver"
        rader={data.oppgaver}
        endret={last}
        forslag={[...new Set([...OPPGAVEFORSLAG, ...data.ressurser.flatMap((r) => r.vakter.map((v) => v.oppgave ?? ""))])].filter(
          (n) => n && !data.oppgaver.some((o) => o.navn.toLowerCase() === n.toLowerCase()),
        )}
      />
      {data.faser.length > 0 && data.oppgaver.length > 0 && <BehovPerFase faser={data.faser} oppgaver={data.oppgaver} behov={data.behov} endret={last} />}
      <div className="knapper oppsett-ferdig">
        <button type="button" className="primar" onClick={() => settOppsett(false)}>
          Ferdig
        </button>
      </div>
    </Dialog>
  );

  if (feil)
    return (
      <>
        {verktoy}
        <Feil melding={feil} />
      </>
    );
  if (!data)
    return (
      <>
        {verktoy}
        <Laster />
      </>
    );
  if (!klar)
    return (
      <>
        {verktoy}
        <div className="kort">
          <Tom ikon={<IkonTavle storrelse={22} />} tittel={kanEndre ? "Sett opp tavla" : "Tavla er ikke satt opp ennå"}>
            <p>
              Del dagen i faser, for eksempel forvakt og senvakt eller før og etter lunsj, og lag oppgavene de ansatte fordeles på, for eksempel telefon,
              resepsjon og lab. Ressursene hentes fra vaktplanen.
            </p>
            {kanEndre && (
              <div className="knapper" style={{ justifyContent: "center" }}>
                <button type="button" className="primar" onClick={() => settOppsett(true)}>
                  Sett opp tavla
                </button>
              </div>
            )}
          </Tom>
        </div>
        {oppsettDialog}
      </>
    );

  const navn = new Map<string, string>([
    ...(ansatte.data ?? []).map((a) => [a.id, `${a.fornavn} ${a.etternavn}`] as const),
    ...data.ressurser.map((r) => [r.ansatt_id, r.navn] as const),
  ]);
  const ressurs = new Map(data.ressurser.map((r) => [r.ansatt_id, r]));
  const paJobb = data.ressurser.filter((r) => !r.fravaer);
  const kandidater = (f: Fase) => paJobb.filter((r) => r.vakter.some((v) => iFasen(v, f)));
  const plassert = (fase: string, oppgave: string) =>
    data.plasseringer
      .filter((p) => p.fase_id === fase && p.oppgave_id === oppgave)
      .map((p) => p.ansatt_id)
      .sort((a, b) => (navn.get(a) ?? "").localeCompare(navn.get(b) ?? "", "nb"));
  // De som er på jobb i fasen og står i oppgaven (de som er borte eller ikke har vakt, teller ikke).
  const antall = (f: Fase, oppgave: string) => {
    const k = new Set(kandidater(f).map((r) => r.ansatt_id));
    return plassert(f.id, oppgave).filter((a) => k.has(a)).length;
  };
  const ikkePlassert = paJobb.filter((r) =>
    data.faser.some((f) => r.vakter.some((v) => iFasen(v, f)) && !data.plasseringer.some((p) => p.fase_id === f.id && p.ansatt_id === r.ansatt_id)),
  ).length;

  const chip = (a: string, f: Fase) => {
    const r = ressurs.get(a);
    const borte = r?.fravaer ?? null;
    const vakter = (r?.vakter ?? []).filter((v) => iFasen(v, f));
    const utenVakt = !borte && !vakter.length;
    const utkast = vakter.length > 0 && vakter.every((v) => !v.publisert);
    const tittel = [
      borte ? `${fravaerTekst[borte]}: plassen teller ikke` : "",
      utenVakt ? "Har ikke vakt i denne fasen" : "",
      utkast ? "Vakten er ikke publisert" : "",
    ]
      .filter(Boolean)
      .join("\n");
    const klasse = `ressurs${borte ? " borte" : ""}${utenVakt ? " uten-vakt" : ""}${utkast ? " utkast" : ""}${dra?.ansatt === a && dra.fase === f.id ? " drar" : ""}`;
    const innhold = (
      <>
        <span className="ressurs-navn">{navn.get(a) ?? "Ukjent"}</span>
        {vakter.length > 0 && <span className="ressurs-tid">{vakter.map(tidKort).join(", ")}</span>}
        {vakter.some((v) => v.vikar) && <span className="ressurs-merke">Vikar</span>}
        {borte && <span className="ressurs-merke fare">{fravaerTekst[borte]}</span>}
      </>
    );
    if (!kanEndre)
      return (
        <span key={a} className={klasse} title={tittel || undefined}>
          {innhold}
        </span>
      );
    return (
      <button
        key={a}
        type="button"
        className={klasse}
        title={tittel || undefined}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData("text/plain", a);
          e.dataTransfer.effectAllowed = "move";
          settDra({ ansatt: a, fase: f.id });
        }}
        onDragEnd={() => {
          settDra(null);
          settOver(null);
        }}
        onClick={() => settValgt({ ansatt: a, fase: f.id })}
      >
        {innhold}
      </button>
    );
  };

  const celle = (f: Fase, o: Oppgave | null, folk: string[], n: number) => {
    const nokkel = `${f.id}:${o?.id ?? "-"}`;
    const kanSlippe = !!dra && dra.fase === f.id;
    const behov = o ? trengs(data.behov, f.id, o) : null;
    const status = behov ? (n < behov ? " under" : " nok") : "";
    return (
      <div
        key={nokkel}
        role="group"
        aria-label={`${f.navn}: ${o?.navn ?? "Ikke plassert"}`}
        className={`tavle-celle${o ? "" : " uplassert"}${behov === 0 ? " trengs-ikke" : ""}${kanSlippe ? " kan-slippe" : ""}${kanSlippe && over === nokkel ? " over" : ""}`}
        onDragOver={
          kanSlippe
            ? (e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                if (over !== nokkel) settOver(nokkel);
              }
            : undefined
        }
        onDrop={
          kanSlippe
            ? (e) => {
                e.preventDefault();
                const a = dra!.ansatt;
                settDra(null);
                settOver(null);
                const na = data.plasseringer.find((p) => p.fase_id === f.id && p.ansatt_id === a)?.oppgave_id ?? null;
                if (na !== (o?.id ?? null)) flytt(a, [f.id], o?.id ?? null);
              }
            : undefined
        }
      >
        <div className="celle-topp">
          <span className="celle-navn">{o?.navn ?? "Ikke plassert"}</span>
          {(!!behov || n > 0) && (
            <span className={`behov${status}`} title={behov ? `${n} av ${behov} som trengs` : behov === 0 ? "Trengs ikke i denne fasen" : undefined}>
              {n}
              {behov ? `/${behov}` : ""}
            </span>
          )}
        </div>
        <div className="celle-folk">{folk.map((a) => chip(a, f))}</div>
      </div>
    );
  };

  const v = valgt && { ...valgt, fase: data.faser.find((f) => f.id === valgt.fase) };

  return (
    <>
      {verktoy}
      <p className="tavle-sum">
        <span>
          <strong>{paJobb.length}</strong> på jobb
        </span>
        {data.fravaer.length > 0 && (
          <span>
            <strong>{data.fravaer.length}</strong> borte
          </span>
        )}
        {ikkePlassert > 0 && (
          <span>
            <strong>{ikkePlassert}</strong> ikke plassert
          </span>
        )}
        {kanEndre && paJobb.length > 0 && (
          <span className="dempet">
            <span className="bare-mus">Dra navnene til oppgavene, eller trykk på et navn.</span>
            <span className="bare-trykk">Trykk på et navn for å plassere det.</span>
          </span>
        )}
      </p>
      {melding && (
        <div className="melding ok" role="status">
          {melding}
        </div>
      )}
      <Feil melding={h.feil} />
      {data.mangler_vikar.length > 0 && (
        <div className="kort mangler-vikar">
          <h2>
            <IkonVarsel storrelse={18} /> {data.mangler_vikar.length === 1 ? "Én vakt mangler vikar" : `${data.mangler_vikar.length} vakter mangler vikar`}
          </h2>
          <ul className="liste-enkel">
            {data.mangler_vikar.map((m) => (
              <li key={m.vakt_id}>
                <span>
                  <strong>{m.navn}</strong> <span className={`merke ${fravaerKlasse[m.type]}`}>{fravaerTekst[m.type]}</span>{" "}
                  <span className="dempet">
                    Vakt {m.fra}–{m.til}
                    {m.oppgave ? ` · ${m.oppgave}` : ""}
                  </span>
                </span>
                {kanEndre && (
                  <button type="button" onClick={() => settVikar(m)}>
                    Sett inn vikar
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {!data.ressurser.length && (
        <div className="melding info venter">
          <span>Ingen har vakt {dato === iDag() ? "i dag" : "denne dagen"}. Ressursene på tavla hentes fra vaktplanen.</span>
          <Link to={`/vakter?fane=plan&uke=${mandag(dato)}`}>Åpne vaktplanen</Link>
        </div>
      )}
      <div className="kort tavle-ramme">
        <div className="tavle" style={{ "--oppgaver": data.oppgaver.length } as CSSProperties}>
          <div className="tavle-rad hode">
            <div className="tavle-hode">Fase</div>
            <div className="tavle-hode">Ikke plassert</div>
            {data.oppgaver.map((o) => (
              <div key={o.id} className="tavle-hode">
                {o.navn}
                {o.behov ? <span className="dempet"> · trenger {o.behov}</span> : null}
              </div>
            ))}
          </div>
          {data.faser.map((f) => {
            const kand = kandidater(f);
            const har = new Set(data.plasseringer.filter((p) => p.fase_id === f.id).map((p) => p.ansatt_id));
            const uplassert = kand.filter((r) => !har.has(r.ansatt_id)).map((r) => r.ansatt_id);
            return (
              <div key={f.id} className="tavle-rad">
                <div className="tavle-fase">
                  <strong>{f.navn}</strong>
                  <span className="dempet">{fasetid(f)}</span>
                  <span className="liten">{kand.length} på jobb</span>
                </div>
                {celle(f, null, uplassert, uplassert.length)}
                {data.oppgaver.map((o) => celle(f, o, plassert(f.id, o.id), antall(f, o.id)))}
              </div>
            );
          })}
        </div>
      </div>
      {data.fravaer.length > 0 && (
        <div className="kort borte-i-dag">
          <h2>
            Borte {dato === iDag() ? "i dag" : "denne dagen"} ({data.fravaer.length})
          </h2>
          <ul className="liste-enkel">
            {data.fravaer.map((x) => (
              <li key={x.id}>
                <span>
                  <span className="tittel">{x.navn}</span> <span className="dempet">{fravaerPeriode(x)}</span>
                </span>
                <span className={`merke ${fravaerKlasse[x.type]}`}>{fravaerTekst[x.type]}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="liten dempet">
        Hvem som hører til en fase, avgjøres av vakten i vaktplanen. Stiplet kant: vakten er ikke publisert, eller den ansatte har ikke vakt i fasen.
      </p>
      {oppsettDialog}
      <Dialog apen={kopierer} lukk={() => settKopierer(false)} tittel={`Kopier plasser til ${visDag(dato).toLowerCase()}`}>
        {kopierer && (
          <KopierTavle
            dato={dato}
            ferdig={(m) => {
              settKopierer(false);
              settMelding(m);
              last();
            }}
            avbryt={() => settKopierer(false)}
          />
        )}
      </Dialog>
      <Dialog apen={!!v?.fase} lukk={() => settValgt(null)} tittel={v ? (navn.get(v.ansatt) ?? "Ansatt") : ""}>
        {v?.fase && (
          <Flytt
            ansatt={v.ansatt}
            navn={navn.get(v.ansatt) ?? "Den ansatte"}
            fase={v.fase}
            data={data}
            antall={antall}
            flytt={(faser, oppgave) => {
              settValgt(null);
              flytt(v.ansatt, faser, oppgave);
            }}
            settInnVikar={(m) => {
              settValgt(null);
              settVikar(m);
            }}
          />
        )}
      </Dialog>
      <Dialog apen={!!vikar} lukk={() => settVikar(null)} tittel="Sett inn vikar">
        {vikar && (
          <VikarSkjema
            vakt={{ id: vikar.vakt_id, dato, fra: vikar.fra, til: vikar.til, oppgave: vikar.oppgave, ansatt_id: vikar.ansatt_id, ansatt_navn: vikar.navn }}
            ansatte={ansatte.data ?? []}
            fravaer={data.fravaer}
            opptatt={new Map(data.ressurser.map((r) => [r.ansatt_id, r.vakter.map((x) => `${x.fra}–${x.til}`).join(", ")]))}
            ferdig={(m) => {
              settVikar(null);
              settMelding(m);
              last();
            }}
            avbryt={() => settVikar(null)}
          />
        )}
      </Dialog>
    </>
  );
}

// Trykk på et navn: velg oppgaven i fasen (og eventuelt de andre fasene på vakten).
function Flytt({
  ansatt,
  navn,
  fase,
  data,
  antall,
  flytt,
  settInnVikar,
}: {
  ansatt: string;
  navn: string;
  fase: Fase;
  data: TavleSvar;
  antall: (f: Fase, oppgave: string) => number;
  flytt: (faser: string[], oppgave: string | null) => void;
  settInnVikar: (m: ManglerVikar) => void;
}) {
  const [alle, settAlle] = useState(false);
  const r = data.ressurser.find((x) => x.ansatt_id === ansatt);
  const andre = r && !r.fravaer ? data.faser.filter((x) => x.id !== fase.id && r.vakter.some((v) => iFasen(v, x))) : [];
  const na = data.plasseringer.find((p) => p.fase_id === fase.id && p.ansatt_id === ansatt)?.oppgave_id ?? null;
  const mangler = data.mangler_vikar.find((m) => m.ansatt_id === ansatt);
  const faser = alle ? [fase.id, ...andre.map((x) => x.id)] : [fase.id];
  const vakter = (r?.vakter ?? []).map((v) => `${v.fra}–${v.til}`).join(", ");

  return (
    <div className="flytt">
      <p className="dempet" style={{ marginTop: 0 }}>
        {fase.navn} ({fasetid(fase).toLowerCase()}){vakter ? ` · vakt ${vakter}` : " · ingen vakt denne dagen"}
      </p>
      {r?.fravaer ? (
        <>
          <div className="melding feil">
            {navn} {borteTekst[r.fravaer]} denne dagen, og plassen teller ikke.{" "}
            {mangler ? "Vakten mangler vikar." : "Vikar er satt inn."}
          </div>
          <div className="knapper">
            {mangler && (
              <button type="button" className="primar" onClick={() => settInnVikar(mangler)}>
                Sett inn vikar
              </button>
            )}
            {na && (
              <button type="button" onClick={() => flytt([fase.id], null)}>
                Ta ut av {data.oppgaver.find((o) => o.id === na)?.navn ?? "oppgaven"}
              </button>
            )}
          </div>
        </>
      ) : (
        <>
          <div className="flytt-valg" role="radiogroup" aria-label="Oppgave">
            {data.oppgaver.map((o) => (
              <button key={o.id} type="button" role="radio" aria-checked={na === o.id} className={na === o.id ? "valgt" : undefined} onClick={() => flytt(faser, o.id)}>
                <span>{o.navn}</span>
                <span className="flytt-antall">
                  {antall(fase, o.id)}
                  {trengs(data.behov, fase.id, o) ? `/${trengs(data.behov, fase.id, o)}` : ""}
                </span>
              </button>
            ))}
            <button type="button" role="radio" aria-checked={na === null} className={`ingen${na === null ? " valgt" : ""}`} onClick={() => flytt(faser, null)}>
              Ikke plassert
            </button>
          </div>
          {andre.length > 0 && (
            <label>
              <input type="checkbox" checked={alle} onChange={(e) => settAlle(e.target.checked)} />
              Gjelder også {andre.map((x) => x.navn).join(" og ")}
            </label>
          )}
        </>
      )}
    </div>
  );
}

function KopierTavle({ dato, ferdig, avbryt }: { dato: string; ferdig: (melding: string) => void; avbryt: () => void }) {
  const { org } = useKonto();
  const [fra, settFra] = useState(leggTilDager(dato, -7));
  const h = useHandling();
  async function kopier(e: FormEvent) {
    e.preventDefault();
    const r = await h.kjor(() => api<{ kopiert: number }>("POST", `/org/${org!.id}/tavle/kopier`, { fra, til: dato }));
    // «fra ons. 30. sep.» slutter allerede med punktum (men ikke «fra fre. 1. mai»).
    const dag = visDag(fra).toLowerCase();
    const slutt = dag.endsWith(".") ? "" : ".";
    if (r) ferdig(r.kopiert ? `Kopierte ${r.kopiert} ${r.kopiert === 1 ? "plass" : "plasser"} fra ${dag}${slutt}` : `Ingen nye plasser å kopiere fra ${dag}${slutt}`);
  }
  return (
    <form onSubmit={kopier}>
      <p className="dempet" style={{ marginTop: 0 }}>
        Plassene fra dagen du velger, kopieres for dem som har vakt og ikke er borte {visDag(dato).toLowerCase()}. Plasser som finnes fra før, beholdes.
      </p>
      <label>
        Kopier fra
        <input type="date" required value={fra} onChange={(e) => settFra(e.target.value)} />
        <span className="felt-hjelp">Forslaget er samme dag forrige uke.</span>
      </label>
      <Feil melding={h.feil} />
      <div className="knapper">
        <button className="primar" disabled={h.opptatt || fra === dato}>
          Kopier
        </button>
        <button type="button" onClick={avbryt}>
          Avbryt
        </button>
      </div>
    </form>
  );
}

// --- Oppsett: faser og oppgaver ----------------------------------------------------------

type Rad = { id: string; navn: string; fra?: string | null; til?: string | null; behov?: number | null };

function OppsettListe({ type, rader, endret, forslag }: { type: "faser" | "oppgaver"; rader: Rad[]; endret: () => Promise<void>; forslag: string[] }) {
  const { org } = useKonto();
  const [rediger, settRediger] = useState<string | null>(null); // id-en, eller «ny»
  const h = useHandling();
  const fase = type === "faser";
  const ny = (k: Record<string, unknown>) => api("POST", `/org/${org!.id}/tavle/${type}`, k);

  const flytt = (i: number, til: number) =>
    h.kjor(async () => {
      const ider = rader.map((r) => r.id);
      const [x] = ider.splice(i, 1);
      ider.splice(til, 0, x!);
      await api("POST", `/org/${org!.id}/tavle/rekkefolge`, { type, ider });
      await endret();
    });
  const slett = (r: Rad) =>
    h.kjor(async () => {
      if (!confirm(`Slette ${fase ? "fasen" : "oppgaven"} «${r.navn}»? Plassene i den forsvinner, også tidligere dager.`)) return;
      await api("DELETE", `/org/${org!.id}/tavle/${type}/${r.id}`);
      await endret();
    });
  const leggTilFaser = (faser: [string, string, string][]) =>
    h.kjor(async () => {
      for (const [navn, fra, til] of faser) await ny({ navn, fra, til });
      await endret();
    });
  const leggTilOppgave = (navn: string) =>
    h.kjor(async () => {
      await ny({ navn });
      await endret();
    });
  const ferdig = async () => {
    settRediger(null);
    await endret();
  };

  return (
    <section className="oppsett-del">
      <h3>{fase ? "Faser" : "Oppgaver"}</h3>
      <p className="liten dempet">
        {fase
          ? "Radene på tavla: dagen delt i vakter eller bolker. De ansatte hører til fasene vakten deres overlapper."
          : "Kolonnene på tavla: det de ansatte fordeles på. Behovet er hvor mange som trengs (valgfritt), og kan settes per fase under."}
      </p>
      {rader.length > 0 && (
        <ul className="liste-enkel oppsett-liste">
          {rader.map((r, i) =>
            rediger === r.id ? (
              <li key={r.id}>
                <RadSkjema type={type} rad={r} ferdig={ferdig} avbryt={() => settRediger(null)} />
              </li>
            ) : (
              <li key={r.id}>
                <span>
                  <span className="tittel">{r.navn}</span>{" "}
                  <span className="dempet">{fase ? (r.fra ? `${r.fra}–${r.til}` : "hele dagen") : r.behov ? `trenger ${r.behov}` : ""}</span>
                </span>
                <span className="knapper">
                  <button type="button" className="ikon" aria-label={`Flytt ${r.navn} opp`} title="Flytt opp" disabled={i === 0 || h.opptatt} onClick={() => flytt(i, i - 1)}>
                    <IkonOpp storrelse={16} />
                  </button>
                  <button
                    type="button"
                    className="ikon"
                    aria-label={`Flytt ${r.navn} ned`}
                    title="Flytt ned"
                    disabled={i === rader.length - 1 || h.opptatt}
                    onClick={() => flytt(i, i + 1)}
                  >
                    <IkonNed storrelse={16} />
                  </button>
                  <button type="button" onClick={() => settRediger(r.id)}>
                    Endre
                  </button>
                  <button type="button" className="fare" disabled={h.opptatt} onClick={() => slett(r)}>
                    Slett
                  </button>
                </span>
              </li>
            ),
          )}
        </ul>
      )}
      {rediger === "ny" ? (
        <RadSkjema type={type} ferdig={ferdig} avbryt={() => settRediger(null)} />
      ) : (
        <div className="knapper">
          <button type="button" onClick={() => settRediger("ny")}>
            <IkonPluss storrelse={16} /> {fase ? "Ny fase" : "Ny oppgave"}
          </button>
        </div>
      )}
      {fase && !rader.length && rediger !== "ny" && (
        <div className="forslag">
          <span className="liten dempet">Eller start med et forslag:</span>
          {FASEFORSLAG.map((f) => (
            <button key={f.navn} type="button" disabled={h.opptatt} title={f.faser.map(([n, fra, til]) => `${n} ${fra}–${til}`).join(", ")} onClick={() => leggTilFaser(f.faser)}>
              {f.navn}
            </button>
          ))}
        </div>
      )}
      {!fase && forslag.length > 0 && rediger !== "ny" && (
        <div className="forslag">
          <span className="liten dempet">Forslag:</span>
          {forslag.map((n) => (
            <button key={n} type="button" disabled={h.opptatt} onClick={() => leggTilOppgave(n)}>
              + {n}
            </button>
          ))}
        </div>
      )}
      <Feil melding={h.feil} />
    </section>
  );
}

function RadSkjema({ type, rad, ferdig, avbryt }: { type: "faser" | "oppgaver"; rad?: Rad; ferdig: () => void; avbryt: () => void }) {
  const { org } = useKonto();
  const fase = type === "faser";
  const [v, settV] = useState({ navn: rad?.navn ?? "", fra: rad?.fra ?? "", til: rad?.til ?? "", behov: rad?.behov ? String(rad.behov) : "" });
  const h = useHandling();
  const sett = (e: Partial<typeof v>) => settV({ ...v, ...e });

  async function lagre(e: FormEvent) {
    e.preventDefault();
    const behov = v.behov.trim() === "" ? null : tall(v.behov);
    if (behov !== null && !Number.isInteger(behov)) return h.settFeil("Skriv behovet som et helt tall");
    const kropp = fase ? { navn: v.navn.trim(), fra: v.fra || null, til: v.til || null } : { navn: v.navn.trim(), behov };
    const r = await h.kjor(async () => {
      if (rad) await api("PATCH", `/org/${org!.id}/tavle/${type}/${rad.id}`, kropp);
      else await api("POST", `/org/${org!.id}/tavle/${type}`, kropp);
      return true;
    });
    if (r) ferdig();
  }

  return (
    <form className="oppsett-skjema" onSubmit={lagre}>
      <div className={fase ? "rad fase-felt" : "rad"}>
        <label>
          Navn
          <input required autoFocus maxLength={40} placeholder={fase ? "F.eks. Forvakt" : "F.eks. Telefon"} value={v.navn} onChange={(e) => sett({ navn: e.target.value })} />
        </label>
        {fase ? (
          <>
            <label>
              Fra
              <input type="time" value={v.fra} onChange={(e) => sett({ fra: e.target.value })} />
            </label>
            <label>
              Til
              <input type="time" value={v.til} onChange={(e) => sett({ til: e.target.value })} />
            </label>
          </>
        ) : (
          <label>
            Behov (antall)
            <input inputMode="numeric" placeholder="Valgfritt" value={v.behov} onChange={(e) => sett({ behov: e.target.value })} />
          </label>
        )}
      </div>
      {fase && <p className="felt-hjelp oppsett-hjelp">Uten tid gjelder fasen hele dagen.</p>}
      <Feil melding={h.feil} />
      <div className="knapper">
        <button className="primar" disabled={h.opptatt}>
          {rad ? "Lagre" : "Legg til"}
        </button>
        <button type="button" onClick={avbryt}>
          Avbryt
        </button>
      </div>
    </form>
  );
}

// Behovet per fase: tomt felt er behovet på oppgaven, 0 at oppgaven ikke trengs i fasen.
function BehovPerFase({ faser, oppgaver, behov, endret }: { faser: Fase[]; oppgaver: Oppgave[]; behov: Behov[]; endret: () => Promise<void> }) {
  const { org } = useKonto();
  const [utkast, settUtkast] = useState<Record<string, string>>({});
  const h = useHandling();
  const satt = (f: string, o: string) => behov.find((b) => b.fase_id === f && b.oppgave_id === o)?.antall;

  function lagre(f: string, o: string, tekst: string) {
    const k = `${f}:${o}`;
    const antall = tekst.trim() === "" ? null : tall(tekst);
    if (antall !== null && !(Number.isInteger(antall) && antall >= 0 && antall <= 50)) return h.settFeil("Behovet er et helt tall fra 0 til 50");
    const ferdig = () =>
      settUtkast((u) => {
        const { [k]: _, ...resten } = u;
        return resten;
      });
    if (antall === (satt(f, o) ?? null)) return ferdig();
    h.kjor(async () => {
      await api("PUT", `/org/${org!.id}/tavle/behov`, { fase_id: f, oppgave_id: o, antall });
      await endret();
      ferdig();
    });
  }

  return (
    <section className="oppsett-del">
      <h3>Behov per fase</h3>
      <p className="liten dempet">Hvor mange som trengs i hver oppgave i hver fase. Tomt felt: som på oppgaven. 0: trengs ikke i fasen.</p>
      <div className="tabell">
        <table className="behov-tabell">
          <thead>
            <tr>
              <th>Fase</th>
              {oppgaver.map((o) => (
                <th key={o.id}>{o.navn}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {faser.map((f) => (
              <tr key={f.id}>
                <td>{f.navn}</td>
                {oppgaver.map((o) => {
                  const k = `${f.id}:${o.id}`;
                  const v = satt(f.id, o.id);
                  return (
                    <td key={o.id}>
                      <input
                        inputMode="numeric"
                        aria-label={`Behov for ${o.navn} i ${f.navn}`}
                        placeholder={o.behov ? String(o.behov) : "–"}
                        value={utkast[k] ?? (v === undefined ? "" : String(v))}
                        onChange={(e) => settUtkast({ ...utkast, [k]: e.target.value })}
                        onBlur={(e) => lagre(f.id, o.id, e.target.value)}
                        onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
                      />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Feil melding={h.feil} />
    </section>
  );
}
