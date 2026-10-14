// Turnus i vaktplanen (0106_turnus.sql, server/src/turnus.ts): de ansatte nedover og dagene
// bortover i flere uker, med vakttypen hver dag (D, K, N …) i sin farge, fraværet, og nederst hvor
// mange som er satt på hver vakttype mot behovet. Eier og administrator setter folk på vaktene rett
// i rutene (trykk, eller skriv koden; Delete fjerner, pilene flytter), og lar automatisk turnus
// lage et forslag for en periode, som legges inn som utkast og publiseres som før. Oppsettet
// (vakttypene, behovet per ukedag og rolle, hvem som går hvilke vakttyper og reglene) står under
// «Oppsett». De ansatte ser den publiserte turnusen.
//
// «Turnus for» viser turnusen til én person i stedet (PersonTurnus.tsx): kalenderen uke for uke med
// hvem personen er på jobb sammen med. De ansatte ser sin egen som standard, og kan velge kollegaene
// eller alle (?person=alle eller id-en); eier og administrator ser alle som standard.
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { api, hent } from "../api";
import { Dialog, Feil, Laster, Tom, tall, useData, useHandling } from "../felles";
import { useKonto } from "../konto";
import { iDag, leggTilDager } from "../format";
import { IkonInnstillinger, IkonKalender, IkonRullering } from "../ikoner";
import { erHelg, Klokkeslett, mandag, middag, regnTimer, tallformat, timer, ukenr, visDag } from "../uke";
import { helligdag } from "../helligdager";
import { fravaerKlasse, fravaerKode, fravaerTekst, type FravaerType } from "./Fravaer";
import { rollevalg, Rollevalg, type Rolle, type Rollevalget } from "./Roller";
import { Periodevelger, type Fast, type Vakt, type VaktSvar } from "./Vakter";
import { PersonTurnus } from "./PersonTurnus";

export type Vakttype = { id: string; navn: string; kode: string; fra: string; til: string; pause_min: number; timer: number; farge: number; aktiv: boolean; rekkefolge: number };
export type TurnusBehov = { vakttype_id: string; ukedag: number; rolle_id: string | null; antall: number };
export type TurnusRegler = { hvile: number; dager_paa_rad: number; netter_paa_rad: number; helg: number };
type TurnusAnsatt = { id: string; navn: string; rolle_id: string | null; aktiv: boolean; ansettelsestype: string; avtalt: number; vakttyper: string[] };
type Kjoring = { id: string; fra: string; til: string; vakter: number; ledige: number; hull: number; opprettet: string; utkast: number; publisert: number };
export type TurnusSvar = { vakttyper: Vakttype[]; behov: TurnusBehov[]; regler: TurnusRegler; ansatte: TurnusAnsatt[]; kjoringer: Kjoring[] };
type Person = { id: string; fornavn: string; etternavn: string; forkortelse?: string | null; gruppe_id?: string | null; ansatt_fra: string; ansatt_til: string | null; aktiv: boolean };
type Forslag = {
  vakter: { ansatt_id: string | null; dato: string; vakttype_id: string; rolle_id: string | null; fra: string; til: string; timer: number }[];
  hull: { dato: string; vakttype_id: string; rolle_id: string | null; antall: number; grunn: string }[];
  personer: { ansatt_id: string; navn: string; maal: number; timer: number; nye: number; netter: number; helger: number; per_type: Record<string, number> }[];
};

export const FARGER = 8;
export const STANDARDTYPER = [
  { navn: "Dagvakt", kode: "D", fra: "07:00", til: "15:00", pause_min: 30 },
  { navn: "Kveldsvakt", kode: "K", fra: "15:00", til: "23:00", pause_min: 30 },
  { navn: "Nattevakt", kode: "N", fra: "23:00", til: "07:00", pause_min: 0 },
];
const UKEDAGER = ["Ma", "Ti", "On", "To", "Fr", "Lø", "Sø"];
const HELGVALG: [number, string][] = [
  [1, "Alle helger"],
  [2, "Annenhver helg"],
  [3, "Hver tredje helg"],
  [4, "Hver fjerde helg"],
  [5, "Hver femte helg"],
  [6, "Hver sjette helg"],
];
const dagTall = (iso: string) => Number(iso.slice(8, 10));
const ukedagNr = (iso: string) => ((middag(iso).getUTCDay() + 6) % 7) + 1; // 1 = mandag
// Helligdagene bemannes som søndager (samme som planleggeren på serveren).
const behovsdag = (iso: string) => (helligdag(iso) ? 7 : ukedagNr(iso));
const tid = (v: { fra: string; til: string }) => `${v.fra}–${v.til}`;
const kort = (v: { fra: string; til: string }) => `${v.fra.slice(0, 2)}–${v.til.slice(0, 2)}`;
const tekstTall = (n: number) => tallformat.format(Math.round(n * 100) / 100);

export const useTurnus = (orgId: string | undefined, versjon: number) =>
  useData(() => (orgId ? hent<TurnusSvar>(`/org/${orgId}/turnus`) : Promise.resolve(null)), [orgId, versjon]);

// Koden til vakttypen i fargen sin, f.eks. «N» for nattevakt.
export function VakttypeMerke({ t, tittel }: { t: { kode: string; farge: number }; tittel?: string }) {
  return (
    <span className={`vt-merke vt${t.farge % FARGER}`} title={tittel}>
      {t.kode}
    </span>
  );
}

export function Turnus({
  start,
  uker,
  velg,
  kanPlanlegge,
  seAlle,
  versjon,
  endret,
  visningsvalg,
  rollevalget,
  person,
  velgPerson,
}: {
  start: string; // mandagen perioden begynner
  uker: number;
  velg: (start: string, uker: number) => void;
  kanPlanlegge: boolean;
  seAlle: boolean;
  versjon: number;
  endret: () => void;
  visningsvalg: ReactNode;
  rollevalget: Rollevalget;
  person: string | null; // «alle», id-en til en person, eller null: standard
  velgPerson: (person: string | null) => void;
}) {
  const { org } = useKonto();
  const fra = start;
  const til = leggTilDager(start, uker * 7 - 1);
  const turnus = useTurnus(org?.id, versjon);
  const personer = useData(() => hent<Person[]>(`/org/${org!.id}/${seAlle ? "ansatte" : "kolleger"}`), [org?.id, seAlle, versjon]);
  const grupper = useData(() => hent<Rolle[]>(`/org/${org!.id}/ansattgrupper`), [org?.id, versjon]);
  const plan = useData(() => hent<VaktSvar>(`/org/${org!.id}/vakter?fra=${fra}&til=${til}`), [org?.id, fra, til, versjon]);
  const [rute, settRute] = useState<{ ansatt: string; dato: string } | null>(null);
  const [ledig, settLedig] = useState<Vakt | null>(null);
  const [oppsett, settOppsett] = useState(false);
  const [auto, settAuto] = useState(false);
  const [melding, settMelding] = useState<string | null>(null);
  const [opptatt, settOpptatt] = useState<string | null>(null); // ruten som lagres
  const h = useHandling();
  const tabell = useRef<HTMLTableElement>(null);

  useEffect(() => {
    settMelding(null);
    h.settFeil(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fra, til]);

  if (turnus.feil || personer.feil || plan.feil || grupper.feil) return <Feil melding={turnus.feil ?? personer.feil ?? plan.feil ?? grupper.feil} />;
  if (!turnus.data || !personer.data || !plan.data || !grupper.data) return <Laster />;
  const data = plan.data;
  const typer = turnus.data.vakttyper;
  const aktiveTyper = typer.filter((t) => t.aktiv);
  const typeAv = new Map(typer.map((t) => [t.id, t]));
  const dager = Array.from({ length: uker * 7 }, (_, i) => leggTilDager(fra, i));
  const idag = iDag();
  const rv = rollevalg(rollevalget.valgt, grupper.data, personer.data);
  // Turnusen til én person: de ansatte ser sin egen som standard, de andre alle.
  const egen = org?.ansatt_id ?? null;
  const standardPerson = egen && !seAlle ? egen : "alle";
  const valgtPerson = (person ?? standardPerson) === "alle" ? undefined : personer.data.find((p) => p.id === (person ?? standardPerson));
  const velgEn = (p: string) => velgPerson(p === standardPerson ? null : p);

  // Folkene i perioden, rolle for rolle (rekkefølgen og fargene fra rollene).
  const iPerioden = (p: Person) => (p.aktiv && p.ansatt_fra <= til && (!p.ansatt_til || p.ansatt_til >= fra)) || data.vakter.some((v) => v.ansatt_id === p.id);
  const rollenr = new Map(grupper.data.map((g, i) => [g.id, i]));
  const seksjoner = [
    ...grupper.data.map((g, i) => ({ id: g.id as string | null, navn: g.navn, farge: i % 5 })),
    { id: null, navn: grupper.data.length ? "Uten rolle" : "", farge: 5 },
  ]
    .map((s) => ({
      ...s,
      folk: personer.data!.filter(
        (p) => iPerioden(p) && rv.vises(p.gruppe_id) && (s.id ? p.gruppe_id === s.id : !(p.gruppe_id && rollenr.has(p.gruppe_id))),
      ),
    }))
    .filter((s) => s.folk.length);
  const meg = egen ? personer.data.find((p) => p.id === egen) : undefined;
  const iValget = [
    ...grupper.data.map((g) => ({ id: g.id as string | null, navn: g.navn })),
    { id: null, navn: "Uten rolle" },
  ]
    .map((g) => ({
      ...g,
      folk: personer.data!.filter((p) => p.id !== egen && iPerioden(p) && (g.id ? p.gruppe_id === g.id : !(p.gruppe_id && rollenr.has(p.gruppe_id)))),
    }))
    .filter((g) => g.folk.length);

  const vakterPaa = new Map<string, Vakt[]>();
  for (const v of data.vakter) if (v.ansatt_id) vakterPaa.set(`${v.ansatt_id}|${v.dato}`, [...(vakterPaa.get(`${v.ansatt_id}|${v.dato}`) ?? []), v]);
  const fastPaa = new Map((data.faste ?? []).map((f) => [`${f.ansatt_id}|${f.dato}`, f]));
  const borte = (a: string, d: string) => (data.fravaer.find((f) => f.ansatt_id === a && f.fra <= d && f.til >= d)?.type ?? null) as FravaerType | null;
  const ledige = data.vakter.filter((v) => !v.ansatt_id);

  // Bemanningen per vakttype og dag mot behovet.
  const behov = (t: string, d: string) =>
    turnus.data!.behov.filter((b) => b.vakttype_id === t && b.ukedag === behovsdag(d)).reduce((s, b) => s + b.antall, 0);
  const satt = (t: string, d: string) => data.vakter.filter((v) => v.vakttype_id === t && v.dato === d && v.ansatt_id && !v.fravaer).length;
  // Bemanningen mot behovet bare for dem som ser hele planen (de ansatte ser ikke utkastene, så tallene
  // ville vært feil for dem).
  const harBehov = seAlle ? aktiveTyper.filter((t) => turnus.data!.behov.some((b) => b.vakttype_id === t.id)) : [];

  // Timene i perioden mot det avtalte (de som ser de ansatte).
  const timerFor = (a: string) => {
    const uker_ = data.uker.filter((u) => u.ansatt_id === a && u.fra >= fra && u.fra <= til);
    return { planlagt: uker_.reduce((s, u) => s + u.planlagt, 0), avtalt: uker_.some((u) => u.avtalt !== null) ? (uker_[0]!.avtalt ?? 0) * uker : null };
  };

  // Sett vakttypen på ruten: endre vakten som er der, eller lag en ny (utkast).
  const settType = async (ansatt: string, dato: string, t: Vakttype | null, tider?: { fra: string; til: string; pause_min: number }) => {
    const finnes = vakterPaa.get(`${ansatt}|${dato}`) ?? [];
    if (finnes.length > 1) return settRute({ ansatt, dato });
    const nokkel = `${ansatt}|${dato}`;
    settOpptatt(nokkel);
    const ok = await h.kjor(async () => {
      const v = finnes[0];
      if (!t && !tider) {
        if (v) await api("DELETE", `/org/${org!.id}/vakter/${v.id}`);
      } else if (v) {
        await api("PATCH", `/org/${org!.id}/vakter/${v.id}`, tider ? { ...tider, vakttype_id: null } : { vakttype_id: t!.id });
      } else {
        await api("POST", `/org/${org!.id}/vakter`, tider ? { ansatt_id: ansatt, dato, ...tider } : { ansatt_id: ansatt, dato, vakttype_id: t!.id });
      }
      return true;
    });
    settOpptatt(null);
    if (ok) {
      settMelding(null);
      await plan.last();
    }
  };

  // Tastene i rutene: koden setter vakttypen, Delete fjerner vakten, pilene flytter.
  const taster = (e: KeyboardEvent<HTMLTableElement>) => {
    const el = e.target as HTMLElement;
    const ansatt = el.dataset.ansatt;
    const dato = el.dataset.dato;
    if (!ansatt || !dato) return;
    const rad = Number(el.dataset.rad);
    const kol = Number(el.dataset.kol);
    const flytt = (r: number, k: number) => tabell.current?.querySelector<HTMLElement>(`[data-rad="${r}"][data-kol="${k}"]`)?.focus();
    if (e.key === "ArrowRight") flytt(rad, kol + 1);
    else if (e.key === "ArrowLeft") flytt(rad, kol - 1);
    else if (e.key === "ArrowDown") flytt(rad + 1, kol);
    else if (e.key === "ArrowUp") flytt(rad - 1, kol);
    else if (kanPlanlegge && (e.key === "Delete" || e.key === "Backspace")) void settType(ansatt, dato, null);
    else if (kanPlanlegge && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const t = aktiveTyper.find((x) => x.kode.toUpperCase() === e.key.toUpperCase());
      if (!t) return;
      void settType(ansatt, dato, t).then(() => flytt(rad, kol + 1));
    } else return;
    e.preventDefault();
  };

  const publiser = () =>
    h.kjor(async () => {
      const r = await api<{ publisert: number; varslet: number }>("POST", `/org/${org!.id}/vakter/publiser`, { fra, til });
      settMelding(
        `Turnusen for ${periodeNavn} er publisert (${r.publisert} ${r.publisert === 1 ? "vakt" : "vakter"}).` +
          (r.varslet ? ` ${r.varslet} ${r.varslet === 1 ? "ansatt har" : "ansatte har"} fått varsel.` : ""),
      );
      endret();
    });

  const u1 = ukenr(fra).uke;
  const u2 = ukenr(til).uke;
  const periodeNavn = uker === 1 ? `uke ${u1}` : `uke ${u1}–${u2}`;
  const verktoy = (
    <div className="uke-verktoy">
      {visningsvalg}
      <Periodevelger
        navn={uker === 1 ? `Uke ${u1}` : `Uke ${u1}–${u2}`}
        under={`${visDag(fra)} – ${visDag(til)}`}
        forrige={[`Forrige ${uker} uker`, () => velg(leggTilDager(fra, -7 * uker), uker)]}
        neste={[`Neste ${uker} uker`, () => velg(leggTilDager(fra, 7 * uker), uker)]}
        naa={fra !== mandag(idag) ? ["Denne uka", () => velg(mandag(idag), uker)] : undefined}
      />
      <label className="turnus-uker">
        <span className="sr-only">Antall uker</span>
        <select value={uker} onChange={(e) => velg(fra, Number(e.target.value))}>
          {[1, 2, 3, 4, 5, 6, 8].map((n) => (
            <option key={n} value={n}>
              {n === 1 ? "1 uke" : `${n} uker`}
            </option>
          ))}
        </select>
      </label>
      <label className="turnus-person">
        <span>Turnus for</span>
        <select value={valgtPerson?.id ?? "alle"} onChange={(e) => velgEn(e.target.value)}>
          <option value="alle">Alle</option>
          {meg && (
            <option value={meg.id}>
              Meg ({meg.fornavn} {meg.etternavn})
            </option>
          )}
          {grupper.data.length
            ? iValget.map((g) => (
                <optgroup key={g.id ?? "uten"} label={g.navn}>
                  {g.folk.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.fornavn} {p.etternavn}
                    </option>
                  ))}
                </optgroup>
              ))
            : iValget.flatMap((g) =>
                g.folk.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.fornavn} {p.etternavn}
                  </option>
                )),
              )}
        </select>
      </label>
      {kanPlanlegge && (
        <div className="knapper">
          <button type="button" onClick={() => settOppsett(true)}>
            <IkonInnstillinger storrelse={17} /> Oppsett
          </button>
          {aktiveTyper.length > 0 && (
            <button type="button" className={data.upubliserte > 0 ? undefined : "primar"} onClick={() => settAuto(true)}>
              <IkonRullering storrelse={17} /> Automatisk turnus
            </button>
          )}
          {data.upubliserte > 0 && (
            <button type="button" className="primar" disabled={h.opptatt} onClick={publiser}>
              Publiser ({data.upubliserte})
            </button>
          )}
        </div>
      )}
    </div>
  );

  const valgtePerson = rute ? personer.data.find((p) => p.id === rute.ansatt) : undefined;
  let radnr = 0;

  return (
    <>
      {verktoy}
      {melding && <div className="melding ok">{melding}</div>}
      <Feil melding={h.feil} />
      {valgtPerson ? (
        <>
          {aktiveTyper.length > 0 && (
            <div className="turnus-forklaring">
              {aktiveTyper.map((t) => (
                <span key={t.id}>
                  <VakttypeMerke t={t} /> {t.navn} <span className="dempet">{tid(t)}</span>
                </span>
              ))}
            </div>
          )}
          <PersonTurnus
            person={valgtPerson}
            dager={dager}
            data={data}
            personer={personer.data}
            typeAv={typeAv}
            velgPerson={velgEn}
            endre={kanPlanlegge ? (ansatt, dato) => settRute({ ansatt, dato }) : undefined}
          />
        </>
      ) : !typer.length ? (
        <div className="kort">
          <Tom ikon={<IkonKalender storrelse={22} />} tittel="Turnus med dag-, kveld- og nattevakter">
            {kanPlanlegge ? (
              <>
                <p>
                  Legg inn vakttypene dere har (f.eks. dag, kveld og natt), hvor mange som trengs på hver, og hvem som kan gå hva. Så kan dere sette folk på vaktene
                  her, eller la automatisk turnus lage et forslag for en periode.
                </p>
                <StandardTyper ferdig={endret} />
              </>
            ) : (
              <p>Turnusen er ikke satt opp ennå. Vaktene står i dagen, uka og måneden.</p>
            )}
          </Tom>
        </div>
      ) : (
        <>
          <div className="turnus-forklaring">
            {typer
              .filter((t) => t.aktiv)
              .map((t) => (
                <span key={t.id}>
                  <VakttypeMerke t={t} /> {t.navn} <span className="dempet">{tid(t)}</span>
                </span>
              ))}
            {kanPlanlegge && (
              <span className="dempet liten turnus-hjelp">
                Trykk på en rute for å velge vakt<span className="kun-tastatur">, eller skriv koden (Delete fjerner, pilene flytter)</span>.
              </span>
            )}
          </div>
          <Rollevalg valg={rv.valg} aktive={rv.aktive} velg={rollevalget.velg} />
          <div className="kort turnus-kort">
            <div className="turnus-rull">
              <table className="turnus" ref={tabell} onKeyDown={taster}>
                <thead>
                  <tr className="turnus-uker-rad">
                    <th />
                    {Array.from({ length: uker }, (_, i) => (
                      <th key={i} colSpan={7} className="turnus-uke">
                        Uke {ukenr(leggTilDager(fra, i * 7)).uke}
                      </th>
                    ))}
                    {seAlle && <th />}
                  </tr>
                  <tr>
                    <th className="turnus-navn">Navn</th>
                    {dager.map((d, i) => (
                      <th
                        key={d}
                        className={`turnus-dag${erHelg(d) ? " helg" : ""}${helligdag(d) ? " helligdag" : ""}${d === idag ? " idag" : ""}${i % 7 === 0 ? " ny-uke" : ""}`}
                        title={helligdag(d) ?? undefined}
                      >
                        <span>{UKEDAGER[i % 7]!.charAt(0)}</span>
                        {dagTall(d)}
                      </th>
                    ))}
                    {seAlle && <th className="turnus-sum">Timer</th>}
                  </tr>
                </thead>
                {seksjoner.map((s) => (
                  <tbody key={s.id ?? "uten"} className={`g${s.farge}`}>
                    {s.navn && (
                      <tr className="turnus-rolle">
                        <th colSpan={dager.length + 1 + (seAlle ? 1 : 0)}>{s.navn}</th>
                      </tr>
                    )}
                    {s.folk.map((p) => {
                      const r = radnr++;
                      const sum = seAlle ? timerFor(p.id) : null;
                      return (
                        <tr key={p.id}>
                          <th className="turnus-navn" scope="row">
                            <span className="fullt">
                              {p.fornavn} {p.etternavn}
                            </span>
                            <span className="forkortet">{p.forkortelse || `${p.fornavn} ${p.etternavn.charAt(0)}.`}</span>
                          </th>
                          {dager.map((d, k) => (
                            <td key={d} className={`${erHelg(d) || helligdag(d) ? "helg" : ""}${k % 7 === 0 ? " ny-uke" : ""}`}>
                              <Rute
                                vakter={vakterPaa.get(`${p.id}|${d}`) ?? []}
                                fast={fastPaa.get(`${p.id}|${d}`) ?? null}
                                fravaer={borte(p.id, d)}
                                typeAv={typeAv}
                                utenfor={d < p.ansatt_fra || (!!p.ansatt_til && d > p.ansatt_til)}
                                kanEndre={kanPlanlegge}
                                opptatt={opptatt === `${p.id}|${d}`}
                                data={{ "data-ansatt": p.id, "data-dato": d, "data-rad": r, "data-kol": k }}
                                apne={() => settRute({ ansatt: p.id, dato: d })}
                                navn={`${p.fornavn} ${p.etternavn}, ${visDag(d)}`}
                              />
                            </td>
                          ))}
                          {sum && (
                            <td className="turnus-sum">
                              {tekstTall(sum.planlagt)}
                              {sum.avtalt !== null && <span className="dempet"> / {tekstTall(sum.avtalt)}</span>}
                            </td>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                ))}
                <tfoot>
                  {ledige.length > 0 && (
                    <tr className="turnus-ledige">
                      <th scope="row">
                        Ledige<span className="fullt"> vakter</span>
                      </th>
                      {dager.map((d, k) => (
                        <td key={d} className={`${erHelg(d) || helligdag(d) ? "helg" : ""}${k % 7 === 0 ? " ny-uke" : ""}`}>
                          {ledige
                            .filter((v) => v.dato === d)
                            .map((v) => {
                              const t = v.vakttype_id ? typeAv.get(v.vakttype_id) : undefined;
                              return (
                                <button
                                  key={v.id}
                                  type="button"
                                  className={`turnus-ledig${v.publisert ? "" : " utkast"}`}
                                  title={`Ledig${t ? ` ${t.navn.toLowerCase()}` : ""} ${tid(v)}${v.rolle_navn ? ` for ${v.rolle_navn}` : ""}${v.publisert ? "" : " (ikke publisert)"}`}
                                  onClick={() => settLedig(v)}
                                  disabled={!kanPlanlegge}
                                >
                                  {t ? t.kode : kort(v)}
                                </button>
                              );
                            })}
                        </td>
                      ))}
                      {seAlle && <td />}
                    </tr>
                  )}
                  {harBehov.map((t) => (
                    <tr key={t.id} className="turnus-bemanning">
                      <th scope="row" title={t.navn}>
                        <VakttypeMerke t={t} /> <span className="fullt">{t.navn}</span>
                      </th>
                      {dager.map((d, k) => {
                        const n = satt(t.id, d);
                        const b = behov(t.id, d);
                        const klasse = !b && !n ? "" : n < b ? "mangler" : n > b ? "over" : "ok";
                        return (
                          <td
                            key={d}
                            className={`${klasse}${erHelg(d) || helligdag(d) ? " helg" : ""}${k % 7 === 0 ? " ny-uke" : ""}`}
                            title={b || n ? `${t.navn} ${visDag(d)}: ${n} av ${b}` : undefined}
                          >
                            {b || n ? `${n}/${b}` : ""}
                          </td>
                        );
                      })}
                      {seAlle && <td />}
                    </tr>
                  ))}
                </tfoot>
              </table>
            </div>
          </div>
          {seAlle && (
            <p className="liten dempet">
              Timer: planlagt i perioden / avtalt etter stillingsprosenten. Tallene nederst er hvor mange som er satt på vakttypen mot behovet (helligdager som
              søndager). Utkast har stiplet kant til de er publisert.
            </p>
          )}
        </>
      )}

      <Dialog apen={!!rute} lukk={() => settRute(null)} tittel={valgtePerson ? `${valgtePerson.fornavn} ${valgtePerson.etternavn}` : "Vakt"}>
        {rute && (
          <RuteValg
            dato={rute.dato}
            vakter={vakterPaa.get(`${rute.ansatt}|${rute.dato}`) ?? []}
            fravaer={borte(rute.ansatt, rute.dato)}
            typer={aktiveTyper}
            typeAv={typeAv}
            kanEndre={kanPlanlegge}
            velg={async (t, tider) => {
              settRute(null);
              await settType(rute.ansatt, rute.dato, t, tider);
            }}
            slett={async (v) => {
              const ok = await h.kjor(async () => (await api("DELETE", `/org/${org!.id}/vakter/${v.id}`), true));
              if (ok) {
                settRute(null);
                await plan.last();
              }
            }}
            lukk={() => settRute(null)}
          />
        )}
      </Dialog>
      <Dialog apen={!!ledig} lukk={() => settLedig(null)} tittel="Ledig vakt">
        {ledig && (
          <LedigValg
            vakt={ledig}
            type={ledig.vakttype_id ? typeAv.get(ledig.vakttype_id) : undefined}
            personer={personer.data.filter((p) => p.aktiv && p.ansatt_fra <= ledig.dato && (!p.ansatt_til || p.ansatt_til >= ledig.dato))}
            ferdig={async () => {
              settLedig(null);
              await plan.last();
            }}
            avbryt={() => settLedig(null)}
          />
        )}
      </Dialog>
      <Dialog apen={oppsett} lukk={() => settOppsett(false)} tittel="Oppsett av turnus" bred>
        {oppsett && (
          <TurnusOppsett
            svar={turnus.data}
            roller={grupper.data}
            endret={() => {
              turnus.last();
              plan.last();
            }}
          />
        )}
      </Dialog>
      <Dialog apen={auto} lukk={() => settAuto(false)} tittel="Automatisk turnus" bred>
        {auto && (
          <AutomatiskTurnus
            svar={turnus.data}
            roller={grupper.data}
            fra={fra < idag ? mandag(leggTilDager(idag, 7)) : fra}
            til={fra < idag ? leggTilDager(mandag(leggTilDager(idag, 7)), uker * 7 - 1) : til}
            ferdig={(tekst) => {
              settAuto(false);
              settMelding(tekst);
              endret();
            }}
            angret={(tekst) => {
              settMelding(tekst);
              endret();
            }}
            tilOppsett={() => {
              settAuto(false);
              settOppsett(true);
            }}
          />
        )}
      </Dialog>
    </>
  );
}

// Én rute: vakttypen (koden i fargen), klokkeslettene for en vakt uten vakttype, fraværet, eller
// den faste arbeidsdagen.
function Rute({
  vakter,
  fast,
  fravaer,
  typeAv,
  utenfor,
  kanEndre,
  opptatt,
  data,
  apne,
  navn,
}: {
  vakter: Vakt[];
  fast: Fast | null;
  fravaer: FravaerType | null;
  typeAv: Map<string, Vakttype>;
  utenfor: boolean;
  kanEndre: boolean;
  opptatt: boolean;
  data: Record<string, string | number>;
  apne: () => void;
  navn: string;
}) {
  const v = vakter[0];
  const t = v?.vakttype_id ? typeAv.get(v.vakttype_id) : undefined;
  const utkast = vakter.some((x) => !x.publisert);
  const advarsler = vakter.flatMap((x) => x.advarsler ?? []);
  const beskrivelse = [
    navn,
    ...vakter.map((x) => {
      const xt = x.vakttype_id ? typeAv.get(x.vakttype_id) : undefined;
      return `${xt ? `${xt.navn} ` : ""}${tid(x)}${x.publisert ? "" : " (utkast)"}`;
    }),
    fravaer ? fravaerTekst[fravaer] : "",
    !v && fast ? `Fast arbeidsdag${fast.fra ? ` ${fast.fra}–${fast.til}` : ""}` : "",
    ...advarsler,
  ]
    .filter(Boolean)
    .join("\n");
  let innhold: ReactNode = null;
  let klasse = "turnus-rute";
  if (fravaer) {
    innhold = fravaerKode[fravaer];
    klasse += ` ${fravaerKlasse[fravaer]}`;
    if (v) klasse += " med-vakt";
  } else if (v) {
    innhold = vakter.length > 1 ? `${t?.kode ?? kort(v)}+` : (t?.kode ?? kort(v));
    klasse += t ? ` vt vt${t.farge % FARGER}` : " uten-type";
  } else if (fast) {
    innhold = "·";
    klasse += " fast";
  }
  if (utkast) klasse += " utkast";
  if (advarsler.length) klasse += " advarsel";
  if (utenfor) klasse += " utenfor";
  if (opptatt) klasse += " opptatt";
  return (
    <button
      type="button"
      className={klasse}
      title={beskrivelse}
      aria-label={beskrivelse.replace(/\n/g, ". ")}
      tabIndex={data["data-rad"] === 0 && data["data-kol"] === 0 ? 0 : -1}
      onFocus={(e) => (e.currentTarget.tabIndex = 0)}
      onBlur={(e) => (e.currentTarget.tabIndex = -1)}
      onClick={kanEndre || v ? apne : undefined}
      disabled={utenfor && !v}
      {...data}
    >
      {innhold}
    </button>
  );
}

// Velg vakttypen for ruten, en annen tid, eller fri.
function RuteValg({
  dato,
  vakter,
  fravaer,
  typer,
  typeAv,
  kanEndre,
  velg,
  slett,
  lukk,
}: {
  dato: string;
  vakter: Vakt[];
  fravaer: FravaerType | null;
  typer: Vakttype[];
  typeAv: Map<string, Vakttype>;
  kanEndre: boolean;
  velg: (t: Vakttype | null, tider?: { fra: string; til: string; pause_min: number }) => void;
  slett: (v: Vakt) => void;
  lukk: () => void;
}) {
  const v = vakter[0];
  const [egen, settEgen] = useState(!!v && !v.vakttype_id);
  const [fraT, settFra] = useState(v?.fra ?? "");
  const [tilT, settTil] = useState(v?.til ?? "");
  const [pause, settPause] = useState(String(v?.pause_min ?? 0));
  const p = pause.trim() === "" ? 0 : tall(pause);
  const gyldig = /^\d{2}:\d{2}$/.test(fraT) && /^\d{2}:\d{2}$/.test(tilT) && fraT !== tilT && Number.isFinite(p) && regnTimer(fraT, tilT, p) > 0;
  const lagre = (e: FormEvent) => {
    e.preventDefault();
    if (gyldig) velg(null, { fra: fraT, til: tilT, pause_min: Math.round(p) });
  };
  return (
    <div className="rute-valg">
      <p className="dempet">{visDag(dato)}</p>
      {fravaer && <div className="melding info">Borte denne dagen ({fravaerTekst[fravaer].toLowerCase()}).</div>}
      {vakter.length > 1 && (
        <ul className="liste-enkel">
          {vakter.map((x) => {
            const t = x.vakttype_id ? typeAv.get(x.vakttype_id) : undefined;
            return (
              <li key={x.id}>
                {t && <VakttypeMerke t={t} />} {tid(x)} {!x.publisert && <span className="dempet">(utkast)</span>}
                {kanEndre && (
                  <button type="button" className="lenke fare" onClick={() => slett(x)}>
                    Fjern
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {vakter.length <= 1 && kanEndre && (
        <>
          <div className="vakttype-valg" role="group" aria-label="Vakttype">
            {typer.map((t) => (
              <button key={t.id} type="button" className={`vt${t.farge % FARGER}${v?.vakttype_id === t.id ? " valgt" : ""}`} aria-pressed={v?.vakttype_id === t.id} onClick={() => velg(t)}>
                <VakttypeMerke t={t} />
                <span>
                  <strong>{t.navn}</strong>
                  <span className="dempet">{tid(t)}</span>
                </span>
              </button>
            ))}
            <button type="button" className={egen ? "valgt" : undefined} aria-pressed={egen} onClick={() => settEgen(!egen)}>
              <span className="vt-merke tom">…</span>
              <span>
                <strong>Annen tid</strong>
                <span className="dempet">Egne klokkeslett</span>
              </span>
            </button>
          </div>
          {egen && (
            <form className="rad tre" onSubmit={lagre}>
              <label>
                Fra
                <Klokkeslett required value={fraT} onChange={settFra} />
              </label>
              <label>
                Til
                <Klokkeslett required value={tilT} onChange={settTil} />
              </label>
              <label>
                Pause (min)
                <input inputMode="numeric" value={pause} onChange={(e) => settPause(e.target.value)} />
              </label>
              <div className="knapper" style={{ gridColumn: "1 / -1" }}>
                <button className="primar" disabled={!gyldig}>
                  Lagre {gyldig ? `(${timer(regnTimer(fraT, tilT, p))})` : ""}
                </button>
              </div>
            </form>
          )}
        </>
      )}
      {!kanEndre && v && (
        <p>
          {vakter.map((x) => {
            const t = x.vakttype_id ? typeAv.get(x.vakttype_id) : undefined;
            return (
              <span key={x.id} className="blokk">
                {t && <VakttypeMerke t={t} />} {t?.navn} {tid(x)}
              </span>
            );
          })}
        </p>
      )}
      <div className="knapper">
        {kanEndre && vakter.length === 1 && (
          <button type="button" className="fare" onClick={() => velg(null)}>
            Fri (fjern vakten)
          </button>
        )}
        <button type="button" onClick={lukk}>
          {kanEndre ? "Avbryt" : "Lukk"}
        </button>
      </div>
    </div>
  );
}

// En ledig vakt: sett noen på den, eller fjern den.
function LedigValg({ vakt, type, personer, ferdig, avbryt }: { vakt: Vakt; type?: Vakttype; personer: Person[]; ferdig: () => void; avbryt: () => void }) {
  const { org } = useKonto();
  const [ansatt, settAnsatt] = useState("");
  const h = useHandling();
  const aktuelle = personer.filter((p) => !vakt.rolle_id || p.gruppe_id === vakt.rolle_id);
  const andre = personer.filter((p) => vakt.rolle_id && p.gruppe_id !== vakt.rolle_id);
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        if (await h.kjor(async () => (await api("PATCH", `/org/${org!.id}/vakter/${vakt.id}`, { ansatt_id: ansatt }), true))) ferdig();
      }}
    >
      <p>
        {type && <VakttypeMerke t={type} />} {type?.navn ?? "Vakt"} {visDag(vakt.dato)} {tid(vakt)}
        {vakt.rolle_navn ? ` for ${vakt.rolle_navn.toLowerCase()}` : ""}.{" "}
        {vakt.publisert ? "Publisert: de ansatte med rollen kan ta den." : "Ikke publisert ennå."}
      </p>
      <label>
        Sett på
        <select required value={ansatt} onChange={(e) => settAnsatt(e.target.value)}>
          <option value="">Velg …</option>
          {aktuelle.map((p) => (
            <option key={p.id} value={p.id}>
              {p.fornavn} {p.etternavn}
            </option>
          ))}
          {andre.length > 0 && (
            <optgroup label="Med en annen rolle">
              {andre.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.fornavn} {p.etternavn}
                </option>
              ))}
            </optgroup>
          )}
        </select>
      </label>
      <Feil melding={h.feil} />
      <div className="knapper">
        <button className="primar" disabled={h.opptatt || !ansatt}>
          Lagre
        </button>
        <button type="button" onClick={avbryt}>
          Avbryt
        </button>
        <button
          type="button"
          className="fare"
          style={{ marginLeft: "auto" }}
          disabled={h.opptatt}
          onClick={async () => {
            if (await h.kjor(async () => (await api("DELETE", `/org/${org!.id}/vakter/${vakt.id}`), true))) ferdig();
          }}
        >
          Fjern vakten
        </button>
      </div>
    </form>
  );
}

// Dag, kveld og natt med ett trykk.
function StandardTyper({ ferdig }: { ferdig: () => void }) {
  const { org } = useKonto();
  const h = useHandling();
  return (
    <>
      <Feil melding={h.feil} />
      <div className="knapper" style={{ justifyContent: "center" }}>
        <button
          type="button"
          className="primar"
          disabled={h.opptatt}
          onClick={async () => {
            const ok = await h.kjor(async () => {
              for (const [i, t] of STANDARDTYPER.entries()) await api("POST", `/org/${org!.id}/turnus/vakttyper`, { ...t, farge: i, rekkefolge: i });
              return true;
            });
            if (ok) ferdig();
          }}
        >
          Legg inn dag, kveld og natt
        </button>
      </div>
      <p className="liten dempet">Dagvakt 07–15, kveldsvakt 15–23 og nattevakt 23–07. Klokkeslettene kan endres under «Oppsett».</p>
    </>
  );
}

// --- Oppsettet: vakttypene, behovet, hvem som går hva og reglene ------------------------------

function TurnusOppsett({ svar, roller, endret }: { svar: TurnusSvar; roller: Rolle[]; endret: () => void }) {
  const [fane, settFane] = useState<"typer" | "behov" | "ansatte" | "regler">(svar.vakttyper.length ? (svar.behov.length ? "ansatte" : "behov") : "typer");
  return (
    <div className="turnus-oppsett">
      <div className="faner tett" role="tablist">
        {(
          [
            ["typer", "Vakttyper"],
            ["behov", "Behov"],
            ["ansatte", "Hvem går hva"],
            ["regler", "Regler"],
          ] as const
        ).map(([v, t]) => (
          <button key={v} type="button" role="tab" aria-selected={fane === v} className={fane === v ? "valgt" : undefined} onClick={() => settFane(v)}>
            {t}
          </button>
        ))}
      </div>
      {fane === "typer" && <Vakttyper typer={svar.vakttyper} endret={endret} />}
      {fane === "behov" && <BehovSkjema svar={svar} roller={roller} endret={endret} />}
      {fane === "ansatte" && <AnsattValg svar={svar} roller={roller} endret={endret} />}
      {fane === "regler" && <ReglerSkjema regler={svar.regler} endret={endret} />}
    </div>
  );
}

function Vakttyper({ typer, endret }: { typer: Vakttype[]; endret: () => void }) {
  const [rediger, settRediger] = useState<string | null>(typer.length ? null : "ny");
  return (
    <div>
      <p className="liten dempet">
        Vakttypene dere har, med koden som står i turnusen. En vakt med vakttype får klokkeslettene fra den, men de kan endres på hver vakt. En vakttype som ikke er
        i bruk lenger, står på de gamle vaktene, men kan ikke velges.
      </p>
      {!typer.length && <StandardTyper ferdig={endret} />}
      <ul className="vakttype-liste">
        {typer.map((t) =>
          rediger === t.id ? (
            <li key={t.id}>
              <VakttypeSkjema
                t={t}
                ferdig={() => {
                  settRediger(null);
                  endret();
                }}
                avbryt={() => settRediger(null)}
              />
            </li>
          ) : (
            <li key={t.id} className={t.aktiv ? undefined : "inaktiv"}>
              <VakttypeMerke t={t} />
              <span>
                <strong>{t.navn}</strong> <span className="dempet">{tid(t)}</span>
                <span className="liten dempet blokk">
                  {timer(t.timer)}
                  {t.pause_min ? `, ${t.pause_min} min pause` : ""}
                  {t.aktiv ? "" : ". Ikke i bruk"}
                </span>
              </span>
              <button type="button" className="lenke" onClick={() => settRediger(t.id)}>
                Endre
              </button>
            </li>
          ),
        )}
      </ul>
      {rediger === "ny" ? (
        <VakttypeSkjema
          ferdig={() => {
            settRediger(null);
            endret();
          }}
          avbryt={() => settRediger(null)}
          farge={typer.length % FARGER}
        />
      ) : (
        <button type="button" onClick={() => settRediger("ny")}>
          Ny vakttype
        </button>
      )}
    </div>
  );
}

function VakttypeSkjema({ t, farge, ferdig, avbryt }: { t?: Vakttype; farge?: number; ferdig: () => void; avbryt: () => void }) {
  const { org } = useKonto();
  const [v, settV] = useState({
    navn: t?.navn ?? "",
    kode: t?.kode ?? "",
    fra: t?.fra ?? "",
    til: t?.til ?? "",
    pause: String(t?.pause_min ?? 0),
    farge: t?.farge ?? farge ?? 0,
    aktiv: t?.aktiv ?? true,
  });
  const h = useHandling();
  const sett = (e: Partial<typeof v>) => settV({ ...v, ...e });
  const p = v.pause.trim() === "" ? 0 : tall(v.pause);
  const klokke = (s: string) => /^\d{2}:\d{2}$/.test(s);
  const utregnet = klokke(v.fra) && klokke(v.til) && v.fra !== v.til && Number.isFinite(p) ? regnTimer(v.fra, v.til, p) : null;
  const lagre = async (e: FormEvent) => {
    e.preventDefault();
    const kropp = { navn: v.navn, kode: v.kode, fra: v.fra, til: v.til, pause_min: Math.round(p), farge: v.farge, aktiv: v.aktiv };
    const ok = await h.kjor(async () => (await (t ? api("PATCH", `/org/${org!.id}/turnus/vakttyper/${t.id}`, kropp) : api("POST", `/org/${org!.id}/turnus/vakttyper`, kropp)), true));
    if (ok) ferdig();
  };
  const slett = async () => {
    if (!t || !confirm(`Slette ${t.navn.toLowerCase()}? Vaktene som har den, beholder klokkeslettene, og behovet for den forsvinner.`)) return;
    if (await h.kjor(async () => (await api("DELETE", `/org/${org!.id}/turnus/vakttyper/${t.id}`), true))) ferdig();
  };
  return (
    <form className="vakttype-skjema" onSubmit={lagre}>
      <div className="rad">
        <label>
          Navn
          <input required maxLength={40} placeholder="F.eks. Dagvakt" value={v.navn} onChange={(e) => sett({ navn: e.target.value })} />
        </label>
        <label className="smal">
          Kode
          <input required maxLength={3} placeholder="D" value={v.kode} onChange={(e) => sett({ kode: e.target.value.toUpperCase() })} />
        </label>
      </div>
      <div className="rad tre">
        <label>
          Fra
          <Klokkeslett required value={v.fra} onChange={(fra) => sett({ fra })} />
        </label>
        <label>
          Til
          <Klokkeslett required value={v.til} onChange={(til) => sett({ til })} />
        </label>
        <label>
          Pause (min)
          <input inputMode="numeric" value={v.pause} onChange={(e) => sett({ pause: e.target.value })} />
        </label>
      </div>
      <p className="utregnet" aria-live="polite">
        {utregnet === null ? " " : utregnet > 0 ? `= ${timer(utregnet)}${v.til < v.fra ? " (over midnatt)" : ""}` : "Pausen er like lang som vakten."}
      </p>
      <fieldset className="naken">
        <legend className="liten">Farge</legend>
        <div className="fargevalg" role="radiogroup" aria-label="Farge">
          {Array.from({ length: FARGER }, (_, i) => (
            <button key={i} type="button" role="radio" aria-checked={v.farge === i} aria-label={`Farge ${i + 1}`} className={`vt${i}${v.farge === i ? " valgt" : ""}`} onClick={() => sett({ farge: i })}>
              <span className="vt-merke">{v.kode || "A"}</span>
            </button>
          ))}
        </div>
      </fieldset>
      {t && (
        <label className="avkryss">
          <input type="checkbox" checked={v.aktiv} onChange={(e) => sett({ aktiv: e.target.checked })} /> I bruk
        </label>
      )}
      <Feil melding={h.feil} />
      <div className="knapper">
        <button className="primar" disabled={h.opptatt}>
          Lagre
        </button>
        <button type="button" onClick={avbryt}>
          Avbryt
        </button>
        {t && (
          <button type="button" className="fare" style={{ marginLeft: "auto" }} disabled={h.opptatt} onClick={slett}>
            Slett
          </button>
        )}
      </div>
    </form>
  );
}

// Behovet: én rad per vakttype (uansett rolle) og per rolle som er lagt til, med antallet hver ukedag.
function BehovSkjema({ svar, roller, endret }: { svar: TurnusSvar; roller: Rolle[]; endret: () => void }) {
  const { org } = useKonto();
  const typer = svar.vakttyper.filter((t) => t.aktiv);
  type Rad = { vakttype_id: string; rolle_id: string | null; antall: string[] };
  const [rader, settRader] = useState<Rad[]>(() => {
    const liste: Rad[] = [];
    for (const t of typer) {
      const roller_ = [null, ...new Set(svar.behov.filter((b) => b.vakttype_id === t.id && b.rolle_id).map((b) => b.rolle_id))];
      for (const r of roller_)
        liste.push({
          vakttype_id: t.id,
          rolle_id: r,
          antall: [1, 2, 3, 4, 5, 6, 7].map((u) => String(svar.behov.find((b) => b.vakttype_id === t.id && b.ukedag === u && b.rolle_id === r)?.antall ?? "")),
        });
    }
    return liste;
  });
  const [melding, settMelding] = useState<string | null>(null);
  const h = useHandling();
  const settAntall = (i: number, u: number | null, verdi: string) =>
    settRader(rader.map((r, j) => (j === i ? { ...r, antall: r.antall.map((a, k) => (u === null || k === u ? verdi : a)) } : r)));
  const leggTilRolle = (t: string, rolle: string) => {
    const siste = rader.map((r) => r.vakttype_id).lastIndexOf(t);
    settRader([...rader.slice(0, siste + 1), { vakttype_id: t, rolle_id: rolle, antall: Array(7).fill("") }, ...rader.slice(siste + 1)]);
  };
  const lagre = async (e: FormEvent) => {
    e.preventDefault();
    const behov = rader.flatMap((r) =>
      r.antall.map((a, k) => ({ vakttype_id: r.vakttype_id, ukedag: k + 1, rolle_id: r.rolle_id, antall: a.trim() === "" ? 0 : Math.round(tall(a)) })).filter((b) => b.antall > 0),
    );
    if (behov.some((b) => !Number.isFinite(b.antall) || b.antall < 0 || b.antall > 50)) return h.settFeil("Skriv et antall mellom 0 og 50");
    const r = await h.kjor(() => api<{ behov: number }>("PUT", `/org/${org!.id}/turnus/behov`, { behov }));
    if (r) {
      settMelding("Behovet er lagret.");
      endret();
    }
  };
  if (!typer.length) return <p className="dempet">Legg inn vakttypene først.</p>;
  return (
    <form onSubmit={lagre}>
      <p className="liten dempet">
        Hvor mange som trengs på hver vakttype hver ukedag. Med en rolle: så mange med rollen. Uten rolle: så mange til, med hvilken som helst rolle (f.eks. «2
        sykepleiere og 1 til»). Helligdagene bemannes som søndager.
      </p>
      <div className="behov-rull">
        <table className="behov-tabell">
          <thead>
            <tr>
              <th>Vakt</th>
              <th className="alle">Alle dager</th>
              {UKEDAGER.map((d) => (
                <th key={d}>{d}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rader.map((r, i) => {
              const t = typer.find((x) => x.id === r.vakttype_id)!;
              const rolle = r.rolle_id ? roller.find((x) => x.id === r.rolle_id) : null;
              const brukt = new Set(rader.filter((x) => x.vakttype_id === t.id).map((x) => x.rolle_id));
              const ledigeRoller = roller.filter((x) => !brukt.has(x.id));
              const forsteForType = rader.findIndex((x) => x.vakttype_id === t.id) === i;
              const sisteForType = rader.map((x) => x.vakttype_id).lastIndexOf(t.id) === i;
              return (
                <tr key={`${r.vakttype_id}:${r.rolle_id ?? ""}`} className={forsteForType ? "ny-type" : undefined}>
                  <th scope="row">
                    {forsteForType && (
                      <span className="blokk">
                        <VakttypeMerke t={t} /> {t.navn}
                      </span>
                    )}
                    <span className="liten dempet">{rolle ? rolle.navn : r.rolle_id ? "Slettet rolle" : forsteForType ? "Uansett rolle" : ""}</span>
                    {sisteForType && ledigeRoller.length > 0 && (
                      <select className="liten" value="" aria-label={`Legg til behov for en rolle på ${t.navn.toLowerCase()}`} onChange={(e) => e.target.value && leggTilRolle(t.id, e.target.value)}>
                        <option value="">+ For en rolle</option>
                        {ledigeRoller.map((x) => (
                          <option key={x.id} value={x.id}>
                            {x.navn}
                          </option>
                        ))}
                      </select>
                    )}
                  </th>
                  <td className="alle">
                    <input inputMode="numeric" aria-label={`Alle dager, ${t.navn}${rolle ? `, ${rolle.navn}` : ""}`} placeholder="–" onChange={(e) => settAntall(i, null, e.target.value)} />
                  </td>
                  {r.antall.map((a, k) => (
                    <td key={k}>
                      <input inputMode="numeric" aria-label={`${UKEDAGER[k]}, ${t.navn}${rolle ? `, ${rolle.navn}` : ""}`} value={a} placeholder="0" onChange={(e) => settAntall(i, k, e.target.value)} />
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {melding && <div className="melding ok">{melding}</div>}
      <Feil melding={h.feil} />
      <div className="knapper">
        <button className="primar" disabled={h.opptatt}>
          Lagre behovet
        </button>
      </div>
    </form>
  );
}

// Hvem som går hvilke vakttyper (de som har minst én, er med i den automatiske turnusen).
function AnsattValg({ svar, roller, endret }: { svar: TurnusSvar; roller: Rolle[]; endret: () => void }) {
  const { org } = useKonto();
  const typer = svar.vakttyper.filter((t) => t.aktiv);
  const [valg, settValg] = useState(() => new Map(svar.ansatte.map((a) => [a.id, new Set(a.vakttyper)])));
  const [melding, settMelding] = useState<string | null>(null);
  const h = useHandling();
  const veksle = (a: string, t: string) => {
    const ny = new Map(valg);
    const s = new Set(ny.get(a) ?? []);
    if (s.has(t)) s.delete(t);
    else s.add(t);
    ny.set(a, s);
    settValg(ny);
  };
  const alle = (pa: boolean) => settValg(new Map(svar.ansatte.map((a) => [a.id, new Set(pa ? typer.map((t) => t.id) : [])])));
  const lagre = async () => {
    const r = await h.kjor(async () => {
      await api("PUT", `/org/${org!.id}/turnus/ansatte`, { ansatte: [...valg.entries()].map(([ansatt_id, s]) => ({ ansatt_id, vakttyper: [...s] })) });
      return true;
    });
    if (r) {
      settMelding("Lagret.");
      endret();
    }
  };
  if (!typer.length) return <p className="dempet">Legg inn vakttypene først.</p>;
  const rolle = (id: string | null) => roller.find((r) => r.id === id)?.navn ?? "";
  return (
    <div>
      <p className="liten dempet">
        Kryss av for vakttypene hver ansatt kan gå. De som har minst én, er med når automatisk turnus fordeler vaktene, etter stillingsprosenten (tilkallingsvikarer
        bare når ingen andre kan).
      </p>
      <div className="knapper">
        <button type="button" onClick={() => alle(true)}>
          Alle kan alt
        </button>
        <button type="button" onClick={() => alle(false)}>
          Ingen
        </button>
      </div>
      <div className="behov-rull">
        <table className="behov-tabell ansatt-valg">
          <thead>
            <tr>
              <th>Ansatt</th>
              {typer.map((t) => (
                <th key={t.id}>
                  <VakttypeMerke t={t} tittel={t.navn} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {svar.ansatte.map((a) => (
              <tr key={a.id}>
                <th scope="row">
                  {a.navn}
                  <span className="liten dempet blokk">
                    {[rolle(a.rolle_id), a.ansettelsestype === "tilkalling" ? "tilkalling" : `${tekstTall(a.avtalt)} t/uke`].filter(Boolean).join(" · ")}
                  </span>
                </th>
                {typer.map((t) => (
                  <td key={t.id}>
                    <input type="checkbox" aria-label={`${a.navn} kan gå ${t.navn.toLowerCase()}`} checked={!!valg.get(a.id)?.has(t.id)} onChange={() => veksle(a.id, t.id)} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {melding && <div className="melding ok">{melding}</div>}
      <Feil melding={h.feil} />
      <div className="knapper">
        <button type="button" className="primar" disabled={h.opptatt} onClick={lagre}>
          Lagre
        </button>
      </div>
    </div>
  );
}

function ReglerSkjema({ regler, endret }: { regler: TurnusRegler; endret: () => void }) {
  const { org } = useKonto();
  const [v, settV] = useState({ hvile: String(regler.hvile), dager: String(regler.dager_paa_rad), netter: String(regler.netter_paa_rad), helg: regler.helg });
  const [melding, settMelding] = useState<string | null>(null);
  const h = useHandling();
  const lagre = async (e: FormEvent) => {
    e.preventDefault();
    const r = await h.kjor(() =>
      api("PUT", `/org/${org!.id}/turnus/regler`, { hvile: tall(v.hvile), dager_paa_rad: Math.round(tall(v.dager)), netter_paa_rad: Math.round(tall(v.netter)), helg: v.helg }),
    );
    if (r) {
      settMelding("Reglene er lagret.");
      endret();
    }
  };
  return (
    <form onSubmit={lagre}>
      <p className="liten dempet">Automatisk turnus bryter aldri disse reglene; en vakt som ikke kan fylles uten å bryte dem, blir stående ledig.</p>
      <div className="rad">
        <label>
          Hvile mellom vaktene (timer)
          <input inputMode="decimal" value={v.hvile} onChange={(e) => settV({ ...v, hvile: e.target.value })} />
          <span className="felt-hjelp">Minst 11 etter arbeidsmiljøloven; ned mot 8 med avtale.</span>
        </label>
        <label>
          Helger
          <select value={v.helg} onChange={(e) => settV({ ...v, helg: Number(e.target.value) })}>
            {HELGVALG.map(([n, t]) => (
              <option key={n} value={n}>
                {t}
              </option>
            ))}
          </select>
          <span className="felt-hjelp">Høyst så ofte jobber den enkelte helg.</span>
        </label>
      </div>
      <div className="rad">
        <label>
          Høyst dager på rad
          <input inputMode="numeric" value={v.dager} onChange={(e) => settV({ ...v, dager: e.target.value })} />
        </label>
        <label>
          Høyst nattevakter på rad
          <input inputMode="numeric" value={v.netter} onChange={(e) => settV({ ...v, netter: e.target.value })} />
        </label>
      </div>
      <p className="liten dempet">
        I tillegg: én vakt per døgn, ikke mer enn grensen for alminnelig arbeidstid i uka (Innstillinger → Ansatte og timer), minst 35 timer sammenhengende fri i uka,
        og ikke mer enn den avtalte arbeidstiden (stillingsprosenten).
      </p>
      {melding && <div className="melding ok">{melding}</div>}
      <Feil melding={h.feil} />
      <div className="knapper">
        <button className="primar" disabled={h.opptatt}>
          Lagre reglene
        </button>
      </div>
    </form>
  );
}

// --- Automatisk turnus: forslaget, innleggingen og angring -----------------------------------

function AutomatiskTurnus({
  svar,
  roller,
  fra: startFra,
  til: startTil,
  ferdig,
  angret,
  tilOppsett,
}: {
  svar: TurnusSvar;
  roller: Rolle[];
  fra: string;
  til: string;
  ferdig: (melding: string) => void;
  angret: (melding: string) => void;
  tilOppsett: () => void;
}) {
  const { org } = useKonto();
  const [fra, settFra] = useState(startFra);
  const [til, settTil] = useState(startTil);
  const [erstatt, settErstatt] = useState(true);
  const [ledige, settLedige] = useState(true);
  const [forslag, settForslag] = useState<{ forslag: Forslag; erstattes: number } | null>(null);
  const h = useHandling();
  const typer = svar.vakttyper.filter((t) => t.aktiv);
  const typeAv = new Map(svar.vakttyper.map((t) => [t.id, t]));
  const rolle = (id: string | null) => (id ? (roller.find((r) => r.id === id)?.navn ?? "rolle") : null);
  const mangler = [
    !typer.length && "vakttypene",
    !svar.behov.length && "behovet",
    !svar.ansatte.some((a) => a.vakttyper.length) && "hvem som går hvilke vakttyper",
  ].filter(Boolean) as string[];
  const kropp = { fra, til, erstatt, ledige };
  useEffect(() => settForslag(null), [fra, til, erstatt, ledige]);

  const lagForslag = async (e?: FormEvent) => {
    e?.preventDefault();
    const r = await h.kjor(() => api<{ forslag: Forslag; erstattes: number }>("POST", `/org/${org!.id}/turnus/forslag`, kropp));
    if (r) settForslag(r);
  };
  const leggInn = async () => {
    const r = await h.kjor(() => api<{ vakter: number; ledige: number; hull: number; erstattet: number }>("POST", `/org/${org!.id}/turnus/kjoringer`, kropp));
    if (r)
      ferdig(
        `Turnusen er lagt inn som utkast: ${r.vakter} ${r.vakter === 1 ? "vakt" : "vakter"}` +
          (r.ledige ? ` og ${r.ledige} ${r.ledige === 1 ? "ledig vakt" : "ledige vakter"}` : "") +
          (r.hull ? `, og ${r.hull} ${r.hull === 1 ? "plass" : "plasser"} uten vakt` : "") +
          (r.erstattet ? ` (${r.erstattet} utkast fra forrige forslag er erstattet)` : "") +
          ". Se over og publiser.",
      );
  };
  const angre = async (k: Kjoring) => {
    if (!confirm(`Angre turnusen for ${visDag(k.fra)}–${visDag(k.til)}? De ${k.utkast} utkastene slettes${k.publisert ? `; de ${k.publisert} publiserte står` : ""}.`)) return;
    const r = await h.kjor(() => api<{ slettet: number; publisert: number }>("DELETE", `/org/${org!.id}/turnus/kjoringer/${k.id}`));
    if (r) angret(`${r.slettet} ${r.slettet === 1 ? "utkast er slettet" : "utkast er slettet"}${r.publisert ? `; ${r.publisert} publiserte vakter står` : ""}.`);
  };

  if (mangler.length)
    return (
      <div>
        <p>Før automatisk turnus kan lage et forslag, må {mangler.join(", ").replace(/, ([^,]*)$/, " og $1")} settes opp.</p>
        <div className="knapper">
          <button type="button" className="primar" onClick={tilOppsett}>
            Til oppsettet
          </button>
        </div>
      </div>
    );

  const hullSum = forslag ? forslag.forslag.hull.reduce((s, x) => s + x.antall, 0) : 0;
  const nye = forslag ? forslag.forslag.vakter.filter((v) => v.ansatt_id).length : 0;
  return (
    <div className="auto-turnus">
      <p className="liten dempet">
        Fordeler de ansatte på vaktene i perioden etter behovet, uansett hvilke ukedager de pleier å jobbe: etter stillingsprosenten, med hviletid, dager og netter på
        rad og helger etter reglene, jevnt fordelte netter og helger, og helst samme vakttype noen dager på rad. Vaktene som står (også publiserte og fraværet), tas
        med. Forslaget legges inn som utkast, som du ser over og publiserer.
      </p>
      <form className="rad" onSubmit={lagForslag}>
        <label>
          Fra
          <input type="date" required min={iDag()} value={fra} onChange={(e) => settFra(e.target.value)} />
        </label>
        <label>
          Til
          <input type="date" required min={fra} value={til} onChange={(e) => settTil(e.target.value)} />
        </label>
        <label className="avkryss" style={{ gridColumn: "1 / -1" }}>
          <input type="checkbox" checked={erstatt} onChange={(e) => settErstatt(e.target.checked)} /> Erstatt utkastene fra tidligere forslag i perioden (vakter du har
          endret eller publisert, står)
        </label>
        <label className="avkryss" style={{ gridColumn: "1 / -1" }}>
          <input type="checkbox" checked={ledige} onChange={(e) => settLedige(e.target.checked)} /> Lag ledige vakter for det som ikke kan fylles (de med rollen kan ta
          dem når de er publisert)
        </label>
        <div className="knapper" style={{ gridColumn: "1 / -1" }}>
          <button className={forslag ? undefined : "primar"} disabled={h.opptatt}>
            {forslag ? "Lag nytt forslag" : "Lag forslag"}
          </button>
        </div>
      </form>
      <Feil melding={h.feil} />
      {forslag && (
        <div className="forslag">
          <div className={`melding ${hullSum ? "advarsel" : "ok"}`}>
            {nye} {nye === 1 ? "vakt" : "vakter"} fordelt
            {hullSum ? `, ${hullSum} ${hullSum === 1 ? "plass" : "plasser"} kunne ikke fylles${ledige ? " (blir ledige vakter)" : ""}` : ", hele behovet er dekket"}.
            {forslag.erstattes > 0 && ` ${forslag.erstattes} utkast fra tidligere forslag erstattes.`}
          </div>
          <div className="behov-rull">
            <table className="behov-tabell forslag-tabell">
              <thead>
                <tr>
                  <th>Ansatt</th>
                  <th>Timer</th>
                  {typer.map((t) => (
                    <th key={t.id}>
                      <VakttypeMerke t={t} tittel={t.navn} />
                    </th>
                  ))}
                  <th>Helger</th>
                </tr>
              </thead>
              <tbody>
                {forslag.forslag.personer.map((p) => (
                  <tr key={p.ansatt_id}>
                    <th scope="row">{p.navn}</th>
                    <td className={p.maal > 0 && p.timer < p.maal - 8 ? "under" : undefined}>
                      {tekstTall(p.timer)}
                      <span className="dempet"> / {tallformat.format(Math.round(p.maal * 10) / 10)}</span>
                    </td>
                    {typer.map((t) => (
                      <td key={t.id}>{p.per_type[t.id] ?? ""}</td>
                    ))}
                    <td>{p.helger || ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="liten dempet">Timer: planlagt / avtalt i de hele ukene perioden dekker, med vaktene som står fra før.</p>
          {forslag.forslag.hull.length > 0 && (
            <details className="hull">
              <summary>Det som ikke kunne fylles, og hvorfor</summary>
              <ul>
                {forslag.forslag.hull.map((x) => {
                  const t = typeAv.get(x.vakttype_id);
                  return (
                    <li key={`${x.dato}:${x.vakttype_id}:${x.rolle_id ?? ""}`}>
                      <strong>{visDag(x.dato)}</strong> {t && <VakttypeMerke t={t} />} {t?.navn}
                      {x.rolle_id ? ` (${rolle(x.rolle_id)})` : ""}: {x.antall} {x.antall === 1 ? "plass" : "plasser"}. <span className="dempet">{x.grunn}.</span>
                    </li>
                  );
                })}
              </ul>
            </details>
          )}
          <div className="knapper">
            <button type="button" className="primar" disabled={h.opptatt || !forslag.forslag.vakter.length} onClick={leggInn}>
              Legg inn som utkast
            </button>
          </div>
        </div>
      )}
      {svar.kjoringer.length > 0 && (
        <div className="kjoringer">
          <h3>Siste kjøringer</h3>
          <ul className="liste-enkel">
            {svar.kjoringer.map((k) => (
              <li key={k.id}>
                <span>
                  {visDag(k.fra)} – {visDag(k.til)}:{" "}
                  <span className="dempet">
                    {k.vakter} vakter{k.ledige ? `, ${k.ledige} ledige` : ""}. {k.utkast} utkast, {k.publisert} publisert.
                  </span>
                </span>
                {k.utkast > 0 && (
                  <button type="button" className="lenke fare" disabled={h.opptatt} onClick={() => angre(k)}>
                    Angre
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
