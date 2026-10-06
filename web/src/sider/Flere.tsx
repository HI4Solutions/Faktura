// Mange fakturaer på én gang: til forskjellige kunder, hver med sine egne produkter.
// Dato, forfall, konto og gebyr er felles. Alt lagres eller sendes samlet: stopper én
// faktura, lagres ingen, og feilmeldingen sier hvilken.
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api, hent } from "../api";
import { Dialog, EpostlisteFelt, Feil, Laster, tall, tilEpostliste, ugyldigeEposter, useData, useHandling } from "../felles";
import { kanSkrive, useKonto } from "../konto";
import { iDag, kr, leggTilDager, summer } from "../format";
import { IkonPluss } from "../ikoner";
import { gebyrLinjer, harRabatt, LinjeTabell, linjefeil, medProdukt, NotatFelt, RabattKnapp, tilTallLinjer, tomLinje, erTom, type LinjeUtkast } from "../linjer";
import { KundeSkjema, ProduktSkjema } from "./Register";
import { kundeValg, produktValg, Sokefelt } from "../sokefelt";
import { AvsenderKonto, fasteValg } from "./AvsenderKonto";

interface Kort {
  nokkel: number;
  kunde_id: string;
  linjer: LinjeUtkast[];
  deres_referanse: string;
  kopi: string;
  rabatt: boolean; // rabattkolonnen er slått på
}

let teller = 0;
const nyttKort = (kunde_id = ""): Kort => ({ nokkel: ++teller, kunde_id, linjer: [tomLinje()], deres_referanse: "", kopi: "", rabatt: false });
const erTomtKort = (k: Kort) => !k.kunde_id && k.linjer.every(erTom);

type Valg =
  | { type: "kunder" }
  | { type: "ny-kunde"; kort: number; navn?: string }
  | { type: "produkt-alle" }
  | { type: "nytt-produkt"; kort: number | "alle"; linje: number | "ny"; antall?: string; navn?: string }
  | null;

const flertall = (n: number, en: string, flere: string) => `${n} ${n === 1 ? en : flere}`;

export function FlereFakturaer() {
  const { org } = useKonto();
  const orgData = useData(() => hent(`/org/${org!.id}`), [org?.id]);
  const kunder = useData(() => hent<any[]>(`/org/${org!.id}/kunder?aktiv=true`), [org?.id]);
  const produkter = useData(() => hent<any[]>(`/org/${org!.id}/produkter?aktiv=true`), [org?.id]);
  const [felles, settFelles] = useState<any>({ fakturadato: iDag(), forfallsdato: "", periode_fra: "", periode_til: "", var_referanse: "", kommentar: "", konto_id: null, avsender: null });
  const [gebyr, settGebyr] = useState(false);
  const [kort, settKort] = useState<Kort[]>(() => [nyttKort()]);
  const [valg, settValg] = useState<Valg>(null);
  const [resultat, settResultat] = useState<{ fakturaer: any[]; ikke_sendt: string[]; sendt: boolean } | null>(null);
  const h = useHandling();

  // Standard forfall og fakturagebyr fra innstillingene.
  useEffect(() => {
    if (orgData.data && !felles.forfallsdato) {
      settFelles((x: any) => ({ ...x, forfallsdato: leggTilDager(x.fakturadato, orgData.data.standard_forfall_dager) }));
      settGebyr(orgData.data.standard_gebyr > 0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgData.data]);

  const utenMva = Boolean(orgData.data && !orgData.data.mva_registrert);
  const kundeMap = useMemo(() => new Map((kunder.data ?? []).map((k) => [k.id, k])), [kunder.data]);
  const kundevalg = useMemo(() => kundeValg(kunder.data ?? []), [kunder.data]);

  const endreKort = (nokkel: number, e: Partial<Kort>) => settKort((ks) => ks.map((k) => (k.nokkel === nokkel ? { ...k, ...e } : k)));
  const fjernKort = (nokkel: number) => settKort((ks) => ks.filter((k) => k.nokkel !== nokkel));
  // Nye kunder erstatter tomme kort (det første kortet er tomt når siden åpnes).
  const leggTilKunder = (ider: string[]) => settKort((ks) => [...ks.filter((k) => !erTomtKort(k)), ...ider.map((id) => nyttKort(id))]);
  const produktPaAlle = (p: any, antall: string) => settKort((ks) => ks.map((k) => ({ ...k, linjer: medProdukt(k.linjer, p, "ny", antall) })));

  const beregnet = kort.map((k, i) => {
    const linjer = tilTallLinjer(k.linjer, utenMva);
    const sum = summer([...linjer, ...gebyrLinjer(gebyr, orgData.data)]);
    const kunde = kundeMap.get(k.kunde_id);
    const feilLinje = linjefeil(k.linjer);
    const mangler = !k.kunde_id
      ? "velg kunde"
      : feilLinje
        ? feilLinje.replace(/\.$/, "").replace(/^./, (c) => c.toLowerCase())
        : linjer.length === 0
          ? "legg inn minst én linje med beskrivelse og pris"
          : ugyldigeEposter(k.kopi).length
            ? "ugyldig e-postadresse for kopi"
            : null;
    // Produkter med fast avsender eller konto bestemmer dem for fakturaen.
    const fast = fasteValg(k.linjer, produkter.data);
    return { k, nr: i + 1, linjer, sum, kunde, mangler, fast };
  });
  const total = beregnet.reduce((s, b) => s + b.sum.inkl, 0);
  const utenEpost = beregnet.filter((b) => b.kunde && !b.kunde.epost);

  async function lagre(send: boolean) {
    const mangler = beregnet.filter((b) => b.mangler);
    if (mangler.length) return h.settFeil(mangler.map((b) => `Faktura ${b.nr}: ${b.mangler}`).join(". ") + ".");
    if (send) {
      const tekst =
        `Sende ${flertall(kort.length, "faktura", "fakturaer")} på til sammen ${kr(total)} kr?` +
        (utenEpost.length ? ` ${flertall(utenEpost.length, "kunde", "kunder")} mangler e-post og får ikke fakturaen på e-post.` : "") +
        " Fakturaene får fakturanummer og kan ikke endres etterpå.";
      if (!confirm(tekst)) return;
    }
    const kropp = {
      fakturadato: felles.fakturadato || null,
      forfallsdato: felles.forfallsdato || null,
      periode_fra: felles.periode_fra || null,
      periode_til: felles.periode_til || null,
      var_referanse: felles.var_referanse || null,
      kommentar: felles.kommentar.trim() || null,
      konto_id: felles.konto_id ?? null,
      avsender: felles.avsender ?? null,
      gebyr,
      utsted: send,
      fakturaer: beregnet.map((b) => ({
        kunde_id: b.k.kunde_id,
        deres_referanse: b.k.deres_referanse || null,
        kopi_til: tilEpostliste(b.k.kopi),
        ...(b.fast.avsender ? { avsender: b.fast.avsender } : {}),
        ...(b.fast.konto_id ? { konto_id: b.fast.konto_id } : {}),
        linjer: b.linjer,
      })),
    };
    const r = await h.kjor(() => api("POST", `/org/${org!.id}/fakturaer/flere`, kropp));
    if (r) {
      settResultat({ ...r, sendt: send });
      window.scrollTo(0, 0);
    }
  }

  if (!kanSkrive(org?.rolle)) return <p className="dempet">Du har ikke tilgang til å lage fakturaer.</p>;
  if (!orgData.data || !kunder.data || !produkter.data) return <Laster />;

  if (resultat) {
    const n = resultat.fakturaer.length;
    return (
      <>
        <div className="topp">
          <h1>{resultat.sendt ? "Fakturaene er sendt" : "Utkastene er lagret"}</h1>
        </div>
        <div className="melding ok">
          {resultat.sendt
            ? `${flertall(n, "faktura er utstedt", "fakturaer er utstedt")} og sendes på e-post nå.`
            : `${flertall(n, "utkast er lagret", "utkast er lagret")}. Du finner dem under Utkast, og kan sende dem samlet derfra.`}
        </div>
        {resultat.ikke_sendt.length > 0 && (
          <div className="melding feil">
            {flertall(resultat.ikke_sendt.length, "faktura", "fakturaer")} kom ikke i kø for sending. Åpne dem og trykk «Send på nytt».
          </div>
        )}
        <div className="kort liste">
          {resultat.fakturaer.map((f) => (
            <Link key={f.id} className="liste-rad" to={`/fakturaer/${f.id}`}>
              <span className="linje">
                <span className="tittel">{f.kunde_navn}</span>
                <span className="belop">{kr(f.sum_inkl_mva)}</span>
              </span>
              <span className="linje">
                <span className="under">{f.fakturanummer ? `Nr. ${f.fakturanummer}` : "Utkast"}</span>
                {resultat.sendt && !f.kunde_epost && <span className="merke merke-advarsel">Uten e-post</span>}
                {resultat.ikke_sendt.includes(f.id) && <span className="merke merke-fare">Ikke sendt</span>}
              </span>
            </Link>
          ))}
        </div>
        <div className="knapper">
          <Link className="knapp primar" to={resultat.sendt ? "/fakturaer?status=utstedt" : "/fakturaer?status=utkast"}>
            Til fakturaene
          </Link>
          <button
            type="button"
            onClick={() => {
              settResultat(null);
              settKort([nyttKort()]);
            }}
          >
            Lag flere
          </button>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="topp">
        <h1>Flere fakturaer</h1>
        <Link className="knapp" to="/fakturaer/ny">
          Én faktura
        </Link>
      </div>
      <p className="undertittel">Lag og send mange fakturaer på én gang, til forskjellige kunder med forskjellige produkter.</p>
      {!orgData.data.kontonr && (
        <div className="melding info">
          Legg inn kontonummer under <Link to="/innstillinger">Innstillinger</Link> før du sender fakturaer.
        </div>
      )}

      <div className="kort">
        <h2 style={{ marginTop: 0 }}>Felles for alle</h2>
        <div className="rad">
          <label>
            Fakturadato
            <input type="date" value={felles.fakturadato} onChange={(e) => settFelles({ ...felles, fakturadato: e.target.value })} />
          </label>
          <label>
            Forfallsdato
            <input type="date" value={felles.forfallsdato} onChange={(e) => settFelles({ ...felles, forfallsdato: e.target.value })} />
          </label>
          <label>
            Periode fra
            <input type="date" value={felles.periode_fra} onChange={(e) => settFelles({ ...felles, periode_fra: e.target.value })} />
          </label>
          <label>
            Periode til
            <input type="date" value={felles.periode_til} onChange={(e) => settFelles({ ...felles, periode_til: e.target.value })} />
          </label>
          <label>
            Vår ref.
            <input value={felles.var_referanse} onChange={(e) => settFelles({ ...felles, var_referanse: e.target.value })} />
          </label>
        </div>
        <AvsenderKonto org={orgData.data} verdi={felles} endre={(v) => settFelles({ ...felles, ...v })} />
        <NotatFelt etikett="Notat på fakturaene" verdi={felles.kommentar} endre={(v) => settFelles({ ...felles, kommentar: v })} />
        {orgData.data.standard_gebyr > 0 && (
          <label>
            <input type="checkbox" checked={gebyr} onChange={(e) => settGebyr(e.target.checked)} /> Fakturagebyr på hver faktura ({kr(orgData.data.standard_gebyr)} eks. mva)
          </label>
        )}
      </div>

      <div className="knapper flere-verktoy">
        <button type="button" className="primar" onClick={() => settValg({ type: "kunder" })}>
          <IkonPluss storrelse={16} /> Legg til kunder
        </button>
        <button type="button" disabled={!kort.length} onClick={() => settValg({ type: "produkt-alle" })}>
          Produkt på alle
        </button>
        <button type="button" onClick={() => settKort((ks) => [...ks, nyttKort()])}>
          + Én faktura til
        </button>
      </div>

      {beregnet.map(({ k, nr, sum, kunde, fast }) => (
        <div className="kort flere-kort" key={k.nokkel}>
          <div className="flere-topp">
            <span className="flere-nr" aria-hidden="true">
              {nr}
            </span>
            <Sokefelt
              etikett={`Kunde for faktura ${nr}`}
              valg={kundevalg}
              verdi={k.kunde_id || null}
              velg={(id) => endreKort(k.nokkel, { kunde_id: id ?? "" })}
              plassholder="Søk kunde"
              ny={{ tekst: "+ Ny kunde", handling: (navn) => settValg({ type: "ny-kunde", kort: k.nokkel, navn }) }}
            />
            <button type="button" className="lenke" aria-label={`Fjern faktura ${nr}`} title="Fjern" onClick={() => fjernKort(k.nokkel)}>
              ✕
            </button>
          </div>
          {kunde && !kunde.epost && <p className="flere-advarsel">Kunden har ingen e-postadresse. Fakturaen blir utstedt, men ikke sendt på e-post.</p>}
          <div className="tabell linjer">
            <LinjeTabell
              linjer={k.linjer}
              endre={(l) => endreKort(k.nokkel, { linjer: l })}
              produkter={produkter.data!}
              utenMva={utenMva}
              visRabatt={k.rabatt || harRabatt(k.linjer)}
              nyttProdukt={(i, navn) => settValg({ type: "nytt-produkt", kort: k.nokkel, linje: i, navn })}
            />
          </div>
          {(fast.avsender || fast.konto_id) && (
            <p className="flere-info">
              {fast.ulike ? "Produktene har ulik fast avsender eller konto; det første produktets valg brukes." : "Fast avsender eller konto fra produktet brukes på denne fakturaen."}
            </p>
          )}
          <div className="flere-bunn">
            <div className="knapper">
              <button type="button" onClick={() => endreKort(k.nokkel, { linjer: [...k.linjer, tomLinje()] })}>
                + Linje
              </button>
              <button type="button" onClick={() => settValg({ type: "nytt-produkt", kort: k.nokkel, linje: "ny" })}>
                + Nytt produkt
              </button>
              <RabattKnapp
                vis={k.rabatt || harRabatt(k.linjer)}
                veksle={() =>
                  k.rabatt || harRabatt(k.linjer) ? endreKort(k.nokkel, { rabatt: false, linjer: k.linjer.map((l) => ({ ...l, rabatt: "" })) }) : endreKort(k.nokkel, { rabatt: true })
                }
              />
            </div>
            <span className="flere-sum">
              <span className="dempet liten">{utenMva ? "Å betale" : "Inkl. mva"}</span> {kr(sum.inkl)}
            </span>
          </div>
          <details className="flere-mer" open={Boolean(k.deres_referanse || k.kopi) || undefined}>
            <summary>Referanse og kopi</summary>
            <div className="rad">
              <label>
                Deres ref.
                <input value={k.deres_referanse} placeholder={kunde?.deres_referanse ?? ""} onChange={(e) => endreKort(k.nokkel, { deres_referanse: e.target.value })} />
              </label>
              <EpostlisteFelt className="hel" etikett="Kopi til" verdi={k.kopi} endre={(v) => endreKort(k.nokkel, { kopi: v })} plassholder="f.eks. regnskap@kunde.no" />
            </div>
          </details>
        </div>
      ))}

      {kort.length === 0 && <p className="dempet">Ingen fakturaer ennå. Legg til kunder for å begynne.</p>}

      <div className="kort flere-oppsummering">
        <div className="flere-total">
          <span>{flertall(kort.length, "faktura", "fakturaer")}</span>
          <strong>{kr(total)}</strong>
        </div>
        {utenEpost.length > 0 && (
          <p className="liten dempet">
            Mangler e-post: {utenEpost.map((b) => b.kunde.navn).join(", ")}. Fakturaene blir utstedt, men ikke sendt på e-post.
          </p>
        )}
        <Feil melding={h.feil} />
        <div className="knapper">
          <button type="button" disabled={h.opptatt || !kort.length} onClick={() => lagre(false)}>
            Lagre som utkast
          </button>
          <button type="button" className="primar" disabled={h.opptatt || !kort.length || !orgData.data.kontonr} onClick={() => lagre(true)}>
            {h.opptatt ? "Sender …" : `Send ${flertall(kort.length, "faktura", "fakturaer")}`}
          </button>
        </div>
      </div>

      <Dialog apen={valg?.type === "kunder"} lukk={() => settValg(null)} tittel="Legg til kunder">
        <VelgKunder
          kunder={kunder.data!}
          brukte={new Set(kort.map((k) => k.kunde_id).filter(Boolean))}
          legg={(ider) => {
            leggTilKunder(ider);
            settValg(null);
          }}
        />
      </Dialog>
      <Dialog apen={valg?.type === "produkt-alle"} lukk={() => settValg(null)} tittel="Produkt på alle fakturaene">
        <ProduktPaAlle
          produkter={produkter.data!}
          antallKort={kort.length}
          bruk={(p, antall) => {
            produktPaAlle(p, antall);
            settValg(null);
          }}
          nytt={(antall, navn) => settValg({ type: "nytt-produkt", kort: "alle", linje: "ny", antall, navn })}
        />
      </Dialog>
      <Dialog apen={valg?.type === "ny-kunde"} lukk={() => settValg(null)} tittel="Ny kunde">
        <KundeSkjema
          kunde={{ type: "firma", aktiv: true, navn: valg?.type === "ny-kunde" ? (valg.navn ?? "") : "" }}
          lagret={async (ny) => {
            const v = valg;
            settValg(null);
            await kunder.last();
            if (v?.type === "ny-kunde") endreKort(v.kort, { kunde_id: ny.id });
          }}
          avbryt={() => settValg(null)}
        />
      </Dialog>
      <Dialog apen={valg?.type === "nytt-produkt"} lukk={() => settValg(null)} tittel="Nytt produkt">
        <ProduktSkjema
          produkt={{ enhet: "stk", mva_sats: utenMva ? 0 : 25, aktiv: true, navn: valg?.type === "nytt-produkt" ? (valg.navn ?? "") : "" }}
          lagret={(p) => {
            const v = valg;
            settValg(null);
            void produkter.last();
            if (!p || v?.type !== "nytt-produkt") return;
            if (v.kort === "alle") produktPaAlle(p, v.antall ?? "1");
            else settKort((ks) => ks.map((k) => (k.nokkel === v.kort ? { ...k, linjer: medProdukt(k.linjer, p, v.linje) } : k)));
          }}
          avbryt={() => settValg(null)}
        />
      </Dialog>
    </>
  );
}

// Velg mange kunder på én gang (med søk og «velg alle»).
function VelgKunder({ kunder, brukte, legg }: { kunder: any[]; brukte: Set<string>; legg: (ider: string[]) => void }) {
  const [sok, settSok] = useState("");
  const [valgt, settValgt] = useState<Set<string>>(new Set());
  const q = sok.trim().toLowerCase();
  const synlige = kunder.filter((k) => !q || k.navn.toLowerCase().includes(q) || String(k.kundenummer).includes(q));
  const alleValgt = synlige.length > 0 && synlige.every((k) => valgt.has(k.id));
  const veksle = (id: string) =>
    settValgt((v) => {
      const n = new Set(v);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  return (
    <div className="flervalg">
      <input type="search" className="sok" placeholder="Søk etter kunde" value={sok} onChange={(e) => settSok(e.target.value)} />
      <label className="velg-alle">
        <input
          type="checkbox"
          checked={alleValgt}
          onChange={() =>
            settValgt((v) => {
              const n = new Set(v);
              for (const k of synlige) {
                if (alleValgt) n.delete(k.id);
                else n.add(k.id);
              }
              return n;
            })
          }
        />
        Velg alle{q ? " treffene" : ""} ({synlige.length})
      </label>
      <div className="flervalg-liste">
        {synlige.map((k) => (
          <label key={k.id}>
            <input type="checkbox" checked={valgt.has(k.id)} onChange={() => veksle(k.id)} />
            <span>
              <span className="navn">{k.navn}</span>
              <span className="dempet liten">
                {k.epost ?? "mangler e-post"}
                {brukte.has(k.id) ? " · har allerede en faktura her" : ""}
              </span>
            </span>
          </label>
        ))}
        {synlige.length === 0 && <p className="dempet">Ingen kunder passer.</p>}
      </div>
      <div className="knapper">
        <button type="button" className="primar" disabled={!valgt.size} onClick={() => legg(kunder.filter((k) => valgt.has(k.id)).map((k) => k.id))}>
          Legg til {valgt.size ? flertall(valgt.size, "kunde", "kunder") : "kunder"}
        </button>
      </div>
    </div>
  );
}

// Legg samme produkt på alle fakturaene (prisen kan endres på hver etterpå).
function ProduktPaAlle({ produkter, antallKort, bruk, nytt }: { produkter: any[]; antallKort: number; bruk: (p: any, antall: string) => void; nytt: (antall: string, navn: string) => void }) {
  const [id, settId] = useState<string | null>(null);
  const [antall, settAntall] = useState("1");
  const [pris, settPris] = useState("");
  const valg = useMemo(() => produktValg(produkter), [produkter]);
  const p = id ? produkter.find((x) => x.id === id) : null;
  const variabel = Boolean(p && p.enhetspris == null);
  return (
    <>
      <div className="rad">
        <label className="hel">
          Produkt
          <Sokefelt etikett="Produkt" valg={valg} verdi={id} velg={settId} plassholder="Søk produkt" ny={{ tekst: "+ Nytt produkt", handling: (navn) => nytt(antall, navn) }} />
        </label>
        <label>
          Antall
          <input inputMode="decimal" value={antall} onChange={(e) => settAntall(e.target.value)} />
        </label>
        {variabel && (
          <label>
            Pris eks. mva
            <input inputMode="decimal" value={pris} placeholder="Fyll inn" onChange={(e) => settPris(e.target.value)} />
          </label>
        )}
      </div>
      {variabel && <p className="liten dempet">Produktet har ikke fast pris. Fyll inn prisen her for alle fakturaene, eller på hver av dem etterpå.</p>}
      <p className="liten dempet">
        Legges på alle {antallKort} fakturaene, på første tomme linje eller som en ny linje. Pris og antall kan endres på hver faktura etterpå.
      </p>
      <div className="knapper">
        <button type="button" className="primar" disabled={!p} onClick={() => bruk(variabel && pris.trim() ? { ...p, enhetspris: tall(pris) } : p, antall)}>
          Legg til på alle
        </button>
      </div>
    </>
  );
}
