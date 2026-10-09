// Lønnshistorikken til en ansatt (0080_lonnsendringer.sql): lønnen og stillingsprosenten med
// datoen hver endring gjelder fra, også fram i tid. Eier og administrator legger inn en endring
// fra en dato (tilbake i tid gir etterbetaling eller trekk i neste lønnskjøring for måneder som
// er godkjent) og fjerner en endring; den første lønnen (fra ansettelsen) kan ikke fjernes.
import { useState } from "react";
import { api, hent } from "../api";
import { Feil, Laster, tall, useData, useHandling } from "../felles";
import { useKonto } from "../konto";
import { dato, iDag } from "../format";

export type Lonnsendring = {
  id: string;
  gjelder_fra: string;
  lonnstype: "maaned" | "time" | null;
  maanedslonn: number | null;
  timelonn: number | null;
  stillingsprosent: number | null;
  grunn: string | null;
  opprettet: string;
  opprettet_av: string | null;
  forste: boolean;
};
// Feltene på den ansatte som historikken endrer (det som gjelder i dag).
export type GjeldendeLonn = { lonnstype: "maaned" | "time"; maanedslonn: number | null; timelonn: number | null; stillingsprosent: number };

const belop = new Intl.NumberFormat("nb-NO", { maximumFractionDigits: 2 });

// «Fastlønn, 45 000 kr i måneden, 100 % stilling» (bare feltene som er med i endringen).
export function endringTekst(e: Pick<Lonnsendring, "lonnstype" | "maanedslonn" | "timelonn" | "stillingsprosent">) {
  const deler: string[] = [];
  if (e.lonnstype) deler.push(e.lonnstype === "maaned" ? "fastlønn" : "timelønn");
  if (e.maanedslonn != null && e.lonnstype !== "time") deler.push(`${belop.format(e.maanedslonn)} kr i måneden`);
  if (e.timelonn != null && e.lonnstype !== "maaned") deler.push(`${belop.format(e.timelonn)} kr i timen`);
  if (e.stillingsprosent != null) deler.push(`${belop.format(e.stillingsprosent)} % stilling`);
  const t = deler.join(", ");
  return t.charAt(0).toUpperCase() + t.slice(1);
}

type Utkast = { gjelder_fra: string; lonnstype: "" | "maaned" | "time"; maanedslonn: string; timelonn: string; stillingsprosent: string; grunn: string };

export function Lonnsendringer({
  ansattId,
  ansattFra,
  kanEndre,
  endret,
}: {
  ansattId: string;
  ansattFra: string;
  kanEndre: boolean;
  endret: (a: GjeldendeLonn) => void;
}) {
  const { org } = useKonto();
  const liste = useData(() => hent<Lonnsendring[]>(`/org/${org!.id}/ansatte/${ansattId}/lonnsendringer`), [org?.id, ansattId]);
  const [skjema, settSkjema] = useState<Utkast | null>(null);
  const h = useHandling();
  const sett = (e: Partial<Utkast>) => settSkjema((s) => (s ? { ...s, ...e } : s));
  const idag = iDag();

  async function lagre() {
    if (!skjema) return;
    const tallEllerNull = (s: string) => (s.trim() ? tall(s) : null);
    const kropp = {
      gjelder_fra: skjema.gjelder_fra,
      lonnstype: skjema.lonnstype || null,
      maanedslonn: skjema.lonnstype !== "time" ? tallEllerNull(skjema.maanedslonn) : null,
      timelonn: skjema.lonnstype !== "maaned" ? tallEllerNull(skjema.timelonn) : null,
      stillingsprosent: tallEllerNull(skjema.stillingsprosent),
      grunn: skjema.grunn.trim() || null,
    };
    if ([kropp.maanedslonn, kropp.timelonn, kropp.stillingsprosent].some((x) => x != null && !Number.isFinite(x))) return h.settFeil("Skriv beløpene og prosenten med siffer");
    const r = await h.kjor(() => api<{ endringer: Lonnsendring[]; ansatt: GjeldendeLonn }>("POST", `/org/${org!.id}/ansatte/${ansattId}/lonnsendringer`, kropp));
    if (!r) return;
    settSkjema(null);
    void liste.last();
    endret(r.ansatt);
  }

  async function fjern(e: Lonnsendring) {
    if (!confirm(`Fjerne endringen fra ${dato(e.gjelder_fra)}? Er lønnen for de månedene alt godkjent, gir neste lønnskjøring trekk eller etterbetaling.`)) return;
    const r = await h.kjor(() => api<{ endringer: Lonnsendring[]; ansatt: GjeldendeLonn }>("DELETE", `/org/${org!.id}/ansatte/${ansattId}/lonnsendringer/${e.id}`));
    if (!r) return;
    void liste.last();
    endret(r.ansatt);
  }

  return (
    <details className="tidligere-lonn lonnsendringer" open={!!skjema || (liste.data?.length ?? 0) > 1}>
      <summary>Lønnshistorikk</summary>
      <p className="felt-hjelp">
        Lønnen og stillingsprosenten fra datoen hver endring gjelder fra. Gjelder en endring tilbake i tid, etterbetaler (eller trekker) neste lønnskjøring for månedene som er
        godkjent; en endring fram i tid tas i bruk den dagen.
      </p>
      {liste.feil ? (
        <Feil melding={liste.feil} />
      ) : !liste.data ? (
        <Laster />
      ) : (
        <ul className="lonnsendring-liste">
          {liste.data.map((e) => (
            <li key={e.id}>
              <span className="lonnsendring-dato">{dato(e.gjelder_fra)}</span>
              <span>
                {endringTekst(e)}
                {e.gjelder_fra > idag && <span className="merke merke-advarsel">Fram i tid</span>}
                <span className="liten dempet lonnsendring-grunn">
                  {[e.forste ? e.grunn || "Ansatt" : e.grunn, e.opprettet_av ? `registrert av ${e.opprettet_av} ${dato(e.opprettet)}` : `registrert ${dato(e.opprettet)}`]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </span>
              {kanEndre && !e.forste && (
                <button type="button" className="lenke" disabled={h.opptatt} onClick={() => fjern(e)}>
                  Fjern
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {skjema ? (
        <div className="tidligere-skjema">
          <div className="rad">
            <label>
              Gjelder fra
              <input type="date" required min={ansattFra} value={skjema.gjelder_fra} onChange={(e) => sett({ gjelder_fra: e.target.value })} />
            </label>
            <label>
              Lønnstype
              <select value={skjema.lonnstype} onChange={(e) => sett({ lonnstype: e.target.value as Utkast["lonnstype"] })}>
                <option value="">Uendret</option>
                <option value="maaned">Fast månedslønn</option>
                <option value="time">Timelønn</option>
              </select>
            </label>
          </div>
          <div className="rad">
            {skjema.lonnstype !== "time" && (
              <label>
                Månedslønn (kr)
                <input inputMode="decimal" placeholder="Uendret" value={skjema.maanedslonn} onChange={(e) => sett({ maanedslonn: e.target.value })} />
              </label>
            )}
            {skjema.lonnstype !== "maaned" && (
              <label>
                Timelønn (kr)
                <input inputMode="decimal" placeholder="Uendret" value={skjema.timelonn} onChange={(e) => sett({ timelonn: e.target.value })} />
              </label>
            )}
            <label>
              Stillingsprosent
              <input inputMode="decimal" placeholder="Uendret" value={skjema.stillingsprosent} onChange={(e) => sett({ stillingsprosent: e.target.value })} />
            </label>
          </div>
          <label>
            Grunn
            <input maxLength={300} placeholder="F.eks. lønnsoppgjør eller ny stilling" value={skjema.grunn} onChange={(e) => sett({ grunn: e.target.value })} />
          </label>
          <span className="felt-hjelp">Fyll bare ut det som endres. Lønnen og stillingen på den ansatte følger historikken.</span>
          <div className="knapper">
            <button type="button" className="primar" disabled={h.opptatt || !skjema.gjelder_fra} onClick={lagre}>
              Lagre endringen
            </button>
            <button type="button" onClick={() => settSkjema(null)}>
              Avbryt
            </button>
          </div>
        </div>
      ) : (
        kanEndre && (
          <button
            type="button"
            className="lenke"
            onClick={() => settSkjema({ gjelder_fra: idag < ansattFra ? ansattFra : idag, lonnstype: "", maanedslonn: "", timelonn: "", stillingsprosent: "", grunn: "" })}
          >
            + Ny lønnsendring
          </button>
        )
      )}
      <Feil melding={h.feil} />
    </details>
  );
}
