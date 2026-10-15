// Min side (for den ansatte, «Min side» i menyen, /meg): det som står om deg i ansattregisteret
// (personalia, ansettelsen og lønnen med de faste tilleggene og skattekortet), feriebanken og
// inntekten (lønnsslippene og årsoversikten, Lonn.tsx). Personalia (adresse, fødselsnummer,
// kontonummer og pårørende) fyller den ansatte ut selv under «Mine opplysninger», og lederen
// godkjenner (AnsattUtfylling.tsx); resten retter lederen under Ansatte.
import { type ReactNode } from "react";
import { hent } from "../api";
import { Feil, Laster, Tom, useData } from "../felles";
import { harFunksjon, useKonto } from "../konto";
import { dato, iDag } from "../format";
import { visKontonr } from "../personnummer";
import { IkonAnsatte } from "../ikoner";
import { dagerTekst } from "./Arbeidsplan";
import { AnsattFerie } from "./Ferie";
import { MineSlipper } from "./Lonn";
import { MineOpplysninger, type Utfylling } from "./AnsattUtfylling";

type Tillegg = { id: string; navn: string; belop: number; per: "maaned" | "time"; fra: string | null; til: string | null };
type Meg = {
  id: string;
  ansattnummer: number;
  fornavn: string;
  etternavn: string;
  epost: string | null;
  telefon: string | null;
  adresse: string | null;
  postnr: string | null;
  poststed: string | null;
  parorende_navn: string | null;
  parorende_telefon: string | null;
  fodselsdato: string | null;
  har_fnr: boolean;
  kontonr: string | null;
  stilling: string | null;
  rolle: string | null;
  stillingsprosent: number;
  ukentlig_arbeidstid: number;
  ansatt_fra: string;
  ansatt_til: string | null;
  ansettelsestype: "fast" | "midlertidig" | "tilkalling";
  arbeidstaker: boolean;
  lonnstype: "maaned" | "time";
  maanedslonn: number | null;
  timelonn: number | null;
  tillegg: Tillegg[];
  arbeidsdager: number[];
  skattekort: "tabell" | "prosent" | "frikort" | null;
  skatt_tabell: number | null;
  skatt_prosent: number | null;
  skatt_frikort: number | null;
  skattekort_aar: number | null;
  utfylling: Utfylling | null;
  utfylling_bedt: string | null;
};

const tall = new Intl.NumberFormat("nb-NO", { maximumFractionDigits: 2 });
const kroner = (n: number) => `${tall.format(n)} kr`;
const ANSETTELSE: Record<Meg["ansettelsestype"], string> = { fast: "Fast", midlertidig: "Midlertidig", tilkalling: "Tilkalling (ekstravakt)" };

function skattekortTekst(m: Meg) {
  if (!m.skattekort) return "Ikke registrert (50 % trekk)";
  const aar = m.skattekort_aar ? ` (${m.skattekort_aar})` : "";
  if (m.skattekort === "tabell") return `Tabelltrekk, tabell ${m.skatt_tabell ?? "–"}${m.skatt_prosent != null ? `, ${tall.format(m.skatt_prosent)} %` : ""}${aar}`;
  if (m.skattekort === "prosent") return `Prosenttrekk ${tall.format(m.skatt_prosent ?? 0)} %${aar}`;
  return `Frikort${m.skatt_frikort != null ? ` på ${kroner(m.skatt_frikort)}` : " uten grense"}${aar}`;
}

// Én opplysning: navnet og verdien (tom verdi står som «Ikke registrert»).
function Rad({ navn, children }: { navn: string; children: ReactNode }) {
  return (
    <div className="min-rad">
      <dt>{navn}</dt>
      <dd>{children || <span className="dempet">Ikke registrert</span>}</dd>
    </div>
  );
}

export function MinSide() {
  const { org } = useKonto();
  const meg = useData(() => (org?.ansatt_id ? hent<Meg>(`/org/${org.id}/ansatte/meg`) : Promise.resolve(null)), [org?.id, org?.ansatt_id]);

  if (!org?.ansatt_id)
    return (
      <>
        <h1>Min side</h1>
        <div className="kort">
          <Tom ikon={<IkonAnsatte storrelse={22} />} tittel="Du er ikke registrert som ansatt her">
            <p>Ta kontakt med den som administrerer {org?.navn}.</p>
          </Tom>
        </div>
      </>
    );
  if (meg.feil) return <Feil melding={meg.feil} />;
  if (!meg.data) return <Laster />;
  const m = meg.data;
  const adresse = [m.adresse, [m.postnr, m.poststed].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  const avtalt = (m.ukentlig_arbeidstid * m.stillingsprosent) / 100;
  const tillegg = (m.tillegg ?? []).filter((t) => (!t.fra || t.fra <= iDag()) && (!t.til || t.til >= iDag()));
  const lonn = m.lonnstype === "maaned" ? (m.maanedslonn != null ? `${kroner(m.maanedslonn)} i måneden` : "") : m.timelonn != null ? `${kroner(m.timelonn)} i timen` : "";

  return (
    <>
      <div className="topp">
        <h1>Min side</h1>
      </div>
      <p className="dempet">
        Dette står om deg hos {org.navn}. Adressen, kontonummeret og de andre opplysningene om deg retter du selv under Mine opplysninger, og lederen din godkjenner
        dem. Er noe annet feil, gi beskjed til lederen din.
      </p>
      {/* Lederen har bedt om opplysningene, eller de er avvist: øverst. */}
      {((m.utfylling_bedt && !m.utfylling) || m.utfylling?.status === "avvist") && <MineOpplysninger meg={m} oppdatert={(x) => meg.settData(x)} />}
      <div className="min-side">
        <section className="kort">
          <h2>
            {m.fornavn} {m.etternavn}
          </h2>
          <dl>
            <Rad navn="Fødselsdato">{m.fodselsdato ? dato(m.fodselsdato) : ""}</Rad>
            <Rad navn="Fødselsnummer">{m.har_fnr ? "Registrert" : ""}</Rad>
            <Rad navn="E-post">{m.epost}</Rad>
            <Rad navn="Telefon">{m.telefon}</Rad>
            <Rad navn="Adresse">{adresse}</Rad>
            {m.arbeidstaker && <Rad navn="Kontonummer">{visKontonr(m.kontonr)}</Rad>}
            <Rad navn="Nærmeste pårørende">{[m.parorende_navn, m.parorende_telefon].filter(Boolean).join(", ")}</Rad>
          </dl>
        </section>
        {!((m.utfylling_bedt && !m.utfylling) || m.utfylling?.status === "avvist") && <MineOpplysninger meg={m} oppdatert={(x) => meg.settData(x)} />}
        <section className="kort">
          <h2>Ansettelse</h2>
          <dl>
            <Rad navn="Ansattnummer">{String(m.ansattnummer)}</Rad>
            <Rad navn="Stilling">{m.stilling}</Rad>
            {m.rolle && <Rad navn="Rolle">{m.rolle}</Rad>}
            {m.arbeidstaker && <Rad navn="Ansettelse">{ANSETTELSE[m.ansettelsestype]}</Rad>}
            <Rad navn="Stillingsprosent">{`${tall.format(m.stillingsprosent)} %${avtalt > 0 ? ` (${tall.format(avtalt)} timer i uka)` : ""}`}</Rad>
            <Rad navn="Ansatt fra">{dato(m.ansatt_fra)}</Rad>
            {m.ansatt_til && <Rad navn="Ansatt til">{dato(m.ansatt_til)}</Rad>}
            {harFunksjon(org, "vaktplan") && (m.arbeidsdager ?? []).length > 0 && <Rad navn="Faste arbeidsdager">{dagerTekst(m.arbeidsdager)}</Rad>}
          </dl>
        </section>
        {m.arbeidstaker && (
          <section className="kort">
            <h2>Lønn</h2>
            <dl>
              <Rad navn={m.lonnstype === "maaned" ? "Fastlønn" : "Timelønn"}>{lonn}</Rad>
              {tillegg.map((t) => (
                <Rad key={t.id} navn={t.navn}>{`${kroner(t.belop)} ${t.per === "time" ? "i timen" : "i måneden"}${t.til ? ` til ${dato(t.til)}` : ""}`}</Rad>
              ))}
              <Rad navn="Skattekort">{skattekortTekst(m)}</Rad>
            </dl>
          </section>
        )}
      </div>
      {m.arbeidstaker && harFunksjon(org, "vaktplan") && (
        <>
          <h2 className="undertittel">Ferie {iDag().slice(0, 4)}</h2>
          <div className="kort">
            <AnsattFerie ansattId={m.id} aar={Number(iDag().slice(0, 4))} />
          </div>
        </>
      )}
      {m.arbeidstaker && harFunksjon(org, "lonn") && (
        <>
          <h2 className="undertittel">Inntekt</h2>
          <MineSlipper />
        </>
      )}
    </>
  );
}
