import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { api, hent } from "../api";
import { AvsenderKonto } from "./AvsenderKonto";
import { Dialog, EpostlisteFelt, Feil, Laster, tall, tilEpostliste, ugyldigeEposter, useData, useHandling, useSmal } from "../felles";
import { kanSkrive, useKonto } from "../konto";
import { dato, iDag, kr, summer } from "../format";

const intervallTekst: Record<string, string> = { maaned: "Hver måned", kvartal: "Hvert kvartal", aar: "Hvert år" };

export function Gjentakende() {
  const { org } = useKonto();
  const nav = useNavigate();
  const { data, feil, last } = useData(() => hent<any[]>(`/org/${org!.id}/gjentakelser`), [org?.id]);
  const [redigerer, settRedigerer] = useState<any | null>(null);
  const h = useHandling();
  const smal = useSmal();

  if (feil) return <Feil melding={feil} />;
  if (!data) return <Laster />;

  return (
    <>
      <div className="topp">
        <h1>Gjentakende fakturaer</h1>
        {kanSkrive(org?.rolle) && (
          <button className="primar" onClick={() => settRedigerer({})}>
            Ny gjentakelse
          </button>
        )}
      </div>
      <p className="dempet">
        Fakturaene lages og sendes automatisk hver morgen, så mange dager før forfall som du velger.
      </p>
      <Feil melding={h.feil} />
      {smal ? (
        <div className="kort liste">
          {data.map((g) => {
            const sum = summer(g.linjer.map((l: any) => ({ antall: l.antall ?? 1, enhetspris: l.enhetspris, mva_sats: l.mva_sats ?? 25 })));
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
              const sum = summer(g.linjer.map((l: any) => ({ antall: l.antall ?? 1, enhetspris: l.enhetspris, mva_sats: l.mva_sats ?? 25 })));
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
      <Dialog apen={!!redigerer} lukk={() => settRedigerer(null)} tittel={redigerer?.id ? "Endre gjentakelse" : "Ny gjentakelse"}>
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

interface L {
  produkt_id: string | null;
  beskrivelse: string;
  antall: string;
  enhetspris: string;
  mva_sats: string;
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
  });
  const [linjer, settLinjer] = useState<L[]>(
    g.linjer?.map((l: any) => ({
      produkt_id: l.produkt_id ?? null,
      beskrivelse: l.beskrivelse,
      antall: String(l.antall ?? 1).replace(".", ","),
      enhetspris: String(l.enhetspris).replace(".", ","),
      mva_sats: String(l.mva_sats ?? 25),
    })) ?? [{ produkt_id: null, beskrivelse: "", antall: "1", enhetspris: "", mva_sats: "25" }],
  );
  const [kopi, settKopi] = useState((g.kopi_til ?? []).join(", "));
  const h = useHandling();
  const utenMva = orgData.data && !orgData.data.mva_registrert;
  const settL = (i: number, e: Partial<L>) => settLinjer(linjer.map((l, j) => (j === i ? { ...l, ...e } : l)));

  async function lagre(e: FormEvent) {
    e.preventDefault();
    const ugyldige = ugyldigeEposter(kopi);
    if (ugyldige.length) return h.settFeil(`Ugyldig e-postadresse for kopi: ${ugyldige.join(", ")}`);
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
      kopi_til: tilEpostliste(kopi),
      linjer: linjer
        .filter((l) => l.beskrivelse.trim() && l.enhetspris !== "")
        .map((l) => ({
          produkt_id: l.produkt_id,
          beskrivelse: l.beskrivelse,
          antall: tall(l.antall),
          enhetspris: tall(l.enhetspris),
          mva_sats: utenMva ? 0 : Number(l.mva_sats),
        })),
    };
    const r = await h.kjor(() => (g.id ? api("PATCH", `/org/${org!.id}/gjentakelser/${g.id}`, kropp) : api("POST", `/org/${org!.id}/gjentakelser`, kropp)));
    if (r) ferdig();
  }

  if (!kunder.data || !produkter.data) return <Laster />;

  return (
    <form onSubmit={lagre}>
      <label>
        Kunde
        <select required value={f.kunde_id} onChange={(e) => settF({ ...f, kunde_id: e.target.value })}>
          <option value="">Velg kunde</option>
          {kunder.data.map((k) => (
            <option key={k.id} value={k.id}>
              {k.navn}
            </option>
          ))}
        </select>
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
                <select
                  value={l.produkt_id ?? ""}
                  onChange={(e) => {
                    const p = produkter.data!.find((x) => x.id === e.target.value);
                    settL(i, p ? { produkt_id: p.id, beskrivelse: p.navn, enhetspris: String(p.enhetspris).replace(".", ","), mva_sats: String(p.mva_sats) } : { produkt_id: null });
                  }}
                >
                  <option value="">Fritekst</option>
                  {produkter.data!.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.navn}
                    </option>
                  ))}
                </select>
              </td>
              <td className="hel" data-label="Beskrivelse">
                <input placeholder="Beskrivelse" value={l.beskrivelse} onChange={(e) => settL(i, { beskrivelse: e.target.value })} />
              </td>
              <td data-label="Antall" style={{ width: 70 }}>
                <input inputMode="decimal" value={l.antall} onChange={(e) => settL(i, { antall: e.target.value })} />
              </td>
              <td data-label="Pris eks. mva" style={{ width: 100 }}>
                <input inputMode="decimal" placeholder="Pris" value={l.enhetspris} onChange={(e) => settL(i, { enhetspris: e.target.value })} />
              </td>
              {!utenMva && (
                <td data-label="Mva" style={{ width: 80 }}>
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
      <button type="button" style={{ margin: "8px 0 12px" }} onClick={() => settLinjer([...linjer, { produkt_id: null, beskrivelse: "", antall: "1", enhetspris: "", mva_sats: "25" }])}>
        + Linje
      </button>
      <label>
        Deres referanse
        <input value={f.deres_referanse} onChange={(e) => settF({ ...f, deres_referanse: e.target.value })} />
      </label>
      <EpostlisteFelt
        etikett="Kopi til (valgfritt)"
        verdi={kopi}
        endre={settKopi}
        plassholder="f.eks. regnskap@kunde.no"
        hjelp="Får hver faktura på e-post sammen med kunden. Skill flere adresser med komma."
      />
      <AvsenderKonto org={orgData.data} verdi={f} endre={(v) => settF({ ...f, ...v })} />
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
