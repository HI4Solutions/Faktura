// AI (Gemini i Google Cloud): fakturautkast fra tekst eller tale. Opptaket gjøres i
// nettleseren (MediaRecorder) og sendes til serveren, som lar Gemini både skrive ned og
// fylle ut. Svaret fyller skjemaet; brukeren ser over før noe lagres eller sendes.
import { useEffect, useRef, useState } from "react";
import { api, sendLyd } from "./api";
import { Feil } from "./felles";
import { IkonGnist, IkonMikrofon } from "./ikoner";

export type AiLinje = { produkt_id: string | null; beskrivelse: string; antall: number; enhet: string; enhetspris: number | null; mva_sats: number; rabatt_prosent: number | null };
export type AiUtkast = {
  transkripsjon: string | null;
  kunde_id: string | null;
  kunde_navn: string | null;
  linjer: AiLinje[];
  fakturadato: string | null;
  forfallsdato: string | null;
  periode_fra: string | null;
  periode_til: string | null;
  deres_referanse: string | null;
  kommentar: string | null;
  merknader: string[];
};

const MAKS_SEK = 120;
// Lydformatene i prioritert rekkefølge (Chrome og Android: webm, Safari: mp4).
const TYPER = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];

export const kanTaOpp = () =>
  typeof window !== "undefined" && typeof MediaRecorder !== "undefined" && Boolean(navigator.mediaDevices?.getUserMedia);

// Opptak fra mikrofonen: start, stopp (eller stopp av seg selv etter to minutter).
export function useOpptak(ferdig: (lyd: Blob) => void) {
  const [tar, settTar] = useState(false);
  const [sek, settSek] = useState(0);
  const [feil, settFeil] = useState<string | null>(null);
  const opptaker = useRef<MediaRecorder | null>(null);
  const klokke = useRef<number | null>(null);
  const ferdigRef = useRef(ferdig);
  ferdigRef.current = ferdig;

  const ryddKlokke = () => {
    if (klokke.current) window.clearInterval(klokke.current);
    klokke.current = null;
  };
  // Siden forlates midt i et opptak: slå av mikrofonen.
  useEffect(
    () => () => {
      ryddKlokke();
      const r = opptaker.current;
      if (r && r.state !== "inactive") {
        r.onstop = null;
        r.stop();
        r.stream.getTracks().forEach((t) => t.stop());
      }
    },
    [],
  );

  async function start() {
    settFeil(null);
    let strom: MediaStream;
    try {
      strom = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch (e) {
      const navn = (e as DOMException)?.name;
      settFeil(
        navn === "NotAllowedError" || navn === "SecurityError"
          ? "Appen fikk ikke bruke mikrofonen. Gi tilgang i innstillingene for nettleseren, eller skriv i stedet."
          : "Fant ingen mikrofon. Skriv i stedet.",
      );
      return;
    }
    const type = TYPER.find((t) => MediaRecorder.isTypeSupported?.(t));
    const r = new MediaRecorder(strom, type ? { mimeType: type, audioBitsPerSecond: 32_000 } : undefined);
    const biter: Blob[] = [];
    r.ondataavailable = (e) => {
      if (e.data.size) biter.push(e.data);
    };
    r.onstop = () => {
      ryddKlokke();
      strom.getTracks().forEach((t) => t.stop());
      settTar(false);
      const lyd = new Blob(biter, { type: (r.mimeType || type || "audio/webm").split(";")[0] });
      if (lyd.size) ferdigRef.current(lyd);
    };
    opptaker.current = r;
    r.start(1000);
    settTar(true);
    settSek(0);
    const startet = Date.now();
    klokke.current = window.setInterval(() => {
      const s = Math.floor((Date.now() - startet) / 1000);
      settSek(s);
      if (s >= MAKS_SEK && r.state === "recording") r.stop();
    }, 250);
  }

  const stopp = () => {
    if (opptaker.current?.state === "recording") opptaker.current.stop();
  };
  return { tar, sek, feil, start, stopp };
}

const tid = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

// Boksen øverst i «Ny faktura»: skriv eller snakk inn, og få skjemaet fylt ut.
export function AiFaktura({ orgId, bruk }: { orgId: string; bruk: (u: AiUtkast) => void }) {
  const [tekst, settTekst] = useState("");
  const [opptatt, settOpptatt] = useState<null | "lytter" | "lager">(null);
  const [feil, settFeil] = useState<string | null>(null);
  const [fylt, settFylt] = useState<AiUtkast | null>(null);
  const opptak = useOpptak((lyd) => lag(lyd));

  async function lag(lyd?: Blob) {
    settFeil(null);
    settFylt(null);
    settOpptatt(lyd ? "lytter" : "lager");
    try {
      const u = lyd ? await sendLyd<AiUtkast>(`/org/${orgId}/ai/faktura`, lyd) : await api<AiUtkast>("POST", `/org/${orgId}/ai/faktura`, { tekst });
      if (u.transkripsjon) settTekst(u.transkripsjon);
      bruk(u);
      settFylt(u);
    } catch (e) {
      settFeil((e as Error).message);
    } finally {
      settOpptatt(null);
    }
  }

  const stotter = kanTaOpp();
  return (
    <div className="kort ai-kort">
      <div className="ai-topp">
        <span className="ai-ikon" aria-hidden="true">
          <IkonGnist storrelse={18} />
        </span>
        <div>
          <h2>Lag med AI</h2>
          <p className="liten dempet">Skriv{stotter ? " eller si" : ""} hva som skal faktureres, så fyller AI-en ut skjemaet. Se over før du sender.</p>
        </div>
      </div>
      <textarea
        rows={3}
        value={tekst}
        aria-label="Hva skal faktureres?"
        placeholder="F.eks. «Husleie for oktober til Kari Hansen, og to timer vask à 500 kr inkl. mva. Forfall om 14 dager.»"
        onChange={(e) => settTekst(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && tekst.trim().length >= 3 && !opptatt) void lag();
        }}
        disabled={opptak.tar || opptatt !== null}
      />
      <div className="knapper ai-knapper">
        {stotter &&
          (opptak.tar ? (
            <button type="button" className="ai-stopp" onClick={opptak.stopp} aria-label={`Stopp opptaket (${tid(opptak.sek)})`}>
              <span className="ai-prikk" aria-hidden="true" /> Stopp {tid(opptak.sek)}
            </button>
          ) : (
            <button type="button" onClick={opptak.start} disabled={opptatt !== null}>
              <IkonMikrofon storrelse={16} /> Snakk inn
            </button>
          ))}
        <button type="button" className="primar" onClick={() => lag()} disabled={tekst.trim().length < 3 || opptatt !== null || opptak.tar}>
          <IkonGnist storrelse={16} /> Fyll ut
        </button>
        {opptatt && (
          <span className="dempet liten ai-status" role="status">
            <span className="spinner" /> {opptatt === "lytter" ? "Lytter og fyller ut …" : "Fyller ut …"}
          </span>
        )}
        {opptak.tar && <span className="dempet liten">Snakk fritt, og trykk Stopp når du er ferdig.</span>}
      </div>
      <Feil melding={opptak.feil ?? feil} />
      {fylt && !opptatt && !opptak.tar && (
        <div className="melding info ai-resultat" role="status">
          Skjemaet er fylt ut{fylt.linjer.length ? ` med ${fylt.linjer.length === 1 ? "én linje" : `${fylt.linjer.length} linjer`}` : ""}. Se over kunde, linjer og
          datoer før du sender.
          {fylt.merknader.length > 0 && (
            <ul>
              {fylt.merknader.map((m, i) => (
                <li key={i}>{m}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

// «AI: …» foran grunnen til et forslag på en innbetaling: merket for seg, og resten som tekst.
export function aiGrunn(grunn: string | null | undefined): { ai: boolean; usikker: boolean; tekst: string | null } {
  const m = grunn?.match(/^AI( \(usikker\))?: (.*)$/s);
  return m ? { ai: true, usikker: Boolean(m[1]), tekst: m[2] } : { ai: false, usikker: false, tekst: grunn ?? null };
}

export function AiMerke({ usikker }: { usikker?: boolean }) {
  return (
    <span className="ai-merke" title={usikker ? "Forslag fra AI (usikkert)" : "Forslag fra AI"}>
      <IkonGnist storrelse={12} /> AI{usikker ? " · usikker" : ""}
    </span>
  );
}
