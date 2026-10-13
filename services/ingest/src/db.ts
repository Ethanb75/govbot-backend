import pg from "pg";

import { ExecutiveOrderRef } from "./types.js";

// Ingest only moves executive_orders rows out of 'pending' (the crawler creates them and moves them
// back). Writes are fail-soft: each method logs [DB-FAIL] and counts the failure instead of
// throwing, so Postgres never holds up Qdrant. Every run re-asserts every order, so a missed
// write is corrected next run.
export interface IngestDb {
    markIndexed: (
        ref: ExecutiveOrderRef,
        indexed: { documentId: string; chunkCount: number; indexedAt: string },
    ) => Promise<void>;
    markFailed: (ref: ExecutiveOrderRef) => Promise<void>;
    // The document's file and vectors are gone, so it is matched on the stored document id.
    markRemoved: (documentId: string) => Promise<void>;
    failures: () => number;
    end: () => Promise<void>;
}

const refLabel = ({ jurisdiction, eoNumber }: ExecutiveOrderRef): string => `${jurisdiction} ${eoNumber}`;

// Only the host and database, never the password.
export const describeDatabaseUrl = (url: string): string => {
    try {
        const { host, pathname } = new URL(url);
        return `${host}${pathname}`;
    } catch {
        return "(unparseable GOVBOT_DATABASE_URL)";
    }
};

// undefined when GOVBOT_DATABASE_URL is unset (local dev) or the database is unreachable. Ingest
// carries on either way; an unreachable database fails the run.
export const connectDb = async (): Promise<IngestDb | undefined> => {
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
        console.error(`[DB-FAIL] cannot reach ${describeDatabaseUrl(url)}, ingesting without the database - ${error}`);
        process.exitCode = 1;
        await pool.end().catch(() => undefined);
        return undefined;
    }

    let failures = 0;

    const attempt = async (label: string, write: () => Promise<unknown>): Promise<void> => {
        try {
            await write();
        } catch (error) {
            console.error(`[DB-FAIL] ${label} - ${error}`);
            failures++;
        }
    };

    return {
        markIndexed: (ref, { documentId, chunkCount, indexedAt }) =>
            attempt(refLabel(ref), async () => {
                const { rowCount } = await pool.query(
                    `UPDATE executive_orders SET
                        qdrant_status = 'indexed', qdrant_document_id = $3, qdrant_chunk_count = $4,
                        qdrant_indexed_at = $5, last_ingested_at = $5
                     WHERE jurisdiction = $1 AND eo_number = $2`,
                    [ref.jurisdiction, ref.eoNumber, documentId, chunkCount, indexedAt],
                );
                // The crawler hasn't written the row yet; it will next run, and the ingest run
                // after that reconciles it.
                if (rowCount === 0) console.warn(`[DB-MISS] ${documentId} - no executive_orders row yet`);
            }),

        markFailed: ref =>
            attempt(refLabel(ref), () =>
                pool.query(
                    `UPDATE executive_orders SET qdrant_status = 'failed'
                     WHERE jurisdiction = $1 AND eo_number = $2`,
                    [ref.jurisdiction, ref.eoNumber],
                ),
            ),

        markRemoved: documentId =>
            attempt(documentId, () =>
                pool.query(
                    `UPDATE executive_orders SET qdrant_status = 'pending' WHERE qdrant_document_id = $1`,
                    [documentId],
                ),
            ),

        failures: () => failures,

        // idle pool clients would otherwise keep the process alive
        end: () => pool.end(),
    };
};
