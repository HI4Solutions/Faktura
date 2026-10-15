# Krav, betalinger og frister fra Skatteetaten

Fanen «Skatteetaten» under Regnskap viser det organisasjonen skylder Skatteetaten, og fristene
den har der:

- **Summene:** forfalt (med stipulerte renter), det som forfaller senere, og saldoen hos
  Skatteetaten (med innbetalinger som ikke er plassert mot et krav ennå).
- **Fristene** for mva-meldingen og skattemeldingen det neste året (Skatteetatens Frister API).
- **De åpne kravene** (skatt og avgifter) med hvert forfall som ikke er betalt, det som
  gjenstår, og betalingsinformasjonen: kontonummer og KID (kan kopieres til nettbanken), og IBAN
  og BIC for betaling fra utlandet.
- **Innbetalingene og utbetalingene** det siste året (Skatteetaten gir høyst ett år om gangen).

Det som er forfalt, det som forfaller de neste to ukene og fristene de neste to ukene, står også
under «Til oppfølging» på Oversikt. Rapportene «Krav fra Skatteetaten», «Frister hos
Skatteetaten» og «Betalinger med Skatteetaten» står under Rapporter → Regnskap, og
regnskapsføreren kan få dem hver måned.

Krav og frister hentes hver morgen fra kl. 06, med en gang tilgangen er godkjent, og når noen
trykker «Hent nå» (høyst én gang i minuttet). Eier, administrator og regnskap ser fanen (og en
egen rolle med Regnskap).

Hentingen er av til GitHub-variabelen `KRAV_OG_FRISTER` er satt til `true`. Til da sier fanen
at funksjonen ikke er slått på, og rapportene vises ikke.

## Slik virker det

Workeren henter med systembrukeren organisasjonen har gitt Admin Konsoll i Altinn (samme system
som skattekortene, `docs/skattekort.md`), med tilgangspakken **«Krav, betalinger og utlegg»**
(`urn:altinn:accesspackage:krav-og-utlegg`). Skatteetaten krever rettighetspakken
`regnskapssystem`, som gjelder systembrukere med en av tilgangspakkene ansvarlig-revisor,
krav-og-utlegg, regnskapsforer-med-signeringsrettighet, regnskapsforer-uten-signeringsrettighet
eller revisormedarbeider; systemet ber om krav-og-utlegg.

- **Krav og betalinger** (scopet `skatteetaten:kravogbetalinger`): Åpne krav, Innbetalinger og
  Utbetalinger for virksomheten.
- **Frister** (scopet `skatteetaten:frister`).

Hver del har sitt eget token og lagres for seg, så den ene virker selv om den andre ikke gjør
det (f.eks. når bare det ene scopet er lagt på klienten). Svarene tolkes til det appen viser og
lagres i `skatteetaten_krav`; det rå svaret lagres ikke. Ingen krav, betalinger eller frister
(KB-007, KB-009, FRI-007) er et tomt svar, ikke en feil. Feil som kan gå over (ingen svar, 5xx),
prøves igjen av Cloud Tasks; feilen fra siste forsøk vises i fanen.

Skatteetaten gir bare tilgang når leverandøren er integrert mot minst ett API for
innrapportering, og kunden har rapportert gjennom systemet minst én gang (f.eks. a-meldingen fra
Admin Konsoll). Opplysningene kan bare brukes til å vise dem for kunden.

**Adressene.** Rettighetspakken står i adressen, som i eksemplene Skatteetaten hadde i
dokumentasjonen: `…/api/innkreving/kravogbetalinger/v1/regnskapssystem/{organisasjonsnummer}/aapnekrav`
(og `/innbetalinger` og `/utbetalinger` med `fraOgMed` og `tilOgMed`), og
`…/api/innkreving/frister/v1/regnskapssystem/{organisasjonsnummer}` for fristene. Vertene er
`api-test.sits.no` (test) og `api.skatteetaten.no` (produksjon), etter `SKATTEETATEN_MILJO`. Den
nøyaktige adressen står i OpenAPI-spesifikasjonene på SwaggerHub (`krav-og-betalinger-api` og
`frister-api`). Svarer Skatteetaten KB-003 eller FRI-003 (ukjent adresse), sier fanen fra, og
adressen rettes i `ADRESSER` i `server/src/maskinporten.ts` (testene kan overstyre den med
`KRAV_OG_BETALINGER_URL` og `FRISTER_URL`).

Koden: `server/src/skatteetatenKrav.ts` (hentingen og tolkingen), `server/src/skatteetatenRuter.ts`
(API-et), `server/src/skatteetatenRapporter.ts` (rapportene), `web/src/sider/RegnskapSkatteetaten.tsx`
og `db/migrations/0112_skatteetaten_krav.sql`.

## Hos kunden

1. **Koblet til Skatteetaten** under Innstillinger → Lønn → Skattekort (som for skattekortene).
2. **Tilgang i Altinn.** Kunder som allerede er koblet til, trykker «Utvid tilgangen i Altinn»
   under Innstillinger → Lønn → Skattekort, og daglig leder godkjenner tilgangspakken «Krav,
   betalinger og utlegg» i Altinn. Nye kunder får den med en gang de kobler til.
3. **Rapportert minst én gang** gjennom Admin Konsoll (f.eks. a-meldingen), som Skatteetaten
   krever.

## Oppsett hos Medinnova (din del)

Gjør det først i testmiljøet, og deretter i produksjon. Maskinporten-klienten og systemet i
Altinn er de samme som for skattekortene.

1. **Tilgangen hos Skatteetaten.** Skatteetaten må ha gitt Medinnova AS rettighetspakken
   `regnskapssystem` for Krav og betalinger API og Frister API (søknadene er godkjent). Test er
   foreløpig bare åpent for leverandørene Skatteetaten har avtale med (piloten).
2. **Scopene på Maskinporten-klienten.** Legg til `skatteetaten:kravogbetalinger` og
   `skatteetaten:frister` på integrasjonen i Samarbeidsportalen (samme klient og nøkkel som for
   skattekortene).
3. **GitHub-variabelen** (Settings → Secrets and variables → Actions → Variables):
   `KRAV_OG_FRISTER` = `true`. Kjør så workflowen «Infrastruktur» (Actions → Infrastruktur → Run
   workflow).
4. **Systemet i Altinn.** Plattform → Drift → «Skattekort (Skatteetaten)» → «Oppdater i
   Altinn». Systemet ber da også om tilgangspakken «Krav, betalinger og utlegg». (Trykker en kunde
   «Utvid tilgangen i Altinn» før det, oppdaterer workeren systemet selv.)
5. **Test.** La testorganisasjonen utvide tilgangen i appen, og trykk «Hent nå» under Regnskap →
   Skatteetaten. Testdata for krav og betalinger finnes i Tenor (søket «Krav og betalinger»);
   Frister har ikke eget søk i Tenor.
