// Plattformadministrasjon i tre faner: Oversikt (bruken, og kontoer og organisasjoner som venter
// på godkjenning), Organisasjoner (alle organisasjonene med brukerne de har, søk, detaljer med
// funksjonene, eksport, og standarden for nye) og Drift. På smale skjermer vises listene som kort.
import { Fragment, useMemo, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { api, hent } from "../api";
import { Dialog, Feil, Laster, useData, useHandling, useSmal } from "../felles";
import { dato, orgnr } from "../format";
import { IkonFaktura, IkonKunder, IkonSkjold, IkonVarsel } from "../ikoner";
import { ModulValg, modulnavn, opplisting, useModuler, type Modul } from "../moduler";
import { SlettOrganisasjon } from "../slettOrg";

type Org = {
  id: string;
  navn: string;
  orgnr: string | null;
  type: string;
  verifisering: "ny" | "verifisert" | "sperret";
  verifisert_metode: string | null;
  sperret_grunn: string | null;
  opprettet: string;
  eier_epost: string | null;
  // Ingen beløp: bare hvor mange fakturaer, og hvor mange av dem på e-post og som EHF.
  antall_fakturaer: number;
  antall_epost: number;
  antall_ehf: number;
  venter_manuell: boolean;
  notat: string | null;
  antall_medlemmer: number;
  sist_aktiv: string | null;
};
type Bruker = {
  id: string;
  epost: string;
  navn: string | null;
  opprettet: string;
  organisasjoner: { id: string; navn: string; rolle: string; verifisering: Org["verifisering"] }[];
  antall_passkeys: number;
  sist_passkey: string | null;
  sist_aktiv: string | null;
  // Kontoen er godkjent av plattformadministratoren, venter eller er avvist.
  status: "venter" | "godkjent" | "avvist";
  behandlet_at: string | null;
  avvist_grunn: string | null;
  // Modulene brukeren ba om, eller som ble godkjent (0044_moduler.sql).
  moduler: string[];
};
// En ny konto som venter på godkjenning, med modulene den ber om.
type KontoVenter = { id: string; epost: string; navn: string | null; opprettet: string; varslet_at: string | null; moduler: string[] };
const kontoMerke = (s: Bruker["status"]) =>
  s === "venter" ? <span className="merke merke-info">Venter</span> : s === "avvist" ? <span className="merke merke-fare">Avvist</span> : null;
type Fane = "oversikt" | "organisasjoner" | "drift";
// En bruker i en organisasjon, med rollen der.
type OrgBruker = Bruker & { rolle: string };
const ROLLEREKKE = ["eier", "admin", "fakturerer", "regnskap", "les", "ansatt"];
const rolleRekke = (r: string) => (ROLLEREKKE.includes(r) ? ROLLEREKKE.indexOf(r) : ROLLEREKKE.length);
// Funksjonene organisasjonene kan ha tilgang til (0041_funksjoner.sql).
type Funksjon = { kode: string; navn: string; beskrivelse: string; krever: string | null; standard: boolean; modul?: string };
type Funksjonsoversikt = {
  // Modulene (Faktura, Bemanning, ...) som funksjonene hører til, i rekkefølge.
  moduler?: Modul[];
  funksjoner: Funksjon[];
  organisasjoner: { id: string; navn: string; orgnr: string | null; type: string; verifisering: Org["verifisering"]; aktive: string[]; endret: string | null }[];
};

const statusMerke: Record<string, string> = { ny: "merke-advarsel", verifisert: "merke-ok", sperret: "merke-fare" };
const statusTekst: Record<string, string> = { ny: "Ikke verifisert", verifisert: "Verifisert", sperret: "Sperret" };
const metodeTekst: Record<string, string> = { epostdomene: "e-postdomene", brreg_epost: "e-posten i Enhetsregisteret", manuell: "manuelt" };
const rolleTekst: Record<string, string> = { eier: "eier", admin: "admin", fakturerer: "fakturerer", regnskap: "regnskap", les: "les", ansatt: "ansatt" };
const integrasjonTekst: Record<string, string> = { peppol: "EHF (Recommand)", bank: "Enable Banking", google_drive: "Google Disk", fiken: "Fiken", tripletex: "Tripletex", poweroffice: "PowerOffice", visma: "Visma" };

// «for 5 min siden», «for 3 t siden», «for 2 dager siden», ellers datoen.
function siden(iso: string | null | undefined): string {
  if (!iso) return "–";
  const min = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (min < 1) return "nå";
  if (min < 60) return `for ${min} min siden`;
  if (min < 24 * 60) return `for ${Math.round(min / 60)} t siden`;
  if (min < 7 * 24 * 60) return `for ${Math.round(min / (24 * 60))} ${Math.round(min / (24 * 60)) === 1 ? "dag" : "dager"} siden`;
  return dato(iso);
}

// CSV som åpnes riktig i norsk Excel (semikolon og BOM).
function lastNedCsv(filnavn: string, rader: (string | number | null | undefined)[][]) {
  const celle = (v: string | number | null | undefined) => {
    const s = v == null ? "" : String(v);
    return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const tekst = "﻿" + rader.map((r) => r.map(celle).join(";")).join("\r\n");
  const url = URL.createObjectURL(new Blob([tekst], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filnavn;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// «Venter» sier nok for en ny organisasjon som venter på godkjenning.
const OrgStatus = ({ o }: { o: Pick<Org, "verifisering" | "venter_manuell"> }) => (
  <>
    {!(o.venter_manuell && o.verifisering === "ny") && <span className={`merke ${statusMerke[o.verifisering]}`}>{statusTekst[o.verifisering]}</span>}
    {o.venter_manuell && <span className="merke merke-info">Venter</span>}
  </>
);
const kontonrTekst = (k: string | null | undefined) => k?.replace(/^(\d{4})(\d{2})(\d{5})$/, "$1.$2.$3") ?? null;

export function Admin() {
  const [sok, settSok] = useSearchParams();
  // Venter, Funksjoner og Brukere er nå en del av Oversikt og Organisasjoner (gamle lenker virker).
  const valgtFane = sok.get("fane") ?? "";
  const fane: Fane = ["organisasjoner", "funksjoner", "brukere"].includes(valgtFane) ? "organisasjoner" : valgtFane === "drift" ? "drift" : "oversikt";
  const orgs = useData(() => hent<Org[]>("/admin/organisasjoner"), []);
  // Nye kontoer som venter på godkjenning.
  const kontoer = useData(() => hent<KontoVenter[]>("/admin/kontoer"), []);
  // Alle brukerne; de vises under organisasjonene de representerer.
  const brukere = useData(() => hent<Bruker[]>("/admin/brukere"), []);
  const [valgt, settValgt] = useState<string | null>(null);
  const velgFane = (f: Fane) => settSok(f === "oversikt" ? {} : { fane: f }, { replace: true });

  if (orgs.feil) return <Feil melding={orgs.feil} />;
  const venter = (orgs.data ?? []).filter((o) => o.venter_manuell).length + (kontoer.data?.length ?? 0);
  const faner: [Fane, string][] = [
    ["oversikt", `Oversikt${venter ? ` (${venter})` : ""}`],
    ["organisasjoner", "Organisasjoner"],
    ["drift", "Drift"],
  ];

  return (
    <div className="admin">
      <h1>Administrasjon</h1>
      <div className="faner" role="tablist">
        {faner.map(([v, t]) => (
          <button key={v} role="tab" aria-selected={fane === v} className={fane === v ? "valgt" : ""} onClick={() => velgFane(v)}>
            {t}
          </button>
        ))}
      </div>
      {!orgs.data ? (
        <Laster />
      ) : fane === "oversikt" ? (
        <>
          {kontoer.feil && <Feil melding={kontoer.feil} />}
          {!!kontoer.data?.length && (
            <KontoerVenter
              kontoer={kontoer.data}
              endret={() => {
                kontoer.last();
                brukere.last();
              }}
            />
          )}
          <Oversikt orgs={orgs.data} apne={settValgt} velgFane={velgFane} />
        </>
      ) : fane === "organisasjoner" ? (
        <Organisasjoner orgs={orgs.data} brukere={brukere.data} brukerFeil={brukere.feil} apne={settValgt} />
      ) : (
        <Drift apne={settValgt} />
      )}
      <Dialog apen={valgt !== null} lukk={() => settValgt(null)} tittel={orgs.data?.find((o) => o.id === valgt)?.navn ?? "Organisasjon"} bred>
        {valgt && (
          <OrgDetaljer
            id={valgt}
            brukere={brukere.data}
            apne={settValgt}
            endret={() => {
              settValgt(null);
              orgs.last();
            }}
          />
        )}
      </Dialog>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Oversikt
// ---------------------------------------------------------------------------

function Oversikt({ orgs, apne, velgFane }: { orgs: Org[]; apne: (id: string) => void; velgFane: (f: Fane) => void }) {
  const { data, feil } = useData(() => hent<any>("/admin/oversikt"), []);
  if (feil) return <Feil melding={feil} />;
  if (!data) return <Laster />;
  const venter = orgs.filter((o) => o.venter_manuell);
  const problemer = Object.values(data.problemer as Record<string, number>).reduce((a, b) => a + b, 0);
  const nyeste = [...orgs].sort((a, b) => b.opprettet.localeCompare(a.opprettet)).slice(0, 5);
  const o = data.organisasjoner;

  return (
    <>
      {venter.length > 0 && (
        <div className="kort tabell admin-varsel">
          <div className="kort-topp">
            <h2>
              {venter.length === 1 ? "1 organisasjon venter" : `${venter.length} organisasjoner venter`} på godkjenning
            </h2>
          </div>
          <OrgListe rader={venter} apne={apne} enkel />
        </div>
      )}
      {problemer > 0 && (
        <div className="melding feil admin-problemer">
          <span>
            {problemer === 1 ? "1 driftsproblem" : `${problemer} driftsproblemer`}: e-post, EHF, banker eller hendelser som ikke er sendt.
          </span>
          <button type="button" className="lenke" onClick={() => velgFane("drift")}>
            Se drift
          </button>
        </div>
      )}
      <div className="nokkeltall">
        <div className="kort">
          <div className="etikett">
            <span className="ikonboks"><IkonSkjold /></span> Organisasjoner
          </div>
          <div className="verdi">{o.totalt}</div>
          <div className="under">
            {o.verifisert} verifisert · {o.ny} ikke verifisert{o.sperret ? ` · ${o.sperret} sperret` : ""}
          </div>
        </div>
        <div className="kort">
          <div className="etikett">
            <span className="ikonboks ok"><IkonKunder /></span> Brukere
          </div>
          <div className="verdi">{data.brukere.totalt}</div>
          <div className="under">
            {data.brukere.aktive_30} aktive og {data.brukere.nye_30} nye siste 30 dager
          </div>
        </div>
        <div className="kort">
          <div className="etikett">
            <span className="ikonboks"><IkonFaktura /></span> Fakturaer siste 30 dager
          </div>
          <div className="verdi">{data.fakturaer.antall_30}</div>
          <div className="under">
            {data.fakturaer.epost_30} på e-post · {data.fakturaer.ehf_30} som EHF · totalt {data.fakturaer.totalt}
          </div>
        </div>
        <div className="kort">
          <div className="etikett">
            <span className={`ikonboks ${problemer ? "fare" : "noytral"}`}><IkonVarsel /></span> Integrasjoner
          </div>
          <div className="verdi">{data.integrasjoner.ehf + data.integrasjoner.bank}</div>
          <div className="under">
            EHF hos {data.integrasjoner.ehf} · bank hos {data.integrasjoner.bank}
          </div>
        </div>
      </div>
      <div className="kort tabell">
        <div className="kort-topp">
          <h2>Nyeste organisasjoner</h2>
          <button type="button" className="lenke" onClick={() => velgFane("organisasjoner")}>
            Se alle
          </button>
        </div>
        <OrgListe rader={nyeste} apne={apne} enkel />
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Organisasjoner
// ---------------------------------------------------------------------------

function Organisasjoner({ orgs, brukere, brukerFeil, apne }: { orgs: Org[]; brukere: Bruker[] | undefined; brukerFeil: string | null; apne: (id: string) => void }) {
  const moduler = useModuler();
  const [sok, settSok] = useState("");
  const [status, settStatus] = useState<"alle" | "venter" | "ny" | "verifisert" | "sperret">("alle");
  const [bruker, settBruker] = useState<Bruker | null>(null);
  // Brukerne under hver organisasjon, eieren først.
  const perOrg = useMemo(() => {
    const m = new Map<string, OrgBruker[]>();
    for (const b of brukere ?? []) for (const o of b.organisasjoner) m.set(o.id, [...(m.get(o.id) ?? []), { ...b, rolle: o.rolle }]);
    for (const l of m.values()) l.sort((a, b) => rolleRekke(a.rolle) - rolleRekke(b.rolle) || (a.navn ?? a.epost).localeCompare(b.navn ?? b.epost, "nb"));
    return m;
  }, [brukere]);
  const s = sok.trim().toLowerCase();
  const brukerTreff = (b: Bruker) => `${b.navn ?? ""} ${b.epost}`.toLowerCase().includes(s);
  // Søket finner også organisasjonene til en bruker (navn eller e-post).
  const rader = orgs.filter(
    (o) =>
      (status === "alle" || (status === "venter" ? o.venter_manuell : o.verifisering === status)) &&
      (!s ||
        `${o.navn} ${o.orgnr ?? ""} ${o.eier_epost ?? ""}`.toLowerCase().includes(s) ||
        (o.orgnr ?? "").includes(s.replace(/\s/g, "")) ||
        (perOrg.get(o.id) ?? []).some(brukerTreff)),
  );
  const utenOrg = (brukere ?? []).filter((b) => !b.organisasjoner.length && (!s || brukerTreff(b)));
  const iDag = new Date().toISOString().slice(0, 10);
  const eksporter = () =>
    lastNedCsv(`organisasjoner-${iDag}.csv`, [
      ["Navn", "Org.nr.", "Type", "Status", "Eier", "Medlemmer", "Fakturaer", "På e-post", "Som EHF", "Opprettet", "Sist aktiv"],
      ...rader.map((o) => [
        o.navn,
        o.orgnr,
        o.type,
        statusTekst[o.verifisering],
        o.eier_epost,
        o.antall_medlemmer,
        o.antall_fakturaer,
        o.antall_epost,
        o.antall_ehf,
        o.opprettet.slice(0, 10),
        o.sist_aktiv?.slice(0, 10),
      ]),
    ]);
  const eksporterBrukere = () =>
    lastNedCsv(`brukere-${iDag}.csv`, [
      ["Navn", "E-post", "Status", "Moduler", "Organisasjoner", "Passkeys", "Registrert", "Sist aktiv"],
      ...(brukere ?? []).map((b) => [
        b.navn,
        b.epost,
        { venter: "Venter", godkjent: "Godkjent", avvist: "Avvist" }[b.status] ?? b.status,
        modulnavn(moduler, b.moduler ?? []).join(", "),
        b.organisasjoner.map((o) => `${o.navn} (${rolleTekst[o.rolle] ?? o.rolle})`).join(", "),
        b.antall_passkeys,
        b.opprettet.slice(0, 10),
        b.sist_aktiv?.slice(0, 10),
      ]),
    ]);

  return (
    <>
      <div className="admin-verktoy">
        <input type="search" placeholder="Søk på organisasjon, org.nr. eller bruker" aria-label="Søk i organisasjoner og brukere" value={sok} onChange={(e) => settSok(e.target.value)} />
        <select aria-label="Status" value={status} onChange={(e) => settStatus(e.target.value as typeof status)}>
          <option value="alle">Alle ({orgs.length})</option>
          <option value="venter">Venter på godkjenning</option>
          <option value="ny">Ikke verifisert</option>
          <option value="verifisert">Verifisert</option>
          <option value="sperret">Sperret</option>
        </select>
        <button type="button" onClick={eksporter} disabled={!rader.length}>
          Organisasjoner (CSV)
        </button>
        <button type="button" onClick={eksporterBrukere} disabled={!brukere?.length}>
          Brukere (CSV)
        </button>
      </div>
      {brukerFeil && <Feil melding={brukerFeil} />}
      <OrgListe rader={rader} apne={apne} brukere={perOrg} />
      <BrukereUtenOrg brukere={utenOrg} apne={settBruker} apen={!!s} />
      <FunksjonerForNye />
      <SlettedeOrganisasjoner key={orgs.length} />
      <Dialog apen={bruker !== null} lukk={() => settBruker(null)} tittel={bruker?.navn ?? bruker?.epost ?? ""}>
        {bruker && <BrukerDetaljer b={bruker} moduler={moduler} />}
      </Dialog>
    </>
  );
}

// Brukerne i en organisasjon på én linje under navnet (de fire første, eieren først).
function BrukerLinje({ liste }: { liste: OrgBruker[] | undefined }) {
  if (!liste?.length) return <span className="org-brukere dempet">Ingen brukere</span>;
  return (
    <span className="org-brukere">
      {liste.slice(0, 4).map((b, i) => (
        <Fragment key={b.id}>
          {i > 0 && " · "}
          {b.navn ?? b.epost} <span className="dempet">({rolleTekst[b.rolle] ?? b.rolle})</span>
          {b.status !== "godkjent" && <> {kontoMerke(b.status)}</>}
        </Fragment>
      ))}
      {liste.length > 4 && <span className="dempet"> · +{liste.length - 4}</span>}
    </span>
  );
}

// Med brukere: brukerne står under navnet på organisasjonen (i stedet for eierens e-post).
function OrgListe({ rader, apne, enkel, brukere }: { rader: Org[]; apne: (id: string) => void; enkel?: boolean; brukere?: Map<string, OrgBruker[]> }) {
  const smal = useSmal();
  if (smal)
    return (
      <div className={enkel ? "liste" : "kort liste"}>
        {rader.map((o) => (
          <button key={o.id} type="button" className="liste-rad" onClick={() => apne(o.id)}>
            <span className="linje">
              <span className="tittel">
                {o.navn}
                {o.type === "regnskapsbyraa" && <span className="dempet"> (byrå)</span>}
              </span>
              <span className="belop">{o.antall_fakturaer} fakt.</span>
            </span>
            {brukere && (
              <span className="linje">
                <BrukerLinje liste={brukere.get(o.id)} />
              </span>
            )}
            <span className="linje">
              <span className="under">
                {[orgnr(o.orgnr) || "uten org.nr.", o.antall_fakturaer ? `${o.antall_epost} e-post · ${o.antall_ehf} EHF` : "", `aktiv ${siden(o.sist_aktiv)}`].filter(Boolean).join(" · ")}
              </span>
              <span className="merker">
                <OrgStatus o={o} />
              </span>
            </span>
          </button>
        ))}
        {rader.length === 0 && <p className="dempet" style={{ padding: 16, margin: 0 }}>Ingenting her.</p>}
      </div>
    );
  const tabell = (
    <table>
      <thead>
        <tr>
          <th>{brukere ? "Organisasjon og brukere" : "Organisasjon"}</th>
          <th>Org.nr.</th>
          {!brukere && <th>Eier</th>}
          <th>Opprettet</th>
          <th>Sist aktiv</th>
          <th className="hoyre">Fakturaer</th>
          <th className="hoyre">E-post</th>
          <th className="hoyre">EHF</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        {rader.map((o) => (
          <tr key={o.id} className="klikkbar" onClick={() => apne(o.id)}>
            <td>
              {o.navn}
              {o.type === "regnskapsbyraa" && <span className="dempet liten"> (byrå)</span>}
              {brukere && <BrukerLinje liste={brukere.get(o.id)} />}
            </td>
            <td className="hel-linje">{orgnr(o.orgnr)}</td>
            {!brukere && <td className="liten">{o.eier_epost}</td>}
            <td className="hel-linje">{dato(o.opprettet)}</td>
            <td className="liten hel-linje">{siden(o.sist_aktiv)}</td>
            <td className="tall">{o.antall_fakturaer}</td>
            <td className="tall">{o.antall_epost}</td>
            <td className="tall">{o.antall_ehf}</td>
            <td>
              <span className="merker">
                <OrgStatus o={o} />
              </span>
            </td>
          </tr>
        ))}
        {rader.length === 0 && (
          <tr>
            <td colSpan={brukere ? 8 : 9} className="dempet">
              Ingenting her.
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
  return enkel ? tabell : <div className="kort tabell">{tabell}</div>;
}

// ---------------------------------------------------------------------------
// Én organisasjon
// ---------------------------------------------------------------------------

const tingNavn: Record<string, string> = {
  organisasjoner: "organisasjon",
  medlemmer: "medlem",
  kunder: "kunde",
  produkter: "produkt",
  gjentakelser: "gjentakende faktura",
  fakturaer: "faktura",
  betalinger: "betaling",
  integrasjoner: "integrasjon",
  org_tilgang: "regnskapsførertilgang",
};
const stor = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
function aktivitetTekst(a: { handling: string; tabell: string | null; felt: string[] | null; status: string | null }) {
  const ting = stor(tingNavn[a.tabell ?? ""] ?? a.tabell ?? "endring");
  if (a.handling === "INSERT") return `${ting} opprettet`;
  if (a.handling === "DELETE" || a.handling === "SLETTET") return `${ting} slettet`;
  if (a.handling === "OPPSLAG") return `Oppslag: ${ting.toLowerCase()}`;
  if (a.handling === "UPDATE" && a.status) return `${ting}: ${a.status}`;
  if (a.handling === "UPDATE") return `${ting} endret${a.felt?.length ? ` (${a.felt.slice(0, 4).join(", ")}${a.felt.length > 4 ? " …" : ""})` : ""}`;
  return `${ting}: ${a.handling.toLowerCase()}`;
}

const Fakta = ({ rader }: { rader: [string, ReactNode][] }) => (
  <dl className="admin-fakta">
    {rader.map(([t, v]) => (
      <div key={t}>
        <dt>{t}</dt>
        <dd>{v ?? "–"}</dd>
      </div>
    ))}
  </dl>
);

// Én organisasjon: behandling, funksjonene den har, organisasjonen, brukerne (med det vi vet om
// dem, og de andre organisasjonene de er med i), bruken, integrasjoner, logg og sletting.
function OrgDetaljer({ id, brukere, apne, endret }: { id: string; brukere?: Bruker[]; apne: (id: string) => void; endret: () => void }) {
  const { data: o, feil } = useData(() => hent<any>(`/admin/organisasjoner/${id}`), [id]);
  const moduler = useModuler();
  const perEpost = useMemo(() => new Map((brukere ?? []).map((b) => [b.epost, b])), [brukere]);
  const [slett, settSlett] = useState(false);
  if (feil) return <Feil melding={feil} />;
  if (!o) return <Laster />;
  const eier = o.medlemmer.find((m: any) => m.rolle === "eier");

  return (
    <div className="admin-detaljer">
      <p className="merker">
        <span className={`merke ${statusMerke[o.verifisering]}`}>{statusTekst[o.verifisering]}</span>
        {o.type === "regnskapsbyraa" && <span className="merke merke-noytral">Regnskapsbyrå</span>}
        <span className="dempet liten">
          Opprettet {dato(o.opprettet)} · aktiv {siden(o.sist_aktiv)}
        </span>
      </p>
      {o.verifisering === "verifisert" && o.verifisert_metode && (
        <p className="liten dempet">
          Verifisert {dato(o.verifisert_at)} ({metodeTekst[o.verifisert_metode] ?? o.verifisert_metode}).
        </p>
      )}
      {o.sperret_grunn && <div className="melding feil">Sperret: {o.sperret_grunn}</div>}

      <section>
        <h3>Behandling</h3>
        <Behandle org={o} venter={o.verifiseringer.some((v: any) => v.metode === "manuell" && v.status === "venter")} ferdig={endret} />
      </section>

      <OrgFunksjoner key={o.id} id={o.id} funksjoner={o.funksjoner ?? []} />

      <section>
        <h3>Organisasjonen</h3>
        <Fakta
          rader={[
            ["Org.nr.", orgnr(o.orgnr) || "mangler"],
            ["E-post", o.epost ? <a href={`mailto:${o.epost}`}>{o.epost}</a> : null],
            ["Telefon", o.telefon ? <a href={`tel:${o.telefon}`}>{o.telefon}</a> : null],
            ["Adresse", o.adresse],
            ["Kontonummer", kontonrTekst(o.kontonr)],
            ["Mva", o.mva_registrert ? "Registrert" : "Ikke registrert"],
            ["Eier", eier ? <a href={`mailto:${eier.epost}`}>{eier.epost}</a> : null],
          ]}
        />
      </section>

      <section>
        <h3>Bruk</h3>
        <Fakta
          rader={[
            ["Fakturaer", `${o.antall.fakturaer} (${o.antall.epost} på e-post, ${o.antall.ehf} som EHF)`],
            ["Kreditnotaer", o.antall.kreditnotaer || null],
            ["Siste faktura", o.siste_faktura ? dato(o.siste_faktura) : null],
            ["Utkast", o.antall.utkast],
            ["Gjentakende", o.antall.gjentakelser],
            ["Kunder og produkter", `${o.antall.kunder} kunder · ${o.antall.produkter} produkter`],
          ]}
        />
      </section>

      <section>
        <h3>Brukere ({o.medlemmer.length})</h3>
        <ul className="admin-rader org-brukerliste">
          {[...o.medlemmer]
            .sort((a: any, b: any) => rolleRekke(a.rolle) - rolleRekke(b.rolle))
            .map((m: any) => {
              const b = perEpost.get(m.epost);
              const andre = b?.organisasjoner.filter((x) => x.id !== o.id) ?? [];
              const info = b
                ? [
                    b.moduler?.length ? `moduler: ${opplisting(modulnavn(moduler, b.moduler))}` : null,
                    b.antall_passkeys ? `${b.antall_passkeys} ${b.antall_passkeys === 1 ? "passkey" : "passkeys"} (sist ${siden(b.sist_passkey)})` : "ingen passkey",
                    `registrert ${dato(b.opprettet)}`,
                  ].filter(Boolean)
                : [];
              return (
                <li key={m.epost}>
                  <span>
                    <strong>{m.navn ?? m.epost}</strong> <span className="dempet liten">({rolleTekst[m.rolle] ?? m.rolle})</span>
                    {b && b.status !== "godkjent" && <> {kontoMerke(b.status)}</>}
                    <span className="dempet liten">
                      {" · "}
                      <a href={`mailto:${m.epost}`}>{m.epost}</a>
                    </span>
                    {info.length > 0 && <span className="bruker-info liten dempet">{info.join(" · ")}</span>}
                    {andre.length > 0 && (
                      <span className="bruker-info liten">
                        Også i{" "}
                        {andre.map((x, i) => (
                          <Fragment key={x.id}>
                            {i > 0 && ", "}
                            <button type="button" className="lenke" onClick={() => apne(x.id)}>
                              {x.navn}
                            </button>{" "}
                            <span className="dempet">({rolleTekst[x.rolle] ?? x.rolle})</span>
                          </Fragment>
                        ))}
                      </span>
                    )}
                  </span>
                  <span className="dempet liten">aktiv {siden(m.sist_aktiv)}</span>
                </li>
              );
            })}
        </ul>
      </section>

      {(o.integrasjoner.length > 0 || o.banker.length > 0) && (
        <section>
          <h3>Integrasjoner</h3>
          <ul className="admin-rader">
            {o.integrasjoner.map((i: any) => (
              <li key={i.type}>
                <span>
                  {integrasjonTekst[i.type] ?? i.type}
                  {i.siste_feil && <span className="fare-tekst liten"> · {i.siste_feil}</span>}
                </span>
                <span className={`merke ${i.status === "aktiv" ? "merke-ok" : "merke-fare"}`}>{i.status === "aktiv" ? "Aktiv" : "Feil"}</span>
              </li>
            ))}
            {o.banker.map((b: any) => (
              <li key={b.bank}>
                <span>
                  Bank: {b.bank}
                  <span className="dempet liten">
                    {b.gyldig_til ? ` · til ${dato(b.gyldig_til)}` : ""}
                    {b.sist_hentet ? ` · hentet ${siden(b.sist_hentet)}` : ""}
                  </span>
                  {b.siste_feil && <span className="fare-tekst liten"> · {b.siste_feil}</span>}
                </span>
                <span className={`merke ${b.status === "aktiv" ? "merke-ok" : b.status === "venter" ? "merke-advarsel" : "merke-fare"}`}>
                  {b.status === "aktiv" ? "Aktiv" : b.status === "venter" ? "Venter" : "Feil"}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {o.kontonr_endringer.length > 0 && (
        <section>
          <h3>Kontonummer endret</h3>
          <ul className="admin-rader">
            {o.kontonr_endringer.map((k: any, i: number) => (
              <li key={i}>
                <span>
                  {kontonrTekst(k.fra) ?? "–"} → <strong>{kontonrTekst(k.til) ?? "–"}</strong>
                  <span className="dempet liten"> · {k.av ?? "ukjent"}</span>
                </span>
                <span className="dempet liten">{siden(k.tid)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {o.verifiseringer.length > 0 && (
        <section>
          <h3>Verifiseringsforsøk</h3>
          <ul className="admin-rader">
            {o.verifiseringer.map((v: any, i: number) => (
              <li key={i}>
                <span>
                  {stor(metodeTekst[v.metode] ?? v.metode)}
                  {v.sendt_til && <span className="dempet liten"> · til {v.sendt_til}</span>}
                  {v.notat && <span className="dempet liten"> · «{v.notat}»</span>}
                </span>
                <span className="dempet liten">
                  {v.status} · {siden(v.tid)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {o.aktivitet.length > 0 && (
        <section>
          <h3>Siste aktivitet</h3>
          <ul className="admin-rader">
            {o.aktivitet.map((a: any, i: number) => (
              <li key={i}>
                <span>
                  {aktivitetTekst(a)}
                  {a.av && <span className="dempet liten"> · {a.av}</span>}
                </span>
                <span className="dempet liten">{siden(a.tid)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="fare-sone">
        <h3>Slett organisasjonen</h3>
        <p className="liten dempet" style={{ marginTop: 0 }}>
          Uten utstedte fakturaer slettes alt. Med utstedte fakturaer stenges organisasjonen, og fakturaene oppbevares så lenge bokføringsloven krever. Eierne får
          e-post med grunnen.
        </p>
        <button type="button" className="fare" onClick={() => settSlett(true)}>
          Slett organisasjonen …
        </button>
        <SlettOrganisasjon
          admin
          navn={o.navn}
          sti={`/admin/organisasjoner/${o.id}/slett`}
          apen={slett}
          lukk={() => settSlett(false)}
          ferdig={() => {
            settSlett(false);
            endret();
          }}
        />
      </section>
    </div>
  );
}

// Organisasjonene som er slettet (alt borte) eller stengt (fakturaene oppbevares), med grunnen.
type Slettet = {
  id: string;
  navn: string;
  orgnr: string | null;
  slettet_at: string;
  slettet_av_navn: string | null;
  slettet_av_epost: string | null;
  av_plattformen: boolean;
  grunn: string;
  antall_fakturaer: number;
  oppbevares_til: string | null;
};
function SlettedeOrganisasjoner() {
  const { data } = useData(() => hent<Slettet[]>("/admin/slettede"), []);
  if (!data?.length) return null;
  return (
    <details className="kort slettede-org">
      <summary>Slettede organisasjoner ({data.length})</summary>
      <ul className="admin-rader">
        {data.map((s) => (
          <li key={s.id}>
            <span>
              <strong>{s.navn}</strong>
              {s.orgnr && <span className="dempet liten"> · {orgnr(s.orgnr)}</span>}
              <span className="liten" style={{ display: "block" }}>
                Grunn: {s.grunn}
              </span>
              <span className="dempet liten" style={{ display: "block" }}>
                {dato(s.slettet_at)} av {s.av_plattformen ? "HI4 Faktura" : "eieren"}
                {s.slettet_av_navn || s.slettet_av_epost ? ` (${s.slettet_av_navn ?? s.slettet_av_epost})` : ""}
              </span>
            </span>
            <span className={`merke ${s.oppbevares_til ? "merke-advarsel" : "merke-noytral"}`}>
              {s.oppbevares_til ? `Stengt · ${s.antall_fakturaer} ${s.antall_fakturaer === 1 ? "faktura" : "fakturaer"} til ${dato(s.oppbevares_til)}` : "Slettet"}
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}

// Funksjonene én organisasjon har tilgang til: slå av og på (lagres med en gang).
function OrgFunksjoner({ id, funksjoner }: { id: string; funksjoner: (Omit<Funksjon, "standard"> & { aktiv: boolean })[] }) {
  const [aktive, settAktive] = useState(() => new Set(funksjoner.filter((f) => f.aktiv).map((f) => f.kode)));
  const h = useHandling();
  if (!funksjoner.length) return null;
  // Vises med en gang, og rettes etter svaret (eller tilbake om det feiler).
  const sett = async (kode: string, aktiv: boolean) => {
    const for_ = aktive;
    settAktive(new Set(aktiv ? [...aktive, kode] : [...aktive].filter((k) => k !== kode)));
    const r = await h.kjor(() => api<{ aktive: string[] }>("PUT", `/admin/organisasjoner/${id}/funksjoner`, { [kode]: aktiv }));
    settAktive(r ? new Set(r.aktive) : for_);
  };
  return (
    <section>
      <h3>Funksjoner</h3>
      <p className="liten dempet" style={{ marginTop: 0 }}>
        Hva organisasjonen har tilgang til. Fakturaer, kunder og produkter har alle. Endringen gjelder med en gang.
      </p>
      <ul className="admin-rader funksjon-liste">
        {funksjoner.map((f) => {
          const mangler = f.krever && !aktive.has(f.krever) ? funksjoner.find((x) => x.kode === f.krever)?.navn : null;
          return (
            <li key={f.kode}>
              <label className={mangler ? "dempet" : undefined}>
                <input type="checkbox" checked={aktive.has(f.kode)} onChange={(e) => void sett(f.kode, e.target.checked)} />
                <span>
                  <strong>{f.navn}</strong>
                  <span className="dempet liten"> · {f.beskrivelse}</span>
                  {mangler && <span className="liten advarsel-tekst"> · virker bare med {mangler}</span>}
                </span>
              </label>
            </li>
          );
        })}
      </ul>
      <Feil melding={h.feil} />
    </section>
  );
}

// ---------------------------------------------------------------------------
// Funksjonene nye organisasjoner får (hva hver organisasjon har, står i detaljene for den)
// ---------------------------------------------------------------------------

function FunksjonerForNye() {
  const { data, settData, feil } = useData(() => hent<Funksjonsoversikt>("/admin/funksjoner"), []);
  const h = useHandling();
  if (feil) return <Feil melding={feil} />;
  if (!data) return null;
  // Vises med en gang, og settes tilbake om lagringen feiler.
  const sett = async (kode: string, standard: boolean) => {
    const med = (d: Funksjonsoversikt, v: boolean) => ({ ...d, funksjoner: d.funksjoner.map((f) => (f.kode === kode ? { ...f, standard: v } : f)) });
    settData(med(data, standard));
    const ok = await h.kjor(async () => (await api("PUT", `/admin/funksjoner/${kode}`, { standard }), true));
    if (!ok) settData((d) => (d ? med(d, !standard) : d));
  };
  // Funksjonene modul for modul (Faktura, Bemanning, ...).
  const grupper: { modul: Modul | undefined; funksjoner: Funksjon[] }[] = [];
  for (const f of data.funksjoner) {
    const siste = grupper.at(-1);
    if (siste && siste.funksjoner[0]!.modul === f.modul) siste.funksjoner.push(f);
    else grupper.push({ modul: data.moduler?.find((m) => m.kode === f.modul), funksjoner: [f] });
  }
  const navn = new Map(data.funksjoner.map((f) => [f.kode, f.navn]));
  return (
    <details className="kort funksjoner-nye">
      <summary>Funksjoner for nye organisasjoner</summary>
      <p className="liten dempet">
        Det en ny organisasjon får når den lages. Nye kontoer får bare funksjonene i modulene de er godkjent med. Fakturaer, kunder og produkter har alle. Hva
        hver organisasjon har, endrer du i organisasjonen.
      </p>
      {grupper.map((g, i) => (
        <section key={g.modul?.kode ?? i}>
          {grupper.length > 1 && <h3>{g.modul?.navn ?? "Annet"}</h3>}
          <ul className="admin-rader funksjon-liste">
            {g.funksjoner.map((f) => (
              <li key={f.kode}>
                <label>
                  <input type="checkbox" checked={f.standard} onChange={(e) => void sett(f.kode, e.target.checked)} />
                  <span>
                    <strong>{f.navn}</strong>
                    <span className="dempet liten">
                      {" · "}
                      {f.beskrivelse}
                      {f.krever ? ` (krever ${navn.get(f.krever)})` : ""}
                    </span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </section>
      ))}
      <Feil melding={h.feil} />
    </details>
  );
}

// Godkjenn, sperr eller sett tilbake, med oppslag i Enhetsregisteret.
function Behandle({ org, venter, ferdig }: { org: any; venter: boolean; ferdig: () => void }) {
  const brreg = useData(() => (org.orgnr ? hent(`/admin/organisasjoner/${org.id}/brreg`) : Promise.resolve(null)), [org.id]);
  const [grunn, settGrunn] = useState("");
  const h = useHandling();
  const sett = async (status: string) => {
    if (status === "sperret" && !confirm(`Sperre ${org.navn}? De kan ikke sende fakturaer før sperringen oppheves.`)) return;
    const r = await h.kjor(() => api("POST", `/admin/organisasjoner/${org.id}/status`, { status, grunn: grunn || undefined }));
    if (r) ferdig();
  };
  const venterNotat = org.verifiseringer.find((v: any) => v.metode === "manuell" && v.status === "venter")?.notat;

  return (
    <>
      {venter && <div className="melding info">Ber om manuell godkjenning{venterNotat ? `: «${venterNotat}»` : "."}</div>}
      {brreg.laster ? (
        <Laster />
      ) : brreg.feil ? (
        <Feil melding={brreg.feil} />
      ) : brreg.data ? (
        <Fakta
          rader={[
            ["Enhetsregisteret", brreg.data.navn],
            ["Adresse", [brreg.data.adresse, brreg.data.postnr, brreg.data.poststed].filter(Boolean).join(", ") || null],
            ["Nettside", brreg.data.hjemmeside],
            ["E-post", brreg.data.epost],
            ["Status", brreg.data.konkurs ? "Konkurs" : brreg.data.under_avvikling ? "Under avvikling" : brreg.data.slettet ? "Slettet" : "Aktiv"],
          ]}
        />
      ) : (
        <p className="dempet">Mangler organisasjonsnummer.</p>
      )}
      {brreg.data?.epost_medlem && (
        <div className="melding ok">
          E-posten i Enhetsregisteret ({brreg.data.epost}) er innloggingen til {brreg.data.epost_medlem}.
        </div>
      )}
      {brreg.data?.roller && (
        <>
          <p className="liten" style={{ margin: "12px 0 4px", fontWeight: 600 }}>
            Roller i Brreg
          </p>
          {brreg.data.roller.length ? (
            <ul className="admin-rader">
              {brreg.data.roller.map((r: { kode: string; rolle: string; navn: string; treff: string[] }, i: number) => (
                <li key={`${r.kode}-${r.navn}-${i}`}>
                  <span>
                    {r.rolle}: {r.navn}
                  </span>
                  {r.treff.length > 0 && <span className="merke merke-ok">Samme navn som {r.treff.join(", ")}</span>}
                </li>
              ))}
            </ul>
          ) : (
            <p className="liten dempet">Ingen personer med roller i Brreg.</p>
          )}
          {brreg.data.roller.some((r: { treff: string[] }) => r.treff.length) && (
            <p className="liten dempet">Samme navn er et hint, ikke et bevis: navnet på profilen kan brukeren skrive selv.</p>
          )}
        </>
      )}
      {org.orgnr && (
        <p className="liten dempet">
          Signatur og prokura står på{" "}
          <a href={`https://virksomhet.brreg.no/nb/oppslag/enheter/${org.orgnr}`} target="_blank" rel="noreferrer">
            virksomhet.brreg.no
          </a>
          .
        </p>
      )}
      <label>
        Grunn (påkrevd ved sperring)
        <input value={grunn} onChange={(e) => settGrunn(e.target.value)} />
      </label>
      <Feil melding={h.feil} />
      <div className="knapper">
        {org.verifisering !== "verifisert" && (
          <button className="primar" disabled={h.opptatt || !org.orgnr} onClick={() => sett("verifisert")}>
            Godkjenn
          </button>
        )}
        {org.verifisering !== "sperret" && (
          <button className="fare" disabled={h.opptatt} onClick={() => sett("sperret")}>
            Sperr
          </button>
        )}
        {org.verifisering !== "ny" && (
          <button disabled={h.opptatt} onClick={() => sett("ny")}>
            Sett til ikke verifisert
          </button>
        )}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Nye kontoer som venter på godkjenning
// ---------------------------------------------------------------------------

function KontoerVenter({ kontoer, endret }: { kontoer: KontoVenter[]; endret: () => void }) {
  const h = useHandling();
  const [melding, settMelding] = useState<string | null>(null);
  const moduler = useModuler();
  // Modulene kontoen godkjennes med: dem brukeren ba om, til administratoren endrer dem.
  const [endret_, settEndret] = useState<Record<string, string[]>>({});
  const valgte = (k: KontoVenter) => endret_[k.id] ?? k.moduler;
  const behandle = (k: KontoVenter, godkjent: boolean) =>
    h.kjor(async () => {
      let grunn: string | undefined;
      if (godkjent && moduler?.length && !valgte(k).length) throw new Error(`Velg minst én modul for ${k.navn ?? k.epost}.`);
      if (!godkjent) {
        const svar = prompt(`Avvise kontoen til ${k.navn ?? k.epost}? Skriv eventuelt en begrunnelse (den sendes til brukeren):`, "");
        if (svar === null) return;
        grunn = svar.trim() || undefined;
      }
      const r = await api<{ moduler?: string[] }>("POST", `/admin/brukere/${k.id}/godkjenning`, {
        godkjent,
        grunn,
        moduler: godkjent && valgte(k).length ? valgte(k) : undefined,
      });
      settMelding(
        godkjent
          ? `${k.navn ?? k.epost} er godkjent${r.moduler?.length ? ` med ${opplisting(r.moduler)}` : ""} og har fått e-post om det.`
          : `${k.navn ?? k.epost} er avvist og har fått e-post om det.`,
      );
      endret();
    });
  return (
    <div className="kort admin-varsel kontoer-venter">
      <h2>{kontoer.length ? `Nye kontoer som venter på godkjenning (${kontoer.length})` : "Nye kontoer"}</h2>
      {melding && (
        <div className="melding ok" role="status">
          {melding}
        </div>
      )}
      <Feil melding={h.feil} />
      {!kontoer.length ? (
        <p className="dempet" style={{ margin: 0 }}>
          Ingen nye kontoer venter på godkjenning.
        </p>
      ) : (
        <ul className="admin-rader">
          {kontoer.map((k) => (
            <li key={k.id}>
              <span>
                <strong>{k.navn ?? <span className="dempet">Uten navn ennå</span>}</strong>
                <span className="dempet liten"> · {k.epost} · registrert {siden(k.opprettet)}</span>
                <span className="liten konto-moduler">
                  {k.moduler.length ? (
                    <>
                      Ber om <strong>{opplisting(modulnavn(moduler, k.moduler))}</strong>
                    </>
                  ) : (
                    <span className="dempet">Har ikke valgt moduler ennå</span>
                  )}
                </span>
                <ModulValg
                  kompakt
                  moduler={moduler}
                  valgt={valgte(k)}
                  endre={(m) => settEndret((e) => ({ ...e, [k.id]: m }))}
                  tittel="Godkjennes med"
                  navn={k.navn ?? k.epost}
                />
              </span>
              <span className="knapper">
                <button type="button" className="primar" disabled={h.opptatt} onClick={() => behandle(k, true)}>
                  Godkjenn
                </button>
                <button type="button" className="fare" disabled={h.opptatt} onClick={() => behandle(k, false)}>
                  Avvis
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="liten dempet" style={{ marginBottom: 0 }}>
        Nye kontoer kommer ikke inn før de er godkjent. Organisasjonene de lager, får bare funksjonene i modulene de er godkjent med (du kan endre dem i
        organisasjonen under Organisasjoner). Den som blir invitert av en organisasjon, godkjennes når invitasjonen tas imot.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Brukere uten organisasjon
// ---------------------------------------------------------------------------

// Kontoer som ikke er med i noen organisasjon (nye som venter eller er avvist, og godkjente som
// ikke har laget eller blitt invitert til en organisasjon ennå). Brukerne i organisasjonene står
// under dem.
function BrukereUtenOrg({ brukere, apne, apen }: { brukere: Bruker[]; apne: (b: Bruker) => void; apen: boolean }) {
  if (!brukere.length) return null;
  return (
    <details className="kort brukere-uten-org" open={apen || undefined}>
      <summary>Brukere uten organisasjon ({brukere.length})</summary>
      <ul className="admin-rader">
        {brukere.map((b) => (
          <li key={b.id}>
            <span>
              <button type="button" className="lenke" onClick={() => apne(b)}>
                {b.navn ?? b.epost}
              </button>
              {b.navn && <span className="dempet liten"> · {b.epost}</span>}
            </span>
            <span className="merker">
              <span className="dempet liten">registrert {dato(b.opprettet)}</span>
              {kontoMerke(b.status)}
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}

function BrukerDetaljer({ b, moduler }: { b: Bruker; moduler: Modul[] | null }) {
  return (
    <div className="admin-detaljer">
      <Fakta
        rader={[
          ["E-post", <a href={`mailto:${b.epost}`}>{b.epost}</a>],
          ["Konto", { venter: "Venter på godkjenning", godkjent: "Godkjent", avvist: "Avvist" }[b.status] ?? b.status],
          ...(b.status === "avvist" ? ([["Avvist fordi", b.avvist_grunn]] as [string, ReactNode][]) : []),
          ["Registrert", dato(b.opprettet)],
          ["Moduler", b.moduler?.length ? opplisting(modulnavn(moduler, b.moduler)) : "Ikke valgt (får standarden for nye organisasjoner)"],
          ["Sist aktiv", siden(b.sist_aktiv)],
          ["Passkeys", b.antall_passkeys ? `${b.antall_passkeys} (sist brukt ${siden(b.sist_passkey)})` : "Ingen"],
        ]}
      />
      <p className="liten dempet">Ikke med i noen organisasjon. Brukerne i organisasjonene står under organisasjonen de er med i.</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Drift
// ---------------------------------------------------------------------------

const epostStatus: [string, string][] = [
  ["levert", "Levert"],
  ["sendt", "Sendt"],
  ["forsinket", "Forsinket"],
  ["sprett", "Sprett"],
  ["klage", "Klage"],
];
const ehfStatus: [string, string][] = [
  ["levert", "Levert"],
  ["venter", "Venter"],
  ["sender", "Sender"],
  ["feilet", "Feilet"],
];

// Prøver AI-oppsettet med en liten forespørsel til Gemini, og viser svaret fra Google.
type AiTestResultat = { navn: string; ok: boolean; ms: number; svar?: string; feil?: string; detaljer?: string | null; skjemafeil?: string | null };

// Tester et enkelt svar og de ekte forespørslene for fakturautkast og assistenten.
function AiTest() {
  const [svar, settSvar] = useState<any | null>(null);
  const h = useHandling();
  const sek = (ms: number) => `${(ms / 1000).toLocaleString("nb-NO", { maximumFractionDigits: 1 })} s`;
  const tester: AiTestResultat[] = svar?.tester ?? [];
  return (
    <div className="ai-test">
      <button type="button" onClick={async () => settSvar(await h.kjor(() => api("POST", "/admin/ai-test")))} disabled={h.opptatt}>
        {h.opptatt ? "Tester …" : "Test AI"}
      </button>
      {h.opptatt && <span className="dempet liten">Tester enkelt svar, fakturautkast og assistenten …</span>}
      {svar && !tester.length && (
        <span className={`${svar.ok ? "ok-tekst" : "fare-tekst"} liten`} role="status">
          {svar.ok ? `Virker: «${svar.svar}» på ${sek(svar.ms)}` : svar.feil}
          {!svar.ok && svar.detaljer && <span className="ai-detaljer"> Svar fra Google: {svar.detaljer}</span>}
        </span>
      )}
      {tester.length > 0 && (
        <ul className="ai-testliste liten" role="status">
          {tester.map((t) => (
            <li key={t.navn}>
              <span className={t.ok ? "ok-tekst" : "fare-tekst"}>
                {t.ok ? "✓" : "✗"} <strong>{t.navn}:</strong> {t.ok ? `virker (${sek(t.ms)})` : t.feil}
              </span>
              {t.ok && t.svar && <span className="ai-detaljer">Svar: {t.svar}</span>}
              {t.skjemafeil && <span className="ai-detaljer">Google avviste svarskjemaet, så svaret kom uten: {t.skjemafeil}</span>}
              {!t.ok && t.detaljer && <span className="ai-detaljer">Svar fra Google: {t.detaljer}</span>}
            </li>
          ))}
        </ul>
      )}
      <Feil melding={h.feil} />
    </div>
  );
}

// Prøver EHF-oppslaget i PEPPOL for et org.nr. og viser hvert steg: DNS (SML), SMP-en,
// svaret for EHF-fakturaen og dokumenttypene mottakeren er registrert for.
type EhfTestResultat = { orgnr: string; svar: boolean | null; smp: string | null; steg: string[]; ms: number };
function EhfTest() {
  const [nr, settNr] = useState("");
  const [svar, settSvar] = useState<EhfTestResultat | null>(null);
  const h = useHandling();
  const sek = (ms: number) => `${(ms / 1000).toLocaleString("nb-NO", { maximumFractionDigits: 1 })} s`;
  return (
    <form
      className="ehf-test"
      onSubmit={async (e) => {
        e.preventDefault();
        settSvar((await h.kjor(() => api<EhfTestResultat>("POST", "/admin/ehf-test", { orgnr: nr }))) ?? null);
      }}
    >
      <div className="ehf-test-rad">
        <label>
          Test EHF-oppslag for org.nr.
          <input inputMode="numeric" autoComplete="off" value={nr} placeholder="F.eks. 986252932" onChange={(e) => settNr(e.target.value)} />
        </label>
        <button disabled={h.opptatt || !nr.trim()}>{h.opptatt ? "Sjekker …" : "Test"}</button>
      </div>
      {svar && (
        <div className="liten" role="status">
          <p className={svar.svar ? "ok-tekst" : svar.svar === false ? "fare-tekst" : "advarsel-tekst"}>
            <strong>{svar.svar ? "✓ Kan motta EHF-faktura" : svar.svar === false ? "✗ Ikke registrert for EHF-faktura" : "? Fikk ikke svar"}</strong>{" "}
            <span className="dempet">
              ({orgnr(svar.orgnr)}, {sek(svar.ms)})
            </span>
          </p>
          <ol className="ehf-steg">
            {svar.steg.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ol>
        </div>
      )}
      <Feil melding={h.feil} />
    </form>
  );
}

function Drift({ apne }: { apne: (id: string) => void }) {
  const { data: d, feil, last, laster } = useData(() => hent<any>("/admin/drift"), []);
  if (feil) return <Feil melding={feil} />;
  if (!d) return <Laster />;
  const utboksForsinket = d.utboks.venter > 0 && d.utboks.eldste && Date.now() - Date.parse(d.utboks.eldste) > 15 * 60_000;
  const Org = ({ p }: { p: any }) => (
    <button type="button" className="lenke" onClick={() => apne(p.org_id)}>
      {p.org}
    </button>
  );
  const Tellinger = ({ tall, navn }: { tall: Record<string, number>; navn: [string, string][] }) => (
    <div className="admin-tellinger">
      {navn.map(([n, t]) => (
        <span key={n} className={(n === "sprett" || n === "klage" || n === "feilet") && tall[n] ? "fare-tekst" : undefined}>
          <strong>{tall[n] ?? 0}</strong> {t.toLowerCase()}
        </span>
      ))}
    </div>
  );

  return (
    <>
      <div className="admin-verktoy">
        <span className="dempet liten">Siste sju dager, og det som står med feil nå.</span>
        <button type="button" onClick={last} disabled={laster}>
          Oppdater
        </button>
      </div>
      <div className="admin-drift">
        <section className="kort">
          <h2>Hendelser</h2>
          {d.utboks.venter === 0 ? (
            <p className="ok-tekst">Alle hendelser er sendt videre.</p>
          ) : (
            <p className={utboksForsinket ? "fare-tekst" : undefined}>
              {d.utboks.venter} venter på å bli sendt videre, den eldste {siden(d.utboks.eldste)}.
              {d.utboks.siste_feil && <span className="liten"> Siste feil: {d.utboks.siste_feil}</span>}
            </p>
          )}
        </section>

        <section className="kort">
          <h2>E-post</h2>
          <Tellinger tall={d.epost} navn={epostStatus} />
          {d.epost_problemer.length > 0 && (
            <ul className="admin-rader">
              {d.epost_problemer.map((p: any, i: number) => (
                <li key={i}>
                  <span>
                    <Org p={p} /> <span className="dempet liten">· {p.til}</span>
                    {p.detaljer && <span className="liten"> · {p.detaljer}</span>}
                  </span>
                  <span className="merker">
                    <span className={`merke ${p.status === "forsinket" ? "merke-advarsel" : "merke-fare"}`}>{stor(p.status)}</span>
                    <span className="dempet liten">{siden(p.tid)}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="kort">
          <h2>EHF</h2>
          <Tellinger tall={d.ehf} navn={ehfStatus} />
          <EhfTest />
          {d.ehf_problemer.length > 0 && (
            <ul className="admin-rader">
              {d.ehf_problemer.map((p: any, i: number) => (
                <li key={i}>
                  <span>
                    <Org p={p} /> <span className="dempet liten">· til {p.mottaker}</span>
                    {p.detaljer && <span className="liten"> · {p.detaljer}</span>}
                  </span>
                  <span className="merker">
                    <span className="merke merke-fare">{p.status === "sender" ? "Ukjent utfall" : "Feilet"}</span>
                    <span className="dempet liten">{siden(p.tid)}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="kort">
          <h2>AI (Gemini)</h2>
          {!d.ai?.satt_opp ? (
            <p className="dempet">AI er ikke satt opp.</p>
          ) : (
            <>
              <p className="dempet liten" style={{ marginTop: 0 }}>
                {d.ai.modell} i {d.ai.region} · høyst {d.ai.grense} forespørsler per organisasjon i måneden
              </p>
              <AiTest />
              <div className="admin-tellinger">
                <span>
                  <strong>{d.ai.sum.antall}</strong> forespørsler denne måneden
                </span>
                <span>
                  <strong>{Math.round((Number(d.ai.sum.tokens_inn) + Number(d.ai.sum.tokens_ut)) / 1000)}k</strong> tokens
                </span>
                <span>
                  <strong>{d.ai.forrige.antall}</strong> forrige måned
                </span>
              </div>
              {d.ai.organisasjoner.length > 0 && (
                <ul className="admin-rader">
                  {d.ai.organisasjoner.map((p: any) => (
                    <li key={p.org_id}>
                      <span>
                        <Org p={p} />{" "}
                        <span className="dempet liten">
                          · {p.faktura} fakturautkast · {p.innbetaling} {p.innbetaling === 1 ? "innbetaling" : "innbetalinger"} · {p.assistent ?? 0} til
                          assistenten{p.lonnsslipp ? ` · ${p.lonnsslipp} med lønnsslipper` : ""}
                        </span>
                      </span>
                      <span className="merker">
                        <span
                          className={`merke ${p.faktura + p.innbetaling + (p.assistent ?? 0) + (p.lonnsslipp ?? 0) >= d.ai.grense * 0.8 ? "merke-advarsel" : "merke-noytral"}`}
                        >
                          {p.faktura + p.innbetaling + (p.assistent ?? 0) + (p.lonnsslipp ?? 0)} av {d.ai.grense}
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </section>

        <section className="kort">
          <h2>Integrasjoner og banker</h2>
          {d.integrasjoner.length === 0 && d.banker.length === 0 ? (
            <p className="ok-tekst">Ingen feil.</p>
          ) : (
            <ul className="admin-rader">
              {d.integrasjoner.map((p: any, i: number) => (
                <li key={`i${i}`}>
                  <span>
                    <Org p={p} /> <span className="dempet liten">· {integrasjonTekst[p.type] ?? p.type}</span>
                    {p.siste_feil && <span className="liten"> · {p.siste_feil}</span>}
                  </span>
                  <span className="dempet liten">{siden(p.tid)}</span>
                </li>
              ))}
              {d.banker.map((p: any, i: number) => (
                <li key={`b${i}`}>
                  <span>
                    <Org p={p} /> <span className="dempet liten">· bank: {p.bank}</span>
                    {p.siste_feil && <span className="liten"> · {p.siste_feil}</span>}
                  </span>
                  <span className="merker">
                    <span className={`merke ${p.status === "feil" ? "merke-fare" : "merke-advarsel"}`}>{p.status === "feil" ? "Må kobles til på nytt" : "Feil ved henting"}</span>
                    <span className="dempet liten">{siden(p.tid)}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </>
  );
}
