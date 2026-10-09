// Sykepenger og NAV (server/src/navRuter.ts): fanen «Sykepenger» under Lønn. Om hentingen fra NAV
// er slått på og tilgangen gitt, NAVs forespørsler om inntektsmelding med inntektsmeldingen appen
// foreslår (arbeidsgiverperioden, inntekten og refusjonskravet), som kan rettes før den sendes, og
// sykmeldingene fra NAV. En forespørsel som er åpen, står i adressen (?foresporsel=).
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, hent } from "../api";
import { Feil, Laster, Tom, tall, useData, useHandling, useSmal } from "../felles";
import { erAdmin, useKonto } from "../konto";
import { dato, kr } from "../format";
import { IkonVenstre } from "../ikoner";

type Periode = { fom: string; tom: string };
type Status = {
  pa: boolean;
  refusjon: boolean;
  tilgang: boolean;
  pakke: string;
  virksomhet: string | null;
  miljo: "test" | "prod";
  henting: { type: "sykmelding" | "forespoersel"; virksomhet_orgnr: string; sist_hentet: string | null; siste_feil: string | null }[];
};
type Sykmeldingsperiode = Periode & { grad: number; type: "full" | "gradert" | "avventende" | "behandlingsdager" | "reisetilskudd" };
type Sykmelding = {
  id: string;
  ansatt_id: string | null;
  navn: string;
  sykefravaer_fom: string | null;
  mottatt_av_nav: string | null;
  perioder: Sykmeldingsperiode[];
  egenmeldingsdager: Periode[];
  melding_til_arbeidsgiver: string | null;
  tiltak_arbeidsplassen: string | null;
  behandler: string | null;
  merknader: string[];
  fravaer: number;
  hentet: string;
};
type Data = {
  sykmeldingsperioder?: Periode[];
  egenmeldingsperioder?: Periode[];
  inntektsdato?: string | null;
  arbeidsgiverperiodePaakrevd?: boolean;
  inntektPaakrevd?: boolean;
  opprettetTid?: string | null;
};
type ImStatus = "sender" | "sendt" | "godkjent" | "avvist" | "feil";
type Foresporsel = {
  id: string;
  ansatt_id: string | null;
  navn: string | null;
  status: "AKTIV" | "BESVART" | "FORKASTET";
  data: Data;
  opprettet: string;
  inntektsmelding: { id: string; status: ImStatus; feil: string | null; sendt_at: string | null; opprettet: string } | null;
};
type Aarsak = { aarsak: string; gjelderFra?: string; bleKjent?: string; ferier?: Periode[]; permisjoner?: Periode[]; permitteringer?: Periode[]; sykefravaer?: Periode[] };
type Innhold = {
  agp: { perioder: Periode[]; redusertLoennIAgp: { beloep: number; begrunnelse: string } | null } | null;
  inntekt: { beloep: number; inntektsdato: string; endringAarsaker: Aarsak[] } | null;
  refusjon: { beloepPerMaaned: number; endringer: { beloep: number; startdato: string }[] } | null;
  naturalytelser: { naturalytelse: string; verdiBeloep: number; sluttdato: string }[];
  kontaktinformasjon: string;
  arbeidsgiverTlf: string;
};
type Forslag = {
  aarsak: "Ny" | "Endring" | null;
  innhold: Innhold;
  grunnlag: {
    fravaer: (Periode & { kilde: "nav" | "appen" })[];
    agp_dager: number;
    maaneder: { maaned: string; lonn: number; nav: number | null }[];
    snitt_lonn: number;
    snitt_nav: number | null;
    maanedslonn: number | null;
    seks_g: number;
    refusjon: boolean;
    endringsaarsaker: { aarsak: string; tekst: string; forslag: Aarsak }[];
  };
  merknader: string[];
};
type Koder = {
  begrunnelser: Record<string, string>;
  naturalytelser: Record<string, string>;
  endringsaarsaker: Record<string, { navn: string; felt: "ingen" | "gjelderFra" | "tariff" | "ferier" | "permisjoner" | "permitteringer" | "sykefravaer" }>;
};
type Detalj = Foresporsel & {
  forslag: Forslag | null;
  koder: Koder;
  inntektsmeldinger: { id: string; status: ImStatus; innhold: Innhold; feil: string | null; opprettet: string; sendt_at: string | null }[];
};

const FORESPORSEL: Record<Foresporsel["status"], [string, string]> = {
  AKTIV: ["Venter på inntektsmelding", "merke-advarsel"],
  BESVART: ["Besvart", "merke-ok"],
  FORKASTET: ["Trukket tilbake", "merke-noytral"],
};
const INNTEKTSMELDING: Record<ImStatus, [string, string]> = {
  sender: ["Sendes", "merke-noytral"],
  sendt: ["Sendt, NAV kontrollerer", "merke-noytral"],
  godkjent: ["Godkjent av NAV", "merke-ok"],
  avvist: ["Avvist av NAV", "merke-fare"],
  feil: ["Ikke sendt", "merke-fare"],
};
const PERIODETYPE: Record<Sykmeldingsperiode["type"], string> = {
  full: "100 %",
  gradert: "gradert",
  avventende: "avventende",
  behandlingsdager: "behandlingsdager",
  reisetilskudd: "reisetilskudd",
};
const periode = (p: Periode) => (p.fom === p.tom ? dato(p.fom) : `${dato(p.fom)}–${dato(p.tom)}`);
const perioder = (p: Periode[] | undefined) => (p?.length ? p.map(periode).join(", ") : "–");
const dager = (p: Periode[]) => p.reduce((s, x) => s + Math.round((Date.parse(`${x.tom}T12:00:00Z`) - Date.parse(`${x.fom}T12:00:00Z`)) / 86_400_000) + 1, 0);
const tid = (iso: string) => {
  const d = new Date(iso);
  return `${dato(new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Oslo" }).format(d))} kl. ${new Intl.DateTimeFormat("nb-NO", { timeZone: "Europe/Oslo", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d).replace(":", ".")}`;
};
const maanedNavn = (m: string) => new Date(`${m}-15T12:00:00Z`).toLocaleDateString("nb-NO", { month: "long", year: "numeric", timeZone: "UTC" });
const belopTekst = (n: number) => String(n).replace(".", ",");
const merke = ([t, k]: [string, string]) => <span className={`merke ${k}`}>{t}</span>;

export function Sykepenger() {
  const [sok, settSok] = useSearchParams();
  const id = sok.get("foresporsel");
  const sett = (endring: Record<string, string | null>) => {
    const p = new URLSearchParams(sok);
    for (const [k, v] of Object.entries(endring)) {
      if (v === null) p.delete(k);
      else p.set(k, v);
    }
    settSok(p);
  };
  if (id) return <ForesporselSide id={id} tilbake={() => sett({ foresporsel: null })} />;
  return <Oversikt apne={(f) => sett({ foresporsel: f })} />;
}

// --- Oversikten -------------------------------------------------------------------------------

function Oversikt({ apne }: { apne: (id: string) => void }) {
  const { org } = useKonto();
  const admin = erAdmin(org?.rolle);
  const sti = `/org/${org!.id}/nav`;
  const status = useData(() => hent<Status>(sti), [sti], { oppdater: true });
  const foresporsler = useData(() => hent<Foresporsel[]>(`${sti}/forespoersler`), [sti], { oppdater: true });
  const sykmeldinger = useData(() => hent<Sykmelding[]>(`${sti}/sykmeldinger`), [sti], { oppdater: true });
  const h = useHandling();
  const [hentet, settHentet] = useState(false);
  const smal = useSmal();

  if (status.feil) return <Feil melding={status.feil} />;
  if (!status.data) return <Laster />;
  const s = status.data;
  const klar = s.pa && s.tilgang && !!s.virksomhet;
  const hentNa = async () => {
    settHentet(false);
    if (await h.kjor(() => api("POST", `${sti}/hent`))) {
      settHentet(true);
      window.setTimeout(() => {
        void status.last();
        void foresporsler.last();
        void sykmeldinger.last();
      }, 4000);
    }
  };
  const sist = s.henting.map((x) => x.sist_hentet).filter((x): x is string => !!x).sort().at(-1);
  const feil = [...new Set(s.henting.map((x) => x.siste_feil).filter((x): x is string => !!x))];

  return (
    <>
      <p className="undertittel">
        Sykmeldingene NAV sender dere, gir sykefravær (gradert når sykmeldingen er det), og NAVs forespørsler om inntektsmelding besvares her: arbeidsgiverperioden,
        inntekten og refusjonskravet.{" "}
        {s.refusjon ? "Dere betaler lønnen under sykdom og krever refusjon fra NAV" : "NAV betaler sykepengene etter arbeidsgiverperioden til den ansatte"} (
        <Link to="/innstillinger?fane=personal#lonn">endre</Link>).
        {s.pa && s.miljo === "test" && <span className="merke merke-noytral lonn-merke">Testmiljø</span>}
      </p>

      <section className="kort">
        <h3 style={{ marginTop: 0 }}>Koblingen til NAV</h3>
        {!s.pa ? (
          <p className="liten">
            Hentingen fra NAV er ikke slått på ennå. Til den er det, sendes inntektsmeldingen på{" "}
            <a href="https://www.nav.no/arbeidsgiver/inntektsmelding" target="_blank" rel="noreferrer">
              nav.no (Min side – arbeidsgiver)
            </a>
            , og fraværet registreres under Fravær.
          </p>
        ) : !s.tilgang ? (
          <p className="liten">
            Gi HI4 Faktura tilgang hos NAV i Altinn: tilgangspakken «{s.pakke}». Trykk «Utvid tilgangen i Altinn» under{" "}
            <Link to="/innstillinger?fane=personal#skattekort">Innstillinger → Ansatte og timer</Link>, og la daglig leder godkjenne i Altinn.
          </p>
        ) : !s.virksomhet ? (
          <p className="liten">
            Legg inn virksomheten (underenheten der de ansatte jobber) under <Link to="/innstillinger?fane=personal#lonn">Innstillinger → Ansatte og timer → A-melding</Link>.
          </p>
        ) : (
          <p className="liten">
            Sykmeldinger og forespørsler hentes fra NAV hver time{sist ? `, sist ${tid(sist)}` : ""}.
          </p>
        )}
        {feil.map((f) => (
          <div key={f} className="melding feil">
            Hentingen feilet: {f}
          </div>
        ))}
        <Feil melding={h.feil} />
        {hentet && (
          <div className="melding ok" role="status">
            Hentes fra NAV nå.
          </div>
        )}
        {klar && admin && (
          <div className="knapper">
            <button type="button" disabled={h.opptatt} onClick={() => void hentNa()}>
              Hent nå
            </button>
          </div>
        )}
      </section>

      <h3 className="lonn-under">Forespørsler om inntektsmelding</h3>
      {foresporsler.feil ? (
        <Feil melding={foresporsler.feil} />
      ) : !foresporsler.data ? (
        <Laster />
      ) : !foresporsler.data.length ? (
        <div className="kort">
          <Tom tittel="Ingen forespørsler">
            <p>NAV ber om inntektsmelding når en ansatt er sykmeldt mer enn 16 dager og har søkt om sykepenger.</p>
          </Tom>
        </div>
      ) : smal ? (
        <div className="kort liste">
          {foresporsler.data.map((f) => (
            <button key={f.id} type="button" className="liste-rad" onClick={() => apne(f.id)}>
              <span className="linje">
                <span className="tittel">{f.navn ?? "Ukjent ansatt"}</span>
                {f.inntektsmelding && f.status !== "FORKASTET" ? merke(INNTEKTSMELDING[f.inntektsmelding.status]) : merke(FORESPORSEL[f.status])}
              </span>
              <span className="linje">
                <span className="under">Sykmeldt {perioder(f.data.sykmeldingsperioder)}</span>
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
                <th>Sykmeldt</th>
                <th>Fra NAV</th>
                <th>Forespørselen</th>
                <th>Inntektsmeldingen</th>
              </tr>
            </thead>
            <tbody>
              {foresporsler.data.map((f) => (
                <tr key={f.id} className="klikkbar" onClick={() => apne(f.id)}>
                  <td>
                    <strong>{f.navn ?? "Ukjent ansatt"}</strong>
                  </td>
                  <td>{perioder(f.data.sykmeldingsperioder)}</td>
                  <td>{dato(f.opprettet.slice(0, 10))}</td>
                  <td>{merke(FORESPORSEL[f.status])}</td>
                  <td>{f.inntektsmelding ? merke(INNTEKTSMELDING[f.inntektsmelding.status]) : <span className="dempet liten">Ikke sendt</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h3 className="lonn-under">Sykmeldinger fra NAV</h3>
      {sykmeldinger.feil ? (
        <Feil melding={sykmeldinger.feil} />
      ) : !sykmeldinger.data ? (
        <Laster />
      ) : !sykmeldinger.data.length ? (
        <div className="kort">
          <Tom tittel="Ingen sykmeldinger">
            <p>Sykmeldingene den ansatte sender til dere i NAV, kommer hit og blir sykefravær.</p>
          </Tom>
        </div>
      ) : (
        <div className="kort liste nav-sykmeldinger">
          {sykmeldinger.data.map((m) => (
            <SykmeldingRad key={m.id} m={m} />
          ))}
        </div>
      )}
    </>
  );
}

function SykmeldingRad({ m }: { m: Sykmelding }) {
  const [apen, settApen] = useState(false);
  return (
    <div className="liste-rad nav-sykmelding">
      <button type="button" className="nav-sykmelding-topp" onClick={() => settApen(!apen)} aria-expanded={apen}>
        <span className="linje">
          <span className="tittel">{m.navn}</span>
          {m.merknader.length > 0 && <span className="merke merke-advarsel">Se merknad</span>}
        </span>
        <span className="linje">
          <span className="under">
            {m.perioder.map((p) => `${periode(p)} (${p.type === "gradert" ? `${p.grad} %` : PERIODETYPE[p.type]})`).join(", ") || "Uten perioder"}
            {m.fravaer > 0 ? ` · fravær registrert` : ""}
          </span>
        </span>
      </button>
      {apen && (
        <div className="nav-sykmelding-detalj liten">
          {m.merknader.map((x) => (
            <div key={x} className="melding info">
              {x}
            </div>
          ))}
          {m.egenmeldingsdager.length > 0 && <p>Egenmeldingsdager før sykmeldingen: {perioder(m.egenmeldingsdager)}.</p>}
          {m.melding_til_arbeidsgiver && <p>Melding til arbeidsgiveren: {m.melding_til_arbeidsgiver}</p>}
          {m.tiltak_arbeidsplassen && <p>Tiltak på arbeidsplassen: {m.tiltak_arbeidsplassen}</p>}
          {m.behandler && <p className="dempet">Behandler: {m.behandler}</p>}
          <p className="dempet">
            Sykefraværet begynte {dato(m.sykefravaer_fom)}. Hentet {tid(m.hentet)}.
            {m.fravaer > 0 && (
              <>
                {" "}
                <Link to="/vakter?fane=fravaer">Se fraværet</Link>
              </>
            )}
          </p>
        </div>
      )}
    </div>
  );
}

// --- Forespørselen og inntektsmeldingen -------------------------------------------------------

function ForesporselSide({ id, tilbake }: { id: string; tilbake: () => void }) {
  const { org } = useKonto();
  const admin = erAdmin(org?.rolle);
  const sti = `/org/${org!.id}/nav/forespoersler/${id}`;
  const d = useData(() => hent<Detalj>(sti), [sti]);
  // Mens inntektsmeldingen sendes eller NAV kontrollerer den: spør igjen.
  const last = useRef(d.last);
  last.current = d.last;
  const pagar = d.data?.inntektsmeldinger.some((m) => m.status === "sender" || m.status === "sendt");
  useEffect(() => {
    if (!pagar) return;
    const i = window.setInterval(() => void last.current(), 10_000);
    return () => window.clearInterval(i);
  }, [pagar]);

  const tilbakeLenke = (
    <button type="button" className="lenke tilbake-lenke" onClick={tilbake}>
      <IkonVenstre storrelse={16} /> Sykepenger
    </button>
  );
  if (d.feil)
    return (
      <>
        {tilbakeLenke}
        <Feil melding={d.feil} />
      </>
    );
  if (!d.data) return <Laster />;
  const f = d.data;
  const siste = f.inntektsmeldinger[0];

  return (
    <>
      {tilbakeLenke}
      <div className="topp">
        <h1>Inntektsmelding for {f.navn ?? "ukjent ansatt"}</h1>
      </div>
      <section className="kort">
        <div className="lonn-bokforing-topp">
          <h3>NAV ber om inntektsmelding</h3>
          {merke(FORESPORSEL[f.status])}
        </div>
        <dl className="nav-forespoersel">
          <dt>Sykmeldt</dt>
          <dd>{perioder(f.data.sykmeldingsperioder)}</dd>
          {!!f.data.egenmeldingsperioder?.length && (
            <>
              <dt>Egenmeldt</dt>
              <dd>{perioder(f.data.egenmeldingsperioder)}</dd>
            </>
          )}
          <dt>Inntektsdato</dt>
          <dd>{dato(f.data.inntektsdato)}</dd>
          <dt>NAV ber om</dt>
          <dd>
            {[f.data.arbeidsgiverperiodePaakrevd !== false && "arbeidsgiverperioden", f.data.inntektPaakrevd !== false && "inntekten", "om dere krever refusjon"].filter(Boolean).join(", ")}
          </dd>
          <dt>Mottatt</dt>
          <dd>{tid(f.opprettet)}</dd>
        </dl>
        {f.status === "FORKASTET" && (
          <div className="melding info">NAV har trukket tilbake forespørselen (som regel fordi det er kommet en ny for sykefraværet). Den kan ikke besvares.</div>
        )}
        {!f.ansatt_id && f.status !== "FORKASTET" && (
          <div className="melding feil">
            Den sykmeldte er ikke registrert som ansatt med fødselsnummer her. Legg inn fødselsnummeret på den ansatte under <Link to="/ansatte">Ansatte</Link>, og hent fra
            NAV på nytt.
          </div>
        )}
      </section>

      {f.inntektsmeldinger.length > 0 && (
        <section className="kort">
          <h3 style={{ marginTop: 0 }}>Sendt</h3>
          {f.inntektsmeldinger.map((m) => (
            <div key={m.id} className="nav-im-rad">
              <span className="linje">
                {merke(INNTEKTSMELDING[m.status])}
                <span className="liten dempet">
                  {tid(m.sendt_at ?? m.opprettet)}
                  {m.innhold.inntekt ? ` · inntekt ${kr(m.innhold.inntekt.beloep)}` : ""}
                  {m.innhold.refusjon ? ` · refusjon ${kr(m.innhold.refusjon.beloepPerMaaned)}/mnd` : " · uten refusjon"}
                </span>
              </span>
              {m.feil && <div className={`melding ${m.status === "avvist" || m.status === "feil" ? "feil" : "info"}`}>{m.feil}</div>}
            </div>
          ))}
        </section>
      )}

      {f.forslag && f.forslag.aarsak && admin && !(siste && (siste.status === "sender" || siste.status === "sendt")) && (
        <InntektsmeldingSkjema key={siste?.id ?? "ny"} sti={sti} forslag={f.forslag} koder={f.koder} data={f.data} sendt={() => void d.last()} />
      )}
      {f.forslag && admin && siste && (siste.status === "sender" || siste.status === "sendt") && (
        <div className="melding info">Inntektsmeldingen er sendt, og NAV kontrollerer den (vanligvis noen minutter). Siden oppdateres av seg selv.</div>
      )}
    </>
  );
}

// Datoer fra–til for en periode i skjemaet.
function PeriodeFelt({ p, endre, fjern, etikett }: { p: Periode; endre: (p: Periode) => void; fjern?: () => void; etikett?: string }) {
  return (
    <div className="rad nav-periode">
      <label>
        {etikett ?? "Fra og med"}
        <input type="date" required value={p.fom} onChange={(e) => endre({ fom: e.target.value, tom: p.tom < e.target.value ? e.target.value : p.tom })} />
      </label>
      <label>
        Til og med
        <input type="date" required min={p.fom} value={p.tom} onChange={(e) => endre({ ...p, tom: e.target.value })} />
      </label>
      {fjern && (
        <button type="button" className="lenke" onClick={fjern}>
          Fjern
        </button>
      )}
    </div>
  );
}

function Periodeliste({ liste, endre, ny }: { liste: Periode[]; endre: (p: Periode[]) => void; ny: Periode }) {
  return (
    <>
      {liste.map((p, i) => (
        <PeriodeFelt key={i} p={p} endre={(x) => endre(liste.map((y, j) => (j === i ? x : y)))} fjern={liste.length > 1 ? () => endre(liste.filter((_, j) => j !== i)) : undefined} />
      ))}
      <button type="button" className="lenke" onClick={() => endre([...liste, ny])}>
        Legg til periode
      </button>
    </>
  );
}

const PERIODEFELT = { ferier: "ferier", permisjoner: "permisjoner", permitteringer: "permitteringer", sykefravaer: "sykefravaer" } as const;

function AarsakFelt({ a, koder, endre, fjern, standard }: { a: Aarsak; koder: Koder; endre: (a: Aarsak) => void; fjern: () => void; standard: string }) {
  const k = koder.endringsaarsaker[a.aarsak];
  const felt = k?.felt ?? "ingen";
  return (
    <div className="nav-aarsak">
      <div className="linje">
        <strong>{k?.navn ?? a.aarsak}</strong>
        <button type="button" className="lenke" onClick={fjern}>
          Fjern
        </button>
      </div>
      {(felt === "gjelderFra" || felt === "tariff") && (
        <div className="rad">
          <label>
            Gjelder fra
            <input type="date" required value={a.gjelderFra ?? ""} onChange={(e) => endre({ ...a, gjelderFra: e.target.value })} />
          </label>
          {felt === "tariff" && (
            <label>
              Ble kjent
              <input type="date" required value={a.bleKjent ?? ""} onChange={(e) => endre({ ...a, bleKjent: e.target.value })} />
            </label>
          )}
        </div>
      )}
      {felt in PERIODEFELT && (
        <Periodeliste
          liste={(a[felt as keyof typeof PERIODEFELT] as Periode[] | undefined) ?? []}
          endre={(p) => endre({ ...a, [felt]: p })}
          ny={{ fom: standard, tom: standard }}
        />
      )}
    </div>
  );
}

// Tomme felt for en ny årsak av typen.
function nyAarsak(aarsak: string, koder: Koder, standard: string): Aarsak {
  const felt = koder.endringsaarsaker[aarsak]?.felt ?? "ingen";
  if (felt === "gjelderFra") return { aarsak, gjelderFra: standard };
  if (felt === "tariff") return { aarsak, gjelderFra: standard, bleKjent: standard };
  if (felt in PERIODEFELT) return { aarsak, [felt]: [{ fom: standard, tom: standard }] };
  return { aarsak };
}

function Seksjon({ tittel, children }: { tittel: string; children: ReactNode }) {
  return (
    <>
      <h4 className="lonn-under">{tittel}</h4>
      {children}
    </>
  );
}

function InntektsmeldingSkjema({ sti, forslag, koder, data, sendt }: { sti: string; forslag: Forslag; koder: Koder; data: Data; sendt: () => void }) {
  const g = forslag.grunnlag;
  const [im, settIm] = useState<Innhold>(() => structuredClone(forslag.innhold));
  // Beløpene som tekst (norsk komma) mens de skrives.
  const [inntekt, settInntekt] = useState(im.inntekt ? belopTekst(im.inntekt.beloep) : "");
  const [refusjon, settRefusjon] = useState(im.refusjon ? belopTekst(im.refusjon.beloepPerMaaned) : "");
  const [nyAarsakType, settNyAarsakType] = useState("");
  const h = useHandling();
  const sett = (e: Partial<Innhold>) => settIm({ ...im, ...e });
  // Refusjonen følger månedsinntekten så lenge de er like.
  const nyInntekt = (v: string) => {
    if (im.refusjon && tall(refusjon) === tall(inntekt)) settRefusjon(v);
    settInntekt(v);
  };
  const agpDager = im.agp ? dager(im.agp.perioder) : 0;
  const etterAgp = im.agp?.perioder.map((p) => p.tom).sort().at(-1) ?? im.inntekt?.inntektsdato ?? data.inntektsdato ?? "";
  const standard = data.inntektsdato ?? new Date().toISOString().slice(0, 10);
  const endring = forslag.aarsak === "Endring";

  async function send(e: FormEvent) {
    e.preventDefault();
    const kropp: Innhold = {
      ...im,
      inntekt: im.inntekt ? { ...im.inntekt, beloep: tall(inntekt) } : null,
      refusjon: im.refusjon ? { ...im.refusjon, beloepPerMaaned: tall(refusjon) } : null,
    };
    if (!confirm(endring ? "Sende den korrigerte inntektsmeldingen til NAV?" : "Sende inntektsmeldingen til NAV?")) return;
    if (await h.kjor(() => api("POST", `${sti}/inntektsmelding`, kropp))) sendt();
  }

  return (
    <form className="kort nav-im" onSubmit={send}>
      <h3 style={{ marginTop: 0 }}>{endring ? "Korriger inntektsmeldingen" : "Inntektsmeldingen"}</h3>
      <p className="liten dempet">
        {endring
          ? "Forespørselen er besvart. En korrigering sender hele inntektsmeldingen på nytt; det som sist ble godkjent, står under."
          : "Appen har fylt inn det den vet fra NAV, fraværet og lønnen. Sjekk og rett før du sender."}
      </p>
      {forslag.merknader.map((m) => (
        <div key={m} className="melding info">
          {m}
        </div>
      ))}

      {(im.agp || data.arbeidsgiverperiodePaakrevd !== false) && (
        <Seksjon tittel={`Arbeidsgiverperioden (${agpDager} av 16 dager)`}>
          {im.agp ? (
            <>
              <p className="liten dempet">
                De første 16 kalenderdagene med fravær (egenmelding og sykmelding; et nytt fravær innen 16 dager hører til det samme).
                {g.fravaer.some((p) => p.kilde === "appen") ? " Fraværet i appen før sykmeldingen er tatt med." : ""}
              </p>
              <Periodeliste liste={im.agp.perioder} endre={(p) => sett({ agp: { ...im.agp!, perioder: p } })} ny={{ fom: standard, tom: standard }} />
              <label>
                <input
                  type="checkbox"
                  checked={!!im.agp.redusertLoennIAgp}
                  onChange={(e) => sett({ agp: { ...im.agp!, redusertLoennIAgp: e.target.checked ? { beloep: 0, begrunnelse: "ManglerOpptjening" } : null } })}
                />
                Vi har ikke betalt full lønn i arbeidsgiverperioden
              </label>
              {im.agp.redusertLoennIAgp && (
                <div className="rad">
                  <label>
                    Betalt i perioden (kr, brutto)
                    <input
                      inputMode="decimal"
                      required
                      value={belopTekst(im.agp.redusertLoennIAgp.beloep)}
                      onChange={(e) => sett({ agp: { ...im.agp!, redusertLoennIAgp: { ...im.agp!.redusertLoennIAgp!, beloep: tall(e.target.value) || 0 } } })}
                    />
                  </label>
                  <label>
                    Hvorfor
                    <select
                      value={im.agp.redusertLoennIAgp.begrunnelse}
                      onChange={(e) => sett({ agp: { ...im.agp!, redusertLoennIAgp: { ...im.agp!.redusertLoennIAgp!, begrunnelse: e.target.value } } })}
                    >
                      {Object.entries(koder.begrunnelser).map(([k, t]) => (
                        <option key={k} value={k}>
                          {t}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              )}
            </>
          ) : (
            <button type="button" className="lenke" onClick={() => sett({ agp: { perioder: [{ fom: standard, tom: standard }], redusertLoennIAgp: null } })}>
              Oppgi arbeidsgiverperioden
            </button>
          )}
        </Seksjon>
      )}

      {im.inntekt && (
        <Seksjon tittel="Månedsinntekten">
          <p className="liten dempet">
            Snittet av lønnen de tre siste månedene før {dato(im.inntekt.inntektsdato)} (uten overtid, bonus og feriepenger). NAV sammenligner med a-ordningen: avviker
            beløpet mer enn 1 000 kr, må årsaken stå under.
          </p>
          <div className="tabell">
            <table className="lonn-linjer">
              <thead>
                <tr>
                  <th>Måned</th>
                  <th className="hoyre">Lønn i appen</th>
                  {g.snitt_nav != null && <th className="hoyre">A-ordningen</th>}
                </tr>
              </thead>
              <tbody>
                {g.maaneder.map((m) => (
                  <tr key={m.maaned}>
                    <td>{maanedNavn(m.maaned)}</td>
                    <td className="tall">{kr(m.lonn)}</td>
                    {g.snitt_nav != null && <td className="tall">{kr(m.nav ?? 0)}</td>}
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td>Snitt</td>
                  <td className="tall">{kr(g.snitt_lonn)}</td>
                  {g.snitt_nav != null && <td className="tall">{kr(g.snitt_nav)}</td>}
                </tr>
              </tfoot>
            </table>
          </div>
          <label>
            Månedsinntekt (kr)
            <input inputMode="decimal" required value={inntekt} onChange={(e) => nyInntekt(e.target.value)} />
          </label>
          <div className="knapper nav-knapper">
            {g.snitt_nav != null && (
              <button type="button" className="lenke" onClick={() => nyInntekt(belopTekst(g.snitt_nav!))}>
                Bruk snittet i a-ordningen
              </button>
            )}
            <button type="button" className="lenke" onClick={() => nyInntekt(belopTekst(g.snitt_lonn))}>
              Bruk snittet fra lønnen
            </button>
            {g.maanedslonn != null && (
              <button type="button" className="lenke" onClick={() => nyInntekt(belopTekst(g.maanedslonn!))}>
                Bruk månedslønnen nå ({kr(g.maanedslonn)})
              </button>
            )}
          </div>
          <h5 className="nav-under">Årsak til endring i inntekten</h5>
          {im.inntekt.endringAarsaker.map((a, i) => (
            <AarsakFelt
              key={i}
              a={a}
              koder={koder}
              standard={standard}
              endre={(x) => sett({ inntekt: { ...im.inntekt!, endringAarsaker: im.inntekt!.endringAarsaker.map((y, j) => (j === i ? x : y)) } })}
              fjern={() => sett({ inntekt: { ...im.inntekt!, endringAarsaker: im.inntekt!.endringAarsaker.filter((_, j) => j !== i) } })}
            />
          ))}
          {g.endringsaarsaker
            .filter((x) => !im.inntekt!.endringAarsaker.some((a) => a.aarsak === x.aarsak))
            .map((x) => (
              <div key={x.aarsak} className="melding info nav-forslag">
                <span>{x.tekst}</span>
                <button type="button" className="lenke" onClick={() => sett({ inntekt: { ...im.inntekt!, endringAarsaker: [...im.inntekt!.endringAarsaker, x.forslag] } })}>
                  Legg til «{koder.endringsaarsaker[x.aarsak]?.navn ?? x.aarsak}»
                </button>
              </div>
            ))}
          <div className="rad">
            <label>
              Legg til årsak
              <select
                value={nyAarsakType}
                onChange={(e) => {
                  const v = e.target.value;
                  settNyAarsakType("");
                  if (v) sett({ inntekt: { ...im.inntekt!, endringAarsaker: [...im.inntekt!.endringAarsaker, nyAarsak(v, koder, standard)] } });
                }}
              >
                <option value="">Velg årsak</option>
                {Object.entries(koder.endringsaarsaker).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v.navn}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </Seksjon>
      )}

      <Seksjon tittel="Refusjon">
        <label>
          <input
            type="checkbox"
            checked={!!im.refusjon}
            onChange={(e) => {
              sett({ refusjon: e.target.checked ? { beloepPerMaaned: tall(inntekt) || g.snitt_nav || g.snitt_lonn, endringer: [] } : null });
              if (e.target.checked) settRefusjon(inntekt || belopTekst(g.snitt_nav ?? g.snitt_lonn));
            }}
          />
          Vi betaler lønnen under sykdommen og krever refusjon fra NAV
        </label>
        {im.refusjon ? (
          <>
            <label>
              Refusjon per måned (kr)
              <input inputMode="decimal" required value={refusjon} onChange={(e) => settRefusjon(e.target.value)} />
              <span className="felt-hjelp">
                Det dere betaler i måneden (høyst månedsinntekten). NAV refunderer høyst sykepenger av 6 G ({kr(g.seks_g)} i måneden).
              </span>
            </label>
            <p className="liten dempet">Endringer og stopp: et nytt beløp fra en dato (0 kr stopper refusjonen, f.eks. når den ansatte slutter).</p>
            {im.refusjon.endringer.map((x, i) => (
              <div key={i} className="rad nav-periode">
                <label>
                  Beløp per måned (kr)
                  <input
                    inputMode="decimal"
                    required
                    value={belopTekst(x.beloep)}
                    onChange={(e) =>
                      sett({ refusjon: { ...im.refusjon!, endringer: im.refusjon!.endringer.map((y, j) => (j === i ? { ...y, beloep: tall(e.target.value) || 0 } : y)) } })
                    }
                  />
                </label>
                <label>
                  Fra og med
                  <input
                    type="date"
                    required
                    value={x.startdato}
                    onChange={(e) => sett({ refusjon: { ...im.refusjon!, endringer: im.refusjon!.endringer.map((y, j) => (j === i ? { ...y, startdato: e.target.value } : y)) } })}
                  />
                </label>
                <button type="button" className="lenke" onClick={() => sett({ refusjon: { ...im.refusjon!, endringer: im.refusjon!.endringer.filter((_, j) => j !== i) } })}>
                  Fjern
                </button>
              </div>
            ))}
            <button
              type="button"
              className="lenke"
              onClick={() => sett({ refusjon: { ...im.refusjon!, endringer: [...im.refusjon!.endringer, { beloep: 0, startdato: etterAgp ? nesteDag(etterAgp) : standard }] } })}
            >
              Legg til endring eller stopp
            </button>
          </>
        ) : (
          <p className="liten dempet">Uten refusjon betaler NAV sykepengene etter arbeidsgiverperioden til den ansatte.</p>
        )}
      </Seksjon>

      <Seksjon tittel="Naturalytelser som faller bort">
        <p className="liten dempet">Bare goder den ansatte mister under sykdommen (f.eks. firmabil som leveres inn), med verdien per måned.</p>
        {im.naturalytelser.map((n, i) => (
          <div key={i} className="rad nav-periode">
            <label>
              Ytelse
              <select
                value={n.naturalytelse}
                onChange={(e) => sett({ naturalytelser: im.naturalytelser.map((y, j) => (j === i ? { ...y, naturalytelse: e.target.value } : y)) })}
              >
                {Object.entries(koder.naturalytelser).map(([k, t]) => (
                  <option key={k} value={k}>
                    {t}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Verdi per måned (kr)
              <input
                inputMode="decimal"
                required
                value={belopTekst(n.verdiBeloep)}
                onChange={(e) => sett({ naturalytelser: im.naturalytelser.map((y, j) => (j === i ? { ...y, verdiBeloep: tall(e.target.value) || 0 } : y)) })}
              />
            </label>
            <label>
              Faller bort fra
              <input
                type="date"
                required
                value={n.sluttdato}
                onChange={(e) => sett({ naturalytelser: im.naturalytelser.map((y, j) => (j === i ? { ...y, sluttdato: e.target.value } : y)) })}
              />
            </label>
            <button type="button" className="lenke" onClick={() => sett({ naturalytelser: im.naturalytelser.filter((_, j) => j !== i) })}>
              Fjern
            </button>
          </div>
        ))}
        <button type="button" className="lenke" onClick={() => sett({ naturalytelser: [...im.naturalytelser, { naturalytelse: "BIL", verdiBeloep: 0, sluttdato: standard }] })}>
          Legg til naturalytelse
        </button>
      </Seksjon>

      <Seksjon tittel="Kontaktperson hos dere">
        <div className="rad">
          <label>
            Navn
            <input required maxLength={64} value={im.kontaktinformasjon} onChange={(e) => sett({ kontaktinformasjon: e.target.value })} />
          </label>
          <label>
            Telefon
            <input type="tel" required inputMode="tel" placeholder="22225555" value={im.arbeidsgiverTlf} onChange={(e) => sett({ arbeidsgiverTlf: e.target.value })} />
          </label>
        </div>
      </Seksjon>

      <Feil melding={h.feil} />
      <div className="knapper">
        <button className="primar" disabled={h.opptatt}>
          {endring ? "Send korrigeringen" : "Send inntektsmeldingen"}
        </button>
      </div>
    </form>
  );
}

const nesteDag = (iso: string) => new Date(Date.parse(`${iso}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
