import "dotenv/config";
import { z } from "zod";

const Config = z.object({
    OPENAI_API_KEY: z.string().min(1),
    QDRANT_URL: z.url(),
    QDRANT_API_KEY: z.string().optional(),
    QDRANT_COLLECTION_NAME: z.string().min(1),
    EMBEDDING_MODEL: z.string().default("text-embedding-3-large"),
    EMBEDDING_DIMENSIONS: z.coerce.number().int().positive().default(3072),
    REWRITE_MODEL: z.string().default("gpt-4.1-nano"),
    RERANK_MODEL: z.string().default("gpt-4.1-nano"),
    // ANSWER_MODEL: z.string().default("gpt-5.4-mini"),
    ANSWER_MODEL: z.string().default("gpt-4.1-nano"),
    // Workers AI, used for the intent check; optional so the service still starts without them
    CLOUDFLARE_WORKER_API_KEY: z.string().optional(),
    CLOUDFLARE_WORKER_ACCOUNT_ID: z.string().optional(),
    INTENT_MODEL: z.string().default("@cf/cloudflare/clef"),
    // govbot-postgres-db (read-only govbot_app role), used by the executive order tool; optional so local dev and the evals still start without it
    GOVBOT_DATABASE_URL: z.string().optional(),
    RETRIEVAL_K:z.coerce.number().int().positive().default(20),
    FINAL_K: z.coerce.number().int().positive().default(10),
    // chunks returned per searchKnowledgeBase call; about half the upfront context so tool results stay small
    TOOL_K: z.coerce.number().int().positive().default(5),
    // IP of the reverse proxy allowed to set X-Forwarded-For; unset when running locally
    TRUSTED_PROXY: z.string().optional(),
    RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(10),
    HOST: z.string().default("0.0.0.0"),
    PORT: z.coerce.number().int().positive().default(8090),
});
export type Config = z.infer<typeof Config>;

// Fail fast at startup rather than on the first request
const parsed = Config.safeParse(process.env);
if (!parsed.success) {
    const fields = parsed.error.issues.map(issue => issue.path.join(".")).join(", ");
    throw new Error(`Invalid configuration: ${fields}`);
}

export const config: Config = parsed.data;
