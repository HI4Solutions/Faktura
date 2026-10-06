import { useEffect, useState, type FormEvent } from "react";
import { updateProfile } from "firebase/auth";
import { hentAuth } from "./firebase";
import { BrowserRouter, NavLink, Navigate, Route, Routes, useLocation, useNavigate, useParams } from "react-router-dom";
import { api } from "./api";
import { Feil, Laster } from "./felles";
import { KontoProvider, kanSkrive, useKonto } from "./konto";
import { BekreftEpost, Innlogging } from "./sider/Innlogging";
import { NyOrganisasjon } from "./sider/NyOrganisasjon";
import { Oversikt } from "./sider/Oversikt";
import { Kunder, Produkter } from "./sider/Register";
import { FakturaSkjema, FakturaVisning, Fakturaliste } from "./sider/Fakturaer";
import { FlereFakturaer } from "./sider/Flere";
import { Innstillinger } from "./sider/Innstillinger";
import { Verifisering } from "./sider/Verifisering";
import { Admin } from "./sider/Admin";
import { Gjentakende } from "./sider/Gjentakende";
import { Rapporter } from "./sider/Rapporter";
import { Logo } from "./Logo";
import { PwaBannere, usePwa, useVarselNavigering } from "./Pwa";
import { AppLaas } from "./Applaas";
import { installer } from "./pwa";
import {
  IkonFaktura, IkonGjenta, IkonInnstillinger, IkonInstaller, IkonKunder, IkonLoggUt, IkonMeny, IkonNokkel, IkonOversikt, IkonPluss, IkonProdukter, IkonRapport, IkonSkjold, IkonVelg,
} from "./ikoner";

const initialer = (navn: string) =>
  navn
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((d) => d[0]!.toUpperCase())
    .join("");

const orgType: Record<string, string> = { foretak: "Foretak", regnskapsbyraa: "Regnskapsbyrå", privatperson: "Privatperson" };

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

// Brukere uten navn (registrert før navn ble påkrevd) må fylle det inn.
function OppgiNavn() {
  const { oppdater, loggUt } = useKonto();
  const [navn, settNavn] = useState("");
  const [feil, settFeil] = useState<string | null>(null);
  async function lagre(e: FormEvent) {
    e.preventDefault();
    try {
      await api("PATCH", "/meg", { navn: navn.trim() });
      const a = await hentAuth();
      if (a.currentUser) await updateProfile(a.currentUser, { displayName: navn.trim() });
      await oppdater();
    } catch (err) {
      settFeil((err as Error).message);
    }
  }
  return (
    <div className="sentrert">
      <form className="kort" onSubmit={lagre}>
        <h1>Hva heter du?</h1>
        <p className="dempet">Navnet vises for andre i organisasjonen og i revisjonsloggen.</p>
        <label>
          Fullt navn
          <input autoComplete="name" required minLength={2} autoFocus value={navn} onChange={(e) => settNavn(e.target.value)} />
        </label>
        <Feil melding={feil} />
        <div className="knapper">
          <button className="primar">Lagre</button>
          <button type="button" className="lenke" onClick={loggUt}>
            Logg ut
          </button>
        </div>
      </form>
    </div>
  );
}

function Ramme() {
  const { meg, org, velgOrg, loggUt } = useKonto();
  const [ny, settNy] = useState(false);
  const [menyApen, settMenyApen] = useState(false);
  const { kanInstallere } = usePwa();
  useVarselNavigering();
  const sted = useLocation();
  // Ny side: lukk menyen og start øverst (ellers lander man midt på siden etter en lang liste).
  useEffect(() => {
    settMenyApen(false);
    window.scrollTo(0, 0);
  }, [sted.pathname]);

  // Mobil: skjul bunnmenyen mens tastaturet er oppe, så den ikke dekker feltet man skriver i.
  useEffect(() => {
    const erFelt = (e: Event) => {
      const el = e.target as HTMLElement;
      return el.matches?.("textarea, select, input:not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit])");
    };
    const inn = (e: FocusEvent) => erFelt(e) && document.body.classList.add("skriver");
    const ut = (e: FocusEvent) => erFelt(e) && document.body.classList.remove("skriver");
    document.addEventListener("focusin", inn);
    document.addEventListener("focusout", ut);
    return () => {
      document.removeEventListener("focusin", inn);
      document.removeEventListener("focusout", ut);
    };
  }, []);
  const orgs = meg?.organisasjoner ?? [];

  if (ny || orgs.length === 0) {
    return (
      <div className="innhold frittstaende" style={{ margin: "0 auto" }}>
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
      {/* Mobil: organisasjonen øverst (trykk for å bytte), meny nederst. */}
      {/* Mobil: logo øverst og logg ut til høyre; menyen ligger i bunnmenyen («Mer»). */}
      <header className="mobiltopp">
        <Logo storrelse={30} />
        <button
          type="button"
          className="ikon"
          aria-label="Logg ut"
          title="Logg ut"
          onClick={() => confirm("Logge ut av HI4 Faktura?") && void loggUt()}
        >
          <IkonLoggUt storrelse={20} />
        </button>
      </header>
      <nav className="bunnmeny" aria-label="Hovedmeny">
        <NavLink to="/" end>
          <IkonOversikt storrelse={22} />
          <span>{org?.type === "regnskapsbyraa" ? "Klienter" : "Oversikt"}</span>
        </NavLink>
        {org?.type !== "regnskapsbyraa" && (
          <>
            <NavLink to="/fakturaer" end={false}>
              <IkonFaktura storrelse={22} />
              <span>Fakturaer</span>
            </NavLink>
            {kanSkrive(org?.rolle) && (
              <NavLink to="/fakturaer/ny" className="ny" aria-label="Ny faktura">
                <span className="pluss">
                  <IkonPluss storrelse={24} />
                </span>
              </NavLink>
            )}
            <NavLink to="/kunder">
              <IkonKunder storrelse={22} />
              <span>Kunder</span>
            </NavLink>
          </>
        )}
        {org?.type === "regnskapsbyraa" && (
          <NavLink to="/innstillinger">
            <IkonInnstillinger storrelse={22} />
            <span>Innstillinger</span>
          </NavLink>
        )}
        <button type="button" className={menyApen ? "aktiv" : ""} onClick={() => settMenyApen(true)}>
          <IkonMeny storrelse={22} />
          <span>Mer</span>
        </button>
      </nav>
      <div className={`meny-skygge${menyApen ? " apen" : ""}`} onClick={() => settMenyApen(false)} />
      <nav className={`meny${menyApen ? " apen" : ""}`}>
        <div className="logo">
          <Logo />
        </div>
        <div className="orgvelger">
          <span className="avatar">{initialer(org?.navn ?? "?")}</span>
          <div style={{ minWidth: 0 }}>
            <div className="navn">{org?.navn}</div>
            <div className="type">
              {org ? orgType[org.type] ?? org.type : ""}
              {org && !org.direkte_medlem ? " · klient" : ""}
            </div>
          </div>
          <span className="pil">
            <IkonVelg storrelse={16} />
          </span>
          <select value={org?.id} onChange={(e) => (e.target.value === "__ny" ? settNy(true) : velgOrg(e.target.value))} aria-label="Bytt organisasjon">
            {orgs.map((o) => (
              <option key={o.id} value={o.id}>
                {o.navn}
                {o.direkte_medlem ? "" : " (klient)"}
              </option>
            ))}
            <option value="__ny">+ Ny organisasjon</option>
          </select>
        </div>
        <div className="meny-seksjon">Meny</div>
        <NavLink to="/" end>
          <IkonOversikt />
          {org?.type === "regnskapsbyraa" ? "Klienter" : "Oversikt"}
        </NavLink>
        {org?.type !== "regnskapsbyraa" && (
          <>
            <NavLink to="/fakturaer">
              <IkonFaktura />
              Fakturaer
            </NavLink>
            <NavLink to="/gjentakende">
              <IkonGjenta />
              Gjentakende
            </NavLink>
            <NavLink to="/kunder">
              <IkonKunder />
              Kunder
            </NavLink>
            <NavLink to="/produkter">
              <IkonProdukter />
              Produkter
            </NavLink>
            <NavLink to="/rapporter">
              <IkonRapport />
              Rapporter
            </NavLink>
          </>
        )}
        <div className="meny-seksjon">Konto</div>
        <NavLink to="/innstillinger">
          <IkonInnstillinger />
          Innstillinger
        </NavLink>
        {org?.verifisering === "ny" && org.direkte_medlem && (
          <NavLink to="/verifisering">
            <IkonSkjold />
            Verifiser organisasjon
          </NavLink>
        )}
        {meg?.plattformadmin && (
          <NavLink to="/admin">
            <IkonNokkel />
            Administrasjon
          </NavLink>
        )}
        {kanInstallere && (
          <a href="#" onClick={(e) => (e.preventDefault(), void installer())}>
            <IkonInstaller />
            Installer appen
          </a>
        )}
        <div className="bunn">
          <span className="avatar rund">{initialer(meg?.bruker.navn ?? meg?.bruker.epost ?? "?")}</span>
          <div className="hvem">
            <div>{meg?.bruker.navn}</div>
            <span>{meg?.bruker.epost}</span>
          </div>
          <button className="ikon" onClick={loggUt} title="Logg ut" aria-label="Logg ut">
            <IkonLoggUt />
          </button>
        </div>
      </nav>
      <main className="innhold">
        {org && (
          <Routes>
            <Route path="/" element={<Oversikt />} />
            <Route path="/fakturaer" element={<Fakturaliste />} />
            <Route path="/fakturaer/ny" element={<FakturaSkjema key="ny" />} />
            <Route path="/fakturaer/flere" element={<FlereFakturaer />} />
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

function Sider() {
  const { laster, bruker, meg, loggUt } = useKonto();
  if (laster) return <div className="sentrert"><Laster /></div>;
  if (!bruker) return <Innlogging />;
  if (!bruker.emailVerified) return <BekreftEpost epost={bruker.email ?? ""} loggUt={loggUt} />;
  if (!meg) return <div className="sentrert"><Laster /></div>;
  if (!meg.bruker.navn || meg.bruker.navn.trim().length < 2) return <OppgiNavn />;
  return (
    <Routes>
      <Route path="/invitasjon/:token" element={<div className="innhold frittstaende"><Invitasjon /></div>} />
      <Route path="*" element={<Ramme />} />
    </Routes>
  );
}

// Applåsen ligger ytterst, så den kan vises (og Face ID starte) før innloggingen har lastet.
function Innhold() {
  return (
    <AppLaas>
      <Sider />
    </AppLaas>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <KontoProvider>
        <Innhold />
        <PwaBannere />
      </KontoProvider>
    </BrowserRouter>
  );
}
