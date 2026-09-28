import { embed } from "ai";
import { openai } from "@ai-sdk/openai";
import { config } from "./config.js";

// Must use the same model and dimensions as knowledge-ingest/src/embeddings.ts, or query
// vectors won't be comparable with the stored ones
export const embedQuery = async (value: string): Promise<number[]> => {
    const { embedding } = await embed({
        model: openai.embedding(config.EMBEDDING_MODEL),
        value,
        providerOptions: {
            openai: {
                dimensions: config.EMBEDDING_DIMENSIONS,
            },
        },
    });

    return embedding;
};
