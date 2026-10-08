// Kunder og produkter: liste og skjema i dialog.
import { useEffect, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, hent } from "../api";
import { Dialog, Feil, Laster, tall, useData, useHandling, useSmal } from "../felles";
import { harFunksjon, kanSkrive, useKonto } from "../konto";
import { dato, kr, orgnr } from "../format";
import { AvsenderKonto } from "./AvsenderKonto";
import { lesMakstak, tallTekst } from "../linjer";

export function Kunder() {
  const { org } = useKonto();
  // Søket kan komme fra adressen (?sok=), f.eks. fra kunden en person er hentet inn fra (Ansatte).
  const [adresse] = useSearchParams();
  const [sok, settSok] = useState(() => adresse.get("sok") ?? "");
  const [redigerer, settRedigerer] = useState<any | null>(null);
  const { data, feil, laster, last } = useData(() => hent(`/org/${org!.id}/kunder${sok ? `?sok=${encodeURIComponent(sok)}` : ""}`), [org?.id, sok]);
  const smal = useSmal();

  return (
    <>
      <div className="topp">
        <h1>Kunder</h1>
        {kanSkrive(org?.rolle) && (
          <div className="knapper">
            {harFunksjon(org, "import") && (
              <Link className="knapp" to="/kunder/importer">
                Importer
              </Link>
            )}
            <button className="primar" onClick={() => settRedigerer({ type: "firma", aktiv: true })}>
              Ny kunde
            </button>
          </div>
        )}
      </div>
      <input type="search" className="sok" placeholder="Søk etter navn" value={sok} onChange={(e) => settSok(e.target.value)} />
      <Feil melding={feil} />
      {laster && !data ? (
        <Laster />
      ) : smal ? (
        <div className="kort liste">
          {(data ?? []).map((k: any) => (
            <button key={k.id} type="button" className="liste-rad" onClick={() => kanSkrive(org?.rolle) && settRedigerer(k)}>
              <span className="linje">
                <span className="tittel">{k.navn}</span>
                <span className="under">{k.kundenummer}</span>
              </span>
              <span className="linje">
                <span className="under">{k.epost ?? k.telefon ?? (k.orgnr ? `Org.nr. ${orgnr(k.orgnr)}` : "")}</span>
                <span>
                  {k.ehf && <span className="merke merke-info">EHF</span>}
                  {!k.epost ? <span className="merke merke-advarsel">Mangler e-post</span> : !k.aktiv && <span className="merke merke-noytral">Inaktiv</span>}
                </span>
              </span>
            </button>
          ))}
          {data?.length === 0 && <IngenEnna hva="kunder" sti="/kunder/importer" kanImportere={kanSkrive(org?.rolle) && harFunksjon(org, "import")} sok={sok} />}
        </div>
      ) : (
        <div className="kort tabell">
          <table>
            <thead>
              <tr>
                <th>Nr.</th>
                <th>Navn</th>
                <th>Org.nr.</th>
                <th>E-post</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {(data ?? []).map((k: any) => (
                <tr key={k.id} className="klikkbar" onClick={() => kanSkrive(org?.rolle) && settRedigerer(k)}>
                  <td>{k.kundenummer}</td>
                  <td>{k.navn}</td>
                  <td>{orgnr(k.orgnr)}</td>
                  <td>{k.epost ?? <span className="merke merke-advarsel">Mangler e-post</span>}</td>
                  <td>
                    {k.ehf && <span className="merke merke-info" title="Kan motta EHF (elektronisk faktura)">EHF</span>}{" "}
                    {!k.aktiv && <span className="merke merke-noytral">Inaktiv</span>}
                  </td>
                </tr>
              ))}
              {data?.length === 0 && (
                <tr>
                  <td colSpan={5}>
                    <IngenEnna hva="kunder" sti="/kunder/importer" kanImportere={kanSkrive(org?.rolle) && harFunksjon(org, "import")} sok={sok} />
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      <Dialog apen={!!redigerer} lukk={() => settRedigerer(null)} tittel={redigerer?.id ? "Endre kunde" : "Ny kunde"}>
        <KundeSkjema
          kunde={redigerer}
          lagret={() => {
            settRedigerer(null);
            last();
          }}
          avbryt={() => settRedigerer(null)}
          slettet={() => {
            settRedigerer(null);
            last();
          }}
        />
      </Dialog>
    </>
  );
}

// Tom liste: si fra, og vis veien til importen.
function IngenEnna({ hva, sti, kanImportere, sok }: { hva: string; sti: string; kanImportere: boolean; sok?: string }) {
  if (sok) return <p className="dempet ingen-enna">Ingen {hva} passer søket.</p>;
  return (
    <p className="dempet ingen-enna">
      Ingen {hva} ennå.
      {kanImportere && (
        <>
          {" "}
          Har du {hva} i et annet system? <Link to={sti}>Importer dem</Link>.
        </>
      )}
    </p>
  );
}

export function KundeSkjema({ kunde, lagret, avbryt, slettet }: { kunde: any; lagret: (k: any) => void; avbryt: () => void; slettet?: () => void }) {
  const { org } = useKonto();
  const [k, settK] = useState<any>({ ...kunde });
  const [takTekst, settTakTekst] = useState(kunde?.makstak != null ? tallTekst(kunde.makstak) : "");
  const tak = lesMakstak(takTekst);
  const { opptatt, feil, settFeil, kjor } = useHandling();
  const felt = (navn: string) => ({ value: k[navn] ?? "", onChange: (e: any) => settK({ ...k, [navn]: e.target.value }) });

  async function slaOpp() {
    const e = await kjor(() => hent(`/brreg/${(k.orgnr ?? "").replace(/\s/g, "")}`));
    if (e) settK({ ...k, navn: e.navn, adresse: e.adresse, postnr: e.postnr, poststed: e.poststed });
  }

  async function lagre(ev: FormEvent) {
    ev.preventDefault();
    if (tak.feil) return settFeil(tak.feil);
    const kropp = {
      type: k.type,
      navn: k.navn,
      orgnr: k.orgnr ? k.orgnr.replace(/\s/g, "") : null,
      adresse: k.adresse || null,
      postnr: k.postnr || null,
      poststed: k.poststed || null,
      epost: k.epost || null,
      telefon: k.telefon || null,
      deres_referanse: k.deres_referanse || null,
      notat: k.notat || null,
      aktiv: k.aktiv,
      makstak: tak.tak,
    };
    const r = await kjor(() => (k.id ? api("PATCH", `/org/${org!.id}/kunder/${k.id}`, kropp) : api("POST", `/org/${org!.id}/kunder`, kropp)));
    if (r) lagret(r);
  }

  return (
    <form onSubmit={lagre}>
      <div className="rad">
        <label>
          Type
          <select {...felt("type")}>
            <option value="firma">Firma</option>
            <option value="person">Privatperson</option>
          </select>
        </label>
        {k.type === "firma" && (
          <label className="hel">
            Org.nr.
            <div className="med-knapp">
              <input inputMode="numeric" {...felt("orgnr")} />
              <button type="button" onClick={slaOpp} disabled={(k.orgnr ?? "").replace(/\s/g, "").length !== 9}>
                Hent
              </button>
            </div>
          </label>
        )}
      </div>
      {k.type === "firma" && harFunksjon(org, "ehf") && <EhfStatus kunde={k} lagretOrgnr={kunde?.orgnr} oppdatert={(ny) => settK({ ...k, ehf: ny.ehf, ehf_sjekket: ny.ehf_sjekket })} />}
      <label>
        Navn
        <input required {...felt("navn")} />
      </label>
      <label>
        Adresse
        <input {...felt("adresse")} />
      </label>
      <div className="rad">
        <label>
          Postnr.
          <input {...felt("postnr")} />
        </label>
        <label>
          Poststed
          <input {...felt("poststed")} />
        </label>
      </div>
      <div className="rad">
        <label>
          E-post for faktura
          <input type="email" {...felt("epost")} />
        </label>
        <label>
          Telefon
          <input {...felt("telefon")} />
        </label>
      </div>
      <div className="rad">
        <label>
          Deres referanse (standard)
          <input {...felt("deres_referanse")} />
        </label>
        <label>
          Makstak per faktura (valgfritt)
          <input inputMode="decimal" placeholder="Ingen" value={takTekst} onChange={(e) => settTakTekst(e.target.value)} />
          <span className="felt-hjelp">
            {tak.tak != null
              ? `Kunden betaler aldri mer enn ${kr(tak.tak)} kr på én faktura. Kommer automatisk på nye fakturaer til kunden og kan fjernes på hver faktura.`
              : "Avtalt høyeste beløp å betale på én faktura. Er summen høyere, får fakturaen et fratrekk."}
            {kunde?.makstak != null && tak.tak !== kunde.makstak && " Endringen gjelder også utkast og gjentakende fakturaer som hadde det gamle makstaket."}
          </span>
        </label>
      </div>
      <label>
        Notat
        <textarea rows={2} {...felt("notat")} />
      </label>
      <label>
        <input type="checkbox" checked={k.aktiv !== false} onChange={(e) => settK({ ...k, aktiv: e.target.checked })} />
        Aktiv
      </label>
      <Feil melding={feil} />
      <div className="knapper">
        <button className="primar" disabled={opptatt}>
          Lagre
        </button>
        <button type="button" onClick={avbryt}>
          Avbryt
        </button>
        {k.id && slettet && (
          <button
            type="button"
            className="fare"
            style={{ marginLeft: "auto" }}
            disabled={opptatt}
            onClick={async () => {
              if (!confirm(`Slette ${k.navn}? Det går bare for kunder uten fakturaer.`)) return;
              const r = await kjor(async () => (await api("DELETE", `/org/${org!.id}/kunder/${k.id}`), true));
              if (r !== undefined) slettet();
            }}
          >
            Slett kunde
          </button>
        )}
      </div>
    </form>
  );
}

// Kan kunden motta EHF (elektronisk faktura)? Sjekkes i PEPPOL-registeret (ELMA) med en
// gang org.nr. er skrevet inn, når kunden lagres, jevnlig, og når man ber om det her.
function EhfStatus({ kunde: k, lagretOrgnr, oppdatert }: { kunde: any; lagretOrgnr?: string | null; oppdatert: (k: any) => void }) {
  const { org } = useKonto();
  const h = useHandling();
  const nr = (k.orgnr ?? "").replace(/\s/g, "");
  if (!/^\d{9}$/.test(nr)) return null;
  if (!k.id || nr !== (lagretOrgnr ?? "").replace(/\s/g, "")) return <EhfForLagring orgnr={nr} />;
  const tekst =
    k.ehf === true ? "Kan motta EHF (elektronisk faktura)." : k.ehf === false ? "Er ikke registrert for å motta EHF." : "Ikke sjekket om kunden kan motta EHF ennå.";
  return (
    <p className={`liten ehf-status${k.ehf ? " ja" : ""}`}>
      {tekst}
      {k.ehf_sjekket && <span className="dempet"> Sjekket {dato(k.ehf_sjekket)}.</span>}{" "}
      <button
        type="button"
        className="lenke"
        disabled={h.opptatt}
        onClick={async () => {
          const r = await h.kjor(() => api("POST", `/org/${org!.id}/kunder/${k.id}/ehf`));
          if (r) oppdatert(r);
        }}
      >
        {h.opptatt ? "Sjekker …" : "Sjekk nå"}
      </button>
      {h.feil && <span className="felt-feil">{h.feil}</span>}
    </p>
  );
}

// Før kunden er lagret (eller når org.nr. er endret): sjekk med en gang org.nr. er skrevet
// inn. Svaret lagres sammen med kunden.
function EhfForLagring({ orgnr }: { orgnr: string }) {
  const [svar, settSvar] = useState<{ orgnr: string; ehf: boolean | null } | null>(null);
  useEffect(() => {
    let avbrutt = false;
    const t = setTimeout(() => {
      hent<{ orgnr: string; ehf: boolean | null }>(`/peppol/${orgnr}`).then(
        (s) => !avbrutt && settSvar(s),
        () => !avbrutt && settSvar({ orgnr, ehf: null }),
      );
    }, 400);
    return () => {
      avbrutt = true;
      clearTimeout(t);
    };
  }, [orgnr]);
  if (!svar || svar.orgnr !== orgnr) return <p className="liten dempet ehf-status" role="status">Sjekker om kunden kan motta EHF …</p>;
  return (
    <p className={`liten ehf-status${svar.ehf ? " ja" : ""}`} role="status">
      {svar.ehf === true
        ? "Kan motta EHF (elektronisk faktura)."
        : svar.ehf === false
          ? "Er ikke registrert for å motta EHF."
          : "Fikk ikke sjekket om kunden kan motta EHF nå. Det sjekkes på nytt når kunden er lagret."}
    </p>
  );
}

export function Produkter() {
  const { org } = useKonto();
  const [redigerer, settRedigerer] = useState<any | null>(null);
  const { data, feil, laster, last } = useData(() => hent(`/org/${org!.id}/produkter`), [org?.id]);
  const smal = useSmal();

  return (
    <>
      <div className="topp">
        <h1>Produkter og tjenester</h1>
        {kanSkrive(org?.rolle) && (
          <div className="knapper">
            {harFunksjon(org, "import") && (
              <Link className="knapp" to="/produkter/importer">
                Importer
              </Link>
            )}
            <button className="primar" onClick={() => settRedigerer({ enhet: "stk", mva_sats: 25, aktiv: true })}>
              Nytt produkt
            </button>
          </div>
        )}
      </div>
      <Feil melding={feil} />
      {laster && !data ? (
        <Laster />
      ) : smal ? (
        <div className="kort liste">
          {(data ?? []).map((p: any) => (
            <button key={p.id} type="button" className="liste-rad" onClick={() => kanSkrive(org?.rolle) && settRedigerer(p)}>
              <span className="linje">
                <span className="tittel">{p.navn}</span>
                <span className="belop">{p.enhetspris == null ? <span className="dempet">Variabel</span> : kr(p.enhetspris)}</span>
              </span>
              <span className="linje">
                <span className="under">
                  per {p.enhet} · {p.mva_sats} % mva{p.varenummer ? ` · nr. ${p.varenummer}` : ""}
                </span>
                <span>
                  {p.indeks_aktiv && <span className="merke merke-info">KPI</span>}
                  {!p.aktiv && <span className="merke merke-noytral">Inaktiv</span>}
                </span>
              </span>
            </button>
          ))}
          {data?.length === 0 && <IngenEnna hva="produkter" sti="/produkter/importer" kanImportere={kanSkrive(org?.rolle) && harFunksjon(org, "import")} />}
        </div>
      ) : (
        <div className="kort tabell">
          <table>
            <thead>
              <tr>
                <th>Varenr.</th>
                <th>Navn</th>
                <th>Enhet</th>
                <th className="hoyre">Pris eks. mva</th>
                <th className="hoyre">Mva</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {(data ?? []).map((p: any) => (
                <tr key={p.id} className="klikkbar" onClick={() => kanSkrive(org?.rolle) && settRedigerer(p)}>
                  <td>{p.varenummer}</td>
                  <td>{p.navn}</td>
                  <td>{p.enhet}</td>
                  <td className="tall">{p.enhetspris == null ? <span className="dempet">Variabel</span> : kr(p.enhetspris)}</td>
                  <td className="tall">{p.mva_sats} %</td>
                  <td>
                    {p.indeks_aktiv && <span className="merke merke-info" title="Indeksreguleres årlig etter KPI">KPI</span>}{" "}
                    {!p.aktiv && <span className="merke merke-noytral">Inaktiv</span>}
                  </td>
                </tr>
              ))}
              {data?.length === 0 && (
                <tr>
                  <td colSpan={6}>
                    <IngenEnna hva="produkter" sti="/produkter/importer" kanImportere={kanSkrive(org?.rolle) && harFunksjon(org, "import")} />
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      <Dialog apen={!!redigerer} lukk={() => settRedigerer(null)} tittel={redigerer?.id ? "Endre produkt" : "Nytt produkt"}>
        <ProduktSkjema
          produkt={redigerer}
          lagret={() => {
            settRedigerer(null);
            last();
          }}
          avbryt={() => settRedigerer(null)}
        />
      </Dialog>
    </>
  );
}

export function ProduktSkjema({ produkt, lagret, avbryt }: { produkt: any; lagret: (p?: any) => void; avbryt: () => void }) {
  const { org } = useKonto();
  const orgData = useData(() => hent(`/org/${org!.id}`), [org?.id]);
  const utenMva = orgData.data && !orgData.data.mva_registrert;
  const [p, settP] = useState<any>({
    ...produkt,
    enhetspris: produkt?.enhetspris?.toString().replace(".", ",") ?? "",
    variabel: Boolean(produkt?.id && produkt.enhetspris == null), // ingen fast pris
  });
  const { opptatt, feil, kjor } = useHandling();
  const felt = (navn: string) => ({ value: p[navn] ?? "", onChange: (e: any) => settP({ ...p, [navn]: e.target.value }) });

  async function lagre(ev: FormEvent) {
    ev.preventDefault();
    const kropp = {
      varenummer: p.varenummer || null,
      navn: p.navn,
      beskrivelse: p.beskrivelse || null,
      enhet: p.enhet || "stk",
      enhetspris: p.variabel ? null : tall(String(p.enhetspris)),
      mva_sats: utenMva ? 0 : Number(p.mva_sats),
      aktiv: p.aktiv !== false,
      avsender: p.avsender ?? null,
      konto_id: p.standardkonto ? null : (p.konto_id ?? null),
      standardkonto: Boolean(p.standardkonto),
      indeks_aktiv: !p.variabel && Boolean(p.indeks_aktiv),
      indeks_maaned: p.indeks_aktiv ? Number(p.indeks_maaned) : (p.indeks_maaned ? Number(p.indeks_maaned) : null),
      indeks_basis: p.indeks_basis ? String(p.indeks_basis).slice(0, 10) : null,
      indeks_andel: Number(String(p.indeks_andel ?? 100).replace(",", ".")),
      indeks_bare_okning: p.indeks_bare_okning !== false,
      indeks_hele_kroner: p.indeks_hele_kroner !== false,
      indeks_varsle: p.indeks_varsle !== false,
    };
    const r = await kjor(() => (p.id ? api("PATCH", `/org/${org!.id}/produkter/${p.id}`, kropp) : api("POST", `/org/${org!.id}/produkter`, kropp)));
    if (r) lagret(r);
  }

  return (
    <form onSubmit={lagre}>
      <div className="rad">
        <label>
          Varenummer
          <input {...felt("varenummer")} />
        </label>
        <label>
          Enhet
          <input {...felt("enhet")} placeholder="stk, time, mnd" />
        </label>
      </div>
      <label>
        Navn
        <input required {...felt("navn")} />
      </label>
      <label>
        Beskrivelse
        <textarea rows={2} {...felt("beskrivelse")} />
      </label>
      <div className="rad">
        <label>
          Pris eks. mva
          {p.variabel ? (
            <input disabled value="" placeholder="Variabel" aria-label="Pris eks. mva" />
          ) : (
            <input required inputMode="decimal" {...felt("enhetspris")} />
          )}
        </label>
        {utenMva ? (
          <label>
            Mva
            <input disabled value="Uten mva" />
          </label>
        ) : (
        <label>
          Mva-sats
          <select {...felt("mva_sats")}>
            <option value="25">25 %</option>
            <option value="15">15 %</option>
            <option value="12">12 %</option>
            <option value="0">0 % (fritatt/utenfor)</option>
          </select>
        </label>
        )}
      </div>
      <label>
        <input type="checkbox" checked={Boolean(p.variabel)} onChange={(e) => settP({ ...p, variabel: e.target.checked })} />
        Variabel pris (fylles inn når produktet brukes på en faktura)
      </label>
      {p.variabel && p.id && produkt?.enhetspris == null && (
        <p className="liten dempet" style={{ marginTop: -6 }}>
          Fakturerer du dette jevnlig? <Link to={`/gjentakende?fane=paaminnelser&produkt=${p.id}`}>Lag en påminnelse</Link>, så får du et varsel når
          fakturaen skal lages, med produktet fylt inn.
        </p>
      )}
      <AvsenderKonto org={orgData.data} verdi={p} endre={(v) => settP({ ...p, ...v })} forProdukt />
      <label>
        <input type="checkbox" checked={p.aktiv !== false} onChange={(e) => settP({ ...p, aktiv: e.target.checked })} />
        Aktiv
      </label>
      {!p.variabel && harFunksjon(org, "gjentakende") && <Indeksregulering p={p} settP={settP} />}
      <Feil melding={feil} />
      <div className="knapper">
        <button className="primar" disabled={opptatt}>
          Lagre
        </button>
        <button type="button" onClick={avbryt}>
          Avbryt
        </button>
        {p.id && (
          <button
            type="button"
            className="fare"
            style={{ marginLeft: "auto" }}
            disabled={opptatt}
            onClick={async () => {
              if (!confirm(`Slette ${p.navn}? Det går bare for produkter som ikke er brukt på fakturaer.`)) return;
              const r = await kjor(async () => (await api("DELETE", `/org/${org!.id}/produkter/${p.id}`), true));
              if (r !== undefined) lagret();
            }}
          >
            Slett produkt
          </button>
        )}
      </div>
    </form>
  );
}

const MAANEDER = ["januar", "februar", "mars", "april", "mai", "juni", "juli", "august", "september", "oktober", "november", "desember"];
const maanedTekst = (iso: string) => `${MAANEDER[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;
const kpiTall = (n: number) => n.toLocaleString("nb-NO", { minimumFractionDigits: 1 });

// Årlig regulering etter konsumprisindeksen (husleie, parkeringsleie o.l.).
function Indeksregulering({ p, settP }: { p: any; settP: (p: any) => void }) {
  const { org } = useKonto();
  const kpi = useData(() => hent<{ maaned: string; verdi: number }[]>("/kpi"), []);
  const status = useData(() => (p.id ? hent(`/org/${org!.id}/produkter/${p.id}/indeksregulering`) : Promise.resolve(null)), [p.id]);
  const h = useHandling();
  const siste = kpi.data?.[0];

  const slaaPaa = (paa: boolean) =>
    settP({
      ...p,
      indeks_aktiv: paa,
      indeks_maaned: p.indeks_maaned ?? 1,
      indeks_basis: p.indeks_basis ?? siste?.maaned ?? null,
      indeks_andel: p.indeks_andel ?? 100,
    });
  const felt = (navn: string) => ({ value: p[navn] ?? "", onChange: (e: any) => settP({ ...p, [navn]: e.target.value }) });
  const avkryss = (navn: string) => ({ checked: p[navn] !== false, onChange: (e: any) => settP({ ...p, [navn]: e.target.checked }) });

  const b = status.data?.beregning;
  const reguleringer: any[] = status.data?.reguleringer ?? [];
  const statusTekst: Record<string, string> = { planlagt: "Planlagt", gjennomfort: "Gjennomført", avbrutt: "Avbrutt", uendret: "Uendret (KPI gikk ned)" };

  return (
    <fieldset className="indeks">
      <label>
        <input type="checkbox" checked={Boolean(p.indeks_aktiv)} onChange={(e) => slaaPaa(e.target.checked)} />
        Indeksreguler prisen årlig etter KPI (husleie, parkeringsleie o.l.)
      </label>
      {p.indeks_aktiv && (
        <>
          <div className="rad">
            <label>
              Ny pris gjelder fra
              <select {...felt("indeks_maaned")}>
                {MAANEDER.map((m, i) => (
                  <option key={m} value={i + 1}>
                    1. {m}
                  </option>
                ))}
              </select>
            </label>
            <label>
              KPI-grunnlag (måneden prisen bygger på)
              <select value={p.indeks_basis ? String(p.indeks_basis).slice(0, 10) : ""} onChange={(e) => settP({ ...p, indeks_basis: e.target.value })}>
                {!kpi.data?.length && <option value="">KPI er ikke hentet ennå</option>}
                {(kpi.data ?? []).map((k) => (
                  <option key={k.maaned} value={String(k.maaned).slice(0, 10)}>
                    {maanedTekst(String(k.maaned))}: {kpiTall(k.verdi)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Andel av KPI-endringen (%)
              <input inputMode="decimal" {...felt("indeks_andel")} />
            </label>
          </div>
          <label>
            <input type="checkbox" {...avkryss("indeks_bare_okning")} /> Bare økning (prisen settes ikke ned hvis KPI faller)
          </label>
          <label>
            <input type="checkbox" {...avkryss("indeks_hele_kroner")} /> Rund av til hele kroner
          </label>
          <label>
            <input type="checkbox" {...avkryss("indeks_varsle")} /> Varsle kundene på e-post minst én måned før ny pris gjelder
          </label>
          <p className="dempet liten">
            Reguleringen planlegges inntil 60 dager før og gjennomføres automatisk. Gjentakende fakturaer for produktet med forfall fra datoen
            får ny pris; har en kunde egen pris, reguleres den med samme prosent. Husleieloven § 4-2 krever minst én måneds skriftlig varsel og
            minst ett år mellom hver regulering.
          </p>
          {b && (
            <p className="liten">
              Med dagens tall (KPI {maanedTekst(String(b.kpi_fra))}: {kpiTall(b.kpi_fra_verdi)} → {maanedTekst(String(b.kpi_til))}:{" "}
              {kpiTall(b.kpi_til_verdi)}) blir prisen <strong>{kr(b.ny_pris)}</strong> fra {dato(b.gjelder_fra)}.
            </p>
          )}
        </>
      )}
      {reguleringer.length > 0 && (
        <table className="liten kompakt">
          <thead>
            <tr>
              <th>Gjelder fra</th>
              <th className="hoyre">Pris</th>
              <th className="hoyre">KPI</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {reguleringer.map((r) => (
              <tr key={r.id}>
                <td>{dato(r.gjelder_fra)}</td>
                <td className="tall">
                  {kr(r.gammel_pris)} → {kr(r.ny_pris)}
                </td>
                <td className="tall">{((r.faktor - 1) * 100).toLocaleString("nb-NO", { maximumFractionDigits: 1 })} %</td>
                <td>
                  {statusTekst[r.status] ?? r.status}
                  {r.varslet > 0 && <span className="dempet"> · {r.varslet} varslet</span>}
                </td>
                <td>
                  {r.status === "planlagt" && (
                    <button
                      type="button"
                      className="lenke"
                      disabled={h.opptatt}
                      onClick={() =>
                        confirm(
                          r.varslet > 0
                            ? `Avbryte reguleringen? ${r.varslet} kunde(r) har fått varsel og får ikke beskjed automatisk om at den er avbrutt.`
                            : "Avbryte reguleringen?",
                        ) && h.kjor(() => api("POST", `/org/${org!.id}/prisreguleringer/${r.id}/avbryt`)).then(status.last)
                      }
                    >
                      Avbryt
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <Feil melding={h.feil} />
    </fieldset>
  );
}
