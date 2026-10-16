# knowledge bucket: the crawler writes knowledge-base/ (the Markdown corpus) and crawler-state/,
# ingest reads knowledge-base/. site bucket: the personal-web-app build, served only through CloudFront.

resource "aws_s3_bucket" "knowledge" {
  bucket = "${var.name}-knowledge-${local.account_id}"
}

# the corpus only exists here, so overwritten and deleted files stay recoverable for a while
resource "aws_s3_bucket_versioning" "knowledge" {
  bucket = aws_s3_bucket.knowledge.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "knowledge" {
  bucket = aws_s3_bucket.knowledge.id

  rule {
    id     = "expire-old-versions"
    status = "Enabled"

    filter {}

    noncurrent_version_expiration {
      noncurrent_days = 30
    }
  }
}

resource "aws_s3_bucket" "site" {
  bucket = "${var.name}-site-${local.account_id}"
}

resource "aws_s3_bucket_public_access_block" "bucket" {
  for_each = {
    knowledge = aws_s3_bucket.knowledge.id
    site      = aws_s3_bucket.site.id
  }

  bucket = each.value

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Only this distribution, through its origin access control. No ListBucket, so a missing file is a
# 403 rather than a 404; client-side routes never reach S3 as-is (see functions/spa-routes.js).
resource "aws_s3_bucket_policy" "site" {
  bucket = aws_s3_bucket.site.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "CloudFrontRead"
        Effect    = "Allow"
        Principal = { Service = "cloudfront.amazonaws.com" }
        Action    = "s3:GetObject"
        Resource  = "${aws_s3_bucket.site.arn}/*"
        Condition = {
          StringEquals = { "AWS:SourceArn" = aws_cloudfront_distribution.site.arn }
        }
      },
    ]
  })

  depends_on = [aws_s3_bucket_public_access_block.bucket]
}
