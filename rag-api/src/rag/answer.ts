import { streamText } from "ai";
import { openai } from "@ai-sdk/openai";
import { config } from "../config.js";
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

export const buildContext = (chunks: RetrievedChunk[]): string => {
    const context = chunks
        .map(chunk => `Extract from ${chunk.metadata.source}:\n${chunk.pageContent}`)
        .join("\n\n");

    return buildSystemPrompt(context);
};

export const streamAnswer = async (question: string, history: Message[], abortSignal?: AbortSignal) => {
    const { rewrittenQuery, chunks } = await fetchContext(question, history);

    const result = streamText({
        model: openai(config.ANSWER_MODEL),
        system: buildContext(chunks),
        messages: [...history, { role: "user", content: question }],
        abortSignal,
    });

    return { rewrittenQuery, chunks, model: config.ANSWER_MODEL, textStream: result.textStream };
};
