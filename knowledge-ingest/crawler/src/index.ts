import "dotenv/config";
import { accessSync, constants, existsSync, mkdirSync } from "node:fs";
import { parseArgs } from "node:util";

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
const parseYear = (): number => {
    const { values } = parseArgs({ options: { year: { type: "string" } } });
    if (values.year === undefined) return new Date().getFullYear();

    const year = Number(values.year);
    if (!Number.isInteger(year) || year < 1900) {
        throw new Error(`invalid --year ${values.year}`);
    }
    return year;
};

const healthCheck = async (): Promise<void> => {
    if (!existsSync(KNOWLEDGE_BASE_PATH)) {
        throw new Error(`knowledge base not found at ${KNOWLEDGE_BASE_PATH}`);
    }
    accessSync(KNOWLEDGE_BASE_PATH, constants.W_OK);

    mkdirSync(CRAWLER_STATE_PATH, { recursive: true });
    accessSync(CRAWLER_STATE_PATH, constants.W_OK);

    await checkOcrTools();
};

const main = async (): Promise<void> => {
    const startedAt = performance.now();
    const year = parseYear();

    console.log("Knowledge crawl started");
    console.log(`Knowledge base: ${KNOWLEDGE_BASE_PATH}`);
    console.log(`State:          ${CRAWLER_STATE_PATH}`);
    console.log(`Year:           ${year}\n`);

    await healthCheck();

    const signal = AbortSignal.timeout(CRAWL_TIMEOUT_MINUTES * 60_000);
    const failedSources: string[] = [];

    for (const source of SOURCES) {
        console.log(`[crawler] ${source.name}`);

        try {
            const result = await source.crawl({
                knowledgeBasePath: KNOWLEDGE_BASE_PATH,
                statePath: CRAWLER_STATE_PATH,
                year,
                signal,
            });

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
            failedSources.push(source.name);
        }
    }

    console.log(`Completed in ${((performance.now() - startedAt) / 1000).toFixed(1)}s`);

    if (failedSources.length > 0) process.exitCode = 1;
};

await main();
