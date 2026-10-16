#!/bin/sh
# Entrypoint of the migrate image: syncs one database's roles, then applies its pending
# migrations. The ECS task (or `docker run`) picks the database with the first argument and
# supplies the libpq connection variables plus that database's role passwords.
#   run.sh metadata   GOVBOT_INGEST_PASSWORD, GOVBOT_APP_PASSWORD
#   run.sh vectors    VECTORS_INGEST_PASSWORD, VECTORS_APP_PASSWORD
set -eu

database="${1:-}"
here=$(dirname "$0")
root="$here/.."

case "$database" in
    metadata | vectors) ;;
    *)
        echo "usage: run.sh metadata|vectors" >&2
        exit 2
        ;;
esac

echo "[$database] ${PGUSER:-?}@${PGHOST:-?}/${PGDATABASE:-?}"
"$root/$database/scripts/sync-roles.sh"
MIGRATIONS_DIR="$root/$database/migrations" "$here/migrate.sh"
