# ECS cluster, task definitions and the rag-api service. Secrets are SSM Parameter Store
# SecureStrings under /govbot, created by hand (scripts/put-secrets.sh) so their values never enter
# Terraform state; the task definitions only reference them.

locals {
  ssm_prefix = "/${var.name}"
  ssm_arn    = "arn:aws:ssm:${local.region}:${local.account_id}:parameter${local.ssm_prefix}"

  # the RDS-managed secret is JSON; ECS pulls out one key with <arn>:<key>::
  admin_password = { for db, instance in aws_db_instance.db : db => "${instance.master_user_secret[0].secret_arn}:password::" }

  knowledge_base_path = "s3://${aws_s3_bucket.knowledge.bucket}/knowledge-base"
  crawler_state_path  = "s3://${aws_s3_bucket.knowledge.bucket}/crawler-state"

  tasks = {
    rag-api = {
      image  = "rag-api"
      cpu    = 512
      memory = 1024
      port   = 8090
      environment = merge(
        {
          PORT                = "8090"
          TRUST_PROXY_HOPS    = "2" # CloudFront edge, then the ALB
          LOG_LEVEL           = "info"
          DOTENV_CONFIG_QUIET = "true"
        },
        var.cloudflare_account_id == null ? {} : { CLOUDFLARE_WORKER_ACCOUNT_ID = var.cloudflare_account_id },
      )
      secrets = merge(
        {
          OPENAI_API_KEY       = "${local.ssm_arn}/openai-api-key"
          VECTORS_DATABASE_URL = "${local.ssm_arn}/vectors/app-url"
          GOVBOT_DATABASE_URL  = "${local.ssm_arn}/metadata/app-url"
        },
        var.cloudflare_account_id == null ? {} : { CLOUDFLARE_WORKER_API_KEY = "${local.ssm_arn}/cloudflare-worker-api-key" },
      )
    }

    # OCR (pdftoppm + tesseract) needs the headroom
    crawler = {
      image  = "crawler"
      cpu    = 2048
      memory = 4096
      environment = {
        KNOWLEDGE_BASE_PATH = local.knowledge_base_path
        CRAWLER_STATE_PATH  = local.crawler_state_path
        AWS_REGION          = local.region
        DOTENV_CONFIG_QUIET = "true"
      }
      secrets = {
        GOVBOT_DATABASE_URL = "${local.ssm_arn}/metadata/ingest-url"
      }
    }

    ingest = {
      image  = "ingest"
      cpu    = 1024
      memory = 2048
      environment = {
        KNOWLEDGE_BASE_PATH = local.knowledge_base_path
        AWS_REGION          = local.region
        DOTENV_CONFIG_QUIET = "true"
      }
      secrets = {
        OPENAI_API_KEY       = "${local.ssm_arn}/openai-api-key"
        VECTORS_DATABASE_URL = "${local.ssm_arn}/vectors/ingest-url"
        GOVBOT_DATABASE_URL  = "${local.ssm_arn}/metadata/ingest-url"
      }
    }

    # one-off: aws ecs run-task --task-definition govbot-migrate-metadata (see DEPLOY.md)
    migrate-metadata = {
      image   = "migrate"
      cpu     = 256
      memory  = 512
      command = ["metadata"]
      environment = {
        PGHOST     = aws_db_instance.db["metadata"].address
        PGPORT     = tostring(aws_db_instance.db["metadata"].port)
        PGDATABASE = local.databases.metadata.db_name
        PGUSER     = local.databases.metadata.username
        PGSSLMODE  = "require"
      }
      secrets = {
        PGPASSWORD             = local.admin_password["metadata"]
        GOVBOT_INGEST_PASSWORD = "${local.ssm_arn}/metadata/ingest-password"
        GOVBOT_APP_PASSWORD    = "${local.ssm_arn}/metadata/app-password"
      }
    }

    migrate-vectors = {
      image   = "migrate"
      cpu     = 256
      memory  = 512
      command = ["vectors"]
      environment = {
        PGHOST     = aws_db_instance.db["vectors"].address
        PGPORT     = tostring(aws_db_instance.db["vectors"].port)
        PGDATABASE = local.databases.vectors.db_name
        PGUSER     = local.databases.vectors.username
        PGSSLMODE  = "require"
      }
      secrets = {
        PGPASSWORD              = local.admin_password["vectors"]
        VECTORS_INGEST_PASSWORD = "${local.ssm_arn}/vectors/ingest-password"
        VECTORS_APP_PASSWORD    = "${local.ssm_arn}/vectors/app-password"
      }
    }
  }
}

resource "aws_ecs_cluster" "main" {
  name = var.name

  # Container Insights bills per metric; the awslogs output is enough at this size
  setting {
    name  = "containerInsights"
    value = "disabled"
  }
}

resource "aws_cloudwatch_log_group" "task" {
  for_each = local.tasks

  name              = "/ecs/${var.name}/${each.key}"
  retention_in_days = var.log_retention_days
}

# --- IAM ---

data "aws_iam_policy_document" "ecs_tasks_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }
  }
}

# used by ECS itself to pull images, write logs and resolve secrets before the container starts
resource "aws_iam_role" "execution" {
  name               = "${var.name}-ecs-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# the parameters use the default aws/ssm key, which needs no kms:Decrypt grant
data "aws_iam_policy_document" "execution_secrets" {
  statement {
    actions   = ["ssm:GetParameters"]
    resources = ["${local.ssm_arn}/*"]
  }

  statement {
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [for instance in aws_db_instance.db : instance.master_user_secret[0].secret_arn]
  }
}

resource "aws_iam_role_policy" "execution_secrets" {
  name   = "secrets"
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.execution_secrets.json
}

# What the code itself may do. rag-api and migrate only talk to Postgres and the internet, so they
# get no task role.
locals {
  task_s3_access = {
    crawler = {
      actions = ["s3:GetObject", "s3:PutObject"]
      objects = ["${aws_s3_bucket.knowledge.arn}/knowledge-base/*", "${aws_s3_bucket.knowledge.arn}/crawler-state/*"]
    }
    ingest = {
      actions = ["s3:GetObject"]
      objects = ["${aws_s3_bucket.knowledge.arn}/knowledge-base/*"]
    }
  }
}

resource "aws_iam_role" "task" {
  for_each = local.task_s3_access

  name               = "${var.name}-${each.key}-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

data "aws_iam_policy_document" "task_s3" {
  for_each = local.task_s3_access

  # Unconditional: S3 only answers 404 for a missing key (which the storage helper treats as "not
  # there yet") when ListBucket is granted, and that check carries no s3:prefix to match on.
  # The bucket holds nothing but knowledge-base/ and crawler-state/.
  statement {
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.knowledge.arn]
  }

  statement {
    actions   = each.value.actions
    resources = each.value.objects
  }
}

resource "aws_iam_role_policy" "task_s3" {
  for_each = local.task_s3_access

  name   = "knowledge-bucket"
  role   = aws_iam_role.task[each.key].id
  policy = data.aws_iam_policy_document.task_s3[each.key].json
}

# --- task definitions ---

resource "aws_ecs_task_definition" "task" {
  for_each = local.tasks

  family                   = "${var.name}-${each.key}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = each.value.cpu
  memory                   = each.value.memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = contains(keys(aws_iam_role.task), each.key) ? aws_iam_role.task[each.key].arn : null

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = var.cpu_architecture
  }

  container_definitions = jsonencode([
    merge(
      {
        name      = each.value.image
        image     = "${aws_ecr_repository.image[each.value.image].repository_url}:${var.image_tag}"
        essential = true
        # sorted, so ECS's own ordering doesn't show up as a diff on every plan
        environment = [for name in sort(keys(each.value.environment)) : { name = name, value = each.value.environment[name] }]
        secrets     = [for name in sort(keys(each.value.secrets)) : { name = name, valueFrom = each.value.secrets[name] }]
        logConfiguration = {
          logDriver = "awslogs"
          options = {
            awslogs-group         = aws_cloudwatch_log_group.task[each.key].name
            awslogs-region        = local.region
            awslogs-stream-prefix = "ecs"
          }
        }
      },
      try({ command = each.value.command }, {}),
      try({ portMappings = [{ containerPort = each.value.port, protocol = "tcp" }] }, {}),
    )
  ])
}

# --- rag-api service ---

resource "aws_ecs_service" "rag_api" {
  name            = "rag-api"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.task["rag-api"].arn
  desired_count   = var.rag_api_desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = aws_subnet.public[*].id
    security_groups  = [aws_security_group.task["rag-api"].id]
    assign_public_ip = true
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.rag_api.arn
    container_name   = "rag-api"
    container_port   = 8090
  }

  # with one task, start the new one before stopping the old; roll back if it never gets healthy
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
  health_check_grace_period_seconds  = 60

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  enable_ecs_managed_tags = true
  propagate_tags          = "SERVICE"

  depends_on = [aws_lb_listener.api]
}
