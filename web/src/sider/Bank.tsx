// Innbetalinger fra banken (open banking gjennom Enable Banking): kobling under
// Innstillinger → Betaling, siden der brukeren kommer tilbake etter BankID, og listen
// over innbetalinger som kobles til fakturaene.
import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { api, hent } from "../api";
import { Dialog, Feil, Laster, Tom, useData, useHandling } from "../felles";
import { dato, kr } from "../format";
import { erAdmin, kanBokfore, useKonto } from "../konto";
import { Sokefelt } from "../sokefelt";
import { IkonKroner } from "../ikoner";

export interface BankStatus {
  tilkoblet: boolean;
  status: "aktiv" | "feil" | null;
  venter_bankid: boolean;
  app_id: string | null;
  app_navn: string | null;
  bank: string | null;
  psu_type: "business" | "personal" | null;
  kontoer: { uid: string; kontonr: string; navn: string | null; valgt: boolean }[];
  gyldig_til: string | null;
  sist_hentet: string | null;
  siste_feil: string | null;
  auth_url: string | null;
  auth_tid: string | null;
  tilbake_url: string;
  antall: { forslag: number; uavklart: number; koblet: number; ignorert: number };
}

const BANKER = ["DNB", "Nordea", "Handelsbanken", "Danske Bank", "SpareBank 1 SR-Bank", "SpareBank 1 SMN", "SpareBank 1 Østlandet", "SpareBank 1 Nord-Norge"];
const pause = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
const kontonrTekst = (k: string) => k.replace(/^(\d{4})(\d{2})(\d{5})$/, "$1.$2.$3");
const tid = (iso: string | null) => (iso ? new Date(iso).toLocaleString("nb-NO", { dateStyle: "short", timeStyle: "short" }) : "");
const dagerTil = (iso: string | null) => (iso ? Math.ceil((Date.parse(iso) - Date.now()) / 86_400_000) : null);

// Ny BankID-adresse fra workeren (fornyelse): spør til den er klar.
async function nyBankIdAdresse(orgId: string): Promise<string> {
  await api("POST", `/org/${orgId}/bank/forny`);
  for (let i = 0; i < 40; i++) {
    await pause(1000);
    const s = await hent<BankStatus>(`/org/${orgId}/bank`);
    if (s.auth_url) return s.auth_url;
    if (s.auth_tid && s.siste_feil) throw new Error(s.siste_feil);
  }
  throw new Error("Banken svarte ikke. Prøv igjen om litt.");
}

// Venter til en henting er ferdig (sist_hentet endres), høyst et halvt minutt.
async function ventPaHenting(orgId: string, forrige: string | null) {
  for (let i = 0; i < 30; i++) {
    await pause(1000);
    const s = await hent<BankStatus>(`/org/${orgId}/bank`);
    if (s.sist_hentet !== forrige || s.siste_feil) return s;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Innstillinger → Betaling
// ---------------------------------------------------------------------------

export function BankKobling() {
  const { org, meg } = useKonto();
  const [sok] = useSearchParams();
  const { data, settData, last } = useData(() => hent<BankStatus>(`/org/${org!.id}/bank`), [org?.id]);
  const [skjema, settSkjema] = useState<{ app_id: string; privat_nokkel: string; filnavn: string | null; bank: string; psu_type: "business" | "personal" } | null>(null);
  const [venter, settVenter] = useState<string | null>(null);
  const h = useHandling();
  const nyttOk = sok.get("bank") === "ok";

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

  async function forny() {
    settVenter("Gjør klar BankID …");
    const url = await h.kjor(() => nyBankIdAdresse(org!.id));
    if (url) window.location.assign(url);
    else settVenter(null);
  }

  async function hentNa() {
    settVenter("Henter innbetalinger …");
    await h.kjor(async () => {
      await api("POST", `/org/${org!.id}/bank/hent`);
      const s = await ventPaHenting(org!.id, data?.sist_hentet ?? null);
      if (s) settData(s);
    });
    settVenter(null);
  }

  async function velgKonto(uid: string, valgt: boolean) {
    const valgte = data!.kontoer.filter((k) => (k.uid === uid ? valgt : k.valgt)).map((k) => k.uid);
    const r = await h.kjor(() => api<BankStatus>("PUT", `/org/${org!.id}/bank/kontoer`, { valgte }));
    if (r) settData(r);
  }

  async function kobleFra() {
    if (!confirm("Koble fra banken? Innbetalinger hentes ikke lenger. De som allerede er hentet og registrert, blir stående.")) return;
    if (await h.kjor(async () => (await api("DELETE", `/org/${org!.id}/bank`), true))) last();
  }

  if (!data) return null;
  const igjen = dagerTil(data.gyldig_til);
  const venterAntall = data.antall.forslag + data.antall.uavklart;

  return (
    <div className="kort">
      <h2 style={{ marginTop: 0 }}>Innbetalinger fra banken</h2>
      <p className="dempet liten">
        Appen leser innbetalingene på bedriftskontoen og registrerer betalinger på fakturaene av seg selv, uten KID-avtale med banken. Står
        fakturanummeret i meldingen, eller stemmer beløpet med det kunden skylder, kobles betalingen til fakturaen. Det du må se over, får du
        under Innbetalinger. Appen kan bare lese kontoen, ikke flytte penger.
      </p>
      {nyttOk && data.tilkoblet && <div className="melding ok">Banken er koblet til. Innbetalingene hentes nå.</div>}
      {venter && <div className="melding info">{venter}</div>}

      {data.tilkoblet || data.status === "feil" || data.venter_bankid ? (
        <div className="bank-status">
          <p>
            {data.tilkoblet ? (
              <span className="merke merke-ok">Tilkoblet</span>
            ) : data.venter_bankid ? (
              <span className="merke merke-advarsel">BankID ikke fullført</span>
            ) : (
              <span className="merke merke-fare">Må kobles til på nytt</span>
            )}{" "}
            <strong>{data.bank}</strong> · {data.psu_type === "personal" ? "privatkonto" : "bedriftskonto"}
            {data.app_navn && <span className="dempet liten"> · applikasjon «{data.app_navn}»</span>}
          </p>
          {data.siste_feil && <div className="melding feil">{data.siste_feil}</div>}
          {data.tilkoblet && (
            <>
              <p className={`liten ${igjen !== null && igjen < 14 ? "advarsel-tekst" : "dempet"}`}>
                Lesetilgang til {dato(data.gyldig_til)}
                {igjen !== null && igjen < 14 ? ` (${igjen <= 0 ? "går ut i dag" : `${igjen} dager igjen`}). Forny med BankID.` : "."}
                {data.sist_hentet && ` Sist hentet ${tid(data.sist_hentet)}.`}
              </p>
              {data.kontoer.length > 0 && (
                <div className="valgliste">
                  {data.kontoer.map((k) => (
                    <label key={k.uid}>
                      <input type="checkbox" checked={k.valgt} disabled={h.opptatt || !erAdmin(org?.rolle)} onChange={(e) => velgKonto(k.uid, e.target.checked)} />
                      {k.navn ?? "Konto"} <span className="dempet">{kontonrTekst(k.kontonr)}</span>
                    </label>
                  ))}
                </div>
              )}
              {venterAntall > 0 && (
                <p className="liten">
                  <Link to="/innbetalinger">
                    {venterAntall} {venterAntall === 1 ? "innbetaling venter" : "innbetalinger venter"} på deg
                  </Link>
                </p>
              )}
            </>
          )}
          <Feil melding={h.feil} />
          <div className="knapper">
            {data.tilkoblet && (
              <button type="button" className="primar" disabled={h.opptatt} onClick={hentNa}>
                Hent nå
              </button>
            )}
            {erAdmin(org?.rolle) && (
              <button type="button" className={data.tilkoblet ? undefined : "primar"} disabled={h.opptatt} onClick={forny}>
                {data.venter_bankid ? "Fortsett med BankID" : data.tilkoblet ? "Forny tilgang" : "Koble til på nytt"}
              </button>
            )}
            {erAdmin(org?.rolle) && (
              <button type="button" className="fare" disabled={h.opptatt} onClick={kobleFra}>
                Koble fra
              </button>
            )}
          </div>
        </div>
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
              Velg <strong>Activate by linking accounts</strong> og koble til bedriftskontoen med BankID. Da kan applikasjonen bare lese kontoene
              du selv har koblet til, og den koster ingenting.
            </li>
            <li>Last opp .pem-filen her og lim inn applikasjonens ID (Application ID). Så logger du inn i banken med BankID en gang til.</li>
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
                {skjema.filnavn ? `Valgt: ${skjema.filnavn}. ` : ""}Nøkkelen lagres kryptert, vises ikke igjen og brukes bare til å lese kontoen.{" "}
                {!skjema.filnavn && skjema.privat_nokkel === "" && (
                  <button type="button" className="lenke" onClick={() => settSkjema({ ...skjema, privat_nokkel: " " })}>
                    Lim inn nøkkelen i stedet
                  </button>
                )}
              </p>
              {!skjema.filnavn && skjema.privat_nokkel !== "" && (
                <textarea
                  aria-label="Privat nøkkel (innholdet i .pem-filen)"
                  rows={5}
                  spellCheck={false}
                  autoCapitalize="off"
                  style={{ marginBottom: 14 }}
                  placeholder={"-----BEGIN PRIVATE KEY-----\n…\n-----END PRIVATE KEY-----"}
                  value={skjema.privat_nokkel.trim()}
                  onChange={(e) => settSkjema({ ...skjema, privat_nokkel: e.target.value || " " })}
                />
              )}
            </div>
            <label className="hel">
              Applikasjons-ID (Application ID)
              <input required autoComplete="off" autoCapitalize="off" spellCheck={false} value={skjema.app_id} onChange={(e) => settSkjema({ ...skjema, app_id: e.target.value.trim() })} />
            </label>
            <label>
              Bank
              <input required list="banker" value={skjema.bank} onChange={(e) => settSkjema({ ...skjema, bank: e.target.value })} />
              <datalist id="banker">
                {BANKER.map((b) => (
                  <option key={b} value={b} />
                ))}
              </datalist>
            </label>
            <label>
              Konto
              <select value={skjema.psu_type} onChange={(e) => settSkjema({ ...skjema, psu_type: e.target.value as "business" | "personal" })}>
                <option value="business">Bedriftskonto</option>
                <option value="personal">Privatkonto (enkeltpersonforetak)</option>
              </select>
            </label>
          </div>
          {!meg?.mfa && <div className="melding info">Du må være logget inn med passkey eller kode fra autentiseringsappen for å koble til.</div>}
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
          {erAdmin(org?.rolle) && (
            <div className="knapper">
              <button type="button" className="primar" onClick={() => settSkjema({ app_id: "", privat_nokkel: "", filnavn: null, bank: "DNB", psu_type: "business" })}>
                Koble til banken
              </button>
            </div>
          )}
        </>
      )}
    </div>
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
        await api("POST", `/org/${orgId}/bank/fullfor`, { code: kode, state });
        for (let i = 0; i < 45; i++) {
          await pause(1000);
          const s = await hent<BankStatus>(`/org/${orgId}/bank`);
          if (s.tilkoblet) return nav("/innstillinger?fane=betaling&bank=ok", { replace: true });
          if (s.siste_feil) throw new Error(s.siste_feil);
        }
        throw new Error("Banken svarte ikke i tide. Se statusen under Innstillinger → Betaling.");
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
            Til Innstillinger → Betaling
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
  const bank = useData(() => hent<BankStatus>(`/org/${org!.id}/bank`), [org?.id]);
  const { data, last } = useData(() => hent<{ transaksjoner: any[]; antall: BankStatus["antall"] }>(`/org/${org!.id}/banktransaksjoner?status=${fane}`), [org?.id, fane]);
  const h = useHandling();
  const [velg, settVelg] = useState<any | null>(null);
  const [henter, settHenter] = useState(false);
  const bokfore = kanBokfore(org?.rolle);

  const handling = async (sti: string, kropp?: unknown) => {
    if (await h.kjor(() => api("POST", `/org/${org!.id}/banktransaksjoner/${sti}`, kropp ?? {}))) {
      last();
      bank.last();
    }
  };

  async function hentNa() {
    settHenter(true);
    await h.kjor(async () => {
      await api("POST", `/org/${org!.id}/bank/hent`);
      await ventPaHenting(org!.id, bank.data?.sist_hentet ?? null);
    });
    settHenter(false);
    last();
    bank.last();
  }

  const antall = data?.antall ?? bank.data?.antall;
  const faner: [Fane, string][] = [
    ["se", `Å se på${antall && antall.forslag + antall.uavklart ? ` (${antall.forslag + antall.uavklart})` : ""}`],
    ["koblet", "Registrert"],
    ["ignorert", "Ignorert"],
    ["alle", "Alle"],
  ];

  return (
    <>
      <div className="topp">
        <h1>Innbetalinger</h1>
        {bank.data?.tilkoblet && bokfore && (
          <button onClick={hentNa} disabled={henter}>
            {henter ? "Henter …" : "Hent nå"}
          </button>
        )}
      </div>
      {bank.data && (
        <p className="undertittel">
          {bank.data.tilkoblet
            ? `Fra ${bank.data.bank}${bank.data.sist_hentet ? ` · sist hentet ${tid(bank.data.sist_hentet)}` : ""}. Hentes automatisk noen ganger om dagen.`
            : "Banken er ikke koblet til."}{" "}
          {!bank.data.tilkoblet && erAdmin(org?.rolle) && <Link to="/innstillinger?fane=betaling">Koble til under Innstillinger → Betaling</Link>}
        </p>
      )}
      {bank.data?.siste_feil && <div className="melding feil">{bank.data.siste_feil}</div>}
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
            <Innbetaling key={t.id} t={t} bokfore={bokfore} opptatt={h.opptatt} handling={handling} velg={() => settVelg(t)} />
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

function Innbetaling({ t, bokfore, opptatt, handling, velg }: { t: any; bokfore: boolean; opptatt: boolean; handling: (sti: string, kropp?: unknown) => void; velg: () => void }) {
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
          {t.melding ? ` · «${t.melding}»` : ""}
          {t.referanse && t.referanse !== t.melding ? ` · ref. ${t.referanse}` : ""}
        </span>
      </div>
      {t.status === "forslag" && (
        <div className="forslag">
          <span>
            Trolig {faktura}
            {t.grunn ? <span className="dempet"> – {t.grunn}</span> : null}
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
          <span className="dempet">{t.grunn ?? "Fant ingen faktura med dette beløpet eller fakturanummeret."}</span>
          {bokfore && (
            <span className="knapper">
              <button className="primar" disabled={opptatt} onClick={velg}>
                Velg faktura
              </button>
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
              · {t.grunn}
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
