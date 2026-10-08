# Plan: connect knowledge-crawler and knowledge-ingest to govbot-postgres-db

## Context
`govbot-postgres-db` (192.168.1.134) has the `executive_orders` and `ingest_runs` tables, and the rag-api `searchExecutiveOrders` tool already reads from them. Nothing writes to them yet. This is step 5 of `agent-plans/plan/govbot-metadata.md`: make the crawler and the ingest service keep the database current, so `qdrant_status = 'indexed'` means "this order is searchable in Qdrant right now".

Both containers run on the knowledge-ingest VM (192.168.1.132). `pg_hba.conf` already admits `govbot_ingest` from that address. Container traffic leaves through the VM's IP, so no database change is needed.

**Gate:** start this only after the Phase 1 acceptance test and the restore drill pass (see Next steps).

## Who writes what

The two containers know different things, and each writes only what it knows:

| Writer | Knows | Writes |
| --- | --- | --- |
| `knowledge-crawler` (1 AM) | order id, description, PDF URL, PDF hash, listed/unlisted | UPSERTs `executive_orders` metadata; sets `qdrant_status = 'pending'` whenever it rewrites an order's Markdown; one `ingest_runs` row per source per run |
| `knowledge-ingest` (3 AM) | which Markdown files are in Qdrant, chunk ids, success/failure | `qdrant_status` (`indexed`/`failed`), `qdrant_document_id`, `qdrant_chunk_count`, `qdrant_indexed_at`, `last_ingested_at` |

The crawler only ever moves a row to `pending`, and ingest only ever moves it out of `pending`. Ingest never inserts rows; the crawler never touches the `qdrant_*` result columns.

### Self-healing instead of exact-once
Neither service treats the database as the source of truth for its own decisions. Each keeps its existing state file (`crawler-state/ga-executive-orders.json`, `app-state/state.json`) and **re-asserts** its view of the database on every run:

- The crawler UPSERTs every listed order on every run, not just new or changed ones, which also keeps `last_seen_at` current.
- Ingest updates the row for every executive order it processes, **including skipped (unchanged) ones**. For a skipped document it writes `indexed` with the chunk count and `lastIndexedAt` from its state file.

So a database outage, a failed write, or a row created after the vectors (the backfill) is corrected on the next run without re-embedding anything.

### Failure policy
- `GOVBOT_DATABASE_URL` unset (local dev): the database is disabled, and behavior is exactly as it is today.
- URL set but the database is unreachable at startup (`SELECT 1` fails): log `[DB-FAIL]`, run without the database, and set `process.exitCode = 1` so the run shows as failed.
- A single write fails mid-run: log `[DB-FAIL] <id> - <error>`, carry on, and exit 1 at the end. Qdrant and the Markdown files are never held up by Postgres.

## Approach

### 1. Dependencies and deploy wiring
- In both `knowledge-ingest/` and `knowledge-ingest/crawler/` (separate npm projects and build contexts), run `npm i pg` and `npm i -D @types/pg`.
- `knowledge-ingest/compose.yml`: add to **both** services
  ```yaml
  # crawler/ingest role on govbot-postgres-db (pg_hba admits it only from this VM)
  - GOVBOT_DATABASE_URL=postgresql://govbot_ingest:${GOVBOT_INGEST_PASSWORD}@192.168.1.134:5432/govbot
  ```
- `Jenkinsfile`, `knowledge-ingest` entry: add
  ```groovy
  // same credential as govbot-postgres-db's ingest role
  [credentialId: 'govbot-postgres-ingest-password', varName: 'GOVBOT_INGEST_PASSWORD']
  ```
  This follows the rag-api pattern: Jenkins injects the password and Compose builds the URL. The password must stay alphanumeric because Compose interpolates `$`.

### 2. Crawler database module: new `crawler/src/db.ts`
`connectDb(): Promise<CrawlerDb | undefined>` returns `undefined` when the URL is unset or `SELECT 1` fails (see Failure policy). It uses a small `pg.Pool` (`max: 2`, `statement_timeout: 10000`, `connectionTimeoutMillis: 5000`, plus an `error` listener, as in `rag-api/src/db.ts`). `CrawlerDb` exposes:

- `upsertExecutiveOrder(record: ExecutiveOrderRecord): Promise<void>`
  ```sql
  INSERT INTO executive_orders
      (source, source_document_id, jurisdiction, eo_number, title, issued_by, signing_date,
       source_url, document_url, content_hash, raw_metadata, last_seen_at, qdrant_status)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'pending')
  ON CONFLICT (source, source_document_id) DO UPDATE SET
      title         = EXCLUDED.title,
      issued_by     = EXCLUDED.issued_by,
      signing_date  = EXCLUDED.signing_date,
      source_url    = EXCLUDED.source_url,
      document_url  = EXCLUDED.document_url,
      content_hash  = COALESCE(EXCLUDED.content_hash, executive_orders.content_hash),
      raw_metadata  = executive_orders.raw_metadata || EXCLUDED.raw_metadata,
      last_seen_at  = EXCLUDED.last_seen_at,
      qdrant_status = CASE WHEN $13 THEN 'pending' ELSE executive_orders.qdrant_status END
  ```
  `$13` is `record.markdownRewritten`. New rows always start `pending`. `raw_metadata` is merged with `||` so keys not sent on this run (for example `textExtraction` on a 304 skip) keep their previous value.
- `markUnlisted(source, ids[])`: `UPDATE … SET raw_metadata = raw_metadata || '{"currentlyListed": false}'` for orders that dropped off the year's page. Rows are never deleted (the role has no `DELETE`).
- `startRun(source)` / `finishRun(runId, result | error)` for `ingest_runs`. `startRun` first closes any `running` row left by a killed run for the same source (`status = 'failed'`, `error_message = 'abandoned'`). That is safe because supercronic doesn't overlap runs.
- `end()`, called at the end of `main()` so idle pool clients don't keep the process alive.

Add `ExecutiveOrderRecord` to `crawler/src/types.ts`, and an optional `db?: CrawlerDb` to `CrawlContext`, so sources that don't produce executive orders ignore it.

### 3. Georgia mapping: `crawler/src/sources/ga-executive-orders.ts`

| Crawler data | Column |
| --- | --- |
| `NAME` (`'ga-executive-orders'`) | `source` |
| order id (`01.02.25.01`) | `source_document_id` and `eo_number` |
| `'Georgia'` | `jurisdiction` |
| description (empty → `null`) | `title` |
| `sourceUrl(year)` | `source_url` |
| `pdfUrl` | `document_url` |
| sha256 of the PDF (the existing `contentHash`) | `content_hash` |
| parsed from the id | `signing_date` |
| governor in office on `signing_date` | `issued_by` |
| `{ currentlyListed, lastModified, textExtraction, year }` | `raw_metadata` |

- `parseSigningDate(id)`: `MM.DD.YY.NN` → `20YY-MM-DD`. Return `null` (with a `[WARN]`) when the date doesn't round-trip through `Date`, so a bad id never blocks the row.
- `governorOn(date)`: a small dated table: Perdue from 2003-01-13, Deal from 2011-01-10, Kemp from 2019-01-14. Kemp's term ends in January 2027. Give his entry an end date and add the successor once the inauguration date is set. Dates outside the table get `null`.
- **Verify before relying on it:** open five or six PDFs across different years and check the signed date against the id. Also check one order from 2019-01-14, the inauguration day, since that day's orders could belong to either governor.
- In the per-order loop, call `db?.upsertExecutiveOrder(...)` in every branch:
  - 304 / unchanged: `markdownRewritten: false`, `content_hash` from state
  - new / updated: `markdownRewritten: true`, with `textExtraction` from `pdfText`
  - failed: `markdownRewritten: false`, `content_hash: null` (COALESCE keeps the old one)

  A failed new order still gets a `pending` row, which is harmless because stats count only `indexed`, and it records that the order was discovered.
- After the unlisted-flagging loop, call `db?.markUnlisted(NAME, ids)`.
- Each DB call gets its own `try/catch` that logs `[DB-FAIL] <id>` and sets a `dbFailed` flag. It never adds the id to `result.failed`, because that list means "Markdown not written".

### 4. Run bookkeeping: `crawler/src/index.ts`
- `healthCheck()` also calls `connectDb()`, and the result goes into each source's `CrawlContext`.
- Around each `source.crawl()`: `startRun(source.name)`, then `finishRun` with `documents_seen = discovered`, `documents_inserted = created`, `documents_updated = updated`, `documents_unchanged = unchanged`, `documents_failed = failed`. Status is `succeeded`, or `failed` with `error_message` when `crawl()` threw.
- At the end, exit 1 if any DB write failed (see Failure policy), then `db.end()`.

### 5. Backfill: `npm run crawl -- --backfill-db`
The nightly cron only crawls the current year, so earlier years' orders would never reach the database. Add a `--backfill-db` flag to `parseArgs` that skips crawling and instead UPSERTs every entry in `crawler-state/ga-executive-orders.json` with `markdownRewritten: false`. Every field can be derived from state: `year` → `source_url`, plus `pdfUrl`, `description`, `contentHash`, `currentlyListed` and `lastModified`. `textExtraction` is read from the Markdown frontmatter when the file exists.

The rows land as `pending`. The next ingest run sees each file unchanged, so it reconciles them to `indexed` from its state file (step 6) without re-embedding. Implement this as an optional `backfill?(context)` on `Source` so the logic stays in the Georgia module.

### 6. Ingest status updates: `knowledge-ingest/src/`
- **New `src/db.ts`:** same `connectDb()` shape as the crawler. It exposes:
  - `markIndexed(ref, { documentId, chunkCount, indexedAt })`: `UPDATE executive_orders SET qdrant_status = 'indexed', qdrant_document_id = …, qdrant_chunk_count = …, qdrant_indexed_at = $indexedAt, last_ingested_at = $indexedAt WHERE jurisdiction = $1 AND eo_number = $2`
  - `markFailed(ref)`: sets `qdrant_status = 'failed'`
  - `markRemoved(documentId)`: sets `qdrant_status = 'pending'` `WHERE qdrant_document_id = $1`, for orphaned files whose vectors were deleted. The file is gone, so match on the stored document id instead of frontmatter.

  If `rowCount` is 0, `markIndexed` logs `[DB-MISS] <key>` and moves on. The crawler creates the row next run, and the following ingest reconciles it.
- **Frontmatter:** in `src/documents.ts`, add `executiveOrderRef(text): { jurisdiction, eoNumber } | undefined`. It reads the leading `---` block and returns a ref only when `document_type: executive_order`, `jurisdiction` and `order_number` are all present, stripping quotes from `order_number`. A three-key regex parser is enough, since the crawler controls this format; it doesn't need a YAML dependency. The Insurellm sample docs have no frontmatter, so they're never written to the database.
- **In the `ingest()` loop** (`src/index.ts`), when `ref` is set:
  - **skip (unchanged):** `markIndexed(ref, { documentId: key, chunkCount: previous.chunkIds.length, indexedAt: previous.lastIndexedAt })`. This is the reconcile path.
  - **success:** after `checkpoint()`, `markIndexed` with the new chunk count and the same timestamp written to state.
  - **failure:** `markFailed(ref)`. No extra retry logic is needed: the state entry keeps its old hash, so the next run retries the document anyway.
  - **orphan deleted:** `markRemoved(key)`.
- `qdrant_document_id` is the state key, for example `georgia/executive-orders/01.02.25.01.md`. It's the same value as `source` on every chunk payload, so a row can be traced straight to its Qdrant points.
- Add a `DB writes failed` row to the run summary, and exit 1 when it's non-zero.

### 7. Docs
- `crawler/README.md`: add `GOVBOT_DATABASE_URL` to the env var table. Rewrite "the crawler's only contract with ingest is `.md` files" to also cover the database. Add `--backfill-db` under Running. Add an item to the new-source checklist: "if the source produces executive orders, UPSERT them via `context.db`".
- `govbot-postgres-db/README.md`: add a short "Writers" section that links here and gives the pending/indexed/failed lifecycle.

## Files touched
- `knowledge-ingest/compose.yml`, `Jenkinsfile`
- `knowledge-ingest/crawler/package.json`, `src/db.ts` (new), `src/types.ts`, `src/index.ts`, `src/sources/ga-executive-orders.ts`, `README.md`
- `knowledge-ingest/package.json`, `src/db.ts` (new), `src/documents.ts`, `src/index.ts`
- `govbot-postgres-db/README.md`

## Verification
No local containers. Use static checks locally, then the real VMs.

1. `npm run build` in both `knowledge-ingest/` and `knowledge-ingest/crawler/`.
2. Check `parseSigningDate` / `governorOn` with a throwaway `tsx` script in the scratchpad: a normal id, a leap day, an invalid month, and an inauguration-day boundary.
3. Run locally **without** `GOVBOT_DATABASE_URL`: `KNOWLEDGE_BASE_PATH=/tmp/kb CRAWLER_STATE_PATH=/tmp/crawler-state npm run dev` for the crawler, then ingest against its local `.env`. The output should match today's apart from a "database disabled" line.
4. Deploy through Jenkins, after creating or confirming the `govbot-postgres-ingest-password` credential.
5. On 192.168.1.132:
   ```bash
   cd /opt/knowledge-ingest
   sudo docker compose run --rm knowledge-crawler node dist/index.js --backfill-db
   sudo docker compose run --rm knowledge-ingest node dist/index.js
   ```
6. As admin on 192.168.1.134:
   ```sql
   SELECT qdrant_status, count(*) FROM executive_orders GROUP BY 1;
   -- every order with a Markdown file should be indexed; compare with
   -- `ls /opt/knowledge-ingest/knowledge-base/georgia/executive-orders/*.md | wc -l` on .132
   SELECT eo_number, signing_date, issued_by, title FROM executive_orders ORDER BY signing_date DESC LIMIT 10;
   SELECT * FROM ingest_runs ORDER BY id DESC LIMIT 5;
   ```
7. Run the crawler for the current year (`node dist/index.js`), then ingest. Everything should be `unchanged`, statuses should stay `indexed`, and `last_seen_at` should advance.
8. Change-detection check: delete one order's `.md` on the VM and run the crawler. That row goes `pending`. Run ingest and it returns to `indexed` with a fresh `qdrant_indexed_at`.
9. Fail-soft check: run the crawler once with a bad host in `GOVBOT_DATABASE_URL` (`docker compose run -e …`). It should still crawl, log `[DB-FAIL]`, and exit 1.
10. Ask GovBot "how many executive orders were signed in 2025?" and confirm `searchExecutiveOrders` now returns rows.

## Next steps
Carried over from `agent-plans/next/govbot-metadata.md`. The "Connect the crawler/ingest" section is this plan, so it isn't repeated here.

### Phase 1 acceptance test
After Jenkins has applied Terraform and run the playbook, SSH to `192.168.1.134` and check:
```bash
sudo docker exec govbot-postgres-db pg_isready -h 127.0.0.1 -U govbot_db_admin -d govbot
sudo docker exec govbot-postgres-db psql -U govbot_db_admin -d govbot -c '\du' -c '\dt' \
  -c 'SELECT * FROM schema_migrations'
```
Then test the roles from the client VMs:
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
Redeploy (`sudo docker compose down && sudo docker compose up -d` in `/opt/govbot-postgres-db`, or push a change), confirm the test row survived, then delete it as admin: `DELETE FROM executive_orders WHERE source = 'acceptance-test';`. If the role tests fail with a `172.x` address in the `pg_hba` error, Docker isn't preserving source IPs; see the README troubleshooting section.

### Add a health check to the CI/CD workflow (plan step 7)
The Jenkins entry has no `port`, so the `Health Check` stage is skipped. The only gate today is the playbook's `wait: true`, and `healthCheck()` only does HTTP. Either add a `healthCheck.type` (`'tcp'` / `'postgres'`) and branch on it, or have Jenkins run `pg_isready -h 192.168.1.134 -p 5432`, which needs the postgres client on the Jenkins host. `pg_isready` doesn't authenticate, so `pg_hba.conf` isn't a problem. Either way, also check that the port is reachable from the LAN.

### Backups (plan step 8)
- Nightly `pg_dump` output lands on the VM's own disk (`/srv/govbot-postgres-db/backups`, 14 days kept). Copy the dumps somewhere durable (files-01, a NAS, or offsite), and decide on Proxmox vzdump backups for this VM.
- **Do a full restore drill once** with the commands in `govbot-postgres-db/README.md`, before the crawler starts relying on the database. This gates this plan.
- Consider alerting when the backup log hasn't had a `wrote` line in more than 24 hours.

### Corpus stats in GovBot (plan step 6)
- Add migration `002_corpus_stats_view.sql` with a `govbot_corpus_stats` view (count, earliest and latest `signing_date`, `last_ingested_at`) and a per-year view, counting only `WHERE qdrant_status = 'indexed'`. Default privileges already give `govbot_app` `SELECT` on new views.
- In rag-api, the `pg` client (`src/db.ts`) and the `govbot-postgres-app-password` credential already exist from the `searchExecutiveOrders` work. What's left: cache the stats for about a minute, feed them into `rag-api/src/rag/prompts.ts`, and fail soft by leaving the stats out if Postgres is down.

### Optional hardening
- Port 5432 is published to the whole LAN, with `pg_hba.conf` as the only gate. Add `DOCKER-USER` iptables rules that allow only `.132` and `.133` (ufw rules don't apply to Docker-published ports).
- Turn on TLS for client connections (`ssl=on` plus a cert), then switch the `pg_hba` entries to `hostssl`.
- Pin the image by digest, or at least watch for 18.x minor releases.
