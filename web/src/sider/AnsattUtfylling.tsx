// Den ansatte fyller ut opplysningene sine selv (server/src/ansattUtfylling.ts): skjemaet på Min
// side (navn, adresse, telefon, fødselsnummer, kontonummer og nærmeste pårørende), og boksen i
// ansattkortet der lederen ser hva som er sendt inn og godkjenner eller avviser det. Ingenting
// skrives på den ansatte før lederen godkjenner; fødselsnummeret vises aldri, bare at det er sendt.
import { useState, type FormEvent } from "react";
import { api } from "../api";
import { Feil, useHandling } from "../felles";
import { useKonto } from "../konto";
import { dato } from "../format";
import { fnrGyldig, fodselsdato, kontonrGyldig, visKontonr } from "../personnummer";

export type Utfylling = {
  felt: Record<string, string>;
  har_fnr: boolean;
  status: "levert" | "avvist";
  avvist_grunn: string | null;
  levert: string;
};

// Feltene den ansatte kan fylle ut, i rekkefølgen de vises.
export const UTFYLLING_FELT: [string, string][] = [
  ["fornavn", "Fornavn"],
  ["etternavn", "Etternavn"],
  ["telefon", "Telefon"],
  ["adresse", "Adresse"],
  ["postnr", "Postnr."],
  ["poststed", "Poststed"],
  ["fodselsdato", "Fødselsdato"],
  ["kontonr", "Kontonummer"],
  ["parorende_navn", "Nærmeste pårørende"],
  ["parorende_telefon", "Telefon til pårørende"],
];
const vis = (felt: string, v: string | null | undefined) => (!v ? "" : felt === "fodselsdato" ? dato(v) : felt === "kontonr" ? visKontonr(v) : v);
const tid = (iso: string) => {
  const d = new Date(iso);
  const kl = new Intl.DateTimeFormat("nb-NO", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d).replace(":", ".");
  return `${dato(iso.slice(0, 10))} kl. ${kl}`;
};

type Person = Record<string, unknown> & { id: string; fornavn: string; har_fnr: boolean; utfylling: Utfylling | null; utfylling_bedt: string | null };

// Boksen i ansattkortet (lederen): det den ansatte har sendt inn, mot det som står nå.
export function UtfyllingBoks<T extends Person>({ ansatt, kanEndre, oppdatert }: { ansatt: T; kanEndre: boolean; oppdatert: (a: T) => void }) {
  const { org } = useKonto();
  const h = useHandling();
  const [avvis, settAvvis] = useState<string | null>(null);
  const u = ansatt.utfylling;
  if (!u) return null;
  if (u.status === "avvist")
    return (
      <div className="melding info utfylling">
        Du ba {ansatt.fornavn} rette opplysningene: «{u.avvist_grunn}». Venter på at {ansatt.fornavn} sender dem på nytt.
      </div>
    );
  const felt = UTFYLLING_FELT.filter(([k]) => u.felt[k] !== undefined);
  const godkjenn = () =>
    h.kjor(async () => {
      oppdatert(await api<T>("POST", `/org/${org!.id}/ansatte/${ansatt.id}/utfylling/godkjenn`));
    });
  const sendAvslag = () =>
    h.kjor(async () => {
      oppdatert(await api<T>("POST", `/org/${org!.id}/ansatte/${ansatt.id}/utfylling/avvis`, { grunn: avvis ?? "" }));
      settAvvis(null);
    });
  return (
    <div className="melding venter utfylling" role="status">
      <div className="utfylling-tekst">
        <strong>
          {ansatt.fornavn} har fylt ut opplysningene sine ({tid(u.levert)}).
        </strong>{" "}
        Se over og godkjenn, så legges de inn.
        <table className="utfylling-tabell">
          <thead>
            <tr>
              <th />
              <th>Nå</th>
              <th>Nytt</th>
            </tr>
          </thead>
          <tbody>
            {felt.map(([k, navn]) => (
              <tr key={k}>
                <th scope="row">{navn}</th>
                <td>{vis(k, ansatt[k] as string | null) || <span className="dempet">–</span>}</td>
                <td>{vis(k, u.felt[k])}</td>
              </tr>
            ))}
            {u.har_fnr && (
              <tr>
                <th scope="row">Fødselsnummer</th>
                <td>{ansatt.har_fnr ? "Registrert" : <span className="dempet">–</span>}</td>
                <td>{ansatt.har_fnr ? "Nytt (vises ikke)" : "Sendt inn (vises ikke)"}</td>
              </tr>
            )}
          </tbody>
        </table>
        {avvis !== null && (
          <label>
            Hva må rettes?
            <textarea rows={2} maxLength={500} autoFocus value={avvis} placeholder="F.eks. kontonummeret stemmer ikke" onChange={(e) => settAvvis(e.target.value)} />
            <span className="felt-hjelp">{ansatt.fornavn} ser dette og kan sende på nytt.</span>
          </label>
        )}
        <Feil melding={h.feil} />
      </div>
      {kanEndre && (
        <div className="knapper">
          {avvis === null ? (
            <>
              <button type="button" className="primar" disabled={h.opptatt} onClick={godkjenn}>
                Godkjenn
              </button>
              <button type="button" disabled={h.opptatt} onClick={() => settAvvis("")}>
                Avvis …
              </button>
            </>
          ) : (
            <>
              <button type="button" className="fare" disabled={h.opptatt || !avvis.trim()} onClick={sendAvslag}>
                Send til {ansatt.fornavn}
              </button>
              <button type="button" onClick={() => settAvvis(null)}>
                Avbryt
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// Skjemaet på Min side (den ansatte). meg: den ansatte slik den står i registeret.
type Meg = Person & {
  etternavn: string;
  telefon: string | null;
  adresse: string | null;
  postnr: string | null;
  poststed: string | null;
  fodselsdato: string | null;
  kontonr: string | null;
  parorende_navn: string | null;
  parorende_telefon: string | null;
  arbeidstaker: boolean;
};

export function MineOpplysninger<T extends Meg>({ meg, oppdatert }: { meg: T; oppdatert: (m: T) => void }) {
  const { org } = useKonto();
  const u = meg.utfylling;
  // Det som er sendt inn (også et avslag, så det kan rettes), ellers det som står i registeret.
  const fra = (k: string) => u?.felt[k] ?? (meg[k] as string | null) ?? "";
  const start = () => ({
    ...Object.fromEntries(UTFYLLING_FELT.map(([k]) => [k, k === "kontonr" ? visKontonr(fra(k)) : fra(k)])),
    fnr: "",
  });
  const [skjema, settSkjema] = useState<Record<string, string>>(start);
  // Åpent når lederen har bedt om det og ingenting er sendt, eller når det er avvist.
  const [apen, settApen] = useState(() => (!!meg.utfylling_bedt && !u) || u?.status === "avvist");
  const [sendt, settSendt] = useState(false);
  const h = useHandling();
  const sett = (k: string, v: string) => settSkjema((s) => ({ ...s, [k]: v }));
  const fnr = skjema.fnr!.replace(/[\s.]/g, "");
  const fnrFeil = fnr.length >= 11 && !fnrGyldig(fnr) ? "Fødselsnummeret er ikke gyldig (sjekk sifrene)" : null;
  const kontonr = skjema.kontonr!.replace(/[\s.]/g, "");
  const kontonrFeil = kontonr.length >= 11 && !kontonrGyldig(kontonr) ? "Kontonummeret er ikke gyldig (sjekk sifrene)" : null;

  async function send(e: FormEvent) {
    e.preventDefault();
    // Bare det som er nytt eller endret (lederen ser det mot det som står nå).
    const kropp: Record<string, string> = {};
    for (const [k] of UTFYLLING_FELT) {
      const v = skjema[k]?.trim() ?? "";
      const naa = String(meg[k] ?? "");
      if (v && (k === "kontonr" ? v.replace(/[\s.]/g, "") !== naa : v !== naa)) kropp[k] = v;
    }
    if (fnr) {
      kropp.fnr = fnr;
      delete kropp.fodselsdato;
    }
    if (!Object.keys(kropp).length) return h.settFeil("Du har ikke endret noe.");
    const r = await h.kjor(() => api<T>("POST", `/org/${org!.id}/ansatte/meg/utfylling`, kropp));
    if (!r) return;
    oppdatert(r);
    settSendt(true);
    settApen(false);
    settSkjema((s) => ({ ...s, fnr: "" }));
  }

  const status = sendt ? (
    <div className="melding ok">Takk! Opplysningene er sendt til lederen din, som ser over og godkjenner dem.</div>
  ) : u?.status === "levert" ? (
    <div className="melding info">Sendt {tid(u.levert)}. Venter på at lederen godkjenner.</div>
  ) : u?.status === "avvist" ? (
    <div className="melding advarsel">
      Lederen ba deg rette opplysningene: «{u.avvist_grunn}». Rett dem og send på nytt.
    </div>
  ) : meg.utfylling_bedt ? (
    <div className="melding advarsel">Lederen ber deg fylle ut opplysningene dine: fødselsnummer, kontonummer for lønnen, adresse og nærmeste pårørende.</div>
  ) : null;

  return (
    <section className="kort mine-opplysninger">
      <h2>Mine opplysninger</h2>
      {status}
      {!apen ? (
        <button type="button" onClick={() => (settSkjema(start()), settApen(true), settSendt(false))}>
          {u ? "Endre det du har sendt" : "Fyll ut eller endre opplysningene dine"}
        </button>
      ) : (
        <form onSubmit={send}>
          <div className="rad">
            <label>
              Fornavn
              <input autoComplete="given-name" value={skjema.fornavn} onChange={(e) => sett("fornavn", e.target.value)} />
            </label>
            <label>
              Etternavn
              <input autoComplete="family-name" value={skjema.etternavn} onChange={(e) => sett("etternavn", e.target.value)} />
            </label>
          </div>
          <label>
            Telefon
            <input type="tel" autoComplete="tel" value={skjema.telefon} onChange={(e) => sett("telefon", e.target.value)} />
          </label>
          <label>
            Adresse
            <input autoComplete="street-address" value={skjema.adresse} onChange={(e) => sett("adresse", e.target.value)} />
          </label>
          <div className="rad">
            <label>
              Postnr.
              <input inputMode="numeric" maxLength={4} autoComplete="postal-code" value={skjema.postnr} onChange={(e) => sett("postnr", e.target.value)} />
            </label>
            <label>
              Poststed
              <input autoComplete="address-level2" value={skjema.poststed} onChange={(e) => sett("poststed", e.target.value)} />
            </label>
          </div>
          {meg.arbeidstaker && (
            <>
              <div className="rad">
                <label>
                  Fødselsnummer
                  <input
                    inputMode="numeric"
                    autoComplete="off"
                    spellCheck={false}
                    maxLength={13}
                    placeholder={meg.har_fnr || u?.har_fnr ? "Registrert – skriv for å endre" : "11 siffer (eller D-nummer)"}
                    aria-invalid={!!fnrFeil || undefined}
                    value={skjema.fnr}
                    onChange={(e) => sett("fnr", e.target.value)}
                  />
                  {fnrFeil ? <span className="felt-feil">{fnrFeil}</span> : <span className="felt-hjelp">Lagres kryptert og vises ikke igjen. Trengs til skattekortet og a-meldingen.</span>}
                </label>
                <label>
                  Fødselsdato
                  <input
                    type="date"
                    value={fnr && fnrGyldig(fnr) ? (fodselsdato(fnr) ?? "") : skjema.fodselsdato}
                    disabled={!!fnr && fnrGyldig(fnr)}
                    onChange={(e) => sett("fodselsdato", e.target.value)}
                  />
                </label>
              </div>
              <label>
                Kontonummer for lønnen
                <input
                  inputMode="numeric"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="1234 56 78903"
                  aria-invalid={!!kontonrFeil || undefined}
                  value={skjema.kontonr}
                  onChange={(e) => sett("kontonr", e.target.value)}
                />
                {kontonrFeil && <span className="felt-feil">{kontonrFeil}</span>}
              </label>
            </>
          )}
          <div className="rad">
            <label>
              Nærmeste pårørende
              <input placeholder="Navn" value={skjema.parorende_navn} onChange={(e) => sett("parorende_navn", e.target.value)} />
            </label>
            <label>
              Telefon til pårørende
              <input type="tel" value={skjema.parorende_telefon} onChange={(e) => sett("parorende_telefon", e.target.value)} />
            </label>
          </div>
          <Feil melding={h.feil} />
          <div className="knapper">
            <button className="primar" disabled={h.opptatt || !!fnrFeil || !!kontonrFeil}>
              Send til lederen
            </button>
            <button type="button" onClick={() => settApen(false)}>
              Avbryt
            </button>
          </div>
          <p className="felt-hjelp">Lederen din ser over opplysningene og godkjenner dem før de lagres.</p>
        </form>
      )}
    </section>
  );
}
