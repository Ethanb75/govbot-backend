import "dotenv/config";
import { EMBEDDING_ENV } from "@govbot/shared";
import { z } from "zod";

const Config = z.object({
    OPENAI_API_KEY: z.string().min(1),
    ...EMBEDDING_ENV,
    CHUNKING_MODEL: z.string().default("gpt-4.1-nano"),
    // a local directory or s3://bucket/prefix; the crawler writes the same location
    KNOWLEDGE_BASE_PATH: z.string().min(1).default("./knowledge-base"),
    // vectors database (vectors_ingest role): chunks, embeddings and what was last indexed
    VECTORS_DATABASE_URL: z.string().min(1),
    // govbot metadata database (govbot_ingest role); optional so local dev still ingests without it
    GOVBOT_DATABASE_URL: z.string().optional(),
});
export type Config = z.infer<typeof Config>;

// Fail fast at startup rather than part way through a run
const parsed = Config.safeParse(process.env);
if (!parsed.success) {
    const fields = parsed.error.issues.map(issue => issue.path.join(".")).join(", ");
    throw new Error(`Invalid configuration: ${fields}`);
}

export const config: Config = parsed.data;
