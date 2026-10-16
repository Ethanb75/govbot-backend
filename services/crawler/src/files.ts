import { createHash } from "node:crypto";

export const createContentHash = (content: Uint8Array | string): string =>
    createHash("sha256").update(content).digest("hex");
