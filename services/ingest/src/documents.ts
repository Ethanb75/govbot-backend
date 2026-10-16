import { createHash } from "node:crypto";
import { posix } from "node:path";
import type { Storage } from "@govbot/shared";
import { ExecutiveOrderRef, KnowledgeDocument } from "./types.js";

const DOCUMENT_TYPES_TO_INGEST = [".md"];

export const createContentHash = (content: string): string => {
    return createHash("sha256")
        .update(content, "utf8")
        .digest("hex");
};

// Every Markdown file in the knowledge base. A document's type is the folder it sits in (e.g.
// "executive-orders"), and its source is its key relative to the knowledge base root.
export const discoverDocuments = async (knowledgeBase: Storage): Promise<KnowledgeDocument[]> =>
    (await knowledgeBase.list())
        .filter(key => DOCUMENT_TYPES_TO_INGEST.includes(posix.extname(key)))
        .sort()
        .map(key => {
            const folder = posix.dirname(key);
            return { type: folder === "." ? "knowledge-base" : posix.basename(folder), source: key };
        });

export const loadDocument = async (knowledgeBase: Storage, source: string): Promise<string> => {
    const text = await knowledgeBase.read(source);
    if (text === undefined) throw new Error(`${source} disappeared from the knowledge base`);
    return text;
};

// The crawler writes this frontmatter itself (see crawler/src/sources/), so a few line regexes
// are enough - no YAML parser needed. Documents without it (e.g. the local dev samples) return
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
