import "dotenv/config";
import { EMBEDDING_ENV } from "@govbot/shared";
import { z } from "zod";

const Config = z.object({
    OPENAI_API_KEY: z.string().min(1),
    // vectors database (read-only vectors_app role) that ingest keeps up to date
    VECTORS_DATABASE_URL: z.string().min(1),
    // must match what ingest embedded the chunks with, so both read it from packages/shared
    ...EMBEDDING_ENV,
    REWRITE_MODEL: z.string().default("gpt-4.1-nano"),
    RERANK_MODEL: z.string().default("gpt-4.1-nano"),
    // ANSWER_MODEL: z.string().default("gpt-5.4-mini"),
    ANSWER_MODEL: z.string().default("gpt-4.1-nano"),
    // only used by the answer evals (__tests__/answers); stronger than the answer model so it can grade it
    JUDGE_MODEL: z.string().default("gpt-5.4-mini"),
    // Workers AI, used for the intent check; optional so the service still starts without them
    CLOUDFLARE_WORKER_API_KEY: z.string().optional(),
    CLOUDFLARE_WORKER_ACCOUNT_ID: z.string().optional(),
    INTENT_MODEL: z.string().default("@cf/cloudflare/clef"),
    // metadata database (read-only govbot_app role), used by the executive order tool; optional so local dev and the evals still start without it
    GOVBOT_DATABASE_URL: z.string().optional(),
    RETRIEVAL_K:z.coerce.number().int().positive().default(20),
    FINAL_K: z.coerce.number().int().positive().default(10),
    // chunks returned per searchKnowledgeBase call; about half the upfront context so tool results stay small
    TOOL_K: z.coerce.number().int().positive().default(5),
    // Proxies in front of the service that append to X-Forwarded-For: 2 behind CloudFront -> ALB
    // (the ALB, then the CloudFront edge). The client IP is read that many hops back, so the rate
    // limit keys on the viewer and anything a client puts in the header itself is ignored. 0 locally.
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).default(0),
    RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(10),
    HOST: z.string().default("0.0.0.0"),
    PORT: z.coerce.number().int().positive().default(8090),
    // debug also logs questions, answers and tool calls - keep it off in production
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
});
export type Config = z.infer<typeof Config>;

// Fail fast at startup rather than on the first request
const parsed = Config.safeParse(process.env);
if (!parsed.success) {
    const fields = parsed.error.issues.map(issue => issue.path.join(".")).join(", ");
    throw new Error(`Invalid configuration: ${fields}`);
}

export const config: Config = parsed.data;
