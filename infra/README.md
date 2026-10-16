# infra

Terraform for GovBot on AWS, applied by hand from your machine (`terraform plan` → review → `terraform apply`). The architecture and the reasons behind it are in [`agent-plans/aws-migration.md`](../agent-plans/aws-migration.md).

```text
viewer ─► CloudFront ─┬─ /*      ─► S3 site bucket (OAC; functions/spa-routes.js)
                      └─ /api/*  ─► internal ALB (VPC origin; functions/strip-api-prefix.js) ─► Fargate: rag-api
EventBridge Scheduler ─► Fargate task: crawler (01:00 ET) ─► S3 knowledge bucket: knowledge-base/, crawler-state/
                     └─► Fargate task: ingest  (03:00 ET) ─► RDS vectors (pgvector)
rag-api, crawler, ingest ─► RDS metadata
```

| File | What |
| --- | --- |
| `bootstrap/` | the state bucket, applied once on local state |
| `network.tf` | VPC, two public and two private subnets, S3 gateway endpoint, security groups. No NAT Gateway: tasks run in the public subnets with public IPs and no inbound rules |
| `ecr.tf` | `govbot/{rag-api,crawler,ingest,migrate}`, immutable tags, last 20 kept |
| `storage.tf` | knowledge bucket (versioned) and site bucket (CloudFront only) |
| `rds.tf` | `govbot-metadata` and `govbot-vectors`, PostgreSQL 18, `db.t4g.micro`, admin passwords managed by RDS in Secrets Manager |
| `ecs.tf` | cluster, log groups, IAM, task definitions (`govbot-rag-api`, `-crawler`, `-ingest`, `-migrate-metadata`, `-migrate-vectors`), the rag-api service |
| `alb.tf` | internal ALB → rag-api, health check `/health/ready` |
| `schedules.tf` | nightly crawler and ingest (`America/New_York`), off until `schedules_enabled = true` |
| `cloudfront.tf` | distribution, OAC, VPC origin, CloudFront Functions, optional ACM certificate |
| `scripts/put-secrets.sh` | creates the SSM parameters, outside Terraform |

## Prerequisites

- Terraform ≥ 1.11, the AWS CLI, Docker with buildx, `jq`.
- An AWS CLI login with admin rights. Prefer an IAM Identity Center user or IAM role (`aws sso login`) over the root user.
- To build `linux/arm64` images on an x86 machine: `docker run --privileged --rm tonistiigi/binfmt --install arm64` once. Or build `linux/amd64` and set `cpu_architecture = "X86_64"`.

## Variables

`image_tag` is the only required variable: the git SHA every image was pushed under. Settings worth knowing about:

| Variable | Default | |
| --- | --- | --- |
| `cloudflare_account_id` | `null` | Workers AI intent check; also makes rag-api read `/govbot/cloudflare-worker-api-key` |
| `schedules_enabled` | `false` | nightly crawler + ingest; turn on after the Phase 4 data migration |
| `rag_api_desired_count` | `1` | `0` during the first bring-up |
| `cpu_architecture` | `ARM64` | must match the images' `--platform` |
| `site_domain` / `attach_site_domain` | `null` / `false` | custom domain, in two steps (see `cloudfront.tf`) |

Keep the non-secret ones in `infra/terraform.tfvars` so only `-var image_tag=…` changes per deploy.

## Secrets

SSM Parameter Store SecureStrings under `/govbot`, created by `scripts/put-secrets.sh` so that no value ever passes through Terraform state. The task definitions only reference them.

| Parameter | Used by |
| --- | --- |
| `/govbot/openai-api-key` | rag-api, ingest |
| `/govbot/cloudflare-worker-api-key` | rag-api (only with `cloudflare_account_id`) |
| `/govbot/metadata/{ingest,app}-password` | migrate-metadata (sets the `govbot_ingest` / `govbot_app` role passwords) |
| `/govbot/metadata/ingest-url` | crawler, ingest |
| `/govbot/metadata/app-url` | rag-api |
| `/govbot/vectors/{ingest,app}-password` | migrate-vectors |
| `/govbot/vectors/ingest-url` | ingest |
| `/govbot/vectors/app-url` | rag-api |

The URLs use `sslmode=verify-full`. RDS forces TLS, and the service images trust the RDS CA bundle (`NODE_EXTRA_CA_CERTS`). The admin passwords are never in SSM: RDS generates and rotates them in Secrets Manager (`terraform output db_admin_secrets`), and only the migrate tasks read them.

## First bring-up

From the repo root. RDS takes ~10 minutes and the CloudFront VPC origin ~15, so step 5 is slow.

```bash
# 1. state bucket (once)
terraform -chdir=infra/bootstrap init
terraform -chdir=infra/bootstrap apply

# 2. main stack backend
terraform -chdir=infra init -backend-config="bucket=$(terraform -chdir=infra/bootstrap output -raw state_bucket)"

# 3. just the ECR repositories, so there is somewhere to push
terraform -chdir=infra apply -var image_tag=none \
  -target=aws_ecr_repository.image -target=aws_ecr_lifecycle_policy.image

# 4. build and push all four images under the current commit
sha=$(git rev-parse --short=12 HEAD)
registry=$(terraform -chdir=infra output -raw ecr_registry)
aws ecr get-login-password | docker login --username AWS --password-stdin "$registry"
for service in rag-api crawler ingest; do
  docker buildx build --platform linux/arm64 -t "$registry/govbot/$service:$sha" --push -f services/$service/Dockerfile .
done
docker buildx build --platform linux/arm64 -t "$registry/govbot/migrate:$sha" --push -f db/Dockerfile db

# 5. everything else, with rag-api scaled to zero until it has secrets and a migrated database
terraform -chdir=infra apply -var image_tag=$sha -var rag_api_desired_count=0

# 6. secrets (prompts for the OpenAI and Cloudflare keys; generates the role passwords)
infra/scripts/put-secrets.sh

# 7. roles + migrations on both databases
net=$(terraform -chdir=infra output -json run_task_network | jq -r .migrate)
for db in metadata vectors; do
  task=$(aws ecs run-task --cluster govbot --launch-type FARGATE --task-definition govbot-migrate-$db \
    --network-configuration "$net" --query 'tasks[0].taskArn' --output text)
  aws ecs wait tasks-stopped --cluster govbot --tasks "$task"
  aws ecs describe-tasks --cluster govbot --tasks "$task" --query 'tasks[0].containers[0].exitCode'   # 0
  aws logs tail /ecs/govbot/migrate-$db --since 15m
done

# 8. start rag-api
terraform -chdir=infra apply -var image_tag=$sha
aws ecs wait services-stable --cluster govbot --services rag-api

# 9. the site (from homelab/personal-web-app)
npm ci && npm run build
aws s3 sync site "s3://$(terraform -chdir=../../govbot-backend/infra output -raw site_bucket)" --delete
aws cloudfront create-invalidation --paths '/*' \
  --distribution-id "$(terraform -chdir=../../govbot-backend/infra output -raw distribution_id)"

# 10. check
curl "$(terraform -chdir=infra output -raw site_url)/api/health/ready"   # {"status":"ok"}
```

rag-api is ready once the vectors database is migrated, even though it's empty. Filling it, and restoring the metadata database, is Phase 4 of the plan. After that, set `schedules_enabled = true`.

Routine deploys (build → push → migrate → `apply -var image_tag=<sha>`) are in `DEPLOY.md`.

## Running a job by hand

```bash
net=$(terraform -chdir=infra output -json run_task_network | jq -r .crawler)   # or .ingest
aws ecs run-task --cluster govbot --launch-type FARGATE --task-definition govbot-crawler --network-configuration "$net"
aws logs tail /ecs/govbot/crawler --follow
```

## Cost

About $65–70/month: Fargate rag-api ~$14, ALB ~$18–22, two RDS micros + storage ~$30, CloudFront/S3/ECR/logs ~$3, scheduled tasks <$2, plus ~$0.80 for the two RDS-managed secrets. The plan should never contain an `aws_nat_gateway`.
