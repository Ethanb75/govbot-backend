# Databases

GovBot has two PostgreSQL 18 databases. On AWS each is its own RDS instance; locally, `compose.dev.yml` runs both on one pgvector server.

| Database | What it holds | Roles |
| --- | --- | --- |
| [`metadata/`](metadata/README.md) (`govbot`) | executive order metadata and crawl/ingest bookkeeping, the source of truth for which orders exist and are indexed | `govbot_ingest` (crawler, ingest: read/write), `govbot_app` (rag-api: read) |
| `vectors/` | the search index: `documents` (what ingest last indexed per file) and `chunks` (content + `halfvec(3072)` embedding, HNSW cosine index) | `vectors_ingest` (ingest: read/write/delete), `vectors_app` (rag-api: read) |

The admin user owns everything and only the migrate task uses it. The metadata migrations name it `govbot_db_admin` and the database `govbot`, so the RDS instance must use those names.

## Layout

```text
Dockerfile                 the migrate image: psql 18 + the scripts and migrations below
scripts/run.sh             entrypoint: run.sh metadata|vectors - sync roles, then migrate
scripts/migrate.sh         applies $MIGRATIONS_DIR/*.sql once each, in order, recorded in schema_migrations
<db>/scripts/sync-roles.sh creates that database's login roles and (re)sets their passwords
<db>/migrations/           numbered schema migrations
dev/                       compose.dev.yml helpers only
```

## Migrating

```bash
docker buildx build -f db/Dockerfile db     # note: db/ is the build context
```

The image connects with the standard libpq variables (`PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`, `PGSSLMODE`) as the admin user, and reads the role passwords from the environment:

| `run.sh` argument | Passwords |
| --- | --- |
| `metadata` | `GOVBOT_INGEST_PASSWORD`, `GOVBOT_APP_PASSWORD` |
| `vectors` | `VECTORS_INGEST_PASSWORD`, `VECTORS_APP_PASSWORD` |

On AWS it runs as a one-off ECS task, once per database, whenever `db/**` changes. Rotating a role's password is an SSM parameter change plus a migrate run. Passwords are read inside psql with `\getenv`, so they never appear on a command line.

## Migrations

Add a new numbered file, such as `metadata/migrations/002_corpus_stats_view.sql`. Never edit a migration that has already been applied. Each file runs as the admin user in its own transaction, together with its `schema_migrations` row. Default privileges give new tables the same access as the originals.

`EMBEDDING_DIMENSIONS` (`packages/shared`) must match the `halfvec(3072)` column in `vectors/migrations/001_chunks.sql`. Changing the embedding size means a new migration and a full re-ingest.
