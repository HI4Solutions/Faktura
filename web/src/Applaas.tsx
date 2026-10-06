// Låseskjermen og logikken for når appen låses. Låsen vises i det appen starter, før
// innloggingen er lastet, og Face ID / Touch ID startes av seg selv. Går det ikke (Safari
// krever iblant et trykk), låser et trykk hvor som helst på skjermen opp.
//
// Er appen låst fra start, vises ikke innholdet og ingen data hentes før den er låst opp.
// Låses den senere, ligger innholdet skjult bak låsen, så halvferdige skjemaer ikke går tapt.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useKonto } from "./konto";
import { LogoIkon } from "./Logo";
import { erAvbrutt } from "./passkey";
import {
  biometriNavn,
  gjenopprettAutomatikk,
  hentPasskeyIder,
  lagreLaas,
  lasOppMedPasskey,
  lesLaas,
  lyttPaLaas,
  merkAktiv,
  oppdaterLegitimasjon,
  sistInnlogget,
  skalLases,
  tidSidenSynlig,
  ventPaFokus,
  type Laas,
} from "./applaas";

// Nettopp logget inn med passord eller passkey: ikke be om Face ID med en gang.
function nyligInnlogget(sist: string | undefined) {
  const t = sist ? Date.parse(sist) : NaN;
  return Number.isFinite(t) && Date.now() - t < 2 * 60_000;
}

export function AppLaas({ children }: { children: ReactNode }) {
  const { laster, bruker, meg } = useKonto();
  const [, oppfrisk] = useState(0);
  useEffect(() => lyttPaLaas(() => oppfrisk((n) => n + 1)), []);

  // Før innloggingen er lastet: den som sist var logget inn på enheten.
  const laas = lesLaas(bruker?.uid ?? (laster ? sistInnlogget() : undefined)) ?? lesLaas(meg?.bruker.id);
  const eier = laas?.bruker ?? null;
  const vurder = () => Boolean(eier) && !nyligInnlogget(bruker?.metadata?.lastSignInTime) && skalLases(eier ?? undefined);

  const [vurdert, settVurdert] = useState(eier);
  const [last, settLast] = useState(vurder);
  // Låsen ble kjent nå (appen startet, eller noen logget inn): avgjør før noe vises.
  if (eier !== vurdert) {
    settVurdert(eier);
    settLast(vurder());
  }
  const laast = last && Boolean(laas);
  const [vist, settVist] = useState(!laast);
  if (!laast && !vist) settVist(true);

  const laastRef = useRef(laast);
  laastRef.current = laast;
  const laasRef = useRef(laas);
  laasRef.current = laas;

  useEffect(() => {
    if (laasRef.current && !laast) merkAktiv();
    const synlighet = () => {
      const l = laasRef.current;
      if (!l) return;
      if (document.visibilityState === "hidden") {
        if (!laastRef.current) merkAktiv();
        // «Hver gang»: lås før appvelgeren tar bilde av skjermen.
        if (l.minutter === 0) settLast(true);
      } else if (!laastRef.current && skalLases(l.bruker)) {
        settLast(true);
      }
    };
    document.addEventListener("visibilitychange", synlighet);
    window.addEventListener("pagehide", synlighet);
    // Mens appen er i bruk: hold «sist aktiv» oppdatert (iOS kan avslutte appen uten varsel).
    const t = setInterval(() => document.visibilityState === "visible" && laasRef.current && !laastRef.current && merkAktiv(), 15_000);
    return () => {
      document.removeEventListener("visibilitychange", synlighet);
      window.removeEventListener("pagehide", synlighet);
      clearInterval(t);
    };
  }, [laast]);

  // Når appen er låst opp: husk Firebase-id-en (så låsen kan vises før innloggingen har
  // lastet neste gang) og hent kontoens passkeys, så nye og fjernede passkeys blir med.
  const megId = meg?.bruker.id;
  const uid = bruker?.uid;
  useEffect(() => {
    if (!megId || laast) return;
    const l = lesLaas(megId);
    if (!l) return;
    if (uid && l.uid !== uid) lagreLaas({ ...l, uid });
    hentPasskeyIder().then(
      (ider) => oppdaterLegitimasjon(megId, ider),
      () => {},
    );
  }, [megId, uid, laast]);

  const automatikk = useRef<(() => void) | undefined>(undefined);
  useEffect(() => () => automatikk.current?.(), []);

  const opplast = (automatisk: boolean) => {
    merkAktiv();
    settLast(false);
    automatikk.current?.();
    automatikk.current = automatisk ? gjenopprettAutomatikk() : undefined;
  };

  return (
    <>
      {vist && <div style={{ display: laast ? "none" : "contents" }}>{children}</div>}
      {laast && laas && <Laaseskjerm laas={laas} opplast={opplast} />}
    </>
  );
}

function Laaseskjerm({ laas, opplast }: { laas: Laas; opplast: (automatisk: boolean) => void }) {
  const { meg, bruker, loggUt } = useKonto();
  const [feil, settFeil] = useState<string | null>(null);
  const [trykk, settTrykk] = useState(false); // automatisk start gikk ikke: be om et trykk
  const [mislykket, settMislykket] = useState(0);
  const laasRef = useRef(laas);
  laasRef.current = laas;
  const opplastRef = useRef(opplast);
  opplastRef.current = opplast;
  const teller = useRef(0);

  // Bakgrunnen bak låseskjermen (der iOS ikke tegner siden) får samme farge som den.
  useEffect(() => {
    document.documentElement.classList.add("laast");
    return () => document.documentElement.classList.remove("laast");
  }, []);

  // Startes synkront fra trykket, så nettleseren regner forespørselen som brukerens egen.
  // Hvert trykk starter en ny forespørsel (en eldre avbrytes ikke; svaret på den ignoreres).
  const lasOpp = (automatisk: boolean) => {
    const nr = ++teller.current;
    settFeil(null);
    lasOppMedPasskey(laasRef.current).then(
      () => teller.current === nr && opplastRef.current(automatisk),
      (e: Error) => {
        if (teller.current !== nr) return;
        settTrykk(true);
        // Et automatisk forsøk kan avvises av nettleseren uten at brukeren har sett noe.
        if (automatisk) return;
        if (e.name === "NotAllowedError" || erAvbrutt(e)) {
          settMislykket((n) => n + 1);
          settFeil(`${biometriNavn()} ble avbrutt eller kom ikke opp. Trykk for å prøve igjen.`);
        } else settFeil(e.message);
      },
    );
  };

  // Start Face ID / Touch ID av seg selv når appen vises og har fokus. Kommer appen fra
  // bakgrunnen, får iOS først gjøre ferdig overgangen, ellers avvises forespørselen.
  useEffect(() => {
    const stopp = new AbortController();
    let periode = 0; // økes hver gang appen skjules: ett automatisk forsøk hver gang den vises
    let forsokt = -1;
    const skjult = () => document.visibilityState === "hidden";
    const prov = async () => {
      if (skjult()) {
        periode++;
        return;
      }
      if (forsokt === periode) return;
      const denne = (forsokt = periode);
      const forsok = teller.current;
      await ventPaFokus(stopp.signal);
      const vent = 400 - tidSidenSynlig();
      if (vent > 0) await new Promise((ok) => setTimeout(ok, vent));
      // Har brukeren trykket i mellomtiden, er Face ID allerede startet av trykket.
      if (stopp.signal.aborted || denne !== periode || skjult() || teller.current !== forsok) return;
      lasOpp(true);
    };
    const synlighet = () => void prov();
    void prov();
    document.addEventListener("visibilitychange", synlighet);
    return () => {
      stopp.abort();
      document.removeEventListener("visibilitychange", synlighet);
    };
  }, []);

  const navn = meg?.bruker.navn ?? bruker?.displayName ?? meg?.bruker.epost ?? bruker?.email;

  return (
    <div className="laas" role="dialog" aria-modal="true" aria-label="Appen er låst" onClick={() => lasOpp(false)}>
      <div className="laas-innhold">
        <LogoIkon storrelse={72} animert={false} />
        <h1>HI4 Faktura er låst</h1>
        <p className="laas-hvem">{navn || " "}</p>
        <button type="button" className="primar laas-knapp" autoFocus>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2" />
            <path d="M9 9.5v1M15 9.5v1M12 9.5v3.5h-1M9.5 16a4 4 0 0 0 5 0" />
          </svg>
          Lås opp med {biometriNavn()}
        </button>
        {trykk && !feil && mislykket < 2 && <p className="laas-trykk">Trykk hvor som helst for å låse opp.</p>}
        {feil && <p className="laas-feil">{feil}</p>}
        {mislykket >= 3 && (
          <p className="laas-hjelp">
            Fungerer det ikke? Passkeyen kan være slettet fra enheten. Logg ut og logg inn med passord; under Innstillinger kan du lage en
            ny passkey eller slå av applåsen.
          </p>
        )}
        <button
          type="button"
          className="lenke laas-ut"
          onClick={(e) => {
            e.stopPropagation();
            void loggUt();
          }}
        >
          Logg ut
        </button>
      </div>
    </div>
  );
}
