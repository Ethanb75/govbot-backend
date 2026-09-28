export type Message = {
    role: "user" | "assistant";
    content: string;
};

// Payload shape written by knowledge-ingest/src/qdrant.ts upsertChunks
export type ChunkPayload = {
    document: string;
    source: string;
    type: string;
    contentHash: string;
};

export type RetrievedChunk = {
    id: string | number;
    score: number;
    pageContent: string;
    metadata: {
        source: string;
        type: string;
        contentHash: string;
    };
};
