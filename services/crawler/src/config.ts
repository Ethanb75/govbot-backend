import "dotenv/config";
import { z } from "zod";

const Config = z.object({
    // a local directory or s3://bucket/prefix; ingest reads the same location
    KNOWLEDGE_BASE_PATH: z.string().min(1).default("../ingest/knowledge-base"),
    // per-source crawl state (a local directory or s3://bucket/prefix)
    CRAWLER_STATE_PATH: z.string().min(1).default("../ingest/crawler-state"),
    // Hard stop so a hanging government site can't keep the crawl running into the 3 AM ingest.
    CRAWL_TIMEOUT_MINUTES: z.coerce.number().positive().default(30),
    // govbot metadata database (govbot_ingest role); optional so local dev still crawls without it
    GOVBOT_DATABASE_URL: z.string().optional(),
});
export type Config = z.infer<typeof Config>;

// Fail fast at startup rather than part way through a crawl
const parsed = Config.safeParse(process.env);
if (!parsed.success) {
    const fields = parsed.error.issues.map(issue => issue.path.join(".")).join(", ");
    throw new Error(`Invalid configuration: ${fields}`);
}

export const config: Config = parsed.data;
