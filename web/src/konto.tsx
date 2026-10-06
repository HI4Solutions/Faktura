import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { onIdTokenChanged, signOut, type User } from "firebase/auth";
import { hentAuth } from "./firebase";
import { hent } from "./api";
import { slaAvVarsler, synkAbonnement } from "./pwa";

export interface MinOrg {
  id: string;
  type: "foretak" | "regnskapsbyraa" | "privatperson";
  navn: string;
  orgnr: string | null;
  verifisering: string;
  rolle: string;
  direkte_medlem: boolean;
}

interface Meg {
  bruker: { id: string; epost: string; navn: string | null };
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

  const innlogget = meg?.bruker.id;
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
