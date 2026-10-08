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
  helseopplysninger: bare eier, administrator, regnskap og den ansatte selv ser det, også i
  revisjonsloggen
- `vakter.vikar_for`: en vikar settes inn som en egen vakt med samme tid og oppgave som vakten
  til den som er borte (den beholder sin). Vikarvakten publiseres med en gang med varsel til
  vikaren, tar over plassene på tavla, og kopieres ikke til neste uke. Vikaren kan være en ny
  ansatt (tilkalling, timelønn) lagt inn fra skjemaet
- `tavle_faser`, `tavle_oppgaver`, `tavle_behov` og `tavle_plasseringer`: tavla
  (ressursfordelingen). Organisasjonen lager selv fasene (radene, f.eks. forvakt, mellomvakt
  og senvakt eller før og etter lunsj, med tidsrom) og oppgavene (kolonnene, f.eks. telefon,
  resepsjon og lab), med hvor mange som trengs i hver oppgave, eventuelt forskjellig per fase.
  Ressursene en dag er de som har vakt i vaktplanen, og hver hører til fasene vakten
  overlapper. Eier og administrator plasserer dem i oppgavene (én oppgave per ansatt og fase;
  dra og slipp på PC, trykk på mobil) og kan kopiere plassene fra en annen dag. Den som er
  borte, kan ikke plasseres, og plassene den har, teller ikke. Regnskap ser tavla, og den
  ansatte ser sine egne plasser under Mine vakter
- `ansattgrupper` og `ansatte.gruppe_id`: grupper av ansatte (f.eks. sekretærer og leger) med
  hvor mange som trengs på jobb per dag. Bemanningskalenderen (i appen, fra vaktplanen og
  fraværet) viser måneden med datoene nedover og de ansatte bortover, gruppe for gruppe: på
  jobb (✓), fri (–), fravær (F ferie, S syk, SB sykt barn, P permisjon, K kurs, A annet) eller
  ekstratimer (timene utover avtalt arbeidstid i uka, alle for tilkallingsvikarer), og til
  høyre hvor mange som er på jobb i hver gruppe mot behovet, vakter uten vikar og ledige
  vakter. Grupper kan lages fra stillingene
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
      fravær (sykdom meldt av den ansatte, ferie, permisjon og kurs), vikarer og
      bemanningskalender med de ansatte i grupper mot behovet
   3. Lønnskjøring: lønnsarter, skattetrekk (tabell eller prosent fra skattekortet),
      feriepenger, OTP, arbeidsgiveravgift per sone, sykepenger og lønnsslipp som PDF
   4. Rapportering: a-melding som fil til Altinn, oversikt over skattetrekk og
      arbeidsgiveravgift, feriepengeliste og årsoversikt for den ansatte
   5. Utbetaling: betalingsfil (pain.001) til nettbanken først, direkte bankintegrasjon senere
