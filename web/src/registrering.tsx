// Person eller organisasjon ved «Opprett konto» (0126_registrering.sql): valget, og oppslaget av
// organisasjonsnummeret i Enhetsregisteret (det åpne /api/brreg, som virker før innloggingen).
// Brukes i registreringen (Innlogging.tsx) og på venteskjermen, der valget kan endres til kontoen
// er godkjent. Den første organisasjonen fylles ut fra valget (NyOrganisasjon.tsx).
import { useEffect, useState, type ReactNode } from "react";
import { orgnr as visOrgnr } from "./format";
import { orgnrGyldig } from "./personnummer";

export type RegistrertSom = "person" | "organisasjon";

// Person: uten organisasjonsnummer, og da bare Faktura (0119_uten_orgnr.sql).
export const REGISTRERING: { som: RegistrertSom; navn: string; tekst: string }[] = [
  { som: "person", navn: "Person", tekst: "Uten organisasjonsnummer, f.eks. utleie av egen bolig eller enkeltoppdrag. Bare Faktura." },
  { som: "organisasjon", navn: "Organisasjon", tekst: "Med organisasjonsnummer: AS, enkeltpersonforetak, forening, regnskapsbyrå og andre." },
];
// Modulene en person får (Personal, Lønn og Regnskap krever organisasjonsnummer).
export const PERSON_MODULER = ["faktura"];

type Registrering = { registrert_som?: RegistrertSom | null; oppgitt_orgnr?: string | null; oppgitt_orgnavn?: string | null };
// «organisasjon: Medinnova AS (org.nr. 936 564 046)» eller «person (uten organisasjonsnummer)».
// Nummeret brytes ikke over to linjer.
export function registreringTekst(r: Registrering): string | null {
  if (r.registrert_som === "person") return "person (uten organisasjonsnummer)";
  if (r.registrert_som === "organisasjon" && r.oppgitt_orgnr)
    return `organisasjon: ${r.oppgitt_orgnavn ? `${r.oppgitt_orgnavn} ` : ""}(org.nr.\u00a0${visOrgnr(r.oppgitt_orgnr).replace(/ /g, "\u00a0")})`;
  return null;
}

export type Enhet = { orgnr: string; navn: string; postnr?: string | null; poststed?: string | null };
export type Enhetsoppslag = {
  // Sifrene, uten mellomrom.
  nr: string;
  status: "tom" | "ufullstendig" | "ugyldig" | "slaar_opp" | "funnet" | "finnes_ikke" | "inaktiv" | "ukjent";
  enhet: Enhet | null;
  // Feilen, eller beskjeden under feltet.
  melding: string | null;
};
// Kan nummeret brukes? Funnet, eller registeret svarte ikke (da ser plattformadministratoren på
// det før kontoen godkjennes).
export const kanBrukes = (o: Enhetsoppslag) => o.status === "funnet" || o.status === "ukjent";

// Slår opp nummeret så snart det er gyldig (9 siffer og riktig kontrollsiffer).
export function useEnhetsoppslag(orgnr: string, aktiv = true): Enhetsoppslag {
  const nr = orgnr.replace(/\s/g, "");
  const gyldig = orgnrGyldig(nr);
  const [svar, settSvar] = useState<Omit<Enhetsoppslag, "nr"> & { for: string } | null>(null);
  useEffect(() => {
    if (!aktiv || !gyldig) return;
    const avbryt = new AbortController();
    fetch(`/api/brreg/${nr}`, { signal: avbryt.signal })
      .then(async (r) => {
        if (r.status === 404)
          return settSvar({ for: nr, status: "finnes_ikke", enhet: null, melding: "Fant ikke organisasjonsnummeret i Enhetsregisteret." });
        if (!r.ok) throw new Error(`Feil ${r.status}`);
        const e = await r.json();
        if (e.konkurs || e.slettet || e.under_avvikling)
          return settSvar({ for: nr, status: "inaktiv", enhet: e, melding: `${e.navn} er konkurs, under avvikling eller slettet i Enhetsregisteret.` });
        settSvar({ for: nr, status: "funnet", enhet: e, melding: null });
      })
      .catch(() => {
        if (!avbryt.signal.aborted)
          settSvar({ for: nr, status: "ukjent", enhet: null, melding: "Enhetsregisteret svarer ikke nå. Nummeret sjekkes før kontoen godkjennes." });
      });
    return () => avbryt.abort();
  }, [nr, gyldig, aktiv]);

  if (!nr) return { nr, status: "tom", enhet: null, melding: null };
  if (!/^\d+$/.test(nr) || nr.length > 9) return { nr, status: "ugyldig", enhet: null, melding: "Organisasjonsnummeret har 9 siffer." };
  if (nr.length < 9) return { nr, status: "ufullstendig", enhet: null, melding: null };
  if (!gyldig) return { nr, status: "ugyldig", enhet: null, melding: "Ugyldig organisasjonsnummer (kontrollsifferet stemmer ikke)." };
  if (!svar || svar.for !== nr) return { nr, status: "slaar_opp", enhet: null, melding: null };
  return { nr, status: svar.status, enhet: svar.enhet, melding: svar.melding };
}

// Feilen som stopper skjemaet, eller null når nummeret kan brukes.
export function oppslagFeil(o: Enhetsoppslag): string | null {
  if (kanBrukes(o)) return null;
  if (o.status === "tom" || o.status === "ufullstendig") return "Skriv inn organisasjonsnummeret (9 siffer).";
  if (o.status === "slaar_opp") return "Vent litt: organisasjonsnummeret slås opp i Enhetsregisteret.";
  return o.melding;
}

// Valget «Registrer deg som»: Person eller Organisasjon, som avkrysningsbokser på blanketten.
export function RegistreringValg({ som, endre, tittel }: { som: RegistrertSom | null; endre: (som: RegistrertSom) => void; tittel: ReactNode }) {
  return (
    <fieldset className="reg-valg">
      <legend>{tittel}</legend>
      {REGISTRERING.map((r) => (
        <label key={r.som} className={som === r.som ? "valgt" : undefined}>
          <input type="radio" name="registrert_som" value={r.som} checked={som === r.som} onChange={() => endre(r.som)} required />
          <span>
            <strong>{r.navn}</strong>
            <span className="dempet">{r.tekst}</span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}

// Organisasjonsnummeret, med svaret fra Enhetsregisteret under feltet.
export function OrgnrFelt({
  orgnr,
  endre,
  oppslag,
  nr,
  klasse = "felt hel",
}: {
  orgnr: string;
  endre: (orgnr: string) => void;
  oppslag: Enhetsoppslag;
  nr?: string;
  klasse?: string;
}) {
  const feil = ["ugyldig", "finnes_ikke", "inaktiv"].includes(oppslag.status);
  const e = oppslag.enhet;
  return (
    <label className={klasse}>
      <span className="lbl">
        {nr && (
          <span className="nr" aria-hidden="true">
            {nr}
          </span>
        )}
        Organisasjonsnummer
      </span>
      <input
        inputMode="numeric"
        autoComplete="off"
        required
        maxLength={11}
        placeholder="9 siffer"
        value={orgnr}
        onChange={(ev) => endre(ev.target.value)}
        aria-invalid={feil || undefined}
        aria-describedby="orgnr-oppslag"
      />
      <span id="orgnr-oppslag" className={`oppslag${feil ? " feil" : ""}`} role="status">
        {oppslag.status === "slaar_opp" ? (
          "Slår opp i Enhetsregisteret …"
        ) : oppslag.status === "funnet" && e ? (
          <>
            <i className="x" aria-hidden="true" />
            <span>
              <b>{e.navn}</b>
              {e.poststed ? `, ${[e.postnr, e.poststed].filter(Boolean).join(" ")}` : ""}
            </span>
          </>
        ) : (
          oppslag.melding
        )}
      </span>
    </label>
  );
}
