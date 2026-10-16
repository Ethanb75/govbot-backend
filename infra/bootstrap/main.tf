# One-time bootstrap: the S3 bucket that holds the main stack's state (and its lockfile).
# Applied once by hand on local state; see infra/README.md. Losing this directory's local state
# only means re-importing the bucket: terraform import aws_s3_bucket.state <bucket>.

terraform {
  required_version = ">= 1.11"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}

variable "region" {
  type    = string
  default = "us-east-1"
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project   = "govbot"
      ManagedBy = "terraform"
      Stack     = "govbot-backend/infra/bootstrap"
    }
  }
}

data "aws_caller_identity" "current" {}

# the account ID keeps the name globally unique without committing it anywhere
resource "aws_s3_bucket" "state" {
  bucket = "govbot-tfstate-${data.aws_caller_identity.current.account_id}"

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_versioning" "state" {
  bucket = aws_s3_bucket.state.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_public_access_block" "state" {
  bucket = aws_s3_bucket.state.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# old state versions are only for recovering from a bad apply
resource "aws_s3_bucket_lifecycle_configuration" "state" {
  bucket = aws_s3_bucket.state.id

  rule {
    id     = "expire-old-state-versions"
    status = "Enabled"

    filter {}

    noncurrent_version_expiration {
      noncurrent_days = 90
    }
  }
}

output "state_bucket" {
  value = aws_s3_bucket.state.bucket
}
