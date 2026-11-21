#!/usr/bin/env bash
# Restore a database dump into the running compose stack.
#   scripts/restore.sh backups/db/cardvault-YYYYMMDD-HHMMSS.dump [backups/images/storage-….tar.gz]
set -euo pipefail
DUMP=${1:?usage: restore.sh <db.dump> [images.tar.gz]}
IMAGES=${2:-}
read -r -p "This REPLACES the current CardVault database. Type 'restore' to continue: " ok
[ "$ok" = "restore" ] || { echo "aborted"; exit 1; }
docker compose stop api worker
docker compose exec -T postgres pg_restore --clean --if-exists --no-owner -U cardvault -d cardvault < "$DUMP"
if [ -n "$IMAGES" ]; then
  docker compose run --rm -T --no-deps -v "$(realpath "$IMAGES")":/restore.tgz --entrypoint sh api -c 'tar -C /data/storage -xzf /restore.tgz'
fi
docker compose start api worker
echo "restored"
