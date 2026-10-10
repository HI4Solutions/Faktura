// Yrkesskader (0102_yrkesskader.sql, server/src/yrkesskader.ts): yrkesskadeforsikringen, registeret
// over personskadene under arbeidet (arbeidsmiljøloven § 5-1), og det som gjenstår å melde for hver
// skade: skademelding til NAV, melding til forsikringen, og ved dødsfall eller alvorlig personskade
// varsel til Arbeidstilsynet og politiet (§ 5-2). Bare eier og administrator (helseopplysninger).
import { useState } from "react";
import { api, hent } from "../api";
import { Feil, Laster, useData, useHandling } from "../felles";
import { useKonto } from "../konto";
import { dato, iDag } from "../format";

type Skade = {
  id: string;
  ansatt_id: string;
  navn: string;
  dato: string;
  klokkeslett: string | null;
  type: "ulykke" | "sykdom";
  sted: string | null;
  beskrivelse: string;
  skade: string | null;
  alvorlig: boolean;
  fravaer: boolean;
  tiltak: string | null;
  meldt_nav: string | null;
  meldt_forsikring: string | null;
  meldt_arbeidstilsynet: string | null;
  meldt_politi: string | null;
  oppgaver: string[];
};
type Svar = { forsikring: { selskap: string | null; polise: string | null }; skader: Skade[] };
type Person = { id: string; fornavn: string; etternavn: string };

const tomSkade = () => ({
  id: "",
  ansatt_id: "",
  dato: iDag(),
  klokkeslett: "",
  type: "ulykke" as "ulykke" | "sykdom",
  sted: "",
  beskrivelse: "",
  skade: "",
  alvorlig: false,
  fravaer: false,
  tiltak: "",
  meldt_nav: "",
  meldt_forsikring: "",
  meldt_arbeidstilsynet: "",
  meldt_politi: "",
});
type Utkast = ReturnType<typeof tomSkade>;
const tilUtkast = (s: Skade): Utkast => ({
  id: s.id,
  ansatt_id: s.ansatt_id,
  dato: s.dato,
  klokkeslett: s.klokkeslett ?? "",
  type: s.type,
  sted: s.sted ?? "",
  beskrivelse: s.beskrivelse,
  skade: s.skade ?? "",
  alvorlig: s.alvorlig,
  fravaer: s.fravaer,
  tiltak: s.tiltak ?? "",
  meldt_nav: s.meldt_nav ?? "",
  meldt_forsikring: s.meldt_forsikring ?? "",
  meldt_arbeidstilsynet: s.meldt_arbeidstilsynet ?? "",
  meldt_politi: s.meldt_politi ?? "",
});

export function Yrkesskader({ personer }: { personer: Person[] }) {
  const { org } = useKonto();
  const { data, feil, last } = useData(() => hent<Svar>(`/org/${org!.id}/yrkesskader`), [org?.id]);
  const [forsikring, settForsikring] = useState<{ selskap: string; polise: string } | null>(null);
  const [utkast, settUtkast] = useState<Utkast | null>(null);
  const [gjenstaar, settGjenstaar] = useState<string[] | null>(null);
  const h = useHandling();
  if (!data) return feil ? <Feil melding={feil} /> : <Laster />;
  const f = forsikring ?? { selskap: data.forsikring.selskap ?? "", polise: data.forsikring.polise ?? "" };

  async function lagreForsikring() {
    const r = await h.kjor(() => api("PUT", `/org/${org!.id}/yrkesskader/forsikring`, { selskap: f.selskap, polise: f.polise }));
    if (r) {
      settForsikring(null);
      last();
    }
  }
  async function lagre() {
    const u = utkast!;
    const { id, ...felt } = u;
    const kropp = { ...felt, klokkeslett: felt.klokkeslett || null };
    const r = await h.kjor<Skade>(() =>
      id ? api("PATCH", `/org/${org!.id}/yrkesskader/${id}`, kropp) : api("POST", `/org/${org!.id}/yrkesskader`, kropp),
    );
    if (r) {
      settUtkast(null);
      settGjenstaar(r.oppgaver);
      last();
    }
  }
  async function slett() {
    if (!confirm("Slette skaden fra registeret?")) return;
    if (await h.kjor(() => api("DELETE", `/org/${org!.id}/yrkesskader/${utkast!.id}`))) {
      settUtkast(null);
      last();
    }
  }
  const sett = (e: Partial<Utkast>) => settUtkast({ ...utkast!, ...e });
  const valg = utkast && !personer.some((p) => p.id === utkast.ansatt_id) && utkast.ansatt_id ? data.skader.find((s) => s.ansatt_id === utkast.ansatt_id) : null;

  if (utkast)
    return (
      <div className="yrkesskade-skjema">
        <div className="rad">
          <label>
            Ansatt
            <select value={utkast.ansatt_id} onChange={(e) => sett({ ansatt_id: e.target.value })}>
              <option value="">Velg ansatt</option>
              {valg && <option value={valg.ansatt_id}>{valg.navn}</option>}
              {personer.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.fornavn} {p.etternavn}
                </option>
              ))}
            </select>
          </label>
          <label>
            Type
            <select value={utkast.type} onChange={(e) => sett({ type: e.target.value as "ulykke" | "sykdom" })}>
              <option value="ulykke">Arbeidsulykke</option>
              <option value="sykdom">Yrkessykdom</option>
            </select>
          </label>
        </div>
        <div className="rad">
          <label>
            Dato
            <input type="date" max={iDag()} value={utkast.dato} onChange={(e) => sett({ dato: e.target.value })} />
          </label>
          <label>
            Klokkeslett
            <input type="time" value={utkast.klokkeslett} onChange={(e) => sett({ klokkeslett: e.target.value })} />
          </label>
        </div>
        <label>
          Sted
          <input value={utkast.sted} placeholder="F.eks. lageret, venterommet" onChange={(e) => sett({ sted: e.target.value })} />
        </label>
        <label>
          Hva skjedde
          <textarea rows={3} value={utkast.beskrivelse} onChange={(e) => sett({ beskrivelse: e.target.value })} />
        </label>
        <label>
          Skaden
          <input value={utkast.skade} placeholder="F.eks. brudd i håndledd, kutt i finger" onChange={(e) => sett({ skade: e.target.value })} />
        </label>
        <label>
          <input type="checkbox" checked={utkast.alvorlig} onChange={(e) => sett({ alvorlig: e.target.checked })} />
          Dødsfall eller alvorlig personskade (Arbeidstilsynet og politiet skal varsles straks)
        </label>
        <label>
          <input type="checkbox" checked={utkast.fravaer} onChange={(e) => sett({ fravaer: e.target.checked })} />
          Førte til sykefravær
        </label>
        <label>
          Tiltak
          <textarea rows={2} value={utkast.tiltak} placeholder="Det som gjøres for at det ikke skal skje igjen" onChange={(e) => sett({ tiltak: e.target.value })} />
        </label>
        <h4>Meldt</h4>
        <div className="rad">
          <label>
            Skademelding til NAV
            <input type="date" value={utkast.meldt_nav} onChange={(e) => sett({ meldt_nav: e.target.value })} />
          </label>
          <label>
            Forsikringen
            <input type="date" value={utkast.meldt_forsikring} onChange={(e) => sett({ meldt_forsikring: e.target.value })} />
          </label>
        </div>
        {utkast.alvorlig && (
          <div className="rad">
            <label>
              Arbeidstilsynet varslet
              <input type="date" value={utkast.meldt_arbeidstilsynet} onChange={(e) => sett({ meldt_arbeidstilsynet: e.target.value })} />
            </label>
            <label>
              Politiet varslet
              <input type="date" value={utkast.meldt_politi} onChange={(e) => sett({ meldt_politi: e.target.value })} />
            </label>
          </div>
        )}
        <p className="felt-hjelp">
          Skademeldingen sendes på{" "}
          <a href="https://www.nav.no/arbeidsgiver/meldyrkesskade" target="_blank" rel="noreferrer">
            nav.no
          </a>{" "}
          så snart som mulig, også om dere er i tvil om det er en yrkesskade.
        </p>
        <Feil melding={h.feil} />
        <div className="knapper">
          <button type="button" className="primar" disabled={h.opptatt || !utkast.ansatt_id || !utkast.beskrivelse.trim()} onClick={lagre}>
            Lagre
          </button>
          <button type="button" onClick={() => settUtkast(null)}>
            Avbryt
          </button>
          {utkast.id && (
            <button type="button" className="fare" onClick={slett} disabled={h.opptatt}>
              Slett
            </button>
          )}
        </div>
      </div>
    );

  return (
    <div className="yrkesskader">
      <h3 style={{ marginTop: 0 }}>Yrkesskadeforsikring</h3>
      <div className="rad" style={{ alignItems: "end" }}>
        <label>
          Forsikringsselskap
          <input value={f.selskap} onChange={(e) => settForsikring({ ...f, selskap: e.target.value })} />
        </label>
        <label>
          Polisenummer
          <input value={f.polise} onChange={(e) => settForsikring({ ...f, polise: e.target.value })} />
        </label>
        {forsikring && (
          <label>
            <button type="button" onClick={lagreForsikring} disabled={h.opptatt}>
              Lagre
            </button>
          </label>
        )}
      </div>
      {!data.forsikring.selskap && <p className="melding advarsel">Alle arbeidsgivere skal ha yrkesskadeforsikring for de ansatte. Legg inn selskapet og polisenummeret.</p>}
      <div className="topp" style={{ marginTop: 16 }}>
        <h3 style={{ margin: 0 }}>Skaderegister</h3>
        <button type="button" className="primar" onClick={() => (settGjenstaar(null), settUtkast(tomSkade()))}>
          Registrer yrkesskade
        </button>
      </div>
      {gjenstaar && gjenstaar.length > 0 && (
        <div className="melding advarsel">
          Lagret. Dette gjenstår:
          <ul>
            {gjenstaar.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
        </div>
      )}
      {gjenstaar && gjenstaar.length === 0 && <div className="melding ok">Lagret. Alt er meldt.</div>}
      {!data.skader.length ? (
        <p className="dempet">Ingen skader er registrert. Arbeidsgiveren skal registrere alle personskader under arbeidet (arbeidsmiljøloven § 5-1).</p>
      ) : (
        <ul className="yrkesskade-liste">
          {data.skader.map((s) => (
            <li key={s.id}>
              <button type="button" className="lenke" onClick={() => (settGjenstaar(null), settUtkast(tilUtkast(s)))}>
                {dato(s.dato)} · {s.navn}
              </button>{" "}
              {s.alvorlig && <span className="merke merke-advarsel">Alvorlig</span>} {s.fravaer && <span className="merke merke-noytral">Fravær</span>}
              <div>{s.beskrivelse}</div>
              {s.oppgaver.length > 0 ? (
                <ul className="liten yrkesskade-oppgaver">
                  {s.oppgaver.map((t) => (
                    <li key={t}>{t}</li>
                  ))}
                </ul>
              ) : (
                <div className="liten dempet">Alt er meldt.</div>
              )}
            </li>
          ))}
        </ul>
      )}
      <Feil melding={h.feil} />
      <p className="liten dempet">Registeret skal være tilgjengelig for verneombudet, arbeidsmiljøutvalget og bedriftshelsetjenesten. Det står også i Rapporter → Personal.</p>
    </div>
  );
}
