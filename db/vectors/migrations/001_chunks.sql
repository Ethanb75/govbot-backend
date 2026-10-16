-- GovBot's search index: one row per knowledge base document and one per chunk with its
-- embedding. Replaces the Qdrant `knowledge` collection and ingest's app-state/state.json. Runs as
-- the database's admin user inside a single transaction (see db/scripts/migrate.sh), after
-- scripts/sync-roles.sh has created the roles granted to below.

CREATE EXTENSION IF NOT EXISTS vector;

-- What ingest last indexed for each Markdown file. source is the file's key relative to the
-- knowledge base root (e.g. 'georgia/executive-orders/01.05.24.01.md'), the same value the
-- metadata database stores as executive_orders.qdrant_document_id.
CREATE TABLE documents (
    source           text PRIMARY KEY,
    content_hash     text NOT NULL,
    last_indexed_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE chunks (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- re-indexing or removing a document replaces all of its chunks
    source     text NOT NULL REFERENCES documents (source) ON DELETE CASCADE,
    -- headline, summary and original text, as embedded
    content    text NOT NULL,
    -- source, type and contentHash, as the rag-api returns them
    metadata   jsonb NOT NULL DEFAULT '{}'::jsonb,
    -- halfvec because pgvector can't HNSW-index a plain vector over 2000 dimensions. Must match
    -- EMBEDDING_DIMENSIONS (packages/shared): changing either needs a new migration and a re-ingest.
    embedding  halfvec(3072) NOT NULL
);

CREATE INDEX chunks_source_idx ON chunks (source);
CREATE INDEX chunks_embedding_idx ON chunks USING hnsw (embedding halfvec_cosine_ops);

-- Only the GovBot roles may connect; the admin user owns everything and needs no grants. The
-- database name differs between RDS and local dev, so it's looked up rather than hardcoded.
DO $$
BEGIN
    EXECUTE format('REVOKE ALL ON DATABASE %I FROM PUBLIC', current_database());
    EXECUTE format('GRANT CONNECT ON DATABASE %I TO vectors_ingest, vectors_app', current_database());
END
$$;
GRANT USAGE ON SCHEMA public TO vectors_ingest, vectors_app;

-- ingest replaces and removes documents; the API only searches
GRANT SELECT, INSERT, UPDATE, DELETE ON documents, chunks TO vectors_ingest;
GRANT SELECT ON documents, chunks TO vectors_app;

-- tables created by later migrations get the same access automatically
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO vectors_ingest;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT SELECT ON TABLES TO vectors_app;
