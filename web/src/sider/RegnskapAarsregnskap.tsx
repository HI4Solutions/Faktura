// Regnskap → Årsregnskap (server/src/aarsregnskap.ts, aarsregnskapInnsending.ts): årsregnskapet til
// Regnskapsregisteret i Brønnøysund. Resultatregnskapet og balansen for små foretak kommer fra
// regnskapet (med fjoråret, som kan legges inn for hånd), notene foreslås, og brukeren fyller ut
// fastsettelsen og revisjonen. Kontrollene sier hva som må rettes. Årsregnskapet sendes til Altinn
// (systembrukeren lager skjemaet og låser det), og daglig leder signerer der med BankID; appen følger
// med til det er levert. PDF-en er til signaturene, og skjemaene kan lastes ned som XML.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { api, hent, lastNed } from "../api";
import { Feil, Laster, useData, useHandling } from "../felles";
import { useKonto } from "../konto";
import { dato, iDag } from "../format";
import { IkonHoyre, IkonVenstre } from "../ikoner";
import { ALTINN_FRA } from "./Skattekort";

// Godkjenningen i Altinn starter her: siden Altinn sender brukeren tilbake til
// (/skattekort/godkjent), viser da veien tilbake til årsregnskapet.
const merkAltinn = () => {
  try {
    sessionStorage.setItem(ALTINN_FRA, JSON.stringify({ fra: "aarsregnskap", tid: Date.now() }));
  } catch {
    // Uten lagring i nettleseren går siden etter tilgangen brukeren har.
  }
};

type Linje = { type: "overskrift" | "post" | "sum"; nokkel: string | null; navn: string; niva: number; aarets: number; fjor: number; vis: boolean };
type Laan = {
  gitt: boolean;
  laan_styret?: number | null;
  laan_andre?: number | null;
  sikkerhet_styret?: number | null;
  sikkerhet_andre?: number | null;
  rente_styret?: string | null;
  rente_andre?: string | null;
  vilkaar_styret?: string | null;
  vilkaar_andre?: string | null;
  tekst?: string | null;
};
type Gjeld = { over_fem_aar?: number | null; pantsikret?: number | null; pantsatte_eiendeler?: number | null; garantier?: number | null; tekst?: string | null };
type Opplysninger = {
  fastsettelsesdato?: string | null;
  bekreftende?: string | null;
  revideres?: boolean | null;
  utarbeidet_av_regnskapsforer?: boolean;
  bistand_regnskapsforer?: boolean;
  kontakt_epost?: string | null;
  prinsipper?: string | null;
  usikkerhet_drift?: boolean;
  usikkerhet_tekst?: string | null;
  aarsverk?: number | null;
  laan?: Laan | null;
  gjeld?: Gjeld | null;
  ytterligere?: string | null;
  fjor?: Record<string, number> | null;
};
type Valideringsfeil = { alvor: "feil" | "advarsel" | "info"; kode: string | null; tekst: string; felt: string | null };
type Status = "utkast" | "sender" | "til_signering" | "levert" | "feil";
type Aarsregnskap = {
  aar: number;
  over: boolean;
  start: string;
  slutt: string;
  orgnr: string | null;
  navn: string;
  organisasjonsform: string | null;
  har_fjor: boolean;
  fjor_for_haand: boolean;
  resultat: Linje[];
  balanse: Linje[];
  noter: { prinsipper: string; prinsipper_standard: string; aarsverk: number | null; aarsverk_forslag: number; lonn: { navn: string; aarets: number; fjor: number }[] | null };
  opplysninger: Opplysninger;
  forslag: { bekreftende: string | null; kontakt_epost: string | null };
  roller: { rolle: string; navn: string }[];
  aarsoppgjor: { bokfort: boolean; stemmer: boolean; trengs: boolean };
  innsending: {
    status: Status;
    instans_url: string | null;
    laast: boolean;
    sendt_at: string | null;
    levert_at: string | null;
    sjekket_at: string | null;
    feil: string | null;
    valideringsfeil: Valideringsfeil[] | null;
  };
  altinn: {
    pa: boolean;
    miljo: string;
    status: string | null;
    godkjenn_url: string | null;
    endring_status: string | null;
    endring_url: string | null;
    har_pakke: boolean;
    pakke: string;
    mangler: string[];
  };
  feil: string[];
  advarsler: string[];
};

const helKr = (n: number) => new Intl.NumberFormat("nb-NO", { maximumFractionDigits: 0 }).format(n);
// «12 000» → 12000 (tomt: null; ugyldig: NaN).
const tallFra = (s: string) => {
  const t = s.replace(/[\s ]/g, "").replace(",", ".");
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : NaN;
};
const tekstFra = (n: number | null | undefined) => (n == null ? "" : String(n).replace(".", ","));
const SENDT: Status[] = ["sender", "til_signering", "levert"];

// Skjemaet på siden (feltene som tekst, som i inputene).
type Skjema = {
  fastsettelsesdato: string;
  bekreftende: string;
  revideres: "" | "ja" | "nei";
  utarbeidet: boolean;
  bistand: boolean;
  kontakt_epost: string;
  prinsipper: string;
  usikkerhet: boolean;
  usikkerhet_tekst: string;
  aarsverk: string;
  laan_gitt: boolean;
  laan_styret: string;
  laan_andre: string;
  sikkerhet_styret: string;
  sikkerhet_andre: string;
  rente_styret: string;
  rente_andre: string;
  vilkaar_styret: string;
  vilkaar_andre: string;
  laan_tekst: string;
  gjeld_fem: string;
  gjeld_pant: string;
  gjeld_pantsatte: string;
  gjeld_garantier: string;
  gjeld_tekst: string;
  ytterligere: string;
};
function tilSkjema(a: Aarsregnskap): Skjema {
  const o = a.opplysninger;
  return {
    fastsettelsesdato: o.fastsettelsesdato ?? "",
    bekreftende: o.bekreftende ?? "",
    revideres: o.revideres == null ? "" : o.revideres ? "ja" : "nei",
    utarbeidet: o.utarbeidet_av_regnskapsforer ?? false,
    bistand: o.bistand_regnskapsforer ?? false,
    kontakt_epost: o.kontakt_epost ?? "",
    prinsipper: a.noter.prinsipper,
    usikkerhet: o.usikkerhet_drift ?? false,
    usikkerhet_tekst: o.usikkerhet_tekst ?? "",
    aarsverk: tekstFra(o.aarsverk),
    laan_gitt: o.laan?.gitt ?? false,
    laan_styret: tekstFra(o.laan?.laan_styret),
    laan_andre: tekstFra(o.laan?.laan_andre),
    sikkerhet_styret: tekstFra(o.laan?.sikkerhet_styret),
    sikkerhet_andre: tekstFra(o.laan?.sikkerhet_andre),
    rente_styret: o.laan?.rente_styret ?? "",
    rente_andre: o.laan?.rente_andre ?? "",
    vilkaar_styret: o.laan?.vilkaar_styret ?? "",
    vilkaar_andre: o.laan?.vilkaar_andre ?? "",
    laan_tekst: o.laan?.tekst ?? "",
    gjeld_fem: tekstFra(o.gjeld?.over_fem_aar),
    gjeld_pant: tekstFra(o.gjeld?.pantsikret),
    gjeld_pantsatte: tekstFra(o.gjeld?.pantsatte_eiendeler),
    gjeld_garantier: tekstFra(o.gjeld?.garantier),
    gjeld_tekst: o.gjeld?.tekst ?? "",
    ytterligere: o.ytterligere ?? "",
  };
}
// Det som lagres (null fjerner). Kaster med en melding når et tall er ugyldig.
function fraSkjema(s: Skjema, a: Aarsregnskap): Opplysninger {
  const belop = (v: string, navn: string) => {
    const n = tallFra(v);
    if (Number.isNaN(n) || (n !== null && n < 0)) throw new Error(`Ugyldig beløp: ${navn}`);
    return n;
  };
  const aarsverk = tallFra(s.aarsverk);
  if (Number.isNaN(aarsverk) || (aarsverk !== null && aarsverk < 0)) throw new Error("Ugyldig antall årsverk");
  const t = (v: string) => v.trim() || null;
  const gjeld = {
    over_fem_aar: belop(s.gjeld_fem, "gjeld som forfaller etter fem år"),
    pantsikret: belop(s.gjeld_pant, "gjeld sikret ved pant"),
    pantsatte_eiendeler: belop(s.gjeld_pantsatte, "pantsatte eiendeler"),
    garantier: belop(s.gjeld_garantier, "garantiforpliktelser"),
    tekst: t(s.gjeld_tekst),
  };
  return {
    fastsettelsesdato: s.fastsettelsesdato || null,
    bekreftende: t(s.bekreftende),
    revideres: s.revideres === "" ? null : s.revideres === "ja",
    utarbeidet_av_regnskapsforer: s.utarbeidet,
    bistand_regnskapsforer: s.bistand,
    kontakt_epost: t(s.kontakt_epost),
    // Standardteksten lagres ikke (den følger regnskapet).
    prinsipper: s.prinsipper.trim() && s.prinsipper.trim() !== a.noter.prinsipper_standard.trim() ? s.prinsipper.trim() : null,
    usikkerhet_drift: s.usikkerhet,
    usikkerhet_tekst: s.usikkerhet ? t(s.usikkerhet_tekst) : null,
    aarsverk,
    laan: s.laan_gitt
      ? {
          gitt: true,
          laan_styret: belop(s.laan_styret, "lån til styret"),
          laan_andre: belop(s.laan_andre, "lån til andre"),
          sikkerhet_styret: belop(s.sikkerhet_styret, "sikkerhetsstillelse for styret"),
          sikkerhet_andre: belop(s.sikkerhet_andre, "sikkerhetsstillelse for andre"),
          rente_styret: t(s.rente_styret),
          rente_andre: t(s.rente_andre),
          vilkaar_styret: t(s.vilkaar_styret),
          vilkaar_andre: t(s.vilkaar_andre),
          tekst: t(s.laan_tekst),
        }
      : { gitt: false },
    gjeld: Object.values(gjeld).some((v) => v !== null) ? gjeld : null,
    ytterligere: t(s.ytterligere),
  };
}

function Oppstilling({ tittel, linjer, a, fjor, settFjor }: { tittel: string; linjer: Linje[]; a: Aarsregnskap; fjor: Record<string, string> | null; settFjor: (k: string, v: string) => void }) {
  // Når fjorårstallene legges inn, vises alle postene.
  const vis = fjor ? linjer.filter((l) => l.type !== "sum" || l.vis || l.niva === 1) : linjer.filter((l) => l.vis);
  return (
    <div className="tabell">
      <table className={`aars-tabell aarsregnskap-tabell${fjor ? " fjor-redigering" : ""}`}>
        <thead>
          <tr>
            <th>{tittel}</th>
            <th className="tall">{a.aar}</th>
            {(a.har_fjor || fjor) && <th className="tall aars-fjor">{a.aar - 1}</th>}
          </tr>
        </thead>
        <tbody>
          {vis.map((l, i) =>
            l.type === "overskrift" ? (
              <tr key={`o${i}`} className={`overskrift niva-${l.niva}`}>
                <td colSpan={3}>{l.navn}</td>
              </tr>
            ) : (
              <tr key={l.nokkel} className={l.type === "sum" ? (l.niva === 1 ? "sum hoved" : "sum") : undefined}>
                <td className={l.type === "post" ? "innrykk" : undefined}>{l.navn}</td>
                <td className="tall">{helKr(l.aarets)}</td>
                {fjor && l.type === "post" ? (
                  <td className="tall aars-fjor">
                    <input className="fjor-felt" inputMode="numeric" aria-label={`${l.navn} ${a.aar - 1}`} value={fjor[l.nokkel!] ?? ""} onChange={(e) => settFjor(l.nokkel!, e.target.value)} />
                  </td>
                ) : (
                  (a.har_fjor || fjor) && <td className="tall dempet aars-fjor">{fjor ? "" : helKr(l.fjor)}</td>
                )}
              </tr>
            ),
          )}
        </tbody>
      </table>
    </div>
  );
}

function Felt({ etikett, hjelp, children }: { etikett: string; hjelp?: ReactNode; children: ReactNode }) {
  return (
    <label>
      {etikett}
      {children}
      {hjelp && <span className="felt-hjelp">{hjelp}</span>}
    </label>
  );
}

export function Aarsregnskap({ aar, velg }: { aar: string | null; velg: (aar: string) => void }) {
  const { org } = useKonto();
  const sti = `/org/${org!.id}/regnskap`;
  const d = useData(() => hent<Aarsregnskap>(aar ? `${sti}/aarsregnskap?aar=${aar}` : `${sti}/aarsregnskap`), [sti, aar]);
  const h = useHandling();
  const [skjema, settSkjema] = useState<Skjema | null>(null);
  const [fjor, settFjorMap] = useState<Record<string, string> | null>(null);
  const [melding, settMelding] = useState<string | null>(null);
  const sjekket = useRef<string | null>(null);
  const a = d.data;

  // Mens det sendes: hent statusen på nytt. Venter det på signering: be workeren sjekke Altinn
  // når siden åpnes.
  useEffect(() => {
    if (!a) return;
    if (a.innsending.status === "sender") {
      const t = setTimeout(() => void d.last(), 3000);
      return () => clearTimeout(t);
    }
    if (a.innsending.status === "til_signering" && sjekket.current !== `${a.aar}`) {
      sjekket.current = `${a.aar}`;
      void api<{ sjekkes: boolean }>("POST", `${sti}/aarsregnskap/${a.aar}/sjekk`)
        .then((r) => r.sjekkes && setTimeout(() => void d.last(), 6000))
        .catch(() => {});
    }
    // Venter tilgangen i Altinn på at forespørselen lages: hent på nytt.
    if (a.altinn.status === "venter" || (a.altinn.endring_status === "venter" && !a.altinn.endring_url)) {
      const t = setTimeout(() => void d.last(), 3000);
      return () => clearTimeout(t);
    }
  }, [a?.innsending.status, a?.altinn.status, a?.altinn.endring_status, a?.aar]);

  if (d.feil) return <Feil melding={d.feil} />;
  if (!a) return <Laster />;
  const s = skjema ?? tilSkjema(a);
  const endre = (x: Partial<Skjema>) => settSkjema({ ...s, ...x });
  const i = a.innsending;
  const sendt = SENDT.includes(i.status);
  const endret = skjema !== null;
  const iAar = Number(iDag().slice(0, 4));
  const kjor = async (fn: () => Promise<unknown>, tekst: string) => {
    settMelding(null);
    const r = await h.kjor(fn);
    if (r !== undefined) {
      settMelding(tekst);
      void d.last();
    }
    return r;
  };
  const lagre = async () => {
    settMelding(null);
    const r = await h.kjor(async () => api<Aarsregnskap>("PUT", `${sti}/aarsregnskap/${a.aar}`, fraSkjema(s, a)));
    if (r) {
      d.settData(r);
      settSkjema(null);
      settMelding("Lagret.");
    }
  };
  // Fjorårstallene for hånd (null: tallene fra regnskapet igjen).
  const lagreFjor = async (verdier: () => Record<string, number> | null) => {
    settMelding(null);
    let fraRegnskapet = false;
    const r = await h.kjor(async () => {
      const v = verdier();
      fraRegnskapet = v === null;
      return api<Aarsregnskap>("PUT", `${sti}/aarsregnskap/${a.aar}`, { fjor: v });
    });
    if (r) {
      d.settData(r);
      settFjorMap(null);
      settMelding(fraRegnskapet ? "Fjorårstallene hentes fra regnskapet." : "Fjorårstallene er lagret.");
    }
  };
  const startFjor = () =>
    settFjorMap(Object.fromEntries([...a.resultat, ...a.balanse].filter((l) => l.type === "post" && l.fjor).map((l) => [l.nokkel!, String(l.fjor)])));
  const fjorVerdier = () => {
    const ut: Record<string, number> = {};
    for (const [k, v] of Object.entries(fjor ?? {})) {
      const n = tallFra(v);
      if (Number.isNaN(n) || (n !== null && !Number.isInteger(n))) throw new Error("Fjorårstallene skal være hele kroner");
      if (n) ut[k] = n;
    }
    return ut;
  };

  const merke =
    i.status === "levert" ? (
      <span className="merke merke-ok">Levert</span>
    ) : i.status === "til_signering" ? (
      <span className="merke merke-info">Til signering i Altinn</span>
    ) : i.status === "sender" ? (
      <span className="merke merke-noytral">Sendes</span>
    ) : i.status === "feil" ? (
      <span className="merke merke-fare">Feil ved innsendingen</span>
    ) : a.feil.length ? (
      <span className="merke merke-advarsel">{a.feil.length === 1 ? "1 punkt må rettes" : `${a.feil.length} punkter må rettes`}</span>
    ) : (
      <span className="merke merke-ok">Klar til å sendes</span>
    );
  const aarsresultat = a.resultat.find((l) => l.nokkel === "aarsresultat")?.aarets ?? 0;
  const tilAltinn = !a.altinn.pa
    ? null
    : !a.altinn.status || ["avslatt", "avvist", "utlopt", "feil"].includes(a.altinn.status)
      ? "koble"
      : a.altinn.status !== "godkjent"
        ? "venter"
        : !a.altinn.har_pakke
          ? a.altinn.endring_status === "ny" || a.altinn.endring_status === "venter"
            ? "utvider"
            : "utvid"
          : "klar";

  return (
    <>
      <p className="dempet liten">
        Årsregnskapet til Regnskapsregisteret i Brønnøysund, satt opp for små foretak fra regnskapet. Fyll ut fastsettelsen og notene, og send det til Altinn: daglig
        leder (eller den som har signaturrett) signerer der med BankID, og da er det sendt inn. Fristen er 31. juli året etter.
      </p>
      <div className={`kort aars-kort${a.over && i.status !== "levert" && (a.feil.length || i.status === "feil") ? " gjenstar" : ""}`}>
        <div className="maaned-status-hode">
          <h3>Årsregnskap</h3>
          <div className="ukevelger">
            <button type="button" className="ikon" aria-label="Forrige år" title="Forrige år" onClick={() => velg(String(a.aar - 1))}>
              <IkonVenstre storrelse={20} />
            </button>
            <div className="uke-navn" aria-live="polite">
              <strong>{a.aar}</strong>
              <span>{a.organisasjonsform ? `${a.navn} (${a.organisasjonsform})` : a.navn}</span>
            </div>
            <button type="button" className="ikon" aria-label="Neste år" title="Neste år" disabled={a.aar >= iAar} onClick={() => velg(String(a.aar + 1))}>
              <IkonHoyre storrelse={20} />
            </button>
          </div>
        </div>
        <div className="mva-sum">
          <span className="dempet">{aarsresultat >= 0 ? "Årsresultat" : "Underskudd"}</span>
          <strong>{helKr(Math.abs(aarsresultat))} kr</strong>
          {merke}
        </div>
        {melding && (
          <div className="melding ok" role="status">
            {melding}
          </div>
        )}

        {i.status === "levert" && (
          <div className="melding ok">
            Årsregnskapet for {a.aar} er signert og sendt inn til Regnskapsregisteret{i.levert_at ? ` ${dato(i.levert_at)}` : ""}. Kvitteringen ligger i innboksen i Altinn.
          </div>
        )}
        {i.status === "til_signering" && (
          <div className="melding info med-knapp">
            <span>
              {i.laast
                ? "Årsregnskapet ligger klart i Altinn og venter på signering. Daglig leder (eller den som har signaturrett) åpner det, logger inn med BankID og signerer; da er det sendt inn."
                : "Årsregnskapet ligger i Altinn. Legg ved revisjonsberetningen der, og send det til signering; daglig leder signerer med BankID."}{" "}
              Det ligger også i innboksen til {a.navn} i Altinn.
            </span>
            {i.instans_url && (
              <a className="knapp primar" href={i.instans_url} target="_blank" rel="noreferrer">
                Åpne i Altinn
              </a>
            )}
          </div>
        )}
        {i.status === "sender" && (
          <div className="melding info" role="status">
            <span className="spinner" /> Sendes til Altinn …
          </div>
        )}
        {i.status === "feil" && i.feil && <div className="melding feil">{i.feil}</div>}
        {!!i.valideringsfeil?.length && (
          <ul className="maaned-punkter">
            {i.valideringsfeil.map((v, n) => (
              <li key={n}>
                <span className={`merke ${v.alvor === "feil" ? "merke-fare" : v.alvor === "advarsel" ? "merke-advarsel" : "merke-noytral"}`}>
                  {v.alvor === "feil" ? "Feil" : v.alvor === "advarsel" ? "Advarsel" : "Info"}
                </span>
                <span>
                  {v.tekst}
                  {v.kode ? <span className="dempet"> ({v.kode})</span> : null}
                </span>
              </li>
            ))}
          </ul>
        )}
        {!sendt && (a.feil.length > 0 || a.advarsler.length > 0) && (
          <ul className="maaned-punkter">
            {a.feil.map((f) => (
              <li key={f}>
                <span className="merke merke-advarsel">Må rettes</span>
                <span>
                  {f}
                  {f.includes("Årsoppgjøret") || f.includes("årsoppgjøret") ? (
                    <>
                      {" "}
                      <Link to={`/regnskap?fane=aarsoppgjor&aar=${a.aar}`}>Til årsoppgjøret</Link>
                    </>
                  ) : null}
                </span>
              </li>
            ))}
            {a.advarsler.map((f) => (
              <li key={f}>
                <span className="merke merke-noytral">Sjekk</span>
                <span>{f}</span>
              </li>
            ))}
          </ul>
        )}

        <div className="mva-handlinger">
          <div>
            <strong>Altinn</strong>
            {tilAltinn === null && (
              <p className="liten dempet">
                Innsendingen til Altinn er ikke slått på ennå. Last ned skjemaene (XML) eller PDF-en, og send årsregnskapet selv i Altinn i mellomtiden.
              </p>
            )}
            {tilAltinn === "koble" && (
              <>
                <p className="liten dempet">
                  Organisasjonen må gi Admin Konsoll tilgang i Altinn (en systembruker), med tilgangspakken «{a.altinn.pakke}». Daglig leder (eller den som styrer
                  tilgangene i Altinn) godkjenner det.
                </p>
                <div className="knapper">
                  <button type="button" className="primar" disabled={h.opptatt} onClick={() => void kjor(() => api("POST", `${sti}/altinn/tilgang`), "Forespørselen lages i Altinn …")}>
                    Gi tilgang i Altinn
                  </button>
                </div>
              </>
            )}
            {tilAltinn === "venter" && (
              <>
                <p className="liten dempet">
                  {a.altinn.godkjenn_url ? "Forespørselen venter på godkjenning i Altinn." : "Forespørselen lages i Altinn …"}
                </p>
                <div className="knapper">
                  {a.altinn.godkjenn_url && (
                    <a className="knapp primar" onClick={merkAltinn} href={a.altinn.godkjenn_url}>
                      Godkjenn i Altinn
                    </a>
                  )}
                  <button type="button" disabled={h.opptatt} onClick={() => void kjor(() => api("POST", `${sti}/altinn/sjekk`), "Sjekker godkjenningen i Altinn …")}>
                    Sjekk igjen
                  </button>
                </div>
              </>
            )}
            {(tilAltinn === "utvid" || tilAltinn === "utvider") && (
              <>
                <p className="liten dempet">Tilgangen i Altinn mangler tilgangspakken «{a.altinn.pakke}». Utvid den, og la daglig leder godkjenne endringen.</p>
                <div className="knapper">
                  {tilAltinn === "utvid" && (
                    <button type="button" className="primar" disabled={h.opptatt} onClick={() => void kjor(() => api("POST", `${sti}/altinn/utvid`), "Endringen lages i Altinn …")}>
                      Utvid tilgangen i Altinn
                    </button>
                  )}
                  {tilAltinn === "utvider" && a.altinn.endring_url && (
                    <a className="knapp primar" onClick={merkAltinn} href={a.altinn.endring_url}>
                      Godkjenn i Altinn
                    </a>
                  )}
                  {tilAltinn === "utvider" && (
                    <button type="button" disabled={h.opptatt} onClick={() => void kjor(() => api("POST", `${sti}/altinn/sjekk`), "Sjekker godkjenningen i Altinn …")}>
                      Sjekk igjen
                    </button>
                  )}
                </div>
              </>
            )}
            {tilAltinn === "klar" && (
              <p className="liten dempet">
                <span className="merke merke-ok">Koblet til</span> Admin Konsoll lager skjemaet i Altinn og låser det for signering
                {a.altinn.miljo === "test" ? " (testmiljøet TT02)" : ""}.
              </p>
            )}
          </div>
          <div>
            <strong>Send</strong>
            <p className="liten dempet">
              {i.status === "levert"
                ? "Levert."
                : i.status === "til_signering"
                  ? "Skal noe endres, trekk det tilbake: skjemaet låses opp i Altinn, og du kan sende det på nytt."
                  : !a.over
                    ? "Sendes når året er over."
                    : a.feil.length
                      ? "Rett punktene over først."
                      : endret
                        ? "Lagre endringene først."
                        : "Alt er klart. Årsregnskapet lastes opp til Altinn og låses for signering."}
            </p>
            <div className="knapper">
              {(i.status === "utkast" || i.status === "feil") && (
                <button
                  type="button"
                  className="primar"
                  disabled={h.opptatt || !!a.feil.length || tilAltinn !== "klar" || endret}
                  onClick={() =>
                    confirm(`Sende årsregnskapet for ${a.aar} til Altinn? Det låses der til det er signert.`) &&
                    void kjor(() => api("POST", `${sti}/aarsregnskap/${a.aar}/send`), "Årsregnskapet sendes til Altinn.")
                  }
                >
                  {i.status === "feil" ? "Send på nytt" : "Send til signering i Altinn"}
                </button>
              )}
              {i.status === "til_signering" && (
                <>
                  <button type="button" disabled={h.opptatt} onClick={() => void kjor(() => api("POST", `${sti}/aarsregnskap/${a.aar}/sjekk`), "Sjekker Altinn …")}>
                    Sjekk om det er signert
                  </button>
                  <button
                    type="button"
                    disabled={h.opptatt}
                    onClick={() =>
                      confirm("Trekke årsregnskapet tilbake? Det låses opp i Altinn, og du må sende det på nytt.") &&
                      void kjor(() => api("POST", `${sti}/aarsregnskap/${a.aar}/tilbake`), "Årsregnskapet trekkes tilbake …")
                    }
                  >
                    Trekk tilbake
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
        <div className="aars-saft">
          <div>
            <strong>Last ned</strong>
            <p className="liten dempet">
              PDF-en er til signaturene (styret og daglig leder skal signere årsregnskapet, regnskapsloven § 3-5). Skjemaene er XML-en som sendes til Altinn.
            </p>
          </div>
          <div className="knapper">
            <button type="button" disabled={h.opptatt} onClick={() => void h.kjor(() => lastNed(`${sti}/aarsregnskap/${a.aar}/aarsregnskap.pdf`, `aarsregnskap-${a.aar}.pdf`))}>
              PDF
            </button>
            <button type="button" disabled={h.opptatt} onClick={() => void h.kjor(() => lastNed(`${sti}/aarsregnskap/${a.aar}/hovedskjema.xml`, `aarsregnskap-${a.aar}-hovedskjema.xml`))}>
              Hovedskjema
            </button>
            <button type="button" disabled={h.opptatt} onClick={() => void h.kjor(() => lastNed(`${sti}/aarsregnskap/${a.aar}/underskjema.xml`, `aarsregnskap-${a.aar}-underskjema.xml`))}>
              Underskjema
            </button>
          </div>
        </div>
        <Feil melding={h.feil} />
      </div>

      <fieldset className="aarsregnskap-skjema" disabled={sendt}>
        <div className="kort">
          <h3>Fastsettelse og revisjon</h3>
          {sendt && <p className="liten dempet">Årsregnskapet er sendt til Altinn. Trekk det tilbake for å endre det.</p>}
          <div className="rad">
            <Felt etikett="Fastsatt av generalforsamlingen" hjelp="Datoen årsregnskapet ble godkjent (innen seks måneder etter årets slutt).">
              <input type="date" value={s.fastsettelsesdato} max={iDag()} onChange={(e) => endre({ fastsettelsesdato: e.target.value })} />
            </Felt>
            <Felt
              etikett="Bekreftet av"
              hjelp={
                a.forslag.bekreftende && !s.bekreftende ? (
                  <button type="button" className="lenke" onClick={() => endre({ bekreftende: a.forslag.bekreftende! })}>
                    Bruk {a.forslag.bekreftende}
                  </button>
                ) : (
                  "Den som bekrefter at årsregnskapet er fastsatt, vanligvis daglig leder eller styrelederen."
                )
              }
            >
              <input value={s.bekreftende} maxLength={70} placeholder={a.forslag.bekreftende ?? ""} onChange={(e) => endre({ bekreftende: e.target.value })} />
            </Felt>
          </div>
          <fieldset className="valg-kort">
            <legend>Skal årsregnskapet revideres?</legend>
            <label className={s.revideres === "nei" ? "valgt" : undefined}>
              <input type="radio" name="revideres" checked={s.revideres === "nei"} onChange={() => endre({ revideres: "nei" })} />
              <span>
                <strong>Nei</strong>
                <span className="felt-hjelp">Generalforsamlingen har besluttet at det ikke skal revideres (små aksjeselskap, aksjeloven § 7-6).</span>
              </span>
            </label>
            <label className={s.revideres === "ja" ? "valgt" : undefined}>
              <input type="radio" name="revideres" checked={s.revideres === "ja"} onChange={() => endre({ revideres: "ja" })} />
              <span>
                <strong>Ja</strong>
                <span className="felt-hjelp">Revisjonsberetningen legges ved i Altinn før årsregnskapet signeres.</span>
              </span>
            </label>
          </fieldset>
          <label className="avkrysning">
            <input type="checkbox" checked={s.utarbeidet} onChange={(e) => endre({ utarbeidet: e.target.checked })} /> Årsregnskapet er utarbeidet av en ekstern autorisert
            regnskapsfører
          </label>
          <label className="avkrysning">
            <input type="checkbox" checked={s.bistand} onChange={(e) => endre({ bistand: e.target.checked })} /> En ekstern autorisert regnskapsfører har bistått med
            regnskapsføringen eller andre tjenester i året
          </label>
          <Felt etikett="E-post for svaret fra Regnskapsregisteret" hjelp="Brønnøysundregistrene sender beskjed når årsregnskapet er behandlet.">
            <input type="email" value={s.kontakt_epost} placeholder={a.forslag.kontakt_epost ?? ""} onChange={(e) => endre({ kontakt_epost: e.target.value })} />
          </Felt>
          {endret && (
            <div className="knapper">
              <button type="button" className="primar" disabled={h.opptatt} onClick={() => void lagre()}>
                Lagre
              </button>
              <button type="button" disabled={h.opptatt} onClick={() => settSkjema(null)}>
                Angre
              </button>
            </div>
          )}
        </div>

        <div className="kort">
          <div className="maaned-status-hode">
            <h3>Resultatregnskap og balanse</h3>
            {!sendt && !fjor && a.start === `${a.aar}-01-01` && (
              <button type="button" className="lenke" onClick={startFjor}>
                {a.fjor_for_haand ? "Endre fjorårstallene" : "Legg inn fjorårstallene"}
              </button>
            )}
          </div>
          <p className="liten dempet">
            Fra regnskapet etter årsoppgjøret, i hele kroner. {a.fjor_for_haand ? "Fjorårstallene er lagt inn for hånd." : a.har_fjor ? "Fjorårstallene er fra regnskapet." : ""}
          </p>
          {fjor && (
            <div className="melding info">
              Skriv inn fjorårstallene fra fjorårets årsregnskap (hele kroner, kostnader og gjeld som positive tall). Summene regnes ut.
              <div className="knapper">
                <button
                  type="button"
                  className="primar"
                  disabled={h.opptatt}
                  onClick={() => void lagreFjor(fjorVerdier)}
                >
                  Lagre fjorårstallene
                </button>
                {a.fjor_for_haand && (
                  <button type="button" disabled={h.opptatt} onClick={() => void lagreFjor(() => null)}>
                    Bruk tallene fra regnskapet
                  </button>
                )}
                <button type="button" disabled={h.opptatt} onClick={() => settFjorMap(null)}>
                  Avbryt
                </button>
              </div>
            </div>
          )}
          <div className="aars-tabeller">
            <Oppstilling tittel="Resultatregnskap" linjer={a.resultat} a={a} fjor={fjor} settFjor={(k, v) => settFjorMap({ ...fjor, [k]: v })} />
            <Oppstilling tittel={`Balanse ${dato(a.slutt)}`} linjer={a.balanse} a={a} fjor={fjor} settFjor={(k, v) => settFjorMap({ ...fjor, [k]: v })} />
          </div>
        </div>

        <div className="kort">
          <h3>Noter</h3>
          <Felt etikett="Regnskapsprinsipper">
            <textarea rows={8} value={s.prinsipper} onChange={(e) => endre({ prinsipper: e.target.value })} />
          </Felt>
          {s.prinsipper.trim() !== a.noter.prinsipper_standard.trim() && (
            <button type="button" className="lenke" onClick={() => endre({ prinsipper: a.noter.prinsipper_standard })}>
              Bruk standardteksten
            </button>
          )}
          <label className="avkrysning">
            <input type="checkbox" checked={s.usikkerhet} onChange={(e) => endre({ usikkerhet: e.target.checked })} /> Det er usikkerhet om fortsatt drift
          </label>
          {s.usikkerhet && (
            <Felt etikett="Usikkerheten om fortsatt drift">
              <textarea rows={3} value={s.usikkerhet_tekst} onChange={(e) => endre({ usikkerhet_tekst: e.target.value })} />
            </Felt>
          )}
          <div className="rad">
            <Felt etikett="Antall årsverk" hjelp={`Forslag fra de ansatte: ${tekstFra(a.noter.aarsverk_forslag)}. Har dere ingen årsverk, er det 0.`}>
              <input inputMode="decimal" value={s.aarsverk} placeholder={tekstFra(a.noter.aarsverk_forslag)} onChange={(e) => endre({ aarsverk: e.target.value })} />
            </Felt>
          </div>
          {a.noter.lonn && (
            <div className="tabell">
              <table className="aars-tabell">
                <thead>
                  <tr>
                    <th>Lønnskostnader</th>
                    <th className="tall">{a.aar}</th>
                    {a.har_fjor && <th className="tall aars-fjor">{a.aar - 1}</th>}
                  </tr>
                </thead>
                <tbody>
                  {a.noter.lonn.map((l) => (
                    <tr key={l.navn}>
                      <td className="innrykk">{l.navn}</td>
                      <td className="tall">{helKr(l.aarets)}</td>
                      {a.har_fjor && <td className="tall dempet aars-fjor">{helKr(l.fjor)}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <fieldset className="valg-kort">
            <legend>Lån og sikkerhetsstillelse til ledende personer og aksjeeiere</legend>
            <label className={!s.laan_gitt ? "valgt" : undefined}>
              <input type="radio" name="laan" checked={!s.laan_gitt} onChange={() => endre({ laan_gitt: false })} />
              <span>
                <strong>Ingen</strong>
                <span className="felt-hjelp">Det er ikke gitt lån eller stilt sikkerhet for daglig leder, styret, aksjeeiere eller nærstående.</span>
              </span>
            </label>
            <label className={s.laan_gitt ? "valgt" : undefined}>
              <input type="radio" name="laan" checked={s.laan_gitt} onChange={() => endre({ laan_gitt: true })} />
              <span>
                <strong>Ja</strong>
                <span className="felt-hjelp">Beløpene, rentesatsen og hovedvilkårene (regnskapsloven § 7-36).</span>
              </span>
            </label>
          </fieldset>
          {s.laan_gitt && (
            <>
              <div className="rad">
                <Felt etikett="Lån til styret (kr)">
                  <input inputMode="decimal" value={s.laan_styret} onChange={(e) => endre({ laan_styret: e.target.value })} />
                </Felt>
                <Felt etikett="Lån til andre (kr)">
                  <input inputMode="decimal" value={s.laan_andre} onChange={(e) => endre({ laan_andre: e.target.value })} />
                </Felt>
              </div>
              <div className="rad">
                <Felt etikett="Sikkerhet for styret (kr)">
                  <input inputMode="decimal" value={s.sikkerhet_styret} onChange={(e) => endre({ sikkerhet_styret: e.target.value })} />
                </Felt>
                <Felt etikett="Sikkerhet for andre (kr)">
                  <input inputMode="decimal" value={s.sikkerhet_andre} onChange={(e) => endre({ sikkerhet_andre: e.target.value })} />
                </Felt>
              </div>
              <div className="rad">
                <Felt etikett="Rentesats, styret (%)">
                  <input value={s.rente_styret} maxLength={12} onChange={(e) => endre({ rente_styret: e.target.value })} />
                </Felt>
                <Felt etikett="Rentesats, andre (%)">
                  <input value={s.rente_andre} maxLength={12} onChange={(e) => endre({ rente_andre: e.target.value })} />
                </Felt>
              </div>
              <Felt etikett="Hovedvilkår og annet om lånene">
                <textarea rows={3} value={s.laan_tekst} onChange={(e) => endre({ laan_tekst: e.target.value })} />
              </Felt>
            </>
          )}
          <details className="aarsregnskap-gjeld" open={Boolean(s.gjeld_fem || s.gjeld_pant || s.gjeld_pantsatte || s.gjeld_garantier || s.gjeld_tekst)}>
            <summary>Gjeld og pant (når det gjelder)</summary>
            <div className="rad">
              <Felt etikett="Gjeld som forfaller om mer enn fem år (kr)">
                <input inputMode="decimal" value={s.gjeld_fem} onChange={(e) => endre({ gjeld_fem: e.target.value })} />
              </Felt>
              <Felt etikett="Gjeld sikret ved pant (kr)">
                <input inputMode="decimal" value={s.gjeld_pant} onChange={(e) => endre({ gjeld_pant: e.target.value })} />
              </Felt>
            </div>
            <div className="rad">
              <Felt etikett="Bokført verdi av de pantsatte eiendelene (kr)">
                <input inputMode="decimal" value={s.gjeld_pantsatte} onChange={(e) => endre({ gjeld_pantsatte: e.target.value })} />
              </Felt>
              <Felt etikett="Garantier som ikke er regnskapsført (kr)">
                <input inputMode="decimal" value={s.gjeld_garantier} onChange={(e) => endre({ gjeld_garantier: e.target.value })} />
              </Felt>
            </div>
            <Felt etikett="Mer om gjelden">
              <textarea rows={2} value={s.gjeld_tekst} onChange={(e) => endre({ gjeld_tekst: e.target.value })} />
            </Felt>
          </details>
          <Felt etikett="Andre opplysninger" hjelp="Det som ellers bør stå i notene (valgfritt).">
            <textarea rows={3} value={s.ytterligere} onChange={(e) => endre({ ytterligere: e.target.value })} />
          </Felt>
          {endret && (
            <div className="knapper">
              <button type="button" className="primar" disabled={h.opptatt} onClick={() => void lagre()}>
                Lagre
              </button>
              <button type="button" disabled={h.opptatt} onClick={() => settSkjema(null)}>
                Angre
              </button>
            </div>
          )}
        </div>
      </fieldset>
    </>
  );
}
