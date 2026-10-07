import { useEffect, useState } from "react";
import { multiFactor, TotpMultiFactorGenerator, type TotpSecret } from "firebase/auth";
import QRCode from "qrcode";
import { hentAuth } from "../firebase";
import { Feil } from "../felles";
import { HemmeligTekst } from "../hemmelig";

// Oppsett av totrinnsbekreftelse med autentiseringsapp (TOTP).
export function Totrinn({ ferdig }: { ferdig?: () => void }) {
  const [hemmelighet, settHemmelighet] = useState<TotpSecret | null>(null);
  const [qr, settQr] = useState<string | null>(null);
  const [kode, settKode] = useState("");
  const [feil, settFeil] = useState<string | null>(null);
  const [aktiv, settAktiv] = useState<boolean | null>(null);
  const [opptatt, settOpptatt] = useState(false);

  useEffect(() => {
    hentAuth().then((a) => settAktiv(a.currentUser ? multiFactor(a.currentUser).enrolledFactors.length > 0 : false));
  }, []);

  async function start() {
    settFeil(null);
    settOpptatt(true);
    try {
      const a = await hentAuth();
      const u = a.currentUser!;
      const s = await TotpMultiFactorGenerator.generateSecret(await multiFactor(u).getSession());
      settHemmelighet(s);
      settQr(await QRCode.toDataURL(s.generateQrCodeUrl(u.email ?? "", "HI4 Faktura"), { margin: 1, width: 200 }));
    } catch (e) {
      settFeil(
        (e as { code?: string }).code === "auth/requires-recent-login"
          ? "Av sikkerhetshensyn må du logge ut og inn igjen før du slår på totrinnsbekreftelse."
          : (e as Error).message,
      );
    } finally {
      settOpptatt(false);
    }
  }

  async function bekreft() {
    if (!hemmelighet) return;
    settFeil(null);
    settOpptatt(true);
    try {
      const a = await hentAuth();
      await multiFactor(a.currentUser!).enroll(TotpMultiFactorGenerator.assertionForEnrollment(hemmelighet, kode.replace(/\s/g, "")), "Autentiseringsapp");
      settAktiv(true);
      settHemmelighet(null);
      ferdig?.();
    } catch (e) {
      settFeil((e as { code?: string }).code === "auth/invalid-verification-code" ? "Feil kode. Prøv igjen." : (e as Error).message);
    } finally {
      settOpptatt(false);
    }
  }

  if (aktiv === null) return null;
  if (aktiv)
    return (
      <div className="melding ok">
        Totrinnsbekreftelse er slått på. Neste gang du logger inn, ber vi om en kode fra appen.
      </div>
    );

  return (
    <div>
      <p>
        Utstedelse og kreditering av fakturaer og endring av kontonummer krever totrinnsbekreftelse. Bruk en
        autentiseringsapp som Google Authenticator, Microsoft Authenticator eller 1Password.
      </p>
      {!hemmelighet ? (
        <button className="primar" onClick={start} disabled={opptatt}>
          Slå på totrinnsbekreftelse
        </button>
      ) : (
        <>
          <p>Skann koden med appen, og skriv inn den sekssifrede koden den viser.</p>
          {qr && <img className="qr" src={qr} alt="QR-kode for autentiseringsappen" width={200} height={200} />}
          <p className="liten dempet">
            Kan du ikke skanne? Skriv inn nøkkelen: <HemmeligTekst verdi={hemmelighet.secretKey} />
          </p>
          <label>
            Kode fra appen
            <input inputMode="numeric" autoComplete="one-time-code" value={kode} onChange={(e) => settKode(e.target.value)} />
          </label>
          <button className="primar" onClick={bekreft} disabled={opptatt || kode.length < 6}>
            Bekreft
          </button>
        </>
      )}
      <Feil melding={feil} />
    </div>
  );
}
