// Bruksvilkårene og databehandleravtalen (0122_avtaler.sql, server/src/avtaler.ts): lenkene til
// dokumentene på nettstedet, avkrysningen når en organisasjon opprettes, og siden der eier eller
// administrator godtar dem for en organisasjon som ikke har godtatt versjonene som gjelder.
import { useEffect, useState, type FormEvent } from "react";
import { api, hent } from "./api";
import { Feil, useHandling } from "./felles";
import { useKonto, type MinOrg } from "./konto";

export type Avtale = { type: "vilkar" | "databehandleravtale"; navn: string; versjon: string; oppdatert: string; url: string };
export type Avtaler = Record<Avtale["type"], Avtale>;

// Versjonene og adressene, hentet én gang.
let minne: Promise<Avtaler> | null = null;
export function useAvtaler() {
  const [avtaler, settAvtaler] = useState<Avtaler | null>(null);
  const [feil, settFeil] = useState<string | null>(null);
  useEffect(() => {
    let aktiv = true;
    minne ??= hent<Avtaler>("/offentlig/avtaler");
    minne.then(
      (a) => aktiv && settAvtaler(a),
      (e: Error) => {
        minne = null;
        if (aktiv) settFeil(e.message);
      },
    );
    return () => {
      aktiv = false;
    };
  }, []);
  return { avtaler, feil };
}

// Versjonene brukeren har lest og godtar (sendes til API-et).
export const versjoner = (a: Avtaler) => ({ vilkar: a.vilkar.versjon, databehandleravtale: a.databehandleravtale.versjon });

const Lenke = ({ a, tekst }: { a: Avtale; tekst: string }) => (
  <a href={a.url} target="_blank" rel="noopener">
    {tekst}
  </a>
);

// Avkrysningen i skjemaet for en ny organisasjon.
export function AvtaleAvkrysning({ avtaler, godtatt, endre }: { avtaler: Avtaler; godtatt: boolean; endre: (v: boolean) => void }) {
  return (
    <label className="avkrysning avtale-avkrysning">
      <input type="checkbox" required checked={godtatt} onChange={(e) => endre(e.target.checked)} />
      <span>
        Jeg godtar <Lenke a={avtaler.vilkar} tekst="bruksvilkårene" /> og{" "}
        <Lenke a={avtaler.databehandleravtale} tekst="databehandleravtalen" /> på vegne av organisasjonen.
      </span>
    </label>
  );
}

// Eier eller administrator godtar versjonene som gjelder før organisasjonen tas i bruk.
export function GodtaAvtaler({ org }: { org: MinOrg }) {
  const { oppdater } = useKonto();
  const { avtaler, feil: lastefeil } = useAvtaler();
  const [godtatt, settGodtatt] = useState(false);
  const { opptatt, feil, kjor } = useHandling();

  async function godta(ev: FormEvent) {
    ev.preventDefault();
    if (!avtaler || !godtatt) return;
    const ok = await kjor(() => api("POST", `/org/${org.id}/avtaler`, versjoner(avtaler)));
    if (ok) await oppdater();
  }

  return (
    <div className="innhold frittstaende">
      <form className="kort godta-avtaler" onSubmit={godta}>
        <h1>Bruksvilkår og databehandleravtale</h1>
        <p>
          Før {org.navn} tar i bruk Admin Konsoll, må en eier eller administrator godta bruksvilkårene og
          databehandleravtalen. Databehandleravtalen gjelder personopplysningene organisasjonen legger inn, for eksempel om
          ansatte og kunder.
        </p>
        {avtaler ? (
          <>
            <ul className="avtaleliste">
              {[avtaler.vilkar, avtaler.databehandleravtale].map((a) => (
                <li key={a.type}>
                  <Lenke a={a} tekst={a.navn} />
                  <span className="dempet liten">
                    {" "}
                    · versjon {a.versjon}, {new Date(`${a.oppdatert}T12:00:00`).toLocaleDateString("nb-NO", { day: "numeric", month: "long", year: "numeric" })}
                  </span>
                </li>
              ))}
            </ul>
            <label className="avkrysning avtale-avkrysning">
              <input type="checkbox" required checked={godtatt} onChange={(e) => settGodtatt(e.target.checked)} />
              <span>Jeg har lest og godtar bruksvilkårene og databehandleravtalen på vegne av {org.navn}.</span>
            </label>
          </>
        ) : (
          !lastefeil && <p className="dempet">Henter avtalene …</p>
        )}
        <Feil melding={lastefeil ?? feil} />
        <div className="knapper">
          <button className="primar" disabled={opptatt || !avtaler || !godtatt}>
            Godta
          </button>
        </div>
      </form>
    </div>
  );
}
