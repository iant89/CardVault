#!/usr/bin/env bash
# Nightly PostgreSQL dump (always) + weekly image archive (Sundays).
# Price history is irreplaceable — keep these backups somewhere off the server too.
set -euo pipefail
OUT=${BACKUP_OUT:-/backups}
STORAGE=${STORAGE_DIR:-/data/storage}
KEEP_DAILY=${KEEP_DAILY:-14}
KEEP_WEEKLY=${KEEP_WEEKLY:-8}
STAMP=$(date +%Y%m%d-%H%M%S)
mkdir -p "$OUT/db" "$OUT/images"

echo "[backup] database → $OUT/db/cardvault-$STAMP.dump"
pg_dump --format=custom --compress=9 --no-owner --file "$OUT/db/cardvault-$STAMP.dump.partial" ${DATABASE_URL:+"$DATABASE_URL"}
mv "$OUT/db/cardvault-$STAMP.dump.partial" "$OUT/db/cardvault-$STAMP.dump"
ls -1t "$OUT"/db/cardvault-*.dump | tail -n +$((KEEP_DAILY + 1)) | xargs -r rm -f

if [ "$(date +%u)" = "7" ] || [ "${FORCE_IMAGES:-}" = "1" ]; then
  echo "[backup] images → $OUT/images/storage-$STAMP.tar.gz"
  tar -C "$STORAGE" -czf "$OUT/images/storage-$STAMP.tar.gz.partial" .
  mv "$OUT/images/storage-$STAMP.tar.gz.partial" "$OUT/images/storage-$STAMP.tar.gz"
  ls -1t "$OUT"/images/storage-*.tar.gz | tail -n +$((KEEP_WEEKLY + 1)) | xargs -r rm -f
fi
echo "[backup] done"
