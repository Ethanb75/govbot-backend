# Plan: Clef intent check in the RAG chat route

## Context
Every chat message currently goes straight into the full rewrite → retrieve → rerank → answer pipeline (`streamAnswer` in `rag-api/src/rag/answer.ts`). The goal (TODOS.txt: "add decision model to determine intent") is to have Cloudflare's `@cf/cloudflare/clef` model classify the user's message first, so later we can skip RAG for small talk / off-topic questions. For this step we only call Clef via the Workers AI REST API and `console.log` its response — chat behavior stays the same.

## Changes

### 1. `rag-api/src/config.ts` — add Cloudflare settings
Add to the zod `Config`:
- `CLOUDFLARE_WORKER_API_KEY: z.string().optional()`
- `CLOUDFLARE_WORKER_ACCOUNT_ID: z.string().optional()`
- `INTENT_MODEL: z.string().default("@cf/cloudflare/clef")`

They're optional because prod only gets `OPENAI_API_KEY` from Jenkins (`Jenkinsfile:73`, `rag-api/compose.yml`). Making them required would make the deployed service fail at startup. If they're unset, the intent call is skipped.

Also add commented entries to `rag-api/.env.example` under the optional section.

### 2. `rag-api/src/rag/prompts.ts` — intent system prompt
Add `INTENT_SYSTEM_PROMPT`, written in the same style as the existing prompts (Georgia laws / executive orders assistant). It asks Clef to put the latest user message into one of these labels and reply only with JSON `{"intent": "...", "reason": "..."}`:
- `knowledge_base`: a question about Georgia laws or executive orders that needs retrieval
- `conversational`: greetings, thanks, or small talk
- `off_topic`: anything else

### 3. `rag-api/src/rag/cfWorkers.ts` — replace the example with a REST client
**Remove the commented curl. It contains a live API token and the account id in plain text.** The file is untracked, so the token hasn't been committed yet, but I'd still rotate it.

Implement:
```ts
export const runWorkersAi = async (model, messages, abortSignal?) => {
  // POST https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/ai/run/${model}
  // headers: Authorization: Bearer ${API_KEY}, Content-Type: application/json
  // body: { messages }
  // throws on !res.ok; returns parsed JSON
};

export const detectIntent = async (question, history, abortSignal?) =>
  runWorkersAi(config.INTENT_MODEL, [
    { role: "system", content: INTENT_SYSTEM_PROMPT },
    ...history,
    { role: "user", content: question },
  ], abortSignal);
```
- Uses Node 22's built-in `fetch`, so there are no new dependencies.
- It returns the raw response body (Workers AI envelope `{ result, success, errors, messages }`). It doesn't parse the label yet, because for now we only log it.
- It uses the existing `Message` type from `rag/types.ts`.

### 4. `rag-api/src/routes/rag-chat.ts` — call Clef where the `// call clef to determine intent` comment is
- If both CF config values are set, start `detectIntent(question, history, abort.signal)` **without awaiting it** before `streamAnswer`:
  `.then(res => console.log("clef intent: ", JSON.stringify(res, null, 2)))`
  `.catch(err => request.log.warn({ err }, "clef intent failed"))`
- Not awaiting means it adds no latency, and a Clef failure can't break the chat. When we later act on the intent, this becomes an `await` that gates `streamAnswer`.

## Not in scope (follow-up)
- Acting on the intent (skipping RAG or answering directly).
- Deployment wiring: add a Jenkins credential to the `rag-api` `env` list in `Jenkinsfile`, plus the account id to `compose.yml`.

## Verification
1. `cd rag-api && npx tsc --noEmit` (type check).
2. `npm run dev`, then:
   ```
   curl -N localhost:8090/v1/rag/chat -H 'Content-Type: application/json' \
     -d '{"messages":[{"role":"user","content":"hi there!"}],"stream":false}'
   ```
   and a second request with a real question (e.g. "Is there an executive order about the winter storm?").
3. Check that the server console prints `clef intent:` with the Workers AI JSON, that the labels look sensible for both requests, and that the chat answer still comes back normally.
4. Unset `CLOUDFLARE_WORKER_API_KEY`, restart, and confirm the chat still works with no Clef call.
