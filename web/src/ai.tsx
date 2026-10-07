// AI (Gemini i Google Cloud): fakturautkast fra tekst eller tale. Opptaket gjøres i
// nettleseren (MediaRecorder), og serveren lar Gemini skrive det ned. Teksten kommer i
// feltet, så brukeren ser hva som ble hørt (og kan rette det) før skjemaet fylles ut.
// Svaret fyller skjemaet; brukeren ser over før noe lagres eller sendes.
import { useEffect, useRef, useState } from "react";
import { api, sendLyd } from "./api";
import { Feil } from "./felles";
import { IkonGnist, IkonMikrofon } from "./ikoner";

export type AiLinje = { produkt_id: string | null; beskrivelse: string; antall: number; enhet: string; enhetspris: number | null; mva_sats: number; rabatt_prosent: number | null };
export type AiUtkast = {
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

// Opptak fra mikrofonen: start, stopp (eller stopp av seg selv etter maksSek). Lyden måles
// mens den tas opp: et opptak der ingen sa noe, forkastes i stedet for å sendes. Med
// stilleStopp stopper opptaket av seg selv når man har sagt noe og så er stille litt.
// niva (0–1) er hvor høyt det er akkurat nå.
export function useOpptak(ferdig: (lyd: Blob) => void, valg: { stilleStopp?: boolean; maksSek?: number } = {}) {
  const [tar, settTar] = useState(false);
  const [sek, settSek] = useState(0);
  const [niva, settNiva] = useState(0);
  const [feil, settFeil] = useState<string | null>(null);
  const opptaker = useRef<MediaRecorder | null>(null);
  const klokke = useRef<number | null>(null);
  const lydkontekst = useRef<AudioContext | null>(null);
  const forkast = useRef(false);
  const ferdigRef = useRef(ferdig);
  ferdigRef.current = ferdig;
  const maks = valg.maksSek ?? MAKS_SEK;

  const rydd = () => {
    if (klokke.current) window.clearInterval(klokke.current);
    klokke.current = null;
    void lydkontekst.current?.close().catch(() => undefined);
    lydkontekst.current = null;
    settNiva(0);
  };
  // Siden forlates midt i et opptak: slå av mikrofonen.
  useEffect(
    () => () => {
      rydd();
      const r = opptaker.current;
      if (r && r.state !== "inactive") {
        r.onstop = null;
        r.stop();
        r.stream.getTracks().forEach((t) => t.stop());
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // true når opptaket er i gang (false: ingen mikrofon eller ingen tilgang).
  async function start(): Promise<boolean> {
    settFeil(null);
    forkast.current = false;
    // Konteksten for å måle lyden lages i trykket (iOS krever det).
    let ctx: AudioContext | null = null;
    try {
      const Ctx = window.AudioContext ?? (window as any).webkitAudioContext;
      ctx = Ctx ? new Ctx() : null;
      void ctx?.resume().catch(() => undefined);
    } catch {
      ctx = null;
    }
    let strom: MediaStream;
    try {
      strom = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch (e) {
      void ctx?.close().catch(() => undefined);
      const navn = (e as DOMException)?.name;
      settFeil(
        navn === "NotAllowedError" || navn === "SecurityError"
          ? "Appen fikk ikke bruke mikrofonen. Gi tilgang i innstillingene for nettleseren, eller skriv i stedet."
          : "Fant ingen mikrofon. Skriv i stedet.",
      );
      return false;
    }
    const type = TYPER.find((t) => MediaRecorder.isTypeSupported?.(t));
    const r = new MediaRecorder(strom, type ? { mimeType: type, audioBitsPerSecond: 32_000 } : undefined);
    const biter: Blob[] = [];
    // Målingen av lyden (se under): hørte vi noe som ligner tale?
    let snakket = false;
    let hoyest = 0;
    r.ondataavailable = (e) => {
      if (e.data.size) biter.push(e.data);
    };
    r.onstop = () => {
      rydd();
      strom.getTracks().forEach((t) => t.stop());
      settTar(false);
      // Ingen tale (og målingen virket): send ikke stillhet til AI-en.
      if (forkast.current || (hoyest > 0 && !snakket)) {
        settFeil("Hørte ingenting. Prøv igjen, eller skriv i stedet.");
        return;
      }
      const lyd = new Blob(biter, { type: (r.mimeType || type || "audio/webm").split(";")[0] });
      if (lyd.size) ferdigRef.current(lyd);
    };
    opptaker.current = r;
    r.start(1000);
    settTar(true);
    settSek(0);
    const startet = Date.now();

    let analyse: (() => number) | null = null;
    if (ctx) {
      try {
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 1024;
        ctx.createMediaStreamSource(strom).connect(analyser);
        const buf = new Float32Array(analyser.fftSize);
        analyse = () => {
          analyser.getFloatTimeDomainData(buf);
          let sum = 0;
          for (const x of buf) sum += x * x;
          return Math.sqrt(sum / buf.length);
        };
        lydkontekst.current = ctx;
      } catch {
        void ctx.close().catch(() => undefined);
      }
    }
    // Støynivået er det laveste i de siste tre sekundene (også mellom ordene), og tale er
    // tydelig høyere enn det i minst to tideler på rad (et klikk er ikke tale). De første
    // tidelene (trykket, mikrofonen som starter) teller ikke.
    const siste: number[] = [];
    let over = 0;
    let stilleFra = 0;
    klokke.current = window.setInterval(() => {
      const ms = Date.now() - startet;
      settSek(Math.floor(ms / 1000));
      if (ms >= maks * 1000 && r.state === "recording") return r.stop();
      if (!analyse) return;
      const rms = analyse();
      settNiva(Math.min(1, rms * 12));
      siste.push(rms);
      if (siste.length > 30) siste.shift();
      if (ms < 300) return;
      hoyest = Math.max(hoyest, rms);
      const stoy = [...siste].sort((a, b) => a - b)[Math.floor(siste.length / 10)];
      if (rms > Math.max(0.01, stoy * 2.5)) {
        if (++over >= 2) snakket = true;
        stilleFra = 0;
        return;
      }
      over = 0;
      if (valg.stilleStopp && snakket) {
        stilleFra ||= Date.now();
        if (Date.now() - stilleFra > 1500 && r.state === "recording") r.stop();
      } else if (valg.stilleStopp && !snakket && ms > 9000 && hoyest > 0 && r.state === "recording") {
        // Ingen sa noe (og mikrofonen virker): forkast.
        forkast.current = true;
        r.stop();
      }
    }, 100);
    return true;
  }

  const stopp = () => {
    if (opptaker.current?.state === "recording") opptaker.current.stop();
  };
  return { tar, sek, niva, feil, start, stopp, settFeil };
}

const tid = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

// Boksen øverst i «Ny faktura»: skriv eller snakk inn, og få skjemaet fylt ut. Tale skrives
// ned i feltet først, så man ser hva som ble hørt før man trykker «Fyll ut».
export function AiFaktura({ orgId, bruk }: { orgId: string; bruk: (u: AiUtkast) => void }) {
  const [tekst, settTekst] = useState("");
  const [fraTale, settFraTale] = useState(false);
  const [opptatt, settOpptatt] = useState<null | "skriver" | "lager">(null);
  const [feil, settFeil] = useState<string | null>(null);
  const [fylt, settFylt] = useState<AiUtkast | null>(null);
  const opptak = useOpptak((lyd) => void skrivNed(lyd));

  async function skrivNed(lyd: Blob) {
    settFeil(null);
    settOpptatt("skriver");
    try {
      const { tekst: hort } = await sendLyd<{ tekst: string }>(`/org/${orgId}/ai/faktura/tale`, lyd);
      settTekst((t) => (t.trim() ? `${t.trim()} ${hort}` : hort));
      settFraTale(true);
      settFylt(null);
    } catch (e) {
      settFeil((e as Error).message);
    } finally {
      settOpptatt(null);
    }
  }

  async function lag() {
    settFeil(null);
    settFylt(null);
    settFraTale(false);
    settOpptatt("lager");
    try {
      const u = await api<AiUtkast>("POST", `/org/${orgId}/ai/faktura`, { tekst });
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
      {fraTale && tekst.trim() && !opptatt && !opptak.tar && <p className="liten dempet ai-hint">Skrevet ned fra tale. Sjekk teksten, og trykk «Fyll ut».</p>}
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
            <span className="spinner" /> {opptatt === "skriver" ? "Skriver ned …" : "Fyller ut …"}
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
