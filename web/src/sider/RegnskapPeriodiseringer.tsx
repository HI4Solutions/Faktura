// Regnskap → Periodiseringer (server/src/regnskapBilagRuter.ts, periodisering.ts): et beløp som
// fordeles på månedene det gjelder (forskuddsbetalt og påløpt kostnad, uopptjent og opptjent
// inntekt), bokført måned for måned i bilagserie P med månedsavslutningen. Et forskudd har en start
// som fører beløpet til balansekontoen (flyttet fra resultatkontoen, eller fra bank, leverandørgjeld
// eller kundefordringer med mva).
import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { api, hent } from "../api";
import { Dialog, Feil, Laster, Tom, tall, useData, useHandling, useSmal } from "../felles";
import { useKonto } from "../konto";
import { dato, iDag, kr } from "../format";
import { IkonPluss, IkonRegnskap, IkonVenstre } from "../ikoner";
import { Maanedsavslutning, mndNavn, type Bilagsvar } from "./RegnskapAvslutning";

type Type = { type: string; navn: string; kostnad: boolean; forskudd: boolean; balansekonto: string; resultatkonto: string };
type Start = "ingen" | "flytt" | "motkonto";
type Periodisering = {
  id: string;
  nummer: number;
  navn: string;
  type: string;
  belop: number;
  fra: string;
  antall_maaneder: number;
  resultatkonto: string;
  balansekonto: string;
  start: Start;
  tekst: string | null;
  fordelt: number;
  igjen: number;
  slutt: string;
  neste: { maaned: string; belop: number } | null;
  start_bilag: string | null;
  mangler_start: boolean;
  ferdig: boolean;
};
type Post = { id: string; type: "start" | "maaned"; maaned: string | null; belop: number; dato: string; bilag_id: string; bilag: string; reversert: boolean };
type Fordelingsmaaned = { maaned: string; belop: number; bokfort: boolean; bilag: string | null; igjen: number };
type Detalj = { periodisering: Periodisering; poster: Post[]; fordeling: Fordelingsmaaned[]; bilag?: Bilagsvar | null };
type Kontorad = { rolle: string; konto: string };

const tekstTall = (n: number | null | undefined) => (n == null ? "" : String(n).replace(".", ","));
const kortMnd = (m: string) => `${m.slice(5, 7)}.${m.slice(0, 4)}`;
const iDagMnd = () => iDag().slice(0, 7);
// Starten dateres den første dagen i den første måneden, eller i dag når den er fram i tid.
const standardStart = (fra: string) => (fra && `${fra.slice(0, 7)}-01` < iDag() ? `${fra.slice(0, 7)}-01` : iDag());

function merke(p: Periodisering) {
  if (p.ferdig) return <span className="merke merke-noytral">Ferdig</span>;
  if (p.mangler_start) return <span className="merke merke-advarsel">Starten mangler</span>;
  if (!p.fordelt) return <span className="merke merke-info">Ikke begynt</span>;
  return <span className="merke merke-ok">I gang</span>;
}

// --- Lista -------------------------------------------------------------------------------------

export function Periodiseringer({ apne }: { apne: (id: string) => void }) {
  const { org } = useKonto();
  const sti = `/org/${org!.id}/regnskap`;
  const liste = useData(() => hent<{ periodiseringer: Periodisering[]; typer: Type[] }>(`${sti}/periodiseringer`), [sti]);
  const kontoer = useData(() => hent<{ kontoer: Kontorad[] }>(`${sti}/oppsett`), [sti]);
  const [ny, settNy] = useState(false);
  const [visFerdige, settVisFerdige] = useState(false);
  const smal = useSmal();

  if (liste.feil) return <Feil melding={liste.feil} />;
  if (!liste.data || !kontoer.data) return <Laster />;
  const { periodiseringer: alle, typer } = liste.data;
  const ferdige = alle.filter((p) => p.ferdig);
  const vist = visFerdige ? alle : alle.filter((p) => !p.ferdig);
  const typenavn = (t: string) => typer.find((x) => x.type === t)?.navn ?? t;

  return (
    <>
      <p className="dempet liten">
        Et beløp som gjelder flere måneder, fordeles likt på månedene og bokføres måned for måned med månedsavslutningen (bilagserie P): forsikring og leie betalt på
        forskudd, kostnader som faktureres senere, abonnementer som er fakturert på forskudd, og inntekter som faktureres senere. Endres antallet måneder, fordeles det
        som står igjen på månedene som er igjen.
      </p>
      <Maanedsavslutning bokfort={() => void liste.last()} visBokfort={alle.length > 0} />
      <div className="knapper lonn-knapper">
        <button type="button" className="primar" onClick={() => settNy(true)}>
          <IkonPluss /> Ny periodisering
        </button>
        {ferdige.length > 0 && (
          <label className="liten">
            <input type="checkbox" checked={visFerdige} onChange={(e) => settVisFerdige(e.target.checked)} /> Vis ferdige ({ferdige.length})
          </label>
        )}
        <Link to="/rapporter?fane=regnskap&rapport=regnskap.periodiseringer" className="knapp">
          Rapport (CSV og PDF)
        </Link>
      </div>
      {!alle.length ? (
        <div className="kort">
          <Tom ikon={<IkonRegnskap storrelse={22} />} tittel="Ingen periodiseringer ennå">
            <p>F.eks. forsikringen for året betalt i januar (kostnaden fordeles på tolv måneder), eller et årsabonnement fakturert på forskudd.</p>
          </Tom>
        </div>
      ) : !vist.length ? (
        <p className="dempet liten">Alle periodiseringene er ferdige.</p>
      ) : smal ? (
        <div className="kort liste">
          {vist.map((p) => (
            <button key={p.id} type="button" className="liste-rad" onClick={() => apne(p.id)}>
              <span className="linje">
                <span className="tittel">
                  {p.nummer}. {p.navn}
                </span>
                <span className="tall">{kr(p.belop)}</span>
              </span>
              <span className="linje">
                <span className="under">
                  {kortMnd(p.fra)}–{kortMnd(p.slutt)} · igjen {kr(p.igjen)}
                </span>
                {merke(p)}
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
                <th>Periodisering</th>
                <th>Måneder</th>
                <th className="hoyre">Beløp</th>
                <th className="hoyre">Fordelt</th>
                <th className="hoyre">Igjen</th>
                <th className="hoyre">Neste</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {vist.map((p) => (
                <tr key={p.id} className="klikkbar" onClick={() => apne(p.id)}>
                  <td>{p.nummer}</td>
                  <td>
                    <Link to={`?fane=periodiseringer&periodisering=${p.id}`} onClick={(e) => e.stopPropagation()}>
                      {p.navn}
                    </Link>
                    <span className="dempet liten"> · {typenavn(p.type)}</span>
                  </td>
                  <td>
                    {kortMnd(p.fra)}–{kortMnd(p.slutt)}
                  </td>
                  <td className="tall">{kr(p.belop)}</td>
                  <td className="tall">{kr(p.fordelt)}</td>
                  <td className="tall">{kr(p.igjen)}</td>
                  <td className="tall">{p.neste ? `${kr(p.neste.belop)} (${mndNavn(p.neste.maaned)})` : <span className="dempet">–</span>}</td>
                  <td>{merke(p)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Dialog apen={ny} lukk={() => settNy(false)} tittel="Ny periodisering" bred>
        {ny && (
          <PeriodiseringSkjema
            typer={typer}
            kontoer={kontoer.data.kontoer}
            lagret={(d) => {
              settNy(false);
              void liste.last();
              apne(d.periodisering.id);
            }}
            avbryt={() => settNy(false)}
          />
        )}
      </Dialog>
    </>
  );
}

// --- Skjemaet (ny og endre) --------------------------------------------------------------------

function Motkonto({ kostnad, kontoer, verdi, endre }: { kostnad: boolean; kontoer: Kontorad[]; verdi: string; endre: (v: string) => void }) {
  const k = (r: string) => kontoer.find((x) => x.rolle === r)?.konto ?? "";
  return (
    <label>
      {kostnad ? "Betalt fra" : "Fakturert til"}
      <select value={verdi} onChange={(e) => endre(e.target.value)}>
        {kostnad ? (
          <>
            <option value={k("leverandorgjeld")}>{k("leverandorgjeld")} Leverandørgjeld (ikke betalt)</option>
            <option value={k("bank")}>{k("bank")} Bank</option>
          </>
        ) : (
          <>
            <option value={k("kundefordringer")}>{k("kundefordringer")} Kundefordringer</option>
            <option value={k("bank")}>{k("bank")} Bank (betalt)</option>
          </>
        )}
      </select>
    </label>
  );
}

function PeriodiseringSkjema({
  typer,
  kontoer,
  naa,
  bokfort,
  lagret,
  avbryt,
}: {
  typer: Type[];
  kontoer: Kontorad[];
  naa?: Periodisering;
  bokfort?: boolean;
  lagret: (d: Detalj) => void;
  avbryt: () => void;
}) {
  const { org } = useKonto();
  const sti = `/org/${org!.id}/regnskap/periodiseringer`;
  const k = (r: string) => kontoer.find((x) => x.rolle === r)?.konto ?? "";
  const forste = typer[0]!;
  const [s, settS] = useState({
    type: naa?.type ?? forste.type,
    navn: naa?.navn ?? "",
    belop: tekstTall(naa?.belop),
    fra: naa ? naa.fra.slice(0, 7) : iDagMnd(),
    antall: naa ? String(naa.antall_maaneder) : "12",
    resultatkonto: naa?.resultatkonto ?? "",
    balansekonto: naa?.balansekonto ?? "",
    start: (naa?.start ?? (forste.forskudd ? "motkonto" : "ingen")) as Start,
    motkonto: forste.kostnad ? k("leverandorgjeld") : k("kundefordringer"),
    mva: "",
    start_dato: "",
    tekst: naa?.tekst ?? "",
  });
  const h = useHandling();
  const t = typer.find((x) => x.type === s.type) ?? forste;
  const sett = (x: Partial<typeof s>) => settS({ ...s, ...x });
  const velgType = (type: string) => {
    const ny = typer.find((x) => x.type === type)!;
    sett({ type, resultatkonto: "", balansekonto: "", start: ny.forskudd ? "motkonto" : "ingen", motkonto: ny.kostnad ? k("leverandorgjeld") : k("kundefordringer") });
  };
  const antall = Math.round(tall(s.antall || "0"));
  const belop = tall(s.belop || "0");
  const resultatkonto = s.resultatkonto.trim() || t.resultatkonto;
  const balansekonto = s.balansekonto.trim() || t.balansekonto;
  const slutt = (() => {
    if (!/^\d{4}-\d{2}$/.test(s.fra) || antall < 1) return null;
    const [a, m] = s.fra.split("-").map(Number) as [number, number];
    const x = a * 12 + m - 1 + antall - 1;
    return `${Math.floor(x / 12)}-${String((x % 12) + 1).padStart(2, "0")}`;
  })();

  async function lagre(e: FormEvent) {
    e.preventDefault();
    const felles = { navn: s.navn, antall_maaneder: antall, tekst: s.tekst.trim() || null };
    const fritt = { belop, fra: s.fra, resultatkonto, balansekonto, start: t.forskudd ? s.start : "ingen" };
    const r = await h.kjor(() =>
      naa
        ? api<Detalj>("PATCH", `${sti}/${naa.id}`, bokfort ? felles : { ...felles, ...fritt })
        : api<Detalj>("POST", sti, {
            ...felles,
            ...fritt,
            type: s.type,
            ...(t.forskudd && s.start === "motkonto" ? { motkonto: s.motkonto, mva: s.mva.trim() ? tall(s.mva) : 0 } : {}),
            ...(t.forskudd && s.start !== "ingen" ? { start_dato: s.start_dato || standardStart(s.fra) } : {}),
          }),
    );
    if (r) lagret(r);
  }

  const startValg: [Start, string][] = t.kostnad
    ? [
        ["motkonto", "Bokfør fakturaen her: beløpet til balansekontoen fra leverandørgjeld eller bank, med inngående mva"],
        ["flytt", `Fakturaen er ført som kostnad (på ${resultatkonto}): flytt beløpet til balansekontoen`],
        ["ingen", `Beløpet er alt ført på balansekontoen (${balansekonto})`],
      ]
    : [
        ["motkonto", "Bokfør fakturaen her: beløpet til balansekontoen fra kundefordringer eller bank, med utgående mva"],
        ["flytt", `Fakturaen er ført som inntekt (på ${resultatkonto}): flytt beløpet til balansekontoen`],
        ["ingen", `Beløpet er alt ført på balansekontoen (${balansekonto})`],
      ];

  return (
    <form onSubmit={lagre} className="regnskap-skjema">
      <label>
        Hva slags periodisering
        {naa ? (
          <input value={t.navn} disabled />
        ) : (
          <select value={s.type} onChange={(e) => velgType(e.target.value)}>
            {typer.map((x) => (
              <option key={x.type} value={x.type}>
                {x.navn}
              </option>
            ))}
          </select>
        )}
        <span className="felt-hjelp">
          {t.type === "forskuddsbetalt_kostnad"
            ? "Betalt nå for flere måneder (forsikring, leie, lisenser): kostnaden føres måned for måned."
            : t.type === "paalopt_kostnad"
              ? "En kostnad som påløper nå, men faktureres senere (bonus, strøm): kostnaden føres hver måned, og fakturaen føres mot balansekontoen når den kommer."
              : t.type === "uopptjent_inntekt"
                ? "Fakturert på forskudd for flere måneder (årsabonnement): inntekten føres måned for måned."
                : "En inntekt som opptjenes nå, men faktureres senere: inntekten føres hver måned, og fakturaen føres mot balansekontoen."}
        </span>
      </label>
      <div className="rad">
        <label>
          Navn
          <input required maxLength={120} value={s.navn} onChange={(e) => sett({ navn: e.target.value })} placeholder="F.eks. Forsikring 2026" />
        </label>
        <label>
          Beløp uten mva (kr)
          <input inputMode="decimal" required disabled={bokfort} value={s.belop} onChange={(e) => sett({ belop: e.target.value })} />
        </label>
      </div>
      <div className="rad">
        <label>
          Første måned
          <input type="month" required disabled={bokfort} value={s.fra} onChange={(e) => sett({ fra: e.target.value })} />
        </label>
        <label>
          Antall måneder
          <input inputMode="numeric" required value={s.antall} onChange={(e) => sett({ antall: e.target.value })} />
          <span className="felt-hjelp">
            {!slutt || antall < 1 || antall > 120
              ? "1–120 måneder."
              : naa && bokfort
                ? `${mndNavn(s.fra)} til og med ${mndNavn(slutt)}. Det som står igjen (${kr(naa.igjen)} kr), fordeles på månedene som ikke er bokført.`
                : `${mndNavn(s.fra)} til og med ${mndNavn(slutt)}${belop > 0 ? `, ca. ${kr(belop / antall)} kr i måneden` : ""}.`}
          </span>
        </label>
      </div>
      <div className="rad">
        <label>
          {t.kostnad ? "Kostnadskonto" : "Inntektskonto"}
          <input inputMode="numeric" disabled={bokfort} placeholder={t.resultatkonto} value={s.resultatkonto} onChange={(e) => sett({ resultatkonto: e.target.value })} />
        </label>
        <label>
          Balansekonto
          <input inputMode="numeric" disabled={bokfort} placeholder={t.balansekonto} value={s.balansekonto} onChange={(e) => sett({ balansekonto: e.target.value })} />
        </label>
      </div>
      {t.forskudd && (
        <>
          <h4 className="lonn-under">Fakturaen</h4>
          <div className="valg valg-kolonne" role="radiogroup">
            {startValg.map(([v, tekst]) => (
              <label key={v}>
                <input type="radio" disabled={bokfort} checked={s.start === v} onChange={() => sett({ start: v })} /> {tekst}
              </label>
            ))}
          </div>
          {!naa && s.start !== "ingen" && (
            <div className="rad">
              <label>
                Dato
                <input type="date" max={iDag()} value={s.start_dato || standardStart(s.fra)} onChange={(e) => sett({ start_dato: e.target.value })} />
              </label>
              {s.start === "motkonto" && (
                <>
                  <Motkonto kostnad={t.kostnad} kontoer={kontoer} verdi={s.motkonto} endre={(v) => sett({ motkonto: v })} />
                  <label>
                    {t.kostnad ? "Inngående mva (kr)" : "Utgående mva (kr)"}
                    <input inputMode="decimal" placeholder="0" value={s.mva} onChange={(e) => sett({ mva: e.target.value })} />
                  </label>
                </>
              )}
            </div>
          )}
        </>
      )}
      <label>
        Merknad
        <input maxLength={300} value={s.tekst} onChange={(e) => sett({ tekst: e.target.value })} placeholder="Valgfritt, f.eks. leverandør og fakturanummer" />
      </label>
      {bokfort && (
        <p className="liten dempet">Det er bokført noe for periodiseringen: beløpet, den første måneden, kontoene og starten kan ikke endres (reverser bilagene først).</p>
      )}
      <Feil melding={h.feil} />
      <div className="knapper">
        <button className="primar" disabled={h.opptatt}>
          {naa ? "Lagre" : t.forskudd && s.start !== "ingen" ? "Legg inn og bokfør" : "Legg inn"}
        </button>
        <button type="button" onClick={avbryt}>
          Avbryt
        </button>
      </div>
    </form>
  );
}

// --- Én periodisering ------------------------------------------------------------------------

export function PeriodiseringDetalj({ id, tilbake }: { id: string; tilbake: () => void }) {
  const { org } = useKonto();
  const sti = `/org/${org!.id}/regnskap`;
  const d = useData(() => hent<Detalj>(`${sti}/periodiseringer/${id}`), [sti, id]);
  const liste = useData(() => hent<{ typer: Type[] }>(`${sti}/periodiseringer`), [sti]);
  const kontoer = useData(() => hent<{ kontoer: Kontorad[] }>(`${sti}/oppsett`), [sti]);
  const [handling, settHandling] = useState<"endre" | "start" | null>(null);
  const [melding, settMelding] = useState<string | null>(null);
  const h = useHandling();
  const smal = useSmal();

  const tilbakeLenke = (
    <button type="button" className="lenke tilbake" onClick={tilbake}>
      <IkonVenstre /> Periodiseringer
    </button>
  );
  if (d.feil)
    return (
      <>
        {tilbakeLenke}
        <Feil melding={d.feil} />
      </>
    );
  if (!d.data || !liste.data || !kontoer.data) return <Laster />;
  const { periodisering: p, poster, fordeling } = d.data;
  const t = liste.data.typer.find((x) => x.type === p.type);
  const gjeldende = poster.filter((x) => !x.reversert);
  const bokfort = gjeldende.length > 0;
  // Det som kan reverseres: den siste måneden, eller starten når ingen måned er bokført.
  const maaneder = gjeldende.filter((x) => x.type === "maaned").sort((x, y) => x.maaned!.localeCompare(y.maaned!));
  const siste = maaneder.at(-1) ?? gjeldende.find((x) => x.type === "start") ?? null;

  const ferdig = (r: Detalj, tekst: string) => {
    settHandling(null);
    d.settData(r);
    settMelding(`${tekst}${r.bilag ? ` (bilag ${r.bilag.bilagsnummer})` : ""}.`);
  };
  const reverser = async (x: Post) => {
    if (!confirm(`Reversere bilag ${x.bilag}? Det føres et nytt bilag med motsatte beløp. Har bilaget flere periodiseringer (månedsavslutningen), reverseres alle.`)) return;
    const r = await h.kjor(() => api<Bilagsvar>("POST", `${sti}/bilag/${x.bilag_id}/reverser`, {}));
    if (r) {
      settMelding(`Bilag ${x.bilag} er reversert (bilag ${r.bilagsnummer}).`);
      void d.last();
    }
  };
  const slett = async () => {
    if (!confirm(`Slette ${p.navn}?`)) return;
    if (await h.kjor(async () => (await api("DELETE", `${sti}/periodiseringer/${p.id}`), true))) tilbake();
  };

  return (
    <>
      {tilbakeLenke}
      <div className="topp">
        <div>
          <h1 style={{ marginBottom: 4 }}>{p.navn}</h1>
          <div className="dempet liten">
            Nr. {p.nummer} · {t?.navn ?? p.type} · {p.resultatkonto} / {p.balansekonto} {merke(p)}
          </div>
        </div>
      </div>
      {melding && (
        <div className="melding ok" role="status">
          {melding}
        </div>
      )}
      <Feil melding={h.feil} />
      {p.mangler_start && (
        <div className="melding advarsel">
          Starten er ikke bokført: beløpet er ikke ført på {p.balansekonto}, og månedene bokføres først når den er det.{" "}
          <button type="button" className="lenke" onClick={() => settHandling("start")}>
            Bokfør starten
          </button>
        </div>
      )}

      <div className="nokkeltall lonn-tall">
        <div className="kort">
          <div className="etikett">Beløp</div>
          <div className="verdi">{kr(p.belop)}</div>
          <div className="under">
            {p.antall_maaneder} {p.antall_maaneder === 1 ? "måned" : "måneder"}: {mndNavn(p.fra.slice(0, 7))}–{mndNavn(p.slutt)}
          </div>
        </div>
        <div className="kort">
          <div className="etikett">Fordelt</div>
          <div className="verdi">{kr(p.fordelt)}</div>
          <div className="under">Igjen {kr(p.igjen)}</div>
        </div>
        <div className="kort">
          <div className="etikett">Neste måned</div>
          <div className="verdi">{p.neste ? kr(p.neste.belop) : "–"}</div>
          <div className="under">{p.neste ? mndNavn(p.neste.maaned) : "Alt er fordelt"}</div>
        </div>
      </div>

      <div className="knapper lonn-knapper">
        <button type="button" onClick={() => settHandling("endre")}>
          Endre
        </button>
        {!bokfort && (
          <button type="button" className="fare" disabled={h.opptatt} onClick={() => void slett()}>
            Slett
          </button>
        )}
      </div>
      {p.tekst && <p className="liten">{p.tekst}</p>}

      <h3 className="lonn-under">Bokført</h3>
      {!poster.length ? (
        <p className="dempet liten">Ingenting er bokført ennå. Månedene bokføres med månedsavslutningen.</p>
      ) : (
        <div className="kort liste">
          {[...poster].reverse().map((x) => (
            <div key={x.id} className={`liste-rad${x.reversert ? " dempet" : ""}`}>
              <span className="linje">
                <span className="tittel">{x.type === "start" ? "Starten: beløpet til balansekontoen" : mndNavn(x.maaned!)}</span>
                <span className="tall">{kr(x.belop)}</span>
              </span>
              <span className="linje">
                <span className="under">
                  {dato(x.dato)} · bilag {x.bilag}
                  {x.reversert ? " · reversert" : ""}
                </span>
                {!x.reversert && x.id === siste?.id && (
                  <button type="button" className="lenke" disabled={h.opptatt} onClick={() => void reverser(x)}>
                    Reverser
                  </button>
                )}
              </span>
            </div>
          ))}
        </div>
      )}

      <details className="regnskap-maaneder" open={fordeling.length <= 24}>
        <summary>Måned for måned ({fordeling.length} måneder)</summary>
        <div className="tabell">
          <table>
            <thead>
              <tr>
                <th>Måned</th>
                <th className="hoyre">Beløp</th>
                {!smal && <th className="hoyre">Igjen etter</th>}
                <th>Bilag</th>
              </tr>
            </thead>
            <tbody>
              {fordeling.map((m) => (
                <tr key={m.maaned}>
                  <td>{mndNavn(m.maaned)}</td>
                  <td className="tall">{kr(m.belop)}</td>
                  {!smal && <td className="tall">{kr(m.igjen)}</td>}
                  <td>{m.bilag ?? <span className="dempet liten">Plan</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>

      <Dialog apen={handling === "endre"} lukk={() => settHandling(null)} tittel={`Endre ${p.navn}`} bred>
        {handling === "endre" && (
          <PeriodiseringSkjema
            typer={liste.data.typer}
            kontoer={kontoer.data.kontoer}
            naa={p}
            bokfort={bokfort}
            lagret={(r) => ferdig(r, "Lagret")}
            avbryt={() => settHandling(null)}
          />
        )}
      </Dialog>
      <Dialog apen={handling === "start"} lukk={() => settHandling(null)} tittel="Bokfør starten">
        {handling === "start" && t && <StartSkjema p={p} t={t} kontoer={kontoer.data.kontoer} ferdig={(r) => ferdig(r, "Starten er bokført")} avbryt={() => settHandling(null)} />}
      </Dialog>
    </>
  );
}

function StartSkjema({ p, t, kontoer, ferdig, avbryt }: { p: Periodisering; t: Type; kontoer: Kontorad[]; ferdig: (r: Detalj) => void; avbryt: () => void }) {
  const { org } = useKonto();
  const k = (r: string) => kontoer.find((x) => x.rolle === r)?.konto ?? "";
  const [s, settS] = useState({ dato: standardStart(p.fra), motkonto: t.kostnad ? k("leverandorgjeld") : k("kundefordringer"), mva: "" });
  const h = useHandling();
  async function lagre(e: FormEvent) {
    e.preventDefault();
    const r = await h.kjor(() =>
      api<Detalj>("POST", `/org/${org!.id}/regnskap/periodiseringer/${p.id}/start`, {
        dato: s.dato,
        ...(p.start === "motkonto" ? { motkonto: s.motkonto, mva: s.mva.trim() ? tall(s.mva) : 0 } : {}),
      }),
    );
    if (r) ferdig(r);
  }
  return (
    <form onSubmit={lagre}>
      <p className="dempet liten">
        {p.start === "flytt"
          ? `${kr(p.belop)} kr flyttes fra ${p.resultatkonto} til ${p.balansekonto}.`
          : `${kr(p.belop)} kr føres på ${p.balansekonto} mot motkontoen${t.kostnad ? ", med inngående mva" : ", med utgående mva"}.`}
      </p>
      <div className="rad">
        <label>
          Dato
          <input type="date" required max={iDag()} value={s.dato} onChange={(e) => settS({ ...s, dato: e.target.value })} />
        </label>
        {p.start === "motkonto" && (
          <>
            <Motkonto kostnad={t.kostnad} kontoer={kontoer} verdi={s.motkonto} endre={(v) => settS({ ...s, motkonto: v })} />
            <label>
              {t.kostnad ? "Inngående mva (kr)" : "Utgående mva (kr)"}
              <input inputMode="decimal" placeholder="0" value={s.mva} onChange={(e) => settS({ ...s, mva: e.target.value })} />
            </label>
          </>
        )}
      </div>
      <Feil melding={h.feil} />
      <div className="knapper">
        <button className="primar" disabled={h.opptatt}>
          Bokfør
        </button>
        <button type="button" onClick={avbryt}>
          Avbryt
        </button>
      </div>
    </form>
  );
}
