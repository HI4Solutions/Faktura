import { useEffect, useState, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api, hent, lastOppLogo } from "../api";
import { EpostlisteFelt, Feil, Laster, tall, tilEpostliste, ugyldigeEposter, useData, useHandling } from "../felles";
import { erAdmin, harFunksjon, useKonto } from "../konto";
import { dato, orgnr } from "../format";
import { Totrinn } from "./Totrinn";
import { AppOgVarsler } from "./Varsler";
import { EhfSending } from "./Ehf";
import { BankKobling, kontoerEndret } from "./Bank";
import { oppdaterLegitimasjon } from "../applaas";
import { forberedVelger, velgMappe } from "../googleVelger";
import { erAvbrutt, foreslattNavn, leggTilPasskey, passkeyFeil, stotterPasskey } from "../passkey";
import { SlettOrganisasjon } from "../slettOrg";

type Fane = "organisasjon" | "faktura" | "personal" | "konto" | "app";
type OrgDel = "organisasjon" | "faktura" | "betaling";
// Faner som er slått sammen med andre (lenker og varsler bruker dem fortsatt): fanen de nå er en
// del av, og stedet på den.
const SAMMENSLATT: Record<string, [Fane, string]> = {
  betaling: ["faktura", "betaling"],
  ehf: ["faktura", "ehf"],
  brukere: ["organisasjon", "brukere"],
};

// Innstillingene er delt i faner. Fanen står i adressen (?fane=), så lenker kan gå rett til
// den. Organisasjon har opplysningene, brukerne og regnskapsføreren; Faktura har oppsettet av
// fakturaene, logoen, betalingen (kontonumre, purring og banken) og EHF. Organisasjonens
// innstillinger vises bare for administratorer; regnskapsbyråer fakturerer ikke, og EHF krever
// organisasjonsnummer.
export function Innstillinger() {
  const { org } = useKonto();
  const [sok, settSok] = useSearchParams();
  const admin = Boolean(org && erAdmin(org.rolle));
  const byraa = org?.type === "regnskapsbyraa";
  const faner: [Fane, string][] = [];
  if (admin) {
    faner.push(["organisasjon", "Organisasjon"]);
    if (!byraa) faner.push(["faktura", "Faktura"]);
    if (org?.type !== "privatperson" && harFunksjon(org, "ansatte")) faner.push(["personal", "Ansatte og timer"]);
  }
  faner.push(["konto", "Min konto"], ["app", "App"]);
  // Tilbake fra Google (Google Disk-koblingen): «Min konto».
  const onsket = sok.get("fane") ?? (sok.has("disk") ? "konto" : null);
  const [tilFane, sted] = (onsket && SAMMENSLATT[onsket]) || [onsket, null];
  const fane = faner.find(([v]) => v === tilFane)?.[0] ?? faner[0][0];
  const ehf = !byraa && org?.type !== "privatperson" && harFunksjon(org, "ehf");
  const skjema = useOrgSkjema(admin);
  useRullTil(fane === tilFane ? sted : null);

  return (
    <>
      <h1>Innstillinger</h1>
      <div className="faner innstillinger-faner" role="tablist" aria-label="Innstillinger">
        {faner.map(([v, navn]) => (
          <button key={v} type="button" role="tab" aria-selected={fane === v} className={fane === v ? "valgt" : undefined} onClick={() => settSok({ fane: v }, { replace: true })}>
            {navn}
          </button>
        ))}
      </div>
      {fane === "organisasjon" && (
        <>
          <OrgSkjemaDel del="organisasjon" skjema={skjema} />
          <div id="brukere" className="innstilling-sted">
            <Medlemmer />
            <Regnskapsforer />
          </div>
          {org?.rolle === "eier" && org.direkte_medlem && <SlettOrg />}
        </>
      )}
      {fane === "faktura" && (
        <>
          <OrgSkjemaDel del="faktura" skjema={skjema} />
          <Logo />
          <div id="betaling" className="innstilling-sted">
            <OrgSkjemaDel del="betaling" skjema={skjema} />
            <Kontoer />
            {harFunksjon(org, "bank") && <BankKobling />}
          </div>
          {ehf && (
            <div id="ehf" className="innstilling-sted">
              <EhfSending />
            </div>
          )}
        </>
      )}
      {fane === "personal" && <PersonalOppsett />}
      {fane === "konto" && <MinKonto />}
      {fane === "app" && <AppOgVarsler />}
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
        Sletter {org.navn} fra HI4 Faktura for alle brukerne. Du må skrive hvorfor. Har organisasjonen utstedte fakturaer, stenges den i stedet, og fakturaene
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

// Ansatte og timer: slås på per organisasjon, med grensene for overtid, bursdagsvarslene, om de
// ansatte kan bytte vakter (Vaktbytte.tsx) og om det er åpent i helgene (0064_helg.sql).
type Bursdagsvarsel = "av" | "push" | "epost" | "begge";
type Vaktbytte = "av" | "godkjenning" | "fritt";
function PersonalOppsett() {
  const { org, oppdater } = useKonto();
  const { data } = useData(() => hent(`/org/${org!.id}/lonn-oppsett`), [org?.id]);
  const [o, settO] = useState<{
    aktiv: boolean;
    daglig_grense: string;
    ukentlig_grense: string;
    overtid_prosent: string;
    bursdag_varsel: Bursdagsvarsel;
    full_stilling: string;
    ferie_dager: string;
    vaktbytte: Vaktbytte;
    helg: boolean;
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
        helg: data.helg ?? true,
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
        helg: o!.helg,
      }),
    );
    if (!r) return;
    settLagret(true);
    await oppdater(); // menyen får (eller mister) Ansatte og Timer, og helgen vises eller ikke
  }

  return (
    <form className="kort" onSubmit={lagre}>
      <h2>Ansatte og timer</h2>
      <p className="dempet">
        Hold oversikt over de ansatte, og la dem føre timene sine i appen. De leverer uka, og du godkjenner eller avviser den. Overtiden regnes ut av seg selv.
      </p>
      <label>
        <input type="checkbox" checked={o.aktiv} onChange={(e) => settO({ ...o, aktiv: e.target.checked })} />
        Bruk ansatte og timer i {org?.navn}
      </label>
      <h3>Arbeidstid</h3>
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
      {harFunksjon(org, "vaktplan") && (
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
          <h3>Vaktbytte</h3>
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
        </>
      )}
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
      <h3>Bursdager</h3>
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

function MinKonto() {
  const { meg } = useKonto();
  return (
    <>
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
      <GoogleDisk />
    </>
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
      if (meg) oppdaterLegitimasjon(meg.bruker.id, [...(data ?? []).map((q) => q.id), ny.id]);
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
                          if (meg) oppdaterLegitimasjon(meg.bruker.id, (data ?? []).filter((q) => q.id !== p.id).map((q) => q.id));
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
  const { data, last } = useData(() => hent("/disk"), []);
  const h = useHandling();
  const resultat = new URLSearchParams(window.location.search).get("disk");

  const velger = data?.kobling && data.velger;
  const [velgerFeil, settVelgerFeil] = useState<string>();
  useEffect(() => {
    if (velger) forberedVelger().catch((e) => settVelgerFeil(e.message));
  }, [Boolean(velger)]);

  if (!data || (!data.tilgjengelig && !data.kobling)) return null;
  // Uten noen organisasjon med Google Disk (funksjonene i Administrasjon) vises det bare for å
  // koble fra en kobling som finnes.
  if (!data.kobling && !(meg?.organisasjoner ?? []).some((o) => harFunksjon(o, "google_disk"))) return null;
  const k = data.kobling;

  const byttMappe = () =>
    h
      .kjor(async () => {
        const mappe = await velgMappe(data.velger, k.google_epost ?? undefined);
        if (mappe) await api("PUT", "/disk/mappe", mappe);
      })
      .then(last);
  const standardMappe = () =>
    confirm("Bruke en ny mappe «HI4 Faktura» øverst i Disk? Fakturaene kopieres dit på nytt.") &&
    h.kjor(() => api("PUT", "/disk/mappe", { standard: true })).then(last);

  const meldinger: Record<string, [string, string]> = {
    ok: ["ok", "Google Disk er koblet til. Fakturaene kopieres nå, også de som er sendt tidligere."],
    avbrutt: ["info", "Koblingen ble avbrutt."],
    feil: ["feil", "Koblingen mot Google Disk feilet. Prøv igjen."],
    "mangler-tilgang": ["feil", "Google ga ikke varig tilgang. Fjern HI4 Faktura under myaccount.google.com/permissions og prøv igjen."],
  };
  const koble = () => h.kjor(async () => (window.location.href = (await api("POST", "/disk/start")).url));

  return (
    <div className="kort">
      <h2 style={{ marginTop: 0 }}>Google Disk</h2>
      <p className="dempet liten">
        Få en kopi av fakturaer og kreditnotaer i din egen Google Disk, privat eller jobb. Velger du en egen mappe, legges fakturaene rett i
        den; ellers i «HI4 Faktura» med undermapper per organisasjon og år. Appen får bare tilgang til mappen du velger og filene den selv lager.
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
            Mappe: <strong>{k.rotmappe_navn ?? "HI4 Faktura"}</strong>
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
              {k.rotmappe_navn !== "HI4 Faktura" && (
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

function Medlemmer() {
  const { org } = useKonto();
  const { data, last } = useData(() => hent(`/org/${org!.id}/medlemmer`), [org?.id]);
  const [epost, settEpost] = useState("");
  const [rolle, settRolle] = useState("fakturerer");
  const [lenke, settLenke] = useState<string | null>(null);
  const h = useHandling();

  async function inviter(e: FormEvent) {
    e.preventDefault();
    const r = await h.kjor(() => api("POST", `/org/${org!.id}/invitasjoner`, { epost, rolle }));
    if (r) {
      settLenke(r.lenke);
      settEpost("");
    }
  }

  const rolletekst: Record<string, string> = { eier: "Eier", admin: "Administrator", fakturerer: "Fakturerer", regnskap: "Regnskap", les: "Les", ansatt: "Ansatt (timer)" };

  return (
    <div className="kort">
      <h2 style={{ marginTop: 0 }}>Brukere</h2>
      <table className="kompakt">
        <tbody>
          {(data ?? []).map((m: any) => (
            <tr key={m.bruker_id}>
              <td>{m.navn ?? m.epost}</td>
              <td className="dempet">{m.epost}</td>
              <td>{rolletekst[m.rolle]}</td>
              <td className="hoyre">
                {m.rolle !== "eier" && (
                  <button className="lenke" onClick={() => confirm(`Fjerne ${m.epost}?`) && h.kjor(() => api("DELETE", `/org/${org!.id}/medlemmer/${m.bruker_id}`)).then(last)}>
                    Fjern
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <form onSubmit={inviter} className="rad" style={{ marginTop: 16, alignItems: "end" }}>
        <label>
          Inviter e-post
          <input type="email" required value={epost} onChange={(e) => settEpost(e.target.value)} />
        </label>
        <label>
          Rolle
          <select value={rolle} onChange={(e) => settRolle(e.target.value)}>
            <option value="admin">Administrator</option>
            <option value="fakturerer">Fakturerer</option>
            <option value="regnskap">Regnskap (bokføre betalinger)</option>
            <option value="les">Les</option>
          </select>
        </label>
        <label>
          <button className="primar" disabled={h.opptatt}>
            Lag invitasjon
          </button>
        </label>
      </form>
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
