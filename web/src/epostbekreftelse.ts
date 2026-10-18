// Lenken som bekrefter e-postadressen (server/src/epostbekreftelse.ts). Serveren lager den og
// sender den fra Admin Konsoll; får den det ikke til, sender Identity Platform (Firebase) den i
// stedet. Hvordan det gikk med den siste sendingen i denne fanen, vises på skjermen som venter på
// bekreftelsen, også når registreringen sendte den og skjermen kom opp i mellomtiden.
import { useSyncExternalStore } from "react";
import { sendEmailVerification, updateProfile, type User } from "firebase/auth";
import { api, ApiFeil } from "./api";
import { hentAuth } from "./firebase";
import { appAdresse } from "./appsti";

export type Sending = { status: "sender" } | { status: "sendt"; til: string } | { status: "bekreftet" } | { status: "feil"; melding: string };

let sending: Sending | null = null;
const lyttere = new Set<() => void>();
function sett(s: Sending) {
  sending = s;
  for (const l of lyttere) l();
}
const abonner = (l: () => void) => {
  lyttere.add(l);
  return () => {
    lyttere.delete(l);
  };
};
export const useSending = () => useSyncExternalStore(abonner, () => sending);

const firebaseFeil: Record<string, string> = {
  "auth/too-many-requests": "For mange forsøk. Vent litt og prøv igjen.",
  "auth/network-request-failed": "Fikk ikke kontakt. Sjekk nettet og prøv igjen.",
};

// En ny lenke til den innloggede. «bekreftet»: adressen var alt bekreftet.
export async function sendBekreftelse(): Promise<Sending> {
  sett({ status: "sender" });
  const a = await hentAuth();
  const til = a.currentUser?.email ?? "";
  let svar: Sending;
  try {
    const r = await api<{ bekreftet: boolean; til?: string }>("POST", "/meg/bekreftelse");
    svar = r.bekreftet ? { status: "bekreftet" } : { status: "sendt", til: r.til ?? til };
  } catch (e) {
    if (e instanceof ApiFeil && e.status === 409) svar = { status: "bekreftet" };
    else if (e instanceof ApiFeil && e.status === 429) svar = { status: "feil", melding: e.message };
    else {
      console.warn("Serveren sendte ikke lenken; Identity Platform sender den", e);
      try {
        if (!a.currentUser) throw e;
        await sendEmailVerification(a.currentUser, { url: appAdresse() });
        svar = { status: "sendt", til };
      } catch (f) {
        svar = { status: "feil", melding: firebaseFeil[(f as { code?: string }).code ?? ""] ?? "Vi fikk ikke sendt lenken. Prøv igjen om litt." };
      }
    }
  }
  sett(svar);
  return svar;
}

// Resten av registreringen når kontoen er laget: navnet og modulene lagres (forespørselen om
// godkjenning går når e-postadressen er bekreftet), og så sendes lenken. Det fortsetter selv om
// skjermen byttes til den som venter på bekreftelsen.
export function fullforRegistrering(bruker: User, navn: string, moduler: string[]) {
  sett({ status: "sender" });
  void (async () => {
    await updateProfile(bruker, { displayName: navn }).catch((e) => console.warn("Kunne ikke lagre navnet i Identity Platform", e));
    await api("PATCH", "/meg", { navn, ...(moduler.length ? { moduler } : {}) }).catch((e) => console.warn("Kunne ikke lagre navnet og modulene", e));
    await sendBekreftelse();
  })();
}
