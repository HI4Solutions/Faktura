// Beskjeder (server/src/beskjeder.ts, 0062_beskjeder.sql): alle i organisasjonen kan legge en
// beskjed til én eller flere roller (f.eks. legene), eller til alle, eventuelt med push-varsel til
// dem det gjelder. Beskjedene står med de nyeste øverst, dag for dag, og de som er nye siden sist,
// er merket. Siden henter beskjedene på nytt mens den er åpen; telleren i menyen
// (useUlesteBeskjeder) viser hvor mange som er nye.
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useLocation } from "react-router-dom";
import { api, hent } from "../api";
import { Feil, Laster, Tom, useData, useHandling, useNarDataEndres } from "../felles";
import { useKonto } from "../konto";
import { IkonBjelle } from "../ikoner";
import { iDag, leggTilDager } from "../format";
import { visDag } from "../uke";

type Beskjed = {
  id: string;
  tekst: string;
  roller: string[]; // tom: til alle
  push: boolean;
  forfatter_navn: string;
  opprettet: string;
  egen: boolean;
  kan_slette: boolean;
  ny: boolean; // fra en annen, etter at du sist så beskjedene
};
type Rolle = { id: string; navn: string };
type Svar = { beskjeder: Beskjed[]; roller: Rolle[] };

// Beskjedene er lest: telleren i menyen nullstilles.
const LEST = "hi4:beskjeder-lest";
const MAKS = 2000;

const osloDato = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Oslo" }); // «2026-10-08»
const klokka = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "Europe/Oslo" }); // «14:05»
const dagen = (iso: string) => osloDato.format(new Date(iso));
function dagTittel(d: string) {
  if (d === iDag()) return "I dag";
  if (d === leggTilDager(iDag(), -1)) return "I går";
  return `${visDag(d)}${d.slice(0, 4) !== iDag().slice(0, 4) ? ` ${d.slice(0, 4)}` : ""}`;
}

// Hvor mange beskjeder som er nye for den innloggede (telleren i menyen). Hentes når appen åpnes
// og kommer fram igjen, og hvert andre minutt; nullstilles når beskjedene leses.
export function useUlesteBeskjeder(orgId: string | undefined, aktiv: boolean) {
  const [uleste, settUleste] = useState(0);
  useEffect(() => {
    settUleste(0);
    if (!orgId || !aktiv) return;
    let nr = 0; // svar på en henting fra før beskjedene ble lest, gjelder ikke
    const sjekk = () => {
      if (document.visibilityState !== "visible") return;
      const mitt = ++nr;
      hent<{ uleste: number }>(`/org/${orgId}/beskjeder/uleste`)
        .then((s) => mitt === nr && settUleste(s.uleste))
        .catch(() => {});
    };
    const lest = () => {
      nr++;
      settUleste(0);
    };
    sjekk();
    const tid = window.setInterval(sjekk, 120_000);
    document.addEventListener("visibilitychange", sjekk);
    window.addEventListener(LEST, lest);
    return () => {
      nr++;
      clearInterval(tid);
      document.removeEventListener("visibilitychange", sjekk);
      window.removeEventListener(LEST, lest);
    };
  }, [orgId, aktiv]);
  return uleste;
}

export function Beskjeder() {
  const { org } = useKonto();
  const sted = useLocation();
  // De som var nye da siden ble åpnet (eller kom mens den var åpen), forblir merket.
  const [nye, settNye] = useState<Set<string>>(new Set());
  // Henter beskjedene og merker dem som lest (telleren i menyen nullstilles).
  const hentOgLes = async () => {
    const s = await hent<Svar>(`/org/${org!.id}/beskjeder`);
    const ny = s.beskjeder.filter((b) => b.ny).map((b) => b.id);
    if (ny.length) settNye((n) => new Set([...n, ...ny]));
    api("POST", `/org/${org!.id}/beskjeder/lest`, {}).then(
      () => window.dispatchEvent(new Event(LEST)),
      () => {},
    );
    return s;
  };
  const { data, feil, settData } = useData(hentOgLes, [org?.id]);

  // Nye beskjeder mens siden er åpen: hent på nytt hvert minutt, når appen kommer fram igjen, og
  // når et push-varsel åpner siden (samme adresse, ny navigasjon). Uten feilmelding (f.eks. uten
  // nett), og et svar som kommer etter en endring her (ny eller slettet beskjed), gjelder ikke.
  const nr = useRef(0);
  const oppdater = useRef(() => {});
  oppdater.current = () => {
    const mitt = ++nr.current;
    hentOgLes().then(
      (s) => mitt === nr.current && settData(s),
      () => {},
    );
  };
  useEffect(() => {
    const igjen = () => document.visibilityState === "visible" && oppdater.current();
    const tid = window.setInterval(igjen, 60_000);
    document.addEventListener("visibilitychange", igjen);
    return () => {
      clearInterval(tid);
      document.removeEventListener("visibilitychange", igjen);
    };
  }, []);
  const nokkel = useRef(sted.key);
  useEffect(() => {
    if (nokkel.current === sted.key) return;
    nokkel.current = sted.key;
    oppdater.current();
  }, [sted.key]);
  useNarDataEndres(() => oppdater.current());
  const endre = (fn: (b: Beskjed[]) => Beskjed[]) => {
    nr.current++;
    settData((d) => (d ? { ...d, beskjeder: fn(d.beskjeder) } : d));
  };

  if (!org) return null;
  return (
    <>
      <div className="topp">
        <h1>Beskjeder</h1>
      </div>
      {!data ? (
        feil ? <Feil melding={feil} /> : <Laster />
      ) : (
        <>
          <NyBeskjed roller={data.roller} lagt={(b) => endre((l) => [b, ...l.filter((x) => x.id !== b.id)])} />
          <Liste svar={data} nye={nye} slettet={(id) => endre((l) => l.filter((x) => x.id !== id))} />
        </>
      )}
    </>
  );
}

function NyBeskjed({ roller, lagt }: { roller: Rolle[]; lagt: (b: Beskjed) => void }) {
  const { org } = useKonto();
  const [tekst, settTekst] = useState("");
  const [til, settTil] = useState<string[]>([]); // tom: alle
  const [push, settPush] = useState(false);
  const h = useHandling();
  const veksle = (id: string) => settTil((t) => (t.includes(id) ? t.filter((x) => x !== id) : [...t, id]));

  async function legg(e?: FormEvent) {
    e?.preventDefault();
    if (!tekst.trim() || h.opptatt) return;
    const b = await h.kjor(() => api<Beskjed>("POST", `/org/${org!.id}/beskjeder`, { tekst: tekst.trim(), roller: til, push }));
    if (!b) return;
    lagt(b);
    settTekst("");
    settTil([]);
    settPush(false);
  }

  return (
    <form className="kort beskjed-ny" onSubmit={legg}>
      <textarea
        aria-label="Ny beskjed"
        rows={3}
        maxLength={MAKS}
        placeholder="Skriv en beskjed …"
        value={tekst}
        onChange={(e) => settTekst(e.target.value)}
        // Ctrl/⌘ + Enter legger den ut (Enter alene er ny linje).
        onKeyDown={(e) => e.key === "Enter" && (e.ctrlKey || e.metaKey) && void legg()}
      />
      {tekst.length > MAKS - 200 && <span className="felt-hjelp">{MAKS - tekst.length} tegn igjen</span>}
      {roller.length > 0 && (
        <div className="beskjed-til" role="group" aria-label="Hvem beskjeden er til">
          <span>Til</span>
          <button type="button" aria-pressed={til.length === 0} onClick={() => settTil([])}>
            Alle
          </button>
          {roller.map((r) => (
            <button key={r.id} type="button" aria-pressed={til.includes(r.id)} onClick={() => veksle(r.id)}>
              {r.navn}
            </button>
          ))}
        </div>
      )}
      <Feil melding={h.feil} />
      <div className="beskjed-send">
        <label>
          <input type="checkbox" checked={push} onChange={(e) => settPush(e.target.checked)} />
          Send push-varsel
        </label>
        <button className="primar" disabled={h.opptatt || !tekst.trim()}>
          Legg ut
        </button>
      </div>
    </form>
  );
}

function Liste({ svar, nye, slettet }: { svar: Svar; nye: Set<string>; slettet: (id: string) => void }) {
  const { org } = useKonto();
  const h = useHandling();
  const indeks = new Map(svar.roller.map((r, i) => [r.id, i]));

  async function slett(b: Beskjed) {
    if (!confirm(b.egen ? "Slette beskjeden din?" : `Slette beskjeden fra ${b.forfatter_navn || "den som skrev den"}?`)) return;
    const ok = await h.kjor(async () => {
      await api("DELETE", `/org/${org!.id}/beskjeder/${b.id}`);
      return true;
    });
    if (ok) slettet(b.id);
  }

  if (!svar.beskjeder.length)
    return (
      <div className="kort">
        <Tom ikon={<IkonBjelle storrelse={22} />} tittel="Ingen beskjeder ennå">
          <p>Skriv en beskjed til en rolle eller til alle. Med push-varsel får de det med en gang på telefonen.</p>
        </Tom>
      </div>
    );

  // Dag for dag, de nyeste øverst.
  const dager: { dag: string; beskjeder: Beskjed[] }[] = [];
  for (const b of svar.beskjeder) {
    const d = dagen(b.opprettet);
    if (dager.at(-1)?.dag !== d) dager.push({ dag: d, beskjeder: [] });
    dager.at(-1)!.beskjeder.push(b);
  }

  return (
    <>
      <Feil melding={h.feil} />
      {dager.map(({ dag, beskjeder }) => (
        <section key={dag} className="beskjed-dag">
          <h2>{dagTittel(dag)}</h2>
          <div className="kort liste">
            {beskjeder.map((b) => {
              const roller = b.roller.filter((r) => indeks.has(r));
              return (
                <article key={b.id} className={`beskjed${nye.has(b.id) ? " ny" : ""}`}>
                  <div className="beskjed-topp">
                    <strong>{b.egen ? "Du" : b.forfatter_navn || "Ukjent"}</strong>
                    <time dateTime={b.opprettet}>{klokka.format(new Date(b.opprettet))}</time>
                    {b.push && (
                      <span className="beskjed-push" title="Sendt med push-varsel" aria-label="Sendt med push-varsel" role="img">
                        <IkonBjelle storrelse={13} />
                      </span>
                    )}
                    {nye.has(b.id) && <span className="merke merke-info">Ny</span>}
                  </div>
                  <p className="beskjed-tekst">{b.tekst}</p>
                  <div className="beskjed-bunn">
                    <span className="beskjed-mottakere" aria-label="Til">
                      {b.roller.length === 0 ? (
                        <span className="beskjed-rolle alle">Alle</span>
                      ) : roller.length ? (
                        roller.map((r) => (
                          <span key={r} className={`beskjed-rolle g${indeks.get(r)! % 5}`}>
                            {svar.roller[indeks.get(r)!]!.navn}
                          </span>
                        ))
                      ) : (
                        <span className="beskjed-rolle alle">En rolle som er slettet</span>
                      )}
                    </span>
                    {b.kan_slette && (
                      <button type="button" className="lenke" disabled={h.opptatt} onClick={() => slett(b)}>
                        Slett
                      </button>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        </section>
      ))}
      {svar.beskjeder.length >= 200 && <p className="liten dempet">Viser de 200 nyeste beskjedene.</p>}
    </>
  );
}
