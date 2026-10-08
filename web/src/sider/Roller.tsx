// Rollene: rollen personen har hos dere, f.eks. lege eller sekretær (i API-et «ansattgrupper»;
// 0039_bemanning.sql og 0056_roller.sql). En rolle kan være for dem som ikke er ansatt (f.eks.
// leger som er aksjonærer eller selvstendige): de er med i vaktplanen, i bemanningskalenderen og
// i fraværet, men ikke i lønn, feriebank og arbeidsmiljølovens advarsler. Med vaktplanen står
// rollene ved siden av hverandre i bemanningskalenderen, med hvor mange som er på jobb mot
// behovet, og en rolle kan stå utenfor tavla (0057_rolle_tavle.sql; f.eks. legene: de står ikke
// der og fordeles ikke). Rollene settes opp her (fra Ansatte og fra kalenderen), og velges for hver
// person i skjemaet under Ansatte. Kunder (f.eks. legene kontoret fakturerer) kan hentes inn som
// rollehavere herfra (HentFraKunder), uten å skrives inn på nytt.
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { api, hent } from "../api";
import { Feil, Laster, tall, useData, useHandling } from "../felles";
import { iDag } from "../format";
import { IkonNed, IkonOpp, IkonPluss } from "../ikoner";
import { useKonto } from "../konto";

export type Rolle = { id: string; navn: string; kort: string | null; behov: number | null; rekkefolge: number; antall: number; ikke_ansatt: boolean; tavle: boolean };
type Person = { id: string; fornavn: string; etternavn: string; aktiv: boolean; stilling: string | null; gruppe_id: string | null; epost?: string | null; kunde_id?: string | null };

// «Sekretær» blir «Sek.» i oppsummeringen i kalenderen, med mindre rollen har en egen forkortelse.
export const kortNavn = (g: Pick<Rolle, "navn" | "kort">) => g.kort || (g.navn.length > 5 ? `${g.navn.slice(0, 3)}.` : g.navn);
export const IKKE_ANSATT_HJELP = "med i vaktplanen, kalenderen og fraværet, men ikke i lønn, feriebank og arbeidsmiljølovens advarsler";

// kalender: med vaktplanen (behov og forkortelse i bemanningskalenderen).
export function RollerOppsett({ roller, personer, kalender, endret, lukk }: { roller: Rolle[]; personer: Person[]; kalender: boolean; endret: () => void; lukk: () => void }) {
  const { org } = useKonto();
  const [rediger, settRediger] = useState<string | null>(null); // id-en, «ny», eller «kunder» (hent fra kundene)
  const [melding, settMelding] = useState<string | null>(null);
  // Meldingen står over rollene; den rulles fram når den kommer (f.eks. etter «Hent fra kunder»).
  const meldingRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (melding) meldingRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [melding]);
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
          <div ref={meldingRef} className="melding ok" role="status">
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
        ) : rediger === "kunder" ? (
          <HentFraKunder
            roller={roller}
            personer={personer}
            ferdig={(m) => {
              settMelding(m);
              ferdig();
            }}
            avbryt={() => settRediger(null)}
          />
        ) : (
          <div className="knapper">
            <button type="button" onClick={() => (settMelding(null), settRediger("ny"))}>
              <IkonPluss storrelse={16} /> Ny rolle
            </button>
            <button type="button" onClick={() => (settMelding(null), settRediger("kunder"))}>
              Hent fra kunder
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

// --- Kunder som rollehavere --------------------------------------------------------------------

type Kunde = { id: string; kundenummer: number; type: "person" | "firma"; navn: string; epost: string | null; deres_referanse: string | null };
type Navn = { fornavn: string; etternavn: string };
type Hentet = { antall: { ny: number; koblet: number; hopp: number }; rader: { status: "ny" | "koblet" | "hopp"; grunn?: string }[] };
const NY_ROLLE = "ny";
const VIS = 200; // flere kunder enn dette: søk

// Navnet på personen fra kunden: for et firma kontaktpersonen (Deres referanse) når det står et
// navn der, ellers kundenavnet uten selskapsformen bakerst (AS, ENK …; med store bokstaver, så
// «da» i «Da Silva» står) og en tittel foran (Lege, Dr.). «Etternavn, Fornavn» snus, og det
// siste ordet er etternavnet. Navnet kan rettes før det hentes.
const SELSKAPSFORM = /(\s+(AS|ASA|ENK|DA|ANS|SA|NUF|BA|KS|IKS|SF)\.?|\s+enkeltpersonforetak)$/i;
const TITTEL = /^(lege|fastlege|overlege|tannlege|dr\.?|att\.?:?|attn\.?:?)\s+/i;
const ER_NAVN = /^\p{L}[\p{L}'’.-]*(\s+\p{L}[\p{L}'’.-]*){1,4}$/u;
const utenSelskapsform = (n: string) => {
  const m = n.match(SELSKAPSFORM);
  return m && (m[2] === undefined || m[2] === m[2].toUpperCase()) ? n.slice(0, m.index).trim() : n;
};
function personnavn(k: Pick<Kunde, "type" | "navn" | "deres_referanse">): Navn {
  const ref = (k.deres_referanse ?? "").replace(TITTEL, "").trim();
  let n = utenSelskapsform((k.type === "firma" && ER_NAVN.test(ref) ? ref : k.navn).replace(/\s+/g, " ").trim());
  while (TITTEL.test(n) && n.replace(TITTEL, "").trim()) n = n.replace(TITTEL, "").trim();
  if (n === n.toUpperCase()) n = n.toLowerCase().replace(/(^|[\s-])\p{L}/gu, (x) => x.toUpperCase());
  const komma = n.indexOf(",");
  if (komma > 0) return { fornavn: n.slice(komma + 1).trim(), etternavn: n.slice(0, komma).trim() };
  const ord = n.split(" ");
  return ord.length > 1 ? { fornavn: ord.slice(0, -1).join(" "), etternavn: ord.at(-1)! } : { fornavn: n, etternavn: "" };
}

const nokkel = (n: Navn) => `${n.fornavn} ${n.etternavn}`.trim().replace(/\s+/g, " ").toLowerCase();

// Hvem kunden er i registeret: hentet inn fra før (koblet til kunden), en av de aktive som
// finnes (samme e-post, ellers samme navn; den kobles), eller ny. Serveren gjør det samme.
// via: hva som er likt (navnet kan rettes, så en annen med samme navn ikke kobles).
function iRegisteret(k: Kunde, n: Navn, personer: Person[]): { status: "hentet" | "annen" | "finnes" | "ny"; person?: Person; via?: "epost" | "navn" } {
  const hentet = personer.find((p) => p.kunde_id === k.id);
  if (hentet) return { status: "hentet", person: hentet };
  const epost = k.epost?.trim().toLowerCase();
  const aktive = personer.filter((p) => p.aktiv);
  const medEpost = epost ? aktive.find((x) => x.epost?.toLowerCase() === epost) : undefined;
  const p = medEpost ?? aktive.find((x) => nokkel(x) === nokkel(n));
  if (!p) return { status: "ny" };
  return { status: p.kunde_id ? "annen" : "finnes", person: p, via: medEpost ? "epost" : "navn" };
}

function hentetMelding(r: Hentet, rolle: string) {
  const { ny, koblet, hopp } = r.antall;
  const grunner = [...new Set(r.rader.filter((x) => x.status === "hopp" && x.grunn).map((x) => x.grunn!.replace(/^\p{Lu}/u, (c) => c.toLowerCase())))];
  const deler = [
    ny ? `${ny} ${ny === 1 ? "person er" : "personer er"} lagt inn med rollen ${rolle}` : "",
    koblet ? `${koblet} som fantes, er koblet til kunden og har fått rollen` : "",
    hopp ? `${hopp} ${hopp === 1 ? "kunde" : "kunder"} hoppet over (${grunner.join("; ") || "hentet inn fra før"})` : "",
  ].filter(Boolean);
  return deler.length ? `${deler.join(", ")}.` : "Ingen å hente inn.";
}

function HentFraKunder({ roller, personer, ferdig, avbryt }: { roller: Rolle[]; personer: Person[]; ferdig: (melding: string) => void; avbryt: () => void }) {
  const { org } = useKonto();
  const kunder = useData(() => hent<Kunde[]>(`/org/${org!.id}/kunder?aktiv=true`), [org?.id]);
  const [sok, settSok] = useState("");
  const [valgt, settValgt] = useState<Record<string, Navn>>({});
  // Standard: en rolle for dem som ikke er ansatt (f.eks. legene), ellers den første.
  const [rolle, settRolle] = useState((roller.find((g) => g.ikke_ansatt) ?? roller[0])?.id ?? NY_ROLLE);
  const [nyRolle, settNyRolle] = useState({ navn: "", ikke_ansatt: true });
  const [fra, settFra] = useState(iDag());
  const h = useHandling();

  const alle = kunder.data ?? [];
  const s = sok.trim().toLowerCase();
  const treff = useMemo(
    () => alle.filter((k) => !s || `${k.navn} ${k.kundenummer} ${k.epost ?? ""} ${k.deres_referanse ?? ""}`.toLowerCase().includes(s)),
    [alle, s],
  );
  const vises = treff.slice(0, VIS);
  const status = (k: Kunde) => iRegisteret(k, valgt[k.id] ?? personnavn(k), personer);
  const kanVelges = (k: Kunde) => !["hentet", "annen"].includes(status(k).status);
  const valgbare = vises.filter(kanVelges);
  const antall = Object.keys(valgt).length;
  const rollenavn = rolle === NY_ROLLE ? nyRolle.navn.trim() || "den nye rollen" : (roller.find((g) => g.id === rolle)?.navn ?? "");

  const velg = (k: Kunde, ja: boolean) =>
    settValgt((v) => {
      const ny = { ...v };
      if (ja) ny[k.id] = v[k.id] ?? personnavn(k);
      else delete ny[k.id];
      return ny;
    });
  const velgAlle = (ja: boolean) =>
    settValgt((v) => {
      const ny = { ...v };
      for (const k of valgbare) {
        if (ja) ny[k.id] = v[k.id] ?? personnavn(k);
        else delete ny[k.id];
      }
      return ny;
    });
  const navn = (k: Kunde, e: Partial<Navn>) => settValgt((v) => ({ ...v, [k.id]: { ...v[k.id]!, ...e } }));

  async function hentInn(e: FormEvent) {
    e.preventDefault();
    const liste = Object.entries(valgt).map(([kunde_id, n]) => ({ kunde_id, fornavn: n.fornavn.trim(), etternavn: n.etternavn.trim() }));
    const mangler = liste.find((x) => !x.fornavn || !x.etternavn);
    if (mangler) return h.settFeil(`Skriv fornavn og etternavn for «${alle.find((k) => k.id === mangler.kunde_id)?.navn ?? "kunden"}».`);
    const nyttNavn = nyRolle.navn.trim();
    if (rolle === NY_ROLLE && !nyttNavn) return h.settFeil("Skriv navnet på den nye rollen, eller velg en annen.");
    const r = await h.kjor(async () => {
      // Den nye rollen lages først (en med samme navn brukes heller, om den finnes).
      const gruppe_id =
        rolle !== NY_ROLLE
          ? rolle
          : (roller.find((g) => g.navn.trim().toLowerCase() === nyttNavn.toLowerCase())?.id ??
            (await api<{ id: string }>("POST", `/org/${org!.id}/ansattgrupper`, { navn: nyttNavn, ikke_ansatt: nyRolle.ikke_ansatt })).id);
      return api<Hentet>("POST", `/org/${org!.id}/ansatte/fra-kunder`, { gruppe_id, ansatt_fra: fra, kunder: liste });
    });
    if (r) ferdig(hentetMelding(r, rollenavn));
  }

  return (
    <form className="oppsett-skjema hent-kunder" onSubmit={hentInn}>
      <p className="liten dempet">
        Velg kundene som skal ha en rolle hos dere, f.eks. legene dere fakturerer. Navnet, e-posten, telefonen og adressen hentes fra kunden, og personen
        kobles til kunden, så den ikke hentes inn to ganger. Finnes personen alt, kobles den og får rollen.
      </p>
      <div className="rad">
        <label>
          Rolle
          <select value={rolle} onChange={(e) => settRolle(e.target.value)}>
            {roller.map((g) => (
              <option key={g.id} value={g.id}>
                {g.navn}
                {g.ikke_ansatt ? " (ikke ansatt)" : ""}
              </option>
            ))}
            <option value={NY_ROLLE}>+ Ny rolle …</option>
          </select>
        </label>
        <label>
          Med fra
          <input type="date" required value={fra} onChange={(e) => settFra(e.target.value)} />
        </label>
      </div>
      {rolle === NY_ROLLE && (
        <>
          <label>
            Navn på den nye rollen
            <input value={nyRolle.navn} maxLength={40} placeholder="F.eks. Lege" onChange={(e) => settNyRolle({ ...nyRolle, navn: e.target.value })} />
          </label>
          <label>
            <input type="checkbox" checked={nyRolle.ikke_ansatt} onChange={(e) => settNyRolle({ ...nyRolle, ikke_ansatt: e.target.checked })} /> Ikke ansatt
          </label>
          <p className="felt-hjelp oppsett-hjelp">For dem som jobber her uten å være ansatt, f.eks. leger som er aksjonærer eller selvstendige: {IKKE_ANSATT_HJELP}.</p>
        </>
      )}
      {!kunder.data ? (
        kunder.feil ? <Feil melding={kunder.feil} /> : <Laster />
      ) : alle.length === 0 ? (
        <p className="dempet">Ingen aktive kunder ennå. Kundene legges inn under Kunder.</p>
      ) : (
        <>
          <input type="search" className="sok" placeholder="Søk etter kunde" aria-label="Søk etter kunde" value={sok} onChange={(e) => settSok(e.target.value)} />
          {valgbare.length > 1 && (
            <label className="hent-alle">
              <input type="checkbox" checked={valgbare.every((k) => valgt[k.id])} onChange={(e) => velgAlle(e.target.checked)} />
              {` Velg alle${s ? " som passer søket" : ""} (${valgbare.length})`}
            </label>
          )}
          <ul className="liste-enkel hent-liste">
            {vises.map((k) => {
              const st = status(k);
              const n = valgt[k.id];
              return (
                <li key={k.id}>
                  <label className="hent-kunde">
                    <input type="checkbox" checked={!!n} disabled={!n && !kanVelges(k)} onChange={(e) => velg(k, e.target.checked)} />
                    <span>
                      <span className="tittel">{k.navn}</span>{" "}
                      <span className="dempet liten">
                        nr. {k.kundenummer}
                        {k.epost ? ` · ${k.epost}` : ""}
                      </span>
                      {st.status !== "ny" && st.person && (
                        <span className="liten dempet hent-status">
                          {st.status === "hentet"
                            ? `Hentet inn som ${st.person.fornavn} ${st.person.etternavn}${rolleTekst(st.person, roller)}`
                            : st.status === "annen"
                              ? `${st.person.fornavn} ${st.person.etternavn} er koblet til en annen kunde`
                              : `Finnes som ${st.person.fornavn} ${st.person.etternavn}${rolleTekst(st.person, roller)}: kobles til kunden og får rollen ${rollenavn}`}
                        </span>
                      )}
                    </span>
                  </label>
                  {/* Navnet kan rettes, også når det er likt navnet til en som finnes. */}
                  {n && (st.status === "ny" || st.via === "navn") && (
                    <div className="rad hent-navn">
                      <label>
                        Fornavn
                        <input required maxLength={100} value={n.fornavn} onChange={(e) => navn(k, { fornavn: e.target.value })} />
                      </label>
                      <label>
                        Etternavn
                        <input required maxLength={100} value={n.etternavn} onChange={(e) => navn(k, { etternavn: e.target.value })} />
                      </label>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
          {treff.length > VIS && (
            <p className="liten dempet">
              Viser {VIS} av {treff.length} kunder. Søk for å finne flere.
            </p>
          )}
          {treff.length === 0 && <p className="dempet">Ingen kunder passer søket.</p>}
        </>
      )}
      <Feil melding={h.feil} />
      <div className="knapper">
        <button className="primar" disabled={h.opptatt || !antall}>
          {antall ? `Hent inn ${antall} som ${rollenavn}` : "Hent inn"}
        </button>
        <button type="button" onClick={avbryt}>
          Avbryt
        </button>
      </div>
    </form>
  );
}

const rolleTekst = (p: Person, roller: Rolle[]) => {
  const r = roller.find((g) => g.id === p.gruppe_id);
  return r ? ` (${r.navn})` : "";
};
