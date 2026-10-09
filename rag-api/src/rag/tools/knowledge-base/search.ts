import { tool } from "ai";
import { z } from "zod";
import { config } from "../../../config.js";
import { rerank } from "../../rerank.js";
import { retrieve } from "../../retrieve.js";
import { RetrievedChunk } from "../../types.js";

// Per-request factory: `provided` is what's already in the system prompt, so the tool only returns new chunks.
// `found` collects every chunk the tool returned, for the sources list; it's complete once the answer stream is drained.
export const createSearchKnowledgeBase = (provided: RetrievedChunk[]) => {
    const seen = new Set(provided.map(chunk => chunk.id));
    const found: RetrievedChunk[] = [];

    const searchKnowledgeBase = tool({
        description:
            "Search the knowledge base of Georgia state government laws and the Governor's executive orders by meaning. " +
            "Use it when the extracts in the system prompt don't cover the question, or a different angle or identifier " +
            "(order number, code section, agency, date) is needed. Content already provided is not returned again.",
        inputSchema: z.object({
            query: z.string().min(1).describe(
                "Short, specific standalone search query, including any order numbers, code sections, agencies or dates"
            ),
        }),
        // no rewrite: the model already has the history and writes a standalone query
        execute: async ({ query }) => {
            try {
                const ranked = await rerank(query, await retrieve(query));
                const fresh = ranked.filter(chunk => !seen.has(chunk.id));
                const top = fresh.slice(0, config.TOOL_K);

                for (const chunk of top) {
                    seen.add(chunk.id);
                    found.push(chunk);
                }

                return {
                    extracts: top.map(chunk => ({ source: chunk.metadata.source, content: chunk.pageContent })),
                    alreadyProvided: ranked.length - fresh.length,
                };
            } catch (err) {
                // fail soft: the model says the lookup failed instead of the whole chat erroring
                console.error("searchKnowledgeBase failed: ", err);
                return { error: "knowledge base search unavailable" };
            }
        },
    });

    return { searchKnowledgeBase, found };
};
