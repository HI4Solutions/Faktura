// Rullering på tavla (server/src/rullering.ts): de som er på jobb i en periode, fordeles på
// oppgavene, så alle får gjøre alt etter tur, fra dag til dag og mellom fasene samme dag. Først
// vises et forslag, så lagres det; plassene rulleringen satte før i perioden, byttes ut, mens de
// som er satt for hånd, står. I oppsettet av tavla: hvem som kan ta hvilke oppgaver.
import { useState, type FormEvent } from "react";
import { api } from "../api";
import { Feil, useHandling } from "../felles";
import { useKonto } from "../konto";
import { leggTilDager } from "../format";
import { mandag, visDag } from "../uke";
import type { Ansatt } from "./Fravaer";

type Forslag = {
  fra: string;
  til: string;
  lagret: boolean;
  plasser: number;
  endret: number;
  faser: { id: string; navn: string }[];
  oppgaver: { id: string; navn: string }[];
  ansatte: { id: string; navn: string }[];
  dager: {
    dato: string;
    plasser: { fase_id: string; oppgave_id: string; ansatt_id: string; rullert: boolean }[];
    ikke_plassert: { fase_id: string; ansatt_id: string }[];
    mangler: { fase_id: string; oppgave_id: string; antall: number }[];
  }[];
};

const langDag = new Intl.DateTimeFormat("nb-NO", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
const visLangDag = (iso: string) => {
  const t = langDag.format(new Date(`${iso}T12:00:00Z`));
  return t.charAt(0).toUpperCase() + t.slice(1);
};
// «fra man. 9. nov.» slutter med punktum; da trengs ikke et til.
const medPunktum = (s: string) => (s.endsWith(".") ? s : `${s}.`);
const periodeTekst = (fra: string, til: string) =>
  fra === til ? `for ${visDag(fra).toLowerCase()}` : `fra ${visDag(fra).toLowerCase()} til ${visDag(til).toLowerCase()}`;

export function Rullering({ dato, ferdig, avbryt }: { dato: string; ferdig: (melding: string) => void; avbryt: () => void }) {
  const { org } = useKonto();
  const [fra, settFra] = useState(dato);
  const [til, settTil] = useState(dato);
  const [bytt, settBytt] = useState(true);
  const [behold, settBehold] = useState(true);
  const [forslag, settForslag] = useState<Forslag | null>(null);
  const h = useHandling();
  const kropp = { fra, til, behold, samme_hele_dagen: !bytt };
  const man = mandag(dato);
  const valg: [string, string, string][] = [
    ["Denne dagen", dato, dato],
    ["Ut uka", dato, leggTilDager(man, 6)],
    ["Neste uke", leggTilDager(man, 7), leggTilDager(man, 13)],
    ["Fire uker", dato, leggTilDager(dato, 27)],
  ];

  async function vis(e: FormEvent) {
    e.preventDefault();
    const r = await h.kjor(() => api<Forslag>("POST", `/org/${org!.id}/tavle/rullering`, kropp));
    if (r) settForslag(r);
  }
  async function lagre() {
    const r = await h.kjor(() => api<Forslag>("POST", `/org/${org!.id}/tavle/rullering`, { ...kropp, lagre: true }));
    if (!r) return;
    const periode = periodeTekst(r.fra, r.til);
    ferdig(
      r.plasser
        ? medPunktum(`Rulleringen er lagret: ${r.plasser} ${r.plasser === 1 ? "plass" : "plasser"} ${periode}`)
        : medPunktum(`Ingen å fordele ${periode}`),
    );
  }

  if (forslag) return <Forhandsvisning forslag={forslag} opptatt={h.opptatt} feil={h.feil} lagre={lagre} tilbake={() => settForslag(null)} />;

  return (
    <form onSubmit={vis} className="rullering-skjema">
      <p className="dempet" style={{ marginTop: 0 }}>
        De som er på jobb, fordeles på oppgavene, så alle får gjøre alt etter tur. Behovet i hver oppgave fylles først, og den som har hatt en oppgave minst i det
        siste, får den. Du ser forslaget før det lagres.
      </p>
      <div className="rad">
        <label>
          Fra
          <input type="date" required value={fra} onChange={(e) => settFra(e.target.value)} />
        </label>
        <label>
          Til
          <input type="date" required min={fra} value={til} onChange={(e) => settTil(e.target.value)} />
        </label>
      </div>
      <div className="forslag rullering-valg">
        {valg.map(([navn, f, t]) => (
          <button
            key={navn}
            type="button"
            className={f === fra && t === til ? "valgt" : undefined}
            aria-pressed={f === fra && t === til}
            onClick={() => {
              settFra(f);
              settTil(t);
            }}
          >
            {navn}
          </button>
        ))}
      </div>
      <label>
        <input type="checkbox" checked={bytt} onChange={(e) => settBytt(e.target.checked)} />
        Bytt oppgave mellom fasene samme dag
        <span className="felt-hjelp">Faser som overlapper i tid, får alltid samme oppgave. Uten kryss har hver ansatt samme oppgave hele dagen, og byttet skjer fra dag til dag.</span>
      </label>
      <label>
        <input type="checkbox" checked={behold} onChange={(e) => settBehold(e.target.checked)} />
        Behold plassene som er satt for hånd
        <span className="felt-hjelp">Rulleringen fyller ut rundt dem. Plassene rulleringen har satt før, byttes alltid ut.</span>
      </label>
      <Feil melding={h.feil} />
      <div className="knapper">
        <button className="primar" disabled={h.opptatt || til < fra}>
          Vis forslag
        </button>
        <button type="button" onClick={avbryt}>
          Avbryt
        </button>
      </div>
    </form>
  );
}

function Forhandsvisning({ forslag, opptatt, feil, lagre, tilbake }: { forslag: Forslag; opptatt: boolean; feil: string | null; lagre: () => void; tilbake: () => void }) {
  const navn = new Map(forslag.ansatte.map((a) => [a.id, a.navn]));
  const dager = forslag.dager.filter((d) => d.plasser.length || d.ikke_plassert.length || d.mangler.length);
  const mangler = forslag.dager.reduce((s, d) => s + d.mangler.reduce((x, m) => x + m.antall, 0), 0);
  const ikke = forslag.dager.reduce((s, d) => s + d.ikke_plassert.length, 0);
  const harIkke = ikke > 0;
  const kolonner = forslag.oppgaver.length + (harIkke ? 2 : 1);
  // Hvor mange plasser hver ansatt får i hver oppgave i perioden (også de som står).
  const fordeling = forslag.ansatte
    .map((a) => ({ ...a, per: forslag.oppgaver.map((o) => forslag.dager.reduce((s, d) => s + d.plasser.filter((p) => p.ansatt_id === a.id && p.oppgave_id === o.id).length, 0)) }))
    .filter((a) => a.per.some((n) => n > 0));
  const person = (id: string, satt = false) => (
    <span key={id} className={`rullering-navn${satt ? " satt" : ""}`} title={satt ? "Satt for hånd" : undefined}>
      {navn.get(id) ?? "Ukjent"}
    </span>
  );

  return (
    <div className="rullering-forslag">
      <p className="rullering-sum">
        <span>
          <strong>{forslag.plasser}</strong> {forslag.plasser === 1 ? "plass" : "plasser"} {periodeTekst(forslag.fra, forslag.til)}
        </span>
        <span>{forslag.endret ? `${forslag.endret} ${forslag.endret === 1 ? "plass blir" : "plasser blir"} annerledes enn nå` : "Ingen endringer fra det som står nå"}</span>
        {mangler > 0 && <span className="fare">Behovet mangler {mangler === 1 ? "én plass" : `${mangler} plasser`}</span>}
        {harIkke && <span>{ikke === 1 ? "Én plass" : `${ikke} plasser`} uten oppgave (behovet er dekket)</span>}
      </p>
      {!dager.length ? (
        <div className="melding info">Ingen er på jobb i perioden. Ressursene hentes fra vaktplanen og de faste arbeidsdagene.</div>
      ) : (
        <div className="tabell rullering-tabell">
          <table className="stabel">
            <thead>
              <tr>
                <th>Fase</th>
                {forslag.oppgaver.map((o) => (
                  <th key={o.id}>{o.navn}</th>
                ))}
                {harIkke && <th>Uten oppgave</th>}
              </tr>
            </thead>
            {dager.map((d) => (
              <tbody key={d.dato}>
                <tr className="rullering-dag">
                  <th colSpan={kolonner} scope="rowgroup">
                    {visLangDag(d.dato)}
                  </th>
                </tr>
                {forslag.faser.map((f) => {
                  const her = d.plasser.filter((p) => p.fase_id === f.id);
                  const uten = d.ikke_plassert.filter((p) => p.fase_id === f.id);
                  const mangel = d.mangler.filter((m) => m.fase_id === f.id);
                  if (!her.length && !uten.length && !mangel.length) return null;
                  return (
                    <tr key={f.id}>
                      <td className="hel tittel">{f.navn}</td>
                      {forslag.oppgaver.map((o) => {
                        const folk = her.filter((p) => p.oppgave_id === o.id);
                        const m = mangel.find((x) => x.oppgave_id === o.id);
                        return (
                          <td key={o.id} data-label={o.navn}>
                            {folk.map((p) => person(p.ansatt_id, !p.rullert))}
                            {m && <span className="rullering-mangler">Mangler {m.antall}</span>}
                            {!folk.length && !m && <span className="dempet">–</span>}
                          </td>
                        );
                      })}
                      {harIkke && <td data-label="Uten oppgave">{uten.length ? uten.map((p) => person(p.ansatt_id)) : <span className="dempet">–</span>}</td>}
                    </tr>
                  );
                })}
              </tbody>
            ))}
          </table>
        </div>
      )}
      {fordeling.length > 0 && (
        <details className="rullering-fordeling">
          <summary>Fordelingen per ansatt</summary>
          <div className="tabell">
            <table>
              <thead>
                <tr>
                  <th>Ansatt</th>
                  {forslag.oppgaver.map((o) => (
                    <th key={o.id} className="tall">
                      {o.navn}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {fordeling.map((a) => (
                  <tr key={a.id}>
                    <td>{a.navn}</td>
                    {a.per.map((n, i) => (
                      <td key={forslag.oppgaver[i]!.id} className="tall">
                        {n || <span className="dempet">0</span>}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
      <p className="liten dempet">Navn med stiplet strek er satt for hånd og står. Plassene kan flyttes på tavla etterpå.</p>
      <Feil melding={feil} />
      <div className="knapper">
        <button type="button" className="primar" disabled={opptatt || !forslag.plasser} onClick={lagre}>
          Lagre rulleringen
        </button>
        <button type="button" onClick={tilbake}>
          Endre valgene
        </button>
      </div>
    </div>
  );
}

// Hvem rulleringen kan sette i hvilke oppgaver (alle kan, til krysset tas bort). «Med» tar den
// ansatte inn i eller ut av alle oppgavene på en gang.
export function HvemKan({
  oppgaver,
  ansatte,
  utelatt,
  faste,
  endret,
}: {
  oppgaver: { id: string; navn: string }[];
  ansatte: Ansatt[];
  utelatt: { oppgave_id: string; ansatt_id: string }[];
  // De faste oppgavene (0059_tavle_fast_oppgave.sql): de rulleres ikke.
  faste: { ansatt_id: string; oppgave_id: string }[];
  endret: () => Promise<void>;
}) {
  const { org } = useKonto();
  const h = useHandling();
  // Endringene vises med en gang; tavla hentes på nytt i bakgrunnen.
  const [ute, settUte] = useState(() => new Set(utelatt.map((u) => `${u.ansatt_id}|${u.oppgave_id}`)));
  const [fast, settFast] = useState(() => new Map(faste.map((x) => [x.ansatt_id, x.oppgave_id])));
  const aktive = ansatte.filter((a) => a.aktiv);

  async function settFastOppgave(ansatt: string, oppgave: string | null) {
    const forrige = fast;
    const neste = new Map(fast);
    if (oppgave) neste.set(ansatt, oppgave);
    else neste.delete(ansatt);
    settFast(neste);
    const ok = await h.kjor(async () => {
      await api("PUT", `/org/${org!.id}/tavle/fast-oppgave`, { ansatt_id: ansatt, oppgave_id: oppgave });
      return true;
    });
    if (!ok) settFast(forrige);
    else void endret();
  }

  async function sett(ansatt: string, oppgave: string | undefined, kan: boolean) {
    const forrige = ute;
    const neste = new Set(ute);
    for (const o of oppgave ? [oppgave] : oppgaver.map((x) => x.id)) {
      if (kan) neste.delete(`${ansatt}|${o}`);
      else neste.add(`${ansatt}|${o}`);
    }
    settUte(neste);
    const ok = await h.kjor(async () => {
      await api("PUT", `/org/${org!.id}/tavle/utelatt`, { ansatt_id: ansatt, oppgave_id: oppgave, kan });
      return true;
    });
    if (!ok) settUte(forrige);
    else void endret();
  }

  if (!aktive.length) return null;
  return (
    <section className="oppsett-del">
      <h3>Hvem kan ta oppgavene</h3>
      <p className="liten dempet">
        For rulleringen: den ansatte settes bare i oppgavene med kryss. Uten kryss ved «Med» er den ansatte ikke med i rulleringen. Med en fast oppgave står den
        ansatte der hver dag uten en annen plass, og rulleringen setter dem alltid der. For hånd kan alle plasseres hvor som helst.
      </p>
      <div className="tabell">
        <table className="hvem-kan">
          <thead>
            <tr>
              <th>Ansatt</th>
              <th>Med</th>
              {oppgaver.map((o) => (
                <th key={o.id}>{o.navn}</th>
              ))}
              <th>Fast oppgave</th>
            </tr>
          </thead>
          <tbody>
            {aktive.map((a) => {
              const navn = `${a.fornavn} ${a.etternavn}`;
              const kan = oppgaver.map((o) => !ute.has(`${a.id}|${o.id}`));
              const noe = kan.some(Boolean);
              const harFast = fast.get(a.id) ?? "";
              return (
                <tr key={a.id} className={noe || harFast ? undefined : "utenfor"} title={harFast ? "Fast oppgave: rulleres ikke" : undefined}>
                  <td>{navn}</td>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`${navn} er med i rulleringen`}
                      checked={noe}
                      disabled={!!harFast}
                      ref={(el) => {
                        if (el) el.indeterminate = noe && !kan.every(Boolean);
                      }}
                      onChange={(e) => sett(a.id, undefined, e.target.checked)}
                    />
                  </td>
                  {oppgaver.map((o, i) => (
                    <td key={o.id}>
                      <input
                        type="checkbox"
                        aria-label={`${navn} kan ta ${o.navn}`}
                        checked={kan[i]}
                        disabled={!!harFast}
                        onChange={(e) => sett(a.id, o.id, e.target.checked)}
                      />
                    </td>
                  ))}
                  <td>
                    <select className="fast-valg" value={harFast} aria-label={`Fast oppgave for ${navn}`} onChange={(e) => settFastOppgave(a.id, e.target.value || null)}>
                      <option value="">Ingen</option>
                      {oppgaver.map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.navn}
                        </option>
                      ))}
                    </select>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <Feil melding={h.feil} />
    </section>
  );
}
