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
  A["Scheduled job discovery"] --> B["Detail queue"]
  B --> C["Capture and deterministic filters"]
  C --> D["Parsing queue"]
  D --> E["LLM extraction and geocoding"]
  E --> F["Canonical listing"]
  F --> G["Rating queue"]
  G --> H["Ridge and GBM scores"]
  H --> I["Notification outbox"]
  I --> J["Telegram"]
```

Discovery uses the interval configured in the application settings. Detail
capture, parsing, rating, and notification are independent durable consumers:
each item has a lease, bounded retry, terminal state, and audit record. Process
restarts do not strand accepted listings.

Market training is the application's only cron task. Everything else runs from
application intervals, queue wakeups, or exact persisted timers.

## Data policy

The SQLite schema has one current migration:
`lib/services/storage/migrations/sql/100.current-schema.js`. It creates a clean
database from scratch and reconciles an existing production database in place
without deleting listings.

- `listing_texts` permanently keeps one richest full-text capture per listing.
  Transient queue copies are cleared after the listing reaches a terminal
  state.
- Listing images are converted to WebP, capped at 20 KB, named by SHA-256, and
  shared by content. Manual maintenance can remove files no database row
  references.
- Source observations and LLM calls retain hashes, byte counts, outcomes, and
  timing rather than duplicating raw pages, prompts, or responses.
- Source URLs, filter decisions, processing attempts, merges, scores, and
  notification results remain auditable.
- There is no historical backfill pipeline and no automatic payload-retention
  cleanup.

The upgrade preserves the existing database file. SQLite does not return freed
pages to the filesystem automatically; use the explicit maintenance command
with `--vacuum` during an exclusive maintenance window if physical compaction
is wanted.

## Docker

```bash
docker run -d --name shoberfredy \
  --env-file .env.local \
  -v shoberfredy_conf:/conf \
  -v shoberfredy_db:/db \
  -p 9998:9998 \
  ghcr.io/jhytabest/shoberfredy:master
```

Open <http://localhost:9998>. The first account is the local administrator.
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

The most useful environment settings are:

| Setting                                      |          Default | Purpose                                         |
| -------------------------------------------- | ---------------: | ----------------------------------------------- |
| `FREDY_MARKET_MODEL_CRON`                    |      `0 2 * * *` | Daily market training schedule; `0` disables it |
| `FREDY_MARKET_MODEL_RUN_TIMEOUT_MS`          |        `1800000` | Maximum training duration                       |
| `FREDY_MARKET_EXPORTER_PORT`                 |           `9217` | Prometheus endpoint; `0` disables it            |
| `FREDY_MARKET_INTERVAL_LEVEL`                |            `0.8` | Target prediction-interval coverage             |
| `FREDY_LLM_DAILY_LIMIT`                      |           `1000` | Persistent UTC-day LLM request budget           |
| `FREDY_LLM_VISION_ENABLED`                   |              `0` | Enable supplemental gallery analysis            |
| `FREDY_LLM_MAX_TEXT_CHARS`                   |          `24000` | Maximum visible-text evidence per request       |
| `FREDY_LLM_MAX_EMBEDDED_CHARS`               |          `24000` | Maximum embedded JSON evidence per request      |
| `FREDY_OPENROUTER_REQUESTS_PER_MINUTE`       |             `18` | Local LLM rate limit                            |
| `FREDY_DISCOVERY_MAX_PAGES`                  | provider default | Maximum pages per provider run                  |
| `FREDY_DETAIL_FETCH_ENABLED`                 |              `1` | Detail worker kill switch                       |
| `FREDY_LLM_ENABLED` / `FREDY_PARSER_ENABLED` |              `1` | Parsing kill switches                           |
| `FREDY_RATING_ENABLED`                       |              `1` | Rating worker kill switch                       |
| `FREDY_NOTIFICATION_ENABLED`                 |              `1` | Notification worker kill switch                 |

Worker idle delays, item deadlines, retry ceilings, and provider circuit
breaker thresholds also have `FREDY_*` overrides in their owning modules.

## Local development

Node.js 22 or newer is required.

```bash
yarn install
yarn start:backend
yarn start:frontend
```

Quality checks:

```bash
yarn format:check
yarn lint
yarn build:frontend
```

CI runs all three checks, builds the Docker image, starts it through the real
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
in-flight requests, or login sessions.

## Maintenance

Commands are read-only unless `--apply` is present:

```bash
yarn maintenance status
yarn maintenance dedupe
yarn maintenance dedupe --apply
yarn maintenance clean
yarn maintenance clean --apply
yarn maintenance clean --apply --vacuum
```

`status` checks the migration ledger, SQLite integrity, foreign keys, queue
state, audit relationships, and full-text coverage. `clean --apply` clears
terminal transient payloads and removes orphaned content-addressed image
files. `--vacuum` additionally compacts the database file and requires
exclusive access.

## Provider notes

ImmoScout uses its mobile API. The other providers use CloakBrowser. On a
datacenter host, a German residential proxy may be needed; configure it in
Settings → Execution. Supported formats include:

```text
http://user:pass@host:port
socks5://user:pass@host:port
```

Leave the setting empty to connect directly.
