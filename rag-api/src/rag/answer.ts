import { isStepCount, streamText } from "ai";
import { openai } from "@ai-sdk/openai";
import { config } from "../config.js";
import { dbEnabled } from "../db.js";
import { searchExecutiveOrders } from "./tools/executive-orders/meta-db.js";
import { createSearchKnowledgeBase } from "./tools/knowledge-base/search.js";
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

export const buildContext = (chunks: RetrievedChunk[], executiveOrdersEnabled = false): string => {
    const context = chunks
        .map(chunk => `Extract from ${chunk.metadata.source}:\n${chunk.pageContent}`)
        .join("\n\n");

    const test = buildSystemPrompt(context, executiveOrdersEnabled);

    // console.log('FULL PROMPT:\n', test);

    return test;
};

export const streamAnswer = async (question: string, history: Message[], abortSignal?: AbortSignal) => {
    const { rewrittenQuery, chunks } = await fetchContext(question, history);

    const executiveOrdersEnabled = dbEnabled();
    const { searchKnowledgeBase, found } = createSearchKnowledgeBase(chunks);

    // RAG retrieval still runs first; the tools add extra and structured lookups on top of the extracts
    const result = streamText({
        model: openai(config.ANSWER_MODEL),
        system: buildContext(chunks, executiveOrdersEnabled),
        messages: [...history, { role: "user", content: question }],
        tools: { searchKnowledgeBase, searchExecutiveOrders },
        // activeTools rather than a conditional tools object, so the step callback keeps its typed tool calls
        activeTools: executiveOrdersEnabled ? ["searchKnowledgeBase", "searchExecutiveOrders"] : ["searchKnowledgeBase"],
        // KB search -> EO search -> answer, with headroom for one retry
        stopWhen: isStepCount(4),
        onStepEnd: step => {
            for (const call of step.toolCalls) {
                console.log("tool call: ", call.toolName, JSON.stringify(call.input));
            }
            for (const result of step.toolResults) {
                // truncated so knowledge base extracts don't flood the logs
                console.log("tool result: ", result.toolName, JSON.stringify(result.output).slice(0, 500));
            }
        },
        abortSignal,
    });

    // toolChunks fills in as the stream runs; it's complete once textStream is drained
    return { rewrittenQuery, chunks, toolChunks: found, model: config.ANSWER_MODEL, textStream: result.textStream };
};
