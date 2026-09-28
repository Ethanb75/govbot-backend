The code you pasted is a strong starting point for the new service. After reviewing the current repo structure and deployment conventions, I’d combine Options 1 and 2 as **one custom TypeScript RAG service with two thin API surfaces**: an application-oriented RAG endpoint for your website and an OpenAI-compatible `/v1/chat/completions` endpoint for portability.

One important repo note: the public `main` branch I can currently inspect shows `personal-web-app/simple-rag-example/`, not the `personal-web-app/apps/knowledge-assistant/answer.ts` path you mentioned. I’m treating the `answer.ts` you pasted as the authoritative prototype. The repo itself does already have `knowledge-ingest`, `vector-db`, `qq-api`, `personal-web-app`, Terraform, Ansible, and the Jenkins pipeline as separate roots. :chatgpt-content-reference{index="1"}

## Target architecture

I would aim for this:

```text
                         INTERNET
                            │
                            ▼
                     Cloudflare Tunnel
                            │
                            ▼
                  personal-web-app nginx
                   /                \
                  /                  \
            static FE            /api/*
                                    │
                                    │ LAN only
                                    ▼
                           ┌─────────────────┐
                           │     rag-api     │
                           │  TypeScript     │
                           │  Node.js        │
                           │  Fastify        │
                           │                 │
                           │ RAG pipeline    │
                           │ API adapters    │
                           └───────┬─────────┘
                                   │
                       ┌───────────┴───────────┐
                       │                       │
                       ▼                       ▼
                    Qdrant              Frontier models
                  192.168...             OpenAI initially
```

I especially like putting `rag-api` **behind the existing personal-site ingress**, rather than publicly exposing another VM. Your current website Compose configuration already has `cloudflared` running alongside nginx, so the website is already the natural external entry point. :chatgpt-content-reference{index="2"}

The browser would ultimately call something like:

```text
https://your-site.com/api/v1/rag/chat
```

and nginx would internally proxy that to:

```text
http://rag-api-lan-ip:809x/v1/rag/chat
```

Qdrant stays private. The OpenAI key stays private. `rag-api` stays private.

---

# Combine Options 1 + 2 at the API boundary

Instead of forcing one endpoint to serve two slightly different use cases, I'd put **two very thin route adapters over the same RAG pipeline**.

```text
                         ┌────────────────────┐
POST /v1/rag/chat ─────►│                    │
                         │   answerQuestion() │──► retrieval
POST /v1/chat/          ►│                    │    reranking
     completions         │                    │    generation
                         └────────────────────┘
```

### Application API

Your personal website would use:

```http
POST /v1/rag/chat
```

Conceptually:

```json
{
  "messages": [
    {
      "role": "user",
      "content": "What projects has Ethan worked on?"
    }
  ],
  "stream": true
}
```

This endpoint is allowed to be RAG-aware. It can return useful metadata such as:

```json
{
  "answer": "...",
  "sources": [
    {
      "source": "about/projects.md",
      "contentHash": "...",
      "score": 0.83
    }
  ]
}
```

That is much nicer for eventually rendering source links/cards in your FE.

### Compatibility API

Also expose:

```http
POST /v1/chat/completions
GET  /v1/models
```

with the normal OpenAI Chat Completions request/response shape.

Expose a virtual model:

```json
{
  "model": "knowledge-assistant"
}
```

rather than leaking the actual model being used internally.

That gives you:

```text
client:
    model = "knowledge-assistant"

rag-api:
    ANSWER_MODEL=gpt-whatever
    RERANK_MODEL=gpt-whatever
    QUERY_REWRITE_MODEL=gpt-whatever
```

Changing the underlying frontier model doesn't change clients.

Both routes call the **same TypeScript service code**. They're just different transports.

---

# How I'd restructure your existing `answer.ts`

The existing prototype has the right stages:

```text
question
   │
   ├──► rewrite question
   │
   ├──► retrieve rewritten question
   │
   ├──► retrieve original question
   │
   ├──► merge
   │
   ├──► rerank
   │
   ├──► take FINAL_K
   │
   └──► generate answer
```

I would preserve that design for v1.

What should change is that the code gets separated into units instead of putting retrieval, Qdrant, prompts, model calls, and orchestration in the same module.

Something like:

```text
rag-api/
├── src/
│   ├── server.ts
│   ├── config.ts
│   │
│   ├── routes/
│   │   ├── health.ts
│   │   ├── rag-chat.ts
│   │   ├── chat-completions.ts
│   │   ├── models.ts
│   │   └── search.ts
│   │
│   ├── rag/
│   │   ├── answer.ts
│   │   ├── retrieve.ts
│   │   ├── rewrite.ts
│   │   ├── rerank.ts
│   │   ├── prompts.ts
│   │   └── types.ts
│   │
│   ├── providers/
│   │   ├── embeddings.ts
│   │   └── language-model.ts
│   │
│   ├── qdrant/
│   │   └── client.ts
│   │
│   └── schemas/
│       ├── chat.ts
│       └── openai.ts
│
├── test/
├── Dockerfile
├── compose.yml
├── package.json
└── tsconfig.json
```

The important dependency direction becomes:

```text
routes
  │
  ▼
answer.ts
  │
  ├── rewrite.ts
  ├── retrieve.ts
  ├── rerank.ts
  └── language-model.ts

retrieve.ts
  │
  ├── embeddings.ts
  └── qdrant/client.ts
```

No HTTP code inside the RAG pipeline.

---

# I would use Fastify

For this particular service, I'd choose:

```text
Node 24
TypeScript
Fastify
Zod
AI SDK
@ai-sdk/openai
@qdrant/js-client-rest
```

You already use essentially the same Node/TypeScript/AI SDK stack in `knowledge-ingest`: it is ESM TypeScript and currently depends on AI SDK 7, the OpenAI AI SDK provider, Qdrant's JS client, and Zod. :chatgpt-content-reference{index="3"}

You can also mirror the ingest service's Node 24 multi-stage Docker pattern instead of introducing another runtime style. :chatgpt-content-reference{index="4"}

That consistency is worth a lot in a homelab.

---



# Streaming should be part of v1

This is the biggest functional change I'd make from the sample.

Your current final step is:

```ts
generateText(...)
```

For the website endpoint, use `streamText()`.

The AI SDK supports text streaming responses directly for interactive chat use cases. :chatgpt-content-reference{index="10"}

The request lifecycle becomes:

```text
               non-streaming setup
                       │
                       ▼
                rewrite question
                       │
                retrieve chunks
                       │
                    rerank
                       │
                       ▼
                START RESPONSE
                       │
                       ▼
                   streamText
                       │
                       ▼
                 browser tokens
```

Retrieval happens before tokens start, but once generation begins, the user sees output immediately.

For the OpenAI adapter, translate those deltas into OpenAI-style SSE:

```text
data: {"object":"chat.completion.chunk", ...}

data: {"object":"chat.completion.chunk", ...}

data: [DONE]
```

The application-native `/v1/rag/chat` can additionally send your source metadata.

---

# Add a `/v1/search` endpoint early

I strongly recommend retaining the debug endpoint from the earlier architecture idea:

```http
POST /v1/search
```

Request:

```json
{
  "query": "What does Ethan use for CI/CD?"
}
```

Response:

```json
{
  "rewrittenQuery": "...",
  "results": [
    {
      "source": "...",
      "score": 0.82,
      "content": "..."
    }
  ]
}
```

This makes RAG debugging dramatically easier.

When the assistant gives a bad answer:

```text
/v1/search bad?
       │
       ├── yes → retrieval/chunking/embedding problem
       │
       └── no  → prompt/model/reranking problem
```

Without this, all RAG failures just look like "the model gave a bad answer."

---

# Health endpoints

I'd expose:

```text
GET /health/live
GET /health/ready
```

`live` just verifies Node is running.

`ready` can verify:

```text
configuration loaded
Qdrant reachable
collection exists
```

I would **not call OpenAI from the health check**. That adds cost, latency, and an external dependency to something Jenkins/Uptime Kuma may hit frequently.

---

# CI/CD fits your existing pattern almost exactly

Your repo explicitly documents the pattern as:

```text
application
    ↓
Jenkins
    ├── Terraform → Proxmox VM
    └── Ansible → Docker Compose
```

and requires each service to have an app directory, Terraform definition, Ansible inventory/playbook, and Jenkins registration. :chatgpt-content-reference{index="11"}

So add:

```text
rag-api/
terraform/rag-api.tf
ansible/inventory/rag-api.ini
ansible/playbooks/deploy-rag-api.yml
```

Your VM can be small because no inference happens locally:

```text
1–2 vCPU
1 GB RAM
small disk
Debian
Docker
```

No GPU.

The runtime is basically:

```text
Node
HTTP
Qdrant HTTP
OpenAI HTTPS
```

---

# One Jenkins improvement I'd make at the same time

Your current Jenkins service selection only watches the application's `rootFolderName`:

```groovy
if (files.any { it.startsWith(services[serviceName].rootFolderName) })
``` :chatgpt-content-reference{index="12"}


Your own service documentation calls out the consequence: changing only Terraform, inventory, or an Ansible playbook does **not** select that service for application deployment. :chatgpt-content-reference{index="13"}

This new service is a good time to change the model from:

```groovy
rootFolderName: 'rag-api'
```

to something conceptually like:

```groovy
watchPaths: [
  'rag-api/',
  'terraform/rag-api.tf',
  'ansible/inventory/rag-api.ini',
  'ansible/playbooks/deploy-rag-api.yml'
]
```

Then:

```text
change TS code          → deploy rag-api
change compose           → deploy rag-api
change Ansible           → deploy rag-api
change its Terraform     → deploy rag-api
```

That fixes a real weakness in your current generic service pipeline rather than creating another special case.

---

# Secrets are one area where I would not copy the existing website pattern

The current personal-web-app playbook copies a `.env` file from the repo into `/opt/personal-web-app`. :chatgpt-content-reference{index="14"}

For this service, the OpenAI key absolutely should not follow that pattern.

Use:

```text
Jenkins Credentials
       │
       ▼
Ansible environment/extra vars
       │
       ▼
/opt/rag-api/.env
```

with the Ansible task marked `no_log: true`.

Git should contain:

```text
.env.example
```

but never:

```text
OPENAI_API_KEY=sk-...
```

---

# Website integration

Once `rag-api` works independently, I'd modify your website nginx config:

```text
location /api/ {
    proxy_pass http://RAG_API_LAN_IP:8090/;

    proxy_http_version 1.1;
    proxy_buffering off;

    # appropriate forwarded headers...
}
```

Disabling proxy buffering matters because otherwise nginx can partially defeat the visible benefit of token streaming.

The resulting external path is nicely simple:

```text
Browser
  │
  │ POST /api/v1/rag/chat
  ▼
personal-web-app nginx
  │
  │ LAN
  ▼
rag-api
```

No CORS headache because the browser talks to the same origin.

No Qdrant exposure.

No OpenAI key in the browser.

No second public Cloudflare service.

---

# Implementation order

I would build it in these phases:

1. **Create `rag-api` as a standalone Node/TypeScript project.** Match your `knowledge-ingest` Node 24 + ESM + AI SDK versions, add Fastify, Zod, Qdrant client, Dockerfile, and Compose.

2. **Extract the pasted `answer.ts` into modules without changing its RAG algorithm yet.** Establish typed `Message`, `RetrievedChunk`, config, Qdrant client, rewrite, retrieve, rerank, prompts, and answer orchestration. This keeps the first refactor behaviorally recognizable.

3. **Fix the retrieval pipeline while extracting it.** Serialize history correctly, skip rewriting when unnecessary, parallelize dual retrieval, preserve Qdrant IDs/scores, deduplicate by ID, validate reranker output, and use `slice`.

4. **Add API routes.** Start with `/health/live`, `/health/ready`, `/v1/search`, `/v1/rag/chat`, `/v1/chat/completions`, and `/v1/models`. Both chat routes use the same internal orchestration function.

5. **Add streaming.** Replace final `generateText()` with `streamText()` while keeping rewrite/retrieval/reranking non-streaming. The native route can expose RAG sources; the OpenAI adapter emits compatible completion chunks.

6. **Deploy it through your existing IaC flow.** Add `terraform/rag-api.tf`, its Ansible inventory/playbook, Compose deployment, Jenkins credentials for the OpenAI key, Jenkins service registration, and a `/health/ready` smoke check. Your repository already provisions application VMs into the `ci-cd` pool with cloud-init/deployer SSH, so this follows the established model. :chatgpt-content-reference{index="15"}

7. **Fix Jenkins watched paths while adding the service.** Let service-specific app, Terraform, inventory, and Ansible changes all select `rag-api`.

8. **Integrate the personal website last.** Add the nginx `/api/` proxy and then build the Lit chat UI against `/api/v1/rag/chat`. Keep all conversation state in the browser for now.

9. **Add a small evaluation fixture before tuning models.** Pick perhaps 10 known questions from your sample knowledge and record expected source documents / core facts. That will give you something measurable when changing `RETRIEVAL_K`, `FINAL_K`, rewrite models, rerank models, prompts, or embedding strategies.

The resulting boundary is very clean:

```text
                   PUBLIC / UI WORLD
                          │
                          ▼
                 personal-web-app
                          │
                    /api proxy
                          │
──────────────────────────┼────────────────────────
                     PRIVATE LAN
                          │
                          ▼
                       rag-api
                     /    |    \
                    /     |     \
            embeddings  Qdrant  generation
                 │                │
                 └──── frontier APIs ────┘
```

And inside `rag-api`:

```text
OpenAI-compatible API ──┐
                        ├──► one RAG engine
Website-specific API ───┘
                              │
                    rewrite → retrieve
                              ↓
                            rerank
                              ↓
                            answer
```

That gives you the simplicity of **Option 1** while preserving the portable client contract of **Option 2**, without introducing LangChain, persistent chat storage, Redis, another public ingress, or your local llama.cpp infrastructure yet.