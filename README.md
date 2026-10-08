# Faktura

Fakturaplattform der foretak oppretter konto og fakturerer sine kunder. Bygget på
Google Cloud. Kjernen er portert fra fakturamodulen i MedSide og gjort flerbruker
(`org_id` overalt).

Funksjoner: produkter, kunder, fakturaer og kreditnotaer (hel eller delvis),
vedlegg på fakturaer, EHF (Peppol) gjennom egen Recommand-konto, betaling og refusjon, gjentakende fakturaer, regnskapsførertilgang på tvers av
klienter, Google Disk, ansatte med vaktplan, tavle, fravær, timeføring og godkjenning, og et adapterlag for
bank og regnskapssystemer.

## Status

| Del | Status |
|---|---|
| Databaseskjema, regler, RLS og tester (`db/`) | Ferdig, testene er grønne |
| Infrastruktur som kode (`infra/terraform`) | Ferdig |
| CI (databasetester, Terraform) og utrulling med GitHub Actions | Ferdig |
| Infrastruktur rullet ut i `hi4-faktura-prod` | Ferdig |
| API og worker (`server/`, TypeScript på Cloud Run) | Ferdig, testet mot Postgres |
| Nettapp (`web/`, React + Vite) på `faktura.hi4.no` | I drift |
| Innlogging: passord, TOTP-MFA og passkeys | Ferdig |
| Verifisering av organisasjoner og adminside | Ferdig (admin via GitHub-variabelen `ADMIN_EPOSTER`) |
| Godkjenning av nye kontoer: forespørselen går til administratorene når e-postadressen er bekreftet, med modulene brukeren krysset av for (Faktura, Bemanning og de som kommer), og kontoen kommer ikke inn før den er godkjent | Ferdig (Administrasjon → Oversikt) |
| Sletting av organisasjoner, alltid med grunn: alt slettes, eller organisasjonen stenges når utstedte fakturaer må oppbevares (bokføringsloven) | Ferdig (eieren under Innstillinger → Organisasjon, plattformadministratoren i Administrasjon) |
| Funksjoner per organisasjon: administratoren velger hvilke organisasjoner som har EHF, bank, AI, ansatte og timer, vaktplan osv., og standarden for nye | Ferdig (Administrasjon → Organisasjoner, i organisasjonen) |
| Gjentakende fakturaer, purring og inkassovarsel | Ferdig |
| Makstak: kunden faktureres aldri mer enn et avtalt beløp; alle produktene står på fakturaen, og et fratrekk tar summen ned. Makstaket kan stå på kunden og kommer da på nye fakturaer, flere på én gang og gjentakelser, og kan fjernes per faktura | Ferdig |
| Påminnelser om å lage fakturaer (push og e-post), for beløp som varierer | Ferdig |
| Rapporter (reskontro, mva, salg) og CSV-eksport | Ferdig |
| E-postsporing (Resend-webhook) | Ferdig, krever webhook i Resend |
| Google Disk | Ferdig, krever OAuth-klient (`GOOGLE_OAUTH_CLIENT_ID`) |
| EHF/Peppol (gjennom hver organisasjons konto hos Recommand) | Ferdig |
| Innbetalinger fra banken (Enable Banking, flere banker) | Ferdig |
| AI med Gemini på Vertex AI: assistent med tale og tekst for fakturaene og for personalet (fravær og vikarer, vakter, tavla og rullering, timer og ferie; de ansatte melder seg syk, tar ledige vakter og fører timene sine), faktura fra tekst eller tale, forslag på innbetalinger, lønnsslipper (PDF eller bilde) lest til ansattopplysninger | Ferdig (valgfrie GitHub-variabler `AI_AKTIV`, `AI_REGION`, `AI_MODELL`, `AI_GRENSE`) |
| Ansatte og timer: ansattregister med faste tillegg på lønnen, forkortelser (f.eks. «KN», laget av navnet og unike, kan endres) der plassen er liten, og roller dere lager selv (f.eks. lege og sekretær), også roller for dem som ikke er ansatt (f.eks. leger som er aksjonærer), kunder hentet inn som rollehavere (f.eks. legene dere fakturerer), import fra lønnssystemet eller Excel/CSV, egen innlogging for ansatte, timeføring med overtid, levering og godkjenning | Ferdig (slås på under Innstillinger → Ansatte og timer) |
| Vaktplan per dag, uke eller måned (dagen som tidslinje rolle for rolle, uka rolle for rolle, måneden som bemanningskalender med rollene mot behovet; kalenderen og vaktplanen er én side, og det kan velges hvilke roller som vises): planlegging og publisering med varsler, ledige vakter, kopiering av uker, advarsler etter arbeidsmiljøloven. De ansatte ser hele den publiserte planen og tavla (bare lesing; kollegaenes fravær bare som «F», uten lønn, stillingsprosent og notater), og har Vaktplan og Tavle som egne punkter i menyen | Ferdig |
| Vaktbytte: de ansatte gir bort eller bytter vakter og faste arbeidsdager med kolleger med samme rolle; eier eller administrator godkjenner (med advarslene byttet gir), og plassen på tavla følger med | Ferdig (av, med eller uten godkjenning under Innstillinger → Ansatte og timer) |
| Tavle (ressursfordeling i faser og oppgaver, med rollene dere velger, f.eks. sekretærene uten legene), fravær (sykdom, ferie, permisjon, kurs), vikarer og vaktplanen per måned med rollene (f.eks. sekretærer og leger, også leger som ikke er ansatt) mot behovet | Ferdig |
| Norske helligdager i kalenderne (vaktplanen, timene og tavla); de faste arbeidsdagene gjelder ikke på helligdager, og timer da er ekstra | Ferdig |
| Rullering på tavla: de som er på jobb, fordeles på oppgavene for en dag, en uke eller fire uker, så alle får gjøre alt etter tur (også mellom fasene samme dag), etter behovet og hvem som kan ta hvilke oppgaver; forslaget vises før det lagres, og plasser satt for hånd står. En ansatt kan ha fast oppgave (f.eks. laben), og står da alltid der | Ferdig |
| Faste arbeidsdager per ansatt (ukedager med klokkeslett eller hel dag; en hel dag står bare med navnet) i vaktplanen og på tavla, og ekstratimer per ansatt med rapport som PDF og CSV | Ferdig |
| Bemanningsdata ett sted: stillingsprosent (følger de faste dagene), arbeidstid, faste dager, fravær og ferie registreres én gang, vises i alle bemanningsmodulene og kan endres fra hver av dem | Ferdig |
| Bursdagsvarsler: når en ansatt har bursdag, får alle de andre push-varsel og/eller e-post kl. 08 | Ferdig (slås på under Innstillinger → Ansatte og timer) |
| Beskjeder: alle i organisasjonen legger beskjeder til én eller flere roller (f.eks. legene) eller til alle, med push-varsel om de vil; de nye står merket, og tallet på dem vises i menyen | Ferdig (menyen «Beskjeder» når Ansatte og timer er slått på) |
| Feriebank: feriedager, avviklet, planlagt og gjenstående ferie per ansatt (justeres av seg selv når ferie registreres), og søknad om å overføre dager til neste år som eier eller administrator godkjenner | Ferdig (menyen «Ferie»; feriedager per år under Innstillinger → Ansatte og timer) |
| Lønnskjøring, a-melding og utbetaling | Planlagt (se veikartet) |
| Regnskapssystemer | Ikke startet |

Se [docs/arkitektur.md](docs/arkitektur.md) for arkitektur, tilgangsmodell og veikart.

## Komme i gang på Google Cloud

1. **Engangsoppsett** i [Cloud Shell](https://shell.cloud.google.com). Det lager prosjekt,
   tilstandsbøtte, en deployer-konto og nøkkelfri innlogging fra GitHub Actions:

   ```bash
   git clone https://github.com/HI4Solutions/Faktura && cd faktura
   gcloud billing accounts list
   PROJECT_ID=faktura-prod BILLING_ACCOUNT=XXXXXX-XXXXXX-XXXXXX bash scripts/bootstrap-gcp.sh
   ```

2. **Legg verdiene skriptet skriver ut** inn som variabler under
   *Settings → Secrets and variables → Actions → Variables* i GitHub-repoet.
   `ALERT_EMAIL` er valgfri og gir driftsvarsler på e-post.

3. **Merge til `main`.** Workflowen *Infrastruktur* kjører `terraform apply`. Etter det
   legges hemmelighetene inn én gang:

   ```bash
   printf '%s' 're_...' | gcloud secrets versions add resend-api-key --data-file=-
   printf '%s' '...'    | gcloud secrets versions add google-oauth-client-secret --data-file=-
   ```

## Utvikling lokalt

```bash
scripts/test-db.sh                         # midlertidig Postgres 16, migreringer og databasetester
SERVER_TESTER=1 scripts/test-db.sh         # ... og API-testene i server/
cd server && npm ci && npm run typecheck
```

`server/` er ett Node-bilde med to roller: `ROLLE=api` (REST-API under `/api`) og
`ROLLE=worker` (PDF, e-post via Resend, gjentakelser, utboks → Pub/Sub). Utrulling skjer
med workflowen *Utrulling* ved push til `main`.

Migreringer ligger i `db/migrations` og kjøres i rekkefølge av `scripts/migrer.sh`.
I skyen gjør Cloud Run-jobben `faktura-migrate` det ved hver utrulling.
