import type { CrawlerDb } from "./db.js";

export interface CrawlContext {
    knowledgeBasePath: string;
    statePath: string;
    // Year to crawl for sources organised by year; defaults to the current year.
    year: number;
    // Fires when the whole crawl hits its hard timeout.
    signal: AbortSignal;
    // govbot-postgres-db, when GOVBOT_DATABASE_URL is set and reachable. Sources that don't
    // produce executive orders ignore it.
    db?: CrawlerDb;
}

export interface CrawlResult {
    discovered: number;
    created: string[];
    updated: string[];
    unchanged: string[];
    failed: string[];
}

export interface Source {
    name: string;
    crawl: (context: CrawlContext) => Promise<CrawlResult>;
    // `--backfill-db`: UPSERT every order already in the state file without crawling, so orders
    // from years the nightly run no longer visits reach the database. Returns the rows written.
    backfill?: (context: CrawlContext & { db: CrawlerDb }) => Promise<number>;
}

// One row of govbot-postgres-db's executive_orders table, as the crawler sees it.
export interface ExecutiveOrderRecord {
    source: string;
    sourceDocumentId: string;
    jurisdiction: string;
    eoNumber: string;
    title: string | null;
    issuedBy: string | null;
    // YYYY-MM-DD
    signingDate: string | null;
    sourceUrl: string;
    documentUrl: string;
    // null keeps the stored hash (e.g. a failed download)
    contentHash: string | null;
    // merged into the stored value, so keys left out keep their previous value
    rawMetadata: Record<string, unknown>;
    lastSeenAt: string;
    // true moves the row back to qdrant_status 'pending' for ingest to pick up
    markdownRewritten: boolean;
}
