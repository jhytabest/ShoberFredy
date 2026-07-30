# Shoberfredy

Shoberfredy is a private, single-user homeserver application for finding
Berlin rental listings. It discovers listings from ImmoScout24, Immowelt,
Kleinanzeigen, and WG-Gesucht, extracts structured facts with an LLM,
deduplicates across portals, prices each listing against two local market
models, and sends accepted listings to Telegram.

It is based on [Fredy](https://github.com/orangecoding/fredy). See
[LICENSE](LICENSE) for licensing and attribution.

## Architecture

```mermaid
flowchart LR
  A["Scheduled discovery"] --> B["pipeline_work: detail"]
  B --> C["Capture and progressive filters"]
  C --> D["pipeline_work: parse"]
  D --> E["LLM, geocoding, and identity claims"]
  E --> F["Canonical listing"]
  F --> G["pipeline_work: rate"]
  G --> H["Ridge and GBM scores"]
  H --> I["pipeline_work: notify"]
  I --> J["Telegram"]
  K["Model schedule"] --> L["pipeline_work: market-model"]
  L --> G
  M["Upkeep schedule"] --> N["pipeline_work: maintenance"]
```

Discovery uses the interval configured in the application settings. Detail
capture, parsing, rating, notification, model training, and database upkeep are
work kinds in one durable queue. Each item has one shared lease, retry,
terminal-state, and audit contract. Process restarts reclaim expired work rather
than running repair scripts.

The market cron only produces a durable work item; it never performs training
itself. Dedupe and filtering are pipeline stages, not maintenance commands.

## Data policy

The SQLite schema has one current migration:
`lib/services/storage/migrations/sql/100.current-schema.js`. It creates a clean
database from scratch and reconciles an existing production database in place
without deleting listings.

- `listing_texts` permanently keeps one richest full-text capture per listing.
  Transient queue copies are cleared after the listing reaches a terminal
  state.
- Listing images are converted to WebP, capped at 20 KB, named by SHA-256, and
  shared by content. Scheduled maintenance removes files no database row
  references.
- Source observations and LLM calls retain hashes, byte counts, outcomes, and
  timing rather than duplicating raw pages, prompts, or responses.
- Source URLs, filter decisions, processing attempts, merges, scores, and
  notification results remain auditable.
- There is no historical backfill pipeline. Terminal work payloads are compacted
  automatically after their durable result is attached.

The upgrade preserves the existing database file. Set `FREDY_DB_VACUUM=1` to
let scheduled maintenance return freed SQLite pages to the filesystem.

## Docker

```bash
docker run -d --name shoberfredy \
  --env-file .env.local \
  -v shoberfredy_conf:/conf \
  -v shoberfredy_db:/db \
  -p 9998:9998 \
  ghcr.io/jhytabest/shoberfredy:master
```

The only HTTP surface is the health endpoint at
<http://localhost:9998/health>; listings are delivered through Telegram.
The image runs as UID/GID `10001`; the supplied Compose file also uses a
read-only root filesystem, drops Linux capabilities, and enables
`no-new-privileges`.

The database lives at `/db/listings.db`, content-addressed media at `/db/media`,
and generated market layers at `/db/surface`. Back up the database and media
directory together.

### Required secrets

Place these in `.env.local`:

```dotenv
OPENROUTER_API_KEY=...
GOOGLE_GEOCODING_API_KEY=...
```

The application also reads `/conf/config.json`; its only deployment-level
setting is the SQLite directory:

```json
{ "sqlitepath": "/db" }
```

## Runtime controls

Every environment variable the application reads is declared in
`lib/shared/env.js`. Reading an undeclared name throws, so this table is
generated from that registry rather than maintained alongside it — if a knob
exists, it is listed here.

#### Credentials

| Variable | Default | Purpose |
| --- | --- | --- |
| `GOOGLE_GEOCODING_API_KEY` | `(unset)` | Google Geocoding key. |
| `OPENROUTER_API_KEY` | `(unset)` | OpenRouter key; required for LLM parsing. |

#### Kill switches

| Variable | Default | Purpose |
| --- | --- | --- |
| `FREDY_DETAIL_FETCH_ENABLED` | `true` | Set 0 to stop draining detail work. |
| `FREDY_LLM_ENABLED` | `true` | Set 0 to disable the LLM entirely (parsing stops). |
| `FREDY_MAINTENANCE_ENABLED` | `true` | Set 0 to stop scheduled maintenance work items. |
| `FREDY_NOTIFICATION_ENABLED` | `true` | Set 0 to stop notification delivery. |
| `FREDY_PARSER_ENABLED` | `true` | Set 0 to stop the LLM parser worker. |
| `FREDY_RATING_ENABLED` | `true` | Set 0 to stop market rating. |

#### Discovery and the work queue

| Variable | Default | Purpose |
| --- | --- | --- |
| `FREDY_DETAIL_ITEM_TIMEOUT_MS` | `300000` | Deadline for one detail capture. |
| `FREDY_DETAIL_MAX_FAILURES` | `8` | Attempts before a detail item is abandoned. |
| `FREDY_DISCOVERY_MAX_PAGES` | `20` | Override the per-provider page ceiling; unset uses the provider's own limit (3). |
| `FREDY_DISCOVERY_TIMEOUT_MS` | `120000` | Deadline for one provider discovery run. |
| `FREDY_PARSER_ITEM_TIMEOUT_MS` | `300000` | Deadline for one parse (text + repair). |
| `FREDY_PARSER_MAX_ITEM_FAILURES` | `8` | Attempts before a parse item is abandoned. |
| `FREDY_RATING_ITEM_TIMEOUT_MS` | `30000` | Deadline for one market rating. |
| `FREDY_MAINTENANCE_ITEM_TIMEOUT_MS` | `1800000` | Deadline for automatic database upkeep. |
| `FREDY_WORK_IDLE_POLL_MS` | `1000` | Idle sleep between empty work-queue polls. |
| `FREDY_WORK_MAX_BACKOFF_MS` | `3600000` | Ceiling on retry backoff for work items. |
| `FREDY_WORKER_RESTART_DELAY_MS` | `5000` | Delay before restarting a crashed worker loop. |

#### LLM

| Variable | Default | Purpose |
| --- | --- | --- |
| `FREDY_LLM_DAILY_LIMIT` | `1000` | Daily LLM request budget (UTC days). |
| `FREDY_LLM_MAX_EMBEDDED_CHARS` | `24000` | Cap on embedded JSON sent to the LLM. |
| `FREDY_LLM_MAX_LISTING_FAILURES` | `5` | LLM attempts before a listing is abandoned. |
| `FREDY_LLM_MAX_TEXT_CHARS` | `24000` | Cap on captured page text sent to the LLM. |
| `FREDY_LLM_REQUEST_TIMEOUT_MS` | `120000` | Deadline for a single LLM request. |
| `FREDY_LLM_TEXT_MODEL` | _unset_ | OpenRouter model id for text extraction. |
| `FREDY_LLM_UPSTREAM_BACKOFF_MS` | `60000` | Backoff after an upstream LLM rate limit. |
| `FREDY_OPENROUTER_REQUESTS_PER_MINUTE` | `18` | Client-side OpenRouter rate limit. |

#### Filters and geocoding

| Variable | Default | Purpose |
| --- | --- | --- |
| `FREDY_GEOCODER_RETRY_COARSE_AFTER_DAYS` | `14` | Age at which a coarse geocode retries. |
| `FREDY_PRELLM_AREA_MIN_PRECISION` | `house,street` | Geocode precisions confident enough to reject a listing before the LLM. |

#### Provider circuit breaker

| Variable | Default | Purpose |
| --- | --- | --- |
| `FREDY_PROVIDER_BREAKER_COOLDOWN_MS` | `1800000` | Initial provider pause duration. |
| `FREDY_PROVIDER_BREAKER_FAILURES` | `2` | Failures before a provider is paused. |
| `FREDY_PROVIDER_BREAKER_MAX_COOLDOWN_MS` | `21600000` | Ceiling on provider pause. |

#### Market model and metrics

| Variable | Default | Purpose |
| --- | --- | --- |
| `FREDY_MARKET_DB_PATH` | _unset_ | Override the market SQLite path (defaults to app db). |
| `FREDY_MARKET_EXPORTER_PORT` | `9217` | Prometheus exporter port; 0 disables it. |
| `FREDY_MARKET_INTERVAL_LEVEL` | `0.8` | Conformal interval coverage level. |
| `FREDY_MARKET_MODEL_CRON` | `0 2 * * *` | Market training schedule; "0" disables training entirely. |
| `FREDY_MARKET_MODEL_INTERVAL_SECONDS` | `86400` | Minimum seconds between retrains; 0 disables training. |
| `FREDY_MARKET_MODEL_RUN_TIMEOUT_MS` | `1800000` | Deadline for one retrain run. |
| `FREDY_MARKET_SURFACE_MIN_CONFIDENCE` | `0.25` | Minimum surface-cell confidence. |
| `FREDY_PYTHON_BIN` | `python3` | Python used for the LightGBM trainer. |

#### Maintenance

| Variable | Default | Purpose |
| --- | --- | --- |
| `FREDY_DB_VACUUM` | `false` | Set 1 to VACUUM during scheduled maintenance. |
| `FREDY_MAINTENANCE_INTERVAL_MS` | `86400000` | Spacing between maintenance work items. |

#### Runtime and tooling

| Variable | Default | Purpose |
| --- | --- | --- |
| `CLOAKBROWSER_BINARY_PATH` | _unset_ | Explicit CloakBrowser Chromium path. |
| `CLOAKBROWSER_CACHE_DIR` | _unset_ | CloakBrowser download cache directory. |
| `FREDY_DOCKER` | `false` | Set by the container image to signal a Docker deployment. |
| `MIGRATION_ALLOW_CHECKSUM_UPDATE` | `false` | Permit rewriting the recorded checksum of an applied migration. |
| `NODE_ENV` | `development` | Node environment; "production" quiets debug logging. |

## Local development

Node.js 22 or newer is required.

```bash
yarn install
yarn market:setup
yarn start:backend
```

For local GBM training, set
`FREDY_PYTHON_BIN=.market-venv/bin/python3` in `.env.local`. The container uses
the same pinned [`requirements.txt`](tools/market/requirements.txt)
automatically.

Quality checks:

```bash
yarn format:check
yarn lint
```

CI runs both checks, builds the Docker image, starts it through the real
migration path, and requires a healthy `/health` response before publishing.

## Production-state Docker mirror

The `hs` deployment can be copied into the ignored `.live-mirror` directory
without stopping or writing to production:

```bash
tools/mirror-live.sh refresh
```

This uses SQLite's online backup API, copies media/configuration/runtime state,
and runs the exact deployed amd64 image at <http://127.0.0.1:19998>. The
application container is isolated on an internal Docker network and uses an
API-only entrypoint, so discovery, workers, LLM/geocoding calls, training, and
notifications cannot run locally.

```bash
tools/mirror-live.sh sync
tools/mirror-live.sh up
tools/mirror-live.sh status
tools/mirror-live.sh down
```

The mirror contains durable state, not process memory, open connections,
in-flight requests.

## Maintenance

Database upkeep runs automatically as durable pipeline work. The only operator
command is read-only:

```bash
yarn maintenance status
```

`status` checks the migration ledger, SQLite integrity, foreign keys, queue
state, claim coverage, audit relationships, and full-text coverage. Dedupe,
payload compaction, orphan-media cleanup, and optional vacuuming have no manual
mutation path.

## Provider notes

ImmoScout uses its mobile API. The other providers use CloakBrowser. On a
datacenter host, a German residential proxy may be needed; store it in the
`proxyUrl` application setting. Supported formats include:

```text
http://user:pass@host:port
socks5://user:pass@host:port
```

Leave the setting empty to connect directly.
