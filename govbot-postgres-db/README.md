# govbot-postgres-db

PostgreSQL 18 holding GovBot's structured executive order metadata and ingest state. Qdrant (`vector-db`) stays the search index; this database is the source of truth for which orders exist, which are indexed, and corpus statistics. 

| Setting         | Value                          |
| --------------- | ------------------------------ |
| VM              | `govbot-postgres-db` (ID 9160) |
| Address         | `192.168.1.134:5432`           |
| Database        | `govbot`                       |
| App directory   | `/opt/govbot-postgres-db`      |
| Data            | `/srv/govbot-postgres-db/data` |
| Backups         | `/srv/govbot-postgres-db/backups` |

## Layout

```text
compose.yml            postgres container (container name govbot-postgres-db)
config/pg_hba.conf     which roles may connect from which hosts
migrations/            numbered schema migrations, applied once each in order
scripts/sync-roles.sh  creates the login roles and sets their passwords (runs in the container)
scripts/migrate.sh     applies pending migrations (runs in the container)
backup.sh              nightly pg_dump (runs on the VM host via cron)
```

## Roles

| Role              | Used by                | Access                            | Connects from            |
| ----------------- | ---------------------- | --------------------------------- | ------------------------ |
| `govbot_db_admin` | migrations, backups    | owner/superuser                   | inside the container only |
| `govbot_ingest`   | crawler / ingest       | `SELECT`, `INSERT`, `UPDATE`      | `192.168.1.132` (knowledge-ingest) |
| `govbot_app`      | GovBot API             | `SELECT`                          | `192.168.1.133` (rag-api) |

Passwords come from the Jenkins credentials `govbot-postgres-admin-password`, `govbot-postgres-ingest-password` and `govbot-postgres-app-password`, written to `.env` at deploy time. Use alphanumeric passwords: Compose interpolates `$` in `.env` values.

`POSTGRES_ADMIN_PASSWORD` is only applied when the data directory is first initialised. The other two are re-applied on every deploy, so to rotate one, change the credential and redeploy.

## Writers

`knowledge-crawler` and `knowledge-ingest` (both on `192.168.1.132`, as `govbot_ingest`) keep `executive_orders` current. See [`agent-plans/plan/crawler-ingest-db.md`](../agent-plans/plan/crawler-ingest-db.md).

| Writer | Writes |
| --- | --- |
| crawler (1 AM) | UPSERTs order metadata on every run; one `ingest_runs` row per source per run |
| ingest (3 AM) | `qdrant_status`, `qdrant_document_id`, `qdrant_chunk_count`, `qdrant_indexed_at`, `last_ingested_at` |

`qdrant_status` lifecycle:

- `pending`: a new row, or the crawler rewrote the order's Markdown. Ingest also sets it when an order's file is removed and its vectors are deleted.
- `indexed`: ingest has the current Markdown in Qdrant. Re-asserted on every ingest run, including for unchanged files.
- `failed`: ingest couldn't index the current Markdown. The next run retries it.

Both writers are fail-soft. If this database is down, they log `[DB-FAIL]`, carry on, and exit 1. The next run repairs the rows. To populate rows for orders crawled before the database existed, run the crawler with `--backfill-db` (see `knowledge-ingest/crawler/README.md`).

## Deploy

Each Jenkins deploy:

1. Starts the container and waits for `pg_isready`.
2. Reloads `pg_hba.conf` if it changed.
3. Runs `scripts/sync-roles.sh`.
4. Runs `scripts/migrate.sh`.
5. Installs the backup cron job.

Jenkins only runs the playbook when a file under `govbot-postgres-db/` changes.

## Migrations

Add a new file, such as `migrations/002_corpus_stats_view.sql`. Never edit a migration that has already been applied. Each file runs as `govbot_db_admin` in its own transaction and is recorded in `schema_migrations`. Default privileges give new tables and views the same `govbot_ingest`/`govbot_app` access as the originals.

## Admin access

There is no LAN admin login. SSH to the VM and use the container:

```bash
sudo docker exec -it govbot-postgres-db psql -U govbot_db_admin -d govbot
```

## Backups and restore

Every night at 02:30 (VM time), the host writes `govbot-<timestamp>.dump` (custom format) to `/srv/govbot-postgres-db/backups` and keeps 14 days. The log is at `/var/log/govbot-postgres-db-backup.log`. Dumps leave out roles; a deploy recreates them.

To restore into a fresh database:

```bash
sudo docker exec govbot-postgres-db createdb -U govbot_db_admin govbot_restore
sudo docker exec -i govbot-postgres-db pg_restore -U govbot_db_admin -d govbot_restore --no-owner \
  < /srv/govbot-postgres-db/backups/govbot-<timestamp>.dump
```

## Troubleshooting

- **`no pg_hba.conf entry for host ...` from an allowed VM.** Docker should keep the client's source address on published ports. If the error names a `172.x` address, Docker is proxying the connection (userland-proxy) and `pg_hba.conf` never sees the real host.
- **The Terraform plan fails with `prevent_destroy`.** That's on purpose. Something in the change would replace this VM and wipe the database. Change the plan so it doesn't, or take a backup and remove the lifecycle block deliberately.
