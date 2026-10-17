// Krav og frister fra Skatteetaten (server/src/skatteetatenRuter.ts og skatteetatenKrav.ts, docs/
// skatteetaten-krav.md): fanen «Skatteetaten» under Regnskap. Det organisasjonen skylder (forfalt,
// ikke forfalt, stipulerte renter og saldoen), fristene for mva-meldingen og skattemeldingen, de
// åpne kravene med forfall og betalingsinformasjon (kontonummer og KID, som kan kopieres), og
// innbetalingene og utbetalingene det siste året. Hentes hver morgen; «Hent nå» ber workeren hente.
import { useState } from "react";
import { Link } from "react-router-dom";
import { api, hent } from "../api";
import { Feil, Laster, Tom, useData, useHandling, useSmal } from "../felles";
import { useKonto } from "../konto";
import { dagerMellom, dato, iDag, kr } from "../format";

type Forfall = {
  id: string | null;
  dato: string | null;
  opprinnelig: number;
  gjenstaaende: number;
  kontonummer: string | null;
  kid: string | null;
  iban: string | null;
  bic: string | null;
  bank: string | null;
};
type Krav = {
  id: string;
  type: string | null;
  beskrivelse: string;
  periode: string | null;
  gruppe: string | null;
  opprinnelig: number;
  gjenstaaende: number;
  renter: number;
  opprettet: string | null;
  forfall: Forfall[];
};
type Innbetaling = { id: string | null; dato: string | null; belop: number; uplassert: number; type: string | null; fra: string | null };
type Utbetaling = { id: string | null; dato: string | null; belop: number; melding: string | null; status: string | null; konto: string | null };
type Summer = { saldo: number; forfalt: number; ikke_forfalt: number; renter: number; uplassert: number };
type Kravoversikt = {
  summer: Summer;
  grupper: (Omit<Summer, "uplassert"> & { gruppe: string })[];
  aapne: Krav[];
  uplasserte: Innbetaling[];
  innbetalinger: Innbetaling[];
  utbetalinger: Utbetaling[];
  periode: { fra: string; til: string };
  skjermet: boolean;
};
type Frist = { tittel: string; beskrivelse: string | null; type: string | null; frist: string; kilde: string | null };
type Fristoversikt = { frister: Frist[]; kilder: { kilde: string; status: string }[] };
type Del<T> = { data: T | null; hentet: string | null; feil: string | null };
export type Skatteetatenstatus = {
  pa: boolean;
  miljo: "test" | "prod";
  koblet: boolean;
  tilgang: boolean;
  pakke: string;
  forsokt: string | null;
  krav: Del<Kravoversikt>;
  frister: Del<Fristoversikt>;
};

const tid = (iso: string) => {
  const d = new Date(iso);
  return `${dato(new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Oslo" }).format(d))} kl. ${new Intl.DateTimeFormat("nb-NO", { timeZone: "Europe/Oslo", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d).replace(":", ".")}`;
};
const belop = (n: number) => `${kr(n)} kr`;
// Kontonummeret med mellomrom (1234 56 78901).
const konto = (k: string | null) => (k && /^\d{11}$/.test(k) ? `${k.slice(0, 4)} ${k.slice(4, 6)} ${k.slice(6)}` : (k ?? ""));
const dager = (n: number) => (n === 1 ? "1 dag" : `${n} dager`);

// Hvor nær datoen er: passert, i dag, eller om noen dager (de neste to ukene).
function naar(d: string | null, idag: string, passert = "Forfalt") {
  if (!d) return null;
  const n = dagerMellom(idag, d);
  if (n < 0) return <span className="merke merke-fare">{passert}</span>;
  if (n === 0) return <span className="merke merke-advarsel">I dag</span>;
  if (n <= 14) return <span className="merke merke-advarsel">Om {dager(n)}</span>;
  return null;
}

// Kopierer kontonummeret eller KID (til betalingen i nettbanken).
function Kopier({ verdi, navn }: { verdi: string; navn: string }) {
  const [kopiert, settKopiert] = useState(false);
  return (
    <button
      type="button"
      className="lenke liten"
      aria-label={`Kopier ${navn}`}
      onClick={async () => {
        await navigator.clipboard?.writeText(verdi).catch(() => undefined);
        settKopiert(true);
        window.setTimeout(() => settKopiert(false), 1500);
      }}
    >
      {kopiert ? "Kopiert" : "Kopier"}
    </button>
  );
}

function Betaling({ f }: { f: Forfall }) {
  if (!f.kontonummer && !f.kid && !f.iban) return <span className="dempet">–</span>;
  return (
    <span className="skatt-betaling">
      {f.kontonummer && (
        <span>
          Konto {konto(f.kontonummer)} <Kopier verdi={f.kontonummer} navn="kontonummeret" />
        </span>
      )}
      {f.kid && (
        <span>
          KID {f.kid} <Kopier verdi={f.kid} navn="KID" />
        </span>
      )}
      {!f.kontonummer && f.iban && (
        <span>
          IBAN {f.iban}
          {f.bic ? ` (BIC ${f.bic})` : ""}
        </span>
      )}
    </span>
  );
}

export function Skatteetaten() {
  const { org } = useKonto();
  const sti = `/org/${org!.id}/regnskap/skatteetaten`;
  const status = useData(() => hent<Skatteetatenstatus>(sti), [sti], { oppdater: true });
  const h = useHandling();
  const [hentes, settHentes] = useState(false);
  const smal = useSmal();
  const idag = iDag();

  if (status.feil) return <Feil melding={status.feil} />;
  if (!status.data) return <Laster />;
  const s = status.data;
  const klar = s.pa && s.koblet && s.tilgang;
  const k = s.krav.data;
  const f = s.frister.data;
  const hentNa = async () => {
    settHentes(false);
    if (await h.kjor(() => api("POST", `${sti}/hent`))) {
      settHentes(true);
      window.setTimeout(() => void status.last(), 5000);
    }
  };
  const sist = [s.krav.hentet, s.frister.hentet].filter((x): x is string => !!x).sort().at(-1);
  // Hvert forfall som ikke er betalt, de første først.
  const forfall = (k?.aapne ?? [])
    .flatMap((x) => {
      const apne = x.forfall.filter((y) => y.gjenstaaende !== 0);
      return apne.length ? apne.map((y) => ({ krav: x, f: y as Forfall | null })) : [{ krav: x, f: null as Forfall | null }];
    })
    .sort((a, b) => (a.f?.dato ?? "9999").localeCompare(b.f?.dato ?? "9999"));
  const neste = forfall.find((x) => x.f?.dato && x.f.dato >= idag)?.f?.dato ?? null;
  // Innbetalingene til Skatteetaten og utbetalingene fra Skatteetaten til dere (beløpene uten fortegn).
  const betalinger = [
    ...(k?.innbetalinger ?? []).map((x) => ({
      dato: x.dato,
      hva: "Betalt til Skatteetaten",
      tekst: [x.type, x.uplassert ? `${belop(x.uplassert)} ikke plassert` : null].filter(Boolean).join(", "),
      belop: x.belop,
    })),
    ...(k?.utbetalinger ?? []).map((x) => ({ dato: x.dato, hva: "Utbetalt til dere", tekst: x.melding ?? x.status ?? "", belop: x.belop })),
  ].sort((a, b) => (b.dato ?? "").localeCompare(a.dato ?? ""));
  const kilderUtenSvar = (f?.kilder ?? []).filter((x) => x.status.toUpperCase() !== "OK");

  return (
    <>
      <p className="undertittel">
        Det dere skylder Skatteetaten (skatt og avgifter) med forfall, kontonummer og KID, fristene for mva-meldingen og skattemeldingen, og innbetalingene og
        utbetalingene det siste året. Hentet fra Skatteetaten med tilgangen dere har gitt i Altinn. Rapportene står under{" "}
        <Link to="/rapporter?fane=regnskap">Rapporter → Regnskap</Link>.
        {s.pa && s.miljo === "test" && <span className="merke merke-noytral lonn-merke">Testmiljø</span>}
      </p>

      <section className="kort">
        <h3 style={{ marginTop: 0 }}>Koblingen til Skatteetaten</h3>
        {!s.pa ? (
          <p className="liten">
            Krav og frister fra Skatteetaten er ikke slått på ennå. Til da står kravene, betalingene og fristene på{" "}
            <a href="https://www.skatteetaten.no/" target="_blank" rel="noreferrer">
              skatteetaten.no
            </a>
            .
          </p>
        ) : !s.koblet ? (
          <p className="liten">
            Koble til Skatteetaten først under <Link to="/lonn?fane=skattekort">Lønn → Skattekort</Link>, og la daglig leder
            godkjenne i Altinn.
          </p>
        ) : !s.tilgang ? (
          <p className="liten">
            Gi Admin Konsoll tilgang til kravene og fristene i Altinn: tilgangspakken «{s.pakke}». Trykk «Utvid tilgangen i Altinn» under{" "}
            <Link to="/lonn?fane=skattekort">Lønn → Skattekort</Link>, og la daglig leder godkjenne i Altinn.
          </p>
        ) : (
          <p className="liten">
            {/* Tidspunktet er siste vellykkede henting. Avviser Skatteetaten tilgangen, står forklaringen i feilen under. */}
            Krav og frister hentes fra Skatteetaten hver morgen{sist ? `, sist ${tid(sist)}` : ""}.
            {sist && !s.krav.feil && !s.frister.feil && " Siste henting gikk uten feil."}
          </p>
        )}
        {s.krav.feil && <div className="melding feil">Kravene ble ikke hentet: {s.krav.feil}</div>}
        {s.frister.feil && <div className="melding feil">Fristene ble ikke hentet: {s.frister.feil}</div>}
        <Feil melding={h.feil} />
        {hentes && (
          <div className="melding ok" role="status">
            Hentes fra Skatteetaten nå.
          </div>
        )}
        {klar && (
          <div className="knapper">
            <button type="button" disabled={h.opptatt} onClick={() => void hentNa()}>
              Hent nå
            </button>
          </div>
        )}
      </section>

      {k && (
        <div className="nokkeltall lonn-tall">
          <div className="kort">
            <div className="etikett">Forfalt</div>
            <div className="verdi">{belop(k.summer.forfalt)}</div>
            <div className="under">{k.summer.renter ? `Pluss stipulerte renter ${belop(k.summer.renter)}` : k.summer.forfalt ? "Betal så snart som mulig" : "Ingenting er forfalt"}</div>
          </div>
          <div className="kort">
            <div className="etikett">Forfaller senere</div>
            <div className="verdi">{belop(k.summer.ikke_forfalt)}</div>
            <div className="under">{neste ? `Neste forfall ${dato(neste)}` : "Ingen forfall framover"}</div>
          </div>
          <div className="kort">
            <div className="etikett">Saldo hos Skatteetaten</div>
            <div className="verdi">{belop(k.summer.saldo)}</div>
            <div className="under">{k.summer.uplassert ? `Innbetalt, ikke plassert: ${belop(k.summer.uplassert)}` : k.summer.saldo < 0 ? "Til gode" : "Det dere skylder"}</div>
          </div>
        </div>
      )}

      <h3 className="lonn-under">Frister</h3>
      {!f ? (
        <div className="kort">
          <Tom tittel={s.frister.feil ? "Fristene er ikke hentet" : "Ikke hentet ennå"}>
            <p>Fristene for mva-meldingen og skattemeldingen hentes fra Skatteetaten når tilgangen er gitt.</p>
          </Tom>
        </div>
      ) : !f.frister.length ? (
        <div className="kort">
          <Tom tittel="Ingen frister">
            <p>Skatteetaten har ingen frister for dere det neste året.</p>
          </Tom>
        </div>
      ) : (
        <div className="kort liste">
          {f.frister.map((x, i) => (
            <div key={`${x.frist}-${i}`} className="liste-rad skatt-rad">
              <span className="linje">
                <span className="tittel">{x.tittel}</span>
                <span className="skatt-naar">
                  {naar(x.frist, idag, "Passert")} <span className="dempet">{dato(x.frist)}</span>
                </span>
              </span>
              {x.beskrivelse && x.beskrivelse !== x.tittel && (
                <span className="linje">
                  <span className="under">{x.beskrivelse}</span>
                </span>
              )}
            </div>
          ))}
        </div>
      )}
      {kilderUtenSvar.length > 0 && (
        <p className="dempet liten">Skatteetaten fikk ikke svar fra {kilderUtenSvar.map((x) => x.kilde).join(", ")}; fristene derfra kan mangle.</p>
      )}

      <h3 className="lonn-under">Åpne krav</h3>
      {!k ? (
        <div className="kort">
          <Tom tittel={s.krav.feil ? "Kravene er ikke hentet" : "Ikke hentet ennå"}>
            <p>Kravene (skatt og avgifter) med forfall og betalingsinformasjon hentes fra Skatteetaten når tilgangen er gitt.</p>
          </Tom>
        </div>
      ) : !forfall.length ? (
        <div className="kort">
          <Tom tittel="Ingen åpne krav">
            <p>Dere skylder ikke Skatteetaten noe nå.</p>
          </Tom>
        </div>
      ) : smal ? (
        <div className="kort liste">
          {forfall.map(({ krav: x, f: y }, i) => (
            <div key={`${x.id}-${y?.id ?? i}`} className="liste-rad skatt-rad">
              <span className="linje">
                <span className="tittel">{x.beskrivelse}</span>
                <span className="belop">{belop(y?.gjenstaaende ?? x.gjenstaaende)}</span>
              </span>
              <span className="linje">
                <span className="under">
                  {[x.periode, y?.dato ? `forfall ${dato(y.dato)}` : null].filter(Boolean).join(" · ")}
                  {x.renter ? ` · renter ${belop(x.renter)}` : ""}
                </span>
                {naar(y?.dato ?? null, idag)}
              </span>
              {y && (
                <span className="linje">
                  <Betaling f={y} />
                </span>
              )}
            </div>
          ))}
        </div>
      ) : (
        <div className="kort tabell">
          <table>
            <thead>
              <tr>
                <th>Forfall</th>
                <th>Krav</th>
                <th className="tall">Å betale</th>
                <th className="tall">Renter</th>
                <th>Betaling</th>
              </tr>
            </thead>
            <tbody>
              {forfall.map(({ krav: x, f: y }, i) => (
                <tr key={`${x.id}-${y?.id ?? i}`}>
                  <td>
                    {y?.dato ? dato(y.dato) : "–"} {naar(y?.dato ?? null, idag)}
                  </td>
                  <td>
                    {x.beskrivelse}
                    {x.periode && <div className="dempet liten">{x.periode}</div>}
                  </td>
                  <td className="tall">{kr(y?.gjenstaaende ?? x.gjenstaaende)}</td>
                  <td className="tall">{x.renter ? kr(x.renter) : ""}</td>
                  <td>{y ? <Betaling f={y} /> : <span className="dempet">–</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {k && k.uplasserte.length > 0 && (
        <p className="dempet liten">
          Innbetalt, men ikke plassert mot et krav ennå:{" "}
          {k.uplasserte.map((x) => `${belop(x.uplassert)}${x.dato ? ` (${dato(x.dato)})` : ""}`).join(", ")}.
        </p>
      )}

      <h3 className="lonn-under">Innbetalinger og utbetalinger</h3>
      {!k ? null : !betalinger.length ? (
        <div className="kort">
          <Tom tittel="Ingen betalinger">
            <p>
              Ingen innbetalinger til eller utbetalinger fra Skatteetaten fra {dato(k.periode.fra)} til {dato(k.periode.til)}.
            </p>
          </Tom>
        </div>
      ) : (
        <div className="kort tabell">
          <table>
            <thead>
              <tr>
                <th>Dato</th>
                <th>Hva</th>
                {!smal && <th>Tekst</th>}
                <th className="tall">Beløp</th>
              </tr>
            </thead>
            <tbody>
              {betalinger.map((x, i) => (
                <tr key={i}>
                  <td>{dato(x.dato)}</td>
                  <td>
                    {x.hva}
                    {smal && x.tekst && <div className="dempet liten">{x.tekst}</div>}
                  </td>
                  {!smal && <td className="dempet">{x.tekst}</td>}
                  <td className="tall">{kr(x.belop)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
