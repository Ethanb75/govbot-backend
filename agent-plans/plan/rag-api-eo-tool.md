# Plan: `searchExecutiveOrders` tool for rag-api

## Context
The rag-api only answers from Qdrant chunks, so it can't handle structured questions like "list the EOs signed in March 2024", "how many orders were issued in 2025", or "what is 01.05.24.01 titled". The new `govbot-postgres-db` (192.168.1.134, `executive_orders` table, read-only `govbot_app` role that may connect only from rag-api at .133) is now the source of truth for that metadata. This change adds the first tool: one simple, parameterized query over `executive_orders`, passed to `streamText` so the answer model can call it when it needs to.

## Approach

### 1. Dependency + config
- `npm i pg` and `npm i -D @types/pg` in `rag-api/`.
- `rag-api/src/config.ts`: add `GOVBOT_DATABASE_URL: z.string().optional()`. It's optional like the Workers AI keys, so local dev and the evals still start without it.

### 2. DB client — new `rag-api/src/db.ts`
- Create a lazy `pg.Pool` (`max: 5`, `statement_timeout: 5000`, `connectionTimeoutMillis: 3000`), built only when `GOVBOT_DATABASE_URL` is set.
- Export `dbEnabled()` (same pattern as `workersAiEnabled()` in `src/rag/cf/workers.ts`) and `pool`.

### 3. Tool — new `rag-api/src/rag/tools/executive-orders.ts`
`searchExecutiveOrders = tool({ description, inputSchema, execute })` from `ai`:
- **inputSchema (zod):** all fields optional.
  - `eoNumber` (exact match, e.g. `01.05.24.01`)
  - `titleContains` (`ILIKE`)
  - `signedAfter` / `signedBefore` (ISO dates, inclusive)
  - `limit` (1–25, default 10)
- **SQL:** one fixed statement with parameters only, and no SQL from the model:
  ```sql
  SELECT eo_number, title, issued_by, signing_date, document_url,
         COUNT(*) OVER () AS total
  FROM executive_orders
  WHERE qdrant_status = 'indexed'
    AND ($1::text IS NULL OR eo_number = $1)
    AND ($2::text IS NULL OR title ILIKE '%' || $2 || '%')
    AND ($3::date IS NULL OR signing_date >= $3)
    AND ($4::date IS NULL OR signing_date <= $4)
  ORDER BY signing_date DESC NULLS LAST
  LIMIT $5
  ```
  `COUNT(*) OVER ()` returns the total match count even when the rows are limited, so "how many…" questions work with the same tool. Filtering to `indexed` follows the metadata plan's rule that GovBot only claims orders that are actually searchable.
- **Returns** `{ total, orders: [...] }`, with dates as `YYYY-MM-DD` strings.
- **Fail soft:** catch errors, log them, and return `{ error: "executive order database unavailable" }` so the model says so instead of the chat failing.
- Escape `%`/`_` in `titleContains` before the `ILIKE`.

### 4. Wire into `streamText` — `rag-api/src/rag/answer.ts`
```ts
const result = streamText({
    model: openai(config.ANSWER_MODEL),
    system: buildContext(chunks),
    messages: [...history, { role: "user", content: question }],
    tools: dbEnabled() ? { searchExecutiveOrders } : undefined,
    stopWhen: isStepCount(3),   // tool call -> answer, with headroom for one retry
    onStepFinish: step => { /* console.log tool calls + results, same as the existing debug logs */ },
    abortSignal,
});
```
- `result.textStream` already concatenates text across steps, so `routes/rag-chat.ts` (SSE and non-stream paths) needs no change.
- RAG retrieval still runs first, as it does today. The tool adds to it and doesn't replace it.

### 5. Prompt — `rag-api/src/rag/prompts.ts`
In `buildSystemPrompt`:
- Change "Answer only from the extracts below" to "Answer only from the extracts below or results from your tools".
- Add one line: use `searchExecutiveOrders` for listing, counting, date-range, or exact order-number lookups, and say how many results there are when `total` is greater than the number of rows shown.

### 6. Deployment wiring
- `rag-api/compose.yml`: add
  `- GOVBOT_DATABASE_URL=postgresql://govbot_app:${GOVBOT_APP_PASSWORD}@192.168.1.134:5432/govbot`
- `Jenkinsfile` `rag-api.env`: add `[credentialId: 'govbot-postgres-app-password', varName: 'GOVBOT_APP_PASSWORD']`. This reuses the existing credential, so there's no new secret. The password is alphanumeric per the DB README, so it's safe in a URL.
- `rag-api/TODOS.txt`: mark "add tools to lookup data" as started.

## Files
- modify: `rag-api/package.json`, `rag-api/src/config.ts`, `rag-api/src/rag/answer.ts`, `rag-api/src/rag/prompts.ts`, `rag-api/compose.yml`, `Jenkinsfile`
- new: `rag-api/src/db.ts`, `rag-api/src/rag/tools/executive-orders.ts`

## Verification
1. `npm run build` in `rag-api/` type-checks the tool and `streamText` options.
2. Locally, without `GOVBOT_DATABASE_URL`: `npm run dev` and send a `/v1/rag/chat` request. It should behave exactly as it does today, with no tools passed.
3. Seed a test row: the table is empty until the crawler is connected. As admin on the DB VM (`docker exec … psql -U govbot_db_admin`), insert one `qdrant_status='indexed'` row, which needs `qdrant_indexed_at` and `qdrant_chunk_count`. Later, delete it with `WHERE source='acceptance-test'`.
4. After deploy (Jenkins → .133): `curl -N -X POST http://192.168.1.133:8090/v1/rag/chat -d '{"messages":[{"role":"user","content":"How many executive orders were signed in 2024?"}],"stream":true}'`. Check that the container logs show a `searchExecutiveOrders` call with `signedAfter/signedBefore`, and that the answer uses `total`.
5. Fail-soft check: point the URL at a bad host and confirm the chat still answers from RAG and mentions that the database is unavailable.
6. `npm test` (the evals) shouldn't regress.
