// Ansatte fra a-ordningen (server/src/aordning.ts): for bedrifter som har sendt a-meldinger fra et
// annet system. Workeren henter avstemmingsrapporten fra Skatteetaten (det de siste månedenes
// a-meldinger sier om hver person: arbeidsforholdet og lønnen), og lederen velger hvem som legges
// inn som nye, og hvem som finnes fra før og får arbeidsforholdet slik det er rapportert
// (startdato, stillingsprosent, yrkeskode og arbeidsforholdID-en, så a-meldingen fortsetter det
// samme arbeidsforholdet). Fødselsnumrene vises aldri; de flyttes til de ansatte på serveren.
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, hent } from "../api";
import { Feil, Laster, useHandling } from "../felles";
import { useKonto } from "../konto";
import { dato } from "../format";

type Arbeidsforhold = {
  id: string | null;
  type: string | null;
  startdato: string | null;
  sluttdato: string | null;
  stillingsprosent: number | null;
  yrkeskode: string | null;
  avlonning: string | null;
};
type Kjent = {
  id: string;
  ansattnummer: number;
  fornavn: string;
  etternavn: string;
  har_fnr: boolean;
  ansatt_fra: string;
  stillingsprosent: number;
  yrkeskode: string | null;
  arbeidsforhold_id: string | null;
};
type Person = {
  nr: number;
  fornavn: string | null;
  etternavn: string | null;
  fodselsdato: string | null;
  arbeidsforhold: Arbeidsforhold | null;
  antall_arbeidsforhold: number;
  lonn: { maaned: string | null; fastlonn: number | null; timelonn: number | null; timer: number | null } | null;
  sluttet: boolean;
  ansatt_id: string | null;
  forslag_id: string | null;
  ansatt: Kjent | null;
  forslag: Kjent | null;
};
type Oversikt = {
  tilgjengelig: boolean;
  grunn: string | null;
  henting: {
    status: "bestilt" | "klar" | "feil";
    bestilt: string;
    hentet: string | null;
    periode_fra: string | null;
    periode_til: string | null;
    personer: Person[] | null;
    feil: string | null;
  } | null;
};
// Valget per person: legges inn som ny, oppdaterer den som finnes, eller ikke med.
type Valg = { med: boolean; fornavn: string; etternavn: string };

const kr = new Intl.NumberFormat("nb-NO", { maximumFractionDigits: 2 });
const MAANED = ["jan.", "feb.", "mars", "apr.", "mai", "juni", "juli", "aug.", "sep.", "okt.", "nov.", "des."];
const maanedTekst = (m: string | null) => (m ? `${MAANED[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}` : "");
const kode = (k: string) => `${k.slice(0, 4)} ${k.slice(4)}`;
const navn = (p: { fornavn: string | null; etternavn: string | null }) => [p.fornavn, p.etternavn].filter(Boolean).join(" ");

// Det som blir endret på en som finnes (arbeidsforholdet slik det er rapportert).
function endringer(p: Person, k: Kjent): string[] {
  const af = p.arbeidsforhold;
  if (!af) return [];
  const e: string[] = [];
  if (af.startdato && af.startdato !== k.ansatt_fra) e.push(`ansatt fra ${dato(k.ansatt_fra)} → ${dato(af.startdato)}`);
  if (af.stillingsprosent && af.stillingsprosent <= 100 && af.stillingsprosent !== k.stillingsprosent)
    e.push(`stilling ${kr.format(k.stillingsprosent)} % → ${kr.format(af.stillingsprosent)} %`);
  if (af.yrkeskode && af.yrkeskode !== k.yrkeskode) e.push(`yrkeskode ${k.yrkeskode ? kode(k.yrkeskode) : "–"} → ${kode(af.yrkeskode)}`);
  if (af.id && af.id !== (k.arbeidsforhold_id ?? String(k.ansattnummer))) e.push(`arbeidsforholdID ${af.id}`);
  if (!k.har_fnr) e.push("fødselsnummeret");
  return e;
}

// Standardvalget: nye som ikke har sluttet, og de som finnes når noe er annerledes.
const standard = (p: Person): Valg => ({
  med: !p.sluttet && (p.ansatt ? endringer(p, p.ansatt).length > 0 : p.forslag ? true : !p.ansatt_id),
  fornavn: p.fornavn ?? "",
  etternavn: p.etternavn ?? "",
});

export function Aordning({ endret }: { endret: () => void }) {
  const { org } = useKonto();
  const [o, settO] = useState<Oversikt | null>(null);
  const [valg, settValg] = useState<Record<number, Valg>>({});
  const [melding, settMelding] = useState<string | null>(null);
  const h = useHandling();

  const bruk = (x: Oversikt) => {
    settO(x);
    if (x.henting?.status === "klar") settValg(Object.fromEntries((x.henting.personer ?? []).map((p) => [p.nr, standard(p)])));
  };
  useEffect(() => {
    void h.kjor(async () => bruk(await hent<Oversikt>(`/org/${org!.id}/ansatte/aordning`)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [org?.id]);
  // Mens Skatteetaten lager rapporten: spør igjen hvert tredje sekund.
  const venter = o?.henting?.status === "bestilt";
  useEffect(() => {
    if (!venter) return;
    const t = setInterval(async () => {
      try {
        const x = await hent<Oversikt>(`/org/${org!.id}/ansatte/aordning`);
        if (x.henting?.status !== "bestilt") bruk(x);
      } catch {
        // prøver igjen
      }
    }, 3000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [venter, org?.id]);

  const hentNa = () =>
    h.kjor(async () => {
      settMelding(null);
      bruk(await api<Oversikt>("POST", `/org/${org!.id}/ansatte/aordning/hent`));
    });
  const personer = o?.henting?.personer ?? [];
  const valgte = personer.filter((p) => valg[p.nr]?.med);
  const leggInn = () =>
    h.kjor(async () => {
      const r = await api<Oversikt & { antall: { ny: number; oppdatert: number } }>("POST", `/org/${org!.id}/ansatte/aordning/legg-inn`, {
        valgte: valgte.map((p) => {
          const v = valg[p.nr]!;
          const finnes = p.ansatt ?? p.forslag;
          return finnes
            ? { nr: p.nr, handling: "oppdater", ansatt_id: finnes.id }
            : { nr: p.nr, handling: "ny", ...(v.fornavn.trim() ? { fornavn: v.fornavn.trim() } : {}), ...(v.etternavn.trim() ? { etternavn: v.etternavn.trim() } : {}) };
        }),
      });
      bruk(r);
      const deler = [r.antall.ny && `${r.antall.ny} lagt inn`, r.antall.oppdatert && `${r.antall.oppdatert} oppdatert`].filter(Boolean);
      settMelding(`${deler.join(" og ")}. Skattekortene hentes for dem som fikk fødselsnummeret.`);
      endret();
    });

  if (!o) return h.feil ? <Feil melding={h.feil} /> : <Laster />;
  if (!o.tilgjengelig)
    return (
      <div className="aordning">
        <p>Hent de ansatte fra a-meldingene som er sendt fra et annet lønnssystem: arbeidsforholdet, lønnen og fødselsnummeret, uten å skrive dem inn.</p>
        <div className="melding info">
          {o.grunn}{" "}
          <Link to="/innstillinger?fane=lonn&del=skattekort">Gå til Innstillinger → Lønn → Skattekort</Link>
        </div>
      </div>
    );

  const hen = o.henting;
  return (
    <div className="aordning">
      {!hen && (
        <p>
          Henter det de siste månedenes a-meldinger sier om hver person (arbeidsforholdet og lønnen) fra Skatteetaten. Du velger hvem som legges inn før noe lagres.
          Fødselsnumrene legges inn kryptert og vises ikke.
        </p>
      )}
      {hen?.status === "bestilt" && (
        <div className="melding info" role="status">
          <span className="spinner" /> Henter fra Skatteetaten … Det kan ta et par minutter; du får varsel når det er klart.
          {hen.feil && <div className="liten">Siste forsøk feilet: {hen.feil}</div>}
        </div>
      )}
      {hen?.status === "feil" && <div className="melding feil">{hen.feil}</div>}
      {melding && (
        <div className="melding ok" role="status">
          {melding}
        </div>
      )}
      {hen?.personer && hen.status === "klar" && (
        <>
          <p className="dempet liten">
            {hen.personer.length} {hen.personer.length === 1 ? "person" : "personer"}{" "}
            {hen.periode_fra === hen.periode_til
              ? `i a-meldingen for ${maanedTekst(hen.periode_fra)}`
              : `i a-meldingene for ${maanedTekst(hen.periode_fra)}–${maanedTekst(hen.periode_til)}`}
            {hen.hentet ? `, hentet ${dato(hen.hentet.slice(0, 10))}` : ""}.
          </p>
          <ul className="aordning-liste">
            {hen.personer.map((p) => {
              const v = valg[p.nr] ?? standard(p);
              const finnes = p.ansatt ?? p.forslag;
              const e = finnes ? endringer(p, finnes) : [];
              const af = p.arbeidsforhold;
              const lagtInn = !!p.ansatt && !e.length;
              const settV = (x: Partial<Valg>) => settValg((alle) => ({ ...alle, [p.nr]: { ...v, ...x } }));
              return (
                <li key={p.nr} className={v.med ? "valgt" : undefined}>
                  <label className="aordning-valg">
                    <input type="checkbox" checked={v.med} disabled={lagtInn} onChange={(x) => settV({ med: x.target.checked })} />
                    <span>
                      <strong>{finnes ? `${finnes.fornavn} ${finnes.etternavn}` : navn(p) || "Uten navn"}</strong>
                      {p.fodselsdato && <span className="dempet"> · født {dato(p.fodselsdato)}</span>}
                    </span>
                  </label>
                  <div className="aordning-detaljer">
                    {af && (
                      <span>
                        {[
                          af.startdato && `fra ${dato(af.startdato)}`,
                          af.sluttdato && `til ${dato(af.sluttdato)}`,
                          af.stillingsprosent != null && `${kr.format(af.stillingsprosent)} %`,
                          af.yrkeskode && `yrke ${kode(af.yrkeskode)}`,
                          p.lonn?.fastlonn && `fastlønn ${kr.format(p.lonn.fastlonn)} kr (${maanedTekst(p.lonn.maaned)})`,
                          p.lonn?.timelonn && `timelønn ${kr.format(p.lonn.timelonn)} kr`,
                          p.antall_arbeidsforhold > 1 && `${p.antall_arbeidsforhold} arbeidsforhold (det siste brukes)`,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    )}
                    {p.sluttet ? (
                      <span className="merke merke-noytral">Sluttet</span>
                    ) : p.ansatt ? (
                      <span className={`merke ${e.length ? "merke-info" : "merke-ok"}`}>{e.length ? `Finnes (nr. ${p.ansatt.ansattnummer})` : "Lagt inn"}</span>
                    ) : p.forslag ? (
                      <span className="merke merke-info">Samme navn som nr. {p.forslag.ansattnummer}</span>
                    ) : (
                      <span className="merke merke-ok">Ny</span>
                    )}
                  </div>
                  {v.med && finnes && e.length > 0 && <div className="felt-hjelp">Oppdateres: {e.join(", ")}.</div>}
                  {v.med && !finnes && (!p.fornavn || !p.etternavn) && (
                    <div className="rad">
                      <label>
                        Fornavn
                        <input value={v.fornavn} onChange={(x) => settV({ fornavn: x.target.value })} />
                      </label>
                      <label>
                        Etternavn
                        <input value={v.etternavn} onChange={(x) => settV({ etternavn: x.target.value })} />
                      </label>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
          {!hen.personer.length && <p className="dempet">Ingen personer i a-meldingene for perioden.</p>}
        </>
      )}
      <Feil melding={h.feil} />
      <div className="knapper">
        {!!valgte.length && hen?.status === "klar" && (
          <button type="button" className="primar" disabled={h.opptatt} onClick={leggInn}>
            Legg inn {valgte.length === 1 ? "1 person" : `${valgte.length} personer`}
          </button>
        )}
        <button type="button" className={hen ? undefined : "primar"} disabled={h.opptatt || venter} onClick={hentNa}>
          {hen?.status === "feil" ? "Prøv igjen" : hen ? "Hent på nytt" : "Hent fra a-ordningen"}
        </button>
      </div>
    </div>
  );
}
