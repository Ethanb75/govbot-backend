#!/bin/sh
# Creates the GovBot login roles and (re)sets their passwords from the container environment.
# Runs inside the container on every deploy, before migrations, so rotating a password is a
# Jenkins credential change plus a redeploy. Passwords are read inside psql with \getenv so they
# never appear on a command line.
set -eu

: "${GOVBOT_INGEST_PASSWORD:?GOVBOT_INGEST_PASSWORD is not set}"
: "${GOVBOT_APP_PASSWORD:?GOVBOT_APP_PASSWORD is not set}"

psql -v ON_ERROR_STOP=1 --no-psqlrc --quiet --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL'
\getenv ingest_password GOVBOT_INGEST_PASSWORD
\getenv app_password GOVBOT_APP_PASSWORD

SELECT 'CREATE ROLE govbot_ingest'
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'govbot_ingest') \gexec

SELECT 'CREATE ROLE govbot_app'
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'govbot_app') \gexec

-- table grants live in the migrations; these only control login
ALTER ROLE govbot_ingest WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD :'ingest_password';
ALTER ROLE govbot_app WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD :'app_password';
SQL

echo "Roles synced"
