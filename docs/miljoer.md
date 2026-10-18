# Test og produksjon

Admin Konsoll kjører i to installasjoner, hver i sitt prosjekt i Google Cloud:

| | Produksjon | Testflaten |
|---|---|---|
| Prosjekt | `hi4-faktura-prod` | `hi4-faktura-test` |
| Adresse | adminkonsoll.no (appen; nettstedet kommer hit ved lanseringen) | app.test.adminkonsoll.no (appen) og test.adminkonsoll.no (nettstedet, med appen under /app) |
| Data | Ekte bedrifter, brukere og fakturaer | Testbedrifter fra Tenor og oppdiktede personer |
| Skatteetaten, Altinn og NAV | Produksjon når det er satt opp (`SKATTEETATEN_MILJO`) | Alltid testmiljøene (Maskinporten-test og TT02) |
| Variablene i GitHub | Repoet | Miljøet «test» (går foran repoet) |
| Terraform-verdiene | `infra/terraform/miljo/produksjon.tfvars` | `infra/terraform/miljo/test.tfvars` |

Testflaten har merket «Testflate» øverst på alle sider og «Test ·» foran navnet i fanen
(`web/src/main.tsx`), så den ikke forveksles med produksjon.

## Slik rulles det ut

En push til main går gjennom testene, så til testflaten og så til produksjon (Utrulling,
`deploy.yml` og `rull-ut.yml`; Infrastruktur, `infra.yml` og `terraform.yml`). Produksjon venter på
testflaten, og feiler den, rulles ikke produksjon ut. Har miljøet «produksjon» i GitHub
«Required reviewers», venter produksjon også på godkjenning: Actions → kjøringen → «Review
deployments». Er testflaten ikke satt opp (miljøet «test» har ikke `MILJO=test`), rulles
produksjon ut alene, som før.

Produksjonens variabler ligger i repoet, og utrullingen ser etter `GCP_PROJECT_ID` der.
Variablene i et miljø i GitHub går foran dem i repoet. Testflaten må derfor ha sine egne verdier
for prosjektet, innloggingen og tilstandsbøtta; mangler de, eller er de like produksjonens, stopper
utrullingen før noe skjer (`miljoer.yml`). Det som ellers skiller miljøene, står i
`infra/terraform/miljo/`: domenet, databasestørrelsen, hvor lenge PDF-ene oppbevares, og at
testflaten alltid bruker testmiljøene til Skatteetaten, Altinn og NAV, uansett hva
`SKATTEETATEN_MILJO` er satt til.

## Sette opp testflaten (din del)

1. **Prosjektet.** I [Cloud Shell](https://shell.cloud.google.com), innlogget som kontoen som eier
   produksjonsprosjektet:

   ```sh
   git clone https://github.com/HI4Solutions/Faktura && cd Faktura
   gcloud billing accounts list
   MILJO=test PROJECT_ID=hi4-faktura-test BILLING_ACCOUNT=XXXXXX-XXXXXX-XXXXXX bash scripts/bootstrap-gcp.sh
   ```

   Er repoet klonet fra før: `cd Faktura && git pull` i stedet for den første linjen.
2. **Miljøet «test» i GitHub.** Settings → Environments → New environment → `test`. Legg inn
   verdiene skriptet skriver ut, som Environment variables (ikke hemmeligheter). Legg også inn
   disse, med de samme verdiene som i repoet i dag (Settings → Secrets and variables → Actions →
   Variables), så testflaten beholder testklienten i Maskinporten når produksjon får sin egen:
   - `MASKINPORTEN_KLIENT_ID` og `MASKINPORTEN_NOKKEL_ID`;
   - `AMELDING_INNSENDING`, og `NAV_SYKEPENGER`, `KRAV_OG_FRISTER` og `AARSREGNSKAP_INNSENDING` om de
     er satt.
3. **Infrastrukturen.** Actions → Infrastruktur → Run workflow, fra grenen `main` (standardgrenen
   i repoet er en annen, og fra den lager Infrastruktur bare en plan). Første gang tar det rundt et
   kvarter, mest for databasen. DNS-oppføringene står i loggen for testjobben (`dns_for_domener`);
   første gang er lista tom, og de kommer med i neste kjøring.
4. **DNS.** Appen ligger på `app.test.adminkonsoll.no` og nettstedet på `test.adminkonsoll.no`
   ([domene.md](domene.md), «Nettstedet og appen»). Legg inn oppføringene hos domeneleverandøren
   (sjekk mot `dns_for_domener`): `app.test`, CNAME, `hi4-faktura-test-app.web.app` (appen), og
   `test`, CNAME, `hi4-faktura-test.web.app` (nettstedet). Sertifikatene kommer av seg selv når
   oppføringene er på plass, etter noen minutter til en time. Til da virker appen på
   https://hi4-faktura-test-app.web.app og nettstedet på https://hi4-faktura-test.web.app.
5. **Hemmelighetene.** Når Infrastruktur er ferdig (den legger inn en plassholder først), kopier
   dem fra produksjon i Cloud Shell, uten at verdiene vises:

   ```sh
   for s in resend-api-key maskinporten-nokkel; do
     gcloud secrets versions access latest --secret="$s" --project=hi4-faktura-prod \
       | gcloud secrets versions add "$s" --data-file=- --project=hi4-faktura-test
   done
   ```

   `maskinporten-nokkel` er nøkkelen til testklienten, som produksjon bruker i dag. Google Disk er
   ikke satt opp på testflaten.
6. **Utrullingen.** Actions → Utrulling → Run workflow. Den ruller ut til testflaten og så til
   produksjon.
7. **I appen på app.test.adminkonsoll.no.** Registrer deg (adressene i `ADMIN_EPOSTER` blir
   plattformadministratorer), trykk Plattform → Drift → «Oppdater i Altinn», og koble testbedriften
   til på nytt (godkjenn i Altinn TT02).
8. **Godkjenning før produksjon.** Settings → Environments → `produksjon` (finnes etter den første
   utrullingen) → Required reviewers → deg selv. Fra da av venter produksjon på at du godkjenner.

## Før Skatteetaten, Altinn og NAV går i produksjon

TT02-testene gjøres på testflaten. Produksjon får sin egen klient i Maskinporten, og den prøves
før appen tar den i bruk (punktet «Produksjon» i [skattekort.md](skattekort.md),
[amelding.md](amelding.md) og [nav.md](nav.md)). Før punkt 5 merker produksjonen ingenting.

1. **Tilgangene.** Logg inn i Samarbeidsportalen for produksjon
   (<https://sjolvbetjening.samarbeid.digdir.no>); ber den om det, signerer du de samme
   bruksvilkårene som i test ([skattekort.md](skattekort.md), punkt 1). «Tilganger» viser scopene
   Medinnova har fått i produksjon. De som mangler, er ikke gitt ennå.
2. **Klienten.** Klienter → Opprett klient → Maskinporten, visningsnavn «Admin Konsoll», med scopene
   fra «Tilganger». Noter klient-ID-en.
3. **Nøkkelen.** I Cloud Shell (`cd Faktura && git pull`):

   ```sh
   bash scripts/maskinporten.sh nokkel
   ```

   Den private nøkkelen går rett i hemmeligheten `maskinporten-nokkel-ny` i `hi4-faktura-prod` og
   vises aldri. Lim den offentlige nøkkelen (JWK-en som skrives ut, med nøkkel-ID-en
   `medinnova-prod-1`) inn under nøklene på klienten.
4. **Sjekken.**

   ```sh
   KLIENT_ID=<klient-ID-en> bash scripts/maskinporten.sh sjekk
   ```

   Skriptet ber Maskinporten om et token for hvert scope appen bruker, og viser ✓, eller ✗ med
   feilen. `invalid_scope` betyr at scopet ikke er lagt på klienten eller ikke er gitt ennå. Feiler
   alle likt med `invalid_grant`, stemmer ikke klient-ID-en, nøkkelen eller nøkkel-ID-en.
   `MILJO=test` sjekker testklienten på samme måte.
5. **Slå på produksjon**, når sjekken viser det som trengs, i denne rekkefølgen:
   - Slett testbedriftene fra Tenor i produksjon (organisasjonsnummer som begynner på 2 eller 3):
     Plattform → Organisasjoner → bedriften → «Slett organisasjonen».
   - Ta nøkkelen i bruk, i Cloud Shell:

     ```sh
     gcloud secrets versions access latest --secret=maskinporten-nokkel-ny --project=hi4-faktura-prod \
       | gcloud secrets versions add maskinporten-nokkel --data-file=- --project=hi4-faktura-prod
     gcloud secrets delete maskinporten-nokkel-ny --project=hi4-faktura-prod
     ```

   - Sjekk at miljøet «test» har sine egne `MASKINPORTEN_KLIENT_ID` og `MASKINPORTEN_NOKKEL_ID`
     (testklienten, punkt 2 under «Sette opp testflaten»). Mangler de, tar testflaten verdiene fra
     repoet, altså produksjonsklienten, og da virker ikke testmiljøene der.
   - Variablene i repoet: `MASKINPORTEN_KLIENT_ID` (klient-ID-en), `MASKINPORTEN_NOKKEL_ID`
     (`medinnova-prod-1`) og `SKATTEETATEN_MILJO` = `prod`. Testflaten er ikke berørt, siden den
     har sine egne (og `test.tfvars` holder den på testmiljøene).
   - Kjør Infrastruktur fra main, og godkjenn produksjon. Trykk så Plattform → Drift → «Registrer
     systemet i Altinn» på adminkonsoll.no.
   - Gi NAV beskjed første gang sykepenger brukes i produksjon ([nav.md](nav.md), punkt 6).

## Flytte prosjektene til medinnova.no

Prosjektene kan flyttes fra kontoen de ble laget i, til organisasjonen medinnova.no når som helst.
Alt i prosjektet følger med, og prosjekt-ID-ene og variablene i GitHub er de samme etterpå. For
hvert prosjekt:

1. IAM & Admin → IAM: gi nadeem@medinnova.no rollen Owner, innlogget med kontoen som eier prosjektet.
2. Innlogget som nadeem@medinnova.no: IAM & Admin → Settings, velg prosjektet, trykk «Migrate» og
   velg organisasjonen. Det krever rollen Project Creator i organisasjonen, og prosjektet kan ikke
   flyttes ut av organisasjonen igjen.
3. Skal Medinnova AS betale: Billing → Account management → «Change billing account». Bruk aldri
   «Disable billing», for da stopper alt.
4. Kjør Infrastruktur. Stopper en regel i organisasjonen noe, for eksempel «Domain restricted
   sharing», som hindrer at API-et er åpent for alle, gir du prosjektet et unntak under
   IAM & Admin → Organization policies.
