#!/bin/sh
# Nightly logical backup of the govbot database. Runs on the VM host (installed and scheduled by
# the Ansible playbook), not inside the container.
#
# Dumps land on this VM's own disk, so they protect against bad writes and bad migrations but not
# against losing the VM - they still need copying somewhere durable.
set -eu

BACKUP_DIR=/srv/govbot-postgres-db/backups
RETENTION_DAYS=14

stamp=$(date +%Y%m%d-%H%M%S)
partial="$BACKUP_DIR/.govbot-$stamp.dump.partial"
trap 'rm -f "$partial"' EXIT

# custom format so pg_restore can restore selectively; roles aren't included in a database dump,
# but a deploy recreates them
docker exec govbot-postgres-db \
    pg_dump --username govbot_db_admin --dbname govbot --format custom > "$partial"

mv "$partial" "$BACKUP_DIR/govbot-$stamp.dump"
echo "$(date -Iseconds) wrote $BACKUP_DIR/govbot-$stamp.dump"

find "$BACKUP_DIR" -name 'govbot-*.dump' -mtime +"$RETENTION_DAYS" -delete
