// Ansatte: registeret over de ansatte (personalia, ansettelse og lønn med faste tillegg) og deres
// egen innlogging for timeføring (rollen ansatt). Eier og administrator endrer og kan importere
// ansatte fra et annet system (Importer.tsx), eller fylle ut skjemaet fra en lønnsslipp som AI
// leser (server/src/aiLonnsslipp.ts); regnskap ser. Fødselsnummeret lagres kryptert og vises
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

type Ansatt = {
  id: string;
  ansattnummer: number;
  fornavn: string;
  etternavn: string;
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
  tilknytning: Tilknytning; // ansatt, eller med uten å være ansatt (aksjonærer, selvstendige, innleide)
  lonnstype: "maaned" | "time";
  maanedslonn: number | null;
  timelonn: number | null;
  aktiv: boolean;
  notat: string | null;
  gruppe_id: string | null;
  bursdag_varsel: boolean; // varsle de andre på bursdagen (når organisasjonen har slått på bursdagsvarsler)
  ferie_dager: number | null; // feriedager per år for denne ansatte (null: organisasjonens)
  tillegg: Tillegg[]; // faste tillegg på lønnen
  arbeidsdager: number[]; // ukedagene i den faste arbeidsplanen som gjelder i dag
  meg: boolean;
  tilgang: "koblet" | "invitert" | null;
};

// Fast tillegg på lønnen (f.eks. funksjonstillegg per måned), eventuelt for en periode.
type Tillegg = { id: string; navn: string; belop: number; per: "maaned" | "time"; fra: string | null; til: string | null };

const ansettelsestype: Record<string, string> = { fast: "Fast", midlertidig: "Midlertidig", tilkalling: "Tilkalling" };
// Tilknytning: de som ikke er ansatt (f.eks. leger som er aksjonærer), er med i vaktplanen, på tavla
// og i kalenderen, men ikke i lønn, feriebank og arbeidsmiljølovens advarsler.
type Tilknytning = "ansatt" | "eier" | "selvstendig" | "innleid";
const TILKNYTNING: Record<Tilknytning, [string, string]> = {
  ansatt: ["Ansatt", "Ansatt"],
  eier: ["Eier eller aksjonær (ikke ansatt)", "Aksjonær"],
  selvstendig: ["Selvstendig næringsdrivende", "Selvstendig"],
  innleid: ["Innleid", "Innleid"],
};
const erAnsatt = (a: Pick<Ansatt, "tilknytning">) => (a.tilknytning ?? "ansatt") === "ansatt";
const NY_GRUPPE = "ny"; // valget «+ Ny gruppe …» for gruppen i bemanningskalenderen
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
      {!erAnsatt(a) && <span className="merke merke-info">{TILKNYTNING[a.tilknytning]?.[1] ?? a.tilknytning}</span>}
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
    tilknytning: ansatt.tilknytning ?? ("ansatt" as Tilknytning),
    lonnstype: ansatt.lonnstype ?? "maaned",
    maanedslonn: tekstTall(ansatt.maanedslonn),
    timelonn: tekstTall(ansatt.timelonn),
    aktiv: ansatt.aktiv ?? true,
    notat: ansatt.notat ?? "",
    gruppe_id: ansatt.gruppe_id ?? "",
    bursdag_varsel: ansatt.bursdag_varsel ?? true,
    ferie_dager: tekstTall(ansatt.ferie_dager),
  }));
  // Bursdagsvarsler (Innstillinger → Ansatte og timer): da kan den ansatte unntas.
  const oppsett = useData(() => hent<{ bursdag_varsel: string; full_stilling: number; ferie_dager: number }>(`/org/${org!.id}/lonn-oppsett`), [org?.id]);
  const bursdager = !!oppsett.data && oppsett.data.bursdag_varsel !== "av";
  // En ny ansatt får organisasjonens arbeidstid i full stilling (Innstillinger → Ansatte og timer).
  const fullStilling = Number(oppsett.data?.full_stilling ?? 37.5);
  // Med vaktplanen (funksjonene i Administrasjon): gruppene i bemanningskalenderen (f.eks.
  // sekretærer og leger), og den faste arbeidsplanen (ukedagene den ansatte jobber), som et
  // utkast til den lagres. En ny gruppe kan lages rett herfra (nyGruppe: navnet), når den
  // ansatte lagres.
  const vaktplan = harFunksjon(org, "vaktplan");
  const grupper = useData(() => (vaktplan ? hent<{ id: string; navn: string }[]>(`/org/${org!.id}/ansattgrupper`) : Promise.resolve([])), [org?.id]);
  const [nyGruppe, settNyGruppe] = useState<string | null>(null);
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
  // De som ikke er ansatt, har ikke lønn, feriebank eller fødselsnummer til a-meldingen her.
  const arbeidstaker = a.tilknytning === "ansatt";

  async function lagre(e: FormEvent) {
    e.preventDefault();
    settMelding(null);
    const tallEllerNull = (s: string) => (s.trim() ? tall(s) : null);
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
      tilknytning: a.tilknytning,
      lonnstype: a.lonnstype,
      maanedslonn: a.lonnstype === "maaned" ? tallEllerNull(a.maanedslonn) : null,
      timelonn: a.lonnstype === "time" ? tallEllerNull(a.timelonn) : null,
      notat: a.notat,
      aktiv: a.aktiv,
    };
    if (bursdager) kropp.bursdag_varsel = a.bursdag_varsel;
    if (grupper.data?.length) kropp.gruppe_id = a.gruppe_id || null;
    const gruppenavn = nyGruppe?.trim() ?? "";
    if (nyGruppe !== null && !gruppenavn) return h.settFeil("Skriv navnet på den nye gruppen, eller velg en annen.");
    if (a.stillingsprosent.trim()) kropp.stillingsprosent = tall(a.stillingsprosent);
    if (a.ukentlig_arbeidstid.trim()) kropp.ukentlig_arbeidstid = tall(a.ukentlig_arbeidstid);
    if (vaktplan) kropp.ferie_dager = a.ferie_dager.trim() ? tall(a.ferie_dager) : null;
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
      // Den nye gruppen lages først (en med samme navn brukes heller, om den finnes).
      if (gruppenavn) {
        const finnes = grupper.data?.find((g) => g.navn.trim().toLowerCase() === gruppenavn.toLowerCase());
        const gruppe = finnes?.id ?? (await api<{ id: string }>("POST", `/org/${org!.id}/ansattgrupper`, { navn: gruppenavn })).id;
        kropp.gruppe_id = gruppe;
        settNyGruppe(null);
        settA((x) => ({ ...x, gruppe_id: gruppe }));
        void grupper.last();
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
        <div className="rad">
          <label>
            Fornavn
            <input required autoComplete="off" {...felt("fornavn")} />
          </label>
          <label>
            Etternavn
            <input required autoComplete="off" {...felt("etternavn")} />
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

        <h3>{arbeidstaker ? "Ansettelse" : "Stilling og tilknytning"}</h3>
        <label>
          Stilling
          <input placeholder="F.eks. butikkmedarbeider eller lege" {...felt("stilling")} />
        </label>
        <div className="rad">
          <label className={arbeidstaker ? undefined : "hel"}>
            Tilknytning
            <select {...felt("tilknytning")}>
              {Object.entries(TILKNYTNING).map(([v, [t]]) => (
                <option key={v} value={v}>
                  {t}
                </option>
              ))}
            </select>
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
        {!arbeidstaker && (
          <p className="felt-hjelp tilknytning-hjelp">
            Ikke ansatt (f.eks. lege som er aksjonær): med i vaktplanen, på tavla, i kalenderen og fraværet, men ikke i lønn, feriebank og arbeidsmiljølovens
            advarsler.
          </p>
        )}
        {vaktplan && (!!grupper.data?.length || kanEndre) && (
          <div className="rad">
            <label className="hel">
              Gruppe i bemanningskalenderen
              <select
                value={nyGruppe !== null ? NY_GRUPPE : a.gruppe_id}
                onChange={(e) => {
                  if (e.target.value === NY_GRUPPE) settNyGruppe("");
                  else {
                    settNyGruppe(null);
                    sett({ gruppe_id: e.target.value });
                  }
                }}
              >
                <option value="">Ingen gruppe</option>
                {(grupper.data ?? []).map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.navn}
                  </option>
                ))}
                {kanEndre && <option value={NY_GRUPPE}>+ Ny gruppe …</option>}
              </select>
              <span className="felt-hjelp">F.eks. leger og sekretærer: kalenderen viser hvor mange i hver gruppe som er på jobb hver dag, mot behovet.</span>
            </label>
            {nyGruppe !== null && (
              <label className="hel">
                Navn på den nye gruppen
                <input value={nyGruppe} maxLength={40} placeholder="F.eks. Leger" autoFocus onChange={(e) => settNyGruppe(e.target.value)} />
                <span className="felt-hjelp">Lages når du lagrer. Hvor mange som trengs per dag, setter du under Vaktplan → Kalender → Grupper.</span>
              </label>
            )}
          </div>
        )}
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
