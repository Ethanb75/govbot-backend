import { FastifyInstance } from "fastify";
import { fetchContext } from "../rag/answer.js";
import { formatIssues, SearchRequest } from "./schemas.js";

// Retrieval and rerank without generation, for checking what the chatbot would see
export const searchRoutes = async (app: FastifyInstance) => {
    app.post("/v1/search", async (request, reply) => {
        const parsed = SearchRequest.safeParse(request.body);
        if (!parsed.success) {
            return reply.code(400).send({ error: "invalid request", issues: formatIssues(parsed.error) });
        }

        const { query, history } = parsed.data;
        const { rewrittenQuery, chunks } = await fetchContext(query, history);

        return {
            rewrittenQuery,
            results: chunks.map(chunk => ({
                id: chunk.id,
                source: chunk.metadata.source,
                score: chunk.score,
                content: chunk.pageContent,
            })),
        };
    });
};
