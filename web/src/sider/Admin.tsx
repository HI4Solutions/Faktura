import { useState } from "react";
import { api, hent } from "../api";
import { Dialog, Feil, Laster, useData, useHandling } from "../felles";
import { dato, kr, orgnr } from "../format";

const statusMerke: Record<string, string> = { ny: "merke-advarsel", verifisert: "merke-ok", sperret: "merke-fare" };
const statusTekst: Record<string, string> = { ny: "Ikke verifisert", verifisert: "Verifisert", sperret: "Sperret" };

export function Admin() {
  const { data, feil, last } = useData(() => hent<any[]>("/admin/organisasjoner"), []);
  const [filter, settFilter] = useState<"venter" | "alle" | "ny" | "sperret">("venter");
  const [valgt, settValgt] = useState<any | null>(null);

  if (feil) return <Feil melding={feil} />;
  if (!data) return <Laster />;

  const rader = data.filter((o) =>
    filter === "venter" ? o.venter_manuell : filter === "ny" ? o.verifisering === "ny" : filter === "sperret" ? o.verifisering === "sperret" : true,
  );

  return (
    <>
      <h1>Administrasjon</h1>
      <div className="knapper" style={{ marginBottom: 12 }}>
        {(
          [
            ["venter", `Venter på godkjenning (${data.filter((o) => o.venter_manuell).length})`],
            ["ny", "Ikke verifisert"],
            ["sperret", "Sperret"],
            ["alle", `Alle (${data.length})`],
          ] as const
        ).map(([v, t]) => (
          <button key={v} className={filter === v ? "primar" : ""} onClick={() => settFilter(v)}>
            {t}
          </button>
        ))}
      </div>
      <div className="kort tabell">
        <table>
          <thead>
            <tr>
              <th>Organisasjon</th>
              <th>Org.nr.</th>
              <th>Eier</th>
              <th>Opprettet</th>
              <th className="hoyre">Fakturert</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {rader.map((o) => (
              <tr key={o.id} className="klikkbar" onClick={() => settValgt(o)}>
                <td>
                  {o.navn}
                  {o.type === "regnskapsbyraa" && <span className="dempet liten"> (byrå)</span>}
                </td>
                <td>{orgnr(o.orgnr)}</td>
                <td className="liten">{o.eier_epost}</td>
                <td>{dato(o.opprettet)}</td>
                <td className="tall">
                  {kr(o.sum_fakturert)} <span className="dempet liten">({o.antall_fakturaer})</span>
                </td>
                <td>
                  <span className={`merke ${statusMerke[o.verifisering]}`}>{statusTekst[o.verifisering]}</span>
                  {o.venter_manuell && <span className="merke merke-info" style={{ marginLeft: 4 }}>Venter</span>}
                </td>
              </tr>
            ))}
            {rader.length === 0 && (
              <tr>
                <td colSpan={6} className="dempet">
                  Ingenting her.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <Dialog apen={!!valgt} lukk={() => settValgt(null)} tittel={valgt?.navn ?? ""}>
        {valgt && (
          <Behandle
            org={valgt}
            ferdig={() => {
              settValgt(null);
              last();
            }}
          />
        )}
      </Dialog>
    </>
  );
}

function Behandle({ org, ferdig }: { org: any; ferdig: () => void }) {
  const brreg = useData(() => (org.orgnr ? hent(`/admin/organisasjoner/${org.id}/brreg`) : Promise.resolve(null)), [org.id]);
  const [grunn, settGrunn] = useState("");
  const h = useHandling();
  const sett = async (status: string) => {
    const r = await h.kjor(() => api("POST", `/admin/organisasjoner/${org.id}/status`, { status, grunn: grunn || undefined }));
    if (r) ferdig();
  };

  return (
    <>
      <p className="dempet">
        Org.nr. {orgnr(org.orgnr) || "mangler"} · eier {org.eier_epost} · {statusTekst[org.verifisering]}
      </p>
      {org.notat && <div className="melding info">«{org.notat}»</div>}
      <h2>Enhetsregisteret</h2>
      {brreg.laster ? (
        <Laster />
      ) : brreg.feil ? (
        <Feil melding={brreg.feil} />
      ) : brreg.data ? (
        <table>
          <tbody>
            <tr><td className="dempet">Navn</td><td>{brreg.data.navn}</td></tr>
            <tr><td className="dempet">Adresse</td><td>{[brreg.data.adresse, brreg.data.postnr, brreg.data.poststed].filter(Boolean).join(", ")}</td></tr>
            <tr><td className="dempet">Nettside</td><td>{brreg.data.hjemmeside ?? "–"}</td></tr>
            <tr><td className="dempet">E-post</td><td>{brreg.data.epost ?? "–"}</td></tr>
            <tr>
              <td className="dempet">Status</td>
              <td>{brreg.data.konkurs ? "Konkurs" : brreg.data.under_avvikling ? "Under avvikling" : brreg.data.slettet ? "Slettet" : "Aktiv"}</td>
            </tr>
          </tbody>
        </table>
      ) : (
        <p className="dempet">Mangler organisasjonsnummer.</p>
      )}
      <p className="liten dempet" style={{ marginTop: 12 }}>
        Sjekk roller (daglig leder, styreleder, signatur) på{" "}
        <a href={`https://virksomhet.brreg.no/nb/oppslag/enheter/${org.orgnr}`} target="_blank" rel="noreferrer">
          virksomhet.brreg.no
        </a>{" "}
        før du godkjenner.
      </p>
      <label>
        Grunn (påkrevd ved sperring)
        <input value={grunn} onChange={(e) => settGrunn(e.target.value)} />
      </label>
      <Feil melding={h.feil} />
      <div className="knapper">
        {org.verifisering !== "verifisert" && (
          <button className="primar" disabled={h.opptatt || !org.orgnr} onClick={() => sett("verifisert")}>
            Godkjenn
          </button>
        )}
        {org.verifisering !== "sperret" && (
          <button className="fare" disabled={h.opptatt} onClick={() => sett("sperret")}>
            Sperr
          </button>
        )}
        {org.verifisering !== "ny" && (
          <button disabled={h.opptatt} onClick={() => sett("ny")}>
            Sett til ikke verifisert
          </button>
        )}
      </div>
    </>
  );
}
