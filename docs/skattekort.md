# Skattekort fra Skatteetaten – oppsett

Appen henter skattekortene til de ansatte fra Skatteetaten (API-et «Skattekort til arbeidsgiver»)
med systembruker i Altinn. Leverandøren av løsningen, Medinnova AS (org.nr. 936 564 046), setter
dette opp én gang. Deretter gir hver kunde tilgang i Altinn rett fra appen.

Funksjonen er skjult til klient-ID-en til Maskinporten er satt (GitHub-variabelen
`MASKINPORTEN_KLIENT_ID`).

## Slik virker det

1. Medinnova har én klient i Maskinporten og ett system i Altinns systemregister (system-ID
   `936564046_lonn`, tilgangspakken «Lønn», `urn:altinn:accesspackage:lonn`).
2. Kunden trykker «Koble til Skatteetaten» under Innstillinger → Ansatte og timer. Appen lager en
   forespørsel om systemtilgang i Altinn, og daglig leder (eller den som har tilgangsstyring i
   Altinn) godkjenner den. Altinn sender brukeren tilbake til `<APP_URL>/skattekort/godkjent`.
3. Workeren henter et token fra Maskinporten for kundens systembruker, bestiller skattekortene til
   de ansatte med fødselsnummer (høyst 1000 om gangen), henter svaret og lagrer skattekortene på de
   ansatte. Hver morgen hentes endringene, og et skattekort hentes når en ansatt legges inn med
   fødselsnummer.

Koden: `server/src/maskinporten.ts` (token), `server/src/altinn.ts` (systemregisteret og
forespørslene), `server/src/skattekort.ts` (bestilling, svar og lagring),
`server/src/skattekortRuter.ts` (API-et) og `db/migrations/0068_skattekort_fra_skatteetaten.sql`.

## Oppsett hos Medinnova (én gang)

Gjør det først i testmiljøet (Maskinporten-test, Altinn TT02 og Skatteetatens testmiljø), og
deretter i produksjon.

1. **Tilgang hos Digdir.** Medinnova må ha tilgang til Samarbeidsportalen (selvbetjening for
   Maskinporten). Test: <https://sjolvbetjening.test.samarbeid.digdir.no>.
2. **Scopene.** Be om disse (begge gjelder Medinnovas organisasjonsnummer):
   - fra Digdir (Altinn): `altinn:authentication/systemregister.write`,
     `altinn:authentication/systemuser.request.read` og
     `altinn:authentication/systemuser.request.write`;
   - fra Skatteetaten: `skatteetaten:skattekorttilarbeidsgiver`.
3. **Nøkkelen.** Lag nøkkelparet i Cloud Shell, i prosjektet `hi4-faktura-prod`. Den private
   nøkkelen legges rett i Secret Manager og slettes etterpå; den skal aldri sendes på e-post, i
   chat eller som skjermbilde.

   ```sh
   openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out maskinporten.pem
   gcloud secrets versions add maskinporten-nokkel --data-file=maskinporten.pem --project=hi4-faktura-prod
   # Den offentlige nøkkelen (JWK) til Samarbeidsportalen; «medinnova-1» er nøkkel-ID-en (kid).
   node -e 'const c=require("crypto"),f=require("fs");const j=c.createPublicKey(f.readFileSync("maskinporten.pem")).export({format:"jwk"});console.log(JSON.stringify({kty:j.kty,e:j.e,n:j.n,kid:process.argv[1],alg:"RS256",use:"sig"}))' medinnova-1
   shred -u maskinporten.pem
   ```

   Den offentlige nøkkelen (JWK-en som skrives ut) er ikke hemmelig.
4. **Maskinporten-klienten.** Lag en integrasjon av typen Maskinporten i Samarbeidsportalen, med
   scopene over, og legg inn den offentlige nøkkelen. Noter klient-ID-en (integrasjons-ID-en) og
   nøkkel-ID-en.
5. **GitHub-variablene** (Settings → Secrets and variables → Actions → Variables):
   - `MASKINPORTEN_KLIENT_ID`: klient-ID-en;
   - `MASKINPORTEN_NOKKEL_ID`: nøkkel-ID-en (kid);
   - `SKATTEETATEN_MILJO`: `test` (standard) eller `prod`;
   - valgfritt `ALTINN_SYSTEMNAVN` (navnet kundene ser i Altinn, standard «HI4 Faktura») og
     `LEVERANDOR_ORGNR` (standard 936564046).

   Kjør så workflowen «Infrastruktur» (Actions → Infrastruktur → Run workflow).
6. **Systemet i Altinn.** Administrasjon → Drift → «Skattekort (Skatteetaten)» → «Registrer
   systemet i Altinn». Det samme oppdaterer navnet og klient-ID-en senere.
7. **Test.** En testorganisasjon i TT02 kobler til under Innstillinger → Ansatte og timer,
   godkjenner i Altinn TT02 og henter skattekortene til Skatteetatens testpersoner
   (regnearket med testpersoner i dokumentasjonen til API-et). Skattekortene i testmiljøet
   oppdateres hver dag kl. 06.
8. **Produksjon.** Gjenta punkt 1–6 i produksjonsmiljøet (<https://sjolvbetjening.samarbeid.digdir.no>)
   med en ny nøkkel, og sett `SKATTEETATEN_MILJO` til `prod`. Adressene til API-ene følger
   miljøet; de kan overstyres med `MASKINPORTEN_URL`, `ALTINN_URL` og `SKATTEKORT_URL`.

## Kilder

- Skatteetaten, Skattekort til arbeidsgiver API:
  <https://skatteetaten.github.io/api-dokumentasjon/api/skattekorttilarbeidsgiver>
- Skatteetaten, systembruker: <https://skatteetaten.github.io/api-dokumentasjon/om/systembruker>
- Skatteetaten, oppkobling for systemleverandører:
  <https://www.skatteetaten.no/samarbeidspartnere/reetablering-altinn/systemleverandor/oppkobling/>
- Altinn, systembruker for systemleverandører:
  <https://docs.altinn.studio/nb/authorization/guides/system-vendor/system-user/>
- Digdir, Maskinporten-token: <https://docs.digdir.no/docs/Maskinporten/maskinporten_protocol_token>
