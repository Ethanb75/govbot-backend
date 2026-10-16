# rag-api

Answers questions about Georgia laws and executive orders from the knowledge base that ingest keeps up to date. Retrieval is a cosine nearest-neighbour search over the `chunks` table in the vectors database (pgvector, see [`db/vectors`](../../db/vectors/migrations/001_chunks.sql)). The executive order tool reads the metadata database.

On AWS it runs as an ECS Fargate service behind an internal ALB, which CloudFront reaches as `/api/*` (CloudFront strips the `/api` prefix). The live homelab deployment still runs from the `homelab` repo's copy of this service, which uses Qdrant; its deploy and log docs live there.

## Endpoints

| Route | |
| --- | --- |
| `POST /v1/rag/chat` | `{ messages, stream }`. With `stream: true` it answers as SSE: `model`, `sources`, `delta`…, `sources` again if the knowledge base tool found more, then `done` (or `error`) |
| `GET /health/live` | process is up |
| `GET /health/ready` | the vectors database answers and has been migrated. The ALB health check. Never calls OpenAI |

## Running locally

```bash
# at the repo root: install and build packages/shared
npm install && npm run build

# local databases (pgvector), see compose.dev.yml for the connection strings
docker compose -f compose.dev.yml up -d

cp services/rag-api/.env.example services/rag-api/.env   # then fill it in
npm run dev -w services/rag-api
```

## Configuration

Validated with zod at startup (`src/config.ts`); see `.env.example` for every variable. The ones that change between environments:

| Env var | |
| --- | --- |
| `OPENAI_API_KEY` | required |
| `VECTORS_DATABASE_URL` | required. `vectors_app` (read-only) connection string |
| `GOVBOT_DATABASE_URL` | optional. `govbot_app` connection string; without it the executive order tool is turned off |
| `EMBEDDING_MODEL`, `EMBEDDING_DIMENSIONS` | shared with ingest through `packages/shared`; must match what the chunks were embedded with |
| `TRUST_PROXY_HOPS` | `2` behind CloudFront → ALB, `0` locally. The rate limit keys on the client IP that many hops back in `X-Forwarded-For` |
| `LOG_LEVEL` | `info` by default. `debug` also logs questions, answers and tool calls, so keep it off in production |

## Evals

`npm run test:retrieval` and `npm run test:answers` run against whatever `VECTORS_DATABASE_URL` points at and write `__tests__/*/current-results.json`. The husky pre-commit hook runs both on `main` when `src/` changes, so committing there needs a populated vectors database.
