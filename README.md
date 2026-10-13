# Govbot backend

GovBot's backend services, split out of `homelab` with their history. The move to AWS is planned in [`agent-plans/aws-migration.md`](agent-plans/aws-migration.md).

```text
services/rag-api    HTTP API that answers questions over the knowledge base (Fastify, SSE)
services/crawler    scheduled crawl of government sources into markdown
services/ingest     scheduled chunking + embedding of the knowledge base
db/metadata/        metadata database migrations and scripts
agent-plans/        plans and research
```

The services are npm workspaces. Run `npm install` at the root, then `npm run build` builds every service, or use `npm run <script> -w services/<name>` for one.

Images build from the repo root:

```bash
docker buildx build -f services/<name>/Dockerfile .
```

## Deployment

Nothing deploys from this repo yet. The live services run on the homelab VMs and are still deployed by Jenkins from the `homelab` repo's own copies. Mentions of VMs, Jenkins, Ansible or LAN addresses in the service docs and configs describe that deployment, and they go away as the AWS migration lands.
