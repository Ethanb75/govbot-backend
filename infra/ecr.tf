locals {
  images = toset(["rag-api", "crawler", "ingest", "migrate"])
}

# Tags are git SHAs and never move. A deploy pushes every image under the new SHA, retagging the
# unchanged ones (see DEPLOY.md), so one image_tag covers them all and a rollback is a reapply.
resource "aws_ecr_repository" "image" {
  for_each = local.images

  name                 = "${var.name}/${each.key}"
  image_tag_mutability = "IMMUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_ecr_lifecycle_policy" "image" {
  for_each = aws_ecr_repository.image

  repository = each.value.name

  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "drop untagged layers left by rebuilds"
        selection = {
          tagStatus   = "untagged"
          countType   = "sinceImagePushed"
          countUnit   = "days"
          countNumber = 1
        }
        action = { type = "expire" }
      },
      {
        rulePriority = 2
        description  = "keep the last 20 deploys to roll back to"
        selection = {
          tagStatus   = "any"
          countType   = "imageCountMoreThan"
          countNumber = 20
        }
        action = { type = "expire" }
      },
    ]
  })
}
