import { useState, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { api, hent } from "../api";
import { AvsenderKonto, useFasteValg } from "./AvsenderKonto";
import { fraProdukt, harRabatt, lesMakstak, NotatFelt, RabattKnapp, tallTekst, tilTallLinjer, tilUtkast, tomLinje, useLinjefeil, type LinjeUtkast } from "../linjer";
import { Dialog, EpostlisteFelt, Feil, Laster, tall, tilEpostliste, ugyldigeEposter, useData, useHandling, useSmal } from "../felles";
import { kundeValg, produktValg, Sokefelt } from "../sokefelt";
import { harFunksjon, kanSkrive, useKonto } from "../konto";
import { dato, iDag, kr, summerMedMakstak } from "../format";
import { Paaminnelser } from "./Paaminnelser";
import { Fakturameny } from "../fakturameny";

const intervallTekst: Record<string, string> = { maaned: "Hver måned", kvartal: "Hvert kvartal", aar: "Hvert år" };

// To faner: gjentakende fakturaer (sendes av seg selv) og påminnelser (for fakturaer man lager
// selv, for eksempel når beløpet varierer). Fanen står i adressen (?fane=paaminnelser).
export function Gjentakende() {
  const { org } = useKonto();
  const [sok, settSok] = useSearchParams();
  // Bare fanene organisasjonen har funksjonene til (funksjonene i Administrasjon).
  const synlige = (
    [
      ["fakturaer", "Gjentakende fakturaer", harFunksjon(org, "gjentakende")],
      ["paaminnelser", "Påminnelser", harFunksjon(org, "paaminnelser")],
    ] as const
  ).filter(([, , vis]) => vis);
  const fane = synlige.some(([v]) => v === "paaminnelser") && (sok.get("fane") === "paaminnelser" || !synlige.some(([v]) => v === "fakturaer")) ? "paaminnelser" : "fakturaer";
  const faner = synlige.length < 2 ? null : (
    <div className="faner" role="tablist">
      {synlige.map(([v, t]) => (
        <button key={v} role="tab" aria-selected={fane === v} className={fane === v ? "valgt" : ""} onClick={() => settSok(v === "fakturaer" ? {} : { fane: v }, { replace: true })}>
          {t}
        </button>
      ))}
    </div>
  );
  return (
    <>
      <Fakturameny />
      {fane === "paaminnelser" ? <Paaminnelser faner={faner} /> : <GjentakendeFakturaer faner={faner} />}
    </>
  );
}

function GjentakendeFakturaer({ faner }: { faner: ReactNode }) {
  const { org } = useKonto();
  const nav = useNavigate();
  const { data, feil, last } = useData(() => hent<any[]>(`/org/${org!.id}/gjentakelser`), [org?.id]);
  const [redigerer, settRedigerer] = useState<any | null>(null);
  const h = useHandling();
  const smal = useSmal();

  if (feil || !data)
    return (
      <>
        <div className="topp">
          <h1>Gjentakende</h1>
        </div>
        {faner}
        {feil ? <Feil melding={feil} /> : <Laster />}
      </>
    );

  return (
    <>
      <div className="topp">
        <h1>Gjentakende</h1>
        {kanSkrive(org?.rolle) && (
          <button className="primar" onClick={() => settRedigerer({})}>
            Ny gjentakelse
          </button>
        )}
      </div>
      {faner}
      <p className="dempet">
        Fakturaene lages og sendes automatisk hver morgen, så mange dager før forfall som du velger. Varierer beløpet fra gang til gang? Lag en{" "}
        <Link to="/gjentakende?fane=paaminnelser">påminnelse</Link> i stedet.
      </p>
      <Feil melding={h.feil} />
      {smal ? (
        <div className="kort liste">
          {data.map((g) => {
            const sum = summerMedMakstak(g.linjer.map((l: any) => ({ antall: l.antall ?? 1, enhetspris: l.enhetspris, mva_sats: l.mva_sats ?? 25, rabatt_prosent: l.rabatt_prosent, rabatt_belop: l.rabatt_belop })), g.makstak);
            const apne = () => kanSkrive(org?.rolle) && settRedigerer(g);
            return (
              <div key={g.id} className="liste-rad" role="button" tabIndex={0} onClick={apne} onKeyDown={(e) => e.key === "Enter" && apne()}>
                <span className="linje">
                  <span className="tittel">{g.kunde_navn}</span>
                  <span className="belop">{kr(sum.inkl)}</span>
                </span>
                <span className="linje">
                  <span className="under">
                    {intervallTekst[g.intervall]} · forfall {dato(g.neste_forfall)}
                  </span>
                  <span className={`merke ${g.aktiv ? "merke-ok" : "merke-noytral"}`}>{g.aktiv ? "Aktiv" : "Stoppet"}</span>
                </span>
                {g.aktiv && (
                  <span className="linje">
                    <span className="under">Sendes {dato(g.neste_dato)}</span>
                    {kanSkrive(org?.rolle) && (
                      <button
                        className="lenke"
                        disabled={h.opptatt}
                        onClick={async (e) => {
                          e.stopPropagation();
                          if (!confirm("Lage og sende neste faktura nå? Neste forfall flyttes én periode fram.")) return;
                          const f = await h.kjor(() => api("POST", `/org/${org!.id}/gjentakelser/${g.id}/kjor`));
                          if (f) nav(`/fakturaer/${f.id}`);
                        }}
                      >
                        Send nå
                      </button>
                    )}
                  </span>
                )}
              </div>
            );
          })}
          {data.length === 0 && <p className="dempet" style={{ padding: 16 }}>Ingen gjentakende fakturaer ennå.</p>}
        </div>
      ) : (
      <div className="kort tabell">
        <table>
          <thead>
            <tr>
              <th>Kunde</th>
              <th>Intervall</th>
              <th className="hoyre">Beløp inkl. mva</th>
              <th>Neste forfall</th>
              <th>Sendes</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {data.map((g) => {
              const sum = summerMedMakstak(g.linjer.map((l: any) => ({ antall: l.antall ?? 1, enhetspris: l.enhetspris, mva_sats: l.mva_sats ?? 25, rabatt_prosent: l.rabatt_prosent, rabatt_belop: l.rabatt_belop })), g.makstak);
              return (
                <tr key={g.id} className="klikkbar" onClick={() => kanSkrive(org?.rolle) && settRedigerer(g)}>
                  <td>{g.kunde_navn}</td>
                  <td>{intervallTekst[g.intervall]}</td>
                  <td className="tall">{kr(sum.inkl)}</td>
                  <td>{dato(g.neste_forfall)}</td>
                  <td>{g.aktiv ? dato(g.neste_dato) : "–"}</td>
                  <td>
                    <span className={`merke ${g.aktiv ? "merke-ok" : "merke-noytral"}`}>{g.aktiv ? "Aktiv" : "Stoppet"}</span>
                  </td>
                  <td className="hoyre" onClick={(e) => e.stopPropagation()}>
                    {kanSkrive(org?.rolle) && g.aktiv && (
                      <button
                        className="lenke"
                        disabled={h.opptatt}
                        onClick={async () => {
                          if (!confirm("Lage og sende neste faktura nå? Neste forfall flyttes én periode fram.")) return;
                          const f = await h.kjor(() => api("POST", `/org/${org!.id}/gjentakelser/${g.id}/kjor`));
                          if (f) nav(`/fakturaer/${f.id}`);
                        }}
                      >
                        Send nå
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
            {data.length === 0 && (
              <tr>
                <td colSpan={7} className="dempet">
                  Ingen gjentakende fakturaer ennå.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      )}
      <Dialog bred apen={!!redigerer} lukk={() => settRedigerer(null)} tittel={redigerer?.id ? "Endre gjentakelse" : "Ny gjentakelse"}>
        <Skjema
          g={redigerer}
          ferdig={() => {
            settRedigerer(null);
            last();
          }}
        />
      </Dialog>
    </>
  );
}

function Skjema({ g, ferdig }: { g: any; ferdig: () => void }) {
  const { org } = useKonto();
  const kunder = useData(() => hent<any[]>(`/org/${org!.id}/kunder?aktiv=true`), [org?.id]);
  const produkter = useData(() => hent<any[]>(`/org/${org!.id}/produkter?aktiv=true`), [org?.id]);
  const orgData = useData(() => hent(`/org/${org!.id}`), [org?.id]);
  const [f, settF] = useState<any>({
    kunde_id: g.kunde_id ?? "",
    intervall: g.intervall ?? "maaned",
    neste_forfall: g.neste_forfall ?? "",
    send_dager_foer: g.send_dager_foer ?? "",
    slutt_dato: g.slutt_dato ?? "",
    deres_referanse: g.deres_referanse ?? "",
    aktiv: g.aktiv ?? true,
    konto_id: g.konto_id ?? null,
    avsender: g.avsender ?? null,
    kommentar: g.kommentar ?? "",
  });
  const [linjer, settLinjer] = useState<LinjeUtkast[]>(g.linjer?.map(tilUtkast) ?? [tomLinje()]);
  const [kopi, settKopi] = useState((g.kopi_til ?? []).join(", "));
  // Makstak for fakturaene: følger kunden når den velges, og kan fjernes eller endres.
  const [makstak, settMakstak] = useState(g.makstak != null ? tallTekst(g.makstak) : "");
  const tak = lesMakstak(makstak);
  const [rabattValgt, settRabattValgt] = useState(false);
  const visRabatt = rabattValgt || harRabatt(linjer);
  const h = useHandling();
  const utenMva = Boolean(orgData.data && !orgData.data.mva_registrert);
  const settL = (i: number, e: Partial<LinjeUtkast>) => settLinjer(linjer.map((l, j) => (j === i ? { ...l, ...e } : l)));
  // Produkter med fast avsender eller konto velger dem når de legges på.
  const ulikeFasteValg = useFasteValg(linjer, produkter.data, true, (v) => settF((x: any) => ({ ...x, ...v })));
  const sjekkLinjer = useLinjefeil(linjer, h.settFeil);

  async function lagre(e: FormEvent) {
    e.preventDefault();
    if (!f.kunde_id) return h.settFeil("Velg kunde.");
    const ugyldige = ugyldigeEposter(kopi);
    if (ugyldige.length) return h.settFeil(`Ugyldig e-postadresse for kopi: ${ugyldige.join(", ")}`);
    if (sjekkLinjer()) return;
    if (tak.feil) return h.settFeil(tak.feil);
    const neste = f.neste_forfall;
    const kropp = {
      kunde_id: f.kunde_id,
      intervall: f.intervall,
      neste_forfall: neste,
      forfall_dag: Number(neste.slice(8, 10)),
      send_dager_foer: f.send_dager_foer === "" ? undefined : Number(f.send_dager_foer),
      slutt_dato: f.slutt_dato || null,
      deres_referanse: f.deres_referanse || null,
      aktiv: f.aktiv,
      konto_id: f.konto_id ?? null,
      avsender: f.avsender ?? null,
      kommentar: f.kommentar.trim() || null,
      kopi_til: tilEpostliste(kopi),
      makstak: tak.tak,
      linjer: tilTallLinjer(linjer, utenMva),
    };
    const r = await h.kjor(() => (g.id ? api("PATCH", `/org/${org!.id}/gjentakelser/${g.id}`, kropp) : api("POST", `/org/${org!.id}/gjentakelser`, kropp)));
    if (r) ferdig();
  }

  if (!kunder.data || !produkter.data) return <Laster />;

  return (
    <form onSubmit={lagre}>
      <label>
        Kunde
        <Sokefelt
          etikett="Kunde"
          valg={kundeValg(kunder.data)}
          verdi={f.kunde_id || null}
          velg={(id) => {
            settF({ ...f, kunde_id: id ?? "" });
            const k = kunder.data!.find((x) => x.id === id);
            settMakstak(k?.makstak != null ? tallTekst(k.makstak) : "");
          }}
          plassholder="Søk kunde"
        />
      </label>
      <div className="rad">
        <label>
          Intervall
          <select value={f.intervall} onChange={(e) => settF({ ...f, intervall: e.target.value })}>
            <option value="maaned">Hver måned</option>
            <option value="kvartal">Hvert kvartal</option>
            <option value="aar">Hvert år</option>
          </select>
        </label>
        <label>
          Neste forfall
          <input type="date" required min={iDag()} value={f.neste_forfall} onChange={(e) => settF({ ...f, neste_forfall: e.target.value })} />
        </label>
        <label>
          Send dager før forfall
          <input
            type="number"
            min={0}
            max={60}
            placeholder={String(orgData.data?.standard_dager_foer_forfall ?? 14)}
            value={f.send_dager_foer}
            onChange={(e) => settF({ ...f, send_dager_foer: e.target.value })}
          />
        </label>
        <label>
          Sluttdato (valgfri)
          <input type="date" value={f.slutt_dato} onChange={(e) => settF({ ...f, slutt_dato: e.target.value })} />
        </label>
      </div>
      <p className="liten dempet">Forfallsdagen ({f.neste_forfall ? Number(f.neste_forfall.slice(8, 10)) : "–"}.) holdes hver periode; kortere måneder får siste dag.</p>

      <table className="linjer stabel">
        <tbody>
          {linjer.map((l, i) => (
            <tr key={i}>
              <td className="hel" data-label="Produkt" style={{ width: "28%" }}>
                <Sokefelt
                  etikett={`Produkt på linje ${i + 1}`}
                  valg={produktValg(produkter.data!)}
                  verdi={l.produkt_id}
                  velg={(id) => {
                    const p = id ? produkter.data!.find((x) => x.id === id) : null;
                    settL(i, p ? fraProdukt(p) : { produkt_id: null });
                  }}
                  tom="Fritekst"
                  plassholder="Søk produkt"
                />
              </td>
              <td className="hel" data-label="Beskrivelse">
                <input placeholder="Beskrivelse" value={l.beskrivelse} onChange={(e) => settL(i, { beskrivelse: e.target.value })} />
              </td>
              <td data-label="Antall" style={{ width: 70 }}>
                <input inputMode="decimal" value={l.antall} onChange={(e) => settL(i, { antall: e.target.value })} />
              </td>
              <td data-label="Pris eks. mva" style={{ width: 100 }}>
                <input inputMode="decimal" placeholder={l.produkt_id && produkter.data!.find((x) => x.id === l.produkt_id)?.enhetspris == null ? "Fyll inn" : "Pris"} aria-label={`Pris på linje ${i + 1}`} value={l.enhetspris} onChange={(e) => settL(i, { enhetspris: e.target.value })} />
              </td>
              {visRabatt && (
                <td data-label="Rabatt" style={{ width: 140 }}>
                  <div className="rabatt-felt">
                    <input inputMode="decimal" aria-label={`Rabatt på linje ${i + 1}`} placeholder="Rabatt" value={l.rabatt} onChange={(e) => settL(i, { rabatt: e.target.value })} />
                    <select aria-label={`Rabatt i prosent eller kroner, linje ${i + 1}`} value={l.rabatt_type} onChange={(e) => settL(i, { rabatt_type: e.target.value as LinjeUtkast["rabatt_type"] })}>
                      <option value="prosent">%</option>
                      <option value="kr">kr</option>
                    </select>
                  </div>
                </td>
              )}
              {!utenMva && (
                <td data-label="Mva" style={{ width: 92 }}>
                  <select value={l.mva_sats} onChange={(e) => settL(i, { mva_sats: e.target.value })}>
                    <option value="25">25 %</option>
                    <option value="15">15 %</option>
                    <option value="12">12 %</option>
                    <option value="0">0 %</option>
                  </select>
                </td>
              )}
              <td className="fjern">
                <button type="button" className="lenke" aria-label="Fjern linje" onClick={() => settLinjer(linjer.filter((_, j) => j !== i))}>
                  ✕
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="knapper" style={{ margin: "8px 0 12px" }}>
        <button type="button" onClick={() => settLinjer([...linjer, tomLinje()])}>
          + Linje
        </button>
        <RabattKnapp
          vis={visRabatt}
          veksle={() => {
            if (!visRabatt) return settRabattValgt(true);
            settRabattValgt(false);
            settLinjer(linjer.map((l) => ({ ...l, rabatt: "" })));
          }}
        />
      </div>
      <div className="rad">
        <label>
          Deres referanse
          <input value={f.deres_referanse} onChange={(e) => settF({ ...f, deres_referanse: e.target.value })} />
        </label>
        <label>
          Makstak per faktura (valgfritt)
          <input inputMode="decimal" placeholder="Ingen" value={makstak} onChange={(e) => settMakstak(e.target.value)} />
          <span className="felt-hjelp">
            {tak.tak != null ? `Hver faktura blir høyst ${kr(tak.tak)} kr å betale.` : "Avtalt høyeste beløp å betale på hver faktura."}
            {tak.tak != null && (() => {
              const s = summerMedMakstak(tilTallLinjer(linjer, utenMva), tak.tak);
              return s.fratrekk !== 0 ? ` Nå: ${kr(s.foer)} kr − fratrekk ${kr(-s.fratrekk)} kr.` : "";
            })()}
          </span>
        </label>
      </div>
      <NotatFelt verdi={f.kommentar} endre={(v) => settF({ ...f, kommentar: v })} />
      <EpostlisteFelt
        etikett="Kopi til (valgfritt)"
        verdi={kopi}
        endre={settKopi}
        plassholder="f.eks. regnskap@kunde.no"
        hjelp="Får hver faktura på e-post sammen med kunden. Skill flere adresser med komma."
      />
      <AvsenderKonto org={orgData.data} verdi={f} endre={(v) => settF({ ...f, ...v })} />
      {ulikeFasteValg && <div className="melding info">{ulikeFasteValg}</div>}
      {g.id && (
        <label>
          <input type="checkbox" checked={f.aktiv} onChange={(e) => settF({ ...f, aktiv: e.target.checked })} /> Aktiv
        </label>
      )}
      <Feil melding={h.feil} />
      <div className="knapper">
        <button className="primar" disabled={h.opptatt}>
          Lagre
        </button>
        {g.id && (
          <button
            type="button"
            className="fare"
            onClick={async () => {
              if (confirm("Slette gjentakelsen? Fakturaer som allerede er sendt, beholdes.")) {
                const r = await h.kjor(() => api("DELETE", `/org/${org!.id}/gjentakelser/${g.id}`).then(() => true));
                if (r) ferdig();
              }
            }}
          >
            Slett
          </button>
        )}
      </div>
    </form>
  );
}
