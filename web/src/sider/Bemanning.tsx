// Bemanningskalenderen: måneden med datoene nedover og de ansatte bortover, gruppe for
// gruppe (f.eks. sekretærer og leger). Hver rute viser om den ansatte er på jobb (✓, fra
// vaktplanen), har fri (–), er borte (F ferie, S syk, SB sykt barn, P permisjon, K kurs,
// A annet) eller jobber ekstra (timene utover avtalt arbeidstid i uka). Til høyre står hvor
// mange som er på jobb i hver gruppe mot behovet, så bemanningen kan ses opp mot hverandre.
// Trykk på en rute for å registrere fravær eller sette inn vikar; grupper og behov settes
// opp under «Grupper».
import { useEffect, useState, type CSSProperties, type FormEvent } from "react";
import { api, hent } from "../api";
import { Dialog, Feil, Laster, Tom, tall, useData, useHandling } from "../felles";
import { useKonto } from "../konto";
import { iDag, leggTilDager, leggTilMaaneder } from "../format";
import { IkonAnsatte, IkonHoyre, IkonNed, IkonOpp, IkonPluss, IkonVenstre } from "../ikoner";
import { mandag, middag, tallformat, ukenr, visDag } from "../uke";
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
import type { Vakt, VaktSvar } from "./Vakter";

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
  | { art: "borte"; fravaer: Fravaer; vakter: Vakt[]; utenVikar: Vakt[] }
  | { art: "jobb"; vakter: Vakt[]; ekstra: number; utkast: boolean }
  | { art: "fri" };

const maanedFormat = new Intl.DateTimeFormat("nb-NO", { month: "long", year: "numeric", timeZone: "UTC" });
const UKEDAG = ["Sø", "Ma", "Ti", "On", "To", "Fr", "Lø"];
const FARGER = 5; // gruppefargene g0–g4 (g5 er for dem uten gruppe)
export const gyldigMaaned = (s: string | null): s is string => !!s && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
// «Sekretærer» blir «Sek.» i oppsummeringen, med mindre gruppen har en egen forkortelse.
const kortNavn = (g: Pick<Gruppe, "navn" | "kort">) => g.kort || (g.navn.length > 5 ? `${g.navn.slice(0, 3)}.` : g.navn);
const timerTekst = (t: number) => `${tallformat.format(Math.round(t * 100) / 100)}t`;
const punktum = (s: string) => (s.endsWith(".") ? s : `${s}.`);
const avtalt = (a: Ansatt) => (a.ansettelsestype === "tilkalling" ? 0 : (Number(a.ukentlig_arbeidstid) * Number(a.stillingsprosent)) / 100);

// Timene utover avtalt arbeidstid, per ansatt og dag: vaktene i hver uke legges sammen i
// rekkefølge, og det som går over avtalt arbeidstid (alt for tilkallingsvikarer), er ekstra.
// Vakter den ansatte er borte fra, teller ikke.
function ekstraTimer(vakter: Vakt[], ansatte: Map<string, Ansatt>) {
  const perUke = new Map<string, Vakt[]>();
  for (const v of vakter) {
    if (!v.ansatt_id || v.fravaer) continue;
    const k = `${v.ansatt_id}|${mandag(v.dato)}`;
    perUke.set(k, [...(perUke.get(k) ?? []), v]);
  }
  const ut = new Map<string, number>();
  for (const [k, liste] of perUke) {
    const a = ansatte.get(k.split("|")[0]!);
    if (!a) continue;
    const grense = avtalt(a);
    let sum = 0;
    for (const v of liste.sort((x, y) => x.dato.localeCompare(y.dato) || x.fra.localeCompare(y.fra))) {
      const t = Number(v.timer);
      const ekstra = Math.max(0, Math.min(t, sum + t - grense));
      sum += t;
      if (ekstra > 0.01) ut.set(`${v.ansatt_id}|${v.dato}`, (ut.get(`${v.ansatt_id}|${v.dato}`) ?? 0) + ekstra);
    }
  }
  return ut;
}

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
  const forste = `${maaned}-01`;
  const siste = leggTilDager(leggTilMaaneder(forste, 1), -1);
  // Hele uker, så ekstratimene i ukene i kantene av måneden regnes riktig.
  const fra = mandag(forste);
  const til = leggTilDager(mandag(siste), 6);
  const [versjon, settVersjon] = useState(0);
  const [oppsettVersjon, settOppsettVersjon] = useState(0);
  const { data, feil } = useData(() => hent<VaktSvar>(`/org/${org!.id}/vakter?fra=${fra}&til=${til}`), [org?.id, fra, til, versjon]);
  const ansatte = useData(() => hent<Ansatt[]>(`/org/${org!.id}/ansatte`), [org?.id, versjon, oppsettVersjon]);
  const grupper = useData(() => hent<Gruppe[]>(`/org/${org!.id}/ansattgrupper`), [org?.id, oppsettVersjon]);
  const [rute, settRute] = useState<{ a: Ansatt; d: string } | null>(null);
  const [fravaer, settFravaer] = useState<Partial<Fravaer> | null>(null);
  const [vikar, settVikar] = useState<Vakt | null>(null);
  const [oppsett, settOppsett] = useState(false);
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
          <strong>{navn.charAt(0).toUpperCase() + navn.slice(1)}</strong>
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
      {kanEndre && (
        <div className="knapper">
          <button type="button" onClick={() => settOppsett(true)}>
            <IkonAnsatte storrelse={17} /> Grupper
          </button>
          <button type="button" className="primar" onClick={() => settFravaer({ fra: iDag().startsWith(maaned) ? iDag() : forste, til: iDag().startsWith(maaned) ? iDag() : forste })}>
            Registrer fravær
          </button>
        </div>
      )}
    </div>
  );

  const feilmelding = feil ?? ansatte.feil ?? grupper.feil;
  if (feilmelding)
    return (
      <>
        {verktoy}
        <Feil melding={feilmelding} />
      </>
    );
  if (!data || !ansatte.data || !grupper.data)
    return (
      <>
        {verktoy}
        <Laster />
      </>
    );

  // --- Utregningen -------------------------------------------------------------------------
  const alle = new Map(ansatte.data.map((a) => [a.id, a]));
  const vakterPer = new Map<string, Vakt[]>();
  for (const v of data.vakter) if (v.ansatt_id) vakterPer.set(`${v.ansatt_id}|${v.dato}`, [...(vakterPer.get(`${v.ansatt_id}|${v.dato}`) ?? []), v]);
  const ekstra = ekstraTimer(data.vakter, alle);

  // Hverdagene, og helgedager med vakter.
  const dager: string[] = [];
  for (let d = forste; d <= siste; d = leggTilDager(d, 1)) {
    const ukedag = middag(d).getUTCDay();
    if ((ukedag !== 0 && ukedag !== 6) || data.vakter.some((v) => v.dato === d)) dager.push(d);
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
    const vakter = vakterPer.get(`${a.id}|${d}`) ?? [];
    const f = data.fravaer.find((x) => x.ansatt_id === a.id && x.fra <= d && x.til >= d);
    if (f) return { art: "borte", fravaer: f, vakter, utenVikar: vakter.filter((v) => !v.har_vikar) };
    if (vakter.length) return { art: "jobb", vakter, ekstra: ekstra.get(`${a.id}|${d}`) ?? 0, utkast: vakter.every((v) => !v.publisert) };
    return { art: "fri" };
  };
  const paJobb = (s: Seksjon, d: string) => s.ansatte.filter((a) => (vakterPer.get(`${a.id}|${d}`) ?? []).some((v) => !v.fravaer)).length;
  const utenVikar = (d: string) => data.vakter.filter((v) => v.dato === d && v.ansatt_id && v.fravaer && !v.har_vikar).length;
  const ledige = (d: string) => data.vakter.filter((v) => v.dato === d && !v.ansatt_id).length;
  const visUtenVikar = dager.some((d) => utenVikar(d) > 0);
  const visLedige = dager.some((d) => ledige(d) > 0);
  const harUtkast = data.vakter.some((v) => v.ansatt_id && !v.publisert && v.dato >= forste && v.dato <= siste);
  // Oppsummeringen står fast til høyre når tabellen rulles sidelengs (på mobil bare gruppene).
  const summer = seksjoner.length + (visUtenVikar ? 1 : 0) + (visLedige ? 1 : 0);
  const hoyre = (i: number) => ({ "--h-alle": summer - 1 - i, "--h-grupper": Math.max(0, seksjoner.length - 1 - i) }) as CSSProperties;

  const beskriv = (r: Rute) => {
    if (r.art === "utenfor") return "Ikke ansatt";
    if (r.art === "fri") return "Fri";
    const deler =
      r.art === "borte"
        ? [`${fravaerTekst[r.fravaer.type]} ${fravaerPeriode(r.fravaer)}`, r.utenVikar.length ? "Vakten mangler vikar" : r.vakter.length ? "Vikar er satt inn" : ""]
        : [
            ...r.vakter.map((v) => `${v.fra}–${v.til}${v.oppgave ? ` ${v.oppgave}` : ""}${v.publisert ? "" : " (ikke publisert)"}`),
            r.ekstra ? `${timerTekst(r.ekstra).replace("t", " t")} utover avtalt arbeidstid` : "",
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
            <p>Legg inn de ansatte under Ansatte, og vaktene i vaktplanen. Da viser kalenderen hvem som er på jobb hver dag.</p>
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
            {FRAVAERTYPER.map((t) => (
              <span key={t}>
                <span className={`bm-tegn fravaer-${t}`}>{fravaerKode[t]}</span> {t === "annet" ? "Annet" : fravaerTekst[t]}
              </span>
            ))}
            <span>
              <span className="bm-tegn ekstra">7,5t</span> Ekstratimer
            </span>
            <span>
              <span className="bm-tegn fravaer-syk uten-vikar">S</span> Vakten mangler vikar
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
                        <span className="bm-navn">{visNavn(a)}</span>
                        <span className="bm-prosent">{a.ansettelsestype === "tilkalling" ? "Tilk." : `${tallformat.format(Number(a.stillingsprosent))}%`}</span>
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
            </table>
          </div>
          <p className="liten dempet">
            På jobb og ekstratimer kommer fra vaktplanen: ekstratimer er timene utover avtalt arbeidstid i uka (alle timene for tilkallingsvikarer). Trykk på en dag for tavla,
            eller på en rute for å registrere fravær og sette inn vikar.
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
            {valgt.r.art === "fri" && <p>Fri (ingen vakt i vaktplanen).</p>}
            {valgt.r.art === "borte" && (
              <div className={`melding ${valgt.r.utenVikar.length ? "feil" : "info"} bm-borte`}>
                <span className={`merke ${fravaerKlasse[valgt.r.fravaer.type]}`}>{fravaerTekst[valgt.r.fravaer.type]}</span> {fravaerPeriode(valgt.r.fravaer)}
                {valgt.r.fravaer.notat ? ` · ${valgt.r.fravaer.notat}` : ""}
                {valgt.r.vakter.length > 0 && <div>{valgt.r.utenVikar.length ? "Vakten mangler vikar." : "Vikar er satt inn."}</div>}
              </div>
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
              <p className="liten">
                {timerTekst(valgt.r.ekstra).replace("t", " t")} utover avtalt arbeidstid denne uka ({tallformat.format(avtalt(valgt.a))} t).
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
            opptatt={new Map(data.vakter.filter((v) => v.dato === vikar.dato && v.ansatt_id).map((v) => [v.ansatt_id!, `${v.fra}–${v.til}`]))}
            ferdig={(m) => {
              settVikar(null);
              endret(m);
            }}
            avbryt={() => settVikar(null)}
          />
        )}
      </Dialog>
      <Dialog apen={oppsett} lukk={() => settOppsett(false)} tittel="Grupper og behov" bred>
        {oppsett && <GrupperOppsett grupper={grupper.data} ansatte={ansatte.data} endret={() => settOppsettVersjon((x) => x + 1)} lukk={() => settOppsett(false)} />}
      </Dialog>
    </>
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
