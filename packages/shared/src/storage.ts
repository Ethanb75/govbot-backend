import { constants } from "node:fs";
import { access, mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import {
    GetObjectCommand,
    HeadObjectCommand,
    ListObjectsV2Command,
    paginateListObjectsV2,
    PutObjectCommand,
    S3Client,
} from "@aws-sdk/client-s3";

// A flat key space of text files under one root: a local directory, or a bucket prefix. Keys are
// always '/'-separated and relative to the root (e.g. "georgia/executive-orders/01.05.24.01.md"),
// so they read the same whichever backend wrote them.
export interface Storage {
    // for logs: the directory or s3:// URI
    location: string;
    // every key under the root, recursively
    list: () => Promise<string[]>;
    // undefined when the key doesn't exist
    read: (key: string) => Promise<string | undefined>;
    // Readers never see a partial file: locally it's written to a .tmp sibling and renamed into
    // place, and an S3 PutObject only becomes visible once complete.
    write: (key: string, content: string) => Promise<void>;
    exists: (key: string) => Promise<boolean>;
    // Fails fast on a bad location. "read" needs the root to already exist, so a typo can't look
    // like an empty knowledge base; "write" creates a local root.
    check: (mode: "read" | "write") => Promise<void>;
}

const isMissing = (error: unknown): boolean =>
    error instanceof Error && ["NoSuchKey", "NotFound", "ENOENT"].includes((error as { code?: string }).code ?? error.name);

const localStorage = (root: string): Storage => {
    const path = (key: string): string => join(root, ...key.split("/"));

    const walk = async (dir: string): Promise<string[]> => {
        const keys: string[] = [];
        for (const entry of await readdir(dir, { withFileTypes: true })) {
            const entryPath = join(dir, entry.name);
            if (entry.isDirectory()) keys.push(...(await walk(entryPath)));
            else if (entry.isFile()) keys.push(relative(root, entryPath).split(sep).join("/"));
        }
        return keys;
    };

    return {
        location: root,

        list: () => walk(root),

        read: async key => {
            try {
                return await readFile(path(key), "utf-8");
            } catch (error) {
                if (isMissing(error)) return undefined;
                throw error;
            }
        },

        write: async (key, content) => {
            const target = path(key);
            await mkdir(dirname(target), { recursive: true });
            await writeFile(`${target}.tmp`, content, "utf-8");
            await rename(`${target}.tmp`, target);
        },

        exists: async key => {
            try {
                return (await stat(path(key))).isFile();
            } catch (error) {
                if (isMissing(error)) return false;
                throw error;
            }
        },

        check: async mode => {
            if (mode === "write") {
                await mkdir(root, { recursive: true });
                await access(root, constants.W_OK);
            } else if (!(await stat(root).catch(() => undefined))?.isDirectory()) {
                throw new Error(`${root} is not a directory`);
            }
        },
    };
};

const s3Storage = (uri: string): Storage => {
    const { host: bucket, pathname } = new URL(uri);
    const prefix = pathname.replace(/^\/+|\/+$/g, "");
    const objectKey = (key: string): string => (prefix ? `${prefix}/${key}` : key);
    const listPrefix = prefix ? `${prefix}/` : "";

    // region and credentials come from the environment (AWS_REGION and the task role on Fargate,
    // your profile locally); AWS_ENDPOINT_URL_S3 points it somewhere else for testing
    const client = new S3Client({});

    return {
        location: uri,

        list: async () => {
            const keys: string[] = [];
            for await (const page of paginateListObjectsV2({ client }, { Bucket: bucket, Prefix: listPrefix })) {
                for (const { Key } of page.Contents ?? []) {
                    // skip "folder" placeholder objects some tools create
                    if (Key && !Key.endsWith("/")) keys.push(Key.slice(listPrefix.length));
                }
            }
            return keys;
        },

        read: async key => {
            try {
                const { Body } = await client.send(new GetObjectCommand({ Bucket: bucket, Key: objectKey(key) }));
                return await Body?.transformToString("utf-8");
            } catch (error) {
                if (isMissing(error)) return undefined;
                throw error;
            }
        },

        write: async (key, content) => {
            await client.send(
                new PutObjectCommand({
                    Bucket: bucket,
                    Key: objectKey(key),
                    Body: content,
                    ContentType: key.endsWith(".json") ? "application/json" : "text/markdown; charset=utf-8",
                }),
            );
        },

        exists: async key => {
            try {
                await client.send(new HeadObjectCommand({ Bucket: bucket, Key: objectKey(key) }));
                return true;
            } catch (error) {
                if (isMissing(error)) return false;
                throw error;
            }
        },

        // proves the bucket exists and the credentials can list it; writes are only proven by writing
        check: async () => {
            await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: listPrefix, MaxKeys: 1 }));
        },
    };
};

// "s3://bucket/prefix" selects S3, anything else is a local directory.
export const createStorage = (location: string): Storage =>
    location.startsWith("s3://") ? s3Storage(location) : localStorage(location);
