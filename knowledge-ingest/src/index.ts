import "dotenv/config";
import { accessSync, constants, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { z } from "zod";

import { createContentHash, discoverDocuments, loadDocument } from "./documents.js";
import { createChunksFromDocument } from "./chunk.js";
import { createEmbeddings } from "./embeddings.js";
import { deleteChunks, ensureCollectionExists, getCollectionStats, upsertChunks } from "./qdrant.js";

const KNOWLEDGE_BASE_PATH = process.env.KNOWLEDGE_BASE_PATH ?? "./knowledge-base";
const APP_STATE_PATH = process.env.APP_STATE_BASE_PATH ?? "./app-state";
const APP_STATE_FILE = join(APP_STATE_PATH, "state.json");

const REQUIRED_ENV_VARS = [
    "OPENAI_API_KEY",
    "EMBEDDING_DIMENSIONS",
    "QDRANT_URL",
    "QDRANT_COLLECTION_NAME",
] as const;

const DocumentState = z.object({
    contentHash: z.string(),
    lastIndexedAt: z.string(),
    chunkIds: z.array(z.string()),
});
type DocumentState = z.infer<typeof DocumentState>;

const AppState = z.object({
    documents: z.record(z.string(), DocumentState).default({}),
});
type AppState = z.infer<typeof AppState>;

const loadAppState = (): AppState => {
    if (!existsSync(APP_STATE_FILE)) return { documents: {} };

    return AppState.parse(JSON.parse(readFileSync(APP_STATE_FILE, "utf-8")));
};

const saveAppState = (state: AppState): void => {
    mkdirSync(APP_STATE_PATH, { recursive: true });
    writeFileSync(APP_STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
};

// State keys - and the source on every chunk payload - are relative to the knowledge base so
// they stay stable no matter how KNOWLEDGE_BASE_PATH is configured.
const toStateKey = (source: string): string => relative(KNOWLEDGE_BASE_PATH, source);

const shortHash = (hash: string): string => hash.slice(0, 12);

const summaryRow = (label: string, value: number | string): string =>
    `${`${label}:`.padEnd(22)}${String(value).padStart(6)}`;

const healthCheck = (): void => {
    const missing = REQUIRED_ENV_VARS.filter(name => !process.env[name]);
    if (missing.length > 0) {
        throw new Error(`Please set ${missing.join(", ")}`);
    }

    if (!existsSync(KNOWLEDGE_BASE_PATH)) {
        throw new Error(`knowledge base not found at ${KNOWLEDGE_BASE_PATH}`);
    }

    // Find out now rather than after a run's worth of upserts: points we can't record in the
    // state file get re-chunked under new ids next run and are never cleaned up.
    mkdirSync(APP_STATE_PATH, { recursive: true });
    accessSync(APP_STATE_PATH, constants.W_OK);
};

const ingest = async (): Promise<void> => {
    const startedAt = performance.now();

    console.log("Knowledge ingestion started");
    console.log(`Knowledge base: ${KNOWLEDGE_BASE_PATH}`);
    console.log(`Qdrant:         ${process.env.QDRANT_URL}`);
    console.log(`Collection:     ${process.env.QDRANT_COLLECTION_NAME}\n`);

    healthCheck();
    await ensureCollectionExists();

    const appState = loadAppState();
    // Built up as we walk the knowledge base; whatever is left behind in appState is an orphan.
    const nextState: AppState = { documents: {} };

    // Entries we haven't reached yet keep their previous state, so a crash part way through a
    // run never loses track of points that are already in qdrant.
    const checkpoint = (): void => saveAppState({ documents: { ...appState.documents, ...nextState.documents } });

    const documents = discoverDocuments(KNOWLEDGE_BASE_PATH);

    const created: string[] = [];
    const updated: string[] = [];
    const unchanged: string[] = [];
    const removed: string[] = [];
    const failed: string[] = [];
    let vectorsUploaded = 0;
    let vectorsDeleted = 0;

    // No concurrency on purpose - one document at a time keeps the chunking model, the embedding
    // API and qdrant all well within their rate limits.
    for (const doc of documents) {
        const key = toStateKey(doc.source);
        const previous: DocumentState | undefined = appState.documents[key];

        const text = loadDocument(doc.source);
        const contentHash = createContentHash(text);

        if (previous?.contentHash === contentHash) {
            console.log(`[SKIP] ${key} - unchanged`);
            nextState.documents[key] = previous;
            unchanged.push(key);
            continue;
        }

        try {
            const chunks = await createChunksFromDocument({ ...doc, source: key, text });
            const embeddings = await createEmbeddings(chunks.map(chunk => chunk.pageContent));
            const chunkIds = await upsertChunks(chunks, embeddings);
            vectorsUploaded += chunkIds.length;

            // Re-chunking a document can produce fewer or differently split chunks, so drop the
            // points it used to own but no longer does.
            const stale = previous?.chunkIds.filter(id => !chunkIds.includes(id)) ?? [];
            await deleteChunks(stale);
            vectorsDeleted += stale.length;

            nextState.documents[key] = {
                contentHash,
                lastIndexedAt: new Date().toISOString(),
                chunkIds,
            };
            checkpoint();

            if (previous) {
                console.log(`[UPDATE] ${key}`);
                console.log(`       hash=${shortHash(previous.contentHash)} -> ${shortHash(contentHash)}`);
                console.log(`       vectors=${previous.chunkIds.length} -> ${chunkIds.length} (${stale.length} stale removed)`);
                updated.push(key);
            } else {
                console.log(`[NEW] ${key}`);
                console.log(`       chunks=${chunks.length} vectors=${chunkIds.length}`);
                created.push(key);
            }
        } catch (error) {
            // Leave the old state entry in place: the document stays "stale" and gets retried on
            // the next run instead of having its existing chunks collected as orphans.
            console.error(`[FAIL] ${key} - ${error}`);
            if (previous) nextState.documents[key] = previous;
            failed.push(key);
        }
    }

    const orphans = Object.keys(appState.documents).filter(key => !(key in nextState.documents));

    for (const key of orphans) {
        const { chunkIds } = appState.documents[key];

        try {
            await deleteChunks(chunkIds);
            vectorsDeleted += chunkIds.length;
            console.log(`[DELETE] ${key}`);
            console.log(`       vectors=${chunkIds.length}`);
            removed.push(key);
        } catch (error) {
            // Keep the entry so the next run retries the cleanup rather than losing the point ids.
            console.error(`[FAIL] ${key} - could not delete chunks: ${error}`);
            nextState.documents[key] = appState.documents[key];
            failed.push(key);
        }
    }

    // save the state of the document store as it is now
    saveAppState(nextState);

    const collectionPoints = await getCollectionStats()
        .then(stats => stats.points_count ?? "unknown")
        .catch(error => `unavailable (${error})`);

    console.log("");
    console.log(summaryRow("Documents discovered", documents.length));
    console.log(summaryRow("Unchanged", unchanged.length));
    console.log(summaryRow("New", created.length));
    console.log(summaryRow("Changed", updated.length));
    console.log(summaryRow("Deleted", removed.length));
    console.log("");
    console.log(summaryRow("Documents ingested", created.length + updated.length));
    console.log(summaryRow("Vectors uploaded", vectorsUploaded));
    console.log(summaryRow("Vectors deleted", vectorsDeleted));
    console.log(summaryRow("Collection points", collectionPoints));
    console.log(summaryRow("Failures", failed.length));
    console.log("");
    console.log(`Completed in ${((performance.now() - startedAt) / 1000).toFixed(1)}s`);

    if (failed.length > 0) {
        console.error(`\nfailed documents:\n  ${failed.join("\n  ")}`);
        process.exitCode = 1;
    }
};

await ingest();
