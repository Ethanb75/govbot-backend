// run me first to create the collection in qdrant

import "dotenv/config";
import { QdrantClient } from "@qdrant/js-client-rest";

const QDRANT_URL = process.env.QDRANT_URL ?? "http://192.168.1.131:6333";
const COLLECTION_NAME = process.env.QDRANT_COLLECTION_NAME;
const EMBEDDING_DIMENSIONS = Number(process.env.EMBEDDING_DIMENSIONS ?? 3072);

const client = new QdrantClient({ url: QDRANT_URL });

const setupCollection = async (): Promise<void> => {
    if(!COLLECTION_NAME) {
        console.error("COLLECTION_NAME is not set. Please set this env variable");
        return;
    }
    const exists = await client.collectionExists(COLLECTION_NAME);

    if (exists.exists) {
        console.log(`collection "${COLLECTION_NAME}" already exists`);
        return;
    }

    await client.createCollection(COLLECTION_NAME, {
        vectors: {
            size: EMBEDDING_DIMENSIONS,
            distance: "Cosine",
        },
    });

    console.log(`created collection "${COLLECTION_NAME}"`);
}

await setupCollection();
