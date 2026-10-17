// Blanketten: rammen rundt innloggingen og de andre skjermene før appen (e-postbekreftelsen og
// ventingen på godkjenning), i samme utseende som nettstedet (landingsside/): skjemahodet med
// logoen, arket med hullrader og bunnen med de juridiske sidene. Stilene ligger i blankett.css.
import { useEffect, type ReactNode } from "react";
import { Logo } from "./Logo";
import { oppdaterTemafarge } from "./tema";
import "./blankett.css";

// Nettstedet: på app.<domene> ligger det på <domene>, og testprosjektets sider i Firebase Hosting
// har det på standardsiden. Ellers ligger appen på nettstedets domene (før appen har flyttet,
// docs/domene.md), med de juridiske sidene ved siden av; da er det ingen egen side å lenke til.
export function nettsted(sted: Pick<Location, "hostname" | "protocol" | "origin"> = window.location): { url: string; eget: boolean } {
  const { hostname, protocol, origin } = sted;
  if (hostname.startsWith("app.")) return { url: `${protocol}//${hostname.slice(4)}`, eget: true };
  if (hostname.endsWith("-app.web.app")) return { url: `${protocol}//${hostname.replace(/-app\.web\.app$/, ".web.app")}`, eget: true };
  return { url: origin, eget: false };
}

const JURIDISK = [
  ["personvern.html", "Personvernerklæring"],
  ["vilkar.html", "Bruksvilkår"],
  ["databehandleravtale.html", "Databehandleravtale"],
  ["underleverandorer.html", "Underleverandører"],
  ["informasjonskapsler.html", "Informasjonskapsler"],
] as const;

// Rammen. `kode` står i skjemahodet og øverst på arket (som «AK-1» på nettstedet), og `handling`
// til høyre i skjemahodet (f.eks. «Opprett konto»).
export function Blankett({ kode, navn, handling, children }: { kode: string; navn: string; handling?: ReactNode; children: ReactNode }) {
  const side = nettsted();
  // Det som vises utenfor siden når man drar forbi kanten, får bordets farge (blankett.css), og
  // nettleseren får papirfargen rundt siden.
  useEffect(() => {
    document.documentElement.classList.add("blankett-side");
    oppdaterTemafarge();
    return () => {
      document.documentElement.classList.remove("blankett-side");
      oppdaterTemafarge();
    };
  }, []);
  return (
    <div className="blankett">
      <header className="bl-topp ark">
        <div className="inn">
          <a className="brand" href={`${side.url}/`} aria-label={side.eget ? "Admin Konsoll, til nettstedet" : "Admin Konsoll"}>
            <Logo storrelse={32} />
          </a>
          <span className="skjemakode" title="Skjemanummer">
            {kode} · {navn}
          </span>
          <div className="act">
            {side.eget && (
              <a className="btn txt" href={`${side.url}/`}>
                Til nettstedet
              </a>
            )}
            {handling}
          </div>
        </div>
      </header>
      <main className="bl-hoved">
        <div className="ark">
          <span className="sidetall" aria-hidden="true">
            {kode} · Side 1 av 1
          </span>
          <div className="inn">{children}</div>
        </div>
      </main>
      <footer className="bl-bunn ark">
        <div className="inn">
          <a className="brand" href={`${side.url}/`} aria-label={side.eget ? "Admin Konsoll, til nettstedet" : "Admin Konsoll"}>
            <Logo storrelse={26} />
          </a>
          <nav aria-label="Juridisk">
            <ul>
              {JURIDISK.map(([fil, tekst]) => (
                <li key={fil}>
                  <a href={`${side.url}/${fil}`} target="_blank" rel="noopener">
                    {tekst}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
          <a className="btn pri kontaktknapp" href={side.eget ? `${side.url}/#kontakt` : "mailto:post@adminkonsoll.no"}>
            Kontakt oss →
          </a>
          <div className="bunnlinje">
            <span>
              © {new Date().getFullYear()} Medinnova AS · Org.nr. 936 564 046 · Olasrudveien 23, 1284 Oslo ·{" "}
              <a href="mailto:post@adminkonsoll.no">post@adminkonsoll.no</a>
            </span>
            <span>Data lagret i EU</span>
          </div>
        </div>
      </footer>
    </div>
  );
}

// Delbåndet øverst på arket: nummeret, overskriften og en kort tekst til høyre.
export function Delband({ nr, tittel, tekst }: { nr: string; tittel: string; tekst?: string }) {
  return (
    <div className="delband">
      <span className="nr">{nr}</span>
      <h1>{tittel}</h1>
      {tekst && <span className="h">{tekst}</span>}
    </div>
  );
}

// Svar på skjemaet, med stempel: feil (rødt), sendt (grønt) eller til orientering (blått).
export function Kvittering({ stempel, farge, children, rolle }: { stempel: string; farge?: "gronn" | "blaa"; children: ReactNode; rolle?: "alert" | "status" }) {
  return (
    <div className="kvittering" role={rolle}>
      <span className={`stempel${farge ? ` ${farge}` : ""}`} aria-hidden="true">
        {stempel}
      </span>
      <p>{children}</p>
    </div>
  );
}

// En enkel skjerm i blanketten (bekreft e-post, venter på godkjenning, navnet): delbåndet med
// overskriften og innholdet under. Knappene i .knapper blir som på nettstedet (blankett.css).
export function EnkelBlankett({ navn, tittel, tekst, nr = "DEL 1", children }: { navn: string; tittel: string; tekst?: string; nr?: string; children: ReactNode }) {
  return (
    <Blankett kode="AK-2" navn={navn}>
      <Delband nr={nr} tittel={tittel} tekst={tekst} />
      <div className="bl-enkel">{children}</div>
    </Blankett>
  );
}
