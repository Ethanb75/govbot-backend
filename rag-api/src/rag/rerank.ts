import { generateText, Output } from "ai";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";
import { config } from "../config.js";
import { buildRerankPrompt, RERANK_SYSTEM_PROMPT } from "./prompts.js";
import { RetrievedChunk } from "./types.js";

const RankOrderSchema = z.object({
    order: z.array(z.number()).describe(
        "The order of relevance of chunks, from most relevant to least relevant, by chunk id number"
    ),
});

export const rerank = async (question: string, chunks: RetrievedChunk[]): Promise<RetrievedChunk[]> => {
    if (chunks.length <= 1) return chunks;

    const { output } = await generateText({
        model: openai(config.RERANK_MODEL),
        output: Output.object({ schema: RankOrderSchema }),
        system: RERANK_SYSTEM_PROMPT,
        prompt: buildRerankPrompt(question, chunks.map(chunk => chunk.pageContent)),
    });

    // The model's ids are 1-based and not guaranteed to be valid, unique or complete:
    // drop anything out of range or repeated, then append whatever it left out in retrieval order
    const used = new Set<number>();
    const ranked: RetrievedChunk[] = [];

    for (const id of output.order) {
        const index = id - 1;
        if (!Number.isInteger(index) || index < 0 || index >= chunks.length || used.has(index)) continue;
        used.add(index);
        ranked.push(chunks[index]);
    }

    chunks.forEach((chunk, index) => {
        if (!used.has(index)) ranked.push(chunk);
    });

    return ranked;
};
