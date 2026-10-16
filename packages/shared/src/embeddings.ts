import { embed, embedMany } from "ai";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";

// Spread into each service's own zod config, so ingest (which writes the vectors) and rag-api
// (which embeds queries against them) can't drift apart. EMBEDDING_DIMENSIONS must also match
// the halfvec(3072) column in db/vectors/migrations - changing it means a new migration and a
// full re-ingest.
export const EMBEDDING_ENV = {
    EMBEDDING_MODEL: z.string().default("text-embedding-3-large"),
    EMBEDDING_DIMENSIONS: z.coerce.number().int().positive().default(3072),
};

export type EmbeddingConfig = {
    EMBEDDING_MODEL: string;
    EMBEDDING_DIMENSIONS: number;
};

export const createEmbedder = ({ EMBEDDING_MODEL, EMBEDDING_DIMENSIONS }: EmbeddingConfig) => {
    const model = openai.embedding(EMBEDDING_MODEL);
    const providerOptions = { openai: { dimensions: EMBEDDING_DIMENSIONS } };

    return {
        embedQuery: async (value: string): Promise<number[]> =>
            (await embed({ model, value, providerOptions })).embedding,

        embedDocuments: async (values: string[]): Promise<number[][]> =>
            (await embedMany({ model, values, providerOptions })).embeddings,
    };
};
