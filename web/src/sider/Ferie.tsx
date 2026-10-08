// Feriebank (0050_feriebank.sql): feriedagene hver ansatt har i året, hvor mange som er avviklet
// og planlagt (regnet av ferien som er registrert som fravær, så banken justeres av seg selv) og
// hvor mange som er igjen. Den ansatte søker om å overføre dager til neste år; eier og
// administrator godkjenner eller avslår. Eier og administrator ser alle, den ansatte seg selv.
import { useState, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { api, hent } from "../api";
import { Dialog, Feil, Laster, tall, useData, useHandling, useSmal } from "../felles";
import { erAdmin, useKonto } from "../konto";
import { dato, iDag } from "../format";
import { IkonHoyre, IkonVenstre } from "../ikoner";
import { FravaerDialog, fravaerPeriode, type Fravaer } from "./Fravaer";

export interface Saldo {
  ansatt_id: string;
  navn: string;
  aktiv: boolean;
  dager_per_uke: number;
  rett: number;
  egen_rett: boolean;
  ekstra_60: boolean;
  sen_start: boolean;
  overfort_inn: number;
  overfort_ut: number;
  avviklet: number;
  planlagt: number;
  igjen: number;
  venter: number;
}
interface Overforing {
  id: string;
  ansatt_id: string;
  ansatt_navn: string;
  fra_aar: number;
  dager: number;
  begrunnelse: string | null;
  status: "venter" | "godkjent" | "avslatt";
  svar: string | null;
  opprettet: string;
  behandlet_at: string | null;
  behandlet_av_navn: string | null;
  min: boolean;
}
interface Periode {
  id: string;
  fra: string;
  til: string;
  notat: string | null;
  dager: number;
  avviklet: number;
}
export interface Detaljer {
  aar: number;
  saldo: Saldo;
  perioder: Periode[];
  overforinger: Overforing[];
}

// «12» og «12,5».
export const dagerTekst = (n: number) => String(Math.round(n * 10) / 10).replace(".", ",");
const dagerOrd = (n: number) => `${dagerTekst(n)} ${Math.abs(n) === 1 ? "dag" : "dager"}`;
const statusTekst = { venter: "Venter", godkjent: "Godkjent", avslatt: "Avslått" } as const;
const statusKlasse = { venter: "merke-advarsel", godkjent: "merke-ok", avslatt: "merke-noytral" } as const;
const iAar = () => Number(iDag().slice(0, 4));

function Aarsvelger({ aar, velg }: { aar: number; velg: (aar: number) => void }) {
  return (
    <div className="ukevelger">
      <button type="button" className="ikon" aria-label="Forrige år" title="Forrige år" onClick={() => velg(aar - 1)}>
        <IkonVenstre storrelse={20} />
      </button>
      <div className="uke-navn" aria-live="polite">
        <strong>{aar}</strong>
        <span>Ferieåret</span>
      </div>
      <button type="button" className="ikon" aria-label="Neste år" title="Neste år" onClick={() => velg(aar + 1)}>
        <IkonHoyre storrelse={20} />
      </button>
      {aar !== iAar() && (
        <button type="button" className="lenke" onClick={() => velg(iAar())}>
          I år
        </button>
      )}
    </div>
  );
}

export function Ferie() {
  const { org } = useKonto();
  const [sok, settSok] = useSearchParams();
  const aar = Number(sok.get("aar")) || iAar();
  const velg = (a: number) => settSok(a === iAar() ? {} : { aar: String(a) }, { replace: true });
  return erAdmin(org?.rolle) ? <Ferieoversikt aar={aar} velg={velg} /> : <MinFerie aar={aar} velg={velg} />;
}

// --- Eier og administrator: alle ansatte og søknadene --------------------------------------

function Ferieoversikt({ aar, velg }: { aar: number; velg: (aar: number) => void }) {
  const { org } = useKonto();
  const smal = useSmal();
  const [versjon, settVersjon] = useState(0);
  const bank = useData(() => hent<Saldo[]>(`/org/${org!.id}/feriebank?aar=${aar}`), [org?.id, aar, versjon]);
  const soknader = useData(() => hent<Overforing[]>(`/org/${org!.id}/ferie/overforinger?status=venter`), [org?.id, versjon]);
  const [valgt, settValgt] = useState<Saldo | null>(null);
  const [melding, settMelding] = useState<string | null>(null);
  const oppdater = () => settVersjon((v) => v + 1);

  return (
    <>
      <div className="topp">
        <h1>Ferie</h1>
        <Aarsvelger aar={aar} velg={velg} />
      </div>
      <p className="undertittel">
        Feriedagene til hver ansatt, hva som er avviklet og planlagt, og hva som er igjen. Ferie registreres som fravær, og banken oppdateres av seg selv.
      </p>
      {melding && (
        <div className="melding ok" role="status">
          {melding}
        </div>
      )}
      {soknader.data && soknader.data.length > 0 && (
        <Soknader
          soknader={soknader.data}
          behandlet={(m) => {
            settMelding(m);
            oppdater();
          }}
        />
      )}
      {bank.feil ? (
        <Feil melding={bank.feil} />
      ) : !bank.data ? (
        <Laster />
      ) : !bank.data.length ? (
        <p className="dempet">Ingen ansatte i {aar}.</p>
      ) : smal ? (
        <div className="kort liste">
          {bank.data.map((s) => (
            <button key={s.ansatt_id} type="button" className="liste-rad" onClick={() => settValgt(s)}>
              <span className="linje">
                <span className="tittel">{s.navn}</span>
                <span className={`belop${s.igjen < 0 ? " ferie-minus" : ""}`}>{dagerOrd(s.igjen)} igjen</span>
              </span>
              <span className="linje">
                <span className="under">
                  {dagerTekst(s.rett + s.overfort_inn)} i år · {dagerTekst(s.avviklet)} avviklet{s.planlagt ? ` · ${dagerTekst(s.planlagt)} planlagt` : ""}
                </span>
                {s.venter > 0 && <span className="merke merke-advarsel">Søknad</span>}
              </span>
            </button>
          ))}
        </div>
      ) : (
        <div className="kort tabell">
          <table>
            <thead>
              <tr>
                <th>Ansatt</th>
                <th className="hoyre">Rett</th>
                <th className="hoyre">Fra i fjor</th>
                <th className="hoyre">Avviklet</th>
                <th className="hoyre">Planlagt</th>
                <th className="hoyre">Til neste år</th>
                <th className="hoyre">Igjen</th>
              </tr>
            </thead>
            <tbody>
              {bank.data.map((s) => (
                <tr key={s.ansatt_id} className="klikkbar" onClick={() => settValgt(s)}>
                  <td>
                    {s.navn}
                    {!s.aktiv && <span className="merke merke-noytral ferie-merke">Sluttet</span>}
                    {s.venter > 0 && <span className="merke merke-advarsel ferie-merke">Søknad</span>}
                  </td>
                  <td className="tall">{dagerTekst(s.rett)}</td>
                  <td className="tall">{s.overfort_inn ? dagerTekst(s.overfort_inn) : "–"}</td>
                  <td className="tall">{dagerTekst(s.avviklet)}</td>
                  <td className="tall">{s.planlagt ? dagerTekst(s.planlagt) : "–"}</td>
                  <td className="tall">{s.overfort_ut ? dagerTekst(s.overfort_ut) : "–"}</td>
                  <td className={`tall sterk${s.igjen < 0 ? " ferie-minus" : ""}`}>{dagerTekst(s.igjen)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="liten dempet">
        Dagene telles i arbeidsdager: de faste dagene i arbeidsplanen (ellers mandag til fredag), uten helligdager. Feriedagene per år står under Innstillinger → Ansatte
        og timer, og kan settes for den enkelte ansatte. Fra året en ansatt fyller 60, kommer en uke ekstra (ferieloven § 5).
      </p>
      <Dialog bred apen={!!valgt} lukk={() => settValgt(null)} tittel={valgt ? `Ferie for ${valgt.navn} i ${aar}` : "Ferie"}>
        {valgt && <AnsattFerie ansattId={valgt.ansatt_id} aar={aar} leder endret={oppdater} />}
      </Dialog>
    </>
  );
}

// Søknadene som venter, med godkjenning og avslag (med et valgfritt svar til den ansatte).
function Soknader({ soknader, behandlet }: { soknader: Overforing[]; behandlet: (melding: string) => void }) {
  const { org } = useKonto();
  const [svar, settSvar] = useState<Record<string, string>>({});
  const h = useHandling();
  async function behandle(o: Overforing, godkjent: boolean) {
    const r = await h.kjor(() => api("POST", `/org/${org!.id}/ferie/overforinger/${o.id}/behandle`, { godkjent, svar: svar[o.id]?.trim() || null }));
    if (r) behandlet(`${godkjent ? "Godkjent" : "Avslått"}: ${o.ansatt_navn}, ${dagerOrd(o.dager)} fra ${o.fra_aar} til ${o.fra_aar + 1}. ${o.ansatt_navn.split(" ")[0]} har fått beskjed.`);
  }
  return (
    <section className="kort ferie-soknader">
      <h2>Søknader om å overføre ferie</h2>
      <Feil melding={h.feil} />
      <ul>
        {soknader.map((o) => (
          <li key={o.id}>
            <div className="ferie-soknad-tekst">
              <strong>{o.ansatt_navn}</strong> vil overføre {dagerOrd(o.dager)} fra {o.fra_aar} til {o.fra_aar + 1}.
              {o.begrunnelse && <span className="dempet"> «{o.begrunnelse}»</span>}
              <div className="liten dempet">Søkt {dato(o.opprettet)}</div>
            </div>
            <input
              aria-label={`Svar til ${o.ansatt_navn} (valgfritt)`}
              placeholder="Svar (valgfritt)"
              maxLength={500}
              value={svar[o.id] ?? ""}
              onChange={(e) => settSvar({ ...svar, [o.id]: e.target.value })}
            />
            <div className="knapper">
              <button type="button" className="primar" disabled={h.opptatt} onClick={() => behandle(o, true)}>
                Godkjenn
              </button>
              <button type="button" disabled={h.opptatt} onClick={() => behandle(o, false)}>
                Avslå
              </button>
            </div>
          </li>
        ))}
      </ul>
      <p className="liten dempet">Ferieloven § 7: inntil to uker (12 virkedager) kan overføres etter skriftlig avtale. En godkjent søknad er avtalen.</p>
    </section>
  );
}

// --- Den ansatte: sin egen ferie ---------------------------------------------------------

function MinFerie({ aar, velg }: { aar: number; velg: (aar: number) => void }) {
  const { org } = useKonto();
  return (
    <>
      <div className="topp">
        <h1>Min ferie</h1>
        <Aarsvelger aar={aar} velg={velg} />
      </div>
      {org?.ansatt_id ? (
        <div className="kort">
          <AnsattFerie ansattId={org.ansatt_id} aar={aar} />
        </div>
      ) : (
        <p className="dempet">Du er ikke registrert som ansatt i {org?.navn}.</p>
      )}
    </>
  );
}

// --- Én ansatt: saldoen, ferien og overføringene ----------------------------------------------

export function AnsattFerie({ ansattId, aar, leder, endret }: { ansattId: string; aar: number; leder?: boolean; endret?: () => void }) {
  const { org } = useKonto();
  const [versjon, settVersjon] = useState(0);
  const d = useData(() => hent<Detaljer>(`/org/${org!.id}/feriebank/${ansattId}?aar=${aar}`), [org?.id, ansattId, aar, versjon]);
  const [fravaer, settFravaer] = useState<Partial<Fravaer> | null>(null);
  const [melding, settMelding] = useState<string | null>(null);
  const oppdater = (m?: string) => {
    if (m) settMelding(m);
    settVersjon((v) => v + 1);
    endret?.();
  };

  if (d.feil) return <p className="dempet">{d.feil.startsWith("Fant ikke") ? `Ingen feriebank for ${aar}.` : d.feil}</p>;
  if (!d.data) return <Laster />;
  const { saldo: s, perioder, overforinger } = d.data;
  const rettNotat = [
    s.egen_rett ? "satt for den ansatte" : null,
    !s.egen_rett && s.dager_per_uke !== 5 ? `${s.dager_per_uke} arbeidsdager i uka` : null,
    !s.egen_rett && s.ekstra_60 ? "med en uke ekstra fra 60 år" : null,
    !s.egen_rett && s.sen_start ? "én uke: begynte etter 30. september" : null,
  ].filter(Boolean);

  return (
    <div className="ansatt-ferie">
      {melding && (
        <div className="melding ok" role="status">
          {melding}
        </div>
      )}
      <div className="ferie-saldo">
        <div>
          <span>Feriedager</span>
          <strong>{dagerTekst(s.rett)}</strong>
          {rettNotat.length > 0 && <small>{rettNotat.join(", ")}</small>}
        </div>
        {s.overfort_inn > 0 && (
          <div>
            <span>Fra {aar - 1}</span>
            <strong>+{dagerTekst(s.overfort_inn)}</strong>
          </div>
        )}
        <div>
          <span>Avviklet</span>
          <strong>{dagerTekst(s.avviklet)}</strong>
        </div>
        <div>
          <span>Planlagt</span>
          <strong>{dagerTekst(s.planlagt)}</strong>
        </div>
        {s.overfort_ut > 0 && (
          <div>
            <span>Til {aar + 1}</span>
            <strong>−{dagerTekst(s.overfort_ut)}</strong>
          </div>
        )}
        <div className={`ferie-igjen${s.igjen < 0 ? " ferie-minus" : ""}`}>
          <span>Igjen</span>
          <strong>{dagerTekst(s.igjen)}</strong>
          {s.igjen < 0 && <small>{dagerOrd(-s.igjen)} for mye</small>}
        </div>
      </div>

      <h3>Ferie i {aar}</h3>
      {perioder.length ? (
        <ul className="ferie-perioder">
          {perioder.map((p) => (
            <li key={p.id}>
              {leder ? (
                <button type="button" className="lenke" onClick={() => settFravaer({ id: p.id, ansatt_id: ansattId, ansatt_navn: s.navn, type: "ferie", fra: p.fra, til: p.til, notat: p.notat })}>
                  {fravaerPeriode(p)}
                </button>
              ) : (
                <span>{fravaerPeriode(p)}</span>
              )}
              <span className="dempet">
                {dagerOrd(p.dager)}
                {p.avviklet === p.dager ? ", avviklet" : p.avviklet > 0 ? `, ${dagerTekst(p.avviklet)} avviklet` : ", planlagt"}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="dempet liten">Ingen ferie registrert i {aar}.</p>
      )}
      {leder && (
        <button type="button" onClick={() => settFravaer({ ansatt_id: ansattId, type: "ferie", fra: iDag() < `${aar}-01-01` || iDag() > `${aar}-12-31` ? `${aar}-07-01` : iDag() })}>
          Registrer ferie
        </button>
      )}

      <h3>Overføring til neste år</h3>
      {overforinger.length > 0 && (
        <ul className="ferie-overforinger">
          {overforinger.map((o) => (
            <OverforingRad key={o.id} o={o} aar={aar} leder={leder} endret={oppdater} />
          ))}
        </ul>
      )}
      <Overfor saldo={s} aar={aar} leder={leder} ferdig={oppdater} />

      <FravaerDialog
        fravaer={fravaer}
        lukk={() => settFravaer(null)}
        ferdig={(m) => {
          settFravaer(null);
          oppdater(m);
        }}
      />
    </div>
  );
}

function OverforingRad({ o, aar, leder, endret }: { o: Overforing; aar: number; leder?: boolean; endret: (m?: string) => void }) {
  const { org } = useKonto();
  const h = useHandling();
  const inn = o.fra_aar === aar - 1;
  async function trekk() {
    if (!confirm(o.status === "godkjent" ? "Angre overføringen? Dagene går tilbake til året de kom fra." : "Trekke søknaden?")) return;
    const r = await h.kjor(async () => (await api("DELETE", `/org/${org!.id}/ferie/overforinger/${o.id}`), true));
    if (r) endret(o.status === "godkjent" ? "Overføringen er angret." : "Søknaden er trukket.");
  }
  return (
    <li>
      <span className={`merke ${statusKlasse[o.status]}`}>{statusTekst[o.status]}</span>
      <span>
        {dagerOrd(o.dager)} {inn ? `fra ${o.fra_aar}` : `til ${o.fra_aar + 1}`}
        {o.begrunnelse && <span className="dempet"> · «{o.begrunnelse}»</span>}
        {o.svar && <span className="dempet"> · Svar: «{o.svar}»</span>}
        {o.behandlet_av_navn && o.status !== "venter" && <span className="dempet liten"> · {o.behandlet_av_navn}</span>}
      </span>
      {(leder || (o.status === "venter" && o.min)) && !inn && (
        <button type="button" className="lenke" disabled={h.opptatt} onClick={trekk}>
          {o.status === "venter" && !leder ? "Trekk" : o.status === "godkjent" ? "Angre" : "Slett"}
        </button>
      )}
      <Feil melding={h.feil} />
    </li>
  );
}

// Den ansatte søker om å overføre dager; eier og administrator overfører med en gang.
function Overfor({ saldo, aar, leder, ferdig }: { saldo: Saldo; aar: number; leder?: boolean; ferdig: (m: string) => void }) {
  const { org } = useKonto();
  const [apen, settApen] = useState(false);
  const [dager, settDager] = useState("");
  const [begrunnelse, settBegrunnelse] = useState("");
  const h = useHandling();
  const ledig = saldo.igjen - saldo.venter;
  // Den ansatte søker for i år, eller for i fjor (i starten av året).
  const kanSoke = leder || aar === iAar() || aar === iAar() - 1;
  const toUker = 2 * saldo.dager_per_uke;

  async function send(e: FormEvent) {
    e.preventDefault();
    const n = tall(dager);
    if (!(n > 0) || !Number.isInteger(n * 2)) return h.settFeil("Skriv hvor mange dager (hele eller halve).");
    const r = await h.kjor(() =>
      api("POST", `/org/${org!.id}/ferie/overforinger`, {
        ...(leder ? { ansatt_id: saldo.ansatt_id, godkjent: true } : {}),
        fra_aar: aar,
        dager: n,
        begrunnelse: begrunnelse.trim() || null,
      }),
    );
    if (!r) return;
    settApen(false);
    settDager("");
    settBegrunnelse("");
    ferdig(leder ? `${dagerOrd(n)} er overført til ${aar + 1}.` : `Søknaden om å overføre ${dagerOrd(n)} til ${aar + 1} er sendt. Du får beskjed når den er behandlet.`);
  }

  if (!kanSoke) return null;
  if (ledig <= 0) return <p className="dempet liten">Ingen feriedager igjen å overføre fra {aar}.</p>;
  if (!apen)
    return (
      <button type="button" onClick={() => settApen(true)}>
        {leder ? `Overfør dager til ${aar + 1}` : `Søk om å overføre ferie til ${aar + 1}`}
      </button>
    );
  return (
    <form className="ferie-overfor" onSubmit={send}>
      <div className="rad">
        <label>
          Antall dager
          <input inputMode="decimal" autoFocus required value={dager} placeholder={`Høyst ${dagerTekst(ledig)}`} onChange={(e) => settDager(e.target.value)} />
          <span className="felt-hjelp">
            {dagerOrd(ledig)} igjen{saldo.venter > 0 ? ` (etter søknader som venter)` : ""}.
            {tall(dager) > toUker && ` Ferieloven tillater å overføre inntil to uker (${dagerTekst(toUker)} dager), i tillegg til avtalt ferie utover loven.`}
          </span>
        </label>
        <label className="hel">
          {leder ? "Notat (valgfritt)" : "Begrunnelse (valgfritt)"}
          <input maxLength={500} value={begrunnelse} placeholder={leder ? "F.eks. avtalt i medarbeidersamtalen" : "F.eks. mye å gjøre i høst"} onChange={(e) => settBegrunnelse(e.target.value)} />
        </label>
      </div>
      <Feil melding={h.feil} />
      <div className="knapper">
        <button className="primar" disabled={h.opptatt}>
          {leder ? "Overfør" : "Send søknad"}
        </button>
        <button type="button" onClick={() => settApen(false)}>
          Avbryt
        </button>
      </div>
      {!leder && <p className="liten dempet">Eier eller administrator godkjenner søknaden. Godkjent er den den skriftlige avtalen ferieloven krever.</p>}
    </form>
  );
}
