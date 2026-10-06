import { useEffect, useState, type FormEvent } from "react";
import { api, hent, lastOppLogo } from "../api";
import { Feil, Laster, tall, useData, useHandling } from "../felles";
import { erAdmin, useKonto } from "../konto";
import { dato, orgnr } from "../format";
import { Totrinn } from "./Totrinn";
import { erAvbrutt, foreslattNavn, leggTilPasskey, passkeyFeil, stotterPasskey } from "../passkey";

export function Innstillinger() {
  const { org, meg } = useKonto();
  return (
    <>
      <h1>Innstillinger</h1>
      <div className="kort">
        <h2 style={{ marginTop: 0 }}>Din konto</h2>
        <p className="dempet">{meg?.bruker.epost}</p>
        <Passkeys />
        <h2>Autentiseringsapp</h2>
        <Totrinn />
        {!meg?.mfa && (
          <p className="liten dempet" style={{ marginTop: 8 }}>
            For å sende fakturaer må du være logget inn med passkey eller med kode fra autentiseringsappen. Har du nettopp
            lagt til en av dem, logger du ut og inn igjen.
          </p>
        )}
      </div>
      {org && erAdmin(org.rolle) && (
        <>
          <Organisasjon />
          <Logo />
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
    if (data.mva_registrert && !o.mva_registrert && !confirm("Fakturere uten mva fremover? Alle produkter, utkast og gjentakende fakturaer settes til 0 % mva.")) return;
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
        <span className="liten" style={{ display: "block", marginLeft: 24 }}>
          Slå av hvis foretaket ikke er mva-registrert eller er fritatt. Da blir alle produkter, utkast og nye fakturaer
          uten mva. Fakturaer som allerede er sendt, endres ikke.
        </span>
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

function Passkeys() {
  const { data, last } = useData(() => hent<any[]>("/passkeys"), []);
  const h = useHandling();
  const [lagt, settLagt] = useState(false);

  const [venter, settVenter] = useState(false);

  async function leggTil() {
    settLagt(false);
    h.settFeil(null);
    settVenter(true);
    try {
      await leggTilPasskey(foreslattNavn());
      settLagt(true);
      last();
    } catch (e) {
      console.error("Passkey-registrering feilet", e);
      if (!erAvbrutt(e)) h.settFeil(passkeyFeil(e));
    } finally {
      settVenter(false);
    }
  }

  return (
    <>
      <h2>Passkeys</h2>
      <p className="dempet liten">
        Logg inn med Face ID, Touch ID, Windows Hello eller en sikkerhetsnøkkel, uten passord. En passkey teller som
        totrinnsbekreftelse.
      </p>
      {(data ?? []).length > 0 && (
        <table style={{ marginBottom: 12 }}>
          <tbody>
            {data!.map((p) => (
              <tr key={p.id}>
                <td>{p.navn}</td>
                <td className="dempet liten">
                  {p.sikkerhetskopiert ? "Synkronisert" : "Bare på denne enheten"} · lagt til {dato(p.opprettet)}
                  {p.sist_brukt ? ` · sist brukt ${dato(p.sist_brukt)}` : ""}
                </td>
                <td className="hoyre">
                  <button
                    className="lenke"
                    onClick={() => confirm(`Fjerne «${p.navn}»?`) && h.kjor(() => api("DELETE", `/passkeys/${encodeURIComponent(p.id)}`)).then(last)}
                  >
                    Fjern
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {stotterPasskey() ? (
        <button className="primar" onClick={leggTil} disabled={h.opptatt || venter}>
          {venter ? "Venter på bekreftelse …" : "Legg til passkey"}
        </button>
      ) : (
        <p className="dempet liten">Nettleseren din støtter ikke passkeys.</p>
      )}
      {lagt && <div className="melding ok" style={{ marginTop: 12 }}>Passkeyen er lagt til. Neste gang kan du logge inn med den.</div>}
      <Feil melding={h.feil} />
    </>
  );
}

function Logo() {
  const { org } = useKonto();
  const [url, settUrl] = useState<string | null>(null);
  const [versjon, settVersjon] = useState(0);
  const h = useHandling();

  useEffect(() => {
    let lenke: string | null = null;
    hent<Blob>(`/org/${org!.id}/logo`)
      .then((b) => {
        lenke = URL.createObjectURL(b);
        settUrl(lenke);
      })
      .catch(() => settUrl(null));
    return () => {
      if (lenke) URL.revokeObjectURL(lenke);
    };
  }, [org?.id, versjon]);

  async function velg(fil: File | undefined) {
    if (!fil) return;
    if (!["image/png", "image/jpeg"].includes(fil.type)) return h.settFeil("Logoen må være PNG eller JPG.");
    if (fil.size > 1_500_000) return h.settFeil("Logoen kan være høyst 1,5 MB.");
    const ok = await h.kjor(() => lastOppLogo(org!.id, fil).then(() => true));
    if (ok) settVersjon((v) => v + 1);
  }

  return (
    <div className="kort">
      <h2 style={{ marginTop: 0 }}>Logo på fakturaen</h2>
      <p className="dempet liten">PNG eller JPG, høyst 1,5 MB. Vises øverst til høyre på nye fakturaer. Bredformat med gjennomsiktig bakgrunn blir finest.</p>
      {url ? (
        <img src={url} alt="Logo" style={{ maxWidth: 220, maxHeight: 80, display: "block", marginBottom: 12, background: "#fff", padding: 6, borderRadius: 6 }} />
      ) : (
        <p className="dempet">Ingen logo lastet opp.</p>
      )}
      <div className="knapper">
        <label className="knapp" style={{ margin: 0, color: "var(--tekst)" }}>
          {url ? "Bytt logo" : "Last opp logo"}
          <input type="file" accept="image/png,image/jpeg" hidden onChange={(e) => velg(e.target.files?.[0])} disabled={h.opptatt} />
        </label>
        {url && (
          <button
            className="fare"
            disabled={h.opptatt}
            onClick={() => h.kjor(() => api("DELETE", `/org/${org!.id}/logo`)).then(() => settVersjon((v) => v + 1))}
          >
            Fjern
          </button>
        )}
      </div>
      <Feil melding={h.feil} />
    </div>
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
