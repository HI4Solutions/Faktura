// EHF-sending: organisasjonen kobler til sin egen konto hos Recommand med en API-nøkkel
// (Basic auth). Hemmeligheten sendes til serveren én gang, lagres kryptert og vises aldri igjen.
import { useState, type FormEvent } from "react";
import { api, hent } from "../api";
import { Feil, useData, useHandling } from "../felles";
import { dato, orgnr } from "../format";
import { useKonto } from "../konto";

export function EhfSending() {
  const { org, meg } = useKonto();
  const { data, settData } = useData(() => hent(`/org/${org!.id}/ehf`), [org?.id]);
  const [skjema, settSkjema] = useState<{ nokkel_id: string; hemmelighet: string } | null>(null);
  const h = useHandling();

  async function koble(e: FormEvent) {
    e.preventDefault();
    const r = await h.kjor(() => api("PUT", `/org/${org!.id}/ehf`, skjema));
    if (r) {
      settData(r);
      settSkjema(null);
    }
  }

  async function kobleFra() {
    if (!confirm("Koble fra EHF-sending? Fakturaene sendes da på e-post. Nøkkelen slettes her, men ikke hos Recommand.")) return;
    const r = await h.kjor(async () => (await api("DELETE", `/org/${org!.id}/ehf`), true));
    if (r) settData({ tilkoblet: false });
  }

  if (!data) return null;
  return (
    <div className="kort">
      <h2 style={{ marginTop: 0 }}>EHF (elektronisk faktura)</h2>
      <p className="dempet liten">
        Fakturaer og kreditnotaer til kunder som kan ta imot EHF, sendes som EHF gjennom organisasjonens egen konto hos Recommand, og kommer
        rett inn i kundens regnskapssystem. Andre kunder får e-post som før, og purringer går alltid på e-post. Kopimottakerne og dere selv får
        en kopi på e-post.
      </p>

      {data.tilkoblet ? (
        <div className="ehf-kobling">
          <p>
            <span className="merke merke-ok">Tilkoblet</span> <strong>{data.selskap}</strong> (org.nr. {orgnr(data.orgnr)}) hos Recommand
            <span className="dempet liten"> · nøkkel {data.nokkel_id} · {dato(data.oppdatert)}</span>
          </p>
          {data.verifisert === false && (
            <div className="melding info">
              Selskapet er ikke verifisert hos Recommand ennå. Fullfør verifiseringen der. Til den er gjort, kan Recommand stoppe sendingen.
            </div>
          )}
          {data.siste_feil && (
            <div className="melding feil">
              Siste feil fra Recommand: {data.siste_feil}. Fakturaene gikk på e-post i stedet. Lim inn en ny nøkkel hvis nøkkelen er slettet.
            </div>
          )}
          <p className="liten dempet">
            {data.tar_imot
              ? "Selskapet tar også imot EHF gjennom Recommand. Leverandørfakturaer kommer til e-postadressen dere har valgt der."
              : "Selskapet tar ikke imot EHF gjennom Recommand, så leverandørfakturaer kommer der de kommer i dag."}
          </p>
        </div>
      ) : (
        <p>EHF-sending er ikke koblet til. Fakturaene sendes på e-post.</p>
      )}

      {skjema ? (
        <form onSubmit={koble} className="ehf-skjema">
          <p className="liten">
            Lag en API-nøkkel med <strong>Basic auth</strong> under API keys hos Recommand, og lim inn nøkkel-ID og hemmelighet her. Selskapet
            med organisasjonens org.nr. må være lagt inn hos Recommand med identifikatoren 0192.
          </p>
          <label>
            Nøkkel-ID
            <input required autoComplete="off" autoCapitalize="off" spellCheck={false} value={skjema.nokkel_id} onChange={(e) => settSkjema({ ...skjema, nokkel_id: e.target.value })} />
          </label>
          <label>
            Hemmelighet
            <input
              required
              type="password"
              autoComplete="new-password"
              value={skjema.hemmelighet}
              onChange={(e) => settSkjema({ ...skjema, hemmelighet: e.target.value })}
            />
            <span className="felt-hjelp">Lagres kryptert og vises ikke igjen. Nøkkelen sjekkes mot Recommand før den lagres.</span>
          </label>
          {!meg?.mfa && <div className="melding info">Du må være logget inn med passkey eller kode fra autentiseringsappen for å koble til.</div>}
          <Feil melding={h.feil} />
          <div className="knapper">
            <button className="primar" disabled={h.opptatt}>
              {h.opptatt ? "Sjekker nøkkelen …" : "Koble til"}
            </button>
            <button type="button" className="lenke" onClick={() => (settSkjema(null), h.settFeil(null))}>
              Avbryt
            </button>
          </div>
        </form>
      ) : (
        <>
          <Feil melding={h.feil} />
          <div className="knapper">
            <button type="button" className={data.tilkoblet ? undefined : "primar"} onClick={() => settSkjema({ nokkel_id: "", hemmelighet: "" })}>
              {data.tilkoblet ? "Bytt nøkkel" : "Koble til Recommand"}
            </button>
            {data.tilkoblet && (
              <button type="button" className="fare" onClick={kobleFra} disabled={h.opptatt}>
                Koble fra
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
