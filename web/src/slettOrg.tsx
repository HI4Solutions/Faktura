// Sletting av organisasjoner (0046_slett_organisasjon.sql): eieren (Innstillinger →
// Organisasjon) eller plattformadministratoren (Administrasjon) sletter, alltid med en grunn, og
// bekrefter med navnet. Uten utstedte fakturaer slettes alt; ellers stenges organisasjonen, og
// fakturaene oppbevares så lenge bokføringsloven krever.
import { useState, type FormEvent } from "react";
import { api } from "./api";
import { Dialog, Feil, useHandling } from "./felles";
import { dato } from "./format";

export type Sletting = { id: string; navn: string; grunn: string; antall_fakturaer: number; oppbevares_til: string | null };

export const slettUtfall = (s: Sletting) =>
  s.oppbevares_til
    ? `${s.navn} er stengt. Ingen har tilgang lenger, og ingenting sendes. ${
        s.antall_fakturaer === 1 ? "Den utstedte fakturaen" : `De ${s.antall_fakturaer} utstedte fakturaene`
      } oppbevares til ${dato(s.oppbevares_til)}, som bokføringsloven krever.`
    : `${s.navn} er slettet.`;

export function SlettOrganisasjon({
  navn,
  sti,
  apen,
  lukk,
  ferdig,
  admin,
}: {
  navn: string;
  sti: string;
  apen: boolean;
  lukk: () => void;
  ferdig: (s: Sletting) => void;
  admin?: boolean;
}) {
  const [grunn, settGrunn] = useState("");
  const [bekreft, settBekreft] = useState("");
  const [utfall, settUtfall] = useState<Sletting | null>(null);
  const h = useHandling();
  const klar = grunn.trim().length >= 3 && bekreft.trim().toLocaleLowerCase("nb") === navn.trim().toLocaleLowerCase("nb");
  async function slett(e: FormEvent) {
    e.preventDefault();
    if (!klar) return;
    const s = await h.kjor(() => api<Sletting>("POST", sti, { grunn: grunn.trim() }));
    if (s) settUtfall(s);
  }
  return (
    <Dialog apen={apen} lukk={() => (utfall ? ferdig(utfall) : lukk())} tittel={utfall ? (utfall.oppbevares_til ? "Organisasjonen er stengt" : "Organisasjonen er slettet") : `Slett ${navn}`}>
      {utfall ? (
        <div className="slett-org">
          <p>{slettUtfall(utfall)}</p>
          <div className="knapper">
            <button type="button" className="primar" onClick={() => ferdig(utfall)}>
              OK
            </button>
          </div>
        </div>
      ) : (
        <form className="slett-org" onSubmit={slett}>
          <p>Uten utstedte fakturaer slettes alt med en gang: kunder, produkter, utkast, ansatte, timer og vaktplan.</p>
          <p className="dempet">
            Har organisasjonen utstedte fakturaer, skal de oppbevares i fem år etter bokføringsloven. Da stenges organisasjonen i stedet: ingen får tilgang
            lenger, ingenting sendes, og fakturaene oppbevares til tiden er ute.{" "}
            {admin ? "Eierne får e-post med grunnen." : "Last ned det dere trenger først (Rapporter → Eksport)."}
          </p>
          <label>
            Hvorfor slettes organisasjonen?
            <textarea required minLength={3} maxLength={1000} rows={3} value={grunn} onChange={(e) => settGrunn(e.target.value)} />
          </label>
          <label>
            Skriv «{navn}» for å bekrefte
            <input autoComplete="off" spellCheck={false} value={bekreft} onChange={(e) => settBekreft(e.target.value)} />
          </label>
          <Feil melding={h.feil} />
          <div className="knapper">
            <button className="fare-fylt" disabled={!klar || h.opptatt}>
              Slett organisasjonen
            </button>
            <button type="button" onClick={lukk}>
              Avbryt
            </button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
