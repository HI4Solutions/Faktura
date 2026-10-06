# Faktura

Fakturaplattform der foretak oppretter konto og fakturerer sine kunder. Bygget på
Google Cloud. Kjernen er portert fra fakturamodulen i MedSide og gjort flerbruker
(`org_id` overalt).

Funksjoner: produkter, kunder, fakturaer og kreditnotaer (hel eller delvis),
betaling og refusjon, gjentakende fakturaer, regnskapsførertilgang på tvers av
klienter, Google Disk og et adapterlag for bank og regnskapssystemer.

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
| Gjentakende fakturaer, purring og inkassovarsel | Ferdig |
| Rapporter (reskontro, mva, salg) og CSV-eksport | Ferdig |
| E-postsporing (Resend-webhook) | Ferdig, krever webhook i Resend |
| Google Disk | Ferdig, krever OAuth-klient (`GOOGLE_OAUTH_CLIENT_ID`) |
| Bank (KID/OCR), regnskapssystemer, EHF/Peppol | Ikke startet |

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
