// Fast arbeidsplan i ansattskjemaet: hvilke ukedager den ansatte jobber, med klokkeslett eller
// som hel dag (en femtedel av arbeidstiden i full stilling, vanligvis 7,5 timer). Planen gjelder
// fra en dato (server/src/arbeidsplan.ts), så en endring ikke endrer tidligere måneder. De
// faste dagene vises i bemanningskalenderen, vaktplanen og på tavla, og timer utover planen
// blir ekstratimer. Stillingsprosenten følger dagene (den kan endres etterpå), og arbeidstiden
// og dagene kan også endres fra vaktplanen, tavla, kalenderen og timelista (ArbeidsplanDialog).
import { useEffect, useState, type FormEvent } from "react";
import { api, hent } from "../api";
import { Dialog, Feil, Laster, tall, useData, useHandling } from "../felles";
import { dato, iDag } from "../format";
import { useKonto } from "../konto";
import { Klokkeslett, regnTimer, tallformat, timer } from "../uke";

export type PlanDag = { ukedag: number; fra: string | null; til: string | null; pause_min: number };
export type Plan = { id: string; gjelder_fra: string; dager: PlanDag[] };
type DagUtkast = { hel: boolean; fra: string; til: string; pause: string };
export type PlanUtkast = {
  gjelder_fra: string;
  dager: Partial<Record<number, DagUtkast>>;
  opprinnelig: string;
  harPlan: boolean;
  fraDato: string | null; // når planen som gjelder nå, begynte
  neste: string | null; // en senere plan som begynner da
};

export const UKEDAGER_KORT = ["", "Ma", "Ti", "On", "To", "Fr", "Lø", "Sø"];

// En fast dag i kalenderen, vaktplanen og på tavla: «08:00–13:00», og ingenting for en hel dag
// (det vanligste: da holder navnet).
export const fastTid = (f: { fra: string | null; til: string | null }) => (f.fra && f.til ? `${f.fra}–${f.til}` : "");
// Vakten en fast dag blir til (f.eks. når det settes inn vikar): klokkeslettene, eller fra
// kl. 08 og like lenge som dagen (som POST /vakter/fra-plan).
export function fastTider(f: { fra: string | null; til: string | null; timer: number }) {
  if (f.fra && f.til) return { fra: f.fra, til: f.til };
  const m = 8 * 60 + Math.round(Number(f.timer) * 60);
  return { fra: "08:00", til: `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}` };
}
const UKEDAGER = ["", "Mandag", "Tirsdag", "Onsdag", "Torsdag", "Fredag", "Lørdag", "Søndag"];
const klokke = (s: string) => /^\d{2}:\d{2}$/.test(s);

// «Ma–Fr», «Ma, On, Fr» eller «Ma–On, Fr»: tre eller flere dager på rad med strek.
export function dagerTekst(ukedager: number[]) {
  const d = [...new Set(ukedager)].sort((a, b) => a - b);
  const ut: string[] = [];
  for (let i = 0; i < d.length; ) {
    let j = i;
    while (j + 1 < d.length && d[j + 1] === d[j]! + 1) j++;
    if (j - i >= 2) ut.push(`${UKEDAGER_KORT[d[i]!]}–${UKEDAGER_KORT[d[j]!]}`);
    else for (let k = i; k <= j; k++) ut.push(UKEDAGER_KORT[d[k]!]!);
    i = j + 1;
  }
  return ut.join(", ");
}

// Planen som gjelder i dag (eller den første som kommer).
export const gjeldende = (planer: Plan[]) => [...planer].reverse().find((p) => p.gjelder_fra <= iDag()) ?? planer[0] ?? null;

const tilDager = (dager: PlanUtkast["dager"]) =>
  Object.entries(dager)
    .filter((e): e is [string, DagUtkast] => !!e[1])
    .map(([u, d]) => ({ ukedag: Number(u), fra: d.hel ? null : d.fra, til: d.hel ? null : d.til, pause_min: d.hel ? 0 : Math.round(Number(d.pause.replace(",", ".")) || 0) }))
    .sort((a, b) => a.ukedag - b.ukedag);

export function lagUtkast(planer: Plan[], ansattFra: string | undefined): PlanUtkast {
  const p = gjeldende(planer);
  const dager: PlanUtkast["dager"] = {};
  for (const d of p?.dager ?? []) dager[d.ukedag] = { hel: !d.fra, fra: d.fra ?? "", til: d.til ?? "", pause: d.pause_min ? String(d.pause_min) : "" };
  return {
    // En endring gjelder fra i dag (eller fra når planen begynner, om det er senere). Den første
    // planen gjelder fra den ansatte begynte, så hele kalenderen viser den.
    gjelder_fra: p ? (p.gjelder_fra > iDag() ? p.gjelder_fra : iDag()) : (ansattFra ?? iDag()),
    dager,
    opprinnelig: JSON.stringify(tilDager(dager)),
    harPlan: !!p,
    fraDato: p?.gjelder_fra ?? null,
    neste: (p && planer.find((x) => x.gjelder_fra > p.gjelder_fra)?.gjelder_fra) ?? null,
  };
}

// Om planen er endret (eller lagt inn) og må lagres.
export const endret = (u: PlanUtkast) => JSON.stringify(tilDager(u.dager)) !== u.opprinnelig;

// Det som sendes til serveren, eller en feilmelding.
export function tilLagring(u: PlanUtkast): { gjelder_fra: string; dager: PlanDag[] } | string {
  for (const [nr, d] of Object.entries(u.dager)) {
    if (!d || d.hel) continue;
    const dag = UKEDAGER[Number(nr)]!.toLowerCase();
    if (!klokke(d.fra) || !klokke(d.til)) return `Skriv fra og til for ${dag}, eller velg hel dag`;
    if (d.fra === d.til) return `Fra og til kan ikke være like (${dag})`;
    const pause = Number(d.pause.replace(",", ".")) || 0;
    if (pause < 0 || pause >= regnTimer(d.fra, d.til, 0) * 60) return `Pausen er for lang (${dag})`;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(u.gjelder_fra)) return "Velg datoen planen gjelder fra";
  return { gjelder_fra: u.gjelder_fra, dager: tilDager(u.dager) };
}

const dagTimer = (d: DagUtkast, ukentlig: number) =>
  d.hel ? ukentlig / 5 : klokke(d.fra) && klokke(d.til) && d.fra !== d.til ? regnTimer(d.fra, d.til, Number(d.pause.replace(",", ".")) || 0) : null;
const rund = (t: number) => Math.round(t * 100) / 100;
const valgteDager = (u: PlanUtkast) => [1, 2, 3, 4, 5, 6, 7].filter((x) => u.dager[x]);
const ukesum = (u: PlanUtkast, ukentlig: number) => rund(valgteDager(u).reduce((s, x) => s + (dagTimer(u.dager[x]!, ukentlig) ?? 0), 0));

// Stillingsprosenten de faste dagene gir (timene i uka av arbeidstiden i full stilling), eller
// null uten dager. Høyst 100 %.
export function planProsent(u: PlanUtkast, ukentlig: number): number | null {
  if (!valgteDager(u).length || !(ukentlig > 0)) return null;
  const p = Math.round((ukesum(u, ukentlig) / ukentlig) * 1000) / 10;
  return p > 0 ? Math.min(100, p) : null;
}

export function ArbeidsplanFelt({
  utkast,
  endre,
  ukentlig,
  prosent,
  settProsent,
  ny,
  kanEndre,
}: {
  utkast: PlanUtkast;
  endre: (u: PlanUtkast) => void;
  ukentlig: number;
  prosent: number;
  settProsent: (p: number) => void;
  ny: boolean;
  kanEndre: boolean;
}) {
  // Stillingsprosenten følger dagene når de endres (den kan endres etterpå).
  const sett = (ukedag: number, d: DagUtkast | undefined) => {
    const ny = { ...utkast, dager: { ...utkast.dager, [ukedag]: d } };
    endre(ny);
    const p = planProsent(ny, ukentlig);
    if (p !== null) settProsent(p);
  };
  const valgte = valgteDager(utkast);
  const gyldigUke = Number.isFinite(ukentlig) && ukentlig > 0;
  const sum = ukesum(utkast, ukentlig);
  const prosentPlan = gyldigUke ? Math.round((sum / ukentlig) * 1000) / 10 : 0;
  const avvik = gyldigUke && valgte.length > 0 && Number.isFinite(prosent) && Math.abs(Math.min(100, prosentPlan) - prosent) >= 0.1;

  // En ny dag får samme tid som den forrige valgte dagen (eller hel dag).
  const slaPa = (u: number) => {
    const forrige = [...valgte].reverse().find((x) => x < u) ?? valgte[0];
    sett(u, forrige ? { ...utkast.dager[forrige]! } : { hel: true, fra: "08:00", til: "15:30", pause: "" });
  };

  return (
    <fieldset className="arbeidsplan" disabled={!kanEndre}>
      <legend className="arbeidsplan-tittel">Faste arbeidsdager</legend>
      <p className="felt-hjelp arbeidsplan-hjelp">
        Velg dagene den ansatte jobber, med klokkeslett eller hel dag ({timer(rund(gyldigUke ? ukentlig / 5 : 7.5))}). De vises i bemanningskalenderen, vaktplanen og på
        tavla, og timer utover planen blir ekstratimer.
      </p>
      <div className="arbeidsdager" role="group" aria-label="Ukedager den ansatte jobber">
        {[1, 2, 3, 4, 5, 6, 7].map((u) => (
          <button
            key={u}
            type="button"
            aria-pressed={!!utkast.dager[u]}
            aria-label={UKEDAGER[u]}
            title={UKEDAGER[u]}
            className={utkast.dager[u] ? "valgt" : undefined}
            onClick={() => (utkast.dager[u] ? sett(u, undefined) : slaPa(u))}
          >
            {UKEDAGER_KORT[u]}
          </button>
        ))}
      </div>
      {valgte.map((u) => {
        const d = utkast.dager[u]!;
        const t = dagTimer(d, ukentlig);
        return (
          <div key={u} className="arbeidsdag-rad">
            <span className="arbeidsdag-navn">{UKEDAGER[u]}</span>
            <label className="arbeidsdag-hel">
              <input type="checkbox" checked={d.hel} onChange={(e) => sett(u, { ...d, hel: e.target.checked })} />
              Hel dag
            </label>
            {!d.hel && (
              <span className="arbeidsdag-tid">
                <Klokkeslett aria-label={`${UKEDAGER[u]} fra`} value={d.fra} onChange={(fra) => sett(u, { ...d, fra })} />
                <span aria-hidden="true">–</span>
                <Klokkeslett aria-label={`${UKEDAGER[u]} til`} value={d.til} onChange={(til) => sett(u, { ...d, til })} />
                <label className="arbeidsdag-pause">
                  Pause
                  <input
                    inputMode="numeric"
                    aria-label={`${UKEDAGER[u]}: pause i minutter`}
                    placeholder="0"
                    value={d.pause}
                    onChange={(e) => sett(u, { ...d, pause: e.target.value.replace(/[^\d]/g, "") })}
                  />
                  min
                </label>
              </span>
            )}
            <span className="arbeidsdag-timer">{t != null && t > 0 ? timer(rund(t)) : "–"}</span>
          </div>
        );
      })}
      {valgte.length > 0 && (
        <p className="arbeidsplan-sum" aria-live="polite">
          <strong>{timer(sum)} i uka</strong>
          {gyldigUke && <span> = {tallformat.format(prosentPlan)} % av {timer(ukentlig)}</span>}
          {avvik && kanEndre && (
            <>
              <span className="dempet"> · stillingen er {tallformat.format(prosent)} %</span>{" "}
              <button type="button" className="lenke" onClick={() => settProsent(Math.min(100, prosentPlan))}>
                Sett stillingen til {tallformat.format(Math.min(100, prosentPlan))} %
              </button>
            </>
          )}
        </p>
      )}
      {!ny && utkast.harPlan && !endret(utkast) && utkast.fraDato && (
        <p className="felt-hjelp arbeidsplan-hjelp">
          Planen gjelder fra {dato(utkast.fraDato)}
          {utkast.neste ? `, og en ny plan gjelder fra ${dato(utkast.neste)}` : ""}.
        </p>
      )}
      {!ny && endret(utkast) && (
        <label className="arbeidsplan-fra">
          {utkast.harPlan ? "Endringen gjelder fra" : "Planen gjelder fra"}
          <input type="date" required value={utkast.gjelder_fra} onChange={(e) => endre({ ...utkast, gjelder_fra: e.target.value })} />
          <span className="felt-hjelp">
            {utkast.harPlan
              ? `Dagene før beholder planen som gjaldt da (i bemanningskalenderen og for ekstratimene).${utkast.neste ? ` Planen fra ${dato(utkast.neste)} gjelder fortsatt fra da.` : ""}`
              : "Fra den ansatte begynte, så hele bemanningskalenderen viser planen."}
          </span>
        </label>
      )}
    </fieldset>
  );
}

// --- Arbeidstid og faste dager fra de andre modulene ------------------------------------------

type AnsattArbeidstid = { id: string; fornavn: string; etternavn: string; stilling: string | null; stillingsprosent: number; ukentlig_arbeidstid: number; ansatt_fra: string };
const tallTekst = (n: number) => String(n).replace(".", ",");

// Stillingsprosenten, arbeidstiden i full stilling og de faste dagene til én ansatt, som i
// ansattkortet (samme data), fra vaktplanen, tavla, bemanningskalenderen og timelista.
export function ArbeidsplanDialog({ ansattId, lukk, lagret }: { ansattId: string | null; lukk: () => void; lagret: (melding: string) => void }) {
  return (
    <Dialog apen={!!ansattId} lukk={lukk} tittel="Arbeidstid og faste dager">
      {ansattId && <ArbeidsplanSkjema ansattId={ansattId} lukk={lukk} lagret={lagret} />}
    </Dialog>
  );
}

function ArbeidsplanSkjema({ ansattId, lukk, lagret }: { ansattId: string; lukk: () => void; lagret: (melding: string) => void }) {
  const { org } = useKonto();
  const ansatt = useData(() => hent<AnsattArbeidstid>(`/org/${org!.id}/ansatte/${ansattId}`), [org?.id, ansattId]);
  const planer = useData(() => hent<Plan[]>(`/org/${org!.id}/ansatte/${ansattId}/arbeidsplan`), [org?.id, ansattId]);
  const [prosent, settProsent] = useState("");
  const [ukentlig, settUkentlig] = useState("");
  const [utkast, settUtkast] = useState<PlanUtkast | null>(null);
  const h = useHandling();
  useEffect(() => {
    if (!ansatt.data || !planer.data) return;
    settProsent(tallTekst(Number(ansatt.data.stillingsprosent)));
    settUkentlig(tallTekst(Number(ansatt.data.ukentlig_arbeidstid)));
    settUtkast(lagUtkast(planer.data, ansatt.data.ansatt_fra));
  }, [ansatt.data, planer.data]);
  const a = ansatt.data;
  if (ansatt.feil || planer.feil) return <Feil melding={ansatt.feil ?? planer.feil} />;
  if (!a || !utkast) return <Laster />;
  const uke = ukentlig.trim() ? tall(ukentlig) : NaN;

  async function lagre(e: FormEvent) {
    e.preventDefault();
    const p = tall(prosent);
    if (!(p > 0 && p <= 100)) return h.settFeil("Stillingsprosenten må være mellom 0 og 100");
    if (!(uke > 0 && uke <= 60)) return h.settFeil("Arbeidstiden i full stilling må være mellom 0 og 60 timer i uka");
    const nyPlan = endret(utkast!) ? tilLagring(utkast!) : null;
    if (typeof nyPlan === "string") return h.settFeil(nyPlan);
    const ok = await h.kjor(async () => {
      if (p !== Number(a!.stillingsprosent) || uke !== Number(a!.ukentlig_arbeidstid))
        await api("PATCH", `/org/${org!.id}/ansatte/${ansattId}`, { stillingsprosent: p, ukentlig_arbeidstid: uke });
      if (nyPlan) await api("PUT", `/org/${org!.id}/ansatte/${ansattId}/arbeidsplan`, nyPlan);
      return true;
    });
    if (ok) lagret(`Arbeidstiden til ${a!.fornavn} er lagret.`);
  }

  return (
    <form className="arbeidsplan-skjema" onSubmit={lagre}>
      <p className="dempet" style={{ marginTop: 0 }}>
        <strong>
          {a.fornavn} {a.etternavn}
        </strong>
        {a.stilling ? ` · ${a.stilling}` : ""} · det samme som i ansattkortet.
      </p>
      <div className="rad">
        <label>
          Stillingsprosent
          <input inputMode="decimal" required value={prosent} onChange={(e) => settProsent(e.target.value)} />
        </label>
        <label>
          Arbeidstid i full stilling
          <input inputMode="decimal" required value={ukentlig} onChange={(e) => settUkentlig(e.target.value)} />
          <span className="felt-hjelp">Timer per uke.</span>
        </label>
      </div>
      <ArbeidsplanFelt
        utkast={utkast}
        endre={settUtkast}
        ukentlig={uke > 0 ? uke : 37.5}
        prosent={prosent.trim() ? tall(prosent) : 100}
        settProsent={(x) => settProsent(tallTekst(x))}
        ny={false}
        kanEndre
      />
      <Feil melding={h.feil} />
      <div className="knapper">
        <button className="primar" disabled={h.opptatt}>
          Lagre
        </button>
        <button type="button" onClick={lukk}>
          Avbryt
        </button>
      </div>
    </form>
  );
}
