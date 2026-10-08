// Bemanningskalenderen: måneden med datoene nedover og de ansatte bortover, gruppe for
// gruppe (f.eks. sekretærer og leger). Hver rute viser om den ansatte er på jobb (✓, fra den
// faste arbeidsplanen eller vaktplanen), har fri (–), er borte (F ferie, S syk, SB sykt barn,
// P permisjon, K kurs, A annet) eller jobber ekstra (timene utover planen). Til høyre står hvor
// mange som er på jobb i hver gruppe mot behovet, så bemanningen kan ses opp mot hverandre, og
// nederst ekstratimene i måneden per ansatt. Trykk på en rute for å registrere fravær eller
// sette inn vikar; grupper og behov settes opp under «Grupper», og rapporten over ekstratimene
// (PDF og CSV) under «Ekstratimer».
import { useEffect, useState, type CSSProperties, type FormEvent } from "react";
import { api, hent, lastNed } from "../api";
import { Dialog, Feil, Laster, Tom, tall, useData, useHandling } from "../felles";
import { erAdmin, useKonto } from "../konto";
import { dato as visDato, iDag, leggTilDager, leggTilMaaneder } from "../format";
import { IkonAnsatte, IkonHoyre, IkonNed, IkonOpp, IkonPluss, IkonRapport, IkonVenstre } from "../ikoner";
import { gyldigDato, mandag, middag, tallformat, timer, ukenr, visDag } from "../uke";
import {
  FRAVAERTYPER,
  fravaerKlasse,
  fravaerKode,
  fravaerPeriode,
  fravaerTekst,
  FravaerSkjema,
  VikarSkjema,
  type Ansatt as Grunnansatt,
  type Fravaer,
} from "./Fravaer";
import { visLangDag } from "./Tavle";
import { ArbeidsplanDialog, fastTid, fastTider } from "./Arbeidsplan";
import type { Fast, Vakt, VaktSvar, VikarVakt } from "./Vakter";

type Ansatt = Grunnansatt & {
  stilling: string | null;
  stillingsprosent: number;
  ukentlig_arbeidstid: number;
  ansettelsestype: string;
  gruppe_id: string | null;
};
type Gruppe = { id: string; navn: string; kort: string | null; behov: number | null; rekkefolge: number; antall: number };
type Seksjon = { id: string | null; navn: string; kort: string; behov: number | null; farge: number; ansatte: Ansatt[] };
type Rute =
  | { art: "utenfor" }
  | { art: "borte"; fravaer: Fravaer; vakter: Vakt[]; utenVikar: Vakt[]; fast: Fast | null }
  | { art: "jobb"; vakter: Vakt[]; fast: Fast | null; ekstra: number; plan: boolean; utkast: boolean }
  | { art: "fri" };

const maanedFormat = new Intl.DateTimeFormat("nb-NO", { month: "long", year: "numeric", timeZone: "UTC" });
const UKEDAG = ["Sø", "Ma", "Ti", "On", "To", "Fr", "Lø"];
const FARGER = 5; // gruppefargene g0–g4 (g5 er for dem uten gruppe)
export const gyldigMaaned = (s: string | null): s is string => !!s && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
// «Sekretærer» blir «Sek.» i oppsummeringen, med mindre gruppen har en egen forkortelse.
const kortNavn = (g: Pick<Gruppe, "navn" | "kort">) => g.kort || (g.navn.length > 5 ? `${g.navn.slice(0, 3)}.` : g.navn);
const rund = (t: number) => Math.round(t * 100) / 100;
const timerTekst = (t: number) => `${tallformat.format(rund(t))}t`;
const punktum = (s: string) => (s.endsWith(".") ? s : `${s}.`);
const forstStor = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function Bemanning({
  maaned,
  velgMaaned,
  kanEndre,
  tilTavle,
  tilUke,
}: {
  maaned: string; // «2026-10»
  velgMaaned: (maaned: string) => void;
  kanEndre: boolean;
  tilTavle: (dato: string) => void;
  tilUke: (mandag: string) => void;
}) {
  const { org } = useKonto();
  // Bare eier og administrator ser hva slags fravær det er; andre ser F (0047_fravaer_skjult.sql).
  const serType = erAdmin(org?.rolle);
  const forste = `${maaned}-01`;
  const siste = leggTilDager(leggTilMaaneder(forste, 1), -1);
  // Hele uker, så ukene i kantene av måneden kommer med.
  const fra = mandag(forste);
  const til = leggTilDager(mandag(siste), 6);
  const [versjon, settVersjon] = useState(0);
  const [oppsettVersjon, settOppsettVersjon] = useState(0);
  const { data, feil } = useData(() => hent<VaktSvar>(`/org/${org!.id}/vakter?fra=${fra}&til=${til}`), [org?.id, fra, til, versjon]);
  const ansatte = useData(() => hent<Ansatt[]>(`/org/${org!.id}/ansatte`), [org?.id, versjon, oppsettVersjon]);
  const grupper = useData(() => hent<Gruppe[]>(`/org/${org!.id}/ansattgrupper`), [org?.id, oppsettVersjon]);
  const [rute, settRute] = useState<{ a: Ansatt; d: string } | null>(null);
  const [fravaer, settFravaer] = useState<Partial<Fravaer> | null>(null);
  const [vikar, settVikar] = useState<VikarVakt | null>(null);
  // Stillingsprosent, arbeidstid og faste dager for en ansatt (samme som i ansattkortet).
  const [planFor, settPlanFor] = useState<string | null>(null);
  const [oppsett, settOppsett] = useState(false);
  const [rapport, settRapport] = useState(false);
  const [melding, settMelding] = useState<string | null>(null);
  useEffect(() => settMelding(null), [maaned]);
  const endret = (m?: string) => {
    if (m) settMelding(m);
    settVersjon((x) => x + 1);
  };
  const denne = iDag().slice(0, 7);
  const navn = maanedFormat.format(middag(forste));

  const verktoy = (
    <div className="uke-verktoy">
      <div className="ukevelger">
        <button type="button" className="ikon" aria-label="Forrige måned" title="Forrige måned" onClick={() => velgMaaned(leggTilMaaneder(forste, -1).slice(0, 7))}>
          <IkonVenstre storrelse={20} />
        </button>
        <div className="uke-navn" aria-live="polite">
          <strong>{forstStor(navn)}</strong>
          <span>
            Uke {ukenr(fra).uke}–{ukenr(til).uke}
          </span>
        </div>
        <button type="button" className="ikon" aria-label="Neste måned" title="Neste måned" onClick={() => velgMaaned(leggTilMaaneder(forste, 1).slice(0, 7))}>
          <IkonHoyre storrelse={20} />
        </button>
        {maaned !== denne && (
          <button type="button" className="lenke" onClick={() => velgMaaned(denne)}>
            Denne måneden
          </button>
        )}
      </div>
      <div className="knapper bm-knapper">
        <button type="button" onClick={() => settRapport(true)}>
          <IkonRapport storrelse={17} /> Ekstratimer
        </button>
        {kanEndre && (
          <>
            <button type="button" onClick={() => settOppsett(true)}>
              <IkonAnsatte storrelse={17} /> Grupper
            </button>
            <button type="button" className="primar" onClick={() => settFravaer({ fra: iDag().startsWith(maaned) ? iDag() : forste, til: iDag().startsWith(maaned) ? iDag() : forste })}>
              Registrer fravær
            </button>
          </>
        )}
      </div>
    </div>
  );
  const rapportDialog = (
    <Dialog apen={rapport} lukk={() => settRapport(false)} tittel="Ekstratimer" bred>
      {rapport && <EkstratimerRapport fra={forste} til={siste} lukk={() => settRapport(false)} />}
    </Dialog>
  );

  const feilmelding = feil ?? ansatte.feil ?? grupper.feil;
  if (feilmelding)
    return (
      <>
        {verktoy}
        <Feil melding={feilmelding} />
        {rapportDialog}
      </>
    );
  if (!data || !ansatte.data || !grupper.data)
    return (
      <>
        {verktoy}
        <Laster />
        {rapportDialog}
      </>
    );

  // --- Utregningen -------------------------------------------------------------------------
  const nokkel = (a: string, d: string) => `${a}|${d}`;
  const vakterPer = new Map<string, Vakt[]>();
  for (const v of data.vakter) if (v.ansatt_id) vakterPer.set(nokkel(v.ansatt_id, v.dato), [...(vakterPer.get(nokkel(v.ansatt_id, v.dato)) ?? []), v]);
  // De faste arbeidsdagene (dager i arbeidsplanen uten vakt) og ekstratimene, fra serveren.
  const fastePer = new Map((data.faste ?? []).map((f) => [nokkel(f.ansatt_id, f.dato), f]));
  const ekstraPer = new Map((data.ekstra ?? []).map((e) => [nokkel(e.ansatt_id, e.dato), e]));

  // Hverdagene, og helgedager med vakter eller faste dager.
  const dager: string[] = [];
  for (let d = forste; d <= siste; d = leggTilDager(d, 1)) {
    const ukedag = middag(d).getUTCDay();
    if ((ukedag !== 0 && ukedag !== 6) || data.vakter.some((v) => v.dato === d) || (data.faste ?? []).some((f) => f.dato === d)) dager.push(d);
  }

  // Kolonnene: de som er ansatt i måneden, og alle med vakter eller fravær i den.
  const iMaaneden = (a: Ansatt) =>
    (a.aktiv && a.ansatt_fra <= siste && (!a.ansatt_til || a.ansatt_til >= forste)) ||
    data.vakter.some((v) => v.ansatt_id === a.id && v.dato >= forste && v.dato <= siste) ||
    data.fravaer.some((f) => f.ansatt_id === a.id && f.til >= forste && f.fra <= siste);
  const synlige = ansatte.data.filter(iMaaneden).sort((x, y) => x.fornavn.localeCompare(y.fornavn, "nb") || x.etternavn.localeCompare(y.etternavn, "nb"));
  const fornavn = new Map<string, number>();
  for (const a of synlige) fornavn.set(a.fornavn, (fornavn.get(a.fornavn) ?? 0) + 1);
  const visNavn = (a: Ansatt) => ((fornavn.get(a.fornavn) ?? 0) > 1 ? `${a.fornavn} ${a.etternavn.charAt(0)}.` : a.fornavn);
  const kjente = new Set(grupper.data.map((g) => g.id));
  const seksjoner: Seksjon[] = [
    ...grupper.data.map((g, i) => ({ id: g.id, navn: g.navn, kort: kortNavn(g), behov: g.behov, farge: i % FARGER, ansatte: synlige.filter((a) => a.gruppe_id === g.id) })),
    {
      id: null,
      navn: grupper.data.length ? "Uten gruppe" : "Ansatte",
      kort: grupper.data.length ? "Andre" : "På jobb",
      behov: null,
      farge: 5,
      ansatte: synlige.filter((a) => !a.gruppe_id || !kjente.has(a.gruppe_id)),
    },
  ].filter((s) => s.ansatte.length > 0);

  const ruteFor = (a: Ansatt, d: string): Rute => {
    if (!(a.ansatt_fra <= d && (!a.ansatt_til || a.ansatt_til >= d))) return { art: "utenfor" };
    const vakter = vakterPer.get(nokkel(a.id, d)) ?? [];
    const fast = fastePer.get(nokkel(a.id, d)) ?? null;
    const f = data.fravaer.find((x) => x.ansatt_id === a.id && x.fra <= d && x.til >= d);
    if (f) return { art: "borte", fravaer: f, vakter, utenVikar: vakter.filter((v) => !v.har_vikar), fast };
    if (vakter.length || fast) {
      const e = ekstraPer.get(nokkel(a.id, d));
      return { art: "jobb", vakter, fast, ekstra: Number(e?.timer ?? 0), plan: !!e?.plan, utkast: vakter.length > 0 && vakter.every((v) => !v.publisert) };
    }
    return { art: "fri" };
  };
  const paJobb = (s: Seksjon, d: string) => s.ansatte.filter((a) => ruteFor(a, d).art === "jobb").length;
  const utenVikar = (d: string) => data.vakter.filter((v) => v.dato === d && v.ansatt_id && v.fravaer && !v.har_vikar).length;
  const ledige = (d: string) => data.vakter.filter((v) => v.dato === d && !v.ansatt_id).length;
  const visUtenVikar = dager.some((d) => utenVikar(d) > 0);
  const visLedige = dager.some((d) => ledige(d) > 0);
  const harUtkast = data.vakter.some((v) => v.ansatt_id && !v.publisert && v.dato >= forste && v.dato <= siste);
  // Ekstratimene i måneden per ansatt (raden nederst).
  const ekstraMaaned = (a: string) => rund((data.ekstra ?? []).filter((e) => e.ansatt_id === a && e.dato >= forste && e.dato <= siste).reduce((sum, e) => sum + Number(e.timer), 0));
  // Oppsummeringen står fast til høyre når tabellen rulles sidelengs (på mobil bare gruppene).
  const summer = seksjoner.length + (visUtenVikar ? 1 : 0) + (visLedige ? 1 : 0);
  const hoyre = (i: number) => ({ "--h-alle": summer - 1 - i, "--h-grupper": Math.max(0, seksjoner.length - 1 - i) }) as CSSProperties;

  const beskriv = (r: Rute) => {
    if (r.art === "utenfor") return "Ikke ansatt";
    if (r.art === "fri") return "Fri";
    const deler =
      r.art === "borte"
        ? [
            `${fravaerTekst[r.fravaer.type]} ${fravaerPeriode(r.fravaer)}`,
            r.fast ? `Fast arbeidsdag ${fastTid(r.fast).toLowerCase()}` : "",
            r.utenVikar.length ? "Vakten mangler vikar" : r.vakter.length ? "Vikar er satt inn" : "",
          ]
        : [
            r.fast ? `Fast arbeidsdag ${fastTid(r.fast).toLowerCase()}` : "",
            ...r.vakter.map((v) => `${v.fra}–${v.til}${v.oppgave ? ` ${v.oppgave}` : ""}${v.publisert ? "" : " (ikke publisert)"}`),
            r.ekstra ? `${timer(rund(r.ekstra))} ekstra` : "",
          ];
    return deler.filter(Boolean).map(punktum).join(" ");
  };

  const celle = (a: Ansatt, d: string, s: Seksjon, forsteISeksjon: boolean) => {
    const r = ruteFor(a, d);
    let klasse = `bm-rute${forsteISeksjon ? " forste" : ""} g${s.farge}`;
    let innhold = "";
    if (r.art === "borte") {
      klasse += ` borte fravaer-${r.fravaer.type}${r.utenVikar.length ? " uten-vikar" : ""}`;
      innhold = fravaerKode[r.fravaer.type];
    } else if (r.art === "jobb") {
      klasse += `${r.ekstra ? " ekstra" : " jobb"}${r.utkast ? " utkast" : ""}`;
      innhold = r.ekstra ? timerTekst(r.ekstra) : "✓";
    } else if (r.art === "fri") {
      klasse += " fri";
      innhold = "–";
    } else klasse += " utenfor";
    const tekst = beskriv(r);
    return (
      <td key={a.id} className={klasse} title={tekst}>
        <button type="button" aria-label={`${a.fornavn} ${a.etternavn}, ${visDag(d)}: ${tekst}`} onClick={() => settRute({ a, d })}>
          {innhold}
        </button>
      </td>
    );
  };

  const valgt = rute && { ...rute, r: ruteFor(rute.a, rute.d) };
  // Vikar for en fast arbeidsdag uten vakt: vakten lages etter planen når vikaren settes inn.
  const vikarForFast = (a: Ansatt, f: Fast) =>
    settVikar({ id: "", dato: f.dato, ...fastTider(f), oppgave: null, ansatt_id: a.id, ansatt_navn: `${a.fornavn} ${a.etternavn}` });

  return (
    <>
      {verktoy}
      {melding && (
        <div className="melding ok" role="status">
          {melding}
        </div>
      )}
      {!grupper.data.length && kanEndre && synlige.length > 0 && (
        <div className="melding info venter">
          <span>Del de ansatte i grupper, f.eks. sekretærer og leger, for å se hvor mange som er på jobb i hver gruppe mot behovet.</span>
          <button type="button" className="lenke" onClick={() => settOppsett(true)}>
            Sett opp grupper
          </button>
        </div>
      )}
      {!synlige.length ? (
        <div className="kort">
          <Tom ikon={<IkonAnsatte storrelse={22} />} tittel="Ingen ansatte denne måneden">
            <p>Legg inn de ansatte under Ansatte, med de faste arbeidsdagene, eller vaktene i vaktplanen. Da viser kalenderen hvem som er på jobb hver dag.</p>
          </Tom>
        </div>
      ) : (
        <>
          <div className="bm-forklaring" aria-label="Forklaring">
            <span>
              <span className="bm-tegn">✓</span> På jobb
            </span>
            <span>
              <span className="bm-tegn">–</span> Fri
            </span>
            {(serType ? FRAVAERTYPER : (["fravaer"] as const)).map((t) => (
              <span key={t}>
                <span className={`bm-tegn fravaer-${t}`}>{fravaerKode[t]}</span> {t === "annet" ? "Annet" : fravaerTekst[t]}
              </span>
            ))}
            <span>
              <span className="bm-tegn ekstra">2t</span> Ekstratimer
            </span>
            <span>
              <span className={`bm-tegn uten-vikar fravaer-${serType ? "syk" : "fravaer"}`}>{serType ? "S" : "F"}</span> Vakten mangler vikar
            </span>
            {harUtkast && (
              <span>
                <span className="bm-tegn utkast">✓</span> Ikke publisert
              </span>
            )}
          </div>
          <div className="kort bemanning-ramme">
            <table className="bemanning">
              <thead>
                <tr>
                  <th rowSpan={2} className="bm-dag-hode">
                    Dag
                  </th>
                  {seksjoner.map((s) => (
                    <th key={s.id ?? "uten"} colSpan={s.ansatte.length} className={`bm-gruppe g${s.farge}`}>
                      <span className="bm-gruppe-navn">{s.navn}</span>
                    </th>
                  ))}
                  {seksjoner.map((s, i) => (
                    <th
                      key={`sum-${s.id ?? "uten"}`}
                      rowSpan={2}
                      className={`bm-sum-hode g${s.farge}${i === 0 ? " bm-sum-forste" : ""}`}
                      style={hoyre(i)}
                      title={s.behov != null ? `${s.navn}: på jobb av ${s.behov} som trengs` : `${s.navn}: på jobb`}
                    >
                      {s.kort}
                      {s.behov != null ? `/${s.behov}` : ""}
                    </th>
                  ))}
                  {visUtenVikar && (
                    <th rowSpan={2} className="bm-sum-hode bm-ekstra-sum varsel" style={hoyre(seksjoner.length)}>
                      Uten vikar
                    </th>
                  )}
                  {visLedige && (
                    <th rowSpan={2} className="bm-sum-hode bm-ekstra-sum" style={hoyre(seksjoner.length + (visUtenVikar ? 1 : 0))}>
                      Ledige
                    </th>
                  )}
                </tr>
                <tr>
                  {seksjoner.flatMap((s) =>
                    s.ansatte.map((a, j) => (
                      <th key={a.id} className={`bm-ansatt g${s.farge}${j === 0 ? " forste" : ""}`} title={`${a.fornavn} ${a.etternavn}${a.stilling ? ` · ${a.stilling}` : ""}`}>
                        {kanEndre ? (
                          // Trykk på navnet: stillingsprosent, arbeidstid og faste dager.
                          <button type="button" className="bm-ansatt-knapp" aria-label={`Arbeidstid og faste dager for ${a.fornavn} ${a.etternavn}`} onClick={() => settPlanFor(a.id)}>
                            <span className="bm-navn">{visNavn(a)}</span>
                            <span className="bm-prosent">{a.ansettelsestype === "tilkalling" ? "Tilk." : `${tallformat.format(Number(a.stillingsprosent))}%`}</span>
                          </button>
                        ) : (
                          <>
                            <span className="bm-navn">{visNavn(a)}</span>
                            <span className="bm-prosent">{a.ansettelsestype === "tilkalling" ? "Tilk." : `${tallformat.format(Number(a.stillingsprosent))}%`}</span>
                          </>
                        )}
                      </th>
                    )),
                  )}
                </tr>
              </thead>
              <tbody>
                {dager.map((d, i) => {
                  const nyUke = i > 0 && mandag(d) !== mandag(dager[i - 1]!);
                  const uv = utenVikar(d);
                  const lv = ledige(d);
                  return (
                    <tr key={d} className={`${nyUke ? "ny-uke" : ""}${d === iDag() ? " i-dag" : ""}`}>
                      <th scope="row" className="bm-dag">
                        <button type="button" className="lenke" title={`Åpne tavla for ${visDag(d).toLowerCase()}`} onClick={() => tilTavle(d)}>
                          {UKEDAG[middag(d).getUTCDay()]} <span>{Number(d.slice(8))}.</span>
                        </button>
                      </th>
                      {seksjoner.flatMap((s) => s.ansatte.map((a, j) => celle(a, d, s, j === 0)))}
                      {seksjoner.map((s, k) => {
                        const n = paJobb(s, d);
                        return (
                          <td
                            key={`sum-${s.id ?? "uten"}`}
                            className={`bm-sum${k === 0 ? " bm-sum-forste" : ""}${s.behov != null && n < s.behov ? " under" : ""}`}
                            style={hoyre(k)}
                            title={s.behov != null ? `${n} av ${s.behov} ${s.navn.toLowerCase()} på jobb` : `${n} på jobb`}
                          >
                            {n}
                            {s.behov != null ? `/${s.behov}` : ""}
                          </td>
                        );
                      })}
                      {visUtenVikar && (
                        <td className={`bm-sum bm-ekstra-sum${uv ? " under" : " null"}`} style={hoyre(seksjoner.length)}>
                          {uv || "–"}
                        </td>
                      )}
                      {visLedige && (
                        <td className={`bm-sum bm-ekstra-sum${lv ? " ledig" : " null"}`} style={hoyre(seksjoner.length + (visUtenVikar ? 1 : 0))}>
                          {lv || "–"}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="bm-fot">
                  <th scope="row" className="bm-dag" title={`Ekstratimer i ${navn}`}>
                    Ekstra
                  </th>
                  {seksjoner.flatMap((s) =>
                    s.ansatte.map((a, j) => {
                      const t = ekstraMaaned(a.id);
                      return (
                        <td
                          key={a.id}
                          className={`bm-fot-rute g${s.farge}${j === 0 ? " forste" : ""}${t ? " har" : ""}`}
                          title={`${a.fornavn} ${a.etternavn}: ${t ? timer(t) : "ingen"} ekstratimer i ${navn}`}
                        >
                          {t ? timerTekst(t) : "–"}
                        </td>
                      );
                    }),
                  )}
                  {seksjoner.map((s, k) => {
                    const t = rund(s.ansatte.reduce((sum, a) => sum + ekstraMaaned(a.id), 0));
                    return (
                      <td
                        key={`sum-${s.id ?? "uten"}`}
                        className={`bm-sum${k === 0 ? " bm-sum-forste" : ""}${t ? " ekstra" : " null"}`}
                        style={hoyre(k)}
                        title={`${s.navn}: ${t ? timer(t) : "ingen"} ekstratimer i ${navn}`}
                      >
                        {t ? timerTekst(t) : "–"}
                      </td>
                    );
                  })}
                  {visUtenVikar && <td className="bm-sum bm-ekstra-sum null" style={hoyre(seksjoner.length)} />}
                  {visLedige && <td className="bm-sum bm-ekstra-sum null" style={hoyre(seksjoner.length + (visUtenVikar ? 1 : 0))} />}
                </tr>
              </tfoot>
            </table>
          </div>
          <p className="liten dempet">
            På jobb kommer fra de faste arbeidsdagene til de ansatte (under Ansatte) og vaktplanen; en vakt gjelder i stedet for den faste dagen. Ekstratimer er timene utover
            den faste planen den dagen (uten fast plan: utover avtalt arbeidstid i uka, og alle timene for tilkallingsvikarer). Trykk på en dag for tavla, eller på en rute
            for å registrere fravær og sette inn vikar.
          </p>
        </>
      )}

      <Dialog apen={!!valgt} lukk={() => settRute(null)} tittel={valgt ? `${valgt.a.fornavn} ${valgt.a.etternavn}` : ""}>
        {valgt && (
          <div className="bm-detaljer">
            <p className="dempet" style={{ marginTop: 0 }}>
              {visLangDag(valgt.d)}
              {valgt.a.stilling ? ` · ${valgt.a.stilling}` : ""}
            </p>
            {valgt.r.art === "utenfor" && <p>Ikke ansatt denne dagen.</p>}
            {valgt.r.art === "fri" && <p>Fri (ingen fast arbeidsdag eller vakt).</p>}
            {valgt.r.art === "borte" && (
              <div className={`melding ${valgt.r.utenVikar.length ? "feil" : "info"} bm-borte`}>
                <span className={`merke ${fravaerKlasse[valgt.r.fravaer.type]}`}>{fravaerTekst[valgt.r.fravaer.type]}</span> {fravaerPeriode(valgt.r.fravaer)}
                {valgt.r.fravaer.notat ? ` · ${valgt.r.fravaer.notat}` : ""}
                {valgt.r.vakter.length > 0 && <div>{valgt.r.utenVikar.length ? "Vakten mangler vikar." : "Vikar er satt inn."}</div>}
              </div>
            )}
            {(valgt.r.art === "jobb" || valgt.r.art === "borte") && valgt.r.fast && (
              <ul className="liste-enkel">
                <li>
                  <span>
                    <span className="tittel">{fastTid(valgt.r.fast)}</span> <span className="dempet">Fast arbeidsdag · {timer(valgt.r.fast.timer)}</span>
                  </span>
                  {kanEndre && valgt.r.art === "borte" && (
                    <button
                      type="button"
                      onClick={() => {
                        const f = (valgt.r as { fast: Fast }).fast;
                        settRute(null);
                        vikarForFast(valgt.a, f);
                      }}
                    >
                      Sett inn vikar
                    </button>
                  )}
                </li>
              </ul>
            )}
            {(valgt.r.art === "jobb" || valgt.r.art === "borte") && valgt.r.vakter.length > 0 && (
              <ul className="liste-enkel">
                {valgt.r.vakter.map((v) => (
                  <li key={v.id}>
                    <span>
                      <span className="tittel">
                        {v.fra}–{v.til}
                      </span>{" "}
                      <span className="dempet">{[v.oppgave, v.vikar_for_navn ? `vikar for ${v.vikar_for_navn}` : "", v.publisert ? "" : "ikke publisert"].filter(Boolean).join(" · ")}</span>
                    </span>
                    {kanEndre && valgt.r.art === "borte" && !v.har_vikar && (
                      <button
                        type="button"
                        onClick={() => {
                          settRute(null);
                          settVikar(v);
                        }}
                      >
                        Sett inn vikar
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {valgt.r.art === "jobb" && valgt.r.ekstra > 0 && (
              <p className="liten bm-ekstra-tekst">
                <span className="bm-tegn ekstra">{timerTekst(valgt.r.ekstra)}</span>
                <span>
                  {timer(rund(valgt.r.ekstra))} ekstratimer denne dagen (
                  {valgt.r.plan
                    ? "utover den faste arbeidsplanen"
                    : valgt.a.ansettelsestype === "tilkalling"
                      ? "tilkallingsvikar: alle timene"
                      : `utover avtalt arbeidstid i uka, ${tallformat.format((Number(valgt.a.ukentlig_arbeidstid) * Number(valgt.a.stillingsprosent)) / 100)} t`}
                  ).
                </span>
              </p>
            )}
            <div className="knapper">
              {kanEndre && valgt.r.art !== "utenfor" && (
                <button
                  type="button"
                  className="primar"
                  onClick={() => {
                    const r = valgt.r;
                    settRute(null);
                    settFravaer(r.art === "borte" ? r.fravaer : { ansatt_id: valgt.a.id, fra: valgt.d, til: valgt.d });
                  }}
                >
                  {valgt.r.art === "borte" ? "Endre fraværet" : "Registrer fravær"}
                </button>
              )}
              {kanEndre && (
                <button
                  type="button"
                  onClick={() => {
                    const a = valgt.a;
                    settRute(null);
                    settPlanFor(a.id);
                  }}
                >
                  Arbeidstid og faste dager
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  settRute(null);
                  tilUke(mandag(valgt.d));
                }}
              >
                Uke {ukenr(valgt.d).uke} i vaktplanen
              </button>
            </div>
          </div>
        )}
      </Dialog>
      <Dialog apen={!!fravaer} lukk={() => settFravaer(null)} tittel={fravaer?.id ? "Endre fravær" : "Registrer fravær"}>
        {fravaer && (
          <FravaerSkjema
            fravaer={fravaer}
            ansatte={ansatte.data}
            ferdig={(m, berort) => {
              settFravaer(null);
              endret(
                berort?.length
                  ? `${m} ${berort.length === 1 ? "Én vakt" : `${berort.length} vakter`} i perioden mangler vikar: ${berort.map((v) => `${visDag(v.dato)} ${v.fra}–${v.til}`).join(", ")}.`
                  : m,
              );
            }}
            avbryt={() => settFravaer(null)}
          />
        )}
      </Dialog>
      <Dialog apen={!!vikar} lukk={() => settVikar(null)} tittel="Sett inn vikar">
        {vikar && (
          <VikarSkjema
            vakt={vikar}
            ansatte={ansatte.data}
            fravaer={data.fravaer}
            opptatt={
              new Map([
                ...(data.faste ?? []).filter((f) => f.dato === vikar.dato && !f.fravaer).map((f) => [f.ansatt_id, fastTid(f).toLowerCase()] as const),
                ...data.vakter.filter((v) => v.dato === vikar.dato && v.ansatt_id).map((v) => [v.ansatt_id!, `${v.fra}–${v.til}`] as const),
              ])
            }
            hentVaktId={async () => (await api<Vakt>("POST", `/org/${org!.id}/vakter/fra-plan`, { ansatt_id: vikar.ansatt_id, dato: vikar.dato })).id}
            ferdig={(m) => {
              settVikar(null);
              endret(m);
            }}
            avbryt={() => settVikar(null)}
          />
        )}
      </Dialog>
      <ArbeidsplanDialog
        ansattId={planFor}
        lukk={() => settPlanFor(null)}
        lagret={(m) => {
          settPlanFor(null);
          endret(m);
        }}
      />
      <Dialog apen={oppsett} lukk={() => settOppsett(false)} tittel="Grupper og behov" bred>
        {oppsett && <GrupperOppsett grupper={grupper.data} ansatte={ansatte.data} endret={() => settOppsettVersjon((x) => x + 1)} lukk={() => settOppsett(false)} />}
      </Dialog>
      {rapportDialog}
    </>
  );
}

// --- Rapporten over ekstratimer --------------------------------------------------------------

type Rapport = {
  fra: string;
  til: string;
  sum: number;
  ansatte: { ansatt_id: string; ansattnummer: number; navn: string; gruppe: string | null; stilling: string | null; stillingsprosent: number; timer: number; dager: { dato: string; timer: number; vakter: string }[] }[];
};

// Ekstratimer per ansatt i en periode (som i kalenderen), med nedlasting som PDF og CSV.
function EkstratimerRapport({ fra: start, til: slutt, lukk }: { fra: string; til: string; lukk: () => void }) {
  const { org } = useKonto();
  const [periode, settPeriode] = useState({ fra: start, til: slutt });
  const { fra, til } = periode;
  const gyldig = gyldigDato(fra) && gyldigDato(til) && fra <= til;
  const { data, feil, laster } = useData(() => (gyldig ? hent<Rapport>(`/org/${org!.id}/ekstratimer?fra=${fra}&til=${til}`) : Promise.resolve(null)), [org?.id, fra, til]);
  const h = useHandling();
  const iDagen = iDag();
  const denneMnd = `${iDagen.slice(0, 7)}-01`;
  const forrigeMnd = leggTilMaaneder(denneMnd, -1);
  const valg: [string, { fra: string; til: string }][] = [
    ["Denne måneden", { fra: denneMnd, til: leggTilDager(leggTilMaaneder(denneMnd, 1), -1) }],
    ["Forrige måned", { fra: forrigeMnd, til: leggTilDager(denneMnd, -1) }],
    ["Hittil i år", { fra: `${iDagen.slice(0, 4)}-01-01`, til: iDagen }],
  ];
  const last = (format: "pdf" | "csv") => h.kjor(() => lastNed(`/org/${org!.id}/ekstratimer.${format}?fra=${fra}&til=${til}`, `ekstratimer-${fra}-${til}.${format}`));

  return (
    <div className="ekstra-rapport">
      <p className="dempet" style={{ marginTop: 0 }}>
        Timene utover den faste arbeidsplanen den dagen, per ansatt (uten fast plan: utover avtalt arbeidstid i uka, og alle timene for tilkallingsvikarer). Vakter den
        ansatte er borte fra, teller ikke.
      </p>
      <div className="rad">
        <label>
          Fra
          <input type="date" required value={fra} max={til || undefined} onChange={(e) => settPeriode({ ...periode, fra: e.target.value })} />
        </label>
        <label>
          Til
          <input type="date" required value={til} min={fra || undefined} onChange={(e) => settPeriode({ ...periode, til: e.target.value })} />
        </label>
      </div>
      <div className="knapper ekstra-perioder">
        {valg.map(([t, p]) => (
          <button key={t} type="button" className={p.fra === fra && p.til === til ? "valgt" : undefined} aria-pressed={p.fra === fra && p.til === til} onClick={() => settPeriode(p)}>
            {t}
          </button>
        ))}
      </div>
      {!gyldig ? (
        <p className="felt-feil">Velg en periode der slutten ikke er før starten.</p>
      ) : feil ? (
        <Feil melding={feil} />
      ) : !data || laster ? (
        <Laster />
      ) : !data.ansatte.length ? (
        <p className="ekstra-tom">Ingen ekstratimer {visDato(fra)}–{visDato(til)}.</p>
      ) : (
        <div className="tabell ekstra-tabell">
          <table>
            <thead>
              <tr>
                <th>Ansatt</th>
                <th className="tall">Dager</th>
                <th className="tall">Ekstratimer</th>
              </tr>
            </thead>
            <tbody>
              {data.ansatte.map((a) => (
                <tr key={a.ansatt_id}>
                  <td>
                    <span className="ekstra-navn">{a.navn}</span>
                    <span className="ekstra-under">
                      {/* «Sekretærer · Sekretær» blir bare «Sekretærer» */}
                      {[a.gruppe, a.gruppe && a.stilling && a.gruppe.toLowerCase().startsWith(a.stilling.toLowerCase()) ? null : a.stilling, `${tallformat.format(a.stillingsprosent)} %`]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                    <span className="ekstra-datoer">{a.dager.map((d) => `${visDato(d.dato).slice(0, 5)}: ${tallformat.format(d.timer)} t`).join(", ")}</span>
                  </td>
                  <td className="tall">{a.dager.length}</td>
                  <td className="tall">
                    <strong>{timer(a.timer)}</strong>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td>Sum</td>
                <td className="tall">{data.ansatte.reduce((n, a) => n + a.dager.length, 0)}</td>
                <td className="tall">{timer(data.sum)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
      <Feil melding={h.feil} />
      <div className="knapper">
        <button type="button" className="primar" disabled={!gyldig || h.opptatt} onClick={() => last("pdf")}>
          Last ned PDF
        </button>
        <button type="button" disabled={!gyldig || h.opptatt} onClick={() => last("csv")}>
          Last ned CSV
        </button>
        <button type="button" onClick={lukk} style={{ marginLeft: "auto" }}>
          Lukk
        </button>
      </div>
    </div>
  );
}

// --- Grupper -------------------------------------------------------------------------------

function GrupperOppsett({ grupper, ansatte, endret, lukk }: { grupper: Gruppe[]; ansatte: Ansatt[]; endret: () => void; lukk: () => void }) {
  const { org } = useKonto();
  const [rediger, settRediger] = useState<string | null>(null); // id-en, eller «ny»
  const [melding, settMelding] = useState<string | null>(null);
  const h = useHandling();
  const aktive = ansatte.filter((a) => a.aktiv).sort((x, y) => x.fornavn.localeCompare(y.fornavn, "nb") || x.etternavn.localeCompare(y.etternavn, "nb"));
  const fraStillinger = aktive.some((a) => !a.gruppe_id && a.stilling?.trim());

  const flytt = (i: number, til: number) =>
    h.kjor(async () => {
      const ider = grupper.map((g) => g.id);
      const [x] = ider.splice(i, 1);
      ider.splice(til, 0, x!);
      await api("POST", `/org/${org!.id}/ansattgrupper/rekkefolge`, { ider });
      endret();
    });
  const slett = (g: Gruppe) =>
    h.kjor(async () => {
      if (!confirm(`Slette gruppen «${g.navn}»? De ansatte i den står uten gruppe.`)) return;
      await api("DELETE", `/org/${org!.id}/ansattgrupper/${g.id}`);
      endret();
    });
  const lagFraStillinger = () =>
    h.kjor(async () => {
      const r = await api<{ grupper: number; ansatte: number }>("POST", `/org/${org!.id}/ansattgrupper/fra-stillinger`);
      settMelding(
        r.ansatte
          ? `${r.ansatte} ${r.ansatte === 1 ? "ansatt er satt" : "ansatte er satt"} i grupper etter stillingen${r.grupper ? ` (${r.grupper} ${r.grupper === 1 ? "ny gruppe" : "nye grupper"})` : ""}.`
          : "Ingen å sette i grupper.",
      );
      endret();
    });
  const settGruppe = (a: Ansatt, gruppe: string) =>
    h.kjor(async () => {
      await api("PATCH", `/org/${org!.id}/ansatte/${a.id}`, { gruppe_id: gruppe || null });
      endret();
    });
  const ferdig = () => {
    settRediger(null);
    endret();
  };

  return (
    <>
      <section className="oppsett-del">
        <h3>Grupper</h3>
        <p className="liten dempet">
          Gruppene står ved siden av hverandre i kalenderen, med hvor mange som er på jobb hver dag mot behovet (hvor mange som trengs).
        </p>
        {melding && (
          <div className="melding ok" role="status">
            {melding}
          </div>
        )}
        {grupper.length > 0 && (
          <ul className="liste-enkel oppsett-liste">
            {grupper.map((g, i) =>
              rediger === g.id ? (
                <li key={g.id}>
                  <GruppeSkjema gruppe={g} ferdig={ferdig} avbryt={() => settRediger(null)} />
                </li>
              ) : (
                <li key={g.id}>
                  <span>
                    <span className="tittel">{g.navn}</span>{" "}
                    <span className="dempet">
                      {[kortNavn(g), g.behov != null ? `trenger ${g.behov} per dag` : "", `${g.antall} ${g.antall === 1 ? "ansatt" : "ansatte"}`].filter(Boolean).join(" · ")}
                    </span>
                  </span>
                  <span className="knapper">
                    <button type="button" className="ikon" aria-label={`Flytt ${g.navn} opp`} title="Flytt opp (lenger til venstre i kalenderen)" disabled={i === 0 || h.opptatt} onClick={() => flytt(i, i - 1)}>
                      <IkonOpp storrelse={16} />
                    </button>
                    <button
                      type="button"
                      className="ikon"
                      aria-label={`Flytt ${g.navn} ned`}
                      title="Flytt ned (lenger til høyre i kalenderen)"
                      disabled={i === grupper.length - 1 || h.opptatt}
                      onClick={() => flytt(i, i + 1)}
                    >
                      <IkonNed storrelse={16} />
                    </button>
                    <button type="button" onClick={() => settRediger(g.id)}>
                      Endre
                    </button>
                    <button type="button" className="fare" disabled={h.opptatt} onClick={() => slett(g)}>
                      Slett
                    </button>
                  </span>
                </li>
              ),
            )}
          </ul>
        )}
        {rediger === "ny" ? (
          <GruppeSkjema ferdig={ferdig} avbryt={() => settRediger(null)} />
        ) : (
          <div className="knapper">
            <button type="button" onClick={() => settRediger("ny")}>
              <IkonPluss storrelse={16} /> Ny gruppe
            </button>
            {fraStillinger && (
              <button type="button" disabled={h.opptatt} onClick={lagFraStillinger}>
                Lag grupper fra stillingene
              </button>
            )}
          </div>
        )}
        <Feil melding={h.feil} />
      </section>
      {grupper.length > 0 && aktive.length > 0 && (
        <section className="oppsett-del">
          <h3>Ansatte</h3>
          <p className="liten dempet">Velg gruppen til hver ansatt (også under Ansatte).</p>
          <ul className="liste-enkel oppsett-liste bm-ansattliste">
            {aktive.map((a) => (
              <li key={a.id}>
                <span>
                  <span className="tittel">
                    {a.fornavn} {a.etternavn}
                  </span>{" "}
                  <span className="dempet">{a.stilling ?? ""}</span>
                </span>
                <select key={a.gruppe_id ?? ""} defaultValue={a.gruppe_id ?? ""} aria-label={`Gruppe for ${a.fornavn} ${a.etternavn}`} onChange={(e) => settGruppe(a, e.target.value)}>
                  <option value="">Uten gruppe</option>
                  {grupper.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.navn}
                    </option>
                  ))}
                </select>
              </li>
            ))}
          </ul>
        </section>
      )}
      <div className="knapper oppsett-ferdig">
        <button type="button" className="primar" onClick={lukk}>
          Ferdig
        </button>
      </div>
    </>
  );
}

function GruppeSkjema({ gruppe, ferdig, avbryt }: { gruppe?: Gruppe; ferdig: () => void; avbryt: () => void }) {
  const { org } = useKonto();
  const [v, settV] = useState({ navn: gruppe?.navn ?? "", kort: gruppe?.kort ?? "", behov: gruppe?.behov != null ? String(gruppe.behov) : "" });
  const h = useHandling();
  const sett = (e: Partial<typeof v>) => settV({ ...v, ...e });

  async function lagre(e: FormEvent) {
    e.preventDefault();
    const behov = v.behov.trim() === "" ? null : tall(v.behov);
    if (behov !== null && !(Number.isInteger(behov) && behov >= 0)) return h.settFeil("Skriv behovet som et helt tall");
    const kropp = { navn: v.navn.trim(), kort: v.kort.trim() || null, behov };
    const r = await h.kjor(async () => {
      if (gruppe) await api("PATCH", `/org/${org!.id}/ansattgrupper/${gruppe.id}`, kropp);
      else await api("POST", `/org/${org!.id}/ansattgrupper`, kropp);
      return true;
    });
    if (r) ferdig();
  }

  return (
    <form className="oppsett-skjema" onSubmit={lagre}>
      <div className="rad fase-felt">
        <label>
          Navn
          <input required autoFocus maxLength={40} placeholder="F.eks. Sekretærer" value={v.navn} onChange={(e) => sett({ navn: e.target.value })} />
        </label>
        <label>
          Forkortelse
          <input maxLength={8} placeholder={v.navn.trim() ? kortNavn({ navn: v.navn.trim(), kort: null }) : "F.eks. Sek."} value={v.kort} onChange={(e) => sett({ kort: e.target.value })} />
        </label>
        <label>
          Behov per dag
          <input inputMode="numeric" placeholder="Valgfritt" value={v.behov} onChange={(e) => sett({ behov: e.target.value })} />
        </label>
      </div>
      <p className="felt-hjelp oppsett-hjelp">Behovet er hvor mange i gruppen som trengs på jobb hver dag. Forkortelsen står over oppsummeringen i kalenderen.</p>
      <Feil melding={h.feil} />
      <div className="knapper">
        <button className="primar" disabled={h.opptatt}>
          {gruppe ? "Lagre" : "Legg til"}
        </button>
        <button type="button" onClick={avbryt}>
          Avbryt
        </button>
      </div>
    </form>
  );
}
