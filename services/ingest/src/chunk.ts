import { generateText, Output } from "ai";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";
import pLimit from "p-limit";
import { createContentHash } from "./documents.js";
import { ChunkResult, DocumentChunk, KnowledgeDocument, LoadedDocument } from "./types.js";

const CHUNKING_MODEL = "gpt-4.1-nano";
const AVERAGE_CHUNK_SIZE = 100;
const CHUNKING_CONCURRENCY = 10;

const chunkToResult = (document: KnowledgeDocument, chunk: DocumentChunk): ChunkResult => ({
    pageContent: `${chunk.headline}\n\n${chunk.summary}\n\n${chunk.originalText}`,
    metadata: {
        source: document.source,
        type: document.type,
        contentHash: createContentHash(chunk.originalText),
    },
});

export const createChunksFromDocument = async (document: LoadedDocument): Promise<ChunkResult[]> => {
    const numChunks = Math.trunc(document.text.length / AVERAGE_CHUNK_SIZE) + 1;

    const chatTemplate = `
        You take a document and you split the document into overlapping chunks for a KnowledgeBase.

        The document is from the shared drive of a company called Insurellm.
        The document is of type: ${document["type"]}
        The document has been retrieved from: ${document["source"]}

        A chatbot will use these chunks to answer questions about the company.
        You should divide up the document as you see fit, being sure that the entire document is returned across the chunks - don't leave anything out.
        This document should probably be split into at least ${numChunks} chunks, but you can have more or less as appropriate, ensuring that there are individual chunks to answer specific questions.
        There should be overlap between the chunks as appropriate; typically about 25% overlap or about 50 words, so you have the same text in multiple chunks for best retrieval results.

        For each chunk, you should provide a headline, a summary, and the original text of the chunk.
        Together your chunks should represent the entire document with overlap.

        Here is the document:

        ${document["text"]}

        Respond with the chunks.
    `;

    const { output } = await generateText({
        model: openai(CHUNKING_MODEL),
        output: Output.object({
            schema: z.object({
                chunks: z.array(z.object({
                    headline: z.string(),
                    summary: z.string(),
                    originalText: z.string(),
                })),
            }),
        }),
        prompt: chatTemplate,
    });

    return output.chunks.map(chunk => chunkToResult(document, chunk));
};

export const convertDocumentsToChunks = async (documents: LoadedDocument[]): Promise<ChunkResult[]> => {
    const limit = pLimit(CHUNKING_CONCURRENCY);
    const results = await Promise.allSettled(documents.map(doc => limit(() => createChunksFromDocument(doc))));

    const chunks: ChunkResult[] = [];

    for (const result of results) {
        if (result.status === "fulfilled") {
            chunks.push(...result.value);
        } else {
            console.warn(`failed to chunk document: ${result.reason}`);
        }
    }

    return chunks;
};
