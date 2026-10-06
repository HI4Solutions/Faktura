#!/usr/bin/env bash
# Starter en midlertidig Postgres, kjører migreringene som en vanlig (ikke-superbruker)
# eier slik som i Cloud SQL, og kjører testene i db/tests.
#
# Lokalt: scripts/test-db.sh  (krever Postgres 16-binærene)
# I CI:   DATABASE_URL settes til en tjenestecontainer, se .github/workflows/ci.yml
set -euo pipefail

rot="$(cd "$(dirname "$0")/.." && pwd)"

if [[ -z "${DATABASE_URL:-}" ]]; then
  pgbin="${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
  tmp="$(mktemp -d)"
  chmod 777 "$tmp"
  som=()
  if [[ "$(id -u)" == "0" ]]; then som=(sudo -u postgres); fi
  "${som[@]}" "$pgbin/initdb" -D "$tmp/data" -U postgres -A trust >/dev/null
  "${som[@]}" "$pgbin/pg_ctl" -D "$tmp/data" -o "-k $tmp -p 54329 -c listen_addresses=''" -l "$tmp/log" -w start >/dev/null
  trap '"${som[@]}" "$pgbin/pg_ctl" -D "$tmp/data" -m immediate stop >/dev/null; rm -rf "$tmp"' EXIT
  ADMIN_URL="postgresql://postgres@/postgres?host=$tmp&port=54329"
  base="postgresql://%s@/faktura?host=$tmp&port=54329"
else
  ADMIN_URL="$DATABASE_URL"
  # DATABASE_URL peker på en superbruker; testbrukerne har ikke passord (trust i CI).
  base="${TEST_URL_MAL:?TEST_URL_MAL må settes sammen med DATABASE_URL, f.eks. postgresql://%s@localhost:5432/faktura}"
fi

psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -q <<'SQL'
drop database if exists faktura;
drop role if exists test_api, test_worker, migrator, faktura_app, faktura_system;
create role migrator login createrole;
create database faktura owner migrator;
SQL

DATABASE_URL="$(printf "$base" migrator)" "$rot/scripts/migrer.sh"

psql "$(printf "$base" migrator)" -v ON_ERROR_STOP=1 -q <<'SQL'
create role test_api login in role faktura_app;
create role test_worker login in role faktura_system;
SQL

feil=0
for t in "$rot"/db/tests/*.sql; do
  echo "Test: $(basename "$t")"
  if ! psql "$(printf "$base" migrator)" -v ON_ERROR_STOP=1 -q \
        -v api="$(printf "$base" test_api)" -v worker="$(printf "$base" test_worker)" \
        -v migrator="$(printf "$base" migrator)" -o /dev/null -f "$t"; then
    feil=1
  fi
done

if [[ $feil == 0 ]]; then echo "Alle databasetester er grønne."; else echo "Databasetester feilet."; exit 1; fi

# Servertestene (API mot samme database) når SERVER_TESTER=1.
if [[ "${SERVER_TESTER:-}" == "1" ]]; then
  echo "Servertester"
  (cd "$rot/server" && DATABASE_URL="$(printf "$base" test_api)" SYSTEM_DATABASE_URL="$(printf "$base" test_worker)" AUTH_TEST=1 EHF_OPPSLAG=av npx vitest run)
fi
