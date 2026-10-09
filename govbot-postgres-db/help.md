# Help

SSH into service:

```sh
sudo docker exec -it govbot-postgres-db psql -U govbot_app -d govbot
```

```sql
\d executive_orders
```

## 10 most recent orders

```sql
SELECT eo_number, title, signing_date
FROM executive_orders
ORDER BY signing_date DESC NULLS LAST
LIMIT 10;
```

## Case-insensitive text search

```sql
SELECT eo_number, title, signing_date
FROM executive_orders
WHERE title ILIKE '%emergency%'
ORDER BY signing_date;
```

## How complete is the metadata?

```sql
SELECT count(*)                                    AS total,
       count(*) FILTER (WHERE title IS NULL)        AS no_title,
       count(*) FILTER (WHERE signing_date IS NULL) AS no_signing_date,
       count(*) FILTER (WHERE issued_by IS NULL)    AS no_issuer
FROM executive_orders;
```

## Find out which keys exist

```sql
SELECT key, count(*)
FROM executive_orders, jsonb_object_keys(raw_metadata) AS key
GROUP BY key
ORDER BY count(*) DESC;
```

## Look at one row's metadata

```sql
SELECT eo_number, jsonb_pretty(raw_metadata)
FROM executive_orders
WHERE raw_metadata <> '{}'
LIMIT 1;
```

## Recent crawler runs

```sql
SELECT source, status, started_at,
       finished_at - started_at AS duration,
       documents_seen, documents_inserted, documents_updated, documents_failed
FROM ingest_runs
ORDER BY started_at DESC
LIMIT 10;
```
