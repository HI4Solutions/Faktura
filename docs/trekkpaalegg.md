# Trekkpålegg fra Skatteetaten

Skatteetaten sender pålegg om utleggstrekk i lønn til arbeidsgiveren (den trekkpliktige) gjennom
API-et for trekkpålegg. Admin Konsoll henter påleggene og trekker dem i lønnen:

- **Fanen «Trekkpålegg» under Lønn** viser påleggene: hvem det gjelder, trekket som gjelder nå og
  den neste endringen, saken, KID-en og kontonummeret, det som er trukket (i år og i alt),
  periodene og merknadene. Avsluttede pålegg står for seg.
- **Et pålegg for en ansatt blir et fast trekk** (samordnet utleggstrekk) på den ansatte. Det står
  under Ansatte → Lønn → Faste trekk med merket «Fra Skatteetaten», og kan ikke endres eller
  fjernes der; det endres bare når Skatteetaten sender en ny versjon.
- **Lønnskjøringen trekker det som gjelder på utbetalingsdatoen**, betaler det til Skatteetaten
  med KID-en i pålegget første virkedag etter lønnsdagen (betalingsfila), fører det på kontoen for
  påleggstrekk (2610) i lønnsbilaget, og melder det i a-meldingen (`utleggstrekkSamordnet`).
- **Varsler:** Nye, endrede og avsluttede pålegg gir varsel til eier, administrator og dem som har
  Lønn (varseltypen «Trekkpålegg fra Skatteetaten»).
- **Rapporten «Trekkpålegg fra Skatteetaten»** står under Rapporter → Lønn, og regnskapsføreren kan
  få den hver måned.

Påleggene hentes hver morgen fra kl. 06, med en gang tilgangen er gitt, og når noen trykker «Hent
nå» (høyst én gang i minuttet). De som ser lønnen, ser fanen.

Hentingen er av til bryteren `TREKKPAALEGG` er på. Den er på i testmiljøet
(`infra/terraform/miljo/test.tfvars`); i produksjon settes GitHub-variabelen `TREKKPAALEGG` til
`true` når Skatteetaten har gitt scopet der. Til da sier fanen at funksjonen ikke er slått på, og
rapporten vises ikke.

## Slik virker det

### Hentingen

Workeren henter med systembrukeren organisasjonen har gitt Admin Konsoll i Altinn (samme system som
skattekortene, [skattekort.md](skattekort.md)), med scopet `skatteetaten:trekkpaalegg`.
Skatteetaten krever at forespørselen om systembruker har **ressursen «Informasjon om trekkpålegg»**
(`ske-informasjon-om-trekkpaalegg`). Den er en enkeltrettighet, ikke en tilgangspakke:

- I appen står den i samme liste som tilgangspakkene, som `urn:altinn:resource:ske-informasjon-om-trekkpaalegg`
  (`TREKKPAALEGG_RESSURS` i `server/src/altinn.ts`).
- Altinn får den som `rights` i systemregisteret og i forespørselen, og som `requiredRights` i
  endringsforespørselen («Utvid tilgangen i Altinn»).

Kallet er `GET /api/trekkpaalegg/v1` uten parametre. Det gir siste versjon av alle påleggene der
organisasjonen er trekkpliktig. Før Skatteetaten har lagt inn pålegg, er svaret en tom liste (200).
`fraSekvensnummer` og `maksAntall` brukes ikke; de er for arbeidsgivere med flere tusen pålegg.

- **Adressene:** `https://api-test.sits.no/api/trekkpaalegg/v1` (test) og
  `https://api.skatteetaten.no/api/trekkpaalegg/v1` (produksjon). De følger `SKATTEETATEN_MILJO`,
  og testene kan overstyre dem med `TREKKPAALEGG_URL`.
- **Ingen pålegg** (204, KB-007 eller KB-009) er et tomt svar, ikke en feil.
- **403** betyr at ressursen ikke er godkjent i Altinn. Feilen lagres og vises i fanen, og
  oppgaven prøves ikke igjen.
- **Ukjent adresse** (KB-003 eller en vanlig 404-side): fanen sier fra, og adressen rettes i
  `ADRESSER` i `server/src/maskinporten.ts`.
- **Feil som kan gå over** (ingen svar, 5xx) prøves igjen av Cloud Tasks. Feilen fra siste forsøk
  vises i fanen, med Skatteetatens kode og korrelasjons-ID.

### Lagringen

Hvert pålegg lagres med siste versjon (én rad per trekk-ID i `trekkpaalegg`). Et pålegg som alt er
lagret med samme eller en nyere versjon (sekvensnummeret), endres ikke. Endringene står i
revisjonsloggen.

- **Skyldneren** (fødselsnummeret i pålegget) kobles til den ansatte med det fødselsnummeret. Bare
  workeren dekrypterer fødselsnumrene. Fødselsnummeret lagres ikke, bare fødselsdatoen. Da kan et
  pålegg for en som ikke er registrert, kjennes igjen.
- **Skyldneren er ikke registrert:** pålegget får en merknad, og trekkes ikke før fødselsnummeret er
  lagt inn på den ansatte. Neste henting kobler det.
- **Andre merknader:** den ansatte er ikke aktiv, kontonummeret i pålegget er ugyldig, eller den
  ansatte har et samordnet utleggstrekk som er lagt inn for hånd med en annen KID. Det kan være det
  samme pålegget, og da skal trekket for hånd avsluttes.
- **Et trekk lagt inn for hånd med samme KID** kobles til pålegget i stedet for at det lages et nytt
  (det som er trukket, følger med).

### Trekket i lønnen

Trekket fra pålegget har ikke beløp eller prosent selv. Størrelsen står i pålegget, som perioder med
et beløp eller en prosent (`server/src/lonnstrekk.ts`):

- **Perioden som gjelder på utbetalingsdatoen** trekkes, ikke alle periodene i lønnsmåneden.
  Skatteetaten: «Trekkpliktig skal trekke det som står i den perioden som gjelder
  lønnsutbetalingsdatoen.» Endres trekket 9. august, trekker lønnen 20. august bare det nye.
- **En prosent** trekkes av bruttolønnen ved hver utbetaling, også i en ekstra kjøring.
- **Et beløp** trekkes én gang i måneden: det som ikke alt er trukket i en annen godkjent kjøring
  med utbetaling i samme måned. Den ordinære kjøringen trekker det. En ekstra kjøring tar det den
  ordinære ikke rakk, når den ordinære i måneden er godkjent.
- **0 kr eller 0 %**, en sluttdato før startdatoen (avsluttet før det startet), eller en
  utbetalingsdato utenfor periodene: ikke noe trekk.
- **Som de andre faste trekkene:** Trekket kommer etter forskuddstrekket, i rekkefølgen
  dekningsloven gir (bidrag før utlegg). Det er i hele kroner, og aldri mer enn det som er igjen av
  nettolønnen; slippen har en merknad når det blir mindre.
- **Et nytt eller endret pålegg** gjør utkastene til lønnskjøring utdatert, så de regnes ut på nytt.

### Koden

- `server/src/trekkpaalegg.ts`: hentingen, tolkingen, koblingen og varslene.
- `server/src/trekkpaaleggRuter.ts`: API-et.
- `server/src/trekkpaaleggRapporter.ts`: rapporten.
- `server/src/lonnstrekk.ts` og `server/src/lonn.ts`: trekket i lønnen.
- `web/src/sider/LonnTrekkpaalegg.tsx` og `web/src/sider/LonnsTrekk.tsx`: appen.
- `db/migrations/0127_trekkpaalegg.sql`: databasen, med `faktura.koble_trekkpaalegg`.
- Testene: `server/test/trekkpaalegg.test.ts` og `db/tests/86_trekkpaalegg.sql`.

## Hos kunden

1. **Koblet til Skatteetaten** under Lønn → Skattekort (som for skattekortene).
2. **Tilgang i Altinn.** Kunder som allerede er koblet til, trykker «Utvid tilgangen i Altinn» under
   Lønn → Skattekort. Daglig leder godkjenner da «Informasjon om trekkpålegg» i Altinn. Nye kunder
   får den med en gang de kobler til.
3. **Fødselsnummeret på de ansatte**, så påleggene kan kobles til dem.

## Oppsett og test hos Medinnova (din del)

Skatteetaten ga Medinnova AS scopet `skatteetaten:trekkpaalegg` i testmiljøet 20.10.2026. Testen
følger fanen «Test» i Skatteetatens dokumentasjon. Testbedriften er EKSTRA NESTE TIGER AS (org.nr.
313 516 504), med den syntetiske daglige lederen 18838398177 (TestID); se
[miljoer.md](miljoer.md), «Testbedriften».

1. **Scopet på testklienten.** Legg `skatteetaten:trekkpaalegg` på Maskinporten-integrasjonen i
   Samarbeidsportalen for test (<https://sjolvbetjening.test.samarbeid.digdir.no>). Det er samme
   klient og nøkkel som for skattekortene.
2. **Utrullingen.** Bryteren er på i `test.tfvars`; Infrastruktur og Utrulling kjører til
   testflaten når koden er på main.
3. **Systemet i Altinn.** På testflaten: Plattform → Drift → «Skattekort (Skatteetaten)» →
   «Oppdater i Altinn». Systemet ber da også om ressursen «Informasjon om trekkpålegg».
4. **Tilgangen hos testbedriften.** I EKSTRA NESTE TIGER AS: Lønn → Skattekort → «Utvid tilgangen
   i Altinn». Logg inn i Altinn TT02 med TestID som 18838398177, og godkjenn.
5. **Nå tjenesten (Skatteetatens steg 1).** Lønn → Trekkpålegg → «Hent nå». Fanen skal si at
   påleggene er hentet, og at Skatteetaten ga 0 pålegg (svaret 200 med en tom liste).
6. **Be om testdata (Skatteetatens steg 2).** Send en e-post til
   fremtidensinnkreving@skatteetaten.no:
   - at integrasjonen når tjenesten i test;
   - organisasjonsnummeret 313516504;
   - fødselsnumrene til de syntetiske ansatte trekkpåleggene skal gjelde.

   Bruk bare syntetiske personer (fra Tenor). Skatteetaten kan legge inn pålegg for flere personer
   på samme organisasjonsnummer.
7. **Test påleggene** når de er lagt inn (se testplanen under), og skriv oppsummeringen.
8. **Produksjon.** Be Skatteetaten om produksjons-scopet på samme adresse, og signer avtalen som
   kommer i retur. Legg så scopet på produksjonsklienten, sett GitHub-variabelen `TREKKPAALEGG` til
   `true` i miljøet for produksjon, og kjør Infrastruktur. Trykk «Oppdater i Altinn» i produksjon.
   Til slutt gjør du en teknisk verifikasjon (steg 5 i produksjon).

Skatteetaten gir ikke tilgang til produksjon før testen er oppsummert.

### Testplan og oppsummering

Skatteetaten vil ha en oppsummering etter testen: hva som er testet, status, og feil og mangler.
Fyll inn resultatet for hvert punkt.

| # | Test | Forventet | Resultat |
|---|---|---|---|
| 1 | Token fra Maskinporten med `skatteetaten:trekkpaalegg` for systembrukeren til 313516504 | Token utstedt | |
| 2 | Kall uten testdata | 200 og en tom liste; fanen sier 0 pålegg | |
| 3 | Nye pålegg (prosent og beløp) | Lagret, koblet til de ansatte, varsel «Nytt trekkpålegg» | |
| 4 | Pålegg for en som ikke er registrert | Merknad med fødselsdatoen; koblet når fødselsnummeret er lagt inn | |
| 5 | Lønnskjøring: trekket som gjelder på utbetalingsdatoen | Riktig beløp eller prosent i hele kroner, KID og konto i betalingsfila, utleggstrekk i a-meldingen | |
| 6 | Ny versjon (endret størrelse fra en dato) | Varsel «Endret trekkpålegg»; lønnen bruker perioden som gjelder | |
| 7 | Avsluttet pålegg | Varsel «Trekkpålegg avsluttet»; ikke trukket etter sluttdatoen | |
| 8 | Samme versjon hentet igjen | Ingen endring og ingen nye varsler | |
| 9 | Feil (tilgangen trukket i Altinn, 403) | Feilen vises i fanen; prøves ikke igjen | |

De samme tilfellene, med Skatteetatens eksempler, er automatiske tester i
`server/test/trekkpaalegg.test.ts`.

## Kilder

- Skatteetatens API-dokumentasjon for trekkpålegg (Om tjenesten, Eksempler, Feilkoder,
  Informasjonsmodell, Test, Sjekkliste): <https://skatteetaten.github.io/api-dokumentasjon/api/trekkpaalegg>
- OpenAPI-spesifikasjonen: <https://app.swaggerhub.com/apis/skatteetaten/trekkpaalegg-app>
- Altinn, forespørsel om systembruker med enkeltrettigheter (`rights`):
  <https://docs.altinn.studio/nb/authorization/guides/system-vendor/system-user/systemuserrequest/>
