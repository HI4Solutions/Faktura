// AI-assistenten: knappen nederst til høyre på alle sider. Trykk på den, og velg å snakke
// eller skrive. Tale skrives ned i feltet først, så du ser hva som ble hørt (og kan rette
// det) før du sender. Så tolker Gemini kommandoen. Spørsmål («har Kari betalt?») besvares,
// og det som endrer noe (sende en faktura, registrere en betaling, sende purring) vises som
// forslag du bekrefter med ett trykk. Forslagene utføres med de vanlige rutene i API-et,
// med dine tilganger.
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { api, hent, sendLyd } from "./api";
import { dataEndret, Feil, useData } from "./felles";
import { kanTaOpp, useOpptak, type AiUtkast } from "./ai";
import { IkonGnist, IkonLukk, IkonMikrofon, IkonTastatur } from "./ikoner";
import { useKonto } from "./konto";

type Forslag =
  | { type: "ny_faktura"; tekst: string; knapp: string; send: boolean; gebyr: boolean; utkast: AiUtkast }
  | { type: "send_utkast"; tekst: string; knapp: string; faktura_id: string }
  | { type: "send_igjen"; tekst: string; knapp: string; faktura_id: string; fakturanummer: number }
  | { type: "betaling"; tekst: string; knapp: string; faktura_id: string; fakturanummer: number; belop: number; dato: string }
  | { type: "purring"; tekst: string; knapp: string; faktura_id: string; fakturanummer: number; purring: "paaminnelse" | "inkassovarsel" };
type Lenke = { tekst: string; til: string };
type Svar = { tekst: string; forslag: Forslag[]; lenker: Lenke[]; gaa_til: string | null; utkast: AiUtkast | null };
type Utfall = { status: "venter" | "utforer" | "ferdig" | "feil" | "avvist"; melding?: string; lenke?: Lenke };
type Melding = {
  id: number;
  rolle: "bruker" | "assistent";
  tekst: string;
  feil?: boolean;
  forslag?: { f: Forslag; u: Utfall }[];
  lenker?: Lenke[];
  utkast?: AiUtkast | null;
};

const EKSEMPLER = ["Hvem skylder oss penger?", "Har det kommet noen betalinger?", "Send purring på alle forfalte", "Vis utkastene"];
const tid = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

// Utfører et bekreftet forslag med de vanlige rutene.
async function utfor(orgId: string, f: Forslag): Promise<{ melding: string; lenke?: Lenke }> {
  const til = (id: string) => ({ tekst: "Åpne fakturaen", til: `/fakturaer/${id}` });
  if (f.type === "ny_faktura") {
    const u = f.utkast;
    const ny = await api("POST", `/org/${orgId}/fakturaer`, {
      kunde_id: u.kunde_id,
      fakturadato: u.fakturadato,
      forfallsdato: u.forfallsdato,
      periode_fra: u.periode_fra,
      periode_til: u.periode_til,
      deres_referanse: u.deres_referanse,
      kommentar: u.kommentar,
      gebyr: f.gebyr,
      linjer: u.linjer.map((l) => ({
        produkt_id: l.produkt_id,
        beskrivelse: l.beskrivelse,
        antall: l.antall,
        enhet: l.enhet,
        enhetspris: l.enhetspris ?? 0,
        mva_sats: l.mva_sats,
        rabatt_prosent: l.rabatt_prosent,
      })),
    });
    if (!f.send) return { melding: "Utkastet er lagret.", lenke: til(ny.id) };
    try {
      const s = await api("POST", `/org/${orgId}/fakturaer/${ny.id}/utsted`, { send_epost: true });
      return { melding: `Faktura ${s.fakturanummer} er sendt.`, lenke: til(ny.id) };
    } catch (e) {
      throw Object.assign(new Error(`Utkastet er lagret, men ikke sendt: ${(e as Error).message}`), { lenke: til(ny.id) });
    }
  }
  if (f.type === "send_utkast") {
    const s = await api("POST", `/org/${orgId}/fakturaer/${f.faktura_id}/utsted`, { send_epost: true });
    return { melding: `Faktura ${s.fakturanummer} er sendt.`, lenke: til(f.faktura_id) };
  }
  if (f.type === "send_igjen") {
    await api("POST", `/org/${orgId}/fakturaer/${f.faktura_id}/send`, {});
    return { melding: `Faktura ${f.fakturanummer} er sendt på nytt.`, lenke: til(f.faktura_id) };
  }
  if (f.type === "betaling") {
    await api("POST", `/org/${orgId}/fakturaer/${f.faktura_id}/betalinger`, { belop: f.belop, dato: f.dato, notat: "Registrert med AI-assistenten" });
    return { melding: `Betalingen er registrert på faktura ${f.fakturanummer}.`, lenke: til(f.faktura_id) };
  }
  await api("POST", `/org/${orgId}/fakturaer/${f.faktura_id}/purring`, { type: f.purring });
  return { melding: `${f.purring === "paaminnelse" ? "Påminnelsen" : "Inkassovarselet"} på faktura ${f.fakturanummer} er sendt.`, lenke: til(f.faktura_id) };
}

export function Assistent() {
  const { org } = useKonto();
  const orgData = useData(() => hent(`/org/${org!.id}`), [org?.id]);
  const nav = useNavigate();
  const tilgjengelig = Boolean(orgData.data?.ai_tilgjengelig && orgData.data?.ai_aktiv && org?.type !== "regnskapsbyraa");
  const [apen, settApen] = useState(false);
  const [logg, settLogg] = useState<Melding[]>([]);
  const [tekst, settTekst] = useState("");
  const [fraTale, settFraTale] = useState(false); // teksten i feltet er skrevet ned fra tale
  const [skriverNed, settSkriverNed] = useState(false);
  const [tenker, settTenker] = useState(false);
  const ref = useRef<HTMLDialogElement>(null);
  const loggRef = useRef<HTMLDivElement>(null);
  const feltRef = useRef<HTMLTextAreaElement>(null);
  const nesteId = useRef(1);
  const avbrutt = useRef(false);
  const opptak = useOpptak((lyd) => !avbrutt.current && void skrivNed(lyd), { stilleStopp: true, maksSek: 60 });
  const stotter = kanTaOpp();

  // Plass til knappen nederst på sidene, og ny samtale i en annen organisasjon.
  useEffect(() => {
    document.body.classList.toggle("med-assistent", tilgjengelig);
    return () => document.body.classList.remove("med-assistent");
  }, [tilgjengelig]);
  useEffect(() => settLogg([]), [org?.id]);

  // Knappen glir bort mens man blar nedover (så den ikke dekker felt), og kommer tilbake
  // når man blar opp eller er nederst.
  const [skjult, settSkjult] = useState(false);
  useEffect(() => {
    let forrige = window.scrollY;
    const blar = () => {
      const y = window.scrollY;
      const nederst = window.innerHeight + y >= document.documentElement.scrollHeight - 40;
      if (Math.abs(y - forrige) > 8) settSkjult(y > forrige && y > 80 && !nederst);
      forrige = y;
    };
    window.addEventListener("scroll", blar, { passive: true });
    return () => window.removeEventListener("scroll", blar);
  }, []);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (apen && !d.open) {
      d.showModal();
      // Med mus og tastatur kan man skrive med en gang; på mobil kommer tastaturet først når man velger «Skriv».
      if (window.matchMedia("(pointer: fine)").matches) feltRef.current?.focus();
    }
    if (!apen && d.open) d.close();
  }, [apen]);
  useEffect(() => {
    loggRef.current?.scrollTo({ top: loggRef.current.scrollHeight, behavior: "smooth" });
  }, [logg, tenker, opptak.tar, skriverNed]);
  // Feltet vokser med teksten (opptil fire–fem linjer), så en lengre kommando kan leses før den sendes.
  useEffect(() => {
    const f = feltRef.current;
    if (!f) return;
    f.style.height = "auto";
    f.style.height = `${Math.min(f.scrollHeight + 2, 140)}px`;
  }, [tekst, apen, skriverNed, opptak.tar]);

  const lukk = () => {
    if (opptak.tar) {
      avbrutt.current = true;
      opptak.stopp();
    }
    settApen(false);
  };
  const gaa = (til: string, state?: unknown) => {
    lukk();
    nav(til, state ? { state } : undefined);
  };
  const leggTil = (m: Omit<Melding, "id">) => {
    const id = nesteId.current++;
    settLogg((l) => [...l, { ...m, id }]);
    return id;
  };
  const endre = (id: number, endring: (m: Melding) => Melding) => settLogg((l) => l.map((m) => (m.id === id ? endring(m) : m)));

  // Det assistenten har sagt og gjort, så den forstår «den» og «henne» i neste kommando.
  const historikk = () =>
    logg
      .filter((m) => !m.feil)
      .slice(-8)
      .map((m) => ({
        rolle: m.rolle,
        tekst: [m.tekst, ...(m.forslag ?? []).filter((x) => x.u.status === "ferdig").map((x) => `Utført: ${x.u.melding}`)].join(" "),
      }));

  async function spor(t: string) {
    opptak.settFeil(null);
    leggTil({ rolle: "bruker", tekst: t });
    settTenker(true);
    try {
      const s = await api<Svar>("POST", `/org/${org!.id}/ai/assistent`, { tekst: t, historikk: historikk() });
      leggTil({
        rolle: "assistent",
        tekst: s.tekst,
        forslag: s.forslag.map((f) => ({ f, u: { status: "venter" } })),
        lenker: s.lenker,
        utkast: s.forslag.length ? null : s.utkast,
      });
      if (s.gaa_til) gaa(s.gaa_til);
    } catch (e) {
      leggTil({ rolle: "assistent", tekst: (e as Error).message, feil: true });
    } finally {
      settTenker(false);
    }
  }

  // Tale til tekst: det som ble hørt, kommer i feltet (etter det som står der fra før).
  async function skrivNed(lyd: Blob) {
    settSkriverNed(true);
    try {
      const { tekst: hort } = await sendLyd<{ tekst: string }>(`/org/${org!.id}/ai/assistent/tale`, lyd);
      settTekst((t) => (t.trim() ? `${t.trim()} ${hort}` : hort));
      settFraTale(true);
    } catch (e) {
      opptak.settFeil((e as Error).message);
    } finally {
      settSkriverNed(false);
    }
  }

  async function bekreft(meldingId: number, indekser: number[]) {
    const m = logg.find((x) => x.id === meldingId);
    if (!m?.forslag) return;
    for (const i of indekser) {
      const { f, u } = m.forslag[i];
      if (u.status !== "venter" && u.status !== "feil") continue;
      const sett = (ny: Utfall) =>
        endre(meldingId, (x) => ({ ...x, forslag: x.forslag!.map((y, j) => (j === i ? { ...y, u: ny } : y)) }));
      sett({ status: "utforer" });
      try {
        const r = await utfor(org!.id, f);
        sett({ status: "ferdig", ...r });
        dataEndret();
      } catch (e) {
        sett({ status: "feil", melding: (e as Error).message, lenke: (e as { lenke?: Lenke }).lenke });
      }
    }
  }
  const avvis = (meldingId: number, i: number) =>
    endre(meldingId, (x) => ({ ...x, forslag: x.forslag!.map((y, j) => (j === i ? { ...y, u: { status: "avvist" } } : y)) }));

  function snakk() {
    avbrutt.current = false;
    opptak.settFeil(null);
    void opptak.start();
  }
  function skriv() {
    opptak.settFeil(null);
    feltRef.current?.focus();
  }
  function send(ev?: FormEvent) {
    ev?.preventDefault();
    const t = tekst.trim();
    if (t.length < 2 || tenker || skriverNed || opptak.tar) return;
    settTekst("");
    settFraTale(false);
    void spor(t);
  }

  if (!tilgjengelig) return null;
  return (
    <>
      <button type="button" className={`assistent-knapp${skjult ? " skjult" : ""}`} onClick={() => settApen(true)} aria-label="AI-assistent" title="AI-assistent">
        <IkonGnist storrelse={26} />
      </button>
      <dialog ref={ref} className="assistent" onClose={lukk} onCancel={lukk} aria-label="AI-assistent">
        <div className="assistent-topp">
          <span className="ai-ikon" aria-hidden="true">
            <IkonGnist storrelse={18} />
          </span>
          <h2>AI-assistent</h2>
          {logg.length > 0 && (
            <button type="button" className="lenke" onClick={() => settLogg([])}>
              Ny samtale
            </button>
          )}
          <button type="button" className="ikon" aria-label="Lukk" onClick={lukk}>
            <IkonLukk storrelse={18} />
          </button>
        </div>

        <div className="assistent-logg" ref={loggRef} role="log" aria-live="polite">
          {logg.length === 0 && opptak.tar && (
            <div className="assistent-velkommen">
              <p>
                <strong>Jeg lytter.</strong> Si for eksempel «Send faktura til Kari Hansen for husleie oktober», «Har Fjordline betalt?», «Registrer
                betaling på faktura 1043» eller «Send purring på alle forfalte».
              </p>
            </div>
          )}
          {logg.length === 0 && !opptak.tar && (
            <div className="assistent-velkommen">
              <p>
                Hva vil du gjøre? {stotter ? "Snakk eller skriv" : "Skriv"}, for eksempel «Send faktura til Kari Hansen for husleie oktober», «Har Fjordline
                betalt?» eller «Registrer betaling på faktura 1043».
              </p>
              <div className="assistent-valg">
                {stotter && (
                  <button type="button" className="primar" onClick={snakk} disabled={tenker || skriverNed}>
                    <IkonMikrofon storrelse={20} /> Snakk
                  </button>
                )}
                <button type="button" onClick={skriv}>
                  <IkonTastatur storrelse={20} /> Skriv
                </button>
              </div>
              <p className="liten dempet">Eller prøv:</p>
              <div className="assistent-eksempler">
                {EKSEMPLER.map((e) => (
                  <button key={e} type="button" onClick={() => void spor(e)} disabled={tenker}>
                    {e}
                  </button>
                ))}
              </div>
              <p className="liten dempet">{stotter ? "Det du sier, skrives ned i feltet først, så du kan sjekke det før du sender. " : ""}Alt som sender, registrerer eller purrer, må du bekrefte.</p>
            </div>
          )}
          {logg.map((m) =>
            m.rolle === "bruker" ? (
              <div key={m.id} className="boble bruker">
                {m.tekst}
              </div>
            ) : (
              <div key={m.id} className={`boble assistent${m.feil ? " feil" : ""}`}>
                <p>{m.tekst}</p>
                {m.forslag && m.forslag.filter((x) => x.f.type === "purring" && x.u.status === "venter").length > 1 && (
                  <button
                    type="button"
                    className="primar"
                    onClick={() => void bekreft(m.id, m.forslag!.map((_, i) => i).filter((i) => m.forslag![i].f.type === "purring"))}
                  >
                    Send alle {m.forslag.filter((x) => x.f.type === "purring" && x.u.status === "venter").length}
                  </button>
                )}
                {m.forslag?.map(({ f, u }, i) => (
                  <div key={i} className={`assistent-forslag ${u.status}`}>
                    <p>{f.tekst}</p>
                    {(u.status === "venter" || u.status === "feil") && (
                      <div className="knapper">
                        <button type="button" className="primar" onClick={() => void bekreft(m.id, [i])}>
                          {u.status === "feil" ? "Prøv igjen" : f.knapp}
                        </button>
                        {f.type === "ny_faktura" && (
                          <button type="button" onClick={() => gaa("/fakturaer/ny", { aiUtkast: f.utkast })}>
                            Åpne i skjemaet
                          </button>
                        )}
                        <button type="button" className="lenke" onClick={() => avvis(m.id, i)}>
                          Avbryt
                        </button>
                      </div>
                    )}
                    {u.status === "utforer" && (
                      <span className="dempet liten assistent-status">
                        <span className="spinner" /> Utfører …
                      </span>
                    )}
                    {u.status === "ferdig" && <p className="ok-tekst">✓ {u.melding}</p>}
                    {u.status === "feil" && <p className="fare-tekst">{u.melding}</p>}
                    {u.status === "avvist" && <p className="dempet liten">Avbrutt.</p>}
                    {u.lenke && (u.status === "ferdig" || u.status === "feil") && (
                      <button type="button" className="lenke" onClick={() => gaa(u.lenke!.til)}>
                        {u.lenke.tekst}
                      </button>
                    )}
                  </div>
                ))}
                {m.utkast && (
                  <div className="knapper">
                    <button type="button" onClick={() => gaa("/fakturaer/ny", { aiUtkast: m.utkast })}>
                      Åpne i skjemaet
                    </button>
                  </div>
                )}
                {m.lenker && m.lenker.length > 0 && (
                  <div className="assistent-lenker">
                    {m.lenker.map((l) => (
                      <button key={l.til + l.tekst} type="button" className="lenke" onClick={() => gaa(l.til)}>
                        {l.tekst}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ),
          )}
          {tenker && (
            <div className="boble assistent tenker" role="status">
              <span className="spinner" /> Tenker …
            </div>
          )}
        </div>

        <Feil melding={opptak.feil} />
        {fraTale && tekst.trim() && !skriverNed && !opptak.tar && <p className="assistent-hint liten dempet">Skrevet ned fra tale. Sjekk teksten, og trykk Send.</p>}
        <form className="assistent-bunn" onSubmit={send}>
          {opptak.tar ? (
            <div className="assistent-lytter" role="status">
              <span className="assistent-niva" style={{ transform: `scaleX(${0.08 + opptak.niva * 0.92})` }} aria-hidden="true" />
              <span>Lytter … {tid(opptak.sek)}</span>
              <span className="dempet liten">Stopper når du tier</span>
            </div>
          ) : skriverNed ? (
            <div className="assistent-lytter" role="status">
              <span className="assistent-status">
                <span className="spinner" /> Skriver ned …
              </span>
            </div>
          ) : (
            <textarea
              ref={feltRef}
              rows={1}
              value={tekst}
              onChange={(e) => settTekst(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) send(e);
              }}
              placeholder={stotter ? "Skriv, eller trykk på mikrofonen" : "Skriv en kommando"}
              aria-label="Kommando til assistenten"
              enterKeyHint="send"
              maxLength={2000}
            />
          )}
          {stotter && (
            <button
              type="button"
              className={`assistent-mik${opptak.tar ? " tar" : ""}`}
              onClick={opptak.tar ? opptak.stopp : snakk}
              disabled={(tenker || skriverNed) && !opptak.tar}
              aria-label={opptak.tar ? "Stopp opptaket" : "Snakk"}
              title={opptak.tar ? "Stopp opptaket" : "Snakk"}
            >
              {opptak.tar ? <span className="assistent-stopp" aria-hidden="true" /> : <IkonMikrofon storrelse={22} />}
            </button>
          )}
          {tekst.trim() && !opptak.tar && !skriverNed && (
            <button type="submit" className="primar" disabled={tenker}>
              Send
            </button>
          )}
        </form>
      </dialog>
    </>
  );
}
