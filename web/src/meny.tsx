// Menyen: modulene og sidene i dem (bygges i App.tsx), og menyen på mobil.
//
// PC har sidemenyen i to nivåer (App.tsx). På mobil er det en bunnmeny som står fast: Oversikt,
// opptil tre snarveier og «Meny». Snarveiene er modulene (brukeren velger hvilke), eller sidene
// i modulen når organisasjonen bare har én modul med flere sider (Faktura: Fakturaer, plussen
// for ny faktura og Kunder). En modul i bunnmenyen åpner siden man sist var på i den, og
// modulen man er i, viser sidene sine i et ark. «Meny» (og logoen) åpner menyarket med alle
// modulene og sidene med navn, et søk, kontoen og valget av moduler i bunnmenyen.
import { Fragment, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { IkonLoggUt, IkonLukk } from "./ikoner";

export type MenyIkon = (p: { storrelse?: number }) => ReactNode;
// gruppe: overskriften punktet står under (Regnskap). kort: navnet i bunnmenyen på mobil.
export type MenyPunkt = { til: string; Ikon: MenyIkon; tekst: string; kort?: string; aktiv: boolean; teller?: number; gruppe?: string };
// kort: navnet under ikonet når hovedmenyen på PC er smal.
export type Modul = { id: string; navn: string; kort?: string; Ikon: MenyIkon; punkter: MenyPunkt[]; aktiv: boolean };

export const initialer = (navn: string) =>
  navn
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((d) => d[0]!.toUpperCase())
    .join("");

// Antall nye beskjeder (99+ over det).
export const UlesteTall = ({ n }: { n: number }) => (n > 0 ? <span className="ulest-tall" aria-label={`${n} nye`}>{n > 99 ? "99+" : n}</span> : null);

export const nye = (m: Modul) => m.punkter.reduce((n, x) => n + (x.teller ?? 0), 0);

// --- Bunnmenyen ---------------------------------------------------------------------------

export const MAKS_SNARVEIER = 3;
export type Snarvei = { type: "side"; punkt: MenyPunkt } | { type: "modul"; modul: Modul } | { type: "ny-faktura" };

// Snarveiene mellom Oversikt og «Meny». valgte: modulene brukeren har valgt (null: de første).
export function snarveier(moduler: Modul[], valgte: string[] | null, nyFaktura: boolean): Snarvei[] {
  const alle = moduler.filter((m) => m.id !== "oversikt");
  const flereSider = alle.filter((m) => m.punkter.length > 1);
  if (flereSider.length === 1) {
    const m = flereSider[0]!;
    const side = (x: MenyPunkt | undefined): Snarvei | null => (x ? { type: "side", punkt: x } : null);
    const liste =
      m.id === "faktura"
        ? [side(m.punkter.find((x) => x.til === "/fakturaer")), nyFaktura ? ({ type: "ny-faktura" } as const) : null, side(m.punkter.find((x) => x.til === "/kunder"))]
        : m.punkter.slice(0, MAKS_SNARVEIER).map(side);
    return liste.filter((s): s is Snarvei => !!s);
  }
  return bunnModuler(alle, valgte).map((modul) => ({ type: "modul", modul }));
}

// Modulene i bunnmenyen, i menyens rekkefølge: de valgte som finnes, ellers de første.
export function bunnModuler(alle: Modul[], valgte: string[] | null): Modul[] {
  const valgt = valgte ? alle.filter((m) => valgte.includes(m.id)) : [];
  return (valgt.length ? valgt : alle).slice(0, MAKS_SNARVEIER);
}

// Valget lagres på enheten, per organisasjon (modulene er ikke de samme overalt).
const nokkel = (org: string) => `bunnmeny:${org}`;
function lesValg(org: string | undefined): string[] | null {
  if (!org) return null;
  try {
    const v = JSON.parse(localStorage.getItem(nokkel(org)) ?? "null");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : null;
  } catch {
    return null;
  }
}
export function useBunnValg(org: string | undefined): [string[] | null, (v: string[] | null) => void] {
  // Valget hører til organisasjonen det ble gjort i; i en annen leses det fra enheten med en gang.
  const [lagret, settLagret] = useState(() => ({ org, valg: lesValg(org) }));
  const valg = lagret.org === org ? lagret.valg : lesValg(org);
  const lagre = (v: string[] | null) => {
    settLagret({ org, valg: v });
    if (!org) return;
    try {
      if (v) localStorage.setItem(nokkel(org), JSON.stringify(v));
      else localStorage.removeItem(nokkel(org));
    } catch {
      /* uten lagring (privat nettleser) gjelder valget til appen lukkes */
    }
  };
  return [valg, lagre];
}

// --- Menyarket ----------------------------------------------------------------------------

// Søket: uten store bokstaver og aksenter, og æ, ø og å som ae, o og a («lonn» finner Lønn).
export const enkel = (t: string) =>
  t
    .toLowerCase()
    .replace(/æ/g, "ae")
    .replace(/[øö]/g, "o")
    .replace(/å/g, "a")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

type Treff = { x: MenyPunkt; modul?: string };
export function sokIMenyen(moduler: Modul[], konto: MenyPunkt[], sok: string): Treff[] {
  const q = enkel(sok.trim());
  if (!q) return [];
  const alle: Treff[] = [
    ...moduler.flatMap((m) => m.punkter.map((x) => ({ x, modul: m.punkter.length > 1 ? m.navn : undefined }))),
    ...konto.map((x) => ({ x, modul: "Konto" })),
  ];
  // Treff i navnet på siden først, så sidene i modulen med det navnet.
  return [...alle.filter((t) => enkel(t.x.tekst).includes(q)), ...alle.filter((t) => !enkel(t.x.tekst).includes(q) && t.modul && enkel(t.modul).includes(q))];
}

function Side({ x }: { x: MenyPunkt }) {
  return (
    <Link to={x.til} className={`menyark-side${x.aktiv ? " active" : ""}`} aria-current={x.aktiv ? "page" : undefined}>
      <span>{x.tekst}</span>
      <UlesteTall n={x.teller ?? 0} />
    </Link>
  );
}

// Sidene i en modul i to kolonner, med overskriften der en ny gruppe begynner.
function Sider({ punkter }: { punkter: MenyPunkt[] }) {
  return (
    <div className="menyark-sider">
      {punkter.map((x, i) => (
        <Fragment key={x.til}>
          {x.gruppe && x.gruppe !== punkter[i - 1]?.gruppe && <div className="menyark-gruppe">{x.gruppe}</div>}
          <Side x={x} />
        </Fragment>
      ))}
    </div>
  );
}

// ark: «meny» (hele menyen), id-en til en modul (bare sidene i den) eller null (lukket).
export function Menyark({
  ark,
  lukk,
  visMeny,
  moduler,
  konto,
  orgvelger,
  bruker,
  loggUt,
  installer,
  bunnvalg,
}: {
  ark: string | null;
  lukk: () => void;
  visMeny: () => void;
  moduler: Modul[];
  konto: MenyPunkt[];
  orgvelger: ReactNode;
  bruker: { navn?: string | null; epost?: string | null };
  loggUt: () => void;
  installer?: () => void;
  // Valget av moduler i bunnmenyen (bare når det er flere moduler enn plasser).
  bunnvalg?: { moduler: Modul[]; valgte: string[]; velg: (v: string[] | null) => void; egetValg: boolean };
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const lukkKnapp = useRef<HTMLButtonElement>(null);
  const liste = useRef<HTMLDivElement>(null);
  const nav = useNavigate();
  const [sok, settSok] = useState("");
  const [velgBunn, settVelgBunn] = useState(false);
  const modul = ark && ark !== "meny" ? moduler.find((m) => m.id === ark && m.punkter.length > 1) : undefined;
  const apen = ark === "meny" || !!modul;
  const treff = sokIMenyen(moduler, konto, sok);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (apen && !d.open) {
      d.showModal();
      // Lukk-knappen får fokus (ikke søkefeltet, som ville åpnet tastaturet).
      lukkKnapp.current?.focus();
    }
    if (!apen && d.open) d.close();
    if (!apen) {
      settSok("");
      settVelgBunn(false);
    }
  }, [apen]);
  // Hele menyen åpner ved modulen man er i (siden man er på, er markert).
  useEffect(() => {
    const l = liste.current;
    if (ark !== "meny" || !l) return;
    const her = l.querySelector<HTMLElement>("[aria-current='page']")?.closest<HTMLElement>("section");
    l.scrollTop = her ? Math.max(0, her.offsetTop - 8) : 0;
  }, [ark]);

  const ga = (e: FormEvent) => {
    e.preventDefault();
    if (!treff[0]) return;
    nav(treff[0].x.til);
    lukk();
  };

  return (
    <dialog
      ref={ref}
      id="mobilmeny"
      className={`menyark${modul ? " modulark" : ""}`}
      aria-label={modul ? modul.navn : "Meny"}
      onClose={lukk}
      onCancel={lukk}
      onClick={(e) => {
        // Trykk utenfor arket (på bakgrunnen) eller på en side lukker det, også siden man er på.
        if (e.target === e.currentTarget || (e.target as HTMLElement).closest("a")) lukk();
      }}
    >
      {apen && (
        <>
          <div className="menyark-hode">
            <button ref={lukkKnapp} type="button" className="ikon menyark-lukk" aria-label="Lukk menyen" onClick={lukk}>
              <IkonLukk storrelse={20} />
            </button>
            {modul ? (
              <h2>
                <modul.Ikon storrelse={20} />
                {modul.navn}
              </h2>
            ) : (
              orgvelger
            )}
          </div>
          {!modul && (
            <form className="menyark-sok" role="search" onSubmit={ga}>
              <input type="search" value={sok} onChange={(e) => settSok(e.target.value)} placeholder="Finn en side" aria-label="Finn en side" enterKeyHint="go" />
            </form>
          )}
          <div ref={liste} className="menyark-liste">
            {modul ? (
              <Sider punkter={modul.punkter} />
            ) : sok.trim() ? (
              treff.length ? (
                <div className="menyark-treff">
                  {treff.map(({ x, modul: m }) => (
                    <Link key={x.til} to={x.til} className={`menyark-rad${x.aktiv ? " active" : ""}`} aria-current={x.aktiv ? "page" : undefined}>
                      <x.Ikon />
                      <span className="menyark-navn">{x.tekst}</span>
                      {m && <span className="menyark-modul">{m}</span>}
                    </Link>
                  ))}
                </div>
              ) : (
                <p className="menyark-ingen">Ingen sider heter det.</p>
              )
            ) : (
              <>
                {moduler.map((m) =>
                  m.punkter.length === 1 ? (
                    <Link key={m.id} to={m.punkter[0]!.til} className={`menyark-rad${m.aktiv ? " active" : ""}`} aria-current={m.aktiv ? "page" : undefined}>
                      <m.Ikon />
                      <span className="menyark-navn">{m.navn}</span>
                      <UlesteTall n={nye(m)} />
                    </Link>
                  ) : (
                    <section key={m.id} aria-labelledby={`menyark-${m.id}`}>
                      <h3 id={`menyark-${m.id}`} className={m.aktiv ? "her" : undefined}>
                        <m.Ikon storrelse={16} />
                        {m.navn}
                      </h3>
                      <Sider punkter={m.punkter} />
                    </section>
                  ),
                )}
                {(konto.length > 0 || installer || bunnvalg) && (
                  <section aria-labelledby="menyark-konto">
                    <h3 id="menyark-konto">Konto</h3>
                    <div className="menyark-sider">
                      {konto.map((x) => (
                        <Side key={x.til} x={x} />
                      ))}
                      {installer && (
                        <button type="button" className="menyark-side" onClick={installer}>
                          <span>Installer appen</span>
                        </button>
                      )}
                      {bunnvalg && (
                        <button type="button" className={`menyark-side${velgBunn ? " valgt" : ""}`} aria-expanded={velgBunn} onClick={() => settVelgBunn(!velgBunn)}>
                          <span>Tilpass bunnmenyen</span>
                        </button>
                      )}
                    </div>
                    {bunnvalg && velgBunn && <BunnValg {...bunnvalg} />}
                  </section>
                )}
              </>
            )}
          </div>
          {modul ? (
            <div className="menyark-mer">
              <button type="button" className="lenke" onClick={visMeny}>
                Hele menyen
              </button>
            </div>
          ) : (
            <div className="menyark-fot">
              <span className="avatar rund">{initialer(bruker.navn ?? bruker.epost ?? "?")}</span>
              <div className="hvem">
                <div>{bruker.navn}</div>
                <span>{bruker.epost}</span>
              </div>
              <button type="button" onClick={loggUt}>
                <IkonLoggUt storrelse={18} />
                Logg ut
              </button>
            </div>
          )}
        </>
      )}
    </dialog>
  );
}

// Modulene i bunnmenyen: opptil tre, minst én; de står i menyens rekkefølge.
function BunnValg({ moduler, valgte, velg, egetValg }: { moduler: Modul[]; valgte: string[]; velg: (v: string[] | null) => void; egetValg: boolean }) {
  return (
    <fieldset className="menyark-bunnvalg">
      <legend>Velg opptil {MAKS_SNARVEIER} moduler til bunnmenyen</legend>
      {moduler.map((m) => {
        const pa = valgte.includes(m.id);
        return (
          <label key={m.id} className={pa ? "valgt" : undefined}>
            <input
              type="checkbox"
              checked={pa}
              disabled={pa ? valgte.length === 1 : valgte.length >= MAKS_SNARVEIER}
              onChange={() => velg(pa ? valgte.filter((v) => v !== m.id) : [...valgte, m.id])}
            />
            <m.Ikon storrelse={16} />
            {m.navn}
          </label>
        );
      })}
      {egetValg && (
        <button type="button" className="lenke" onClick={() => velg(null)}>
          Tilbake til standard
        </button>
      )}
    </fieldset>
  );
}
