// Bekreftelsen av e-postadressen: skjermen en ny konto ser til adressen er bekreftet, og siden
// lenken i e-posten åpner (/bekreft-epost?kode=…). Lenken kommer fra Admin Konsoll
// (server/src/epostbekreftelse.ts), eller fra Identity Platform når serveren ikke fikk sendt den.
import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { applyActionCode } from "firebase/auth";
import { hentAuth } from "../firebase";
import { Feil, Laster } from "../felles";
import { sendBekreftelse, useSending } from "../epostbekreftelse";
import { EnkelBlankett } from "../blankett";

// Er adressen bekreftet (kanskje på en annen enhet)? Da hentes et nytt token, og appen lastes på
// nytt med det.
async function sjekkBekreftet(): Promise<boolean> {
  const a = await hentAuth();
  await a.currentUser?.reload().catch(() => undefined);
  if (!a.currentUser?.emailVerified) return false;
  await a.currentUser.getIdToken(true);
  window.location.reload();
  return true;
}

// Venter på at e-postadressen blir bekreftet. Lenken åpnes ofte på telefonen, så skjermen ser
// etter bekreftelsen selv: når den åpnes, hvert femte sekund de første ti minuttene, og når man
// kommer tilbake til fanen.
export function BekreftEpost({ epost, loggUt }: { epost: string; loggUt: () => void }) {
  const sending = useSending();
  const [melding, settMelding] = useState<string | null>(null);
  const [opptatt, settOpptatt] = useState(false);

  useEffect(() => {
    const start = Date.now();
    const se = () => {
      if (document.visibilityState === "visible") void sjekkBekreftet();
    };
    // Med en gang også: adressen kan være bekreftet siden sist (eller av administratoren).
    se();
    const t = window.setInterval(() => (Date.now() - start > 10 * 60_000 ? window.clearInterval(t) : se()), 5000);
    document.addEventListener("visibilitychange", se);
    window.addEventListener("focus", se);
    return () => {
      window.clearInterval(t);
      document.removeEventListener("visibilitychange", se);
      window.removeEventListener("focus", se);
    };
  }, []);

  const sjekk = useCallback(async () => {
    settMelding(null);
    if (!(await sjekkBekreftet())) settMelding("E-postadressen er ikke bekreftet ennå. Klikk på lenken i e-posten først.");
  }, []);

  async function sendNy() {
    settMelding(null);
    settOpptatt(true);
    try {
      if ((await sendBekreftelse()).status === "bekreftet") await sjekk();
    } finally {
      settOpptatt(false);
    }
  }

  return (
    <EnkelBlankett navn="Ny konto" nr="DEL 2" tittel="Bekreft e-postadressen" tekst="Lenke på e-post">
      {sending?.status === "sender" ? (
        <p role="status">
          Sender en lenke til <strong>{epost}</strong> …
        </p>
      ) : sending?.status === "sendt" ? (
        <p role="status">
          Vi har sendt en lenke til <strong>{sending.til || epost}</strong>. Klikk på den for å bekrefte adressen, så går du videre her av deg selv.
        </p>
      ) : (
        <p>
          Klikk på lenken vi sendte til <strong>{epost}</strong> for å bekrefte adressen. Finner du den ikke, kan du få en ny.
        </p>
      )}
      {sending?.status === "feil" && <Feil melding={sending.melding} />}
      {melding && <div className="melding info">{melding}</div>}
      <p className="liten dempet">
        Finner du ikke e-posten? Se i søppelpost eller uønsket e-post; den kommer fra Admin Konsoll. Er adressen feil, logger du ut og lager kontoen på nytt
        med riktig adresse.
      </p>
      <div className="knapper">
        <button className="primar" onClick={sjekk}>
          Jeg har bekreftet
        </button>
        <button onClick={sendNy} disabled={opptatt || sending?.status === "sender"}>
          Send ny lenke
        </button>
        <button className="lenke" onClick={loggUt}>
          Logg ut
        </button>
      </div>
    </EnkelBlankett>
  );
}

const feiltekst: Record<string, string> = {
  "auth/user-disabled": "Kontoen er stengt.",
  "auth/user-not-found": "Fant ikke kontoen. Den kan være slettet.",
  "auth/network-request-failed": "Fikk ikke kontakt. Sjekk nettet og prøv igjen.",
  "auth/too-many-requests": "For mange forsøk. Vent litt og prøv igjen.",
};

// Lenken i e-posten: bekrefter adressen hos Identity Platform. Er brukeren logget inn i denne
// nettleseren, hentes et nytt token og appen går videre; ellers logger brukeren inn.
export function BekreftLenke() {
  const [sok] = useSearchParams();
  const kode = sok.get("kode") ?? sok.get("oobCode") ?? "";
  const [tilstand, settTilstand] = useState<"bekrefter" | "bekreftet" | "brukt" | "feil">("bekrefter");
  const [innlogget, settInnlogget] = useState(false);
  const [feil, settFeil] = useState<string | null>(null);
  const kjort = useRef(false);

  useEffect(() => {
    if (kjort.current) return;
    kjort.current = true;
    void (async () => {
      const a = await hentAuth();
      await a.authStateReady();
      try {
        if (!kode) throw Object.assign(new Error("Lenken mangler koden."), { code: "auth/invalid-action-code" });
        await applyActionCode(a, kode);
      } catch (e) {
        // Brukt før eller utløpt: er adressen bekreftet likevel, er alt i orden.
        await a.currentUser?.reload().catch(() => undefined);
        if (!a.currentUser?.emailVerified) {
          const k = (e as { code?: string }).code ?? "";
          settInnlogget(!!a.currentUser);
          if (k === "auth/invalid-action-code" || k === "auth/expired-action-code") settTilstand("brukt");
          else {
            console.error("Kunne ikke bekrefte e-postadressen", e);
            settFeil(feiltekst[k] ?? "Vi fikk ikke bekreftet adressen. Prøv igjen om litt.");
            settTilstand("feil");
          }
          return;
        }
      }
      if (a.currentUser) {
        await a.currentUser.reload().catch(() => undefined);
        await a.currentUser.getIdToken(true).catch(() => undefined);
        settInnlogget(true);
      }
      settTilstand("bekreftet");
    })();
  }, [kode]);

  // Innlogget her: videre inn i appen av seg selv.
  useEffect(() => {
    if (tilstand !== "bekreftet" || !innlogget) return;
    const t = window.setTimeout(() => window.location.replace("/"), 1500);
    return () => window.clearTimeout(t);
  }, [tilstand, innlogget]);

  const videre = () => window.location.replace("/");
  const tittel =
    tilstand === "bekrefter" ? "Bekrefter e-postadressen" : tilstand === "bekreftet" ? "E-postadressen er bekreftet" : tilstand === "brukt" ? "Lenken virker ikke lenger" : "Noe gikk galt";
  return (
    <EnkelBlankett navn="Ny konto" nr="DEL 2" tittel={tittel} tekst="Lenke på e-post">
      {tilstand === "bekrefter" ? (
        <Laster />
      ) : tilstand === "bekreftet" ? (
        <>
          <p role="status">{innlogget ? "Takk! Du sendes videre nå." : "Takk! Logg inn for å fortsette."}</p>
          <div className="knapper">
            <button className="primar" onClick={videre}>
              {innlogget ? "Fortsett" : "Logg inn"}
            </button>
          </div>
        </>
      ) : tilstand === "brukt" ? (
        <>
          <p>
            Den er brukt før eller har gått ut.{" "}
            {innlogget ? "Be om en ny lenke på neste side." : "Logg inn, så kan du be om en ny lenke hvis adressen ikke er bekreftet."}
          </p>
          <div className="knapper">
            <button className="primar" onClick={videre}>
              {innlogget ? "Fortsett" : "Logg inn"}
            </button>
          </div>
        </>
      ) : (
        <>
          <Feil melding={feil} />
          <div className="knapper">
            <button className="primar" onClick={() => window.location.reload()}>
              Prøv igjen
            </button>
            <button onClick={videre}>Tilbake</button>
          </div>
        </>
      )}
    </EnkelBlankett>
  );
}
