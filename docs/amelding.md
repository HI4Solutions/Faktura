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
   på dødsdatoen med sluttårsaken «arbeidstaker har sagt opp selv». Kildeskatt på lønn (utenlandske
   arbeidstakere) er ordinært forskuddstrekk med de vanlige beskrivelsene.
3. **Fila.** Eier eller administrator trykker «Lag fil (XML)» (med totrinnsbekreftelse, fila har
   fødselsnumrene). Workeren lager fila (bare workeren kan lese fødselsnumrene), og den lastes ned
   og lastes opp på skatteetaten.no. Merk den som lastet opp etterpå: da erstatter en ny melding for
   måneden den (en rettet a-melding med `erstatterMeldingsId`).
4. **Innsendingen** (når den er slått på og kunden har gitt tilgang): «Send til Skatteetaten».
   Workeren sender meldingen til API-et, og henter tilbakemeldingen fra Dialogporten og Skatteetaten
   (første gang etter to minutter, så sjeldnere, og minst hver halvtime i en uke). Status og avvik
   vises på måneden, og eier og administrator får varsel når den er mottatt eller avvist. Hvert
   avvik viser alvorlighetsgraden, regelen og detaljene fra Skatteetaten (`navn` og `detaljer`) og
   koden (f.eks. MAGNET_EDAG-230B); det samme avviket flere ganger står én gang med antallet, og
   fødselsnummeret i teksten blir navnet på den ansatte (workeren slår det opp; ellers skjules det).
   En avvist melding rettes og sendes på nytt som en ny melding (den erstatter ingenting).
   Dialogen har én forsendelse for innsendingen og en annen for tilbakemeldingen, og begge kan ha
   en lenke for API-et. Forsendelsen for innsendingen (ID-en i svaret på innsendingen, eller typen
   «Submission») hoppes over, og den nyeste tilbakemeldingen hentes. Til den er kommet, står det
   på meldingen når den sist ble sjekket og hva den venter på (f.eks. «Skatteetaten har ikke lagt
   tilbakemeldingen i Dialogporten ennå»), og workeren logger forsendelsene i dialogen («Tilbakemeldingen
   på a-meldingen er ikke klar»). Er organisasjonen ikke lenger koblet til Skatteetaten, står det
   også på meldingen. Sjekkene er oppgaver workeren selv legger i kø (se Køer og hendelser i
   `arkitektur.md`); før workeren fikk sin egen adresse, ble de borte, og meldingen sto på «Sendt,
   venter på svar» med bare tidspunktet for siste sjekk. Tilbakemeldingen står også i innboksen i
   Altinn (i testmiljøet <https://af.tt.altinn.no/>, innlogget som daglig leder i testbedriften).
   Avviser API-et selve innsendingen (status «Feil», f.eks. «Feil i request (AMLD_006)»), står
   hele feilen på meldingen: koden, detaljene fra Skatteetaten (feilspesifiseringen med sti og
   angitt verdi) og korrelasjons-ID-en, som Skatteetatens brukerstøtte trenger. Workeren logger
   svaret (uten fødselsnumre) og hva som ble sendt («Skatteetaten avviste a-meldingen»). En melding
   som feilet, kan sendes på nytt (ny idempotensnøkkel). Idempotensnøkkelen (ID-en til meldingen)
   sendes både i adressen og som hode (`idempotencyKey` og `Idempotency-Key`). Dokumentasjonen sier
   bare at «parameteren» er påkrevd, og testmiljøet svarte «Header mangler (AMLD_1028)» da den bare
   sto i adressen.

Flere virksomheter (underenheter): hver får sin `virksomhet` i meldingen med de ansatte som har
lønnen og arbeidsforholdet der, og arbeidsgiveravgiften per sone; summene er for hele foretaket.
AFP-premien rapporteres på hovedvirksomheten.

Det som ikke er med ennå: finansskatt på lønn, og inntektsmottakere uten norsk fødselsnummer eller
D-nummer.

Koden: `server/src/amelding.ts` (grunnlaget, kontrollen og meldingen som JSON og XML),
`server/src/ameldingInnsending.ts` (workeren: fila, innsendingen og tilbakemeldingen),
`server/src/ameldingRuter.ts` (API-et), `web/src/sider/LonnAmelding.tsx` og
`db/migrations/0077_amelding.sql`. Testene validerer XML-en mot skjemaet
(`server/test/xsd/amelding_v2_3.xsd`).

## Hos kunden

1. **Innstillinger → Lønn → A-melding:** organisasjonsnummeret til virksomheten
   (underenheten i Enhetsregisteret; appen foreslår den når det bare er én) og til
   pensjonsleverandøren når de har OTP. Har foretaket ingen underenhet, sier feltet det (den
   registreres med Samordnet registermelding i Altinn). Foretakets eget organisasjonsnummer (den
   juridiske enheten) godtas ikke som virksomhet. Testbedriftene (organisasjonsnumre som
   begynner på 2 eller 3) slås opp i Brønnøysundregistrenes testmiljø
   (`data.ppe.brreg.no`), der testdataene fra Tenor ligger.
2. **På hver ansatt** (Arbeidsforhold i a-meldingen): yrkeskoden (7 siffer fra SSBs
   yrkeskatalog, basert på STYRK-08; søk på yrket i feltet), arbeidstidsordningen og typen
   arbeidsforhold (standard: ordinært, ikke skift), og årsaken når den ansatte slutter.
   ArbeidsforholdID-en er ansattnummeret, eller den fra det forrige lønnssystemet når den er ført
   (hentet fra a-ordningen, `docs/ansatte.md`), så arbeidsforholdet fortsetter. Den står bare på
   arbeidsforholdet, ikke på inntektene: der er den et gammelt felt, og Skatteetaten avviser
   meldingen (MAGNET_EDAG-230B, «ArbeidsforholdsID på inntekt skal ikke oppgis»). Stillingsprosenten og datoene for siste
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
   Skatteetaten for skattekortene, trykker «Utvid tilgangen i Altinn» under Innstillinger → Lønn →
   Skattekort, og daglig leder godkjenner tilgangspakken «A-ordningen» i Altinn. Nye kunder får den
   med en gang de kobler til.

## Oppsett hos Medinnova (din del)

Gjør det først i testmiljøet (Maskinporten-test, Altinn TT02 og Skatteetatens testmiljø), og
deretter i produksjon. Maskinporten-klienten og systemet i Altinn er de samme som for
skattekortene (se `docs/skattekort.md`); de må være satt opp først.

1. **Søk om tilgang til API-et hos Skatteetaten** for Medinnova AS (scopet
   `skatteetaten:innrapporteringamelding`, test og produksjon). Det gjøres med Skatteetatens skjema
   for tilgang til tjenester for innrapportering, i samme søknad som skattekortet (se
   `docs/skattekort.md`); lenken står også under «Trenger du hjelp» på siden «A-meldingen – for
   sluttbrukersystemer» (lenkene under). Scopet gir også avstemmingsrapporten (tidligere A06/A07).
2. **Scopene på Maskinporten-klienten.** Når Skatteetaten har gitt tilgang, legg disse til på
   integrasjonen i Samarbeidsportalen (samme klient og nøkkel som for skattekortene):
   - `skatteetaten:innrapporteringamelding` (innsending og tilbakemelding);
   - `digdir:dialogporten` (tilbakemeldingen ligger i Dialogporten). Det bestilles hos Digdir i
     registreringsskjemaet for sluttbrukersystemleverandører (lenken står i `docs/skattekort.md`,
     punkt 2).
3. **GitHub-variabelen** (Settings → Secrets and variables → Actions → Variables):
   `AMELDING_INNSENDING` = `true`. Kjør så workflowen «Infrastruktur» (Actions → Infrastruktur →
   Run workflow). Adressen til API-et følger `SKATTEETATEN_MILJO`; den kan overstyres med
   `AMELDING_URL`.
4. **Systemet i Altinn.** Plattform → Drift → «Skattekort (Skatteetaten)» → «Oppdater i
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
- Skatteetaten, kildeskatt på lønn i a-meldingen:
  <https://www.skatteetaten.no/bedrift-og-organisasjon/arbeidsgiver/a-meldingen/veiledning/spesielle-grupper/kildeskatt-pa-lonn>
- NAV, permittering for arbeidsgivere (lønnsplikt i 15 arbeidsdager, de permitterte timene summert
  ved delvis permittering, fritak i 26 uker i løpet av 18 måneder):
  <https://www.nav.no/arbeidsgiver/permittere>
- Store norske leksikon, permitteringslønnsloven (lønnsplikten 15 dager fra 1. mars 2022):
  <https://snl.no/permitteringsl%C3%B8nnsloven>
- Statens særavtale om reise og kost innenlands (§ 9: satsene, og tiden ut over hele døgn etter
  satsen for 6–12 timer eller over 12 timer uten overnatting), PM-2025-12:
  <https://lovdata.no/dokument/SPHPM/pm-2025-12> og
  <https://www.regjeringen.no/no/dokumenter/saravtale-om-dekning-av-utgifter-til-reise-og-kost-innenlands/id3083006/>
- Statens særavtale om reise og kost utenfor Norge (§ 8: landets sats, 50 % for 6–12 timer, hele fra
  12 timer, 25 % lavere fra det 29. døgnet; kompensasjonstillegget), PM-2025-18:
  <https://lovdata.no/dokument/SPHPM/pm-2025-18> og
  <https://arbeidsgiver.dfo.no/lonn-goder-og-reise/reiser-og-satser/statens-satser-utenlands>
- Skatteetaten, trekkfri godtgjørelse til kost på reise med overnatting (de samme trekkfrie satsene i
  Norge og i utlandet, påbegynt døgn på 6 timer eller mer, måltidstrekk og overskudd per døgn):
  <https://www.skatteetaten.no/bedrift-og-organisasjon/arbeidsgiver/a-meldingen/veiledning/lonn-og-ytelser/oversikt-over-lonn-og-andre-ytelser/trekkfri-godtgjorelse-til-kost-pa-reise-med-overnatting>
- Forskuddssatsene for 2026 (forskrift 7. november 2025 nr. 2216):
  <https://lovdata.no/dokument/SF/forskrift/2025-11-07-2216>
- Normrenten (4,8 % januar–august og 4,7 % september–oktober 2026): <https://www.sticos.no/satser/rentesatser>
