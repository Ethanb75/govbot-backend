#!/usr/bin/env bash
# Creates the SSM SecureString parameters the task definitions reference, outside Terraform so the
# values never land in state. Only creates what's missing, so it's safe to re-run; it never
# overwrites. Run after the first `terraform apply` (the URLs need the RDS endpoints):
#   infra/scripts/put-secrets.sh
#
#   /govbot/openai-api-key                  prompted
#   /govbot/cloudflare-worker-api-key       prompted; leave empty to skip (cloudflare_account_id = null)
#   /govbot/<db>/<role>-password            generated; set on the role by the migrate task
#   /govbot/<db>/<role>-url                 the services' connection string, built from the password
#
# Rotating a role password: overwrite both its -password and -url parameters (put-parameter
# --overwrite), run that database's migrate task, then restart whatever uses the URL
# (aws ecs update-service --force-new-deployment for rag-api; the jobs pick it up on their next run).
set -euo pipefail

infra="$(cd "$(dirname "$0")/.." && pwd)"
tf_output() { terraform -chdir="$infra" output -raw "$1"; }

prefix=$(tf_output ssm_prefix)
metadata_host=$(tf_output metadata_db_address)
vectors_host=$(tf_output vectors_db_address)

exists() {
    aws ssm get-parameter --name "$1" --query Parameter.Name --output text >/dev/null 2>&1
}

put() {
    # value on stdin via file:///dev/stdin, so it never shows up in the process list
    printf '%s' "$2" | aws ssm put-parameter --name "$1" --type SecureString --value file:///dev/stdin >/dev/null
    echo "created $1"
}

get() {
    aws ssm get-parameter --name "$1" --with-decryption --query Parameter.Value --output text
}

prompt_secret() {
    local name=$1 label=$2 value
    if exists "$name"; then
        echo "exists  $name"
        return
    fi
    read -rsp "$label: " value
    echo
    if [ -z "$value" ]; then
        echo "skipped $name"
        return
    fi
    put "$name" "$value"
}

# role password + URL; hex so the password needs no escaping inside the URL
role() {
    local db=$1 role=$2 user=$3 host=$4 database=$5
    local password_name="$prefix/$db/$role-password" url_name="$prefix/$db/$role-url" password

    if exists "$password_name"; then
        echo "exists  $password_name"
    else
        put "$password_name" "$(openssl rand -hex 24)"
    fi

    if exists "$url_name"; then
        echo "exists  $url_name"
    else
        password=$(get "$password_name")
        # verify-full: the images trust the RDS CA bundle (NODE_EXTRA_CA_CERTS)
        put "$url_name" "postgresql://$user:$password@$host:5432/$database?sslmode=verify-full"
    fi
}

prompt_secret "$prefix/openai-api-key" "OpenAI API key"
prompt_secret "$prefix/cloudflare-worker-api-key" "Cloudflare Workers AI API key (empty to skip)"

role metadata ingest govbot_ingest "$metadata_host" govbot
role metadata app govbot_app "$metadata_host" govbot
role vectors ingest vectors_ingest "$vectors_host" vectors
role vectors app vectors_app "$vectors_host" vectors
