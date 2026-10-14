// Oversikten for den ansatte (forsiden, «Oversikt» øverst i menyen): det som gjelder deg selv. Neste
// vakt, timene denne uka, ferien som er igjen og timebanken; de neste vaktene; det som venter på deg
// (vakter kollegaene gir bort, ledige vakter, avviste timer, nye beskjeder); beskjedene og den siste
// lønnsslippen. Hvert kort henter sitt fra de samme rutene sidene bruker, så et kort som er tregt
// eller feiler, ikke stopper resten. Eier og administrator har sin egen oversikt (Oversikt.tsx), og
// plattformadministratoren sin (Admin.tsx).
import { Link, useNavigate } from "react-router-dom";
import { hent } from "../api";
import { Laster, Tom, useData } from "../felles";
import { harFunksjon, useKonto } from "../konto";
import { dato, iDag, kr, leggTilDager } from "../format";
import { mandag, timer, ukenr, visDag } from "../uke";
import { maaned } from "../lonn";
import { IkonBjelle, IkonEkstraTimer, IkonFerie, IkonFravaer, IkonKalender, IkonKlokke, IkonLedigeVakter, IkonLonn, IkonPerson, IkonTimebank } from "../ikoner";
import type { Fast, Vakt, VaktSvar } from "./Vakter";
import type { Detaljer as FerieDetaljer } from "./Ferie";
import { fraKolleger, type ByttSvar } from "./Vaktbytte";
import { fravaerPeriode, fravaerTekst } from "./Fravaer";
import { antall, hilsen, Oppfolging, Tall, type Oppgave } from "./OversiktDeler";

type Uke = { ansatt_id: string; uke: number; sum: number; status: "utkast" | "levert" | "godkjent" | "avvist" };
type Slipp = { id: string; periode: string; utbetalingsdato: string; netto: number; brutto: number };
type Beskjed = { id: string; tekst: string; forfatter_navn: string; opprettet: string; ny: boolean };

const tall = new Intl.NumberFormat("nb-NO", { maximumFractionDigits: 1 });
const UKESTATUS: Record<Uke["status"], string> = {
  utkast: "Ikke levert ennå",
  levert: "Levert til godkjenning",
  godkjent: "Godkjent",
  avvist: "Avvist – se over timene",
};
// «I dag», «I morgen» eller dagen («Tor. 22. okt.»).
const naarDag = (d: string, idag: string) => (d === idag ? "I dag" : d === leggTilDager(idag, 1) ? "I morgen" : visDag(d));
const tid = (v: { fra: string | null; til: string | null }) => (v.fra && v.til ? `${v.fra}–${v.til}` : "Hel dag");
const erVakt = (v: Vakt | Fast): v is Vakt => "id" in v;

export function AnsattOversikt() {
  const { org, meg } = useKonto();
  const nav = useNavigate();
  const egen = org?.ansatt_id ?? null;
  const personal = !!org?.personal && !!egen;
  const vaktplan = personal && harFunksjon(org, "vaktplan");
  const lonn = personal && harFunksjon(org, "lonn");
  const bytte = vaktplan && org?.vaktbytte !== "av";
  const idag = iDag();
  const uke = mandag(idag);
  const aar = Number(idag.slice(0, 4));
  const sti = `/org/${org?.id}`;
  const valg = { oppdater: true };

  // De neste to ukene: egne vakter og faste dager, de ledige vaktene og fraværet (som Mine vakter).
  const vakter = useData(
    () => (vaktplan ? hent<VaktSvar>(`${sti}/vakter?fra=${idag}&til=${leggTilDager(idag, 13)}&ansatt=${egen}&ledige=1`) : Promise.resolve(null)),
    [sti, egen, vaktplan, idag],
    valg,
  );
  const timerUka = useData(
    () => (personal ? hent<{ uker: Uke[] }>(`${sti}/timer?fra=${uke}&til=${leggTilDager(uke, 6)}&ansatt=${egen}`) : Promise.resolve(null)),
    [sti, egen, personal, uke],
    valg,
  );
  const ferie = useData(
    () => (vaktplan ? hent<FerieDetaljer>(`${sti}/feriebank/${egen}?aar=${aar}`).catch(() => null) : Promise.resolve(null)),
    [sti, egen, vaktplan, aar],
    valg,
  );
  const timebank = useData(
    () => (personal && org?.timebank ? hent<{ saldo: { saldo: number } }>(`${sti}/timebank/${egen}`).catch(() => null) : Promise.resolve(null)),
    [sti, egen, personal, org?.timebank],
    valg,
  );
  const slipper = useData(() => (lonn ? hent<Slipp[]>(`${sti}/lonn/mine`).catch(() => null) : Promise.resolve(null)), [sti, lonn], valg);
  const beskjeder = useData(
    () => (personal ? hent<{ beskjeder: Beskjed[] }>(`${sti}/beskjeder`).catch(() => null) : Promise.resolve(null)),
    [sti, personal],
    valg,
  );
  const bytter = useData(() => (bytte ? hent<ByttSvar>(`${sti}/vaktbytter`).catch(() => null) : Promise.resolve(null)), [sti, bytte], valg);

  if (!org) return <Laster />;
  if (!egen)
    return (
      <>
        <h1>{hilsen(meg?.bruker.navn)}</h1>
        <div className="kort">
          <Tom ikon={<IkonPerson storrelse={22} />} tittel="Du er ikke registrert som ansatt her">
            <p>Ta kontakt med den som administrerer {org.navn}.</p>
          </Tom>
        </div>
      </>
    );

  const v = vakter.data;
  // Egne vakter og faste arbeidsdager fra og med i dag, i rekkefølge.
  const mine: (Vakt | Fast)[] = v
    ? [...v.vakter.filter((x) => x.ansatt_id === egen && x.publisert), ...(v.faste ?? []).filter((f) => f.ansatt_id === egen)]
        .filter((x) => x.dato >= idag)
        .sort((a, b) => a.dato.localeCompare(b.dato) || (a.fra ?? "").localeCompare(b.fra ?? ""))
    : [];
  const neste = mine.find((x) => !x.fravaer);
  const ledige = v ? v.vakter.filter((x) => !x.ansatt_id && x.publisert && x.dato >= idag) : [];
  const fraKollegaer = fraKolleger(bytter.data?.bytter, egen);
  const tilMeg = (bytter.data?.bytter ?? []).filter((b) => b.status === "tilbudt" && b.til_ansatt === egen);
  const fravaer = (v?.fravaer ?? []).filter((f) => f.ansatt_id === egen && f.til >= idag);
  const denneUka = timerUka.data?.uker.find((u) => u.ansatt_id === egen);
  const saldo = ferie.data?.saldo;
  const tb = timebank.data?.saldo.saldo;
  const slipp = slipper.data?.[0];
  const nye = (beskjeder.data?.beskjeder ?? []).filter((b) => b.ny);

  // Det som venter på deg.
  const oppgaver: Oppgave[] = [
    ...tilMeg.map((b) => ({
      nokkel: `bytte-${b.id}`,
      tekst: `${b.fra_navn.split(" ")[0]} vil ${b.mot_vakt_id ? "bytte vakt med deg" : "gi deg vakten"} ${naarDag(b.dato, idag).toLowerCase()} ${b.fra}–${b.til}`,
      til: "/vakter?fane=bytter",
    })),
    ...(denneUka?.status === "avvist" ? [{ nokkel: "timer-avvist", tekst: `Timene for uke ${denneUka.uke} er avvist. Se over og send på nytt.`, til: "/timer", fare: true }] : []),
    ...(ledige.length + fraKollegaer.length > 0
      ? [{ nokkel: "ledige", tekst: `${antall(ledige.length + fraKollegaer.length, "ledig vakt", "ledige vakter")} de neste to ukene`, til: "/vakter?fane=ledige" }]
      : []),
    ...(nye.length ? [{ nokkel: "beskjeder", tekst: antall(nye.length, "ny beskjed", "nye beskjeder"), til: "/beskjeder" }] : []),
    ...(ferie.data?.overforinger ?? [])
      .filter((o) => o.status === "venter")
      .map((o) => ({ nokkel: `ferie-${o.id}`, tekst: `Søknaden om å overføre ${tall.format(o.dager)} feriedager venter på svar`, til: "/ferie" })),
  ];
  const lasterOppgaver = (vaktplan && !vakter.data && !vakter.feil) || (bytte && !bytter.data && !bytter.feil);

  return (
    <>
      <div className="velkommen">
        <div>
          <h1>{hilsen(meg?.bruker.navn)}</h1>
          <p>Her er det som gjelder deg i {org.navn}.</p>
        </div>
        <div className="knapper">
          {vaktplan && (
            <button onClick={() => nav("/fravaer?ny=1")}>
              <IkonFravaer storrelse={16} /> Meld deg syk
            </button>
          )}
          <button className="primar" onClick={() => nav("/timer?send=1")}>
            <IkonEkstraTimer storrelse={16} /> Send ekstra timer
          </button>
        </div>
      </div>

      {fravaer.map((f) => (
        <div key={f.id} className="melding info">
          {fravaerTekst[f.type]}: {fravaerPeriode(f)}. <Link to="/fravaer">Se fraværet ditt</Link>
        </div>
      ))}

      <div className="nokkeltall">
        {vaktplan && (
          <Tall
            ikon={<IkonKalender />}
            etikett="Neste vakt"
            til="/vakter?fane=plan&visning=turnus"
            verdi={!v ? "…" : neste ? naarDag(neste.dato, idag) : "Ingen"}
            under={!v ? "" : neste ? `${tid(neste)}${erVakt(neste) && (neste.vakttype_navn || neste.oppgave) ? ` · ${neste.vakttype_navn ?? neste.oppgave}` : ""}` : "Ingen vakter de neste to ukene"}
          />
        )}
        <Tall
          ikon={<IkonKlokke />}
          tone={denneUka?.status === "avvist" ? "fare" : denneUka?.status === "godkjent" ? "ok" : undefined}
          etikett={`Timer uke ${ukenr(uke).uke}`}
          til="/timer"
          verdi={timerUka.data ? timer(denneUka?.sum ?? 0) : "…"}
          under={timerUka.data ? (denneUka ? UKESTATUS[denneUka.status] : "Ingen timer ført denne uka") : ""}
        />
        {saldo && (
          <Tall
            ikon={<IkonFerie />}
            tone={saldo.igjen < 0 ? "fare" : undefined}
            etikett={`Ferie ${aar}`}
            til="/ferie"
            verdi={`${tall.format(saldo.igjen)} ${Math.abs(saldo.igjen) === 1 ? "dag" : "dager"}`}
            under={`igjen av ${tall.format(saldo.rett + saldo.overfort_inn)}${saldo.planlagt ? ` · ${tall.format(saldo.planlagt)} planlagt` : ""}`}
          />
        )}
        {tb !== undefined ? (
          <Tall ikon={<IkonTimebank />} etikett="Timebank" til="/timer?fane=timebank" verdi={`${tb > 0 ? "+" : tb < 0 ? "−" : ""}${timer(Math.abs(tb))}`} under="kan avspaseres" />
        ) : (
          vaktplan && (
            <Tall
              ikon={<IkonLedigeVakter />}
              etikett="Ledige vakter"
              til="/vakter?fane=ledige"
              verdi={v ? String(ledige.length + fraKollegaer.length) : "…"}
              under="de neste to ukene"
            />
          )
        )}
      </div>

      <div className="dash-rad">
        {vaktplan ? (
          <div className="kort">
            <div className="kort-topp">
              <h2>Mine neste vakter</h2>
              <Link to="/vakter?fane=plan&visning=turnus" className="liten">
                Kalender
              </Link>
            </div>
            {vakter.feil ? (
              <p className="dempet">{vakter.feil}</p>
            ) : !v ? (
              <Laster />
            ) : mine.length ? (
              <ul className="liste-enkel">
                {mine.slice(0, 6).map((x) => (
                  <li key={erVakt(x) ? x.id : `fast-${x.dato}`}>
                    <div style={{ minWidth: 0 }}>
                      <div className="tittel">{naarDag(x.dato, idag)}</div>
                      <div className="dempet liten">
                        {x.fravaer ? `${fravaerTekst[x.fravaer]} (borte)` : erVakt(x) ? x.vakttype_navn ?? x.oppgave ?? "Vakt" : "Fast arbeidsdag"}
                      </div>
                    </div>
                    <span className="tall">{tid(x)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <Tom ikon={<IkonKalender />} tittel="Ingen vakter de neste to ukene">
                <Link to="/vakter?fane=ledige" className="liten">
                  Se de ledige vaktene
                </Link>
              </Tom>
            )}
          </div>
        ) : (
          <Snarveier lonn={lonn} />
        )}
        <Oppfolging oppgaver={oppgaver} laster={lasterOppgaver} tittel="Venter på deg" />
      </div>

      <div className="dash-rad">
        {personal && (
          <div className="kort">
            <div className="kort-topp">
              <h2>Beskjeder</h2>
              <Link to="/beskjeder" className="liten">
                Alle beskjeder
              </Link>
            </div>
            {!beskjeder.data ? (
              beskjeder.feil ? null : <Laster />
            ) : beskjeder.data.beskjeder.length ? (
              <ul className="liste-enkel beskjed-utdrag">
                {beskjeder.data.beskjeder.slice(0, 3).map((b) => (
                  <li key={b.id}>
                    <div style={{ minWidth: 0 }}>
                      <div className={b.ny ? "tittel" : undefined}>{b.tekst.length > 140 ? `${b.tekst.slice(0, 140)}…` : b.tekst}</div>
                      <div className="dempet liten">
                        {b.forfatter_navn} · {dato(b.opprettet.slice(0, 10))}
                      </div>
                    </div>
                    {b.ny && <span className="merke merke-info">Ny</span>}
                  </li>
                ))}
              </ul>
            ) : (
              <Tom ikon={<IkonBjelle />} tittel="Ingen beskjeder" />
            )}
          </div>
        )}
        {lonn ? (
          <div className="kort">
            <div className="kort-topp">
              <h2>Lønn</h2>
              <Link to="/lonn?fane=mine" className="liten">
                Lønnsslipper
              </Link>
            </div>
            {!slipper.data ? (
              slipper.feil ? null : <Laster />
            ) : slipp ? (
              <Link to="/lonn?fane=mine" className="lonn-siste">
                <span className="dempet liten">Siste lønnsslipp · {maaned(slipp.periode)}</span>
                <strong>{kr(slipp.netto)} kr</strong>
                <span className="dempet liten">
                  utbetalt {dato(slipp.utbetalingsdato)} · brutto {kr(slipp.brutto)} kr
                </span>
              </Link>
            ) : (
              <Tom ikon={<IkonLonn />} tittel="Ingen lønnsslipper ennå">
                <p className="liten">Lønnsslippen kommer her når lønnen er godkjent.</p>
              </Tom>
            )}
          </div>
        ) : (
          vaktplan && <Snarveier lonn={false} />
        )}
      </div>
    </>
  );
}

// Snarveiene til sidene den ansatte bruker mest.
function Snarveier({ lonn }: { lonn: boolean }) {
  return (
    <div className="kort">
      <div className="kort-topp">
        <h2>Snarveier</h2>
      </div>
      <ul className="liste-enkel">
        <li>
          <Link to="/meg">Min side: opplysningene dine, ansettelsen og lønnen</Link>
        </li>
        <li>
          <Link to="/timer">Timene dine</Link>
        </li>
        {lonn && (
          <li>
            <Link to="/lonn?fane=reiser">Reiser og utlegg</Link>
          </li>
        )}
      </ul>
    </div>
  );
}
