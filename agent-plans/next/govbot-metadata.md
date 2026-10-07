# govbot-metadata: next steps

Phase 1 (the database service) is in the repo: `govbot-postgres-db/`, `terraform/govbot-postgres-db.tf`, the Ansible inventory and playbook, and the Jenkins `services` entry. It hasn't been deployed or run yet. Follow these steps in order.

## Before pushing

1. **Create three Jenkins secret-text credentials:**
   - `govbot-postgres-admin-password`
   - `govbot-postgres-ingest-password`
   - `govbot-postgres-app-password`

   Make them long and alphanumeric. Compose interpolates `$` inside `.env`, so passwords containing `$` would break.
2. **Check the VM choices.** `terraform/govbot-postgres-db.tf` uses:
   - VM ID `9160`
   - IP `192.168.1.134` (it didn't answer ping on 2026-10-06)
   - node `pve-dell-laptop`, the same node as its clients, rag-api and knowledge-ingest; nuc2 is already full with qq-api and vector-db
   - 2 cores and 2 GB RAM

   Change any of these that are wrong before the first apply.
3. **Disk size.** No `disk` block is set, so the VM inherits the template's disk, the same as the other services. The plan called for 32–64 GB. Check the template's disk size. If it's smaller, add a `disk` block that resizes the cloned disk; it must match the template's interface and datastore, or it adds a second disk.
4. **`prevent_destroy` is already on the VM.** Any plan that would replace it fails, including changes to attributes like `node_name` or `vm_id`. If you need to iterate on the VM before it holds real data, remove the lifecycle block temporarily.

## Phase 1 acceptance test

After Jenkins has applied Terraform and run the playbook, SSH to `192.168.1.134` and check:

```bash
# server up
sudo docker exec govbot-postgres-db pg_isready -h 127.0.0.1 -U govbot_db_admin -d govbot

# roles, schema and recorded migrations
sudo docker exec govbot-postgres-db psql -U govbot_db_admin -d govbot -c '\du' -c '\dt' \
  -c 'SELECT * FROM schema_migrations'
```

Then test the roles from the client VMs, since `pg_hba.conf` only admits each role from its own host:

```bash
# from knowledge-ingest (192.168.1.132): insert works
psql "postgresql://govbot_ingest:<pw>@192.168.1.134/govbot" -c \
  "INSERT INTO executive_orders (source, source_document_id, jurisdiction, eo_number)
   VALUES ('acceptance-test', 'test-1', 'Test', 'TEST-1')"

# from rag-api (192.168.1.133): read works, write is denied
psql "postgresql://govbot_app:<pw>@192.168.1.134/govbot" -c "SELECT * FROM executive_orders"
psql "postgresql://govbot_app:<pw>@192.168.1.134/govbot" -c "DELETE FROM executive_orders"   # must fail

# from any other host: connection is rejected
```

Next, redeploy: `sudo docker compose down && sudo docker compose up -d` in `/opt/govbot-postgres-db`, or push a change. Confirm the test row survived. Then delete it as admin:

```sql
DELETE FROM executive_orders WHERE source = 'acceptance-test';
```

If the role tests fail with a `172.x` address in the `pg_hba` error, Docker isn't preserving source IPs; see the README troubleshooting section.

## Add a health check to the CI/CD workflow (plan step 7)

The Jenkins entry has no `port` on purpose, so the `Health Check` stage is skipped. Today the only gate is the playbook's `wait: true` on the container healthcheck. `healthCheck()` in the Jenkinsfile only does HTTP via `curl | grep`. Two ways to fix that:

- Add a `healthCheck.type` (for example `'tcp'` or `'postgres'`) and branch in `healthCheck()`.
- Have Jenkins run `pg_isready -h 192.168.1.134 -p 5432` itself. This needs the postgres client on the Jenkins host. `pg_isready` doesn't authenticate, so `pg_hba.conf` isn't a problem.

Either way, also cover the port being reachable from the LAN.

## Backups (plan step 8)

- The nightly `pg_dump` currently lands on the VM's own disk at `/srv/govbot-postgres-db/backups`, with 14 days kept. Copy the dumps somewhere durable, such as files-01, a NAS, or offsite. Also decide on VM-level backups (Proxmox vzdump) for this VM.
- **Do a full restore drill once** using the restore commands in `govbot-postgres-db/README.md`, before the crawler starts relying on the database.
- Consider alerting when the backup log hasn't had a `wrote` line in more than 24 hours.

## Connect the crawler/ingest (plan step 5)

Do this only after the acceptance test and the restore drill pass.

- The work is split across two containers today:
  - `knowledge-crawler` knows EO metadata: order id, description, PDF URL, content hash, listed/unlisted.
  - `knowledge-ingest` knows the Qdrant side: chunk count, document id, success or failure.

  The likely split: the crawler does the `executive_orders` UPSERT and `ingest_runs` bookkeeping; ingest moves `qdrant_status` from `pending` to `indexed` or `failed` and sets `qdrant_chunk_count`, `qdrant_indexed_at` and `last_ingested_at`.
- Add `GOVBOT_DATABASE_URL` (the `govbot_ingest` role) as a Jenkins credential to the knowledge-ingest `env` list.
- **Mapping for Georgia:**

  | Crawler data                      | Column                          |
  | --------------------------------- | ------------------------------- |
  | order id (`01.02.25.01`)          | `source_document_id` and `eo_number` |
  | `'Georgia'`                       | `jurisdiction`                  |
  | description                       | `title`                         |
  | year page URL                     | `source_url`                    |
  | PDF URL                           | `document_url`                  |
  | `currentlyListed`, `lastModified`, `text_extraction` | `raw_metadata` |

  `signing_date` can probably be parsed from the `MM.DD.YY.NN` id; verify that against a few PDFs. `issued_by` (the governor) can be set from the date range.
- Change detection should use `content_hash`: skip re-embedding when it's unchanged and the row is `indexed`. On a hash change, set the row to `pending` before touching Qdrant.
- Backfill: the first run should UPSERT every order already in `crawler-state`/Qdrant. Otherwise the stats undercount until each order is next re-crawled.
- Retry rows with `qdrant_status = 'failed'` on the next run.

## Corpus stats in GovBot (plan step 6)

- Add a migration, for example `002_corpus_stats_view.sql`, with a `govbot_corpus_stats` view (count, earliest and latest `signing_date`, `last_ingested_at`) and a per-year view. Count only `WHERE qdrant_status = 'indexed'`. Default privileges already give `govbot_app` `SELECT` on new views.
- In rag-api:
  - Add a `pg` client as `govbot_app`, with a Jenkins credential added to its `env` list.
  - Cache the stats for about a minute.
  - Feed them into the prompt (`rag-api/src/rag/prompts.ts`).
  - Fail soft: if Postgres is down, leave the stats out rather than failing the chat.

## Optional hardening

- Port 5432 is published to the whole LAN and `pg_hba.conf` is the only gate. For defense in depth, add `DOCKER-USER` iptables rules that only allow `.132` and `.133` (ufw rules alone don't apply to Docker-published ports).
- Turn on TLS for client connections (`ssl=on` plus a cert), then switch `pg_hba` entries to `hostssl`.
- Pin the image by digest, or at least watch for 18.x minor releases.
