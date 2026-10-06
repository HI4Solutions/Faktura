import { useEffect, useState, type FormEvent } from "react";
import { api, hent } from "../api";
import { Feil, Laster, tall, useData, useHandling } from "../felles";
import { erAdmin, useKonto } from "../konto";
import { dato, orgnr } from "../format";
import { Totrinn } from "./Totrinn";

export function Innstillinger() {
  const { org, meg } = useKonto();
  return (
    <>
      <h1>Innstillinger</h1>
      <div className="kort">
        <h2 style={{ marginTop: 0 }}>Din konto</h2>
        <p className="dempet">{meg?.bruker.epost}</p>
        <Totrinn />
        {!meg?.mfa && (
          <p className="liten dempet" style={{ marginTop: 8 }}>
            Har du nettopp slått på totrinnsbekreftelse? Logg ut og inn igjen med koden for å kunne sende fakturaer.
          </p>
        )}
      </div>
      {org && erAdmin(org.rolle) && (
        <>
          <Organisasjon />
          <Medlemmer />
          <Regnskapsforer />
        </>
      )}
    </>
  );
}

function Organisasjon() {
  const { org, oppdater } = useKonto();
  const { data, last } = useData(() => hent(`/org/${org!.id}`), [org?.id]);
  const [o, settO] = useState<any>(null);
  const h = useHandling();
  const [lagret, settLagret] = useState(false);

  useEffect(() => {
    if (data) settO({ ...data, standard_gebyr: String(data.standard_gebyr).replace(".", ",") });
  }, [data]);
  if (!o) return <Laster />;

  const felt = (navn: string) => ({ value: o[navn] ?? "", onChange: (e: any) => settO({ ...o, [navn]: e.target.value }) });
  const avkryss = (navn: string) => ({ checked: !!o[navn], onChange: (e: any) => settO({ ...o, [navn]: e.target.checked }) });

  async function lagre(ev: FormEvent) {
    ev.preventDefault();
    settLagret(false);
    const kropp: Record<string, unknown> = {
      navn: o.navn,
      adresse: o.adresse || null,
      postnr: o.postnr || null,
      poststed: o.poststed || null,
      epost: o.epost || null,
      telefon: o.telefon || null,
      mva_registrert: o.mva_registrert,
      foretaksregisteret: o.foretaksregisteret,
      bruk_kid: o.bruk_kid,
      standard_forfall_dager: Number(o.standard_forfall_dager),
      standard_gebyr: tall(String(o.standard_gebyr)),
      standard_dager_foer_forfall: Number(o.standard_dager_foer_forfall),
      farge: o.farge || null,
    };
    if (o.verifisering === "ny") kropp.orgnr = o.orgnr ? o.orgnr.replace(/\s/g, "") : null;
    const ktnr = (o.kontonr ?? "").replace(/[\s.]/g, "");
    if (ktnr !== (data.kontonr ?? "")) {
      if (!confirm(`Endre kontonummeret til ${ktnr}? Alle eiere får beskjed på e-post.`)) return;
      kropp.kontonr = ktnr || null;
    }
    const r = await h.kjor(() => api("PATCH", `/org/${org!.id}`, kropp));
    if (r) {
      settLagret(true);
      last();
      oppdater();
    }
  }

  return (
    <form className="kort" onSubmit={lagre}>
      <h2 style={{ marginTop: 0 }}>Organisasjon og faktura</h2>
      <p className="dempet liten">
        Status: {o.verifisering === "verifisert" ? "Verifisert" : o.verifisering === "sperret" ? "Sperret" : "Ikke verifisert"}
      </p>
      <div className="rad">
        <label>
          Navn
          <input required {...felt("navn")} />
        </label>
        <label>
          Org.nr.
          <input disabled={o.verifisering !== "ny"} {...felt("orgnr")} />
        </label>
      </div>
      <label>
        Adresse
        <input {...felt("adresse")} />
      </label>
      <div className="rad">
        <label>
          Postnr.
          <input {...felt("postnr")} />
        </label>
        <label>
          Poststed
          <input {...felt("poststed")} />
        </label>
        <label>
          E-post (svar på fakturaer)
          <input type="email" {...felt("epost")} />
        </label>
        <label>
          Telefon
          <input {...felt("telefon")} />
        </label>
      </div>
      <label>
        <input type="checkbox" {...avkryss("mva_registrert")} /> MVA-registrert
      </label>
      <label>
        <input type="checkbox" {...avkryss("foretaksregisteret")} /> Registrert i Foretaksregisteret
      </label>
      <div className="rad">
        <label>
          Kontonummer
          <input inputMode="numeric" {...felt("kontonr")} placeholder="1234.56.78901" />
        </label>
        <label>
          Betalingsfrist (dager)
          <input type="number" min={0} max={120} {...felt("standard_forfall_dager")} />
        </label>
        <label>
          Fakturagebyr eks. mva
          <input inputMode="decimal" {...felt("standard_gebyr")} />
        </label>
        <label>
          Gjentakende sendes dager før forfall
          <input type="number" min={0} max={60} {...felt("standard_dager_foer_forfall")} />
        </label>
      </div>
      <label>
        <input type="checkbox" {...avkryss("bruk_kid")} /> Bruk KID (krever KID-avtale med banken)
      </label>
      <label style={{ maxWidth: 200 }}>
        Farge på fakturaen
        <input type="color" value={o.farge || "#1f3a73"} onChange={(e) => settO({ ...o, farge: e.target.value })} />
      </label>
      <Feil melding={h.feil} />
      {lagret && <div className="melding ok">Lagret.</div>}
      <button className="primar" disabled={h.opptatt}>
        Lagre
      </button>
    </form>
  );
}

function Medlemmer() {
  const { org } = useKonto();
  const { data, last } = useData(() => hent(`/org/${org!.id}/medlemmer`), [org?.id]);
  const [epost, settEpost] = useState("");
  const [rolle, settRolle] = useState("fakturerer");
  const [lenke, settLenke] = useState<string | null>(null);
  const h = useHandling();

  async function inviter(e: FormEvent) {
    e.preventDefault();
    const r = await h.kjor(() => api("POST", `/org/${org!.id}/invitasjoner`, { epost, rolle }));
    if (r) {
      settLenke(r.lenke);
      settEpost("");
    }
  }

  const rolletekst: Record<string, string> = { eier: "Eier", admin: "Administrator", fakturerer: "Fakturerer", regnskap: "Regnskap", les: "Les" };

  return (
    <div className="kort">
      <h2 style={{ marginTop: 0 }}>Brukere</h2>
      <table>
        <tbody>
          {(data ?? []).map((m: any) => (
            <tr key={m.bruker_id}>
              <td>{m.navn ?? m.epost}</td>
              <td className="dempet">{m.epost}</td>
              <td>{rolletekst[m.rolle]}</td>
              <td className="hoyre">
                {m.rolle !== "eier" && (
                  <button className="lenke" onClick={() => confirm(`Fjerne ${m.epost}?`) && h.kjor(() => api("DELETE", `/org/${org!.id}/medlemmer/${m.bruker_id}`)).then(last)}>
                    Fjern
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <form onSubmit={inviter} className="rad" style={{ marginTop: 16, alignItems: "end" }}>
        <label>
          Inviter e-post
          <input type="email" required value={epost} onChange={(e) => settEpost(e.target.value)} />
        </label>
        <label>
          Rolle
          <select value={rolle} onChange={(e) => settRolle(e.target.value)}>
            <option value="admin">Administrator</option>
            <option value="fakturerer">Fakturerer</option>
            <option value="regnskap">Regnskap (bokføre betalinger)</option>
            <option value="les">Les</option>
          </select>
        </label>
        <label>
          <button className="primar" disabled={h.opptatt}>
            Lag invitasjon
          </button>
        </label>
      </form>
      {lenke && (
        <div className="melding ok">
          Send denne lenken til personen. Den gjelder i 7 dager og bare for e-postadressen du skrev inn:
          <br />
          <code className="hemmelig">{lenke}</code>
        </div>
      )}
      <Feil melding={h.feil} />
    </div>
  );
}

function Regnskapsforer() {
  const { org } = useKonto();
  const { data, last } = useData(() => hent(`/org/${org!.id}/tilgang`), [org?.id]);
  const [nr, settNr] = useState("");
  const [rolle, settRolle] = useState("bokfor");
  const h = useHandling();
  const byraa = org?.type === "regnskapsbyraa";

  async function opprett(e: FormEvent) {
    e.preventDefault();
    const r = await h.kjor(() => api("POST", `/org/${org!.id}/tilgang`, { orgnr: nr.replace(/\s/g, ""), rolle }));
    if (r) {
      settNr("");
      last();
    }
  }

  const statustekst: Record<string, string> = { invitert: "Venter på byrået", forespurt: "Venter på klienten", aktiv: "Aktiv", avslaatt: "Avslått", trukket: "Trukket" };
  const kanSvare = (t: any) => (t.status === "invitert" && t.byraa_org_id === org!.id) || (t.status === "forespurt" && t.klient_org_id === org!.id);

  return (
    <div className="kort">
      <h2 style={{ marginTop: 0 }}>{byraa ? "Klienter" : "Regnskapsfører"}</h2>
      <p className="dempet liten">
        {byraa
          ? "Be om tilgang til en klient med klientens organisasjonsnummer. Klienten må godkjenne."
          : "Gi regnskapsføreren tilgang med byråets organisasjonsnummer. Byrået må godta, og du kan trekke tilgangen når som helst."}{" "}
        Begge organisasjonene må være verifisert.
      </p>
      <table>
        <tbody>
          {(data ?? []).map((t: any) => (
            <tr key={t.id}>
              <td>{byraa ? t.klient_navn : t.byraa_navn}</td>
              <td className="dempet">{orgnr(byraa ? t.klient_orgnr : t.byraa_orgnr)}</td>
              <td>{t.rolle === "bokfor" ? "Les og bokfør" : "Les"}</td>
              <td>{statustekst[t.status]}{t.utloper ? ` til ${dato(t.utloper)}` : ""}</td>
              <td className="hoyre knapper" style={{ justifyContent: "flex-end" }}>
                {kanSvare(t) && (
                  <>
                    <button className="lenke" onClick={() => h.kjor(() => api("POST", `/tilgang/${t.id}/svar`, { aksepter: true })).then(last)}>
                      Godta
                    </button>
                    <button className="lenke" onClick={() => h.kjor(() => api("POST", `/tilgang/${t.id}/svar`, { aksepter: false })).then(last)}>
                      Avslå
                    </button>
                  </>
                )}
                {["invitert", "forespurt", "aktiv"].includes(t.status) && (
                  <button className="lenke" onClick={() => confirm("Trekke tilgangen?") && h.kjor(() => api("DELETE", `/tilgang/${t.id}`)).then(last)}>
                    Trekk
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <form onSubmit={opprett} className="rad" style={{ marginTop: 16, alignItems: "end" }}>
        <label>
          {byraa ? "Klientens org.nr." : "Byråets org.nr."}
          <input inputMode="numeric" required value={nr} onChange={(e) => settNr(e.target.value)} />
        </label>
        <label>
          Tilgang
          <select value={rolle} onChange={(e) => settRolle(e.target.value)}>
            <option value="bokfor">Les og bokfør betalinger</option>
            <option value="les">Bare les</option>
          </select>
        </label>
        <label>
          <button className="primar" disabled={h.opptatt}>
            {byraa ? "Be om tilgang" : "Inviter"}
          </button>
        </label>
      </form>
      <Feil melding={h.feil} />
    </div>
  );
}
