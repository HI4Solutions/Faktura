// De faste trekkene i lønnen til en ansatt (0082_lonnstrekk.sql, server/src/lonnstrekk.ts):
// utleggstrekk og bidragstrekk etter pålegg, fagforeningskontingent, tilbakebetaling av forskudd
// og andre trekk, med det som er trukket. Den ordinære lønnskjøringen trekker dem etter
// forskuddstrekket (fagforeningen før), aldri mer enn nettolønnen. Eier og administrator legger
// inn, endrer og fjerner; et trekk som er brukt i en godkjent kjøring, avsluttes i stedet.
import { useState } from "react";
import { api, hent } from "../api";
import { Feil, Laster, tall, useData, useHandling } from "../felles";
import { useKonto } from "../konto";
import { dato, iDag, kr } from "../format";

type Trekktype = "utlegg_samordnet" | "utlegg_skatt" | "utlegg_annet" | "bidrag" | "fagforening" | "forskudd" | "annet";
type Trekk = {
  id: string;
  type: Trekktype;
  tekst: string | null;
  belop: number | null;
  prosent: number | null;
  totalt: number | null;
  fra: string;
  til: string | null;
  mottaker: string | null;
  kontonr: string | null;
  kid: string | null;
  melding: string | null;
  trukket: number;
};

const TYPER: Record<Trekktype, { navn: string; hjelp: string }> = {
  utlegg_samordnet: { navn: "Utleggstrekk (samordnet, Skatteetaten)", hjelp: "Pålegget fra Skatteetaten etter den nye innkrevingsloven: beløpet eller prosenten, kontonummeret og KID-en står i pålegget." },
  utlegg_skatt: { navn: "Utleggstrekk for skattekrav", hjelp: "Pålegg om trekk for skattekrav etter det gamle regelverket (kontonummer og KID i pålegget)." },
  utlegg_annet: { navn: "Utleggstrekk (namsmannen og andre)", hjelp: "Andre pålegg om utleggstrekk etter det gamle regelverket. De rapporteres ikke i a-meldingen." },
  bidrag: { navn: "Bidragstrekk", hjelp: "Pålegg om trekk for barnebidrag. Trekkes før utleggstrekk." },
  fagforening: { navn: "Fagforeningskontingent", hjelp: "Gjør grunnlaget for forskuddstrekket mindre og står som fradrag i a-meldingen. Ofte en prosent av bruttolønnen." },
  forskudd: { navn: "Tilbakebetaling av forskudd", hjelp: "Forskudd på lønn (et lån) som betales tilbake med et beløp hver måned til summen er nådd." },
  annet: { navn: "Annet trekk", hjelp: "F.eks. kantine eller personalkjøp, etter avtale med den ansatte." },
};

type Utkast = {
  id?: string;
  type: Trekktype;
  tekst: string;
  maate: "belop" | "prosent";
  verdi: string;
  totalt: string;
  fra: string;
  til: string;
  mottaker: string;
  kontonr: string;
  kid: string;
  melding: string;
};
const tilUtkast = (t: Trekk): Utkast => ({
  id: t.id,
  type: t.type,
  tekst: t.tekst ?? "",
  maate: t.prosent != null ? "prosent" : "belop",
  verdi: String(t.prosent ?? t.belop ?? "").replace(".", ","),
  totalt: t.totalt != null ? String(t.totalt).replace(".", ",") : "",
  fra: t.fra,
  til: t.til ?? "",
  mottaker: t.mottaker ?? "",
  kontonr: t.kontonr ?? "",
  kid: t.kid ?? "",
  melding: t.melding ?? "",
});

function beskrivelse(t: Trekk) {
  const mengde = t.prosent != null ? `${String(t.prosent).replace(".", ",")} % av bruttolønnen` : `${kr(Number(t.belop))} kr per måned`;
  const periode = t.til ? `${dato(t.fra)}–${dato(t.til)}` : `fra ${dato(t.fra)}`;
  return [mengde, periode, t.totalt != null ? `${kr(t.trukket)} av ${kr(t.totalt)} kr trukket` : t.trukket ? `${kr(t.trukket)} kr trukket` : null, t.mottaker ? `til ${t.mottaker}` : null]
    .filter(Boolean)
    .join(" · ");
}

export function LonnsTrekk({ ansattId, kanEndre }: { ansattId: string; kanEndre: boolean }) {
  const { org } = useKonto();
  const sti = `/org/${org!.id}/ansatte/${ansattId}/trekk`;
  const liste = useData(() => hent<Trekk[]>(sti), [sti]);
  const [skjema, settSkjema] = useState<Utkast | null>(null);
  const h = useHandling();
  const sett = (e: Partial<Utkast>) => settSkjema((s) => (s ? { ...s, ...e } : s));
  const ny = () =>
    settSkjema({ type: "fagforening", tekst: "", maate: "prosent", verdi: "", totalt: "", fra: iDag().slice(0, 8) + "01", til: "", mottaker: "", kontonr: "", kid: "", melding: "" });

  async function lagre() {
    if (!skjema) return;
    const verdi = skjema.verdi.trim() ? tall(skjema.verdi) : NaN;
    if (!Number.isFinite(verdi) || verdi <= 0) return h.settFeil(skjema.maate === "prosent" ? "Skriv prosenten av bruttolønnen" : "Skriv beløpet som trekkes hver måned");
    const totalt = skjema.totalt.trim() ? tall(skjema.totalt) : null;
    const kropp = {
      type: skjema.type,
      tekst: skjema.tekst,
      belop: skjema.maate === "belop" ? verdi : null,
      prosent: skjema.maate === "prosent" ? verdi : null,
      totalt,
      fra: skjema.fra,
      til: skjema.til || null,
      mottaker: skjema.mottaker,
      kontonr: skjema.kontonr,
      kid: skjema.kid,
      melding: skjema.kid.trim() ? null : skjema.melding,
    };
    const r = await h.kjor(() => api<Trekk[]>(skjema.id ? "PUT" : "POST", skjema.id ? `${sti}/${skjema.id}` : sti, kropp));
    if (r) {
      liste.settData(r);
      settSkjema(null);
    }
  }

  async function fjern(t: Trekk) {
    const brukt = t.trukket > 0;
    if (!confirm(brukt ? `Avslutte trekket «${TYPER[t.type].navn}»? Det som er trukket, står i lønnskjøringene.` : `Fjerne trekket «${TYPER[t.type].navn}»?`)) return;
    const r = await h.kjor(() => api<Trekk[]>("DELETE", `${sti}/${t.id}`));
    if (r) liste.settData(r);
  }

  const idag = iDag();
  return (
    <details className="tidligere-lonn lonnstrekk" open={!!skjema || (liste.data?.length ?? 0) > 0}>
      <summary>Faste trekk</summary>
      <p className="felt-hjelp">
        Trekkes i den ordinære lønnskjøringen etter forskuddstrekket (fagforeningskontingenten før), aldri mer enn nettolønnen. Trekk med kontonummer betales med
        betalingsfila første virkedag etter lønnsdagen.
      </p>
      {liste.feil ? (
        <Feil melding={liste.feil} />
      ) : !liste.data ? (
        <Laster />
      ) : (
        !!liste.data.length && (
          <ul className="lonnstrekk-liste">
            {liste.data.map((t) => (
              <li key={t.id} className={t.til && t.til < idag ? "dempet" : undefined}>
                <span>
                  {TYPER[t.type].navn}
                  {t.tekst ? ` – ${t.tekst}` : ""}
                  {t.til && t.til < idag && <span className="merke merke-noytral">Avsluttet</span>}
                  {t.totalt != null && t.trukket >= t.totalt && <span className="merke merke-ok">Ferdig trukket</span>}
                </span>
                {kanEndre && !(t.til && t.til < idag && t.trukket > 0) && (
                  <span className="lonnstrekk-knapper">
                    <button type="button" className="lenke" disabled={h.opptatt} onClick={() => settSkjema(tilUtkast(t))}>
                      Endre
                    </button>
                    <button type="button" className="lenke" disabled={h.opptatt} onClick={() => void fjern(t)}>
                      {t.trukket > 0 ? "Avslutt" : "Fjern"}
                    </button>
                  </span>
                )}
                <span className="liten dempet">{beskrivelse(t)}</span>
              </li>
            ))}
          </ul>
        )
      )}
      {skjema ? (
        <div className="tidligere-skjema">
          <label>
            Trekk
            <select value={skjema.type} onChange={(e) => sett({ type: e.target.value as Trekktype, ...(e.target.value === "fagforening" ? {} : { maate: "belop" }) })}>
              {Object.entries(TYPER).map(([v, t]) => (
                <option key={v} value={v}>
                  {t.navn}
                </option>
              ))}
            </select>
            <span className="felt-hjelp">{TYPER[skjema.type].hjelp}</span>
          </label>
          <div className="rad">
            <label>
              Beskrivelse
              <input maxLength={100} placeholder={skjema.type === "fagforening" ? "F.eks. Fellesforbundet" : "Valgfritt"} value={skjema.tekst} onChange={(e) => sett({ tekst: e.target.value })} />
            </label>
            <label>
              Trekkes som
              <select value={skjema.maate} onChange={(e) => sett({ maate: e.target.value as Utkast["maate"] })}>
                <option value="belop">Beløp per måned</option>
                <option value="prosent">Prosent av bruttolønnen</option>
              </select>
            </label>
            <label>
              {skjema.maate === "prosent" ? "Prosent" : "Beløp (kr)"}
              <input inputMode="decimal" value={skjema.verdi} onChange={(e) => sett({ verdi: e.target.value })} />
            </label>
          </div>
          <div className="rad">
            <label>
              Fra og med
              <input type="date" value={skjema.fra} onChange={(e) => sett({ fra: e.target.value })} />
            </label>
            <label>
              Til og med
              <input type="date" min={skjema.fra} value={skjema.til} onChange={(e) => sett({ til: e.target.value })} />
            </label>
            <label>
              Til summen er trukket (kr)
              <input inputMode="decimal" placeholder="Valgfritt" value={skjema.totalt} onChange={(e) => sett({ totalt: e.target.value })} />
            </label>
          </div>
          {skjema.type !== "forskudd" && (
            <>
              <div className="rad">
                <label>
                  Mottaker
                  <input
                    maxLength={140}
                    placeholder={skjema.type.startsWith("utlegg_s") ? "Skatteetaten" : "Valgfritt"}
                    value={skjema.mottaker}
                    onChange={(e) => sett({ mottaker: e.target.value })}
                  />
                </label>
                <label>
                  Kontonummer
                  <input inputMode="numeric" value={skjema.kontonr} onChange={(e) => sett({ kontonr: e.target.value })} />
                </label>
              </div>
              <div className="rad">
                <label>
                  KID
                  <input inputMode="numeric" value={skjema.kid} onChange={(e) => sett({ kid: e.target.value })} />
                </label>
                {!skjema.kid.trim() && (
                  <label>
                    Melding til mottakeren
                    <input maxLength={140} placeholder="Uten KID" value={skjema.melding} onChange={(e) => sett({ melding: e.target.value })} />
                  </label>
                )}
              </div>
              <span className="felt-hjelp">Med kontonummer betales trekket med betalingsfila; uten blir det hos arbeidsgiveren.</span>
            </>
          )}
          <div className="knapper">
            <button type="button" className="primar" disabled={h.opptatt || !skjema.fra} onClick={() => void lagre()}>
              Lagre trekket
            </button>
            <button type="button" onClick={() => settSkjema(null)}>
              Avbryt
            </button>
          </div>
        </div>
      ) : (
        kanEndre && (
          <button type="button" className="lenke" onClick={ny}>
            + Legg til trekk
          </button>
        )
      )}
      <Feil melding={h.feil} />
    </details>
  );
}
