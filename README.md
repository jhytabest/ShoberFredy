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

### One advert, one extraction, one verdict per job

Work is keyed by advert, not by (job, advert). Three searches that all find the
same flat meet at the same `pipeline_work` row, so it is fetched once and given
to the LLM once. What differs per job is the _verdict_, and that is a row in
`listing_verdicts` — so a flat inside one search's polygon and outside another's
is accepted by the first and rejected by the second, without either one hiding
or reviving the listing on the other's behalf.

Every stage asks the same question before it spends anything: has this advert
already been decided, under this job's configuration, on evidence that has not
changed? The answer is stored against the advert's identity claims and is
consulted at discovery, at detail capture, before the LLM call, and before
rating.

Filtering is deliberately uneven, because the stages differ in what they cost:

| Stage      | Filters on                                                      | Costs        |
| ---------- | --------------------------------------------------------------- | ------------ |
| Card       | Blacklist and specification, over what the card states          | nothing      |
| Extraction | Structured LLM fields, and geography from the canonical address | one LLM call |

There is no text matching after extraction. The model already answers "is this a
swap, a sublet, a WG room, furnished, fixed-term?" as validated enum fields, and
grepping the page for the same thing asks twice and believes the worse answer.

An advert refused at the card stage never becomes a listing. It is recorded in
`source_rejections` together with the claims that identify it, which is what
stops it being fetched and refused again on the next capture whose page text
differs.

Geography is decided exactly once, after extraction, from the address the model
read. The detail stage used to geocode a scraped address and refuse adverts
outside every interested job's polygons, which meant guessing the location from
the worst evidence available to save a page it had already fetched — and often
guessing from a district centroid, one point standing for a whole neighbourhood.

## Data policy

The SQLite schema has one current migration:
`lib/services/storage/migrations/sql/100.current-schema.js`. It creates a clean
database from scratch, and converts the one shape that preceded it — the release
where a listing carried its own verdict — in place. That conversion moves
never-extracted rejections out of `listings` into `source_rejections`,
synthesises a per-job verdict for every surviving listing from what the old
schema recorded, and merges rows that were separate only because two jobs found
the same advert. Foreign keys are suspended while it runs, because a table whose
shape must change has to be rebuilt, and referential integrity is asserted before
it commits.

- `listings` holds extractions only. A listing exists once the LLM has read the
  advert; what each job decided about it is a `listing_verdicts` row, and an
  advert refused before extraction is a `source_rejections` row instead.
- A listing that stops being advertised becomes `gone`. Scheduled maintenance
  re-fetches the oldest still-active listings; the probe is a page fetch and
  nothing else, so confirming a flat is still up costs no LLM call.
- Blacklist terms are one deployment-wide setting. Jobs carry only the two
  things that are genuinely theirs, a spatial filter and a specification.
- `pipeline_work.status` is lifecycle only. What became of an item is `outcome`,
  why is `outcome_code` from a closed vocabulary, and `last_error` holds an
  exception message or nothing at all.
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
<http://localhost:9998/health>; listings are delivered through Telegram. Besides
liveness it reports, without either being able to fail a deploy, how long ago
each provider last returned listings and the data-integrity verdict scheduled
maintenance last recorded.
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

| Variable                   | Default   | Purpose                                   |
| -------------------------- | --------- | ----------------------------------------- |
| `GOOGLE_GEOCODING_API_KEY` | `(unset)` | Google Geocoding key.                     |
| `OPENROUTER_API_KEY`       | `(unset)` | OpenRouter key; required for LLM parsing. |

#### Kill switches

| Variable                     | Default | Purpose                                            |
| ---------------------------- | ------- | -------------------------------------------------- |
| `FREDY_DETAIL_FETCH_ENABLED` | `true`  | Set 0 to stop draining detail work.                |
| `FREDY_LLM_ENABLED`          | `true`  | Set 0 to disable the LLM entirely (parsing stops). |
| `FREDY_MAINTENANCE_ENABLED`  | `true`  | Set 0 to stop scheduled maintenance work items.    |
| `FREDY_NOTIFICATION_ENABLED` | `true`  | Set 0 to stop notification delivery.               |
| `FREDY_PARSER_ENABLED`       | `true`  | Set 0 to stop the LLM parser worker.               |
| `FREDY_RATING_ENABLED`       | `true`  | Set 0 to stop market rating.                       |

#### Discovery and the work queue

| Variable                             | Default    | Purpose                                                                          |
| ------------------------------------ | ---------- | -------------------------------------------------------------------------------- |
| `FREDY_DETAIL_ITEM_TIMEOUT_MS`       | `300000`   | Deadline for one detail capture.                                                 |
| `FREDY_DETAIL_MAX_FAILURES`          | `8`        | Attempts before a detail item is abandoned.                                      |
| `FREDY_DISCOVERY_MAX_PAGES`          | `20`       | Override the per-provider page ceiling; unset uses the provider's own limit (3). |
| `FREDY_DISCOVERY_TIMEOUT_MS`         | `120000`   | Deadline for one provider discovery run.                                         |
| `FREDY_PARSER_ITEM_TIMEOUT_MS`       | `300000`   | Deadline for one parse (text + repair).                                          |
| `FREDY_PARSER_MAX_ITEM_FAILURES`     | `8`        | Attempts before a parse item is abandoned.                                       |
| `FREDY_NOTIFICATION_ITEM_TIMEOUT_MS` | `120000`   | Deadline for one notification digest.                                            |
| `FREDY_NOTIFICATION_BATCH_SIZE`      | `50`       | Deliveries considered for one digest.                                            |
| `FREDY_RATING_ITEM_TIMEOUT_MS`       | `30000`    | Deadline for one market rating.                                                  |
| `FREDY_MAINTENANCE_ITEM_TIMEOUT_MS`  | `1800000`  | Deadline for automatic database upkeep.                                          |
| `FREDY_WORK_IDLE_POLL_MS`            | `1000`     | Idle sleep between empty work-queue polls.                                       |
| `FREDY_WORK_MAX_BACKOFF_MS`          | `3600000`  | Ceiling on retry backoff for work items.                                         |
| `FREDY_WORK_MAX_DEFERRALS`           | `24`       | Parks on a resource before work is abandoned.                                    |
| `FREDY_WORK_MAX_PARK_MS`             | `86400000` | Age at which parked work is abandoned regardless of park count.                  |
| `FREDY_RATE_MAX_FAILURES`            | `5`        | Attempts before a rating item is abandoned.                                      |
| `FREDY_MAINTENANCE_MAX_FAILURES`     | `3`        | Attempts before a maintenance item is abandoned.                                 |
| `FREDY_MARKET_MODEL_MAX_FAILURES`    | `3`        | Attempts before a training item is abandoned.                                    |
| `FREDY_NOTIFY_MAX_FAILURES`          | `6`        | Attempts before a notification is abandoned.                                     |
| `FREDY_WORKER_RESTART_DELAY_MS`      | `5000`     | Delay before restarting a crashed worker loop.                                   |

#### LLM

| Variable                               | Default  | Purpose                                     |
| -------------------------------------- | -------- | ------------------------------------------- |
| `FREDY_LLM_DAILY_LIMIT`                | `1000`   | Daily LLM request budget (UTC days).        |
| `FREDY_LLM_MAX_EMBEDDED_CHARS`         | `24000`  | Cap on embedded JSON sent to the LLM.       |
| `FREDY_LLM_MAX_LISTING_FAILURES`       | `5`      | LLM attempts before a listing is abandoned. |
| `FREDY_LLM_MAX_TEXT_CHARS`             | `24000`  | Cap on captured page text sent to the LLM.  |
| `FREDY_LLM_REQUEST_TIMEOUT_MS`         | `120000` | Deadline for a single LLM request.          |
| `FREDY_LLM_TEXT_MODEL`                 | _unset_  | OpenRouter model id for text extraction.    |
| `FREDY_LLM_UPSTREAM_BACKOFF_MS`        | `60000`  | Backoff after an upstream LLM rate limit.   |
| `FREDY_OPENROUTER_REQUESTS_PER_MINUTE` | `18`     | Client-side OpenRouter rate limit.          |

#### Filters and geocoding

| Variable                                 | Default | Purpose                                                                                  |
| ---------------------------------------- | ------- | ---------------------------------------------------------------------------------------- |
| `FREDY_GEOCODER_RETRY_COARSE_AFTER_DAYS` | `14`    | Age at which a coarse geocode retries.                                                   |
| `FREDY_CARD_FILTER_AUDIT_RATE`           | `0.03`  | Fraction of card-stage refusals let through to extraction so the refusal can be checked. |

#### Provider circuit breaker

| Variable                                 | Default    | Purpose                                                                           |
| ---------------------------------------- | ---------- | --------------------------------------------------------------------------------- |
| `FREDY_PROVIDER_BREAKER_COOLDOWN_MS`     | `1800000`  | Initial provider pause duration.                                                  |
| `FREDY_PROVIDER_BREAKER_FAILURES`        | `2`        | Failed discovery runs before a provider is paused.                                |
| `FREDY_PROVIDER_BREAKER_ITEM_CHALLENGES` | `8`        | Challenged single requests, with no success between, before a provider is paused. |
| `FREDY_PROVIDER_BREAKER_MAX_COOLDOWN_MS` | `21600000` | Ceiling on provider pause.                                                        |

#### Market model and metrics

| Variable                              | Default     | Purpose                                                   |
| ------------------------------------- | ----------- | --------------------------------------------------------- |
| `FREDY_MARKET_DB_PATH`                | _unset_     | Override the market SQLite path (defaults to app db).     |
| `FREDY_MARKET_EXPORTER_PORT`          | `9217`      | Prometheus exporter port; 0 disables it.                  |
| `FREDY_MARKET_INTERVAL_LEVEL`         | `0.8`       | Conformal interval coverage level.                        |
| `FREDY_MARKET_MODEL_CRON`             | `0 2 * * *` | Market training schedule; "0" disables training entirely. |
| `FREDY_MARKET_MODEL_INTERVAL_SECONDS` | `86400`     | Minimum seconds between retrains; 0 disables training.    |
| `FREDY_MARKET_MODEL_RUN_TIMEOUT_MS`   | `1800000`   | Deadline for one retrain run.                             |
| `FREDY_MARKET_SURFACE_MIN_CONFIDENCE` | `0.25`      | Minimum surface-cell confidence.                          |
| `FREDY_PYTHON_BIN`                    | `python3`   | Python used for the LightGBM trainer.                     |

#### Maintenance

| Variable                         | Default     | Purpose                                                                      |
| -------------------------------- | ----------- | ---------------------------------------------------------------------------- |
| `FREDY_DB_VACUUM`                | `false`     | Set 1 to VACUUM during scheduled maintenance.                                |
| `FREDY_MAINTENANCE_INTERVAL_MS`  | `86400000`  | Spacing between maintenance work items.                                      |
| `FREDY_LIVENESS_CHECKS_PER_PASS` | `200`       | Stale listings re-fetched per pass to see whether they are gone. 0 disables. |
| `FREDY_LIVENESS_STALE_AFTER_MS`  | `604800000` | Age at which an active listing is re-checked for liveness.                   |

#### Runtime and tooling

| Variable                          | Default       | Purpose                                                         |
| --------------------------------- | ------------- | --------------------------------------------------------------- |
| `CLOAKBROWSER_BINARY_PATH`        | _unset_       | Explicit CloakBrowser Chromium path.                            |
| `CLOAKBROWSER_CACHE_DIR`          | _unset_       | CloakBrowser download cache directory.                          |
| `FREDY_DOCKER`                    | `false`       | Set by the container image to signal a Docker deployment.       |
| `MIGRATION_ALLOW_CHECKSUM_UPDATE` | `false`       | Permit rewriting the recorded checksum of an applied migration. |
| `NODE_ENV`                        | `development` | Node environment; "production" quiets debug logging.            |

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

The live database can be snapshotted into `db/listings.db` without stopping or
writing to production:

```bash
tools/mirror-live.sh
```

It runs `VACUUM INTO` inside the live container over SSH — a plain file copy of a
WAL-mode database silently drops whatever is still in the write-ahead log — then
downloads the result and removes the remote temporary file. The source is opened
read-only. Set `SHOBERFREDY_MIRROR_HOST` (default `hs`) and
`SHOBERFREDY_MIRROR_CONTAINER` (default `fredy`) to point it elsewhere.

This is the only place a schema change is exercised against real data. CI builds
the image and requires a healthy `/health`, but it does so against an empty
database, so it validates migration-from-scratch and nothing else.

```bash
tools/mirror-live.sh                       # snapshot production
cp db/listings.db ~/pre-migration.db       # before anything destructive
yarn migratedb                             # the real migration path
yarn maintenance status                    # exit 0 == healthy
```

The snapshot contains durable state, not process memory, open connections, or
in-flight requests.

## Maintenance

Database upkeep runs automatically as durable pipeline work. The only operator
command is read-only:

```bash
yarn maintenance status
```

`status` checks the migration ledger, SQLite integrity, foreign keys, queue
state, claim coverage, audit relationships, and full-text coverage. Dedupe,
payload compaction, orphan-media cleanup, terminal work-row pruning, and optional
vacuuming have no manual mutation path.

The scheduled pass records its verdict, and `/health` serves that recorded
verdict with its age rather than recomputing an integrity check on every liveness
probe — the two surfaces report one answer about one database. Finished work rows
are pruned after 30 days; anything still pending, retrying or leased is never
touched. Orphaned media are images no `listing_images` row references, so the
first pass after a long gap can remove a great deal at once.

## Provider notes

ImmoScout uses its mobile API. The other providers use CloakBrowser. On a
datacenter host, a German residential proxy may be needed; store it in the
`proxyUrl` application setting. Supported formats include:

```text
http://user:pass@host:port
socks5://user:pass@host:port
```

Leave the setting empty to connect directly.

Immowelt declares `requiresProxy` in its provider metadata, so it is the one
provider that will not run without one: on a bare datacenter IP it answers every
search with an HTTP 403 bot challenge and no cards, which is indistinguishable
from changed markup and drives the circuit breaker to its six-hour ceiling.
While `proxyUrl` is empty, discovery skips Immowelt and already-queued Immowelt
detail captures wait rather than spending their failure budget. Filling the
setting in resumes both on the next run — no restart, no queue surgery.
