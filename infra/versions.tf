terraform {
  required_version = ">= 1.11"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }

  # The bucket comes from infra/bootstrap and is passed at init, so the account ID isn't committed:
  #   terraform -chdir=infra init -backend-config="bucket=$(terraform -chdir=infra/bootstrap output -raw state_bucket)"
  backend "s3" {
    key          = "govbot-backend/terraform.tfstate"
    region       = "us-east-1"
    encrypt      = true
    use_lockfile = true
  }
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project   = "govbot"
      ManagedBy = "terraform"
      Stack     = "govbot-backend/infra"
    }
  }
}

# CloudFront only accepts ACM certificates from us-east-1, whatever region the rest runs in
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"

  default_tags {
    tags = {
      Project   = "govbot"
      ManagedBy = "terraform"
      Stack     = "govbot-backend/infra"
    }
  }
}

data "aws_caller_identity" "current" {}

data "aws_region" "current" {}

locals {
  account_id = data.aws_caller_identity.current.account_id
  region     = data.aws_region.current.region
}
