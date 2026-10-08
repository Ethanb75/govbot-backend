import pg from "pg";

import { CrawlResult, ExecutiveOrderRecord } from "./types.js";

// Writes are fail-soft: each method logs [DB-FAIL] and counts the failure instead of throwing, so
// Postgres never holds up the Markdown. Every run re-asserts the full picture, so a missed write is
// corrected next run; index.ts exits 1 when failures() is non-zero.
export interface CrawlerDb {
    upsertExecutiveOrder: (record: ExecutiveOrderRecord) => Promise<void>;
    // Flags orders that dropped off a source's listing. Rows are never deleted.
    markUnlisted: (source: string, ids: string[]) => Promise<void>;
    startRun: (source: string) => Promise<number | undefined>;
    finishRun: (runId: number | undefined, outcome: { result: CrawlResult } | { error: unknown }) => Promise<void>;
    failures: () => number;
    end: () => Promise<void>;
}

const UPSERT_EXECUTIVE_ORDER = `
    INSERT INTO executive_orders
        (source, source_document_id, jurisdiction, eo_number, title, issued_by, signing_date,
         source_url, document_url, content_hash, raw_metadata, last_seen_at, qdrant_status)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, 'pending')
    ON CONFLICT (source, source_document_id) DO UPDATE SET
        title         = EXCLUDED.title,
        issued_by     = EXCLUDED.issued_by,
        signing_date  = EXCLUDED.signing_date,
        source_url    = EXCLUDED.source_url,
        document_url  = EXCLUDED.document_url,
        content_hash  = COALESCE(EXCLUDED.content_hash, executive_orders.content_hash),
        raw_metadata  = executive_orders.raw_metadata || EXCLUDED.raw_metadata,
        last_seen_at  = EXCLUDED.last_seen_at,
        qdrant_status = CASE WHEN $13::boolean THEN 'pending' ELSE executive_orders.qdrant_status END`;

// Safe because supercronic never overlaps runs: a 'running' row at start-up belongs to a killed run.
const CLOSE_ABANDONED_RUNS = `
    UPDATE ingest_runs SET status = 'failed', finished_at = now(), error_message = 'abandoned'
    WHERE source = $1 AND status = 'running'`;

// Only the host and database, never the password.
export const describeDatabaseUrl = (url: string): string => {
    try {
        const { host, pathname } = new URL(url);
        return `${host}${pathname}`;
    } catch {
        return "(unparseable GOVBOT_DATABASE_URL)";
    }
};

// undefined when GOVBOT_DATABASE_URL is unset (local dev) or the database is unreachable. The
// crawl carries on either way; an unreachable database fails the run.
export const connectDb = async (): Promise<CrawlerDb | undefined> => {
    const url = process.env.GOVBOT_DATABASE_URL;
    if (!url) return undefined;

    const pool = new pg.Pool({
        connectionString: url,
        max: 2,
        statement_timeout: 10_000,
        connectionTimeoutMillis: 5_000,
    });
    // an idle client losing its connection would otherwise crash the process
    pool.on("error", error => console.error(`[DB-FAIL] pool - ${error}`));

    try {
        await pool.query("SELECT 1");
    } catch (error) {
        console.error(`[DB-FAIL] cannot reach ${describeDatabaseUrl(url)}, crawling without the database - ${error}`);
        process.exitCode = 1;
        await pool.end().catch(() => undefined);
        return undefined;
    }

    let failures = 0;

    const attempt = async <T>(label: string, write: () => Promise<T>): Promise<T | undefined> => {
        try {
            return await write();
        } catch (error) {
            console.error(`[DB-FAIL] ${label} - ${error}`);
            failures++;
            return undefined;
        }
    };

    return {
        upsertExecutiveOrder: async record => {
            await attempt(record.sourceDocumentId, () =>
                pool.query(UPSERT_EXECUTIVE_ORDER, [
                    record.source,
                    record.sourceDocumentId,
                    record.jurisdiction,
                    record.eoNumber,
                    record.title,
                    record.issuedBy,
                    record.signingDate,
                    record.sourceUrl,
                    record.documentUrl,
                    record.contentHash,
                    JSON.stringify(record.rawMetadata),
                    record.lastSeenAt,
                    record.markdownRewritten,
                ]),
            );
        },

        markUnlisted: async (source, ids) => {
            if (ids.length === 0) return;

            await attempt(`${source} unlisted`, () =>
                pool.query(
                    `UPDATE executive_orders SET raw_metadata = raw_metadata || '{"currentlyListed": false}'::jsonb
                     WHERE source = $1 AND source_document_id = ANY($2)`,
                    [source, ids],
                ),
            );
        },

        startRun: source =>
            attempt(`${source} run start`, async () => {
                await pool.query(CLOSE_ABANDONED_RUNS, [source]);
                const { rows } = await pool.query<{ id: string }>(
                    "INSERT INTO ingest_runs (source) VALUES ($1) RETURNING id",
                    [source],
                );
                // bigint comes back as a string
                return Number(rows[0].id);
            }),

        finishRun: async (runId, outcome) => {
            if (runId === undefined) return;

            const result = "result" in outcome ? outcome.result : undefined;
            const errorMessage = "error" in outcome ? String(outcome.error) : null;

            await attempt(`run ${runId} finish`, () =>
                pool.query(
                    `UPDATE ingest_runs SET
                        finished_at = now(), status = $2, documents_seen = $3, documents_inserted = $4,
                        documents_updated = $5, documents_unchanged = $6, documents_failed = $7,
                        error_message = $8
                     WHERE id = $1`,
                    [
                        runId,
                        result ? "succeeded" : "failed",
                        result?.discovered ?? 0,
                        result?.created.length ?? 0,
                        result?.updated.length ?? 0,
                        result?.unchanged.length ?? 0,
                        result?.failed.length ?? 0,
                        errorMessage,
                    ],
                ),
            );
        },

        failures: () => failures,

        // idle pool clients would otherwise keep the process alive
        end: () => pool.end(),
    };
};
