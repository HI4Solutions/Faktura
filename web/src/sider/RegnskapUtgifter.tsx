// Regnskap → Utgifter (server/src/utgifter.ts): leverandørfakturaer og kvitteringer. Last opp eller
// ta bilde: AI leser dem, og reglene foreslår kontoen, fradraget for mva og om de skal
// kostnadsføres, aktiveres som anleggsmiddel eller periodiseres. Kladdene godkjennes (bokføres) med
// ett trykk, og fra en kjent leverandør bokføres de av seg selv. Ubetalte leverandørfakturaer står
// til de betales; bokføringen kan angres.
import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, hent, sendFil } from "../api";
import { Dialog, Feil, Laster, Tom, tall, useData, useHandling } from "../felles";
import { useKonto } from "../konto";
import { dato, iDag, kr } from "../format";
import { IkonGnist, IkonKamera, IkonOpplasting, IkonPluss, IkonRegnskap } from "../ikoner";
import { slippBlob, SLIPP_ACCEPT } from "../importer";

type Behandling = "kostnad" | "anlegg" | "periodisering";
type Betaling = "ubetalt" | "bank" | "kontant" | "ansatt";
type Linje = { beskrivelse: string | null; kategori: string | null; konto: string; belop: number; mva_sats: number; mva: number; fradrag: number };
type Forslag = { behandling: Behandling; vurdering: string; anlegg_kategori: string | null; levetid_mnd: number | null; periode_fra: string | null; antall_maaneder: number | null };
export type Utgift = {
  id: string;
  status: "kladd" | "bokfort";
  type: "faktura" | "kvittering";
  leverandor: string | null;
  orgnr: string | null;
  fakturanummer: string | null;
  dato: string | null;
  forfallsdato: string | null;
  kid: string | null;
  kontonr: string | null;
  belop: number | null;
  valuta: string;
  beskrivelse: string | null;
  betaling: Betaling;
  betalt_dato: string | null;
  behandling: Behandling;
  anlegg_kategori: string | null;
  levetid_mnd: number | null;
  periode_fra: string | null;
  antall_maaneder: number | null;
  vurdering: string | null;
  utland: boolean;
  fil_type: string | null;
  fil_navn: string | null;
  har_fil: boolean;
  auto: boolean;
  laert: boolean;
  anlegg_id: string | null;
  periodisering_id: string | null;
  bilagsnummer: string | null;
  betaling_bilagsnummer: string | null;
  linjer: Linje[];
  forslag?: Forslag | null;
  mangler?: string[];
  merknader?: string[];
  merknader_ai?: string[];
  ai_feil?: string | null;
};
type Kategori = { kode: string; navn: string; konto: string; fradrag: boolean };
type Liste = { utgifter: Utgift[]; ai: boolean; auto: boolean; kategorier: Kategori[]; anleggskategorier: { kode: string; navn: string; levetid: number | null }[] };

const BEHANDLING: Record<Behandling, string> = { kostnad: "Kostnad", anlegg: "Anleggsmiddel", periodisering: "Periodisert" };
const BETALING: Record<Betaling, string> = {
  ubetalt: "Ikke betalt (leverandørgjeld)",
  bank: "Betalt med kort eller fra banken",
  kontant: "Betalt kontant",
  ansatt: "Lagt ut av en ansatt",
};
const SATSER = [25, 15, 12, 11.11, 0];
const tekstTall = (n: number | null | undefined) => (n == null ? "" : String(n).replace(".", ","));
const tittel = (u: Pick<Utgift, "leverandor" | "fil_navn" | "type" | "fakturanummer">) =>
  u.leverandor ? `${u.leverandor}${u.fakturanummer ? `, ${u.type === "kvittering" ? "kvittering" : "faktura"} ${u.fakturanummer}` : ""}` : (u.fil_navn ?? "Uten leverandør");

export function Utgifter({ apen, apne }: { apen: string | null; apne: (id: string | null) => void }) {
  const { org } = useKonto();
  const sti = `/org/${org!.id}/regnskap/utgifter`;
  const liste = useData(() => hent<Liste>(sti), [sti]);
  const [laster, settLaster] = useState<string[]>([]);
  const [meldinger, settMeldinger] = useState<string[]>([]);
  const fil = useRef<HTMLInputElement>(null);
  const kamera = useRef<HTMLInputElement>(null);
  const h = useHandling();

  async function lastOpp(filer: File[]) {
    settMeldinger([]);
    h.settFeil(null);
    const ut: string[] = [];
    for (const f of filer) {
      settLaster((x) => [...x, f.name]);
      try {
        const u = await sendFil<Utgift>(sti, slippBlob(f), "Fila er for stor. En faktura eller kvittering kan være høyst 12 MB.", f.name);
        ut.push(
          u.status === "bokfort"
            ? `${tittel(u)}: bokført av seg selv (${u.bilagsnummer}).`
            : u.ai_feil
              ? `${f.name}: ${u.ai_feil} Fyll ut og godkjenn.`
              : `${tittel(u)}: venter på godkjenning.`,
        );
        if (filer.length === 1 && u.status === "kladd") apne(u.id);
      } catch (e) {
        ut.push(`${f.name}: ${(e as Error).message}`);
      } finally {
        settLaster((x) => x.filter((n) => n !== f.name));
      }
    }
    settMeldinger(ut);
    void liste.last();
  }

  async function nyForHaand() {
    const u = await h.kjor(() => api<Utgift>("POST", sti, { dato: iDag() }));
    if (u) {
      void liste.last();
      apne(u.id);
    }
  }

  const d = liste.data;
  const kladder = d?.utgifter.filter((u) => u.status === "kladd") ?? [];
  const ubetalt = d?.utgifter.filter((u) => u.status === "bokfort" && u.betaling === "ubetalt") ?? [];
  const bokfort = d?.utgifter.filter((u) => u.status === "bokfort" && u.betaling !== "ubetalt") ?? [];
  const velg = (filer: FileList | null) => {
    const l = [...(filer ?? [])];
    if (l.length) void lastOpp(l);
  };

  return (
    <>
      <p className="dempet liten">
        Leverandørfakturaer og kvitteringer: last dem opp eller ta bilde{d?.ai ? ", så leser AI dem" : ""}. Reglene foreslår kontoen, fradraget for mva og om utgiften skal
        kostnadsføres, aktiveres som anleggsmiddel (fra 30 000 kr) eller periodiseres over månedene den gjelder. Godkjenn med ett trykk;
        {d?.auto ? " fra en leverandør du har godkjent før, bokføres de av seg selv." : " automatikken for kjente leverandører er slått av (Kontoer)."}
      </p>
      <div className="knapper lonn-knapper utgift-knapper">
        <button type="button" className="primar" disabled={laster.length > 0} onClick={() => fil.current?.click()}>
          {laster.length ? <span className="spinner" /> : <IkonOpplasting />} {laster.length ? `Leser ${laster.length === 1 ? laster[0] : `${laster.length} filer`} …` : "Last opp"}
        </button>
        <button type="button" className="utgift-kamera" disabled={laster.length > 0} onClick={() => kamera.current?.click()}>
          <IkonKamera /> Ta bilde
        </button>
        <button type="button" disabled={h.opptatt} onClick={() => void nyForHaand()}>
          <IkonPluss /> For hånd
        </button>
        <input ref={fil} type="file" hidden multiple accept={SLIPP_ACCEPT} onChange={(e) => (velg(e.target.files), (e.target.value = ""))} />
        <input ref={kamera} type="file" hidden accept="image/*" capture="environment" onChange={(e) => (velg(e.target.files), (e.target.value = ""))} />
      </div>
      {meldinger.length > 0 && (
        <div className="melding ok" role="status">
          {meldinger.map((m) => (
            <div key={m}>{m}</div>
          ))}
        </div>
      )}
      <Feil melding={h.feil} />
      {liste.feil ? (
        <Feil melding={liste.feil} />
      ) : !d ? (
        <Laster />
      ) : !d.utgifter.length ? (
        <div className="kort">
          <Tom ikon={<IkonRegnskap storrelse={22} />} tittel="Ingen utgifter ennå">
            <p>Last opp en leverandørfaktura eller en kvittering (PDF eller bilde), eller ta bilde av den med telefonen.</p>
          </Tom>
        </div>
      ) : (
        <>
          <Gruppe tittel="Til godkjenning" utgifter={kladder} apne={apne} tom="Ingenting venter på godkjenning." />
          <Gruppe tittel="Ikke betalt" utgifter={ubetalt} apne={apne} />
          <Gruppe tittel="Bokført" utgifter={bokfort} apne={apne} />
        </>
      )}
      <Dialog apen={!!apen} lukk={() => apne(null)} tittel="Utgift" bred>
        {apen && d && <UtgiftDetalj key={apen} id={apen} liste={d} endret={() => void liste.last()} lukk={() => apne(null)} />}
      </Dialog>
    </>
  );
}

function Gruppe({ tittel: t, utgifter, apne, tom }: { tittel: string; utgifter: Utgift[]; apne: (id: string) => void; tom?: string }) {
  if (!utgifter.length && !tom) return null;
  const forfalt = (u: Utgift) => u.betaling === "ubetalt" && u.status === "bokfort" && !!u.forfallsdato && u.forfallsdato < iDag();
  return (
    <>
      <h2 className="utgift-gruppe">
        {t} {utgifter.length > 0 && <span className="dempet">({utgifter.length})</span>}
      </h2>
      {!utgifter.length ? (
        <p className="dempet liten">{tom}</p>
      ) : (
        <div className="kort liste">
          {utgifter.map((u) => (
            <button key={u.id} type="button" className="liste-rad" onClick={() => apne(u.id)}>
              <span className="linje">
                <span className="tittel">{tittel(u)}</span>
                <span className="tall">{u.belop != null ? kr(u.belop) : ""}</span>
              </span>
              <span className="linje">
                <span className="under">
                  {u.dato ? dato(u.dato) : "Uten dato"}
                  {u.bilagsnummer ? ` · ${u.bilagsnummer}` : ""}
                  {u.status === "bokfort" && u.betaling === "ubetalt" && u.forfallsdato ? ` · forfall ${dato(u.forfallsdato)}` : ""}
                </span>
                {u.status === "kladd" ? (
                  u.laert ? (
                    <span className="merke merke-info">Kjent leverandør</span>
                  ) : (
                    <span className="merke merke-advarsel">Venter</span>
                  )
                ) : forfalt(u) ? (
                  <span className="merke merke-fare">Forfalt</span>
                ) : u.behandling !== "kostnad" ? (
                  <span className="merke merke-noytral">{BEHANDLING[u.behandling]}</span>
                ) : u.auto ? (
                  <span className="merke merke-ok">Bokført av seg selv</span>
                ) : null}
              </span>
            </button>
          ))}
        </div>
      )}
    </>
  );
}

type Skjemalinje = { beskrivelse: string; kategori: string; konto: string; belop: string; mva_sats: string; mva: string; fradrag: string };
const tilSkjemalinje = (l: Linje): Skjemalinje => ({
  beskrivelse: l.beskrivelse ?? "",
  kategori: l.kategori ?? "",
  konto: l.konto,
  belop: tekstTall(l.belop),
  mva_sats: String(l.mva_sats),
  mva: tekstTall(l.mva),
  fradrag: tekstTall(l.fradrag),
});
type Skjema = {
  type: "faktura" | "kvittering";
  leverandor: string;
  orgnr: string;
  fakturanummer: string;
  dato: string;
  forfallsdato: string;
  kid: string;
  kontonr: string;
  belop: string;
  valuta: string;
  beskrivelse: string;
  betaling: Betaling;
  utland: boolean;
  behandling: Behandling;
  anlegg_kategori: string;
  levetid_mnd: string;
  periode_fra: string;
  antall_maaneder: string;
  linjer: Skjemalinje[];
};
const tilSkjema = (u: Utgift): Skjema => ({
  type: u.type,
  leverandor: u.leverandor ?? "",
  orgnr: u.orgnr ?? "",
  fakturanummer: u.fakturanummer ?? "",
  dato: u.dato ?? "",
  forfallsdato: u.forfallsdato ?? "",
  kid: u.kid ?? "",
  kontonr: u.kontonr ?? "",
  belop: tekstTall(u.belop),
  valuta: u.valuta,
  beskrivelse: u.beskrivelse ?? "",
  betaling: u.betaling,
  utland: u.utland,
  behandling: u.behandling,
  anlegg_kategori: u.anlegg_kategori ?? "",
  levetid_mnd: u.levetid_mnd ? String(u.levetid_mnd) : "",
  periode_fra: u.periode_fra ? u.periode_fra.slice(0, 7) : "",
  antall_maaneder: u.antall_maaneder ? String(u.antall_maaneder) : "",
  linjer: u.linjer.map(tilSkjemalinje),
});
const tomtTall = (s: string) => (s.trim() ? tall(s) : null);
// Det som sendes: tomme felt som null, tallene som tall.
function tilKropp(s: Skjema) {
  return {
    type: s.type,
    leverandor: s.leverandor.trim() || null,
    orgnr: s.orgnr.replace(/\s/g, "") || null,
    fakturanummer: s.fakturanummer.trim() || null,
    dato: s.dato || null,
    forfallsdato: s.forfallsdato || null,
    kid: s.kid.replace(/\s/g, "") || null,
    kontonr: s.kontonr.replace(/[\s.]/g, "") || null,
    belop: tomtTall(s.belop),
    valuta: s.valuta,
    beskrivelse: s.beskrivelse.trim() || null,
    betaling: s.betaling,
    utland: s.utland,
    behandling: s.behandling,
    anlegg_kategori: s.anlegg_kategori || null,
    levetid_mnd: s.levetid_mnd ? Number(s.levetid_mnd) : null,
    periode_fra: s.periode_fra || null,
    antall_maaneder: s.antall_maaneder ? Number(s.antall_maaneder) : null,
    linjer: s.linjer
      .filter((l) => l.konto.trim() || l.belop.trim())
      .map((l) => ({
        beskrivelse: l.beskrivelse.trim() || null,
        kategori: l.kategori || null,
        konto: l.konto.trim(),
        belop: tall(l.belop),
        mva_sats: Number(l.mva_sats),
        mva: tomtTall(l.mva) ?? 0,
        fradrag: tomtTall(l.fradrag) ?? 0,
      })),
  };
}

function UtgiftDetalj({ id, liste, endret, lukk }: { id: string; liste: Liste; endret: () => void; lukk: () => void }) {
  const { org } = useKonto();
  const sti = `/org/${org!.id}/regnskap/utgifter/${id}`;
  const u = useData(() => hent<Utgift>(sti), [sti]);
  const kontoer = useData(() => hent<{ kontoer: { konto: string; navn: string }[] }>(`/org/${org!.id}/regnskap/kontoliste`), [org!.id]);
  const [s, settS] = useState<Skjema | null>(null);
  const [url, settUrl] = useState<string | null>(null);
  const [betalt, settBetalt] = useState(iDag());
  const h = useHandling();
  useEffect(() => {
    if (u.data && !s) settS(tilSkjema(u.data));
  }, [u.data, s]);
  useEffect(() => {
    if (!u.data?.har_fil) return;
    void hent<{ url: string }>(`${sti}/fil`)
      .then((x) => settUrl(x.url))
      .catch(() => settUrl(null));
  }, [u.data?.har_fil, sti]);
  if (u.feil) return <Feil melding={u.feil} />;
  if (!u.data || !s) return <Laster />;
  const x = u.data;
  const kladd = x.status === "kladd";
  const navn = (k: string) => kontoer.data?.kontoer.find((y) => y.konto === k.trim())?.navn ?? "";
  const sett = (endring: Partial<Skjema>) => settS({ ...s, ...endring });
  const settLinje = (i: number, endring: Partial<Skjemalinje>) => {
    const l = { ...s.linjer[i]!, ...endring };
    // Avgiften regnes når beløpet eller satsen endres (den kan skrives over).
    if ((endring.belop !== undefined || endring.mva_sats !== undefined) && l.belop.trim())
      l.mva = tekstTall(Math.round(tall(l.belop) * Number(l.mva_sats)) / 100);
    sett({ linjer: s.linjer.map((y, j) => (j === i ? l : y)) });
  };
  const ny = (svar: Utgift) => {
    u.settData(svar);
    settS(tilSkjema(svar));
    endret();
  };

  async function lagre(e?: FormEvent) {
    e?.preventDefault();
    const r = await h.kjor(() => api<Utgift>("PATCH", sti, tilKropp(s!)));
    if (r) ny(r);
    return r;
  }
  async function bokfor() {
    const r = await h.kjor(async () => {
      await api<Utgift>("PATCH", sti, tilKropp(s!));
      return api<Utgift>("POST", `${sti}/bokfor`);
    });
    if (r) ny(r);
  }
  async function handling(sti2: string, kropp?: unknown) {
    const r = await h.kjor(() => api<Utgift>("POST", `${sti}${sti2}`, kropp));
    if (r) ny(r);
  }
  async function slett() {
    if (!confirm("Slette utgiften?")) return;
    const r = await h.kjor(() => api("DELETE", sti));
    if (r !== undefined) {
      endret();
      lukk();
    }
  }

  const bilde = x.fil_type?.startsWith("image/") && x.fil_type !== "image/heic" && x.fil_type !== "image/heif";
  const sumLinjer = s.linjer.reduce((t, l) => t + (l.belop.trim() ? tall(l.belop) : 0) + (s.utland ? 0 : l.mva.trim() ? tall(l.mva) : 0), 0);
  return (
    <div className="utgift-detalj">
      {x.har_fil && (
        <div className="utgift-fil">
          {url && bilde ? <img src={url} alt={x.fil_navn ?? "Kvitteringen"} /> : url && x.fil_type === "application/pdf" ? <iframe src={url} title={x.fil_navn ?? "Fakturaen"} /> : null}
          {url && (
            <a href={url} target="_blank" rel="noreferrer" className="liten">
              Åpne {x.fil_navn ?? "fila"}
            </a>
          )}
        </div>
      )}
      <form className="utgift-skjema" onSubmit={lagre}>
        {x.status === "bokfort" && (
          <div className="melding ok" role="status">
            Bokført {x.auto ? "av seg selv " : ""}({x.bilagsnummer}){x.betaling_bilagsnummer ? `, betalt ${dato(x.betalt_dato)} (${x.betaling_bilagsnummer})` : x.betalt_dato ? `, betalt ${dato(x.betalt_dato)}` : ""}.
          </div>
        )}
        {x.ai_feil && <div className="melding advarsel">{x.ai_feil} Fyll ut selv, eller les fila på nytt.</div>}
        {(x.merknader_ai ?? []).length > 0 && (
          <div className="melding advarsel">
            {x.merknader_ai!.map((m) => (
              <div key={m}>{m}</div>
            ))}
          </div>
        )}
        <fieldset disabled={!kladd || h.opptatt}>
          <div className="rad">
            <label>
              Leverandør
              <input value={s.leverandor} onChange={(e) => sett({ leverandor: e.target.value })} />
            </label>
            <label>
              Org.nr.
              <input inputMode="numeric" value={s.orgnr} onChange={(e) => sett({ orgnr: e.target.value })} />
            </label>
          </div>
          <div className="rad">
            <label>
              Hva
              <select value={s.type} onChange={(e) => sett({ type: e.target.value as Skjema["type"] })}>
                <option value="faktura">Leverandørfaktura</option>
                <option value="kvittering">Kvittering</option>
              </select>
            </label>
            <label>
              {s.type === "kvittering" ? "Kvitteringsnr." : "Fakturanr."}
              <input value={s.fakturanummer} onChange={(e) => sett({ fakturanummer: e.target.value })} />
            </label>
            <label>
              Dato
              <input type="date" value={s.dato} max={iDag()} onChange={(e) => sett({ dato: e.target.value })} />
            </label>
            <label>
              Beløp med mva
              <input inputMode="decimal" value={s.belop} onChange={(e) => sett({ belop: e.target.value })} />
              {s.valuta !== "NOK" && <span className="felt-hjelp">I {s.valuta}: skriv beløpet i kroner.</span>}
            </label>
          </div>
          <div className="rad">
            <label>
              Betaling
              <select value={s.betaling} onChange={(e) => sett({ betaling: e.target.value as Betaling })}>
                {(Object.keys(BETALING) as Betaling[]).map((b) => (
                  <option key={b} value={b}>
                    {BETALING[b]}
                  </option>
                ))}
              </select>
            </label>
            {s.betaling === "ubetalt" && (
              <>
                <label>
                  Forfall
                  <input type="date" value={s.forfallsdato} onChange={(e) => sett({ forfallsdato: e.target.value })} />
                </label>
                <label>
                  KID
                  <input inputMode="numeric" value={s.kid} onChange={(e) => sett({ kid: e.target.value })} />
                </label>
                <label>
                  Kontonummer
                  <input inputMode="numeric" value={s.kontonr} onChange={(e) => sett({ kontonr: e.target.value })} />
                </label>
              </>
            )}
          </div>
          <div className="utgift-linjer">
            <h3>Linjene</h3>
            {s.linjer.map((l, i) => (
              <div key={i} className="utgift-linje">
                <label className="bred">
                  Beskrivelse
                  <input aria-label={`Beskrivelse, linje ${i + 1}`} value={l.beskrivelse} onChange={(e) => settLinje(i, { beskrivelse: e.target.value })} />
                </label>
                <label className="kategori">
                  Hva slags kjøp
                  <select
                    value={l.kategori}
                    onChange={(e) => {
                      const k = liste.kategorier.find((y) => y.kode === e.target.value);
                      settLinje(i, { kategori: e.target.value, ...(k ? { konto: k.konto } : {}) });
                    }}
                  >
                    <option value="">Velg</option>
                    {liste.kategorier.map((k) => (
                      <option key={k.kode} value={k.kode}>
                        {k.navn}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Konto
                  <input inputMode="numeric" aria-label={`Konto, linje ${i + 1}`} value={l.konto} onChange={(e) => settLinje(i, { konto: e.target.value })} />
                  <span className="felt-hjelp">{navn(l.konto)}</span>
                </label>
                <label>
                  Uten mva
                  <input inputMode="decimal" aria-label={`Beløp uten mva, linje ${i + 1}`} value={l.belop} onChange={(e) => settLinje(i, { belop: e.target.value })} />
                </label>
                {!s.utland && (
                  <label>
                    Sats
                    <select value={l.mva_sats} onChange={(e) => settLinje(i, { mva_sats: e.target.value })}>
                      {SATSER.map((x) => (
                        <option key={x} value={String(x)}>
                          {tekstTall(x)} %
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {!s.utland && (
                  <label>
                    Mva
                    <input inputMode="decimal" value={l.mva} onChange={(e) => settLinje(i, { mva: e.target.value })} />
                  </label>
                )}
                <label>
                  Fradrag %
                  <input inputMode="decimal" value={l.fradrag} onChange={(e) => settLinje(i, { fradrag: e.target.value })} />
                </label>
                {kladd && (
                  <button type="button" className="lenke fjern" onClick={() => sett({ linjer: s.linjer.filter((_, j) => j !== i) })}>
                    Fjern
                  </button>
                )}
              </div>
            ))}
            {kladd && (
              <button
                type="button"
                className="lenke"
                onClick={() => sett({ linjer: [...s.linjer, { beskrivelse: "", kategori: "", konto: "", belop: "", mva_sats: "25", mva: "", fradrag: "100" }] })}
              >
                <IkonPluss /> Legg til linje
              </button>
            )}
            <p className="liten dempet">
              Linjene: {kr(Math.round(sumLinjer * 100) / 100)}
              {s.utland ? " (uten mva, som beregnes)" : " med mva"}
              {s.belop.trim() && Math.abs(sumLinjer - tall(s.belop)) >= 0.005 ? ` · utgiften er ${kr(tall(s.belop))}` : ""}
            </p>
            <label className="avkrysning">
              <input type="checkbox" checked={s.utland} onChange={(e) => sett({ utland: e.target.checked })} /> Tjenester kjøpt fra utlandet uten norsk mva (mva-en beregnes
              av oss)
            </label>
          </div>
          <div className="utgift-behandling">
            <h3>Føres som</h3>
            <div className="valg-rad" role="radiogroup">
              {(Object.keys(BEHANDLING) as Behandling[]).map((b) => (
                <label key={b} className="avkrysning">
                  <input type="radio" name="behandling" checked={s.behandling === b} onChange={() => sett({ behandling: b })} /> {BEHANDLING[b]}
                </label>
              ))}
            </div>
            {s.behandling === "anlegg" && (
              <div className="rad">
                <label>
                  Hva slags anleggsmiddel
                  <select
                    value={s.anlegg_kategori}
                    onChange={(e) => {
                      const k = liste.anleggskategorier.find((y) => y.kode === e.target.value);
                      sett({ anlegg_kategori: e.target.value, levetid_mnd: k?.levetid ? String(k.levetid) : s.levetid_mnd });
                    }}
                  >
                    <option value="">Velg</option>
                    {liste.anleggskategorier.map((k) => (
                      <option key={k.kode} value={k.kode}>
                        {k.navn}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Levetid (måneder)
                  <input inputMode="numeric" value={s.levetid_mnd} onChange={(e) => sett({ levetid_mnd: e.target.value.replace(/\D/g, "") })} />
                </label>
              </div>
            )}
            {s.behandling === "periodisering" && (
              <div className="rad">
                <label>
                  Fra måned
                  <input type="month" value={s.periode_fra} onChange={(e) => sett({ periode_fra: e.target.value })} />
                </label>
                <label>
                  Antall måneder
                  <input inputMode="numeric" value={s.antall_maaneder} onChange={(e) => sett({ antall_maaneder: e.target.value.replace(/\D/g, "") })} />
                </label>
              </div>
            )}
            {x.vurdering && <p className="utgift-vurdering">{x.vurdering}</p>}
            {kladd && x.forslag && x.forslag.behandling !== x.behandling && (
              <p className="liten dempet">Reglene foreslår {BEHANDLING[x.forslag.behandling].toLowerCase()}; du har valgt {BEHANDLING[x.behandling].toLowerCase()}.</p>
            )}
            {(x.merknader ?? []).map((m) => (
              <p key={m} className="liten advarsel-tekst">
                {m}
              </p>
            ))}
          </div>
          <label>
            Notat
            <input value={s.beskrivelse} onChange={(e) => sett({ beskrivelse: e.target.value })} />
          </label>
        </fieldset>
        {kladd && (x.mangler ?? []).length > 0 && (
          <ul className="utgift-mangler liten">
            {x.mangler!.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        )}
        <Feil melding={h.feil} />
        <div className="knapper">
          {kladd ? (
            <>
              <button type="button" className="primar" disabled={h.opptatt} onClick={() => void bokfor()}>
                Godkjenn og bokfør
              </button>
              <button disabled={h.opptatt}>Lagre</button>
              {liste.ai && x.har_fil && (
                <button type="button" disabled={h.opptatt} onClick={() => void handling("/les")}>
                  <IkonGnist storrelse={16} /> Les på nytt
                </button>
              )}
              <button type="button" className="lenke fare-lenke" disabled={h.opptatt} onClick={() => void slett()}>
                Slett
              </button>
            </>
          ) : (
            <>
              {x.betaling === "ubetalt" && (
                <span className="utgift-betal">
                  <input type="date" aria-label="Betalingsdato" value={betalt} max={iDag()} onChange={(e) => settBetalt(e.target.value)} />
                  <button type="button" className="primar" disabled={h.opptatt} onClick={() => void handling("/betal", { dato: betalt })}>
                    Betalt
                  </button>
                </span>
              )}
              <button
                type="button"
                disabled={h.opptatt}
                onClick={() => {
                  if (confirm("Angre bokføringen? Bilagene reverseres, og utgiften blir en kladd igjen.")) void handling("/angre");
                }}
              >
                Angre bokføringen
              </button>
            </>
          )}
        </div>
      </form>
    </div>
  );
}
