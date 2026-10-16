output "site_url" {
  value = "https://${aws_cloudfront_distribution.site.domain_name}"
}

output "distribution_id" {
  description = "For aws cloudfront create-invalidation"
  value       = aws_cloudfront_distribution.site.id
}

output "site_bucket" {
  value = aws_s3_bucket.site.bucket
}

output "knowledge_bucket" {
  value = aws_s3_bucket.knowledge.bucket
}

output "ecr_registry" {
  description = "For docker login"
  value       = split("/", aws_ecr_repository.image["rag-api"].repository_url)[0]
}

output "ecr_repositories" {
  value = { for image, repository in aws_ecr_repository.image : image => repository.repository_url }
}

output "cluster" {
  value = aws_ecs_cluster.main.name
}

output "metadata_db_address" {
  value = aws_db_instance.db["metadata"].address
}

output "vectors_db_address" {
  value = aws_db_instance.db["vectors"].address
}

output "db_admin_secrets" {
  description = "Secrets Manager ARNs of the RDS-managed admin passwords"
  value       = { for db, instance in aws_db_instance.db : db => instance.master_user_secret[0].secret_arn }
}

output "ssm_prefix" {
  value = local.ssm_prefix
}

# aws ecs run-task --network-configuration "$(terraform output -json run_task_network | jq -r .<task>)"
output "run_task_network" {
  description = "awsvpc network configuration for one-off runs of each task (migrate, crawler, ingest)"
  value = {
    for task in ["migrate", "crawler", "ingest"] : task => jsonencode({
      awsvpcConfiguration = {
        subnets        = aws_subnet.public[*].id
        securityGroups = [aws_security_group.task[task].id]
        assignPublicIp = "ENABLED"
      }
    })
  }
}

output "validation_records" {
  description = "DNS records that validate the site_domain certificate"
  value = var.site_domain == null ? [] : [
    for option in aws_acm_certificate.site[0].domain_validation_options : {
      name  = option.resource_record_name
      type  = option.resource_record_type
      value = option.resource_record_value
    }
  ]
}
