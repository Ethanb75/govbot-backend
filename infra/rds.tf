# Two single-AZ instances: metadata (executive_orders, ingest_runs) and vectors (pgvector chunks).
# Each admin password is generated and rotated by RDS in Secrets Manager, so it never passes
# through Terraform state; only the migrate task reads it. The GovBot role passwords live in SSM
# (see scripts/put-secrets.sh). rds.force_ssl is on by default, so clients must use TLS.

locals {
  databases = {
    # migration 001 names both the admin user and the database
    metadata = { db_name = "govbot", username = "govbot_db_admin" }
    vectors  = { db_name = "vectors", username = "vectors_db_admin" }
  }
}

resource "aws_db_subnet_group" "main" {
  name       = var.name
  subnet_ids = aws_subnet.private[*].id
}

resource "aws_db_instance" "db" {
  for_each = local.databases

  identifier     = "${var.name}-${each.key}"
  engine         = "postgres"
  engine_version = var.postgres_version
  instance_class = var.rds_instance_class

  db_name                     = each.value.db_name
  username                    = each.value.username
  manage_master_user_password = true

  allocated_storage     = 20
  max_allocated_storage = 100
  storage_type          = "gp3"
  storage_encrypted     = true

  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.db[each.key].id]
  publicly_accessible    = false
  multi_az               = false

  # UTC, clear of the 01:00 and 03:00 ET crawler and ingest runs
  backup_window              = "09:00-09:30"
  maintenance_window         = "sun:10:00-sun:11:00"
  backup_retention_period    = 7
  copy_tags_to_snapshot      = true
  auto_minor_version_upgrade = true

  deletion_protection       = true
  skip_final_snapshot       = false
  final_snapshot_identifier = "${var.name}-${each.key}-final"
}
