/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import crypto from 'node:crypto';

export function sha256(value) {
  return crypto
    .createHash('sha256')
    .update(String(value ?? ''), 'utf8')
    .digest('hex');
}

export function hashParts(...parts) {
  const cleaned = parts.filter((part) => part != null && String(part).length > 0);
  return cleaned.length === 0 ? null : sha256(cleaned.join('|'));
}
