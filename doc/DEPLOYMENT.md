# Deploying Shoberfredy to the homeserver

The pipeline is split in two:

1. **This repo (CI/CD)** — every push to `master` runs lint + offline tests
   (`ci.yml`) and builds/publishes `ghcr.io/jhytabest/shoberfredy:master`
   (`docker.yml`, amd64). Tags publish versioned images.
2. **The homeserver repo** — owns the actual deployment (Ansible → compose on
   the host reached via `ssh hs`).

## Single-container layout

Everything runs in ONE container now:

- the app itself (scraping, pipeline, UI on 9998),
- the Prometheus market exporter (`:9217/metrics`, in-process; env
  `FREDY_MARKET_EXPORTER_PORT`, `0` disables),
- the daily market model retrain (in-process timer; env
  `FREDY_MARKET_MODEL_INTERVAL_SECONDS`, default 86400, `0` disables).

The old standalone modes still exist for ad-hoc use inside the container:

```bash
docker exec shoberfredy node tools/market/marketModel.js run|status
docker exec shoberfredy node tools/market/geocoderBackfill.js run|status|refresh-all
```

## Switching the homeserver over (not yet done)

In `homeserver/services/fredy/`:

- Delete the patching machinery (`Dockerfile`, `patch-fredy-pipeline.mjs`, all
  copied `.mjs` modules) — the image is prebuilt.
- Collapse `compose.yml.j2` to the single `fredy` service with
  `image: ghcr.io/jhytabest/shoberfredy:master`, keeping the existing
  hardening (user 10001, `read_only`, `cap_drop`, tmpfs) and volumes
  (`/conf`, `/srv/data/fredy:/db`, cloakbrowser/cache mounts). Drop the
  `fredy-market-exporter` and `fredy-market-model` services; add
  `FREDY_MARKET_EXPORTER_PORT=9217` + `FREDY_MARKET_MODEL_INTERVAL_SECONDS=86400`
  to the environment and expose 9217 on `home_stack_net`.
- **Prometheus**: change the scrape target from `fredy-market-exporter:9217`
  to `fredy:9217` in the monitoring config.
- `geocoder.env` stays as-is; the in-process geocoder and the backfill CLI
  read the same variables.
- GHCR auth: the package is private. Either make the package visibility
  public, or `docker login ghcr.io` on the host with a read-only PAT
  (packages:read) before the first pull.

Trade-off note: the split-container isolation (read-only DB for the exporter,
`network_mode: none` for the model) is gone by design; the exporter still
opens its database handle read-only in-process.

## Migrating the existing database

The old and new schema are compatible (same upstream lineage; the
`homeserver_*` tables carry over untouched). Point Shoberfredy at the
existing `/srv/data/fredy` volume and it applies migration 22 on first start
without touching existing rows.

For a cautious file-swap cutover (or pulling a copy elsewhere) use the import
tool — it snapshots via the SQLite online backup API (WAL-safe), backs up the
target, runs migrations, and verifies row counts:

```bash
node tools/migrate/importLegacyDb.js --source /path/to/listings.db [--target path] [--force]
```

## Automatic updates

Recommended: add a `repository_dispatch` step at the end of this repo's
`docker.yml` that triggers the homeserver repo's deploy workflow (needs a PAT
secret with `repo` scope on the homeserver repo), and set
`pull_policy: always` on the fredy service in the homeserver compose. Every
Shoberfredy push then flows: CI → GHCR image → homeserver deploy pipeline →
new container.
