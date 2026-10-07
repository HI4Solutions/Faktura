// Påminnelser om å lage fakturaer: et varsel på datoen du velger (hver måned, kvartal, år,
// uke eller én gang), for fakturaer du må lage selv, for eksempel når beløpet varierer fra
// gang til gang og en gjentakende faktura ikke passer. Varselet åpner en kort side der kunden
// og produktene er fylt inn: skriv inn beløpet og send fakturaen derfra.
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api, hent } from "../api";
import { Dialog, Feil, Laster, tall, useData, useHandling, useSmal } from "../felles";
import { dato, iDag, kr, leggTilDager, summer } from "../format";
import { gebyrLinjer } from "../linjer";
import { kanSkrive, useKonto } from "../konto";
import { kundeValg, produktValg, Sokefelt } from "../sokefelt";
import { hentAbonnement, pushStotte, slaPaVarsler } from "../pwa";
import { IkonBjelle, IkonLukk } from "../ikoner";

type Intervall = "maaned" | "kvartal" | "aar" | "uke" | "en_gang";
export type Paaminnelse = {
  id: string;
  tekst: string;
  kunde_id: string | null;
  kunde_navn: string | null;
  produkter: string[];
  produktliste: { id: string; navn: string; fast_pris: boolean; aktiv: boolean }[];
  intervall: Intervall;
  dag: number;
  neste_dato: string;
  klokkeslett: string;
  hvem: "meg" | "alle";
  epost: boolean;
  aktiv: boolean;
  sist_varslet: string | null;
  opprettet_av_navn: string | null;
  min: boolean;
};

const INTERVALLER: [Intervall, string][] = [
  ["maaned", "Hver måned"],
  ["kvartal", "Hvert kvartal"],
  ["aar", "Hvert år"],
  ["uke", "Hver uke"],
  ["en_gang", "Bare én gang"],
];

const ukedag = (iso: string) => new Intl.DateTimeFormat("nb-NO", { weekday: "long", timeZone: "UTC" }).format(new Date(`${iso}T12:00:00Z`));
const dagOgMaaned = (iso: string) => new Intl.DateTimeFormat("nb-NO", { day: "numeric", month: "long", timeZone: "UTC" }).format(new Date(`${iso}T12:00:00Z`));
const langDato = (iso: string) => `${ukedag(iso)} ${dagOgMaaned(iso)}`;

// «Den 1. hver måned kl. 08:00», «Hver mandag kl. 08:00» …
export function naar(p: { intervall: Intervall; dag: number; neste_dato: string; klokkeslett: string }): string {
  const kl = `kl. ${p.klokkeslett}`;
  const dag = p.dag >= 31 ? "siste dag" : `den ${p.dag}.`;
  if (p.intervall === "maaned") return `${dag[0].toUpperCase()}${dag.slice(1)} hver måned ${kl}`;
  if (p.intervall === "kvartal") return `${dag[0].toUpperCase()}${dag.slice(1)} hvert kvartal ${kl}`;
  if (p.intervall === "aar") return `Hvert år ${dagOgMaaned(p.neste_dato)} ${kl}`;
  if (p.intervall === "uke") return `Hver ${ukedag(p.neste_dato)} ${kl}`;
  return `${dato(p.neste_dato)} ${kl}`;
}

// Den første i neste måned: det vanlige for fakturaer som lages hver måned.
const forsteNesteMaaned = () => {
  const [a, m] = iDag().split("-").map(Number);
  return m === 12 ? `${a + 1}-01-01` : `${a}-${String(m + 1).padStart(2, "0")}-01`;
};

// Får brukeren varsler på denne enheten? Hvis ikke: en kort forklaring og en knapp.
function Varselstatus() {
  const push = useData(() => hent<{ nokkel: string | null; abonnementer: { endpoint: string }[] }>("/push"), []);
  const [denne, settDenne] = useState<string | null | undefined>(undefined);
  const h = useHandling();
  const stotte = pushStotte();
  useEffect(() => {
    hentAbonnement().then((s) => settDenne(s?.endpoint ?? null), () => settDenne(null));
  }, []);
  if (!push.data || denne === undefined) return null;
  const paDenne = Boolean(denne && push.data.abonnementer.some((a) => a.endpoint === denne));
  if (paDenne) return null;
  const andre = push.data.abonnementer.length;
  return (
    <div className="melding info paaminnelse-varsel">
      {stotte === "installer" ? (
        <>På iPhone og iPad må appen legges til på Hjem-skjermen for å få varsler (Del → «Legg til på Hjem-skjerm»). Åpne den derfra og slå på varsler.</>
      ) : stotte === "nei" || !push.data.nokkel ? (
        <>Denne nettleseren kan ikke få push-varsler. {andre ? "Påminnelsene kommer på de andre enhetene dine" : "Kryss av for e-post på påminnelsene"}.</>
      ) : (
        <>
          <span>
            Denne enheten får ikke varsler ennå{andre ? ` (påminnelsene kommer på ${andre === 1 ? "én annen enhet" : `${andre} andre enheter`})` : ""}.
          </span>
          <button
            type="button"
            disabled={h.opptatt}
            onClick={() =>
              h
                .kjor(async () => {
                  const s = await slaPaVarsler(push.data!.nokkel!);
                  settDenne(s.endpoint);
                  return true;
                })
                .then(() => push.last())
            }
          >
            <IkonBjelle storrelse={16} /> Slå på varsler
          </button>
        </>
      )}
      <Feil melding={h.feil} />
    </div>
  );
}

export function Paaminnelser({ faner }: { faner: ReactNode }) {
  const { org } = useKonto();
  const nav = useNavigate();
  const smal = useSmal();
  const [sok, settSok] = useSearchParams();
  const { data, feil, last } = useData(() => hent<Paaminnelse[]>(`/org/${org!.id}/paaminnelser`), [org?.id]);
  const [redigerer, settRedigerer] = useState<Partial<Paaminnelse> | null>(null);
  const skriv = kanSkrive(org?.rolle);

  // Fra et produkt (?produkt=…) eller en kunde (?kunde=…): ny påminnelse med dem fylt inn.
  useEffect(() => {
    const produkter = sok.getAll("produkt");
    const kunde = sok.get("kunde");
    if (!skriv || (!produkter.length && !kunde)) return;
    settRedigerer({ produkter, kunde_id: kunde });
    settSok({ fane: "paaminnelser" }, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const lagFaktura = (p: Paaminnelse) => nav(`/paaminnelser/${p.id}`);
  const hva = (p: Paaminnelse) =>
    [p.kunde_navn, p.produktliste.map((x) => x.navn).join(", ")].filter(Boolean).join(" · ") || "Ingen kunde eller produkt valgt";
  const hvem = (p: Paaminnelse) =>
    `${p.hvem === "alle" ? "Alle som fakturerer" : p.min ? "Bare deg" : `Bare ${p.opprettet_av_navn ?? "den som lagde den"}`}${p.epost ? " · også e-post" : ""}`;
  const merke = (p: Paaminnelse) => <span className={`merke ${p.aktiv ? "merke-ok" : "merke-noytral"}`}>{p.aktiv ? "Aktiv" : "Stoppet"}</span>;

  return (
    <>
      <div className="topp">
        <h1>Gjentakende</h1>
        {skriv && (
          <button className="primar" onClick={() => settRedigerer({})}>
            Ny påminnelse
          </button>
        )}
      </div>
      {faner}
      <p className="dempet">
        Få et varsel på datoen du velger om fakturaer du lager selv, for eksempel når beløpet varierer fra måned til måned. Trykk på varselet, skriv
        inn beløpet og send fakturaen med en gang: kunden og produktene er fylt inn.
      </p>
      <Varselstatus />
      {feil ? (
        <Feil melding={feil} />
      ) : !data ? (
        <Laster />
      ) : smal ? (
        <div className="kort liste">
          {data.map((p) => (
            <div
              key={p.id}
              className="liste-rad"
              role="button"
              tabIndex={0}
              onClick={() => skriv && settRedigerer(p)}
              onKeyDown={(e) => e.key === "Enter" && skriv && settRedigerer(p)}
            >
              <span className="linje">
                <span className="tittel">{p.tekst}</span>
                {merke(p)}
              </span>
              <span className="linje">
                <span className="under">{hva(p)}</span>
              </span>
              <span className="linje">
                <span className="under">{p.aktiv ? `${naar(p)} · neste ${dato(p.neste_dato)}` : naar(p)}</span>
              </span>
              <span className="linje">
                <span className="under">{hvem(p)}</span>
                <button
                  className="lenke"
                  onClick={(e) => {
                    e.stopPropagation();
                    lagFaktura(p);
                  }}
                >
                  Send faktura nå
                </button>
              </span>
            </div>
          ))}
          {data.length === 0 && <p className="dempet" style={{ padding: 16 }}>Ingen påminnelser ennå.</p>}
        </div>
      ) : (
        <div className="kort tabell">
          <table>
            <thead>
              <tr>
                <th>Påminnelse</th>
                <th>Når</th>
                <th>Neste</th>
                <th>Til</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {data.map((p) => (
                <tr key={p.id} className="klikkbar" onClick={() => skriv && settRedigerer(p)}>
                  <td>
                    {p.tekst}
                    <span className="dempet liten" style={{ display: "block" }}>
                      {hva(p)}
                    </span>
                  </td>
                  <td>{naar(p)}</td>
                  <td>{p.aktiv ? dato(p.neste_dato) : "–"}</td>
                  <td>{hvem(p)}</td>
                  <td>{merke(p)}</td>
                  <td className="hoyre" onClick={(e) => e.stopPropagation()}>
                    <button className="lenke" onClick={() => lagFaktura(p)}>
                      Send faktura nå
                    </button>
                  </td>
                </tr>
              ))}
              {data.length === 0 && (
                <tr>
                  <td colSpan={6} className="dempet">
                    Ingen påminnelser ennå.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      <Dialog apen={!!redigerer} lukk={() => settRedigerer(null)} tittel={redigerer?.id ? "Endre påminnelse" : "Ny påminnelse"}>
        {redigerer && (
          <Skjema
            key={redigerer.id ?? "ny"}
            p={redigerer}
            ferdig={() => {
              settRedigerer(null);
              last();
            }}
          />
        )}
      </Dialog>
    </>
  );
}

function Skjema({ p, ferdig }: { p: Partial<Paaminnelse>; ferdig: () => void }) {
  const { org } = useKonto();
  const kunder = useData(() => hent<any[]>(`/org/${org!.id}/kunder?aktiv=true`), [org?.id]);
  const produkter = useData(() => hent<any[]>(`/org/${org!.id}/produkter?aktiv=true`), [org?.id]);
  const [kundeId, settKundeId] = useState<string | null>(p.kunde_id ?? null);
  const [valgte, settValgte] = useState<string[]>(p.produkter ?? []);
  const [tekst, settTekst] = useState(p.tekst ?? "");
  const [egenTekst, settEgenTekst] = useState(Boolean(p.id)); // brukeren har skrevet teksten selv
  const [neste, settNeste] = useState(p.neste_dato && p.neste_dato >= iDag() ? p.neste_dato : forsteNesteMaaned());
  const [kl, settKl] = useState(p.klokkeslett ?? "08:00");
  const [intervall, settIntervall] = useState<Intervall>(p.intervall ?? "maaned");
  const [hvem, settHvem] = useState<"meg" | "alle">(p.hvem ?? "meg");
  const [epost, settEpost] = useState(p.epost ?? false);
  const [aktiv, settAktiv] = useState(p.aktiv ?? true);
  const h = useHandling();

  const kunde = kunder.data?.find((k) => k.id === kundeId);
  // Produktene fra registeret, og de som er tatt ut av det (vises, men kan fjernes).
  const produktNavn = (id: string) => produkter.data?.find((x) => x.id === id)?.navn ?? p.produktliste?.find((x) => x.id === id)?.navn ?? "Produkt";
  const variabel = (id: string) => {
    const x = produkter.data?.find((y) => y.id === id);
    return x ? x.enhetspris == null : p.produktliste?.find((y) => y.id === id)?.fast_pris === false;
  };
  const forslag = `Send faktura${kunde ? ` til ${kunde.navn}` : ""}${valgte.length ? ` for ${valgte.map(produktNavn).join(", ")}` : ""}`;
  useEffect(() => {
    if (!egenTekst) settTekst(valgte.length || kunde ? forslag : "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [forslag, egenTekst]);

  const dag = Number(neste.slice(8, 10));
  const deretter =
    intervall === "en_gang" ? "Bare denne gangen." : `Deretter ${naar({ intervall, dag, neste_dato: neste, klokkeslett: kl }).replace(/^./, (c) => c.toLowerCase())}.`;

  async function lagre(e: FormEvent) {
    e.preventDefault();
    if (!tekst.trim()) return h.settFeil("Skriv hva påminnelsen gjelder.");
    const kropp: Record<string, unknown> = { tekst, kunde_id: kundeId, produkter: valgte, intervall, klokkeslett: kl, hvem, epost, aktiv };
    if (!p.id || neste !== p.neste_dato || (aktiv && !p.aktiv)) kropp.neste_dato = neste;
    const r = await h.kjor(() => (p.id ? api("PATCH", `/org/${org!.id}/paaminnelser/${p.id}`, kropp) : api("POST", `/org/${org!.id}/paaminnelser`, kropp)));
    if (r) ferdig();
  }
  async function slett() {
    if (!confirm("Slette påminnelsen?")) return;
    const r = await h.kjor(async () => (await api("DELETE", `/org/${org!.id}/paaminnelser/${p.id}`), true));
    if (r) ferdig();
  }

  if (!kunder.data || !produkter.data) return <Laster />;
  return (
    <form onSubmit={lagre} className="paaminnelse-skjema">
      <label>
        Kunde
        <Sokefelt valg={kundeValg(kunder.data)} verdi={kundeId} velg={settKundeId} tom="Ingen bestemt kunde" plassholder="Søk etter kunde" etikett="Kunde" />
      </label>
      <div className="felt">
        <span className="etikett">Produkter</span>
        {valgte.length > 0 && (
          <div className="paaminnelse-produkter">
            {valgte.map((id) => (
              <span key={id} className="produkt-brikke">
                {produktNavn(id)}
                {variabel(id) && <span className="dempet"> · variabel pris</span>}
                <button type="button" className="ikon" aria-label={`Fjern ${produktNavn(id)}`} onClick={() => settValgte(valgte.filter((x) => x !== id))}>
                  <IkonLukk storrelse={14} />
                </button>
              </span>
            ))}
          </div>
        )}
        {valgte.length < 10 && (
          <Sokefelt
            valg={produktValg(produkter.data.filter((x) => !valgte.includes(x.id)))}
            verdi={null}
            velg={(id) => id && settValgte([...valgte, id])}
            plassholder={valgte.length ? "Legg til et produkt til" : "Søk etter produkt (valgfritt)"}
            etikett="Legg til produkt"
          />
        )}
      </div>
      <label>
        Tekst i varselet
        <input
          value={tekst}
          maxLength={200}
          placeholder="F.eks. «Send strømfaktura til Kari Hansen»"
          onChange={(e) => {
            settTekst(e.target.value);
            settEgenTekst(true);
          }}
        />
      </label>
      <div className="rad">
        <label>
          {intervall === "en_gang" ? "Dato" : "Første påminnelse"}
          <input type="date" required min={iDag()} value={neste} onChange={(e) => settNeste(e.target.value)} />
        </label>
        <label>
          Klokkeslett
          <input type="time" required value={kl} onChange={(e) => settKl(e.target.value)} />
        </label>
      </div>
      <label>
        Hvor ofte
        <select value={intervall} onChange={(e) => settIntervall(e.target.value as Intervall)}>
          {INTERVALLER.map(([v, t]) => (
            <option key={v} value={v}>
              {t}
            </option>
          ))}
        </select>
      </label>
      {neste && (
        <p className="liten dempet paaminnelse-oppsummering">
          Første påminnelse {langDato(neste)} kl. {kl}. {deretter}
        </p>
      )}
      <fieldset className="valg-rad">
        <legend>Hvem får påminnelsen</legend>
        <label>
          <input type="radio" name="hvem" checked={hvem === "meg"} onChange={() => settHvem("meg")} />
          {p.id && !p.min ? `Bare ${p.opprettet_av_navn ?? "den som lagde den"}` : "Bare meg"}
        </label>
        <label>
          <input type="radio" name="hvem" checked={hvem === "alle"} onChange={() => settHvem("alle")} />
          Alle som kan fakturere i {org?.navn}
        </label>
      </fieldset>
      <label>
        <input type="checkbox" checked={epost} onChange={(e) => settEpost(e.target.checked)} />
        Send også på e-post
      </label>
      {p.id && (
        <label>
          <input type="checkbox" checked={aktiv} onChange={(e) => settAktiv(e.target.checked)} />
          Aktiv
        </label>
      )}
      <Feil melding={h.feil} />
      <div className="knapper">
        <button className="primar" disabled={h.opptatt}>
          {h.opptatt ? "Lagrer …" : "Lagre"}
        </button>
        {p.id && (
          <button type="button" className="fare" disabled={h.opptatt} onClick={slett}>
            Slett
          </button>
        )}
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Send fakturaen rett fra påminnelsen (varselet åpner denne siden)
// ---------------------------------------------------------------------------

type HurtigLinje = { produkt_id: string | null; beskrivelse: string; antall: string; enhet: string; pris: string; mva_sats: number; fast: boolean };

export function SendFraPaaminnelse() {
  const { id } = useParams();
  const { org } = useKonto();
  const nav = useNavigate();
  const paaminnelse = useData(() => hent<Paaminnelse>(`/org/${org!.id}/paaminnelser/${id}`), [org?.id, id]);
  const orgData = useData(() => hent<any>(`/org/${org!.id}`), [org?.id]);
  const kunder = useData(() => hent<any[]>(`/org/${org!.id}/kunder?aktiv=true`), [org?.id]);
  const produkter = useData(() => hent<any[]>(`/org/${org!.id}/produkter?aktiv=true`), [org?.id]);
  const [kundeId, settKundeId] = useState<string | null>(null);
  const [linjer, settLinjer] = useState<HurtigLinje[] | null>(null);
  const [forfall, settForfall] = useState("");
  const utkastId = useRef<string | null>(null); // utkastet som er lagret (om sendingen feilet etterpå)
  const forstePris = useRef<HTMLInputElement | null>(null);
  const h = useHandling();
  const p = paaminnelse.data;
  const o = orgData.data;

  // Fyll inn kunden og produktene fra påminnelsen (én gang). Produkter uten fast pris får tom pris.
  useEffect(() => {
    if (!p || !o || !kunder.data || !produkter.data || linjer) return;
    const utenMva = !o.mva_registrert;
    settKundeId(p.kunde_id && kunder.data.some((k) => k.id === p.kunde_id) ? p.kunde_id : null);
    const fra: HurtigLinje[] = p.produkter
      .map((pid) => produkter.data!.find((x) => x.id === pid))
      .filter(Boolean)
      .map((x: any) => ({
        produkt_id: x.id,
        beskrivelse: x.beskrivelse ? `${x.navn} – ${x.beskrivelse}` : x.navn,
        antall: "1",
        enhet: x.enhet || "stk",
        pris: x.enhetspris == null ? "" : String(x.enhetspris).replace(".", ","),
        mva_sats: utenMva ? 0 : Number(x.mva_sats),
        fast: x.enhetspris != null,
      }));
    settLinjer(fra.length ? fra : [{ produkt_id: null, beskrivelse: "", antall: "1", enhet: "stk", pris: "", mva_sats: utenMva ? 0 : 25, fast: false }]);
    settForfall(leggTilDager(iDag(), Number(o.standard_forfall_dager ?? 14)));
  }, [p, o, kunder.data, produkter.data, linjer]);
  // Rett til beløpet.
  useEffect(() => {
    if (linjer) forstePris.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [Boolean(linjer)]);

  if (paaminnelse.feil) return <Feil melding={paaminnelse.feil} />;
  if (!p || !o || !kunder.data || !produkter.data || !linjer) return <Laster />;
  if (!kanSkrive(org?.rolle)) return <Feil melding="Du har ikke tilgang til å lage fakturaer i denne organisasjonen." />;

  const kunde = kunder.data.find((k) => k.id === kundeId);
  const utenMva = !o.mva_registrert;
  const gebyr = Number(o.standard_gebyr) > 0;
  const tallLinjer = linjer.map((l) => ({ antall: tall(l.antall || "0") || 0, enhetspris: tall(l.pris || "0") || 0, mva_sats: l.mva_sats }));
  const sum = summer([...tallLinjer, ...gebyrLinjer(gebyr, o)]);
  const endre = (i: number, e: Partial<HurtigLinje>) => {
    h.settFeil(null);
    settLinjer(linjer.map((l, j) => (j === i ? { ...l, ...e } : l)));
  };
  const fokus = Math.max(0, linjer.findIndex((x) => !x.pris.trim())); // første linje uten pris
  const mottaker = !kunde
    ? null
    : kunde.epost
      ? `Sendes på e-post til ${kunde.epost}${kunde.ehf ? " (eller som EHF)" : ""}.`
      : kunde.ehf
        ? "Sendes som EHF."
        : "Kunden har ingen e-postadresse, så fakturaen blir utstedt, men ikke sendt. Du kan laste ned PDF-en etterpå.";

  const feil = (): string | null => {
    if (!kunde) return "Velg kunde.";
    for (const l of linjer) {
      const navn = l.beskrivelse.trim() || "linjen";
      if (!l.beskrivelse.trim()) return "Skriv hva fakturaen gjelder.";
      if (!(tall(l.antall) > 0)) return `Fyll inn antall for «${navn}».`;
      if (!l.pris.trim() || Number.isNaN(tall(l.pris))) return `Fyll inn prisen for «${navn}».`;
    }
    return null;
  };
  const kropp = () => ({
    kunde_id: kundeId,
    fakturadato: iDag(),
    forfallsdato: forfall || null,
    gebyr,
    linjer: linjer.map((l) => ({ produkt_id: l.produkt_id, beskrivelse: l.beskrivelse.trim(), antall: tall(l.antall), enhet: l.enhet, enhetspris: tall(l.pris), mva_sats: l.mva_sats })),
  });
  async function lagre(send: boolean) {
    const f = feil();
    if (f) return h.settFeil(f);
    if (send && !o.kontonr) return h.settFeil("Legg inn kontonummer under Innstillinger → Betaling før du sender fakturaer.");
    const r = await h.kjor(async () => {
      // Feilet sendingen etter at utkastet ble lagret, brukes samme utkast (ikke et nytt).
      if (utkastId.current) await api("PUT", `/org/${org!.id}/fakturaer/${utkastId.current}`, kropp());
      else utkastId.current = (await api<{ id: string }>("POST", `/org/${org!.id}/fakturaer`, kropp())).id;
      if (send) await api("POST", `/org/${org!.id}/fakturaer/${utkastId.current}/utsted`, { send_epost: true });
      return utkastId.current;
    });
    if (r) nav(`/fakturaer/${r}`, { state: send ? { sendt: true } : undefined });
  }
  // Mer å fylle inn (periode, referanser, vedlegg …): det fulle skjemaet, med det som er skrevet.
  const fulltSkjema = () =>
    nav(`/fakturaer/ny?paaminnelse=${p.id}`, {
      state: {
        kilde: "paaminnelse",
        aiUtkast: {
          kunde_id: kundeId,
          kunde_navn: null,
          linjer: linjer.map((l) => ({ produkt_id: l.produkt_id, beskrivelse: l.beskrivelse, antall: tall(l.antall || "1") || 1, enhet: l.enhet, enhetspris: l.pris.trim() ? tall(l.pris) : null, mva_sats: l.mva_sats, rabatt_prosent: null })),
          fakturadato: null,
          forfallsdato: forfall || null,
          periode_fra: null,
          periode_til: null,
          deres_referanse: null,
          kommentar: null,
          merknader: [],
        },
      },
    });

  return (
    <>
      <div className="topp">
        <h1>{p.tekst}</h1>
      </div>
      <p className="undertittel">
        Påminnelse · {naar(p)}
        {p.aktiv ? ` · neste ${dato(p.neste_dato)}` : ""}
      </p>
      <form
        className="kort hurtigfaktura"
        onSubmit={(e) => {
          e.preventDefault();
          void lagre(true);
        }}
      >
        <label>
          Kunde
          <Sokefelt valg={kundeValg(kunder.data)} verdi={kundeId} velg={settKundeId} plassholder="Søk etter kunde" etikett="Kunde" />
        </label>
        {linjer.map((l, i) => (
          <div key={i} className="hurtig-linje">
            <label>
              {linjer.length > 1 ? `Linje ${i + 1}` : "Hva gjelder fakturaen"}
              <input value={l.beskrivelse} onChange={(e) => endre(i, { beskrivelse: e.target.value })} placeholder="F.eks. Strøm oktober" />
            </label>
            <div className="hurtig-tall">
              <label>
                Antall{l.enhet && l.enhet !== "stk" ? ` (${l.enhet})` : ""}
                <input inputMode="decimal" value={l.antall} onChange={(e) => endre(i, { antall: e.target.value })} />
              </label>
              <label>
                {utenMva ? "Pris" : "Pris eks. mva"}
                <input
                  ref={i === fokus ? forstePris : undefined}
                  inputMode="decimal"
                  value={l.pris}
                  placeholder={l.fast ? undefined : "Fyll inn"}
                  onChange={(e) => endre(i, { pris: e.target.value })}
                />
              </label>
            </div>
          </div>
        ))}
        <label className="hurtig-forfall">
          Forfallsdato
          <input type="date" min={iDag()} value={forfall} onChange={(e) => settForfall(e.target.value)} />
        </label>
        <div className="hurtig-sum">
          <span>Å betale{!utenMva && sum.mva ? " inkl. mva" : ""}</span>
          <strong>{kr(sum.inkl)} kr</strong>
        </div>
        {gebyr && <p className="liten dempet">Med fakturagebyr på {kr(Number(o.standard_gebyr))} kr.</p>}
        {mottaker && <p className="liten dempet">{mottaker}</p>}
        {!o.kontonr && (
          <div className="melding info">
            Legg inn kontonummer under <Link to="/innstillinger?fane=betaling">Innstillinger → Betaling</Link> før du sender fakturaer.
          </div>
        )}
        <Feil melding={h.feil} />
        <div className="knapper hurtig-knapper">
          <button className="primar" disabled={h.opptatt || !o.kontonr}>
            {h.opptatt ? "Sender …" : "Send faktura"}
          </button>
          <button type="button" disabled={h.opptatt} onClick={() => void lagre(false)}>
            Lagre som utkast
          </button>
        </div>
        <button type="button" className="lenke liten" onClick={fulltSkjema} disabled={h.opptatt}>
          Åpne i fullt skjema (periode, referanser, vedlegg …)
        </button>
      </form>
    </>
  );
}
