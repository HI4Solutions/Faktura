import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { onIdTokenChanged, signOut, type User } from "firebase/auth";
import { hentAuth } from "./firebase";
import { hent } from "./api";
import { slaAvVarsler, synkAbonnement } from "./pwa";
import { huskInnlogget } from "./applaas";
import { APP_STI } from "./appsti";

export interface MinOrg {
  id: string;
  type: "foretak" | "regnskapsbyraa" | "privatperson";
  navn: string;
  orgnr: string | null;
  verifisering: string;
  rolle: string;
  direkte_medlem: boolean;
  // Ansatte og timer er slått på (Innstillinger → Personal).
  personal: boolean;
  // Den innloggedes egen ansattrad her (fører egne timer), eller null.
  ansatt_id: string | null;
  // Funksjonene organisasjonen har tilgang til (funksjonene i Administrasjon).
  funksjoner?: Funksjon[];
  // Ser vaktplanen, tavla og bemanningskalenderen (eier, administrator og regnskap, og de aktive
  // ansatte; 0063_ansatte_ser_planen.sql).
  ser_planen?: boolean;
  // Åpent i helgene (0064_helg.sql); stengt: personalmodulen viser bare mandag–fredag.
  helg?: boolean;
  // Timebanken er slått på (0073_timebank.sql): overtid og ekstratimer kan avspaseres senere.
  timebank?: boolean;
  // Vaktbytte (0060_vaktbytte.sql): av, med godkjenning eller fritt (0108_meny_vaktbytte.sql).
  vaktbytte?: "av" | "godkjenning" | "fritt";
  // Modulene organisasjonen har (0110_moduler.sql), som plattformadministratoren gir.
  moduler?: ModulKode[];
  // Med en egen rolle (rollen «tilpasset», 0111_tilgangsroller.sql): navnet på rollen og modulene
  // den gir (de som er slått på).
  tilgangsrolle?: string | null;
  rollemoduler?: ModulKode[] | null;
  // Organisasjonen har godtatt versjonene av bruksvilkårene og databehandleravtalen som gjelder
  // (0122_avtaler.sql). Uten feltet (eldre API) regnes de som godtatt.
  avtaler_godtatt?: boolean;
}

// Modulene: Faktura, Personal, Lønn og Regnskap.
export type ModulKode = "faktura" | "personal" | "lonn" | "regnskap";
export const MODULNAVN: Record<ModulKode, string> = { faktura: "Faktura", personal: "Personal", lonn: "Lønn", regnskap: "Regnskap" };
// Om organisasjonen har modulen. Uten lista (eldre API) er alt på.
export const harModul = (org: Pick<MinOrg, "moduler"> | null | undefined, kode: ModulKode) => !!org && (!org.moduler || org.moduler.includes(kode));

export type Funksjon = "faktura" | "ehf" | "bank" | "ai" | "gjentakende" | "flere" | "paaminnelser" | "rapporter" | "import" | "google_disk" | "ansatte" | "vaktplan" | "lonn" | "regnskap" | "sjekklister";
// Om organisasjonen har funksjonen. Uten lista (eldre API) er alt på.
export const harFunksjon = (org: Pick<MinOrg, "funksjoner"> | null | undefined, kode: Funksjon) => !!org && (!org.funksjoner || org.funksjoner.includes(kode));

interface Meg {
  // status: kontoen er godkjent av Admin Konsoll, venter på godkjenning eller er avvist.
  // moduler: modulene brukeren har bedt om (eller fått godkjent), f.eks. ["faktura", "personal"].
  // registrert_som: person eller organisasjon fra «Opprett konto», med organisasjonsnummeret og
  // navnet i Enhetsregisteret (0126_registrering.sql); null for eldre kontoer og de inviterte.
  bruker: {
    id: string;
    epost: string;
    navn: string | null;
    status?: "venter" | "godkjent" | "avvist";
    avvist_grunn?: string | null;
    moduler?: string[];
    registrert_som?: "person" | "organisasjon" | null;
    oppgitt_orgnr?: string | null;
    oppgitt_orgnavn?: string | null;
  };
  mfa: boolean;
  plattformadmin: boolean;
  organisasjoner: MinOrg[];
}

interface KontoKontekst {
  laster: boolean;
  bruker: User | null;
  meg: Meg | null;
  org: MinOrg | null;
  velgOrg: (id: string) => void;
  oppdater: () => Promise<void>;
  loggUt: () => Promise<void>;
}

const Kontekst = createContext<KontoKontekst | null>(null);
const LAGRET_ORG = "faktura.org";

function lesLagret(): string | null {
  try {
    return localStorage.getItem(LAGRET_ORG);
  } catch {
    return null;
  }
}

export function KontoProvider({ children }: { children: ReactNode }) {
  const [laster, settLaster] = useState(true);
  const [bruker, settBruker] = useState<User | null>(null);
  const [meg, settMeg] = useState<Meg | null>(null);
  const [orgId, settOrgId] = useState<string | null>(lesLagret());

  const oppdater = useCallback(async () => {
    const a = await hentAuth();
    if (!a.currentUser || !a.currentUser.emailVerified) {
      settMeg(null);
      return;
    }
    settMeg(await hent<Meg>("/meg"));
  }, []);

  useEffect(() => {
    let avbrutt = false;
    let stopp: (() => void) | undefined;
    hentAuth().then((a) => {
      stopp = onIdTokenChanged(a, async (u) => {
        if (avbrutt) return;
        settBruker(u);
        huskInnlogget(u?.uid ?? null);
        try {
          if (u?.emailVerified) settMeg(await hent<Meg>("/meg"));
          else settMeg(null);
        } catch {
          settMeg(null);
        } finally {
          settLaster(false);
        }
      });
    });
    return () => {
      avbrutt = true;
      stopp?.();
    };
  }, []);

  const velgOrg = (id: string) => {
    settOrgId(id);
    try {
      localStorage.setItem(LAGRET_ORG, id);
    } catch {
      /* ikke kritisk */
    }
  };

  // Varsler inneholder kundenavn og beløp: en enhet man logger ut av, skal ikke få flere. Ligger appen
  // under /app på nettstedets domene (appsti.ts), kommer man tilbake til nettstedet.
  const loggUt = async () => {
    await slaAvVarsler().catch(() => {});
    await signOut(await hentAuth());
    settMeg(null);
    huskInnlogget(null); // før nettstedet åpnes, så det ikke sender tilbake til appen
    if (APP_STI) window.location.assign("/");
  };

  // Varsler på enheten først når kontoen er godkjent.
  const innlogget = meg && (meg.bruker.status ?? "godkjent") === "godkjent" ? meg.bruker.id : undefined;
  useEffect(() => {
    if (innlogget) void synkAbonnement();
  }, [innlogget]);

  const orgs = meg?.organisasjoner ?? [];
  const org = orgs.find((o) => o.id === orgId) ?? orgs.find((o) => o.direkte_medlem) ?? orgs[0] ?? null;

  return <Kontekst.Provider value={{ laster, bruker, meg, org, velgOrg, oppdater, loggUt }}>{children}</Kontekst.Provider>;
}

export function useKonto() {
  const k = useContext(Kontekst);
  if (!k) throw new Error("useKonto brukt utenfor KontoProvider");
  return k;
}

// Tilgangen i organisasjonen: de faste rollene (eier, administrator, fakturerer, regnskap, les og
// ansatt), og de egne rollene (tilpasset), som gir modulene som er krysset av, som i databasen
// (faktura.kan, 0111_tilgangsroller.sql). Administrasjonen (innstillingene, brukerne og rollene) er
// bare for eier og administrator.
type Tilgang = Pick<MinOrg, "rolle"> & Partial<Pick<MinOrg, "rollemoduler">>;
const rolleHar = (org: Tilgang | null | undefined, ...moduler: ModulKode[]) =>
  org?.rolle === "tilpasset" && moduler.some((m) => !!org.rollemoduler?.includes(m));
const fast = (org: Tilgang | null | undefined, ...roller: string[]) => roller.includes(org?.rolle ?? "");

// Fakturaene, kundene og produktene: skrive og sende (Faktura), og se (også Regnskap og les).
export const kanSkrive = (org?: Tilgang | null) => fast(org, "eier", "admin", "fakturerer") || rolleHar(org, "faktura");
export const kanSeFakturaer = (org?: Tilgang | null) => fast(org, "eier", "admin", "fakturerer", "regnskap", "les") || rolleHar(org, "faktura", "regnskap");
// Fakturadelen i menyen og på oversikten: modulen Faktura er på, brukeren ser fakturaene, og det er
// ikke et regnskapsbyrå selv (byrået ser klientenes).
export const visFakturadelen = (org: MinOrg | null | undefined) =>
  !!org && org.type !== "regnskapsbyraa" && !erAnsatt(org) && harFunksjon(org, "faktura") && kanSeFakturaer(org);
export const kanBokfore = (org?: Tilgang | null) => fast(org, "eier", "admin", "fakturerer", "regnskap") || rolleHar(org, "faktura", "regnskap");
export const erAdmin = (org?: Tilgang | null) => fast(org, "eier", "admin");
// Ansatte (rollen ansatt, og en egen rolle uten moduler) ser bare sitt eget; personal styrer de
// ansatte og godkjenner timer, og regnskap kan se dem.
export const erAnsatt = (org?: Tilgang | null) => fast(org, "ansatt") || (org?.rolle === "tilpasset" && !org.rollemoduler?.length);
export const kanPersonal = (org?: Tilgang | null) => erAdmin(org) || rolleHar(org, "personal");
export const kanSePersonal = (org?: Tilgang | null) => fast(org, "eier", "admin", "regnskap") || rolleHar(org, "personal");
// Lønnen (kjøringene, a-meldingen, skattekortene, reisene): se (eier, administrator og regnskap) og
// kjøre (eier og administrator), og med en egen rolle med Lønn begge deler.
export const kanSeLonn = (org?: Tilgang | null) => fast(org, "eier", "admin", "regnskap") || rolleHar(org, "lonn");
export const kanLonn = (org?: Tilgang | null) => erAdmin(org) || rolleHar(org, "lonn");
// Eier og administrator (og en egen rolle med Personal) har Timer og Ferie som ett punkt i menyen,
// «Timer og ferie», med Ferie som siste fane på Timer; de ansatte har dem som egne punkter.
export const timerOgFerie = (org: MinOrg | null | undefined) => !!org?.personal && harFunksjon(org, "vaktplan") && !erAnsatt(org) && kanPersonal(org);
// Regnskapet (anleggsmidlene, bilagene): eier, administrator og regnskap (og en egen rolle med
// Regnskap).
export const kanSeRegnskap = (org?: Tilgang | null) => fast(org, "eier", "admin", "regnskap") || rolleHar(org, "regnskap");
