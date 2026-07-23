/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

export const DEFAULT_HEADER = {
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5',
  Connection: 'keep-alive',
  'Upgrade-Insecure-Requests': '1',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36',
};

export const botDetected = (pageSource, statusCode) => {
  const suspiciousStatusCodes = [403, 429];
  const botDetectionPatterns = [
    /verify you are human/i,
    /access denied/i,
    /x-amz-cf-id/i,
    /bitte best[aä]tigen sie,? dass sie ein mensch sind/i,
    /best[aä]tigen.{0,80}(mensch|kein roboter)/i,
    /captcha/i,
    /challenge-platform/i,
    /cf-chl-/i,
  ];

  const detectedInSource = botDetectionPatterns.some((pattern) => pattern.test(pageSource));
  const detectedByStatus = suspiciousStatusCodes.includes(statusCode);

  return detectedInSource || detectedByStatus;
};
