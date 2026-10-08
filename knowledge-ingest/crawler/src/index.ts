import "dotenv/config";
import { accessSync, constants, existsSync, mkdirSync } from "node:fs";
import { parseArgs } from "node:util";

import { connectDb, CrawlerDb, describeDatabaseUrl } from "./db.js";
import { checkOcrTools } from "./pdf.js";
import { gaExecutiveOrders } from "./sources/ga-executive-orders.js";
import { Source } from "./types.js";

const KNOWLEDGE_BASE_PATH = process.env.KNOWLEDGE_BASE_PATH ?? "../knowledge-base";
const CRAWLER_STATE_PATH = process.env.CRAWLER_STATE_PATH ?? "../crawler-state";

// Hard stop so a hanging government site can't keep the crawl running into the 3 AM ingest.
const CRAWL_TIMEOUT_MINUTES = Number(process.env.CRAWL_TIMEOUT_MINUTES ?? 30);

const SOURCES: Source[] = [gaExecutiveOrders];

const summaryRow = (label: string, value: number | string): string =>
    `${`${label}:`.padEnd(22)}${String(value).padStart(6)}`;

// `npm run crawl -- --year 2025` backfills a past year; the cron job crawls the current year.
// `npm run crawl -- --backfill-db` writes every order already in state to the database, no crawling.
const parseCliArgs = (): { year: number; backfillDb: boolean } => {
    const { values } = parseArgs({
        options: { year: { type: "string" }, "backfill-db": { type: "boolean", default: false } },
    });
    const backfillDb = values["backfill-db"] ?? false;
    if (values.year === undefined) return { year: new Date().getFullYear(), backfillDb };

    const year = Number(values.year);
    if (!Number.isInteger(year) || year < 1900) {
        throw new Error(`invalid --year ${values.year}`);
    }
    return { year, backfillDb };
};

const healthCheck = async (backfillDb: boolean): Promise<CrawlerDb | undefined> => {
    if (!existsSync(KNOWLEDGE_BASE_PATH)) {
        throw new Error(`knowledge base not found at ${KNOWLEDGE_BASE_PATH}`);
    }
    accessSync(KNOWLEDGE_BASE_PATH, constants.W_OK);

    mkdirSync(CRAWLER_STATE_PATH, { recursive: true });
    accessSync(CRAWLER_STATE_PATH, constants.W_OK);

    // a backfill only reads state, so it never OCRs anything
    if (!backfillDb) await checkOcrTools();

    return connectDb();
};

const crawlSources = async (year: number, db: CrawlerDb | undefined): Promise<string[]> => {
    const signal = AbortSignal.timeout(CRAWL_TIMEOUT_MINUTES * 60_000);
    const failedSources: string[] = [];

    for (const source of SOURCES) {
        console.log(`[crawler] ${source.name}`);
        const runId = await db?.startRun(source.name);

        try {
            const result = await source.crawl({
                knowledgeBasePath: KNOWLEDGE_BASE_PATH,
                statePath: CRAWLER_STATE_PATH,
                year,
                signal,
                db,
            });
            await db?.finishRun(runId, { result });

            console.log("");
            console.log(summaryRow("Orders discovered", result.discovered));
            console.log(summaryRow("New", result.created.length));
            console.log(summaryRow("Changed", result.updated.length));
            console.log(summaryRow("Unchanged", result.unchanged.length));
            console.log(summaryRow("Failed", result.failed.length));
            console.log("");

            if (result.failed.length > 0) {
                console.error(`failed documents:\n  ${result.failed.join("\n  ")}\n`);
                failedSources.push(source.name);
            }
        } catch (error) {
            console.error(`[FAIL] ${source.name} - ${error}\n`);
            await db?.finishRun(runId, { error });
            failedSources.push(source.name);
        }
    }

    return failedSources;
};

const backfillSources = async (year: number, db: CrawlerDb): Promise<void> => {
    for (const source of SOURCES) {
        if (!source.backfill) continue;

        const written = await source.backfill({
            knowledgeBasePath: KNOWLEDGE_BASE_PATH,
            statePath: CRAWLER_STATE_PATH,
            year,
            signal: AbortSignal.timeout(CRAWL_TIMEOUT_MINUTES * 60_000),
            db,
        });
        console.log(`[backfill] ${source.name} - ${written} orders`);
    }
};

const main = async (): Promise<void> => {
    const startedAt = performance.now();
    const { year, backfillDb } = parseCliArgs();
    const databaseUrl = process.env.GOVBOT_DATABASE_URL;

    console.log(backfillDb ? "Knowledge crawl started (database backfill only)" : "Knowledge crawl started");
    console.log(`Knowledge base: ${KNOWLEDGE_BASE_PATH}`);
    console.log(`State:          ${CRAWLER_STATE_PATH}`);
    console.log(`Database:       ${databaseUrl ? describeDatabaseUrl(databaseUrl) : "disabled (GOVBOT_DATABASE_URL not set)"}`);
    console.log(`Year:           ${year}\n`);

    const db = await healthCheck(backfillDb);

    try {
        if (backfillDb) {
            if (!db) throw new Error("--backfill-db needs a reachable GOVBOT_DATABASE_URL");
            await backfillSources(year, db);
        } else {
            const failedSources = await crawlSources(year, db);
            if (failedSources.length > 0) process.exitCode = 1;
        }
    } finally {
        const dbFailures = db?.failures() ?? 0;
        if (dbFailures > 0) {
            console.error(`[DB-FAIL] ${dbFailures} database writes failed`);
            process.exitCode = 1;
        }
        await db?.end();
    }

    console.log(`Completed in ${((performance.now() - startedAt) / 1000).toFixed(1)}s`);
};

await main();
