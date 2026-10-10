// Regnskap → Bilag og Saldobalanse (server/src/regnskapBilagRuter.ts, hovedbok.ts): bilagene fra alle
// kildene (fakturaer og innbetalinger, lønn, refusjoner fra NAV, anleggsmidler, periodiseringer og
// manuelle bilag) med posteringene og mva-kodene, manuelle bilag (også den inngående balansen) og
// reversering, saldobalansen for en periode og hovedboken for en konto.
import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { api, hent } from "../api";
import { Dialog, Feil, Laster, Tom, tall, useData, useHandling, useSmal } from "../felles";
import { useKonto } from "../konto";
import { dato, iDag, kr } from "../format";
import { IkonPluss, IkonRegnskap } from "../ikoner";
import { Bilagstabell } from "./LonnBokforing";
import { Maanedsavslutning, Maanedsstatus } from "./RegnskapAvslutning";

type Postering = { konto: string; navn: string; tekst: string; belop: number; mva_kode?: string | null };
type Regnskapsbilag = {
  id: string;
  bilagsnummer: string;
  serie: string;
  dato: string;
  tekst: string;
  kilde: string;
  reverserer: string | null;
  reversert_av: string | null;
  opprettet_av: string | null;
  lenke?: string | null; // fakturaen eller lønnskjøringen bilaget kommer fra
  posteringer: Postering[];
};
type Konto = { konto: string; navn: string };

export const KILDER: Record<string, string> = {
  faktura: "Faktura",
  innbetaling: "Innbetaling",
  utgift: "Utgift",
  utgift_betaling: "Betaling av utgift",
  bank: "Bankpost",
  lonn: "Lønn",
  nav_refusjon: "Refusjon fra NAV",
  anlegg: "Anleggsmidler",
  periodisering: "Periodisering",
  manuell: "Manuelt bilag",
};
// Hvor bilag fra fakturaene, innbetalingene, lønnen og refusjonene rettes.
const ANDRE_STEDER: Record<string, string> = {
  faktura: "En faktura rettes med en kreditnota (Fakturaer), og kreditnotaen bokføres av seg selv.",
  innbetaling: "En innbetaling reverseres ved å ta bort betalingen på fakturaen (eller koble innbetalingen fra fakturaen under Innbetalinger).",
  utgift: "En utgift rettes under Regnskap → Utgifter (Angre bokføringen).",
  utgift_betaling: "En betaling av en utgift rettes under Regnskap → Utgifter (Angre bokføringen).",
  bank: "En bankpost rettes under Regnskap → Bank (Angre).",
  lonn: "Et lønnsbilag reverseres ved å åpne lønnskjøringen igjen (Lønn → Lønnskjøringer).",
  nav_refusjon: "En refusjon fra NAV reverseres ved å slette den (Lønn → Sykepenger).",
};
const LENKETEKST: Record<string, string> = {
  faktura: "Åpne fakturaen",
  innbetaling: "Åpne fakturaen",
  utgift: "Åpne utgiften",
  utgift_betaling: "Åpne utgiften",
  bank: "Åpne bankposten",
  lonn: "Åpne lønnskjøringen",
};
const aarsstart = () => `${iDag().slice(0, 4)}-01-01`;
const debetsum = (b: { posteringer: Postering[] }) => b.posteringer.reduce((s, p) => s + (p.belop > 0 ? p.belop : 0), 0);

// Fra–til med snarveier (i år, forrige måned, i fjor).
function Periodevalg({ fra, til, endre }: { fra: string; til: string; endre: (p: { fra: string; til: string }) => void }) {
  const d = iDag();
  const aar = Number(d.slice(0, 4));
  const m = Number(d.slice(5, 7));
  const [fa, fm] = m === 1 ? [aar - 1, 12] : [aar, m - 1];
  const forrige = { fra: `${fa}-${String(fm).padStart(2, "0")}-01`, til: new Date(Date.UTC(fa, fm, 0)).toISOString().slice(0, 10) };
  const snarveier: [string, { fra: string; til: string }][] = [
    ["I år", { fra: `${aar}-01-01`, til: d }],
    ["Forrige måned", forrige],
    ["I fjor", { fra: `${aar - 1}-01-01`, til: `${aar - 1}-12-31` }],
  ];
  return (
    <div className="regnskap-periode">
      <label>
        Fra
        <input type="date" value={fra} max={til} onChange={(e) => e.target.value && endre({ fra: e.target.value, til })} />
      </label>
      <label>
        Til
        <input type="date" value={til} min={fra} onChange={(e) => e.target.value && endre({ fra, til: e.target.value })} />
      </label>
      <div className="knapper">
        {snarveier.map(([t, p]) => (
          <button key={t} type="button" className={`lenke${p.fra === fra && p.til === til ? " valgt" : ""}`} onClick={() => endre(p)}>
            {t}
          </button>
        ))}
      </div>
    </div>
  );
}

// --- Bilagene ----------------------------------------------------------------------------------

export function Bilag() {
  const { org } = useKonto();
  const sti = `/org/${org!.id}/regnskap`;
  const [periode, settPeriode] = useState({ fra: aarsstart(), til: iDag() });
  const [kilde, settKilde] = useState("");
  const liste = useData(
    () => hent<{ bilag: Regnskapsbilag[] }>(`${sti}/bilag?fra=${periode.fra}&til=${periode.til}${kilde ? `&kilde=${kilde}` : ""}`),
    [sti, periode.fra, periode.til, kilde],
  );
  const [apen, settApen] = useState<string | null>(null);
  const [ny, settNy] = useState(false);
  const [melding, settMelding] = useState<string | null>(null);
  const h = useHandling();

  async function reverser(b: Regnskapsbilag) {
    const flere =
      b.kilde === "periodisering" ? " Har bilaget flere periodiseringer, reverseres alle." : b.kilde === "anlegg" ? " Har bilaget flere anleggsmidler, reverseres alle." : "";
    if (!confirm(`Reversere bilag ${b.bilagsnummer}? Det føres et nytt bilag med motsatte beløp.${flere}`)) return;
    const r = await h.kjor(() => api<Regnskapsbilag>("POST", `${sti}/bilag/${b.id}/reverser`, {}));
    if (r) {
      settMelding(`Bilag ${b.bilagsnummer} er reversert (bilag ${r.bilagsnummer}).`);
      void liste.last();
    }
  }

  const bilag = [...(liste.data?.bilag ?? [])].reverse();
  return (
    <>
      <p className="dempet liten">
        Alle bilagene i regnskapet: fakturaer og kreditnotaer (serie F) og bankpostene (B: innbetalinger, gebyrer, overføringer og annet fra banken), som bokføres av
        seg selv, utgifter (U), lønn (L, også refusjoner fra NAV),
        anleggsmidler (A), periodiseringer (P) og manuelle bilag (M), som den inngående balansen. Et bilag endres aldri; det reverseres med et nytt bilag med
        motsatte beløp. Bilagsjournalen, hovedboken og saldobalansen står også under{" "}
        <Link to="/rapporter?fane=regnskap">Rapporter → Regnskap</Link> (CSV og PDF).
      </p>
      <Maanedsstatus />
      <Maanedsavslutning bokfort={() => void liste.last()} />
      <div className="knapper lonn-knapper">
        <button type="button" className="primar" onClick={() => settNy(true)}>
          <IkonPluss /> Nytt bilag
        </button>
      </div>
      <div className="kort regnskap-filter">
        <Periodevalg fra={periode.fra} til={periode.til} endre={settPeriode} />
        <label>
          Kilde
          <select value={kilde} onChange={(e) => settKilde(e.target.value)}>
            <option value="">Alle</option>
            {Object.entries(KILDER).map(([k, t]) => (
              <option key={k} value={k}>
                {t}
              </option>
            ))}
          </select>
        </label>
      </div>
      {melding && (
        <div className="melding ok" role="status">
          {melding}
        </div>
      )}
      <Feil melding={h.feil} />
      {liste.feil ? (
        <Feil melding={liste.feil} />
      ) : !liste.data ? (
        <Laster />
      ) : !bilag.length ? (
        <div className="kort">
          <Tom ikon={<IkonRegnskap storrelse={22} />} tittel="Ingen bilag i perioden">
            <p>Bilagene kommer fra fakturaene og innbetalingene, utgiftene, lønnskjøringene, refusjonene fra NAV, anleggsmidlene og periodiseringene, og fra manuelle bilag.</p>
          </Tom>
        </div>
      ) : (
        <div className="kort liste regnskap-bilag">
          {bilag.map((b) => {
            const aapen = apen === b.id;
            const kanReverseres = !b.reverserer && !b.reversert_av && !ANDRE_STEDER[b.kilde];
            return (
              <div key={b.id} className={`regnskap-bilagsrad${aapen ? " apen" : ""}`}>
                <button type="button" className="liste-rad" aria-expanded={aapen} onClick={() => settApen(aapen ? null : b.id)}>
                  <span className="linje">
                    <span className="tittel">
                      {b.bilagsnummer} · {b.tekst}
                    </span>
                    <span className="tall">{kr(debetsum(b))}</span>
                  </span>
                  <span className="linje">
                    <span className="under">
                      {dato(b.dato)} · {KILDER[b.kilde] ?? b.kilde}
                      {b.opprettet_av && b.kilde === "manuell" ? ` · ${b.opprettet_av}` : ""}
                    </span>
                    {b.reverserer ? <span className="merke merke-noytral">Reversering</span> : b.reversert_av ? <span className="merke merke-noytral">Reversert</span> : null}
                  </span>
                </button>
                {aapen && (
                  <div className="regnskap-bilagsdetalj">
                    <Bilagstabell b={b} />
                    {b.lenke && LENKETEKST[b.kilde] && (
                      <p className="liten">
                        <Link to={b.lenke}>{LENKETEKST[b.kilde]}</Link>
                      </p>
                    )}
                    {kanReverseres ? (
                      <div className="knapper">
                        <button type="button" disabled={h.opptatt} onClick={() => void reverser(b)}>
                          Reverser
                        </button>
                      </div>
                    ) : ANDRE_STEDER[b.kilde] && !b.reverserer && !b.reversert_av ? (
                      <p className="liten dempet">{ANDRE_STEDER[b.kilde]}</p>
                    ) : null}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      <Dialog apen={ny} lukk={() => settNy(false)} tittel="Nytt bilag" bred>
        {ny && (
          <NyttBilag
            lagret={(b) => {
              settNy(false);
              settMelding(`Bilag ${b.bilagsnummer} er bokført.`);
              if (b.dato < periode.fra || b.dato > periode.til) settPeriode({ fra: b.dato < periode.fra ? b.dato : periode.fra, til: b.dato > periode.til ? b.dato : periode.til });
              else void liste.last();
              settApen(b.id);
            }}
            avbryt={() => settNy(false)}
          />
        )}
      </Dialog>
    </>
  );
}

type Linje = { konto: string; tekst: string; debet: string; kredit: string };
const tomLinje = (): Linje => ({ konto: "", tekst: "", debet: "", kredit: "" });
const ore = (s: string) => (s.trim() ? Math.round(tall(s) * 100) : 0);

// Manuelt bilag: linjer med debet eller kredit som går i null (f.eks. den inngående balansen fra
// forrige regnskapssystem, eller en faktura som ikke kommer fra HI4).
function NyttBilag({ lagret, avbryt }: { lagret: (b: Regnskapsbilag) => void; avbryt: () => void }) {
  const { org } = useKonto();
  const sti = `/org/${org!.id}/regnskap`;
  const kontoer = useData(() => hent<{ kontoer: Konto[] }>(`${sti}/kontoliste`), [sti]);
  const [s, settS] = useState({ dato: iDag(), tekst: "", linjer: [tomLinje(), tomLinje()] });
  const h = useHandling();
  const navn = (k: string) => kontoer.data?.kontoer.find((x) => x.konto === k.trim())?.navn ?? "";
  const endre = (i: number, x: Partial<Linje>) => settS({ ...s, linjer: s.linjer.map((l, j) => (j === i ? { ...l, ...x } : l)) });
  const ugyldig = s.linjer.some((l) => [l.debet, l.kredit].some((v) => v.trim() && !(Number.isFinite(tall(v)) && tall(v) >= 0)));
  const debet = ugyldig ? 0 : s.linjer.reduce((t, l) => t + ore(l.debet), 0);
  const kredit = ugyldig ? 0 : s.linjer.reduce((t, l) => t + ore(l.kredit), 0);
  const brukt = s.linjer.filter((l) => l.konto.trim() || l.debet.trim() || l.kredit.trim());
  const diff = debet - kredit;

  // Feltet som får bilaget til å gå i null, fylles inn med beløpet som mangler (og markeres, så det
  // kan skrives over).
  const fyll = (i: number, side: "debet" | "kredit", felt: HTMLInputElement) => {
    const l = s.linjer[i]!;
    if (ugyldig || l.debet.trim() || l.kredit.trim() || !diff || (side === "debet") !== diff < 0) return;
    endre(i, { [side]: String(Math.abs(diff) / 100).replace(".", ",") });
    requestAnimationFrame(() => felt.select());
  };

  async function lagre(e: FormEvent) {
    e.preventDefault();
    const r = await h.kjor(() =>
      api<Regnskapsbilag>("POST", `${sti}/bilag`, {
        dato: s.dato,
        tekst: s.tekst,
        linjer: brukt.map((l) => ({
          konto: l.konto.trim(),
          tekst: l.tekst.trim() || null,
          debet: l.debet.trim() ? tall(l.debet) : null,
          kredit: l.kredit.trim() ? tall(l.kredit) : null,
        })),
      }),
    );
    if (r) lagret(r);
  }

  return (
    <form onSubmit={lagre} className="regnskap-nytt-bilag">
      <p className="dempet liten">
        Hver linje har en konto (norsk standard kontoplan, NS 4102) og et beløp i debet eller kredit; bilaget må gå i null. Den inngående balansen føres som et bilag
        på den første dagen: eiendelene i debet, egenkapitalen og gjelden i kredit.
      </p>
      <div className="rad">
        <label>
          Dato
          <input type="date" required max={iDag()} value={s.dato} onChange={(e) => settS({ ...s, dato: e.target.value })} />
        </label>
        <label>
          Tekst
          <input required maxLength={300} value={s.tekst} onChange={(e) => settS({ ...s, tekst: e.target.value })} placeholder="F.eks. Inngående balanse 2026" />
        </label>
      </div>
      <datalist id="regnskap-kontoer">
        {kontoer.data?.kontoer.map((k) => (
          <option key={k.konto} value={k.konto}>
            {k.navn}
          </option>
        ))}
      </datalist>
      <div className="regnskap-linjer">
        <div className="regnskap-linje hode" aria-hidden>
          <span>Konto</span>
          <span>Tekst</span>
          <span className="hoyre">Debet</span>
          <span className="hoyre">Kredit</span>
          <span />
        </div>
        {s.linjer.map((l, i) => (
          <div key={i} className="regnskap-linje">
            <label className="konto">
              <span className="smal-etikett">Konto</span>
              <input inputMode="numeric" list="regnskap-kontoer" maxLength={6} value={l.konto} onChange={(e) => endre(i, { konto: e.target.value })} aria-label={`Konto, linje ${i + 1}`} />
              {navn(l.konto) && <span className="felt-hjelp">{navn(l.konto)}</span>}
            </label>
            <label className="tekst">
              <span className="smal-etikett">Tekst</span>
              <input maxLength={200} value={l.tekst} onChange={(e) => endre(i, { tekst: e.target.value })} aria-label={`Tekst, linje ${i + 1}`} />
            </label>
            <label className="debet">
              <span className="smal-etikett">Debet</span>
              <input
                inputMode="decimal"
                className="tall"
                value={l.debet}
                disabled={!!l.kredit.trim()}
                onFocus={(e) => fyll(i, "debet", e.currentTarget)}
                onChange={(e) => endre(i, { debet: e.target.value })}
                aria-label={`Debet, linje ${i + 1}`}
              />
            </label>
            <label className="kredit">
              <span className="smal-etikett">Kredit</span>
              <input
                inputMode="decimal"
                className="tall"
                value={l.kredit}
                disabled={!!l.debet.trim()}
                onFocus={(e) => fyll(i, "kredit", e.currentTarget)}
                onChange={(e) => endre(i, { kredit: e.target.value })}
                aria-label={`Kredit, linje ${i + 1}`}
              />
            </label>
            <button
              type="button"
              className="lenke fjern"
              disabled={s.linjer.length <= 2}
              onClick={() => settS({ ...s, linjer: s.linjer.filter((_, j) => j !== i) })}
              aria-label={`Fjern linje ${i + 1}`}
            >
              Fjern
            </button>
          </div>
        ))}
        <div className="regnskap-linje sum">
          <span>
            <button type="button" className="lenke" disabled={s.linjer.length >= 200} onClick={() => settS({ ...s, linjer: [...s.linjer, tomLinje()] })}>
              <IkonPluss /> Legg til linje
            </button>
          </span>
          <span className="hoyre">Sum</span>
          <span className="tall">{kr(debet / 100)}</span>
          <span className="tall">{kr(kredit / 100)}</span>
          <span />
        </div>
      </div>
      <p className={`liten ${diff || ugyldig ? "regnskap-diff" : "dempet"}`} role="status">
        {ugyldig
          ? "Et beløp er ugyldig: skriv det som et tall, f.eks. 1 250,50."
          : diff
            ? `Bilaget går ikke i null: ${diff > 0 ? "debet" : "kredit"} er ${kr(Math.abs(diff) / 100)} kr høyere.`
            : brukt.length >= 2 && debet
              ? "Bilaget går i null."
              : "Skriv minst to linjer med beløp."}
      </p>
      <Feil melding={h.feil} />
      <div className="knapper">
        <button className="primar" disabled={h.opptatt || ugyldig || !!diff || brukt.length < 2 || !debet}>
          Bokfør
        </button>
        <button type="button" onClick={avbryt}>
          Avbryt
        </button>
      </div>
    </form>
  );
}

// --- Saldobalansen og hovedboken ------------------------------------------------------------------

type Saldorad = { konto: string; navn: string; inngaende: number; debet: number; kredit: number; utgaende: number };
type Saldobalanse = { fra: string; til: string; rader: Saldorad[]; tidligere: number; resultat: number };
type Hovedbokspost = { dato: string; bilag: string; bilag_id: string; bilagstekst: string; tekst: string; debet: number | null; kredit: number | null; saldo: number };

// Kontoklassene i norsk standard kontoplan.
const KLASSER: [string, string][] = [
  ["1", "Eiendeler"],
  ["2", "Egenkapital og gjeld"],
  ["3", "Salgs- og driftsinntekter"],
  ["4", "Varekostnad"],
  ["5", "Lønnskostnader"],
  ["6", "Andre driftskostnader"],
  ["7", "Andre driftskostnader"],
  ["8", "Finansposter og skatt"],
];
const klasse = (k: string) => KLASSER.find(([c]) => k.startsWith(c))?.[1] ?? "Andre kontoer";

export function Saldobalansen() {
  const { org } = useKonto();
  const sti = `/org/${org!.id}/regnskap`;
  const [periode, settPeriode] = useState({ fra: aarsstart(), til: iDag() });
  const s = useData(() => hent<Saldobalanse>(`${sti}/saldobalanse?fra=${periode.fra}&til=${periode.til}`), [sti, periode.fra, periode.til]);
  const [konto, settKonto] = useState<Saldorad | null>(null);
  const smal = useSmal();

  const grupper: { navn: string; rader: Saldorad[] }[] = [];
  for (const r of s.data?.rader ?? []) {
    const n = klasse(r.konto);
    if (grupper.at(-1)?.navn === n) grupper.at(-1)!.rader.push(r);
    else grupper.push({ navn: n, rader: [r] });
  }
  const sum = (rader: Saldorad[], k: keyof Omit<Saldorad, "konto" | "navn">) => rader.reduce((t, r) => t + r[k], 0);
  const d = s.data;
  const eiendeler = d ? sum(d.rader.filter((r) => r.konto.startsWith("1")), "utgaende") : 0;
  const ekGjeld = d ? -sum(d.rader.filter((r) => r.konto.startsWith("2")), "utgaende") : 0;

  return (
    <>
      <p className="dempet liten">
        Saldoen per konto fra alle bilagene. Balansekontoene (klasse 1 og 2) har saldoen fra starten; resultatkontoene (klasse 3–8) begynner på null 1. januar. Trykk på
        en konto for hovedboken. Som rapport (CSV og PDF, og hver måned til regnskapsføreren):{" "}
        <Link to="/rapporter?fane=regnskap&rapport=regnskap.saldobalanse">Rapporter → Regnskap → Saldobalanse</Link>.
      </p>
      <div className="kort regnskap-filter">
        <Periodevalg fra={periode.fra} til={periode.til} endre={settPeriode} />
      </div>
      {s.feil ? (
        <Feil melding={s.feil} />
      ) : !d ? (
        <Laster />
      ) : !d.rader.length ? (
        <div className="kort">
          <Tom ikon={<IkonRegnskap storrelse={22} />} tittel="Ingen saldoer i perioden">
            <p>Saldoene kommer fra bilagene (Regnskap → Bilag).</p>
          </Tom>
        </div>
      ) : (
        <>
          <div className="nokkeltall lonn-tall">
            <div className="kort">
              <div className="etikett">Resultat i perioden</div>
              <div className="verdi">{kr(Math.abs(d.resultat))}</div>
              <div className="under">{d.resultat > 0 ? "Overskudd" : d.resultat < 0 ? "Underskudd" : "Går i null"} (inntektene minus kostnadene)</div>
            </div>
            <div className="kort">
              <div className="etikett">Eiendeler</div>
              <div className="verdi">{kr(eiendeler)}</div>
              <div className="under">Klasse 1 per {dato(d.til)}</div>
            </div>
            <div className="kort">
              <div className="etikett">Egenkapital og gjeld</div>
              <div className="verdi">{kr(ekGjeld)}</div>
              <div className="under">Klasse 2 per {dato(d.til)} (uten årets resultat)</div>
            </div>
          </div>
          <div className="kort tabell regnskap-saldobalanse">
            <table>
              <thead>
                <tr>
                  <th>Konto</th>
                  {!smal && <th className="hoyre">Inngående</th>}
                  {!smal && <th className="hoyre">Debet</th>}
                  {!smal && <th className="hoyre">Kredit</th>}
                  <th className="hoyre">Utgående</th>
                </tr>
              </thead>
              {grupper.map((g, i) => (
                <tbody key={i}>
                  <tr className="gruppe">
                    <td colSpan={smal ? 2 : 5}>{g.navn}</td>
                  </tr>
                  {g.rader.map((r) => (
                    <tr key={r.konto} className="klikkbar" onClick={() => settKonto(r)}>
                      <td>
                        {r.konto} {r.navn}
                        {smal && (
                          <span className="lonn-art">
                            Inngående {kr(r.inngaende)} · debet {kr(r.debet)} · kredit {kr(r.kredit)}
                          </span>
                        )}
                      </td>
                      {!smal && <td className="tall">{kr(r.inngaende)}</td>}
                      {!smal && <td className="tall">{r.debet ? kr(r.debet) : ""}</td>}
                      {!smal && <td className="tall">{r.kredit ? kr(r.kredit) : ""}</td>}
                      <td className="tall">{kr(r.utgaende)}</td>
                    </tr>
                  ))}
                  <tr className="delsum">
                    <td>Sum {g.navn.toLowerCase()}</td>
                    {!smal && <td className="tall">{kr(sum(g.rader, "inngaende"))}</td>}
                    {!smal && <td className="tall">{kr(sum(g.rader, "debet"))}</td>}
                    {!smal && <td className="tall">{kr(sum(g.rader, "kredit"))}</td>}
                    <td className="tall">{kr(sum(g.rader, "utgaende"))}</td>
                  </tr>
                </tbody>
              ))}
              <tfoot>
                {d.tidligere !== 0 && (
                  <tr>
                    <td>Resultat fra tidligere år (ikke ført mot egenkapitalen)</td>
                    {!smal && <td className="tall">{kr(d.tidligere)}</td>}
                    {!smal && <td />}
                    {!smal && <td />}
                    <td className="tall">{kr(d.tidligere)}</td>
                  </tr>
                )}
                <tr>
                  <td>Sum</td>
                  {!smal && <td className="tall">{kr(sum(d.rader, "inngaende") + d.tidligere)}</td>}
                  {!smal && <td className="tall">{kr(sum(d.rader, "debet"))}</td>}
                  {!smal && <td className="tall">{kr(sum(d.rader, "kredit"))}</td>}
                  <td className="tall">{kr(sum(d.rader, "utgaende") + d.tidligere)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </>
      )}
      <Dialog apen={!!konto} lukk={() => settKonto(null)} tittel={konto ? `Hovedbok ${konto.konto} ${konto.navn}`.trim() : "Hovedbok"} bred>
        {konto && <Hovedbok konto={konto} fra={periode.fra} til={periode.til} />}
      </Dialog>
    </>
  );
}

function Hovedbok({ konto, fra, til }: { konto: Saldorad; fra: string; til: string }) {
  const { org } = useKonto();
  const sti = `/org/${org!.id}/regnskap/hovedbok?fra=${fra}&til=${til}&konto=${konto.konto}`;
  const h = useData(() => hent<{ kontoer: (Saldorad & { poster: Hovedbokspost[] })[] }>(sti), [sti]);
  const smal = useSmal();
  if (h.feil) return <Feil melding={h.feil} />;
  if (!h.data) return <Laster />;
  const k = h.data.kontoer[0];
  if (!k) return <p className="dempet">Ingen posteringer i perioden.</p>;
  return (
    <>
      <p className="dempet liten">
        {dato(fra)}–{dato(til)}. Saldoen er debet minus kredit{smal ? "; kredit står med minus" : ""}.
      </p>
      <div className="tabell">
        <table className="lonn-linjer regnskap-hovedbok">
          <thead>
            <tr>
              <th>Dato</th>
              <th>{smal ? "Bilag og tekst" : "Bilag"}</th>
              {!smal && <th>Tekst</th>}
              {smal ? <th className="hoyre">Beløp og saldo</th> : <th className="hoyre">Debet</th>}
              {!smal && <th className="hoyre">Kredit</th>}
              {!smal && <th className="hoyre">Saldo</th>}
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>{dato(fra)}</td>
              <td colSpan={smal ? 1 : 4}>Inngående saldo</td>
              <td className="tall">{kr(k.inngaende)}</td>
            </tr>
            {k.poster.map((p, i) => (
              <tr key={i}>
                <td>{dato(p.dato)}</td>
                <td>
                  {p.bilag}
                  {smal && <span className="lonn-art">{p.tekst || p.bilagstekst}</span>}
                </td>
                {!smal && <td>{p.tekst && p.tekst !== p.bilagstekst ? `${p.bilagstekst}: ${p.tekst}` : p.bilagstekst}</td>}
                {smal ? (
                  <td className="tall">
                    {p.debet != null ? kr(p.debet) : `−${kr(p.kredit)}`}
                    <span className="lonn-art">{kr(p.saldo)}</span>
                  </td>
                ) : (
                  <>
                    <td className="tall">{p.debet != null ? kr(p.debet) : ""}</td>
                    <td className="tall">{p.kredit != null ? kr(p.kredit) : ""}</td>
                    <td className="tall">{kr(p.saldo)}</td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
          <tfoot>
            {smal ? (
              <tr>
                <td colSpan={2}>Utgående saldo {dato(til)}</td>
                <td className="tall">{kr(k.utgaende)}</td>
              </tr>
            ) : (
              <tr>
                <td colSpan={3}>Sum i perioden og utgående saldo</td>
                <td className="tall">{kr(k.debet)}</td>
                <td className="tall">{kr(k.kredit)}</td>
                <td className="tall">{kr(k.utgaende)}</td>
              </tr>
            )}
          </tfoot>
        </table>
      </div>
    </>
  );
}
