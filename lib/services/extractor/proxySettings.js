/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { getSettings } from '../storage/settingsStorage.js';

/**
 * Where the shared browser's exit node is decided.
 *
 * The proxy is read per unit of work rather than snapshotted at startup, so
 * setting or clearing it takes effect on the next discovery run and the next
 * detail capture without restarting the backend. An empty value means a direct
 * connection.
 *
 * @returns {Promise<string>} trimmed proxy URL, or '' when none is configured
 */
export async function currentProxyUrl() {
  const settings = await getSettings();
  return typeof settings?.proxyUrl === 'string' ? settings.proxyUrl.trim() : '';
}

/**
 * Whether this provider must not be contacted right now because it only works
 * through a proxy and none is configured.
 *
 * A provider that answers a datacenter IP with a bot challenge is
 * indistinguishable from one whose markup changed: discovery returns zero cards
 * and detail capture fails, so the circuit breaker escalates to its six-hour
 * ceiling and a misconfiguration reads as a broken provider. Declaring the
 * dependency lets both callers skip the navigation instead of paying for it and
 * then guessing at the cause.
 *
 * @param {{metaInformation?: {requiresProxy?: boolean}}} provider loaded provider module
 * @param {string} proxyUrl result of {@link currentProxyUrl}
 * @returns {boolean}
 */
export function proxyMissingFor(provider, proxyUrl) {
  return provider?.metaInformation?.requiresProxy === true && !proxyUrl;
}
