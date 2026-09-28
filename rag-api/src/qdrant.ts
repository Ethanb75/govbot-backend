import { QdrantClient } from "@qdrant/js-client-rest";
import { config } from "./config.js";

export const qdrant = new QdrantClient({
    url: config.QDRANT_URL,
    apiKey: config.QDRANT_API_KEY,
});

export const collectionExists = async (): Promise<boolean> => {
    const { exists } = await qdrant.collectionExists(config.QDRANT_COLLECTION_NAME);
    return exists;
};
