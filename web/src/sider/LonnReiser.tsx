// Reiseregningene (server/src/reiseRuter.ts, server/src/reise.ts): fanen «Reiser» under Lønn. Den
// ansatte fører sin egen reise (tidene, overnattingen, måltidene som er dekket, kjøringen og
// utleggene), ser hva den gir mens den fylles ut, og sender den. De som ser lønnen, ser alle; eier
// og administrator fører også for en ansatt, godkjenner (og tar bort «vilkårene for trekkfri
// godtgjørelse er oppfylt» når de ikke er det), avviser med en grunn, eller åpner en godkjent som
// ikke er utbetalt. Neste lønnskjøring betaler de godkjente. Reiseregningen som er åpen, står i
// adressen (?reise=, «ny» for en ny).
import { useEffect, useRef, useState } from "react";
import { api, hent } from "../api";
import { Feil, Laster, Tom, tall, useData, useHandling, useSmal } from "../felles";
import { erAdmin, useKonto } from "../konto";
import { dato, iDag, kr } from "../format";
import { IkonPluss, IkonVenstre } from "../ikoner";
import { maaned } from "../lonn";

type Status = "utkast" | "sendt" | "godkjent" | "avvist";
type Overnatting = "ingen" | "hotell" | "hybel" | "privat";
type Kjoretoy = "bil" | "mc" | "moped" | "snoscooter" | "baat";
type Etappe = { dato: string; fra: string; til: string; km: number; kjoretoy: Kjoretoy; passasjerer: string[]; skogsvei: number; tilhenger: boolean };
type Utlegg = { dato: string; tekst: string; belop: number };
type Linje = { lonnsart: string; tekst: string; antall: number | null; sats: number | null; belop: number };
type Dogn = { nr: number; fra: string; til: string; timer: number; maaltider: string; sats: number; trekkfri: number };
type Beregning = { linjer: Linje[]; dogn: Dogn[]; belop: number; trekkfritt: number; trekkpliktig: number; utlegg: number; merknader: string[] };
type Reise = {
  id: string;
  ansatt_id: string;
  navn: string;
  status: Status;
  formaal: string;
  sted: string | null;
  fra: string;
  til: string;
  overnatting: Overnatting;
  nattillegg: boolean;
  utland: boolean;
  land: string | null;
  kostsats: number | null;
  diett: boolean;
  maaltider: Record<string, string>;
  kjoring: Etappe[];
  utlegg: Utlegg[];
  merknad: string | null;
  trekkfri: boolean;
  beregning: Linje[] | null;
  belop: number | null;
  avvist_grunn: string | null;
  godkjent_at: string | null;
  godkjent_av: string | null;
  lonnskjoring_id: string | null;
  utbetalt_periode: string | null;
  utbetalt_dato: string | null;
  utregning: Beregning | null;
  sum: number;
};

const STATUS: Record<Status, [string, string]> = {
  utkast: ["Utkast", "merke-noytral"],
  sendt: ["Venter på godkjenning", "merke-advarsel"],
  godkjent: ["Godkjent", "merke-ok"],
  avvist: ["Avvist", "merke-feil"],
};
// Delene av en lagret beregning (den godkjente): trekkpliktig, utlegg og resten trekkfritt.
const TREKKPLIKTIG = new Set(["reise_kost_trekk", "reise_annet_trekk", "km_bil_trekk", "km_annet_trekk"]);
const deler = (linjer: Linje[]): Beregning => {
  const sum = (f: (l: Linje) => boolean) => Math.round(linjer.filter(f).reduce((x, l) => x + Number(l.belop), 0) * 100) / 100;
  return {
    linjer,
    dogn: [],
    belop: sum(() => true),
    trekkfritt: sum((l) => !TREKKPLIKTIG.has(l.lonnsart) && l.lonnsart !== "reise_utlegg"),
    trekkpliktig: sum((l) => TREKKPLIKTIG.has(l.lonnsart)),
    utlegg: sum((l) => l.lonnsart === "reise_utlegg"),
    merknader: [],
  };
};
const merke = (r: Pick<Reise, "status" | "lonnskjoring_id">) => {
  const [t, k] = r.lonnskjoring_id ? ["Utbetalt", "merke-ok"] : STATUS[r.status];
  return <span className={`merke ${k}`}>{t}</span>;
};
const OVERNATTING: Record<Overnatting, string> = {
  ingen: "Ingen (dagsreise)",
  hotell: "Hotell",
  hybel: "Hybel, pensjonat eller brakke uten kokemulighet",
  privat: "Hybel med kokemulighet, eller privat",
};
const KJORETOY: Record<Kjoretoy, string> = {
  bil: "Bil",
  mc: "Motorsykkel over 125 ccm",
  moped: "Moped eller motorsykkel til 125 ccm",
  snoscooter: "Snøscooter eller ATV",
  baat: "Båt",
};
// «5.10 kl. 08.00» og «5.–7.10».
const tidTekst = (t: string) => `${Number(t.slice(8, 10))}.${Number(t.slice(5, 7))} kl. ${t.slice(11, 16).replace(":", ".")}`;
const periode = (r: Pick<Reise, "fra" | "til">) => {
  const a = r.fra.slice(0, 10);
  const b = r.til.slice(0, 10);
  return a === b ? dato(a) : `${dato(a)}–${dato(b)}`;
};

// --- Lista ----------------------------------------------------------------------------------

export function Reiser({ leder, reise, apne }: { leder: boolean; reise: string | null; apne: (id: string | null) => void }) {
  if (reise) return <ReiseSide id={reise} leder={leder} tilbake={() => apne(null)} apne={apne} />;
  return <Oversikt leder={leder} apne={apne} />;
}

const FILTER: [string, string][] = [
  ["", "Alle"],
  ["sendt", "Venter"],
  ["godkjent", "Godkjent"],
  ["utbetalt", "Utbetalt"],
  ["utkast", "Utkast"],
  ["avvist", "Avvist"],
];

function Oversikt({ leder, apne }: { leder: boolean; apne: (id: string) => void }) {
  const { org } = useKonto();
  const [filter, settFilter] = useState(leder ? "sendt" : "");
  const d = useData(() => hent<{ satser: "staten" | "trekkfri"; reiser: Reise[] }>(`/org/${org!.id}/reiser${filter ? `?status=${filter}` : ""}`), [org?.id, filter], { oppdater: true });
  const smal = useSmal();
  const kanFore = erAdmin(org?.rolle) || !!org?.ansatt_id;

  return (
    <>
      <p className="undertittel">
        Reiseregninger med diett, nattillegg, kilometergodtgjørelse og utlegg.{" "}
        {d.data?.satser === "trekkfri" ? "Det betales etter de trekkfrie satsene." : "Det betales etter statens satser; det som er over de trekkfrie satsene, er trekkpliktig."} De
        godkjente utbetales med neste lønnskjøring.
      </p>
      <div className="lonn-reiser-topp">
        <div className="faner tett" role="tablist">
          {FILTER.map(([v, t]) => (
            <button key={v} type="button" role="tab" aria-selected={filter === v} className={filter === v ? "valgt" : undefined} onClick={() => settFilter(v)}>
              {t}
            </button>
          ))}
        </div>
        {kanFore && (
          <button type="button" className="primar" onClick={() => apne("ny")}>
            <IkonPluss storrelse={16} /> Ny reiseregning
          </button>
        )}
      </div>
      {d.feil ? (
        <Feil melding={d.feil} />
      ) : !d.data ? (
        <Laster />
      ) : !d.data.reiser.length ? (
        <div className="kort">
          <Tom tittel={filter ? "Ingen reiseregninger her" : "Ingen reiseregninger ennå"}>
            {kanFore && <p>Før en reise med «Ny reiseregning»: tidene, overnattingen, kjøringen og utleggene.</p>}
          </Tom>
        </div>
      ) : smal ? (
        <div className="kort liste">
          {d.data.reiser.map((r) => (
            <button key={r.id} type="button" className="liste-rad" onClick={() => apne(r.id)}>
              <span className="linje">
                <span className="tittel">{r.sted || r.formaal}</span>
                {merke(r)}
              </span>
              <span className="linje">
                <span className="under">
                  {periode(r)}
                  {leder ? ` · ${r.navn}` : ""}
                </span>
                <span className="tall">{kr(r.sum)}</span>
              </span>
            </button>
          ))}
        </div>
      ) : (
        <div className="kort tabell">
          <table>
            <thead>
              <tr>
                <th>Dato</th>
                {leder && <th>Ansatt</th>}
                <th>Reise</th>
                <th>Status</th>
                <th className="hoyre">Beløp</th>
              </tr>
            </thead>
            <tbody>
              {d.data.reiser.map((r) => (
                <tr key={r.id} className="klikkbar" onClick={() => apne(r.id)}>
                  <td>{periode(r)}</td>
                  {leder && <td>{r.navn}</td>}
                  <td>
                    {r.sted ? `${r.sted} – ` : ""}
                    {r.formaal}
                  </td>
                  <td>{merke(r)}</td>
                  <td className="tall">{kr(r.sum)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

// --- Én reiseregning ------------------------------------------------------------------------

type Skjema = {
  ansatt_id: string;
  formaal: string;
  sted: string;
  fra: string;
  til: string;
  overnatting: Overnatting;
  nattillegg: boolean;
  utland: boolean;
  land: string;
  kostsats: string;
  diett: boolean;
  maaltider: Record<string, string>;
  kjoring: (Omit<Etappe, "km" | "skogsvei" | "passasjerer"> & { km: string; skogsvei: string; passasjerer: string })[];
  utlegg: (Omit<Utlegg, "belop"> & { belop: string })[];
  merknad: string;
};
const tilSkjema = (r: Reise): Skjema => ({
  ansatt_id: r.ansatt_id,
  formaal: r.formaal,
  sted: r.sted ?? "",
  fra: r.fra,
  til: r.til,
  overnatting: r.overnatting,
  nattillegg: r.nattillegg,
  utland: r.utland,
  land: r.land ?? "",
  kostsats: r.kostsats != null ? String(r.kostsats).replace(".", ",") : "",
  diett: r.diett,
  maaltider: r.maaltider ?? {},
  kjoring: r.kjoring.map((e) => ({ ...e, km: String(e.km).replace(".", ","), skogsvei: e.skogsvei ? String(e.skogsvei).replace(".", ",") : "", passasjerer: e.passasjerer.join(", ") })),
  utlegg: r.utlegg.map((u) => ({ ...u, belop: String(u.belop).replace(".", ",") })),
  merknad: r.merknad ?? "",
});
const nytt = (ansatt: string): Skjema => {
  const d = iDag();
  return {
    ansatt_id: ansatt,
    formaal: "",
    sted: "",
    fra: `${d}T08:00`,
    til: `${d}T16:00`,
    overnatting: "ingen",
    nattillegg: false,
    utland: false,
    land: "",
    kostsats: "",
    diett: true,
    maaltider: {},
    kjoring: [],
    utlegg: [],
    merknad: "",
  };
};
const tallEller = (s: string) => (s.trim() ? tall(s) : NaN);
const tilKropp = (s: Skjema, leder: boolean, ny: boolean) => ({
  ...(leder && ny ? { ansatt_id: s.ansatt_id || null } : {}),
  formaal: s.formaal,
  sted: s.sted,
  fra: s.fra,
  til: s.til,
  overnatting: s.overnatting,
  nattillegg: s.nattillegg && (s.overnatting === "hybel" || s.overnatting === "privat") && !s.utland,
  utland: s.utland,
  land: s.utland ? s.land : null,
  kostsats: s.utland && s.kostsats.trim() ? tallEller(s.kostsats) : null,
  diett: s.diett,
  maaltider: Object.fromEntries(Object.entries(s.maaltider).filter(([, m]) => m)),
  kjoring: s.kjoring.map((e) => ({
    dato: e.dato,
    fra: e.fra,
    til: e.til,
    km: tallEller(e.km),
    kjoretoy: e.kjoretoy,
    passasjerer: e.kjoretoy === "bil" ? e.passasjerer.split(",").map((x) => x.trim()).filter(Boolean) : [],
    skogsvei: e.kjoretoy === "bil" && e.skogsvei.trim() ? tallEller(e.skogsvei) : 0,
    tilhenger: e.kjoretoy === "bil" && e.tilhenger,
  })),
  utlegg: s.utlegg.map((u) => ({ dato: u.dato, tekst: u.tekst, belop: tallEller(u.belop) })),
  merknad: s.merknad,
});

function ReiseSide({ id, leder, tilbake, apne }: { id: string; leder: boolean; tilbake: () => void; apne: (id: string | null) => void }) {
  const { org } = useKonto();
  const ny = id === "ny";
  const sti = `/org/${org!.id}/reiser`;
  const d = useData(() => (ny ? Promise.resolve(null) : hent<Reise>(`${sti}/${id}`)), [sti, id]);
  const admin = leder && erAdmin(org?.rolle);
  const ansatte = useData(
    () => (admin && ny ? hent<{ id: string; fornavn: string; etternavn: string; arbeidstaker: boolean; aktiv: boolean }[]>(`/org/${org!.id}/ansatte`) : Promise.resolve([])),
    [org?.id, admin, ny],
  );
  const [skjema, settSkjema] = useState<Skjema | null>(null);
  const [beregning, settBeregning] = useState<Beregning | null>(null);
  const [beregnFeil, settBeregnFeil] = useState<string | null>(null);
  const [trekkfri, settTrekkfri] = useState(true);
  const [avvis, settAvvis] = useState<string | null>(null);
  const h = useHandling();
  const r = d.data ?? null;

  useEffect(() => {
    if (ny) settSkjema(nytt(admin ? "" : (org?.ansatt_id ?? "")));
    else if (r) {
      settSkjema(tilSkjema(r));
      settTrekkfri(r.trekkfri);
    }
  }, [ny, r, admin, org?.ansatt_id]);

  const utbetalt = !!r?.lonnskjoring_id;
  const egen = !!r && r.ansatt_id === org?.ansatt_id;
  const kanEndre = ny || (!!r && !utbetalt && (admin || (egen && r.status !== "godkjent")));

  // Beregningen mens skjemaet fylles ut (den lagrede når den er godkjent).
  const tidtaker = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!skjema || !kanEndre) return;
    window.clearTimeout(tidtaker.current);
    tidtaker.current = window.setTimeout(async () => {
      try {
        settBeregning(await api<Beregning>("POST", `${sti}/beregn`, tilKropp(skjema, false, false)));
        settBeregnFeil(null);
      } catch (e) {
        settBeregnFeil((e as Error).message);
      }
    }, 400);
    return () => window.clearTimeout(tidtaker.current);
  }, [skjema, kanEndre, sti]);

  const tilbakeLenke = (
    <button type="button" className="lenke tilbake-lenke" onClick={tilbake}>
      <IkonVenstre storrelse={16} /> Reiser
    </button>
  );
  if (d.feil)
    return (
      <>
        {tilbakeLenke}
        <Feil melding={d.feil} />
      </>
    );
  if (!skjema || (!ny && !r)) return <Laster />;
  const s = skjema;
  const sett = (e: Partial<Skjema>) => settSkjema((x) => (x ? { ...x, ...e } : x));
  // Den godkjente beregningen (det som utbetales) til skjemaet endres; ellers den nye.
  const endret = !!r && JSON.stringify(tilKropp(s, false, false)) !== JSON.stringify(tilKropp(tilSkjema(r), false, false));
  const visning = r?.status === "godkjent" && !endret ? deler(r.beregning ?? []) : kanEndre ? beregning : (r?.utregning ?? null);

  const lagre = async (send = false) => {
    const lagret = await h.kjor(async () => {
      const x = ny ? await api<Reise>("POST", sti, tilKropp(s, admin, true)) : await api<Reise>("PUT", `${sti}/${id}`, tilKropp(s, admin, false));
      return send ? api<Reise>("POST", `${sti}/${x.id}/send`) : x;
    });
    if (!lagret) return;
    if (ny) apne(lagret.id);
    else d.settData(lagret);
  };
  const handling = async (sti2: string, kropp?: unknown) => {
    const x = await h.kjor(() => api<Reise>("POST", `${sti}/${id}/${sti2}`, kropp));
    if (x) d.settData(x);
  };
  const slett = async () => {
    if (!confirm("Slette reiseregningen?")) return;
    if (await h.kjor(() => api("DELETE", `${sti}/${id}`))) tilbake();
  };
  const dognListe = (kanEndre ? beregning?.dogn : r?.utregning?.dogn) ?? [];
  const maaltid = (nr: number, k: string, paa: boolean) => {
    const naa = s.maaltider[String(nr)] ?? "";
    const ny2 = ["F", "L", "M"].filter((x) => (x === k ? paa : naa.includes(x))).join("");
    sett({ maaltider: { ...s.maaltider, [String(nr)]: ny2 } });
  };

  return (
    <>
      {tilbakeLenke}
      <div className="topp">
        <h1>{ny ? "Ny reiseregning" : `${r!.sted || r!.formaal} ${periode(r!)}`}</h1>
        {r && merke(r)}
      </div>
      {r && (
        <p className="undertittel">
          {r.navn}
          {r.status === "avvist" && r.avvist_grunn ? ` · Avvist: ${r.avvist_grunn}` : ""}
          {r.godkjent_at && ` · Godkjent ${dato(r.godkjent_at)}${r.godkjent_av ? ` av ${r.godkjent_av}` : ""}`}
          {utbetalt && r.utbetalt_periode && ` · Utbetalt med lønnen for ${maaned(r.utbetalt_periode.slice(0, 7))} (${dato(r.utbetalt_dato)})`}
        </p>
      )}

      <section className="kort lonn-reise">
        <fieldset disabled={!kanEndre || h.opptatt}>
          {admin && ny && (
            <label>
              Ansatt
              <select value={s.ansatt_id} onChange={(e) => sett({ ansatt_id: e.target.value })}>
                <option value="">Velg …</option>
                {(ansatte.data ?? [])
                  .filter((a) => a.arbeidstaker && a.aktiv)
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.fornavn} {a.etternavn}
                    </option>
                  ))}
              </select>
            </label>
          )}
          <div className="rad">
            <label>
              Formål
              <input maxLength={200} placeholder="F.eks. kurs, kundemøte" value={s.formaal} onChange={(e) => sett({ formaal: e.target.value })} />
            </label>
            <label>
              Sted (reiserute)
              <input maxLength={200} placeholder="F.eks. Bergen" value={s.sted} onChange={(e) => sett({ sted: e.target.value })} />
            </label>
          </div>
          <div className="rad lonn-reise-tider">
            <label>
              Avreise
              <input type="datetime-local" value={s.fra} onChange={(e) => sett({ fra: e.target.value })} />
            </label>
            <label>
              Hjemkomst
              <input type="datetime-local" min={s.fra} value={s.til} onChange={(e) => sett({ til: e.target.value })} />
            </label>
            <label>
              Overnatting
              <select value={s.overnatting} onChange={(e) => sett({ overnatting: e.target.value as Overnatting })}>
                {Object.entries(OVERNATTING).map(([v, t]) => (
                  <option key={v} value={v}>
                    {t}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="rad lonn-reise-valg">
            <label>
              <input type="checkbox" checked={s.diett} onChange={(e) => sett({ diett: e.target.checked })} /> Kostgodtgjørelse (diett)
            </label>
            {(s.overnatting === "hybel" || s.overnatting === "privat") && !s.utland && (
              <label>
                <input type="checkbox" checked={s.nattillegg} onChange={(e) => sett({ nattillegg: e.target.checked })} /> Nattillegg (uten kvittering for overnattingen)
              </label>
            )}
            <label>
              <input type="checkbox" checked={s.utland} onChange={(e) => sett({ utland: e.target.checked })} /> Reise i utlandet
            </label>
          </div>
          {s.utland && (
            <div className="rad">
              <label>
                Land
                <input maxLength={60} value={s.land} onChange={(e) => sett({ land: e.target.value })} />
              </label>
              <label>
                Statens sats per døgn (kr)
                <input inputMode="decimal" placeholder="Fra regulativet for landet" value={s.kostsats} onChange={(e) => sett({ kostsats: e.target.value })} />
                <span className="felt-hjelp">Hele satsen per døgn og fra 12 timer, halvparten for 6–12 timer, og 25 % lavere fra det 29. døgnet. De trekkfrie satsene er de samme som i Norge.</span>
              </label>
            </div>
          )}
          <span className="felt-hjelp">Kostgodtgjørelse forutsetter at reisen er over 15 km fra både hjemmet og arbeidsstedet, og varer minst 6 timer.</span>

          {s.diett && dognListe.length > 0 && (
            <div className="lonn-reise-dogn">
              <h3>Måltider som er dekket</h3>
              <p className="felt-hjelp">Kryss av måltidene som er dekket av andre (også frokost i hotellprisen og mat i billetten). De trekkes fra satsen.</p>
              <ul>
                {dognListe.map((x) => (
                  <li key={x.nr}>
                    <span>
                      {s.overnatting === "ingen" ? "Dagsreisen" : `Døgn ${x.nr}`}
                      <span className="liten dempet">
                        {" "}
                        {tidTekst(x.fra)}–{tidTekst(x.til)} ({String(x.timer).replace(".", ",")} t)
                      </span>
                    </span>
                    <span className="lonn-reise-maaltider">
                      {[
                        ["F", "Frokost"],
                        ["L", "Lunsj"],
                        ["M", "Middag"],
                      ].map(([k, t]) => (
                        <label key={k}>
                          <input type="checkbox" checked={(s.maaltider[String(x.nr)] ?? "").includes(k!)} onChange={(e) => maaltid(x.nr, k!, e.target.checked)} /> {t}
                        </label>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <h3>Kjøring</h3>
          {s.kjoring.map((e, i) => {
            const endre = (x: Partial<Skjema["kjoring"][number]>) => sett({ kjoring: s.kjoring.map((y, j) => (j === i ? { ...y, ...x } : y)) });
            return (
              <div key={i} className="lonn-reise-etappe">
                <div className="rad">
                  <label>
                    Dato
                    <input type="date" value={e.dato} onChange={(v) => endre({ dato: v.target.value })} />
                  </label>
                  <label>
                    Fra
                    <input maxLength={100} value={e.fra} onChange={(v) => endre({ fra: v.target.value })} />
                  </label>
                  <label>
                    Til
                    <input maxLength={100} value={e.til} onChange={(v) => endre({ til: v.target.value })} />
                  </label>
                  <label>
                    Km
                    <input inputMode="decimal" value={e.km} onChange={(v) => endre({ km: v.target.value })} />
                  </label>
                </div>
                <div className="rad">
                  <label>
                    Kjøretøy
                    <select value={e.kjoretoy} onChange={(v) => endre({ kjoretoy: v.target.value as Kjoretoy })}>
                      {Object.entries(KJORETOY).map(([v, t]) => (
                        <option key={v} value={v}>
                          {t}
                        </option>
                      ))}
                    </select>
                  </label>
                  {e.kjoretoy === "bil" && (
                    <>
                      <label>
                        Passasjerer (navn)
                        <input placeholder="Skill med komma" value={e.passasjerer} onChange={(v) => endre({ passasjerer: v.target.value })} />
                      </label>
                      <label>
                        Km på skogsvei
                        <input inputMode="decimal" value={e.skogsvei} onChange={(v) => endre({ skogsvei: v.target.value })} />
                      </label>
                      <label>
                        <input type="checkbox" checked={e.tilhenger} onChange={(v) => endre({ tilhenger: v.target.checked })} /> Tilhenger eller utstyr
                      </label>
                    </>
                  )}
                </div>
                <button type="button" className="lenke fare-lenke" onClick={() => sett({ kjoring: s.kjoring.filter((_, j) => j !== i) })}>
                  Fjern kjøringen
                </button>
              </div>
            );
          })}
          <button
            type="button"
            className="lenke"
            onClick={() =>
              sett({ kjoring: [...s.kjoring, { dato: s.fra.slice(0, 10), fra: "", til: "", km: "", kjoretoy: "bil", passasjerer: "", skogsvei: "", tilhenger: false }] })
            }
          >
            + Legg til kjøring
          </button>

          <h3>Utlegg etter regning</h3>
          {s.utlegg.map((u, i) => {
            const endre = (x: Partial<Skjema["utlegg"][number]>) => sett({ utlegg: s.utlegg.map((y, j) => (j === i ? { ...y, ...x } : y)) });
            return (
              <div key={i} className="rad lonn-reise-utlegg">
                <label>
                  Dato
                  <input type="date" value={u.dato} onChange={(v) => endre({ dato: v.target.value })} />
                </label>
                <label>
                  Hva
                  <input maxLength={140} placeholder="F.eks. hotell, fly, parkering" value={u.tekst} onChange={(v) => endre({ tekst: v.target.value })} />
                </label>
                <label>
                  Beløp (kr)
                  <input inputMode="decimal" value={u.belop} onChange={(v) => endre({ belop: v.target.value })} />
                </label>
                <button type="button" className="lenke fare-lenke" onClick={() => sett({ utlegg: s.utlegg.filter((_, j) => j !== i) })}>
                  Fjern
                </button>
              </div>
            );
          })}
          <button type="button" className="lenke" onClick={() => sett({ utlegg: [...s.utlegg, { dato: s.fra.slice(0, 10), tekst: "", belop: "" }] })}>
            + Legg til utlegg
          </button>
          <span className="felt-hjelp">Kvitteringene leveres til arbeidsgiveren. Utleggene refunderes og rapporteres ikke.</span>

          <label>
            Merknad
            <textarea maxLength={500} rows={2} value={s.merknad} onChange={(e) => sett({ merknad: e.target.value })} />
          </label>
        </fieldset>
      </section>

      <section className="kort lonn-reise-beregning">
        <h3>Det reisen gir</h3>
        {visning ? (
          <>
            {visning.linjer.length ? (
              <table className="lonn-linjer">
                <tbody>
                  {visning.linjer.map((l, i) => (
                    <tr key={i}>
                      <td>{l.tekst.replace(/^[^:]*: /, "")}</td>
                      <td className="tall">{kr(l.belop)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="liten dempet">Ingenting å utbetale ennå.</p>
            )}
            <div className="summer lonn-summer">
              {visning.belop > 0 && (
                <>
                  <div>
                    <span>Trekkfritt</span>
                    <span>{kr(visning.trekkfritt)}</span>
                  </div>
                  {visning.trekkpliktig > 0 && (
                    <div>
                      <span>Trekkpliktig (med i lønnen)</span>
                      <span>{kr(visning.trekkpliktig)}</span>
                    </div>
                  )}
                  {visning.utlegg > 0 && (
                    <div>
                      <span>Utlegg</span>
                      <span>{kr(visning.utlegg)}</span>
                    </div>
                  )}
                </>
              )}
              <div className="total">
                <span>Utbetales</span>
                <span>{kr(visning.belop)}</span>
              </div>
            </div>
            {visning.merknader.map((m, i) => (
                <p key={i} className="liten advarsel-tekst">
                  {m}
                </p>
              ))}
          </>
        ) : (
          beregnFeil && <p className="liten dempet">{beregnFeil}</p>
        )}
        {kanEndre && beregnFeil && visning && <p className="liten dempet">{beregnFeil}</p>}
      </section>

      {admin && r?.status === "godkjent" && !utbetalt && (
        <p className="felt-hjelp">Endres reiseregningen, må den godkjennes på nytt. Den utbetales med neste lønnskjøring.</p>
      )}
      {admin && r && (r.status === "sendt" || r.status === "utkast") && (
        <label>
          <input type="checkbox" checked={trekkfri} onChange={(e) => settTrekkfri(e.target.checked)} /> Vilkårene for trekkfri godtgjørelse er oppfylt (reiseregningen har
          det den skal ha)
        </label>
      )}
      {avvis != null && (
        <label>
          Hvorfor avvises den?
          <input maxLength={300} value={avvis} onChange={(e) => settAvvis(e.target.value)} autoFocus />
        </label>
      )}
      <Feil melding={h.feil} />
      <div className="knapper">
        {kanEndre && (
          <>
            <button type="button" className={admin && (r?.status === "sendt" || r?.status === "godkjent") ? undefined : "primar"} disabled={h.opptatt} onClick={() => void lagre(false)}>
              {ny ? "Lagre som utkast" : "Lagre"}
            </button>
            {(ny || r?.status === "utkast" || r?.status === "avvist") && (
              <button type="button" disabled={h.opptatt} onClick={() => void lagre(true)}>
                Lagre og send
              </button>
            )}
          </>
        )}
        {admin && r && !utbetalt && (r.status === "sendt" || r.status === "utkast") && (
          <button type="button" className="primar" disabled={h.opptatt} onClick={() => void handling("godkjenn", { trekkfri })}>
            Godkjenn
          </button>
        )}
        {admin && r?.status === "sendt" &&
          (avvis == null ? (
            <button type="button" disabled={h.opptatt} onClick={() => settAvvis("")}>
              Avvis
            </button>
          ) : (
            <>
              <button type="button" className="fare" disabled={h.opptatt || !avvis.trim()} onClick={() => void handling("avvis", { grunn: avvis }).then(() => settAvvis(null))}>
                Avvis reiseregningen
              </button>
              <button type="button" onClick={() => settAvvis(null)}>
                Avbryt
              </button>
            </>
          ))}
        {admin && r?.status === "godkjent" && !utbetalt && (
          <button type="button" disabled={h.opptatt} onClick={() => void handling("apne")}>
            Åpne igjen
          </button>
        )}
        {r && !utbetalt && (admin || (egen && r.status !== "godkjent")) && (
          <button type="button" className="lenke fare-lenke" disabled={h.opptatt} onClick={() => void slett()}>
            Slett
          </button>
        )}
      </div>
    </>
  );
}
