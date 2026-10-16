# Metadata database

PostgreSQL 18 holding GovBot's structured executive order metadata and ingest bookkeeping. The vectors database (`../vectors`) is the search index; this database is the source of truth for which orders exist, which are indexed, and corpus statistics. Migrating, roles and the migrate image are covered in [`../README.md`](../README.md); handy queries are in [`help.md`](help.md).

The live homelab copy (`govbot-postgres-db` on VM .134, deployed by Jenkins from the `homelab` repo) still runs alongside; its VM, `pg_hba.conf` and backup docs live in that repo. On AWS, security groups replace `pg_hba.conf` and RDS automated backups replace the nightly `pg_dump`.

| Setting | Value |
| --- | --- |
| Database | `govbot` |
| Admin user | `govbot_db_admin` |

## Roles

| Role | Used by | Access |
| --- | --- | --- |
| `govbot_db_admin` | migrations | owner |
| `govbot_ingest` | crawler, ingest | `SELECT`, `INSERT`, `UPDATE` |
| `govbot_app` | rag-api | `SELECT` |

## Writers

The crawler and ingest (both as `govbot_ingest`) keep `executive_orders` current. See [`agent-plans/plan/crawler-ingest-db.md`](../../agent-plans/plan/crawler-ingest-db.md).

| Writer | Writes |
| --- | --- |
| crawler (1 AM) | UPSERTs order metadata on every run; one `ingest_runs` row per source per run |
| ingest (3 AM) | `qdrant_status`, `qdrant_document_id`, `qdrant_chunk_count`, `qdrant_indexed_at`, `last_ingested_at` |

The `qdrant_*` names predate the move to pgvector and will be renamed in a later migration. `qdrant_document_id` is the document's knowledge base key, the same value as `documents.source` in the vectors database.

`qdrant_status` lifecycle:

- `pending`: a new row, or the crawler rewrote the order's Markdown. Ingest also sets it when an order's file is removed and its vectors are deleted.
- `indexed`: the vectors database has the current Markdown. Re-asserted on every ingest run, including for unchanged files.
- `failed`: ingest couldn't index the current Markdown. The next run retries it.

Both writers are fail-soft. If this database is down, they log `[DB-FAIL]`, carry on, and exit 1. The next run repairs the rows. To populate rows for orders crawled before the database existed, run the crawler with `--backfill-db` (see [`services/crawler/README.md`](../../services/crawler/README.md)).
