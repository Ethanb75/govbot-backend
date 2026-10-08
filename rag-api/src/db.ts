import pg from "pg";
import { config } from "./config.js";

export const dbEnabled = (): boolean => !!config.GOVBOT_DATABASE_URL;

let pool: pg.Pool | undefined;

// Built on first use, so the service starts (and the evals run) without a database
export const getPool = (): pg.Pool => {
    if (!pool) {
        pool = new pg.Pool({
            connectionString: config.GOVBOT_DATABASE_URL,
            max: 5,
            statement_timeout: 5000,
            connectionTimeoutMillis: 3000,
        });
        // an idle client losing its connection would otherwise crash the process
        pool.on("error", err => console.error("postgres pool error: ", err));
    }
    return pool;
};
