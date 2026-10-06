# Show the answer model in Gov Chat

## Context
The Gov Chat page (`personal-web-app`) doesn't show which LLM wrote each answer. Its "more" blurb hardcodes `gpt-4.1-nano`, but rag-api's `ANSWER_MODEL` now defaults to `gpt-5.4-mini`, so the page is already wrong. Fix: rag-api sends the model as the first SSE event of each response. The FE then shows it in small, light text above the answer, so it always matches what the server actually used.

## rag-api

**`rag-api/src/rag/answer.ts`**: `streamAnswer` also returns `model: config.ANSWER_MODEL`. The model then comes from the same place that calls `streamText`, and the route doesn't need to import config.

**`rag-api/src/routes/rag-chat.ts`**:
- Destructure `model` from `streamAnswer(...)`.
- Streaming path: right after `reply.raw.writeHead(...)`, before the `sources` event, write `sseEvent("model", { model })` using the existing `sseEvent` helper. New event order: `model` → `sources` → `delta`* → `done` | `error`.
- Non-streaming path: return `{ answer, sources, model }` so both modes match.

Timing: the headers only go out after retrieval and rerank finish, and that order is intentional because a retrieval failure still gets a normal HTTP error status. So the `model` event arrives together with `sources`, a moment before the first delta. The existing `...` placeholder covers the wait, so nothing about it needs to change.

## personal-web-app

**`personal-web-app/src/components/pages/gov-chat-page.ts`**:
- `Turn` gets `model?: string`.
- `handleEvent`: add `case 'model': this.updateLastTurn({ model: payload.model }); return false`.
- `renderTurn`: between the `> 🤖:` label and `<p class="answer">`, render `${turn.model ? html`<span class="model">${turn.model}</span>` : null}`.
- Styles: add `.model { display: block; font-size: 0.8rem; color: #AF9085; opacity: 0.8; }`. This reuses the muted color already used by `.details` and `.sources`, with a smaller size and lower opacity than both. Small tweaks to the exact size or opacity are fine during implementation.
- Details blurb: replace the hardcoded "gpt-4.1-nano" with model-neutral wording, e.g. "…to support chat completion with an OpenAI model (shown above each answer)". That way it can't go stale again.

Other consumers of the SSE stream: only this page, checked with grep. The client ignores unknown event names (`default: return false`), so an old FE paired with a new API still works, and vice versa.

## Verification
1. `cd rag-api && npm run build`: typecheck.
2. `npm run dev`, then `curl -N -XPOST localhost:8090/v1/rag/chat -H 'content-type: application/json' -d '{"messages":[{"role":"user","content":"What executive orders were issued about hurricanes?"}],"stream":true}'`. The first event should be `event: model` with `{"model":"gpt-5.4-mini"}` (or whatever `ANSWER_MODEL` is set to), then `sources`, deltas and `done`. Repeat with `"stream":false` and confirm the JSON has a `model` field.
3. `cd personal-web-app && npm run build`, then the dev server with `/api` pointed at the local rag-api. Ask a question and check that the model name appears in small, faded text under `> 🤖:` and above the streamed answer. Also check that it appears again on a second turn, that "New chat" clears it, and that the "more" blurb no longer names a specific model.
