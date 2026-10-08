import { isStepCount, streamText } from "ai";
import { openai } from "@ai-sdk/openai";
import { config } from "../config.js";
import { dbEnabled } from "../db.js";
import { searchExecutiveOrders } from "./tools/executive-orders.js";
import { buildSystemPrompt } from "./prompts.js";
import { rerank } from "./rerank.js";
import { mergeChunks, retrieve } from "./retrieve.js";
import { rewriteQuery } from "./rewrite.js";
import { Message, RetrievedChunk } from "./types.js";

export type RetrievedContext = {
    rewrittenQuery: string;
    chunks: RetrievedChunk[];
};

// rewrite -> retrieve with both the rewritten and original question -> merge -> rerank -> top FINAL_K
export const fetchContext = async (question: string, history: Message[]): Promise<RetrievedContext> => {
    const rewrittenQuery = await rewriteQuery(question, history);

    const lookups = rewrittenQuery === question ? [question] : [rewrittenQuery, question];
    const results = await Promise.all(lookups.map(retrieve));
    const merged = mergeChunks(...results);

    const ranked = await rerank(question, merged);

    return { rewrittenQuery, chunks: ranked.slice(0, config.FINAL_K) };
};

export const buildContext = (chunks: RetrievedChunk[], toolsEnabled = false): string => {
    const context = chunks
        .map(chunk => `Extract from ${chunk.metadata.source}:\n${chunk.pageContent}`)
        .join("\n\n");

    return buildSystemPrompt(context, toolsEnabled);
};

export const streamAnswer = async (question: string, history: Message[], abortSignal?: AbortSignal) => {
    const { rewrittenQuery, chunks } = await fetchContext(question, history);

    const toolsEnabled = dbEnabled();

    // RAG retrieval still runs first; the tools add structured lookups on top of the extracts
    const result = streamText({
        model: openai(config.ANSWER_MODEL),
        system: buildContext(chunks, toolsEnabled),
        messages: [...history, { role: "user", content: question }],
        tools: toolsEnabled ? { searchExecutiveOrders } : undefined,
        // tool call -> answer, with headroom for one retry
        stopWhen: isStepCount(3),
        onStepEnd: step => {
            for (const call of step.toolCalls) {
                console.log("tool call: ", call.toolName, JSON.stringify(call.input));
            }
            for (const result of step.toolResults) {
                console.log("tool result: ", result.toolName, JSON.stringify(result.output));
            }
        },
        abortSignal,
    });

    return { rewrittenQuery, chunks, model: config.ANSWER_MODEL, textStream: result.textStream };
};
