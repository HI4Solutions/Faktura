#!/usr/bin/env bash
# Publiserer nettappen (web/dist, bygget først) og nettstedet (landingsside/) i Firebase Hosting.
# Kalles fra Rull ut med PROSJEKT, REGION og MILJO (docs/domene.md, «Nettstedet og appen»).
#
# - Appen går til appens egen side (<prosjekt>-app) når Terraform har satt den opp (NETTSTED_URL
#   finnes på API-et).
# - Standardsiden (<prosjekt>) har nettstedet, med appen under /app ved siden av: «Logg inn» og
#   «Opprett konto» åpner appen på samme domene, så den som har lagt nettstedet på Hjem-skjermen,
#   logger inn og bruker appen inne i snarveien. Alt nettstedet ikke har selv (gamle lenker og
#   tilbakeadressene fra banken, Altinn og Google), åpner appen der.
# - Så lenge appens hoveddomene (APP_URL) er nettstedets domene (før appen flytter til
#   app.<domene>), har standardsiden bare appen, med de juridiske sidene og statussiden ved siden av
#   så lenkene til vilkårene virker, og nettstedet legges i forhåndsvisningskanalen «nettsted», med «Logg inn» og
#   «Opprett konto» til appens hoveddomene.
#
# Prøvekjøring: med UT=<katalog> (og APP_URL og NETTSTED_URL) settes sidene sammen i katalogen,
# uten gcloud og uten å publisere, f.eks. for å prøve dem i Firebase-emulatoren.
set -euo pipefail
cd "$(dirname "$0")/.."
MILJO="${MILJO:-}"
[ -f web/dist/index.html ] || { echo "::error::Nettappen er ikke bygget (web/dist)."; exit 1; }

if [ -n "${UT:-}" ]; then
  PROVE=1
  PROSJEKT="${PROSJEKT:-provekjoring}"
  : "${APP_URL:?APP_URL mangler}"
  NETTSTED_URL="${NETTSTED_URL:-}"
  rm -rf "$UT"
  mkdir -p "$UT"
else
  PROVE=
  : "${PROSJEKT:?PROSJEKT mangler}" "${REGION:?REGION mangler}"
  # Adressene står på API-et (Terraform, run.tf).
  api_env() {
    gcloud run services describe faktura-api --region "$REGION" --format=json |
      jq -r --arg n "$1" '[.spec.template.spec.containers[0].env[]? | select(.name == $n) | .value][0] // ""'
  }
  APP_URL="$(api_env APP_URL)"
  NETTSTED_URL="$(api_env NETTSTED_URL)"
  UT="$(mktemp -d)"
  trap 'rm -rf "$UT"' EXIT
fi
[ -n "$APP_URL" ] || { echo "::error::APP_URL mangler på faktura-api."; exit 1; }
echo "Appen: $APP_URL. Nettstedet: ${NETTSTED_URL:-ikke satt opp ennå (kjør Infrastruktur)}."

# <katalog> <side> [kanal]: publiserer katalogen (med sin firebase.json) til siden, eller til en
# forhåndsvisningskanal på den.
publiser() {
  local dir="$1" side="$2" kanal="${3:-}"
  jq --arg s "$side" '.hosting.site = $s' "$dir/firebase.json" >"$dir/firebase.json.ny"
  mv "$dir/firebase.json.ny" "$dir/firebase.json"
  if [ -n "$PROVE" ]; then
    echo "Prøvekjøring: $dir til ${side}${kanal:+, kanalen $kanal} (ikke publisert)"
  elif [ -n "$kanal" ]; then
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

# <katalog> <appen>: nettstedet, med lenkene til appen («Logg inn» og «Opprett konto») til /app på
# samme domene eller til appens hoveddomene. Testflaten skal ikke i søkemotorene.
# felles.css og nettsted.js får en kontrollsum av innholdet i adressen (?v=…): sidene hentes alltid
# på nytt, men stilarket lagres en time, og en ny side med et gammelt stilark mangler blant annet
# den faste toppen. Med ny adresse henter nettleseren filen på nytt når den er endret.
lag_nettsted() {
  local dir="$1" app="$2"
  mkdir -p "$dir"
  cp -r landingsside/. "$dir/"
  if [ "$app" = "/app" ]; then
    # https://app.adminkonsoll.no → /app og https://app.adminkonsoll.no/?konto=ny → /app?konto=ny
    find "$dir" -name '*.html' -exec sed -i -E 's#https://app\.adminkonsoll\.no/?([?"])#/app\1#g' {} +
  else
    find "$dir" -name '*.html' -exec sed -i "s#https://app\.adminkonsoll\.no#${app}#g" {} +
  fi
  if [ "$app" != "https://app.adminkonsoll.no" ] && grep -n 'https://app\.adminkonsoll\.no' "$dir"/*.html; then
    echo "::error::Lenkene over til appen ble ikke skrevet om."; exit 1
  fi
  local css js
  css="$(sha256sum "$dir/felles.css" | cut -c1-12)"
  js="$(sha256sum "$dir/nettsted.js" | cut -c1-12)"
  find "$dir" -name '*.html' -exec sed -i -e "s#href=\"felles\.css\"#href=\"felles.css?v=${css}\"#g" \
    -e "s#src=\"nettsted\.js\"#src=\"nettsted.js?v=${js}\"#g" {} +
  if grep -L "felles\.css?v=${css}" "$dir"/*.html | grep -q .; then
    echo "::error::Fant ikke stilarket i alle sidene:"; grep -L "felles\.css?v=${css}" "$dir"/*.html; exit 1
  fi
  if [ "$MILJO" = "test" ]; then
    jq '.hosting.headers += [{"source": "**", "headers": [{"key": "X-Robots-Tag", "value": "noindex"}]}]' \
      "$dir/firebase.json" >"$dir/firebase.json.ny"
    mv "$dir/firebase.json.ny" "$dir/firebase.json"
  fi
}

# Appen under /app på nettstedet (web/src/appsti.ts): filene fra bygget ved siden av nettstedets
# (favicon.svg og ikoner/ finnes i begge og er like, scripts/lag-ikoner.mjs), siden appen starter
# fra som app/index.html med <meta name="app-sti">, og appens service worker (sw.js) med
# app/index.html som skall. firebase.json får appens regler (som i web/firebase.json): /api/** til
# API-et, og alt nettstedet ikke har selv, til appen.
legg_til_appen() {
  local dir="$1" app f
  app="$(mktemp -d)"
  cp -r web/dist/. "$app/"
  mkdir -p "$dir/app"
  sed 's#</head>#  <meta name="app-sti" content="/app" />\n  </head>#' "$app/index.html" >"$dir/app/index.html"
  grep -q '<meta name="app-sti" content="/app" />' "$dir/app/index.html" || { echo "::error::Fant ikke </head> i appens index.html."; exit 1; }
  sed 's#^const SKALL_SIDE = "/";$#const SKALL_SIDE = "/app/index.html";#' "$app/sw.js" >"$dir/sw.js"
  grep -q '^const SKALL_SIDE = "/app/index.html";$' "$dir/sw.js" || { echo "::error::Fant ikke SKALL_SIDE i appens sw.js."; exit 1; }
  rm "$app/index.html" "$app/sw.js"
  while IFS= read -r f; do
    if [ -e "$dir/$f" ] && ! cmp -s "$app/$f" "$dir/$f"; then
      echo "::warning::$f finnes både på nettstedet og i appen, med ulikt innhold. Appens brukes."
    fi
  done < <(cd "$app" && find . -type f | sed 's#^\./##')
  cp -r "$app/." "$dir/"
  rm -rf "$app"
  jq '.hosting.rewrites = [
        {"source": "/api/**", "run": {"serviceId": "faktura-api", "region": "europe-north1"}},
        {"source": "**", "destination": "/app/index.html"}
      ]
      | .hosting.headers += [
        {"source": "/assets/**", "headers": [{"key": "Cache-Control", "value": "public, max-age=31536000, immutable"}]},
        {"source": "/sw.js", "headers": [{"key": "Service-Worker-Allowed", "value": "/"}]},
        {"source": "/manifest.webmanifest", "headers": [
          {"key": "Content-Type", "value": "application/manifest+json"}, {"key": "Cache-Control", "value": "no-cache"}]},
        {"regex": "^/([^.]*|app/index\\.html)$", "headers": [{"key": "Cache-Control", "value": "no-cache"}]}
      ]' "$dir/firebase.json" >"$dir/firebase.json.ny"
  mv "$dir/firebase.json.ny" "$dir/firebase.json"
}

if [ -n "$NETTSTED_URL" ]; then
  echo "==> Appen til ${PROSJEKT}-app"
  lag_app "$UT/app"
  publiser "$UT/app" "${PROSJEKT}-app"
fi

if [ -z "$NETTSTED_URL" ] || [ "$APP_URL" = "$NETTSTED_URL" ]; then
  echo "==> Standardsiden: appen (hoveddomenet ligger der ennå), med de juridiske sidene"
  lag_nettsted "$UT/nettsted" "$APP_URL"
  lag_app "$UT/standard"
  for f in personvern vilkar databehandleravtale underleverandorer informasjonskapsler status; do
    cp "$UT/nettsted/$f.html" "$UT/standard/dist/"
  done
  cp "$UT/nettsted/felles.css" "$UT/nettsted/nettsted.js" "$UT/nettsted/og-bilde.png" "$UT/standard/dist/"
  cp -r "$UT/nettsted/fonter" "$UT/standard/dist/fonter"
  publiser "$UT/standard" "$PROSJEKT"
  if [ -n "$NETTSTED_URL" ]; then
    echo "==> Nettstedet i forhåndsvisningskanalen «nettsted»"
    publiser "$UT/nettsted" "$PROSJEKT" nettsted
  fi
else
  echo "==> Standardsiden: nettstedet, med appen under /app"
  lag_nettsted "$UT/nettsted" "/app"
  legg_til_appen "$UT/nettsted"
  publiser "$UT/nettsted" "$PROSJEKT"
fi
