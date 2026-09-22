import { embedMany, embed } from "ai";
import { openai } from "@ai-sdk/openai";

const EMBEDDING_MODEL = "text-embedding-3-large";
const EMBEDDING_DIMENSIONS = Number(process.env.EMBEDDING_DIMENSIONS ?? 3072);

export const createEmbeddings = async (values: string[]): Promise<number[][]> => {
    const { embeddings } = await embedMany({
        model: openai.embedding(EMBEDDING_MODEL),
        values,
        providerOptions: {
            openai: {
                dimensions: EMBEDDING_DIMENSIONS,
            },
        },
    });

    return embeddings;
};
