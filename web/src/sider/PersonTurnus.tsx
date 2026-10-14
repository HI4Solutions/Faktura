// Turnus for én person (Turnus.tsx, «Turnus for»): kalenderen uke for uke med vakten hver dag
// (koden i fargen til vakttypen og klokkeslettene), fraværet og de faste dagene, og hvem personen er
// på jobb sammen med: de andre som har en vakt eller fast dag som overlapper minst en time (også over
// midnatt). Trykk på en dag for hele dagen: hvem som går sammen med personen, hvem som går de andre
// vaktene og hvem som er borte. De ansatte ser bare sin egen kalender (og hele turnusen), med det
// publiserte og andres fravær bare som «F», som ellers i vaktplanen. Eier og administrator kan åpne
// kalenderen til hvem som helst (trykk på et navn), ser også utkastene og kan endre vakten fra dagen.
import { useState, type ReactNode } from "react";
import { Dialog } from "../felles";
import { iDag } from "../format";
import { helligdag } from "../helligdager";
import { erHelg, mandag, tallformat, ukenr, visDag } from "../uke";
import { fravaerKlasse, fravaerKode, fravaerTekst, type FravaerType } from "./Fravaer";
import { FARGER, VakttypeMerke, type Vakttype } from "./Turnus";
import type { Vakt, VaktSvar } from "./Vakter";

export type PersonInfo = { id: string; fornavn: string; etternavn: string; forkortelse?: string | null; ansatt_fra: string; ansatt_til: string | null };

// En vakt eller en fast arbeidsdag (ikke de som er borte), med starten og slutten i minutter (over
// midnatt slutter den neste dag). En hel fast dag regnes som 08–16.
type Arbeid = { ansatt_id: string; dato: string; fra: string | null; til: string | null; timer: number; vakt: Vakt | null; start: number; slutt: number };

const SAMMEN = 60; // så mange minutter må vaktene overlappe for at to er på jobb sammen
const UKEDAGER = ["Ma", "Ti", "On", "To", "Fr", "Lø", "Sø"];
const minutter = (kl: string) => Number(kl.slice(0, 2)) * 60 + Number(kl.slice(3, 5));
const dagnr = (iso: string) => Math.round(Date.parse(`${iso}T12:00:00Z`) / 86_400_000);
const tid = (a: { fra: string | null; til: string | null }) => (a.fra && a.til ? `${a.fra}–${a.til}` : "hel dag");
const kort = (a: { fra: string | null; til: string | null }) => (a.fra && a.til ? `${a.fra.slice(0, 2)}–${a.til.slice(0, 2)}` : "Hel dag");
const navn = (p: PersonInfo) => `${p.fornavn} ${p.etternavn}`;
const forkortelse = (p: PersonInfo) => p.forkortelse || `${p.fornavn.charAt(0)}${p.etternavn.charAt(0)}`.toUpperCase();

function arbeidet(data: VaktSvar): Arbeid[] {
  const ut: Arbeid[] = [];
  const legg = (ansatt_id: string, dato: string, fra: string | null, til: string | null, timer: number, vakt: Vakt | null) => {
    const f = fra ? minutter(fra) : 8 * 60;
    let s = til ? minutter(til) : 16 * 60;
    if (s <= f) s += 24 * 60;
    ut.push({ ansatt_id, dato, fra, til, timer: Number(timer), vakt, start: dagnr(dato) * 1440 + f, slutt: dagnr(dato) * 1440 + s });
  };
  for (const v of data.vakter) if (v.ansatt_id && !v.fravaer) legg(v.ansatt_id, v.dato, v.fra, v.til, v.timer, v);
  for (const f of data.faste ?? []) if (!f.fravaer) legg(f.ansatt_id, f.dato, f.fra, f.til, f.timer, null);
  return ut.sort((a, b) => a.start - b.start);
}

export function PersonTurnus({
  person,
  dager,
  data,
  personer,
  typeAv,
  velgPerson,
  endre,
}: {
  person: PersonInfo;
  dager: string[]; // hele uker
  data: VaktSvar;
  personer: PersonInfo[];
  typeAv: Map<string, Vakttype>;
  velgPerson?: (id: string) => void; // eier og administrator: kalenderen til en annen
  endre?: (ansatt: string, dato: string) => void; // eier og administrator: valget i ruten
}) {
  const [dag, settDag] = useState<string | null>(null);
  const idag = iDag();
  const alt = arbeidet(data);
  const hvem = new Map(personer.map((p) => [p.id, p]));
  const navnPaa = (a: Arbeid) => {
    const p = hvem.get(a.ansatt_id);
    return p ? navn(p) : (a.vakt?.ansatt_navn ?? "");
  };
  const egne = (d: string) => alt.filter((a) => a.ansatt_id === person.id && a.dato === d);
  const borte = (a: string, d: string) => (data.fravaer.find((f) => f.ansatt_id === a && f.fra <= d && f.til >= d)?.type ?? null) as FravaerType | null;
  // De andre som er på jobb samtidig med personen den dagen (minst en time), i rekkefølgen de begynner.
  const sammenMed = (d: string) => {
    const mine = egne(d);
    const ut = new Map<string, Arbeid>();
    for (const x of alt) {
      if (x.ansatt_id === person.id || ut.has(x.ansatt_id) || !navnPaa(x)) continue;
      if (mine.some((m) => Math.min(m.slutt, x.slutt) - Math.max(m.start, x.start) >= SAMMEN)) ut.set(x.ansatt_id, x);
    }
    return [...ut.values()];
  };

  // Oppsummeringen for perioden: vaktene per vakttype, timene og helgene.
  const iPerioden = alt.filter((a) => a.ansatt_id === person.id && a.dato >= dager[0]! && a.dato <= dager[dager.length - 1]!);
  const perType = new Map<string, number>();
  for (const a of iPerioden) if (a.vakt?.vakttype_id) perType.set(a.vakt.vakttype_id, (perType.get(a.vakt.vakttype_id) ?? 0) + 1);
  const helger = new Set(iPerioden.filter((a) => erHelg(a.dato)).map((a) => mandag(a.dato))).size;
  const timerSum = iPerioden.reduce((s, a) => s + a.timer, 0);

  const uker = Array.from({ length: dager.length / 7 }, (_, i) => dager.slice(i * 7, i * 7 + 7));
  const merke = (a: Arbeid) => {
    const t = a.vakt?.vakttype_id ? typeAv.get(a.vakt.vakttype_id) : undefined;
    return t ? <VakttypeMerke t={t} tittel={t.navn} /> : <span className="vt-merke tom">{a.vakt ? kort(a) : "Fast"}</span>;
  };
  const beskriv = (a: Arbeid) => {
    const t = a.vakt?.vakttype_id ? typeAv.get(a.vakt.vakttype_id) : undefined;
    return `${t ? t.navn : a.vakt ? "Vakt" : "Fast arbeidsdag"} ${tid(a)}${a.vakt && !a.vakt.publisert ? " (ikke publisert)" : ""}`;
  };

  return (
    <>
      <div className="pt-topp" aria-live="polite">
        <strong>{navn(person)}</strong>
        <span>
          {iPerioden.length} {iPerioden.length === 1 ? "vakt" : "vakter"} · {tallformat.format(Math.round(timerSum * 100) / 100)} timer
          {helger > 0 && ` · ${helger} ${helger === 1 ? "helg" : "helger"}`}
        </span>
        {perType.size > 0 && (
          <span className="pt-typer">
            {[...typeAv.values()]
              .filter((t) => perType.has(t.id))
              .map((t) => (
                <span key={t.id}>
                  <VakttypeMerke t={t} tittel={t.navn} /> {perType.get(t.id)}
                </span>
              ))}
          </span>
        )}
      </div>
      <div className="kort pt-kort">
        <table className="pt-kalender">
          <thead>
            <tr>
              <th className="pt-uke">
                <span className="sr-only">Uke</span>
              </th>
              {UKEDAGER.map((u) => (
                <th key={u} scope="col">
                  {u}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {uker.map((u) => (
              <tr key={u[0]}>
                <th className="pt-uke" scope="row" title={`Uke ${ukenr(u[0]!).uke}`}>
                  {ukenr(u[0]!).uke}
                </th>
                {u.map((d) => {
                  const mine = egne(d);
                  const fravaer = borte(person.id, d);
                  const med = mine.length && !fravaer ? sammenMed(d) : [];
                  const utenfor = d < person.ansatt_fra || (!!person.ansatt_til && d > person.ansatt_til);
                  const hellig = helligdag(d);
                  const tekst =
                    `${visDag(d)}${hellig ? ` (${hellig})` : ""}: ` +
                    (fravaer ? fravaerTekst[fravaer] : mine.length ? mine.map(beskriv).join(", ") : "fri") +
                    (med.length ? `, sammen med ${med.map(navnPaa).join(", ")}` : "");
                  return (
                    <td key={d} className={`${erHelg(d) || hellig ? "helg" : ""}${d === idag ? " idag" : ""}${utenfor ? " utenfor" : ""}`}>
                      <button type="button" className="pt-dag" aria-label={tekst} title={tekst} onClick={() => settDag(d)}>
                        <span className={`pt-dato${hellig ? " helligdag" : ""}`}>{Number(d.slice(8, 10))}</span>
                        {fravaer ? (
                          <span className={`pt-vakt ${fravaerKlasse[fravaer]}`}>
                            <b>{fravaerKode[fravaer]}</b>
                          </span>
                        ) : (
                          mine.map((a) => {
                            const t = a.vakt?.vakttype_id ? typeAv.get(a.vakt.vakttype_id) : undefined;
                            return (
                              <span
                                key={`${a.start}-${a.vakt?.id ?? "fast"}`}
                                className={`pt-vakt${t ? ` vt vt${t.farge % FARGER}` : a.vakt ? "" : " fast"}${a.vakt && !a.vakt.publisert ? " utkast" : ""}`}
                              >
                                <b>{t ? t.kode : a.vakt ? kort(a) : "Fast"}</b>
                                {(t || !a.vakt) && <span className="pt-tid">{kort(a)}</span>}
                              </span>
                            );
                          })
                        )}
                        {med.length > 0 && (
                          <span className="pt-med">
                            {med.slice(0, 3).map((x) => {
                              const p = hvem.get(x.ansatt_id);
                              return (
                                <span key={x.ansatt_id} className="pt-fork">
                                  {p ? forkortelse(p) : navnPaa(x).slice(0, 2)}
                                </span>
                              );
                            })}
                            {med.length > 3 && <span className="pt-fork pluss">+{med.length - 3}</span>}
                          </span>
                        )}
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="liten dempet">
        Under vakten står de som er på jobb samtidig (forkortelsene). Trykk på en dag for å se hvem som går sammen med {person.fornavn}, de andre vaktene og hvem
        som er borte.
      </p>
      <Dialog apen={!!dag} lukk={() => settDag(null)} tittel={dag ? visDag(dag) : ""}>
        {dag && (
          <Dagen
            dato={dag}
            person={person}
            egne={egne(dag)}
            fravaer={borte(person.id, dag)}
            sammen={sammenMed(dag)}
            andre={alt.filter((a) => a.dato === dag && a.ansatt_id !== person.id && !!navnPaa(a))}
            borte={data.fravaer.filter((f) => f.ansatt_id !== person.id && f.fra <= dag && f.til >= dag)}
            navnPaa={navnPaa}
            merke={merke}
            beskriv={beskriv}
            velgPerson={
              velgPerson
                ? (id) => {
                    settDag(null);
                    velgPerson(id);
                  }
                : undefined
            }
            endre={endre ? () => (settDag(null), endre(person.id, dag)) : undefined}
          />
        )}
      </Dialog>
    </>
  );
}

// Hele dagen: personens vakt, de som er på jobb samtidig, de andre vaktene og hvem som er borte.
function Dagen({
  dato,
  person,
  egne,
  fravaer,
  sammen,
  andre,
  borte,
  navnPaa,
  merke,
  beskriv,
  velgPerson,
  endre,
}: {
  dato: string;
  person: PersonInfo;
  egne: Arbeid[];
  fravaer: FravaerType | null;
  sammen: Arbeid[];
  andre: Arbeid[];
  borte: { ansatt_id: string; ansatt_navn?: string | null; type: string }[];
  navnPaa: (a: Arbeid) => string;
  merke: (a: Arbeid) => ReactNode;
  beskriv: (a: Arbeid) => string;
  velgPerson?: (id: string) => void;
  endre?: () => void;
}) {
  const ider = new Set(sammen.map((a) => a.ansatt_id));
  const resten = andre.filter((a) => !ider.has(a.ansatt_id));
  // Navnet åpner kalenderen til personen (eier og administrator), ellers bare navnet.
  const navnet = (id: string, tekst: ReactNode) =>
    velgPerson ? (
      <button type="button" className="lenke" onClick={() => velgPerson(id)} title={`Turnusen til ${tekst}`}>
        {tekst}
      </button>
    ) : (
      <span>{tekst}</span>
    );
  const rad = (a: Arbeid) => (
    <li key={`${a.ansatt_id}-${a.start}`}>
      {merke(a)}
      {navnet(a.ansatt_id, navnPaa(a))}
      <span className="dempet">
        {tid(a)}
        {a.vakt && !a.vakt.publisert ? " · utkast" : ""}
      </span>
    </li>
  );
  const hellig = helligdag(dato);
  return (
    <div className="pt-dagen">
      {hellig && <p className="dempet liten">{hellig}</p>}
      <p>
        <strong>{navn(person)}:</strong>{" "}
        {fravaer ? fravaerTekst[fravaer] : egne.length ? egne.map(beskriv).join(", ") : "fri"}
      </p>
      {!fravaer && egne.length > 0 && (
        <>
          <h3>Sammen med {person.fornavn}</h3>
          {sammen.length ? <ul className="pt-liste">{sammen.map(rad)}</ul> : <p className="dempet">Ingen andre er på jobb samtidig.</p>}
        </>
      )}
      {resten.length > 0 && (
        <>
          <h3>{!fravaer && egne.length ? "Andre på jobb denne dagen" : "På jobb denne dagen"}</h3>
          <ul className="pt-liste">{resten.map(rad)}</ul>
        </>
      )}
      {borte.length > 0 && (
        <>
          <h3>Borte</h3>
          <ul className="pt-liste">
            {borte.map((f) => (
              <li key={`${f.ansatt_id}-${f.type}`}>
                <span className={`vt-merke ${fravaerKlasse[f.type as FravaerType] ?? ""}`}>{fravaerKode[f.type as FravaerType] ?? "F"}</span>
                {navnet(f.ansatt_id, f.ansatt_navn)}
              </li>
            ))}
          </ul>
        </>
      )}
      {endre && (
        <div className="knapper">
          <button type="button" onClick={endre}>
            Endre vakten til {person.fornavn}
          </button>
        </div>
      )}
    </div>
  );
}
