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
  `varslet_at`), og de godkjenner eller avviser under Administrasjon → Venter; brukeren får
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
  e-posten. Administratoren godkjenner med de modulene eller andre (Administrasjon → Venter),
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
  dag (`HENTETIDER` i `bank.ts`, kl. 06, 12 og 18 norsk tid, innenfor PSD2-grensen på fire
  hentinger i døgnet uten brukeren; «Hent nå» kommer i tillegg). Hver hentetid tas én gang per
  bank (atomisk, også med flere instanser), og en som ble gått glipp av, tas igjen før neste.
  Appen viser hentetidene, neste henting og når det sist ble hentet. Innbetalingene kobles
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
  kommandoer som tekst: Gemini
  velger handling og fyller ut feltene, serveren slår opp og svarer (betalinger, utestående),
  og alt som endrer noe (sende faktura eller utkast, registrere betaling, purre) blir forslag
  som appen utfører med de vanlige rutene når brukeren bekrefter. Avviser Gemini svarskjemaet
  (400, eller 500 for innviklede skjemaer), prøver serveren én gang til uten det, med
  skjemaet i systemteksten; svaret tilpasses skjemaet og sjekkes som ellers. Plattform-
  administratorene ser svaret fra Google i feilmeldingene, og «Test AI» på adminsiden prøver
  de samme forespørslene som fakturautkast og assistenten, og tale til tekst med et stille
  opptak (der AI-en ikke skal finne noen tale)
- `lonn_oppsett`, `ansatte`, `timeforinger`: ansatte og timer, slått på per organisasjon
  (Innstillinger → Ansatte og timer). Ansattregisteret har personalia, ansettelse og lønn.
  Fødselsnummeret krypteres med KMS i API-et, som ikke kan lese det igjen (bare workeren kan,
  til lønn og a-melding senere); revisjonsloggen sier bare at det er registrert eller endret.
  En ansatt kan få egen innlogging: invitasjonen (`inviter_ansatt`) gir rollen `ansatt` og
  kobler brukeren til ansattkortet, og er e-posten alt med i organisasjonen, kobles den med
  en gang. Timene føres med fra og til (over midnatt går fint) og pause, eller som antall
  timer. Den ansatte leverer uka (`lever_timer`), eier eller administrator godkjenner eller
  avviser med en grunn (`godkjenn_timer`, `avvis_timer`), og begge får push-varsel. Status
  endres bare gjennom funksjonene, og leverte timer er låst for den ansatte. Overtiden regnes
  ut per uke (`arbeidstid.ts`): timene over grensen per dag, så timene over grensen per uke av
  resten, med tillegg (arbeidsmiljøloven: 9 og 40 timer, minst 40 %; grensene kan endres for
  tariffavtaler). Føringer merket som overtid teller i sin helhet med sitt tillegg, og
  ordinære timer over avtalt arbeidstid er merarbeid
- `vakter`: vaktplanen. Eier og administrator planlegger vakter per dag og ansatt (fra–til,
  pause, oppgave og notat); vaktene er utkast til de publiseres (`publiser_vakter`), og da
  får hver ansatt én push-melding om sine nye vakter. Endringer i og fjerning av publiserte
  vakter varsles til dem det gjelder. En vakt uten ansatt er ledig: aktive ansatte ser
  publiserte ledige vakter og kan ta en (`ta_vakt`: raden låses, så den første får den;
  ikke passerte vakter, og ikke om den overlapper en av deres egne), og eier og administrator
  får beskjed. En uke kan kopieres til neste (eller flere uker) som utkast, uten dobbeltvakter
  og uten ansatte som har sluttet. Mens man planlegger, viser appen advarsler etter
  arbeidsmiljøloven (`vaktregler.ts`): under 11 timer hvile mellom arbeidsdagene (delte vakter
  samme dag er én arbeidsdag), under 35 timer sammenhengende fri i uka, overtid per dag og
  uke etter grensene i oppsettet, overlappende vakter og vakter utenfor ansettelsen. Timene
  kan føres fra vakten (`timeforinger.vakt_id`), og timelisten og godkjenningen viser hvor
  mange timer som var planlagt
- `fravaer`: sykdom, sykt barn, ferie, permisjon, kurs og annet fravær per ansatt (fra og med, til
  og med). Eier og administrator registrerer alt; den ansatte melder selv sykdom (fra og med
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
  borte, kan ikke plasseres, og plassene den har, teller ikke. Regnskap ser tavla, og den
  ansatte ser sine egne plasser under Mine vakter
- `arbeidsplaner` og `arbeidsplan_dager`: den faste arbeidsplanen til en ansatt, lagt inn i
  ansattskjemaet ved stillingsprosenten: ukedagene den ansatte jobber, med klokkeslett (og
  pause) eller som hel dag (en femtedel av arbeidstiden i full stilling, vanligvis 7,5 timer),
  gjeldende fra en dato. En endring blir en ny plan fra en dato, så tidligere måneder beholder
  planen som gjaldt da; en plan uten dager betyr ingen faste dager fra da. En fast dag er en
  dag i planen uten vakt (en vakt samme dag gjelder i stedet), og den vises i
  bemanningskalenderen, vaktplanen, på tavla og i timelisten (med «Før timer»), og teller som
  planlagt arbeid. Vikar for en fast dag gir en vakt etter planen (`POST /vakter/fra-plan`) som
  vikaren dekker. Ekstratimer (`server/src/arbeidsplan.ts`): med plan timene utover planen
  den dagen; uten plan timene utover avtalt arbeidstid i uka (alle timene for
  tilkallingsvikarer); vakter den ansatte er borte fra, teller ikke. Rapporten over
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
- `ansattgrupper` og `ansatte.gruppe_id`: grupper av ansatte (f.eks. sekretærer og leger) med
  hvor mange som trengs på jobb per dag. Bemanningskalenderen (i appen, fra de faste
  arbeidsplanene, vaktplanen og fraværet) viser måneden med datoene nedover og de ansatte
  bortover, gruppe for gruppe: på jobb (✓), fri (–), fravær (for eier og administrator Fe
  ferie, S syk, SB sykt barn, P permisjon, K kurs, A annet; for andre bare F) eller
  ekstratimer, nederst ekstratimene i måneden per ansatt,
  og til høyre hvor mange som er på jobb i hver gruppe mot behovet, vakter uten vikar og ledige
  vakter. Grupper kan lages fra stillingene
- `funksjoner` og `org_funksjoner`: hvilke funksjoner hver organisasjon har tilgang til (EHF,
  bank, AI, gjentakende fakturaer, flere fakturaer, påminnelser, rapporter, import, Google
  Disk, ansatte og timer, vaktplan og bemanning; vaktplanen bygger på ansatte og timer),
  gruppert i modulene Faktura og Bemanning. Fakturaer, kunder og produkter har alle. Plattformadministratoren slår dem av og på under
  Administrasjon → Funksjoner (eller i detaljene for en organisasjon) og velger standarden
  for nye organisasjoner; de som fantes da funksjonene kom, beholdt alt. API-et avviser rutene
  til en funksjon organisasjonen ikke har (`server/src/funksjoner.ts`, med svaret husket et
  halvt minutt), bakgrunnsjobbene hopper over organisasjonen (bankhenting, gjentakende
  fakturaer, EHF-sending, som da går på e-post, påminnelser og Google Disk), og appen
  skjuler det som ikke er slått på (`mine_organisasjoner.funksjoner`)
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
| Se ansatte, hele vaktplanen, tavla, fraværet og alle timer | ✓ | ✓ | | ✓ | | |
| Endre ansatte, gi innlogging, planlegge og publisere vakter, sette inn vikarer, styre tavla, registrere fravær, godkjenne og avvise timer | ✓ | ✓ | | | | |
| Se egne vakter og plasser og ta ledige, melde seg syk, føre og levere egne timer | ✓¹ | ✓¹ | ✓¹ | ✓¹ | ✓¹ | ✓ |

¹ Når brukeren også er koblet til et ansattkort (eieren kan for eksempel føre egne timer).

En regnskapsfører med tilgangen «bokfør» får rollen `regnskap` hos klienten. Med
tilgangen «les» får regnskapsføreren rollen `les`. Tilgangen kan ha utløpsdato, og
begge parter kan trekke den. Byråets ansatte med rollen `ansatt` får ikke tilgang til
klientene.

Rollen `ansatt` ser bare organisasjonens navn, sitt eget medlemskap, sitt eget ansattkort,
sine egne publiserte vakter, de publiserte ledige vakter, sitt eget fravær, sine egne plasser
på tavla (og fasene og oppgavene) og sine egne timer (`faktura.kan(org, 'medlem')`,
`faktura.er_meg` og `faktura.min_ansatt`), aldri fakturadata, andre medlemmer, andres vakter
og fravær eller revisjonsloggen. Varsler til hele organisasjonen og
Google Disk-kopier går ikke til ansatte, og appen viser dem bare Timer, Vakter og
Innstillinger (egen konto og app).

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
6. **Penger inn og regnskap**: bank via aggregator (KID-matching), OCR-fil, purring,
   adaptere for Fiken, Tripletex, PowerOffice Go og Visma, åpent API, webhooks, SAF-T
7. **EHF/Peppol** via aksesspunkt, betalingslenker (Vipps/Stripe Connect) og
   abonnementer for plattformens egne kunder
8. ~~**Passkeys**~~ Ferdig: WebAuthn i API-et, nøkler i Postgres, innlogging via Firebase custom token med kravet `passkey` (teller som totrinn)
9. **Ansatte og lønn**, i steg:
   1. ~~Ansatte og timer~~ Ferdig: ansattregister, egen innlogging for ansatte, timeføring
      med overtid og merarbeid, levering og godkjenning med push-varsler
   2. ~~Vaktplan~~ Ferdig: vakter per uke og ansatt med publisering og varsler, ledige vakter
      som de ansatte tar, kopiering av uker, advarsler etter arbeidsmiljøloven, og timer
      ført fra vakten. Tavle (ressursfordeling i egne faser og oppgaver med behov),
      fravær (sykdom meldt av den ansatte, ferie, permisjon og kurs), vikarer,
      bemanningskalender med de ansatte i grupper mot behovet, faste arbeidsdager per
      ansatt og rapport over ekstratimer (PDF og CSV)
   3. Lønnskjøring: lønnsarter, skattetrekk (tabell eller prosent fra skattekortet),
      feriepenger, OTP, arbeidsgiveravgift per sone, sykepenger og lønnsslipp som PDF
   4. Rapportering: a-melding som fil til Altinn, oversikt over skattetrekk og
      arbeidsgiveravgift, feriepengeliste og årsoversikt for den ansatte
   5. Utbetaling: betalingsfil (pain.001) til nettbanken først, direkte bankintegrasjon senere
