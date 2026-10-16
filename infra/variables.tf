variable "region" {
  type    = string
  default = "us-east-1"
}

variable "name" {
  description = "Prefix for resource names"
  type        = string
  default     = "govbot"
}

variable "image_tag" {
  description = "Tag (the git SHA) of the rag-api, crawler, ingest and migrate images to run; every deploy pushes all four under it"
  type        = string
}

variable "cpu_architecture" {
  description = "Fargate CPU architecture; must match the --platform the images were built for (ARM64 = linux/arm64)"
  type        = string
  default     = "ARM64"

  validation {
    condition     = contains(["ARM64", "X86_64"], var.cpu_architecture)
    error_message = "cpu_architecture must be ARM64 or X86_64."
  }
}

variable "vpc_cidr" {
  type    = string
  default = "10.40.0.0/16"
}

variable "postgres_version" {
  description = "RDS PostgreSQL major version; minor versions upgrade automatically in the maintenance window"
  type        = string
  default     = "18"
}

variable "rds_instance_class" {
  type    = string
  default = "db.t4g.micro"
}

variable "rag_api_desired_count" {
  type    = number
  default = 1
}

variable "schedules_enabled" {
  description = "Run the crawler and ingest nightly. Off until the Phase 4 data migration is done, so a crawl can't write rows the metadata restore would collide with."
  type        = bool
  default     = false
}

variable "crawler_schedule" {
  description = "EventBridge Scheduler expression, in America/New_York"
  type        = string
  default     = "cron(0 1 * * ? *)"
}

variable "ingest_schedule" {
  description = "EventBridge Scheduler expression, in America/New_York; after the crawler's 30 minute timeout"
  type        = string
  default     = "cron(0 3 * * ? *)"
}

variable "cloudflare_account_id" {
  description = "Workers AI account for the rag-api intent check; null skips it (and the /govbot/cloudflare-worker-api-key parameter)"
  type        = string
  default     = null
}

variable "site_domain" {
  description = "Custom domain for the site, e.g. govbot.example.com. Setting it requests an ACM certificate; add the validation_records output to DNS."
  type        = string
  default     = null
}

variable "attach_site_domain" {
  description = "Put site_domain on the distribution. Only set once the certificate's DNS validation records exist, because apply waits for validation."
  type        = bool
  default     = false

  validation {
    condition     = !var.attach_site_domain || var.site_domain != null
    error_message = "attach_site_domain needs site_domain."
  }
}

variable "log_retention_days" {
  type    = number
  default = 30
}
