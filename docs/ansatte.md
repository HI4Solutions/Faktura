# Legge inn ansatte

Det finnes tre måter å legge inn ansatte på, ved siden av import fra fil (Importer) og
«Fyll ut fra lønnsslipp» (AI):

1. **Hent fra a-ordningen.** Passer for bedrifter som har hatt ansatte før og har sendt
   a-meldinger fra et annet system. Ansatte → «Hent fra a-ordningen».
2. **Den ansatte fyller ut selv.** Passer for nye bedrifter, og når lederen vil la den ansatte
   gjøre jobben. Den ansatte får invitasjon på e-post, logger inn og fyller ut fødselsnummer,
   kontonummer, adresse og nærmeste pårørende under Min side. Lederen godkjenner.
3. **Ny ansatt i tre steg.** «Ny ansatt» åpner et kort skjema: hvem (og hvem som fyller ut
   resten), ansettelsen (med søk etter yrkeskode) og lønnen. Hele ansattkortet er der som før.

I lista og i ansattkortet står det hva som mangler før lønnen og a-meldingen kan kjøres
(«Mangler»: fødselsnummer, kontonummer, lønn, og med Lønn også skattekort og yrkeskode). Trykk på
det som mangler, så hopper skjemaet dit. Oversikten sier hvem som venter på godkjenning, og hvem
som mangler noe.

## Hent fra a-ordningen

Workeren henter avstemmingsrapporten for a-meldingen fra Skatteetaten (Avstemmingsrapport
A-melding API, som erstatter A06/A07) for de tre siste kalendermånedene: det a-meldingene sier
om hver person (arbeidsforholdet: startdato, sluttdato, stillingsprosent, yrkeskode,
arbeidstidsordning, arbeidsforholdID, og fastlønnen eller timelønnen fra siste måned).

Lederen ser lista og velger:

- **Ny:** legges inn med fødselsnummeret (kryptert), arbeidsforholdet og lønnen. Står det ikke
  navn i rapporten, skriver lederen navnet. De som har sluttet, er ikke valgt; velges de, legges
  de inn som sluttet.
- **Finnes:** samme fødselsnummer som en i registeret. Arbeidsforholdet skrives slik det er
  rapportert, og lønnen bare når den ansatte ikke har noen.
- **Samme navn:** en i registeret uten fødselsnummer med samme navn (og samme fødselsdato, om den
  er registrert). Velges den, kobles personen til den ansatte, som får fødselsnummeret.

**ArbeidsforholdID-en** fra det forrige lønnssystemet tas vare på (`ansatte.arbeidsforhold_id`;
den kan også føres i ansattkortet). A-meldingen fra Admin Konsoll bruker den i stedet for
ansattnummeret, så arbeidsforholdet fortsetter. Ellers måtte det gamle arbeidsforholdet avsluttes
(årsak «byttet lønnssystem») og et nytt startes.

Hentingen bruker systembrukeren organisasjonen har gitt Admin Konsoll i Altinn, med
tilgangspakken **«A-ordningen»** og scopet `skatteetaten:innrapporteringamelding`. Dette er de
samme som for innsendingen av a-meldingen. Knappen virker derfor når `AMELDING_INNSENDING` er på
og organisasjonen er koblet til Skatteetaten med «A-ordningen» (ellers sier dialogen hva som
mangler, med lenke til Innstillinger → Lønn → Skattekort).

Bestillingen og hentingen tar gjerne et par minutter. Workeren spør hvert tredje sekund i halvannet
minutt, og deretter hvert minutt i opptil tjue minutter. Lederen får varsel når lista er klar.
Fødselsnumrene krypteres av workeren og lagres for seg (`aordning_import.fnr`, som API-et ikke
kan lese). De flyttes til den ansatte i databasen (`aordning_sett_fnr`) når lederen legger
personen inn.

**Adressen.** Skatteetaten har adressene og JSON-skjemaet bare i OpenAPI-spesifikasjonen på
SwaggerHub (`avstemmingsrapport-amelding-api`):

- Bestillingen sendes til `{adresse}/bestilling/{orgnr}` med `fraOgMedKalendermaaned` og
  `tilOgMedKalendermaaned`.
- Rapporten hentes fra adressen i svaret (Location, bare hos samme vert) eller med ID-en i svaret.
- Vertene er gjettet etter mønsteret til de andre a-meldingstjenestene:
  `avstemmingsrapportamelding.api.skatteetaten-test.no/v1` og `…api.skatteetaten.no/v1`.
  `AVSTEMMING_URL` overstyrer.
- Tolkingen finner feltene med navnene fra a-meldingen (`norskIdentifikator`, `arbeidsforhold`,
  `startdato`, `stillingsprosent`, `yrke`, `inntekt`/`loennsinntekt` …) der de står.

Svarer Skatteetaten at adressen er ukjent (404, AMLD_021/AMLD_1023), sier dialogen det. Da rettes
adressen i `ADRESSER` i `server/src/maskinporten.ts` og stiene i `server/src/aordning.ts` etter
spesifikasjonen.

## Den ansatte fyller ut selv

- Lederen ber om det i ansattkortet («Be om opplysninger», eller «Be … fylle ut selv» i
  Mangler-boksen), eller velger «Den ansatte fyller ut selv» i «Ny ansatt». Har den ansatte ikke
  innlogging, får den invitasjonen med beskjed om å fylle ut. Har den innlogging, får den e-post
  og varsel. `ansatte.utfylling_bedt` sier når det ble bedt om.
- Den ansatte ser oppgaven på oversikten, og skjemaet under Min side («Mine opplysninger»):
  navn, telefon, adresse, fødselsnummer (eller fødselsdato), kontonummer og nærmeste pårørende.
  Bare det som er nytt eller endret, sendes.
- Ingenting skrives på den ansatte før lederen godkjenner. Innsendingen ligger i
  `ansatt_utfylling`, med fødselsnummeret kryptert (API-et kan ikke lese det).
- Lederen får varsel og ser boksen øverst i ansattkortet, med det som står nå og det nye:
  - **Godkjenn:** opplysningene skrives på den ansatte (tomme felt endrer ingenting), og
    skattekortet hentes når fødselsnummeret er med.
  - **Avvis:** med en grunn den ansatte ser. Fødselsnummeret i innsendingen fjernes, og den
    ansatte retter og sender på nytt.

  Den ansatte får varsel i begge tilfeller.
- Den ansatte kan bare sende inn for seg selv og bare de tillatte feltene (databasen tar bort
  resten), og kan ikke godkjenne. Varseltypen er «Opplysninger fra de ansatte» (kan slås av under
  Varsler).

## Yrkeskode

Yrkeskoden søkes opp i SSBs yrkeskatalog (Klass, klassifikasjon 145; 7 siffer). Søk på yrket
eller skriv koden. En kode som ikke finnes i katalogen, gir en advarsel, fordi a-meldingen
avvises med den (MAGNET_EDAG-115B). Serveren henter katalogen fra data.ssb.no og husker den et
døgn (`GET /org/:org/ansatte/yrkeskoder?sok=…` og `?kode=…`).

## Koden

- `db/migrations/0113_ansatte_enklere.sql`: de nye feltene på den ansatte, `ansatt_utfylling`
  med funksjonene, og `aordning_import` med funksjonene.
- `server/src/ansattUtfylling.ts`, `server/src/aordning.ts` (tolkingen, workeren og API-et),
  `server/src/yrkeskoder.ts`.
- `web/src/sider/NyAnsatt.tsx`, `web/src/sider/AnsattUtfylling.tsx`, `web/src/sider/Aordning.tsx`,
  `web/src/sider/Yrkeskode.tsx`, `web/src/ansattMangler.ts`.
- Tester: `server/test/ansattUtfylling.test.ts`, `server/test/aordning.test.ts`,
  `server/test/yrkeskoder.test.ts` og `db/tests/76_ansatte_enklere.sql`.
