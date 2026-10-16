#!/bin/sh
# Creates the vectors database's login roles and (re)sets their passwords from the environment.
# run.sh runs it before the migrations on every migrate task. Passwords are read inside psql with
# \getenv so they never appear on a command line. Connects with the libpq variables, as the
# database's admin user.
set -eu

: "${VECTORS_INGEST_PASSWORD:?VECTORS_INGEST_PASSWORD is not set}"
: "${VECTORS_APP_PASSWORD:?VECTORS_APP_PASSWORD is not set}"

psql -v ON_ERROR_STOP=1 --no-psqlrc --quiet <<'SQL'
\getenv ingest_password VECTORS_INGEST_PASSWORD
\getenv app_password VECTORS_APP_PASSWORD

SELECT 'CREATE ROLE vectors_ingest'
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'vectors_ingest') \gexec

SELECT 'CREATE ROLE vectors_app'
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'vectors_app') \gexec

-- table grants live in the migrations; these only control login
ALTER ROLE vectors_ingest WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD :'ingest_password';
ALTER ROLE vectors_app WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD :'app_password';
SQL

echo "Roles synced"
