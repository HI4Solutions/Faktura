// Yrkeskoden i a-meldingen: søk i SSBs yrkeskatalog på yrket (eller skriv koden, 7 siffer).
// Koden som er valgt, vises med navnet; en kode som ikke finnes i katalogen, gir en advarsel
// (a-meldingen avvises da). Katalogen hentes av serveren (server/src/yrkeskoder.ts).
import { useEffect, useId, useRef, useState } from "react";
import { hent } from "../api";
import { useKonto } from "../konto";

type Yrke = { kode: string; navn: string };
const visKode = (k: string) => `${k.slice(0, 4)} ${k.slice(4)}`;

export function YrkeskodeFelt({ verdi, endre, disabled }: { verdi: string; endre: (kode: string) => void; disabled?: boolean }) {
  const { org } = useKonto();
  const id = useId();
  const [sok, settSok] = useState<string | null>(null); // null: viser koden som er valgt
  const [treff, settTreff] = useState<Yrke[]>([]);
  const [apen, settApen] = useState(false);
  const [aktiv, settAktiv] = useState(0);
  const [navn, settNavn] = useState<{ kode: string; navn: string | null } | null>(null);
  const [feil, settFeil] = useState<string | null>(null);
  const kode = verdi.replace(/\s/g, "");
  const tidtaker = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Navnet på koden som er valgt (og om den finnes i katalogen).
  useEffect(() => {
    if (!/^\d{7}$/.test(kode) || navn?.kode === kode) return;
    let aktuell = true;
    hent<{ yrker: Yrke[] }>(`/org/${org!.id}/ansatte/yrkeskoder?kode=${kode}`)
      .then((r) => aktuell && settNavn({ kode, navn: r.yrker[0]?.navn ?? null }))
      .catch(() => undefined);
    return () => {
      aktuell = false;
    };
  }, [kode, org, navn?.kode]);

  const sokEtter = (tekst: string) => {
    clearTimeout(tidtaker.current);
    if (!tekst.trim()) return settTreff([]);
    tidtaker.current = setTimeout(async () => {
      try {
        const r = await hent<{ yrker: Yrke[] }>(`/org/${org!.id}/ansatte/yrkeskoder?sok=${encodeURIComponent(tekst.trim())}`);
        settTreff(r.yrker);
        settAktiv(0);
        settFeil(null);
      } catch (e) {
        settFeil((e as Error).message);
      }
    }, 200);
  };
  const velg = (y: Yrke) => {
    endre(y.kode);
    settNavn({ kode: y.kode, navn: y.navn });
    settSok(null);
    settApen(false);
  };

  const ukjent = /^\d{7}$/.test(kode) && navn?.kode === kode && navn.navn === null;
  const visning = /^\d{7}$/.test(kode) ? `${visKode(kode)}${navn?.kode === kode && navn.navn ? ` – ${navn.navn}` : ""}` : verdi;

  return (
    <>
      <div className="sokefelt">
        <input
          id="felt-yrkeskode"
          role="combobox"
          aria-expanded={apen}
          aria-controls={`${id}-liste`}
          aria-autocomplete="list"
          aria-activedescendant={apen && treff[aktiv] ? `${id}-${aktiv}` : undefined}
          aria-invalid={ukjent || undefined}
          autoComplete="off"
          spellCheck={false}
          disabled={disabled}
          placeholder="Søk på yrket, f.eks. sykepleier"
          value={sok ?? visning}
          onFocus={(e) => e.target.select()}
          onChange={(e) => {
            const t = e.target.value;
            settSok(t);
            settApen(true);
            // Sju siffer er en kode (skrevet inn eller limt inn); ellers søkes det.
            const siffer = t.replace(/\s/g, "");
            if (/^\d{7}$/.test(siffer)) endre(siffer);
            else if (!t.trim()) endre("");
            sokEtter(t);
          }}
          onBlur={() => {
            settApen(false);
            settSok(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              settApen(true);
              settAktiv((i) => Math.max(0, Math.min(treff.length - 1, i + (e.key === "ArrowDown" ? 1 : -1))));
            } else if (e.key === "Enter" && apen && treff[aktiv]) {
              e.preventDefault();
              velg(treff[aktiv]!);
            } else if (e.key === "Escape" && apen) {
              e.preventDefault();
              e.stopPropagation();
              settApen(false);
            }
          }}
        />
        {apen && sok?.trim() && (
          <ul id={`${id}-liste`} role="listbox" className="sokefelt-liste">
            {treff.map((y, i) => (
              <li key={y.kode} id={`${id}-${i}`} role="option" aria-selected={i === aktiv} onMouseDown={(e) => e.preventDefault()} onClick={() => velg(y)}>
                <span className="tittel">{y.navn}</span>
                <span className="under">{visKode(y.kode)}</span>
              </li>
            ))}
            {!treff.length && <li className="ingen">{feil ?? "Ingen treff"}</li>}
          </ul>
        )}
      </div>
      {/* Utenfor søkefeltet, så lista legger seg rett under feltet. */}
      {ukjent ? (
        <span className="felt-feil">Koden finnes ikke i SSBs yrkeskatalog, og a-meldingen blir avvist med den. Søk på yrket.</span>
      ) : (
        <span className="felt-hjelp">Søk på yrket (arbeidsoppgavene), eller skriv koden (7 siffer) fra SSBs yrkeskatalog.</span>
      )}
    </>
  );
}
