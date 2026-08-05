/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

export function normalizeAddress(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/\s+,/g, ',')
    .trim();
}

export function addressKey(value) {
  return normalizeAddress(value).toLowerCase();
}
