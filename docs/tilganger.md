# Tilganger, scopes og avtaler – sjekkliste

Denne lista viser hva Admin Konsoll trenger fra Skatteetaten, Altinn og Digdir, NAV,
Brønnøysundregistrene og leverandørene for å dekke lønn, a-melding, mva, krav og frister,
utleggstrekk, årsregnskap, skattemelding og aksjonærregisteroppgave. Den viser også hva som alt er
gitt. Medinnova AS (org.nr. 936 564 046) er leverandøren, og alle tilgangene står på Medinnova.

Lista viser status 18.10.2026. Den bygger på:

- sjekken av produksjonsklienten i Cloud Shell 17.10 (`scripts/maskinporten.sh sjekk`, der 8 av 9
  scopes virket);
- svarene fra Digdir, Altinn og Skatteetaten 13.–15.10;
- variablene i siste Infrastruktur-kjøring 18.10;
- Skatteetatens API-dokumentasjon fra oktober 2026.

Oppdater lista når noe blir gitt.

Nøkler, tokens og hemmeligheter skal aldri sendes på e-post, i chat eller som skjermbilde. De
legges i Secret Manager med skriptene (`scripts/maskinporten.sh` og `scripts/idporten.sh`).

## Det som gjenstår, i rekkefølge

1. [ ] **Altinn: `digdir:dialogporten`, `altinn:instances.read` og `altinn:instances.write` i
   produksjon.**
   - Uten Dialogporten henter ikke appen svaret på a-meldingen i produksjon. Svaret ligger da i
     Altinn-innboksen.
   - Skatteetaten sender også varselet om nye trekkpålegg gjennom Dialogporten.
   - Uten instances-scopene kan ikke årsregnskapet sendes.
   - Du trenger bare én e-post til Altinn. Teksten står under [Altinn](#altinn).
2. [ ] **Skatteetaten: trekkpålegg (`skatteetaten:trekkpaalegg`).**
   - Søkt i oktober. Skatteetaten skrev 15.10 at avgjørelsen kommer i en egen oppdatering.
   - Kommer den ikke, send organisasjonsnummeret på e-post til fremtidensinnkreving@skatteetaten.no
     og be om test og produksjon.
3. [ ] **Skatteetaten: aksjonærregisteroppgaven
   (`skatteetaten:innrapporteringaksjonaerregisteroppgave`).**
   - Etter juni 2026 må alle aksjeselskap levere den gjennom et sluttbrukersystem.
   - Fristen for 2026 er 31.01.2027. Søk nå.
4. [ ] **Mva-meldingen fra appen.** Den trenger to ting:
   - en ID-porten-klient i Samarbeidsportalen, først i test og så i produksjon;
   - scopet `skatteetaten:mvameldingvalidering` fra Skatteetaten.

   Skatteetaten anbefaler å bestille ID-porten-integrasjonen tidlig, siden den delvis behandles for
   hånd. Se [mva-innsending.md](mva-innsending.md).
5. [ ] **Skattemeldingen for AS med næringsspesifikasjon.**
   - Scopet `skatteetaten:formueinntekt/skattemelding` bestilles fra Skatteetaten.
   - Det legges på ID-porten-klienten og Maskinporten-klienten.
   - Fristen for inntektsåret 2026 er 31.05.2027.
6. [ ] **Slå på årsregnskapet i testmiljøet.**
   - Scopene er på testklienten, men `AARSREGNSKAP_INNSENDING` er av i miljøet «test».
   - Sett den til `true` der, og kjør Infrastruktur.
   - Trykk så «Oppdater i Altinn» under Plattform → Drift på testflaten.
7. [ ] **NAV.**
   - Gi beskjed første gang sykepenger brukes i produksjon.
   - Vent på svar fra Dolly (testdata).
   - Legg på scopene for de andre inntektsmeldingene når de bygges. Se [NAV](#nav).
8. [ ] **Enable Banking: partneravtale** før bankkoblingen tilbys andre bedrifter.
9. [ ] **Recommand: mottak av EHF** når du har bestemt deg.
10. [ ] **Regnskapsbyråer som fører for klienter (klientforhold)** når det blir aktuelt. Se
    [Regnskapsbyråer](#regnskapsbyråer-klientforhold).

## Grunnlaget hos Digdir

| | Status |
|---|---|
| Tilgang til Samarbeidsportalen for Medinnova AS | Har (13.10.2026) |
| «Bruksvilkår for private virksomheter» (Maskinporten og ID-porten) | Har, signert |
| «Bruksvilkår sluttbrukersystemleverandører» (systembruker i Altinn; NAV krever dem også) | Har, signert |
| Registreringsskjemaet for sluttbrukersystemleverandør, med «Systembruker» | Har (Altinn ga scopene 15.10) |
| Maskinporten-klient i test (`MASKINPORTEN_KLIENT_ID` i miljøet «test», nøkkel-ID `medinnova-1`) | Har |
| Maskinporten-klient i produksjon (`MASKINPORTEN_KLIENT_ID` i repoet, nøkkel-ID `medinnova-prod-1`) | Har, i bruk (sjekket 17.10) |
| ID-porten-klient (API-klient) for mva og skattemelding, test | **Mangler** (`IDPORTEN_KLIENT_ID` er tom) |
| ID-porten-klient (API-klient), produksjon | **Mangler** |

De andre bruksvilkårene i portalen trengs ikke. ELMA gjelder aksesspunkter i Peppol, og EHF går
gjennom Recommand. De øvrige er for offentlige virksomheter og leverandørene deres.

## Altinn

### Scopene på Maskinporten-klienten

| Scope | Brukes til | Test | Produksjon |
|---|---|---|---|
| `altinn:authentication/systemregister.write` | registrere systemet `936564046_lonn` | Har | Har |
| `altinn:authentication/systemuser.request.read` | se kundenes forespørsler om tilgang | Har | Har |
| `altinn:authentication/systemuser.request.write` | be kundene om tilgang og utvidelser | Har | Har |
| `digdir:dialogporten` | svaret på a-meldingen, varselet om trekkpålegg, og senere brev fra etatene i appen | Har | **Mangler** |
| `altinn:instances.read` og `altinn:instances.write` | årsregnskapet til Brønnøysund, og senere skattemeldingen | Har | **Mangler** (fantes ikke i portalen 17.10) |

Send denne e-posten til servicedesk@altinn.no fra en @medinnova.no-adresse:

> **Emne:** Tilgang til scopes i produksjon – Medinnova AS (936564046)
>
> Hei!
>
> Medinnova AS (org.nr. 936564046) leverer sluttbrukersystemet Admin Konsoll (systemet
> 936564046_lonn i systemregisteret), som bruker systembruker i Altinn. Vi har disse scopene i
> testmiljøet og trenger dem også i produksjon:
>
> - digdir:dialogporten, for å hente tilbakemeldingen på a-meldingen og varsler fra Skatteetaten;
> - altinn:instances.read og altinn:instances.write, for å sende årsregnskapet gjennom
>   Brønnøysundregistrenes app i Altinn (brg/aarsregnskap-vanlig-202406).
>
> Altinn-scopene for systembruker og Skatteetatens scopes er allerede gitt i produksjon. Kan dere
> gi oss tilgang til disse også?
>
> Med vennlig hilsen
> Medinnova AS

Når Altinn har svart: legg scopene på produksjonsklienten i Samarbeidsportalen, og kjør sjekken. Det
trengs ingen ny utrulling for Dialogporten. For årsregnskapet settes `AARSREGNSKAP_INNSENDING` til
`true` i miljøet `produksjon` ([aarsregnskap.md](aarsregnskap.md)).

### Tilgangspakkene kundene godkjenner

Systemet ber om disse nå, i test og produksjon: Lønn, A-ordningen, Lønn med personopplysninger av
særlig kategori, og Krav, betalinger og utlegg.

| Tilgangspakke | Brukes til | Ber systemet om den nå? |
|---|---|---|
| Lønn (`urn:altinn:accesspackage:lonn`) | skattekortene | Ja |
| A-ordningen (`…:a-ordning`) | a-meldingen og avstemmingsrapporten | Ja (`AMELDING_INNSENDING`) |
| Lønn med personopplysninger av særlig kategori (`…:lonn-personopplysninger-saerlig-kategori`) | sykmeldingene og inntektsmeldingene hos NAV | Ja (`NAV_SYKEPENGER`) |
| Krav, betalinger og utlegg (`…:krav-og-utlegg`) | krav, betalinger og frister fra Skatteetaten | Ja (`KRAV_OG_FRISTER`) |
| Regnskap og økonomirapportering (`…:regnskap-okonomi-rapport`) | årsregnskapet | Nei, først med `AARSREGNSKAP_INNSENDING` |
| Skattegrunnlag (`…:skattegrunnlag`) | aksjonærregisteroppgaven | Nei, når den bygges |
| Enkeltrettigheten «Informasjon om trekkpålegg» (ressursen `ske-informasjon-om-trekkpaalegg`) | trekkpåleggene | Nei, når de bygges |
| Skatt næring (`…:skatt-naering`) | skattemeldingen | Nei. Den som sender skattemeldingen, trenger pakken. Systembrukeren trenger den først når hele innsendingen kan gjøres med systembruker. |
| Merverdiavgift | mva-meldingen | Nei. Skatteetaten tar imot mva-meldingen med ID-porten, og den som sender, trenger pakken. |

Når en ny pakke kommer til, trykker du «Oppdater i Altinn» under Plattform → Drift. Kundene
godkjenner så utvidelsen med «Utvid tilgangen i Altinn».

### Regnskapsbyråer (klientforhold)

Skal et regnskapsbyrå bruke Admin Konsoll for klientene sine, trengs en systembruker for
klientforhold (agent):

- Systemet registreres med regnskapsførerpakkene: Regnskapsfører med signeringsrettighet, uten
  signeringsrettighet og lønn.
- Byrået godkjenner, og delegerer klientene i Altinn.
- Forespørslene går med de samme Altinn-scopene.
- Skal klientene kunne delegeres fra appen, trengs `altinn:clientdelegations.read` og `.write`
  gjennom ID-porten.
- Skatteetaten fraråder å blande pakker fra ulike fullmaktsområder i et klientsystem, fordi det kan
  stoppe klientdelegeringen. Byråene bør derfor få et eget system i systemregisteret.

## Skatteetaten

Tilgangene bestilles i Skatteetatens brukerstøtteportal (<https://eksternjira.sits.no>):

- velg tjenesteområdet, og både test og produksjon;
- godta bruksvilkårene.

Trekkpålegg kan også bestilles på e-post. Skatteetaten gir tilgang til krav, frister og trekkpålegg
bare når kunden har rapportert gjennom systemet minst én gang, for eksempel a-meldingen.

| Tjeneste | Scope | Brukes til i appen | Test | Produksjon |
|---|---|---|---|---|
| Skattekort til arbeidsgiver (DM-41) | `skatteetaten:skattekorttilarbeidsgiver` | Lønn → Skattekort | Har | Har |
| Innrapportering a-melding (DM-1) | `skatteetaten:innrapporteringamelding` | a-meldingen og avstemmingsrapporten | Har | Har |
| Krav og betalinger (DM-47) | `skatteetaten:kravogbetalinger` | Regnskap → Skatteetaten | Har | Har |
| Frister (DM-49) | `skatteetaten:frister` | Regnskap → Skatteetaten | Har | Har |
| Trekkpålegg | `skatteetaten:trekkpaalegg` | trekkpåleggene rett inn i lønnstrekkene (ikke bygget) | **Venter** | **Venter** |
| Mva-meldingen | `skatteetaten:mvameldingvalidering` (ID-porten) | Regnskap → Mva → «Send til Skatteetaten» | **Ikke søkt** | **Ikke søkt** |
| Skattemeldingen | `skatteetaten:formueinntekt/skattemelding` (ID-porten og Maskinporten) | skattemeldingen for AS med næringsspesifikasjon (ikke bygget) | **Ikke søkt** | **Ikke søkt** |
| Aksjonærregisteroppgaven (RF-1086) | `skatteetaten:innrapporteringaksjonaerregisteroppgave` | aksjonærregisteroppgaven (ikke bygget) | **Ikke søkt** | **Ikke søkt** |

### Trekkpålegg

- Søkt sammen med Krav og betalinger og Frister («Tilgangsforespørsel hente data»). Skatteetaten
  skrev 15.10 at avgjørelsen kommer i en egen oppdatering.
- Test-scopet bestilles også med en e-post til fremtidensinnkreving@skatteetaten.no, med
  organisasjonsnummeret til Medinnova (ikke et syntetisk). Produksjon bestilles på samme måte.
- Med systembruker må forespørselen til kunden ha ressursen `ske-informasjon-om-trekkpaalegg`.
- Skatteetaten varsler nye trekkpålegg gjennom Dialogporten.

### Mva-meldingen

- Bestilles under tjenesteområdet «MVA-melding».
- ID-porten-klienten trenger også `openid`, `altinn:instances.read` og `altinn:instances.write`.
- Den som sender, logger inn med ID-porten og må ha «Merverdiavgift» eller en regnskapsførerpakke
  for organisasjonen.

### Skattemeldingen

- Bestilles under tjenesteområdet «Skattemeldingen».
- For inntektsåret 2025 kunne systembruker hente og validere, men selve innsendingen krevde en
  person innlogget med ID-porten.
- Kunden trenger «Skatt næring».
- Ikke søk om «Næringsspesifikasjon API» eller «Skattemelding upersonlig API». Det er
  datadelingstjenester som krever hjemmel.

### Aksjonærregisteroppgaven

- Bestilles under tjenesteområdet «Aksjonærregisteret».
- API-et er åpent i test og produksjon.
- Systembrukeren trenger «Skattegrunnlag», en regnskapsfører- eller revisorpakke, eller
  enkeltrettigheten `ske-innrapportering-aksjonaerregisteroppgave`.

### Kan bli aktuelt

«Oppdrag utenlandske oppdragstakere» (RF-1199) har scopet
`skatteetaten:innrapporteringoppdragutenlandskeoppdragstakere` og ressursen
`ske-innrapportering-oppdragsregisteret`. Den trengs bare om kundene bruker utenlandske
oppdragstakere.

## NAV

| Hva | Scope | Brukes til | Test | Produksjon |
|---|---|---|---|---|
| Sykepenger | `nav:helseytelser/sykepenger` | sykmeldinger, søknader, forespørsler og inntektsmelding (Lønn → Sykepenger) | Har | Har |
| Foreldrepenger og svangerskapspenger | `nav:inntektsmelding/foreldrepenger` | inntektsmeldingen (ikke bygget) | – | – |
| Omsorgspenger, pleiepenger og opplæringspenger | `nav:inntektsmelding/sif` | inntektsmeldingen og refusjonskravet for omsorgspenger (ikke bygget) | – | – |
| Oppfølgingsplan | `nav:oppfolgingsplan/lps.write` | oppfølgingsplanen for sykmeldte (kan bli aktuelt i Personal) | – | – |

Sykepengescopet er åpent for alle, så NAV trenger ikke godkjenne det. NAVs API-er for foreldrepenger
og for sykdom i familien er i produksjon. Sjekk i Samarbeidsportalen om scopene deres er åpne på
samme måte når de skal bygges. NAV oppgir «Lønn med personopplysninger av særlig kategori» som
tilgangspakken for inntektsmeldingene.

- [ ] **Kontaktinformasjonen** som NAVs vilkår krever (kontaktperson, e-post og telefon) skal til
  nav.prosjekt.2.inntektsmelding@nav.no. Du skrev 15.10 at e-post til NAV var sendt. Sjekk at den
  gikk dit.
- [ ] **Testdata i Dolly**: e-post til dolly@nav.no er sendt, men det var ikke kommet svar 17.10.
- [ ] **Beskjed til nav.prosjekt.2.inntektsmelding@nav.no første gang sykepenger brukes i
  produksjon.** Dette gjøres bare første gang, ikke for hver kunde. Se [nav.md](nav.md).

## Brønnøysundregistrene

| | Status |
|---|---|
| Enhetsregisteret og rollene (åpne API-er, også testmiljøet) | Har, trenger ingen tilgang |
| Årsregnskapet (Regnskapsregisteret) | Går gjennom Altinn, med scopene og tilgangspakken over. Det trengs ingen egen avtale med Brønnøysund, men de vil ha en skriftlig oppsummering av testen før produksjon. |
| `brreg:mottak` (elektronisk mottak) | Trengs ikke |
| Reelle rettighetshavere (maskinell innrapportering) | Kan bli aktuelt. Krever egen tilgang hos Brønnøysund. |

## Bank, EHF og signering

| Leverandør | Brukes til | Nå | Trengs for et komplett system |
|---|---|---|---|
| Enable Banking | kontoinformasjon og bankavstemming | Hver organisasjon har sin egen applikasjon og avtale, med egen nøkkel. Vilkårene lar bedrifter lese egne kontoer til Enable Banking varsler skriftlig. | En partneravtale for Admin Konsoll, med én applikasjon for alle kundene, før bankkoblingen tilbys bredt. Kontakt support.api@enablebanking.com eller info@enablebanking.com. Betalinger fra appen er en egen tjeneste med egen avtale. |
| Recommand | EHF ut (Peppol) | Hver organisasjon har sin egen konto og API-nøkkel | Mottak av EHF (innkommende fakturaer) venter på avgjørelsen din og svaret fra Recommand |
| Idura | BankID-signering | Lisensen finnes | Brukes når elektronisk signering av PDF-ene bygges |

## Hos hver kunde

- **Systemtilgangen:** Daglig leder, eller den som har tilgangsstyring, godkjenner systemtilgangen i
  Altinn når kunden kobler til (Lønn → Skattekort, eller Regnskap → Årsregnskap).
- **Flere tilgangspakker:** Når systemet ber om flere, godkjenner kunden utvidelsen («Utvid tilgangen
  i Altinn»).
- **Krav, frister og trekkpålegg:** Kunden må ha rapportert gjennom Admin Konsoll minst én gang.
- **Mva-meldingen:** Den sendes av en person som logger inn med ID-porten. Personen trenger
  «Merverdiavgift» eller en regnskapsførerpakke for organisasjonen.
- **Skattemeldingen:** Det samme gjelder senere, men med «Skatt næring».
- **Årsregnskapet:** Det signeres i Altinn av daglig leder eller en annen med signaturrett.
- **Bank og EHF:** Kunden har egen applikasjon hos Enable Banking og egen konto hos Recommand, til
  partneravtalene er på plass.

## Bryterne i miljøene

Slik står variablene etter Infrastruktur 18.10.2026:

| GitHub-variabel | Test | Produksjon |
|---|---|---|
| `SKATTEETATEN_MILJO` | test (låst i `test.tfvars`) | prod |
| `AMELDING_INNSENDING` | true | true |
| `NAV_SYKEPENGER` | true | true |
| `KRAV_OG_FRISTER` | true | true |
| `AARSREGNSKAP_INNSENDING` | false | false |
| `MVA_INNSENDING` | på i `test.tfvars`, men skjult til `IDPORTEN_KLIENT_ID` er satt | false |
| `IDPORTEN_KLIENT_ID` | tom | tom |

Når en tilgang er gitt:

1. Legg scopet på klienten i Samarbeidsportalen.
2. Kjør sjekken.
3. Sett variabelen, og kjør Infrastruktur fra main.
4. Kommer det til en ny tilgangspakke, trykker du «Oppdater i Altinn» under Plattform → Drift.

## Slik sjekker du selv

- I Cloud Shell: `KLIENT_ID=<klient-ID-en> bash scripts/maskinporten.sh sjekk`. Det sjekker
  produksjonsklienten; sett `MILJO=test` foran for testklienten. Du får ✓ eller ✗ for hvert scope
  appen bruker. `invalid_scope` betyr at scopet ikke er gitt, eller ikke er lagt på klienten.
- «Tilganger» i Samarbeidsportalen viser hva Medinnova har fått:
  - test: <https://sjolvbetjening.test.samarbeid.digdir.no>
  - produksjon: <https://sjolvbetjening.samarbeid.digdir.no>
- Plattform → Drift i appen viser systemet i Altinn og tilgangspakkene det ber om.

## Kilder

- Skatteetatens API-dokumentasjon (trekkpålegg, aksjonærregisteroppgave, skattemelding,
  mva-melding og systembruker): <https://skatteetaten.github.io/api-dokumentasjon>
- Skatteetaten, aksjonærregisteroppgaven for sluttbrukersystemer:
  <https://www.skatteetaten.no/samarbeidspartnere/sluttbrukersystemer/aksjonarregisteroppgaven-sbs/>
- Skatteetaten, trekkpålegg for sluttbrukersystemer:
  <https://www.skatteetaten.no/samarbeidspartnere/sluttbrukersystemer/trekkpalegg-sbs/>
- Skatteetaten, overgangen til Altinn 3 for skattemelding og mva:
  <https://www.skatteetaten.no/samarbeidspartnere/sluttbrukersystemer/sbs-nyheter/informasjon-om-overgangen-fra-altinn-2-til-altinn-3-for-de-moderniserte-losningene-skattemelding-og-mva/>
- Altinn, klientdelegering for systemleverandører:
  <https://docs.altinn.studio/en/authorization/guides/system-vendor/system-user/client-delegation/>
- NAV, nye inntektsmeldinger: <https://www.nav.no/arbeidsgiver/nye-inntektsmeldinger>, og API-ene
  `navikt/sykepenger-im-lps-api`, `navikt/fp-inntektsmelding-api` og `navikt/k9-inntektsmelding-api` på
  GitHub
- Brønnøysundregistrene, maskinell innsending av årsregnskap:
  <https://brreg.github.io/docs/apidokumentasjon/regnskapsregisteret/maskinell-innrapportering/hvordan-sende-inn/>
- Oppsettet for hver tjeneste: [skattekort.md](skattekort.md), [amelding.md](amelding.md),
  [nav.md](nav.md), [skatteetaten-krav.md](skatteetaten-krav.md),
  [aarsregnskap.md](aarsregnskap.md), [mva-innsending.md](mva-innsending.md) og
  [miljoer.md](miljoer.md)
