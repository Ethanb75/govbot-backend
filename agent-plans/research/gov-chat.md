# Plan: Gov Chat page at `/projects/gov-chat`

## Context
rag-api is live on 192.168.1.133:8090. personal-web-app's nginx already proxies `/api/` to it, with buffering off so SSE works (`personal-web-app/nginx/default.conf`), so the browser can call `/api/v1/rag/chat` on the same origin. What's missing is a front end. The goal is one simple page: type a question and get a streamed answer with its sources. It keeps no chat history, so each request sends only the current question.

## Changes

### 1. New page `personal-web-app/src/components/pages/gov-chat-page.ts`
This is a Lit element `gov-chat-page` that follows the same pattern as `contact-page.ts`: `static styles = [PageStyles, GovChatPageStyles, AtomsStyles]` and `customElements.define` at the bottom, with a `HTMLElementTagNameMap` declaration.

- **State** (`@state` from `lit/decorators.js`, or `static properties`, following the existing `@property` import style from `@lit/reactive-element/decorators/...`):
  - `turns: { question: string; answer: string; sources: Source[]; error?: string }[]` lists the Q/A pairs shown on the page. It lives only in memory and is never sent back to the API.
  - `pending: boolean`
- **UI:**
  - An `<h1>Gov Chat</h1>` heading with a short blurb.
  - The list of turns. Each question is labelled `> you`. Each answer is shown with `white-space: pre-wrap` and no markdown rendering, and a small list of source filenames sits underneath it.
  - A `<form>` with a `<textarea maxlength=4000>`, where 4000 matches `MAX_MESSAGE_LENGTH` in `rag-api/src/routes/schemas.ts`. Enter submits and Shift+Enter adds a new line. The Send button is disabled while a request is pending.
- **Request:** `fetch('/api/v1/rag/chat', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ messages: [{ role: 'user', content }], stream: true }), signal })`.
- **SSE parsing:** `EventSource` can't send a POST, so the page reads `res.body` with a `TextDecoderStream` reader instead. It buffers the text, splits on `\n\n`, and parses each block's `event:` and `data:` lines. Event names match `rag-api/src/routes/rag-chat.ts`:
  - `sources` sets `turn.sources`.
  - `delta` appends `data.text` to `turn.answer`.
  - `done` finishes the turn.
  - `error` sets `turn.error`.
  - After each change it reassigns `this.turns = [...]` (or calls `requestUpdate()`) so Lit re-renders.
- **Non-OK responses** come back before any streaming starts. The page reads the JSON body and shows a friendly error:
  - 429: "Too many requests, try again in a minute"
  - 400: shows `issues[0].message`
  - anything else: "Something went wrong"
- **Cleanup:** an `AbortController` is kept on the element and aborted in `disconnectedCallback`. When someone navigates away mid-answer, rag-api sees the connection close and stops spending tokens.
- **Sources display:** the page shows `basename(source)` and removes duplicates, because several chunks can come from the same file.

### 2. Route and nav in `personal-web-app/src/components/main.ts`
- Add `import './pages/gov-chat-page'`.
- Add `case '/projects/gov-chat': return html\`<gov-chat-page></gov-chat-page>\`` to `renderPage()`.
- Add `<li><app-link href="/projects/gov-chat" nav>Gov Chat</app-link></li>` to the nav and a matching footer link without `nav`. `app-link` already handles the active state and the pixel transition.
- Direct loads and refreshes on `/projects/gov-chat` already work: nginx's `try_files ... /index.html` covers them, and all assets use absolute paths.

### 3. Dev proxy in `personal-web-app/vite.config.js`
Add the following so `npm run dev` hits the real API the same way nginx does:
```js
server: {
  proxy: {
    '/api': { target: 'http://192.168.1.133:8090', rewrite: p => p.replace(/^\/api/, '') },
  },
},
```

## Out of scope / worth knowing
- rag-api's `SYSTEM_PROMPT` (`rag-api/src/rag/prompts.ts`) still casts the assistant as "Insurellm", and the collection mixes the Insurellm sample docs with the crawled GA executive orders. The page will work, but gov answers may be framed oddly until the prompt or data is updated. That's a separate backend change.
- The uncommitted `console.log`s in `rag-chat.ts` aren't touched.

## Verification
1. `cd personal-web-app && npm run lint`, which type-checks.
2. `npm run dev`, then open http://localhost:3000/projects/gov-chat:
   - Ask something about a GA executive order and confirm the text streams in and sources are listed.
   - Submit an empty message and confirm it's blocked. Paste more than 4000 characters and confirm the textarea caps it.
   - Send 11 or more quick requests and confirm the 429 message shows (the default `RATE_LIMIT_PER_MINUTE=10`).
   - Navigate away mid-stream and confirm there's no console error and the rag-api logs show the request ended.
   - Check that the nav link shows as active on the page, and that refreshing on `/projects/gov-chat` still loads the page.
3. `npm run build`, then `npm run preview` for a sanity check. After deploying through Jenkins, repeat the stream check through the public URL, which goes via Cloudflare and nginx, to confirm deltas aren't buffered.
