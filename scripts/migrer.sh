#!/usr/bin/env bash
# Kjører migreringene i db/migrations som ikke er kjørt før, i rekkefølge.
# Bruk: DATABASE_URL=postgres://... scripts/migrer.sh
# Hver fil kjøres i én transaksjon og registreres i faktura_migreringer.
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL må være satt}"
dir="$(cd "$(dirname "$0")/../db/migrations" && pwd)"

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q <<'SQL'
create table if not exists public.faktura_migreringer (
  navn text primary key,
  kjort timestamptz not null default now()
);
SQL

for fil in "$dir"/*.sql; do
  navn="$(basename "$fil")"
  kjort="$(psql "$DATABASE_URL" -tAc "select 1 from public.faktura_migreringer where navn = '$navn'")"
  if [[ "$kjort" == "1" ]]; then
    continue
  fi
  echo "Kjører $navn"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -1 \
    -f "$fil" \
    -c "insert into public.faktura_migreringer (navn) values ('$navn')"
done

# Gi tjenestekontoene (Cloud SQL IAM-brukere) riktig rolle, hvis oppgitt.
if [[ -n "${API_DB_USER:-}" ]]; then
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -c "grant faktura_app to \"$API_DB_USER\""
fi
if [[ -n "${WORKER_DB_USER:-}" ]]; then
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -c "grant faktura_system to \"$WORKER_DB_USER\""
fi
echo "Migreringene er oppdatert."
