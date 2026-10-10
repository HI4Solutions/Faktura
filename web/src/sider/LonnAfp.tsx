// AFP og OU (0098, server/src/afpPremier.ts): det som er avsatt per kvartal i lønnskjøringene (det
// fakturaen fra Fellesordningen bygger på; den kommer kvartalsvis etterskudd), og betalingene av
// fakturaene. Når fakturaen er betalt, registreres beløpene her: betalingen bokføres, og
// arbeidsgiveravgiften av AFP-premien kommer i a-meldingen for måneden premien ble betalt. Eier og
// administrator registrerer og sletter; de som ser lønnen, ser oversikten.
import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { api, hent } from "../api";
import { Feil, Laster, Tom, tall, useData, useHandling, useSmal } from "../felles";
import { erAdmin, useKonto } from "../konto";
import { dato, iDag, kr } from "../format";

type Kvartal = {
  aar: number;
  kvartal: number;
  navn: string;
  ansatte: number;
  grunnlag: number;
  afp: number;
  ou: number;
  betalt: { afp: number; ou: number; aga: number; antall: number };
};
type Betaling = { id: string; dato: string; aar: number; kvartal: number; afp: number; ou: number; aga_sats: number; aga: number; tekst: string | null; bilag: string | null };
type Oversikt = {
  aar: number;
  oppsett: { afp: boolean; afp_sats: number; ou_premie: number; bokforing_afp: boolean; aga_sone: string };
  kvartaler: Kvartal[];
  betalinger: Betaling[];
};
type Skjema = { aar: number; kvartal: number; dato: string; afp: string; ou: string; tekst: string };

// 1111.36 → «1111,36» (tomt for 0) i et beløpsfelt.
const felt = (n: number) => (n > 0 ? (Math.round(n * 100) / 100).toFixed(2).replace(".", ",") : "");
const prosent = (n: number) => `${String(n).replace(".", ",")} %`;
const MND = ["januar", "februar", "mars", "april", "mai", "juni", "juli", "august", "september", "oktober", "november", "desember"];

export function Afp() {
  const { org } = useKonto();
  const admin = erAdmin(org?.rolle);
  const smal = useSmal();
  const [aar, settAar] = useState(Number(iDag().slice(0, 4)));
  const sti = `/org/${org!.id}/lonn/afp`;
  const d = useData(() => hent<Oversikt>(`${sti}?aar=${aar}`), [sti, aar]);
  const [ny, settNy] = useState<Skjema | null>(null);
  const [melding, settMelding] = useState<string | null>(null);
  const h = useHandling();

  // Skjemaet for kvartalet, med det som er avsatt og ikke betalt.
  const registrer = (k: Kvartal) => {
    settMelding(null);
    settNy({ aar: k.aar, kvartal: k.kvartal, dato: iDag(), afp: felt(k.afp - k.betalt.afp), ou: felt(k.ou - k.betalt.ou), tekst: "" });
  };
  async function lagre(e: FormEvent) {
    e.preventDefault();
    if (!ny) return;
    const r = await h.kjor(() =>
      api<Betaling>("POST", sti, { aar: ny.aar, kvartal: ny.kvartal, dato: ny.dato, afp: ny.afp ? tall(ny.afp) : 0, ou: ny.ou ? tall(ny.ou) : 0, tekst: ny.tekst.trim() || null }),
    );
    if (r) {
      settNy(null);
      settMelding(
        `Betalingen på ${kr(r.afp + r.ou)} kr er registrert og bokført${r.bilag ? ` (bilag ${r.bilag})` : ""}. Arbeidsgiveravgiften av AFP-premien (${kr(r.aga)} kr) kommer med i a-meldingen for ${MND[Number(r.dato.slice(5, 7)) - 1]} ${r.dato.slice(0, 4)}.`,
      );
      void d.last();
    }
  }
  async function slett(b: Betaling) {
    if (!confirm(`Slette betalingen på ${kr(b.afp + b.ou)} kr fra ${dato(b.dato)}? Bilaget reverseres.`)) return;
    if (await h.kjor(async () => (await api("DELETE", `${sti}/${b.id}`), true))) {
      settMelding("Betalingen er slettet, og bilaget er reversert.");
      void d.last();
    }
  }

  if (d.feil) return <Feil melding={d.feil} />;
  if (!d.data) return <Laster />;
  const { oppsett, kvartaler, betalinger } = d.data;
  const kvartal = (b: Pick<Betaling, "aar" | "kvartal">) => `${b.kvartal}. kvartal ${b.aar}`;
  // Det som er avsatt og ikke betalt for kvartalet.
  const igjen = (k: Kvartal) => Math.round((k.afp + k.ou - k.betalt.afp - k.betalt.ou) * 100) / 100;
  // «Registrer betaling» øverst: det siste kvartalet med noe som ikke er betalt (eller forrige kvartal).
  const forslag = [...kvartaler].reverse().find((k) => igjen(k) > 0) ?? kvartaler[Math.max(0, Math.floor((Number(iDag().slice(5, 7)) - 1) / 3) - 1)]!;

  return (
    <>
      {!oppsett.afp && (
        <div className="melding advarsel" role="status">
          AFP er ikke slått på, så lønnskjøringene avsetter ikke premien. Slå det på under{" "}
          <Link to="/innstillinger?fane=personal#afp">Innstillinger → Ansatte og timer → AFP</Link>.
        </div>
      )}
      <p className="liten dempet">
        Fellesordningen for AFP fakturerer premien kvartalsvis etterskudd ut fra a-meldingen: {prosent(oppsett.afp_sats)} av lønnen mellom 1 og 7,1 G i året for de
        ansatte fra året de fyller 13 til og med året de fyller 61
        {oppsett.ou_premie > 0 ? `, og OU-premien (${kr(oppsett.ou_premie)} kr per måned per heltidsansatt)` : ""}. Lønnskjøringene avsetter premien hver måned
        {oppsett.bokforing_afp ? " og bokfører avsetningen (kostnad mot påløpt premie)" : ""}. Når fakturaen er betalt, registrerer du betalingen her: den bokføres,
        og arbeidsgiveravgiften av AFP-premien kommer med i a-meldingen for måneden den ble betalt.
      </p>
      <div className="knapper lonn-knapper">
        <label>
          År{" "}
          <select value={aar} onChange={(e) => settAar(Number(e.target.value))}>
            {[0, 1, 2].map((i) => {
              const a = Number(iDag().slice(0, 4)) - i;
              return (
                <option key={a} value={a}>
                  {a}
                </option>
              );
            })}
          </select>
        </label>
        {admin && !ny && (
          <button type="button" onClick={() => registrer(forslag)}>
            Registrer betaling
          </button>
        )}
        <Link className="knapp" to={`/rapporter?fane=lonn&rapport=lonn.afp`}>
          Rapporten «AFP og OU»
        </Link>
      </div>
      {melding && (
        <div className="melding ok" role="status">
          {melding}
        </div>
      )}
      {ny && (
        <form className="kort afp-skjema" onSubmit={lagre}>
          <h3>Betaling for {kvartal(ny)}</h3>
          <div className="rad">
            <label>
              Kvartal
              <select value={ny.kvartal} onChange={(e) => settNy({ ...ny, kvartal: Number(e.target.value) })}>
                {[1, 2, 3, 4].map((q) => (
                  <option key={q} value={q}>
                    {q}. kvartal {ny.aar}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Betalt
              <input type="date" required value={ny.dato} onChange={(e) => settNy({ ...ny, dato: e.target.value })} />
            </label>
          </div>
          <div className="rad">
            <label>
              AFP-premie (kr)
              <input inputMode="decimal" value={ny.afp} onChange={(e) => settNy({ ...ny, afp: e.target.value })} />
            </label>
            <label>
              OU-premie (kr)
              <input inputMode="decimal" value={ny.ou} onChange={(e) => settNy({ ...ny, ou: e.target.value })} />
            </label>
          </div>
          <label>
            Tekst
            <input maxLength={200} placeholder="Valgfritt, f.eks. fakturanummeret" value={ny.tekst} onChange={(e) => settNy({ ...ny, tekst: e.target.value })} />
          </label>
          <p className="liten dempet">
            Beløpene er det som er avsatt og ikke betalt for kvartalet; skriv det som står på fakturaen. Arbeidsgiveravgiften av AFP-premien regnes med satsen for
            sonen.
          </p>
          <Feil melding={h.feil} />
          <div className="knapper">
            <button className="primar" disabled={h.opptatt}>
              Registrer og bokfør
            </button>
            <button type="button" onClick={() => settNy(null)}>
              Avbryt
            </button>
          </div>
        </form>
      )}
      <h3 className="lonn-under">Avsatt og betalt per kvartal</h3>
      {smal ? (
        <div className="kort liste">
          {kvartaler.map((k) => (
            <div key={k.kvartal} className="liste-rad">
              <span className="linje">
                <span className="tittel">{k.navn}</span>
                <span className="tall">{kr(k.afp + k.ou)}</span>
              </span>
              <span className="linje">
                <span className="under">
                  AFP {kr(k.afp)} · OU {kr(k.ou)}
                </span>
                {k.betalt.antall > 0 && igjen(k) <= 0 ? (
                  <span className="merke merke-ok">Betalt</span>
                ) : (
                  admin &&
                  igjen(k) > 0 && (
                    <button type="button" className="lenke" onClick={() => registrer(k)}>
                      Registrer betaling
                    </button>
                  )
                )}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <div className="kort tabell">
          <table>
            <thead>
              <tr>
                <th>Kvartal</th>
                <th className="hoyre">Ansatte</th>
                <th className="hoyre">Grunnlag</th>
                <th className="hoyre">AFP-premie</th>
                <th className="hoyre">OU-premie</th>
                <th className="hoyre">Betalt</th>
                <th className="hoyre">Arbeidsgiveravgift</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {kvartaler.map((k) => (
                <tr key={k.kvartal}>
                  <td>{k.navn}</td>
                  <td className="tall">{k.ansatte || ""}</td>
                  <td className="tall">{kr(k.grunnlag)}</td>
                  <td className="tall">{kr(k.afp)}</td>
                  <td className="tall">{kr(k.ou)}</td>
                  <td className="tall">{k.betalt.antall ? kr(k.betalt.afp + k.betalt.ou) : <span className="dempet">–</span>}</td>
                  <td className="tall">{k.betalt.antall ? kr(k.betalt.aga) : <span className="dempet">–</span>}</td>
                  <td className="hoyre">
                    {k.betalt.antall > 0 && igjen(k) <= 0 ? (
                      <span className="merke merke-ok">Betalt</span>
                    ) : (
                      admin &&
                      igjen(k) > 0 && (
                        <button type="button" className="lenke" onClick={() => registrer(k)}>
                          Registrer betaling
                        </button>
                      )
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <h3 className="lonn-under">Betalinger til Fellesordningen</h3>
      {!betalinger.length ? (
        <div className="kort">
          <Tom tittel={`Ingen betalinger registrert i ${aar}`}>
            <p>Når fakturaen fra Fellesordningen er betalt, registrerer du den på kvartalet over.</p>
          </Tom>
        </div>
      ) : (
        <div className="kort liste">
          {betalinger.map((b) => (
            <div key={b.id} className="liste-rad">
              <span className="linje">
                <span className="tittel">
                  {kvartal(b)}
                  {b.tekst && !smal ? <span className="dempet liten"> · {b.tekst}</span> : null}
                </span>
                <span className="tall">{kr(b.afp + b.ou)}</span>
              </span>
              <span className="linje">
                <span className="under">{[`Betalt ${dato(b.dato)}`, b.bilag].filter(Boolean).join(" · ")}</span>
                {admin && (
                  <button type="button" className="lenke" disabled={h.opptatt} onClick={() => void slett(b)}>
                    Slett
                  </button>
                )}
              </span>
              <span className="linje">
                <span className="under">
                  {[`AFP ${kr(b.afp)}`, b.ou ? `OU ${kr(b.ou)}` : null, smal ? `avgift ${kr(b.aga)}` : `arbeidsgiveravgift ${kr(b.aga)} (${prosent(b.aga_sats)})`]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </span>
            </div>
          ))}
        </div>
      )}
      {!ny && <Feil melding={h.feil} />}
    </>
  );
}
