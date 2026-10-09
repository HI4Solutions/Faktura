// A-meldingen (server/src/ameldingRuter.ts): fanen «A-melding» under Lønn. Månedene i året med
// fristen, lønnen og arbeidsforholdene og hva som er levert; for en måned (?maaned=ÅÅÅÅ-MM)
// grunnlaget, avvikene, fila (XML til opplasting på skatteetaten.no) eller innsendingen til
// Skatteetaten, og tilbakemeldingen.
import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, hent } from "../api";
import { Feil, Laster, useData, useHandling, useSmal } from "../felles";
import { erAdmin, useKonto } from "../konto";
import { dato, kr } from "../format";
import { IkonVenstre } from "../ikoner";
import { maaned as maanedTekst } from "../lonn";

type Status = "lages" | "klar" | "levert" | "sendt" | "mottatt" | "avvist" | "feil";
type Melding = {
  id: string;
  maaned: string;
  meldings_id: string;
  erstatter: string | null;
  innsending: "fil" | "api";
  status: Status;
  oppsummering: Grunnlag | null;
  forsendelse_id: string | null;
  tilbakemelding: { status: string | null; avvik: { kode: string | null; tekst: string; alvorlighet: string | null }[] } | null;
  feil: string | null;
  opprettet: string;
  sendt_at: string | null;
  laget_av: string | null;
};
type Innsending = { pa: boolean; tilgang: boolean; miljo: "test" | "prod" };
type Grunnlag = {
  antall_arbeidsforhold: number;
  antall_med_lonn: number;
  inntekt: number;
  forskuddstrekk: { dato: string; belop: number }[];
  sum_forskuddstrekk: number;
  arbeidsgiveravgift: number;
  mottakere: {
    ansatt_id: string;
    navn: string;
    ansattnummer: number;
    inntekter: { beskrivelse: string; belop: number; antall: number | null; fordel?: string; trekk?: boolean }[];
    forskuddstrekk: number;
    // Permisjonene og permitteringene som rapporteres (0084); til er null når sluttdatoen ikke er kjent.
    permisjoner?: { navn: string; fra: string; til: string | null; prosent: number }[];
  }[];
};
type Maaned = { maaned: string; frist: string; med_lonn: number; arbeidsforhold: number; skattetrekk: number; brutto: number; siste: Melding | null };

const BESKRIVELSE: Record<string, string> = {
  fastloenn: "Fastlønn",
  timeloenn: "Timelønn",
  overtidsgodtgjoerelse: "Overtid",
  fastTillegg: "Faste tillegg",
  uregelmessigeTilleggKnyttetTilArbeidetTid: "Uregelmessige tillegg",
  bonus: "Bonus",
  feriepenger: "Feriepenger",
  trekkILoennForFerie: "Trekk i lønn for ferie",
  // Naturalytelser og utgiftsgodtgjørelser (reiser).
  bil: "Fri bil",
  elektroniskKommunikasjon: "Elektronisk kommunikasjon",
  skattepliktigDelForsikringer: "Forsikringer",
  rentefordelLaan: "Rentefordel lån",
  bolig: "Fri bolig",
  skattepliktigPersonalrabatt: "Personalrabatt",
  annet: "Andre naturalytelser",
  reiseKostMedOvernattingPaaHotell: "Kost, hotell",
  reiseKostMedOvernattingPaaHybelUtenKokEllerPensjonatEllerBrakke: "Kost, hybel/pensjonat/brakke",
  reiseKostMedOvernattingPaaHybelMedKokEllerPrivat: "Kost, hybel med kokemulighet/privat",
  reiseKostUtenOvernatting: "Kost, dagsreise",
  reiseNattillegg: "Nattillegg",
  reiseKost: "Kost (trekkpliktig)",
  reiseAnnet: "Reise, annet (trekkpliktig)",
  kilometergodtgjoerelseBil: "Bilgodtgjørelse",
  kilometergodtgjoerelsePassasjertillegg: "Passasjertillegg",
  kilometergodtgjoerelseAndreFremkomstmidler: "Kilometergodtgjørelse, andre",
};
// Enheten for antallet: timer for timelønnen, døgn, dager, netter og km for reisene.
const ENHET: Record<string, string> = {
  timeloenn: "t",
  reiseKostMedOvernattingPaaHotell: "døgn",
  reiseKostMedOvernattingPaaHybelUtenKokEllerPensjonatEllerBrakke: "døgn",
  reiseKostMedOvernattingPaaHybelMedKokEllerPrivat: "døgn",
  reiseKostUtenOvernatting: "dager",
  reiseNattillegg: "netter",
  kilometergodtgjoerelseBil: "km",
  kilometergodtgjoerelsePassasjertillegg: "km",
  kilometergodtgjoerelseAndreFremkomstmidler: "km",
};
const STATUS: Record<Status, [string, string]> = {
  lages: ["Lages", "merke-noytral"],
  klar: ["Fil klar", "merke-noytral"],
  levert: ["Lastet opp", "merke-ok"],
  sendt: ["Sendt, venter på svar", "merke-noytral"],
  mottatt: ["Mottatt", "merke-ok"],
  avvist: ["Avvist", "merke-fare"],
  feil: ["Feil", "merke-fare"],
};
// Inntektene til en mottaker på én linje, f.eks. «Timelønn 38 000,00 (152 t)», eller null.
const inntektTekst = (inntekter: Grunnlag["mottakere"][number]["inntekter"]) =>
  inntekter.length
    ? inntekter
        .map(
          (i) =>
            `${BESKRIVELSE[i.beskrivelse] ?? i.beskrivelse}${i.fordel === "utgiftsgodtgjoerelse" && i.trekk && !/trekkpliktig/.test(BESKRIVELSE[i.beskrivelse] ?? "") ? " (trekkpliktig)" : ""} ${kr(i.belop)}${i.antall ? ` (${String(i.antall).replace(".", ",")} ${ENHET[i.beskrivelse] ?? ""})`.replace(" )", ")") : ""}`,
        )
        .join(" · ")
    : null;
// «Permittering 50 % fra 01.10.2026» eller «Foreldrepermisjon 01.03.2026–31.12.2026».
const permisjonTekst = (p: NonNullable<Grunnlag["mottakere"][number]["permisjoner"]>) =>
  p.length ? p.map((x) => `${x.navn}${x.prosent < 100 ? ` ${x.prosent} %` : ""} ${x.til ? `${dato(x.fra)}–${dato(x.til)}` : `fra ${dato(x.fra)}`}`).join(" · ") : null;
const merke = (s: Status) => <span className={`merke ${STATUS[s][1]}`}>{STATUS[s][0]}</span>;
const tid = (iso: string) => {
  const d = new Date(iso);
  return `${dato(new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Oslo" }).format(d))} kl. ${new Intl.DateTimeFormat("nb-NO", { timeZone: "Europe/Oslo", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d).replace(":", ".")}`;
};
const iDagOslo = () => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Oslo" }).format(new Date());

export function Ameldinger() {
  const [sok, settSok] = useSearchParams();
  const maaned = sok.get("maaned");
  const sett = (endring: Record<string, string | null>) => {
    const p = new URLSearchParams(sok);
    for (const [k, v] of Object.entries(endring)) {
      if (v === null) p.delete(k);
      else p.set(k, v);
    }
    settSok(p);
  };
  if (maaned && /^\d{4}-\d{2}$/.test(maaned)) return <AmeldingMaaned maaned={maaned} tilbake={() => sett({ maaned: null })} />;
  return <AmeldingListe aar={Number(sok.get("aar")) || Number(iDagOslo().slice(0, 4))} velgAar={(a) => sett({ aar: String(a) })} apne={(m) => sett({ maaned: m })} />;
}

function Innsendingstekst({ i }: { i: Innsending }) {
  return (
    <p className="undertittel">
      A-meldingen leveres hver måned innen den 5. i måneden etter (neste virkedag), også i måneder uten lønn så lenge noen er ansatt.{" "}
      {i.pa && i.tilgang ? (
        "Appen sender den til Skatteetaten, og henter tilbakemeldingen."
      ) : (
        <>
          Last ned fila og last den opp på{" "}
          <a href="https://www.skatteetaten.no/bedrift-og-organisasjon/arbeidsgiver/a-meldingen/" target="_blank" rel="noreferrer">
            skatteetaten.no
          </a>
          {i.pa ? (
            <>
              , eller gi tilgang i Altinn (<Link to="/innstillinger?fane=personal#skattekort">Innstillinger → Ansatte og timer</Link>), så sender appen den.
            </>
          ) : (
            "."
          )}
        </>
      )}
      {i.miljo === "test" && i.pa && <span className="merke merke-noytral lonn-merke">Testmiljø</span>}
    </p>
  );
}

function AmeldingListe({ aar, velgAar, apne }: { aar: number; velgAar: (a: number) => void; apne: (m: string) => void }) {
  const { org } = useKonto();
  const smal = useSmal();
  const d = useData(() => hent<{ aar: number; maaneder: Maaned[]; innsending: Innsending }>(`/org/${org!.id}/amelding?aar=${aar}`), [org?.id, aar], { oppdater: true });
  const iAar = Number(iDagOslo().slice(0, 4));
  const iDag = iDagOslo();
  const aarene = [iAar, iAar - 1, iAar - 2].filter((a) => a >= 2015);
  if (d.feil) return <Feil melding={d.feil} />;
  if (!d.data) return <Laster />;
  const status = (m: Maaned) =>
    m.siste ? (
      merke(m.siste.status)
    ) : m.med_lonn || m.arbeidsforhold ? (
      <span className={`merke ${m.frist < iDag ? "merke-fare" : "merke-advarsel"}`}>{m.frist < iDag ? "Ikke levert" : "Skal leveres"}</span>
    ) : (
      <span className="dempet liten">Ingenting å levere</span>
    );
  return (
    <>
      <Innsendingstekst i={d.data.innsending} />
      <div className="knapper lonn-knapper lonn-aar-valg">
        <label>
          År{" "}
          <select value={aar} onChange={(e) => velgAar(Number(e.target.value))}>
            {[...new Set([aar, ...aarene])].sort((a, b) => b - a).map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </label>
      </div>
      {smal ? (
        <div className="kort liste">
          {d.data.maaneder.map((m) => (
            <button key={m.maaned} type="button" className="liste-rad" onClick={() => apne(m.maaned)}>
              <span className="linje">
                <span className="tittel">{maanedTekst(`${m.maaned}-01`)}</span>
                {status(m)}
              </span>
              <span className="linje">
                <span className="under">
                  Frist {dato(m.frist)} · {m.med_lonn} med lønn · trekk {kr(m.skattetrekk)}
                </span>
              </span>
            </button>
          ))}
        </div>
      ) : (
        <div className="kort tabell">
          <table>
            <thead>
              <tr>
                <th>Måned</th>
                <th>Frist</th>
                <th className="hoyre">Med lønn</th>
                <th className="hoyre">Ansatte</th>
                <th className="hoyre">Forskuddstrekk</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {d.data.maaneder.map((m) => (
                <tr key={m.maaned} className="klikkbar" onClick={() => apne(m.maaned)}>
                  <td>
                    <strong>{maanedTekst(`${m.maaned}-01`)}</strong>
                  </td>
                  <td>{dato(m.frist)}</td>
                  <td className="tall">{m.med_lonn}</td>
                  <td className="tall">{m.arbeidsforhold}</td>
                  <td className="tall">{kr(m.skattetrekk)}</td>
                  <td>{status(m)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function AmeldingMaaned({ maaned, tilbake }: { maaned: string; tilbake: () => void }) {
  const { org } = useKonto();
  const admin = erAdmin(org?.rolle);
  const d = useData(
    () =>
      hent<{ maaned: string; frist: string; avvik: { niva: "feil" | "advarsel"; tekst: string; ansatt_id?: string }[]; grunnlag: Grunnlag; meldinger: Melding[]; innsending: Innsending }>(
        `/org/${org!.id}/amelding/${maaned}`,
      ),
    [org?.id, maaned],
  );
  const h = useHandling();
  const smal = useSmal();
  const [erstatt, settErstatt] = useState(true);

  // Mens en melding lages eller venter på tilbakemelding: spør igjen.
  const last = useRef(d.last);
  last.current = d.last;
  const pagar = d.data?.meldinger.some((m) => m.status === "lages" || (m.status === "sendt" && m.innsending === "api"));
  const lages = d.data?.meldinger.find((m) => m.status === "lages");
  useEffect(() => {
    if (!pagar) return;
    const i = window.setInterval(() => void last.current(), lages ? 2500 : 15_000);
    return () => window.clearInterval(i);
  }, [pagar, lages]);

  if (d.feil)
    return (
      <>
        <button type="button" className="lenke tilbake-lenke" onClick={tilbake}>
          <IkonVenstre storrelse={16} /> Alle måneder
        </button>
        <Feil melding={d.feil} />
      </>
    );
  if (!d.data) return <Laster />;
  const x = d.data;
  const g = x.grunnlag;
  const feil = x.avvik.filter((a) => a.niva === "feil");
  const levert = x.meldinger.find((m) => ["levert", "sendt", "mottatt"].includes(m.status));
  const kanSende = x.innsending.pa && x.innsending.tilgang;
  const bestill = async (innsending: "fil" | "api") => {
    if (innsending === "api" && !confirm(`Sende a-meldingen for ${maanedTekst(`${maaned}-01`)} til Skatteetaten?`)) return;
    if (await h.kjor(() => api<Melding>("POST", `/org/${org!.id}/amelding/${maaned}`, { innsending, erstatt: levert ? erstatt : true }))) void d.last();
  };
  const lastNedFil = async (m: Melding) => {
    const vindu = window.open("", "_blank");
    const r = await h.kjor(() => api<{ url: string }>("GET", `/org/${org!.id}/amelding/fil/${m.id}`));
    if (r && vindu) vindu.location.href = r.url;
    else if (r) window.location.href = r.url;
    else vindu?.close();
  };
  const merkLevert = async (m: Melding, levert: boolean) => {
    if (await h.kjor(() => api("POST", `/org/${org!.id}/amelding/fil/${m.id}/levert`, { levert }))) void d.last();
  };

  return (
    <>
      <button type="button" className="lenke tilbake-lenke" onClick={tilbake}>
        <IkonVenstre storrelse={16} /> Alle måneder
      </button>
      <div className="topp">
        <h1>A-melding for {maanedTekst(`${maaned}-01`)}</h1>
      </div>
      <p className="undertittel">
        Frist {dato(x.frist)}. Lønnen er med i måneden den er utbetalt (de godkjente lønnskjøringene med utbetaling i måneden), og alle som er ansatt i måneden.
      </p>
      {lages && (
        <div className="melding info" role="status">
          <span className="spinner" /> {lages.innsending === "fil" ? "Fila lages …" : "A-meldingen lages og sendes til Skatteetaten …"}
        </div>
      )}
      <Feil melding={h.feil} />
      {x.avvik.length > 0 && (
        <ul className="lonn-merknader amelding-avvik">
          {x.avvik.map((a, i) => (
            <li key={i} className={a.niva === "feil" ? "fare-tekst" : "advarsel-tekst"}>
              {a.tekst}{" "}
              {a.ansatt_id ? (
                <Link to={`/ansatte/${a.ansatt_id}`}>Åpne den ansatte</Link>
              ) : /Innstillinger/.test(a.tekst) ? (
                <Link to="/innstillinger?fane=personal#amelding">Til innstillingene</Link>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <div className="nokkeltall lonn-tall">
        <div className="kort">
          <div className="etikett">Inntektsmottakere</div>
          <div className="verdi">{g.antall_med_lonn}</div>
          <div className="under">{g.antall_arbeidsforhold} arbeidsforhold i måneden</div>
        </div>
        <div className="kort">
          <div className="etikett">Lønn</div>
          <div className="verdi">{kr(g.inntekt)}</div>
          <div className="under">Som i a-meldingen</div>
        </div>
        <div className="kort">
          <div className="etikett">Forskuddstrekk</div>
          <div className="verdi">{kr(g.sum_forskuddstrekk)}</div>
          <div className="under">{g.forskuddstrekk.map((f) => `${dato(f.dato)}: ${kr(f.belop)}`).join(" · ") || "Ingen lønn i måneden"}</div>
        </div>
        <div className="kort">
          <div className="etikett">Arbeidsgiveravgift</div>
          <div className="verdi">{kr(g.arbeidsgiveravgift)}</div>
          <div className="under">Betales annenhver måned</div>
        </div>
      </div>

      {admin && (
        <div className="kort amelding-handling">
          {levert && (
            <label>
              <input type="checkbox" checked={erstatt} onChange={(e) => settErstatt(e.target.checked)} />
              Erstatt meldingen som er levert {tid(levert.sendt_at ?? levert.opprettet)} (en rettet a-melding)
            </label>
          )}
          <div className="knapper">
            <button type="button" className={kanSende ? undefined : "primar"} disabled={h.opptatt || feil.length > 0 || !!lages} onClick={() => void bestill("fil")}>
              Lag fil (XML)
            </button>
            {kanSende && (
              <button type="button" className="primar" disabled={h.opptatt || feil.length > 0 || !!pagar} onClick={() => void bestill("api")}>
                Send til Skatteetaten
              </button>
            )}
          </div>
          {feil.length > 0 && <p className="liten fare-tekst">Rett feilene over først.</p>}
          <p className="liten dempet">
            {kanSende
              ? "Fila lastes opp på skatteetaten.no om du ikke vil sende fra appen."
              : x.innsending.pa
                ? "Gi tilgang til a-meldingen i Altinn (Innstillinger → Ansatte og timer), så kan appen sende den."
                : "Fila lastes opp på skatteetaten.no (a-melding som fil). Merk den som lastet opp etterpå, så erstatter en ny fil for måneden den."}
          </p>
        </div>
      )}

      {x.meldinger.length > 0 && (
        <>
          <h3>Meldinger</h3>
          <div className="kort liste">
            {x.meldinger.map((m) => (
              <div key={m.id} className="amelding-rad">
                <div className="linje">
                  <span>
                    <strong>{m.innsending === "fil" ? "Fil" : "Sendt fra appen"}</strong> {tid(m.opprettet)}
                    {m.laget_av ? ` av ${m.laget_av}` : ""}
                  </span>
                  {merke(m.status)}
                </div>
                {m.erstatter && <div className="liten dempet">Erstatter en melding som er levert.</div>}
                {m.feil && <div className="liten fare-tekst">{m.feil}</div>}
                {m.tilbakemelding?.avvik.length ? (
                  <ul className="liten amelding-tilbakemelding">
                    {m.tilbakemelding.avvik.map((a, i) => (
                      <li key={i}>
                        {a.alvorlighet ? `${a.alvorlighet}: ` : ""}
                        {a.tekst}
                        {a.kode ? ` (${a.kode})` : ""}
                      </li>
                    ))}
                  </ul>
                ) : null}
                {admin && m.innsending === "fil" && (m.status === "klar" || m.status === "levert") && (
                  <div className="knapper">
                    <button type="button" disabled={h.opptatt} onClick={() => void lastNedFil(m)}>
                      Last ned fila
                    </button>
                    {m.status === "klar" ? (
                      <button type="button" disabled={h.opptatt} onClick={() => void merkLevert(m, true)}>
                        Merk som lastet opp
                      </button>
                    ) : (
                      <button type="button" className="lenke" disabled={h.opptatt} onClick={() => void merkLevert(m, false)}>
                        Ikke lastet opp likevel
                      </button>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        </>
      )}

      {g.mottakere.length > 0 && smal && (
        <>
          <h3>Inntektsmottakerne</h3>
          <div className="kort liste">
            {g.mottakere.map((m) => (
              <div key={m.ansatt_id} className="amelding-rad">
                <div className="linje">
                  <strong>
                    {m.navn} <span className="dempet liten">({m.ansattnummer})</span>
                  </strong>
                  <span className="tall">{kr(m.forskuddstrekk)}</span>
                </div>
                <div className="liten dempet">{inntektTekst(m.inntekter) ?? "Bare arbeidsforholdet"}</div>
                {permisjonTekst(m.permisjoner ?? []) && <div className="liten dempet">{permisjonTekst(m.permisjoner ?? [])}</div>}
              </div>
            ))}
          </div>
        </>
      )}
      {g.mottakere.length > 0 && !smal && (
        <>
          <h3>Inntektsmottakerne</h3>
          <div className="kort tabell">
            <table className="lonn-linjer">
              <thead>
                <tr>
                  <th>Ansatt</th>
                  <th>Lønn i a-meldingen</th>
                  <th className="hoyre">Forskuddstrekk</th>
                </tr>
              </thead>
              <tbody>
                {g.mottakere.map((m) => (
                  <tr key={m.ansatt_id}>
                    <td>
                      {m.navn} <span className="dempet liten">({m.ansattnummer})</span>
                    </td>
                    <td>
                      {inntektTekst(m.inntekter) ?? <span className="dempet">Bare arbeidsforholdet</span>}
                      {permisjonTekst(m.permisjoner ?? []) && <div className="liten dempet">{permisjonTekst(m.permisjoner ?? [])}</div>}
                    </td>
                    <td className="tall">{kr(m.forskuddstrekk)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}
