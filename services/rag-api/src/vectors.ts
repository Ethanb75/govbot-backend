import pg from "pg";
import { config } from "./config.js";

let pool: pg.Pool | undefined;

// The vectors database (db/vectors) that ingest writes chunks and embeddings into. Built on first
// use, like the metadata pool in db.ts
export const getVectorsPool = (): pg.Pool => {
    if (!pool) {
        pool = new pg.Pool({
            connectionString: config.VECTORS_DATABASE_URL,
            max: 5,
            statement_timeout: 5000,
            connectionTimeoutMillis: 3000,
            // lets the eval scripts exit once they're done; the server stays up because it's listening
            allowExitOnIdle: true,
        });
        // an idle client losing its connection would otherwise crash the process
        pool.on("error", err => console.error("vectors pool error: ", err));
    }
    return pool;
};

// Readiness: the database answers and ingest's migration has been applied
export const chunksTableExists = async (): Promise<boolean> => {
    const { rows } = await getVectorsPool().query<{ exists: boolean }>(
        "SELECT to_regclass('public.chunks') IS NOT NULL AS exists",
    );
    return rows[0].exists;
};
