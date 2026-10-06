// Søkbart valg (produkter, kunder): skriv deler av navn, nummer e.l. for å filtrere, og
// velg med trykk eller piltaster og Enter. Uten søkeord vises alle, så man kan bla.
import { Fragment, useEffect, useId, useMemo, useRef, useState } from "react";
import { kr } from "./format";

export interface SokeValg {
  id: string;
  tittel: string;
  under?: string; // ekstra linje (nummer, pris, e-post …)
  sok?: string; // teksten det søkes i (standard: tittel og under)
}

type Rad = { type: "tom" } | { type: "valg"; v: SokeValg } | { type: "ny" };

export function Sokefelt({ valg, verdi, velg, plassholder, tom, ny, etikett, maks = 100 }: {
  valg: SokeValg[];
  verdi: string | null;
  velg: (id: string | null) => void;
  plassholder?: string;
  tom?: string; // valg uten verdi, f.eks. «Fritekst»
  ny?: { tekst: string; handling: (sok: string) => void }; // f.eks. «+ Nytt produkt»
  etikett?: string;
  maks?: number;
}) {
  const id = useId();
  const valgt = valg.find((v) => v.id === verdi) ?? null;
  const [sok, settSok] = useState<string | null>(null); // null: viser det som er valgt
  const [apen, settApen] = useState(false);
  const [aktiv, settAktiv] = useState(0);
  const inn = useRef<HTMLInputElement>(null);
  const liste = useRef<HTMLUListElement>(null);

  const ord = (sok ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const treff = useMemo(() => {
    const t = valg.filter((v) => {
      const tekst = (v.sok ?? `${v.tittel} ${v.under ?? ""}`).toLowerCase();
      return ord.every((o) => tekst.includes(o));
    });
    // Treff der navnet begynner med søket, først.
    if (ord.length) t.sort((a, b) => Number(!a.tittel.toLowerCase().startsWith(ord[0]!)) - Number(!b.tittel.toLowerCase().startsWith(ord[0]!)));
    return t.slice(0, maks);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [valg, sok, maks]);
  const rader: Rad[] = [...(tom && !ord.length ? [{ type: "tom" as const }] : []), ...treff.map((v) => ({ type: "valg" as const, v })), ...(ny ? [{ type: "ny" as const }] : [])];

  // Hold det markerte valget synlig når man blar med piltastene.
  useEffect(() => {
    if (apen) document.getElementById(`${id}-${aktiv}`)?.scrollIntoView({ block: "nearest" });
  }, [aktiv, apen, id]);

  const apne = () => {
    const i = rader.findIndex((r) => r.type === "valg" && r.v.id === verdi);
    settAktiv(i >= 0 ? i : 0);
    settApen(true);
  };
  const lukk = () => {
    settApen(false);
    settSok(null);
  };
  const bruk = (r: Rad | undefined) => {
    if (!r) return;
    if (r.type === "tom") velg(null);
    else if (r.type === "valg") velg(r.v.id);
    else ny!.handling((sok ?? "").trim());
    lukk();
  };

  return (
    <div className="sokefelt">
      <input
        ref={inn}
        role="combobox"
        aria-label={etikett}
        aria-expanded={apen}
        aria-controls={`${id}-liste`}
        aria-autocomplete="list"
        aria-activedescendant={apen && rader[aktiv] ? `${id}-${aktiv}` : undefined}
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        value={sok ?? valgt?.tittel ?? ""}
        placeholder={plassholder ?? tom}
        onFocus={(e) => {
          e.target.select();
          apne();
          // Mobil: flytt feltet opp, så lista ikke havner bak tastaturet.
          if (window.matchMedia("(max-width: 700px)").matches) setTimeout(() => inn.current?.scrollIntoView({ block: "start", behavior: "smooth" }), 250);
        }}
        onChange={(e) => {
          settSok(e.target.value);
          settApen(true);
          settAktiv(0);
        }}
        onBlur={lukk}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            if (!apen) return apne();
            settAktiv((i) => Math.max(0, Math.min(rader.length - 1, i + (e.key === "ArrowDown" ? 1 : -1))));
          } else if (e.key === "Enter" && apen) {
            e.preventDefault();
            bruk(rader[aktiv]);
          } else if (e.key === "Escape" && apen) {
            // Ikke lukk dialogen feltet ligger i.
            e.preventDefault();
            e.stopPropagation();
            lukk();
          }
        }}
      />
      {apen && (
        <ul id={`${id}-liste`} ref={liste} role="listbox" className="sokefelt-liste">
          {rader.map((r, i) => (
            <Fragment key={r.type === "valg" ? r.v.id : r.type}>
              {r.type === "ny" && ord.length > 0 && treff.length === 0 && <li className="ingen">Ingen treff</li>}
              <li
                id={`${id}-${i}`}
                role="option"
                aria-selected={i === aktiv}
                className={r.type === "ny" ? "ny" : r.type === "tom" ? "tom" : r.type === "valg" && r.v.id === verdi ? "valgt" : undefined}
                // Ikke mist fokus før valget er registrert.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => bruk(r)}
              >
                {r.type === "valg" ? (
                  <>
                    <span className="tittel">{r.v.tittel}</span>
                    {r.v.under && <span className="under">{r.v.under}</span>}
                  </>
                ) : r.type === "tom" ? (
                  <span className="tittel">{tom}</span>
                ) : (
                  <span className="tittel">
                    {ny!.tekst}
                    {sok?.trim() ? ` «${sok.trim()}»` : ""}
                  </span>
                )}
              </li>
            </Fragment>
          ))}
          {!ny && ord.length > 0 && treff.length === 0 && <li className="ingen">Ingen treff</li>}
        </ul>
      )}
    </div>
  );
}

// Valg for produkter og kunder, med det det er naturlig å søke på.
export const produktValg = (produkter: any[]): SokeValg[] =>
  produkter.map((p) => ({
    id: p.id,
    tittel: p.navn,
    under: [p.varenummer ? `Nr. ${p.varenummer}` : null, `${kr(p.enhetspris)} per ${p.enhet}`].filter(Boolean).join(" · "),
    sok: `${p.navn} ${p.varenummer ?? ""} ${p.beskrivelse ?? ""}`,
  }));

export const kundeValg = (kunder: any[]): SokeValg[] =>
  kunder.map((k) => ({
    id: k.id,
    tittel: k.navn,
    under: [`Kundenr. ${k.kundenummer}`, k.orgnr ? `org.nr. ${k.orgnr}` : null, k.epost].filter(Boolean).join(" · "),
    sok: `${k.navn} ${k.kundenummer} ${k.orgnr ?? ""} ${k.epost ?? ""}`,
  }));
