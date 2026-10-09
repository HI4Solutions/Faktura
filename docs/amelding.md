# A-meldingen – oppsett og bruk

Appen lager a-meldingen for hver måned fra de godkjente lønnskjøringene og de ansatte (format 2.3).
Den kan alltid lastes ned som fil (XML) og lastes opp på skatteetaten.no. Når leverandøren av
løsningen, Medinnova AS (org.nr. 936 564 046), har fått tilgang til Skatteetatens API for
a-meldingen, kan appen også sende den selv og hente tilbakemeldingen.

Innsendingen fra appen er av til GitHub-variabelen `AMELDING_INNSENDING` er satt til `true`.

## Slik virker det

1. **Grunnlaget.** Lønnen er med i måneden den er utbetalt (de godkjente lønnskjøringene med
   utbetalingsdato i måneden), og alle som er ansatt i måneden er med med arbeidsforholdet, også
   uten lønn. A-meldingen skal leveres hver måned så lenge noen er ansatt, innen den 5. i måneden
   etter (neste virkedag).
2. **Kontrollen.** Under Lønn → A-melding ser eier, administrator og regnskap månedene i året med
   fristen og hva som er levert. For en måned viser appen lønnen, forskuddstrekket per
   utbetalingsdato, arbeidsgiveravgiften og inntektsmottakerne, og det som mangler: fødselsnummer,
   yrkeskode, virksomheten (underenheten) og pensjonsleverandøren når det er OTP stopper meldingen;
   lønnskjøringer som står som utkast, sluttdato uten årsak og permisjon over 14 dager er advarsler.
3. **Fila.** Eier eller administrator trykker «Lag fil (XML)» (med totrinnsbekreftelse, fila har
   fødselsnumrene). Workeren lager fila (bare workeren kan lese fødselsnumrene), og den lastes ned
   og lastes opp på skatteetaten.no. Merk den som lastet opp etterpå: da erstatter en ny melding for
   måneden den (en rettet a-melding med `erstatterMeldingsId`).
4. **Innsendingen** (når den er slått på og kunden har gitt tilgang): «Send til Skatteetaten».
   Workeren sender meldingen til API-et, og henter tilbakemeldingen fra Dialogporten og Skatteetaten
   (første gang etter to minutter, så sjeldnere, og minst hver halvtime i en uke). Status og avvik
   vises på måneden, og eier og administrator får varsel når den er mottatt eller avvist.

Det som ikke er med ennå: permisjoner (de over 14 dager meldes i Altinn), utleggstrekk,
finansskatt på lønn, inntektsmottakere uten norsk fødselsnummer eller D-nummer, og mer enn én
virksomhet per organisasjon.

Koden: `server/src/amelding.ts` (grunnlaget, kontrollen og meldingen som JSON og XML),
`server/src/ameldingInnsending.ts` (workeren: fila, innsendingen og tilbakemeldingen),
`server/src/ameldingRuter.ts` (API-et), `web/src/sider/LonnAmelding.tsx` og
`db/migrations/0077_amelding.sql`. Testene validerer XML-en mot skjemaet
(`server/test/xsd/amelding_v2_3.xsd`).

## Hos kunden

1. **Innstillinger → Ansatte og timer → A-melding:** organisasjonsnummeret til virksomheten
   (underenheten i Enhetsregisteret; appen foreslår den når det bare er én) og til
   pensjonsleverandøren når de har OTP.
2. **På hver ansatt** (Arbeidsforhold i a-meldingen): yrkeskoden (7 siffer, SSBs yrkeskoder
   basert på STYRK-08), arbeidstidsordningen og typen arbeidsforhold (standard: ordinært, ikke
   skift), og årsaken når den ansatte slutter. Datoene for siste lønnsendring og endring i
   stillingsprosent settes av seg selv når lønnen eller stillingsprosenten endres.
3. **Hver måned:** godkjenn lønnskjøringen, åpne måneden under Lønn → A-melding, rett det som
   mangler, og lag fila eller send den.
4. **Tilgang for innsending fra appen** (når den er slått på): kunder som allerede har koblet til
   Skatteetaten for skattekortene, trykker «Utvid tilgangen i Altinn» under Innstillinger → Ansatte
   og timer, og daglig leder godkjenner tilgangspakken «A-ordningen» i Altinn. Nye kunder får den
   med en gang de kobler til.

## Oppsett hos Medinnova (din del)

Gjør det først i testmiljøet (Maskinporten-test, Altinn TT02 og Skatteetatens testmiljø), og
deretter i produksjon. Maskinporten-klienten og systemet i Altinn er de samme som for
skattekortene (se `docs/skattekort.md`); de må være satt opp først.

1. **Søk om tilgang til API-et hos Skatteetaten** for Medinnova AS (scopet
   `skatteetaten:innrapporteringamelding`, testmiljøet først). Søknaden står på Skatteetatens sider
   for sluttbrukersystemer (lenkene under).
2. **Scopene på Maskinporten-klienten.** Når Skatteetaten har gitt tilgang, legg disse til på
   integrasjonen i Samarbeidsportalen (samme klient og nøkkel som for skattekortene):
   - `skatteetaten:innrapporteringamelding` (innsending og tilbakemelding);
   - `digdir:dialogporten` (tilbakemeldingen ligger i Dialogporten).
3. **GitHub-variabelen** (Settings → Secrets and variables → Actions → Variables):
   `AMELDING_INNSENDING` = `true`. Kjør så workflowen «Infrastruktur» (Actions → Infrastruktur →
   Run workflow). Adressen til API-et følger `SKATTEETATEN_MILJO`; den kan overstyres med
   `AMELDING_URL`.
4. **Systemet i Altinn.** Administrasjon → Drift → «Skattekort (Skatteetaten)» → «Oppdater i
   Altinn». Systemet ber da om tilgangspakkene «Lønn» og «A-ordningen»
   (`urn:altinn:accesspackage:a-ordning`; «Lønn» alene godtas ikke for a-meldingen).
5. **Test.** En testorganisasjon i TT02 (fra Tenor testdatasøk) kobler til eller trykker «Utvid
   tilgangen i Altinn», og daglig leder godkjenner i Altinn TT02. Legg inn testpersoner fra Tenor
   som ansatte, godkjenn en lønnskjøring, og send a-meldingen for måneden. Tilbakemeldingen vises
   på måneden. Fila kan også prøves i testløsningen for opplasting.
6. **Produksjon.** Skatteetaten gir tilgang i produksjon etter testen. Legg scopene på
   produksjonsklienten og sett `SKATTEETATEN_MILJO` til `prod` (om det ikke er gjort for
   skattekortene), og gjenta punkt 3–4.

Hemmeligheter (nøkkelen til Maskinporten) legges bare i Secret Manager fra Cloud Shell, som
beskrevet i `docs/skattekort.md`; de skal aldri sendes på e-post, i chat eller som skjermbilde.

## Kilder

- Skatteetaten, a-meldingen for sluttbrukersystemer:
  <https://www.skatteetaten.no/samarbeidspartnere/sluttbrukersystemer/a-meldingen-sbs/>
- Skatteetaten, API for innrapportering av a-meldingen:
  <https://skatteetaten.github.io/api-dokumentasjon/api/innrapportering-amelding>
- Skatteetaten, systembruker: <https://skatteetaten.github.io/api-dokumentasjon/om/systembruker>
- Informasjonsmodellen for a-meldingen 2.3:
  <https://github.com/Skatteetaten/api-dokumentasjon/blob/main/static/download/a-melding/Informasjonsmodell_A-meldingen_V2_3.pdf>
- Altinn, systembruker for systemleverandører:
  <https://docs.altinn.studio/nb/authorization/guides/system-vendor/system-user/>
- Tenor testdatasøk: <https://www.skatteetaten.no/testdata/>
