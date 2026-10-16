import { createEmbedder, createStorage } from "@govbot/shared";

import { config } from "./config.js";
import { connectDb, describeDatabaseUrl } from "./db.js";
import { createContentHash, discoverDocuments, executiveOrderRef, loadDocument } from "./documents.js";
import { createChunksFromDocument } from "./chunk.js";
import { ExecutiveOrderRef } from "./types.js";
import { connectVectors, IndexedDocument } from "./vectors.js";

const knowledgeBase = createStorage(config.KNOWLEDGE_BASE_PATH);
const { embedDocuments } = createEmbedder(config);

const shortHash = (hash: string): string => hash.slice(0, 12);

const summaryRow = (label: string, value: number | string): string =>
    `${`${label}:`.padEnd(22)}${String(value).padStart(6)}`;

const ingest = async (): Promise<void> => {
    const startedAt = performance.now();

    console.log("Knowledge ingestion started");
    console.log(`Knowledge base: ${knowledgeBase.location}`);
    console.log(`Vectors:        ${describeDatabaseUrl(config.VECTORS_DATABASE_URL)}`);
    console.log(`Database:       ${config.GOVBOT_DATABASE_URL ? describeDatabaseUrl(config.GOVBOT_DATABASE_URL) : "disabled (GOVBOT_DATABASE_URL not set)"}\n`);

    await knowledgeBase.check("read");
    const vectors = await connectVectors(config.VECTORS_DATABASE_URL);
    const db = await connectDb();

    // what the vectors database last indexed; whatever isn't discovered below is an orphan
    const indexed = await vectors.indexedDocuments();
    const documents = await discoverDocuments(knowledgeBase);

    // An empty listing is far more likely a wrong path, prefix or bucket than a deliberately
    // emptied knowledge base, and the orphan cleanup below would wipe the whole index.
    if (documents.length === 0 && indexed.size > 0) {
        throw new Error(
            `no documents found in ${knowledgeBase.location}, but ${indexed.size} are indexed - refusing to delete them all`,
        );
    }

    const created: string[] = [];
    const updated: string[] = [];
    const unchanged: string[] = [];
    const removed: string[] = [];
    const failed: string[] = [];
    let vectorsUploaded = 0;
    let vectorsDeleted = 0;

    // No concurrency on purpose - one document at a time keeps the chunking model, the embedding
    // API and the database all well within their rate limits.
    for (const doc of documents) {
        const key = doc.source;
        const previous: IndexedDocument | undefined = indexed.get(key);
        // set for executive orders, whose metadata row tracks their index status
        let ref: ExecutiveOrderRef | undefined;

        try {
            const text = await loadDocument(knowledgeBase, key);
            const contentHash = createContentHash(text);
            ref = executiveOrderRef(text);

            if (previous?.contentHash === contentHash) {
                console.log(`[SKIP] ${key} - unchanged`);
                unchanged.push(key);
                // Reconcile from the index: repairs missed writes and rows the crawler created
                // after the vectors (e.g. its --backfill-db), without re-embedding.
                if (ref) {
                    await db?.markIndexed(ref, {
                        documentId: key,
                        chunkCount: previous.chunkCount,
                        indexedAt: previous.lastIndexedAt,
                    });
                }
                continue;
            }

            const chunks = await createChunksFromDocument({ ...doc, text });
            const embeddings = await embedDocuments(chunks.map(chunk => chunk.pageContent));
            // drops the chunks the document used to have along with writing the new ones
            const { chunkCount, indexedAt } = await vectors.replaceDocument(key, contentHash, chunks, embeddings);
            vectorsUploaded += chunkCount;
            vectorsDeleted += previous?.chunkCount ?? 0;

            if (ref) {
                await db?.markIndexed(ref, { documentId: key, chunkCount, indexedAt });
            }

            if (previous) {
                console.log(`[UPDATE] ${key}`);
                console.log(`       hash=${shortHash(previous.contentHash)} -> ${shortHash(contentHash)}`);
                console.log(`       vectors=${previous.chunkCount} -> ${chunkCount}`);
                updated.push(key);
            } else {
                console.log(`[NEW] ${key}`);
                console.log(`       vectors=${chunkCount}`);
                created.push(key);
            }
        } catch (error) {
            // The previous version stays indexed under its old hash, so the document is still
            // searchable and gets retried on the next run.
            console.error(`[FAIL] ${key} - ${error}`);
            failed.push(key);
            if (ref) await db?.markFailed(ref);
        }
    }

    const discovered = new Set(documents.map(doc => doc.source));
    const orphans = [...indexed.keys()].filter(key => !discovered.has(key));

    for (const key of orphans) {
        try {
            const chunkCount = await vectors.removeDocument(key);
            vectorsDeleted += chunkCount;
            console.log(`[DELETE] ${key}`);
            console.log(`       vectors=${chunkCount}`);
            removed.push(key);
            await db?.markRemoved(key);
        } catch (error) {
            // still in documents, so the next run retries the cleanup
            console.error(`[FAIL] ${key} - could not delete chunks: ${error}`);
            failed.push(key);
        }
    }

    const dbFailures = db?.failures() ?? 0;
    await db?.end();

    const totalChunks = await vectors
        .countChunks()
        .catch(error => `unavailable (${error})`);
    await vectors.end();

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
    console.log(summaryRow("Chunks indexed", totalChunks));
    console.log(summaryRow("Failures", failed.length));
    console.log(summaryRow("DB writes failed", db ? dbFailures : "n/a"));
    console.log("");
    console.log(`Completed in ${((performance.now() - startedAt) / 1000).toFixed(1)}s`);

    if (failed.length > 0) {
        console.error(`\nfailed documents:\n  ${failed.join("\n  ")}`);
        process.exitCode = 1;
    }
    if (dbFailures > 0) process.exitCode = 1;
};

await ingest();
