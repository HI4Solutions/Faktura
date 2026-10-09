# Arkitektur

## Oversikt

```
 Nettapp (React)            Kundeportal            Åpent API / webhooks
 Firebase Hosting               │                         │
        │  /api/**              │                         │
        └──────────────► Cloud Run: faktura-api ◄─────────┘
                         (Identity Platform-token / API-nøkkel)
                            │        │         │
               Cloud SQL ◄──┘   Cloud Tasks   Cloud Storage (signerte URL-er)
               Postgres 16       «utsending»
               (privat IP)          │
                   ▲                ▼
                   └──── Cloud Run: faktura-worker ◄── Cloud Scheduler (gjenta, utboks, bank)
                         PDF · e-post · gjentakelser
                         utboks → Pub/Sub «hendelser» → google-disk / regnskap / webhooks
                                                         └─► dead-letter + varsel
```

| Behov | Tjeneste |
|---|---|
| Database | Cloud SQL for PostgreSQL 16, privat IP, IAM-innlogging, PITR |
| API og bakgrunnsjobber | Cloud Run (api, worker) og Cloud Run job (migrate) |
| Innlogging | Identity Platform: e-post og passord, e-postbekreftelse, TOTP-MFA |
| Filer | Cloud Storage: `fakturaer` med versjonering og oppbevaringsregel, `filer` for logo og vedlegg |
| Køer og hendelser | Cloud Tasks (utsending med gjentatte forsøk), Pub/Sub (integrasjoner). Cloud Tasks og Scheduler ligger i europe-west1, som er nærmeste region med disse tjenestene |
| Planlagte jobber | Cloud Scheduler med OIDC-token mot workeren |
| Hemmeligheter | Secret Manager. Cloud KMS krypterer OAuth- og integrasjonstokens |
| Bygg og utrulling | GitHub Actions med Workload Identity Federation, Artifact Registry, Terraform |
| Overvåking | Cloud Logging, oppetidssjekk og varsler i Cloud Monitoring |
| E-post | Resend (EU) bak et eget grensesnitt. Google har ingen transaksjonell e-posttjeneste |
| AI | Gemini på Vertex AI i EU (europe-west3, Frankfurt): fakturautkast fra tekst og tale, forslag på innbetalinger. Tjenestekontoene har `roles/aiplatform.user`, uten nøkler |

## Datamodell

Alle data hører til en organisasjon (`org_id`). Brukere er uavhengige av
organisasjoner og kobles via `medlemmer` med en rolle.

- `organisasjoner`: foretak eller regnskapsbyrå. Selgeropplysninger, kontonummer,
  standard frist og gebyr, KID, verifiseringsstatus og grenser
- `nummerserier`: neste fakturanummer og kundenummer per organisasjon, låst med radlås
- `medlemmer`, `invitasjoner`: brukere og roller
- `brukere.status`: en ny konto venter (`venter`) til plattformadministratoren har godkjent
  den (`godkjent`) eller avvist den (`avvist`, med begrunnelse). Når e-postadressen er
  bekreftet og navnet skrevet inn, går forespørselen på e-post til administratorene (én gang,
  `varslet_at`), og de godkjenner eller avviser i Administrasjon → Oversikt; brukeren får
  e-post om utfallet. Til da slipper API-et bare gjennom `/meg` og invitasjoner
  (`server/src/kontoer.ts`), og appen viser bare at kontoen venter (eller begrunnelsen for
  avslaget). Den som tar imot en invitasjon fra en organisasjon (sendt til e-postadressen
  sin), godkjennes da; organisasjonen går god for den. Plattformadministratorene og de som
  hadde konto fra før, er godkjent (`0043_kontogodkjenning.sql`)
- `moduler` og `bruker_moduler`: plattformens moduler (foreløpig Faktura og Bemanning), og
  hvilke en bruker har bedt om eller fått. Hver funksjon (`funksjoner.modul`) hører til en
  modul. Den som lager en konto, krysser av for modulene den trenger (lagres rett fra
  registreringen, også før e-postadressen er bekreftet, eller på venteskjermen), og
  forespørselen til administratorene går først når navn og moduler er på plass, med modulene i
  e-posten. Administratoren godkjenner med de modulene eller andre (Administrasjon → Oversikt),
  og etter godkjenningen er det bare administratoren som endrer dem. Organisasjonene brukeren
  lager, får bare funksjonene i modulene (av standarden for nye organisasjoner), og med
  Bemanning er ansatte og timer slått på fra start. Brukere uten moduler (fra før, eller
  godkjent av en invitasjon uten å ha valgt) får standarden som før. En ny modul er en rad i
  `moduler` og funksjonene dens; da kommer den med i registreringen, forespørselen,
  godkjenningen og administrasjonen uten flere endringer (`0044_moduler.sql`,
  `/api/offentlig/moduler`)
- `org_tilgang`: regnskapsbyrå ↔ klient (les eller bokfør), alltid med klientens samtykke
- `kunder`, `produkter`, `gjentakelser`. `kunder.ehf`: om kunden kan motta EHF-faktura, slått
  opp i PEPPOL slik aksesspunktene gjør det (`peppol.ts`): SML-en i DNS (NAPTR) gir SMP-en,
  og SMP-en spørres direkte om dokumenttypen (BIS Billing 3), ellers leses tjenestelisten.
  DNS-en i Cloud Run svarer ikke på NAPTR-oppslag, så da spørres Google og Cloudflare (DNS
  over HTTPS), og finner ingen av dem SMP-en, spørres ELMA direkte. Nei bare når både DNS
  og ELMA sier det. Sjekkes med en gang org.nr. er skrevet inn i kundeskjemaet
  (`/api/peppol/:orgnr`, svaret huskes en time), når kunden lagres, med «Sjekk nå», og av
  workeren: kunder som aldri er sjekket (importerte, nytt org.nr. eller feilet oppslag) hvert
  minutt, alle hver 30. dag. Admin → Drift har «Test EHF-oppslag», som viser hvert steg
- `paaminnelser`: påminnelser om fakturaer man lager selv (når beløpet varierer og en
  gjentakende faktura ikke passer): hver måned, kvartal, år, uke eller én gang, på et
  klokkeslett. Workeren tar dem hvert minutt (`ta_paaminnelser` flytter hver til neste dato
  før varselet sendes, så ingen sendes to ganger) og sender push-varsel til den som lagde
  dem eller alle som kan fakturere, og e-post om det er valgt. Varselet åpner en kort side
  (`/paaminnelser/<id>`) med kunden og produktene fylt inn: brukeren skriver inn beløpet og
  sender fakturaen derfra. Kortet kan også få flere linjer, periode (med hurtigvalg for
  forrige og denne måneden, kvartalet eller året), rabatt i prosent eller kroner,
  referanser, melding til kunden, vedlegg, datoer og fakturagebyr. Det fulle skjemaet
  (kopimottakere, gjentakelse) åpnes med alt som er skrevet
- `fakturaer`, `faktura_linjer`, `betalinger`
- Makstak (`0049_makstak.sql`): en avtale om at kunden aldri faktureres mer enn et beløp å
  betale (inkl. mva) på én faktura, f.eks. en lege som betaler for flere produkter, men aldri
  mer enn 70 000 kr. Alle produktene står på fakturaen, og er summen over makstaket, får den
  et fratrekk ned til makstaket: egne linjer (`faktura_linjer.makstak`, antall −1 så prisen
  ikke er negativ i EHF), én per mva-sats, fordelt etter hvor mye satsen utgjør av summen.
  0 % tar øreavrundingen når den er stor nok; ellers kan summen bli ett øre under, aldri
  over (`makstak_fordel`). Fratrekket blir linjer når fakturaen utstedes; for utkast regnes
  det for visning (`makstak_fratrekk`, `utkast_sum`, PDF-forhåndsvisningen), og appen regner
  det likt i nettleseren (`makstakFratrekk`, testet mot databasen). Makstaket kan stå på
  kunden (`kunder.makstak`): nye fakturaer, flere på én gang og gjentakelser får det når
  `makstak` er utelatt i API-et, og det kan fjernes (`null`) eller endres per faktura.
  Endres kundens makstak, følger utkast og gjentakelser som hadde det gamle, med. Delvis
  kreditering regner fratrekket på nytt for det som står igjen, og kreditnotaen tar med
  forskjellen (blir den 0 kr, avvises den); full kreditering tar alt tilbake. Makstaket
  låses ved utstedelse, og en kreditnota har aldri makstak
- `vedlegg`: filer på fakturaer (PDF, bilder, CSV og regneark, typene EHF godtar).
  Lastes opp før utkastet lagres, låses ved utstedelse, og workeren legger en kopi i
  `fakturaer`-bøtta når fakturaen sendes. Filer etter slettede vedlegg ryddes daglig
- `integrasjoner`: Google Disk, regnskapssystemer, bank, Peppol. Tokens er KMS-kryptert.
  EHF sendes gjennom organisasjonens egen konto hos Recommand (type `peppol`): API-et
  sjekker nøkkelen og krypterer hemmeligheten, bare workeren dekrypterer og sender
- `ehf_sendinger`: hver EHF-sending med status (levert, venter, feilet). Kommer den ikke
  fram, sender workeren e-post i stedet
- `banktransaksjoner`: innbetalinger lest fra organisasjonens egne bankkontoer gjennom open
  banking (Enable Banking, type `bank` i `integrasjoner`: egen applikasjon per organisasjon,
  privat nøkkel KMS-kryptert, bare workeren bruker den). Workeren henter på faste tider hver
  dag (`HENTETIDER` i `bank.ts`, kl. 07, 12 og 18 norsk tid, innenfor PSD2-grensen på fire
  hentinger i døgnet uten brukeren; «Hent nå» kommer i tillegg). Hver hentetid tas én gang per
  bank (atomisk, også med flere instanser), og en som ble gått glipp av, tas igjen før neste.
  Appen viser hentetidene, neste henting og når det sist ble hentet, med «Hent innbetalinger
  nå» i samme boks. Når appen åpnes eller kommer fram igjen (Innbetalinger, fakturaene,
  oversikten), henter den med brukeren til stede (`POST …/bank/hent` med `apnet`: høyst hvert
  kvarter, og bare for dem som kan registrere betalinger), og den første hentingen etter BankID
  skjer også med brukeren til stede. IP-adressen og nettleseren (PSU-headerne) sendes bare da
  og ved «Hent nå», aldri fra de faste hentetidene. Innbetalinger som bare er reservert i banken
  (ikke bokført ennå; DNB bokfører innbetalinger fra andre banker gjerne morgenen etter, derfor
  er den første hentetiden kl. 07), registreres ikke, men lagres for seg (`reserverte_innbetalinger`,
  se under). Innbetalingene kobles
  til fakturaer: KID eller fakturanummer i meldingen
  registreres med en gang (`koble_banktransaksjon`), samme beløp og betaler blir forslag,
  resten uavklart. Uten KID-avtale med banken. Innbetalinger fra før startdatoen
  (`organisasjoner.bank_fra`, som standard dagen organisasjonen ble opprettet) hentes ikke,
  og `rydd_banktransaksjoner` fjerner de som er hentet (automatisk registrerte angres)
- `bankkoblinger`: én rad per bank (f.eks. DNB og Storebrand) på samme applikasjon, med egen
  BankID-innlogging, eget samtykke (økt og utløpsdato) og egen henting. Alle kontoene i økten
  lagres, men bare de som er lagt inn i HI4 Faktura (organisasjonens kontonummer og
  `kontoer`) vises og leses, hver fra sin egen dato. Appen legger til og fjerner banker;
  workeren lager BankID-adressen, fullfører økten og henter, og appen venter på svaret ved
  å spørre etter statusen
- `reserverte_innbetalinger`: innbetalinger som er reservert i banken, men ikke bokført ennå,
  med fakturaen de trolig gjelder (samme regler som over). Hver henting fra en konto erstatter
  kontoens reserverte med det banken sender nå, så de som blir bokført (og da registreres som
  vanlig) eller slettet i banken, forsvinner. Uten reserverte i svaret, og med brukeren til
  stede, spør appen etter dem for seg (`transaction_status=PDNG`); aldri på de faste
  hentetidene, der det ville brukt av grensen på fire hentinger i døgnet. Appen viser dem under
  Innbetalinger («Reservert i banken»), på fakturaen («Betaling reservert») og i oversikten, og
  den automatiske betalingspåminnelsen venter mens en reservert innbetaling trolig gjelder
  fakturaen. De registreres aldri som betaling: en reservasjon kan ennå endres eller slettes
- `bankhentinger`: hver henting fra en bank (`loggHenting` i `bank.ts`): hvorfor (de faste
  hentetidene, «Hent nå», appen åpnet eller etter BankID), hva banken sendte (transaksjonene,
  innbetalingene som er bokført og de som ikke er det ennå, den nyeste bokføringsdatoen), hva
  som ble nytt, eller feilen. Logges også til Cloud Logging («Henting fra banken»). Appen viser
  de siste under «Siste hentinger» på Innbetalinger, så det går an å se hva de automatiske
  hentingene får fra banken. Bare workeren skriver, og de siste 200 per organisasjon beholdes
  (`rydd_bankhentinger`)
- `ai_bruk`: AI-forespørsler og tokens per organisasjon, måned og funksjon. Hver organisasjon
  har et tak per måned (`AI_GRENSE`), og en administrator kan slå AI av
  (`organisasjoner.ai_aktiv`). Tale skrives først ned (`…/ai/faktura/tale`,
  `…/ai/assistent/tale`): Gemini skriver ned ordrett og sier fra når det ikke er tale i
  opptaket, og brukeren ser (og kan rette) teksten før den sendes; appen sender heller ikke
  opptak der den ikke hørte noe. Fakturautkast: teksten sendes til Gemini
  sammen med kundene og produktene (med korte id-er, så modellen bare kan velge fra
  registrene), og svaret (JSON etter et fast skjema) sjekkes før skjemaet fylles ut; ingenting
  lagres. Innbetalinger reglene ikke fant noen faktura for, får et forslag fra Gemini når den
  er rimelig sikker (`foresla_banktransaksjon`); forslag registreres aldri uten at en person
  bekrefter. AI-assistenten (knappen på alle sider; man velger å snakke eller skrive) tar
  kommandoer som tekst: Gemini velger handling og fyller ut feltene, serveren slår opp og
  svarer (betalinger, utestående, hvem som jobber og er borte, vakter, timer, feriedager), og
  alt som endrer noe (sende faktura eller utkast, registrere betaling, purre; melde fravær og
  sette inn vikarer, legge inn og publisere vakter, plassere på tavla og lagre rulleringen,
  føre, levere og godkjenne timer, søke om og svare på overføring av ferie) blir forslag som
  appen utfører med de vanlige rutene og brukerens tilgang når brukeren bekrefter. Hva
  assistenten kan, følger brukeren (`GET …/ai/assistent/status`): fakturadelen for dem som har
  tilgang til fakturaene, og personaldelen når ansatte og timer er slått på (vakter, tavle,
  fravær og ferie med Vaktplan), for dem som ser de ansatte og for den som selv er ansatt (også
  rollen `ansatt`, som melder seg syk, tar ledige vakter, fører og leverer timene sine, søker
  om å overføre ferie og spør om sitt eget). Hver kombinasjon har sitt eget faste svarskjema,
  og assistenten er åpen for alle medlemmer (`ai_krev`). Lønnsslipper (PDF eller
  bilde, gjerne mange i én PDF) leses til opplysningene om de ansatte (`…/ai/lonnsslipp`,
  funksjonen `lonnsslipp`, bare eier og administrator): navn, adresse, fødselsnummer,
  kontonummer, stilling, stillingsprosent, lønn, faste tillegg og andre opplysninger lønnen
  trenger (skattetrekk, feriepenger, pensjon, som havner i notatet). Fødselsnummer og
  kontonummer med feil kontrollsiffer tas ut og sies fra om; svaret er rader til importen av
  ansatte (forhåndsvisningen før noe lagres) eller fyller ut skjemaet for én ansatt, og fila
  lagres ikke. Avviser Gemini svarskjemaet
  (400, eller 500 for innviklede skjemaer), prøver serveren én gang til uten det, med
  skjemaet i systemteksten; svaret tilpasses skjemaet og sjekkes som ellers. Plattform-
  administratorene ser svaret fra Google i feilmeldingene, og «Test AI» på adminsiden prøver
  de samme forespørslene som fakturautkast og assistenten, og tale til tekst med et stille
  opptak (der AI-en ikke skal finne noen tale)
- `lonn_oppsett`, `ansatte`, `timeforinger`: ansatte og timer, slått på per organisasjon
  (Innstillinger → Ansatte og timer). Ansattregisteret har personalia, ansettelse og lønn.
  Fødselsnummeret krypteres med KMS i API-et, som ikke kan lese det igjen (bare workeren kan,
  til lønn og a-melding senere); revisjonsloggen sier bare at det er registrert eller endret.
  Hver person kan ha en rolle som organisasjonen lager selv, med det navnet rollen faktisk har
  (f.eks. lege eller sekretær; `ansattgrupper`, se under). Ikke alle i registeret er ansatt: en
  rolle kan være for dem som ikke er ansatt (`ansattgrupper.ikke_ansatt`, f.eks. leger på et
  legekontor som er aksjonærer eller selvstendige), og `ansatte.arbeidstaker` følger rollen
  (triggere når personen får en annen rolle, når rollen endres og når den slettes; API-et kan
  ikke sette det selv). De som ikke er ansatt, er med i vaktplanen, på tavla (om rollen er med
  der), i bemanningskalenderen og i fraværet, men ikke i feriebanken (`feriebank`), ekstratimene eller
  arbeidsmiljølovens advarsler (der sjekkes bare overlapp og at de er aktive), og appen viser
  ikke lønn, fødselsnummer eller kontonummer for dem. Det er rollen som vises («Lege»), ikke
  «eier eller aksjonær» (tilknytningen per person fra 0054 er erstattet av rollene i 0056).
  Faste tillegg på lønnen (`ansatt_tillegg`: f.eks. funksjonstillegg per måned eller
  fagbrevtillegg per time, eventuelt for en periode) ligger på den ansatte og vises som lønnen
  (eier, administrator, regnskap og den ansatte selv); lønnskjøringen tar dem med (se under), og
  a-meldingen skal få dem som faste tillegg. Ansatte kan importeres fra lønnssystemet eller et regneark, som kunder
  og produkter (Excel eller CSV, kolonnene kjennes igjen; «Etternavn, Fornavn», norske datoer,
  prosent og årslønn tolkes): samme e-post, eller samme navn når e-posten mangler, er samme
  ansatt, fødselsnumrene krypteres før lagringen, og et fast tillegg i fila legges til eller
  oppdaterer tillegget med samme navn, og rollen i fila (f.eks. «Lege») er rollen med det navnet,
  eller en ny (`POST /ansatte/importer`, krever Import og personal).
  Kunder kan hentes inn som rollehavere (Roller → «Hent fra kunder», `POST /ansatte/fra-kunder`,
  `0058_kunder_som_rollehavere.sql`; f.eks. legene på et legekontor, som kontoret fakturerer): de
  valgte kundene legges inn med en rolle og «med fra»-dato, med navnet (foreslått fra kunden, og
  kan rettes før det hentes), e-posten, telefonen og adressen fra kunden, og personen kobles til
  kunden (`ansatte.kunde_id`, bare innenfor organisasjonen; slettes kunden, står personen uten
  kobling). En kunde som er hentet inn, hoppes over neste gang. Finnes personen alt blant de
  aktive (samme e-post, ellers samme navn; appen viser hvem før det hentes), kobles den til kunden
  og får rollen, og det som mangler av e-post, telefon og adresse, fylles ut fra kunden.
  Ansattkortet viser kunden (med lenke til kundelista) og kan fjerne koblingen.
  En ansatt kan få egen innlogging: invitasjonen (`inviter_ansatt`) gir rollen `ansatt` og
  kobler brukeren til ansattkortet, og er e-posten alt med i organisasjonen, kobles den med
  en gang. Timene føres med fra og til (over midnatt går fint) og pause, eller som antall
  timer. Den ansatte leverer uka (`lever_timer`), eier eller administrator godkjenner eller
  avviser med en grunn (`godkjenn_timer`, `avvis_timer`), og begge får push-varsel. Status
  endres bare gjennom funksjonene, og leverte timer er låst for den ansatte. Overtiden regnes
  ut per uke (`arbeidstid.ts`): timene over grensen per dag, så timene over grensen per uke av
  resten, med tillegg (arbeidsmiljøloven: 9 og 40 timer, minst 40 %; grensene kan endres for
  tariffavtaler). Føringer merket som overtid teller i sin helhet med sitt tillegg, og
  ordinære timer over avtalt arbeidstid er merarbeid. Føringer uten overtid
  (`timeforinger.uten_overtid`, `0069_ekstratimer_uten_overtid.sql`: ekstra timer etter
  avtale, f.eks. fleksitid) er aldri overtid og regnes ikke med i grensene; de lønnes med
  timelønnen, eller med timesatsen som «Ekstratimer (uten overtid)» for dem med fastlønn
- `vakter`: vaktplanen. Eier og administrator planlegger vakter per dag og ansatt (fra–til,
  pause, oppgave og notat); vaktene er utkast til de publiseres (`publiser_vakter`), og da
  får hver ansatt én push-melding om sine nye vakter. Endringer i og fjerning av publiserte
  vakter varsles til dem det gjelder. De aktive ansatte ser hele den publiserte planen (se
  «De ansatte ser planen» under). En vakt uten ansatt er ledig: aktive ansatte ser
  publiserte ledige vakter og kan ta en (`ta_vakt`: raden låses, så den første får den;
  ikke passerte vakter, og ikke om den overlapper en av deres egne), og eier og administrator
  får beskjed. En uke kan kopieres til neste (eller flere uker) som utkast, uten dobbeltvakter
  og uten ansatte som har sluttet. Mens man planlegger, viser appen advarsler etter
  arbeidsmiljøloven (`vaktregler.ts`): under 11 timer hvile mellom arbeidsdagene (delte vakter
  samme dag er én arbeidsdag), under 35 timer sammenhengende fri i uka, overtid per dag og
  uke etter grensene i oppsettet, overlappende vakter og vakter utenfor ansettelsen. Timene
  kan føres fra vakten (`timeforinger.vakt_id`), og timelisten og godkjenningen viser hvor
  mange timer som var planlagt. Vaktplanen vises per dag, uke eller måned (`?visning=dag`,
  `uke` eller `maaned`): dagen som en tidslinje rolle for rolle (vaktene og de faste dagene som
  streker, hvem som har vakt ledig og hvem som er borte; trykk på en strek åpner vakten, og på en
  tom linje legges en vakt inn, og «Tavla for dagen» åpner tavla), uka rolle for rolle (på PC
  rollen over personene i tabellen, i rollenes rekkefølge; på mobil og nettbrett står rollene side
  om side i hver dag, f.eks. sekretærene i én kolonne og legene i den neste, med kanten på
  vaktene i rollens farge), og måneden som bemanningskalenderen (se under;
  kalenderen er ikke en egen fane lenger, og gamle lenker med `fane=kalender` går til måneden).
  Trykk på en dato i måneden åpner dagen. «Publiser» gjelder dagen eller uka som vises. Over
  planen velges hvilke roller som vises («Vis: Alle | Sekretærer | Leger | Uten rolle»,
  `Rollevalg` i `Roller.tsx`): det samme valget gjelder dagen, uka og måneden, og tellingene (på
  jobb, mangler vikar) følger det, mens ledige vakter (uten rolle), advarslene, «Publiser» og
  «Kopier uka» gjelder alle. Valget huskes på enheten per organisasjon (`localStorage`) og
  endrer bare visningen
- `vaktbytter` (`0060_vaktbytte.sql`, `server/src/vaktbytte.ts`): den ansatte gir bort en
  publisert vakt eller en fast arbeidsdag (den blir en vakt med de samme tidene,
  `vakt_fra_plan`), til en bestemt kollega eller til alle med samme rolle (uten rolle: alle), eller
  bytter den mot en vakt eller fast dag en kollega har. Kollegaene er de aktive med innlogging og
  samme rolle (`vaktbytte_kollega`); åpne tilbud står blant de ledige vaktene deres. Kollegaen tar
  vakten (et åpent tilbud: den første får den, raden låses), bytter eller sier nei takk, og kan
  angre mens byttet venter. `lonn_oppsett.vaktbytte`: `godkjenning` (standard: eier eller
  administrator godkjenner eller avviser med en grunn, og ser advarslene etter
  arbeidsmiljøloven byttet gir de to), `fritt` (gjennom med en gang) eller `av`. Alt sjekkes
  når tilbudet lages, når kollegaen svarer og når byttet gjøres (`vaktbytte_utfor`): vakten har
  ikke begynt, den som gir den bort, er ikke borte og har ikke vikar (vakten står for
  sykepengene, og lederen setter inn vikar), og den som tar den, er aktiv, ansatt den dagen, ikke
  borte og har ingen annen vakt eller fast dag som overlapper (`vaktbytte_hindring`; om
  kollegaer sies bare «annen vakt» eller at de ikke kan, siden fraværet er skjult). Når byttet går
  gjennom, flyttes vakten (ved bytte begge), en fast dag samme dag hos den som får vakten blir en
  vakt først, og plassene på tavla følger med (`vaktbytte_tavle`: plassene i fasene vakten
  dekker, og den faste oppgaven, som for en vikar). Den som gir bort en vakt på en fast
  arbeidsdag, får fri den dagen (`arbeidsplan_fri`), så den faste dagen ikke kommer tilbake; ved
  et bytte flyttes timene i planen til dagen de fikk igjen (`byttet_til`), så byttet ikke blir
  ekstratimer. Endrer lederen dag, tid eller ansatt på en vakt med et åpent tilbud, er tilbudet
  utgått; et tilbud som ikke er besvart når vakten begynner, vises som utgått. De to, kollegaene
  (åpne tilbud) og eier og administrator (til godkjenning) får push-varsler (`vakter`). Den
  ansatte ser byttene de er med i og de åpne tilbudene fra kolleger (`vaktbytte_liste`), eier,
  administrator og regnskap alle; alt annet går gjennom funksjonene.
  Eier og administrator gir bort eller bytter en vakt eller fast arbeidsdag rett fra vaktplanen
  (`0072_vaktbytte_leder.sql`, «Bytt eller gi bort» i vaktskjemaet,
  `GET /vaktbytter/leder/muligheter` og `POST /vaktbytter/leder`): uten godkjenning og uansett
  innstillingen, med alle aktive i organisasjonen (også med en annen rolle eller uten innlogging),
  og også vakter som ikke er publisert. `leder_bytt_vakt` lagrer byttet som godkjent
  (`av_leder`, «Gitt bort»/«Byttet» av lederen i lista) og gjør det med `vaktbytte_utfor`, med de
  samme sjekkene; vakter med førte timer byttes ikke. Med `forhandsvis` gjøres byttet og rulles
  tilbake (savepoint), så lederen ser de nye advarslene etter arbeidsmiljøloven før det
  bekreftes. De to får beskjed når en av vaktene er publisert.
  Fridagen (`0074_vaktbytte_fridag.sql`): gir den ansatte bort en fast arbeidsdag (eller vakten på
  en fast arbeidsdag) uten å få en vakt igjen, og får fri den dagen (`gir_fridag`), velger de hva
  fridagen tas fra (`vaktbytter.fri`, når `lonn_oppsett.vaktbytte_fridag` er på, som er
  standard): en feriedag, timer fra timebanken (timene vakten var på, `fri_timer`) eller betalt
  fravær med en grunn (`fri_grunn`); med timelønn også fri uten lønn (standard for dem), med
  fastlønn må den tas fra noe. `sjekk_fridag` sjekker at feriedagene og timene finnes, og det
  som er valgt i bytter som venter, regnes som brukt (`ferie_i_vaktbytter`, og
  `timebank_saldo.sokt`); `vaktbytte_fridag` gir appen valgene med saldoene. Ferie, timebanken og
  betalt fravær er fravær lederen ellers registrerer, så et slikt bytte må alltid godkjennes av
  eier eller administrator (også med `fritt`), og når det går gjennom, registrerer
  `vaktbytte_utfor` fraværet (ferie, avspasering med timene, eller permisjon med lønn) og
  lagrer det på byttet (`fravaer_id`). Valget ser bare den som ga bort vakten, og eier og
  administrator (`ser_fravaertype`; ikke kollegaen, ikke regnskap og ikke revisjonsloggen for
  andre); lederen får det i varselet (`vaktbytte_fri`, som system). Lederen kan også velge
  fridagen (eller ikke noe fravær) når de gir bort en ansatts faste arbeidsdag i vaktplanen, og
  da registreres fraværet med en gang
- `fravaer`: sykdom, sykt barn, ferie, permisjon, kurs og annet fravær per ansatt (fra og med, til
  og med). Permisjon kan være med lønn (`betalt`, med timene: med timelønn lønnes de i
  lønnskjøringen som «Permisjon med lønn», med fastlønn går lønnen som vanlig). Eier og administrator registrerer alt; den ansatte melder selv sykdom (fra og med
  i går) og kan bare endre sluttdatoen på den etterpå. Melder den ansatte seg syk, får eier og
  administrator varsel med hvor mange vakter som trenger vikar; registrerer leder fravær, får
  den ansatte beskjed. Den som er borte, tas ut av ressursene: vaktene er merket med fraværet,
  teller ikke i advarslene eller som planlagt arbeid, og står som «mangler vikar». Fravær er
  helseopplysninger: bare eier, administrator, regnskap og den ansatte selv ser det. Hva slags
  fravær det er (syk, sykt barn, ferie, permisjon, kurs, annet) og notatet ser bare eier og
  administrator, som registrerer og følger opp fraværet, og den ansatte selv. Alle andre (f.eks.
  regnskap) ser bare at den ansatte har fravær («F») i fraværslista, vaktplanen, på tavla og i
  bemanningskalenderen, og fraværet står ikke i revisjonsloggen for dem
  (`faktura.fravaer_type`, `0047_fravaer_skjult.sql`)
- Egenmelding (`0071_egenmelding.sql`, `server/src/fravaer.ts`, «Meld deg syk» og «Send
  egenmelding» under Mine vakter): den ansatte sender egenmelding for egen sykdom eller sykt barn
  når sykdommen meldes, eller etterpå for sykdom de siste 16 dagene, og bekrefter erklæringen
  (og svarer på om fraværet har sammenheng med arbeidet); eier og administrator får varsel.
  `fravaer.dokumentasjon` er egenmelding (med `egenmeldt` og `egenmeldt_av`) eller sykmelding
  (legeerklæring for sykt barn), som lederen registrerer, også en egenmelding på papir. Den
  ansatte kan ikke endre eller fjerne dokumentasjonen etterpå. Databasen sjekker reglene
  (`faktura.fravaer_egenmelding`): egen sykdom inntil 3 kalenderdager på rad og 4 ganger i
  løpet av 12 måneder, etter to måneder i jobben (folketrygdloven § 8-24); arbeidsgiveren kan
  gi mer under Innstillinger → Ansatte og timer (`lonn_oppsett.egenmelding_dager`,
  `egenmelding_ganger`, `egenmelding_dager_aar`, f.eks. IA-ordningen med 8 dager per gang og 24
  dager i løpet av 12 måneder), aldri mindre: lovens regler gjelder alltid. Sykt barn: inntil 3
  dager på rad (`egenmelding_barn_dager`), og telles ikke med i de fire gangene. Fravær med
  egenmelding som henger sammen (dagen etter), er samme tilfelle
  (`faktura.egenmelding_tilfeller`, `faktura.egenmelding_brukt`). Dokumentasjonen følger typen:
  bare eier, administrator og den ansatte selv ser den. Rapporten «Sykefravær og egenmeldinger»
  ligger i rapportmodulen
- Feriebank (`0050_feriebank.sql`, `ferie.ts`, siden «Ferie»): feriedagene hver ansatt har i
  ferieåret (kalenderåret), hva som er avviklet (til og med i dag) og planlagt, og hva som er
  igjen. Avviklet og planlagt regnes av fraværet med typen ferie (`ferie_saldo`), så banken
  justeres av seg selv når ferie registreres, endres eller slettes. Dagene telles i den
  ansattes arbeidsdager: dagene i den faste arbeidsplanen som gjelder den dagen (ellers mandag
  til fredag), uten helligdagene (`helligdager`, påsken regnes ut). Retten er
  `lonn_oppsett.ferie_dager` (standard 25, fem uker) regnet om etter dagene i uka den ansatte
  jobber, med en uke ekstra fra året den ansatte fyller 60 og én uke for den som begynner
  etter 30. september (ferieloven § 5), eller `ansatte.ferie_dager` når den er satt. Den
  ansatte søker om å overføre dager til neste år (`ferie_overforinger`, fra i år eller i
  fjor); eier og administrator får varsel, godkjenner eller avslår, og den ansatte får svar.
  Godkjente dager trekkes fra i året de overføres fra og legges til året etter, og ingen kan
  overføre mer enn det som er igjen. Fraværsskjemaet og ansattkortet viser hva som er igjen.
  Som fraværstypen ser bare eier, administrator og den ansatte selv feriebanken
- Timebank (`0073_timebank.sql`, `timebank.ts`, fanen «Timebank» under Timer): timer den ansatte
  har jobbet mer enn avtalt, og som tas ut som fri senere. Den slås på per organisasjon
  (`lonn_oppsett.timebank`, `faktura.timebank_paa`). Inn: godkjente timeføringer merket «til
  timebanken» (`timeforinger.timebank`), bare overtid eller ekstratimer uten overtid (databasen
  avviser vanlige timer); levert og ikke godkjent vises som «venter på godkjenning». Ut:
  avspasering i hele dager er fravær med typen `avspasering` og timene den tar fra banken
  (`fravaer.timer`; foreslått av de planlagte timene, vakter og faste dager, ellers en vanlig
  arbeidsdag per dag, `avspasering_forslag`), og noen timer en dag er en post i
  `timebank_poster` med typen `avspasering`. Eier og administrator kan også justere banken
  (`justering`, pluss eller minus med en grunn, f.eks. en dag for jobb på en fridag, i timer
  eller dager) og betale ut timer (`utbetaling`). Saldoen regnes av dataene, ikke lagret
  (`timebank_saldo`, `timebank`): inn minus avspasert og utbetalt, pluss justert, og vises også
  i dager (avtalt arbeidstid per uke delt på dagene i den faste planen, ellers fem; `dag_timer`).
  Den ansatte søker om avspasering (`avspasering_soknader`, `sok_avspasering`): hele dager eller
  noen timer én dag, fra en uke tilbake og høyst tre måneder, ikke mer enn saldoen minus det som
  er søkt om fra før, og ikke over annet fravær. Eier og administrator får varsel og godkjenner
  (timene kan endres, og `behandle_avspasering` lager fraværet eller posten) eller avslår med
  en grunn; den ansatte får svar og kan trekke søknaden mens den venter. Avspaseringen avtales,
  så den gjelder først når den er godkjent. Lønnskjøringen lønner ikke timene som settes i
  banken, men overtidstillegget for dem utbetales med en egen linje (arbeidsmiljøloven § 10-6
  tolvte ledd: overtid kan avspaseres etter skriftlig avtale, tillegget betales likevel). Med
  timelønn lønnes avspaseringen i perioden den tas ut («Avspasering fra timebanken», fordelt på
  virkedagene), og med fastlønn går lønnen som vanlig. Utbetalinger lønnes i neste vanlige
  kjøring med timelønnen eller timesatsen («Utbetalt fra timebanken»), og merkes med
  `lonnskjoring_id` når kjøringen godkjennes (`lonnsslipper.timebank_poster`); de kan da ikke
  endres eller slettes før kjøringen åpnes igjen, og en lønnet føring kan ikke settes i eller
  tas ut av banken.
  Eier, administrator og regnskap ser saldoene med verdien (saldoen ganger timelønnen eller
  timesatsen, uten feriepenger og arbeidsgiveravgift), den ansatte sin egen, og søknadene ser
  bare eier, administrator og den ansatte selv. Rapporten «Timebank» ligger i rapportmodulen
  og kan sendes til regnskapsføreren hver måned
- `vakter.vikar_for`: en vikar settes inn som en egen vakt med samme tid og oppgave som vakten
  til den som er borte (den beholder sin). Vikarvakten publiseres med en gang med varsel til
  vikaren, tar over plassene på tavla, og kopieres ikke til neste uke. Vikaren kan være en ny
  ansatt (tilkalling, timelønn) lagt inn fra skjemaet
- `tavle_faser`, `tavle_oppgaver`, `tavle_behov` og `tavle_plasseringer`: tavla
  (ressursfordelingen). Organisasjonen lager selv fasene (radene, f.eks. forvakt, mellomvakt
  og senvakt eller før og etter lunsj, med tidsrom) og oppgavene (kolonnene, f.eks. telefon,
  resepsjon og lab), med hvor mange som trengs i hver oppgave, eventuelt forskjellig per fase.
  Ressursene en dag er de som har vakt i vaktplanen eller fast arbeidsdag etter
  arbeidsplanen, og hver hører til fasene vakten overlapper (en hel fast dag hører til alle). Eier og administrator plasserer dem i oppgavene (én oppgave per ansatt og fase;
  dra og slipp på PC, trykk på mobil) og kan kopiere plassene fra en annen dag. Den som er
  borte, kan ikke plasseres, og plassene den har, teller ikke. En rolle kan stå utenfor tavla
  (`ansattgrupper.tavle`, `0057_rolle_tavle.sql`; f.eks. legene, mens sekretærene fordeles): de
  med rollen står ikke der, rulleringen og kopieringen tar dem ikke med, og de kan ikke plasseres
  (databasen lager ikke plassen, og API-et sier fra). Når rollen tas ut av tavla, eller personen
  får en slik rolle, fjernes plassene deres fra i dag av; i vaktplanen, bemanningskalenderen og
  fraværet er de med som før. Regnskap ser tavla, og den ansatte ser sine egne plasser under
  Mine vakter
- Norske helligdager (`server/src/helligdager.ts`, `web/src/helligdager.ts` og
  `faktura.helligdager` i databasen, likt regnet): 1. nyttårsdag, skjærtorsdag, langfredag,
  1. og 2. påskedag, 1. mai, 17. mai, Kristi himmelfartsdag, 1. og 2. pinsedag og 1. og 2.
  juledag (påsken etter den gregorianske kalenderen). De faste arbeidsdagene gjelder ikke da,
  så de er ikke med i bemanningen, på tavla, i rulleringen eller som planlagt arbeid;
  feriebanken teller dem ikke som feriedager. Bemanningskalenderen viser dem med rød dato og
  navn, uten å varsle om behovet, og vaktplanen, timene og tavla viser navnet på dagen
- Rullering på tavla (`server/src/rullering.ts`, `POST /tavle/rullering`): de som er på jobb
  i en periode (høyst 31 dager), fordeles på oppgavene så alle får gjøre alt etter tur. Hver
  dag og fase for seg, i rekkefølge: behovet fylles først (én i hver oppgave før noen får to,
  og mangler det folk, i oppgavenes rekkefølge), resten går jevnt til oppgavene uten behov
  (har alle behov, står resten uten oppgave), og behov 0 betyr ingen. Hvem som får hva, er
  en tilordning med lavest samlet kostnad (den ungarske metoden): andelen av plassene den
  ansatte har hatt i oppgaven de siste åtte ukene (de nyeste teller mest, halvert hver
  annen uke), helst ikke det samme som forrige arbeidsdag, og en annen oppgave enn i fasene
  før samme dag; faser som overlapper i tid, gir samme oppgave (valgfritt: samme oppgave
  hele dagen). Plassene rulleringen setter, er merket (`tavle_plasseringer.rullert`) og
  byttes ut når den kjøres igjen for de samme dagene, mens plassene satt for hånd står og
  teller med (en plass som flyttes for hånd, er ikke lenger rullert); med `behold: false`
  fordeles også de. `tavle_utelatt`: hvem rulleringen ikke setter i en oppgave (uten rad
  kan alle; uten noen oppgave er den ansatte utenfor rulleringen), styrt i oppsettet av
  tavla; for hånd kan alle plasseres. `tavle_fast_oppgave` (`0059_tavle_fast_oppgave.sql`): en
  ansatt kan ha en fast oppgave (f.eks. laben), valgt i oppsettet av tavla eller ved å trykke på
  navnet. Rulleringen setter dem alltid der, i alle fasene de er på jobb og oppgaven trengs (også
  når behovet er dekket; der den ikke trengs, står de uten plass), og de rulleres ikke. Uten en
  plass i fasen står de der likevel, på tavla («Fast»), i «Mine vakter» og for AI-assistenten
  (regnet ut i API-et, `fastePlasser`, og ikke lagret); en plass satt for hånd en dag står foran,
  og en vikar tar over plassen. En rolle som tas ut av tavla, tar også den faste oppgaven. Appen viser et forslag (dagene med fasene og
  oppgavene, behovet som mangler og fordelingen per ansatt) før det lagres
- `arbeidsplaner` og `arbeidsplan_dager`: den faste arbeidsplanen til en ansatt, lagt inn i
  ansattskjemaet ved stillingsprosenten: ukedagene den ansatte jobber, med klokkeslett (og
  pause) eller som hel dag (en femtedel av arbeidstiden i full stilling, vanligvis 7,5 timer),
  gjeldende fra en dato. En endring blir en ny plan fra en dato, så tidligere måneder beholder
  planen som gjaldt da; en plan uten dager betyr ingen faste dager fra da. En fast dag er en
  dag i planen uten vakt (en vakt samme dag gjelder i stedet) og ikke en helligdag (da har den
  ansatte fri, og timene en vakt gir den dagen, er ekstra), og den vises i
  bemanningskalenderen, vaktplanen, på tavla og i timelisten (med «Før timer»), og teller som
  planlagt arbeid. Vikar for en fast dag gir en vakt etter planen (`POST /vakter/fra-plan`) som
  vikaren dekker. En fast dag som er gitt bort i et vaktbytte, gjelder ikke (`arbeidsplan_fri`).
  En hel dag (det vanligste) står bare med navnet, uten «hel dag» eller klokkeslett, i
  vaktplanen, på tavla, i kalenderen, i timelista og hos AI-assistenten.
  Ekstratimer (`server/src/arbeidsplan.ts`): med plan timene utover planen den dagen (en dag
  med fri har ingen timer i planen, og timene fra en fast dag som er byttet, er flyttet til
  dagen den ansatte fikk igjen); uten plan timene utover avtalt arbeidstid i uka (alle timene
  for tilkallingsvikarer); vakter den ansatte er borte fra, teller ikke. Rapporten over
  ekstratimer per ansatt i en periode tas ut som PDF eller CSV (`/ekstratimer.pdf|.csv`)
- Bemanningsdataene registreres ett sted og brukes overalt: stillingsprosenten, arbeidstiden og
  de faste dagene ligger på den ansatte (`ansatte`, `arbeidsplaner`), og fraværet og ferien i
  `fravaer`. De vises i vaktplanen, på tavla, i bemanningskalenderen, i timelista og i
  ansattkortet, og kan endres fra alle: «Registrer fravær» og «Arbeidstid og faste dager» åpner
  de samme skjemaene som i ansattkortet (fra en vakt, en plass på tavla, en dag eller et navn i
  kalenderen og en ansatts uke i timelista), og ansattkortet viser fraværet og ferien til den
  ansatte. Stillingsprosenten følger de faste dagene når de endres (timene i uka av arbeidstiden
  i full stilling), og kan endres etterpå. `lonn_oppsett.full_stilling` er organisasjonens
  arbeidstid i full stilling (vanligvis 37,5), som nye ansatte får (`0048_full_stilling.sql`)
- `lonn_oppsett.helg` (`0064_helg.sql`): åpent i helgene (standard: ja). Eier og administrator
  slår det av under Innstillinger → Ansatte og timer når de har stengt lørdag og søndag; alle i
  organisasjonen får det i `mine_organisasjoner.helg` (`/api/meg`). Med stengt helg viser
  vaktplanen (dagen, uka og måneden), tavla, timeføringen (timelista og ukeoversikten) og de
  faste arbeidsdagene bare mandag–fredag, ukevelgeren viser «5.–9. okt.», og dag for dag (i
  vaktplanen og på tavla) hopper over helgen; «i dag» på en lørdag eller søndag er mandagen etter.
  Lørdag og søndag vises likevel når noen har vakt, fast dag eller timer da, så ingenting blir
  borte, og en vakt som legges på en lørdag, får en merknad. Med åpen helg viser måneden alle
  dagene (før bare helgedager med vakter). AI-assistenten legger perioder («hele neste uke») på
  mandag–fredag (dagene brukeren sier, gjelder likevel), og hopper over tomme helgedager når den
  forteller hvem som jobber
- `lonn_oppsett.bursdag_varsel` og `ansatte.bursdag_varsel`: bursdagsvarsler. Eier og
  administrator slår dem på under Innstillinger → Ansatte og timer (de ansatte har ikke tilgang
  dit) og velger push-varsel, e-post eller begge. Når en aktiv ansatt har bursdag (fødselsdatoen
  på ansattkortet; 29. februar feires 28. februar i år som ikke er skuddår), får alle de andre i
  organisasjonen beskjed kl. 08 norsk tid: medlemmene og de aktive ansatte, også dem uten
  innlogging når det går på e-post, men ikke den som har bursdag (`bursdager_i_dag`,
  `bursdag_mottakere`). Workeren tar det i hjerteslaget hvert minutt (`server/src/bursdager.ts`),
  én gang per ansatt og dag, og e-posten går til hver mottaker for seg. En ansatt kan unntas i
  ansattkortet, og hver bruker kan slå av push om bursdager for seg selv (varseltypen
  `bursdag`). Varselet sier ikke alderen (`0045_bursdager.sql`)
- Klokkeslett skrives og vises med 24-timersklokke (tt:mm) overalt i appen, også på enheter
  med engelsk språk, der nettleserens eget klokkeslettfelt ville vist AM og PM. Feltet
  (`Klokkeslett` i `web/src/uke.tsx`) tar også «730», «7.30» og «1530» og retter dem til 07:30
  og 15:30
- Personalmodulen på mobil (Ansatte, Vaktplan, Timer, Ferie, Lønn og Beskjeder; `main[data-modul="personal"]` i
  `web/src/styles.css`) er tettere enn resten av appen, så det blir mindre å rulle: mindre knapper,
  felt og rader (fortsatt 16 px tekst i feltene, så iPhone ikke zoomer), vaktplanen én dag om
  gangen med en dagvelger (ukedagene med hvor mange som er på jobb, og «!» når en vakt mangler
  vikar; samme ukedag når uka byttes), navnene på tavla ved siden av hverandre under oppgaven,
  forklaringen i vaktplanen for måneden i «Forklaring», og bunnmenyen med personaldelen (Ansatte,
  Vaktplan og Timer) der. PC og fakturadelen er som før
- `ansattgrupper` og `ansatte.gruppe_id`: rollene (i appen «Roller»; f.eks. lege og sekretær),
  med hvor mange som trengs på jobb per dag, om de med rollen er ansatt (`ikke_ansatt`), og om
  de er med på tavla (`tavle`, se over).
  Rollene settes opp under Ansatte → Roller og i vaktplanen for måneden, og velges (eller lages,
  «+ Ny rolle») i ansattskjemaet; de hører til «Ansatte og timer», ikke bare vaktplanen.
  Bemanningskalenderen (månedsvisningen i vaktplanen, `web/src/sider/Bemanning.tsx`; fra de faste
  arbeidsplanene, vaktene og fraværet) viser måneden med datoene nedover og folkene bortover,
  rolle for rolle: på jobb (✓), fri (–),
  fravær (for eier og administrator Fe ferie, S syk, SB sykt barn, P permisjon, K kurs, A
  annet; for andre bare F) eller ekstratimer, nederst ekstratimene i måneden per ansatt,
  og til høyre hvor mange med hver rolle som er på jobb mot behovet, vakter uten vikar og
  ledige vakter. Så kan f.eks. legene ses opp mot sekretærene, også leger som ikke er ansatt.
  Roller kan lages fra stillingene, og kunder hentes inn som rollehavere (se over).
  AI-assistenten svarer med det samme når man spør hvem som jobber («Lege 6 av 7 (mangler 1),
  Sekretær 4 av 4»)
- `ansatte.forkortelse` (`0061_forkortelser.sql`): en kort forkortelse for hver person, brukt der
  plassen er liten (kolonnene i vaktplanen for måneden). Den lages
  av navnet når den mangler (`ny_forkortelse`: forbokstavene i fornavn og etternavn, så to
  bokstaver fra etternavnet eller fornavnet, så et tall; «KN», «KNO», «KAN», «KN2»), er unik i
  organisasjonen uten hensyn til store og små bokstaver, og kan endres i ansattskjemaet (1–6
  tegn: bokstaver, tall og bindestrek). Tømmes den, lages en ny; de som fantes, fikk en da
  kolonnen kom
- `beskjeder` og `beskjed_lest` (`0062_beskjeder.sql`, `server/src/beskjeder.ts`, siden
  «Beskjeder»): alle i organisasjonen kan legge en beskjed til én eller flere roller (f.eks.
  legene) eller til alle, eventuelt med push-varsel (varseltypen `beskjed`) til de aktive med
  rollene, eller til alle medlemmene, men ikke til den som skrev den. En beskjed til roller ses
  av de aktive med rollene, av den som skrev den, og av eier, administrator og regnskap (som ser
  de ansatte; `ser_beskjed`); en beskjed til alle ses av alle i organisasjonen. Navnet til den
  som skrev den, kommer fra ansattregisteret (ellers fra innloggingen), og beskjeden kan ikke
  endres; den som skrev den, og eier og administrator, kan slette den. `beskjed_lest` har når
  hver bruker sist så beskjedene: nye er andres beskjeder etter det, høyst 14 dager gamle. De
  står merket på siden, og tallet på dem står i menyen (i bunnmenyen for de ansatte, ellers som
  en prikk på «Mer»); siden henter nye beskjeder hvert minutt mens den er åpen
- `funksjoner` og `org_funksjoner`: hvilke funksjoner hver organisasjon har tilgang til (EHF,
  bank, AI, gjentakende fakturaer, flere fakturaer, påminnelser, rapporter, import, Google
  Disk, ansatte og timer, vaktplan og bemanning, lønn; vaktplanen og lønnen bygger på ansatte og timer),
  gruppert i modulene Faktura og Bemanning. Fakturaer, kunder og produkter har alle. Plattformadministratoren slår dem av og på i
  detaljene for organisasjonen (Administrasjon → Organisasjoner) og velger standarden for nye
  organisasjoner nederst samme sted; de som fantes da funksjonene kom, beholdt alt. API-et avviser rutene
  til en funksjon organisasjonen ikke har (`server/src/funksjoner.ts`, med svaret husket et
  halvt minutt), bakgrunnsjobbene hopper over organisasjonen (bankhenting, gjentakende
  fakturaer, EHF-sending, som da går på e-post, påminnelser og Google Disk), og appen
  skjuler det som ikke er slått på (`mine_organisasjoner.funksjoner`)
- Menyen i appen har ett punkt for fakturaene: Fakturaer har fanene Alle, Utkast, Ubetalt,
  Betalt, Kreditert, Gjentakende og Innbetalinger (`web/src/fakturameny.tsx`). Gjentakende og
  Innbetalinger har de samme adressene som før (`/gjentakende`, `/innbetalinger`), og
  «Fakturaer» er valgt i menyen på alle tre.
  Innstillingene har fanene Organisasjon (opplysningene, brukerne, regnskapsføreren og
  sletting), Faktura (fakturaoppsettet, logoen, betalingen med kontonumre, purring og banken,
  og EHF), Ansatte og timer, Min konto og App. Hver del lagrer bare sine felt
  (`PATCH /org/:id` tar imot deler av organisasjonen), og det som ikke er lagret, blir med
  mellom fanene. Gamle lenker og varsler (`?fane=betaling`, `?fane=ehf`, `?fane=brukere`) går
  til fanen og stedet der delen er nå
- Administrasjonen har tre faner. Oversikt: bruken, og kontoer og organisasjoner som venter på
  godkjenning (antallet står på fanen). Organisasjoner: alle organisasjonene med brukerne under
  organisasjonen de er med i (søket finner også en bruker), detaljer med behandling,
  funksjonene, brukerne (moduler, passkeys og de andre organisasjonene de er med i), bruk,
  integrasjoner, logg og sletting, og nederst brukere uten organisasjon, funksjonene for nye
  organisasjoner og de slettede. Drift: e-post, EHF, AI, trekktabellene, banker og utboksen. Gamle lenker til
  Venter, Funksjoner og Brukere går til Oversikt og Organisasjoner
- `slettede_organisasjoner` og `organisasjoner.slettet_at`: sletting av organisasjoner. Eieren
  (Innstillinger → Organisasjon) eller plattformadministratoren (detaljene i Administrasjon)
  sletter, alltid med en grunn, og bekrefter med navnet; eieren må ha totrinnsinnlogging. Uten
  utstedte fakturaer eller kreditnotaer slettes alt med en gang (kunder, produkter, utkast,
  ansatte, timer, vaktplan, revisjonsloggen, og filene ryddes av workeren). Utstedte fakturaer
  er regnskapsmateriale som skal oppbevares i fem år etter regnskapsårets slutt (bokføringsloven
  § 13), og er låst; da stenges organisasjonen i stedet: medlemmer, regnskapsførertilgang og
  invitasjoner fjernes, utkast slettes, gjentakelser, påminnelser og automatisk purring
  stoppes, og `har_funksjon` er av, så bakgrunnsjobbene hopper over den. Fakturaene, kundene og
  betalingene blir liggende til `oppbevares_til` (31.12. fem år etter siste faktura); selve
  slettingen etter det er ikke laget ennå. Hver sletting logges med grunnen, også når alt er
  borte, og vises under Administrasjon → Organisasjoner → Slettede organisasjoner. Sletter
  eieren, får plattformadministratorene e-post med grunnen; sletter plattformadministratoren,
  får eierne det (`0046_slett_organisasjon.sql`, `server/src/slettOrg.ts`)
- `lonnskjoringer`, `lonnsslipper`, `lonnslinjer` (`0065_lonn.sql`, `server/src/lonn.ts`,
  `server/src/lonnsberegning.ts`, `server/src/lonnsarter.ts`, siden «Lønn»): lønnskjøringen
  (funksjonen «Lønn», som bygger på ansatte og timer). Eier og administrator lager en kjøring
  for en måned (én vanlig per måned, og ekstra kjøringer, f.eks. for en bonus), og API-et regner
  ut en lønnsslipp for hver ansatt (`arbeidstaker`) med linjer etter lønnsartene: fastlønn for
  arbeidsdagene den ansatte er ansatt (og aktiv), timelønn, merarbeid og overtid fra de godkjente
  timene som ikke er lønnet (for hver uke det som er godkjent i alt minus det som er lønnet før,
  så overtiden regnes på hele uka; en uke hører til måneden den begynner i), faste tillegg per
  måned (for dagene) og per time, sykepenger i arbeidsgiverperioden (16 kalenderdager, etter fire
  ukers ansettelse) og omsorgsdager for sykt barn (10 i året) for dem med timelønn, med de
  planlagte timene (vakter og faste dager), og feriepenger for i fjor med trekk i lønn for ferie
  (årslønn / 260 per feriedag) for dem med fastlønn i juni (eller når det krysses av), og
  sluttoppgjør med feriepengene for den som slutter i måneden. Skattetrekket følger skattekortet
  på den ansatte (`ansatte.skattekort`, `skatt_tabell`, `skatt_prosent`, `skatt_frikort`,
  `skattekort_aar`): tabelltrekk etter Skatteetatens trekktabeller (`trekktabeller`, månedstabellene
  for lønn, som plattformadministratoren laster inn fra tekstfila under Administrasjon → Drift;
  `trekktabell_last`), halvt trekk i november eller desember, ikke tabelltrekk av feriepenger i
  ferieåret, og prosentsatsen i ekstra kjøringer og når tabellene for året mangler (med merknad);
  prosenttrekk; frikort til beløpet er brukt opp i året, deretter 50 %; og 50 % uten skattekort.
  OTP (`lonn_oppsett.otp_prosent`, minst 2 % opp til 12 G i året), opptjente feriepenger
  (`feriepenger_prosent`, 10,2 eller 12 %, og 2,3 % av inntil 6 G det året den ansatte fyller 60)
  og arbeidsgiveravgift per sone (`aga_sone`; i sone 1a redusert sats til den sparte avgiften i
  året når 850 000 kr) regnes på hver slipp, og satsene (G fra 1. mai) står i
  `lonnsberegning.ts`. Utbetalingsdatoen er lønnsdagen (`lonnsdag`) eller virkedagen før, og
  kjøringen viser fristene: skattetrekket til Skatteetaten første virkedag etter utbetalingen (fra
  2026) og arbeidsgiveravgiften den 15. annenhver måned. Linjene kan endres (en utregnet linje
  blir da manuell og regnes ikke ut på nytt; «Angre» gjør den utregnet igjen), fjernes og legges
  til, og skattetrekket kan settes for hånd; en ny utregning beholder det. Det som bør sjekkes
  (mangler skattekort, kontonummer eller lønn, frikortet brukt opp, syk etter arbeidsgiverperioden
  osv.), står som merknader på slippen. Når kjøringen godkjennes (`lonn_godkjenn`), regnes den ut
  på nytt, kontonummeret lagres på slippene, timene merkes som lønnet
  (`timeforinger.lonnskjoring_id`; lønnede timer kan ikke endres, avvises eller slettes), og
  kjøringen låses (`lonn_laast`); de ansatte med innlogging får varsel (varseltypen `lonn`) og ser
  lønnsslippen under «Lønnsslipper», med tallene hittil i år, også som PDF
  (`server/src/lonnsslippPdf.ts`). En godkjent kjøring kan åpnes igjen (`lonn_gjenapne`), og
  lastes ned som CSV (til regnskapet og nettbanken). Tall fra et tidligere lønnssystem per ansatt
  og år (`lonn_inngaende`: feriepengegrunnlag og utbetalte feriepenger for opptjeningsåret,
  trekkpliktig lønn og forskuddstrekk i året) tas med i feriepengene, frikortet og tallene hittil
  i år. Kjøringene ses av eier, administrator og regnskap; en ansatt ser bare sine egne slipper i
  godkjente kjøringer (`min_lonnsslipp`). En ansatt med lønnsslipper i godkjente kjøringer kan
  ikke slettes, og en organisasjon med godkjente kjøringer stenges i stedet for å slettes
  (oppbevares fem år etter siste utbetaling)
- Betalingsfila (`0076_lonn_betalingsfil.sql`, `server/src/betalingsfil.ts`): en godkjent kjøring
  lastes ned som ISO 20022-betalingsfil (pain.001.001.03, som alle norske banker tar imot, eller
  .09 under Innstillinger → Ansatte og timer) og lastes opp og godkjennes i nettbanken. Én betaling
  med alle de ansatte: lønn (`CtgyPurp` SALA, så bare dem med lønnstilgang i nettbanken ser
  beløpene), samlet bokført, på utbetalingsdatoen, fra lønnskontoen (`lonn_oppsett.lonnskonto`,
  ellers organisasjonens kontonummer) i banken med BIC-en i oppsettet (`bank_bic`). Hver ansatt
  med noe til utbetaling får nettolønnen til kontonummeret sitt (fra godkjenningen, ellers det på
  den ansatte nå; et ugyldig eller manglende kontonummer stopper fila med navnene).
  Meldings-ID-en er den samme for samme godkjenning, så banken avviser en fil som lastes opp to
  ganger. `lonn_betalingsfil` merker kjøringen (når, av hvem og hvor mange ganger; for de som
  ser lønnen), og appen advarer før fila lastes ned igjen. Fila valideres mot ISO-skjemaene i
  testene (`server/test/xsd`)
- Årsoversikten (`0075_lonn_aarsoversikt.sql`, `server/src/lonnAarsoversikt.ts`,
  `server/src/aarsoversiktPdf.ts`, `web/src/sider/LonnAar.tsx`): sammenstillingsoppgaven
  arbeidsgiveren skal gi hver ansatt innen 31. januar. Tallene er de godkjente kjøringene med
  utbetaling i året: lønnen gruppert etter beskrivelsen i a-meldingen (`AMELDING_NAVN` i
  `lonnsarter.ts`), forskuddstrekket, utgiftene og trekkene etter skatt, det som er utbetalt,
  feriepengegrunnlaget og opptjente feriepenger, OTP, tallene fra et tidligere lønnssystem og
  hver utbetaling. Den ansatte ser sin egen under «Lønnsslipper» (radtilgangen gir bare egne
  slipper fra godkjente kjøringer), også som PDF; eier, administrator og regnskap ser de ansatte i
  året under fanen «Årsoversikt» og laster ned én eller alle i én PDF. Den daglige jobben varsler
  de ansatte med innlogging fra 10. januar, når ingen kjøring for året står som utkast (senest
  25. januar), én gang (`lonn_aarsoversikt_varslet`, `aarsoversikt_klar`); eier og administrator
  kan varsle dem igjen. Trekktabellene: den daglige jobben sender plattformadministratorene
  (`ADMIN_EPOSTER`) e-post på mandager fra 10. desember om tabellene for neste år og i januar
  om årets, så lenge de mangler og en organisasjon med lønn har en ansatt med tabelltrekk
  (`trekktabeller_mangler`, `server/src/trekktabeller.ts`); Administrasjon → Drift viser det også
- Eget regnskap: `bilag`, `posteringer` og `bilagserier` (`0078_lonn_bokforing.sql`,
  `server/src/lonnBokforing.ts`, `server/src/lonnBokforingRuter.ts`, `web/src/sider/LonnBokforing.tsx`).
  Grunnlaget for regnskapsmodulen (plattformen kobles ikke til andre regnskapssystemer): bilag i
  nummerserier per år (serie L for lønn, med `neste_bilagsnummer`), med posteringer på
  kontonumre (positivt i debet, negativt i kredit) som må gå i null (utsatt kontroll ved commit).
  Ingen skriver, endrer eller sletter bilag direkte; de føres med funksjonene, og en feil rettes
  med et nytt bilag som reverserer det gamle (`reverser_bilag`: samme dato, motsatte beløp,
  `reverserer` og `reversert_av`), som bokføringsloven krever. Bilagene blir stående om kilden
  slettes. Lønnen er første kilde: når en kjøring godkjennes, regner API-et ut lønnsbilaget
  (`lagLonnsbilag`, i øre så det går i null) og fører det i samme transaksjon (`bokfor_lonn`, eier
  og administrator, ett gjeldende bilag per kjøring); `lonn_gjenapne` reverserer det. Bilaget har
  lønnen (5000), utgiftsgodtgjørelsen (7790), forskuddstrekket (2600), andre trekk (2690),
  nettolønnen til skyldig lønn (2930) eller bank (1920), arbeidsgiveravgiften (5400/2770),
  feriepengene (avsatt hver måned med avgiften, 5020/2940 og 5405/2785, og utbetalingen tatt fra
  avsetningen; eller kostnadsført når de utbetales) og eventuelt OTP (5945/2990); kontoene kan
  endres (`lonn_oppsett.bokforing_*`). Kjøringer godkjent før bokføringen kom, bokføres fra
  kjøringen. Rapporten «Lønnsbilag» viser bilagene (også til regnskapsføreren når kjøringen
  godkjennes). Lønnsbilagene ser de som ser lønnen
- A-meldingen (`0077_amelding.sql`, `server/src/amelding.ts`, `server/src/ameldingInnsending.ts`,
  `server/src/ameldingRuter.ts`, `web/src/sider/LonnAmelding.tsx`, `docs/amelding.md`): format
  2.3, for hver måned. Grunnlaget er de godkjente kjøringene med utbetaling i måneden (lønnen
  etter beskrivelsen i a-meldingen, forskuddstrekket per person og per utbetalingsdato, og
  arbeidsgiveravgiften per sone og sats, med OTP-premien for seg) og arbeidsforholdene som er
  aktive i måneden, også uten lønn. Arbeidsforholdet står på den ansatte (`yrkeskode`,
  `arbeidsforhold_type`, `arbeidstidsordning`, `aarsak_sluttdato`; `siste_lonnsendring` og
  `siste_stillingsendring` settes av triggeren `ansatt_endringsdatoer`), virksomheten
  (underenheten) og pensjonsinnretningen i `lonn_oppsett`. Kontrollen (`kontroller`) stopper
  meldingen når fødselsnummer, yrkeskode, virksomhet eller pensjonsinnretning mangler, og
  advarer om utkast, sluttdato uten årsak og permisjon over 14 dager. Eier og administrator
  bestiller (`bestill_amelding`, med totrinn): en ny melding erstatter den siste som er levert
  for måneden (`erstatter`), og en måned som venter, får ikke en ny. Bare workeren skriver
  `ameldinger` og leser fødselsnumrene: den lager fila (XML i bøtta, lenke i fem minutter) eller
  sender JSON-en til Skatteetatens API med en idempotensnøkkel, og henter tilbakemeldingen fra
  Dialogporten og Skatteetaten (første gang etter to minutter, så sjeldnere; hjerteslaget tar
  dem som ikke er sjekket på en halvtime i en uke). Status: lages, klar, levert (fila er merket
  som lastet opp, `amelding_levert`), sendt, mottatt, avvist eller feil; eier og administrator
  får varsel. Innsendingen er av til `AMELDING_INNSENDING` er satt; da ber systemet i Altinn også
  om tilgangspakken «A-ordningen», og kunder som er koblet til, utvider tilgangen med en
  endringsforespørsel (`be_om_utvidet_tilgang`, `skattekort_tilgang.pakker` og `endring_*`)
- Sykepenger og NAV (`0079_nav_sykepenger.sql`, `server/src/navSykepenger.ts`,
  `server/src/navInntektsmelding.ts`, `server/src/navRuter.ts`, `web/src/sider/LonnSykepenger.tsx`,
  `docs/nav.md`): NAVs API for sykepenger (sykepenger-im-lps-api) med systembruker i Altinn
  (tilgangspakken «Lønn med personopplysninger av særlig kategori») og et eget Maskinporten-token
  med scopet `nav:helseytelser/sykepenger`. Hjerteslaget legger organisasjonene som har tilgang og
  virksomhet, i kø hver time (`nav_henting` per type og virksomhet, fra siste løpenummer). Bare
  workeren dekrypterer fødselsnumrene og kobler sykmeldingene og forespørslene til de ansatte;
  fødselsnummeret lagres ikke. En sykmelding (`nav_sykmeldinger`) gir sykefravær for dagene som
  ikke alt er registrert: egenmeldingsdagene før den som egenmelding, og periodene som sykmelding
  med graden når den er gradert (`fravaer.sykmeldingsgrad` 1–99, `fravaer.nav_sykmelding`);
  avventende sykmelding, behandlingsdager og reisetilskudd blir merknader. NAVs forespørsler om
  inntektsmelding (`nav_forespoersler`: AKTIV, BESVART eller FORKASTET) hentes med inntekten i
  a-ordningen de tre månedene før inntektsdatoen (`/v1/inntekt`), og statusen på dem som venter,
  sjekkes. Forslaget til inntektsmelding (`forslagTilInntektsmelding`) har arbeidsgiverperioden
  (de første 16 dagene i sykefraværstilfellet, fra NAVs perioder og fraværet i appen; uten fire
  uker i jobben med redusert lønn og begrunnelsen), månedsinntekten (snittet i a-ordningen, ellers
  fra de godkjente lønnskjøringene uten overtid, bonus og feriepenger), endringsårsaker appen ser
  (lønns- og stillingsendring, nyansatt, ferie, sykefravær, permisjon) og refusjonen når
  arbeidsgiveren betaler lønnen under sykdom (`lonn_oppsett.sykepenger_refusjon`), med stopp når
  den ansatte slutter. Skjemaet (`inntektsmeldingSkjema`) følger NAVs regler, og forespørselen
  kontrolleres (det NAV ber om). Eier og administrator sender (`bestill_inntektsmelding`: ikke
  mens en sendes eller NAV kontrollerer den, og ikke når forespørselen er trukket tilbake);
  workeren henter forespørselen på nytt, sender som ny eller korrigering (NAV kjenner igjen en
  som er sendt før), og henter statusen (sendt, godkjent eller avvist med årsaken). Lønnen under
  sykdom etter arbeidsgiverperioden: forskutterer arbeidsgiveren, går fastlønnen som vanlig og
  timelønte får de planlagte timene (`sykepenger_nav`); ellers trekkes fastlønnen for virkedagene
  (`trekk_sykdom`). Gradert sykmelding gir den sykmeldte delen av timene i arbeidsgiverperioden.
  Rapporten «Sykepenger og refusjon» (`lonn.sykepenger`) har dagene i og etter
  arbeidsgiverperioden og den beregnede refusjonen. Henting og innsending er av til
  `NAV_SYKEPENGER` er satt; da ber systemet i Altinn også om tilgangspakken «Lønn med
  personopplysninger av særlig kategori», og kunder som er koblet til, utvider tilgangen som for
  a-meldingen
- `skattekort_tilgang`, `altinn_system` og skattekortet på `ansatte` (`0068_skattekort_fra_skatteetaten.sql`,
  `server/src/skattekort.ts`, `server/src/altinn.ts`, `server/src/maskinporten.ts`,
  `docs/skattekort.md`): skattekort fra Skatteetaten («Skattekort til arbeidsgiver») med
  systembruker i Altinn. Leverandøren (Medinnova AS) har én Maskinporten-klient og ett system i
  Altinns systemregister (tilgangspakken «Lønn»), som plattformadministratoren registrerer under
  Administrasjon → Drift (`altinn_system`). Eier og administrator ber om tilgang
  (`be_om_skattekorttilgang`, med totrinn); workeren lager forespørselen i Altinn, og daglig
  leder godkjenner den (`skattekort_tilgang`: venter, ny, godkjent, avslått, avvist, utløpt
  eller feil). Hjerteslaget sjekker forespørsler som venter (hvert andre minutt den første timen,
  så hver halvtime). Med godkjent tilgang henter workeren et token for organisasjonens
  systembruker, bestiller skattekortene til de ansatte med fødselsnummer (høyst 1000 om gangen)
  og henter svaret (204 til det er klart; ellers i en ny oppgave). Skattekortet lagres på den
  ansatte med alle trekkodene (`skattekort_trekk`), svaret (`skattekort_resultat`),
  tilleggsopplysningene og hvor det kom fra (`skattekort_kilde`: manuell eller skatteetaten);
  lønnskjøringen bruker trekket for lønn fra hovedarbeidsgiver, eller fra biarbeidsgiver når
  den ansatte er merket slik (`biarbeidsgiver`, regnes om når valget endres). Uten skattekort
  trekkes 50 %, uten trekkplikt er det frikort uten beløpsgrense. Hver morgen hentes
  endringene, og de som mangler skattekortet for året (eller ikke er hentet på en uke); et
  skattekort for et tidligere år erstatter aldri et nyere
- Rapportmodulen (`0070_rapportmodul.sql`, `server/src/rapportmodul.ts`, siden «Rapporter»):
  én side for rapportene fra alle modulene, med en fane per modul (Faktura, Personal, Lønn og
  de som kommer) og Utsending. Hver modul melder inn rapportene sine (`Rapportdef` i
  `RAPPORTER`: id `modul.navn`, funksjonen og tilgangen rapporten krever, valgene periode,
  termin, år eller ingen, og en funksjon som gir kolonnene og radene); visningen, summene,
  CSV (semikolon, BOM, norske desimaler) og PDF (liggende med mange kolonner) er felles. Lista
  viser bare rapportene organisasjonen har funksjonen til og brukeren har tilgang til
  (fakturarapportene for alle med lesetilgang, timer, timebank, ansatte og lønn for eier,
  administrator og regnskap, fravær og feriebank for eier og administrator). Faktura: kundereskontro, mva per
  termin, salg per måned, fakturajournal (med alle kolonnene fra den gamle eksporten) og
  innbetalinger (`server/src/rapporter.ts`). Personal: timer per ansatt (ordinære, overtid uke
  for uke, merarbeid og uten overtid), timeliste, fravær, feriebank, timebank, ekstratimer og
  ansatte (`server/src/personalRapporter.ts`). Lønn, fra de godkjente kjøringene: lønnsjournal, sum
  per lønnsart (grunnlaget for bokføringen), skattetrekk og arbeidsgiveravgift per termin med
  fristene, feriepengeliste, årsoversikt og OTP (`server/src/lonnRapporter.ts`).
  `rapport_oppsett`: regnskapsføreren (høyst 10 adresser), om lønnsjournalen og summen per
  lønnsart skal sendes når en lønnskjøring godkjennes, og månedsrapportene som sendes den 1.
  for forrige måned (terminrapporter når terminen er slutt, årsrapporter i januar). Bare eier og
  administrator endrer det, med totrinn, og nye mottakere gir hendelsen
  `organisasjon.rapportmottakere_endret`, som sender e-post til alle eierne (mottakerne får
  lønn og personopplysninger). Rapportene sendes av workeren (oppgaven `rapport-send`) som PDF
  og CSV på e-post, med svar til den som sendte; det som er sendt, logges i
  `rapport_utsendinger` (bare workeren skriver), og måneden månedsrapportene er lagt i kø for,
  står i `rapport_maanedsutsendinger`, så hver måned sendes én gang
- `utboks`: hendelser skrevet i samme transaksjon, publisert til Pub/Sub
- `revisjonslogg`: alle endringer og regnskapsføreres oppslag

### Roller

| Handling | eier | admin | fakturerer | regnskap | les | ansatt |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| Lese fakturadata (kunder, fakturaer, innbetalinger, rapporter) | ✓ | ✓ | ✓ | ✓ | ✓ | |
| Kunder, produkter, utkast, gjentakelser | ✓ | ✓ | ✓ | | | |
| Utstede, sende, kreditere | ✓ | ✓ | ✓ | | | |
| Registrere betaling og refusjon | ✓ | ✓ | ✓ | ✓ | | |
| Innstillinger, kontonummer, medlemmer, integrasjoner, regnskapsfører | ✓ | ✓ | | | | |
| Se ansatte, hele vaktplanen (også utkast), tavla, fraværet og alle timer | ✓ | ✓ | | ✓ | | |
| Se den publiserte vaktplanen (dag, uke og måned) og tavla (kollegaenes fravær bare som «F») | ✓ | ✓ | ✓¹ | ✓ | ✓¹ | ✓² |
| Endre ansatte, gi innlogging, planlegge og publisere vakter, gi bort og bytte vakter for de ansatte, sette inn vikarer, styre tavla, registrere fravær, godkjenne og avvise timer | ✓ | ✓ | | | | |
| Se egne vakter og plasser og ta ledige, melde seg syk, føre og levere egne timer | ✓¹ | ✓¹ | ✓¹ | ✓¹ | ✓¹ | ✓ |
| Legge beskjeder til rollene eller alle, og se dem som er til en selv | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Se alle beskjedene | ✓ | ✓ | | ✓ | | |
| Slette andres beskjeder | ✓ | ✓ | | | | |
| Se lønnskjøringene og alle lønnsslippene, og laste ned betalingsfila | ✓ | ✓ | | ✓ | | |
| Lage, endre, godkjenne og åpne lønnskjøringer, skattekort og tall fra tidligere lønnssystem | ✓ | ✓ | | | | |
| Se lønnsbilagene | ✓ | ✓ | | ✓ | | |
| Endre kontoene for lønnsbilaget, og bokføre en kjøring som ble godkjent før bokføringen kom | ✓ | ✓ | | | | |
| Se a-meldingene (månedene, grunnlaget og avvikene) | ✓ | ✓ | | ✓ | | |
| Lage og sende a-meldingen, laste ned fila og merke den som lastet opp | ✓ | ✓ | | | | |
| Se sykmeldingene og forespørslene fra NAV, sende inntektsmeldingen og rapporten «Sykepenger og refusjon» | ✓ | ✓ | | | | |
| Se egne sykmeldinger fra NAV | ✓¹ | ✓¹ | ✓¹ | ✓¹ | ✓¹ | ✓ |
| Se egne lønnsslipper og egen årsoversikt (godkjente kjøringer) | ✓¹ | ✓¹ | ✓¹ | ✓¹ | ✓¹ | ✓ |
| Se årsoversiktene til alle, og laste dem ned | ✓ | ✓ | | ✓ | | |
| Varsle de ansatte om årsoversikten | ✓ | ✓ | | | | |
| Se timebanken til alle, med verdien | ✓ | ✓ | | ✓ | | |
| Godkjenne og registrere avspasering, justere timebanken og betale ut timer fra den | ✓ | ✓ | | | | |
| Se egen timebank og søke om avspasering | ✓¹ | ✓¹ | ✓¹ | ✓¹ | ✓¹ | ✓ |
| Rapporter: fakturarapportene | ✓ | ✓ | ✓ | ✓ | ✓ | |
| Rapporter: timer, timebank, ansatte og lønn | ✓ | ✓ | | ✓ | | |
| Rapporter: fravær og feriebank | ✓ | ✓ | | | | |
| Sende rapporter og endre utsendingen til regnskapsføreren | ✓ | ✓ | | | | |

¹ Når brukeren også er koblet til et ansattkort (eieren kan for eksempel føre egne timer).
² Så lenge den ansatte er aktiv (ikke etter at de har sluttet).

En regnskapsfører med tilgangen «bokfør» får rollen `regnskap` hos klienten. Med
tilgangen «les» får regnskapsføreren rollen `les`. Tilgangen kan ha utløpsdato, og
begge parter kan trekke den. Byråets ansatte med rollen `ansatt` får ikke tilgang til
klientene.

Rollen `ansatt` ser bare organisasjonens navn, sitt eget medlemskap, sitt eget ansattkort,
den publiserte vaktplanen og tavla (se under), vaktbyttene de er med i og
de åpne tilbudene fra kolleger med samme rolle (`vaktbytte_liste`), sitt eget fravær (med typen),
sine egne timer, sin egen timebank og sine søknader om avspasering, og beskjedene til rollen sin
og til alle (`ser_beskjed`; `faktura.kan(org,
'medlem')`, `faktura.kan(org, 'plan')`, `faktura.er_meg` og `faktura.min_ansatt`), aldri
fakturadata, andre medlemmer, kollegaenes ansattkort, lønn, timer, timebank, notater og typen fravær,
utkast i vaktplanen eller revisjonsloggen. Varsler til hele organisasjonen og
Google Disk-kopier går ikke til ansatte, og appen viser dem bare Timer, Vakter (Mine vakter,
Ledige vakter og Bytter, og fanene Vaktplan og Tavle), Vaktplan og Tavle som egne punkter i
sidemenyen (lenker til de samme fanene), Ferie, Lønnsslipper (sine egne, når kjøringen er godkjent),
Beskjeder og Innstillinger (egen konto og app).

De ansatte ser planen (`0063_ansatte_ser_planen.sql`): `faktura.kan(org, 'plan')` er eier,
administrator og regnskap, og de aktive ansatte med innlogging (`min_ansatt`; ikke etter at de har
sluttet, og ikke den som bare fakturerer). De ser de publiserte vaktene (ikke utkast), de faste
arbeidsdagene og dagene gitt bort i et vaktbytte, plassene på tavla og den faste oppgaven, og
rollene med behovet (radsikkerheten i `vakter`, `arbeidsplaner`, `arbeidsplan_dager`,
`arbeidsplan_fri`, `tavle_plasseringer`, `tavle_fast_oppgave` og `ansattgrupper`). Fraværet og
ansattregisteret er låst som før; planen leser dem gjennom to view: `fravaer_plan` (hvem som er
borte når, med typen og notatet bare for dem som ser dem, ellers «fravaer») og `ansatte_plan`
(navn, forkortelse, rolle, ansettelsesperioden og om de er ansatt; stillingen, stillingsprosenten
og ansettelsestypen bare for dem som ser de ansatte og for den ansatte selv). Viewene leser
tabellene som eieren, så det er where-leddet i dem som avgjør hvem som ser hvem. API-et gir de
ansatte personene i planen fra `/kolleger` (ikke `/ansatte`), notatet på en kollegas vakt er tomt,
og advarslene, timene per uke og ekstratimene får bare de som ser de ansatte.
`mine_organisasjoner.ser_planen` forteller appen om Vaktplan og Tavle skal vises (fanene og
punktene i sidemenyen). AI-assistenten åpner vaktplanen, måneden og tavla også for de ansatte
(`kan.plan`).

### Sikkerhet i databasen

- API-et setter `SET LOCAL app.bruker_id` i hver transaksjon. RLS-policyene bruker
  `faktura.kan(org_id, handling)`. Appen sjekker tilgang selv i tillegg.
- Kolonnerettigheter: appen kan ikke sette status, nummer, summer, KID eller kopiene av
  selger og kunde. Det gjør bare funksjonene `utsted`, `krediter`, `registrer_betaling`
  og `registrer_refusjon`.
- En utstedt faktura, linjene og vedleggene dens er låst med triggere, også for tabelleieren.
- Workeren logger inn som medlem av `faktura_system` og ser alle organisasjoner.
- Endring av kontonummer gir hendelsen `organisasjon.kontonr_endret`. Workeren varsler
  alle eiere på e-post.

### Misbruksvern uten BankID

Nye organisasjoner har status `ny`, og grensen er 20 fakturaer og 50 000 kr per måned.
Workeren verifiserer organisasjonen med `faktura.sett_verifisering` etter én av disse
kontrollene:

1. organisasjonsnummeret slås opp i Enhetsregisteret, og foretaket er aktivt
2. brukerens bekreftede e-postadresse er nøyaktig den som står på foretaket i
   Enhetsregisteret (også Gmail o.l.), **eller**
3. e-postdomenet til brukeren samsvarer med foretakets domene, **eller**
4. en kode sendes til e-postadressen som er registrert i Enhetsregisteret, **eller**
5. en administrator godkjenner manuelt.

Rollene i Brreg (daglig leder, styreleder, innehaver, deltakere, kontaktperson o.l.) slås
opp samtidig. Står navnet brukeren oppgir som en rolleinnehaver, får brukeren beskjed om det,
det kommer med i forespørselen om manuell godkjenning, og adminsiden viser rollene med treff
på medlemmenes navn. Navnet alene verifiserer ikke, siden det kan skrives av hvem som helst;
helt automatisk verifisering av personer krever BankID (bekreftet navn og fødselsdato mot
rollene i Brreg).

Adminsiden viser ikke hvor mye organisasjonene fakturerer for (ingen beløp, heller ikke
utestående), bare hvor mange fakturaer de har sendt, og hvor mange av dem som gikk på e-post
og som EHF (`0042_admin_uten_belop.sql`).

Et organisasjonsnummer kan bare være verifisert hos én organisasjon. Andre grenser:
maks fem uverifiserte organisasjoner per bruker, reCAPTCHA Enterprise ved registrering,
og hastighetsgrenser i API-et.

## Forbedringer fra MedSide-modulen

- Delvis kreditering per linje. Originalen blir `kreditert` først når alt er kreditert.
- Inaktive kunder faktureres ikke fra gjentakelser, og gjentakelsen slås av.
- Intervallene måned, kvartal og år. Forfallsdagen holdes (31.01 → 28.02 → 31.03).
- Bankimport er idempotent: samme `ekstern_ref` registreres bare én gang.
- PDF-er bygges med flere sider (HTML → PDF i workeren).

## Veikart

1. **Grunnmur** (ferdig): skjema, RLS, regler, tester, Terraform, CI/CD
2. **Fakturering**: API, worker (PDF, e-post via Cloud Tasks), nettapp med kunder,
   produkter, utkast, utstedelse, kreditnota, betaling og refusjon
3. **Tillit**: Brønnøysund-oppslag, verifiseringsflyt, MFA påkrevd for utstedelse og
   kontonummer, reCAPTCHA, varsling ved endring av kontonummer
4. **Regnskapsfører og Google Disk**: byrå-dashboard, invitasjoner, Drive (`drive.file`)
   med kopi av PDF-er i `Fakturaer/ÅÅÅÅ/`
5. **Gjentakende fakturaer og kundeportal**
6. **Penger inn og eget regnskap**: bank via aggregator (KID-matching), OCR-fil, purring,
   og vår egen regnskapsmodul (ingen kobling til andre regnskapssystemer): kontoplan per
   organisasjon, hovedbok med bilagene fra fakturaene, innbetalingene og lønnen (grunnlaget,
   `bilag` og `posteringer`, er på plass med lønnsbilagene), saldobalanse, resultat og
   balanse, mva-melding, årsoppgjør, åpent API, webhooks og SAF-T
7. **EHF/Peppol** via aksesspunkt, betalingslenker (Vipps/Stripe Connect) og
   abonnementer for plattformens egne kunder
8. ~~**Passkeys**~~ Ferdig: WebAuthn i API-et, nøkler i Postgres, innlogging via Firebase custom token med kravet `passkey` (teller som totrinn)
9. **Ansatte og lønn**, i steg:
   1. ~~Ansatte og timer~~ Ferdig: ansattregister, egen innlogging for ansatte, timeføring
      med overtid og merarbeid, levering og godkjenning med push-varsler
   2. ~~Vaktplan~~ Ferdig: vakter per uke og ansatt med publisering og varsler, ledige vakter
      som de ansatte tar, vaktbytte mellom kolleger med samme rolle (med eller uten
      godkjenning), kopiering av uker, advarsler etter arbeidsmiljøloven, og timer
      ført fra vakten. Tavle (ressursfordeling i egne faser og oppgaver med behov, og
      rullering som fordeler de ansatte etter tur),
      fravær (sykdom meldt av den ansatte, ferie, permisjon og kurs), vikarer,
      bemanningskalender med de ansatte i grupper mot behovet, faste arbeidsdager per
      ansatt og rapport over ekstratimer (PDF og CSV)
   3. ~~Lønnskjøring~~ Ferdig: lønnsarter, skattetrekk etter skattekortet (tabell med
      Skatteetatens trekktabeller, prosent eller frikort), feriepenger og ferietrekk, OTP,
      arbeidsgiveravgift per sone, sykepenger i arbeidsgiverperioden, sluttoppgjør,
      godkjenning med låsing og lønnsslipp som PDF
   4. Rapportering: ~~lønnsbilag i eget regnskap~~ (ferdig: serie L, reverseres når kjøringen åpnes
      igjen), ~~a-melding~~ (ferdig: fil til opplasting på skatteetaten.no, og innsending
      til Skatteetatens API med systembruker når tilgangen er gitt), ~~oversikt over skattetrekk og
      arbeidsgiveravgift, feriepengeliste og årsoversikt for den ansatte~~ (ferdig). ~~Skattekort fra
      Skatteetaten~~ Ferdig (systembruker i Altinn; slås på når Maskinporten er satt opp).
      OTP rapporteres i a-meldingen med pensjonsinnretningens organisasjonsnummer
   5. Utbetaling: ~~betalingsfil (pain.001) til nettbanken~~ (ferdig), direkte bankintegrasjon senere
