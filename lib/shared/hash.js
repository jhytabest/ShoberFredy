/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import crypto from 'node:crypto';

/**
 * Hex SHA-256 of a value's string form. The one hashing primitive: identity
 * keys, claim keys, capture versions and session material all derive from it,
 * so two call sites cannot disagree about encoding.
 * @param {unknown} value
 * @returns {string}
 */
export function sha256(value) {
  return crypto
    .createHash('sha256')
    .update(String(value ?? ''), 'utf8')
    .digest('hex');
}

/**
 * Hash an ordered list of parts under a fixed separator, skipping null and
 * empty entries. Returns null when nothing usable was supplied, so callers can
 * treat "no identity" as distinct from "identity of nothing".
 * @param {...(string|number|null|undefined)} parts
 * @returns {string|null}
 */
export function hashParts(...parts) {
  const cleaned = parts.filter((part) => part != null && String(part).length > 0);
  return cleaned.length === 0 ? null : sha256(cleaned.join('|'));
}
