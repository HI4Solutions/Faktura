// Regnskap (0086_regnskap_anlegg.sql, 0087_regnskap_bilag.sql, server/src/regnskapRuter.ts og
// regnskapBilagRuter.ts): bilagene fra alle kildene med manuelle bilag og reversering
// (RegnskapBilag.tsx), saldobalansen og hovedboken, anleggsmidlene med avskrivningsplanen over flere
// år (også goodwill), nedskrivning og reversering, salg og utrangering, periodiseringene
// (RegnskapPeriodiseringer.tsx), månedsavslutningen (RegnskapAvslutning.tsx), saldoavskrivningene
// (skattemessig, med goodwill i gruppe b) og kontoene. Eier, administrator og regnskap, med
// funksjonen «Regnskap».
//
// Fanen står i adressen (?fane=bilag|utgifter|bank|saldobalanse|anlegg|periodiseringer|saldo|kontoer), og det
// som er åpent, med ?anlegg=, ?periodisering=, ?utgift= eller ?post=.
import { useState, type FormEvent, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, hent } from "../api";
import { Dialog, Feil, Laster, Tom, tall, useData, useHandling, useSmal } from "../felles";
import { useKonto } from "../konto";
import { dato, iDag, kr } from "../format";
import { IkonPluss, IkonRegnskap, IkonVenstre } from "../ikoner";
import { Bilag, Saldobalansen } from "./RegnskapBilag";
import { Maanedsavslutning, mndNavn, type Bilagsvar } from "./RegnskapAvslutning";
import { PeriodiseringDetalj, Periodiseringer } from "./RegnskapPeriodiseringer";
import { Utgifter } from "./RegnskapUtgifter";
import { Bank, visKonto, type Bankoversikt } from "./RegnskapBank";

type Kategori = { kode: string; navn: string; konto: string; avskrivningskonto: string | null; skatt: string; levetid_mnd: number | null };
type Kontorad = { rolle: string; navn: string; standard: string; konto: string; endret: boolean };
type Oppsett = {
  kontoer: Kontorad[];
  saldo_fra_aar: number | null;
  saldo_inngaende: Partial<Record<"a" | "c" | "d" | "gevinst_tap", number>>;
  salg_fra: string | null;
  uten_mva: "unntatt" | "fritatt";
  kundefordringer_ved_start: number | null;
  mva_fradrag: number | null;
  periodiser_fra: number;
  utgifter_auto: boolean;
  bank_fra: string | null;
  bank_auto: boolean;
  bankkontoer: Record<string, string>;
  kategorier: Kategori[];
  saldogrupper: { gruppe: string; navn: string; sats: number; samlet: boolean }[];
};
type Anlegg = {
  id: string;
  nummer: number;
  navn: string;
  beskrivelse: string | null;
  kategori: string;
  anskaffet: string;
  avskrives_fra: string;
  kostpris: number;
  restverdi: number;
  levetid_mnd: number | null;
  konto: string;
  avskrivningskonto: string | null;
  skatt: string;
  skatt_kostpris: number | null;
  skatt_sats: number | null;
  tidligere_til: string | null;
  tidligere_avskrevet: number;
  skatt_inngaende: number | null;
  avgang_dato: string | null;
  avgang_type: "salg" | "utrangering" | null;
  avgang_vederlag: number | null;
  avskrevet: number;
  nedskrevet: number;
  verdi: number;
  bokfort_til: string | null;
  neste: { maaned: string; belop: number } | null;
  slutt: string | null;
  tilstand: "aktiv" | "avskrevet" | "solgt" | "utrangert";
};
type Hendelse = {
  id: string;
  type: "anskaffelse" | "avskrivning" | "nedskrivning" | "reversering" | "avgang";
  dato: string;
  maaned: string | null;
  belop: number;
  vederlag: number | null;
  tekst: string | null;
  bilag_id: string;
  bilag: string;
  reversert: boolean;
};
type Planmaaned = { maaned: string; belop: number; bokfort: boolean; bilag: string | null; verdi: number };
type Planaar = { aar: number; inngaende: number; avskrivning: number; nedskrivning: number; avgang: number; utgaende: number; bokfort: boolean };
type Detalj = { anleggsmiddel: Anlegg; hendelser: Hendelse[]; plan: Planmaaned[]; aar: Planaar[]; kan_reversere: boolean };
const levetid = (m: number | null) => (m == null ? "Avskrives ikke" : m % 12 === 0 ? `${m / 12} år` : m < 12 ? `${m} mnd` : `${Math.floor(m / 12)} år og ${m % 12} mnd`);
const skattNavn = (s: string) => (s === "lineaer" ? "Lineært" : s === "ingen" ? "Avskrives ikke" : `Gruppe ${s}`);
const tekstTall = (n: number | null | undefined) => (n == null ? "" : String(n).replace(".", ","));
const TILSTAND: Record<Anlegg["tilstand"], [string, string]> = {
  aktiv: ["I bruk", "merke-ok"],
  avskrevet: ["Avskrevet", "merke-noytral"],
  solgt: ["Solgt", "merke-noytral"],
  utrangert: ["Utrangert", "merke-noytral"],
};
const HENDELSE: Record<Hendelse["type"], string> = {
  anskaffelse: "Anskaffelse",
  avskrivning: "Avskrivning",
  nedskrivning: "Nedskrivning",
  reversering: "Reversert nedskrivning",
  avgang: "Avgang",
};
const merke = (a: Anlegg) => {
  const [t, k] = TILSTAND[a.tilstand];
  return <span className={`merke ${k}`}>{a.avgang_dato ? `${t} ${dato(a.avgang_dato)}` : t}</span>;
};

export function Regnskap() {
  const [sok, settSok] = useSearchParams();
  const faner: [string, string][] = [
    ["bilag", "Bilag"],
    ["utgifter", "Utgifter"],
    ["bank", "Bank"],
    ["saldobalanse", "Saldobalanse"],
    ["anlegg", "Anleggsmidler"],
    ["periodiseringer", "Periodiseringer"],
    ["saldo", "Saldoavskrivninger"],
    ["kontoer", "Kontoer"],
  ];
  const fane = faner.find(([v]) => v === sok.get("fane"))?.[0] ?? "bilag";
  const anlegg = sok.get("anlegg");
  const periodisering = sok.get("periodisering");
  const ga = (endring: Record<string, string | null>) => {
    const p = new URLSearchParams(sok);
    for (const [k, v] of Object.entries(endring)) {
      if (v === null) p.delete(k);
      else p.set(k, v);
    }
    settSok(p);
  };
  if (fane === "anlegg" && anlegg) return <AnleggDetalj key={anlegg} id={anlegg} tilbake={() => ga({ anlegg: null })} />;
  if (fane === "periodiseringer" && periodisering)
    return <PeriodiseringDetalj key={periodisering} id={periodisering} tilbake={() => ga({ periodisering: null })} />;
  return (
    <>
      <div className="topp">
        <h1>Regnskap</h1>
      </div>
      <div className="faner tett" role="tablist">
        {faner.map(([v, t]) => (
          <button
            key={v}
            type="button"
            role="tab"
            aria-selected={fane === v}
            className={fane === v ? "valgt" : undefined}
            onClick={() => ga({ fane: v, anlegg: null, periodisering: null, utgift: null, post: null })}
          >
            {t}
          </button>
        ))}
      </div>
      {fane === "bilag" && <Bilag />}
      {fane === "utgifter" && <Utgifter apen={sok.get("utgift")} apne={(id) => ga({ utgift: id })} />}
      {fane === "bank" && <Bank apen={sok.get("post")} apne={(id) => ga({ post: id })} />}
      {fane === "saldobalanse" && <Saldobalansen />}
      {fane === "anlegg" && <Anleggsmidler apne={(id) => ga({ anlegg: id })} />}
      {fane === "periodiseringer" && <Periodiseringer apne={(id) => ga({ periodisering: id })} />}
      {fane === "saldo" && <Saldoavskrivninger />}
      {fane === "kontoer" && <Kontoer />}
    </>
  );
}

// --- Anleggsmidlene -----------------------------------------------------------------------------

function Anleggsmidler({ apne }: { apne: (id: string) => void }) {
  const { org } = useKonto();
  const sti = `/org/${org!.id}/regnskap`;
  const liste = useData(() => hent<{ anleggsmidler: Anlegg[] }>(`${sti}/anleggsmidler`), [sti]);
  const oppsett = useData(() => hent<Oppsett>(`${sti}/oppsett`), [sti]);
  const [ny, settNy] = useState(false);
  const [visUte, settVisUte] = useState(false);
  const smal = useSmal();

  if (liste.feil) return <Feil melding={liste.feil} />;
  if (!liste.data || !oppsett.data) return <Laster />;
  const alle = liste.data.anleggsmidler;
  const ute = alle.filter((a) => a.avgang_dato);
  const vist = visUte ? alle : alle.filter((a) => !a.avgang_dato);
  const kategori = (k: string) => oppsett.data!.kategorier.find((x) => x.kode === k)?.navn ?? k;

  return (
    <>
      <p className="dempet liten">
        Anleggsmidlene (også goodwill) avskrives lineært over levetiden ned til restverdien, og avskrivningene bokføres måned for måned (bilagserie A). En
        nedskrivning eller en ny levetid gjelder framover. Ved salg eller utrangering avskrives det til og med måneden, og gevinsten eller tapet bokføres. Rapportene
        står under <Link to="/rapporter?fane=regnskap">Rapporter → Regnskap</Link>.
      </p>
      <Maanedsavslutning bokfort={() => void liste.last()} visBokfort={alle.length > 0} />
      <div className="knapper lonn-knapper">
        <button type="button" className="primar" onClick={() => settNy(true)}>
          <IkonPluss /> Nytt anleggsmiddel
        </button>
        {ute.length > 0 && (
          <label className="liten">
            <input type="checkbox" checked={visUte} onChange={(e) => settVisUte(e.target.checked)} /> Vis solgte og utrangerte ({ute.length})
          </label>
        )}
      </div>
      {!alle.length ? (
        <div className="kort">
          <Tom ikon={<IkonRegnskap storrelse={22} />} tittel="Ingen anleggsmidler ennå">
            <p>Legg inn driftsmidler, bygninger, tomter og goodwill med kostprisen og levetiden; avskrivningsplanen regnes ut over årene.</p>
          </Tom>
        </div>
      ) : smal ? (
        <div className="kort liste">
          {vist.map((a) => (
            <button key={a.id} type="button" className="liste-rad" onClick={() => apne(a.id)}>
              <span className="linje">
                <span className="tittel">
                  {a.nummer}. {a.navn}
                </span>
                <span className="tall">{kr(a.verdi)}</span>
              </span>
              <span className="linje">
                <span className="under">
                  {[kategori(a.kategori), a.neste ? `${kr(a.neste.belop)} i ${mndNavn(a.neste.maaned).split(" ")[0]}` : null].filter(Boolean).join(" · ")}
                </span>
                {merke(a)}
              </span>
            </button>
          ))}
        </div>
      ) : (
        <div className="kort tabell">
          <table>
            <thead>
              <tr>
                <th>Nr</th>
                <th>Anleggsmiddel</th>
                <th>Anskaffet</th>
                <th className="hoyre">Kostpris</th>
                <th className="hoyre">Bokført verdi</th>
                <th className="hoyre">Neste avskrivning</th>
                <th>Levetid</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {vist.map((a) => (
                <tr key={a.id} className="klikkbar" onClick={() => apne(a.id)}>
                  <td>{a.nummer}</td>
                  <td>
                    <Link to={`?fane=anlegg&anlegg=${a.id}`} onClick={(e) => e.stopPropagation()}>
                      {a.navn}
                    </Link>
                    <span className="dempet liten"> · {kategori(a.kategori)}</span>
                  </td>
                  <td>{dato(a.anskaffet)}</td>
                  <td className="tall">{kr(a.kostpris)}</td>
                  <td className="tall">{kr(a.verdi)}</td>
                  <td className="tall">{a.neste ? `${kr(a.neste.belop)} (${mndNavn(a.neste.maaned)})` : <span className="dempet">–</span>}</td>
                  <td>{levetid(a.levetid_mnd)}</td>
                  <td>{merke(a)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={3}>Sum</td>
                <td className="tall">{kr(vist.reduce((s, a) => s + a.kostpris, 0))}</td>
                <td className="tall">{kr(vist.reduce((s, a) => s + a.verdi, 0))}</td>
                <td colSpan={3} />
              </tr>
            </tfoot>
          </table>
        </div>
      )}
      <Dialog apen={ny} lukk={() => settNy(false)} tittel="Nytt anleggsmiddel" bred>
        <AnleggSkjema
          oppsett={oppsett.data}
          lagret={(d) => {
            settNy(false);
            void liste.last();
            apne(d.anleggsmiddel.id);
          }}
          avbryt={() => settNy(false)}
        />
      </Dialog>
    </>
  );
}

// --- Skjemaet (nytt og endre) -----------------------------------------------------------------

function AnleggSkjema({ oppsett, naa, bokfort, lagret, avbryt }: { oppsett: Oppsett; naa?: Anlegg; bokfort?: boolean; lagret: (d: Detalj) => void; avbryt: () => void }) {
  const { org } = useKonto();
  const sti = `/org/${org!.id}/regnskap/anleggsmidler`;
  const kat = (k: string) => oppsett.kategorier.find((x) => x.kode === k)!;
  const start = naa?.kategori ?? "inventar";
  const [s, settS] = useState({
    navn: naa?.navn ?? "",
    beskrivelse: naa?.beskrivelse ?? "",
    kategori: start,
    anskaffet: naa?.anskaffet ?? iDag(),
    kostpris: tekstTall(naa?.kostpris),
    restverdi: naa?.restverdi ? tekstTall(naa.restverdi) : "",
    levetid: tekstTall((naa ? naa.levetid_mnd : kat(start).levetid_mnd) == null ? null : (naa ? naa.levetid_mnd! : kat(start).levetid_mnd!) / 12),
    avskrives_fra: naa ? naa.avskrives_fra.slice(0, 7) : "",
    konto: naa?.konto ?? "",
    avskrivningskonto: naa?.avskrivningskonto ?? "",
    skatt: naa?.skatt ?? kat(start).skatt,
    skatt_kostpris: tekstTall(naa?.skatt_kostpris),
    skatt_sats: tekstTall(naa?.skatt_sats),
    tidligere: !!naa?.tidligere_til,
    tidligere_til: naa?.tidligere_til?.slice(0, 7) ?? "",
    tidligere_avskrevet: naa?.tidligere_til ? tekstTall(naa.tidligere_avskrevet) : "",
    skatt_inngaende: tekstTall(naa?.skatt_inngaende),
    bokfor: !naa,
    motkonto: oppsett.kontoer.find((k) => k.rolle === "leverandorgjeld")!.konto,
    mva: "",
  });
  const [mer, settMer] = useState(!!naa && (!!naa.avskrivningskonto || !!naa.skatt_kostpris || naa.avskrives_fra.slice(0, 7) !== naa.anskaffet.slice(0, 7)));
  const h = useHandling();
  const k = kat(s.kategori);
  const tomt = s.kategori === "tomt";
  const fast = s.kategori === "goodwill" || tomt;
  const enkelt = ["b", "e", "f", "g", "h", "i", "j"].includes(s.skatt);
  const maaneder = Math.round(tall(s.levetid || "0") * 12);
  const sett = (x: Partial<typeof s>) => settS({ ...s, ...x });
  const velgKategori = (kode: string) => {
    const ny = kat(kode);
    sett({ kategori: kode, skatt: ny.skatt, levetid: naa ? s.levetid : tekstTall(ny.levetid_mnd == null ? null : ny.levetid_mnd / 12), konto: naa ? s.konto : "" });
  };
  const bank = oppsett.kontoer.find((x) => x.rolle === "bank")!.konto;
  const lev = oppsett.kontoer.find((x) => x.rolle === "leverandorgjeld")!.konto;

  async function lagre(e: FormEvent) {
    e.preventDefault();
    const kropp: Record<string, unknown> = {
      navn: s.navn,
      beskrivelse: s.beskrivelse.trim() || null,
      kategori: s.kategori,
      anskaffet: s.anskaffet,
      kostpris: tall(s.kostpris),
      restverdi: s.restverdi ? tall(s.restverdi) : 0,
      levetid_mnd: tomt ? null : maaneder || null,
      avskrives_fra: s.avskrives_fra || (naa ? s.anskaffet.slice(0, 7) : null),
      konto: s.konto.trim() || (naa && naa.kategori === s.kategori ? undefined : k.konto),
      avskrivningskonto: s.avskrivningskonto.trim() || null,
      skatt: s.skatt,
      skatt_kostpris: s.skatt_kostpris ? tall(s.skatt_kostpris) : null,
      skatt_sats: enkelt && s.skatt_sats ? tall(s.skatt_sats) : null,
      tidligere_til: s.tidligere ? s.tidligere_til || null : null,
      tidligere_avskrevet: s.tidligere && s.tidligere_avskrevet ? tall(s.tidligere_avskrevet) : 0,
      skatt_inngaende: s.tidligere && s.skatt_inngaende ? tall(s.skatt_inngaende) : null,
    };
    if (!naa) kropp.anskaffelse = s.bokfor && !s.tidligere ? { motkonto: s.motkonto, mva: s.mva ? tall(s.mva) : 0 } : null;
    if (naa && bokfort) for (const f of ["kategori", "anskaffet", "kostpris", "avskrives_fra", "konto", "tidligere_til", "tidligere_avskrevet"]) delete kropp[f];
    const r = await h.kjor(() => api<Detalj>(naa ? "PATCH" : "POST", naa ? `${sti}/${naa.id}` : sti, kropp));
    if (r) lagret(r);
  }

  return (
    <form onSubmit={lagre} className="regnskap-skjema">
      <div className="rad">
        <label>
          Navn
          <input required maxLength={120} value={s.navn} onChange={(e) => sett({ navn: e.target.value })} placeholder="F.eks. Varebil EL 12345" />
        </label>
        <label>
          Kategori
          <select value={s.kategori} disabled={bokfort} onChange={(e) => velgKategori(e.target.value)}>
            {oppsett.kategorier.map((x) => (
              <option key={x.kode} value={x.kode}>
                {x.navn}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="rad">
        <label>
          Anskaffet
          <input type="date" required disabled={bokfort} max={iDag()} value={s.anskaffet} onChange={(e) => sett({ anskaffet: e.target.value })} />
        </label>
        <label>
          Kostpris (kr, uten fradragsberettiget mva)
          <input inputMode="decimal" required disabled={bokfort} value={s.kostpris} onChange={(e) => sett({ kostpris: e.target.value })} />
          {s.kostpris && tall(s.kostpris) > 0 && tall(s.kostpris) < 30000 && (
            <span className="felt-hjelp">Under 30 000 kr: kan utgiftsføres direkte i stedet (skattemessig også når brukstiden er under tre år).</span>
          )}
        </label>
      </div>
      {!tomt && (
        <div className="rad">
          <label>
            Levetid (år)
            <input inputMode="decimal" required value={s.levetid} onChange={(e) => sett({ levetid: e.target.value })} />
            <span className="felt-hjelp">
              {maaneder > 0 ? `${maaneder} måneder. ` : ""}
              {s.kategori === "goodwill" ? "Goodwill avskrives over den forventede økonomiske levetiden." : `Forslag for kategorien: ${levetid(k.levetid_mnd)}.`}
            </span>
          </label>
          <label>
            Restverdi (kr)
            <input inputMode="decimal" placeholder="0" value={s.restverdi} onChange={(e) => sett({ restverdi: e.target.value })} />
            <span className="felt-hjelp">Det som ventes igjen ved slutten av levetiden; avskrives ikke.</span>
          </label>
        </div>
      )}
      <label>
        Beskrivelse
        <input maxLength={500} value={s.beskrivelse} onChange={(e) => sett({ beskrivelse: e.target.value })} placeholder="Valgfritt, f.eks. leverandør og fakturanummer" />
      </label>

      <h4 className="lonn-under">Skatt</h4>
      <div className="rad">
        <label>
          Saldogruppe
          <select value={s.skatt} disabled={fast} onChange={(e) => sett({ skatt: e.target.value })}>
            {oppsett.saldogrupper.map((g) => (
              <option key={g.gruppe} value={g.gruppe}>
                {g.gruppe}: {g.navn} ({g.sats} %)
              </option>
            ))}
            <option value="lineaer">Lineært (immaterielle rettigheter som taper seg i verdi)</option>
            <option value="ingen">Avskrives ikke (tomt o.l.)</option>
          </select>
          {s.kategori === "goodwill" && <span className="felt-hjelp">Kjøpt goodwill (forretningsverdi) er alltid i gruppe b, med egen saldo.</span>}
        </label>
        {enkelt && (
          <label>
            Egen sats (%)
            <input inputMode="decimal" placeholder={String(oppsett.saldogrupper.find((g) => g.gruppe === s.skatt)?.sats ?? "")} value={s.skatt_sats} onChange={(e) => sett({ skatt_sats: e.target.value })} />
            <span className="felt-hjelp">Tomt felt: den høyeste satsen. {s.skatt === "h" ? "Bygg med brukstid på 20 år eller mindre: inntil 10 %." : ""}</span>
          </label>
        )}
      </div>

      <label>
        <input type="checkbox" checked={s.tidligere} disabled={bokfort} onChange={(e) => sett({ tidligere: e.target.checked, bokfor: e.target.checked ? false : s.bokfor })} />
        Ført i et annet system før (avskrivningene fram til nå er bokført der)
      </label>
      {s.tidligere && (
        <div className="rad">
          <label>
            Avskrevet til og med
            <input type="month" required disabled={bokfort} value={s.tidligere_til} onChange={(e) => sett({ tidligere_til: e.target.value })} />
          </label>
          <label>
            Avskrevet og nedskrevet til da (kr)
            <input inputMode="decimal" disabled={bokfort} value={s.tidligere_avskrevet} onChange={(e) => sett({ tidligere_avskrevet: e.target.value })} />
          </label>
          {(enkelt || s.skatt === "lineaer") && (
            <label>
              Skattemessig saldo ved inngangen til det første året i HI4 (kr)
              <input inputMode="decimal" value={s.skatt_inngaende} onChange={(e) => sett({ skatt_inngaende: e.target.value })} />
            </label>
          )}
        </div>
      )}

      {!naa && !s.tidligere && (
        <>
          <label>
            <input type="checkbox" checked={s.bokfor} onChange={(e) => sett({ bokfor: e.target.checked })} />
            Bokfør anskaffelsen (kostprisen på {s.konto || k.konto} mot leverandørgjeld eller bank)
          </label>
          {s.bokfor && (
            <div className="rad">
              <label>
                Motkonto
                <select value={s.motkonto} onChange={(e) => sett({ motkonto: e.target.value })}>
                  <option value={lev}>{lev} Leverandørgjeld</option>
                  <option value={bank}>{bank} Bank</option>
                </select>
              </label>
              <label>
                Inngående mva (kr)
                <input inputMode="decimal" placeholder="0" value={s.mva} onChange={(e) => sett({ mva: e.target.value })} />
                <span className="felt-hjelp">Fradragsberettiget mva (ikke for personbiler).</span>
              </label>
            </div>
          )}
        </>
      )}

      <button type="button" className="lenke" onClick={() => settMer(!mer)}>
        {mer ? "Færre valg" : "Flere valg (kontoer, når avskrivningen begynner, skattemessig kostpris)"}
      </button>
      {mer && (
        <>
          <div className="rad">
            <label>
              Balansekonto
              <input inputMode="numeric" disabled={bokfort} placeholder={k.konto} value={s.konto} onChange={(e) => sett({ konto: e.target.value })} />
            </label>
            <label>
              Konto for avskrivningen
              <input inputMode="numeric" placeholder={k.avskrivningskonto ?? ""} value={s.avskrivningskonto} onChange={(e) => sett({ avskrivningskonto: e.target.value })} />
            </label>
          </div>
          <div className="rad">
            <label>
              Avskrivningen begynner (måned)
              <input type="month" disabled={bokfort} value={s.avskrives_fra} placeholder={s.anskaffet.slice(0, 7)} onChange={(e) => sett({ avskrives_fra: e.target.value })} />
              <span className="felt-hjelp">Når det ble tatt i bruk; tomt felt: anskaffelsesmåneden.</span>
            </label>
            <label>
              Skattemessig kostpris (kr)
              <input inputMode="decimal" placeholder={s.kostpris || ""} value={s.skatt_kostpris} onChange={(e) => sett({ skatt_kostpris: e.target.value })} />
              <span className="felt-hjelp">Når den er en annen enn i regnskapet.</span>
            </label>
          </div>
        </>
      )}
      {bokfort && <p className="liten dempet">Det er bokført noe for anleggsmiddelet: kategorien, datoene, kostprisen og kontoen kan ikke endres (bruk nedskrivning, eller reverser bilagene).</p>}
      <Feil melding={h.feil} />
      <div className="knapper">
        <button className="primar" disabled={h.opptatt}>
          {naa ? "Lagre" : s.bokfor && !s.tidligere ? "Legg inn og bokfør" : "Legg inn"}
        </button>
        <button type="button" onClick={avbryt}>
          Avbryt
        </button>
      </div>
    </form>
  );
}

// --- Ett anleggsmiddel --------------------------------------------------------------------------

type Handling = "endre" | "nedskriv" | "reverser" | "avgang" | "anskaffelse" | null;

function AnleggDetalj({ id, tilbake }: { id: string; tilbake: () => void }) {
  const { org } = useKonto();
  const sti = `/org/${org!.id}/regnskap`;
  const d = useData(() => hent<Detalj>(`${sti}/anleggsmidler/${id}`), [sti, id]);
  const oppsett = useData(() => hent<Oppsett>(`${sti}/oppsett`), [sti]);
  const [handling, settHandling] = useState<Handling>(null);
  const [melding, settMelding] = useState<string | null>(null);
  const h = useHandling();
  const smal = useSmal();

  const tilbakeLenke = (
    <button type="button" className="lenke tilbake" onClick={tilbake}>
      <IkonVenstre /> Anleggsmidler
    </button>
  );
  if (d.feil)
    return (
      <>
        {tilbakeLenke}
        <Feil melding={d.feil} />
      </>
    );
  if (!d.data || !oppsett.data) return <Laster />;
  const { anleggsmiddel: a, hendelser, aar, plan } = d.data;
  const gjeldende = hendelser.filter((x) => !x.reversert);
  const bokfort = gjeldende.length > 0;
  // Bare det siste bilaget kan reverseres (dato, så bilagsnummeret).
  const nr = (b: string) => Number(b.split("-")[1]) * 1e6 + Number(b.split("-")[2]);
  const siste = [...gjeldende].sort((x, y) => x.dato.localeCompare(y.dato) || nr(x.bilag) - nr(y.bilag)).at(-1) ?? null;
  const harAnskaffelse = gjeldende.some((x) => x.type === "anskaffelse");
  const kategori = oppsett.data.kategorier.find((x) => x.kode === a.kategori)?.navn ?? a.kategori;
  const ferdig = (r: Detalj & { bilag?: Bilagsvar | Bilagsvar[] }, tekst: string) => {
    settHandling(null);
    d.settData(r);
    const b = Array.isArray(r.bilag) ? r.bilag : r.bilag ? [r.bilag] : [];
    settMelding(`${tekst}${b.length ? ` (bilag ${b.map((x) => x.bilagsnummer).join(", ")})` : ""}.`);
  };
  const reverser = async (x: Hendelse) => {
    const flere = x.type === "avskrivning" ? " Bilaget har avskrivningene for måneden for alle anleggsmidlene i det, og alle reverseres." : "";
    if (!confirm(`Reversere bilag ${x.bilag}? Det føres et nytt bilag med motsatte beløp.${flere}`)) return;
    const r = await h.kjor(() => api<Bilagsvar>("POST", `${sti}/bilag/${x.bilag_id}/reverser`, {}));
    if (r) {
      settMelding(`Bilag ${x.bilag} er reversert (bilag ${r.bilagsnummer}).`);
      void d.last();
    }
  };
  const slett = async () => {
    if (!confirm(`Slette ${a.navn}?`)) return;
    if (await h.kjor(async () => (await api("DELETE", `${sti}/anleggsmidler/${a.id}`), true))) tilbake();
  };

  return (
    <>
      {tilbakeLenke}
      <div className="topp">
        <div>
          <h1 style={{ marginBottom: 4 }}>{a.navn}</h1>
          <div className="dempet liten">
            Nr. {a.nummer} · {kategori} · anskaffet {dato(a.anskaffet)} {merke(a)}
          </div>
        </div>
      </div>
      {melding && (
        <div className="melding ok" role="status">
          {melding}
        </div>
      )}
      <Feil melding={h.feil} />

      <div className="nokkeltall lonn-tall">
        <div className="kort">
          <div className="etikett">Kostpris</div>
          <div className="verdi">{kr(a.kostpris)}</div>
          <div className="under">{a.restverdi ? `Restverdi ${kr(a.restverdi)}` : a.tidligere_til ? `Avskrevet ${kr(a.tidligere_avskrevet)} før HI4` : "Uten restverdi"}</div>
        </div>
        <div className="kort">
          <div className="etikett">Bokført verdi</div>
          <div className="verdi">{kr(a.verdi)}</div>
          <div className="under">
            Avskrevet {kr(a.avskrevet)}
            {a.nedskrevet ? ` · nedskrevet ${kr(a.nedskrevet)}` : ""}
          </div>
        </div>
        <div className="kort">
          <div className="etikett">Avskrivning</div>
          <div className="verdi">{a.neste ? kr(a.neste.belop) : "–"}</div>
          <div className="under">
            {a.neste ? `Neste: ${mndNavn(a.neste.maaned)}` : a.levetid_mnd ? "Ingenting igjen å avskrive" : "Avskrives ikke"}
            {a.bokfort_til ? ` · bokført til og med ${mndNavn(a.bokfort_til)}` : ""}
          </div>
        </div>
        <div className="kort">
          <div className="etikett">Levetid</div>
          <div className="verdi">{levetid(a.levetid_mnd)}</div>
          <div className="under">
            {a.slutt ? `Fra ${mndNavn(a.avskrives_fra.slice(0, 7))} til og med ${mndNavn(a.slutt)}` : ""} · skatt: {skattNavn(a.skatt)}
            {a.skatt_sats != null ? ` (${tekstTall(a.skatt_sats)} %)` : ""}
          </div>
        </div>
      </div>

      {!a.avgang_dato && (
        <div className="knapper lonn-knapper">
          <button type="button" onClick={() => settHandling("endre")}>
            Endre
          </button>
          <button type="button" onClick={() => settHandling("nedskriv")}>
            Nedskriv
          </button>
          {d.data.kan_reversere && (
            <button type="button" onClick={() => settHandling("reverser")}>
              Reverser nedskrivning
            </button>
          )}
          <button type="button" onClick={() => settHandling("avgang")}>
            Selg eller utranger
          </button>
          {!harAnskaffelse && !a.tidligere_til && (
            <button type="button" onClick={() => settHandling("anskaffelse")}>
              Bokfør anskaffelsen
            </button>
          )}
          {!bokfort && (
            <button type="button" className="fare" disabled={h.opptatt} onClick={() => void slett()}>
              Slett
            </button>
          )}
        </div>
      )}

      {aar.length > 0 && (
        <>
          <h3 className="lonn-under">Avskrivningsplan per år</h3>
          <div className="kort tabell">
            <table>
              <thead>
                <tr>
                  <th>År</th>
                  <th className="hoyre">Verdi 1.1.</th>
                  <th className="hoyre">Avskrivning</th>
                  {aar.some((x) => x.nedskrivning) && <th className="hoyre">Nedskrivning</th>}
                  {aar.some((x) => x.avgang) && <th className="hoyre">Avgang</th>}
                  <th className="hoyre">Verdi 31.12.</th>
                  {!smal && <th />}
                </tr>
              </thead>
              <tbody>
                {aar.map((x) => (
                  <tr key={x.aar}>
                    <td>{x.aar}</td>
                    <td className="tall">{kr(x.inngaende)}</td>
                    <td className="tall">{kr(x.avskrivning)}</td>
                    {aar.some((y) => y.nedskrivning) && <td className="tall">{x.nedskrivning ? kr(x.nedskrivning) : ""}</td>}
                    {aar.some((y) => y.avgang) && <td className="tall">{x.avgang ? kr(x.avgang) : ""}</td>}
                    <td className="tall">{kr(x.utgaende)}</td>
                    {!smal && <td>{x.bokfort ? <span className="merke merke-ok">Bokført</span> : <span className="dempet liten">Plan</span>}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <h3 className="lonn-under">Bokført</h3>
      {!hendelser.length ? (
        <p className="dempet liten">Ingenting er bokført for anleggsmiddelet ennå.</p>
      ) : (
        <div className="kort liste">
          {[...hendelser].reverse().map((x) => (
            <div key={x.id} className={`liste-rad${x.reversert ? " dempet" : ""}`}>
              <span className="linje">
                <span className="tittel">
                  {x.type === "avskrivning" && x.maaned ? `Avskrivning ${mndNavn(x.maaned)}` : x.type === "avgang" ? (a.avgang_type === "utrangering" ? "Utrangering" : "Salg") : HENDELSE[x.type]}
                  {x.tekst ? <span className="dempet liten"> · {x.tekst}</span> : null}
                </span>
                <span className="tall">{x.type === "avgang" ? (x.vederlag ? `Salgssum ${kr(x.vederlag)}` : kr(x.belop)) : kr(x.belop)}</span>
              </span>
              <span className="linje">
                <span className="under">
                  {dato(x.dato)} · bilag {x.bilag}
                  {x.reversert ? " · reversert" : ""}
                </span>
                {!x.reversert && x.bilag_id === siste?.bilag_id && (
                  <button type="button" className="lenke" disabled={h.opptatt} onClick={() => void reverser(x)}>
                    Reverser
                  </button>
                )}
              </span>
            </div>
          ))}
        </div>
      )}

      {plan.length > 0 && (
        <details className="regnskap-maaneder">
          <summary>Måned for måned ({plan.length} måneder)</summary>
          <div className="tabell">
            <table>
              <thead>
                <tr>
                  <th>Måned</th>
                  <th className="hoyre">Avskrivning</th>
                  <th className="hoyre">Verdi etter</th>
                  <th>Bilag</th>
                </tr>
              </thead>
              <tbody>
                {plan.map((p) => (
                  <tr key={p.maaned}>
                    <td>{mndNavn(p.maaned)}</td>
                    <td className="tall">{kr(p.belop)}</td>
                    <td className="tall">{kr(p.verdi)}</td>
                    <td>{p.bilag ?? <span className="dempet liten">Plan</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}

      <Dialog apen={handling === "endre"} lukk={() => settHandling(null)} tittel={`Endre ${a.navn}`} bred>
        <AnleggSkjema oppsett={oppsett.data} naa={a} bokfort={bokfort} lagret={(r) => ferdig(r, "Lagret")} avbryt={() => settHandling(null)} />
      </Dialog>
      <Dialog apen={handling === "nedskriv" || handling === "reverser"} lukk={() => settHandling(null)} tittel={handling === "reverser" ? "Reverser nedskrivning" : "Nedskriv"}>
        <Nedskrivning
          a={a}
          reverser={handling === "reverser"}
          ferdig={(r) => ferdig(r, handling === "reverser" ? "Nedskrivningen er reversert" : "Nedskrivningen er bokført")}
          avbryt={() => settHandling(null)}
        />
      </Dialog>
      <Dialog apen={handling === "avgang"} lukk={() => settHandling(null)} tittel="Selg eller utranger">
        <Avgang a={a} plan={plan} oppsett={oppsett.data} ferdig={(r) => ferdig(r, "Avgangen er bokført")} avbryt={() => settHandling(null)} />
      </Dialog>
      <Dialog apen={handling === "anskaffelse"} lukk={() => settHandling(null)} tittel="Bokfør anskaffelsen">
        <Anskaffelse a={a} oppsett={oppsett.data} ferdig={(r) => ferdig(r, "Anskaffelsen er bokført")} avbryt={() => settHandling(null)} />
      </Dialog>
    </>
  );
}

function Skjemaknapper({ h, tekst, avbryt }: { h: ReturnType<typeof useHandling>; tekst: string; avbryt: () => void }) {
  return (
    <>
      <Feil melding={h.feil} />
      <div className="knapper">
        <button className="primar" disabled={h.opptatt}>
          {tekst}
        </button>
        <button type="button" onClick={avbryt}>
          Avbryt
        </button>
      </div>
    </>
  );
}

function Nedskrivning({ a, reverser, ferdig, avbryt }: { a: Anlegg; reverser: boolean; ferdig: (r: Detalj) => void; avbryt: () => void }) {
  const { org } = useKonto();
  const [s, settS] = useState({ dato: iDag(), belop: "", tekst: "" });
  const h = useHandling();
  async function lagre(e: FormEvent) {
    e.preventDefault();
    const r = await h.kjor(() =>
      api<Detalj>("POST", `/org/${org!.id}/regnskap/anleggsmidler/${a.id}/nedskrivning`, { dato: s.dato, belop: tall(s.belop), tekst: s.tekst.trim() || null, reverser }),
    );
    if (r) ferdig(r);
  }
  return (
    <form onSubmit={lagre}>
      <p className="dempet liten">
        {reverser
          ? "Reverseringen gjelder når grunnlaget for nedskrivningen ikke lenger er til stede, og verdien kan ikke bli høyere enn etter planen uten nedskrivning. Avskrivningene framover regnes av den nye verdien."
          : `Ned til virkelig verdi ved et verdifall som ikke er forbigående (bokført verdi nå ${kr(a.verdi)}). Avskrivningene framover regnes av den nye verdien over levetiden som er igjen.${a.kategori === "goodwill" ? " En nedskrivning av goodwill kan ikke reverseres." : ""}`}
      </p>
      <div className="rad">
        <label>
          Dato
          <input type="date" required max={iDag()} value={s.dato} onChange={(e) => settS({ ...s, dato: e.target.value })} />
        </label>
        <label>
          Beløp (kr)
          <input inputMode="decimal" required value={s.belop} onChange={(e) => settS({ ...s, belop: e.target.value })} />
        </label>
      </div>
      <label>
        Grunn
        <input maxLength={300} value={s.tekst} onChange={(e) => settS({ ...s, tekst: e.target.value })} placeholder={reverser ? "F.eks. markedsverdien har tatt seg opp" : "F.eks. skadet, lavere markedsverdi"} />
      </label>
      <Skjemaknapper h={h} tekst={reverser ? "Reverser og bokfør" : "Nedskriv og bokfør"} avbryt={avbryt} />
    </form>
  );
}

function Avgang({ a, plan, oppsett, ferdig, avbryt }: { a: Anlegg; plan: Planmaaned[]; oppsett: Oppsett; ferdig: (r: Detalj) => void; avbryt: () => void }) {
  const { org } = useKonto();
  const konto = (r: string) => oppsett.kontoer.find((k) => k.rolle === r)!.konto;
  const [s, settS] = useState({ type: "salg" as "salg" | "utrangering", dato: iDag(), vederlag: "", mva: "", motkonto: konto("bank"), tekst: "" });
  const h = useHandling();
  const m = s.dato.slice(0, 7);
  // Verdien etter avskrivningene til og med måneden (etter planen).
  const etter = [...plan].reverse().find((p) => p.maaned <= m);
  const verdi = etter ? etter.verdi : a.verdi;
  const vederlag = s.type === "salg" && s.vederlag ? tall(s.vederlag) : 0;
  const diff = Math.round((vederlag - verdi) * 100) / 100;
  const ikkeBokfort = plan.filter((p) => !p.bokfort && p.maaned <= m && p.belop > 0).length;
  async function lagre(e: FormEvent) {
    e.preventDefault();
    const r = await h.kjor(() =>
      api<Detalj>("POST", `/org/${org!.id}/regnskap/anleggsmidler/${a.id}/avgang`, {
        dato: s.dato,
        type: s.type,
        vederlag: s.type === "salg" ? tall(s.vederlag) : undefined,
        mva: s.type === "salg" && s.mva ? tall(s.mva) : 0,
        motkonto: s.motkonto,
        tekst: s.tekst.trim() || null,
      }),
    );
    if (r) ferdig(r);
  }
  return (
    <form onSubmit={lagre}>
      <div className="valg" role="radiogroup">
        {(["salg", "utrangering"] as const).map((t) => (
          <label key={t}>
            <input type="radio" checked={s.type === t} onChange={() => settS({ ...s, type: t })} /> {t === "salg" ? "Salg" : "Utrangering (kassert, ødelagt eller gitt bort)"}
          </label>
        ))}
      </div>
      <div className="rad">
        <label>
          Dato
          <input type="date" required min={a.anskaffet} max={iDag()} value={s.dato} onChange={(e) => settS({ ...s, dato: e.target.value })} />
        </label>
        {s.type === "salg" && (
          <label>
            Salgssum uten mva (kr)
            <input inputMode="decimal" required value={s.vederlag} onChange={(e) => settS({ ...s, vederlag: e.target.value })} />
          </label>
        )}
      </div>
      {s.type === "salg" && (
        <div className="rad">
          <label>
            Utgående mva (kr)
            <input inputMode="decimal" placeholder="0" value={s.mva} onChange={(e) => settS({ ...s, mva: e.target.value })} />
            <span className="felt-hjelp">Når salget er mva-pliktig (som oftest 25 %).</span>
          </label>
          <label>
            Betalt til
            <select value={s.motkonto} onChange={(e) => settS({ ...s, motkonto: e.target.value })}>
              <option value={konto("bank")}>{konto("bank")} Bank</option>
              <option value={konto("kundefordringer")}>{konto("kundefordringer")} Kundefordringer (fakturert)</option>
            </select>
          </label>
        </div>
      )}
      <label>
        Tekst
        <input maxLength={300} value={s.tekst} onChange={(e) => settS({ ...s, tekst: e.target.value })} placeholder="Valgfritt, f.eks. kjøperen" />
      </label>
      <p className="liten">
        {ikkeBokfort > 0 && `Avskrivningene til og med ${mndNavn(m)} bokføres først (${ikkeBokfort} ${ikkeBokfort === 1 ? "måned" : "måneder"}). `}
        Bokført verdi som går ut: <strong>{kr(verdi)}</strong>.{" "}
        {diff > 0 ? `Gevinst: ${kr(diff)}.` : diff < 0 ? `Tap: ${kr(-diff)}.` : ""}
      </p>
      <Skjemaknapper h={h} tekst={s.type === "salg" ? "Selg og bokfør" : "Utranger og bokfør"} avbryt={avbryt} />
    </form>
  );
}

function Anskaffelse({ a, oppsett, ferdig, avbryt }: { a: Anlegg; oppsett: Oppsett; ferdig: (r: Detalj) => void; avbryt: () => void }) {
  const { org } = useKonto();
  const konto = (r: string) => oppsett.kontoer.find((k) => k.rolle === r)!.konto;
  const [s, settS] = useState({ motkonto: konto("leverandorgjeld"), mva: "" });
  const h = useHandling();
  async function lagre(e: FormEvent) {
    e.preventDefault();
    const r = await h.kjor(() => api<Detalj>("POST", `/org/${org!.id}/regnskap/anleggsmidler/${a.id}/anskaffelse`, { motkonto: s.motkonto, mva: s.mva ? tall(s.mva) : 0 }));
    if (r) ferdig(r);
  }
  return (
    <form onSubmit={lagre}>
      <p className="dempet liten">
        Kostprisen {kr(a.kostpris)} føres på {a.konto} den {dato(a.anskaffet)}, mot leverandørgjelden eller banken.
      </p>
      <div className="rad">
        <label>
          Motkonto
          <select value={s.motkonto} onChange={(e) => settS({ ...s, motkonto: e.target.value })}>
            <option value={konto("leverandorgjeld")}>{konto("leverandorgjeld")} Leverandørgjeld</option>
            <option value={konto("bank")}>{konto("bank")} Bank</option>
          </select>
        </label>
        <label>
          Inngående mva (kr)
          <input inputMode="decimal" placeholder="0" value={s.mva} onChange={(e) => settS({ ...s, mva: e.target.value })} />
        </label>
      </div>
      <Skjemaknapper h={h} tekst="Bokfør" avbryt={avbryt} />
    </form>
  );
}

// --- Saldoavskrivningene ---------------------------------------------------------------------

type Saldorad = {
  type: "samlet" | "enkelt" | "lineaer" | "ingen" | "gevinst_tap";
  gruppe: string | null;
  anleggsmiddel_id: string | null;
  navn: string;
  inngaende: number;
  tilgang: number;
  vederlag: number;
  grunnlag: number;
  sats: number | null;
  avskrivning: number;
  gevinst_tap: number;
  utgaende: number;
  regnskap: number | null;
  forskjell: number | null;
  merknad: string;
};
type Saldosvar = {
  aar: number;
  fra_aar: number;
  rader: Saldorad[];
  sum: { avskrivning: number; inntekt: number; gevinst_tap: number };
  satser: { gruppe: string; navn: string; maks: number; sats: number }[];
  oppsett: { saldo_fra_aar: number | null; saldo_inngaende: Partial<Record<string, number>> };
};

function Saldoavskrivninger() {
  const { org } = useKonto();
  const sti = `/org/${org!.id}/regnskap`;
  const [aar, settAar] = useState(Number(iDag().slice(0, 4)));
  const s = useData(() => hent<Saldosvar>(`${sti}/saldo?aar=${aar}`), [sti, aar]);
  const [satser, settSatser] = useState<Record<string, string> | null>(null);
  const [start, settStart] = useState<Record<string, string> | null>(null);
  const h = useHandling();
  const [melding, settMelding] = useState<string | null>(null);
  const smal = useSmal();

  if (s.feil) return <Feil melding={s.feil} />;
  if (!s.data) return <Laster />;
  const d = s.data;
  const grupper = [...new Set(d.rader.map((r) => r.gruppe).filter((g): g is string => !!g))].sort();

  async function lagreSatser(e: FormEvent) {
    e.preventDefault();
    const r = await h.kjor(() =>
      api<Saldosvar>("PUT", `${sti}/saldo/${aar}`, { satser: Object.fromEntries(Object.entries(satser!).map(([g, v]) => [g, v.trim() ? tall(v) : null])) }),
    );
    if (r) {
      s.settData(r);
      settSatser(null);
      settMelding(`Satsene for ${aar} er lagret.`);
    }
  }
  async function lagreStart(e: FormEvent) {
    e.preventDefault();
    const st = start!;
    const r = await h.kjor(() =>
      api("PUT", `${sti}/oppsett`, {
        saldo_fra_aar: st.fra.trim() ? Number(st.fra) : null,
        saldo_inngaende: Object.fromEntries(["a", "c", "d", "gevinst_tap"].map((g) => [g, st[g]!.trim() ? tall(st[g]!) : null])),
      }),
    );
    if (r) {
      settStart(null);
      settMelding("Startverdiene er lagret.");
      void s.last();
    }
  }

  return (
    <>
      <p className="dempet liten">
        De skattemessige avskrivningene (skatteloven kapittel 14) regnet fra anleggsregisteret: samlesaldo for gruppe a, c og d, egen saldo for goodwill (b) og
        gruppe e–j, lineært for immaterielle rettigheter, og gevinst- og tapskontoen. Kontroller satsene og saldoene mot skattemeldingen; tallene er grunnlaget for
        saldoskjemaet i næringsspesifikasjonen.
      </p>
      <div className="knapper lonn-knapper">
        <label>
          År{" "}
          <select value={aar} onChange={(e) => settAar(Number(e.target.value))}>
            {[0, 1, 2, 3].map((i) => {
              const a = Number(iDag().slice(0, 4)) - i;
              return (
                <option key={a} value={a}>
                  {a}
                </option>
              );
            })}
          </select>
        </label>
        <Link to={`/rapporter?fane=regnskap&rapport=regnskap.saldoskjema`} className="knapp">
          Saldoskjema (CSV og PDF)
        </Link>
      </div>
      {melding && (
        <div className="melding ok" role="status">
          {melding}
        </div>
      )}
      {aar < d.fra_aar ? (
        <div className="kort">
          <Tom tittel={`Saldoene regnes fra ${d.fra_aar}`} />
        </div>
      ) : !d.rader.length ? (
        <div className="kort">
          <Tom ikon={<IkonRegnskap storrelse={22} />} tittel={`Ingen saldoer i ${aar}`}>
            <p>Saldoene kommer fra anleggsmidlene og startverdiene under.</p>
          </Tom>
        </div>
      ) : (
        <div className="kort tabell">
          <table>
            <thead>
              <tr>
                <th>Saldo</th>
                <th className="hoyre">Inngående</th>
                {!smal && <th className="hoyre">Tilgang</th>}
                {!smal && <th className="hoyre">Vederlag</th>}
                <th className="hoyre">Sats</th>
                <th className="hoyre">Avskrivning</th>
                <th className="hoyre">Utgående</th>
                {!smal && <th className="hoyre">Regnskap</th>}
              </tr>
            </thead>
            <tbody>
              {d.rader.map((r, i) => (
                <tr key={i}>
                  <td>
                    {r.navn}
                    {r.merknad && <div className="liten dempet">{r.merknad}</div>}
                  </td>
                  <td className="tall">{kr(r.inngaende)}</td>
                  {!smal && <td className="tall">{r.tilgang ? kr(r.tilgang) : ""}</td>}
                  {!smal && <td className="tall">{r.vederlag ? kr(r.vederlag) : r.gevinst_tap ? `${r.gevinst_tap > 0 ? "Gevinst" : "Tap"} ${kr(Math.abs(r.gevinst_tap))}` : ""}</td>}
                  <td className="tall">{r.sats != null ? `${tekstTall(r.sats)} %` : ""}</td>
                  <td className="tall">{r.avskrivning < 0 ? `(${kr(-r.avskrivning)})` : kr(r.avskrivning)}</td>
                  <td className="tall">{kr(r.utgaende)}</td>
                  {!smal && <td className="tall">{r.regnskap != null ? kr(r.regnskap) : ""}</td>}
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={smal ? 3 : 5}>Fradrag {kr(d.sum.avskrivning)} · inntektsført {kr(d.sum.inntekt)}</td>
                <td className="tall">{kr(d.sum.avskrivning - d.sum.inntekt)}</td>
                <td colSpan={smal ? 1 : 2} />
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {grupper.length > 0 && aar >= d.fra_aar && (
        <form className="kort" onSubmit={lagreSatser}>
          <h3 style={{ marginTop: 0 }}>Satsene for {aar}</h3>
          <p className="liten dempet">Satsen kan settes lavere enn den høyeste for et år (for driftsmidler med egen saldo også på anleggsmiddelet).</p>
          {!satser ? (
            <>
              <p className="liten">{d.satser.filter((x) => grupper.includes(x.gruppe)).map((x) => `Gruppe ${x.gruppe}: ${tekstTall(x.sats)} %${x.sats !== x.maks ? ` (høyst ${x.maks} %)` : ""}`).join(" · ")}</p>
              <button type="button" onClick={() => settSatser(Object.fromEntries(d.satser.filter((x) => grupper.includes(x.gruppe)).map((x) => [x.gruppe, x.sats === x.maks ? "" : tekstTall(x.sats)])))}>
                Endre satsene
              </button>
            </>
          ) : (
            <>
              <div className="bokforing-kontoer">
                {d.satser
                  .filter((x) => grupper.includes(x.gruppe))
                  .map((x) => (
                    <label key={x.gruppe}>
                      Gruppe {x.gruppe} (høyst {x.maks} %)
                      <input inputMode="decimal" placeholder={String(x.maks)} value={satser[x.gruppe] ?? ""} onChange={(e) => settSatser({ ...satser, [x.gruppe]: e.target.value })} />
                    </label>
                  ))}
              </div>
              <Skjemaknapper h={h} tekst="Lagre satsene" avbryt={() => settSatser(null)} />
            </>
          )}
        </form>
      )}

      <form className="kort" onSubmit={lagreStart}>
        <h3 style={{ marginTop: 0 }}>Startverdier</h3>
        <p className="liten dempet">
          Det første året saldoene regnes i HI4 ({d.oppsett.saldo_fra_aar ?? `nå ${d.fra_aar}, regnet fra anleggsmidlene`}), og saldoene ved inngangen til det året fra
          skattemeldingen (samlesaldoene og gevinst- og tapskontoen). Driftsmidler med egen saldo har inngående saldo på anleggsmiddelet.
        </p>
        {!start ? (
          <button
            type="button"
            onClick={() =>
              settStart({
                fra: d.oppsett.saldo_fra_aar ? String(d.oppsett.saldo_fra_aar) : "",
                ...Object.fromEntries(["a", "c", "d", "gevinst_tap"].map((g) => [g, tekstTall(d.oppsett.saldo_inngaende[g])])),
              })
            }
          >
            Endre startverdiene
          </button>
        ) : (
          <>
            <div className="bokforing-kontoer">
              <label>
                Første år i HI4
                <input inputMode="numeric" placeholder={String(d.fra_aar)} value={start.fra} onChange={(e) => settStart({ ...start, fra: e.target.value })} />
              </label>
              {(["a", "c", "d"] as const).map((g) => (
                <label key={g}>
                  Inngående saldo gruppe {g} (kr)
                  <input inputMode="decimal" value={start[g] ?? ""} onChange={(e) => settStart({ ...start, [g]: e.target.value })} />
                </label>
              ))}
              <label>
                Gevinst- og tapskonto (kr)
                <input inputMode="decimal" value={start.gevinst_tap ?? ""} onChange={(e) => settStart({ ...start, gevinst_tap: e.target.value })} />
                <span className="felt-hjelp">Negativ når saldoen er et tap.</span>
              </label>
            </div>
            <Skjemaknapper h={h} tekst="Lagre startverdiene" avbryt={() => settStart(null)} />
          </>
        )}
      </form>
    </>
  );
}

// --- Kontoene ----------------------------------------------------------------------------------

// Fakturaene og innbetalingene i regnskapet (server/src/salgBokforing.ts): fra hvilken dato de
// bokføres, og om salg uten mva er utenfor merverdiavgiftsloven eller fritatt.
function Salget({ o, lagret }: { o: Oppsett; lagret: (o: Oppsett) => void }) {
  const { org } = useKonto();
  const sti = `/org/${org!.id}/regnskap/oppsett`;
  const [skjema, settSkjema] = useState<{ fra: string; uten: Oppsett["uten_mva"] } | null>(null);
  const [ok, settOk] = useState(false);
  const h = useHandling();
  const v = skjema ?? { fra: o.salg_fra ?? "", uten: o.uten_mva };
  const kundefordringer = o.kontoer.find((k) => k.rolle === "kundefordringer")?.konto ?? "1500";

  async function lagre(e: FormEvent) {
    e.preventDefault();
    settOk(false);
    const r = await h.kjor(() => api<Oppsett>("PUT", sti, { salg_fra: v.fra || null, uten_mva: v.uten }));
    if (r) {
      lagret(r);
      settSkjema(null);
      settOk(true);
    }
  }

  return (
    <form className="kort" onSubmit={lagre}>
      <h3 style={{ marginTop: 0 }}>Fakturaene og innbetalingene</h3>
      <p className="liten dempet">
        Fakturaene, kreditnotaene og innbetalingene bokføres av seg selv, hvert minutt og når regnskapet vises. Hver faktura og kreditnota får et bilag i serie F:
        kundefordringen mot salget og den utgående avgiften per sats, med mva-kodene fra Skatteetaten. Hver innbetaling og refusjon får et bilag i serie B: banken
        mot kundefordringen, og purregebyret når det er betalt. En faktura rettes med en kreditnota, og en betaling som tas bort, blir reversert.
      </p>
      <div className="rad">
        <label>
          Bokfør fra og med
          <input type="date" value={v.fra} onChange={(e) => settSkjema({ ...v, fra: e.target.value })} />
          <span className="felt-hjelp">Tomt felt: alle. Det som er fra før, hører til den inngående balansen.</span>
        </label>
        <label>
          Salg uten mva (0 %)
          <select value={v.uten} onChange={(e) => settSkjema({ ...v, uten: e.target.value as Oppsett["uten_mva"] })}>
            <option value="unntatt">Utenfor mva-loven, f.eks. helsetjenester (3200, kode 6)</option>
            <option value="fritatt">Fritatt for mva, f.eks. bøker og aviser (3100, kode 5)</option>
          </select>
          <span className="felt-hjelp">Uten mva-registrering føres alt salg på 3200, uten mva-kode.</span>
        </label>
      </div>
      {o.salg_fra && o.kundefordringer_ved_start !== null && (
        <p className="liten salg-start">
          Kundefordringene ved {dato(o.salg_fra)}: <strong>{kr(o.kundefordringer_ved_start)}</strong> (fakturaene før datoen minus det som er betalt før den). Før
          dem i den inngående balansen, på konto {kundefordringer}; det som betales etter datoen, bokføres mot dem.
        </p>
      )}
      <p className="liten dempet">Flyttes datoen fram, reverseres bilagene før den; flyttes den tilbake, bokføres de på nytt.</p>
      <Feil melding={h.feil} />
      {ok && (
        <div className="melding ok" role="status">
          Lagret.
        </div>
      )}
      <div className="knapper">
        <button className="primar" disabled={h.opptatt || !skjema}>
          Lagre
        </button>
      </div>
    </form>
  );
}

// Utgiftene (server/src/utgifter.ts): fradraget for inngående mva, grensen for å periodisere, og om
// utgiftene fra kjente leverandører bokføres av seg selv.
function Utgiftsoppsett({ o, lagret }: { o: Oppsett; lagret: (o: Oppsett) => void }) {
  const { org } = useKonto();
  const sti = `/org/${org!.id}/regnskap/oppsett`;
  const [skjema, settSkjema] = useState<{ fradrag: string; grense: string; auto: boolean } | null>(null);
  const [ok, settOk] = useState(false);
  const h = useHandling();
  const v = skjema ?? { fradrag: o.mva_fradrag == null ? "" : String(o.mva_fradrag).replace(".", ","), grense: String(o.periodiser_fra).replace(".", ","), auto: o.utgifter_auto };

  async function lagre(e: FormEvent) {
    e.preventDefault();
    settOk(false);
    const r = await h.kjor(() =>
      api<Oppsett>("PUT", sti, { mva_fradrag: v.fradrag.trim() ? tall(v.fradrag) : null, periodiser_fra: v.grense.trim() ? tall(v.grense) : 0, utgifter_auto: v.auto }),
    );
    if (r) {
      lagret(r);
      settSkjema(null);
      settOk(true);
    }
  }

  return (
    <form className="kort" onSubmit={lagre}>
      <h3 style={{ marginTop: 0 }}>Utgiftene</h3>
      <p className="liten dempet">
        Leverandørfakturaer og kvitteringer under Regnskap → Utgifter. Fradraget for inngående mva gjelder det meste; representasjon og gaver får ikke fradrag. Den som
        bare har salg utenfor merverdiavgiftsloven (f.eks. helsetjenester), har ikke fradrag; med salg både innenfor og utenfor er fradraget for fellesanskaffelser
        forholdsmessig.
      </p>
      <div className="rad">
        <label>
          Fradrag for inngående mva (%)
          <input inputMode="decimal" placeholder="Fullt når mva-registrert" value={v.fradrag} onChange={(e) => settSkjema({ ...v, fradrag: e.target.value })} />
          <span className="felt-hjelp">Tomt felt: 100 % for den som er mva-registrert, ellers 0.</span>
        </label>
        <label>
          Periodiser fra (kr uten mva)
          <input inputMode="decimal" value={v.grense} onChange={(e) => settSkjema({ ...v, grense: e.target.value })} />
          <span className="felt-hjelp">En utgift for flere måneder fordeles på månedene når den er på minst så mye.</span>
        </label>
      </div>
      <label className="avkrysning">
        <input type="checkbox" checked={v.auto} onChange={(e) => settSkjema({ ...v, auto: e.target.checked })} /> Bokfør av seg selv fra leverandører som er godkjent før,
        når alt stemmer
      </label>
      <Feil melding={h.feil} />
      {ok && (
        <div className="melding ok" role="status">
          Lagret.
        </div>
      )}
      <div className="knapper">
        <button className="primar" disabled={h.opptatt || !skjema}>
          Lagre
        </button>
      </div>
    </form>
  );
}

// Banken (server/src/bankAvstemming.ts): startdatoen for bankpostene i regnskapet, om reglene fører
// dem av seg selv, kontoen i regnskapet for hver bankkonto, og reglene som er lært.
type Bankregel = { id: string; retning: "inn" | "ut"; motpart_konto: string | null; motpart: string | null; konto: string; tekst: string | null };
function Bankoppsett({ o, lagret }: { o: Oppsett; lagret: (o: Oppsett) => void }) {
  const { org } = useKonto();
  const sti = `/org/${org!.id}/regnskap`;
  const bank = useData(() => hent<Bankoversikt>(`${sti}/bank`), [sti]);
  const regler = useData(() => hent<Bankregel[]>(`${sti}/bank/regler`), [sti]);
  const [skjema, settSkjema] = useState<{ fra: string; auto: boolean; kontoer: Record<string, string> } | null>(null);
  const [ok, settOk] = useState(false);
  const h = useHandling();
  const v = skjema ?? { fra: o.bank_fra ?? "", auto: o.bank_auto, kontoer: { ...o.bankkontoer } };
  const kontoer = [...new Set([...(bank.data?.kontoer.map((k) => k.konto) ?? []), ...Object.keys(o.bankkontoer)])];
  const navn = (nr: string) => bank.data?.kontoer.find((k) => k.konto === nr)?.navn;

  async function lagre(e: FormEvent) {
    e.preventDefault();
    settOk(false);
    const r = await h.kjor(() =>
      api<Oppsett>("PUT", `${sti}/oppsett`, {
        bank_fra: v.fra || null,
        bank_auto: v.auto,
        bankkontoer: Object.fromEntries(kontoer.map((k) => [k, v.kontoer[k]?.trim() || null])),
      }),
    );
    if (r) {
      lagret(r);
      settSkjema(null);
      settOk(true);
      void bank.last();
    }
  }
  async function slett(id: string) {
    if (await h.kjor(() => api("DELETE", `${sti}/bank/regler/${id}`))) void regler.last();
  }

  return (
    <form className="kort" onSubmit={lagre}>
      <h3 style={{ marginTop: 0 }}>Banken</h3>
      <p className="liten dempet">
        Transaksjonene fra banken (Regnskap → Bank) føres i regnskapet fra og med startdatoen; det som er fra før, hører til den inngående balansen. Banken sender
        høyst 89 dager tilbake uten BankID. Flyttes datoen fram, angres det som er ført før den.
      </p>
      <div className="rad">
        <label>
          Bankpostene føres fra og med
          <input type="date" max={iDag()} value={v.fra} onChange={(e) => settSkjema({ ...v, fra: e.target.value })} />
          <span className="felt-hjelp">Tomt felt: alt som er hentet.</span>
        </label>
      </div>
      <label className="avkrysning">
        <input type="checkbox" checked={v.auto} onChange={(e) => settSkjema({ ...v, auto: e.target.checked })} /> Før bankpostene av seg selv når reglene er sikre
        (ellers bare forslag)
      </label>
      {kontoer.length > 0 && (
        <>
          <h4>Kontoen i regnskapet for hver bankkonto</h4>
          <div className="rad">
            {kontoer.map((k) => (
              <label key={k}>
                {navn(k) ? `${navn(k)} ` : ""}
                {visKonto(k)}
                <input
                  inputMode="numeric"
                  placeholder={o.kontoer.find((x) => x.rolle === "bank")?.konto ?? "1920"}
                  value={v.kontoer[k] ?? ""}
                  onChange={(e) => settSkjema({ ...v, kontoer: { ...v.kontoer, [k]: e.target.value } })}
                />
              </label>
            ))}
          </div>
          <p className="liten dempet">Tomt felt: bankkontoen i kontoplanen. Gjelder bilagene som føres etterpå.</p>
        </>
      )}
      <Feil melding={h.feil} />
      {ok && (
        <div className="melding ok" role="status">
          Lagret.
        </div>
      )}
      <div className="knapper">
        <button className="primar" disabled={h.opptatt || !skjema}>
          Lagre
        </button>
      </div>
      {!!regler.data?.length && (
        <>
          <h4>Det reglene har lært</h4>
          <div className="kort liste">
            {regler.data.map((r) => (
              <div key={r.id} className="liste-rad">
                <span className="linje">
                  <span className="tittel">
                    {r.retning === "ut" ? "Til" : "Fra"} {r.motpart ?? visKonto(r.motpart_konto)} → {r.konto}
                  </span>
                  <button type="button" className="lenke" disabled={h.opptatt} onClick={() => void slett(r.id)}>
                    Slett
                  </button>
                </span>
                {r.tekst && <span className="under">{r.tekst}</span>}
              </div>
            ))}
          </div>
        </>
      )}
    </form>
  );
}

function Kontoer() {
  const { org } = useKonto();
  const sti = `/org/${org!.id}/regnskap/oppsett`;
  const o = useData(() => hent<Oppsett>(sti), [sti]);
  const [skjema, settSkjema] = useState<Record<string, string> | null>(null);
  const [lagret, settLagret] = useState(false);
  const h = useHandling();
  if (o.feil) return <Feil melding={o.feil} />;
  if (!o.data) return <Laster />;
  const verdier = skjema ?? Object.fromEntries(o.data.kontoer.map((k) => [k.rolle, k.endret ? k.konto : ""]));

  async function lagre(e: FormEvent) {
    e.preventDefault();
    settLagret(false);
    const r = await h.kjor(() => api<Oppsett>("PUT", sti, { kontoer: Object.fromEntries(Object.entries(verdier).map(([k, v]) => [k, v.trim() || null])) }));
    if (r) {
      o.settData(r);
      settSkjema(null);
      settLagret(true);
    }
  }
  const rad = (navn: ReactNode, konto: string) => (
    <tr key={konto + String(navn)}>
      <td>{navn}</td>
      <td className="tall">{konto}</td>
    </tr>
  );

  return (
    <>
      <Salget o={o.data} lagret={(r) => o.settData(r)} />
      <Utgiftsoppsett o={o.data} lagret={(r) => o.settData(r)} />
      <Bankoppsett o={o.data} lagret={(r) => o.settData(r)} />
      <form className="kort" onSubmit={lagre}>
        <h3 style={{ marginTop: 0 }}>Kontoene for salget, utgiftene, anleggsmidlene og periodiseringene</h3>
        <p className="liten dempet">
          Standarden er norsk standard kontoplan (NS 4102). Tomt felt: standardkontoen. Endringer gjelder bilagene som føres etterpå. Balansekontoene for
          periodiseringene er forslag; hver periodisering har sine kontoer. Lønnskontoene står under Innstillinger → Ansatte og timer.
        </p>
        <div className="bokforing-kontoer">
          {o.data.kontoer.map((k) => (
            <label key={k.rolle}>
              {k.navn}
              <input inputMode="numeric" placeholder={k.standard} value={verdier[k.rolle] ?? ""} onChange={(e) => settSkjema({ ...verdier, [k.rolle]: e.target.value })} />
            </label>
          ))}
        </div>
        <Feil melding={h.feil} />
        {lagret && (
          <div className="melding ok" role="status">
            Lagret.
          </div>
        )}
        <div className="knapper">
          <button className="primar" disabled={h.opptatt}>
            Lagre
          </button>
        </div>
      </form>
      <div className="kort tabell">
        <table>
          <thead>
            <tr>
              <th>Balansekontoen som foreslås for kategorien</th>
              <th className="hoyre">Konto</th>
            </tr>
          </thead>
          <tbody>{o.data.kategorier.map((k) => rad(k.navn, k.konto))}</tbody>
        </table>
      </div>
    </>
  );
}
