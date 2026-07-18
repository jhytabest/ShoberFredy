# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Fredy is a self-hosted real estate finder for Germany. It scrapes ImmoScout24, Immowelt, Kleinanzeigen, and WG-Gesucht, deduplicates results across providers, and sends notifications via Slack, Telegram, Email, Discord, ntfy, etc. It includes a React web UI and a built-in MCP server for LLM access to listings data.

- Node.js >= 22, ESM-only (`"type": "module"`)
- Default port: 9998, default login: admin / admin
- SQLite via `better-sqlite3` (synchronous - all DB ops are sync; only network I/O is async)

## Commands

```bash
# Development
yarn run start:backend:dev    # nodemon backend
yarn run start:frontend:dev   # Vite dev server (proxies /api → :9998)

# Production
yarn run start:backend        # NODE_ENV=production node index.js
yarn run build:frontend       # vite build → ui/public/

# Tests
yarn test                     # Live tests (hits actual providers)
yarn test:offline             # Offline tests using HTML/JSON fixtures (fast, preferred)
yarn test:download-fixtures   # Re-download fresh provider HTML fixtures

# Single test file
TEST_MODE=offline npx vitest run test/provider/immoscout.test.js

# Lint / Format
yarn lint && yarn lint:fix
yarn format && yarn format:check

# DB migrations
yarn migratedb
```

## Architecture

### Core data flow

```
index.js (startup)
  ├── runMigrations()
  ├── getProviders()            # lazily imports lib/provider/*.js
  ├── similarityCache.init()    # preloads hash cache from DB
  ├── api.js                    # starts fastify HTTP server
  ├── initJobExecutionService() # registers event-bus listeners + starts scheduler
  ├── startParserWorker()       # continuous live-first durable parser
  └── startNotificationDispatcher() # independent hourly digest timer

scheduler (every N minutes) or manual trigger via POST /api/jobs/:id/run
  └── FredyPipelineExecutioner.execute()
      1. queryStringMutator(url)           # inject sort-by-date param
      2. provider.getListings()            # API or Puppeteer+Cheerio
      3. provider.normalize(listing)       # raw → ParsedListing
      4. provider.filter(listing)          # broken-row filter + required fields
      5. filter to hashes not in DB or parsing queue
      6. provider.captureDetails()         # complete API/HTML evidence
      7. optimize gallery to <=20 KB WebP
      8. enqueue persistent parsing capture

parser worker (continuous, live before backfill, LLM-only)
  vision LLM (live only, 1 request) → text LLM (1 request)
  → geocode/filter/dedupe/score → canonical listing + notification outbox
  Consumes the queue exactly as fast as the LLM budget allows: budget/429
  exhaustion defers items (no failure accounting) until the reset.

notification dispatcher (hourly)
  └── digest of all pending deliveries with structured fields, comments,
      and persisted model scores; idempotent per adapter
```

### Plugin systems

**Providers** (`lib/provider/*.js`) - each module exports:

- `metaInformation` - `{ id, name, baseUrl }`
- `config` - `ProviderConfig` with `requiredFieldNames`, `crawlContainer`, `crawlFields`, `sortByDateParam`, `normalize()`, `filter()`, `captureDetails()`, optional `getListings()` and `activeTester()`
- `init(sourceConfig, blacklist)` - called before each job run; providers are **stateful modules** holding mutable `url` and `appliedBlackList` at module scope

**Notification adapters** (`lib/notification/adapter/*.js`) - each exports:

- `config` - `{ id, name, description, fields }` (drives the UI form)
- `send({ serviceName, newListings, notificationConfig, jobKey, baseUrl })`
- Loaded dynamically at startup via `fs.readdirSync`

### Key services

| Service          | Location                                   | Notes                                                                                |
| ---------------- | ------------------------------------------ | ------------------------------------------------------------------------------------ |
| Event bus        | `lib/services/events/event-bus.js`         | Plain `EventEmitter`; events: `jobs:runAll`, `jobs:runOne`, `jobs:status`            |
| SSE broker       | `lib/services/sse/sse-broker.js`           | Per-userId `Set<ServerResponse>`; heartbeat every 25s; pushes job status to UI       |
| Similarity cache | `lib/services/similarity-check/`           | In-memory SHA-256 Set; refreshes hourly; cross-provider dedup by title+price+address |
| SqliteConnection | `lib/services/storage/SqliteConnection.js` | Singleton, WAL mode; `execute()`, `query()`, `withTransaction()`                     |
| Migrations       | `lib/services/storage/migrations/`         | Numbered JS files each exporting `up(db)`; checksum-tracked in `schema_migrations`   |
| Extractor        | `lib/services/extractor/`                  | Orchestrates Puppeteer + Cheerio; shared browser instance per job                    |

### Frontend

- React 19 SPA, Vite build → `ui/public/` (served as static by backend)
- State: Zustand single store with per-domain slices
- UI library: `@douyinfe/semi-ui`
- Map: MapLibre GL + `@mapbox/mapbox-gl-draw` + `@turf/boolean-point-in-polygon` for GeoJSON polygon filters
- In dev: Vite proxies `/api` to `:9998`

### MCP server

Two transports:

1. **stdio** (`lib/mcp/stdio.js`) - for Claude Desktop/LM Studio; opens its own DB connection (main process need not be running)
2. **HTTP** (`/api/mcp`) - authenticated via Bearer token (`mcp_token` column in `users` table)

Tools: `list_jobs`, `get_job`, `list_listings`, `get_listing`, `get_current_date_time`. Responses are Markdown via `lib/mcp/mcpNormalizer.js`.

## Key Conventions

- **ESM only** - `import`/`export` everywhere, no CommonJS
- **JSDoc typedefs** (no TypeScript) in `lib/types/` - `listing.js`, `job.js`, `filter.js`, `providerConfig.js`
- **Copyright header** required on all `.js` files - enforced by `lint-staged` pre-commit hook via `copyright.js`
- **`NoNewListingsWarning`** (`lib/errors.js`) is used as control flow to short-circuit the pipeline (not an error)
- **Test fixtures** in `test/testFixtures/` - HTML/JSON snapshots per provider; `TEST_MODE=offline` mocks `puppeteerExtractor` and global `fetch` via `test/offlineFixtures.js`
- **`conf/config.json`** is the only runtime config file; created with defaults if missing

## Shoberfredy additions (this fork)

Storage policy: EVERY non-duplicate listing is stored; job filters (blacklist,
specs, spatial) only set `listings.hidden_reason` ('blacklist' | 'spec_filter'
| 'area_filter' | 'no_coordinates'; NULL = visible). Only visible listings are
notified. Duplicates (similarity cache + cross-portal DB check in
`lib/services/listings/dedupe.js`) are never stored; the cache is checked
read-only during finalize and committed only after a successful store, so
retries stay idempotent. TWO market models ('ridge' and 'gbm' families,
trained as equals — see below) score every listing pre-save; the per-family
scores are persisted with the listing (`storeListings` →
`homeserver_listing_model_scores`, migration 26) and the hourly digest
renders both onto the score line from the persisted rows.

Extraction is LLM-only (`lib/services/pipeline/listingSchema.js`, migration
28): every listing gets exactly one vision request (live items with stored
images) and one text request against OpenRouter. The schema is strictly
structured — enum-constrained `listing_type`/`property_type`/`condition`/
`heating_type`/`energy.class`/amenity vocabulary, numeric sanity ranges, a
normalized `availability` enum + ISO `available_from` — plus a free-text
`comments` field capturing everything that does not fit the fields
(persisted in `listing_attributes.comments`, shown in notifications). There
is no deterministic parsing fallback; `lib/services/scoring/listingAttrs.js`
survives only as a dependency of historical migration 24.

LLM budget (`lib/services/pipeline/llmBudget.js`, table `llm_budget_usage`):
every OpenRouter request consumes one unit of `FREDY_LLM_DAILY_LIMIT`
(default 1000/day, persisted per UTC day). Backfill may use at most
`FREDY_LLM_BACKFILL_SHARE` (default 0.5) of it; live always has priority and
may consume everything. Budget exhaustion and upstream 429s are never
failures: the queue defers (`deferQueue`, no attempt accounting) and waits
for the reset. Backfill parses text-only and is driven by
`tools/parsing/backfill.js` (enqueue|status|pause|resume); re-enqueueing
under a bumped `PIPELINE_SCHEMA_VERSION` supersedes unfinished older rows.

Single-container architecture — index.js also starts, in-process:

- Prometheus market exporter on :9217 (`lib/services/market/metricsExporter.js`, `FREDY_MARKET_EXPORTER_PORT`, 0 disables)
- daily market model retrain (`lib/services/market/marketModel.js`, `FREDY_MARKET_MODEL_INTERVAL_SECONDS`, 0 disables)

Geocoding is Google-only (`GOOGLE_GEOCODING_API_KEY`) and runs in the parser,
after capture. Temporary failures retry durably and do not affect scraping.
Cache table: homeserver_geocode_cache. Blacklist evaluation uses the complete
captured listing description.

Market models (dual, equals): one shared corpus
(`lib/services/market/corpus.js`: cold-equivalent-rent target — parsed
Kaltmiete / declared cold / warm-minus-charges imputation; warm-without-
breakdown and unknown prices are scored but never trained on; MAD-based
outlier trim; duplicate clusters; rows without coordinates kept). Families:
`ridge` (`models/ridgeModel.js`, standardized robust ridge + spatial residual
field, λ and recency half-life by spatially blocked CV) and `gbm`
(`models/gbmModel.js` + `tools/market/train_gbm.py`, LightGBM quantile
regression in a short-lived Python child process, scored in-process by the
pure-JS `models/gbmTreeEvaluator.js`; Python is never on the scrape path and
a missing Python/LightGBM only skips the gbm retrain). Both carry Mondrian
split-conformal intervals (per coordinate-quality tier: trusted/coarse/
missing; level via `FREDY_MARKET_INTERVAL_LEVEL`, default 0.8), are evaluated
on identical spatially-blocked folds (MdAPE/PPE10 + interval coverage/width,
per-family rows in `homeserver_model_runs`), and persist artifacts in the
`homeserver_models` registry read by `lib/services/scoring/marketScore.js`.
Trainers read stored listing_attributes exclusively (no text re-parsing).
Artifacts are validated structurally (feature-vector length), not by version
strings.

CLIs: `tools/market/geocoderBackfill.js` (run|status|refresh-all; manual only), `tools/market/marketModel.js` (run|daemon|status), `tools/migrate/importLegacyDb.js --source <db>` (legacy fredy DB import). Deployment: `doc/DEPLOYMENT.md`.

## Coding

- After building the task, run the linter
- After building the task, run the tests
- New features must be tested
- New features must be properly documented with JsDoc
- You do **not** commit any changes, you do **not** create a new branch unless I told you so
