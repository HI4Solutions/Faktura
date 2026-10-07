// Ansatte: registeret over de ansatte (personalia, ansettelse og lønn) og deres egen innlogging
// for timeføring (rollen ansatt). Eier og administrator endrer; regnskap ser. Fødselsnummeret
// lagres kryptert og vises aldri igjen, bare at det er registrert.
import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { api, hent } from "../api";
import { Dialog, Feil, Laster, Tom, tall, useData, useHandling, useSmal } from "../felles";
import { kanPersonal, kanSePersonal, useKonto } from "../konto";
import { dato, iDag } from "../format";
import { fnrGyldig, fodselsdato, kontonrGyldig, visKontonr } from "../personnummer";
import { IkonAnsatte } from "../ikoner";

type Ansatt = {
  id: string;
  ansattnummer: number;
  fornavn: string;
  etternavn: string;
  epost: string | null;
  telefon: string | null;
  adresse: string | null;
  postnr: string | null;
  poststed: string | null;
  fodselsdato: string | null;
  har_fnr: boolean;
  kontonr: string | null;
  stilling: string | null;
  stillingsprosent: number;
  ukentlig_arbeidstid: number;
  ansatt_fra: string;
  ansatt_til: string | null;
  ansettelsestype: "fast" | "midlertidig" | "tilkalling";
  lonnstype: "maaned" | "time";
  maanedslonn: number | null;
  timelonn: number | null;
  aktiv: boolean;
  notat: string | null;
  meg: boolean;
  tilgang: "koblet" | "invitert" | null;
};

const ansettelsestype: Record<string, string> = { fast: "Fast", midlertidig: "Midlertidig", tilkalling: "Tilkalling" };
const belop = new Intl.NumberFormat("nb-NO", { maximumFractionDigits: 2 });
const tekstTall = (n: number | null | undefined) => (n == null ? "" : belop.format(n).replace(/\s/g, " "));
const lonn = (a: Ansatt) =>
  a.lonnstype === "maaned" ? (a.maanedslonn != null ? `${belop.format(a.maanedslonn)} kr/mnd` : "") : a.timelonn != null ? `${belop.format(a.timelonn)} kr/t` : "";
const sluttet = (a: Ansatt) => !a.aktiv || (!!a.ansatt_til && a.ansatt_til < iDag());

function Merker({ a }: { a: Ansatt }) {
  return (
    <span className="merker">
      {sluttet(a) && <span className="merke merke-noytral">{a.aktiv ? "Sluttet" : "Ikke aktiv"}</span>}
      {a.tilgang === "koblet" && <span className="merke merke-ok">Innlogging</span>}
      {a.tilgang === "invitert" && <span className="merke merke-info">Invitert</span>}
    </span>
  );
}

export function Ansatte() {
  const { org } = useKonto();
  const [alle, settAlle] = useState(false);
  const [sok, settSok] = useState("");
  const [apen, settApen] = useState<Partial<Ansatt> | null>(null);
  const { data, feil, last } = useData(() => hent<Ansatt[]>(`/org/${org!.id}/ansatte${alle ? "" : "?aktiv=true"}`), [org?.id, alle]);
  const smal = useSmal();
  const endre = kanPersonal(org?.rolle);

  if (!kanSePersonal(org?.rolle) || !org?.personal)
    return (
      <>
        <h1>Ansatte</h1>
        <div className="kort">
          <Tom ikon={<IkonAnsatte storrelse={22} />} tittel={org?.personal ? "Du har ikke tilgang til ansatte" : "Ansatte og timer er ikke slått på"}>
            {!org?.personal && endre && (
              <p>
                Slå det på under <Link to="/innstillinger?fane=personal">Innstillinger → Ansatte og timer</Link>.
              </p>
            )}
          </Tom>
        </div>
      </>
    );

  const s = sok.trim().toLowerCase();
  const liste = (data ?? []).filter((a) => !s || `${a.fornavn} ${a.etternavn} ${a.ansattnummer} ${a.stilling ?? ""} ${a.epost ?? ""}`.toLowerCase().includes(s));
  const lukk = () => {
    settApen(null);
    last();
  };

  return (
    <>
      <div className="topp">
        <h1>Ansatte</h1>
        {endre && (
          <button type="button" className="primar" onClick={() => settApen({})}>
            Ny ansatt
          </button>
        )}
      </div>
      <div className="liste-verktoy">
        <div className="faner" role="tablist">
          {(
            [
              [false, "Aktive"],
              [true, "Alle"],
            ] as const
          ).map(([v, t]) => (
            <button key={t} type="button" role="tab" aria-selected={alle === v} className={alle === v ? "valgt" : undefined} onClick={() => settAlle(v)}>
              {t}
            </button>
          ))}
        </div>
        {(data?.length ?? 0) > 6 && <input type="search" className="sok" placeholder="Søk etter navn eller stilling" value={sok} onChange={(e) => settSok(e.target.value)} />}
      </div>
      <Feil melding={feil} />
      {!data ? (
        !feil && <Laster />
      ) : !data.length ? (
        <div className="kort">
          <Tom ikon={<IkonAnsatte storrelse={22} />} tittel={alle ? "Ingen ansatte ennå" : "Ingen aktive ansatte"}>
            <p>
              Legg inn de ansatte med stilling og lønn. De kan få egen innlogging og føre timene sine selv, og du godkjenner dem under{" "}
              <Link to="/timer">Timer</Link>.
            </p>
            {endre && (
              <button type="button" className="primar" onClick={() => settApen({})}>
                Ny ansatt
              </button>
            )}
          </Tom>
        </div>
      ) : smal ? (
        <div className="kort liste">
          {liste.map((a) => (
            <button key={a.id} type="button" className="liste-rad" onClick={() => settApen(a)}>
              <span className="linje">
                <span className="tittel">
                  {a.fornavn} {a.etternavn}
                </span>
                <span className="under">Nr. {a.ansattnummer}</span>
              </span>
              <span className="linje">
                <span className="under">
                  {[a.stilling, `${belop.format(a.stillingsprosent)} %`, lonn(a)].filter(Boolean).join(" · ")}
                </span>
                <Merker a={a} />
              </span>
            </button>
          ))}
          {!liste.length && <p className="dempet ingen-enna" style={{ padding: 16 }}>Ingen ansatte passer søket.</p>}
        </div>
      ) : (
        <div className="kort tabell">
          <table>
            <thead>
              <tr>
                <th>Nr.</th>
                <th>Navn</th>
                <th>Stilling</th>
                <th className="tall">Stilling %</th>
                <th className="tall">Lønn</th>
                <th>Ansatt fra</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {liste.map((a) => (
                <tr key={a.id} className="klikkbar" onClick={() => settApen(a)}>
                  <td>{a.ansattnummer}</td>
                  <td>
                    {a.fornavn} {a.etternavn}
                    {a.meg && <span className="dempet"> (deg)</span>}
                  </td>
                  <td>{a.stilling}</td>
                  <td className="tall">{belop.format(a.stillingsprosent)} %</td>
                  <td className="tall">{lonn(a)}</td>
                  <td>{dato(a.ansatt_fra)}</td>
                  <td>
                    <Merker a={a} />
                  </td>
                </tr>
              ))}
              {!liste.length && (
                <tr>
                  <td colSpan={7} className="dempet">
                    Ingen ansatte passer søket.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      <Dialog apen={!!apen} lukk={lukk} tittel={apen?.id ? `${apen.fornavn} ${apen.etternavn}` : "Ny ansatt"} bred>
        {apen && (
          <AnsattSkjema
            ansatt={apen}
            kanEndre={endre}
            oppdatert={(a) => {
              settApen(a);
              last();
            }}
            lukk={lukk}
          />
        )}
      </Dialog>
    </>
  );
}

function AnsattSkjema({ ansatt, kanEndre, oppdatert, lukk }: { ansatt: Partial<Ansatt>; kanEndre: boolean; oppdatert: (a: Ansatt) => void; lukk: () => void }) {
  const { org } = useKonto();
  const [a, settA] = useState(() => ({
    fornavn: ansatt.fornavn ?? "",
    etternavn: ansatt.etternavn ?? "",
    epost: ansatt.epost ?? "",
    telefon: ansatt.telefon ?? "",
    adresse: ansatt.adresse ?? "",
    postnr: ansatt.postnr ?? "",
    poststed: ansatt.poststed ?? "",
    fodselsdato: ansatt.fodselsdato ?? "",
    fnr: "",
    endreFnr: !ansatt.har_fnr,
    fjernFnr: false,
    kontonr: visKontonr(ansatt.kontonr),
    stilling: ansatt.stilling ?? "",
    stillingsprosent: tekstTall(ansatt.stillingsprosent ?? 100),
    ukentlig_arbeidstid: tekstTall(ansatt.ukentlig_arbeidstid ?? 37.5),
    ansatt_fra: ansatt.ansatt_fra ?? iDag(),
    ansatt_til: ansatt.ansatt_til ?? "",
    ansettelsestype: ansatt.ansettelsestype ?? "fast",
    lonnstype: ansatt.lonnstype ?? "maaned",
    maanedslonn: tekstTall(ansatt.maanedslonn),
    timelonn: tekstTall(ansatt.timelonn),
    aktiv: ansatt.aktiv ?? true,
    notat: ansatt.notat ?? "",
  }));
  const [forlatt, settForlatt] = useState<Record<string, boolean>>({});
  const [melding, settMelding] = useState<string | null>(null);
  const h = useHandling();
  const sett = (e: Partial<typeof a>) => settA({ ...a, ...e });
  const felt = (navn: keyof typeof a) => ({
    value: String(a[navn] ?? ""),
    onChange: (e: { target: { value: string } }) => sett({ [navn]: e.target.value } as Partial<typeof a>),
    onBlur: () => settForlatt((f) => ({ ...f, [navn]: true })),
  });

  const fnr = a.fnr.replace(/[\s.]/g, "");
  const fnrFeil = a.endreFnr && fnr && forlatt.fnr && !fnrGyldig(fnr) ? "Fødselsnummeret er ikke gyldig (sjekk sifrene)" : null;
  const kontonr = a.kontonr.replace(/[\s.]/g, "");
  const kontonrFeil = kontonr && forlatt.kontonr && !kontonrGyldig(kontonr) ? "Kontonummeret er ikke gyldig (sjekk sifrene)" : null;
  const maaned = a.lonnstype === "maaned" && a.maanedslonn ? tall(a.maanedslonn) : null;

  async function lagre(e: FormEvent) {
    e.preventDefault();
    settMelding(null);
    const tallEllerNull = (s: string) => (s.trim() ? tall(s) : null);
    const kropp: Record<string, unknown> = {
      fornavn: a.fornavn,
      etternavn: a.etternavn,
      epost: a.epost,
      telefon: a.telefon,
      adresse: a.adresse,
      postnr: a.postnr,
      poststed: a.poststed,
      kontonr: a.kontonr,
      stilling: a.stilling,
      ansatt_fra: a.ansatt_fra,
      ansatt_til: a.ansatt_til,
      ansettelsestype: a.ansettelsestype,
      lonnstype: a.lonnstype,
      maanedslonn: a.lonnstype === "maaned" ? tallEllerNull(a.maanedslonn) : null,
      timelonn: a.lonnstype === "time" ? tallEllerNull(a.timelonn) : null,
      notat: a.notat,
      aktiv: a.aktiv,
    };
    if (a.stillingsprosent.trim()) kropp.stillingsprosent = tall(a.stillingsprosent);
    if (a.ukentlig_arbeidstid.trim()) kropp.ukentlig_arbeidstid = tall(a.ukentlig_arbeidstid);
    // Fødselsnummeret sendes bare når det er skrevet inn eller skal fjernes; ellers fødselsdatoen.
    if (a.fjernFnr) kropp.fnr = null;
    else if (a.endreFnr && fnr) kropp.fnr = fnr;
    if (!kropp.fnr) kropp.fodselsdato = a.fodselsdato;
    const ny = !ansatt.id;
    const r = await h.kjor(() => (ny ? api<Ansatt>("POST", `/org/${org!.id}/ansatte`, kropp) : api<Ansatt>("PATCH", `/org/${org!.id}/ansatte/${ansatt.id}`, kropp)));
    if (!r) return;
    if (!ny) return lukk();
    // Ny ansatt: bli i skjemaet, så man kan gi innlogging med en gang.
    settA({ ...a, fnr: "", endreFnr: !r.har_fnr, fjernFnr: false, fodselsdato: r.fodselsdato ?? "" });
    settMelding(`${r.fornavn} er lagt inn som ansatt nr. ${r.ansattnummer}.`);
    oppdatert(r);
  }

  async function slett() {
    if (!confirm(`Slette ${ansatt.fornavn} ${ansatt.etternavn}? Det går bare for ansatte uten timer. Har den ansatte sluttet, setter du en sluttdato i stedet.`)) return;
    const r = await h.kjor(async () => (await api("DELETE", `/org/${org!.id}/ansatte/${ansatt.id}`), true));
    if (r) lukk();
  }

  return (
    <form onSubmit={lagre}>
      {melding && (
        <div className="melding ok" role="status">
          {melding}
        </div>
      )}
      <fieldset className="naken" disabled={!kanEndre}>
        <div className="rad">
          <label>
            Fornavn
            <input required autoComplete="off" {...felt("fornavn")} />
          </label>
          <label>
            Etternavn
            <input required autoComplete="off" {...felt("etternavn")} />
          </label>
        </div>
        <div className="rad">
          <label>
            E-post
            <input type="email" autoComplete="off" {...felt("epost")} />
            <span className="felt-hjelp">Til innloggingen og lønnsslippene.</span>
          </label>
          <label>
            Telefon
            <input type="tel" autoComplete="off" {...felt("telefon")} />
          </label>
        </div>
        <label>
          Adresse
          <input autoComplete="off" {...felt("adresse")} />
        </label>
        <div className="rad">
          <label>
            Postnr.
            <input inputMode="numeric" maxLength={4} autoComplete="off" {...felt("postnr")} />
          </label>
          <label>
            Poststed
            <input autoComplete="off" {...felt("poststed")} />
          </label>
        </div>
        <div className="rad">
          {a.endreFnr ? (
            <label>
              Fødselsnummer
              <input
                inputMode="numeric"
                autoComplete="off"
                spellCheck={false}
                maxLength={13}
                placeholder={ansatt.har_fnr ? "Nytt fødselsnummer" : "11 siffer (eller D-nummer)"}
                aria-invalid={!!fnrFeil || undefined}
                value={a.fnr}
                onChange={(e) => {
                  const ren = e.target.value.replace(/[\s.]/g, "");
                  const fodt = fnrGyldig(ren) ? fodselsdato(ren) : null;
                  sett({ fnr: e.target.value, ...(fodt ? { fodselsdato: fodt } : {}) });
                }}
                onBlur={() => settForlatt((f) => ({ ...f, fnr: true }))}
              />
              {fnrFeil ? <span className="felt-feil">{fnrFeil}</span> : <span className="felt-hjelp">Lagres kryptert og vises ikke igjen. Trengs til a-meldingen.</span>}
            </label>
          ) : (
            <div className="felt">
              Fødselsnummer
              <div className="felt-verdi">
                <span>{a.fjernFnr ? "Fjernes når du lagrer" : "Registrert"}</span>
                {kanEndre && !a.fjernFnr && (
                  <span className="knapper">
                    <button type="button" className="lenke" onClick={() => sett({ endreFnr: true })}>
                      Endre
                    </button>
                    <button type="button" className="lenke fare" onClick={() => sett({ fjernFnr: true })}>
                      Fjern
                    </button>
                  </span>
                )}
                {a.fjernFnr && (
                  <button type="button" className="lenke" onClick={() => sett({ fjernFnr: false })}>
                    Angre
                  </button>
                )}
              </div>
              <span className="felt-hjelp">Lagres kryptert og vises aldri.</span>
            </div>
          )}
          <label>
            Fødselsdato
            {/* Med fødselsnummer følger datoen av det. */}
            <input type="date" max={iDag()} {...felt("fodselsdato")} disabled={!kanEndre || (a.endreFnr ? fnrGyldig(fnr) : !a.fjernFnr)} />
          </label>
        </div>
        <label>
          Kontonummer for lønn
          <input inputMode="numeric" autoComplete="off" spellCheck={false} aria-invalid={!!kontonrFeil || undefined} placeholder="1234 56 78903" {...felt("kontonr")} />
          {kontonrFeil && <span className="felt-feil">{kontonrFeil}</span>}
        </label>

        <h3>Ansettelse</h3>
        <div className="rad">
          <label>
            Stilling
            <input placeholder="F.eks. butikkmedarbeider" {...felt("stilling")} />
          </label>
          <label>
            Ansettelse
            <select {...felt("ansettelsestype")}>
              {Object.entries(ansettelsestype).map(([v, t]) => (
                <option key={v} value={v}>
                  {t}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="rad">
          <label>
            Stillingsprosent
            <input inputMode="decimal" {...felt("stillingsprosent")} />
          </label>
          <label>
            Arbeidstid i full stilling
            <input inputMode="decimal" {...felt("ukentlig_arbeidstid")} />
            <span className="felt-hjelp">Timer per uke, vanligvis 37,5.</span>
          </label>
        </div>
        <div className="rad">
          <label>
            Ansatt fra
            <input type="date" required {...felt("ansatt_fra")} />
          </label>
          <label>
            Sluttdato
            <input type="date" min={a.ansatt_fra} {...felt("ansatt_til")} />
            <span className="felt-hjelp">Tom hvis den ansatte fortsatt jobber her.</span>
          </label>
        </div>

        <h3>Lønn</h3>
        <div className="rad">
          <label>
            Lønnstype
            <select {...felt("lonnstype")}>
              <option value="maaned">Fast månedslønn</option>
              <option value="time">Timelønn</option>
            </select>
          </label>
          {a.lonnstype === "maaned" ? (
            <label>
              Månedslønn (kr)
              <input inputMode="decimal" {...felt("maanedslonn")} />
              {maaned != null && Number.isFinite(maaned) && <span className="felt-hjelp">{belop.format(maaned * 12)} kr i året</span>}
            </label>
          ) : (
            <label>
              Timelønn (kr)
              <input inputMode="decimal" {...felt("timelonn")} />
            </label>
          )}
        </div>
        <label>
          Notat
          <textarea rows={2} {...felt("notat")} />
        </label>
        {ansatt.id && (
          <label>
            <input type="checkbox" checked={a.aktiv} onChange={(e) => sett({ aktiv: e.target.checked })} />
            Aktiv (kan føre timer)
          </label>
        )}
      </fieldset>
      {ansatt.id && <Tilgang ansatt={ansatt as Ansatt} kanEndre={kanEndre} epostEndret={(a.epost.trim().toLowerCase() || null) !== (ansatt.epost ?? null)} oppdatert={oppdatert} />}
      <Feil melding={h.feil} />
      <div className="knapper">
        {kanEndre && (
          <button className="primar" disabled={h.opptatt}>
            Lagre
          </button>
        )}
        <button type="button" onClick={lukk}>
          {kanEndre ? (melding ? "Ferdig" : "Avbryt") : "Lukk"}
        </button>
        {ansatt.id && kanEndre && (
          <button type="button" className="fare" style={{ marginLeft: "auto" }} disabled={h.opptatt} onClick={slett}>
            Slett ansatt
          </button>
        )}
      </div>
    </form>
  );
}

// Egen innlogging: invitasjon på e-post med rollen ansatt (den ansatte ser bare sine egne timer).
function Tilgang({ ansatt: a, kanEndre, epostEndret, oppdatert }: { ansatt: Ansatt; kanEndre: boolean; epostEndret: boolean; oppdatert: (a: Ansatt) => void }) {
  const { org, oppdater } = useKonto();
  const h = useHandling();
  const [svar, settSvar] = useState<{ koblet: boolean; lenke: string | null; sendt_til: string | null } | null>(null);
  const hentPaNytt = async () => oppdatert(await hent<Ansatt>(`/org/${org!.id}/ansatte/${a.id}`));

  const inviter = () =>
    h.kjor(async () => {
      const r = await api("POST", `/org/${org!.id}/ansatte/${a.id}/inviter`);
      settSvar(r);
      await hentPaNytt();
      // Koblet med en gang (kanskje til en selv): menyen og «Mine timer» oppdateres.
      if (r.koblet) await oppdater();
    });
  const fjern = () =>
    h.kjor(async () => {
      if (!confirm(a.tilgang === "invitert" ? `Trekke tilbake invitasjonen til ${a.fornavn}?` : `Fjerne innloggingen til ${a.fornavn}? Timene blir liggende.`)) return;
      await api("DELETE", `/org/${org!.id}/ansatte/${a.id}/tilgang`);
      settSvar(null);
      await hentPaNytt();
      if (a.meg) await oppdater();
    });

  return (
    <div className="tilgang">
      <h3>Innlogging</h3>
      {a.tilgang === "koblet" ? (
        <p>
          {a.meg ? "Dette er deg: du fører egne timer under Timer → Mine timer." : `${a.fornavn} har egen innlogging og fører timene sine selv.`}
        </p>
      ) : a.tilgang === "invitert" ? (
        <p>
          Invitert på e-post til {a.epost}. Venter på at {a.fornavn} åpner lenken og logger inn.
        </p>
      ) : (
        <p className="dempet">
          Med egen innlogging fører {a.fornavn} timene sine selv og leverer uka til godkjenning. Den ansatte ser bare sine egne timer.
        </p>
      )}
      {svar &&
        (svar.koblet ? (
          <div className="melding ok">{a.fornavn} var allerede med i organisasjonen og er nå koblet til ansattkortet.</div>
        ) : (
          <div className="melding ok">
            Invitasjonen er sendt til {svar.sendt_til}. Du kan også sende lenken selv; den gjelder i sju dager:
            <br />
            <code className="hemmelig">{svar.lenke}</code>
          </div>
        ))}
      {kanEndre && (
        <div className="knapper">
          {a.tilgang !== "koblet" && (
            <button type="button" disabled={h.opptatt || !a.epost || epostEndret || !a.aktiv} onClick={inviter}>
              {a.tilgang === "invitert" ? "Send invitasjonen på nytt" : "Gi innlogging"}
            </button>
          )}
          {a.tilgang && (
            <button type="button" className="fare" disabled={h.opptatt} onClick={fjern}>
              {a.tilgang === "invitert" ? "Trekk tilbake" : a.meg ? "Koble fra meg" : "Fjern innloggingen"}
            </button>
          )}
          {a.tilgang !== "koblet" && (!a.epost || epostEndret) && (
            <span className="liten dempet">{epostEndret ? "Lagre e-postadressen først." : "Legg inn e-postadressen først."}</span>
          )}
          {a.tilgang !== "koblet" && a.epost && !epostEndret && !a.aktiv && <span className="liten dempet">Den ansatte er ikke aktiv.</span>}
        </div>
      )}
      <Feil melding={h.feil} />
    </div>
  );
}
