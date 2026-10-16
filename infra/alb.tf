# Internal ALB in the private subnets; CloudFront reaches it as a VPC origin, so it's never public.
# An ALB rather than API Gateway because it passes the SSE answer stream through unbuffered.

resource "aws_lb" "api" {
  name               = "${var.name}-api"
  internal           = true
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = aws_subnet.private[*].id

  # longer than any pause between SSE events while the answer model thinks
  idle_timeout               = 120
  drop_invalid_header_fields = true
}

resource "aws_lb_target_group" "rag_api" {
  name        = "${var.name}-rag-api"
  port        = 8090
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = aws_vpc.main.id

  # lets an in-flight streamed answer finish when a deploy replaces the task
  deregistration_delay = 60

  health_check {
    # also checks the vectors database is reachable and migrated; never calls OpenAI
    path                = "/health/ready"
    matcher             = "200"
    interval            = 15
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
}

# plain HTTP inside the VPC; viewers get TLS at CloudFront
resource "aws_lb_listener" "api" {
  load_balancer_arn = aws_lb.api.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.rag_api.arn
  }
}
