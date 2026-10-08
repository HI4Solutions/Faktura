// Uker og klokkeslett for timeføringen og vaktplanen: ISO-uker (mandag–søndag, uke 1 er uka
// med 4. januar), datoer som «Man. 5. okt.», timer som «7,5 t» og ukevelgeren.
import { useEffect, useRef, useState, type InputHTMLAttributes } from "react";
import { iDag, leggTilDager } from "./format";
import { IkonHoyre, IkonVenstre } from "./ikoner";

export const tallformat = new Intl.NumberFormat("nb-NO", { maximumFractionDigits: 2 });
export const timer = (n: number) => `${tallformat.format(n)} t`;

export const middag = (iso: string) => new Date(`${iso}T12:00:00Z`);
export const gyldigDato = (s: string | null): s is string => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s) && middag(s).toISOString().slice(0, 10) === s;
export const mandag = (iso: string) => leggTilDager(iso, -((middag(iso).getUTCDay() + 6) % 7));
export const ukedager = (man: string) => [0, 1, 2, 3, 4, 5, 6].map((i) => leggTilDager(man, i));

export function ukenr(iso: string) {
  const man = mandag(iso);
  const aar = middag(leggTilDager(man, 3)).getUTCFullYear(); // torsdagen bestemmer året
  const forste = mandag(`${aar}-01-04`);
  return { aar, uke: Math.round((middag(man).getTime() - middag(forste).getTime()) / (7 * 86_400_000)) + 1 };
}

const dagFormat = new Intl.DateTimeFormat("nb-NO", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
export const ukedagFormat = new Intl.DateTimeFormat("nb-NO", { weekday: "short", timeZone: "UTC" });
const periodeFormat = new Intl.DateTimeFormat("nb-NO", { day: "numeric", month: "short", timeZone: "UTC" });

// «Man. 5. okt.» (stor forbokstav bare i ukedagen).
export const visDag = (iso: string) => {
  const t = dagFormat.format(middag(iso));
  return t.charAt(0).toUpperCase() + t.slice(1);
};

function visPeriode(fra: string, til: string) {
  try {
    return periodeFormat.formatRange(middag(fra), middag(til));
  } catch {
    return `${periodeFormat.format(middag(fra))}–${periodeFormat.format(middag(til))}`;
  }
}

// «5.–11. okt.», med året når uka ikke er i år.
export function ukePeriode(man: string) {
  const { aar } = ukenr(man);
  return `${visPeriode(man, leggTilDager(man, 6))}${aar !== Number(iDag().slice(0, 4)) ? ` ${aar}` : ""}`;
}

// Timene mellom fra og til (over midnatt når til er før fra), minus pausen. Som i databasen.
export function regnTimer(fra: string, til: string, pause: number) {
  const min = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
  let m = min(til) - min(fra);
  if (m <= 0) m += 24 * 60;
  return (m - pause) / 60;
}

// Klokkeslett som skrives inn: «8» og «08» → 08:00, «830» → 08:30, «1630» → 16:30, og «8.30»,
// «8,30» og «8:30» → 08:30. null: ikke et klokkeslett.
export function tolkKlokke(s: string): string | null {
  const t = s.trim().replace(/[.,]/g, ":");
  let x = /^(\d{1,2}):(\d{1,2})$/.exec(t);
  let h: number;
  let m: number;
  if (x) {
    h = Number(x[1]);
    m = Number(x[2]);
  } else if ((x = /^\d{1,4}$/.exec(t))) {
    h = Number(t.length <= 2 ? t : t.slice(0, t.length - 2));
    m = t.length <= 2 ? 0 : Number(t.slice(-2));
  } else return null;
  if (h > 23 || m > 59) return null;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

// Klokkeslett i 24-timersformat (TT:MM), uansett språket på enheten (<input type="time"> viser
// AM/PM på enheter med engelsk språk). Feltet tolker det som skrives (tolkKlokke) og gir
// klokkeslettet videre med en gang; teksten ryddes når man går ut av feltet.
export function Klokkeslett({
  value,
  onChange,
  className,
  placeholder,
  ...rest
}: { value: string; onChange: (klokke: string) => void } & Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "type">) {
  const [tekst, settTekst] = useState(value);
  const [fokus, settFokus] = useState(false);
  const iFokus = useRef(false);
  // Endres klokkeslettet utenfra (f.eks. fra vakten), vises det, men ikke mens man skriver.
  useEffect(() => {
    if (!iFokus.current) settTekst(value);
  }, [value]);
  const ugyldig = !fokus && tekst.trim() !== "" && tolkKlokke(tekst) === null;
  return (
    <input
      {...rest}
      type="text"
      inputMode="decimal"
      autoComplete="off"
      spellCheck={false}
      maxLength={5}
      placeholder={placeholder ?? "tt:mm"}
      className={["klokkeslett", className].filter(Boolean).join(" ")}
      aria-invalid={ugyldig || undefined}
      title={ugyldig ? "Skriv klokkeslettet som TT:MM, f.eks. 08:30" : rest.title}
      value={tekst}
      onFocus={(e) => {
        iFokus.current = true;
        settFokus(true);
        rest.onFocus?.(e);
      }}
      onChange={(e) => {
        const t = e.target.value.replace(/[^\d:.,]/g, "");
        settTekst(t);
        onChange(tolkKlokke(t) ?? t);
      }}
      onBlur={(e) => {
        iFokus.current = false;
        settFokus(false);
        const n = tolkKlokke(tekst);
        if (n) {
          settTekst(n);
          onChange(n);
        }
        rest.onBlur?.(e);
      }}
    />
  );
}

export function Ukevelger({ uke, velgUke }: { uke: string; velgUke: (mandag: string) => void }) {
  const denne = mandag(iDag());
  return (
    <div className="ukevelger">
      <button type="button" className="ikon" aria-label="Forrige uke" title="Forrige uke" onClick={() => velgUke(leggTilDager(uke, -7))}>
        <IkonVenstre storrelse={20} />
      </button>
      <div className="uke-navn" aria-live="polite">
        <strong>Uke {ukenr(uke).uke}</strong>
        <span>{ukePeriode(uke)}</span>
      </div>
      <button type="button" className="ikon" aria-label="Neste uke" title="Neste uke" onClick={() => velgUke(leggTilDager(uke, 7))}>
        <IkonHoyre storrelse={20} />
      </button>
      {uke !== denne && (
        <button type="button" className="lenke" onClick={() => velgUke(denne)}>
          Denne uka
        </button>
      )}
    </div>
  );
}
