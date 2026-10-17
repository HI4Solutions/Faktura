#!/usr/bin/env bash
# Publiserer nettappen (web/dist, bygget først) og nettstedet (landingsside/) i Firebase Hosting.
# Kalles fra Rull ut med PROSJEKT, REGION og MILJO (docs/domene.md, «Nettstedet og appen»).
#
# - Appen går til appens egen side (<prosjekt>-app) når Terraform har satt den opp (NETTSTED_URL
#   finnes på API-et).
# - Standardsiden (<prosjekt>) har nettstedet. Så lenge appens hoveddomene (APP_URL) er nettstedets
#   domene (før appen flytter til app.<domene>), har den appen i stedet, med de juridiske sidene ved
#   siden av så lenkene til vilkårene virker, og nettstedet legges i forhåndsvisningskanalen
#   «nettsted».
# - «Logg inn» og «Opprett konto» på nettstedet peker til appens hoveddomene i miljøet.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${PROSJEKT:?PROSJEKT mangler}" "${REGION:?REGION mangler}"
MILJO="${MILJO:-}"
[ -f web/dist/index.html ] || { echo "::error::Nettappen er ikke bygget (web/dist)."; exit 1; }

# Adressene står på API-et (Terraform, run.tf).
api_env() {
  gcloud run services describe faktura-api --region "$REGION" --format=json |
    jq -r --arg n "$1" '[.spec.template.spec.containers[0].env[]? | select(.name == $n) | .value][0] // ""'
}
APP_URL="$(api_env APP_URL)"
NETTSTED_URL="$(api_env NETTSTED_URL)"
[ -n "$APP_URL" ] || { echo "::error::APP_URL mangler på faktura-api."; exit 1; }
echo "Appen: $APP_URL. Nettstedet: ${NETTSTED_URL:-ikke satt opp ennå (kjør Infrastruktur)}."

UT="$(mktemp -d)"
trap 'rm -rf "$UT"' EXIT

# <katalog> <side> [kanal]: publiserer katalogen (med sin firebase.json) til siden, eller til en
# forhåndsvisningskanal på den.
publiser() {
  local dir="$1" side="$2" kanal="${3:-}"
  jq --arg s "$side" '.hosting.site = $s' "$dir/firebase.json" >"$dir/firebase.json.ny"
  mv "$dir/firebase.json.ny" "$dir/firebase.json"
  if [ -n "$kanal" ]; then
    local svar url
    svar="$(cd "$dir" && npx --yes firebase-tools@latest hosting:channel:deploy "$kanal" --expires 30d --project "$PROSJEKT" --non-interactive --json)"
    url="$(jq -r '.result | to_entries[0].value.url // empty' <<<"$svar")"
    echo "::notice::Nettstedet til forhåndsvisning: ${url:-se loggen}"
  else
    (cd "$dir" && npx --yes firebase-tools@latest deploy --only hosting --project "$PROSJEKT" --non-interactive)
  fi
}

# Appen, slik den er bygget.
lag_app() {
  mkdir -p "$1"
  cp web/firebase.json "$1/firebase.json"
  cp -r web/dist "$1/dist"
}

# Nettstedet, med lenkene til appen på appens hoveddomene. Testflaten skal ikke i søkemotorene.
lag_nettsted() {
  mkdir -p "$1"
  cp -r landingsside/. "$1/"
  find "$1" -name '*.html' -exec sed -i "s#https://app\.adminkonsoll\.no#${APP_URL}#g" {} +
  if [ "$MILJO" = "test" ]; then
    jq '.hosting.headers += [{"source": "**", "headers": [{"key": "X-Robots-Tag", "value": "noindex"}]}]' \
      "$1/firebase.json" >"$1/firebase.json.ny"
    mv "$1/firebase.json.ny" "$1/firebase.json"
  fi
}

lag_nettsted "$UT/nettsted"

if [ -n "$NETTSTED_URL" ]; then
  echo "==> Appen til ${PROSJEKT}-app"
  lag_app "$UT/app"
  publiser "$UT/app" "${PROSJEKT}-app"
fi

if [ -z "$NETTSTED_URL" ] || [ "$APP_URL" = "$NETTSTED_URL" ]; then
  echo "==> Standardsiden: appen (hoveddomenet ligger der ennå), med de juridiske sidene"
  lag_app "$UT/standard"
  for f in personvern vilkar databehandleravtale underleverandorer informasjonskapsler; do
    cp "$UT/nettsted/$f.html" "$UT/standard/dist/"
  done
  cp "$UT/nettsted/felles.css" "$UT/nettsted/og-bilde.png" "$UT/standard/dist/"
  cp -r "$UT/nettsted/fonter" "$UT/standard/dist/fonter"
  publiser "$UT/standard" "$PROSJEKT"
  if [ -n "$NETTSTED_URL" ]; then
    echo "==> Nettstedet i forhåndsvisningskanalen «nettsted»"
    publiser "$UT/nettsted" "$PROSJEKT" nettsted
  fi
else
  echo "==> Standardsiden: nettstedet"
  publiser "$UT/nettsted" "$PROSJEKT"
fi
