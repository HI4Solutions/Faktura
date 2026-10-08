// Import av kunder, produkter og ansatte fra andre systemer: fil (Excel, CSV) eller rader limt
// inn fra et regneark. Kolonnene kobles til feltene automatisk og kan endres; API-et prøver
// importen først, så man ser hva som blir nytt, hva som finnes fra før og hva som har feil.
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api, hent, sendFil } from "../api";
import { Feil, Laster, useData } from "../felles";
import { harFunksjon, kanPersonal, kanSkrive, useKonto } from "../konto";
import { dato, kr, orgnr } from "../format";
import { IkonHake, IkonOpplasting } from "../ikoner";
import {
  erLonnsslipp,
  FELT,
  gjett,
  harOverskrifter,
  koble,
  lesFil,
  lesTekst,
  mal,
  rensCelle,
  slippBlob,
  SLIPP_ACCEPT,
  tilRader,
  type Importtype,
  type Innlest,
  type Lonnsslipper,
} from "../importer";

const MAKS: Record<Importtype, number> = { kunder: 5000, produkter: 5000, ansatte: 2000 }; // rader per import (API-ets grense)
const VIS = 200; // rader i forhåndsvisningen

type Status = "ny" | "oppdater" | "hopp" | "feil";
interface Svar {
  antall: Record<Status, number>;
  rader: { nr: number; status: Status; grunn?: string }[];
}

const ORD = {
  kunder: { en: "kunde", flere: "kunder", ny: "ny", liste: "/kunder", likhet: "Samme org.nr., eller samme e-post eller navn når org.nr. mangler." },
  produkter: { en: "produkt", flere: "produkter", ny: "nytt", liste: "/produkter", likhet: "Samme varenummer, eller samme navn når varenummer mangler." },
  ansatte: { en: "ansatt", flere: "ansatte", ny: "ny", liste: "/ansatte", likhet: "Samme e-post, eller samme navn når e-post mangler." },
};

const STATUS: Record<Status, { merke: string; klasse: string; fane: string }> = {
  ny: { merke: "Ny", klasse: "merke-ok", fane: "Nye" },
  oppdater: { merke: "Oppdateres", klasse: "merke-info", fane: "Oppdateres" },
  hopp: { merke: "Hoppes over", klasse: "merke-noytral", fane: "Hoppes over" },
  feil: { merke: "Feil", klasse: "merke-fare", fane: "Feil" },
};

// Kolonnenavn som i Excel: A, B … Z, AA …
function bokstav(i: number) {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

const kort = (s: string, n = 40) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
// Lønnen til en ansatt i forhåndsvisningen: månedslønn eller timelønn (verdier som ikke kunne
// tolkes, vises som de står).
const lonnTekst = (d: Record<string, any>) => {
  const vis = (v: unknown, enhet: string) => (typeof v === "number" ? `${kr(v)} kr${enhet}` : String(v));
  if (d.lonnstype === "time" || (d.timelonn !== undefined && d.maanedslonn === undefined)) return d.timelonn !== undefined ? vis(d.timelonn, "/t") : "";
  return d.maanedslonn !== undefined ? vis(d.maanedslonn, "/mnd") : "";
};
const setning = (d: string[]) => (d.length < 2 ? (d[0] ?? "") : `${d.slice(0, -1).join(", ")} og ${d[d.length - 1]}`) + ".";

export function Importer({ type }: { type: Importtype }) {
  const { org } = useKonto();
  const o = ORD[type];
  const orgData = useData(() => hent(`/org/${org!.id}`), [org?.id]);
  const [innlest, settInnlest] = useState<Innlest | null>(null);
  const [filnavn, settFilnavn] = useState("");
  const [arkNr, settArkNr] = useState(0);
  const [overskrift, settOverskrift] = useState(true);
  const [kobling, settKobling] = useState<(string | null)[]>([]);
  const [duplikater, settDuplikater] = useState<"hopp" | "oppdater">("hopp");
  const [plan, settPlan] = useState<Svar | null>(null);
  const [kontrollerer, settKontrollerer] = useState(false);
  const [feil, settFeil] = useState<string | null>(null);
  const [lesFeil, settLesFeil] = useState<string | null>(null);
  const [leser, settLeser] = useState(false);
  const [limer, settLimer] = useState(false);
  const [limt, settLimt] = useState("");
  const [drar, settDrar] = useState(false);
  const [filter, settFilter] = useState<Status | "alle">("alle");
  const [importerer, settImporterer] = useState(false);
  const [ferdig, settFerdig] = useState<Svar | null>(null);
  // Ansatte fra lønnsslipper (PDF eller bilde), lest med AI: radene er ferdige, uten kolonner å koble.
  const [slipp, settSlipp] = useState<Lonnsslipper | null>(null);
  const foresporsel = useRef(0);
  const aiPaa = type === "ansatte" && harFunksjon(org, "ai") && Boolean(orgData.data?.ai_tilgjengelig && orgData.data?.ai_aktiv);

  const ark = innlest?.ark[arkNr];
  const bredde = ark ? Math.max(0, ...ark.rader.map((r) => r.length)) : 0;
  const dataRader = useMemo(() => (ark ? ark.rader.slice(overskrift ? 1 : 0) : []), [ark, overskrift]);
  const radnr = useMemo(() => (slipp ? slipp.ansatte.map((_, i) => i + 1) : ark ? ark.radnr.slice(overskrift ? 1 : 0) : []), [ark, overskrift, slipp]);
  const mvaRegistrert = orgData.data?.mva_registrert !== false;
  const rader = useMemo(
    () => slipp?.ansatte ?? tilRader(type, dataRader, kobling, { kilde: innlest?.kilde ?? "tekst", mvaRegistrert, overskrifter: overskrift ? ark?.rader[0] : undefined }),
    [type, dataRader, kobling, innlest, mvaRegistrert, overskrift, ark, slipp],
  );

  const har = (f: string) => kobling.includes(f);
  const mangler = !ark || slipp
    ? null
    : type === "kunder"
      ? !har("navn") && !har("fornavn") && !har("etternavn")
        ? "Velg hvilken kolonne som har navnet på kunden."
        : null
      : type === "ansatte"
        ? !har("navn") && !(har("fornavn") && har("etternavn"))
          ? "Velg hvilke kolonner som har navnet: hele navnet, eller fornavn og etternavn."
          : null
        : !har("navn") && !har("beskrivelse")
          ? "Velg hvilken kolonne som har navnet på produktet."
          : null;
  // Uten priskolonne får produktene variabel pris (fylles inn på fakturaen).
  const utenPris = type === "produkter" && ark && !mangler && !har("enhetspris") && !har("pris_inkl");
  const forMange = rader.length > MAKS[type];

  // Prøvekjøring i API-et hver gang radene eller valget for duplikater endres.
  useEffect(() => {
    const nr = ++foresporsel.current;
    if ((!ark && !slipp) || mangler || !rader.length || forMange) {
      settPlan(null);
      settKontrollerer(false);
      return;
    }
    settKontrollerer(true);
    const t = setTimeout(async () => {
      try {
        const s = await api<Svar>("POST", `/org/${org!.id}/${type}/importer`, { rader, duplikater, proving: true });
        if (nr !== foresporsel.current) return;
        settPlan(s);
        settFeil(null);
      } catch (e) {
        if (nr !== foresporsel.current) return;
        settPlan(null);
        settFeil((e as Error).message);
      }
      settKontrollerer(false);
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rader, duplikater, mangler, forMange]);

  const lagKobling = (r: string[][], medOverskrift: boolean) => {
    const b = Math.max(0, ...r.map((x) => x.length));
    const k = medOverskrift ? koble(type, r[0] ?? []) : gjett(type, r);
    return Array.from({ length: b }, (_, i) => k[i] ?? null);
  };

  function velgArk(inn: Innlest, nr: number) {
    const a = inn.ark[nr]!;
    const medOverskrift = harOverskrifter(type, a.rader[0]);
    settArkNr(nr);
    settOverskrift(medOverskrift);
    settKobling(lagKobling(a.rader, medOverskrift));
    settFilter("alle");
  }

  function ta(inn: Innlest, navn: string) {
    if (!inn.ark.some((a) => a.rader.length)) {
      settLesFeil("Fant ingen rader å importere.");
      return;
    }
    settLesFeil(null);
    settFeil(null);
    settInnlest(inn);
    settFilnavn(navn);
    settLimer(false);
    velgArk(inn, Math.max(0, inn.ark.findIndex((a) => a.rader.length)));
  }

  async function brukFil(fil: File | undefined) {
    if (!fil) return;
    settLeser(true);
    settLesFeil(null);
    try {
      if (aiPaa && erLonnsslipp(fil)) {
        const s = await sendFil<Lonnsslipper>(`/org/${org!.id}/ai/lonnsslipp`, slippBlob(fil), "Fila er for stor. Lønnsslipper kan være høyst 12 MB (del opp en stor PDF).");
        settFeil(null);
        settFilter("alle");
        settFilnavn(fil.name);
        settSlipp(s);
        return;
      }
      if (erLonnsslipp(fil) && type === "ansatte") throw new Error("Lønnsslipper (PDF eller bilde) kan leses når AI er slått på for organisasjonen. Bruk en Excel- eller CSV-fil i stedet.");
      ta(await lesFil(fil), fil.name);
    } catch (e) {
      settLesFeil((e as Error).message);
    } finally {
      settLeser(false);
    }
  }

  function nullstill() {
    settSlipp(null);
    settInnlest(null);
    settFilnavn("");
    settKobling([]);
    settPlan(null);
    settFerdig(null);
    settFeil(null);
    settLimt("");
    settDuplikater("hopp");
  }

  function velgFelt(k: number, f: string | null) {
    settKobling((gammel) => gammel.map((x, i) => (i === k ? f : x === f ? null : x)));
  }

  function lastNedMal() {
    const url = URL.createObjectURL(new Blob([mal(type)], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${o.flere}-mal.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // Feilmeldinger fra API-et bruker radnummeret i importen; vis radnummeret i fila.
  const iFila = (melding: string) => melding.replace(/^Rad (\d+):/, (_, n) => `Rad ${radnr[Number(n) - 1] ?? n}:`);

  async function importer() {
    settImporterer(true);
    settFeil(null);
    try {
      settFerdig(await api<Svar>("POST", `/org/${org!.id}/${type}/importer`, { rader, duplikater }));
      window.scrollTo({ top: 0 });
    } catch (e) {
      settFeil(iFila((e as Error).message));
    } finally {
      settImporterer(false);
    }
  }

  if (!(type === "ansatte" ? kanPersonal(org?.rolle) : kanSkrive(org?.rolle))) return <Feil melding={`Du har ikke tilgang til å importere ${o.flere}.`} />;
  if (type === "ansatte" && !org?.personal)
    return <Feil melding="Ansatte og timer er ikke slått på. Slå det på under Innstillinger → Ansatte og timer." />;

  const tittel = <h1>Importer {o.flere}</h1>;

  if (ferdig) {
    const a = ferdig.antall;
    const deler: string[] = [];
    if (a.ny) deler.push(`${a.ny} ${a.ny === 1 ? `${o.ny} ${o.en}` : `nye ${o.flere}`} er lagt til`);
    if (a.oppdater) deler.push(`${a.oppdater} er oppdatert`);
    if (a.hopp) deler.push(`${a.hopp} ${a.hopp === 1 ? "fantes" : "fantes"} fra før og ble hoppet over`);
    if (a.feil) deler.push(`${a.feil} ${a.feil === 1 ? "rad" : "rader"} med feil ble ikke importert`);
    return (
      <>
        <div className="topp">{tittel}</div>
        <div className="kort import-ferdig" role="status">
          <div className="ikonboks">
            <IkonHake storrelse={26} />
          </div>
          <h2>Importen er ferdig</h2>
          <p>{deler.length ? setning(deler) : "Ingenting ble importert."}</p>
          {type === "kunder" && a.ny > 0 && <p className="dempet liten">Om de nye kundene kan motta EHF, sjekkes av seg selv i løpet av noen minutter.</p>}
          {type === "ansatte" && a.ny > 0 && (
            <p className="dempet liten">Åpne de ansatte for å legge inn faste arbeidsdager eller gi dem egen innlogging, så de kan føre timene sine selv.</p>
          )}
          <div className="knapper">
            <Link className="knapp primar" to={o.liste}>
              Til {o.flere}
            </Link>
            <button type="button" onClick={nullstill}>
              Importer en fil til
            </button>
          </div>
        </div>
      </>
    );
  }

  if ((!innlest || !ark) && !slipp) {
    return (
      <>
        <div className="topp">{tittel}</div>
        <p className="undertittel">
          Hent {o.flere} fra {type === "ansatte" ? "lønnssystemet (Tripletex, Visma, PowerOffice, Fiken …), Excel" : "Fiken, Tripletex, Visma, PowerOffice, Excel"} eller et annet
          system.
        </p>
        <label
          className={`slipp${drar ? " over" : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            settDrar(true);
          }}
          onDragLeave={() => settDrar(false)}
          onDrop={(e) => {
            e.preventDefault();
            settDrar(false);
            brukFil(e.dataTransfer.files[0]);
          }}
        >
          <span className="ikonboks">
            <IkonOpplasting storrelse={24} />
          </span>
          <strong>{leser ? (aiPaa ? "Leser fila … (lønnsslipper tar litt tid)" : "Leser fila …") : "Velg en fil, eller dra den hit"}</strong>
          <span className="dempet">{aiPaa ? "Excel (.xlsx), CSV eller lønnsslipper (PDF eller bilde)" : "Excel (.xlsx) eller CSV"}</span>
          <input
            type="file"
            disabled={leser}
            accept={`.xlsx,.csv,.txt,.tsv,text/csv,text/plain,text/tab-separated-values,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet${aiPaa ? `,${SLIPP_ACCEPT}` : ""}`}
            onChange={(e) => {
              brukFil(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
        </label>
        <Feil melding={lesFeil} />
        {limer ? (
          <div className="kort">
            <label>
              Lim inn rader fra et regneark
              <textarea
                rows={8}
                autoFocus
                spellCheck={false}
                value={limt}
                placeholder="Merk radene i Excel, Numbers eller Google Regneark (gjerne med overskriftene), kopier og lim inn her."
                onChange={(e) => settLimt(e.target.value)}
              />
            </label>
            <div className="knapper">
              <button type="button" className="primar" disabled={!limt.trim()} onClick={() => ta(lesTekst(limt), "Innlimte rader")}>
                Les inn
              </button>
              <button type="button" onClick={() => settLimer(false)}>
                Avbryt
              </button>
            </div>
          </div>
        ) : (
          <p>
            <button type="button" className="lenke" onClick={() => settLimer(true)}>
              Eller lim inn rader fra et regneark
            </button>
          </p>
        )}
        <div className="kort">
          <h2>Slik gjør du</h2>
          <ol className="import-steg">
            <li>Eksporter {o.flere} som Excel eller CSV fra systemet du bruker i dag.</li>
            <li>Velg fila her. Kolonnene kjennes igjen automatisk, og du kan endre koblingen.</li>
            <li>Se hva som blir nytt, hva som finnes fra før og hva som har feil, før noe lagres.</li>
          </ol>
          {aiPaa && (
            <p className="liten">
              Har du lønnsslipper fra lønnssystemet (PDF eller bilde, gjerne alle de ansatte i én PDF)? Velg dem her, så leser AI ut navn, adresse, fødselsnummer,
              kontonummer, stilling, lønn, faste tillegg og andre opplysninger lønnen trenger (de havner i notatet). Du ser alt før noe lagres.
            </p>
          )}
          <p className="liten dempet">
            Har du ingen fil?{" "}
            <button type="button" className="lenke" onClick={lastNedMal}>
              Last ned en mal
            </button>{" "}
            og fyll den ut i Excel.
          </p>
        </div>
      </>
    );
  }

  const tellFinnes = plan?.rader.filter((r) => r.grunn === "Finnes fra før").length ?? 0;
  if (!ark && !slipp) return null;
  const lagres = plan ? plan.antall.ny + plan.antall.oppdater : 0;
  const filtrert = plan ? plan.rader.filter((r) => filter === "alle" || r.status === filter) : [];
  const navnPaKolonne = (k: number) => (overskrift ? rensCelle(ark?.rader[0]?.[k] ?? "") : "") || `Kolonne ${bokstav(k)}`;
  const brukerFelt = (f: string, unntatt: number) => {
    const k = kobling.findIndex((x, i) => x === f && i !== unntatt);
    return k >= 0 ? navnPaKolonne(k) : null;
  };

  return (
    <>
      <div className="topp">{tittel}</div>
      {slipp ? (
        <>
          <div className="kort import-fil">
            <div className="import-filnavn">
              <strong>{filnavn}</strong>
              <span className="dempet">
                {" "}
                · {slipp.ansatte.length} {slipp.ansatte.length === 1 ? "ansatt" : "ansatte"} lest fra lønnsslippene med AI
              </span>
            </div>
            <button type="button" onClick={nullstill}>
              Bytt fil
            </button>
          </div>
          <p className="undertittel liten">
            Sjekk opplysningene før du importerer. Andre opplysninger fra lønnsslippene (skattetrekk, feriepenger, pensjon …) legges i notatet på den ansatte.
          </p>
          {slipp.merknader.length > 0 && (
            <div className="melding info">
              {slipp.merknader.map((m) => (
                <div key={m}>{m}</div>
              ))}
            </div>
          )}
        </>
      ) : (
        ark &&
        innlest && (
          <>
            <div className="kort import-fil">
              <div className="import-filnavn">
                <strong>{filnavn}</strong>
                <span className="dempet">
                  {" "}
                  · {dataRader.length} {dataRader.length === 1 ? "rad" : "rader"}
                </span>
              </div>
              {innlest.ark.length > 1 && (
                <label>
                  Ark
                  <select value={arkNr} onChange={(e) => velgArk(innlest, Number(e.target.value))}>
                    {innlest.ark.map((a, i) => (
                      <option key={i} value={i}>
                        {a.navn}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label>
                <input
                  type="checkbox"
                  checked={overskrift}
                  onChange={(e) => {
                    settOverskrift(e.target.checked);
                    settKobling(lagKobling(ark.rader, e.target.checked));
                  }}
                />
                Første rad er overskrifter
              </label>
              <button type="button" onClick={nullstill}>
                Bytt fil
              </button>
            </div>

            <h2>Kolonner</h2>
            <p className="undertittel liten">Velg hva hver kolonne skal bli. Kolonner du ikke trenger, lar du stå som «Ikke importer».</p>
            <div className="kort tabell">
              <table className="stabel import-kolonner">
                <thead>
                  <tr>
                    <th style={{ width: "28%" }}>Kolonne i fila</th>
                    <th>Eksempler</th>
                    <th style={{ width: 290 }}>Importer som</th>
                  </tr>
                </thead>
                <tbody>
                  {Array.from({ length: bredde }, (_, k) => {
                    const navn = navnPaKolonne(k);
                    // Fødselsnumre vises ikke i sin helhet (bare fødselsdatoen).
                    const eksempler = dataRader
                      .map((r) => rensCelle(r[k] ?? ""))
                      .filter(Boolean)
                      .slice(0, 3)
                      .map((e) => (kobling[k] === "fnr" && /^\d{11}$/.test(e.replace(/[\s.]/g, "")) ? `${e.replace(/[\s.]/g, "").slice(0, 6)}•••••` : e));
                    return (
                      <tr key={k} className={kobling[k] ? undefined : "av"}>
                        <td className="tittel hel">{navn}</td>
                        <td className="hel eksempler">{eksempler.length ? eksempler.map((e) => kort(e)).join(" · ") : "(tom)"}</td>
                        <td className="hel">
                          <select aria-label={`Importer «${navn}» som`} value={kobling[k] ?? ""} onChange={(e) => velgFelt(k, e.target.value || null)}>
                            <option value="">Ikke importer</option>
                            {FELT[type].map((f) => {
                              const annen = brukerFelt(f.id, k);
                              return (
                                <option key={f.id} value={f.id}>
                                  {f.navn}
                                  {annen ? ` (nå: ${kort(annen, 24)})` : ""}
                                </option>
                              );
                            })}
                          </select>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )
      )}

      <h2>Forhåndsvisning</h2>
      {mangler && <div className="melding info">{mangler}</div>}
      {utenPris && <div className="melding info">Ingen kolonne er koblet til pris. Produktene får variabel pris, som fylles inn når de brukes på en faktura.</div>}
      {!rader.length && <div className="melding info">Det er ingen rader under overskriftene.</div>}
      {forMange && <Feil melding={`Fila har ${rader.length} rader. Del den opp i filer med høyst ${MAKS[type]} rader.`} />}
      <Feil melding={feil} />
      {!plan && kontrollerer && <Laster />}
      {plan && (
        <>
          <div className="import-tall" aria-live="polite">
            {(["ny", "oppdater", "hopp", "feil"] as const)
              .filter((s) => plan.antall[s] > 0)
              .map((s) => (
                <span key={s} className={`merke ${STATUS[s].klasse}`}>
                  {plan.antall[s]} {s === "ny" ? (plan.antall.ny === 1 ? o.ny : "nye") : s === "oppdater" ? "oppdateres" : s === "hopp" ? "hoppes over" : "med feil"}
                </span>
              ))}
            {kontrollerer && <span className="spinner" aria-label="Kontrollerer" />}
          </div>
          {tellFinnes > 0 && (
            <fieldset className="import-duplikater">
              <legend>
                {tellFinnes} {tellFinnes === 1 ? o.en : o.flere} finnes fra før
              </legend>
              <p className="liten dempet">{o.likhet}</p>
              <label>
                <input type="radio" name="duplikater" checked={duplikater === "hopp"} onChange={() => settDuplikater("hopp")} />
                Hopp over, og behold det som står i appen
              </label>
              <label>
                <input type="radio" name="duplikater" checked={duplikater === "oppdater"} onChange={() => settDuplikater("oppdater")} />
                Oppdater med verdiene fra fila (tomme celler endrer ingenting)
              </label>
            </fieldset>
          )}
          <div className="faner" role="tablist">
            {(["alle", "ny", "oppdater", "hopp", "feil"] as const)
              .filter((s) => s === "alle" || plan.antall[s] > 0)
              .map((s) => (
                <button key={s} type="button" role="tab" aria-selected={filter === s} className={filter === s ? "valgt" : undefined} onClick={() => settFilter(s)}>
                  {s === "alle" ? "Alle" : STATUS[s].fane} ({s === "alle" ? plan.rader.length : plan.antall[s]})
                </button>
              ))}
          </div>
          <div className={`kort tabell${kontrollerer ? " oppdateres" : ""}`}>
            <table className="stabel import-rader">
              <thead>
                <tr>
                  <th style={{ width: 60 }}>Rad</th>
                  <th>Navn</th>
                  {type === "kunder" ? (
                    <>
                      <th>Org.nr.</th>
                      <th>E-post</th>
                      <th>Poststed</th>
                    </>
                  ) : type === "ansatte" ? (
                    <>
                      <th>Stilling</th>
                      <th className="hoyre">Lønn</th>
                      <th>Ansatt fra</th>
                    </>
                  ) : (
                    <>
                      <th>Varenr.</th>
                      <th className="hoyre">Pris eks. mva</th>
                      <th className="hoyre">Mva</th>
                    </>
                  )}
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {filtrert.slice(0, VIS).map((p) => {
                  const d = (rader[p.nr - 1] ?? {}) as Record<string, any>;
                  const navn = type === "ansatte" ? [d.fornavn, d.etternavn].filter(Boolean).join(" ") : d.navn;
                  return (
                    <tr key={p.nr}>
                      <td className="radnr">{radnr[p.nr - 1] ?? p.nr}</td>
                      <td className="navn">{navn || <span className="dempet">(uten navn)</span>}</td>
                      {type === "ansatte" ? (
                        <>
                          <td data-label="Stilling">
                            {[d.stilling, typeof d.stillingsprosent === "number" ? `${String(d.stillingsprosent).replace(".", ",")} %` : d.stillingsprosent]
                              .filter(Boolean)
                              .join(" · ")}
                          </td>
                          <td data-label="Lønn" className="tall">
                            {lonnTekst(d)}
                            {Array.isArray(d.tillegg) &&
                              d.tillegg.map((t: any, i: number) => (
                                <span key={i} className="tillegg-liten">
                                  + {t.navn} {typeof t.belop === "number" ? `${kr(t.belop)} kr` : t.belop}
                                  {t.per === "time" ? "/t" : "/mnd"}
                                </span>
                              ))}
                          </td>
                          <td data-label="Ansatt fra">{typeof d.ansatt_fra === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d.ansatt_fra) ? dato(d.ansatt_fra) : d.ansatt_fra}</td>
                        </>
                      ) : type === "kunder" ? (
                        <>
                          <td data-label="Org.nr.">{typeof d.orgnr === "string" && /^\d{9}$/.test(d.orgnr) ? orgnr(d.orgnr) : d.orgnr}</td>
                          <td data-label="E-post" className="epost">
                            {d.epost}
                          </td>
                          <td data-label="Poststed">{[d.postnr, d.poststed].filter(Boolean).join(" ")}</td>
                        </>
                      ) : (
                        <>
                          <td data-label="Varenr.">{d.varenummer}</td>
                          <td data-label="Pris eks. mva" className="tall">
                            {typeof d.enhetspris === "number" ? kr(d.enhetspris) : (d.enhetspris ?? <span className="dempet">Variabel</span>)}
                          </td>
                          <td data-label="Mva" className="tall">
                            {typeof d.mva_sats === "number" ? `${d.mva_sats} %` : d.mva_sats}
                          </td>
                        </>
                      )}
                      <td className="status">
                        <span className="radnr-mobil">Rad {radnr[p.nr - 1] ?? p.nr}</span>
                        <span className={`merke ${STATUS[p.status].klasse}`}>{STATUS[p.status].merke}</span>
                        {p.grunn && <span className={`grunn${p.status === "feil" ? " feil" : ""}`}>{p.grunn}</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {filtrert.length > VIS && (
            <p className="liten dempet">
              Viser de første {VIS} av {filtrert.length} radene.
            </p>
          )}
        </>
      )}
      <div className="knapper import-knapper">
        <button type="button" className="primar" disabled={!plan || kontrollerer || importerer || lagres === 0} onClick={importer}>
          {importerer ? "Importerer …" : lagres ? `Importer ${lagres} ${lagres === 1 ? o.en : o.flere}` : "Importer"}
        </button>
        <Link className="knapp" to={o.liste}>
          Avbryt
        </Link>
      </div>
    </>
  );
}
