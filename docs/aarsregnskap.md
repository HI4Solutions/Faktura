# Årsregnskapet til Brønnøysundregistrene

Under Regnskap → Årsregnskap lages årsregnskapet for et aksjeselskap som er et lite foretak, slik
Regnskapsregisteret i Brønnøysund vil ha det (RR-0002, «Årsregnskap for vanlige foretak»):

- **Resultatregnskapet** for året og **balansen** 31. desember, med fjoråret, etter postene i
  Brønnøysunds skjema. Tallene hentes fra kontoene (NS 4102) etter årsoppgjøret (skattekostnaden og
  disponeringene, se `docs/regnskap.md`) og vises i hele kroner. Øreavrundingen føres mot annen
  egenkapital og overføringene til annen egenkapital, så summene går opp. Bare postene med beløp
  vises (og summene Brønnøysund krever).
- **Fjorårstallene** kommer fra regnskapet når fjoråret ligger her. Ellers (f.eks. det første året
  i Admin Konsoll) legges de inn for hånd fra fjorårets årsregnskap, post for post.
- **Notene** for små foretak: regnskapsprinsippene (en standardtekst som kan endres), usikkerhet om
  fortsatt drift, lønnskostnadene (fra kontoene) og antall årsverk (forslag regnet fra de ansatte:
  stillingsprosenten vektet med delen av året, uten frilansere og roller som ikke er ansatt), lån og
  sikkerhetsstillelse til ledende personer og aksjeeiere, gjelden (forfall etter fem år, pant og
  garantier) og andre opplysninger.
- **Fastsettelsen og revisjonen:** datoen generalforsamlingen fastsatte årsregnskapet, hvem som
  bekrefter det (forslaget er daglig leder eller styrelederen fra Enhetsregisteret), om det skal
  revideres, og om en regnskapsfører har laget det eller hjulpet til.
- **Kontrollene** sier hva som må rettes før innsendingen («Må rettes») og hva som bør sjekkes
  («Sjekk»): årsoppgjøret er bokført og stemmer, balansen og overføringene går opp, ingen beløp på
  kontoer uten post (8400–8799, ekstraordinære poster), fastsettelsesdatoen er etter årets slutt og
  ikke fram i tid, og notene som krever tekst, har det. Advarslene gjelder bl.a. revisjonsplikten
  (aksjeloven § 7-6), aksjekapitalen under 30 000 kr, negativ egenkapital, negative bankinnskudd,
  lønnskostnader uten årsverk, manglende fjorårstall og resultat fra tidligere år som ikke er ført
  mot egenkapitalen.
- **PDF** med oppstillingen, notene, fastsettelsen og signaturlinjene for styret og daglig leder
  (regnskapsloven § 3-5), med rollene fra Enhetsregisteret. Den signerte PDF-en oppbevares.
- **Skjemaene som XML:** hovedskjemaet (1266, versjon 51820) og underskjemaet (758, versjon 51980),
  validert mot Brønnøysunds XSD-er i testene.

Rapporten «Årsregnskap» står under Rapporter → Regnskap (oppstillingen med fjoråret og statusen for
innsendingen). Eier, administrator og regnskap ser årsregnskapet (og en egen rolle med Regnskap).

Fristen for å sende årsregnskapet er én måned etter at det er fastsatt, og senest 31. juli året
etter (regnskapsloven § 8-2); deretter ilegger Regnskapsregisteret forsinkelsesgebyr.

## Innsendingen

Årsregnskapet sendes til signering i Altinn med systembrukeren organisasjonen har gitt Admin
Konsoll (samme system som skattekortene, `docs/skattekort.md`), med tilgangspakken **«Regnskap og
økonomirapportering»** (`urn:altinn:accesspackage:regnskap-okonomi-rapport`):

1. **Gi tilgang i Altinn** (eller **Utvid tilgangen i Altinn** når organisasjonen alt er koblet til
   for skattekortene). Daglig leder godkjenner i Altinn og kommer tilbake til appen. Regnskap kan
   koble til uten Personal og Lønn (rutene under `/regnskap/altinn`).
2. **Send til signering i Altinn.** Workeren lager skjemaet i Brønnøysunds app i Altinn, laster
   opp hovedskjemaet og underskjemaet, og Altinn validerer dem. Feil fra Altinn vises på siden, og
   årsregnskapet kan rettes og sendes på nytt. Ellers låses skjemaet for signering.
3. **Signeringen gjøres i Altinn** av daglig leder (eller den som har signaturrett), med ID-porten
   (BankID). En systembruker kan ikke signere. Lenken til skjemaet står på siden.
4. **Levert.** Appen ser etter i Altinn til skjemaet er signert og sendt inn: hvert kvarter det
   første døgnet, deretter hver sjette time i 90 dager, og når siden åpnes («Sjekk om det er
   signert»).

Skal noe endres mens det venter på signering: **Trekk tilbake**. Skjemaet låses opp i Altinn, og
neste innsending bruker det samme skjemaet. Skal årsregnskapet revideres, låses det ikke, så
revisoren kan legge ved revisjonsberetningen i Altinn før det signeres. Å sende, trekke tilbake og
gi tilgang krever totrinnsinnlogging.

Innsendingen er av til GitHub-variabelen `AARSREGNSKAP_INNSENDING` er satt til `true`. Til da sier
siden at innsendingen ikke er slått på, og PDF-en og skjemaene kan lastes ned og sendes i Altinn for
hånd.

## Slik virker det

- Workeren henter et Maskinporten-token for kundens systembruker med scopene
  `altinn:instances.read altinn:instances.write` og bytter det til et Altinn-token
  (`GET {platform}/authentication/api/v1/exchange/maskinporten`).
- Appen i Altinn er `brg/aarsregnskap-vanlig-202406`, på `brg.apps.tt02.altinn.no` (test) og
  `brg.apps.altinn.no` (produksjon); vertene følger `SKATTEETATEN_MILJO` (testene kan overstyre med
  `BRREG_APP_URL`).
- Instansen lages med `POST …/instances/create` (organisasjonsnummeret som eier). Hovedskjemaet
  lastes opp til dataelementet appen lager, underskjemaet som et nytt (`dataType=Underskjema`), og
  så valideres instansen (`GET …/validate`, alvorlighet 1 er feil). `PUT …/process/next` med
  `confirm` låser for signering, og `reject` låser opp (trekk tilbake). Statusen leses av instansen
  (avsluttet = levert).
- Skjemaene lagres på `aarsregnskap` slik de ble sendt, sammen med instansen og statusen: utkast,
  sender, til_signering, levert eller feil. En innsending som ikke er ferdig etter en halvtime, får
  feil, så den kan sendes på nytt. Feil som kan gå over (ingen svar, 5xx), prøves igjen av Cloud
  Tasks.

Koden: `server/src/aarsregnskap.ts` (oppstillingen, notene, kontrollene, rutene og rapporten),
`server/src/aarsregnskapXml.ts` (skjemaene), `server/src/aarsregnskapInnsending.ts` (Altinn),
`server/src/aarsregnskapPdf.ts`, `web/src/sider/RegnskapAarsregnskap.tsx` og
`db/migrations/0120_aarsregnskap.sql`. Brønnøysunds dokumentasjon:
https://github.com/brreg/docs (regnskapsregisteret, maskinell innrapportering).

## Begrensninger

- Bare aksjeselskap som er små foretak, uten konsern. Andre organisasjonsformer får beskjed om det.
- Små foretak har ikke plikt til årsberetning, så den sendes ikke.
- Revisjonsberetningen legges ved i Altinn av den som signerer (eller revisoren).
- Styret og daglig leder signerer PDF-en selv; elektronisk signering av PDF-en (f.eks. med BankID
  gjennom Idura) kan komme senere.

## Oppsett hos Medinnova (din del)

Gjør det først i testmiljøet, og deretter i produksjon. Maskinporten-klienten og systemet i Altinn
er de samme som for skattekortene.

1. **Scopene på Maskinporten-klienten.** Legg til `altinn:instances.read` og
   `altinn:instances.write` på integrasjonen i Samarbeidsportalen (samme klient og nøkkel som for
   skattekortene). I test er det gjort. Finnes ikke scopene i produksjon, må Altinn gi Medinnova AS
   tilgang til dem først (Altinn brukerstøtte, servicedesk@altinn.no); da dukker de opp i
   Samarbeidsportalen.
2. **GitHub-variabelen** (Settings → Environments → `test`, og senere `production`):
   `AARSREGNSKAP_INNSENDING` = `true`. Kjør så workflowen «Infrastruktur» (Actions → Infrastruktur →
   Run workflow).
3. **Systemet i Altinn.** Plattform → Drift → «Skattekort (Skatteetaten)» → «Oppdater i Altinn».
   Systemet ber da også om tilgangspakken «Regnskap og økonomirapportering». (Trykker en kunde
   «Utvid tilgangen i Altinn» før det, oppdaterer workeren systemet selv.)
4. **Test.** La en testorganisasjon (aksjeselskap fra Tenor) koble til eller utvide tilgangen under
   Regnskap → Årsregnskap, bokfør årsoppgjøret, fyll ut fastsettelsen og send. Åpne skjemaet i Altinn
   (TT02) med lenken på siden, og signer som daglig leder med en testbruker.
