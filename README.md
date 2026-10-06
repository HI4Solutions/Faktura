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
| Infrastruktur som kode (`infra/terraform`) | Ferdig, validert, ikke rullet ut |
| CI (databasetester, Terraform) og utrulling med GitHub Actions | Ferdig |
| API (Cloud Run, TypeScript) | Neste |
| Worker: PDF, e-post, gjentakelser, utboks | Neste |
| Nettapp (React) på Firebase Hosting | Etter API |

Se [docs/arkitektur.md](docs/arkitektur.md) for arkitektur, tilgangsmodell og veikart.

## Komme i gang på Google Cloud

1. **Engangsoppsett** i [Cloud Shell](https://shell.cloud.google.com). Det lager prosjekt,
   tilstandsbøtte, en deployer-konto og nøkkelfri innlogging fra GitHub Actions:

   ```bash
   git clone https://github.com/hi4solutions/faktura && cd faktura
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
scripts/test-db.sh      # starter en midlertidig Postgres 16, migrerer og kjører testene
```

Migreringer ligger i `db/migrations` og kjøres i rekkefølge av `scripts/migrer.sh`.
I skyen gjør Cloud Run-jobben `faktura-migrate` det ved hver utrulling.
