// Lønn (0065_lonn.sql, server/src/lonn.ts): eier og administrator lager en lønnskjøring for
// hver måned (og ekstra kjøringer), og lønnsslippene regnes ut fra de ansatte, de godkjente
// timene, de faste tilleggene, sykefraværet og skattekortene. Linjene kan endres, fjernes og
// legges til, og skattetrekket kan settes for hånd, før kjøringen godkjennes; da får de ansatte
// lønnsslippen. Regnskap ser kjøringene. De ansatte ser sine egne lønnsslipper («Mine
// lønnsslipper»).
//
// Fanen står i adressen (?fane=kjoringer|amelding|sykepenger|aar|mine), kjøringen som er åpen med
// ?kjoring=, måneden i a-meldingen med ?maaned= (LonnAmelding.tsx), forespørselen fra NAV med
// ?foresporsel= (LonnSykepenger.tsx), og året for årsoversikten med ?aar= (LonnAar.tsx).
import { useState, type FormEvent, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, hent, lastNed } from "../api";
import { Dialog, Feil, Laster, Tom, tall, useData, useHandling, useNarDataEndres, useSmal } from "../felles";
import { erAdmin, erAnsatt, kanSePersonal, useKonto } from "../konto";
import { dato, iDag, kr } from "../format";
import { IkonLonn, IkonPluss, IkonVarsel, IkonVenstre } from "../ikoner";
import { apnePdf, maaned } from "../lonn";
import { Aarsoversikter, MineAarsoversikter } from "./LonnAar";
import { Ameldinger } from "./LonnAmelding";
import { Sykepenger } from "./LonnSykepenger";
import { KjoringBokforing } from "./LonnBokforing";
import { LonnBetalinger } from "./LonnBetalinger";

export interface Linje {
  id: string;
  slipp_id: string;
  lonnsart: string;
  tekst: string;
  antall: number | null;
  sats: number | null;
  belop: number;
  kilde: "auto" | "manuell";
  nokkel: string | null;
  fjernet: boolean;
  opptjeningsaar: number | null;
}
export interface Slipp {
  id: string;
  kjoring_id: string;
  ansatt_id: string;
  navn: string;
  ansattnummer: number;
  lonnstype: string;
  periode: string;
  utbetalingsdato: string;
  kontonr: string | null;
  trekkmetode: string;
  trekkpliktig: number;
  trekkgrunnlag: number;
  skattetrekk: number;
  skattetrekk_manuell: boolean;
  brutto: number;
  utgifter: number;
  trekk_etter_skatt: number;
  netto: number;
  feriepengegrunnlag: number;
  feriepenger_opptjent: number;
  otp_grunnlag: number;
  otp: number;
  aga_grunnlag: number;
  aga: number;
  aga_sats: number;
  antall_timeforinger: number;
  merknader: string[];
  linjer: Linje[];
}
type Summer = {
  antall: number;
  brutto: number;
  skattetrekk: number;
  utgifter: number;
  trekk_etter_skatt: number;
  netto: number;
  feriepengegrunnlag: number;
  feriepenger_opptjent: number;
  otp: number;
  aga_grunnlag: number;
  aga: number;
  merknader: number;
};
interface Kjoring {
  id: string;
  periode: string;
  type: "ordinar" | "ekstra";
  utbetalingsdato: string;
  status: "utkast" | "godkjent";
  feriepenger: boolean;
  halv_skatt: boolean;
  notat: string | null;
  godkjent_at: string | null;
  godkjent_av: string | null;
  aga_sone: string;
  otp_prosent: number;
  feriepenger_prosent: number;
  trekktabeller: { aar: number; lastet: boolean };
  frister: { skattetrekk: string; aga: string };
  betalingsfil_lastet: string | null;
  betalingsfil_antall: number;
  betalingsfil_av: string | null;
  sum: Summer;
  slipper: Slipp[];
}
interface KjoringRad {
  id: string;
  periode: string;
  type: "ordinar" | "ekstra";
  utbetalingsdato: string;
  status: "utkast" | "godkjent";
  feriepenger: boolean;
  antall: number;
  brutto: number;
  skattetrekk: number;
  netto: number;
  aga: number;
  merknader: number;
}
interface Lonnsart {
  kode: string;
  navn: string;
  type: "lonn" | "utgift" | "trekk";
  fortegn: 1 | -1;
  manuell: boolean;
}
type MinSlipp = Omit<Slipp, "linjer"> & { linjer?: Linje[] };
type SlippDetaljer = Slipp & {
  godkjent: boolean;
  hittil: { brutto: number; trekkpliktig: number; skattetrekk: number; feriepengegrunnlag: number; otp: number };
};

const kjoringNavn = (k: { periode: string; type: string }) => `${maaned(k.periode)}${k.type === "ekstra" ? " (ekstra)" : ""}`;
// Dato og klokkeslett (norsk tid), f.eks. «20.11.2026 kl. 10.15».
const tidspunkt = (iso: string) => {
  const d = new Date(iso);
  const t = new Intl.DateTimeFormat("nb-NO", { timeZone: "Europe/Oslo", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);
  return `${dato(new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Oslo" }).format(d))} kl. ${t.replace(":", ".")}`;
};
const tallTekst = (n: number, maks = 2) => new Intl.NumberFormat("nb-NO", { maximumFractionDigits: maks }).format(n);
const prosentArt = (art: string) => art === "feriepenger" || art === "feriepenger_60";
const AGA_SONER: Record<string, string> = { "1": "sone 1, 14,1 %", "1a": "sone 1a, 10,6 % til fribeløpet", "2": "sone 2, 10,6 %", "3": "sone 3, 6,4 %", "4": "sone 4, 5,1 %", "4a": "sone 4a, 7,9 %", "5": "sone 5, 0 %" };
const synlig = (l: Linje) => l.nokkel !== "lagt_til";

// Lønnsslippen som PDF i en ny fane.
const apneSlipp = (orgId: string, slippId: string) => apnePdf(`/org/${orgId}/lonn/slipper/${slippId}/pdf`);

export function Lonn() {
  const { org } = useKonto();
  const [sok, settSok] = useSearchParams();
  const leder = !erAnsatt(org?.rolle) && kanSePersonal(org?.rolle);
  const egen = !!org?.ansatt_id;
  const faner: [string, string][] = [];
  if (leder) faner.push(["kjoringer", "Lønnskjøringer"], ["amelding", "A-melding"], ["aar", "Årsoversikt"]);
  // Sykepenger og NAV: helseopplysninger, så bare eier og administrator.
  if (leder && erAdmin(org?.rolle)) faner.splice(2, 0, ["sykepenger", "Sykepenger"]);
  if (egen) faner.push(["mine", "Mine lønnsslipper"]);
  const fane = faner.find(([v]) => v === sok.get("fane"))?.[0] ?? faner[0]?.[0] ?? null;
  const kjoring = sok.get("kjoring");
  // Kjøringen og måneden i a-meldingen har sin egen overskrift og lenke tilbake.
  const detalj = (fane === "kjoringer" && !!kjoring) || (fane === "amelding" && !!sok.get("maaned")) || (fane === "sykepenger" && !!sok.get("foresporsel"));
  const ga = (endring: Record<string, string | null>) => {
    const p = new URLSearchParams(sok);
    for (const [k, v] of Object.entries(endring)) {
      if (v === null) p.delete(k);
      else p.set(k, v);
    }
    settSok(p);
  };

  if (!org?.personal || !fane)
    return (
      <>
        <h1>Lønn</h1>
        <div className="kort">
          <Tom ikon={<IkonLonn storrelse={22} />} tittel={!org?.personal ? "Ansatte og timer er ikke slått på" : "Ingen lønnsslipper her"}>
            {!org?.personal && erAdmin(org?.rolle) ? (
              <p>
                Slå det på under <Link to="/innstillinger?fane=personal">Innstillinger → Ansatte og timer</Link>.
              </p>
            ) : (
              <p>Du er ikke registrert som ansatt i {org?.navn}.</p>
            )}
          </Tom>
        </div>
      </>
    );

  return (
    <>
      {!detalj && (
        <>
          <div className="topp">
            <h1>{leder ? "Lønn" : "Lønnsslipper"}</h1>
          </div>
          {faner.length > 1 && (
            <div className="faner tett" role="tablist">
              {faner.map(([v, t]) => (
                <button key={v} type="button" role="tab" aria-selected={fane === v} className={fane === v ? "valgt" : undefined} onClick={() => ga({ fane: v, kjoring: null, aar: null, maaned: null, foresporsel: null })}>
                  {t}
                </button>
              ))}
            </div>
          )}
        </>
      )}
      {fane === "kjoringer" && (kjoring ? <KjoringSide id={kjoring} tilbake={() => ga({ kjoring: null })} /> : <Kjoringer apne={(id) => ga({ kjoring: id })} />)}
      {fane === "amelding" && <Ameldinger />}
      {fane === "sykepenger" && <Sykepenger />}
      {fane === "aar" && <Aarsoversikter />}
      {fane === "mine" && <MineSlipper />}
    </>
  );
}

// --- Kjøringene ---------------------------------------------------------------------------

function Kjoringer({ apne }: { apne: (id: string) => void }) {
  const { org } = useKonto();
  const smal = useSmal();
  const admin = erAdmin(org?.rolle);
  const liste = useData(() => hent<KjoringRad[]>(`/org/${org!.id}/lonn/kjoringer`), [org?.id], { oppdater: true });
  const [ny, settNy] = useState(false);
  const status = (k: KjoringRad) => (
    <span className={`merke ${k.status === "godkjent" ? "merke-ok" : "merke-advarsel"}`}>{k.status === "godkjent" ? "Godkjent" : "Utkast"}</span>
  );

  return (
    <>
      <div className="knapper lonn-knapper">
        {admin && (
          <button type="button" className="primar" onClick={() => settNy(true)}>
            <IkonPluss storrelse={16} /> Ny lønnskjøring
          </button>
        )}
      </div>
      <p className="undertittel">
        En lønnskjøring per måned: lønnen regnes ut fra de ansatte, de godkjente timene, de faste tilleggene, sykefraværet og skattekortene. Se over og godkjenn, så får de
        ansatte lønnsslippen.
      </p>
      {liste.feil ? (
        <Feil melding={liste.feil} />
      ) : !liste.data ? (
        <Laster />
      ) : !liste.data.length ? (
        <div className="kort">
          <Tom ikon={<IkonLonn storrelse={22} />} tittel="Ingen lønnskjøringer ennå">
            <p>
              Sjekk at de ansatte har lønn, kontonummer og skattekort, og lønnsoppsettet under <Link to="/innstillinger?fane=personal">Innstillinger → Ansatte og timer</Link>.
            </p>
            {admin && (
              <button type="button" className="primar" onClick={() => settNy(true)}>
                Lag den første lønnskjøringen
              </button>
            )}
          </Tom>
        </div>
      ) : smal ? (
        <div className="kort liste">
          {liste.data.map((k) => (
            <button key={k.id} type="button" className="liste-rad" onClick={() => apne(k.id)}>
              <span className="linje">
                <span className="tittel">{kjoringNavn(k)}</span>
                <span className="belop">{kr(k.netto)}</span>
              </span>
              <span className="linje">
                <span className="under">
                  Utbetales {dato(k.utbetalingsdato)} · {k.antall} {k.antall === 1 ? "ansatt" : "ansatte"}
                </span>
                {status(k)}
              </span>
            </button>
          ))}
        </div>
      ) : (
        <div className="kort tabell">
          <table>
            <thead>
              <tr>
                <th>Måned</th>
                <th>Utbetales</th>
                <th className="hoyre">Ansatte</th>
                <th className="hoyre">Bruttolønn</th>
                <th className="hoyre">Skattetrekk</th>
                <th className="hoyre">Til utbetaling</th>
                <th className="hoyre">Arbeidsgiveravgift</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {liste.data.map((k) => (
                <tr key={k.id} className="klikkbar" onClick={() => apne(k.id)}>
                  <td>
                    <strong>{kjoringNavn(k)}</strong>
                    {k.feriepenger && <span className="liten dempet"> · feriepenger</span>}
                  </td>
                  <td>{dato(k.utbetalingsdato)}</td>
                  <td className="tall">{k.antall}</td>
                  <td className="tall">{kr(k.brutto)}</td>
                  <td className="tall">{kr(k.skattetrekk)}</td>
                  <td className="tall sterk">{kr(k.netto)}</td>
                  <td className="tall">{kr(k.aga)}</td>
                  <td>
                    {status(k)}
                    {k.status === "utkast" && k.merknader > 0 && <span className="merke merke-noytral lonn-merke">{k.merknader} å sjekke</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Dialog apen={ny} lukk={() => settNy(false)} tittel="Ny lønnskjøring">
        <NyKjoring
          siste={liste.data?.find((k) => k.type === "ordinar")?.periode ?? null}
          laget={(id) => {
            settNy(false);
            apne(id);
          }}
        />
      </Dialog>
    </>
  );
}

const nesteMaaned = (periode: string) => {
  const [a, m] = periode.split("-").map(Number) as [number, number];
  return m === 12 ? `${a + 1}-01` : `${a}-${String(m + 1).padStart(2, "0")}`;
};

function NyKjoring({ siste, laget }: { siste: string | null; laget: (id: string) => void }) {
  const { org } = useKonto();
  const h = useHandling();
  const [periode, settPeriode] = useState(siste ? nesteMaaned(siste) : iDag().slice(0, 7));
  const [type, settType] = useState<"ordinar" | "ekstra">("ordinar");
  const [dato_, settDato] = useState("");
  const [feriepenger, settFeriepenger] = useState<boolean | null>(null);
  const [notat, settNotat] = useState("");
  const juni = periode.endsWith("-06");
  const medFerie = feriepenger ?? (type === "ordinar" && juni);

  async function lagre(e: FormEvent) {
    e.preventDefault();
    const k = await h.kjor(() =>
      api<Kjoring>("POST", `/org/${org!.id}/lonn/kjoringer`, {
        periode,
        type,
        utbetalingsdato: dato_ || undefined,
        feriepenger: medFerie,
        notat: notat.trim() || null,
      }),
    );
    if (k) laget(k.id);
  }

  return (
    <form onSubmit={lagre}>
      <div className="rad">
        <label>
          Måned
          <input type="month" required value={periode} onChange={(e) => settPeriode(e.target.value)} />
        </label>
        <label>
          Type
          <select value={type} onChange={(e) => settType(e.target.value as "ordinar" | "ekstra")}>
            <option value="ordinar">Vanlig lønn for måneden</option>
            <option value="ekstra">Ekstra kjøring (f.eks. bonus)</option>
          </select>
        </label>
      </div>
      <label>
        Utbetalingsdato
        <input type="date" value={dato_} onChange={(e) => settDato(e.target.value)} />
        <span className="felt-hjelp">Tom: lønnsdagen i oppsettet (virkedagen før når den er en helg eller helligdag).</span>
      </label>
      <label>
        <input type="checkbox" checked={medFerie} onChange={(e) => settFeriepenger(e.target.checked)} />
        Utbetal feriepengene for {Number(periode.slice(0, 4)) - 1}
        <span className="felt-hjelp">Vanligvis i juni. De med fastlønn får trekk i lønnen for ferien samtidig.</span>
      </label>
      <label>
        Notat (valgfritt)
        <input value={notat} maxLength={500} onChange={(e) => settNotat(e.target.value)} />
      </label>
      {type === "ekstra" && <p className="liten dempet">En ekstra kjøring starter tom: legg til de ansatte og linjene (f.eks. en bonus). Tabelltrekket regnes da med prosentsatsen.</p>}
      <Feil melding={h.feil} />
      <div className="knapper">
        <button type="submit" className="primar" disabled={h.opptatt}>
          {h.opptatt ? "Regner ut …" : "Lag og regn ut"}
        </button>
      </div>
    </form>
  );
}

// --- Én kjøring -----------------------------------------------------------------------------

function KjoringSide({ id, tilbake }: { id: string; tilbake: () => void }) {
  const { org } = useKonto();
  const admin = erAdmin(org?.rolle);
  const k = useData(() => hent<Kjoring>(`/org/${org!.id}/lonn/kjoringer/${id}`), [org?.id, id]);
  useNarDataEndres(() => void k.last());
  const arter = useData(() => hent<Lonnsart[]>(`/org/${org!.id}/lonn/lonnsarter`), [org?.id]);
  const h = useHandling();
  const [melding, settMelding] = useState<string | null>(null);
  const [apne, settApne] = useState<Set<string>>(new Set());
  const [endre, settEndre] = useState(false);
  const [godkjenn, settGodkjenn] = useState(false);
  const [leggTil, settLeggTil] = useState(false);

  if (k.feil)
    return (
      <>
        <button type="button" className="lenke tilbake-lenke" onClick={tilbake}>
          <IkonVenstre storrelse={16} /> Alle lønnskjøringer
        </button>
        <Feil melding={k.feil} />
      </>
    );
  if (!k.data) return <Laster />;
  const d = k.data;
  const utkast = d.status === "utkast";
  const kanEndre = admin && utkast;
  // Kjør en handling som gir kjøringen tilbake (regnet ut på nytt).
  const kjor = async (fn: () => Promise<Kjoring>, ok?: string) => {
    const ny = await h.kjor(fn);
    if (ny) {
      k.settData(ny);
      settMelding(ok ?? null);
    }
    return ny;
  };
  const sti = `/org/${org!.id}/lonn/kjoringer/${d.id}`;
  const veksle = (sid: string) => {
    const s = new Set(apne);
    if (s.has(sid)) s.delete(sid);
    else s.add(sid);
    settApne(s);
  };
  const manglerTabell = !d.trekktabeller.lastet && d.slipper.some((s) => s.trekkmetode.startsWith("Tabell"));
  const filnavn = `lonn-${d.periode.slice(0, 7)}${d.type === "ekstra" ? "-ekstra" : ""}`;
  // Betalingsfila (pain.001) til nettbanken; lastet ned før, spør appen først (dobbel betaling).
  const betalingsfil = async () => {
    if (
      d.betalingsfil_lastet &&
      !confirm(
        `Betalingsfila ble lastet ned ${tidspunkt(d.betalingsfil_lastet)}${d.betalingsfil_av ? ` av ${d.betalingsfil_av}` : ""}. Lastes den opp i nettbanken igjen, kan lønnen bli betalt to ganger. Laste den ned likevel?`,
      )
    )
      return;
    const ok = await h.kjor(async () => {
      await lastNed(`${sti}/betalingsfil`, `${filnavn}.xml`, "POST");
      return true;
    });
    if (!ok) return;
    settMelding(
      `Betalingsfila er lastet ned. Last den opp i nettbanken (betaling med fil) og godkjenn den der. Forskuddstrekket på ${kr(d.sum.skattetrekk)} betales til Skatteetaten senest ${dato(d.frister.skattetrekk)}.`,
    );
    void k.last();
  };

  return (
    <>
      <button type="button" className="lenke tilbake-lenke" onClick={tilbake}>
        <IkonVenstre storrelse={16} /> Alle lønnskjøringer
      </button>
      <div className="topp">
        <h1>Lønn for {kjoringNavn(d)}</h1>
        <span className={`merke ${utkast ? "merke-advarsel" : "merke-ok"}`}>{utkast ? "Utkast" : "Godkjent"}</span>
      </div>
      <p className="undertittel">
        Utbetales {dato(d.utbetalingsdato)}. Skattetrekket betales til Skatteetaten senest {dato(d.frister.skattetrekk)}, og arbeidsgiveravgiften ({AGA_SONER[d.aga_sone] ?? `sone ${d.aga_sone}`}) senest{" "}
        {dato(d.frister.aga)}.
        {d.halv_skatt && " Halv skatt (tabelltrekk) denne måneden."}
        {d.feriepenger && ` Feriepengene for ${Number(d.utbetalingsdato.slice(0, 4)) - 1} utbetales.`}
        {!utkast && d.godkjent_at && ` Godkjent ${dato(d.godkjent_at)}${d.godkjent_av ? ` av ${d.godkjent_av}` : ""}.`}
        {!utkast && d.betalingsfil_lastet && ` Betalingsfila ble lastet ned ${tidspunkt(d.betalingsfil_lastet)}${d.betalingsfil_av ? ` av ${d.betalingsfil_av}` : ""}.`}
      </p>
      {d.notat && <p className="lonn-notat">{d.notat}</p>}
      {melding && (
        <div className="melding ok" role="status">
          {melding}
        </div>
      )}
      <Feil melding={h.feil} />
      {manglerTabell && (
        <div className="melding info">
          Trekktabellene for {d.trekktabeller.aar} er ikke lastet inn i HI4 Faktura ennå. Tabelltrekket er regnet med prosentsatsen på skattekortet; kontroller trekket, eller sett det
          for hånd.
        </div>
      )}

      <div className="nokkeltall lonn-tall">
        <div className="kort">
          <div className="etikett">Bruttolønn</div>
          <div className="verdi">{kr(d.sum.brutto)}</div>
          <div className="under">
            {d.sum.antall} {d.sum.antall === 1 ? "lønnsslipp" : "lønnsslipper"}
          </div>
        </div>
        <div className="kort">
          <div className="etikett">Forskuddstrekk</div>
          <div className="verdi">{kr(d.sum.skattetrekk)}</div>
          <div className="under">Til Skatteetaten {dato(d.frister.skattetrekk)}</div>
        </div>
        <div className="kort">
          <div className="etikett">Til utbetaling</div>
          <div className="verdi">{kr(d.sum.netto)}</div>
          <div className="under">Til de ansatte {dato(d.utbetalingsdato)}</div>
        </div>
        <div className="kort">
          <div className="etikett">Arbeidsgiveravgift</div>
          <div className="verdi">{kr(d.sum.aga)}</div>
          <div className="under">
            OTP {kr(d.sum.otp)} · feriepenger opptjent {kr(d.sum.feriepenger_opptjent)}
          </div>
        </div>
      </div>

      <div className="knapper lonn-knapper">
        {kanEndre && (
          <>
            <button type="button" className="primar" disabled={h.opptatt || !d.slipper.length} onClick={() => settGodkjenn(true)}>
              Godkjenn lønnen
            </button>
            <button type="button" disabled={h.opptatt} onClick={() => kjor(() => api("POST", `${sti}/beregn`), "Regnet ut på nytt med det som er registrert nå.")}>
              Regn ut på nytt
            </button>
            <button type="button" disabled={h.opptatt} onClick={() => settLeggTil(true)}>
              Legg til ansatt
            </button>
            <button type="button" disabled={h.opptatt} onClick={() => settEndre(true)}>
              Endre
            </button>
          </>
        )}
        {admin && !utkast && (
          <button
            type="button"
            disabled={h.opptatt}
            onClick={() =>
              confirm(`Åpne lønnen for ${kjoringNavn(d)} igjen? De ansatte ser ikke lønnsslippene før den er godkjent på nytt, og timene kan endres igjen.`) &&
              void kjor(() => api("POST", `${sti}/gjenapne`), "Kjøringen er åpnet igjen.")
            }
          >
            Åpne igjen
          </button>
        )}
        {!utkast && d.slipper.some((s) => s.netto > 0) && (
          <button type="button" className="primar" disabled={h.opptatt} onClick={() => void betalingsfil()}>
            Betalingsfil til nettbanken
          </button>
        )}
        <button type="button" disabled={h.opptatt || !d.slipper.length} onClick={() => void h.kjor(() => lastNed(`${sti}/csv`, `${filnavn}.csv`))}>
          Last ned (CSV)
        </button>
        {kanEndre && (
          <button
            type="button"
            className="fare"
            disabled={h.opptatt}
            onClick={async () => {
              if (!confirm(`Slette utkastet til lønn for ${kjoringNavn(d)}?`)) return;
              let slettet = false;
              await h.kjor(async () => {
                await api("DELETE", sti);
                slettet = true;
              });
              if (slettet) tilbake();
            }}
          >
            Slett utkastet
          </button>
        )}
      </div>

      {!utkast && d.slipper.length > 0 && <LonnBetalinger sti={sti} kanEndre={admin} versjon={`${d.godkjent_at}-${d.betalingsfil_antall}`} />}

      {!d.slipper.length ? (
        <div className="kort">
          <Tom ikon={<IkonLonn storrelse={22} />} tittel="Ingen lønnsslipper">
            <p>
              {d.type === "ekstra"
                ? "Legg til de ansatte som skal ha noe utbetalt i denne kjøringen."
                : "Ingen ansatte har lønn denne måneden: sjekk månedslønnen og timelønnen på de ansatte, og at timene er godkjent."}
            </p>
          </Tom>
        </div>
      ) : (
        <div className="lonn-slipper">
          {d.slipper.map((s) => (
            <SlippKort
              key={s.id}
              s={s}
              apen={apne.has(s.id)}
              veksle={() => veksle(s.id)}
              kanEndre={kanEndre}
              opptatt={h.opptatt}
              arter={arter.data ?? []}
              sti={sti}
              kjor={kjor}
              pdf={() => void h.kjor(() => apneSlipp(org!.id, s.id))}
            />
          ))}
        </div>
      )}
      <KjoringBokforing kjoringId={d.id} godkjent={!utkast} godkjentAt={d.godkjent_at} />
      <p className="liten dempet">
        Fastlønn for arbeidsdagene den ansatte er ansatt, timelønn og overtid fra de godkjente timene som ikke er lønnet, faste tillegg, sykepenger i arbeidsgiverperioden og
        omsorgsdager for dem med timelønn, og feriepenger i juni. Skattetrekket etter skattekortet (50 % uten skattekort), OTP med {tallTekst(d.otp_prosent)} %, feriepenger med{" "}
        {tallTekst(d.feriepenger_prosent)} % og arbeidsgiveravgift i {AGA_SONER[d.aga_sone] ?? `sone ${d.aga_sone}`}. Satsene står under{" "}
        <Link to="/innstillinger?fane=personal">Innstillinger → Ansatte og timer</Link>.
      </p>

      <Dialog apen={godkjenn} lukk={() => settGodkjenn(false)} tittel={`Godkjenne lønnen for ${kjoringNavn(d)}?`}>
        <div className="summer lonn-summer">
          <div>
            <span>Lønnsslipper</span>
            <span>{d.sum.antall}</span>
          </div>
          <div>
            <span>Bruttolønn</span>
            <span>{kr(d.sum.brutto)}</span>
          </div>
          <div>
            <span>Forskuddstrekk</span>
            <span>{kr(d.sum.skattetrekk)}</span>
          </div>
          <div className="total">
            <span>Til utbetaling {dato(d.utbetalingsdato)}</span>
            <span>{kr(d.sum.netto)}</span>
          </div>
        </div>
        {d.sum.merknader > 0 && (
          <p className="melding info">
            {d.sum.merknader} {d.sum.merknader === 1 ? "merknad" : "merknader"} på lønnsslippene. Se over dem før du godkjenner.
          </p>
        )}
        <p className="liten dempet">
          Lønnen regnes ut på nytt først. Kjøringen låses, timene merkes som lønnet, og de ansatte får lønnsslippen (med varsel). Betal lønnen med betalingsfila i
          nettbanken, og skattetrekket til Skatteetaten senest {dato(d.frister.skattetrekk)}.
        </p>
        <div className="knapper">
          <button
            type="button"
            className="primar"
            disabled={h.opptatt}
            onClick={async () => {
              const ny = await kjor(() => api("POST", `${sti}/godkjenn`), "Lønnen er godkjent, og de ansatte har fått lønnsslippen.");
              if (ny) settGodkjenn(false);
            }}
          >
            {h.opptatt ? "Godkjenner …" : "Godkjenn"}
          </button>
          <button type="button" onClick={() => settGodkjenn(false)}>
            Avbryt
          </button>
        </div>
        <Feil melding={h.feil} />
      </Dialog>
      <Dialog apen={endre} lukk={() => settEndre(false)} tittel="Endre lønnskjøringen">
        <EndreKjoring
          k={d}
          lagre={async (b) => {
            const ny = await kjor(() => api("PATCH", sti, b), "Endret, og regnet ut på nytt.");
            if (ny) settEndre(false);
          }}
          opptatt={h.opptatt}
          feil={h.feil}
        />
      </Dialog>
      <Dialog apen={leggTil} lukk={() => settLeggTil(false)} tittel="Legg til en ansatt">
        <LeggTilAnsatt
          har={new Set(d.slipper.map((s) => s.ansatt_id))}
          velg={async (ansattId) => {
            const ny = await kjor(() => api("POST", `${sti}/slipper`, { ansatt_id: ansattId }));
            if (ny) {
              settLeggTil(false);
              const s = ny.slipper.find((x) => x.ansatt_id === ansattId);
              if (s) settApne(new Set([...apne, s.id]));
            }
          }}
          opptatt={h.opptatt}
          feil={h.feil}
        />
      </Dialog>
    </>
  );
}

function EndreKjoring({ k, lagre, opptatt, feil }: { k: Kjoring; lagre: (b: Record<string, unknown>) => void; opptatt: boolean; feil: string | null }) {
  const [utbetalt, settUtbetalt] = useState(k.utbetalingsdato);
  const [feriepenger, settFeriepenger] = useState(k.feriepenger);
  const [halv, settHalv] = useState(k.halv_skatt);
  const [notat, settNotat] = useState(k.notat ?? "");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        lagre({ utbetalingsdato: utbetalt, feriepenger, halv_skatt: halv, notat: notat.trim() || null });
      }}
    >
      <label>
        Utbetalingsdato
        <input type="date" required value={utbetalt} onChange={(e) => settUtbetalt(e.target.value)} />
      </label>
      <label>
        <input type="checkbox" checked={feriepenger} onChange={(e) => settFeriepenger(e.target.checked)} />
        Utbetal feriepengene for {Number(utbetalt.slice(0, 4)) - 1}
      </label>
      <label>
        <input type="checkbox" checked={halv} onChange={(e) => settHalv(e.target.checked)} />
        Halv skatt (halvt tabelltrekk, vanligvis i desember)
      </label>
      <label>
        Notat
        <input value={notat} maxLength={500} onChange={(e) => settNotat(e.target.value)} />
      </label>
      <Feil melding={feil} />
      <div className="knapper">
        <button type="submit" className="primar" disabled={opptatt}>
          Lagre og regn ut
        </button>
      </div>
    </form>
  );
}

function LeggTilAnsatt({ har, velg, opptatt, feil }: { har: Set<string>; velg: (id: string) => void; opptatt: boolean; feil: string | null }) {
  const { org } = useKonto();
  const ansatte = useData(
    () => hent<{ id: string; ansattnummer: number; fornavn: string; etternavn: string; aktiv: boolean; arbeidstaker: boolean }[]>(`/org/${org!.id}/ansatte`),
    [org?.id],
  );
  const [valgt, settValgt] = useState("");
  if (ansatte.feil) return <Feil melding={ansatte.feil} />;
  if (!ansatte.data) return <Laster />;
  const kan = ansatte.data.filter((a) => a.arbeidstaker && !har.has(a.id));
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (valgt) velg(valgt);
      }}
    >
      {kan.length ? (
        <label>
          Ansatt
          <select required value={valgt} onChange={(e) => settValgt(e.target.value)}>
            <option value="">Velg …</option>
            {kan.map((a) => (
              <option key={a.id} value={a.id}>
                {a.fornavn} {a.etternavn} ({a.ansattnummer}){a.aktiv ? "" : " – sluttet"}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <p className="dempet">Alle de ansatte har alt en lønnsslipp i kjøringen.</p>
      )}
      <p className="liten dempet">Lønnsslippen regnes ut som for de andre. Legg til linjer etterpå (f.eks. en bonus).</p>
      <Feil melding={feil} />
      <div className="knapper">
        <button type="submit" className="primar" disabled={opptatt || !valgt}>
          Legg til
        </button>
      </div>
    </form>
  );
}

// --- Én lønnsslipp i kjøringen ------------------------------------------------------------------

function SlippKort({
  s,
  apen,
  veksle,
  kanEndre,
  opptatt,
  arter,
  sti,
  kjor,
  pdf,
}: {
  s: Slipp;
  apen: boolean;
  veksle: () => void;
  kanEndre: boolean;
  opptatt: boolean;
  arter: Lonnsart[];
  sti: string;
  kjor: (fn: () => Promise<Kjoring>, ok?: string) => Promise<Kjoring | undefined>;
  pdf: () => void;
}) {
  const [linje, settLinje] = useState<Linje | "ny" | null>(null);
  const [trekk, settTrekk] = useState(false);
  const linjer = s.linjer.filter(synlig);
  const navnPaArt = (kode: string) => arter.find((a) => a.kode === kode)?.navn ?? kode;
  const tekstAntall = (l: Linje) => (l.antall == null ? "" : prosentArt(l.lonnsart) ? kr(l.antall) : tallTekst(l.antall, Math.abs(l.antall) < 1 ? 4 : 2));
  const tekstSats = (l: Linje) => (l.sats == null ? "" : prosentArt(l.lonnsart) ? `${tallTekst(l.sats)} %` : kr(l.sats));

  return (
    <section className={`kort lonn-slipp${apen ? " apen" : ""}`}>
      <button type="button" className="lonn-slipp-topp" aria-expanded={apen} onClick={veksle}>
        <span className="lonn-slipp-navn">
          <strong>{s.navn}</strong>
          <span className="liten dempet">
            Nr. {s.ansattnummer} · {s.trekkmetode || "Uten trekk"}
          </span>
        </span>
        {s.merknader.length > 0 && (
          <span className="merke merke-advarsel lonn-merke" title={s.merknader.join("\n")}>
            {s.merknader.length} å sjekke
          </span>
        )}
        <span className="lonn-slipp-tall">
          <span>
            <small>Brutto</small>
            {kr(s.brutto)}
          </span>
          <span>
            <small>Trekk</small>
            {kr(s.skattetrekk)}
          </span>
          <span className="sterk">
            <small>Utbetales</small>
            {kr(s.netto)}
          </span>
        </span>
      </button>
      {apen && (
        <div className="lonn-slipp-innhold">
          {s.merknader.length > 0 && (
            <ul className="lonn-merknader">
              {s.merknader.map((m, i) => (
                <li key={i}>
                  <IkonVarsel storrelse={15} /> {m}
                </li>
              ))}
            </ul>
          )}
          <div className="tabell">
            <table className="lonn-linjer">
              <thead>
                <tr>
                  <th>Beskrivelse</th>
                  <th className="hoyre">Antall</th>
                  <th className="hoyre lonn-sats">Sats</th>
                  <th className="hoyre">Beløp</th>
                  {kanEndre && <th aria-label="Handlinger" />}
                </tr>
              </thead>
              <tbody>
                {linjer.map((l) => (
                  <tr key={l.id} className={l.fjernet ? "fjernet" : undefined}>
                    <td>
                      {l.tekst}
                      {l.fjernet ? (
                        <span className="merke merke-noytral lonn-merke">Fjernet</span>
                      ) : l.kilde === "manuell" ? (
                        <span className="merke merke-info lonn-merke">{l.nokkel ? "Endret" : "Lagt til"}</span>
                      ) : null}
                      {!l.tekst.toLowerCase().startsWith(navnPaArt(l.lonnsart).toLowerCase()) && <span className="lonn-art">{navnPaArt(l.lonnsart)}</span>}
                    </td>
                    <td className="tall">{tekstAntall(l)}</td>
                    <td className="tall lonn-sats">{tekstSats(l)}</td>
                    <td className="tall">{kr(l.belop)}</td>
                    {kanEndre && (
                      <td className="lonn-handlinger">
                        {l.kilde === "manuell" && l.nokkel ? (
                          <button
                            type="button"
                            className="lenke"
                            disabled={opptatt}
                            onClick={() => void kjor(() => api("POST", `${sti}/linjer/${l.id}/tilbakestill`))}
                            title="Tilbake til det utregnede"
                          >
                            Angre
                          </button>
                        ) : null}
                        {!l.fjernet && (
                          <>
                            <button type="button" className="lenke" disabled={opptatt} onClick={() => settLinje(l)}>
                              Endre
                            </button>
                            <button
                              type="button"
                              className="lenke fare-lenke"
                              disabled={opptatt}
                              onClick={() => void kjor(() => api("DELETE", `${sti}/linjer/${l.id}`))}
                              title={l.kilde === "auto" ? "Fjern linjen (den regnes ikke ut på nytt)" : "Slett linjen"}
                            >
                              Fjern
                            </button>
                          </>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="lonn-slipp-bunn">
            <div className="lonn-opptjent liten dempet">
              <div>
                Feriepengegrunnlag {kr(s.feriepengegrunnlag)} (opptjent {kr(s.feriepenger_opptjent)})
              </div>
              <div>
                OTP {kr(s.otp)} · arbeidsgiveravgift {kr(s.aga)}
              </div>
              {s.antall_timeforinger > 0 && (
                <div>
                  {s.antall_timeforinger} {s.antall_timeforinger === 1 ? "timeføring" : "timeføringer"} lønnes
                </div>
              )}
              <div>Konto {s.kontonr ? s.kontonr.replace(/^(\d{4})(\d{2})(\d{5})$/, "$1.$2.$3") : "mangler"}</div>
            </div>
            <div className="summer lonn-summer">
              <div>
                <span>Bruttolønn</span>
                <span>{kr(s.brutto)}</span>
              </div>
              <div>
                <span>
                  Forskuddstrekk
                  {s.skattetrekk_manuell && <span className="merke merke-info lonn-merke">For hånd</span>}
                </span>
                <span>{kr(-s.skattetrekk)}</span>
              </div>
              {s.utgifter !== 0 && (
                <div>
                  <span>Utgifter</span>
                  <span>{kr(s.utgifter)}</span>
                </div>
              )}
              {s.trekk_etter_skatt !== 0 && (
                <div>
                  <span>Trekk etter skatt</span>
                  <span>{kr(s.trekk_etter_skatt)}</span>
                </div>
              )}
              <div className="total">
                <span>Utbetales</span>
                <span>{kr(s.netto)}</span>
              </div>
            </div>
          </div>
          <div className="knapper">
            {kanEndre && (
              <>
                <button type="button" disabled={opptatt} onClick={() => settLinje("ny")}>
                  <IkonPluss storrelse={16} /> Legg til linje
                </button>
                <button type="button" disabled={opptatt} onClick={() => settTrekk(true)}>
                  Endre skattetrekket
                </button>
              </>
            )}
            <button type="button" disabled={opptatt} onClick={pdf}>
              Lønnsslippen (PDF)
            </button>
          </div>
        </div>
      )}
      <Dialog apen={!!linje} lukk={() => settLinje(null)} tittel={linje === "ny" ? `Ny linje for ${s.navn}` : "Endre linjen"}>
        {linje && (
          <LinjeSkjema
            linje={linje === "ny" ? null : linje}
            arter={arter}
            lagre={async (b) => {
              const ny = await kjor(() => (linje === "ny" ? api("POST", `${sti}/linjer`, { ...b, slipp_id: s.id }) : api("PATCH", `${sti}/linjer/${linje.id}`, b)));
              if (ny) settLinje(null);
            }}
            opptatt={opptatt}
          />
        )}
      </Dialog>
      <Dialog apen={trekk} lukk={() => settTrekk(false)} tittel={`Skattetrekket for ${s.navn}`}>
        <TrekkSkjema
          s={s}
          lagre={async (belop) => {
            const ny = await kjor(() => api("PUT", `${sti}/slipper/${s.id}/skattetrekk`, { belop }));
            if (ny) settTrekk(false);
          }}
          opptatt={opptatt}
        />
      </Dialog>
    </section>
  );
}

function LinjeSkjema({ linje, arter, lagre, opptatt }: { linje: Linje | null; arter: Lonnsart[]; lagre: (b: Record<string, unknown>) => void; opptatt: boolean }) {
  const valgbare = arter.filter((a) => a.manuell);
  const [art, settArt] = useState(linje?.lonnsart ?? "bonus");
  const valgtArt = arter.find((a) => a.kode === art);
  const minus = (valgtArt?.fortegn ?? 1) < 0;
  const komma = (n: number | null | undefined) => (n == null ? "" : String(n).replace(".", ","));
  // Feriepengene er en prosent av grunnlaget: bare beløpet kan endres.
  const bareBelop = !!linje && prosentArt(linje.lonnsart);
  const harAntall = !!linje && linje.antall != null && linje.sats != null && !bareBelop;
  const [tekst, settTekst] = useState(linje?.tekst ?? "");
  const [antall, settAntall] = useState(komma(linje?.antall));
  const [sats, settSats] = useState(komma(linje?.sats));
  // Med antall og sats regnes beløpet ut; et beløp som skrives inn, gjelder i stedet.
  const [belop, settBelop] = useState(linje && !harAntall ? komma(minus ? Math.abs(linje.belop) : linje.belop) : "");
  const [feil, settFeil] = useState<string | null>(null);
  const tallEller = (v: string) => (v.trim() === "" ? null : tall(v));
  const a = tallEller(antall);
  const s = tallEller(sats);
  const endret = !linje || a !== (linje.antall ?? null) || s !== (linje.sats ?? null);
  const utregnet = a != null && s != null ? Math.round(a * s * 100) / 100 : null;
  const forslag = endret ? utregnet : linje ? Math.abs(linje.belop) : null;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const b = tallEller(belop);
        if ([a, s, b].some((x) => x != null && !Number.isFinite(x))) return settFeil("Skriv tallene med siffer, f.eks. 1500 eller 37,5");
        if (!linje && b == null && (a == null || s == null)) return settFeil("Skriv beløpet, eller antall og sats");
        settFeil(null);
        if (!linje) return lagre({ lonnsart: art, tekst: tekst.trim() || null, antall: a, sats: s, belop: b });
        const kropp: Record<string, unknown> = { tekst: tekst.trim() || linje.tekst };
        if (!bareBelop && a !== (linje.antall ?? null)) kropp.antall = a;
        if (!bareBelop && s !== (linje.sats ?? null)) kropp.sats = s;
        if (b != null) kropp.belop = b;
        lagre(kropp);
      }}
    >
      {!linje ? (
        <label>
          Lønnsart
          <select value={art} onChange={(e) => settArt(e.target.value)}>
            {valgbare.map((x) => (
              <option key={x.kode} value={x.kode}>
                {x.navn}
              </option>
            ))}
          </select>
          {valgtArt && (
            <span className="felt-hjelp">
              {valgtArt.type === "utgift"
                ? "Utbetales i tillegg, uten skatt og arbeidsgiveravgift."
                : valgtArt.type === "trekk"
                  ? "Trekkes fra det som utbetales, etter skatt."
                  : valgtArt.fortegn < 0
                    ? "Trekkes fra bruttolønnen."
                    : "Med i bruttolønnen og skattetrekket."}
            </span>
          )}
        </label>
      ) : (
        <p className="dempet liten">
          {arter.find((x) => x.kode === linje.lonnsart)?.navn ?? linje.lonnsart}
          {linje.kilde === "auto" && ". En utregnet linje som endres, regnes ikke ut på nytt (Angre gjør den utregnet igjen)."}
        </p>
      )}
      <label>
        Tekst på lønnsslippen
        <input value={tekst} maxLength={120} placeholder={valgtArt?.navn} onChange={(e) => settTekst(e.target.value)} />
      </label>
      <div className="rad">
        {!bareBelop && (
          <>
            <label>
              Antall
              <input inputMode="decimal" value={antall} onChange={(e) => settAntall(e.target.value)} />
            </label>
            <label>
              Sats
              <input inputMode="decimal" value={sats} onChange={(e) => settSats(e.target.value)} />
            </label>
          </>
        )}
        <label>
          Beløp{minus ? " (trekkes)" : ""}
          <input inputMode="decimal" value={belop} placeholder={forslag != null ? kr(forslag) : undefined} onChange={(e) => settBelop(e.target.value)} />
        </label>
      </div>
      <p className="liten dempet">
        {bareBelop ? "Skriv beløpet." : "Skriv antall og sats, eller beløpet."}
        {minus ? " Trekk skrives uten minus." : ""}
      </p>
      <Feil melding={feil} />
      <div className="knapper">
        <button type="submit" className="primar" disabled={opptatt}>
          {linje ? "Lagre" : "Legg til"}
        </button>
      </div>
    </form>
  );
}

function TrekkSkjema({ s, lagre, opptatt }: { s: Slipp; lagre: (belop: number | null) => void; opptatt: boolean }) {
  const [belop, settBelop] = useState(String(s.skattetrekk).replace(".", ","));
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const b = tall(belop);
        if (Number.isFinite(b) && b >= 0) lagre(b);
      }}
    >
      <p className="dempet liten">
        Utregnet: {s.trekkmetode.replace(/ – endret for hånd$/, "")}, av et trekkgrunnlag på {kr(s.trekkgrunnlag)}. Sett trekket for hånd når skattekortet sier noe annet, eller
        den ansatte har bedt om et høyere trekk.
      </p>
      <label>
        Forskuddstrekk (hele kroner)
        <input inputMode="numeric" required value={belop} onChange={(e) => settBelop(e.target.value)} />
      </label>
      <div className="knapper">
        <button type="submit" className="primar" disabled={opptatt}>
          Bruk dette trekket
        </button>
        {s.skattetrekk_manuell && (
          <button type="button" disabled={opptatt} onClick={() => lagre(null)}>
            Tilbake til det utregnede
          </button>
        )}
      </div>
    </form>
  );
}

// --- Den ansatte: sine egne lønnsslipper -----------------------------------------------------

function MineSlipper() {
  const { org } = useKonto();
  const liste = useData(() => hent<MinSlipp[]>(`/org/${org!.id}/lonn/mine`), [org?.id], { oppdater: true });
  const [valgt, settValgt] = useState<MinSlipp | null>(null);
  const h = useHandling();
  if (liste.feil) return <Feil melding={liste.feil} />;
  if (!liste.data) return <Laster />;
  if (!liste.data.length)
    return (
      <div className="kort">
        <Tom ikon={<IkonLonn storrelse={22} />} tittel="Ingen lønnsslipper ennå">
          <p>Lønnsslippen kommer her (med varsel) når lønnen er godkjent.</p>
        </Tom>
      </div>
    );
  return (
    <>
      <MineAarsoversikter />
      <Feil melding={h.feil} />
      <div className="kort liste">
        {liste.data.map((s) => (
          <div key={s.id} className="liste-rad-ramme">
            <button type="button" className="liste-rad" onClick={() => settValgt(s)}>
              <span className="linje">
                <span className="tittel">{maaned(s.periode)}</span>
                <span className="belop">{kr(s.netto)}</span>
              </span>
              <span className="linje">
                <span className="under">
                  Utbetalt {dato(s.utbetalingsdato)} · brutto {kr(s.brutto)}
                </span>
              </span>
            </button>
            <button type="button" className="lenke lonn-pdf" onClick={() => void h.kjor(() => apneSlipp(org!.id, s.id))}>
              PDF
            </button>
          </div>
        ))}
      </div>
      <Dialog bred apen={!!valgt} lukk={() => settValgt(null)} tittel={valgt ? `Lønnsslipp for ${maaned(valgt.periode)}` : "Lønnsslipp"}>
        {valgt && <SlippVisning id={valgt.id} />}
      </Dialog>
    </>
  );
}

function SlippVisning({ id }: { id: string }) {
  const { org } = useKonto();
  const d = useData(() => hent<SlippDetaljer>(`/org/${org!.id}/lonn/slipper/${id}`), [org?.id, id]);
  const h = useHandling();
  if (d.feil) return <Feil melding={d.feil} />;
  if (!d.data) return <Laster />;
  const s = d.data;
  const rad = (navn: ReactNode, verdi: number, klasse?: string) => (
    <div className={klasse}>
      <span>{navn}</span>
      <span>{kr(verdi)}</span>
    </div>
  );
  return (
    <div className="lonn-visning">
      <p className="dempet liten">
        Utbetalt {dato(s.utbetalingsdato)} til konto {s.kontonr ? s.kontonr.replace(/^(\d{4})(\d{2})(\d{5})$/, "$1.$2.$3") : "–"} · {s.trekkmetode}
      </p>
      <div className="tabell">
        <table className="lonn-linjer">
          <thead>
            <tr>
              <th>Beskrivelse</th>
              <th className="hoyre">Antall</th>
              <th className="hoyre">Beløp</th>
            </tr>
          </thead>
          <tbody>
            {s.linjer.filter(synlig).map((l) => (
              <tr key={l.id}>
                <td>{l.tekst}</td>
                <td className="tall">{l.antall == null ? "" : prosentArt(l.lonnsart) ? `${tallTekst(l.sats ?? 0)} % av ${kr(l.antall)}` : tallTekst(l.antall, 4)}</td>
                <td className="tall">{kr(l.belop)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="summer lonn-summer">
        {rad("Bruttolønn", s.brutto)}
        {rad("Forskuddstrekk", -s.skattetrekk)}
        {s.utgifter !== 0 && rad("Utgifter", s.utgifter)}
        {s.trekk_etter_skatt !== 0 && rad("Trekk etter skatt", s.trekk_etter_skatt)}
        {rad("Utbetalt", s.netto, "total")}
      </div>
      <h3>Hittil i {s.utbetalingsdato.slice(0, 4)}</h3>
      <div className="summer lonn-summer">
        {rad("Bruttolønn", s.hittil.brutto)}
        {rad("Forskuddstrekk", s.hittil.skattetrekk)}
        {rad("Feriepengegrunnlag", s.hittil.feriepengegrunnlag)}
      </div>
      <p className="liten dempet">
        Opptjent denne måneden: feriepenger {kr(s.feriepenger_opptjent)}
        {s.otp ? ` og pensjon (OTP) ${kr(s.otp)} fra arbeidsgiveren` : ""}.
      </p>
      <Feil melding={h.feil} />
      <div className="knapper">
        <button type="button" className="primar" disabled={h.opptatt} onClick={() => void h.kjor(() => apneSlipp(org!.id, s.id))}>
          Last ned som PDF
        </button>
      </div>
    </div>
  );
}
