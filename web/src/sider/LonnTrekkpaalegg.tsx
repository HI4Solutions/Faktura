// Trekkpålegg fra Skatteetaten (server/src/trekkpaalegg.ts og trekkpaaleggRuter.ts,
// docs/trekkpaalegg.md): fanen «Trekkpålegg» under Lønn. Påleggene om utleggstrekk Skatteetaten
// har sendt organisasjonen: hvem det gjelder (den ansatte, eller fødselsdatoen når skyldneren ikke
// er registrert med fødselsnummer), trekket som gjelder nå og det neste, KID-en og kontonummeret,
// det som er trukket, periodene og merknadene. Lønnskjøringen trekker dem (det som gjelder på
// utbetalingsdatoen). Hentes hver morgen; «Hent nå» ber workeren hente.
import { useState } from "react";
import { Link } from "react-router-dom";
import { api, hent } from "../api";
import { Feil, Laster, Tom, useData, useHandling } from "../felles";
import { useKonto } from "../konto";
import { dato, iDag, kr } from "../format";

type Periode = { fra: string; til: string | null; belop: number | null; prosent: number | null };
type Paalegg = {
  id: string;
  trekkid: string;
  trekkversjon: number;
  saksnummer: string | null;
  trekkstatus: "aktiv" | "avsluttet";
  formidlet: string | null;
  fodselsdato: string | null;
  kontonr: string | null;
  kid: string | null;
  perioder: Periode[];
  merknader: string[];
  ansatt_id: string | null;
  navn: string | null;
  trukket: number;
  trukket_i_aar: number;
  sist_trukket: string | null;
  gjeldende: Periode | null;
  neste: Periode | null;
};
type Status = {
  pa: boolean;
  miljo: "test" | "prod";
  koblet: boolean;
  tilgang: boolean;
  ressurs: string;
  henting: { forsokt: string | null; hentet: string | null; antall: number | null; feil: string | null };
  paalegg: Paalegg[];
};

const tid = (iso: string) => {
  const d = new Date(iso);
  return `${dato(new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Oslo" }).format(d))} kl. ${new Intl.DateTimeFormat("nb-NO", { timeZone: "Europe/Oslo", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d).replace(":", ".")}`;
};
const konto = (k: string | null) => (k && /^\d{11}$/.test(k) ? `${k.slice(0, 4)} ${k.slice(4, 6)} ${k.slice(6)}` : (k ?? ""));
// Beløpet i hele kroner når det er det (påleggene er som regel i hele kroner).
const belop = (n: number) => (n % 1 ? kr(n) : kr(n).replace(/,00$/, ""));
// Størrelsen som tekst, som på serveren (lonnstrekk.ts, storrelseTekst).
export function storrelse(p: Pick<Periode, "belop" | "prosent">) {
  if (p.prosent != null && p.prosent > 0) return `${String(p.prosent).replace(".", ",")} % av bruttolønnen`;
  if (p.belop != null && p.belop > 0) return `${belop(p.belop)} kr per måned`;
  return "ikke noe trekk";
}
const periodeTekst = (p: Periode) => (p.til ? (p.til < p.fra ? `avsluttet før ${dato(p.fra)}` : `${dato(p.fra)}–${dato(p.til)}`) : `fra ${dato(p.fra)}`);

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

function Pakort({ p }: { p: Paalegg }) {
  const avsluttet = p.trekkstatus === "avsluttet";
  return (
    <div className={`liste-rad trekkpaalegg-rad${avsluttet ? " dempet" : ""}`}>
      <span className="linje">
        <span className="tittel">
          {p.navn ? (
            <Link to={`/ansatte?ansatt=${p.ansatt_id}`}>{p.navn}</Link>
          ) : (
            <>Ikke registrert{p.fodselsdato ? ` (født ${dato(p.fodselsdato)})` : ""}</>
          )}
        </span>
        <span>
          {avsluttet ? <span className="merke merke-noytral">Avsluttet</span> : <span className="merke merke-ok">Aktiv</span>}
          {!p.navn && !avsluttet && <span className="merke merke-advarsel">Ikke koblet</span>}
        </span>
      </span>
      <span className="linje">
        <span className="under">
          {p.gjeldende ? (
            <>
              Trekk nå: <strong>{storrelse(p.gjeldende)}</strong> ({periodeTekst(p.gjeldende)})
            </>
          ) : avsluttet ? (
            "Trekkes ikke lenger"
          ) : (
            "Ikke noe trekk nå"
          )}
          {p.neste && ` · Fra ${dato(p.neste.fra)}: ${storrelse(p.neste)}`}
        </span>
      </span>
      <span className="linje">
        <span className="under trekkpaalegg-betaling">
          {p.saksnummer && <span>Sak {p.saksnummer}</span>}
          {p.kid && (
            <span>
              KID {p.kid} <Kopier verdi={p.kid} navn="KID" />
            </span>
          )}
          {p.kontonr && <span>Konto {konto(p.kontonr)}</span>}
        </span>
      </span>
      {(p.trukket > 0 || p.navn) && (
        <span className="linje">
          <span className="under">
            Trukket i år {kr(p.trukket_i_aar)} kr · i alt {kr(p.trukket)} kr{p.sist_trukket ? ` · sist ${dato(p.sist_trukket)}` : ""}
          </span>
        </span>
      )}
      {p.merknader.map((m) => (
        <div key={m} className="melding advarsel liten">
          {m}
        </div>
      ))}
      <details className="trekkpaalegg-perioder">
        <summary className="liten">
          Periodene (versjon {p.trekkversjon}
          {p.formidlet ? `, formidlet ${tid(p.formidlet)}` : ""})
        </summary>
        {p.perioder.length ? (
          <ul className="liten">
            {p.perioder.map((x, i) => (
              <li key={`${x.fra}-${i}`}>
                {periodeTekst(x)}: {storrelse(x)}
              </li>
            ))}
          </ul>
        ) : (
          <p className="liten dempet">Pålegget har ingen perioder.</p>
        )}
        <p className="liten dempet">Trekk-ID {p.trekkid}.</p>
      </details>
    </div>
  );
}

export function Trekkpaalegg() {
  const { org } = useKonto();
  const sti = `/org/${org!.id}/lonn/trekkpaalegg`;
  const status = useData(() => hent<Status>(sti), [sti], { oppdater: true });
  const h = useHandling();
  const [hentes, settHentes] = useState(false);

  if (status.feil) return <Feil melding={status.feil} />;
  if (!status.data) return <Laster />;
  const s = status.data;
  const klar = s.pa && s.koblet && s.tilgang;
  const hentNa = async () => {
    settHentes(false);
    if (await h.kjor(() => api("POST", `${sti}/hent`))) {
      settHentes(true);
      window.setTimeout(() => void status.last(), 5000);
    }
  };
  const aktive = s.paalegg.filter((p) => p.trekkstatus === "aktiv");
  const avsluttede = s.paalegg.filter((p) => p.trekkstatus === "avsluttet");
  const idag = iDag();

  return (
    <>
      <p className="undertittel">
        Påleggene om utleggstrekk i lønnen som Skatteetaten har sendt dere. Lønnskjøringen trekker det som gjelder på utbetalingsdatoen: prosenten av bruttolønnen ved hver
        utbetaling, og beløpet én gang i måneden. Trekket betales til Skatteetaten med KID-en i pålegget første virkedag etter lønnsdagen, og står i a-meldingen. Rapporten
        står under <Link to="/rapporter?fane=lonn">Rapporter → Lønn</Link>.
        {s.pa && s.miljo === "test" && <span className="merke merke-noytral lonn-merke">Testmiljø</span>}
      </p>

      <section className="kort">
        <h3 style={{ marginTop: 0 }}>Koblingen til Skatteetaten</h3>
        {!s.pa ? (
          <p className="liten">
            Trekkpålegg fra Skatteetaten er ikke slått på ennå. Til da kommer påleggene i innboksen i Altinn, og trekket legges inn for hånd på den ansatte (Ansatte → Lønn →
            Faste trekk).
          </p>
        ) : !s.koblet ? (
          <p className="liten">
            Koble til Skatteetaten først under <Link to="/lonn?fane=skattekort">Lønn → Skattekort</Link>, og la daglig leder godkjenne i Altinn.
          </p>
        ) : !s.tilgang ? (
          <p className="liten">
            Gi Admin Konsoll tilgang til trekkpåleggene i Altinn: «{s.ressurs}». Trykk «Utvid tilgangen i Altinn» under <Link to="/lonn?fane=skattekort">Lønn → Skattekort</Link>, og
            la daglig leder godkjenne i Altinn.
          </p>
        ) : (
          <p className="liten">
            Påleggene hentes fra Skatteetaten hver morgen{s.henting.hentet ? `, sist ${tid(s.henting.hentet)}` : ""}.
            {s.henting.hentet && !s.henting.feil && ` Skatteetaten ga ${s.henting.antall === 1 ? "1 pålegg" : `${s.henting.antall ?? 0} pålegg`}.`}
          </p>
        )}
        {s.henting.feil && <div className="melding feil">Påleggene ble ikke hentet: {s.henting.feil}</div>}
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

      <h3 className="lonn-under">Pålegg</h3>
      {!s.paalegg.length ? (
        <div className="kort">
          <Tom tittel={s.henting.hentet ? "Ingen trekkpålegg" : "Ikke hentet ennå"}>
            <p>
              {s.henting.hentet
                ? "Skatteetaten har ingen trekkpålegg for dere."
                : "Påleggene hentes fra Skatteetaten når tilgangen er gitt. Et pålegg for en ansatt blir et fast trekk i lønnen."}
            </p>
          </Tom>
        </div>
      ) : (
        <div className="kort liste">
          {aktive.map((p) => (
            <Pakort key={p.id} p={p} />
          ))}
          {!aktive.length && <p className="dempet liten">Ingen aktive pålegg per {dato(idag)}.</p>}
        </div>
      )}
      {avsluttede.length > 0 && (
        <details className="kort trekkpaalegg-avsluttede">
          <summary>Avsluttede pålegg ({avsluttede.length})</summary>
          <div className="liste">
            {avsluttede.map((p) => (
              <Pakort key={p.id} p={p} />
            ))}
          </div>
        </details>
      )}
    </>
  );
}
