// Betalingene fra en godkjent lønnskjøring (server/src/lonnBetalinger.ts): nettolønnen på
// lønnsdagen, og forskuddstrekket og trekkene (utleggstrekk, bidragstrekk, fagforeningskontingent)
// første virkedag etter. Eier og administrator legger inn KID-en for forskuddstrekket i måneden
// (fra Skatteetatens KID-generator); det som mangler for at en betaling skal være med i
// betalingsfila, står ved den.
import { useState } from "react";
import { api, hent } from "../api";
import { Feil, Laster, useData, useHandling } from "../felles";
import { dato, kr } from "../format";
import { maaned } from "../lonn";

type Trekkbetaling = { mottaker: string; kontonr: string | null; kid: string | null; tekst: string | null; belop: number; antall: number; hva: string; mangler: string | null };
type Betalinger = {
  lonn: { dato: string; antall: number; sum: number };
  trekkdato: string;
  forskuddstrekk: Trekkbetaling | null;
  forventetKid: string | null;
  trekk: Trekkbetaling[];
};

const konto = (k: string | null) => (k ? k.replace(/^(\d{4})(\d{2})(\d{5})$/, "$1.$2.$3") : "");

export function LonnBetalinger({ sti, kanEndre, versjon }: { sti: string; kanEndre: boolean; versjon: unknown }) {
  const b = useData(() => hent<Betalinger>(`${sti}/betalinger`), [sti, versjon]);
  const [kid, settKid] = useState<string | null>(null);
  const h = useHandling();
  if (b.feil) return <Feil melding={b.feil} />;
  if (!b.data) return <Laster />;
  const d = b.data;
  const f = d.forskuddstrekk;
  const lagreKid = async () => {
    const ny = await h.kjor(() => api<Betalinger>("PUT", `${sti}/forskuddstrekk-kid`, { kid: (kid ?? "").trim() || null }));
    if (ny) {
      b.settData(ny);
      settKid(null);
    }
  };
  const feilKid = f?.kid && d.forventetKid && !f.kid.startsWith(d.forventetKid);
  return (
    <section className="kort lonn-betalinger">
      <h3>Betalinger</h3>
      <ul>
        <li>
          <span className="lonn-betaling-hva">Nettolønn til {d.lonn.antall === 1 ? "1 ansatt" : `${d.lonn.antall} ansatte`}</span>
          <span className="tall">{kr(d.lonn.sum)}</span>
          <span className="liten dempet">{dato(d.lonn.dato)} (lønnsdagen)</span>
        </li>
        {f && (
          <li>
            <span className="lonn-betaling-hva">Forskuddstrekk til Skatteetaten</span>
            <span className="tall">{kr(f.belop)}</span>
            <span className="liten dempet">
              innen {dato(d.trekkdato)}
              {f.kontonr && `, konto ${konto(f.kontonr)}`}
            </span>
            <div className="lonn-betaling-kid">
              {kanEndre && kid != null ? (
                <>
                  <input
                    inputMode="numeric"
                    aria-label="KID for forskuddstrekk"
                    placeholder={d.forventetKid ? `${d.forventetKid}…` : "19 siffer"}
                    value={kid}
                    onChange={(e) => settKid(e.target.value)}
                  />
                  <button type="button" className="primar" disabled={h.opptatt} onClick={() => void lagreKid()}>
                    Lagre
                  </button>
                  <button type="button" onClick={() => settKid(null)}>
                    Avbryt
                  </button>
                </>
              ) : (
                <>
                  <span className="liten">KID: {f.kid ?? <em className="dempet">mangler</em>}</span>
                  {kanEndre && (
                    <button type="button" className="lenke" onClick={() => settKid(f.kid ?? "")}>
                      {f.kid ? "Endre" : "Legg inn KID"}
                    </button>
                  )}
                </>
              )}
            </div>
            {f.mangler && <span className="liten advarsel-tekst">{f.mangler}</span>}
            {feilKid && (
              <span className="liten advarsel-tekst">
                KID-en ser ikke ut som en KID for forskuddstrekk i {maaned(d.lonn.dato.slice(0, 7))} (den begynner med {d.forventetKid}). Sjekk den i Skatteetatens KID-generator.
              </span>
            )}
          </li>
        )}
        {d.trekk.map((t, i) => (
          <li key={i}>
            <span className="lonn-betaling-hva">
              {t.hva}
              {t.mottaker !== t.hva && ` til ${t.mottaker}`}
              {t.antall > 1 && ` (${t.antall} ansatte)`}
            </span>
            <span className="tall">{kr(t.belop)}</span>
            <span className="liten dempet">
              innen {dato(d.trekkdato)}
              {t.kontonr && `, konto ${konto(t.kontonr)}`}
              {t.kid ? `, KID ${t.kid}` : t.tekst ? `, «${t.tekst}»` : ""}
            </span>
            {t.mangler && <span className="liten advarsel-tekst">{t.mangler}</span>}
          </li>
        ))}
      </ul>
      <p className="felt-hjelp">
        Betalingene med kontonummer (og KID for forskuddstrekket) er med i betalingsfila. Forskuddstrekket og trekkene betales første virkedag etter lønnsdagen.
      </p>
      <Feil melding={h.feil} />
    </section>
  );
}
