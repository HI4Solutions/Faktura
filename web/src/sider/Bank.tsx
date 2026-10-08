// Innbetalinger fra banken (open banking gjennom Enable Banking): kobling under
// Innstillinger → Faktura, siden der brukeren kommer tilbake etter BankID, og listen
// over innbetalinger som kobles til fakturaene.
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { api, hent } from "../api";
import { Dialog, Feil, Laster, Tom, useData, useHandling } from "../felles";
import { AiMerke, aiGrunn } from "../ai";
import { dato, kr } from "../format";
import { erAdmin, kanBokfore, useKonto } from "../konto";
import { Sokefelt } from "../sokefelt";
import { IkonGnist, IkonKlokke, IkonKroner } from "../ikoner";
import { HemmeligFelt, HemmeligTekst } from "../hemmelig";
import { Fakturafaner } from "../fakturameny";

// En konto i banken som er lagt inn i HI4 Faktura (bare de leses), med navnet derfra.
export interface BankKonto {
  kontonr: string;
  navn: string | null;
}

// Én bank (DNB, Storebrand …) med egen BankID-innlogging, eget samtykke og egne kontoer.
export interface Bankkobling {
  id: string;
  bank: string;
  psu_type: "business" | "personal";
  status: "venter" | "aktiv" | "feil";
  tilkoblet: boolean;
  kontoer: BankKonto[];
  andre_kontoer: number; // kontoer i banken som ikke er lagt inn i HI4 Faktura
  gyldig_til: string | null;
  fullfort: string | null;
  sist_hentet: string | null;
  siste_feil: string | null;
  auth_url: string | null;
  auth_tid: string | null;
}

export interface BankStatus {
  app: { app_id: string; app_navn: string | null } | null; // applikasjonen hos Enable Banking
  koblinger: Bankkobling[];
  fra: string | null; // innbetalinger hentes fra og med denne datoen
  fra_satt: boolean; // valgt av en administrator (ellers dagen organisasjonen ble opprettet)
  tilkoblet: boolean;
  hentetider: string[]; // når appen henter av seg selv hver dag (TT:MM, norsk tid)
  tilbake_url: string;
  antall: { forslag: number; uavklart: number; koblet: number; ignorert: number };
  ai: boolean; // AI kan foreslå fakturaen for uavklarte innbetalinger
}

const BANKER = ["DNB", "Storebrand", "Nordea", "Handelsbanken", "Danske Bank", "SpareBank 1 SR-Bank", "SpareBank 1 SMN", "SpareBank 1 Østlandet", "SpareBank 1 Nord-Norge"];
const pause = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
const kontonrTekst = (k: string) => k.replace(/^(\d{4})(\d{2})(\d{5})$/, "$1.$2.$3");
const kontotype = (t: Bankkobling["psu_type"]) => (t === "personal" ? "privatkonto" : "bedriftskonto");
const iDag = () => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Oslo" }).format(new Date());
export const dagerTil = (iso: string | null) => (iso ? Math.ceil((Date.parse(iso) - Date.now()) / 86_400_000) : null);
// «DNB», «DNB og Storebrand Bank», «DNB, Nordea og Storebrand Bank».
export const navnListe = (navn: string[]) => (navn.length <= 1 ? navn.join("") : `${navn.slice(0, -1).join(", ")} og ${navn.at(-1)}`);
// Kontonumrene er endret (kontonummeret eller Flere kontonumre): bankene viser kontoene på nytt.
export const kontoerEndret = () => window.dispatchEvent(new Event("faktura-kontoer"));

// Dato (ÅÅÅÅ-MM-DD) og klokkeslett (TT:MM) i Oslo: hentetidene er norsk tid.
const osloFormat = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Oslo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const iOslo = (t: Date) => {
  const d = Object.fromEntries(osloFormat.formatToParts(t).map((x) => [x.type, x.value]));
  return { dato: `${d.year}-${d.month}-${d.day}`, klokke: `${d.hour}:${d.minute}` };
};
// Neste hentetid etter nå: senere i dag, ellers den første i morgen.
export function nesteHenting(tider: string[] | undefined, naa = new Date()): { iDag: boolean; klokke: string } | null {
  if (!tider?.length) return null;
  const senere = tider.find((t) => t > iOslo(naa).klokke);
  return senere ? { iDag: true, klokke: senere } : { iDag: false, klokke: tider[0] };
}
// «i dag kl. 06:02», «i går kl. 18:00» eller «05.10.2026 kl. 12:00».
export function naarTekst(iso: string, naa = new Date()) {
  const t = iOslo(new Date(iso));
  const dag = t.dato === iOslo(naa).dato ? "i dag" : t.dato === iOslo(new Date(naa.getTime() - 86_400_000)).dato ? "i går" : dato(t.dato);
  return `${dag} kl.\u00a0${t.klokke}`;
}

// Tegner på nytt ved hvert nytt minutt (og når appen kommer fram igjen), så «neste henting»
// ikke blir stående på en tid som er passert.
function useMinutt() {
  const [naa, settNaa] = useState(() => new Date());
  useEffect(() => {
    let t = 0;
    const tikk = () => {
      settNaa(new Date());
      clearTimeout(t);
      t = window.setTimeout(tikk, 60_000 - (Date.now() % 60_000) + 50);
    };
    t = window.setTimeout(tikk, 60_000 - (Date.now() % 60_000) + 50);
    const synlig = () => document.visibilityState === "visible" && tikk();
    document.addEventListener("visibilitychange", synlig);
    return () => {
      clearTimeout(t);
      document.removeEventListener("visibilitychange", synlig);
    };
  }, []);
  return naa;
}

// Når appen henter innbetalingene av seg selv, neste gang og sist. Når en hentetid passerer
// mens siden er åpen, hentes statusen på nytt litt etter (workeren trenger litt tid).
export function Hentetider({ tider, sist, oppdater }: { tider: string[]; sist: string | null; oppdater?: () => void }) {
  const naa = useMinutt();
  const neste = nesteHenting(tider, naa);
  const forrige = useRef(neste && `${neste.iDag}${neste.klokke}`);
  const noekkel = neste && `${neste.iDag}${neste.klokke}`;
  useEffect(() => {
    if (forrige.current === noekkel) return;
    forrige.current = noekkel;
    if (!oppdater) return;
    const t = setTimeout(oppdater, 90_000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noekkel]);
  if (!neste) return null;
  return (
    <div className="hentetider">
      <IkonKlokke />
      <div>
        <div>
          Neste henting <strong>{neste.iDag ? "i dag" : "i morgen"} kl.&nbsp;{neste.klokke}</strong>
        </div>
        <div className="liten dempet">
          Automatisk hver dag kl.&nbsp;{navnListe(tider)}
          {sist ? ` · sist hentet ${naarTekst(sist, naa)}` : ""}
        </div>
      </div>
    </div>
  );
}

// BankID-adressen workeren lager for banken: spør til den er klar.
async function ventPaBankId(orgId: string, koblingId: string): Promise<string> {
  for (let i = 0; i < 40; i++) {
    await pause(1000);
    const k = (await hent<BankStatus>(`/org/${orgId}/bank`)).koblinger.find((x) => x.id === koblingId);
    if (!k) throw new Error("Banken er fjernet.");
    if (k.auth_url) return k.auth_url;
    if (k.siste_feil) throw new Error(k.siste_feil);
  }
  throw new Error("Banken svarte ikke. Prøv igjen om litt.");
}

// Venter til hentingen er ferdig i bankene (sist_hentet endres), høyst et halvt minutt.
async function ventPaHenting(orgId: string, for_: BankStatus): Promise<BankStatus | null> {
  const forrige = new Map(for_.koblinger.map((k) => [k.id, k.sist_hentet]));
  for (let i = 0; i < 30; i++) {
    await pause(1000);
    const s = await hent<BankStatus>(`/org/${orgId}/bank`);
    if (s.koblinger.filter((k) => k.tilkoblet && forrige.has(k.id)).every((k) => k.sist_hentet !== forrige.get(k.id))) return s;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Innstillinger → Faktura
// ---------------------------------------------------------------------------

export function BankKobling() {
  const { org, meg } = useKonto();
  const [sok] = useSearchParams();
  const { data, settData, last } = useData(() => hent<BankStatus>(`/org/${org!.id}/bank`), [org?.id]);
  // Første gang: applikasjonen hos Enable Banking og den første banken.
  const [skjema, settSkjema] = useState<{ app_id: string; privat_nokkel: string; filnavn: string | null; bank: string; psu_type: "business" | "personal" } | null>(null);
  // En bank til, med samme applikasjon.
  const [nyBank, settNyBank] = useState<{ bank: string; psu_type: "business" | "personal" } | null>(null);
  // Ny startdato for innbetalingene.
  const [endreFra, settEndreFra] = useState<string | null>(null);
  const [venter, settVenter] = useState<string | null>(null);
  const [melding, settMelding] = useState<string | null>(null);
  const h = useHandling();
  const admin = erAdmin(org?.rolle);

  // Hvilke kontoer som leses, følger kontonumrene som er lagt inn.
  useEffect(() => {
    window.addEventListener("faktura-kontoer", last);
    return () => window.removeEventListener("faktura-kontoer", last);
  }, [last]);

  async function koble(e: FormEvent) {
    e.preventDefault();
    if (!skjema?.privat_nokkel.includes("PRIVATE KEY")) return h.settFeil("Last opp .pem-filen med den private nøkkelen, eller lim inn innholdet i den.");
    const { filnavn: _, ...kropp } = skjema;
    const r = await h.kjor(() => api<BankStatus & { url: string }>("PUT", `/org/${org!.id}/bank`, kropp));
    if (r?.url) {
      settVenter("Sender deg til banken for BankID …");
      window.location.assign(r.url);
    }
  }

  // Workeren sjekker banken og lager BankID-adressen; brukeren sendes videre når den er klar.
  async function tilBankId(bank: string, start: () => Promise<{ kobling_id: string; ny?: boolean }>) {
    settVenter(`Gjør klar BankID for ${bank} …`);
    const url = await h.kjor(async () => {
      const r = await start();
      try {
        return await ventPaBankId(org!.id, r.kobling_id);
      } catch (feil) {
        // En ny bank som ikke kunne startes (feil navn o.l.), blir ikke liggende i listen.
        if (r.ny) await api("DELETE", `/org/${org!.id}/bank/koblinger/${r.kobling_id}`).catch(() => undefined);
        throw feil;
      }
    });
    if (url) return window.location.assign(url);
    settVenter(null);
    last();
  }

  function leggTil(e: FormEvent) {
    e.preventDefault();
    if (!nyBank) return;
    const bank = nyBank.bank.trim();
    void tilBankId(bank, () => api("POST", `/org/${org!.id}/bank/koblinger`, { ...nyBank, bank }));
  }

  const forny = (k: Bankkobling) => tilBankId(k.bank, () => api("POST", `/org/${org!.id}/bank/koblinger/${k.id}/forny`));

  async function fjern(k: Bankkobling) {
    if (!confirm(`Fjerne ${k.bank}? Innbetalinger hentes ikke lenger fra ${k.bank}. De som allerede er hentet og registrert, blir stående.`)) return;
    if (await h.kjor(async () => (await api("DELETE", `/org/${org!.id}/bank/koblinger/${k.id}`), true))) last();
  }

  async function hentNa() {
    settVenter("Henter innbetalinger …");
    await h.kjor(async () => {
      await api("POST", `/org/${org!.id}/bank/hent`);
      const s = await ventPaHenting(org!.id, data!);
      if (s) settData(s);
    });
    settVenter(null);
  }

  async function lagreFra(e: FormEvent) {
    e.preventDefault();
    const r = await h.kjor(() => api<BankStatus & { fjernet: number }>("PUT", `/org/${org!.id}/bank/fra`, { fra: endreFra || null }));
    if (!r) return;
    settData(r);
    settEndreFra(null);
    settMelding(r.fjernet ? `Fjernet ${r.fjernet} ${r.fjernet === 1 ? "innbetaling" : "innbetalinger"} fra før ${dato(r.fra)}.` : null);
  }

  async function kobleFra() {
    if (!confirm("Koble fra alle bankene og slette nøkkelen? Innbetalinger hentes ikke lenger. De som allerede er hentet og registrert, blir stående.")) return;
    if (await h.kjor(async () => (await api("DELETE", `/org/${org!.id}/bank`), true))) last();
  }

  if (!data) return null;
  const venterAntall = data.antall.forslag + data.antall.uavklart;
  const ny = sok.get("bank") === "ok" ? (data.koblinger.find((k) => k.id === sok.get("kobling")) ?? null) : null;
  const mfa = !meg?.mfa && <div className="melding info">Du må være logget inn med passkey eller kode fra autentiseringsappen for å koble til.</div>;

  return (
    <div className="kort">
      <h2 style={{ marginTop: 0 }}>Innbetalinger fra banken</h2>
      <p className="dempet liten">
        Appen leser innbetalingene på kontoene du har lagt inn i HI4 Faktura (kontonummeret og Flere kontonumre over), og registrerer
        betalinger på fakturaene av seg selv, uten KID-avtale med banken. Står fakturanummeret i meldingen, eller stemmer beløpet med det
        kunden skylder, kobles betalingen til fakturaen. Det du må se over, får du under Innbetalinger. Appen kan bare lese kontoene, ikke
        flytte penger.
      </p>
      {sok.get("bank") === "ok" && (ny ? ny.tilkoblet : data.tilkoblet) && (
        <div className="melding ok">{ny ? ny.bank : "Banken"} er koblet til. Innbetalingene hentes nå.</div>
      )}
      {venter && <div className="melding info">{venter}</div>}
      {melding && <div className="melding ok">{melding}</div>}

      {data.app ? (
        <>
          {data.koblinger.length > 0 ? (
            <div className="banker">
              {data.koblinger.map((k) => (
                <BankRad key={k.id} k={k} admin={admin} opptatt={h.opptatt || Boolean(venter)} forny={forny} fjern={fjern} />
              ))}
            </div>
          ) : (
            <p>Ingen bank er koblet til ennå.</p>
          )}
          {data.koblinger.some((k) => k.tilkoblet && k.kontoer.length > 0) && <Hentetider tider={data.hentetider} sist={null} oppdater={last} />}
          {endreFra === null && data.fra && (
            <p className="dempet liten">
              Henter innbetalinger fra og med {dato(data.fra)}
              {data.fra_satt ? "" : ", dagen dere begynte med HI4 Faktura"}. Eldre innbetalinger hentes ikke.{" "}
              {admin && !nyBank && (
                <button type="button" className="lenke" onClick={() => (h.settFeil(null), settMelding(null), settEndreFra(data.fra ?? iDag()))}>
                  Endre
                </button>
              )}
            </p>
          )}
          {venterAntall > 0 && (
            <p className="liten">
              <Link to="/innbetalinger">
                {venterAntall} {venterAntall === 1 ? "innbetaling venter" : "innbetalinger venter"} på deg
              </Link>
            </p>
          )}
          {nyBank ? (
            <form onSubmit={leggTil} className="ny-bank">
              <h3>Legg til bank</h3>
              <p className="dempet liten">
                Samme applikasjon hos Enable Banking brukes for alle bankene. Kontoen må først være koblet til applikasjonen der (Link accounts i
                Control Panel). Så logger du inn i banken med BankID her.
              </p>
              <div className="rad">
                <label>
                  Bank
                  <input required autoFocus list="banker" value={nyBank.bank} onChange={(e) => settNyBank({ ...nyBank, bank: e.target.value })} />
                </label>
                <label>
                  Kontotype
                  <select value={nyBank.psu_type} onChange={(e) => settNyBank({ ...nyBank, psu_type: e.target.value as "business" | "personal" })}>
                    <option value="business">Bedriftskonto</option>
                    <option value="personal">Privatkonto</option>
                  </select>
                </label>
              </div>
              {mfa}
              <Feil melding={h.feil} />
              <div className="knapper">
                <button className="primar" disabled={h.opptatt || Boolean(venter)}>
                  {h.opptatt ? "Gjør klar BankID …" : "Koble til med BankID"}
                </button>
                <button type="button" className="lenke" disabled={h.opptatt} onClick={() => (settNyBank(null), h.settFeil(null))}>
                  Avbryt
                </button>
              </div>
            </form>
          ) : endreFra !== null ? (
            <form onSubmit={lagreFra} className="ny-bank">
              <h3>Startdato for innbetalinger</h3>
              <p className="dempet liten">
                Eldre innbetalinger hentes ikke, og de som allerede er hentet, fjernes. Ble noen av dem registrert på en faktura av seg selv, tas
                betalingen bort igjen. Det du har registrert selv, blir stående.
              </p>
              <label>
                Hent innbetalinger fra og med
                <input type="date" required max={iDag()} value={endreFra} onChange={(e) => settEndreFra(e.target.value)} />
              </label>
              <Feil melding={h.feil} />
              <div className="knapper">
                <button className="primar" disabled={h.opptatt}>
                  {h.opptatt ? "Lagrer …" : "Lagre"}
                </button>
                <button type="button" className="lenke" disabled={h.opptatt} onClick={() => (settEndreFra(null), h.settFeil(null))}>
                  Avbryt
                </button>
              </div>
            </form>
          ) : (
            <>
              <Feil melding={h.feil} />
              <div className="knapper">
                {data.tilkoblet && (
                  <button type="button" className="primar" disabled={h.opptatt || Boolean(venter)} onClick={hentNa}>
                    Hent nå
                  </button>
                )}
                {admin && (
                  <button
                    type="button"
                    disabled={h.opptatt || Boolean(venter)}
                    onClick={() => (h.settFeil(null), settMelding(null), settNyBank({ bank: "", psu_type: "business" }))}
                  >
                    Legg til bank
                  </button>
                )}
                {admin && (
                  <button type="button" className="fare" disabled={h.opptatt || Boolean(venter)} onClick={kobleFra}>
                    Koble fra alt
                  </button>
                )}
              </div>
            </>
          )}
          <p className="dempet liten bank-app">
            Applikasjon hos Enable Banking{data.app.app_navn ? `: «${data.app.app_navn}»` : ""} · ID <HemmeligTekst verdi={data.app.app_id} />
          </p>
        </>
      ) : skjema ? (
        <form onSubmit={koble} className="bank-skjema">
          <ol className="steg liten">
            <li>
              Lag en gratis bruker hos{" "}
              <a href="https://enablebanking.com" target="_blank" rel="noreferrer">
                Enable Banking
              </a>{" "}
              og åpne Control Panel. Det er enklest fra en PC.
            </li>
            <li>
              Velg <strong>Register new application</strong> med miljøet <strong>Production</strong>. Kall den f.eks. «HI4 Faktura», og legg
              inn denne adressen under <strong>Allowed redirect URLs</strong>:
              <span className="kopier-felt">
                <code>{data.tilbake_url}</code>
                <button type="button" className="lenke" onClick={() => void navigator.clipboard?.writeText(data.tilbake_url)}>
                  Kopier
                </button>
              </span>
              Nettleseren laster ned en <strong>.pem-fil</strong> med den private nøkkelen. Ta vare på den.
            </li>
            <li>
              Velg <strong>Activate by linking accounts</strong> og koble til kontoene appen skal lese, med BankID i hver bank. Da kan
              applikasjonen bare lese kontoene du selv har koblet til, og den koster ingenting.
            </li>
            <li>
              Last opp .pem-filen her og lim inn applikasjonens ID (Application ID). Så logger du inn i den første banken med BankID en gang
              til. Flere banker legger du til etterpå.
            </li>
          </ol>
          <div className="rad">
            <div className="hel">
              <label style={{ marginBottom: 6 }}>
                Privat nøkkel (.pem-filen)
                {/* Uten accept: iPhone gråer ellers ut .pem-filer den ikke kjenner. Innholdet sjekkes her og av API-et. */}
                <input
                  type="file"
                  onChange={async (e) => {
                    const fil = e.target.files?.[0];
                    if (!fil) return;
                    const tekst = fil.size < 20_000 ? await fil.text() : "";
                    if (!tekst.includes("PRIVATE KEY")) {
                      h.settFeil(`«${fil.name}» inneholder ingen privat nøkkel. Velg .pem-filen du lastet ned fra Enable Banking.`);
                      return;
                    }
                    h.settFeil(null);
                    const id = fil.name.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0] ?? "";
                    settSkjema((s) => s && { ...s, privat_nokkel: tekst, filnavn: fil.name, app_id: s.app_id || id });
                  }}
                />
              </label>
              <p className="felt-hjelp" style={{ margin: "0 0 14px" }}>
                {skjema.filnavn ? `Valgt: ${skjema.filnavn}. ` : ""}Nøkkelen lagres kryptert, vises ikke igjen og brukes bare til å lese kontoene.{" "}
                {!skjema.filnavn && skjema.privat_nokkel === "" && (
                  <button type="button" className="lenke" onClick={() => settSkjema({ ...skjema, privat_nokkel: " " })}>
                    Lim inn nøkkelen i stedet
                  </button>
                )}
              </p>
              {!skjema.filnavn && skjema.privat_nokkel !== "" && (
                <div style={{ margin: "-6px 0 14px" }}>
                  <HemmeligFelt
                    aria-label="Privat nøkkel (innholdet i .pem-filen)"
                    placeholder="-----BEGIN PRIVATE KEY----- …"
                    verdi={skjema.privat_nokkel.trim()}
                    endre={(v) => settSkjema({ ...skjema, privat_nokkel: v || " " })}
                  />
                </div>
              )}
            </div>
            <label className="hel">
              Applikasjons-ID (Application ID)
              <HemmeligFelt required verdi={skjema.app_id} endre={(v) => settSkjema({ ...skjema, app_id: v.trim() })} />
            </label>
            <label>
              Bank
              <input required list="banker" value={skjema.bank} onChange={(e) => settSkjema({ ...skjema, bank: e.target.value })} />
            </label>
            <label>
              Kontotype
              <select value={skjema.psu_type} onChange={(e) => settSkjema({ ...skjema, psu_type: e.target.value as "business" | "personal" })}>
                <option value="business">Bedriftskonto</option>
                <option value="personal">Privatkonto (enkeltpersonforetak)</option>
              </select>
            </label>
          </div>
          {mfa}
          <Feil melding={h.feil} />
          <div className="knapper">
            <button className="primar" disabled={h.opptatt || Boolean(venter)}>
              {h.opptatt ? "Sjekker nøkkelen …" : "Koble til med BankID"}
            </button>
            <button type="button" className="lenke" onClick={() => (settSkjema(null), h.settFeil(null))}>
              Avbryt
            </button>
          </div>
        </form>
      ) : (
        <>
          <p>Banken er ikke koblet til. Betalinger registreres for hånd på fakturaen.</p>
          {admin && (
            <div className="knapper">
              <button type="button" className="primar" onClick={() => settSkjema({ app_id: "", privat_nokkel: "", filnavn: null, bank: "DNB", psu_type: "business" })}>
                Koble til banken
              </button>
            </div>
          )}
        </>
      )}
      <datalist id="banker">
        {BANKER.map((b) => (
          <option key={b} value={b} />
        ))}
      </datalist>
    </div>
  );
}

function BankRad({
  k,
  admin,
  opptatt,
  forny,
  fjern,
}: {
  k: Bankkobling;
  admin: boolean;
  opptatt: boolean;
  forny: (k: Bankkobling) => void;
  fjern: (k: Bankkobling) => void;
}) {
  const igjen = dagerTil(k.gyldig_til);
  const snart = igjen !== null && igjen < 14;
  return (
    <section className="bank" aria-label={k.bank}>
      <div className="bank-topp">
        <span>
          <strong>{k.bank}</strong> <span className="dempet liten">· {kontotype(k.psu_type)}</span>
        </span>
        {k.tilkoblet ? (
          <span className="merke merke-ok">Tilkoblet</span>
        ) : k.status === "venter" ? (
          <span className="merke merke-advarsel">BankID ikke fullført</span>
        ) : (
          <span className="merke merke-fare">Må kobles til på nytt</span>
        )}
      </div>
      {k.siste_feil && <div className="melding feil">{k.siste_feil}</div>}
      {k.tilkoblet && (
        <p className={`liten ${snart ? "advarsel-tekst" : "dempet"}`}>
          Lesetilgang til {dato(k.gyldig_til)}
          {snart ? ` (${igjen! <= 0 ? "går ut i dag" : `${igjen} ${igjen === 1 ? "dag" : "dager"} igjen`}). Forny med BankID.` : "."}
          {k.kontoer.length > 0 && k.sist_hentet && ` Sist hentet ${naarTekst(k.sist_hentet)}.`}
        </p>
      )}
      {k.tilkoblet && k.kontoer.length > 0 && (
        <ul className="bank-kontoer">
          {k.kontoer.map((x) => (
            <li key={x.kontonr}>
              {x.navn ?? "Konto"} <span className="dempet">{kontonrTekst(x.kontonr)}</span>
            </li>
          ))}
        </ul>
      )}
      {k.tilkoblet && k.kontoer.length === 0 && k.andre_kontoer > 0 && (
        <p className="liten advarsel-tekst">
          Ingen av kontoene i {k.bank} er lagt inn i HI4 Faktura ennå. Legg inn kontonummeret under Kontonummer eller Flere kontonumre, så
          hentes innbetalingene derfra.
        </p>
      )}
      {admin && (
        <div className="knapper">
          <button type="button" className={k.tilkoblet && !snart ? undefined : "primar"} disabled={opptatt} onClick={() => forny(k)}>
            {k.status === "venter" ? "Fortsett med BankID" : k.tilkoblet ? "Forny tilgang" : "Koble til på nytt"}
          </button>
          <button type="button" className="lenke" disabled={opptatt} onClick={() => fjern(k)}>
            Fjern
          </button>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Tilbake fra banken etter BankID
// ---------------------------------------------------------------------------

const behandlet = new Set<string>(); // React kjører effekten to ganger i utvikling

export function BankTilbake() {
  const nav = useNavigate();
  const [sok] = useSearchParams();
  const { velgOrg } = useKonto();
  const [feil, settFeil] = useState<string | null>(null);

  useEffect(() => {
    const kode = sok.get("code");
    const state = sok.get("state");
    const bankFeil = sok.get("error_description") ?? sok.get("error");
    const orgId = state?.split(".")[0];
    if (bankFeil) return settFeil(`Banken avbrøt innloggingen (${bankFeil}).`);
    if (!kode || !state || !orgId) return settFeil("Fikk ikke noe svar fra banken.");
    if (behandlet.has(state)) return;
    behandlet.add(state);
    velgOrg(orgId);
    (async () => {
      try {
        // Workeren bytter koden mot en ny økt; fullfort endres når den er klar.
        const r = await api<{ kobling_id: string; forrige: string | null }>("POST", `/org/${orgId}/bank/fullfor`, { code: kode, state });
        for (let i = 0; i < 45; i++) {
          await pause(1000);
          const k = (await hent<BankStatus>(`/org/${orgId}/bank`)).koblinger.find((x) => x.id === r.kobling_id);
          if (!k) throw new Error("Banken er fjernet. Legg den til på nytt under Innstillinger → Faktura.");
          if (k.siste_feil) throw new Error(k.siste_feil);
          if (k.tilkoblet && k.fullfort !== r.forrige) return nav(`/innstillinger?fane=betaling&bank=ok&kobling=${k.id}`, { replace: true });
        }
        throw new Error("Banken svarte ikke i tide. Se statusen under Innstillinger → Faktura.");
      } catch (e) {
        settFeil((e as Error).message);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="kort" style={{ maxWidth: 560 }}>
      <h1 style={{ marginTop: 0 }}>Kobler til banken</h1>
      {feil ? (
        <>
          <Feil melding={feil} />
          <Link className="knapp" to="/innstillinger?fane=betaling">
            Til Innstillinger → Faktura
          </Link>
        </>
      ) : (
        <>
          <p className="dempet">Fullfører koblingen og henter kontoene. Det tar noen sekunder.</p>
          <Laster />
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Innbetalinger
// ---------------------------------------------------------------------------

type Fane = "se" | "koblet" | "ignorert" | "alle";

export function Innbetalinger() {
  const { org } = useKonto();
  const [sok, settSok] = useSearchParams();
  const fane = (["se", "koblet", "ignorert", "alle"].includes(sok.get("vis") ?? "") ? sok.get("vis") : "se") as Fane;
  const bank = useData(() => hent<BankStatus>(`/org/${org!.id}/bank`), [org?.id], { oppdater: true });
  const { data, last } = useData(() => hent<{ transaksjoner: any[]; antall: BankStatus["antall"] }>(`/org/${org!.id}/banktransaksjoner?status=${fane}`), [org?.id, fane], { oppdater: true });
  const h = useHandling();
  const [velg, settVelg] = useState<any | null>(null);
  const [henter, settHenter] = useState(false);
  const [spor, settSpor] = useState<string | null>(null); // innbetalingen AI-en ser på
  const [aiSvar, settAiSvar] = useState<Record<string, string>>({}); // når AI-en ikke fant noen faktura
  const bokfore = kanBokfore(org?.rolle);

  const handling = async (sti: string, kropp?: unknown) => {
    if (await h.kjor(() => api("POST", `/org/${org!.id}/banktransaksjoner/${sti}`, kropp ?? {}))) {
      last();
      bank.last();
    }
  };

  // Be AI-en om et forslag. Finner den en faktura, blir det et forslag som må bekreftes.
  async function foreslaMedAi(id: string) {
    settSpor(id);
    const r = await h.kjor(() => api<{ transaksjon: any | null; grunn: string }>("POST", `/org/${org!.id}/banktransaksjoner/${id}/ai`));
    settSpor(null);
    if (!r) return;
    if (r.transaksjon) {
      last();
      bank.last();
    } else settAiSvar((x) => ({ ...x, [id]: r.grunn }));
  }

  async function hentNa() {
    settHenter(true);
    await h.kjor(async () => {
      await api("POST", `/org/${org!.id}/bank/hent`);
      await ventPaHenting(org!.id, bank.data!);
    });
    settHenter(false);
    last();
    bank.last();
  }

  const antall = data?.antall ?? bank.data?.antall;
  const aktive = bank.data?.koblinger.filter((k) => k.tilkoblet) ?? [];
  const sist = aktive.map((k) => k.sist_hentet ?? "").sort().at(-1) || null;
  // Med flere kontoer vises kontoen innbetalingen kom til.
  const kontoer = (bank.data?.koblinger ?? []).flatMap((k) => k.kontoer);
  const kontoNavn = kontoer.length > 1 ? new Map(kontoer.map((x) => [x.kontonr, x.navn ?? kontonrTekst(x.kontonr)])) : null;
  const faner: [Fane, string][] = [
    ["se", `Å se på${antall && antall.forslag + antall.uavklart ? ` (${antall.forslag + antall.uavklart})` : ""}`],
    ["koblet", "Registrert"],
    ["ignorert", "Ignorert"],
    ["alle", "Alle"],
  ];

  return (
    <>
      <div className="topp">
        <h1>Fakturaer</h1>
        {aktive.length > 0 && bokfore && (
          <button onClick={hentNa} disabled={henter}>
            {henter ? "Henter …" : "Hent innbetalinger nå"}
          </button>
        )}
      </div>
      <Fakturafaner valgt="innbetalinger" />
      {bank.data && (
        <p className="undertittel">
          {aktive.length ? `Fra ${navnListe(aktive.map((k) => k.bank))}.` : "Banken er ikke koblet til."}{" "}
          {!aktive.length && erAdmin(org?.rolle) && <Link to="/innstillinger?fane=betaling">Koble til under Innstillinger → Faktura</Link>}
        </p>
      )}
      {bank.data && aktive.some((k) => k.kontoer.length > 0) && (
        <Hentetider
          tider={bank.data.hentetider}
          sist={sist}
          oppdater={() => {
            last();
            bank.last();
          }}
        />
      )}
      {bank.data?.koblinger
        .filter((k) => k.siste_feil)
        .map((k) => (
          <div key={k.id} className="melding feil">
            {k.bank}: {k.siste_feil}
            {erAdmin(org?.rolle) && (
              <>
                {" "}
                <Link to="/innstillinger?fane=betaling">Til Innstillinger → Faktura</Link>
              </>
            )}
          </div>
        ))}
      <div className="faner" role="tablist">
        {faner.map(([v, t]) => (
          <button key={v} role="tab" aria-selected={fane === v} className={fane === v ? "valgt" : ""} onClick={() => settSok(v === "se" ? {} : { vis: v }, { replace: true })}>
            {t}
          </button>
        ))}
      </div>
      <Feil melding={h.feil} />
      {!data ? (
        <Laster />
      ) : data.transaksjoner.length === 0 ? (
        <div className="kort">
          <Tom ikon={<IkonKroner />} tittel={fane === "se" ? "Ingenting å se på" : "Ingen innbetalinger her"}>
            <p className="liten">
              {fane === "se" ? "Innbetalinger som ikke kunne kobles til en faktura av seg selv, dukker opp her." : "Innbetalinger fra banken vises her."}
            </p>
          </Tom>
        </div>
      ) : (
        <div className="kort liste innbetalinger">
          {data.transaksjoner.map((t) => (
            <Innbetaling
              key={t.id}
              t={t}
              konto={kontoNavn?.get(t.konto) ?? null}
              bokfore={bokfore}
              opptatt={h.opptatt}
              handling={handling}
              velg={() => settVelg(t)}
              ai={bank.data?.ai && t.valuta === "NOK" ? { spor: () => foreslaMedAi(t.id), sporres: spor === t.id, svar: aiSvar[t.id] ?? null } : null}
            />
          ))}
        </div>
      )}
      <Dialog apen={velg !== null} lukk={() => settVelg(null)} tittel="Velg faktura">
        {velg && (
          <VelgFaktura
            t={velg}
            valgt={async (fakturaId) => {
              settVelg(null);
              await handling(`${velg.id}/koble`, { faktura_id: fakturaId });
            }}
          />
        )}
      </Dialog>
    </>
  );
}

function Innbetaling({
  t,
  konto,
  bokfore,
  opptatt,
  handling,
  velg,
  ai,
}: {
  t: any;
  konto: string | null;
  bokfore: boolean;
  opptatt: boolean;
  handling: (sti: string, kropp?: unknown) => void;
  velg: () => void;
  ai: { spor: () => void; sporres: boolean; svar: string | null } | null; // AI kan foreslå fakturaen
}) {
  const grunn = aiGrunn(t.grunn);
  const faktura = t.faktura_id ? (
    <Link to={`/fakturaer/${t.faktura_id}`}>
      Faktura {t.fakturanummer}
      {t.kunde_navn ? ` · ${t.kunde_navn}` : ""}
    </Link>
  ) : null;
  return (
    <div className={`innbetaling ${t.status}`}>
      <div className="linje">
        <span className="tittel">{t.betaler ?? "Ukjent betaler"}</span>
        <span className="belop">
          {kr(t.belop)}
          {t.valuta !== "NOK" ? ` ${t.valuta}` : ""}
        </span>
      </div>
      <div className="linje under">
        <span>
          {dato(t.dato)}
          {konto ? ` · til ${konto}` : ""}
          {t.melding ? ` · «${t.melding}»` : ""}
          {t.referanse && t.referanse !== t.melding ? ` · ref. ${t.referanse}` : ""}
        </span>
      </div>
      {t.status === "forslag" && (
        <div className="forslag">
          <span>
            {grunn.ai && <AiMerke usikker={grunn.usikker} />} {grunn.usikker ? "Kanskje" : "Trolig"} {faktura}
            {grunn.tekst ? <span className="dempet"> – {grunn.tekst}</span> : null}
          </span>
          {bokfore && (
            <span className="knapper">
              <button className="primar" disabled={opptatt} onClick={() => handling(`${t.id}/koble`, { faktura_id: t.faktura_id })}>
                Bekreft
              </button>
              <button disabled={opptatt} onClick={velg}>
                Annen faktura
              </button>
              <button className="lenke" disabled={opptatt} onClick={() => handling(`${t.id}/angre`)}>
                Ikke denne
              </button>
            </span>
          )}
        </div>
      )}
      {t.status === "uavklart" && (
        <div className="forslag uavklart">
          <span className="dempet">
            {ai?.svar ? (
              <>
                <AiMerke /> {ai.svar}
              </>
            ) : (
              t.grunn ?? "Fant ingen faktura med dette beløpet eller fakturanummeret."
            )}
          </span>
          {bokfore && (
            <span className="knapper">
              <button className="primar" disabled={opptatt} onClick={velg}>
                Velg faktura
              </button>
              {ai && !ai.svar && (
                <button disabled={opptatt} onClick={ai.spor}>
                  {ai.sporres ? <span className="spinner" /> : <IkonGnist storrelse={15} />} {ai.sporres ? "Spør AI …" : "Foreslå med AI"}
                </button>
              )}
              <button disabled={opptatt} onClick={() => handling(`${t.id}/ignorer`, { ignorer: true })}>
                Ikke en faktura
              </button>
            </span>
          )}
        </div>
      )}
      {t.status === "koblet" && (
        <div className="forslag koblet">
          <span>
            <span className="merke merke-ok">Registrert</span> på {faktura}
            <span className="dempet liten">
              {" "}
              · {grunn.ai ? `AI: ${grunn.tekst}` : t.grunn}
              {t.behandlet_av ? ` (${t.behandlet_av})` : " (automatisk)"}
            </span>
          </span>
          {bokfore && (
            <button
              className="lenke"
              disabled={opptatt}
              onClick={() => confirm(`Ta bort betalingen fra faktura ${t.fakturanummer}? Fakturaen blir ubetalt igjen.`) && handling(`${t.id}/angre`)}
            >
              Angre
            </button>
          )}
        </div>
      )}
      {t.status === "ignorert" && (
        <div className="forslag ignorert">
          <span className="dempet">Ikke en fakturabetaling.</span>
          {bokfore && (
            <button className="lenke" disabled={opptatt} onClick={() => handling(`${t.id}/ignorer`, { ignorer: false })}>
              Angre
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// Fakturaene som ikke er betalt: de med samme beløp først.
function VelgFaktura({ t, valgt }: { t: any; valgt: (fakturaId: string) => void }) {
  const { org } = useKonto();
  const { data } = useData(() => hent<any[]>(`/org/${org!.id}/fakturaer?status=utstedt&type=faktura`), [org?.id]);
  const [id, settId] = useState<string | null>(null);
  if (!data) return <Laster />;
  const rest = (f: any) => Math.round((f.sum_inkl_mva - (f.kreditert_belop ?? 0) - (f.betalt_belop ?? 0)) * 100) / 100;
  const sortert = [...data].sort((a, b) => Number(rest(b) === t.belop) - Number(rest(a) === t.belop) || (a.forfallsdato ?? "").localeCompare(b.forfallsdato ?? ""));
  return (
    <>
      <p className="liten">
        {kr(t.belop)} fra {t.betaler ?? "ukjent betaler"} {dato(t.dato)}
        {t.melding ? ` («${t.melding}»)` : ""}. Velg fakturaen betalingen gjelder.
      </p>
      {sortert.length === 0 ? (
        <p className="dempet">Ingen ubetalte fakturaer.</p>
      ) : (
        <Sokefelt
          etikett="Faktura"
          plassholder="Søk på nummer, kunde eller beløp"
          valg={sortert.map((f) => ({
            id: f.id,
            tittel: `${f.fakturanummer} · ${f.kunde_navn}`,
            under: `${kr(rest(f))} gjenstår · forfall ${dato(f.forfallsdato)}${rest(f) === t.belop ? " · samme beløp" : ""}`,
          }))}
          verdi={id}
          velg={(v) => {
            settId(v);
            if (v) valgt(v);
          }}
        />
      )}
    </>
  );
}
