import { FastifyInstance } from "fastify";
import { streamAnswer } from "../rag/answer.js";
import { RetrievedChunk } from "../rag/types.js";
import { ChatRequest, formatIssues, MAX_MESSAGE_LENGTH } from "./schemas.js";

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
        // zod helper function
        const parsed = ChatRequest.safeParse(request.body);
        console.log("parsed", parsed);
        if (!parsed.success) {
            console.log("parsed", parsed);
            return reply.code(400).send({ error: "invalid request", issues: formatIssues(parsed.error) });
        }

        const { messages, stream } = parsed.data;
        console.log(`messages: `, messages);
        const question = messages[messages.length - 1].content;
        const history = messages.slice(0, -1);

        // node thing
        const abort = new AbortController();

        // when the connection is closed to the client, abort request and stop using tokens
        reply.raw.on("close", () => {
            if (!reply.raw.writableFinished) abort.abort();
        });

        // Retrieval happens here, before any response is sent, so failures still get a normal error status
        const { chunks, textStream } = await streamAnswer(question, history, abort.signal);
        const sources = toSources(chunks);

        console.log("sources: ", sources)

        // if stream: false, combine the text into a string and send normally
        if (!stream) {
            let answer = "";
            for await (const text of textStream) answer += text;
            return { answer, sources };
        }

        // tell fastly we're hijacking the response. then set headers for SSE - Server Sent Events
        reply.hijack();
        reply.raw.writeHead(200, {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
            // tells nginx not to buffer, so deltas reach the browser as they are generated
            "X-Accel-Buffering": "no",
        });

        // used for citations
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
