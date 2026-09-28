# Plan: add a `rag-api` service to the homelab

## Context
`knowledge-ingest` now keeps the Qdrant `knowledge` collection (on vector-db, 192.168.1.131) up to date every day. Nothing serves answers from it yet. The only query code is the CLI prototype in `personal-web-app/apps/knowledge-assistant/answer.ts`, which does rewrite → dual retrieve → merge → rerank → answer. The goal is a small, private HTTP service that runs this pipeline, deploys through the same Terraform → Ansible → Jenkins flow as the other services, and can be reached through the personal site's nginx so a chatbot front end can be built on it later.

Scope for v1, as you chose: `/health/live`, `/health/ready`, `/v1/search` and a streaming `/v1/rag/chat`, plus an nginx `/api/` proxy on personal-web-app. Out of scope for now: the OpenAI-compatible `/v1/chat/completions` and `/v1/models`, the Jenkins `watchPaths` refactor, the chat UI and the eval fixtures.

## Placement
- New VM **9150 `rag-api` at 192.168.1.133** on `pve-dell-laptop`, next to personal-web-app (.128) and knowledge-ingest (.132). It gets 1 core and 1 GB RAM because no inference runs locally. Before applying, confirm that .133 is free.
- The service listens on **port 8090**. Qdrant and the OpenAI key stay private, and the browser reaches the API only through `personal-web-app` nginx.

## Step 1: Scaffold `rag-api/` by mirroring `knowledge-ingest`
Copy the conventions from `knowledge-ingest/` exactly:
- `package.json`: ESM with the same versions of `ai`, `@ai-sdk/openai`, `@qdrant/js-client-rest`, `zod` and `dotenv`. Add `fastify`. Dev dependencies are `typescript`, `tsx` and `@types/node`. Scripts are `dev` (tsx), `build` (tsc) and `start` (node dist/server.js).
- `tsconfig.json`: an exact copy of `knowledge-ingest/tsconfig.json`, with nodenext resolution and `.js` import extensions.
- `Dockerfile`: the same two-stage Node 24 alpine build as `knowledge-ingest/Dockerfile`, with supercronic and the crontab removed. It uses `USER node`, `EXPOSE 8090` and `CMD ["node","dist/server.js"]`.
- `.dockerignore` and `.gitignore` copied from knowledge-ingest.
- `compose.yml` with a single `rag-api` service, `ports: "8090:8090"` and `restart: unless-stopped`. It takes `OPENAI_API_KEY=${OPENAI_API_KEY}` and sets `QDRANT_URL=http://192.168.1.131:6333`, `QDRANT_COLLECTION_NAME=knowledge`, `EMBEDDING_DIMENSIONS=3072`, `PORT=8090` and `DOTENV_CONFIG_QUIET=true`. Model names are also env vars, defaulting to `gpt-4.1-nano`.

## Step 2: Move the prototype into modules
Port `personal-web-app/apps/knowledge-assistant/answer.ts` into these files:
```
rag-api/src/
  server.ts          Fastify bootstrap and route registration
  config.ts          env parsing with zod; fail fast on a missing key or collection
  qdrant.ts          QdrantClient plus a collectionExists() check for readiness
  embeddings.ts      embedQuery(): single-value version of knowledge-ingest/src/embeddings.ts
  rag/types.ts       Message, RetrievedChunk (id, score, pageContent, metadata)
  rag/prompts.ts     SYSTEM_PROMPT, rewrite prompt, rerank prompt (moved verbatim)
  rag/rewrite.ts     rewriteQuery()
  rag/retrieve.ts    retrieve(query) -> RetrievedChunk[]
  rag/rerank.ts      rerank()
  rag/answer.ts      buildContext() + streamAnswer() orchestration; no HTTP code
  routes/health.ts, routes/search.ts, routes/rag-chat.ts
```
The RAG algorithm stays the same. Only these fixes go in during the move:
- Serialize `history` into readable `role: content` lines before it goes into the rewrite prompt. The prototype interpolates the raw array.
- Skip the rewrite when there is no history, and use the original question instead.
- Run the two retrievals in parallel with `Promise.all`.
- Keep the Qdrant point `id` and `score`, and dedupe by `id` rather than by content string.
- Validate the reranker output: drop IDs that are out of range or repeated, then append any chunks it left out. Take the top `FINAL_K` with `slice`, not `splice`.
- Replace the final `generateText` with `streamText`.

The chunk payload shape (`document`, `source`, `type`, `contentHash`) must match what `knowledge-ingest/src/qdrant.ts` `upsertChunks` writes.

## Step 3: Routes
- `GET /health/live` returns `{ status: "ok" }`.
- `GET /health/ready` checks that config loaded and that Qdrant has the collection. It returns 503 if not. It never calls OpenAI.
- `POST /v1/search` takes `{ query, history? }` and returns `{ rewrittenQuery, results: [{ id, source, score, content }] }`. This runs retrieval and rerank without generation and is used for debugging.
- `POST /v1/rag/chat` takes `{ messages: [{role, content}], stream?: boolean }`, validated with zod. The last user message is the question and everything before it is history. Cap the message count and length.
  - When `stream` is true, it returns SSE (`text/event-stream`). The events are one `sources` event with `[{source, contentHash, score}]`, then `delta` events with `{text}`, then `done`. Send `X-Accel-Buffering: no`.
  - When `stream` is false, it returns `{ answer, sources }` as JSON.

## Step 4: Infrastructure, following the `knowledge-ingest` pattern
- `terraform/rag-api.tf`: a copy of `terraform/knowledge-ingest.tf` with name `rag-api`, `vm_id 9150`, address `192.168.1.133/24` and tags updated.
- `ansible/inventory/rag-api.ini` with a `[rag_api]` group at `192.168.1.133` and `ansible_user=deployer`.
- `ansible/playbooks/deploy-rag-api.yml`: a copy of `deploy-knowledge-ingest.yml` with the knowledge-base and state directory tasks removed. It copies `src/`, `package*.json`, `tsconfig.json`, `Dockerfile`, `.dockerignore` and `compose.yml`, and copies `.env` with mode `0600` and `no_log: true`. It then runs `docker_compose_v2` with `build: always` and `wait: true`.
- `Jenkinsfile` gets a new `'rag-api'` entry. It uses inventory, group and playbook as above, `ip: '192.168.1.133'`, `port: '8090'`, `expected: 'ok'`, `rootFolderName: 'rag-api'`, and `env: [[credentialId: 'openai-api-key', varName: 'OPENAI_API_KEY']]`, which reuses the existing credential. `healthCheck()` currently curls `/` only, so add an optional `healthPath` field that is appended to the URL, and set it to `/health/ready`.
- Update `ADDING_SERVICES.md` and `README.md` to list the new VM and IP.

## Step 5: Proxy through personal-web-app nginx
In `personal-web-app/nginx/default.conf`, add this block above `location /`:
```nginx
location /api/ {
    proxy_pass http://192.168.1.133:8090/;   # strips /api
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_buffering off;
    proxy_read_timeout 120s;
}
```
The browser then calls `/api/v1/rag/chat` on the same origin, which avoids CORS.

Because this makes the endpoint public, `rag-api` also needs basic protection against a runaway OpenAI bill:
- Add `@fastify/rate-limit`, per IP, reading `X-Forwarded-For` with `trustProxy` limited to the web app IP.
- Cap the request body size.

## Verification
1. Run locally from `rag-api/` against the LAN Qdrant with a local `.env`: `npm run dev`, then:
   - `curl localhost:8090/health/ready` should return 200.
   - `curl -XPOST localhost:8090/v1/search -H 'content-type: application/json' -d '{"query":"Who founded Insurellm?"}'` should return ranked chunks with sources.
   - `curl -N -XPOST localhost:8090/v1/rag/chat -d '{"messages":[{"role":"user","content":"What does Carllm do?"}],"stream":true}' -H 'content-type: application/json'` should show a `sources` event, then deltas as they arrive.
   - Send a follow-up question with history and confirm that the rewritten query in `/v1/search` makes sense.
2. Run `npm run build` and `docker compose up --build` locally, then repeat the curls.
3. Run `terraform fmt -check && terraform validate` and `ansible-playbook --syntax-check ansible/playbooks/deploy-rag-api.yml`.
4. After the Jenkins deploy, confirm the stage shows `Health Check - rag-api` passing, and that `curl http://192.168.1.133:8090/health/ready` works from the LAN.
5. After the personal-web-app deploy, `curl -N https://<site>/api/v1/rag/chat ...` should stream tokens progressively, which confirms nginx buffering is off.
