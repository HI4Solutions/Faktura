// Naturalytelsene til en ansatt (0083_naturalytelser_reiser.sql, server/src/naturalytelser.ts):
// fri bil (etter listeprisen), elektronisk kommunikasjon (sjablongen), forsikring, rentefordel på
// lån (normrenten), fri bolig og andre, med fordelen denne måneden. Den ordinære lønnskjøringen tar
// dem med hver måned de gjelder: med i skattetrekket og arbeidsgiveravgiften, men de utbetales ikke.
// Eier og administrator legger inn, endrer og fjerner; en som er med i en godkjent kjøring,
// avsluttes i stedet.
import { useState } from "react";
import { api, hent } from "../api";
import { Feil, Laster, tall, useData, useHandling } from "../felles";
import { useKonto } from "../konto";
import { dato, iDag, kr } from "../format";

type Type = "bil" | "ek" | "forsikring" | "rentefordel" | "bolig" | "annet";
type Naturalytelse = {
  id: string;
  type: Type;
  tekst: string | null;
  belop: number | null;
  listepris: number | null;
  regnr: string | null;
  bilpool: boolean;
  forstegangsreg: string | null;
  yrkeskjoring: boolean;
  laan: number | null;
  rente: number | null;
  fra: string;
  til: string | null;
  maaned: number;
  beskrivelse: string;
  merknad: string | null;
  brukt: number;
};

const TYPER: Record<Type, { navn: string; hjelp: string }> = {
  bil: { navn: "Fri bil", hjelp: "Fordelen er 30 % av listeprisen som ny opp til 370 300 kr og 20 % av resten per år (2026), 75 % for biler eldre enn tre år eller med over 40 000 km yrkeskjøring." },
  ek: { navn: "Elektronisk kommunikasjon", hjelp: "Telefon og internett som arbeidsgiveren betaler: sjablongen 4 392 kr i året (366 kr per måned)." },
  forsikring: { navn: "Forsikring", hjelp: "Den skattepliktige delen av premien per måned (f.eks. gruppeliv, ulykke i fritiden, helseforsikring som ikke er skattefri)." },
  rentefordel: { navn: "Rentefordel på lån", hjelp: "Lån fra arbeidsgiveren med lavere rente enn normrenten: fordelen er lånet ganger forskjellen, per måned." },
  bolig: { navn: "Fri bolig", hjelp: "Verdien av boligen per måned (markedsleien minus det den ansatte betaler)." },
  annet: { navn: "Annen naturalytelse", hjelp: "Andre skattepliktige fordeler per måned. Gaver over grensene og personalrabatt legges til som en linje i lønnskjøringen." },
};

type Utkast = {
  id?: string;
  type: Type;
  tekst: string;
  belop: string;
  listepris: string;
  regnr: string;
  bilpool: boolean;
  forstegangsreg: string;
  yrkeskjoring: boolean;
  laan: string;
  rente: string;
  fra: string;
  til: string;
};
const s = (n: number | null) => (n != null ? String(n).replace(".", ",") : "");
const tilUtkast = (n: Naturalytelse): Utkast => ({
  id: n.id,
  type: n.type,
  tekst: n.tekst ?? "",
  belop: s(n.belop),
  listepris: s(n.listepris),
  regnr: n.regnr ?? "",
  bilpool: n.bilpool,
  forstegangsreg: n.forstegangsreg ?? "",
  yrkeskjoring: n.yrkeskjoring,
  laan: s(n.laan),
  rente: s(n.rente),
  fra: n.fra,
  til: n.til ?? "",
});
const tallEllerNull = (v: string) => (v.trim() ? tall(v) : null);

export function LonnNaturalytelser({ ansattId, kanEndre }: { ansattId: string; kanEndre: boolean }) {
  const { org } = useKonto();
  const sti = `/org/${org!.id}/ansatte/${ansattId}/naturalytelser`;
  const liste = useData(() => hent<Naturalytelse[]>(sti), [sti]);
  const [skjema, settSkjema] = useState<Utkast | null>(null);
  const h = useHandling();
  const sett = (e: Partial<Utkast>) => settSkjema((x) => (x ? { ...x, ...e } : x));
  const ny = () =>
    settSkjema({ type: "bil", tekst: "", belop: "", listepris: "", regnr: "", bilpool: false, forstegangsreg: "", yrkeskjoring: false, laan: "", rente: "", fra: iDag().slice(0, 8) + "01", til: "" });

  async function lagre() {
    if (!skjema) return;
    const kropp = {
      type: skjema.type,
      tekst: skjema.tekst,
      belop: tallEllerNull(skjema.belop),
      listepris: tallEllerNull(skjema.listepris),
      regnr: skjema.regnr,
      bilpool: skjema.bilpool,
      forstegangsreg: skjema.forstegangsreg || null,
      yrkeskjoring: skjema.yrkeskjoring,
      laan: tallEllerNull(skjema.laan),
      rente: tallEllerNull(skjema.rente),
      fra: skjema.fra,
      til: skjema.til || null,
    };
    const r = await h.kjor(() => api<Naturalytelse[]>(skjema.id ? "PUT" : "POST", skjema.id ? `${sti}/${skjema.id}` : sti, kropp));
    if (r) {
      liste.settData(r);
      settSkjema(null);
    }
  }

  async function fjern(n: Naturalytelse) {
    if (!confirm(n.brukt ? `Avslutte «${TYPER[n.type].navn}»? Den står i lønnskjøringene den er med i.` : `Fjerne «${TYPER[n.type].navn}»?`)) return;
    const r = await h.kjor(() => api<Naturalytelse[]>("DELETE", `${sti}/${n.id}`));
    if (r) liste.settData(r);
  }

  const idag = iDag();
  return (
    <details className="tidligere-lonn naturalytelser" open={!!skjema || (liste.data?.length ?? 0) > 0}>
      <summary>Naturalytelser</summary>
      <p className="felt-hjelp">Med i grunnlaget for skattetrekket og arbeidsgiveravgiften hver måned de gjelder, men utbetales ikke.</p>
      {liste.feil ? (
        <Feil melding={liste.feil} />
      ) : !liste.data ? (
        <Laster />
      ) : (
        !!liste.data.length && (
          <ul className="lonnstrekk-liste">
            {liste.data.map((n) => {
              const slutt = !!n.til && n.til < idag;
              return (
                <li key={n.id} className={slutt ? "dempet" : undefined}>
                  <span>
                    {n.beskrivelse}
                    {slutt && <span className="merke merke-noytral">Avsluttet</span>}
                  </span>
                  {kanEndre && !(slutt && n.brukt > 0) && (
                    <span className="lonnstrekk-knapper">
                      <button type="button" className="lenke" disabled={h.opptatt} onClick={() => settSkjema(tilUtkast(n))}>
                        Endre
                      </button>
                      <button type="button" className="lenke" disabled={h.opptatt} onClick={() => void fjern(n)}>
                        {n.brukt > 0 ? "Avslutt" : "Fjern"}
                      </button>
                    </span>
                  )}
                  <span className="liten dempet">
                    {[
                      !slutt && n.maaned > 0 ? `${kr(n.maaned)} kr per måned nå` : null,
                      n.til ? `${dato(n.fra)}–${dato(n.til)}` : `fra ${dato(n.fra)}`,
                      n.merknad,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </li>
              );
            })}
          </ul>
        )
      )}
      {skjema ? (
        <div className="tidligere-skjema">
          <label>
            Naturalytelse
            <select value={skjema.type} onChange={(e) => sett({ type: e.target.value as Type })}>
              {Object.entries(TYPER).map(([v, t]) => (
                <option key={v} value={v}>
                  {t.navn}
                </option>
              ))}
            </select>
            <span className="felt-hjelp">{TYPER[skjema.type].hjelp}</span>
          </label>
          {skjema.type === "bil" ? (
            <>
              <div className="rad">
                <label>
                  Listepris som ny (kr)
                  <input inputMode="decimal" value={skjema.listepris} onChange={(e) => sett({ listepris: e.target.value })} />
                </label>
                <label>
                  Registreringsnummer
                  <input maxLength={12} disabled={skjema.bilpool} value={skjema.regnr} onChange={(e) => sett({ regnr: e.target.value })} />
                </label>
                <label>
                  Registrert første gang
                  <input type="date" value={skjema.forstegangsreg} onChange={(e) => sett({ forstegangsreg: e.target.value })} />
                </label>
              </div>
              <label>
                <input type="checkbox" checked={skjema.bilpool} onChange={(e) => sett({ bilpool: e.target.checked })} />
                Bilpool (flere biler å velge mellom)
              </label>
              <label>
                <input type="checkbox" checked={skjema.yrkeskjoring} onChange={(e) => sett({ yrkeskjoring: e.target.checked })} />
                Over 40 000 km yrkeskjøring i året (elektronisk kjørebok)
              </label>
            </>
          ) : skjema.type === "rentefordel" ? (
            <div className="rad">
              <label>
                Lånet (kr)
                <input inputMode="decimal" value={skjema.laan} onChange={(e) => sett({ laan: e.target.value })} />
              </label>
              <label>
                Renten den ansatte betaler (%)
                <input inputMode="decimal" value={skjema.rente} onChange={(e) => sett({ rente: e.target.value })} />
              </label>
            </div>
          ) : (
            <label>
              {skjema.type === "ek" ? "Beløp per måned (kr, valgfritt)" : "Beløp per måned (kr)"}
              <input inputMode="decimal" placeholder={skjema.type === "ek" ? "366" : undefined} value={skjema.belop} onChange={(e) => sett({ belop: e.target.value })} />
              {skjema.type === "ek" && <span className="felt-hjelp">Tomt: sjablongen. Et lavere beløp bare om fordelen er lavere (høyst 366 kr per måned).</span>}
            </label>
          )}
          <div className="rad">
            <label>
              Beskrivelse
              <input maxLength={100} placeholder="Valgfritt" value={skjema.tekst} onChange={(e) => sett({ tekst: e.target.value })} />
            </label>
            <label>
              Fra og med
              <input type="date" value={skjema.fra} onChange={(e) => sett({ fra: e.target.value })} />
            </label>
            <label>
              Til og med
              <input type="date" min={skjema.fra} value={skjema.til} onChange={(e) => sett({ til: e.target.value })} />
            </label>
          </div>
          <div className="knapper">
            <button type="button" className="primar" disabled={h.opptatt || !skjema.fra} onClick={() => void lagre()}>
              Lagre naturalytelsen
            </button>
            <button type="button" onClick={() => settSkjema(null)}>
              Avbryt
            </button>
          </div>
        </div>
      ) : (
        kanEndre && (
          <button type="button" className="lenke" onClick={ny}>
            + Legg til naturalytelse
          </button>
        )
      )}
      <Feil melding={h.feil} />
    </details>
  );
}
