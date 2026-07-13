# Deploying Shoberfredy to the homeserver

The pipeline is split in two:

1. **This repo (CI/CD)** — pull requests run `ci.yml`; every push to `master`
   runs lint + offline tests before `docker.yml` builds and publishes
   `ghcr.io/jhytabest/shoberfredy:master` (amd64). Tags publish versioned images.
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

## Homeserver integration

The homeserver repository uses the prebuilt image directly. Its Fredy Compose
project contains only the `fredy` service, retains the existing hardening and
volumes, and sets `pull_policy: always`. Prometheus scrapes the in-process
exporter at `fredy:9217`; the Google key still comes from the homeserver's
secret-managed environment.

The old image-patching Dockerfile, copied modules, standalone exporter, model,
and geocoding containers have been removed. The host is authenticated to the
private package with a classic PAT limited to `read:packages`.

Trade-off note: the split-container isolation (read-only DB for the exporter,
`network_mode: none` for the model) is gone by design; the exporter still
opens its database handle read-only in-process.

## Cutover checklist

- Migration 24 backfills `listing_attributes` for all existing rows and tags
  legacy shadow rows; **migration 25 then deletes the legacy shadow corpus,
  the adapterless "zz Shadow" jobs, and the homeserver_backfill_hides table**
  — the database ends up trimmed to active data only. Both run automatically
  at first start.
- Fredy's standard `GET /health` endpoint returns `503` while geocoding is
  unavailable, so the ordinary container-health and application-probe alerts
  cover this failure without a Fredy-specific alert. Pipeline runs abort while
  unhealthy, so nothing is partially ingested. Backfill afterwards is manual:
  `docker exec fredy node tools/market/geocoderBackfill.js run`.

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

After the image passes its container smoke test, `docker.yml` sends the
`shoberfredy_image_published` repository dispatch using the fine-grained
`HOMESERVER_DISPATCH_TOKEN` secret. The homeserver workflow validates its
repository, joins Tailscale, and invokes the restricted `deploy-fredy` SSH
command. That command runs `infra/ansible/fredy-update.yml`, which pulls and
reconciles only the `fredy` Compose service; every other container remains
untouched.

The homeserver cutover must be deployed once through its normal full workflow
before the first automatic Fredy dispatch, because that bootstrap installs the
new restricted SSH command and single-container Compose definition.
