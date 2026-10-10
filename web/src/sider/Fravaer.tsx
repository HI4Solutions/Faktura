// Fravær og vikarer: registrere fravær (eier og administrator), melde seg syk (den ansatte),
// listen over fravær, og vikar for en vakt når den som har den, er borte. Fravær er
// helseopplysninger og vises bare for eier, administrator, regnskap og den ansatte selv; hva
// slags fravær det er, ser bare eier, administrator og den ansatte selv (andre ser «F»). Fraværet
// registreres ett sted og vises i vaktplanen, på tavla, i bemanningskalenderen, i timelista og
// i ansattkortet, og kan registreres og endres fra alle (FravaerDialog).
//
// Egenmelding (0071_egenmelding.sql): den ansatte sender egenmelding når sykdommen meldes, eller
// etterpå (for sykdom de siste 16 dagene), med erklæringen; reglene står i skjemaet, og databasen
// sjekker dem. Lederen ser dokumentasjonen og registrerer sykmelding (legeerklæring for sykt barn).
//
// Avspasering (0073_timebank.sql): fri fra timebanken i hele dager, med timene den tar fra banken
// (foreslått av de planlagte timene). Lederen registrerer den her; den ansatte søker under Timer →
// Timebank.
//
// Permisjon og permittering (0084_permisjon_permittering.sql): arten (som i a-meldingen), prosenten
// av stillingen (delvis permisjon gjør ikke den ansatte borte i planen), om sluttdatoen er ukjent,
// og for permitteringen datoen varselet ble gitt og lønnsplikten (standard de 15 første
// arbeidsdagene). Permitteringen har sin egen knapp; varselet lastes ned som PDF.
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { api, hent, lastNed } from "../api";
import { Dialog, Feil, Laster, Tom, useData, useHandling } from "../felles";
import { kanPersonal, useKonto } from "../konto";
import { iDag, leggTilDager } from "../format";
import { helligdag } from "../helligdager";
import { IkonKalender } from "../ikoner";
import { visDag } from "../uke";

// «fravaer»: typen er skjult. Bare eier, administrator og den ansatte selv ser hva slags fravær det
// er (0047_fravaer_skjult.sql); andre ser bare at den ansatte er borte (F).
export type FravaerType = "syk" | "sykt_barn" | "ferie" | "permisjon" | "kurs" | "avspasering" | "annet" | "fravaer";
export type Dokumentasjon = "egenmelding" | "sykmelding";
export type Fravaer = {
  id: string;
  ansatt_id: string;
  ansatt_navn: string;
  type: FravaerType;
  fra: string;
  til: string;
  notat?: string | null;
  // Sykdom: egenmelding eller sykmelding (legeerklæring for sykt barn), og egenmeldingen.
  dokumentasjon?: Dokumentasjon | null;
  arbeidsrelatert?: boolean | null;
  egenmeldt?: string | null;
  egenmeldt_selv?: boolean | null;
  timer?: number | null; // avspasering: timene den tar fra timebanken; permisjon med lønn: timene som lønnes
  betalt?: boolean | null; // permisjon med lønn (0074_vaktbytte_fridag.sql)
  sykmeldingsgrad?: number | null; // gradert sykmelding (1–99 %; null er 100 %) (0079_nav_sykepenger.sql)
  fra_nav?: boolean | null; // registrert fra en sykmelding hos NAV
  // Permisjon (0084): arten, prosenten av stillingen (1–99 %; null er 100 %), om sluttdatoen er
  // ukjent, og for permitteringen varselet og den siste dagen med lønnsplikt. delvis: under 100 %
  // (den ansatte er ikke borte; alle ser det).
  permisjon_art?: PermisjonsArt | null;
  prosent?: number | null;
  slutt_ukjent?: boolean | null;
  varslet?: string | null;
  lonnsplikt_til?: string | null;
  delvis?: boolean;
};
export type PermisjonsArt = "annen" | "lovfestet" | "foreldre" | "utdanning_lovfestet" | "utdanning" | "militaer" | "permittering";
// Artene som i a-meldingen (server/src/permisjoner.ts): navnet på fraværet og teksten i valget.
export const PERMISJONSARTER: Record<PermisjonsArt, { navn: string; valg: string }> = {
  annen: { navn: "Permisjon", valg: "Annen permisjon (ikke lovfestet, f.eks. velferdspermisjon)" },
  foreldre: { navn: "Foreldrepermisjon", valg: "Foreldrepermisjon (med foreldrepenger)" },
  lovfestet: { navn: "Lovfestet permisjon", valg: "Annen lovfestet permisjon (omsorgspermisjon, pleiepenger, utvidet foreldrepermisjon)" },
  utdanning_lovfestet: { navn: "Utdanningspermisjon", valg: "Utdanningspermisjon (lovfestet)" },
  utdanning: { navn: "Utdanningspermisjon", valg: "Utdanningspermisjon (ikke lovfestet)" },
  militaer: { navn: "Militærtjeneste", valg: "Militærtjeneste, sivilforsvar eller heimevern" },
  permittering: { navn: "Permittering", valg: "Permittering" },
};
// Lønnsplikten ved permittering: de 15 første arbeidsdagene; den siste dagen. Arbeidsdagene er
// ukedagene i den faste arbeidsplanen (ellers mandag–fredag), ikke helligdager. Ved delvis
// permittering legges de permitterte timene sammen til 15 hele dager (30 arbeidsdager ved 50 %).
// Som lonnspliktSlutt i server/src/permisjoner.ts.
export const lonnspliktDager = (prosent?: number | null) => Math.ceil((15 * 100) / Math.min(100, Math.max(1, prosent || 100)) - 1e-9);
export function lonnspliktSlutt(fra: string, dager = 15, ukedager?: number[] | null): string {
  let n = 0;
  let d = fra;
  for (let i = 0; i < 3000; i++, d = leggTilDager(d, 1)) {
    const u = new Date(`${d}T12:00:00Z`).getUTCDay();
    const arbeidsdag = ukedager?.length ? ukedager.includes(((u + 6) % 7) + 1) : u !== 0 && u !== 6;
    if (arbeidsdag && !helligdag(d) && ++n === dager) return d;
  }
  return d;
}
// Egenmeldingene til en ansatt (GET /egenmelding): reglene, retten etter to måneder, det som er
// brukt i løpet av 12 måneder (egen sykdom) og dagene med sykt barn i år.
type EgenmeldingStatus = {
  ansatt_id: string;
  regler: { dager: number; ganger: number | null; dager_aar: number | null; barn_dager: number };
  ansatt_fra: string;
  opptjent_fra: string;
  brukt: { ganger: number; dager: number };
  tilfeller: { fra: string; til: string; dager: number }[];
  sykt_barn: { aar: number; dager: number };
};
export type Ansatt = {
  id: string;
  fornavn: string;
  etternavn: string;
  forkortelse?: string | null; // f.eks. «AB» (0061_forkortelser.sql)
  ansatt_fra: string;
  ansatt_til: string | null;
  aktiv: boolean;
  tavle?: boolean;
  arbeidsdager?: number[]; // ukedagene i den faste arbeidsplanen (1 = mandag)
};
type BerortVakt = { id: string; dato: string; fra: string; til: string; oppgave: string | null };

export const FRAVAERTYPER: FravaerType[] = ["ferie", "avspasering", "syk", "sykt_barn", "permisjon", "kurs", "annet"];
export const fravaerTekst: Record<FravaerType, string> = {
  syk: "Syk",
  sykt_barn: "Sykt barn",
  ferie: "Ferie",
  permisjon: "Permisjon",
  kurs: "Kurs",
  avspasering: "Avspasering",
  annet: "Annet fravær",
  fravaer: "Fravær",
};
// Forkortelsene i bemanningskalenderen. F er fravær uten type (det andre ser).
export const fravaerKode: Record<FravaerType, string> = { ferie: "Fe", syk: "S", sykt_barn: "SB", permisjon: "P", kurs: "K", avspasering: "Av", annet: "A", fravaer: "F" };
// Hver type har sin farge (styles.css: --fv-ferie osv.), samme i merker, vaktplan og kalender;
// fravær uten type er grått, så fargen ikke røper typen.
export const fravaerKlasse = Object.fromEntries([...FRAVAERTYPER, "fravaer"].map((t) => [t, `merke-fravaer fravaer-${t}`])) as Record<FravaerType, string>;
// «Ola Nordmann har ferie denne dagen.»
export const borteTekst: Record<FravaerType, string> = {
  syk: "er syk",
  sykt_barn: "har sykt barn",
  ferie: "har ferie",
  permisjon: "har permisjon",
  kurs: "er på kurs",
  avspasering: "avspaserer",
  annet: "er borte",
  fravaer: "har fravær",
};

// Permisjon: arten («Foreldrepermisjon», «Permittering», «Permisjon med lønn» …), ellers typen.
export const fravaerNavn = (f: Pick<Fravaer, "type" | "betalt" | "permisjon_art">) =>
  f.type !== "permisjon"
    ? fravaerTekst[f.type]
    : f.permisjon_art && f.permisjon_art !== "annen"
      ? PERMISJONSARTER[f.permisjon_art].navn
      : f.betalt
        ? "Permisjon med lønn"
        : "Permisjon";
// «Delvis 50 %» for delvis permisjon og permittering.
export const prosentTekst = (f: Pick<Fravaer, "type" | "prosent">) => (f.type === "permisjon" && f.prosent ? `Delvis ${f.prosent} %` : null);
export const fravaerPeriode = (f: Pick<Fravaer, "fra" | "til">) => (f.fra === f.til ? visDag(f.fra) : `${visDag(f.fra)} – ${visDag(f.til)}`);
const dager = (f: Pick<Fravaer, "fra" | "til">) => Math.round((Date.parse(`${f.til}T12:00:00Z`) - Date.parse(`${f.fra}T12:00:00Z`)) / 86_400_000) + 1;
const erSykdom = (t?: string) => t === "syk" || t === "sykt_barn";
// Valget i skjemaet: typene, og permittering (en permisjon med arten permittering).
type Valg = FravaerType | "permittering";
const dagerMellom = (fra: string, til: string) => Math.round((Date.parse(`${til}T12:00:00Z`) - Date.parse(`${fra}T12:00:00Z`)) / 86_400_000);
// «Egenmelding», «Sykmelding» eller «Legeerklæring» (sykt barn).
export const dokumentasjonTekst = (f: Pick<Fravaer, "type" | "dokumentasjon">) =>
  f.dokumentasjon === "egenmelding" ? "Egenmelding" : f.dokumentasjon === "sykmelding" ? (f.type === "sykt_barn" ? "Legeerklæring" : "Sykmelding") : null;
// «Gradert 50 %» for gradert sykmelding.
export const gradTekst = (f: Pick<Fravaer, "type" | "sykmeldingsgrad">) => (f.type === "syk" && f.sykmeldingsgrad ? `Gradert ${f.sykmeldingsgrad} %` : null);
const tidspunkt = (t: string) => new Date(t).toLocaleString("nb-NO", { timeZone: "Europe/Oslo", dateStyle: "short", timeStyle: "short" });
const flertall = (n: number, en: string, flere: string) => `${n} ${n === 1 ? en : flere}`;
export const iArbeid = (a: Ansatt, dato: string) => a.aktiv && a.ansatt_fra <= dato && (!a.ansatt_til || a.ansatt_til >= dato);
// Delvis permisjon (0084) er ikke borte: den ansatte jobber resten.
export const borte = (fravaer: Pick<Fravaer, "ansatt_id" | "fra" | "til" | "type" | "delvis">[], ansatt: string | null, dato: string) =>
  (ansatt && fravaer.find((f) => f.ansatt_id === ansatt && f.fra <= dato && f.til >= dato && !f.delvis)?.type) || null;

// Registrer eller endre fravær. Den ansatte selv (selv) kan bare melde sykdom og deretter
// endre sluttdatoen, og sende egenmelding (egenmelding: avkrysset fra start); eier og
// administrator velger ansatt og type, og dokumentasjonen for sykdom.
export function FravaerSkjema({
  fravaer,
  ansatte,
  selv,
  egenmelding,
  ferdig,
  avbryt,
}: {
  fravaer: Partial<Fravaer>;
  ansatte?: Ansatt[];
  selv?: boolean;
  egenmelding?: boolean;
  ferdig: (melding: string, berort?: BerortVakt[]) => void;
  avbryt: () => void;
}) {
  const { org } = useKonto();
  const [f, settF] = useState(() => ({
    ansatt_id: fravaer.ansatt_id ?? "",
    type: (fravaer.type === "permisjon" && fravaer.permisjon_art === "permittering" ? "permittering" : (fravaer.type ?? (selv ? "syk" : "ferie"))) as Valg,
    fra: fravaer.fra ?? iDag(),
    til: fravaer.til ?? fravaer.fra ?? iDag(),
    notat: fravaer.notat ?? "",
    dokumentasjon: (fravaer.dokumentasjon ?? "") as Dokumentasjon | "",
    timer: fravaer.timer != null ? String(fravaer.timer).replace(".", ",") : "",
    betalt: !!fravaer.betalt,
    gradert: !!fravaer.sykmeldingsgrad,
    grad: fravaer.sykmeldingsgrad ? String(fravaer.sykmeldingsgrad) : "",
    // Permisjon og permittering (0084).
    art: (fravaer.permisjon_art && fravaer.permisjon_art !== "permittering" ? fravaer.permisjon_art : "annen") as PermisjonsArt,
    delvis: !!fravaer.prosent,
    prosent: fravaer.prosent ? String(fravaer.prosent) : "",
    sluttUkjent: !!fravaer.slutt_ukjent,
    varslet: fravaer.varslet ?? iDag(),
    lonnsplikt: !fravaer.id || fravaer.permisjon_art !== "permittering" || !!fravaer.lonnsplikt_til,
    lonnspliktTil:
      fravaer.lonnsplikt_til ?? lonnspliktSlutt(fravaer.fra ?? iDag(), lonnspliktDager(fravaer.prosent), ansatte?.find((a) => a.id === fravaer.ansatt_id)?.arbeidsdager),
  }));
  // Ukedagene i den faste arbeidsplanen til den ansatte (lønnsplikten telles på dem).
  const planDager = (ansattId: string) => ansatte?.find((a) => a.id === ansattId)?.arbeidsdager;
  // Lønnsplikten foreslås av startdatoen, til den endres for hånd.
  const lonnspliktEndret = useRef(!!fravaer.lonnsplikt_til);
  // Avspasering og permisjon med lønn: timene foreslås av de planlagte timene, til de endres for hånd.
  const timerEndret = useRef(fravaer.timer != null);
  // Egenmeldingen den ansatte sender (med erklæringen) og svaret om arbeidet.
  const [egen, settEgen] = useState({ send: !!egenmelding && !fravaer.dokumentasjon, arbeidsrelatert: "nei" as "nei" | "ja" | "vet_ikke" });
  const h = useHandling();
  const sett = (e: Partial<typeof f>) => settF({ ...f, ...e });
  // Den foreslåtte lønnsplikten følger startdatoen og prosenten ved permittering, til den endres for hånd.
  const nyLonnsplikt = (fra: string, prosent: number | null) =>
    f.type === "permittering" && !lonnspliktEndret.current && /^\d{4}-\d{2}-\d{2}$/.test(fra)
      ? { lonnspliktTil: lonnspliktSlutt(fra, lonnspliktDager(prosent), planDager(f.ansatt_id)) }
      : {};
  // Avspasering bare når timebanken er på (eller fraværet alt er avspasering); permittering etter
  // permisjon.
  const typer: Valg[] = selv
    ? ["syk", "sykt_barn"]
    : FRAVAERTYPER.filter((t) => t !== "avspasering" || org?.timebank || fravaer.type === "avspasering").flatMap((t): Valg[] => (t === "permisjon" ? [t, "permittering"] : [t]));
  const avspasering = f.type === "avspasering";
  const permisjon = f.type === "permisjon" || f.type === "permittering";
  const permittering = f.type === "permittering";
  // Varselet skal normalt gis minst 14 dager før (2 dager ved uforutsette hendelser).
  const kortVarsel = permittering && !!f.varslet && /^\d{4}-\d{2}-\d{2}$/.test(f.fra) && f.varslet <= f.fra && dagerMellom(f.varslet, f.fra) < 14;
  const medLonn = f.type === "permisjon" && f.betalt;
  const medTimer = avspasering || medLonn;
  useEffect(() => {
    if (!medTimer || !f.ansatt_id || !/^\d{4}-\d{2}-\d{2}$/.test(f.fra) || !/^\d{4}-\d{2}-\d{2}$/.test(f.til) || f.til < f.fra || timerEndret.current) return;
    let aktiv = true;
    hent<{ timer: number }>(`/org/${org!.id}/timebank/forslag?ansatt=${f.ansatt_id}&fra=${f.fra}&til=${f.til}`).then(
      (r) => aktiv && !timerEndret.current && settF((x) => ({ ...x, timer: String(r.timer).replace(".", ",") })),
      () => undefined,
    );
    return () => {
      aktiv = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [medTimer, f.ansatt_id, f.fra, f.til]);
  // Den ansatte endrer bare sluttdatoen på sykdom som er meldt (og kan sende egenmelding for den).
  const bareSlutt = !!selv && !!fravaer.id;
  const valg = (ansatte ?? []).filter((a) => a.id === fravaer.ansatt_id || a.aktiv);
  const sendEgen = !!selv && egen.send && !fravaer.dokumentasjon;
  const arbeid = f.type === "syk" ? { arbeidsrelatert: egen.arbeidsrelatert === "ja" ? true : egen.arbeidsrelatert === "nei" ? false : null } : {};

  async function lagre(e: FormEvent) {
    e.preventDefault();
    const egenmeldingen = sendEgen ? { dokumentasjon: "egenmelding", erklaering: true, ...arbeid } : {};
    const kropp = bareSlutt
      ? { til: f.til, ...egenmeldingen }
      : {
          type: permittering ? "permisjon" : f.type,
          fra: f.fra,
          til: f.til,
          notat: f.notat.trim() || null,
          ...(selv ? egenmeldingen : { dokumentasjon: erSykdom(f.type) ? f.dokumentasjon || null : null }),
          ...(medTimer ? { timer: Number(f.timer.replace(",", ".")) } : {}),
          ...(f.type === "permisjon" ? { betalt: f.betalt } : {}),
          ...(!selv && f.type === "syk" ? { sykmeldingsgrad: f.gradert && f.grad.trim() ? Number(f.grad) : null } : {}),
          ...(!selv && permisjon
            ? {
                permisjon_art: permittering ? "permittering" : f.art,
                prosent: f.delvis && f.prosent.trim() ? Number(f.prosent) : null,
                slutt_ukjent: f.sluttUkjent,
              }
            : {}),
          ...(!selv && permittering ? { varslet: f.varslet || null, lonnsplikt_til: f.lonnsplikt ? f.lonnspliktTil || null : null } : {}),
        };
    const r = await h.kjor(() =>
      fravaer.id
        ? api("PATCH", `/org/${org!.id}/fravaer/${fravaer.id}`, kropp)
        : api("POST", `/org/${org!.id}/fravaer`, { ...kropp, ...(selv ? {} : { ansatt_id: f.ansatt_id }) }),
    );
    if (!r) return;
    const hvem = selv ? "Du" : r.ansatt_navn;
    ferdig(
      (sendEgen
        ? `Egenmeldingen er sendt (${fravaerPeriode(r)}). Lederen din har fått beskjed.`
        : fravaer.id
          ? "Fraværet er endret."
          : selv
            ? `Sykdommen er meldt (${fravaerPeriode(r)}). Lederen din har fått beskjed.`
            : `${fravaerNavn(r)} for ${hvem} er registrert (${fravaerPeriode(r)}).`) + (r.merknader?.length ? ` ${r.merknader.join(" ")}` : ""),
      r.vakter,
    );
  }

  async function slett() {
    if (!confirm(selv ? "Slette sykdommen du har meldt?" : `Slette fraværet for ${fravaer.ansatt_navn}?`)) return;
    const r = await h.kjor(async () => (await api("DELETE", `/org/${org!.id}/fravaer/${fravaer.id}`), true));
    if (r) ferdig("Fraværet er slettet.");
  }

  return (
    <form onSubmit={lagre}>
      {!selv && (
        <label>
          Ansatt
          <select
            required
            disabled={!!fravaer.id}
            value={f.ansatt_id}
            onChange={(e) =>
              sett({
                ansatt_id: e.target.value,
                ...(!lonnspliktEndret.current && /^\d{4}-\d{2}-\d{2}$/.test(f.fra)
                  ? { lonnspliktTil: lonnspliktSlutt(f.fra, lonnspliktDager(f.delvis ? Number(f.prosent) : null), planDager(e.target.value)) }
                  : {}),
              })
            }
          >
            <option value="">Velg ansatt</option>
            {valg.map((a) => (
              <option key={a.id} value={a.id}>
                {a.fornavn} {a.etternavn}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className={`faner valg${selv ? "" : " fravaertyper"}${typer.length % 3 === 1 ? " siste-hel" : ""}`} role="radiogroup" aria-label="Type fravær">
        {typer.map((t) => (
          <button key={t} type="button" role="radio" aria-checked={f.type === t} className={f.type === t ? "valgt" : undefined} disabled={bareSlutt} onClick={() => sett({ type: t })}>
            {t === "annet" ? "Annet" : t === "permittering" ? "Permittering" : fravaerTekst[t]}
          </button>
        ))}
      </div>
      <div className="rad">
        <label>
          Fra og med
          <input
            type="date"
            required
            disabled={bareSlutt}
            min={selv && !fravaer.id ? leggTilDager(iDag(), sendEgen ? -16 : -1) : undefined}
            value={f.fra}
            onChange={(e) =>
              sett({
                fra: e.target.value,
                til: f.til < e.target.value ? e.target.value : f.til,
                ...(!lonnspliktEndret.current && /^\d{4}-\d{2}-\d{2}$/.test(e.target.value)
                  ? { lonnspliktTil: lonnspliktSlutt(e.target.value, lonnspliktDager(f.delvis ? Number(f.prosent) : null), planDager(f.ansatt_id)) }
                  : {}),
              })
            }
          />
        </label>
        <label>
          {erSykdom(f.type) ? "Til og med (siste sykedag)" : "Til og med"}
          <input type="date" required min={f.fra} value={f.til} onChange={(e) => sett({ til: e.target.value })} />
        </label>
      </div>
      {!selv && f.type === "ferie" && f.ansatt_id && /^\d{4}/.test(f.fra) && <FerieSaldo ansattId={f.ansatt_id} aar={Number(f.fra.slice(0, 4))} />}
      {avspasering && (
        <label>
          Timer fra timebanken
          <input
            inputMode="decimal"
            required
            placeholder="7,5"
            value={f.timer}
            onChange={(e) => {
              timerEndret.current = true;
              sett({ timer: e.target.value });
            }}
          />
          <TimebankSaldo ansattId={f.ansatt_id} />
        </label>
      )}
      {!selv && f.type === "permisjon" && (
        <>
          <label>
            Hva slags permisjon
            <select value={f.art} onChange={(e) => sett({ art: e.target.value as PermisjonsArt })}>
              {(Object.keys(PERMISJONSARTER) as PermisjonsArt[])
                .filter((a) => a !== "permittering")
                .map((a) => (
                  <option key={a} value={a}>
                    {PERMISJONSARTER[a].valg}
                  </option>
                ))}
            </select>
            <span className="felt-hjelp">Som i a-meldingen: permisjon over 14 dager rapporteres der hver måned den varer.</span>
          </label>
          <label>
            <input type="checkbox" checked={f.betalt} onChange={(e) => sett({ betalt: e.target.checked })} />
            Med lønn (betalt permisjon, f.eks. velferdspermisjon)
            {!f.betalt && <span className="felt-hjelp">Uten lønn trekkes fastlønnen for arbeidsdagene i permisjonen (med prosenten) i lønnskjøringen.</span>}
          </label>
        </>
      )}
      {!selv && permittering && (
        <>
          <div className="rad">
            <label>
              Varselet ble gitt
              <input type="date" required max={f.fra} value={f.varslet} onChange={(e) => sett({ varslet: e.target.value })} />
            </label>
            <label>
              Siste dag med lønnsplikt
              <input
                type="date"
                required={f.lonnsplikt}
                disabled={!f.lonnsplikt}
                min={f.fra}
                value={f.lonnsplikt ? f.lonnspliktTil : ""}
                onChange={(e) => {
                  lonnspliktEndret.current = true;
                  sett({ lonnspliktTil: e.target.value });
                }}
              />
            </label>
          </div>
          {kortVarsel && (
            <p className="melding advarsel">Varselet er gitt mindre enn 14 dager før permitteringen begynner. Fristen er normalt 14 dager (2 dager ved uforutsette hendelser).</p>
          )}
          <label>
            <input type="checkbox" checked={f.lonnsplikt} onChange={(e) => sett({ lonnsplikt: e.target.checked })} />
            Lønnsplikt: arbeidsgiveren betaler lønnen de første dagene
            <span className="felt-hjelp">
              Foreslått: de 15 første arbeidsdagene av permitteringen, etter den faste arbeidsplanen (ved delvis permittering summeres de permitterte timene til
              15 dager, så perioden blir lengre). Med fastlønn går lønnen som vanlig så lenge, og deretter trekkes den permitterte delen; med timelønn lønnes de
              planlagte timene. Uten lønnsplikt bare når permitteringen skyldes brann, ulykke eller naturomstendigheter. Etter 26 uker uten lønnsplikt i løpet
              av 18 måneder gjelder lønnsplikten igjen. Sjekk reglene på nav.no.
            </span>
          </label>
        </>
      )}
      {!selv && permisjon && (
        <>
          <label>
            <input
              type="checkbox"
              checked={f.delvis}
              onChange={(e) => sett({ delvis: e.target.checked, ...nyLonnsplikt(f.fra, e.target.checked ? Number(f.prosent) : null) })}
            />
            {permittering ? "Delvis permittering (jobber resten)" : "Delvis permisjon (jobber resten)"}
          </label>
          {f.delvis && (
            <label>
              Prosent av stillingen
              <input
                type="number"
                inputMode="numeric"
                required
                min={1}
                max={99}
                placeholder="50"
                value={f.prosent}
                onChange={(e) => sett({ prosent: e.target.value, ...nyLonnsplikt(f.fra, Number(e.target.value)) })}
              />
              <span className="felt-hjelp">
                Andelen av stillingen {permittering ? "som er permittert" : "permisjonen gjelder"}, f.eks. 40 når den ansatte jobber 60 % av den. Den ansatte er på jobb i
                vaktplanen og på tavla, og kan ha ferie og annet fravær i perioden.
              </span>
            </label>
          )}
          <label>
            <input type="checkbox" checked={f.sluttUkjent} onChange={(e) => sett({ sluttUkjent: e.target.checked })} />
            Sluttdatoen er ikke bestemt (inntil videre)
            {f.sluttUkjent && (
              <span className="felt-hjelp">
                Til-datoen er foreløpig: den rapporteres i a-meldingen først den måneden {permittering ? "permitteringen" : "permisjonen"} står til å slutte. Forleng den om
                den varer lenger.
              </span>
            )}
          </label>
        </>
      )}
      {medLonn && (
        <label>
          Timer med lønn
          <input
            inputMode="decimal"
            required
            placeholder="7,5"
            value={f.timer}
            onChange={(e) => {
              timerEndret.current = true;
              sett({ timer: e.target.value });
            }}
          />
          <span className="felt-hjelp">
            Foreslått av de planlagte timene (vakter og faste dager), ellers en vanlig arbeidsdag per dag. Med timelønn lønnes timene; med fastlønn går lønnen som
            vanlig.
          </span>
        </label>
      )}
      {selv && (
        <EgenmeldingValg
          fravaer={fravaer}
          type={f.type as FravaerType}
          periode={{ fra: f.fra, til: f.til }}
          send={sendEgen}
          arbeidsrelatert={egen.arbeidsrelatert}
          endre={(e) => settEgen({ ...egen, ...e })}
        />
      )}
      {!selv && erSykdom(f.type) && (
        <label>
          Dokumentasjon
          <select value={f.dokumentasjon} onChange={(e) => sett({ dokumentasjon: e.target.value as Dokumentasjon | "" })}>
            <option value="">Ikke levert ennå</option>
            <option value="egenmelding">Egenmelding</option>
            <option value="sykmelding">{f.type === "sykt_barn" ? "Legeerklæring" : "Sykmelding fra lege"}</option>
          </select>
          {fravaer.egenmeldt && f.dokumentasjon === "egenmelding" ? (
            <span className="felt-hjelp">
              Egenmelding {fravaer.egenmeldt_selv ? "sendt av den ansatte" : "registrert"} {tidspunkt(fravaer.egenmeldt)}.
              {fravaer.type === "syk" && fravaer.arbeidsrelatert != null && (fravaer.arbeidsrelatert ? " Har sammenheng med arbeidet." : " Har ikke sammenheng med arbeidet.")}
            </span>
          ) : fravaer.fra_nav ? (
            <span className="felt-hjelp">Fra sykmeldingen hos NAV (Lønn → Sykepenger).</span>
          ) : (
            <span className="felt-hjelp">Egenmelding på papir eller sykmelding fra lege. Den ansatte kan også sende egenmeldingen selv i appen.</span>
          )}
        </label>
      )}
      {!selv && f.type === "syk" && (
        <>
          <label>
            <input type="checkbox" checked={f.gradert} onChange={(e) => sett({ gradert: e.target.checked })} />
            Gradert sykmelding (jobber delvis)
          </label>
          {f.gradert && (
            <label>
              Sykmeldingsgrad (%)
              <input type="number" inputMode="numeric" required min={1} max={99} placeholder="50" value={f.grad} onChange={(e) => sett({ grad: e.target.value })} />
              <span className="felt-hjelp">
                Andelen den ansatte er sykmeldt. I arbeidsgiverperioden får den ansatte sykepenger for den delen av timene; resten er arbeid som vanlig.
              </span>
            </label>
          )}
        </>
      )}
      {!bareSlutt &&
        (permittering ? (
          <label>
            Grunnen til permitteringen
            <input maxLength={500} required placeholder="F.eks. ordremangel" value={f.notat} onChange={(e) => sett({ notat: e.target.value })} />
            <span className="felt-hjelp">Står i varselet om permittering (PDF) den ansatte får.</span>
          </label>
        ) : (
          <label>
            Notat
            <input maxLength={500} placeholder={selv ? "Valgfritt, f.eks. når du regner med å være tilbake" : "Valgfritt"} value={f.notat} onChange={(e) => sett({ notat: e.target.value })} />
            {erSykdom(f.type) && <span className="felt-hjelp">Ikke skriv hva sykdommen gjelder.</span>}
          </label>
        ))}
      <Feil melding={h.feil} />
      <div className="knapper">
        <button className="primar" disabled={h.opptatt}>
          {sendEgen ? "Send egenmelding" : fravaer.id ? "Lagre" : selv ? "Meld sykdom" : "Registrer"}
        </button>
        <button type="button" onClick={avbryt}>
          Avbryt
        </button>
        {fravaer.id && fravaer.permisjon_art === "permittering" && (
          <button
            type="button"
            disabled={h.opptatt || !fravaer.notat}
            title={fravaer.notat ? "Varselet med det som er lagret" : "Skriv grunnen til permitteringen og lagre først"}
            onClick={() => void h.kjor(() => lastNed(`/org/${org!.id}/fravaer/${fravaer.id}/permitteringsvarsel`, `permitteringsvarsel-${fravaer.fra}.pdf`))}
          >
            Varsel (PDF)
          </button>
        )}
        {fravaer.id && (
          <button type="button" className="fare" style={{ marginLeft: "auto" }} disabled={h.opptatt} onClick={slett}>
            Slett
          </button>
        )}
      </div>
    </form>
  );
}

// Saldoen i timebanken under timene for avspasering (lederen): «Kari har 12,5 t i timebanken».
function TimebankSaldo({ ansattId }: { ansattId: string }) {
  const { org } = useKonto();
  const s = useData(
    () => (ansattId ? hent<{ saldo: { navn: string; saldo: number; dag_timer: number | null } }>(`/org/${org!.id}/timebank/${ansattId}`) : Promise.resolve(null)),
    [org?.id, ansattId],
  );
  const x = s.data?.saldo;
  const tall = (n: number) => n.toLocaleString("nb-NO", { maximumFractionDigits: 2 });
  const d = x?.dag_timer && x.saldo ? Math.round((x.saldo / x.dag_timer) * 10) / 10 : null;
  return (
    <span className="felt-hjelp">
      Foreslått av de planlagte timene (vakter og faste dager), ellers en vanlig arbeidsdag per dag.
      {x ? ` ${x.navn.split(" ")[0]} har ${tall(x.saldo)} t i timebanken${d != null ? ` (${tall(d)} ${Math.abs(d) === 1 ? "dag" : "dager"})` : ""}.` : ""}
    </span>
  );
}

// Egenmeldingen i skjemaet til den ansatte: erklæringen (avkrysningen), spørsmålet om arbeidet og
// reglene med det som er brukt. Sendt fra før: når, og hva slags dokumentasjon.
function EgenmeldingValg({
  fravaer,
  type,
  periode,
  send,
  arbeidsrelatert,
  endre,
}: {
  fravaer: Partial<Fravaer>;
  type: FravaerType;
  periode: { fra: string; til: string };
  send: boolean;
  arbeidsrelatert: "nei" | "ja" | "vet_ikke";
  endre: (e: { send?: boolean; arbeidsrelatert?: "nei" | "ja" | "vet_ikke" }) => void;
}) {
  const { org } = useKonto();
  const status = useData(() => hent<EgenmeldingStatus>(`/org/${org!.id}/egenmelding`), [org?.id]);
  const s = status.data;
  const barn = type === "sykt_barn";
  // Før retten er opptjent (egen sykdom): ikke egenmelding.
  const forTidlig = !!s && !barn && periode.fra < s.opptjent_fra;
  useEffect(() => {
    if (forTidlig && send) endre({ send: false });
  }, [forTidlig, send, endre]);

  if (fravaer.dokumentasjon)
    return (
      <p className="melding info egenmelding-sendt">
        {fravaer.dokumentasjon === "egenmelding"
          ? `Egenmelding ${fravaer.egenmeldt_selv ? "sendt" : "registrert av lederen din"}${fravaer.egenmeldt ? ` ${tidspunkt(fravaer.egenmeldt)}` : ""}.`
          : `${barn ? "Legeerklæring" : "Sykmelding fra lege"} er registrert av lederen din.`}
      </p>
    );
  const maks = !s ? null : barn ? s.regler.barn_dager : Math.max(3, s.regler.dager);
  const lengde = dager(periode);
  const fortid = periode.til < iDag();
  return (
    <fieldset className="egenmelding">
      <legend>Egenmelding</legend>
      <label className="egenmelding-valg">
        <input type="checkbox" checked={send} disabled={forTidlig} onChange={(e) => endre({ send: e.target.checked })} />
        <span>
          <strong>Send egenmelding.</strong>{" "}
          {barn
            ? `Jeg erklærer at jeg ${fortid ? "var" : "er"} borte fra arbeidet fordi barnet mitt ${fortid ? "var" : "er"} sykt, eller fordi den som har tilsyn med barnet, ${fortid ? "var" : "er"} syk.`
            : `Jeg erklærer at jeg ${fortid ? "var" : "er"} borte fra arbeidet på grunn av egen sykdom eller skade.`}
        </span>
      </label>
      {send && !barn && (
        <label>
          Har fraværet sammenheng med arbeidet?
          <select value={arbeidsrelatert} onChange={(e) => endre({ arbeidsrelatert: e.target.value as "nei" | "ja" | "vet_ikke" })}>
            <option value="nei">Nei</option>
            <option value="ja">Ja</option>
            <option value="vet_ikke">Vet ikke</option>
          </select>
          <span className="felt-hjelp">Svaret går til lederen din, så arbeidsplassen kan følge opp. Ikke skriv hva sykdommen gjelder.</span>
        </label>
      )}
      {status.feil ? (
        <Feil melding={status.feil} />
      ) : !s ? (
        <Laster />
      ) : forTidlig ? (
        <p className="felt-hjelp">
          Egenmelding kan brukes etter to måneder i jobben, fra {visDag(s.opptjent_fra)}. Før det trengs sykmelding fra lege.
        </p>
      ) : (
        <>
          {send && maks != null && lengde > maks && (
            <div className="melding advarsel">
              Perioden er {lengde} dager. En egenmelding kan gjelde høyst {maks} dager på rad (kalenderdager, også helg); lengre fravær trenger{" "}
              {barn ? "legeerklæring" : "sykmelding fra lege"}.
            </div>
          )}
          <p className="felt-hjelp">{barn ? reglerBarn(s) : reglerSyk(s)}</p>
        </>
      )}
    </fieldset>
  );
}

// «Egenmelding gjelder inntil 3 dager på rad, 4 ganger i løpet av 12 måneder. Du har brukt 1 (2 dager).»
function reglerSyk(s: EgenmeldingStatus, du = true) {
  const r = s.regler;
  const lov = r.dager === 3 && r.ganger === 4 && r.dager_aar == null;
  const grenser = [r.ganger != null ? `${r.ganger} ganger` : null, r.dager_aar != null ? `${r.dager_aar} dager` : null].filter(Boolean).join(" og ");
  const regel = lov
    ? "Egenmelding gjelder inntil 3 dager på rad (kalenderdager, også helg), 4 ganger i løpet av 12 måneder."
    : `Egenmelding gjelder inntil ${r.dager} dager på rad${grenser ? ` og ${grenser} i løpet av 12 måneder` : ""} (loven gir alltid 3 dager, 4 ganger).`;
  const brukt = s.brukt.ganger
    ? `${du ? "Du har" : "Har"} brukt ${flertall(s.brukt.ganger, "gang", "ganger")} (${flertall(s.brukt.dager, "dag", "dager")}) de siste 12 månedene.`
    : `${du ? "Du har" : "Har"} ikke brukt egenmelding de siste 12 månedene.`;
  return `${regel} ${brukt}`;
}
function reglerBarn(s: EgenmeldingStatus) {
  return `Egenmelding for sykt barn gjelder inntil ${s.regler.barn_dager} dager på rad, og telles ikke med i egenmeldingene for egen sykdom. Sykt barn i ${s.sykt_barn.aar}: ${flertall(
    s.sykt_barn.dager,
    "arbeidsdag",
    "arbeidsdager",
  )} (de fleste har 10 omsorgsdager i året, 15 med tre barn eller flere, og dobbelt så mange alene om omsorgen).`;
}

// Vikar for en vakt: velg en som er i arbeid og ikke borte den dagen, eller legg inn en ny
// vikar (tilkalling). Vikaren får en egen vakt med samme tid, og tar over plassene på tavla.
export function VikarSkjema({
  vakt,
  ansatte,
  fravaer,
  opptatt,
  hentVaktId,
  ferdig,
  avbryt,
}: {
  vakt: { id: string; dato: string; fra: string; til: string; oppgave: string | null; ansatt_id: string | null; ansatt_navn: string | null };
  ansatte: Ansatt[];
  fravaer: Pick<Fravaer, "ansatt_id" | "fra" | "til" | "type">[];
  opptatt?: Map<string, string>; // ansatte som er på jobb samme dag: id → tiden (tom for en hel dag)
  // For en fast arbeidsdag uten vakt: lager vakten (fra planen) når vikaren settes inn.
  hentVaktId?: () => Promise<string>;
  ferdig: (melding: string) => void;
  avbryt: () => void;
}) {
  const { org } = useKonto();
  const [valgt, settValgt] = useState("");
  const [publiser, settPubliser] = useState(true);
  const [ny, settNy] = useState<{ fornavn: string; etternavn: string; telefon: string } | null>(null);
  const [lagt, settLagt] = useState<Ansatt[]>([]);
  const h = useHandling();
  // De som er i arbeid og ikke borte den dagen; de uten vakt den dagen først.
  const kandidater = [...ansatte, ...lagt]
    .filter((a) => a.id !== vakt.ansatt_id && iArbeid(a, vakt.dato) && !borte(fravaer, a.id, vakt.dato))
    .sort((a, b) => Number(!!opptatt?.has(a.id)) - Number(!!opptatt?.has(b.id)));

  async function settInn(e: FormEvent) {
    e.preventDefault();
    const r = await h.kjor(async () => {
      let ansatt = valgt;
      if (ny) {
        const a = await api<Ansatt>("POST", `/org/${org!.id}/ansatte`, {
          fornavn: ny.fornavn,
          etternavn: ny.etternavn,
          telefon: ny.telefon || null,
          ansettelsestype: "tilkalling",
          lonnstype: "time",
          ansatt_fra: vakt.dato,
        });
        settLagt((l) => [...l, a]);
        settNy(null);
        ansatt = a.id;
      }
      if (!ansatt) throw new Error("Velg en vikar");
      const id = vakt.id || (await hentVaktId!());
      return api("POST", `/org/${org!.id}/vakter/${id}/vikar`, { ansatt_id: ansatt, publiser });
    });
    if (r) ferdig(`${r.ansatt_navn} er satt inn som vikar ${visDag(vakt.dato)} ${vakt.fra}–${vakt.til}.${publiser ? " Vikaren har fått beskjed." : ""}`);
  }

  return (
    <form onSubmit={settInn}>
      <p className="dempet" style={{ marginTop: 0 }}>
        {vakt.ansatt_navn ? `${vakt.ansatt_navn} er borte. ` : ""}Vikaren får en egen vakt {visDag(vakt.dato)} {vakt.fra}–{vakt.til}
        {vakt.oppgave ? ` (${vakt.oppgave})` : ""}, og tar over plassene på tavla.
      </p>
      {ny ? (
        <fieldset className="ny-vikar">
          <legend>Ny vikar</legend>
          <div className="rad">
            <label>
              Fornavn
              <input required autoFocus value={ny.fornavn} onChange={(e) => settNy({ ...ny, fornavn: e.target.value })} />
            </label>
            <label>
              Etternavn
              <input required value={ny.etternavn} onChange={(e) => settNy({ ...ny, etternavn: e.target.value })} />
            </label>
          </div>
          <label>
            Telefon
            <input type="tel" value={ny.telefon} onChange={(e) => settNy({ ...ny, telefon: e.target.value })} />
            <span className="felt-hjelp">Legges inn som ansatt med tilkalling og timelønn. Resten fyller du ut under Ansatte.</span>
          </label>
          <button type="button" className="lenke" onClick={() => settNy(null)}>
            Velg en av de ansatte i stedet
          </button>
        </fieldset>
      ) : (
        <label>
          Vikar
          <select required value={valgt} onChange={(e) => settValgt(e.target.value)}>
            <option value="">Velg vikar</option>
            {kandidater.map((a) => (
              <option key={a.id} value={a.id}>
                {a.fornavn} {a.etternavn}
                {opptatt?.has(a.id) ? (opptatt.get(a.id) ? ` (har vakt ${opptatt.get(a.id)})` : " (på jobb)") : ""}
              </option>
            ))}
          </select>
          <button type="button" className="lenke ny-vikar-lenke" onClick={() => settNy({ fornavn: "", etternavn: "", telefon: "" })}>
            + Ny vikar som ikke er lagt inn
          </button>
        </label>
      )}
      <label>
        <input type="checkbox" checked={publiser} onChange={(e) => settPubliser(e.target.checked)} />
        Publiser vakten og varsle vikaren nå
      </label>
      <Feil melding={h.feil} />
      <div className="knapper">
        <button className="primar" disabled={h.opptatt}>
          Sett inn vikar
        </button>
        <button type="button" onClick={avbryt}>
          Avbryt
        </button>
      </div>
    </form>
  );
}

// Fraværet i organisasjonen: nå og framover, eller tidligere. Eier og administrator
// registrerer og endrer; regnskap ser.
export function FravaerListe({ versjon, endret }: { versjon: number; endret: () => void }) {
  const { org } = useKonto();
  const [tidligere, settTidligere] = useState(false);
  const [apen, settApen] = useState<Partial<Fravaer> | null>(null);
  const [melding, settMelding] = useState<string | null>(null);
  const [berort, settBerort] = useState<BerortVakt[]>([]);
  const fra = tidligere ? leggTilDager(iDag(), -365) : iDag();
  const til = tidligere ? leggTilDager(iDag(), -1) : leggTilDager(iDag(), 365);
  const { data, feil } = useData(() => hent<Fravaer[]>(`/org/${org!.id}/fravaer?fra=${fra}&til=${til}`), [org?.id, tidligere, versjon]);
  const ansatte = useData(() => hent<Ansatt[]>(`/org/${org!.id}/ansatte`), [org?.id, versjon]);
  const endre = kanPersonal(org?.rolle);
  const liste = (data ?? []).slice().sort((a, b) => (tidligere ? b.fra.localeCompare(a.fra) : a.fra.localeCompare(b.fra)));

  return (
    <>
      <div className="uke-verktoy">
        <div className="faner" role="tablist">
          {(
            [
              [false, "Nå og framover"],
              [true, "Tidligere"],
            ] as const
          ).map(([v, t]) => (
            <button key={t} type="button" role="tab" aria-selected={tidligere === v} className={tidligere === v ? "valgt" : undefined} onClick={() => settTidligere(v)}>
              {t}
            </button>
          ))}
        </div>
        {endre && (
          <button type="button" className="primar" onClick={() => settApen({})}>
            Registrer fravær
          </button>
        )}
      </div>
      {melding && (
        <div className="melding ok" role="status">
          {melding}
          {berort.length > 0 && (
            <>
              <br />
              {berort.length === 1 ? "Én vakt" : `${berort.length} vakter`} i perioden mangler vikar: {berort.map((v) => `${visDag(v.dato)} ${v.fra}–${v.til}`).join(", ")}. Sett
              inn vikar fra vaktplanen eller tavla.
            </>
          )}
        </div>
      )}
      <Feil melding={feil} />
      {!data ? (
        !feil && <Laster />
      ) : !liste.length ? (
        <div className="kort">
          <Tom ikon={<IkonKalender storrelse={22} />} tittel={tidligere ? "Ingen fravær det siste året" : "Ingen fravær nå eller framover"}>
            <p>Sykdom, ferie og permisjon vises i vaktplanen og på tavla. Den som er borte, tas ut av ressursene på tavla.</p>
          </Tom>
        </div>
      ) : (
        <div className="kort liste">
          {liste.map((f) => (
            <button key={f.id} type="button" className="liste-rad" onClick={() => endre && settApen(f)} disabled={!endre}>
              <span className="linje">
                <span className="tittel">{f.ansatt_navn}</span>
                <span className={`merke ${fravaerKlasse[f.type]}`}>{fravaerNavn(f)}</span>
                {dokumentasjonTekst(f) && <span className="merke merke-dok">{dokumentasjonTekst(f)}</span>}
                {gradTekst(f) && <span className="merke merke-dok">{gradTekst(f)}</span>}
                {prosentTekst(f) && <span className="merke merke-dok">{prosentTekst(f)}</span>}
                {f.fra_nav && <span className="merke merke-noytral">Fra NAV</span>}
              </span>
              <span className="linje">
                <span className="under">
                  {fravaerPeriode(f)} · {dager(f) === 1 ? "1 dag" : `${dager(f)} dager`}
                  {f.slutt_ukjent ? " · inntil videre" : ""}
                  {f.notat ? ` · ${f.notat}` : ""}
                </span>
                {f.fra <= iDag() && f.til >= iDag() && <span className="merke merke-advarsel">Nå</span>}
              </span>
            </button>
          ))}
        </div>
      )}
      <p className="liten dempet">
        Fravær er helseopplysninger: bare eier, administrator, regnskap og den ansatte selv ser det, og hva slags fravær det er, ser bare eier, administrator og
        den ansatte selv.
      </p>
      <Dialog apen={!!apen} lukk={() => settApen(null)} tittel={apen?.id ? "Endre fravær" : "Registrer fravær"}>
        {apen && (
          <FravaerSkjema
            fravaer={apen}
            ansatte={ansatte.data ?? []}
            ferdig={(m, b) => {
              settApen(null);
              settMelding(m);
              settBerort(b ?? []);
              endret();
            }}
            avbryt={() => settApen(null)}
          />
        )}
      </Dialog>
    </>
  );
}

// Den ansattes eget fravær (i «Mine vakter»): meld deg syk, send egenmelding (også etterpå, for
// sykdom de siste 16 dagene), friskmeld deg.
// Fraværet hentes her (med dokumentasjonen), fra 16 dager tilbake; versjon: endret utenfra.
export function MittFravaer({ ansattId, versjon: utenfra, endret }: { ansattId: string; versjon?: unknown; endret: () => void }) {
  const { org } = useKonto();
  const [apen, settApen] = useState<{ f: Partial<Fravaer>; egenmelding: boolean } | null>(null);
  const [melding, settMelding] = useState<string | null>(null);
  const [versjon, settVersjon] = useState(0);
  const liste = useData(
    () => hent<Fravaer[]>(`/org/${org!.id}/fravaer?fra=${leggTilDager(iDag(), -16)}&til=${leggTilDager(iDag(), 365)}&ansatt=${ansattId}`),
    [org?.id, ansattId, versjon, utenfra],
  );
  // Det som pågår eller kommer, og sykdom som er over uten egenmelding eller sykmelding (den kan
  // sendes nå).
  const aktuelt = (liste.data ?? []).filter((f) => f.til >= iDag() || (erSykdom(f.type) && !f.dokumentasjon));
  const tittel = !apen ? "" : apen.egenmelding ? "Send egenmelding" : apen.f.id ? "Endre sykdom" : "Meld deg syk";
  return (
    <>
      {melding && (
        <div className="melding ok" role="status">
          {melding}
        </div>
      )}
      <div className="mitt-fravaer">
        {aktuelt.map((f) => (
          <div key={f.id} className="melding info mitt-fravaer-rad">
            <span>
              <strong>{fravaerNavn(f)}</strong> {fravaerPeriode(f)}
              {dokumentasjonTekst(f) && <span className="merke merke-dok">{dokumentasjonTekst(f)}</span>}
              {gradTekst(f) && <span className="merke merke-dok">{gradTekst(f)}</span>}
              {prosentTekst(f) && <span className="merke merke-dok">{prosentTekst(f)}</span>}
            </span>
            {erSykdom(f.type) && (
              <span className="mitt-fravaer-knapper">
                {!f.dokumentasjon && (
                  <button type="button" className="lenke" onClick={() => settApen({ f, egenmelding: true })}>
                    Send egenmelding
                  </button>
                )}
                {f.til >= iDag() && (
                  <button type="button" className="lenke" onClick={() => settApen({ f, egenmelding: false })}>
                    Endre
                  </button>
                )}
              </span>
            )}
          </div>
        ))}
        <div className="knapper">
          <button type="button" onClick={() => settApen({ f: {}, egenmelding: false })}>
            Meld deg syk
          </button>
          <button type="button" onClick={() => settApen({ f: {}, egenmelding: true })}>
            Send egenmelding
          </button>
        </div>
      </div>
      <Dialog apen={!!apen} lukk={() => settApen(null)} tittel={tittel}>
        {apen && (
          <FravaerSkjema
            fravaer={apen.f}
            selv
            egenmelding={apen.egenmelding}
            ferdig={(m) => {
              settApen(null);
              settMelding(m);
              settVersjon((v) => v + 1);
              endret();
            }}
            avbryt={() => settApen(null)}
          />
        )}
      </Dialog>
    </>
  );
}

// Meldingen etter at fraværet er lagret, med vaktene i perioden som mangler vikar.
export const fravaerMelding = (m: string, berort?: BerortVakt[]) =>
  berort?.length
    ? `${m} ${berort.length === 1 ? "Én vakt" : `${berort.length} vakter`} i perioden mangler vikar: ${berort.map((v) => `${visDag(v.dato)} ${v.fra}–${v.til}`).join(", ")}.`
    : m;

// Registrer eller endre fravær fra hvor som helst: ansattkortet, vaktplanen, tavla, bemannings-
// kalenderen og timelista (samme fravær som i fraværslista). Uten liste over ansatte hentes den.
// Hvor mange feriedager den ansatte har igjen det året (feriebanken, Ferie.tsx), når ferie registreres.
function FerieSaldo({ ansattId, aar, lenke }: { ansattId: string; aar: number; lenke?: boolean }) {
  const { org } = useKonto();
  const { data } = useData(
    () => hent<{ saldo: { rett: number; overfort_inn: number; overfort_ut: number; avviklet: number; planlagt: number; igjen: number } }>(
      `/org/${org!.id}/feriebank/${ansattId}?aar=${aar}`,
    ).catch(() => null),
    [org?.id, ansattId, aar],
  );
  if (!data) return null;
  const s = data.saldo;
  const tekst = (n: number) => String(Math.round(n * 10) / 10).replace(".", ",");
  return (
    <p className="felt-hjelp ferie-saldo-hint">
      Feriebank {aar}: {tekst(s.rett + s.overfort_inn - s.overfort_ut)} dager, {tekst(s.avviklet + s.planlagt)} avviklet eller planlagt{lenke ? "" : " fra før"},{" "}
      <strong>
        {tekst(s.igjen)} {Math.abs(s.igjen) === 1 ? "dag" : "dager"} igjen
      </strong>
      .{lenke && <> <Link to={`/ferie?aar=${aar}`}>Se feriebanken</Link></>}
    </p>
  );
}

export function FravaerDialog({
  fravaer,
  ansatte,
  lukk,
  ferdig,
}: {
  fravaer: Partial<Fravaer> | null;
  ansatte?: Ansatt[];
  lukk: () => void;
  ferdig: (melding: string) => void;
}) {
  const { org } = useKonto();
  const apen = !!fravaer;
  const liste = useData(() => (ansatte || !apen ? Promise.resolve(ansatte ?? null) : hent<Ansatt[]>(`/org/${org!.id}/ansatte`)), [org?.id, apen, ansatte]);
  return (
    <Dialog apen={apen} lukk={lukk} tittel={fravaer?.id ? "Endre fravær" : "Registrer fravær"}>
      {fravaer &&
        (liste.feil ? (
          <Feil melding={liste.feil} />
        ) : !liste.data ? (
          <Laster />
        ) : (
          <FravaerSkjema fravaer={fravaer} ansatte={liste.data} ferdig={(m, berort) => ferdig(fravaerMelding(m, berort))} avbryt={lukk} />
        ))}
    </Dialog>
  );
}

// Fraværet og ferien til én ansatt i år og det som kommer (i ansattkortet). Registrering og
// endring går gjennom FravaerDialog utenfor ansattskjemaet (apne).
export function AnsattFravaer({ ansattId, versjon, kanEndre, apne }: { ansattId: string; versjon: number; kanEndre: boolean; apne: (f: Partial<Fravaer>) => void }) {
  const { org } = useKonto();
  const aar = Number(iDag().slice(0, 4));
  const { data, feil } = useData(
    () => hent<Fravaer[]>(`/org/${org!.id}/fravaer?fra=${aar}-01-01&til=${aar + 1}-12-31&ansatt=${ansattId}`),
    [org?.id, ansattId, versjon],
  );
  return (
    <section className="ansatt-fravaer">
      <h3>Fravær og ferie</h3>
      <p className="felt-hjelp" style={{ marginTop: 0 }}>
        Vises i vaktplanen, på tavla og i timelista, og kan registreres og endres der også.
      </p>
      {kanEndre && <FerieSaldo key={versjon} ansattId={ansattId} aar={aar} lenke />}
      {kanEndre && <EgenmeldingSaldo key={`e${versjon}`} ansattId={ansattId} />}
      {feil ? (
        <Feil melding={feil} />
      ) : !data ? (
        <Laster />
      ) : !data.length ? (
        <p className="dempet liten">Ikke noe fravær registrert i {aar}.</p>
      ) : (
        <ul className="ansatt-fravaer-liste">
          {data.map((f) => (
            <li key={f.id}>
              <button type="button" className="fravaer-rad" disabled={!kanEndre} onClick={() => apne(f)} title={kanEndre ? "Endre fraværet" : undefined}>
                <span className={`merke ${fravaerKlasse[f.type]}`}>{fravaerNavn(f)}</span>
                <span>
                  {fravaerPeriode(f)} · {dager(f) === 1 ? "1 dag" : `${dager(f)} dager`}
                  {erSykdom(f.type) && <span className="dempet"> · {dokumentasjonTekst(f) ?? "ikke dokumentert"}</span>}
                  {gradTekst(f) && <span className="dempet"> · {gradTekst(f)!.toLowerCase()}</span>}
                  {prosentTekst(f) && <span className="dempet"> · {prosentTekst(f)!.toLowerCase()}</span>}
                  {f.slutt_ukjent && <span className="dempet"> · inntil videre</span>}
                </span>
                {f.fra <= iDag() && f.til >= iDag() && <span className="merke merke-advarsel">Nå</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
      {kanEndre && (
        <button type="button" onClick={() => apne({ ansatt_id: ansattId, fra: iDag(), til: iDag() })}>
          Registrer fravær
        </button>
      )}
    </section>
  );
}

// Egenmeldingene til den ansatte i løpet av 12 måneder (i ansattkortet, for eier og administrator).
function EgenmeldingSaldo({ ansattId }: { ansattId: string }) {
  const { org } = useKonto();
  const { data } = useData(() => hent<EgenmeldingStatus>(`/org/${org!.id}/egenmelding?ansatt=${ansattId}`).catch(() => null), [org?.id, ansattId]);
  if (!data) return null;
  return (
    <p className="felt-hjelp egenmelding-saldo">
      {iDag() < data.opptjent_fra ? `Egenmelding fra ${visDag(data.opptjent_fra)} (to måneder i jobben). ` : ""}
      {reglerSyk(data, false)}
    </p>
  );
}
