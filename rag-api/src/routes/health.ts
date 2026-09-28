import { FastifyInstance } from "fastify";
import { collectionExists } from "../qdrant.js";

export const healthRoutes = async (app: FastifyInstance) => {
    app.get("/health/live", { config: { rateLimit: false } }, async () => ({ status: "ok" }));

    // config is validated at startup, so being able to answer at all means it loaded;
    // deliberately never touches OpenAI so health checks cost nothing
    app.get("/health/ready", { config: { rateLimit: false } }, async (request, reply) => {
        try {
            if (!(await collectionExists())) {
                return reply.code(503).send({ status: "unavailable", reason: "qdrant collection not found" });
            }
        } catch (error) {
            request.log.warn({ err: error }, "qdrant readiness check failed");
            return reply.code(503).send({ status: "unavailable", reason: "qdrant unreachable" });
        }

        return { status: "ok" };
    });
};
