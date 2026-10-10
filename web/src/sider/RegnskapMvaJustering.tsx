// Mva-justeringen for kapitalvarer (server/src/mvaJustering.ts): kortet for året under Regnskap → Mva
// (fradragsprosenten for fellesanskaffelser, kapitalvarene med justeringen, bokføringen og de samlede
// justeringene ved salg) og delen på anleggsmiddelet (justeringen år for år, bruken og den samlede
// justeringen ved salget).
import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { api, hent } from "../api";
import { Dialog, Feil, tall, useData, useHandling } from "../felles";
import { useKonto } from "../konto";
import { dato, kr } from "../format";

export type Kapitalvarestatus = {
  kapitalvare: boolean;
  grense: number;
  periode: { fra: number; til: number; antall: number } | null;
  aar: { aar: number; prosent: number; kilde: Kilde; endring: number; belop: number; bokfort: { belop: number; bilagsnummer: string } | null }[];
  salg: {
    aar: number;
    aar_til: number;
    antall: number;
    prosent: number;
    endring: number;
    belop: number;
    med_avgift: boolean;
    bilag: { id: string; bilagsnummer: string; belop: number } | null;
  } | null;
};
type Kilde = "egen" | "felles" | "anskaffelse";
type Aarsjustering = {
  aar: number;
  over: boolean;
  laast: boolean;
  felles: {
    prosent: number;
    kilde: "satt" | "omsetning" | "oppsett";
    satt: number | null;
    omsetning: { avgiftspliktig: number; utenfor: number; prosent: number } | null;
    oppsett: number;
  };
  kapitalvarer: {
    anleggsmiddel_id: string;
    nummer: number;
    navn: string;
    periode: { fra: number; til: number; antall: number };
    aar_nr: number;
    mva_inngaende: number;
    start: number;
    prosent: number;
    kilde: Kilde;
    endring: number;
    belop: number;
    bokfort: number | null;
  }[];
  sum: number;
  bilag: { id: string; bilagsnummer: string } | null;
  stemmer: boolean;
  trengs: boolean;
  samlet: { anleggsmiddel_id: string; nummer: number; navn: string; dato: string; aar: number; aar_til: number; prosent: number; belop: number; bilag: { bilagsnummer: string } }[];
};
// Feltene på anleggsmiddelet som trengs her.
export type Kapitalfelt = {
  id: string;
  mva_inngaende: number | null;
  mva_fradrag: number | null;
  mva_felles: boolean;
  mva_bruk: Record<string, number>;
  avgang_dato: string | null;
};

export const pst = (n: number) => `${String(Math.round(n * 100) / 100).replace(".", ",")} %`;
// Justeringen med retningen: positiv er mer fradrag, negativ betales tilbake.
export const justeringTekst = (belop: number) => (belop > 0 ? `${kr(belop)} kr mer i fradrag` : belop < 0 ? `${kr(-belop)} kr å betale tilbake` : "ingen justering");
const KILDE: Record<Kilde, string> = { felles: "fellesprosenten", egen: "egen prosent", anskaffelse: "som ved anskaffelsen" };

// Den samlede justeringen ved salg i året (som på serveren): resten av perioden med salgsåret, med
// 100 % når salget har avgift og 0 % ellers, når endringen er minst ti prosentpoeng.
export function salgsforslag(a: Kapitalfelt, m: Kapitalvarestatus, salgsdato: string, medAvgift: boolean) {
  if (!m.kapitalvare || !m.periode || a.mva_inngaende == null || a.mva_fradrag == null) return null;
  const aar = Number(salgsdato.slice(0, 4));
  if (aar > m.periode.til) return null;
  const fra = Math.max(aar, m.periode.fra);
  const antall = m.periode.til - fra + 1;
  const prosent = medAvgift ? 100 : 0;
  const endring = Math.round((prosent - a.mva_fradrag) * 100) / 100;
  const belop = Math.abs(endring) < 10 ? 0 : Math.round((Math.round(a.mva_inngaende * 100) * endring * antall) / (100 * m.periode.antall)) / 100;
  return { fra, til: m.periode.til, prosent, belop };
}

// --- Året (Regnskap → Mva) ------------------------------------------------------------------------

// endret: kalles når justeringen er bokført, angret eller fellesprosenten endret (mva-meldingen
// over regnes på nytt).
export function MvaJustering({ aar, endret }: { aar: number; endret?: () => void }) {
  const { org } = useKonto();
  const sti = `/org/${org!.id}/regnskap/mva-justering`;
  const d = useData(() => hent<Aarsjustering>(`${sti}?aar=${aar}`), [sti, aar]);
  const h = useHandling();
  const [prosent, settProsent] = useState<string | null>(null);
  const [melding, settMelding] = useState<string | null>(null);

  if (d.feil) return <Feil melding={d.feil} />;
  const s = d.data;
  if (!s || (!s.kapitalvarer.length && !s.samlet.length && !s.bilag)) return null;
  const kjor = async (fn: () => Promise<unknown>, tekst: (r: any) => string) => {
    settMelding(null);
    const r = await h.kjor(fn);
    if (r) {
      settMelding(tekst(r));
      settProsent(null);
      void d.last();
      endret?.();
    }
  };
  const lagreProsent = (e: FormEvent) => {
    e.preventDefault();
    const p = prosent?.trim() ? tall(prosent) : null;
    void kjor(() => api("PUT", `${sti}/${aar}`, { fradrag: p }), () => (p === null ? "Fradragsprosenten regnes fra omsetningen." : `Fradragsprosenten for ${aar} er satt til ${pst(p)}.`));
  };
  const f = s.felles;
  const kilde =
    f.kilde === "satt"
      ? `satt for ${aar}${f.omsetning ? ` (omsetningen gir ${pst(f.omsetning.prosent)})` : ""}`
      : f.kilde === "omsetning"
        ? `andelen avgiftspliktig omsetning: ${kr(f.omsetning!.avgiftspliktig)} kr av ${kr(f.omsetning!.avgiftspliktig + f.omsetning!.utenfor)} kr`
        : "fradraget i oppsettet (ingen omsetning i året)";
  const merke = !s.over ? (
    <span className="merke merke-noytral">Føres 31.12.</span>
  ) : !s.trengs && !s.bilag ? (
    <span className="merke merke-ok">Ingen endring</span>
  ) : s.bilag && s.stemmer ? (
    <span className="merke merke-ok">Bokført {s.bilag.bilagsnummer}</span>
  ) : s.bilag ? (
    <span className="merke merke-advarsel">Endret etterpå</span>
  ) : (
    <span className="merke merke-advarsel">Ikke bokført</span>
  );

  return (
    <div className={`kort mva-justering${s.over && !s.stemmer ? " gjenstar" : ""}`}>
      <div className="maaned-status-hode">
        <h3>Mva-justering for kapitalvarer {aar}</h3>
        {s.kapitalvarer.length > 0 && merke}
      </div>
      <p className="liten dempet">
        Kapitalvarer (inngående mva på kostprisen minst 50 000 kr, fast eiendom 100 000 kr) justeres hvert år i fem år (fast eiendom ti) når fradragsprosenten er minst
        ti prosentpoeng høyere eller lavere enn ved anskaffelsen: en femdel (tidel) av avgiften ganger endringen. Justeringen føres 31. desember og står i mva-meldingen for
        den siste terminen i året (kode 1, spesifikasjon «justering»).
      </p>
      {melding && (
        <div className="melding ok" role="status">
          {melding}
        </div>
      )}
      {s.kapitalvarer.length > 0 && (
        <>
          <div className="mva-felles">
            <div>
              <strong>Fradragsprosent for fellesanskaffelser: {pst(f.prosent)}</strong>
              <div className="liten dempet">{kilde}</div>
            </div>
            <form onSubmit={lagreProsent}>
              <label>
                Sett for {aar} (%)
                <input
                  inputMode="decimal"
                  value={prosent ?? (f.satt == null ? "" : String(f.satt).replace(".", ","))}
                  placeholder={String(f.omsetning?.prosent ?? f.oppsett)}
                  onChange={(e) => settProsent(e.target.value)}
                />
              </label>
              <button disabled={h.opptatt || prosent === null}>Lagre</button>
              {f.satt != null && (
                <button type="button" className="lenke" disabled={h.opptatt} onClick={() => void kjor(() => api("PUT", `${sti}/${aar}`, { fradrag: null }), () => "Fradragsprosenten regnes fra omsetningen.")}>
                  Regn fra omsetningen
                </button>
              )}
            </form>
          </div>
          <div className="tabell">
            <table className="mva-linjer">
              <thead>
                <tr>
                  <th>Kapitalvare</th>
                  <th className="tall mvaj-fradrag">Fradrag</th>
                  <th className="tall">Justering</th>
                </tr>
              </thead>
              <tbody>
                {s.kapitalvarer.map((l) => (
                  <tr key={l.anleggsmiddel_id}>
                    <td>
                      <Link to={`/regnskap?fane=anlegg&anlegg=${l.anleggsmiddel_id}`}>{l.navn}</Link>
                      <div className="liten dempet">
                        Nr. {l.nummer} · år {l.aar_nr} av {l.periode.antall} · mva {kr(l.mva_inngaende)} kr
                      </div>
                      <div className="liten mvaj-fradrag-under">
                        Fradrag {pst(l.start)} → {pst(l.prosent)} ({KILDE[l.kilde]})
                      </div>
                    </td>
                    <td className="tall mvaj-fradrag">
                      {pst(l.start)} → {pst(l.prosent)}
                      <div className="liten dempet">{KILDE[l.kilde]}</div>
                    </td>
                    <td className="tall">
                      {l.belop ? kr(l.belop) : "–"}
                      {!l.belop && l.endring !== 0 && <div className="liten dempet">under 10 p.p.</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td>{s.sum > 0 ? "Mer i fradrag" : s.sum < 0 ? "Å betale tilbake" : "Sum"}</td>
                  <td className="mvaj-fradrag" />
                  <td className="tall">{kr(s.sum)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
          <div className="mva-handlinger">
            <div>
              <strong>Bokføringen</strong>
              <p className="liten dempet">
                {!s.over
                  ? "Føres av seg selv med månedsavslutningen for desember, før oppgjøret for den siste terminen."
                  : s.bilag
                    ? s.stemmer
                      ? `Bokført (${s.bilag.bilagsnummer}): ${justeringTekst(s.sum)}.`
                      : `Bokført (${s.bilag.bilagsnummer}), men justeringen er endret etterpå.`
                    : s.trengs
                      ? `Ikke bokført (${justeringTekst(s.sum)}). Månedsavslutningen gjør det av seg selv, eller bokfør nå.`
                      : "Ingen endring på minst ti prosentpoeng: ingenting å justere."}
                {s.laast ? " Året er låst." : ""}
              </p>
              {s.over && !s.laast && (s.bilag || s.trengs) && (
                <div className="knapper">
                  {!s.stemmer && (
                    <button
                      type="button"
                      className="primar"
                      disabled={h.opptatt}
                      onClick={() =>
                        void kjor(
                          () => api("POST", `${sti}/${aar}`, {}),
                          (r) => (r.bilag ? `Justeringen er bokført (${r.bilag.bilagsnummer}).` : "Justeringen er angret; det er ingenting å justere."),
                        )
                      }
                    >
                      {s.bilag ? "Bokfør på nytt" : "Bokfør justeringen"}
                    </button>
                  )}
                  {s.bilag && (
                    <button
                      type="button"
                      disabled={h.opptatt}
                      onClick={() => confirm("Angre justeringen? Bilaget reverseres.") && void kjor(() => api("DELETE", `${sti}/${aar}`), () => "Justeringen er angret.")}
                    >
                      Angre
                    </button>
                  )}
                </div>
              )}
            </div>
            <div>
              <strong>I mva-meldingen</strong>
              <p className="liten dempet">
                Kode 1 med spesifikasjonen «justering», uten grunnlag og sats: {s.sum ? `${kr(-s.sum)} kr` : "0 kr"} (positivt er tilbakebetaling). Kostnaden eller
                inntekten føres på kontoen for mva-justering (Kontoer).
              </p>
            </div>
          </div>
        </>
      )}
      {s.samlet.length > 0 && (
        <div className="mva-samlet liten">
          <strong>Samlet justering ved salg</strong>
          <ul>
            {s.samlet.map((x) => (
              <li key={x.anleggsmiddel_id}>
                <Link to={`/regnskap?fane=anlegg&anlegg=${x.anleggsmiddel_id}`}>{x.navn}</Link> solgt {dato(x.dato)}: {x.aar === x.aar_til ? x.aar : `${x.aar}–${x.aar_til}`} med{" "}
                {pst(x.prosent)}, {justeringTekst(x.belop)} ({x.bilag.bilagsnummer}).
              </li>
            ))}
          </ul>
        </div>
      )}
      <Feil melding={h.feil} />
    </div>
  );
}

// --- Anleggsmiddelet ---------------------------------------------------------------------------------

export function Kapitalvare({ a, m, ferdig }: { a: Kapitalfelt; m: Kapitalvarestatus; ferdig: (r: any, tekst: string) => void }) {
  const { org } = useKonto();
  const sti = `/org/${org!.id}/regnskap/anleggsmidler/${a.id}`;
  const h = useHandling();
  const [bruk, settBruk] = useState(false);
  if (!m.kapitalvare || !m.periode) {
    if (a.mva_inngaende == null) return null;
    return (
      <p className="dempet liten">
        Inngående mva på kostprisen er {kr(a.mva_inngaende)} kr, under grensen for kapitalvarer ({kr(m.grense)} kr): justeres ikke.
      </p>
    );
  }
  const salg = m.salg;
  const kjor = async (fn: () => Promise<unknown>, tekst: (r: any) => string) => {
    const r = await h.kjor(fn);
    if (r) ferdig(r, tekst(r));
  };
  return (
    <>
      <h3 className="lonn-under">Mva-justering (kapitalvare)</h3>
      <p className="dempet liten">
        Inngående mva på kostprisen {kr(a.mva_inngaende)} kr med {pst(a.mva_fradrag!)} fradrag ved anskaffelsen. Justeringsperioden er {m.periode.fra}–{m.periode.til} (
        {m.periode.antall} år); {a.mva_felles ? "bruken følger fradragsprosenten for fellesanskaffelser hvert år" : "egen fradragsprosent per år"}. Justeres når
        prosenten i et år er minst ti prosentpoeng høyere eller lavere.
      </p>
      {m.aar.length > 0 && (
        <div className="kort tabell">
          <table>
            <thead>
              <tr>
                <th>År</th>
                <th className="hoyre">Fradrag</th>
                <th className="hoyre">Justering</th>
                <th>Bokført</th>
              </tr>
            </thead>
            <tbody>
              {m.aar.map((x) => (
                <tr key={x.aar}>
                  <td>{x.aar}</td>
                  <td className="tall">
                    {pst(x.prosent)}
                    <div className="liten dempet">{KILDE[x.kilde]}</div>
                  </td>
                  <td className="tall">{x.belop ? kr(x.belop) : "–"}</td>
                  <td>{x.bokfort ? `${x.bokfort.bilagsnummer}${x.bokfort.belop !== x.belop ? ` (${kr(x.bokfort.belop)})` : ""}` : <span className="dempet liten">{x.belop ? "Ikke bokført" : ""}</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {salg && (
        <div className={`kort mva-salg${salg.belop && !salg.bilag ? " gjenstar" : ""}`}>
          <strong>Samlet justering ved salget</strong>
          <p className="liten">
            {salg.aar === salg.aar_til ? salg.aar : `${salg.aar}–${salg.aar_til}`} ({salg.antall} år) med {pst(salg.prosent)}
            {salg.prosent === (salg.med_avgift ? 100 : 0) ? (salg.med_avgift ? " (salget har avgift)" : " (salget er uten avgift)") : ""}: {justeringTekst(salg.belop)}
            {salg.bilag ? `, bokført (${salg.bilag.bilagsnummer}) mot gevinst eller tap.` : salg.belop ? ", ikke bokført." : "."}
          </p>
          <div className="knapper">
            {!salg.bilag && salg.belop !== 0 && (
              <button
                type="button"
                className="primar"
                disabled={h.opptatt}
                onClick={() => void kjor(() => api("POST", `${sti}/mva-justering`, {}), () => "Den samlede justeringen er bokført")}
              >
                Bokfør justeringen
              </button>
            )}
            {salg.bilag && (
              <button
                type="button"
                disabled={h.opptatt}
                onClick={() =>
                  confirm("Angre den samlede justeringen (f.eks. når kjøperen overtar justeringsplikten)? Bilaget reverseres.") &&
                  void kjor(() => api("DELETE", `${sti}/mva-justering`), () => "Den samlede justeringen er angret")
                }
              >
                Angre justeringen
              </button>
            )}
          </div>
        </div>
      )}
      {!a.avgang_dato && (
        <div className="knapper lonn-knapper">
          <button type="button" onClick={() => settBruk(true)}>
            Endre bruken
          </button>
        </div>
      )}
      <Feil melding={h.feil} />
      <Dialog apen={bruk} lukk={() => settBruk(false)} tittel="Bruken av kapitalvaren">
        <Bruk a={a} periode={m.periode} ferdig={(r) => (settBruk(false), ferdig(r, "Bruken er lagret"))} avbryt={() => settBruk(false)} />
      </Dialog>
    </>
  );
}

function Bruk({ a, periode, ferdig, avbryt }: { a: Kapitalfelt; periode: { fra: number; til: number }; ferdig: (r: unknown) => void; avbryt: () => void }) {
  const { org } = useKonto();
  const aar = Array.from({ length: periode.til - periode.fra + 1 }, (_, i) => periode.fra + i);
  const [felles, settFelles] = useState(a.mva_felles);
  const [egen, settEgen] = useState<Record<string, string>>(Object.fromEntries(Object.entries(a.mva_bruk).map(([k, v]) => [k, String(v).replace(".", ",")])));
  const h = useHandling();
  async function lagre(e: FormEvent) {
    e.preventDefault();
    const mva_bruk = Object.fromEntries(
      Object.entries(egen)
        .filter(([, v]) => v.trim())
        .map(([k, v]) => [k, tall(v)]),
    );
    const r = await h.kjor(() => api("PATCH", `/org/${org!.id}/regnskap/anleggsmidler/${a.id}`, { mva_felles: felles, mva_bruk }));
    if (r) ferdig(r);
  }
  return (
    <form onSubmit={lagre}>
      <label>
        <input type="checkbox" checked={felles} onChange={(e) => settFelles(e.target.checked)} /> Til felles bruk: følger fradragsprosenten for fellesanskaffelser hvert år
      </label>
      <p className="dempet liten">
        {felles
          ? "Fyll inn et år bare når bruken det året var en annen enn fellesprosenten."
          : "Fradragsprosenten gjelder fra året den står i, til den endres; tomt før det første: som ved anskaffelsen."}
      </p>
      <div className="mva-bruk">
        {aar.map((y) => (
          <label key={y}>
            {y} (%)
            <input inputMode="decimal" value={egen[String(y)] ?? ""} placeholder={felles ? "felles" : ""} onChange={(e) => settEgen({ ...egen, [String(y)]: e.target.value })} />
          </label>
        ))}
      </div>
      <Feil melding={h.feil} />
      <div className="knapper">
        <button className="primar" disabled={h.opptatt}>
          Lagre
        </button>
        <button type="button" onClick={avbryt}>
          Avbryt
        </button>
      </div>
    </form>
  );
}
