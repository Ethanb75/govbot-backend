# Two AZs. Fargate tasks run in the public subnets with public IPs and no inbound rules, which gives
# them egress to OpenAI, Cloudflare and the gov sites without a NAT Gateway. RDS and the internal
# ALB sit in the private subnets, which have no route out at all.

data "aws_availability_zones" "available" {
  state = "available"
}

locals {
  azs = slice(data.aws_availability_zones.available.names, 0, 2)
}

resource "aws_vpc" "main" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = {
    Name = var.name
  }
}

# strip the default security group's allow-all rules so nothing can use it by accident
resource "aws_default_security_group" "default" {
  vpc_id = aws_vpc.main.id
}

# also required for CloudFront VPC origins
resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id

  tags = {
    Name = var.name
  }
}

resource "aws_subnet" "public" {
  count = length(local.azs)

  vpc_id            = aws_vpc.main.id
  availability_zone = local.azs[count.index]
  cidr_block        = cidrsubnet(var.vpc_cidr, 8, count.index)

  tags = {
    Name = "${var.name}-public-${local.azs[count.index]}"
  }
}

resource "aws_subnet" "private" {
  count = length(local.azs)

  vpc_id            = aws_vpc.main.id
  availability_zone = local.azs[count.index]
  cidr_block        = cidrsubnet(var.vpc_cidr, 8, count.index + 10)

  tags = {
    Name = "${var.name}-private-${local.azs[count.index]}"
  }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }

  tags = {
    Name = "${var.name}-public"
  }
}

resource "aws_route_table_association" "public" {
  count = length(aws_subnet.public)

  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table" "private" {
  vpc_id = aws_vpc.main.id

  tags = {
    Name = "${var.name}-private"
  }
}

resource "aws_route_table_association" "private" {
  count = length(aws_subnet.private)

  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private.id
}

# free; keeps the crawler and ingest S3 traffic off the internet gateway
resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.main.id
  service_name      = "com.amazonaws.${local.region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [aws_route_table.public.id, aws_route_table.private.id]

  tags = {
    Name = "${var.name}-s3"
  }
}

# --- security groups ---
# Tasks get no inbound rules apart from rag-api from the ALB. The databases accept only the tasks
# that use them.

resource "aws_security_group" "alb" {
  name        = "${var.name}-alb"
  description = "Internal ALB: CloudFront VPC origin in, rag-api out"
  vpc_id      = aws_vpc.main.id
}

resource "aws_security_group" "task" {
  for_each = toset(["rag-api", "crawler", "ingest", "migrate"])

  name        = "${var.name}-${each.key}"
  description = "${each.key} tasks"
  vpc_id      = aws_vpc.main.id
}

resource "aws_security_group" "db" {
  for_each = toset(["metadata", "vectors"])

  name        = "${var.name}-${each.key}-db"
  description = "${each.key} RDS instance"
  vpc_id      = aws_vpc.main.id
}

# the CloudFront ingress rule is in cloudfront.tf, because its source only exists once the VPC origin does
resource "aws_vpc_security_group_egress_rule" "alb_to_rag_api" {
  security_group_id            = aws_security_group.alb.id
  referenced_security_group_id = aws_security_group.task["rag-api"].id
  ip_protocol                  = "tcp"
  from_port                    = 8090
  to_port                      = 8090
}

resource "aws_vpc_security_group_ingress_rule" "rag_api_from_alb" {
  security_group_id            = aws_security_group.task["rag-api"].id
  referenced_security_group_id = aws_security_group.alb.id
  ip_protocol                  = "tcp"
  from_port                    = 8090
  to_port                      = 8090
}

# OpenAI, Cloudflare, gov sites, ECR, SSM, CloudWatch Logs, S3 and the databases
resource "aws_vpc_security_group_egress_rule" "task_all" {
  for_each = aws_security_group.task

  security_group_id = each.value.id
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
}

locals {
  db_clients = {
    "metadata/rag-api" = { db = "metadata", task = "rag-api" }
    "metadata/crawler" = { db = "metadata", task = "crawler" }
    "metadata/ingest"  = { db = "metadata", task = "ingest" }
    "metadata/migrate" = { db = "metadata", task = "migrate" }
    "vectors/rag-api"  = { db = "vectors", task = "rag-api" }
    "vectors/ingest"   = { db = "vectors", task = "ingest" }
    "vectors/migrate"  = { db = "vectors", task = "migrate" }
  }
}

resource "aws_vpc_security_group_ingress_rule" "db_from_task" {
  for_each = local.db_clients

  security_group_id            = aws_security_group.db[each.value.db].id
  referenced_security_group_id = aws_security_group.task[each.value.task].id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  description                  = each.value.task
}
