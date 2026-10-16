# viewer ─► CloudFront ─┬─ /*     ─► S3 site bucket (OAC)
#                       └─ /api/* ─► internal ALB (VPC origin) ─► rag-api

resource "aws_cloudfront_origin_access_control" "site" {
  name                              = "${var.name}-site"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_vpc_origin" "api" {
  vpc_origin_endpoint_config {
    name                   = "${var.name}-api"
    arn                    = aws_lb.api.arn
    http_port              = 80
    https_port             = 443
    origin_protocol_policy = "http-only"

    origin_ssl_protocols {
      items    = ["TLSv1.2"]
      quantity = 1
    }
  }
}

# CloudFront creates this service-managed group in the VPC along with the VPC origin. Allowing only
# it (rather than the CloudFront origin-facing prefix list) limits the ALB to this account's
# distributions. Read after the origin exists, hence the depends_on.
data "aws_security_group" "cloudfront_vpc_origin" {
  vpc_id = aws_vpc.main.id

  filter {
    name   = "group-name"
    values = ["CloudFront-VPCOrigins-Service-SG"]
  }

  depends_on = [aws_cloudfront_vpc_origin.api]
}

resource "aws_vpc_security_group_ingress_rule" "alb_from_cloudfront" {
  security_group_id            = aws_security_group.alb.id
  referenced_security_group_id = data.aws_security_group.cloudfront_vpc_origin.id
  ip_protocol                  = "tcp"
  from_port                    = 80
  to_port                      = 80
}

resource "aws_cloudfront_function" "spa_routes" {
  name    = "${var.name}-spa-routes"
  runtime = "cloudfront-js-2.0"
  code    = file("${path.module}/functions/spa-routes.js")
  publish = true
}

resource "aws_cloudfront_function" "strip_api_prefix" {
  name    = "${var.name}-strip-api-prefix"
  runtime = "cloudfront-js-2.0"
  code    = file("${path.module}/functions/strip-api-prefix.js")
  publish = true
}

data "aws_cloudfront_cache_policy" "caching_optimized" {
  name = "Managed-CachingOptimized"
}

data "aws_cloudfront_cache_policy" "caching_disabled" {
  name = "Managed-CachingDisabled"
}

data "aws_cloudfront_origin_request_policy" "all_viewer_except_host" {
  name = "Managed-AllViewerExceptHostHeader"
}

# --- optional custom domain ---
# 1. set site_domain and apply: the certificate is requested; add the validation_records output
#    as CNAMEs wherever the domain's DNS lives
# 2. set attach_site_domain = true and apply: waits for validation, then adds the alias
# 3. point the domain at the distribution (cutover; see "Next steps" in the migration plan)

resource "aws_acm_certificate" "site" {
  count    = var.site_domain == null ? 0 : 1
  provider = aws.us_east_1

  domain_name       = var.site_domain
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_acm_certificate_validation" "site" {
  count    = var.attach_site_domain ? 1 : 0
  provider = aws.us_east_1

  certificate_arn = aws_acm_certificate.site[0].arn
}

resource "aws_cloudfront_distribution" "site" {
  enabled             = true
  comment             = "GovBot site and API"
  is_ipv6_enabled     = true
  http_version        = "http2and3"
  price_class         = "PriceClass_100"
  default_root_object = "index.html"
  aliases             = var.attach_site_domain ? [var.site_domain] : []

  origin {
    origin_id                = "site"
    domain_name              = aws_s3_bucket.site.bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.site.id
  }

  origin {
    origin_id   = "api"
    domain_name = aws_lb.api.dns_name

    vpc_origin_config {
      vpc_origin_id = aws_cloudfront_vpc_origin.api.id
      # the longest wait for the next byte (not the whole response) without a quota increase, so
      # a streamed answer can run longer as long as events keep arriving
      origin_read_timeout      = 60
      origin_keepalive_timeout = 60
    }
  }

  default_cache_behavior {
    target_origin_id       = "site"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true
    cache_policy_id        = data.aws_cloudfront_cache_policy.caching_optimized.id

    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.spa_routes.arn
    }
  }

  # Nothing cached, every viewer header (bar Host) forwarded, and no compression so SSE events go
  # out as they arrive. CloudFront appends the viewer IP to X-Forwarded-For and the ALB appends the
  # edge's, which is why rag-api runs with TRUST_PROXY_HOPS=2.
  ordered_cache_behavior {
    path_pattern             = "/api/*"
    target_origin_id         = "api"
    viewer_protocol_policy   = "https-only"
    allowed_methods          = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods           = ["GET", "HEAD"]
    compress                 = false
    cache_policy_id          = data.aws_cloudfront_cache_policy.caching_disabled.id
    origin_request_policy_id = data.aws_cloudfront_origin_request_policy.all_viewer_except_host.id

    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.strip_api_prefix.arn
    }
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = !var.attach_site_domain
    acm_certificate_arn            = var.attach_site_domain ? aws_acm_certificate_validation.site[0].certificate_arn : null
    ssl_support_method             = var.attach_site_domain ? "sni-only" : null
    minimum_protocol_version       = var.attach_site_domain ? "TLSv1.2_2021" : "TLSv1"
  }
}
