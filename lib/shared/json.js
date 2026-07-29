/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * The single safe-JSON contract for the whole application.
 *
 * There were eleven private copies of this before, with three mutually
 * incompatible failure behaviours (null, [], caller fallback), which is how a
 * column written by one module came back a different shape in another. The rule
 * here is explicit: the caller always states what it wants back on failure.
 */

/**
 * Serialize for storage. Null and undefined become SQL NULL rather than the
 * string "null", so a missing value stays missing.
 * @param {unknown} value
 * @returns {string|null}
 */
export function toJson(value) {
  return value == null ? null : JSON.stringify(value);
}

/**
 * Parse a stored JSON column, returning `fallback` when absent or malformed.
 * Accepts an already-parsed value so callers can be indifferent to whether a
 * row came from SQLite or from memory.
 * @template T
 * @param {unknown} value
 * @param {T} fallback
 * @returns {T}
 */
export function fromJson(value, fallback = null) {
  if (value == null || value === '') return fallback;
  if (typeof value !== 'string') return value;
  try {
    const parsed = JSON.parse(value);
    return parsed === undefined ? fallback : parsed;
  } catch {
    return fallback;
  }
}

/**
 * Parse a stored JSON column that must be an array. Anything else — including a
 * valid JSON object — yields an empty array, so callers can iterate safely.
 * @param {unknown} value
 * @returns {unknown[]}
 */
export function jsonArray(value) {
  const parsed = fromJson(value, []);
  return Array.isArray(parsed) ? parsed : [];
}

/**
 * Parse a stored JSON column that must be a plain object.
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
export function jsonObject(value) {
  const parsed = fromJson(value, {});
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
}
