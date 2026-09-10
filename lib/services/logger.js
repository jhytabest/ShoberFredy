/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

let sink = null;
const pending = [];

export function setLogSink(next) {
  sink = next;
  for (const event of pending.splice(0)) persist(event);
}

export function redact(value) {
  const seen = new WeakSet();
  const clean = (item, key = '') => {
    if (/token|api[_-]?key|authorization|password|secret/i.test(key)) return '[redacted]';
    if (typeof item === 'string')
      return item
        .replace(/bot\d+:[A-Za-z0-9_-]+/g, 'bot[redacted]')
        .replace(/sk-or-v1-[A-Za-z0-9_-]+/g, '[redacted]')
        .replace(/([?&](?:key|token|api_key)=)[^&\s]+/gi, '$1[redacted]');
    if (item == null || typeof item !== 'object') return item;
    if (seen.has(item)) return '[circular]';
    seen.add(item);
    if (item instanceof Error)
      return {
        name: item.name,
        message: clean(item.message),
        code: item.code,
        stack: clean(item.stack),
        cause: clean(item.cause),
      };
    if (Array.isArray(item)) return item.map((entry) => clean(entry));
    return Object.fromEntries(Object.entries(item).map(([name, entry]) => [name, clean(entry, name)]));
  };
  return clean(value);
}

function persist(event) {
  if (!sink) {
    if (pending.length >= 1000) pending.shift();
    pending.push(event);
    return;
  }
  try {
    sink(event);
  } catch (error) {
    // A database write failure cannot recursively log into the same database.
    // eslint-disable-next-line no-console
    console.error('Database event log write failed:', redact(error));
  }
}

const COLORS = {
  debug: '\x1b[36m',
  info: '\x1b[32m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
  reset: '\x1b[0m',
};

const env = process.env.NODE_ENV || 'development';
const useColor = process.stdout.isTTY || process.stderr.isTTY;

function ts() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
}

function lvl(level) {
  const upper = level.toUpperCase();
  if (!useColor) return upper;
  return `${COLORS[level] || ''}${upper}${COLORS.reset}`;
}

/* eslint-disable no-console */
function log(level, event, ...args) {
  args = redact(args);
  persist({ level, event, args, createdAt: Date.now() });
  if (level === 'debug' && env !== 'development') {
    return;
  }

  const prefix = `[${ts()}] ${lvl(level)}:`;
  switch (level) {
    case 'debug':
      console.debug(prefix, ...args);
      break;
    case 'info':
      console.info(prefix, ...args);
      break;
    case 'warn':
      console.warn(prefix, ...args);
      break;
    case 'error':
      console.error(prefix, ...args);
      break;
    default:
      console.log(prefix, ...args);
  }
}

export default {
  debug: (...a) => log('debug', 'log', ...a),
  info: (...a) => log('info', 'log', ...a),
  warn: (...a) => log('warn', 'log', ...a),
  error: (...a) => log('error', 'log', ...a),
  event: (event, level, ...a) => {
    log(level, event, ...a);
  },
};
