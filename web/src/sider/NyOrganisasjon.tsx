import { useEffect, useState, type FormEvent } from "react";
import { api, hent } from "../api";
import { AvtaleAvkrysning, useAvtaler, versjoner } from "../avtaler";
import { Feil, useHandling } from "../felles";
import { useKonto } from "../konto";
import { orgnr as visOrgnr } from "../format";
import { orgnrGyldig } from "../personnummer";

type Type = "foretak" | "privatperson" | "regnskapsbyraa";

// Valgene øverst i skjemaet. Uten organisasjonsnummer (privatperson) er det bare Faktura
// (0119_uten_orgnr.sql); nummeret kan legges inn senere under Innstillinger → Organisasjon.
const TYPER: { type: Type; navn: string; tekst: string }[] = [
  { type: "foretak", navn: "Foretak", tekst: "AS, enkeltpersonforetak og andre med organisasjonsnummer. Faktura, Personal, Lønn og Regnskap." },
  {
    type: "privatperson",
    navn: "Privatperson",
    tekst: "Uten organisasjonsnummer og mva, f.eks. utleie av egen bolig eller enkeltoppdrag. Bare Faktura.",
  },
  { type: "regnskapsbyraa", navn: "Regnskapsbyrå", tekst: "Fører regnskapet for klienter som gir byrået tilgang." },
];

// opprettet kalles når organisasjonen er laget og valgt, så den som viser skjemaet kan lukke det.
export function NyOrganisasjon({ avbryt, opprettet }: { avbryt?: () => void; opprettet?: () => void }) {
  const { oppdater, velgOrg, meg } = useKonto();
  const [type, settType] = useState<Type>("foretak");
  const [orgnr, settOrgnr] = useState("");
  const [oppslag, settOppslag] = useState<any>(null);
  const [navn, settNavn] = useState("");
  // Bruksvilkårene og databehandleravtalen godtas når organisasjonen opprettes (versjonene lagres).
  const { avtaler, feil: avtalefeil } = useAvtaler();
  const [godtatt, settGodtatt] = useState(false);
  const { opptatt, feil, kjor, settFeil } = useHandling();

  // Uten Faktura blant brukerens moduler er det ingenting en privatperson kan bruke.
  const moduler = meg?.bruker?.moduler;
  const typer = TYPER.filter((t) => t.type !== "privatperson" || !moduler?.length || moduler.includes("faktura"));
  const privat = type === "privatperson";
  const nr = orgnr.replace(/\s/g, "");
  const nrFeil = !privat && nr.length === 9 && !orgnrGyldig(nr) ? "Ugyldig organisasjonsnummer (kontrollsifferet stemmer ikke)" : null;
  const kanOpprette = !!navn.trim() && (privat || orgnrGyldig(nr)) && !!avtaler && godtatt;

  async function slaOpp(n = nr) {
    settOppslag(null);
    const e = await kjor(() => hent(`/brreg/${n}`));
    if (!e) return;
    if (e.konkurs || e.slettet || e.under_avvikling) {
      settFeil("Foretaket er konkurs, under avvikling eller slettet i Enhetsregisteret.");
      return;
    }
    settOppslag(e);
    settNavn(e.navn);
  }

  // Slås opp så snart nummeret er gyldig (knappen er der for et nytt forsøk).
  useEffect(() => {
    if (!privat && orgnrGyldig(nr) && oppslag?.orgnr !== nr) void slaOpp(nr);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nr, privat]);

  function velgType(ny: Type) {
    settType(ny);
    settFeil(null);
    if (ny === "privatperson") {
      settOppslag(null);
      if (!navn || navn === oppslag?.navn) settNavn(meg?.bruker?.navn ?? "");
    }
  }

  async function opprett(ev: FormEvent) {
    ev.preventDefault();
    if (!kanOpprette || !avtaler) return;
    const o = await kjor(async () => {
      const o = await api("POST", "/organisasjoner", { navn: navn.trim(), orgnr: privat ? null : nr, type, avtaler: versjoner(avtaler) });
      if (!privat && oppslag?.orgnr === nr) {
        await api("PATCH", `/org/${o.id}`, {
          adresse: oppslag.adresse,
          postnr: oppslag.postnr,
          poststed: oppslag.poststed,
          mva_registrert: oppslag.mva_registrert,
          foretaksregisteret: oppslag.foretaksregisteret,
        });
      }
      return o;
    });
    if (o) {
      velgOrg(o.id);
      await oppdater();
      opprettet?.();
    }
  }

  return (
    <form className="kort ny-organisasjon" onSubmit={opprett} style={{ maxWidth: 560 }}>
      <h2 style={{ marginTop: 0 }}>Ny organisasjon</h2>
      <fieldset className="valg-kort stablet">
        <legend>Hvem skal fakturere?</legend>
        {typer.map((t) => (
          <label key={t.type} className={type === t.type ? "valgt" : undefined}>
            <input type="radio" name="type" checked={type === t.type} onChange={() => velgType(t.type)} />
            <span>
              <strong>{t.navn}</strong>
              <span className="felt-hjelp">{t.tekst}</span>
            </span>
          </label>
        ))}
      </fieldset>
      {privat ? (
        <p className="liten dempet">
          Fakturaene sendes i ditt navn. Personal, Lønn og Regnskap krever organisasjonsnummer: får du det senere (f.eks. et
          enkeltpersonforetak), legger du det inn under Innstillinger → Organisasjon, så blir resten tilgjengelig. Har du
          enkeltpersonforetak allerede, velg «Foretak»; der kan du velge å sende fakturaene med ditt eget navn.
        </p>
      ) : (
        <>
          <label>
            Organisasjonsnummer
            <div className="knapper">
              <input
                style={{ flex: 1 }}
                inputMode="numeric"
                autoComplete="off"
                required
                value={orgnr}
                onChange={(e) => settOrgnr(e.target.value)}
                placeholder="9 siffer"
                aria-invalid={nrFeil ? true : undefined}
              />
              <button type="button" onClick={() => void slaOpp()} disabled={opptatt || !orgnrGyldig(nr)}>
                Slå opp
              </button>
            </div>
          </label>
          {nrFeil && <p className="felt-feil">{nrFeil}</p>}
          {!oppslag && typer.some((t) => t.type === "privatperson") && (
            <p className="liten dempet">
              Har du ikke organisasjonsnummer?{" "}
              <button type="button" className="lenke" onClick={() => velgType("privatperson")}>
                Fakturer som privatperson
              </button>{" "}
              – nummeret kan legges inn senere.
            </p>
          )}
        </>
      )}
      {oppslag && !privat && (
        <div className="melding info">
          {oppslag.navn}, org.nr. {visOrgnr(oppslag.orgnr)}
          <br />
          {[oppslag.adresse, [oppslag.postnr, oppslag.poststed].filter(Boolean).join(" ")].filter(Boolean).join(", ")}
          {oppslag.mva_registrert ? " · MVA-registrert" : ""}
        </div>
      )}
      <label>
        {privat ? "Ditt navn" : "Navn"}
        <input required value={navn} onChange={(e) => settNavn(e.target.value)} />
      </label>
      <p className="liten dempet">
        Nye organisasjoner kan sende opptil 20 fakturaer og 50 000 kr per måned til de er verifisert
        {privat ? " (det krever organisasjonsnummer)" : ""}. Ved å opprette organisasjonen bekrefter du at du har fullmakt
        til å fakturere på vegne av den.
      </p>
      {avtaler && <AvtaleAvkrysning avtaler={avtaler} godtatt={godtatt} endre={settGodtatt} />}
      <Feil melding={feil ?? avtalefeil} />
      <div className="knapper">
        <button className="primar" disabled={opptatt || !kanOpprette}>
          Opprett
        </button>
        {avbryt && (
          <button type="button" onClick={avbryt}>
            Avbryt
          </button>
        )}
      </div>
    </form>
  );
}
