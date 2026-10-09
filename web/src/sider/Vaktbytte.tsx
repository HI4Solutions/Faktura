// Vaktbytte (server/src/vaktbytte.ts, 0060_vaktbytte.sql): den ansatte gir bort eller bytter en
// vakt (eller en fast arbeidsdag) med en kollega med samme rolle. Tilbudet lages fra «Mine vakter»
// (ByttDialog), åpne tilbud fra kolleger står blant de ledige vaktene, og fanen «Bytter» viser det
// som er til den ansatte, det de selv har tilbudt, og byttene som venter på godkjenning (eier og
// administrator), med advarslene etter arbeidsmiljøloven byttet gir.
//
// Lederen (eier og administrator) gir bort eller bytter vakter rett fra vaktplanen (LederByttDialog,
// 0072_vaktbytte_leder.sql): uten godkjenning, med alle aktive i organisasjonen, og med advarslene
// byttet gir før det bekreftes.
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { api, hent } from "../api";
import { Dialog, Feil, Laster, Tom, useData, useHandling } from "../felles";
import { useKonto } from "../konto";
import { IkonHake, IkonRullering, IkonVarsel } from "../ikoner";
import { timer, visDag } from "../uke";

export type Innstilling = "av" | "godkjenning" | "fritt";
export type Bytte = {
  id: string;
  status: "tilbudt" | "akseptert" | "godkjent" | "avslatt" | "avvist" | "trukket" | "utgatt";
  fra_ansatt: string;
  fra_navn: string;
  til_ansatt: string | null; // null: alle med samme rolle
  til_navn: string | null;
  tatt_av: string | null;
  tatt_av_navn: string | null;
  vakt_id: string;
  dato: string;
  fra: string;
  til: string;
  timer: number;
  oppgave: string | null;
  mot_vakt_id: string | null; // et bytte: vakten den som gir bort, får igjen
  mot_dato: string | null;
  mot_fra: string | null;
  mot_til: string | null;
  mot_timer: number | null;
  mot_oppgave: string | null;
  melding: string | null;
  grunn: string | null;
  opprettet: string;
  svart_at: string | null;
  behandlet_at: string | null;
  behandlet_av_navn: string | null;
  hindring: string | null; // hva som hindrer deg i å ta vakten
  advarsler: string[]; // for den som godkjenner
  av_leder: boolean; // byttet er gjort av lederen i vaktplanen
};
export type ByttSvar = { innstilling: Innstilling; bytter: Bytte[] };
// Vakten (eller den faste arbeidsdagen, uten id) som skal byttes.
export type ByttVakt = { id: string | null; dato: string; fra: string | null; til: string | null; timer: number };

type Kollega = { ansatt_id: string; navn: string; hindring: string | null };
type Kandidat = { vakt_id: string | null; ansatt_id: string; navn: string; dato: string; fra: string; til: string; timer: number; oppgave: string | null; hel_dag: boolean; hindring: string | null };

export const aapen = (b: Bytte) => b.status === "tilbudt" || b.status === "akseptert";
// Det åpne tilbudet på en vakt (egen), om det er ett.
export const aapentPaa = (bytter: Bytte[] | undefined, vakt: string) => bytter?.find((b) => b.vakt_id === vakt && aapen(b));
// Åpne tilbud fra kolleger (blant de ledige vaktene).
export const fraKolleger = (bytter: Bytte[] | undefined, egen: string | null) =>
  (bytter ?? []).filter((b) => b.status === "tilbudt" && !b.til_ansatt && b.fra_ansatt !== egen);

// En hel dag (fast arbeidsdag uten klokkeslett): bare datoen.
const vaktTekst = (dato: string, fra: string | null, til: string | null) => `${visDag(dato)}${fra && til ? ` ${fra}–${til}` : ""}`;
// Midt i en setning: «mot tir. 13. okt. 08:00–16:00».
const liten = (t: string) => t.charAt(0).toLowerCase() + t.slice(1);
const motTekst = (b: Bytte) => (b.mot_dato ? liten(vaktTekst(b.mot_dato, b.mot_fra, b.mot_til)) : "");

export function statusMerke(b: Bytte) {
  switch (b.status) {
    case "tilbudt":
      return { tekst: b.til_ansatt ? "Venter på svar" : "Åpent tilbud", klasse: "merke-info" };
    case "akseptert":
      return { tekst: "Venter på godkjenning", klasse: "merke-advarsel" };
    case "godkjent":
      return { tekst: b.mot_vakt_id ? "Byttet" : b.av_leder ? "Gitt bort" : "Tatt over", klasse: "merke-ok" };
    case "avslatt":
      return { tekst: "Nei takk", klasse: "merke-noytral" };
    case "avvist":
      return { tekst: "Ikke godkjent", klasse: "merke-fare" };
    case "trukket":
      return { tekst: "Trukket tilbake", klasse: "merke-noytral" };
    default:
      return { tekst: "Utgått", klasse: "merke-noytral" };
  }
}

// Hvem som gir vakten til hvem, sett fra den innloggede («Du», «deg»); i fortid når byttet er gjort.
function beskrivelse(b: Bytte, egen: string | null) {
  const navn = (id: string | null, n: string | null, objekt = false) => (id && id === egen ? (objekt ? "deg" : "Du") : (n ?? ""));
  const gjort = b.status === "godkjent";
  if (b.av_leder) {
    const av = b.behandlet_av_navn ?? "Lederen";
    if (b.mot_vakt_id) return `${av} byttet vakten mellom ${navn(b.fra_ansatt, b.fra_navn, true)} og ${navn(b.tatt_av, b.tatt_av_navn, true)}, mot ${motTekst(b)}`;
    return `${av} ga vakten fra ${navn(b.fra_ansatt, b.fra_navn, true)} til ${navn(b.tatt_av, b.tatt_av_navn, true)}`;
  }
  if (b.mot_vakt_id) {
    if (gjort) return `${navn(b.fra_ansatt, b.fra_navn)} byttet med ${navn(b.til_ansatt, b.til_navn, true)} mot ${motTekst(b)}`;
    if (b.til_ansatt === egen) return `${b.fra_navn} vil bytte mot vakten din ${motTekst(b)}`;
    return `${navn(b.fra_ansatt, b.fra_navn)} vil bytte med ${navn(b.til_ansatt, b.til_navn, true)} mot ${motTekst(b)}`;
  }
  if (b.tatt_av) return `${navn(b.tatt_av, b.tatt_av_navn)} ${gjort ? "tok" : "tar"} vakten fra ${navn(b.fra_ansatt, b.fra_navn, true)}`;
  if (b.til_ansatt) return `${navn(b.fra_ansatt, b.fra_navn)} gir vakten til ${navn(b.til_ansatt, b.til_navn, true)}`;
  return `${navn(b.fra_ansatt, b.fra_navn)} gir bort vakten til alle med samme rolle`;
}

// --- Tilby en vakt ------------------------------------------------------------------

export function ByttDialog({
  vakt,
  innstilling,
  lukk,
  ferdig,
}: {
  vakt: ByttVakt | null;
  innstilling: Innstilling;
  lukk: () => void;
  ferdig: (melding: string) => void;
}) {
  return (
    <Dialog apen={!!vakt} lukk={lukk} tittel="Bytt eller gi bort vakten">
      {vakt && <ByttSkjema key={vakt.id ?? vakt.dato} vakt={vakt} innstilling={innstilling} lukk={lukk} ferdig={ferdig} />}
    </Dialog>
  );
}

const nokkel = (k: Kandidat) => k.vakt_id ?? `${k.ansatt_id}|${k.dato}`;

function ByttSkjema({ vakt, innstilling, lukk, ferdig }: { vakt: ByttVakt; innstilling: Innstilling; lukk: () => void; ferdig: (melding: string) => void }) {
  const { org } = useKonto();
  const sti = vakt.id ? `vakt=${vakt.id}` : `dato=${vakt.dato}`;
  const m = useData(() => hent<{ kolleger: Kollega[]; vakter: Kandidat[] }>(`/org/${org!.id}/vaktbytter/muligheter?${sti}`), [org?.id, sti]);
  const [type, settType] = useState<"gi" | "bytt">("gi");
  const [til, settTil] = useState(""); // tom: alle med samme rolle
  const [mot, settMot] = useState("");
  const [melding, settMelding] = useState("");
  const h = useHandling();

  if (m.feil) return <Feil melding={m.feil} />;
  if (!m.data) return <Laster />;
  const kolleger = m.data.kolleger;
  const mulige = m.data.vakter.filter((k) => !k.hindring);
  // Vaktene en kan bytte mot, per kollega.
  const perKollega = new Map<string, Kandidat[]>();
  for (const k of mulige) perKollega.set(k.navn, [...(perKollega.get(k.navn) ?? []), k]);

  const send = (e: FormEvent) => {
    e.preventDefault();
    h.kjor(async () => {
      const valgt = type === "bytt" ? mulige.find((k) => nokkel(k) === mot) : undefined;
      if (type === "bytt" && !valgt) throw new Error("Velg vakten du vil bytte mot");
      const b = await api<Bytte>("POST", `/org/${org!.id}/vaktbytter`, {
        ...(vakt.id ? { vakt_id: vakt.id } : { dato: vakt.dato }),
        til_ansatt: valgt ? valgt.ansatt_id : til || null,
        ...(valgt ? (valgt.vakt_id ? { mot_vakt_id: valgt.vakt_id } : { mot_dato: valgt.dato }) : {}),
        melding: melding.trim() || undefined,
      });
      ferdig(
        b.mot_vakt_id
          ? `Du har spurt ${b.til_navn} om å bytte. Du får beskjed når ${b.til_navn?.split(" ")[0]} har svart.`
          : b.til_ansatt
            ? `Du har spurt ${b.til_navn} om å ta vakten.`
            : "Vakten er tilbudt kollegaene dine. Du får beskjed når noen tar den.",
      );
    });
  };

  return (
    <form onSubmit={send}>
      <p className="bytte-vakt">
        <strong>{vaktTekst(vakt.dato, vakt.fra, vakt.til)}</strong> <span className="dempet">· {timer(vakt.timer)}</span>
      </p>
      <div className="faner valg" role="radiogroup" aria-label="Hva vil du?">
        <button type="button" role="radio" aria-checked={type === "gi"} className={type === "gi" ? "valgt" : undefined} onClick={() => settType("gi")}>
          Gi bort
        </button>
        <button type="button" role="radio" aria-checked={type === "bytt"} className={type === "bytt" ? "valgt" : undefined} onClick={() => settType("bytt")}>
          Bytt mot en annen vakt
        </button>
      </div>
      {!kolleger.length ? (
        <p className="melding info">Ingen kolleger med samme rolle har innlogging ennå, så det er ingen å gi vakten til.</p>
      ) : type === "gi" ? (
        <label>
          Til
          <select value={til} onChange={(e) => settTil(e.target.value)}>
            <option value="">Alle med samme rolle (den første som tar den)</option>
            {kolleger.map((k) => (
              <option key={k.ansatt_id} value={k.ansatt_id} disabled={!!k.hindring}>
                {k.navn}
                {k.hindring ? ` (${k.hindring.toLowerCase()})` : ""}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <label>
          Vakten du vil ha i stedet
          <select required value={mot} onChange={(e) => settMot(e.target.value)}>
            <option value="">{mulige.length ? "Velg vakt" : "Ingen vakter å bytte mot de neste ukene"}</option>
            {[...perKollega.entries()].map(([navn, liste]) => (
              <optgroup key={navn} label={navn}>
                {liste.map((k) => (
                  <option key={nokkel(k)} value={nokkel(k)}>
                    {vaktTekst(k.dato, k.hel_dag ? null : k.fra, k.hel_dag ? null : k.til)}
                    {k.oppgave ? ` · ${k.oppgave}` : ""}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          <span className="felt-hjelp">Vaktene til kolleger med samme rolle de neste åtte ukene, som dere begge kan ta (uten en annen vakt som overlapper).</span>
        </label>
      )}
      <label>
        Melding
        <input maxLength={300} placeholder="Valgfritt, f.eks. hvorfor" value={melding} onChange={(e) => settMelding(e.target.value)} />
      </label>
      {innstilling === "godkjenning" && <p className="felt-hjelp">Når en kollega har sagt ja, må lederen godkjenne byttet før det gjelder.</p>}
      <Feil melding={h.feil} />
      <div className="knapper">
        <button className="primar" disabled={h.opptatt || !kolleger.length}>
          {type === "gi" ? "Tilby vakten" : "Spør om bytte"}
        </button>
        <button type="button" onClick={lukk}>
          Avbryt
        </button>
      </div>
    </form>
  );
}

// --- Lederen bytter eller gir bort (vaktplanen) ------------------------------------

// Vakten (eller den faste arbeidsdagen, uten id) lederen bytter, og hvem som har den.
export type LederVakt = { id: string | null; ansatt_id: string; navn: string; dato: string; fra: string | null; til: string | null; timer: number; publisert: boolean };
type LederKollega = { ansatt_id: string; navn: string; rolle: string | null; hindring: string | null };
type LederKandidat = { vakt_id: string | null; dato: string; fra: string; til: string; timer: number; oppgave: string | null; hel_dag: boolean; publisert: boolean; hindring: string | null };
type LederSvar = Bytte & { utfort: boolean; varslet: boolean };

export function LederByttDialog({ vakt, lukk, ferdig }: { vakt: LederVakt | null; lukk: () => void; ferdig: (melding: string) => void }) {
  return (
    <Dialog apen={!!vakt} lukk={lukk} tittel="Bytt eller gi bort vakten">
      {vakt && <LederByttSkjema key={vakt.id ?? `${vakt.ansatt_id}|${vakt.dato}`} vakt={vakt} lukk={lukk} ferdig={ferdig} />}
    </Dialog>
  );
}

const fornavn = (navn: string) => navn.split(" ")[0] ?? navn;
// Hindringen uten navnet foran (navnet står i valget): «har en annen vakt som overlapper».
const utenNavn = (hindring: string, navn: string) => (hindring.startsWith(`${navn} `) ? hindring.slice(navn.length + 1) : hindring);
const kandidatNokkel = (k: LederKandidat) => k.vakt_id ?? k.dato;

function LederByttSkjema({ vakt, lukk, ferdig }: { vakt: LederVakt; lukk: () => void; ferdig: (melding: string) => void }) {
  const { org } = useKonto();
  const sti = `/org/${org!.id}/vaktbytter/leder/muligheter?${vakt.id ? `vakt=${vakt.id}` : `ansatt=${vakt.ansatt_id}&dato=${vakt.dato}`}`;
  const m = useData(() => hent<{ rolle: string | null; kolleger: LederKollega[] }>(sti), [sti]);
  const [type, settType] = useState<"gi" | "bytt">("gi");
  const [til, settTil] = useState("");
  const [mot, settMot] = useState("");
  const [melding, settMelding] = useState("");
  // Vaktene til den det byttes med (svaret huskes med hvem det gjelder, så et nytt valg ikke viser
  // vaktene til den forrige).
  const k = useData(
    () => (type === "bytt" && til ? hent<{ vakter: LederKandidat[] }>(`${sti}&kollega=${til}`).then((r) => ({ kollega: til, vakter: r.vakter })) : Promise.resolve(null)),
    [sti, type, til],
  );
  const kandidater = k.data && k.data.kollega === til ? k.data.vakter : null;
  const valgt = type === "bytt" ? kandidater?.find((x) => kandidatNokkel(x) === mot) : undefined;
  const klar = !!til && (type === "gi" || !!valgt);
  // Forhåndsvisningen: advarslene etter arbeidsmiljøloven byttet gir (eller hvorfor det ikke går).
  const nokkel = klar ? `${type}|${til}|${type === "bytt" ? mot : ""}` : "";
  const [forhand, settForhand] = useState<{ nokkel: string; advarsler?: string[]; feil?: string } | null>(null);
  const h = useHandling();

  const kropp = () => ({
    ...(vakt.id ? { vakt_id: vakt.id } : { ansatt_id: vakt.ansatt_id, dato: vakt.dato }),
    til_ansatt: til,
    ...(valgt ? (valgt.vakt_id ? { mot_vakt_id: valgt.vakt_id } : { mot_dato: valgt.dato }) : {}),
  });
  useEffect(() => {
    if (!nokkel) return;
    let aktiv = true;
    settForhand({ nokkel });
    api<LederSvar>("POST", `/org/${org!.id}/vaktbytter/leder`, { ...kropp(), forhandsvis: true }).then(
      (r) => aktiv && settForhand({ nokkel, advarsler: r.advarsler }),
      (e: Error) => aktiv && settForhand({ nokkel, feil: e.message }),
    );
    return () => {
      aktiv = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nokkel]);
  const visning = forhand && forhand.nokkel === nokkel ? forhand : null;

  if (m.feil) return <Feil melding={m.feil} />;
  if (!m.data) return <Laster />;
  const navn = fornavn(vakt.navn);
  const kollega = m.data.kolleger.find((x) => x.ansatt_id === til);
  // Rollene: den samme rollen som den som har vakten først, så de andre, og de uten rolle til sist.
  const roller = [...new Set(m.data.kolleger.map((x) => x.rolle ?? ""))].sort((a, b) =>
    a === (m.data!.rolle ?? "") ? -1 : b === (m.data!.rolle ?? "") ? 1 : !a ? 1 : !b ? -1 : a.localeCompare(b, "nb"),
  );
  const varsles = vakt.publisert || !!valgt?.publisert;

  // Den som er valgt, kan være opptatt da vakten er (det går ved et bytte, men ikke når vakten gis bort).
  const velgType = (t: "gi" | "bytt") => {
    settType(t);
    settMot("");
    if (t === "gi" && kollega?.hindring) settTil("");
  };
  const send = (e: FormEvent) => {
    e.preventDefault();
    h.kjor(async () => {
      if (!til) throw new Error(type === "gi" ? "Velg hvem vakten skal til" : "Velg hvem vakten skal byttes med");
      if (type === "bytt" && !valgt) throw new Error(`Velg vakten ${navn} skal få i stedet`);
      const r = await api<LederSvar>("POST", `/org/${org!.id}/vaktbytter/leder`, { ...kropp(), melding: melding.trim() || undefined });
      const beskjed = r.varslet ? " De to får beskjed." : "";
      ferdig(
        r.mot_vakt_id
          ? `Vaktene er byttet: ${r.fra_navn} har nå ${liten(vaktTekst(r.mot_dato!, r.mot_fra, r.mot_til))}, og ${r.tatt_av_navn} har ${liten(vaktTekst(r.dato, r.fra, r.til))}.${beskjed}`
          : `Vakten ${liten(vaktTekst(r.dato, r.fra, r.til))} er gitt til ${r.tatt_av_navn}.${beskjed}`,
      );
    });
  };

  const personer = (
    <>
      <option value="">{m.data.kolleger.length ? "Velg hvem" : "Ingen andre aktive i organisasjonen"}</option>
      {roller.map((rolle) => (
        <optgroup key={rolle} label={rolle || "Uten rolle"}>
          {m.data!.kolleger
            .filter((x) => (x.rolle ?? "") === rolle)
            .map((x) => (
              // Et bytte kan gå selv om den andre er opptatt akkurat da (vakten de gir fra seg, teller
              // ikke); hva som hindrer, står da ved vaktene deres.
              <option key={x.ansatt_id} value={x.ansatt_id} disabled={type === "gi" && !!x.hindring}>
                {x.navn}
                {type === "gi" && x.hindring ? ` (${utenNavn(x.hindring, x.navn)})` : ""}
              </option>
            ))}
        </optgroup>
      ))}
    </>
  );

  return (
    <form onSubmit={send}>
      <p className="bytte-vakt">
        <strong>{vakt.navn}</strong> · {vaktTekst(vakt.dato, vakt.fra, vakt.til)} <span className="dempet">· {timer(vakt.timer)}</span>
        {!vakt.id && <span className="dempet"> · fast arbeidsdag</span>}
        {!vakt.publisert && <span className="merke merke-noytral leder-bytte-utkast">Utkast</span>}
      </p>
      <div className="faner valg" role="radiogroup" aria-label="Hva vil du?">
        <button type="button" role="radio" aria-checked={type === "gi"} className={type === "gi" ? "valgt" : undefined} onClick={() => velgType("gi")}>
          Gi bort
        </button>
        <button type="button" role="radio" aria-checked={type === "bytt"} className={type === "bytt" ? "valgt" : undefined} onClick={() => velgType("bytt")}>
          Bytt mot en annen vakt
        </button>
      </div>
      <label>
        {type === "gi" ? "Gi vakten til" : "Bytt med"}
        <select
          required
          value={til}
          onChange={(e) => {
            settTil(e.target.value);
            settMot("");
          }}
        >
          {personer}
        </select>
        <span className="felt-hjelp">Alle aktive i organisasjonen, også de med en annen rolle og de uten innlogging.</span>
      </label>
      {type === "bytt" && til && (
        <label>
          Vakten {navn} får i stedet
          <select required value={mot} onChange={(e) => settMot(e.target.value)} disabled={!kandidater}>
            <option value="">{!kandidater ? "Laster …" : kandidater.length ? "Velg vakt" : `${kollega ? fornavn(kollega.navn) : "Den andre"} har ingen vakter de neste ukene`}</option>
            {(kandidater ?? []).map((x) => (
              <option key={kandidatNokkel(x)} value={kandidatNokkel(x)} disabled={!!x.hindring}>
                {vaktTekst(x.dato, x.hel_dag ? null : x.fra, x.hel_dag ? null : x.til)}
                {x.oppgave ? ` · ${x.oppgave}` : ""}
                {!x.vakt_id ? " · fast dag" : !x.publisert ? " · utkast" : ""}
                {x.hindring ? ` (${x.hindring})` : ""}
              </option>
            ))}
          </select>
          <Feil melding={k.feil} />
          <span className="felt-hjelp">Vaktene og de faste arbeidsdagene til {kollega ? fornavn(kollega.navn) : "den andre"} de neste åtte ukene, også utkast.</span>
        </label>
      )}
      <label>
        Melding til de ansatte
        <input maxLength={300} placeholder="Valgfritt, f.eks. hvorfor" value={melding} onChange={(e) => settMelding(e.target.value)} />
      </label>
      {klar && (
        <div className="leder-bytte-sjekk" aria-live="polite">
          {!visning ? (
            <p className="liten dempet">Sjekker arbeidsmiljøloven …</p>
          ) : visning.feil ? (
            <Feil melding={visning.feil} />
          ) : visning.advarsler?.length ? (
            <div className="melding advarsel">
              <strong>Byttet gir advarsler etter arbeidsmiljøloven</strong>
              <ul className="bytte-advarsler">
                {visning.advarsler.map((a) => (
                  <li key={a}>
                    <IkonVarsel storrelse={13} /> {a}
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="liten leder-bytte-ok">
              <IkonHake storrelse={14} /> Ingen nye advarsler etter arbeidsmiljøloven.
            </p>
          )}
        </div>
      )}
      <p className="felt-hjelp">
        Byttet gjøres med en gang, uten godkjenning, og plassen på tavla følger med.
        {!vakt.id ? ` ${navn} får fri denne dagen.` : ""}
        {varsles ? " De to får beskjed (de som har innlogging)." : " Vakten er ikke publisert, så ingen får beskjed før uka publiseres."}
      </p>
      <Feil melding={h.feil} />
      <div className="knapper">
        <button className="primar" disabled={h.opptatt || !klar || !visning || !!visning.feil}>
          {type === "gi" ? "Gi bort vakten" : "Bytt vaktene"}
          {visning?.advarsler?.length ? " likevel" : ""}
        </button>
        <button type="button" onClick={lukk}>
          Avbryt
        </button>
      </div>
    </form>
  );
}

// --- Fanen «Bytter» -----------------------------------------------------------------

const SELV_LEDER = "Du kan også gi bort eller bytte en vakt selv: trykk på vakten i vaktplanen og velg «Bytt eller gi bort».";

// leder: godkjenner og kan trekke tilbake (eier og administrator); seAlle: ser alle byttene (også regnskap).
export function Bytter({
  svar,
  feil,
  egen,
  leder,
  seAlle,
  endret,
}: {
  svar?: ByttSvar;
  feil: string | null;
  egen: string | null;
  leder: boolean;
  seAlle: boolean;
  endret: () => void;
}) {
  const { org } = useKonto();
  const h = useHandling();
  const [melding, settMelding] = useState<string | null>(null);
  const [avviser, settAvviser] = useState<string | null>(null);
  const [grunn, settGrunn] = useState("");
  if (feil) return <Feil melding={feil} />;
  if (!svar) return <Laster />;

  const alle = svar.bytter;
  const tilGodkjenning = seAlle ? alle.filter((b) => b.status === "akseptert") : [];
  const tilDeg = alle.filter((b) => b.status === "tilbudt" && !!egen && b.til_ansatt === egen);
  const dine = alle.filter((b) => aapen(b) && !!egen && (b.fra_ansatt === egen || b.tatt_av === egen) && !tilGodkjenning.includes(b));
  const andre = seAlle ? alle.filter((b) => b.status === "tilbudt" && !tilDeg.includes(b) && !dine.includes(b)) : [];
  const avsluttet = alle.filter((b) => !aapen(b)).sort((x, y) => (y.behandlet_at ?? y.svart_at ?? y.opprettet).localeCompare(x.behandlet_at ?? x.svart_at ?? x.opprettet));

  const kjor = (fn: () => Promise<unknown>, tekst: string) =>
    h.kjor(async () => {
      await fn();
      settMelding(tekst);
      settAvviser(null);
      endret();
    });
  const svarPaa = (b: Bytte, ja: boolean) =>
    kjor(
      () => api("POST", `/org/${org!.id}/vaktbytter/${b.id}/svar`, { ja }),
      !ja
        ? b.status === "akseptert"
          ? "Du har angret."
          : `Du har sagt nei takk til ${b.fra_navn}.`
        : svar.innstilling === "godkjenning"
          ? "Du har sagt ja. Byttet gjelder når lederen har godkjent det."
          : b.mot_vakt_id
            ? `Byttet er gjort: du har nå ${vaktTekst(b.dato, b.fra, b.til)}.`
            : `Vakten ${vaktTekst(b.dato, b.fra, b.til)} er din.`,
    );
  const trekk = (b: Bytte) => {
    if (!confirm(`Trekke tilbake tilbudet om vakten ${vaktTekst(b.dato, b.fra, b.til)}?`)) return;
    kjor(() => api("POST", `/org/${org!.id}/vaktbytter/${b.id}/trekk`), "Tilbudet er trukket tilbake.");
  };
  const godkjenn = (b: Bytte) => kjor(() => api("POST", `/org/${org!.id}/vaktbytter/${b.id}/godkjenn`, {}), `Byttet er godkjent, og vakten${b.mot_vakt_id ? "e" : ""} er flyttet. De to får beskjed.`);
  const avvis = (b: Bytte) =>
    kjor(() => api("POST", `/org/${org!.id}/vaktbytter/${b.id}/avvis`, { grunn: grunn.trim() || undefined }), "Byttet er ikke godkjent. De to får beskjed, og vaktene blir som før.");

  const rad = (b: Bytte, knapper?: ReactNode) => {
    const s = statusMerke(b);
    return (
      <div key={b.id} className="liste-rad statisk bytte-rad">
        <span className="linje">
          <span className="tittel">
            {vaktTekst(b.dato, b.fra, b.til)}
            {b.oppgave ? ` · ${b.oppgave}` : ""}
          </span>
          <span className={`merke ${s.klasse}`}>{s.tekst}</span>
        </span>
        <span className="under bryt">{beskrivelse(b, egen)}</span>
        {b.melding && <span className="under bryt">«{b.melding}»</span>}
        {b.status === "avvist" && <span className="under bryt">Ikke godkjent{b.behandlet_av_navn ? ` av ${b.behandlet_av_navn}` : ""}{b.grunn ? `: ${b.grunn}` : "."}</span>}
        {b.advarsler.length > 0 && (
          <ul className="bytte-advarsler">
            {b.advarsler.map((a) => (
              <li key={a}>
                <IkonVarsel storrelse={13} /> {a}
              </li>
            ))}
          </ul>
        )}
        {b.hindring && b.status === "tilbudt" && <span className="under bryt hindring">{b.hindring}</span>}
        {knapper && <div className="knapper bytte-knapper">{knapper}</div>}
        {avviser === b.id && (
          <div className="bytte-avvis">
            <label>
              Grunn (valgfri, de to ser den)
              <input maxLength={300} value={grunn} onChange={(e) => settGrunn(e.target.value)} autoFocus />
            </label>
            <div className="knapper">
              <button type="button" className="fare" disabled={h.opptatt} onClick={() => avvis(b)}>
                Ikke godkjenn
              </button>
              <button type="button" onClick={() => settAvviser(null)}>
                Avbryt
              </button>
            </div>
          </div>
        )}
      </div>
    );
  };

  const seksjon = (tittel: string, liste: Bytte[], knapper: (b: Bytte) => ReactNode) =>
    liste.length > 0 && (
      <>
        <h2 className="bytte-overskrift">{tittel}</h2>
        <div className="kort liste">{liste.map((b) => rad(b, knapper(b)))}</div>
      </>
    );

  const tomt = !tilGodkjenning.length && !tilDeg.length && !dine.length && !andre.length && !avsluttet.length;
  return (
    <>
      {melding && (
        <div className="melding ok" role="status">
          {melding}
        </div>
      )}
      <Feil melding={h.feil} />
      {svar.innstilling === "av" && (
        <p className="melding info">
          Vaktbytte er slått av{leder ? " (Innstillinger → Ansatte og timer)" : ""}. Byttene under er fra før.
        </p>
      )}
      {seksjon("Til godkjenning", tilGodkjenning, (b) =>
        leder && (
        <>
          <button type="button" className="primar" disabled={h.opptatt} onClick={() => godkjenn(b)}>
            Godkjenn
          </button>
          <button
            type="button"
            disabled={h.opptatt}
            onClick={() => {
              settGrunn("");
              settAvviser(b.id);
            }}
          >
            Ikke godkjenn
          </button>
        </>
        ),
      )}
      {seksjon("Til deg", tilDeg, (b) => (
        <>
          <button type="button" className="primar" disabled={h.opptatt || !!b.hindring} onClick={() => svarPaa(b, true)}>
            {b.mot_vakt_id ? "Bytt" : "Ta vakten"}
          </button>
          <button type="button" disabled={h.opptatt} onClick={() => svarPaa(b, false)}>
            Nei takk
          </button>
        </>
      ))}
      {seksjon("Dine bytter", dine, (b) =>
        b.fra_ansatt === egen ? (
          <button type="button" disabled={h.opptatt} onClick={() => trekk(b)}>
            Trekk tilbake
          </button>
        ) : (
          <button type="button" disabled={h.opptatt} onClick={() => svarPaa(b, false)}>
            Angre
          </button>
        ),
      )}
      {seksjon("Åpne tilbud", andre, (b) =>
        leder && (
          <button type="button" className="lenke" disabled={h.opptatt} onClick={() => trekk(b)}>
            Trekk tilbake
          </button>
        ),
      )}
      {seksjon("Siste 30 dager", avsluttet, () => null)}
      {tomt && (
        <div className="kort">
          <Tom ikon={<IkonRullering storrelse={22} />} tittel="Ingen vaktbytter">
            {egen ? (
              <p>Trykk «Bytt» på en vakt under Mine vakter for å gi den bort eller bytte den med en kollega med samme rolle.</p>
            ) : (
              <p>
                Når de ansatte gir bort eller bytter vakter, ser du det her{svar.innstilling === "godkjenning" ? ", og godkjenner byttene" : ""}.
                {leder ? ` ${SELV_LEDER}` : ""}
              </p>
            )}
          </Tom>
        </div>
      )}
      {!tomt && (svar.innstilling !== "av" || leder) && (
        <p className="liten dempet">
          {[
            svar.innstilling === "godkjenning"
              ? "Et bytte gjelder når en kollega har sagt ja og lederen har godkjent det. Da flyttes vakten, og plassen på tavla følger med."
              : svar.innstilling === "fritt"
                ? "Et bytte gjelder med en gang en kollega har sagt ja. Da flyttes vakten, og plassen på tavla følger med."
                : null,
            leder ? SELV_LEDER : null,
          ]
            .filter(Boolean)
            .join(" ")}
        </p>
      )}
    </>
  );
}
