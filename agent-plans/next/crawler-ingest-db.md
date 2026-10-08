# crawler-ingest-db: next steps

The crawler and ingest now write to `govbot-postgres-db` (see `agent-plans/plan/crawler-ingest-db.md`). The code builds and the parsers are checked, but nothing has run against the real database yet. Follow these steps in order.

| | |
| --- | --- |
| knowledge-ingest VM | `192.168.1.132`, app dir `/opt/knowledge-ingest` |
| govbot-postgres-db VM | `192.168.1.134`, container `govbot-postgres-db`, database `govbot` |
| Nightly schedule | crawler 1:00 AM, ingest 3:00 AM (`America/New_York`) |

## 1. Before deploying

1. **Gate:** the Phase 1 acceptance test and the restore drill (`agent-plans/next/govbot-metadata.md`) have both passed.
2. **The Jenkins credential `govbot-postgres-ingest-password` exists.** `govbot-postgres-db` already uses it, so it should. The knowledge-ingest entry must use the same credential, or the role's password won't match.
3. **Spot-check the signing dates.** Open five or six PDFs from different years and compare the signed date with the order id (`MM.DD.YY.NN`). Include any order from 2019-01-14, Kemp's inauguration day: the governor table gives that day to Kemp.

## 2. Deploy

Push to trigger Jenkins. The `knowledge-ingest` entry writes `GOVBOT_INGEST_PASSWORD` into `/opt/knowledge-ingest/.env`, and Compose recreates both containers because their environment changed.

Then, on `192.168.1.132`, check that both containers have the URL. These commands don't print the password:

```bash
cd /opt/knowledge-ingest
sudo docker compose ps
sudo grep -c '^GOVBOT_INGEST_PASSWORD=.' .env                         # expect 1
sudo docker compose exec knowledge-crawler sh -c 'test -n "$GOVBOT_DATABASE_URL" && echo crawler: set'
sudo docker compose exec knowledge-ingest  sh -c 'test -n "$GOVBOT_DATABASE_URL" && echo ingest: set'
```

## 3. Run the backfill on the VM

Don't run this between about 00:55 and the end of the 3 AM ingest, so it can't overlap the nightly jobs. `exec` runs inside the already-running containers, as the `node` user, with the same env and volumes as the cron jobs.

### 3a. Note the expected count

```bash
cd /opt/knowledge-ingest

# orders in the crawler's state file: what the backfill will write
sudo docker compose exec knowledge-crawler node -e \
  'console.log(Object.keys(require("/data/state/ga-executive-orders.json").documents).length)'

# Markdown files on disk: what ingest can mark indexed
ls knowledge-base/georgia/executive-orders/*.md | wc -l
```

The two numbers are normally equal. A failed new order has no state entry and no file, so neither count includes it.

### 3b. Backfill the crawler's rows

```bash
sudo docker compose exec knowledge-crawler node dist/index.js --backfill-db; echo "exit=$?"
```

Expect:

- `Database:       192.168.1.134:5432/govbot`, not `disabled`
- `[backfill] ga-executive-orders - <N> orders`, where `N` matches the state count from 3a
- no `[DB-FAIL]` lines, and `exit=0`

The rows are now `pending`. The backfill skips crawling and the OCR check, so it finishes in seconds.

### 3c. Reconcile with ingest

Either wait for the 3 AM run, or run ingest now:

```bash
sudo docker compose exec knowledge-ingest node dist/index.js; echo "exit=$?"
```

If the knowledge base hasn't changed since the last ingest, every document is `[SKIP] ... unchanged`. That costs no embeddings, and it marks each order `indexed` from the state file. If a crawl has written new files since, those are embedded as usual. Expect:

- `DB writes failed:` `0`, and `exit=0`
- no `[DB-MISS]` lines. A `[DB-MISS] georgia/executive-orders/<id>.md` means there's a Markdown file with no row. Check that the id is in the crawler's state file.

## 4. Check the data

As admin on `192.168.1.134`:

```bash
sudo docker exec -it govbot-postgres-db psql -U govbot_db_admin -d govbot
```

### Counts and status

```sql
-- after 3c: everything indexed, apart from any failed orders
SELECT qdrant_status, count(*) FROM executive_orders GROUP BY 1 ORDER BY 1;

-- total should match the state count; indexed should match the .md file count from 3a
SELECT count(*)                                         AS total,
       count(*) FILTER (WHERE qdrant_status = 'indexed') AS indexed,
       count(*) FILTER (WHERE raw_metadata->>'currentlyListed' = 'false') AS unlisted
FROM executive_orders;

-- anything not indexed, and why
SELECT eo_number, qdrant_status, qdrant_document_id, last_seen_at, raw_metadata
FROM executive_orders WHERE qdrant_status <> 'indexed' ORDER BY eo_number;
```

Rows stuck in `pending` mean ingest hasn't run since, or the order's `.md` file is missing. `failed` rows are retried on the next ingest run. Check that run's `[FAIL]` line for the cause.

### Metadata quality

```sql
-- latest orders: dates, governors and titles look right
SELECT eo_number, signing_date, issued_by, title
FROM executive_orders ORDER BY signing_date DESC NULLS LAST LIMIT 10;

-- orders whose id didn't parse into a date or governor (expect none)
SELECT eo_number, signing_date, issued_by FROM executive_orders
WHERE signing_date IS NULL OR issued_by IS NULL;

-- signing year disagrees with the listing page it came from (worth a look, not always wrong)
SELECT eo_number, signing_date, raw_metadata->>'year' AS listed_year FROM executive_orders
WHERE extract(year FROM signing_date)::int <> (raw_metadata->>'year')::int;

-- per-year and per-governor counts, compared with the governor's site
SELECT extract(year FROM signing_date)::int AS year, issued_by, count(*)
FROM executive_orders GROUP BY 1, 2 ORDER BY 1 DESC;

-- the inauguration-day boundary
SELECT eo_number, signing_date, issued_by, document_url FROM executive_orders
WHERE signing_date BETWEEN '2019-01-10' AND '2019-01-18' ORDER BY signing_date;

-- how the text was extracted
SELECT raw_metadata->>'textExtraction' AS extraction, count(*) FROM executive_orders GROUP BY 1;
```

`textExtraction` comes from each Markdown file's frontmatter, so it's only `NULL` for orders without a file. `extraction = 'none'` means the order is indexed with only its description.

### Qdrant columns

```sql
-- indexed rows point at their Markdown file (the `source` on every Qdrant chunk); expect 0
SELECT count(*) FROM executive_orders
WHERE qdrant_status = 'indexed'
  AND qdrant_document_id <> 'georgia/executive-orders/' || eo_number || '.md';

-- chunk counts: a 0 would mean an order is indexed with no vectors
SELECT min(qdrant_chunk_count), round(avg(qdrant_chunk_count), 1), max(qdrant_chunk_count),
       count(*) FILTER (WHERE qdrant_chunk_count = 0) AS zero_chunks
FROM executive_orders WHERE qdrant_status = 'indexed';

-- the reconcile wrote the original index time from ingest's state, not the time of this run
SELECT min(qdrant_indexed_at), max(qdrant_indexed_at), max(last_ingested_at)
FROM executive_orders WHERE qdrant_status = 'indexed';
```

### Run bookkeeping

The backfill doesn't write `ingest_runs` rows; only real crawls do. After the next 1 AM crawl:

```sql
SELECT id, source, started_at, finished_at, status, documents_seen, documents_inserted,
       documents_updated, documents_unchanged, documents_failed, error_message
FROM ingest_runs ORDER BY id DESC LIMIT 5;
```

Expect one `succeeded` row per night, with `documents_seen` equal to the number of orders on the current year's page. A `failed` row with `error_message = 'abandoned'` means the previous run was killed mid-crawl.

## 5. After the first nightly run

The next morning:

```bash
# on 192.168.1.132: no database errors from either job
cd /opt/knowledge-ingest
sudo docker compose logs --since 12h knowledge-crawler knowledge-ingest | grep -E 'DB-FAIL|DB-MISS|Database:'
```

```sql
-- on 192.168.1.134: the current year's orders were re-asserted last night...
SELECT max(last_seen_at), count(*) FILTER (WHERE last_seen_at > now() - interval '1 day') AS seen_today
FROM executive_orders;
-- ...and nothing slipped out of indexed
SELECT qdrant_status, count(*) FROM executive_orders GROUP BY 1;
```

Then finish plan verification steps 8–10:

- **Change detection:** delete one order's `.md` on the VM and run the crawler. That row goes `pending`. Run ingest and it returns to `indexed` with a fresh `qdrant_indexed_at`.
- **Fail-soft:** `sudo docker compose exec -e GOVBOT_DATABASE_URL=postgresql://x:y@192.168.1.250:5432/govbot knowledge-crawler node dist/index.js`. It should still crawl, log `[DB-FAIL] cannot reach ...`, and exit 1.
- **GovBot:** ask "how many executive orders were signed in 2025?" and confirm `searchExecutiveOrders` returns rows.

## Troubleshooting

- **`no pg_hba.conf entry for host "172.x..."`:** Docker isn't preserving the source IP on `.134`. See the `govbot-postgres-db/README.md` troubleshooting section.
- **`password authentication failed for user "govbot_ingest"`:** the knowledge-ingest `.env` and the database role use different passwords. Both come from `govbot-postgres-ingest-password`. Redeploy `govbot-postgres-db` (which re-runs `sync-roles.sh`) and then knowledge-ingest.
- **`Database: disabled`:** `GOVBOT_DATABASE_URL` didn't reach the container. Re-check step 2.
- **Rerunning the backfill** is safe: it's an UPSERT that never moves an `indexed` row back to `pending`.
