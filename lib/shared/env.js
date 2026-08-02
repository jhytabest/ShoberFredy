/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Every environment variable the application reads, declared once.
 *
 * Reading a knob that is not declared here throws, so a typo fails loudly at
 * startup instead of silently falling back to a default. The registry is also
 * what `describeEnv()` renders, so the documentation cannot drift from the code.
 *
 * `kind` drives parsing and validation:
 *   'int'    integer at or above `min` (default 1); anything else falls back
 *   'number' finite number; out-of-range falls back
 *   'flag'   '0' is false, anything else present is true, absent is the default
 *   'string' used verbatim when non-empty
 */
const REGISTRY = {
  // ---- runtime / deployment -------------------------------------------------
  NODE_ENV: { kind: 'string', default: 'development', doc: 'Node environment; "production" quiets debug logging.' },
  FREDY_DOCKER: { kind: 'flag', default: false, doc: 'Set by the container image to signal a Docker deployment.' },

  // ---- credentials ---------------------------------------------------------
  OPENROUTER_API_KEY: { kind: 'string', default: '', secret: true, doc: 'OpenRouter key; required for LLM parsing.' },
  GOOGLE_GEOCODING_API_KEY: { kind: 'string', default: '', secret: true, doc: 'Google Geocoding key.' },

  // ---- worker kill switches -----------------------------------------------
  FREDY_DETAIL_FETCH_ENABLED: { kind: 'flag', default: true, doc: 'Set 0 to stop draining detail work.' },
  FREDY_PARSER_ENABLED: { kind: 'flag', default: true, doc: 'Set 0 to stop the LLM parser worker.' },
  FREDY_RATING_ENABLED: { kind: 'flag', default: true, doc: 'Set 0 to stop market rating.' },
  FREDY_NOTIFICATION_ENABLED: { kind: 'flag', default: true, doc: 'Set 0 to stop notification delivery.' },
  FREDY_LLM_ENABLED: { kind: 'flag', default: true, doc: 'Set 0 to disable the LLM entirely (parsing stops).' },
  FREDY_MAINTENANCE_ENABLED: { kind: 'flag', default: true, doc: 'Set 0 to stop scheduled maintenance work items.' },

  // ---- discovery ----------------------------------------------------------
  // Unset means "use each provider's own pagination.maxPages", which is 3 for
  // every provider today. The registry default only applies once the override is
  // set, so it is deliberately not the effective value.
  FREDY_DISCOVERY_MAX_PAGES: {
    kind: 'int',
    default: 20,
    doc: "Override the per-provider page ceiling; unset uses the provider's own limit (3).",
  },
  FREDY_DISCOVERY_TIMEOUT_MS: { kind: 'int', default: 120_000, doc: 'Deadline for one provider discovery run.' },

  // ---- work queue ---------------------------------------------------------
  FREDY_WORK_IDLE_POLL_MS: { kind: 'int', default: 1000, doc: 'Idle sleep between empty work-queue polls.' },
  FREDY_WORKER_RESTART_DELAY_MS: { kind: 'int', default: 5000, doc: 'Delay before restarting a crashed worker loop.' },
  FREDY_WORK_MAX_BACKOFF_MS: { kind: 'int', default: 60 * 60 * 1000, doc: 'Ceiling on retry backoff for work items.' },
  FREDY_RATE_MAX_FAILURES: { kind: 'int', default: 5, doc: 'Attempts before a rating item is abandoned.' },
  FREDY_MAINTENANCE_MAX_FAILURES: { kind: 'int', default: 3, doc: 'Attempts before a maintenance item is abandoned.' },
  FREDY_MARKET_MODEL_MAX_FAILURES: { kind: 'int', default: 3, doc: 'Attempts before a training item is abandoned.' },
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
  FREDY_RATING_ITEM_TIMEOUT_MS: { kind: 'int', default: 30_000, doc: 'Deadline for one market rating.' },
  FREDY_MAINTENANCE_ITEM_TIMEOUT_MS: {
    kind: 'int',
    default: 1_800_000,
    doc: 'Deadline for automatic database upkeep.',
  },

  // ---- LLM ---------------------------------------------------------------
  FREDY_LLM_TEXT_MODEL: { kind: 'string', default: '', doc: 'OpenRouter model id for text extraction.' },
  FREDY_LLM_DAILY_LIMIT: { kind: 'int', default: 1000, doc: 'Daily LLM request budget (UTC days).' },
  FREDY_LLM_MAX_TEXT_CHARS: { kind: 'int', default: 24_000, doc: 'Cap on captured page text sent to the LLM.' },
  FREDY_LLM_MAX_EMBEDDED_CHARS: { kind: 'int', default: 24_000, doc: 'Cap on embedded JSON sent to the LLM.' },
  FREDY_LLM_REQUEST_TIMEOUT_MS: { kind: 'int', default: 120_000, doc: 'Deadline for a single LLM request.' },
  FREDY_LLM_UPSTREAM_BACKOFF_MS: { kind: 'int', default: 60_000, doc: 'Backoff after an upstream LLM rate limit.' },
  FREDY_LLM_MAX_LISTING_FAILURES: { kind: 'int', default: 5, doc: 'LLM attempts before a listing is abandoned.' },
  FREDY_OPENROUTER_REQUESTS_PER_MINUTE: { kind: 'int', default: 18, doc: 'Client-side OpenRouter rate limit.' },

  // ---- geocoding ----------------------------------------------------------
  FREDY_GEOCODER_RETRY_COARSE_AFTER_DAYS: { kind: 'int', default: 14, doc: 'Age at which a coarse geocode retries.' },

  // ---- provider circuit breaker ------------------------------------------
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

  // ---- market ------------------------------------------------------------
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
  FREDY_MARKET_SURFACE_MIN_CONFIDENCE: { kind: 'number', default: 0.25, doc: 'Minimum surface-cell confidence.' },
  FREDY_MARKET_INTERVAL_LEVEL: { kind: 'number', default: 0.8, doc: 'Conformal interval coverage level.' },
  FREDY_PYTHON_BIN: { kind: 'string', default: 'python3', doc: 'Python used for the LightGBM trainer.' },

  // ---- maintenance work --------------------------------------------------
  FREDY_MAINTENANCE_INTERVAL_MS: { kind: 'int', default: 86_400_000, doc: 'Spacing between maintenance work items.' },
  FREDY_DB_VACUUM: { kind: 'flag', default: false, doc: 'Set 1 to VACUUM during scheduled maintenance.' },

  // ---- browser / binary --------------------------------------------------
  CLOAKBROWSER_BINARY_PATH: { kind: 'string', default: '', doc: 'Explicit CloakBrowser Chromium path.' },
  CLOAKBROWSER_CACHE_DIR: { kind: 'string', default: '', doc: 'CloakBrowser download cache directory.' },

  // ---- migrations --------------------------------------------------------
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

/**
 * Read a declared environment variable, parsed and validated per its `kind`.
 * @param {string} name
 * @returns {string|number|boolean}
 */
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

/** Whether a declared variable has a non-empty value set. */
export function envIsSet(name) {
  spec(name);
  const raw = process.env[name];
  return raw != null && raw !== '';
}

/**
 * Render the registry as a documentation table. Secret values are never read,
 * only their names and whether they are configured.
 * @returns {{name:string, kind:string, default:string, doc:string, set:boolean}[]}
 */
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
