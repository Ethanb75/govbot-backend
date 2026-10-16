import pg from "pg";
import { ChunkResult } from "./types.js";

export type IndexedDocument = {
    contentHash: string;
    lastIndexedAt: string;
    chunkCount: number;
};

// The vectors database (db/vectors): `documents` records what was last indexed for each file,
// and `chunks` holds its embedded chunks. A document's chunks are only ever replaced or removed
// as a whole, inside one transaction, so a failed or killed run leaves the previous version
// searchable and the next run simply retries it.
export interface VectorStore {
    indexedDocuments: () => Promise<Map<string, IndexedDocument>>;
    replaceDocument: (
        source: string,
        contentHash: string,
        chunks: ChunkResult[],
        embeddings: number[][],
    ) => Promise<{ chunkCount: number; indexedAt: string }>;
    // returns the number of chunks removed with it
    removeDocument: (source: string) => Promise<number>;
    countChunks: () => Promise<number>;
    end: () => Promise<void>;
}

// pgvector's text format, cast to halfvec in SQL
const toVectorLiteral = (embedding: number[]): string => `[${embedding.join(",")}]`;

export const connectVectors = async (url: string): Promise<VectorStore> => {
    const pool = new pg.Pool({
        connectionString: url,
        max: 2,
        // a large document's chunk insert carries a few MB of vectors
        statement_timeout: 60_000,
        connectionTimeoutMillis: 5_000,
    });
    // an idle client losing its connection would otherwise crash the process
    pool.on("error", error => console.error(`[VECTORS] pool - ${error}`));

    // unlike the metadata database, ingest can't do anything useful without this one
    await pool.query("SELECT 1 FROM documents LIMIT 1");

    const transaction = async <T>(work: (client: pg.PoolClient) => Promise<T>): Promise<T> => {
        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            const result = await work(client);
            await client.query("COMMIT");
            return result;
        } catch (error) {
            await client.query("ROLLBACK").catch(() => undefined);
            throw error;
        } finally {
            client.release();
        }
    };

    return {
        indexedDocuments: async () => {
            const { rows } = await pool.query<{
                source: string;
                content_hash: string;
                last_indexed_at: Date;
                chunk_count: number;
            }>(
                `SELECT d.source, d.content_hash, d.last_indexed_at, count(c.id)::int AS chunk_count
                 FROM documents d LEFT JOIN chunks c USING (source)
                 GROUP BY d.source`,
            );

            return new Map(
                rows.map(row => [
                    row.source,
                    {
                        contentHash: row.content_hash,
                        lastIndexedAt: row.last_indexed_at.toISOString(),
                        chunkCount: row.chunk_count,
                    },
                ]),
            );
        },

        replaceDocument: (source, contentHash, chunks, embeddings) =>
            transaction(async client => {
                const { rows } = await client.query<{ last_indexed_at: Date }>(
                    `INSERT INTO documents (source, content_hash, last_indexed_at) VALUES ($1, $2, now())
                     ON CONFLICT (source) DO UPDATE SET content_hash = EXCLUDED.content_hash, last_indexed_at = now()
                     RETURNING last_indexed_at`,
                    [source, contentHash],
                );
                await client.query("DELETE FROM chunks WHERE source = $1", [source]);

                if (chunks.length > 0) {
                    const values: unknown[] = [source];
                    const tuples = chunks.map((chunk, i) => {
                        values.push(chunk.pageContent, JSON.stringify(chunk.metadata), toVectorLiteral(embeddings[i]));
                        const n = values.length;
                        return `($1, $${n - 2}, $${n - 1}::jsonb, $${n}::halfvec)`;
                    });
                    await client.query(
                        `INSERT INTO chunks (source, content, metadata, embedding) VALUES ${tuples.join(", ")}`,
                        values,
                    );
                }

                return { chunkCount: chunks.length, indexedAt: rows[0].last_indexed_at.toISOString() };
            }),

        // chunks first only to count them; the cascade from documents would remove them anyway
        removeDocument: source =>
            transaction(async client => {
                const { rowCount } = await client.query("DELETE FROM chunks WHERE source = $1", [source]);
                await client.query("DELETE FROM documents WHERE source = $1", [source]);
                return rowCount ?? 0;
            }),

        countChunks: async () => {
            const { rows } = await pool.query<{ count: number }>("SELECT count(*)::int AS count FROM chunks");
            return rows[0].count;
        },

        // idle pool clients would otherwise keep the process alive
        end: () => pool.end(),
    };
};
