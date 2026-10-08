// Rollene: rollen personen har hos dere, f.eks. lege eller sekretær (i API-et «ansattgrupper»;
// 0039_bemanning.sql og 0056_roller.sql). En rolle kan være for dem som ikke er ansatt (f.eks.
// leger som er aksjonærer eller selvstendige): de er med i vaktplanen, i bemanningskalenderen og
// i fraværet, men ikke i lønn, feriebank og arbeidsmiljølovens advarsler. Med vaktplanen står
// rollene ved siden av hverandre i bemanningskalenderen, med hvor mange som er på jobb mot
// behovet, og en rolle kan stå utenfor tavla (0057_rolle_tavle.sql; f.eks. legene: de står ikke
// der og fordeles ikke). Rollene settes opp her (fra Ansatte og fra kalenderen), og velges for hver
// person i skjemaet under Ansatte.
import { useState, type FormEvent } from "react";
import { api } from "../api";
import { Feil, tall, useHandling } from "../felles";
import { IkonNed, IkonOpp, IkonPluss } from "../ikoner";
import { useKonto } from "../konto";

export type Rolle = { id: string; navn: string; kort: string | null; behov: number | null; rekkefolge: number; antall: number; ikke_ansatt: boolean; tavle: boolean };
type Person = { id: string; fornavn: string; etternavn: string; aktiv: boolean; stilling: string | null; gruppe_id: string | null };

// «Sekretær» blir «Sek.» i oppsummeringen i kalenderen, med mindre rollen har en egen forkortelse.
export const kortNavn = (g: Pick<Rolle, "navn" | "kort">) => g.kort || (g.navn.length > 5 ? `${g.navn.slice(0, 3)}.` : g.navn);
export const IKKE_ANSATT_HJELP = "med i vaktplanen, kalenderen og fraværet, men ikke i lønn, feriebank og arbeidsmiljølovens advarsler";

// kalender: med vaktplanen (behov og forkortelse i bemanningskalenderen).
export function RollerOppsett({ roller, personer, kalender, endret, lukk }: { roller: Rolle[]; personer: Person[]; kalender: boolean; endret: () => void; lukk: () => void }) {
  const { org } = useKonto();
  const [rediger, settRediger] = useState<string | null>(null); // id-en, eller «ny»
  const [melding, settMelding] = useState<string | null>(null);
  const h = useHandling();
  const aktive = personer.filter((a) => a.aktiv).sort((x, y) => x.fornavn.localeCompare(y.fornavn, "nb") || x.etternavn.localeCompare(y.etternavn, "nb"));
  const fraStillinger = aktive.some((a) => !a.gruppe_id && a.stilling?.trim());

  const flytt = (i: number, til: number) =>
    h.kjor(async () => {
      const ider = roller.map((g) => g.id);
      const [x] = ider.splice(i, 1);
      ider.splice(til, 0, x!);
      await api("POST", `/org/${org!.id}/ansattgrupper/rekkefolge`, { ider });
      endret();
    });
  const slett = (g: Rolle) =>
    h.kjor(async () => {
      if (!confirm(`Slette rollen «${g.navn}»? De med rollen står uten rolle${g.ikke_ansatt ? " og regnes som ansatt" : ""}.`)) return;
      await api("DELETE", `/org/${org!.id}/ansattgrupper/${g.id}`);
      endret();
    });
  const lagFraStillinger = () =>
    h.kjor(async () => {
      const r = await api<{ grupper: number; ansatte: number }>("POST", `/org/${org!.id}/ansattgrupper/fra-stillinger`);
      settMelding(
        r.ansatte
          ? `${r.ansatte} ${r.ansatte === 1 ? "person har" : "personer har"} fått rolle etter stillingen${r.grupper ? ` (${r.grupper} ${r.grupper === 1 ? "ny rolle" : "nye roller"})` : ""}.`
          : "Ingen å gi rolle.",
      );
      endret();
    });
  const settRolle = (a: Person, rolle: string) =>
    h.kjor(async () => {
      await api("PATCH", `/org/${org!.id}/ansatte/${a.id}`, { gruppe_id: rolle || null });
      endret();
    });
  const ferdig = () => {
    settRediger(null);
    endret();
  };

  return (
    <>
      <section className="oppsett-del">
        <h3>Roller</h3>
        <p className="liten dempet">
          Rollen personen har hos dere, f.eks. lege eller sekretær.
          {kalender ? " I bemanningskalenderen står rollene ved siden av hverandre, med hvor mange som er på jobb hver dag mot behovet (hvor mange som trengs)." : ""}
        </p>
        {melding && (
          <div className="melding ok" role="status">
            {melding}
          </div>
        )}
        {roller.length > 0 && (
          <ul className="liste-enkel oppsett-liste">
            {roller.map((g, i) =>
              rediger === g.id ? (
                <li key={g.id}>
                  <RolleSkjema rolle={g} kalender={kalender} ferdig={ferdig} avbryt={() => settRediger(null)} />
                </li>
              ) : (
                <li key={g.id}>
                  <span>
                    <span className="tittel">{g.navn}</span>{" "}
                    <span className="dempet">
                      {[
                        kalender ? kortNavn(g) : "",
                        kalender && g.behov != null ? `trenger ${g.behov} per dag` : "",
                        `${g.antall} ${g.antall === 1 ? "person" : "personer"}`,
                        g.ikke_ansatt ? "ikke ansatt" : "",
                        kalender && g.tavle === false ? "ikke på tavla" : "",
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </span>
                  <span className="knapper">
                    {kalender && (
                      <>
                        <button type="button" className="ikon" aria-label={`Flytt ${g.navn} opp`} title="Flytt opp (lenger til venstre i kalenderen)" disabled={i === 0 || h.opptatt} onClick={() => flytt(i, i - 1)}>
                          <IkonOpp storrelse={16} />
                        </button>
                        <button
                          type="button"
                          className="ikon"
                          aria-label={`Flytt ${g.navn} ned`}
                          title="Flytt ned (lenger til høyre i kalenderen)"
                          disabled={i === roller.length - 1 || h.opptatt}
                          onClick={() => flytt(i, i + 1)}
                        >
                          <IkonNed storrelse={16} />
                        </button>
                      </>
                    )}
                    <button type="button" onClick={() => settRediger(g.id)}>
                      Endre
                    </button>
                    <button type="button" className="fare" disabled={h.opptatt} onClick={() => slett(g)}>
                      Slett
                    </button>
                  </span>
                </li>
              ),
            )}
          </ul>
        )}
        {rediger === "ny" ? (
          <RolleSkjema kalender={kalender} ferdig={ferdig} avbryt={() => settRediger(null)} />
        ) : (
          <div className="knapper">
            <button type="button" onClick={() => settRediger("ny")}>
              <IkonPluss storrelse={16} /> Ny rolle
            </button>
            {fraStillinger && (
              <button type="button" disabled={h.opptatt} onClick={lagFraStillinger}>
                Lag roller fra stillingene
              </button>
            )}
          </div>
        )}
        <Feil melding={h.feil} />
      </section>
      {roller.length > 0 && aktive.length > 0 && (
        <section className="oppsett-del">
          <h3>Hvem har hvilken rolle</h3>
          <p className="liten dempet">Velg rollen til hver person (også i skjemaet under Ansatte).</p>
          <ul className="liste-enkel oppsett-liste bm-ansattliste">
            {aktive.map((a) => (
              <li key={a.id}>
                <span>
                  <span className="tittel">
                    {a.fornavn} {a.etternavn}
                  </span>{" "}
                  <span className="dempet">{a.stilling ?? ""}</span>
                </span>
                <select key={a.gruppe_id ?? ""} defaultValue={a.gruppe_id ?? ""} aria-label={`Rolle for ${a.fornavn} ${a.etternavn}`} onChange={(e) => settRolle(a, e.target.value)}>
                  <option value="">Uten rolle</option>
                  {roller.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.navn}
                    </option>
                  ))}
                </select>
              </li>
            ))}
          </ul>
        </section>
      )}
      <div className="knapper oppsett-ferdig">
        <button type="button" className="primar" onClick={lukk}>
          Ferdig
        </button>
      </div>
    </>
  );
}

function RolleSkjema({ rolle, kalender, ferdig, avbryt }: { rolle?: Rolle; kalender: boolean; ferdig: () => void; avbryt: () => void }) {
  const { org } = useKonto();
  const [v, settV] = useState({
    navn: rolle?.navn ?? "",
    kort: rolle?.kort ?? "",
    behov: rolle?.behov != null ? String(rolle.behov) : "",
    ikke_ansatt: rolle?.ikke_ansatt ?? false,
    tavle: rolle?.tavle ?? true,
  });
  const h = useHandling();
  const sett = (e: Partial<typeof v>) => settV({ ...v, ...e });

  async function lagre(e: FormEvent) {
    e.preventDefault();
    const behov = v.behov.trim() === "" ? null : tall(v.behov);
    if (behov !== null && !(Number.isInteger(behov) && behov >= 0)) return h.settFeil("Skriv behovet som et helt tall");
    const kropp = { navn: v.navn.trim(), ikke_ansatt: v.ikke_ansatt, ...(kalender ? { kort: v.kort.trim() || null, behov, tavle: v.tavle } : {}) };
    const r = await h.kjor(async () => {
      if (rolle) await api("PATCH", `/org/${org!.id}/ansattgrupper/${rolle.id}`, kropp);
      else await api("POST", `/org/${org!.id}/ansattgrupper`, kropp);
      return true;
    });
    if (r) ferdig();
  }

  return (
    <form className="oppsett-skjema" onSubmit={lagre}>
      <div className={kalender ? "rad fase-felt" : "rad"}>
        <label>
          Navn
          <input required autoFocus maxLength={40} placeholder="F.eks. Lege" value={v.navn} onChange={(e) => sett({ navn: e.target.value })} />
        </label>
        {kalender && (
          <>
            <label>
              Forkortelse
              <input maxLength={8} placeholder={v.navn.trim() ? kortNavn({ navn: v.navn.trim(), kort: null }) : "F.eks. Sek."} value={v.kort} onChange={(e) => sett({ kort: e.target.value })} />
            </label>
            <label>
              Behov per dag
              <input inputMode="numeric" placeholder="Valgfritt" value={v.behov} onChange={(e) => sett({ behov: e.target.value })} />
            </label>
          </>
        )}
      </div>
      {kalender && <p className="felt-hjelp oppsett-hjelp">Behovet er hvor mange med rollen som trengs på jobb hver dag. Forkortelsen står over oppsummeringen i kalenderen.</p>}
      <label>
        <input type="checkbox" checked={v.ikke_ansatt} onChange={(e) => sett({ ikke_ansatt: e.target.checked })} /> Ikke ansatt
      </label>
      <p className="felt-hjelp oppsett-hjelp">For dem som jobber her uten å være ansatt, f.eks. leger som er aksjonærer eller selvstendige: {IKKE_ANSATT_HJELP}.</p>
      {kalender && (
        <>
          <label>
            <input type="checkbox" checked={v.tavle} onChange={(e) => sett({ tavle: e.target.checked })} /> Med på tavla
          </label>
          <p className="felt-hjelp oppsett-hjelp">
            Uten kryss står de med rollen ikke på tavla, rulleringen fordeler dem ikke, og plassene deres fra i dag av fjernes. I vaktplanen og kalenderen er de med
            som før.
          </p>
        </>
      )}
      <Feil melding={h.feil} />
      <div className="knapper">
        <button className="primar" disabled={h.opptatt}>
          {rolle ? "Lagre" : "Legg til"}
        </button>
        <button type="button" onClick={avbryt}>
          Avbryt
        </button>
      </div>
    </form>
  );
}
