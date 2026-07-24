# Shoberfredy 🐕🏡

**Shoberfredy** is a private, shiba-inu-themed fork of
[orangecoding/fredy](https://github.com/orangecoding/fredy) tuned for a single
personal homeserver deployment (Berlin rental market). On top of upstream
Fredy it adds, natively in the source tree:

- **Google Geocoding** with a persistent cache (`homeserver_geocode_cache`),
  Berlin-aware plausibility checks, and fail-open behavior when Google is
  unavailable (listings are kept, not silently dropped by the spatial filter).
- **Durable market rating**: every LLM-parsed listing is queued and priced
  against a persisted hedonic + spatial-residual model; notifications carry a
  `Model: … €/m² vs fair … €/m²` metrics line.
- **Cross-portal dedupe**: a flat already accepted by the same search job in
  the last 7 days absorbs the new portal source instead of being re-notified.
- **Market model daemon** (`yarn market:model:daemon`): geo-surface-v3 robust
  ridge regression + adaptive kernel residual field, with holdout/spatial-CV
  self-evaluation, surface GeoJSON for Grafana.
- **Prometheus exporter** (`yarn market:exporter`): market, scraper-health,
  geocode and prediction metrics on `:9217/metrics`.
- **Durable LLM-only listing pipeline**: paginated discovery, separately queued
  full-detail capture, required audited OpenRouter text extraction, queued
  market rating, and an idempotent notification outbox. Discovery-card values
  never become canonical listing facts.
- **Rate-limited historical reparse** (`yarn parsing:backfill enqueue`) plus the
  geocode backfill and legacy database import tools.
- Token-aware German blacklist matching (`wg`, `befristet`) and SQLite
  `busy_timeout` for multi-process access.

Upstream docs below still apply. Credit and license: Christian Kellner,
Apache-2.0 with Commons Clause and Attribution/Naming Clause.

---

<p align="center">

<a href="https://fredy.orange-coding.net/">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://github.com/orangecoding/fredy/blob/master/doc/logo_white.png" width="400">
  <source media="(prefers-color-scheme: light)" srcset="https://github.com/orangecoding/fredy/blob/master/doc/logo.png" width="400">
  <img alt="Jetbrains Open Source" src="https://github.com/orangecoding/fredy/blob/master/doc/logo.png">
</picture>
</a>
</p>

<p align="center">
  <a href="https://fredy.orange-coding.net/" target="_blank">Website</a>
</p>

# Fredy 🏡 - Your Self-Hosted Real Estate Finder for Germany

Finding an apartment or house in Germany can be stressful and
time-consuming.\
**Fredy** makes it easier: it automatically scrapes **ImmoScout24,
Immowelt, eBay Kleinanzeigen, and WG-Gesucht** and notifies you
instantly via **Telegram** when new listings appear.

With a modern architecture, Fredy provides a **clean Web UI**, removes
duplicates across platforms, and stores results so you never see the
same listing twice.

---

## ✨ Key Features

- 🏠 Scrapes **ImmoScout24, Immowelt, eBay Kleinanzeigen,
  WG-Gesucht**
- ⚡ Instant Telegram notifications
- 🔎 Uses the **ImmoScout Mobile API** (reverse engineered)
- 🌍 Runs anywhere: Docker, Node.js, self-hosted
- 🖥️ Intuitive **Web UI** to manage searches
- 🎯 Easy to use thanks to a user-friendly Web UI
- 🔄 Deduplication across platforms
- ⏱️ Customizable search intervals

---

## 🤝 Sponsorship [![](https://img.shields.io/static/v1?label=Sponsor&message=❤&logo=GitHub&color=%23fe8e86)](https://github.com/sponsors/orangecoding)

I maintain Fredy and other open-source projects in my free time, if you find it useful, consider supporting the project ❤️

#### Support me on

[Ko-Fi](https://ko-fi.com/orangecoding) | [Github](https://github.com/sponsors/orangecoding)
----

Fredy is proudly backed by the **JetBrains Open Source Support Program**.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://www.jetbrains.com/company/brand/img/logo_jb_dos_3.svg">
  <source media="(prefers-color-scheme: light)" srcset="https://resources.jetbrains.com/storage/products/company/brand/logos/jetbrains.svg">
  <img alt="Jetbrains Open Source" src="https://resources.jetbrains.com/storage/products/company/brand/logos/jetbrains.svg">
</picture>

---

## 🚀 Quick Start

### With Docker

> [!NOTE]
> In order to start Fredy, you must provide a config.json. As a start, use the one in this repo: https://github.com/orangecoding/fredy/blob/master/conf/config.json

```bash
docker run -d --name fredy \
  -v fredy_conf:/conf \
  -v fredy_db:/db \
  -p 9998:9998 \
  ghcr.io/orangecoding/fredy:master
```

Logs:

```bash
docker logs fredy -f
```

### Manual (Node.js)

- Requirement: **Node.js 22 or higher**
- Install dependencies and start:

```bash
yarn
yarn run start:backend   # in one terminal
yarn run start:frontend  # in another terminal
```

👉 Open <http://localhost:9998>

### With Unraid

Should you use [Unraid](https://unraid.net/), you can now install Fredy from the community store :)

**Default Login:**

- Username: `admin`
- Password: `admin`

---

## 📸 Screenshots

| Fredy Maps View                                  | Dashboard                                                             | Found Listings                                                     |
| ------------------------------------------------ | --------------------------------------------------------------------- | ------------------------------------------------------------------ |
| ![Screenshot showing Fredy](doc/screenshot1.png) | ![Screenshot showing job configuration in Fredy](doc/screenshot3.png) | ![Screenshot showing found listings in Fredy](doc/screenshot2.png) |

---

## 🧩 Core Concepts

Fredy is built around three simple concepts:

### Provider 🌐

A **provider** is a real-estate platform (e.g. ImmoScout24, Immowelt,
eBay Kleinanzeigen, WG-Gesucht).\
When you create a job, you paste the search URL from the platform into
Fredy.\
⚠️ Always make sure the search results are sorted by **date**, so Fredy
picks up the newest listings first.

### Telegram 📡

Every job sends new listings to a Telegram bot and chat that you configure.

### Job 📅

A **job** combines one or more providers with its Telegram destination.\
Example: "Search apartments on ImmoScout24 + Immowelt and send results
to Telegram."\
Jobs run automatically at the interval you configure (see
`/conf/config.json`).

---

## Immoscout

Immoscout has implemented advanced bot detection. In order to work around this, we are using a reversed engineered version of their mobile api. See [Immoscout Reverse Engineering Documentation](https://github.com/orangecoding/fredy/blob/master/reverse-engineered-immoscout.md)

## Durable parsing pipeline

Scheduled jobs only paginate provider result lists and put each discovery card
in a durable detail-fetch queue. Stable provider ID and canonical URL form the
first conservative dedupe layer. A single continuous detail worker drains that
queue in FIFO order independently of future discovery runs; failures move aside
with durable backoff, so another provider can continue. A card that already
proves a blacklist/specification failure is audited and stopped immediately
after discovery dedupe, without waiting behind detail fetches. After detail capture, a
small deterministic classifier establishes trusted identity facts before the
detail dedupe checks identity-preserving URLs or a strict evidence-plus-image
identity and applies the job blacklist and specification
limits to the complete detail evidence. Pre-LLM filter matches are stored as
soft-deleted audit listings and do not spend an LLM call. CAPTCHA and bot
challenge pages are retried as acquisition failures and can never participate
in dedupe. Query-based WG fallback links retain only their `asset_id`; sort and
list-context parameters cannot create new source identities. Provider
pages marked `gelöscht` or `reserviert` are retained as inactive audit evidence
and never enter parsing. Active detail evidence is conservatively cleaned,
while the untouched raw text is retained for audit. Gallery media may be
compressed for display, but media is not part of database backups.

Every raw source has its own `listing_sources` record and immutable
discovery/detail observations. Dedupe never discards a source: it points the
source at its representative listing and merges every URL into
`listings.source_urls_json`. `pipeline_audit_events` records discovery/detail
merges, blacklist decisions, post-LLM filters, final merges, scores, and
notification outcomes.

Stored active listings receive one provider reachability check at startup and
then daily at 01:00, for at most seven days. A Kleinanzeigen page containing
`Gelöscht` or `Reserviert`, any non-success response, or a network failure ends
the listing immediately; recognized bot blocking leaves it active for the next
daily pass. Listings still active at seven days expire locally. Every transition
records `inactive_at` and `inactive_reason`.

A durable worker extracts every active listing with a required structured text
LLM request against a strict, compact schema with a free-text `comments`
overflow field. Live LLM extraction receives detail-page/API evidence only;
discovery-card values never become canonical fallbacks. Historical backfills
add their preserved discovery and legacy facts as explicitly labeled LLM
evidence, but still require the model to extract and validate every canonical
field. Vision is disabled by default and, when
explicitly enabled, is supplemental: it can never block text parsing. Validated
LLM fields then drive geocoding, a second blacklist/filter decision, final
semantic deduplication within the same job, storage, and the market model.
Rating and notification each use their own durable queue, so a process restart
cannot strand an accepted listing. A temporarily unavailable market model does not delay notification:
the listing remains in `waiting_model` and is requeued after the next successful
model training. Rating completion inserts the durable notification delivery and
wakes the dispatcher immediately. Notification retries schedule one timer for their
exact persisted due time; notifications are never polled.

Discovery rejects only malformed cards without a stable ID/link. After details,
the blacklist is applied to retained page evidence before LLM parsing. After the
required LLM extraction, the blacklist runs again against the LLM title and
retained detail evidence; specification filters use only LLM price/size/rooms,
and spatial filters use the geocoded LLM address. Deterministic pre-LLM values
never overwrite or supplement LLM fields. Rejected listings remain stored with
`hidden_reason` plus every decision in `filter_reasons_json` for audit. Filtering
is terminal: detail, LLM, rating, and pending notification work is cancelled,
while the listing, all source links, raw observations, and audit events remain.

True pre-pipeline legacy rows are handled separately from those ordinary live
filter rejects. Historical reconciliation considers only rows carrying a
legacy snapshot. Detailed, non-blacklisted listings with an exact provider or
house/street geocode confirmed inside the job polygon receive a fresh v4
backfill; all other legacy rows move atomically into compressed
`pre_llm_archive_*` tables together with their complete source, capture, queue,
LLM, score, notification, and decision history. They are then absent from the
live listing/queue graph. The archive lives in `listings.db`, so normal Fredy
backups include it, but no production worker reads it.

Backfill prompts may use clearly labeled preserved discovery-card and legacy
snapshot facts when the retained detail text omits a field. This evidence
contract is backfill-only; live extraction continues to receive detail/API
evidence exclusively. A separate all-time canonical reconciliation can absorb
historical duplicates across jobs and portals using exact source identity,
provider listing IDs, exact semantic identity, shared images, or trusted
house/street coordinates with matching size and price. Every absorbed row is
stored in `canonical_merge_archive` before its production records are attached
to the representative.

The queue is consumed exactly as fast as the LLM allows. Every request draws
from a persistent daily budget (`FREDY_LLM_DAILY_LIMIT`, default 1000 —
matching the OpenRouter free tier); backfill may spend at most
`FREDY_LLM_BACKFILL_SHARE` (default 0.8) of it. The persistent weighted queue
serves one live item and then up to three backfill items, so new listings remain
prompt while migration cannot starve. When the budget or an upstream rate limit
is exhausted, queue items wait for reset. All other failures retry indefinitely
with bounded exponential backoff and jitter; expired leases recover automatically.

Every outbound LLM request and complete response is written to
`llm_call_audit` before/after the HTTP call. Audit rows contain the model,
operation, queue/listing identity, sanitized request, raw response, response
headers, usage, timing, outcome, and error. Authorization is never stored.
Inline image data is represented by its digest and size so database backups do
not become media backups.

Native development loads `.env.local`; Docker Compose uses the same file when
present. Set `OPENROUTER_API_KEY` and `GOOGLE_GEOCODING_API_KEY` there. The model,
rate, and worker defaults can be overridden with the `FREDY_LLM_*`,
`FREDY_OPENROUTER_*`, and `FREDY_PARSER_*` environment variables.

Important parsing settings:

| Setting                                | Default | Purpose                                          |
| -------------------------------------- | ------- | ------------------------------------------------ |
| `FREDY_LLM_VISION_ENABLED`             | `0`     | Set to `1` to add best-effort gallery analysis.  |
| `FREDY_LLM_DAILY_LIMIT`                | `1000`  | Persistent UTC-day request budget.               |
| `FREDY_LLM_BACKFILL_SHARE`             | `0.8`   | Maximum share available to historical migration. |
| `FREDY_PARSER_BACKFILL_BURST`          | `3`     | Backfill calls allowed after each live call.     |
| `FREDY_OPENROUTER_REQUESTS_PER_MINUTE` | `18`    | Local rate limiter.                              |
| `FREDY_DISCOVERY_MAX_PAGES`            | provider| Result pages visited per scheduled provider run. |
| `FREDY_DETAIL_FETCH_IDLE_POLL_MS`      | `1000`  | Detail worker delay when no card is due.          |
| `FREDY_PRELLM_AREA_MIN_PRECISION`      | `house,street` | Geocode precisions confident enough to reject a listing on the area filter before the LLM call. Coarser precisions never reject (fail open). |
| `FREDY_LLM_MAX_TEXT_CHARS`             | `24000` | Cap on visible-text evidence sent to the LLM.    |
| `FREDY_LLM_MAX_EMBEDDED_CHARS`         | `24000` | Cap on embedded-JSON evidence sent to the LLM.   |
| `FREDY_LLM_UPSTREAM_BACKOFF_MS`        | `60000` | Global defer window when the provider returns a transient upstream-capacity error (HTTP-200-wrapped 5xx). |
| `FREDY_DB_PAYLOAD_RETENTION_DAYS`      | `30`    | Age after which the nightly maintenance cron nulls heavy payloads (capture JSON, LLM request/response bodies) on terminal rows. |
| `FREDY_DB_VACUUM`                      | `0`     | Set to `1` to also `VACUUM` (exclusive lock) during nightly maintenance. |

Before the required LLM extraction, a deterministic tier mines price, size,
rooms, address and (ImmoScout) rooftop coordinates from the captured detail
evidence and applies the blacklist, specification and spatial filters, so a
listing that will be rejected anyway never spends an LLM call. Deterministic
values only gate and dedupe — they never become canonical listing facts.

Migration 30 automatically queues every existing listing for schema-v4 text
extraction using the best retained detail capture, falling back to its stored
description only when no capture exists. Migration 31 keeps the former semantic
columns in `legacy_snapshot_json` for audit and replaces the canonical title,
address, price, size, rooms, coordinates, filters, and attributes exclusively
from the validated v4 result. Null LLM facts remain null. Legacy model artifacts
and scores are cleared so retraining uses only the v4 feature space. Check or
repair migration progress without opening historical listing pages or APIs:

```bash
yarn parsing:backfill enqueue
yarn parsing:backfill status
yarn parsing:backfill pause
yarn parsing:backfill resume
```

The status output reports total and migrated listing counts, queue state, LLM
budget, and audit outcomes. A listing is never finalized or notified without a
validated text-LLM result.

## Homeserver deployment

`master` publishes `ghcr.io/jhytabest/shoberfredy:master`; the homeserver's
restricted Fredy deployment pulls that image. The single container serves the
UI on `9998` and the internal Prometheus exporter on `9217`. Prometheus scrapes
`fredy:9217` over the private Docker network. Only the SQLite database file
`/db/listings.db` is backed up; `/db/media` is excluded and intentionally expendable.

The container runs as UID/GID `10001`, with a read-only root filesystem,
dropped Linux capabilities, and `no-new-privileges`. Memory and PID limits are
deliberately not configured.

A nightly in-process maintenance task (02:30) checkpoints the WAL and bounds
the retained audit/queue payload growth (see
`FREDY_DB_PAYLOAD_RETENTION_DAYS`). Because the CI image is rebuilt on every
push, the host should also prune unused Docker images and build cache
periodically (e.g. a weekly `docker image prune -af` + `docker builder prune
-af` systemd timer) so old image layers don't fill the root disk, and alert on
low free space for both the root and `/srv/data` volumes (the raw
`node_filesystem_avail_bytes` metric is already scraped).

## 🛡️ Bot Detection & Proxies

The browser-based providers (Immowelt, Kleinanzeigen, and WG-Gesucht) are scraped through a hardened headless browser ([CloakBrowser](https://www.npmjs.com/package/cloakbrowser)). It makes the **browser fingerprint** indistinguishable from a real Chrome, which is enough when you run Fredy on a normal home connection.

On a **server / VPS the requests usually originate from a datacenter IP**, and providers behind anti-bot systems (e.g. AWS CloudFront/WAF) block those based on **IP reputation alone**, no matter how perfect the fingerprint is. The typical symptom: it works locally but you get `We have been detected as a bot :-/` on the server.

### The fix: a residential proxy

A **residential proxy** routes Fredy's browser through the internet connection of a real household, so the provider sees a "normal user" IP instead of a datacenter. For German portals, use a **German (DE) residential** (or mobile/4G) proxy. Plain VPNs and **datacenter proxies do not help** here, they share the same bad reputation as your server.

**Configure it** under **Settings → Execution → Proxy URL**. Supported formats:

```
http://user:pass@host:port
socks5://user:pass@host:port
```

Leave the field empty to disable. The proxy applies to all headless-browser providers and takes effect on the next job run (no restart needed). Immoscout uses a separate mobile API and is not affected.

### Where to get a residential proxy

Residential proxies are a paid service (usually billed per GB, Fredy's traffic is small). Well-known providers offering German residential IPs include:

| Provider                                           | Notes                                                  |
| -------------------------------------------------- | ------------------------------------------------------ |
| [IPRoyal](https://iproyal.com)                     | Pay-as-you-go, no monthly minimum, good for low volume |
| [Webshare](https://www.webshare.io)                | Cheap entry tier, has a small free plan to test with   |
| [Decodo (formerly Smartproxy)](https://decodo.com) | Easy setup, country/city targeting                     |
| [SOAX](https://soax.com)                           | Residential + mobile, fine-grained geo-targeting       |
| [Bright Data](https://brightdata.com)              | Largest pool, most features, higher complexity/price   |
| [Oxylabs](https://oxylabs.io)                      | Enterprise-grade, larger plans                         |

This is not an endorsement, pick whatever fits your budget. For low-volume use like Fredy, a pay-as-you-go plan (e.g. IPRoyal) or a cheap entry tier (e.g. Webshare) is usually plenty. Make sure to select **Germany** as the proxy location and keep the search interval reasonable (the higher the interval, the less you look like a bot).

## 🛠️ Development

### Development Mode

```bash
yarn run start:backend:dev
yarn run start:frontend:dev
```

You should now be able to access _Fredy_ from your browser. Check your Terminal to see what port the frontend is running on.

### Run Tests

## "Online" tests

These tests are directly executed against the actual providers.

```bash
yarn run test
```

## "Offline" tests

These tests are using the test fixtures instead of the actual providers. Much faster and "good enough" to test the core functionality.

```bash
yarn run test:offline
```

## Download new fixtures

If you have to refresh the fixtures (every once in a while needed because the providers change their code), run this command:

```bash
yarn run download-fixtures
```

## Adding a new language

Fredy's UI is fully multilingual. Translation files live in `ui/src/locales/`. To add a new language, create a single JSON file there, no code changes required.

**Example: `ui/src/locales/fr.json`**

```json
{
  "_meta": {
    "flag": "🇫🇷",
    "name": "Français",
    "locale": "fr-FR",
    "semiLocale": "fr"
  },
  "nav.dashboard": "Tableau de bord",
  "common.save": "Enregistrer",
  ...
}
```

The `_meta` fields:

| Field        | Description                                                                     |
| ------------ | ------------------------------------------------------------------------------- |
| `flag`       | Unicode flag emoji shown in the language selector                               |
| `name`       | Display name shown in the language selector                                     |
| `locale`     | BCP 47 locale string used for date and number formatting (e.g. `fr-FR`)         |
| `semiLocale` | Semi UI locale key for component-level strings (date pickers, pagination, etc.) |

> **Important:** `semiLocale` must exactly match a locale filename from the Semi UI locale sources (without the `.js` extension). See the [available Semi UI locales on GitHub](https://github.com/DouyinFE/semi-design/tree/main/packages/semi-ui/locale/source) for the full list of supported keys.

After adding the file, rebuild the frontend (`yarn build:frontend` or restart the dev server) and the new language will appear automatically in **Settings → User Settings → Language**.

---

## 📐 Architecture

```mermaid
flowchart TD
 subgraph Jobs["Jobs"]
        A1["Job 1"]
        A2["Job 2"]
        A3["Job 3"]
  end
 subgraph Providers["Providers"]
        C1["Provider 1"]
        C2["Provider 2"]
        C3["Provider 3"]
  end
    A1 --> B["FredyPipelineExecutioner"]
    A2 --> B
    A3 --> B
    B --> C1 & C2 & C3
    C1 --> D["Similarity Check"]
    C2 --> D
    C3 --> D
    D --> E{"Duplicate?"}
    E -- No --> F["Telegram"]
```

---

## 🤖 Using AI such as Claude Code

When I started building Fredy, LLMs were still basically the wet dream of a few nerdy scientists.

Nowadays, it’s easier than ever to throw a prompt into the LLM of your choice and let 'the AI' build your stuff. I’m not against that. I use Claude Code myself for smaller tasks, and I do think these tools can be really useful.

That said, I still believe humans should stay in charge. AI is great-ish at writing code, but it still lacks creativity, context, and the ability to see the full picture.

So, if you want to contribute to Fredy, using AI tools to get things done is totally fine. Just please don’t stop thinking.

I’ve had one too many PRs full of hallucinated bullshit.

**Thanks ;)**

---

## 👐 Contributing

Thanks to everyone who has contributed!

<a href="https://github.com/orangecoding/fredy/graphs/contributors"><img src="https://contrib.rocks/image?repo=orangecoding/fredy" /></a>

See the [Contributing
Guide](https://github.com/orangecoding/fredy/blob/master/CONTRIBUTING.md).

---

## ⭐ Star History

[![Star History
Chart](https://api.star-history.com/svg?repos=orangecoding/fredy&type=Date)](https://www.star-history.com/#orangecoding/fredy&Date)
