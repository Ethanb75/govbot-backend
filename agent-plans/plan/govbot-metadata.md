Yes. I’d make PostgreSQL the **structured source of truth for EO metadata and ingest state**, while Qdrant remains the search/index layer.

Your current Jenkins setup already has the right basic pattern: each deployable service has its own inventory, playbook, address/port, and root folder; Jenkins detects changed service folders, runs the corresponding Ansible deployment, and performs a health check. [GitHub](https://raw.githubusercontent.com/Ethanb75/homelab/main/Jenkinsfile) We can extend that pattern for `govbot-postgres-db`, with two small improvements for a database service.

## Target architecture

```text
                         GOVBOT DATA PIPELINE

                  Federal Register / source
                            │
                            ▼
                    crawl / ingest job
                            │
                  normalize EO metadata
                            │
              ┌─────────────┴─────────────┐
              │                           │
              ▼                           ▼
    govbot-postgres-db                  Qdrant
      PostgreSQL 18                     vectors
              │                           │
      authoritative metadata       searchable chunks
              │                           │
      EO # / dates / title          embeddings
      ingest status                 chunk text
      content hash                  payload
      chunk count
              │
              └─────────────┬─────────────┘
                            ▼
                         GovBot API
                            │
              ┌─────────────┴─────────────┐
              ▼                           ▼
        SQL corpus stats              vector RAG
              │                           │
              └─────────────┬─────────────┘
                            ▼
                           LLM
```

I would use **PostgreSQL 18.6**, not PostgreSQL 19 yet. PostgreSQL 18 is the current supported major release as of October 6, 2026; 19 is still beta. [PostgreSQL](https://www.postgresql.org/docs/release/?utm_source=chatgpt.com) The official Docker image currently provides `postgres:18.6` and `postgres:18.6-bookworm`. [Docker Hub](https://hub.docker.com/_/postgres?utm_source=chatgpt.com) I’d use the Debian-based `postgres:18.6-bookworm` rather than Alpine—it is slightly larger but easier to debug and extend later.

A likely repo layout would become:

```text
homelab/
│
├── terraform/
│   └── govbot-postgres-db.tf
│
├── ansible/
│   ├── inventory/
│   │   └── govbot-postgres-db.ini
│   │
│   └── playbooks/
│       └── deploy-govbot-postgres-db.yml
│
├── govbot-postgres-db/
│   ├── compose.yaml
│   ├── migrations/
│   │   └── 001_initial_schema.sql
│   └── README.md
│
└── Jenkinsfile
```

### Implementation plan

1. **Provision a dedicated `govbot-postgres-db` VM with Terraform.** I’d keep the database separate from the GovBot application VM so its lifecycle and storage are independent. Something around 2 vCPU, 2 GB RAM, and 32–64 GB disk is plenty to start for EO metadata. Give it a reserved/static LAN address and put it in your existing `ci-cd` Proxmox pool. Terraform should create the VM exactly like your other service VMs, while Ansible owns everything inside it. Because this VM becomes stateful, we should also treat accidental destruction differently from disposable web services: once established, add protection against accidental Terraform destruction and establish database backups before relying on it.

2. **Deploy PostgreSQL through Docker Compose.** The Compose service would be named `govbot-postgres-db`, run `postgres:18.6-bookworm`, have `restart: unless-stopped`, a persistent data volume, and a native `pg_isready` health check. PostgreSQL 18 changed the official image's volume layout, so the persistent mount should target `/var/lib/postgresql`, not the old `/var/lib/postgresql/data` pattern used by PostgreSQL 17 and earlier. [Docker Hub](https://hub.docker.com/_/postgres?utm_source=chatgpt.com) Conceptually:

```yaml
services:
  postgres:
    image: postgres:18.6-bookworm
    container_name: govbot-postgres-db
    restart: unless-stopped

    environment:
      POSTGRES_DB: govbot
      POSTGRES_USER: govbot_db_admin
      POSTGRES_PASSWORD: ${POSTGRES_ADMIN_PASSWORD}

    ports:
      - "5432:5432"

    volumes:
      - govbot_postgres_data:/var/lib/postgresql

    healthcheck:
      test:
        ["CMD-SHELL", "pg_isready -U govbot_db_admin -d govbot"]
      interval: 10s
      timeout: 5s
      retries: 5

volumes:
  govbot_postgres_data:
```

The actual Compose file should not contain the password. Ansible should render a root-readable `.env` on the database VM from Jenkins credentials.

3. **Create three PostgreSQL roles, rather than giving every GovBot component the database admin account.** The initialization/migration account would be `govbot_db_admin`; the crawler would connect as `govbot_ingest` with `SELECT/INSERT/UPDATE`; and the normal GovBot API would eventually connect as `govbot_app` with read-only `SELECT`. None of their passwords should live in Git. This also lets us firewall 5432 so it is reachable only from the GovBot and ingest hosts rather than the entire LAN.

4. **Create an intentionally small initial schema.** I would start with two tables rather than trying to model everything on day one:

```sql
executive_orders
────────────────────────────────────
id
source
source_document_id
eo_number
title
president
signing_date
publication_date
source_url

content_hash

qdrant_document_id
qdrant_status
qdrant_chunk_count
qdrant_indexed_at

first_seen_at
last_seen_at
last_ingested_at

raw_metadata JSONB
```

and:

```sql
ingest_runs
────────────────────────────────────
id
source
started_at
finished_at
status

documents_seen
documents_inserted
documents_updated
documents_unchanged
documents_failed

error_message
```

I would make `(source, source_document_id)` unique and probably make `eo_number` unique as well for EO records. `raw_metadata JSONB` gives you somewhere to preserve source fields without immediately adding a column for every Federal Register attribute.

5. **Make ingestion idempotent with PostgreSQL UPSERTs.** Each crawl starts an `ingest_runs` record. When a document is encountered, calculate a deterministic content hash and execute essentially:

```sql
INSERT INTO executive_orders (...)
VALUES (...)
ON CONFLICT (source, source_document_id)
DO UPDATE SET
    title            = EXCLUDED.title,
    signing_date     = EXCLUDED.signing_date,
    publication_date = EXCLUDED.publication_date,
    source_url       = EXCLUDED.source_url,
    last_seen_at     = now(),
    raw_metadata     = EXCLUDED.raw_metadata;
```

Then compare `content_hash`. If the document hasn't changed and its existing Qdrant status is `indexed`, you can skip re-embedding it. If it's new or changed, mark it `pending`, perform the Qdrant chunk/embed/upsert, and update the SQL row to `indexed` only after Qdrant succeeds.

```text
crawl EO
   │
   ▼
normalize
   │
   ▼
UPSERT PostgreSQL
   │
   ├── unchanged + indexed
   │        └── skip embedding
   │
   └── new / changed
            │
            ▼
       status=pending
            │
            ▼
      chunk + embed
            │
            ▼
          Qdrant
            │
       ┌────┴────┐
       │         │
    success    failure
       │         │
       ▼         ▼
    indexed     failed
       │         │
       └────┬────┘
            ▼
      update PostgreSQL
```

This is better than writing Qdrant and PostgreSQL independently. There isn't a distributed transaction spanning both databases, so PostgreSQL gives us an explicit record of incomplete work. A failed Qdrant request leaves an EO with `qdrant_status='failed'` that the next ingest can retry.

6. **Define corpus statistics in terms of successfully indexed rows.** This matters for the feature that started this work. GovBot should not claim an EO is available merely because the crawler discovered it. The authoritative count should be roughly:

```sql
SELECT
    COUNT(*) AS executive_order_count,
    MIN(signing_date) AS earliest_signing_date,
    MAX(signing_date) AS latest_signing_date,
    MAX(last_ingested_at) AS last_ingested_at
FROM executive_orders
WHERE qdrant_status = 'indexed';
```

Year counts become ordinary SQL:

```sql
SELECT
    EXTRACT(YEAR FROM signing_date) AS year,
    COUNT(*) AS executive_order_count
FROM executive_orders
WHERE qdrant_status = 'indexed'
GROUP BY year
ORDER BY year;
```

Later we can put these behind a SQL view such as `govbot_corpus_stats`, or have the GovBot API cache the results for a minute or more. That means the prompt gets trustworthy structured facts while Qdrant handles semantic retrieval.

7. **IGNORE healthcheck** no healthcheck line for now. create next step to add healthcheck to cicd workflow
8. **Finish with backups and acceptance tests before connecting the crawler.** At minimum, establish a nightly `pg_dump` of `govbot` to durable storage plus whatever VM-level backup strategy you're using. Then verify a full restore at least once. The acceptance test for Phase 1 should be: Terraform creates the VM; Jenkins/Ansible deploy PostgreSQL; `pg_isready` succeeds; the three database roles exist; the schema exists; a test EO can be inserted with `govbot_ingest`; `govbot_app` can read it but cannot modify it; and redeploying the Docker container does not lose the record.

### The important boundary

I'd keep the division of responsibilities very explicit:

```text
PostgreSQL
    authoritative structured metadata
    ingest history
    indexing status
    corpus statistics

Qdrant
    EO chunks
    embeddings
    semantic retrieval

crawl/ingest service
    coordinates writes to both

GovBot API
    reads Postgres stats
    searches Qdrant
    constructs LLM context
```

I would **not store the entire EO text twice initially**. Keep full/chunk text where your current ingest architecture already expects it, and put the structured metadata plus cross-system identifiers in Postgres. `content_hash`, `qdrant_document_id`, `qdrant_chunk_count`, and `qdrant_status` give us enough linkage to reconcile the two stores later.

The best build order from here is **database VM → PostgreSQL Compose → roles/schema → Jenkins deployment/health check → backups → modify crawl/ingest to perform UPSERTs → derive corpus stats from indexed rows**. That gets the stateful infrastructure solid before we change the working crawl/Qdrant pipeline.

After finishing implementation, add all next steps into a newly created file in agent-plans/next folder