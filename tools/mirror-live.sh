#!/usr/bin/env bash

set -euo pipefail

PROJECT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
MIRROR_DIR="${PROJECT_DIR}/.live-mirror"
COMPOSE_FILE="${PROJECT_DIR}/docker-compose.mirror.yml"
REMOTE_HOST="${SHOBERFREDY_MIRROR_HOST:-hs}"
REMOTE_CONTAINER="${SHOBERFREDY_MIRROR_CONTAINER:-fredy}"
REMOTE_DATA="${SHOBERFREDY_MIRROR_DATA:-/srv/data/fredy}"
REMOTE_CONF="${SHOBERFREDY_MIRROR_CONF:-/etc/homeserver/apps/fredy}"
REMOTE_CACHE="${SHOBERFREDY_MIRROR_CACHE:-/var/cache/homeserver/fredy}"
IMAGE='ghcr.io/jhytabest/shoberfredy:master'

usage() {
  printf '%s\n' \
    'Usage: tools/mirror-live.sh sync|image|up|down|status|refresh' \
    '' \
    '  sync     Copy a consistent DB snapshot plus live media, config, secrets, and caches' \
    '  image    Copy the exact live Docker image into the local Docker engine' \
    '  up       Start the isolated API-only mirror at http://127.0.0.1:19998' \
    '  down     Stop the local mirror' \
    '  status   Show mirror status and compare local/live image IDs' \
    '  refresh  Run sync, image, and up'
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf 'Required command not found: %s\n' "$1" >&2
    exit 1
  fi
}

prepare_directories() {
  mkdir -p \
    "${MIRROR_DIR}/db/media" \
    "${MIRROR_DIR}/db/surface" \
    "${MIRROR_DIR}/conf" \
    "${MIRROR_DIR}/cache/browser" \
    "${MIRROR_DIR}/cache/runtime" \
    "${MIRROR_DIR}/cache/config"
}

remote_container_image_id() {
  ssh -o BatchMode=yes "$REMOTE_HOST" \
    "docker inspect '$REMOTE_CONTAINER' --format '{{.Image}}'"
}

sync_live_state() {
  require_command ssh
  require_command rsync
  require_command sqlite3
  require_command docker
  prepare_directories

  local snapshot_name snapshot_remote snapshot_local restart_after_sync
  snapshot_name="shoberfredy-mirror-$PPID-$(date -u +%Y%m%dT%H%M%SZ).db"
  snapshot_remote="/tmp/${snapshot_name}"
  snapshot_local="${MIRROR_DIR}/db/listings.db.next"
  restart_after_sync=0

  if [[ -n "$(docker compose -f "$COMPOSE_FILE" ps --status running -q 2>/dev/null)" ]]; then
    printf 'Stopping the local mirror before replacing its database...\n'
    docker compose -f "$COMPOSE_FILE" stop
    restart_after_sync=1
  fi

  cleanup_sync() {
    ssh -o BatchMode=yes "$REMOTE_HOST" "rm -f '$snapshot_remote'" >/dev/null 2>&1 || true
    if [[ "$restart_after_sync" == 1 ]]; then
      docker compose -f "$COMPOSE_FILE" up -d --wait >/dev/null 2>&1 || true
    fi
  }
  trap cleanup_sync EXIT

  printf 'Creating a consistent live SQLite snapshot...\n'
  ssh -o BatchMode=yes "$REMOTE_HOST" \
    "set -eu; test -d '$REMOTE_DATA'; sqlite3 '$REMOTE_DATA/listings.db' \".timeout 30000\" \".backup '$snapshot_remote'\"; chmod 0644 '$snapshot_remote'"

  printf 'Copying database snapshot...\n'
  rsync -a "${REMOTE_HOST}:${snapshot_remote}" "$snapshot_local"
  sqlite3 "$snapshot_local" 'PRAGMA quick_check;' | grep -qx 'ok'
  mv -f "$snapshot_local" "${MIRROR_DIR}/db/listings.db"
  rm -f "${MIRROR_DIR}/db/listings.db-wal" "${MIRROR_DIR}/db/listings.db-shm"

  printf 'Copying listing media and market surfaces...\n'
  rsync -a --delete "${REMOTE_HOST}:${REMOTE_DATA}/media/" "${MIRROR_DIR}/db/media/"
  rsync -a --delete "${REMOTE_HOST}:${REMOTE_DATA}/surface/" "${MIRROR_DIR}/db/surface/"

  printf 'Copying configuration and secret environment...\n'
  rsync -a "${REMOTE_HOST}:${REMOTE_CONF}/config.json" "${MIRROR_DIR}/conf/config.json"
  rsync -a "${REMOTE_HOST}:${REMOTE_CONF}/geocoder.env" "${MIRROR_DIR}/conf/geocoder.env"
  chmod 0600 "${MIRROR_DIR}/conf/geocoder.env"

  printf 'Copying live browser/runtime caches...\n'
  rsync -a --delete "${REMOTE_HOST}:${REMOTE_CACHE}/browser/" "${MIRROR_DIR}/cache/browser/"
  rsync -a --delete "${REMOTE_HOST}:${REMOTE_CACHE}/runtime/" "${MIRROR_DIR}/cache/runtime/"
  rsync -a --delete "${REMOTE_HOST}:${REMOTE_CACHE}/config/" "${MIRROR_DIR}/cache/config/"

  ssh -o BatchMode=yes "$REMOTE_HOST" "rm -f '$snapshot_remote'" >/dev/null 2>&1 || true
  if [[ "$restart_after_sync" == 1 ]]; then
    printf 'Restarting the local mirror with the refreshed state...\n'
    docker compose -f "$COMPOSE_FILE" up -d --wait
    restart_after_sync=0
  fi
  trap - EXIT

  printf 'Mirror data is synchronized and passed SQLite quick_check.\n'
}

copy_live_image() {
  require_command ssh
  require_command docker

  local remote_id local_id
  remote_id=$(remote_container_image_id)
  local_id=$(docker image inspect "$IMAGE" --format '{{.Id}}' 2>/dev/null || true)
  if [[ "$local_id" == "$remote_id" ]]; then
    printf 'The exact live image is already loaded locally: %s\n' "$remote_id"
    return
  fi

  printf 'Streaming the exact live amd64 image into the local Docker engine...\n'
  ssh -o BatchMode=yes "$REMOTE_HOST" "docker image save '$IMAGE'" | docker image load
  local_id=$(docker image inspect "$IMAGE" --format '{{.Id}}')
  if [[ "$local_id" != "$remote_id" ]]; then
    printf 'Image mismatch after transfer (live %s, local %s).\n' "$remote_id" "$local_id" >&2
    exit 1
  fi
  printf 'Exact live image loaded: %s\n' "$local_id"
}

start_mirror() {
  require_command docker
  test -s "${MIRROR_DIR}/db/listings.db"
  test -s "${MIRROR_DIR}/conf/config.json"
  test -s "${MIRROR_DIR}/conf/geocoder.env"
  docker compose -f "$COMPOSE_FILE" up -d --wait
  printf 'Local mirror: http://127.0.0.1:19998\n'
}

stop_mirror() {
  require_command docker
  docker compose -f "$COMPOSE_FILE" down
}

show_status() {
  require_command docker
  local remote_id local_id
  remote_id=$(remote_container_image_id)
  local_id=$(docker image inspect "$IMAGE" --format '{{.Id}}' 2>/dev/null || true)
  printf 'Live image:  %s\n' "$remote_id"
  printf 'Local image: %s\n' "${local_id:-not loaded}"
  if [[ -f "${MIRROR_DIR}/db/listings.db" ]]; then
    printf 'Local DB:    %s bytes\n' "$(wc -c < "${MIRROR_DIR}/db/listings.db" | tr -d ' ')"
  else
    printf 'Local DB:    not synchronized\n'
  fi
  docker compose -f "$COMPOSE_FILE" ps
}

main() {
  cd "$PROJECT_DIR"
  case "${1:-}" in
    sync)
      sync_live_state
      ;;
    image)
      copy_live_image
      ;;
    up)
      start_mirror
      ;;
    down)
      stop_mirror
      ;;
    status)
      show_status
      ;;
    refresh)
      sync_live_state
      copy_live_image
      start_mirror
      ;;
    *)
      usage
      exit 2
      ;;
  esac
}

main "$@"
