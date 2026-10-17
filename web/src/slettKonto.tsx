// Brukeren sletter sin egen konto (DELETE /api/meg, server/src/slettKonto.ts): under Innstillinger →
// Min konto, og på siden for en konto som venter på godkjenning. Brukeren skriver e-postadressen
// sin for å bekrefte, og logges ut når kontoen er slettet.
import { useState, type FormEvent } from "react";
import { api } from "./api";
import { Dialog, Feil, useHandling } from "./felles";
import { useKonto } from "./konto";

// Innloggingssiden viser at kontoen er slettet (sider/Innlogging.tsx).
export const KONTO_SLETTET = "faktura.konto-slettet";

export function SlettKontoDialog({ apen, lukk }: { apen: boolean; lukk: () => void }) {
  const { meg, loggUt } = useKonto();
  const [bekreft, settBekreft] = useState("");
  const h = useHandling();
  const epost = meg?.bruker.epost ?? "";
  const klar = !!epost && bekreft.trim().toLowerCase() === epost.toLowerCase();

  async function slett(e: FormEvent) {
    e.preventDefault();
    if (!klar) return;
    const ok = await h.kjor(async () => {
      await api("DELETE", "/meg", { bekreft: bekreft.trim() });
      return true;
    });
    if (!ok) return;
    try {
      sessionStorage.setItem(KONTO_SLETTET, "1");
    } catch {
      /* uten lagring vises bare innloggingen */
    }
    await loggUt();
  }

  return (
    <Dialog apen={apen} lukk={lukk} tittel="Slett kontoen">
      <form className="slett-org" onSubmit={slett}>
        <p>
          Kontoen din slettes: e-postadressen og navnet ditt, innloggingen, passkeys, varslene og koblingen til Google Disk. Du
          mister tilgangen til alle organisasjonene.
        </p>
        <p className="dempet">
          Det organisasjonene har registrert, hører til dem og blir liggende, for eksempel fakturaer og regnskap (som skal
          oppbevares etter bokføringsloven), og ansattkortet ditt. Der vises kontoen som «Slettet bruker». Er du eneste eier av en
          organisasjon, må du gi eierrollen til en annen eller slette organisasjonen først.
        </p>
        <label>
          Skriv e-postadressen din ({epost}) for å bekrefte
          <input type="email" autoComplete="off" spellCheck={false} value={bekreft} onChange={(e) => settBekreft(e.target.value)} />
        </label>
        <Feil melding={h.feil} />
        <div className="knapper">
          <button className="fare-fylt" disabled={!klar || h.opptatt}>
            Slett kontoen
          </button>
          <button type="button" onClick={lukk}>
            Avbryt
          </button>
        </div>
      </form>
    </Dialog>
  );
}

// Kortet under Innstillinger → Min konto → Slett kontoen.
export function SlettKonto() {
  const [apen, settApen] = useState(false);
  return (
    <div className="kort fare-sone">
      <h2>Slett kontoen</h2>
      <p className="dempet">
        Sletter kontoen din i Admin Konsoll. Det kan ikke angres. Organisasjonene beholder det de har registrert, og du kan
        lage en ny konto senere med samme e-postadresse.
      </p>
      <div className="knapper">
        <button type="button" className="fare" onClick={() => settApen(true)}>
          Slett kontoen …
        </button>
      </div>
      <SlettKontoDialog apen={apen} lukk={() => settApen(false)} />
    </div>
  );
}
