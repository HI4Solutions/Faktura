#!/usr/bin/env bash
# Maskinporten-klienten til Admin Konsoll, fra Cloud Shell: lag nøkkelen, og sjekk hvilke scopes
# klienten får token for. Den private nøkkelen går rett inn i Secret Manager og leses derfra; den
# skrives aldri til disk eller skjermen.
#
#   bash scripts/maskinporten.sh nokkel
#       Lager en nøkkel i hemmeligheten maskinporten-nokkel-ny (om den ikke har en fra før) og
#       skriver ut den offentlige delen (JWK), som legges inn på klienten i Samarbeidsportalen.
#       NY_NOKKEL=1 lager en ny nøkkel selv om det finnes en.
#   KLIENT_ID=… bash scripts/maskinporten.sh sjekk
#       Ber Maskinporten om et token for hvert scope appen bruker, og viser hvilke som virker.
#
# MILJO=prod (standard) bruker prosjektet hi4-faktura-prod og maskinporten.no; MILJO=test bruker
# hi4-faktura-test og test.maskinporten.no. NOKKEL_ID er nøkkel-ID-en (kid), standard
# medinnova-prod-1 (test: medinnova-1). PROSJEKT overstyrer prosjektet, og HEMMELIGHET
# hemmeligheten «sjekk» leser.
#
# En ny nøkkel ligger i maskinporten-nokkel-ny til den tas i bruk. Appen bruker
# maskinporten-nokkel og merker ingenting før nøkkelen kopieres dit (docs/miljoer.md). «sjekk»
# bruker maskinporten-nokkel-ny når den finnes, ellers maskinporten-nokkel.
set -euo pipefail

MILJO="${MILJO:-prod}"
case "$MILJO" in
  prod)
    PROSJEKT="${PROSJEKT:-hi4-faktura-prod}"
    NOKKEL_ID="${NOKKEL_ID:-medinnova-prod-1}"
    ;;
  test)
    PROSJEKT="${PROSJEKT:-hi4-faktura-test}"
    NOKKEL_ID="${NOKKEL_ID:-medinnova-1}"
    ;;
  *)
    echo "MILJO må være prod eller test." >&2
    exit 2
    ;;
esac
REGION="${REGION:-europe-north1}"
NY="maskinporten-nokkel-ny"
SKRIPT="$(cd "$(dirname "$0")" && pwd)/maskinporten.mjs"

finnes() { gcloud secrets describe "$1" --project="$PROSJEKT" >/dev/null 2>&1; }
har_nokkel() {
  [ -n "$(gcloud secrets versions list "$1" --project="$PROSJEKT" --filter='state=ENABLED' --limit=1 --format='value(name)' 2>/dev/null)" ]
}
les() { gcloud secrets versions access latest --secret="$1" --project="$PROSJEKT"; }

case "${1:-}" in
  nokkel)
    if ! finnes "$NY"; then
      gcloud secrets create "$NY" --project="$PROSJEKT" --replication-policy=user-managed --locations="$REGION" >/dev/null
    fi
    if har_nokkel "$NY" && [ "${NY_NOKKEL:-}" != "1" ]; then
      echo "==> $NY i $PROSJEKT har en nøkkel fra før, og den brukes (NY_NOKKEL=1 lager en ny)." >&2
    else
      echo "==> Lager en ny nøkkel i $NY i $PROSJEKT" >&2
      PEM="$(openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 2>/dev/null)"
      [ -n "$PEM" ] || { echo "openssl laget ingen nøkkel." >&2; exit 1; }
      printf '%s\n' "$PEM" | gcloud secrets versions add "$NY" --data-file=- --project="$PROSJEKT" >/dev/null
      unset PEM
    fi
    echo "==> Den offentlige nøkkelen (JWK), med nøkkel-ID-en $NOKKEL_ID. Den er ikke hemmelig." >&2
    echo "    Lim den inn under nøklene på klienten i Samarbeidsportalen:" >&2
    echo >&2
    les "$NY" | node "$SKRIPT" jwk "$NOKKEL_ID"
    ;;
  sjekk)
    : "${KLIENT_ID:?Sett KLIENT_ID til klient-ID-en fra Samarbeidsportalen}"
    if [ -z "${HEMMELIGHET:-}" ]; then
      HEMMELIGHET="maskinporten-nokkel"
      if finnes "$NY" && har_nokkel "$NY"; then HEMMELIGHET="$NY"; fi
    fi
    echo "==> Nøkkelen fra $HEMMELIGHET i $PROSJEKT" >&2
    les "$HEMMELIGHET" | node "$SKRIPT" sjekk "$MILJO" "$KLIENT_ID" "$NOKKEL_ID"
    ;;
  *)
    echo "Bruk: bash scripts/maskinporten.sh nokkel" >&2
    echo "      KLIENT_ID=… bash scripts/maskinporten.sh sjekk" >&2
    echo "MILJO=test for testklienten. Se toppen av skriptet." >&2
    exit 2
    ;;
esac
