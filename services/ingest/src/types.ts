export type KnowledgeDocument = {
    type: string;
    source: string;
};

// How an executive order's Markdown maps to its govbot-postgres-db row.
export type ExecutiveOrderRef = {
    jurisdiction: string;
    eoNumber: string;
};

export type LoadedDocument = KnowledgeDocument & {
    text: string;
};

export type DocumentChunk = {
    headline: string;
    summary: string;
    originalText: string;
};

export type ChunkResult = {
    pageContent: string;
    metadata: {
        source: string;
        type: string;
        contentHash: string;
    };
};
