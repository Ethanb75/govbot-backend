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
    ANSWER_MODEL: z.string().default("gpt-5.4-mini"),
    RETRIEVAL_K: z.coerce.number().int().positive().default(20),
    FINAL_K: z.coerce.number().int().positive().default(10),
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
