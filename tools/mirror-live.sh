#!/usr/bin/env bash
#
# Copy a consistent snapshot of the live database into ./db for local inspection.
#
# This used to also build and serve a local mirror of the deployment so the live
# data could be browsed in the web UI. There is no UI any more — Telegram is the
# only output — so all that is still worth having is the snapshot, which is what
# local validation runs against.
#
# VACUUM INTO is used rather than a file copy because the live database runs in
# WAL mode: copying listings.db alone silently drops whatever is still in the
# write-ahead log, producing a torn database that looks fine until it doesn't.

set -euo pipefail

REMOTE_HOST="${SHOBERFREDY_MIRROR_HOST:-hs}"
REMOTE_CONTAINER="${SHOBERFREDY_MIRROR_CONTAINER:-fredy}"
PROJECT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
TARGET="${PROJECT_DIR}/db/listings.db"

printf 'Snapshotting %s on %s...\n' "$REMOTE_CONTAINER" "$REMOTE_HOST"
ssh "$REMOTE_HOST" "docker exec ${REMOTE_CONTAINER} node -e '
  const D = require(\"better-sqlite3\");
  const db = new D(\"/db/listings.db\", { readonly: true });
  db.exec(\"VACUUM INTO \x27/db/_mirror.db\x27\");
'"

printf 'Downloading...\n'
mkdir -p "${PROJECT_DIR}/db"
rm -f "${TARGET}" "${TARGET}-wal" "${TARGET}-shm"
scp -q "${REMOTE_HOST}:/srv/data/fredy/_mirror.db" "${TARGET}"
ssh "$REMOTE_HOST" "rm -f /srv/data/fredy/_mirror.db"

printf 'Wrote %s (%s)\n' "${TARGET}" "$(du -h "${TARGET}" | cut -f1)"
