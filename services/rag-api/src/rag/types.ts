export type Message = {
    role: "user" | "assistant";
    content: string;
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
