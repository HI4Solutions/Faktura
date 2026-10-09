// Skattekort fra Skatteetaten (server/src/skattekort.ts): koblingen under Innstillinger → Ansatte
// og timer, siden Altinn sender brukeren tilbake til etter godkjenningen, skattekortet på den
// ansatte og oppsettet hos plattformadministratoren.
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api, hent } from "../api";
import { Feil, Laster, useData, useHandling } from "../felles";
import { erAdmin, useKonto } from "../konto";
import { dato, kr } from "../format";
import { naarTekst } from "./Bank";

export type Tilgangsstatus = "venter" | "ny" | "godkjent" | "avslatt" | "avvist" | "utlopt" | "feil";
export type SkattekortStatus = {
  tilgjengelig: boolean;
  miljo: "test" | "prod";
  systemnavn: string;
  aar: number;
  tilgang: null | {
    status: Tilgangsstatus;
    godkjenn_url: string | null;
    opprettet: string;
    oppdatert: string;
    sjekket: string | null;
    sist_hentet: string | null;
    siste_feil: string | null;
    // Tilgangspakkene systembrukeren har, de som mangler, og endringsforespørselen (0077).
    pakkenavn: string[];
    mangler: string[];
    endring_status: Tilgangsstatus | null;
    endring_url: string | null;
    endring_feil: string | null;
  };
  antall: { med_fnr: number; fra_skatteetaten: number; uten_fnr: number };
};
export type Trekk = { trekkode: string; tabell?: number; prosent?: number; frikort?: number | null; maaneder?: number };

export const RESULTAT: Record<string, string> = {
  skattekortopplysningerOK: "Skattekort",
  ikkeSkattekort: "Har ikke skattekort (det trekkes 50 %)",
  ikkeTrekkplikt: "Ikke trekkplikt (ingen trekk)",
  vurderArbeidstillatelse: "Vurder arbeidstillatelsen",
  ugyldigFoedselsEllerDnummer: "Ugyldig fødselsnummer eller D-nummer",
  utgaattDnummerSkattekortForFoedselsnummerErLevert: "D-nummeret er utgått: skattekortet er levert på fødselsnummeret",
  ugyldigOrganisasjonsnummer: "Ugyldig organisasjonsnummer",
};
const TREKKODER: Record<string, string> = {
  LOENN_FRA_HOVEDARBEIDSGIVER: "Lønn fra hovedarbeidsgiver",
  LOENN_FRA_BIARBEIDSGIVER: "Lønn fra biarbeidsgiver",
  LOENN_FRA_NAV: "Lønn fra NAV",
  PENSJON: "Pensjon",
  PENSJON_FRA_NAV: "Pensjon fra NAV",
  UFOERETRYGD_FRA_NAV: "Uføretrygd fra NAV",
  UFOEREYTELSER_FRA_ANDRE: "Uføreytelser fra andre",
  INTRODUKSJONSSTOENAD: "Introduksjonsstønad",
  LOENN_TIL_UTENRIKSTJENESTEMANN: "Lønn til utenrikstjenestemann",
  LOENN_KUN_TRYGDEAVGIFT_TIL_UTENLANDSK_BORGER: "Lønn, bare trygdeavgift (utenlandsk borger)",
  LOENN_KUN_TRYGDEAVGIFT_TIL_UTENLANDSK_BORGER_SOM_GRENSEGJENGER: "Lønn, bare trygdeavgift (grensegjenger)",
};
const TILLEGG: Record<string, string> = {
  oppholdPaaSvalbard: "Bor på Svalbard",
  kildeskattPaaLoenn: "Kildeskatt på lønn (PAYE)",
  kildeskattpensjonist: "Kildeskatt for pensjonist",
  kildeskattPaaPensjon: "Kildeskatt på pensjon",
  oppholdITiltakssone: "Bor i tiltakssonen (Finnmark og Nord-Troms)",
};
const prosent = (n: number) => `${String(n).replace(".", ",")} %`;
export const trekkTekst = (t: Trekk) =>
  t.tabell != null
    ? `Tabell ${t.tabell} (${prosent(t.prosent ?? 0)} i ekstra kjøringer)`
    : "frikort" in t
      ? t.frikort == null
        ? "Frikort uten beløpsgrense"
        : `Frikort ${kr(t.frikort)}`
      : t.prosent != null
        ? `Prosenttrekk ${prosent(t.prosent)}`
        : "–";

// --- Innstillinger → Ansatte og timer ---------------------------------------------------------

export function SkattekortKobling() {
  const { org } = useKonto();
  const s = useData(() => hent<SkattekortStatus>(`/org/${org!.id}/skattekort`), [org?.id]);
  const h = useHandling();
  const [henter, settHenter] = useState<string | null>(null); // sist_hentet da «Hent nå» ble trykket
  const [kopiert, settKopiert] = useState(false);
  const admin = erAdmin(org?.rolle);
  const t = s.data?.tilgang;
  const endres = t?.status === "godkjent" && (t.endring_status === "venter" || t.endring_status === "ny");
  const venter = t?.status === "venter" || t?.status === "ny" || henter !== null || endres;

  // Mens forespørselen lages eller venter på godkjenning, og mens skattekortene hentes: spør igjen.
  const last = useRef(s.last);
  last.current = s.last;
  useEffect(() => {
    if (!venter) return;
    const i = window.setInterval(() => void last.current(), t?.status === "ny" || t?.endring_status === "ny" ? 10_000 : 2500);
    const slutt = window.setTimeout(() => settHenter(null), 150_000);
    return () => {
      window.clearInterval(i);
      window.clearTimeout(slutt);
    };
  }, [venter, t?.status, t?.endring_status]);
  useEffect(() => {
    if (henter !== null && t && (t.sist_hentet ?? "") !== henter) settHenter(null);
    if (henter !== null && t?.siste_feil) settHenter(null);
  }, [henter, t]);

  if (s.feil) return <Feil melding={s.feil} />;
  if (!s.data) return <Laster />;
  if (!s.data.tilgjengelig) return null;
  const d = s.data;

  const ber = async () => {
    const r = await h.kjor(() => api<SkattekortStatus>("POST", `/org/${org!.id}/skattekort/tilgang`));
    if (r) s.settData(r);
  };
  const sjekk = async () => {
    await h.kjor(() => api("POST", `/org/${org!.id}/skattekort/sjekk`));
    window.setTimeout(() => void s.last(), 2500);
  };
  const hentNa = async (aar?: number) => {
    const r = await h.kjor(() => api("POST", `/org/${org!.id}/skattekort/hent`, aar ? { aar } : {}));
    if (r) settHenter(t?.sist_hentet ?? "");
  };
  const utvid = async () => {
    const r = await h.kjor(() => api<SkattekortStatus>("POST", `/org/${org!.id}/skattekort/utvid`));
    if (r) s.settData(r);
  };
  const kobleFra = async () => {
    if (!window.confirm("Koble fra Skatteetaten? Skattekortene som er hentet, blir stående på de ansatte, men hentes ikke lenger.")) return;
    if (await h.kjor(() => api("DELETE", `/org/${org!.id}/skattekort/tilgang`))) void s.last();
  };
  const desember = new Date().getMonth() === 11;

  return (
    <div className="kort skattekort-kobling" id="skattekort">
      <h2>
        Skattekort fra Skatteetaten {d.miljo === "test" && <span className="merke merke-noytral">Testmiljø</span>}
      </h2>
      {!t && (
        <>
          <p className="dempet">
            Hent skattekortene til de ansatte rett fra Skatteetaten. Du gir {d.systemnavn} tilgang i Altinn én gang; deretter hentes skattekortet når en ansatt
            legges inn med fødselsnummer, og endringene hver morgen. Lønnskjøringen bruker dem av seg selv.
          </p>
          <p className="liten dempet">
            Daglig leder, eller en som har tilgangsstyring for {org?.navn} i Altinn, godkjenner tilgangen (tilgangspakken «Lønn»). Du kan sende lenken til dem.
          </p>
          {admin && (
            <div className="knapper">
              <button type="button" className="primar" onClick={ber} disabled={h.opptatt}>
                Koble til Skatteetaten
              </button>
            </div>
          )}
        </>
      )}
      {t?.status === "venter" && (
        <p role="status">
          <span className="spinner" /> Lager forespørselen i Altinn …
        </p>
      )}
      {t?.status === "ny" && (
        <>
          <p>
            Forespørselen venter på godkjenning i Altinn. Daglig leder, eller en som har tilgangsstyring for {org?.navn} i Altinn, logger inn og godkjenner
            den. Du kan sende lenken til dem.
          </p>
          {t.siste_feil && <p className="liten fare-tekst">{t.siste_feil}</p>}
          <div className="knapper">
            {t.godkjenn_url && (
              <a className="knapp primar" href={t.godkjenn_url}>
                Godkjenn i Altinn
              </a>
            )}
            {t.godkjenn_url && (
              <button
                type="button"
                onClick={async () => {
                  await navigator.clipboard?.writeText(t.godkjenn_url!).catch(() => undefined);
                  settKopiert(true);
                }}
              >
                {kopiert ? "Lenken er kopiert" : "Kopier lenken"}
              </button>
            )}
            <button type="button" onClick={sjekk} disabled={h.opptatt}>
              Jeg har godkjent
            </button>
          </div>
          <p className="liten dempet">Appen ser etter godkjenningen av seg selv også.</p>
        </>
      )}
      {t && ["avslatt", "avvist", "utlopt", "feil"].includes(t.status) && (
        <>
          <p className="fare-tekst">
            {t.status === "avslatt"
              ? "Forespørselen ble avslått i Altinn."
              : t.status === "avvist"
                ? "Forespørselen ble avvist i Altinn."
                : t.status === "utlopt"
                  ? "Forespørselen gikk ut før den ble godkjent."
                  : "Tilgangen virker ikke."}
            {t.siste_feil && <span className="liten"> {t.siste_feil}</span>}
          </p>
          {admin && (
            <div className="knapper">
              <button type="button" className="primar" onClick={ber} disabled={h.opptatt}>
                Be om tilgang på nytt
              </button>
              <button type="button" onClick={kobleFra} disabled={h.opptatt}>
                Fjern
              </button>
            </div>
          )}
        </>
      )}
      {t?.status === "godkjent" && (
        <>
          <p>
            <span className="merke merke-ok">Koblet til</span> Skattekortene hentes når en ansatt legges inn med fødselsnummer, og endringene hver morgen.
          </p>
          <div className="admin-tellinger">
            <span>
              <strong>{d.antall.fra_skatteetaten}</strong> av {d.antall.med_fnr} ansatte med fødselsnummer har skattekortet for {d.aar} fra Skatteetaten
            </span>
            {d.antall.uten_fnr > 0 && (
              <span className="advarsel-tekst">
                <strong>{d.antall.uten_fnr}</strong> {d.antall.uten_fnr === 1 ? "ansatt mangler" : "ansatte mangler"} fødselsnummer
              </span>
            )}
          </div>
          <p className="liten dempet">
            {henter !== null ? (
              <>
                <span className="spinner" /> Henter skattekortene …
              </>
            ) : t.sist_hentet ? (
              `Sist hentet ${naarTekst(t.sist_hentet)}.`
            ) : (
              "Ikke hentet ennå."
            )}
          </p>
          {t.siste_feil && <p className="liten fare-tekst">Siste henting feilet: {t.siste_feil}</p>}
          <p className="liten dempet">Tilgangspakker i Altinn: {t.pakkenavn.join(", ")}.</p>
          {(t.mangler.length > 0 || endres) && (
            <div className="melding info">
              {t.endring_status === "venter" ? (
                <>
                  <span className="spinner" /> Lager endringsforespørselen i Altinn …
                </>
              ) : t.endring_status === "ny" ? (
                <>
                  Endringen venter på godkjenning i Altinn (tilgangspakken {t.mangler.map((m) => `«${m}»`).join(" og ")}).{" "}
                  {t.endring_url && (
                    <a className="lenke" href={t.endring_url}>
                      Godkjenn i Altinn
                    </a>
                  )}
                </>
              ) : (
                <>
                  {d.systemnavn} trenger også tilgangspakken {t.mangler.map((m) => `«${m}»`).join(" og ")} (for a-meldingen). Daglig leder godkjenner det i Altinn.
                  {t.endring_feil && <span className="fare-tekst"> {t.endring_feil}</span>}
                  {admin && (
                    <div className="knapper">
                      <button type="button" className="primar" onClick={utvid} disabled={h.opptatt}>
                        Utvid tilgangen i Altinn
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>
          )}
          {admin && (
            <div className="knapper">
              <button type="button" onClick={() => hentNa()} disabled={h.opptatt || henter !== null}>
                Hent skattekortene nå
              </button>
              {desember && (
                <button type="button" onClick={() => hentNa(d.aar + 1)} disabled={h.opptatt || henter !== null}>
                  Hent for {d.aar + 1}
                </button>
              )}
              <button type="button" className="lenke" onClick={kobleFra} disabled={h.opptatt}>
                Koble fra
              </button>
            </div>
          )}
          <p className="liten dempet">
            Kobler du fra, kan dere også fjerne systemtilgangen for {d.systemnavn} i Altinn (Tilgangsstyring → Systemtilganger).
          </p>
        </>
      )}
      <Feil melding={h.feil} />
    </div>
  );
}

// --- Tilbake fra Altinn --------------------------------------------------------------------------

export function SkattekortGodkjent() {
  const { org } = useKonto();
  const [status, settStatus] = useState<Tilgangsstatus | "sjekker" | null>("sjekker");
  const [feil, settFeil] = useState<string | null>(null);
  useEffect(() => {
    if (!org) return;
    let stopp = false;
    (async () => {
      try {
        await api("POST", `/org/${org.id}/skattekort/sjekk`);
        for (let i = 0; i < 20 && !stopp; i++) {
          await new Promise((ok) => setTimeout(ok, 2000));
          const s = await hent<SkattekortStatus>(`/org/${org.id}/skattekort`);
          const st = s.tilgang?.status ?? null;
          if (st !== "ny" && st !== "venter") return void (!stopp && settStatus(st));
          if (i === 9) await api("POST", `/org/${org.id}/skattekort/sjekk`);
        }
        if (!stopp) settStatus("ny");
      } catch (e) {
        if (!stopp) settFeil((e as Error).message);
      }
    })();
    return () => {
      stopp = true;
    };
  }, [org?.id]);

  return (
    <div className="kort" style={{ maxWidth: 560 }}>
      <h1>Skattekort fra Skatteetaten</h1>
      {status === "sjekker" && !feil && (
        <p role="status">
          <span className="spinner" /> Sjekker godkjenningen i Altinn for {org?.navn} …
        </p>
      )}
      {status === "godkjent" && <p className="ok-tekst">Tilgangen er godkjent. Skattekortene til de ansatte hentes nå.</p>}
      {status === "ny" && <p>Altinn har ikke registrert godkjenningen ennå. Appen ser etter den av seg selv, så du kan gå videre.</p>}
      {status && ["avslatt", "avvist", "utlopt", "feil"].includes(status) && <p className="fare-tekst">Tilgangen ble ikke godkjent. Du kan be om den på nytt under Innstillinger.</p>}
      {status === null && <p>{org?.navn} har ikke bedt om tilgang til Skatteetaten. Velg organisasjonen øverst og prøv igjen, eller gå til Innstillinger.</p>}
      <Feil melding={feil} />
      <div className="knapper">
        <Link className="knapp primar" to="/innstillinger?fane=skattekort">
          Til innstillingene
        </Link>
      </div>
    </div>
  );
}

// --- På den ansatte ------------------------------------------------------------------------------

export function SkattekortFraSkatteetaten({ a }: { a: { skattekort_kilde: string | null; skattekort_hentet: string | null; skattekort_resultat: string | null; skattekort_utstedt: string | null; skattekort_tillegg: string[] | null; skattekort_trekk: Trekk[] | null } }) {
  if (!a.skattekort_hentet) return null;
  const tillegg = (a.skattekort_tillegg ?? []).map((x) => TILLEGG[x] ?? x);
  return (
    <div className="skattekort-fra-skatteetaten">
      <p className="liten">
        <span className={`merke ${a.skattekort_kilde === "skatteetaten" ? "merke-ok" : "merke-noytral"}`}>
          {a.skattekort_kilde === "skatteetaten" ? "Fra Skatteetaten" : "Endret for hånd"}
        </span>{" "}
        Hentet {naarTekst(a.skattekort_hentet)}
        {a.skattekort_utstedt ? `, utstedt ${dato(a.skattekort_utstedt)}` : ""}.{" "}
        {a.skattekort_resultat && a.skattekort_resultat !== "skattekortopplysningerOK" && (
          <strong className={a.skattekort_resultat.startsWith("ugyldig") || a.skattekort_resultat === "vurderArbeidstillatelse" ? "fare-tekst" : undefined}>
            {RESULTAT[a.skattekort_resultat] ?? a.skattekort_resultat}.
          </strong>
        )}
      </p>
      {!!a.skattekort_trekk?.length && (
        <ul className="skattekort-trekk liten">
          {a.skattekort_trekk.map((t, i) => (
            <li key={i}>
              <span className="dempet">{TREKKODER[t.trekkode] ?? t.trekkode}:</span> {trekkTekst(t)}
            </li>
          ))}
        </ul>
      )}
      {tillegg.length > 0 && <p className="liten">Tilleggsopplysninger: {tillegg.join(", ")}.</p>}
      {a.skattekort_kilde !== "skatteetaten" && <p className="liten dempet">Neste henting fra Skatteetaten erstatter endringen.</p>}
    </div>
  );
}

// --- Admin → Drift ------------------------------------------------------------------------------

type AdminSkattekort = {
  oppsett: {
    miljo: string;
    klient_id: boolean;
    nokkel_id: boolean;
    leverandor_orgnr: string;
    system_id: string;
    systemnavn: string;
    tilgangspakke: string;
    // Tilgangspakkene systemet ber om, og om a-meldingen sendes til API-et (AMELDING_INNSENDING).
    tilgangspakker: string[];
    amelding: boolean;
    tilbake_url: string;
  };
  system: { id: string; registrert: string | null; oppdatert: string; siste_feil: string | null } | null;
  organisasjoner: { status: Tilgangsstatus; antall: number }[];
};
const STATUSNAVN: Record<Tilgangsstatus, string> = {
  venter: "venter på forespørsel",
  ny: "venter på godkjenning",
  godkjent: "godkjent",
  avslatt: "avslått",
  avvist: "avvist",
  utlopt: "utløpt",
  feil: "med feil",
};

export function SkattekortOppsett() {
  const { data, feil, last } = useData(() => hent<AdminSkattekort>("/admin/skattekort"), []);
  const h = useHandling();
  const [startet, settStartet] = useState(false);
  useEffect(() => {
    if (!startet) return;
    const t = window.setTimeout(() => {
      void last();
      settStartet(false);
    }, 4000);
    return () => window.clearTimeout(t);
  }, [startet, last]);
  if (feil) return <Feil melding={feil} />;
  if (!data) return <Laster />;
  const o = data.oppsett;
  const sattOpp = o.klient_id && o.nokkel_id;
  return (
    <section className="kort">
      <h2>Skattekort (Skatteetaten)</h2>
      <p className="dempet liten" style={{ marginTop: 0 }}>
        {o.miljo === "prod" ? "Produksjon" : "Testmiljø (TT02)"} · leverandør {o.leverandor_orgnr} · system {o.system_id} («{o.systemnavn}»)
      </p>
      {!sattOpp ? (
        <p className="advarsel-tekst">
          Ikke satt opp: {!o.klient_id && "klient-ID-en til Maskinporten (MASKINPORTEN_KLIENT_ID)"}
          {!o.klient_id && !o.nokkel_id && " og "}
          {!o.nokkel_id && "nøkkel-ID-en (MASKINPORTEN_NOKKEL_ID)"} mangler. Se docs/skattekort.md.
        </p>
      ) : (
        <>
          <p className={data.system?.siste_feil ? "fare-tekst" : data.system?.registrert ? "ok-tekst" : undefined}>
            {data.system?.siste_feil
              ? data.system.siste_feil
              : data.system?.registrert
                ? `Registrert i Altinns systemregister (sist oppdatert ${naarTekst(data.system.registrert)}).`
                : "Systemet er ikke registrert i Altinn ennå."}
          </p>
          <p className="liten dempet">
            Tilgangspakker: {o.tilgangspakker.join(", ")}. Tilbake til {o.tilbake_url}. Registreringen oppdaterer også navnet, klient-ID-en og tilgangspakkene.
          </p>
          <p className="liten dempet">
            A-meldingen:{" "}
            {o.amelding
              ? "sendes til Skatteetatens API (AMELDING_INNSENDING er på). Kundene som har koblet til, utvider tilgangen i Altinn fra innstillingene."
              : "som fil til opplasting på skatteetaten.no. Innsending fra appen slås på med AMELDING_INNSENDING (se docs/amelding.md)."}
          </p>
          <div className="knapper">
            <button
              type="button"
              disabled={h.opptatt || startet}
              onClick={async () => {
                if (await h.kjor(() => api("POST", "/admin/skattekort/system", {}))) settStartet(true);
              }}
            >
              {startet ? "Registrerer …" : data.system?.registrert ? "Oppdater i Altinn" : "Registrer systemet i Altinn"}
            </button>
          </div>
        </>
      )}
      {data.organisasjoner.length > 0 && (
        <div className="admin-tellinger">
          {data.organisasjoner.map((x) => (
            <span key={x.status} className={x.status === "feil" ? "fare-tekst" : undefined}>
              <strong>{x.antall}</strong> {STATUSNAVN[x.status] ?? x.status}
            </span>
          ))}
        </div>
      )}
      <Feil melding={h.feil} />
    </section>
  );
}
