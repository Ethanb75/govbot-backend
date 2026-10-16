# Nightly crawler and ingest runs as one-off Fargate tasks. Each task's exit code is the run's
# result; failures show up in its log group. Disabled until the Phase 4 data migration is done
# (var.schedules_enabled).

locals {
  scheduled_tasks = {
    crawler = var.crawler_schedule
    ingest  = var.ingest_schedule
  }
}

data "aws_iam_policy_document" "scheduler_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["scheduler.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }
  }
}

resource "aws_iam_role" "scheduler" {
  name               = "${var.name}-scheduler"
  assume_role_policy = data.aws_iam_policy_document.scheduler_assume.json
}

data "aws_iam_policy_document" "scheduler" {
  statement {
    actions   = ["ecs:RunTask"]
    resources = [for task in keys(local.scheduled_tasks) : "${aws_ecs_task_definition.task[task].arn_without_revision}:*"]

    condition {
      test     = "ArnEquals"
      variable = "ecs:cluster"
      values   = [aws_ecs_cluster.main.arn]
    }
  }

  statement {
    actions   = ["iam:PassRole"]
    resources = concat([aws_iam_role.execution.arn], [for task in keys(local.scheduled_tasks) : aws_iam_role.task[task].arn])

    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "scheduler" {
  name   = "run-tasks"
  role   = aws_iam_role.scheduler.id
  policy = data.aws_iam_policy_document.scheduler.json
}

resource "aws_scheduler_schedule" "task" {
  for_each = local.scheduled_tasks

  name                         = "${var.name}-${each.key}"
  state                        = var.schedules_enabled ? "ENABLED" : "DISABLED"
  schedule_expression          = each.value
  schedule_expression_timezone = "America/New_York"

  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = aws_ecs_cluster.main.arn
    role_arn = aws_iam_role.scheduler.arn

    ecs_parameters {
      task_definition_arn = aws_ecs_task_definition.task[each.key].arn
      launch_type         = "FARGATE"
      task_count          = 1

      network_configuration {
        subnets          = aws_subnet.public[*].id
        security_groups  = [aws_security_group.task[each.key].id]
        assign_public_ip = true
      }
    }

    # retries a RunTask that couldn't start (e.g. no Fargate capacity), not a run that failed;
    # a failed crawl or ingest waits for the next night or a manual run
    retry_policy {
      maximum_retry_attempts       = 2
      maximum_event_age_in_seconds = 900
    }
  }
}
