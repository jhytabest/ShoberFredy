/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { getSettings } from '../storage/settingsStorage.js';

export async function currentProxyUrl() {
  const settings = await getSettings();
  return typeof settings?.proxyUrl === 'string' ? settings.proxyUrl.trim() : '';
}

export function proxyMissingFor(provider, proxyUrl) {
  return provider?.metaInformation?.requiresProxy === true && !proxyUrl;
}
