// Ansatte: registeret over de ansatte (personalia, ansettelse og lønn med faste tillegg) og deres
// egen innlogging for timeføring (rollen ansatt). Hver person kan ha en rolle (f.eks. lege eller
// sekretær, Roller.tsx), og en rolle kan være for dem som ikke er ansatt (f.eks. leger som er
// aksjonærer): de har ikke lønn, feriebank eller fødselsnummer her. Eier og administrator endrer og
// kan importere fra et annet system (Importer.tsx), eller fylle ut skjemaet fra en lønnsslipp som
// AI leser (server/src/aiLonnsslipp.ts); regnskap ser. Fødselsnummeret lagres kryptert og vises
// aldri igjen, bare at det er registrert.
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { api, hent, sendFil } from "../api";
import { Dialog, Feil, Laster, Tom, tall, useData, useHandling, useSmal } from "../felles";
import { harFunksjon, kanPersonal, kanSePersonal, useKonto } from "../konto";
import { dato, iDag } from "../format";
import { fnrGyldig, fodselsdato, kontonrGyldig, visKontonr } from "../personnummer";
import { IkonAnsatte, IkonGnist, IkonLukk } from "../ikoner";
import { slippBlob, SLIPP_ACCEPT, type Lonnsslipper } from "../importer";
import { tallformat } from "../uke";
import { ArbeidsplanFelt, dagerTekst, endret, lagUtkast, tilLagring, type Plan, type PlanUtkast } from "./Arbeidsplan";
import { AnsattFravaer, FravaerDialog, type Fravaer } from "./Fravaer";
import { Lonnsendringer, type GjeldendeLonn } from "./Lonnsendringer";
import { LonnsTrekk } from "./LonnsTrekk";
import { IKKE_ANSATT_HJELP, RollerOppsett, type Rolle } from "./Roller";
import { SkattekortFraSkatteetaten, type Trekk } from "./Skattekort";

type Ansatt = {
  id: string;
  ansattnummer: number;
  fornavn: string;
  etternavn: string;
  forkortelse: string | null; // f.eks. «AB», der plassen er trang (lages av initialene)
  epost: string | null;
  telefon: string | null;
  adresse: string | null;
  postnr: string | null;
  poststed: string | null;
  fodselsdato: string | null;
  har_fnr: boolean;
  kontonr: string | null;
  stilling: string | null;
  stillingsprosent: number;
  ukentlig_arbeidstid: number;
  ansatt_fra: string;
  ansatt_til: string | null;
  ansettelsestype: "fast" | "midlertidig" | "tilkalling";
  rolle: string | null; // rollen (f.eks. lege), gruppe_id er id-en
  arbeidstaker: boolean; // false: rollen er for dem som ikke er ansatt
  lonnstype: "maaned" | "time";
  maanedslonn: number | null;
  timelonn: number | null;
  aktiv: boolean;
  notat: string | null;
  gruppe_id: string | null; // rollen
  kunde_id: string | null; // kunden personen er hentet inn fra (Roller → Hent fra kunder)
  kunde: string | null; // navnet på kunden
  bursdag_varsel: boolean; // varsle de andre på bursdagen (når organisasjonen har slått på bursdagsvarsler)
  ferie_dager: number | null; // feriedager per år for denne ansatte (null: organisasjonens)
  tillegg: Tillegg[]; // faste tillegg på lønnen
  // Skattekortet (0065_lonn.sql): tabelltrekk (tabellnummer og prosentsats), prosenttrekk eller
  // frikort (beløpet), og året. Uten skattekort trekkes 50 %.
  skattekort: "tabell" | "prosent" | "frikort" | null;
  skatt_tabell: number | null;
  skatt_prosent: number | null;
  skatt_frikort: number | null; // frikort uten beløp: uten grense
  skattekort_aar: number | null;
  // Fra Skatteetaten (0068): biarbeidsgiverforhold, hvor skattekortet kom fra, svaret og trekket.
  biarbeidsgiver: boolean;
  skattekort_kilde: "manuell" | "skatteetaten" | null;
  skattekort_hentet: string | null;
  skattekort_resultat: string | null;
  skattekort_utstedt: string | null;
  skattekort_tillegg: string[] | null;
  skattekort_trekk: Trekk[] | null;
  // Arbeidsforholdet i a-meldingen (0077_amelding.sql).
  yrkeskode: string | null;
  arbeidsforhold_type: string;
  arbeidstidsordning: string;
  aarsak_sluttdato: string | null;
  arbeidsdager: number[]; // ukedagene i den faste arbeidsplanen som gjelder i dag
  meg: boolean;
  tilgang: "koblet" | "invitert" | null;
};

// Fast tillegg på lønnen (f.eks. funksjonstillegg per måned), eventuelt for en periode.
type Tillegg = { id: string; navn: string; belop: number; per: "maaned" | "time"; fra: string | null; til: string | null };

const ansettelsestype: Record<string, string> = { fast: "Fast", midlertidig: "Midlertidig", tilkalling: "Tilkalling" };
// Kodene i a-meldingen (0077_amelding.sql).
const ARBEIDSFORHOLD: Record<string, string> = {
  ordinaertArbeidsforhold: "Ordinært arbeidsforhold",
  maritimtArbeidsforhold: "Maritimt arbeidsforhold",
  frilanserOppdragstakerHonorarPersonerMm: "Frilanser, oppdragstaker eller honorar",
};
const ARBEIDSTID: Record<string, string> = {
  ikkeSkift: "Ikke skift",
  andreSkift: "Andre skift",
  skift365: "Skift (36,5 t)",
  doegnkontinuerligSkiftOgTurnus355: "Døgnkontinuerlig skift og turnus (35,5 t)",
  helkontinuerligSkiftOgAndreOrdninger336: "Helkontinuerlig skift og andre ordninger (33,6 t)",
  offshore336: "Offshore (33,6 t)",
};
const SLUTTAARSAK: Record<string, string> = {
  arbeidstakerHarSagtOppSelv: "Den ansatte har sagt opp selv",
  arbeidsgiverHarSagtOppArbeidstaker: "Arbeidsgiveren har sagt opp den ansatte",
  kontraktEngasjementEllerVikariatErUtloept: "Kontrakt, engasjement eller vikariat er utløpt",
  byttetLoenssystemEllerRegnskapsfoerer: "Byttet lønnssystem eller regnskapsfører",
  endringIOrganisasjonsstrukturEllerByttetJobbInternt: "Endret organisasjon eller byttet jobb internt",
  arbeidsforholdetSkulleAldriVaertRapportert: "Arbeidsforholdet skulle aldri vært rapportert",
};
// De som har en rolle for dem som ikke er ansatt (f.eks. leger som er aksjonærer), er med i
// vaktplanen, på tavla og i kalenderen, men ikke i lønn, feriebank og arbeidsmiljølovens advarsler.
const erAnsatt = (a: Pick<Ansatt, "arbeidstaker">) => a.arbeidstaker !== false;
const NY_ROLLE = "ny"; // valget «+ Ny rolle …»
const belop = new Intl.NumberFormat("nb-NO", { maximumFractionDigits: 2 });
const tekstTall = (n: number | null | undefined) => (n == null ? "" : belop.format(n).replace(/\s/g, " "));
const lonn = (a: Ansatt) =>
  a.lonnstype === "maaned" ? (a.maanedslonn != null ? `${belop.format(a.maanedslonn)} kr/mnd` : "") : a.timelonn != null ? `${belop.format(a.timelonn)} kr/t` : "";
const sluttet = (a: Ansatt) => !a.aktiv || (!!a.ansatt_til && a.ansatt_til < iDag());
// Tilleggene som gjelder i dag, kort: «+ Funksjonstillegg 1 500 kr/mnd» eller «+ 2 faste tillegg».
const gjelder = (t: Tillegg) => (!t.fra || t.fra <= iDag()) && (!t.til || t.til >= iDag());
const tilleggKort = (a: Ansatt) => {
  const t = (a.tillegg ?? []).filter(gjelder);
  if (!t.length) return "";
  return t.length === 1 ? `+ ${t[0]!.navn} ${belop.format(t[0]!.belop)} kr/${t[0]!.per === "time" ? "t" : "mnd"}` : `+ ${t.length} faste tillegg`;
};

function Merker({ a }: { a: Ansatt }) {
  return (
    <span className="merker">
      {a.rolle && (
        <span className={`merke ${erAnsatt(a) ? "merke-noytral" : "merke-info"}`} title={erAnsatt(a) ? undefined : "Ikke ansatt"}>
          {a.rolle}
        </span>
      )}
      {sluttet(a) && <span className="merke merke-noytral">{a.aktiv ? "Sluttet" : "Ikke aktiv"}</span>}
      {a.tilgang === "koblet" && <span className="merke merke-ok">Innlogging</span>}
      {a.tilgang === "invitert" && <span className="merke merke-info">Invitert</span>}
    </span>
  );
}

export function Ansatte() {
  const { org } = useKonto();
  const [alle, settAlle] = useState(false);
  const [sok, settSok] = useState("");
  const [apen, settApen] = useState<Partial<Ansatt> | null>(null);
  const { data, feil, last } = useData(() => hent<Ansatt[]>(`/org/${org!.id}/ansatte${alle ? "" : "?aktiv=true"}`), [org?.id, alle]);
  const smal = useSmal();
  const endre = kanPersonal(org?.rolle);
  const vaktplan = harFunksjon(org, "vaktplan");
  // Rollene (f.eks. lege og sekretær) settes opp her og i bemanningskalenderen.
  const [roller, settRoller] = useState(false);
  const [rolleVersjon, settRolleVersjon] = useState(0);
  const rolleliste = useData(() => (roller ? hent<Rolle[]>(`/org/${org!.id}/ansattgrupper`) : Promise.resolve(null)), [org?.id, roller, rolleVersjon]);
  // Alle, også de som har sluttet (de som er hentet inn fra en kunde, hentes ikke inn igjen).
  const allePersoner = useData(() => (roller ? hent<Ansatt[]>(`/org/${org!.id}/ansatte`) : Promise.resolve(null)), [org?.id, roller, rolleVersjon]);

  if (!kanSePersonal(org?.rolle) || !org?.personal)
    return (
      <>
        <h1>Ansatte</h1>
        <div className="kort">
          <Tom ikon={<IkonAnsatte storrelse={22} />} tittel={org?.personal ? "Du har ikke tilgang til ansatte" : "Ansatte og timer er ikke slått på"}>
            {!org?.personal && endre && (
              <p>
                Slå det på under <Link to="/innstillinger?fane=personal">Innstillinger → Ansatte og timer</Link>.
              </p>
            )}
          </Tom>
        </div>
      </>
    );

  const s = sok.trim().toLowerCase();
  const liste = (data ?? []).filter((a) => !s || `${a.fornavn} ${a.etternavn} ${a.ansattnummer} ${a.stilling ?? ""} ${a.epost ?? ""}`.toLowerCase().includes(s));
  const lukk = () => {
    settApen(null);
    last();
  };

  return (
    <>
      <div className="topp">
        <h1>Ansatte</h1>
        {endre && (
          <div className="knapper">
            <button type="button" onClick={() => settRoller(true)}>
              Roller
            </button>
            {harFunksjon(org, "import") && (
              <Link className="knapp" to="/ansatte/importer">
                Importer
              </Link>
            )}
            <button type="button" className="primar" onClick={() => settApen({})}>
              Ny ansatt
            </button>
          </div>
        )}
      </div>
      <Dialog apen={roller} lukk={() => (settRoller(false), last())} tittel={vaktplan ? "Roller og behov" : "Roller"} bred>
        {roller && !rolleliste.data && (rolleliste.feil ? <Feil melding={rolleliste.feil} /> : <Laster />)}
        {roller && rolleliste.data && (
          <RollerOppsett
            roller={rolleliste.data}
            personer={allePersoner.data ?? data ?? []}
            kalender={vaktplan}
            endret={() => (settRolleVersjon((x) => x + 1), last())}
            lukk={() => (settRoller(false), last())}
          />
        )}
      </Dialog>
      <div className="liste-verktoy">
        <div className="faner" role="tablist">
          {(
            [
              [false, "Aktive"],
              [true, "Alle"],
            ] as const
          ).map(([v, t]) => (
            <button key={t} type="button" role="tab" aria-selected={alle === v} className={alle === v ? "valgt" : undefined} onClick={() => settAlle(v)}>
              {t}
            </button>
          ))}
        </div>
        {(data?.length ?? 0) > 6 && <input type="search" className="sok" placeholder="Søk etter navn eller stilling" value={sok} onChange={(e) => settSok(e.target.value)} />}
      </div>
      <Feil melding={feil} />
      {!data ? (
        !feil && <Laster />
      ) : !data.length ? (
        <div className="kort">
          <Tom ikon={<IkonAnsatte storrelse={22} />} tittel={alle ? "Ingen ansatte ennå" : "Ingen aktive ansatte"}>
            <p>
              Legg inn de ansatte med stilling og lønn. De kan få egen innlogging og føre timene sine selv, og du godkjenner dem under{" "}
              <Link to="/timer">Timer</Link>.
            </p>
            {endre && (
              <div className="knapper" style={{ justifyContent: "center" }}>
                <button type="button" className="primar" onClick={() => settApen({})}>
                  Ny ansatt
                </button>
                {harFunksjon(org, "import") && (
                  <Link className="knapp" to="/ansatte/importer">
                    Importer fra et annet system
                  </Link>
                )}
              </div>
            )}
          </Tom>
        </div>
      ) : smal ? (
        <div className="kort liste">
          {liste.map((a) => (
            <button key={a.id} type="button" className="liste-rad" onClick={() => settApen(a)}>
              <span className="linje">
                <span className="tittel">
                  {a.forkortelse && <span className="fork-merke">{a.forkortelse}</span>}
                  {a.fornavn} {a.etternavn}
                </span>
                <span className="under">Nr. {a.ansattnummer}</span>
              </span>
              <span className="linje">
                <span className="under">
                  {[a.stilling, `${belop.format(a.stillingsprosent)} %`, vaktplan ? dagerTekst(a.arbeidsdager ?? []) : "", erAnsatt(a) ? lonn(a) : "", erAnsatt(a) ? tilleggKort(a) : ""]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
                <Merker a={a} />
              </span>
            </button>
          ))}
          {!liste.length && <p className="dempet ingen-enna" style={{ padding: 16 }}>Ingen ansatte passer søket.</p>}
        </div>
      ) : (
        <div className="kort tabell">
          <table>
            <thead>
              <tr>
                <th>Nr.</th>
                <th>Navn</th>
                <th>Stilling</th>
                <th className="tall">Stilling %</th>
                {vaktplan && <th>Faste dager</th>}
                <th className="tall">Lønn</th>
                <th>Ansatt fra</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {liste.map((a) => (
                <tr key={a.id} className="klikkbar" onClick={() => settApen(a)}>
                  <td>{a.ansattnummer}</td>
                  <td>
                    {a.forkortelse && <span className="fork-merke">{a.forkortelse}</span>}
                    {a.fornavn} {a.etternavn}
                    {a.meg && <span className="dempet"> (deg)</span>}
                  </td>
                  <td>{a.stilling}</td>
                  <td className="tall">{belop.format(a.stillingsprosent)} %</td>
                  {vaktplan && <td>{dagerTekst(a.arbeidsdager ?? []) || <span className="dempet">–</span>}</td>}
                  <td className="tall">
                    {erAnsatt(a) ? lonn(a) : <span className="dempet">–</span>}
                    {erAnsatt(a) && tilleggKort(a) && <span className="tillegg-liten">{tilleggKort(a)}</span>}
                  </td>
                  <td>{dato(a.ansatt_fra)}</td>
                  <td>
                    <Merker a={a} />
                  </td>
                </tr>
              ))}
              {!liste.length && (
                <tr>
                  <td colSpan={vaktplan ? 8 : 7} className="dempet">
                    Ingen ansatte passer søket.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      <Dialog apen={!!apen} lukk={lukk} tittel={apen?.id ? `${apen.fornavn} ${apen.etternavn}` : "Ny ansatt"} bred>
        {apen && (
          <AnsattSkjema
            ansatt={apen}
            kanEndre={endre}
            oppdatert={(a) => {
              settApen(a);
              last();
            }}
            lukk={lukk}
          />
        )}
      </Dialog>
    </>
  );
}

// Et fast tillegg i skjemaet (tekstfelt til det lagres).
type TilleggUtkast = { id?: string; navn: string; belop: string; per: "maaned" | "time"; fra: string; til: string };
const tilUtkast = (liste: Tillegg[] | undefined): TilleggUtkast[] =>
  (liste ?? []).map((t) => ({ id: t.id, navn: t.navn, belop: tekstTall(t.belop), per: t.per, fra: t.fra ?? "", til: t.til ?? "" }));

function AnsattSkjema({ ansatt, kanEndre, oppdatert, lukk }: { ansatt: Partial<Ansatt>; kanEndre: boolean; oppdatert: (a: Ansatt) => void; lukk: () => void }) {
  const { org } = useKonto();
  const [tillegg, settTillegg] = useState<TilleggUtkast[]>(() => tilUtkast(ansatt.tillegg));
  const [lagretTillegg, settLagretTillegg] = useState(() => JSON.stringify(tilUtkast(ansatt.tillegg)));
  const endreTillegg = (i: number, e: Partial<TilleggUtkast>) => settTillegg((l) => l.map((t, j) => (j === i ? { ...t, ...e } : t)));
  const [a, settA] = useState(() => ({
    fornavn: ansatt.fornavn ?? "",
    etternavn: ansatt.etternavn ?? "",
    forkortelse: ansatt.forkortelse ?? "",
    epost: ansatt.epost ?? "",
    telefon: ansatt.telefon ?? "",
    adresse: ansatt.adresse ?? "",
    postnr: ansatt.postnr ?? "",
    poststed: ansatt.poststed ?? "",
    fodselsdato: ansatt.fodselsdato ?? "",
    fnr: "",
    endreFnr: !ansatt.har_fnr,
    fjernFnr: false,
    kontonr: visKontonr(ansatt.kontonr),
    stilling: ansatt.stilling ?? "",
    stillingsprosent: tekstTall(ansatt.stillingsprosent ?? 100),
    ukentlig_arbeidstid: tekstTall(ansatt.ukentlig_arbeidstid ?? 37.5),
    ansatt_fra: ansatt.ansatt_fra ?? iDag(),
    ansatt_til: ansatt.ansatt_til ?? "",
    ansettelsestype: ansatt.ansettelsestype ?? "fast",
    lonnstype: ansatt.lonnstype ?? "maaned",
    maanedslonn: tekstTall(ansatt.maanedslonn),
    timelonn: tekstTall(ansatt.timelonn),
    aktiv: ansatt.aktiv ?? true,
    notat: ansatt.notat ?? "",
    gruppe_id: ansatt.gruppe_id ?? "",
    kunde_id: ansatt.kunde_id ?? "",
    bursdag_varsel: ansatt.bursdag_varsel ?? true,
    ferie_dager: tekstTall(ansatt.ferie_dager),
    skattekort: (ansatt.skattekort ?? "") as "" | "tabell" | "prosent" | "frikort",
    skatt_tabell: ansatt.skatt_tabell != null ? String(ansatt.skatt_tabell) : "",
    skatt_prosent: tekstTall(ansatt.skatt_prosent),
    skatt_frikort: tekstTall(ansatt.skatt_frikort),
    skattekort_aar: String(ansatt.skattekort_aar ?? iDag().slice(0, 4)),
    biarbeidsgiver: ansatt.biarbeidsgiver ?? false,
    yrkeskode: ansatt.yrkeskode ?? "",
    arbeidsforhold_type: ansatt.arbeidsforhold_type ?? "ordinaertArbeidsforhold",
    arbeidstidsordning: ansatt.arbeidstidsordning ?? "ikkeSkift",
    aarsak_sluttdato: ansatt.aarsak_sluttdato ?? "",
    // Lønns- og stillingsendringer (Lonnsendringer.tsx): datoen endringen gjelder fra, og grunnen.
    lonn_gjelder_fra: "",
    lonn_grunn: "",
  }));
  // Lønnen og stillingen som er lagret (det som gjelder i dag); en endring får en dato.
  const [lagretLonn, settLagretLonn] = useState<GjeldendeLonn>(() => ({
    lonnstype: ansatt.lonnstype ?? "maaned",
    maanedslonn: ansatt.maanedslonn ?? null,
    timelonn: ansatt.timelonn ?? null,
    stillingsprosent: ansatt.stillingsprosent ?? 100,
  }));
  // Bursdagsvarsler (Innstillinger → Ansatte og timer): da kan den ansatte unntas.
  const oppsett = useData(() => hent<{ bursdag_varsel: string; full_stilling: number; ferie_dager: number }>(`/org/${org!.id}/lonn-oppsett`), [org?.id]);
  const bursdager = !!oppsett.data && oppsett.data.bursdag_varsel !== "av";
  // En ny ansatt får organisasjonens arbeidstid i full stilling (Innstillinger → Ansatte og timer).
  const fullStilling = Number(oppsett.data?.full_stilling ?? 37.5);
  // Rollene (f.eks. lege og sekretær, Roller.tsx); en ny kan lages rett herfra (nyRolle) når
  // personen lagres. Med vaktplanen (funksjonene i Administrasjon) også den faste arbeidsplanen
  // (ukedagene personen jobber), som et utkast til den lagres.
  const vaktplan = harFunksjon(org, "vaktplan");
  // Med lønn (funksjonen «Lønn»): skattekortet og tallene fra et tidligere lønnssystem.
  const medLonn = harFunksjon(org, "lonn");
  const roller = useData(() => hent<Rolle[]>(`/org/${org!.id}/ansattgrupper`), [org?.id]);
  const [nyRolle, settNyRolle] = useState<{ navn: string; ikke_ansatt: boolean } | null>(null);
  const planer = useData(
    () => (ansatt.id && vaktplan ? hent<Plan[]>(`/org/${org!.id}/ansatte/${ansatt.id}/arbeidsplan`) : Promise.resolve([] as Plan[])),
    [org?.id, ansatt.id],
  );
  const [plan, settPlan] = useState<PlanUtkast | null>(null);
  useEffect(() => {
    if (planer.data) settPlan(lagUtkast(planer.data, ansatt.ansatt_fra));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planer.data]);
  const [forlatt, settForlatt] = useState<Record<string, boolean>>({});
  const [melding, settMelding] = useState<string | null>(null);
  useEffect(() => {
    if (!ansatt.id && oppsett.data && !forlatt.ukentlig_arbeidstid) settA((x) => ({ ...x, ukentlig_arbeidstid: tekstTall(Number(oppsett.data!.full_stilling ?? 37.5)) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [oppsett.data]);
  // Fravær og ferie registreres i en egen dialog utenfor skjemaet (FravaerDialog har sitt eget).
  const [fravaer, settFravaer] = useState<Partial<Fravaer> | null>(null);
  const [fravaerVersjon, settFravaerVersjon] = useState(0);
  const h = useHandling();
  // Lønnsslipp (PDF eller bilde) lest med AI: fyller ut skjemaet, som brukeren ser over og lagrer.
  const orgData = useData(() => (kanEndre ? hent<{ ai_tilgjengelig: boolean; ai_aktiv: boolean }>(`/org/${org!.id}`) : Promise.resolve(null)), [org?.id]);
  const aiPaa = kanEndre && harFunksjon(org, "ai") && Boolean(orgData.data?.ai_tilgjengelig && orgData.data?.ai_aktiv);
  const slippFelt = useRef<HTMLInputElement>(null);
  const [leserSlipp, settLeserSlipp] = useState(false);
  const [slippMerknader, settSlippMerknader] = useState<string[]>([]);
  async function fraLonnsslipp(fil: File) {
    settLeserSlipp(true);
    settMelding(null);
    settSlippMerknader([]);
    h.settFeil(null);
    try {
      const s = await sendFil<Lonnsslipper>(`/org/${org!.id}/ai/lonnsslipp`, slippBlob(fil), "Fila er for stor. En lønnsslipp kan være høyst 12 MB.");
      // Flere slipper i fila: den med samme navn som i skjemaet, ellers den første.
      const navn = (x: Record<string, unknown>) => `${x.fornavn ?? ""} ${x.etternavn ?? ""}`.trim().toLowerCase();
      const x = (s.ansatte.find((y) => navn(y) === `${a.fornavn} ${a.etternavn}`.trim().toLowerCase()) ?? s.ansatte[0]) as Record<string, any>;
      const ny: Partial<typeof a> = {};
      const fylt: string[] = [];
      const tekstfelt = (felt: "fornavn" | "etternavn" | "adresse" | "postnr" | "poststed" | "stilling" | "ansatt_fra", navn: string) => {
        if (typeof x[felt] === "string" && x[felt]) {
          ny[felt] = x[felt];
          if (!fylt.includes(navn)) fylt.push(navn);
        }
      };
      tekstfelt("fornavn", "navn");
      tekstfelt("etternavn", "navn");
      tekstfelt("adresse", "adresse");
      tekstfelt("postnr", "adresse");
      tekstfelt("poststed", "adresse");
      if (x.fnr) {
        Object.assign(ny, { fnr: x.fnr, endreFnr: true, fjernFnr: false, fodselsdato: fodselsdato(x.fnr) ?? a.fodselsdato });
        fylt.push("fødselsnummer");
      } else if (x.fodselsdato) {
        ny.fodselsdato = x.fodselsdato;
        fylt.push("fødselsdato");
      }
      if (x.kontonr) {
        ny.kontonr = visKontonr(x.kontonr);
        fylt.push("kontonummer");
      }
      tekstfelt("stilling", "stilling");
      if (typeof x.stillingsprosent === "number") {
        ny.stillingsprosent = tekstTall(x.stillingsprosent);
        fylt.push("stillingsprosent");
      }
      tekstfelt("ansatt_fra", "ansatt fra");
      if (x.lonnstype) ny.lonnstype = x.lonnstype;
      if (typeof x.maanedslonn === "number") ny.maanedslonn = tekstTall(x.maanedslonn);
      if (typeof x.timelonn === "number") ny.timelonn = tekstTall(x.timelonn);
      if (x.lonnstype || x.maanedslonn != null || x.timelonn != null) fylt.push("lønn");
      if (typeof x.notat === "string" && x.notat && !a.notat.includes(x.notat)) {
        ny.notat = a.notat.trim() ? `${a.notat.trim()}\n${x.notat}` : x.notat;
        fylt.push("notat (andre opplysninger)");
      }
      // Faste tillegg: et med samme navn får beløpet fra slippen, de andre legges til.
      const fraSlipp = (Array.isArray(x.tillegg) ? x.tillegg : []) as { navn: string; belop: number; per: "maaned" | "time" }[];
      if (fraSlipp.length) {
        settTillegg((l) => {
          const liste = [...l];
          for (const t of fraSlipp) {
            const i = liste.findIndex((y) => y.navn.trim().toLowerCase() === t.navn.toLowerCase());
            if (i >= 0) liste[i] = { ...liste[i]!, belop: tekstTall(t.belop), per: t.per };
            else liste.push({ navn: t.navn, belop: tekstTall(t.belop), per: t.per, fra: "", til: "" });
          }
          return liste;
        });
        fylt.push(fraSlipp.length === 1 ? "1 fast tillegg" : `${fraSlipp.length} faste tillegg`);
      }
      settA((gammel) => ({ ...gammel, ...ny }));
      settMelding(fylt.length ? `Fylt ut fra lønnsslippen: ${fylt.join(", ")}. Sjekk feltene, og trykk Lagre.` : "Fant ingen opplysninger å fylle ut i lønnsslippen.");
      // Merknader om de andre i fila (f.eks. et kontonummer som ikke stemmer) gjelder ikke her.
      const valgt = `${x.fornavn ?? ""} ${x.etternavn ?? ""}`.trim();
      const andre = s.ansatte.map((y) => `${y.fornavn ?? ""} ${y.etternavn ?? ""}`.trim()).filter((n) => n && n !== valgt);
      settSlippMerknader([
        ...(s.ansatte.length > 1
          ? [`Fila hadde ${s.ansatte.length} lønnsslipper. Opplysningene til ${valgt} er brukt; bruk Importer på Ansatte-siden for å legge inn alle.`]
          : []),
        ...s.merknader.filter((m) => m.includes(valgt) || !andre.some((n) => m.includes(n))),
      ]);
    } catch (e) {
      h.settFeil((e as Error).message);
    } finally {
      settLeserSlipp(false);
    }
  }
  const sett = (e: Partial<typeof a>) => settA({ ...a, ...e });
  const felt = (navn: keyof typeof a) => ({
    value: String(a[navn] ?? ""),
    onChange: (e: { target: { value: string } }) => sett({ [navn]: e.target.value } as Partial<typeof a>),
    onBlur: () => settForlatt((f) => ({ ...f, [navn]: true })),
  });

  const fnr = a.fnr.replace(/[\s.]/g, "");
  const fnrFeil = a.endreFnr && fnr && forlatt.fnr && !fnrGyldig(fnr) ? "Fødselsnummeret er ikke gyldig (sjekk sifrene)" : null;
  const kontonr = a.kontonr.replace(/[\s.]/g, "");
  const kontonrFeil = kontonr && forlatt.kontonr && !kontonrGyldig(kontonr) ? "Kontonummeret er ikke gyldig (sjekk sifrene)" : null;
  const maaned = a.lonnstype === "maaned" && a.maanedslonn ? tall(a.maanedslonn) : null;
  // Er lønnen eller stillingen endret på en ansatt som finnes: datoen endringen gjelder fra (som
  // standard i dag, eller fra datoen en ny arbeidsplan gjelder fra).
  const tallEllerNull = (x: string) => (x.trim() ? tall(x) : null);
  const lonnEndret =
    !!ansatt.id &&
    (a.lonnstype !== lagretLonn.lonnstype ||
      (a.lonnstype === "maaned" && tallEllerNull(a.maanedslonn) !== lagretLonn.maanedslonn) ||
      (a.lonnstype === "time" && tallEllerNull(a.timelonn) !== lagretLonn.timelonn) ||
      (!!a.stillingsprosent.trim() && tall(a.stillingsprosent) !== Number(lagretLonn.stillingsprosent)));
  const lonnDato = a.lonn_gjelder_fra || (plan && endret(plan) ? plan.gjelder_fra : iDag());
  // Lønnshistorikken endret: feltene i skjemaet følger det som gjelder i dag.
  const fraHistorikken = (x: GjeldendeLonn) => {
    settLagretLonn(x);
    settA((f) => ({ ...f, lonnstype: x.lonnstype, maanedslonn: tekstTall(x.maanedslonn), timelonn: tekstTall(x.timelonn), stillingsprosent: tekstTall(x.stillingsprosent) }));
    oppdatert({ ...ansatt, ...x } as Ansatt);
  };
  const endringsdato = lonnEndret && (
    <div className="lonn-endringsdato">
      <div className="rad">
        <label>
          Endringen gjelder fra
          <input type="date" required min={a.ansatt_fra} value={lonnDato} onChange={(e) => sett({ lonn_gjelder_fra: e.target.value })} />
        </label>
        <label>
          Grunn
          <input maxLength={300} placeholder="F.eks. lønnsoppgjør" {...felt("lonn_grunn")} />
        </label>
      </div>
      <span className="felt-hjelp">
        {lonnDato < iDag()
          ? "Tilbake i tid: neste lønnskjøring etterbetaler (eller trekker) for månedene som er godkjent."
          : lonnDato > iDag()
            ? "Fram i tid: lønnen og stillingen endres den dagen, og lønnskjøringen deler måneden."
            : "Lønnshistorikken får endringen fra i dag."}
      </span>
    </div>
  );
  // De med en rolle for dem som ikke er ansatt, har ikke lønn, feriebank eller fødselsnummer til
  // a-meldingen her. Før rollene er hentet: det som er lagret.
  const valgtRolle = roller.data?.find((g) => g.id === a.gruppe_id);
  const arbeidstaker = nyRolle
    ? !nyRolle.ikke_ansatt
    : valgtRolle
      ? !valgtRolle.ikke_ansatt
      : !(a.gruppe_id && a.gruppe_id === (ansatt.gruppe_id ?? "") && ansatt.arbeidstaker === false);
  const rollenavn = nyRolle?.navn.trim() || valgtRolle?.navn;
  const rolleHjelp =
    (!arbeidstaker
      ? `${rollenavn ? `«${rollenavn}»` : "Rollen"} er for dem som ikke er ansatt: ${IKKE_ANSATT_HJELP}.`
      : vaktplan
        ? "F.eks. lege eller sekretær. Vaktplanen viser hvor mange med hver rolle som er på jobb, mot behovet."
        : "F.eks. lege eller sekretær.") + (vaktplan && !nyRolle && valgtRolle?.tavle === false ? " Rollen er ikke med på tavla." : "");

  async function lagre(e: FormEvent) {
    e.preventDefault();
    settMelding(null);
    const kropp: Record<string, unknown> = {
      fornavn: a.fornavn,
      etternavn: a.etternavn,
      epost: a.epost,
      telefon: a.telefon,
      adresse: a.adresse,
      postnr: a.postnr,
      poststed: a.poststed,
      kontonr: a.kontonr,
      stilling: a.stilling,
      ansatt_fra: a.ansatt_fra,
      ansatt_til: a.ansatt_til,
      ansettelsestype: a.ansettelsestype,
      lonnstype: a.lonnstype,
      maanedslonn: a.lonnstype === "maaned" ? tallEllerNull(a.maanedslonn) : null,
      timelonn: a.lonnstype === "time" ? tallEllerNull(a.timelonn) : null,
      notat: a.notat,
      aktiv: a.aktiv,
    };
    if (bursdager) kropp.bursdag_varsel = a.bursdag_varsel;
    // Forkortelsen sendes når den er endret (tom: lages av initialene).
    const fork = a.forkortelse.trim().toUpperCase();
    if (fork !== (ansatt.forkortelse ?? "")) kropp.forkortelse = fork || null;
    if (roller.data?.length) kropp.gruppe_id = a.gruppe_id || null;
    if (a.kunde_id !== (ansatt.kunde_id ?? "")) kropp.kunde_id = a.kunde_id || null;
    const nyttNavn = nyRolle?.navn.trim() ?? "";
    if (nyRolle && !nyttNavn) return h.settFeil("Skriv navnet på den nye rollen, eller velg en annen.");
    if (a.stillingsprosent.trim()) kropp.stillingsprosent = tall(a.stillingsprosent);
    if (lonnEndret) {
      kropp.lonn_gjelder_fra = lonnDato;
      if (a.lonn_grunn.trim()) kropp.lonn_grunn = a.lonn_grunn.trim();
    }
    if (a.ukentlig_arbeidstid.trim()) kropp.ukentlig_arbeidstid = tall(a.ukentlig_arbeidstid);
    if (vaktplan) kropp.ferie_dager = a.ferie_dager.trim() ? tall(a.ferie_dager) : null;
    // Skattekortet (med lønn): bare feltene som hører til typen.
    if (medLonn && arbeidstaker) {
      const k = a.skattekort;
      if (k === "tabell" && (!a.skatt_tabell.trim() || !a.skatt_prosent.trim())) return h.settFeil("Skriv tabellnummeret og prosentsatsen fra skattekortet.");
      if (k === "prosent" && !a.skatt_prosent.trim()) return h.settFeil("Skriv prosentsatsen fra skattekortet.");
      kropp.skattekort = k || null;
      kropp.skatt_tabell = k === "tabell" ? Number(a.skatt_tabell.trim()) : null;
      kropp.skatt_prosent = k === "tabell" || k === "prosent" ? tall(a.skatt_prosent) : null;
      // Frikort uten beløp: uten beløpsgrense (ingen trekk).
      kropp.skatt_frikort = k === "frikort" && a.skatt_frikort.trim() ? tall(a.skatt_frikort) : null;
      kropp.skattekort_aar = k && a.skattekort_aar.trim() ? Number(a.skattekort_aar) : null;
      kropp.biarbeidsgiver = a.biarbeidsgiver;
      // Arbeidsforholdet i a-meldingen.
      kropp.yrkeskode = a.yrkeskode.replace(/\s/g, "") || null;
      kropp.arbeidsforhold_type = a.arbeidsforhold_type;
      kropp.arbeidstidsordning = a.arbeidstidsordning;
      kropp.aarsak_sluttdato = a.ansatt_til && a.aarsak_sluttdato ? a.aarsak_sluttdato : null;
    }
    // Fødselsnummeret sendes bare når det er skrevet inn eller skal fjernes; ellers fødselsdatoen.
    if (a.fjernFnr) kropp.fnr = null;
    else if (a.endreFnr && fnr) kropp.fnr = fnr;
    if (!kropp.fnr) kropp.fodselsdato = a.fodselsdato;
    // De faste tilleggene sendes når de er endret (hele listen; de som er fjernet, slettes).
    const brukte = tillegg.filter((t) => t.navn.trim() || t.belop.trim());
    if (brukte.some((t) => !t.navn.trim() || !t.belop.trim())) return h.settFeil("Fyll ut navn og beløp på de faste tilleggene, eller fjern dem.");
    if (JSON.stringify(tillegg) !== lagretTillegg)
      kropp.tillegg = brukte.map((t) => ({ ...(t.id ? { id: t.id } : {}), navn: t.navn.trim(), belop: tall(t.belop), per: t.per, fra: t.fra || null, til: t.til || null }));
    const ny = !ansatt.id;
    const nyPlan = plan && endret(plan) ? tilLagring(plan) : null;
    if (typeof nyPlan === "string") return h.settFeil(nyPlan);
    const r = await h.kjor(async () => {
      // Den nye rollen lages først (en med samme navn brukes heller, om den finnes).
      if (nyRolle && nyttNavn) {
        const finnes = roller.data?.find((g) => g.navn.trim().toLowerCase() === nyttNavn.toLowerCase());
        const rolle = finnes?.id ?? (await api<{ id: string }>("POST", `/org/${org!.id}/ansattgrupper`, { navn: nyttNavn, ikke_ansatt: nyRolle.ikke_ansatt })).id;
        kropp.gruppe_id = rolle;
        settNyRolle(null);
        settA((x) => ({ ...x, gruppe_id: rolle }));
        void roller.last();
      }
      const lagret = await (ny ? api<Ansatt>("POST", `/org/${org!.id}/ansatte`, kropp) : api<Ansatt>("PATCH", `/org/${org!.id}/ansatte/${ansatt.id}`, kropp));
      // Planen for en ny ansatt gjelder fra den ansatte begynner.
      if (nyPlan) {
        const p = await api<Plan[]>("PUT", `/org/${org!.id}/ansatte/${lagret.id}/arbeidsplan`, { ...nyPlan, gjelder_fra: ny ? lagret.ansatt_fra : nyPlan.gjelder_fra });
        settPlan(lagUtkast(p, lagret.ansatt_fra));
        return { ...lagret, arbeidsdager: p.findLast((x) => x.gjelder_fra <= iDag())?.dager.map((d) => d.ukedag) ?? [] };
      }
      return lagret;
    });
    if (!r) return;
    if (!ny) return lukk();
    // Ny ansatt: bli i skjemaet, så man kan gi innlogging med en gang.
    settA({ ...a, fnr: "", endreFnr: !r.har_fnr, fjernFnr: false, fodselsdato: r.fodselsdato ?? "", gruppe_id: r.gruppe_id ?? "" });
    settTillegg(tilUtkast(r.tillegg));
    settLagretTillegg(JSON.stringify(tilUtkast(r.tillegg)));
    settMelding(erAnsatt(r) ? `${r.fornavn} er lagt inn som ansatt nr. ${r.ansattnummer}.` : `${r.fornavn} er lagt inn (nr. ${r.ansattnummer}).`);
    oppdatert(r);
  }

  async function slett() {
    if (!confirm(`Slette ${ansatt.fornavn} ${ansatt.etternavn}? Det går bare for ansatte uten timer. Har den ansatte sluttet, setter du en sluttdato i stedet.`)) return;
    const r = await h.kjor(async () => (await api("DELETE", `/org/${org!.id}/ansatte/${ansatt.id}`), true));
    if (r) lukk();
  }

  return (
    <>
    <form onSubmit={lagre}>
      {aiPaa && arbeidstaker && (
        <div className="fra-slipp">
          <button type="button" disabled={leserSlipp || h.opptatt} onClick={() => slippFelt.current?.click()}>
            {leserSlipp ? <span className="spinner" /> : <IkonGnist storrelse={16} />} {leserSlipp ? "Leser lønnsslippen …" : "Fyll ut fra lønnsslipp"}
          </button>
          <span className="liten dempet">PDF eller bilde. AI leser opplysningene, og du ser over dem før du lagrer.</span>
          <input
            ref={slippFelt}
            type="file"
            hidden
            accept={SLIPP_ACCEPT}
            onChange={(e) => {
              const fil = e.target.files?.[0];
              e.target.value = "";
              if (fil) void fraLonnsslipp(fil);
            }}
          />
        </div>
      )}
      {melding && (
        <div className="melding ok" role="status">
          {melding}
        </div>
      )}
      {slippMerknader.length > 0 && (
        <div className="melding info">
          {slippMerknader.map((m) => (
            <div key={m}>{m}</div>
          ))}
        </div>
      )}
      <fieldset className="naken" disabled={!kanEndre}>
        <div className="rad navn-rad">
          <label>
            Fornavn
            <input required autoComplete="off" {...felt("fornavn")} />
          </label>
          <label>
            Etternavn
            <input required autoComplete="off" {...felt("etternavn")} />
          </label>
          <label title="Vises i vaktplanen der plassen er trang. Tom: lages av initialene.">
            Forkortelse
            <input
              autoComplete="off"
              maxLength={6}
              placeholder={(a.fornavn.trim().charAt(0) + a.etternavn.trim().charAt(0)).toUpperCase() || "AB"}
              {...felt("forkortelse")}
            />
          </label>
        </div>
        <div className="rad">
          <label>
            E-post
            <input type="email" autoComplete="off" {...felt("epost")} />
            <span className="felt-hjelp">{arbeidstaker ? "Til innloggingen og lønnsslippene." : "Til innloggingen."}</span>
          </label>
          <label>
            Telefon
            <input type="tel" autoComplete="off" {...felt("telefon")} />
          </label>
        </div>
        <label>
          Adresse
          <input autoComplete="off" {...felt("adresse")} />
        </label>
        <div className="rad">
          <label>
            Postnr.
            <input inputMode="numeric" maxLength={4} autoComplete="off" {...felt("postnr")} />
          </label>
          <label>
            Poststed
            <input autoComplete="off" {...felt("poststed")} />
          </label>
        </div>
        <div className="rad">
          {!arbeidstaker ? null : a.endreFnr ? (
            <label>
              Fødselsnummer
              <input
                inputMode="numeric"
                autoComplete="off"
                spellCheck={false}
                maxLength={13}
                placeholder={ansatt.har_fnr ? "Nytt fødselsnummer" : "11 siffer (eller D-nummer)"}
                aria-invalid={!!fnrFeil || undefined}
                value={a.fnr}
                onChange={(e) => {
                  const ren = e.target.value.replace(/[\s.]/g, "");
                  const fodt = fnrGyldig(ren) ? fodselsdato(ren) : null;
                  sett({ fnr: e.target.value, ...(fodt ? { fodselsdato: fodt } : {}) });
                }}
                onBlur={() => settForlatt((f) => ({ ...f, fnr: true }))}
              />
              {fnrFeil ? <span className="felt-feil">{fnrFeil}</span> : <span className="felt-hjelp">Lagres kryptert og vises ikke igjen. Trengs til a-meldingen.</span>}
            </label>
          ) : (
            <div className="felt">
              Fødselsnummer
              <div className="felt-verdi">
                <span>{a.fjernFnr ? "Fjernes når du lagrer" : "Registrert"}</span>
                {kanEndre && !a.fjernFnr && (
                  <span className="knapper">
                    <button type="button" className="lenke" onClick={() => sett({ endreFnr: true })}>
                      Endre
                    </button>
                    <button type="button" className="lenke fare" onClick={() => sett({ fjernFnr: true })}>
                      Fjern
                    </button>
                  </span>
                )}
                {a.fjernFnr && (
                  <button type="button" className="lenke" onClick={() => sett({ fjernFnr: false })}>
                    Angre
                  </button>
                )}
              </div>
              <span className="felt-hjelp">Lagres kryptert og vises aldri.</span>
            </div>
          )}
          <label>
            Fødselsdato
            {/* Med fødselsnummer følger datoen av det. */}
            <input type="date" max={iDag()} {...felt("fodselsdato")} disabled={!kanEndre || (a.endreFnr ? fnrGyldig(fnr) : !a.fjernFnr)} />
          </label>
        </div>
        {bursdager && (
          <label>
            <input type="checkbox" checked={a.bursdag_varsel} disabled={!kanEndre} onChange={(e) => sett({ bursdag_varsel: e.target.checked })} />
            Varsle de andre på bursdagen
          </label>
        )}
        {arbeidstaker && (
          <label>
            Kontonummer for lønn
            <input inputMode="numeric" autoComplete="off" spellCheck={false} aria-invalid={!!kontonrFeil || undefined} placeholder="1234 56 78903" {...felt("kontonr")} />
            {kontonrFeil && <span className="felt-feil">{kontonrFeil}</span>}
          </label>
        )}

        <h3>{arbeidstaker ? "Rolle og ansettelse" : "Rolle og stilling"}</h3>
        {(!!roller.data?.length || kanEndre) && (
          <div className="rad">
            <label className="hel">
              Rolle
              <select
                value={nyRolle ? NY_ROLLE : a.gruppe_id}
                onChange={(e) => {
                  if (e.target.value === NY_ROLLE) settNyRolle({ navn: "", ikke_ansatt: false });
                  else {
                    settNyRolle(null);
                    sett({ gruppe_id: e.target.value });
                  }
                }}
              >
                <option value="">Ingen rolle</option>
                {(roller.data ?? []).map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.navn}
                    {g.ikke_ansatt ? " (ikke ansatt)" : ""}
                  </option>
                ))}
                {kanEndre && <option value={NY_ROLLE}>+ Ny rolle …</option>}
              </select>
              <span className="felt-hjelp">{rolleHjelp}</span>
              {/* Hentet inn fra en kunde (Roller → Hent fra kunder); navnet bare for dem som ser kundene. */}
              {ansatt.kunde_id && (
                <span className="felt-hjelp">
                  {a.kunde_id ? (
                    <>
                      Hentet inn fra kunden{" "}
                      {ansatt.kunde ? <Link to={`/kunder?sok=${encodeURIComponent(ansatt.kunde)}`}>{ansatt.kunde}</Link> : "i kunderegisteret"}.
                      {kanEndre && (
                        <>
                          {" "}
                          <button type="button" className="lenke" onClick={() => sett({ kunde_id: "" })}>
                            Fjern koblingen
                          </button>
                        </>
                      )}
                    </>
                  ) : (
                    <>
                      Koblingen til kunden fjernes når du lagrer.{" "}
                      <button type="button" className="lenke" onClick={() => sett({ kunde_id: ansatt.kunde_id ?? "" })}>
                        Angre
                      </button>
                    </>
                  )}
                </span>
              )}
            </label>
            {nyRolle && (
              <>
                <label className="hel">
                  Navn på den nye rollen
                  <input value={nyRolle.navn} maxLength={40} placeholder="F.eks. Lege" autoFocus onChange={(e) => settNyRolle({ ...nyRolle, navn: e.target.value })} />
                  <span className="felt-hjelp">Lages når du lagrer.{vaktplan ? " Hvor mange som trengs per dag, setter du under Roller." : ""}</span>
                </label>
                <label className="hel">
                  <input type="checkbox" checked={nyRolle.ikke_ansatt} onChange={(e) => settNyRolle({ ...nyRolle, ikke_ansatt: e.target.checked })} /> De med rollen er ikke ansatt (f.eks.
                  leger som er aksjonærer eller selvstendige)
                </label>
              </>
            )}
          </div>
        )}
        <div className="rad">
          <label className={arbeidstaker ? undefined : "hel"}>
            Stilling
            <input placeholder="F.eks. butikkmedarbeider eller lege" {...felt("stilling")} />
          </label>
          {arbeidstaker && (
            <label>
              Ansettelse
              <select {...felt("ansettelsestype")}>
                {Object.entries(ansettelsestype).map(([v, t]) => (
                  <option key={v} value={v}>
                    {t}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        <div className="rad">
          <label>
            Stillingsprosent
            <input inputMode="decimal" {...felt("stillingsprosent")} />
            {vaktplan && <span className="felt-hjelp">Følger de faste arbeidsdagene, og kan endres.</span>}
          </label>
          <label>
            Arbeidstid i full stilling
            <input inputMode="decimal" {...felt("ukentlig_arbeidstid")} />
            <span className="felt-hjelp">Timer per uke. Standarden ({tallformat.format(fullStilling)}) står under Innstillinger → Ansatte og timer.</span>
          </label>
        </div>
        {!arbeidstaker && endringsdato}
      </fieldset>
      {!vaktplan ? null : plan ? (
        <ArbeidsplanFelt
          utkast={plan}
          endre={settPlan}
          ukentlig={a.ukentlig_arbeidstid.trim() ? tall(a.ukentlig_arbeidstid) : fullStilling}
          prosent={a.stillingsprosent.trim() ? tall(a.stillingsprosent) : 100}
          settProsent={(p) => sett({ stillingsprosent: tekstTall(p) })}
          ny={!ansatt.id}
          kanEndre={kanEndre}
        />
      ) : (
        planer.feil && <Feil melding={planer.feil} />
      )}
      <fieldset className="naken" disabled={!kanEndre}>
        <div className="rad">
          <label>
            {arbeidstaker ? "Ansatt fra" : "Jobber her fra"}
            <input type="date" required {...felt("ansatt_fra")} />
          </label>
          <label>
            {arbeidstaker ? "Sluttdato" : "Til"}
            <input type="date" min={a.ansatt_fra} {...felt("ansatt_til")} />
            <span className="felt-hjelp">{arbeidstaker ? "Tom hvis den ansatte fortsatt jobber her." : "Tom hvis personen fortsatt jobber her."}</span>
          </label>
        </div>
        {vaktplan && arbeidstaker && (
          <label>
            Feriedager per år
            <input inputMode="decimal" placeholder={`Organisasjonens (${tallformat.format(Number(oppsett.data?.ferie_dager ?? 25))} med fem dager i uka)`} {...felt("ferie_dager")} />
            <span className="felt-hjelp">
              Tom: organisasjonens feriedager, regnet om etter dagene den ansatte jobber, med en uke ekstra fra året den ansatte fyller 60. Fyll inn for en egen avtale.
            </span>
          </label>
        )}

        {arbeidstaker && (
          <>
          <h3>Lønn</h3>
          <div className="rad">
            <label>
              Lønnstype
              <select {...felt("lonnstype")}>
                <option value="maaned">Fast månedslønn</option>
                <option value="time">Timelønn</option>
              </select>
            </label>
            {a.lonnstype === "maaned" ? (
              <label>
                Månedslønn (kr)
                <input inputMode="decimal" {...felt("maanedslonn")} />
                {maaned != null && Number.isFinite(maaned) && <span className="felt-hjelp">{belop.format(maaned * 12)} kr i året</span>}
              </label>
            ) : (
              <label>
                Timelønn (kr)
                <input inputMode="decimal" {...felt("timelonn")} />
              </label>
            )}
          </div>
          {endringsdato}
          <h3>Faste tillegg</h3>
          <p className="felt-hjelp tillegg-hjelp">
            Betales fast i tillegg til lønnen, f.eks. funksjonstillegg per måned eller fagbrevtillegg per time. Uten datoer gjelder tillegget til det fjernes.
          </p>
          {tillegg.map((t, i) => (
            <div key={i} className="tillegg-rad">
              <label>
                Navn
                <input value={t.navn} placeholder="F.eks. funksjonstillegg" maxLength={100} onChange={(e) => endreTillegg(i, { navn: e.target.value })} />
              </label>
              <label>
                Beløp (kr)
                <input inputMode="decimal" value={t.belop} onChange={(e) => endreTillegg(i, { belop: e.target.value })} />
              </label>
              <label>
                Per
                <select value={t.per} onChange={(e) => endreTillegg(i, { per: e.target.value as TilleggUtkast["per"] })}>
                  <option value="maaned">måned</option>
                  <option value="time">time</option>
                </select>
              </label>
              <label>
                Fra og med
                <input type="date" value={t.fra} onChange={(e) => endreTillegg(i, { fra: e.target.value })} />
              </label>
              <label>
                Til og med
                <input type="date" value={t.til} min={t.fra || undefined} onChange={(e) => endreTillegg(i, { til: e.target.value })} />
              </label>
              {kanEndre && (
                <button type="button" className="ikon" aria-label={`Fjern ${t.navn || "tillegget"}`} title="Fjern tillegget" onClick={() => settTillegg((l) => l.filter((_, j) => j !== i))}>
                  <IkonLukk storrelse={16} />
                </button>
              )}
            </div>
          ))}
          {kanEndre ? (
            <button type="button" className="lenke legg-til-tillegg" onClick={() => settTillegg((l) => [...l, { navn: "", belop: "", per: "maaned", fra: "", til: "" }])}>
              + Legg til fast tillegg
            </button>
          ) : (
            !tillegg.length && <p className="dempet liten">Ingen faste tillegg.</p>
          )}
          {medLonn && (
            <>
              <h3>Skattekort</h3>
              <div className="rad">
                <label>
                  Skattetrekk
                  <select {...felt("skattekort")}>
                    <option value="">Ikke registrert (50 % trekk)</option>
                    <option value="tabell">Tabelltrekk</option>
                    <option value="prosent">Prosenttrekk</option>
                    <option value="frikort">Frikort</option>
                  </select>
                </label>
                {a.skattekort === "tabell" && (
                  <label>
                    Tabellnummer
                    <input inputMode="numeric" maxLength={4} placeholder="F.eks. 7100" {...felt("skatt_tabell")} />
                  </label>
                )}
                {(a.skattekort === "tabell" || a.skattekort === "prosent") && (
                  <label>
                    Prosentsats (%)
                    <input inputMode="decimal" {...felt("skatt_prosent")} />
                  </label>
                )}
                {a.skattekort === "frikort" && (
                  <label>
                    Frikortbeløp (kr)
                    <input inputMode="decimal" placeholder="Uten grense" {...felt("skatt_frikort")} />
                  </label>
                )}
                {a.skattekort && (
                  <label>
                    For året
                    <input inputMode="numeric" maxLength={4} {...felt("skattekort_aar")} />
                  </label>
                )}
              </div>
              <label>
                <input type="checkbox" checked={a.biarbeidsgiver} disabled={!kanEndre} onChange={(e) => sett({ biarbeidsgiver: e.target.checked })} />
                Biarbeidsgiver (den ansatte har hovedarbeidsgiveren et annet sted)
              </label>
              <p className="felt-hjelp tillegg-hjelp">
                {a.skattekort === "tabell"
                  ? "Lønnen trekkes etter tabellen; prosentsatsen brukes i ekstra kjøringer og på feriepengene for den ekstra ferieuka."
                  : a.skattekort === "frikort"
                    ? a.skatt_frikort.trim()
                      ? "Ingen trekk til frikortbeløpet er brukt opp i året; deretter 50 %."
                      : "Frikort uten beløpsgrense: ingen trekk."
                    : a.skattekort === "prosent"
                      ? "Prosentsatsen trekkes av all lønn."
                      : "Uten skattekort trekkes 50 %."}{" "}
                {ansatt.skattekort_kilde === "skatteetaten" || ansatt.skattekort_hentet
                  ? "Hentes fra Skatteetaten; som biarbeidsgiver brukes trekket for biarbeidsgiver."
                  : "Med koblingen til Skatteetaten (Innstillinger → Ansatte og timer) hentes skattekortet av seg selv når fødselsnummeret er registrert."}
              </p>
              {ansatt.id && <SkattekortFraSkatteetaten a={ansatt as Ansatt} />}
              <h3>A-melding</h3>
              <div className="rad">
                <label>
                  Yrkeskode
                  <input inputMode="numeric" maxLength={9} placeholder="7 siffer" {...felt("yrkeskode")} />
                  <span className="felt-hjelp">
                    SSBs yrkeskode (STYRK-08), 7 siffer.{" "}
                    <a href="https://www.ssb.no/klass/klassifikasjoner/7" target="_blank" rel="noreferrer">
                      Finn koden hos SSB
                    </a>
                  </span>
                </label>
                <label>
                  Arbeidstidsordning
                  <select {...felt("arbeidstidsordning")}>
                    {Object.entries(ARBEIDSTID).map(([v, t]) => (
                      <option key={v} value={v}>
                        {t}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="rad">
                <label>
                  Type arbeidsforhold
                  <select {...felt("arbeidsforhold_type")}>
                    {Object.entries(ARBEIDSFORHOLD).map(([v, t]) => (
                      <option key={v} value={v}>
                        {t}
                      </option>
                    ))}
                  </select>
                </label>
                {a.ansatt_til && (
                  <label>
                    Årsak til sluttdatoen
                    <select {...felt("aarsak_sluttdato")}>
                      <option value="">Velg årsak</option>
                      {Object.entries(SLUTTAARSAK).map(([v, t]) => (
                        <option key={v} value={v}>
                          {t}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
              </div>
            </>
          )}
          </>
        )}
        <label>
          Notat
          <textarea rows={2} {...felt("notat")} />
        </label>
        {ansatt.id && (
          <label>
            <input type="checkbox" checked={a.aktiv} onChange={(e) => sett({ aktiv: e.target.checked })} />
            Aktiv (kan føre timer)
          </label>
        )}
      </fieldset>
      {ansatt.id && vaktplan && <AnsattFravaer ansattId={ansatt.id} versjon={fravaerVersjon} kanEndre={kanEndre} apne={settFravaer} />}
      {ansatt.id && arbeidstaker && <Lonnsendringer ansattId={ansatt.id} ansattFra={ansatt.ansatt_fra ?? a.ansatt_fra} kanEndre={kanEndre} endret={fraHistorikken} />}
      {ansatt.id && medLonn && arbeidstaker && <LonnsTrekk ansattId={ansatt.id} kanEndre={kanEndre} />}
      {ansatt.id && medLonn && arbeidstaker && <TidligereLonn ansattId={ansatt.id} kanEndre={kanEndre} />}
      {ansatt.id && <Tilgang ansatt={ansatt as Ansatt} kanEndre={kanEndre} epostEndret={(a.epost.trim().toLowerCase() || null) !== (ansatt.epost ?? null)} oppdatert={oppdatert} />}
      <Feil melding={h.feil} />
      <div className="knapper">
        {kanEndre && (
          <button className="primar" disabled={h.opptatt}>
            Lagre
          </button>
        )}
        <button type="button" onClick={lukk}>
          {kanEndre ? (melding ? "Ferdig" : "Avbryt") : "Lukk"}
        </button>
        {ansatt.id && kanEndre && (
          <button type="button" className="fare" style={{ marginLeft: "auto" }} disabled={h.opptatt} onClick={slett}>
            Slett ansatt
          </button>
        )}
      </div>
    </form>
    {ansatt.id && (
      <FravaerDialog
        fravaer={fravaer}
        ansatte={[ansatt as Ansatt]}
        lukk={() => settFravaer(null)}
        ferdig={(m) => {
          settFravaer(null);
          settMelding(m);
          settFravaerVersjon((v) => v + 1);
        }}
      />
    )}
    </>
  );
}

// Tall fra et tidligere lønnssystem per år (0065_lonn.sql): feriepengegrunnlaget og
// feriepengene som er utbetalt for opptjeningsåret (feriepengene utbetales året etter), og
// trekkpliktig lønn og forskuddstrekk i året (frikortet og tallene hittil i år på lønnsslippen).
type Inngaende = { aar: number; feriepengegrunnlag: number; feriepenger_utbetalt: number; trekkpliktig: number; forskuddstrekk: number };
const INNGAENDE: [keyof Omit<Inngaende, "aar">, string][] = [
  ["feriepengegrunnlag", "Feriepengegrunnlag"],
  ["feriepenger_utbetalt", "Feriepenger utbetalt"],
  ["trekkpliktig", "Trekkpliktig lønn"],
  ["forskuddstrekk", "Forskuddstrekk"],
];
function TidligereLonn({ ansattId, kanEndre }: { ansattId: string; kanEndre: boolean }) {
  const { org } = useKonto();
  const liste = useData(() => hent<Inngaende[]>(`/org/${org!.id}/lonn/inngaende/${ansattId}`), [org?.id, ansattId]);
  const [skjema, settSkjema] = useState<Record<string, string> | null>(null);
  const h = useHandling();
  const ny = () => settSkjema({ aar: String(Number(iDag().slice(0, 4))), feriepengegrunnlag: "", feriepenger_utbetalt: "", trekkpliktig: "", forskuddstrekk: "" });
  const endre = (i: Inngaende) =>
    settSkjema({ aar: String(i.aar), ...Object.fromEntries(INNGAENDE.map(([k]) => [k, i[k] ? tekstTall(i[k]) : ""])) });
  async function lagre() {
    if (!skjema) return;
    const aar = Number(skjema.aar);
    if (!Number.isInteger(aar) || aar < 2000 || aar > 2100) return h.settFeil("Skriv året, f.eks. 2026");
    const kropp = Object.fromEntries(INNGAENDE.map(([k]) => [k, skjema[k]?.trim() ? tall(skjema[k]!) : 0]));
    if (Object.values(kropp).some((v) => !Number.isFinite(v) || v < 0)) return h.settFeil("Skriv beløpene med siffer, uten minus");
    const ok = await h.kjor(async () => (await api("PUT", `/org/${org!.id}/lonn/inngaende/${ansattId}/${aar}`, kropp), true));
    if (ok) {
      settSkjema(null);
      void liste.last();
    }
  }
  return (
    <details className="tidligere-lonn" open={!!liste.data?.length || !!skjema}>
      <summary>Fra tidligere lønnssystem</summary>
      <p className="felt-hjelp">
        Når lønnen er kjørt i et annet system før: feriepengegrunnlaget og feriepengene som er utbetalt for hvert opptjeningsår, og trekkpliktig lønn og forskuddstrekk i
        året (til frikortet og tallene hittil i år).
      </p>
      {liste.feil && <Feil melding={liste.feil} />}
      {!!liste.data?.length && (
        <div className="tabell">
          <table>
            <thead>
              <tr>
                <th>År</th>
                {INNGAENDE.map(([k, n]) => (
                  <th key={k} className="hoyre">
                    {n}
                  </th>
                ))}
                {kanEndre && <th aria-label="Handlinger" />}
              </tr>
            </thead>
            <tbody>
              {liste.data.map((i) => (
                <tr key={i.aar}>
                  <td>{i.aar}</td>
                  {INNGAENDE.map(([k]) => (
                    <td key={k} className="tall">
                      {belop.format(i[k])}
                    </td>
                  ))}
                  {kanEndre && (
                    <td className="hoyre">
                      <button type="button" className="lenke" onClick={() => endre(i)}>
                        Endre
                      </button>{" "}
                      <button
                        type="button"
                        className="lenke"
                        onClick={async () => {
                          if (!confirm(`Fjerne tallene for ${i.aar}?`)) return;
                          if (await h.kjor(async () => (await api("DELETE", `/org/${org!.id}/lonn/inngaende/${ansattId}/${i.aar}`), true))) void liste.last();
                        }}
                      >
                        Fjern
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {skjema ? (
        <div className="tidligere-skjema">
          <div className="rad">
            <label>
              År
              <input inputMode="numeric" maxLength={4} value={skjema.aar} onChange={(e) => settSkjema({ ...skjema, aar: e.target.value })} />
            </label>
            {INNGAENDE.map(([k, n]) => (
              <label key={k}>
                {n} (kr)
                <input inputMode="decimal" value={skjema[k]} onChange={(e) => settSkjema({ ...skjema, [k]: e.target.value })} />
              </label>
            ))}
          </div>
          <div className="knapper">
            <button type="button" className="primar" disabled={h.opptatt} onClick={lagre}>
              Lagre tallene
            </button>
            <button type="button" onClick={() => settSkjema(null)}>
              Avbryt
            </button>
          </div>
        </div>
      ) : (
        kanEndre && (
          <button type="button" className="lenke" onClick={ny}>
            + Legg til tall for et år
          </button>
        )
      )}
      <Feil melding={h.feil} />
    </details>
  );
}

// Egen innlogging: invitasjon på e-post med rollen ansatt (den ansatte ser bare sine egne timer).
function Tilgang({ ansatt: a, kanEndre, epostEndret, oppdatert }: { ansatt: Ansatt; kanEndre: boolean; epostEndret: boolean; oppdatert: (a: Ansatt) => void }) {
  const { org, oppdater } = useKonto();
  const h = useHandling();
  const [svar, settSvar] = useState<{ koblet: boolean; lenke: string | null; sendt_til: string | null } | null>(null);
  const hentPaNytt = async () => oppdatert(await hent<Ansatt>(`/org/${org!.id}/ansatte/${a.id}`));

  const inviter = () =>
    h.kjor(async () => {
      const r = await api("POST", `/org/${org!.id}/ansatte/${a.id}/inviter`);
      settSvar(r);
      await hentPaNytt();
      // Koblet med en gang (kanskje til en selv): menyen og «Mine timer» oppdateres.
      if (r.koblet) await oppdater();
    });
  const fjern = () =>
    h.kjor(async () => {
      if (!confirm(a.tilgang === "invitert" ? `Trekke tilbake invitasjonen til ${a.fornavn}?` : `Fjerne innloggingen til ${a.fornavn}? Timene blir liggende.`)) return;
      await api("DELETE", `/org/${org!.id}/ansatte/${a.id}/tilgang`);
      settSvar(null);
      await hentPaNytt();
      if (a.meg) await oppdater();
    });

  return (
    <div className="tilgang">
      <h3>Innlogging</h3>
      {a.tilgang === "koblet" ? (
        <p>
          {a.meg ? "Dette er deg: du fører egne timer under Timer → Mine timer." : `${a.fornavn} har egen innlogging og fører timene sine selv.`}
        </p>
      ) : a.tilgang === "invitert" ? (
        <p>
          Invitert på e-post til {a.epost}. Venter på at {a.fornavn} åpner lenken og logger inn.
        </p>
      ) : (
        <p className="dempet">
          Med egen innlogging fører {a.fornavn} timene sine selv og leverer uka til godkjenning. Den ansatte ser bare sine egne timer.
        </p>
      )}
      {svar &&
        (svar.koblet ? (
          <div className="melding ok">{a.fornavn} var allerede med i organisasjonen og er nå koblet til ansattkortet.</div>
        ) : (
          <div className="melding ok">
            Invitasjonen er sendt til {svar.sendt_til}. Du kan også sende lenken selv; den gjelder i sju dager:
            <br />
            <code className="hemmelig">{svar.lenke}</code>
          </div>
        ))}
      {kanEndre && (
        <div className="knapper">
          {a.tilgang !== "koblet" && (
            <button type="button" disabled={h.opptatt || !a.epost || epostEndret || !a.aktiv} onClick={inviter}>
              {a.tilgang === "invitert" ? "Send invitasjonen på nytt" : "Gi innlogging"}
            </button>
          )}
          {a.tilgang && (
            <button type="button" className="fare" disabled={h.opptatt} onClick={fjern}>
              {a.tilgang === "invitert" ? "Trekk tilbake" : a.meg ? "Koble fra meg" : "Fjern innloggingen"}
            </button>
          )}
          {a.tilgang !== "koblet" && (!a.epost || epostEndret) && (
            <span className="liten dempet">{epostEndret ? "Lagre e-postadressen først." : "Legg inn e-postadressen først."}</span>
          )}
          {a.tilgang !== "koblet" && a.epost && !epostEndret && !a.aktiv && <span className="liten dempet">Den ansatte er ikke aktiv.</span>}
        </div>
      )}
      <Feil melding={h.feil} />
    </div>
  );
}
