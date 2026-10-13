-- GovBot executive order metadata and ingest bookkeeping. PostgreSQL is the source of truth for
-- what has been discovered, ingested and indexed; Qdrant (vector-db) only holds chunks and
-- embeddings. Runs as govbot_db_admin inside a single transaction (see scripts/migrate.sh), after
-- scripts/sync-roles.sh has created the roles granted to below.

CREATE TABLE executive_orders (
    id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    -- crawler source name (e.g. 'ga-executive-orders') and that source's own id for the order
    source              text NOT NULL,
    source_document_id  text NOT NULL,

    jurisdiction        text NOT NULL,
    eo_number           text NOT NULL,
    title               text,
    issued_by           text,
    signing_date        date,
    publication_date    date,
    -- listing page the order was found on, and the order document itself (e.g. its PDF)
    source_url          text,
    document_url        text,

    content_hash        text,

    qdrant_document_id  text,
    qdrant_status       text NOT NULL DEFAULT 'pending'
                        CHECK (qdrant_status IN ('pending', 'indexed', 'failed')),
    qdrant_chunk_count  integer CHECK (qdrant_chunk_count >= 0),
    qdrant_indexed_at   timestamptz,

    first_seen_at       timestamptz NOT NULL DEFAULT now(),
    last_seen_at        timestamptz NOT NULL DEFAULT now(),
    last_ingested_at    timestamptz,

    -- source fields that don't have a column (yet)
    raw_metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,

    UNIQUE (source, source_document_id),
    -- order numbers are only unique within a jurisdiction - Georgia's 01.02.25.01 style ids
    -- could collide with another state's
    UNIQUE (jurisdiction, eo_number),

    -- corpus stats only count indexed rows, so an indexed row must say when and how much
    CHECK (qdrant_status <> 'indexed' OR (qdrant_indexed_at IS NOT NULL AND qdrant_chunk_count IS NOT NULL))
);

CREATE TABLE ingest_runs (
    id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    source               text NOT NULL,
    started_at           timestamptz NOT NULL DEFAULT now(),
    finished_at          timestamptz,
    status               text NOT NULL DEFAULT 'running'
                         CHECK (status IN ('running', 'succeeded', 'failed')),

    documents_seen       integer NOT NULL DEFAULT 0,
    documents_inserted   integer NOT NULL DEFAULT 0,
    documents_updated    integer NOT NULL DEFAULT 0,
    documents_unchanged  integer NOT NULL DEFAULT 0,
    documents_failed     integer NOT NULL DEFAULT 0,

    error_message        text,

    CHECK ((status = 'running') = (finished_at IS NULL))
);

-- Only the GovBot roles may connect; govbot_db_admin owns everything and needs no grants.
REVOKE ALL ON DATABASE govbot FROM PUBLIC;
GRANT CONNECT ON DATABASE govbot TO govbot_ingest, govbot_app;
GRANT USAGE ON SCHEMA public TO govbot_ingest, govbot_app;

-- no DELETE for the crawler: orders that drop off a source are flagged, never removed
GRANT SELECT, INSERT, UPDATE ON executive_orders, ingest_runs TO govbot_ingest;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO govbot_ingest;
GRANT SELECT ON executive_orders, ingest_runs TO govbot_app;

-- tables, views and sequences created by later migrations get the same access automatically
ALTER DEFAULT PRIVILEGES FOR ROLE govbot_db_admin IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE ON TABLES TO govbot_ingest;
ALTER DEFAULT PRIVILEGES FOR ROLE govbot_db_admin IN SCHEMA public
    GRANT USAGE ON SEQUENCES TO govbot_ingest;
ALTER DEFAULT PRIVILEGES FOR ROLE govbot_db_admin IN SCHEMA public
    GRANT SELECT ON TABLES TO govbot_app;
