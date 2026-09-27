# Knowledge ingest — status

Original plan below is fully implemented and deployed. This section tracks what actually
shipped, where it deviated from the plan, and what's still open. Keep the original plan
text below for context; update this section as the service changes.

## Current architecture (deviates from the plan)

The plan proposed nesting the worker inside `personal-web-app`'s compose project on the
existing VM. Instead it shipped as its **own top-level service**, following the repo's
standard "one root app dir → one Jenkins entry → one Terraform resource → one inventory →
one playbook" convention (see `ADDING_SERVICES.md`):

```text
knowledge-ingest/                        # repo root, not nested under personal-web-app
├── src/
│   ├── index.ts        # orchestration, state load/save, health check, summary logging
│   ├── documents.ts     # discover .md files, read, sha256 content hash
│   ├── chunk.ts          # gpt-4.1-nano chunking (createChunksFromDocument)
│   ├── embeddings.ts     # text-embedding-3-large via ai-sdk
│   ├── qdrant.ts        # ensureCollectionExists / upsert / delete / stats
│   └── types.ts
├── Dockerfile            # multi-stage: tsc build, then supercronic + tzdata runtime
├── crontab               # 0 3 * * * node /app/dist/index.js
├── compose.yml           # single `knowledge-ingest` service, no ports
├── knowledge-base/       # sample Insurellm docs, local-only (not deployed)
└── app-state/            # gitignored, state.json lives here locally

Deployed to its own Proxmox VM (192.168.1.132):
  Jenkinsfile              → 'knowledge-ingest' service entry (OPENAI_API_KEY from
                             Jenkins credential 'openai-api-key', not from a shared web-app env)
  ansible/inventory/knowledge-ingest.ini
  ansible/playbooks/deploy-knowledge-ingest.yml
```

Qdrant stays external and unmanaged by this service, as planned — `192.168.1.131:6333`,
collection `knowledge`, both required via env with no hardcoded fallback
(`healthCheck()` throws on missing `QDRANT_URL`/`QDRANT_COLLECTION_NAME`/
`OPENAI_API_KEY`/`EMBEDDING_DIMENSIONS`). Collection creation itself lives outside this
repo path, in `personal-web-app/apps/knowledge-assistant/setup_db.ts`.

## What's implemented (matches the plan)

- **Rename**: `injest` → `ingest` done throughout.
- **Split responsibilities**: `documents.ts` / `chunk.ts` / `embeddings.ts` / `qdrant.ts` /
  `index.ts`, per the plan. No separate `state.ts` — state load/save lives directly in
  `index.ts` as a small zod-validated `AppState` (`{ documents: { [relativeSource]:
  { contentHash, lastIndexedAt, chunkIds } } }`).
- **Document-level SHA-256 + incremental skip**: `createContentHash` hashes whole document
  text before chunking; unchanged documents are skipped (`[SKIP] ... - unchanged`).
- **Persistent manifest**: `app-state/state.json`, mounted host → `/data/state`
  (`APP_STATE_BASE_PATH`), knowledge base mounted read-only host → `/data/knowledge-base`
  (`KNOWLEDGE_BASE_PATH`).
- **Checkpointing beyond the plan**: state is saved after *every* successfully processed
  document (`checkpoint()` inside the loop), not only at the end of a run — a crash
  partway through only loses progress on the document in flight, not the whole run.
- **Sequential, one-document-at-a-time processing**: no concurrency in `index.ts`'s main
  loop, exactly as recommended.
- **Stable relative source names**: `toStateKey = relative(KNOWLEDGE_BASE_PATH, source)`;
  chunks are created with the relative key as `source`, so state keys and Qdrant payload
  `source` values survive the container mount path changing.
- **Write-before-delete on update**: new chunks are embedded and upserted first, then the
  diff of stale `chunkIds` (previous minus current) is deleted — a mid-run failure never
  drops a document to zero vectors.
- **Deleted-file sync**: any manifest entry whose file no longer exists on disk is treated
  as an orphan, its Qdrant points are deleted, and the manifest entry is dropped
  (`[DELETE] ...`) — retried on next run if the delete itself fails.
- **Dockerized, TS compiled at build time**: multi-stage Dockerfile, `tsc` in the build
  stage, prod-only `npm ci --omit=dev` in the runtime stage, runs as the non-root `node`
  user. `@qdrant/js-client-rest` is a real dependency now.
- **Supercronic schedule**: `0 3 * * *`, `TZ=America/New_York` set via compose
  `environment`, PID 1 is supercronic so job output lands in `docker logs`.
- **Ansible creates but never overwrites persistent dirs**: `knowledge-base/` (owned by the
  deploy user, so files can be dropped in without sudo) and `app-state/` (owned by uid
  1000, the container's `node` user) are created idempotently and excluded from the
  source copy step.
- **Observable runs**: per-document `[SKIP]/[NEW]/[UPDATE]/[DELETE]/[FAIL]` lines plus a
  padded summary table (discovered/unchanged/new/changed/deleted, vectors
  uploaded/deleted, live collection point count via `getCollectionStats()`, duration).
  Nonzero exit code if anything failed, without blocking the rest of the run.

## Deviations worth flagging

- **Own VM instead of folding into `personal-web-app`**: bigger blast radius than the plan
  assumed (new Terraform/Ansible/Jenkins surface), but matches how every other service in
  this repo is deployed and keeps the OpenAI key scoped to one Jenkins credential instead
  of living in the web app's shared `.env`.
- **Qdrant collection existence is checked, not created**: `ensureCollectionExists()` in
  `qdrant.ts` throws if the collection is missing rather than creating it; collection
  bootstrap is a manual/separate step (`setup_db.ts` under
  `personal-web-app/apps/knowledge-assistant/`, run once against Qdrant directly).

## Open items / not yet done

- **Retrieval/query service** (plan's step 16) hasn't started against this schema.
  `personal-web-app/apps/knowledge-assistant/{answer.ts,cli.ts,setup_db.ts}` is an earlier,
  separate prototype — still references a `personal_knowledge` collection name in its
  design notes (`next.md`) vs. this service's actual `knowledge` collection, so it isn't
  wired up to what `knowledge-ingest` is actually populating yet.
- **Dead code from the old bulk-processing prototype**: `chunk.ts` still exports
  `convertDocumentsToChunks` (with `pLimit`/`CHUNKING_CONCURRENCY = 10`), but `index.ts`
  now calls `createChunksFromDocument` directly per document and never uses the bulk
  helper — worth deleting along with the now-unused `p-limit` dependency.
- **No README** in `knowledge-ingest/` describing env vars, local dev (`npm run dev`),
  manual run (`docker compose run --rm knowledge-ingest node dist/index.js`), or the
  state-file format for someone new to the repo.
- **In-progress, unrelated experiment on this branch**: `src/jev.ts` was deleted and
  `src/jev.experiment.ts` (untracked) added — a `@typesafe-ai/sdk`-based intent-routing
  sketch ("jev"), not imported by `index.ts` and not part of the ingestion pipeline. Looks
  like exploratory work for a future "cheap router in front of the RAG answerer" idea, not
  ready to fold into this service.

## Suggested next steps, in order

1. Delete the unused `convertDocumentsToChunks` / `CHUNKING_CONCURRENCY` / `p-limit` path
   in `chunk.ts` (and the `p-limit` dependency) now that processing is document-at-a-time.
2. Add a short README to `knowledge-ingest/` (env vars, local dev, manual run, state file).
3. Decide `jev.experiment.ts`'s fate — commit it somewhere intentional (e.g. under
   `agent-plans/next/` as a design note, or a dedicated experiment branch) rather than
   leaving a deleted-file/new-file pair uncommitted on `main`.
4. Reconcile the retrieval prototype's collection name/schema with this service's actual
   Qdrant collection (`knowledge`) before building the query/answer service further.

---

## Original plan (as proposed, before implementation)

Your current `injest.ts` already has the core pipeline: recursively load documents, chunk them with `gpt-4.1-nano`, create `text-embedding-3-large` embeddings, and upsert them into Qdrant.  The work now is mostly about turning that prototype into an idempotent batch job.

## Target architecture

```text
personal-web-app VM
│
├── nginx / personal website
├── cloudflared
│
└── knowledge-ingest
      │
      │ daily, e.g. 03:00
      ▼
  /knowledge-base
      │
      ├── scan files
      ├── calculate document SHA-256
      ├── skip unchanged documents
      ├── chunk changed/new documents
      ├── create embeddings
      └── upsert into Qdrant
                         │
                         ▼
                  Qdrant server
                  192.168.1.131:6333
```

I would also fix the naming now: rename **`injest` → `ingest`** everywhere.

### Proposed directory structure

I'd reorganize the existing package into something like:

```text
personal-web-app/
├── compose.yml
├── .env
├── knowledge-base/
│   └── .gitkeep
│
├── apps/
│   └── knowledge-assistant/
│       └── ingest/
│           ├── src/
│           │   ├── index.ts
│           │   ├── documents.ts
│           │   ├── chunk.ts
│           │   ├── embeddings.ts
│           │   ├── qdrant.ts
│           │   ├── state.ts
│           │   └── types.ts
│           ├── package.json
│           ├── package-lock.json
│           ├── tsconfig.json
│           ├── Dockerfile
│           ├── .dockerignore
│           └── crontab
│
└── ...
```

I would **not bake the knowledge base into the Docker image**. Make it a persistent host directory and mount it read-only into the worker:

```text
host:
  /opt/personal-web-app/knowledge-base

container:
  /data/knowledge-base
```

That way you can drop a file into the host directory at any time without rebuilding or redeploying the container.

Your current Compose project only contains `web` and `cloudflared`, so `knowledge-ingest` becomes a third service.

---

## 1. Refactor `injest.ts` into an actual application

Instead of one ~190-line script, split responsibilities.

The entrypoint becomes approximately:

```ts
async function main() {
  const files = await discoverDocuments();

  for (const file of files) {
    await ingestDocument(file);
  }

  await removeDeletedDocuments(files);
}

await main();
```

Then the pieces are separate:

```text
documents.ts
  discover files
  read documents
  calculate document hashes

chunk.ts
  LLM document chunking

embeddings.ts
  OpenAI embedding generation

qdrant.ts
  upsert/delete/query Qdrant

state.ts
  record successful ingestions

index.ts
  orchestrate one complete ingestion run
```

That will also make the later **query service** independent. Both services can eventually share types/utilities without ingestion logic being coupled to retrieval.

---

# 2. Make ingestion incremental

This is the most important change.

Today:

```text
daily run
  ↓
read everything
  ↓
chunk everything
  ↓
embed everything
  ↓
upsert everything
```

Instead:

```text
daily run
  ↓
scan files
  ↓
SHA-256 each file
  ↓
compare against previous successful run
  │
  ├── same hash ──────────► skip
  │
  └── new/changed
         ↓
       chunk
         ↓
       embed
         ↓
       Qdrant upsert
         ↓
       save new hash
```

You already have a SHA-256 helper, but currently it hashes individual chunks **after the expensive LLM chunking call has happened**.

Add a document-level hash:

```ts
documentHash = sha256(document.text)
```

before calling the chunking model.

### State file

For the first version, I'd use a tiny JSON manifest:

```json
{
  "documents": {
    "work/aws-notes.md": {
      "hash": "742e...",
      "lastIngestedAt": "2026-09-18T07:00:00Z",
      "pointIds": [
        "uuid-1",
        "uuid-2",
        "uuid-3"
      ]
    }
  }
}
```

Mount that separately:

```text
/opt/personal-web-app/ingest-state
        ↓
/data/state
```

The important rule is:

> **Never update the manifest until the Qdrant upsert succeeds.**

So a failed run automatically retries that document tomorrow.

I'd still put `documentHash` into every Qdrant payload as useful metadata.

---

# 3. Process one document at a time

I'd change another aspect of the current implementation.

Right now it:

```text
load ALL documents
↓
chunk ALL documents
↓
embed ALL resulting chunks
↓
upload everything
```

The script even loads every file's complete contents into memory before processing.

For a growing knowledge base, use:

```text
document A
  hash
  chunk
  embed
  upload
  save state

document B
  hash
  unchanged → skip

document C
  hash
  chunk
  embed
  upload
  save state
```

This gives you:

* bounded memory usage
* easier retries
* clear logging
* fewer giant embedding batches
* partial progress if one document fails
* less risk from OpenAI rate limits

You could eventually process 2–3 documents concurrently, but I'd start sequentially.

Your current `CHUNKING_CONCURRENCY` is `10`; I wouldn't carry that into version one of the scheduled worker.

---

# 4. Use stable source names

This matters once Docker enters the picture.

Don't store:

```text
/data/knowledge-base/projects/aws.md
```

as the Qdrant source.

Instead store:

```text
projects/aws.md
```

using:

```ts
relative(KNOWLEDGE_BASE_PATH, filename)
```

Otherwise moving the mount from:

```text
./knowledge-base
```

to:

```text
/data/knowledge-base
```

would make the same file look like a completely different document.

I'd make Qdrant payloads roughly:

```ts
{
  document: pageContent,

  source: "projects/aws.md",
  type: "projects",

  documentHash: "...",
  chunkHash: "...",
  chunkIndex: 4,

  ingestedAt: "2026-09-18T07:00:00.000Z"
}
```

---

# 5. Handle changed and deleted files

There are really three cases.

### New file

```text
foo.md
no state entry
→ ingest
→ save point IDs
```

### Changed file

```text
foo.md
old hash != new hash
→ create new chunks
→ create embeddings
→ upsert new points
→ delete old point IDs
→ update state
```

Importantly, I'd **write the new points before deleting the old points**.

That prevents an OpenAI/Qdrant failure from temporarily removing a document from the knowledge base.

### Deleted file

If the manifest contains:

```text
foo.md
```

but the filesystem no longer does:

```text
delete its point IDs from Qdrant
remove manifest entry
```

This gives you true filesystem → vector-store synchronization.

---

# 6. Dockerize the worker

The ingestion package gets its own Dockerfile.

Conceptually:

```dockerfile
FROM node:24-alpine AS build

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build


FROM node:24-alpine

WORKDIR /app

COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY package.json ./

CMD [...]
```

I would **compile the TypeScript at image build time** rather than installing `tsx` and running TypeScript directly in production.

Your package scripts could become:

```json
{
  "scripts": {
    "dev": "tsx src/index.ts",
    "build": "tsc",
    "ingest": "node dist/index.js"
  }
}
```

One dependency issue should also be fixed while doing this: `injest.ts` imports `@qdrant/js-client-rest`, but that package isn't currently listed in the package's dependencies.

---

# 7. Schedule it with Supercronic

Docker Compose itself isn't a scheduler.

For a containerized cron-style worker, I'd use **Supercronic** inside the worker container. It behaves nicely in containers because the scheduler stays PID 1 and job output goes to normal Docker logs.

For example:

```text
0 3 * * * node /app/dist/index.js
```

would run daily at 3 AM.

I'd make the timezone explicit:

```yaml
environment:
  TZ: America/New_York
```

The Compose service would conceptually look like:

```yaml
knowledge-ingest:
  build:
    context: ./apps/knowledge-assistant/ingest

  restart: unless-stopped

  env_file:
    - .env

  environment:
    KNOWLEDGE_BASE_PATH: /data/knowledge-base
    INGEST_STATE_PATH: /data/state/manifest.json
    TZ: America/New_York

  volumes:
    - ./knowledge-base:/data/knowledge-base:ro
    - ./ingest-state:/data/state
```

No ports.

No Cloudflare route.

No HTTP server.

It's simply a scheduled worker.

---

# 8. Keep Qdrant external

I would **not add Qdrant to this Compose project**.

Your current ingestion code is already configured to connect to the Qdrant server at `192.168.1.131:6333`.

Change the configuration so production requires:

```env
QDRANT_URL=http://192.168.1.131:6333
QDRANT_COLLECTION_NAME=knowledge
OPENAI_API_KEY=...
EMBEDDING_DIMENSIONS=3072
```

I'd remove the hard-coded production fallback:

```ts
process.env.QDRANT_URL ?? "http://192.168.1.131:6333"
```

and instead fail immediately:

```text
Missing required environment variable: QDRANT_URL
```

That prevents accidentally sending data to the wrong database later.

---

# 9. Update Ansible deployment

There's one repo-specific issue we definitely need to address.

Your current Ansible deployment only copies:

```text
compose.yml
.env
site/
nginx/
```

to `/opt/personal-web-app`. It does **not** copy anything under `apps/`.

So we'd update the playbook to create:

```text
/opt/personal-web-app/
├── apps/knowledge-assistant/ingest/
├── knowledge-base/
├── ingest-state/
├── site/
├── nginx/
└── compose.yml
```

Then copy:

```text
apps/knowledge-assistant/ingest/
```

to the VM.

But Ansible should merely **create** these:

```text
knowledge-base/
ingest-state/
```

and should **not overwrite their contents** during deployment.

The existing CI/CD setup already redeploys `personal-web-app` whenever something underneath that root application folder changes, so we don't need another Jenkins service or another Proxmox VM for this.

---

# 10. Make the worker observable

A daily service can fail silently for weeks if its logs aren't clear.

I'd have every run finish with something like:

```text
Knowledge ingestion started
Qdrant: http://192.168.1.131:6333
Collection: knowledge

Documents discovered: 37
Unchanged:            34
New:                   2
Changed:               1
Deleted:               0

Documents ingested:    3
Chunks created:       47
Vectors uploaded:     47
Failures:              0

Completed in 18.4s
```

And per-document logging:

```text
[SKIP] aws/vpc.md - unchanged
[NEW] projects/rag.md
       chunks=13 vectors=13
[UPDATE] homelab/proxmox.md
       oldHash=abc...
       newHash=def...
       oldVectors=8
       newVectors=11
```

If **any changed/new document fails**, the process should return a nonzero exit code after finishing the rest.

---

## Suggested implementation order

I would tackle this in this order:

1. **Rename `injest` → `ingest`.**
2. Move it into `apps/knowledge-assistant/ingest/src/`.
3. Split document/chunk/embedding/Qdrant responsibilities.
4. Make paths/config environment-based.
5. Normalize source names relative to the knowledge-base root.
6. Add whole-document SHA-256 detection.
7. Add persistent ingestion manifest.
8. Make processing document-at-a-time.
9. Add changed/deleted document synchronization.
10. Add Dockerfile.
11. Add Supercronic daily schedule.
12. Add `knowledge-ingest` to `personal-web-app/compose.yml`.
13. Update Ansible to deploy the worker code and create persistent directories.
14. Manually run one ingestion.
15. Restart the Compose project and verify the scheduled worker.
16. Then build the **query/retrieval service** against the resulting Qdrant schema.

### First milestone

For the first pass, I'd call it successful when this works:

```bash
echo "# My new knowledge" \
  > /opt/personal-web-app/knowledge-base/test.md
```

Manual test:

```bash
docker compose run --rm knowledge-ingest node dist/index.js
```

produces:

```text
[NEW] test.md
chunks=...
vectors=...
```

Running it again immediately produces:

```text
[SKIP] test.md - unchanged
```

Modify the file:

```text
[UPDATE] test.md
```

Delete it:

```text
[DELETE] test.md
```

and the corresponding Qdrant vectors disappear.

That gives you a solid ingestion layer on which the eventual RAG query service can depend.
</content>
