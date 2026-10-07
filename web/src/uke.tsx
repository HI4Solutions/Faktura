// Uker og klokkeslett for timeføringen og vaktplanen: ISO-uker (mandag–søndag, uke 1 er uka
// med 4. januar), datoer som «Man. 5. okt.», timer som «7,5 t» og ukevelgeren.
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
