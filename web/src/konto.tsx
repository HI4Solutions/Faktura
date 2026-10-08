import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { onIdTokenChanged, signOut, type User } from "firebase/auth";
import { hentAuth } from "./firebase";
import { hent } from "./api";
import { slaAvVarsler, synkAbonnement } from "./pwa";
import { huskInnlogget } from "./applaas";

export interface MinOrg {
  id: string;
  type: "foretak" | "regnskapsbyraa" | "privatperson";
  navn: string;
  orgnr: string | null;
  verifisering: string;
  rolle: string;
  direkte_medlem: boolean;
  // Ansatte og timer er slått på (Innstillinger → Ansatte og timer).
  personal: boolean;
  // Den innloggedes egen ansattrad her (fører egne timer), eller null.
  ansatt_id: string | null;
  // Funksjonene organisasjonen har tilgang til (Administrasjon → Funksjoner).
  funksjoner?: Funksjon[];
}

export type Funksjon = "ehf" | "bank" | "ai" | "gjentakende" | "flere" | "paaminnelser" | "rapporter" | "import" | "google_disk" | "ansatte" | "vaktplan";
// Om organisasjonen har funksjonen. Uten lista (eldre API) er alt på.
export const harFunksjon = (org: Pick<MinOrg, "funksjoner"> | null | undefined, kode: Funksjon) => !!org && (!org.funksjoner || org.funksjoner.includes(kode));

interface Meg {
  // status: kontoen er godkjent av HI4 Faktura, venter på godkjenning eller er avvist.
  bruker: { id: string; epost: string; navn: string | null; status?: "venter" | "godkjent" | "avvist"; avvist_grunn?: string | null };
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

  // Varsler inneholder kundenavn og beløp: en enhet man logger ut av, skal ikke få flere.
  const loggUt = async () => {
    await slaAvVarsler().catch(() => {});
    await signOut(await hentAuth());
    settMeg(null);
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

export const kanSkrive = (rolle?: string) => ["eier", "admin", "fakturerer"].includes(rolle ?? "");
export const kanBokfore = (rolle?: string) => ["eier", "admin", "fakturerer", "regnskap"].includes(rolle ?? "");
export const erAdmin = (rolle?: string) => ["eier", "admin"].includes(rolle ?? "");
// Ansatte (rollen ansatt) ser bare sine egne timer; personal styrer ansatte og godkjenner timer,
// og regnskap kan se dem.
export const erAnsatt = (rolle?: string) => rolle === "ansatt";
export const kanPersonal = erAdmin;
export const kanSePersonal = (rolle?: string) => ["eier", "admin", "regnskap"].includes(rolle ?? "");
