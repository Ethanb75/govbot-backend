import { readdirSync, readFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { createHash } from "node:crypto";
import { KnowledgeDocument } from "./types.js";

const DOCUMENT_TYPES_TO_INGEST = [".md"];

export const createContentHash = (content: string): string => {
    return createHash("sha256")
        .update(content, "utf8")
        .digest("hex");
};

export const discoverDocuments = (path: string): KnowledgeDocument[] => {
    const documents: KnowledgeDocument[] = [];

    for (const entry of readdirSync(path, { withFileTypes: true })) {
        const entryPath = join(path, entry.name);

        if (entry.isDirectory()) {
            documents.push(...discoverDocuments(entryPath));
        } else if (DOCUMENT_TYPES_TO_INGEST.includes(extname(entry.name))) {
            documents.push({
                type: basename(path),
                source: entryPath
            });
        }
    }

    return documents;
};

export const loadDocument = (entryPath: string) => readFileSync(entryPath, "utf-8");
