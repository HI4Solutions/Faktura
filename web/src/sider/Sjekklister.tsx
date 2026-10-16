// Sjekklister (server/src/sjekklister.ts, 0114_sjekklister.sql; funksjonen «Sjekklister» i Personal):
// administrator lager sjekklister med punkter som gjøres daglig, ukentlig, månedlig eller ved behov,
// av alle eller av rollene som har dem (f.eks. varemottak for lageret). Den som gjør en sjekkliste,
// svarer «Normalt» eller «Avvik» med en kommentar på hvert punkt (eller «Alt normalt» på resten) og
// fullfører; avvikene går til administrator, som lukker dem med det som er gjort, og den som meldte
// avviket, får beskjed. Fanene: Å gjøre, Avvik, Historikk og (administrator) Oppsett. En utfylling
// åpnes med ?utfylling=<id> i adressen, så tilbake-knappen virker og oversiktene kan lenke rett dit.
// Rapportene ligger i rapportmodulen (Rapporter → Personal).
import { useEffect, useRef, useState, type ClipboardEvent, type FormEvent, type ReactNode } from "react";
import { Link, useLocation, useSearchParams } from "react-router-dom";
import { api, hent } from "../api";
import { Dialog, Feil, Laster, Tom, useData, useHandling } from "../felles";
import { useKonto } from "../konto";
import { dato, iDag, leggTilDager } from "../format";
import { erHelg, middag, ukenr, visDag } from "../uke";
import { MND } from "../lonn";
import { IkonHake, IkonLukk, IkonNed, IkonOpp, IkonPluss, IkonSjekkliste, IkonVarsel, IkonVenstre } from "../ikoner";
import { antall, type Oppgave } from "./OversiktDeler";

export type Frekvens = "daglig" | "ukentlig" | "maanedlig" | "ved_behov";
type Punkt = { id: string; tekst: string; hjelp: string | null };
// Utfyllingen for denne perioden (ved behov: den innloggedes egen som ikke er fullført).
type Naa = {
  id: string;
  status: "pagar" | "fullfort";
  periode: string;
  startet_navn: string;
  fullfort: string | null;
  fullfort_navn: string | null;
  besvart: number;
  avvik: number;
};
type Sist = { id: string; periode: string; fullfort: string; fullfort_navn: string; avvik: number };
export type Sjekkliste = {
  id: string;
  navn: string;
  beskrivelse: string | null;
  frekvens: Frekvens;
  roller: string[]; // tom: alle
  aktiv: boolean;
  min: boolean; // den innloggede gjør den (alle, rollen, eller administrator)
  punkter: Punkt[];
  periode: string | null;
  naa: Naa | null;
  sist: Sist | null;
  forrige: string | null; // starten av forrige periode (de faste)
  forrige_gjort: boolean | null; // null: ingen forrige periode å sjekke
};
type Rolle = { id: string; navn: string };
export type SjekklisteSvar = { idag: string; kan_endre: boolean; ser_alle: boolean; roller: Rolle[]; lister: Sjekkliste[]; apne_avvik: number };
type PunktSvar = {
  svar: "ok" | "avvik";
  kommentar: string | null;
  besvart: string;
  besvart_navn: string;
  avvik_lukket: string | null;
  avvik_lukket_navn: string | null;
  tiltak: string | null;
};
type UPunkt = { id: string; tekst: string; hjelp: string | null; aktiv: boolean; svar: PunktSvar | null };
type Utfylling = {
  id: string;
  sjekkliste_id: string;
  navn: string;
  beskrivelse: string | null;
  frekvens: Frekvens;
  periode: string;
  status: "pagar" | "fullfort";
  kommentar: string | null;
  startet: string;
  startet_navn: string;
  fullfort: string | null;
  fullfort_navn: string | null;
  kan_svare: boolean;
  punkter: UPunkt[];
};
type Avvik = {
  utfylling_id: string;
  punkt_id: string;
  sjekkliste_id: string;
  sjekkliste: string;
  frekvens: Frekvens;
  periode: string;
  punkt_tekst: string;
  kommentar: string;
  besvart: string;
  besvart_navn: string;
  avvik_lukket: string | null;
  avvik_lukket_navn: string | null;
  tiltak: string | null;
  eget: boolean;
};
type HistorikkRad = {
  id: string;
  navn: string;
  frekvens: Frekvens;
  periode: string;
  status: "pagar" | "fullfort";
  startet_navn: string;
  fullfort: string | null;
  fullfort_navn: string | null;
  besvart: number;
  avvik: number;
  apne_avvik: number;
};

export const FREKVENSNAVN: Record<Frekvens, string> = { daglig: "Daglig", ukentlig: "Ukentlig", maanedlig: "Månedlig", ved_behov: "Ved behov" };
const FREKVENSER: Frekvens[] = ["daglig", "ukentlig", "maanedlig", "ved_behov"];
const FREKVENSHJELP: Record<Frekvens, string> = {
  daglig: "Én gang hver dag. Har dere stengt i helgene (Innstillinger → Personal), regnes ikke lørdag og søndag med.",
  ukentlig: "Én gang hver uke, mandag til søndag.",
  maanedlig: "Én gang hver måned.",
  ved_behov: "Hver gang den trengs, f.eks. når det kommer varer. Hver utfylling står for seg.",
};
// Denne perioden i en setning.
const DENNE: Record<Frekvens, string> = { daglig: "i dag", ukentlig: "denne uka", maanedlig: "denne måneden", ved_behov: "" };

const osloDato = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Oslo" }); // «2026-10-16»
const klokka = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "Europe/Oslo" }); // «08:12»
const ukedag = new Intl.DateTimeFormat("nb-NO", { weekday: "long", timeZone: "UTC" }); // «fredag»

// «i dag kl. 08:12», «i går kl. 16:40» eller «12.10.2026 kl. 08:12». Tidspunktene fra JSON i
// databasen har mikrosekunder, som ikke alle nettlesere leser; de kortes ned til millisekunder.
function tidspunkt(iso: string, idag = iDag()) {
  const t = new Date(iso.replace(/(\.\d{3})\d+/, "$1"));
  const d = osloDato.format(t);
  return `${d === idag ? "i dag" : d === leggTilDager(idag, -1) ? "i går" : dato(d)} kl. ${klokka.format(t)}`;
}

// Perioden en utfylling er for: «I dag», «Uke 42», «Oktober», eller dagen (ved behov: den den ble startet).
function periodeTekst(f: Frekvens, periode: string, idag = iDag()) {
  if (f === "ukentlig") {
    const { aar, uke } = ukenr(periode);
    return `Uke ${uke}${aar !== Number(idag.slice(0, 4)) ? ` ${aar}` : ""}`;
  }
  if (f === "maanedlig") {
    const m = MND[Number(periode.slice(5, 7)) - 1] ?? "";
    return `${m.charAt(0).toUpperCase()}${m.slice(1)}${periode.slice(0, 4) !== idag.slice(0, 4) ? ` ${periode.slice(0, 4)}` : ""}`;
  }
  return periode === idag ? "I dag" : periode === leggTilDager(idag, -1) ? "I går" : visDag(periode);
}

// Forrige periode i en setning: «i går», «fredag», «forrige uke», «i september».
function forrigeTekst(f: Frekvens, forrige: string, idag = iDag()) {
  if (f === "ukentlig") return "forrige uke";
  if (f === "maanedlig") return `i ${MND[Number(forrige.slice(5, 7)) - 1]}`;
  return forrige === leggTilDager(idag, -1) ? "i går" : ukedag.format(middag(forrige));
}

// Den siste dagen i perioden (som på serveren).
function periodeSlutt(f: Frekvens, p: string) {
  if (f === "ukentlig") return leggTilDager(p, 6);
  if (f === "maanedlig") {
    const d = middag(p);
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0, 12)).toISOString().slice(0, 10);
  }
  return p;
}

// --- Oversiktene ------------------------------------------------------------------------------

// Sjekklistene til oversiktene (Oversikt.tsx og AnsattOversikt.tsx); null uten funksjonen.
export function useSjekklisterTilOversikt(aktiv: boolean) {
  const { org } = useKonto();
  return useData(
    () => (aktiv && org ? hent<SjekklisteSvar>(`/org/${org.id}/sjekklister`).catch(() => null) : Promise.resolve(null)),
    [org?.id, aktiv],
    { oppdater: true },
  );
}

// Det som venter. gjore: de faste sjekklistene den innloggede skal gjøre denne perioden og ikke har
// fullført (de daglige ikke i helgen når det er stengt da). leder: de åpne avvikene og de faste som
// ikke ble gjort forrige periode.
export function sjekklisteOppgaver(s: SjekklisteSvar | null | undefined, valg: { gjore?: boolean; leder?: boolean; helg?: boolean }): Oppgave[] {
  if (!s) return [];
  const ut: Oppgave[] = [];
  if (valg.gjore)
    for (const l of [...s.lister].sort((a, b) => FREKVENSER.indexOf(a.frekvens) - FREKVENSER.indexOf(b.frekvens))) {
      if (!l.aktiv || !l.min || l.frekvens === "ved_behov" || l.naa?.status === "fullfort" || !l.punkter.length) continue;
      if (l.frekvens === "daglig" && valg.helg === false && erHelg(s.idag)) continue;
      ut.push(
        l.naa
          ? { nokkel: `sjekk-${l.id}`, tekst: `Fullfør sjekklisten «${l.navn}» (${l.naa.besvart} av ${l.punkter.length})`, til: `/sjekklister?utfylling=${l.naa.id}` }
          : { nokkel: `sjekk-${l.id}`, tekst: `Gjør sjekklisten «${l.navn}» ${DENNE[l.frekvens]}`, til: "/sjekklister" },
      );
    }
  if (valg.leder) {
    if (s.apne_avvik)
      ut.push({ nokkel: "sjekk-avvik", tekst: `${antall(s.apne_avvik, "åpent avvik", "åpne avvik")} fra sjekklistene`, til: "/sjekklister?fane=avvik", fare: true });
    const glemt = s.lister.filter((l) => l.aktiv && l.forrige_gjort === false && l.forrige);
    if (glemt.length === 1)
      ut.push({ nokkel: "sjekk-glemt", tekst: `«${glemt[0]!.navn}» ble ikke gjort ${forrigeTekst(glemt[0]!.frekvens, glemt[0]!.forrige!, s.idag)}`, til: "/sjekklister" });
    else if (glemt.length > 1) ut.push({ nokkel: "sjekk-glemt", tekst: `${glemt.length} sjekklister ble ikke gjort forrige gang`, til: "/sjekklister" });
  }
  return ut;
}

// --- Siden ------------------------------------------------------------------------------------

type Fane = "gjore" | "avvik" | "historikk" | "oppsett";

export function Sjekklister() {
  const { org } = useKonto();
  const [sok, settSok] = useSearchParams();
  const sted = useLocation();
  const { data, feil, last } = useData(() => hent<SjekklisteSvar>(`/org/${org!.id}/sjekklister`), [org?.id], { oppdater: true });
  const utfylling = sok.get("utfylling");

  // Tilbake fra en utfylling: hent lista på nytt (status og avvik).
  const forrige = useRef(utfylling);
  useEffect(() => {
    if (forrige.current && !utfylling) void last();
    forrige.current = utfylling;
  }, [utfylling, last]);

  const ga = (endring: Record<string, string | null>, ny = false) => {
    const p = new URLSearchParams(sok);
    for (const [k, v] of Object.entries(endring)) {
      if (v === null) p.delete(k);
      else p.set(k, v);
    }
    settSok(p, ny ? { state: { fraListe: true } } : { replace: true });
  };
  // Åpnet fra lista: tilbake er et steg tilbake; ellers (f.eks. fra oversikten) til lista.
  const tilbake = () => ((sted.state as { fraListe?: boolean } | null)?.fraListe ? window.history.back() : ga({ utfylling: null }));

  if (!org) return null;
  if (!data)
    return (
      <>
        <h1>Sjekklister</h1>
        {feil ? <Feil melding={feil} /> : <Laster />}
      </>
    );
  if (utfylling) return <UtfyllingSide key={utfylling} id={utfylling} svar={data} tilbake={tilbake} endret={() => void last()} />;

  const faner: [Fane, ReactNode][] = [
    ["gjore", "Å gjøre"],
    [
      "avvik",
      <>
        Avvik
        {data.apne_avvik > 0 && <span className="teller">{data.apne_avvik}</span>}
      </>,
    ],
    ["historikk", "Historikk"],
  ];
  if (data.kan_endre) faner.push(["oppsett", "Oppsett"]);
  const fane: Fane = faner.find(([f]) => f === sok.get("fane"))?.[0] ?? (data.kan_endre && data.lister.length === 0 ? "oppsett" : "gjore");
  const apne = (id: string) => ga({ utfylling: id }, true);

  return (
    <>
      <div className="topp">
        <h1>Sjekklister</h1>
      </div>
      <div className="faner tett" role="tablist">
        {faner.map(([f, t]) => (
          <button key={f} type="button" role="tab" aria-selected={fane === f} className={fane === f ? "valgt" : undefined} onClick={() => ga({ fane: f })}>
            {t}
          </button>
        ))}
      </div>
      {fane === "gjore" && <Gjore svar={data} apne={apne} tilOppsett={() => ga({ fane: "oppsett" })} />}
      {fane === "avvik" && <AvvikFane svar={data} apne={apne} endret={() => void last()} />}
      {fane === "historikk" && <Historikk svar={data} apne={apne} />}
      {fane === "oppsett" && <Oppsett svar={data} endret={() => void last()} />}
    </>
  );
}

// --- Å gjøre ----------------------------------------------------------------------------------

function Gjore({ svar, apne, tilOppsett }: { svar: SjekklisteSvar; apne: (id: string) => void; tilOppsett: () => void }) {
  const { org } = useKonto();
  const h = useHandling();
  const mine = svar.lister.filter((l) => l.aktiv && l.min && l.punkter.length > 0);
  const glemt = mine.filter((l) => l.forrige_gjort === false && l.forrige);

  // Starter (eller fortsetter) sjekklisten for perioden datoen hører til (uten dato: denne).
  async function start(l: Sjekkliste, dato?: string) {
    if (!dato && l.naa) return apne(l.naa.id);
    const u = await h.kjor(() => api<{ id: string }>("POST", `/org/${org!.id}/sjekklister/${l.id}/start`, dato ? { dato } : {}));
    if (u) apne(u.id);
  }

  if (!mine.length)
    return (
      <div className="kort">
        <Tom ikon={<IkonSjekkliste storrelse={22} />} tittel="Ingen sjekklister å gjøre">
          {svar.kan_endre ? (
            <>
              <p>Lag sjekklister for det som skal sjekkes daglig, ukentlig, månedlig eller ved behov, f.eks. åpning, varemottak og bestillinger.</p>
              <button type="button" className="primar" onClick={tilOppsett}>
                <IkonPluss storrelse={16} /> Ny sjekkliste
              </button>
            </>
          ) : (
            <p>Du har ingen sjekklister her ennå. Det er administrator som lager dem.</p>
          )}
        </Tom>
      </div>
    );

  return (
    <>
      <Feil melding={h.feil} />
      {glemt.map((l) => (
        <div key={l.id} className="melding advarsel sjekk-glemt">
          <span>
            «{l.navn}» ble ikke gjort {forrigeTekst(l.frekvens, l.forrige!, svar.idag)}.
          </span>
          <button type="button" disabled={h.opptatt} onClick={() => start(l, l.forrige!)}>
            Fyll ut i etterkant
          </button>
        </div>
      ))}
      {FREKVENSER.map((f) => {
        const lister = mine.filter((l) => l.frekvens === f);
        if (!lister.length) return null;
        return (
          <section key={f} className="sjekk-gruppe">
            <h2>{FREKVENSNAVN[f]}</h2>
            <div className="kort liste">
              {lister.map((l) => (
                <ListeRad key={l.id} l={l} idag={svar.idag} opptatt={h.opptatt} start={() => start(l)} />
              ))}
            </div>
          </section>
        );
      })}
    </>
  );
}

function ListeRad({ l, idag, opptatt, start }: { l: Sjekkliste; idag: string; opptatt: boolean; start: () => void }) {
  const n = l.punkter.length;
  const u = l.naa;
  let merker: ReactNode;
  let under: string;
  if (u?.status === "fullfort") {
    merker = (
      <>
        {u.avvik > 0 && <span className="merke merke-fare">{antall(u.avvik, "avvik", "avvik")}</span>}
        <span className="merke merke-ok">Fullført</span>
      </>
    );
    under = `Fullført av ${u.fullfort_navn ?? ""} ${u.fullfort ? tidspunkt(u.fullfort, idag) : ""}`;
  } else if (u) {
    merker = <span className="merke merke-info">Påbegynt</span>;
    under = `${u.besvart} av ${n} punkter · startet av ${u.startet_navn}`;
  } else if (l.frekvens === "ved_behov") {
    merker = <span className="sjekk-start">Start</span>;
    under = `${antall(n, "punkt", "punkter")} · ${l.sist ? `sist ${tidspunkt(l.sist.fullfort, idag)} av ${l.sist.fullfort_navn}` : "ikke gjort ennå"}`;
  } else {
    merker = <span className="merke merke-noytral">Ikke startet</span>;
    under = `${antall(n, "punkt", "punkter")} · ${DENNE[l.frekvens]}`;
  }
  return (
    <button type="button" className="liste-rad sjekk-rad" disabled={opptatt} onClick={start}>
      <div className="linje">
        <span className="tittel">{l.navn}</span>
        <span className="sjekk-merker">{merker}</span>
      </div>
      <div className="under">{under}</div>
    </button>
  );
}

// --- Utfyllingen ------------------------------------------------------------------------------

function UtfyllingSide({ id, svar, tilbake, endret }: { id: string; svar: SjekklisteSvar; tilbake: () => void; endret: () => void }) {
  const { org } = useKonto();
  const sti = `/org/${org!.id}/sjekklister/utfyllinger/${id}`;
  const { data: u, feil, last, settData } = useData(() => hent<Utfylling>(sti), [sti]);
  const h = useHandling();
  // Avvikene som skrives på (punktet → teksten), og punktene der avviket er åpent for skriving.
  const [utkast, settUtkast] = useState<Record<string, string>>({});
  const [skriver, settSkriver] = useState<ReadonlySet<string>>(new Set());
  const [kommentar, settKommentar] = useState("");
  const [ferdig, settFerdig] = useState<number | null>(null); // antall avvik da den ble fullført her

  const settSvar = (punkt: string, s: PunktSvar | null) => settData((d) => d && { ...d, punkter: d.punkter.map((p) => (p.id === punkt ? { ...p, svar: s } : p)) });
  const ferdigSkrevet = (punkt: string) =>
    settSkriver((s) => {
      const n = new Set(s);
      n.delete(punkt);
      return n;
    });
  const nyttSvar = (svar: "ok" | "avvik", kommentar: string | null): PunktSvar => ({
    svar,
    kommentar,
    besvart: new Date().toISOString(),
    besvart_navn: "",
    avvik_lukket: null,
    avvik_lukket_navn: null,
    tiltak: null,
  });

  if (!u)
    return (
      <>
        <TilbakeKnapp tilbake={tilbake} />
        {feil ? <Feil melding={feil} /> : <Laster />}
      </>
    );

  // «Normalt» lagres med en gang (vises før svaret kommer; feiler det, settes det tilbake).
  async function normalt(p: UPunkt) {
    ferdigSkrevet(p.id);
    if (p.svar?.svar === "ok") return;
    const for_ = p.svar;
    settSvar(p.id, nyttSvar("ok", null));
    const ok = await h.kjor(() => api("PUT", `${sti}/punkter/${p.id}`, { svar: "ok" }).then(() => true));
    if (!ok) settSvar(p.id, for_);
  }

  function skrivAvvik(p: UPunkt) {
    settUtkast((x) => ({ ...x, [p.id]: x[p.id] ?? p.svar?.kommentar ?? "" }));
    settSkriver((s) => new Set(s).add(p.id));
  }

  async function lagreAvvik(p: UPunkt): Promise<boolean> {
    const tekst = (utkast[p.id] ?? "").trim();
    if (tekst.length < 2) {
      h.settFeil(`Skriv hva avviket er på «${p.tekst}», eller trykk Avbryt.`);
      return false;
    }
    if (p.svar?.svar === "avvik" && p.svar.kommentar === tekst) {
      ferdigSkrevet(p.id);
      return true;
    }
    const ok = await h.kjor(() => api("PUT", `${sti}/punkter/${p.id}`, { svar: "avvik", kommentar: tekst }).then(() => true));
    if (!ok) return false;
    settSvar(p.id, nyttSvar("avvik", tekst));
    ferdigSkrevet(p.id);
    return true;
  }

  function avbryt(p: UPunkt) {
    ferdigSkrevet(p.id);
    settUtkast((x) => {
      const n = { ...x };
      delete n[p.id];
      return n;
    });
  }

  // Avvikene som skrives på, lagres før «Alt normalt» og «Fullfør».
  async function lagreUtkast() {
    for (const p of u!.punkter) if (skriver.has(p.id) && !(await lagreAvvik(p))) return false;
    return true;
  }

  async function altNormalt() {
    if (!(await lagreUtkast())) return;
    const ny = await h.kjor(() => api<Utfylling>("POST", `${sti}/alt-normalt`, {}));
    if (ny) settData(ny);
  }

  async function fullfor() {
    if (!(await lagreUtkast())) return;
    const r = await h.kjor(() => api<{ avvik: number }>("POST", `${sti}/fullfor`, { kommentar: kommentar.trim() || null }));
    if (!r) return;
    settFerdig(r.avvik);
    endret();
    await last();
    window.scrollTo(0, 0);
  }

  const kanSvare = u.kan_svare;
  const klar = (p: UPunkt) => !!p.svar && !skriver.has(p.id);
  const besvart = u.punkter.filter((p) => p.svar).length;
  // Et avvik som er skrevet, men ikke lagret, lagres når man fullfører.
  const igjen = u.punkter.filter((p) => !klar(p) && !(skriver.has(p.id) && (utkast[p.id] ?? "").trim().length >= 2)).length;
  const antallAvvik = u.punkter.filter((p) => (skriver.has(p.id) ? (utkast[p.id] ?? "").trim().length >= 2 : p.svar?.svar === "avvik")).length;
  const n = u.punkter.length;

  return (
    <div className="sjekk-utfylling">
      <TilbakeKnapp tilbake={tilbake} />
      <div className="sjekk-hode">
        <h1>{u.navn}</h1>
        <div className="dempet">
          {u.frekvens === "ved_behov" ? `Ved behov · startet ${tidspunkt(u.startet, svar.idag)} av ${u.startet_navn}` : `${FREKVENSNAVN[u.frekvens]} · ${periodeTekst(u.frekvens, u.periode, svar.idag)}`}
        </div>
        {u.beskrivelse && <p className="sjekk-beskrivelse">{u.beskrivelse}</p>}
      </div>

      {ferdig !== null && (
        <div className="melding ok" role="status">
          Sjekklisten er fullført. {ferdig ? `${antall(ferdig, "avvik", "avvik")} er sendt til administrator.` : "Alt var normalt."}
        </div>
      )}

      {kanSvare ? (
        <div className="sjekk-fremdrift">
          <div className="sjekk-fremdrift-linje">
            <span>
              <strong>
                {besvart} av {n}
              </strong>{" "}
              punkter
            </span>
            {antallAvvik > 0 && <span className="merke merke-fare">{antall(antallAvvik, "avvik", "avvik")}</span>}
            {besvart < n && (
              <button type="button" className="sjekk-alt-normalt" disabled={h.opptatt} onClick={altNormalt}>
                <IkonHake storrelse={16} /> {besvart ? "Resten normalt" : "Alt normalt"}
              </button>
            )}
          </div>
          <div className="sjekk-stolpe" role="progressbar" aria-label="Punkter som er besvart" aria-valuemin={0} aria-valuemax={n} aria-valuenow={besvart}>
            <span style={{ width: `${n ? (besvart / n) * 100 : 0}%` }} />
          </div>
          <Feil melding={h.feil} />
        </div>
      ) : (
        <div className="kort sjekk-status">
          {u.status === "fullfort" ? (
            <span>
              <span className="merke merke-ok">Fullført</span> av {u.fullfort_navn} {u.fullfort ? tidspunkt(u.fullfort, svar.idag) : ""}
            </span>
          ) : (
            <span>
              <span className="merke merke-info">Påbegynt</span> av {u.startet_navn} · {besvart} av {n} punkter
            </span>
          )}
          {u.kommentar && <p className="sjekk-kommentar">«{u.kommentar}»</p>}
        </div>
      )}

      <ol className="sjekk-punkter">
        {u.punkter.map((p, i) => {
          const apen = kanSvare && skriver.has(p.id);
          const s = p.svar;
          const klasse = apen || s?.svar === "avvik" ? " avvik" : s?.svar === "ok" ? " ok" : "";
          return (
            <li key={p.id} className={`sjekk-punkt${klasse}`}>
              <div className="sjekk-punkt-topp">
                <span className="sjekk-nr" aria-hidden="true">
                  {s?.svar === "ok" && !apen ? <IkonHake storrelse={18} /> : s?.svar === "avvik" || apen ? <IkonVarsel storrelse={16} /> : i + 1}
                </span>
                <div className="sjekk-punkt-tekst">
                  <span>{p.tekst}</span>
                  {p.hjelp && <span className="felt-hjelp">{p.hjelp}</span>}
                </div>
              </div>
              {kanSvare ? (
                <div className="sjekk-valg" role="group" aria-label={p.tekst}>
                  <button type="button" className="sjekk-normalt" aria-pressed={s?.svar === "ok" && !apen} onClick={() => normalt(p)}>
                    <IkonHake storrelse={18} /> Normalt
                  </button>
                  <button type="button" className="sjekk-avvik" aria-pressed={s?.svar === "avvik" || apen} onClick={() => skrivAvvik(p)}>
                    <IkonVarsel storrelse={17} /> Avvik
                  </button>
                </div>
              ) : (
                <div className="sjekk-svar">
                  {s?.svar === "ok" ? (
                    <span className="merke merke-ok">Normalt</span>
                  ) : s?.svar === "avvik" ? (
                    <span className="merke merke-fare">Avvik</span>
                  ) : (
                    <span className="merke merke-noytral">Ikke besvart</span>
                  )}
                  {s && (
                    <span className="dempet liten">
                      {s.besvart_navn} {tidspunkt(s.besvart, svar.idag)}
                    </span>
                  )}
                </div>
              )}
              {apen ? (
                <div className="sjekk-avvik-skjema">
                  <textarea
                    autoFocus
                    rows={2}
                    maxLength={2000}
                    aria-label={`Avviket på «${p.tekst}»`}
                    placeholder="Hva er avviket? Det går til administrator."
                    value={utkast[p.id] ?? ""}
                    onChange={(e) => settUtkast((x) => ({ ...x, [p.id]: e.target.value }))}
                    // Ctrl/⌘ + Enter lagrer (Enter alene er ny linje).
                    onKeyDown={(e) => e.key === "Enter" && (e.ctrlKey || e.metaKey) && void lagreAvvik(p)}
                  />
                  <div className="knapper">
                    <button type="button" className="primar" disabled={h.opptatt || (utkast[p.id] ?? "").trim().length < 2} onClick={() => void lagreAvvik(p)}>
                      Lagre avviket
                    </button>
                    <button type="button" className="lenke" onClick={() => avbryt(p)}>
                      Avbryt
                    </button>
                  </div>
                </div>
              ) : (
                s?.svar === "avvik" && (
                  <div className="sjekk-avvik-tekst">
                    <p>{s.kommentar}</p>
                    {kanSvare ? (
                      <button type="button" className="lenke" onClick={() => skrivAvvik(p)}>
                        Endre
                      </button>
                    ) : s.avvik_lukket ? (
                      <p className="sjekk-tiltak">
                        <span className="dempet liten">
                          Lukket av {s.avvik_lukket_navn} {tidspunkt(s.avvik_lukket, svar.idag)}
                        </span>
                        {s.tiltak}
                      </p>
                    ) : svar.kan_endre ? (
                      <LukkAvvik
                        utfylling={u.id}
                        punkt={p.id}
                        lukket={() => {
                          void last();
                          endret();
                        }}
                      />
                    ) : (
                      <span className="merke merke-fare">Åpent</span>
                    )}
                  </div>
                )
              )}
            </li>
          );
        })}
      </ol>

      {kanSvare && (
        <div className="kort sjekk-fullfor">
          <label>
            Kommentar <span className="dempet">(valgfritt)</span>
            <textarea rows={2} maxLength={2000} value={kommentar} onChange={(e) => settKommentar(e.target.value)} placeholder="Noe administrator bør vite?" />
          </label>
          {antallAvvik > 0 && <p className="liten advarsel-tekst">{antall(antallAvvik, "avvik", "avvik")} sendes til administrator når du fullfører.</p>}
          <Feil melding={h.feil} />
          <div className="knapper">
            <button type="button" className="primar" disabled={h.opptatt || igjen > 0} onClick={fullfor}>
              Fullfør sjekklisten
            </button>
            {igjen > 0 && <span className="dempet liten">Svar på alle punktene først ({igjen} igjen)</span>}
          </div>
        </div>
      )}
      {!kanSvare && (
        <button type="button" onClick={tilbake}>
          <IkonVenstre storrelse={16} /> Tilbake til sjekklistene
        </button>
      )}
    </div>
  );
}

function TilbakeKnapp({ tilbake }: { tilbake: () => void }) {
  return (
    <button type="button" className="lenke sjekk-tilbake" onClick={tilbake}>
      <IkonVenstre storrelse={16} /> Sjekklister
    </button>
  );
}

// Lukker et avvik med det som er gjort (administrator).
function LukkAvvik({ utfylling, punkt, lukket }: { utfylling: string; punkt: string; lukket: () => void }) {
  const { org } = useKonto();
  const [apen, settApen] = useState(false);
  const [tiltak, settTiltak] = useState("");
  const h = useHandling();

  async function lukk(e: FormEvent) {
    e.preventDefault();
    const ok = await h.kjor(() => api("POST", `/org/${org!.id}/sjekklister/avvik/${utfylling}/${punkt}/lukk`, { tiltak: tiltak.trim() }).then(() => true));
    if (!ok) return;
    settApen(false);
    lukket();
  }

  if (!apen)
    return (
      <button type="button" className="sjekk-lukk-knapp" onClick={() => settApen(true)}>
        <IkonHake storrelse={16} /> Lukk avviket
      </button>
    );
  return (
    <form className="sjekk-lukk" onSubmit={lukk}>
      <label>
        Hva er gjort?
        <textarea autoFocus rows={2} maxLength={2000} value={tiltak} onChange={(e) => settTiltak(e.target.value)} placeholder="F.eks. «Ringt service, kjøledisken er reparert»" />
      </label>
      <Feil melding={h.feil} />
      <div className="knapper">
        <button className="primar" disabled={h.opptatt || tiltak.trim().length < 2}>
          Lukk avviket
        </button>
        <button type="button" className="lenke" onClick={() => settApen(false)}>
          Avbryt
        </button>
      </div>
    </form>
  );
}

// --- Avvik ------------------------------------------------------------------------------------

function AvvikFane({ svar, apne, endret }: { svar: SjekklisteSvar; apne: (id: string) => void; endret: () => void }) {
  const { org } = useKonto();
  const [alle, settAlle] = useState(false);
  const { data, feil, last } = useData(() => hent<Avvik[]>(`/org/${org!.id}/sjekklister/avvik${alle ? "?alle=1" : ""}`), [org?.id, alle], { oppdater: true });

  return (
    <>
      <div className="faner valg sjekk-filter" role="radiogroup" aria-label="Hvilke avvik">
        {(
          [
            [false, "Åpne"],
            [true, "Alle"],
          ] as const
        ).map(([v, t]) => (
          <button key={t} type="button" role="radio" aria-checked={alle === v} className={alle === v ? "valgt" : undefined} onClick={() => settAlle(v)}>
            {t}
          </button>
        ))}
      </div>
      <p className="liten dempet sjekk-forklaring">
        {svar.ser_alle ? "Avvikene fra alle sjekklistene." : "Avvikene du har meldt."}{" "}
        {svar.kan_endre ? "Lukk dem med det som er gjort; den som meldte avviket, får beskjed." : "Administrator lukker dem med det som er gjort, og du får beskjed."}
      </p>
      {!data ? (
        feil ? (
          <Feil melding={feil} />
        ) : (
          <Laster />
        )
      ) : data.length === 0 ? (
        <div className="kort">
          <Tom ikon={<IkonHake storrelse={22} />} tittel={alle ? "Ingen avvik" : "Ingen åpne avvik"}>
            <p>Avvikene som meldes på sjekklistene, kommer her.</p>
          </Tom>
        </div>
      ) : (
        <div className="sjekk-avviksliste">
          {data.map((a) => (
            <article key={`${a.utfylling_id}-${a.punkt_id}`} className={`kort sjekk-avvik-kort${a.avvik_lukket ? " lukket" : ""}`}>
              <div className="sjekk-avvik-topp">
                <strong>{a.punkt_tekst}</strong>
                {a.avvik_lukket ? <span className="merke merke-ok">Lukket</span> : <span className="merke merke-fare">Åpent</span>}
              </div>
              <div className="dempet liten">
                {a.sjekkliste} · {periodeTekst(a.frekvens, a.periode, svar.idag)} · meldt av {a.eget ? "deg" : a.besvart_navn} {tidspunkt(a.besvart, svar.idag)}
              </div>
              <p className="sjekk-kommentar">{a.kommentar}</p>
              {a.avvik_lukket ? (
                <p className="sjekk-tiltak">
                  <span className="dempet liten">
                    Lukket av {a.avvik_lukket_navn} {tidspunkt(a.avvik_lukket, svar.idag)}
                  </span>
                  {a.tiltak}
                </p>
              ) : (
                svar.kan_endre && (
                  <LukkAvvik
                    utfylling={a.utfylling_id}
                    punkt={a.punkt_id}
                    lukket={() => {
                      void last();
                      endret();
                    }}
                  />
                )
              )}
              <button type="button" className="lenke liten sjekk-se" onClick={() => apne(a.utfylling_id)}>
                Se hele sjekklisten
              </button>
            </article>
          ))}
        </div>
      )}
    </>
  );
}

// --- Historikk --------------------------------------------------------------------------------

const gyldig = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d);

function Historikk({ svar, apne }: { svar: SjekklisteSvar; apne: (id: string) => void }) {
  const { org } = useKonto();
  const [fra, settFra] = useState(() => leggTilDager(svar.idag, -30));
  const [til, settTil] = useState(svar.idag);
  const [liste, settListe] = useState("");
  const { data, feil } = useData(
    () => hent<HistorikkRad[]>(`/org/${org!.id}/sjekklister/utfyllinger?fra=${fra}&til=${til}${liste ? `&sjekkliste=${liste}` : ""}`),
    [org?.id, fra, til, liste],
    { oppdater: true },
  );
  const lister = svar.lister.filter((l) => l.min || svar.ser_alle);

  return (
    <>
      <div className="kort sjekk-historikk-valg">
        <div className="rad">
          <label>
            Sjekkliste
            <select value={liste} onChange={(e) => settListe(e.target.value)}>
              <option value="">Alle</option>
              {lister.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.navn}
                  {l.aktiv ? "" : " (arkivert)"}
                </option>
              ))}
            </select>
          </label>
          <label>
            Fra
            <input type="date" value={fra} max={til} onChange={(e) => gyldig(e.target.value) && settFra(e.target.value)} />
          </label>
          <label>
            Til
            <input type="date" value={til} min={fra} onChange={(e) => gyldig(e.target.value) && settTil(e.target.value)} />
          </label>
        </div>
        {svar.ser_alle && (
          <p className="liten dempet">
            Rapportene over sjekklistene (også de faste som ikke ble gjort) og avvikene, med utskrift og utsending, ligger under <Link to="/rapporter">Rapporter</Link> → Personal.
          </p>
        )}
      </div>
      {!data ? (
        feil ? (
          <Feil melding={feil} />
        ) : (
          <Laster />
        )
      ) : data.length === 0 ? (
        <div className="kort">
          <Tom ikon={<IkonSjekkliste storrelse={22} />} tittel="Ingen sjekklister i perioden" />
        </div>
      ) : (
        <div className="kort liste">
          {data.map((r) => {
            const over = r.frekvens !== "ved_behov" && periodeSlutt(r.frekvens, r.periode) < svar.idag;
            return (
              <button key={r.id} type="button" className="liste-rad" onClick={() => apne(r.id)}>
                <div className="linje">
                  <span className="tittel">{r.navn}</span>
                  <span className="sjekk-merker">
                    {r.avvik > 0 && <span className={`merke ${r.apne_avvik ? "merke-fare" : "merke-noytral"}`}>{antall(r.avvik, "avvik", "avvik")}</span>}
                    {r.status === "fullfort" ? (
                      <span className="merke merke-ok">Fullført</span>
                    ) : over ? (
                      <span className="merke merke-advarsel">Ikke fullført</span>
                    ) : (
                      <span className="merke merke-info">Påbegynt</span>
                    )}
                  </span>
                </div>
                <div className="under">
                  {periodeTekst(r.frekvens, r.periode, svar.idag)} ·{" "}
                  {r.status === "fullfort" && r.fullfort ? `${r.fullfort_navn} ${tidspunkt(r.fullfort, svar.idag)}` : `startet av ${r.startet_navn}, ${r.besvart} besvart`}
                  {r.apne_avvik > 0 ? ` · ${antall(r.apne_avvik, "åpent avvik", "åpne avvik")}` : ""}
                </div>
              </button>
            );
          })}
        </div>
      )}
      {data && data.length >= 500 && <p className="liten dempet">Viser de 500 siste. Velg en kortere periode for å se resten.</p>}
    </>
  );
}

// --- Oppsett (administrator) ------------------------------------------------------------------

type Mal = { navn: string; frekvens: Frekvens; beskrivelse?: string; punkter: string[] };
// Forslag å starte fra (punktene kan endres før sjekklisten lagres).
const FORSLAG: Mal[] = [
  {
    navn: "Åpning",
    frekvens: "daglig",
    punkter: ["Alarmen er slått av", "Lys og varme er på", "Kassen er telt opp og stemmer", "Kjøl og frys holder riktig temperatur", "Inngangen er ryddig og trygg"],
  },
  {
    navn: "Stenging",
    frekvens: "daglig",
    punkter: ["Kassen er telt opp og stemmer", "Kjøl og frys er lukket", "Avfallet er tatt ut", "Vinduer og dører er låst", "Alarmen er slått på"],
  },
  {
    navn: "Varebestilling",
    frekvens: "ukentlig",
    punkter: ["Lageret er gått gjennom", "Varer som snart er tomme, er notert", "Bestillingen er sendt", "Ordrebekreftelsen stemmer med bestillingen"],
  },
  {
    navn: "Varemottak",
    frekvens: "ved_behov",
    punkter: ["Antallet stemmer med følgeseddelen", "Varene er uten skader", "Kjølevarene holder riktig temperatur", "Holdbarhetsdatoene er gode nok", "Varene er satt på plass"],
  },
  {
    navn: "HMS-runde",
    frekvens: "maanedlig",
    punkter: ["Brannslukkerne er på plass og kontrollert", "Nødutgangene er frie", "Førstehjelpsutstyret er komplett", "Elektrisk utstyr er uten synlige skader", "Stoffkartoteket er oppdatert"],
  },
];

type Start = { id?: string; navn: string; frekvens: Frekvens; beskrivelse: string | null; roller: string[]; punkter: { id?: string; tekst: string; hjelp: string | null }[] };
const fraMal = (m: Mal): Start => ({ navn: m.navn, frekvens: m.frekvens, beskrivelse: m.beskrivelse ?? null, roller: [], punkter: m.punkter.map((tekst) => ({ tekst, hjelp: null })) });

function Oppsett({ svar, endret }: { svar: SjekklisteSvar; endret: () => void }) {
  const { org } = useKonto();
  const [skjema, settSkjema] = useState<Start | null>(null);
  const [melding, settMelding] = useState<string | null>(null);
  const h = useHandling();
  const aktive = svar.lister.filter((l) => l.aktiv);
  const arkiverte = svar.lister.filter((l) => !l.aktiv);
  const navn = new Set(svar.lister.map((l) => l.navn.toLowerCase()));
  const forslag = FORSLAG.filter((m) => !navn.has(m.navn.toLowerCase()));
  const rollenavn = new Map(svar.roller.map((r) => [r.id, r.navn]));
  const hvem = (l: Sjekkliste) => (l.roller.length ? l.roller.map((r) => rollenavn.get(r) ?? "en slettet rolle").join(", ") : "alle");

  async function settAktiv(l: Sjekkliste, aktiv: boolean) {
    settMelding(null);
    const ok = await h.kjor(() => api("POST", `/org/${org!.id}/sjekklister/${l.id}/aktiv`, { aktiv }).then(() => true));
    if (ok) endret();
  }

  async function slett(l: Sjekkliste) {
    if (!confirm(`Slette «${l.navn}»? Er den brukt, arkiveres den i stedet, så historikken og avvikene blir tatt vare på.`)) return;
    settMelding(null);
    const r = await h.kjor(() => api<{ resultat: "slettet" | "arkivert" }>("DELETE", `/org/${org!.id}/sjekklister/${l.id}`));
    if (!r) return;
    settMelding(r.resultat === "arkivert" ? `«${l.navn}» er brukt, så den er arkivert i stedet for slettet. Historikken og avvikene er tatt vare på.` : `«${l.navn}» er slettet.`);
    endret();
  }

  const rad = (l: Sjekkliste) => (
    <li key={l.id}>
      <span>
        <span className="tittel">{l.navn}</span>{" "}
        <span className="dempet">{[FREKVENSNAVN[l.frekvens], antall(l.punkter.length, "punkt", "punkter"), hvem(l)].join(" · ")}</span>
      </span>
      <span className="knapper">
        {l.aktiv && (
          <button type="button" onClick={() => settSkjema({ ...l, punkter: l.punkter })}>
            Endre
          </button>
        )}
        <button type="button" disabled={h.opptatt} onClick={() => settAktiv(l, !l.aktiv)}>
          {l.aktiv ? "Arkiver" : "Hent fram"}
        </button>
        <button type="button" className="fare" disabled={h.opptatt} onClick={() => slett(l)}>
          Slett
        </button>
      </span>
    </li>
  );

  return (
    <>
      <div className="kort">
        <div className="kort-topp">
          <h2>Sjekklistene</h2>
          <button type="button" className="primar" onClick={() => settSkjema({ navn: "", frekvens: "daglig", beskrivelse: null, roller: [], punkter: [] })}>
            <IkonPluss storrelse={16} /> Ny sjekkliste
          </button>
        </div>
        {melding && <div className="melding info">{melding}</div>}
        <Feil melding={h.feil} />
        {aktive.length ? (
          <ul className="liste-enkel oppsett-liste">{aktive.map(rad)}</ul>
        ) : (
          <p className="dempet">Ingen sjekklister ennå. Lag en ny, eller start fra et forslag under.</p>
        )}
        {forslag.length > 0 && (
          <div className="forslag" aria-label="Forslag">
            <span className="liten dempet">Forslag:</span>
            {forslag.map((m) => (
              <button key={m.navn} type="button" onClick={() => settSkjema(fraMal(m))}>
                <IkonPluss storrelse={14} /> {m.navn}
              </button>
            ))}
          </div>
        )}
        {arkiverte.length > 0 && (
          <>
            <h3 className="sjekk-arkivert">Arkivert</h3>
            <p className="liten dempet">Arkiverte sjekklister gjøres ikke, men historikken og avvikene finnes fortsatt.</p>
            <ul className="liste-enkel oppsett-liste">{arkiverte.map(rad)}</ul>
          </>
        )}
      </div>
      <p className="liten dempet">
        Avvik går som varsel til eier og administrator (og egne roller med Personal). Hvem som får hvilke varsler, velges under Innstillinger → App → Varsler.
      </p>
      <Dialog apen={!!skjema} lukk={() => settSkjema(null)} tittel={skjema?.id ? `Endre «${skjema.navn}»` : "Ny sjekkliste"} bred>
        {skjema && (
          <MalSkjema
            key={skjema.id ?? skjema.navn}
            start={skjema}
            roller={svar.roller}
            avbryt={() => settSkjema(null)}
            ferdig={(nyNavn) => {
              settSkjema(null);
              settMelding(skjema.id ? `«${nyNavn}» er lagret.` : `«${nyNavn}» er laget.`);
              endret();
            }}
          />
        )}
      </Dialog>
    </>
  );
}

type PunktUtkast = { nokkel: string; id?: string; tekst: string; hjelp: string; visHjelp: boolean };
let teller = 0;
const nyNokkel = () => `p${++teller}`;
// En linje som limes inn: uten punkttegn og nummer foran («- », «• », «1. », «[ ] »).
const renLinje = (s: string) => s.replace(/^\s*(?:[-*•–]|\d+[.)]|\[[ xX]?\])\s*/, "").trim();

function MalSkjema({ start, roller, avbryt, ferdig }: { start: Start; roller: Rolle[]; avbryt: () => void; ferdig: (navn: string) => void }) {
  const { org } = useKonto();
  const [navn, settNavn] = useState(start.navn);
  const [frekvens, settFrekvens] = useState<Frekvens>(start.frekvens);
  const [til, settTil] = useState<string[]>(start.roller.filter((r) => roller.some((x) => x.id === r)));
  const [beskrivelse, settBeskrivelse] = useState(start.beskrivelse ?? "");
  const [punkter, settPunkter] = useState<PunktUtkast[]>(() =>
    (start.punkter.length ? start.punkter : [{ tekst: "", hjelp: null }]).map((p) => ({ nokkel: nyNokkel(), id: p.id, tekst: p.tekst, hjelp: p.hjelp ?? "", visHjelp: !!p.hjelp })),
  );
  const h = useHandling();
  const felt = useRef(new Map<string, HTMLInputElement>());
  const [fokus, settFokus] = useState<string | null>(null);
  useEffect(() => {
    if (!fokus) return;
    felt.current.get(fokus)?.focus();
    settFokus(null);
  }, [fokus]);

  const endre = (i: number, e: Partial<PunktUtkast>) => settPunkter((l) => l.map((p, j) => (j === i ? { ...p, ...e } : p)));
  const leggTil = (etter: number, tekster: string[] = [""]) => {
    const nye = tekster.map((tekst) => ({ nokkel: nyNokkel(), tekst, hjelp: "", visHjelp: false }));
    settPunkter((l) => [...l.slice(0, etter + 1), ...nye, ...l.slice(etter + 1)]);
    settFokus(nye.at(-1)!.nokkel);
  };
  const fjern = (i: number) => settPunkter((l) => (l.length === 1 ? [{ nokkel: nyNokkel(), tekst: "", hjelp: "", visHjelp: false }] : l.filter((_, j) => j !== i)));
  const flytt = (i: number, j: number) =>
    settPunkter((l) => {
      const n = [...l];
      [n[i], n[j]] = [n[j]!, n[i]!];
      return n;
    });
  const veksle = (id: string) => settTil((t) => (t.includes(id) ? t.filter((x) => x !== id) : [...t, id]));

  // Flere linjer limt inn (f.eks. en liste fra et dokument) blir ett punkt per linje.
  function lim(i: number, e: ClipboardEvent<HTMLInputElement>) {
    const linjer = e.clipboardData.getData("text").split(/\r?\n/).map(renLinje).filter(Boolean);
    if (linjer.length < 2) return;
    e.preventDefault();
    const tom = !punkter[i]!.tekst.trim();
    if (tom) endre(i, { tekst: linjer[0]!.slice(0, 200) });
    leggTil(
      i,
      (tom ? linjer.slice(1) : linjer).map((l) => l.slice(0, 200)),
    );
  }

  async function lagre(e: FormEvent) {
    e.preventDefault();
    const liste = punkter.map((p) => ({ id: p.id, tekst: p.tekst.trim(), hjelp: p.hjelp.trim() || null })).filter((p) => p.tekst);
    if (!liste.length) return h.settFeil("Legg inn minst ett punkt");
    const kropp = { navn: navn.trim(), beskrivelse: beskrivelse.trim() || null, frekvens, roller: til, punkter: liste };
    const ok = await h.kjor(() =>
      (start.id ? api("PUT", `/org/${org!.id}/sjekklister/${start.id}`, kropp) : api("POST", `/org/${org!.id}/sjekklister`, kropp)).then(() => true),
    );
    if (ok) ferdig(navn.trim());
  }

  return (
    <form className="sjekk-skjema" onSubmit={lagre}>
      <label>
        Navn
        <input required minLength={2} maxLength={80} value={navn} onChange={(e) => settNavn(e.target.value)} placeholder="F.eks. Åpning, Varemottak eller Renhold" autoFocus={!start.navn} />
      </label>
      <div className="sjekk-felt">
        <span className="sjekk-etikett">Hvor ofte</span>
        <div className="faner valg sjekk-frekvens" role="radiogroup" aria-label="Hvor ofte">
          {FREKVENSER.map((f) => (
            <button key={f} type="button" role="radio" aria-checked={frekvens === f} className={frekvens === f ? "valgt" : undefined} onClick={() => settFrekvens(f)}>
              {FREKVENSNAVN[f]}
            </button>
          ))}
        </div>
        <span className="felt-hjelp">{FREKVENSHJELP[frekvens]}</span>
      </div>
      <div className="sjekk-felt">
        <span className="sjekk-etikett">Hvem gjør den</span>
        {roller.length > 0 ? (
          <>
            <div className="beskjed-til sjekk-roller" role="group" aria-label="Hvem gjør den">
              <button type="button" aria-pressed={til.length === 0} onClick={() => settTil([])}>
                Alle
              </button>
              {roller.map((r) => (
                <button key={r.id} type="button" aria-pressed={til.includes(r.id)} onClick={() => veksle(r.id)}>
                  {r.navn}
                </button>
              ))}
            </div>
            <span className="felt-hjelp">
              {til.length ? "Bare de med rollene ser og gjør sjekklisten (og administrator)." : "Alle i organisasjonen ser og kan gjøre sjekklisten."}
            </span>
          </>
        ) : (
          <span className="felt-hjelp">Alle i organisasjonen kan gjøre den. Vil du at bare noen skal ha den (f.eks. lageret), lag roller under Ansatte.</span>
        )}
      </div>
      <label>
        Beskrivelse <span className="dempet">(valgfritt)</span>
        <textarea rows={2} maxLength={1000} value={beskrivelse} onChange={(e) => settBeskrivelse(e.target.value)} placeholder="Vises øverst når sjekklisten fylles ut" />
      </label>

      <div className="sjekk-felt">
        <span className="sjekk-etikett">Punktene</span>
        <span className="felt-hjelp sjekk-punkthjelp">Enter gir et nytt punkt. Limer du inn en liste, blir hver linje et punkt.</span>
        <ol className="sjekk-redigering">
          {punkter.map((p, i) => (
            <li key={p.nokkel}>
              <span className="sjekk-nr" aria-hidden="true">
                {i + 1}
              </span>
              <input
                className="sjekk-punkt-felt"
                ref={(el) => {
                  if (el) felt.current.set(p.nokkel, el);
                  else felt.current.delete(p.nokkel);
                }}
                aria-label={`Punkt ${i + 1}`}
                maxLength={200}
                value={p.tekst}
                placeholder="Hva skal sjekkes?"
                onChange={(e) => endre(i, { tekst: e.target.value })}
                onPaste={(e) => lim(i, e)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    leggTil(i);
                  }
                }}
              />
              <span className="knapper sjekk-punkt-knapper">
                <button type="button" className="ikon" aria-label={`Flytt punkt ${i + 1} opp`} title="Flytt opp" disabled={i === 0} onClick={() => flytt(i, i - 1)}>
                  <IkonOpp storrelse={16} />
                </button>
                <button type="button" className="ikon" aria-label={`Flytt punkt ${i + 1} ned`} title="Flytt ned" disabled={i === punkter.length - 1} onClick={() => flytt(i, i + 1)}>
                  <IkonNed storrelse={16} />
                </button>
                <button type="button" className="ikon" aria-label={`Fjern punkt ${i + 1}`} title="Fjern" onClick={() => fjern(i)}>
                  <IkonLukk storrelse={16} />
                </button>
              </span>
              {p.visHjelp ? (
                <input
                  className="sjekk-veiledning"
                  aria-label={`Veiledning til punkt ${i + 1}`}
                  maxLength={500}
                  value={p.hjelp}
                  placeholder="Veiledning, f.eks. «Under 4 grader»"
                  onChange={(e) => endre(i, { hjelp: e.target.value })}
                />
              ) : (
                <button type="button" className="lenke liten sjekk-legg-veiledning" onClick={() => endre(i, { visHjelp: true })}>
                  + Veiledning
                </button>
              )}
            </li>
          ))}
        </ol>
        <button type="button" onClick={() => leggTil(punkter.length - 1)}>
          <IkonPluss storrelse={16} /> Legg til punkt
        </button>
        {start.id && <p className="felt-hjelp">Punkter som fjernes, blir borte fra lista framover; svarene som er gitt på dem, står fortsatt i historikken.</p>}
      </div>

      <Feil melding={h.feil} />
      <div className="knapper sjekk-skjema-knapper">
        <button className="primar" disabled={h.opptatt}>
          {start.id ? "Lagre" : "Lag sjekklisten"}
        </button>
        <button type="button" className="lenke" onClick={avbryt}>
          Avbryt
        </button>
      </div>
    </form>
  );
}
