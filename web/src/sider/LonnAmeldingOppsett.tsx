// Oppsettet for a-meldingen, på Lønn → A-melding der den lages (før under Innstillinger → Lønn):
// virksomheten (underenheten) de ansatte jobber i, pensjonsleverandøren for OTP, og flere
// virksomheter med hver sin sone for arbeidsgiveravgift. Eier og administrator endrer det (PUT
// /lonn-oppsett med bare disse feltene); de andre ser det. Mangler virksomheten, er det åpent.
import { useEffect, useState, type FormEvent } from "react";
import { api, hent } from "../api";
import { Feil, Laster, useData, useHandling } from "../felles";
import { erAdmin, useKonto } from "../konto";
import { orgnr } from "../format";

// Sonene for arbeidsgiveravgift (også i lønnsoppsettet under Innstillinger → Lønn).
export const AGA_SONER: [string, string][] = [
  ["1", "Sone 1 – 14,1 %"],
  ["1a", "Sone 1a – 10,6 % til fribeløpet er brukt, deretter 14,1 %"],
  ["2", "Sone 2 – 10,6 %"],
  ["3", "Sone 3 – 6,4 %"],
  ["4", "Sone 4 – 5,1 %"],
  ["4a", "Sone 4a – 7,9 %"],
  ["5", "Sone 5 – 0 % (Finnmark og Nord-Troms)"],
];
// Flere virksomheter (0101_virksomheter.sql): underenhetene i foretaket med sonen for
// arbeidsgiveravgift. Den ansatte velger virksomheten i ansattskjemaet; uten valg er det
// hovedvirksomheten (over). Lagres for seg.
type Virksomhet = { id: string; orgnr: string; navn: string; aga_sone: string; ansatte: number };
function FlereVirksomheter({ enhetsregisteret, hoved }: { enhetsregisteret: { orgnr: string; navn: string }[]; hoved: string }) {
  const { org } = useKonto();
  const { data, last } = useData(() => hent<{ andre: Virksomhet[] }>(`/org/${org!.id}/lonn/virksomheter`), [org?.id]);
  const tom = { orgnr: "", navn: "", aga_sone: "1" };
  const [ny, settNy] = useState(tom);
  const h = useHandling();
  const kan = Boolean(org && erAdmin(org));
  const andre = data?.andre ?? [];
  async function leggTil() {
    const r = await h.kjor(() => api("POST", `/org/${org!.id}/lonn/virksomheter`, { ...ny, orgnr: ny.orgnr.replace(/\s/g, ""), navn: ny.navn.trim() }));
    if (r) {
      settNy(tom);
      last();
    }
  }
  const sone = (v: Virksomhet, aga_sone: string) => h.kjor(() => api("PATCH", `/org/${org!.id}/lonn/virksomheter/${v.id}`, { aga_sone })).then(last);
  const fjern = (v: Virksomhet) => confirm(`Fjerne ${v.navn}?`) && h.kjor(() => api("DELETE", `/org/${org!.id}/lonn/virksomheter/${v.id}`)).then(last);
  return (
    <>
      <h4 className="lonn-under">Flere virksomheter</h4>
      <p className="felt-hjelp">
        Har foretaket flere virksomheter (underenheter), kanskje i andre soner for arbeidsgiveravgift? Legg dem inn her, og velg virksomheten på hver ansatt (uten valg:
        hovedvirksomheten over). Lønnskjøringen regner avgiften med sonen til virksomheten, og a-meldingen får én virksomhet per underenhet.
      </p>
      {andre.length > 0 && (
        <table className="kompakt virksomheter">
          <tbody>
            {andre.map((v) => (
              <tr key={v.id}>
                <td>
                  {v.navn}
                  <div className="dempet liten">
                    {orgnr(v.orgnr)} · {v.ansatte === 1 ? "1 ansatt" : `${v.ansatte} ansatte`}
                  </div>
                </td>
                <td>
                  <select aria-label={`Sone for ${v.navn}`} value={v.aga_sone} disabled={!kan || h.opptatt} onChange={(e) => sone(v, e.target.value)}>
                    {AGA_SONER.map(([z, t]) => (
                      <option key={z} value={z}>
                        {t}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="hoyre">
                  {kan && (
                    <button type="button" className="lenke" onClick={() => fjern(v)}>
                      Fjern
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {kan && (
        <div className="rad" style={{ alignItems: "end" }}>
          <label>
            Organisasjonsnummer
            <input
              inputMode="numeric"
              list="amelding-virksomheter"
              placeholder="9 siffer"
              value={ny.orgnr}
              onChange={(e) => {
                const treff = enhetsregisteret.find((x) => x.orgnr === e.target.value.replace(/\s/g, ""));
                settNy({ ...ny, orgnr: e.target.value, navn: ny.navn || treff?.navn || "" });
              }}
            />
          </label>
          <label>
            Navn
            <input value={ny.navn} onChange={(e) => settNy({ ...ny, navn: e.target.value })} />
          </label>
          <label>
            Sone
            <select value={ny.aga_sone} onChange={(e) => settNy({ ...ny, aga_sone: e.target.value })}>
              {AGA_SONER.map(([z, t]) => (
                <option key={z} value={z}>
                  {t}
                </option>
              ))}
            </select>
          </label>
          <label>
            <button type="button" onClick={leggTil} disabled={h.opptatt || !ny.orgnr.trim() || !ny.navn.trim() || ny.orgnr.replace(/\s/g, "") === hoved}>
              Legg til
            </button>
          </label>
        </div>
      )}
      <Feil melding={h.feil} />
    </>
  );
}

type Underenhet = { orgnr: string; navn: string; adresse: string | null };
type Oppsett = { virksomhet_orgnr: string | null; pensjonsinnretning_orgnr: string | null };

export function AmeldingOppsett({ apen, settApen }: { apen: boolean; settApen: (apen: boolean) => void }) {
  const { org } = useKonto();
  const admin = erAdmin(org);
  const oppsett = useData(() => hent<Oppsett>(`/org/${org!.id}/lonn-oppsett`), [org?.id]);
  // Virksomhetene (underenhetene) i Enhetsregisteret (null: ikke slått opp).
  const virksomheter = useData<Underenhet[] | null>(() => hent<Underenhet[]>(`/org/${org!.id}/amelding-virksomheter`).catch(() => null), [org?.id]);
  const [skjema, settSkjema] = useState({ virksomhet: "", pensjon: "" });
  const [lagret, settLagret] = useState(false);
  const h = useHandling();
  const d = oppsett.data;
  useEffect(() => {
    if (d) settSkjema({ virksomhet: d.virksomhet_orgnr ?? "", pensjon: d.pensjonsinnretning_orgnr ?? "" });
  }, [d]);
  if (oppsett.feil) return <Feil melding={oppsett.feil} />;
  if (!d) return <Laster />;
  const navn = (nr: string) => virksomheter.data?.find((v) => v.orgnr === nr)?.navn;
  const vis = (nr: string | null) => (nr ? (navn(nr) ? `${navn(nr)} (${orgnr(nr)})` : orgnr(nr)) : null);
  const mangler = !d.virksomhet_orgnr;

  async function lagre(e: FormEvent) {
    e.preventDefault();
    settLagret(false);
    const r = await h.kjor(() =>
      api<Oppsett>("PUT", `/org/${org!.id}/lonn-oppsett`, {
        virksomhet_orgnr: skjema.virksomhet.replace(/\s/g, "") || null,
        pensjonsinnretning_orgnr: skjema.pensjon.replace(/\s/g, "") || null,
      }),
    );
    if (!r) return;
    await oppsett.last();
    settLagret(true);
    settApen(false);
  }

  // Lukket: virksomheten og pensjonsleverandøren på én linje, med «Endre».
  if (!apen && !mangler)
    return (
      <div className="kort amelding-oppsett" id="oppsett">
        <div className="amelding-oppsett-linje">
          <span>
            <span className="dempet">Virksomhet</span> <strong>{vis(d.virksomhet_orgnr)}</strong>
          </span>
          <span>
            <span className="dempet">Pensjonsleverandør (OTP)</span> {d.pensjonsinnretning_orgnr ? <strong>{vis(d.pensjonsinnretning_orgnr)}</strong> : <span className="dempet">ikke lagt inn</span>}
          </span>
          <button type="button" className="lenke" onClick={() => settApen(true)}>
            {admin ? "Endre oppsettet" : "Se oppsettet"}
          </button>
        </div>
        {lagret && (
          <p className="ok-tekst liten" role="status">
            Lagret.
          </p>
        )}
      </div>
    );

  return (
    <form className="kort amelding-oppsett" id="oppsett" onSubmit={lagre}>
      <h2 style={{ marginTop: 0 }}>Oppsett for a-meldingen</h2>
      {mangler && (
        <p className="melding advarsel">
          A-meldingen må ha virksomheten (underenheten i Enhetsregisteret) der de ansatte jobber.{admin ? " Legg den inn her." : " Eier eller administrator legger den inn."}
        </p>
      )}
      <div className="rad">
        <label>
          Virksomhet (underenhet)
          <input
            inputMode="numeric"
            list="amelding-virksomheter"
            placeholder="9 siffer"
            disabled={!admin}
            value={skjema.virksomhet}
            onChange={(e) => settSkjema({ ...skjema, virksomhet: e.target.value })}
          />
          <datalist id="amelding-virksomheter">
            {(virksomheter.data ?? []).map((v) => (
              <option key={v.orgnr} value={v.orgnr}>
                {v.navn}
                {v.adresse ? `, ${v.adresse}` : ""}
              </option>
            ))}
          </datalist>
          <span className="felt-hjelp">
            Organisasjonsnummeret til virksomheten (underenheten i Enhetsregisteret) der de ansatte jobber.
            {admin && virksomheter.data?.length === 1 && skjema.virksomhet !== virksomheter.data[0]!.orgnr && (
              <>
                {" "}
                <button type="button" className="lenke" onClick={() => settSkjema({ ...skjema, virksomhet: virksomheter.data![0]!.orgnr })}>
                  Bruk {virksomheter.data[0]!.navn} ({virksomheter.data[0]!.orgnr})
                </button>
              </>
            )}
            {virksomheter.data?.length === 0 && org!.orgnr && (
              <>
                {" "}
                {/^[23]\d{8}$/.test(org!.orgnr)
                  ? "Testbedriften har ingen underenhet i Brønnøysundregistrenes testmiljø (der testdataene fra Tenor ligger). A-meldingen må ha en, så bruk en testbedrift som har en underenhet."
                  : "Enhetsregisteret har ingen underenhet for foretaket. A-meldingen må ha en: registrer virksomheten med Samordnet registermelding i Altinn, og skriv nummeret her når den er registrert."}
              </>
            )}
          </span>
        </label>
        <label>
          Pensjonsleverandør (OTP)
          <input inputMode="numeric" placeholder="9 siffer" disabled={!admin} value={skjema.pensjon} onChange={(e) => settSkjema({ ...skjema, pensjon: e.target.value })} />
          <span className="felt-hjelp">Organisasjonsnummeret til pensjonsinnretningen (står i OTP-avtalen). Må med i a-meldingen når det er OTP.</span>
        </label>
      </div>
      <Feil melding={h.feil} />
      {admin && (
        <div className="knapper">
          <button className="primar" disabled={h.opptatt}>
            Lagre
          </button>
          {!mangler && (
            <button type="button" onClick={() => settApen(false)} disabled={h.opptatt}>
              Lukk
            </button>
          )}
        </div>
      )}
      {!admin && !mangler && (
        <div className="knapper">
          <button type="button" onClick={() => settApen(false)}>
            Lukk
          </button>
        </div>
      )}
      <FlereVirksomheter enhetsregisteret={virksomheter.data ?? []} hoved={skjema.virksomhet.replace(/\s/g, "")} />
    </form>
  );
}
