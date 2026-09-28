import { FastifyInstance } from "fastify";
import { streamAnswer } from "../rag/answer.js";
import { RetrievedChunk } from "../rag/types.js";
import { ChatRequest, formatIssues } from "./schemas.js";

const toSources = (chunks: RetrievedChunk[]) =>
    chunks.map(chunk => ({
        source: chunk.metadata.source,
        contentHash: chunk.metadata.contentHash,
        score: chunk.score,
    }));

const sseEvent = (event: string, data: unknown): string =>
    `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

export const ragChatRoutes = async (app: FastifyInstance) => {
    app.post("/v1/rag/chat", async (request, reply) => {
        const parsed = ChatRequest.safeParse(request.body);
        if (!parsed.success) {
            return reply.code(400).send({ error: "invalid request", issues: formatIssues(parsed.error) });
        }

        const { messages, stream } = parsed.data;
        const question = messages[messages.length - 1].content;
        const history = messages.slice(0, -1);

        // stop paying for tokens nobody will read once the client goes away
        const abort = new AbortController();
        reply.raw.on("close", () => {
            if (!reply.raw.writableFinished) abort.abort();
        });

        // Retrieval happens here, before any response is sent, so failures still get a normal error status
        const { chunks, textStream } = await streamAnswer(question, history, abort.signal);
        const sources = toSources(chunks);

        if (!stream) {
            let answer = "";
            for await (const text of textStream) answer += text;
            return { answer, sources };
        }

        reply.hijack();
        reply.raw.writeHead(200, {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
            // tells nginx not to buffer, so deltas reach the browser as they are generated
            "X-Accel-Buffering": "no",
        });

        reply.raw.write(sseEvent("sources", sources));
        try {
            for await (const text of textStream) {
                reply.raw.write(sseEvent("delta", { text }));
            }
            reply.raw.write(sseEvent("done", {}));
        } catch (error) {
            if (!abort.signal.aborted) {
                request.log.error({ err: error }, "answer stream failed");
                reply.raw.write(sseEvent("error", { message: "failed to generate an answer" }));
            }
        } finally {
            reply.raw.end();
        }
    });
};
