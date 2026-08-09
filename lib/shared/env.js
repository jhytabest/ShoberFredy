/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

const REGISTRY = {
  NODE_ENV: { kind: 'string', default: 'development', doc: 'Node environment; "production" quiets debug logging.' },
  FREDY_DOCKER: { kind: 'flag', default: false, doc: 'Set by the container image to signal a Docker deployment.' },
  FREDY_HEALTH_PORT: { kind: 'int', default: 9998, doc: 'Port for the /health HTTP server; read once at startup.' },

  OPENROUTER_API_KEY: { kind: 'string', default: '', secret: true, doc: 'OpenRouter key; required for LLM parsing.' },
  GOOGLE_GEOCODING_API_KEY: { kind: 'string', default: '', secret: true, doc: 'Google Geocoding key.' },

  FREDY_DETAIL_FETCH_ENABLED: { kind: 'flag', default: true, doc: 'Set 0 to stop draining detail work.' },
  FREDY_PARSER_ENABLED: { kind: 'flag', default: true, doc: 'Set 0 to stop the LLM parser worker.' },
  FREDY_RATING_ENABLED: { kind: 'flag', default: true, doc: 'Set 0 to stop market rating.' },
  FREDY_NOTIFICATION_ENABLED: { kind: 'flag', default: true, doc: 'Set 0 to stop notification delivery.' },
  FREDY_LLM_ENABLED: { kind: 'flag', default: true, doc: 'Set 0 to disable the LLM entirely (parsing stops).' },
  FREDY_MAINTENANCE_ENABLED: { kind: 'flag', default: true, doc: 'Set 0 to stop scheduled maintenance work items.' },

  FREDY_DISCOVERY_MAX_PAGES: {
    kind: 'int',
    default: 20,
    doc: "Override the per-provider page ceiling; unset uses the provider's own limit (3).",
  },
  FREDY_DISCOVERY_TIMEOUT_MS: { kind: 'int', default: 120_000, doc: 'Deadline for one provider discovery run.' },
  FREDY_DISCOVERY_CONCURRENCY: {
    kind: 'int',
    default: 3,
    doc: 'Global cap on discovery runs in flight at once, across all portals.',
  },
  FREDY_DISCOVERY_MIN_PORTAL_GAP_MS: {
    kind: 'int',
    min: 0,
    default: 5000,
    doc: 'Minimum gap between consecutive discovery hits of the same portal, across jobs.',
  },
  FREDY_SCHEDULER_TICK_MS: { kind: 'int', default: 15_000, doc: 'How often the scheduler checks for due jobs.' },

  FREDY_WORK_IDLE_POLL_MS: { kind: 'int', default: 1000, doc: 'Idle sleep between empty work-queue polls.' },
  FREDY_WORKER_RESTART_DELAY_MS: { kind: 'int', default: 5000, doc: 'Delay before restarting a crashed worker loop.' },
  FREDY_WORK_MAX_BACKOFF_MS: {
    kind: 'int',
    default: 15 * 60 * 1000,
    doc: 'Ceiling on retry and park backoff for work items.',
  },
  FREDY_NOTIFY_MAX_FAILURES: { kind: 'int', default: 6, doc: 'Attempts before a notification is abandoned.' },
  FREDY_WORK_MAX_DEFERRALS: { kind: 'int', default: 24, doc: 'Parks on a resource before work is abandoned.' },
  FREDY_WORK_MAX_PARK_MS: {
    kind: 'int',
    default: 24 * 60 * 60 * 1000,
    doc: 'Age at which parked work is abandoned regardless of park count.',
  },

  FREDY_DETAIL_ITEM_TIMEOUT_MS: { kind: 'int', default: 300_000, doc: 'Deadline for one detail capture.' },
  FREDY_DETAIL_MAX_FAILURES: { kind: 'int', default: 8, doc: 'Attempts before a detail item is abandoned.' },
  FREDY_PARSER_ITEM_TIMEOUT_MS: { kind: 'int', default: 300_000, doc: 'Deadline for one parse (text + repair).' },
  FREDY_PARSER_MAX_ITEM_FAILURES: { kind: 'int', default: 8, doc: 'Attempts before a parse item is abandoned.' },
  FREDY_NOTIFICATION_ITEM_TIMEOUT_MS: { kind: 'int', default: 120_000, doc: 'Deadline for one notification digest.' },
  FREDY_NOTIFICATION_BATCH_SIZE: { kind: 'int', default: 50, doc: 'Deliveries considered for one digest.' },
  FREDY_RATING_ITEM_TIMEOUT_MS: { kind: 'int', default: 30_000, doc: 'Deadline for one market rating.' },
  FREDY_MAINTENANCE_ITEM_TIMEOUT_MS: {
    kind: 'int',
    default: 1_800_000,
    doc: 'Deadline for automatic database upkeep.',
  },

  FREDY_LLM_TEXT_MODEL: { kind: 'string', default: '', doc: 'OpenRouter model id for text extraction.' },
  FREDY_LLM_DAILY_LIMIT: { kind: 'int', default: 1000, doc: 'Daily LLM request budget (UTC days).' },
  FREDY_LLM_MAX_TEXT_CHARS: { kind: 'int', default: 24_000, doc: 'Cap on captured page text sent to the LLM.' },
  FREDY_LLM_MAX_EMBEDDED_CHARS: { kind: 'int', default: 24_000, doc: 'Cap on embedded JSON sent to the LLM.' },
  FREDY_LLM_REQUEST_TIMEOUT_MS: { kind: 'int', default: 120_000, doc: 'Deadline for a single LLM request.' },
  FREDY_LLM_UPSTREAM_BACKOFF_MS: { kind: 'int', default: 60_000, doc: 'Backoff after an upstream LLM rate limit.' },
  FREDY_LLM_MAX_LISTING_FAILURES: { kind: 'int', default: 5, doc: 'LLM attempts before a listing is abandoned.' },
  FREDY_OPENROUTER_REQUESTS_PER_MINUTE: { kind: 'int', default: 18, doc: 'Client-side OpenRouter rate limit.' },

  FREDY_GEOCODER_RETRY_COARSE_AFTER_DAYS: { kind: 'int', default: 14, doc: 'Age at which a coarse geocode retries.' },

  FREDY_PROVIDER_BREAKER_FAILURES: {
    kind: 'int',
    default: 2,
    doc: 'Failed discovery runs before a provider is paused.',
  },
  FREDY_PROVIDER_BREAKER_ITEM_CHALLENGES: {
    kind: 'int',
    default: 8,
    doc: 'Challenged single requests, with no success between, before a provider is paused.',
  },
  FREDY_PROVIDER_BREAKER_COOLDOWN_MS: { kind: 'int', default: 1_800_000, doc: 'Initial provider pause duration.' },
  FREDY_PROVIDER_BREAKER_MAX_COOLDOWN_MS: { kind: 'int', default: 21_600_000, doc: 'Ceiling on provider pause.' },

  FREDY_MARKET_DB_PATH: { kind: 'string', default: '', doc: 'Override the market SQLite path (defaults to app db).' },
  FREDY_MARKET_EXPORTER_PORT: {
    kind: 'int',
    min: 0,
    default: 9217,
    doc: 'Prometheus exporter port; 0 disables it.',
  },
  FREDY_MARKET_MODEL_CRON: {
    kind: 'string',
    default: '0 2 * * *',
    doc: 'Market training schedule; "0" disables training entirely.',
  },
  FREDY_MARKET_MODEL_INTERVAL_SECONDS: {
    kind: 'int',
    min: 0,
    default: 86_400,
    doc: 'Minimum seconds between retrains; 0 disables training.',
  },
  FREDY_MARKET_MODEL_RUN_TIMEOUT_MS: { kind: 'int', default: 1_800_000, doc: 'Deadline for one retrain run.' },
  FREDY_MARKET_INTERVAL_LEVEL: { kind: 'number', default: 0.8, doc: 'Conformal interval coverage level.' },
  FREDY_PYTHON_BIN: { kind: 'string', default: 'python3', doc: 'Python used for the LightGBM trainer.' },

  FREDY_CARD_FILTER_AUDIT_RATE: {
    kind: 'number',
    default: 0.03,
    doc: 'Fraction of card-stage refusals let through to extraction so the refusal can be checked. 0 disables.',
  },
  FREDY_LIVENESS_CHECKS_PER_PASS: {
    kind: 'int',
    default: 200,
    doc: 'Stale listings re-fetched per maintenance pass to see whether they are gone. 0 disables.',
  },
  FREDY_LIVENESS_STALE_AFTER_MS: {
    kind: 'int',
    default: 7 * 24 * 60 * 60 * 1000,
    doc: 'Age at which an active listing is re-checked for liveness.',
  },
  FREDY_MAINTENANCE_INTERVAL_MS: { kind: 'int', default: 86_400_000, doc: 'Spacing between maintenance work items.' },
  FREDY_DB_VACUUM: { kind: 'flag', default: false, doc: 'Set 1 to VACUUM during scheduled maintenance.' },

  CLOAKBROWSER_BINARY_PATH: { kind: 'string', default: '', doc: 'Explicit CloakBrowser Chromium path.' },
  CLOAKBROWSER_CACHE_DIR: { kind: 'string', default: '', doc: 'CloakBrowser download cache directory.' },

  MIGRATION_ALLOW_CHECKSUM_UPDATE: {
    kind: 'flag',
    default: false,
    doc: 'Permit rewriting the recorded checksum of an applied migration.',
  },
};

function spec(name) {
  const entry = REGISTRY[name];
  if (!entry) throw new Error(`Undeclared environment variable '${name}'. Add it to lib/shared/env.js.`);
  return entry;
}

export function env(name) {
  const { kind, min = 1, default: fallback } = spec(name);
  const raw = process.env[name];

  if (kind === 'flag') {
    if (raw == null || raw === '') return fallback;
    return raw !== '0' && raw.toLowerCase() !== 'false';
  }
  if (raw == null || raw === '') return fallback;
  if (kind === 'int') {
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed >= min ? parsed : fallback;
  }
  if (kind === 'number') {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return raw;
}

export function envIsSet(name) {
  spec(name);
  const raw = process.env[name];
  return raw != null && raw !== '';
}

export function describeEnv() {
  return Object.entries(REGISTRY)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, entry]) => ({
      name,
      kind: entry.kind,
      default: entry.secret ? '(unset)' : String(entry.default),
      doc: entry.doc,
      set: process.env[name] != null && process.env[name] !== '',
    }));
}
