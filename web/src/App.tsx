import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { updateProfile } from "firebase/auth";
import { hentAuth } from "./firebase";
import { BrowserRouter, Link, NavLink, Navigate, Route, Routes, useLocation, useNavigate, useParams } from "react-router-dom";
import { api } from "./api";
import { Feil, Laster, Tom } from "./felles";
import {
  KontoProvider, erAdmin, erAnsatt, harFunksjon, kanLonn, kanPersonal, kanSeLonn, kanSePersonal, kanSeRegnskap, kanSkrive, timerOgFerie, useKonto, visFakturadelen, type Funksjon,
} from "./konto";
import { Innlogging, VenterPaaGodkjenning } from "./sider/Innlogging";
import { BekreftEpost, BekreftLenke } from "./sider/Bekreftelse";
import { NyOrganisasjon } from "./sider/NyOrganisasjon";
import { Oversikt } from "./sider/Oversikt";
import { AnsattOversikt } from "./sider/AnsattOversikt";
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
import { MittFravaerSide } from "./sider/Fravaer";
import { MinSide } from "./sider/MinSide";
import { Beskjeder, useUlesteBeskjeder } from "./sider/Beskjeder";
import { Sjekklister } from "./sider/Sjekklister";
import { Lonn } from "./sider/Lonn";
import { Regnskap } from "./sider/Regnskap";
import { Logo } from "./Logo";
import { PwaBannere, usePwa, useVarselNavigering } from "./Pwa";
import { AppLaas } from "./Applaas";
import { TemaBryter } from "./TemaBryter";
import { installer } from "./pwa";
import { Assistent } from "./assistent";
import { iFakturadelen } from "./fakturameny";
import { SkattekortGodkjent } from "./sider/Skattekort";
import {
  IkonAarsoppgjor, IkonAnlegg, IkonAnsatte, IkonAvskrivning, IkonBalanse, IkonBank, IkonBilag, IkonBjelle, IkonBytte, IkonDrift, IkonEkstraTimer, IkonFaktura, IkonFerie,
  IkonFravaer, IkonInnstillinger, IkonInstaller, IkonKalender, IkonKlokke, IkonKontoplan, IkonKunder, IkonLedigeVakter, IkonLoggUt, IkonLonn, IkonMeny, IkonMineVakter, IkonMva, IkonSkatteetaten,
  IkonNed, IkonNokkel, IkonOversikt, IkonPeriodisering, IkonPerson, IkonPluss, IkonProdukter, IkonRapport, IkonReise, IkonSjekkliste, IkonSkjold, IkonTavle, IkonTimebank,
  IkonUtgift, IkonVelg,
} from "./ikoner";

const initialer = (navn: string) =>
  navn
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((d) => d[0]!.toUpperCase())
    .join("");

const orgType: Record<string, string> = { foretak: "Foretak", regnskapsbyraa: "Regnskapsbyrå", privatperson: "Privatperson" };
// Antall nye beskjeder (99+ over det).
const UlesteTall = ({ n }: { n: number }) => (n > 0 ? <span className="ulest-tall" aria-label={`${n} nye`}>{n > 99 ? "99+" : n}</span> : null);

// Punktene i sidemenyen, i kategorier (Plattform, Faktura, Personal, Lønn, Regnskap).
type MenyIkon = (p: { storrelse?: number }) => ReactNode;
type MenyPunkt = { til: string; Ikon: MenyIkon; tekst: string; aktiv: boolean; teller?: number };
type MenyKategoriData = { navn: string; punkter: MenyPunkt[]; aktiv: boolean };

function MenyLenke({ x }: { x: MenyPunkt }) {
  return (
    <Link to={x.til} className={x.aktiv ? "active" : undefined} aria-current={x.aktiv ? "page" : undefined}>
      <x.Ikon />
      {x.tekst}
      <UlesteTall n={x.teller ?? 0} />
    </Link>
  );
}

// En kategori som foldes ut og sammen med overskriften. Lukket viser den antall nye (beskjedene),
// og en prikk når siden man er på, ligger i den.
function MenyKategori({ k, apen, veksle }: { k: MenyKategoriData; apen: boolean; veksle: () => void }) {
  const id = `meny-${k.navn.toLowerCase().replace(/[^a-z0-9æøå]+/g, "-")}`;
  const teller = k.punkter.reduce((n, x) => n + (x.teller ?? 0), 0);
  return (
    <div className={`meny-gruppe${apen ? " apen" : ""}`}>
      <button type="button" className={`meny-kategori${k.aktiv && !apen ? " har-aktiv" : ""}`} aria-expanded={apen} aria-controls={id} onClick={veksle}>
        <span className="meny-kategori-navn">{k.navn}</span>
        {!apen && <UlesteTall n={teller} />}
        <IkonNed storrelse={16} />
      </button>
      <div id={id} className="meny-punkter" hidden={!apen}>
        {k.punkter.map((x) => (
          <MenyLenke key={x.til} x={x} />
        ))}
      </div>
    </div>
  );
}

// En side som hører til en funksjon organisasjonen ikke har (funksjonene i Administrasjon).
function Krever({ kode, navn, children }: { kode: Funksjon | Funksjon[]; navn: string; children: ReactNode }) {
  const { org } = useKonto();
  if ((Array.isArray(kode) ? kode : [kode]).some((k) => harFunksjon(org, k))) return <>{children}</>;
  return (
    <>
      <h1>{navn}</h1>
      <div className="kort">
        <Tom ikon={<IkonSkjold storrelse={22} />} tittel={`${navn} er ikke slått på`}>
          <p>Funksjonen er ikke slått på for {org?.navn}. Ta kontakt med Admin Konsoll hvis dere vil ha den.</p>
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
  // Kategoriene i sidemenyen som er åpne (lukket som standard).
  const [apne, settApne] = useState<ReadonlySet<string>>(() => new Set());
  const veksle = (navn: string) =>
    settApne((a) => {
      const n = new Set(a);
      if (n.has(navn)) n.delete(navn);
      else n.add(navn);
      return n;
    });
  const { kanInstallere } = usePwa();
  useVarselNavigering();
  const sted = useLocation();
  const nav = useNavigate();
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
  const ansatt = erAnsatt(org);
  const visAnsatte = !ansatt && !!org?.personal && kanSePersonal(org);
  const visTimer = ansatt || (!!org?.personal && (kanSePersonal(org) || !!org.ansatt_id));
  const visVakter = harFunksjon(org, "vaktplan");
  // Feriebanken: eier og administrator (og en egen rolle med Personal) ser alle, den ansatte seg
  // selv (regnskap ser den ikke).
  const visFerie = visVakter && !!org?.personal && (ansatt || kanPersonal(org));
  // Beskjeder til rollene: alle i organisasjonen, når Ansatte og timer er slått på. Telleren viser
  // de nye (ikke mens man er på siden).
  const visBeskjeder = !!org?.personal;
  // Sjekklister (Sjekklister.tsx): alle i organisasjonen, når funksjonen er på; serveren avgjør
  // hvilke sjekklister hver ser (rollene) og hvem som lager dem og lukker avvikene.
  const visSjekklister = !!org?.personal && harFunksjon(org, "sjekklister");
  // Lønn: eier, administrator og regnskap (og en egen rolle med Lønn) ser lønnskjøringene, og den
  // som er ansatt, sine egne lønnsslipper (funksjonen «Lønn» bygger på ansatte og timer).
  const visLonn = harFunksjon(org, "lonn") && !!org?.personal && ((!ansatt && kanSeLonn(org)) || !!org.ansatt_id);
  // Fakturaene, kundene og produktene: modulen Faktura, for dem som ser fakturaene.
  const visFaktura = visFakturadelen(org);
  // Rapporter (felles rapportmodul): fakturarapportene med funksjonen «Rapporter», og personal- og
  // lønnsrapportene for eier, administrator og regnskap. Serveren velger rapport for rapport.
  // Regnskap (anleggsmidlene og saldoavskrivningene): eier, administrator og regnskap.
  const visRegnskap = !ansatt && harFunksjon(org, "regnskap") && kanSeRegnskap(org);
  const visRapporter =
    !ansatt &&
    ((visFaktura && harFunksjon(org, "rapporter")) || visRegnskap || (kanSePersonal(org) && harFunksjon(org, "ansatte")) || (kanSeLonn(org) && harFunksjon(org, "lonn")));
  const uleste = useUlesteBeskjeder(org?.id, visBeskjeder);
  const nyeBeskjeder = sted.pathname === "/beskjeder" ? 0 : uleste;
  // Personalmodulen (Ansatte, Vaktplan, Timer, Ferie og Beskjeder): tettere på mobil (styles.css),
  // og bunnmenyen viser personaldelen i stedet for fakturadelen der.
  const iPersonal = /^\/(ansatte|vakter|timer|ferie|beskjeder|sjekklister|lonn|fravaer|meg)(\/|$)/.test(sted.pathname);
  // Eier og administrator har Timer og Ferie som ett punkt, «Timer og ferie» (Ferie er en fane på Timer).
  const iTimerOgFerie = sted.pathname === "/timer" || (timerOgFerie(org) && sted.pathname === "/ferie");
  // Menyen til de ansatte: det som ellers ligger i faner på sidene (vaktene, timene, lønnen), er
  // egne punkter, i grupper. Bunnmenyen på mobil har Kalender, Ekstra timer, Fravær og Min side,
  // og resten under «Mer».
  const her = new URLSearchParams(sted.search);
  // På siden, med fanen (eller uten fane i adressen, når fanen er den siden viser først).
  const paa = (sti: string, fane: string, forst = false) => sted.pathname === sti && (her.get("fane") === fane || (forst && !her.get("fane")));
  // Kalenderen og tavla: ikke for en som har sluttet (ser_planen).
  const ansattSerPlanen = ansatt && visVakter && org?.ser_planen !== false;
  // bunn: med i bunnmenyen (bunnAktiv: valgt der, der et punkt står for flere i sidemenyen).
  type AnsattPunkt = {
    til: string;
    Ikon: (p: { storrelse?: number }) => ReactNode;
    tekst: string;
    kort?: string;
    aktiv: boolean;
    teller?: number;
    bunn?: boolean;
    bunnAktiv?: boolean;
  };
  const ansattGrupper: [string, AnsattPunkt[]][] = !ansatt
    ? []
    : (
        [
          [
            "Vakter",
            visVakter
              ? [
                  ansattSerPlanen && {
                    til: "/vakter?fane=plan&visning=turnus",
                    Ikon: IkonKalender,
                    tekst: "Kalender",
                    aktiv: paa("/vakter", "plan", true) || paa("/vakter", "kalender"),
                    bunn: true,
                    bunnAktiv: sted.pathname === "/vakter",
                  },
                  { til: "/vakter?fane=mine", Ikon: IkonMineVakter, tekst: "Mine vakter", aktiv: paa("/vakter", "mine", !ansattSerPlanen) },
                  { til: "/vakter?fane=ledige", Ikon: IkonLedigeVakter, tekst: "Ledige vakter", aktiv: paa("/vakter", "ledige") },
                  org?.vaktbytte !== "av" && { til: "/vakter?fane=bytter", Ikon: IkonBytte, tekst: "Bytte vakter", aktiv: paa("/vakter", "bytter") },
                  ansattSerPlanen && { til: "/vakter?fane=tavle", Ikon: IkonTavle, tekst: "Tavle", aktiv: paa("/vakter", "tavle") },
                ]
              : [],
          ],
          [
            "Timer og fravær",
            [
              { til: "/timer", Ikon: IkonKlokke, tekst: "Timer", aktiv: paa("/timer", "mine", true) && her.get("send") !== "1" },
              {
                til: "/timer?send=1",
                Ikon: IkonEkstraTimer,
                tekst: "Send ekstra timer",
                kort: "Ekstra timer",
                aktiv: sted.pathname === "/timer" && her.get("send") === "1",
                bunn: true,
                bunnAktiv: sted.pathname === "/timer",
              },
              !!org?.timebank && { til: "/timer?fane=timebank", Ikon: IkonTimebank, tekst: "Timebank", aktiv: paa("/timer", "timebank") },
              visVakter && { til: "/fravaer?ny=1", Ikon: IkonFravaer, tekst: "Registrer fravær", kort: "Fravær", aktiv: sted.pathname === "/fravaer", bunn: true },
              visFerie && { til: "/ferie", Ikon: IkonFerie, tekst: "Ferie", aktiv: sted.pathname === "/ferie" },
            ],
          ],
          ["Sjekklister", [visSjekklister && { til: "/sjekklister", Ikon: IkonSjekkliste, tekst: "Sjekklister", aktiv: sted.pathname === "/sjekklister" }]],
          [
            "Lønn",
            visLonn
              ? [
                  { til: "/lonn?fane=mine", Ikon: IkonLonn, tekst: "Lønnsslipper", aktiv: paa("/lonn", "mine", true) },
                  { til: "/lonn?fane=reiser", Ikon: IkonReise, tekst: "Reiser", aktiv: paa("/lonn", "reiser") },
                ]
              : [],
          ],
          [
            "Meg",
            [
              { til: "/meg", Ikon: IkonPerson, tekst: "Min side", aktiv: sted.pathname === "/meg" },
              visBeskjeder && { til: "/beskjeder", Ikon: IkonBjelle, tekst: "Beskjeder", aktiv: sted.pathname === "/beskjeder", teller: nyeBeskjeder },
            ],
          ],
        ] as [string, (AnsattPunkt | false)[]][]
      )
        .map(([navn, punkter]): [string, AnsattPunkt[]] => [navn, punkter.filter((x): x is AnsattPunkt => !!x)])
        .filter(([, punkter]) => punkter.length > 0);
  const ansattLenke = (x: AnsattPunkt, bunn = false) => {
    const aktiv = bunn ? (x.bunnAktiv ?? x.aktiv) : x.aktiv;
    return (
      <Link key={x.til} to={x.til} className={aktiv ? "active" : undefined} aria-current={aktiv ? "page" : undefined}>
        <x.Ikon storrelse={bunn ? 22 : undefined} />
        {bunn ? <span>{x.kort ?? x.tekst}</span> : x.tekst}
        {!bunn && <UlesteTall n={x.teller ?? 0} />}
      </Link>
    );
  };
  // Bunnmenyen viser personaldelen på personalsidene, og alltid når fakturadelen ikke er med.
  const personalmeny = !ansatt && (iPersonal || (!visFaktura && org?.type !== "regnskapsbyraa")) && (visAnsatte || visTimer || visBeskjeder);
  // Regnskapet er en egen seksjon i menyen, med fanene på Regnskap som punkter (Regnskap.tsx; uten
  // fane i adressen er det bilagene).
  const regnskapFane = sted.pathname === "/regnskap" ? (her.get("fane") ?? "bilag") : null;
  const regnskapPunkter: [string, string, (p: { storrelse?: number }) => ReactNode][] = [
    ["bilag", "Bilag", IkonBilag],
    ["utgifter", "Utgifter", IkonUtgift],
    ["bank", "Bank", IkonBank],
    ["mva", "Mva", IkonMva],
    ["skatteetaten", "Skatteetaten", IkonSkatteetaten],
    ["saldobalanse", "Saldobalanse", IkonBalanse],
    ["aarsoppgjor", "Årsoppgjør", IkonAarsoppgjor],
    ["anlegg", "Anleggsmidler", IkonAnlegg],
    ["periodiseringer", "Periodiseringer", IkonPeriodisering],
    ["saldo", "Saldoavskrivninger", IkonAvskrivning],
    ["kontoer", "Kontoer", IkonKontoplan],
  ];
  // Plattformadministratoren (GitHub-variabelen ADMIN_EPOSTER) har sin egen oversikt over plattformen,
  // organisasjonene og driften (fanene i Admin.tsx).
  const adminFane = sted.pathname === "/admin" ? (her.get("fane") ?? "oversikt") : null;
  const plattformPunkter: [string, string, string[], (p: { storrelse?: number }) => ReactNode][] = [
    ["/admin", "Plattformoversikt", ["oversikt"], IkonNokkel],
    ["/admin?fane=organisasjoner", "Organisasjoner", ["organisasjoner", "funksjoner", "brukere"], IkonSkjold],
    ["/admin?fane=drift", "Drift", ["drift"], IkonDrift],
  ];

  // Sidemenyen: Oversikt øverst, så kategoriene: Plattform (plattformadministratoren) og modulene
  // (Faktura, Personal, Lønn, Regnskap og Rapporter; de ansatte har sine egne grupper). Kategoriene
  // foldes ut og sammen og er lukket som standard; den med siden man er på, åpnes når man kommer dit.
  // En kategori med ett punkt er en vanlig lenke. Konto (Innstillinger) står nederst som før.
  const punkt = (til: string, Ikon: MenyIkon, tekst: string, aktiv: boolean, teller?: number): MenyPunkt => ({ til, Ikon, tekst, aktiv, teller });
  const kategori = (navn: string, punkter: (MenyPunkt | false | null | undefined)[], aktiv = false): MenyKategoriData => {
    const p = punkter.filter((x): x is MenyPunkt => !!x);
    return { navn, punkter: p, aktiv: aktiv || p.some((x) => x.aktiv) };
  };
  // Lønnen: fanene på Lønn som punkter (Lonn.tsx); lederen ser kjøringene først, ellers egne slipper.
  const lonnLeder = !ansatt && kanSeLonn(org);
  const kategorier = [
    meg?.plattformadmin &&
      kategori(
        "Plattform",
        plattformPunkter.map(([til, tekst, faner, Ikon]) => punkt(til, Ikon, tekst, !!adminFane && faner.includes(adminFane))),
        sted.pathname === "/admin",
      ),
    ...(org && !ansatt
      ? [
          visFaktura &&
            kategori("Faktura", [
              punkt("/fakturaer", IkonFaktura, "Fakturaer", iFakturadelen(sted.pathname)),
              punkt("/kunder", IkonKunder, "Kunder", sted.pathname.startsWith("/kunder")),
              punkt("/produkter", IkonProdukter, "Produkter", sted.pathname.startsWith("/produkter")),
            ]),
          kategori("Personal", [
            visAnsatte && punkt("/ansatte", IkonAnsatte, "Ansatte", sted.pathname.startsWith("/ansatte")),
            visTimer && visVakter && punkt("/vakter", IkonKalender, "Vaktplan", sted.pathname === "/vakter"),
            visTimer && punkt("/timer", IkonKlokke, timerOgFerie(org) ? "Timer og ferie" : "Timer", iTimerOgFerie),
            visBeskjeder && punkt("/beskjeder", IkonBjelle, "Beskjeder", sted.pathname === "/beskjeder", nyeBeskjeder),
            visSjekklister && punkt("/sjekklister", IkonSjekkliste, "Sjekklister", sted.pathname === "/sjekklister"),
          ]),
          visLonn &&
            kategori(
              "Lønn",
              [
                lonnLeder && punkt("/lonn?fane=kjoringer", IkonLonn, "Lønnskjøringer", paa("/lonn", "kjoringer", true)),
                lonnLeder && punkt("/lonn?fane=amelding", IkonRapport, "A-melding", paa("/lonn", "amelding")),
                lonnLeder && kanLonn(org) && punkt("/lonn?fane=sykepenger", IkonFravaer, "Sykepenger", paa("/lonn", "sykepenger")),
                lonnLeder && punkt("/lonn?fane=aar", IkonKalender, "Årsoversikt", paa("/lonn", "aar")),
                lonnLeder && punkt("/lonn?fane=reiser", IkonReise, "Reiser", paa("/lonn", "reiser")),
                !!org.ansatt_id && punkt("/lonn?fane=mine", IkonPerson, "Mine lønnsslipper", paa("/lonn", "mine", !lonnLeder)),
                !!org.ansatt_id && !lonnLeder && punkt("/lonn?fane=reiser", IkonReise, "Mine reiser", paa("/lonn", "reiser")),
              ],
              sted.pathname === "/lonn" || sted.pathname.startsWith("/skattekort"),
            ),
          // Regnskap og Rapporter: ikke for byrået selv (klientene har sine).
          visRegnskap &&
            org.type !== "regnskapsbyraa" &&
            kategori(
              "Regnskap",
              regnskapPunkter.map(([fane, tekst, Ikon]) => punkt(fane === "bilag" ? "/regnskap" : `/regnskap?fane=${fane}`, Ikon, tekst, regnskapFane === fane)),
              sted.pathname === "/regnskap",
            ),
          visRapporter && org.type !== "regnskapsbyraa" && kategori("Rapporter", [punkt("/rapporter", IkonRapport, "Rapporter", sted.pathname === "/rapporter")]),
        ]
      : []),
    ...(org && ansatt ? ansattGrupper.map(([navn, punkter]) => kategori(navn, punkter.map((x) => punkt(x.til, x.Ikon, x.tekst, x.aktiv, x.teller)))) : []),
  ].filter((k): k is MenyKategoriData => !!k && k.punkter.length > 0);
  const aktivKategori = kategorier.find((k) => k.aktiv && k.punkter.length > 1)?.navn ?? null;

  // Kategorien med siden man er på, åpnes når man kommer dit (også om den var lukket).
  useEffect(() => {
    if (aktivKategori) settApne((a) => (a.has(aktivKategori) ? a : new Set(a).add(aktivKategori)));
  }, [aktivKategori, sted.pathname, sted.search]);

  // Plattformadministratoren kommer inn også uten organisasjon (til sin egen oversikt).
  if (ny || (orgs.length === 0 && !meg?.plattformadmin)) {
    return (
      <div className="innhold frittstaende" style={{ margin: "0 auto" }}>
        <h1>{orgs.length === 0 && !meg?.plattformadmin ? "Velkommen til Admin Konsoll" : "Ny organisasjon"}</h1>
        {orgs.length === 0 && !meg?.plattformadmin && (
          <p className="dempet">
            {/* Uten Faktura blant modulene (bare Bemanning) er det ikke fakturering det handler om. */}
            {meg?.bruker.moduler?.length && !meg.bruker.moduler.includes("faktura")
              ? "Start med å legge inn foretaket ditt."
              : "Start med å legge inn foretaket du skal fakturere fra, eller regnskapsbyrået ditt."}
          </p>
        )}
        <NyOrganisasjon
          avbryt={orgs.length || meg?.plattformadmin ? () => settNy(false) : undefined}
          opprettet={() => {
            // Den nye organisasjonen er valgt: lukk skjemaet og gå til oversikten for den.
            settNy(false);
            nav("/");
          }}
        />
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
            onClick={() => confirm("Logge ut av Admin Konsoll?") && void loggUt()}
          >
            <IkonLoggUt storrelse={20} />
          </button>
        </div>
      </header>
      <nav className="bunnmeny" aria-label="Hovedmeny">
        {!org ? (
          <NavLink to="/admin">
            <IkonNokkel storrelse={22} />
            <span>Plattform</span>
          </NavLink>
        ) : ansatt ? (
          <>
            <NavLink to="/" end>
              <IkonOversikt storrelse={22} />
              <span>Oversikt</span>
            </NavLink>
            {ansattGrupper.flatMap(([, punkter]) => punkter.filter((x) => x.bunn)).map((x) => ansattLenke(x, true))}
          </>
        ) : (
          <NavLink to="/" end>
            <IkonOversikt storrelse={22} />
            <span>{org?.type === "regnskapsbyraa" ? "Klienter" : "Oversikt"}</span>
          </NavLink>
        )}
        {personalmeny && (
          <>
            {visAnsatte && (
              <NavLink to="/ansatte">
                <IkonAnsatte storrelse={22} />
                <span>Ansatte</span>
              </NavLink>
            )}
            {visTimer && visVakter && (
              <NavLink to="/vakter">
                <IkonKalender storrelse={22} />
                <span>Vaktplan</span>
              </NavLink>
            )}
            {visTimer && (
              <NavLink to="/timer" className={({ isActive }) => (isActive || iTimerOgFerie ? "active" : undefined)}>
                <IkonKlokke storrelse={22} />
                <span>Timer</span>
              </NavLink>
            )}
          </>
        )}
        {org && !ansatt && !personalmeny && visFaktura && (
          <>
            <NavLink to="/fakturaer" end={false} className={({ isActive }) => (isActive || iFakturadelen(sted.pathname) ? "active" : undefined)}>
              <IkonFaktura storrelse={22} />
              <span>Fakturaer</span>
            </NavLink>
            {kanSkrive(org) && (
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
        {org?.type === "regnskapsbyraa" && !ansatt && (
          <NavLink to="/innstillinger">
            <IkonInnstillinger storrelse={22} />
            <span>Innstillinger</span>
          </NavLink>
        )}
        <button type="button" className={menyApen ? "aktiv" : ""} onClick={() => settMenyApen(true)} aria-label={nyeBeskjeder ? `Mer (${nyeBeskjeder} nye beskjeder)` : undefined}>
          <span className="bunn-ikon">
            <IkonMeny storrelse={22} />
            {nyeBeskjeder > 0 && <span className="ulest-prikk" />}
          </span>
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
            <div className="navn">{org?.navn ?? "Ingen organisasjon"}</div>
            <div className="type">
              {/* Med en egen rolle: navnet på rollen (f.eks. Personalansvarlig). */}
              {org ? (org.rolle === "tilpasset" && org.tilgangsrolle ? org.tilgangsrolle : ansatt ? "Ansatt" : (orgType[org.type] ?? org.type)) : "Plattformadministrator"}
              {org && !org.direkte_medlem ? " · klient" : ""}
            </div>
          </div>
          <span className="pil">
            <IkonVelg storrelse={16} />
          </span>
          <select value={org?.id ?? ""} onChange={(e) => (e.target.value === "__ny" ? settNy(true) : velgOrg(e.target.value))} aria-label="Bytt organisasjon">
            {!org && (
              <option value="" disabled>
                Ingen organisasjon
              </option>
            )}
            {orgs.map((o) => (
              <option key={o.id} value={o.id}>
                {o.navn}
                {o.direkte_medlem ? "" : " (klient)"}
              </option>
            ))}
            <option value="__ny">+ Ny organisasjon</option>
          </select>
        </div>
        {/* Lista ruller, og bunnen (utseende, navn og logg ut) står fast. Oversikt øverst: forsiden
            for hver rolle (de ansatte har sin egen, AnsattOversikt.tsx; et regnskapsbyrå ser
            klientene). */}
        <div className="meny-liste">
          {org && (
            <NavLink to="/" end>
              <IkonOversikt />
              {org.type === "regnskapsbyraa" ? "Klienter" : "Oversikt"}
            </NavLink>
          )}
          {kategorier.map((k) =>
            k.punkter.length === 1 ? (
              <MenyLenke key={k.navn} x={k.punkter[0]!} />
            ) : (
              <MenyKategori key={k.navn} k={k} apen={apne.has(k.navn)} veksle={() => veksle(k.navn)} />
            ),
          )}
          {/* Konto nederst i lista, som før: Innstillinger er alltid synlig (ikke i en nedtrekk). Uten
              organisasjon (plattformadministratoren) er det bare å installere appen. */}
          {(org || kanInstallere) && <div className="meny-seksjon">Konto</div>}
          {org && (
            <NavLink to="/innstillinger">
              <IkonInnstillinger />
              Innstillinger
            </NavLink>
          )}
          {/* Bare eier og administrator verifiserer (Verifisering.tsx). */}
          {org?.verifisering === "ny" && org.direkte_medlem && erAdmin(org) && (
            <NavLink to="/verifisering">
              <IkonSkjold />
              Verifiser organisasjon
            </NavLink>
          )}
          {kanInstallere && (
            <a href="#" onClick={(e) => (e.preventDefault(), void installer())}>
              <IkonInstaller />
              Installer appen
            </a>
          )}
        </div>
        <div className="meny-fot">
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
        </div>
      </nav>
      <main className="innhold" data-modul={iPersonal ? "personal" : undefined}>
        {org && ansatt && (
          <Routes>
            <Route path="/timer" element={<Timer />} />
            <Route path="/vakter" element={<Krever kode="vaktplan" navn="Kalender"><Vakter /></Krever>} />
            <Route path="/fravaer" element={<Krever kode="vaktplan" navn="Fravær"><MittFravaerSide /></Krever>} />
            <Route path="/meg" element={<MinSide />} />
            <Route path="/ferie" element={<Krever kode="vaktplan" navn="Ferie"><Ferie /></Krever>} />
            <Route path="/beskjeder" element={<Krever kode="ansatte" navn="Beskjeder"><Beskjeder /></Krever>} />
            <Route path="/sjekklister" element={<Krever kode="sjekklister" navn="Sjekklister"><Sjekklister /></Krever>} />
            <Route path="/lonn" element={<Krever kode="lonn" navn="Lønn og reiser"><Lonn /></Krever>} />
            <Route path="/innstillinger" element={<Innstillinger />} />
            {meg?.plattformadmin && <Route path="/admin" element={<Admin />} />}
            <Route path="/invitasjon/:token" element={<Invitasjon />} />
            <Route path="/" element={<AnsattOversikt />} />
            <Route path="*" element={<Navigate to="/" replace />} />
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
            <Route path="/rapporter" element={<Krever kode={["rapporter", "ansatte", "lonn", "regnskap"]} navn="Rapporter"><Rapporter /></Krever>} />
            <Route path="/regnskap" element={<Krever kode="regnskap" navn="Regnskap"><Regnskap /></Krever>} />
            <Route path="/produkter" element={<Produkter />} />
            <Route path="/produkter/importer" element={<Krever kode="import" navn="Importer produkter"><Importer key="produkter" type="produkter" /></Krever>} />
            <Route path="/ansatte" element={<Ansatte />} />
            <Route path="/ansatte/importer" element={<Krever kode="import" navn="Importer ansatte"><Importer key="ansatte" type="ansatte" /></Krever>} />
            <Route path="/vakter" element={<Krever kode="vaktplan" navn="Vaktplan"><Vakter /></Krever>} />
            <Route path="/ferie" element={<Krever kode="vaktplan" navn="Ferie"><Ferie /></Krever>} />
            <Route path="/beskjeder" element={<Krever kode="ansatte" navn="Beskjeder"><Beskjeder /></Krever>} />
            <Route path="/sjekklister" element={<Krever kode="sjekklister" navn="Sjekklister"><Sjekklister /></Krever>} />
            <Route path="/lonn" element={<Krever kode="lonn" navn="Lønn"><Lonn /></Krever>} />
            <Route path="/skattekort/godkjent" element={<Krever kode="lonn" navn="Skattekort"><SkattekortGodkjent /></Krever>} />
            <Route path="/timer" element={<Timer />} />
            <Route path="/innstillinger" element={<Innstillinger />} />
            <Route path="/verifisering" element={<Verifisering />} />
            {meg?.plattformadmin && <Route path="/admin" element={<Admin />} />}
            <Route path="/invitasjon/:token" element={<Invitasjon />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        )}
        {!org && meg?.plattformadmin && (
          <Routes>
            <Route path="/admin" element={<Admin />} />
            <Route path="*" element={<Navigate to="/admin" replace />} />
          </Routes>
        )}
      </main>
      {/* AI-assistenten: for de ansatte bare personaldelen (serveren avgjør hva den kan). */}
      {org && <Assistent key={org.id} />}
    </div>
  );
}

function Sider() {
  const { laster, bruker, meg, loggUt } = useKonto();
  const sted = useLocation();
  // Lenken i e-posten som bekrefter adressen, virker både innlogget og ikke.
  if (sted.pathname === "/bekreft-epost") return <BekreftLenke />;
  if (laster) return <div className="sentrert"><Laster /></div>;
  if (!bruker) return <Innlogging />;
  if (!bruker.emailVerified) return <BekreftEpost epost={bruker.email ?? ""} loggUt={loggUt} />;
  if (!meg) return <div className="sentrert"><Laster /></div>;
  if (!meg.bruker.navn || meg.bruker.navn.trim().length < 2) return <OppgiNavn />;
  // Nye kontoer venter på godkjenning fra Admin Konsoll (en invitasjon godkjenner kontoen).
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
