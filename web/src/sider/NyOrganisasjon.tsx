import { useState, type FormEvent } from "react";
import { api, hent } from "../api";
import { Feil, useHandling } from "../felles";
import { useKonto } from "../konto";
import { orgnr as visOrgnr } from "../format";

export function NyOrganisasjon({ avbryt }: { avbryt?: () => void }) {
  const { oppdater, velgOrg } = useKonto();
  const [type, settType] = useState<"foretak" | "regnskapsbyraa">("foretak");
  const [orgnr, settOrgnr] = useState("");
  const [oppslag, settOppslag] = useState<any>(null);
  const [navn, settNavn] = useState("");
  const { opptatt, feil, kjor, settFeil } = useHandling();

  async function slaOpp() {
    const nr = orgnr.replace(/\s/g, "");
    settOppslag(null);
    const e = await kjor(() => hent(`/brreg/${nr}`));
    if (!e) return;
    if (e.konkurs || e.slettet || e.under_avvikling) {
      settFeil("Foretaket er konkurs, under avvikling eller slettet i Enhetsregisteret.");
      return;
    }
    settOppslag(e);
    settNavn(e.navn);
  }

  async function opprett(ev: FormEvent) {
    ev.preventDefault();
    const nr = orgnr.replace(/\s/g, "") || null;
    const o = await kjor(async () => {
      const o = await api("POST", "/organisasjoner", { navn, orgnr: nr, type });
      if (oppslag) {
        await api("PATCH", `/org/${o.id}`, {
          adresse: oppslag.adresse,
          postnr: oppslag.postnr,
          poststed: oppslag.poststed,
          mva_registrert: oppslag.mva_registrert,
          foretaksregisteret: oppslag.foretaksregisteret,
        });
      }
      return o;
    });
    if (o) {
      velgOrg(o.id);
      await oppdater();
    }
  }

  return (
    <form className="kort" onSubmit={opprett} style={{ maxWidth: 560 }}>
      <h2 style={{ marginTop: 0 }}>Ny organisasjon</h2>
      <label>
        Type
        <select value={type} onChange={(e) => settType(e.target.value as typeof type)}>
          <option value="foretak">Foretak som skal fakturere</option>
          <option value="regnskapsbyraa">Regnskapsbyrå</option>
        </select>
      </label>
      <label>
        Organisasjonsnummer
        <div className="knapper">
          <input style={{ flex: 1 }} inputMode="numeric" value={orgnr} onChange={(e) => settOrgnr(e.target.value)} placeholder="123 456 789" />
          <button type="button" onClick={slaOpp} disabled={opptatt || orgnr.replace(/\s/g, "").length !== 9}>
            Slå opp
          </button>
        </div>
      </label>
      {oppslag && (
        <div className="melding info">
          {oppslag.navn}, org.nr. {visOrgnr(oppslag.orgnr)}
          <br />
          {[oppslag.adresse, oppslag.postnr, oppslag.poststed].filter(Boolean).join(", ")}
          {oppslag.mva_registrert ? " · MVA-registrert" : ""}
        </div>
      )}
      <label>
        Navn
        <input required value={navn} onChange={(e) => settNavn(e.target.value)} />
      </label>
      <p className="liten dempet">
        Nye organisasjoner kan sende opptil 20 fakturaer og 50 000 kr per måned til de er verifisert. Ved å opprette
        organisasjonen bekrefter du at du har fullmakt til å fakturere på vegne av den.
      </p>
      <Feil melding={feil} />
      <div className="knapper">
        <button className="primar" disabled={opptatt || !navn}>
          Opprett
        </button>
        {avbryt && (
          <button type="button" onClick={avbryt}>
            Avbryt
          </button>
        )}
      </div>
    </form>
  );
}
