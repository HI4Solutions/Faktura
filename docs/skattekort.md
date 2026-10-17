# Skattekort fra Skatteetaten – oppsett

Appen henter skattekortene til de ansatte fra Skatteetaten (API-et «Skattekort til arbeidsgiver»)
med systembruker i Altinn. Leverandøren av løsningen, Medinnova AS (org.nr. 936 564 046), setter
dette opp én gang. Deretter gir hver kunde tilgang i Altinn rett fra appen.

Funksjonen er skjult til klient-ID-en til Maskinporten er satt (GitHub-variabelen
`MASKINPORTEN_KLIENT_ID`).

## Slik virker det

1. Medinnova har én klient i Maskinporten og ett system i Altinns systemregister (system-ID
   `936564046_lonn`, tilgangspakken «Lønn», `urn:altinn:accesspackage:lonn`). Når a-meldingen
   sendes fra appen, ber systemet også om «A-ordningen» (se [amelding.md](amelding.md)), med
   sykepengene fra NAV «Lønn med personopplysninger av særlig kategori» (se [nav.md](nav.md)), og
   med krav og frister fra Skatteetaten «Krav, betalinger og utlegg» (se
   [skatteetaten-krav.md](skatteetaten-krav.md)).
2. Kunden trykker «Koble til Skatteetaten» under Innstillinger → Lønn → Skattekort. Appen lager en
   forespørsel om systemtilgang i Altinn, og daglig leder (eller den som har tilgangsstyring i
   Altinn) godkjenner den. Altinn sender brukeren tilbake til `<APP_URL>/skattekort/godkjent`.
3. Workeren henter et token fra Maskinporten for kundens systembruker, bestiller skattekortene til
   de ansatte med fødselsnummer (høyst 1000 om gangen), henter svaret og lagrer skattekortene på de
   ansatte. Hver morgen hentes endringene, og et skattekort hentes når en ansatt legges inn med
   fødselsnummer. Bestillingen har med en e-postadresse (og mobilnummer når organisasjonen har
   et) som Skatteetaten varsler når et skattekort endres: organisasjonens e-post (Innstillinger →
   Organisasjon), ellers e-posten til den som koblet til Skatteetaten, ellers eierens.
4. Avviser Skatteetaten en bestilling, står svaret deres (med korrelasjons-ID-en, som Skatteetaten
   trenger om feilen meldes) under «Siste henting feilet». Hele svaret, uten fødselsnumre, står i
   loggen til workeren («Skatteetaten avviste bestillingen av skattekort»).

Koden: `server/src/maskinporten.ts` (token), `server/src/altinn.ts` (systemregisteret og
forespørslene), `server/src/skattekort.ts` (bestilling, svar og lagring),
`server/src/skattekortRuter.ts` (API-et) og `db/migrations/0068_skattekort_fra_skatteetaten.sql`.

## Oppsett hos Medinnova (én gang)

Gjør det først i testmiljøet (Maskinporten-test, Altinn TT02 og Skatteetatens testmiljø), og
deretter i produksjon.

1. **Tilgang hos Digdir.** Medinnova må ha tilgang til Samarbeidsportalen (selvbetjening for
   Maskinporten). Når Digdir har opprettet tilgangen for virksomheten, registrerer den som skal
   signere seg med sin @medinnova.no-adresse på <https://minside-samarbeid.digdir.no/>, går til
   «Virksomhetens bruksvilkår» og signerer to av dem: «Bruksvilkår for private virksomheter»
   (Maskinporten) og «Bruksvilkår sluttbrukersystemleverandører» (systembrukeren i Altinn; NAV
   krever dem også, se [nav.md](nav.md)). De andre trengs ikke: de er for offentlige virksomheter
   og leverandørene deres, for eInnsyn og for tjenesteleverandører i ELMA (aksesspunktene i
   PEPPOL; EHF går gjennom Recommand). Test: <https://sjolvbetjening.test.samarbeid.digdir.no>.
2. **Scopene.** Ingen av dem er åpne for alle; de bestilles for Medinnovas organisasjonsnummer
   (test og produksjon). Før de er godkjent, står de ikke i lista over scopes i portalen, eller
   de er merket «Tilgang mangler».
   - Fra Digdir (Altinn): når bruksvilkårene for sluttbrukersystemleverandører er signert (punkt
     1), fyll ut «Registreringsskjema for sluttbrukersystemleverandør» med «Systembruker» krysset
     av:
     <https://forms.office.com/Pages/ResponsePage.aspx?id=D1aOAK8I7EygVrNUR1A5kcdP2Xp78HZOttvolvmHfSJUOFFBMThaOTI1UlVEVU9VM0FaTVZLMzg0Vi4u>
     (lenket fra steg 2 på <https://docs.altinn.studio/nb/authorization/getting-started/systemuser/>).
     Det gir `altinn:authentication/systemregister.write`,
     `altinn:authentication/systemuser.request.read` og
     `altinn:authentication/systemuser.request.write`. Be i det samme skjemaet om
     `digdir:dialogporten` (a-meldingen, se [amelding.md](amelding.md)); Skatteetaten ber
     leverandørene bestille det der. Klientdelegering og samtykke trengs ikke.
   - Fra Skatteetaten: `skatteetaten:skattekorttilarbeidsgiver` og
     `skatteetaten:innrapporteringamelding` (a-meldingen, se [amelding.md](amelding.md)). Begge
     bestilles i én søknad med Skatteetatens skjema for tilgang til tjenester for innrapportering, i
     brukerstøtteportalen (<https://eksternjira.sits.no>): velg «Skattekort til arbeidsgiver» og
     «A-meldingen», test og produksjon, og godta bruksvilkårene (se «søknad om tilgang til tjenester
     for innrapportering» under Kilder). Tre tjenester til er aktuelle senere, men brukes ikke av
     appen ennå: «Krav og betalinger» og «Frister» (regnskapet) bestilles med «Tilgangsforespørsel
     hente data» i samme portal, og trekkpålegg (`skatteetaten:trekkpaalegg`, lønnstrekkene) i test
     med e-post til fremtidensinnkreving@skatteetaten.no.
   - `nav:helseytelser/sykepenger` (NAV, `docs/nav.md`) er åpent for alle og trenger ingen søknad.
3. **Nøkkelen.** I Cloud Shell, fra repoet (`cd Faktura && git pull`):

   ```sh
   MILJO=test bash scripts/maskinporten.sh nokkel   # testklienten (hi4-faktura-test)
   bash scripts/maskinporten.sh nokkel              # produksjonsklienten (hi4-faktura-prod)
   ```

   Skriptet lager nøkkelparet og legger den private nøkkelen rett i Secret Manager (hemmeligheten
   `maskinporten-nokkel-ny`), uten at den skrives til disk eller vises. Den skal aldri sendes på
   e-post, i chat eller som skjermbilde. Den offentlige nøkkelen (JWK-en som skrives ut, med
   nøkkel-ID-en `medinnova-1` i test og `medinnova-prod-1` i produksjon) er ikke hemmelig. Appen
   bruker hemmeligheten `maskinporten-nokkel`; nøkkelen flyttes dit når klienten er sjekket
   (punkt 4 og [miljoer.md](miljoer.md)).
4. **Maskinporten-klienten.** I Samarbeidsportalen: **Klienter → Opprett klient**, velg
   Maskinporten, visningsnavn «Admin Konsoll» og en beskrivelse, og legg til scopene over (de som er
   godkjent; resten legges på den samme klienten senere). Legg inn den offentlige nøkkelen (JWK-en
   fra punkt 3) under nøklene på klienten. Noter klient-ID-en og nøkkel-ID-en (`kid`). «Scopes» i
   menyen er for dem som lager egne API-er, og «Tilganger» viser tilgangene Medinnova har fått.
   Sjekk klienten i Cloud Shell med `KLIENT_ID=<klient-ID-en> bash scripts/maskinporten.sh sjekk`
   (`MILJO=test` for testklienten): den ber Maskinporten om et token for hvert scope appen bruker,
   og viser hvilke som virker.
5. **GitHub-variablene** (Settings → Secrets and variables → Actions → Variables):
   - `MASKINPORTEN_KLIENT_ID`: klient-ID-en;
   - `MASKINPORTEN_NOKKEL_ID`: nøkkel-ID-en (kid);
   - `SKATTEETATEN_MILJO`: `test` (standard) eller `prod`;
   - valgfritt `ALTINN_SYSTEMNAVN` (navnet kundene ser i Altinn, standard «Admin Konsoll») og
     `LEVERANDOR_ORGNR` (standard 936564046).

   Kjør så workflowen «Infrastruktur» (Actions → Infrastruktur → Run workflow).
6. **Systemet i Altinn.** Plattform → Drift → «Skattekort (Skatteetaten)» → «Registrer
   systemet i Altinn». Det samme oppdaterer navnet og klient-ID-en senere.
7. **Test.** En testorganisasjon i TT02 kobler til under Innstillinger → Lønn → Skattekort,
   godkjenner i Altinn TT02 og henter skattekortene til Skatteetatens testpersoner
   (regnearket med testpersoner i dokumentasjonen til API-et). Skattekortene i testmiljøet
   oppdateres hver dag kl. 06.
8. **Produksjon.** Gjenta punkt 1–6 i produksjonsmiljøet (<https://sjolvbetjening.samarbeid.digdir.no>)
   med en ny nøkkel, i rekkefølgen i [miljoer.md](miljoer.md) («Før Skatteetaten, Altinn og NAV går
   i produksjon»), og sett `SKATTEETATEN_MILJO` til `prod`. Adressene til API-ene følger
   miljøet; de kan overstyres med `MASKINPORTEN_URL`, `ALTINN_URL` og `SKATTEKORT_URL`.

## Kilder

- Skatteetaten, Skattekort til arbeidsgiver API:
  <https://skatteetaten.github.io/api-dokumentasjon/api/skattekorttilarbeidsgiver>
- Skatteetaten, systembruker: <https://skatteetaten.github.io/api-dokumentasjon/om/systembruker>
- Skatteetaten, søknad om tilgang til tjenester for innrapportering (a-meldingen, skattekort og
  flere):
  <https://www.skatteetaten.no/samarbeidspartnere/sluttbrukersystemer/sbs-nyheter/her-kan-du-soke-om-tilgang-til-tjenester-for-innrapportering-til-skatteetaten/>
- Skatteetaten, oppkobling for systemleverandører:
  <https://www.skatteetaten.no/samarbeidspartnere/reetablering-altinn/systemleverandor/oppkobling/>
- Altinn, systembruker for systemleverandører:
  <https://docs.altinn.studio/nb/authorization/guides/system-vendor/system-user/>
- Digdir, Maskinporten-token: <https://docs.digdir.no/docs/Maskinporten/maskinporten_protocol_token>
