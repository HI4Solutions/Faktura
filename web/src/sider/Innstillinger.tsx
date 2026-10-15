import { useEffect, useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { api, hent, lastOppLogo } from "../api";
import { Dialog, EpostlisteFelt, Feil, Laster, tall, tilEpostliste, ugyldigeEposter, useData, useHandling } from "../felles";
import { erAdmin, harFunksjon, harModul, MODULNAVN, useKonto, type MinOrg, type ModulKode } from "../konto";
import { dato, orgnr } from "../format";
import { Totrinn } from "./Totrinn";
import { AppOgVarsler } from "./Varsler";
import { EhfSending } from "./Ehf";
import { BankKobling, kontoerEndret } from "./Bank";
import { SkattekortKobling } from "./Skattekort";
import { BokforingOppsett } from "./LonnBokforing";
import { oppdaterLegitimasjon, passkeyHer } from "../applaas";
import { forberedVelger, velgMappe } from "../googleVelger";
import { erAvbrutt, foreslattNavn, leggTilPasskey, passkeyFeil, stotterPasskey } from "../passkey";
import { SlettOrganisasjon } from "../slettOrg";

type OrgDel = "organisasjon" | "faktura" | "betaling";
type InnstillingFane = "organisasjon" | "faktura" | "personal" | "lonn" | "konto" | "app";

// Fanene i innstillingene: organisasjonens bare for eier og administrator. Regnskapsbyråer
// fakturerer ikke; Faktura er med når modulen er på (eller banken, som regnskapet også bruker),
// Personal og Lønn når funksjonene er på.
function innstillingFaner(org: MinOrg | null | undefined): [InnstillingFane, string][] {
  const faner: [InnstillingFane, string][] = [];
  if (org && erAdmin(org)) {
    const byraa = org.type === "regnskapsbyraa";
    faner.push(["organisasjon", "Organisasjon"]);
    if (!byraa && (harFunksjon(org, "faktura") || harFunksjon(org, "bank"))) faner.push(["faktura", "Faktura"]);
    if (org.type !== "privatperson" && harFunksjon(org, "ansatte")) faner.push(["personal", "Personal"]);
    if (org.type !== "privatperson" && harFunksjon(org, "lonn")) faner.push(["lonn", "Lønn"]);
  }
  faner.push(["konto", "Min konto"], ["app", "App"]);
  return faner;
}

// Underfanene i hver fane (?del=): det som hører sammen, så hver side blir kort. Google Disk er med
// når en av organisasjonene har funksjonen.
function underfaner(fane: InnstillingFane, org: MinOrg | null, orgs: MinOrg[]): [string, string][] {
  const byraa = org?.type === "regnskapsbyraa";
  const faktura = harFunksjon(org, "faktura");
  switch (fane) {
    case "organisasjon":
      return [
        ["opplysninger", "Opplysninger"],
        ["brukere", "Brukere"],
        ["roller", "Roller"],
        ["regnskapsforer", byraa ? "Klienter" : "Regnskapsfører"],
        ...(org?.rolle === "eier" && org.direkte_medlem ? [["slett", "Slett organisasjonen"] as [string, string]] : []),
      ];
    case "faktura":
      return [
        ...(faktura
          ? ([
              ["oppsett", "Fakturaoppsett"],
              ["logo", "Logo"],
              ["betaling", "Betaling og purring"],
              ["kontoer", "Kontonumre"],
            ] as [string, string][])
          : []),
        ...(harFunksjon(org, "bank") ? [["bank", "Bank"] as [string, string]] : []),
        ...(faktura && org?.type !== "privatperson" && harFunksjon(org, "ehf") ? [["ehf", "EHF"] as [string, string]] : []),
      ];
    case "personal":
      return [
        ["arbeidstid", "Arbeidstid og overtid"],
        ...(harFunksjon(org, "vaktplan")
          ? ([
              ["fravaer", "Ferie og egenmelding"],
              ["vaktbytte", "Vaktbytte"],
            ] as [string, string][])
          : []),
        ["timebank", "Timebank"],
        ["bursdager", "Bursdager"],
      ];
    case "lonn":
      return [
        ["lonn", "Lønn"],
        ["betalingsfil", "Betalingsfil"],
        ["amelding", "A-melding"],
        ["skattekort", "Skattekort"],
        ["bokforing", "Bokføring"],
      ];
    case "konto":
      return [["innlogging", "Innlogging"], ...(orgs.some((o) => harFunksjon(o, "google_disk")) ? [["disk", "Google Disk"] as [string, string]] : [])];
    case "app":
      return [
        ["app", "App"],
        ["varsler", "Varsler"],
      ];
  }
}

// Gamle adresser (lenker og varsler bruker dem fortsatt): fanen og underfanen de er nå. Fra før
// lå lønnen på fanen Ansatte og timer (#lonn, #afp, #amelding, #skattekort), og betalingen,
// EHF, brukerne og skattekortene var egne faner.
function nyAdresse(fane: string | null, del: string | null, sted: string, bank: boolean): [string | null, string | null] {
  if (fane === "betaling") return ["faktura", bank ? "bank" : "betaling"];
  if (fane === "ehf") return ["faktura", "ehf"];
  if (fane === "brukere") return ["organisasjon", "brukere"];
  if (fane === "skattekort") return ["lonn", "skattekort"];
  if (fane === "personal" && !del) {
    if (sted === "lonn" || sted === "afp") return ["lonn", "lonn"];
    if (sted === "amelding") return ["lonn", "amelding"];
    if (sted === "skattekort") return ["lonn", "skattekort"];
  }
  return [fane, del];
}

// Innstillingene er delt i faner, og hver fane i underfaner. Fanen og underfanen står i adressen
// (?fane=&del=), så lenker kan gå rett dit. Organisasjon har opplysningene, brukerne, rollene,
// regnskapsføreren og slettingen; Faktura oppsettet av fakturaene, logoen, betalingen, kontonumrene,
// banken og EHF; Personal arbeidstiden, ferien, vaktbyttene, timebanken og bursdagene; Lønn
// lønnsoppsettet, betalingsfila, a-meldingen, skattekortene og bokføringen.
// Fanen og underfanen adressen gir (også de gamle adressene), med fanene og underfanene som finnes.
function valgtInnstilling(org: MinOrg | null, orgs: MinOrg[], sok: URLSearchParams, hash: string) {
  const faner = innstillingFaner(org);
  // Tilbake fra Google (Google Disk-koblingen): «Min konto».
  const [onsket, onsketDel] = nyAdresse(
    sok.get("fane") ?? (sok.has("disk") ? "konto" : null),
    sok.get("del") ?? (sok.has("disk") ? "disk" : null),
    hash.replace(/^#/, ""),
    sok.has("bank") || sok.has("kobling"),
  );
  const fane = faner.find(([v]) => v === onsket)?.[0] ?? faner[0][0];
  const deler = underfaner(fane, org, orgs);
  const del = deler.find(([v]) => v === onsketDel)?.[0] ?? deler[0]?.[0] ?? "";
  return { faner, fane, deler, del };
}

export function Innstillinger() {
  const { org, meg } = useKonto();
  const [sok, settSok] = useSearchParams();
  const { hash } = useLocation();
  const admin = Boolean(org && erAdmin(org));
  const { faner, fane, deler, del } = valgtInnstilling(org, meg?.organisasjoner ?? [], sok, hash);
  const skjema = useOrgSkjema(admin);
  // Et sted på underfanen (f.eks. #afp) når innholdet over er lastet.
  useRullTil(hash ? hash.replace(/^#/, "") : null);
  // Til en annen fane eller underfane (uten det som var med i adressen fra før, f.eks. svaret fra
  // banken eller Google).
  const ga = (f: InnstillingFane, d?: string) => settSok(d ? { fane: f, del: d } : { fane: f }, { replace: true });

  return (
    <>
      <h1>Innstillinger</h1>
      <div className="faner innstillinger-faner" role="tablist" aria-label="Innstillinger">
        {faner.map(([v, navn]) => (
          <button key={v} type="button" role="tab" aria-selected={fane === v} className={fane === v ? "valgt" : undefined} onClick={() => ga(v)}>
            {navn}
          </button>
        ))}
      </div>
      {deler.length > 1 && (
        <div className="underfaner" role="tablist" aria-label={faner.find(([v]) => v === fane)?.[1]}>
          {deler.map(([v, navn]) => (
            <button key={v} type="button" role="tab" aria-selected={del === v} className={del === v ? "valgt" : undefined} onClick={() => ga(fane, v)}>
              {navn}
            </button>
          ))}
        </div>
      )}
      {fane === "organisasjon" && (
        <>
          {del === "opplysninger" && <OrgSkjemaDel del="organisasjon" skjema={skjema} />}
          {del === "brukere" && <Medlemmer />}
          {del === "roller" && <Tilgangsroller />}
          {del === "regnskapsforer" && <Regnskapsforer />}
          {del === "slett" && <SlettOrg />}
        </>
      )}
      {fane === "faktura" && (
        <>
          {del === "oppsett" && <OrgSkjemaDel del="faktura" skjema={skjema} />}
          {del === "logo" && <Logo />}
          {del === "betaling" && <OrgSkjemaDel del="betaling" skjema={skjema} />}
          {del === "kontoer" && <Kontoer />}
          {del === "bank" && <BankKobling />}
          {del === "ehf" && <EhfSending />}
        </>
      )}
      {(fane === "personal" || (fane === "lonn" && ["lonn", "betalingsfil", "amelding"].includes(del))) && <PersonalOppsett del={del} />}
      {fane === "lonn" && del === "skattekort" && <SkattekortKobling />}
      {fane === "lonn" && del === "bokforing" && <BokforingOppsett />}
      {fane === "konto" && <MinKonto del={del} />}
      {fane === "app" && <AppOgVarsler del={del === "varsler" ? "varsler" : "app"} />}
    </>
  );
}

// Til et sted på fanen (f.eks. betalingen fra en lenke) når innholdet over er lastet.
function useRullTil(id: string | null) {
  useEffect(() => {
    if (!id) return;
    let n = 0;
    const t = window.setInterval(() => {
      const el = document.getElementById(id);
      n++;
      if (el && (!document.querySelector(".innhold .laster") || n > 20)) {
        el.scrollIntoView({ block: "start" });
        window.clearInterval(t);
      } else if (n > 40) window.clearInterval(t);
    }, 100);
    return () => window.clearInterval(t);
  }, [id]);
}

// Eieren kan slette organisasjonen, med en grunn (se slettOrg.tsx).
function SlettOrg() {
  const { org, oppdater } = useKonto();
  const [apen, settApen] = useState(false);
  const naviger = useNavigate();
  if (!org) return null;
  return (
    <div className="kort fare-sone">
      <h2>Slett organisasjonen</h2>
      <p className="dempet">
        Sletter {org.navn} fra Admin Konsoll for alle brukerne. Du må skrive hvorfor. Har organisasjonen utstedte fakturaer, stenges den i stedet, og fakturaene
        oppbevares så lenge bokføringsloven krever.
      </p>
      <div className="knapper">
        <button type="button" className="fare" onClick={() => settApen(true)}>
          Slett organisasjonen …
        </button>
      </div>
      <SlettOrganisasjon
        navn={org.navn}
        sti={`/org/${org.id}/slett`}
        apen={apen}
        lukk={() => settApen(false)}
        ferdig={async () => {
          settApen(false);
          await oppdater();
          naviger("/", { replace: true });
        }}
      />
    </div>
  );
}

// Ansatte og timer: slås på per organisasjon, med grensene for overtid, timebanken
// (0073_timebank.sql), bursdagsvarslene, om de ansatte kan bytte vakter (Vaktbytte.tsx), om det er
// åpent i helgene (0064_helg.sql) og lønnsoppsettet (0065_lonn.sql: sone for arbeidsgiveravgift,
// OTP, feriepenger, lønnsdag og måneden med halv skatt).
type Bursdagsvarsel = "av" | "push" | "epost" | "begge";
type Vaktbytte = "av" | "godkjenning" | "fritt";
const AGA_SONER: [string, string][] = [
  ["1", "Sone 1 – 14,1 %"],
  ["1a", "Sone 1a – 10,6 % til fribeløpet er brukt, deretter 14,1 %"],
  ["2", "Sone 2 – 10,6 %"],
  ["3", "Sone 3 – 6,4 %"],
  ["4", "Sone 4 – 5,1 %"],
  ["4a", "Sone 4a – 7,9 %"],
  ["5", "Sone 5 – 0 % (Finnmark og Nord-Troms)"],
];
// Flere virksomheter (0101_virksomheter.sql): underenhetene i foretaket med sonen for
// arbeidsgiveravgift. Den ansatte velger virksomheten i ansattskjemaet; uten valg er det
// hovedvirksomheten (A-melding over). Lagres for seg (ikke med skjemaet rundt).
type Virksomhet = { id: string; orgnr: string; navn: string; aga_sone: string; ansatte: number };
function FlereVirksomheter({ enhetsregisteret, hoved }: { enhetsregisteret: { orgnr: string; navn: string }[]; hoved: string }) {
  const { org } = useKonto();
  const { data, last } = useData(() => hent<{ andre: Virksomhet[] }>(`/org/${org!.id}/lonn/virksomheter`), [org?.id]);
  const tom = { orgnr: "", navn: "", aga_sone: "1" };
  const [ny, settNy] = useState(tom);
  const h = useHandling();
  const kan = Boolean(org && erAdmin(org));
  const andre = data?.andre ?? [];
  async function leggTil() {
    const r = await h.kjor(() => api("POST", `/org/${org!.id}/lonn/virksomheter`, { ...ny, orgnr: ny.orgnr.replace(/\s/g, ""), navn: ny.navn.trim() }));
    if (r) {
      settNy(tom);
      last();
    }
  }
  const sone = (v: Virksomhet, aga_sone: string) => h.kjor(() => api("PATCH", `/org/${org!.id}/lonn/virksomheter/${v.id}`, { aga_sone })).then(last);
  const fjern = (v: Virksomhet) => confirm(`Fjerne ${v.navn}?`) && h.kjor(() => api("DELETE", `/org/${org!.id}/lonn/virksomheter/${v.id}`)).then(last);
  return (
    <>
      <h4 className="lonn-under">Flere virksomheter</h4>
      <p className="felt-hjelp">
        Har foretaket flere virksomheter (underenheter), kanskje i andre soner for arbeidsgiveravgift? Legg dem inn her, og velg virksomheten på hver ansatt (uten valg:
        hovedvirksomheten over). Lønnskjøringen regner avgiften med sonen til virksomheten, og a-meldingen får én virksomhet per underenhet.
      </p>
      {andre.length > 0 && (
        <table className="kompakt virksomheter">
          <tbody>
            {andre.map((v) => (
              <tr key={v.id}>
                <td>
                  {v.navn}
                  <div className="dempet liten">
                    {orgnr(v.orgnr)} · {v.ansatte === 1 ? "1 ansatt" : `${v.ansatte} ansatte`}
                  </div>
                </td>
                <td>
                  <select aria-label={`Sone for ${v.navn}`} value={v.aga_sone} disabled={!kan || h.opptatt} onChange={(e) => sone(v, e.target.value)}>
                    {AGA_SONER.map(([z, t]) => (
                      <option key={z} value={z}>
                        {t}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="hoyre">
                  {kan && (
                    <button type="button" className="lenke" onClick={() => fjern(v)}>
                      Fjern
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {kan && (
        <div className="rad" style={{ alignItems: "end" }}>
          <label>
            Organisasjonsnummer
            <input
              inputMode="numeric"
              list="amelding-virksomheter"
              placeholder="9 siffer"
              value={ny.orgnr}
              onChange={(e) => {
                const treff = enhetsregisteret.find((x) => x.orgnr === e.target.value.replace(/\s/g, ""));
                settNy({ ...ny, orgnr: e.target.value, navn: ny.navn || treff?.navn || "" });
              }}
            />
          </label>
          <label>
            Navn
            <input value={ny.navn} onChange={(e) => settNy({ ...ny, navn: e.target.value })} />
          </label>
          <label>
            Sone
            <select value={ny.aga_sone} onChange={(e) => settNy({ ...ny, aga_sone: e.target.value })}>
              {AGA_SONER.map(([z, t]) => (
                <option key={z} value={z}>
                  {t}
                </option>
              ))}
            </select>
          </label>
          <label>
            <button type="button" onClick={leggTil} disabled={h.opptatt || !ny.orgnr.trim() || !ny.navn.trim() || ny.orgnr.replace(/\s/g, "") === hoved}>
              Legg til
            </button>
          </label>
        </div>
      )}
      <Feil melding={h.feil} />
    </>
  );
}
// Egenmelding (0071_egenmelding.sql): lovens regler, IA-ordningen eller en egen ordning.
type Egenmeldingsordning = "lov" | "ia" | "egen";
const ordning = (dager: number, ganger: number | null, dagerAar: number | null): Egenmeldingsordning =>
  dager === 3 && ganger === 4 && dagerAar == null ? "lov" : dager === 8 && ganger == null && dagerAar === 24 ? "ia" : "egen";
const valgfrittTall = (t: string) => (t.trim() ? tall(t) : null);
function egenmeldingsregler(o: { egenmelding: Egenmeldingsordning; egenmelding_dager: string; egenmelding_ganger: string; egenmelding_dager_aar: string; egenmelding_barn_dager: string }) {
  const barn = { egenmelding_barn_dager: tall(o.egenmelding_barn_dager) };
  if (o.egenmelding === "lov") return { egenmelding_dager: 3, egenmelding_ganger: 4, egenmelding_dager_aar: null, ...barn };
  if (o.egenmelding === "ia") return { egenmelding_dager: 8, egenmelding_ganger: null, egenmelding_dager_aar: 24, ...barn };
  return {
    egenmelding_dager: tall(o.egenmelding_dager),
    egenmelding_ganger: valgfrittTall(o.egenmelding_ganger),
    egenmelding_dager_aar: valgfrittTall(o.egenmelding_dager_aar),
    ...barn,
  };
}
// Overskriften på hver underfane i Personal og Lønn (samme skjema, lagres samlet).
const TITTEL: Record<string, string> = {
  arbeidstid: "Arbeidstid og overtid",
  fravaer: "Ferie og egenmelding",
  vaktbytte: "Vaktbytte",
  timebank: "Timebank",
  bursdager: "Bursdager",
  lonn: "Lønn",
  betalingsfil: "Betalingsfil til nettbanken",
  amelding: "A-melding",
};
function PersonalOppsett({ del }: { del: string }) {
  const { org, oppdater } = useKonto();
  const { data } = useData(() => hent(`/org/${org!.id}/lonn-oppsett`), [org?.id]);
  // Virksomhetene (underenhetene) i Enhetsregisteret, til a-meldingen (null: ikke slått opp).
  const virksomheter = useData<{ orgnr: string; navn: string; adresse: string | null }[] | null>(
    () => (harFunksjon(org, "lonn") ? hent<{ orgnr: string; navn: string; adresse: string | null }[]>(`/org/${org!.id}/amelding-virksomheter`).catch(() => null) : Promise.resolve(null)),
    [org?.id],
  );
  const [o, settO] = useState<{
    aktiv: boolean;
    daglig_grense: string;
    ukentlig_grense: string;
    overtid_prosent: string;
    bursdag_varsel: Bursdagsvarsel;
    full_stilling: string;
    ferie_dager: string;
    vaktbytte: Vaktbytte;
    vaktbytte_fridag: boolean;
    helg: boolean;
    timebank: boolean;
    aga_sone: string;
    otp_prosent: string;
    otp_unntak_75: boolean;
    afp: boolean;
    afp_sats: string;
    ou_premie: string;
    feriepenger_prosent: string;
    lonnsdag: string;
    halv_skatt: "november" | "desember";
    lonnskonto: string;
    skatt_kontonr: string;
    bank_bic: string;
    betalingsfil_format: "pain.001.001.03" | "pain.001.001.09";
    virksomhet_orgnr: string;
    pensjonsinnretning_orgnr: string;
    sykepenger_refusjon: boolean;
    reise_satser: "staten" | "trekkfri";
    auto_kjoring: boolean;
    egenmelding: Egenmeldingsordning;
    egenmelding_dager: string;
    egenmelding_ganger: string;
    egenmelding_dager_aar: string;
    egenmelding_barn_dager: string;
  } | null>(null);
  const [lagret, settLagret] = useState(false);
  const h = useHandling();
  const tekst = (n: number) => String(n).replace(".", ",");
  useEffect(() => {
    if (data)
      settO({
        aktiv: data.aktiv,
        daglig_grense: tekst(data.daglig_grense),
        ukentlig_grense: tekst(data.ukentlig_grense),
        overtid_prosent: String(data.overtid_prosent),
        bursdag_varsel: data.bursdag_varsel ?? "av",
        full_stilling: tekst(data.full_stilling ?? 37.5),
        ferie_dager: tekst(data.ferie_dager ?? 25),
        vaktbytte: data.vaktbytte ?? "godkjenning",
        vaktbytte_fridag: data.vaktbytte_fridag ?? true,
        helg: data.helg ?? true,
        timebank: data.timebank ?? false,
        aga_sone: data.aga_sone ?? "1",
        otp_prosent: tekst(data.otp_prosent ?? 2),
        otp_unntak_75: data.otp_unntak_75 ?? false,
        afp: data.afp ?? false,
        afp_sats: tekst(data.afp_sats ?? 2.7),
        ou_premie: data.ou_premie ? tekst(data.ou_premie) : "",
        feriepenger_prosent: tekst(data.feriepenger_prosent ?? 12),
        lonnsdag: String(data.lonnsdag ?? 20),
        halv_skatt: data.halv_skatt ?? "desember",
        lonnskonto: data.lonnskonto ? data.lonnskonto.replace(/^(\d{4})(\d{2})(\d{5})$/, "$1.$2.$3") : "",
        skatt_kontonr: data.skatt_kontonr ? data.skatt_kontonr.replace(/^(\d{4})(\d{2})(\d{5})$/, "$1.$2.$3") : "",
        bank_bic: data.bank_bic ?? "",
        betalingsfil_format: data.betalingsfil_format ?? "pain.001.001.03",
        virksomhet_orgnr: data.virksomhet_orgnr ?? "",
        pensjonsinnretning_orgnr: data.pensjonsinnretning_orgnr ?? "",
        sykepenger_refusjon: data.sykepenger_refusjon ?? true,
        reise_satser: data.reise_satser ?? "staten",
        auto_kjoring: data.auto_kjoring ?? true,
        egenmelding: ordning(data.egenmelding_dager ?? 3, data.egenmelding_ganger === undefined ? 4 : data.egenmelding_ganger, data.egenmelding_dager_aar ?? null),
        egenmelding_dager: String(data.egenmelding_dager ?? 3),
        egenmelding_ganger: data.egenmelding_ganger == null ? "" : String(data.egenmelding_ganger),
        egenmelding_dager_aar: data.egenmelding_dager_aar == null ? "" : String(data.egenmelding_dager_aar),
        egenmelding_barn_dager: String(data.egenmelding_barn_dager ?? 3),
      });
  }, [data]);
  if (!o) return <Laster />;

  async function lagre(e: FormEvent) {
    e.preventDefault();
    settLagret(false);
    const r = await h.kjor(() =>
      api("PUT", `/org/${org!.id}/lonn-oppsett`, {
        aktiv: o!.aktiv,
        daglig_grense: tall(o!.daglig_grense),
        ukentlig_grense: tall(o!.ukentlig_grense),
        overtid_prosent: tall(o!.overtid_prosent),
        bursdag_varsel: o!.bursdag_varsel,
        full_stilling: tall(o!.full_stilling),
        ferie_dager: tall(o!.ferie_dager),
        vaktbytte: o!.vaktbytte,
        vaktbytte_fridag: o!.vaktbytte_fridag,
        helg: o!.helg,
        timebank: o!.timebank,
        ...(harFunksjon(org, "vaktplan") ? egenmeldingsregler(o!) : {}),
        ...(harFunksjon(org, "lonn")
          ? {
              aga_sone: o!.aga_sone,
              otp_prosent: tall(o!.otp_prosent),
              otp_unntak_75: o!.otp_unntak_75,
              afp: o!.afp,
              ...(o!.afp ? { afp_sats: tall(o!.afp_sats), ou_premie: o!.ou_premie.trim() ? tall(o!.ou_premie) : 0 } : {}),
              feriepenger_prosent: tall(o!.feriepenger_prosent),
              lonnsdag: tall(o!.lonnsdag),
              halv_skatt: o!.halv_skatt,
              lonnskonto: o!.lonnskonto.trim() || null,
              skatt_kontonr: o!.skatt_kontonr.trim() || null,
              bank_bic: o!.bank_bic.trim() || null,
              betalingsfil_format: o!.betalingsfil_format,
              virksomhet_orgnr: o!.virksomhet_orgnr.replace(/\s/g, "") || null,
              pensjonsinnretning_orgnr: o!.pensjonsinnretning_orgnr.replace(/\s/g, "") || null,
              sykepenger_refusjon: o!.sykepenger_refusjon,
              reise_satser: o!.reise_satser,
              auto_kjoring: o!.auto_kjoring,
            }
          : {}),
      }),
    );
    if (!r) return;
    settLagret(true);
    await oppdater(); // menyen får (eller mister) Ansatte og Timer, og helgen og timebanken vises eller ikke
  }

  return (
    <form className="kort" onSubmit={lagre}>
      <h2 style={{ marginTop: 0 }}>{TITTEL[del] ?? "Ansatte og timer"}</h2>
      {del === "arbeidstid" && (
        <>
          <p className="dempet">
            Hold oversikt over de ansatte, og la dem føre timene sine i appen. De leverer uka, og du godkjenner eller avviser den. Overtiden regnes ut av seg selv.
          </p>
          <label>
            <input type="checkbox" checked={o.aktiv} onChange={(e) => settO({ ...o, aktiv: e.target.checked })} />
            Bruk ansatte og timer i {org?.navn}
          </label>
          <label>
            Full stilling (timer per uke)
            <input inputMode="decimal" required value={o.full_stilling} onChange={(e) => settO({ ...o, full_stilling: e.target.value })} />
            <span className="felt-hjelp">
              Det nye ansatte får, så det ikke må skrives inn hver gang (vanligvis 37,5; 35,5 eller 33,6 med turnus eller skift). Hver ansatt kan ha sin egen, og
              stillingsprosenten regnes av den.
            </span>
          </label>
          <label>
            <input type="checkbox" checked={o.helg} onChange={(e) => settO({ ...o, helg: e.target.checked })} />
            Åpent i helgene (lørdag og søndag)
          </label>
          <p className="liten dempet">
            Har dere stengt i helgene, viser vaktplanen, tavla, timene og de faste arbeidsdagene bare mandag–fredag, og dag for dag hopper over helgen. Lørdag og
            søndag vises likevel når noen har vakt, fast dag eller timer da.
          </p>
          <h3>Overtid</h3>
          <div className="rad">
            <label>
              Timer per dag før overtid
              <input inputMode="decimal" required value={o.daglig_grense} onChange={(e) => settO({ ...o, daglig_grense: e.target.value })} />
            </label>
            <label>
              Timer per uke før overtid
              <input inputMode="decimal" required value={o.ukentlig_grense} onChange={(e) => settO({ ...o, ukentlig_grense: e.target.value })} />
            </label>
            <label>
              Overtidstillegg (%)
              <input inputMode="numeric" required value={o.overtid_prosent} onChange={(e) => settO({ ...o, overtid_prosent: e.target.value })} />
            </label>
          </div>
          <p className="liten dempet">
            Arbeidsmiljøloven: arbeid ut over 9 timer per dag eller 40 timer per uke er overtid, med minst 40 % tillegg (§ 10-4 og § 10-6). Har dere tariffavtale
            med andre grenser, skriver du dem her.
          </p>
        </>
      )}
      {del === "fravaer" && harFunksjon(org, "vaktplan") && (
        <>
          <h3>Ferie</h3>
          <label>
            Feriedager per år (med fem arbeidsdager i uka)
            <input inputMode="decimal" required value={o.ferie_dager} onChange={(e) => settO({ ...o, ferie_dager: e.target.value })} />
            <span className="felt-hjelp">
              Feriebanken regnes av dette: 25 er fem uker, 21 er lovens fire uker og én dag. Ansatte som jobber færre dager i uka får like mange uker, regnet i
              dagene de jobber, og fra året de fyller 60 en uke ekstra. Hver ansatt kan ha sin egen avtale.
            </span>
          </label>
          <h3>Egenmelding</h3>
          <label>
            Egenmelding for egen sykdom
            <select value={o.egenmelding} onChange={(e) => settO({ ...o, egenmelding: e.target.value as Egenmeldingsordning })}>
              <option value="lov">Lovens regler: inntil 3 dager, 4 ganger i løpet av 12 måneder</option>
              <option value="ia">IA-ordningen: inntil 8 dager per gang og 24 dager i løpet av 12 måneder</option>
              <option value="egen">Egen ordning</option>
            </select>
            <span className="felt-hjelp">
              De ansatte sender egenmeldingen i appen (under Mine vakter), og du får beskjed. Loven gir alltid inntil 3 dager 4 ganger i løpet av 12 måneder,
              etter to måneder i jobben; dere kan gi mer, ikke mindre.
            </span>
          </label>
          {o.egenmelding === "egen" && (
            <div className="rad">
              <label>
                Dager per gang
                <input inputMode="numeric" required value={o.egenmelding_dager} onChange={(e) => settO({ ...o, egenmelding_dager: e.target.value })} />
                <span className="felt-hjelp">3–16 (arbeidsgiverperioden)</span>
              </label>
              <label>
                Ganger i løpet av 12 måneder
                <input inputMode="numeric" placeholder="Ingen grense" value={o.egenmelding_ganger} onChange={(e) => settO({ ...o, egenmelding_ganger: e.target.value })} />
              </label>
              <label>
                Dager i løpet av 12 måneder
                <input inputMode="numeric" placeholder="Ingen grense" value={o.egenmelding_dager_aar} onChange={(e) => settO({ ...o, egenmelding_dager_aar: e.target.value })} />
              </label>
            </div>
          )}
          <label>
            Egenmelding for sykt barn: dager per gang
            <input inputMode="numeric" required value={o.egenmelding_barn_dager} onChange={(e) => settO({ ...o, egenmelding_barn_dager: e.target.value })} />
            <span className="felt-hjelp">Loven: 3 dager, deretter kan dere kreve legeerklæring. Dere kan godta flere (høyst 30).</span>
          </label>
        </>
      )}
      {del === "vaktbytte" && harFunksjon(org, "vaktplan") && (
        <>
          <label>
            Ansatte kan bytte vakter
            <select value={o.vaktbytte} onChange={(e) => settO({ ...o, vaktbytte: e.target.value as Vaktbytte })}>
              <option value="godkjenning">Ja, og du godkjenner byttene</option>
              <option value="fritt">Ja, uten godkjenning</option>
              <option value="av">Nei</option>
            </select>
            <span className="felt-hjelp">
              Under Mine vakter kan de ansatte gi bort en vakt eller en fast arbeidsdag, eller bytte den mot en vakt en kollega med samme rolle har. Når
              kollegaen sier ja, flyttes vakten, og plassen på tavla følger med. Med godkjenning må eier eller administrator godkjenne byttet først, og ser da
              advarslene etter arbeidsmiljøloven byttet gir.
            </span>
          </label>
          {o.vaktbytte !== "av" && (
            <>
              <label>
                <input type="checkbox" checked={o.vaktbytte_fridag} onChange={(e) => settO({ ...o, vaktbytte_fridag: e.target.checked })} />
                Spør hva fridagen tas fra når en ansatt gir bort en fast arbeidsdag
              </label>
              <p className="liten dempet">
                Den som gir bort en fast arbeidsdag uten å få en vakt igjen, velger da en feriedag, timer fra timebanken eller å søke om betalt fravær (med timelønn
                også fri uten lønn). Feriedagene og timene må finnes. Du godkjenner byttet, også når byttene ellers går uten godkjenning, og fraværet registreres
                da av seg selv.
              </p>
            </>
          )}
        </>
      )}
      {del === "timebank" && (
        <>
          <label>
            <input type="checkbox" checked={o.timebank} onChange={(e) => settO({ ...o, timebank: e.target.checked })} />
            Timebank: overtid og ekstratimer kan avspaseres senere
          </label>
          <p className="liten dempet">
            De ansatte kan føre overtid og ekstratimer «til timebanken» i stedet for å få dem lønnet nå, og søke om avspasering (hele dager eller noen timer) når de
            vil ta dem ut. Du godkjenner timene og avspaseringen, kan justere banken (f.eks. en dag for jobb på en fridag) og betale ut timer i lønnskjøringen. For
            overtid utbetales overtidstillegget likevel (arbeidsmiljøloven § 10-6); avspasering av overtid må avtales skriftlig, f.eks. i arbeidsavtalen.
          </p>
        </>
      )}
      {del === "lonn" && harFunksjon(org, "lonn") && (
        <>
          <label>
            <input type="checkbox" checked={o.auto_kjoring} onChange={(e) => settO({ ...o, auto_kjoring: e.target.checked })} />
            Lag lønnskjøringen for måneden automatisk
          </label>
          <p className="liten dempet">
            Den første i måneden lages lønnskjøringen for måneden (når dere har kjørt lønn her de siste tre månedene), og eier og administrator får beskjed. Alle utkast regnes ut på nytt av seg
            selv når timer, fravær, vakter, tillegg, trekk eller de ansatte endres, og dere får en påminnelse tre dager før lønnsdagen om den ikke er godkjent. Lønnen godkjennes
            alltid av dere.
          </p>
          <label>
            Sone for arbeidsgiveravgift
            <select value={o.aga_sone} onChange={(e) => settO({ ...o, aga_sone: e.target.value })}>
              {AGA_SONER.map(([v, t]) => (
                <option key={v} value={v}>
                  {t}
                </option>
              ))}
            </select>
            <span className="felt-hjelp">
              Sonen der (hoved)virksomheten er registrert (kommunen). I sone 1a gjelder den reduserte satsen til den sparte avgiften i året når 850 000 kr, for hele
              foretaket. Virksomheter i andre soner legges inn under A-melding.
            </span>
          </label>
          <div className="rad">
            <label>
              OTP (%)
              <input inputMode="decimal" required value={o.otp_prosent} onChange={(e) => settO({ ...o, otp_prosent: e.target.value })} />
              <span className="felt-hjelp">Obligatorisk tjenestepensjon, minst 2 % fra første krone opp til 12 G. 0 uten OTP.</span>
            </label>
            <label>
              Feriepenger (%)
              <select
                value={["10,2", "12"].includes(o.feriepenger_prosent) ? o.feriepenger_prosent : "annen"}
                onChange={(e) => settO({ ...o, feriepenger_prosent: e.target.value === "annen" ? "14,3" : e.target.value })}
              >
                <option value="12">12 % (fem uker ferie)</option>
                <option value="10,2">10,2 % (lovens fire uker og én dag)</option>
                <option value="annen">Annen sats</option>
              </select>
              {!["10,2", "12"].includes(o.feriepenger_prosent) && (
                <input inputMode="decimal" aria-label="Feriepengesats (%)" required value={o.feriepenger_prosent} onChange={(e) => settO({ ...o, feriepenger_prosent: e.target.value })} />
              )}
            </label>
          </div>
          {tall(o.otp_prosent) > 0 && (
            <label>
              <input type="checkbox" checked={o.otp_unntak_75} onChange={(e) => settO({ ...o, otp_unntak_75: e.target.checked })} />
              OTP-ordningen tar ikke opp ansatte som har fylt 75 år
              <span className="felt-hjelp">
                Alle ansatte fra 13 år er med i OTP fra første dag og første krone (frilansere og oppdragstakere er ikke med). Ordningens regelverk kan si at de som har
                fylt 75 år ikke tas opp; kryss av om deres gjør det. A-meldingen minner om dem som skal meldes inn eller ut hos pensjonsleverandøren.
              </span>
            </label>
          )}
          <label id="afp">
            <input type="checkbox" checked={o.afp} onChange={(e) => settO({ ...o, afp: e.target.checked })} />
            Med i Fellesordningen for AFP (tariffavtale)
            <span className="felt-hjelp">
              Lønnskjøringene avsetter AFP-premien hver måned: satsen av lønnen mellom 1 og 7,1 G i året for de ansatte fra året de fyller 13 til og med året de fyller
              61 (ikke frilansere). Fakturaen fra Fellesordningen kommer kvartalsvis; betalingen registreres under Lønn → AFP, og da kommer arbeidsgiveravgiften av
              premien med i a-meldingen.
            </span>
          </label>
          {o.afp && (
            <div className="rad">
              <label>
                AFP-premie (%)
                <input inputMode="decimal" required value={o.afp_sats} onChange={(e) => settO({ ...o, afp_sats: e.target.value })} />
                <span className="felt-hjelp">Satsen Fellesordningen har fastsatt (2,7 % for 2025 og 2026).</span>
              </label>
              <label>
                OU-premie (kr per måned per heltidsansatt)
                <input inputMode="decimal" placeholder="0" value={o.ou_premie} onChange={(e) => settO({ ...o, ou_premie: e.target.value })} />
                <span className="felt-hjelp">Opplysnings- og utviklingsfondet (LO/NHO), faktureres sammen med AFP-premien, f.eks. 46 kr i 2026. Tom: ingen.</span>
              </label>
            </div>
          )}
          <div className="rad">
            <label>
              Lønnsdag (dagen i måneden)
              <input inputMode="numeric" required value={o.lonnsdag} onChange={(e) => settO({ ...o, lonnsdag: e.target.value })} />
              <span className="felt-hjelp">Lønnen utbetales virkedagen før når dagen er en helg eller helligdag.</span>
            </label>
            <label>
              Halv skatt i
              <select value={o.halv_skatt} onChange={(e) => settO({ ...o, halv_skatt: e.target.value as "november" | "desember" })}>
                <option value="desember">Desember</option>
                <option value="november">November</option>
              </select>
              <span className="felt-hjelp">Med tabelltrekk trekkes det halv skatt én måned i året.</span>
            </label>
          </div>
          <label>
            Lønn under sykdom etter arbeidsgiverperioden
            <select value={o.sykepenger_refusjon ? "ja" : "nei"} onChange={(e) => settO({ ...o, sykepenger_refusjon: e.target.value === "ja" })}>
              <option value="ja">Vi betaler lønnen og krever refusjon fra NAV</option>
              <option value="nei">NAV betaler sykepengene til den ansatte</option>
            </select>
            <span className="felt-hjelp">
              {o.sykepenger_refusjon
                ? "Lønnen går som vanlig (med timelønn: de planlagte timene), og refusjonen kreves i inntektsmeldingen til NAV (Lønn → Sykepenger). NAV refunderer høyst 6 G."
                : "Etter de 16 dagene i arbeidsgiverperioden trekkes fastlønnen for sykedagene, og timelønn betales ikke; NAV betaler sykepengene til den ansatte."}
            </span>
          </label>
          <label>
            Satser for reiser (diett, nattillegg og kilometergodtgjørelse)
            <select value={o.reise_satser} onChange={(e) => settO({ ...o, reise_satser: e.target.value as "staten" | "trekkfri" })}>
              <option value="staten">Statens satser</option>
              <option value="trekkfri">De trekkfrie satsene</option>
            </select>
            <span className="felt-hjelp">
              {o.reise_satser === "staten"
                ? "Reiseregningene betales etter statens særavtale (f.eks. 1 012 kr per døgn med overnatting og 5,30 kr per km i 2026). Det som er over Skatteetatens trekkfrie satser, er trekkpliktig og gir arbeidsgiveravgift."
                : "Reiseregningene betales etter Skatteetatens trekkfrie satser (f.eks. 693 kr per døgn på hotell og 3,50 kr per km i 2026), så ingenting blir trekkpliktig."}
            </span>
          </label>
        </>
      )}
      {del === "betalingsfil" && harFunksjon(org, "lonn") && (
        <>
          <div className="rad">
            <label>
              Lønnskonto (lønnen betales fra)
              <input
                inputMode="numeric"
                placeholder="Organisasjonens kontonummer"
                value={o.lonnskonto}
                onChange={(e) => settO({ ...o, lonnskonto: e.target.value })}
              />
              <span className="felt-hjelp">Tom: organisasjonens kontonummer.</span>
            </label>
            <label>
              BIC for banken
              <input
                autoCapitalize="characters"
                placeholder="DNBANOKK"
                list="lonn-bic"
                value={o.bank_bic}
                onChange={(e) => settO({ ...o, bank_bic: e.target.value.toUpperCase() })}
              />
              <datalist id="lonn-bic">
                <option value="DNBANOKK">DNB</option>
                <option value="NDEANOKK">Nordea</option>
                <option value="HANDNOKK">Handelsbanken</option>
                <option value="DABANO22">Danske Bank</option>
              </datalist>
              <span className="felt-hjelp">SWIFT-adressen til banken lønnskontoen er i (står i nettbanken), f.eks. DNBANOKK for DNB.</span>
            </label>
          </div>
          <label>
            Skatteetatens kontonummer (forskuddstrekk og utleggstrekk)
            <input inputMode="numeric" value={o.skatt_kontonr} onChange={(e) => settO({ ...o, skatt_kontonr: e.target.value })} />
            <span className="felt-hjelp">
              Står på skatteetaten.no (betaling av forskuddstrekk). Da er forskuddstrekket med i betalingsfila, første virkedag etter lønnsdagen, med KID-en for
              måneden som legges inn på lønnskjøringen.
            </span>
          </label>
          <label>
            Format
            <select value={o.betalingsfil_format} onChange={(e) => settO({ ...o, betalingsfil_format: e.target.value as "pain.001.001.03" | "pain.001.001.09" })}>
              <option value="pain.001.001.03">ISO 20022 pain.001.001.03 (alle norske banker)</option>
              <option value="pain.001.001.09">ISO 20022 pain.001.001.09</option>
            </select>
            <span className="felt-hjelp">
              Den godkjente lønnskjøringen lastes ned som betalingsfil (lønn, så bare de med lønnstilgang i nettbanken ser beløpene) og lastes opp og godkjennes i
              nettbanken.
            </span>
          </label>
        </>
      )}
      {del === "amelding" && harFunksjon(org, "lonn") && (
        <>
          <div className="rad">
            <label>
              Virksomhet (underenhet)
              <input inputMode="numeric" list="amelding-virksomheter" placeholder="9 siffer" value={o.virksomhet_orgnr} onChange={(e) => settO({ ...o, virksomhet_orgnr: e.target.value })} />
              <datalist id="amelding-virksomheter">
                {(virksomheter.data ?? []).map((v) => (
                  <option key={v.orgnr} value={v.orgnr}>
                    {v.navn}
                    {v.adresse ? `, ${v.adresse}` : ""}
                  </option>
                ))}
              </datalist>
              <span className="felt-hjelp">
                Organisasjonsnummeret til virksomheten (underenheten i Enhetsregisteret) der de ansatte jobber.
                {virksomheter.data?.length === 1 && o.virksomhet_orgnr !== virksomheter.data[0]!.orgnr && (
                  <>
                    {" "}
                    <button type="button" className="lenke" onClick={() => settO({ ...o, virksomhet_orgnr: virksomheter.data![0]!.orgnr })}>
                      Bruk {virksomheter.data[0]!.navn} ({virksomheter.data[0]!.orgnr})
                    </button>
                  </>
                )}
                {virksomheter.data?.length === 0 && org!.orgnr && (
                  <>
                    {" "}
                    {/^[23]\d{8}$/.test(org!.orgnr)
                      ? "Testbedriften har ingen underenhet i Brønnøysundregistrenes testmiljø (der testdataene fra Tenor ligger). A-meldingen må ha en, så bruk en testbedrift som har en underenhet."
                      : "Enhetsregisteret har ingen underenhet for foretaket. A-meldingen må ha en: registrer virksomheten med Samordnet registermelding i Altinn, og skriv nummeret her når den er registrert."}
                  </>
                )}
              </span>
            </label>
            <label>
              Pensjonsleverandør (OTP)
              <input inputMode="numeric" placeholder="9 siffer" value={o.pensjonsinnretning_orgnr} onChange={(e) => settO({ ...o, pensjonsinnretning_orgnr: e.target.value })} />
              <span className="felt-hjelp">Organisasjonsnummeret til pensjonsinnretningen (står i OTP-avtalen). Må med i a-meldingen når det er OTP.</span>
            </label>
          </div>
          <FlereVirksomheter enhetsregisteret={virksomheter.data ?? []} hoved={o.virksomhet_orgnr.replace(/\s/g, "")} />
          <p className="liten dempet">
            Skattekortet registreres på hver ansatt, eller hentes fra Skatteetaten når dere har koblet til (under). Lønnskjøringene og a-meldingen er under{" "}
            <Link to="/lonn">Lønn</Link>.
          </p>
        </>
      )}
      {del === "bursdager" && (
        <>
          <label>
            Varsle om bursdager
            <select value={o.bursdag_varsel} onChange={(e) => settO({ ...o, bursdag_varsel: e.target.value as Bursdagsvarsel })}>
              <option value="av">Nei</option>
              <option value="push">Ja, med push-varsel</option>
              <option value="epost">Ja, med e-post</option>
              <option value="begge">Ja, med push-varsel og e-post</option>
            </select>
          </label>
          <p className="liten dempet">
            Når en ansatt har bursdag, får alle de andre i {org?.navn} beskjed kl. 08 (den som har bursdag, får ikke). Bursdagen er fødselsdatoen på ansattkortet,
            og der kan du også unnta en ansatt. Push-varsel går til dem som har slått på varsler i appen, og hver enkelt kan slå av bursdagsvarslene for seg selv.
            E-post går til e-postadressen på ansattkortet eller innloggingen.
          </p>
        </>
      )}
      <Feil melding={h.feil} />
      {lagret && (
        <div className="melding ok" role="status">
          Lagret.{o.aktiv ? " Ansatte og Timer ligger i menyen." : ""}
        </div>
      )}
      <div className="knapper">
        <button className="primar" disabled={h.opptatt}>
          Lagre
        </button>
      </div>
    </form>
  );
}

// Min konto: innloggingen (passkeys og autentiseringsappen) og Google Disk.
function MinKonto({ del }: { del: string }) {
  const { meg } = useKonto();
  if (del === "disk") return <GoogleDisk />;
  return (
    <div className="kort">
      <h2 style={{ marginTop: 0 }}>{meg?.bruker.navn}</h2>
      <p className="dempet">{meg?.bruker.epost}</p>
      <Passkeys />
      <h2>Autentiseringsapp</h2>
      <Totrinn />
      {!meg?.mfa && (
        <p className="liten dempet" style={{ marginTop: 8 }}>
          For å sende fakturaer må du være logget inn med passkey eller med kode fra autentiseringsappen. Har du nettopp
          lagt til en av dem, logger du ut og inn igjen.
        </p>
      )}
    </div>
  );
}

// Organisasjonens opplysninger og fakturaoppsett: hentet én gang for fanene, så det som ikke er
// lagret, blir med mellom dem. Hver del (et kort med egen lagreknapp) lagrer bare sine felt.
const DELFELT: Record<OrgDel, string[]> = {
  organisasjon: ["navn", "orgnr", "innehaver", "standard_avsender", "adresse", "postnr", "poststed", "epost", "telefon", "mva_registrert", "foretaksregisteret", "ai_aktiv"],
  faktura: ["standard_forfall_dager", "standard_gebyr", "standard_dager_foer_forfall", "kopi_til", "kopi_tekst", "farge"],
  betaling: ["kontonr", "bruk_kid", "purring_auto", "purring_dager", "purregebyr"],
};
const tilSkjema = (d: any) => ({
  ...d,
  standard_gebyr: String(d.standard_gebyr).replace(".", ","),
  purregebyr: String(d.purregebyr ?? 0).replace(".", ","),
  kopi_tekst: (d.kopi_til ?? []).join(", "),
});

function useOrgSkjema(aktiv: boolean) {
  const { org } = useKonto();
  const { data, settData } = useData(() => (aktiv ? hent<any>(`/org/${org!.id}`) : Promise.resolve(null)), [org?.id, aktiv]);
  const [o, settO] = useState<any>(null);
  useEffect(() => {
    settO(data ? tilSkjema(data) : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.id]);
  // Lagret: svaret blir grunnlaget, og bare den delens felt byttes i skjemaet.
  const lagret = (ny: any, del: OrgDel) => {
    settData((d: any) => ({ ...d, ...ny }));
    const s = tilSkjema(ny);
    settO((x: any) => ({ ...x, ...Object.fromEntries(DELFELT[del].map((k) => [k, s[k]])), verifisering: s.verifisering }));
  };
  return { data, o, settO, lagret };
}
type OrgSkjema = ReturnType<typeof useOrgSkjema>;

function OrgSkjemaDel({ del, skjema }: { del: OrgDel; skjema: OrgSkjema }) {
  const { org, oppdater } = useKonto();
  const { data, o, settO } = skjema;
  const h = useHandling();
  const [lagret, settLagret] = useState(false);
  if (!o || !data) return <Laster />;

  const felt = (navn: string) => ({ value: o[navn] ?? "", onChange: (e: any) => settO({ ...o, [navn]: e.target.value }) });
  const avkryss = (navn: string) => ({ checked: !!o[navn], onChange: (e: any) => settO({ ...o, [navn]: e.target.checked }) });

  async function lagre(ev: FormEvent) {
    ev.preventDefault();
    settLagret(false);
    const kropp: Record<string, unknown> = {};
    if (del === "organisasjon") {
      Object.assign(kropp, {
        navn: o.navn,
        adresse: o.adresse || null,
        postnr: o.postnr || null,
        poststed: o.poststed || null,
        epost: o.epost || null,
        telefon: o.telefon || null,
      });
      if (data.ai_tilgjengelig) kropp.ai_aktiv = o.ai_aktiv;
      if (o.type !== "privatperson") {
        Object.assign(kropp, {
          mva_registrert: o.mva_registrert,
          foretaksregisteret: o.foretaksregisteret,
          innehaver: o.innehaver?.trim() || null,
          standard_avsender: o.innehaver?.trim() ? o.standard_avsender : "firma",
        });
        if (o.verifisering === "ny") kropp.orgnr = o.orgnr ? o.orgnr.replace(/\s/g, "") : null;
        if (data.mva_registrert && !o.mva_registrert && !confirm("Fakturere uten mva fremover? Alle produkter, utkast og gjentakende fakturaer settes til 0 % mva.")) return;
      }
    } else if (del === "faktura") {
      Object.assign(kropp, {
        standard_forfall_dager: Number(o.standard_forfall_dager),
        standard_gebyr: tall(String(o.standard_gebyr)),
        standard_dager_foer_forfall: Number(o.standard_dager_foer_forfall),
        farge: o.farge || null,
      });
      // Fast kopiadresse: som kontonummeret varsles alle eiere når den endres.
      const ugyldige = ugyldigeEposter(o.kopi_tekst ?? "");
      if (ugyldige.length) return h.settFeil(`Ugyldig e-postadresse for kopi: ${ugyldige.join(", ")}`);
      const kopi = tilEpostliste(o.kopi_tekst ?? "");
      if (kopi.length > 5) return h.settFeil("Kopi kan sendes til høyst fem adresser.");
      const forrige: string[] = data.kopi_til ?? [];
      if (kopi.join(",").toLowerCase() !== forrige.join(",").toLowerCase()) {
        const tekst = kopi.length
          ? `Sende kopi av alle fakturaer til ${kopi.join(", ")}? Alle eiere får beskjed på e-post.`
          : `Slutte å sende kopi til ${forrige.join(", ")}? Kopien går da til organisasjonens e-post. Alle eiere får beskjed på e-post.`;
        if (!confirm(tekst)) return;
        kropp.kopi_til = kopi;
      }
    } else {
      Object.assign(kropp, {
        bruk_kid: o.bruk_kid,
        purring_auto: o.purring_auto,
        purring_dager: Number(o.purring_dager),
        purregebyr: tall(String(o.purregebyr ?? 0)),
      });
      const ktnr = (o.kontonr ?? "").replace(/[\s.]/g, "");
      if (ktnr !== (data.kontonr ?? "")) {
        if (!confirm(`Endre kontonummeret til ${ktnr}? Alle eiere får beskjed på e-post.`)) return;
        kropp.kontonr = ktnr || null;
      }
    }
    const r = await h.kjor(() => api("PATCH", `/org/${org!.id}`, kropp));
    if (r) {
      settLagret(true);
      skjema.lagret(r, del);
      oppdater();
      if ("kontonr" in kropp) kontoerEndret();
    }
  }

  return (
    <form className="kort" onSubmit={lagre}>
      {del === "organisasjon" && (
        <>
          <h2 style={{ marginTop: 0 }}>Organisasjon</h2>
          <p className="dempet liten">
            Status: {o.verifisering === "verifisert" ? "Verifisert" : o.verifisering === "sperret" ? "Sperret" : "Ikke verifisert"}
          </p>
          <div className="rad">
            <label className="hel">
              Navn
              <input required {...felt("navn")} />
            </label>
            {o.type !== "privatperson" && (
              <label>
                Org.nr.
                <input disabled={o.verifisering !== "ny"} {...felt("orgnr")} />
              </label>
            )}
          </div>
          {o.type === "privatperson" ? (
            <p className="dempet liten">Du fakturerer som privatperson: uten organisasjonsnummer og mva.</p>
          ) : (
            <div className="rad">
              <label>
                Innehaver (for enkeltpersonforetak)
                <input {...felt("innehaver")} placeholder="Ola Nordmann" />
              </label>
              <label className="hel">
                Avsender på fakturaene
                <select {...felt("standard_avsender")} disabled={!o.innehaver?.trim()}>
                  <option value="firma">Firmanavnet ({o.navn})</option>
                  <option value="innehaver">Innehaverens navn{o.innehaver?.trim() ? ` (${o.innehaver.trim()})` : ""}</option>
                </select>
              </label>
            </div>
          )}
          <label>
            Adresse
            <input {...felt("adresse")} />
          </label>
          <div className="rad">
            <label>
              Postnr.
              <input {...felt("postnr")} />
            </label>
            <label>
              Poststed
              <input {...felt("poststed")} />
            </label>
            <label className="hel">
              E-post (svar på fakturaer)
              <input type="email" {...felt("epost")} />
            </label>
            <label>
              Telefon
              <input {...felt("telefon")} />
            </label>
          </div>
          {o.type !== "privatperson" && (
            <>
              <label>
                <input type="checkbox" {...avkryss("mva_registrert")} /> MVA-registrert
                <span className="liten" style={{ display: "block", marginLeft: 24 }}>
                  Slå av hvis foretaket ikke er mva-registrert eller er fritatt. Da blir alle produkter, utkast og nye fakturaer
                  uten mva. Fakturaer som allerede er sendt, endres ikke.
                </span>
              </label>
              <label>
                <input type="checkbox" {...avkryss("foretaksregisteret")} /> Registrert i Foretaksregisteret
              </label>
            </>
          )}
          {o.ai_tilgjengelig && (
            <>
              <h2>AI</h2>
              <label>
                <input type="checkbox" {...avkryss("ai_aktiv")} /> Bruk AI (Google Gemini)
                <span className="liten" style={{ display: "block", marginLeft: 24 }}>
                  Lag fakturaer fra tekst eller tale, og få forslag om hvilken faktura en innbetaling gjelder. Teksten eller opptaket, og det
                  som trengs fra registrene (kunder, produkter, ubetalte fakturaer og innbetalingen), sendes til Gemini hos Google Cloud i EU.
                  Google bruker ikke dataene til å trene modellene. AI-en lager bare utkast og forslag: du ser over før noe sendes eller
                  registreres.
                </span>
              </label>
            </>
          )}
        </>
      )}

      {del === "faktura" && (
        <>
          <h2 style={{ marginTop: 0 }}>Faktura</h2>
          <div className="rad">
            <label>
              Betalingsfrist (dager)
              <input type="number" min={0} max={120} {...felt("standard_forfall_dager")} />
            </label>
            <label>
              Fakturagebyr eks. mva
              <input inputMode="decimal" {...felt("standard_gebyr")} />
            </label>
            <label>
              Gjentakende sendes dager før forfall
              <input type="number" min={0} max={60} {...felt("standard_dager_foer_forfall")} />
            </label>
          </div>
          <EpostlisteFelt
            etikett="Send alltid kopi av fakturaer til"
            verdi={o.kopi_tekst ?? ""}
            endre={(v) => settO({ ...o, kopi_tekst: v })}
            plassholder="f.eks. regnskap@firma.no"
            hjelp={
              <>
                Fakturaer, kreditnotaer og purringer som sendes på e-post, går også som skjult kopi hit (kunden ser den ikke). Står feltet
                tomt, går kopien til {o.epost ? <strong>{o.epost}</strong> : "organisasjonens e-post (under Organisasjon)"}. Skill flere
                adresser med komma.
              </>
            }
          />
          <label style={{ maxWidth: 200 }}>
            Farge på fakturaen
            <input type="color" value={o.farge || "#1f3a73"} onChange={(e) => settO({ ...o, farge: e.target.value })} />
          </label>
        </>
      )}

      {del === "betaling" && (
        <>
          <h2 style={{ marginTop: 0 }}>Betaling</h2>
          <label style={{ maxWidth: 320 }}>
            Kontonummer (standard)
            <input inputMode="numeric" {...felt("kontonr")} placeholder="1234.56.78901" />
            <span className="felt-hjelp">Brukes på fakturaene om ikke en annen konto er valgt. Alle eiere får beskjed når det endres.</span>
          </label>
          <label>
            <input type="checkbox" {...avkryss("bruk_kid")} /> Bruk KID (krever KID-avtale med banken)
          </label>
          <h2>Purring</h2>
          <label>
            <input type="checkbox" {...avkryss("purring_auto")} /> Send betalingspåminnelse automatisk
          </label>
          <div className="rad">
            <label>
              Dager etter forfall
              <input type="number" min={0} max={60} {...felt("purring_dager")} />
            </label>
            <label>
              Purregebyr (kr)
              <input inputMode="decimal" {...felt("purregebyr")} />
            </label>
          </div>
          <p className="liten dempet">
            Påminnelsen gir 14 dagers ny frist. Purregebyret kreves én gang per faktura og kan ikke være høyere enn grensen i
            inkassoforskriften (en tidel av inkassosatsen). Inkassovarsel sendes manuelt fra fakturaen når fristen er ute.
          </p>
        </>
      )}
      <Feil melding={h.feil} />
      {lagret && <div className="melding ok">Lagret.</div>}
      <button className="primar" disabled={h.opptatt}>
        Lagre
      </button>
    </form>
  );
}

function Passkeys() {
  const { meg } = useKonto();
  const { data, last } = useData(() => hent<any[]>("/passkeys"), []);
  const h = useHandling();
  const [lagt, settLagt] = useState(false);

  const [venter, settVenter] = useState(false);

  async function leggTil() {
    settLagt(false);
    h.settFeil(null);
    settVenter(true);
    try {
      const ny = await leggTilPasskey(foreslattNavn());
      // Den nye passkeyen kan også låse opp appen.
      if (meg) oppdaterLegitimasjon(meg.bruker.id, [...(data ?? []).filter(passkeyHer).map((q) => q.id), ny.id]);
      settLagt(true);
      last();
    } catch (e) {
      console.error("Passkey-registrering feilet", e);
      if (!erAvbrutt(e)) h.settFeil(passkeyFeil(e));
    } finally {
      settVenter(false);
    }
  }

  return (
    <>
      <h2>Passkeys</h2>
      <p className="dempet liten">
        Logg inn med Face ID, Touch ID, Windows Hello eller en sikkerhetsnøkkel, uten passord. En passkey teller som
        totrinnsbekreftelse.
      </p>
      {(data ?? []).length > 0 && (
        <table className="kompakt" style={{ marginBottom: 12 }}>
          <tbody>
            {data!.map((p) => (
              <tr key={p.id}>
                <td>{p.navn}</td>
                <td className="dempet liten">
                  {p.sikkerhetskopiert ? "Synkronisert" : "Bare på denne enheten"} · lagt til {dato(p.opprettet)}
                  {p.sist_brukt ? ` · sist brukt ${dato(p.sist_brukt)}` : ""}
                  {!passkeyHer(p) && ` · virker bare på ${p.rp_id}`}
                </td>
                <td className="hoyre">
                  <button
                    className="lenke"
                    onClick={() =>
                      confirm(`Fjerne «${p.navn}»?`) &&
                      h
                        .kjor(async () => {
                          await api("DELETE", `/passkeys/${encodeURIComponent(p.id)}`);
                          // Fjernede passkeys skal ikke låse opp appen (uten passkeys slås låsen av).
                          if (meg) oppdaterLegitimasjon(meg.bruker.id, (data ?? []).filter((q) => q.id !== p.id && passkeyHer(q)).map((q) => q.id));
                          return true;
                        })
                        .then(last)
                    }
                  >
                    Fjern
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {(data ?? []).length > 0 && !(data ?? []).some(passkeyHer) && (
        <div className="melding info">
          Passkeyene dine virker på {[...new Set((data ?? []).map((p) => p.rp_id))].join(" og ")}, ikke her på {window.location.hostname}. Legg til en
          passkey for denne adressen for å logge inn med den her.
        </div>
      )}
      {stotterPasskey() ? (
        <button className="primar" data-passkey onClick={leggTil} disabled={h.opptatt || venter}>
          {venter ? "Venter på bekreftelse …" : "Legg til passkey"}
        </button>
      ) : (
        <p className="dempet liten">Nettleseren din støtter ikke passkeys.</p>
      )}
      {lagt && <div className="melding ok" style={{ marginTop: 12 }}>Passkeyen er lagt til. Neste gang kan du logge inn med den.</div>}
      <Feil melding={h.feil} />
    </>
  );
}

function GoogleDisk() {
  const { meg } = useKonto();
  const { data, last, feil } = useData(() => hent("/disk"), []);
  const h = useHandling();
  const resultat = new URLSearchParams(window.location.search).get("disk");

  const velger = data?.kobling && data.velger;
  const [velgerFeil, settVelgerFeil] = useState<string>();
  useEffect(() => {
    if (velger) forberedVelger().catch((e) => settVelgerFeil(e.message));
  }, [Boolean(velger)]);

  if (feil) return <Feil melding={feil} />;
  if (!data) return <Laster />;
  // Uten noen organisasjon med Google Disk (funksjonene i Plattform) vises det bare for å koble fra
  // en kobling som finnes.
  if ((!data.tilgjengelig && !data.kobling) || (!data.kobling && !(meg?.organisasjoner ?? []).some((o) => harFunksjon(o, "google_disk"))))
    return (
      <div className="kort">
        <h2 style={{ marginTop: 0 }}>Google Disk</h2>
        <p className="dempet">Kopiering av fakturaene til Google Disk er ikke slått på for organisasjonene dine.</p>
      </div>
    );
  const k = data.kobling;

  const byttMappe = () =>
    h
      .kjor(async () => {
        const mappe = await velgMappe(data.velger, k.google_epost ?? undefined);
        if (mappe) await api("PUT", "/disk/mappe", mappe);
      })
      .then(last);
  const standardMappe = () =>
    confirm("Bruke en ny mappe «Admin Konsoll» øverst i Disk? Fakturaene kopieres dit på nytt.") &&
    h.kjor(() => api("PUT", "/disk/mappe", { standard: true })).then(last);

  const meldinger: Record<string, [string, string]> = {
    ok: ["ok", "Google Disk er koblet til. Fakturaene kopieres nå, også de som er sendt tidligere."],
    avbrutt: ["info", "Koblingen ble avbrutt."],
    feil: ["feil", "Koblingen mot Google Disk feilet. Prøv igjen."],
    "mangler-tilgang": ["feil", "Google ga ikke varig tilgang. Fjern Admin Konsoll under myaccount.google.com/permissions og prøv igjen."],
  };
  const koble = () => h.kjor(async () => (window.location.href = (await api("POST", "/disk/start")).url));

  return (
    <div className="kort">
      <h2 style={{ marginTop: 0 }}>Google Disk</h2>
      <p className="dempet liten">
        Få en kopi av fakturaer og kreditnotaer i din egen Google Disk, privat eller jobb. Velger du en egen mappe, legges fakturaene rett i
        den; ellers i «Admin Konsoll» med undermapper per organisasjon og år. Appen får bare tilgang til mappen du velger og filene den selv lager.
      </p>
      {resultat && meldinger[resultat] && <div className={`melding ${meldinger[resultat][0]}`}>{meldinger[resultat][1]}</div>}
      {!k ? (
        <button className="primar" disabled={h.opptatt} onClick={koble}>
          Koble til Google Disk
        </button>
      ) : (
        <>
          <p>
            <span className={`merke ${k.status === "aktiv" ? "merke-ok" : "merke-fare"}`}>{k.status === "aktiv" ? "Koblet til" : "Feil"}</span>{" "}
            {k.google_epost}
            {k.siste_feil && <span className="dempet liten"> · {k.siste_feil}</span>}
          </p>
          <p>
            Mappe: <strong>{k.rotmappe_navn ?? "Admin Konsoll"}</strong>
            {k.undermapper ? (
              <span className="dempet liten"> / organisasjon / år</span>
            ) : (
              <span className="dempet liten"> · fakturaene legges rett i mappen</span>
            )}
          </p>
          {velger && (
            <div className="knapper" style={{ marginBottom: 12 }}>
              <button disabled={h.opptatt || Boolean(velgerFeil)} onClick={byttMappe}>
                Velg mappe …
              </button>
              {!k.undermapper && (
                <button className="lenke" disabled={h.opptatt} onClick={standardMappe}>
                  Bruk standardmappe
                </button>
              )}
            </div>
          )}
          <Feil melding={velgerFeil} />
          <p className="dempet liten" style={{ marginBottom: 4 }}>
            Kopier fakturaer fra:
          </p>
          {data.organisasjoner.map((o: any) => (
            <label key={o.id} style={{ marginBottom: 4 }}>
              <input
                type="checkbox"
                checked={o.aktiv}
                disabled={h.opptatt}
                onChange={(e) => h.kjor(() => api("PUT", `/disk/organisasjoner/${o.id}`, { aktiv: e.target.checked })).then(last)}
              />
              {o.navn}
              {!o.direkte_medlem && <span className="dempet"> (klient)</span>}
              {o.sist_kopiert && <span className="dempet liten"> · sist kopiert {dato(o.sist_kopiert)}</span>}
            </label>
          ))}
          <div className="knapper" style={{ marginTop: 8 }}>
            {k.status !== "aktiv" && (
              <button className="primar" disabled={h.opptatt} onClick={koble}>
                Koble til på nytt
              </button>
            )}
            <button
              className="fare"
              disabled={h.opptatt}
              onClick={() => confirm("Koble fra Google Disk? Filer som allerede er kopiert, blir liggende.") && h.kjor(() => api("DELETE", "/disk")).then(last)}
            >
              Koble fra
            </button>
          </div>
        </>
      )}
      <Feil melding={h.feil} />
    </div>
  );
}

function Logo() {
  const { org } = useKonto();
  const [url, settUrl] = useState<string | null>(null);
  const [versjon, settVersjon] = useState(0);
  const h = useHandling();

  useEffect(() => {
    let lenke: string | null = null;
    hent<Blob>(`/org/${org!.id}/logo`)
      .then((b) => {
        lenke = URL.createObjectURL(b);
        settUrl(lenke);
      })
      .catch(() => settUrl(null));
    return () => {
      if (lenke) URL.revokeObjectURL(lenke);
    };
  }, [org?.id, versjon]);

  async function velg(fil: File | undefined) {
    if (!fil) return;
    if (!["image/png", "image/jpeg"].includes(fil.type)) return h.settFeil("Logoen må være PNG eller JPG.");
    if (fil.size > 5_000_000) return h.settFeil("Logoen kan være høyst 5 MB.");
    const ok = await h.kjor(() => lastOppLogo(org!.id, fil).then(() => true));
    if (ok) settVersjon((v) => v + 1);
  }

  return (
    <div className="kort">
      <h2 style={{ marginTop: 0 }}>Logo på fakturaen</h2>
      <p className="dempet liten">PNG eller JPG, høyst 5 MB. Vises øverst til høyre på nye fakturaer. Bredformat med gjennomsiktig bakgrunn blir finest.</p>
      {url ? (
        <img src={url} alt="Logo" style={{ maxWidth: 220, maxHeight: 80, display: "block", marginBottom: 12, background: "#fff", padding: 6, borderRadius: 6 }} />
      ) : (
        <p className="dempet">Ingen logo lastet opp.</p>
      )}
      <div className="knapper">
        <label className="knapp" style={{ margin: 0, color: "var(--tekst)" }}>
          {url ? "Bytt logo" : "Last opp logo"}
          <input type="file" accept="image/png,image/jpeg" hidden onChange={(e) => velg(e.target.files?.[0])} disabled={h.opptatt} />
        </label>
        {url && (
          <button
            className="fare"
            disabled={h.opptatt}
            onClick={() => h.kjor(() => api("DELETE", `/org/${org!.id}/logo`)).then(() => settVersjon((v) => v + 1))}
          >
            Fjern
          </button>
        )}
      </div>
      <Feil melding={h.feil} />
    </div>
  );
}

// Brukerne i organisasjonen med rollen sin: en av de faste, eller en av de egne rollene (Roller).
// Eier og administrator inviterer og bytter rolle; bare en eier kan gi eller ta eierrollen.
type Medlem = { bruker_id: string; rolle: string; tilgangsrolle_id: string | null; tilgangsrolle: string | null; epost: string; navn: string | null };
const ROLLETEKST: Record<string, string> = {
  eier: "Eier",
  admin: "Administrator",
  fakturerer: "Fakturerer",
  regnskap: "Regnskap",
  les: "Les",
  ansatt: "Ansatt",
};
// Verdien i rollevalget: den faste rollen, eller «t:» og id-en til den egne rollen.
const rolleVerdi = (m: { rolle: string; tilgangsrolle_id: string | null }) => (m.rolle === "tilpasset" ? `t:${m.tilgangsrolle_id}` : m.rolle);
const fraRolleVerdi = (v: string) => (v.startsWith("t:") ? { rolle: "tilpasset", tilgangsrolle_id: v.slice(2) } : { rolle: v, tilgangsrolle_id: null });

function Rollevalg({ verdi, endre, faste, roller, etikett, disabled }: {
  verdi: string;
  endre: (v: string) => void;
  faste: string[];
  roller: Tilgangsrolle[];
  etikett?: string;
  disabled?: boolean;
}) {
  return (
    <select value={verdi} onChange={(e) => endre(e.target.value)} aria-label={etikett} disabled={disabled}>
      <optgroup label="Faste roller">
        {faste.map((r) => (
          <option key={r} value={r}>
            {ROLLETEKST[r]}
          </option>
        ))}
      </optgroup>
      {roller.length > 0 && (
        <optgroup label="Egne roller">
          {roller.map((r) => (
            <option key={r.id} value={`t:${r.id}`}>
              {r.navn}
            </option>
          ))}
        </optgroup>
      )}
    </select>
  );
}

function Medlemmer() {
  const { org, meg, oppdater } = useKonto();
  const { data, last } = useData(() => hent<Medlem[]>(`/org/${org!.id}/medlemmer`), [org?.id]);
  const roller = useData(() => hent<Tilgangsrolle[]>(`/org/${org!.id}/tilgangsroller`), [org?.id]);
  const [epost, settEpost] = useState("");
  const [rolle, settRolle] = useState(harModul(org, "faktura") ? "fakturerer" : "admin");
  const [lenke, settLenke] = useState<string | null>(null);
  const h = useHandling();
  const eier = org?.rolle === "eier";
  // De faste rollene som passer: fakturerer og les bare med Faktura, og eier bare for en eier.
  const faste = ["admin", ...(harModul(org, "faktura") ? ["fakturerer"] : []), "regnskap", ...(harModul(org, "faktura") ? ["les"] : [])];

  async function inviter(e: FormEvent) {
    e.preventDefault();
    const r = await h.kjor(() => api("POST", `/org/${org!.id}/invitasjoner`, { epost, ...fraRolleVerdi(rolle) }));
    if (r) {
      settLenke(r.lenke);
      settEpost("");
      roller.last();
    }
  }
  async function byttRolle(m: Medlem, v: string) {
    const ny = fraRolleVerdi(v);
    const navn = ny.rolle === "tilpasset" ? roller.data?.find((r) => r.id === ny.tilgangsrolle_id)?.navn : ROLLETEKST[ny.rolle];
    if (!confirm(`Gi ${m.navn ?? m.epost} rollen ${navn}?`)) return;
    const ok = await h.kjor(async () => (await api("PATCH", `/org/${org!.id}/medlemmer/${m.bruker_id}`, ny), true));
    if (!ok) return;
    last();
    roller.last();
    if (m.bruker_id === meg?.bruker.id) await oppdater(); // egen rolle: menyen og tilgangen endres
  }

  return (
    <div className="kort">
      <h2 style={{ marginTop: 0 }}>Brukere</h2>
      <p className="dempet liten">
        Hver bruker har en rolle: en av de faste, eller en av organisasjonens egne roller (under Roller), som gir modulene som er krysset av.
      </p>
      <div className="tabell">
        <table className="kompakt">
          <tbody>
            {(data ?? []).map((m) => {
              // Eierrollen gis og tas bare av en eier, og ingen bytter sin egen rolle her.
              const kanBytte = m.bruker_id !== meg?.bruker.id && (eier || m.rolle !== "eier");
              const valg = [...(eier ? ["eier"] : []), ...faste, ...(m.rolle === "ansatt" || org?.personal ? ["ansatt"] : [])];
              return (
                <tr key={m.bruker_id}>
                  <td>
                    {m.navn ?? m.epost}
                    {m.navn && <span className="dempet liten" style={{ display: "block" }}>{m.epost}</span>}
                  </td>
                  <td>
                    {kanBytte ? (
                      <Rollevalg
                        verdi={rolleVerdi(m)}
                        endre={(v) => void byttRolle(m, v)}
                        faste={valg.includes(m.rolle) || m.rolle === "tilpasset" ? valg : [m.rolle, ...valg]}
                        roller={roller.data ?? []}
                        etikett={`Rollen til ${m.navn ?? m.epost}`}
                        disabled={h.opptatt}
                      />
                    ) : m.rolle === "tilpasset" ? (
                      m.tilgangsrolle
                    ) : (
                      ROLLETEKST[m.rolle] ?? m.rolle
                    )}
                  </td>
                  <td className="hoyre">
                    {m.rolle !== "eier" && (
                      <button
                        className="lenke"
                        onClick={() => confirm(`Fjerne ${m.epost}?`) && h.kjor(() => api("DELETE", `/org/${org!.id}/medlemmer/${m.bruker_id}`)).then(() => (last(), roller.last()))}
                      >
                        Fjern
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <form onSubmit={inviter} className="rad" style={{ marginTop: 16, alignItems: "end" }}>
        <label>
          Inviter e-post
          <input type="email" required value={epost} onChange={(e) => settEpost(e.target.value)} />
        </label>
        <label>
          Rolle
          <Rollevalg verdi={rolle} endre={settRolle} faste={faste} roller={roller.data ?? []} />
        </label>
        <label>
          <button className="primar" disabled={h.opptatt}>
            Lag invitasjon
          </button>
        </label>
      </form>
      <p className="liten dempet">Ansatte inviteres fra ansattkortet (Personal → Ansatte), så de kobles til timene og vaktene sine.</p>
      {lenke && (
        <div className="melding ok">
          Send denne lenken til personen. Den gjelder i 7 dager og bare for e-postadressen du skrev inn:
          <br />
          <code className="hemmelig">{lenke}</code>
        </div>
      )}
      <Feil melding={h.feil} />
    </div>
  );
}

// Rollene i bedriften (0111_tilgangsroller.sql): eier og administrator lager egne roller, f.eks.
// Daglig leder eller Personalansvarlig, og krysser av for modulene hver rolle gir (bare de som er
// slått på for organisasjonen; Lønn tar med Personal). Innstillingene, brukerne og rollene er alltid
// bare for eier og administrator, og en rolle uten moduler er som Ansatt: bare sitt eget.
type Tilgangsrolle = { id: string; navn: string; beskrivelse: string | null; moduler: ModulKode[]; brukere: number; invitert: number };
type Rolleskjema = { id: string | null; navn: string; beskrivelse: string; moduler: ModulKode[] };
const MODULER: ModulKode[] = ["faktura", "personal", "lonn", "regnskap"];
const MODULTEKST: Record<ModulKode, string> = {
  faktura: "Fakturaene, kundene, produktene og innbetalingene",
  personal: "De ansatte, vaktplanen, timene, ferien og fraværet",
  lonn: "Lønnskjøringene, a-meldingen, skattekortene og reisene (med Personal)",
  regnskap: "Regnskapet, bilagene, utgiftene, banken og mva",
};
// Forslag når organisasjonen lager rollene sine (med modulene som er slått på); vises når en av
// modulene i «krever» er på.
const FORSLAG: { navn: string; beskrivelse: string; moduler: ModulKode[]; krever: ModulKode[] }[] = [
  { navn: "Daglig leder", beskrivelse: "Alle modulene, uten innstillingene og brukerne", moduler: ["faktura", "personal", "lonn", "regnskap"], krever: MODULER },
  { navn: "Økonomiansvarlig", beskrivelse: "Fakturaene og regnskapet", moduler: ["faktura", "regnskap"], krever: ["faktura", "regnskap"] },
  { navn: "Personalansvarlig", beskrivelse: "De ansatte, vaktplanen og timene", moduler: ["personal"], krever: ["personal"] },
  { navn: "Lønnsansvarlig", beskrivelse: "Lønnen og de ansatte", moduler: ["personal", "lonn"], krever: ["lonn"] },
];
const FASTE_ROLLER: [string, string][] = [
  ["Eier", "Alt, også å gi andre eierrollen og slette organisasjonen."],
  ["Administrator", "Alle modulene, innstillingene, brukerne og rollene."],
  ["Fakturerer", "Lage og sende fakturaer, og registrere betalinger."],
  ["Regnskap", "Se fakturaene, bokføre betalinger, regnskapet, og se de ansatte og lønnen."],
  ["Les", "Bare se fakturaene."],
  ["Ansatt", "Sitt eget: timer, vakter, ferie, fravær og lønnsslipper."],
];
// Lønn bygger på Personal: med Lønn følger Personal, og uten Personal går Lønn.
function velgModul(moduler: ModulKode[], m: ModulKode, pa: boolean): ModulKode[] {
  let ny = pa ? [...moduler, m] : moduler.filter((x) => x !== m);
  if (pa && m === "lonn") ny.push("personal");
  if (!pa && m === "personal") ny = ny.filter((x) => x !== "lonn");
  return MODULER.filter((x) => ny.includes(x));
}

function Tilgangsroller() {
  const { org } = useKonto();
  const { data, last } = useData(() => hent<Tilgangsrolle[]>(`/org/${org!.id}/tilgangsroller`), [org?.id]);
  const [skjema, settSkjema] = useState<Rolleskjema | null>(null);
  const h = useHandling();
  const lagring = useHandling();
  const tilgjengelige = MODULER.filter((m) => harModul(org, m));
  const roller = data ?? [];
  const brukt = new Set(roller.map((r) => r.navn.trim().toLowerCase()));
  const forslag = FORSLAG.filter((f) => !brukt.has(f.navn.toLowerCase()) && f.krever.some((m) => tilgjengelige.includes(m)));

  async function lagre(e: FormEvent) {
    e.preventDefault();
    const s = skjema!;
    const kropp = { navn: s.navn.trim(), beskrivelse: s.beskrivelse.trim() || null, moduler: s.moduler };
    const r = await lagring.kjor(() => (s.id ? api("PUT", `/org/${org!.id}/tilgangsroller/${s.id}`, kropp) : api("POST", `/org/${org!.id}/tilgangsroller`, kropp)));
    if (!r) return;
    settSkjema(null);
    last();
  }
  const slett = (r: Tilgangsrolle) =>
    confirm(`Slette rollen ${r.navn}?`) && h.kjor(async () => (await api("DELETE", `/org/${org!.id}/tilgangsroller/${r.id}`), true)).then(last);
  const ny = (f?: (typeof FORSLAG)[number]) => {
    lagring.settFeil(null);
    settSkjema({ id: null, navn: f?.navn ?? "", beskrivelse: f?.beskrivelse ?? "", moduler: (f?.moduler ?? []).filter((m) => tilgjengelige.includes(m)) });
  };

  return (
    <>
      <div className="kort">
        <div className="topp" style={{ marginBottom: 8 }}>
          <h2 style={{ margin: 0 }}>Roller</h2>
          <button className="primar" type="button" onClick={() => ny()}>
            Ny rolle
          </button>
        </div>
        <p className="dempet liten">
          Lag rollene dere trenger, f.eks. Daglig leder eller Personalansvarlig, og velg modulene hver rolle gir. Gi rollen til en bruker under Brukere.
          Innstillingene, brukerne og rollene er alltid bare for eier og administrator, og en rolle uten moduler gir bare tilgang til sitt eget, som Ansatt.
        </p>
        {!data ? (
          <Laster />
        ) : roller.length === 0 ? (
          <p className="dempet">Ingen egne roller ennå.</p>
        ) : (
          <ul className="rolleliste">
            {roller.map((r) => (
              <li key={r.id}>
                <div>
                  <strong>{r.navn}</strong>
                  {r.beskrivelse && <span className="dempet liten">{r.beskrivelse}</span>}
                  <div className="merker">
                    {r.moduler.length ? (
                      r.moduler.map((m) => (
                        <span key={m} className={`merke ${harModul(org, m) ? "merke-info" : "merke-noytral"}`} title={harModul(org, m) ? undefined : "Modulen er ikke slått på"}>
                          {MODULNAVN[m]}
                        </span>
                      ))
                    ) : (
                      <span className="merke merke-noytral">Bare sitt eget</span>
                    )}
                  </div>
                  <span className="dempet liten rolle-antall">
                    {r.brukere === 1 ? "1 bruker" : `${r.brukere} brukere`}
                    {r.invitert > 0 ? ` · ${r.invitert} invitert` : ""}
                  </span>
                </div>
                <div className="knapper">
                  <button
                    type="button"
                    onClick={() => {
                      lagring.settFeil(null);
                      settSkjema({ id: r.id, navn: r.navn, beskrivelse: r.beskrivelse ?? "", moduler: r.moduler });
                    }}
                  >
                    Endre
                  </button>
                  <button type="button" className="fare" disabled={h.opptatt} onClick={() => slett(r)}>
                    Slett
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
        <Feil melding={h.feil} />
        {forslag.length > 0 && (
          <>
            <p className="liten" style={{ margin: "16px 0 0", fontWeight: 600 }}>
              Forslag
            </p>
            <div className="forslag">
              {forslag.map((f) => (
                <button key={f.navn} type="button" onClick={() => ny(f)} title={f.beskrivelse}>
                  + {f.navn}
                </button>
              ))}
            </div>
          </>
        )}
      </div>
      <div className="kort">
        <h2 style={{ marginTop: 0 }}>De faste rollene</h2>
        <ul className="rolleliste faste">
          {FASTE_ROLLER.map(([navn, tekst]) => (
            <li key={navn}>
              <div>
                <strong>{navn}</strong>
                <span className="dempet liten">{tekst}</span>
              </div>
            </li>
          ))}
        </ul>
      </div>
      <Dialog apen={!!skjema} lukk={() => settSkjema(null)} tittel={skjema?.id ? "Endre rollen" : "Ny rolle"}>
        {skjema && (
          <form onSubmit={lagre}>
            <label>
              Navn
              <input required minLength={2} maxLength={60} value={skjema.navn} onChange={(e) => settSkjema({ ...skjema, navn: e.target.value })} placeholder="Daglig leder" />
            </label>
            <label>
              Beskrivelse (valgfritt)
              <input maxLength={300} value={skjema.beskrivelse} onChange={(e) => settSkjema({ ...skjema, beskrivelse: e.target.value })} />
            </label>
            <p className="liten" style={{ margin: "12px 0 4px", fontWeight: 600 }}>
              Modulene rollen gir
            </p>
            {tilgjengelige.map((m) => (
              <label key={m}>
                <input type="checkbox" checked={skjema.moduler.includes(m)} onChange={(e) => settSkjema({ ...skjema, moduler: velgModul(skjema.moduler, m, e.target.checked) })} />
                {MODULNAVN[m]}
                <span className="felt-hjelp">{MODULTEKST[m]}</span>
              </label>
            ))}
            {MODULER.some((m) => !tilgjengelige.includes(m)) && (
              <p className="liten dempet">
                {MODULER.filter((m) => !tilgjengelige.includes(m))
                  .map((m) => MODULNAVN[m])
                  .join(" og ")}{" "}
                er ikke slått på for {org?.navn}.
              </p>
            )}
            {!skjema.moduler.length && <p className="liten dempet">Uten moduler ser brukerne bare sitt eget (timer, vakter, fravær og lønnsslipper), som Ansatt.</p>}
            <Feil melding={lagring.feil} />
            <div className="knapper">
              <button className="primar" disabled={lagring.opptatt}>
                Lagre
              </button>
              <button type="button" onClick={() => settSkjema(null)}>
                Avbryt
              </button>
            </div>
          </form>
        )}
      </Dialog>
    </>
  );
}

function Regnskapsforer() {
  const { org } = useKonto();
  const { data, last } = useData(() => hent(`/org/${org!.id}/tilgang`), [org?.id]);
  const [nr, settNr] = useState("");
  const [rolle, settRolle] = useState("bokfor");
  const h = useHandling();
  const byraa = org?.type === "regnskapsbyraa";

  async function opprett(e: FormEvent) {
    e.preventDefault();
    const r = await h.kjor(() => api("POST", `/org/${org!.id}/tilgang`, { orgnr: nr.replace(/\s/g, ""), rolle }));
    if (r) {
      settNr("");
      last();
    }
  }

  const statustekst: Record<string, string> = { invitert: "Venter på byrået", forespurt: "Venter på klienten", aktiv: "Aktiv", avslaatt: "Avslått", trukket: "Trukket" };
  const kanSvare = (t: any) => (t.status === "invitert" && t.byraa_org_id === org!.id) || (t.status === "forespurt" && t.klient_org_id === org!.id);

  return (
    <div className="kort">
      <h2 style={{ marginTop: 0 }}>{byraa ? "Klienter" : "Regnskapsfører"}</h2>
      <p className="dempet liten">
        {byraa
          ? "Be om tilgang til en klient med klientens organisasjonsnummer. Klienten må godkjenne."
          : "Gi regnskapsføreren tilgang med byråets organisasjonsnummer. Byrået må godta, og du kan trekke tilgangen når som helst."}{" "}
        Begge organisasjonene må være verifisert.
      </p>
      <table className="kompakt">
        <tbody>
          {(data ?? []).map((t: any) => (
            <tr key={t.id}>
              <td>{byraa ? t.klient_navn : t.byraa_navn}</td>
              <td className="dempet">{orgnr(byraa ? t.klient_orgnr : t.byraa_orgnr)}</td>
              <td>{t.rolle === "bokfor" ? "Les og bokfør" : "Les"}</td>
              <td>{statustekst[t.status]}{t.utloper ? ` til ${dato(t.utloper)}` : ""}</td>
              <td className="hoyre knapper" style={{ justifyContent: "flex-end" }}>
                {kanSvare(t) && (
                  <>
                    <button className="lenke" onClick={() => h.kjor(() => api("POST", `/tilgang/${t.id}/svar`, { aksepter: true })).then(last)}>
                      Godta
                    </button>
                    <button className="lenke" onClick={() => h.kjor(() => api("POST", `/tilgang/${t.id}/svar`, { aksepter: false })).then(last)}>
                      Avslå
                    </button>
                  </>
                )}
                {["invitert", "forespurt", "aktiv"].includes(t.status) && (
                  <button className="lenke" onClick={() => confirm("Trekke tilgangen?") && h.kjor(() => api("DELETE", `/tilgang/${t.id}`)).then(last)}>
                    Trekk
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <form onSubmit={opprett} className="rad" style={{ marginTop: 16, alignItems: "end" }}>
        <label>
          {byraa ? "Klientens org.nr." : "Byråets org.nr."}
          <input inputMode="numeric" required value={nr} onChange={(e) => settNr(e.target.value)} />
        </label>
        <label>
          Tilgang
          <select value={rolle} onChange={(e) => settRolle(e.target.value)}>
            <option value="bokfor">Les og bokfør betalinger</option>
            <option value="les">Bare les</option>
          </select>
        </label>
        <label>
          <button className="primar" disabled={h.opptatt}>
            {byraa ? "Be om tilgang" : "Inviter"}
          </button>
        </label>
      </form>
      <Feil melding={h.feil} />
    </div>
  );
}

// Flere kontonumre, f.eks. egen konto for husleie. Velges per faktura og gjentakelse.
function Kontoer() {
  const { org } = useKonto();
  const { data, last } = useData(() => hent(`/org/${org!.id}/kontoer`), [org?.id]);
  const [ny, settNy] = useState({ navn: "", kontonr: "" });
  const h = useHandling();

  async function leggTil(ev: FormEvent) {
    ev.preventDefault();
    const r = await h.kjor(() => api("POST", `/org/${org!.id}/kontoer`, ny));
    if (r) {
      settNy({ navn: "", kontonr: "" });
      last();
      kontoerEndret();
    }
  }

  return (
    <div className="kort">
      <h2 style={{ marginTop: 0 }}>Flere kontonumre</h2>
      <p className="dempet liten">
        Standardkontoen står over. Her kan du legge til flere, f.eks. en egen konto for husleie, og velge konto på hver faktura og
        gjentakende faktura.
      </p>
      {(data ?? []).length > 0 && (
        <table className="kompakt">
          <tbody>
            {(data ?? []).map((k: any) => (
              <tr key={k.id}>
                <td>{k.navn}</td>
                <td className="tall">{k.kontonr.replace(/^(\d{4})(\d{2})(\d{5})$/, "$1.$2.$3")}</td>
                <td className="hoyre">
                  <button
                    type="button"
                    className="lenke"
                    disabled={h.opptatt}
                    onClick={() =>
                      confirm(`Fjerne ${k.navn}? Utkast og gjentakende fakturaer som bruker den, går over til standardkontoen.`) &&
                      h.kjor(async () => (await api("DELETE", `/org/${org!.id}/kontoer/${k.id}`), true)).then(() => (last(), kontoerEndret()))
                    }
                  >
                    Fjern
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <form onSubmit={leggTil} className="rad">
        <label>
          Navn
          <input required value={ny.navn} onChange={(e) => settNy({ ...ny, navn: e.target.value })} placeholder="Husleiekonto" />
        </label>
        <label>
          Kontonummer
          <input required inputMode="numeric" value={ny.kontonr} onChange={(e) => settNy({ ...ny, kontonr: e.target.value })} placeholder="1234.56.78901" />
        </label>
        <label>
          &nbsp;
          <button className="primar" disabled={h.opptatt}>
            Legg til
          </button>
        </label>
      </form>
      <Feil melding={h.feil} />
    </div>
  );
}
