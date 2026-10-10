// Regnskap → Bank (server/src/regnskapBank.ts og bankAvstemming.ts): alle transaksjonene på
// bankkontoene, inn og ut, slik banken sender dem, og hvordan hver er ført i regnskapet: koblet til
// bilaget som alt fører den (innbetalingen på en faktura, kvitteringen betalt med kort, lønnen),
// eller bokført av reglene (betalingen av en leverandørfaktura, nettolønnen, skatt og avgift,
// overføringer, gebyrer og renter). Det reglene ikke er sikre på, står under «Må avklares» med et
// forslag eller hva som mangler. Øverst avstemmingen per konto: saldoen i banken mot kontoen i
// regnskapet.
import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { api, hent } from "../api";
import { Dialog, Feil, Laster, Tom, useData, useHandling } from "../felles";
import { useKonto } from "../konto";
import { dato, iDag, kr } from "../format";
import { IkonHoyre, IkonRegnskap, IkonVenstre } from "../ikoner";

type Status = "ny" | "avstemt" | "forslag" | "uavklart";
type Forslag =
  | { type: "bilag"; bilag_id: string; nummer: string }
  | { type: "utgift"; utgift_id: string; leverandor: string | null }
  | { type: "bokfor"; tekst: string; posteringer: { konto: string; belop: number; tekst?: string | null }[]; mot?: string | null }
  | { type: "overforing"; mot: string };
export type Bankpost = {
  id: string;
  konto: string;
  ekstern_id: string;
  dato: string;
  belop: number;
  valuta: string;
  motpart: string | null;
  motpart_konto: string | null;
  melding: string | null;
  referanse: string | null;
  status: Status;
  auto: boolean;
  regel: string | null;
  forslag: Forslag | null;
  bilag_id: string | null;
  par_id: string | null;
  bilagsnummer: string | null;
  av_seg_selv: boolean;
  for_start?: boolean;
};
type Bankkonto = {
  konto: string;
  vis: string;
  navn: string | null;
  regnskapskonto: string;
  delt: boolean;
  hentet_fra: string | null;
  dato: string;
  saldo: number | null;
  regnskap: number;
  apne: { antall: number; sum: number };
  uten_post: { antall: number; sum: number };
  differanse: number | null;
};
export type Bankoversikt = { maaned: string; bank_fra: string | null; auto: boolean; kontoer: Bankkonto[]; poster: Bankpost[]; apne: number };
type Detalj = Bankpost & {
  regnskapskonto: string;
  kandidater: {
    utgifter: { id: string; leverandor: string | null; fakturanummer: string | null; dato: string; forfallsdato: string | null; belop: number; kid: string | null }[];
    bilag: { id: string; nummer: string; dato: string; tekst: string; kilde: string; rest: number }[];
  };
  innbetaling: { id: string; status: string } | null;
};

const MND = ["januar", "februar", "mars", "april", "mai", "juni", "juli", "august", "september", "oktober", "november", "desember"];
const visMaaned = (m: string) => `${MND[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
const flytt = (m: string, n: number) => {
  const d = new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)) - 1 + n, 1));
  return d.toISOString().slice(0, 7);
};
export const visKonto = (k: string | null) => (k && /^\d{11}$/.test(k) ? `${k.slice(0, 4)}.${k.slice(4, 6)}.${k.slice(6)}` : (k ?? ""));
const tittel = (p: Bankpost) => p.motpart ?? p.melding ?? (p.belop < 0 ? "Utbetaling" : "Innbetaling");

function Merke({ p }: { p: Bankpost }) {
  if (p.for_start) return <span className="merke merke-noytral">Før startdatoen</span>;
  if (p.status === "avstemt") return p.av_seg_selv ? <span className="merke merke-ok">Ført av seg selv</span> : <span className="merke merke-noytral">Ført</span>;
  if (p.status === "forslag") return <span className="merke merke-info">Forslag</span>;
  if (p.status === "uavklart") return <span className="merke merke-advarsel">Må avklares</span>;
  return <span className="merke merke-noytral">Vurderes</span>;
}

// Den første setningen av regelen (hele står i detaljen).
const kort = (regel: string) => {
  const i = regel.indexOf(". ");
  return i > 0 ? regel.slice(0, i + 1) : regel;
};

function Postliste({ poster, apne, hovedkonto }: { poster: Bankpost[]; apne: (id: string) => void; hovedkonto: string | null }) {
  return (
    <div className="kort liste">
      {poster.map((p) => (
        <button key={p.id} type="button" className="liste-rad" onClick={() => apne(p.id)}>
          <span className="linje">
            <span className="tittel">{tittel(p)}</span>
            <span className={`tall bank-belop ${p.belop < 0 ? "ut" : "inn"}`}>{kr(p.belop)}</span>
          </span>
          <span className="linje">
            <span className="under">
              {dato(p.dato)}
              {p.bilagsnummer ? ` · ${p.bilagsnummer}` : ""}
              {hovedkonto && p.konto !== hovedkonto ? ` · ${visKonto(p.konto)}` : ""}
              {p.status !== "avstemt" && !p.for_start && p.regel ? ` · ${kort(p.regel)}` : ""}
            </span>
            <Merke p={p} />
          </span>
        </button>
      ))}
    </div>
  );
}

function Kontokort({ k }: { k: Bankkonto }) {
  return (
    <div className="kort bank-konto">
      <div className="bank-konto-hode">
        <span>
          <strong>{k.navn ?? "Bankkonto"}</strong> <span className="dempet">{k.vis}</span>
        </span>
        {k.delt ? (
          <span className="merke merke-noytral">Felles konto {k.regnskapskonto}</span>
        ) : k.differanse === 0 ? (
          <span className="merke merke-ok">Avstemt</span>
        ) : k.differanse !== null ? (
          <span className="merke merke-advarsel">Differanse</span>
        ) : null}
      </div>
      <dl className="bank-tall">
        <div>
          <dt>I banken</dt>
          <dd>{k.saldo !== null ? kr(k.saldo) : "–"}</dd>
        </div>
        <div>
          <dt>I regnskapet ({k.regnskapskonto})</dt>
          <dd>{kr(k.regnskap)}</dd>
        </div>
        {k.apne.antall > 0 && (
          <div>
            <dt>Ikke ført ({k.apne.antall})</dt>
            <dd>{kr(k.apne.sum)}</dd>
          </div>
        )}
        {k.uten_post.antall > 0 && (
          <div>
            <dt>Bilag uten bankpost ({k.uten_post.antall})</dt>
            <dd>{kr(k.uten_post.sum)}</dd>
          </div>
        )}
        {k.differanse !== null && k.differanse !== 0 && (
          <div>
            <dt>Differanse</dt>
            <dd>{kr(k.differanse)}</dd>
          </div>
        )}
      </dl>
      <p className="liten dempet">
        {k.saldo !== null
          ? `Per ${dato(k.dato)}.`
          : "Saldoen i banken kommer når du henter fra banken selv (Fakturaer → Innbetalinger → Hent nå), eller med bankpostene når banken sender den."}
        {k.differanse ? " Differansen er saldoen fra før startdatoen (den inngående saldoen, som føres som et manuelt bilag) eller noe som er ført på andre måter." : ""}
        {k.delt ? ` Kontoen ${k.regnskapskonto} i regnskapet gjelder flere bankkontoer; velg egne kontoer under Kontoer → Banken for å avstemme hver.` : ""}
      </p>
    </div>
  );
}

export function Bank({ apen, apne }: { apen: string | null; apne: (id: string | null) => void }) {
  const { org } = useKonto();
  const [maaned, settMaaned] = useState(() => iDag().slice(0, 7));
  const sti = `/org/${org!.id}/regnskap/bank`;
  const d = useData(() => hent<Bankoversikt>(`${sti}?maaned=${maaned}`), [sti, maaned]);
  const data = d.data;
  const apneListe = data?.poster.filter((p) => p.status !== "avstemt" && !p.for_start) ?? [];
  const iMaaned = data?.poster.filter((p) => p.dato.startsWith(maaned)) ?? [];
  // Kontoen på fakturaene står først; de andre kontoene vises på postene.
  const hovedkonto = (data?.kontoer.length ?? 0) > 1 ? data!.kontoer[0]!.konto : null;

  return (
    <>
      <p className="dempet liten">
        Alle transaksjonene på bankkontoene hentes fra banken og føres i regnskapet: koblet til bilaget som alt fører dem (innbetalinger, kvitteringer betalt med kort,
        lønnen), eller bokført av reglene (betalinger av leverandørfakturaer, nettolønnen, skatt og avgift, overføringer, gebyrer og renter).
        {data?.auto === false ? " Automatikken er slått av (Kontoer → Banken): reglene foreslår bare." : " Det reglene ikke er sikre på, står under «Må avklares»."}
        {data?.bank_fra ? ` Bankpostene føres fra og med ${dato(data.bank_fra)}.` : ""}
      </p>
      {d.feil ? (
        <Feil melding={d.feil} />
      ) : !data ? (
        <Laster />
      ) : !data.kontoer.length ? (
        <div className="kort">
          <Tom ikon={<IkonRegnskap storrelse={22} />} tittel="Ingen bankposter ennå">
            <p>
              Koble til banken under <Link to="/innstillinger?fane=betaling">Innstillinger → Faktura</Link>. Transaksjonene hentes på de faste hentetidene og når du
              henter selv, og føres her.
            </p>
          </Tom>
        </div>
      ) : (
        <>
          <div className="bank-kontoer">
            {data.kontoer.map((k) => (
              <Kontokort key={k.konto} k={k} />
            ))}
          </div>
          <h2 className="utgift-gruppe">
            Må avklares {apneListe.length > 0 && <span className="dempet">({apneListe.length})</span>}
          </h2>
          {apneListe.length ? <Postliste poster={apneListe} apne={apne} hovedkonto={hovedkonto} /> : <p className="dempet liten">Alt er ført.</p>}
          <div className="bank-maaned">
            <h2 className="utgift-gruppe">Bankpostene</h2>
            <div className="ukevelger">
              <button type="button" className="ikon" aria-label="Forrige måned" title="Forrige måned" onClick={() => settMaaned(flytt(maaned, -1))}>
                <IkonVenstre storrelse={20} />
              </button>
              <div className="uke-navn" aria-live="polite">
                <strong>{visMaaned(maaned).replace(/^./, (c) => c.toUpperCase())}</strong>
              </div>
              <button
                type="button"
                className="ikon"
                aria-label="Neste måned"
                title="Neste måned"
                disabled={maaned >= iDag().slice(0, 7)}
                onClick={() => settMaaned(flytt(maaned, 1))}
              >
                <IkonHoyre storrelse={20} />
              </button>
            </div>
          </div>
          {iMaaned.length ? <Postliste poster={iMaaned} apne={apne} hovedkonto={hovedkonto} /> : <p className="dempet liten">Ingen bankposter i {visMaaned(maaned)}.</p>}
        </>
      )}
      <Dialog apen={!!apen} lukk={() => apne(null)} tittel="Bankpost">
        {apen && <BankpostDetalj key={apen} id={apen} endret={() => void d.last()} />}
      </Dialog>
    </>
  );
}

function BankpostDetalj({ id, endret }: { id: string; endret: () => void }) {
  const { org } = useKonto();
  const sti = `/org/${org!.id}/regnskap/bank/${id}`;
  const p = useData(() => hent<Detalj>(sti), [sti]);
  const kontoer = useData(() => hent<{ kontoer: { konto: string; navn: string }[] }>(`/org/${org!.id}/regnskap/kontoliste`), [org!.id]);
  const [konto, settKonto] = useState("");
  const [tekst, settTekst] = useState("");
  const [husk, settHusk] = useState(true);
  const h = useHandling();
  if (p.feil) return <Feil melding={p.feil} />;
  if (!p.data) return <Laster />;
  const x = p.data;
  const navn = (k: string) => kontoer.data?.kontoer.find((y) => y.konto === k.trim())?.navn ?? "";

  async function gjor(handling: string, kropp?: unknown) {
    const r = await h.kjor(() => api<Bankpost>("POST", `${sti}/${handling}`, kropp ?? {}));
    if (r) {
      endret();
      await p.last();
    }
  }
  function forKonto(e: FormEvent) {
    e.preventDefault();
    void gjor("konto", { konto: konto.trim(), tekst: tekst.trim() || null, husk: husk && !!(x.motpart || x.motpart_konto) });
  }

  const venterPaaInnbetaling = x.innbetaling && (x.innbetaling.status === "uavklart" || x.innbetaling.status === "forslag");
  return (
    <div className="bank-post">
      <div className="bank-post-hode">
        <span className={`bank-belop stor ${x.belop < 0 ? "ut" : "inn"}`}>{kr(x.belop)}</span>
        <span className="dempet">{dato(x.dato)}</span>
      </div>
      <dl className="bank-felter">
        <dt>{x.belop < 0 ? "Til" : "Fra"}</dt>
        <dd>
          {x.motpart ?? "–"}
          {x.motpart_konto ? ` (${visKonto(x.motpart_konto)})` : ""}
        </dd>
        {x.melding && (
          <>
            <dt>Melding</dt>
            <dd>{x.melding}</dd>
          </>
        )}
        {x.referanse && (
          <>
            <dt>KID</dt>
            <dd>{x.referanse}</dd>
          </>
        )}
        <dt>Konto</dt>
        <dd>
          {visKonto(x.konto)} · {x.regnskapskonto} i regnskapet
        </dd>
      </dl>
      <Feil melding={h.feil} />
      {x.status === "avstemt" ? (
        <>
          <div className="melding ok" role="status">
            {x.bilagsnummer ? `Ført i bilag ${x.bilagsnummer}` : "Ført"}
            {x.av_seg_selv ? " av seg selv" : ""}: {x.regel}
          </div>
          <div className="knapper">
            <button type="button" disabled={h.opptatt} onClick={() => void gjor("angre")}>
              Angre
            </button>
          </div>
          <p className="liten dempet">Angre reverserer bilaget i serie B (eller betalingen av utgiften); posten blir stående til du velger hvordan den skal føres.</p>
        </>
      ) : (
        <>
          {x.for_start ? null : x.regel && <div className={`melding ${x.status === "forslag" ? "info" : "advarsel"}`}>{x.status === "forslag" ? `Forslag: ${x.regel}` : x.regel}</div>}
          {x.status === "forslag" && x.forslag && (
            <div className="knapper">
              <button type="button" className="primar" disabled={h.opptatt} onClick={() => void gjor("godta")}>
                Godta forslaget
              </button>
            </div>
          )}
          {venterPaaInnbetaling && (
            <div className="knapper">
              <Link className="knapp" to="/fakturaer?fane=innbetalinger">
                Til Innbetalinger
              </Link>
              <button type="button" disabled={h.opptatt} onClick={() => void gjor("ikke-faktura")}>
                Ikke en fakturabetaling
              </button>
            </div>
          )}
          <h3>Før på en konto</h3>
          <form className="bank-konto-skjema" onSubmit={forKonto}>
            <label>
              Konto
              <input required inputMode="numeric" list="bank-kontoer" value={konto} onChange={(e) => settKonto(e.target.value)} placeholder="F.eks. 6900" />
              <span className="felt-hjelp">{navn(konto)}</span>
            </label>
            <label>
              Tekst
              <input maxLength={200} value={tekst} onChange={(e) => settTekst(e.target.value)} placeholder={tittel(x)} />
            </label>
            {(x.motpart || x.motpart_konto) && (
              <label className="avkrysning">
                <input type="checkbox" checked={husk} onChange={(e) => settHusk(e.target.checked)} /> Før {x.belop < 0 ? "betalinger til" : "innbetalinger fra"}{" "}
                {x.motpart ?? visKonto(x.motpart_konto)} på denne kontoen av seg selv neste gang
              </label>
            )}
            <div className="knapper">
              <button className={x.status === "forslag" ? undefined : "primar"} disabled={h.opptatt}>
                Før på kontoen
              </button>
            </div>
          </form>
          <datalist id="bank-kontoer">
            {kontoer.data?.kontoer.map((k) => (
              <option key={k.konto} value={k.konto}>
                {k.navn}
              </option>
            ))}
          </datalist>
          {x.belop < 0 && (
            <>
              <h3>Betaling av en utgift</h3>
              {x.kandidater.utgifter.length ? (
                <div className="kort liste">
                  {x.kandidater.utgifter.map((u) => (
                    <button key={u.id} type="button" className="liste-rad" disabled={h.opptatt} onClick={() => void gjor("utgift", { utgift_id: u.id })}>
                      <span className="linje">
                        <span className="tittel">
                          {u.leverandor ?? "Utgift"}
                          {u.fakturanummer ? `, faktura ${u.fakturanummer}` : ""}
                        </span>
                        <span className="tall">{kr(u.belop)}</span>
                      </span>
                      <span className="under">
                        {dato(u.dato)}
                        {u.forfallsdato ? ` · forfall ${dato(u.forfallsdato)}` : ""}
                        {u.kid ? ` · KID ${u.kid}` : ""}
                      </span>
                    </button>
                  ))}
                </div>
              ) : (
                <p className="liten dempet">Ingen ubetalte leverandørfakturaer.</p>
              )}
              <p className="liten dempet">
                Mangler kvitteringen eller fakturaen? Last den opp under <Link to="/regnskap?fane=utgifter">Utgifter</Link>; posten kobles når utgiften er bokført.{" "}
                <button type="button" className="lenke" disabled={h.opptatt} onClick={() => void gjor("vurder")}>
                  Vurder på nytt
                </button>
              </p>
            </>
          )}
          {x.kandidater.bilag.length > 0 && (
            <>
              <h3>Koble til et bilag</h3>
              <div className="kort liste">
                {x.kandidater.bilag.map((b) => (
                  <button key={b.id} type="button" className="liste-rad" disabled={h.opptatt} onClick={() => void gjor("bilag", { bilag_id: b.id })}>
                    <span className="linje">
                      <span className="tittel">
                        {b.nummer} {b.tekst}
                      </span>
                      <span className="tall">{kr(b.rest)}</span>
                    </span>
                    <span className="under">{dato(b.dato)}</span>
                  </button>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
