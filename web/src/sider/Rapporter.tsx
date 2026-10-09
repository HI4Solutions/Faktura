// Rapporter: én side for rapportene fra alle modulene (server/src/rapportmodul.ts), med en fane per
// modul (Faktura, Personal, Lønn og de som kommer) og Utsending (rapportene til regnskapsføreren).
// Hver rapport vises som tabell med valgene sine (periode, termin, år), og kan lastes ned som CSV
// eller PDF, eller sendes på e-post.
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { api, hent, lastNed } from "../api";
import { Dialog, EpostlisteFelt, Feil, Laster, Tom, tilEpostliste, ugyldigeEposter, useData, useHandling, useSmal } from "../felles";
import { erAdmin, useKonto } from "../konto";
import { dato, kr } from "../format";

type Parameter = "periode" | "termin" | "aar" | "ingen";
type Rapportinfo = { id: string; navn: string; beskrivelse: string; parameter: Parameter; maanedlig: boolean };
type Modul = { id: string; navn: string; rapporter: Rapportinfo[] };
type Kolonnetype = "tekst" | "tall" | "kr" | "timer" | "dato" | "prosent" | "antall";
type Kolonne = { nokkel: string; navn: string; type?: Kolonnetype; sum?: boolean };
type Resultat = {
  id: string;
  navn: string;
  beskrivelse: string;
  periode: string;
  merknad?: string;
  kolonner: Kolonne[];
  rader: Record<string, unknown>[];
  sum: Record<string, number> | null;
};
type Oppsett = { mottakere: string[]; lonn_ved_godkjenning: boolean; maanedlig: string[]; oppdatert: string | null };
type Utsending = { id: number; tid: string; til: string[]; rapporter: { id: string; navn: string; periode: string }[]; automatisk: "lonn" | "maaned" | null; feil: string | null; sendt_av: string | null };

const iDag = () => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Oslo" }).format(new Date());
const sisteDag = (aar: number, mnd: number) => new Date(Date.UTC(aar, mnd, 0)).toISOString().slice(0, 10);
const MAANEDER = ["jan–feb", "mar–apr", "mai–jun", "jul–aug", "sep–okt", "nov–des"];
const tall = new Intl.NumberFormat("nb-NO", { maximumFractionDigits: 2 });

function vis(v: unknown, type: Kolonnetype = "tekst"): string {
  if (v == null || v === "") return "";
  if (type === "dato" && typeof v === "string") return dato(v);
  const n = Number(v);
  if (type === "kr" && Number.isFinite(n)) return kr(n);
  if ((type === "tall" || type === "timer" || type === "antall") && Number.isFinite(n)) return tall.format(n);
  if (type === "prosent" && Number.isFinite(n)) return `${tall.format(n)} %`;
  return String(v);
}
const hoyre = (t?: Kolonnetype) => t === "kr" || t === "tall" || t === "timer" || t === "antall" || t === "prosent";

// Valgene for en rapport, som spørrestreng.
type Valg = { periode: "denne" | "forrige" | "aar" | "ifjor" | "egen"; fra: string; til: string; aar: number; termin: number };
function standardValg(): Valg {
  const d = iDag();
  return { periode: "denne", fra: `${d.slice(0, 7)}-01`, til: sisteDag(Number(d.slice(0, 4)), Number(d.slice(5, 7))), aar: Number(d.slice(0, 4)), termin: Math.floor((Number(d.slice(5, 7)) - 1) / 2) + 1 };
}
function periodeFra(p: Valg["periode"], v: Valg): Pick<Valg, "fra" | "til"> {
  const d = iDag();
  const [aar, mnd] = [Number(d.slice(0, 4)), Number(d.slice(5, 7))];
  if (p === "denne") return { fra: `${d.slice(0, 7)}-01`, til: sisteDag(aar, mnd) };
  if (p === "forrige") {
    const [a, m] = mnd === 1 ? [aar - 1, 12] : [aar, mnd - 1];
    return { fra: `${a}-${String(m).padStart(2, "0")}-01`, til: sisteDag(a, m) };
  }
  if (p === "aar") return { fra: `${aar}-01-01`, til: `${aar}-12-31` };
  if (p === "ifjor") return { fra: `${aar - 1}-01-01`, til: `${aar - 1}-12-31` };
  return { fra: v.fra, til: v.til };
}
const sporring = (p: Parameter, v: Valg) =>
  p === "periode" ? `fra=${v.fra}&til=${v.til}` : p === "termin" ? `aar=${v.aar}&termin=${v.termin}` : p === "aar" ? `aar=${v.aar}` : "";
const valgTilApi = (p: Parameter, v: Valg) =>
  p === "periode" ? { fra: v.fra, til: v.til } : p === "termin" ? { aar: v.aar, termin: v.termin } : p === "aar" ? { aar: v.aar } : {};

export function Rapporter() {
  const { org } = useKonto();
  const [sok, settSok] = useSearchParams();
  const liste = useData(() => hent<{ moduler: Modul[] }>(`/org/${org!.id}/rapportmodul`), [org?.id]);
  const admin = erAdmin(org?.rolle);
  const moduler = liste.data?.moduler ?? [];
  const faner: [string, string][] = [...moduler.map((m) => [m.id, m.navn] as [string, string]), ...(admin && moduler.length ? [["utsending", "Utsending"] as [string, string]] : [])];
  const fane = faner.find(([v]) => v === sok.get("fane"))?.[0] ?? faner[0]?.[0];
  const modul = moduler.find((m) => m.id === fane);

  if (liste.feil) return <Feil melding={liste.feil} />;
  if (!liste.data) return <Laster />;
  return (
    <>
      <h1>Rapporter</h1>
      {!moduler.length ? (
        <div className="kort">
          <Tom tittel="Ingen rapporter">
            <p>Du har ikke tilgang til rapporter i {org?.navn}.</p>
          </Tom>
        </div>
      ) : (
        <>
          <div className="faner" role="tablist" aria-label="Rapporter">
            {faner.map(([v, navn]) => (
              <button key={v} type="button" role="tab" aria-selected={fane === v} className={fane === v ? "valgt" : undefined} onClick={() => settSok({ fane: v }, { replace: true })}>
                {navn}
              </button>
            ))}
          </div>
          {modul && <ModulRapporter key={modul.id} modul={modul} admin={admin} />}
          {fane === "utsending" && <UtsendingOppsett moduler={moduler} />}
        </>
      )}
    </>
  );
}

function ModulRapporter({ modul, admin }: { modul: Modul; admin: boolean }) {
  const [sok, settSok] = useSearchParams();
  const smal = useSmal(860); // som i styles.css: listen blir en nedtrekksliste
  const valgt = modul.rapporter.find((r) => r.id === sok.get("rapport")) ?? modul.rapporter[0]!;
  const velg = (id: string) => settSok({ fane: modul.id, rapport: id }, { replace: true });
  return (
    <div className="rapport-oppsett">
      {smal ? (
        <label className="rapport-velger">
          Rapport
          <select value={valgt.id} onChange={(e) => velg(e.target.value)}>
            {modul.rapporter.map((r) => (
              <option key={r.id} value={r.id}>
                {r.navn}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <nav className="rapport-liste" aria-label={`Rapporter for ${modul.navn}`}>
          {modul.rapporter.map((r) => (
            <button key={r.id} type="button" className={r.id === valgt.id ? "valgt" : undefined} aria-current={r.id === valgt.id || undefined} onClick={() => velg(r.id)}>
              {r.navn}
            </button>
          ))}
        </nav>
      )}
      <RapportVisning key={valgt.id} rapport={valgt} admin={admin} />
    </div>
  );
}

function RapportVisning({ rapport, admin }: { rapport: Rapportinfo; admin: boolean }) {
  const { org } = useKonto();
  const [v, settV] = useState<Valg>(standardValg);
  const q = sporring(rapport.parameter, v);
  const data = useData(() => hent<Resultat>(`/org/${org!.id}/rapportmodul/${rapport.id}${q ? `?${q}` : ""}`), [org?.id, rapport.id, q]);
  const h = useHandling();
  const [send, settSend] = useState(false);
  const r = data.data;
  const aarene = useMemo(() => {
    const a = Number(iDag().slice(0, 4));
    return [a + 1, a, a - 1, a - 2, a - 3];
  }, []);
  const filnavn = (x: string) => `${`${rapport.navn}-${r?.periode ?? ""}`.toLowerCase().replace(/[^a-z0-9æøå]+/g, "-").replace(/^-|-$/g, "")}.${x}`;

  return (
    <section className="kort rapport-visning">
      <div className="rapport-topp">
        <div>
          <h2>{rapport.navn}</h2>
          <p className="dempet liten">{rapport.beskrivelse}</p>
        </div>
      </div>
      <div className="rapport-valg">
        {rapport.parameter === "periode" && (
          <>
            <label>
              Periode
              <select value={v.periode} onChange={(e) => settV({ ...v, periode: e.target.value as Valg["periode"], ...periodeFra(e.target.value as Valg["periode"], v) })}>
                <option value="denne">Denne måneden</option>
                <option value="forrige">Forrige måned</option>
                <option value="aar">I år</option>
                <option value="ifjor">I fjor</option>
                <option value="egen">Velg datoer</option>
              </select>
            </label>
            {v.periode === "egen" && (
              <>
                <label>
                  Fra
                  <input type="date" value={v.fra} onChange={(e) => e.target.value && settV({ ...v, fra: e.target.value })} />
                </label>
                <label>
                  Til
                  <input type="date" value={v.til} onChange={(e) => e.target.value && settV({ ...v, til: e.target.value })} />
                </label>
              </>
            )}
          </>
        )}
        {(rapport.parameter === "termin" || rapport.parameter === "aar") && (
          <label>
            År
            <select value={v.aar} onChange={(e) => settV({ ...v, aar: Number(e.target.value) })}>
              {aarene.map((a) => (
                <option key={a}>{a}</option>
              ))}
            </select>
          </label>
        )}
        {rapport.parameter === "termin" && (
          <label>
            Termin
            <select value={v.termin} onChange={(e) => settV({ ...v, termin: Number(e.target.value) })}>
              {MAANEDER.map((t, i) => (
                <option key={i} value={i + 1}>
                  {i + 1}. termin ({t})
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="knapper rapport-knapper">
          <button type="button" disabled={!r || h.opptatt} onClick={() => h.kjor(() => lastNed(`/org/${org!.id}/rapportmodul/${rapport.id}/csv${q ? `?${q}` : ""}`, filnavn("csv")))}>
            CSV
          </button>
          <button type="button" disabled={!r || h.opptatt} onClick={() => h.kjor(() => lastNed(`/org/${org!.id}/rapportmodul/${rapport.id}/pdf${q ? `?${q}` : ""}`, filnavn("pdf")))}>
            PDF
          </button>
          {admin && (
            <button type="button" disabled={!r} onClick={() => settSend(true)}>
              Send
            </button>
          )}
        </div>
      </div>
      <Feil melding={h.feil ?? data.feil} />
      {!r ? (
        !data.feil && <Laster />
      ) : (
        <>
          <p className="liten rapport-periode">
            <strong>{r.periode}</strong>
            {r.merknad && <span className="dempet"> · {r.merknad}</span>}
          </p>
          {!r.rader.length ? (
            <p className="dempet">Ingen rader {rapport.parameter === "ingen" ? "nå" : "i perioden"}.</p>
          ) : (
            <div className="tabell-rull">
              <table className="rapport-tabell">
                <thead>
                  <tr>
                    {r.kolonner.map((k) => (
                      <th key={k.nokkel} className={hoyre(k.type) ? "hoyre" : undefined}>
                        {k.navn}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {r.rader.map((rad, i) => (
                    <tr key={i}>
                      {r.kolonner.map((k) => (
                        <td key={k.nokkel} className={hoyre(k.type) ? "tall" : undefined}>
                          {vis(rad[k.nokkel], k.type)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
                {r.sum && (
                  <tfoot>
                    <tr>
                      {r.kolonner.map((k, i) => (
                        <td key={k.nokkel} className={hoyre(k.type) ? "tall" : undefined}>
                          <strong>{i === 0 ? "Sum" : r.sum![k.nokkel] != null ? vis(r.sum![k.nokkel], k.type) : ""}</strong>
                        </td>
                      ))}
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          )}
        </>
      )}
      {send && r && <SendDialog lukk={() => settSend(false)} rapporter={[{ id: rapport.id, navn: rapport.navn, periode: r.periode, valg: valgTilApi(rapport.parameter, v) }]} />}
    </section>
  );
}

// Send en eller flere rapporter på e-post (til regnskapsføreren i oppsettet, eller andre).
function SendDialog({ lukk, rapporter }: { lukk: () => void; rapporter: { id: string; navn: string; periode: string; valg: Record<string, unknown> }[] }) {
  const { org } = useKonto();
  const oppsett = useData(() => hent<{ oppsett: Oppsett }>(`/org/${org!.id}/rapportmodul/oppsett`), [org?.id]);
  const [til, settTil] = useState<string | null>(null);
  const [melding, settMelding] = useState("");
  const [sendt, settSendt] = useState<string[] | null>(null);
  const h = useHandling();
  useEffect(() => {
    if (oppsett.data && til === null) settTil(oppsett.data.oppsett.mottakere.join(", "));
  }, [oppsett.data, til]);

  async function send(e: FormEvent) {
    e.preventDefault();
    const liste = tilEpostliste(til ?? "");
    if (!liste.length) return h.settFeil("Skriv minst én e-postadresse.");
    if (ugyldigeEposter(til ?? "").length) return h.settFeil("Rett e-postadressene først.");
    const r = await h.kjor(() => api<{ til: string[] }>("POST", `/org/${org!.id}/rapportmodul/send`, { rapporter: rapporter.map(({ id, valg }) => ({ id, valg })), til: liste, melding: melding.trim() || undefined }));
    if (r) settSendt(r.til);
  }

  return (
    <Dialog apen lukk={lukk} tittel="Send rapport">
      {sendt ? (
        <>
          <div className="melding ok" role="status">
            Rapporten sendes til {sendt.join(", ")} (PDF og CSV). Du finner den under Rapporter → Utsending.
          </div>
          <div className="knapper">
            <button type="button" className="primar" onClick={lukk}>
              Lukk
            </button>
          </div>
        </>
      ) : (
        <form onSubmit={send}>
          <ul className="liten">
            {rapporter.map((r) => (
              <li key={r.id}>
                {r.navn}, {r.periode}
              </li>
            ))}
          </ul>
          {til === null ? (
            <Laster />
          ) : (
            <EpostlisteFelt
              etikett="Til"
              verdi={til}
              endre={settTil}
              hjelp="Regnskapsføreren fra Rapporter → Utsending. Skill flere adresser med komma."
              plassholder="regnskap@byraa.no"
            />
          )}
          <label>
            Melding (valgfritt)
            <textarea rows={3} maxLength={2000} value={melding} onChange={(e) => settMelding(e.target.value)} />
          </label>
          <p className="liten dempet">Rapporten sendes som PDF og CSV. Svar på e-posten går til deg.</p>
          <Feil melding={h.feil} />
          <div className="knapper">
            <button className="primar" disabled={h.opptatt || til === null}>
              Send
            </button>
            <button type="button" onClick={lukk}>
              Avbryt
            </button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

// Utsending: regnskapsføreren, lønnsrapportene ved godkjenning, månedsrapportene og loggen.
function UtsendingOppsett({ moduler }: { moduler: Modul[] }) {
  const { org } = useKonto();
  const data = useData(() => hent<{ oppsett: Oppsett; sendt: Utsending[] }>(`/org/${org!.id}/rapportmodul/oppsett`), [org?.id]);
  const [o, settO] = useState<{ mottakere: string; lonn_ved_godkjenning: boolean; maanedlig: string[] } | null>(null);
  const [lagret, settLagret] = useState(false);
  const h = useHandling();
  useEffect(() => {
    if (data.data && !o) settO({ ...data.data.oppsett, mottakere: data.data.oppsett.mottakere.join(", ") });
  }, [data.data, o]);
  const lonn = moduler.some((m) => m.id === "lonn");
  const maanedlige = moduler.map((m) => ({ ...m, rapporter: m.rapporter.filter((r) => r.maanedlig) })).filter((m) => m.rapporter.length);

  async function lagre(e: FormEvent) {
    e.preventDefault();
    settLagret(false);
    if (ugyldigeEposter(o!.mottakere).length) return h.settFeil("Rett e-postadressene først.");
    const r = await h.kjor(() =>
      api("PUT", `/org/${org!.id}/rapportmodul/oppsett`, { mottakere: tilEpostliste(o!.mottakere), lonn_ved_godkjenning: o!.lonn_ved_godkjenning, maanedlig: o!.maanedlig }),
    );
    if (r) {
      settLagret(true);
      void data.last();
    }
  }

  if (data.feil) return <Feil melding={data.feil} />;
  if (!data.data || !o) return <Laster />;
  return (
    <>
      <form className="kort" onSubmit={lagre}>
        <h2>Til regnskapsføreren</h2>
        <p className="dempet">
          Rapportene sendes på e-post som PDF og CSV. Bare eier og administrator kan endre dette, og alle eierne får beskjed når rapportene skal til en ny
          adresse.
        </p>
        <EpostlisteFelt
          etikett="E-postadresser"
          verdi={o.mottakere}
          endre={(mottakere) => settO({ ...o, mottakere })}
          hjelp="Skill flere adresser med komma (høyst 10)."
          plassholder="regnskap@byraa.no"
        />
        {lonn && (
          <label>
            <input type="checkbox" checked={o.lonn_ved_godkjenning} onChange={(e) => settO({ ...o, lonn_ved_godkjenning: e.target.checked })} />
            Send lønnsjournalen, summen per lønnsart og lønnsbilaget når en lønnskjøring godkjennes
          </label>
        )}
        <h3>Hver måned</h3>
        <p className="liten dempet">De valgte rapportene sendes den 1. i måneden for forrige måned (termin- og årsrapporter når terminen eller året er slutt).</p>
        <div className="rapport-maanedlig">
          {maanedlige.map((m) => (
            <fieldset key={m.id} className="naken">
              <legend>{m.navn}</legend>
              {m.rapporter.map((r) => (
                <label key={r.id}>
                  <input
                    type="checkbox"
                    checked={o.maanedlig.includes(r.id)}
                    onChange={(e) => settO({ ...o, maanedlig: e.target.checked ? [...o.maanedlig, r.id] : o.maanedlig.filter((x) => x !== r.id) })}
                  />
                  {r.navn}
                </label>
              ))}
            </fieldset>
          ))}
        </div>
        <Feil melding={h.feil} />
        {lagret && (
          <div className="melding ok" role="status">
            Lagret.
          </div>
        )}
        <div className="knapper">
          <button className="primar" disabled={h.opptatt}>
            Lagre
          </button>
        </div>
      </form>
      <section className="kort">
        <h2>Sendt</h2>
        {!data.data.sendt.length ? (
          <p className="dempet">Ingen rapporter er sendt ennå.</p>
        ) : (
          <ul className="admin-rader">
            {data.data.sendt.map((u) => (
              <li key={u.id}>
                <span>
                  {u.rapporter.map((r) => `${r.navn} (${r.periode})`).join(", ") || "Ingen rapporter"}
                  <span className="dempet liten"> · til {u.til.join(", ")}</span>
                  {u.feil && <span className="liten fare-tekst"> · {u.feil}</span>}
                </span>
                <span className="dempet liten">
                  {new Date(u.tid).toLocaleString("nb-NO", { timeZone: "Europe/Oslo", dateStyle: "short", timeStyle: "short" })} ·{" "}
                  {u.automatisk === "lonn" ? "ved godkjent lønn" : u.automatisk === "maaned" ? "månedlig" : (u.sendt_av ?? "manuelt")}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
