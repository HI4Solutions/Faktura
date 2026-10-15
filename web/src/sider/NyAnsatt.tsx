// Ny ansatt i tre korte steg: hvem (og hvem som fyller ut resten), ansettelsen og lønnen. Den
// ansatte kan fylle ut fødselsnummer, kontonummer, adresse og pårørende selv (invitasjon på e-post,
// lederen godkjenner; AnsattUtfylling.tsx), eller lederen fyller ut alt nå. Resten (rolle,
// arbeidsplan, tillegg, skattekort for hånd …) står i hele ansattkortet (Ansatte.tsx).
import { useState } from "react";
import { api, hent } from "../api";
import { Feil, tall, useData, useHandling } from "../felles";
import { harFunksjon, useKonto } from "../konto";
import { iDag } from "../format";
import { fnrGyldig, kontonrGyldig } from "../personnummer";
import { YrkeskodeFelt } from "./Yrkeskode";

type Lagret = { id: string; fornavn: string; ansattnummer: number };
const STEG = ["Hvem", "Ansettelse", "Lønn"] as const;

export function NyAnsatt({ ferdig, heleSkjemaet }: { ferdig: (a: Lagret | null) => void; heleSkjemaet: () => void }) {
  const { org } = useKonto();
  const medLonn = harFunksjon(org, "lonn");
  const oppsett = useData(() => hent<{ full_stilling: number }>(`/org/${org!.id}/lonn-oppsett`), [org?.id]);
  const [steg, settSteg] = useState(0);
  const [selv, settSelv] = useState(true); // den ansatte fyller ut resten selv
  const [s, settS] = useState({
    fornavn: "",
    etternavn: "",
    epost: "",
    telefon: "",
    fnr: "",
    kontonr: "",
    stilling: "",
    ansettelsestype: "fast",
    stillingsprosent: "100",
    ansatt_fra: iDag(),
    yrkeskode: "",
    lonnstype: "maaned" as "maaned" | "time",
    belop: "",
  });
  const [resultat, settResultat] = useState<{ a: Lagret; sendt_til: string | null } | null>(null);
  const h = useHandling();
  const sett = (e: Partial<typeof s>) => settS((x) => ({ ...x, ...e }));
  const fnr = s.fnr.replace(/[\s.]/g, "");
  const kontonr = s.kontonr.replace(/[\s.]/g, "");

  // Det som må være på plass før neste steg.
  function sjekk(i: number): string | null {
    if (i === 0) {
      if (!s.fornavn.trim() || !s.etternavn.trim()) return "Skriv fornavn og etternavn.";
      if (selv && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s.epost.trim())) return "Skriv e-postadressen: den ansatte får invitasjonen dit.";
      if (!selv && fnr && !fnrGyldig(fnr)) return "Fødselsnummeret er ikke gyldig (sjekk sifrene).";
      if (!selv && kontonr && !kontonrGyldig(kontonr)) return "Kontonummeret er ikke gyldig (sjekk sifrene).";
    }
    if (i === 1) {
      const p = tall(s.stillingsprosent);
      if (!(p > 0 && p <= 100)) return "Stillingsprosenten må være mellom 0 og 100.";
      if (!s.ansatt_fra) return "Velg datoen den ansatte begynner.";
    }
    return null;
  }
  const neste = () => {
    const f = sjekk(steg);
    if (f) return h.settFeil(f);
    h.settFeil(null);
    settSteg(steg + 1);
  };

  async function lagre() {
    for (const i of [0, 1, 2]) {
      const f = sjekk(i);
      if (f) return h.settFeil(f);
    }
    const belop = s.belop.trim() ? tall(s.belop) : null;
    const kropp: Record<string, unknown> = {
      fornavn: s.fornavn,
      etternavn: s.etternavn,
      epost: s.epost,
      telefon: s.telefon,
      stilling: s.stilling,
      ansettelsestype: s.ansettelsestype,
      stillingsprosent: tall(s.stillingsprosent),
      ansatt_fra: s.ansatt_fra,
      lonnstype: s.lonnstype,
      maanedslonn: s.lonnstype === "maaned" ? belop : null,
      timelonn: s.lonnstype === "time" ? belop : null,
      ...(oppsett.data ? { ukentlig_arbeidstid: Number(oppsett.data.full_stilling) } : {}),
    };
    if (s.yrkeskode) kropp.yrkeskode = s.yrkeskode;
    if (!selv) {
      if (fnr) kropp.fnr = fnr;
      if (kontonr) kropp.kontonr = kontonr;
    }
    const r = await h.kjor(async () => {
      const a = await api<Lagret>("POST", `/org/${org!.id}/ansatte`, kropp);
      // Invitasjonen med beskjed om å fylle ut (den ansatte er lagt inn selv om den feiler).
      if (!selv) return { a, sendt_til: null };
      try {
        const inv = await api<{ sendt_til: string | null }>("POST", `/org/${org!.id}/ansatte/${a.id}/inviter`, { utfylling: true });
        return { a, sendt_til: inv.sendt_til };
      } catch (e) {
        h.settFeil(`${a.fornavn} er lagt inn, men invitasjonen ble ikke sendt: ${(e as Error).message}`);
        return { a, sendt_til: null };
      }
    });
    if (r) settResultat(r);
  }

  if (resultat)
    return (
      <div className="ny-ansatt">
        <div className="melding ok" role="status">
          {resultat.a.fornavn} er lagt inn som ansatt nr. {resultat.a.ansattnummer}.
          {resultat.sendt_til && ` Invitasjonen er sendt til ${resultat.sendt_til}: ${resultat.a.fornavn} logger inn og fyller ut resten, og du får varsel når det er klart til godkjenning.`}
        </div>
        <Feil melding={h.feil} />
        <div className="knapper">
          <button type="button" className="primar" onClick={() => ferdig(resultat.a)}>
            Åpne ansattkortet
          </button>
          <button
            type="button"
            onClick={() => {
              settResultat(null);
              settSteg(0);
              h.settFeil(null);
              settS((x) => ({ ...x, fornavn: "", etternavn: "", epost: "", telefon: "", fnr: "", kontonr: "", belop: "" }));
            }}
          >
            Legg inn en til
          </button>
          <button type="button" onClick={() => ferdig(null)}>
            Ferdig
          </button>
        </div>
      </div>
    );

  return (
    <form
      className="ny-ansatt"
      onSubmit={(e) => {
        e.preventDefault();
        if (steg < STEG.length - 1) neste();
        else void lagre();
      }}
    >
      <ol className="steg-viser" aria-label="Steg">
        {STEG.map((navn, i) => (
          <li key={navn} className={i === steg ? "aktiv" : i < steg ? "ferdig" : undefined} aria-current={i === steg ? "step" : undefined}>
            <span className="steg-nr">{i + 1}</span> {navn}
          </li>
        ))}
      </ol>

      {steg === 0 && (
        <>
          <div className="rad">
            <label>
              Fornavn
              <input required autoFocus autoComplete="off" value={s.fornavn} onChange={(e) => sett({ fornavn: e.target.value })} />
            </label>
            <label>
              Etternavn
              <input required autoComplete="off" value={s.etternavn} onChange={(e) => sett({ etternavn: e.target.value })} />
            </label>
          </div>
          <div className="rad">
            <label>
              E-post
              <input type="email" autoComplete="off" value={s.epost} onChange={(e) => sett({ epost: e.target.value })} />
            </label>
            <label>
              Telefon
              <input type="tel" autoComplete="off" value={s.telefon} onChange={(e) => sett({ telefon: e.target.value })} />
            </label>
          </div>
          <fieldset className="valg-kort">
            <legend>Fødselsnummer, kontonummer, adresse og pårørende</legend>
            <label className={selv ? "valgt" : undefined}>
              <input type="radio" name="hvem" checked={selv} onChange={() => settSelv(true)} />
              <span>
                <strong>Den ansatte fyller ut selv</strong>
                <span className="felt-hjelp">Får invitasjon på e-post, logger inn og fyller ut. Du ser over og godkjenner før det lagres.</span>
              </span>
            </label>
            <label className={!selv ? "valgt" : undefined}>
              <input type="radio" name="hvem" checked={!selv} onChange={() => settSelv(false)} />
              <span>
                <strong>Jeg fyller ut nå</strong>
                <span className="felt-hjelp">Fødselsnummer og kontonummer her; adressen og resten i ansattkortet etterpå.</span>
              </span>
            </label>
          </fieldset>
          {!selv && (
            <div className="rad">
              <label>
                Fødselsnummer
                <input inputMode="numeric" autoComplete="off" spellCheck={false} maxLength={13} placeholder="11 siffer (eller D-nummer)" value={s.fnr} onChange={(e) => sett({ fnr: e.target.value })} />
                <span className="felt-hjelp">Lagres kryptert. Skattekortet hentes når det er registrert.</span>
              </label>
              <label>
                Kontonummer for lønn
                <input inputMode="numeric" autoComplete="off" spellCheck={false} placeholder="1234 56 78903" value={s.kontonr} onChange={(e) => sett({ kontonr: e.target.value })} />
              </label>
            </div>
          )}
        </>
      )}

      {steg === 1 && (
        <>
          <div className="rad">
            <label>
              Stilling
              <input placeholder="F.eks. butikkmedarbeider" value={s.stilling} onChange={(e) => sett({ stilling: e.target.value })} />
            </label>
            <label>
              Ansettelse
              <select value={s.ansettelsestype} onChange={(e) => sett({ ansettelsestype: e.target.value })}>
                <option value="fast">Fast</option>
                <option value="midlertidig">Midlertidig</option>
                <option value="tilkalling">Tilkalling</option>
              </select>
            </label>
          </div>
          <div className="rad">
            <label>
              Stillingsprosent
              <input inputMode="decimal" value={s.stillingsprosent} onChange={(e) => sett({ stillingsprosent: e.target.value })} />
            </label>
            <label>
              Begynner
              <input type="date" required value={s.ansatt_fra} onChange={(e) => sett({ ansatt_fra: e.target.value })} />
            </label>
          </div>
          {medLonn && (
            <label>
              Yrkeskode (til a-meldingen)
              <YrkeskodeFelt verdi={s.yrkeskode} endre={(k) => sett({ yrkeskode: k })} />
            </label>
          )}
        </>
      )}

      {steg === 2 && (
        <>
          <div className="rad">
            <label>
              Lønn
              <select value={s.lonnstype} onChange={(e) => sett({ lonnstype: e.target.value as "maaned" | "time" })}>
                <option value="maaned">Fastlønn per måned</option>
                <option value="time">Timelønn</option>
              </select>
            </label>
            <label>
              {s.lonnstype === "maaned" ? "Månedslønn (kr)" : "Timelønn (kr)"}
              <input inputMode="decimal" value={s.belop} onChange={(e) => sett({ belop: e.target.value })} />
            </label>
          </div>
          <p className="felt-hjelp">
            {medLonn
              ? "Skattekortet hentes fra Skatteetaten når fødselsnummeret er registrert (med koblingen under Innstillinger → Lønn → Skattekort). Faste tillegg, arbeidsplan og rolle legger du inn i ansattkortet."
              : "Faste tillegg, arbeidsplan og rolle legger du inn i ansattkortet."}
          </p>
        </>
      )}

      <Feil melding={h.feil} />
      <div className="knapper">
        {steg > 0 && (
          <button type="button" onClick={() => (h.settFeil(null), settSteg(steg - 1))}>
            Tilbake
          </button>
        )}
        <button className="primar" disabled={h.opptatt}>
          {steg < STEG.length - 1 ? "Neste" : selv ? "Lagre og send invitasjon" : "Lagre"}
        </button>
        <button type="button" className="lenke" style={{ marginLeft: "auto" }} onClick={heleSkjemaet}>
          Bruk hele skjemaet
        </button>
      </div>
    </form>
  );
}
