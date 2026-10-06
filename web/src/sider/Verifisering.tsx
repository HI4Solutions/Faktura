import { useState } from "react";
import { Link } from "react-router-dom";
import { api, hent } from "../api";
import { Feil, Laster, useData, useHandling } from "../felles";
import { erAdmin, useKonto } from "../konto";

export function Verifisering() {
  const { org, oppdater } = useKonto();
  const { data, last } = useData(() => hent(`/org/${org!.id}/verifisering`), [org?.id]);
  const [steg, settSteg] = useState<{ status: string; sendt_til?: string } | null>(null);
  const [kode, settKode] = useState("");
  const [notat, settNotat] = useState("");
  const h = useHandling();

  if (!data) return <Laster />;

  const ferdig = async () => {
    await oppdater();
    await last();
  };

  if (data.verifisering === "verifisert") {
    return (
      <>
        <h1>Verifisering</h1>
        <div className="melding ok">
          {org?.navn} er verifisert. Det er ingen grenser på antall fakturaer eller beløp.
        </div>
      </>
    );
  }
  if (data.verifisering === "sperret") {
    return (
      <>
        <h1>Verifisering</h1>
        <div className="melding feil">Organisasjonen er sperret{data.sperret_grunn ? `: ${data.sperret_grunn}` : ""}. Ta kontakt med support.</div>
      </>
    );
  }
  if (!erAdmin(org?.rolle)) return <p>Bare eiere og administratorer kan verifisere organisasjonen.</p>;

  const venterManuell = data.forsok?.some((f: any) => f.metode === "manuell" && f.status === "venter");

  async function start() {
    const r = await h.kjor(() => api("POST", `/org/${org!.id}/verifisering/start`));
    if (!r) return;
    settSteg(r);
    if (r.status === "verifisert") await ferdig();
  }

  return (
    <>
      <h1>Verifiser {org?.navn}</h1>
      <div className="kort" style={{ maxWidth: 640 }}>
        <p>
          For å hindre at noen fakturerer i andres navn, må vi bekrefte at du kan representere foretaket. Frem til da kan
          dere sende opptil 20 fakturaer og 50 000 kr per måned, og regnskapsførertilgang er ikke tilgjengelig.
        </p>
        {!data.orgnr ? (
          <div className="melding info">
            Legg inn organisasjonsnummer under <Link to="/innstillinger">Innstillinger</Link> først.
          </div>
        ) : venterManuell ? (
          <div className="melding info">Forespørselen din er sendt og blir behandlet manuelt. Du får beskjed når den er godkjent.</div>
        ) : !steg ? (
          <>
            <p className="dempet liten">
              Vi slår opp org.nr. {data.orgnr} i Enhetsregisteret. Har e-postadressen din samme domene som foretakets nettside
              eller e-post der, blir organisasjonen godkjent med en gang. Ellers sender vi en kode til foretakets e-post i
              registeret.
            </p>
            <button className="primar" onClick={start} disabled={h.opptatt}>
              Start verifisering
            </button>
          </>
        ) : steg.status === "kode_sendt" ? (
          <>
            <p>
              Vi har sendt en sekssifret kode til <strong>{steg.sendt_til}</strong>, som er foretakets e-post i Enhetsregisteret.
              Koden gjelder i 30 minutter.
            </p>
            <label style={{ maxWidth: 200 }}>
              Kode
              <input inputMode="numeric" autoComplete="one-time-code" value={kode} onChange={(e) => settKode(e.target.value)} />
            </label>
            <div className="knapper">
              <button
                className="primar"
                disabled={h.opptatt || kode.trim().length !== 6}
                onClick={async () => {
                  const r = await h.kjor(() => api("POST", `/org/${org!.id}/verifisering/kode`, { kode }));
                  if (r) {
                    settSteg(r);
                    await ferdig();
                  }
                }}
              >
                Bekreft
              </button>
              <button onClick={start} disabled={h.opptatt}>
                Send ny kode
              </button>
            </div>
          </>
        ) : steg.status === "manuell" ? (
          <>
            <p>
              Foretaket har ingen e-postadresse i Enhetsregisteret, og e-postdomenet ditt samsvarer ikke med foretaket. Vi kan
              godkjenne manuelt. Skriv gjerne kort hvilken rolle du har i foretaket.
            </p>
            <label>
              Melding (valgfri)
              <textarea rows={3} value={notat} onChange={(e) => settNotat(e.target.value)} placeholder="F.eks. daglig leder og styreleder" />
            </label>
            <button
              className="primar"
              disabled={h.opptatt}
              onClick={async () => {
                const r = await h.kjor(() => api("POST", `/org/${org!.id}/verifisering/manuell`, { notat: notat || undefined }));
                if (r) await last();
              }}
            >
              Send til manuell godkjenning
            </button>
          </>
        ) : null}
        <Feil melding={h.feil} />
      </div>
    </>
  );
}
