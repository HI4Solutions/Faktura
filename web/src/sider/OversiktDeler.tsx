// Delene oversiktene er bygget av: hilsenen øverst, nøkkeltallene (et tall med en forklaring under,
// og som lenke når det finnes en side for det) og «Til oppfølging» (det som venter, med lenke dit).
// Brukes av oversikten for organisasjonen (Oversikt.tsx), for den ansatte (AnsattOversikt.tsx) og
// for plattformen (Admin.tsx).
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Laster, Tom } from "../felles";
import { IkonHake, IkonHoyre } from "../ikoner";

// «God morgen, Kari» (norsk tid): natt til kl. 5, morgen til 10, dag til 18, så kveld.
export function hilsen(navn: string | null | undefined): string {
  const time = Number(new Intl.DateTimeFormat("nb-NO", { hour: "numeric", hourCycle: "h23", timeZone: "Europe/Oslo" }).format(new Date()));
  const hei = time < 5 ? "God natt" : time < 10 ? "God morgen" : time < 18 ? "God dag" : "God kveld";
  const fornavn = (navn ?? "").trim().split(/\s+/)[0];
  return fornavn ? `${hei}, ${fornavn}` : hei;
}

// Ett nøkkeltall. Med til: hele kortet er en lenke til siden tallet hører til.
export function Tall({
  ikon,
  tone,
  etikett,
  verdi,
  under,
  til,
}: {
  ikon: ReactNode;
  tone?: "fare" | "ok" | "noytral";
  etikett: string;
  verdi: ReactNode;
  under?: ReactNode;
  til?: string;
}) {
  const innhold = (
    <>
      <div className="etikett">
        <span className={`ikonboks${tone ? ` ${tone}` : ""}`}>{ikon}</span> {etikett}
      </div>
      <div className="verdi">{verdi}</div>
      {under != null && <div className="under">{under}</div>}
    </>
  );
  return til ? (
    <Link to={til} className="kort tall-lenke">
      {innhold}
    </Link>
  ) : (
    <div className="kort">{innhold}</div>
  );
}

// Det som venter, én linje per ting, med lenke dit. fare: haster (f.eks. forfalt eller avvist). På
// smale skjermer kommer kortet først i raden når noe venter (styles.css).
export type Oppgave = { nokkel: string; tekst: ReactNode; til: string; fare?: boolean };

export function Oppfolging({
  oppgaver,
  laster = false,
  tittel = "Til oppfølging",
  tomt = "Ingenting venter på deg nå.",
}: {
  oppgaver: Oppgave[];
  laster?: boolean;
  tittel?: string;
  tomt?: string;
}) {
  return (
    <div className={`kort oppfolging${oppgaver.length ? " har-oppgaver" : ""}`}>
      <div className="kort-topp">
        <h2>{tittel}</h2>
        {oppgaver.length > 0 && <span className="teller">{oppgaver.length}</span>}
      </div>
      {oppgaver.length ? (
        <ul className="liste-enkel">
          {oppgaver.map((o) => (
            <li key={o.nokkel}>
              <Link to={o.til} className={`oppfolging-punkt${o.fare ? " fare" : ""}`}>
                <span>{o.tekst}</span>
                <IkonHoyre storrelse={16} />
              </Link>
            </li>
          ))}
        </ul>
      ) : laster ? (
        <Laster />
      ) : (
        <Tom ikon={<IkonHake />} tittel={tomt} />
      )}
    </div>
  );
}

// «1 uke», «3 uker»: tallet med entall eller flertall.
export const antall = (n: number, en: string, flere: string) => `${n} ${n === 1 ? en : flere}`;
