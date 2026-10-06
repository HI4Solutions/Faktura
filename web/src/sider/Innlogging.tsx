import { useState, type FormEvent } from "react";
import {
  createUserWithEmailAndPassword,
  getMultiFactorResolver,
  sendEmailVerification,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  TotpMultiFactorGenerator,
  type MultiFactorError,
  type MultiFactorResolver,
} from "firebase/auth";
import { hentAuth } from "../firebase";
import { Feil } from "../felles";

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
  const [modus, settModus] = useState<"inn" | "ny" | "glemt">("inn");
  const [epost, settEpost] = useState("");
  const [passord, settPassord] = useState("");
  const [kode, settKode] = useState("");
  const [resolver, settResolver] = useState<MultiFactorResolver | null>(null);
  const [feil, settFeil] = useState<string | null>(null);
  const [info, settInfo] = useState<string | null>(null);
  const [opptatt, settOpptatt] = useState(false);

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
        const { user } = await createUserWithEmailAndPassword(auth, epost, passord);
        await sendEmailVerification(user, { url: window.location.origin });
      } else {
        await sendPasswordResetEmail(auth, epost, { url: window.location.origin });
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

  return (
    <div className="sentrert">
      <form className="kort" onSubmit={send}>
        <h1>HI4 Faktura</h1>
        {resolver ? (
          <>
            <p>Skriv inn koden fra autentiseringsappen din.</p>
            <label>
              Kode
              <input inputMode="numeric" autoComplete="one-time-code" autoFocus value={kode} onChange={(e) => settKode(e.target.value)} />
            </label>
          </>
        ) : (
          <>
            <p className="dempet">{modus === "ny" ? "Lag en konto" : modus === "glemt" ? "Glemt passord" : "Logg inn"}</p>
            <label>
              E-post
              <input type="email" autoComplete="email" required value={epost} onChange={(e) => settEpost(e.target.value)} />
            </label>
            {modus !== "glemt" && (
              <label>
                Passord
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
          </>
        )}
        <Feil melding={feil} />
        {info && <div className="melding ok">{info}</div>}
        <div className="knapper">
          <button className="primar" disabled={opptatt}>
            {resolver ? "Bekreft" : modus === "ny" ? "Lag konto" : modus === "glemt" ? "Send lenke" : "Logg inn"}
          </button>
        </div>
        {!resolver && (
          <p className="liten" style={{ marginTop: 16 }}>
            {modus !== "inn" && (
              <button type="button" className="lenke" onClick={() => settModus("inn")}>
                Har du konto? Logg inn
              </button>
            )}
            {modus === "inn" && (
              <>
                <button type="button" className="lenke" onClick={() => settModus("ny")}>
                  Lag konto
                </button>
                {" · "}
                <button type="button" className="lenke" onClick={() => settModus("glemt")}>
                  Glemt passord
                </button>
              </>
            )}
          </p>
        )}
      </form>
    </div>
  );
}

export function BekreftEpost({ epost, loggUt }: { epost: string; loggUt: () => void }) {
  const [melding, settMelding] = useState<string | null>(null);
  async function sjekk() {
    const a = await hentAuth();
    await a.currentUser?.reload();
    if (a.currentUser?.emailVerified) {
      await a.currentUser.getIdToken(true);
      window.location.reload();
    } else settMelding("E-postadressen er ikke bekreftet ennå.");
  }
  async function sendIgjen() {
    const a = await hentAuth();
    if (a.currentUser) await sendEmailVerification(a.currentUser, { url: window.location.origin });
    settMelding("Ny lenke er sendt.");
  }
  return (
    <div className="sentrert">
      <div className="kort">
        <h1>Bekreft e-postadressen</h1>
        <p>
          Vi har sendt en lenke til <strong>{epost}</strong>. Klikk på den, og kom tilbake hit.
        </p>
        {melding && <div className="melding info">{melding}</div>}
        <div className="knapper">
          <button className="primar" onClick={sjekk}>
            Jeg har bekreftet
          </button>
          <button onClick={sendIgjen}>Send på nytt</button>
          <button className="lenke" onClick={loggUt}>
            Logg ut
          </button>
        </div>
      </div>
    </div>
  );
}
