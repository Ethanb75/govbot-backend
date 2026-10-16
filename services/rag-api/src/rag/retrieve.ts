import { createEmbedder } from "@govbot/shared";
import { config } from "../config.js";
import { getVectorsPool } from "../vectors.js";
import { RetrievedChunk } from "./types.js";

const { embedQuery } = createEmbedder(config);

// Nearest chunks by cosine distance, served by the HNSW index on chunks.embedding. The score is
// cosine similarity (1 - distance), the same scale Qdrant reported, so higher is closer.
const NEAREST_CHUNKS_SQL = `
    SELECT id, content, metadata, 1 - (embedding <=> $1::halfvec) AS score
    FROM chunks
    ORDER BY embedding <=> $1::halfvec
    LIMIT $2
`;

type ChunkRow = {
    id: string;
    content: string;
    metadata: RetrievedChunk["metadata"];
    score: number;
};

export const retrieve = async (query: string): Promise<RetrievedChunk[]> => {
    const embedding = await embedQuery(query);

    const { rows } = await getVectorsPool().query<ChunkRow>(NEAREST_CHUNKS_SQL, [
        `[${embedding.join(",")}]`,
        config.RETRIEVAL_K,
    ]);

    return rows.map(row => ({
        id: row.id,
        score: Number(row.score),
        pageContent: row.content,
        metadata: { source: row.metadata.source, type: row.metadata.type, contentHash: row.metadata.contentHash },
    }));
};

// Keeps the first occurrence of each point, so earlier lists win on ordering and score
export const mergeChunks = (...lists: RetrievedChunk[][]): RetrievedChunk[] => {
    const seen = new Set<string | number>();
    const merged: RetrievedChunk[] = [];

    for (const chunk of lists.flat()) {
        if (seen.has(chunk.id)) continue;
        seen.add(chunk.id);
        merged.push(chunk);
    }

    return merged;
};
