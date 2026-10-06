import { useEffect, useState } from "react";
import { BrowserRouter, NavLink, Navigate, Route, Routes, useNavigate, useParams } from "react-router-dom";
import { api } from "./api";
import { Feil, Laster } from "./felles";
import { KontoProvider, useKonto } from "./konto";
import { BekreftEpost, Innlogging } from "./sider/Innlogging";
import { NyOrganisasjon } from "./sider/NyOrganisasjon";
import { Oversikt } from "./sider/Oversikt";
import { Kunder, Produkter } from "./sider/Register";
import { FakturaSkjema, FakturaVisning, Fakturaliste } from "./sider/Fakturaer";
import { Innstillinger } from "./sider/Innstillinger";
import { Verifisering } from "./sider/Verifisering";
import { Admin } from "./sider/Admin";
import { Gjentakende } from "./sider/Gjentakende";
import { Rapporter } from "./sider/Rapporter";
import { Logo } from "./Logo";

function Invitasjon() {
  const { token } = useParams();
  const { oppdater, velgOrg } = useKonto();
  const nav = useNavigate();
  const [feil, settFeil] = useState<string | null>(null);
  useEffect(() => {
    api("POST", "/invitasjoner/aksepter", { token })
      .then(async (r) => {
        velgOrg(r.org_id);
        await oppdater();
        nav("/");
      })
      .catch((e) => settFeil(e.message));
  }, [token]);
  return feil ? <Feil melding={feil} /> : <Laster />;
}

function Ramme() {
  const { meg, org, velgOrg, loggUt } = useKonto();
  const [ny, settNy] = useState(false);
  const orgs = meg?.organisasjoner ?? [];

  if (ny || orgs.length === 0) {
    return (
      <div className="innhold" style={{ margin: "0 auto" }}>
        <h1>{orgs.length === 0 ? "Velkommen til HI4 Faktura" : "Ny organisasjon"}</h1>
        {orgs.length === 0 && <p className="dempet">Start med å legge inn foretaket du skal fakturere fra, eller regnskapsbyrået ditt.</p>}
        <NyOrganisasjon avbryt={orgs.length ? () => settNy(false) : undefined} />
        <p className="liten dempet">
          Fått en invitasjon? Åpne lenken i e-posten. · <button className="lenke" onClick={loggUt}>Logg ut</button>
        </p>
      </div>
    );
  }

  return (
    <div className="ramme">
      <nav className="meny">
        <div className="logo"><Logo /></div>
        <select
          value={org?.id}
          onChange={(e) => (e.target.value === "__ny" ? settNy(true) : velgOrg(e.target.value))}
          style={{ marginBottom: 12 }}
          aria-label="Organisasjon"
        >
          {orgs.map((o) => (
            <option key={o.id} value={o.id}>
              {o.navn}
              {o.direkte_medlem ? "" : " (klient)"}
            </option>
          ))}
          <option value="__ny">+ Ny organisasjon</option>
        </select>
        <NavLink to="/" end>
          {org?.type === "regnskapsbyraa" ? "Klienter" : "Oversikt"}
        </NavLink>
        {org?.type !== "regnskapsbyraa" && (
          <>
            <NavLink to="/fakturaer">Fakturaer</NavLink>
            <NavLink to="/gjentakende">Gjentakende</NavLink>
            <NavLink to="/kunder">Kunder</NavLink>
            <NavLink to="/produkter">Produkter</NavLink>
            <NavLink to="/rapporter">Rapporter</NavLink>
          </>
        )}
        <NavLink to="/innstillinger">Innstillinger</NavLink>
        {org?.verifisering === "ny" && org.direkte_medlem && <NavLink to="/verifisering">Verifiser organisasjon</NavLink>}
        {meg?.plattformadmin && <NavLink to="/admin">Administrasjon</NavLink>}
        <div className="bunn">
          <span className="liten dempet">{meg?.bruker.epost}</span>
          <button onClick={loggUt}>Logg ut</button>
        </div>
      </nav>
      <main className="innhold">
        {org && (
          <Routes>
            <Route path="/" element={<Oversikt />} />
            <Route path="/fakturaer" element={<Fakturaliste />} />
            <Route path="/fakturaer/ny" element={<FakturaSkjema key="ny" />} />
            <Route path="/fakturaer/:id/endre" element={<FakturaSkjema />} />
            <Route path="/fakturaer/:id" element={<FakturaVisning />} />
            <Route path="/gjentakende" element={<Gjentakende />} />
            <Route path="/kunder" element={<Kunder />} />
            <Route path="/rapporter" element={<Rapporter />} />
            <Route path="/produkter" element={<Produkter />} />
            <Route path="/innstillinger" element={<Innstillinger />} />
            <Route path="/verifisering" element={<Verifisering />} />
            {meg?.plattformadmin && <Route path="/admin" element={<Admin />} />}
            <Route path="/invitasjon/:token" element={<Invitasjon />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        )}
      </main>
    </div>
  );
}

function Innhold() {
  const { laster, bruker, meg, loggUt } = useKonto();
  if (laster) return <div className="sentrert"><Laster /></div>;
  if (!bruker) return <Innlogging />;
  if (!bruker.emailVerified) return <BekreftEpost epost={bruker.email ?? ""} loggUt={loggUt} />;
  if (!meg) return <div className="sentrert"><Laster /></div>;
  return (
    <Routes>
      <Route path="/invitasjon/:token" element={<div className="innhold"><Invitasjon /></div>} />
      <Route path="*" element={<Ramme />} />
    </Routes>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <KontoProvider>
        <Innhold />
      </KontoProvider>
    </BrowserRouter>
  );
}
