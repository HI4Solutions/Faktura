# A-meldingen – oppsett og bruk

Appen lager a-meldingen for hver måned fra de godkjente lønnskjøringene og de ansatte (format 2.3).
Den kan alltid lastes ned som fil (XML) og lastes opp på skatteetaten.no. Når leverandøren av
løsningen, Medinnova AS (org.nr. 936 564 046), har fått tilgang til Skatteetatens API for
a-meldingen, kan appen også sende den selv og hente tilbakemeldingen.

Innsendingen fra appen er av til GitHub-variabelen `AMELDING_INNSENDING` er satt til `true`.

## Slik virker det

1. **Grunnlaget.** Lønnen er med i måneden den er utbetalt (de godkjente lønnskjøringene med
   utbetalingsdato i måneden), og alle som er ansatt i måneden er med med arbeidsforholdet, også
   uten lønn. Frilansere, oppdragstakere og styremedlemmer (arbeidsforholdet «frilanser,
   oppdragstaker eller honorar») er bare med de månedene de får honorar. A-meldingen skal leveres
   hver måned så lenge noen er ansatt, innen den 5. i måneden etter (neste virkedag).
2. **Kontrollen.** Under Lønn → A-melding ser eier, administrator og regnskap månedene i året med
   fristen og hva som er levert. For en måned viser appen lønnen, forskuddstrekket per
   utbetalingsdato, arbeidsgiveravgiften og inntektsmottakerne, og det som mangler: fødselsnummer,
   yrkeskode, virksomheten (underenheten) og pensjonsleverandøren når det er OTP stopper meldingen;
   og en permisjon over 14 dager uten valgt art stopper meldingen; lønnskjøringer som står som utkast,
   sluttdato uten årsak, en permisjon som slutter i måneden uten bekreftet sluttdato, en ansatt
   som er med i OTP uten å være meldt inn hos pensjonsleverandøren (eller slutter uten å være meldt
   ut), AFP-premien for forrige kvartal som ikke er registrert som betalt (andre og tredje måned i
   kvartalet), og minst 10 permitteringer som begynner i måneden (melding til NAV) er advarsler.
   Arten for en permisjon som mangler den, kan velges rett fra avviket. AFP-premien som er betalt i
   måneden (Lønn → AFP), er med i arbeidsgiveravgiften som tilskudd og premie til pensjon, også når
   det ikke er lønn i måneden. Lønn og feriepenger som er utbetalt etter at den ansatte døde, er
   «lønn etter dødsfall» (uten forskuddstrekk og arbeidsgiveravgift), og arbeidsforholdet slutter
   på dødsdatoen med sluttårsaken «arbeidstaker har sagt opp selv».
3. **Fila.** Eier eller administrator trykker «Lag fil (XML)» (med totrinnsbekreftelse, fila har
   fødselsnumrene). Workeren lager fila (bare workeren kan lese fødselsnumrene), og den lastes ned
   og lastes opp på skatteetaten.no. Merk den som lastet opp etterpå: da erstatter en ny melding for
   måneden den (en rettet a-melding med `erstatterMeldingsId`).
4. **Innsendingen** (når den er slått på og kunden har gitt tilgang): «Send til Skatteetaten».
   Workeren sender meldingen til API-et, og henter tilbakemeldingen fra Dialogporten og Skatteetaten
   (første gang etter to minutter, så sjeldnere, og minst hver halvtime i en uke). Status og avvik
   vises på måneden, og eier og administrator får varsel når den er mottatt eller avvist.

Det som ikke er med ennå: finansskatt på lønn, inntektsmottakere uten norsk fødselsnummer eller
D-nummer, og mer enn én virksomhet per organisasjon.

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
   skift), og årsaken når den ansatte slutter. Stillingsprosenten og datoene for siste
   lønnsendring og endring i stillingsprosent kommer fra lønnshistorikken på den ansatte (det som
   gjelder ved utgangen av måneden); endres lønnen eller stillingen, velger du datoen den gjelder
   fra. Etterbetaling eller trekk for en tidligere måned får opptjeningsperioden i meldingen.
   Faste trekk (på den ansatte): fagforeningskontingenten blir fradrag, utleggstrekkene til
   Skatteetaten (samordnet og for skattekrav) blir utleggstrekk med datoen for trekket og summen i
   betalingsinformasjonen, og forskuddstrekket har beskrivelsen «ordinaert». Bidragstrekk og andre
   utleggstrekk rapporteres ikke.
   Naturalytelser (på den ansatte) rapporteres med fordelen naturalytelse (trekk- og
   avgiftspliktig), fri bil med listeprisen og registreringsnummeret (eller bilpool) i
   tilleggsinformasjonen. Reisene (godkjente reiseregninger) rapporteres som utgiftsgodtgjørelse:
   kost, nattillegg og kilometergodtgjørelse innenfor de trekkfrie satsene med antall døgn,
   dager, netter eller km (uten trekk og avgift), og det som er over (reiseKost, reiseAnnet,
   kilometergodtgjoerelseBil) med trekk og avgift. Utlegg etter regning rapporteres ikke.
   Permisjon og permittering (på fraværet, med arten): permisjon over 14 dager (med eller uten
   lønn, hel eller delvis) og all permittering rapporteres som permisjon på arbeidsforholdet hver
   måned den varer, med startdatoen, prosenten, id-en (den samme hver måned), beskrivelsen etter
   arten og sluttdatoen når den er kjent (ellers i måneden permisjonen står til å slutte).
   Permitteringen har beskrivelsen «permittering»; de nye opplysningene om permittering i format
   2.3 (varslingsdato, lønnsplikt og årsak) og `loennet` på permisjonen er utsatt av Skatteetaten
   og sendes ikke.
   Frilansere, oppdragstakere og styremedlemmer: honoraret rapporteres som «honorar, akkord-,
   prosent- eller provisjonslønn» (`honorarAkkordProsentProvisjon`) eller «styrehonorar og
   godtgjørelse i forbindelse med verv» (`styrehonorarOgGodtgjoerelseVerv`), etter valget på den
   ansatte, med trekk og avgift. Arbeidsforholdet har startdatoen for oppdraget, yrket (som må
   oppgis også for dem) og sluttdatoen, men ikke ansettelsesform, arbeidstid, stillingsprosent,
   sluttårsak eller permisjon.
3. **Hver måned:** godkjenn lønnskjøringen, åpne måneden under Lønn → A-melding, rett det som
   mangler, og lag fila eller send den. Endres lønnen for måneden etter at a-meldingen er levert
   (en kjøring åpnes igjen, eller en ekstra kjøring), merkes måneden «Lønnen er endret»: lag en ny
   a-melding, som erstatter den forrige. Rapportene «Avstemming per termin» og «Årsavstemming»
   (Rapporter → Lønn) sammenligner lønnskjøringene, a-meldingene som er levert, og bokføringen.
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
- Skatteetaten, lønn etter dødsfall:
  <https://www.skatteetaten.no/bedrift-og-organisasjon/arbeidsgiver/a-meldingen/veiledning/lonn-og-ytelser/oversikt-over-lonn-og-andre-ytelser/lonn-etter-dodsfall>
