import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { updateProfile } from "firebase/auth";
import { hentAuth } from "./firebase";
import { BrowserRouter, NavLink, Navigate, Route, Routes, useLocation, useNavigate, useParams } from "react-router-dom";
import { api } from "./api";
import { Feil, Laster, Tom } from "./felles";
import { KontoProvider, erAdmin, erAnsatt, harFunksjon, kanSePersonal, kanSkrive, useKonto, type Funksjon } from "./konto";
import { BekreftEpost, Innlogging, VenterPaaGodkjenning } from "./sider/Innlogging";
import { NyOrganisasjon } from "./sider/NyOrganisasjon";
import { Oversikt } from "./sider/Oversikt";
import { Kunder, Produkter } from "./sider/Register";
import { Importer } from "./sider/Importer";
import { FakturaSkjema, FakturaVisning, Fakturaliste } from "./sider/Fakturaer";
import { FlereFakturaer } from "./sider/Flere";
import { Innstillinger } from "./sider/Innstillinger";
import { Verifisering } from "./sider/Verifisering";
import { Admin } from "./sider/Admin";
import { Gjentakende } from "./sider/Gjentakende";
import { SendFraPaaminnelse } from "./sider/Paaminnelser";
import { Rapporter } from "./sider/Rapporter";
import { BankTilbake, Innbetalinger } from "./sider/Bank";
import { Ansatte } from "./sider/Ansatte";
import { Timer } from "./sider/Timer";
import { Vakter } from "./sider/Vakter";
import { Ferie } from "./sider/Ferie";
import { Logo } from "./Logo";
import { PwaBannere, usePwa, useVarselNavigering } from "./Pwa";
import { AppLaas } from "./Applaas";
import { TemaBryter } from "./TemaBryter";
import { installer } from "./pwa";
import { Assistent } from "./assistent";
import { iFakturadelen } from "./fakturameny";
import {
  IkonAnsatte, IkonFaktura, IkonFerie, IkonInnstillinger, IkonInstaller, IkonKalender, IkonKlokke, IkonKunder, IkonLoggUt, IkonMeny, IkonNokkel, IkonOversikt, IkonPluss,
  IkonProdukter, IkonRapport, IkonSkjold, IkonVelg,
} from "./ikoner";

const initialer = (navn: string) =>
  navn
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((d) => d[0]!.toUpperCase())
    .join("");

const orgType: Record<string, string> = { foretak: "Foretak", regnskapsbyraa: "Regnskapsbyrå", privatperson: "Privatperson" };

// En side som hører til en funksjon organisasjonen ikke har (funksjonene i Administrasjon).
function Krever({ kode, navn, children }: { kode: Funksjon | Funksjon[]; navn: string; children: ReactNode }) {
  const { org } = useKonto();
  if ((Array.isArray(kode) ? kode : [kode]).some((k) => harFunksjon(org, k))) return <>{children}</>;
  return (
    <>
      <h1>{navn}</h1>
      <div className="kort">
        <Tom ikon={<IkonSkjold storrelse={22} />} tittel={`${navn} er ikke slått på`}>
          <p>Funksjonen er ikke slått på for {org?.navn}. Ta kontakt med HI4 Faktura hvis dere vil ha den.</p>
        </Tom>
      </div>
    </>
  );
}

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

// Ny faktura: skjemaet starter på nytt når adressen endres, f.eks. fra en kopi til en tom faktura.
function NyFaktura() {
  const { search } = useLocation();
  return <FakturaSkjema key={search} />;
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
  // Den kommer tilbake litt etter at feltet mister fokus: ellers dukker den opp under fingeren
  // idet man trykker på en knapp nederst (som «Send faktura»), og trykket går tapt.
  useEffect(() => {
    const erFelt = (e: Event) => {
      const el = e.target as HTMLElement;
      return el.matches?.("textarea, select, input:not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit])");
    };
    let tid: number | undefined;
    const inn = (e: FocusEvent) => {
      if (!erFelt(e)) return;
      clearTimeout(tid);
      document.body.classList.add("skriver");
    };
    const ut = (e: FocusEvent) => {
      if (!erFelt(e)) return;
      clearTimeout(tid);
      tid = window.setTimeout(() => document.body.classList.remove("skriver"), 300);
    };
    document.addEventListener("focusin", inn);
    document.addEventListener("focusout", ut);
    return () => {
      clearTimeout(tid);
      document.removeEventListener("focusin", inn);
      document.removeEventListener("focusout", ut);
    };
  }, []);
  const orgs = meg?.organisasjoner ?? [];
  // Ansatte (rollen ansatt) ser bare timene sine. Ellers: Ansatte og Timer når det er slått på.
  const ansatt = erAnsatt(org?.rolle);
  const visAnsatte = !ansatt && !!org?.personal && kanSePersonal(org.rolle);
  const visTimer = ansatt || (!!org?.personal && (kanSePersonal(org.rolle) || !!org.ansatt_id));
  const visVakter = harFunksjon(org, "vaktplan");
  // Feriebanken: eier og administrator ser alle, den ansatte seg selv (regnskap ser den ikke).
  const visFerie = visVakter && !!org?.personal && (ansatt || erAdmin(org.rolle));

  if (ny || orgs.length === 0) {
    return (
      <div className="innhold frittstaende" style={{ margin: "0 auto" }}>
        <h1>{orgs.length === 0 ? "Velkommen til HI4 Faktura" : "Ny organisasjon"}</h1>
        {orgs.length === 0 && (
          <p className="dempet">
            {/* Uten Faktura blant modulene (bare Bemanning) er det ikke fakturering det handler om. */}
            {meg?.bruker.moduler?.length && !meg.bruker.moduler.includes("faktura")
              ? "Start med å legge inn foretaket ditt."
              : "Start med å legge inn foretaket du skal fakturere fra, eller regnskapsbyrået ditt."}
          </p>
        )}
        <NyOrganisasjon avbryt={orgs.length ? () => settNy(false) : undefined} />
        <p className="liten dempet">
          Fått en invitasjon? Åpne lenken i e-posten. · <button className="lenke" onClick={loggUt}>Logg ut</button>
        </p>
      </div>
    );
  }

  return (
    <div className="ramme">
      {/* Mobil: logo øverst (trykk for menyen), utseende og logg ut til høyre; menyen ligger
          også i bunnmenyen («Mer»). */}
      <header className="mobiltopp">
        <button type="button" className="logo-knapp" aria-label="Åpne menyen" aria-controls="hovedmeny" aria-expanded={menyApen} onClick={() => settMenyApen(true)}>
          <Logo storrelse={30} />
        </button>
        <div className="topp-knapper">
          <TemaBryter />
          <button
            type="button"
            className="ikon"
            aria-label="Logg ut"
            title="Logg ut"
            onClick={() => confirm("Logge ut av HI4 Faktura?") && void loggUt()}
          >
            <IkonLoggUt storrelse={20} />
          </button>
        </div>
      </header>
      <nav className="bunnmeny" aria-label="Hovedmeny">
        {ansatt ? (
          <>
            <NavLink to="/timer">
              <IkonKlokke storrelse={22} />
              <span>Timer</span>
            </NavLink>
            {visVakter && (
              <NavLink to="/vakter">
                <IkonKalender storrelse={22} />
                <span>Vakter</span>
              </NavLink>
            )}
          </>
        ) : (
          <NavLink to="/" end>
            <IkonOversikt storrelse={22} />
            <span>{org?.type === "regnskapsbyraa" ? "Klienter" : "Oversikt"}</span>
          </NavLink>
        )}
        {!ansatt && org?.type !== "regnskapsbyraa" && (
          <>
            <NavLink to="/fakturaer" end={false} className={({ isActive }) => (isActive || iFakturadelen(sted.pathname) ? "active" : undefined)}>
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
        {(ansatt || org?.type === "regnskapsbyraa") && (
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
      <nav
        id="hovedmeny"
        className={`meny${menyApen ? " apen" : ""}`}
        onClick={(e) => {
          // Også når man trykker på siden man er på (da endres ikke adressen).
          if ((e.target as HTMLElement).closest("a")) settMenyApen(false);
        }}
      >
        <div className="logo" onClick={() => settMenyApen(false)}>
          <Logo />
        </div>
        <div className="orgvelger">
          <span className="avatar">{initialer(org?.navn ?? "?")}</span>
          <div style={{ minWidth: 0 }}>
            <div className="navn">{org?.navn}</div>
            <div className="type">
              {org ? (ansatt ? "Ansatt" : orgType[org.type] ?? org.type) : ""}
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
        {ansatt ? (
          <>
            <NavLink to="/timer">
              <IkonKlokke />
              Timer
            </NavLink>
            {visVakter && (
              <NavLink to="/vakter">
                <IkonKalender />
                Vakter
              </NavLink>
            )}
            {visFerie && (
              <NavLink to="/ferie">
                <IkonFerie />
                Ferie
              </NavLink>
            )}
          </>
        ) : (
          <NavLink to="/" end>
            <IkonOversikt />
            {org?.type === "regnskapsbyraa" ? "Klienter" : "Oversikt"}
          </NavLink>
        )}
        {!ansatt && org?.type !== "regnskapsbyraa" && (
          <>
            {/* Gjentakende og innbetalinger ligger under Fakturaer (fakturameny.tsx). */}
            <NavLink to="/fakturaer" className={({ isActive }) => (isActive || iFakturadelen(sted.pathname) ? "active" : undefined)}>
              <IkonFaktura />
              Fakturaer
            </NavLink>
            <NavLink to="/kunder">
              <IkonKunder />
              Kunder
            </NavLink>
            <NavLink to="/produkter">
              <IkonProdukter />
              Produkter
            </NavLink>
            {harFunksjon(org, "rapporter") && (
              <NavLink to="/rapporter">
                <IkonRapport />
                Rapporter
              </NavLink>
            )}
          </>
        )}
        {!ansatt && (visAnsatte || visTimer) && (
          <>
            <div className="meny-seksjon">Personal</div>
            {visAnsatte && (
              <NavLink to="/ansatte">
                <IkonAnsatte />
                Ansatte
              </NavLink>
            )}
            {visTimer && visVakter && (
              <NavLink to="/vakter">
                <IkonKalender />
                Vaktplan
              </NavLink>
            )}
            {visTimer && (
              <NavLink to="/timer">
                <IkonKlokke />
                Timer
              </NavLink>
            )}
            {visFerie && (
              <NavLink to="/ferie">
                <IkonFerie />
                Ferie
              </NavLink>
            )}
          </>
        )}
        <div className="meny-seksjon">Konto</div>
        <NavLink to="/innstillinger">
          <IkonInnstillinger />
          Innstillinger
        </NavLink>
        {org?.verifisering === "ny" && org.direkte_medlem && !ansatt && (
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
        <div className="meny-tema">
          <span>Utseende</span>
          <TemaBryter />
        </div>
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
        {org && ansatt && (
          <Routes>
            <Route path="/timer" element={<Timer />} />
            <Route path="/vakter" element={<Krever kode="vaktplan" navn="Vakter"><Vakter /></Krever>} />
            <Route path="/ferie" element={<Krever kode="vaktplan" navn="Ferie"><Ferie /></Krever>} />
            <Route path="/innstillinger" element={<Innstillinger />} />
            {meg?.plattformadmin && <Route path="/admin" element={<Admin />} />}
            <Route path="/invitasjon/:token" element={<Invitasjon />} />
            <Route path="*" element={<Navigate to="/timer" replace />} />
          </Routes>
        )}
        {org && !ansatt && (
          <Routes>
            <Route path="/" element={<Oversikt />} />
            <Route path="/fakturaer" element={<Fakturaliste />} />
            <Route path="/fakturaer/ny" element={<NyFaktura />} />
            <Route path="/fakturaer/flere" element={<Krever kode="flere" navn="Flere fakturaer"><FlereFakturaer /></Krever>} />
            <Route path="/fakturaer/:id/endre" element={<FakturaSkjema />} />
            <Route path="/fakturaer/:id" element={<FakturaVisning />} />
            <Route path="/gjentakende" element={<Krever kode={["gjentakende", "paaminnelser"]} navn="Gjentakende fakturaer"><Gjentakende /></Krever>} />
            <Route path="/paaminnelser" element={<Navigate to="/gjentakende?fane=paaminnelser" replace />} />
            <Route path="/paaminnelser/:id" element={<Krever kode="paaminnelser" navn="Påminnelser"><SendFraPaaminnelse /></Krever>} />
            <Route path="/innbetalinger" element={<Krever kode="bank" navn="Innbetalinger"><Innbetalinger /></Krever>} />
            <Route path="/bank/tilbake" element={<Krever kode="bank" navn="Bank"><BankTilbake /></Krever>} />
            <Route path="/kunder" element={<Kunder />} />
            <Route path="/kunder/importer" element={<Krever kode="import" navn="Importer kunder"><Importer key="kunder" type="kunder" /></Krever>} />
            <Route path="/rapporter" element={<Krever kode="rapporter" navn="Rapporter"><Rapporter /></Krever>} />
            <Route path="/produkter" element={<Produkter />} />
            <Route path="/produkter/importer" element={<Krever kode="import" navn="Importer produkter"><Importer key="produkter" type="produkter" /></Krever>} />
            <Route path="/ansatte" element={<Ansatte />} />
            <Route path="/ansatte/importer" element={<Krever kode="import" navn="Importer ansatte"><Importer key="ansatte" type="ansatte" /></Krever>} />
            <Route path="/vakter" element={<Krever kode="vaktplan" navn="Vaktplan"><Vakter /></Krever>} />
            <Route path="/ferie" element={<Krever kode="vaktplan" navn="Ferie"><Ferie /></Krever>} />
            <Route path="/timer" element={<Timer />} />
            <Route path="/innstillinger" element={<Innstillinger />} />
            <Route path="/verifisering" element={<Verifisering />} />
            {meg?.plattformadmin && <Route path="/admin" element={<Admin />} />}
            <Route path="/invitasjon/:token" element={<Invitasjon />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        )}
      </main>
      {org && !ansatt && <Assistent key={org.id} />}
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
  // Nye kontoer venter på godkjenning fra HI4 Faktura (en invitasjon godkjenner kontoen).
  if ((meg.bruker.status ?? "godkjent") !== "godkjent")
    return (
      <Routes>
        <Route path="/invitasjon/:token" element={<div className="innhold frittstaende"><Invitasjon /></div>} />
        <Route path="*" element={<VenterPaaGodkjenning />} />
      </Routes>
    );
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
