import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { hent } from "../api";
import { Feil, Laster, Tom, useData } from "../felles";
import { kanSkrive, useKonto } from "../konto";
import { dato, kr } from "../format";
import { IkonFaktura, IkonHake, IkonKlokke, IkonKroner, IkonKunder, IkonPluss, IkonUtkast, IkonVarsel } from "../ikoner";
import { Fakturatabell } from "./Fakturaer";

export function Oversikt() {
  const { org, meg, velgOrg } = useKonto();
  const nav = useNavigate();
  const { data, feil } = useData(() => hent<any[]>(`/org/${org!.id}/fakturaer`), [org?.id]);

  // Regnskapsbyrå: felles oversikt over klientene.
  if (org?.type === "regnskapsbyraa") {
    const klienter = (meg?.organisasjoner ?? []).filter((o) => !o.direkte_medlem);
    return (
      <>
        <h1>Klienter</h1>
        {org.verifisering === "ny" && (
          <div className="melding info">
            Byrået må være verifisert før klienter kan gi tilgang. <Link to="/verifisering">Verifiser nå</Link>
          </div>
        )}
        <p className="dempet">Klienter som har gitt {org.navn} tilgang. Velg en klient for å se fakturaene.</p>
        <div className="kort tabell">
          <table>
            <thead>
              <tr>
                <th>Klient</th>
                <th>Org.nr.</th>
                <th>Tilgang</th>
              </tr>
            </thead>
            <tbody>
              {klienter.map((k) => (
                <tr
                  key={k.id}
                  className="klikkbar"
                  onClick={() => {
                    velgOrg(k.id);
                    nav("/fakturaer");
                  }}
                >
                  <td>{k.navn}</td>
                  <td>{k.orgnr}</td>
                  <td>{k.rolle === "regnskap" ? "Les og bokfør" : "Les"}</td>
                </tr>
              ))}
              {klienter.length === 0 && (
                <tr>
                  <td colSpan={3} className="dempet">
                    Ingen klienter ennå. Be om tilgang under <Link to="/innstillinger?fane=brukere">Innstillinger → Brukere</Link>, eller be klienten invitere byrået.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </>
    );
  }

  if (feil) return <Feil melding={feil} />;
  if (!data) return <Laster />;

  const rest = (f: any) => f.sum_inkl_mva - f.kreditert_belop - f.betalt_belop;
  const fakturaer = data.filter((f) => f.type === "faktura");
  const utestaende = fakturaer.filter((f) => f.status === "utstedt");
  const sumUte = utestaende.reduce((s, f) => s + rest(f), 0);
  const forfalt = utestaende.filter((f) => f.forfalt);
  const sumForfalt = forfalt.reduce((s, f) => s + rest(f), 0);
  const iDag = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Oslo" }).format(new Date());
  const maaned = iDag.slice(0, 7);
  const utstedte = data.filter((f) => f.status !== "utkast" && f.fakturadato);
  const fakturertMnd = utstedte.filter((f) => f.fakturadato.startsWith(maaned)).reduce((s, f) => s + f.sum_inkl_mva, 0);
  const betaltMnd = fakturaer.filter((f) => f.status === "betalt" && (f.fakturadato ?? "").startsWith(maaned)).length;
  const utkast = data.filter((f) => f.status === "utkast");
  const snart = utestaende
    .filter((f) => !f.forfalt)
    .sort((a, b) => String(a.forfallsdato).localeCompare(String(b.forfallsdato)))
    .slice(0, 5);

  // Fakturert per måned, siste seks måneder (kreditnotaer trekker fra).
  const maaneder = Array.from({ length: 6 }, (_, i) => {
    const d = new Date(`${maaned}-01T12:00:00`);
    d.setMonth(d.getMonth() - (5 - i));
    const nokkel = d.toISOString().slice(0, 7);
    return {
      nokkel,
      navn: new Intl.DateTimeFormat("nb-NO", { month: "short" }).format(d).replace(".", ""),
      sum: utstedte.filter((f) => f.fakturadato.startsWith(nokkel)).reduce((s, f) => s + f.sum_inkl_mva, 0),
    };
  });

  const time = Number(new Intl.DateTimeFormat("nb-NO", { hour: "numeric", timeZone: "Europe/Oslo" }).format(new Date()));
  const hilsen = time < 5 ? "God natt" : time < 10 ? "God morgen" : time < 18 ? "God dag" : "God kveld";
  const fornavn = (meg?.bruker.navn ?? "").split(" ")[0];

  return (
    <>
      <div className="velkommen">
        <div>
          <h1>
            {hilsen}
            {fornavn ? `, ${fornavn}` : ""}
          </h1>
          <p>Her er status for {org?.navn}.</p>
        </div>
        {kanSkrive(org?.rolle) && (
          <div className="knapper">
            <button onClick={() => nav("/kunder")}>
              <IkonKunder storrelse={16} /> Ny kunde
            </button>
            <button className="primar" onClick={() => nav("/fakturaer/ny")}>
              <IkonPluss storrelse={16} /> Ny faktura
            </button>
          </div>
        )}
      </div>
      {org?.verifisering === "ny" && (
        <div className="melding info">
          Organisasjonen er ikke verifisert ennå. Til den er det, kan dere sende opptil 20 fakturaer og 50 000 kr per måned.{" "}
          <Link to="/verifisering">Verifiser nå</Link>
        </div>
      )}
      {org?.verifisering === "sperret" && <div className="melding feil">Organisasjonen er sperret og kan ikke sende fakturaer.</div>}
      <div className="nokkeltall">
        <div className="kort">
          <div className="etikett">
            <span className="ikonboks"><IkonKroner /></span> Utestående
          </div>
          <div className="verdi">{kr(sumUte)}</div>
          <div className="under">{utestaende.length} ubetalte fakturaer</div>
        </div>
        <div className="kort">
          <div className="etikett">
            <span className={`ikonboks ${forfalt.length ? "fare" : "noytral"}`}><IkonVarsel /></span> Forfalt
          </div>
          <div className="verdi">{kr(sumForfalt)}</div>
          <div className="under">{forfalt.length ? `${forfalt.length} fakturaer har passert forfall` : "Ingenting forfalt"}</div>
        </div>
        <div className="kort">
          <div className="etikett">
            <span className="ikonboks ok"><IkonHake /></span> Fakturert denne måneden
          </div>
          <div className="verdi">{kr(fakturertMnd)}</div>
          <div className="under">{betaltMnd} av dem er betalt</div>
        </div>
        <div className="kort">
          <div className="etikett">
            <span className="ikonboks noytral"><IkonUtkast /></span> Utkast
          </div>
          <div className="verdi">{utkast.length}</div>
          <div className="under">{utkast.length ? "Klare til å sendes" : "Ingen utkast"}</div>
        </div>
      </div>

      <div className="dash-rad">
        <div className="kort">
          <div className="kort-topp">
            <h2>Fakturert inkl. mva</h2>
            <span className="dempet liten">Siste seks måneder</span>
          </div>
          <Stolper data={maaneder} />
        </div>
        <div className="kort">
          <div className="kort-topp">
            <h2>Forfaller snart</h2>
            <Link to="/fakturaer?status=utstedt" className="liten">
              Se alle
            </Link>
          </div>
          {snart.length ? (
            <ul className="liste-enkel">
              {snart.map((f) => (
                <li key={f.id} style={{ cursor: "pointer" }} onClick={() => nav(`/fakturaer/${f.id}`)}>
                  <div style={{ minWidth: 0 }}>
                    <div className="tittel">{f.kunde_navn ?? f.kunde?.navn ?? `Faktura ${f.fakturanummer}`}</div>
                    <div className="dempet liten">
                      Nr. {f.fakturanummer} · forfaller {dato(f.forfallsdato)}
                    </div>
                  </div>
                  <span className="tall">{kr(rest(f))}</span>
                </li>
              ))}
            </ul>
          ) : (
            <Tom ikon={<IkonKlokke />} tittel="Ingen ubetalte fakturaer">
              <span className="liten">Alt er betalt eller forfalt.</span>
            </Tom>
          )}
        </div>
      </div>

      <div className="kort-topp" style={{ marginTop: 8 }}>
        <h2>Siste fakturaer</h2>
        <Link to="/fakturaer" className="liten">
          Alle fakturaer
        </Link>
      </div>
      {data.length ? (
        <Fakturatabell
          rader={data.slice(0, 8)}
          klikk={(id) => nav(`/fakturaer/${id}`)}
          kopier={kanSkrive(org?.rolle) ? (id) => nav(`/fakturaer/ny?kopi=${id}`) : undefined}
        />
      ) : (
        <div className="kort">
          <Tom ikon={<IkonFaktura />} tittel="Ingen fakturaer ennå">
            <p className="liten">Lag den første fakturaen, så dukker den opp her.</p>
            {kanSkrive(org?.rolle) && (
              <button className="primar" onClick={() => nav("/fakturaer/ny")}>
                <IkonPluss storrelse={16} /> Ny faktura
              </button>
            )}
          </Tom>
        </div>
      )}
    </>
  );
}

// Ett stolpediagram, én serie: ingen forklaring trengs, tittelen sier hva det er.
// Verdiene vises i verktøytips ved pekeren, og som tekst over høyeste stolpe.
function Stolper({ data }: { data: { nokkel: string; navn: string; sum: number }[] }) {
  const [valgt, settValgt] = useState<number | null>(null);
  const B = 560;
  const H = 210;
  const topp = 20;
  const bunn = 26;
  const venstre = 4;
  const maks = Math.max(...data.map((d) => d.sum), 1);
  const steg = Math.pow(10, Math.floor(Math.log10(maks)));
  const tak = Math.ceil(maks / steg) * steg;
  const bredde = (B - venstre) / data.length;
  const stolpe = Math.min(44, bredde * 0.55);
  const y = (v: number) => topp + (H - topp - bunn) * (1 - v / tak);
  const hoyest = data.reduce((m, d, i) => (d.sum > data[m].sum ? i : m), 0);
  const kort = (n: number) => (n >= 1e6 ? `${(n / 1e6).toLocaleString("nb-NO", { maximumFractionDigits: 1 })} mill` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(Math.round(n)));

  return (
    <div className="stolpe-diagram" onMouseLeave={() => settValgt(null)}>
      <svg viewBox={`0 0 ${B} ${H}`} role="img" aria-label="Fakturert per måned, siste seks måneder">
        {[0, 0.5, 1].map((t) => (
          <line key={t} className="rutenett" x1={0} x2={B} y1={y(tak * t)} y2={y(tak * t)} />
        ))}
        {data.map((d, i) => {
          const x = venstre + i * bredde + (bredde - stolpe) / 2;
          const h = Math.max(H - bunn - y(d.sum), d.sum > 0 ? 2 : 0);
          const r = Math.min(4, h / 2);
          const y0 = H - bunn;
          // Avrundet topp, flat mot grunnlinjen.
          const sti = h > 0 ? `M${x},${y0} V${y0 - h + r} Q${x},${y0 - h} ${x + r},${y0 - h} H${x + stolpe - r} Q${x + stolpe},${y0 - h} ${x + stolpe},${y0 - h + r} V${y0} Z` : "";
          return (
            <g key={d.nokkel}>
              {sti && <path className={`stolpe${valgt !== null && valgt !== i ? " dempet" : ""}`} d={sti} />}
              {i === hoyest && d.sum > 0 && valgt === null && (
                <text className="akse" x={x + stolpe / 2} y={y0 - h - 6} textAnchor="middle">
                  {kort(d.sum)}
                </text>
              )}
              <text className="akse" x={x + stolpe / 2} y={H - 6} textAnchor="middle">
                {d.navn}
              </text>
              <rect className="treff" x={venstre + i * bredde} y={0} width={bredde} height={H} onMouseEnter={() => settValgt(i)} />
            </g>
          );
        })}
      </svg>
      {valgt !== null && (
        <div className="verktoytips" style={{ left: `${((venstre + valgt * bredde + bredde / 2) / B) * 100}%`, top: `${(y(data[valgt].sum) / H) * 100}%` }}>
          {data[valgt].navn}: <strong>{kr(data[valgt].sum)}</strong>
        </div>
      )}
    </div>
  );
}
