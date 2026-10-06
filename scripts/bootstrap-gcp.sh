#!/usr/bin/env bash
# Engangsoppsett av GCP. Kjøres én gang i Google Cloud Shell (shell.cloud.google.com)
# av en som har rett til å opprette prosjekter og koble fakturering.
#
#   PROJECT_ID=faktura-prod BILLING_ACCOUNT=XXXXXX-XXXXXX-XXXXXX bash scripts/bootstrap-gcp.sh
#
# Skriptet:
#   1. oppretter prosjektet (hvis det ikke finnes) og kobler fakturering
#   2. lager en bøtte for Terraform-tilstanden
#   3. lager tjenestekontoen «faktura-deployer» som GitHub Actions ruller ut med
#   4. setter opp Workload Identity Federation, så GitHub Actions logger inn uten nøkler,
#      og bare fra repoet $GITHUB_REPO
# Til slutt skriver det ut verdiene som skal inn som variabler i GitHub-repoet.
set -euo pipefail

: "${PROJECT_ID:?Sett PROJECT_ID, f.eks. faktura-prod}"
: "${BILLING_ACCOUNT:?Sett BILLING_ACCOUNT (gcloud billing accounts list)}"
REGION="${REGION:-europe-north1}"
# Må stå nøyaktig som på GitHub; Google skiller mellom store og små bokstaver.
GITHUB_REPO="${GITHUB_REPO:-HI4Solutions/Faktura}"
STATE_BUCKET="${STATE_BUCKET:-${PROJECT_ID}-tfstate}"
DEPLOYER="faktura-deployer"
POOL="github"
PROVIDER="github"

echo "==> Prosjekt $PROJECT_ID"
if ! gcloud projects describe "$PROJECT_ID" >/dev/null 2>&1; then
  gcloud projects create "$PROJECT_ID" --name="Faktura"
fi
gcloud billing projects link "$PROJECT_ID" --billing-account="$BILLING_ACCOUNT" >/dev/null
gcloud config set project "$PROJECT_ID" >/dev/null
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"

echo "==> Grunn-API-er"
gcloud services enable \
  cloudresourcemanager.googleapis.com serviceusage.googleapis.com iam.googleapis.com \
  iamcredentials.googleapis.com sts.googleapis.com storage.googleapis.com

echo "==> Bøtte for Terraform-tilstand: gs://$STATE_BUCKET"
if ! gcloud storage buckets describe "gs://$STATE_BUCKET" >/dev/null 2>&1; then
  gcloud storage buckets create "gs://$STATE_BUCKET" --location="$REGION" \
    --uniform-bucket-level-access --public-access-prevention
  gcloud storage buckets update "gs://$STATE_BUCKET" --versioning
fi

echo "==> Tjenestekonto $DEPLOYER"
SA="$DEPLOYER@$PROJECT_ID.iam.gserviceaccount.com"
if ! gcloud iam service-accounts describe "$SA" >/dev/null 2>&1; then
  gcloud iam service-accounts create "$DEPLOYER" --display-name="Faktura deployer (GitHub Actions)"
fi
# Prosjektet er dedikert til plattformen, så deployeren får eierrollen.
# Stram inn til enkeltroller når oppsettet har satt seg.
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:$SA" --role="roles/owner" --condition=None >/dev/null

echo "==> Workload Identity Federation for $GITHUB_REPO"
if ! gcloud iam workload-identity-pools describe "$POOL" --location=global >/dev/null 2>&1; then
  gcloud iam workload-identity-pools create "$POOL" --location=global --display-name="GitHub Actions"
fi
if ! gcloud iam workload-identity-pools providers describe "$PROVIDER" \
      --workload-identity-pool="$POOL" --location=global >/dev/null 2>&1; then
  gcloud iam workload-identity-pools providers create-oidc "$PROVIDER" \
    --workload-identity-pool="$POOL" --location=global \
    --issuer-uri="https://token.actions.githubusercontent.com" \
    --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref" \
    --attribute-condition="assertion.repository == '$GITHUB_REPO'"
fi
gcloud iam service-accounts add-iam-policy-binding "$SA" \
  --role="roles/iam.workloadIdentityUser" \
  --member="principalSet://iam.googleapis.com/projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/$POOL/attribute.repository/$GITHUB_REPO" \
  >/dev/null

WIF_PROVIDER="projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/$POOL/providers/$PROVIDER"

cat <<EOF

Ferdig. Legg inn disse som variabler (ikke hemmeligheter) i GitHub:
  https://github.com/$GITHUB_REPO/settings/variables/actions

  GCP_PROJECT_ID    = $PROJECT_ID
  GCP_REGION        = $REGION
  GCP_WIF_PROVIDER  = $WIF_PROVIDER
  GCP_DEPLOY_SA     = $SA
  TF_STATE_BUCKET   = $STATE_BUCKET

Deretter ruller GitHub Actions ut infrastrukturen ved neste push til main
(eller start «Infrastruktur» manuelt under Actions).
EOF
