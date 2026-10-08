// Fravær og vikarer: registrere fravær (eier og administrator), melde seg syk (den ansatte),
// listen over fravær, og vikar for en vakt når den som har den, er borte. Fravær er
// helseopplysninger og vises bare for eier, administrator, regnskap og den ansatte selv.
import { useState, type FormEvent } from "react";
import { api, hent } from "../api";
import { Dialog, Feil, Laster, Tom, useData, useHandling } from "../felles";
import { kanPersonal, useKonto } from "../konto";
import { iDag, leggTilDager } from "../format";
import { IkonKalender } from "../ikoner";
import { visDag } from "../uke";

// «fravaer»: typen er skjult. Bare eier, administrator og den ansatte selv ser hva slags fravær det
// er (0047_fravaer_skjult.sql); andre ser bare at den ansatte er borte (F).
export type FravaerType = "syk" | "sykt_barn" | "ferie" | "permisjon" | "kurs" | "annet" | "fravaer";
export type Fravaer = { id: string; ansatt_id: string; ansatt_navn: string; type: FravaerType; fra: string; til: string; notat?: string | null };
export type Ansatt = { id: string; fornavn: string; etternavn: string; ansatt_fra: string; ansatt_til: string | null; aktiv: boolean };
type BerortVakt = { id: string; dato: string; fra: string; til: string; oppgave: string | null };

export const FRAVAERTYPER: FravaerType[] = ["ferie", "syk", "sykt_barn", "permisjon", "kurs", "annet"];
export const fravaerTekst: Record<FravaerType, string> = {
  syk: "Syk",
  sykt_barn: "Sykt barn",
  ferie: "Ferie",
  permisjon: "Permisjon",
  kurs: "Kurs",
  annet: "Annet fravær",
  fravaer: "Fravær",
};
// Forkortelsene i bemanningskalenderen. F er fravær uten type (det andre ser).
export const fravaerKode: Record<FravaerType, string> = { ferie: "Fe", syk: "S", sykt_barn: "SB", permisjon: "P", kurs: "K", annet: "A", fravaer: "F" };
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
  annet: "er borte",
  fravaer: "har fravær",
};

export const fravaerPeriode = (f: Pick<Fravaer, "fra" | "til">) => (f.fra === f.til ? visDag(f.fra) : `${visDag(f.fra)} – ${visDag(f.til)}`);
const dager = (f: Pick<Fravaer, "fra" | "til">) => Math.round((Date.parse(`${f.til}T12:00:00Z`) - Date.parse(`${f.fra}T12:00:00Z`)) / 86_400_000) + 1;
export const iArbeid = (a: Ansatt, dato: string) => a.aktiv && a.ansatt_fra <= dato && (!a.ansatt_til || a.ansatt_til >= dato);
export const borte = (fravaer: Pick<Fravaer, "ansatt_id" | "fra" | "til" | "type">[], ansatt: string | null, dato: string) =>
  (ansatt && fravaer.find((f) => f.ansatt_id === ansatt && f.fra <= dato && f.til >= dato)?.type) || null;

// Registrer eller endre fravær. Den ansatte selv (selv) kan bare melde sykdom og deretter
// endre sluttdatoen; eier og administrator velger ansatt og type.
export function FravaerSkjema({
  fravaer,
  ansatte,
  selv,
  ferdig,
  avbryt,
}: {
  fravaer: Partial<Fravaer>;
  ansatte?: Ansatt[];
  selv?: boolean;
  ferdig: (melding: string, berort?: BerortVakt[]) => void;
  avbryt: () => void;
}) {
  const { org } = useKonto();
  const [f, settF] = useState(() => ({
    ansatt_id: fravaer.ansatt_id ?? "",
    type: (fravaer.type ?? (selv ? "syk" : "ferie")) as FravaerType,
    fra: fravaer.fra ?? iDag(),
    til: fravaer.til ?? fravaer.fra ?? iDag(),
    notat: fravaer.notat ?? "",
  }));
  const h = useHandling();
  const sett = (e: Partial<typeof f>) => settF({ ...f, ...e });
  const typer: FravaerType[] = selv ? ["syk", "sykt_barn"] : FRAVAERTYPER;
  // Den ansatte endrer bare sluttdatoen på en sykmelding som er meldt.
  const bareSlutt = !!selv && !!fravaer.id;
  const valg = (ansatte ?? []).filter((a) => a.id === fravaer.ansatt_id || a.aktiv);

  async function lagre(e: FormEvent) {
    e.preventDefault();
    const kropp = bareSlutt ? { til: f.til } : { type: f.type, fra: f.fra, til: f.til, notat: f.notat.trim() || null };
    const r = await h.kjor(() =>
      fravaer.id
        ? api("PATCH", `/org/${org!.id}/fravaer/${fravaer.id}`, kropp)
        : api("POST", `/org/${org!.id}/fravaer`, { ...kropp, ...(selv ? {} : { ansatt_id: f.ansatt_id }) }),
    );
    if (!r) return;
    const hvem = selv ? "Du" : r.ansatt_navn;
    ferdig(
      fravaer.id
        ? "Fraværet er endret."
        : selv
          ? `Sykdommen er meldt (${fravaerPeriode(r)}). Lederen din har fått beskjed.`
          : `${fravaerTekst[r.type as FravaerType]} for ${hvem} er registrert (${fravaerPeriode(r)}).`,
      r.vakter,
    );
  }

  async function slett() {
    if (!confirm(selv ? "Slette sykmeldingen?" : `Slette fraværet for ${fravaer.ansatt_navn}?`)) return;
    const r = await h.kjor(async () => (await api("DELETE", `/org/${org!.id}/fravaer/${fravaer.id}`), true));
    if (r) ferdig("Fraværet er slettet.");
  }

  return (
    <form onSubmit={lagre}>
      {!selv && (
        <label>
          Ansatt
          <select required disabled={!!fravaer.id} value={f.ansatt_id} onChange={(e) => sett({ ansatt_id: e.target.value })}>
            <option value="">Velg ansatt</option>
            {valg.map((a) => (
              <option key={a.id} value={a.id}>
                {a.fornavn} {a.etternavn}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className={`faner valg${selv ? "" : " fravaertyper"}`} role="radiogroup" aria-label="Type fravær">
        {typer.map((t) => (
          <button key={t} type="button" role="radio" aria-checked={f.type === t} className={f.type === t ? "valgt" : undefined} disabled={bareSlutt} onClick={() => sett({ type: t })}>
            {t === "annet" ? "Annet" : fravaerTekst[t]}
          </button>
        ))}
      </div>
      <div className="rad">
        <label>
          Fra og med
          <input type="date" required disabled={bareSlutt} min={selv && !fravaer.id ? leggTilDager(iDag(), -1) : undefined} value={f.fra} onChange={(e) => sett({ fra: e.target.value, til: f.til < e.target.value ? e.target.value : f.til })} />
        </label>
        <label>
          {f.type === "syk" || f.type === "sykt_barn" ? "Til og med (siste sykedag)" : "Til og med"}
          <input type="date" required min={f.fra} value={f.til} onChange={(e) => sett({ til: e.target.value })} />
        </label>
      </div>
      {!bareSlutt && (
        <label>
          Notat
          <input maxLength={500} placeholder={selv ? "Valgfritt, f.eks. når du regner med å være tilbake" : "Valgfritt"} value={f.notat} onChange={(e) => sett({ notat: e.target.value })} />
          {(f.type === "syk" || f.type === "sykt_barn") && <span className="felt-hjelp">Ikke skriv hva sykdommen gjelder.</span>}
        </label>
      )}
      <Feil melding={h.feil} />
      <div className="knapper">
        <button className="primar" disabled={h.opptatt}>
          {fravaer.id ? "Lagre" : selv ? "Meld sykdom" : "Registrer"}
        </button>
        <button type="button" onClick={avbryt}>
          Avbryt
        </button>
        {fravaer.id && (
          <button type="button" className="fare" style={{ marginLeft: "auto" }} disabled={h.opptatt} onClick={slett}>
            Slett
          </button>
        )}
      </div>
    </form>
  );
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
  opptatt?: Map<string, string>; // ansatte som har vakt samme dag: id → tid
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
    .sort((a, b) => Number(!!opptatt?.get(a.id)) - Number(!!opptatt?.get(b.id)));

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
                {opptatt?.get(a.id) ? ` (har vakt ${opptatt.get(a.id)})` : ""}
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
            <p>Sykdom, ferie og permisjon vises i vaktplanen, på tavla og i kalenderen. Den som er borte, tas ut av ressursene på tavla.</p>
          </Tom>
        </div>
      ) : (
        <div className="kort liste">
          {liste.map((f) => (
            <button key={f.id} type="button" className="liste-rad" onClick={() => endre && settApen(f)} disabled={!endre}>
              <span className="linje">
                <span className="tittel">{f.ansatt_navn}</span>
                <span className={`merke ${fravaerKlasse[f.type]}`}>{fravaerTekst[f.type]}</span>
              </span>
              <span className="linje">
                <span className="under">
                  {fravaerPeriode(f)} · {dager(f) === 1 ? "1 dag" : `${dager(f)} dager`}
                  {f.notat ? ` · ${f.notat}` : ""}
                </span>
                {f.fra <= iDag() && f.til >= iDag() && <span className="merke merke-advarsel">Nå</span>}
              </span>
            </button>
          ))}
        </div>
      )}
      <p className="liten dempet">Fravær er helseopplysninger: bare eier, administrator, regnskap og den ansatte selv ser det.</p>
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

// Den ansattes eget fravær (i «Mine vakter»): meld deg syk, friskmeld deg.
export function MittFravaer({ fravaer, endret }: { fravaer: Fravaer[]; endret: () => void }) {
  const [apen, settApen] = useState<Partial<Fravaer> | null>(null);
  const [melding, settMelding] = useState<string | null>(null);
  const aktuelt = fravaer.filter((f) => f.til >= iDag());
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
              <strong>{fravaerTekst[f.type]}</strong> {fravaerPeriode(f)}
            </span>
            {(f.type === "syk" || f.type === "sykt_barn") && (
              <button type="button" className="lenke" onClick={() => settApen(f)}>
                Endre
              </button>
            )}
          </div>
        ))}
        <button type="button" onClick={() => settApen({})}>
          Meld deg syk
        </button>
      </div>
      <Dialog apen={!!apen} lukk={() => settApen(null)} tittel={apen?.id ? "Endre sykmelding" : "Meld deg syk"}>
        {apen && (
          <FravaerSkjema
            fravaer={apen}
            selv
            ferdig={(m) => {
              settApen(null);
              settMelding(m);
              endret();
            }}
            avbryt={() => settApen(null)}
          />
        )}
      </Dialog>
    </>
  );
}
