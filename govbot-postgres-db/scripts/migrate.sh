#!/bin/sh
# Applies /migrations/*.sql in filename order, each exactly once and in its own transaction,
# recording what ran in schema_migrations. Runs inside the container on every deploy.
# Migrations must never be edited once applied - add a new numbered file instead.
set -eu

psql_admin() {
    psql -v ON_ERROR_STOP=1 --no-psqlrc --quiet --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" "$@"
}

psql_admin <<'SQL'
CREATE TABLE IF NOT EXISTS schema_migrations (
    version    text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
);
SQL

applied=0

for file in /migrations/*.sql; do
    [ -e "$file" ] || continue
    version=$(basename "$file" .sql)

    already_applied=$(
        echo "SELECT 1 FROM schema_migrations WHERE version = :'version'" |
            psql_admin --tuples-only --no-align -v version="$version"
    )
    [ -n "$already_applied" ] && continue

    # the migration and its schema_migrations row commit together or not at all
    echo "INSERT INTO schema_migrations (version) VALUES (:'version')" |
        psql_admin --single-transaction -v version="$version" -f "$file" -f -

    echo "Applied $version"
    applied=$((applied + 1))
done

[ "$applied" -eq 0 ] && echo "No pending migrations"
exit 0
