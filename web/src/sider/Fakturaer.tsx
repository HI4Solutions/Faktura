import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api, apnePdf, hent, lastNed } from "../api";
import { Dialog, EpostlisteFelt, Feil, Laster, tall, tilEpostliste, ugyldigeEposter, useData, useHandling, useSmal } from "../felles";
import { erAdmin, kanBokfore, kanSkrive, useKonto } from "../konto";
import { dato, epostStatus, fakturaMerke, iDag, kr, leggTilDager, linjebelop, summer } from "../format";
import { KundeSkjema, ProduktSkjema } from "./Register";
import { AvsenderKonto, useFasteValg } from "./AvsenderKonto";
import { IkonPluss } from "../ikoner";
import { gebyrLinjer, harRabatt, LinjeTabell, medProdukt, NotatFelt, RabattKnapp, tilTallLinjer, tilUtkast, tomLinje, useLinjefeil, type LinjeUtkast } from "../linjer";
import { kundeValg, Sokefelt } from "../sokefelt";

// ---------------------------------------------------------------------------
// Liste
// ---------------------------------------------------------------------------

export function Fakturaliste() {
  const { org } = useKonto();
  const nav = useNavigate();
  // Filteret står i adressen (?status=utstedt), så lenker fra oversikten og varsler treffer riktig fane.
  const [sok, settSok] = useSearchParams();
  const status = sok.get("status") ?? "";
  const settStatus = (s: string) => settSok(s ? { status: s } : {}, { replace: true });
  const { data, feil, laster, last } = useData(() => hent(`/org/${org!.id}/fakturaer${status ? `?status=${status}` : ""}`), [org?.id, status]);
  const [sendUtkast, settSendUtkast] = useState(false);
  const utkast = status === "utkast" ? (data ?? []) : [];

  return (
    <>
      <div className="topp">
        <h1>Fakturaer</h1>
        {kanSkrive(org?.rolle) && (
          <div className="knapper">
            <Link className="knapp" to="/fakturaer/flere">
              Flere på én gang
            </Link>
            <Link className="knapp primar" to="/fakturaer/ny">
              <IkonPluss storrelse={16} /> Ny faktura
            </Link>
          </div>
        )}
      </div>
      <div className="faner" role="tablist">
        {[
          ["", "Alle"],
          ["utkast", "Utkast"],
          ["utstedt", "Ubetalt"],
          ["betalt", "Betalt"],
          ["kreditert", "Kreditert"],
        ].map(([v, t]) => (
          <button key={v} role="tab" aria-selected={status === v} className={status === v ? "valgt" : ""} onClick={() => settStatus(v)}>
            {t}
          </button>
        ))}
      </div>
      {utkast.length > 0 && kanSkrive(org?.rolle) && (
        <div className="knapper" style={{ marginBottom: 14 }}>
          <button type="button" onClick={() => settSendUtkast(true)}>
            Send flere utkast …
          </button>
        </div>
      )}
      <Feil melding={feil} />
      {laster && !data ? <Laster /> : <Fakturatabell rader={data ?? []} klikk={(id) => nav(`/fakturaer/${id}`)} />}
      <Dialog apen={sendUtkast} lukk={() => settSendUtkast(false)} tittel="Send utkast">
        <SendUtkast
          utkast={utkast}
          ferdig={() => {
            settSendUtkast(false);
            last();
          }}
        />
      </Dialog>
    </>
  );
}

// Send mange utkast samlet. Utkast uten linjer kan ikke sendes.
function SendUtkast({ utkast, ferdig }: { utkast: any[]; ferdig: () => void }) {
  const { org } = useKonto();
  const klare = utkast.filter((u) => u.antall_linjer > 0);
  const [valgt, settValgt] = useState<Set<string>>(() => new Set(klare.map((u) => u.id)));
  const [resultat, settResultat] = useState<{ fakturaer: any[]; ikke_sendt: string[]; hoppet_over: string[] } | null>(null);
  const h = useHandling();
  const valgte = klare.filter((u) => valgt.has(u.id));
  const total = valgte.reduce((s, u) => s + Number(u.sum_inkl_mva ?? 0), 0);
  const utenEpost = valgte.filter((u) => !u.kunde_epost);
  const alle = valgte.length === klare.length && klare.length > 0;
  const n = (x: number) => `${x} ${x === 1 ? "faktura" : "fakturaer"}`;

  async function send() {
    if (!confirm(`Sende ${n(valgte.length)} på til sammen ${kr(total)} kr? De får fakturanummer og kan ikke endres etterpå.`)) return;
    const r = await h.kjor(() => api("POST", `/org/${org!.id}/fakturaer/utsted-flere`, { ider: valgte.map((u) => u.id) }));
    if (r) settResultat(r);
  }

  if (resultat)
    return (
      <>
        <div className="melding ok">{n(resultat.fakturaer.length)} er utstedt og sendes på e-post nå.</div>
        {resultat.hoppet_over.length > 0 && <p className="liten dempet">{n(resultat.hoppet_over.length)} var allerede sendt og ble hoppet over.</p>}
        {resultat.ikke_sendt.length > 0 && (
          <div className="melding feil">{n(resultat.ikke_sendt.length)} kom ikke i kø for sending. Åpne dem og trykk «Send på nytt».</div>
        )}
        <div className="knapper">
          <button type="button" className="primar" onClick={ferdig}>
            Ferdig
          </button>
        </div>
      </>
    );

  return (
    <div className="flervalg">
      <label className="velg-alle">
        <input type="checkbox" checked={alle} onChange={() => settValgt(alle ? new Set() : new Set(klare.map((u) => u.id)))} />
        Velg alle ({klare.length})
      </label>
      <div className="flervalg-liste">
        {utkast.map((u) => {
          const ok = u.antall_linjer > 0;
          return (
            <label key={u.id} className={ok ? undefined : "av"}>
              <input
                type="checkbox"
                disabled={!ok}
                checked={valgt.has(u.id)}
                onChange={() =>
                  settValgt((v) => {
                    const ny = new Set(v);
                    if (ny.has(u.id)) ny.delete(u.id);
                    else ny.add(u.id);
                    return ny;
                  })
                }
              />
              <span>
                <span className="linje">
                  <span className="navn">{u.kunde_navn}</span>
                  {ok && <span className="belop">{kr(u.sum_inkl_mva)}</span>}
                </span>
                <span className="dempet liten">
                  {!ok ? "Ingen linjer – åpne utkastet og fyll det ut" : u.kunde_epost ?? "Mangler e-post: blir utstedt, men ikke sendt"}
                </span>
              </span>
            </label>
          );
        })}
      </div>
      {utenEpost.length > 0 && (
        <p className="liten dempet">
          {utenEpost.length === 1 ? "Én kunde" : `${utenEpost.length} kunder`} mangler e-post og får ikke fakturaen på e-post.
        </p>
      )}
      <Feil melding={h.feil} />
      <div className="knapper">
        <button type="button" className="primar" disabled={!valgte.length || h.opptatt} onClick={send}>
          {h.opptatt ? "Sender …" : `Send ${n(valgte.length)} (${kr(total)})`}
        </button>
      </div>
    </div>
  );
}

export function Fakturatabell({ rader, klikk }: { rader: any[]; klikk: (id: string) => void }) {
  const smal = useSmal();
  if (smal) {
    return (
      <div className="kort liste">
        {rader.map((f) => {
          const m = fakturaMerke(f);
          return (
            <button key={f.id} type="button" className="liste-rad" onClick={() => klikk(f.id)}>
              <span className="linje">
                <span className="tittel">{f.kunde_navn}</span>
                <span className="belop">{f.sum_inkl_mva == null ? "" : kr(f.sum_inkl_mva)}</span>
              </span>
              <span className="linje">
                <span className="under">
                  {f.fakturanummer ? `Nr. ${f.fakturanummer}` : "Utkast"}
                  {f.type === "kreditnota" ? " · kreditnota" : f.forfallsdato ? ` · forfall ${dato(f.forfallsdato)}` : ""}
                </span>
                <span className={`merke ${m.klasse}`}>{m.tekst}</span>
              </span>
            </button>
          );
        })}
        {rader.length === 0 && <p className="dempet" style={{ padding: "16px" }}>Ingen fakturaer her.</p>}
      </div>
    );
  }
  return (
    <div className="kort tabell">
      <table>
        <thead>
          <tr>
            <th>Nr.</th>
            <th>Kunde</th>
            <th>Dato</th>
            <th>Forfall</th>
            <th className="hoyre">Beløp</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {rader.map((f) => {
            const m = fakturaMerke(f);
            return (
              <tr key={f.id} className="klikkbar" onClick={() => klikk(f.id)}>
                <td>{f.fakturanummer ?? "–"}</td>
                <td>{f.kunde_navn}</td>
                <td>{dato(f.fakturadato)}</td>
                <td>{f.type === "faktura" ? dato(f.forfallsdato) : ""}</td>
                <td className="tall">{f.sum_inkl_mva == null ? "" : kr(f.sum_inkl_mva)}</td>
                <td>
                  <span className={`merke ${m.klasse}`}>{m.tekst}</span>
                </td>
              </tr>
            );
          })}
          {rader.length === 0 && (
            <tr>
              <td colSpan={6} className="dempet">
                Ingen fakturaer her.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Skjema for utkast
// ---------------------------------------------------------------------------

export function FakturaSkjema() {
  const { id } = useParams();
  const { org } = useKonto();
  const nav = useNavigate();
  const orgData = useData(() => hent(`/org/${org!.id}`), [org?.id]);
  const kunder = useData(() => hent(`/org/${org!.id}/kunder?aktiv=true`), [org?.id]);
  const produkter = useData(() => hent(`/org/${org!.id}/produkter?aktiv=true`), [org?.id]);
  const [f, settF] = useState<any>({ kunde_id: "", fakturadato: iDag(), forfallsdato: "", periode_fra: "", periode_til: "", deres_referanse: "", var_referanse: "", notat: "", kommentar: "" });
  const [linjer, settLinjer] = useState<LinjeUtkast[]>([tomLinje()]);
  const [lastet, settLastet] = useState(!id); // et utkast som endres, er hentet
  const [rabattValgt, settRabattValgt] = useState(false);
  const visRabatt = rabattValgt || harRabatt(linjer);
  const [gebyr, settGebyr] = useState(false);
  const [nyKunde, settNyKunde] = useState<{ navn: string } | null>(null);
  const [nyttProdukt, settNyttProdukt] = useState<{ linje: number | "ny"; navn?: string } | null>(null); // linjen produktet skal inn på
  const [kopi, settKopi] = useState("");
  const { opptatt, feil, settFeil, kjor } = useHandling();

  // Fyll inn eksisterende utkast.
  useEffect(() => {
    if (!id) return;
    hent(`/org/${org!.id}/fakturaer/${id}`).then((u) => {
      settF({
        kunde_id: u.kunde_id,
        fakturadato: u.fakturadato ?? "",
        forfallsdato: u.forfallsdato ?? "",
        periode_fra: u.periode_fra ?? "",
        periode_til: u.periode_til ?? "",
        deres_referanse: u.deres_referanse ?? "",
        var_referanse: u.var_referanse ?? "",
        notat: u.notat ?? "",
        kommentar: u.kommentar ?? "",
        konto_id: u.konto_id ?? null,
        avsender: u.avsender ?? null,
      });
      settKopi((u.kopi_til ?? []).join(", "));
      settLinjer(u.linjer.map(tilUtkast));
      settLastet(true);
    });
  }, [id, org]);

  // Standard forfall fra innstillingene.
  useEffect(() => {
    if (!id && orgData.data && f.fakturadato && !f.forfallsdato) {
      settF((x: any) => ({ ...x, forfallsdato: leggTilDager(x.fakturadato, orgData.data.standard_forfall_dager) }));
      settGebyr(orgData.data.standard_gebyr > 0);
    }
  }, [orgData.data, id, f.fakturadato, f.forfallsdato]);

  const utenMva = Boolean(orgData.data && !orgData.data.mva_registrert);
  const tallLinjer = tilTallLinjer(linjer, utenMva);
  const sum = useMemo(() => summer([...tallLinjer, ...gebyrLinjer(gebyr, orgData.data)]), [JSON.stringify(tallLinjer), gebyr, orgData.data]);
  const kunde = kunder.data?.find((k: any) => k.id === f.kunde_id);
  const rabatt = Math.round((summer(tallLinjer.map((l) => ({ ...l, rabatt_prosent: null, rabatt_belop: null }))).eks - summer(tallLinjer).eks) * 100) / 100;
  const sjekkLinjer = useLinjefeil(linjer, settFeil);
  const vekslRabatt = () => {
    if (!visRabatt) return settRabattValgt(true);
    settRabattValgt(false);
    settLinjer(linjer.map((l) => ({ ...l, rabatt: "" })));
  };
  // Produkter med fast avsender eller konto velger dem når de legges på.
  const ulikeFasteValg = useFasteValg(linjer, produkter.data, lastet, (v) => settF((x: any) => ({ ...x, ...v })));

  // Et produkt laget fra skjemaet havner på linjen det ble laget fra, ellers på første
  // tomme linje (eller en ny linje).
  function brukNyttProdukt(p: any, hvor: number | "ny") {
    void produkter.last();
    settLinjer((ls) => medProdukt(ls, p, hvor));
  }

  async function lagre(utsted: boolean) {
    const feilAdresser = ugyldigeEposter(kopi);
    if (feilAdresser.length) return settFeil(`Ugyldig e-postadresse for kopi: ${feilAdresser.join(", ")}`);
    if (sjekkLinjer()) return;
    const kropp = {
      kunde_id: f.kunde_id,
      fakturadato: f.fakturadato || null,
      forfallsdato: f.forfallsdato || null,
      periode_fra: f.periode_fra || null,
      periode_til: f.periode_til || null,
      deres_referanse: f.deres_referanse || null,
      var_referanse: f.var_referanse || null,
      notat: f.notat || null,
      kommentar: f.kommentar.trim() || null,
      konto_id: f.konto_id ?? null,
      avsender: f.avsender ?? null,
      kopi_til: tilEpostliste(kopi),
      gebyr,
      linjer: tallLinjer,
    };
    const r = await kjor(async () => {
      const u = id ? await api("PUT", `/org/${org!.id}/fakturaer/${id}`, kropp) : await api("POST", `/org/${org!.id}/fakturaer`, kropp);
      if (utsted) await api("POST", `/org/${org!.id}/fakturaer/${u.id}/utsted`, { send_epost: true });
      return u;
    });
    if (r) nav(`/fakturaer/${r.id}`);
  }

  if (!kunder.data || !orgData.data) return <Laster />;
  const fastKopi: string[] = orgData.data.kopi_til?.length ? orgData.data.kopi_til : orgData.data.epost ? [orgData.data.epost] : [];

  return (
    <>
      <div className="topp">
        <h1>{id ? "Endre utkast" : "Ny faktura"}</h1>
        {!id && (
          <Link className="knapp" to="/fakturaer/flere">
            Flere på én gang
          </Link>
        )}
      </div>
      {!orgData.data.kontonr && (
        <div className="melding info">
          Legg inn kontonummer under <Link to="/innstillinger">Innstillinger</Link> før du sender fakturaer.
        </div>
      )}
      <div className="kort">
        <div className="rad">
          <label className="hel">
            Kunde
            <div className="med-knapp">
              <Sokefelt
                etikett="Kunde"
                valg={kundeValg(kunder.data)}
                verdi={f.kunde_id || null}
                velg={(id) => settF({ ...f, kunde_id: id ?? "" })}
                plassholder="Søk kunde"
                ny={{ tekst: "+ Ny kunde", handling: (navn) => settNyKunde({ navn }) }}
              />
              <button type="button" onClick={() => settNyKunde({ navn: "" })}>
                <IkonPluss storrelse={16} /> Ny kunde
              </button>
            </div>
          </label>
          <label>
            Fakturadato
            <input type="date" value={f.fakturadato} onChange={(e) => settF({ ...f, fakturadato: e.target.value })} />
          </label>
          <label>
            Forfallsdato
            <input type="date" value={f.forfallsdato} onChange={(e) => settF({ ...f, forfallsdato: e.target.value })} />
          </label>
        </div>
        {kunde && !kunde.epost && <div className="melding info">Kunden har ingen e-postadresse. Fakturaen blir utstedt, men ikke sendt på e-post.</div>}
        <div className="rad">
          <label>
            Periode fra
            <input type="date" value={f.periode_fra} onChange={(e) => settF({ ...f, periode_fra: e.target.value })} />
          </label>
          <label>
            Periode til
            <input type="date" value={f.periode_til} onChange={(e) => settF({ ...f, periode_til: e.target.value })} />
          </label>
          <label>
            Deres ref.
            <input value={f.deres_referanse} placeholder={kunde?.deres_referanse ?? ""} onChange={(e) => settF({ ...f, deres_referanse: e.target.value })} />
          </label>
          <label>
            Vår ref.
            <input value={f.var_referanse} onChange={(e) => settF({ ...f, var_referanse: e.target.value })} />
          </label>
        </div>
        <EpostlisteFelt
          etikett="Kopi til (valgfritt)"
          verdi={kopi}
          endre={(v) => {
            settKopi(v);
            if (feil?.startsWith("Ugyldig e-postadresse")) settFeil(null);
          }}
          plassholder="f.eks. regnskap@kunde.no"
          hjelp={
            <>
              Får fakturaen på e-post sammen med kunden, og ser hverandre som mottakere. Skill flere adresser med komma.
              {fastKopi.length > 0 && <> En skjult kopi går også til {fastKopi.join(", ")}.</>}
            </>
          }
        />
        <AvsenderKonto org={orgData.data} verdi={f} endre={(v) => settF({ ...f, ...v })} />
        {ulikeFasteValg && <div className="melding info">{ulikeFasteValg}</div>}
      </div>

      <div className="kort tabell linjer">
        <LinjeTabell
          linjer={linjer}
          endre={settLinjer}
          produkter={produkter.data ?? []}
          utenMva={utenMva}
          visRabatt={visRabatt}
          nyttProdukt={(linje, navn) => settNyttProdukt({ linje, navn })}
        />
        <div className="knapper" style={{ marginTop: 12 }}>
          <button type="button" onClick={() => settLinjer([...linjer, tomLinje()])}>
            + Linje
          </button>
          <button type="button" onClick={() => settNyttProdukt({ linje: "ny" })}>
            + Nytt produkt
          </button>
          <RabattKnapp vis={visRabatt} veksle={vekslRabatt} />
          {orgData.data.standard_gebyr > 0 && (
            <label style={{ margin: 0 }}>
              <input type="checkbox" checked={gebyr} onChange={(e) => settGebyr(e.target.checked)} />
              Fakturagebyr ({kr(orgData.data.standard_gebyr)} eks. mva)
            </label>
          )}
        </div>
        <div className="summer">
          {rabatt !== 0 && (
            <div className="rabatt">
              <span>Rabatt</span>
              <span className="tall">−{kr(rabatt)}</span>
            </div>
          )}
          {!utenMva && (
            <>
              <div>
                <span>Sum eks. mva</span>
                <span className="tall">{kr(sum.eks)}</span>
              </div>
              <div>
                <span>Mva</span>
                <span className="tall">{kr(sum.mva)}</span>
              </div>
            </>
          )}
          <div className="total">
            <span>Å betale{utenMva ? " (uten mva)" : ""}</span>
            <span className="tall">{kr(sum.inkl)}</span>
          </div>
        </div>
      </div>

      <NotatFelt verdi={f.kommentar} endre={(v) => settF({ ...f, kommentar: v })} />
      <label>
        Internt notat (vises ikke på fakturaen)
        <textarea rows={2} value={f.notat} onChange={(e) => settF({ ...f, notat: e.target.value })} />
      </label>
      <Feil melding={feil} />
      <div className="knapper">
        <button onClick={() => lagre(false)} disabled={opptatt || !f.kunde_id}>
          Lagre utkast
        </button>
        <button className="primar" onClick={() => lagre(true)} disabled={opptatt || !f.kunde_id || tallLinjer.length === 0 || !orgData.data.kontonr}>
          Send faktura
        </button>
        <button className="lenke" onClick={() => nav(-1)}>
          Avbryt
        </button>
      </div>

      <Dialog apen={nyKunde !== null} lukk={() => settNyKunde(null)} tittel="Ny kunde">
        <KundeSkjema
          kunde={{ type: "firma", aktiv: true, navn: nyKunde?.navn ?? "" }}
          lagret={async (k) => {
            settNyKunde(null);
            await kunder.last();
            settF((x: any) => ({ ...x, kunde_id: k.id }));
          }}
          avbryt={() => settNyKunde(null)}
        />
      </Dialog>
      <Dialog apen={nyttProdukt !== null} lukk={() => settNyttProdukt(null)} tittel="Nytt produkt">
        <ProduktSkjema
          produkt={{ enhet: "stk", mva_sats: utenMva ? 0 : 25, aktiv: true, navn: nyttProdukt?.navn ?? "" }}
          lagret={(p) => {
            if (p && nyttProdukt !== null) brukNyttProdukt(p, nyttProdukt.linje);
            settNyttProdukt(null);
          }}
          avbryt={() => settNyttProdukt(null)}
        />
      </Dialog>
    </>
  );
}

// ---------------------------------------------------------------------------
// Visning og handlinger
// ---------------------------------------------------------------------------

export function FakturaVisning() {
  const { id } = useParams();
  const { org } = useKonto();
  const nav = useNavigate();
  const { data: f, feil, last } = useData(() => hent(`/org/${org!.id}/fakturaer/${id}`), [org?.id, id]);
  const h = useHandling();
  const [dialog, settDialog] = useState<"betaling" | "refusjon" | "krediter" | "slett" | "send" | null>(null);

  if (feil) return <Feil melding={feil} />;
  if (!f) return <Laster />;

  const sisteEpost = f.eposter?.at(-1);
  const m = fakturaMerke({ ...f, forfalt: f.status === "utstedt" && f.forfallsdato < iDag(), antall_purringer: f.purringer?.length ?? 0, epost_status: sisteEpost?.status });
  const forfalt = f.type === "faktura" && f.status === "utstedt" && f.forfallsdato < iDag();
  const sistePurring = f.purringer?.at(-1);
  const kanPurre = forfalt && (!sistePurring || sistePurring.ny_frist < iDag());
  const nestePurring = f.purringer?.some((p: any) => p.type === "paaminnelse") ? "inkassovarsel" : "paaminnelse";
  const aaBetale = f.sum_inkl_mva - f.kreditert_belop - f.betalt_belop;
  const linjerMedRabatt = f.linjer.some((l: any) => l.rabatt_prosent != null || l.rabatt_belop != null);
  const rolle = org?.rolle;

  const handling = async (fn: () => Promise<unknown>, gaaTil?: string) => {
    const r = await h.kjor(fn);
    if (r !== undefined || gaaTil) {
      if (gaaTil) nav(gaaTil);
      else last();
    }
  };

  return (
    <>
      <div className="topp">
        <h1>
          {f.type === "kreditnota" ? "Kreditnota" : "Faktura"} {f.fakturanummer ?? "(utkast)"} <span className={`merke ${m.klasse}`}>{m.tekst}</span>
        </h1>
        <div className="knapper handlinger">
          <button onClick={() => h.kjor(() => apnePdf(org!.id, f.id))}>{f.status === "utkast" ? "Forhåndsvis PDF" : "PDF"}</button>
          {f.status !== "utkast" && f.selger?.orgnr && f.kunde?.orgnr && (
            <button title="Last ned fakturaen som EHF (elektronisk faktura)" onClick={() => h.kjor(() => lastNed(`/org/${org!.id}/fakturaer/${f.id}/ehf`, `${f.type === "kreditnota" ? "Kreditnota" : "Faktura"}-${f.fakturanummer}.xml`))}>
              EHF
            </button>
          )}
          {f.status === "utkast" && kanSkrive(rolle) && (
            <>
              <button onClick={() => nav(`/fakturaer/${f.id}/endre`)}>Endre</button>
              <button className="primar" onClick={() => handling(() => api("POST", `/org/${org!.id}/fakturaer/${f.id}/utsted`, { send_epost: true }))}>
                Send
              </button>
              <button className="fare" onClick={() => confirm("Slette utkastet?") && handling(() => api("DELETE", `/org/${org!.id}/fakturaer/${f.id}`), "/fakturaer")}>
                Slett
              </button>
            </>
          )}
          {f.status !== "utkast" && kanSkrive(rolle) && <button onClick={() => settDialog("send")}>Send på nytt</button>}
          {kanPurre && kanSkrive(rolle) && (
            <button
              onClick={() =>
                confirm(
                  nestePurring === "inkassovarsel"
                    ? "Sende inkassovarsel? Kunden får 14 dager før kravet kan sendes til inkasso."
                    : "Sende betalingspåminnelse med 14 dagers ny frist?",
                ) && handling(() => api("POST", `/org/${org!.id}/fakturaer/${f.id}/purring`, { type: nestePurring }))
              }
            >
              {nestePurring === "inkassovarsel" ? "Send inkassovarsel" : "Send påminnelse"}
            </button>
          )}
          {f.type === "faktura" && ["utstedt", "betalt"].includes(f.status) && kanBokfore(rolle) && (
            <button onClick={() => settDialog("betaling")}>Registrer betaling</button>
          )}
          {f.type === "faktura" && f.betalt_belop - f.refusjon_belop > 0 && kanBokfore(rolle) && <button onClick={() => settDialog("refusjon")}>Refusjon</button>}
          {f.type === "faktura" && ["utstedt", "betalt"].includes(f.status) && kanSkrive(rolle) && (
            <button className="fare" onClick={() => settDialog("krediter")}>
              Krediter
            </button>
          )}
          {f.status !== "utkast" && f.type === "faktura" && erAdmin(rolle) && (
            <button className="fare" onClick={() => settDialog("slett")}>
              Slett
            </button>
          )}
        </div>
      </div>
      <Feil melding={h.feil} />
      {sisteEpost && ["sprett", "klage"].includes(sisteEpost.status) && (
        <div className="melding feil">
          E-posten til {sisteEpost.til}
          {sisteEpost.kopi?.length > 0 && ` (med kopi til ${sisteEpost.kopi.join(", ")})`}{" "}
          {sisteEpost.status === "sprett" ? "kom i retur" : "ble merket som søppelpost"}
          {sisteEpost.detaljer ? ` (${sisteEpost.detaljer})` : ""}. Rett e-postadressen under Kunder og send på nytt, eller kontakt kunden.
        </div>
      )}

      <div className="kort">
        <div className="rad info">
          <div>
            <div className="dempet liten">Kunde</div>
            {f.kunde?.navn ?? ""}
          </div>
          <div>
            <div className="dempet liten">Fakturadato</div>
            {dato(f.fakturadato) || "ved sending"}
          </div>
          {f.type === "faktura" && (
            <div>
              <div className="dempet liten">Forfall</div>
              {dato(f.forfallsdato) || "ved sending"}
            </div>
          )}
          {f.kid && (
            <div>
              <div className="dempet liten">KID</div>
              {f.kid}
            </div>
          )}
          {f.sendt_til && (
            <div>
              <div className="dempet liten">Sendt til</div>
              {f.sendt_til}{" "}
              {sisteEpost && <span className={`merke ${epostStatus[sisteEpost.status]?.klasse}`}>{epostStatus[sisteEpost.status]?.tekst}</span>}
            </div>
          )}
          {f.kopi_til?.length > 0 && (
            <div>
              <div className="dempet liten">Kopi til</div>
              {f.kopi_til.join(", ")}
            </div>
          )}
        </div>
        {f.kommentar && (
          <div className="faktura-kommentar">
            <div className="dempet liten">Notat på fakturaen</div>
            {f.kommentar}
          </div>
        )}
      </div>

      <div className="kort tabell">
        <table className="stabel">
          <thead>
            <tr>
              <th>Beskrivelse</th>
              <th className="hoyre">Antall</th>
              <th className="hoyre">Pris</th>
              {linjerMedRabatt && <th className="hoyre">Rabatt</th>}
              <th className="hoyre">Mva</th>
              <th className="hoyre">Beløp eks. mva</th>
            </tr>
          </thead>
          <tbody>
            {f.linjer.map((l: any) => (
              <tr key={l.id}>
                <td className="hel tittel">{l.beskrivelse}</td>
                <td className="tall" data-label="Antall">
                  {String(l.antall).replace(".", ",")} {l.enhet !== "stk" ? l.enhet : ""}
                </td>
                <td className="tall" data-label="Pris">{kr(l.enhetspris)}</td>
                {linjerMedRabatt && (
                  <td className="tall" data-label="Rabatt">
                    {l.rabatt_prosent != null ? `${String(l.rabatt_prosent).replace(".", ",")} %` : l.rabatt_belop != null ? kr(l.rabatt_belop) : ""}
                  </td>
                )}
                <td className="tall" data-label="Mva">{l.mva_sats} %</td>
                <td className="tall" data-label="Beløp eks. mva">{kr(l.belop_eks ?? linjebelop(l))}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {f.sum_inkl_mva != null && (
          <div className="summer">
            <div>
              <span>Sum eks. mva</span>
              <span className="tall">{kr(f.sum_eks_mva)}</span>
            </div>
            <div>
              <span>Mva</span>
              <span className="tall">{kr(f.mva)}</span>
            </div>
            <div className="total">
              <span>Totalt</span>
              <span className="tall">{kr(f.sum_inkl_mva)}</span>
            </div>
            {f.type === "faktura" && f.kreditert_belop > 0 && (
              <div>
                <span>Kreditert</span>
                <span className="tall">−{kr(f.kreditert_belop)}</span>
              </div>
            )}
            {f.type === "faktura" && f.betalt_belop !== 0 && (
              <div>
                <span>Betalt</span>
                <span className="tall">−{kr(f.betalt_belop)}</span>
              </div>
            )}
            {f.type === "faktura" && f.status !== "kreditert" && (
              <div className="total">
                <span>Gjenstår</span>
                <span className="tall">{kr(Math.max(0, aaBetale))}</span>
              </div>
            )}
          </div>
        )}
      </div>

      {forfalt && sistePurring && sistePurring.ny_frist >= iDag() && (
        <div className="melding info">
          {sistePurring.type === "inkassovarsel" ? "Inkassovarsel" : "Påminnelse"} sendt {dato(sistePurring.sendt_at ?? sistePurring.opprettet)}. Ny frist{" "}
          {dato(sistePurring.ny_frist)}.
        </div>
      )}
      {(f.betalinger?.length > 0 || f.kreditnotaer?.length > 0 || f.purringer?.length > 0) && (
        <div className="kort">
          <h2 style={{ marginTop: 0 }}>Historikk</h2>
          <table>
            <tbody>
              {f.betalinger.map((b: any) => (
                <tr key={b.id}>
                  <td>{dato(b.betalt_dato)}</td>
                  <td>{b.type === "refusjon" ? "Refusjon" : "Betaling"}{b.notat ? ` – ${b.notat}` : ""}</td>
                  <td className="tall">{kr(b.belop)}</td>
                </tr>
              ))}
              {f.purringer.map((p: any) => (
                <tr key={p.id}>
                  <td>{dato(p.sendt_at ?? p.opprettet)}</td>
                  <td>
                    {p.type === "inkassovarsel" ? "Inkassovarsel" : "Betalingspåminnelse"}
                    {p.automatisk ? " (automatisk)" : ""} – frist {dato(p.ny_frist)}
                    {!p.sendt_at && <span className="dempet"> · sendes …</span>}
                  </td>
                  <td className="tall">{p.gebyr > 0 ? `gebyr ${kr(p.gebyr)}` : ""}</td>
                </tr>
              ))}
              {f.kreditnotaer.map((k: any) => (
                <tr key={k.id} className="klikkbar" onClick={() => nav(`/fakturaer/${k.id}`)}>
                  <td>{dato(k.fakturadato)}</td>
                  <td>Kreditnota {k.fakturanummer}</td>
                  <td className="tall">{kr(k.sum_inkl_mva)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {f.kreditnota_for && (
        <p>
          <Link to={`/fakturaer/${f.kreditnota_for}`}>Gå til fakturaen som er kreditert</Link>
        </p>
      )}

      <Dialog apen={dialog === "betaling"} lukk={() => settDialog(null)} tittel="Registrer betaling">
        <BelopSkjema
          forslag={Math.max(0, aaBetale)}
          knapp="Registrer"
          send={async (belop, d, notat) => {
            await api("POST", `/org/${org!.id}/fakturaer/${f.id}/betalinger`, { belop, dato: d, notat });
            settDialog(null);
            last();
          }}
        />
      </Dialog>
      <Dialog apen={dialog === "refusjon"} lukk={() => settDialog(null)} tittel="Registrer refusjon">
        <p className="dempet">Kan refundere opptil {kr(f.betalt_belop - f.refusjon_belop)} kr.</p>
        <BelopSkjema
          forslag={f.betalt_belop - f.refusjon_belop}
          knapp="Registrer refusjon"
          send={async (belop, d, notat) => {
            await api("POST", `/org/${org!.id}/fakturaer/${f.id}/refusjoner`, { belop, dato: d, notat });
            settDialog(null);
            last();
          }}
        />
      </Dialog>
      <Dialog apen={dialog === "send"} lukk={() => settDialog(null)} tittel={`Send ${f.type === "kreditnota" ? "kreditnotaen" : "fakturaen"} på nytt`}>
        <SendPaNytt
          faktura={f}
          ferdig={() => {
            settDialog(null);
            last();
          }}
        />
      </Dialog>
      <Dialog apen={dialog === "slett"} lukk={() => settDialog(null)} tittel="Slett faktura">
        <SlettFaktura faktura={f} ferdig={() => nav("/fakturaer")} />
      </Dialog>
      <Dialog apen={dialog === "krediter"} lukk={() => settDialog(null)} tittel="Krediter faktura">
        <Kreditering
          faktura={f}
          ferdig={(kn) => {
            settDialog(null);
            nav(`/fakturaer/${kn.id}`);
          }}
        />
      </Dialog>
    </>
  );
}

// Send på nytt, til kundens e-post slik den er nå, med mulighet til å endre kopimottakerne.
function SendPaNytt({ faktura, ferdig }: { faktura: any; ferdig: () => void }) {
  const { org } = useKonto();
  const kunde = useData(() => hent(`/org/${org!.id}/kunder/${faktura.kunde_id}`), [org?.id, faktura.kunde_id]);
  const orgData = useData(() => hent(`/org/${org!.id}`), [org?.id]);
  const [kopi, settKopi] = useState((faktura.kopi_til ?? []).join(", "));
  const [sendt, settSendt] = useState(false);
  const h = useHandling();

  if (!kunde.data || !orgData.data) return <Laster />;
  const til = kunde.data.epost as string | null;
  const fast: string[] = orgData.data.kopi_til?.length ? orgData.data.kopi_til : orgData.data.epost ? [orgData.data.epost] : [];

  async function send(ev: FormEvent) {
    ev.preventDefault();
    const feil = ugyldigeEposter(kopi);
    if (feil.length) return h.settFeil(`Ugyldig e-postadresse: ${feil.join(", ")}`);
    const r = await h.kjor(() => api("POST", `/org/${org!.id}/fakturaer/${faktura.id}/send`, { kopi_til: tilEpostliste(kopi) }));
    if (r !== undefined) {
      settSendt(true);
      setTimeout(ferdig, 1200);
    }
  }

  if (!til)
    return (
      <p>
        {faktura.kunde?.navn ?? "Kunden"} har ingen e-postadresse. Legg den inn under <Link to="/kunder">Kunder</Link> først.
      </p>
    );
  return (
    <form onSubmit={send}>
      <p>
        Sendes til <strong>{til}</strong>
        {faktura.sendt_til && faktura.sendt_til !== til && <span className="dempet"> (sist sendt til {faktura.sendt_til})</span>}.
      </p>
      <EpostlisteFelt
        etikett="Kopi til (valgfritt)"
        verdi={kopi}
        endre={settKopi}
        plassholder="f.eks. regnskap@kunde.no"
        hjelp={<>Kopimottakerne får også eventuelle purringer. Skill flere adresser med komma.{fast.length > 0 && <> En skjult kopi går til {fast.join(", ")}.</>}</>}
      />
      <Feil melding={h.feil} />
      {sendt && <div className="melding ok">Sendt. E-posten går ut i løpet av noen sekunder.</div>}
      <div className="knapper">
        <button className="primar" disabled={h.opptatt || sendt}>
          Send
        </button>
        <button type="button" onClick={ferdig}>
          Avbryt
        </button>
      </div>
    </form>
  );
}

function SlettFaktura({ faktura, ferdig }: { faktura: any; ferdig: () => void }) {
  const { org } = useKonto();
  const [grunn, settGrunn] = useState("Testfaktura");
  const [bekreft, settBekreft] = useState("");
  const h = useHandling();
  const kreditnotaer = faktura.kreditnotaer?.length ?? 0;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        h.kjor(() => api("POST", `/org/${org!.id}/fakturaer/${faktura.id}/slett`, { grunn })).then((r) => r !== undefined && ferdig());
      }}
    >
      <p>
        Sletting er ment for <strong>testfakturaer</strong> og fakturaer som aldri skulle vært sendt. En ekte faktura som er feil, skal
        krediteres, ikke slettes (bokføringsloven).
      </p>
      <p className="dempet liten">
        Faktura {faktura.fakturanummer}
        {kreditnotaer > 0 && ` og ${kreditnotaer} kreditnota${kreditnotaer > 1 ? "er" : ""}`} slettes sammen med betalinger og purringer, og
        kopier i Google Disk legges i papirkurven. Hvis dette er de siste fakturaene, fortsetter nummerserien fra der den var før. Slettingen
        logges med grunnen.
      </p>
      <label>
        Grunn
        <input value={grunn} onChange={(e) => settGrunn(e.target.value)} maxLength={500} required minLength={3} />
      </label>
      <label>
        Skriv fakturanummeret ({faktura.fakturanummer}) for å bekrefte
        <input inputMode="numeric" value={bekreft} onChange={(e) => settBekreft(e.target.value)} />
      </label>
      <Feil melding={h.feil} />
      <button className="fare" disabled={h.opptatt || bekreft.trim() !== String(faktura.fakturanummer) || grunn.trim().length < 3}>
        Slett for godt
      </button>
    </form>
  );
}

function BelopSkjema({ forslag, knapp, send }: { forslag: number; knapp: string; send: (belop: number, dato: string, notat: string | null) => Promise<void> }) {
  const [belop, settBelop] = useState(forslag.toFixed(2).replace(".", ","));
  const [d, settD] = useState(iDag());
  const [notat, settNotat] = useState("");
  const h = useHandling();
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        h.kjor(() => send(tall(belop), d, notat || null));
      }}
    >
      <div className="rad">
        <label>
          Beløp inkl. mva
          <input inputMode="decimal" value={belop} onChange={(e) => settBelop(e.target.value)} />
        </label>
        <label>
          Dato
          <input type="date" max={iDag()} value={d} onChange={(e) => settD(e.target.value)} />
        </label>
      </div>
      <label>
        Notat
        <input value={notat} onChange={(e) => settNotat(e.target.value)} />
      </label>
      <Feil melding={h.feil} />
      <button className="primar" disabled={h.opptatt}>
        {knapp}
      </button>
    </form>
  );
}

function Kreditering({ faktura, ferdig }: { faktura: any; ferdig: (kn: any) => void }) {
  const { org } = useKonto();
  const [hel, settHel] = useState(true);
  const [antall, settAntall] = useState<Record<string, string>>({});
  const h = useHandling();

  async function krediter() {
    const linjer = hel
      ? null
      : Object.entries(antall)
          .filter(([, v]) => v && tall(v) !== 0)
          .map(([linje_id, v]) => ({ linje_id, antall: tall(v) }));
    const kn = await h.kjor(() => api("POST", `/org/${org!.id}/fakturaer/${faktura.id}/krediter`, { linjer, send_epost: true }));
    if (kn) ferdig(kn);
  }

  return (
    <>
      <p>En kreditnota får eget nummer og sendes til kunden. Den kan ikke angres.</p>
      <label>
        <input type="radio" checked={hel} onChange={() => settHel(true)} /> Krediter hele fakturaen
      </label>
      <label>
        <input type="radio" checked={!hel} onChange={() => settHel(false)} /> Krediter deler av den
      </label>
      {!hel && (
        <table>
          <tbody>
            {faktura.linjer
              .filter((l: any) => l.antall > 0)
              .map((l: any) => (
                <tr key={l.id}>
                  <td>{l.beskrivelse}</td>
                  <td className="dempet liten">av {String(l.antall).replace(".", ",")}</td>
                  <td style={{ width: 100 }}>
                    <input inputMode="decimal" value={antall[l.id] ?? ""} onChange={(e) => settAntall({ ...antall, [l.id]: e.target.value })} />
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      )}
      <Feil melding={h.feil} />
      <div className="knapper" style={{ marginTop: 12 }}>
        <button className="fare" onClick={krediter} disabled={h.opptatt}>
          Lag og send kreditnota
        </button>
      </div>
    </>
  );
}

