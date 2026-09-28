import { config } from "../config.js";
import { embedQuery } from "../embeddings.js";
import { qdrant } from "../qdrant.js";
import { ChunkPayload, RetrievedChunk } from "./types.js";

export const retrieve = async (query: string): Promise<RetrievedChunk[]> => {
    const embedding = await embedQuery(query);

    const results = await qdrant.query(config.QDRANT_COLLECTION_NAME, {
        query: embedding,
        limit: config.RETRIEVAL_K,
        with_payload: true,
    });

    return results.points.map(point => {
        const payload = point.payload as ChunkPayload;
        return {
            id: point.id,
            score: point.score,
            pageContent: payload.document,
            metadata: { source: payload.source, type: payload.type, contentHash: payload.contentHash },
        };
    });
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
