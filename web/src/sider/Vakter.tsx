// Vaktplan: eier og administrator planlegger uka (tabell på PC, dag for dag på mobil),
// publiserer den og kopierer uker; regnskap og de ansatte ser planen (0063). Ansatte ser også sine
// egne vakter og de ledige, som de kan ta, melder seg syke, og gir bort eller bytter vakter (Vaktbytte.tsx).
// Advarslene etter arbeidsmiljøloven (hviletid, overtid) kommer fra serveren
// (server/src/vaktregler.ts). Tavla (Tavle.tsx), måneden i vaktplanen (Bemanning.tsx), fraværet
// (Fravaer.tsx) og vaktbyttene er egne faner. Vaktplanen viser rolle for rolle, og hvilke roller som
// vises, velges over den (Rollevalg i Roller.tsx; det samme valget i dagen, uka og måneden).
//
// Fanen står i adressen (?fane=plan|tavle|fravaer|mine|ledige|bytter; kalender er måneden i planen), vaktplanen per dag,
// uke eller måned (?visning=dag|maaned; uke uten), uka med mandagen (?uke=2026-10-12), dagen i
// vaktplanen og på tavla (?dato=2026-10-14) og måneden i vaktplanen (?maaned=2026-10).
import { useEffect, useState, type CSSProperties, type FormEvent, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, hent } from "../api";
import { Dialog, Feil, Laster, Tom, tall, useData, useHandling, useNarDataEndres, useSmal } from "../felles";
import { erAdmin, kanPersonal, kanSePersonal, useKonto } from "../konto";
import { iDag, leggTilDager } from "../format";
import { IkonHoyre, IkonKalender, IkonPluss, IkonVarsel, IkonVenstre } from "../ikoner";
import { gyldigDato, Klokkeslett, mandag, middag, regnTimer, tallformat, timer, ukedagFormat, ukedager, ukenr, ukePeriode, Ukevelger, visDag } from "../uke";
import { borteTekst, FravaerDialog, fravaerKlasse, fravaerTekst, FravaerListe, MittFravaer, VikarSkjema, type Fravaer, type FravaerType } from "./Fravaer";
import { iFasen, Tavle, visLangDag } from "./Tavle";
import { Bemanning, gyldigMaaned } from "./Bemanning";
import { ArbeidsplanDialog, fastTid, fastTider } from "./Arbeidsplan";
import { helligdag } from "../helligdager";
import { aapentPaa, ByttDialog, Bytter, fraKolleger, type ByttSvar, type ByttVakt, type Bytte, type Innstilling } from "./Vaktbytte";
import { rollevalg, Rollevalg, useRollevalg, type Rolle, type Rollevalget } from "./Roller";

export type Vakt = {
  id: string;
  ansatt_id: string | null;
  ansatt_navn: string | null;
  dato: string;
  fra: string;
  til: string;
  pause_min: number;
  timer: number;
  oppgave: string | null;
  notat: string | null;
  publisert: boolean;
  fort: boolean;
  advarsler: string[];
  // Vikar: vakten dekker for en som er borte (navnet ser bare den som ser hele planen).
  vikar_for: string | null;
  vikar_for_navn: string | null;
  har_vikar: boolean; // en vikar dekker denne vakten
  fravaer: FravaerType | null; // den ansatte er borte den dagen
};
// En fast arbeidsdag fra arbeidsplanen (server/src/arbeidsplan.ts): en dag i planen uten vakt.
// En hel dag har ikke klokkeslett.
export type Fast = { ansatt_id: string; dato: string; fra: string | null; til: string | null; pause_min: number; timer: number; fravaer: FravaerType | null };
type Ukesum = { ansatt_id: string; fra: string; planlagt: number; avtalt: number | null; advarsler: string[] };
export type VaktSvar = {
  vakter: Vakt[];
  uker: Ukesum[];
  upubliserte: number;
  fravaer: Fravaer[];
  faste: Fast[];
  // Timene utover den faste planen den dagen (plan), eller utover avtalt arbeidstid i uka.
  ekstra: { ansatt_id: string; dato: string; timer: number; plan: boolean }[];
};
// Vakten vikaren settes inn for (id-en er tom for en fast dag uten vakt).
export type VikarVakt = Pick<Vakt, "id" | "dato" | "fra" | "til" | "oppgave" | "ansatt_id" | "ansatt_navn">;
type MinPlass = { dato: string; fase: string; fra: string | null; til: string | null; oppgave: string };
type Ansatt = {
  id: string;
  fornavn: string;
  etternavn: string;
  forkortelse?: string | null; // «AB» i dags- og månedsvisningen (0061_forkortelser.sql)
  gruppe_id?: string | null; // rollen
  ansatt_fra: string;
  ansatt_til: string | null;
  aktiv: boolean;
};
// Vaktplanen per dag, uke eller måned (måneden er bemanningskalenderen, Bemanning.tsx).
type Visning = "dag" | "uke" | "maaned";

const tid = (v: Pick<Vakt, "fra" | "til">) => `${v.fra}–${v.til}`;
const fornavn = (navn: string) => navn.split(" ")[0];
// Har vakten begynt (norsk tid)? En hel dag begynner kl. 08.
const klokka = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "Europe/Oslo" }); // «14:05»
const begynt = (dato: string, fra: string | null) => dato < iDag() || (dato === iDag() && (fra ?? "08:00") <= klokka.format(new Date()));

// Forrige vakt som ble lagret på denne enheten: nye vakter starter med samme tider.
const SIST = "faktura.vakt.sist";
type Sist = { fra: string; til: string; pause_min: number; oppgave: string };
function lesSist(): Sist | null {
  try {
    const v = JSON.parse(localStorage.getItem(SIST) ?? "null");
    return v && typeof v.fra === "string" ? v : null;
  } catch {
    return null;
  }
}
function huskSist(v: Sist) {
  try {
    localStorage.setItem(SIST, JSON.stringify(v));
  } catch {
    /* ikke kritisk */
  }
}

const TITLER: Record<string, string> = {
  plan: "Vaktplan",
  tavle: "Tavle",
  fravaer: "Fravær",
  mine: "Vakter",
  ledige: "Vakter",
  bytter: "Vaktbytte",
};

export function Vakter() {
  const { org } = useKonto();
  const [sok, settSok] = useSearchParams();
  const [versjon, settVersjon] = useState(0);
  const endret = () => settVersjon((v) => v + 1);
  useNarDataEndres(endret); // f.eks. vakter, fravær og vikarer fra AI-assistenten
  const seHelePlanen = kanSePersonal(org?.rolle);
  const egen = org?.ansatt_id ?? null;
  // Rollene som vises i vaktplanen (dagen, uka og måneden), husket på enheten.
  const rollevalget = useRollevalg(org?.id);

  // Egne og ledige vakter de neste åtte ukene (for ansatte; hele planen står under Vaktplan).
  const fra = iDag();
  const egne = useData(
    () => (egen && org?.personal ? hent<VaktSvar>(`/org/${org.id}/vakter?fra=${fra}&til=${leggTilDager(fra, 55)}&ansatt=${egen}&ledige=1`) : Promise.resolve(null)),
    [org?.id, org?.personal, egen, versjon],
  );
  const plasser = useData(
    () => (egen && org?.personal ? hent<MinPlass[]>(`/org/${org.id}/tavle/mine?fra=${fra}&til=${leggTilDager(fra, 55)}`) : Promise.resolve([])),
    [org?.id, org?.personal, egen, versjon],
  );
  const ledige = (egne.data?.vakter ?? []).filter((v) => !v.ansatt_id && v.publisert && v.dato >= fra);
  // Vaktbyttene (Vaktbytte.tsx): for den ansatte og for dem som ser hele planen.
  const bytter = useData(
    () => ((egen || seHelePlanen) && org?.personal ? hent<ByttSvar>(`/org/${org.id}/vaktbytter`) : Promise.resolve(null)),
    [org?.id, org?.personal, egen, seHelePlanen, versjon],
  );
  const innstilling: Innstilling = bytter.data?.innstilling ?? "av";
  const kollegaTilbud = fraKolleger(bytter.data?.bytter, egen);
  const tilSvar =
    (bytter.data?.bytter ?? []).filter((b) => b.status === "tilbudt" && !!egen && b.til_ansatt === egen).length +
    (kanPersonal(org?.rolle) ? (bytter.data?.bytter ?? []).filter((b) => b.status === "akseptert").length : 0);
  const tilGodkjenning = kanPersonal(org?.rolle) ? (bytter.data?.bytter ?? []).filter((b) => b.status === "akseptert").length : 0;

  const faner: [string, ReactNode][] = [];
  // Vaktplanen har dagen, uka og måneden (måneden er bemanningskalenderen, Bemanning.tsx).
  if (seHelePlanen) faner.push(["plan", "Vaktplan"], ["tavle", "Tavle"], ["fravaer", "Fravær"]);
  if (egen)
    faner.push(
      ["mine", "Mine vakter"],
      [
        "ledige",
        <>
          Ledige vakter
          {ledige.length + kollegaTilbud.length > 0 && <span className="teller">{ledige.length + kollegaTilbud.length}</span>}
        </>,
      ],
    );
  // De ansatte ser hele den publiserte planen (også måneden) og tavla, bare til lesing (0063); ikke en
  // som har sluttet (ser_planen).
  const ansattSerPlanen = !seHelePlanen && !!egen && org?.ser_planen !== false;
  if (ansattSerPlanen) faner.push(["plan", "Vaktplan"], ["tavle", "Tavle"]);
  if (bytter.data && (bytter.data.innstilling !== "av" || (bytter.data.bytter?.length ?? 0) > 0))
    faner.push([
      "bytter",
      <>
        Bytter
        {tilSvar > 0 && <span className="teller">{tilSvar}</span>}
      </>,
    ]);
  const gammelKalender = sok.get("fane") === "kalender";
  const fane = faner.find(([v]) => v === (gammelKalender ? "plan" : sok.get("fane")))?.[0] ?? faner[0]?.[0] ?? null;
  const uke = mandag(gyldigDato(sok.get("uke")) ? sok.get("uke")! : iDag());
  const dato = gyldigDato(sok.get("dato")) ? sok.get("dato")! : iDag();
  const maaned = gyldigMaaned(sok.get("maaned")) ? sok.get("maaned")! : iDag().slice(0, 7);
  const visning: Visning = sok.get("visning") === "dag" ? "dag" : sok.get("visning") === "maaned" || gammelKalender ? "maaned" : "uke";
  const ga = (endring: Record<string, string | null>) => {
    const p = new URLSearchParams(sok);
    for (const [k, v] of Object.entries(endring)) {
      if (v === null) p.delete(k);
      else p.set(k, v);
    }
    settSok(p, { replace: true });
  };
  // Kalenderen er måneden i vaktplanen nå: gamle lenker og varsler (fane=kalender) går dit.
  useEffect(() => {
    if (gammelKalender) ga({ fane: "plan", visning: "maaned" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gammelKalender]);
  // En annen visning (eller en dag fra måneden): dagen, uka eller måneden følger det som vises nå.
  const velgVisning = (v: Visning, dag?: string) => {
    const denneMnd = iDag().slice(0, 7);
    const her = dag ?? (visning === "dag" ? dato : visning === "uke" ? (ukedager(uke).includes(iDag()) ? iDag() : uke) : maaned === denneMnd ? iDag() : `${maaned}-01`);
    ga({
      visning: v === "uke" ? null : v,
      dato: v === "dag" && her !== iDag() ? her : v === "dag" ? null : sok.get("dato"),
      uke: v === "uke" && mandag(her) !== mandag(iDag()) ? mandag(her) : v === "uke" ? null : sok.get("uke"),
      maaned: v === "maaned" && her.slice(0, 7) !== denneMnd ? her.slice(0, 7) : v === "maaned" ? null : sok.get("maaned"),
    });
  };

  if (!org?.personal || !fane)
    return (
      <>
        <h1>Vaktplan</h1>
        <div className="kort">
          <Tom ikon={<IkonKalender storrelse={22} />} tittel={!org?.personal ? "Vaktplanen er ikke slått på" : "Du har ingen vakter her"}>
            {!org?.personal && erAdmin(org?.rolle) ? (
              <p>
                Slå på ansatte og timer under <Link to="/innstillinger?fane=personal">Innstillinger → Ansatte og timer</Link>.
              </p>
            ) : (
              <p>Ta kontakt med den som administrerer {org?.navn}.</p>
            )}
          </Tom>
        </div>
      </>
    );

  return (
    <>
      <div className={faner.length > 1 ? "topp med-faner" : "topp"}>
        <h1>{TITLER[fane] ?? "Vakter"}</h1>
      </div>
      {faner.length > 1 && (
        <div className="faner tett" role="tablist">
          {faner.map(([v, t]) => (
            <button key={v} type="button" role="tab" aria-selected={fane === v} className={fane === v ? "valgt" : undefined} onClick={() => ga({ fane: v })}>
              {t}
            </button>
          ))}
        </div>
      )}
      {fane === "plan" && visning === "maaned" && (
        <Bemanning
          maaned={maaned}
          velgMaaned={(m) => ga({ maaned: m === iDag().slice(0, 7) ? null : m })}
          kanEndre={kanPersonal(org.rolle)}
          seAlle={seHelePlanen}
          visningsvalg={<Visningsvalg visning={visning} velg={velgVisning} />}
          tilDag={(d) => velgVisning("dag", d)}
          tilUke={(m) => velgVisning("uke", m)}
          rollevalget={rollevalget}
        />
      )}
      {fane === "plan" && visning !== "maaned" && (
        <Vaktplan
          visning={visning}
          velgVisning={velgVisning}
          dato={dato}
          velgDato={(d) => ga({ dato: d === iDag() ? null : d })}
          tilTavle={(d) => ga({ fane: "tavle", dato: d === iDag() ? null : d })}
          uke={uke}
          velgUke={(u) => ga({ uke: u === mandag(iDag()) ? null : u })}
          kanPlanlegge={kanPersonal(org.rolle)}
          seAlle={seHelePlanen}
          versjon={versjon}
          endret={endret}
          tilGodkjenning={tilGodkjenning}
          tilBytter={() => ga({ fane: "bytter" })}
          rollevalget={rollevalget}
        />
      )}
      {fane === "tavle" && <Tavle dato={dato} velgDato={(d) => ga({ dato: d === iDag() ? null : d })} kanEndre={kanPersonal(org.rolle)} />}
      {fane === "fravaer" && <FravaerListe versjon={versjon} endret={endret} />}
      {fane === "mine" && (
        <MineVakter
          svar={egne.data ?? undefined}
          feil={egne.feil}
          egen={egen!}
          plasser={plasser.data ?? []}
          ledige={ledige.length + kollegaTilbud.length}
          tilLedige={() => ga({ fane: "ledige" })}
          bytter={bytter.data?.bytter}
          innstilling={innstilling}
          tilBytter={() => ga({ fane: "bytter" })}
          endret={endret}
        />
      )}
      {fane === "ledige" && (
        <LedigeVakter vakter={egne.data ? ledige : undefined} tilbud={kollegaTilbud} innstilling={innstilling} feil={egne.feil} endret={endret} />
      )}
      {fane === "bytter" && (
        <Bytter svar={bytter.data ?? undefined} feil={bytter.feil} egen={egen} leder={kanPersonal(org.rolle)} seAlle={seHelePlanen} endret={endret} />
      )}
    </>
  );
}

// --- Planen (eier og administrator planlegger; regnskap og de ansatte ser den) ----------

const DAGNAVN = ["Ma", "Ti", "On", "To", "Fr", "Lø", "Sø"];

// Dagen, uka eller måneden i vaktplanen (dagen og uka her, måneden i Bemanning.tsx).
function Visningsvalg({ visning, velg }: { visning: Visning; velg: (v: Visning) => void }) {
  return (
    <div className="faner valg visningsvalg" role="radiogroup" aria-label="Visning">
      {(
        [
          ["dag", "Dag"],
          ["uke", "Uke"],
          ["maaned", "Måned"],
        ] as const
      ).map(([v, t]) => (
        <button key={v} type="button" role="radio" aria-checked={visning === v} className={visning === v ? "valgt" : undefined} onClick={() => velg(v)}>
          {t}
        </button>
      ))}
    </div>
  );
}

function Vaktplan({
  visning,
  velgVisning,
  dato,
  velgDato,
  tilTavle,
  uke,
  velgUke,
  kanPlanlegge,
  seAlle,
  versjon,
  endret,
  tilGodkjenning,
  tilBytter,
  rollevalget,
}: {
  visning: Visning;
  velgVisning: (v: Visning, dato?: string) => void;
  dato: string;
  velgDato: (dato: string) => void;
  tilTavle: (dato: string) => void;
  uke: string;
  velgUke: (mandag: string) => void;
  kanPlanlegge: boolean;
  // false: en ansatt, som ser den publiserte planen uten timene per uke til kollegaene (0063).
  seAlle: boolean;
  versjon: number;
  endret: () => void;
  tilGodkjenning: number;
  tilBytter: () => void;
  rollevalget: Rollevalget;
}) {
  const { org } = useKonto();
  // Perioden som vises: dagen eller uka (måneden er bemanningskalenderen).
  const [fra, til] = visning === "dag" ? [dato, dato] : [uke, leggTilDager(uke, 6)];
  const ansatte = useData(() => hent<Ansatt[]>(`/org/${org!.id}/${seAlle ? "ansatte" : "kolleger"}`), [org?.id, seAlle, versjon]);
  // Rollene: rekkefølgen og fargene, og rollevalget.
  const grupper = useData(() => hent<Rolle[]>(`/org/${org!.id}/ansattgrupper`), [org?.id, versjon]);
  const { data, feil } = useData(() => hent<VaktSvar>(`/org/${org!.id}/vakter?fra=${fra}&til=${til}`), [org?.id, fra, til, versjon]);
  const [apen, settApen] = useState<(Partial<Vakt> & { fraPlan?: boolean }) | null>(null);
  const [vikarFor, settVikarFor] = useState<VikarVakt | null>(null);
  // Fravær og arbeidstid for en ansatt, rett fra vaktplanen (samme som i ansattkortet).
  const [fravaerFor, settFravaerFor] = useState<Partial<Fravaer> | null>(null);
  const [planFor, settPlanFor] = useState<string | null>(null);
  const [kopierer, settKopierer] = useState(false);
  const [melding, settMelding] = useState<string | null>(null);
  const h = useHandling();
  const smal = useSmal(1099);
  // Mobil: én dag om gangen, valgt i en stripe med ukedagene (samme ukedag når uka byttes).
  const mobil = useSmal();
  const [ukedag, settUkedag] = useState<number | null>(null);
  const dager = ukedager(uke);
  const nr = ukenr(uke).uke;
  const valgtDag = dager[ukedag ?? Math.max(0, dager.indexOf(iDag()))]!;
  // Ny periode: ikke vis meldingen eller feilen fra den forrige.
  useEffect(() => {
    settMelding(null);
    h.settFeil(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fra, til]);
  const periodeNavn = visning === "dag" ? visDag(dato) : `Uke ${nr}`;

  // Publiser utkastene i perioden som vises.
  const publiser = () =>
    h.kjor(async () => {
      const r = await api<{ publisert: number; varslet: number }>("POST", `/org/${org!.id}/vakter/publiser`, { fra, til });
      settMelding(
        `${periodeNavn} er publisert (${r.publisert} ${r.publisert === 1 ? "vakt" : "vakter"}).` +
          (r.varslet ? ` ${r.varslet} ${r.varslet === 1 ? "ansatt har" : "ansatte har"} fått varsel.` : ""),
      );
      endret();
    });
  const kopierForrige = () =>
    h.kjor(async () => {
      const r = await api<{ kopiert: number; hoppet_over: number }>("POST", `/org/${org!.id}/vakter/kopier`, { fra: leggTilDager(uke, -7), til: uke });
      settMelding(kopiMelding(r, `uke ${nr}`));
      endret();
    });

  // «Ny vakt»: dagen som vises (mobil: den valgte), i dag om den er i perioden, ellers den første.
  const nyDato = visning === "dag" ? dato : mobil ? valgtDag : dager.includes(iDag()) ? iDag() : uke;
  const verktoy = (
    <div className="uke-verktoy">
      <Visningsvalg visning={visning} velg={velgVisning} />
      {visning === "dag" ? (
        <Periodevelger
          navn={visLangDag(dato)}
          under={`Uke ${ukenr(dato).uke}`}
          forrige={["Forrige dag", () => velgDato(leggTilDager(dato, -1))]}
          neste={["Neste dag", () => velgDato(leggTilDager(dato, 1))]}
          naa={dato !== iDag() ? ["I dag", () => velgDato(iDag())] : undefined}
        />
      ) : (
        <Ukevelger uke={uke} velgUke={velgUke} />
      )}
      {kanPlanlegge && data && (
        <div className="knapper">
          {visning === "uke" && data.vakter.length > 0 && (
            <button type="button" onClick={() => settKopierer(true)}>
              Kopier uka
            </button>
          )}
          {data.upubliserte > 0 && (
            <button type="button" className="primar" disabled={h.opptatt} onClick={publiser}>
              Publiser ({data.upubliserte})
            </button>
          )}
          <button type="button" className={data.upubliserte > 0 ? undefined : "primar"} onClick={() => settApen({ dato: nyDato })}>
            <IkonPluss storrelse={18} /> Ny vakt
          </button>
        </div>
      )}
    </div>
  );

  if (feil || ansatte.feil || grupper.feil)
    return (
      <>
        {verktoy}
        <Feil melding={feil ?? ansatte.feil ?? grupper.feil} />
      </>
    );
  if (!data || !ansatte.data || !grupper.data)
    return (
      <>
        {verktoy}
        <Laster />
      </>
    );

  // Rollene som vises (ledige vakter har ingen rolle, og vises alltid).
  const r = rolleoppsett(grupper.data, ansatte.data);
  const rv = rollevalg(rollevalget.valgt, grupper.data, ansatte.data);
  const vises = (id: string | null) => !id || rv.vises(r.rolle(id));
  // Radene: ansatte i jobb denne uka, og alle som har vakter i den, rolle for rolle (i rollenes
  // rekkefølge, som dagen og måneden). Ledige vakter øverst.
  const rader = ansatte.data.filter(
    (a) => vises(a.id) && (data.vakter.some((v) => v.ansatt_id === a.id) || (a.aktiv && a.ansatt_fra <= til && (!a.ansatt_til || a.ansatt_til >= uke))),
  );
  const rolleRader = r.seksjoner.map((s) => ({ s, folk: rader.filter((a) => r.rolle(a.id) === s.id) })).filter((x) => x.folk.length > 0);
  const medRoller = grupper.data.length > 0;
  const navn = new Map(ansatte.data.map((a) => [a.id, `${a.fornavn} ${a.etternavn}`]));
  const alleFaste = data.faste ?? [];
  const ledige = data.vakter.filter((v) => !v.ansatt_id);
  const sum = (a: string) => data.uker.find((u) => u.ansatt_id === a);
  const advarsler = [
    ...data.vakter.flatMap((v) => v.advarsler.map((t) => ({ hvem: v.ansatt_navn ?? "Ledig vakt", nar: `${visDag(v.dato)} ${tid(v)}`, tekst: t }))),
    ...data.uker.flatMap((u) => {
      const a = ansatte.data!.find((x) => x.id === u.ansatt_id);
      return u.advarsler.map((t) => ({ hvem: a ? `${a.fornavn} ${a.etternavn}` : "", nar: `Uke ${ukenr(u.fra).uke}`, tekst: t }));
    }),
  ];
  const nyVakt = (dato: string, ansatt_id: string | null) => kanPlanlegge && settApen({ dato, ansatt_id });
  // Fraværet til en ansatt en dag, og hvor mange som er på jobb (med vakt eller fast arbeidsdag;
  // de som er borte, teller ikke).
  const borteDag = (a: string, d: string) => data.fravaer.find((f) => f.ansatt_id === a && f.fra <= d && f.til >= d);
  const fastDag = (a: string, d: string) => alleFaste.find((f) => f.ansatt_id === a && f.dato === d);
  const paJobb = (d: string) =>
    new Set([
      ...data.vakter.filter((v) => v.dato === d && v.ansatt_id && !v.fravaer && vises(v.ansatt_id)).map((v) => v.ansatt_id),
      ...alleFaste.filter((f) => f.dato === d && !f.fravaer && vises(f.ansatt_id)).map((f) => f.ansatt_id),
    ]).size;
  const manglerVikar = (d: string) => data.vakter.filter((v) => v.dato === d && v.ansatt_id && v.fravaer && !v.har_vikar && vises(v.ansatt_id)).length;

  const chip = (v: Vakt, medNavn = false) => {
    const mangler = !!v.fravaer && !v.har_vikar;
    return (
      <button
        key={v.id}
        type="button"
        className={`vakt-chip${v.publisert ? "" : " utkast"}${v.advarsler.length ? " advarsel" : ""}${v.fravaer ? " borte" : ""}${mangler ? " mangler" : ""}${v.vikar_for ? " vikar" : ""}`}
        title={
          [
            v.publisert ? "" : "Ikke publisert",
            v.fravaer ? `${fravaerTekst[v.fravaer]}: ${v.har_vikar ? "vikar er satt inn" : "mangler vikar"}` : "",
            v.vikar_for_navn ? `Vikar for ${v.vikar_for_navn}` : "",
            ...v.advarsler,
          ]
            .filter(Boolean)
            .join("\n") || undefined
        }
        onClick={(e) => {
          e.stopPropagation();
          settApen(v);
        }}
      >
        <span className="vakt-tid">
          {v.advarsler.length > 0 && <IkonVarsel storrelse={13} />}
          {tid(v)}
        </span>
        {medNavn && <span className="vakt-navn">{v.ansatt_navn ?? "Ledig vakt"}</span>}
        {v.fravaer ? (
          <span className="vakt-fravaer">
            {fravaerTekst[v.fravaer]} · {v.har_vikar ? "vikar inne" : "mangler vikar"}
          </span>
        ) : (
          v.vikar_for && <span className="vakt-vikar">Vikar{v.vikar_for_navn ? ` for ${fornavn(v.vikar_for_navn)}` : ""}</span>
        )}
        {v.oppgave && <span className="vakt-oppgave">{v.oppgave}</span>}
      </button>
    );
  };

  // En fast arbeidsdag: trykk for å lage en vakt i stedet (andre tider den dagen), eller for å
  // sette inn vikar når den ansatte er borte.
  const apneFast = (f: Fast) => {
    if (f.fravaer) settVikarFor({ id: "", dato: f.dato, ...fastTider(f), oppgave: null, ansatt_id: f.ansatt_id, ansatt_navn: navn.get(f.ansatt_id) ?? null });
    else settApen({ dato: f.dato, ansatt_id: f.ansatt_id, ...fastTider(f), pause_min: f.pause_min, fraPlan: true });
  };
  const fastChip = (f: Fast, medNavn = false) => {
    const tittel = f.fravaer
      ? `Fast arbeidsdag. ${fravaerTekst[f.fravaer]}${kanPlanlegge ? ": trykk for å sette inn vikar" : ""}`
      : `Fast arbeidsdag (${timer(f.timer)})${kanPlanlegge ? ". Trykk for å lage en vakt med andre tider" : ""}`;
    const innhold = (
      <>
        {fastTid(f) && <span className="vakt-tid">{fastTid(f)}</span>}
        {medNavn && <span className="vakt-navn">{navn.get(f.ansatt_id) ?? ""}</span>}
        {/* En hel dag med navnet: navnet holder. */}
        {f.fravaer ? <span className="vakt-fravaer">{fravaerTekst[f.fravaer]}</span> : (!medNavn || fastTid(f)) && <span className="vakt-fast">Fast</span>}
      </>
    );
    const klasse = `vakt-chip fast${f.fravaer ? " borte" : ""}`;
    if (!kanPlanlegge)
      return (
        <span key={`fast-${f.ansatt_id}`} className={klasse} title={tittel}>
          {innhold}
        </span>
      );
    return (
      <button
        key={`fast-${f.ansatt_id}`}
        type="button"
        className={klasse}
        title={tittel}
        onClick={(e) => {
          e.stopPropagation();
          apneFast(f);
        }}
      >
        {innhold}
      </button>
    );
  };

  // En dag i lista (nettbrett og mobil): hvem som er borte, og vaktene og de faste dagene.
  const dagen = (d: string) => {
    const dagens = data.vakter.filter((v) => v.dato === d && vises(v.ansatt_id));
    const faste = alleFaste.filter((f) => f.dato === d && vises(f.ansatt_id));
    const borte = data.fravaer.filter((f) => f.fra <= d && f.til >= d && vises(f.ansatt_id));
    const mangler = manglerVikar(d);
    // Ledige vakter først, så rolle for rolle etter når de begynner (en hel dag fra kl. 08) og navnet.
    const rekke = (id: string | null) => (id ? r.rekke(id) : -1);
    const ordnet = [
      ...dagens.map((v) => ({ k: rekke(v.ansatt_id), fra: v.fra, navn: v.ansatt_navn ?? "", el: chip(v, true) })),
      ...faste.map((f) => ({ k: rekke(f.ansatt_id), fra: f.fra ?? "08:00", navn: navn.get(f.ansatt_id) ?? "", el: fastChip(f, true) })),
    ].sort((a, b) => a.k - b.k || a.fra.localeCompare(b.fra) || a.navn.localeCompare(b.navn, "nb"));
    return (
      <section key={d} className={`dag${d === iDag() ? " i-dag" : ""}${helligdag(d) ? " helligdag" : ""}`} aria-label={visDag(d)}>
        <div className="dag-topp">
          <span className="dag-navn">
            {visDag(d)}
            {helligdag(d) && <span className="helligdag-navn">{helligdag(d)}</span>}
          </span>
          {dagens.length + faste.length > 0 && <span className="dag-sum">{paJobb(d)} på jobb</span>}
          {kanPlanlegge && (
            <button type="button" className="kopier" aria-label={`Ny vakt ${visDag(d)}`} title="Ny vakt" onClick={() => nyVakt(d, null)}>
              <IkonPluss storrelse={18} />
            </button>
          )}
        </div>
        {(borte.length > 0 || mangler > 0) && (
          <div className="dag-fravaer">
            {mangler > 0 && <span className="merke merke-fare">{mangler} mangler vikar</span>}
            {borte.map((f) => (
              <span key={f.id} className={`merke ${fravaerKlasse[f.type]}`}>
                {fornavn(f.ansatt_navn)}: {fravaerTekst[f.type].toLowerCase()}
              </span>
            ))}
          </div>
        )}
        {ordnet.length > 0 ? (
          <div className="vakt-rad">{ordnet.map((x) => x.el)}</div>
        ) : (
          mobil && <p className="dempet liten ingen-vakter">Ingen vakter denne dagen.</p>
        )}
      </section>
    );
  };

  return (
    <>
      {verktoy}
      <Rollevalg valg={rv.valg} aktive={rv.aktive} velg={rollevalget.velg} />
      {melding && (
        <div className="melding ok" role="status">
          {melding}
        </div>
      )}
      <Feil melding={h.feil} />
      {tilGodkjenning > 0 && (
        <div className="melding info venter">
          <span>{tilGodkjenning === 1 ? "Ett vaktbytte venter" : `${tilGodkjenning} vaktbytter venter`} på godkjenning.</span>
          <button type="button" className="lenke" onClick={tilBytter}>
            Se {tilGodkjenning === 1 ? "det" : "dem"}
          </button>
        </div>
      )}
      {kanPlanlegge && data.upubliserte > 0 && (
        <p className="liten dempet utkast-info">
          {data.upubliserte === 1 ? "Én vakt" : `${data.upubliserte} vakter`} med stiplet kant er ikke publisert. De ansatte ser dem først når du publiserer.
        </p>
      )}
      {visning === "dag" ? (
        <DagVisning
          dato={dato}
          data={data}
          ansatte={ansatte.data}
          grupper={grupper.data}
          kanPlanlegge={kanPlanlegge}
          apneVakt={(v) => settApen(v)}
          apneFast={apneFast}
          nyVakt={nyVakt}
          tilTavle={tilTavle}
          vises={vises}
        />
      ) : !data.vakter.length && !alleFaste.length ? (
        <div className="kort">
          <Tom ikon={<IkonKalender storrelse={22} />} tittel={`Ingen vakter i uke ${nr}`}>
            {kanPlanlegge ? (
              <>
                <p>
                  Legg inn vakter for de ansatte, eller kopier forrige ukes plan. Vaktene er utkast til du publiserer uka. Faste arbeidsdager legger du inn på hver ansatt
                  under Ansatte.
                </p>
                <div className="knapper" style={{ justifyContent: "center" }}>
                  <button type="button" disabled={h.opptatt} onClick={kopierForrige}>
                    Kopier uke {ukenr(leggTilDager(uke, -7)).uke}
                  </button>
                  <button type="button" className="primar" onClick={() => settApen({ dato: dager.includes(iDag()) ? iDag() : uke })}>
                    Ny vakt
                  </button>
                </div>
              </>
            ) : (
              <p>Vaktene vises her når de er planlagt.</p>
            )}
          </Tom>
        </div>
      ) : smal ? (
        <>
          {mobil && (
            <div className="dagvelger" role="tablist" aria-label="Dag">
              {dager.map((d, i) => {
                const n = paJobb(d);
                const mangler = manglerVikar(d) > 0;
                const utkast = data.vakter.some((v) => v.dato === d && !v.publisert);
                return (
                  <button
                    key={d}
                    type="button"
                    role="tab"
                    aria-selected={d === valgtDag}
                    aria-label={`${visDag(d)}: ${n} på jobb${mangler ? ", mangler vikar" : ""}${utkast ? ", ikke publisert" : ""}`}
                    className={[d === valgtDag ? "valgt" : "", d === iDag() ? "i-dag" : "", helligdag(d) ? "helligdag" : "", utkast ? "utkast" : ""].filter(Boolean).join(" ") || undefined}
                    onClick={() => settUkedag(i)}
                  >
                    <span className="dv-dag">{DAGNAVN[i]}</span>
                    <span className="dv-dato">{Number(d.slice(8))}</span>
                    <span className={`dv-antall${mangler ? " varsel" : ""}`}>{mangler ? "!" : n || "–"}</span>
                  </button>
                );
              })}
            </div>
          )}
          <div className="kort liste uke-dager vaktdager">{(mobil ? [valgtDag] : dager).map(dagen)}</div>
        </>
      ) : (
        <div className="kort tabell vaktplan">
          <table>
            <thead>
              <tr>
                <th>Ansatt</th>
                {dager.map((d) => (
                  <th key={d} className={[d === iDag() ? "i-dag" : "", helligdag(d) ? "helligdag" : ""].filter(Boolean).join(" ") || undefined} title={helligdag(d) ?? undefined}>
                    {ukedagFormat.format(middag(d))} {Number(d.slice(8))}.
                    {helligdag(d) && <span className="helligdag-navn">{helligdag(d)}</span>}
                  </th>
                ))}
                {seAlle && <th className="tall">Timer</th>}
              </tr>
            </thead>
            {(ledige.length > 0 || kanPlanlegge) && (
              <tbody>
                <tr className="ledige-rad">
                  <td>
                    <strong>Ledige vakter</strong>
                    <span className="liten dempet">Alle ansatte kan ta dem</span>
                  </td>
                  {dager.map((d) => (
                    <td key={d} className={kanPlanlegge ? "ny-vakt" : undefined} onClick={() => nyVakt(d, null)}>
                      {ledige.filter((v) => v.dato === d).map((v) => chip(v))}
                    </td>
                  ))}
                  {seAlle && <td className="tall dempet">{ledige.length ? timer(ledige.reduce((s, v) => s + Number(v.timer), 0)) : ""}</td>}
                </tr>
              </tbody>
            )}
            {/* Rolle for rolle, med rollen over (uten roller: alle i én liste) */}
            {rolleRader.map(({ s, folk }) => (
              <tbody key={s.id ?? "uten"} className={`g${s.farge}`}>
                {medRoller && (
                  <tr className="rolle-rad">
                    <th scope="rowgroup" colSpan={dager.length + (seAlle ? 2 : 1)}>
                      {s.navn}
                    </th>
                  </tr>
                )}
                {folk.map((a) => {
                  const u = sum(a.id);
                  return (
                    <tr key={a.id} className={a.id === org?.ansatt_id ? "meg" : undefined}>
                      <td>
                        {a.fornavn} {a.etternavn}
                      </td>
                      {dager.map((d) => {
                        const vakter = data.vakter.filter((v) => v.ansatt_id === a.id && v.dato === d);
                        const fast = vakter.length ? undefined : fastDag(a.id, d);
                        const f = vakter.length || fast ? undefined : borteDag(a.id, d);
                        return (
                          <td key={d} className={kanPlanlegge ? "ny-vakt" : undefined} onClick={() => nyVakt(d, a.id)}>
                            {vakter.map((v) => chip(v))}
                            {fast && fastChip(fast)}
                            {f && (
                              <span className={`fravaer-dag fravaer-${f.type}`} title={`${fravaerTekst[f.type]} ${f.fra === f.til ? visDag(f.fra) : `${visDag(f.fra)}–${visDag(f.til)}`}`}>
                                {fravaerTekst[f.type]}
                              </span>
                            )}
                          </td>
                        );
                      })}
                      {seAlle && (
                        <td className={`tall${u?.advarsler.length ? " advarsel-tekst" : ""}`} title={u?.advarsler.join("\n") || undefined}>
                          {u ? tallformat.format(u.planlagt) : "–"}
                          {u?.avtalt != null && <span className="dempet"> / {tallformat.format(u.avtalt)}</span>}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            ))}
            {!rolleRader.length && !rv.alle && (
              <tbody>
                <tr>
                  <td colSpan={dager.length + (seAlle ? 2 : 1)} className="rolle-tom">
                    Ingen med de valgte rollene denne uka.{" "}
                    <button type="button" className="lenke" onClick={() => rollevalget.velg([])}>
                      Vis alle
                    </button>
                  </td>
                </tr>
              </tbody>
            )}
            <tfoot>
              <tr className="bemanning-rad">
                <td>På jobb</td>
                {dager.map((d) => (
                  <td key={d}>
                    <strong>{paJobb(d)}</strong>
                    {manglerVikar(d) > 0 && <span className="mangler-tekst">{manglerVikar(d)} mangler vikar</span>}
                  </td>
                ))}
                {seAlle && <td></td>}
              </tr>
            </tfoot>
          </table>
        </div>
      )}
      {visning === "uke" && data.vakter.length + alleFaste.length > 0 && (
        <p className="liten dempet">
          {alleFaste.length > 0 && `«Fast» er en fast arbeidsdag etter arbeidsplanen til den ansatte${seAlle ? " (under Ansatte)" : ""}; en vakt samme dag gjelder i stedet. `}
          {!smal && seAlle && "Timer: planlagt / avtalt arbeidstid i uka. "}
          {kanPlanlegge ? "Trykk i en rute for å legge inn en vakt." : ""}
        </p>
      )}
      {advarsler.length > 0 && (
        <div className="kort advarsler">
          <h2>
            <IkonVarsel storrelse={18} /> {advarsler.length === 1 ? "Én advarsel" : `${advarsler.length} advarsler`}
          </h2>
          <ul className="liste-enkel">
            {advarsler.map((x, i) => (
              <li key={i}>
                <span>
                  <strong>{x.hvem}</strong> <span className="dempet">{x.nar}</span>
                </span>
                <span>{x.tekst}</span>
              </li>
            ))}
          </ul>
          <p className="liten dempet">
            Arbeidsmiljøloven: minst 11 timer hvile mellom arbeidsdagene og 35 timer sammenhengende fri i uka. Overtid etter grensene under Innstillinger →
            Ansatte og timer.
          </p>
        </div>
      )}
      <Dialog apen={!!apen} lukk={() => settApen(null)} tittel={apen?.id ? (kanPlanlegge ? "Endre vakt" : "Vakt") : "Ny vakt"}>
        {apen && (
          <VaktSkjema
            vakt={apen}
            ansatte={ansatte.data}
            oppgaver={[...new Set(data.vakter.map((v) => v.oppgave).filter((o): o is string => !!o))]}
            kanEndre={kanPlanlegge}
            ferdig={(tekst) => {
              settApen(null);
              settMelding(tekst ?? null);
              endret();
            }}
            avbryt={() => settApen(null)}
            settInnVikar={(v) => {
              settApen(null);
              settVikarFor(v);
            }}
            registrerFravaer={(ansatt_id, dato) => {
              settApen(null);
              // Er den ansatte borte den dagen, endres fraværet som gjelder.
              settFravaerFor(data.fravaer.find((f) => f.ansatt_id === ansatt_id && f.fra <= dato && f.til >= dato) ?? { ansatt_id, fra: dato, til: dato });
            }}
            endrePlan={(ansatt_id) => {
              settApen(null);
              settPlanFor(ansatt_id);
            }}
          />
        )}
      </Dialog>
      <FravaerDialog
        fravaer={fravaerFor}
        ansatte={ansatte.data}
        lukk={() => settFravaerFor(null)}
        ferdig={(m) => {
          settFravaerFor(null);
          settMelding(m);
          endret();
        }}
      />
      <ArbeidsplanDialog
        ansattId={planFor}
        lukk={() => settPlanFor(null)}
        lagret={(m) => {
          settPlanFor(null);
          settMelding(m);
          endret();
        }}
      />
      <Dialog apen={!!vikarFor} lukk={() => settVikarFor(null)} tittel="Sett inn vikar">
        {vikarFor && (
          <VikarSkjema
            vakt={vikarFor}
            ansatte={ansatte.data}
            fravaer={data.fravaer}
            opptatt={
              new Map([
                ...alleFaste.filter((f) => f.dato === vikarFor.dato && !f.fravaer).map((f) => [f.ansatt_id, fastTid(f)] as const),
                ...data.vakter.filter((v) => v.dato === vikarFor.dato && v.ansatt_id).map((v) => [v.ansatt_id!, tid(v)] as const),
              ])
            }
            hentVaktId={async () => (await api<Vakt>("POST", `/org/${org!.id}/vakter/fra-plan`, { ansatt_id: vikarFor.ansatt_id, dato: vikarFor.dato })).id}
            ferdig={(tekst) => {
              settVikarFor(null);
              settMelding(tekst);
              endret();
            }}
            avbryt={() => settVikarFor(null)}
          />
        )}
      </Dialog>
      <Dialog apen={kopierer} lukk={() => settKopierer(false)} tittel={`Kopier uke ${nr}`}>
        <KopierSkjema
          uke={uke}
          ferdig={(tekst) => {
            settKopierer(false);
            settMelding(tekst);
            endret();
          }}
          avbryt={() => settKopierer(false)}
        />
      </Dialog>
    </>
  );
}

// --- Velger for dag og måned (som ukevelgeren) ----------------------------------------------

function Periodevelger({ navn, under, forrige, neste, naa }: { navn: string; under: string; forrige: [string, () => void]; neste: [string, () => void]; naa?: [string, () => void] }) {
  return (
    <div className="ukevelger">
      <button type="button" className="ikon" aria-label={forrige[0]} title={forrige[0]} onClick={forrige[1]}>
        <IkonVenstre storrelse={20} />
      </button>
      <div className="uke-navn" aria-live="polite">
        <strong>{navn}</strong>
        <span>{under}</span>
      </div>
      <button type="button" className="ikon" aria-label={neste[0]} title={neste[0]} onClick={neste[1]}>
        <IkonHoyre storrelse={20} />
      </button>
      {naa && (
        <button type="button" className="lenke" onClick={naa[1]}>
          {naa[0]}
        </button>
      )}
    </div>
  );
}

// --- Dags- og månedsvisningen ----------------------------------------------------------------

// Rollene i rekkefølge, med fargene fra måneden i vaktplanen (g0–g4; g5 uten rolle), og
// forkortelsen og navnet til hver person.
function rolleoppsett(grupper: Rolle[], ansatte: Ansatt[]) {
  const indeks = new Map(grupper.map((g, i) => [g.id, i]));
  const person = new Map(ansatte.map((a) => [a.id, a]));
  const rolle = (id: string | null) => {
    const g = id ? person.get(id)?.gruppe_id : null;
    return g && indeks.has(g) ? g : null;
  };
  return {
    seksjoner: [
      ...grupper.map((g, i) => ({ id: g.id as string | null, navn: g.navn, farge: i % 5 })),
      { id: null as string | null, navn: grupper.length ? "Uten rolle" : "På jobb", farge: 5 },
    ],
    rolle,
    rekke: (id: string | null) => indeks.get(rolle(id) ?? "") ?? grupper.length,
    farge: (id: string | null) => {
      const g = rolle(id);
      return g ? indeks.get(g)! % 5 : 5;
    },
    fork: (id: string) => {
      const a = person.get(id);
      return a?.forkortelse || (a ? (a.fornavn.charAt(0) + a.etternavn.charAt(0)).toUpperCase() : "?");
    },
    navn: (id: string) => {
      const a = person.get(id);
      return a ? `${a.fornavn} ${a.etternavn}` : "Ukjent";
    },
  };
}

const minutter = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
// Når vakten slutter, i minutter fra midnatt (over midnatt: etter 24).
const sluttMin = (fra: string, til: string) => minutter(til) + (minutter(til) <= minutter(fra) ? 1440 : 0);
// «8–15:30»
const kortKl = (s: string) => (s.endsWith(":00") ? String(Number(s.slice(0, 2))) : `${Number(s.slice(0, 2))}:${s.slice(3)}`);

// En vakt eller fast arbeidsdag i dagsvisningen (en hel dag uten klokkeslett: fra kl. 08).
type Linje = { ansatt_id: string | null; vakt?: Vakt; fast?: Fast; fra: string; til: string; hel: boolean; borte: FravaerType | null; mangler: boolean };

// Dagen: de som er på jobb, rolle for rolle (de valgte rollene), på en tidslinje. Trykk på en vakt
// for å endre den, på en fast dag for å lage en vakt med andre tider (eller sette inn vikar), og i en
// tom del av linja for å legge inn en ny vakt for personen.
function DagVisning({
  dato,
  data,
  ansatte,
  grupper,
  kanPlanlegge,
  apneVakt,
  apneFast,
  nyVakt,
  tilTavle,
  vises,
}: {
  dato: string;
  data: VaktSvar;
  ansatte: Ansatt[];
  grupper: Rolle[];
  kanPlanlegge: boolean;
  apneVakt: (v: Vakt) => void;
  apneFast: (f: Fast) => void;
  nyVakt: (dato: string, ansatt: string | null) => void;
  tilTavle: (dato: string) => void;
  // Personene med de valgte rollene (rollevalget; ledige vakter vises alltid).
  vises: (ansatt: string | null) => boolean;
}) {
  const r = rolleoppsett(grupper, ansatte);
  const alle: Linje[] = [
    ...data.vakter
      .filter((v) => v.dato === dato)
      .map((v) => ({ ansatt_id: v.ansatt_id, vakt: v, fra: v.fra, til: v.til, hel: false, borte: v.fravaer, mangler: !!v.fravaer && !v.har_vikar })),
    ...(data.faste ?? [])
      .filter((f) => f.dato === dato)
      .map((f) => ({ ansatt_id: f.ansatt_id, fast: f, ...fastTider(f), hel: !f.fra, borte: f.fravaer, mangler: !!f.fravaer })),
  ];
  const linjer = alle.filter((l) => vises(l.ansatt_id));
  // Tidsaksen: fra den første starten til den siste slutten (hele timer), minst seks timer.
  const fraT = linjer.length ? Math.floor(Math.min(...linjer.map((l) => minutter(l.fra))) / 60) : 7;
  const tilT = Math.min(30, Math.max(linjer.length ? Math.ceil(Math.max(...linjer.map((l) => sluttMin(l.fra, l.til))) / 60) : 17, fraT + 6));
  const spenn = (tilT - fraT) * 60;
  const plass = (fra: number, til: number) => {
    const a = Math.max(0, fra - fraT * 60);
    const b = Math.min(spenn, til - fraT * 60);
    return { left: `${(a / spenn) * 100}%`, width: `${Math.max(1.5, ((b - a) / spenn) * 100)}%` };
  };
  const naa = dato === iDag() ? (() => {
    const [t, m] = klokka.format(new Date()).split(":").map(Number);
    const x = t! * 60 + m! - fraT * 60;
    return x >= 0 && x <= spenn ? `${(x / spenn) * 100}%` : null;
  })() : null;

  // Personene med vakt eller fast dag, rolle for rolle; ledige vakter for seg.
  const per = new Map<string, Linje[]>();
  for (const l of linjer) if (l.ansatt_id) per.set(l.ansatt_id, [...(per.get(l.ansatt_id) ?? []), l]);
  const forst = (id: string) => Math.min(...per.get(id)!.map((l) => minutter(l.fra)));
  const ledige = linjer.filter((l) => !l.ansatt_id);
  const paJobb = [...per.keys()].filter((id) => per.get(id)!.some((l) => !l.borte));
  const borteUten = data.fravaer.filter((f) => f.fra <= dato && f.til >= dato && !per.has(f.ansatt_id) && vises(f.ansatt_id));
  const mangler = linjer.filter((l) => l.mangler).length;

  const rad = (id: string | null, liste: Linje[]) => {
    const tider = liste
      .filter((l) => !l.hel)
      .map((l) => `${l.fra}–${l.til}`)
      .join(", ");
    const borte = liste.find((l) => l.borte)?.borte ?? null;
    const oppgaver = [...new Set(liste.map((l) => l.vakt?.oppgave).filter(Boolean))].join(", ");
    return (
      <div key={id ?? `ledig-${liste[0]!.vakt?.id}`} className={`dl-rad g${r.farge(id)}`}>
        <div className="dl-person">
          {id ? <span className="fork-merke">{r.fork(id)}</span> : <span className="fork-merke ledig">–</span>}
          <span className="dl-navn">{id ? r.navn(id) : "Ledig vakt"}</span>
          <span className="dl-tid">
            {[borte ? `${fravaerTekst[borte]}${liste.some((l) => l.mangler) ? " · mangler vikar" : " · vikar inne"}` : "", tider, oppgaver].filter(Boolean).join(" · ")}
          </span>
        </div>
        <div className={`dl-spor${kanPlanlegge ? " klikkbar" : ""}`} onClick={() => kanPlanlegge && nyVakt(dato, id)}>
          {naa && <span className="dl-naa" style={{ left: naa }} />}
          {liste.map((l, i) => {
            const v = l.vakt;
            const klasse = ["dl-bar", v ? "" : "fast", l.borte ? "borte" : "", l.mangler ? "mangler" : "", v && !v.publisert ? "utkast" : "", v?.advarsler.length ? "advarsel" : "", v?.vikar_for ? "vikar" : ""]
              .filter(Boolean)
              .join(" ");
            const tittel = [
              id ? r.navn(id) : "Ledig vakt",
              l.hel ? "Fast arbeidsdag" : `${l.fra}–${l.til}${v ? "" : " (fast arbeidsdag)"}`,
              v?.oppgave ?? "",
              l.borte ? `${fravaerTekst[l.borte]}: ${l.mangler ? "mangler vikar" : "vikar er satt inn"}` : "",
              v && !v.publisert ? "Ikke publisert" : "",
              v?.vikar_for_navn ? `Vikar for ${v.vikar_for_navn}` : "",
              ...(v?.advarsler ?? []),
            ]
              .filter(Boolean)
              .join("\n");
            return (
              <button
                key={i}
                type="button"
                className={klasse}
                style={plass(minutter(l.fra), sluttMin(l.fra, l.til))}
                title={tittel}
                disabled={!v && !kanPlanlegge}
                onClick={(e) => {
                  e.stopPropagation();
                  if (v) apneVakt(v);
                  else if (l.fast) apneFast(l.fast);
                }}
              >
                {v?.advarsler.length ? <IkonVarsel storrelse={12} /> : null}
                <span>{l.borte ? fravaerTekst[l.borte] : l.hel ? "" : `${kortKl(l.fra)}–${kortKl(l.til)}${v?.oppgave ? ` ${v.oppgave}` : ""}`}</span>
              </button>
            );
          })}
        </div>
      </div>
    );
  };

  const timene = Array.from({ length: tilT - fraT + 1 }, (_, i) => fraT + i);
  return (
    <div className="kort dagsvisning" style={{ "--timer": tilT - fraT } as CSSProperties}>
      <div className="dl-oppsummering">
        <strong>{paJobb.length} på jobb</strong>
        {borteUten.length + linjer.filter((l) => l.borte && l.ansatt_id).length > 0 && <span>{new Set([...borteUten.map((f) => f.ansatt_id), ...linjer.filter((l) => l.borte).map((l) => l.ansatt_id)]).size} borte</span>}
        {mangler > 0 && <span className="merke merke-fare">{mangler} mangler vikar</span>}
        {ledige.length > 0 && <span>{ledige.length === 1 ? "Én ledig vakt" : `${ledige.length} ledige vakter`}</span>}
        {helligdag(dato) && <span className="helligdag-navn">{helligdag(dato)}</span>}
        <button type="button" className="lenke dl-tavle" onClick={() => tilTavle(dato)}>
          Tavla for dagen
        </button>
      </div>
      <div className="dl-akse" aria-hidden="true">
        <span className="dl-person" />
        <div className="dl-spor">
          {timene.map((t, i) => (
            <span key={t} style={{ left: `${(i / (tilT - fraT)) * 100}%` }}>
              {String(t % 24).padStart(2, "0")}
            </span>
          ))}
        </div>
      </div>
      {ledige.length > 0 && (
        <section className="dl-gruppe">
          <h3>Ledige vakter</h3>
          {ledige.map((l) => rad(null, [l]))}
        </section>
      )}
      {r.seksjoner.map((s) => {
        const folk = [...per.keys()].filter((id) => r.rolle(id) === s.id).sort((a, b) => forst(a) - forst(b) || r.navn(a).localeCompare(r.navn(b), "nb"));
        if (!folk.length) return null;
        return (
          <section key={s.id ?? "uten"} className={`dl-gruppe g${s.farge}`}>
            <h3>
              {s.navn} <span className="dempet">{folk.filter((id) => per.get(id)!.some((l) => !l.borte)).length}</span>
            </h3>
            {folk.map((id) => rad(id, per.get(id)!.sort((a, b) => minutter(a.fra) - minutter(b.fra))))}
          </section>
        );
      })}
      {!linjer.length && (
        <p className="dempet dl-tom">
          {alle.length
            ? "Ingen med de valgte rollene denne dagen."
            : `Ingen vakter eller faste arbeidsdager denne dagen.${kanPlanlegge ? " Trykk «Ny vakt» for å legge inn en." : ""}`}
        </p>
      )}
      {borteUten.length > 0 && (
        <p className="dl-borte">
          <strong>Borte:</strong> {borteUten.map((f) => `${r.navn(f.ansatt_id)} (${fravaerTekst[f.type].toLowerCase()})`).join(", ")}
        </p>
      )}
    </div>
  );
}

const kopiMelding = (r: { kopiert: number; hoppet_over: number }, hvor: string) =>
  `${r.kopiert ? `Kopierte ${r.kopiert} ${r.kopiert === 1 ? "vakt" : "vakter"} til ${hvor}, som utkast.` : "Ingen nye vakter å kopiere."}` +
  (r.hoppet_over ? ` ${r.hoppet_over} ble hoppet over (finnes fra før, eller den ansatte er ikke ansatt da).` : "");

function KopierSkjema({ uke, ferdig, avbryt }: { uke: string; ferdig: (tekst: string) => void; avbryt: () => void }) {
  const { org } = useKonto();
  const [antall, settAntall] = useState("1");
  const h = useHandling();
  const n = Math.min(12, Math.max(1, Math.round(tall(antall)) || 1));
  const forste = leggTilDager(uke, 7);
  async function kopier(e: FormEvent) {
    e.preventDefault();
    const r = await h.kjor(() => api<{ kopiert: number; hoppet_over: number }>("POST", `/org/${org!.id}/vakter/kopier`, { fra: uke, til: forste, antall: n }));
    if (r) ferdig(kopiMelding(r, n === 1 ? `uke ${ukenr(forste).uke}` : `uke ${ukenr(forste).uke}–${ukenr(leggTilDager(forste, 7 * (n - 1))).uke}`));
  }
  return (
    <form onSubmit={kopier}>
      <p className="dempet" style={{ marginTop: 0 }}>
        Vaktene i uke {ukenr(uke).uke} kopieres til uka etter, som utkast. Vakter som finnes fra før, og ansatte som ikke er ansatt da, hoppes over.
      </p>
      <label>
        Antall uker framover
        <input inputMode="numeric" value={antall} onChange={(e) => settAntall(e.target.value)} />
        <span className="felt-hjelp">
          {n === 1 ? `Til uke ${ukenr(forste).uke} (${ukePeriode(forste)}).` : `Til uke ${ukenr(forste).uke}–${ukenr(leggTilDager(forste, 7 * (n - 1))).uke}.`} Høyst 12.
        </span>
      </label>
      <Feil melding={h.feil} />
      <div className="knapper">
        <button className="primar" disabled={h.opptatt}>
          Kopier
        </button>
        <button type="button" onClick={avbryt}>
          Avbryt
        </button>
      </div>
    </form>
  );
}

function VaktSkjema({
  vakt,
  ansatte,
  oppgaver,
  kanEndre,
  ferdig,
  avbryt,
  settInnVikar,
  registrerFravaer,
  endrePlan,
}: {
  vakt: Partial<Vakt> & { fraPlan?: boolean };
  ansatte: Ansatt[];
  oppgaver: string[];
  kanEndre: boolean;
  ferdig: (melding?: string) => void;
  avbryt: () => void;
  settInnVikar: (v: Vakt) => void;
  // Fravær og faste dager for den ansatte på vakten (samme som i ansattkortet).
  registrerFravaer?: (ansattId: string, dato: string) => void;
  endrePlan?: (ansattId: string) => void;
}) {
  const { org } = useKonto();
  const [v, settV] = useState(() => {
    const sist = vakt.id ? null : lesSist();
    return {
      ansatt_id: vakt.ansatt_id ?? "",
      dato: vakt.dato ?? iDag(),
      fra: vakt.fra ?? sist?.fra ?? "",
      til: vakt.til ?? sist?.til ?? "",
      pause: String(vakt.pause_min ?? sist?.pause_min ?? 0),
      oppgave: vakt.oppgave ?? sist?.oppgave ?? "",
      notat: vakt.notat ?? "",
    };
  });
  const h = useHandling();
  const sett = (e: Partial<typeof v>) => settV({ ...v, ...e });
  const pause = v.pause.trim() === "" ? 0 : tall(v.pause);
  const klokke = (s: string) => /^\d{2}:\d{2}$/.test(s);
  const utregnet = klokke(v.fra) && klokke(v.til) && v.fra !== v.til && Number.isFinite(pause) ? regnTimer(v.fra, v.til, pause) : null;
  // Ansatte som kan settes på vakten: aktive og ansatt den dagen (og den som har den nå).
  const valg = ansatte.filter((a) => a.id === vakt.ansatt_id || (a.aktiv && a.ansatt_fra <= v.dato && (!a.ansatt_til || a.ansatt_til >= v.dato)));

  async function lagre(e: FormEvent) {
    e.preventDefault();
    const kropp = {
      ansatt_id: v.ansatt_id || null,
      dato: v.dato,
      fra: v.fra,
      til: v.til,
      pause_min: Math.round(pause),
      oppgave: v.oppgave.trim() || null,
      notat: v.notat.trim() || null,
    };
    const r = await h.kjor(() => (vakt.id ? api("PATCH", `/org/${org!.id}/vakter/${vakt.id}`, kropp) : api("POST", `/org/${org!.id}/vakter`, kropp)));
    if (!r) return;
    huskSist({ fra: v.fra, til: v.til, pause_min: Math.round(pause), oppgave: v.oppgave.trim() });
    ferdig(vakt.publisert && vakt.ansatt_id ? "Vakten er endret, og den ansatte har fått beskjed." : undefined);
  }

  async function slett() {
    if (!confirm(`Slette vakten ${visDag(vakt.dato!)} ${tid(vakt as Vakt)}?${vakt.publisert && vakt.ansatt_id ? " Den ansatte får beskjed." : ""}`)) return;
    const r = await h.kjor(async () => (await api("DELETE", `/org/${org!.id}/vakter/${vakt.id}`), true));
    if (r) ferdig("Vakten er slettet.");
  }

  return (
    <form onSubmit={lagre}>
      {vakt.fraPlan && (
        <p className="liten vakt-status">
          Fast arbeidsdag etter arbeidsplanen. Lagrer du en vakt, gjelder den i stedet denne dagen (som utkast til uka publiseres). Timer utover planen blir
          ekstratimer.
        </p>
      )}
      {vakt.id && (
        <p className={`liten vakt-status${vakt.publisert ? "" : " utkast"}`}>
          {vakt.publisert ? (kanEndre ? "Publisert. Endringer varsles til den ansatte." : "Publisert.") : "Ikke publisert ennå. Den ansatte ser vakten når uka publiseres."}
          {vakt.fort ? " Timene er ført fra vakten." : ""}
          {vakt.vikar_for_navn ? ` Vikar for ${vakt.vikar_for_navn}.` : ""}
        </p>
      )}
      {vakt.id && vakt.fravaer && (
        <div className={`melding ${vakt.har_vikar ? "info" : "feil"} vikar-info`}>
          <span>
            {vakt.ansatt_navn} {borteTekst[vakt.fravaer]} denne dagen. {vakt.har_vikar ? "Vikar er satt inn." : "Vakten mangler vikar."}
          </span>
          {!vakt.har_vikar && kanEndre && (
            <button type="button" className="primar" onClick={() => settInnVikar(vakt as Vakt)}>
              Sett inn vikar
            </button>
          )}
        </div>
      )}
      {(vakt.advarsler ?? []).length > 0 && (
        <div className="melding advarsel">
          {(vakt.advarsler ?? []).map((t) => (
            <div key={t}>{t}</div>
          ))}
        </div>
      )}
      <fieldset className="naken" disabled={!kanEndre}>
        <label>
          Ansatt
          <select value={v.ansatt_id} onChange={(e) => sett({ ansatt_id: e.target.value })}>
            <option value="">Ledig vakt (alle ansatte kan ta den)</option>
            {valg.map((a) => (
              <option key={a.id} value={a.id}>
                {a.fornavn} {a.etternavn}
              </option>
            ))}
          </select>
        </label>
        <label>
          Dato
          <input type="date" required value={v.dato} onChange={(e) => sett({ dato: e.target.value })} />
        </label>
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
          {v.fra && v.fra === v.til
            ? "Fra og til kan ikke være like."
            : utregnet === null
              ? " "
              : utregnet > 0
                ? `= ${timer(utregnet)}${v.til < v.fra ? " (over midnatt)" : ""}`
                : "Pausen er like lang som vakten."}
        </p>
        <label>
          Oppgave eller avdeling
          <input list="vakt-oppgaver" maxLength={60} placeholder="F.eks. Kasse eller Lager (valgfritt)" value={v.oppgave} onChange={(e) => sett({ oppgave: e.target.value })} />
          <datalist id="vakt-oppgaver">
            {oppgaver.map((o) => (
              <option key={o} value={o} />
            ))}
          </datalist>
        </label>
        <label>
          Notat til den ansatte
          <textarea rows={2} maxLength={500} value={v.notat} onChange={(e) => sett({ notat: e.target.value })} />
        </label>
      </fieldset>
      {kanEndre && v.ansatt_id && (registrerFravaer || endrePlan) && (
        <p className="vakt-lenker liten">
          {registrerFravaer && (
            <button type="button" className="lenke" onClick={() => registrerFravaer(v.ansatt_id, v.dato)}>
              {vakt.fravaer && v.ansatt_id === vakt.ansatt_id ? "Endre fraværet" : `Registrer fravær for ${ansatte.find((a) => a.id === v.ansatt_id)?.fornavn ?? "den ansatte"}`}
            </button>
          )}
          {endrePlan && (
            <button type="button" className="lenke" onClick={() => endrePlan(v.ansatt_id)}>
              Arbeidstid og faste dager
            </button>
          )}
        </p>
      )}
      <Feil melding={h.feil} />
      <div className="knapper">
        {kanEndre && (
          <button className="primar" disabled={h.opptatt}>
            Lagre
          </button>
        )}
        <button type="button" onClick={avbryt}>
          {kanEndre ? "Avbryt" : "Lukk"}
        </button>
        {vakt.id && kanEndre && (
          <button type="button" className="fare" style={{ marginLeft: "auto" }} disabled={h.opptatt} onClick={slett}>
            Slett
          </button>
        )}
      </div>
    </form>
  );
}

// --- For den ansatte --------------------------------------------------------------------

function MineVakter({
  svar,
  feil,
  egen,
  plasser,
  ledige,
  tilLedige,
  bytter,
  innstilling,
  tilBytter,
  endret,
}: {
  svar?: VaktSvar;
  feil: string | null;
  egen: string;
  plasser: MinPlass[];
  ledige: number;
  tilLedige: () => void;
  bytter?: Bytte[];
  innstilling: Innstilling;
  tilBytter: () => void;
  endret: () => void;
}) {
  // Vakten (eller den faste arbeidsdagen) som gis bort eller byttes (Vaktbytte.tsx).
  const [bytt, settBytt] = useState<ByttVakt | null>(null);
  const [melding, settMelding] = useState<string | null>(null);
  if (feil) return <Feil melding={feil} />;
  if (!svar) return <Laster />;
  const mine = svar.vakter.filter((v) => v.ansatt_id === egen && v.publisert);
  // Vaktene og de faste arbeidsdagene (etter arbeidsplanen), uke for uke.
  const faste = (svar.faste ?? []).filter((f) => f.ansatt_id === egen);
  const uker = new Map<string, (Vakt | Fast)[]>();
  for (const v of [...mine, ...faste].sort((x, y) => x.dato.localeCompare(y.dato) || (x.fra ?? "").localeCompare(y.fra ?? "")))
    uker.set(mandag(v.dato), [...(uker.get(mandag(v.dato)) ?? []), v]);
  const erVakt = (v: Vakt | Fast): v is Vakt => "id" in v;
  // Plassene på tavla som hører til vakten (fasene vakten overlapper).
  const plassTekst = (v: Pick<Vakt, "dato"> & { fra: string | null; til: string | null }) =>
    plasser
      .filter((p) => p.dato === v.dato && iFasen(v, { id: "", navn: p.fase, fra: p.fra, til: p.til }))
      .map((p) => `${p.fase}: ${p.oppgave}`)
      .join(" · ");
  // Kan byttes: vaktbytte er på, den ansatte er ikke borte, og vakten har ikke begynt (og har ikke
  // vikar eller førte timer).
  const kanBytte = (v: Vakt | Fast) => innstilling !== "av" && !v.fravaer && !begynt(v.dato, v.fra) && (!erVakt(v) || (!v.fort && !v.har_vikar));
  // Et åpent tilbud på vakten: kort tekst, og trykk for å se det under Bytter.
  const tilbudTekst = (b: Bytte) =>
    b.status === "akseptert"
      ? "Venter på godkjenning"
      : b.mot_vakt_id
        ? `Bytte foreslått for ${fornavn(b.til_navn ?? "")}`
        : b.til_ansatt
          ? `Tilbudt ${fornavn(b.til_navn ?? "")}`
          : "Tilbudt kollegaene";
  const byttKnapp = (v: Vakt | Fast) => {
    const tilbud = erVakt(v) ? aapentPaa(bytter, v.id) : undefined;
    if (tilbud)
      return (
        <button type="button" className="lenke" onClick={tilBytter}>
          {tilbudTekst(tilbud)}
        </button>
      );
    if (!kanBytte(v)) return null;
    return (
      <button type="button" className="lenke" onClick={() => settBytt({ id: erVakt(v) ? v.id : null, dato: v.dato, fra: v.fra, til: v.til, timer: Number(v.timer) })}>
        Bytt
      </button>
    );
  };
  return (
    <>
      {melding && (
        <div className="melding ok" role="status">
          {melding}
        </div>
      )}
      <MittFravaer fravaer={svar.fravaer.filter((f) => f.ansatt_id === egen)} endret={endret} />
      {ledige > 0 && (
        <div className="melding info venter">
          <span>{ledige === 1 ? "Én ledig vakt" : `${ledige} ledige vakter`} de neste ukene.</span>
          <button type="button" className="lenke" onClick={tilLedige}>
            Se {ledige === 1 ? "den" : "dem"}
          </button>
        </div>
      )}
      {!mine.length && !faste.length ? (
        <div className="kort">
          <Tom ikon={<IkonKalender storrelse={22} />} tittel="Ingen vakter de neste ukene">
            <p>Du får varsel når vaktplanen er publisert.</p>
          </Tom>
        </div>
      ) : (
        [...uker.entries()].map(([m, vakter]) => (
          <div key={m} className="kort liste mine-vakter">
            <div className="mine-vakter-topp">
              <strong>Uke {ukenr(m).uke}</strong>
              <span className="dempet">{ukePeriode(m)}</span>
              <span className="tall">{timer(vakter.filter((v) => !v.fravaer).reduce((s, v) => s + Number(v.timer), 0))}</span>
            </div>
            {vakter.map((v) => {
              const plass = v.fravaer ? "" : plassTekst(v);
              if (!erVakt(v))
                return (
                  <div key={`fast-${v.dato}`} className={`liste-rad statisk${v.dato === iDag() ? " i-dag" : ""}${v.fravaer ? " borte" : ""}`}>
                    <span className="linje">
                      <span className="tittel">
                        {visDag(v.dato)}
                        {fastTid(v) && (
                          <>
                            {" "}
                            · <span className="vakt-tid-tekst">{fastTid(v)}</span>
                          </>
                        )}
                      </span>
                      {v.fravaer ? <span className={`merke ${fravaerKlasse[v.fravaer]}`}>{fravaerTekst[v.fravaer]}</span> : <span className="belop">{timer(v.timer)}</span>}
                    </span>
                    {plass && <span className="under plass">{plass}</span>}
                    {!v.fravaer && (
                      <span className="linje">
                        <span className="under">Fast arbeidsdag</span>
                        {byttKnapp(v) ??
                          (v.dato <= iDag() && (
                            <Link className="liten" to={`/timer?uke=${mandag(v.dato)}`}>
                              Før timer
                            </Link>
                          ))}
                      </span>
                    )}
                  </div>
                );
              return (
                <div key={v.id} className={`liste-rad statisk${v.dato === iDag() ? " i-dag" : ""}${v.fravaer ? " borte" : ""}`}>
                  <span className="linje">
                    <span className="tittel">
                      {visDag(v.dato)} · <span className="vakt-tid-tekst">{tid(v)}</span>
                      {helligdag(v.dato) && <span className="helligdag-navn">{helligdag(v.dato)}</span>}
                    </span>
                    {v.fravaer ? <span className={`merke ${fravaerKlasse[v.fravaer]}`}>{fravaerTekst[v.fravaer]}</span> : <span className="belop">{timer(v.timer)}</span>}
                  </span>
                  {plass && <span className="under plass">{plass}</span>}
                  {(v.oppgave || v.notat || v.fort || byttKnapp(v)) && !v.fravaer && (
                    <span className="linje">
                      <span className="under">{[v.oppgave, v.notat].filter(Boolean).join(" · ")}</span>
                      {v.fort ? (
                        <span className="merke merke-ok">Ført</span>
                      ) : (
                        (byttKnapp(v) ??
                        (v.dato <= iDag() && (
                          <Link className="liten" to={`/timer?uke=${mandag(v.dato)}`}>
                            Før timer
                          </Link>
                        )))
                      )}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        ))
      )}
      <ByttDialog
        vakt={bytt}
        innstilling={innstilling}
        lukk={() => settBytt(null)}
        ferdig={(m) => {
          settBytt(null);
          settMelding(m);
          endret();
        }}
      />
    </>
  );
}

// Ledige vakter, og vakter kolleger med samme rolle gir bort (Vaktbytte.tsx).
function LedigeVakter({
  vakter,
  tilbud,
  innstilling,
  feil,
  endret,
}: {
  vakter?: Vakt[];
  tilbud: Bytte[];
  innstilling: Innstilling;
  feil: string | null;
  endret: () => void;
}) {
  const { org } = useKonto();
  const h = useHandling();
  const [melding, settMelding] = useState<string | null>(null);
  if (feil) return <Feil melding={feil} />;
  if (!vakter) return <Laster />;
  const ta = (v: Vakt) =>
    h.kjor(async () => {
      if (!confirm(`Ta vakten ${visDag(v.dato)} ${tid(v)}?`)) return;
      await api("POST", `/org/${org!.id}/vakter/${v.id}/ta`);
      settMelding(`Vakten ${visDag(v.dato)} ${tid(v)} er din.`);
      endret();
    });
  const taFra = (b: Bytte) =>
    h.kjor(async () => {
      if (!confirm(`Ta vakten ${visDag(b.dato)} ${tid(b)} fra ${b.fra_navn}?`)) return;
      await api("POST", `/org/${org!.id}/vaktbytter/${b.id}/svar`, { ja: true });
      settMelding(
        innstilling === "godkjenning"
          ? `Du har tatt vakten ${visDag(b.dato)} ${tid(b)}. Den blir din når lederen har godkjent byttet.`
          : `Vakten ${visDag(b.dato)} ${tid(b)} er din.`,
      );
      endret();
    });
  // Ledige vakter og tilbudene fra kolleger, etter dato.
  const rader = [...vakter.map((v) => ({ dato: v.dato, fra: v.fra, v })), ...tilbud.map((b) => ({ dato: b.dato, fra: b.fra, b }))].sort(
    (x, y) => x.dato.localeCompare(y.dato) || x.fra.localeCompare(y.fra),
  );
  return (
    <>
      {melding && (
        <div className="melding ok" role="status">
          {melding}
        </div>
      )}
      <Feil melding={h.feil} />
      {!rader.length ? (
        <div className="kort">
          <Tom ikon={<IkonKalender storrelse={22} />} tittel="Ingen ledige vakter nå">
            <p>Du får varsel når det kommer ledige vakter, eller en kollega gir bort en vakt.</p>
          </Tom>
        </div>
      ) : (
        <div className="kort liste">
          {rader.map((r) =>
            "v" in r ? (
              <div key={r.v.id} className="liste-rad statisk ledig-vakt">
                <span className="linje">
                  <span className="tittel">
                    {visDag(r.v.dato)} · {tid(r.v)}
                  </span>
                  <button type="button" className="primar" disabled={h.opptatt} onClick={() => ta(r.v)}>
                    Ta vakten
                  </button>
                </span>
                <span className="under">{[timer(r.v.timer), r.v.oppgave, r.v.notat].filter(Boolean).join(" · ")}</span>
              </div>
            ) : (
              <div key={r.b.id} className="liste-rad statisk ledig-vakt">
                <span className="linje">
                  <span className="tittel">
                    {visDag(r.b.dato)} · {tid(r.b)}
                  </span>
                  <button type="button" className="primar" disabled={h.opptatt || !!r.b.hindring} onClick={() => taFra(r.b)}>
                    Ta vakten
                  </button>
                </span>
                <span className="under">{[`Fra ${r.b.fra_navn}`, timer(r.b.timer), r.b.oppgave, r.b.melding && `«${r.b.melding}»`].filter(Boolean).join(" · ")}</span>
                {r.b.hindring && <span className="under hindring">{r.b.hindring}</span>}
              </div>
            ),
          )}
        </div>
      )}
      <p className="liten dempet">
        Den første som tar en ledig vakt, får den. Du kan ikke ta en vakt som overlapper en av dine egne.
        {tilbud.length > 0 && innstilling === "godkjenning" ? " En vakt fra en kollega blir din når lederen har godkjent byttet." : ""}
      </p>
    </>
  );
}
