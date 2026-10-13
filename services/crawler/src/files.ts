import { createHash } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const createContentHash = (content: Uint8Array | string): string =>
    createHash("sha256").update(content).digest("hex");

// knowledge-ingest picks up every *.md under the knowledge base, so write to a .tmp sibling and
// rename it into place - the ingester only ever sees complete files.
export const writeFileAtomic = (path: string, content: string): void => {
    mkdirSync(dirname(path), { recursive: true });

    const tmpPath = `${path}.tmp`;
    writeFileSync(tmpPath, content, "utf-8");
    renameSync(tmpPath, path);
};
