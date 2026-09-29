import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import { AISDKError } from "ai";
import { config } from "./config.js";
import { healthRoutes } from "./routes/health.js";
import { ragChatRoutes } from "./routes/rag-chat.js";
// import { searchRoutes } from "./routes/search.js";

const app = Fastify({
    logger: true,
    // MAX_MESSAGES * MAX_MESSAGE_LENGTH plus room for JSON overhead
    bodyLimit: 128 * 1024,
    // only trust X-Forwarded-For from the nginx proxy, so clients can't spoof their IP past the rate limit
    trustProxy: config.TRUSTED_PROXY ?? false,
});

await app.register(rateLimit, {
    max: config.RATE_LIMIT_PER_MINUTE,
    timeWindow: "1 minute",
});

// Don't leak upstream (OpenAI / Qdrant) error details to the public
app.setErrorHandler((error: { statusCode?: number; message: string }, request, reply) => {
    // AI SDK errors carry the upstream status code (e.g. 401 for a bad key), which is ours to hide
    const statusCode = AISDKError.isInstance(error) ? 502 : (error.statusCode ?? 500);
    if (statusCode >= 500) {
        request.log.error({ err: error }, "request failed");
        return reply.code(statusCode).send({ error: "internal error" });
    }
    return reply.code(statusCode).send({ error: error.message });
});

await app.register(healthRoutes);
// await app.register(searchRoutes);
await app.register(ragChatRoutes);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, async () => {
        await app.close();
        process.exit(0);
    });
}

await app.listen({ host: config.HOST, port: config.PORT });
