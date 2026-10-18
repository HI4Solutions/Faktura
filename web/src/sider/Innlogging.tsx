import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  createUserWithEmailAndPassword,
  getMultiFactorResolver,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  TotpMultiFactorGenerator,
  type MultiFactorError,
  type MultiFactorResolver,
} from "firebase/auth";
import { hentAuth } from "../firebase";
import { fullforRegistrering } from "../epostbekreftelse";
import { Feil, Laster } from "../felles";
import { Blankett, Delband, EnkelBlankett, Kvittering } from "../blankett";
import { useKonto } from "../konto";
import { api } from "../api";
import { ModulValg, modulnavn, opplisting, useModuler } from "../moduler";
import { KONTO_SLETTET, SlettKontoDialog } from "../slettKonto";
import { forberedPasskey, loggInnMedPasskey, passkeyFeil, stotterPasskey, venterAllerede } from "../passkey";
import { appAdresse } from "../appsti";

const feiltekst: Record<string, string> = {
  "auth/invalid-credential": "Feil e-post eller passord.",
  "auth/invalid-login-credentials": "Feil e-post eller passord.",
  "auth/user-disabled": "Kontoen er stengt.",
  "auth/email-already-in-use": "Det finnes allerede en konto med denne e-postadressen.",
  "auth/weak-password": "Passordet må ha minst 8 tegn.",
  "auth/password-does-not-meet-requirements": "Passordet oppfyller ikke kravene.",
  "auth/invalid-email": "Ugyldig e-postadresse.",
  "auth/too-many-requests": "For mange forsøk. Vent litt og prøv igjen.",
  "auth/invalid-verification-code": "Feil kode. Prøv igjen.",
};

const tekst = (e: unknown) => feiltekst[(e as { code?: string }).code ?? ""] ?? (e as Error).message;

export function Innlogging() {
  // «Opprett konto» på nettstedet lenker hit med ?konto=ny.
  const [modus, settModus] = useState<"inn" | "ny" | "glemt">(() =>
    new URLSearchParams(window.location.search).get("konto") === "ny" ? "ny" : "inn",
  );
  const [navn, settNavn] = useState("");
  const [epost, settEpost] = useState("");
  const [passord, settPassord] = useState("");
  const [kode, settKode] = useState("");
  const [resolver, settResolver] = useState<MultiFactorResolver | null>(null);
  const [feil, settFeil] = useState<string | null>(null);
  // Etter at kontoen er slettet (slettKonto.tsx) kommer brukeren hit, med en bekreftelse én gang.
  const [info, settInfo] = useState<string | null>(() => {
    try {
      if (sessionStorage.getItem(KONTO_SLETTET)) {
        sessionStorage.removeItem(KONTO_SLETTET);
        return "Kontoen din er slettet.";
      }
    } catch {
      /* uten lagring ingen melding */
    }
    return null;
  });
  const [opptatt, settOpptatt] = useState(false);
  // Modulene den nye brukeren trenger (Faktura, Bemanning, ...); de kommer med i forespørselen.
  const moduler = useModuler(modus === "ny");
  const [valgte, settValgte] = useState<string[]>([]);

  // Passkey: utfordringen hentes på forhånd (og fornyes før den går ut), så trykket åpner
  // passkey-vinduet med en gang. Knappen kan trykkes igjen mens appen venter (kom det ikke
  // opp noe vindu, starter et nytt trykk en ny forespørsel); feil vises bare fra det siste.
  const passkeyMulig = !resolver && modus === "inn" && stotterPasskey();
  const [venterPasskey, settVenterPasskey] = useState(false);
  const [lenge, settLenge] = useState(false); // ingenting har skjedd på en stund
  const forsok = useRef(0);
  useEffect(() => {
    if (!passkeyMulig) return;
    const forbered = () => document.visibilityState === "visible" && void forberedPasskey().catch(() => undefined);
    forbered();
    const t = setInterval(forbered, 60_000);
    document.addEventListener("visibilitychange", forbered);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", forbered);
    };
  }, [passkeyMulig]);

  async function passkey() {
    const nr = ++forsok.current;
    settFeil(null);
    settVenterPasskey(true);
    settLenge(false);
    const t = window.setTimeout(() => forsok.current === nr && settLenge(true), 6000);
    try {
      await loggInnMedPasskey();
    } catch (e) {
      console.error("Passkey-innlogging feilet", e);
      if (forsok.current === nr && !venterAllerede(e)) settFeil(passkeyFeil(e));
    } finally {
      clearTimeout(t);
      if (forsok.current === nr) {
        settVenterPasskey(false);
        settLenge(false);
      }
    }
  }

  async function send(e: FormEvent) {
    e.preventDefault();
    settFeil(null);
    settInfo(null);
    settOpptatt(true);
    const auth = await hentAuth();
    try {
      if (resolver) {
        const hint = resolver.hints.find((h) => h.factorId === TotpMultiFactorGenerator.FACTOR_ID) ?? resolver.hints[0];
        await resolver.resolveSignIn(TotpMultiFactorGenerator.assertionForSignIn(hint.uid, kode.replace(/\s/g, "")));
      } else if (modus === "inn") {
        await signInWithEmailAndPassword(auth, epost, passord);
      } else if (modus === "ny") {
        if (passord.length < 8) throw Object.assign(new Error(), { code: "auth/weak-password" });
        if (navn.trim().length < 2) throw new Error("Skriv inn fullt navn.");
        if (moduler?.length && !valgte.length) throw new Error("Velg hva du trenger (minst én modul).");
        const { user } = await createUserWithEmailAndPassword(auth, epost, passord);
        // Navnet og modulene lagres med en gang (forespørselen går når e-postadressen er
        // bekreftet; feiler det, spør venteskjermen etter modulene i stedet), og lenken som
        // bekrefter adressen sendes fra Admin Konsoll. Skjermen som kommer nå (BekreftEpost),
        // viser hvordan det gikk.
        fullforRegistrering(user, navn.trim(), valgte);
      } else {
        await sendPasswordResetEmail(auth, epost, { url: appAdresse() });
        settInfo("Hvis adressen har en konto, har vi sendt en lenke for å lage nytt passord.");
      }
    } catch (err) {
      if ((err as { code?: string }).code === "auth/multi-factor-auth-required") {
        settResolver(getMultiFactorResolver(auth, err as MultiFactorError));
      } else {
        settFeil(tekst(err));
      }
    } finally {
      settOpptatt(false);
    }
  }

  // Skjermen er en blankett som nettstedet (blankett.tsx): innledningen og opplysningene til
  // venstre, feltene til høyre. Totrinnskoden er del 2 av innloggingen.
  const bytt = (m: typeof modus) => {
    settModus(m);
    settFeil(null);
    settInfo(null);
  };
  const del = resolver ? 2 : 1;
  let felt = 0;
  const nr = () => `${del}.${++felt}`;
  const tekster = resolver
    ? { tittel: "Bekreft innloggingen", band: "Totrinnsinnlogging", stor: "Én kode til.", intro: "Skriv inn koden fra autentiseringsappen din." }
    : modus === "ny"
      ? { tittel: "Opprett konto", band: "Godkjennes før første innlogging", stor: "Kom i gang.", intro: "Fyll ut skjemaet og bekreft e-postadressen. Vi godkjenner nye kontoer før første innlogging." }
      : modus === "glemt"
        ? { tittel: "Glemt passord", band: "Lenke på e-post", stor: "Nytt passord.", intro: "Skriv inn e-postadressen din, så sender vi en lenke for å lage nytt passord." }
        : { tittel: "Logg inn", band: "Passord eller passkey", stor: "Velkommen tilbake.", intro: "Logg inn for å fortsette i Admin Konsoll." };
  const knapp = resolver ? "Bekreft" : modus === "ny" ? "Opprett konto" : modus === "glemt" ? "Send lenke" : "Logg inn";

  return (
    <Blankett
      kode="AK-2"
      navn="Innlogging"
      handling={
        resolver ? undefined : modus === "inn" ? (
          <button type="button" className="btn pri" onClick={() => bytt("ny")}>
            Opprett konto
          </button>
        ) : (
          <button type="button" className="btn pri" onClick={() => bytt("inn")}>
            Logg inn
          </button>
        )
      }
    >
      <Delband nr={`DEL ${del}`} tittel={tekster.tittel} tekst={tekster.band} />
      <div className="bl-skjema">
        <div className="bl-intro">
          <p className="stor2">{tekster.stor}</p>
          <p>{tekster.intro}</p>
        </div>
        <form className="skjema" onSubmit={send}>
          {resolver ? (
            <label className="felt hel">
              <span className="lbl">
                <span className="nr" aria-hidden="true">{nr()}</span>Kode
              </span>
              <input inputMode="numeric" autoComplete="one-time-code" autoFocus value={kode} onChange={(e) => settKode(e.target.value)} />
            </label>
          ) : (
            <>
              {modus === "ny" && (
                <label className="felt">
                  <span className="lbl">
                    <span className="nr" aria-hidden="true">{nr()}</span>Fullt navn
                  </span>
                  <input autoComplete="name" required minLength={2} value={navn} onChange={(e) => settNavn(e.target.value)} />
                </label>
              )}
              <label className={modus === "ny" ? "felt" : "felt hel"}>
                <span className="lbl">
                  <span className="nr" aria-hidden="true">{nr()}</span>E-post
                </span>
                <input type="email" autoComplete="email" required value={epost} onChange={(e) => settEpost(e.target.value)} />
              </label>
              {modus !== "glemt" && (
                <label className="felt hel">
                  <span className="lbl">
                    <span className="nr" aria-hidden="true">{nr()}</span>Passord{modus === "ny" && <span className="hint"> (minst 8 tegn)</span>}
                  </span>
                  <input
                    type="password"
                    autoComplete={modus === "ny" ? "new-password" : "current-password"}
                    required
                    minLength={modus === "ny" ? 8 : undefined}
                    value={passord}
                    onChange={(e) => settPassord(e.target.value)}
                  />
                </label>
              )}
              {modus === "ny" && !!moduler?.length && (
                <ModulValg
                  moduler={moduler}
                  valgt={valgte}
                  endre={settValgte}
                  tittel={
                    <>
                      <span className="nr" aria-hidden="true">{nr()}</span>Hva trenger du? (sett kryss)
                    </>
                  }
                />
              )}
            </>
          )}
          {feil && (
            <Kvittering stempel="Avvist" rolle="alert">
              {feil}
            </Kvittering>
          )}
          {info && (
            <Kvittering stempel={modus === "glemt" ? "Sendt" : "Slettet"} farge="gronn" rolle="status">
              {info}
            </Kvittering>
          )}
          <div className="send">
            <p className="liten">
              {resolver ? (
                "Koden står i autentiseringsappen og byttes hvert 30. sekund."
              ) : modus === "inn" ? (
                <button type="button" className="lenke" onClick={() => bytt("glemt")}>
                  Glemt passordet?
                </button>
              ) : (
                <button type="button" className="lenke" onClick={() => bytt("inn")}>
                  {modus === "ny" ? "Har du konto? Logg inn" : "Husker du det? Logg inn"}
                </button>
              )}
            </p>
            <button className="btn pri" disabled={opptatt}>
              {knapp} →
            </button>
          </div>
          {passkeyMulig && (
            <div className="bl-eller">
              <span className="lbl">Eller</span>
              <button type="button" className="btn sec" data-passkey onClick={passkey} disabled={opptatt}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <circle cx="9" cy="8" r="4" />
                  <path d="M2.5 20a6.5 6.5 0 0 1 10.6-5" />
                  <circle cx="18" cy="15" r="2.5" />
                  <path d="M18 17.5V22M18 20h2" />
                </svg>
                {venterPasskey ? "Venter på passkey …" : "Logg inn med passkey"}
              </button>
              {lenge && (
                <p className="liten" role="status">
                  Kom det ikke opp noe vindu? Trykk på knappen igjen, eller logg inn med passord.
                </p>
              )}
            </div>
          )}
        </form>
        <div className="bl-detaljer">
          <div className="bl-info">
            {modus === "ny" && !resolver ? (
              <>
                <div>
                  <span className="lbl">Steg 1</span>
                  <span className="v">Fyll ut og send skjemaet</span>
                </div>
                <div>
                  <span className="lbl">Steg 2</span>
                  <span className="v">Bekreft e-postadressen</span>
                </div>
                <div>
                  <span className="lbl">Steg 3</span>
                  <span className="v">Vi godkjenner kontoen</span>
                </div>
              </>
            ) : (
              <>
                <div>
                  <span className="lbl">Gjelder</span>
                  <span className="bl-kryss">
                    {["Faktura", "Personal", "Lønn", "Regnskap"].map((m) => (
                      <span key={m}>
                        <i className="x" aria-hidden="true" />
                        {m}
                      </span>
                    ))}
                  </span>
                </div>
                <div>
                  <span className="lbl">Sikkerhet</span>
                  <span className="v">Passkey og totrinnsinnlogging. Data lagret i EU.</span>
                </div>
              </>
            )}
            <div>
              <span className="lbl">Spørsmål</span>
              <span className="v">
                <a href="mailto:post@adminkonsoll.no">post@adminkonsoll.no</a>
              </span>
            </div>
          </div>
        </div>
      </div>
    </Blankett>
  );
}

// En ny konto som venter på godkjenning fra Admin Konsoll (eller er avvist). Har brukeren ikke valgt
// moduler ennå (f.eks. når kontoen ble laget på en annen enhet), velges de her, og først da går
// forespørselen. Modulene kan endres til kontoen er godkjent.
export function VenterPaaGodkjenning() {
  const { meg, oppdater, loggUt } = useKonto();
  const [melding, settMelding] = useState<string | null>(null);
  const [feil, settFeil] = useState<string | null>(null);
  const [opptatt, settOpptatt] = useState(false);
  const avvist = meg?.bruker.status === "avvist";
  const moduler = useModuler(!avvist);
  const mine = meg?.bruker.moduler ?? [];
  const [endrer, settEndrer] = useState(false);
  const [valgte, settValgte] = useState<string[]>(mine);
  const [slett, settSlett] = useState(false);
  const velger = !avvist && !!moduler?.length && (!mine.length || endrer);
  async function sjekk() {
    settOpptatt(true);
    settMelding(null);
    try {
      await oppdater();
      settMelding("Kontoen venter fortsatt på godkjenning.");
    } catch (e) {
      settMelding((e as Error).message);
    } finally {
      settOpptatt(false);
    }
  }
  async function lagre(e: FormEvent) {
    e.preventDefault();
    settFeil(null);
    settMelding(null);
    if (!valgte.length) return settFeil("Velg minst én modul.");
    settOpptatt(true);
    try {
      await api("PATCH", "/meg", { moduler: valgte });
      await oppdater();
      if (endrer) settMelding("Endringen er lagret.");
      settEndrer(false);
    } catch (e) {
      settFeil((e as Error).message);
    } finally {
      settOpptatt(false);
    }
  }
  const fornavn = meg?.bruker.navn?.split(" ")[0];
  // Uten valgte moduler avhenger skjermen av modulene; vent på dem.
  if (!avvist && !mine.length && moduler === null)
    return (
      <div className="sentrert">
        <Laster />
      </div>
    );
  return (
    <EnkelBlankett
      navn="Ny konto"
      nr="DEL 3"
      tittel={avvist ? "Kontoen er ikke godkjent" : velger && !mine.length ? "Hva trenger du?" : "Kontoen venter på godkjenning"}
      tekst={avvist ? undefined : "Godkjennes av Admin Konsoll"}
    >
      {avvist ? (
        <>
          <p>Kontoen din i Admin Konsoll ({meg?.bruker.epost}) ble ikke godkjent.</p>
          {meg?.bruker.avvist_grunn && <p className="dempet">Begrunnelse: {meg.bruker.avvist_grunn}</p>}
          <p className="dempet">Ta kontakt med Admin Konsoll hvis du mener dette er feil.</p>
        </>
      ) : velger ? (
        <form onSubmit={lagre}>
          {!mine.length && (
            <p>
              Takk, {fornavn}! E-postadressen er bekreftet. Kryss av for det du skal bruke Admin Konsoll til, så sendes kontoen til Admin Konsoll for godkjenning.
            </p>
          )}
          <ModulValg moduler={moduler} valgt={valgte} endre={settValgte} tittel={mine.length ? "Endre hva du trenger" : "Hva trenger du?"} />
          <Feil melding={feil} />
          <div className="knapper">
            <button className="primar" disabled={opptatt}>
              {mine.length ? "Lagre" : "Send til godkjenning"}
            </button>
            {endrer && (
              <button
                type="button"
                onClick={() => {
                  settEndrer(false);
                  settValgte(mine);
                  settFeil(null);
                }}
              >
                Avbryt
              </button>
            )}
            <button type="button" className="lenke" onClick={loggUt}>
              Logg ut
            </button>
          </div>
        </form>
      ) : (
        <>
          <p>
            Takk, {fornavn}! E-postadressen er bekreftet, og kontoen din er sendt til Admin Konsoll for godkjenning. Du får e-post til{" "}
            <strong>{meg?.bruker.epost}</strong> når den er godkjent.
          </p>
          {!!mine.length && (
            <p className="valgte-moduler">
              Du har bedt om <strong>{opplisting(modulnavn(moduler, mine))}</strong>.{" "}
              {!!moduler?.length && (
                <button
                  type="button"
                  className="lenke"
                  onClick={() => {
                    settValgte(mine);
                    settEndrer(true);
                    settMelding(null);
                  }}
                >
                  Endre
                </button>
              )}
            </p>
          )}
          <p className="dempet">Er du invitert av en organisasjon, åpner du lenken i invitasjonen, så kommer du inn med en gang.</p>
        </>
      )}
      {melding && <div className="melding info">{melding}</div>}
      {!velger && (
        <div className="knapper">
          {!avvist && (
            <button className="primar" disabled={opptatt} onClick={sjekk}>
              Sjekk på nytt
            </button>
          )}
          <button className="lenke" onClick={loggUt}>
            Logg ut
          </button>
          <button className="lenke" onClick={() => settSlett(true)}>
            Slett kontoen
          </button>
        </div>
      )}
      <SlettKontoDialog apen={slett} lukk={() => settSlett(false)} />
    </EnkelBlankett>
  );
}
