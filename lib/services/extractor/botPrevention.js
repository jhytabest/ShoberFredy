/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

const toInt = (v, d) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
};

export function getPreLaunchConfig(options = {}) {
  const acceptLanguage = options.acceptLanguage || 'de-DE,de;q=0.9,en-US;q=0.7,en;q=0.5';
  const langForFlag = acceptLanguage.split(',')[0];

  const baseViewport = { width: 1366, height: 768 };
  const jitter = options.viewportJitter !== false ? Math.floor(Math.random() * 6) : 0;
  const width = toInt(options?.viewport?.width, baseViewport.width) + jitter;
  const height = toInt(options?.viewport?.height, baseViewport.height) + jitter;

  return {
    langForFlag,
    windowSizeArg: `--window-size=${width},${height}`,
    timezone: options?.timezone || 'Europe/Berlin',
  };
}
