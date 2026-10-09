# Plan: `searchKnowledgeBase` tool for rag-api

## Context
`streamAnswer` (`rag-api/src/rag/answer.ts`) does one upfront rewrite → retrieve → rerank and stuffs the top `FINAL_K` chunks into the system prompt. If those extracts miss (follow-up on a different angle, a specific order number/code section the rewrite didn't surface, multi-part questions), the model has no way to look again — it can only say "not covered". There's already a `// rag lookup should be another tool` note in `streamAnswer`.

Goal: expose the same Qdrant retrieval + rerank as an AI SDK tool the answer model can call (alongside `searchExecutiveOrders`) to run its own queries. **Hybrid** (decided): the upfront fetch stays, so latency, `/v1/search` and the evals are unchanged; the tool covers extra lookups. Tool results are **reranked** (decided).

## Changes

### 1. New tool — `rag-api/src/rag/tools/knowledge-base/search.ts`
A per-request factory (it needs request state, unlike the static `searchExecutiveOrders`):

```ts
export const createSearchKnowledgeBase = (provided: RetrievedChunk[]) => {
    const seen = new Set(provided.map(chunk => chunk.id));
    const found: RetrievedChunk[] = [];
    const searchKnowledgeBase = tool({ description, inputSchema, execute });
    return { searchKnowledgeBase, found };
};
```

- `inputSchema`: `{ query: z.string().min(1).describe("Short, specific standalone search query ...") }`.
- `execute({ query })`:
  - `retrieve(query)` → `rerank(query, chunks)` (reuse `src/rag/retrieve.ts`, `src/rag/rerank.ts` directly; no rewrite — the model already has the history and writes a standalone query).
  - Drop chunks whose id is in `seen` (already in the system prompt or a prior tool call), take top `config.TOOL_K`, add their ids to `seen` and push them to `found`.
  - Return `{ extracts: [{ source, content }], alreadyProvided: <count dropped> }` — same "source + text" shape the prompt uses, no scores/hashes to save tokens.
  - Fail soft in `try/catch` like `meta-db.ts`: `console.error` + `{ error: "knowledge base search unavailable" }`.
- Description: search the Georgia laws / executive orders knowledge base by meaning; use when the extracts in the system prompt don't cover the question or a different angle/identifier is needed; content already provided is not returned again.

### 2. Config — `rag-api/src/config.ts`
Add `TOOL_K: z.coerce.number().int().positive().default(5)` next to `RETRIEVAL_K`/`FINAL_K` (keeps each tool result ~half the size of the upfront context).

### 3. Wire into `streamAnswer` — `rag-api/src/rag/answer.ts`
- After `fetchContext`, `const { searchKnowledgeBase, found } = createSearchKnowledgeBase(chunks);`
- `tools: { searchKnowledgeBase, ...(dbEnabled() ? { searchExecutiveOrders } : {}) }` — tools are now always passed.
- `stopWhen: isStepCount(4)` (KB search → EO search → answer, plus one retry); update the comment.
- `onStepEnd`: truncate logged tool output (e.g. `.slice(0, 500)`) so KB extracts don't flood the logs.
- Return `toolChunks: found` alongside `chunks` (filled in as the stream runs; complete once `textStream` is drained).
- Remove the `// rag lookup should be another tool` comment.

### 4. Prompt — `rag-api/src/rag/prompts.ts`
Change `buildSystemPrompt(context, toolsEnabled)` to `buildSystemPrompt(context, executiveOrdersEnabled)` (and `buildContext` accordingly), since tools are now always on:
- `sources` always reads "the extracts below or the results of your tools".
- Always add KB guidance: "If the extracts don't fully cover the question, call searchKnowledgeBase with a short, specific query (a different angle, an order number, a code section) before saying the information isn't available. Don't search for what the extracts already answer."
- Keep the existing `searchExecutiveOrders` guidance behind the flag. Update the line-1 comment.

### 5. Sources — `rag-api/src/routes/rag-chat.ts`
- Non-stream: build `sources` after the text loop from `[...chunks, ...toolChunks]`.
- Stream: keep the upfront `sources` event; after the delta loop, if `toolChunks.length`, write a second `sources` event with the merged list before `done`. The frontend (`personal-web-app/src/components/pages/gov-chat-page.ts` `handleEvent`) already replaces `sources` on each event, so no FE change. (It shows the first 4 unique names; upfront chunks rank first, which is fine.)

### 6. Housekeeping
- `rag-api/TODOS.txt`: note knowledge-base search tool added under "add tools to lookup data".

Untouched: `fetchContext`, `/v1/search`, `__tests__/eval.test.ts`, deploy config (no new env vars required; `TOOL_K` has a default).

## Verification
1. `cd rag-api && npm run build` — type-checks the tool factory, new return shape, and route changes.
2. `npm run dev` (plain tsx, no Docker) with the existing `.env`, then:
   - `curl -N -X POST localhost:8090/v1/rag/chat -H 'content-type: application/json' -d '{"messages":[...],"stream":true}'` with a multi-part question or a follow-up the first extracts won't cover → logs show `tool call: searchKnowledgeBase {...}`, stream contains a second `sources` event.
   - A simple question answered by the upfront extracts → no tool call, single `sources` event (behaviour unchanged).
   - Same with `"stream": false` → `sources` includes tool chunks.
3. `npm test` (evals over `fetchContext`) — should be unchanged.
