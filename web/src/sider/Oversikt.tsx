import { useNavigate } from "react-router-dom";
import { hent } from "../api";
import { Feil, Laster, useData } from "../felles";
import { useKonto } from "../konto";
import { kr } from "../format";
import { Fakturatabell } from "./Fakturaer";

export function Oversikt() {
  const { org, meg, velgOrg } = useKonto();
  const nav = useNavigate();
  const { data, feil } = useData(() => hent<any[]>(`/org/${org!.id}/fakturaer`), [org?.id]);

  // Regnskapsbyrå: felles oversikt over klientene.
  if (org?.type === "regnskapsbyraa") {
    const klienter = (meg?.organisasjoner ?? []).filter((o) => !o.direkte_medlem);
    return (
      <>
        <h1>Klienter</h1>
        <p className="dempet">Klienter som har gitt {org.navn} tilgang. Velg en klient for å se fakturaene.</p>
        <div className="kort tabell">
          <table>
            <thead>
              <tr>
                <th>Klient</th>
                <th>Org.nr.</th>
                <th>Tilgang</th>
              </tr>
            </thead>
            <tbody>
              {klienter.map((k) => (
                <tr
                  key={k.id}
                  className="klikkbar"
                  onClick={() => {
                    velgOrg(k.id);
                    nav("/fakturaer");
                  }}
                >
                  <td>{k.navn}</td>
                  <td>{k.orgnr}</td>
                  <td>{k.rolle === "regnskap" ? "Les og bokfør" : "Les"}</td>
                </tr>
              ))}
              {klienter.length === 0 && (
                <tr>
                  <td colSpan={3} className="dempet">
                    Ingen klienter ennå. Be om tilgang under Innstillinger, eller be klienten invitere byrået.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </>
    );
  }

  if (feil) return <Feil melding={feil} />;
  if (!data) return <Laster />;

  const fakturaer = data.filter((f) => f.type === "faktura");
  const utestaende = fakturaer.filter((f) => f.status === "utstedt");
  const sumUte = utestaende.reduce((s, f) => s + f.sum_inkl_mva - f.kreditert_belop - f.betalt_belop, 0);
  const forfalt = utestaende.filter((f) => f.forfalt);
  const sumForfalt = forfalt.reduce((s, f) => s + f.sum_inkl_mva - f.kreditert_belop - f.betalt_belop, 0);
  const maaned = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Oslo" }).format(new Date()).slice(0, 7);
  const fakturertMnd = fakturaer.filter((f) => f.status !== "utkast" && (f.fakturadato ?? "").startsWith(maaned)).reduce((s, f) => s + f.sum_inkl_mva, 0);
  const utkast = data.filter((f) => f.status === "utkast");

  return (
    <>
      <h1>Oversikt</h1>
      {org?.verifisering === "ny" && (
        <div className="melding info">
          Organisasjonen er ikke verifisert ennå. Til den er det, kan dere sende opptil 20 fakturaer og 50 000 kr per måned.
        </div>
      )}
      <div className="nokkeltall">
        <div className="kort">
          <div className="dempet liten">Utestående</div>
          <div className="verdi">{kr(sumUte)}</div>
          <div className="dempet liten">{utestaende.length} fakturaer</div>
        </div>
        <div className="kort">
          <div className="dempet liten">Forfalt</div>
          <div className="verdi" style={{ color: forfalt.length ? "var(--fare)" : undefined }}>
            {kr(sumForfalt)}
          </div>
          <div className="dempet liten">{forfalt.length} fakturaer</div>
        </div>
        <div className="kort">
          <div className="dempet liten">Fakturert denne måneden</div>
          <div className="verdi">{kr(fakturertMnd)}</div>
        </div>
        <div className="kort">
          <div className="dempet liten">Utkast</div>
          <div className="verdi">{utkast.length}</div>
        </div>
      </div>
      <h2>Siste fakturaer</h2>
      <Fakturatabell rader={data.slice(0, 10)} klikk={(id) => nav(`/fakturaer/${id}`)} />
    </>
  );
}
