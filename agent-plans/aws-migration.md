# GovBot: split into its own repo and move to AWS

## Context

The GovBot backend is five pieces in the `homelab` repo. Each runs on its own Proxmox VM and is deployed by Jenkins → Terraform (bpg/proxmox) → Ansible → Docker Compose:

| Piece | Today | Shape |
| --- | --- | --- |
| `rag-api` (Fastify, SSE) | VM .133:8090 | long-lived HTTP; OpenAI, CF Workers AI, Qdrant, Postgres (`govbot_app`) |
| `knowledge-crawler` | VM .132 | cron 01:00, ≤30 min, poppler + tesseract; writes `knowledge-base/*.md` and `crawler-state/*.json` to local disk; Postgres (`govbot_ingest`) |
| `knowledge-ingest` | VM .132 | cron 03:00; reads local `knowledge-base/` and `app-state/state.json`; LLM chunking + embeddings → Qdrant; Postgres |
| `govbot-postgres-db` | VM .134 | PG 18; migrations and role sync run with `docker exec`; pg_hba allowlist; pg_dump backups to the same disk |
| `vector-db` (Qdrant) | VM .131 | `qdrant:latest`, collection `knowledge`, 3072-dim cosine, no auth |

The frontend (`personal-web-app`, a Vite + Lit static build) is served by nginx plus a cloudflared tunnel on VM .128, which proxies `/api/` to rag-api. The corpus is small (~76 docs and a few thousand vectors), so the design should optimize for low cost and low maintenance, not scale.

**Decisions made:**
- **Compute:** ECS on Fargate.
- **Vector store:** a separate RDS Postgres + pgvector database for vectors, alongside the RDS metadata database. This replaces Qdrant.
- **Frontend:** moves to AWS (S3 + CloudFront).
- **Deploys:** manual for now, from your machine with the AWS CLI, Docker buildx and Terraform, following a `DEPLOY.md` runbook. CI/CD with GitHub Actions + OIDC comes after the move (see Next steps). Jenkins is not used for the new repo.

## Review findings carried into the work

1. **Shared local disk couples crawler and ingest.** The markdown corpus and ingest state live only on the .132 disk and aren't backed up. → S3 for markdown and crawler state; ingest state moves into the vectors DB (see Phase 1).
2. **Hardcoded LAN IPs**: compose files, `knowledge-ingest/setupDb.ts`, `personal-web-app/nginx/default.conf`, `pg_hba.conf`. → All of these become env/config.
3. **DB operations rely on `docker exec`** (`scripts/migrate.sh`, `scripts/sync-roles.sh`, `backup.sh`). → The plain-psql scripts are reused, run as one-off ECS tasks. RDS automated backups replace `backup.sh`, and security groups replace `pg_hba`.
4. **Secrets come from Jenkins credentials written to `.env`.** → SSM Parameter Store SecureStrings, set once by hand with `aws ssm put-parameter` (kept out of Terraform state) and referenced by the task definitions.
5. **Qdrant runs unauthenticated.** Jenkins writes `QDRANT__SERVICE__API_KEY`, but `vector-db/compose.yml` never passes it in. This becomes moot once Qdrant is retired.
6. **The chunking prompt in `knowledge-ingest/src/chunk.ts` still describes "Insurellm"** → Rewrite it for government documents.
7. **The embedding model is defined twice**: hardcoded in `knowledge-ingest/src/embeddings.ts`, configurable in `rag-api/src/config.ts`. → Move it into one shared config package.
8. **Verbose payload/answer logging** in `rag-api/src/routes/rag-chat.ts` and `rag-api/src/rag/answer.ts` → Remove or gate it behind a debug level before it goes to CloudWatch.

## Target architecture (AWS)

```text
viewer ─► CloudFront ─┬─ /*      ─► S3 (personal-web-app build, private, OAC)
                      └─ /api/*  ─► internal ALB (CloudFront VPC origin) ─► ECS Fargate: rag-api
EventBridge Scheduler ─► Fargate task: crawler (01:00 ET) ─► S3 knowledge-base/, crawler-state/
                     └─► Fargate task: ingest  (03:00 ET) ─► RDS vectors (pgvector)
rag-api, crawler, ingest ─► RDS metadata (executive_orders, ingest_runs)
```

- **VPC:** two AZs. Fargate tasks run in public subnets with public IPs and **no inbound rules**, so they get egress to OpenAI/CF/gov sites **without a NAT Gateway**. RDS and the internal ALB sit in private subnets.
- **RDS:** two `db.t4g.micro` single-AZ instances: `govbot-metadata` and `govbot-vectors` (pgvector). Use the same major version as today (18) if RDS offers it, so `pg_dump` restores cleanly.
- **rag-api:** Fargate service, 0.5 vCPU / 1 GB, desired count 1. The ALB health check is `/health/ready`, which now checks the vectors DB.
- **crawler:** 2 vCPU / 4 GB for OCR. **ingest:** 1 vCPU / 2 GB. Both are scheduled tasks, so the supercronic `CMD` becomes `node dist/index.js`.
- **CloudFront:**
  - Default behavior goes to S3. A CloudFront Function rewrites SPA routes to `/index.html`. Don't use custom error responses for this, because they would also mask API 404s.
  - The `/api/*` behavior has caching disabled, all viewer headers forwarded, the origin response timeout raised to 60s for SSE, and `/api` stripped by a CloudFront Function.
  - ACM cert in us-east-1. DNS moves from the Cloudflare tunnel to a CNAME (or Route 53 alias) pointing at CloudFront.
- **Why an ALB and not API Gateway:** API Gateway HTTP APIs buffer the whole response, so SSE answers wouldn't stream. REST API response streaming is newer and has its own limits. An ALB passes the stream through as-is and can sit behind CloudFront as a private VPC origin.
- **Rate limiting:** rag-api keys on the client IP. With CloudFront → ALB in front, replace `TRUSTED_PROXY` (a single IP) with a hop count (`trustProxy: 2`) or read `CloudFront-Viewer-Address`. A WAF rate-based rule is optional (~$6+/mo).
- **Approximate monthly cost:** Fargate rag-api ~$14, ALB ~$18–22, 2× RDS micro + storage ~$30, CloudFront/S3/ECR/logs/SSM ~$3, scheduled tasks <$2. **Total ≈ $65–70/mo.** Putting both databases on one RDS instance would save ~$15/mo if that's acceptable later.

## New repo layout (`govbot-backend`)

```text
services/rag-api        (from rag-api/)
services/crawler        (from knowledge-ingest/crawler/)
services/ingest         (from knowledge-ingest/)
packages/shared         embedding model/dims config, storage (S3/local) helper
db/metadata/            migrations + scripts (from govbot-postgres-db/)
db/vectors/             migrations for pgvector schema
infra/                  Terraform (AWS provider, S3 state backend + lockfile)
DEPLOY.md               manual deploy runbook
```

This repo (`Ethanb75/govbot-backend`) already exists with no commits. To bring the history over, run `git filter-repo` on a fresh clone of `homelab`, keeping the paths `rag-api`, `knowledge-ingest`, `govbot-postgres-db` and the govbot `agent-plans/*` files. Then fetch that clone into this repo and make the existing `README.md`, `notes.txt` and `agent-plans/` the first commit on top of it. Then move the folders into the layout above as npm workspaces. Fix `rag-api/.husky/pre-commit`, which assumes the homelab root and `rag-api/` paths.

**Frontend:** `personal-web-app` source stays in `homelab` for now. Its CloudFront/S3 resources live in `govbot-backend/infra`, because the distribution also routes `/api`. It is deployed by hand: `npm run build` → `aws s3 sync` → CloudFront invalidation (see the runbook in Phase 3).

## Phases

### Phase 0 — split the repo (no behavior change)
- Run the filter-repo split into this repo and create the workspace layout.
- Homelab keeps running and deploying its copies; nothing in `homelab` is changed by this plan. Make new changes in `govbot-backend` only.

### Phase 1 — decouple code from the VMs
- **Config:** no IP literals; everything comes from env, validated with zod as in `rag-api/src/config.ts`. Shared embedding config goes in `packages/shared`.
- **Storage helper** (`packages/shared`): `list/read/write` with S3 and local-dir backends, selected by env. Use it in:
  - crawler `src/files.ts` (`writeFileAtomic` becomes a single S3 `PutObject`, which is already atomic for readers) and the state load/save in `src/sources/ga-executive-orders.ts`
  - ingest `src/documents.ts` (`discoverDocuments`, `loadDocument`)
- **Vectors DB schema** (`db/vectors/migrations/001_chunks.sql`):
  - `documents(source PK, content_hash, last_indexed_at)`
  - `chunks(id uuid PK, source FK ON DELETE CASCADE, content, metadata jsonb, embedding halfvec(3072))`
  - HNSW index on `embedding halfvec_cosine_ops`. pgvector's plain `vector` type can't HNSW-index more than 2000 dims.
  - Roles `vectors_ingest` (rw) and `vectors_app` (read).
  - This **replaces `app-state/state.json`**: ingest compares file hashes with `documents`, and the deletes for orphans and re-chunks become row deletes.
- **VectorStore swap:**
  - rag-api: replace `src/qdrant.ts` with `src/vectors.ts` (a pg pool modeled on `src/db.ts`), update `src/rag/retrieve.ts` (`ORDER BY embedding <=> $1 LIMIT $k`) and `src/routes/health.ts`.
  - ingest: replace `src/qdrant.ts` (`upsertChunks`, `deleteChunks`, `getCollectionStats`) and `setupDb.ts`.
  - Keep `mergeChunks` and the `RetrievedChunk` shape unchanged so rerank/answer/tools don't change.
- **Metadata DB:** the code is unchanged apart from the URL. Leave the `qdrant_*` column names for now and rename them in a later migration.
- **Fixes:** findings 6–8. Swap trust-proxy handling for the CloudFront/ALB hops. Add a `migrate` entrypoint image (postgres client + `db/*/scripts`), with `migrate.sh` reading the migrations path from env.
- **Dockerfiles:** keep the multi-stage builds; drop supercronic/crontab; build `linux/arm64` locally with `docker buildx`, or use X86_64 Fargate to skip cross-building.

### Phase 2 — AWS infra (`infra/` Terraform)
- **Applied by hand** from your machine with your AWS CLI profile (`terraform plan` → review → `terraform apply`).
- **Bootstrap:** create the S3 state bucket once, with a tiny `infra/bootstrap/` stack on local state or with the AWS CLI. The main stack then uses it as its backend (with `use_lockfile`).
- **Foundation:** VPC/subnets/security groups, ECR repos (rag-api, crawler, ingest, migrate), ECS cluster.
- **ECS:** task definitions with SSM secret refs, the rag-api service, an internal ALB, and EventBridge schedules (`America/New_York`).
- **Data:** both RDS instances (pgvector via `CREATE EXTENSION vector` in the vectors migration), and S3 buckets for the knowledge base and the site.
- **Edge:** CloudFront + OAC + VPC origin, ACM.
- **Observability:** CloudWatch log groups with 14–30 day retention.
- **Image tags:** task definitions take an `image_tag` variable (the git SHA), so a deploy is a push plus `terraform apply -var image_tag=<sha>`, and rollbacks are reapplies of an older SHA.

### Phase 3 — manual deploy runbook (`DEPLOY.md`)
Write each step as a copy-pasteable command so the later GitHub Actions workflows can mirror it one to one.
1. **Log in:** `aws sso login` (or your profile's equivalent); `aws ecr get-login-password | docker login …`.
2. **Build and push** each changed service: `docker buildx build --platform linux/arm64 -t <ecr>/<service>:<git-sha> --push -f services/<service>/Dockerfile .` (images build from the repo root so they can include `packages/shared`).
3. **Migrate** when `db/**` changed: `aws ecs run-task` with the `migrate` task (metadata and/or vectors), then `aws ecs wait tasks-stopped` and check the exit code and logs.
4. **Roll out:** `terraform -chdir=infra apply -var image_tag=<git-sha>`, then `aws ecs wait services-stable` for rag-api.
5. **Frontend** (from `homelab/personal-web-app`): `npm ci && npm run build` → `aws s3 sync <dist> s3://<site-bucket> --delete` → `aws cloudfront create-invalidation --paths '/*'`.
6. **Check:** `curl https://<site>/api/health/ready` → `ok`.

### Phase 4 — data migration
- **Metadata:** `pg_dump -Fc` from `govbot-postgres-db` → `pg_restore --no-owner` into RDS metadata. Then run sync-roles + migrate to restore grants.
- **Corpus:** `aws s3 sync` of `/opt/knowledge-ingest/knowledge-base` and `crawler-state` from VM .132 into the knowledge-base bucket.
- **Vectors:** run the ingest task once to fill the vectors DB. It re-chunks and re-embeds ~76 docs; the OpenAI cost is small.
- **Check:** run the crawler task once manually; `ingest_runs` gets a row and orders end up `indexed`.

### Phase 5 — run side by side
- The homelab services stay deployed and untouched. Both stacks run independently: each has its own crawler, databases and nightly schedule, so their data can drift apart. That's fine, because the AWS crawler keeps its own copy current.
- Verify the AWS stack on the CloudFront domain (`https://<id>.cloudfront.net`). Public DNS keeps pointing at the homelab site through the Cloudflare tunnel.

## Next steps (after this plan)
- **Cut over and clean up homelab** (once the AWS stack has run cleanly for a while):
  - Switch the site's DNS to CloudFront and remove the cloudflared tunnel.
  - Take a final `pg_dump` of `govbot-postgres-db` and keep it somewhere durable.
  - Remove the homelab VMs for rag-api, knowledge-ingest, vector-db, govbot-postgres-db and personal-web-app from `terraform/`. `govbot_postgres_db` has `prevent_destroy`, so remove that block deliberately.
  - Remove their playbooks, inventories, homelab `Jenkinsfile` entries, `pg_hba.conf` and README rows, and the old source folders.
- **Set up CI/CD with GitHub Actions + OIDC → AWS:**
  - an IAM OIDC provider for `token.actions.githubusercontent.com`, plus a deploy role whose trust policy is limited to `repo:Ethanb75/govbot-backend` on `main` (and a read-only plan role for PRs). No long-lived AWS keys anywhere.
  - workflows that mirror `DEPLOY.md`: `terraform plan` on PRs, `apply` on merge to `main`, build/push only the services whose paths changed, run the migrate task when `db/**` changed, wait for the service to be stable, then the health check.
  - a separate workflow (or repo) for the frontend's build → S3 sync → invalidation.
  - the same Terraform S3 backend is reused.
- Consider merging the two RDS instances into one (two databases) if cost matters more than isolation.
- Rename the `qdrant_*` columns in `executive_orders`.
- Move `personal-web-app` out of `homelab` into its own repo, or into `govbot-backend`.

## Verification
- **Unit/eval:** `npm run test:retrieval` and `npm run test:answers` in `services/rag-api` against the pgvector store; compare with `__tests__/*/current-results.json` from the Qdrant baseline (recall@k, MRR shouldn't drop meaningfully).
- **Local:** a compose file with `pgvector/pgvector` + MinIO for dev, run only with your go-ahead (no local Docker by default).
- **After deploy:**
  - `curl https://<site>/api/health/ready` → `ok`
  - a chat from the site streams SSE deltas through CloudFront
  - the rate limit triggers per client IP, not per CloudFront edge
  - manually run the crawler and ingest tasks, then check `ingest_runs`, `executive_orders.qdrant_status = 'indexed'`, and `SELECT count(*) FROM chunks`
- **Cost:** `terraform plan` has no `aws_nat_gateway`; check Cost Explorer after the first week.
