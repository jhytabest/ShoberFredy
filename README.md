# Shoberfredy

Shoberfredy is a private homeserver application that discovers German rental
adverts from ImmoScout24, Kleinanzeigen and WG-Gesucht and sends suitable homes
to Telegram. It began as a fork of [Fredy](https://github.com/orangecoding/fredy)
by Christian Kellner. Preserve the copyright notices and the licence's
attribution terms; see [LICENSE](LICENSE).

## One shared pipeline

```mermaid
flowchart LR
  J[Discovery jobs] --> D[Advert identity]
  D --> C[Capture and normalize]
  C --> E[Standardized extraction]
  E --> G[Optional geocoding]
  G --> M[Safe canonical deduplication]
  M --> F[Global feature filter]
  F --> T[Telegram outbox]
```

Jobs are search inputs only: name, city, provider URLs, interval, working hours
and enabled state. Overlapping jobs meet at one `(provider, external advert ID)`
source. Discovery origins are retained as provenance; changing or deleting a job
does not cancel queued processing, erase captured facts or change delivery.
Cadence remains per job/provider, with persisted schedules and a single discovery
lane per provider. The durable workers can run concurrently, while each advert
follows the same sequence with no job fan-out.

Capture selects advert content and removes result counts, relative online ages,
navigation and recommendations before fingerprinting. Tracking links and images
do not reset discovery work. Unchanged discoveries only refresh observation
times. Identical normalized text reuses extraction under the same schema and
prompt version. A failed extraction has a bounded retry budget; changed content
or extraction version creates fresh work, while a filter change never calls the
model.

Extraction standardizes facts independently of preferences. The current model is
`nvidia/nemotron-3-ultra-550b-a55b:free`. It uses context to judge Altbau, furnishing,
condition, tenancy and other semantic features. There is no fixed Altbau year
cutoff and no citation protocol. Numeric facts must not be invented. Unknown
facts remain null/unknown/unstated; unknown amenities are omitted. Shape, types,
basic numeric/date sanity and bounded malformed-output retries are retained.
Captured text, model/version provenance and request/response audits remain
available for inspection.

## Shared policy

`pipeline_config` holds one filter document and one Telegram configuration.
The pure filter reads standardized features only. Every known violation is
recorded on one global `listing_decisions` row. Null/unknown/unstated values pass.

| Filter | Default rejection |
| --- | --- |
| `minSize` | Known size below 60 m² |
| `maxColdRent` | Known cold rent above €2,500; warm rent is never substituted |
| `excludeSwap` | Swap offer |
| `excludeRooms` | Private/shared room |
| `excludeSublet` | Sublet |
| `excludeFixedTerm` | Fixed-term letting |
| `excludeFurnished` | Fully furnished; partial/none/unknown pass |
| `excludeNonAltbau` | Classified non-Altbau; unknown passes |
| `spatialFilter` | House-level geocode outside every Polygon |

Boolean exclusions default to true. Numeric limits accept a positive number or
null; polygons accept a GeoJSON FeatureCollection or null. Street, district,
postcode and unknown geocodes cannot exclude a listing. A geocoding outage leaves
location unknown and processing continues. Floors, condition, advertiser type and
other amenities remain useful facts, but have no filter rules. There are no
card-stage refusals, free-text blacklists or positive-category whitelists.

```bash
yarn maintenance pipeline show
yarn maintenance pipeline patch '{"filters":{"maxColdRent":2500,"minSize":60}}'
yarn maintenance pipeline patch '{"notify":{"token":"...","chatId":"-100...","threadId":null,"plainText":false}}'
```

The editor validates values and redacts Telegram secrets. Patches merge supplied
filter/notification fields; set a nullable field to null to clear it. Policy or
destination changes reevaluate post-cutover stored facts without re-extraction.
The initial migration takes the union of existing job polygons and moves their
identical Telegram settings into the shared configuration. Conflicting Telegram
settings stop migration instead of silently choosing a destination.

## Identity and delivery

Provider IDs and canonical advert URLs establish primary identity. Different
advert IDs merge only with at least two shared image hashes, compatible market
and address, no known room/floor conflict, and known size agreement within 1%
(capped at 1 m²). When both rents have the same cold/warm basis they must agree
within 5%. Coordinates and title/price/size equality alone never establish
identity. Floor can distinguish units while remaining irrelevant to suitability.
Merge audit events record the claim and shared-image count. Representative
facts, link and image come from the same source extraction.

The outbox has one permanent key per `(canonical listing, chat, topic)`.
Successful message receipts survive retries and overlapping discoveries cannot
create another delivery. Network failures retain ordinary retry/fallback
behavior: Telegram accepting a request whose response is lost can still cause a
duplicate. Telegram and SQLite cannot commit atomically.

## Discovery jobs

```bash
yarn maintenance jobs list
yarn maintenance jobs show <id>
yarn maintenance jobs add '{"name":"Berlin","city":"Berlin","interval":15,"workingHours":{"from":"","to":""},"provider":[{"id":"immoscout","url":"https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-mieten"}]}'
yarn maintenance jobs patch <id> '{"interval":15}'
yarn maintenance jobs enable <id>
yarn maintenance jobs disable <id>
yarn maintenance jobs remove <id>
```

Provider entries may include `maxPages`. The city anchors geocoding and provider
backoff; the returned geographic locality determines the listing's market.
Jobs cannot carry filters or notification settings. Fresh installations configure
Telegram through `pipeline patch` separately.

## Migration and archive policy

Ordered migrations are immutable after application. Migration 107 introduces
the shared stream, consolidates source rows, archives job decisions, preserves
all recorded receipts and repairs contradictory canonical groups from retained
per-source extractions. Unassignable historical associations are detached from
active matching while their audit history remains.

Historical migrations with application dependencies use a checksum-pinned
implementation in `lib/services/storage/migrations/frozen`. This preserves
their original behavior when application helpers change. New migrations must
be self-contained or use immutable migration helpers. Applied migration files,
their pinned implementations and historical delivery suppression must remain.

Migration records a cutover timestamp. Every pre-existing source is historical;
every existing canonical listing, including repaired splits, receives durable
suppression. Pre-cutover unfinished detail/parse/notify work is retired. There
is no historical replay or reprocessing wave, and rediscovery of an old advert
does not make it new. Stop the application during migration. Only newly
discovered advert identities enter the new stream.

Listings are an archive, not an availability promise. There are no liveness
probes. Canonical facts, source origins, global decisions, receipts and work rows
are durable. Operational logs, audit events, request/response bodies and terminal
capture bodies expire after 14 days. Images are content-addressed WebP files up
to 20 KB; download/decoded-size limits and single-image processing bound memory.
Referenced media expires after 14 days; upkeep also removes missing references
and old unreferenced files. Do not run a host age-pruner over `/db/media`.

Scheduled upkeep drains retention in bounded batches. Optional vacuum returns
free pages to disk. For explicit compaction, stop Fredy and run:

```bash
yarn maintenance prune-audit
```

## Docker

```bash
docker run -d --name shoberfredy \
  --env-file .env.local \
  -v shoberfredy_conf:/conf \
  -v shoberfredy_db:/db \
  -p 9998:9998 \
  ghcr.io/jhytabest/shoberfredy:main
```

The only HTTP surface is Docker's minimal `/health` endpoint on
`FREDY_HEALTH_PORT` (default `9998`). It responds with `ok` if the process can run
`SELECT 1`, otherwise HTTP 503. There are no worker heartbeats, service counters,
provider dashboards, integrity sweeps, alerts or custom monitoring endpoints.
Scheduling, circuit breakers, deadlines and retry backoff remain execution controls.
Event history lives in SQLite for ad hoc analysis. External Docker/Ansible
configuration belongs to the host repository; this application change does not
edit or deploy it.

The image runs as UID/GID `10001`; the supplied Compose file also uses a
read-only root filesystem, drops Linux capabilities, and enables
`no-new-privileges`.

The database lives at `/db/listings.db` and content-addressed media at
`/db/media`. Both belong to the persistent application volume. The host must not
age-prune this directory: it cannot distinguish referenced images from orphans.
Image expiry belongs to the application. Removing a host pruning rule prevents
further deletions but cannot restore files already removed. SQLite files are private to the application user.
Absolute `sqlitepath` values are honored directly; relative paths resolve from
the application directory. Local development can use `{"sqlitepath":"db"}`.

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
`lib/shared/env.js`. Reading an undeclared name throws, so nothing is read
outside that registry — but the table below is hand-maintained alongside it,
not generated from it; keep the two in sync when the registry changes.

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

#### Discovery scheduler

| Variable                            | Default  | Purpose                                                                                                                 |
| ----------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------- |
| `FREDY_SCHEDULER_TICK_MS`           | `15000`  | How often the scheduler checks for due jobs.                                                                            |
| `FREDY_DISCOVERY_CONCURRENCY`       | `3`      | Global cap on discovery runs in flight at once, across all portals.                                                     |
| `FREDY_DISCOVERY_MIN_PORTAL_GAP_MS` | `5000`   | Minimum gap between consecutive discovery hits of the same portal, across jobs.                                         |
| `FREDY_DISCOVERY_MAX_PAGES`         | `20`     | Deployment-wide page-ceiling override, under a job's own `provider[].maxPages`; unset uses the adapter's own limit (3). |
| `FREDY_DISCOVERY_TIMEOUT_MS`        | `120000` | Deadline for one provider discovery run.                                                                                |
| `FREDY_HEALTH_PORT`                 | `9998`   | Port for the `/health` HTTP server; read once at startup.                                                               |

#### The work queue

| Variable                             | Default    | Purpose                                                         |
| ------------------------------------ | ---------- | --------------------------------------------------------------- |
| `FREDY_DETAIL_ITEM_TIMEOUT_MS`       | `300000`   | Deadline for one detail capture.                                |
| `FREDY_DETAIL_MAX_FAILURES`          | `8`        | Attempts before a detail item is abandoned.                     |
| `FREDY_PARSER_ITEM_TIMEOUT_MS`       | `300000`   | Deadline for the model chain and finalization.                  |
| `FREDY_PARSER_MAX_ITEM_FAILURES`     | `8`        | Attempts before a parse item is abandoned.                      |
| `FREDY_NOTIFICATION_ITEM_TIMEOUT_MS` | `120000`   | Deadline for one notification digest.                           |
| `FREDY_MAINTENANCE_ITEM_TIMEOUT_MS`  | `600000`  | Deadline for automatic database upkeep.                         |
| `FREDY_WORK_IDLE_POLL_MS`            | `1000`     | Idle sleep between empty work-queue polls.                      |
| `FREDY_WORK_MAX_BACKOFF_MS`          | `900000`   | Ceiling on retry and park backoff for work items.               |
| `FREDY_WORK_MAX_DEFERRALS`           | `24`       | Parks on a resource before work is abandoned.                   |
| `FREDY_WORK_MAX_PARK_MS`             | `86400000` | Age at which parked work is abandoned regardless of park count. |
| `FREDY_NOTIFY_MAX_FAILURES`          | `6`        | Attempts before a notification is abandoned.                    |
| `FREDY_WORKER_RESTART_DELAY_MS`      | `5000`     | Delay before restarting a crashed worker loop.                  |

#### LLM

| Variable                               | Default  | Purpose                                                  |
| -------------------------------------- | -------- | -------------------------------------------------------- |
| `FREDY_LLM_DAILY_LIMIT`                | `1000`   | Daily LLM request budget (UTC days).                     |
| `FREDY_LLM_MAX_EMBEDDED_CHARS`         | `24000`  | Cap on embedded JSON sent to the LLM.                    |
| `FREDY_LLM_MAX_LISTING_FAILURES`       | `2`      | LLM attempts before a listing is abandoned.              |
| `FREDY_LLM_MAX_TEXT_CHARS`             | `24000`  | Cap on captured page text sent to the LLM.               |
| `FREDY_LLM_REQUEST_TIMEOUT_MS`         | `75000`  | Deadline for a single LLM request.                       |
| `FREDY_LLM_UPSTREAM_BACKOFF_MS`        | `60000`  | Initial pause after an upstream LLM request failure.     |
| `FREDY_LLM_UPSTREAM_MAX_BACKOFF_MS`    | `900000` | Maximum per-model pause after repeated request failures. |
| `FREDY_OPENROUTER_REQUESTS_PER_MINUTE` | `18`     | Client-side OpenRouter rate limit.                       |

#### Geocoding

| Variable                                 | Default | Purpose                                                                                  |
| ---------------------------------------- | ------- | ---------------------------------------------------------------------------------------- |
| `FREDY_GEOCODER_RETRY_COARSE_AFTER_DAYS` | `14`    | Age at which a coarse geocode retries.                                                   |

#### Provider circuit breaker

| Variable                                 | Default    | Purpose                                                                           |
| ---------------------------------------- | ---------- | --------------------------------------------------------------------------------- |
| `FREDY_PROVIDER_BREAKER_COOLDOWN_MS`     | `600000`  | Initial provider pause duration.                                                  |
| `FREDY_PROVIDER_BREAKER_FAILURES`        | `2`        | Failed discovery runs before a provider is paused.                                |
| `FREDY_PROVIDER_BREAKER_ITEM_CHALLENGES` | `8`        | Challenged single requests, with no success between, before a provider is paused. |
| `FREDY_PROVIDER_BREAKER_MAX_COOLDOWN_MS` | `3600000` | Ceiling on provider pause.                                                        |

#### Maintenance

| Variable                        | Default    | Purpose                                       |
| ------------------------------- | ---------- | --------------------------------------------- |
| `FREDY_DB_VACUUM`               | `false`    | Set 1 to VACUUM during scheduled maintenance. |
| `FREDY_MAINTENANCE_INTERVAL_MS` | `86400000` | Spacing between maintenance work items.       |

#### Runtime and tooling

| Variable                   | Default       | Purpose                                                   |
| -------------------------- | ------------- | --------------------------------------------------------- |
| `CLOAKBROWSER_BINARY_PATH` | _unset_       | Explicit CloakBrowser Chromium path.                      |
| `CLOAKBROWSER_CACHE_DIR`   | _unset_       | CloakBrowser download cache directory.                    |
| `NODE_ENV`                 | `development` | Node environment; "production" quiets debug logging.      |


## Runtime and operations

Use the Node.js version in `package.json`, install with `yarn install`, provide
`OPENROUTER_API_KEY` and `GOOGLE_GEOCODING_API_KEY`, then run `yarn start`.
The release workflow publishes the production image on pushes to `main` and
version tags. The HTTP surface is only `/health`, which checks database access.
There are no test suites or lint/format hooks.

ImmoScout uses its mobile API. Kleinanzeigen and WG-Gesucht use CloakBrowser.
WG-Gesucht waits for the advert details panel and excludes partner discovery ads
without a listing ID. Missing search layouts are failures, not empty results.
All providers connect directly; routing belongs to the host.

```bash
yarn maintenance resume-llm
yarn maintenance settings list
```

Transient LLM/provider outages defer work without consuming semantic extraction
attempts. Configuration failures remain paused until corrected. Audit bodies
are content-addressed; `readLlmRequest`/`readLlmResponse` reconstruct retained
requests and responses. Audit views expose availability after bodies expire.

```sql
SELECT verdict, COUNT(*) FROM listing_decisions GROUP BY verdict;
SELECT provider, outcome, COUNT(*) FROM discovery_run_audit GROUP BY provider, outcome;
SELECT model, outcome, COUNT(*) FROM llm_call_audit GROUP BY model, outcome;
SELECT reason, COUNT(*) FROM notification_suppressions GROUP BY reason;
SELECT chat_id, topic_id, COUNT(*) FROM notification_receipts GROUP BY chat_id, topic_id;
SELECT severity, event, message FROM runtime_events ORDER BY id DESC LIMIT 100;
```
