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
- **Cross-portal dedupe**: a flat already notified from another portal/job in
  the last 7 days is soft-hidden instead of re-notified.
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
  <a href="https://fredy.orange-coding.net/" target="_blank">Website</a>&nbsp;&nbsp;|&nbsp;&nbsp;
  <a href="https://fredy-demo.orange-coding.net/" target="_blank">Demo</a>
</p>

<p align="center">
  <img src="https://github.com/orangecoding/fredy/actions/workflows/test.yml/badge.svg" alt="Tests" />
  <img src="https://github.com/orangecoding/fredy/actions/workflows/docker.yml/badge.svg" alt="Docker" />
  <img src="https://github.com/orangecoding/fredy/actions/workflows/check_source.yml/badge.svg" alt="Source" />
  <img src="https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fghcr-badge.elias.eu.org%2Fapi%2Forangecoding%2Ffredy%2Ffredy&query=%24.downloadCount&label=Docker%20Pulls" alt="Docker Pulls" />
</p>

# Fredy 🏡 - Your Self-Hosted Real Estate Finder for Germany

Finding an apartment or house in Germany can be stressful and
time-consuming.\
**Fredy** makes it easier: it automatically scrapes **ImmoScout24,
Immowelt, eBay Kleinanzeigen, and WG-Gesucht** and notifies you
instantly via **Slack, Telegram, Email, ntfy, discord and more** when new
listings appear.

With a modern architecture, Fredy provides a **clean Web UI**, removes
duplicates across platforms, and stores results so you never see the
same listing twice.

---

## ✨ Key Features

- 🏠 Scrapes **ImmoScout24, Immowelt, eBay Kleinanzeigen,
  WG-Gesucht**
- ⚡ Instant notifications: Slack, Telegram, Email (SendGrid,
  Mailjet), ntfy, discord
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

## 👨‍🏫 Demo

You can try out Fredy here: [Fredy Demo](https://fredy-demo.orange-coding.net/)

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

### Adapter 📡

An **adapter** is the channel through which Fredy notifies you (Slack,
Telegram, Email, ntfy, discord ...).\
Each adapter has its own configuration (e.g. API keys, webhook URLs).\
You can use multiple adapters at once --- Fredy will send new listings
through all of them.

### Job 📅

A **job** combines providers and adapters.\
Example: "Search apartments on ImmoScout24 + Immowelt and send results
to Slack + Telegram."\
Jobs run automatically at the interval you configure (see
`/conf/config.json`).

### MCP Server 🤖

Starting with **V20**, Fredy ships with a built-in **MCP Server **. This allows you to connect Fredy to LLMs (like Claude, ChatGPT, or local models via LM Studio) and query your real estate data using natural language.
The local LLM can even enrich existing listings by checking the listing online.

Run `yarn mcp:stdio` for a local stdio transport. The authenticated HTTP MCP
route is served by the main application.

---

## Immoscout

Immoscout has implemented advanced bot detection. In order to work around this, we are using a reversed engineered version of their mobile api. See [Immoscout Reverse Engineering Documentation](https://github.com/orangecoding/fredy/blob/master/reverse-engineered-immoscout.md)

## Durable parsing pipeline

Scheduled jobs paginate provider result lists and put each discovery card in a
durable detail-fetch queue. Stable provider ID or canonical URL is the first
dedupe key. Detail pages are then fetched separately and exact evidence versions
are deduplicated before they enter the parsing queue. Provider pages marked
`gelöscht` or `reserviert` are retained as inactive audit evidence and never
enter parsing. Active detail evidence is conservatively cleaned, while the
untouched raw text is retained for audit. Gallery media may be compressed for
display, but media is not part of database backups.

Stored active listings receive one provider reachability check at startup and
then daily at 01:00, for at most seven days. A Kleinanzeigen page containing
`Gelöscht` or `Reserviert`, any non-success response, or a network failure ends
the listing immediately; recognized bot blocking leaves it active for the next
daily pass. Listings still active at seven days expire locally. Every transition
records `inactive_at` and `inactive_reason`.

A durable worker extracts every active listing with a required structured text
LLM request against a strict, compact schema with a free-text `comments`
overflow field. The LLM receives detail-page/API evidence only. Discovery-card
title, address, price, size, and rooms are never fallbacks after LLM extraction;
unknown values remain null/unknown. Vision is disabled by default and, when
explicitly enabled, is supplemental: it can never block text parsing. Validated
LLM fields then drive geocoding, filtering, semantic deduplication, storage, and
the market model. Rating and notification each use their own durable queue, so a
process restart cannot strand an accepted listing.

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
rate, worker, and notification defaults can be overridden with the
`FREDY_LLM_*`, `FREDY_OPENROUTER_*`, `FREDY_PARSER_*`, and
`FREDY_NOTIFICATION_*` environment variables.

Important parsing settings:

| Setting                                | Default | Purpose                                          |
| -------------------------------------- | ------- | ------------------------------------------------ |
| `FREDY_LLM_VISION_ENABLED`             | `0`     | Set to `1` to add best-effort gallery analysis.  |
| `FREDY_LLM_DAILY_LIMIT`                | `1000`  | Persistent UTC-day request budget.               |
| `FREDY_LLM_BACKFILL_SHARE`             | `0.8`   | Maximum share available to historical migration. |
| `FREDY_PARSER_BACKFILL_BURST`          | `3`     | Backfill calls allowed after each live call.     |
| `FREDY_OPENROUTER_REQUESTS_PER_MINUTE` | `18`    | Local rate limiter.                              |

Migration 30 automatically queues every existing listing for schema-v4 text
extraction using the best retained detail capture, falling back to its stored
description only when no capture exists. Base listing rows remain intact while
structured attributes are replaced only by validated v4 results. Legacy model
artifacts and scores are cleared so retraining uses the v4 feature space. Check
or repair migration progress without opening historical listing pages or APIs:

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

## Analytics

Fredy is completely free (and will always remain free). However, it would be a huge help if you’d allow me to collect some analytical data.
Before you freak out, let me explain...  
If you agree, Fredy will send a ping once every 6 hours to my internal tracking project (Will be open sourced soon).  
The data includes: names of active adapters/providers, OS, architecture, Node version, and language. The information is entirely anonymous and helps me understand which adapters/providers are most frequently used.</p>

**Thanks**🤘

## 🐞 Debug Information

Since Fredy **22.5.0** there is a built-in way to capture everything Fredy logs into the
database for a limited time and download it as a single zip file. This is the recommended
way to attach diagnostics to a bug report. I decided against simply putting all logs into
a debug bundle due to privacy reasons!

**How it works**

- Debug logging is **opt-in** and admin-only. As long as it is off, Fredy behaves exactly
  as before (console output only, nothing in the DB).
- When you turn it on, every log line (`debug`, `info`, `warn`, `error`) is additionally
  written into the `debug_logs` SQLite table. The console keeps logging at its usual level.
- The recorded data is hard-capped at **5 MiB** via a rolling buffer: once the cap is hit,
  the oldest entries are dropped automatically so the newest ones always survive.
- The on/off flag is persisted, so debug logging stays on across restarts (and you'll see
  the warning banner everywhere until you turn it off again).

**Capturing a debug bundle**

1. Open Fredy as an **admin** and go to **Settings → Debug**.
2. Click **"Enable debug logging" / "Debug-Logging aktivieren"**. A red banner appears on
   every page while recording is on.
3. **Reproduce the bug**.
4. Come back to **Settings → Debug** and check the progress bar, if it stayed at 0 %,
   nothing was captured.
5. Click **"Download debug information" / "Debug Informationen herunterladen"**. You get a
   zip named `YYYY-MM-DD-FredyDebug-<version>.zip` containing two files:
   - `logs.txt` - every log line captured while recording was on, prefixed with timestamp
     and level.
   - `sys.txt` - runtime snapshot (Fredy version, Node.js version, OS, Docker detection,
     CPU, memory, sanitized settings). Proxy credentials and session secrets are
     **stripped** before export.
6. Attach the zip to the bug report.
7. Optional but recommended: click **"Disable debug logging"** to stop recording, and
   **"Delete stored debug logs"** once you've sent the zip so the DB does not keep them
   around.

**What is _not_ included**

- passwords/privacy relevant things
- Anything that Fredy itself does not pass through its `logger`. If a third-party library
  writes directly to `process.stderr`, that output stays on the console only.

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
 subgraph NotificationAdapters["Notification Adapters"]
        F1["Adapter 1"]
        F2["Adapter 2"]
  end

    A1 --> B["FredyPipelineExecutioner"]
    A2 --> B
    A3 --> B
    B --> C1 & C2 & C3
    C1 --> D["Similarity Check"]
    C2 --> D
    C3 --> D
    D --> E{"Duplicate?"}
    E -- No --> F1
    F1 --> F2
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
