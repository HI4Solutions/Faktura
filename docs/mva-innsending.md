# Mva-meldingen til Skatteetaten

Under Regnskap → Mva sendes mva-meldingen til Skatteetaten rett fra appen: linjene appen har regnet
fra bilagene, med merknadene Skatteetaten krever, valideres hos Skatteetaten og sendes gjennom
Skatteetatens app i Altinn. Terminen merkes som levert, betalingsinformasjonen (beløp, konto, KID og
frist) vises, og kvitteringen fra Skatteetaten kan lastes ned. Meldingen kan fortsatt leveres i
Altinn og merkes som levert for hånd («Levert i Altinn i stedet?»).

**Den som sender, logger inn med ID-porten.** Skatteetaten tar ikke imot mva-meldingen med
systembruker ennå (mars 2026), så meldingen sendes på vegne av personen som logger inn, ikke av
systemet. Personen må ha rett til å sende mva-meldingen for organisasjonen i Altinn: tilgangspakken
**«Merverdiavgift»**, eller **«Regnskapsfører med signeringsrett»** for en regnskapsfører (Altinns
roller er erstattet av tilgangspakker fra 15. april 2026). Uten rettigheten svarer Altinn nei, og
appen sier hva som mangler.

Funksjonen er på i testmiljøet og av i produksjon (se «Oppsett» under). Den vises når
ID-porten-klienten er satt opp.

## I appen

1. **Send til Skatteetaten** (når terminen er over og ikke levert, eller endret etter leveringen).
   Appen fryser meldingen (XML-en, linjene og summen) og sender brukeren til ID-porten. Det som
   sendes, er det brukeren så.
2. **Innloggingen i ID-porten** (nivå «betydelig», alltid ny innlogging). ID-porten sender brukeren
   tilbake til appen (`/mva/idporten`), som gir koden til API-et. Avbryter brukeren, eller tar det
   mer enn et kvarter, sendes ingenting.
3. **Sendingen** (workeren, noen sekunder; siden viser hvor langt den har kommet):
   - koden byttes mot tokenene, og ID-tokenet sjekkes;
   - Skatteetaten **validerer** meldingen. Er den **ugyldig**, sendes den ikke, og feilene vises.
     **Avvik** (avvikende melding) stopper ikke sendingen; de vises, og Skatteetaten kan følge dem
     opp;
   - ID-porten-tokenet byttes til et Altinn-token, og meldingen sendes gjennom Skatteetatens app i
     Altinn: instansen, konvolutten (MvaMeldingInnsending), meldingen, utfyllingen og innsendingen.
4. **Sendt:** terminen merkes som levert i dag med beløpet som ble sendt, av den som sendte.
   Betalingsinformasjonen fra Skatteetaten vises (positivt beløp betales, negativt kommer tilbake).
5. **Mottatt:** når Skatteetaten har behandlet meldingen, henter appen tilbakemeldingen (statusen,
   valideringsresultatet og kvitteringen som PDF). Workeren spør med litt mellomrom så lenge
   Altinn-tokenet varer (rundt en halvtime); kommer den senere, ligger kvitteringen i Altinn.

**Merknader.** En linje med motsatt fortegn av det vanlige (f.eks. inngående avgift som skal
tilbakeføres etter en kreditnota fra en leverandør, eller negativt salg) må forklares (Skatteetatens
regler R020 og R021). Appen merker linjen, og brukeren velger en av merknadene Skatteetaten godtar
for koden (kodelisten merknadTilsvarendeMvaKode), eller skriver en egen forklaring der det er lov.
Uten merknad sender ikke appen meldingen. Merknadene fra forrige sending for terminen fylles inn.

**Korrigert melding.** Endres terminen etter at meldingen er levert (beløpet er et annet), sier
appen fra, og «Send korrigert melding» sender en ny, komplett melding for terminen.

## Sikkerhet og feil

- **Koden fra ID-porten brukes én gang**, så sendingen prøves ikke på nytt av seg selv. Feiler den,
  får innsendingen feil med årsaken, og brukeren sender på nytt (og logger inn igjen). Cloud Tasks
  kan levere oppgaven to ganger; bare én worker tar den.
- **Ble meldingen sendt?** Feiler noe etter at instansen er laget, sjekker workeren instansen i
  Altinn: er den sendt inn, merkes terminen som levert som vanlig. Kan ikke det avgjøres (Altinn
  svarte ikke etter innsendingen), ber appen brukeren sjekke meldingen i Altinn før de sender på
  nytt, så den ikke sendes to ganger. Instansen og meldingen lages ikke to ganger ved nye forsøk på
  kallene (POST prøves bare på nytt når Altinn svarte 503).
- **Bare én sending om gangen** for en termin (databasen sørger for det).
- **Tokenene lagres ikke**, bortsett fra Altinn-tokenet, kryptert med Cloud KMS (API-et kan bare
  kryptere), til tilbakemeldingen er hentet. Innloggingen (state, nonce og PKCE-verifikatoren) brukes
  én gang og tømmes; API-et kan ikke lese verifikatoren, nonce eller tokenet.
- **Hjerteslaget** (hvert minutt) avbryter innlogginger som ikke ble fullført på et kvarter, gir
  feil til sendinger som ikke ble ferdige på en halvtime, og sletter utløpte Altinn-tokener.
- **Tilgangen:** de med Regnskap (eier, administrator, regnskap og egne roller med Regnskap) ser og
  sender meldingen. Brukeren som startet innloggingen, må være den som kommer tilbake fra ID-porten.

## Lagret

`faktura.mva_innsendinger` (`0125_mva_innsending.sql`): én rad per forsøk, med statusen
(innlogging, sender, sendt, mottatt, feil, avbrutt), meldingen (XML), linjene med merknadene,
summen, instansen i Altinn, steget sendingen kom til, avvikene, betalingsinformasjonen,
tilbakemeldingen, kvitteringen (PDF), feilen, hvem som startet den og når. Den siste raden for
terminen vises under Regnskap → Mva. Raden slettes med organisasjonen (og regnskapsmaterialet når
oppbevaringstiden er ute).

## Oppsett hos Medinnova

Gjøres i testmiljøet først (ID-porten test, Altinn TT02 og Skatteetatens testmiljø), deretter i
produksjon. Ingen nøkler, tokens eller hemmeligheter skal sendes på e-post, i chat eller som
skjermbilde.

1. **ID-porten-integrasjonen.** I Digdirs selvbetjening (test:
   <https://sjolvbetjening.test.samarbeid.digdir.no>, produksjon:
   <https://sjolvbetjening.samarbeid.digdir.no>), innlogget for Medinnova AS (936564046):
   **Klienter → Opprett klient**, velg **ID-porten** og integrasjonstypen **API-klient** (innlogging
   for en person som bruker API-er på egne og andres vegne), applikasjonstype **web**, visningsnavn
   «Admin Konsoll». Legg inn:
   - scopene `openid`, `skatteetaten:mvameldingvalidering`, `altinn:instances.read` og
     `altinn:instances.write`;
   - tilbakeadressene (redirect URI) `https://app.test.adminkonsoll.no/mva/idporten` og
     `https://test.adminkonsoll.no/mva/idporten` (produksjon: `https://app.adminkonsoll.no/mva/idporten`
     og `https://adminkonsoll.no/mva/idporten`);
   - klientautentisering `private_key_jwt` (anbefalt; nøkkelen i punkt 3) eller
     `client_secret_basic` (klienthemmeligheten).

   Noter klient-ID-en.
2. **Scopet hos Skatteetaten.** `skatteetaten:mvameldingvalidering` bestilles for Medinnovas
   organisasjonsnummer (test og produksjon) hos Skatteetaten (brukerstøtteportalen
   <https://eksternjira.sits.no>, tilgang til mva-meldingen for sluttbrukersystemer). Før det er
   godkjent, står scopet ikke i lista i selvbetjeningen. `altinn:instances.read` og
   `altinn:instances.write` er Altinns scopes for instansene i appene.
3. **Nøkkelen** (med `private_key_jwt`). I Cloud Shell, fra repoet (`cd Faktura && git pull`), når
   Infrastruktur har laget hemmeligheten:

   ```sh
   bash scripts/idporten.sh nokkel            # testklienten (hi4-faktura-test)
   MILJO=prod bash scripts/idporten.sh nokkel # produksjonsklienten (hi4-faktura-prod)
   ```

   Skriptet lager nøkkelparet og legger den private nøkkelen rett i Secret Manager (hemmeligheten
   `idporten-nokkel`, som bare workeren leser), uten at den skrives til disk eller vises. Lim den
   offentlige nøkkelen (JWK-en som skrives ut, med nøkkel-ID-en `admin-konsoll-mva-test-1`) inn
   under nøklene på integrasjonen.

   Med klienthemmeligheten i stedet: legg den i hemmeligheten `idporten-klienthemmelighet` i Cloud
   Shell, uten at den vises:

   ```sh
   read -rs H && printf '%s' "$H" | gcloud secrets versions add idporten-klienthemmelighet --data-file=- --project=hi4-faktura-test; unset H
   ```
4. **GitHub-variablene** i miljøet `test` (Settings → Environments → test → Environment variables):
   - `IDPORTEN_KLIENT_ID`: klient-ID-en;
   - `IDPORTEN_NOKKEL_ID`: nøkkel-ID-en (kid), når klienten bruker nøkkelen.

   `MVA_INNSENDING` trengs ikke i test (den er på i `infra/terraform/miljo/test.tfvars`). Kjør
   **Infrastruktur** og så **Utrulling**, så API-et og workeren får variablene og hemmeligheten.
5. **Test.** Logg inn i appen på app.test.adminkonsoll.no i en organisasjon med
   organisasjonsnummeret til en syntetisk organisasjon som er registrert i Merverdiavgiftsregisteret
   (Tenor), med «Registrert for merverdiavgift» under Innstillinger → Organisasjon og bilag i en
   termin som er over. Under Regnskap → Mva: **Send til Skatteetaten**, og logg inn i ID-porten (test)
   med en testperson fra Tenor som har tilgangspakken «Merverdiavgift» for organisasjonen i TT02
   (f.eks. daglig leder).
6. **Produksjon.** Gjenta punkt 1–4 i produksjonsmiljøet med en egen integrasjon og nøkkel
   (`MILJO=prod`), og sett `MVA_INNSENDING` til `true` i miljøet `produksjon` når det skal på.
   Adressene følger `SKATTEETATEN_MILJO` (testflaten bruker alltid testmiljøene); de kan overstyres
   med `IDPORTEN_URL`, `MVA_VALIDERING_URL` og `MVA_APP_URL`.

## Kilder

- Skatteetaten, mva-meldingen (innsending, validering, konvolutten og tilbakemeldingen):
  <https://skatteetaten.github.io/api-dokumentasjon/api/mvameldinginnsending> og
  <https://skatteetaten.github.io/api-dokumentasjon/api/mvameldingvalidering>
- Skatteetaten, informasjonsmodellen, XSD-ene og kodelistene (Apache License 2.0):
  <https://github.com/Skatteetaten/mva-meldingen>
- Digdir, ID-porten (autorisasjonskode med PKCE, tokenbyttet og ID-tokenet):
  <https://docs.digdir.no/docs/idporten/oidc/oidc_protocol_authorize> og
  <https://docs.digdir.no/docs/idporten/oidc/oidc_protocol_token>
- Altinn, tokenbyttet fra ID-porten:
  <https://docs.altinn.studio/nb/authentication/what-do-you-get/>
