#!/usr/bin/env bash
# ID-porten-klienten til mva-innsendingen (docs/mva-innsending.md), fra Cloud Shell: lag nøkkelen
# klienten logger inn med (private_key_jwt). Den private nøkkelen går rett inn i Secret Manager
# (hemmeligheten idporten-nokkel, som bare workeren leser) og skrives aldri til disk eller skjermen.
#
#   bash scripts/idporten.sh nokkel
#       Lager en nøkkel i idporten-nokkel (om den ikke har en fra før; Terraform legger inn
#       plassholderen «ikke-satt») og skriver ut den offentlige delen (JWK), som legges inn på
#       integrasjonen i Digdirs selvbetjening. NY_NOKKEL=1 lager en ny nøkkel selv om det finnes en.
#
# MILJO=test (standard) bruker prosjektet hi4-faktura-test; MILJO=prod bruker hi4-faktura-prod.
# NOKKEL_ID er nøkkel-ID-en (kid), standard admin-konsoll-mva-test-1 (prod: admin-konsoll-mva-1).
# PROSJEKT overstyrer prosjektet.
set -euo pipefail

MILJO="${MILJO:-test}"
case "$MILJO" in
  test)
    PROSJEKT="${PROSJEKT:-hi4-faktura-test}"
    NOKKEL_ID="${NOKKEL_ID:-admin-konsoll-mva-test-1}"
    ;;
  prod)
    PROSJEKT="${PROSJEKT:-hi4-faktura-prod}"
    NOKKEL_ID="${NOKKEL_ID:-admin-konsoll-mva-1}"
    ;;
  *)
    echo "MILJO må være test eller prod." >&2
    exit 2
    ;;
esac
HEMMELIGHET="idporten-nokkel"
SKRIPT="$(cd "$(dirname "$0")" && pwd)/maskinporten.mjs"

les() { gcloud secrets versions access latest --secret="$HEMMELIGHET" --project="$PROSJEKT" 2>/dev/null || true; }

case "${1:-}" in
  nokkel)
    if ! gcloud secrets describe "$HEMMELIGHET" --project="$PROSJEKT" >/dev/null 2>&1; then
      echo "Hemmeligheten $HEMMELIGHET finnes ikke i $PROSJEKT. Kjør Infrastruktur først (Terraform lager den)." >&2
      exit 1
    fi
    # Plassholderen fra Terraform («ikke-satt») er ingen nøkkel.
    if les | grep -q "PRIVATE KEY" && [ "${NY_NOKKEL:-}" != "1" ]; then
      echo "==> $HEMMELIGHET i $PROSJEKT har en nøkkel fra før, og den brukes (NY_NOKKEL=1 lager en ny)." >&2
    else
      echo "==> Lager en ny nøkkel i $HEMMELIGHET i $PROSJEKT" >&2
      PEM="$(openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 2>/dev/null)"
      [ -n "$PEM" ] || { echo "openssl laget ingen nøkkel." >&2; exit 1; }
      printf '%s\n' "$PEM" | gcloud secrets versions add "$HEMMELIGHET" --data-file=- --project="$PROSJEKT" >/dev/null
      unset PEM
    fi
    echo "==> Den offentlige nøkkelen (JWK), med nøkkel-ID-en $NOKKEL_ID. Den er ikke hemmelig." >&2
    echo "    Legg den inn på ID-porten-integrasjonen i selvbetjeningen, og sett GitHub-variabelen" >&2
    echo "    IDPORTEN_NOKKEL_ID til $NOKKEL_ID i miljøet ($MILJO):" >&2
    echo >&2
    les | node "$SKRIPT" jwk "$NOKKEL_ID"
    ;;
  *)
    echo "Bruk: bash scripts/idporten.sh nokkel" >&2
    echo "MILJO=prod for produksjonsklienten. Se toppen av skriptet." >&2
    exit 2
    ;;
esac
