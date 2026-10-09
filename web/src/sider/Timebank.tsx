// Timebank (server/src/timebank.ts, 0073_timebank.sql): timer den ansatte har jobbet utover det
// avtalte, som tas ut som fri (avspasering) senere i stedet for å lønnes nå. Overtid og ekstratimer
// føres «til timebanken» i timeføringen. Fanen Timebank under Timer:
//
// - den ansatte: saldoen (timer og dager), søknad om avspasering (hele dager eller noen timer),
//   søknadene og historikken;
// - eier og administrator: saldoen til alle, søknadene som venter (godkjenn med timene, som kan
//   endres, eller avslå med en grunn), og for hver ansatt historikken, avspasering registrert
//   direkte, justering (f.eks. en dag for jobb på en fridag, eller saldoen fra før) og utbetaling i
//   neste lønnskjøring;
// - regnskap: saldoene.
import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, hent } from "../api";
import { Dialog, Feil, Laster, Tom, tall, useData, useHandling, useNarDataEndres, useSmal } from "../felles";
import { kanPersonal, useKonto } from "../konto";
import { kr, iDag, dato } from "../format";
import { IkonKlokke, IkonVenstre } from "../ikoner";
import { tallformat, timer, visDag } from "../uke";

type Saldo = {
  ansatt_id: string;
  navn: string;
  aktiv: boolean;
  lonnstype: "maaned" | "time";
  sats: number | null; // timelønnen, eller timesatsen for fastlønn (bare for dem som ser de ansatte)
  inn: number;
  venter_inn: number;
  avspasert: number;
  utbetalt: number;
  justert: number;
  saldo: number;
  sokt: number;
  dag_timer: number | null;
};
type Soknad = {
  id: string;
  ansatt_id: string;
  ansatt_navn: string;
  fra: string;
  til: string;
  timer: number;
  hele_dager: boolean;
  melding: string | null;
  status: "venter" | "godkjent" | "avslatt" | "trukket";
  svar: string | null;
  opprettet: string;
  behandlet_at: string | null;
  behandlet_av_navn: string | null;
  fjernet: boolean;
};
type Hendelse = {
  kilde: "timer" | "fravaer" | "post";
  id: string;
  dato: string;
  til: string | null;
  type: "overtid" | "ekstratimer" | "avspasering" | "utbetaling" | "justering";
  timer: number;
  tekst: string | null;
  status: string | null;
  overtid_prosent: number | null;
  lonnet: boolean;
};
type Oversikt = { paa: boolean; ansatte: Saldo[]; soknader: Soknad[] };
type Detaljer = { saldo: Saldo; historikk: Hendelse[]; soknader: Soknad[] };

// «12,5 t (1,7 dager)»
const dager = (s: Pick<Saldo, "dag_timer">, t: number) => {
  if (!s.dag_timer) return "";
  const d = Math.round((t / s.dag_timer) * 10) / 10;
  return `${tallformat.format(d)} ${Math.abs(d) === 1 ? "dag" : "dager"}`;
};
const medDager = (s: Pick<Saldo, "dag_timer">, t: number) => (s.dag_timer && t ? `${timer(t)} (${dager(s, t)})` : timer(t));
const fortegn = (t: number) => `${t > 0 ? "+" : t < 0 ? "−" : ""}${timer(Math.abs(t))}`;
const periode = (fra: string, til: string) => (fra === til ? visDag(fra) : `${visDag(fra)} – ${visDag(til)}`);
// Midt i en setning: «fre. 30. okt.».
const liten = (t: string) => t.charAt(0).toLowerCase() + t.slice(1);
const STATUS: Record<Soknad["status"], { tekst: string; klasse: string }> = {
  venter: { tekst: "Venter på svar", klasse: "merke-advarsel" },
  godkjent: { tekst: "Godkjent", klasse: "merke-ok" },
  avslatt: { tekst: "Ikke godkjent", klasse: "merke-fare" },
  trukket: { tekst: "Trukket", klasse: "merke-noytral" },
};

// --- Fanen -----------------------------------------------------------------------------------

export function Timebank({ versjon, endret, valgt, velg }: { versjon: number; endret: () => void; valgt: string | null; velg: (id: string | null) => void }) {
  const { org } = useKonto();
  const leder = kanPersonal(org?.rolle);
  const egen = org?.ansatt_id ?? null;
  const o = useData(() => hent<Oversikt>(`/org/${org!.id}/timebank`), [org?.id, versjon]);
  const [melding, settMelding] = useState<string | null>(null);
  const ferdig = (m: string) => {
    settMelding(m);
    endret();
  };

  if (o.feil) return <Feil melding={o.feil} />;
  if (!o.data) return <Laster />;
  // Den ansatte (og lederen på en ansatt): saldoen og historikken.
  const en = leder ? valgt : egen;
  if (en)
    return (
      <AnsattTimebank
        key={en}
        ansattId={en}
        leder={leder}
        egen={en === egen}
        versjon={versjon}
        endret={endret}
        tilbake={leder && valgt ? () => velg(null) : undefined}
      />
    );
  return (
    <>
      {melding && (
        <div className="melding ok" role="status">
          {melding}
        </div>
      )}
      {leder && <Soknader soknader={o.data.soknader.filter((s) => s.status === "venter")} saldoer={o.data.ansatte} ferdig={ferdig} />}
      <Saldoer saldoer={o.data.ansatte} apne={leder ? velg : undefined} />
      <p className="liten dempet">
        Overtid og ekstratimer kan føres «til timebanken» i timeføringen. De lønnes ikke nå, men tas ut som fri (avspasering) senere; for overtid utbetales
        overtidstillegget likevel (arbeidsmiljøloven § 10-6). Den ansatte søker om avspasering, og den gjelder når den er godkjent. Med timelønn lønnes timene når de tas ut
        som fri; med fastlønn går lønnen som vanlig.
      </p>
    </>
  );
}

// Saldoen til alle (eier, administrator og regnskap), med verdien av saldoen.
function Saldoer({ saldoer, apne }: { saldoer: Saldo[]; apne?: (id: string) => void }) {
  const smal = useSmal();
  if (!saldoer.length)
    return (
      <div className="kort">
        <Tom ikon={<IkonKlokke storrelse={22} />} tittel="Ingen i timebanken ennå">
          <p>Når overtid og ekstratimer føres til timebanken og godkjennes, står saldoen her.</p>
        </Tom>
      </div>
    );
  const verdi = saldoer.reduce((s, x) => s + (x.sats != null ? x.saldo * x.sats : 0), 0);
  const medSats = saldoer.some((x) => x.sats != null);
  if (smal)
    return (
      <div className="kort liste">
        {saldoer.map((s) => (
          <button key={s.ansatt_id} type="button" className="liste-rad" disabled={!apne} onClick={() => apne?.(s.ansatt_id)}>
            <span className="linje">
              <span className="tittel">{s.navn}</span>
              <span className={`belop${s.saldo < 0 ? " ferie-minus" : ""}`}>{timer(s.saldo)}</span>
            </span>
            <span className="linje">
              <span className="under">
                {[
                  s.dag_timer && s.saldo ? dager(s, s.saldo) : null,
                  `inn ${timer(s.inn)}`,
                  s.avspasert ? `avspasert ${timer(s.avspasert)}` : null,
                  s.utbetalt ? `utbetalt ${timer(s.utbetalt)}` : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
              {s.sokt > 0 && <span className="merke merke-advarsel">Søknad</span>}
            </span>
          </button>
        ))}
      </div>
    );
  return (
    <div className="kort tabell">
      <table>
        <thead>
          <tr>
            <th>Ansatt</th>
            <th className="hoyre">Inn</th>
            <th className="hoyre">Avspasert</th>
            <th className="hoyre">Utbetalt</th>
            <th className="hoyre">Justert</th>
            <th className="hoyre">Saldo</th>
            {medSats && <th className="hoyre">Verdi</th>}
          </tr>
        </thead>
        <tbody>
          {saldoer.map((s) => (
            <tr key={s.ansatt_id} className={apne ? "klikkbar" : undefined} onClick={() => apne?.(s.ansatt_id)}>
              <td>
                {s.navn}
                {!s.aktiv && <span className="merke merke-noytral ferie-merke">Sluttet</span>}
                {s.sokt > 0 && <span className="merke merke-advarsel ferie-merke">Søknad</span>}
                {s.venter_inn > 0 && <span className="merke merke-info ferie-merke">{timer(s.venter_inn)} til godkjenning</span>}
              </td>
              <td className="tall">{timer(s.inn)}</td>
              <td className="tall">{s.avspasert ? timer(s.avspasert) : "–"}</td>
              <td className="tall">{s.utbetalt ? timer(s.utbetalt) : "–"}</td>
              <td className="tall">{s.justert ? fortegn(s.justert) : "–"}</td>
              <td className={`tall sterk${s.saldo < 0 ? " ferie-minus" : ""}`}>
                {timer(s.saldo)}
                {s.dag_timer && s.saldo ? <div className="liten dempet">{dager(s, s.saldo)}</div> : null}
              </td>
              {medSats && <td className="tall">{s.sats != null ? kr(s.saldo * s.sats) : "–"}</td>}
            </tr>
          ))}
        </tbody>
        {medSats && (
          <tfoot>
            <tr>
              <td colSpan={5}>Sum (saldoen ganger timelønnen eller timesatsen, uten feriepenger og arbeidsgiveravgift)</td>
              <td className="tall sterk">{timer(saldoer.reduce((s, x) => s + x.saldo, 0))}</td>
              <td className="tall sterk">{kr(verdi)}</td>
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

// Søknadene som venter (eier og administrator): godkjenn med timene (kan endres) eller avslå med
// en grunn.
function Soknader({ soknader, saldoer, ferdig }: { soknader: Soknad[]; saldoer: Saldo[]; ferdig: (m: string) => void }) {
  if (!soknader.length) return null;
  return (
    <section className="kort ferie-soknader timebank-soknader">
      <h2>Søknader om avspasering</h2>
      <ul>
        {soknader.map((s) => (
          <SoknadRad key={s.id} s={s} saldo={saldoer.find((x) => x.ansatt_id === s.ansatt_id)} leder visNavn ferdig={ferdig} />
        ))}
      </ul>
    </section>
  );
}

function SoknadRad({ s, saldo, leder, visNavn, ferdig }: { s: Soknad; saldo?: Saldo; leder?: boolean; visNavn?: boolean; ferdig: (m: string) => void }) {
  const { org } = useKonto();
  const h = useHandling();
  const [svarer, settSvarer] = useState<"godkjenn" | "avslaa" | null>(null);
  const [t, settT] = useState(tallformat.format(s.timer));
  const [svar, settSvar] = useState("");
  const status = STATUS[s.status];
  const behandle = (e: FormEvent) => {
    e.preventDefault();
    h.kjor(async () => {
      const r = await api<Soknad>("POST", `/org/${org!.id}/timebank/soknader/${s.id}/${svarer}`, {
        ...(svarer === "godkjenn" ? { timer: tall(t) } : {}),
        svar: svar.trim() || undefined,
      });
      ferdig(r.status === "godkjent" ? `Avspaseringen for ${r.ansatt_navn} er godkjent. ${r.ansatt_navn.split(" ")[0]} får beskjed.` : `Søknaden er avslått. ${r.ansatt_navn.split(" ")[0]} får beskjed.`);
    });
  };
  const trekk = () =>
    h.kjor(async () => {
      await api("POST", `/org/${org!.id}/timebank/soknader/${s.id}/trekk`);
      ferdig("Søknaden er trukket.");
    });
  return (
    <li className="timebank-soknad">
      <div className="ferie-soknad-tekst">
        {visNavn && <strong>{s.ansatt_navn}: </strong>}
        {periode(s.fra, s.til)} · {timer(s.timer)}
        {!s.hele_dager && <span className="dempet"> (noen timer)</span>}
        {s.melding && <span className="dempet"> «{s.melding}»</span>}
        <div className="liten dempet">
          Søkt {dato(s.opprettet)}
          {saldo && leder ? ` · har ${timer(saldo.saldo)} i banken${saldo.sokt > s.timer ? ` (${timer(saldo.sokt)} søkt i alt)` : ""}` : ""}
          {s.svar ? ` · «${s.svar}»` : ""}
          {s.fjernet ? " · avspaseringen er fjernet etterpå" : ""}
        </div>
      </div>
      {s.status !== "venter" || !leder ? (
        <div className="knapper">
          <span className={`merke ${status.klasse}`}>{status.tekst}</span>
          {s.status === "venter" && (
            <button type="button" className="lenke" disabled={h.opptatt} onClick={trekk}>
              Trekk søknaden
            </button>
          )}
        </div>
      ) : !svarer ? (
        <div className="knapper">
          <button type="button" className="primar" disabled={h.opptatt} onClick={() => settSvarer("godkjenn")}>
            Godkjenn
          </button>
          <button type="button" disabled={h.opptatt} onClick={() => settSvarer("avslaa")}>
            Avslå
          </button>
        </div>
      ) : (
        <form className="timebank-svar" onSubmit={behandle}>
          {svarer === "godkjenn" && (
            <label>
              Timer fra timebanken
              <input inputMode="decimal" required value={t} onChange={(e) => settT(e.target.value)} />
            </label>
          )}
          <label>
            {svarer === "godkjenn" ? "Svar (valgfritt)" : "Grunn (valgfri, den ansatte ser den)"}
            <input maxLength={300} value={svar} onChange={(e) => settSvar(e.target.value)} autoFocus={svarer === "avslaa"} />
          </label>
          <div className="knapper">
            <button className={svarer === "godkjenn" ? "primar" : "fare"} disabled={h.opptatt}>
              {svarer === "godkjenn" ? "Godkjenn" : "Avslå"}
            </button>
            <button type="button" onClick={() => settSvarer(null)}>
              Avbryt
            </button>
          </div>
        </form>
      )}
      <Feil melding={h.feil} />
    </li>
  );
}

// --- Én ansatt -------------------------------------------------------------------------------

function AnsattTimebank({
  ansattId,
  leder,
  egen,
  versjon,
  endret,
  tilbake,
}: {
  ansattId: string;
  leder: boolean;
  egen: boolean;
  versjon: number;
  endret: () => void;
  tilbake?: () => void;
}) {
  const { org } = useKonto();
  const [lokal, settLokal] = useState(0);
  const d = useData(() => hent<Detaljer>(`/org/${org!.id}/timebank/${ansattId}`), [org?.id, ansattId, versjon, lokal]);
  useNarDataEndres(() => settLokal((v) => v + 1));
  const [melding, settMelding] = useState<string | null>(null);
  const [dialog, settDialog] = useState<"sok" | "avspasering" | "juster" | "utbetal" | null>(null);
  const h = useHandling();
  const ferdig = (m: string) => {
    settDialog(null);
    settMelding(m);
    settLokal((v) => v + 1);
    endret();
  };

  if (d.feil) return <Feil melding={d.feil} />;
  if (!d.data) return <Laster />;
  const { saldo: s, historikk, soknader } = d.data;
  const igjen = s.saldo - s.sokt;
  const slett = (x: Hendelse) => {
    if (!confirm(`Slette ${x.type === "utbetaling" ? "utbetalingen" : x.type === "avspasering" ? "avspaseringen" : "justeringen"} (${fortegn(x.timer)})?`)) return;
    h.kjor(async () => {
      await api("DELETE", `/org/${org!.id}/timebank/poster/${x.id}`);
      ferdig("Posten er slettet, og timene er tilbake i banken.");
    });
  };

  return (
    <div className="timebank-ansatt">
      {tilbake && (
        <button type="button" className="lenke tilbake" onClick={tilbake}>
          <IkonVenstre storrelse={16} /> Alle ansatte
        </button>
      )}
      {!egen && <h2 className="timebank-navn">{s.navn}</h2>}
      {melding && (
        <div className="melding ok" role="status">
          {melding}
        </div>
      )}
      <Feil melding={h.feil} />
      <div className="ferie-saldo timebank-saldo">
        <div className={`ferie-igjen${s.saldo < 0 ? " ferie-minus" : ""}`}>
          <span>I timebanken</span>
          <strong>{timer(s.saldo)}</strong>
          {s.dag_timer ? <small>{dager(s, s.saldo)} à {timer(s.dag_timer)}</small> : null}
        </div>
        <div>
          <span>Inn</span>
          <strong>{timer(s.inn)}</strong>
          {s.venter_inn > 0 && <small>+{timer(s.venter_inn)} venter på godkjenning</small>}
        </div>
        <div>
          <span>Avspasert</span>
          <strong>{timer(s.avspasert)}</strong>
          <small>også planlagt fram i tid</small>
        </div>
        {(s.utbetalt > 0 || s.justert !== 0) && (
          <div>
            <span>{s.utbetalt > 0 ? "Utbetalt" : "Justert"}</span>
            <strong>{s.utbetalt > 0 ? timer(s.utbetalt) : fortegn(s.justert)}</strong>
            {s.utbetalt > 0 && s.justert !== 0 && <small>justert {fortegn(s.justert)}</small>}
          </div>
        )}
        {s.sokt > 0 && (
          <div>
            <span>Søkt om</span>
            <strong>{timer(s.sokt)}</strong>
            <small>venter på svar</small>
          </div>
        )}
      </div>
      <div className="knapper timebank-knapper">
        {egen && org?.timebank && (
          <button type="button" className="primar" disabled={igjen <= 0} onClick={() => settDialog("sok")}>
            Søk om avspasering
          </button>
        )}
        {leder && org?.timebank && (
          <>
            <button type="button" className={egen ? undefined : "primar"} onClick={() => settDialog("avspasering")}>
              Registrer avspasering
            </button>
            <button type="button" onClick={() => settDialog("juster")}>
              Juster
            </button>
            <button type="button" disabled={s.saldo <= 0} onClick={() => settDialog("utbetal")}>
              Utbetal
            </button>
          </>
        )}
      </div>
      {egen && igjen <= 0 && s.saldo <= 0 && (
        <p className="liten dempet">Før overtid eller ekstratimer «til timebanken» i timeføringen for å spare timer til avspasering.</p>
      )}

      {soknader.length > 0 && (
        <>
          <h3>Søknader om avspasering</h3>
          <ul className="ferie-soknader timebank-liste">
            {soknader.map((x) => (
              <SoknadRad key={x.id} s={x} saldo={s} leder={leder} ferdig={ferdig} />
            ))}
          </ul>
        </>
      )}

      <h3>Historikk</h3>
      {historikk.length ? (
        <ul className="timebank-historikk">
          {historikk.map((x) => (
            <li key={`${x.kilde}:${x.id}`}>
              <span className="timebank-dato">{x.til && x.til !== x.dato ? periode(x.dato, x.til) : visDag(x.dato)}</span>
              <span className="timebank-tekst">
                {beskriv(x)}
                {x.tekst && <span className="dempet"> «{x.tekst}»</span>}
                {x.status === "levert" && <span className="merke merke-info ferie-merke">Venter på godkjenning</span>}
                {x.lonnet && <span className="merke merke-ok ferie-merke">Lønnet</span>}
              </span>
              <span className={`tall timebank-timer${x.timer < 0 ? " ut" : ""}`}>{fortegn(x.timer)}</span>
              {leder && x.kilde === "post" && !x.lonnet && (
                <button type="button" className="lenke" disabled={h.opptatt} onClick={() => slett(x)}>
                  Slett
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="dempet liten">Ingenting i timebanken ennå.</p>
      )}

      <Dialog apen={dialog === "sok" || dialog === "avspasering"} lukk={() => settDialog(null)} tittel={dialog === "sok" ? "Søk om avspasering" : `Avspasering for ${s.navn}`}>
        {(dialog === "sok" || dialog === "avspasering") && (
          <AvspaseringSkjema saldo={s} ansattId={ansattId} leder={dialog === "avspasering"} ferdig={ferdig} avbryt={() => settDialog(null)} />
        )}
      </Dialog>
      <Dialog apen={dialog === "juster" || dialog === "utbetal"} lukk={() => settDialog(null)} tittel={dialog === "juster" ? `Juster timebanken for ${s.navn}` : `Utbetal fra timebanken`}>
        {(dialog === "juster" || dialog === "utbetal") && <PostSkjema saldo={s} ansattId={ansattId} type={dialog} ferdig={ferdig} avbryt={() => settDialog(null)} />}
      </Dialog>
    </div>
  );
}

function beskriv(x: Hendelse) {
  switch (x.type) {
    case "overtid":
      return `Overtid ${x.overtid_prosent} % til banken`;
    case "ekstratimer":
      return "Ekstratimer til banken";
    case "avspasering":
      return x.kilde === "fravaer" ? "Avspasering" : "Avspasering (timer)";
    case "utbetaling":
      return "Utbetalt med lønnen";
    default:
      return "Justering";
  }
}

// Søknad om avspasering (den ansatte), eller avspasering lederen registrerer direkte: hele dager
// (fra og med til og med; timene foreslås av de planlagte timene) eller noen timer én dag.
function AvspaseringSkjema({ saldo, ansattId, leder, ferdig, avbryt }: { saldo: Saldo; ansattId: string; leder: boolean; ferdig: (m: string) => void; avbryt: () => void }) {
  const { org } = useKonto();
  const [f, settF] = useState({ hele: true, fra: iDag(), til: iDag(), timer: "", melding: "" });
  const endretForHand = useRef(false);
  const h = useHandling();
  const sett = (e: Partial<typeof f>) => settF((x) => ({ ...x, ...e }));
  const igjen = Math.max(0, saldo.saldo - saldo.sokt);
  // Hele dager: timene foreslås av de planlagte timene i perioden.
  useEffect(() => {
    if (!f.hele || endretForHand.current || !/^\d{4}-\d{2}-\d{2}$/.test(f.fra) || !/^\d{4}-\d{2}-\d{2}$/.test(f.til) || f.til < f.fra) return;
    let aktiv = true;
    hent<{ timer: number }>(`/org/${org!.id}/timebank/forslag?ansatt=${ansattId}&fra=${f.fra}&til=${f.til}`).then(
      (r) => aktiv && !endretForHand.current && sett({ timer: r.timer ? tallformat.format(r.timer) : "" }),
      () => undefined,
    );
    return () => {
      aktiv = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [f.hele, f.fra, f.til, ansattId]);

  const send = (e: FormEvent) => {
    e.preventDefault();
    h.kjor(async () => {
      const t = tall(f.timer);
      if (!(t > 0)) throw new Error("Skriv hvor mange timer");
      const til = f.hele ? f.til : f.fra;
      if (!leder) {
        await api("POST", `/org/${org!.id}/timebank/soknader`, { fra: f.fra, til, timer: t, hele_dager: f.hele, melding: f.melding.trim() || undefined });
        ferdig(`Du har søkt om avspasering ${liten(periode(f.fra, til))} (${timer(t)}). Du får beskjed når lederen har svart.`);
      } else if (f.hele) {
        await api("POST", `/org/${org!.id}/fravaer`, { ansatt_id: ansattId, type: "avspasering", fra: f.fra, til, timer: t, notat: f.melding.trim() || null });
        ferdig(`Avspasering ${liten(periode(f.fra, til))} (${timer(t)}) er registrert for ${saldo.navn}.`);
      } else {
        await api("POST", `/org/${org!.id}/timebank/poster`, { ansatt_id: ansattId, type: "avspasering", dato: f.fra, timer: t, tekst: f.melding.trim() || undefined });
        ferdig(`${timer(t)} avspasering ${liten(visDag(f.fra))} er registrert for ${saldo.navn}.`);
      }
    });
  };

  return (
    <form onSubmit={send}>
      <p className="bytte-vakt">
        {leder ? `${saldo.navn} har` : "Du har"} <strong>{medDager(saldo, saldo.saldo)}</strong> i timebanken
        {saldo.sokt > 0 ? ` (${timer(saldo.sokt)} er søkt om fra før, så ${timer(igjen)} er ledig)` : ""}.
      </p>
      <div className="faner valg" role="radiogroup" aria-label="Hva slags avspasering">
        {(
          [
            [true, "Hele dager"],
            [false, "Noen timer"],
          ] as const
        ).map(([v, t]) => (
          <button
            key={t}
            type="button"
            role="radio"
            aria-checked={f.hele === v}
            className={f.hele === v ? "valgt" : undefined}
            onClick={() => {
              endretForHand.current = false;
              sett({ hele: v, timer: v ? f.timer : "" });
            }}
          >
            {t}
          </button>
        ))}
      </div>
      {f.hele ? (
        <div className="rad">
          <label>
            Fra og med
            <input type="date" required value={f.fra} onChange={(e) => sett({ fra: e.target.value, til: f.til < e.target.value ? e.target.value : f.til })} />
          </label>
          <label>
            Til og med
            <input type="date" required min={f.fra} value={f.til} onChange={(e) => sett({ til: e.target.value })} />
          </label>
        </div>
      ) : (
        <label>
          Dag
          <input type="date" required value={f.fra} onChange={(e) => sett({ fra: e.target.value, til: e.target.value })} />
        </label>
      )}
      <label>
        Timer fra timebanken
        <input
          inputMode="decimal"
          required
          placeholder={f.hele ? "7,5" : "2"}
          value={f.timer}
          onChange={(e) => {
            endretForHand.current = true;
            sett({ timer: e.target.value });
          }}
        />
        <span className="felt-hjelp">
          {f.hele
            ? "Foreslått av de planlagte timene (vakter og faste dager), ellers en vanlig arbeidsdag per dag. Du er borte de dagene i vaktplanen."
            : "F.eks. når du går to timer tidligere. Vakten endres ikke; snakk med lederen om den."}
        </span>
      </label>
      <label>
        {leder ? "Notat" : "Melding til lederen"}
        <input maxLength={300} placeholder="Valgfritt" value={f.melding} onChange={(e) => sett({ melding: e.target.value })} />
      </label>
      {!leder && <p className="felt-hjelp">Avspasering avtales med lederen, og gjelder når søknaden er godkjent.</p>}
      <Feil melding={h.feil} />
      <div className="knapper">
        <button className="primar" disabled={h.opptatt}>
          {leder ? "Registrer" : "Send søknad"}
        </button>
        <button type="button" onClick={avbryt}>
          Avbryt
        </button>
      </div>
    </form>
  );
}

// Justering (pluss eller minus, i timer eller dager, med en grunn) og utbetaling i neste lønnskjøring.
function PostSkjema({ saldo, ansattId, type, ferdig, avbryt }: { saldo: Saldo; ansattId: string; type: "juster" | "utbetal"; ferdig: (m: string) => void; avbryt: () => void }) {
  const { org } = useKonto();
  const [f, settF] = useState({ retning: "pluss" as "pluss" | "minus", mengde: type === "utbetal" ? tallformat.format(Math.max(0, saldo.saldo)) : "", enhet: "timer" as "timer" | "dager", tekst: "" });
  const h = useHandling();
  const sett = (e: Partial<typeof f>) => settF((x) => ({ ...x, ...e }));
  const mengde = tall(f.mengde);
  const timerNa = f.enhet === "dager" && saldo.dag_timer ? Math.round(mengde * saldo.dag_timer * 100) / 100 : mengde;
  const send = (e: FormEvent) => {
    e.preventDefault();
    h.kjor(async () => {
      if (!(timerNa > 0)) throw new Error("Skriv antall timer");
      if (type === "juster") {
        const t = f.retning === "pluss" ? timerNa : -timerNa;
        await api("POST", `/org/${org!.id}/timebank/poster`, { ansatt_id: ansattId, type: "justering", timer: t, tekst: f.tekst.trim() });
        ferdig(`Timebanken er justert (${fortegn(t)}). ${saldo.navn.split(" ")[0]} får beskjed.`);
      } else {
        await api("POST", `/org/${org!.id}/timebank/poster`, { ansatt_id: ansattId, type: "utbetaling", timer: timerNa, tekst: f.tekst.trim() || undefined });
        ferdig(`${timer(timerNa)} utbetales i neste lønnskjøring og er trukket fra timebanken.`);
      }
    });
  };
  return (
    <form onSubmit={send}>
      <p className="bytte-vakt">
        {saldo.navn} har <strong>{medDager(saldo, saldo.saldo)}</strong> i timebanken.
      </p>
      {type === "juster" && (
        <div className="faner valg" role="radiogroup" aria-label="Legg til eller trekk fra">
          {(
            [
              ["pluss", "Legg til"],
              ["minus", "Trekk fra"],
            ] as const
          ).map(([v, t]) => (
            <button key={v} type="button" role="radio" aria-checked={f.retning === v} className={f.retning === v ? "valgt" : undefined} onClick={() => sett({ retning: v })}>
              {t}
            </button>
          ))}
        </div>
      )}
      <div className="rad">
        <label>
          {type === "juster" ? "Antall" : "Timer som utbetales"}
          <input inputMode="decimal" required value={f.mengde} onChange={(e) => sett({ mengde: e.target.value })} />
        </label>
        {type === "juster" && saldo.dag_timer ? (
          <label>
            Enhet
            <select value={f.enhet} onChange={(e) => sett({ enhet: e.target.value as "timer" | "dager" })}>
              <option value="timer">Timer</option>
              <option value="dager">Dager (à {timer(saldo.dag_timer)})</option>
            </select>
          </label>
        ) : null}
      </div>
      {f.enhet === "dager" && mengde > 0 && <p className="felt-hjelp">= {timer(timerNa)}</p>}
      <label>
        {type === "juster" ? "Hvorfor" : "Tekst (valgfri)"}
        <input
          maxLength={300}
          required={type === "juster"}
          placeholder={type === "juster" ? "F.eks. jobbet 1. mai, eller saldoen fra før" : "Valgfritt"}
          value={f.tekst}
          onChange={(e) => sett({ tekst: e.target.value })}
        />
      </label>
      <p className="felt-hjelp">
        {type === "juster"
          ? "Justeringen påvirker ikke lønnen. Den ansatte ser den i historikken og får beskjed."
          : `Utbetales i neste lønnskjøring med ${saldo.lonnstype === "time" ? "timelønnen" : "timesatsen"}${saldo.sats != null ? ` (${kr(saldo.sats)} per time)` : ""}, og trekkes fra timebanken nå.`}
      </p>
      <Feil melding={h.feil} />
      <div className="knapper">
        <button className="primar" disabled={h.opptatt}>
          {type === "juster" ? "Juster" : "Utbetal"}
        </button>
        <button type="button" onClick={avbryt}>
          Avbryt
        </button>
      </div>
    </form>
  );
}
