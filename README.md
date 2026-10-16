# Govbot backend

GovBot's backend services, split out of `homelab` with their history. The move to AWS is planned in [`agent-plans/aws-migration.md`](agent-plans/aws-migration.md).

```text
services/rag-api    HTTP API that answers questions over the knowledge base (Fastify, SSE)
services/crawler    scheduled crawl of government sources into markdown
services/ingest     scheduled chunking + embedding of the knowledge base into the vectors database
packages/shared     embedding config and the knowledge base storage helper (local dir or S3)
db/                 metadata and vectors (pgvector) migrations, plus the migrate image
infra/              Terraform for AWS (ECS Fargate, RDS, S3, CloudFront)
compose.dev.yml     local databases for development
agent-plans/        plans and research
```

These are npm workspaces. Run `npm install` at the root, then `npm run build` builds `packages/shared` and then every service. Use `npm run <script> -w services/<name>` for one service; it needs `packages/shared` built first.

Service images build from the repo root, and the migrate image from `db/`:

```bash
docker buildx build -f services/<name>/Dockerfile .
docker buildx build -f db/Dockerfile db
```

For local development, `docker compose -f compose.dev.yml up -d` starts a pgvector Postgres with both databases migrated; each service's `.env.example` has the matching connection strings. The knowledge base stays a local directory locally and is an S3 bucket on AWS.

## Deployment

The AWS infrastructure is Terraform in [`infra/`](infra/README.md), applied by hand. Its README covers the first bring-up. Routine deploys will follow `DEPLOY.md` (Phase 3 of the migration plan). Until the cutover, the live services still run on the homelab VMs, deployed by Jenkins from the `homelab` repo's own copies (with Qdrant).
