import { readdirSync, readFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { createHash } from "node:crypto";
import { ExecutiveOrderRef, KnowledgeDocument } from "./types.js";

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

// The crawler writes this frontmatter itself (see crawler/src/sources/), so a few line regexes
// are enough - no YAML parser needed. Documents without it (e.g. the Insurellm samples) return
// undefined and never touch the database.
export const executiveOrderRef = (text: string): ExecutiveOrderRef | undefined => {
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1];
    if (!frontmatter) return undefined;

    const field = (name: string): string | undefined =>
        new RegExp(`^${name}:[ \\t]*(.*)$`, "m")
            .exec(frontmatter)?.[1]
            .trim()
            .replace(/^(["'])(.*)\1$/, "$2");

    const jurisdiction = field("jurisdiction");
    const eoNumber = field("order_number");
    if (field("document_type") !== "executive_order" || !jurisdiction || !eoNumber) return undefined;

    return { jurisdiction, eoNumber };
};
